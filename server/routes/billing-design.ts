// Invoice design and attachments: the letterhead logo, a live preview of the invoice layout
// for Settings, and PDFs from a property's Files tab attached to one of its invoices.
// Mounted under /api/firm after requireFirmContext; every query runs inside withContext and
// filters on firm_id. Support access can see the design but never a client file.

import { Router, type Request } from "express";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { withContext } from "../db.js";
import { requireFirmAdmin, requirePermission } from "../auth.js";
import { FirmDropbox } from "../dropbox/client.js";
import { invoicePreviewPdf } from "../billing/pdf.js";
import { dropboxCall, httpError, idParam, noSupportAccess } from "./files-common.js";

export const billingDesignRouter = Router();

const MAX_LOGO_BYTES = 1024 * 1024;
/** Postmark takes about 10 MB per email in all; the invoice's own PDF needs room too. */
export const MAX_ATTACHMENTS_BYTES = 9 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function audit(c: import("pg").PoolClient, req: Request, table: string, rowId: string, action: string, after: Record<string, unknown> | null, before: Record<string, unknown> | null = null) {
  return c.query(
    `INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after) VALUES ($1, $2, 'firm_user', $3, $4, $5, $6, $7)`,
    [req.ctx!.firmId, req.auth!.user.id, table, rowId, action, before, after],
  );
}

// ---------------------------------------------------------------- logo
billingDesignRouter.get("/billing/logo", async (req, res) => {
  const logo = await withContext(req.ctx!, async (c) =>
    (await c.query<{ content: Buffer; content_type: string; updated_at: string }>(`SELECT content, content_type, updated_at FROM firm_logos WHERE firm_id = $1`, [req.ctx!.firmId])).rows[0]);
  if (!logo) throw httpError(404, "No logo yet.");
  res.setHeader("Content-Type", logo.content_type);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(logo.content);
});

const LogoBody = z.object({ contentType: z.enum(["image/png", "image/jpeg"], { message: "Use a PNG or JPEG image." }), data: z.string().min(1).max(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8) }).strict();

billingDesignRouter.put("/billing/logo", requireFirmAdmin, async (req, res) => {
  const parsed = LogoBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message.startsWith("String must contain at most") ? "The logo can be up to 1 MB." : parsed.error.issues[0].message);
  const bytes = Buffer.from(parsed.data.data, "base64");
  if (!bytes.length) throw httpError(400, "The image is empty.");
  if (bytes.length > MAX_LOGO_BYTES) throw httpError(400, "The logo can be up to 1 MB.");
  // It must really be the image it says it is; reading it the way the PDF will proves that and gives its size.
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if ((parsed.data.contentType === "image/png" && !isPng) || (parsed.data.contentType === "image/jpeg" && !isJpeg)) throw httpError(400, "That file isn't a PNG or JPEG image.");
  let dims: { width: number; height: number };
  try {
    const doc = await PDFDocument.create();
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    dims = { width: img.width, height: img.height };
  } catch {
    throw httpError(400, "That image couldn't be read. Save it again as PNG or JPEG and try once more.");
  }
  await withContext(req.ctx!, async (c) => {
    await c.query(
      `INSERT INTO firm_logos (firm_id, content_type, content, width, height, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (firm_id) DO UPDATE SET content_type = EXCLUDED.content_type, content = EXCLUDED.content, width = EXCLUDED.width,
         height = EXCLUDED.height, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.ctx!.firmId, parsed.data.contentType, bytes, dims.width, dims.height, req.auth!.user.id],
    );
    await audit(c, req, "firm_logos", String(req.ctx!.firmId), "UPDATE", { content_type: parsed.data.contentType, bytes: bytes.length, ...dims });
  });
  res.json({ ok: true, ...dims });
});

billingDesignRouter.delete("/billing/logo", requireFirmAdmin, async (req, res) => {
  await withContext(req.ctx!, async (c) => {
    const r = await c.query(`DELETE FROM firm_logos WHERE firm_id = $1`, [req.ctx!.firmId]);
    if (r.rowCount) await audit(c, req, "firm_logos", String(req.ctx!.firmId), "DELETE", null, { logo: true });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- preview
const hex = z.string().trim().toUpperCase().regex(/^#[0-9A-F]{6}$/, "Use a color like #B8733E.");
const PreviewBody = z.object({
  letterheadName: z.string().trim().max(120).nullable().optional(),
  letterheadAddress: z.string().trim().max(200).nullable().optional(),
  letterheadPhone: z.string().trim().max(40).nullable().optional(),
  letterheadWebsite: z.string().trim().max(120).nullable().optional(),
  invoiceNote: z.string().trim().max(600).nullable().optional(),
  remitTo: z.string().trim().max(300).nullable().optional(),
  accentColor: z.union([hex, z.literal("")]).nullable().optional(),
}).passthrough();

/**
 * A sample invoice with the settings as typed (before saving), shown in a frame in Settings.
 * The draft travels as JSON in ?d=; nothing is stored.
 */
billingDesignRouter.get("/billing/invoice-preview", async (req, res) => {
  let draft: unknown = {};
  try { draft = typeof req.query.d === "string" && req.query.d.length <= 4000 ? JSON.parse(req.query.d) : {}; } catch { throw httpError(400, "The preview settings couldn't be read."); }
  const parsed = PreviewBody.safeParse(draft ?? {});
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const d = parsed.data;
  const pdf = await withContext(req.ctx!, (c) => invoicePreviewPdf(c, req.ctx!.firmId!, {
    letterheadName: d.letterheadName, letterheadAddress: d.letterheadAddress, letterheadPhone: d.letterheadPhone, letterheadWebsite: d.letterheadWebsite,
    invoiceNote: d.invoiceNote, remitTo: d.remitTo, accentColor: d.accentColor === undefined ? undefined : d.accentColor || null,
  }));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
  res.end(pdf);
});

// ---------------------------------------------------------------- attachments
function invId(req: Request): number {
  const n = idParam(req);
  if (!n) throw httpError(400, "Invalid invoice.");
  return n;
}

export async function attachmentList(c: import("pg").PoolClient, firmId: number, invoiceId: number) {
  return (await c.query<{ id: number; name: string; size: number; document_id: number | null; created_at: string }>(
    `SELECT id, name, size, document_id, created_at FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = $2 ORDER BY position, id`,
    [firmId, invoiceId],
  )).rows;
}

async function attachableInvoice(c: import("pg").PoolClient, firmId: number, invoiceId: number) {
  const i = (await c.query<{ status: string; property_id: number }>(`SELECT status, property_id FROM invoices WHERE firm_id = $1 AND id = $2`, [firmId, invoiceId])).rows[0];
  if (!i) throw httpError(404, "Invoice not found.");
  return i;
}

/** PDFs on the invoice's property (from its Files tab) that could be attached. */
billingDesignRouter.get("/billing/invoices/:id/attachable", noSupportAccess, async (req, res) => {
  const id = invId(req);
  const files = await withContext(req.ctx!, async (c) => {
    const i = await attachableInvoice(c, req.ctx!.firmId!, id);
    return (await c.query(
      `SELECT d.id, d.name, d.size, d.path_display, d.doc_date, d.assessment_year, d.level, t.name AS type_name,
              EXISTS (SELECT 1 FROM invoice_attachments x WHERE x.firm_id = d.firm_id AND x.invoice_id = $3 AND x.document_id = d.id) AS attached
         FROM documents d LEFT JOIN document_types t ON t.firm_id = d.firm_id AND t.id = d.doc_type_id
        WHERE d.firm_id = $1 AND d.property_id = $2 AND d.deleted_at IS NULL AND lower(d.name) LIKE '%.pdf'
        ORDER BY d.assessment_year DESC NULLS LAST, d.server_modified DESC NULLS LAST, d.name LIMIT 300`,
      [req.ctx!.firmId, i.property_id, id],
    )).rows;
  });
  res.json({ files });
});

billingDesignRouter.post("/billing/invoices/:id/attachments", noSupportAccess, requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  const parsed = z.object({ documentId: z.number().int().positive() }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Choose a PDF from the property's files.");
  const firmId = req.ctx!.firmId!;
  const doc = await withContext(req.ctx!, async (c) => {
    const i = await attachableInvoice(c, firmId, id);
    if (i.status === "paid" || i.status === "void") throw httpError(409, "A paid or void invoice can't take attachments.");
    const d = (await c.query<{ id: number; file_id: string; name: string; size: string | null }>(
      `SELECT id, file_id, name, size FROM documents WHERE firm_id = $1 AND id = $2 AND property_id = $3 AND deleted_at IS NULL`,
      [firmId, parsed.data.documentId, i.property_id],
    )).rows[0];
    if (!d) throw httpError(404, "That file isn't on this invoice's property.");
    if (!/\.pdf$/i.test(d.name)) throw httpError(400, "Only PDFs can be attached to an invoice.");
    const have = (await c.query<{ n: number; bytes: string; dup: boolean }>(
      `SELECT count(*)::int AS n, COALESCE(sum(size), 0)::bigint AS bytes, bool_or(document_id = $3) AS dup FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = $2`,
      [firmId, id, d.id],
    )).rows[0];
    if (have.dup) throw httpError(409, `${d.name} is already attached.`);
    if (have.n >= MAX_ATTACHMENTS) throw httpError(409, `An invoice can carry up to ${MAX_ATTACHMENTS} attachments.`);
    return { ...d, usedBytes: Number(have.bytes) };
  });
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) throw httpError(409, "Dropbox isn't connected. A firm admin can connect it in Settings, Integrations.");
  const room = MAX_ATTACHMENTS_BYTES - doc.usedBytes;
  const got = await dropboxCall(() => dbx.content("files/download", { path: doc.file_id }, Math.max(room, 1))).catch((e) => {
    if ((e as { status?: number }).status === 413) throw httpError(413, `Attachments on one invoice can total up to 9 MB (emails carry about 10 MB). ${doc.name} doesn't fit.`);
    throw e;
  });
  if (got.body.subarray(0, 5).toString("latin1") !== "%PDF-") throw httpError(400, `${doc.name} isn't a readable PDF.`);
  const row = await withContext(req.ctx!, async (c) => {
    const i = await attachableInvoice(c, firmId, id);
    if (i.status === "paid" || i.status === "void") throw httpError(409, "A paid or void invoice can't take attachments.");
    const used = Number((await c.query<{ b: string }>(`SELECT COALESCE(sum(size), 0)::bigint AS b FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = $2`, [firmId, id])).rows[0].b);
    if (used + got.body.length > MAX_ATTACHMENTS_BYTES) throw httpError(413, `Attachments on one invoice can total up to 9 MB (emails carry about 10 MB). ${doc.name} doesn't fit.`);
    const r = (await c.query<{ id: number }>(
      `INSERT INTO invoice_attachments (firm_id, invoice_id, document_id, name, size, content, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(max(position), 0) + 1 FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = $2), $7) RETURNING id`,
      [firmId, id, doc.id, doc.name, got.body.length, got.body, req.auth!.user.id],
    )).rows[0];
    await audit(c, req, "invoice_attachments", String(r.id), "INSERT", { invoice_id: id, document_id: doc.id, name: doc.name, size: got.body.length });
    return r;
  });
  const list = await withContext(req.ctx!, (c) => attachmentList(c, firmId, id));
  res.status(201).json({ id: row.id, attachments: list });
});

billingDesignRouter.delete("/billing/invoices/:id/attachments/:att", noSupportAccess, requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  const att = Number(req.params.att);
  if (!Number.isInteger(att) || att <= 0) throw httpError(400, "Invalid attachment.");
  const firmId = req.ctx!.firmId!;
  const list = await withContext(req.ctx!, async (c) => {
    const i = await attachableInvoice(c, firmId, id);
    if (i.status === "paid" || i.status === "void") throw httpError(409, "A paid or void invoice's attachments stay as they were sent.");
    const gone = (await c.query<{ name: string }>(`DELETE FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = $2 AND id = $3 RETURNING name`, [firmId, id, att])).rows[0];
    if (!gone) throw httpError(404, "Attachment not found.");
    await audit(c, req, "invoice_attachments", String(att), "DELETE", null, { invoice_id: id, name: gone.name });
    return attachmentList(c, firmId, id);
  });
  res.json({ attachments: list });
});

billingDesignRouter.get("/billing/invoices/:id/attachments/:att", noSupportAccess, async (req, res) => {
  const id = invId(req);
  const att = Number(req.params.att);
  if (!Number.isInteger(att) || att <= 0) throw httpError(400, "Invalid attachment.");
  const a = await withContext(req.ctx!, async (c) =>
    (await c.query<{ name: string; content: Buffer }>(`SELECT name, content FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = $2 AND id = $3`, [req.ctx!.firmId, id, att])).rows[0]);
  if (!a) throw httpError(404, "Attachment not found.");
  sendPdf(res, a.name, a.content);
});

export function sendPdf(res: import("express").Response, name: string, content: Buffer): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(content);
}
