import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, type Me } from "./api";
import { Login } from "./pages/Login";
import { Shell } from "./components/Shell";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { Admin } from "./pages/Admin";
import { Placeholder } from "./pages/Placeholder";

interface Session {
  me: Me;
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
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/auth/me"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST", body: {} });
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return null;
  if (!me) return <Login onSignedIn={refresh} />;

  const superAdminOutside = me.user.isSuperAdmin && !me.acting;

  return (
    <SessionContext.Provider value={{ me, refresh, logout }}>
      <Shell>
        {superAdminOutside ? (
          <Routes>
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/properties" element={<Placeholder title="Properties" step={2} detail="The property grid, filters, and each property's year track, appeals, values and parcels." />} />
            <Route path="/accounts" element={<Placeholder title="Accounts" step={2} detail="Clients, their fee terms, contacts and properties." />} />
            <Route path="/calendar" element={<Placeholder title="Calendar" step={3} detail="Township filing windows, hearings and deadlines." />} />
            <Route path="/decisions" element={<Placeholder title="Decisions" step={6} detail="Upload a batch of decision letters, review the matches, and apply them." />} />
            <Route path="/billing" element={<Placeholder title="Billing" step={7} detail="Invoices, statements, payments and refunds." />} />
            <Route path="/settings" element={<Settings />} />
            {me.user.isSuperAdmin && <Route path="/admin" element={<Admin />} />}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        )}
      </Shell>
    </SessionContext.Provider>
  );
}
