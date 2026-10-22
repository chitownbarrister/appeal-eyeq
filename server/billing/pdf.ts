// Invoice, statement and settlement-letter PDFs on the firm's letterhead (Settings, Billing):
// its logo and details at the top, its accent color (copper by default), and on invoices and
// statements a "How to pay" block with the pay link, a QR code for it, and check remittance details.

import type pg from "pg";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import qrcode from "qrcode-generator";
import { matterTitle } from "../../shared/domain.js";
import { formatMoney } from "../../shared/money.js";
import { billingSettings } from "./core.js";

const NAVY = rgb(10 / 255, 31 / 255, 68 / 255);
const COPPER_HEX = "#B8733E";
const MUTED = rgb(0.37, 0.4, 0.47);
const LINE = rgb(0.87, 0.88, 0.9);
const PAPER = rgb(247 / 255, 245 / 255, 240 / 255);
const L = 54;
const R = 558;
const BOTTOM = 72;

export const hexToRgb = (hex: string): RGB => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(COPPER_HEX)!;
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
};

const fmtDate = (iso: string | null) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
/** pdf-lib's standard fonts only carry the Windows-1252 characters; anything else becomes a plain stand-in. */
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E -ÿ–—•€]/g, "-");

// ---------------------------------------------------------------- the letterhead ("look")
export interface Look {
  name: string;
  address: string | null;
  contact: string;
  accent: RGB;
  logo: { bytes: Buffer; type: "image/png" | "image/jpeg" } | null;
  remit: string | null;
  note: string | null;
}

/** What the settings screen may change before saving, so the preview shows it. */
export interface LookDraft {
  letterheadName?: string | null; letterheadAddress?: string | null; letterheadPhone?: string | null; letterheadWebsite?: string | null;
  invoiceNote?: string | null; remitTo?: string | null; accentColor?: string | null;
}

export async function lookFor(c: pg.PoolClient, firmId: number, draft: LookDraft = {}): Promise<Look> {
  const f = (await c.query(`SELECT name, letterhead_name, letterhead_address, letterhead_phone, letterhead_website FROM firms WHERE id = $1`, [firmId])).rows[0];
  const s = await billingSettings(c, firmId);
  const logo = (await c.query<{ content: Buffer; content_type: "image/png" | "image/jpeg" }>(`SELECT content, content_type FROM firm_logos WHERE firm_id = $1`, [firmId])).rows[0];
  const pick = <T>(d: T | undefined, saved: T) => (d === undefined ? saved : d);
  const phone = pick(draft.letterheadPhone, f.letterhead_phone);
  const web = pick(draft.letterheadWebsite, f.letterhead_website);
  return {
    name: pick(draft.letterheadName, f.letterhead_name) || f.name,
    address: pick(draft.letterheadAddress, f.letterhead_address) || null,
    contact: [phone, web].filter(Boolean).join("  ·  "),
    accent: hexToRgb(pick(draft.accentColor, s.accent_color) || COPPER_HEX),
    logo: logo ? { bytes: logo.content, type: logo.content_type } : null,
    remit: pick(draft.remitTo, s.remit_to) || null,
    note: pick(draft.invoiceNote, s.invoice_note) || null,
  };
}

// ---------------------------------------------------------------- drawing
interface Ctx { doc: PDFDocument; page: PDFPage; font: PDFFont; bold: PDFFont; y: number; look: Look; logo: PDFImage | null; running: string; pages: PDFPage[] }

function text(x: Ctx, s: string, at: number, size = 10, opts: { bold?: boolean; color?: RGB; right?: boolean } = {}) {
  const f = opts.bold ? x.bold : x.font;
  const str = safe(s);
  const w = f.widthOfTextAtSize(str, size);
  x.page.drawText(str, { x: opts.right ? at - w : at, y: x.y, size, font: f, color: opts.color ?? NAVY });
}

function wrap(f: PDFFont, s: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split(/\r?\n/).map(safe)) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Long text with no spaces (a pay link) broken to fit. */
function breakLong(f: PDFFont, s: string, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of safe(s)) {
    if (f.widthOfTextAtSize(line + ch, size) > width && line) { out.push(line); line = ch; } else line += ch;
  }
  if (line) out.push(line);
  return out;
}

const rule = (x: Ctx, from = L, to = R, color = LINE, thickness = 0.6) => x.page.drawLine({ start: { x: from, y: x.y }, end: { x: to, y: x.y }, thickness, color });

function newPage(x: Ctx): void {
  x.page = x.doc.addPage([612, 792]);
  x.pages.push(x.page);
  x.y = 748;
  text(x, x.look.name, L, 10, { bold: true });
  text(x, x.running, R, 9, { right: true, color: MUTED });
  x.y -= 8;
  rule(x, L, R, x.look.accent, 1);
  x.y -= 24;
}

/** Starts a new page when the next block won't fit above the footer. */
function need(x: Ctx, height: number): void {
  if (x.y - height < BOTTOM) newPage(x);
}

async function start(look: Look, title: string, running: string): Promise<Ctx> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const x: Ctx = {
    doc, page, pages: [page], font: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold),
    y: 748, look, logo: null, running,
  };
  if (look.logo) {
    try { x.logo = look.logo.type === "image/png" ? await doc.embedPng(look.logo.bytes) : await doc.embedJpg(look.logo.bytes); } catch { x.logo = null; }
  }
  // Left: the logo (scaled to fit 190 x 54), the firm's name under it; or the name alone, larger.
  const top = 756;
  let leftBottom: number;
  if (x.logo) {
    const s = Math.min(190 / x.logo.width, 54 / x.logo.height, 1);
    const w = x.logo.width * s, h = x.logo.height * s;
    page.drawImage(x.logo, { x: L, y: top - h, width: w, height: h });
    x.y = top - h - 14;
    text(x, look.name, L, 10.5, { bold: true });
    leftBottom = x.y;
  } else {
    x.y = top - 18;
    text(x, look.name, L, 18, { bold: true });
    leftBottom = x.y;
  }
  // Right: address and contact, right aligned.
  x.y = top - 10;
  for (const l of [...wrap(x.font, look.address ?? "", 9, 250), ...(look.contact ? [look.contact] : [])]) { text(x, l, R, 9, { right: true, color: MUTED }); x.y -= 12; }
  x.y = Math.min(leftBottom, x.y + 12) - 12;
  rule(x, L, R, look.accent, 1.5);
  x.y -= 30;
  text(x, title, L, 22, { bold: true, color: look.accent });
  return x;
}

function finish(x: Ctx): void {
  const n = x.pages.length;
  x.pages.forEach((p, i) => {
    const str = safe(`${x.look.name}${n > 1 ? `  ·  Page ${i + 1} of ${n}` : ""}`);
    const w = x.font.widthOfTextAtSize(str, 8);
    p.drawText(str, { x: (612 - w) / 2, y: 36, size: 8, font: x.font, color: MUTED });
  });
}

interface Party { name: string; address1: string | null; address2: string | null; city: string | null; state: string | null; zip: string | null }

async function partyOf(c: pg.PoolClient, firmId: number, accountId: number): Promise<Party> {
  return (await c.query(`SELECT name, address1, address2, city, state, zip FROM accounts WHERE firm_id = $1 AND id = $2`, [firmId, accountId])).rows[0];
}

/** Client on the left, the document's facts on the right; leaves y under the taller of the two. */
function parties(x: Ctx, who: Party, label: string, facts: [string, string][], amountDue?: string) {
  const top = x.y;
  text(x, label, L, 8, { bold: true, color: MUTED });
  x.y -= 15; text(x, who.name, L, 11, { bold: true });
  for (const l of [who.address1, who.address2, [who.city, [who.state, who.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean) as string[]) { x.y -= 13; text(x, l, L, 10); }
  const left = x.y;
  x.y = top;
  for (const [k, v] of facts) { text(x, k, 380, 9, { color: MUTED }); text(x, v, R, 10, { right: true, bold: k === facts[0][0] }); x.y -= 15; }
  if (amountDue !== undefined) {
    x.y -= 4;
    x.page.drawRectangle({ x: 370, y: x.y - 9, width: R - 370 + 4, height: 28, color: PAPER });
    text(x, "Amount due", 380, 9, { bold: true });
    text(x, formatMoney(amountDue), R - 6, 14, { bold: true, right: true, color: x.look.accent });
    x.y -= 24;
  }
  x.y = Math.min(left, x.y) - 26;
}

function matterBlock(x: Ctx, title: string, sub: string | null) {
  const h = sub ? 40 : 28;
  need(x, h + 10);
  x.page.drawRectangle({ x: L, y: x.y - h + 14, width: R - L, height: h, color: PAPER });
  text(x, "MATTER", L + 10, 7.5, { bold: true, color: MUTED });
  x.y -= 0;
  text(x, wrap(x.font, title, 10, 400)[0] ?? "", L + 62, 10, { bold: true });
  if (sub) { x.y -= 14; text(x, sub, L + 62, 9.5, { color: MUTED }); }
  x.y -= h - (sub ? 14 : 0) + 4;
}

function tableHead(x: Ctx, cols: [string, number, boolean?][]) {
  need(x, 40);
  for (const [label, at, right] of cols) text(x, label, at, 7.5, { bold: true, color: MUTED, right });
  x.y -= 7;
  rule(x, L, R, x.look.accent, 0.8);
}

function totalRow(x: Ctx, label: string, amount: string) {
  need(x, 44);
  x.y -= 20;
  x.page.drawRectangle({ x: 330, y: x.y - 10, width: R - 330 + 4, height: 26, color: PAPER });
  text(x, label, 342, 10.5, { bold: true });
  text(x, formatMoney(amount), R - 6, 12, { bold: true, right: true });
  x.y -= 30;
}

/** A QR code for the pay link, drawn as squares (no image needed). */
function drawQr(x: Ctx, link: string, at: number, top: number, size: number) {
  const q = qrcode(0, "M");
  q.addData(link);
  q.make();
  const n = q.getModuleCount();
  const cell = size / (n + 2);
  x.page.drawRectangle({ x: at, y: top - size, width: size, height: size, color: rgb(1, 1, 1) });
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (q.isDark(r, col)) x.page.drawRectangle({ x: at + cell * (col + 1), y: top - cell * (r + 2), width: cell, height: cell, color: NAVY });
    }
  }
}

/** "How to pay": online (link and QR) on the left when there's a live link, by check on the right. */
function howToPay(x: Ctx, link: string | null, dueText: string, numberWord: string) {
  need(x, 130);
  x.y -= 8;
  text(x, "HOW TO PAY", L, 8, { bold: true, color: MUTED });
  x.y -= 8;
  rule(x);
  x.y -= 18;
  const top = x.y;
  const checkAt = link ? 330 : L;
  if (link) {
    drawQr(x, link, L, top + 8, 76);
    const tx = L + 88;
    text(x, "Pay online", tx, 10, { bold: true });
    x.y -= 13; text(x, "Bank account (ACH) or card.", tx, 9, { color: MUTED });
    x.y -= 13; text(x, "Scan the code or open:", tx, 9, { color: MUTED });
    for (const l of breakLong(x.font, link, 8, 175)) { x.y -= 11; text(x, l, tx, 8, { color: x.look.accent }); }
  }
  const leftBottom = Math.min(x.y, top - 76);
  x.y = top;
  text(x, "Pay by check", checkAt, 10, { bold: true });
  const remit = x.look.remit ?? [`Payable to ${x.look.name}`, x.look.address].filter(Boolean).join("\n");
  for (const l of wrap(x.font, remit, 9, link ? R - checkAt : 300)) { x.y -= 13; text(x, l, checkAt, 9); }
  x.y -= 13; text(x, `Please write the ${numberWord} number on the check.`, checkAt, 9, { color: MUTED });
  x.y = Math.min(leftBottom, x.y) - 22;
  need(x, 30);
  for (const l of wrap(x.font, dueText, 9.5, R - L)) { text(x, l, L, 9.5); x.y -= 13; }
  if (x.look.note) for (const l of wrap(x.font, x.look.note, 9, R - L)) { need(x, 14); text(x, l, L, 9, { color: MUTED }); x.y -= 12; }
}

// ---------------------------------------------------------------- invoices
export interface InvoiceData {
  status: "draft" | "sent" | "paid" | "void";
  number: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  total: string;
  billTo: Party;
  matter: string;
  appeal: string | null;
  note: string | null;
  lines: { description: string; amount: string }[];
  attachments: string[];
}

export async function renderInvoice(look: Look, d: InvoiceData, link: string | null): Promise<Buffer> {
  const title = d.status === "draft" ? "DRAFT INVOICE" : d.status === "void" ? "VOID INVOICE" : d.status === "paid" ? "INVOICE (PAID)" : "INVOICE";
  const x = await start(look, title, `Invoice ${d.number ?? "(draft)"}, continued`);
  x.y -= 30;
  parties(x, d.billTo, "BILL TO", [["Invoice", d.number ?? "Draft"], ["Date", fmtDate(d.issuedOn) || "Not sent yet"], ["Due", fmtDate(d.dueOn) || "On receipt"]],
    d.status === "paid" ? "0.00" : d.total);
  matterBlock(x, d.matter, d.appeal);
  x.y -= 18;
  tableHead(x, [["DESCRIPTION", L], ["AMOUNT", R, true]]);
  for (const l of d.lines) {
    const parts = wrap(x.font, l.description, 10, 400);
    need(x, 18 + parts.length * 13);
    x.y -= 17;
    text(x, parts[0] ?? "", L, 10); text(x, formatMoney(l.amount), R, 10, { right: true });
    for (const more of parts.slice(1)) { x.y -= 13; text(x, more, L, 10); }
    x.y -= 7;
    rule(x);
  }
  totalRow(x, d.status === "paid" ? "Total (paid)" : "Total due", d.total);
  if (d.note) for (const l of wrap(x.font, d.note, 9.5, R - L)) { need(x, 14); text(x, l, L, 9.5); x.y -= 13; }
  if (d.attachments.length) {
    need(x, 20 + d.attachments.length * 12);
    x.y -= 6;
    text(x, "ATTACHED", L, 8, { bold: true, color: MUTED });
    for (const a of d.attachments) { x.y -= 12; text(x, `•  ${a}`, L, 9); }
    x.y -= 16;
  }
  if (d.status === "sent" || d.status === "draft") {
    howToPay(x, d.status === "sent" ? link : null,
      d.dueOn ? `Payment in full is due by ${fmtDate(d.dueOn)}.` : "Payment in full is due on receipt.", "invoice");
  } else if (look.note) {
    for (const l of wrap(x.font, look.note, 9, R - L)) { need(x, 14); text(x, l, L, 9, { color: MUTED }); x.y -= 12; }
  }
  finish(x);
  return Buffer.from(await x.doc.save());
}

export async function invoicePdf(c: pg.PoolClient, firmId: number, invoiceId: number, link: string | null): Promise<Buffer> {
  const inv = (await c.query(
    `SELECT i.*, a.assessment_year, a.level, a.petition_no, p.address1, p.name AS pname, p.city, t.name AS township,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM invoices i JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN townships t ON t.id = p.township_id
       LEFT JOIN appeals a ON a.firm_id = i.firm_id AND a.id = i.appeal_id
      WHERE i.firm_id = $1 AND i.id = $2`,
    [firmId, invoiceId],
  )).rows[0];
  const lines = (await c.query(`SELECT description, amount FROM invoice_lines WHERE firm_id = $1 AND invoice_id = $2 ORDER BY position, id`, [firmId, invoiceId])).rows;
  const attachments = (await c.query<{ name: string }>(`SELECT name FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = $2 ORDER BY position, id`, [firmId, invoiceId])).rows;
  const LEVEL_NAME: Record<string, string> = { assessor: "Assessor", bor: "Board of Review", ptab: "Property Tax Appeal Board", circuit: "Circuit Court" };
  return renderInvoice(await lookFor(c, firmId), {
    status: inv.status, number: inv.number, issuedOn: inv.issued_on, dueOn: inv.due_on, total: inv.total,
    billTo: await partyOf(c, firmId, inv.account_id),
    matter: matterTitle(inv.pin, inv.address1 || inv.pname, inv.city, inv.township),
    appeal: inv.level ? `${inv.assessment_year} ${LEVEL_NAME[inv.level] ?? inv.level} appeal${inv.petition_no ? `, ${inv.petition_no}` : ""}` : null,
    note: inv.note, lines, attachments: attachments.map((a) => a.name),
  }, link);
}

/** A sample invoice on the letterhead being edited in Settings (nothing saved, nothing numbered). */
export async function invoicePreviewPdf(c: pg.PoolClient, firmId: number, draft: LookDraft): Promise<Buffer> {
  const look = await lookFor(c, firmId, draft);
  const today = new Date().toISOString().slice(0, 10);
  return renderInvoice(look, {
    status: "sent", number: "SAMPLE-0001", issuedOn: today, dueOn: today, total: "2400.00",
    billTo: { name: "Sample Client LLC", address1: "100 Main Street", address2: null, city: "Chicago", state: "IL", zip: "60601" },
    matter: "PIN 17-08-101-022 · 1415 W. Grand Ave., Chicago (West Chicago)", appeal: "2025 Board of Review appeal",
    note: null,
    lines: [{ description: "Board of Review fee: 40% of first-year savings of $6,000.00", amount: "2400.00" }],
    attachments: ["2025 BOR decision letter.pdf"],
  }, "https://appeal-eyeq.example/pay/sample-link-for-preview");
}

// ---------------------------------------------------------------- statements
export async function statementPdf(c: pg.PoolClient, firmId: number, statementId: number, link: string | null): Promise<Buffer> {
  const st = (await c.query(`SELECT * FROM statements WHERE firm_id = $1 AND id = $2`, [firmId, statementId])).rows[0];
  const invs = (await c.query(
    `SELECT i.number, i.issued_on, i.total, p.address1, p.name AS pname, p.city, t.name AS township,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM invoices i JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE i.firm_id = $1 AND i.statement_id = $2 ORDER BY i.issued_on, i.number`,
    [firmId, statementId],
  )).rows;
  const look = await lookFor(c, firmId);
  const x = await start(look, st.status === "void" ? "VOID STATEMENT" : "STATEMENT", `Statement ${st.number}, continued`);
  x.y -= 30;
  parties(x, await partyOf(c, firmId, st.account_id), "BILL TO", [["Statement", st.number], ["Date", fmtDate(st.issued_on)], ["Due", fmtDate(st.due_on)]],
    st.status === "paid" ? "0.00" : st.total);
  x.y -= 4;
  tableHead(x, [["INVOICE", L], ["MATTER", 150], ["DATE", 430], ["AMOUNT", R, true]]);
  for (const i of invs) {
    need(x, 24);
    x.y -= 16;
    text(x, i.number, L, 9.5);
    text(x, wrap(x.font, matterTitle(i.pin, i.address1 || i.pname, i.city, i.township), 9.5, 270)[0], 150, 9.5);
    text(x, fmtDate(i.issued_on), 430, 9.5); text(x, formatMoney(i.total), R, 9.5, { right: true });
    x.y -= 7;
    rule(x);
  }
  totalRow(x, st.status === "paid" ? "Total (paid)" : "Total due", st.total);
  if (st.status === "open") {
    howToPay(x, link, `This statement replaces the separate invoices listed. Payment of the full statement is due by ${fmtDate(st.due_on)}.`, "statement");
  }
  finish(x);
  return Buffer.from(await x.doc.save());
}

/**
 * The client's settlement letter for a refund held in trust: the refund received, the fee,
 * any expenses the firm fronted, and what's paid to the client (and how, once paid).
 */
export async function settlementPdf(c: pg.PoolClient, firmId: number, settlementId: number): Promise<Buffer> {
  const s = (await c.query(
    `SELECT s.*, a.assessment_year, a.level, a.petition_no, p.address1, p.name AS pname, p.city, t.name AS township, ac.name AS client,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM trust_settlements s JOIN appeals a ON a.firm_id = s.firm_id AND a.id = s.appeal_id
       JOIN properties p ON p.firm_id = s.firm_id AND p.id = s.property_id LEFT JOIN townships t ON t.id = p.township_id
       JOIN accounts ac ON ac.firm_id = s.firm_id AND ac.id = s.account_id
      WHERE s.firm_id = $1 AND s.id = $2`,
    [firmId, settlementId],
  )).rows[0];
  const exps = (await c.query(
    `SELECT e.incurred_on, e.vendor, e.description, se.amount FROM settlement_expenses se JOIN expenses e ON e.firm_id = se.firm_id AND e.id = se.expense_id
      WHERE se.firm_id = $1 AND se.settlement_id = $2 ORDER BY e.incurred_on, e.id`,
    [firmId, settlementId],
  )).rows;
  const level = s.level === "ptab" ? "Property Tax Appeal Board" : "Circuit Court";
  const x = await start(await lookFor(c, firmId), s.status === "paid" ? "REFUND SETTLEMENT" : s.status === "void" ? "VOID" : "SETTLEMENT (DRAFT)", "Refund settlement, continued");
  x.y -= 30;
  parties(x, await partyOf(c, firmId, s.account_id), "CLIENT", [["Refund received", fmtDate(s.refund_received_on)], ["Paid to you", s.paid_on ? fmtDate(s.paid_on) : "Pending"]]);
  matterBlock(x, matterTitle(s.pin, s.address1 || s.pname, s.city, s.township), `${s.assessment_year} ${level} appeal${s.petition_no ? `, ${s.petition_no}` : ""}`);
  x.y -= 18;
  for (const l of wrap(x.font, `The refund from your ${level} appeal arrived and was deposited to our client trust account. This is how it was divided.`, 10, 504)) { text(x, l, 54, 10); x.y -= 14; }
  x.y -= 10;
  const row = (label: string, amount: string, o: { bold?: boolean; minus?: boolean } = {}) => {
    need(x, 20);
    text(x, label, 54, 10, { bold: o.bold }); text(x, `${o.minus ? "Less " : ""}${formatMoney(amount)}`, 558, 10, { right: true, bold: o.bold }); x.y -= 16;
  };
  row("Refund received, including interest", s.refund_amount);
  const basis = s.fee_basis ?? {};
  const feeLabel = basis.noFee ? "Our fee (waived)" : basis.flat ? "Our fee (flat fee)" : `Our fee, ${basis.percent ?? ""}% of the refund${basis.cap ? `, capped at ${formatMoney(basis.cap)}` : ""}`;
  row(feeLabel, s.fee_amount, { minus: true });
  if (exps.length) {
    row("Expenses we advanced for you", s.expenses_amount, { minus: true });
    for (const e of exps) {
      x.y += 2;
      text(x, `${fmtDate(e.incurred_on)}  ${e.vendor}: ${e.description}`.slice(0, 95), 70, 9, { color: MUTED }); text(x, formatMoney(e.amount), 480, 9, { right: true, color: MUTED });
      x.y -= 13;
    }
    x.y -= 3;
  }
  x.page.drawLine({ start: { x: 300, y: x.y + 6 }, end: { x: 558, y: x.y + 6 }, thickness: 0.6, color: LINE });
  x.y -= 6;
  row(s.status === "paid" ? "Paid to you" : "To be paid to you", s.client_amount, { bold: true });
  x.y -= 16;
  if (s.status === "paid") {
    const how = s.payout_method === "ach" ? `by ACH${s.payout_reference ? ` (reference ${s.payout_reference})` : ""}` : `by check${s.payout_reference ? ` number ${s.payout_reference}` : ""}`;
    for (const l of wrap(x.font, `We paid ${formatMoney(s.client_amount)} to you ${how} on ${fmtDate(s.paid_on)}.`, 10, 504)) { text(x, l, 54, 10); x.y -= 14; }
  }
  if (s.note) for (const l of wrap(x.font, s.note, 9, 504)) { x.y -= 4; text(x, l, 54, 9, { color: MUTED }); x.y -= 10; }
  finish(x);
  return Buffer.from(await x.doc.save());
}
