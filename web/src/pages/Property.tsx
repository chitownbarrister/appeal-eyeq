import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { useApi, useFirmUsers } from "../data";
import { fmvFromAv, formatDate, formatMoney, formatValue, nn, reductionPct, titleCase } from "../format";
import {
  APPEAL_STATUS_LABELS, LEVEL_LABELS, LEVEL_SUBSTAGES, SUBSTAGE_LABELS,
  type AppealStatus, type Level, type Substage,
} from "../../../shared/domain";
import { sumMoney } from "../../../shared/money";
import type { EffectiveFee } from "../../../shared/fees";
import { AppealSheet, FeeSheet, PropertySheet, type PropertyRecord } from "../components/forms";
import { ValuesEditor } from "../components/ValuesEditor";
import { Sheet } from "../components/Sheet";

export interface AppealRow {
  id: number; property_id: number; parcel_id: number | null; assessment_year: number; tax_year: number; level: Level; substage: Substage;
  status: AppealStatus; external_id: string | null; petition_no: string | null; filed_on: string | null; hearing_at: string | null;
  decision_on: string | null; representative_user_id: number | null; representative_name: string | null;
  orig_av: string | null; target_av: string | null; resolved_av: string | null; assessment_ratio: string | null;
  equalizer: string | null; equalizer_source: string | null; tax_rate_percent: string | null; tax_rate_source: string | null;
  original_tax: string | null; target_tax: string | null; resolved_tax: string | null; estimated_savings: string | null; savings: string | null;
  calc_override: boolean; exclude_from_totals: boolean; fee_percent: string | null; next_action: string | null; next_action_on: string | null;
  days_in_substage: number; fee: EffectiveFee; fee_amount: string | null; estimated_fee: string | null; data_source: string;
  [key: string]: unknown;
}
interface Parcel { id: number; pin: string; alternate_pin: string | null; owner_name: string | null; parcel_type: string; class: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; is_primary: boolean; active: boolean }
interface Contact { id: number; account_id: number | null; property_id: number | null; name: string; title: string | null; role: string; email: string | null; phone: string | null; mobile: string | null; notes: string | null }
interface Activity { id: number; kind: string; subject: string; body: string | null; due_on: string | null; status: "open" | "done"; assigned_user_id: number | null; assigned_name: string | null; created_by_name: string | null; created_at: string }
interface Detail {
  property: PropertyRecord & { title: string; county: string; township: string | null; account_name: string; attorney_name: string | null; analyst_name: string | null };
  parcels: Parcel[];
  appeals: AppealRow[];
  contacts: Contact[];
  activities: Activity[];
  reference: { rate: { taxYear: number; ratePercent: string; source: string } | null; equalizer: { year: number; factor: string; source: string } | null };
  fees: { firstYear: EffectiveFee; refund: EffectiveFee };
}

type Tab = "appeals" | "values" | "parcels" | "contacts" | "activities" | "deadlines" | "files";
const TABS: { id: Tab; label: string; soon?: string }[] = [
  { id: "appeals", label: "Appeals" }, { id: "values", label: "Values" }, { id: "parcels", label: "Parcels" },
  { id: "contacts", label: "Contacts" }, { id: "activities", label: "Activities" },
  { id: "deadlines", label: "Deadlines", soon: "step 3" }, { id: "files", label: "Files", soon: "step 5" },
];

const statusPill = (s: AppealStatus) => (s === "reduced" ? "ok" : s === "waiting_decision" || s === "open" ? "warn" : s === "increased" ? "crit" : "");

export function Property() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const { data, error, reload } = useApi<Detail>(`/firm/properties/${id}`);
  const accounts = useApi<{ accounts: { id: number; name: string }[] }>("/firm/accounts");
  const [tab, setTab] = useState<Tab>(params.get("appeal") ? "values" : "appeals");
  const [year, setYear] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(params.get("appeal") ? Number(params.get("appeal")) : null);
  const [sheet, setSheet] = useState<"edit" | "fees" | "appeal" | null>(null);
  const [trackError, setTrackError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const appeals = useMemo(() => data?.appeals ?? [], [data]);
  const years = useMemo(() => [...new Set(appeals.map((a) => a.assessment_year))].sort((a, b) => b - a), [appeals]);
  const current = appeals[0] ?? null;
  const activeYear = year ?? years[0] ?? new Date().getFullYear();
  const selectedAppeal = appeals.find((a) => a.id === selected) ?? current;

  useEffect(() => {
    if (params.get("appeal")) {
      setSelected(Number(params.get("appeal")));
      setTab("values");
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const refreshAll = useCallback(async () => {
    await reload();
  }, [reload]);

  async function setSubstage(a: AppealRow, substage: Substage) {
    setTrackError("");
    try {
      await api(`/firm/appeals/${a.id}`, { method: "PATCH", body: { substage } });
      if (substage === "pushed_next_level") {
        const nextLevel: Level = a.level === "assessor" ? "bor" : "ptab";
        if (!appeals.some((x) => x.assessment_year === a.assessment_year && x.level === nextLevel)) {
          await api(`/firm/properties/${a.property_id}/appeals`, { method: "POST", body: { assessmentYear: a.assessment_year, level: nextLevel } });
        }
      }
      await refreshAll();
    } catch (err) {
      setTrackError(errorText(err));
    }
  }

  async function startLevel(level: Level) {
    setTrackError("");
    try {
      const r = await api<{ id: number }>(`/firm/properties/${id}/appeals`, { method: "POST", body: { assessmentYear: activeYear, level } });
      await refreshAll();
      setSelected(r.id);
    } catch (err) {
      setTrackError(errorText(err));
    }
  }

  async function deleteProperty() {
    try {
      await api(`/firm/properties/${id}`, { method: "DELETE" });
      navigate("/properties");
    } catch (err) {
      setTrackError(errorText(err));
    }
  }

  if (error) return <><Link className="back" to="/properties">← Properties</Link><div className="error" role="alert">{error}</div></>;
  if (!data) return null;
  const p = data.property;
  const achieved = sumMoney(appeals.filter((a) => a.status === "reduced" && a.savings && !a.exclude_from_totals).map((a) => a.savings!));
  const feeText = (f: EffectiveFee) => `${f.percent}%${f.source === "firm" ? "" : ` (${f.source})`}`;
  const now = current;
  const hot = now?.substage === "decision_analysis" && now.days_in_substage > 14;

  return (
    <>
      <Link className="back" to="/properties">← Properties</Link>
      <section className="card">
        <div className="mhead">
          <div className="mgrid">
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div className="eyebrow">Property tax appeal · {titleCase(p.asset_type)} · {p.county} County, {p.state}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {can("properties.edit") && <button className="btn small secondary" onClick={() => setSheet("edit")}>Edit matter</button>}
                  {can("appeals.edit") && <button className="btn small" onClick={() => setSheet("appeal")}>+ Appeal</button>}
                </div>
              </div>
              <h1>{p.title}</h1>
              <div className="dmeta">
                <span>Client <Link to={`/accounts/${p.account_id}`}>{p.account_name}</Link></span>
                {data.parcels[0]?.owner_name && <span>Owner of record <b>{data.parcels[0].owner_name}</b></span>}
                <span><span className={`pill ${p.status === "active" ? "ok" : ""}`}>{titleCase(p.status)}</span> {p.status === "active" ? "Open until the property is sold or the engagement ends" : ""}</span>
                {p.no_fee && <span className="pill net">No fee property</span>}
              </div>
              {years.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div className="vseg" role="group" aria-label="Assessment year">
                    {years.map((y) => (
                      <button key={y} className={activeYear === y ? "on" : ""} aria-pressed={activeYear === y} onClick={() => setYear(y)}>
                        {y}{y === years[0] ? " · current" : ""}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <YearTrack
                appeals={appeals.filter((a) => a.assessment_year === activeYear)}
                canEdit={can("appeals.edit")}
                onSubstage={(a, s) => void setSubstage(a, s)}
                onStart={(l) => void startLevel(l)}
                onOpen={(a) => { setSelected(a.id); setTab("values"); }}
              />
              {trackError && <div className="error" role="alert">{trackError}</div>}
            </div>
            <dl className="facts">
              <div><dt>Now</dt><dd className={hot ? "hot" : ""}>{now ? `${LEVEL_LABELS[now.level]} · ${SUBSTAGE_LABELS[now.substage]}` : "No appeal yet"}{hot ? ` · ${now!.days_in_substage} days` : ""}</dd></div>
              <div><dt>Next</dt><dd>{now?.next_action ?? "—"}{now?.next_action_on ? ` · ${formatDate(now.next_action_on)}` : ""}</dd></div>
              <div><dt>Attorney</dt><dd>{p.attorney_name ?? "Not assigned"}</dd></div>
              <div><dt>Analyst</dt><dd>{p.analyst_name ?? "Not assigned"}</dd></div>
              <div><dt>Township</dt><dd>{p.township ?? "Not set"}{p.tax_code ? ` · tax code ${p.tax_code}` : ""}{p.tax_code && !p.tax_code_confirmed ? " (unconfirmed)" : ""}</dd></div>
              <div><dt>Level of assessment</dt><dd>{p.level_of_assessment ? `${Number(p.level_of_assessment)}%` : "Not set"}</dd></div>
              <div><dt>Current AV</dt><dd className="num">{formatValue(now?.orig_av)}</dd></div>
              <div><dt>Target AV</dt><dd className="num">{formatValue(now?.target_av)}</dd></div>
              <div><dt>Achieved savings</dt><dd className="num" style={{ color: "var(--ok)" }}>{formatMoney(achieved)}</dd></div>
              <div><dt>Est. savings now</dt><dd className="num">{now?.estimated_savings ? formatMoney(now.estimated_savings) : "—"}</dd></div>
              <div className="wide">
                <dt>Fee</dt>
                <dd>
                  {p.no_fee && <span className="pill net">No fee</span>} Assessor and BOR {feeText(data.fees.firstYear)} of first-year savings; PTAB or Court {feeText(data.fees.refund)} of the refund{" "}
                  {can("fees.edit") && <button className="lk" onClick={() => setSheet("fees")}>Edit</button>}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="subtabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}{t.id === "parcels" && data.parcels.length > 1 ? ` (${data.parcels.length})` : ""}{t.soon && <span className="soon">{t.soon}</span>}
            </button>
          ))}
        </div>
        <div className="pane">
          {tab === "appeals" && (
            <AppealsTab appeals={appeals} canEdit={can("appeals.edit")} onCreate={() => setSheet("appeal")} onOpen={(a) => { setSelected(a.id); setTab("values"); }} />
          )}
          {tab === "values" && (selectedAppeal ? (
            <>
              <div className="tbar">
                <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <span className="meta">Appeal</span>
                  <select value={selectedAppeal.id} onChange={(e) => setSelected(Number(e.target.value))} aria-label="Choose an appeal">
                    {appeals.map((a) => <option key={a.id} value={a.id}>{a.assessment_year} {LEVEL_LABELS[a.level]} · {APPEAL_STATUS_LABELS[a.status]}</option>)}
                  </select>
                </label>
              </div>
              <ValuesEditor
                appeal={selectedAppeal}
                canEdit={can("appeals.edit")}
                canEditFees={can("fees.edit")}
                onSaved={() => void refreshAll()}
                onDeleted={() => { setSelected(null); setTab("appeals"); void refreshAll(); }}
              />
            </>
          ) : <p className="muted">No appeals yet. {can("appeals.edit") && <button className="lk" onClick={() => setSheet("appeal")}>Create the first appeal</button>}</p>)}
          {tab === "parcels" && <ParcelsTab propertyId={p.id} parcels={data.parcels} canEdit={can("properties.edit")} onChanged={() => void refreshAll()} />}
          {tab === "contacts" && <ContactsTab propertyId={p.id} accountId={p.account_id} contacts={data.contacts} canEdit={can("accounts.edit")} onChanged={() => void refreshAll()} />}
          {tab === "activities" && <ActivitiesTab target={{ propertyId: p.id }} activities={data.activities} onChanged={() => void refreshAll()} />}
          {tab === "deadlines" && (
            <div className="placeholder"><h2>Deadlines arrive with the calendar</h2><p className="muted">Build step 3 adds township filing windows and property-specific deadlines (like PTAB at 30 days from the BOR decision) here and on the Calendar.</p></div>
          )}
          {tab === "files" && (
            <div className="placeholder"><h2>Files arrive with Dropbox</h2><p className="muted">Build step 5 connects your firm's Dropbox, creates the folder template for this property, and opens documents in your desktop apps.</p></div>
          )}
        </div>
      </section>

      {can("properties.delete") && (
        <div className="tbar" style={{ marginTop: 14 }}>
          <span className="sp" />
          {confirmDelete ? (
            <span className="confirm">
              Delete {p.name} with all its appeals, parcels, contacts and activities? This can't be undone.
              <button className="btn small danger" onClick={() => void deleteProperty()}>Delete property</button>
              <button className="btn small secondary" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          ) : <button className="btn small ghost" onClick={() => setConfirmDelete(true)}>Delete property</button>}
        </div>
      )}

      {sheet === "edit" && (
        <PropertySheet existing={p} accounts={accounts.data?.accounts ?? []} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void refreshAll(); }} />
      )}
      {sheet === "fees" && (
        <FeeSheet
          property={p}
          inherited={{ firstYear: data.fees.firstYear.source === "property" ? "Client or firm" : data.fees.firstYear.percent, refund: data.fees.refund.source === "property" ? "Client or firm" : data.fees.refund.percent }}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); void refreshAll(); }}
        />
      )}
      {sheet === "appeal" && (
        <AppealSheet
          propertyId={p.id}
          parcels={data.parcels}
          defaultYear={activeYear}
          onClose={() => setSheet(null)}
          onSaved={async (aid) => { setSheet(null); await refreshAll(); setSelected(aid); setTab("values"); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- year track
function YearTrack({
  appeals, canEdit, onSubstage, onStart, onOpen,
}: {
  appeals: AppealRow[];
  canEdit: boolean;
  onSubstage: (a: AppealRow, s: Substage) => void;
  onStart: (level: Level) => void;
  onOpen: (a: AppealRow) => void;
}) {
  const byLevel = new Map<Level, AppealRow>();
  for (const a of appeals) if (!byLevel.has(a.level) || a.parcel_id === null) byLevel.set(a.level, a);
  const path: Level[] = byLevel.has("circuit") ? ["assessor", "bor", "circuit"] : ["assessor", "bor", "ptab"];
  const curIdx = Math.max(-1, ...path.map((l, i) => (byLevel.has(l) ? i : -1)));
  const pushLabel = (l: Level) => (l === "assessor" ? "Push to BOR" : "Push to PTAB");

  return (
    <div className="txtrack">
      {path.map((level, i) => {
        const a = byLevel.get(level);
        const finished = a && (a.substage === "closed" || a.substage === "pushed_next_level");
        const state = !a ? (i < curIdx ? "done" : "next") : i < curIdx || finished ? "done" : "cur";
        const subs = LEVEL_SUBSTAGES[level];
        const si = a ? (a.substage === "closed" ? subs.length : subs.indexOf(a.substage)) : -1;
        const status = !a ? (i < curIdx ? "Not filed" : "Not started") : a.substage === "closed" ? `${APPEAL_STATUS_LABELS[a.status]} · closed` : SUBSTAGE_LABELS[a.substage];
        return (
          <div key={level} className={`txlvl ${state}`}>
            <div className="txh" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div><b>{LEVEL_LABELS[level]}</b><span>{status}</span></div>
              {a && <button className="lk" onClick={() => onOpen(a)} aria-label={`Open ${LEVEL_LABELS[level]} values`}>Values</button>}
            </div>
            {a ? (
              <ol>
                {subs.map((s, j) => (
                  <li key={s} className={j < si ? "d" : j === si ? "c" : ""}>
                    <button
                      type="button"
                      disabled={!canEdit || j === si}
                      onClick={() => onSubstage(a, s)}
                      aria-label={`Set ${LEVEL_LABELS[level]} to ${s === "pushed_next_level" ? pushLabel(level) : SUBSTAGE_LABELS[s]}`}
                    >
                      {s === "pushed_next_level" ? pushLabel(level) : SUBSTAGE_LABELS[s]}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              i === curIdx + 1 && canEdit && <button className="btn small secondary" style={{ marginTop: 8 }} onClick={() => onStart(level)}>Start {LEVEL_LABELS[level]} appeal</button>
            )}
          </div>
        );
      })}
      <div className="txalt">
        <span className="meta">
          {path.includes("circuit") ? "Circuit Court tax objection instead of PTAB." : "Circuit Court is the alternative to PTAB."}
          {!path.includes("circuit") && byLevel.has("bor") && !byLevel.has("ptab") && canEdit && (
            <> <button className="lk" onClick={() => onStart("circuit")}>Start a Circuit Court tax objection instead</button></>
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- appeals table
function AppealsTab({ appeals, canEdit, onCreate, onOpen }: { appeals: AppealRow[]; canEdit: boolean; onCreate: () => void; onOpen: (a: AppealRow) => void }) {
  const achieved = sumMoney(appeals.filter((a) => a.status === "reduced" && a.savings && !a.exclude_from_totals).map((a) => a.savings!));
  return (
    <>
      <div className="tbar">
        <span className="meta">{appeals.length} appeal{appeals.length === 1 ? "" : "s"} · achieved savings {formatMoney(achieved)}</span>
        <span className="sp" />
        {canEdit && <button className="btn small" onClick={onCreate}>+ Create appeal</button>}
      </div>
      <div className="tw">
        <table className="compact">
          <thead>
            <tr>
              <th>Asmt year</th><th>Level</th><th>Status</th><th className="num">Orig. FMV</th><th className="num">Target FMV</th><th className="num">Resolved FMV</th>
              <th className="num">Orig. AV</th><th className="num">Target AV</th><th className="num">Resolved AV</th><th className="num">Reduction</th>
              <th className="num">Orig. tax</th><th className="num">Target tax</th><th className="num">Resolved tax</th><th className="num">Savings</th><th className="num">Fee</th>
            </tr>
          </thead>
          <tbody>
            {appeals.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => onOpen(a)} title="Open values">
                <td className="num">{a.assessment_year}<span className="mn" style={{ display: "block" }}>tax yr {a.tax_year}</span></td>
                <td style={{ whiteSpace: "nowrap" }}>{LEVEL_LABELS[a.level]}<span className="mn" style={{ display: "block" }}>{SUBSTAGE_LABELS[a.substage]}</span></td>
                <td><span className={`pill ${statusPill(a.status)}`}>{APPEAL_STATUS_LABELS[a.status]}</span>{a.exclude_from_totals && <span className="mn" style={{ display: "block" }}>Excluded</span>}</td>
                <td className="num">{formatValue(fmvFromAv(a.orig_av, a.assessment_ratio))}</td>
                <td className="num">{formatValue(fmvFromAv(a.target_av, a.assessment_ratio))}</td>
                <td className="num">{formatValue(fmvFromAv(a.resolved_av, a.assessment_ratio))}</td>
                <td className="num">{formatValue(a.orig_av)}</td>
                <td className="num">{formatValue(a.target_av)}</td>
                <td className="num">{formatValue(a.resolved_av)}</td>
                <td className="num">{reductionPct(a.orig_av, a.resolved_av)}</td>
                <td className="num">{a.original_tax ? formatMoney(a.original_tax) : "—"}</td>
                <td className="num">{a.target_tax ? formatMoney(a.target_tax) : "—"}</td>
                <td className="num">{a.resolved_tax ? formatMoney(a.resolved_tax) : "—"}</td>
                <td className="num"><b>{a.savings ? formatMoney(a.savings) : "—"}</b>{a.calc_override && <span className="mn" style={{ display: "block" }}>entered by hand</span>}</td>
                <td className="num">
                  {a.fee_amount ? formatMoney(a.fee_amount) : a.fee.basis === "refund" ? <span className="mn">{a.fee.percent}% of refund</span> : "—"}
                  {a.fee_amount && a.fee.noFee && <span className="mn" style={{ display: "block" }}>Waived</span>}
                </td>
              </tr>
            ))}
            {appeals.length === 0 && <tr><td colSpan={15} className="meta" style={{ textAlign: "center", padding: 20 }}>No appeals yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="meta" style={{ marginTop: 10 }}>
        Click a row to see and edit its values. FMV = AV ÷ level of assessment.
        {appeals.some((a) => a.calc_override) && " Rows marked \u201centered by hand\u201d keep their tax figures as entered (for example, imported from the prior software) and aren't recalculated."}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- parcels
function ParcelsTab({ propertyId, parcels, canEdit, onChanged }: { propertyId: number; parcels: Parcel[]; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Parcel | "new" | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function remove(id: number) {
    setError("");
    try {
      await api(`/firm/parcels/${id}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <>
      <div className="tbar">
        <span className="meta">Properties with several PINs list each one here. Appeals can cover the whole property or one parcel.</span>
        <span className="sp" />
        {canEdit && <button className="btn small" onClick={() => setEditing("new")}>+ Parcel</button>}
      </div>
      <div className="tw">
        <table className="compact">
          <thead><tr><th>Parcel #</th><th>Owner</th><th>Type</th><th>Class</th><th>Address</th><th>Status</th><th /></tr></thead>
          <tbody>
            {parcels.map((x) => (
              <tr key={x.id}>
                <td className="num"><span className="mt">{x.pin}</span>{x.is_primary && <span className="mn">Primary</span>}</td>
                <td>{x.owner_name ?? "—"}</td>
                <td>{titleCase(x.parcel_type)}</td>
                <td>{x.class ?? "—"}</td>
                <td>{[x.address, x.city].filter(Boolean).join(", ") || "—"}</td>
                <td><span className={`pill ${x.active ? "ok" : ""}`}>{x.active ? "Active" : "Inactive"}</span></td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {canEdit && (removing === x.id ? (
                    <span className="confirm">Remove {x.pin}?
                      <button className="btn small danger" onClick={() => void remove(x.id)}>Remove</button>
                      <button className="btn small secondary" onClick={() => setRemoving(null)}>Keep</button>
                    </span>
                  ) : (
                    <>
                      <button className="btn small ghost" onClick={() => setEditing(x)}>Edit</button>
                      {parcels.length > 1 && <button className="btn small ghost" onClick={() => setRemoving(x.id)}>Remove</button>}
                    </>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {editing && <ParcelSheet propertyId={propertyId} parcel={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
    </>
  );
}

function ParcelSheet({ propertyId, parcel, onClose, onSaved }: { propertyId: number; parcel: Parcel | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    pin: parcel?.pin ?? "", alternatePin: parcel?.alternate_pin ?? "", ownerName: parcel?.owner_name ?? "", parcelType: parcel?.parcel_type ?? "real",
    class: parcel?.class ?? "", address: parcel?.address ?? "", city: parcel?.city ?? "", active: parcel?.active ?? true,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    const body = { pin: f.pin.trim(), alternatePin: nn(f.alternatePin), ownerName: nn(f.ownerName), parcelType: f.parcelType, class: nn(f.class), address: nn(f.address), city: nn(f.city), ...(parcel ? { active: f.active } : {}) };
    try {
      if (parcel) await api(`/firm/parcels/${parcel.id}`, { method: "PATCH", body });
      else await api(`/firm/properties/${propertyId}/parcels`, { method: "POST", body });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet eyebrow={parcel ? "Edit parcel" : "New parcel"} title={parcel ? parcel.pin : "Add a parcel"} onClose={onClose} onSubmit={() => void save()}
      footer={<>{error && <span className="error" style={{ margin: 0, flexBasis: "100%" }} role="alert">{error}</span>}<span className="sp" /><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving" : "Save parcel"}</button></>}>
      <div className="fgrid">
        <div className="fld"><label htmlFor="pc-pin">PIN</label><input id="pc-pin" className="in" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value })} required /></div>
        <div className="fld"><label htmlFor="pc-alt">Alternate PIN</label><input id="pc-alt" className="in" value={f.alternatePin} onChange={(e) => setF({ ...f, alternatePin: e.target.value })} /></div>
        <div className="fld span2"><label htmlFor="pc-owner">Owner of record</label><input id="pc-owner" className="in" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></div>
        <div className="fld">
          <label htmlFor="pc-type">Type</label>
          <select id="pc-type" className="in" value={f.parcelType} onChange={(e) => setF({ ...f, parcelType: e.target.value })}><option value="real">Real</option><option value="personal">Personal</option></select>
        </div>
        <div className="fld"><label htmlFor="pc-class">Class</label><input id="pc-class" className="in" value={f.class} onChange={(e) => setF({ ...f, class: e.target.value })} placeholder="2-95" /></div>
        <div className="fld"><label htmlFor="pc-addr">Address</label><input id="pc-addr" className="in" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
        <div className="fld"><label htmlFor="pc-city">City</label><input id="pc-city" className="in" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></div>
      </div>
      {parcel && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
    </Sheet>
  );
}

// ---------------------------------------------------------------- contacts
export function ContactsTab({ propertyId, accountId, contacts, canEdit, onChanged }: { propertyId?: number; accountId: number; contacts: Contact[]; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", title: "", role: "other", email: "", phone: "", attach: propertyId ? "property" : "account" });
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/firm/contacts", {
        method: "POST",
        body: {
          name: f.name.trim(), title: nn(f.title), role: f.role, email: nn(f.email), phone: nn(f.phone),
          ...(f.attach === "property" && propertyId ? { propertyId, accountId } : { accountId }),
        },
      });
      setF({ ...f, name: "", title: "", email: "", phone: "" });
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function remove(id: number) {
    try {
      await api(`/firm/contacts/${id}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <>
      <div className="tbar"><span className="sp" />{canEdit && !adding && <button className="btn small" onClick={() => setAdding(true)}>+ Contact</button>}</div>
      {adding && (
        <form className="card pad" onSubmit={add} aria-label="Add a contact" style={{ marginBottom: 14 }}>
          <div className="form-row">
            <div className="field"><label htmlFor="ct-name">Name</label><input id="ct-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
            <div className="field"><label htmlFor="ct-title">Title</label><input id="ct-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
            <div className="field">
              <label htmlFor="ct-role">Role</label>
              <select id="ct-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="primary">Primary</option><option value="billing">Billing</option><option value="owner">Owner</option><option value="other">Other</option>
              </select>
            </div>
            <div className="field"><label htmlFor="ct-email">Email</label><input id="ct-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            <div className="field"><label htmlFor="ct-phone">Phone</label><input id="ct-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
            {propertyId && (
              <div className="field">
                <label htmlFor="ct-attach">Applies to</label>
                <select id="ct-attach" value={f.attach} onChange={(e) => setF({ ...f, attach: e.target.value })}>
                  <option value="property">This property</option><option value="account">The client (all properties)</option>
                </select>
              </div>
            )}
            <button className="btn" type="submit">Add contact</button>
            <button className="btn secondary" type="button" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
      <div className="tw">
        <table className="compact">
          <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th>Applies to</th><th /></tr></thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td><span className="mt">{c.title ? `${c.title} ` : ""}{c.name}</span></td>
                <td>{titleCase(c.role)}</td>
                <td>{c.email ? <span style={{ userSelect: "all" }}>{c.email}</span> : "—"}</td>
                <td>{c.phone ?? c.mobile ?? "—"}</td>
                <td className="meta">{c.property_id ? "This property" : "Client"}</td>
                <td className="num">
                  {canEdit && (removing === c.id ? (
                    <span className="confirm">Remove?<button className="btn small danger" onClick={() => void remove(c.id)}>Remove</button><button className="btn small secondary" onClick={() => setRemoving(null)}>Keep</button></span>
                  ) : <button className="btn small ghost" onClick={() => setRemoving(c.id)}>Remove</button>)}
                </td>
              </tr>
            ))}
            {contacts.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 20 }}>No contacts yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
    </>
  );
}

// ---------------------------------------------------------------- activities
export function ActivitiesTab({ target, activities, onChanged, showProperty }: {
  target: { propertyId?: number; accountId?: number };
  activities: (Activity & { property_name?: string | null })[];
  onChanged: () => void;
  showProperty?: boolean;
}) {
  const { me } = useSession();
  const users = useFirmUsers();
  const readOnly = me.user.isSuperAdmin;
  const [f, setF] = useState({ kind: "task", subject: "", dueOn: "", assignedUserId: "" });
  const [error, setError] = useState("");
  async function add(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/firm/activities", {
        method: "POST",
        body: { ...target, kind: f.kind, subject: f.subject.trim(), dueOn: nn(f.dueOn), assignedUserId: f.assignedUserId ? Number(f.assignedUserId) : null },
      });
      setF({ kind: f.kind, subject: "", dueOn: "", assignedUserId: "" });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function toggle(a: Activity) {
    try {
      await api(`/firm/activities/${a.id}`, { method: "PATCH", body: { status: a.status === "done" ? "open" : "done" } });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function remove(a: Activity) {
    try {
      await api(`/firm/activities/${a.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <>
      {!readOnly && (
        <form className="form-row" onSubmit={add} aria-label="Add an activity" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="act-kind">Type</label>
            <select id="act-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} style={{ minWidth: 110 }}>
              <option value="task">Task</option><option value="note">Note</option><option value="call">Call</option><option value="email">Email</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}><label htmlFor="act-subject">What</label><input id="act-subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required placeholder="Pull 2026 assessment notice" /></div>
          <div className="field"><label htmlFor="act-due">Due</label><input id="act-due" type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} style={{ minWidth: 140 }} /></div>
          <div className="field">
            <label htmlFor="act-who">Assigned to</label>
            <select id="act-who" value={f.assignedUserId} onChange={(e) => setF({ ...f, assignedUserId: e.target.value })}>
              <option value="">Nobody</option>
              {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <button className="btn" type="submit">Add</button>
        </form>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="card">
        {activities.map((a) => (
          <div key={a.id} className={`trow${a.status === "done" ? " done" : ""}`}>
            <button className="tcheck" disabled={readOnly} aria-label={a.status === "done" ? `Reopen ${a.subject}` : `Mark ${a.subject} done`} aria-pressed={a.status === "done"} onClick={() => void toggle(a)} />
            <span className="tt">
              <span className="pill" style={{ marginRight: 6 }}>{titleCase(a.kind)}</span>
              {a.subject}
              {showProperty && a.property_name && <span className="meta"> · {a.property_name}</span>}
            </span>
            <span className="tm">{a.assigned_name ?? ""}</span>
            <span className="tm num" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {a.due_on ? formatDate(a.due_on) : a.status === "done" ? "Done" : "Open"}
              {!readOnly && <button className="btn small ghost" onClick={() => void remove(a)} aria-label={`Delete ${a.subject}`}>Delete</button>}
            </span>
          </div>
        ))}
        {activities.length === 0 && <p className="meta" style={{ padding: 16, margin: 0 }}>No activities yet.</p>}
      </div>
    </>
  );
}
