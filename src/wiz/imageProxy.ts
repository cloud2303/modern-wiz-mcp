import { createHmac, timingSafeEqual } from "node:crypto";

const ttlMs = 10 * 60 * 1000;

export function signImageProxy(input: { base: string; docId: string; name: string; secret: string; now?: number }) {
  const base = new URL(input.base);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) throw new Error("invalid base");
  const exp = (input.now ?? Date.now()) + ttlMs;
  const url = new URL(`/resources/${encodeURIComponent(input.docId)}/${encodeURIComponent(input.name)}`, base.origin);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", signature(input.secret, input.docId, input.name, exp));
  return { url: url.toString(), expiresAt: new Date(exp).toISOString() };
}

export function verifyImageProxy(input: { docId: string; name: string; exp: string; sig: string; secret: string; now?: number }) {
  const exp = Number(input.exp);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + ttlMs + 60_000) return false;
  const expected = Buffer.from(signature(input.secret, input.docId, input.name, exp));
  const actual = Buffer.from(input.sig);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signature(secret: string, docId: string, name: string, exp: number) {
  return createHmac("sha256", secret).update(`${docId}\n${name}\n${exp}`).digest("base64url");
}
