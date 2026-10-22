// Stripe, through its REST API (no SDK, so tests can point STRIPE_API_URL at a stand-in).
// Appeal EyeQ is the Connect platform; each firm's payments are made on the firm's own
// Stripe account (the Stripe-Account header), so money goes straight to the firm and the
// firm pays Stripe's fees. The platform secret key lives only in Render's environment.

import { createHmac, timingSafeEqual } from "node:crypto";

export const stripeApi = () => (process.env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/$/, "");
export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);

export class StripeError extends Error {
  constructor(public httpStatus: number, public code: string | null, message: string) { super(message); }
}

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=v. */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => parts.push(typeof x === "object" ? formEncode(x as Record<string, unknown>, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`));
    else if (typeof v === "object") parts.push(formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join("&");
}

export async function stripe<T = Record<string, unknown>>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, account?: string | null, idempotencyKey?: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError(0, "not_configured", "Stripe isn't set up on this server.");
  const body = formEncode(params);
  const url = `${stripeApi()}${path}${method === "GET" && body ? `?${body}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(account ? { "Stripe-Account": account } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? body : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
  if (!res.ok) throw new StripeError(res.status, data.error?.code ?? null, data.error?.message ?? `Stripe returned ${res.status}`);
  return data;
}

/**
 * Stripe's v2 API (JSON bodies, a pinned Stripe-Version). New Connect platforms create each
 * firm's account with POST /v2/core/accounts and its signup link with /v2/core/account_links;
 * everything else (Checkout, PaymentIntents, Customers, GET /v1/accounts) stays on v1, which
 * accepts v2 account ids.
 */
export const STRIPE_V2_VERSION = "2026-09-30.endive";

export async function stripeV2<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError(0, "not_configured", "Stripe isn't set up on this server.");
  const res = await fetch(`${stripeApi()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_V2_VERSION,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
  if (!res.ok) throw new StripeError(res.status, data.error?.code ?? null, data.error?.message ?? `Stripe returned ${res.status}`);
  return data;
}

/** Checks a webhook's Stripe-Signature header ("t=...,v1=...") against the raw body; refuses anything older than 5 minutes. */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2)) as Record<string, string>;
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/** A plain message for a Stripe failure. */
export function friendlyStripeError(err: unknown): string {
  if (err instanceof StripeError) {
    if (err.code === "not_configured") return "Online payments aren't set up on this server yet.";
    if (err.httpStatus === 401) return "Stripe didn't accept Appeal EyeQ's key. Check STRIPE_SECRET_KEY in Render.";
    if (err.code === "authentication_required") return "The bank or card needs the client to approve this payment. Send them the pay link instead.";
    if (err.code === "card_declined") return "The card was declined.";
    return `Stripe said: ${err.message}`.slice(0, 300);
  }
  return "Stripe didn't respond. Try again in a moment.";
}
