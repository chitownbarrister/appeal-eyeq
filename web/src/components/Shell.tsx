import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useSession } from "../App";
import { api } from "../api";
import { formatDateTime } from "../format";
import { EyeMark } from "./EyeMark";
import { GlobalSearch } from "./GlobalSearch";
import { UserMenu } from "./UserMenu";

const FIRM_NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/properties", label: "Properties" },
  { to: "/accounts", label: "Clients" },
  { to: "/calendar", label: "Calendar" },
  { to: "/decisions", label: "Decisions" },
  { to: "/billing", label: "Billing" },
];

export function Shell({ children }: { children: ReactNode }) {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const outsideFirm = me.user.isSuperAdmin && !me.acting;
  const nav = outsideFirm ? [{ to: "/admin", label: "Firms & reference data" }] : FIRM_NAV;

  async function exitFirm() {
    await api("/admin/exit", { method: "POST", body: {} });
    await refresh();
    navigate("/admin");
  }

  return (
    <>
      <header className="topbar">
        <NavLink to={outsideFirm ? "/admin" : "/dashboard"} className="brand" aria-label="Appeal EyeQ home">
          <EyeMark />
          <span className="brand-name">Appeal Eye<em>Q</em></span>
        </NavLink>
        <nav className="nav" aria-label="Main">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        {outsideFirm ? <span className="sp" /> : <GlobalSearch />}
        {!outsideFirm && me.firm?.logoAt && (
          <NavLink to="/settings?tab=firm" className="firm-logo" title={me.firm.name}>
            <img src={`/api/firm/billing/logo?v=${encodeURIComponent(me.firm.logoAt)}`} alt={`${me.firm.name} logo`} />
          </NavLink>
        )}
        <UserMenu />
      </header>
      {me.acting && (
        <div className="banner support" role="status">
          <span>
            Viewing <strong>{me.acting.firmName}</strong> under support access, read-only, until {formatDateTime(me.acting.grantExpiresAt)}.
            Every page you open is logged for the firm.
          </span>
          <button className="btn small secondary" onClick={() => void exitFirm()}>Exit firm</button>
        </div>
      )}
      {!me.acting && me.firm?.isSample && (
        <div className="banner sample" role="status">
          Sample data. Nichols Law is a demonstration firm; none of its clients or figures are real.
        </div>
      )}
      <main className="page">{children}</main>
    </>
  );
}
