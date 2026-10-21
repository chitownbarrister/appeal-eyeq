// One decision letter: the scan beside what was read from it, the checks against
// the matter, corrections, the appeal it matched, and Apply / Undo / Dismiss, with
// the next step once it's applied. Used on the Decisions page and the property page.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, errorText } from "../api";
import { useSession } from "../App";
import { formatDate, formatValue, splitMatterTitle } from "../format";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";
import { sumMoney } from "../../../shared/money";
import { MoneyInput } from "./MoneyInput";

export type CheckLevel = "ok" | "note" | "review" | "block";
export interface Check { key: string; level: CheckLevel; text: string }
export type LetterKind = "assessor" | "bor" | "ptab" | "circuit" | "unknown";
export type Outcome = "reduced" | "no_change" | "increased" | "agreed";
export type NextStep = "start_bor" | "bor_judgment" | "invoice" | "awaiting_refund" | "waiting_rest" | null;

export interface LetterSummary {
  id: number; uploadId: number; fileName: string; pages: string; kind: LetterKind; status: "review" | "clean" | "applied" | "dismissed";
  textSource: "text" | "ocr"; confidence: number | null; letterDate: string | null; year: number | null; outcome: Outcome | null;
  reference: string | null; county: string | null; pins: { pin: string | null; origAv: string | null; av: string | null }[]; refund: string | null;
  property: { id: number; title: string; client: string | null } | null;
  appeal: { id: number; year: number; level: Level; status: string; refundStatus: string | null } | null;
  checks: Check[]; headline: Check | null; achieved: string | null; createdAt: string; appliedAt: string | null; appliedBy: string | null;
  filedPath: string | null; fileError: string | null; documentId: number | null; hasFile: boolean; dismissedReason: string | null;
  canUndo: boolean; nextStep: NextStep;
}
interface LetterPinFields { pin: string | null; origAv: string | null; land: string | null; impr: string | null; av: string | null; [k: string]: unknown }
interface LetterFields {
  kind: LetterKind; county: string | null; year: number | null; letterDate: string | null; outcome: Outcome | null; reference: string | null;
  pins: LetterPinFields[]; refund?: string | null; [k: string]: unknown;
}
export interface LetterDetail extends LetterSummary {
  fields: LetterFields; corrected: boolean; rawText: string; appealChosen: boolean;
  appeals: { id: number; year: number; level: Level; status: string }[];
}

export const KIND_LABELS: Record<LetterKind, string> = { assessor: "Assessor", bor: "Board of Review", ptab: "PTAB", circuit: "Circuit Court", unknown: "Not recognized" };
export const OUTCOME_LABELS: Record<Outcome, string> = { reduced: "Reduced", no_change: "No change", increased: "Increased", agreed: "By agreement" };
const REFERENCE_LABELS: Record<LetterKind, string> = { ptab: "Docket number", bor: "Complaint number", assessor: "Appeal number", circuit: "Objection number", unknown: "Reference number" };
const CHECK_LABELS: Record<CheckLevel, string> = { ok: "OK", note: "Note", review: "Review", block: "Can't apply" };
export const outcomePill = (o: Outcome | null | string) => (o === "reduced" || o === "agreed" ? "ok" : o === "increased" ? "crit" : "");

/** A letter's PINs added up (decided or going in), or null when any is missing. */
function total(vals: (string | null)[]): string | null {
  return vals.length && vals.every((v) => v) ? sumMoney(vals as string[]) : null;
}
export const decidedTotal = (l: Pick<LetterSummary, "pins">) => total(l.pins.map((p) => p.av));
export const originalTotal = (l: Pick<LetterSummary, "pins">) => total(l.pins.map((p) => p.origAv));

export function CheckList({ checks }: { checks: Check[] }) {
  if (!checks.length) return <p className="meta">Nothing to check yet.</p>;
  const order: CheckLevel[] = ["block", "review", "note", "ok"];
  return (
    <ul className="checks">
      {[...checks].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map((c, i) => (
        <li key={`${c.key}-${i}`} className={`ck ${c.level}`}><span className="ck-l">{CHECK_LABELS[c.level]}</span><span>{c.text}</span></li>
      ))}
    </ul>
  );
}

/** What happens next once a letter is applied, with the one-click actions. */
export function NextStepBox({ letter, onChanged }: { letter: LetterSummary; onChanged: () => void }) {
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const step = letter.nextStep;
  if (!step || !letter.appeal) return null;
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setErr("");
    try { setMsg(await fn()); onChanged(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const startBor = () => run(async () => {
    const r = await api<{ started: { created: boolean }[]; skipped: { reason: string }[] }>("/firm/decisions/start-bor", { method: "POST", body: { letterIds: [letter.id] } });
    if (r.skipped.length) throw new ApiError(409, r.skipped[0].reason);
    return r.started[0]?.created ? "Board of Review appeal started." : "The Board of Review appeal was already started.";
  });
  const next = (level: Level) => run(async () => {
    const r = await api<{ created: boolean }>(`/firm/appeals/${letter.appeal!.id}/next-level`, { method: "POST", body: { level } });
    return r.created ? `${LEVEL_LABELS[level]} appeal started.` : `The ${LEVEL_LABELS[level]} appeal was already started.`;
  });
  const edit = can("appeals.edit");
  let body: ReactNode = null;
  if (step === "start_bor") body = <>{letter.appeal.status === "no_change" ? "No change at the Assessor, so this goes on to the Board of Review." : "Reduced at the Assessor. The Board of Review is the next chance for more."} {edit && <button type="button" className="btn small copper" disabled={busy} onClick={() => void startBor()}>Start BOR appeal</button>}</>;
  if (step === "bor_judgment") body = <>No change at the Board of Review. Whether to go on to PTAB is a call on the merits. {edit && <><button type="button" className="btn small secondary" disabled={busy} onClick={() => void next("ptab")}>Start PTAB appeal</button> <button type="button" className="btn small ghost" disabled={busy} onClick={() => void next("circuit")}>Circuit Court instead</button></>}</>;
  if (step === "invoice") body = <>Reduced at the Board of Review: ready to bill. A stipulation here doesn't stop a PTAB appeal. {edit && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void next("ptab")}>Start PTAB appeal</button>}</>;
  if (step === "awaiting_refund") body = <>Awaiting the refund check. Record it under Awaiting refund when it arrives.</>;
  if (step === "waiting_rest") body = <>Waiting for the letters for the appeal's other PINs.</>;
  return (
    <div className="notice-box copper next-step" role="status">
      <span>{msg || body}</span>
      {err && <span className="error" role="alert" style={{ flexBasis: "100%", margin: 0 }}>{err}</span>}
    </div>
  );
}

/** The panel for one letter. */
export function LetterSheet({ letterId, onClose, onChanged }: { letterId: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const [d, setD] = useState<LetterDetail | null>(null);
  const [f, setF] = useState<LetterFields | null>(null);
  const [dirty, setDirty] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dismissing, setDismissing] = useState<string | null>(null);

  const take = useCallback((x: LetterDetail) => { setD(x); setF(structuredClone(x.fields)); setDirty(false); setAck(false); }, []);
  const load = useCallback(async () => {
    try { take(await api<LetterDetail>(`/firm/decisions/letters/${letterId}`)); } catch (e) { setError(errorText(e)); }
  }, [letterId, take]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function act(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); if (done) setNotice(done); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  const editable = can("appeals.edit") && d && d.status !== "applied";
  const set = (patch: Partial<LetterFields>) => { setF((x) => ({ ...x!, ...patch })); setDirty(true); };
  const setPin = (i: number, patch: Partial<LetterPinFields>) => { setF((x) => ({ ...x!, pins: x!.pins.map((p, j) => (j === i ? { ...p, ...patch } : p)) })); setDirty(true); };

  const save = () => act("save", async () => take(await api<LetterDetail>(`/firm/decisions/letters/${letterId}`, { method: "PUT", body: { fields: f } })), "Saved. The checks below are run again on what you entered.");
  const choose = (appealId: number | null) => act("choose", async () => take(await api<LetterDetail>(`/firm/decisions/letters/${letterId}`, { method: "PUT", body: { appealId } })));
  const apply = () => act("apply", async () => {
    const r = await api<{ letter: LetterDetail; filed: { fileError: string | null; filedPath: string | null } }>(`/firm/decisions/letters/${letterId}/apply`, { method: "POST", body: { acknowledged: ack } });
    take(r.letter);
    setNotice(r.filed.fileError ? `Applied. ${r.filed.fileError}` : "Applied, and filed in Dropbox as a Decision Letter.");
  });
  const undo = () => act("undo", async () => take((await api<{ letter: LetterDetail }>(`/firm/decisions/letters/${letterId}/undo`, { method: "POST", body: {} })).letter), "Undone. The appeal is back the way it was; a letter already filed in Dropbox stays there.");
  const file = () => act("file", async () => take((await api<{ letter: LetterDetail }>(`/firm/decisions/letters/${letterId}/file`, { method: "POST", body: {} })).letter), "Filed in Dropbox as a Decision Letter.");
  const dismiss = () => act("dismiss", async () => { take((await api<{ letter: LetterDetail }>(`/firm/decisions/letters/${letterId}/dismiss`, { method: "POST", body: { reason: dismissing || null } })).letter); setDismissing(null); }, "Dismissed.");
  const restore = () => act("restore", async () => take((await api<{ letter: LetterDetail }>(`/firm/decisions/letters/${letterId}/restore`, { method: "POST", body: {} })).letter), "Restored to review.");

  const blocked = d?.checks.some((c) => c.level === "block");
  const needsReview = d?.checks.some((c) => c.level === "review");
  const title = d ? `${KIND_LABELS[d.kind]} letter${d.year ? `, ${d.year}` : ""}` : "Decision letter";
  const place = d?.property ? splitMatterTitle(d.property.title) : null;
  const multi = (f?.pins.length ?? 0) > 1;

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <section className="sheet letter-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sh-h">
          <div>
            <div className="eyebrow">Decision letter · {d ? `${d.fileName}, page ${d.pages}` : ""}</div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="btn ghost small x" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {!d ? <div className="sh-b">{error ? <div className="error" role="alert">{error}</div> : <p className="meta">Loading…</p>}</div> : (
          <div className="sh-b letter-body">
            <div className="letter-scan">
              {d.hasFile
                ? <iframe className="pv-frame" src={`/api/firm/decisions/letters/${d.id}/file`} title={`The letter: ${d.fileName}, page ${d.pages}`} />
                : <div className="pv-none">The scan is filed in Dropbox now. {d.property && <Link to={`/properties/${d.property.id}?tab=files`}>Open the property's files</Link>}</div>}
              <p className="meta" style={{ marginTop: 6 }}>
                {d.textSource === "ocr" ? `Read from the scan${d.confidence !== null ? ` (${Math.round(d.confidence)}% confidence)` : ""}.` : "Read from the PDF's text."}
                {d.corrected && " Corrected by hand."}
              </p>
            </div>
            <div className="letter-side">
              <div className="letter-match">
                <span className={`pill ${d.status === "clean" ? "ok" : d.status === "applied" ? "net" : d.status === "review" ? "warn" : "grey"}`}>
                  {d.status === "clean" ? "Matched cleanly" : d.status === "applied" ? "Applied" : d.status === "review" ? "To review" : "Dismissed"}
                </span>
                {place ? (
                  <div>
                    {place.pin && <div className="mn">PIN {place.pin}</div>}
                    <Link to={`/properties/${d.property!.id}${d.appeal ? `?appeal=${d.appeal.id}` : ""}`} className="mt">{place.place}</Link>
                    {d.property!.client && <div className="mn">{d.property!.client}</div>}
                  </div>
                ) : <span className="meta">No property matched yet.</span>}
                {d.appeal && <div className="mn">{d.appeal.year} {LEVEL_LABELS[d.appeal.level]} appeal</div>}
                {d.appliedAt && <div className="mn">Applied {formatDate(d.appliedAt.slice(0, 10))}{d.appliedBy ? ` by ${d.appliedBy}` : ""}</div>}
                {d.dismissedReason && <div className="mn">Dismissed: {d.dismissedReason}</div>}
              </div>

              {notice && <div className="ok" role="status">{notice}</div>}
              {error && <div className="error" role="alert">{error}</div>}
              {d.status === "applied" && <NextStepBox letter={d} onChanged={() => { void load(); onChanged(); }} />}
              {d.status === "applied" && d.fileError && (
                <div className="notice-box" role="status"><span>{d.fileError}</span><span className="sp" />{can("appeals.edit") && <button type="button" className="btn small secondary" disabled={Boolean(busy)} onClick={() => void file()}>File in Dropbox</button>}</div>
              )}
              {d.filedPath && <p className="meta">Filed in Dropbox: <span className="mono">{d.filedPath}</span></p>}

              <h3 className="subhead">Checks</h3>
              <CheckList checks={d.checks} />

              <h3 className="subhead">What the letter says</h3>
              {f && (
                <div className="letter-fields">
                  <div className="pgrid">
                    <div className="fld">
                      <label htmlFor="lf-kind">Kind</label>
                      <select id="lf-kind" className="in" value={f.kind} disabled={!editable} onChange={(e) => set({ kind: e.target.value as LetterKind })}>
                        {(Object.keys(KIND_LABELS) as LetterKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                      </select>
                    </div>
                    <div className="fld">
                      <label htmlFor="lf-outcome">Result</label>
                      <select id="lf-outcome" className="in" value={f.outcome ?? ""} disabled={!editable} onChange={(e) => set({ outcome: (e.target.value || null) as Outcome | null })}>
                        <option value="">Not read</option>
                        {(Object.keys(OUTCOME_LABELS) as Outcome[]).map((k) => <option key={k} value={k}>{OUTCOME_LABELS[k]}</option>)}
                      </select>
                    </div>
                    <div className="fld"><label htmlFor="lf-year">Assessment year</label><input id="lf-year" className="in num" inputMode="numeric" value={f.year ?? ""} disabled={!editable} onChange={(e) => set({ year: e.target.value ? Number(e.target.value.replace(/\D/g, "").slice(0, 4)) : null })} /></div>
                    <div className="fld"><label htmlFor="lf-date">Letter date</label><input id="lf-date" className="in" type="date" value={f.letterDate ?? ""} disabled={!editable} onChange={(e) => set({ letterDate: e.target.value || null })} /></div>
                    <div className="fld"><label htmlFor="lf-ref">{REFERENCE_LABELS[f.kind]}</label><input id="lf-ref" className="in" value={f.reference ?? ""} disabled={!editable} placeholder={f.kind === "ptab" ? "2024-012345.001-R-1" : ""} onChange={(e) => set({ reference: e.target.value || null })} /></div>
                    <div className="fld"><label htmlFor="lf-county">County</label><input id="lf-county" className="in" value={f.county ?? ""} disabled={!editable} onChange={(e) => set({ county: e.target.value || null })} /></div>
                    {f.kind === "circuit" && <div className="fld"><label htmlFor="lf-refund">Refund ordered</label><MoneyInput id="lf-refund" money value={f.refund ?? null} disabled={!editable} onChange={(v) => set({ refund: v })} /></div>}
                  </div>
                  <div className="tw">
                    <table className="compact letter-pins">
                      <thead><tr><th>PIN</th><th className="num">Going in</th>{f.kind === "ptab" && <><th className="num">Land</th><th className="num">Building</th></>}<th className="num">Decided AV</th></tr></thead>
                      <tbody>
                        {f.pins.map((p, i) => (
                          <tr key={i}>
                            <td><input className="in" aria-label={`PIN ${i + 1}`} value={p.pin ?? ""} disabled={!editable} onChange={(e) => setPin(i, { pin: e.target.value || null })} /></td>
                            <td className="num"><MoneyInput aria-label={`Going in, PIN ${i + 1}`} value={p.origAv} disabled={!editable} onChange={(v) => setPin(i, { origAv: v })} /></td>
                            {f.kind === "ptab" && <>
                              <td className="num"><MoneyInput aria-label={`Land, PIN ${i + 1}`} value={p.land} disabled={!editable} onChange={(v) => setPin(i, { land: v })} /></td>
                              <td className="num"><MoneyInput aria-label={`Building, PIN ${i + 1}`} value={p.impr} disabled={!editable} onChange={(v) => setPin(i, { impr: v })} /></td>
                            </>}
                            <td className="num"><MoneyInput aria-label={`Decided AV, PIN ${i + 1}`} value={p.av} disabled={!editable} onChange={(v) => setPin(i, { av: v })} /></td>
                          </tr>
                        ))}
                        {f.pins.length === 0 && <tr><td colSpan={5} className="meta">No PINs read.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  {editable && (
                    <div className="tbar" style={{ marginTop: 8 }}>
                      <button type="button" className="btn small ghost" onClick={() => { setF({ ...f, pins: [...f.pins, { pin: null, origAv: null, land: null, impr: null, av: null }] }); setDirty(true); }}>+ PIN</button>
                      {multi && <button type="button" className="btn small ghost" onClick={() => { setF({ ...f, pins: f.pins.slice(0, -1) }); setDirty(true); }}>Remove last PIN</button>}
                      <span className="sp" />
                      {dirty && <button type="button" className="btn small secondary" onClick={() => { setF(structuredClone(d.fields)); setDirty(false); }}>Discard changes</button>}
                      <button type="button" className="btn small" disabled={!dirty || Boolean(busy)} onClick={() => void save()}>{busy === "save" ? "Saving" : "Save and check again"}</button>
                    </div>
                  )}
                </div>
              )}

              {editable && d.appeals.length > 0 && (
                <div className="fld" style={{ marginTop: 12 }}>
                  <label htmlFor="lf-appeal">Appeal</label>
                  <select id="lf-appeal" className="in" value={d.appealChosen && d.appeal ? d.appeal.id : ""} onChange={(e) => void choose(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Match automatically{d.appeal && !d.appealChosen ? ` (${d.appeal.year} ${LEVEL_LABELS[d.appeal.level]})` : ""}</option>
                    {d.appeals.map((a) => <option key={a.id} value={a.id}>{a.year} {LEVEL_LABELS[a.level]}</option>)}
                  </select>
                </div>
              )}

              <details className="raw-text">
                <summary>Text read from the letter</summary>
                <pre>{d.rawText || "Nothing was read."}</pre>
              </details>
            </div>
          </div>
        )}
        {d && (
          <div className="sh-f">
            {d.status === "dismissed" ? (
              <>{can("appeals.edit") && <button type="button" className="btn secondary" disabled={Boolean(busy)} onClick={() => void restore()}>Restore to review</button>}</>
            ) : d.status === "applied" ? (
              <>
                {d.canUndo && can("decisions.apply") && <button type="button" className="btn secondary" disabled={Boolean(busy)} onClick={() => void undo()}>Undo</button>}
                <span className="sp" />
                {d.property && <Link className="btn" to={`/properties/${d.property.id}${d.appeal ? `?appeal=${d.appeal.id}` : ""}`}>Open the appeal</Link>}
              </>
            ) : (
              <>
                {can("appeals.edit") && (dismissing === null
                  ? <button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={() => setDismissing("")}>Dismiss</button>
                  : <span className="confirm"><input className="in" aria-label="Why dismiss it?" placeholder="Why? (a second copy, not a decision)" value={dismissing} onChange={(e) => setDismissing(e.target.value)} /><button type="button" className="btn small danger" onClick={() => void dismiss()}>Dismiss</button><button type="button" className="btn small secondary" onClick={() => setDismissing(null)}>Keep</button></span>)}
                <span className="sp" />
                {can("decisions.apply") && (blocked ? <span className="meta">Fix the items marked Can't apply first.</span> : dirty ? <span className="meta">Save your changes first.</span> : needsReview ? (
                  <>
                    <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I've checked the flagged items</label>
                    <button type="button" className="btn copper" disabled={!ack || Boolean(busy)} onClick={() => void apply()}>{busy === "apply" ? "Applying" : "Apply after review"}</button>
                  </>
                ) : <button type="button" className="btn copper" disabled={Boolean(busy)} onClick={() => void apply()}>{busy === "apply" ? "Applying" : "Apply"}</button>)}
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}

/** Values in a letter row: going in → decided. */
export function LetterValues({ l }: { l: LetterSummary }) {
  const o = originalTotal(l), dcd = decidedTotal(l);
  return <span className="num">{o ? formatValue(o) : "—"} <span className="meta">→</span> {dcd ? formatValue(dcd) : "—"}</span>;
}
