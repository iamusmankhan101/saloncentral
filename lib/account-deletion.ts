/**
 * lib/account-deletion.ts
 * Admin-only: permanently deletes a salon owner's entire account — login,
 * staff/manager sub-accounts, sessions, all app data (appointments, clients,
 * staff, services, products, invoices, settings, WhatsApp logs) and billing
 * records. Creates backup snapshots first, but the live delete itself is hard.
 */

import { db } from "@/lib/db";
import { snapshotFullDatabase, snapshotSalonDataForOwner } from "@/lib/data-backup";

// Relational tables (lib/db-schema.ts) scoped by a plain `user_id` column.
const OWNER_SCOPED_TABLES = [
  "appointments", "clients", "staff", "services", "products", "invoices",
  "settings", "payment_requests", "user_plans",
] as const;

// WhatsApp automation dedup/log tables, also scoped by `user_id`.
const WHATSAPP_TABLES = [
  "wa_followup_sent", "birthday_sent", "birthday_message_queue",
  "wa_lowstock_sent", "wa_message_logs", "wa_birthday_settings",
  // Not WhatsApp, but scoped the same way: frees the salon's short booking link.
  "booking_slugs",
] as const;

export interface DeleteAccountResult {
  ownerId: string;
  deletedStaffIds: string[];
}

/**
 * Deletes everything tied to `ownerId`: their own login, any staff/manager
 * logins pointing back at them (users.salon_owner_id), all sessions, all
 * relational salon data, the generic salon_data key-value blob store
 * (settings/clients/appointments/etc. saved via /api/db), WhatsApp
 * automation logs, and billing records (billing_users/billing_invoices).
 */
export async function deleteSalonAccount(ownerId: string): Promise<DeleteAccountResult> {
  await snapshotFullDatabase("before-account-delete").catch((err) => {
    console.error("[account-deletion] Failed to create pre-delete database backup:", err);
  });

  await snapshotSalonDataForOwner(ownerId, "before-account-delete").catch((err) => {
    console.error("[account-deletion] Failed to create pre-delete salon_data backup:", err);
  });

  const ownerRow = await db.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [ownerId] });
  const ownerEmail = ownerRow.rows[0]?.email as string | undefined;

  const staffRes = await db.execute({
    sql: "SELECT id FROM users WHERE salon_owner_id = ?",
    args: [ownerId],
  });
  const staffIds = staffRes.rows.map((r) => r.id as string);

  for (const id of [ownerId, ...staffIds]) {
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] }).catch(() => {});
  }

  for (const table of OWNER_SCOPED_TABLES) {
    await db.execute({ sql: `DELETE FROM ${table} WHERE user_id = ?`, args: [ownerId] }).catch(() => {});
  }

  for (const table of WHATSAPP_TABLES) {
    await db.execute({ sql: `DELETE FROM ${table} WHERE user_id = ?`, args: [ownerId] }).catch(() => {});
  }

  if (ownerEmail) {
    await db.execute({
      sql: "DELETE FROM email_verification_tokens WHERE email = ?",
      args: [ownerEmail],
    }).catch(() => {});
  }

  // Generic key-value blob store — entities are keyed `${ownerId}` or
  // `${ownerId}_...` (e.g. `${ownerId}_settings`, `${ownerId}_main_clients`).
  await db.execute({
    // Key range for the `${ownerId}_` prefix ('`' follows '_'): uses the primary key, unlike LIKE.
    sql: "DELETE FROM salon_data WHERE entity = ? OR (entity >= ? AND entity < ?)",
    args: [ownerId, `${ownerId}_`, `${ownerId}\``],
  }).catch(() => {});

  await db.execute({ sql: "DELETE FROM billing_invoices WHERE user_id = ?", args: [ownerId] }).catch(() => {});
  await db.execute({ sql: "DELETE FROM billing_users WHERE id = ?", args: [ownerId] }).catch(() => {});

  for (const id of staffIds) {
    await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [id] }).catch(() => {});
  }
  await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [ownerId] }).catch(() => {});

  return { ownerId, deletedStaffIds: staffIds };
}
