export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data as T;
}

export interface Me {
  user: { id: number; name: string; email: string; role: "attorney" | "analyst" | null; isSuperAdmin: boolean };
  firm: { id: number; name: string; isSample: boolean } | null;
  acting: { firmId: number; firmName: string; grantExpiresAt: string } | null;
  permissions: string[];
}
