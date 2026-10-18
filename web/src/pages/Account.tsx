import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useSession } from "../App";
import { useApi } from "../data";
import { formatMoney, titleCase } from "../format";
import { LEVEL_LABELS, SUBSTAGE_LABELS, type Level, type Substage } from "../../../shared/domain";
import type { EffectiveFee } from "../../../shared/fees";
import { AccountSheet, PropertySheet, type AccountRecord } from "../components/forms";
import { ActivitiesTab, ContactsTab } from "./Property";

interface AccountDetail {
  account: AccountRecord & { rep_name: string | null };
  properties: { id: number; title: string; city: string | null; state: string; county: string; township: string | null; status: string; asset_type: string; level: Level | null; substage: Substage | null }[];
  savings: { assessment_year: number; savings: string }[];
  activeAppeals: number;
  contacts: Parameters<typeof ContactsTab>[0]["contacts"];
  activities: Parameters<typeof ActivitiesTab>[0]["activities"];
  fees: { firstYear: EffectiveFee; refund: EffectiveFee };
  achievedSavings: string;
}

type Tab = "properties" | "details" | "contacts" | "activities";

export function Account() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const { data, error, reload } = useApi<AccountDetail>(`/firm/accounts/${id}`);
  const [tab, setTab] = useState<Tab>("properties");
  const [sheet, setSheet] = useState<"edit" | "property" | null>(null);
  const [status, setStatus] = useState("");

  if (error) return <><Link className="back" to="/accounts">← Clients</Link><div className="error" role="alert">{error}</div></>;
  if (!data) return null;
  const a = data.account;
  const feeLine = (f: EffectiveFee) => `${f.percent}%${f.source === "account" ? "" : " (firm default)"}`;
  const props = data.properties.filter((p) => !status || p.status === status);

  return (
    <>
      <Link className="back" to="/accounts">← Clients</Link>
      <section className="card">
        <div className="dhead">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow">Tax appeal client · {titleCase(a.account_type)}</div>
            <h1 style={{ margin: "4px 0 6px" }}>{a.name}</h1>
            <div className="dmeta">
              {(a.address1 || a.city) && <span>{[a.address1, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</span>}
              <span>Representative <b>{a.rep_name ?? "Not assigned"}</b></span>
              {a.source && <span>Source {a.source}</span>}
              {a.email && <span style={{ userSelect: "all" }}>{a.email}</span>}
              {a.phone && <span>{a.phone}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {can("accounts.edit") && <button className="btn small secondary" onClick={() => setSheet("edit")}>Edit client</button>}
            {can("properties.edit") && <button className="btn small" onClick={() => setSheet("property")}>+ Property</button>}
          </div>
        </div>
        <div className="kpis" style={{ padding: "16px 22px 0", marginBottom: 0 }}>
          <div className="card kpi"><span className="label">Properties</span><span className="value">{data.properties.length}</span></div>
          <div className="card kpi"><span className="label">Appeals awaiting decision</span><span className="value">{data.activeAppeals}</span></div>
          <div className="card kpi"><span className="label">Achieved savings</span><span className="value good">{formatMoney(data.achievedSavings)}</span></div>
          <div className="card kpi">
            <span className="label">Fee terms</span>
            <span className="value" style={{ fontSize: 15, fontFamily: "var(--f-body)", fontWeight: 500 }}>
              {a.no_fee ? "No fee" : a.fee_type === "flat" ? `Flat ${a.flat_fee ? formatMoney(a.flat_fee) : ""}` : `${feeLine(data.fees.firstYear)} / ${feeLine(data.fees.refund)}`}
            </span>
            <span className="note">Assessor and BOR / PTAB and Court</span>
          </div>
        </div>
        <div className="subtabs" role="tablist">
          {(["properties", "details", "contacts", "activities"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{titleCase(t)}</button>
          ))}
        </div>
        <div className="pane">
          {tab === "properties" && (
            <>
              <div className="tbar">
                <select className="in" style={{ width: 160, height: 30 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Property status">
                  <option value="">All statuses</option><option value="active">Active</option><option value="closed">Closed</option><option value="inactive">Inactive</option><option value="sold">Sold</option>
                </select>
              </div>
              <div className="tw">
                <table className="compact">
                  <thead><tr><th>Property</th><th>County</th><th>Township</th><th>Status</th><th>Type</th><th>Level · substage</th></tr></thead>
                  <tbody>
                    {props.map((p) => (
                      <tr key={p.id} className="clickable" onClick={() => navigate(`/properties/${p.id}`)}>
                        <td><Link className="mt" to={`/properties/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.title}</Link></td>
                        <td>{p.county}</td><td>{p.township}</td>
                        <td><span className={`pill ${p.status === "active" ? "ok" : ""}`}>{titleCase(p.status)}</span></td>
                        <td>{titleCase(p.asset_type)}</td>
                        <td>{p.level ? `${LEVEL_LABELS[p.level]} · ${p.substage ? SUBSTAGE_LABELS[p.substage] : ""}` : "No appeal yet"}</td>
                      </tr>
                    ))}
                    {props.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 20 }}>No properties.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {tab === "details" && (
            <div className="grid g-2">
              <div className="blk">
                <h5>Name and address</h5>
                <ul className="tl">
                  <li><span className="k">Client</span><span>{a.name}</span></li>
                  <li><span className="k">Account number</span><span>{a.account_number ?? "—"}</span></li>
                  <li><span className="k">Address</span><span>{[a.address1, a.address2, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—"}</span></li>
                  <li><span className="k">Phone</span><span>{a.phone ?? "—"}</span></li>
                  <li><span className="k">Email</span><span>{a.email ?? "—"}</span></li>
                  <li><span className="k">Owners of record</span><span>{a.owners_of_record ?? "—"}</span></li>
                  <li><span className="k">Status</span><span>{titleCase(a.status)}</span></li>
                </ul>
              </div>
              <div className="blk">
                <h5>Fee information</h5>
                <ul className="tl">
                  <li><span className="k">Arrangement</span><span>{a.no_fee ? "No fee" : titleCase(a.fee_type)}</span></li>
                  <li><span className="k">Assessor and BOR</span><span>{feeLine(data.fees.firstYear)} of first-year savings</span></li>
                  <li><span className="k">PTAB and Court</span><span>{feeLine(data.fees.refund)} of the refund</span></li>
                  <li><span className="k">Cap</span><span>{a.fee_cap ? formatMoney(a.fee_cap) : "None"}</span></li>
                  <li><span className="k">Co-counsel</span><span>{a.co_counsel ? `${a.co_counsel}${a.co_counsel_fee ? ` (${a.co_counsel_fee})` : ""}` : "None"}</span></li>
                  <li><span className="k">Fee memo</span><span>{a.fee_memo ?? "—"}</span></li>
                </ul>
              </div>
              <div className="blk">
                <h5>Achieved savings by assessment year</h5>
                <ul className="tl">
                  {data.savings.map((s) => <li key={s.assessment_year}><span className="k">{s.assessment_year}</span><span className="num">{formatMoney(s.savings)}</span></li>)}
                  {data.savings.length === 0 && <li><span className="meta">None yet</span></li>}
                </ul>
              </div>
              <div className="blk"><h5>Notes</h5><p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{a.notes ?? <span className="meta">None</span>}</p></div>
            </div>
          )}
          {tab === "contacts" && <ContactsTab accountId={a.id} contacts={data.contacts} canEdit={can("accounts.edit")} onChanged={() => void reload()} />}
          {tab === "activities" && <ActivitiesTab target={{ accountId: a.id }} activities={data.activities} onChanged={() => void reload()} showProperty />}
        </div>
      </section>
      {sheet === "edit" && <AccountSheet existing={a} canEditFees={can("fees.edit")} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} />}
      {sheet === "property" && (
        <PropertySheet presetAccount={{ id: a.id, name: a.name }} accounts={[{ id: a.id, name: a.name }]} onClose={() => setSheet(null)} onSaved={(pid) => { setSheet(null); navigate(`/properties/${pid}`); }} />
      )}
    </>
  );
}
