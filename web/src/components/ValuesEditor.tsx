// The Values tab: one appeal's values PIN by PIN (land, building, AV for
// original, target and resolved; see PinValues), with FMV, equalized value,
// net tax and savings recalculated live as you type, using the same
// exact-decimal math the server uses, and the appeal's own details.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { useFirmUsers } from "../data";
import { cleanNumber, formatDateTime, formatMoney, formatValue, nn } from "../format";
import { AmountInput } from "./MoneyInput";
import { PinValues, type LiveTotals } from "./PinValues";
import { computeAppealTax } from "../../../shared/valuation";
import { centsToString, equalizedValue, feeAmount, toCents } from "../../../shared/money";
import { APPEAL_STATUSES, APPEAL_STATUS_LABELS, LEVEL_LABELS, LEVEL_SUBSTAGES, SUBSTAGE_LABELS, type Level, type Substage } from "../../../shared/domain";
import type { AppealRow } from "../pages/Property";

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const valid = (v: string) => v === "" || /^-?\d{1,12}(\.\d{1,2})?$/.test(cleanNumber(v));

export function ValuesEditor({
  appeal, onSaved, canEdit, canEditFees, onDeleted,
}: {
  appeal: AppealRow;
  onSaved: () => void;
  onDeleted: () => void;
  canEdit: boolean;
  canEditFees: boolean;
}) {
  const users = useFirmUsers();
  const [form, setForm] = useState(() => formFrom(appeal));
  const [manual, setManual] = useState({ original: s(appeal.original_tax), target: s(appeal.target_tax), resolved: s(appeal.resolved_tax) });
  const [rateEdit, setRateEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Fresh data for the same appeal (after a save) refreshes the fields but keeps the confirmation;
  // switching to another appeal also clears messages.
  useEffect(() => {
    setForm(formFrom(appeal));
    setManual({ original: s(appeal.original_tax), target: s(appeal.target_tax), resolved: s(appeal.resolved_tax) });
  }, [appeal]);
  useEffect(() => {
    setRateEdit(false);
    setError("");
    setSaved("");
    setConfirmDelete(false);
  }, [appeal.id]);

  // Totals come from the PINs, live as they're typed.
  const [totals, setTotals] = useState<LiveTotals>({ original: appeal.orig_av, target: appeal.target_av, resolved: appeal.resolved_av });
  const pinSave = useRef<{ save: (() => Promise<void>) | null; valid: boolean }>({ save: null, valid: true });
  const [pinsValid, setPinsValid] = useState(true);
  const [pinsKey, setPinsKey] = useState(0);
  const onTotals = useCallback((t: LiveTotals) => setTotals((cur) => (cur.original === t.original && cur.target === t.target && cur.resolved === t.resolved ? cur : t)), []);
  const register = useCallback((save: (() => Promise<void>) | null, valid: boolean) => { pinSave.current = { save, valid }; setPinsValid(valid); }, []);
  const eq = form.equalizer.trim() || null;
  const rate = form.taxRatePercent.trim() || null;
  const computed = useMemo(() => {
    if (form.calcOverride) {
      const m = { o: nn(cleanNumber(manual.original)), t: nn(cleanNumber(manual.target)), r: nn(cleanNumber(manual.resolved)) };
      const ok = (v: string | null) => v === null || valid(v);
      const diff = (x: string | null, y: string | null) => (x && y && ok(x) && ok(y) ? centsToString(toCents(x) - toCents(y)) : null);
      return { originalTax: m.o, targetTax: m.t, resolvedTax: m.r, estimatedSavings: diff(m.o, m.t), savings: diff(m.o, m.r) };
    }
    const okEq = eq && /^\d{1,3}(\.\d{1,4})?$/.test(eq);
    const okRate = rate && /^\d{1,3}(\.\d{1,6})?$/.test(rate);
    return computeAppealTax({ origAv: totals.original, targetAv: totals.target, resolvedAv: totals.resolved, equalizer: okEq ? eq : null, taxRatePercent: okRate ? rate : null });
  }, [form.calcOverride, manual, eq, rate, totals]);

  const feePercent = form.feePercent.trim() || appeal.fee.percent;
  const feeBase = computed.savings ?? computed.estimatedSavings;
  const feeEstimate = appeal.fee.basis === "first_year_savings" && feeBase && /^\d{1,3}(\.\d{1,2})?$/.test(feePercent) ? feeAmount(feeBase, feePercent) : null;
  const ratio = form.assessmentRatio.trim() || appeal.assessment_ratio;
  const rateChanged = eq !== (appeal.equalizer ?? null) || rate !== (appeal.tax_rate_percent ?? null);
  const gridValid = pinsValid;

  async function save() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      if (pinSave.current.save) await pinSave.current.save();
      const body: Record<string, unknown> = {
        status: form.status, substage: form.substage, externalId: nn(form.externalId), petitionNo: nn(form.petitionNo),
        filedOn: nn(form.filedOn), decisionOn: nn(form.decisionOn),
        representativeUserId: form.representativeUserId ? Number(form.representativeUserId) : null,
        nextAction: nn(form.nextAction), nextActionOn: nn(form.nextActionOn), assessmentRatio: nn(cleanNumber(form.assessmentRatio)),
        excludeFromTotals: form.excludeFromTotals, calcOverride: form.calcOverride,
      };
      if (/^\d{4}$/.test(form.taxYear.trim()) && Number(form.taxYear) !== appeal.tax_year) body.taxYear = Number(form.taxYear);
      if (form.calcOverride) {
        body.manualTaxes = { original: nn(cleanNumber(manual.original)), target: nn(cleanNumber(manual.target)), resolved: nn(cleanNumber(manual.resolved)) };
      }
      if (rateChanged) {
        body.equalizer = eq;
        body.taxRatePercent = rate;
        body.overrideReason = nn(form.overrideReason);
      }
      if (canEditFees && (form.feePercent.trim() || null) !== (appeal.fee_percent ?? null)) body.feePercent = nn(cleanNumber(form.feePercent));
      await api(`/firm/appeals/${appeal.id}`, { method: "PATCH", body });
      setSaved("Saved.");
      setPinsKey((k) => k + 1);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function useReference() {
    setBusy(true);
    setError("");
    try {
      // Carry an unsaved switch between calculated and hand-entered figures along with the new rates.
      if (form.calcOverride !== appeal.calc_override) {
        await api(`/firm/appeals/${appeal.id}`, { method: "PATCH", body: { calcOverride: form.calcOverride } });
      }
      await api(`/firm/appeals/${appeal.id}/use-reference`, { method: "POST", body: {} });
      setSaved("Applied the latest published equalizer and rate.");
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/firm/appeals/${appeal.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const substages: Substage[] = [...LEVEL_SUBSTAGES[appeal.level], "closed"];

  const update = appeal.reference_update as null | { equalizer: string; equalizerYear: number; ratePercent: string; taxYear: number; manual: boolean };

  return (
    <div className="stack">
      {update && (
        <div className="notice-box copper" role="status">
          <span>
            <b>Newer rate published.</b> Tax year {update.taxYear}: equalizer {update.equalizer}, rate {update.ratePercent}%.
            {" "}{update.manual ? "This appeal uses figures entered by hand, so it wasn't changed automatically." : "This appeal is decided, so its figures weren't changed automatically."}
          </span>
          <span className="sp" />
          {canEdit && <button type="button" className="btn small copper" onClick={() => void useReference()} disabled={busy}>Apply the newer rate</button>}
        </div>
      )}
      <div className="tbar" style={{ marginBottom: 0 }}>
        <div>
          <b style={{ color: "var(--navy)" }}>{appeal.assessment_year} {LEVEL_LABELS[appeal.level]}</b>
          <div className="meta">
            Tax year {form.taxYear} · equalizer {eq ?? "not set"} · tax rate {rate ? `${rate}%` : "not set"}
          </div>
        </div>
        <span className="sp" />
        {canEdit && <button type="button" className="btn small secondary" onClick={() => void useReference()} disabled={busy}>Use latest published rates</button>}
        {canEdit && <button type="button" className="btn small secondary" onClick={() => setRateEdit((v) => !v)}>{rateEdit ? "Hide" : "Change by hand"}</button>}
      </div>

      {(appeal.equalizer_source || appeal.tax_rate_source) && (
        <div className="meta" style={{ marginTop: -8 }}>
          {appeal.equalizer_source && <div>Equalizer source: {appeal.equalizer_source}</div>}
          {appeal.tax_rate_source && <div>Rate source: {appeal.tax_rate_source}</div>}
        </div>
      )}

      {rateEdit && canEdit && (
        <div className="card pad">
          <div className="fgrid">
            <div className="fld"><label htmlFor="v-eq">Equalizer</label><input id="v-eq" className="in num" value={form.equalizer} onChange={(e) => setForm({ ...form, equalizer: e.target.value })} inputMode="decimal" /></div>
            <div className="fld"><label htmlFor="v-rate">Tax rate %</label><input id="v-rate" className="in num" value={form.taxRatePercent} onChange={(e) => setForm({ ...form, taxRatePercent: e.target.value })} inputMode="decimal" /></div>
            <div className="fld"><label htmlFor="v-ty">Tax year of these figures</label><input id="v-ty" className="in num" value={form.taxYear} onChange={(e) => setForm({ ...form, taxYear: e.target.value })} inputMode="numeric" /></div>
            <div className="fld"><label htmlFor="v-why">Reason for the change</label><input id="v-why" className="in" value={form.overrideReason} onChange={(e) => setForm({ ...form, overrideReason: e.target.value })} placeholder="Required when you change either figure" /></div>
          </div>
        </div>
      )}

      <PinValues
        key={`${appeal.id}:${pinsKey}`}
        appealId={appeal.id}
        level={appeal.level}
        ratio={ratio}
        canEdit={canEdit}
        onTotals={onTotals}
        register={register}
        onChanged={(msg) => { setSaved(msg); onSaved(); }}
      />

      <div className="card">
        <div className="tw">
          <table className="values compact">
            <thead>
              <tr><th /><th className="num">Original</th><th className="num">Target</th><th className="num">Resolved</th></tr>
            </thead>
            <tbody>
              <tr className="group"><td colSpan={4}>Tax</td></tr>
              <tr>
                <td>Equalized value</td>
                {(["original", "target", "resolved"] as const).map((k) => <td key={k} className="num">{!form.calcOverride && totals[k] && eq && /^\d{1,3}(\.\d{1,4})?$/.test(eq) ? formatValue(equalizedValue(totals[k]!, eq)) : "—"}</td>)}
              </tr>
              <tr>
                <td>Net tax</td>
                {form.calcOverride
                  ? (["original", "target", "resolved"] as const).map((k) => (
                    <td key={k} className="num">
                      <AmountInput money className="in num" style={{ height: 30 }} aria-label={`${k} net tax`} value={manual[k]} disabled={!canEdit} onChange={(v) => setManual({ ...manual, [k]: v })} />
                    </td>
                  ))
                  : [computed.originalTax, computed.targetTax, computed.resolvedTax].map((v, i) => <td key={i} className="num">{v ? formatMoney(v) : "—"}</td>)}
              </tr>
              <tr>
                <td><b>Savings</b></td>
                <td />
                <td className="num"><b>{computed.estimatedSavings ? formatMoney(computed.estimatedSavings) : "—"}</b></td>
                <td className="num"><b style={{ color: computed.savings && Number(computed.savings) > 0 ? "var(--ok)" : undefined }}>{computed.savings ? formatMoney(computed.savings) : "—"}</b></td>
              </tr>
              {appeal.fee.basis === "first_year_savings" && (
                <tr>
                  <td>Fee at {feePercent}%{appeal.fee.noFee ? " (waived, no fee)" : ""}</td>
                  <td /><td />
                  <td className="num">{feeEstimate ? formatMoney(feeEstimate) : "—"}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="meta" style={{ margin: 0 }}>
        Net tax = assessed value × equalizer × tax rate, rounded to the cent. Savings = original net tax minus resolved (or target) net tax.
        {appeal.fee.basis === "refund" && " PTAB and Circuit Court fees are a percent of the refund check, recorded when it arrives."}
      </p>

      <div className="card pad">
        <div className="fgrid">
          <div className="fld">
            <label htmlFor="v-status">Status</label>
            <select id="v-status" className="in" value={form.status} disabled={!canEdit} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {APPEAL_STATUSES.map((st) => <option key={st} value={st}>{APPEAL_STATUS_LABELS[st]}</option>)}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="v-sub">Substage</label>
            <select id="v-sub" className="in" value={form.substage} disabled={!canEdit} onChange={(e) => setForm({ ...form, substage: e.target.value as Substage })}>
              {substages.map((st) => <option key={st} value={st}>{SUBSTAGE_LABELS[st]}</option>)}
            </select>
          </div>
          <div className="fld"><label htmlFor="v-pet">Petition number</label><input id="v-pet" className="in" value={form.petitionNo} disabled={!canEdit} onChange={(e) => setForm({ ...form, petitionNo: e.target.value })} /></div>
          <div className="fld"><label htmlFor="v-ext">Appeal / filing ID</label><input id="v-ext" className="in" value={form.externalId} disabled={!canEdit} onChange={(e) => setForm({ ...form, externalId: e.target.value })} /></div>
          <div className="fld"><label htmlFor="v-filed">Date filed</label><input id="v-filed" type="date" className="in" value={form.filedOn} disabled={!canEdit} onChange={(e) => setForm({ ...form, filedOn: e.target.value })} /></div>
          <div className="fld"><label htmlFor="v-dec">Decision date</label><input id="v-dec" type="date" className="in" value={form.decisionOn} disabled={!canEdit} onChange={(e) => setForm({ ...form, decisionOn: e.target.value })} /></div>
          <div className="fld">
            <label htmlFor="v-hear">Hearing</label>
            <input id="v-hear" className="in" readOnly disabled value={appeal.hearing_at ? formatDateTime(appeal.hearing_at) : "None scheduled"} />
            <span className="hint">Add or change hearings under Deadlines in the summary card.</span>
          </div>
          <div className="fld">
            <label htmlFor="v-rep">Representative</label>
            <select id="v-rep" className="in" value={form.representativeUserId} disabled={!canEdit} onChange={(e) => setForm({ ...form, representativeUserId: e.target.value })}>
              <option value="">Not set</option>
              {users.filter((u) => u.active || String(u.id) === form.representativeUserId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="fld"><label htmlFor="v-next">Next action</label><input id="v-next" className="in" value={form.nextAction} disabled={!canEdit} onChange={(e) => setForm({ ...form, nextAction: e.target.value })} /></div>
          <div className="fld"><label htmlFor="v-nextd">Next action date</label><input id="v-nextd" type="date" className="in" value={form.nextActionOn} disabled={!canEdit} onChange={(e) => setForm({ ...form, nextActionOn: e.target.value })} /></div>
          <div className="fld"><label htmlFor="v-ratio">Level of assessment %</label><input id="v-ratio" className="in num" value={form.assessmentRatio} disabled={!canEdit} onChange={(e) => setForm({ ...form, assessmentRatio: e.target.value })} inputMode="decimal" /></div>
          <div className="fld">
            <label htmlFor="v-fee">Fee % for this appeal</label>
            <input id="v-fee" className="in num" value={form.feePercent} disabled={!canEdit || !canEditFees} onChange={(e) => setForm({ ...form, feePercent: e.target.value })} placeholder={`${appeal.fee.percent} (${appeal.fee.source === "firm" ? "firm default" : `from ${appeal.fee.source}`})`} inputMode="decimal" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <label className="check"><input type="checkbox" checked={form.excludeFromTotals} disabled={!canEdit} onChange={(e) => setForm({ ...form, excludeFromTotals: e.target.checked })} /> Exclude from totals</label>
          <label className="check"><input type="checkbox" checked={form.calcOverride} disabled={!canEdit} onChange={(e) => setForm({ ...form, calcOverride: e.target.checked })} /> Enter tax figures by hand (no calculation)</label>
        </div>
      </div>

      {canEdit && (
        <div className="tbar">
          <button type="button" className="btn" onClick={() => void save()} disabled={busy || !gridValid}>{busy ? "Saving" : "Save appeal"}</button>
          {!gridValid && <span className="error" style={{ margin: 0 }}>Values must be numbers with up to 2 decimals.</span>}
          {error && <span className="error" role="alert" style={{ margin: 0 }}>{error}</span>}
          {saved && <span className="ok" role="status" style={{ margin: 0 }}>{saved}</span>}
          <span className="sp" />
          {confirmDelete ? (
            <span className="confirm">
              Delete the {appeal.assessment_year} {LEVEL_LABELS[appeal.level]} appeal and its values?
              <button type="button" className="btn small danger" onClick={() => void remove()} disabled={busy}>Delete</button>
              <button type="button" className="btn small secondary" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="btn small ghost" onClick={() => setConfirmDelete(true)}>Delete appeal</button>
          )}
        </div>
      )}
    </div>
  );
}

function formFrom(a: AppealRow) {
  const local = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return {
    status: a.status as string, substage: a.substage, externalId: s(a.external_id), petitionNo: s(a.petition_no), filedOn: s(a.filed_on),
    decisionOn: s(a.decision_on), hearingAt: local(a.hearing_at), representativeUserId: s(a.representative_user_id), nextAction: s(a.next_action),
    nextActionOn: s(a.next_action_on), assessmentRatio: s(a.assessment_ratio), equalizer: s(a.equalizer), taxRatePercent: s(a.tax_rate_percent),
    taxYear: s(a.tax_year), overrideReason: "", feePercent: s(a.fee_percent), excludeFromTotals: a.exclude_from_totals, calcOverride: a.calc_override,
  };
}

export type { Level };
