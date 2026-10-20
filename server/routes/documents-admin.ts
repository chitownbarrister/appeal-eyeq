// The firm's folder template and document types. Everyone in the firm can read
// them (the Files tab uses them); only firm admins change them. Changes apply
// to folders created from now on: existing property folders keep their names.

import { Router } from "express";
import { z } from "zod";
import { withContext } from "../db.js";
import { requireFirmAdmin } from "../auth.js";
import { loadTemplate } from "../documents.js";
import { safeName } from "../dropbox/folders.js";
import { httpError } from "./files-common.js";

export const documentsAdminRouter = Router();

documentsAdminRouter.get("/documents/template", async (req, res) => {
  const t = await withContext(req.ctx!, (c) => loadTemplate(c, req.ctx!.firmId!));
  const usage = await withContext(req.ctx!, async (c) =>
    (await c.query<{ doc_type_id: number; n: string }>(
      `SELECT doc_type_id, count(*) AS n FROM documents WHERE firm_id = $1 AND doc_type_id IS NOT NULL AND deleted_at IS NULL GROUP BY doc_type_id`,
      [req.ctx!.firmId],
    )).rows,
  );
  const used = new Map(usage.map((u) => [u.doc_type_id, Number(u.n)]));
  res.json({
    folders: t.top.map((r) => ({ id: r.id, kind: r.kind, name: r.name, position: r.position })),
    levels: Object.values(t.levelRows).map((r) => ({ id: r!.id, level: r!.level, name: r!.name })),
    types: t.types.map((d) => ({ id: d.id, name: d.name, templateId: d.template_id, anyLevel: d.any_level, protected: d.protected, active: d.active, documents: used.get(d.id) ?? 0 })),
  });
});

const FolderName = z.string().trim().min(1, "Name the folder.").max(120).transform(safeName);

documentsAdminRouter.post("/documents/template/folders", requireFirmAdmin, async (req, res) => {
  const parsed = z.object({ name: FolderName }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const row = await withContext(req.ctx!, async (c) => {
    const next = (await c.query<{ n: number }>(`SELECT COALESCE(max(position), -1) + 1 AS n FROM folder_template WHERE firm_id = $1 AND kind <> 'level'`, [req.ctx!.firmId])).rows[0].n;
    return (await c.query(`INSERT INTO folder_template (firm_id, kind, name, position) VALUES ($1, 'folder', $2, $3) RETURNING id, name`, [req.ctx!.firmId, parsed.data.name, next])).rows[0];
  });
  res.status(201).json(row);
});

documentsAdminRouter.patch("/documents/template/folders/:id", requireFirmAdmin, async (req, res) => {
  const parsed = z.object({ name: FolderName }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const id = Number(req.params.id);
  const r = await withContext(req.ctx!, async (c) => {
    const cur = (await c.query<{ kind: string }>(`SELECT kind FROM folder_template WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rows[0];
    if (!cur) throw httpError(404, "That folder isn't in the template.");
    if (cur.kind === "appeals") throw httpError(409, "The Appeals folder keeps its name, so every property's year and level folders stay where Appeal EyeQ expects them.");
    return (await c.query(`UPDATE folder_template SET name = $3 WHERE firm_id = $1 AND id = $2 RETURNING id, name`, [req.ctx!.firmId, id, parsed.data.name])).rows[0];
  });
  res.json(r);
});

documentsAdminRouter.put("/documents/template/order", requireFirmAdmin, async (req, res) => {
  const parsed = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Send the folders in their new order.");
  await withContext(req.ctx!, async (c) => {
    const have = (await c.query<{ id: number }>(`SELECT id FROM folder_template WHERE firm_id = $1 AND kind <> 'level'`, [req.ctx!.firmId])).rows.map((r) => r.id).sort();
    const got = [...parsed.data.ids].sort();
    if (have.length !== got.length || have.some((v, i) => v !== got[i])) throw httpError(400, "The order must list every template folder once.");
    for (const [i, id] of parsed.data.ids.entries()) await c.query(`UPDATE folder_template SET position = $3 WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id, i]);
  });
  res.json({ ok: true });
});

documentsAdminRouter.delete("/documents/template/folders/:id", requireFirmAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await withContext(req.ctx!, async (c) => {
    const cur = (await c.query<{ kind: string }>(`SELECT kind FROM folder_template WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rows[0];
    if (!cur) throw httpError(404, "That folder isn't in the template.");
    if (cur.kind !== "folder") throw httpError(409, "Appeals and the level folders are part of every property and can't be removed.");
    await c.query(`UPDATE document_types SET template_id = NULL WHERE firm_id = $1 AND template_id = $2`, [req.ctx!.firmId, id]);
    await c.query(`DELETE FROM folder_template WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id]);
  });
  res.json({ ok: true });
});

documentsAdminRouter.patch("/documents/template/levels/:id", requireFirmAdmin, async (req, res) => {
  const parsed = z.object({ name: FolderName }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const r = await withContext(req.ctx!, (c) =>
    c.query(`UPDATE folder_template SET name = $3 WHERE firm_id = $1 AND id = $2 AND kind = 'level' RETURNING id, name`, [req.ctx!.firmId, Number(req.params.id), parsed.data.name]),
  );
  if (!r.rowCount) throw httpError(404, "That level folder isn't in the template.");
  res.json(r.rows[0]);
});

const DocType = z.object({
  name: z.string().trim().min(1, "Name the document type.").max(80),
  templateId: z.number().int().positive().nullable().optional(),
  anyLevel: z.boolean().optional(),
  protected: z.boolean().optional(),
  active: z.boolean().optional(),
});

async function checkTemplateId(req: import("express").Request, id: number | null | undefined): Promise<void> {
  if (!id) return;
  const ok = await withContext(req.ctx!, async (c) => (await c.query(`SELECT 1 FROM folder_template WHERE firm_id = $1 AND id = $2 AND kind <> 'appeals'`, [req.ctx!.firmId, id])).rowCount);
  if (!ok) throw httpError(400, "Choose one of the template's folders.");
}

documentsAdminRouter.post("/documents/types", requireFirmAdmin, async (req, res) => {
  const parsed = DocType.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const v = parsed.data;
  await checkTemplateId(req, v.templateId);
  const row = await withContext(req.ctx!, async (c) => {
    const dupe = (await c.query(`SELECT 1 FROM document_types WHERE firm_id = $1 AND lower(name) = lower($2)`, [req.ctx!.firmId, v.name])).rowCount;
    if (dupe) throw httpError(409, `There's already a document type named ${v.name}.`);
    const next = (await c.query<{ n: number }>(`SELECT COALESCE(max(position), -1) + 1 AS n FROM document_types WHERE firm_id = $1`, [req.ctx!.firmId])).rows[0].n;
    return (await c.query(
      `INSERT INTO document_types (firm_id, name, template_id, any_level, protected, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.ctx!.firmId, v.name, v.anyLevel ? null : v.templateId ?? null, Boolean(v.anyLevel), Boolean(v.protected), next],
    )).rows[0];
  });
  res.status(201).json(row);
});

documentsAdminRouter.patch("/documents/types/:id", requireFirmAdmin, async (req, res) => {
  const parsed = DocType.partial().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const v = parsed.data;
  await checkTemplateId(req, v.templateId);
  const id = Number(req.params.id);
  await withContext(req.ctx!, async (c) => {
    const cur = (await c.query(`SELECT 1 FROM document_types WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rowCount;
    if (!cur) throw httpError(404, "That document type isn't the firm's.");
    if (v.name !== undefined) {
      const dupe = (await c.query(`SELECT 1 FROM document_types WHERE firm_id = $1 AND lower(name) = lower($2) AND id <> $3`, [req.ctx!.firmId, v.name, id])).rowCount;
      if (dupe) throw httpError(409, `There's already a document type named ${v.name}.`);
      await c.query(`UPDATE document_types SET name = $3 WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id, v.name]);
    }
    if (v.anyLevel !== undefined || v.templateId !== undefined) {
      await c.query(`UPDATE document_types SET any_level = $3, template_id = $4 WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id, Boolean(v.anyLevel), v.anyLevel ? null : v.templateId ?? null]);
    }
    if (v.protected !== undefined) await c.query(`UPDATE document_types SET protected = $3 WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id, v.protected]);
    if (v.active !== undefined) await c.query(`UPDATE document_types SET active = $3 WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id, v.active]);
  });
  res.json({ ok: true });
});
