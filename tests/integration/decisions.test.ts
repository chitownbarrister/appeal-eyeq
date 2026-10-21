// Delivery 8: decision letters. Scans read by OCR (and e-filed PDFs from their text),
// a stack split into letters, each letter matched and cross-checked against the
// matter, the review queue, corrections, "Apply all that matched cleanly", Undo,
// Start BOR, multi-PIN letters against a locked stipulation, PTAB docket rules and
// pending PTAB scrutiny, Circuit Court refunds, filing in Dropbox as a Decision
// Letter, and cross-firm and support-access lockouts. Real server, Postgres and OCR,
// stand-in Dropbox.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { letters, scannedJpeg, scannedPdf, textPdf } from "./letters";
import { startFakeDropbox, FAKE_APP_KEY, FAKE_APP_SECRET, type FakeDropbox } from "../fake-dropbox/server";

let env: TestEnv;
let fake: FakeDropbox;
let dillon = "";
let julie = "";
let olivia = "";
const prop: Record<string, number> = {};

type Letter = { id: number; status: string; kind: string; checks: { key: string; level: string; text: string }[]; appeal: { id: number; level: string; year: number; status: string } | null; property: { id: number } | null; [k: string]: unknown };

async function idle(): Promise<void> {
  const { decisionQueueIdle } = await import("../../server/decisions/queue");
  await decisionQueueIdle();
}

async function upload(cookie: string, body: Buffer, name: string, propertyId?: number) {
  const q = new URLSearchParams({ name, ...(propertyId ? { propertyId: String(propertyId) } : {}) });
  const res = await fetch(`${env.base}/api/firm/decisions/upload?${q}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream" }, body });
  const json = await res.json();
  await idle();
  return { status: res.status, body: json };
}

/** Uploads a file and returns the letters read from it. */
async function read(cookie: string, body: Buffer, name: string, propertyId?: number): Promise<Letter[]> {
  const up = await upload(cookie, body, name, propertyId);
  expect(up.status).toBe(201);
  const all: Letter[] = [];
  for (const view of ["review", "clean"]) all.push(...(await call(env.base, cookie, "GET", `/api/firm/decisions?view=${view}`)).body.letters);
  return all.filter((l) => l.uploadId === up.body.upload.id).sort((a, b) => a.id - b.id);
}

const detail = async (id: number, cookie = dillon) => (await call(env.base, cookie, "GET", `/api/firm/decisions/letters/${id}`)).body as Letter & { fields: Record<string, unknown> };
const appealOf = async (propertyId: number, year: number, level: string) =>
  (await call(env.base, dillon, "GET", `/api/firm/properties/${propertyId}`)).body.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === year && a.level === level);
const levels = (l: Letter) => Object.fromEntries(l.checks.map((c) => [c.key, c.level]));
const texts = (l: Letter) => l.checks.map((c) => c.text).join(" | ");

async function sys<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const { withContext } = await import("../../server/db");
  return withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, fn);
}

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  for (const p of (await call(env.base, dillon, "GET", "/api/firm/properties?status=all")).body.properties) prop[p.address1] = p.id;
}, 120000);

afterAll(async () => {
  for (const k of ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "TOKEN_ENCRYPTION_KEY", "DROPBOX_API_URL", "DROPBOX_CONTENT_URL", "DROPBOX_AUTHORIZE_URL", "DROPBOX_WEB_URL"]) delete process.env[k];
  await fake?.close();
  await stopTestEnv(env);
});

let towerLetter = 0;
let clintonLetter = 0;

describe("reading a scanned stack", () => {
  it("OCRs a scanned PDF, splits it into a BOR letter and a two-page Assessor letter, and matches both cleanly", async () => {
    const pdf = await scannedPdf([
      letters.bor({ pin: "05-17-302-010-0000", complaint: "2634518-001", year: 2026, date: "10/02/2026", orig: "70,000", final: "63,000" }),
      ...letters.assessor({ year: 2026, date: "09/14/2026", township: "76 SOUTH CHICAGO", appealNo: "2771901", rows: [{ pin: "17-16-104-008-0000", cls: "591", prior: "1,100,000", proposed: "1,150,000", current: "1,150,000" }] }),
    ]);
    const got = await read(dillon, pdf, "scan 2026-10-05.pdf");
    expect(got.map((l) => [l.kind, l.pages, l.status, l.textSource])).toEqual([["bor", "1", "clean", "ocr"], ["assessor", "2–3", "clean", "ocr"]]);
    const [bor, assr] = got;
    expect(bor.property!.id).toBe(prop["1044 Tower Road"]);
    expect(bor).toMatchObject({ year: 2026, letterDate: "2026-10-02", outcome: "reduced", reference: "2634518-001", achieved: "97.2%" });
    expect(bor.appeal).toMatchObject({ level: "bor", year: 2026, status: "waiting_decision" });
    expect(levels(bor)).toMatchObject({ original: "ok", reference: "note", requested: "note" });
    expect(texts(bor)).toContain("97.2% of the requested reduction (asked $62,800, decided $63,000)");
    expect(assr.property!.id).toBe(prop["820 S. Clinton St."]);
    expect(assr).toMatchObject({ outcome: "no_change", reference: "2771901" });
    towerLetter = bor.id;
    clintonLetter = assr.id;
  }, 120000);

  it("reads a phone photo (JPEG) too", async () => {
    const jpg = scannedJpeg(letters.bor({ pin: "11-19-207-011-0000", complaint: "2601234-001", year: 2026, date: "09/21/2026", orig: "1,240,000", final: "1,240,000" }));
    const [l] = await read(dillon, jpg, "IMG_2231.jpg");
    expect(l).toMatchObject({ kind: "bor", outcome: "no_change", textSource: "ocr" });
    expect(l.property!.id).toBe(prop["1300 Sheridan Rd."]);
    // 1300 Sheridan's 2026 BOR is already in Decision analysis; the letter itself is clean.
    expect(l.status).toBe("clean");
    await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${l.id}/dismiss`, { reason: "Test photo" });
  }, 120000);

  it("refuses files that aren't PDF, JPG or PNG, whatever they're named", async () => {
    const res = await fetch(`${env.base}/api/firm/decisions/upload?name=letter.pdf`, { method: "POST", headers: { Cookie: dillon, "Content-Type": "application/octet-stream" }, body: "just some text" });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe("Upload decision letters as PDF, JPG or PNG files.");
  });

  it("serves the letter's own pages as a PDF for the preview", async () => {
    const res = await fetch(`${env.base}/api/firm/decisions/letters/${clintonLetter}/file`, { headers: { Cookie: dillon } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(Buffer.from(await res.arrayBuffer()))).getPageCount()).toBe(2);
  });
});

describe("applying", () => {
  it("applies all that matched cleanly: values, date, complaint number, result and substage; Dropbox not connected is recorded", async () => {
    const r = await call(env.base, dillon, "POST", "/api/firm/decisions/apply-clean", {});
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(2);
    expect(r.body.startBor).toEqual([clintonLetter]);
    expect(r.body.results.map((x: { fileError: string }) => x.fileError)).toEqual([
      "Not filed in Dropbox yet: Dropbox isn't connected. A firm admin can connect it in Settings, Integrations.",
      "Not filed in Dropbox yet: Dropbox isn't connected. A firm admin can connect it in Settings, Integrations.",
    ]);
    const bor = await appealOf(prop["1044 Tower Road"], 2026, "bor");
    expect(bor).toMatchObject({ status: "reduced", substage: "decision_analysis", resolved_av: "63000.00", decision_on: "2026-10-02", petition_no: "2634518-001" });
    const assr = await appealOf(prop["820 S. Clinton St."], 2026, "assessor");
    expect(assr).toMatchObject({ status: "no_change", resolved_av: "1150000.00", decision_on: "2026-09-14", external_id: "2771901" });
    const l = await detail(clintonLetter);
    expect(l).toMatchObject({ status: "applied", nextStep: "start_bor", canUndo: true });
  });

  it("starts the Board of Review appeal in one click after no change at the Assessor, once", async () => {
    const r = await call(env.base, dillon, "POST", "/api/firm/decisions/start-bor", { letterIds: [clintonLetter] });
    expect(r.body.started).toMatchObject([{ letterId: clintonLetter, created: true }]);
    const bor = await appealOf(prop["820 S. Clinton St."], 2026, "bor");
    expect(bor).toMatchObject({ orig_av: "1150000.00", status: "open", substage: "under_review" });
    expect((await appealOf(prop["820 S. Clinton St."], 2026, "assessor")).substage).toBe("pushed_next_level");
    const again = await call(env.base, dillon, "POST", "/api/firm/decisions/start-bor", { letterIds: [clintonLetter] });
    expect(again.body.started).toMatchObject([{ created: false, appealId: bor.id }]);
    expect((await call(env.base, dillon, "POST", "/api/firm/decisions/start-bor", { letterIds: [towerLetter] })).body.skipped[0].reason).toBe("Only an Assessor decision goes on to the Board of Review this way.");
  });

  it("undoes a letter, putting the appeal back exactly, and applies it again", async () => {
    const u = await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${towerLetter}/undo`, {});
    expect(u.status).toBe(200);
    expect(u.body.letter.status).toBe("clean");
    expect(await appealOf(prop["1044 Tower Road"], 2026, "bor")).toMatchObject({ status: "waiting_decision", substage: "appeal_filed", resolved_av: null, petition_no: null, decision_on: null });
    const a = await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${towerLetter}/apply`, {});
    expect(a.body.result).toMatchObject({ status: "reduced", allDecided: true, nextStep: "invoice" });
  });

  it("treats a second copy of an applied letter as a duplicate, and a misread PIN gets a suggestion", async () => {
    const pdf = await textPdf([letters.bor({ pin: "05-17-302-011-0000", complaint: "2634518-001", year: 2026, date: "10/02/2026", orig: "70,000", final: "63,000" })]);
    const [l] = await read(dillon, pdf, "copy.pdf");
    expect(l).toMatchObject({ status: "review", textSource: "text" });
    expect(levels(l).pin).toBe("block");
    expect(texts(l)).toContain("PIN 05-17-302-011-0000 isn't on any of your properties. The closest is 05-17-302-010-0000");
    const d = await detail(l.id);
    const fields = { ...d.fields, pins: [{ ...(d.fields.pins as object[])[0], pin: "05-17-302-010-0000" }] };
    const fixed = await call(env.base, dillon, "PUT", `/api/firm/decisions/letters/${l.id}`, { fields });
    expect(fixed.body.corrected).toBe(true);
    expect(levels(fixed.body).duplicate).toBe("block");
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${l.id}/apply`, { acknowledged: true })).status).toBe(409);
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${l.id}/dismiss`, { reason: "Second copy" })).body.letter.status).toBe("dismissed");
  });
});

describe("PTAB letters and pending PTABs", () => {
  let borLetter = 0;
  it("a 2026 BOR letter is held for review while the 2025 PTAB is pending in the same cycle", async () => {
    const pdf = await textPdf([letters.bor({ pin: "08-27-401-031-0000", complaint: "2655555-001", year: 2026, date: "10/09/2026", orig: "3,875,000", final: "3,600,000" })]);
    const [l] = await read(dillon, pdf, "busse bor.pdf");
    expect(l.status).toBe("review");
    expect(levels(l)["pending-ptab"]).toBe("review");
    expect(texts(l)).toContain("A 2025 PTAB appeal is still pending in this reassessment cycle. When it's decided, its value carries into 2026.");
    borLetter = l.id;
    expect((await call(env.base, dillon, "POST", "/api/firm/decisions/apply-clean", {})).body.applied).toBe(0);
  });

  it("a PTAB letter with no docket number goes to review; with the docket entered it matches, and the year comes from the docket", async () => {
    const pdf = await textPdf([letters.ptab({ docket: null, pin: "08-27-401-031-0000", county: "Cook", outcome: "reduction", land: "450,000", impr: "3,050,000", total: "3,500,000" })]);
    const [l] = await read(dillon, pdf, "busse ptab.pdf");
    expect(l.status).toBe("review");
    expect(texts(l)).toContain("No docket number on the letter.");
    expect(levels(l).year).toBe("block");
    const d = await detail(l.id);
    const fixed = (await call(env.base, dillon, "PUT", `/api/firm/decisions/letters/${l.id}`, { fields: { ...d.fields, reference: "2025-034567.001-I-3", year: 2025 } })).body;
    expect(fixed.status).toBe("clean");
    expect(fixed.appeal).toMatchObject({ level: "ptab", year: 2025 });
    expect(texts(fixed)).toContain("Docket 2025-034567.001-I-3 will be saved to the appeal.");
    const a = await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${l.id}/apply`, {});
    expect(a.body.result).toMatchObject({ status: "reduced", nextStep: "awaiting_refund" });
    const ptab = await appealOf(prop["1700 Busse Rd."], 2025, "ptab");
    expect(ptab).toMatchObject({ resolved_av: "3500000.00", petition_no: "2025-034567.001-I-3", refund_status: "awaiting" });
    // With the PTAB decided, the 2026 BOR letter has nothing pending against it.
    expect(levels(await detail(borLetter))["pending-ptab"]).toBeUndefined();
  });

  it("matches a PTAB letter by its docket when the PIN can't be read", async () => {
    await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${(await call(env.base, dillon, "GET", "/api/firm/decisions?view=applied")).body.letters.find((x: Letter) => x.kind === "ptab").id}/undo`, {});
    // Undo took the docket back off the appeal; staff record it once it's known.
    const ptab = await appealOf(prop["1700 Busse Rd."], 2025, "ptab");
    expect(ptab.petition_no).toBeNull();
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${ptab.id}`, { petitionNo: "2025-034567.001-I-3" });
    const pdf = await textPdf([letters.ptab({ docket: "2025-034567.001-I-3", pin: "", county: "Cook", outcome: "reduction", land: "450,000", impr: "3,050,000", total: "3,500,000" })]);
    const [l] = await read(dillon, pdf, "busse ptab again.pdf");
    expect(texts(l)).toContain("Matched by docket number 2025-034567.001-I-3.");
    expect(texts(l)).toContain("Docket 2025-034567.001-I-3 matches the appeal.");
    expect(l.appeal).toMatchObject({ level: "ptab", year: 2025 });
  });
});

describe("several PINs, one letter per PIN, against a locked stipulation", () => {
  let grandBor = 0;
  const parcel: Record<string, number> = {};
  it("locks a stipulation of 380,000 divided the firm's way", async () => {
    const d = (await call(env.base, dillon, "GET", `/api/firm/properties/${prop["1415 W. Grand Ave."]}`)).body;
    for (const p of d.parcels) parcel[p.pin] = p.id;
    grandBor = d.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2026 && a.level === "bor").id;
    await call(env.base, dillon, "POST", `/api/firm/appeals/${grandBor}/split`, { stage: "resolved", totalAv: "380000" });
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${grandBor}/stipulation`, { lock: true })).status).toBe(200);
  });

  it("each PIN's letter is checked against its locked figure; the appeal is decided when the last PIN's letter is in", async () => {
    const make = (pin: string, orig: string, final: string) => textPdf([letters.bor({ pin, complaint: "2677777-001", year: 2026, date: "10/12/2026", orig, final })]);
    const [a] = await read(dillon, await make("17-08-101-022-0000", "330,000", "304,000"), "grand 022.pdf");
    expect(a.status).toBe("clean");
    expect(texts(a)).toContain("Matches the locked stipulation for 17-08-101-022-0000.");
    expect(texts(a)).toContain("This letter covers 1 of 3 PINs on the appeal. It's decided when the rest arrive.");
    const [b] = await read(dillon, await make("17-08-101-023-0000", "61,875", "57,500"), "grand 023.pdf");
    expect(b.status).toBe("review");
    expect(texts(b)).toContain("Differs from the locked stipulation for 17-08-101-023-0000: the letter says $57,500, the stipulation $57,000.");
    const [c] = await read(dillon, await make("17-08-101-024-0000", "20,625", "19,000"), "grand 024.pdf");
    expect(c.status).toBe("clean");

    // A locked stipulation fills every PIN's resolved value, but the appeal is decided only when a letter is in for each PIN.
    const ra = (await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${a.id}/apply`, {})).body.result;
    expect(ra).toMatchObject({ unlocked: false, allDecided: false, status: "waiting_decision", nextStep: "waiting_rest" });
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${b.id}/apply`, {})).body.error).toBe("This letter has items to review. Check them, then apply.");
    // The tribunal's figure is the official one: applying it unlocks the stipulation.
    const rb = (await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${b.id}/apply`, { acknowledged: true })).body.result;
    expect(rb).toMatchObject({ unlocked: true, allDecided: false });
    const rc = (await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${c.id}/apply`, {})).body.result;
    expect(rc).toMatchObject({ allDecided: true, status: "reduced", nextStep: "invoice" });
    const v = (await call(env.base, dillon, "GET", `/api/firm/appeals/${grandBor}/values`)).body;
    expect(v.pins.map((p: { resolved: { av: string } }) => p.resolved.av)).toEqual(["304000.00", "57500.00", "19000.00"]);
    expect(v.totals.resolved.av).toBe("380500.00");
    expect(v.stipulation).toBeNull();
    // Land is held and the building takes the change (the firm's method).
    expect(v.pins[0].resolved).toEqual({ land: "61875.00", impr: "242125.00", av: "304000.00" });
  });
});

describe("Circuit Court and refunds", () => {
  it("reads an agreed judgment, checks the arithmetic, and marks the refund awaited with the order's figure", async () => {
    const pdf = await textPdf([letters.circuit({ county: "Will", objectionNo: "2024-COTO-001234", year: 2024, orig: "1,680,000", correct: "1,450,000", excess: "230,000", factor: "1.0000", rate: "8.000", refund: "18,400.00", pin: "30-07-15-201-004-0000" })]);
    const [l] = await read(dillon, pdf, "channahon order.pdf");
    expect(l).toMatchObject({ kind: "circuit", status: "clean", year: 2024, refund: "18400.00" });
    expect(texts(l)).toContain("Refund $18,400.00 checks against the excess AV, factor and rate.");
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${l.id}/apply`, {})).body.result.nextStep).toBe("awaiting_refund");
    const refunds = (await call(env.base, dillon, "GET", "/api/firm/decisions/refunds")).body.refunds;
    const ch = refunds.find((r: { propertyId: number }) => r.propertyId === prop["2550 Channahon Rd."]);
    expect(ch).toMatchObject({ status: "awaiting", expected: "18400.00", expectedIsEstimate: false, level: "circuit" });
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/refunds/${ch.appealId}`, { receivedOn: "2026-10-15", amount: "$18,950.12" })).status).toBe(200);
    const after = (await call(env.base, dillon, "GET", "/api/firm/decisions/refunds")).body.refunds.find((r: { appealId: number }) => r.appealId === ch.appealId);
    expect(after).toMatchObject({ status: "received", received: "18950.12", receivedOn: "2026-10-15" });
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/refunds/${ch.appealId}`, { receivedOn: "2099-01-01", amount: "1" })).status).toBe(400);
  });
});

describe("review cases", () => {
  it("a letter uploaded from one property but for another is blocked", async () => {
    const pdf = await textPdf([letters.bor({ pin: "05-17-302-010-0000", complaint: "1-001", year: 2026, date: "10/02/2026", orig: "70,000", final: "63,000" })]);
    const [l] = await read(dillon, pdf, "wrong property.pdf", prop["2200 Pratt Blvd."]);
    expect(texts(l)).toContain("This letter is for a different property than the one it was uploaded from.");
  });

  it("a letter that can't be classified needs its kind; dismiss and restore", async () => {
    const [l] = await read(dillon, await textPdf([["Thank you for your payment. Please keep this notice for your records and contact us with any questions."]]), "notice.pdf");
    expect(l.kind).toBe("unknown");
    expect(levels(l).kind).toBe("block");
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${l.id}/dismiss`, {})).body.letter.status).toBe("dismissed");
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${l.id}/restore`, {})).body.letter.status).toBe("review");
  });

  it("a letter for a year with no appeal says so, and matches once the appeal exists", async () => {
    const [l] = await read(dillon, await textPdf([letters.bor({ pin: "16-07-118-020-0000", complaint: "2500001-001", year: 2025, date: "06/01/2025", orig: "74,261", final: "71,000" })]), "euclid 2025.pdf");
    expect(texts(l)).toContain("There's no 2025 Board of Review appeal on this property. Create it, then check again.");
    expect((await call(env.base, dillon, "POST", `/api/firm/properties/${prop["1027 N. Euclid Ave."]}/appeals`, { assessmentYear: 2025, level: "bor" })).status).toBe(201);
    const again = (await call(env.base, dillon, "GET", "/api/firm/decisions?view=clean")).body.letters.find((x: Letter) => x.id === l.id);
    expect(again.appeal).toMatchObject({ year: 2025, level: "bor" });
  });

  it("deleting the matched appeal sends its letter back to review instead of blocking the delete", async () => {
    const euclid = await appealOf(prop["1027 N. Euclid Ave."], 2025, "bor");
    const l = (await call(env.base, dillon, "GET", "/api/firm/decisions?view=clean")).body.letters.find((x: Letter) => x.appeal?.id === euclid.id);
    expect((await call(env.base, dillon, "DELETE", `/api/firm/appeals/${euclid.id}`)).status).toBe(200);
    expect((await detail(l.id)).status).toBe("review");
  });

  it("an analyst can't apply when the firm turns off Apply decisions for analysts", async () => {
    const [l] = await read(dillon, await textPdf([letters.bor({ pin: "08-22-200-014-0000", complaint: "2600002-001", year: 2026, date: "10/03/2026", orig: "2,210,000", final: "2,050,000" })]), "pratt.pdf");
    await sys((c) => c.query(`UPDATE role_permissions SET allowed = false WHERE firm_id = $1 AND role = 'analyst' AND permission = 'decisions.apply'`, [env.nicholsId]));
    expect((await call(env.base, julie, "POST", `/api/firm/decisions/letters/${l.id}/apply`, {})).status).toBe(403);
    await sys((c) => c.query(`UPDATE role_permissions SET allowed = true WHERE firm_id = $1 AND role = 'analyst' AND permission = 'decisions.apply'`, [env.nicholsId]));
    expect((await call(env.base, julie, "POST", `/api/firm/decisions/letters/${l.id}/apply`, {})).status).toBe(200);
  });
});

describe("filing in Dropbox", () => {
  const TOWER = "/Appeal EyeQ/Nichols, Dillon/05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)";
  it("files an applied letter as a Decision Letter under Appeals / year / level, then lets the stored scan go", async () => {
    fake = await startFakeDropbox();
    Object.assign(process.env, {
      DROPBOX_APP_KEY: FAKE_APP_KEY, DROPBOX_APP_SECRET: FAKE_APP_SECRET, TOKEN_ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough-123",
      DROPBOX_API_URL: fake.url, DROPBOX_CONTENT_URL: fake.url, DROPBOX_AUTHORIZE_URL: `${fake.url}/oauth2/authorize`, DROPBOX_WEB_URL: "https://www.dropbox.test",
    });
    const start = await fetch(`${env.base}/api/firm/integrations/dropbox/connect`, { method: "POST", headers: { Cookie: dillon, "Content-Type": "application/json" }, body: "{}" });
    const stateCookie = (start.headers.get("set-cookie") || "").split(";")[0];
    const approve = await fetch(((await start.json()) as { url: string }).url, { redirect: "manual" });
    await fetch(approve.headers.get("location")!, { redirect: "manual", headers: { Cookie: `${dillon}; ${stateCookie}` } });

    // 820 S. Clinton has no folder yet: filing says how to fix it.
    const noFolder = await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${clintonLetter}/file`, {});
    expect(noFolder.status).toBe(409);
    expect(noFolder.body.error).toBe("Not filed in Dropbox yet: this property has no Dropbox folder. Create it on the property's Files tab, then press File in Dropbox.");

    expect((await call(env.base, dillon, "POST", `/api/firm/properties/${prop["1044 Tower Road"]}/files/ensure`, {})).status).toBeLessThan(300);
    const f = await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${towerLetter}/file`, {});
    expect(f.status).toBe(200);
    expect(f.body.filedPath).toBe(`${TOWER}/Appeals/2026/Board of Review/05-17-302-010 – Decision Letter (2026).pdf`);
    const tree = (await (await fetch(`${fake.url}/__test/tree`)).json()) as Record<string, string[]>;
    expect(Object.values(tree).flat()).toContain(`F ${TOWER}/Appeals/2026/Board of Review/05-17-302-010 – Decision Letter (2026).pdf`);
    const doc = await sys(async (c) => (await c.query(
      `SELECT d.status, d.doc_date, d.assessment_year, d.level, t.name AS type FROM documents d LEFT JOIN document_types t ON t.firm_id = d.firm_id AND t.id = d.doc_type_id WHERE d.firm_id = $1 AND d.id = (SELECT document_id FROM decision_letters WHERE id = $2)`,
      [env.nicholsId, towerLetter],
    )).rows[0]);
    expect(doc).toEqual({ status: "final", doc_date: "2026-10-02", assessment_year: 2026, level: "bor", type: "Decision Letter" });

    // The Clinton letter shares the upload and isn't filed yet, so the scan stays until it is.
    expect((await fetch(`${env.base}/api/firm/decisions/letters/${towerLetter}/file`, { headers: { Cookie: dillon } })).status).toBe(200);
    expect((await call(env.base, dillon, "POST", `/api/firm/properties/${prop["820 S. Clinton St."]}/files/ensure`, {})).status).toBeLessThan(300);
    expect((await call(env.base, dillon, "POST", `/api/firm/decisions/letters/${clintonLetter}/file`, {})).status).toBe(200);
    const gone = await fetch(`${env.base}/api/firm/decisions/letters/${towerLetter}/file`, { headers: { Cookie: dillon } });
    expect(gone.status).toBe(410);
    expect((await gone.json()).error).toBe("The scan is filed in Dropbox now. Open it from the property's Files tab.");
  });
});

describe("isolation", () => {
  it("another firm sees none of Nichols Law's letters and can't reach one by id", async () => {
    const theirs = (await call(env.base, olivia, "GET", "/api/firm/decisions?view=applied")).body;
    expect(theirs.letters).toEqual([]);
    expect(theirs.counts).toMatchObject({ review: 0, clean: 0, applied: 0 });
    expect((await call(env.base, olivia, "GET", `/api/firm/decisions/letters/${towerLetter}`)).status).toBe(404);
    expect((await fetch(`${env.base}/api/firm/decisions/letters/${clintonLetter}/file`, { headers: { Cookie: olivia } })).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/decisions/letters/${towerLetter}/undo`, {})).status).toBe(404);
    expect((await call(env.base, olivia, "PUT", `/api/firm/decisions/letters/${towerLetter}`, { appealId: null })).status).toBe(404);
    expect((await call(env.base, olivia, "GET", "/api/firm/decisions/refunds")).body.refunds).toEqual([]);
    expect((await call(env.base, olivia, "POST", `/api/firm/decisions/refunds/${(await appealOf(prop["2550 Channahon Rd."], 2024, "circuit")).id}`, { receivedOn: "2026-10-01", amount: "1" })).status).toBe(404);
  });

  it("their letter with a Nichols Law PIN finds nothing, and they can't choose a Nichols Law appeal", async () => {
    const pdf = await textPdf([letters.bor({ pin: "05-17-302-010-0000", complaint: "9-001", year: 2026, date: "10/02/2026", orig: "70,000", final: "63,000" })]);
    const up = await upload(olivia, pdf, "theirs.pdf");
    const l = (await call(env.base, olivia, "GET", "/api/firm/decisions?view=review")).body.letters.find((x: Letter) => x.uploadId === up.body.upload.id);
    expect(texts(l)).toContain("PIN 05-17-302-010-0000 isn't on any of your properties.");
    expect(texts(l)).not.toContain("closest is 05-17-302-010");
    const towerBor = (await appealOf(prop["1044 Tower Road"], 2026, "bor")).id;
    expect((await call(env.base, olivia, "PUT", `/api/firm/decisions/letters/${l.id}`, { appealId: towerBor })).status).toBe(404);
  });

  it("support access can't open decision letters, even with a grant", async () => {
    await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 2, reason: "Checking decisions" });
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    const r = await call(env.base, admin, "GET", "/api/firm/decisions");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Decision letters aren't available under support access.");
  });

  it("the audit log never holds the scans themselves", async () => {
    const n = await sys(async (c) => (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE firm_id = $1 AND table_name = 'decision_upload_files'`, [env.nicholsId])).rows[0].n);
    expect(n).toBe(0);
  });
});

describe("display preference", () => {
  it("each person chooses whether values show cents", async () => {
    expect((await call(env.base, julie, "GET", "/api/auth/me")).body.preferences).toEqual({ showValueCents: false });
    expect((await call(env.base, julie, "PUT", "/api/auth/preferences", { showValueCents: true })).status).toBe(200);
    expect((await call(env.base, julie, "GET", "/api/auth/me")).body.preferences).toEqual({ showValueCents: true });
    expect((await call(env.base, dillon, "GET", "/api/auth/me")).body.preferences).toEqual({ showValueCents: false });
  });
});

describe("the sample firm", () => {
  it("resets cleanly with decision letters in it, and the letters go with the rest", async () => {
    expect((await call(env.base, dillon, "POST", "/api/firm/sample/reset", {})).status).toBe(200);
    const q = (await call(env.base, dillon, "GET", "/api/firm/decisions?view=applied")).body;
    expect(q.counts).toEqual({ review: 0, clean: 0, applied: 0, dismissed: 0, awaitingRefund: 0 });
    expect(q.uploads).toEqual([]);
  });
});

