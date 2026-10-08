/**
 * Audit log of who opened or changed a patient's clinical record.
 *   POST { action, entity, clientId, detail? } — records it against the signed-in
 *        person (taken from the session, never from the body)
 *   GET  ?clientId=… — the log for one patient; owners and managers only
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { getUserById } from "@/lib/auth-db";

const ACTIONS = new Set(["view", "create", "edit", "delete", "sign", "download", "send", "upload"]);

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS clinic_audit_log (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      client_id  TEXT NOT NULL,
      actor_id   TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      action     TEXT NOT NULL,
      entity     TEXT NOT NULL,
      detail     TEXT,
      at         TEXT NOT NULL
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS clinic_audit_client ON clinic_audit_log(user_id, client_id, at)").catch(() => {});
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false }, { status: 401 });
  const body = await req.json().catch(() => null) as { action?: string; entity?: string; clientId?: string; detail?: string } | null;
  if (!body?.clientId || !body.action || !ACTIONS.has(body.action)) return Response.json({ ok: false }, { status: 400 });
  try {
    await ensureTable();
    const person = await getUserById(actor.actorId);
    await db.execute({
      sql: "INSERT INTO clinic_audit_log (id, user_id, client_id, actor_id, actor_name, action, entity, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), actor.userId, body.clientId.slice(0, 200), actor.actorId, person?.ownerName || actor.role, body.action,
        (body.entity || "record").slice(0, 60), body.detail?.slice(0, 300) ?? null, new Date().toISOString()],
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[clinic/audit POST]", err);
    return Response.json({ ok: false }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false }, { status: 401 });
  if (actor.role === "staff") return Response.json({ ok: false, error: "Only owners and managers can see the access log." }, { status: 403 });
  const clientId = req.nextUrl.searchParams.get("clientId");
  if (!clientId) return Response.json({ ok: false }, { status: 400 });
  try {
    await ensureTable();
    const r = await db.execute({
      sql: "SELECT actor_name, action, entity, detail, at FROM clinic_audit_log WHERE user_id = ? AND client_id = ? ORDER BY at DESC LIMIT 300",
      args: [actor.userId, clientId],
    });
    return Response.json({ ok: true, entries: r.rows.map((x) => ({ who: x.actor_name, action: x.action, entity: x.entity, detail: x.detail, at: x.at })) });
  } catch (err) {
    console.error("[clinic/audit GET]", err);
    return Response.json({ ok: false }, { status: 500 });
  }
}
