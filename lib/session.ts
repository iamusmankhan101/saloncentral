/**
 * lib/session.ts
 * HMAC-signed session tokens stored in HTTP-only cookies.
 * No external JWT library required — uses Node built-in crypto.
 */

import { createHmac, timingSafeEqual, createHash } from "crypto";

// Resolved lazily at call time so the module can be imported during build
// without throwing (SESSION_SECRET is only available at runtime, not build time).
export function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET environment variable is required in production.");
  }
  return s ?? "dev-only-insecure-secret-change-before-deploy";
}

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Token ────────────────────────────────────────────────────────────────────

export function createSessionToken(userId: string): string {
  const expiry = Date.now() + SESSION_DURATION_MS;
  const payload = `${userId}:${expiry}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

export function verifySessionToken(token: string): string | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;

    const b64 = token.slice(0, dot);
    const sig  = token.slice(dot + 1);

    const payload  = Buffer.from(b64, "base64url").toString("utf8");
    const expected = createHmac("sha256", getSecret()).update(payload).digest("hex");

    // Reject if sig is the wrong length before timingSafeEqual (would throw)
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf   = Buffer.from(sig, "hex");
    if (actualBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

    const [userId, expiry] = payload.split(":");
    if (!userId || !expiry) return null;
    if (Date.now() > Number(expiry)) return null;

    return userId;
  } catch {
    return null;
  }
}

// ─── Cookie config ────────────────────────────────────────────────────────────

export const COOKIE_NAME = "werzio_session";

/** SHA-256 of the token — safe to store in DB (token itself stays secret). */
export function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const cookieOptions = {
  httpOnly:  true,
  secure:    process.env.NODE_ENV === "production",
  sameSite:  "lax" as const,   // "strict" would break email-verification redirects
  maxAge:    SESSION_DURATION_MS / 1000,  // seconds
  path:      "/",
};
