import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "../App";
import { useApi } from "../data";
import { formatDate, formatMoney, titleCase } from "../format";
import { LEVELS, LEVEL_LABELS, SUBSTAGE_LABELS, LEVEL_SUBSTAGES, type Level, type Substage } from "../../../shared/domain";
import { PropertySheet } from "../components/forms";
import { MatterName } from "../components/MatterName";
import type { DashboardData } from "./Dashboard";

export interface PropertyRow {
  id: number; title: string; name: string; address1: string | null; city: string | null; state: string; status: string;
  asset_type: string; use_type: string | null; county: string; township: string | null; account_id: number; account_name: string;
  attorney_user_id: number | null; attorney_name: string | null; analyst_user_id: number | null; analyst_name: string | null;
  pin: string | null; level: Level | null; substage: Substage | null; days_in_substage: number | null; assessment_year: number | null;
  estimated_savings: string | null; next_action: string | null; next_action_on: string | null; no_fee: boolean;
  unfiled_window_open: boolean; window_closes_on: string | null; next_title: string | null; next_on: string | null; next_kind: string | null;
}

type SortKey = "title" | "client" | "county" | "township" | "type" | "level" | "analyst" | "attorney" | "est" | "next";
const FILTERS = ["county", "township", "level", "substage", "analyst", "attorney", "type", "client", "status", "flag"] as const;
type FilterKey = (typeof FILTERS)[number];

const EMPTY_FILTERS: Record<FilterKey, string> = { county: "", township: "", level: "", substage: "", analyst: "", attorney: "", type: "", client: "", status: "active", flag: "" };
const SORT_KEYS: SortKey[] = ["title", "client", "county", "township", "type", "level", "analyst", "attorney", "est", "next"];

/**
 * Filters live in the address bar (/properties?township=Elk%20Grove&level=bor), so any number on the
 * dashboard can link straight to the matching properties, and Back returns to the same view.
 * Status defaults to Active; status=all shows every status. ids=1,2,3 (with an optional label) shows an exact set.
 */
function filtersFrom(params: URLSearchParams): Record<FilterKey, string> {
  const f = { ...EMPTY_FILTERS };
  for (const k of FILTERS) {
    const v = params.get(k);
    if (v !== null) f[k] = k === "status" && v === "all" ? "" : v;
  }
  return f;
}
const isStalled = (p: PropertyRow) => p.substage === "decision_analysis" && (p.days_in_substage ?? 0) > 14;

const levelRank = (r: PropertyRow) => (r.level ? LEVELS.indexOf(r.level) * 10 + LEVEL_SUBSTAGES[r.level].indexOf(r.substage as Substage) : 99);

export function Properties() {
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, error, reload } = useApi<{ properties: PropertyRow[] }>("/firm/properties");
  const accounts = useApi<{ accounts: { id: number; name: string }[] }>("/firm/accounts");
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFrom(params), [params]);
  const idSet = useMemo(() => {
    const raw = params.get("ids");
    return raw ? new Set(raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0)) : null;
  }, [params]);
  const idLabel = params.get("label");
  function setFilters(f: Record<FilterKey, string>, keepIds = true) {
    const next = new URLSearchParams();
    for (const k of FILTERS) {
      if (k === "status") { if (f.status !== "active") next.set("status", f.status || "all"); }
      else if (f[k]) next.set(k, f[k]);
    }
    if (keepIds && params.get("ids")) { next.set("ids", params.get("ids")!); if (idLabel) next.set("label", idLabel); }
    setParams(next, { replace: true });
  }
  const dash = useApi<DashboardData>("/firm/dashboard");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(() => {
    const k = params.get("sort") as SortKey | null;
    return k && SORT_KEYS.includes(k) ? { key: k, dir: params.get("dir") === "desc" ? -1 : 1 } : { key: "title", dir: 1 };
  });
  const [creating, setCreating] = useState(false);
  const all = useMemo(() => data?.properties ?? [], [data]);

  const options = useMemo(() => {
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort();
    return {
      county: uniq(all.map((p) => p.county)).map((v) => [v, v]),
      township: uniq(all.filter((p) => !filters.county || p.county === filters.county).map((p) => p.township)).map((v) => [v, v]),
      level: LEVELS.map((l) => [l, LEVEL_LABELS[l]]),
      substage: (filters.level ? LEVEL_SUBSTAGES[filters.level as Level] : (Object.keys(SUBSTAGE_LABELS) as Substage[]).filter((x) => x !== "closed" && x !== "pushed_next_level")).map((x) => [x, SUBSTAGE_LABELS[x]]),
      analyst: uniq(all.map((p) => p.analyst_name)).map((v) => [v, v]),
      attorney: uniq(all.map((p) => p.attorney_name)).map((v) => [v, v]),
      type: ["residential", "commercial", "industrial"].map((v) => [v, titleCase(v)]),
      client: uniq(all.map((p) => p.account_name)).map((v) => [v, v]),
      status: ["active", "closed", "inactive", "sold"].map((v) => [v, titleCase(v)]),
      flag: [["unfiled", "Unfiled, window open"], ["stalled", "Stalled in Decision analysis"]],
    } as Record<FilterKey, string[][]>;
  }, [all, filters.county, filters.level]);

  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    const digits = t.replace(/\D/g, "");
    const out = all.filter((p) =>
      (!filters.county || p.county === filters.county) &&
      (!filters.township || p.township === filters.township) &&
      (!filters.level || p.level === filters.level) &&
      (!filters.substage || p.substage === filters.substage) &&
      (!idSet || idSet.has(p.id)) &&
      (!filters.analyst || p.analyst_name === filters.analyst) &&
      (!filters.attorney || p.attorney_name === filters.attorney) &&
      (!filters.type || p.asset_type === filters.type) &&
      (!filters.client || p.account_name === filters.client) &&
      (!filters.status || p.status === filters.status) &&
      (!filters.flag || (filters.flag === "unfiled" ? p.unfiled_window_open : isStalled(p))) &&
      (!t || p.title.toLowerCase().includes(t) || p.account_name.toLowerCase().includes(t) || (digits.length >= 4 && (p.pin ?? "").replace(/\D/g, "").includes(digits))),
    );
    const key: Record<SortKey, (p: PropertyRow) => string | number> = {
      title: (p) => p.title.toLowerCase(), client: (p) => p.account_name.toLowerCase(), county: (p) => p.county, township: (p) => p.township ?? "",
      type: (p) => p.asset_type, level: levelRank, analyst: (p) => p.analyst_name ?? "", attorney: (p) => p.attorney_name ?? "",
      est: (p) => Number(p.estimated_savings ?? -1), next: (p) => p.next_on ?? "9999",
    };
    return [...out].sort((a, b) => {
      const x = key[sort.key](a), y = key[sort.key](b);
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
    });
  }, [all, filters, text, sort, idSet]);

  const th = (k: SortKey, label: string, right = false) => (
    <th
      scope="col"
      role="columnheader"
      className={`sortable${right ? " num" : ""}`}
      aria-sort={sort.key === k ? (sort.dir > 0 ? "ascending" : "descending") : "none"}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : 1 }))}
    >
      {label}{sort.key === k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
    </th>
  );

  function exportCsv() {
    const header = ["Matter", "PIN", "Client", "County", "Township", "Type", "Use", "Level", "Substage", "Unfiled, window open", "Analyst", "Attorney", "Est. savings", "Next", "Next date"];
    const lines = rows.map((p) => [
      p.title, p.pin ?? "", p.account_name, p.county, p.township ?? "", titleCase(p.asset_type), p.use_type ?? "",
      p.level ? LEVEL_LABELS[p.level] : "", p.substage ? SUBSTAGE_LABELS[p.substage] : "", p.unfiled_window_open ? "Yes" : "",
      p.analyst_name ?? "", p.attorney_name ?? "", p.estimated_savings ?? "", p.next_title ?? "", p.next_on ?? "",
    ]);
    const csv = [header, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "appeal-eyeq-properties.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const clients = new Set(all.map((p) => p.account_id)).size;
  const filtered = FILTERS.some((k) => (k === "status" ? filters.status !== "active" : filters[k])) || text || idSet;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Matters</div>
          <h1>Properties</h1>
          <div className="subtitle">{all.length} properties · {clients} clients · Cook and the collar counties</div>
        </div>
        <div className="actions">
          <button className="btn secondary" onClick={exportCsv} disabled={!rows.length}>Export list</button>
          {can("properties.edit") && <button className="btn" onClick={() => setCreating(true)}>+ New property</button>}
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {dash.data && (
        <div className="card txstrip" aria-label="Summary">
          <button onClick={() => setFilters({ ...filters, flag: "unfiled" })}>
            <b className={`num${dash.data.kpis.unfiled ? " bad" : ""}`}>{dash.data.kpis.unfiled}</b> unfiled with the window open
          </button>
          {dash.data.nextClose && (
            <button onClick={() => setFilters({ ...EMPTY_FILTERS, county: dash.data!.nextClose!.county, township: dash.data!.nextClose!.label, level: dash.data!.nextClose!.level }, false)}>
              Next close: <b>{dash.data.nextClose.label} {dash.data.nextClose.levelShort}</b>, {formatDate(dash.data.nextClose.closes_on)} ({dash.data.nextClose.days_left} day{dash.data.nextClose.days_left === 1 ? "" : "s"})
            </button>
          )}
          {dash.data.kpis.stalled > 0 && (
            <button onClick={() => setFilters({ ...filters, flag: "stalled" })}><b className="num bad">{dash.data.kpis.stalled}</b> stalled in Decision analysis</button>
          )}
          <span><b className="num">{formatMoney(dash.data.kpis.savingsInPlay)}</b> in play</span>
          <Link to="/dashboard" style={{ marginLeft: "auto" }}>Dashboard</Link>
        </div>
      )}
      <section className="card">
        <div className="ch">
          <h3>Property matters <span className="meta">{rows.length} of {all.length}</span></h3>
          <span className="meta">Click a column to sort</span>
        </div>
        <div className="cb" style={{ paddingBottom: 8 }}>
          {idSet && (
            <div className="idchip" role="status">
              Showing {idLabel ? <b>{idLabel}</b> : "a selected set"} ({idSet.size} propert{idSet.size === 1 ? "y" : "ies"})
              <button className="lk" onClick={() => setFilters(filters, false)}>Show all properties</button>
            </div>
          )}
          <div className="mselects">
            <label>Search
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Address, PIN, client" aria-label="Filter properties" />
            </label>
            {FILTERS.map((k) => (
              <label key={k}>{{ county: "County", township: "Township", level: "Appeal level", substage: "Substage", analyst: "Analyst", attorney: "Attorney", type: "Asset type", client: "Client", status: "Status", flag: "Needs attention" }[k]}
                <select value={filters[k]} onChange={(e) => setFilters({ ...filters, [k]: e.target.value, ...(k === "county" ? { township: "" } : {}), ...(k === "level" ? { substage: "" } : {}) })}>
                  <option value="">All</option>
                  {options[k].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            ))}
          </div>
          {filtered && (
            <button className="lk" style={{ marginTop: 8 }} onClick={() => { setFilters(EMPTY_FILTERS, false); setText(""); }}>
              Clear filters
            </button>
          )}
        </div>
        <div className="tw">
          <table className="grid-table">
            <thead>
              <tr>
                {th("title", "Matter")}{th("client", "Client")}{th("county", "County")}{th("township", "Township")}{th("type", "Type")}
                {th("level", "Level · substage")}{th("analyst", "Analyst")}{th("attorney", "Attorney")}{th("est", "Est. savings", true)}{th("next", "Next")}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/properties/${p.id}`)}>
                  <td style={{ minWidth: 210 }}>
                    <MatterName title={p.title} to={`/properties/${p.id}`} onClick={(e) => e.stopPropagation()} />
                    <span className="mn">{p.use_type}{p.no_fee ? " · No fee" : ""}</span>
                  </td>
                  <td style={{ minWidth: 120 }}>
                    <Link to={`/accounts/${p.account_id}`} onClick={(e) => e.stopPropagation()} style={{ textDecoration: "none" }}>{p.account_name}</Link>
                  </td>
                  <td>{p.county}</td>
                  <td>{p.township}</td>
                  <td>{titleCase(p.asset_type)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {p.level ? (
                      <>
                        <b style={{ fontWeight: 500, color: "var(--navy)" }}>{LEVEL_LABELS[p.level]}</b>
                        <div className="rail-l">
                          {p.substage && SUBSTAGE_LABELS[p.substage]}
                          {isStalled(p) && <> <span className="pill crit" title="Stalled in Decision analysis">{p.days_in_substage}d</span></>}
                          {p.unfiled_window_open && <> <span className="pill copper" title={`Not filed yet; the window closes ${formatDate(p.window_closes_on)}`}>Unfiled</span></>}
                        </div>
                      </>
                    ) : <span className="meta">No appeal yet</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{p.analyst_name}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{p.attorney_name}</td>
                  <td className="num">{p.estimated_savings && Number(p.estimated_savings) > 0 ? formatMoney(p.estimated_savings) : "—"}</td>
                  <td style={{ minWidth: 130 }}>
                    {p.next_on ? <span className="num" style={{ whiteSpace: "nowrap", display: "block" }}>{formatDate(p.next_on)}</span> : null}
                    {p.next_title ? <span className="mn" style={{ display: "block" }}>{p.next_title}</span> : !p.next_on && "—"}
                  </td>
                </tr>
              ))}
              {data && rows.length === 0 && (
                <tr><td colSpan={10} className="meta" style={{ padding: 24, textAlign: "center" }}>
                  {all.length ? "No properties match these filters." : "No properties yet. Add your first with New property."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {creating && (
        <PropertySheet
          accounts={accounts.data?.accounts ?? []}
          onClose={() => setCreating(false)}
          onSaved={(id) => { setCreating(false); void reload(); navigate(`/properties/${id}`); }}
        />
      )}
    </>
  );
}
