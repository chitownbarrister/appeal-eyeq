// The firm's calendar: filing windows, deadlines and hearings, tasks, and entries made right here
// (meetings, calls, reminders). Views: List, Day, Work week, Week, Month, Year, remembered per person.
// An entry tagged to a client, property or appeal shows on their Activities (or, for a hearing or
// deadline, in the property's deadlines); an untagged one is a firm entry, or private to its maker.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { useApi, useFirmUsers } from "../data";
import { clock } from "../components/Deadlines";
import { Sheet } from "../components/Sheet";
import { nn, splitMatterTitle } from "../format";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";

type EventType = "window" | "hearing" | "evidence" | "filing" | "other" | "task" | "meeting" | "call" | "reminder";
const TYPES: { id: EventType; label: string }[] = [
  { id: "window", label: "Filing windows" },
  { id: "hearing", label: "Hearings" },
  { id: "evidence", label: "Evidence due" },
  { id: "filing", label: "Filing deadlines" },
  { id: "other", label: "Other deadlines" },
  { id: "task", label: "Tasks" },
  { id: "meeting", label: "Meetings" },
  { id: "call", label: "Calls" },
  { id: "reminder", label: "Reminders" },
];

type View = "list" | "day" | "workweek" | "week" | "month" | "year";
const VIEWS: { id: View; label: string }[] = [
  { id: "list", label: "List" }, { id: "day", label: "Day" }, { id: "workweek", label: "Work week" },
  { id: "week", label: "Week" }, { id: "month", label: "Month" }, { id: "year", label: "Year" },
];

interface WindowRow { id: number; label: string; level: string; assessment_year: number; opens_on: string; closes_on: string; note: string | null; properties: number; unfiled: number; mine: boolean }
interface DeadlineRow { id: number; property_id: number; kind: "hearing" | "evidence" | "filing" | "other"; title: string; due_on: string; due_time: string | null; location: string | null; status: "open" | "done"; property_title: string; property_short: string; attorney_name: string | null; analyst_name: string | null; mine: boolean }
export interface EntryRow {
  id: number; kind: "task" | "meeting" | "call" | "reminder"; property_id: number | null; account_id: number | null; appeal_id: number | null;
  subject: string; body: string | null; due_on: string; start_time: string | null; end_time: string | null; location: string | null; is_private: boolean;
  status: "open" | "done"; assigned_user_id: number | null; assigned_name: string | null; property_title: string | null; property_short: string | null;
  account_name: string | null; assessment_year: number | null; level: Level | null; mine: boolean;
}
interface CalendarData { today: string; windows: WindowRow[]; deadlines: DeadlineRow[]; entries: EntryRow[] }

interface CalEvent {
  key: string; type: EventType; date: string; time: string | null; end: string | null; title: string; sub: string; who: string;
  href: string | null; done: boolean; mine: boolean; entry: EntryRow | null;
}

/** "1440 Brookdale Rd., Naperville (Lisle) · PIN 07-26-110-009" */
const pinLast = (title: string) => { const t = splitMatterTitle(title); return t.pin ? `${t.place} · PIN ${t.pin}` : t.place; };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const minutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const HOUR_PX = 44;

interface Prefs { view: View; hidden: EventType[]; mine: boolean }
const DEFAULT_PREFS: Prefs = { view: "month", hidden: [], mine: false };

function loadPrefs(key: string): Prefs {
  try {
    const raw = window.localStorage.getItem(key) ?? window.localStorage.getItem("aeq.calendar");
    if (raw) {
      const p = { ...DEFAULT_PREFS, ...JSON.parse(raw) } as Prefs;
      if (!VIEWS.some((v) => v.id === p.view)) p.view = "month";
      return p;
    }
  } catch { /* storage can be unavailable; defaults are fine */ }
  return DEFAULT_PREFS;
}
function savePrefs(key: string, p: Prefs) {
  try { window.localStorage.setItem(key, JSON.stringify(p)); } catch { /* ignore */ }
}

/** The days the view shows, and the range to ask the server for. */
function rangeOf(view: View, anchor: Date): { from: Date; to: Date; days: Date[] } {
  let from: Date, to: Date;
  if (view === "day") { from = anchor; to = anchor; }
  else if (view === "week") { from = addDays(anchor, -anchor.getDay()); to = addDays(from, 6); }
  else if (view === "workweek") { from = addDays(anchor, -((anchor.getDay() + 6) % 7)); to = addDays(from, 4); }
  else if (view === "year") { from = new Date(anchor.getFullYear(), 0, 1); to = new Date(anchor.getFullYear(), 11, 31); }
  else {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    from = addDays(first, -first.getDay());
    to = addDays(last, 6 - last.getDay());
  }
  const days: Date[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return { from, to, days };
}

function headingOf(view: View, anchor: Date, days: Date[]): string {
  if (view === "day") return anchor.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (view === "year") return String(anchor.getFullYear());
  if (view === "week" || view === "workweek") {
    const a = days[0], b = days[days.length - 1];
    const left = a.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const right = a.getMonth() === b.getMonth() ? String(b.getDate()) : b.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${left} to ${right}, ${b.getFullYear()}`;
  }
  return anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function step(view: View, anchor: Date, dir: number): Date {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week" || view === "workweek") return addDays(anchor, 7 * dir);
  if (view === "year") return new Date(anchor.getFullYear() + dir, anchor.getMonth(), 1);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}
const UNIT: Record<View, string> = { list: "month", month: "month", day: "day", week: "week", workweek: "week", year: "year" };

export function Calendar() {
  const { me } = useSession();
  const prefsKey = `aeq.calendar.${me.user.id}`;
  const prefs = useMemo(() => loadPrefs(prefsKey), [prefsKey]);
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [view, setView] = useState<View>(prefs.view);
  const [hidden, setHidden] = useState<Set<EventType>>(new Set(prefs.hidden));
  const [mine, setMine] = useState(prefs.mine);
  const [allWindows, setAllWindows] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ entry?: EntryRow; date?: string; time?: string } | null>(null);
  const readOnly = me.user.isSuperAdmin;

  // Until the server says what "today" is, use the browser's date.
  const shown = anchor ?? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const { from, to, days } = rangeOf(view, shown);
  const { data, error, reload } = useApi<CalendarData>(`/firm/calendar?from=${iso(from)}&to=${iso(to)}${allWindows ? "&windows=all" : ""}`);
  const today = data?.today ?? iso(new Date());
  // Once the server's date arrives, start on it (tests and the firm's clock agree on "today").
  useEffect(() => { if (data?.today && !anchor) setAnchor(parse(data.today)); }, [data?.today, anchor]);

  function persist(next: Partial<{ view: View; hidden: Set<EventType>; mine: boolean }>) {
    savePrefs(prefsKey, { view: next.view ?? view, hidden: [...(next.hidden ?? hidden)], mine: next.mine ?? mine });
  }

  const events = useMemo(() => {
    if (!data) return [] as CalEvent[];
    const out: CalEvent[] = [];
    for (const w of data.windows) {
      const sub = `${w.properties} propert${w.properties === 1 ? "y" : "ies"}${w.unfiled ? ` · ${w.unfiled} not filed` : ""}`;
      out.push({ key: `wo-${w.id}`, type: "window", date: w.opens_on, time: null, end: null, title: `${w.label} window opens`, sub, who: "", href: null, done: false, mine: w.mine, entry: null });
      out.push({ key: `wc-${w.id}`, type: "window", date: w.closes_on, time: null, end: null, title: `${w.label} window closes`, sub: w.note ? `${sub} · ${w.note}` : sub, who: "", href: null, done: w.closes_on < today, mine: w.mine, entry: null });
    }
    for (const d of data.deadlines) {
      out.push({
        key: `d-${d.id}`, type: d.kind, date: d.due_on, time: d.due_time, end: null, title: `${d.title} · ${d.property_short}`,
        sub: [d.location, pinLast(d.property_title)].filter(Boolean).join(" · "), who: [d.attorney_name, d.analyst_name].filter(Boolean).join(", "),
        href: `/properties/${d.property_id}`, done: d.status === "done", mine: d.mine, entry: null,
      });
    }
    for (const t of data.entries) {
      const tag = t.property_title ? pinLast(t.property_title) : t.account_name ?? (t.is_private ? "Private" : "Firm");
      out.push({
        key: `a-${t.id}`, type: t.kind, date: t.due_on, time: t.start_time, end: t.end_time,
        title: t.property_short ? `${t.subject} · ${t.property_short}` : t.subject,
        sub: [t.location, tag, t.level ? `${t.assessment_year} ${LEVEL_LABELS[t.level]}` : null].filter(Boolean).join(" · "),
        who: t.assigned_name ?? (t.kind === "task" ? "Unassigned" : ""),
        href: null, done: t.status === "done", mine: t.mine, entry: t,
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

  const heading = headingOf(view, shown, days);
  const go = (dir: number) => { setExpanded(null); setAnchor(step(view, shown, dir)); };
  const goToday = () => { setExpanded(null); setAnchor(parse(today)); };
  const switchView = (v: View) => { setView(v); persist({ view: v }); };
  const openDay = (d: Date) => { setAnchor(d); switchView("day"); };

  const evLine = (e: CalEvent) => {
    const label = <><span className={`dot ${e.type}`} aria-hidden="true" /><span className="t">{e.time ? `${clock(e.time)} ` : ""}{e.title}</span></>;
    const title = [e.title, e.sub, e.who].filter(Boolean).join("\n");
    if (e.entry) return <button type="button" key={e.key} className={`ev${e.done ? " done" : ""}`} title={title} onClick={() => setSheet({ entry: e.entry! })}>{label}</button>;
    return e.href
      ? <Link key={e.key} to={e.href} className={`ev${e.done ? " done" : ""}`} title={title}>{label}</Link>
      : <span key={e.key} className={`ev${e.done ? " done" : ""}`} title={title}>{label}</span>;
  };

  const monthDays = view === "list" ? days.filter((d) => d.getMonth() === shown.getMonth()) : days;
  const listDays = monthDays.filter((d) => byDay.has(iso(d)));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Calendar</div>
          <h1>Calendar</h1>
          <div className="subtitle">Filing windows for your townships, hearings and deadlines, tasks, and the firm's meetings, calls and reminders.</div>
        </div>
        {!readOnly && <div className="actions"><button className="btn" onClick={() => setSheet({ date: iso(shown) < today && view !== "day" ? today : iso(shown) })}>+ New entry</button></div>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="card">
        <div className="cal-bar">
          <div className="cal-nav">
            <button className="btn small secondary" onClick={() => go(-1)} aria-label={`Previous ${UNIT[view]}`}>‹</button>
            <button className="btn small secondary" onClick={goToday}>Today</button>
            <button className="btn small secondary" onClick={() => go(1)} aria-label={`Next ${UNIT[view]}`}>›</button>
            <h2 aria-live="polite">{heading}</h2>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div className="vseg" role="group" aria-label="Whose items">
              <button className={!mine ? "on" : ""} aria-pressed={!mine} onClick={() => { setMine(false); persist({ mine: false }); }}>Everyone</button>
              <button className={mine ? "on" : ""} aria-pressed={mine} onClick={() => { setMine(true); persist({ mine: true }); }}>Mine</button>
            </div>
            <div className="vseg cal-views" role="group" aria-label="View">
              {VIEWS.map((v) => <button key={v.id} className={view === v.id ? "on" : ""} aria-pressed={view === v.id} onClick={() => switchView(v.id)}>{v.label}</button>)}
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

        {view === "month" && (
          <div className="cal-grid" role="grid" aria-label={heading}>
            {DOW.map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}
            {days.map((d) => {
              const key = iso(d);
              const list = byDay.get(key) ?? [];
              const open = expanded === key;
              const visible = open ? list : list.slice(0, 4);
              return (
                <div key={key} role="gridcell" className={`cal-day${d.getMonth() !== shown.getMonth() ? " out" : ""}${key === today ? " today" : ""}`} aria-label={d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}>
                  <button type="button" className="n" onClick={() => openDay(d)} aria-label={`Open ${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`}>{d.getDate()}</button>
                  {list.length > 0 && <ul>{visible.map((e) => <li key={e.key}>{evLine(e)}</li>)}</ul>}
                  {list.length > 4 && <button className="more" onClick={() => setExpanded(open ? null : key)}>{open ? "Show fewer" : `+${list.length - 4} more`}</button>}
                </div>
              );
            })}
          </div>
        )}

        {(view === "day" || view === "week" || view === "workweek") && (
          <TimeGrid days={days} byDay={byDay} today={today} evLine={evLine} onSlot={readOnly ? undefined : (date, time) => setSheet({ date, time })}
            onOpen={(e) => (e.entry ? setSheet({ entry: e.entry }) : undefined)} onDay={view === "day" ? undefined : openDay} />
        )}

        {view === "year" && (
          <div className="cal-year">
            {Array.from({ length: 12 }, (_, m) => {
              const first = new Date(shown.getFullYear(), m, 1);
              const cells: (Date | null)[] = [...Array(first.getDay()).fill(null)];
              for (let d = first; d.getMonth() === m; d = addDays(d, 1)) cells.push(d);
              const count = cells.reduce((a, d) => a + (d ? byDay.get(iso(d))?.length ?? 0 : 0), 0);
              return (
                <div key={m} className="ym">
                  <button type="button" className="ymh" onClick={() => { setAnchor(first); switchView("month"); }}>
                    {first.toLocaleDateString("en-US", { month: "long" })}<small>{count ? `${count} item${count === 1 ? "" : "s"}` : ""}</small>
                  </button>
                  <div className="ymg">
                    {DOW.map((d) => <span key={d} className="yd">{d[0]}</span>)}
                    {cells.map((d, i) => {
                      if (!d) return <span key={`b${i}`} />;
                      const k = iso(d);
                      const n = byDay.get(k)?.length ?? 0;
                      return (
                        <button key={k} type="button" className={`yc${n ? " has" : ""}${k === today ? " today" : ""}`} onClick={() => openDay(d)}
                          aria-label={`${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })}${n ? `, ${n} item${n === 1 ? "" : "s"}` : ""}`}
                          title={n ? (byDay.get(k) ?? []).map((e) => e.title).join("\n") : undefined}>
                          {d.getDate()}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {view === "list" && (
          <div className="cal-list">
            {listDays.length === 0 && <p className="meta" style={{ padding: 24, margin: 0, textAlign: "center" }}>Nothing on the calendar in {heading}{hidden.size || mine ? " with these filters" : ""}.</p>}
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
                          {e.entry
                            ? <button type="button" className="lk t" onClick={() => setSheet({ entry: e.entry! })}>{e.time ? `${clock(e.time)}${e.end ? ` to ${clock(e.end)}` : ""} · ` : ""}{e.title}</button>
                            : e.href ? <Link className="t" to={e.href}>{e.time ? `${clock(e.time)} · ` : ""}{e.title}</Link> : <span className="t">{e.title}</span>}
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
          Windows come from the published township calendar and show where your firm has properties. Deadlines are added on each property or here; tasks come from Activities.
          Meetings, calls and reminders tagged to a client or property show on its Activities.
        </div>
      </section>
      {sheet && (
        <EntrySheet
          entry={sheet.entry} date={sheet.date ?? today} time={sheet.time ?? ""} readOnly={readOnly}
          onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- day and week grids
function TimeGrid({ days, byDay, today, evLine, onSlot, onOpen, onDay }: {
  days: Date[]; byDay: Map<string, CalEvent[]>; today: string; evLine: (e: CalEvent) => ReactElement;
  onSlot?: (date: string, time: string) => void; onOpen: (e: CalEvent) => void; onDay?: (d: Date) => void;
}) {
  // Office hours, stretched to fit anything earlier or later.
  const timed = days.flatMap((d) => (byDay.get(iso(d)) ?? []).filter((e) => e.time));
  const startHour = Math.min(7, ...timed.map((e) => Math.floor(minutes(e.time!) / 60)));
  const endHour = Math.max(19, ...timed.map((e) => Math.ceil(minutes(e.end ?? e.time!) / 60) + (e.end ? 0 : 1)));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  return (
    <div className="tg" role="grid" aria-label="Times" style={{ ["--days" as string]: days.length } as CSSProperties}>
      <div className="tg-head">
        <span />
        {days.map((d) => {
          const k = iso(d);
          const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
          return onDay
            ? <button key={k} type="button" className={`tg-dh${k === today ? " today" : ""}`} onClick={() => onDay(d)}>{label}</button>
            : <span key={k} className={`tg-dh${k === today ? " today" : ""}`}>{d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</span>;
        })}
      </div>
      <div className="tg-all">
        <span className="tg-l">All day</span>
        {days.map((d) => {
          const k = iso(d);
          const list = (byDay.get(k) ?? []).filter((e) => !e.time);
          return <div key={k} role="gridcell" aria-label={`${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}, all day`}><ul>{list.map((e) => <li key={e.key}>{evLine(e)}</li>)}</ul></div>;
        })}
      </div>
      <div className="tg-body">
        <div className="tg-hours">{hours.map((h) => <span key={h} style={{ height: HOUR_PX }}>{clock(`${String(h).padStart(2, "0")}:00`).replace(":00", "")}</span>)}</div>
        {days.map((d) => {
          const k = iso(d);
          const list = (byDay.get(k) ?? []).filter((e) => e.time);
          // Side by side when they overlap: each takes the first free lane.
          const lanes: number[] = [];
          const placed = list.map((e) => {
            const s = minutes(e.time!);
            const end = Math.max(e.end ? minutes(e.end) : s + 60, s + 30);
            let lane = lanes.findIndex((busyTo) => busyTo <= s);
            if (lane < 0) { lane = lanes.length; lanes.push(end); } else lanes[lane] = end;
            return { e, s, end, lane };
          });
          const width = 100 / Math.max(1, lanes.length);
          return (
            <div key={k} className={`tg-col${k === today ? " today" : ""}`} style={{ height: hours.length * HOUR_PX }} role="gridcell"
              aria-label={d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}>
              {onSlot && hours.map((h) => (
                <button key={h} type="button" className="tg-slot" style={{ top: (h - startHour) * HOUR_PX, height: HOUR_PX }} tabIndex={-1}
                  aria-label={`New entry ${clock(`${String(h).padStart(2, "0")}:00`)}`} onClick={() => onSlot(k, `${String(h).padStart(2, "0")}:00`)} />
              ))}
              {placed.map(({ e, s, end, lane }) => (
                <div key={e.key} className={`tg-ev ${e.type}${e.done ? " done" : ""}`}
                  style={{ top: ((s - startHour * 60) / 60) * HOUR_PX, height: Math.max(((end - s) / 60) * HOUR_PX - 2, 20), left: `${lane * width}%`, width: `calc(${width}% - 3px)` }}
                  title={[e.title, e.sub, e.who].filter(Boolean).join("\n")}>
                  {e.entry ? (
                    <button type="button" onClick={() => onOpen(e)}><b>{clock(e.time)}{e.end ? ` to ${clock(e.end)}` : ""}</b> {e.title}</button>
                  ) : e.href ? <Link to={e.href}><b>{clock(e.time)}</b> {e.title}</Link> : <span><b>{clock(e.time)}</b> {e.title}</span>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- making and editing entries
type EntryKind = "meeting" | "call" | "reminder" | "task" | "hearing" | "evidence" | "filing" | "other";
const ENTRY_KINDS: { id: EntryKind; label: string; deadline?: boolean }[] = [
  { id: "meeting", label: "Meeting" }, { id: "call", label: "Call" }, { id: "reminder", label: "Reminder" }, { id: "task", label: "Task" },
  { id: "hearing", label: "Hearing", deadline: true }, { id: "evidence", label: "Evidence due", deadline: true },
  { id: "filing", label: "Filing deadline", deadline: true }, { id: "other", label: "Other deadline", deadline: true },
];
const isDeadline = (k: EntryKind) => ENTRY_KINDS.find((x) => x.id === k)?.deadline ?? false;

interface PropertyOption { id: number; title: string; account_id: number; account_name: string }

function EntrySheet({ entry, date, time, readOnly, onClose, onSaved }: {
  entry?: EntryRow; date: string; time: string; readOnly: boolean; onClose: () => void; onSaved: () => void;
}) {
  const users = useFirmUsers();
  const { me } = useSession();
  const props = useApi<{ properties: PropertyOption[] }>("/firm/properties");
  const accounts = useApi<{ accounts: { id: number; name: string }[] }>("/firm/accounts");
  const [f, setF] = useState({
    kind: (entry?.kind ?? "meeting") as EntryKind, subject: entry?.subject ?? "", dueOn: entry?.due_on ?? date,
    startTime: (entry?.start_time ?? time).slice(0, 5), endTime: (entry?.end_time ?? "").slice(0, 5), location: entry?.location ?? "",
    accountId: entry?.account_id ? String(entry.account_id) : "", propertyId: entry?.property_id ? String(entry.property_id) : "",
    appealId: entry?.appeal_id ? String(entry.appeal_id) : "", assignedUserId: entry?.assigned_user_id ? String(entry.assigned_user_id) : entry ? "" : String(me.user.id),
    body: entry?.body ?? "", isPrivate: entry?.is_private ?? false,
  });
  const [appeals, setAppeals] = useState<{ id: number; assessment_year: number; level: Level }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const deadline = isDeadline(f.kind);
  const allProps = props.data?.properties ?? [];
  const propOptions = f.accountId ? allProps.filter((p) => String(p.account_id) === f.accountId) : allProps;
  const tagged = Boolean(f.accountId || f.propertyId || f.appealId);

  const loadAppeals = useCallback(async (pid: string) => {
    if (!pid) { setAppeals([]); return; }
    try {
      const d = await api<{ appeals: { id: number; assessment_year: number; level: Level }[] }>(`/firm/properties/${pid}`);
      setAppeals(d.appeals);
    } catch { setAppeals([]); }
  }, []);
  useEffect(() => { void loadAppeals(f.propertyId); }, [f.propertyId, loadAppeals]);

  async function save() {
    setBusy(true); setError("");
    try {
      if (deadline) {
        if (!f.propertyId) throw new Error("A hearing or deadline belongs to a property. Choose one.");
        await api(`/firm/properties/${f.propertyId}/deadlines`, {
          method: "POST",
          body: { kind: f.kind, title: nn(f.subject), dueOn: f.dueOn, dueTime: nn(f.startTime), location: nn(f.location), notes: nn(f.body), appealId: f.appealId ? Number(f.appealId) : null },
        });
      } else {
        const body = {
          kind: f.kind, subject: f.subject.trim(), dueOn: f.dueOn, startTime: nn(f.startTime), endTime: nn(f.endTime), location: nn(f.location),
          accountId: f.accountId ? Number(f.accountId) : null, propertyId: f.propertyId ? Number(f.propertyId) : null, appealId: f.appealId ? Number(f.appealId) : null,
          assignedUserId: f.assignedUserId ? Number(f.assignedUserId) : null, body: nn(f.body), isPrivate: !tagged && f.isPrivate,
        };
        if (entry) await api(`/firm/activities/${entry.id}`, { method: "PATCH", body });
        else await api("/firm/activities", { method: "POST", body });
      }
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!entry) return;
    setBusy(true); setError("");
    try { await api(`/firm/activities/${entry.id}`, { method: "DELETE" }); onSaved(); } catch (err) { setError(errorText(err)); setBusy(false); }
  }
  async function toggleDone() {
    if (!entry) return;
    setBusy(true); setError("");
    try { await api(`/firm/activities/${entry.id}`, { method: "PATCH", body: { status: entry.status === "done" ? "open" : "done" } }); onSaved(); } catch (err) { setError(errorText(err)); setBusy(false); }
  }

  const title = entry ? entry.subject : "New calendar entry";
  return (
    <Sheet eyebrow={entry ? ENTRY_KINDS.find((k) => k.id === entry.kind)?.label ?? "Entry" : "Calendar"} title={title} onClose={onClose} onSubmit={readOnly ? undefined : () => void save()}
      footer={<>
        {error && <span className="error" role="alert" style={{ margin: 0, flexBasis: "100%" }}>{error}</span>}
        {entry && !readOnly && <button type="button" className="btn ghost" disabled={busy} onClick={() => void remove()}>Delete</button>}
        {entry && !readOnly && <button type="button" className="btn secondary" disabled={busy} onClick={() => void toggleDone()}>{entry.status === "done" ? "Reopen" : "Mark done"}</button>}
        <span className="sp" />
        <button type="button" className="btn secondary" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</button>
        {!readOnly && <button type="submit" className="btn" disabled={busy}>{busy ? "Saving" : entry ? "Save changes" : "Add to calendar"}</button>}
      </>}>
      <div className="fgrid">
        <div className="fld">
          <label htmlFor="ce-kind">Type</label>
          <select id="ce-kind" className="in" value={f.kind} disabled={Boolean(entry)} onChange={(e) => setF({ ...f, kind: e.target.value as EntryKind })}>
            {ENTRY_KINDS.filter((k) => !entry || !k.deadline).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </div>
        <div className="fld"><label htmlFor="ce-date">Date</label><input id="ce-date" type="date" className="in" value={f.dueOn} onChange={set("dueOn")} required /></div>
        <div className="fld span2"><label htmlFor="ce-subject">{deadline ? "Title (optional)" : "What"}</label>
          <input id="ce-subject" className="in" value={f.subject} onChange={set("subject")} required={!deadline} placeholder={deadline ? "BOR hearing" : f.kind === "call" ? "Call with the property manager" : "Meet with the client about the 2026 notice"} /></div>
        <div className="fld"><label htmlFor="ce-start">{deadline ? "Time" : "Starts"}</label><input id="ce-start" type="time" className="in" value={f.startTime} onChange={set("startTime")} /></div>
        {!deadline && <div className="fld"><label htmlFor="ce-end">Ends</label><input id="ce-end" type="time" className="in" value={f.endTime} onChange={set("endTime")} disabled={!f.startTime} /></div>}
        <div className="fld span2"><label htmlFor="ce-loc">Where</label><input id="ce-loc" className="in" value={f.location} onChange={set("location")} placeholder="Office, Zoom, Room 601 of the County Building" /></div>
        <div className="fld">
          <label htmlFor="ce-client">Client</label>
          <select id="ce-client" className="in" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value, propertyId: "", appealId: "" })}>
            <option value="">{deadline ? "Any client" : "None (firm entry)"}</option>
            {(accounts.data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="ce-prop">Property{deadline ? "" : " (optional)"}</label>
          <select id="ce-prop" className="in" value={f.propertyId} required={deadline}
            onChange={(e) => { const p = allProps.find((x) => String(x.id) === e.target.value); setF({ ...f, propertyId: e.target.value, appealId: "", accountId: p ? String(p.account_id) : f.accountId }); }}>
            <option value="">{deadline ? "Choose a property" : "None"}</option>
            {propOptions.map((p) => <option key={p.id} value={p.id}>{splitMatterTitle(p.title).place}</option>)}
          </select>
        </div>
        {f.propertyId && (
          <div className="fld">
            <label htmlFor="ce-appeal">Appeal (optional)</label>
            <select id="ce-appeal" className="in" value={f.appealId} onChange={set("appealId")}>
              <option value="">None</option>
              {appeals.map((a) => <option key={a.id} value={a.id}>{a.assessment_year} {LEVEL_LABELS[a.level]}</option>)}
            </select>
          </div>
        )}
        {!deadline && (
          <div className="fld">
            <label htmlFor="ce-who">{f.kind === "task" ? "Assigned to" : "Who"}</label>
            <select id="ce-who" className="in" value={f.assignedUserId} onChange={set("assignedUserId")}>
              <option value="">Nobody in particular</option>
              {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        )}
        <div className="fld span2"><label htmlFor="ce-notes">Notes</label><textarea id="ce-notes" className="in" rows={3} value={f.body} onChange={set("body")} /></div>
      </div>
      {!deadline && !tagged && (
        <label className="check"><input type="checkbox" checked={f.isPrivate} onChange={(e) => setF({ ...f, isPrivate: e.target.checked })} /> Private: only I see it</label>
      )}
      <p className="meta">
        {deadline ? "Saved in the property's deadlines, where it also counts toward its hearing date."
          : tagged ? "Shows on the calendar and on the client's and property's Activities."
            : f.isPrivate ? "Shows only on your calendar." : "A firm entry: shows on everyone's calendar."}
      </p>
      {entry?.property_id && <p className="meta"><Link to={`/properties/${entry.property_id}`} onClick={onClose}>Open the property</Link></p>}
    </Sheet>
  );
}
