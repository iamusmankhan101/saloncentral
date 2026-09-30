/**
 * /api/admin/pointly/* — the Pointly tab of the admin console.
 *
 * Pointly is a separate app with its own database, so rather than reach into
 * that database from here, every call is forwarded to Pointly's own
 * /api/admin/* routes, which keep owning its rules (password hashing, session
 * revocation, billing). Pointly accepts the call on the shared
 * LINKED_ADMIN_KEY — sent only from this server, never to the browser — and
 * records the Salon Central admin's email in its audit log.
 *
 * The caller must be a Salon Central platform admin; nothing is forwarded
 * otherwise.
 */

import { NextRequest } from "next/server";
import { getSessionUserId } from "@/lib/api-auth";
import { getUserById } from "@/lib/auth-db";

const POINTLY_URL = (process.env.POINTLY_URL ?? "").replace(/\/+$/, "");
const LINKED_ADMIN_KEY = process.env.LINKED_ADMIN_KEY ?? "";

// Pointly's admin surface: users, users/<id>, billing, invoice-settings, audit.
const ALLOWED_PATH = /^(users(\/[A-Za-z0-9_-]+)?|billing|invoice-settings|audit)$/;

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const actorId = await getSessionUserId(req);
  const actor = actorId ? await getUserById(actorId) : null;
  if (!actor || actor.role !== "admin") {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  if (!POINTLY_URL || LINKED_ADMIN_KEY.length < 32) {
    return Response.json(
      { ok: false, error: "Pointly isn't connected yet — set POINTLY_URL and LINKED_ADMIN_KEY." },
      { status: 503 },
    );
  }

  const { path } = await ctx.params;
  const subPath = path.join("/");
  if (!ALLOWED_PATH.test(subPath)) {
    return Response.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const target = `${POINTLY_URL}/api/admin/${subPath}${req.nextUrl.search}`;
  const hasBody = req.method === "POST";

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
        "x-linked-admin-key": LINKED_ADMIN_KEY,
        "x-linked-admin-email": actor.email,
      },
      body: hasBody ? await req.text() : undefined,
      cache: "no-store",
      redirect: "manual",
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    console.error("[admin/pointly] Forward error:", err);
    return Response.json({ ok: false, error: "Couldn't reach Pointly." }, { status: 502 });
  }
}

// The console only reads and posts actions — see Pointly's app/admin.
export const GET = forward;
export const POST = forward;
