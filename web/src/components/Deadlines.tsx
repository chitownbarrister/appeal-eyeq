import { useState } from "react";
import { api, errorText } from "../api";
import { Sheet } from "./Sheet";
import { nn } from "../format";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";
import type { AppealRow, DeadlineItem } from "../pages/Property";

const SHOWN = 3;

/** "Oct 22", with the year added when it isn't the current one. */
export function shortDate(iso: string, today: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return iso.slice(0, 4) === today.slice(0, 4) ? s : `${s}, ${y}`;
}

/** "10:30 AM" from "10:30:00". */
export function clock(time: string | null): string {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The urgency pill: red within 2 days or late, amber within a week. */
export function urgency(item: { status: string; days: number; kind: string }): { cls: string; text: string } | null {
  if (item.status === "done") return { cls: "grey", text: "Done" };
  const d = item.days;
  if (d < 0) return { cls: "crit", text: item.kind === "window" ? "Closed" : `${-d} day${d === -1 ? "" : "s"} late` };
  if (d === 0) return { cls: "crit", text: "Today" };
  if (d === 1) return { cls: "crit", text: "Tomorrow" };
  if (d <= 2) return { cls: "crit", text: `${d} days` };
  if (d <= 7) return { cls: "warn", text: `${d} days` };
  return { cls: "grey", text: `${d} days` };
}

export function DeadlinesBlock({ items, today, canEdit, onAdd, onOpen }: {
  items: DeadlineItem[]; today: string; canEdit: boolean; onAdd: () => void; onOpen: (d: DeadlineItem) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const open = items.filter((i) => i.status === "open");
  const past = items.filter((i) => i.status === "done");
  const shown = showAll ? open : open.slice(0, SHOWN);

  const row = (d: DeadlineItem) => {
    const u = urgency(d);
    const sub = [d.due_time ? clock(d.due_time) : null, d.detail].filter(Boolean).join(" · ");
    const body = <>{d.title}{sub && <small>{sub}</small>}</>;
    return (
      <li key={d.key} className={d.status === "done" ? "past" : ""}>
        <span className="d">{shortDate(d.due_on, today)}</span>
        <span className="w">
          {d.id !== null && canEdit
            ? <button type="button" className="edit" onClick={() => onOpen(d)} aria-label={`Edit ${d.title}, ${shortDate(d.due_on, today)}`}>{body}</button>
            : body}
        </span>
        {u && <span className={`pill ${u.cls}`}>{u.text}</span>}
      </li>
    );
  };

  return (
    <div className="dlb">
      <dt className="dlb-h">
        <span>Deadlines</span>
        {canEdit && <button type="button" className="lk" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }} onClick={onAdd}>+ Add</button>}
      </dt>
      <dd style={{ margin: 0 }}>
        {open.length === 0 && !showPast && <p className="empty">Nothing coming up. Hearings, evidence dates and filing deadlines you add appear here and on the Calendar.</p>}
        {open.length > 0 && <ol aria-label="Upcoming deadlines">{shown.map(row)}</ol>}
        {showPast && past.length > 0 && <ol aria-label="Past deadlines" style={{ marginTop: open.length ? 10 : 0 }}>{past.map(row)}</ol>}
        {(open.length > SHOWN || past.length > 0) && (
          <div className="more">
            {open.length > SHOWN && (
              <button type="button" className="lk" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${open.length} upcoming`}</button>
            )}
            {past.length > 0 && (
              <button type="button" className="lk" aria-expanded={showPast} onClick={() => setShowPast(!showPast)}>
                {showPast ? "Hide past deadlines" : `Show ${past.length} past deadline${past.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        )}
      </dd>
    </div>
  );
}

const KIND_LABELS = { hearing: "Hearing", evidence: "Evidence due", filing: "Filing deadline", other: "Other" } as const;
type Kind = keyof typeof KIND_LABELS;

export function DeadlineSheet({ propertyId, appeals, existing, onClose, onSaved }: {
  propertyId: number;
  appeals: AppealRow[];
  existing: DeadlineItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = appeals[0];
  const [f, setF] = useState({
    kind: (existing?.kind && existing.kind !== "window" ? existing.kind : "hearing") as Kind,
    appealId: existing ? (existing.appeal_id ? String(existing.appeal_id) : "") : current ? String(current.id) : "",
    title: existing?.title ?? "",
    dueOn: existing?.due_on ?? "",
    dueTime: existing?.due_time?.slice(0, 5) ?? "",
    location: existing?.location ?? "",
    notes: existing?.notes ?? "",
    done: existing?.status === "done",
    reason: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const computedChanged = existing?.source === "computed" && f.dueOn !== existing.due_on;

  async function save() {
    setBusy(true);
    setError("");
    const body = {
      kind: f.kind, appealId: f.appealId ? Number(f.appealId) : null, title: nn(f.title), dueOn: f.dueOn,
      dueTime: f.kind === "hearing" ? nn(f.dueTime) : null, location: nn(f.location), notes: nn(f.notes),
    };
    try {
      if (existing?.id) {
        await api(`/firm/deadlines/${existing.id}`, {
          method: "PATCH",
          body: { ...body, title: body.title ?? existing.title, status: f.done ? "done" : "open", ...(computedChanged ? { overrideReason: nn(f.reason) } : {}) },
        });
      } else {
        await api(`/firm/properties/${propertyId}/deadlines`, { method: "POST", body });
      }
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing?.id) return;
    try {
      await api(`/firm/deadlines/${existing.id}`, { method: "DELETE" });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const levelName = (l: Level) => (l === "bor" ? "BOR" : LEVEL_LABELS[l]);
  const appealName = appeals.find((a) => String(a.id) === f.appealId);
  const placeholder = `${appealName ? `${levelName(appealName.level)} ` : ""}${KIND_LABELS[f.kind].toLowerCase()}`.replace(/^./, (x) => x.toUpperCase());

  return (
    <Sheet
      eyebrow={existing ? "Edit deadline" : "New deadline"}
      title={existing ? existing.title : "Add a deadline"}
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          {error && <span className="error" style={{ margin: 0, flexBasis: "100%" }} role="alert">{error}</span>}
          {existing && (confirmDelete ? (
            <span className="confirm" style={{ flexBasis: "100%" }}>
              Delete this deadline?
              <button type="button" className="btn small danger" onClick={() => void remove()}>Delete</button>
              <button type="button" className="btn small secondary" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          ) : <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>Delete</button>)}
          <span className="sp" />
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || !f.dueOn || (computedChanged && !f.reason.trim())}>{busy ? "Saving" : "Save deadline"}</button>
        </>
      }
    >
      <div className="fgrid">
        <div className="fld">
          <label htmlFor="dl-kind">Type</label>
          <select id="dl-kind" className="in" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
            {(Object.keys(KIND_LABELS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="dl-appeal">Appeal</label>
          <select id="dl-appeal" className="in" value={f.appealId} onChange={(e) => setF({ ...f, appealId: e.target.value })}>
            <option value="">Whole property</option>
            {appeals.map((a) => <option key={a.id} value={a.id}>{a.assessment_year} {LEVEL_LABELS[a.level]}</option>)}
          </select>
        </div>
        <div className="fld span2">
          <label htmlFor="dl-title">Name</label>
          <input id="dl-title" className="in" value={f.title} placeholder={placeholder} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <span className="hint">Leave blank to use “{placeholder}”.</span>
        </div>
        <div className="fld">
          <label htmlFor="dl-date">Date</label>
          <input id="dl-date" type="date" className="in" value={f.dueOn} required onChange={(e) => setF({ ...f, dueOn: e.target.value })} />
        </div>
        {f.kind === "hearing" ? (
          <div className="fld">
            <label htmlFor="dl-time">Time</label>
            <input id="dl-time" type="time" className="in" value={f.dueTime} onChange={(e) => setF({ ...f, dueTime: e.target.value })} />
          </div>
        ) : <div />}
        {f.kind === "hearing" && (
          <div className="fld span2">
            <label htmlFor="dl-where">Where</label>
            <input id="dl-where" className="in" value={f.location} placeholder="Room 1-200, Wheaton, or a video link" onChange={(e) => setF({ ...f, location: e.target.value })} />
          </div>
        )}
        <div className="fld span2">
          <label htmlFor="dl-notes">Notes</label>
          <textarea id="dl-notes" className="in" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </div>
        {computedChanged && (
          <div className="fld span2">
            <label htmlFor="dl-reason">Why change the date the app worked out?</label>
            <input id="dl-reason" className="in" value={f.reason} required onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </div>
        )}
      </div>
      {existing && <label className="check"><input type="checkbox" checked={f.done} onChange={(e) => setF({ ...f, done: e.target.checked })} /> Done</label>}
    </Sheet>
  );
}
