// Builds the deadline list shown in a property's summary card and on the
// calendar: stored deadlines (hearings, evidence, filing, other) plus the
// township filing window for the property's current appeal, which is read
// from the global windows table rather than copied per property.

import type { Level, Substage } from "../shared/domain.js";
import type { WindowRow } from "./reference-lookup.js";

export const LEVEL_SHORT: Record<Level, string> = { assessor: "Assessor", bor: "BOR", ptab: "PTAB", circuit: "Circuit Court" };

/** Substages where the appeal hasn't been filed yet, so an open window means work to do. */
export const WINDOW_ACTIVE_SUBSTAGES: Substage[] = ["under_review"];

export interface DeadlineRow {
  id: number; property_id: number; appeal_id: number | null; kind: "hearing" | "evidence" | "filing" | "other";
  title: string; due_on: string; due_time: string | null; location: string | null; notes: string | null;
  status: "open" | "done"; source: "manual" | "notice" | "computed"; computed_on: string | null; override_reason: string | null;
  level?: Level | null;
}

export interface DeadlineItem {
  key: string;
  id: number | null;           // null for a derived window entry
  kind: DeadlineRow["kind"] | "window";
  title: string;
  detail: string | null;
  due_on: string;
  due_time: string | null;
  location: string | null;
  notes: string | null;
  status: "open" | "done";
  source: DeadlineRow["source"] | "window";
  appeal_id: number | null;
  days: number;                // due_on minus today, in days (negative when past)
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface CurrentAppeal { id: number; level: Level; substage: Substage; assessment_year: number; filed_on: string | null }

/** The window entry for the current appeal, if a window is published for it. */
export function windowItem(win: WindowRow | null, cur: CurrentAppeal | null, today: string): DeadlineItem | null {
  if (!win || !cur) return null;
  const place = `${win.township ?? win.county} ${LEVEL_SHORT[win.level]}`;
  const unfiled = WINDOW_ACTIVE_SUBSTAGES.includes(cur.substage);
  const base = { key: `window-${win.id}`, id: null, kind: "window" as const, due_time: null, location: null, notes: win.note, source: "window" as const, appeal_id: cur.id };
  if (unfiled) {
    const notOpen = today < win.opens_on;
    return {
      ...base,
      title: `${place} window closes`,
      detail: notOpen ? `Opens ${shortDate(win.opens_on)}` : today > win.closes_on ? "Closed before filing" : "Open now, not filed yet",
      due_on: win.closes_on,
      status: "open",
      days: daysBetween(today, win.closes_on),
    };
  }
  return {
    ...base,
    title: `${place} window ${today > win.closes_on ? "closed" : "closes"}`,
    detail: cur.substage === "fairly_assessed" ? "Fairly assessed, not filed" : cur.filed_on ? `Filed ${shortDate(cur.filed_on)}` : "Filed",
    due_on: win.closes_on,
    status: "done",
    days: daysBetween(today, win.closes_on),
  };
}

export function deadlineItem(d: DeadlineRow, today: string): DeadlineItem {
  return {
    key: `d-${d.id}`, id: d.id, kind: d.kind, title: d.title,
    detail: [d.location, d.source === "computed" && d.override_reason ? `Changed by hand: ${d.override_reason}` : null].filter(Boolean).join(" · ") || null,
    due_on: d.due_on, due_time: d.due_time, location: d.location, notes: d.notes, status: d.status, source: d.source,
    appeal_id: d.appeal_id, days: daysBetween(today, d.due_on),
  };
}

/** Open items soonest first (overdue at the top), then finished ones, most recent first. */
export function buildDeadlineList(rows: DeadlineRow[], win: DeadlineItem | null, today: string): DeadlineItem[] {
  const items = rows.map((r) => deadlineItem(r, today));
  if (win) items.push(win);
  const open = items.filter((i) => i.status === "open").sort((a, b) => a.due_on.localeCompare(b.due_on) || (a.due_time ?? "").localeCompare(b.due_time ?? ""));
  const done = items.filter((i) => i.status === "done").sort((a, b) => b.due_on.localeCompare(a.due_on));
  return [...open, ...done];
}
