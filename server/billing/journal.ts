// The accounting journal: every money event Appeal EyeQ records, as balanced double-entry
// lines with suggested account names. Today it's the CSV the firm's accountant imports or
// reads; later the QuickBooks sync posts these same entries (with the firm's own account
// mapping), so nothing about the books is worked out twice. Cash basis for fees received;
// invoices post to receivables when sent.

import type pg from "pg";
import { LEVEL_LABELS, type Level } from "../../shared/domain.js";
import { centsToString, toCents } from "../../shared/money.js";

export const ACCOUNTS = {
  ar: "Accounts receivable",
  feeIncome: "Legal fee income",
  otherIncome: "Other income",
  costsAdvanced: "Client costs advanced",
  writeOff: "Client costs written off",
  operating: "Operating bank",
  stripe: "Stripe clearing",
  trustBank: "Trust bank (IOLTA)",
  trustLiability: "Client trust funds (liability)",
} as const;

export interface JournalLine { date: string; entry: string; account: string; debit: string; credit: string; client: string; matter: string; memo: string; reference: string; source: string }

const d = (v: unknown) => String(v).slice(0, 10);

export async function journal(c: pg.PoolClient, firmId: number, from: string, to: string): Promise<JournalLine[]> {
  const out: JournalLine[] = [];
  let n = 0;
  const entry = (date: string, client: string, matter: string, memo: string, reference: string, source: string, lines: [string, bigint, bigint][]) => {
    n += 1;
    for (const [account, dr, cr] of lines) {
      if (dr === 0n && cr === 0n) continue;
      out.push({ date, entry: `JE-${String(n).padStart(5, "0")}`, account, debit: dr ? centsToString(dr) : "", credit: cr ? centsToString(cr) : "", client, matter, memo, reference, source });
    }
  };
  const matterOf = (r: { address1: string | null; pname: string | null; assessment_year?: number | null; level?: string | null }) =>
    [r.address1 || r.pname, r.level ? `${r.assessment_year} ${LEVEL_LABELS[r.level as Level]}` : null].filter(Boolean).join(", ");

  // Invoices sent: receivable against fee income, expense reimbursement and other lines.
  const invs = (await c.query(
    `SELECT i.id, i.number, i.issued_on, i.status, i.updated_at, ac.name AS client, p.address1, p.name AS pname, a.assessment_year, a.level,
            COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'fee'), 0) AS fee, COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'expense'), 0) AS exp,
            COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'other'), 0) AS other
       FROM invoices i JOIN accounts ac ON ac.firm_id = i.firm_id AND ac.id = i.account_id JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id
       LEFT JOIN appeals a ON a.firm_id = i.firm_id AND a.id = i.appeal_id LEFT JOIN invoice_lines l ON l.firm_id = i.firm_id AND l.invoice_id = i.id
      WHERE i.firm_id = $1 AND i.number IS NOT NULL
      GROUP BY i.id, ac.name, p.address1, p.name, a.assessment_year, a.level ORDER BY i.issued_on, i.id`,
    [firmId],
  )).rows;
  for (const i of invs) {
    const fee = toCents(i.fee), exp = toCents(i.exp), other = toCents(i.other), total = fee + exp + other;
    const lines: [string, bigint, bigint][] = [[ACCOUNTS.ar, total, 0n], [ACCOUNTS.feeIncome, 0n, fee], [ACCOUNTS.costsAdvanced, 0n, exp], [ACCOUNTS.otherIncome, 0n, other]];
    if (d(i.issued_on) >= from && d(i.issued_on) <= to) entry(d(i.issued_on), i.client, matterOf(i), `Invoice ${i.number}`, i.number, "invoice", lines);
    if (i.status === "void" && d(i.updated_at) >= from && d(i.updated_at) <= to) {
      entry(d(i.updated_at), i.client, matterOf(i), `Invoice ${i.number} voided`, i.number, "invoice void", lines.map(([a, dr, cr]) => [a, cr, dr]));
    }
  }

  // Payments received: card and ACH land in Stripe clearing (Stripe pays out net of its fees); checks in operating.
  const pays = (await c.query(
    `SELECT y.id, y.amount, y.method, y.received_on, y.check_number, y.reference, ac.name AS client, COALESCE(i.number, s.number) AS number
       FROM payments y JOIN accounts ac ON ac.firm_id = y.firm_id AND ac.id = y.account_id
       LEFT JOIN invoices i ON i.firm_id = y.firm_id AND i.id = y.invoice_id LEFT JOIN statements s ON s.firm_id = y.firm_id AND s.id = y.statement_id
      WHERE y.firm_id = $1 AND y.status = 'succeeded' AND y.received_on BETWEEN $2 AND $3 ORDER BY y.received_on, y.id`,
    [firmId, from, to],
  )).rows;
  for (const p of pays) {
    const amt = toCents(p.amount);
    const bank = p.method === "card" || p.method === "ach" ? ACCOUNTS.stripe : ACCOUNTS.operating;
    entry(d(p.received_on), p.client, "", `Payment on ${p.number} (${p.method})`, p.check_number ? `Check ${p.check_number}` : p.reference ?? "", "payment", [[bank, amt, 0n], [ACCOUNTS.ar, 0n, amt]]);
  }

  // Expenses the firm fronted, and any written off.
  const exps = (await c.query(
    `SELECT e.id, e.incurred_on, e.vendor, e.description, e.amount, e.written_off_at, ac.name AS client, p.address1, p.name AS pname
       FROM expenses e JOIN accounts ac ON ac.firm_id = e.firm_id AND ac.id = e.account_id JOIN properties p ON p.firm_id = e.firm_id AND p.id = e.property_id
      WHERE e.firm_id = $1 ORDER BY e.incurred_on, e.id`,
    [firmId],
  )).rows;
  for (const e of exps) {
    const amt = toCents(e.amount);
    if (d(e.incurred_on) >= from && d(e.incurred_on) <= to) entry(d(e.incurred_on), e.client, matterOf(e), `${e.vendor}: ${e.description}`, "", "expense", [[ACCOUNTS.costsAdvanced, amt, 0n], [ACCOUNTS.operating, 0n, amt]]);
    if (e.written_off_at && d(e.written_off_at) >= from && d(e.written_off_at) <= to) entry(d(e.written_off_at), e.client, matterOf(e), `Written off: ${e.vendor}`, "", "expense write-off", [[ACCOUNTS.writeOff, amt, 0n], [ACCOUNTS.costsAdvanced, 0n, amt]]);
  }

  // Trust: deposits, the fee and reimbursed expenses moving to operating, and payouts to clients.
  const tr = (await c.query(
    `SELECT t.id, t.kind, t.amount, t.entry_on, t.memo, t.reference, ac.name AS client, p.address1, p.name AS pname, a.assessment_year, a.level
       FROM trust_entries t JOIN accounts ac ON ac.firm_id = t.firm_id AND ac.id = t.account_id
       LEFT JOIN appeals a ON a.firm_id = t.firm_id AND a.id = t.appeal_id LEFT JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
      WHERE t.firm_id = $1 AND t.entry_on BETWEEN $2 AND $3 ORDER BY t.entry_on, t.id`,
    [firmId, from, to],
  )).rows;
  for (const t of tr) {
    const amt = toCents(t.amount) < 0n ? -toCents(t.amount) : toCents(t.amount);
    const m = matterOf(t);
    if (t.kind === "deposit") entry(d(t.entry_on), t.client, m, t.memo ?? "Refund deposited to trust", t.reference ?? "", "trust deposit", [[ACCOUNTS.trustBank, amt, 0n], [ACCOUNTS.trustLiability, 0n, amt]]);
    if (t.kind === "fee") entry(d(t.entry_on), t.client, m, "Fee earned from trust", "", "trust fee", [[ACCOUNTS.trustLiability, amt, 0n], [ACCOUNTS.trustBank, 0n, amt], [ACCOUNTS.operating, amt, 0n], [ACCOUNTS.feeIncome, 0n, amt]]);
    if (t.kind === "expenses") entry(d(t.entry_on), t.client, m, "Fronted expenses reimbursed from trust", "", "trust expenses", [[ACCOUNTS.trustLiability, amt, 0n], [ACCOUNTS.trustBank, 0n, amt], [ACCOUNTS.operating, amt, 0n], [ACCOUNTS.costsAdvanced, 0n, amt]]);
    if (t.kind === "payout") entry(d(t.entry_on), t.client, m, t.memo ?? "Paid to client", t.reference ?? "", "trust payout", [[ACCOUNTS.trustLiability, amt, 0n], [ACCOUNTS.trustBank, 0n, amt]]);
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || a.entry.localeCompare(b.entry));
  // Renumber in date order so entries read top to bottom.
  const map = new Map<string, string>();
  for (const l of out) if (!map.has(l.entry)) map.set(l.entry, `JE-${String(map.size + 1).padStart(5, "0")}`);
  return out.map((l) => ({ ...l, entry: map.get(l.entry)! }));
}

const cell = (v: string) => (/[",\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);

export function journalCsv(lines: JournalLine[]): string {
  const head = ["Date", "Entry", "Account", "Debit", "Credit", "Client", "Matter", "Memo", "Reference", "Source"];
  return [head.join(","), ...lines.map((l) => [l.date, l.entry, l.account, l.debit, l.credit, l.client, l.matter, l.memo, l.reference, l.source].map(cell).join(","))].join("\r\n") + "\r\n";
}
