// An appeal's values by PIN: land, building and AV for original, target and
// resolved, the property total with FMV, the latest offers from each side
// (hidden until asked for), the offer history, dividing an agreed total the
// firm's way, and locking the stipulation. Totals recalculate live as you type,
// with the same exact-decimal rules the server uses.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { cleanNumber, formatDate, formatDateTime, formatValue, nn } from "../format";
import { centsToString, toCents } from "../../../shared/money";
import { fmvFromAv, pinAv, requestedAchieved } from "../../../shared/pins";
import type { Level } from "../../../shared/domain";

type Stage = "original" | "target" | "resolved";
interface V { land: string | null; impr: string | null; av: string | null }
interface Pin { id: number; parcelId: number; pin: string; isPrimary: boolean; onAppeal: boolean; original: V; target: V; resolved: V }
interface Offer { id: number; offered_on: string; party: string; total_av: string; fmv: string | null; pins: { parcelId: number; land: string | null; impr: string | null; av: string }[]; note: string | null; created_by_name: string | null }
export interface ValuesData {
  pinMode: boolean; ratio: string | null; pins: Pin[];
  totals: Record<Stage, V & { fmv: string | null }> & { onAppeal: Record<Stage, string | null> };
  requestedAchieved: string | null; offers: Offer[]; latestOffers: { firm: Offer | null; other: Offer | null };
  targetSource: "manual" | "rollover" | null;
  rollover: { appealId: number; year: number; decisionOn: string | null; cycle: { start: number | null; end: number | null } } | null;
  rolloverSuggestion: { appealId: number; year: number; totalAv: string } | null;
  stipulation: { lockedAt: string; lockedBy: string | null } | null;
}
export interface LiveTotals { original: string | null; target: string | null; resolved: string | null }

const STAGES: [Stage, string][] = [["original", "Original"], ["target", "Target"], ["resolved", "Resolved"]];
const PARTY_LABELS: Record<string, string> = {
  firm: "Firm", assessor: "Assessor", board_of_review: "Board of Review", states_attorney: "State's Attorney", intervenor: "Intervenor", agreed: "Agreed",
};
/** Who sits across the table at each level. */
const OTHER_SIDE: Record<Level, string> = { assessor: "assessor", bor: "board_of_review", ptab: "board_of_review", circuit: "states_attorney" };

const s = (v: string | null | undefined) => (v === null || v === undefined ? "" : String(v).replace(/\.00$/, ""));
const ok = (v: string) => v === "" || /^-?\d{1,12}(\.\d{1,2})?$/.test(cleanNumber(v));
type Draft = Record<number, { onAppeal: boolean } & Record<Stage, { land: string; impr: string; av: string }>>;

function draftFrom(d: ValuesData): Draft {
  const out: Draft = {};
  for (const p of d.pins) {
    out[p.parcelId] = {
      onAppeal: p.onAppeal,
      original: { land: s(p.original.land), impr: s(p.original.impr), av: s(p.original.av) },
      target: { land: s(p.target.land), impr: s(p.target.impr), av: s(p.target.av) },
      resolved: { land: s(p.resolved.land), impr: s(p.resolved.impr), av: s(p.resolved.av) },
    };
  }
  return out;
}

/** A PIN's AV in the draft: land + building when both are filled in, else the AV typed. */
function draftAv(x: { land: string; impr: string; av: string }): string | null {
  const land = cleanNumber(x.land), impr = cleanNumber(x.impr), av = cleanNumber(x.av);
  if (land !== "" && impr !== "" && ok(land) && ok(impr)) return pinAv({ land, impr, av: null });
  return av !== "" && ok(av) ? centsToString(toCents(av)) : null;
}

export function PinValues({ appealId, level, ratio, canEdit, onTotals, register, onChanged }: {
  appealId: number; level: Level; ratio: string | null; canEdit: boolean;
  onTotals: (t: LiveTotals, data: ValuesData) => void;
  register: (save: (() => Promise<void>) | null, valid: boolean) => void;
  onChanged: (msg: string) => void;
}) {
  const [d, setD] = useState<ValuesData | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [showOffers, setShowOffers] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [divide, setDivide] = useState<null | { stage: "target" | "resolved"; basis: "av" | "fmv"; amount: string }>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const r = await api<ValuesData>(`/firm/appeals/${appealId}/values`);
    setD(r);
    setDraft(draftFrom(r));
  }, [appealId]);
  useEffect(() => { void load().catch((err) => setError(errorText(err))); }, [load]);

  // Live totals: a PIN off the appeal keeps its original value at every stage.
  const live = useMemo<LiveTotals>(() => {
    if (!d) return { original: null, target: null, resolved: null };
    const total = (stage: Stage) => {
      const vals = d.pins.map((p) => { const x = draft[p.parcelId]; return x ? draftAv(x.onAppeal ? x[stage] : x.original) : null; });
      if (stage !== "original" && !d.pins.some((p) => draft[p.parcelId]?.onAppeal && draftAv(draft[p.parcelId][stage]) !== null)) return null;
      return vals.every((v) => v !== null) ? centsToString(vals.reduce((a, v) => a + toCents(v!), 0n)) : null;
    };
    return { original: total("original"), target: total("target"), resolved: total("resolved") };
  }, [d, draft]);

  const valid = Object.values(draft).every((x) => STAGES.every(([st]) => ok(x[st].land) && ok(x[st].impr) && ok(x[st].av)));
  const changed = useMemo(() => {
    if (!d) return [];
    const base = draftFrom(d);
    return d.pins.filter((p) => JSON.stringify(base[p.parcelId]) !== JSON.stringify(draft[p.parcelId]));
  }, [d, draft]);

  const save = useCallback(async () => {
    if (!d || !changed.length) return;
    const base = draftFrom(d);
    const pins = changed.map((p) => {
      const x = draft[p.parcelId];
      const b = base[p.parcelId];
      const out: Record<string, unknown> = { parcelId: p.parcelId };
      if (x.onAppeal !== b.onAppeal) out.onAppeal = x.onAppeal;
      for (const [st] of STAGES) {
        if (JSON.stringify(x[st]) === JSON.stringify(b[st])) continue;
        const land = nn(cleanNumber(x[st].land)), impr = nn(cleanNumber(x[st].impr)), av = nn(cleanNumber(x[st].av));
        // Land or building edited: send the split. Only the AV edited: send the AV (the land stays, the building takes the rest).
        out[st] = x[st].land !== b[st].land || x[st].impr !== b[st].impr ? { land, impr, ...(land === null || impr === null ? { av } : {}) } : { av };
      }
      return out;
    });
    const r = await api<ValuesData>(`/firm/appeals/${appealId}/pins`, { method: "PUT", body: { pins } });
    setD(r);
    setDraft(draftFrom(r));
  }, [appealId, changed, d, draft]);

  useEffect(() => { if (d) onTotals(live, d); }, [live, d, onTotals]);
  useEffect(() => { register(changed.length ? save : null, valid); }, [register, save, changed.length, valid]);

  async function act(fn: () => Promise<ValuesData>, msg: string) {
    setError("");
    try {
      const r = await fn();
      setD(r);
      setDraft(draftFrom(r));
      onChanged(msg);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  }

  if (error && !d) return <div className="error" role="alert">{error}</div>;
  if (!d) return <p className="meta">Loading values…</p>;

  const multi = d.pins.length > 1;
  const locked = Boolean(d.stipulation);
  const offerCols = showOffers ? [d.latestOffers.firm, d.latestOffers.other] : [];
  const setCell = (parcelId: number, st: Stage, part: "land" | "impr" | "av", v: string) =>
    setDraft({ ...draft, [parcelId]: { ...draft[parcelId], [st]: { ...draft[parcelId][st], [part]: v } } });
  const offerFor = (o: Offer | null, parcelId: number) => o?.pins.find((x) => x.parcelId === parcelId) ?? null;
  const editable = (st: Stage, x: { onAppeal: boolean }) => canEdit && (st === "original" || x.onAppeal) && !(st === "resolved" && locked);
  const achieved = requestedAchieved(live.original, live.target, live.resolved);

  const cell = (p: Pin, st: Stage, part: "land" | "impr" | "av") => {
    const x = draft[p.parcelId];
    const src = x.onAppeal || st === "original" ? x[st] : x.original;
    if (part === "av") {
      const sum = draftAv(src);
      const hasSplit = cleanNumber(src.land) !== "" && cleanNumber(src.impr) !== "";
      if (hasSplit || !editable(st, x)) return <b className="num">{formatValue(sum)}</b>;
    }
    if (!editable(st, x)) return <span className="num meta">{formatValue(nn(cleanNumber(src[part])))}</span>;
    const v = x[st][part];
    return (
      <input
        className="in num" style={{ height: 28, ...(ok(v) ? {} : { borderColor: "var(--crit)" }) }} inputMode="decimal" value={v}
        aria-label={`${p.pin} ${STAGES.find((z) => z[0] === st)![1]} ${part === "impr" ? "building" : part === "av" ? "AV" : "land"}`}
        onChange={(e) => setCell(p.parcelId, st, part, e.target.value)}
      />
    );
  };

  return (
    <div className="pinvals">
      {d.rolloverSuggestion && canEdit && (
        <div className="notice-box" role="status">
          <span>The {d.rolloverSuggestion.year} PTAB decision ({formatValue(d.rolloverSuggestion.totalAv)}) is in this reassessment cycle and can be this appeal's target.</span>
          <span className="sp" />
          <button type="button" className="btn small secondary" onClick={() => void act(() => api(`/firm/appeals/${appealId}/rollover`, { method: "POST", body: {} }), `Target set from the ${d.rolloverSuggestion!.year} PTAB decision.`)}>Use as target</button>
        </div>
      )}

      {!d.pinMode && multi && (
        <div className="notice-box copper" role="status">This property has {d.pins.length} PINs. Enter each PIN's original land and building to see the property totals and taxes.</div>
      )}

      <div className="vtiles">
        <div className="card vtile"><span className="label">Original AV</span><b>{formatValue(live.original)}</b><span className="meta">FMV {formatValue(fmvFromAv(live.original, ratio))}</span></div>
        <div className="card vtile">
          <span className="label">Target AV {d.targetSource === "rollover" && d.rollover && (
            <span className="pill net" title={`The ${d.rollover.year} PTAB decision sets this property's value for the rest of its reassessment cycle (${d.rollover.cycle.start} to ${d.rollover.cycle.end}), so it's the starting point here.`}>Rollover</span>
          )}</span>
          <b>{formatValue(live.target)}</b>
          <span className="meta">{d.targetSource === "rollover" && d.rollover ? `From the ${d.rollover.year} PTAB decision, same cycle` : `FMV ${formatValue(fmvFromAv(live.target, ratio))}`}</span>
        </div>
        <div className="card vtile"><span className="label">Resolved AV</span><b>{formatValue(live.resolved)}</b><span className="meta">FMV {formatValue(fmvFromAv(live.resolved, ratio))}</span></div>
        <div className="card vtile"><span className="label">Of the requested reduction</span><b className="copper">{achieved ?? "—"}</b><span className="meta">Resolved against target</span></div>
      </div>

      <div className="tbar" style={{ marginBottom: 8 }}>
        <button type="button" className="btn small secondary" aria-pressed={showOffers} onClick={() => setShowOffers((v) => !v)}>{showOffers ? "Hide offers" : "Show offers"}</button>
        <button type="button" className="btn small secondary" aria-pressed={showLog} onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide offer history" : `Offer history (${d.offers.length})`}</button>
        {canEdit && d.pinMode && <button type="button" className="btn small secondary" onClick={() => setDivide(divide ? null : { stage: locked ? "target" : "resolved", basis: "fmv", amount: "" })}>Divide an agreed total</button>}
        <span className="sp" />
        {locked
          ? <span className="pill net" title={`Locked ${formatDateTime(d.stipulation!.lockedAt)}${d.stipulation!.lockedBy ? ` by ${d.stipulation!.lockedBy}` : ""}`}>Stipulation locked</span>
          : null}
        {canEdit && d.pinMode && (locked
          ? <button type="button" className="btn small ghost" onClick={() => void act(() => api(`/firm/appeals/${appealId}/stipulation`, { method: "POST", body: { lock: false } }), "Stipulation unlocked.")}>Unlock</button>
          : <button type="button" className="btn small secondary" disabled={live.resolved === null} title="Freezes the resolved figures for each PIN as the stipulation" onClick={() => void act(() => api(`/firm/appeals/${appealId}/stipulation`, { method: "POST", body: { lock: true } }), "Stipulation locked. The resolved figures can't change until it's unlocked.")}>Lock stipulation</button>)}
      </div>

      {divide && (
        <form className="card pad divide" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act(() => api(`/firm/appeals/${appealId}/split`, { method: "POST", body: { stage: divide.stage, [divide.basis === "fmv" ? "fmv" : "totalAv"]: cleanNumber(divide.amount) } }),
            `Divided among the PINs: land held, building takes the change.`).then((done) => { if (done) setDivide(null); });
        }}>
          <div className="fld"><label htmlFor="dv-stage">Set</label>
            <select id="dv-stage" className="in" value={divide.stage} onChange={(e) => setDivide({ ...divide, stage: e.target.value as "target" | "resolved" })}>
              <option value="target">Target</option>{!locked && <option value="resolved">Resolved</option>}
            </select>
          </div>
          <div className="fld"><label htmlFor="dv-basis">Agreed as</label>
            <select id="dv-basis" className="in" value={divide.basis} onChange={(e) => setDivide({ ...divide, basis: e.target.value as "av" | "fmv" })}>
              <option value="fmv">Market value</option><option value="av">Total AV</option>
            </select>
          </div>
          <div className="fld"><label htmlFor="dv-amt">{divide.basis === "fmv" ? "Market value" : "Total AV"} for the PINs on the appeal</label>
            <input id="dv-amt" className="in num" inputMode="decimal" value={divide.amount} onChange={(e) => setDivide({ ...divide, amount: e.target.value })} />
          </div>
          <button className="btn small" disabled={!cleanNumber(divide.amount) || !ok(divide.amount)}>Divide</button>
          <button type="button" className="btn small secondary" onClick={() => setDivide(null)}>Cancel</button>
          <p className="meta" style={{ flexBasis: "100%", margin: 0 }}>Each PIN gets its share of the original AV of the PINs on the appeal, to the penny. Land stays; the building takes the change, or the land when there's no building left.</p>
        </form>
      )}

      <div className="card">
        <div className="tw">
          <table className="compact pintable">
            <thead>
              <tr>
                <th>PIN</th><th />
                {STAGES.map(([st, label]) => <th key={st} className="num">{label}</th>)}
                {showOffers && <><th className="num">Firm offer</th><th className="num">{PARTY_LABELS[d.latestOffers.other?.party ?? OTHER_SIDE[level]]} offer</th></>}
              </tr>
            </thead>
            <tbody>
              {d.pins.map((p) => {
                const x = draft[p.parcelId];
                if (!x) return null;
                return (["land", "impr", "av"] as const).map((part, i) => (
                  <tr key={`${p.parcelId}-${part}`} className={i === 0 ? "pinstart" : ""}>
                    <td>
                      {i === 0 && <b className="pin">{p.pin.replace(/-0000$/, "")}</b>}
                      {i === 1 && multi && (
                        <label className="check small">
                          <input type="checkbox" checked={x.onAppeal} disabled={!canEdit || locked} onChange={(e) => setDraft({ ...draft, [p.parcelId]: { ...x, onAppeal: e.target.checked } })} /> On this appeal
                        </label>
                      )}
                    </td>
                    <td className={part === "av" ? "" : "meta"}>{part === "land" ? "Land" : part === "impr" ? "Building" : <b>AV</b>}</td>
                    {STAGES.map(([st]) => <td key={st} className="num">{cell(p, st, part)}</td>)}
                    {offerCols.map((o, k) => {
                      const v = offerFor(o, p.parcelId);
                      const shown = !x.onAppeal ? (part === "av" ? draftAv(x.original) : nn(cleanNumber(x.original[part]))) : v ? (part === "av" ? v.av : v[part]) : null;
                      return <td key={k} className={`num ${part === "av" ? "" : "meta"}`}>{formatValue(shown)}</td>;
                    })}
                  </tr>
                ));
              })}
              {multi && (
                <>
                  <tr className="ptotal">
                    <td><b>Property</b></td><td><b>AV</b></td>
                    {STAGES.map(([st]) => <td key={st} className="num"><b>{formatValue(live[st])}</b></td>)}
                    {offerCols.map((o, k) => <td key={k} className="num"><b>{formatValue(o ? offerPropertyTotal(o, d, draft) : null)}</b></td>)}
                  </tr>
                  <tr className="ptotal">
                    <td /><td className="meta">FMV</td>
                    {STAGES.map(([st]) => <td key={st} className="num">{formatValue(fmvFromAv(live[st], ratio))}</td>)}
                    {offerCols.map((o, k) => <td key={k} className="num meta">{formatValue(o ? fmvFromAv(offerPropertyTotal(o, d, draft), ratio) : null)}</td>)}
                  </tr>
                </>
              )}
              {!multi && (
                <tr className="ptotal">
                  <td /><td className="meta">FMV</td>
                  {STAGES.map(([st]) => <td key={st} className="num">{formatValue(fmvFromAv(live[st], ratio))}</td>)}
                  {offerCols.map((o, k) => <td key={k} className="num meta">{formatValue(o ? o.fmv : null)}</td>)}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="meta" style={{ margin: "6px 0 0" }}>
        {multi ? "A PIN not on the appeal keeps its original value in the property total. " : ""}
        AV = land + building. FMV = AV ÷ {ratio ? `${Number(ratio)}%` : "the level of assessment"}{ratio && toCents(ratio) === 3333n ? " (one third: AV × 3)" : ""}. Typing only an AV keeps the land and puts the rest on the building.
      </p>

      {showLog && <OfferLog appealId={appealId} level={level} d={d} canEdit={canEdit} locked={locked} act={act} />}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

/** An offer covers the PINs on the appeal; the property total adds the others at their original values. */
function offerPropertyTotal(o: Offer, d: ValuesData, draft: Draft): string | null {
  let sum = 0n;
  for (const p of d.pins) {
    const x = draft[p.parcelId];
    const v = o.pins.find((q) => q.parcelId === p.parcelId);
    const av = v ? v.av : x ? draftAv(x.original) : null;
    if (av === null) return null;
    sum += toCents(av);
  }
  return centsToString(sum);
}

function OfferLog({ appealId, level, d, canEdit, locked, act }: {
  appealId: number; level: Level; d: ValuesData; canEdit: boolean; locked: boolean;
  act: (fn: () => Promise<ValuesData>, msg: string) => Promise<boolean>;
}) {
  const [f, setF] = useState({ offeredOn: new Date().toISOString().slice(0, 10), party: "firm", basis: "fmv" as "fmv" | "av", amount: "", note: "" });
  const [confirm, setConfirm] = useState<number | null>(null);
  const multi = d.pins.filter((p) => p.onAppeal).length > 1;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="tw">
        <table className="compact">
          <thead><tr><th>Date</th><th>From</th><th className="num">Market value</th><th className="num">AV{multi ? ", PINs on appeal" : ""}</th><th>Note</th><th /></tr></thead>
          <tbody>
            {d.offers.map((o) => (
              <tr key={o.id}>
                <td>{formatDate(o.offered_on)}</td>
                <td><span className={`pill ${o.party === "firm" ? "net" : o.party === "agreed" ? "ok" : "copper"}`}>{PARTY_LABELS[o.party]}</span></td>
                <td className="num">{formatValue(o.fmv)}</td>
                <td className="num"><b>{formatValue(o.total_av)}</b></td>
                <td className="meta" style={{ whiteSpace: "normal" }}>{o.note}{o.created_by_name ? <span style={{ display: "block" }}>by {o.created_by_name}</span> : null}</td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {canEdit && (confirm === o.id ? (
                    <span className="confirm tight">Delete?
                      <button type="button" className="btn small danger" onClick={() => void act(() => api(`/firm/appeals/${appealId}/offers/${o.id}`, { method: "DELETE" }), "Offer deleted.").then(() => setConfirm(null))}>Delete</button>
                      <button type="button" className="btn small secondary" onClick={() => setConfirm(null)}>Keep</button>
                    </span>
                  ) : (
                    <>
                      {!locked && <button type="button" className="btn small ghost" onClick={() => void act(() => api(`/firm/appeals/${appealId}/offers/${o.id}/use`, { method: "POST", body: { stage: "resolved" } }), "The offer's figures are now the resolved values.")}>Use as resolved</button>}
                      <button type="button" className="btn small ghost" onClick={() => setConfirm(o.id)} aria-label={`Delete the ${formatDate(o.offered_on)} offer`}>✕</button>
                    </>
                  ))}
                </td>
              </tr>
            ))}
            {d.offers.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 16 }}>No offers recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {canEdit && d.pinMode && (
        <form className="offer-form" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act(() => api(`/firm/appeals/${appealId}/offers`, { method: "POST", body: {
            offeredOn: f.offeredOn, party: f.party, [f.basis === "fmv" ? "fmv" : "totalAv"]: cleanNumber(f.amount), note: f.note.trim() || null,
          } }), "Offer recorded.").then((done) => { if (done) setF({ ...f, amount: "", note: "" }); });
        }} aria-label="Record an offer">
          <div className="fld"><label htmlFor="of-date">Date</label><input id="of-date" type="date" className="in" value={f.offeredOn} onChange={(e) => setF({ ...f, offeredOn: e.target.value })} /></div>
          <div className="fld"><label htmlFor="of-from">From</label>
            <select id="of-from" className="in" value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })}>
              <option value="firm">Firm</option>
              <option value={OTHER_SIDE[level]}>{PARTY_LABELS[OTHER_SIDE[level]]}</option>
              {Object.keys(PARTY_LABELS).filter((k) => k !== "firm" && k !== OTHER_SIDE[level]).map((k) => <option key={k} value={k}>{PARTY_LABELS[k]}</option>)}
            </select>
          </div>
          <div className="fld"><label htmlFor="of-basis">As</label>
            <select id="of-basis" className="in" value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value as "fmv" | "av" })}><option value="fmv">Market value</option><option value="av">Total AV</option></select>
          </div>
          <div className="fld"><label htmlFor="of-amt">Amount</label><input id="of-amt" className="in num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div className="fld grow"><label htmlFor="of-note">Note</label><input id="of-note" className="in" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <button className="btn small" disabled={!cleanNumber(f.amount) || !ok(f.amount)}>Record offer</button>
        </form>
      )}
    </div>
  );
}
