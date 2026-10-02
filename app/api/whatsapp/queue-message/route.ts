import { NextRequest } from "next/server";
import { followupsTimedFromInvoice } from "@/lib/salon-overrides";
import { resolveActor } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { activeWhatsAppCredential, isFakePlaceholderPhone, type WhatsAppProviderConfig, ycloudConfigOf } from "@/lib/whatsapp-provider";
import { appointmentStartHasPassed, appointmentStartMs, isWithinSalonHours, nextSalonOpenMs, timezoneFromSettings, type SalonHoursDay } from "@/lib/appointment-time";

type QueueKind = "groupalert" | "followup" | "cancellation" | "reminder" | "birthday" | "winback" | "lowstock" | "manual";

const MINUTE_MS = 60 * 1000;
const FOLLOWUP_STALE_GRACE_MS = 36 * 60 * MINUTE_MS;
const REMINDER_TARGET_GRACE_MS = 75 * MINUTE_MS;
const REMINDER_MIN_LEAD_MS = 30 * MINUTE_MS;
const SALON_HOURS_GATED_KINDS = new Set<QueueKind>(["reminder", "followup", "cancellation", "birthday", "winback", "lowstock"]);

interface QueueMessageBody {
  kind: QueueKind;
  phone: string;
  text: string;
  clientName?: string;
  apptId?: string;
  apptDate?: string;
  apptTime?: string;
  service?: string;
  scheduledAt?: string;
  dedupeKey?: string;
}

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS salon_data (
      entity     TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
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
      appt_id       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, id)
    )
  `);
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_id TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_date TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN service TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_date TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN service TEXT NOT NULL DEFAULT ''`).catch(() => {});
}

function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits;
}

function isQueueKind(value: unknown): value is QueueKind {
  return ["groupalert", "followup", "cancellation", "reminder", "birthday", "winback", "lowstock", "manual"].includes(String(value));
}

function normalizeRecipient(kind: QueueKind, rawPhone: string): string {
  const trimmed = rawPhone.trim();
  if (kind === "groupalert" && trimmed.endsWith("@g.us")) return trimmed;
  return normalizePhone(trimmed);
}

function queueIdFor(body: QueueMessageBody): string {
  if (body.dedupeKey?.trim()) return body.dedupeKey.trim();
  if (body.apptId?.trim()) return `${body.kind}_${body.apptId.trim()}`;
  return `${body.kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function randBetween(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

function salonHoursAdjustedScheduledAt(kind: QueueKind, scheduledAt: string, settings: Record<string, unknown>): string {
  if (!SALON_HOURS_GATED_KINDS.has(kind)) return scheduledAt;
  const scheduledMs = new Date(scheduledAt).getTime();
  if (!Number.isFinite(scheduledMs)) return scheduledAt;
  const hours = settings.hours as SalonHoursDay[] | undefined;
  const timezone = timezoneFromSettings(settings);
  if (isWithinSalonHours(hours, timezone, scheduledMs)) return scheduledAt;
  const nextOpenMs = nextSalonOpenMs(hours, timezone, scheduledMs);
  if (nextOpenMs == null) return scheduledAt;
  return new Date(nextOpenMs + randBetween(5 * MINUTE_MS, 15 * MINUTE_MS)).toISOString();
}

function scheduledAtFor(kind: QueueKind, settings: Record<string, unknown>, requested?: string): string {
  const now = Date.now();
  const requestedAt = requested ? new Date(requested).getTime() : NaN;
  let scheduledAt: string;
  if (kind === "reminder") {
    const minimum = now + 25 * MINUTE_MS;
    if (!Number.isFinite(requestedAt) || requestedAt < minimum) {
      scheduledAt = new Date(now + randBetween(25 * MINUTE_MS, 30 * MINUTE_MS)).toISOString();
      return salonHoursAdjustedScheduledAt(kind, scheduledAt, settings);
    }
  }
  if (kind === "cancellation") {
    const minimum = now + 15 * MINUTE_MS;
    if (!Number.isFinite(requestedAt) || requestedAt < minimum) {
      scheduledAt = new Date(now + randBetween(15 * MINUTE_MS, 20 * MINUTE_MS)).toISOString();
      return salonHoursAdjustedScheduledAt(kind, scheduledAt, settings);
    }
  }
  if (kind === "birthday") {
    const minimum = now + 20 * MINUTE_MS;
    if (!Number.isFinite(requestedAt) || requestedAt < minimum) {
      scheduledAt = new Date(now + randBetween(20 * MINUTE_MS, 30 * MINUTE_MS)).toISOString();
      return salonHoursAdjustedScheduledAt(kind, scheduledAt, settings);
    }
  }
  if (kind === "winback") {
    const minimum = now + 25 * MINUTE_MS;
    if (!Number.isFinite(requestedAt) || requestedAt < minimum) {
      scheduledAt = new Date(now + randBetween(25 * MINUTE_MS, 45 * MINUTE_MS)).toISOString();
      return salonHoursAdjustedScheduledAt(kind, scheduledAt, settings);
    }
  }
  scheduledAt = Number.isFinite(requestedAt) ? new Date(requestedAt).toISOString() : new Date(now).toISOString();
  return salonHoursAdjustedScheduledAt(kind, scheduledAt, settings);
}

function followupWindowExpired(settings: Record<string, unknown>, apptDate?: string, apptTime?: string): boolean {
  if (!apptDate?.trim() || !apptTime?.trim()) return false;
  const wasender = settings.wasender as { followupDelayMinutes?: number } | undefined;
  const rawDelayMinutes = Number(wasender?.followupDelayMinutes ?? 1440);
  const delayMinutes = Number.isFinite(rawDelayMinutes) ? rawDelayMinutes : 1440;
  const startMs = appointmentStartMs(apptDate, apptTime, timezoneFromSettings(settings));
  if (startMs == null) return false;
  return Date.now() > startMs + delayMinutes * MINUTE_MS + FOLLOWUP_STALE_GRACE_MS;
}

function reminderWindowMissed(settings: Record<string, unknown>, apptDate?: string, apptTime?: string): boolean {
  if (!apptDate?.trim() || !apptTime?.trim()) return false;
  const wasender = settings.wasender as { reminderHours?: number } | undefined;
  const rawReminderHours = Number(wasender?.reminderHours ?? 24);
  const reminderHours = Number.isFinite(rawReminderHours) ? rawReminderHours : 24;
  const startMs = appointmentStartMs(apptDate, apptTime, timezoneFromSettings(settings));
  if (startMs == null) return false;
  const targetMs = startMs - reminderHours * 60 * MINUTE_MS;
  const now = Date.now();
  return now > targetMs + REMINDER_TARGET_GRACE_MS || startMs - now < REMINDER_MIN_LEAD_MS;
}

function logTypeForKind(kind: QueueKind): string {
  if (kind === "groupalert") return "newbooking";
  return kind;
}

function autoSettingEnabled(settings: Record<string, unknown>, kind: QueueKind): boolean {
  const wasender = settings.wasender as {
    autoGroupBooking?: boolean;
    autoFollowup?: boolean;
    autoCancellation?: boolean;
    autoReminder?: boolean;
    autoLowStock?: boolean;
  } | undefined;
  if (kind === "groupalert") return wasender?.autoGroupBooking !== false;
  if (kind === "followup") return wasender?.autoFollowup !== false;
  if (kind === "cancellation") return wasender?.autoCancellation !== false;
  if (kind === "reminder") {
    const notifications = settings.notifications as { apptReminder?: boolean } | undefined;
    return wasender?.autoReminder !== false && notifications?.apptReminder !== false;
  }
  if (kind === "lowstock") return wasender?.autoLowStock !== false;
  // Win-back lives in its own settings block and is opt-in, so an absent value
  // means off, not on.
  if (kind === "winback") return (settings.winback as { autoWinback?: boolean } | undefined)?.autoWinback === true;
  return true;
}

async function hasSentMessage(userId: string, kind: QueueKind, apptId?: string): Promise<boolean> {
  if (!apptId?.trim()) return false;
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND appt_id = ? AND type = ? AND status = 'sent' LIMIT 1",
    args: [userId, apptId.trim(), logTypeForKind(kind)],
  });
  return result.rows.length > 0;
}

// Guards against duplicate appointment records (or a client re-booked twice for
// the same visit) resulting in two reminders/follow-ups for what is really the
// same client + service + date — the appt_id check above only catches a retry of
// the *same* appointment record, not a second, distinct one for the same visit.
async function hasSentForSameVisit(userId: string, kind: QueueKind, phone: string, apptDate?: string, service?: string): Promise<boolean> {
  if (!apptDate?.trim() || !service?.trim()) return false;
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND phone = ? AND type = ? AND appt_date = ? AND service = ? AND status = 'sent' LIMIT 1",
    args: [userId, phone, logTypeForKind(kind), apptDate.trim(), service.trim()],
  });
  return result.rows.length > 0;
}

// A client can have several appointment records on the same day (e.g. two
// services back-to-back with different staff). Follow-ups are one-per-visit,
// not one-per-service — three "how was your visit" texts within minutes of
// each other reads as spam, not care — so only the first completed service
// of the day should queue one, regardless of which specific service it was.
async function hasFollowupForSameDay(userId: string, phone: string, apptDate?: string): Promise<boolean> {
  if (!apptDate?.trim()) return false;
  const sent = await db.execute({
    sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND phone = ? AND type = 'followup' AND appt_date = ? AND status = 'sent' LIMIT 1",
    args: [userId, phone, apptDate.trim()],
  });
  if (sent.rows.length > 0) return true;
  const pending = await db.execute({
    sql: "SELECT 1 FROM wa_booking_send_queue WHERE user_id = ? AND phone = ? AND kind = 'followup' AND appt_date = ? AND status = 'pending' LIMIT 1",
    args: [userId, phone, apptDate.trim()],
  });
  return pending.rows.length > 0;
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: QueueMessageBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid body." }, { status: 400 });
  }

  if (!isQueueKind(body.kind)) return Response.json({ ok: false, error: "Invalid queue kind." }, { status: 400 });
  if (!body.text?.trim()) return Response.json({ ok: false, error: "Missing message text." }, { status: 400 });

  const phone = normalizeRecipient(body.kind, body.phone || "");
  if (!phone) return Response.json({ ok: true, queued: false, skipped: true, reason: "missing-phone" });
  if (body.kind !== "groupalert" && isFakePlaceholderPhone(phone)) {
    return Response.json({ ok: true, queued: false, skipped: true, reason: "fake-placeholder-phone" });
  }

  try {
    await ensureTable();

    const settingsRow = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${actor.userId}_settings`],
    });
    const settings = settingsRow.rows.length > 0
      ? JSON.parse(settingsRow.rows[0].data as string)
      : {};

    if (settings?.wasender?.enabled === false) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "automation-disabled" });
    }
    if (!autoSettingEnabled(settings, body.kind)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: `${body.kind}-automation-disabled` });
    }
    if (body.kind === "reminder" && body.apptDate && body.apptTime
        && appointmentStartHasPassed(body.apptDate, body.apptTime, timezoneFromSettings(settings))) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "appointment-started" });
    }
    if (body.kind === "reminder" && reminderWindowMissed(settings, body.apptDate, body.apptTime)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "reminder-window-missed" });
    }
    // Invoice-timed salons get follow-ups 24h after the invoice, queued by
    // /api/cron/followup. This path is appointment completion, so skip it.
    if (body.kind === "followup" && followupsTimedFromInvoice(settings)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "followup-timed-from-invoice" });
    }
    if (body.kind === "followup" && followupWindowExpired(settings, body.apptDate, body.apptTime)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "followup-window-expired" });
    }

    const providerConfig: WhatsAppProviderConfig = {
      provider: settings?.wasender?.provider || "wasender",
      apiKey: settings?.wasender?.apiKey,
      botSailorApiToken: settings?.wasender?.botSailorApiToken,
      botSailorPhoneNumberId: settings?.wasender?.botSailorPhoneNumberId,
      zaptickApiKey: settings?.wasender?.zaptickApiKey,
      chakraAccessToken: settings?.wasender?.chakraAccessToken,
      ...ycloudConfigOf(settings?.wasender),
    };
    if (!activeWhatsAppCredential(providerConfig)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "missing-provider-credentials" });
    }

    const id = queueIdFor(body);
    if (await hasSentMessage(actor.userId, body.kind, body.apptId)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "already-sent" });
    }
    if (body.kind === "reminder"
        && await hasSentForSameVisit(actor.userId, body.kind, phone, body.apptDate, body.service)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "already-sent-same-visit" });
    }
    if (body.kind === "followup" && await hasFollowupForSameDay(actor.userId, phone, body.apptDate)) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "followup-already-queued-same-day" });
    }
    const existingQueue = await db.execute({
      sql: "SELECT status FROM wa_booking_send_queue WHERE user_id = ? AND id = ? AND status IN ('pending', 'sent') LIMIT 1",
      args: [actor.userId, id],
    });
    if (existingQueue.rows.length > 0) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: `already-${existingQueue.rows[0].status}` });
    }

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT OR IGNORE INTO wa_booking_send_queue
              (id, user_id, kind, phone, text, client_name, appt_date, appt_time, service, scheduled_at, status, attempts, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      args: [
        id,
        actor.userId,
        body.kind,
        phone,
        body.text,
        body.clientName?.trim() || "Client",
        body.apptDate || null,
        body.apptTime || null,
        body.service || null,
        scheduledAtFor(body.kind, settings, body.scheduledAt),
        now,
      ],
    });

    return Response.json({ ok: true, queued: true });
  } catch (error) {
    console.error("[whatsapp/queue-message]", error);
    return Response.json({ ok: false, error: "Could not queue message." }, { status: 500 });
  }
}
