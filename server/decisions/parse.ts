// Deterministic parsers for Illinois decision letters, read from OCR or a PDF text
// layer. Four kinds: the Assessor's appeal result letter, the Board of Review's
// decision notice, PTAB's Final Administrative Decision, and a Circuit Court
// (tax objection) agreed judgment order. Collar-county letters are read with the
// same rules as Cook's (Dillon, Oct 20, 2026). Nothing here guesses a figure: a
// value that can't be read is left empty and listed in `problems`, so the letter
// goes to review.

export type LetterKind = "assessor" | "bor" | "ptab" | "circuit" | "unknown";
export const LETTER_KINDS: LetterKind[] = ["assessor", "bor", "ptab", "circuit", "unknown"];
export type Outcome = "reduced" | "no_change" | "increased" | "agreed";
export const OUTCOMES: Outcome[] = ["reduced", "no_change", "increased", "agreed"];

export interface LetterPin {
  pin: string | null;           // as printed, tidied ("05-17-302-010-0000"); null when unreadable
  origAv: string | null;        // the AV going in (Assessor: proposed; BOR: Assessor original; Circuit: the excessive AV)
  land: string | null;          // decided land (PTAB)
  impr: string | null;          // decided building (PTAB)
  av: string | null;            // decided total AV
  priorAv?: string | null;      // Assessor: last year's AV
  className?: string | null;    // Assessor: property class
  complaintNo?: string | null;  // BOR: complaint number on this row
  change?: string | null;       // BOR: the change column
}

export interface LetterFields {
  kind: LetterKind;
  county: string | null;
  year: number | null;          // assessment year
  letterDate: string | null;    // YYYY-MM-DD
  outcome: Outcome | null;
  reference: string | null;     // PTAB docket, BOR complaint, Assessor appeal number, Circuit objection number
  township?: string | null;
  pins: LetterPin[];
  refund?: string | null;       // Circuit: refund ordered (before interest)
  equalizer?: string | null;    // Circuit
  taxRatePercent?: string | null; // Circuit
  excessAv?: string | null;     // Circuit
  total?: { land: string | null; impr: string | null; av: string | null } | null; // PTAB: one decided total for several PINs
  problems: string[];
}

export const COUNTIES = ["Cook", "DuPage", "Kane", "Lake", "McHenry", "Will", "Kendall", "DeKalb", "Grundy", "Kankakee"];

// ---------------------------------------------------------------- small readers
/** Common OCR slips inside something that should be a number: O for 0, l or I or | for 1, S for 5. */
function fixDigits(s: string): string {
  return s.replace(/[Oo]/g, "0").replace(/[lI|!]/g, "1").replace(/S/g, "5").replace(/B/g, "8");
}

/**
 * "$182,484", "182.484" (a comma read as a period), "$9.741.19", "26,954.69", "0" → exact decimal string.
 * The last separator is a decimal point only when exactly two digits follow it.
 */
export function parseAmount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const neg = /^\s*\(.*\)\s*$/.test(raw) || /^\s*-/.test(raw);
  const s = fixDigits(raw.replace(/[$\s_()-]/g, "")).replace(/[^0-9.,]/g, "").replace(/[.,]+$/, "");
  if (!/\d/.test(s)) return null;
  let whole = s;
  let cents = "00";
  const m = s.match(/^(.*)[.,](\d{2})$/);
  if (m) { whole = m[1]; cents = m[2]; }
  const groups = whole.split(/[.,]/);
  if (groups.some((g) => g === "")) return null;
  // groups after the first must be exactly three digits, or the reading is doubtful
  if (groups.length > 1 && (groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3))) return null;
  return `${neg ? "-" : ""}${groups.join("").replace(/^0+(?=\d)/, "")}.${cents}`;
}

const AMOUNT_TOKEN = /\$?\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?(?!\d)|\$?\s?\d{4,}(?:[.,]\d{2})?(?!\d)|(?<![\d,.-])0(?![\d,.])/g;
const GROUPED_TOKEN = /\$?\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?(?!\d)|(?<![\d,.-])0(?![\d,.])/g;
/**
 * Amount-looking tokens in a line, in order. Two figures OCR ran together ("70,000.63,000") are
 * split first. When the line has at least `preferGrouped` figures printed with thousands commas,
 * only those count, so a reference number like 2026-00451 isn't read as money.
 */
function amountsIn(line: string, preferGrouped = 0): string[] {
  const l = line.replace(/;/g, ",").replace(/(\d,\d{3})[.](?=\d{1,3},\d{3}(?!\d))/g, "$1 ");
  const read = (re: RegExp) => (l.match(re) ?? []).map((t) => parseAmount(t)).filter((x): x is string => x !== null);
  if (preferGrouped) {
    const grouped = read(GROUPED_TOKEN);
    if (grouped.filter((x) => x !== "0.00").length >= preferGrouped) return grouped;
  }
  return read(AMOUNT_TOKEN);
}

/** Tidy a PIN from its digit groups. 14 digits: Cook (2-2-3-3-4); 10: 2-2-3-3; 16 or 12: Will (2-2-2-3-3-4). */
function formatPin(digits: string): string | null {
  if (digits.length === 16) return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 9)}-${digits.slice(9, 12)}-${digits.slice(12)}`;
  if (digits.length === 12) return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 9)}-${digits.slice(9)}`;
  if (digits.length === 14) return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}-${digits.slice(10)}`;
  if (digits.length === 10) return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return null;
}

const PIN_RE = /(?<![\d-])[0-9OIl]{2}(?:\s?[-–—]\s?[0-9OIl]{2,4}){3,5}(?![\d])/g;
/** PINs in a piece of text, tidied and without repeats. */
export function findPins(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(PIN_RE) ?? []) {
    const digits = fixDigits(m).replace(/\D/g, "");
    const pin = formatPin(digits);
    if (pin && !out.includes(pin)) out.push(pin);
  }
  return out;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function iso(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** The first date in the text: 03/27/2023 or March 27, 2023 (or 1002/2026, a slash OCR dropped). */
export function findDate(text: string): string | null {
  const a = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/) ?? text.match(/\b(\d{2})(\d{2})\/(\d{4})\b/);
  const b = text.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i"));
  const ai = a ? text.indexOf(a[0]) : Infinity;
  const bi = b ? text.indexOf(b[0]) : Infinity;
  if (a && ai <= bi) return iso(Number(a[3]), Number(a[1]), Number(a[2]));
  if (b) return iso(Number(b[3]), MONTHS.indexOf(b[1].toLowerCase()) + 1, Number(b[2]));
  return null;
}

function countyIn(text: string, counties: string[]): string | null {
  const re = new RegExp(`\\b(${counties.map((c) => c.replace(/([a-z])([A-Z])/g, "$1\\s?$2")).join("|")})\\s+County\\b`, "i");
  const m = text.match(re);
  if (!m) return null;
  const key = m[1].replace(/\s/g, "").toLowerCase();
  return counties.find((c) => c.toLowerCase() === key) ?? null;
}

function tidy(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\r/g, "");
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

// ---------------------------------------------------------------- classifying pages
const IS = {
  ptab: (t: string) => /FINAL\s+ADMINISTRATIVE\s+DECISION/i.test(t) || (/PROPERTY\s+TAX\s+APPEAL\s+BOARD/i.test(t) && /DOCKET\s*N[O0]/i.test(t))
    || /DOCKET\s*N[O0]\.?\s*:?\s*\d{4}\s*-\s*\d{5,6}\s*\.\s*\d{3}/i.test(t),
  circuit: (t: string) => /CIRCUIT\s+COURT\s+OF/i.test(t) && /(Valuation\s+Objection|Objection\s+N[O0]|JUDGMENT\s+ORDER|refund\s+to\s+the\s+Plaintiff)/i.test(t),
  bor: (t: string) => /BOARD\s+OF\s+REVIEW/i.test(t) && /(Assessed\s+Valuations|Board\s+of\s+Review\s+Final|COMPLAINT\s+TYPE|Board\s+Complaint)/i.test(t),
  assessor: (t: string) => /Assessor'?s\s+Office/i.test(t) || /Assessment\s+Appeal/i.test(t),
};

/** What kind of letter a page belongs to, and whether a new letter starts on it. */
export function classifyPage(raw: string): { kind: LetterKind; starts: boolean; blank: boolean } {
  const t = tidy(raw);
  const blank = (t.match(/[A-Za-z0-9]/g) ?? []).length < 25;
  if (blank) return { kind: "unknown", starts: false, blank };
  // Order matters: a Board of Review notice mentions PTAB and the Circuit Court in its "your options" paragraph.
  if (IS.ptab(t)) return { kind: "ptab", starts: /FINAL\s+ADMINISTRATIVE\s+DECISION/i.test(t), blank };
  if (IS.bor(t)) return { kind: "bor", starts: true, blank };
  if (IS.circuit(t)) return { kind: "circuit", starts: /IN\s+THE\s+CIRCUIT\s+COURT/.test(t), blank };
  if (IS.assessor(t)) return { kind: "assessor", starts: /\b[0-9O]{4}\s+Assessment\s+Appeal/i.test(t), blank };
  return { kind: "unknown", starts: false, blank };
}

/**
 * Groups a file's pages into letters. A page starts a new letter when it carries that
 * letter's first-page heading; anything else (an Assessor letter's back page, a PTAB
 * decision's later pages, a blank back side) belongs to the letter before it.
 */
export function splitIntoLetters(pageTexts: string[]): { from: number; to: number; kind: LetterKind }[] {
  const out: { from: number; to: number; kind: LetterKind }[] = [];
  pageTexts.forEach((text, i) => {
    const c = classifyPage(text);
    const prev = out[out.length - 1];
    const continues = prev && !c.starts && (c.blank || c.kind === "unknown" || c.kind === prev.kind || prev.kind === "unknown");
    if (continues) {
      prev.to = i + 1;
      if (prev.kind === "unknown" && c.kind !== "unknown") prev.kind = c.kind;
    } else {
      out.push({ from: i + 1, to: i + 1, kind: c.kind });
    }
  });
  return out;
}

// ---------------------------------------------------------------- the four letters
function base(kind: LetterKind): LetterFields {
  return { kind, county: null, year: null, letterDate: null, outcome: null, reference: null, pins: [], problems: [] };
}

function yearOf(m: RegExpMatchArray | null): number | null {
  if (!m) return null;
  const y = Number(fixDigits(m[1]));
  return y >= 1990 && y <= 2100 ? y : null;
}

function parseAssessor(t: string, counties: string[]): LetterFields {
  const f = base("assessor");
  f.county = countyIn(t, counties);
  f.letterDate = findDate(t);
  f.year = yearOf(t.match(/\b([0-9O]{4})\s+Assessment\s+Appeal/i));
  const tw = t.match(/Township:\s*(?:\d+\s+)?([A-Z][A-Z .'-]*[A-Z])/);
  f.township = tw ? tw[1].trim() : null;
  const ap = t.match(/Appeal\s+Number:?\s*([0-9OIl]{5,12})\b/i);
  f.reference = ap ? fixDigits(ap[1]) : null;
  if (/should\s+be\s+reduced|be\s+reduced\s+for/i.test(t)) f.outcome = "reduced";
  else if (/remain\s+as\s+originally\s+proposed|no\s+change/i.test(t)) f.outcome = "no_change";
  else if (/should\s+be\s+increased/i.test(t)) f.outcome = "increased";
  const all = lines(t);
  const head = all.findIndex((l) => /Property\s+Index\s+Number\s*\(PIN\)/i.test(l));
  for (const l of head >= 0 ? all.slice(head + 1) : all) {
    const amts = amountsIn(l, 3);
    if (amts.length < 3) continue;
    const pins = findPins(l);
    const cls = l.replace(PIN_RE, " ").match(/(?:^|\s)(\d-?\d{2})(?=\s)/);
    const [prior, proposed, current] = amts.slice(-3);
    f.pins.push({ pin: pins[0] ?? null, priorAv: prior, origAv: proposed, land: null, impr: null, av: current, className: cls ? cls[1] : null });
  }
  if (!f.pins.length) f.problems.push("Couldn't read the table of PINs and values.");
  return f;
}

function parseBor(t: string, counties: string[]): LetterFields {
  const f = base("bor");
  f.county = countyIn(t.replace(/COUNTY\s*\n\s*BOARD/i, "COUNTY BOARD"), counties);
  f.letterDate = findDate(t);
  f.year = yearOf(t.match(/\b([0-9O]{4})\s+Assessed\s+Valuations/i)) ?? yearOf(t.match(/dissatisfied\s+with\s+your\s+(\d{4})/i));
  if (/directed\s+the\s+Assessor\s+to\s+reduce|reduce\s+the\s+assessed\s+value/i.test(t)) f.outcome = "reduced";
  else if (/not\s+warranted|no\s+change/i.test(t)) f.outcome = "no_change";
  else if (/increase\s+the\s+assessed\s+value/i.test(t)) f.outcome = "increased";
  const all = lines(t);
  const head = all.findIndex((l) => /Assessed\s+Valuations/i.test(l));
  for (const l of head >= 0 ? all.slice(head + 1) : all) {
    if (/dissatisfied|you\s+may|^\d\.\s/i.test(l)) break;
    const complaint = l.match(/\b(\d{6,8}\s?-\s?\d{3}|\d{4}-\d{4,6})\b/);
    const rest = l.replace(PIN_RE, " ").replace(/\b(\d{6,8}\s?-\s?\d{3}|\d{4}-\d{4,6})\b/, " ").replace(/^\s*\d{2}\s?-/, " ").replace(/\b\d{9,}\b/g, " ");
    const amts = amountsIn(rest, 2);
    if (amts.length < 2) continue;
    const pins = findPins(l);
    const [orig, final, change] = amts;
    f.pins.push({ pin: pins[0] ?? null, origAv: orig, land: null, impr: null, av: final, change: change ?? null, complaintNo: complaint ? complaint[1].replace(/\s/g, "") : null });
  }
  f.reference = f.pins.find((p) => p.complaintNo)?.complaintNo ?? null;
  if (!f.pins.length) f.problems.push("Couldn't read the table of PINs and values.");
  return f;
}

function parsePtab(t: string, counties: string[]): LetterFields {
  const f = base("ptab");
  const d = t.match(/DOCKET\s*N[O0]\.?\s*:?\s*([0-9OIl]{4})\s*-\s*([0-9OIl]{5,6})\s*\.\s*([0-9OIl]{3})\s*-\s*([A-Z])\s*-\s*([0-9Il])/i);
  if (d) {
    f.reference = `${fixDigits(d[1])}-${fixDigits(d[2])}.${fixDigits(d[3])}-${d[4].toUpperCase()}-${fixDigits(d[5])}`;
    f.year = Number(fixDigits(d[1]));
  }
  const cm = t.match(/subject\s+matter\s+of\s+this\s+([A-Za-z]+(?:\s[A-Za-z]+)?)\s+County\s+appeal/i) ?? t.match(/the\s+([A-Za-z]+(?:\s?[A-Z][a-z]+)?)\s+County\s+Board\s+of\s+Review/i);
  f.county = cm ? countyIn(`${cm[1]} County`, counties) : countyIn(t, counties);
  if (/agreement\s+of\s+the\s+parties/i.test(t)) f.outcome = "agreed";
  else if (/finds\s+(?:\S{1,3}\s+)?Reduction/i.test(t)) f.outcome = "reduced";
  else if (/finds\s+(?:\S{1,3}\s+)?No\s+Change/i.test(t)) f.outcome = "no_change";
  else if (/finds\s+(?:\S{1,3}\s+)?Increase/i.test(t)) f.outcome = "increased";
  const amt = (label: RegExp) => { const m = t.match(label); return m ? parseAmount(m[1]) : null; };
  const land = amt(/LAND\s*:?\s*\$?\s*([0-9OIl.,]+)/i);
  const impr = amt(/IMPR(?:OVEMENT)?S?\.?\s*:?\s*\$?\s*([0-9OIl.,]+)/i);
  const total = amt(/TOTAL\s*:?\s*\$?\s*([0-9OIl.,]+)/i);
  const parcelLine = t.match(/PARCEL\s+N[O0]S?\.?\s*:?\s*([^\n]*)/i);
  const pins = findPins(parcelLine ? parcelLine[1] : "");
  const pinList = pins.length ? pins : findPins(t);
  if (pinList.length <= 1) {
    f.pins.push({ pin: pinList[0] ?? null, origAv: null, land, impr, av: total });
  } else {
    // Several PINs under one decided total: the total is divided among them the firm's way when applied.
    for (const p of pinList) f.pins.push({ pin: p, origAv: null, land: null, impr: null, av: null });
    f.problems.push(`The decision covers ${pinList.length} PINs with one total. Check how it divides before applying.`);
    f.total = { land, impr, av: total };
  }
  f.letterDate = findDate(t);
  if (!total) f.problems.push("Couldn't read the total assessed value.");
  if (!f.reference) f.problems.push("No docket number on the letter.");
  return f;
}

function parseCircuit(t: string, counties: string[]): LetterFields {
  const f = base("circuit");
  const cc = t.match(/CIRCUIT\s+COURT\s+OF\s+([A-Za-z]+(?:\s[A-Za-z]+)?)\s+COUNTY/i);
  f.county = cc ? countyIn(`${cc[1]} County`, counties) : countyIn(t, counties);
  const on = t.match(/Objection\s+N[O0]\.?\s*:?\s*([0-9OIl][0-9OIl-]{4,})/i);
  f.reference = on ? fixDigits(on[1]) : null;
  f.year = yearOf(t.match(/The\s+([0-9O]{4})\s+assessed\s+valuation/i)) ?? yearOf(t.match(/Objection\s+N[O0][^\n]*\((\d{4})\)/i)) ?? yearOf(t.match(/\((\d{4})\)/));
  const orig = t.match(/assessed\s+valuation\s+of\s+\$?\s*([0-9OIl.,]+)\s*,?\s*before\s+equalization,?\s+is\s+excessive/i);
  const correct = t.match(/correct\s+\d{4}\s+assessed\s+valuation,?\s+before\s+equalization,?\s+is\s+\$?\s*([0-9OIl.,]+?)\.?(?:\s|$)/i);
  const excess = t.match(/excess\s+assessed\s+valuation\s+in\s+the\s+amount\s+of\s+\$?\s*([0-9OIl.,]+)/i);
  const refund = t.match(/refund\s+to\s+the\s+Plaintiff\s+the\s+sum\s+of\s+\$?\s*([0-9OIl.,]+?)\s*,?\s+plus/i) ?? t.match(/excess\s+payment\s+of\s+taxes\s+in\s+the\s+amount\s+of\s+\$?\s*([0-9OIl.,]+?)\.?(?:\s|$)/i);
  const eq = t.match(/equalization\s+factor\s+of\s*_?\s*([0-9.]+)/i);
  const rate = t.match(/tax\s+rate\s+of\s*_?\s*([0-9.]+)\s*%/i);
  const pins = findPins(t);
  f.excessAv = excess ? parseAmount(excess[1]) : null;
  f.refund = refund ? parseAmount(refund[1]) : null;
  f.equalizer = eq ? eq[1].replace(/\.$/, "") : null;
  f.taxRatePercent = rate ? rate[1].replace(/\.$/, "") : null;
  const origAv = orig ? parseAmount(orig[1]) : null;
  const av = correct ? parseAmount(correct[1]) : null;
  f.pins.push({ pin: pins[0] ?? null, origAv, land: null, impr: null, av });
  if (origAv && av) f.outcome = BigInt(origAv.replace(".", "")) > BigInt(av.replace(".", "")) ? "reduced" : "no_change";
  const ent = t.match(/ENTERED\s*:?\s*([^\n]+)/i);
  f.letterDate = ent ? findDate(ent[1]) : null;
  if (!origAv || !av) f.problems.push("Couldn't read the assessed values in the order.");
  if (!f.refund) f.problems.push("Couldn't read the refund amount.");
  return f;
}

/** Reads one letter's text. The kind comes from its pages unless a reviewer set it. */
export function parseLetter(text: string, kind?: LetterKind, counties: string[] = COUNTIES): LetterFields {
  const t = tidy(text);
  const k = kind && kind !== "unknown" ? kind : classifyPage(t).kind;
  switch (k) {
    case "assessor": return parseAssessor(t, counties);
    case "bor": return parseBor(t, counties);
    case "ptab": return parsePtab(t, counties);
    case "circuit": return parseCircuit(t, counties);
    default: {
      const f = base("unknown");
      f.problems.push("Couldn't tell what kind of letter this is.");
      return f;
    }
  }
}
