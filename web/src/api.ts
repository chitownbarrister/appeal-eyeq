export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> | null = null) {
    super(message);
  }
}

/** Fired when the server says the session has ended, so the app can return to sign-in. */
export const SIGNED_OUT_EVENT = "aeq:signed-out";

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: { error?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 401 && !path.startsWith("/auth/")) {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data as Record<string, unknown> | null);
  return data as T;
}

export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export interface Me {
  user: { id: number; name: string; email: string; role: "attorney" | "analyst" | "operations" | null; isSuperAdmin: boolean; isFirmAdmin: boolean };
  firm: { id: number; name: string; isSample: boolean; logoAt?: string | null } | null;
  acting: { firmId: number; firmName: string; grantExpiresAt: string } | null;
  permissions: string[];
  preferences?: { showValueCents: boolean };
}
