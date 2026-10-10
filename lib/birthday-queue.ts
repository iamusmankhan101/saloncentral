/**
 * Birthday WhatsApp queue — shared by /api/cron/birthday (4 runs a day) and
 * /api/cron/booking-queue (hourly), so queued birthday wishes drain every hour
 * instead of only at the birthday cron's four runs. See the route file for the
 * full description of the flow.
 */

import { db } from "@/lib/db";
import { activeWhatsAppCredential, isFakePlaceholderPhone, sendWhatsAppMessage, type WhatsAppProviderConfig } from "@/lib/whatsapp-provider";
import { checkWhatsAppSafety, recordWhatsAppSafetySend, type WhatsAppSafetyConfig } from "@/lib/whatsapp-safety";

const MINUTE_MS = 60 * 1000;
const BIRTHDAY_SPREAD_MIN_MS = 6 * 60 * MINUTE_MS;
const BIRTHDAY_SPREAD_MAX_MS = 8 * 60 * MINUTE_MS;
const BIRTHDAY_RETRY_MIN_MS = 20 * MINUTE_MS;
const BIRTHDAY_RETRY_MAX_MS = 30 * MINUTE_MS;
// Due rows read per run; at most one is sent per salon per run (see below).
const BIRTHDAY_DUE_BATCH_LIMIT = 50;
// A quiet day (1-5 birthdays) is sent early instead of spread across 6-8 hours:
// the first wish 10-25 min after the salon opens, then 35-55 min between each.
const BIRTHDAY_EARLY_DAY_MAX = 5;
const BIRTHDAY_EARLY_FIRST_MIN_MS = 10 * MINUTE_MS;
const BIRTHDAY_EARLY_FIRST_MAX_MS = 25 * MINUTE_MS;
const BIRTHDAY_EARLY_GAP_MIN_MS = 35 * MINUTE_MS;
const BIRTHDAY_EARLY_GAP_MAX_MS = 55 * MINUTE_MS;
// Never two birthday wishes from one salon closer than this, whichever cron
// (birthday or the hourly booking-queue) sends them.
const BIRTHDAY_MIN_SEND_GAP_MS = 30 * MINUTE_MS;
const BIRTHDAY_MAX_ATTEMPTS = 5;

interface BusinessHour {
  day: string;
  open: boolean;
  from: string;
  to: string;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

export async function ensureBirthdayTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS birthday_sent (
      user_id   TEXT NOT NULL,
      client_id TEXT NOT NULL,
      year      TEXT NOT NULL,
      sent_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, client_id, year)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS birthday_message_queue (
      user_id     TEXT NOT NULL,
      client_id   TEXT NOT NULL,
      year        TEXT NOT NULL,
      client_name TEXT NOT NULL,
      phone       TEXT NOT NULL,
      text        TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT NOT NULL,
      sent_at     TEXT,
      PRIMARY KEY (user_id, client_id, year)
    )
  `);
  await db.execute(`ALTER TABLE birthday_message_queue ADD COLUMN opted_in INTEGER NOT NULL DEFAULT 1`).catch(() => {});
  // The send cron's "pending and due" query.
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_birthday_queue_due ON birthday_message_queue(status, scheduled_at)`).catch(() => {});
  // wa_birthday_settings and wa_message_logs created by their own routes on first use
}

interface BirthdayUser {
  userId: string;
  discount: string;
  providerConfig: WhatsAppProviderConfig & WhatsAppSafetyConfig;
  birthdayTemplate: string;
  salonName: string;
  timezone: string;
  hours: BusinessHour[];
}

const DEFAULT_HOURS: BusinessHour[] = [
  { day: "Monday",    open: true,  from: "09:00", to: "20:00" },
  { day: "Tuesday",   open: true,  from: "09:00", to: "20:00" },
  { day: "Wednesday", open: true,  from: "09:00", to: "20:00" },
  { day: "Thursday",  open: true,  from: "09:00", to: "20:00" },
  { day: "Friday",    open: true,  from: "09:00", to: "20:00" },
  { day: "Saturday",  open: true,  from: "10:00", to: "18:00" },
  { day: "Sunday",    open: false, from: "10:00", to: "18:00" },
];

function zonedParts(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: Number(get("hour") || "0"),
    minute: Number(get("minute") || "0"),
  };
}

function minutesFromTime(value: string) {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function isSalonOpen(user: BirthdayUser) {
  const parts = zonedParts(user.timezone);
  const todayHours = user.hours.find((hour) => hour.day === parts.weekday);
  if (!todayHours?.open) return false;
  const nowMin = parts.hour * 60 + parts.minute;
  const from = minutesFromTime(todayHours.from);
  const to = minutesFromTime(todayHours.to);
  if (from === to) return true;
  if (from < to) return nowMin >= from && nowMin <= to;
  return nowMin >= from || nowMin <= to;
}

function salonToday(user: BirthdayUser) {
  const parts = zonedParts(user.timezone);
  return {
    year: parts.year,
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

/**
 * Scan salon_data for every salon that has autoBirthday enabled.
 * This avoids the wa_birthday_settings pre-registration requirement —
 * settings saved via the app are sufficient to trigger birthday messages.
 */
async function getAllBirthdayUsers(): Promise<BirthdayUser[]> {
  const users: BirthdayUser[] = [];
  try {
    // Pull all settings rows — entity format is "{userId}_settings"
    const result = await db.execute(
      "SELECT s.entity, s.data FROM users u JOIN salon_data s ON s.entity = u.id || '_settings'",
    );
    for (const row of result.rows) {
      try {
        const entity = row.entity as string;
        const userId = entity.replace(/_settings$/, "");
        const s = JSON.parse(row.data as string);

        const autoBirthday = s?.birthday?.autoBirthday;
        const providerConfig: WhatsAppProviderConfig & WhatsAppSafetyConfig = { ...(s?.wasender ?? {}), provider: s?.wasender?.provider || "wasender" };
        const discountEnabled = s?.birthday?.birthdayDiscountEnabled !== false;
        const template     = discountEnabled ? s?.whatsapp?.birthday : (s?.whatsapp?.birthdayNoDiscount || s?.whatsapp?.birthday);

        // Master "WhatsApp Automation" toggle in Account settings — when off, all
        // automated sends (and their log entries) must stop, not just autoBirthday.
        // Filtering here also excludes the user from processDueBirthdayMessages'
        // userById lookup, so already-queued birthday messages stop draining too.
        if (s?.wasender?.enabled === false) continue;
        if (!autoBirthday || !activeWhatsAppCredential(providerConfig) || !template) continue;

        users.push({
          userId,
          discount:        discountEnabled ? (s?.birthday?.birthdayDiscount || "a special treat") : "",
          providerConfig,
          birthdayTemplate: template,
          salonName:        s?.salon?.name || "Your Salon",
          timezone:         s?.salon?.timezone || s?.wasender?.quietHoursTimezone || "Asia/Karachi",
          hours:            Array.isArray(s?.hours) ? s.hours : DEFAULT_HOURS,
        });
      } catch { /* skip malformed row */ }
    }
  } catch { /* table may not exist yet */ }
  return users;
}

async function getClients(userId: string): Promise<{ id: string; name: string; phone: string; dob?: string; whatsappOptedOut?: boolean }[]> {
  try {
    const result = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${userId}_clients`],
    });
    if (result.rows.length === 0) return [];
    const raw = JSON.parse(result.rows[0].data as string);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function alreadySent(userId: string, clientId: string, year: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM birthday_sent WHERE user_id = ? AND client_id = ? AND year = ?",
    args: [userId, clientId, year],
  });
  return result.rows.length > 0;
}

async function markSent(userId: string, clientId: string, year: string) {
  await db.execute({
    sql: "INSERT OR IGNORE INTO birthday_sent (user_id, client_id, year, sent_at) VALUES (?, ?, ?, ?)",
    args: [userId, clientId, year, new Date().toISOString()],
  });
}

function randBetween(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

function randomScheduledAt(index: number, total: number, spreadWindowMs: number, baseTime = Date.now()): string {
  const safeTotal = Math.max(1, total);
  const slotMs = spreadWindowMs / safeTotal;
  const offsetMs = Math.floor(index * slotMs + Math.random() * slotMs);
  return new Date(baseTime + offsetMs).toISOString();
}

/** Offsets from now for a quiet day's wishes: early, with a random gap between each. */
function earlyScheduleOffsets(count: number): number[] {
  const offsets: number[] = [];
  let offset = randBetween(BIRTHDAY_EARLY_FIRST_MIN_MS, BIRTHDAY_EARLY_FIRST_MAX_MS);
  for (let i = 0; i < count; i++) {
    offsets.push(offset);
    offset += randBetween(BIRTHDAY_EARLY_GAP_MIN_MS, BIRTHDAY_EARLY_GAP_MAX_MS);
  }
  return offsets;
}

async function lastBirthdaySentMs(userId: string): Promise<number | null> {
  try {
    const result = await db.execute({
      sql: "SELECT MAX(timestamp) AS ts FROM wa_message_logs WHERE user_id = ? AND type = 'birthday' AND status = 'sent'",
      args: [userId],
    });
    const ts = result.rows[0]?.ts as string | null;
    return ts ? new Date(ts).getTime() : null;
  } catch {
    return null;
  }
}

async function queueBirthdayMessage(input: {
  userId: string;
  clientId: string;
  year: string;
  clientName: string;
  phone: string;
  text: string;
  scheduledAt: string;
  optedIn: boolean;
}) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO birthday_message_queue
            (user_id, client_id, year, client_name, phone, text, scheduled_at, status, attempts, created_at, opted_in)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    args: [
      input.userId,
      input.clientId,
      input.year,
      input.clientName,
      input.phone,
      input.text,
      input.scheduledAt,
      new Date().toISOString(),
      input.optedIn ? 1 : 0,
    ],
  });
}

async function birthdayLoggedToday(userId: string, phone: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * MINUTE_MS).toISOString();
  try {
    const result = await db.execute({
      sql: `SELECT 1 FROM wa_message_logs
            WHERE user_id = ? AND type = 'birthday' AND status = 'sent' AND timestamp >= ?
              AND replace(replace(phone, '+', ''), ' ', '') = ?
            LIMIT 1`,
      args: [userId, since, phone],
    });
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

async function queuedAlready(userId: string, clientId: string, year: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM birthday_message_queue WHERE user_id = ? AND client_id = ? AND year = ?",
    args: [userId, clientId, year],
  });
  return result.rows.length > 0;
}

async function logMessage(
  userId: string,
  clientName: string,
  phone: string,
  templateName: string,
  status: "sent" | "failed",
) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  try {
    await db.execute({
      sql: `INSERT OR REPLACE INTO wa_message_logs
              (id, user_id, timestamp, type, client_name, phone, status, template_id)
            VALUES (?, ?, ?, 'birthday', ?, ?, ?, ?)`,
      args: [id, userId, new Date().toISOString(), clientName, phone, status, templateName],
    });
  } catch {
    // non-critical — don't crash the cron
  }
}

// ─── WhatsApp send ────────────────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "92" + digits.slice(1);
  else if (digits.length === 10 && digits.startsWith("3")) digits = "92" + digits;
  return digits;
}

async function sendBirthdayMessage(
  phone: string,
  providerConfig: WhatsAppProviderConfig & WhatsAppSafetyConfig,
  text: string,
  recipientOptedIn: boolean,
): Promise<{ ok: boolean; skipped: boolean }> {
  if (!phone.trim()) return { ok: false, skipped: false };
  try {
    const safety = checkWhatsAppSafety({ phone, intent: "marketing", recipientOptedIn, config: providerConfig });
    if (!safety.ok) throw new Error(safety.error);
    const result = await sendWhatsAppMessage(providerConfig, phone, text, { messageType: "birthday" });
    if (result.ok) recordWhatsAppSafetySend({ phone, config: providerConfig });
    return { ok: result.ok, skipped: result.skipped === true };
  } catch {
    return { ok: false, skipped: false };
  }
}

// ─── Birthday check ───────────────────────────────────────────────────────────

function isBirthdayToday(dob: string, user: BirthdayUser): boolean {
  // dob is stored as "YYYY-MM-DD"
  const today = salonToday(user);
  const [, month, day] = dob.split("-");
  return (
    parseInt(month, 10) === today.month &&
    parseInt(day, 10) === today.day
  );
}

// ─── Main run ─────────────────────────────────────────────────────────────────

async function enqueueTodaysBirthdays(): Promise<{ checked: number; queued: number; skipped: number }> {
  const users = await getAllBirthdayUsers();

  let checked = 0;
  let queued = 0;
  let skipped = 0;

  for (const user of users) {
    if (!isSalonOpen(user)) continue;
    const year = salonToday(user).year;
    const clients = await getClients(user.userId);
    const birthdayClients = clients.filter((client) => client.dob && client.phone && isBirthdayToday(client.dob, user));
    const toQueue: Array<{ client: typeof birthdayClients[number]; phone: string }> = [];

    for (const client of birthdayClients) {
      checked++;
      const phone = normalizePhone(client.phone);
      if (!phone) continue;
      if (isFakePlaceholderPhone(phone)) {
        skipped++;
        continue;
      }

      // Skip if already sent this year
      if (await alreadySent(user.userId, client.id, year)) {
        skipped++;
        console.log(`[birthday] already sent ${year} → ${client.name} (${user.userId})`);
        continue;
      }
      if (await queuedAlready(user.userId, client.id, year)) {
        skipped++;
        continue;
      }

      toQueue.push({ client, phone });
    }

    // Scheduled once the real count is known (already sent/queued ones excluded).
    const earlyDay = toQueue.length <= BIRTHDAY_EARLY_DAY_MAX;
    const earlyOffsets = earlyDay ? earlyScheduleOffsets(toQueue.length) : [];
    const spreadWindowMs = randBetween(BIRTHDAY_SPREAD_MIN_MS, BIRTHDAY_SPREAD_MAX_MS);

    for (const [scheduleIndex, { client, phone }] of toQueue.entries()) {
      const text = user.birthdayTemplate
        .replace(/\{\{name\}\}/g, client.name)
        .replace(/\{\{salon_name\}\}/g, user.salonName)
        .replace(/\{\{discount\}\}/g, user.discount || "a special treat");

      await queueBirthdayMessage({
        userId: user.userId,
        clientId: client.id,
        year,
        clientName: client.name,
        phone,
        text,
        scheduledAt: earlyDay
          ? new Date(Date.now() + earlyOffsets[scheduleIndex]).toISOString()
          : randomScheduledAt(scheduleIndex, toQueue.length, spreadWindowMs),
        optedIn: !client.whatsappOptedOut,
      });
      queued++;
    }
  }

  return { checked, queued, skipped };
}

async function getDueBirthdayQueueItems(limit: number): Promise<Array<{
  userId: string;
  clientId: string;
  year: string;
  clientName: string;
  phone: string;
  text: string;
  attempts: number;
  optedIn: boolean;
}>> {
  const result = await db.execute({
    sql: `SELECT user_id, client_id, year, client_name, phone, text, attempts, opted_in
          FROM birthday_message_queue
          WHERE status = 'pending'
            AND scheduled_at <= ?
            AND attempts < ?
          ORDER BY scheduled_at ASC
          LIMIT ?`,
    args: [new Date().toISOString(), BIRTHDAY_MAX_ATTEMPTS, limit],
  });
  return result.rows.map((row) => ({
    userId: row.user_id as string,
    clientId: row.client_id as string,
    year: row.year as string,
    clientName: row.client_name as string,
    phone: row.phone as string,
    text: row.text as string,
    attempts: Number(row.attempts ?? 0),
    optedIn: Number(row.opted_in ?? 1) !== 0,
  }));
}

async function updateQueueAttempt(input: {
  userId: string;
  clientId: string;
  year: string;
  ok: boolean;
  attempts: number;
  error?: string;
}) {
  const nextStatus = input.ok ? "sent" : input.attempts + 1 >= BIRTHDAY_MAX_ATTEMPTS ? "failed" : "pending";
  const nextScheduledAt = nextStatus === "pending"
    ? new Date(Date.now() + randBetween(BIRTHDAY_RETRY_MIN_MS, BIRTHDAY_RETRY_MAX_MS)).toISOString()
    : null;
  await db.execute({
    sql: `UPDATE birthday_message_queue
          SET status = ?, attempts = ?, last_error = ?, sent_at = ?, scheduled_at = COALESCE(?, scheduled_at)
          WHERE user_id = ? AND client_id = ? AND year = ?`,
    args: [
      nextStatus,
      input.attempts + 1,
      input.error ?? null,
      input.ok ? new Date().toISOString() : null,
      nextScheduledAt,
      input.userId,
      input.clientId,
      input.year,
    ],
  });
}

async function processDueBirthdayMessages(): Promise<{ sent: number; failed: number; deferred: number }> {
  const users = await getAllBirthdayUsers();
  const userById = new Map(users.map((user) => [user.userId, user]));
  const dueItems = await getDueBirthdayQueueItems(BIRTHDAY_DUE_BATCH_LIMIT);
  // One salon's backlog must not hold up another's, but a single salon still
  // gets at most one birthday wish per run.
  const handledUsers = new Set<string>();

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  for (const item of dueItems) {
    if (handledUsers.has(item.userId)) continue;
    const user = userById.get(item.userId);
    if (!user) {
      await updateQueueAttempt({ ...item, ok: false, error: "Birthday settings or WhatsApp credentials are no longer available." });
      failed++;
      continue;
    }
    if (await alreadySent(item.userId, item.clientId, item.year)) {
      await updateQueueAttempt({ ...item, ok: true });
      deferred++;
      continue;
    }
    // Sent by hand ("Send now") or from an open dashboard since it was queued.
    if (await birthdayLoggedToday(item.userId, item.phone)) {
      await markSent(item.userId, item.clientId, item.year);
      await updateQueueAttempt({ ...item, ok: true });
      deferred++;
      continue;
    }

    handledUsers.add(item.userId);
    const lastSent = await lastBirthdaySentMs(item.userId);
    if (lastSent != null && Date.now() - lastSent < BIRTHDAY_MIN_SEND_GAP_MS) {
      // Leave it pending and due — the next cron run picks it up.
      deferred++;
      continue;
    }

    const result = await sendBirthdayMessage(item.phone, user.providerConfig, item.text, item.optedIn);
    if (result.skipped) {
      await updateQueueAttempt({ ...item, ok: true });
      deferred++;
      continue;
    }
    await logMessage(item.userId, item.clientName, item.phone, "birthday", result.ok ? "sent" : "failed");

    if (result.ok) {
      await markSent(item.userId, item.clientId, item.year);
      await updateQueueAttempt({ ...item, ok: true });
      sent++;
      console.log(`[birthday] ✓ sent queued birthday → ${item.clientName} (${item.phone})`);
    } else {
      await updateQueueAttempt({ ...item, ok: false, error: "WhatsApp send failed or was blocked by safety guard." });
      failed++;
      console.log(`[birthday] ✗ failed queued birthday → ${item.clientName} (${item.phone})`);
    }
  }

  return { sent, failed, deferred };
}

export async function runBirthdayCron(): Promise<{ checked: number; queued: number; sent: number; failed: number; skipped: number; deferred: number }> {
  const enqueueResult = await enqueueTodaysBirthdays();
  const sendResult = await processDueBirthdayMessages();
  return { ...enqueueResult, ...sendResult };
}

