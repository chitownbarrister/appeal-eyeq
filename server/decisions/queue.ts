// Uploads waiting to be read. One at a time, in the order they arrived: read the
// pages, split them into letters, parse each letter, and match it. Each step runs
// under a 'system' context for the upload's own firm, so row-level security still
// keeps every firm's letters apart.

import { query, withContext, type DbContext } from "../db.js";
import { readPages, type DecisionContentType } from "./read-file.js";
import { COUNTIES, parseLetter, splitIntoLetters } from "./parse.js";
import { loadLetter, refreshMatch } from "./apply.js";

const pending: { firmId: number; uploadId: number }[] = [];
let running = false;
const idleWaiters: (() => void)[] = [];

const sys = (firmId: number): DbContext => ({ actorKind: "system", userId: null, firmId });

export function enqueueUpload(firmId: number, uploadId: number): void {
  if (!pending.some((p) => p.firmId === firmId && p.uploadId === uploadId)) pending.push({ firmId, uploadId });
  void drain();
}

/** Resolves when nothing is waiting or being read (tests use it). */
export function decisionQueueIdle(): Promise<void> {
  if (!running && !pending.length) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.length) {
      const next = pending.shift()!;
      await processUpload(next.firmId, next.uploadId).catch((err) => {
        console.error(`Decision upload failed: ${err instanceof Error ? err.name : "Error"}`);
      });
    }
  } finally {
    running = false;
    idleWaiters.splice(0).forEach((r) => r());
  }
}

/** After a restart: anything that was waiting or half-read is read again. */
export async function resumeDecisionQueue(): Promise<void> {
  const firms = (await query<{ id: number }>(`SELECT id FROM firms`)).rows;
  for (const f of firms) {
    const ids = await withContext(sys(f.id), async (c) => {
      await c.query(`DELETE FROM decision_letters WHERE firm_id = $1 AND upload_id IN (SELECT id FROM decision_uploads WHERE firm_id = $1 AND status = 'reading')`, [f.id]);
      await c.query(`UPDATE decision_uploads SET status = 'queued', pages_read = 0 WHERE firm_id = $1 AND status = 'reading'`, [f.id]);
      return (await c.query<{ id: number }>(`SELECT id FROM decision_uploads WHERE firm_id = $1 AND status = 'queued' ORDER BY id`, [f.id])).rows.map((r) => r.id);
    });
    ids.forEach((id) => enqueueUpload(f.id, id));
  }
}

async function processUpload(firmId: number, uploadId: number): Promise<void> {
  const ctx = sys(firmId);
  const up = await withContext(ctx, async (c) => {
    const r = (await c.query<{ content_type: DecisionContentType; data: Buffer; status: string }>(
      `UPDATE decision_uploads u SET status = 'reading', pages_read = 0, error = NULL FROM decision_upload_files f
        WHERE u.firm_id = $1 AND u.id = $2 AND u.status = 'queued' AND f.firm_id = u.firm_id AND f.upload_id = u.id
        RETURNING u.content_type, f.data, u.status`,
      [firmId, uploadId],
    )).rows[0];
    return r ?? null;
  });
  if (!up) return;
  try {
    let lastWrite = 0;
    const pages = await readPages(up.data, up.content_type, (read, total) => {
      if (Date.now() - lastWrite < 700 && read < total) return;
      lastWrite = Date.now();
      void withContext(ctx, (c) => c.query(`UPDATE decision_uploads SET pages_read = $3, page_count = $4 WHERE firm_id = $1 AND id = $2 AND status = 'reading'`, [firmId, uploadId, read, total])).catch(() => undefined);
    });
    await withContext(ctx, async (c) => {
      const counties = (await c.query<{ name: string }>(`SELECT name FROM counties`)).rows.map((r) => r.name);
      const groups = splitIntoLetters(pages.map((p) => p.text));
      for (const g of groups) {
        const slice = pages.slice(g.from - 1, g.to);
        const text = slice.map((p) => p.text).join("\n\f\n");
        const ocr = slice.filter((p) => p.source === "ocr" && p.confidence !== null);
        const confidence = ocr.length ? Math.min(...ocr.map((p) => p.confidence!)) : null;
        const fields = parseLetter(text, g.kind, counties.length ? counties : COUNTIES);
        const id = (await c.query<{ id: number }>(
          `INSERT INTO decision_letters (firm_id, upload_id, page_from, page_to, kind, text_source, confidence, raw_text, fields, parsed_fields)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
          [firmId, uploadId, g.from, g.to, fields.kind, ocr.length ? "ocr" : "text", confidence, text.slice(0, 60000), JSON.stringify(fields)],
        )).rows[0].id;
        const l = await loadLetter(c, firmId, id);
        await refreshMatch(c, firmId, l!);
      }
      await c.query(
        `UPDATE decision_uploads SET status = 'done', page_count = $3, pages_read = $3, finished_at = now() WHERE firm_id = $1 AND id = $2`,
        [firmId, uploadId, pages.length],
      );
    });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "The file couldn't be read.";
    await withContext(ctx, (c) => c.query(
      `UPDATE decision_uploads SET status = 'failed', error = $3, finished_at = now() WHERE firm_id = $1 AND id = $2`,
      [firmId, uploadId, `Couldn't read this file. ${message}`.slice(0, 500)],
    ));
  }
}
