// The firm's folder template and document types: defaults for a firm, and
// reading them back in the shapes the file routes need.

import type pg from "pg";
import { getPool } from "./db.js";
import { LEVELS, type Level } from "../shared/domain.js";
import { DEFAULT_ANY_LEVEL_TYPES, DEFAULT_LEVEL_FOLDERS, DEFAULT_LEVEL_TYPES, DEFAULT_TEMPLATE } from "../shared/documents.js";

/**
 * Writes the default template and document types for a firm that has never had them.
 * Runs inside the caller's context (a 'system' context for that firm). Safe to call again:
 * a firm whose document_defaults_at is set is left alone, so a firm admin's edits stick.
 */
export async function seedDocumentDefaults(c: pg.PoolClient, firmId: number): Promise<boolean> {
  const firm = (await c.query<{ document_defaults_at: string | null }>(`SELECT document_defaults_at FROM firms WHERE id = $1 FOR UPDATE`, [firmId])).rows[0];
  if (!firm || firm.document_defaults_at) return false;
  let position = 0;
  let typePos = 0;
  for (const f of DEFAULT_TEMPLATE) {
    const row = await c.query<{ id: number }>(
      `INSERT INTO folder_template (firm_id, kind, name, position) VALUES ($1, $2, $3, $4) RETURNING id`,
      [firmId, f.kind, f.name, position++],
    );
    for (const t of f.types) {
      await c.query(
        `INSERT INTO document_types (firm_id, name, template_id, protected, position) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [firmId, t.name, row.rows[0].id, Boolean(t.protected), typePos++],
      );
    }
  }
  for (const level of LEVELS) {
    const row = await c.query<{ id: number }>(
      `INSERT INTO folder_template (firm_id, kind, level, name, position) VALUES ($1, 'level', $2, $3, $4) RETURNING id`,
      [firmId, level, DEFAULT_LEVEL_FOLDERS[level], LEVELS.indexOf(level)],
    );
    for (const t of DEFAULT_LEVEL_TYPES[level] ?? []) {
      await c.query(
        `INSERT INTO document_types (firm_id, name, template_id, protected, position) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [firmId, t.name, row.rows[0].id, Boolean(t.protected), typePos++],
      );
    }
  }
  for (const t of DEFAULT_ANY_LEVEL_TYPES) {
    await c.query(
      `INSERT INTO document_types (firm_id, name, any_level, protected, position) VALUES ($1, $2, true, $3, $4) ON CONFLICT DO NOTHING`,
      [firmId, t.name, Boolean(t.protected), typePos++],
    );
  }
  await c.query(`UPDATE firms SET document_defaults_at = now() WHERE id = $1`, [firmId]);
  return true;
}

/** After migrations: gives every firm without them the default template and types. */
export async function seedAllDocumentDefaults(log: (msg: string) => void): Promise<void> {
  const pool = getPool();
  const firms = (await pool.query<{ id: number; name: string }>(`SELECT id, name FROM firms WHERE document_defaults_at IS NULL ORDER BY id`)).rows;
  for (const f of firms) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.actor_kind', 'system', true), set_config('app.user_id', '', true), set_config('app.firm_id', $1, true)`, [String(f.id)]);
      const did = await seedDocumentDefaults(client, f.id);
      await client.query("COMMIT");
      if (did) log(`Document template: defaults added for ${f.name}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface TemplateRow { id: number; kind: "folder" | "appeals" | "level"; level: Level | null; name: string; position: number }
export interface DocTypeRow { id: number; name: string; template_id: number | null; any_level: boolean; protected: boolean; active: boolean; position: number }
export interface Template {
  top: TemplateRow[];               // folders at the property's root, in order, including Appeals
  appeals: TemplateRow | null;
  levels: Record<Level, string>;    // level folder names
  levelRows: Partial<Record<Level, TemplateRow>>;
  types: DocTypeRow[];
}

export async function loadTemplate(c: pg.PoolClient, firmId: number): Promise<Template> {
  const rows = (await c.query<TemplateRow>(`SELECT id, kind, level, name, position FROM folder_template WHERE firm_id = $1 ORDER BY position, id`, [firmId])).rows;
  const types = (await c.query<DocTypeRow>(
    `SELECT id, name, template_id, any_level, protected, active, position FROM document_types WHERE firm_id = $1 ORDER BY position, id`, [firmId],
  )).rows;
  const levels = { ...DEFAULT_LEVEL_FOLDERS };
  const levelRows: Partial<Record<Level, TemplateRow>> = {};
  for (const r of rows) if (r.kind === "level" && r.level) { levels[r.level] = r.name; levelRows[r.level] = r; }
  const top = rows.filter((r) => r.kind !== "level");
  return { top, appeals: top.find((r) => r.kind === "appeals") ?? null, levels, levelRows, types };
}

/** Where a folder (relative to the property folder) sits in the template, if it's a template folder. */
export interface FolderPlace { templateId: number | null; level: Level | null; year: number | null; isTemplateFolder: boolean }

export function placeOf(t: Template, rel: string): FolderPlace {
  const parts = rel.split("/").filter(Boolean);
  const none: FolderPlace = { templateId: null, level: null, year: null, isTemplateFolder: false };
  if (!parts.length) return none;
  const top = t.top.find((r) => r.name.toLowerCase() === parts[0].toLowerCase());
  if (!top) return none;
  if (top.kind !== "appeals") return { templateId: top.id, level: null, year: null, isTemplateFolder: parts.length === 1 };
  const year = parts[1] && /^\d{4}$/.test(parts[1]) ? Number(parts[1]) : null;
  if (parts.length === 1) return { templateId: top.id, level: null, year: null, isTemplateFolder: true };
  if (!year) return none;
  if (parts.length === 2) return { templateId: null, level: null, year, isTemplateFolder: true };
  const level = (Object.keys(t.levels) as Level[]).find((l) => t.levels[l].toLowerCase() === parts[2].toLowerCase()) ?? null;
  if (!level) return { templateId: null, level: null, year, isTemplateFolder: false };
  return { templateId: t.levelRows[level]?.id ?? null, level, year, isTemplateFolder: parts.length === 3 };
}

/** Document types meant for a folder: its own types, plus every-level types inside a level folder. */
export function typesFor(t: Template, place: FolderPlace): DocTypeRow[] {
  return t.types.filter((d) => d.active && ((place.templateId !== null && d.template_id === place.templateId) || (place.level !== null && d.any_level)));
}
