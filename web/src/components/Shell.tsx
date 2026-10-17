import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useSession } from "../App";
import { api } from "../api";
import { formatDateTime } from "../format";
import { EyeMark } from "./EyeMark";

const FIRM_NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/properties", label: "Properties" },
  { to: "/accounts", label: "Accounts" },
  { to: "/calendar", label: "Calendar" },
  { to: "/decisions", label: "Decisions" },
  { to: "/billing", label: "Billing" },
  { to: "/settings", label: "Settings" },
];

export function Shell({ children }: { children: ReactNode }) {
  const { me, refresh, logout } = useSession();
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
        {!outsideFirm && (
          <label className="search" title="Global search arrives with the property screens (step 2)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.8-4.8" />
            </svg>
            <input placeholder="Search PIN, address, client" disabled aria-label="Search" />
          </label>
        )}
        <div className="usermenu" style={outsideFirm ? { marginLeft: "auto" } : undefined}>
          <div className="who">
            {me.user.name}
            <small>{me.user.isSuperAdmin ? "Super admin" : `${me.firm?.name} · ${me.user.role === "attorney" ? "Attorney" : "Analyst"}`}</small>
          </div>
          <button className="linkbtn" onClick={() => void logout()}>Sign out</button>
        </div>
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
