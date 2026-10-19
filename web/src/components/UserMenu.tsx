import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSession } from "../App";
import { ROLE_LABELS } from "../../../shared/domain";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** The menu under the signed-in person's name: who they are, their account, firm settings, sign out. */
export function UserMenu() {
  const { me, logout } = useSession();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const insideFirm = !me.user.isSuperAdmin || Boolean(me.acting);
  const roleLabel = me.user.isSuperAdmin ? "Super admin" : me.user.role ? ROLE_LABELS[me.user.role] : "";
  const subtitle = me.user.isSuperAdmin
    ? me.acting ? `Super admin · viewing ${me.acting.firmName}` : "Super admin"
    : `${me.firm?.name ?? ""} · ${roleLabel}`;

  // Close on navigation, a click elsewhere, or Escape (which returns focus to the button).
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  function focusItem(i: number) {
    const all = items();
    if (all.length) all[(i + all.length) % all.length].focus();
  }
  function openWith(first: "first" | "last") {
    setOpen(true);
    requestAnimationFrame(() => focusItem(first === "first" ? 0 : -1));
  }
  function onButtonKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openWith("first"); }
    if (e.key === "ArrowUp") { e.preventDefault(); openWith("last"); }
  }
  function onMenuKey(e: KeyboardEvent) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(-1); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div className="usermenu" ref={wrap}>
      <button
        ref={button}
        className={`um-btn${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="user-menu"
        aria-label={`Account menu for ${me.user.name}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
      >
        <span className="who">
          {me.user.name}
          <small>{subtitle}</small>
        </span>
        <span className="avatar" aria-hidden="true">{initials(me.user.name)}</span>
        <svg className="caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      {open && (
        <div className="um-menu" id="user-menu" role="menu" aria-label="Account" ref={menu} onKeyDown={onMenuKey}>
          <div className="um-head">
            <b>{me.user.name}</b>
            <span>{me.user.email}</span>
            <span>
              {subtitle}
              {me.user.isFirmAdmin && !me.user.isSuperAdmin && <span className="pill copper">Firm admin</span>}
            </span>
          </div>
          <Link role="menuitem" to="/account">Your account</Link>
          {insideFirm && <Link role="menuitem" to="/settings">Firm settings</Link>}
          {insideFirm && me.user.isFirmAdmin && !me.user.isSuperAdmin && <Link role="menuitem" to="/settings?tab=integrations">Integrations</Link>}
          {me.user.isSuperAdmin && <Link role="menuitem" to="/admin">Firms &amp; reference data</Link>}
          <div className="um-sep" role="separator" />
          <button role="menuitem" onClick={() => void logout()}>Sign out</button>
        </div>
      )}
    </div>
  );
}
