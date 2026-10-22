// The property's Evaluation tab (Delivery 10b): the facts, the current assessment year and the two
// before it side by side, each PIN's values, a full history overlay with every year (scrolls left
// and right with the labels fixed), and the Excel export in the Evaluation Worksheet 3 look.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "../data";
import { formatDate, formatMoney, formatValue } from "../format";
import { ASSET_TYPE_LABELS, LEVEL_LABELS, type AssetType, type Level } from "../../../shared/domain";
import { pct } from "./FeeFigures";

interface EvalPin { parcelId: number; pin: string; class: string | null; land: string | null; impr: string | null; total: string | null }
export interface EvalYear {
  assessmentYear: number; taxYear: number; levelReached: Level; decided: boolean; status: string;
  levels: { level: Level; status: string; origAv: string | null; resolvedAv: string | null; reduction: string | null }[];
  equalizer: string | null; ratePercent: string | null; equalizedRatePercent: string | null; taxFromRates: boolean;
  avIn: string | null; land: string | null; impr: string | null; total: string | null; levelOfAssessment: string | null;
  fmv: string | null; fmvPerUnit: string | null; taxBefore: string | null; tax: string | null; taxPerUnit: string | null;
  savings: string | null; feePercent: string; feeBasis: string; noFee: boolean; fee: string | null; invoiced: string | null;
  coCounselShare: string | null; netFee: string | null; pins: EvalPin[];
}
interface Evaluation {
  property: {
    id: number; client: string; address: string; city: string | null; state: string; county: string; township: string | null;
    assetType: string; assetGroup: string; units: number | null; buildingSqft: number | null; rentableSqft: number | null; landSqft: number | null;
    landSqftFromAcreage: boolean; landToBuilding: string | null; yearBuilt: number | null; age: number | null; purchasePrice: string | null;
    purchaseDate: string | null; taxCode: string | null; levelOfAssessment: string | null;
    coCounsel: { firm: string; role: "relationship" | "handling"; percent: string | null; bills: "us" | "co_counsel" | null } | null;
  };
  pins: { parcelId: number; pin: string; class: string | null; isPrimary: boolean }[];
  years: EvalYear[];
  recent: number[];
}

const dash = "—";
const val = (v: string | null) => (v === null ? dash : formatValue(v));
const money = (v: string | null) => (v === null ? dash : formatMoney(v));
const int = (v: number | null) => (v === null ? dash : v.toLocaleString("en-US"));
const STATUS: Record<string, string> = { reduced: "Reduced", no_change: "No change", increased: "Increased", waiting_decision: "Waiting", open: "Open", withdrawn: "Withdrawn", dismissed: "Dismissed" };
const SHORT: Record<Level, string> = { assessor: "Assessor", bor: "BOR", ptab: "PTAB", circuit: "Circuit" };

type Row = { key: string; label: string; cell: (y: EvalYear) => ReactNode; strong?: boolean; section?: string; hint?: string };

/** The rows shown for each year, in the worksheet's order. */
function rowsFor(coCounsel: Evaluation["property"]["coCounsel"], history: boolean): Row[] {
  const rows: Row[] = [
    { key: "tax-year", label: "Tax year", cell: (y) => y.taxYear },
    { key: "level", label: "Furthest level decided", cell: (y) => `${LEVEL_LABELS[y.levelReached]} · ${STATUS[y.status] ?? y.status}` },
  ];
  if (history) {
    rows.push({ key: "ladder", label: "Each level", cell: (y) => (
      <span className="ev-ladder">{y.levels.map((l, i) => <span key={i}>{SHORT[l.level]}: {STATUS[l.status] ?? l.status}{l.reduction && Number(l.reduction) > 0 ? `, ${formatValue(l.reduction)} off` : ""}</span>)}</span>
    ) });
  }
  rows.push(
    { key: "eq", section: "Rate", label: "Equalizer", cell: (y) => y.equalizer ?? dash },
    { key: "rate", label: "Tax rate", cell: (y) => (y.ratePercent ? `${Number(y.ratePercent).toFixed(3)}%` : dash) },
    { key: "eqrate", label: "Equalized tax rate", cell: (y) => (y.equalizedRatePercent ? `${Number(y.equalizedRatePercent).toFixed(3)}%` : dash), hint: "Equalizer × rate" },
    { key: "land", section: "Value", label: "Land AV", cell: (y) => val(y.land) },
    { key: "impr", label: "Building AV", cell: (y) => val(y.impr) },
    { key: "total", label: "Total AV", cell: (y) => val(y.total), strong: true },
    { key: "loa", label: "Level of assessment", cell: (y) => (y.levelOfAssessment ? pct(y.levelOfAssessment) : dash) },
    { key: "fmv", label: "Fair market value", cell: (y) => val(y.fmv), strong: true, hint: "AV ÷ level of assessment" },
    { key: "fmvunit", label: "FMV per unit", cell: (y) => val(y.fmvPerUnit) },
    { key: "avin", section: "Tax", label: "AV going into the first appeal", cell: (y) => val(y.avIn) },
    { key: "before", label: "Tax before the appeal", cell: (y) => money(y.taxBefore) },
    { key: "tax", label: "Estimated tax", cell: (y) => <>{money(y.tax)}{!y.taxFromRates && y.tax !== null && <span className="mn" style={{ display: "block" }}>as entered</span>}</>, strong: true, hint: "AV × equalizer × rate, or the amount entered on the appeal when the year has no rate" },
    { key: "taxunit", label: "Tax per unit", cell: (y) => money(y.taxPerUnit) },
    { key: "savings", label: "Tax savings", cell: (y) => (y.savings === null ? (y.decided ? dash : "Pending") : money(y.savings)), strong: true },
    { key: "feepct", section: "Fee", label: "Fee percent", cell: (y) => (y.noFee ? "No fee" : `${pct(y.feePercent)} of ${y.feeBasis === "refund" ? "the refund" : "first-year savings"}`) },
    { key: "fee", label: "Fee on the savings", cell: (y) => money(y.fee) },
    { key: "invoiced", label: "Invoiced or taken from a refund", cell: (y) => money(y.invoiced) },
  );
  if (coCounsel) {
    rows.push(
      { key: "cc", label: `${coCounsel.firm}'s share${coCounsel.percent ? ` (${pct(coCounsel.percent)})` : ""}`, cell: (y) => money(y.coCounselShare) },
      { key: "net", label: "Our net fee", cell: (y) => money(y.netFee), strong: true },
    );
  }
  return rows;
}

function YearTable({ years, coCounsel, history, label }: { years: EvalYear[]; coCounsel: Evaluation["property"]["coCounsel"]; history?: boolean; label: string }) {
  const rows = rowsFor(coCounsel, Boolean(history));
  return (
    <table className={`compact ev-table${history ? " ev-history" : ""}`} aria-label={label}>
      <thead>
        <tr><th scope="col">Assessment year</th>{years.map((y) => <th key={y.assessmentYear} scope="col" className="num">{y.assessmentYear}{y.decided ? "" : " (pending)"}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={`${r.strong ? "strong" : ""}${r.section ? " sec" : ""}`}>
            <th scope="row" title={r.hint}>{r.section && <span className="ev-sec">{r.section}</span>}{r.label}</th>
            {years.map((y) => <td key={y.assessmentYear} className="num">{r.cell(y)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PinTable({ ev, years }: { ev: Evaluation; years: EvalYear[] }) {
  const sum = (y: EvalYear, k: "land" | "impr" | "total") => {
    const xs = y.pins.map((p) => p[k]).filter((v): v is string => v !== null);
    return xs.length ? String(xs.reduce((a, v) => a + Number(v), 0)) : null;
  };
  return (
    <table className="compact ev-table ev-pins" aria-label="PIN detail">
      <thead>
        <tr><th rowSpan={2} scope="col">PIN</th><th rowSpan={2} scope="col">Class</th>{years.map((y) => <th key={y.assessmentYear} colSpan={3} scope="colgroup" className="num ygrp">{y.assessmentYear}</th>)}</tr>
        <tr>{years.map((y) => ["Land", "Building", "Total"].map((t) => <th key={`${y.assessmentYear}${t}`} scope="col" className="num">{t}</th>))}</tr>
      </thead>
      <tbody>
        {ev.pins.map((p) => (
          <tr key={p.parcelId}>
            <th scope="row" className="mono">{p.pin}</th>
            <td>{p.class ?? dash}</td>
            {years.map((y) => {
              const v = y.pins.find((x) => x.parcelId === p.parcelId);
              return [<td key="l" className="num ygrp">{val(v?.land ?? null)}</td>, <td key="i" className="num">{val(v?.impr ?? null)}</td>, <td key="t" className="num">{val(v?.total ?? null)}</td>];
            })}
          </tr>
        ))}
        {ev.pins.length > 1 && (
          <tr className="strong">
            <th scope="row">Total</th><td />
            {years.map((y) => [<td key="l" className="num ygrp">{val(sum(y, "land"))}</td>, <td key="i" className="num">{val(sum(y, "impr"))}</td>, <td key="t" className="num">{val(sum(y, "total"))}</td>])}
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Facts({ ev }: { ev: Evaluation }) {
  const p = ev.property;
  const type = ASSET_TYPE_LABELS[p.assetType as AssetType] ?? p.assetType;
  const items: [string, ReactNode][] = [
    ["Client", p.client],
    ["County and township", `${p.county}${p.township ? ` · ${p.township}` : ""}`],
    ["Class", ev.pins.map((x) => x.class).filter(Boolean).join(", ") || "Not set"],
    ["Asset type", p.assetGroup !== p.assetType ? `${type} · ${ASSET_TYPE_LABELS[p.assetGroup as AssetType]}` : type],
    ["Units", int(p.units)],
    ["Building SF", int(p.buildingSqft)],
    ["Rentable SF", int(p.rentableSqft)],
    ["Land SF", <>{int(p.landSqft)}{p.landSqftFromAcreage && <span className="mn"> from acreage</span>}</>],
    ["Land to building", p.landToBuilding ? `${p.landToBuilding} : 1` : dash],
    ["Year built", p.yearBuilt ? `${p.yearBuilt}${p.age !== null ? ` · ${p.age} years` : ""}` : dash],
    ["Sale", p.purchasePrice ? `${formatValue(p.purchasePrice)}${p.purchaseDate ? `, ${formatDate(p.purchaseDate)}` : ""}` : dash],
    ["Co-counsel", p.coCounsel ? `${p.coCounsel.firm} · we're the ${p.coCounsel.role === "relationship" ? "relationship" : "handling"} firm${p.coCounsel.percent ? ` · their share ${pct(p.coCounsel.percent)}` : ""}${p.coCounsel.bills ? ` · ${p.coCounsel.bills === "us" ? "we bill" : "they bill"}` : ""}` : "None"],
  ];
  return <dl className="ev-facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

function HistoryOverlay({ ev, onClose }: { ev: Evaluation; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    box.current?.focus();
    // Open at the newest years: the right end of the scroll.
    const s = box.current?.querySelector(".ev-scroll");
    if (s) s.scrollLeft = s.scrollWidth;
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="ev-overlay" role="dialog" aria-modal="true" aria-label="Full history" tabIndex={-1} ref={box}>
        <div className="ev-oh">
          <div>
            <div className="eyebrow">Evaluation · full history</div>
            <h2>{ev.property.address}{ev.property.city ? `, ${ev.property.city}` : ""}</h2>
            <div className="meta">{ev.years.length} assessment year{ev.years.length === 1 ? "" : "s"}, {ev.years[0]?.assessmentYear} to {ev.years[ev.years.length - 1]?.assessmentYear}. Scroll sideways for earlier years.</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <a className="btn small secondary" href={`/api/firm/properties/${ev.property.id}/evaluation.xlsx?years=all`}>Download Excel (all years)</a>
            <button type="button" className="btn small ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="ev-scroll"><YearTable years={ev.years} coCounsel={ev.property.coCounsel} history label="Every assessment year" /></div>
        <h3 style={{ margin: "18px 0 8px" }}>PIN detail</h3>
        <div className="ev-scroll"><PinTable ev={ev} years={ev.years} /></div>
      </div>
    </>
  );
}

export function EvaluationTab({ propertyId }: { propertyId: number }) {
  const { data: ev, error } = useApi<Evaluation>(`/firm/properties/${propertyId}/evaluation`);
  const [history, setHistory] = useState(false);
  if (error) return <div className="error" role="alert">{error}</div>;
  if (!ev) return null;
  const recent = ev.years.filter((y) => ev.recent.includes(y.assessmentYear));
  return (
    <div className="ev">
      <div className="ev-bar">
        <p className="meta" style={{ margin: 0 }}>
          The current assessment year and the two before it, from the appeals, values and rates on this property. Each year shows the furthest level decided.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ev.years.length > 0 && <button type="button" className="btn small secondary" onClick={() => setHistory(true)}>Full history{ev.years.length > 3 ? ` (${ev.years.length} years)` : ""}</button>}
          {ev.years.length > 0 && <a className="btn small" href={`/api/firm/properties/${propertyId}/evaluation.xlsx`}>Download Excel</a>}
        </div>
      </div>
      <section className="card pad"><h3 style={{ marginTop: 0 }}>Property</h3><Facts ev={ev} /></section>
      {ev.years.length === 0 ? (
        <p className="meta">No appeals on this property yet, so there's nothing to evaluate. Start an appeal and its values show here.</p>
      ) : (
        <>
          <section className="card"><div className="ev-scroll"><YearTable years={recent} coCounsel={ev.property.coCounsel} label="Summary by assessment year" /></div></section>
          <section className="card pad">
            <h3 style={{ marginTop: 0 }}>PIN detail</h3>
            <div className="ev-scroll"><PinTable ev={ev} years={recent} /></div>
          </section>
        </>
      )}
      {history && <HistoryOverlay ev={ev} onClose={() => setHistory(false)} />}
    </div>
  );
}
