/**
 * /api/cron/winback
 *
 * Runs daily. For every salon with win-back enabled, finds clients who haven't
 * visited within their configured inactivity window and queues a win-back
 * WhatsApp message for each — capped per salon and spread across several hours.
 * The paced /api/cron/booking-queue drain sends the queued rows one at a time.
 *
 * Secured with Authorization: Bearer {CRON_SECRET}
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { activeWhatsAppCredential, type WhatsAppProviderConfig, ycloudConfigOf } from "@/lib/whatsapp-provider";
import { ensureWinbackTables, enqueueWinbackForUser } from "@/lib/winback-queue";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function runWinbackCron() {
  const settingsRows = await db.execute(
    "SELECT s.entity, s.data FROM users u JOIN salon_data s ON s.entity = u.id || '_settings'",
  );

  let salons = 0;
  let eligible = 0;
  let queued = 0;
  let skipped = 0;

  for (const row of settingsRows.rows) {
    const userId = (row.entity as string).replace(/_settings$/, "");
    try {
      const settings = JSON.parse(row.data as string);
      if (settings?.winback?.autoWinback !== true) continue;

      const providerConfig: WhatsAppProviderConfig = {
        provider: settings?.wasender?.provider || "wasender",
        apiKey: settings?.wasender?.apiKey,
        botSailorApiToken: settings?.wasender?.botSailorApiToken,
        botSailorPhoneNumberId: settings?.wasender?.botSailorPhoneNumberId,
        zaptickApiKey: settings?.wasender?.zaptickApiKey,
        chakraAccessToken: settings?.wasender?.chakraAccessToken,
        ...ycloudConfigOf(settings?.wasender),
      };
      if (!activeWhatsAppCredential(providerConfig)) continue;

      const result = await enqueueWinbackForUser(userId);
      if (!result.ok) continue;
      salons++;
      eligible += result.eligible;
      queued += result.queued;
      skipped += result.skipped;
    } catch (err) {
      console.error("[winback] error for row:", row.entity, err);
    }
  }

  return { salons, eligible, queued, skipped };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureWinbackTables();
    const result = await runWinbackCron();
    console.log("[winback] cron complete:", result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[winback] cron error:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
