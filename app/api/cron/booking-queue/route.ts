/**
 * /api/cron/booking-queue
 *
 * Drains wa_booking_send_queue — automated appointment/customer WhatsApp sends
 * queued by the app with a 5-10 min scheduled_at
 * instead of being sent immediately (a serverless function can't just sleep
 * for 5-10 minutes to apply the same jitter every other automated WhatsApp
 * send in this app uses).
 *
 * Also drains wa_pos_receipt_queue, whose rows are scheduled only 1-2 min out —
 * a POS receipt is meant to reach the client on the sale, not paced like the
 * types above.
 *
 * That deadline is NOT met by the current schedule, and the reason is a plan
 * limit, not an oversight: Hobby accounts may only run a cron expression once
 * per day, and a sub-daily expression fails the deployment outright rather
 * than being downgraded. The 24 entries in vercel.json are 24 separate
 * once-a-day jobs at "0 0", "0 1" ... "0 23" — the legal way to get hourly
 * coverage on Hobby — so a receipt due 90 seconds from now actually goes out
 * at the next hourly tick. Per-minute drains (and the 1-2 min receipt) need
 * Pro, or a send that does not route through this cron at all.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { activeWhatsAppCredential, isFakePlaceholderPhone, sendWhatsAppMessage, type WhatsAppProviderConfig, ycloudConfigOf } from "@/lib/whatsapp-provider";
import { sendSalonInvoiceWhatsApp } from "@/lib/whatsapp-invoice-send";
import type { SalonInvoice } from "@/lib/salon-invoices";
import { checkWhatsAppSafety, recordWhatsAppSafetySend, type WhatsAppMessageIntent, type WhatsAppSafetyConfig } from "@/lib/whatsapp-safety";
import { appointmentStartHasPassed, appointmentStartMs, timezoneFromSettings, isWithinSalonHours, nextSalonOpenMs, type SalonHoursDay } from "@/lib/appointment-time";
import { followupsTimedFromInvoice, INVOICE_FOLLOWUP_DELAY_MS, isInvoiceFollowupId } from "@/lib/salon-overrides";
import { ensureBirthdayTables, runBirthdayCron } from "@/lib/birthday-queue";

const BATCH_LIMIT = 50;
const SEND_LIMIT_PER_RUN = 1;
// One send plus one retry, then the row is done. Whatever stops a WhatsApp send
// (provider outage, an unpaid provider subscription, a number that isn't on
// WhatsApp) rarely clears inside the retry window, so further attempts mostly
// repeat-pressure the same recipient; anything genuinely still owed is either
// re-queued by its own automation or resent by hand from the Message Log.
const MAX_ATTEMPTS = 2;
// If the cron hasn't run in a long time (e.g. stuck on Hobby's once-daily
// schedule), don't fire off a burst of hours-old booking confirmations —
// mirrors the same "don't send stale automated messages" fix applied to the
// dashboard's own confirmation queue.
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const FOLLOWUP_STALE_GRACE_MS = 36 * 60 * MINUTE_MS;
const REMINDER_TARGET_GRACE_MS = 75 * MINUTE_MS;
const REMINDER_MIN_LEAD_MS = 30 * MINUTE_MS;

function randBetween(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

function spacingDelayMs(kind: QueueKind): number {
  if (kind === "followup") return randBetween(30 * MINUTE_MS, 120 * MINUTE_MS);
  if (kind === "reminder") return randBetween(10 * MINUTE_MS, 20 * MINUTE_MS);
  if (kind === "cancellation") return randBetween(15 * MINUTE_MS, 20 * MINUTE_MS);
  if (kind === "birthday") return randBetween(20 * MINUTE_MS, 30 * MINUTE_MS);
  // Widest of all — a win-back run is a bulk marketing batch to dormant
  // numbers, the send pattern most likely to get a number flagged.
  if (kind === "winback") return randBetween(25 * MINUTE_MS, 45 * MINUTE_MS);
  return randBetween(10 * MINUTE_MS, 15 * MINUTE_MS);
}

// A POS receipt is expected mail: the client paid a minute ago and watched the
// invoice print, so it is sent on the sale rather than paced like the outbound
// automations above (see posReceiptDelayMs in /api/whatsapp/queue-pos-receipt).
// What is left is only the step between receipts that collide inside one tick —
// enough that a checkout rush doesn't leave the provider with five invoices in
// the same second, and short enough that the fifth client still has theirs
// before they reach the door (2nd lands 1-2 min out, 3rd 2-4 min, ...).
function posSpacingDelayMs(): number {
  return randBetween(1 * MINUTE_MS, 2 * MINUTE_MS);
}

// A failed send is almost never worth retrying immediately — the usual causes
// (provider outage, an expired/unpaid provider subscription, a rate limit) all
// take minutes-to-hours to clear, and retrying on the next cron tick just burns
// the one retry each row gets while looking like a bot. Every kind therefore
// waits a random 25-30 min, never a fixed, guessable interval.
const RETRY_MIN_GAP_MS = 25 * MINUTE_MS;
const RETRY_MAX_GAP_MS = 30 * MINUTE_MS;

function retryDelayMs(): number {
  return randBetween(RETRY_MIN_GAP_MS, RETRY_MAX_GAP_MS);
}

function posRetryDelayMs(): number {
  return randBetween(RETRY_MIN_GAP_MS, RETRY_MAX_GAP_MS);
}

function followupWindowExpired(item: Pick<QueueRow, "apptDate" | "apptTime">, settings: Record<string, unknown> | null): boolean {
  if (!item.apptDate?.trim() || !item.apptTime?.trim()) return false;
  const wasender = settings?.wasender as { followupDelayMinutes?: number } | undefined;
  const rawDelayMinutes = Number(wasender?.followupDelayMinutes ?? 1440);
  const delayMinutes = Number.isFinite(rawDelayMinutes) ? rawDelayMinutes : 1440;
  const startMs = appointmentStartMs(item.apptDate, item.apptTime, timezoneFromSettings(settings));
  if (startMs == null) return false;
  return Date.now() > startMs + delayMinutes * MINUTE_MS + FOLLOWUP_STALE_GRACE_MS;
}

function reminderWindowMissed(item: Pick<QueueRow, "apptDate" | "apptTime">, settings: Record<string, unknown> | null): boolean {
  if (!item.apptDate?.trim() || !item.apptTime?.trim()) return false;
  const wasender = settings?.wasender as { reminderHours?: number } | undefined;
  const rawReminderHours = Number(wasender?.reminderHours ?? 24);
  const reminderHours = Number.isFinite(rawReminderHours) ? rawReminderHours : 24;
  const startMs = appointmentStartMs(item.apptDate, item.apptTime, timezoneFromSettings(settings));
  if (startMs == null) return false;
  const targetMs = startMs - reminderHours * 60 * MINUTE_MS;
  const now = Date.now();
  return now > targetMs + REMINDER_TARGET_GRACE_MS || startMs - now < REMINDER_MIN_LEAD_MS;
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function ensureTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wa_booking_send_queue (
      id           TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      phone        TEXT NOT NULL,
      text         TEXT NOT NULL,
      client_name  TEXT NOT NULL,
      appt_date    TEXT,
      appt_time    TEXT,
      scheduled_at TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      created_at   TEXT NOT NULL,
      sent_at      TEXT,
      PRIMARY KEY (user_id, id)
    )
  `);
  // Older deployments may predate appt_date/appt_time — add them if missing.
  await db.execute(`ALTER TABLE wa_booking_send_queue ADD COLUMN appt_date TEXT`).catch(() => {});
  await db.execute(`ALTER TABLE wa_booking_send_queue ADD COLUMN appt_time TEXT`).catch(() => {});
  await db.execute(`ALTER TABLE wa_booking_send_queue ADD COLUMN service TEXT`).catch(() => {});
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wa_message_logs (
      id            TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      type          TEXT NOT NULL,
      client_name   TEXT NOT NULL,
      phone         TEXT NOT NULL,
      status        TEXT NOT NULL,
      template_id   TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, id)
    )
  `);
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_date TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN service TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wa_pos_receipt_queue (
      id             TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      invoice_id     TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      phone          TEXT NOT NULL,
      client_name    TEXT NOT NULL,
      invoice_json   TEXT NOT NULL,
      salon_json     TEXT NOT NULL,
      thank_you_text TEXT NOT NULL DEFAULT '',
      scheduled_at   TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      attempts       INTEGER NOT NULL DEFAULT 0,
      last_error     TEXT,
      created_at     TEXT NOT NULL,
      sent_at        TEXT,
      PRIMARY KEY (user_id, invoice_id)
    )
  `);
}

type QueueKind = "confirmation" | "groupalert" | "followup" | "cancellation" | "reminder" | "birthday" | "winback" | "lowstock" | "manual";
type LogKind = QueueKind | "invoice";

interface QueueRow {
  id: string;
  userId: string;
  kind: QueueKind;
  phone: string;
  text: string;
  clientName: string;
  apptDate: string | null;
  apptTime: string | null;
  service: string | null;
  scheduledAt: string;
  attempts: number;
}

async function getDueItems(): Promise<QueueRow[]> {
  const result = await db.execute({
    sql: `SELECT id, user_id, kind, phone, text, client_name, appt_date, appt_time, service, scheduled_at, attempts
          FROM wa_booking_send_queue
          WHERE status = 'pending' AND scheduled_at <= ? AND attempts < ?
          ORDER BY scheduled_at ASC
          LIMIT ?`,
    args: [new Date().toISOString(), MAX_ATTEMPTS, BATCH_LIMIT],
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    kind: r.kind as QueueKind,
    phone: r.phone as string,
    text: r.text as string,
    clientName: r.client_name as string,
    apptDate: (r.appt_date as string) ?? null,
    apptTime: (r.appt_time as string) ?? null,
    service: (r.service as string) ?? null,
    scheduledAt: r.scheduled_at as string,
    attempts: Number(r.attempts ?? 0),
  }));
}

async function updateItem(item: QueueRow, status: "sent" | "pending" | "expired", error?: string, nextScheduledAt?: string) {
  await db.execute({
    sql: `UPDATE wa_booking_send_queue
          SET status = ?, attempts = ?, last_error = ?, sent_at = ?, scheduled_at = COALESCE(?, scheduled_at)
          WHERE user_id = ? AND id = ?`,
    args: [
      status, item.attempts + 1, error ?? null,
      status === "sent" ? new Date().toISOString() : null,
      nextScheduledAt ?? null,
      item.userId, item.id,
    ],
  });
}

async function deferItem(item: QueueRow, delayMs: number, reason: string) {
  await db.execute({
    sql: `UPDATE wa_booking_send_queue
          SET scheduled_at = ?, last_error = ?
          WHERE user_id = ? AND id = ? AND status = 'pending'`,
    args: [
      new Date(Date.now() + delayMs).toISOString(),
      reason,
      item.userId,
      item.id,
    ],
  });
}

async function hasSentMessage(userId: string, logType: string, apptId: string): Promise<boolean> {
  if (!apptId) return false;
  try {
    await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_id TEXT NOT NULL DEFAULT ''`).catch(() => {});
    const result = await db.execute({
      sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND appt_id = ? AND type = ? AND status = 'sent' LIMIT 1",
      args: [userId, apptId, logType],
    });
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

// Guards against duplicate appointment records (or a client re-booked twice for
// the same visit) resulting in two confirmations/reminders/follow-ups for what
// is really the same client + service + date — the appt_id check above only
// catches a retry of the *same* appointment record, not a second, distinct one
// for the same visit.
async function hasSentForSameVisit(userId: string, logType: string, phone: string, apptDate: string | null, service: string | null): Promise<boolean> {
  if (!apptDate?.trim() || !service?.trim()) return false;
  try {
    const result = await db.execute({
      sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND phone = ? AND type = ? AND appt_date = ? AND service = ? AND status = 'sent' LIMIT 1",
      args: [userId, phone, logType, apptDate.trim(), service.trim()],
    });
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

function logTypeForKind(kind: LogKind): string {
  if (kind === "groupalert") return "newbooking";
  return kind;
}

function messageTypeForKind(kind: QueueKind): "reminder" | "confirmation" | "followup" | "cancellation" | "manual" | "birthday" | "winback" {
  if (kind === "groupalert") return "manual";
  if (kind === "lowstock") return "manual";
  return kind;
}

function intentForKind(kind: QueueKind): WhatsAppMessageIntent {
  if (kind === "lowstock" || kind === "groupalert") return "internal";
  if (kind === "cancellation" || kind === "birthday" || kind === "winback") return "marketing";
  return "utility";
}

// Confirmations stay immediate (client is actively booking right now — holding
// that back defeats the point). Everything else in this set has no time
// pressure, so it waits for the salon to actually be open rather than landing
// in a client's chat, or the owner's low-stock alert, while the salon is closed.
const SALON_HOURS_GATED_KINDS = new Set<QueueKind>(["reminder", "followup", "cancellation", "birthday", "winback", "lowstock"]);

function autoSettingEnabled(settings: Record<string, unknown> | null, kind: QueueKind): boolean {
  const wasender = settings?.wasender as {
    autoConfirmation?: boolean;
    autoGroupBooking?: boolean;
    autoFollowup?: boolean;
    autoCancellation?: boolean;
    autoReminder?: boolean;
    autoLowStock?: boolean;
  } | undefined;
  if (kind === "confirmation") return wasender?.autoConfirmation !== false;
  if (kind === "groupalert") return wasender?.autoGroupBooking !== false;
  if (kind === "followup") return wasender?.autoFollowup !== false;
  if (kind === "cancellation") return wasender?.autoCancellation !== false;
  if (kind === "reminder") return wasender?.autoReminder !== false;
  if (kind === "lowstock") return wasender?.autoLowStock !== false;
  // Win-back lives in its own settings block (not wasender) and is opt-in, so
  // unlike every other kind here an absent value means off, not on.
  if (kind === "winback") return (settings?.winback as { autoWinback?: boolean } | undefined)?.autoWinback === true;
  return true;
}

function apptIdForQueueItem(item: QueueRow): string {
  if (item.kind === "confirmation") return item.id;
  if (item.kind === "groupalert" && item.id.startsWith("newbooking_")) return item.id.slice("newbooking_".length);
  const prefix = `${item.kind}_`;
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : "";
}

async function logMessage(userId: string, kind: LogKind, clientName: string, phone: string, status: "sent" | "failed", error?: string, apptId = "", apptDate = "", service = "") {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  try {
    await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_id TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await db.execute({
      sql: `INSERT OR REPLACE INTO wa_message_logs
              (id, user_id, timestamp, type, client_name, phone, status, template_id, error_message, appt_id, appt_date, service)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'direct', ?, ?, ?, ?)`,
      args: [id, userId, new Date().toISOString(), logTypeForKind(kind), clientName, phone, status, error ?? "", apptId, apptDate, service],
    });
  } catch { /* non-critical */ }
}

interface PosReceiptRow {
  id: string;
  userId: string;
  invoiceId: string;
  phone: string;
  clientName: string;
  invoice: SalonInvoice;
  salon: { name: string; phone?: string; email?: string; address?: string; logo?: string };
  thankYouText: string;
  scheduledAt: string;
  attempts: number;
}

async function getDuePosReceipts(): Promise<PosReceiptRow[]> {
  const result = await db.execute({
    sql: `SELECT id, user_id, invoice_id, phone, client_name, invoice_json, salon_json, thank_you_text, scheduled_at, attempts
          FROM wa_pos_receipt_queue
          WHERE status = 'pending' AND scheduled_at <= ? AND attempts < ?
          ORDER BY scheduled_at ASC
          LIMIT ?`,
    args: [new Date().toISOString(), MAX_ATTEMPTS, BATCH_LIMIT],
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    invoiceId: r.invoice_id as string,
    phone: r.phone as string,
    clientName: r.client_name as string,
    invoice: JSON.parse(r.invoice_json as string) as SalonInvoice,
    salon: JSON.parse(r.salon_json as string) as PosReceiptRow["salon"],
    thankYouText: (r.thank_you_text as string) || "",
    scheduledAt: r.scheduled_at as string,
    attempts: Number(r.attempts ?? 0),
  }));
}

async function updatePosReceipt(
  item: PosReceiptRow,
  status: "sent" | "pending" | "expired",
  error?: string,
  nextScheduledAt?: string,
) {
  await db.execute({
    sql: `UPDATE wa_pos_receipt_queue
          SET status = ?, attempts = ?, last_error = ?, sent_at = ?,
              scheduled_at = COALESCE(?, scheduled_at)
          WHERE user_id = ? AND invoice_id = ?`,
    args: [
      status, item.attempts + 1, error ?? null,
      status === "sent" ? new Date().toISOString() : null,
      nextScheduledAt ?? null,
      item.userId, item.invoiceId,
    ],
  });
}

async function deferPosReceipt(item: PosReceiptRow, delayMs: number, reason: string) {
  await db.execute({
    sql: `UPDATE wa_pos_receipt_queue
          SET scheduled_at = ?, last_error = ?
          WHERE user_id = ? AND invoice_id = ? AND status = 'pending'`,
    args: [
      new Date(Date.now() + delayMs).toISOString(),
      reason,
      item.userId,
      item.invoiceId,
    ],
  });
}

function providerFromSettings(settings: Record<string, unknown> | null): WhatsAppProviderConfig & WhatsAppSafetyConfig {
  const wasender = (settings?.wasender ?? {}) as Record<string, unknown>;
  return {
    ...(wasender as WhatsAppSafetyConfig),
    provider: (wasender.provider as WhatsAppProviderConfig["provider"]) || "wasender",
    apiKey: wasender.apiKey as string | undefined,
    botSailorApiToken: wasender.botSailorApiToken as string | undefined,
    botSailorPhoneNumberId: wasender.botSailorPhoneNumberId as string | undefined,
    zaptickApiKey: wasender.zaptickApiKey as string | undefined,
    chakraAccessToken: wasender.chakraAccessToken as string | undefined,
    ...ycloudConfigOf(wasender),
    chakraPluginId: wasender.chakraPluginId as string | undefined,
    chakraWhatsappPhoneNumberId: wasender.chakraWhatsappPhoneNumberId as string | undefined,
    chakraTemplateReminder: wasender.chakraTemplateReminder as string | undefined,
    chakraTemplateConfirmation: wasender.chakraTemplateConfirmation as string | undefined,
    chakraTemplateFollowup: wasender.chakraTemplateFollowup as string | undefined,
    chakraTemplateCancellation: wasender.chakraTemplateCancellation as string | undefined,
    chakraTemplateBirthday: wasender.chakraTemplateBirthday as string | undefined,
  };
}

async function getSettings(userId: string, cache: Map<string, Record<string, unknown> | null>) {
  if (!cache.has(userId)) {
    const row = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${userId}_settings`],
    });
    cache.set(userId, row.rows.length > 0 ? JSON.parse(row.rows[0].data as string) : null);
  }
  return cache.get(userId) ?? null;
}

function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits;
}

// Marketing sends (cancellation win-backs) need the client's real opt-in status
// for blockMarketingWithoutOptIn to have anything to check — without this,
// every marketing send here is treated as an unknown, non-opted-in phone and
// gets blocked outright whenever that (default-on) safety toggle is enabled.
async function getRecipientOptedIn(
  userId: string,
  phone: string,
  cache: Map<string, Map<string, boolean>>,
): Promise<boolean | undefined> {
  if (!cache.has(userId)) {
    const map = new Map<string, boolean>();
    try {
      const row = await db.execute({
        sql: "SELECT data FROM salon_data WHERE entity = ?",
        args: [`${userId}_clients`],
      });
      if (row.rows.length > 0) {
        const clients = JSON.parse(row.rows[0].data as string) as Array<{ phone?: string; whatsappOptedOut?: boolean }>;
        for (const client of clients) {
          if (!client.phone) continue;
          map.set(normalizePhone(client.phone), !client.whatsappOptedOut);
        }
      }
    } catch { /* leave map empty — unknown phones stay treated as not opted-in */ }
    cache.set(userId, map);
  }
  return cache.get(userId)?.get(phone);
}

// The floor each kind's spacingDelayMs/posSpacingDelayMs range already implies
// (e.g. reminder's 10-20 min range implies "at least 10 min apart"). Used to
// check real elapsed time since the last actual send, not just collisions
// within a single cron run — see getLastSentAtMs below for why that matters.
function minGapMsForKind(kind: QueueKind): number {
  if (kind === "followup") return 30 * MINUTE_MS;
  if (kind === "reminder") return 10 * MINUTE_MS;
  if (kind === "cancellation") return 15 * MINUTE_MS;
  if (kind === "birthday") return 20 * MINUTE_MS;
  // Matches the 30 min floor win-back scheduling already builds into every gap
  // (see WINBACK_MIN_GAP_MS), so a message that drains a minute early — or a
  // predecessor that drained late — is held back rather than closing the gap.
  if (kind === "winback") return 30 * MINUTE_MS;
  return 10 * MINUTE_MS;
}
// The floor between two invoice sends. Was 10 min, matching the old spacing;
// at that width a second checkout inside the same 10 minutes had its receipt
// pushed past the client's visit, which is the delay this is meant to remove.
// A 1 min floor still keeps two receipts off the same second.
const POS_MIN_GAP_MS = 1 * MINUTE_MS;

// SEND_LIMIT_PER_RUN only caps how many messages go out within one cron
// invocation — it does nothing to stop a *later* invocation from sending
// again a couple minutes after. With the drain cron now polling every 1-3
// min (instead of the old, accidentally-slow ~10 min interval), a sustained
// backlog could otherwise send a message every single poll, defeating the
// whole point of each kind's 5-30 min anti-ban spacing. This checks the real
// last successful send time (persisted in wa_message_logs, so it holds
// across separate serverless invocations) and defers if the kind's own
// minimum gap hasn't actually elapsed yet.
async function getLastSentAtMs(
  userId: string,
  type: string,
  cache: Map<string, number | null>,
): Promise<number | null> {
  const key = `${userId}:${type}`;
  if (!cache.has(key)) {
    const row = await db.execute({
      sql: "SELECT MAX(timestamp) AS ts FROM wa_message_logs WHERE user_id = ? AND type = ? AND status = 'sent'",
      args: [userId, type],
    });
    const ts = row.rows[0]?.ts as string | null;
    cache.set(key, ts ? new Date(ts).getTime() : null);
  }
  return cache.get(key) ?? null;
}

// getLastSentAtMs above only tracks spacing within one message *type* (e.g.
// confirmation vs. groupalert vs. invoice track separately) — that leaves no
// floor between two DIFFERENT automated types, so a confirmation, a group
// alert, and an invoice for unrelated bookings could each land on their own
// per-type schedule but still all fire within the same minute of each other,
// reading as a bot blast even though each type individually looks paced.
// This tracks the last successful send of ANY kind for the salon and enforces
// a gap across every automated message type, on top of each kind's own
// (equal or larger) internal spacing. The required gap itself is a fresh
// random 10-15 min draw on every check (not a fixed 10-min floor) — a hard
// floor means sends can always cluster right at the 10-min mark, which is
// its own detectable regularity.
function globalTargetGapMs(): number {
  return randBetween(10 * MINUTE_MS, 15 * MINUTE_MS);
}

// The same cross-type floor, drawn narrow for POS receipts. At the full 10-15
// min a receipt was held behind any unrelated automated message the salon
// happened to send in the last quarter hour — a reminder for tomorrow's
// appointment could push the receipt for the sale happening right now past the
// client's visit. A receipt is also the one message a recipient is expecting,
// so it is the least likely of the automated types to be reported, which is
// what the cross-type gap is ultimately protecting against.
function posGlobalTargetGapMs(): number {
  return randBetween(1 * MINUTE_MS, 2 * MINUTE_MS);
}
async function getLastAnySentAtMs(
  userId: string,
  cache: Map<string, number | null>,
): Promise<number | null> {
  const key = `${userId}:any`;
  if (!cache.has(key)) {
    const row = await db.execute({
      sql: "SELECT MAX(timestamp) AS ts FROM wa_message_logs WHERE user_id = ? AND status = 'sent'",
      args: [userId],
    });
    const ts = row.rows[0]?.ts as string | null;
    cache.set(key, ts ? new Date(ts).getTime() : null);
  }
  return cache.get(key) ?? null;
}

async function runBookingQueueCron(): Promise<{ sent: number; failed: number; skipped: number; expired: number; posSent: number; posFailed: number; posExpired: number }> {
  const items = await getDueItems();
  let sent = 0, failed = 0, skipped = 0, expired = 0, posSent = 0, posFailed = 0, posExpired = 0;
  // Shared across the general queue AND the invoice queue below — every
  // automated WhatsApp send (of any kind) draws from this same budget so at
  // most one message goes out per cron run, and collisions (whichever kind
  // hits the exhausted budget first) all stagger off the same accumulating
  // delay instead of each kind getting its own independent send slot.
  let sendAttemptsThisRun = 0;
  let deferredDelayMs = 0;
  const settingsCache = new Map<string, Record<string, unknown> | null>();
  const optedInCache = new Map<string, Map<string, boolean>>();
  const lastSentCache = new Map<string, number | null>();

  for (const item of items) {
    if (Date.now() - new Date(item.scheduledAt).getTime() > EXPIRE_AFTER_MS) {
      await updateItem(item, "expired", "Expired before the queue could drain — too stale to send.");
      expired++;
      continue;
    }

    const settings = await getSettings(item.userId, settingsCache);

    // Confirmation/reminder/group-alert messages are tied to the appointment
    // start. Once that time has passed in the salon's timezone, do not send
    // them from a backlog — a "New Booking!" group alert or a client reminder
    // for an appointment that's already happened is just noise.
    if ((item.kind === "confirmation" || item.kind === "reminder" || item.kind === "groupalert") && item.apptDate && item.apptTime
        && appointmentStartHasPassed(item.apptDate, item.apptTime, timezoneFromSettings(settings))) {
      await updateItem(item, "expired", "Appointment time already passed — queued message skipped.");
      expired++;
      continue;
    }
    if (item.kind === "reminder" && reminderWindowMissed(item, settings)) {
      await updateItem(item, "expired", "Reminder window missed — too close to appointment time.");
      expired++;
      continue;
    }
    if (item.kind === "followup" && followupsTimedFromInvoice(settings)) {
      if (!isInvoiceFollowupId(item.id)) {
        await updateItem(item, "expired", "This salon sends follow-ups 24 hours after the invoice, not from appointments.");
        expired++;
        continue;
      }
      // appt_date/appt_time hold the invoice's creation time in salon time.
      const createdMs = item.apptDate && item.apptTime
        ? appointmentStartMs(item.apptDate, item.apptTime, timezoneFromSettings(settings))
        : null;
      const earliestMs = createdMs != null ? createdMs + INVOICE_FOLLOWUP_DELAY_MS : null;
      if (earliestMs != null && Date.now() < earliestMs) {
        await deferItem(item, earliestMs - Date.now(), "Held until 24 hours after the invoice.");
        skipped++;
        continue;
      }
    }
    if (item.kind === "followup" && followupWindowExpired(item, settings)) {
      await updateItem(item, "expired", "Follow-up window already passed — queued message skipped.");
      expired++;
      continue;
    }

    // If automation or a specific message type is off when a due item is reached,
    // expire it instead of leaving a backlog that fires when the toggle is turned
    // on again later.
    if (settings?.wasender && (settings.wasender as { enabled?: boolean }).enabled === false) {
      await updateItem(item, "expired", "WhatsApp automation was disabled at the scheduled send time.");
      expired++;
      continue;
    }
    // A win-back batch queued by hand from the Messaging page ("Queue Now") still
    // sends even when the nightly win-back automation is off — the owner asked for
    // that specific batch. The master WhatsApp Automation switch (checked just
    // above) and the 24h staleness expiry still stop it.
    const manuallyQueued = item.kind === "winback" && item.service === "manual";
    if (!manuallyQueued && !autoSettingEnabled(settings, item.kind)) {
      await updateItem(item, "expired", `${logTypeForKind(item.kind)} automation was disabled at the scheduled send time.`);
      expired++;
      continue;
    }
    if (SALON_HOURS_GATED_KINDS.has(item.kind)) {
      const hours = settings?.hours as SalonHoursDay[] | undefined;
      const tz = timezoneFromSettings(settings);
      if (!isWithinSalonHours(hours, tz)) {
        const nextOpenMs = nextSalonOpenMs(hours, tz);
        if (nextOpenMs != null) {
          const delayMs = Math.max(0, nextOpenMs - Date.now()) + Math.round(Math.random() * 15 * MINUTE_MS);
          await deferItem(item, delayMs, "Deferred until the salon reopens.");
          skipped++;
          continue;
        }
      }
    }
    const apptId = apptIdForQueueItem(item);
    if (apptId && await hasSentMessage(item.userId, logTypeForKind(item.kind), apptId)) {
      await updateItem(item, "sent");
      skipped++;
      continue;
    }
    if ((item.kind === "confirmation" || item.kind === "reminder" || item.kind === "followup")
        && await hasSentForSameVisit(item.userId, logTypeForKind(item.kind), item.phone, item.apptDate, item.service)) {
      await updateItem(item, "sent");
      skipped++;
      continue;
    }

    const providerConfig = providerFromSettings(settings);
    if (!activeWhatsAppCredential(providerConfig)) {
      // Not connected — defer rather than attempt/fail. Credentials can come back
      // (reconnect, re-enter API key) and the message should still go out then,
      // unlike the "automation explicitly disabled" case above which expires outright.
      await deferItem(item, retryDelayMs(), "WhatsApp is not connected — will retry once reconnected.");
      skipped++;
      continue;
    }
    if (sendAttemptsThisRun >= SEND_LIMIT_PER_RUN) {
      deferredDelayMs += spacingDelayMs(item.kind);
      await deferItem(item, deferredDelayMs, "Deferred to pace automated WhatsApp sends.");
      skipped++;
      continue;
    }
    const lastSentForKind = await getLastSentAtMs(item.userId, logTypeForKind(item.kind), lastSentCache);
    const minGap = minGapMsForKind(item.kind);
    if (lastSentForKind != null && Date.now() - lastSentForKind < minGap) {
      await deferItem(item, spacingDelayMs(item.kind), "Deferred to keep automated WhatsApp sends spaced apart.");
      skipped++;
      continue;
    }
    const lastAnySent = await getLastAnySentAtMs(item.userId, lastSentCache);
    if (lastAnySent != null) {
      const targetGap = globalTargetGapMs();
      const elapsed = Date.now() - lastAnySent;
      if (elapsed < targetGap) {
        await deferItem(item, targetGap - elapsed, "Deferred to keep automated WhatsApp sends spaced apart from other message types.");
        skipped++;
        continue;
      }
    }

    const intent = intentForKind(item.kind);
    const safety = checkWhatsAppSafety({
      phone: item.phone,
      intent,
      // Follow-ups have no time pressure (they go out days after the visit), so
      // they respect quiet hours even though their intent is "utility" — unlike
      // confirmations/reminders, which stay exempt since they're time-critical.
      respectQuietHours: item.kind === "followup" ? true : undefined,
      recipientOptedIn: intent === "marketing" ? await getRecipientOptedIn(item.userId, item.phone, optedInCache) : undefined,
      config: providerConfig,
    });
    if (!safety.ok) {
      const retryAfterMs = "retryAfter" in safety && typeof safety.retryAfter === "number"
        ? safety.retryAfter * 1000
        : retryDelayMs();
      await deferItem(item, retryAfterMs, safety.error ?? "WhatsApp safety check deferred this send.");
      skipped++;
      continue;
    }

    const result = await sendWhatsAppMessage(
      providerConfig, item.phone, item.text,
      { messageType: messageTypeForKind(item.kind) },
    );
    sendAttemptsThisRun++;
    if (result.skipped) {
      // sendWhatsAppMessage skips for two different reasons — the number looks
      // fake, or WhatsApp reports no account on it — and they mean opposite
      // things to an owner reading the log: bad data entry vs. a real client
      // who simply isn't on WhatsApp. Keep whichever one actually applied.
      await updateItem(item, "expired", result.errorReason ?? "Skipped fake/placeholder recipient.");
      skipped++;
      continue;
    }
    await logMessage(item.userId, item.kind, item.clientName, item.phone, result.ok ? "sent" : "failed", result.errorReason, apptId, item.apptDate ?? "", item.service ?? "");

    if (result.ok) {
      recordWhatsAppSafetySend({ phone: item.phone, config: providerConfig });
      await updateItem(item, "sent");
      sent++;
    } else if (item.attempts + 1 >= MAX_ATTEMPTS) {
      await updateItem(item, "expired", result.errorReason);
      failed++;
    } else {
      await updateItem(item, "pending", result.errorReason, new Date(Date.now() + retryDelayMs()).toISOString());
      failed++;
    }
  }

  const posItems = await getDuePosReceipts();
  for (const item of posItems) {
    if (Date.now() - new Date(item.scheduledAt).getTime() > EXPIRE_AFTER_MS) {
      await updatePosReceipt(item, "expired", "Expired before the queue could drain — too stale to send.");
      posExpired++;
      continue;
    }

    const settings = await getSettings(item.userId, settingsCache);
    if (settings?.wasender && (settings.wasender as { enabled?: boolean }).enabled === false) {
      skipped++;
      continue;
    }

    const providerConfig = providerFromSettings(settings);
    if (!activeWhatsAppCredential(providerConfig)) {
      await deferPosReceipt(item, retryDelayMs(), "WhatsApp provider credentials are not configured.");
      posFailed++;
      continue;
    }
    if (isFakePlaceholderPhone(item.phone)) {
      await updatePosReceipt(item, "expired", "Skipped fake/placeholder recipient.");
      skipped++;
      continue;
    }

    const safety = checkWhatsAppSafety({ phone: item.phone, intent: "utility", config: providerConfig });
    if (!safety.ok) {
      const retryAfterMs = "retryAfter" in safety && typeof safety.retryAfter === "number"
        ? safety.retryAfter * 1000
        : retryDelayMs();
      await deferPosReceipt(item, retryAfterMs, safety.error ?? "WhatsApp safety check deferred this send.");
      skipped++;
      continue;
    }
    const lastInvoiceSent = await getLastSentAtMs(item.userId, "invoice", lastSentCache);
    if (lastInvoiceSent != null && Date.now() - lastInvoiceSent < POS_MIN_GAP_MS) {
      await deferPosReceipt(item, posSpacingDelayMs(), "Deferred to keep automated invoice sends spaced apart.");
      skipped++;
      continue;
    }
    const lastAnySent = await getLastAnySentAtMs(item.userId, lastSentCache);
    if (lastAnySent != null) {
      const targetGap = posGlobalTargetGapMs();
      const elapsed = Date.now() - lastAnySent;
      if (elapsed < targetGap) {
        await deferPosReceipt(item, targetGap - elapsed, "Deferred to keep automated WhatsApp sends spaced apart from other message types.");
        skipped++;
        continue;
      }
    }

    // Same guard the booking queue applies via hasSentMessage: if this exact
    // invoice already has a successful send logged, never send it a second time
    // (a retry that actually reached WhatsApp before failing on the response, or
    // the same invoice re-queued from the POS, would otherwise double-message).
    if (await hasSentMessage(item.userId, "invoice", item.invoiceId)) {
      await updatePosReceipt(item, "sent");
      skipped++;
      continue;
    }

    if (sendAttemptsThisRun >= SEND_LIMIT_PER_RUN) {
      deferredDelayMs += posSpacingDelayMs();
      await deferPosReceipt(item, deferredDelayMs, "Deferred to pace automated invoice WhatsApp sends 10-15 min apart.");
      skipped++;
      continue;
    }

    const result = await sendSalonInvoiceWhatsApp({
      invoice: item.invoice,
      salon: item.salon,
      phone: item.phone,
      providerConfig,
      thankYouText: item.thankYouText,
    });
    sendAttemptsThisRun++;
    if (result.skipped) {
      await updatePosReceipt(item, "expired", result.error ?? "Skipped fake/placeholder recipient.");
      skipped++;
      continue;
    }
    await logMessage(item.userId, "invoice", item.clientName, item.phone, result.ok ? "sent" : "failed", result.error, item.invoiceId);

    if (result.ok) {
      recordWhatsAppSafetySend({ phone: item.phone, config: providerConfig });
      await updatePosReceipt(item, "sent");
      posSent++;
    } else if (item.attempts + 1 >= MAX_ATTEMPTS) {
      await updatePosReceipt(item, "expired", result.error);
      posFailed++;
    } else {
      // Without a new scheduled_at the row stays due immediately, so every
      // following cron tick retried it — burning every attempt within a few
      // minutes and filling the message log with the same failure over and over.
      await updatePosReceipt(item, "pending", result.error, new Date(Date.now() + posRetryDelayMs()).toISOString());
      posFailed++;
    }
  }

  return { sent, failed, skipped, expired, posSent, posFailed, posExpired };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureTables();
    const result = await runBookingQueueCron();
    // Birthday wishes also drain here, hourly, so a quiet day's early schedule
    // is actually met — the birthday cron itself only runs four times a day.
    // Skipped when this run already sent something, to keep sends apart.
    let birthday: Awaited<ReturnType<typeof runBirthdayCron>> | null = null;
    if (result.sent + result.failed + result.posSent + result.posFailed === 0) {
      try {
        await ensureBirthdayTables();
        birthday = await runBirthdayCron();
      } catch (err) {
        console.error("[booking-queue] birthday drain error:", err);
      }
    }
    console.log("[booking-queue] cron complete:", result, "birthday:", birthday);
    return Response.json({ ok: true, ...result, birthday });
  } catch (err) {
    console.error("[booking-queue] cron error:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
