/**
 * What a branch-bound login (a branch's manager, or its staff) is allowed to
 * see in the account-wide tables — WhatsApp logs and queue, client feedback,
 * payment screenshots, the clinical audit log. Those rows are stored per
 * account, not per branch, so they're filtered down to the clients,
 * phone numbers and appointments of the login's own branch.
 *
 * Owners (and the platform admin) see everything: returns null for them.
 */

import { db } from "./db";
import type { ResolvedActor } from "./api-auth";

export interface BranchScope {
  clientIds: Set<string>;
  apptIds: Set<string>;
  hasPhone: (phone: string | null | undefined) => boolean;
}

/** Last 10 digits — matches 0300…, 92300… and +92 300… as the same number. */
const phoneKey = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

async function load(userId: string, locationId: string, entity: string): Promise<Record<string, unknown>[]> {
  const key = locationId === "main" ? `${userId}_${entity}` : `${userId}_${locationId}_${entity}`;
  const r = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [key] });
  if (!r.rows.length) return [];
  try {
    const parsed = JSON.parse(r.rows[0].data as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function branchScope(actor: ResolvedActor): Promise<BranchScope | null> {
  if (actor.role === "owner" || actor.role === "admin") return null;
  const [clients, appointments] = await Promise.all([
    load(actor.userId, actor.locationId, "clients"),
    load(actor.userId, actor.locationId, "appointments"),
  ]);
  const phones = new Set(clients.map((c) => phoneKey(c.phone as string)).filter((p) => p.length >= 10));
  return {
    clientIds: new Set(clients.map((c) => String(c.id))),
    apptIds: new Set(appointments.map((a) => String(a.id))),
    hasPhone: (phone) => phones.has(phoneKey(phone)),
  };
}
