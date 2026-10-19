import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../data";
import { clock } from "../components/Deadlines";
import { splitMatterTitle } from "../format";

type EventType = "window" | "hearing" | "evidence" | "filing" | "other" | "task";
const TYPES: { id: EventType; label: string }[] = [
  { id: "window", label: "Filing windows" },
  { id: "hearing", label: "Hearings" },
  { id: "evidence", label: "Evidence due" },
  { id: "filing", label: "Filing deadlines" },
  { id: "other", label: "Other deadlines" },
  { id: "task", label: "Tasks" },
];

interface WindowRow { id: number; label: string; level: string; assessment_year: number; opens_on: string; closes_on: string; note: string | null; properties: number; unfiled: number; mine: boolean }
interface DeadlineRow { id: number; property_id: number; kind: "hearing" | "evidence" | "filing" | "other"; title: string; due_on: string; due_time: string | null; location: string | null; status: "open" | "done"; property_title: string; property_short: string; attorney_name: string | null; analyst_name: string | null; mine: boolean }
interface TaskRow { id: number; property_id: number | null; account_id: number | null; subject: string; due_on: string; status: "open" | "done"; assigned_name: string | null; property_title: string | null; property_short: string | null; account_name: string | null; mine: boolean }
interface CalendarData { today: string; windows: WindowRow[]; deadlines: DeadlineRow[]; tasks: TaskRow[] }

interface CalEvent {
  key: string; type: EventType; date: string; time: string | null; title: string; sub: string; who: string;
  href: string | null; done: boolean; mine: boolean;
}

/** "1440 Brookdale Rd., Naperville (Lisle) · PIN 07-26-110-009" */
const pinLast = (title: string) => { const t = splitMatterTitle(title); return t.pin ? `${t.place} · PIN ${t.pin}` : t.place; };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

function loadPrefs(): { view: "month" | "list"; hidden: EventType[]; mine: boolean } {
  try {
    const raw = window.localStorage.getItem("aeq.calendar");
    if (raw) return { view: "month", hidden: [], mine: false, ...JSON.parse(raw) };
  } catch { /* storage can be unavailable; defaults are fine */ }
  return { view: "month", hidden: [], mine: false };
}
function savePrefs(p: { view: string; hidden: EventType[]; mine: boolean }) {
  try { window.localStorage.setItem("aeq.calendar", JSON.stringify(p)); } catch { /* ignore */ }
}

export function Calendar() {
  const prefs = useMemo(loadPrefs, []);
  const [month, setMonth] = useState<Date | null>(null);
  const [view, setView] = useState<"month" | "list">(prefs.view);
  const [hidden, setHidden] = useState<Set<EventType>>(new Set(prefs.hidden));
  const [mine, setMine] = useState(prefs.mine);
  const [allWindows, setAllWindows] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // The month on screen; until the server says what "today" is, use the browser's date.
  const shown = month ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const gridStart = new Date(shown.getFullYear(), shown.getMonth(), 1 - new Date(shown.getFullYear(), shown.getMonth(), 1).getDay());
  const monthEnd = new Date(shown.getFullYear(), shown.getMonth() + 1, 0);
  const gridEnd = new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate() + (6 - monthEnd.getDay()));
  const { data, error } = useApi<CalendarData>(`/firm/calendar?from=${iso(gridStart)}&to=${iso(gridEnd)}${allWindows ? "&windows=all" : ""}`);
  const today = data?.today ?? iso(new Date());

  function persist(next: Partial<{ view: "month" | "list"; hidden: Set<EventType>; mine: boolean }>) {
    savePrefs({ view: next.view ?? view, hidden: [...(next.hidden ?? hidden)], mine: next.mine ?? mine });
  }

  const events = useMemo(() => {
    if (!data) return [] as CalEvent[];
    const out: CalEvent[] = [];
    for (const w of data.windows) {
      const sub = `${w.properties} propert${w.properties === 1 ? "y" : "ies"}${w.unfiled ? ` · ${w.unfiled} not filed` : ""}`;
      out.push({ key: `wo-${w.id}`, type: "window", date: w.opens_on, time: null, title: `${w.label} window opens`, sub, who: "", href: null, done: false, mine: w.mine });
      out.push({ key: `wc-${w.id}`, type: "window", date: w.closes_on, time: null, title: `${w.label} window closes`, sub: w.note ? `${sub} · ${w.note}` : sub, who: "", href: null, done: w.closes_on < today, mine: w.mine });
    }
    for (const d of data.deadlines) {
      out.push({
        key: `d-${d.id}`, type: d.kind, date: d.due_on, time: d.due_time, title: `${d.title} · ${d.property_short}`,
        sub: [d.location, pinLast(d.property_title)].filter(Boolean).join(" · "), who: [d.attorney_name, d.analyst_name].filter(Boolean).join(", "),
        href: `/properties/${d.property_id}`, done: d.status === "done", mine: d.mine,
      });
    }
    for (const t of data.tasks) {
      out.push({
        key: `t-${t.id}`, type: "task", date: t.due_on, time: null, title: t.property_short ? `${t.subject} · ${t.property_short}` : t.subject,
        sub: t.property_title ? pinLast(t.property_title) : t.account_name ?? "", who: t.assigned_name ?? "Unassigned",
        href: t.property_id ? `/properties/${t.property_id}` : t.account_id ? `/accounts/${t.account_id}` : null, done: t.status === "done", mine: t.mine,
      });
    }
    return out
      .filter((e) => !hidden.has(e.type) && (!mine || e.mine))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "99").localeCompare(b.time ?? "99") || a.title.localeCompare(b.title));
  }, [data, hidden, mine, today]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [events]);

  const days: Date[] = [];
  for (let d = new Date(gridStart); d <= gridEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d);
  const monthName = shown.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const go = (delta: number) => { setExpanded(null); setMonth(new Date(shown.getFullYear(), shown.getMonth() + delta, 1)); };
  const thisMonth = () => { const t = parse(today); setExpanded(null); setMonth(new Date(t.getFullYear(), t.getMonth(), 1)); };

  const evLine = (e: CalEvent) => {
    const label = <><span className={`dot ${e.type}`} aria-hidden="true" /><span className="t">{e.time ? `${clock(e.time)} ` : ""}{e.title}</span></>;
    const title = [e.title, e.sub, e.who].filter(Boolean).join("\n");
    return e.href
      ? <Link key={e.key} to={e.href} className={`ev${e.done ? " done" : ""}`} title={title}>{label}</Link>
      : <span key={e.key} className={`ev${e.done ? " done" : ""}`} title={title}>{label}</span>;
  };

  const listDays = days.filter((d) => d.getMonth() === shown.getMonth() && byDay.has(iso(d)));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Calendar</div>
          <h1>Calendar</h1>
          <div className="subtitle">Filing windows for your townships, hearings, evidence and filing deadlines, and tasks across the firm.</div>
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="card">
        <div className="cal-bar">
          <div className="cal-nav">
            <button className="btn small secondary" onClick={() => go(-1)} aria-label="Previous month">‹</button>
            <button className="btn small secondary" onClick={thisMonth}>Today</button>
            <button className="btn small secondary" onClick={() => go(1)} aria-label="Next month">›</button>
            <h2 aria-live="polite">{monthName}</h2>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div className="vseg" role="group" aria-label="Whose items">
              <button className={!mine ? "on" : ""} aria-pressed={!mine} onClick={() => { setMine(false); persist({ mine: false }); }}>Everyone</button>
              <button className={mine ? "on" : ""} aria-pressed={mine} onClick={() => { setMine(true); persist({ mine: true }); }}>Mine</button>
            </div>
            <div className="vseg" role="group" aria-label="View">
              <button className={view === "month" ? "on" : ""} aria-pressed={view === "month"} onClick={() => { setView("month"); persist({ view: "month" }); }}>Month</button>
              <button className={view === "list" ? "on" : ""} aria-pressed={view === "list"} onClick={() => { setView("list"); persist({ view: "list" }); }}>List</button>
            </div>
          </div>
        </div>
        <div className="cal-bar" style={{ paddingTop: 10, paddingBottom: 10 }}>
          <div className="cal-types" role="group" aria-label="Show on the calendar">
            {TYPES.map((t) => (
              <button
                key={t.id}
                aria-pressed={!hidden.has(t.id)}
                onClick={() => {
                  const next = new Set(hidden);
                  if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                  setHidden(next);
                  persist({ hidden: next });
                }}
              >
                <span className={`dot ${t.id}`} aria-hidden="true" />{t.label}
              </button>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={allWindows} onChange={(e) => setAllWindows(e.target.checked)} /> Windows for every township, not just ours</label>
        </div>

        {view === "month" ? (
          <div className="cal-grid" role="grid" aria-label={monthName}>
            {DOW.map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}
            {days.map((d) => {
              const key = iso(d);
              const list = byDay.get(key) ?? [];
              const open = expanded === key;
              const visible = open ? list : list.slice(0, 4);
              return (
                <div key={key} role="gridcell" className={`cal-day${d.getMonth() !== shown.getMonth() ? " out" : ""}${key === today ? " today" : ""}`} aria-label={d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}>
                  <span className="n">{d.getDate()}</span>
                  {list.length > 0 && <ul>{visible.map((e) => <li key={e.key}>{evLine(e)}</li>)}</ul>}
                  {list.length > 4 && <button className="more" onClick={() => setExpanded(open ? null : key)}>{open ? "Show fewer" : `+${list.length - 4} more`}</button>}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="cal-list">
            {listDays.length === 0 && <p className="meta" style={{ padding: 24, margin: 0, textAlign: "center" }}>Nothing on the calendar in {monthName}{hidden.size || mine ? " with these filters" : ""}.</p>}
            {listDays.map((d) => {
              const key = iso(d);
              return (
                <div key={key} className={`day${key === today ? " today" : ""}`}>
                  <div className="dh">{d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}<small>{d.toLocaleDateString("en-US", { weekday: "long" })}{key === today ? " · today" : ""}</small></div>
                  <ul>
                    {byDay.get(key)!.map((e) => (
                      <li key={e.key} className={e.done ? "done" : ""}>
                        <span className={`dot ${e.type}`} aria-hidden="true" style={{ position: "relative", top: 1 }} />
                        <span>
                          {e.href ? <Link className="t" to={e.href}>{e.time ? `${clock(e.time)} · ` : ""}{e.title}</Link> : <span className="t">{e.title}</span>}
                          {e.sub && <span className="s">{e.sub}</span>}
                        </span>
                        <span className="who">{e.who}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        <div className="cal-legend">
          Windows come from the published township calendar and show where your firm has properties. Deadlines are added on each property; tasks come from Activities.
        </div>
      </section>
    </>
  );
}
