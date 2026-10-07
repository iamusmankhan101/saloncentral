/**
 * GET  /api/notifications/broadcast — subscriber count + whether push is configured
 * POST /api/notifications/broadcast — send a push to this salon's subscribers
 *
 * Authenticated: the tenant comes from `resolveActor` (the session cookie),
 * never from the request body, so a salon can only ever notify devices that
 * subscribed to it. Optional `clientId` narrows a broadcast to one customer's
 * devices — the path an appointment reminder or a "your stylist is ready" ping
 * would use.
 */

import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import {
  broadcastToSalon,
  countSubscriptions,
  isPushConfigured,
  type PushPayload,
} from "@/lib/push";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const subscribers = await countSubscriptions(actor.userId);
  return Response.json({ ok: true, configured: isPushConfigured(), subscribers });
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  // Staff can view the dashboard but shouldn't be able to message the whole
  // client list — broadcasting is an owner/manager action.
  if (actor.role === "staff") {
    return Response.json({ ok: false, error: "Not permitted" }, { status: 403 });
  }

  // A broadcast reaches every customer device at once; cap how often one salon
  // can fire one so a stuck retry loop can't spam their client base.
  const limited = await rateLimit("push-broadcast", actor.userId, {
    windowMs: 60 * 60 * 1000,
    maxAttempts: 20,
    blockMs: 30 * 60 * 1000,
  });
  if (limited.blocked) {
    return Response.json(
      { ok: false, error: "Broadcast limit reached. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter ?? 1800) } },
    );
  }

  if (!isPushConfigured()) {
    return Response.json(
      {
        ok: false,
        error:
          "Push is not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, " +
          "then redeploy (generate a pair with `npx web-push generate-vapid-keys`).",
      },
      { status: 503 },
    );
  }

  let body: {
    title?: string;
    body?: string;
    url?: string;
    image?: string;
    tag?: string;
    clientId?: string | null;
    requireInteraction?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const title = body.title?.trim();
  const text  = body.body?.trim();
  if (!title) return Response.json({ ok: false, error: "Title is required" }, { status: 400 });
  if (!text)  return Response.json({ ok: false, error: "Message is required" }, { status: 400 });

  // Push services cap the encrypted payload at ~4KB; trim well inside it since
  // nothing longer would be displayed by the OS anyway.
  const payload: PushPayload = {
    title: title.slice(0, 80),
    body:  text.slice(0, 300),
    url:   safeUrl(body.url) ?? `/client/${encodeURIComponent(actor.userId)}`,
    image: safeUrl(body.image),
    tag:   body.tag?.trim().slice(0, 40) || undefined,
    requireInteraction: Boolean(body.requireInteraction),
  };

  try {
    const result = await broadcastToSalon(actor.userId, payload, body.clientId?.trim() || null);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[broadcast] failed:", err);
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

/**
 * Accepts a same-origin path or an https URL. A javascript:/data: target here
 * would be handed straight to clients.openWindow() in the service worker.
 */
function safeUrl(value?: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (v.startsWith("/") && !v.startsWith("//")) return v.slice(0, 500);
  if (/^https:\/\//i.test(v)) return v.slice(0, 500);
  return undefined;
}
