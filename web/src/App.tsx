import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, SIGNED_OUT_EVENT, type Me } from "./api";
import { clearLookupCache } from "./data";
import { Login } from "./pages/Login";
import { Shell } from "./components/Shell";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { MyAccount } from "./pages/MyAccount";
import { Admin } from "./pages/Admin";
import { Billing } from "./pages/Billing";
import { Pay } from "./pages/Pay";
import { Properties } from "./pages/Properties";
import { Property } from "./pages/Property";
import { Accounts } from "./pages/Accounts";
import { Account } from "./pages/Account";
import { Calendar } from "./pages/Calendar";
import { Decisions } from "./pages/Decisions";
import { setValueCents } from "./format";

interface Session {
  me: Me;
  can: (permission: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside provider");
  return s;
}

export function App() {
  // A client's pay link opens on its own, with no sign-in.
  const pay = window.location.pathname.match(/^\/pay\/([A-Za-z0-9_-]{20,100})\/?$/);
  if (pay) return <Pay token={pay[1]} />;
  return <FirmApp />;
}

function FirmApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [ended, setEnded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>("/auth/me");
      setValueCents(Boolean(m.preferences?.showValueCents));
      setMe(m);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    clearLookupCache();
    setEnded(false);
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // If the session ends while a page is open (signed out elsewhere, expired), return to sign-in.
  useEffect(() => {
    const onSignedOut = () => {
      clearLookupCache();
      setMe((current) => {
        if (current) setEnded(true);
        return null;
      });
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  if (loading) return null;
  if (!me) {
    return (
      <Login
        notice={ended ? "Your session ended, so you've been signed out. Sign in again to continue." : ""}
        onSignedIn={async () => {
          setEnded(false);
          clearLookupCache();
          await refresh();
        }}
      />
    );
  }

  const superAdminOutside = me.user.isSuperAdmin && !me.acting;
  const can = (permission: string) => !me.user.isSuperAdmin && me.permissions.includes(permission);

  return (
    <SessionContext.Provider value={{ me, can, refresh, logout }}>
      <Shell>
        {superAdminOutside ? (
          <Routes>
            <Route path="/admin" element={<Admin />} />
            <Route path="/account" element={<MyAccount />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/properties" element={<Properties />} />
            <Route path="/properties/:id" element={<Property />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/accounts/:id" element={<Account />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/account" element={<MyAccount />} />
            {me.user.isSuperAdmin && <Route path="/admin" element={<Admin />} />}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        )}
      </Shell>
    </SessionContext.Provider>
  );
}
