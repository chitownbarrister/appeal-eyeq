// A letter's own PDF (its pages cut from the uploaded stack, or a photo turned into
// a one-page PDF), and filing it in the property's Dropbox folder as a Decision
// Letter document under Appeals / year / level.

import type { Request } from "express";
import { PDFDocument } from "pdf-lib";
import { LEVEL_LABELS, shortPin, type Level } from "../../shared/domain.js";
import { suggestedFileName } from "../../shared/documents.js";
import { withContext } from "../db.js";
import { FirmDropbox } from "../dropbox/client.js";
import { friendlyDropboxError, joinPath } from "../dropbox/folders.js";
import { ensureAppealFolder } from "../routes/property-files.js";
import type { LetterFields } from "./parse.js";

const chicagoDate = (d: string | Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));

/** The letter's pages as a PDF of their own. */
export async function letterPdf(file: Buffer, contentType: string, from: number, to: number): Promise<Buffer> {
  if (contentType === "application/pdf") {
    const src = await PDFDocument.load(file, { ignoreEncryption: true });
    if (from === 1 && to === src.getPageCount()) return file;
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
    pages.forEach((p) => out.addPage(p));
    return Buffer.from(await out.save());
  }
  const out = await PDFDocument.create();
  const img = contentType === "image/png" ? await out.embedPng(file) : await out.embedJpg(file);
  // Fit the picture on a letter-size page (612 x 792 points), keeping its shape.
  const scale = Math.min(612 / img.width, 792 / img.height);
  const w = img.width * scale, h = img.height * scale;
  const page = out.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return Buffer.from(await out.save());
}

export async function loadLetterFile(req: Request, letterId: number): Promise<{ pdf: Buffer; name: string } | null> {
  const firmId = req.ctx!.firmId!;
  const row = await withContext(req.ctx!, async (c) => (await c.query(
    `SELECT l.page_from, l.page_to, l.fields, u.content_type, u.file_name, f.data
       FROM decision_letters l JOIN decision_uploads u ON u.firm_id = l.firm_id AND u.id = l.upload_id
       LEFT JOIN decision_upload_files f ON f.firm_id = u.firm_id AND f.upload_id = u.id
      WHERE l.firm_id = $1 AND l.id = $2`,
    [firmId, letterId],
  )).rows[0]);
  if (!row || !row.data) return null;
  return { pdf: await letterPdf(row.data, row.content_type, row.page_from, row.page_to), name: row.file_name };
}

/**
 * Files an applied letter in Dropbox and records it as a Decision Letter document. Never throws:
 * a problem (Dropbox not connected, no property folder, Dropbox refusing) is saved on the letter
 * so it can be tried again, and the decision itself stays applied either way.
 */
export async function fileLetter(req: Request, letterId: number): Promise<{ filedPath: string | null; error: string | null }> {
  const firmId = req.ctx!.firmId!;
  const saveError = async (error: string) => {
    await withContext(req.ctx!, (c) => c.query(`UPDATE decision_letters SET file_error = $3 WHERE firm_id = $1 AND id = $2`, [firmId, letterId, error.slice(0, 500)]));
    return { filedPath: null, error };
  };
  const l = await withContext(req.ctx!, async (c) => (await c.query<{
    status: string; document_id: number | null; property_id: number; fields: LetterFields; year: number; level: Level; created_at: string; upload_id: number;
  }>(
    `SELECT l.status, l.document_id, l.property_id, l.fields, a.assessment_year AS year, a.level, u.created_at, l.upload_id
       FROM decision_letters l JOIN appeals a ON a.firm_id = l.firm_id AND a.id = l.appeal_id
       JOIN decision_uploads u ON u.firm_id = l.firm_id AND u.id = l.upload_id
      WHERE l.firm_id = $1 AND l.id = $2`,
    [firmId, letterId],
  )).rows[0]);
  if (!l || l.status !== "applied") return { filedPath: null, error: "Only an applied letter is filed." };
  if (l.document_id) return { filedPath: null, error: null };
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) return saveError("Not filed in Dropbox yet: Dropbox isn't connected. A firm admin can connect it in Settings, Integrations.");
  try {
    const folder = await ensureAppealFolder(req, l.property_id, l.year, l.level);
    if (!folder) return saveError("Not filed in Dropbox yet: this property has no Dropbox folder. Create it on the property's Files tab, then press File in Dropbox.");
    const file = await loadLetterFile(req, letterId);
    if (!file) return saveError("The scan is no longer stored here.");
    const pin = l.fields.pins.find((p) => p.pin)?.pin ?? null;
    const name = suggestedFileName(pin ? shortPin(pin) : null, "Decision Letter", l.year, "letter.pdf");
    const saved = await dbx.upload(joinPath(folder, name), file.pdf);
    await withContext(req.ctx!, async (c) => {
      const type = (await c.query<{ id: number }>(`SELECT id FROM document_types WHERE firm_id = $1 AND lower(name) = 'decision letter' AND active LIMIT 1`, [firmId])).rows[0];
      const doc = (await c.query<{ id: number }>(
        `INSERT INTO documents (firm_id, property_id, provider, file_id, rev, path_display, name, size, server_modified, doc_type_id, status,
                                doc_date, received_on, assessment_year, level, uploaded_by, uploaded_at, profiled_by, profiled_at, notes)
         VALUES ($1, $2, 'dropbox', $3, $4, $5, $6, $7, $8, $9, 'final', $10, $11, $12, $13, $14, now(), $14, now(), $15)
         ON CONFLICT (firm_id, provider, file_id) DO UPDATE SET path_display = EXCLUDED.path_display, deleted_at = NULL
         RETURNING id`,
        [firmId, l.property_id, saved.id, saved.rev, saved.path_display, saved.name, saved.size, saved.server_modified, type?.id ?? null,
          l.fields.letterDate, chicagoDate(l.created_at), l.year, l.level, req.auth!.user.id,
          `${LEVEL_LABELS[l.level]} decision letter, read and applied in Decisions.`],
      )).rows[0];
      await c.query(`UPDATE decision_letters SET document_id = $3, filed_path = $4, file_error = NULL WHERE firm_id = $1 AND id = $2`, [firmId, letterId, doc.id, saved.path_display]);
      await purgeIfFinished(c, firmId, l.upload_id);
    });
    return { filedPath: saved.path_display, error: null };
  } catch (err) {
    const friendly = friendlyDropboxError(err);
    return saveError(friendly ? `Not filed in Dropbox yet: ${friendly.publicMessage}` : "Not filed in Dropbox yet: Dropbox didn't accept the file. Try again.");
  }
}

/** Once every letter in an upload is filed or dismissed, the stored scan isn't needed here any more. */
export async function purgeIfFinished(c: import("pg").PoolClient, firmId: number, uploadId: number): Promise<void> {
  const open = (await c.query(
    `SELECT 1 FROM decision_letters WHERE firm_id = $1 AND upload_id = $2 AND NOT (status = 'dismissed' OR (status = 'applied' AND document_id IS NOT NULL)) LIMIT 1`,
    [firmId, uploadId],
  )).rowCount;
  if (open) return;
  const r = await c.query(`DELETE FROM decision_upload_files WHERE firm_id = $1 AND upload_id = $2`, [firmId, uploadId]);
  if (r.rowCount) await c.query(`UPDATE decision_uploads SET file_purged_at = now() WHERE firm_id = $1 AND id = $2`, [firmId, uploadId]);
}
