/**
 * Treatment rooms and machines (aesthetic clinics), and keeping two bookings
 * off the same one at the same time.
 *
 * A treatment lists the rooms/machines it can use (Service.resourceIds). It
 * needs one free resource of each kind it lists: ticking Room 1, Room 2 and
 * Laser 1 means "any free room, plus Laser 1". Booking picks the first free
 * one of each and stores it on the appointment (Appointment.resourceIds), so a
 * second booking that overlaps it is refused.
 *
 * Pure and isomorphic — used by the booking form in the browser and by the
 * online-booking / AI-assistant path on the server.
 */

import type { Appointment, Service } from "./types";

export type ResourceKind = "room" | "machine";

export interface ClinicResource {
  id: string;
  name: string;
  kind: ResourceKind;
}

const INACTIVE = new Set(["cancelled", "no-show"]);

const toMin = (t: string) => {
  const [h, m] = (t || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

function overlaps(a: Pick<Appointment, "date" | "startTime" | "endTime">, b: Pick<Appointment, "date" | "startTime" | "endTime">): boolean {
  if (a.date !== b.date) return false;
  const aEnd = toMin(a.endTime) > toMin(a.startTime) ? toMin(a.endTime) : toMin(a.startTime) + 30;
  const bEnd = toMin(b.endTime) > toMin(b.startTime) ? toMin(b.endTime) : toMin(b.startTime) + 30;
  return toMin(a.startTime) < bEnd && toMin(b.startTime) < aEnd;
}

/** The booking holding `resourceId` at this appointment's time, if any. */
export function resourceClash(appt: Appointment, resourceId: string, others: Appointment[]): Appointment | undefined {
  return others.find((o) => o.id !== appt.id && !INACTIVE.has(o.status) && o.resourceIds?.includes(resourceId) && overlaps(appt, o));
}

/**
 * Gives each new appointment the rooms/machines its treatments need, checked
 * against existing bookings and against each other. Returns the appointments
 * with `resourceIds` set, or an error naming what is taken.
 */
export function assignResources(
  newAppts: Appointment[],
  existing: Appointment[],
  services: Service[],
  resources: ClinicResource[],
): { ok: true; appointments: Appointment[] } | { ok: false; error: string } {
  if (resources.length === 0) return { ok: true, appointments: newAppts };
  const byId = new Map(resources.map((r) => [r.id, r]));
  const taken = [...existing];
  const out: Appointment[] = [];
  for (const appt of newAppts) {
    const serviceIds = [...appt.serviceIds, ...(appt.guests ?? []).flatMap((g) => g.serviceIds)];
    const wanted = new Set(serviceIds.flatMap((id) => services.find((s) => s.id === id)?.resourceIds ?? []));
    const groups = new Map<ResourceKind, ClinicResource[]>();
    for (const id of wanted) {
      const r = byId.get(id);
      if (r) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
    }
    const assigned: string[] = [];
    for (const [kind, options] of groups) {
      const free = options.find((r) => !resourceClash(appt, r.id, taken));
      if (!free) {
        const clash = resourceClash(appt, options[0].id, taken)!;
        const names = options.map((r) => r.name).join(" / ");
        return { ok: false, error: `No ${kind} free on ${appt.date} at ${appt.startTime}: ${names} ${options.length > 1 ? "are" : "is"} booked (e.g. ${clash.startTime}–${clash.endTime}). Pick another time.` };
      }
      assigned.push(free.id);
    }
    const withResources = assigned.length ? { ...appt, resourceIds: assigned } : appt;
    out.push(withResources);
    taken.push(withResources);
  }
  return { ok: true, appointments: out };
}
