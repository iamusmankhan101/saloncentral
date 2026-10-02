/**
 * Server-only: a salon's WhatsApp provider setup, read from its settings row.
 * Routes that talk to the provider use this instead of anything the browser
 * sends — salons never hold the keys (see lib/whatsapp-credentials.ts).
 */

import { db } from "@/lib/db";

export async function loadWhatsAppConfig(userId: string): Promise<Record<string, unknown>> {
  try {
    const res = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${userId}_settings`] });
    if (!res.rows.length) return {};
    const settings = JSON.parse(res.rows[0].data as string) as { wasender?: Record<string, unknown> };
    return settings?.wasender && typeof settings.wasender === "object" ? settings.wasender : {};
  } catch {
    return {};
  }
}
