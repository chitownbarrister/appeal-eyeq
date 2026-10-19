import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../App";
import { useApi } from "../data";
import { formatDate, formatMoney } from "../format";
import { LEVEL_LABELS, SUBSTAGE_LABELS, type Level, type Substage } from "../../../shared/domain";

interface Summary { accounts: number; properties: number; activeProperties: number; appeals: number; savingsAchieved: string; savingsInPlay: string }
interface WindowRow { id: number; label: string; county: string; level: Level; levelShort: string; opens_on: string; closes_on: string; note: string | null; open: boolean; days_left: number; days_to_open: number; tagged: number; unfiled: number; tagged_ids: number[]; unfiled_ids: number[] }
interface WinGroup { key: string; decided: number; won: number; avgReduction: number | null }
interface ForecastItem { property_id: number; short: string; account: string; level: Level; kind: "decided" | "expected"; month: string; fee: string; likely: string | null; basis: string }
export interface DashboardData {
  today: string; cycle: number;
  kpis: { unfiled: number; savingsInPlay: string; readyToBill: string; forecastSixMonths: string; stalled: number };
  links: { unfiled: number[]; inPlay: number[]; achieved: number[]; readyToBill: number[]; forecastSixMonths: number[] };
  nextClose: WindowRow | null;
  windowWatch: WindowRow[];
  byAssetType: { type: string; count: number }[];
  byLevel: { level: Level; count: number }[];
  pipeline: { level: Level; cells: { substage: Substage; count: number; avgDays: number | null; ids: number[] }[]; total: number; ids: number[] }[];
  stalled: { property_id: number; short: string; days: number; level: Level }[];
  winRates: Record<"level" | "assetType" | "township" | "analyst", WinGroup[]>;
  forecast: {
    months: { month: string; decided: string; expected: string; ids: number[] }[]; later: string; readyToBill: string; nextSixMonths: string;
    likelySixMonths: string | null; winRateUsed: Record<"assessor" | "bor", number | null>; items: ForecastItem[];
    refundLevelOpen: number; noFeeSkipped: number; assumptions: Record<"assessor" | "bor", number>;
  };
  workload: { user_id: number; name: string; open: number; openIds: number[]; filedThisCycle: number; filedIds: number[]; hearings30: number; hearingIds: number[] }[];
  reassessment: { year: number; label: string; properties: number; ids: number[]; townships: string[] };
  retention: { active: number; carriedOver: number; carriedOverIds: number[]; atRisk: { property_id: number; short: string; reason: string }[] };
}

const monthName = (ym: string, long = false) =>
  new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", { month: long ? "long" : "short", year: long ? "numeric" : undefined });
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Properties filtered by grid filters, e.g. toProperties({ township: "Elk Grove", level: "bor" }). */
export const toProperties = (q: Record<string, string>) => `/properties?${new URLSearchParams(q)}`;
/** Exactly these properties, with a label the grid shows ("Showing Fees ready to bill"). */
export const toPropertySet = (ids: number[], label: string) => `/properties?${new URLSearchParams({ ids: ids.join(","), label, status: "all" })}`;

/** A number that opens the matching properties; plain text when there's nothing to show. */
function N({ to, children, title }: { to: string | null; children: React.ReactNode; title?: string }) {
  return to ? <Link className="nlink" to={to} title={title ?? "Show these properties"}>{children}</Link> : <>{children}</>;
}
const setOrNull = (ids: number[], label: string) => (ids.length ? toPropertySet(ids, label) : null);

const LEVEL_SHORT_TO_KEY: Record<string, Level> = { Assessor: "assessor", BOR: "bor", PTAB: "ptab", "Circuit Court": "circuit" };
const SUBSTAGE_COLUMNS: Substage[] = ["under_review", "fairly_assessed", "appeal_filed", "hearing_scheduled", "decision_analysis", "invoice_sent"];

export function Dashboard() {
  const { me } = useSession();
  const summary = useApi<Summary>("/firm/summary");
  const dash = useApi<DashboardData>("/firm/dashboard");
  const s = summary.data;
  const d = dash.data;
  const error = summary.error || dash.error;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Dashboard</div>
          <h1>{me.firm?.name}</h1>
          {s && (
            <div className="subtitle">
              {s.activeProperties} active properties · {s.accounts} clients · {s.appeals} appeals on file{d ? ` · ${d.cycle} assessment cycle` : ""}
            </div>
          )}
        </div>
        <div className="actions"><Link className="btn secondary" to="/calendar">Calendar</Link><Link className="btn secondary" to="/properties">Open properties</Link></div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {s && d && (
        <>
          <div className="kpis k5">
            <Link className="card kpi kpi-link" to="/properties?flag=unfiled">
              <span className="label">Unfiled, window open</span>
              <span className={`value${d.kpis.unfiled ? " bad" : ""}`}>{d.kpis.unfiled}</span>
              <span className="note">{d.nextClose ? `Next close: ${d.nextClose.label}, ${formatDate(d.nextClose.closes_on)}` : "No open windows"}</span>
            </Link>
            <KpiTile to={setOrNull(d.links.inPlay, "Estimated savings in play")} label="Estimated savings in play" value={formatMoney(s.savingsInPlay)} note="First-year, open appeals" />
            <KpiTile to={setOrNull(d.links.readyToBill, "Fees ready to bill")} label="Fees ready to bill" value={formatMoney(d.kpis.readyToBill)} note="Decisions in, not invoiced" />
            <KpiTile
              to={setOrNull(d.links.forecastSixMonths, "Fee forecast, next 6 months")} label="Fee forecast, next 6 months" value={formatMoney(d.kpis.forecastSixMonths)}
              note={d.forecast.likelySixMonths ? `${formatMoney(d.forecast.likelySixMonths)} at your win rates` : "At target values"}
            />
            <KpiTile to={setOrNull(d.links.achieved, "Savings achieved")} label="Savings achieved" value={formatMoney(s.savingsAchieved)} note="Reduced appeals, all years" good />
          </div>

          <div className="grid g-8-4">
            <WindowWatch rows={d.windowWatch} />
            <div className="stack">
              <section className="card">
                <div className="ch"><h3>Properties by asset type</h3><span className="meta">{d.byAssetType.reduce((a, x) => a + x.count, 0)} active</span></div>
                <Bars rows={d.byAssetType.map((x) => ({ label: x.type.charAt(0).toUpperCase() + x.type.slice(1), value: x.count, to: toProperties({ type: x.type }) }))} />
              </section>
              <section className="card">
                <div className="ch"><h3>Properties at each level</h3><span className="meta">Current appeal</span></div>
                <Bars rows={d.byLevel.map((x) => ({ label: LEVEL_LABELS[x.level], value: x.count, to: toProperties({ level: x.level }) }))} />
              </section>
            </div>
          </div>

          <Pipeline d={d} />

          <div className="grid g-7-5" style={{ marginTop: 16 }}>
            <Forecast d={d} />
            <WinRates d={d} />
          </div>

          <div className="grid g-3" style={{ marginTop: 16 }}>
            <section className="card">
              <div className="ch"><h3>Analyst workload</h3><span className="meta">Hearings: next 30 days</span></div>
              <div className="tw" style={{ marginTop: 8 }}>
                <table className="compact workload">
                  <thead><tr><th>Analyst</th><th className="num">Open</th><th className="num" title={`Appeals filed for the ${d.cycle} assessment year`}>Filed {d.cycle}</th><th className="num" title="Hearings in the next 30 days">Hearings</th></tr></thead>
                  <tbody>
                    {d.workload.map((w) => (
                      <tr key={w.user_id}>
                        <td><N to={toProperties({ analyst: w.name })} title={`${w.name}'s properties`}>{w.name}</N></td>
                        <td className="num"><N to={setOrNull(w.openIds, `${w.name}: open`)}>{w.open}</N></td>
                        <td className="num"><N to={setOrNull(w.filedIds, `${w.name}: filed in ${d.cycle}`)}>{w.filedThisCycle}</N></td>
                        <td className="num"><N to={setOrNull(w.hearingIds, `${w.name}: hearings in the next 30 days`)}>{w.hearings30}</N></td>
                      </tr>
                    ))}
                    {d.workload.length === 0 && <tr><td colSpan={4} className="meta">No analysts assigned yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <div className="ch"><h3>Reassessment exposure, {d.reassessment.year}</h3></div>
              <div className="cb">
                <p style={{ margin: "0 0 10px", fontSize: 13 }}>
                  <b className="num"><N to={setOrNull(d.reassessment.ids, `Reassessed in ${d.reassessment.year}`)}>{d.reassessment.properties}</N></b> active propert{d.reassessment.properties === 1 ? "y sits" : "ies sit"} in jurisdictions reassessed in {d.reassessment.year}
                  {d.reassessment.label ? `: ${d.reassessment.label}.` : "."}
                </p>
                <div className="chips">{d.reassessment.townships.map((t) => <Link key={t} className="pill pill-link" to={toProperties({ township: t })}>{t}</Link>)}</div>
                <p className="meta" style={{ margin: "10px 0 0" }}>New assessment notices mean new appeals. These are the townships to market in before notices go out.</p>
              </div>
            </section>
            <section className="card">
              <div className="ch"><h3>Retention</h3></div>
              <div className="cb">
                <dl className="retention">
                  <div><dt>Carried over</dt><dd><b className="num"><N to={setOrNull(d.retention.carriedOverIds, `Carried over from before ${d.cycle}`)}>{d.retention.carriedOver}</N> of {d.retention.active}</b> active properties were with the firm before {d.cycle}</dd></div>
                  <div>
                    <dt>At risk</dt>
                    <dd>
                      {d.retention.atRisk.length === 0 ? "None right now." : d.retention.atRisk.map((r, i) => (
                        <span key={r.property_id}>{i > 0 && ", "}<Link to={`/properties/${r.property_id}`} title={r.reason}>{r.short}</Link></span>
                      ))}
                      {d.retention.atRisk.length > 0 && <span className="meta" style={{ display: "block" }}>No change last cycle, or fairly assessed this cycle</span>}
                    </dd>
                  </div>
                  <div><dt>Agreements</dt><dd className="meta">Contingency agreements and their renewal dates arrive with the Files step.</dd></div>
                </dl>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}

function KpiTile({ to, label, value, note, good }: { to: string | null; label: string; value: string; note: string; good?: boolean }) {
  const body = <><span className="label">{label}</span><span className={`value${good ? " good" : ""}`}>{value}</span><span className="note">{note}</span></>;
  return to ? <Link className="card kpi kpi-link" to={to}>{body}</Link> : <div className="card kpi">{body}</div>;
}

function Bars({ rows }: { rows: { label: string; value: number; to?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} style={{ display: "contents" }}>
          <span>{r.to && r.value ? <Link className="nlink" to={r.to}>{r.label}</Link> : r.label}</span>
          <div className="bar" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 4 : 0 }} title={`${r.label}: ${r.value}`} />
          <span className="num" style={{ textAlign: "right" }}><N to={r.to && r.value ? r.to : null}>{r.value}</N></span>
        </div>
      ))}
    </div>
  );
}

function WindowWatch({ rows }: { rows: WindowRow[] }) {
  return (
    <section className="card">
      <div className="ch"><h3>Window watch</h3><span className="meta">Open and upcoming windows where you have properties</span></div>
      <div className="tw" style={{ marginTop: 8 }}>
        <table className="compact">
          <thead><tr><th>Township</th><th>Level</th><th>Window</th><th className="num">Days left</th><th className="num">Properties</th><th className="num">Not filed</th></tr></thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td><span className="mt"><Link className="nlink" to={toProperties(w.label.endsWith(" County") ? { county: w.county } : { county: w.county, township: w.label })}>{w.label}</Link></span><span className="mn">{w.county}{w.note ? ` · ${w.note}` : ""}</span></td>
                <td>{w.levelShort}</td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{formatDate(w.opens_on).replace(/, \d{4}$/, "")} to {formatDate(w.closes_on).replace(/, \d{4}$/, "")}</td>
                <td className="num">
                  {w.open
                    ? <span className={`pill ${w.days_left <= 7 ? "crit" : w.days_left <= 14 ? "warn" : "grey"}`}>{w.days_left === 0 ? "Today" : `${w.days_left} days`}</span>
                    : <span className="meta">Opens in {w.days_to_open} days</span>}
                </td>
                <td className="num"><N to={setOrNull(w.tagged_ids, `${w.label} ${w.levelShort} window: properties`)}>{w.tagged}</N></td>
                <td className="num">{w.unfiled ? <b style={{ color: w.open ? "var(--crit)" : "var(--navy)" }}><N to={setOrNull(w.unfiled_ids, `${w.label} ${w.levelShort} window: not filed`)}>{w.unfiled}</N></b> : "0"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 20 }}>No open or upcoming windows in your townships.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Pipeline({ d }: { d: DashboardData }) {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="ch"><h3>Pipeline by level and substage</h3><span className="meta">Current appeal per active property · count and average days in the substage</span></div>
      <div className="tw" style={{ marginTop: 8 }}>
        <table className="compact pipeline">
          <thead>
            <tr><th>Level</th>{SUBSTAGE_COLUMNS.map((s) => <th key={s} className="num">{SUBSTAGE_LABELS[s]}</th>)}<th className="num">Total</th></tr>
          </thead>
          <tbody>
            {d.pipeline.map((row) => (
              <tr key={row.level}>
                <td><span className="mt"><Link className="nlink" to={toProperties({ level: row.level })}>{LEVEL_LABELS[row.level]}</Link></span></td>
                {row.cells.map((c) => (
                  <td key={c.substage} className="num">
                    {c.count ? (
                      <>
                        <b style={{ color: c.substage === "decision_analysis" && (c.avgDays ?? 0) > 14 ? "var(--crit)" : "var(--navy)" }}>
                          <N to={toProperties({ level: row.level, substage: c.substage })}>{c.count}</N>
                        </b>
                        <span className="meta"> · {c.avgDays}d</span>
                      </>
                    ) : <span className="meta">·</span>}
                  </td>
                ))}
                <td className="num"><b><N to={setOrNull(row.ids, `${LEVEL_LABELS[row.level]} pipeline`)}>{row.total}</N></b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.stalled.length > 0 && (
        <div className="cb" style={{ borderTop: "1px solid var(--line-2)" }}>
          <div className="callout">
            <span>
              <b><N to={toProperties({ flag: "stalled" })}>{d.stalled.length} propert{d.stalled.length === 1 ? "y has" : "ies have"}</N> sat in Decision analysis more than 14 days: </b>
              {d.stalled.map((p, i) => <span key={p.property_id}>{i > 0 && ", "}<Link to={`/properties/${p.property_id}`}>{p.short}</Link> ({p.days} days)</span>)}.
              {" "}Invoice the reduction or push it to the next level.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function Forecast({ d }: { d: DashboardData }) {
  const f = d.forecast;
  const [showAll, setShowAll] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const navigate = useNavigate();
  const totals = f.months.map((m) => Number(m.decided) + Number(m.expected));
  const max = Math.max(1, ...totals);
  // Round the axis top to a tidy value so the gridlines read cleanly.
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const W = 560, H = 200, padL = 52, padR = 8, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / f.months.length;
  const barW = Math.min(46, slot * 0.56);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const items = showAll ? f.items : f.items.slice(0, 6);
  const money0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

  return (
    <section className="card">
      <div className="ch"><h3>When fees land</h3><span className="meta">Assessor and BOR fees by expected month · no invoices are created until a decision is processed</span></div>
      <div className="cb">
        <div className="legend">
          <span><i className="sw s1" />Decision in, not invoiced</span>
          <span><i className="sw s2" />Expected decisions, at target</span>
        </div>
        <div className="chart-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Fee forecast by month: ${f.months.map((m, i) => `${monthName(m.month, true)} ${money0(totals[i])}`).join(", ")}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="grid-line" />
                <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="axis">{money0(t)}</text>
              </g>
            ))}
            {f.months.map((m, i) => {
              const x = padL + slot * i + (slot - barW) / 2;
              const dec = Number(m.decided), exp = Number(m.expected);
              const hDec = (dec / top) * plotH, hExp = (exp / top) * plotH;
              const gap = dec && exp ? 2 : 0;
              return (
                <g
                  key={m.month} tabIndex={0} className={`col${m.ids.length ? " clickable" : ""}`}
                  role={m.ids.length ? "link" : undefined} aria-label={m.ids.length ? `${monthName(m.month, true)}: show these properties` : undefined}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  onClick={() => m.ids.length && navigate(toPropertySet(m.ids, `Fees expected in ${monthName(m.month, true)}`))}
                  onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && m.ids.length) { e.preventDefault(); navigate(toPropertySet(m.ids, `Fees expected in ${monthName(m.month, true)}`)); } }}
                >
                  <rect x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent" />
                  {dec > 0 && <rect x={x} y={padT + plotH - hDec} width={barW} height={hDec} className="s1" rx={hExp ? 0 : 3} />}
                  {exp > 0 && <rect x={x} y={padT + plotH - hDec - gap - hExp} width={barW} height={Math.max(0, hExp)} className="s2" rx={3} />}
                  {totals[i] > 0 && <text x={x + barW / 2} y={padT + plotH - hDec - hExp - gap - 6} textAnchor="middle" className="val">{money0(totals[i])}</text>}
                  <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="axis">{monthName(m.month)}</text>
                  <title>{`${monthName(m.month, true)}: ${formatMoney(m.decided)} decided, ${formatMoney(m.expected)} expected`}</title>
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div className="tip" style={{ left: `${((padL + slot * hover + slot / 2) / W) * 100}%` }} role="status">
              <b>{formatMoney(String(totals[hover].toFixed(2)))}</b>
              <span>{monthName(f.months[hover].month, true)}</span>
              {Number(f.months[hover].decided) > 0 && <span><i className="sw s1" />{formatMoney(f.months[hover].decided)} decision in</span>}
              {Number(f.months[hover].expected) > 0 && <span><i className="sw s2" />{formatMoney(f.months[hover].expected)} expected</span>}
              {f.months[hover].ids.length > 0 && <span className="meta">Click to see the properties</span>}
            </div>
          )}
        </div>
        <p className="meta" style={{ margin: "6px 0 12px" }}>
          Expected decisions land {f.assumptions.assessor} days (Assessor) and {f.assumptions.bor} days (Board of Review) after the township window closes.
          {f.likelySixMonths && ` At your win rates (Assessor ${f.winRateUsed.assessor === null ? "n/a" : pct(f.winRateUsed.assessor)}, BOR ${f.winRateUsed.bor === null ? "n/a" : pct(f.winRateUsed.bor)}) the next six months come to ${formatMoney(f.likelySixMonths)}.`}
          {Number(f.later) > 0 && ` ${formatMoney(f.later)} more lands after that.`}
          {f.refundLevelOpen > 0 && ` ${f.refundLevelOpen} open PTAB or Circuit Court appeal${f.refundLevelOpen === 1 ? " isn't" : "s aren't"} included: those fees are set when the refund check arrives.`}
          {f.noFeeSkipped > 0 && ` ${f.noFeeSkipped} no-fee appeal${f.noFeeSkipped === 1 ? " is" : "s are"} left out.`}
          {" "}Billed and unpaid invoices and refunds outstanding arrive with billing.
        </p>
        <h4 className="subhead">Money detail</h4>
        <div className="tw">
          <table className="compact">
            <tbody>
              {items.map((i) => (
                <tr key={`${i.property_id}-${i.level}-${i.kind}`}>
                  <td style={{ whiteSpace: "nowrap" }}><span className={`pill ${i.kind === "decided" ? "net" : "copper"}`}>{i.kind === "decided" ? "Ready to bill" : monthName(i.month, true)}</span></td>
                  <td><Link className="mt" to={`/properties/${i.property_id}`}>{i.short}</Link><span className="mn">{i.account} · {LEVEL_LABELS[i.level]}</span></td>
                  <td className="num">{formatMoney(i.fee)}</td>
                </tr>
              ))}
              {f.items.length === 0 && <tr><td className="meta">Nothing to forecast yet. Fees appear here once appeals have estimated savings.</td></tr>}
            </tbody>
          </table>
        </div>
        {f.items.length > 6 && <button className="lk" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${f.items.length}`}</button>}
      </div>
    </section>
  );
}

function WinRates({ d }: { d: DashboardData }) {
  const [allTwp, setAllTwp] = useState(false);
  const block = (title: string, rows: WinGroup[], link: (key: string) => string | null, extra?: JSX.Element) => (
    <div>
      <h4 className="subhead">{title}</h4>
      <table className="compact winrate">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td><N to={link(r.key)} title={`Properties: ${r.key}`}>{r.key}</N></td>
              <td className="num" title={`${r.won} of ${r.decided} decided appeals reduced`}>{pct(r.won / r.decided)}</td>
              <td className="num meta">{r.avgReduction !== null ? `${r.avgReduction.toFixed(1)}% avg` : "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="meta">No decided appeals yet.</td></tr>}
        </tbody>
      </table>
      {extra}
    </div>
  );
  const twp = d.winRates.township;
  return (
    <section className="card">
      <div className="ch"><h3>Win rate and average reduction</h3><span className="meta">Decided appeals, all years · reduction in assessed value</span></div>
      <div className="cb">
        <div className="grid g-2" style={{ gap: 18 }}>
          {block("By level", d.winRates.level, (k) => { const l = (Object.keys(LEVEL_SHORT_TO_KEY) as string[]).includes(k) ? LEVEL_SHORT_TO_KEY[k] : null; return l ? toProperties({ level: l }) : null; })}
          {block("By asset type", d.winRates.assetType, (k) => toProperties({ type: k.toLowerCase() }))}
          {block("By township", allTwp ? twp : twp.slice(0, 5), (k) => (k === "Not set" ? null : toProperties({ township: k })), twp.length > 5 ? <button className="lk" style={{ marginTop: 6 }} onClick={() => setAllTwp(!allTwp)}>{allTwp ? "Show top 5" : `Show all ${twp.length} townships`}</button> : undefined)}
          {block("By analyst", d.winRates.analyst, (k) => (k === "Not set" ? null : toProperties({ analyst: k })))}
        </div>
      </div>
    </section>
  );
}
