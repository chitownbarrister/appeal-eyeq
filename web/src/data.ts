// Small shared data hooks. Lookups that rarely change (users, counties) are
// cached for the session; pages call reload() after they change something.

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";

export interface FirmUser { id: number; name: string; email: string; role: "attorney" | "analyst" | "operations"; is_firm_admin: boolean; active: boolean }
export interface County { id: number; state: string; name: string }
export interface Township { id: number; county_id: number; name: string; triad: string | null }

let usersCache: Promise<FirmUser[]> | null = null;
let countiesCache: Promise<{ counties: County[]; townships: Township[] }> | null = null;

export function clearLookupCache(): void {
  usersCache = null;
  countiesCache = null;
}

export function useFirmUsers(): FirmUser[] {
  const [users, setUsers] = useState<FirmUser[]>([]);
  useEffect(() => {
    usersCache ??= api<{ users: FirmUser[] }>("/firm/users").then((d) => d.users).catch(() => {
      usersCache = null;
      return [];
    });
    let live = true;
    void usersCache.then((u) => live && setUsers(u));
    return () => { live = false; };
  }, []);
  return users;
}

export function useCounties(): { counties: County[]; townships: Township[] } {
  const [data, setData] = useState<{ counties: County[]; townships: Township[] }>({ counties: [], townships: [] });
  useEffect(() => {
    countiesCache ??= api<{ counties: County[]; townships: Township[] }>("/reference/counties").catch(() => {
      countiesCache = null;
      return { counties: [], townships: [] };
    });
    let live = true;
    void countiesCache.then((d) => live && setData(d));
    return () => { live = false; };
  }, []);
  return data;
}

/** Load something from the API with loading and error state, plus a reload function. */
export function useApi<T>(path: string | null): { data: T | null; error: string; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}
