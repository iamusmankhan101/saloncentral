/**
 * /api/wa/messages
 *
 * GET  ?userId=xxx&limit=200                    — fetch WA message log for a user from Turso
 * GET  ?userId=xxx&apptId=yyy&type=z            — check whether a log already exists for
 *                                                  that appointment/type (used to dedup a
 *                                                  send across browsers/devices)
 * GET  ?userId=xxx&stats=1&todaySince=..&weekSince=..
 *                                                — aggregate counts (today/week/failed/sent),
 *                                                  computed via SQL over the FULL table, not
 *                                                  capped by `limit` — see note below.
 * POST { userId, entry }                        — persist a single WA log entry to Turso
 *
 * This gives every salon owner their own message history that survives
 * localStorage clears and is visible across devices.
 *
 * The stat cards on the Messages page used to be derived client-side from the
 * same `limit`-capped row list used to render the log table. Once a salon
 * accumulates more than `limit` log rows total, "This Week" / "Success Rate"
 * silently became "over whatever fit in the last `limit` rows ever" instead
 * of the real period — wrong for any moderately active salon. The `stats`
 * mode below runs COUNT()s against the whole table so these numbers are
 * accurate regardless of how many rows exist. `todaySince`/`weekSince` are
 * ISO timestamps computed client-side (in the browser's local timezone) so
 * "today" means the salon's local calendar day, not the server's UTC day.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { branchScope } from "@/lib/branch-scope";

/**
 * Message logs hold client names and phone numbers, so the caller must be
 * logged in, and may only use their own salon's id (or their own login id —
 * staff devices have historically logged under the staff member's id).
 */
async function authorizedUserId(req: NextRequest, requested: string | null | undefined): Promise<string | Response> {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!requested) return Response.json({ ok: false, error: "Missing userId." }, { status: 400 });
  if (requested !== actor.userId && requested !== actor.actorId) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  return requested;
}

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wa_message_logs (
      id          TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      type        TEXT NOT NULL,
      client_name TEXT NOT NULL,
      phone       TEXT NOT NULL,
      status      TEXT NOT NULL,
      template_id TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      appt_id     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, id)
    )
  `);
  // Older rows may predate these columns — add them if missing (no-op once applied).
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN error_message TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_id TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_date TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN service TEXT NOT NULL DEFAULT ''`).catch(() => {});
}

export async function GET(req: NextRequest) {
  const userId = await authorizedUserId(req, req.nextUrl.searchParams.get("userId"));
  if (userId instanceof Response) return userId;

  try {
    await ensureTable();

    const apptId = req.nextUrl.searchParams.get("apptId");
    const phone = req.nextUrl.searchParams.get("phone");
    const type = req.nextUrl.searchParams.get("type");
    const since = req.nextUrl.searchParams.get("since");

    if (apptId && type) {
      const result = await db.execute({
        sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND appt_id = ? AND type = ? AND status = 'sent' LIMIT 1",
        args: [userId, apptId, type],
      });
      return Response.json({ ok: true, exists: result.rows.length > 0 });
    }

    if (phone && type && since) {
      const result = await db.execute({
        sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND phone = ? AND type = ? AND timestamp >= ? AND status = 'sent' LIMIT 1",
        args: [userId, phone, type, since],
      });
      return Response.json({ ok: true, exists: result.rows.length > 0 });
    }

    if (req.nextUrl.searchParams.get("stats")) {
      const todaySince = req.nextUrl.searchParams.get("todaySince") || new Date().toISOString();
      const weekSince = req.nextUrl.searchParams.get("weekSince") || new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [todayResult, weekResult] = await Promise.all([
        db.execute({
          sql: "SELECT COUNT(*) AS n FROM wa_message_logs WHERE user_id = ? AND timestamp >= ?",
          args: [userId, todaySince],
        }),
        db.execute({
          sql: "SELECT status, COUNT(*) AS n FROM wa_message_logs WHERE user_id = ? AND timestamp >= ? GROUP BY status",
          args: [userId, weekSince],
        }),
      ]);
      const todayCount = Number(todayResult.rows[0]?.n ?? 0);
      let weekSent = 0;
      let weekFailed = 0;
      for (const row of weekResult.rows) {
        const n = Number(row.n ?? 0);
        if (row.status === "sent") weekSent += n;
        else if (row.status === "failed") weekFailed += n;
      }
      return Response.json({ ok: true, todayCount, weekSent, weekFailed, weekCount: weekSent + weekFailed });
    }

    const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "200"), 500);
    const result = await db.execute({
      sql: "SELECT * FROM wa_message_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
      args: [userId, limit],
    });

    const logs = result.rows.map((r) => ({
      id:         r.id            as string,
      timestamp:  r.timestamp     as string,
      type:       r.type          as string,
      clientName: r.client_name   as string,
      phone:      r.phone         as string,
      status:     r.status        as string,
      templateId: r.template_id   as string,
      error:      (r.error_message as string) || undefined,
      apptId:     (r.appt_id      as string) || undefined,
    }));

    // A branch's manager/staff only see messages to their own branch's clients.
    const actor = await resolveActor(req);
    const scope = actor ? await branchScope(actor) : null;
    return Response.json({ ok: true, logs: scope ? logs.filter((l) => scope.hasPhone(l.phone)) : logs });
  } catch (err) {
    console.error("[wa/messages] GET error:", err);
    return Response.json({ ok: true, logs: [] }); // fail open — don't break the page
  }
}

export async function POST(req: NextRequest) {
  let body: {
    userId: string;
    entry: {
      id: string;
      timestamp: string;
      type: string;
      clientName: string;
      phone: string;
      status: string;
      templateId: string;
      error?: string;
      apptId?: string;
      apptDate?: string;
      service?: string;
    };
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid body." }, { status: 400 });
  }

  if (!body?.userId || !body?.entry) {
    return Response.json({ ok: false, error: "Missing userId or entry." }, { status: 400 });
  }
  const allowed = await authorizedUserId(req, body.userId);
  if (allowed instanceof Response) return allowed;

  try {
    await ensureTable();
    const { entry } = body;
    await db.execute({
      sql: `INSERT OR REPLACE INTO wa_message_logs
              (id, user_id, timestamp, type, client_name, phone, status, template_id, error_message, appt_id, appt_date, service)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.id, body.userId, entry.timestamp, entry.type,
        entry.clientName, entry.phone, entry.status, entry.templateId ?? "", entry.error ?? "", entry.apptId ?? "",
        entry.apptDate ?? "", entry.service ?? "",
      ],
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[wa/messages] POST error:", err);
    return Response.json({ ok: false, error: "Failed to save log." }, { status: 500 });
  }
}