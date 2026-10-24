// The Dashboard modules added in 10e. Each loads its own data, so a module nobody has on their
// Dashboard costs nothing. Every number links to the list behind it, as on the rest of the Dashboard.

import { Link } from "react-router-dom";
import { useApi } from "../data";
import { formatDate, formatMoney, splitMatterTitle, titleCase } from "../format";
import { KPI_GROUPS, KPI_LEVELS, KPI_METRICS, KPI_YEARS, type ModuleInstance } from "../../../shared/dashboard";
import { PropertyAvatar } from "./PropertyPhoto";

export const toPropertySet = (ids: number[], label: string) => `/properties?${new URLSearchParams({ ids: ids.join(","), label, status: "all" })}`;
const qs = (s?: Record<string, string>) => (s && Object.keys(s).length ? `?${new URLSearchParams(s)}` : "");
const shortDate = (iso: string) => formatDate(iso).replace(/, \d{4}$/, "");
const place = (title: string) => splitMatterTitle(title).place;

/** The frame every module shares: a card with its title, an optional note, and the body. */
function Card({ title, meta, children, action }: { title: string; meta?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="card dmod">
      <div className="ch"><h3>{title}</h3>{action ?? (meta ? <span className="meta">{meta}</span> : null)}</div>
      <div className="dmod-body">{children}</div>
    </section>
  );
}
function Loading({ title, error }: { title: string; error: string }) {
  return <Card title={title}>{error ? <div className="error" role="alert">{error}</div> : <p className="meta dmod-pad">Loading</p>}</Card>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="meta dmod-pad" style={{ margin: 0 }}>{children}</p>;
}
const scopeText = (m: ModuleInstance) => (m.settings?.scope === "mine" ? "Yours" : "Everyone's");

// ---------------------------------------------------------------- deadlines and work
const KIND: Record<string, string> = { hearing: "Hearing", evidence: "Evidence", filing: "Filing", other: "Deadline", task: "Task", reminder: "Reminder", call: "Call", meeting: "Meeting", window: "Window" };

export function DeadlinesModule({ m }: { m: ModuleInstance }) {
  const { data, error } = useApi<{ overdue: number; items: { id: number; kind: string; title: string; dueOn: string; time: string | null; inDays: number; propertyId: number; property: string }[] }>(`/firm/dashboard/m/deadlines${qs(m.settings)}`);
  const title = "Deadlines and hearings, next 14 days";
  if (!data) return <Loading title={title} error={error} />;
  return (
    <Card title={title} meta={scopeText(m)}>
      {data.overdue > 0 && <div className="callout dmod-pad-x" role="status" style={{ marginBottom: 8 }}><b>{data.overdue} past due</b> and still open. <Link to="/calendar">Calendar</Link></div>}
      {data.items.length === 0 ? <Empty>Nothing due in the next 14 days.</Empty> : (
        <ul className="dlist">
          {data.items.map((d) => (
            <li key={d.id}>
              <span className={`pill ${d.kind === "hearing" ? "net" : d.inDays <= 3 ? "crit" : "grey"}`}>{d.inDays === 0 ? "Today" : d.inDays === 1 ? "Tomorrow" : shortDate(d.dueOn)}</span>
              <span className="dl-main">
                <Link to={`/properties/${d.propertyId}`}>{d.title}</Link>
                <span className="mn">{KIND[d.kind] ?? "Deadline"}{d.time ? ` · ${d.time}` : ""} · {place(d.property)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TasksModule({ m }: { m: ModuleInstance }) {
  const { data, error } = useApi<{ items: { id: number; kind: string; subject: string; dueOn: string | null; time: string | null; overdue: boolean; assigned: string | null; propertyId: number | null; accountId: number | null; about: string | null }[] }>(`/firm/dashboard/m/tasks${qs(m.settings)}`);
  if (!data) return <Loading title="Tasks" error={error} />;
  return (
    <Card title="Tasks" meta={`${scopeText(m)} · open`}>
      {data.items.length === 0 ? <Empty>No open tasks.</Empty> : (
        <ul className="dlist">
          {data.items.map((t) => (
            <li key={t.id}>
              <span className={`pill ${t.overdue ? "crit" : t.dueOn ? "grey" : "net"}`}>{t.dueOn ? (t.overdue ? `Due ${shortDate(t.dueOn)}` : shortDate(t.dueOn)) : "No date"}</span>
              <span className="dl-main">
                {t.propertyId ? <Link to={`/properties/${t.propertyId}?tab=activities`}>{t.subject}</Link> : t.accountId ? <Link to={`/accounts/${t.accountId}`}>{t.subject}</Link> : <Link to="/calendar">{t.subject}</Link>}
                <span className="mn">{KIND[t.kind]}{t.time ? ` · ${t.time}` : ""}{t.about ? ` · ${place(t.about)}` : ""}{m.settings?.scope !== "mine" && t.assigned ? ` · ${t.assigned}` : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function WeekModule({ m }: { m: ModuleInstance }) {
  const { data, error } = useApi<{ from: string; to: string; today: string; days: { day: string; items: { kind: string; title: string; time: string | null; to: string }[] }[] }>(`/firm/dashboard/m/week${qs(m.settings)}`);
  if (!data) return <Loading title="This week" error={error} />;
  return (
    <Card title="This week" action={<Link className="meta" to="/calendar">{shortDate(data.from)} to {shortDate(data.to)} · Calendar</Link>}>
      <div className="wk" role="list">
        {data.days.map((d) => {
          const dt = new Date(`${d.day}T12:00:00`);
          return (
            <div key={d.day} role="listitem" className={`wk-day${d.day === data.today ? " today" : ""}${d.day < data.today ? " past" : ""}`}>
              <div className="wk-h"><b>{dt.toLocaleDateString("en-US", { weekday: "short" })}</b> {dt.getDate()}</div>
              {d.items.length === 0 ? <span className="wk-none" aria-label="Nothing">·</span> : d.items.map((it, i) => (
                <Link key={i} to={it.to} className={`wk-it k-${it.kind}`} title={`${KIND[it.kind] ?? ""}${it.time ? ` ${it.time}` : ""}: ${it.title}`}>
                  {it.time && <span className="wk-t">{it.time}</span>}{it.title}
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function DecisionsModule() {
  const { data, error } = useApi<{ hidden?: boolean; review: number; clean: number; reading: number; items: { id: number; status: string; readOn: string; property: string | null }[] }>("/firm/dashboard/m/decisions");
  if (!data) return <Loading title="Decisions to review" error={error} />;
  if (data.hidden) return <Card title="Decisions to review"><Empty>Decision letters aren't shown under support access.</Empty></Card>;
  return (
    <Card title="Decisions to review" action={<Link className="meta" to="/decisions">Decisions</Link>}>
      <div className="dnum-row">
        <Link className="dnum" to="/decisions?view=clean"><b>{data.clean}</b><span>matched cleanly</span></Link>
        <Link className="dnum" to="/decisions?view=review"><b className={data.review ? "warn" : ""}>{data.review}</b><span>to review</span></Link>
      </div>
      {data.reading > 0 && <p className="meta dmod-pad" style={{ margin: "0 0 6px" }}>{data.reading} file{data.reading === 1 ? " is" : "s are"} still being read.</p>}
      {data.items.length === 0 ? <Empty>Nothing waiting. Upload letters on the Decisions page as they arrive.</Empty> : (
        <ul className="dlist">
          {data.items.map((l) => (
            <li key={l.id}>
              <span className={`pill ${l.status === "clean" ? "ok" : "warn"}`}>{l.status === "clean" ? "Clean" : "Review"}</span>
              <span className="dl-main"><Link to={`/decisions?view=${l.status}`}>{l.property ? place(l.property) : "No property matched"}</Link><span className="mn">Read {shortDate(l.readOn)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- money
export function RefundsModule() {
  const { data, error } = useApi<{ count: number; total: string; ids: number[]; items: { appealId: number; propertyId: number; property: string; client: string; appeal: string; expected: string | null; days: number | null }[] }>("/firm/dashboard/m/refunds");
  if (!data) return <Loading title="Awaiting refund" error={error} />;
  return (
    <Card title="Awaiting refund" action={<Link className="meta" to="/decisions?view=refunds">Refunds</Link>}>
      <div className="dbig dmod-pad"><b>{formatMoney(data.total)}</b><span>{data.count ? <Link className="nlink" to={toPropertySet(data.ids, "Awaiting refund")}>{data.count} refund{data.count === 1 ? "" : "s"}</Link> : "No refunds"} expected</span></div>
      {data.items.length > 0 && (
        <ul className="dlist">
          {data.items.map((r) => (
            <li key={r.appealId}>
              <span className={`pill ${(r.days ?? 0) > 120 ? "warn" : "grey"}`}>{r.days === null ? "Waiting" : `${r.days} days`}</span>
              <span className="dl-main"><Link to={`/properties/${r.propertyId}?appeal=${r.appealId}`}>{place(r.property)}</Link><span className="mn">{r.appeal} · {r.client}</span></span>
              <span className="num">{r.expected ? formatMoney(r.expected) : "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ReadyToBillModule() {
  const { data, error } = useApi<{ count: number; total: string; needsTax: number; ids: number[]; items: { appealId: number; propertyId: number; property: string; client: string; appeal: string; fee: string }[] }>("/firm/dashboard/m/readyToBill");
  if (!data) return <Loading title="Ready to bill" error={error} />;
  return (
    <Card title="Ready to bill" action={<Link className="meta" to="/billing?view=ready">Billing</Link>}>
      <div className="dbig dmod-pad"><b>{formatMoney(data.total)}</b><span>{data.count ? <Link className="nlink" to={toPropertySet(data.ids, "Ready to bill")}>{data.count} reduction{data.count === 1 ? "" : "s"}</Link> : "Nothing"} to invoice</span></div>
      {data.needsTax > 0 && <p className="dmod-pad" style={{ margin: "0 0 8px", fontSize: 12.5 }}><Link to="/billing">{data.needsTax} more need{data.needsTax === 1 ? "s" : ""} tax figures</Link> before {data.needsTax === 1 ? "it" : "they"} can be billed.</p>}
      {data.items.length > 0 && (
        <ul className="dlist">
          {data.items.map((r) => (
            <li key={r.appealId}>
              <span className="dl-main"><Link to={`/properties/${r.propertyId}?appeal=${r.appealId}`}>{place(r.property)}</Link><span className="mn">{r.appeal} · {r.client}</span></span>
              <span className="num">{formatMoney(r.fee)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AgingModule() {
  const { data, error } = useApi<{ total: string; count: number; buckets: { key: string; label: string; count: number; total: string }[] }>("/firm/dashboard/m/aging");
  if (!data) return <Loading title="Aged receivables" error={error} />;
  const max = Math.max(1, ...data.buckets.map((b) => Number(b.total)));
  return (
    <Card title="Aged receivables" action={<Link className="meta" to="/billing?view=unpaid">{data.count} unpaid · {formatMoney(data.total)}</Link>}>
      {data.count === 0 ? <Empty>No unpaid invoices.</Empty> : (
        <div className="bars aging">
          {data.buckets.map((b) => (
            <div key={b.key} style={{ display: "contents" }}>
              <span>{b.label}<span className="mn"> · {b.count}</span></span>
              <div className={`bar${b.key === "over" || b.key === "d90" ? " late" : ""}`} style={{ width: `${(Number(b.total) / max) * 100}%`, minWidth: Number(b.total) ? 4 : 0 }} title={`${b.label}: ${formatMoney(b.total)}`} />
              <span className="num" style={{ textAlign: "right" }}>{formatMoney(b.total)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function CollectedModule() {
  const { data, error } = useApi<{ month: string; year: string; lastYearToDate: string; months: { month: string; total: string }[] }>("/firm/dashboard/m/collected");
  if (!data) return <Loading title="Collected" error={error} />;
  const max = Math.max(1, ...data.months.map((m) => Number(m.total)));
  const y = data.months[0]?.month.slice(0, 4);
  return (
    <Card title="Collected" action={<Link className="meta" to="/billing?view=paid">Billing</Link>}>
      <div className="dnum-row">
        <div className="dnum"><b>{formatMoney(data.month)}</b><span>this month</span></div>
        <div className="dnum"><b>{formatMoney(data.year)}</b><span>{y} to date</span></div>
        <div className="dnum"><b className="muted">{formatMoney(data.lastYearToDate)}</b><span>same point last year</span></div>
      </div>
      {data.months.every((m) => Number(m.total) === 0) ? <Empty>No payments received yet this year.</Empty> : <div className="mbars dmod-pad" role="img" aria-label={`Collected by month: ${data.months.map((m) => `${m.month} ${formatMoney(m.total)}`).join(", ")}`}>
        {data.months.map((m) => (
          <div key={m.month} className="mbar" title={`${new Date(`${m.month}-15T12:00:00`).toLocaleDateString("en-US", { month: "long" })}: ${formatMoney(m.total)}`}>
            <span style={{ height: `${(Number(m.total) / max) * 100}%` }} />
            <i>{new Date(`${m.month}-15T12:00:00`).toLocaleDateString("en-US", { month: "narrow" })}</i>
          </div>
        ))}
      </div>}
    </Card>
  );
}

export function TrustModule() {
  const { data, error } = useApi<{ total: string; clients: number; items: { accountId: number; client: string; balance: string; lastOn: string }[] }>("/firm/dashboard/m/trust");
  if (!data) return <Loading title="Trust balances held" error={error} />;
  return (
    <Card title="Trust balances held" action={<Link className="meta" to="/billing?view=trust">Trust</Link>}>
      <div className="dbig dmod-pad"><b>{formatMoney(data.total)}</b><span>for {data.clients} client{data.clients === 1 ? "" : "s"}</span></div>
      {data.items.length > 0 && (
        <ul className="dlist">
          {data.items.map((b) => (
            <li key={b.accountId}>
              <span className="dl-main"><Link to={`/accounts/${b.accountId}`}>{b.client}</Link><span className="mn">Last entry {shortDate(b.lastOn)}</span></span>
              <span className="num">{formatMoney(b.balance)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ExpensesModule() {
  const { data, error } = useApi<{ total: string; count: number; open: number; items: { id: number; propertyId: number; property: string; vendor: string; description: string; amount: string; state: string; incurredOn: string }[] }>("/firm/dashboard/m/expenses");
  if (!data) return <Loading title="Expenses not yet recovered" error={error} />;
  return (
    <Card title="Expenses not yet recovered" action={<Link className="meta" to="/billing?view=expenses">Billing</Link>}>
      <div className="dbig dmod-pad"><b>{formatMoney(data.total)}</b><span>{data.count} expense{data.count === 1 ? "" : "s"}{data.open < data.count ? `, ${data.count - data.open} on a bill not yet paid` : ""}</span></div>
      {data.items.length > 0 && (
        <ul className="dlist">
          {data.items.map((e) => (
            <li key={e.id}>
              <span className="dl-main"><Link to={`/properties/${e.propertyId}?tab=billing`}>{e.vendor}</Link><span className="mn">{e.description} · {place(e.property)}</span></span>
              <span className="num">{formatMoney(e.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- results and matters
export function TopClientsModule({ m }: { m: ModuleInstance }) {
  const { data, error } = useApi<{ year: number | null; items: { accountId: number; client: string; savings: string; appeals: number }[] }>(`/firm/dashboard/m/topClients${qs(m.settings)}`);
  if (!data) return <Loading title="Top clients by savings" error={error} />;
  const max = Math.max(1, ...data.items.map((i) => Number(i.savings)));
  return (
    <Card title="Top clients by savings" meta={data.year ? `${data.year} assessment year` : "All years"}>
      {data.items.length === 0 ? <Empty>No savings recorded{data.year ? ` for ${data.year}` : ""} yet.</Empty> : (
        <div className="bars money">
          {data.items.map((i) => (
            <div key={i.accountId} style={{ display: "contents" }}>
              <span><Link className="nlink" to={`/accounts/${i.accountId}`}>{i.client}</Link></span>
              <div className="bar" style={{ width: `${(Number(i.savings) / max) * 100}%`, minWidth: 4 }} title={`${i.appeals} reduced appeal${i.appeals === 1 ? "" : "s"}`} />
              <span className="num" style={{ textAlign: "right" }}>{formatMoney(i.savings)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function SavingsByYearModule() {
  const { data, error } = useApi<{ years: { year: number; savings: string; appeals: number; ids: number[] }[] }>("/firm/dashboard/m/savingsByYear");
  if (!data) return <Loading title="Savings achieved by year" error={error} />;
  const max = Math.max(1, ...data.years.map((y) => Number(y.savings)));
  return (
    <Card title="Savings achieved by year" meta="Reduced appeals, by assessment year">
      {data.years.length === 0 ? <Empty>No reductions recorded yet.</Empty> : (
        <div className="mbars tall dmod-pad">
          {data.years.map((y) => (
            <Link key={y.year} className="mbar" to={toPropertySet(y.ids, `Savings achieved, ${y.year}`)} title={`${y.year}: ${formatMoney(y.savings)} across ${y.appeals} appeal${y.appeals === 1 ? "" : "s"}`}>
              <b>{formatMoney(y.savings).replace(/\.\d\d$/, "")}</b>
              <span style={{ height: `${(Number(y.savings) / max) * 100}%` }} />
              <i>{y.year}</i>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

export function RecentPropertiesModule() {
  const { data, error } = useApi<{ items: { id: number; title: string; client: string; assetType: string; photoAt: string | null; addedOn: string }[] }>("/firm/dashboard/m/recentProperties");
  if (!data) return <Loading title="Recently added properties" error={error} />;
  return (
    <Card title="Recently added properties" action={<Link className="meta" to="/properties">Properties</Link>}>
      {data.items.length === 0 ? <Empty>No properties yet.</Empty> : (
        <ul className="dlist">
          {data.items.map((p) => (
            <li key={p.id}>
              <PropertyAvatar id={p.id} photoAt={p.photoAt} assetType={p.assetType} size={30} label={place(p.title)} />
              <span className="dl-main"><Link to={`/properties/${p.id}`}>{place(p.title)}</Link><span className="mn">{p.client} · added {shortDate(p.addedOn)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function CoCounselModule() {
  const { data, error } = useApi<{ count: number; ids: number[]; firms: { firm: string; items: { propertyId: number; property: string; client: string; role: string; percent: string | null }[] }[] }>("/firm/dashboard/m/coCounsel");
  if (!data) return <Loading title="Co-counseled matters" error={error} />;
  return (
    <Card title="Co-counseled matters" action={data.count ? <Link className="meta" to="/properties?flag=co_counsel&status=all">{data.count} propert{data.count === 1 ? "y" : "ies"}</Link> : undefined}>
      {data.firms.length === 0 ? <Empty>No co-counseled properties.</Empty> : data.firms.map((f) => (
        <div key={f.firm} className="cc-firm">
          <h4 className="subhead dmod-pad">{f.firm}</h4>
          <ul className="dlist">
            {f.items.map((p) => (
              <li key={p.propertyId}>
                <span className="cc-mark" aria-hidden="true">*</span>
                <span className="dl-main"><Link to={`/properties/${p.propertyId}`}>{place(p.property)}</Link><span className="mn">{p.client} · we're the {p.role} firm{p.percent ? ` · their share ${Number(p.percent)}%` : ""}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

const PURPOSE: Record<string, string> = { migration: "Firm migration", new: "New clients and matters", update: "Bulk update" };
export function ImportsModule() {
  const { data, error } = useApi<{ hidden?: boolean; items: { id: number; purpose: string; status: string; files: number; by: string | null; at: string; added: number; changed: number }[] }>("/firm/dashboard/m/imports");
  if (!data) return <Loading title="Recent imports" error={error} />;
  if (data.hidden) return <Card title="Recent imports"><Empty>Imports aren't shown under support access.</Empty></Card>;
  return (
    <Card title="Recent imports" action={<Link className="meta" to="/import">Import</Link>}>
      {data.items.length === 0 ? <Empty>No imports yet.</Empty> : (
        <ul className="dlist">
          {data.items.map((b) => (
            <li key={b.id}>
              <span className={`pill ${b.status === "committed" ? "ok" : b.status === "previewed" || b.status === "draft" ? "copper" : "grey"}`}>{b.status === "committed" ? "Imported" : b.status === "undone" ? "Undone" : b.status === "draft" || b.status === "previewed" ? "Not committed" : titleCase(b.status)}</span>
              <span className="dl-main">
                <Link to={`/import?id=${b.id}`}>{PURPOSE[b.purpose] ?? b.purpose}</Link>
                <span className="mn">{shortDate(b.at.slice(0, 10))}{b.by ? ` · ${b.by}` : ""} · {b.files} file{b.files === 1 ? "" : "s"}{b.status === "committed" ? ` · ${b.added} added, ${b.changed} changed` : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** "Your number": one figure built from a metric and filters. */
export function CustomKpiModule({ m }: { m: ModuleInstance }) {
  const s = m.settings ?? {};
  const { data, error } = useApi<{ value: string; format: "count" | "money"; ids: number[] }>(`/firm/dashboard/kpi${qs(s)}`);
  const label = (list: [string, string][], v?: string) => list.find(([k]) => k === (v ?? ""))?.[1] ?? "";
  const name = label(KPI_METRICS, s.metric) || "Active properties";
  const filters = [s.level ? label(KPI_LEVELS, s.level) : "", s.group ? label(KPI_GROUPS, s.group) : "", s.year ? label(KPI_YEARS, s.year) : ""].filter(Boolean).join(" · ");
  const value = !data ? "…" : data.format === "money" ? formatMoney(data.value) : Number(data.value).toLocaleString("en-US");
  const to = data && data.ids.length ? toPropertySet(data.ids, [name, filters].filter(Boolean).join(", ")) : null;
  const body = (
    <>
      <span className="label">{name}</span>
      <span className="value">{error ? "—" : value}</span>
      <span className="note">{filters || "All of them"}</span>
    </>
  );
  return to ? <Link className="card kpi kpi-link dmod-kpi" to={to}>{body}</Link> : <div className="card kpi dmod-kpi">{body}</div>;
}
