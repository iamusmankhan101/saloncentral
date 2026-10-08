/**
 * GET /api/feedback
 *
 * Lists collected client feedback for the logged-in salon, plus a summary
 * (requested/submitted counts, average rating over submitted rows).
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { branchScope } from "@/lib/branch-scope";

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS client_feedback (
      id           TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      appt_id      TEXT NOT NULL,
      token        TEXT NOT NULL,
      client_id    TEXT,
      client_name  TEXT NOT NULL DEFAULT '',
      phone        TEXT,
      staff_name   TEXT,
      service      TEXT,
      appt_date    TEXT,
      rating       INTEGER,
      comment      TEXT,
      requested_at TEXT NOT NULL,
      submitted_at TEXT,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, appt_id)
    )
  `);
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS client_feedback_token_idx ON client_feedback(token)`);
}

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    await ensureTable();

    const result = await db.execute({
      sql: `SELECT client_id, appt_id, client_name, service, appt_date, rating, comment, requested_at, submitted_at
            FROM client_feedback WHERE user_id = ?
            ORDER BY COALESCE(submitted_at, requested_at) DESC`,
      args: [actor.userId],
    });

    // A branch's manager/staff only see feedback from their own branch's visits.
    const scope = await branchScope(actor);
    const rows = scope ? result.rows.filter((r) => scope.apptIds.has(String(r.appt_id)) || scope.clientIds.has(String(r.client_id))) : result.rows;
    const items = rows.map((r) => ({
      clientName: r.client_name as string,
      service: r.service as string | null,
      apptDate: r.appt_date as string | null,
      rating: r.rating as number | null,
      comment: r.comment as string | null,
      requestedAt: r.requested_at as string,
      submittedAt: r.submitted_at as string | null,
    }));

    const submitted = items.filter((i) => i.submittedAt != null);
    const avgRating = submitted.length > 0
      ? submitted.reduce((sum, i) => sum + (i.rating ?? 0), 0) / submitted.length
      : 0;

    return Response.json({
      ok: true,
      items,
      summary: {
        requested: items.length,
        submitted: submitted.length,
        averageRating: Math.round(avgRating * 10) / 10,
        responseRate: items.length > 0 ? Math.round((submitted.length / items.length) * 100) : 0,
      },
    });
  } catch (err) {
    console.error("[feedback GET] error:", err);
    return Response.json({ ok: false, error: "Failed to load feedback." }, { status: 500 });
  }
}
