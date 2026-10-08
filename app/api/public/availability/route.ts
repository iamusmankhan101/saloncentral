/**
 * GET /api/public/availability?salonId=xxx
 *
 * The salon's upcoming busy times, for the client app's booking sheet to hide
 * slots that are already taken. Public, so it returns only date, start/end and
 * stylist ids — no client names, phones or services (see lib/availability.ts).
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { busySlots } from "@/lib/availability";
import type { Appointment } from "@/lib/types";

/** Room/machine id → kind, so the booking page can check them (no names or bookings). */
async function resourceKinds(salonId: string): Promise<Record<string, string>> {
  try {
    const r = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_settings`] });
    const list = r.rows.length ? (JSON.parse(r.rows[0].data as string)?.clinic?.resources ?? []) : [];
    return Object.fromEntries((Array.isArray(list) ? list : []).map((x: { id: string; kind: string }) => [x.id, x.kind]));
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  const salonId = req.nextUrl.searchParams.get("salonId");
  if (!salonId) return Response.json({ ok: false, error: "Missing salonId" }, { status: 400 });

  try {
    const row = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${salonId}_appointments`],
    });
    let appointments: Appointment[] = [];
    try { appointments = row.rows.length ? JSON.parse(row.rows[0].data as string) : []; } catch { /* treat as empty */ }

    // A day of slack behind UTC "today" so salons ahead of UTC still get their own today.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return Response.json(
      { ok: true, busy: busySlots(appointments, from), resourceKinds: await resourceKinds(salonId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[public/availability] error:", err);
    return Response.json({ ok: false, error: "Failed to load availability" }, { status: 500 });
  }
}
