/**
 * POST /api/public/booking
 *
 * Saves a new appointment (and optionally a new/updated client) for a salon.
 * Called from the public online-booking page — no auth required.
 *
 * Body: { salonId, appointment, client? }
 */

import { NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { createBooking } from "@/lib/booking";
import { db } from "@/lib/db";
import { busySlots, isSlotFree } from "@/lib/availability";
import { appointmentStaffIds } from "@/lib/appointment-staff";
import type { Appointment, Client, Service, Staff } from "@/lib/types";

async function load<T>(entity: string): Promise<T[]> {
  const row = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [entity] });
  try { return row.rows.length ? JSON.parse(row.rows[0].data as string) : []; } catch { return []; }
}

/** Re-checks the slot against what's on the books right now, in case someone else took it first. */
async function slotStillFree(salonId: string, appt: Appointment): Promise<boolean> {
  const [appointments, services, staff] = await Promise.all([
    load<Appointment>(`${salonId}_appointments`),
    load<Service>(`${salonId}_services`),
    load<Staff>(`${salonId}_staff`),
  ]);
  const allStaffIds = staff.filter((s) => s.isActive !== false).map((s) => s.id);
  const chosen = services.filter((s) => appt.serviceIds?.includes(s.id));
  const eligible = allStaffIds.filter((id) =>
    chosen.every((s) => !s.assignedStaffIds?.length || s.assignedStaffIds.includes(id)));
  // Skip this booking's own id — a retried submission must not clash with itself.
  const busy = busySlots(appointments.filter((a) => a.id !== appt.id), appt.date);
  const slot = { date: appt.date, start: appt.startTime, end: appt.endTime };
  // Every named stylist must be free; a booking naming none needs anyone who can do it.
  const named = appointmentStaffIds(appt).filter((id) => id !== "any");
  return named.length > 0
    ? named.every((id) => isSlotFree(busy, slot, id, [], allStaffIds))
    : isSlotFree(busy, slot, "", eligible, allStaffIds);
}

export async function POST(req: NextRequest) {
  // Public + unauthenticated by design (customer self-booking), but each
  // booking triggers a real WhatsApp send and a DB write — throttle abuse.
  const limit = await rateLimit("public-booking", clientIp(req), { maxAttempts: 8, windowMs: 10 * 60 * 1000, blockMs: 30 * 60 * 1000 });
  if (limit.blocked) {
    return Response.json(
      { ok: false, error: "Too many booking attempts. Please try again later.", retryAfter: limit.retryAfter },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter ?? 0) } },
    );
  }

  // checkAvailability is sent by the client app, which shows the error. The
  // older online-booking page ignores the response, so it isn't refused there.
  let body: { salonId: string; appointment: Appointment; client?: Client; clientPhone?: string; checkAvailability?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const { salonId, appointment, client } = body;
  if (!salonId || !appointment) {
    return Response.json({ ok: false, error: "Missing salonId or appointment" }, { status: 400 });
  }

  try {
    if (body.checkAvailability && !(await slotStillFree(salonId, appointment))) {
      return Response.json(
        { ok: false, taken: true, error: "Sorry, that time was just booked. Please pick another time." },
        { status: 409 },
      );
    }
    // clientPhone is always sent from the booking form (covers both new and
    // returning clients).
    const result = await createBooking(salonId, appointment, client, body.clientPhone);
    return Response.json({ ok: result.ok });
  } catch (err) {
    console.error("[public/booking] error:", err);
    return Response.json({ ok: false, error: "Failed to save booking" }, { status: 500 });
  }
}
