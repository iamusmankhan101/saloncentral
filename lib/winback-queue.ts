/**
 * Server-side win-back enqueueing.
 *
 * Finds a salon's lapsed clients and drops win-back messages into the shared
 * wa_booking_send_queue, which /api/cron/booking-queue drains one message at a
 * time with the usual anti-ban pacing. Used by both the nightly
 * /api/cron/winback scan and the manual "Queue Now" button on the Messaging page,
 * so both paths apply the same cooldown, cap and spread.
 */

import { db } from "./db";
import { isFakePlaceholderPhone } from "./whatsapp-provider";
import { summarizeWinbackAudience, resolveWinbackConfig, todaysWinbackCap, winbackTemplateVars, type WinbackAppointment, type WinbackClient, type WinbackInvoice } from "./winback";
import { appointmentStartMs, isWithinSalonHours, nextSalonOpenMs, timezoneFromSettings, type SalonHoursDay } from "./appointment-time";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Win-backs are pure marketing with no deadline, so they're spread far wider than
// any other automated send — never a recognizable burst from one number.
//
// Each day's batch (15-20 messages) is spread across a random 7-8 hour window.
// Every gap gets the WINBACK_MIN_GAP_MS floor, and the rest of the window is
// shared out between the gaps by random weights — so the gaps are uneven and
// never a guessable interval, but the batch always ends inside the window and two
// messages are never closer than the floor.
//
// Nothing goes out at queue time either: even the first message waits out
// WINBACK_FIRST_SEND_*, so a manual "Queue Now" never becomes an instant blast.
const WINBACK_MIN_GAP_MS = 15 * MINUTE_MS;
const WINBACK_SPREAD_MIN_MS = 7 * 60 * MINUTE_MS;
const WINBACK_SPREAD_MAX_MS = 8 * 60 * MINUTE_MS;
const WINBACK_FIRST_SEND_MIN_MS = 30 * MINUTE_MS;
const WINBACK_FIRST_SEND_MAX_MS = 50 * MINUTE_MS;

export interface WinbackEnqueueResult {
  ok: boolean;
  reason?: string;
  eligible: number;
  queued: number;
  skipped: number;
  /** Today's send budget for this salon, and what was left of it when this ran. */
  dailyCap?: number;
  remainingToday?: number;
}

function emptyResult(reason: string, eligible = 0): WinbackEnqueueResult {
  return { ok: false, reason, eligible, queued: 0, skipped: 0 };
}

export async function ensureWinbackTables() {
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
}

function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

function randBetween(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

/** Random gaps for `count` messages that add up to a 7-8 hour spread, none under the floor. */
export function winbackGapsMs(count: number): number[] {
  if (count < 2) return [];
  const spreadMs = randBetween(WINBACK_SPREAD_MIN_MS, WINBACK_SPREAD_MAX_MS);
  const slackMs = Math.max(0, spreadMs - (count - 1) * WINBACK_MIN_GAP_MS);
  // 0.5-1.5 weights keep any one gap from swallowing most of the window.
  const weights = Array.from({ length: count - 1 }, () => 0.5 + Math.random());
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => WINBACK_MIN_GAP_MS + Math.floor(slackMs * w / total));
}

async function loadEntity<T>(userId: string, entity: string): Promise<T[]> {
  try {
    const result = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${userId}_${entity}`],
    });
    if (result.rows.length === 0) return [];
    const parsed = JSON.parse(result.rows[0].data as string);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export async function loadSalonSettings(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${userId}_settings`],
    });
    if (result.rows.length === 0) return null;
    return JSON.parse(result.rows[0].data as string) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Last time this exact number was successfully sent a win-back. The cooldown is
 * keyed on the phone rather than the client id so a client re-added under a new
 * record can't be messaged twice inside their cooldown window.
 */
async function lastWinbackSentMs(userId: string, phone: string): Promise<number | null> {
  try {
    const result = await db.execute({
      sql: `SELECT timestamp FROM wa_message_logs
            WHERE user_id = ? AND phone = ? AND type = 'winback' AND status = 'sent'
            ORDER BY timestamp DESC LIMIT 1`,
      args: [userId, phone],
    });
    if (result.rows.length === 0) return null;
    const ms = Date.parse(result.rows[0].timestamp as string);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Win-backs already queued today, so the nightly cron and any manual "Queue Now"
 * draw down one shared daily budget instead of each getting a full allowance.
 * Counts every row created today whatever its status — a failed or expired row
 * still consumed a send attempt against the number's reputation.
 */
async function queuedTodayCount(userId: string, salonDayStartMs: number): Promise<number> {
  try {
    const result = await db.execute({
      sql: `SELECT COUNT(*) AS count FROM wa_booking_send_queue
            WHERE user_id = ? AND kind = 'winback' AND created_at >= ?`,
      args: [userId, new Date(salonDayStartMs).toISOString()],
    });
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

/** Anything already waiting in the queue for this number — don't stack a second one on top. */
async function alreadyQueued(userId: string, phone: string): Promise<boolean> {
  try {
    const result = await db.execute({
      sql: `SELECT 1 FROM wa_booking_send_queue
            WHERE user_id = ? AND phone = ? AND kind = 'winback' AND status = 'pending' LIMIT 1`,
      args: [userId, phone],
    });
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/** Hold the send until the salon is actually open — nobody wants a marketing text at 3am. */
function withinOpeningHours(baseMs: number, settings: Record<string, unknown> | null): number {
  const hours = settings?.hours as SalonHoursDay[] | undefined;
  const timezone = timezoneFromSettings(settings);
  if (isWithinSalonHours(hours, timezone, baseMs)) return baseMs;
  const nextOpenMs = nextSalonOpenMs(hours, timezone, baseMs);
  if (nextOpenMs == null) return baseMs;
  return nextOpenMs + randBetween(5 * MINUTE_MS, 20 * MINUTE_MS);
}

/**
 * Queue win-back messages for one salon.
 *
 * `force` is the manual "Queue Now" button — it bypasses the autoWinback toggle
 * (the owner is asking for this send right now) but never the cooldown, the
 * per-run cap, or the credential/template checks.
 */
export async function enqueueWinbackForUser(
  userId: string,
  options: { force?: boolean; nowMs?: number } = {},
): Promise<WinbackEnqueueResult> {
  const nowMs = options.nowMs ?? Date.now();
  const settings = await loadSalonSettings(userId);
  if (!settings) return emptyResult("no-settings");

  const wasender = settings.wasender as Record<string, unknown> | undefined;
  if (wasender?.enabled === false) return emptyResult("automation-disabled");

  const config = resolveWinbackConfig(settings);
  if (!config.autoWinback && !options.force) return emptyResult("winback-disabled");

  const whatsapp = settings.whatsapp as Record<string, string> | undefined;
  const template = (config.discountEnabled ? whatsapp?.winback : whatsapp?.winbackNoDiscount)
    || whatsapp?.winback;
  if (!template?.trim()) return emptyResult("no-template");

  const clients = await loadEntity<WinbackClient>(userId, "clients");
  const appointments = await loadEntity<WinbackAppointment>(userId, "appointments");
  // POS/manual invoices count as visits too — for a till-driven salon they are
  // often the only record that a client came in, so leaving them out both hides
  // real lapsed clients and, worse, makes active ones look dormant.
  const invoices = await loadEntity<WinbackInvoice>(userId, "salon_invoices");
  const audience = summarizeWinbackAudience(clients, appointments, config.daysInactive, nowMs, invoices);
  // Lapsed clients first, so a capped day reaches them before any never-visited
  // leads. Leads get their own wording since there's no "last visit" to mention.
  const neverVisitedTemplate = (config.discountEnabled ? whatsapp?.winbackNeverVisited : whatsapp?.winbackNeverVisitedNoDiscount)
    || whatsapp?.winbackNeverVisited;
  const targets: { client: WinbackClient; template: string; lastVisit?: string; daysSinceVisit?: number }[] = [
    ...audience.lapsed.map((entry) => ({ ...entry, template })),
    ...(config.includeNeverVisited && neverVisitedTemplate?.trim()
      ? audience.neverVisited.map((client) => ({ client, template: neverVisitedTemplate }))
      : []),
  ];
  if (targets.length === 0) return { ok: true, eligible: 0, queued: 0, skipped: 0 };

  const salonName = (settings.salon as { name?: string } | undefined)?.name || "Your Salon";
  const discount = config.discountEnabled ? (config.discount || "a special offer") : "";
  const cooldownMs = config.cooldownDays * DAY_MS;
  // Walks forward one gap per queued message; every scheduled_at comes off this.
  let sendCursorMs = nowMs + randBetween(WINBACK_FIRST_SEND_MIN_MS, WINBACK_FIRST_SEND_MAX_MS);
  const createdAt = new Date(nowMs).toISOString();

  // "Per day" means the salon's own calendar day, not UTC — the owner reads this
  // cap against their own working day, and the cron fires at a fixed UTC hour that
  // falls at a different local time for every salon.
  const timezone = timezoneFromSettings(settings);
  const salonDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(nowMs));
  const salonDayStartMs = appointmentStartMs(salonDay, "00:00", timezone) ?? nowMs - DAY_MS;

  const dailyCap = todaysWinbackCap(userId, salonDay);
  const alreadyQueuedToday = await queuedTodayCount(userId, salonDayStartMs);
  const remainingToday = Math.max(0, dailyCap - alreadyQueuedToday);
  if (remainingToday === 0) {
    return { ok: true, eligible: targets.length, queued: 0, skipped: targets.length, dailyCap, remainingToday: 0 };
  }

  let skipped = 0;
  const seenPhones = new Set<string>();
  // Pick today's batch first, so the gaps can be sized to fill the 7-8 hour window.
  const batch: { clientId: string; clientName: string; phone: string; text: string }[] = [];

  for (const entry of targets) {
    if (batch.length >= remainingToday) { skipped++; continue; }

    const phone = normalizePhone(entry.client.phone || "");
    if (!phone || isFakePlaceholderPhone(phone)) { skipped++; continue; }
    // Two client records sharing a number (a couple, a family) get one message.
    if (seenPhones.has(phone)) { skipped++; continue; }

    const lastSent = await lastWinbackSentMs(userId, phone);
    if (lastSent != null && nowMs - lastSent < cooldownMs) { skipped++; continue; }
    if (await alreadyQueued(userId, phone)) { skipped++; continue; }

    const text = fillTemplate(entry.template, winbackTemplateVars({
      clientName: entry.client.name,
      salonName,
      discount,
      lastVisit: entry.lastVisit,
      daysSinceVisit: entry.daysSinceVisit,
    }));

    seenPhones.add(phone);
    batch.push({ clientId: entry.client.id, clientName: entry.client.name, phone, text });
  }

  const gaps = winbackGapsMs(batch.length);
  for (const [i, item] of batch.entries()) {
    if (i > 0) sendCursorMs += gaps[i - 1];
    // The cursor absorbs any shift to the salon's next opening time — otherwise a
    // message pushed to tomorrow morning would be followed by one still scheduled
    // for this evening, sending them out of order and inside the gap floor.
    sendCursorMs = withinOpeningHours(sendCursorMs, settings);
    const scheduledMs = sendCursorMs;

    await db.execute({
      sql: `INSERT OR IGNORE INTO wa_booking_send_queue
              (id, user_id, kind, phone, text, client_name, appt_date, appt_time, service, scheduled_at, status, attempts, created_at)
            VALUES (?, ?, 'winback', ?, ?, ?, NULL, NULL, ?, ?, 'pending', 0, ?)`,
      args: [
        // Dated so the same client can be re-queued after their cooldown lapses —
        // a bare `winback_{clientId}` row would stay in the table forever and the
        // INSERT OR IGNORE would silently drop every future attempt.
        `winback_${item.clientId}_${salonDay}`,
        userId,
        item.phone,
        item.text,
        item.clientName,
        // The `service` column is unused for win-backs, so it carries how the row
        // got here instead: the queue drainer lets a hand-queued batch through even
        // when the nightly win-back automation is switched off.
        options.force ? "manual" : "auto",
        new Date(scheduledMs).toISOString(),
        createdAt,
      ],
    });
  }

  return { ok: true, eligible: targets.length, queued: batch.length, skipped, dailyCap, remainingToday };
}
