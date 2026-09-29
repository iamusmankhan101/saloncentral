/**
 * Whether a time is still free to book — shared by the client app's booking
 * sheet (to hide taken times) and /api/public/booking (to refuse a slot that
 * was taken between the customer loading times and pressing Confirm).
 *
 * Works on BusySlot rather than Appointment so the public availability
 * endpoint can hand the browser only times and stylist ids — never who the
 * booking is for.
 */

import type { Appointment } from "./types";
import { appointmentStaffIds } from "./appointment-staff";

export interface BusySlot {
  date: string;
  start: string;
  end: string;
  /** Stylists held by this booking; empty for an "Any stylist" booking. */
  staffIds: string[];
}

/** Statuses that no longer hold a chair. */
const FREED: Appointment["status"][] = ["cancelled", "no-show"];

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

export function busySlots(appointments: Appointment[], fromDate: string): BusySlot[] {
  return appointments
    .filter((a) => a?.date && a.startTime && a.endTime && a.date >= fromDate && !FREED.includes(a.status))
    .map((a) => ({
      date: a.date,
      start: a.startTime,
      end: a.endTime,
      staffIds: appointmentStaffIds(a).filter((id) => id !== "any"),
    }));
}

/**
 * Can a booking of [start, end) on `date` fit?
 *
 * - `staffId` set: that stylist must have no overlapping booking.
 * - `staffId` empty ("Anyone available"): at least one of `eligibleIds` must be free.
 *
 * "Any stylist" bookings already on the books don't name anyone, but each one
 * will still take a stylist, so they're counted against whoever is left free.
 * A salon with no staff listed is treated as one chair.
 */
export function isSlotFree(
  busy: BusySlot[],
  slot: { date: string; start: string; end: string },
  staffId: string,
  eligibleIds: string[],
  allStaffIds: string[],
): boolean {
  const s = toMin(slot.start);
  const e = toMin(slot.end);
  const overlapping = busy.filter((b) => b.date === slot.date && toMin(b.start) < e && s < toMin(b.end));
  if (overlapping.length === 0) return true;
  if (allStaffIds.length === 0) return false;

  const taken = new Set<string>();
  let unnamed = 0;
  for (const b of overlapping) {
    const known = b.staffIds.filter((id) => allStaffIds.includes(id));
    if (known.length === 0) unnamed++;
    known.forEach((id) => taken.add(id));
  }
  const freeCount = allStaffIds.filter((id) => !taken.has(id)).length;
  if (freeCount <= unnamed) return false;

  if (staffId) return !taken.has(staffId);
  const pool = eligibleIds.length > 0 ? eligibleIds : allStaffIds;
  return pool.some((id) => !taken.has(id));
}
