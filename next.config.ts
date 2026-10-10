import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const securityHeaders = [
  // CSP is set dynamically in middleware.ts (nonce-based, per-request).
  // All other headers below are static and safe to set here.

  // ── HTTPS enforcement (HSTS) ──────────────────────────────────────────────
  // Tells browsers to always use HTTPS for 1 year. Only effective in production.
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" }]
    : []),

  // ── Prevent MIME sniffing ─────────────────────────────────────────────────
  { key: "X-Content-Type-Options", value: "nosniff" },

  // ── Block clickjacking ────────────────────────────────────────────────────
  { key: "X-Frame-Options", value: "DENY" },

  // ── Limit referrer information ────────────────────────────────────────────
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // ── Disable browser features the app doesn't use ─────────────────────────
  {
    key: "Permissions-Policy",
    // geolocation=(self): QR attendance check-in confirms the phone is at the salon.
    value: "camera=(), microphone=(), geolocation=(self), payment=(), usb=()",
  },

  // ── Prevent cross-site scripting via DNS prefetch ─────────────────────────
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  // Prevent Next.js from bundling @libsql/client — load it from Node.js at
  // runtime instead. Bundling it causes two class instances (ESM + CJS) which
  // breaks private class fields (#promiseLimitFunction).
  // sharp is a native module (salon-logo resizing for PWA icons) — same
  // reason as @libsql/client: bundling it breaks the native bindings.
  serverExternalPackages: ["@libsql/client", "sharp"],

  // The WhatsApp invoice PDF is built on the server and reads FBR's logo from
  // /public, which isn't part of a serverless function's files by default.
  outputFileTracingIncludes: { "/api/**": ["./public/fbr-pos-logo.png", "./public/report-logo.png"] },

  async headers() {
    // The public booking pages may be embedded in salons' own websites (the
    // WordPress plugin in wordpress-plugin/), so they skip X-Frame-Options;
    // middleware.ts sets their CSP frame-ancestors instead. Everything else stays DENY.
    const embeddable = securityHeaders.filter((h) => h.key !== "X-Frame-Options");
    return [
      { source: "/((?!book/|online-booking).*)", headers: securityHeaders },
      { source: "/book/:slug*", headers: embeddable },
      { source: "/online-booking", headers: embeddable },
    ];
  },
};

export default nextConfig;
