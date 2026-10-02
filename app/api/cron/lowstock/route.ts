/**
 * /api/cron/lowstock
 *
 * Runs daily at 05:00 UTC (10:00 PKT).
 * Sends a WhatsApp low-stock alert to the salon owner for any inventory
 * items at or below their minimum stock level.
 * Sends at most once per item per day.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { activeWhatsAppCredential, sendWhatsAppMessage, type WhatsAppProviderConfig, ycloudConfigOf } from "@/lib/whatsapp-provider";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "92" + digits.slice(1);
  else if (digits.length === 10 && digits.startsWith("3")) digits = "92" + digits;
  return digits;
}

async function ensureTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wa_lowstock_sent (
      user_id  TEXT NOT NULL,
      item_id  TEXT NOT NULL,
      sent_on  TEXT NOT NULL,
      PRIMARY KEY (user_id, item_id, sent_on)
    )
  `);
}

async function alreadySentToday(userId: string, itemId: string, today: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_lowstock_sent WHERE user_id = ? AND item_id = ? AND sent_on = ?",
    args: [userId, itemId, today],
  });
  return result.rows.length > 0;
}

async function markSent(userId: string, itemId: string, today: string) {
  await db.execute({
    sql: "INSERT OR IGNORE INTO wa_lowstock_sent (user_id, item_id, sent_on) VALUES (?, ?, ?)",
    args: [userId, itemId, today],
  });
}

async function sendMessage(phone: string, providerConfig: WhatsAppProviderConfig, text: string): Promise<{ ok: boolean; skipped: boolean }> {
  try {
    const result = await sendWhatsAppMessage(providerConfig, phone, text);
    return { ok: result.ok, skipped: result.skipped === true };
  } catch { return { ok: false, skipped: false }; }
}

async function logMessage(userId: string, phone: string, status: "sent" | "failed") {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  try {
    await db.execute({
      sql: `INSERT OR REPLACE INTO wa_message_logs
              (id, user_id, timestamp, type, client_name, phone, status, template_id)
            VALUES (?, ?, ?, 'lowstock', 'Owner', ?, ?, 'lowstock')`,
      args: [id, userId, new Date().toISOString(), phone, status],
    });
  } catch { /* non-critical */ }
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

interface InventoryItem {
  id: string;
  name: string;
  currentStock: number;
  minStock: number;
  unit?: string;
}

async function runLowStockCron() {
  const today = new Date().toISOString().slice(0, 10);
  let alertsSent = 0, alertsFailed = 0, alertsSkipped = 0, usersChecked = 0;

  const settingsRows = await db.execute(
    "SELECT entity, data FROM salon_data WHERE entity LIKE '%_settings'"
  );

  for (const row of settingsRows.rows) {
    try {
      const userId = (row.entity as string).replace(/_settings$/, "");
      const s = JSON.parse(row.data as string);

      const providerConfig: WhatsAppProviderConfig = {
        provider: s?.wasender?.provider || "wasender",
        apiKey: s?.wasender?.apiKey,
        botSailorApiToken: s?.wasender?.botSailorApiToken,
        botSailorPhoneNumberId: s?.wasender?.botSailorPhoneNumberId,
        zaptickApiKey: s?.wasender?.zaptickApiKey,
        chakraAccessToken: s?.wasender?.chakraAccessToken,
        ...ycloudConfigOf(s?.wasender),
      };
      const ownerPhone   = s?.wasender?.ownerPhone;
      const autoLowStock = s?.wasender?.autoLowStock;
      const template     = s?.whatsapp?.lowstock;
      const salonName    = s?.salon?.name || "Your Salon";

      // Master "WhatsApp Automation" toggle in Account settings — when off, all
      // automated sends (and their log entries) must stop, not just autoLowStock.
      if (s?.wasender?.enabled === false) continue;
      if (!activeWhatsAppCredential(providerConfig) || !ownerPhone || !autoLowStock || !template) continue;

      usersChecked++;
      const phone = normalizePhone(ownerPhone);
      if (!phone) continue;

      // Load inventory
      const invRow = await db.execute({
        sql: "SELECT data FROM salon_data WHERE entity = ?",
        args: [`${userId}_inventory`],
      });
      if (invRow.rows.length === 0) continue;

      const inventory: InventoryItem[] = JSON.parse(invRow.rows[0].data as string);

      // Items at or below min stock that haven't been alerted today
      const lowItems: InventoryItem[] = [];
      for (const item of inventory) {
        const minStock = Number(item.minStock ?? 0);
        if (minStock <= 0) continue; // skip items without a minimum configured
        if (item.currentStock <= minStock) {
          const alreadyDone = await alreadySentToday(userId, item.id, today);
          if (!alreadyDone) lowItems.push(item);
        }
      }

      if (lowItems.length === 0) continue;

      const itemList = lowItems
        .map((i) => `${i.name} (${i.currentStock} ${i.unit || "units"} left)`)
        .join(", ");

      const text = fillTemplate(template, {
        items:      itemList,
        count:      String(lowItems.length),
        salon_name: salonName,
      });

      const result = await sendMessage(phone, providerConfig, text);
      if (result.skipped) {
        alertsSkipped++;
        continue;
      }
      await logMessage(userId, phone, result.ok ? "sent" : "failed");

      if (result.ok) {
        for (const item of lowItems) await markSent(userId, item.id, today);
        alertsSent++;
        console.log(`[lowstock] ✓ sent → ${userId} (${lowItems.length} items)`);
      } else {
        alertsFailed++;
        console.log(`[lowstock] ✗ failed → ${userId}`);
      }
    } catch (e) {
      console.error("[lowstock] error for row:", row.entity, e);
    }
  }

  return { usersChecked, alertsSent, alertsFailed, alertsSkipped };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureTables();
    const result = await runLowStockCron();
    console.log("[lowstock] cron complete:", result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[lowstock] cron error:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
