/**
 * /api/cron/reminder
 *
 * Runs hourly. Scans every salon's appointments server-side and queues an
 * appointment reminder once an appointment enters its configured reminderHours
 * window — this is the server-side counterpart to the browser-only scheduler
 * in lib/whatsapp-scheduler.ts, which only ever runs while someone has the
 * dashboard open in a tab. Without this cron, a reminder for an appointment
 * simply never queues if nobody opened the app during that window.
 * The paced /api/cron/booking-queue drain sends the queued rows later, one at a time.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { activeWhatsAppCredential, isFakePlaceholderPhone, type WhatsAppProviderConfig, ycloudConfigOf } from "@/lib/whatsapp-provider";
import { appointmentStartMs, isWithinSalonHours, nextSalonOpenMs, timezoneFromSettings, type SalonHoursDay } from "@/lib/appointment-time";

const MINUTE_MS = 60 * 1000;
const REMINDER_TARGET_GRACE_MS = 75 * MINUTE_MS;
const REMINDER_MIN_LEAD_MS = 30 * MINUTE_MS;

function reminderSpacingMs() {
  return Math.round(10 * MINUTE_MS + Math.random() * 10 * MINUTE_MS);
}

function reminderClosedDayJitterMs() {
  return Math.round(5 * MINUTE_MS + Math.random() * 5 * MINUTE_MS);
}

function reminderIsInSendWindow(apptStart: number, reminderHours: number, nowMs = Date.now()): boolean {
  const reminderMs = Number.isFinite(reminderHours) ? reminderHours * 60 * MINUTE_MS : 24 * 60 * MINUTE_MS;
  const targetMs = apptStart - reminderMs;
  return nowMs >= targetMs && nowMs <= targetMs + REMINDER_TARGET_GRACE_MS && apptStart - nowMs >= REMINDER_MIN_LEAD_MS;
}

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
    CREATE TABLE IF NOT EXISTS wa_booking_send_queue (
      id           TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      phone        TEXT NOT NULL,
      text         TEXT NOT NULL,
      client_name  TEXT NOT NULL,
      appt_date    TEXT,
      appt_time    TEXT,
      service      TEXT,
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
      appt_date     TEXT NOT NULL DEFAULT '',
      service       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, id)
    )
  `);
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_id TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN appt_date TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await db.execute(`ALTER TABLE wa_message_logs ADD COLUMN service TEXT NOT NULL DEFAULT ''`).catch(() => {});
}

async function alreadySent(userId: string, apptId: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND appt_id = ? AND type = 'reminder' AND status = 'sent' LIMIT 1",
    args: [userId, apptId],
  });
  return result.rows.length > 0;
}

async function alreadyQueued(userId: string, apptId: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_booking_send_queue WHERE user_id = ? AND id = ? AND status IN ('pending', 'sent') LIMIT 1",
    args: [userId, `reminder_${apptId}`],
  });
  return result.rows.length > 0;
}

// Guards against duplicate appointment records (or a client re-booked twice for
// the same visit) resulting in two reminders for what is really the same
// client + service + date — the appt_id check above only catches a retry of
// the *same* appointment record, not a second, distinct one for the same visit.
async function hasSentForSameVisit(userId: string, phone: string, apptDate: string, service: string): Promise<boolean> {
  if (!apptDate.trim() || !service.trim()) return false;
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND phone = ? AND type = 'reminder' AND appt_date = ? AND service = ? AND status = 'sent' LIMIT 1",
    args: [userId, phone, apptDate.trim(), service.trim()],
  });
  return result.rows.length > 0;
}

// Confirmations should always land in the client's chat before any reminder
// does — hold the reminder back while a confirmation is still pending for the
// same appointment (it sends after its own 5-10 min delay), so a same-day
// booking's reminder can't win the race and arrive first.
async function hasPendingConfirmation(userId: string, apptId: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_booking_send_queue WHERE user_id = ? AND id = ? AND kind = 'confirmation' AND status = 'pending' LIMIT 1",
    args: [userId, apptId],
  });
  return result.rows.length > 0;
}

async function queueReminder(input: {
  userId: string;
  appt: Appointment;
  phone: string;
  text: string;
  scheduledAt: string;
}) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT OR IGNORE INTO wa_booking_send_queue
            (id, user_id, kind, phone, text, client_name, appt_date, appt_time, service, scheduled_at, status, attempts, created_at)
          VALUES (?, ?, 'reminder', ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    args: [
      `reminder_${input.appt.id}`,
      input.userId,
      input.phone,
      input.text,
      input.appt.clientName,
      input.appt.date,
      input.appt.startTime,
      input.appt.serviceNames.join(", "),
      input.scheduledAt,
      now,
    ],
  });
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

function to12h(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  const h = parseInt(hStr, 10);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${mStr ?? "00"} ${suffix}`;
}

interface Appointment {
  id: string;
  clientId: string;
  clientName: string;
  clientPhone?: string;
  serviceNames: string[];
  date: string;
  startTime: string;
  status: string;
  totalAmount: number;
  createdAt?: string;
}

interface Client { id: string; phone: string; name: string; }

function reminderScheduledAt(baseMs: number, settings: Record<string, unknown>, spacingMs: number): string {
  const hours = settings.hours as SalonHoursDay[] | undefined;
  const timezone = timezoneFromSettings(settings);
  if (isWithinSalonHours(hours, timezone, baseMs)) return new Date(baseMs).toISOString();
  const nextOpenMs = nextSalonOpenMs(hours, timezone, baseMs);
  if (nextOpenMs == null) return new Date(baseMs).toISOString();
  return new Date(nextOpenMs + spacingMs + reminderClosedDayJitterMs()).toISOString();
}

async function runReminderCron() {
  const now = new Date();

  let queued = 0, skipped = 0;
  let scheduleDelayMs = 0;

  const settingsRows = await db.execute(
    "SELECT s.entity, s.data FROM users u JOIN salon_data s ON s.entity = u.id || '_settings'"
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
      const autoReminder = s?.wasender?.autoReminder;
      const notificationsEnabled = s?.notifications?.apptReminder !== false;
      const rawReminderHours = Number(s?.wasender?.reminderHours ?? 24);
      const reminderHours = Number.isFinite(rawReminderHours) ? rawReminderHours : 24;
      const template  = s?.whatsapp?.reminder;
      const salonName = s?.salon?.name || "Your Salon";
      const timezone  = timezoneFromSettings(s);

      // Master "WhatsApp Automation" toggle in Account settings — when off, all
      // automated sends must stop, not just autoReminder.
      if (s?.wasender?.enabled === false) continue;
      if (!activeWhatsAppCredential(providerConfig) || autoReminder === false || !notificationsEnabled || !template) continue;

      const apptRow = await db.execute({
        sql: "SELECT data FROM salon_data WHERE entity = ?",
        args: [`${userId}_appointments`],
      });
      if (apptRow.rows.length === 0) continue;

      const appointments: Appointment[] = JSON.parse(apptRow.rows[0].data as string);
      const clientsRow = await db.execute({
        sql: "SELECT data FROM salon_data WHERE entity = ?",
        args: [`${userId}_clients`],
      });
      const clients: Client[] = clientsRow.rows.length > 0
        ? JSON.parse(clientsRow.rows[0].data as string)
        : [];

      const eligible = appointments.filter((appt) => {
        if (appt.status === "cancelled" || appt.status === "no-show" || appt.status === "completed") return false;
        // A walk-in booked today for later today never gets a reminder — the
        // confirmation that just went out makes an advance-notice reminder
        // redundant. createdAt's date equalling appt.date can only happen for
        // a booking made on the same calendar day as its own appointment
        // (createdAt can never be later than "now", so for a still-upcoming
        // appointment this is equivalent to "booked today").
        if (appt.createdAt && appt.createdAt.slice(0, 10) === appt.date) return false;
        const apptTimeMs = appointmentStartMs(appt.date, appt.startTime, timezone);
        if (apptTimeMs == null) return false;
        return reminderIsInSendWindow(apptTimeMs, reminderHours, now.getTime());
      });

      for (const appt of eligible) {
        if (await alreadySent(userId, appt.id)) { skipped++; continue; }
        if (await alreadyQueued(userId, appt.id)) { skipped++; continue; }
        if (await hasPendingConfirmation(userId, appt.id)) { skipped++; continue; }

        let rawPhone = appt.clientPhone || "";
        if (!rawPhone && appt.clientId) {
          rawPhone = clients.find((c) => c.id === appt.clientId)?.phone || "";
        }
        const phone = normalizePhone(rawPhone);
        if (!phone) { skipped++; continue; }
        if (isFakePlaceholderPhone(phone)) { skipped++; continue; }

        const service = appt.serviceNames.join(", ");
        if (await hasSentForSameVisit(userId, phone, appt.date, service)) { skipped++; continue; }

        const text = fillTemplate(template, {
          name:       appt.clientName,
          service:    appt.serviceNames[0] || "",
          date:       appt.date,
          time:       to12h(appt.startTime),
          salon_name: salonName,
        });

        scheduleDelayMs += reminderSpacingMs();
        await queueReminder({
          userId,
          appt,
          phone,
          text,
          scheduledAt: reminderScheduledAt(Date.now() + scheduleDelayMs, s, scheduleDelayMs),
        });
        queued++;
      }
    } catch (e) {
      console.error("[reminder] error for row:", row.entity, e);
    }
  }

  return { queued, skipped };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureTables();
    const result = await runReminderCron();
    console.log("[reminder] cron complete:", result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[reminder] cron error:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
