/**
 * POST /api/auth/signin-log
 * Browser-side sign-in diagnostics (page opened, button pressed, errors).
 * See lib/signin-log.ts.
 */

import { NextRequest } from "next/server";
import { logSigninEvent } from "@/lib/signin-log";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const EVENTS = new Set(["page_loaded", "button_pressed", "success", "error", "timeout", "network_error", "js_error"]);

export async function POST(req: NextRequest) {
  const limit = await rateLimit("signin-log", clientIp(req), { maxAttempts: 60, blockMs: 15 * 60 * 1000 });
  if (limit.blocked) return new Response(null, { status: 204 });

  let body: { event?: unknown; email?: unknown; detail?: unknown };
  try {
    // sendBeacon posts text/plain, so parse the raw text rather than req.json().
    body = JSON.parse(await req.text());
  } catch {
    return new Response(null, { status: 204 });
  }

  if (typeof body.event === "string" && EVENTS.has(body.event)) {
    await logSigninEvent(
      req,
      "client",
      body.event,
      typeof body.email === "string" ? body.email : null,
      typeof body.detail === "string" ? body.detail : null,
    );
  }
  return new Response(null, { status: 204 });
}

/** Hit by a plain <img> on the sign-in page — records the visit even when JS never runs. */
export async function GET(req: NextRequest) {
  const limit = await rateLimit("signin-log", clientIp(req), { maxAttempts: 60, blockMs: 15 * 60 * 1000 });
  if (!limit.blocked) await logSigninEvent(req, "client", "html_loaded");
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
