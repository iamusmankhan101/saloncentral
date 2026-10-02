import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { activeWhatsAppCredential, isFakePlaceholderPhone, type WhatsAppProviderConfig, ycloudConfigOf } from "@/lib/whatsapp-provider";
import { appointmentStartHasPassed, timezoneFromSettings } from "@/lib/appointment-time";

const MINUTE_MS = 60 * 1000;

interface QueueConfirmationBody {
  appointment: {
    id: string;
    clientName: string;
    serviceNames: string[];
    date: string;
    startTime: string;
    totalAmount?: number;
    /** Related people seen in the same visit and billed together. */
    guests?: { name: string; serviceNames: string[] }[];
  };
  phone: string;
  /** A person deliberately asked for this send — bypass the "already sent"/"already queued" dedupe guards (still subject to every config check). */
  force?: boolean;
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
}

function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits;
}

function to12h(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  const h = parseInt(hStr, 10);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${mStr ?? "00"} ${suffix}`;
}

function fillTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

function jitteredScheduledAt(): string {
  const delayMs = 5 * MINUTE_MS + Math.random() * 5 * MINUTE_MS;
  return new Date(Date.now() + delayMs).toISOString();
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: QueueConfirmationBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid body." }, { status: 400 });
  }

  const { appointment, phone: rawPhone } = body;
  if (!appointment?.id || !appointment.clientName || !appointment.date || !appointment.startTime) {
    return Response.json({ ok: false, error: "Missing appointment details." }, { status: 400 });
  }

  const phone = normalizePhone(rawPhone || "");
  if (!phone) return Response.json({ ok: true, queued: false, skipped: true, reason: "missing-phone" });
  if (isFakePlaceholderPhone(phone)) return Response.json({ ok: true, queued: false, skipped: true, reason: "fake-placeholder-phone" });

  try {
    await ensureTable();

    if (!body.force) {
      const sentLog = await db.execute({
        sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND appt_id = ? AND type = 'confirmation' AND status = 'sent' LIMIT 1",
        args: [actor.userId, appointment.id],
      });
      if (sentLog.rows.length > 0) {
        return Response.json({ ok: true, queued: false, skipped: true, reason: "already-sent" });
      }
    }
    // Guards against a duplicate appointment record (or a client re-booked twice
    // for the same visit) resulting in two confirmations for what is really the
    // same client + service + date — the appt_id check above only catches a retry
    // of the *same* appointment record, not a second, distinct one for the same visit.
    // A booking covering several related people names each of them with their
    // own services — "Facial" alone would tell the mother nothing about what
    // her daughter is booked for.
    const service = appointment.guests?.length
      ? [{ name: appointment.clientName, serviceNames: appointment.serviceNames }, ...appointment.guests]
          .filter((p) => p.serviceNames.length > 0)
          .map((p) => `${p.name}: ${p.serviceNames.join(", ")}`)
          .join("; ")
      : appointment.serviceNames.join(", ");
    if (!body.force) {
      const sameVisitLog = await db.execute({
        sql: "SELECT 1 FROM wa_message_logs WHERE user_id = ? AND phone = ? AND type = 'confirmation' AND appt_date = ? AND service = ? AND status = 'sent' LIMIT 1",
        args: [actor.userId, phone, appointment.date, service],
      });
      if (sameVisitLog.rows.length > 0) {
        return Response.json({ ok: true, queued: false, skipped: true, reason: "already-sent-same-visit" });
      }
      const existingQueue = await db.execute({
        sql: "SELECT status FROM wa_booking_send_queue WHERE user_id = ? AND id = ? AND status IN ('pending', 'sent') LIMIT 1",
        args: [actor.userId, appointment.id],
      });
      if (existingQueue.rows.length > 0) {
        return Response.json({ ok: true, queued: false, skipped: true, reason: `already-${existingQueue.rows[0].status}` });
      }
    }

    const settingsRow = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${actor.userId}_settings`],
    });
    const settings = settingsRow.rows.length > 0
      ? JSON.parse(settingsRow.rows[0].data as string)
      : {};

    if (appointmentStartHasPassed(appointment.date, appointment.startTime, timezoneFromSettings(settings))) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "appointment-started" });
    }

    if (settings?.wasender?.enabled === false) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "automation-disabled" });
    }
    if (settings?.wasender?.autoConfirmation === false) {
      return Response.json({ ok: true, queued: false, skipped: true, reason: "auto-confirmation-disabled" });
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

    const template: string =
      settings?.whatsapp?.confirmation ||
      "Hi {{name}}, your {{service}} booking on {{date}} at {{time}} is confirmed at {{salon_name}}. We look forward to seeing you!";
    const text = fillTemplate(template, {
      name: appointment.clientName,
      service,
      date: appointment.date,
      time: to12h(appointment.startTime),
      salon_name: settings?.salon?.name || "the salon",
      amount: String(appointment.totalAmount ?? ""),
    });

    const now = new Date().toISOString();
    // REPLACE, not IGNORE — a forced resend must actually overwrite a queue row
    // left over from an earlier "sent" or still-"pending" attempt, or nothing
    // would happen at all (the whole point of asking for it deliberately).
    await db.execute({
      sql: `INSERT OR REPLACE INTO wa_booking_send_queue
              (id, user_id, kind, phone, text, client_name, appt_date, appt_time, service, scheduled_at, status, attempts, created_at)
            VALUES (?, ?, 'confirmation', ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      args: [
        appointment.id,
        actor.userId,
        phone,
        text,
        appointment.clientName,
        appointment.date,
        appointment.startTime,
        service,
        jitteredScheduledAt(),
        now,
      ],
    });

    return Response.json({ ok: true, queued: true });
  } catch (error) {
    console.error("[whatsapp/queue-confirmation]", error);
    return Response.json({ ok: false, error: "Could not queue confirmation." }, { status: 500 });
  }
}
