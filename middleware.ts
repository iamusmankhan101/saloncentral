/**
 * middleware.ts — Edge-compatible (no Node.js crypto imports)
 *
 * Vercel/Next.js middleware runs on the Edge Runtime, which supports only
 * the Web Crypto API (globalThis.crypto). All session verification and nonce
 * generation uses crypto.subtle / crypto.getRandomValues instead of Node's
 * "crypto" module.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME  = "werzio_session";
const SESSION_SECRET_ENV = process.env.SESSION_SECRET;
// Only used outside production (or if SESSION_SECRET is unset locally). In
// production, a missing SESSION_SECRET must fail closed — falling back to a
// value visible in source would let anyone forge a session for any user ID.
const SESSION_SECRET = SESSION_SECRET_ENV ?? "dev-only-insecure-secret-change-before-deploy";
const SECRET_MISCONFIGURED_IN_PROD = process.env.NODE_ENV === "production" && !SESSION_SECRET_ENV;

const DASHBOARD = /^\/dashboard(\/|$)/;
const AUTH_PAGES = new Set(["/sign-in", "/sign-up"]);
// Public booking pages, which salons may embed in their own sites (WordPress plugin).
const EMBEDDABLE = /^\/(book\/|online-booking\/?$)/;

// ─── Edge-compatible token verification ──────────────────────────────────────
// Token format (from lib/session.ts): base64url(userId:expiry).hexHMAC

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function verifySessionToken(token: string): Promise<string | null> {
  // Fail closed: never verify a session against the known-public dev secret in production.
  if (SECRET_MISCONFIGURED_IN_PROD) return null;
  try {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;

    const b64Payload = token.slice(0, dot);
    const hexSig     = token.slice(dot + 1);
    if (!b64Payload || !hexSig || hexSig.length % 2 !== 0) return null;

    // base64url → UTF-8 payload string
    const payload = new TextDecoder().decode(
      Uint8Array.from(
        atob(b64Payload.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      ),
    );

    // Import HMAC-SHA-256 key for signing (Web Crypto, Edge-compatible)
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    // Re-compute HMAC over the payload
    const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const expected  = new Uint8Array(sigBuffer);
    const actual    = hexToBytes(hexSig);

    // Reject on length mismatch or signature mismatch (constant-time byte loop)
    if (expected.length !== actual.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    if (diff !== 0) return null;

    const [userId, expiry] = payload.split(":");
    if (!userId || !expiry) return null;
    if (Date.now() > Number(expiry)) return null;

    return userId;
  } catch {
    return null;
  }
}

// ─── Edge-compatible nonce generation ────────────────────────────────────────

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // btoa → base64; replace URL-unsafe chars for safety in CSP headers
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── HTTPS redirect in production ──────────────────────────────────────────
  if (
    process.env.NODE_ENV === "production" &&
    req.headers.get("x-forwarded-proto") === "http"
  ) {
    const httpsUrl = req.nextUrl.clone();
    httpsUrl.protocol = "https:";
    return NextResponse.redirect(httpsUrl, { status: 301 });
  }

  // ── Session check (crypto-only — no DB round-trip in Edge middleware) ─────
  // DB-level revocation is enforced in the API routes and signout handler.
  const token  = req.cookies.get(COOKIE_NAME)?.value ?? "";
  const userId = token ? await verifySessionToken(token) : null;

  // ── Protect dashboard routes ──────────────────────────────────────────────
  if (DASHBOARD.test(pathname) && !userId) {
    const dest = req.nextUrl.clone();
    dest.pathname = "/sign-in";
    dest.search   = "";
    return NextResponse.redirect(dest);
  }

  // ── Redirect authenticated users away from auth pages ────────────────────
  if (AUTH_PAGES.has(pathname) && userId) {
    const dest = req.nextUrl.clone();
    dest.pathname = "/dashboard";
    dest.search   = "";
    return NextResponse.redirect(dest);
  }

  // ── Nonce-based Content-Security-Policy ───────────────────────────────────
  const nonce  = generateNonce();
  const isProd = process.env.NODE_ENV === "production";

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // worker-src must be explicit: it falls back to script-src, and
    // 'strict-dynamic' there makes the browser ignore 'self', which would
    // block /sw.js from registering at all (PWA install + Web Push).
    "worker-src 'self'",
    "manifest-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.turso.io wss://*.turso.io https://api.resend.com https://graph.facebook.com https://api.qrserver.com https://api.wasenderapi.com",
    "frame-src 'none'",
    EMBEDDABLE.test(pathname) ? "frame-ancestors *" : "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    isProd ? "upgrade-insecure-requests" : "",
  ].filter(Boolean).join("; ");

  // Pass nonce to Server Components via request header
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: reqHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    // Run on all routes except static assets and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
