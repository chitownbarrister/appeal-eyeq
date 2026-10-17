import { useEffect, useState } from "react";
import { api } from "../api";
import { useSession } from "../App";
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
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Summary>("/firm/summary").then(setSummary).catch((e: Error) => setError(e.message));
  }, []);

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
      </div>
      {error && <div className="error">{error}</div>}
      {summary && (
        <>
          <div className="kpis">
            <div className="card kpi">
              <div className="label">Active properties</div>
              <div className="value">{summary.activeProperties}</div>
              <div className="note">of {summary.properties} on file</div>
            </div>
            <div className="card kpi">
              <div className="label">Clients</div>
              <div className="value">{summary.accounts}</div>
              <div className="note">Accounts</div>
            </div>
            <div className="card kpi">
              <div className="label">Estimated savings in play</div>
              <div className="value">{formatMoney(summary.savingsInPlay)}</div>
              <div className="note">First-year, open appeals</div>
            </div>
            <div className="card kpi">
              <div className="label">Savings achieved</div>
              <div className="value">{formatMoney(summary.savingsAchieved)}</div>
              <div className="note">Reduced appeals, all years</div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>Properties at each level</h3>
              <span className="muted small">Current open appeal per property</span>
            </div>
            <div className="bars">
              {LEVELS.map((l, i) => (
                <div key={l} style={{ display: "contents" }}>
                  <span>{LEVEL_LABELS[l]}</span>
                  <div className={`bar${i >= 2 ? " alt" : ""}`} style={{ width: `${(summary.openAppealsByLevel[l] / max) * 100}%`, minWidth: 2 }} />
                  <span className="num" style={{ textAlign: "right" }}>{summary.openAppealsByLevel[l]}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>The full dashboard arrives in build step 4</h3>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Window watch, the pipeline by level and substage, the fee forecast, and win rates are built after the property
              screens and the filing-window calendar, since they read from both.
            </p>
          </div>
        </>
      )}
    </>
  );
}
