// Decisions: upload decision letters (one, or a scanned stack), see how each was read
// and matched, apply all that matched cleanly, review the rest, and track refunds.

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, errorText } from "../api";
import { useSession } from "../App";
import { formatDate, formatMoney, splitMatterTitle, todayIso } from "../format";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";
import { Sheet } from "../components/Sheet";
import { MoneyInput } from "../components/MoneyInput";
import { KIND_LABELS, LetterSheet, LetterValues, OUTCOME_LABELS, outcomePill, type LetterSummary } from "../components/DecisionLetter";

interface UploadRow { id: number; file_name: string; status: "queued" | "reading" | "done" | "failed"; page_count: number | null; pages_read: number; error: string | null; created_at: string; uploaded_by_name: string | null; letters: number }
interface Queue {
  counts: { review: number; clean: number; applied: number; dismissed: number; awaitingRefund: number };
  uploads: UploadRow[];
  letters: LetterSummary[];
}
interface Refund {
  appealId: number; propertyId: number; year: number; level: Level; levelLabel: string; status: "awaiting" | "received"; expected: string | null;
  expectedIsEstimate: boolean; received: string | null; receivedOn: string | null; decisionOn: string | null; daysWaiting: number | null; client: string; title: string;
}

type View = "review" | "clean" | "applied" | "refunds" | "dismissed";
const VIEWS: { id: View; label: string }[] = [
  { id: "clean", label: "Matched cleanly" }, { id: "review", label: "To review" }, { id: "applied", label: "Applied" },
  { id: "refunds", label: "Awaiting refund" }, { id: "dismissed", label: "Dismissed" },
];
const MAX_BYTES = 40 * 1024 * 1024;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

/** Sends files to be read; returns the upload ids. Shared with the property page. */
export async function uploadDecisionFiles(files: File[], propertyId?: number): Promise<number[]> {
  const ids: number[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) throw new ApiError(413, `${f.name} is over 40 MB. Split the scan into smaller PDFs.`);
    const q = new URLSearchParams({ name: f.name, ...(propertyId ? { propertyId: String(propertyId) } : {}) });
    const res = await fetch(`/api/firm/decisions/upload?${q}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: f });
    const body = (await res.json().catch(() => ({}))) as { error?: string; upload?: { id: number } };
    if (!res.ok) throw new ApiError(res.status, `${f.name}: ${body.error || `Upload failed (${res.status})`}`);
    ids.push(body.upload!.id);
  }
  return ids;
}

function Pins({ l }: { l: LetterSummary }) {
  const pins = l.pins.map((p) => p.pin).filter(Boolean) as string[];
  return <span className="mn">{pins.length ? `PIN ${pins[0]}${pins.length > 1 ? ` and ${pins.length - 1} more` : ""}` : "PIN not read"}</span>;
}

function PropertyCell({ l }: { l: LetterSummary }) {
  if (!l.property) return <><Pins l={l} /><span className="meta" style={{ display: "block" }}>No property matched</span></>;
  const t = splitMatterTitle(l.property.title);
  return (
    <>
      {t.pin && <span className="mn" style={{ display: "block" }}>PIN {t.pin}</span>}
      <Link to={`/properties/${l.property.id}`} onClick={(e) => e.stopPropagation()} className="mt">{t.place}</Link>
    </>
  );
}

export function Decisions() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((v) => v.id === params.get("view")) ? params.get("view") : null) as View | null;
  const [data, setData] = useState<Queue | null>(null);
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState<Refund | null>(null);
  const [startBor, setStartBor] = useState<number[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const shown: View = view ?? (data && data.counts.clean === 0 && data.counts.review > 0 ? "review" : "clean");

  const load = useCallback(async (recheck = true) => {
    try {
      if (shown === "refunds") {
        setRefunds((await api<{ refunds: Refund[] }>("/firm/decisions/refunds")).refunds);
        setData(await api<Queue>(`/firm/decisions?view=review&recheck=0`));
      } else {
        setData(await api<Queue>(`/firm/decisions?view=${shown}${recheck ? "" : "&recheck=0"}`));
      }
      setError("");
    } catch (e) { setError(errorText(e)); }
  }, [shown]);
  useEffect(() => { void load(); }, [load]);

  // While files are being read, check back every couple of seconds.
  const reading = data?.uploads.some((u) => u.status === "queued" || u.status === "reading") ?? false;
  const wasReading = useRef(false);
  useEffect(() => {
    if (!reading) {
      if (wasReading.current) { wasReading.current = false; void load(true); }
      return;
    }
    wasReading.current = true;
    const t = setInterval(() => void load(false), 2000);
    return () => clearInterval(t);
  }, [reading, load]);

  async function act(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(""); setNotice("");
    try { const m = await fn(); if (m) setNotice(m); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }

  const upload = (files: File[]) => act("upload", async () => {
    const ok = files.filter((f) => /\.(pdf|jpe?g|png)$/i.test(f.name) || /^(application\/pdf|image\/(jpeg|png))$/.test(f.type));
    if (ok.length < files.length) throw new ApiError(415, "Upload decision letters as PDF, JPG or PNG files.");
    await uploadDecisionFiles(ok);
    return `${ok.length} file${ok.length === 1 ? "" : "s"} uploaded. Each letter is read and checked against its matter; this takes a few seconds a page.`;
  });
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (can("appeals.edit") && e.dataTransfer.files.length) void upload([...e.dataTransfer.files]);
  };

  const applyClean = () => act("apply", async () => {
    const r = await api<{ applied: number; skipped: { letterId: number; reason: string }[]; startBor: number[]; results: { fileError: string | null }[] }>("/firm/decisions/apply-clean", { method: "POST", body: {} });
    setStartBor(r.startBor);
    const unfiled = r.results.filter((x) => x.fileError).length;
    return [
      `Applied ${r.applied} letter${r.applied === 1 ? "" : "s"}.`,
      r.skipped.length ? `${r.skipped.length} turned up something to review and ${r.skipped.length === 1 ? "was" : "were"} left in To review.` : "",
      unfiled ? `${unfiled} couldn't be filed in Dropbox yet; see Applied.` : "",
    ].filter(Boolean).join(" ");
  });
  const startAllBor = () => act("bor", async () => {
    const r = await api<{ started: { created: boolean }[]; skipped: unknown[] }>("/firm/decisions/start-bor", { method: "POST", body: { letterIds: startBor } });
    setStartBor([]);
    const made = r.started.filter((x) => x.created).length;
    return `Started ${made} Board of Review appeal${made === 1 ? "" : "s"}.`;
  });
  const removeUpload = (u: UploadRow) => act("remove", async () => { await api(`/firm/decisions/uploads/${u.id}`, { method: "DELETE" }); });

  const counts = data?.counts;
  const letters = data?.letters ?? [];
  const tabCount = (v: View) => (counts ? (v === "refunds" ? counts.awaitingRefund : counts[v]) : 0);
  const recent = (data?.uploads ?? []).filter((u) => u.status !== "done");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Decisions</div>
          <h1>Decision letters</h1>
          <p className="subtitle">Upload the letters as they arrive. Each one is read, matched to its appeal and checked against it; clean matches apply together, the rest wait here for a look.</p>
        </div>
      </div>

      {can("appeals.edit") && (
        <div
          className={`card pad dropzone${dragging ? " dragging" : ""}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
          onDrop={onDrop}
        >
          <div>
            <b>Drop scanned decision letters here</b>
            <p className="meta" style={{ margin: "2px 0 0" }}>PDF, JPG or PNG. One PDF can hold a whole stack; each letter in it is found and read on its own.</p>
          </div>
          <span className="sp" />
          <button type="button" className="btn" disabled={busy === "upload"} onClick={() => input.current?.click()}>{busy === "upload" ? "Uploading" : "Choose files"}</button>
          <input ref={input} type="file" multiple hidden accept={ACCEPT} aria-label="Choose decision letters to upload" onChange={(e) => { if (e.target.files?.length) void upload([...e.target.files]); e.target.value = ""; }} />
        </div>
      )}

      {recent.length > 0 && (
        <div className="card uploads" aria-live="polite">
          {recent.map((u) => (
            <div key={u.id} className={`trow up-${u.status}`}>
              <span className="tt">{u.file_name}</span>
              <span className="tm">
                {u.status === "queued" && "Waiting to be read"}
                {u.status === "reading" && (u.page_count ? `Reading page ${Math.min(u.pages_read + 1, u.page_count)} of ${u.page_count}` : "Reading")}
                {u.status === "failed" && <span className="error" style={{ margin: 0 }}>{u.error}</span>}
              </span>
              {u.status === "failed" && can("appeals.edit") && <button type="button" className="btn small ghost" onClick={() => void removeUpload(u)}>Remove</button>}
            </div>
          ))}
        </div>
      )}

      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {startBor.length > 0 && can("appeals.edit") && (
        <div className="notice-box copper" role="status">
          <span>{startBor.length} Assessor letter{startBor.length === 1 ? "" : "s"} came back. No change at the Assessor goes on to the Board of Review.</span>
          <span className="sp" />
          <button type="button" className="btn small copper" disabled={busy === "bor"} onClick={() => void startAllBor()}>Start {startBor.length === 1 ? "the BOR appeal" : `BOR appeals for all ${startBor.length}`}</button>
        </div>
      )}

      <section className="card" style={{ marginTop: 14 }}>
        <div className="subtabs" role="tablist" aria-label="Letters">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={shown === v.id} className={shown === v.id ? "active" : ""} onClick={() => setParams(v.id === "clean" ? {} : { view: v.id })}>
              {v.label}{counts ? ` (${tabCount(v.id)})` : ""}
            </button>
          ))}
        </div>
        <div className="pane">
          {shown === "clean" && (
            <div className="tbar">
              <span className="meta">{letters.length ? `${letters.length} letter${letters.length === 1 ? "" : "s"} passed every check against ${letters.length === 1 ? "its" : "their"} appeal.` : "Nothing waiting. Letters that pass every check show here."}</span>
              <span className="sp" />
              {can("decisions.apply") && letters.length > 0 && <button type="button" className="btn copper" disabled={busy === "apply"} onClick={() => void applyClean()}>{busy === "apply" ? "Applying" : "Apply all that matched cleanly"}</button>}
            </div>
          )}
          {shown === "review" && <p className="meta" style={{ marginTop: 0 }}>Each of these has something a person should look at first. Open one to see the scan beside what was read.</p>}
          {shown === "refunds" ? (
            <Refunds rows={refunds ?? []} canEdit={can("appeals.edit")} onRecord={setRecording} onUndo={(r) => void act("undo-refund", async () => { await api(`/firm/decisions/refunds/${r.appealId}`, { method: "DELETE" }); })} />
          ) : (
            <div className="tw">
              <table className="compact letters">
                <thead>
                  <tr>
                    <th>Letter</th><th>Property</th><th>Appeal</th><th>Result</th><th className="num">Going in → decided</th><th className="num">Of requested</th>
                    <th>{shown === "applied" ? "Filed" : shown === "dismissed" ? "Why" : "Checks"}</th>
                  </tr>
                </thead>
                <tbody>
                  {letters.map((l) => (
                    <tr key={l.id} className="clickable" tabIndex={0} onClick={() => setOpen(l.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(l.id); }}>
                      <td><span className="mt">{KIND_LABELS[l.kind]}</span><span className="mn" style={{ display: "block" }}>{l.letterDate ? formatDate(l.letterDate) : "No date"} · {l.fileName}{l.pages !== "1" ? `, p. ${l.pages}` : ""}</span></td>
                      <td><PropertyCell l={l} /></td>
                      <td>{l.appeal ? <>{l.appeal.year}<span className="mn" style={{ display: "block" }}>{LEVEL_LABELS[l.appeal.level]}</span></> : l.year ? <span className="meta">{l.year}</span> : "—"}</td>
                      <td>{l.outcome ? <span className={`pill ${outcomePill(l.outcome)}`}>{OUTCOME_LABELS[l.outcome]}</span> : "—"}{l.appeal?.refundStatus === "awaiting" && <span className="pill copper" style={{ marginTop: 3 }}>Awaiting refund</span>}</td>
                      <td className="num"><LetterValues l={l} />{l.refund && <span className="mn" style={{ display: "block" }}>Refund {formatMoney(l.refund)}</span>}</td>
                      <td className="num">{l.achieved ?? "—"}</td>
                      <td className="why">
                        {shown === "applied" ? (l.filedPath ? <span className="pill ok">In Dropbox</span> : <span className="warn-text">{l.fileError ? "Not filed yet" : "Filing"}</span>)
                          : shown === "dismissed" ? <span className="meta">{l.dismissedReason ?? "No reason given"}</span>
                          : l.headline && (l.headline.level === "review" || l.headline.level === "block") ? <span className={`ck-inline ${l.headline.level}`}>{l.headline.text}</span>
                          : <span className="ck-inline ok">Every check passed{l.checks.some((c) => c.level === "note") ? <span className="meta"> · {l.checks.filter((c) => c.level === "note").length} to note</span> : null}</span>}
                        {shown === "applied" && l.nextStep === "start_bor" && l.appeal?.status === "no_change" && <span className="mn" style={{ display: "block" }}>Next: Board of Review</span>}
                      </td>
                    </tr>
                  ))}
                  {letters.length === 0 && <tr><td colSpan={7} className="meta" style={{ textAlign: "center", padding: 20 }}>{shown === "applied" ? "No letters applied yet." : shown === "dismissed" ? "Nothing dismissed." : shown === "review" ? "Nothing to review." : "Nothing here yet."}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {open !== null && <LetterSheet letterId={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {recording && <RecordRefund refund={recording} onClose={() => setRecording(null)} onSaved={() => { setRecording(null); void act("refund", async () => "Refund recorded."); }} />}
    </>
  );
}

function Refunds({ rows, canEdit, onRecord, onUndo }: { rows: Refund[]; canEdit: boolean; onRecord: (r: Refund) => void; onUndo: (r: Refund) => void }) {
  const waiting = rows.filter((r) => r.status === "awaiting");
  const received = rows.filter((r) => r.status === "received");
  const row = (r: Refund) => {
    const t = splitMatterTitle(r.title);
    return (
      <tr key={r.appealId}>
        <td>{t.pin && <span className="mn" style={{ display: "block" }}>PIN {t.pin}</span>}<Link to={`/properties/${r.propertyId}?appeal=${r.appealId}`} className="mt">{t.place}</Link><span className="mn" style={{ display: "block" }}>{r.client}</span></td>
        <td>{r.year}<span className="mn" style={{ display: "block" }}>{r.levelLabel}</span></td>
        <td>{r.decisionOn ? formatDate(r.decisionOn) : "—"}</td>
        <td className="num">{r.expected ? formatMoney(r.expected) : "—"}{r.expectedIsEstimate && r.expected && <span className="mn" style={{ display: "block" }}>estimate from the tax saved</span>}</td>
        {r.status === "awaiting"
          ? <><td className="num">{r.daysWaiting ?? "—"}</td><td className="num">{canEdit && <button type="button" className="btn small" onClick={() => onRecord(r)}>Record refund</button>}</td></>
          : <><td className="num">{formatMoney(r.received)}<span className="mn" style={{ display: "block" }}>{r.receivedOn ? formatDate(r.receivedOn) : ""}</span></td><td className="num">{canEdit && <button type="button" className="btn small ghost" onClick={() => onUndo(r)}>Undo</button>}</td></>}
      </tr>
    );
  };
  return (
    <>
      <p className="meta" style={{ marginTop: 0 }}>PTAB and Circuit Court reductions are paid as a refund check. The fee is a share of the whole refund, interest included, so record what the check says.</p>
      <div className="tw">
        <table className="compact">
          <thead><tr><th>Property</th><th>Appeal</th><th>Decided</th><th className="num">Expected</th><th className="num">Days waiting</th><th /></tr></thead>
          <tbody>
            {waiting.map(row)}
            {waiting.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 20 }}>No refunds outstanding.</td></tr>}
          </tbody>
        </table>
      </div>
      {received.length > 0 && (
        <>
          <h3 className="subhead">Received</h3>
          <div className="tw">
            <table className="compact">
              <thead><tr><th>Property</th><th>Appeal</th><th>Decided</th><th className="num">Expected</th><th className="num">Received</th><th /></tr></thead>
              <tbody>{received.map(row)}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function RecordRefund({ refund, onClose, onSaved }: { refund: Refund; onClose: () => void; onSaved: () => void }) {
  const [on, setOn] = useState(todayIso());
  const [amount, setAmount] = useState<string | null>(refund.expected);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError("");
    try { await api(`/firm/decisions/refunds/${refund.appealId}`, { method: "POST", body: { receivedOn: on, amount: amount ?? "" } }); onSaved(); }
    catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  const t = splitMatterTitle(refund.title);
  return (
    <Sheet eyebrow="Record refund" title={t.place} onClose={onClose} onSubmit={() => void save()}
      footer={<>{error && <span className="error" style={{ margin: 0, flexBasis: "100%" }} role="alert">{error}</span>}<span className="sp" /><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving" : "Record refund"}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>{refund.year} {refund.levelLabel}. Expected {refund.expected ? formatMoney(refund.expected) : "not known"}{refund.expectedIsEstimate ? ", an estimate from the tax saved" : ""}.</p>
      <div className="fgrid">
        <div className="fld"><label htmlFor="rf-on">Check received</label><input id="rf-on" className="in" type="date" max={todayIso()} value={on} onChange={(e) => setOn(e.target.value)} required /></div>
        <div className="fld"><label htmlFor="rf-amt">Amount, refund and interest</label><MoneyInput id="rf-amt" money value={amount} onChange={setAmount} required /></div>
      </div>
      <p className="meta">The fee is figured on the amount received, so include the interest.</p>
    </Sheet>
  );
}
