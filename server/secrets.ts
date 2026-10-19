// Encryption for secrets the app must store (Dropbox tokens) and signing for
// short-lived values it hands the browser (the Dropbox sign-in state).
// The key comes only from the TOKEN_ENCRYPTION_KEY environment variable, so
// a copy of the database alone can't be used to reach a firm's Dropbox.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key(purpose: "enc" | "sig"): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) throw Object.assign(new Error("no key"), { status: 503, publicMessage: "File storage isn't set up on this server yet (TOKEN_ENCRYPTION_KEY is missing)." });
  return createHash("sha256").update(`${purpose}:${raw}`).digest();
}

export function hasEncryptionKey(): boolean {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY && process.env.TOKEN_ENCRYPTION_KEY.length >= 32);
}

/** AES-256-GCM. Output: "v1.<iv>.<tag>.<ciphertext>", base64url parts. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key("enc"), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable secret");
  const d = createDecipheriv("aes-256-gcm", key("enc"), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

/** Signs a small JSON payload for a cookie; verify() returns it only if untampered and unexpired. */
export function sign(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const mac = createHmac("sha256", key("sig")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T extends Record<string, unknown>>(token: string | null | undefined): T | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key("sig")).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
  return data.exp > Date.now() ? data : null;
}
