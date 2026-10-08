/**
 * lib/booking.ts
 *
 * Core "persist a booking + notify" logic, extracted out of
 * app/api/public/booking/route.ts so both the public online-booking form and
 * the MCP book_appointment tool call the exact same code instead of two
 * independently-drifting copies. Callers are responsible for constructing a
 * fully-formed, already-validated Appointment (id, date/time, staff, services,
 * total) before calling createBooking — this module only persists it and
 * queues the resulting WhatsApp sends, mirroring the original route exactly.
 */

import { assignResources, resourcesAt, type ClinicResource } from "./clinic-resources";
import { db } from "./db";
import { backupExistingSalonData } from "./data-backup";
import { activeWhatsAppCredential, isFakePlaceholderPhone, type WhatsAppProviderConfig, ycloudConfigOf } from "./whatsapp-provider";
import { appointmentStartHasPassed, timezoneFromSettings } from "./appointment-time";
import type { Client, Appointment, Service } from "./types";

export async function ensureBookingTables(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS salon_data (
      entity     TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Drained by /api/cron/booking-queue — see that route for why this can't just
  // be sent immediately (a serverless function can't sleep for 5-7 minutes).
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
}

export interface CreateBookingResult {
  ok: boolean;
  duplicate: boolean;
  error?: string;
}

/**
 * Persists `appointment` (and optionally creates/updates `client`) for
 * `salonId`, then queues a WhatsApp confirmation + group alert exactly like
 * the public booking form does. `channelLabel` customizes the trailing
 * sentence of the default group-alert template so staff can tell at a glance
 * how a booking arrived (e.g. "online booking page" vs "AI assistant") —
 * defaults to the original public-form wording so that caller's behavior is
 * unchanged.
 */
export async function createBooking(
  salonId: string,
  appointment: Appointment,
  client?: Client,
  clientPhone?: string,
  channelLabel = "online booking page",
): Promise<CreateBookingResult> {
  await ensureBookingTables();
  const now = new Date().toISOString();

  // ── Save appointment ──────────────────────────────────────────────────────
  const apptKey = `${salonId}_appointments`;
  const apptRow = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [apptKey] });
  const existingAppts: Appointment[] = apptRow.rows.length > 0 ? JSON.parse(apptRow.rows[0].data as string) : [];

  // A double-click on "Confirm Booking" (or a network-level retry of this exact
  // request) resubmits the same appointment.id — without this check, each
  // request still independently sends its own client confirmation + group
  // alert even when the row itself collapses to one on write.
  const isDuplicateSubmission = existingAppts.some((a) => a.id === appointment.id);
  if (!isDuplicateSubmission) {
    // Clinics: book the room/machine the treatment needs, or refuse the slot
    // when it's taken — the booking page offers slots by stylist only.
    const [settingsRow, servicesRow] = await Promise.all([
      db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_settings`] }),
      db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_services`] }),
    ]);
    const resources: ClinicResource[] = settingsRow.rows.length ? (JSON.parse(settingsRow.rows[0].data as string)?.clinic?.resources ?? []) : [];
    const services: Service[] = servicesRow.rows.length ? JSON.parse(servicesRow.rows[0].data as string) : [];
    // Online bookings land in the main branch (see the appointments key above).
    const assigned = assignResources([appointment], existingAppts, services, resourcesAt(resources, "main"));
    if (!assigned.ok) return { ok: false, duplicate: false, error: assigned.error };
    appointment = assigned.appointments[0];
    const appointmentWithCreatedAt = { ...appointment, createdAt: appointment.createdAt || now };
    const updatedAppts = [appointmentWithCreatedAt, ...existingAppts];
    await backupExistingSalonData(apptKey, salonId);
    await db.execute({
      sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
      args: [apptKey, JSON.stringify(updatedAppts), now],
    });
  }

  // ── Save / update client ──────────────────────────────────────────────────
  if (client) {
    const clientKey = `${salonId}_clients`;
    const clientRow = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [clientKey] });
    let clients: Client[] = clientRow.rows.length > 0 ? JSON.parse(clientRow.rows[0].data as string) : [];

    const normalizedPhone = client.phone.replace(/\D/g, "");
    const existingIdx = clients.findIndex((c) => c.phone.replace(/\D/g, "") === normalizedPhone);

    if (existingIdx >= 0) {
      clients[existingIdx] = {
        ...clients[existingIdx],
        totalVisits: clients[existingIdx].totalVisits + 1,
        totalSpend: clients[existingIdx].totalSpend + appointment.totalAmount,
        lastVisitDate: appointment.date,
      };
    } else {
      clients = [{ ...client, locationId: client.locationId || "main" }, ...clients];
    }

    await backupExistingSalonData(clientKey, salonId);
    await db.execute({
      sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
      args: [clientKey, JSON.stringify(clients), now],
    });
  }

  // ── Send WhatsApp messages using salon's saved templates ─────────────────
  // Skipped entirely on a duplicate submission — a resubmitted request for an
  // appointment.id already on file must not send a second confirmation/group alert.
  const phone = clientPhone || client?.phone || "";
  if (isDuplicateSubmission) {
    console.log(`[booking] Duplicate submission for appointment ${appointment.id} — skipping WhatsApp sends`);
    return { ok: true, duplicate: true };
  }

  try {
    const settingsRow = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_settings`] });
    const settings = settingsRow.rows.length > 0 ? JSON.parse(settingsRow.rows[0].data as string) : {};

    const providerConfig: WhatsAppProviderConfig = {
      provider: settings?.wasender?.provider || "wasender",
      apiKey: settings?.wasender?.apiKey,
      botSailorApiToken: settings?.wasender?.botSailorApiToken,
      botSailorPhoneNumberId: settings?.wasender?.botSailorPhoneNumberId,
      botSailorTemplateReminder: settings?.wasender?.botSailorTemplateReminder,
      botSailorTemplateConfirmation: settings?.wasender?.botSailorTemplateConfirmation,
      botSailorTemplateFollowup: settings?.wasender?.botSailorTemplateFollowup,
      botSailorTemplateCancellation: settings?.wasender?.botSailorTemplateCancellation,
      botSailorTemplateBirthday: settings?.wasender?.botSailorTemplateBirthday,
      zaptickApiKey: settings?.wasender?.zaptickApiKey,
      chakraAccessToken: settings?.wasender?.chakraAccessToken,
      ...ycloudConfigOf(settings?.wasender),
      chakraPluginId: settings?.wasender?.chakraPluginId,
      chakraWhatsappPhoneNumberId: settings?.wasender?.chakraWhatsappPhoneNumberId,
      chakraTemplateReminder: settings?.wasender?.chakraTemplateReminder,
      chakraTemplateConfirmation: settings?.wasender?.chakraTemplateConfirmation,
      chakraTemplateFollowup: settings?.wasender?.chakraTemplateFollowup,
      chakraTemplateCancellation: settings?.wasender?.chakraTemplateCancellation,
      chakraTemplateBirthday: settings?.wasender?.chakraTemplateBirthday,
    };
    const autoConfirmation: boolean = settings?.wasender?.autoConfirmation !== false; // default true
    const bookingGroupJid: string = settings?.wasender?.bookingGroupJid?.trim() || "";
    const autoGroupBooking: boolean = settings?.wasender?.autoGroupBooking === true;
    const salonName: string = settings?.salon?.name || "the salon";
    const tpl = settings?.whatsapp ?? {};

    // Master "WhatsApp Automation" toggle in Account settings — when off, the
    // booking confirmation/group alert must stay silent too, not just the
    // dashboard scheduler and cron jobs.
    const automationEnabled = settings?.wasender?.enabled !== false;

    if (automationEnabled && activeWhatsAppCredential(providerConfig)) {
      const to12h = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
      };
      const fillTemplate = (template: string, vars: Record<string, string>) =>
        template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

      const vars = {
        name: appointment.clientName,
        service: appointment.serviceNames.join(", "),
        date: appointment.date,
        time: to12h(appointment.startTime),
        salon_name: salonName,
        amount: String(appointment.totalAmount),
      };

      const normalizePhone = (p: string): string => {
        let d = p.replace(/\D/g, "");
        if (d.startsWith("0")) d = "92" + d.slice(1);
        else if (d.length === 10 && d.startsWith("3")) d = "92" + d;
        return d;
      };

      // Both sends below are queued (not sent immediately) so a booking doesn't
      // fire off a burst of WhatsApp traffic the instant it lands — same 5-7 min
      // jitter floor as every dashboard-triggered send. A serverless function
      // can't just sleep for 5-7 minutes, so /api/cron/booking-queue drains this
      // table on its own schedule instead.
      const jitterMs = () => 5 * 60_000 + Math.random() * 2 * 60_000; // 5-7 min
      async function queueBookingSend(kind: "confirmation" | "groupalert", targetPhone: string, text: string, clientNameForLog: string) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await db.execute({
          sql: `INSERT INTO wa_booking_send_queue
                  (id, user_id, kind, phone, text, client_name, appt_date, appt_time, scheduled_at, status, attempts, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
          args: [
            id, salonId, kind, targetPhone, text, clientNameForLog,
            appointment.date, appointment.startTime,
            new Date(Date.now() + jitterMs()).toISOString(), new Date().toISOString(),
          ],
        });
      }

      // Confirmation to client — skipped up front if the appointment's start time
      // has already passed (e.g. a same-day/near-term booking whose 5-7 min queue
      // delay pushed it past its own start), same as the dashboard's confirmation
      // queue: confirming a booking that's already happened isn't useful.
      const apptAlreadyStarted = appointmentStartHasPassed(appointment.date, appointment.startTime, timezoneFromSettings(settings));
      const normalizedPhone = phone ? normalizePhone(phone) : "";
      const phoneLooksFake = normalizedPhone ? isFakePlaceholderPhone(normalizedPhone) : false;
      if (normalizedPhone && !phoneLooksFake && autoConfirmation && !apptAlreadyStarted) {
        const confirmationTpl: string =
          tpl.confirmation ||
          "Hi {{name}}, your {{service}} booking on {{date}} at {{time}} is confirmed at {{salon_name}}. We look forward to seeing you! 💜";
        const confirmText = fillTemplate(confirmationTpl, vars);
        await queueBookingSend("confirmation", normalizedPhone, confirmText, appointment.clientName);
        console.log(`[booking] Queued confirmation to ${normalizedPhone}`);
      } else if (!normalizedPhone) {
        console.warn("[booking] No phone number — skipping WhatsApp confirmation");
      } else if (phoneLooksFake) {
        console.warn("[booking] Phone number looks fake/placeholder — skipping WhatsApp confirmation");
      } else if (apptAlreadyStarted) {
        console.log("[booking] Appointment time already passed — skipping WhatsApp confirmation");
      }

      // Salon group alert — respects the same "New Booking Group Alert" toggle as
      // dashboard-created bookings.
      if (autoGroupBooking && providerConfig.provider === "wasender" && bookingGroupJid.endsWith("@g.us")) {
        const groupTpl: string =
          tpl.newBooking ||
          `📅 New Online Booking!\n👤 Name: {{name}}\n💇 Service: {{service}}\n📅 Date: {{date}}\n⏰ Time: {{time}}\n💰 Total: PKR {{amount}}\n\nBooked via {{salon_name}} ${channelLabel}.`;
        const groupText = fillTemplate(groupTpl, vars);
        await queueBookingSend("groupalert", bookingGroupJid, groupText, "Group");
        console.log(`[booking] Queued group alert to ${bookingGroupJid}`);
      } else if (!autoGroupBooking) {
        console.log("[booking] New Booking Group Alert is disabled — skipping group alert");
      } else if (bookingGroupJid) {
        console.warn("[booking] bookingGroupJid is set but not a valid group JID (@g.us):", bookingGroupJid);
      } else {
        console.log("[booking] No group JID configured — skipping group alert");
      }
    } else if (!automationEnabled) {
      console.log("[booking] WhatsApp Automation is disabled — skipping confirmation");
    } else {
      console.warn("[booking] No active WhatsApp provider credentials — skipping confirmation");
    }
  } catch (waErr) {
    // Non-fatal — booking is saved regardless
    console.warn("[booking] WhatsApp send failed:", waErr);
  }

  return { ok: true, duplicate: false };
}
