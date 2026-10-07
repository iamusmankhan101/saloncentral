/**
 * POST   /api/subscribe — store a browser push subscription for a salon's customer
 * DELETE /api/subscribe — remove one (customer turned notifications off)
 *
 * Public by design: the caller is a walk-in customer who scanned a QR code and
 * has no session. The tenant is therefore taken from the body's `salonId`, and
 * validated against the users table so the endpoint can't be used to seed rows
 * under a salon that doesn't exist. Rate-limited per IP for the same reason the
 * public booking route is.
 */

import { NextRequest } from "next/server";
import { savePushSubscription, deletePushSubscription, isValidSubscription } from "@/lib/push";
import { getUserById } from "@/lib/auth-db";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = await rateLimit("push-subscribe", clientIp(req), {
    windowMs: 10 * 60 * 1000,
    maxAttempts: 30,
    blockMs: 15 * 60 * 1000,
  });
  if (limited.blocked) {
    return Response.json(
      { ok: false, error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter ?? 900) } },
    );
  }

  let body: {
    salonId?: string;
    clientId?: string | null;
    subscription?: unknown;
    previousEndpoint?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const salonId = body.salonId?.trim();
  if (!salonId) return Response.json({ ok: false, error: "Missing salonId" }, { status: 400 });

  if (!isValidSubscription(body.subscription)) {
    return Response.json({ ok: false, error: "Invalid push subscription" }, { status: 400 });
  }

  // Reject unknown tenants rather than storing rows nothing will ever read.
  const salon = await getUserById(salonId);
  if (!salon) return Response.json({ ok: false, error: "Unknown salon" }, { status: 404 });

  try {
    await savePushSubscription({
      userId: salonId,
      clientId: body.clientId?.trim() || null,
      subscription: body.subscription,
      userAgent: req.headers.get("user-agent"),
      previousEndpoint: body.previousEndpoint ?? null,
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[subscribe] failed to save subscription:", err);
    return Response.json({ ok: false, error: "Failed to save subscription" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  let endpoint = req.nextUrl.searchParams.get("endpoint") ?? "";
  if (!endpoint) {
    try {
      const body = await req.json();
      endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    } catch {
      /* body is optional — the query string is the documented form */
    }
  }
  if (!endpoint) return Response.json({ ok: false, error: "Missing endpoint" }, { status: 400 });

  try {
    // The endpoint is an unguessable, browser-issued URL, so possessing it is
    // sufficient proof to remove it — the same assumption an unsubscribe link has.
    await deletePushSubscription(endpoint);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[subscribe] failed to delete subscription:", err);
    return Response.json({ ok: false, error: "Failed to remove subscription" }, { status: 500 });
  }
}
