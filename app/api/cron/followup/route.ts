/**
 * /api/cron/followup
 *
 * Runs daily at 06:00 UTC (11:00 PKT).
 * Queues follow-up WhatsApp messages for visits that finished yesterday — both
 * completed appointments and POS/manual invoices, since a walk-in salon often
 * has no booking record at all and the till receipt is the only proof of a visit.
 * The paced /api/cron/booking-queue drain sends the rows later, one at a time.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { activeWhatsAppCredential, isFakePlaceholderPhone, type WhatsAppProviderConfig } from "@/lib/whatsapp-provider";
import { appointmentStartMs, isWithinSalonHours, nextSalonOpenMs, timezoneFromSettings, type SalonHoursDay } from "@/lib/appointment-time";
import { followupsTimedFromInvoice, INVOICE_FOLLOWUP_DELAY_MS } from "@/lib/salon-overrides";

const MINUTE_MS = 60 * 1000;

function followupSpacingMs() {
  return Math.round(30 * MINUTE_MS + Math.random() * 90 * MINUTE_MS);
}

function followupClosedDayJitterMs() {
  return Math.round(25 * MINUTE_MS + Math.random() * 5 * MINUTE_MS);
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
    CREATE TABLE IF NOT EXISTS wa_followup_sent (
      user_id TEXT NOT NULL,
      appt_id TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (user_id, appt_id)
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
}

async function alreadySent(userId: string, apptId: string): Promise<boolean> {
  const legacyResult = await db.execute({
    sql: "SELECT 1 FROM wa_followup_sent WHERE user_id = ? AND appt_id = ?",
    args: [userId, apptId],
  });
  if (legacyResult.rows.length > 0) return true;
  const logResult = await db.execute({
    sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND appt_id = ? AND type = 'followup' AND status = 'sent' LIMIT 1",
    args: [userId, apptId],
  });
  return logResult.rows.length > 0;
}

async function alreadyQueued(userId: string, apptId: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM wa_booking_send_queue WHERE user_id = ? AND id = ? AND status IN ('pending', 'sent') LIMIT 1",
    args: [userId, `followup_${apptId}`],
  });
  return result.rows.length > 0;
}

// A client can have several appointment records on the same day (e.g. two
// services back-to-back with different staff) — only the first completed
// service of the day should queue a follow-up, not one per service. This is
// the authoritative cross-run check; `queuedPhones` below only catches
// duplicates within a single cron invocation.
async function hasFollowupForSameDay(userId: string, phone: string, apptDate: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT 1 FROM wa_booking_send_queue
          WHERE user_id = ? AND phone = ? AND kind = 'followup' AND appt_date = ? AND status IN ('pending', 'sent')
          LIMIT 1`,
    args: [userId, phone, apptDate],
  });
  return result.rows.length > 0;
}

async function queueFollowup(input: {
  userId: string;
  /** Appointment id, or `inv_<invoice id>` for a POS/manual sale. */
  visitId: string;
  clientName: string;
  phone: string;
  text: string;
  visitDate: string;
  visitTime: string;
  scheduledAt: string;
}) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT OR IGNORE INTO wa_booking_send_queue
            (id, user_id, kind, phone, text, client_name, appt_date, appt_time, scheduled_at, status, attempts, created_at)
          VALUES (?, ?, 'followup', ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    args: [
      `followup_${input.visitId}`,
      input.userId,
      input.phone,
      input.text,
      input.clientName,
      input.visitDate,
      input.visitTime,
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
  endTime?: string;
  status: string;
  totalAmount: number;
}

interface Client { id: string; phone: string; name: string; }

interface InvoiceItem { type?: string; description?: string; }

/** A sale rung up at the till (or typed by hand) — see lib/salon-invoices.ts. */
interface PosInvoice {
  id: string;
  clientId?: string;
  clientName: string;
  clientPhone: string;
  items?: InvoiceItem[];
  date: string;
  createdAt?: string;
  status?: string;
}

/**
 * Only a fully paid invoice marks a finished visit — an unpaid bill or one with
 * just an advance taken ("partial") gets no follow-up.
 */
function isCompleteInvoice(inv: PosInvoice): boolean {
  return inv.status === "paid";
}

/**
 * An imported or hand-written sale can carry a date with no usable timestamp.
 * Treat it as a late-afternoon visit so the configured delay still lands at a
 * sane hour rather than at midnight.
 */
const FALLBACK_INVOICE_TIME = "17:00";

function salonLocalParts(ms: number, timezone: string): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(ms),
    time: new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(ms),
  };
}

/**
 * When the client actually left, as a salon-local date + time. The drain
 * re-derives the follow-up window from these two columns, so they have to
 * reconstruct `completedAt` through appointmentStartMs, not just approximate it.
 */
function invoiceVisitTime(inv: PosInvoice, timezone: string): { date: string; time: string; completedAt: number } | null {
  const createdMs = inv.createdAt ? Date.parse(inv.createdAt) : NaN;
  if (Number.isFinite(createdMs)) {
    const parts = salonLocalParts(createdMs, timezone);
    const date = inv.date?.trim() || parts.date;
    const completedAt = appointmentStartMs(date, parts.time, timezone);
    return { date, time: parts.time, completedAt: completedAt ?? createdMs };
  }
  if (!inv.date?.trim()) return null;
  const completedAt = appointmentStartMs(inv.date, FALLBACK_INVOICE_TIME, timezone);
  if (completedAt == null) return null;
  return { date: inv.date, time: FALLBACK_INVOICE_TIME, completedAt };
}

/**
 * Invoice-timed salons (see lib/salon-overrides): the visit time is exactly
 * when the invoice was created, ignoring its editable `date` field, so the
 * follow-up lands 24 hours after the bill and not a day early for a backdated one.
 */
function invoiceCreatedTime(inv: PosInvoice, timezone: string): { date: string; time: string; completedAt: number } | null {
  const createdMs = inv.createdAt ? Date.parse(inv.createdAt) : NaN;
  if (!Number.isFinite(createdMs)) return invoiceVisitTime(inv, timezone);
  return { ...salonLocalParts(createdMs, timezone), completedAt: createdMs };
}

/** The {{service}} variable — a product-only sale falls back to the first line. */
function invoiceServiceName(inv: PosInvoice): string {
  const items = inv.items ?? [];
  const service = items.find((item) => item.type === "service");
  return (service ?? items[0])?.description || "";
}

function followupScheduledAt(baseMs: number, settings: Record<string, unknown>, spacingMs: number): string {
  const hours = settings.hours as SalonHoursDay[] | undefined;
  const timezone = timezoneFromSettings(settings);
  if (isWithinSalonHours(hours, timezone, baseMs)) return new Date(baseMs).toISOString();
  const nextOpenMs = nextSalonOpenMs(hours, timezone, baseMs);
  if (nextOpenMs == null) return new Date(baseMs).toISOString();
  return new Date(nextOpenMs + spacingMs + followupClosedDayJitterMs()).toISOString();
}

async function runFollowupCron() {
  const now = new Date();
  const dueLookbackMs = 36 * 60 * MINUTE_MS;

  let queued = 0, skipped = 0;
  let scheduleDelayMs = 0;

  // Get all users with followup enabled
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
      };
      const autoFollowup = s?.wasender?.autoFollowup;
      const rawFollowupDelayMinutes = Number(s?.wasender?.followupDelayMinutes ?? 1440);
      const followupDelayMinutes = Number.isFinite(rawFollowupDelayMinutes) ? rawFollowupDelayMinutes : 1440;
      const template     = s?.whatsapp?.followup;
      const salonName    = s?.salon?.name || "Your Salon";
      const timezone     = timezoneFromSettings(s);

      // Master "WhatsApp Automation" toggle in Account settings — when off, all
      // automated sends (and their log entries) must stop, not just autoFollowup.
      if (s?.wasender?.enabled === false) continue;
      if (!activeWhatsAppCredential(providerConfig) || !autoFollowup || !template) continue;

      // Load appointments and till sales. A POS-only salon has no appointments
      // row at all, so neither source may be skipped on account of the other.
      const apptRow = await db.execute({
        sql: "SELECT data FROM salon_data WHERE entity = ?",
        args: [`${userId}_appointments`],
      });
      const invoiceRow = await db.execute({
        sql: "SELECT data FROM salon_data WHERE entity = ?",
        args: [`${userId}_salon_invoices`],
      });
      if (apptRow.rows.length === 0 && invoiceRow.rows.length === 0) continue;

      const appointments: Appointment[] = apptRow.rows.length > 0
        ? JSON.parse(apptRow.rows[0].data as string)
        : [];
      const invoices: PosInvoice[] = invoiceRow.rows.length > 0
        ? JSON.parse(invoiceRow.rows[0].data as string)
        : [];
      const clientsRow = await db.execute({
        sql: "SELECT data FROM salon_data WHERE entity = ?",
        args: [`${userId}_clients`],
      });
      const clients: Client[] = clientsRow.rows.length > 0
        ? JSON.parse(clientsRow.rows[0].data as string)
        : [];

      // Invoice-timed salons get follow-ups from invoices only (below).
      const invoiceTimed = followupsTimedFromInvoice(s);

      const eligible = invoiceTimed ? [] : appointments.filter((appt) => {
        if (appt.status !== "completed") return false;
        const completedAt = appointmentStartMs(appt.date, appt.endTime || appt.startTime, timezone);
        if (completedAt == null) return false;
        const dueAt = completedAt + followupDelayMinutes * MINUTE_MS;
        return dueAt <= now.getTime() && now.getTime() - dueAt <= dueLookbackMs;
      });
      const queuedPhones = new Set<string>();

      for (const appt of eligible) {
        if (await alreadySent(userId, appt.id)) { skipped++; continue; }
        if (await alreadyQueued(userId, appt.id)) { skipped++; continue; }

        // Resolve phone: try appt.clientPhone first, then look up in clients
        let rawPhone = appt.clientPhone || "";
        if (!rawPhone && appt.clientId) {
          rawPhone = clients.find((c) => c.id === appt.clientId)?.phone || "";
        }
        const phone = normalizePhone(rawPhone);
        if (!phone) { skipped++; continue; }
        if (isFakePlaceholderPhone(phone)) { skipped++; continue; }
        if (queuedPhones.has(phone)) { skipped++; continue; }
        if (await hasFollowupForSameDay(userId, phone, appt.date)) { skipped++; continue; }

        const text = fillTemplate(template, {
          name:       appt.clientName,
          service:    appt.serviceNames[0] || "",
          date:       appt.date,
          time:       to12h(appt.startTime),
          salon_name: salonName,
        });

        scheduleDelayMs += followupSpacingMs();
        await queueFollowup({
          userId,
          visitId: appt.id,
          clientName: appt.clientName,
          phone,
          text,
          visitDate: appt.date,
          visitTime: appt.startTime,
          scheduledAt: followupScheduledAt(Date.now() + scheduleDelayMs, s, scheduleDelayMs),
        });
        queuedPhones.add(phone);
        queued++;
      }

      // ── POS / manual sales ──────────────────────────────────────────────
      // Run after the appointments above so that a booking billed at the till
      // is followed up once, from its appointment record. The shared
      // `queuedPhones` set and the phone+date check below are what actually
      // enforce that, which also means a booking that was never marked
      // completed still gets a follow-up off its receipt.
      //
      // This cron only runs once a day, so an invoice-timed salon queues every
      // invoice that falls due before the next run, scheduled for its exact due
      // time, instead of waiting until it is already due (which could make a
      // follow-up almost a day late).
      const invoiceDelayMs = invoiceTimed ? INVOICE_FOLLOWUP_DELAY_MS : followupDelayMinutes * MINUTE_MS;
      const lookaheadMs = invoiceTimed ? 24 * 60 * MINUTE_MS : 0;
      const eligibleInvoices = invoices
        .filter(isCompleteInvoice)
        .map((inv) => {
          const visit = invoiceTimed ? invoiceCreatedTime(inv, timezone) : invoiceVisitTime(inv, timezone);
          return visit ? { inv, ...visit } : null;
        })
        .filter((entry): entry is { inv: PosInvoice; date: string; time: string; completedAt: number } => {
          if (!entry) return false;
          const dueAt = entry.completedAt + invoiceDelayMs;
          return dueAt <= now.getTime() + lookaheadMs && now.getTime() - dueAt <= dueLookbackMs;
        });

      for (const { inv, date, time, completedAt } of eligibleInvoices) {
        // Namespaced so an invoice id can never collide with an appointment id.
        const visitId = `inv_${inv.id}`;
        if (await alreadySent(userId, visitId)) { skipped++; continue; }
        if (await alreadyQueued(userId, visitId)) { skipped++; continue; }

        let rawPhone = inv.clientPhone || "";
        if (!rawPhone && inv.clientId) {
          rawPhone = clients.find((c) => c.id === inv.clientId)?.phone || "";
        }
        const phone = normalizePhone(rawPhone);
        if (!phone) { skipped++; continue; }
        if (isFakePlaceholderPhone(phone)) { skipped++; continue; }
        if (queuedPhones.has(phone)) { skipped++; continue; }
        if (await hasFollowupForSameDay(userId, phone, date)) { skipped++; continue; }

        const text = fillTemplate(template, {
          name:       inv.clientName,
          service:    invoiceServiceName(inv),
          date,
          time:       to12h(time),
          salon_name: salonName,
        });

        let scheduledAt: string;
        if (invoiceTimed) {
          // Never before 24h after the invoice; a few random minutes on top so
          // invoices billed back-to-back don't fall due in the same minute.
          const dueAt = completedAt + invoiceDelayMs + Math.round(Math.random() * 15 * MINUTE_MS);
          scheduledAt = followupScheduledAt(Math.max(dueAt, Date.now()), s, followupSpacingMs());
        } else {
          scheduleDelayMs += followupSpacingMs();
          scheduledAt = followupScheduledAt(Date.now() + scheduleDelayMs, s, scheduleDelayMs);
        }
        await queueFollowup({
          userId,
          visitId,
          clientName: inv.clientName,
          phone,
          text,
          visitDate: date,
          visitTime: time,
          scheduledAt,
        });
        queuedPhones.add(phone);
        queued++;
      }
    } catch (e) {
      console.error("[followup] error for row:", row.entity, e);
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
    const result = await runFollowupCron();
    console.log("[followup] cron complete:", result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[followup] cron error:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
