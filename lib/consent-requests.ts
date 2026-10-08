/**
 * Remote consent signing: a one-off link a clinic sends so the patient signs
 * on their own phone (/consent/[token]). The request row holds a snapshot of
 * the form; on signing, the signed record is also added to the salon's synced
 * `consents` list, so it appears on the patient's profile like one signed in
 * the clinic.
 */

import { randomBytes } from "crypto";
import { db } from "./db";
import type { ConsentRecord } from "./clinic";

export const CONSENT_LINK_DAYS = 7;

export async function ensureConsentRequestTable(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS consent_requests (
      token        TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      location_id  TEXT NOT NULL,
      client_id    TEXT NOT NULL,
      client_name  TEXT NOT NULL,
      template_id  TEXT NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      signed_at    TEXT
    )
  `);
}

export function newConsentToken(): string {
  return randomBytes(24).toString("base64url");
}

function entityKey(userId: string, locationId: string): string {
  return locationId === "main" ? `${userId}_consents` : `${userId}_${locationId}_consents`;
}

/** Adds a signed record to the salon's synced consents list (merge-by-id on every device). */
export async function appendSignedConsent(userId: string, locationId: string, record: ConsentRecord): Promise<void> {
  const key = entityKey(userId, locationId);
  await db.execute(`CREATE TABLE IF NOT EXISTS salon_data (entity TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const row = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [key] });
  const list = row.rows.length ? JSON.parse(row.rows[0].data as string) as unknown[] : [];
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
    args: [key, JSON.stringify([{ ...record, _updatedAt: now }, ...(Array.isArray(list) ? list : [])]), now],
  });
}
