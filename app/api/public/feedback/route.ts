/**
 * GET/POST /api/public/feedback?token=xxx
 *
 * Public, unauthenticated by design — a client opens /feedback/[token] from
 * a WhatsApp follow-up message and rates their visit without logging in.
 * Resolved by opaque token, never by raw appointment id, so links can't be
 * enumerated/guessed.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";

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
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return Response.json({ ok: false, error: "Missing token." }, { status: 400 });

  try {
    await ensureTable();

    const row = await db.execute({
      sql: "SELECT * FROM client_feedback WHERE token = ?",
      args: [token],
    });
    if (row.rows.length === 0) return Response.json({ ok: false, error: "Not found." }, { status: 404 });

    const fb = row.rows[0];
    const settingsRow = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${fb.user_id}_settings`],
    });
    const settings = settingsRow.rows.length > 0 ? JSON.parse(settingsRow.rows[0].data as string) : {};
    const salonName = settings?.salon?.name || "Salon";
    const clientFirstName = (fb.client_name as string || "").split(" ")[0] || "";

    return Response.json({
      ok: true,
      salonName,
      clientFirstName,
      service: fb.service,
      apptDate: fb.appt_date,
      alreadySubmitted: !!fb.submitted_at,
      rating: fb.rating,
      comment: fb.comment,
    });
  } catch (err) {
    console.error("[public/feedback GET] error:", err);
    return Response.json({ ok: false, error: "Failed to load feedback." }, { status: 500 });
  }
}

interface SubmitBody {
  token: string;
  rating: number;
  comment?: string;
}

export async function POST(req: NextRequest) {
  const limit = await rateLimit("public-feedback", clientIp(req), { maxAttempts: 8, windowMs: 10 * 60 * 1000, blockMs: 30 * 60 * 1000 });
  if (limit.blocked) {
    return Response.json(
      { ok: false, error: "Too many attempts. Please try again later.", retryAfter: limit.retryAfter },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter ?? 0) } },
    );
  }

  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid body." }, { status: 400 });
  }
  if (!body.token?.trim()) return Response.json({ ok: false, error: "Missing token." }, { status: 400 });
  const rating = Math.round(Number(body.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return Response.json({ ok: false, error: "Rating must be between 1 and 5." }, { status: 400 });
  }
  const comment = (body.comment ?? "").toString().trim().slice(0, 1000);

  try {
    await ensureTable();

    const row = await db.execute({
      sql: "SELECT submitted_at FROM client_feedback WHERE token = ?",
      args: [body.token],
    });
    if (row.rows.length === 0) return Response.json({ ok: false, error: "Not found." }, { status: 404 });
    if (row.rows[0].submitted_at) return Response.json({ ok: true, alreadySubmitted: true });

    await db.execute({
      sql: "UPDATE client_feedback SET rating = ?, comment = ?, submitted_at = ? WHERE token = ?",
      args: [rating, comment, new Date().toISOString(), body.token],
    });

    return Response.json({ ok: true });
  } catch (err) {
    console.error("[public/feedback POST] error:", err);
    return Response.json({ ok: false, error: "Failed to submit feedback." }, { status: 500 });
  }
}
