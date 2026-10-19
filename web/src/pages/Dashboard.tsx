import { Link } from "react-router-dom";
import { useSession } from "../App";
import { useApi } from "../data";
import { formatMoney } from "../format";
import { LEVELS, LEVEL_LABELS } from "../../../shared/domain";

interface Summary {
  accounts: number;
  properties: number;
  activeProperties: number;
  appeals: number;
  savingsAchieved: string;
  savingsInPlay: string;
  openAppealsByLevel: Record<string, number>;
}

export function Dashboard() {
  const { me } = useSession();
  const { data: summary, error } = useApi<Summary>("/firm/summary");
  const max = summary ? Math.max(1, ...Object.values(summary.openAppealsByLevel)) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Dashboard</div>
          <h1>{me.firm?.name}</h1>
          {summary && (
            <div className="subtitle">
              {summary.activeProperties} active properties · {summary.accounts} clients · {summary.appeals} appeals on file
            </div>
          )}
        </div>
        <div className="actions"><Link className="btn secondary" to="/properties">Open properties</Link></div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {summary && (
        <>
          <div className="kpis">
            <div className="card kpi"><span className="label">Active properties</span><span className="value">{summary.activeProperties}</span><span className="note">of {summary.properties} on file</span></div>
            <div className="card kpi"><span className="label">Clients</span><span className="value">{summary.accounts}</span><span className="note">Accounts</span></div>
            <div className="card kpi"><span className="label">Estimated savings in play</span><span className="value">{formatMoney(summary.savingsInPlay)}</span><span className="note">First-year, open appeals</span></div>
            <div className="card kpi"><span className="label">Savings achieved</span><span className="value good">{formatMoney(summary.savingsAchieved)}</span><span className="note">Reduced appeals, all years</span></div>
          </div>
          <div className="grid g-8-4">
            <section className="card">
              <div className="ch"><h3>Properties at each level</h3><span className="meta">Current open appeal per property</span></div>
              <div className="bars">
                {LEVELS.map((l, i) => (
                  <div key={l} style={{ display: "contents" }}>
                    <span>{LEVEL_LABELS[l]}</span>
                    <div className={`bar${i >= 2 ? " alt" : ""}`} style={{ width: `${(summary.openAppealsByLevel[l] / max) * 100}%`, minWidth: 2 }} />
                    <span className="num" style={{ textAlign: "right" }}>{summary.openAppealsByLevel[l]}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="card">
              <div className="ch"><h3>Coming in build step 4</h3></div>
              <div className="cb">
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                  Window watch, the pipeline by level and substage, the fee forecast, and win rates. They build on the property screens and the calendar, which are now in place.
                </p>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
