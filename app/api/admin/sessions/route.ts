/**
 * /api/admin/sessions
 * Admin-only: the devices an account is currently signed in on.
 *   GET    ?userId=…                    → list that account's active sessions
 *   DELETE { userId, sessionId }        → sign that one device out
 *   DELETE { userId, all: true }        → sign the account out everywhere
 */

import { NextRequest } from "next/server";
import { listActiveSessions, revokeAllSessionsForUser, revokeUserSession } from "@/lib/auth-db";
import { requireAdmin } from "@/lib/api-auth";
import { COOKIE_NAME, tokenId } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return Response.json({ ok: false, error: "Missing userId." }, { status: 400 });
  }

  try {
    const token = req.cookies.get(COOKIE_NAME)?.value;
    const currentId = token ? tokenId(token) : null;
    const sessions = await listActiveSessions(userId);
    return Response.json({
      ok: true,
      sessions: sessions.map((s) => ({ ...s, current: s.id === currentId })),
    });
  } catch (err) {
    console.error("[admin/sessions] Error listing sessions:", err);
    return Response.json({ ok: false, error: "Failed to load devices." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  let body: { userId?: string; sessionId?: string; all?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!body.userId || (!body.all && !body.sessionId)) {
    return Response.json({ ok: false, error: "Missing userId or sessionId." }, { status: 400 });
  }

  try {
    if (body.all) await revokeAllSessionsForUser(body.userId);
    else await revokeUserSession(body.userId, body.sessionId!);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[admin/sessions] Error revoking session:", err);
    return Response.json({ ok: false, error: "Failed to sign out device." }, { status: 500 });
  }
}
