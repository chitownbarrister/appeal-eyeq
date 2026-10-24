import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { useApi, useFirmUsers } from "../data";
import { fmvFromAv, formatDate, formatMoney, formatValue, nn, reductionPct, splitMatterTitle, titleCase } from "../format";
import {
  APPEAL_STATUS_LABELS, LEVELS, LEVEL_LABELS, LEVEL_SUBSTAGES, SUBSTAGE_LABELS, assetTypeText,
  type AppealStatus, type Level, type Substage,
} from "../../../shared/domain";
import { sumMoney } from "../../../shared/money";
import type { EffectiveFee } from "../../../shared/fees";
import { AppealSheet, FeeSheet, PropertySheet, type PropertyRecord } from "../components/forms";
import { FeeFigures, pct } from "../components/FeeFigures";
import { EvaluationTab } from "../components/Evaluation";
import { ValuesEditor } from "../components/ValuesEditor";
import { PropertyBilling } from "../components/BillingSheets";
import { Sheet } from "../components/Sheet";
import { DeadlinesBlock, DeadlineSheet, clock } from "../components/Deadlines";
import { FilesTab } from "../components/Files";
import { KIND_LABELS, LetterSheet, type LetterSummary } from "../components/DecisionLetter";
import { uploadDecisionFiles } from "./Decisions";
import { PhotoPanel, type PhotoInfo } from "../components/PropertyPhoto";

export interface AppealRow {
  id: number; property_id: number; parcel_id: number | null; assessment_year: number; tax_year: number; level: Level; substage: Substage;
  status: AppealStatus; external_id: string | null; petition_no: string | null; filed_on: string | null; hearing_at: string | null;
  decision_on: string | null; representative_user_id: number | null; representative_name: string | null;
  orig_av: string | null; target_av: string | null; resolved_av: string | null; assessment_ratio: string | null;
  equalizer: string | null; equalizer_source: string | null; tax_rate_percent: string | null; tax_rate_source: string | null;
  original_tax: string | null; target_tax: string | null; resolved_tax: string | null; estimated_savings: string | null; savings: string | null;
  calc_override: boolean; exclude_from_totals: boolean; fee_percent: string | null; next_action: string | null; next_action_on: string | null;
  days_in_substage: number; fee: EffectiveFee; fee_amount: string | null; estimated_fee: string | null; data_source: string;
  refund_status: "awaiting" | "received" | null; refund_expected: string | null; refund_received: string | null;
  [key: string]: unknown;
}
interface Parcel { id: number; pin: string; alternate_pin: string | null; owner_name: string | null; parcel_type: string; class: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; is_primary: boolean; active: boolean }
interface Contact { id: number; account_id: number | null; property_id: number | null; name: string; title: string | null; role: string; email: string | null; phone: string | null; mobile: string | null; notes: string | null }
interface Activity { id: number; kind: string; subject: string; body: string | null; due_on: string | null; start_time?: string | null; end_time?: string | null; location?: string | null; status: "open" | "done"; assigned_user_id: number | null; assigned_name: string | null; created_by_name: string | null; created_at: string }
export interface DeadlineItem {
  key: string; id: number | null; kind: "hearing" | "evidence" | "filing" | "other" | "window"; title: string; detail: string | null;
  due_on: string; due_time: string | null; location: string | null; notes: string | null; status: "open" | "done";
  source: "manual" | "notice" | "computed" | "window"; appeal_id: number | null; days: number;
}
interface Detail {
  deadlines: DeadlineItem[];
  today: string;
  property: PropertyRecord & { title: string; county: string; township: string | null; account_name: string; attorney_name: string | null; analyst_name: string | null; photo?: PhotoInfo | null };
  parcels: Parcel[];
  appeals: AppealRow[];
  contacts: Contact[];
  activities: Activity[];
  reference: { rate: { taxYear: number; ratePercent: string; source: string } | null; equalizer: { year: number; factor: string; source: string } | null };
  fees: { firstYear: EffectiveFee; refund: EffectiveFee };
  pendingPtab: { appealId: number; year: number; docket: string | null }[];
  decisionLetters: PropertyLetter[];
}
interface PropertyLetter { id: number; status: "review" | "clean" | "applied"; kind: LetterSummary["kind"]; appealId: number | null; appliedAt: string | null; letterDate: string | null; filedPath: string | null; fileError: string | null; filed: boolean }

/** Where the level of assessment comes from, in a few words under the figure. */
function levelNote(p: PropertyRecord): string {
  const s = p.level_source;
  if (!s) return "";
  if (s.kind === "manual") return "Set by hand";
  if (s.kind === "class") return `Class ${s.classCode}`;
  if (s.kind === "county") return "County rule";
  return s.classCode ? `Class ${s.classCode} not in the county's list` : "No class code yet";
}
function levelTip(p: PropertyRecord): string {
  const s = p.level_source;
  if (!s) return "";
  if (s.kind === "manual") return "Typed on this property. Clear it in Edit matter to follow the class code again.";
  if (s.kind === "class" || s.kind === "county") return `${s.label ?? ""}. From the county's level of assessment by class (reference data). New appeals start at this level.`;
  return "Add the PIN's class code on the Parcels tab and the level follows the county's rules. Until then this is the county's default for the asset type.";
}

type Tab = "appeals" | "values" | "evaluation" | "parcels" | "contacts" | "activities" | "billing" | "files";
const TABS: { id: Tab; label: string; soon?: string }[] = [
  { id: "appeals", label: "Appeals" }, { id: "values", label: "Values" }, { id: "evaluation", label: "Evaluation" }, { id: "parcels", label: "Parcels" },
  { id: "contacts", label: "Contacts" }, { id: "activities", label: "Activities" },
  { id: "billing", label: "Billing" }, { id: "files", label: "Files" },
];

const statusPill = (s: AppealStatus) => (s === "reduced" ? "ok" : s === "waiting_decision" || s === "open" ? "warn" : s === "increased" ? "crit" : "");

export function Property() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const { data, error, reload } = useApi<Detail>(`/firm/properties/${id}`);
  const accounts = useApi<{ accounts: { id: number; name: string }[] }>("/firm/accounts");
  const [tab, setTab] = useState<Tab>(params.get("tab") === "files" ? "files" : params.get("tab") === "evaluation" ? "evaluation" : params.get("appeal") ? "values" : "appeals");
  // A link from search to a document opens the Files tab at that file, even when this page is already open.
  const askedTab = params.get("tab");
  const askedFile = params.get("file");
  useEffect(() => { if (askedTab === "files") setTab("files"); }, [askedTab, askedFile]);
  const [year, setYear] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(params.get("appeal") ? Number(params.get("appeal")) : null);
  const [sheet, setSheet] = useState<"edit" | "fees" | "appeal" | null>(null);
  const [deadline, setDeadline] = useState<DeadlineItem | "new" | null>(null);
  const [trackError, setTrackError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [letterOpen, setLetterOpen] = useState<number | null>(null);
  const [reading, setReading] = useState("");
  const letterInput = useRef<HTMLInputElement>(null);

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
      // Pushing on marks this level and starts the next one (Assessor to BOR, BOR to PTAB) in one step.
      if (substage === "pushed_next_level") await api(`/firm/appeals/${a.id}/next-level`, { method: "POST", body: {} });
      else await api(`/firm/appeals/${a.id}`, { method: "PATCH", body: { substage } });
      await refreshAll();
    } catch (err) {
      setTrackError(errorText(err));
    }
  }

  async function startLevel(level: Level) {
    setTrackError("");
    try {
      const prevLevel: Level | null = level === "bor" ? "assessor" : level === "ptab" || level === "circuit" ? "bor" : null;
      const prev = prevLevel ? appeals.find((x) => x.assessment_year === activeYear && x.level === prevLevel) : undefined;
      const r = prev
        ? await api<{ id: number }>(`/firm/appeals/${prev.id}/next-level`, { method: "POST", body: { level } })
        : await api<{ id: number }>(`/firm/properties/${id}/appeals`, { method: "POST", body: { assessmentYear: activeYear, level } });
      await refreshAll();
      setSelected(r.id);
    } catch (err) {
      setTrackError(errorText(err));
    }
  }

  /** Reads decision letters uploaded here, then opens the first one to check and apply. */
  async function uploadLetters(files: File[]) {
    setTrackError("");
    const pid = Number(id);
    try {
      setReading(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}`);
      const ids = await uploadDecisionFiles(files, pid);
      type Q = { uploads: { id: number; status: string; page_count: number | null; pages_read: number; error: string | null }[]; letters: LetterSummary[] };
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        const q = await api<Q>(`/firm/decisions?view=review&recheck=0&propertyId=${pid}`);
        const ups = q.uploads.filter((u) => ids.includes(u.id));
        const left = ups.filter((u) => u.status === "queued" || u.status === "reading");
        if (!left.length) {
          const failed = ups.find((u) => u.status === "failed");
          if (failed) throw new Error(failed.error ?? "Couldn't read the file.");
          break;
        }
        const r = left.find((u) => u.status === "reading");
        setReading(r?.page_count ? `Reading page ${Math.min(r.pages_read + 1, r.page_count)} of ${r.page_count}` : "Reading the letter");
      }
      const found: LetterSummary[] = [];
      for (const view of ["clean", "review"]) found.push(...(await api<Q>(`/firm/decisions?view=${view}&propertyId=${pid}`)).letters.filter((l) => ids.includes(l.uploadId)));
      await refreshAll();
      if (found.length) setLetterOpen(found.sort((a, b) => a.id - b.id)[0].id);
      else setTrackError("No decision letter was found in that file.");
    } catch (err) {
      setTrackError(err instanceof Error && !(err as { status?: number }).status ? err.message : errorText(err));
    } finally {
      setReading("");
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
                <div className="eyebrow">Property tax appeal · {assetTypeText(p.asset_type, p.asset_group)} · {p.county} County, {p.state}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {can("properties.edit") && <button className="btn small secondary" onClick={() => setSheet("edit")}>Edit matter</button>}
                  {can("appeals.edit") && (
                    <>
                      <button className="btn small secondary" disabled={Boolean(reading)} onClick={() => letterInput.current?.click()}>{reading || "Upload decision letter"}</button>
                      <input ref={letterInput} type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" aria-label="Choose a decision letter to upload"
                        onChange={(e) => { if (e.target.files?.length) void uploadLetters([...e.target.files]); e.target.value = ""; }} />
                    </>
                  )}
                  {can("appeals.edit") && <button className="btn small" onClick={() => setSheet("appeal")}>+ Appeal</button>}
                </div>
              </div>
              {splitMatterTitle(p.title).pin && <div className="pin-head">PIN {splitMatterTitle(p.title).pin}{data.parcels.length > 1 ? ` and ${data.parcels.length - 1} more` : ""}</div>}
              <h1>{splitMatterTitle(p.title).place}</h1>
              <div className="dmeta">
                <span>Client <Link to={`/accounts/${p.account_id}`}>{p.account_name}</Link></span>
                {data.parcels[0]?.owner_name && <span>Owner of record <b>{data.parcels[0].owner_name}</b></span>}
                <span><span className={`pill ${p.status === "active" ? "ok" : ""}`}>{titleCase(p.status)}</span></span>
                {p.no_fee && <span className="pill net">No fee property</span>}
              </div>
              {data.pendingPtab.length > 0 && (
                <div className="ptab-flag" role="status">
                  <b>Pending PTAB</b>
                  {data.pendingPtab.map((x) => (
                    <button key={x.appealId} type="button" className="lk" onClick={() => { setSelected(x.appealId); setTab("values"); }}>{x.year}{x.docket ? ` · docket ${x.docket}` : ""}</button>
                  ))}
                </div>
              )}
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
            <div className="mside">
              <PhotoPanel propertyId={p.id} photo={p.photo ?? null} assetType={p.asset_type} address={splitMatterTitle(p.title).place} canEdit={can("properties.edit")} onChanged={() => reload()} />
              <dl className="facts">
                <div><dt>Now</dt><dd className={hot ? "hot" : ""}>{now ? `${LEVEL_LABELS[now.level]} · ${SUBSTAGE_LABELS[now.substage]}` : "No appeal yet"}{hot ? ` · ${now!.days_in_substage} days` : ""}{appeals.some((a) => a.refund_status === "awaiting") && <> <span className="pill copper">Awaiting refund</span></>}</dd></div>
                <div><dt>Attorney</dt><dd>{p.attorney_name ?? "Not assigned"}</dd></div>
                <div><dt>Analyst</dt><dd>{p.analyst_name ?? "Not assigned"}</dd></div>
                <div><dt>Township</dt><dd>{p.township ?? "Not set"}{p.tax_code ? ` · tax code ${p.tax_code}` : ""}{p.tax_code && !p.tax_code_confirmed ? " (unconfirmed)" : ""}</dd></div>
                <div><dt>Level of assessment</dt><dd title={levelTip(p)}>{p.level_of_assessment ? pct(p.level_of_assessment) : "Not set"}{levelNote(p) && <span className="mn" style={{ display: "block" }}>{levelNote(p)}</span>}</dd></div>
                <div><dt>Current AV</dt><dd className="num">{formatValue(now?.orig_av)}</dd></div>
                <div><dt>Target AV</dt><dd className="num">{formatValue(now?.target_av)}</dd></div>
                <div><dt>Achieved savings</dt><dd className="num" style={{ color: "var(--ok)" }}>{formatMoney(achieved)}</dd></div>
                <div><dt>Est. savings now</dt><dd className="num">{now?.estimated_savings ? formatMoney(now.estimated_savings) : "—"}</dd></div>
                <DeadlinesBlock items={data.deadlines} today={data.today} canEdit={can("appeals.edit")} onAdd={() => setDeadline("new")} onOpen={(d) => setDeadline(d)} />
                <div className="wide">
                  <dt>Fee</dt>
                  <dd>
                    <FeeFigures firstYear={data.fees.firstYear} refund={data.fees.refund} noFee={data.fees.firstYear.noFee}
                      flat={p.account_fee_type === "flat" ? p.account_flat_fee : null} cap={p.account_fee_cap} />
                    {can("fees.edit") && <> <span className="sep" aria-hidden="true">·</span> <button className="lk" onClick={() => setSheet("fees")}>Edit</button></>}
                    {p.co_counsel_firm && (
                      <span className="cc-note" title={`Co-counseled with ${p.co_counsel_firm}: we're the ${p.co_counsel_role === "handling" ? "handling" : "relationship"} firm${p.co_counsel_bills ? `, ${p.co_counsel_bills === "us" ? "we bill the client" : "they bill the client"}` : ""}. Details on the Evaluation tab.`}>
                        <span className="cc-mark" aria-hidden="true">*</span>Co-counsel <b>{p.co_counsel_firm}</b>{p.co_counsel_percent ? <> · <b className="num">{pct(p.co_counsel_percent)}</b> of the fee</> : null}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
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
            <>
              <AppealsTab appeals={appeals} canEdit={can("appeals.edit")} onCreate={() => setSheet("appeal")} onOpen={(a) => { setSelected(a.id); setTab("values"); }} />
              <LettersList letters={data.decisionLetters} appeals={appeals} onOpen={setLetterOpen} />
            </>
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
              <LettersList letters={data.decisionLetters.filter((l) => l.appealId === selectedAppeal.id)} appeals={appeals} onOpen={setLetterOpen} compact />
            </>
          ) : <p className="muted">No appeals yet. {can("appeals.edit") && <button className="lk" onClick={() => setSheet("appeal")}>Create the first appeal</button>}</p>)}
          {tab === "parcels" && <ParcelsTab propertyId={p.id} parcels={data.parcels} canEdit={can("properties.edit")} onChanged={() => void refreshAll()} />}
          {tab === "contacts" && <ContactsTab propertyId={p.id} accountId={p.account_id} contacts={data.contacts} canEdit={can("accounts.edit")} onChanged={() => void refreshAll()} />}
          {tab === "activities" && <ActivitiesTab target={{ propertyId: p.id }} activities={data.activities} onChanged={() => void refreshAll()} />}
          {tab === "billing" && <PropertyBilling propertyId={p.id} />}
          {tab === "evaluation" && <EvaluationTab key={`${p.id}:${appeals.length}`} propertyId={p.id} />}
          {tab === "files" && <FilesTab key={`${p.id}:${askedFile ?? ""}`} propertyId={p.id} propertyStatus={p.status} canEdit={can("properties.edit")} initialPath={params.get("path") ?? ""} initialFile={askedFile} onPhotoChanged={() => void reload()} />}
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

      {letterOpen !== null && <LetterSheet letterId={letterOpen} onClose={() => setLetterOpen(null)} onChanged={() => void refreshAll()} />}
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
      {deadline && (
        <DeadlineSheet
          propertyId={p.id}
          appeals={appeals}
          existing={deadline === "new" ? null : deadline}
          onClose={() => setDeadline(null)}
          onSaved={() => { setDeadline(null); void refreshAll(); }}
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
              i === curIdx + 1 && canEdit && (level === "bor" && byLevel.get("assessor")?.status === "no_change"
                ? <div style={{ marginTop: 8 }}><span className="meta" style={{ display: "block" }}>No change at the Assessor</span><button className="btn small copper" onClick={() => onStart(level)}>Start BOR appeal</button></div>
                : <button className="btn small secondary" style={{ marginTop: 8 }} onClick={() => onStart(level)}>Start {LEVEL_LABELS[level]} appeal</button>)
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
const FILTER_KEY = "aeq.appealFilters";
const STATUS_ORDER: AppealStatus[] = ["open", "waiting_decision", "reduced", "no_change", "increased", "withdrawn", "dismissed"];
type AppealFilters = { year: string; level: string; status: string };
function readFilters(): AppealFilters {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    return { year: typeof f.year === "string" ? f.year : "", level: typeof f.level === "string" ? f.level : "", status: typeof f.status === "string" ? f.status : "" };
  } catch { return { year: "", level: "", status: "" }; }
}

function AppealsTab({ appeals: all, canEdit, onCreate, onOpen }: { appeals: AppealRow[]; canEdit: boolean; onCreate: () => void; onOpen: (a: AppealRow) => void }) {
  // Filters, one choice per dropdown (Dillon, Oct 21). Remembered on this browser.
  const [f, setF] = useState<AppealFilters>(readFilters);
  const years = [...new Set(all.map((a) => a.assessment_year))].sort((a, b) => b - a);
  const fy = f.year && years.includes(Number(f.year)) ? f.year : "";
  const set = (next: AppealFilters) => { setF(next); try { localStorage.setItem(FILTER_KEY, JSON.stringify(next)); } catch { /* private window */ } };
  const appeals = all.filter((a) => (!fy || a.assessment_year === Number(fy)) && (!f.level || a.level === f.level) && (!f.status || a.status === f.status));
  const filtered = Boolean(fy || f.level || f.status);
  const achieved = sumMoney(appeals.filter((a) => a.status === "reduced" && a.savings && !a.exclude_from_totals).map((a) => a.savings!));
  return (
    <>
      <div className="tbar">
        <select className="in" style={{ width: 130, height: 30 }} aria-label="Filter by assessment year" value={fy} onChange={(e) => set({ ...f, year: e.target.value })}>
          <option value="">All years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select className="in" style={{ width: 170, height: 30 }} aria-label="Filter by level" value={f.level} onChange={(e) => set({ ...f, level: e.target.value })}>
          <option value="">All levels</option>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>
        <select className="in" style={{ width: 190, height: 30 }} aria-label="Filter by status" value={f.status} onChange={(e) => set({ ...f, status: e.target.value })}>
          <option value="">All statuses</option>
          {STATUS_ORDER.map((st) => <option key={st} value={st}>{APPEAL_STATUS_LABELS[st]}</option>)}
        </select>
        {filtered && <button type="button" className="lk" onClick={() => set({ year: "", level: "", status: "" })}>Clear filters</button>}
        <span className="meta">{filtered ? `${appeals.length} of ${all.length} appeals` : `${all.length} appeal${all.length === 1 ? "" : "s"}`} · achieved savings {formatMoney(achieved)}</span>
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
                <td><span className={`pill ${statusPill(a.status)}`}>{APPEAL_STATUS_LABELS[a.status]}</span>{a.exclude_from_totals && <span className="mn" style={{ display: "block" }}>Excluded</span>}{a.reference_update ? <span className="pill copper" style={{ marginTop: 3 }} title="A newer equalizer or rate is published. Open the values to apply it.">Newer rate</span> : null}{a.refund_status && <span className={`pill ${a.refund_status === "received" ? "ok" : "copper"}`} style={{ marginTop: 3 }}>{a.refund_status === "received" ? "Refund received" : "Awaiting refund"}</span>}</td>
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
            {appeals.length === 0 && <tr><td colSpan={15} className="meta" style={{ textAlign: "center", padding: 20 }}>{filtered ? "No appeals match these filters." : "No appeals yet."}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="meta" style={{ marginTop: 10 }}>
        Click a row to see and edit its values. FMV = AV ÷ level of assessment.
        {all.some((a) => a.calc_override) && " Rows marked \u201centered by hand\u201d keep their tax figures as entered (for example, imported from the prior software) and aren't recalculated."}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- decision letters
function LettersList({ letters, appeals, onOpen, compact }: { letters: PropertyLetter[]; appeals: AppealRow[]; onOpen: (id: number) => void; compact?: boolean }) {
  if (!letters.length) return compact ? null : <p className="meta letters-mini">No decision letters yet. Upload one with Upload decision letter above, or a stack on the Decisions page.</p>;
  const appealName = (id: number | null) => { const a = appeals.find((x) => x.id === id); return a ? `${a.assessment_year} ${LEVEL_LABELS[a.level]}` : "Not matched"; };
  return (
    <div className="letters-mini">
      <h3 className="subhead">Decision letters</h3>
      <div className="tw">
        <table className="compact">
          <thead><tr><th>Letter</th><th>Appeal</th><th>Status</th><th>Filed</th><th /></tr></thead>
          <tbody>
            {letters.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => onOpen(l.id)}>
                <td>{KIND_LABELS[l.kind]}<span className="mn" style={{ display: "block" }}>{l.letterDate ? formatDate(l.letterDate) : "No date"}</span></td>
                <td>{appealName(l.appealId)}</td>
                <td><span className={`pill ${l.status === "applied" ? "net" : l.status === "clean" ? "ok" : "warn"}`}>{l.status === "applied" ? `Applied ${l.appliedAt ? formatDate(l.appliedAt.slice(0, 10)) : ""}` : l.status === "clean" ? "Ready to apply" : "To review"}</span></td>
                <td>{l.filed ? <span className="pill ok">In Dropbox</span> : l.status === "applied" ? <span className="warn-text">Not filed yet</span> : "—"}</td>
                <td className="num"><button type="button" className="btn small ghost" onClick={(e) => { e.stopPropagation(); onOpen(l.id); }}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
              <option value="meeting">Meeting</option><option value="reminder">Reminder</option>
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
              {a.location && <span className="meta"> · {a.location}</span>}
              {showProperty && a.property_name && <span className="meta"> · {a.property_name}</span>}
            </span>
            <span className="tm">{a.assigned_name ?? ""}</span>
            <span className="tm num" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {a.due_on ? `${formatDate(a.due_on)}${a.start_time ? `, ${clock(a.start_time)}` : ""}` : a.status === "done" ? "Done" : "Open"}
              {!readOnly && <button className="btn small ghost" onClick={() => void remove(a)} aria-label={`Delete ${a.subject}`}>Delete</button>}
            </span>
          </div>
        ))}
        {activities.length === 0 && <p className="meta" style={{ padding: 16, margin: 0 }}>No activities yet.</p>}
      </div>
    </>
  );
}
