// Invoice and statement PDFs, on the firm's letterhead (Settings), in the brand's navy and copper.

import type pg from "pg";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { matterTitle } from "../../shared/domain.js";
import { formatMoney } from "../../shared/money.js";
import { billingSettings } from "./core.js";

const NAVY = rgb(10 / 255, 31 / 255, 68 / 255);
const COPPER = rgb(184 / 255, 115 / 255, 62 / 255);
const MUTED = rgb(0.37, 0.4, 0.47);
const LINE = rgb(0.87, 0.88, 0.9);

const fmtDate = (iso: string | null) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
/** pdf-lib's standard fonts only carry the Windows-1252 characters; anything else becomes a plain stand-in. */
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E -ÿ–—•€]/g, "-");

interface Ctx { page: PDFPage; font: PDFFont; bold: PDFFont; y: number }

function text(x: Ctx, s: string, at: number, size = 10, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; right?: boolean } = {}) {
  const f = opts.bold ? x.bold : x.font;
  const str = safe(s);
  const w = f.widthOfTextAtSize(str, size);
  x.page.drawText(str, { x: opts.right ? at - w : at, y: x.y, size, font: f, color: opts.color ?? NAVY });
}

function wrap(f: PDFFont, s: string, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of safe(s).split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (f.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

async function letterhead(c: pg.PoolClient, firmId: number) {
  const f = (await c.query(`SELECT name, letterhead_name, letterhead_address, letterhead_phone, letterhead_website FROM firms WHERE id = $1`, [firmId])).rows[0];
  return { name: f.letterhead_name || f.name, lines: [f.letterhead_address, [f.letterhead_phone, f.letterhead_website].filter(Boolean).join("  ·  ")].filter(Boolean) as string[] };
}

async function start(c: pg.PoolClient, firmId: number, title: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const x: Ctx = { page, font: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), y: 740 };
  const lh = await letterhead(c, firmId);
  text(x, lh.name, 54, 16, { bold: true });
  text(x, title, 558, 16, { bold: true, color: COPPER, right: true });
  for (const l of lh.lines) { x.y -= 14; text(x, l, 54, 9, { color: MUTED }); }
  x.y -= 12;
  page.drawLine({ start: { x: 54, y: x.y }, end: { x: 558, y: x.y }, thickness: 1, color: COPPER });
  x.y -= 26;
  return { doc, x };
}

async function billTo(c: pg.PoolClient, firmId: number, accountId: number) {
  return (await c.query(`SELECT name, address1, address2, city, state, zip FROM accounts WHERE firm_id = $1 AND id = $2`, [firmId, accountId])).rows[0];
}

function addressBlock(x: Ctx, a: { name: string; address1: string | null; address2: string | null; city: string | null; state: string | null; zip: string | null }) {
  text(x, "BILL TO", 54, 8, { bold: true, color: MUTED });
  x.y -= 14; text(x, a.name, 54, 11, { bold: true });
  for (const l of [a.address1, a.address2, [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean) as string[]) { x.y -= 13; text(x, l, 54, 10); }
}

function footer(x: Ctx, link: string | null, note: string | null, dueText: string) {
  x.y -= 30;
  if (link) {
    text(x, "Pay online by bank account (ACH) or card:", 54, 10, { bold: true });
    x.y -= 14; text(x, link, 54, 9, { color: COPPER });
    x.y -= 18;
  }
  text(x, dueText, 54, 10, { color: MUTED });
  if (note) for (const l of wrap(x.font, note, 9, 504)) { x.y -= 14; text(x, l, 54, 9, { color: MUTED }); }
}

export async function invoicePdf(c: pg.PoolClient, firmId: number, invoiceId: number, link: string | null): Promise<Buffer> {
  const inv = (await c.query(
    `SELECT i.*, p.address1, p.name AS pname, p.city, t.name AS township,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM invoices i JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE i.firm_id = $1 AND i.id = $2`,
    [firmId, invoiceId],
  )).rows[0];
  const lines = (await c.query(`SELECT description, amount FROM invoice_lines WHERE firm_id = $1 AND invoice_id = $2 ORDER BY position, id`, [firmId, invoiceId])).rows;
  const s = await billingSettings(c, firmId);
  const { doc, x } = await start(c, firmId, inv.status === "draft" ? "DRAFT INVOICE" : "INVOICE");
  const top = x.y;
  addressBlock(x, await billTo(c, firmId, inv.account_id));
  const left = x.y;
  x.y = top;
  for (const [k, v] of [["Invoice", inv.number ?? "Draft"], ["Date", fmtDate(inv.issued_on) || "Not sent yet"], ["Due", fmtDate(inv.due_on) || ""]] as [string, string][]) {
    text(x, k, 420, 9, { color: MUTED }); text(x, v, 558, 10, { right: true, bold: k === "Invoice" }); x.y -= 15;
  }
  x.y = Math.min(left, x.y) - 26;
  text(x, "MATTER", 54, 8, { bold: true, color: MUTED });
  x.y -= 14; text(x, matterTitle(inv.pin, inv.address1 || inv.pname, inv.city, inv.township), 54, 10);
  x.y -= 28;
  text(x, "DESCRIPTION", 54, 8, { bold: true, color: MUTED }); text(x, "AMOUNT", 558, 8, { bold: true, color: MUTED, right: true });
  x.y -= 8; x.page.drawLine({ start: { x: 54, y: x.y }, end: { x: 558, y: x.y }, thickness: 0.6, color: LINE });
  for (const l of lines) {
    x.y -= 16;
    const parts = wrap(x.font, l.description, 10, 400);
    text(x, parts[0], 54, 10); text(x, formatMoney(l.amount), 558, 10, { right: true });
    for (const more of parts.slice(1)) { x.y -= 13; text(x, more, 54, 10); }
  }
  x.y -= 10; x.page.drawLine({ start: { x: 300, y: x.y }, end: { x: 558, y: x.y }, thickness: 0.6, color: LINE });
  x.y -= 18; text(x, "Total due", 420, 11, { bold: true }); text(x, formatMoney(inv.total), 558, 12, { bold: true, right: true });
  footer(x, inv.status === "sent" ? link : null, s.invoice_note, inv.due_on ? `Payment in full is due by ${fmtDate(inv.due_on)}. Please include the invoice number with a check.` : "Payment in full is due on receipt.");
  return Buffer.from(await doc.save());
}

export async function statementPdf(c: pg.PoolClient, firmId: number, statementId: number, link: string | null): Promise<Buffer> {
  const st = (await c.query(`SELECT * FROM statements WHERE firm_id = $1 AND id = $2`, [firmId, statementId])).rows[0];
  const invs = (await c.query(
    `SELECT i.number, i.issued_on, i.total, p.address1, p.name AS pname, p.city, t.name AS township,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM invoices i JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE i.firm_id = $1 AND i.statement_id = $2 ORDER BY i.issued_on, i.number`,
    [firmId, statementId],
  )).rows;
  const s = await billingSettings(c, firmId);
  const { doc, x } = await start(c, firmId, "STATEMENT");
  const top = x.y;
  addressBlock(x, await billTo(c, firmId, st.account_id));
  const left = x.y;
  x.y = top;
  for (const [k, v] of [["Statement", st.number], ["Date", fmtDate(st.issued_on)], ["Due", fmtDate(st.due_on)]] as [string, string][]) {
    text(x, k, 420, 9, { color: MUTED }); text(x, v, 558, 10, { right: true, bold: k === "Statement" }); x.y -= 15;
  }
  x.y = Math.min(left, x.y) - 30;
  text(x, "INVOICE", 54, 8, { bold: true, color: MUTED }); text(x, "MATTER", 150, 8, { bold: true, color: MUTED });
  text(x, "DATE", 430, 8, { bold: true, color: MUTED }); text(x, "AMOUNT", 558, 8, { bold: true, color: MUTED, right: true });
  x.y -= 8; x.page.drawLine({ start: { x: 54, y: x.y }, end: { x: 558, y: x.y }, thickness: 0.6, color: LINE });
  for (const i of invs) {
    x.y -= 16;
    text(x, i.number, 54, 9.5);
    text(x, wrap(x.font, matterTitle(i.pin, i.address1 || i.pname, i.city, i.township), 9.5, 270)[0], 150, 9.5);
    text(x, fmtDate(i.issued_on), 430, 9.5); text(x, formatMoney(i.total), 558, 9.5, { right: true });
  }
  x.y -= 10; x.page.drawLine({ start: { x: 300, y: x.y }, end: { x: 558, y: x.y }, thickness: 0.6, color: LINE });
  x.y -= 18; text(x, "Total due", 420, 11, { bold: true }); text(x, formatMoney(st.total), 558, 12, { bold: true, right: true });
  footer(x, st.status === "open" ? link : null, s.invoice_note,
    `This statement replaces the separate invoices listed. Payment of the full statement is due by ${fmtDate(st.due_on)}.`);
  return Buffer.from(await doc.save());
}
