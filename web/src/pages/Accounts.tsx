import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../App";
import { useApi } from "../data";
import { formatMoney, titleCase } from "../format";
import { AccountSheet } from "../components/forms";

interface AccountRow {
  id: number; name: string; account_type: string; city: string | null; state: string | null; status: string; source: string | null;
  no_fee: boolean; fee_percent_first_year: string | null; fee_percent_refund: string | null; rep_name: string | null;
  properties: number; achieved_savings: string;
}

export function Accounts() {
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, error, reload } = useApi<{ accounts: AccountRow[] }>("/firm/accounts");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.accounts ?? []).filter((a) => !t || a.name.toLowerCase().includes(t) || (a.city ?? "").toLowerCase().includes(t));
  }, [data, q]);
  const terms = (a: AccountRow) =>
    a.no_fee ? "No fee" : a.fee_percent_first_year || a.fee_percent_refund ? `Custom: ${a.fee_percent_first_year ?? "default"}% / ${a.fee_percent_refund ?? "default"}%` : "Standard";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Accounts</div>
          <h1>Clients</h1>
          <div className="subtitle">{data?.accounts.length ?? 0} clients</div>
        </div>
        <div className="actions">
          {can("accounts.edit") && <button className="btn" onClick={() => setCreating(true)}>+ New client</button>}
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="card">
        <div className="ch"><h3>All clients <span className="meta">{rows.length}</span></h3></div>
        <div className="cb" style={{ paddingBottom: 8 }}>
          <div className="mselects" style={{ maxWidth: 320 }}>
            <label>Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or city" aria-label="Filter clients" /></label>
          </div>
        </div>
        <div className="tw">
          <table>
            <thead><tr><th>Client</th><th>Type</th><th>City</th><th className="num">Properties</th><th className="num">Achieved savings</th><th>Representative</th><th>Fee terms</th><th>Source</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => navigate(`/accounts/${a.id}`)}>
                  <td><Link className="mt" to={`/accounts/${a.id}`} onClick={(e) => e.stopPropagation()}>{a.name}</Link>{a.status !== "active" && <span className="mn">Inactive</span>}</td>
                  <td>{titleCase(a.account_type)}</td>
                  <td>{[a.city, a.state].filter(Boolean).join(", ")}</td>
                  <td className="num">{a.properties}</td>
                  <td className="num">{formatMoney(a.achieved_savings)}</td>
                  <td>{a.rep_name ?? "—"}</td>
                  <td>{terms(a)}</td>
                  <td className="meta">{a.source}</td>
                </tr>
              ))}
              {data && rows.length === 0 && <tr><td colSpan={8} className="meta" style={{ textAlign: "center", padding: 24 }}>{data.accounts.length ? "No clients match." : "No clients yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {creating && (
        <AccountSheet canEditFees={can("fees.edit")} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); void reload(); navigate(`/accounts/${id}`); }} />
      )}
    </>
  );
}
