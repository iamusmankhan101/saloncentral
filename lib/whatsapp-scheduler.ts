import { getCurrentUser } from "./auth";
import { settingsStore } from "./settings-store";
import { getStoredAppointments, getStoredClients, getStoredInventory } from "./storage";
import { locationUserKey } from "./locations";
import { getWhatsAppRandomDelayMs, type WhatsAppSafetyConfig } from "./whatsapp-safety";
import { appointmentStartHasPassed, appointmentStartMs, timezoneFromSettings } from "./appointment-time";

/**
 * Normalize a phone number to international format required by WhatsApp API.
 * e.g. "0300-1234567"  → "923001234567"
 *      "+92 300 1234567" → "923001234567"
 *      "3001234567"     → "923001234567"  (10-digit PK mobile, no leading 0)
 *      "923001234567"   → "923001234567"  (already correct)
 */
/**
 * Is a WhatsApp provider set up for this salon? The keys are admin-managed and
 * never reach the browser — the server reports `connected` instead (see
 * lib/whatsapp-credentials.ts). A key still cached from before that change
 * counts too, until the next settings sync replaces it.
 */
export function whatsAppConnected(ws: { connected?: boolean; provider?: string; apiKey?: string; botSailorApiToken?: string; zaptickApiKey?: string; chakraAccessToken?: string } | null | undefined): boolean {
  if (!ws) return false;
  if (ws.connected) return true;
  return !!(ws.provider === "botsailor" ? ws.botSailorApiToken : ws.provider === "zaptick" ? ws.zaptickApiKey : ws.provider === "chakra" ? ws.chakraAccessToken : ws.provider === "ycloud" ? (ws as { ycloudApiKey?: string }).ycloudApiKey : ws.apiKey);
}

export function normalizePhone(raw: string, countryCode = "92"): string {
  let digits = raw.replace(/\D/g, "");
  // International "00" prefix is the same as "+" (e.g. 00971501234567 → 971501234567)
  if (digits.startsWith("00")) return digits.slice(2);
  // Leading 0 → replace with country code (e.g. 03001234567 → 923001234567)
  if (digits.startsWith("0")) digits = countryCode + digits.slice(1);
  // 10-digit Pakistani mobile starting with 3 (no leading 0, no country code)
  else if (digits.length === 10 && digits.startsWith("3")) digits = countryCode + digits;
  // Already has country code
  return digits;
}

/** Replace {{variable}} placeholders in a template string with actual values. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

export type WaMsgType = "reminder" | "confirmation" | "followup" | "cancellation" | "lowstock" | "manual" | "birthday" | "winback" | "thankyou" | "newbooking" | "invoice" | "aftercare";
export type WaMsgStatus = "sent" | "failed";

export interface WaLogEntry {
  id: string;
  timestamp: string;
  type: WaMsgType;
  clientName: string;
  phone: string;
  status: WaMsgStatus;
  templateId: string;
  error?: string;
  apptId?: string;
  apptDate?: string;
  service?: string;
}

const LOG_KEY = "werzio_wa_logs";
const MAX_LOG = 200;
const LOW_STOCK_SENT_KEY = "werzio_wa_lowstock_sent";

// Shared floor for every automated WhatsApp send — nothing goes out the instant
// it's triggered. Manual/test sends (Messages page "Send Now") are the one
// exception: they call /api/whatsapp/send directly and never pass through this
// file, so they're unaffected by design.
const MESSAGE_JITTER_MIN_MS = 5 * 60_000;
const MESSAGE_JITTER_MAX_MS = 10 * 60_000;
const MINUTE_MS = 60_000;
const REMINDER_TARGET_GRACE_MS = 75 * MINUTE_MS;
const REMINDER_MIN_LEAD_MS = 30 * MINUTE_MS;
const FOLLOWUP_STALE_GRACE_MS = 36 * 60 * MINUTE_MS;
// Kept in step with posReceiptDelayMs in /api/whatsapp/queue-pos-receipt, which
// is the path POS receipts actually take now: a receipt goes out on the sale,
// so this is jitter around "now" and not the 10-15 min pacing the outbound
// automations above use.
const POS_JITTER_MIN_MS = 1 * 60_000;
const POS_JITTER_MAX_MS = 2 * 60_000;

export function getWaLogs(): WaLogEntry[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(locationUserKey(LOG_KEY)) || "[]"); } catch { return []; }
}

export function appendLog(entry: Omit<WaLogEntry, "id" | "timestamp">) {
  const fullEntry: WaLogEntry = {
    ...entry,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    timestamp: new Date().toISOString(),
  };
  const logs = getWaLogs();
  logs.unshift(fullEntry);
  if (logs.length > MAX_LOG) logs.length = MAX_LOG;
  localStorage.setItem(locationUserKey(LOG_KEY), JSON.stringify(logs));

  // Notify the dashboard UI so it can show a toast
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("werzio_wa_message_logged", { detail: fullEntry }));
  }

  // Persist to Turso so message history survives across devices / localStorage clears
  const user = getCurrentUser();
  if (user) {
    fetch("/api/wa/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, entry: fullEntry }),
    }).catch(() => { /* fire-and-forget — non-critical */ });
  }
}

const SENT_KEY = "werzio_wa_sent";
// Once a reminder first becomes due (crosses the salon's configured reminderHours
// window), it doesn't send on that same tick — it waits a random 0-10 min from the
// moment it was first detected as due. The offset is picked once per appointment
// and cached, so 50 reminders all due at once spread over the next few minutes
// instead of firing in the same tick, while still landing close to the configured time.
const REMINDER_JITTER_KEY = "werzio_wa_reminder_jitter"; // { [apptId]: sendAtTimestampMs }

function getReminderSendAt(apptId: string): number {
  const key = locationUserKey(REMINDER_JITTER_KEY);
  let map: Record<string, number> = {};
  try { map = JSON.parse(localStorage.getItem(key) || "{}"); } catch { /* reset below */ }
  if (map[apptId] != null) return map[apptId];
  const sendAt = Date.now() + MESSAGE_JITTER_MIN_MS + Math.random() * (MESSAGE_JITTER_MAX_MS - MESSAGE_JITTER_MIN_MS); // 5-10 min from now
  map[apptId] = sendAt;
  localStorage.setItem(key, JSON.stringify(map));
  return sendAt;
}

function clearReminderSendAt(apptId: string) {
  const key = locationUserKey(REMINDER_JITTER_KEY);
  try {
    const map = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, number>;
    delete map[apptId];
    localStorage.setItem(key, JSON.stringify(map));
  } catch { /* ignore */ }
}

function clearReminderSendAts(apptIds: Set<string>) {
  const key = locationUserKey(REMINDER_JITTER_KEY);
  try {
    const map = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, number>;
    apptIds.forEach((apptId) => { delete map[apptId]; });
    localStorage.setItem(key, JSON.stringify(map));
  } catch { /* ignore */ }
}

function reminderIsInSendWindow(apptStart: number, reminderHours: number, nowMs = Date.now()): boolean {
  const reminderMs = Number.isFinite(reminderHours) ? reminderHours * 60 * MINUTE_MS : 24 * 60 * MINUTE_MS;
  const targetMs = apptStart - reminderMs;
  return nowMs >= targetMs && nowMs <= targetMs + REMINDER_TARGET_GRACE_MS && apptStart - nowMs >= REMINDER_MIN_LEAD_MS;
}

const CONFIRM_QUEUE_KEY = "werzio_wa_confirm_queue";
const FOLLOWUP_QUEUE_KEY = "werzio_wa_followup_queue";
const CANCEL_QUEUE_KEY  = "werzio_wa_cancel_queue";
const BIRTHDAY_QUEUE_KEY = "werzio_wa_birthday_queue";
// Birthday messages carry a discount, so all of today's birthdays should never land
// in the same 4-hour block — spread across a random 6-8 hour window, chosen once
// per day (cached) so every client that day shares the same spread, not a fresh
// window recalculated on every scheduler tick.
const BIRTHDAY_SPREAD_MIN_MS = 6 * 60 * 60 * 1000;
const BIRTHDAY_SPREAD_MAX_MS = 8 * 60 * 60 * 1000;
const BIRTHDAY_NEXT_SEND_MIN_MS = 20 * 60_000;
const BIRTHDAY_NEXT_SEND_MAX_MS = 30 * 60_000;
const BIRTHDAY_SPREAD_CACHE_KEY = "werzio_wa_birthday_spread_window";

function getTodaysBirthdaySpreadWindowMs(): number {
  const todayKey = new Date().toISOString().slice(0, 10);
  const cacheKey = locationUserKey(BIRTHDAY_SPREAD_CACHE_KEY);
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null") as { date: string; windowMs: number } | null;
    if (cached && cached.date === todayKey) return cached.windowMs;
  } catch { /* recompute below */ }

  const windowMs = Math.round(BIRTHDAY_SPREAD_MIN_MS + Math.random() * (BIRTHDAY_SPREAD_MAX_MS - BIRTHDAY_SPREAD_MIN_MS));
  localStorage.setItem(cacheKey, JSON.stringify({ date: todayKey, windowMs }));
  return windowMs;
}

function getSentLog(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(locationUserKey(SENT_KEY)) || "{}"); } catch { return {}; }
}

function markSent(key: string) {
  const log = getSentLog();
  log[key] = Date.now();
  localStorage.setItem(locationUserKey(SENT_KEY), JSON.stringify(log));
}

function alreadySent(key: string): boolean {
  return !!getSentLog()[key];
}

// Exported for one-off "has this exact thing already been sent" checks outside
// this file (e.g. the POS invoice PDF, which isn't queued/sent through here) —
// callers should namespace their own key (e.g. `invoice_${invoiceId}`) so it
// can't collide with the confirm_/followup_/cancel_/reminder_/etc. keys used above.
export { alreadySent as hasBeenSent, markSent as markAsSent };

// Initial attempt + exactly one retry — repeatedly hammering a bad number or a down
// provider is riskier than just giving up sooner, so we no longer retry more than once.
const MAX_RETRIES = 2;
const RETRY_MIN_DELAY_MS = 30 * 60_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;
function nextRetryDelayMs(): number {
  return RETRY_MIN_DELAY_MS + Math.random() * (RETRY_MAX_DELAY_MS - RETRY_MIN_DELAY_MS);
}
const SEND_RATE_LIMIT_MS = 60_000;       // WaSender free plan: 1 message per minute

// Mandatory floor between any two automated sends, independent of the optional
// WhatsApp Safety toggle and of provider — without this, disabling Safety (or using
// BotSailor/Zaptick, which have no built-in rate limit) let two different automated
// queues (e.g. a follow-up and a cancellation due in the same scheduler tick) fire
// back-to-back with no gap at all.
//
// Base pacing is a random 5-10 minutes between every message. On top of that, every
// 10th/50th/100th message gets a longer break before the next one — only the largest
// matching tier applies (e.g. message #100 gets the 60-90 min break, not all three).
function randBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}
function minNaturalGapMs(sentSoFar: number): number {
  if (sentSoFar > 0 && sentSoFar % 100 === 0) return randBetween(60 * 60_000, 90 * 60_000);
  if (sentSoFar > 0 && sentSoFar % 50  === 0) return randBetween(30 * 60_000, 45 * 60_000);
  if (sentSoFar > 0 && sentSoFar % 10  === 0) return randBetween(10 * 60_000, 20 * 60_000);
  return randBetween(MESSAGE_JITTER_MIN_MS, MESSAGE_JITTER_MAX_MS);
}

let lastSentAt = 0;
let sentCount = 0;
let schedulerRunning = false;

// Confirmations, new-booking group alerts, reminders, and follow-ups each get their own independent pacing
// clock and gap range, so a burst of one type never eats into or waits on another
// type's spacing.
const FAST_JITTER_MIN_MS = MESSAGE_JITTER_MIN_MS;       // 5 min
const FAST_JITTER_MAX_MS = MESSAGE_JITTER_MAX_MS;        // 7 min
const REMINDER_TIER_MIN_MS = 25 * 60_000;
const REMINDER_TIER_MAX_MS = 30 * 60_000;
const FOLLOWUP_TIER_MIN_MS = 20 * 60_000;
const FOLLOWUP_TIER_MAX_MS = 35 * 60_000;

/** Builds an independent "wait at least min-max between sends of this type" gate, each with its own clock. */
function makeTierGate(minMs: number, maxMs: number, waitBeforeFirst = true) {
  let lastSentAtForTier = 0;
  return async function gate(): Promise<void> {
    if (lastSentAtForTier === 0 && !waitBeforeFirst) {
      lastSentAtForTier = Date.now();
      return;
    }
    const targetGapMs = randBetween(minMs, maxMs);
    const elapsedSinceLast = lastSentAtForTier > 0 ? Date.now() - lastSentAtForTier : 0;
    const wait = targetGapMs - elapsedSinceLast;
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    lastSentAtForTier = Date.now();
  };
}

const fastTierGate = makeTierGate(FAST_JITTER_MIN_MS, FAST_JITTER_MAX_MS);
const newBookingTierGate = makeTierGate(FAST_JITTER_MIN_MS, FAST_JITTER_MAX_MS);
const reminderTierGate = makeTierGate(REMINDER_TIER_MIN_MS, REMINDER_TIER_MAX_MS);
const followupTierGate = makeTierGate(FOLLOWUP_TIER_MIN_MS, FOLLOWUP_TIER_MAX_MS);

/** Random 1-2 min delay for POS invoice + thank-you sends, applied per transaction/client. */
export function posJitterMs(): number {
  return randBetween(POS_JITTER_MIN_MS, POS_JITTER_MAX_MS);
}

// ── Number warm-up ramp ──────────────────────────────────────────────────────
// Unofficial WhatsApp warm-up schedule: a brand-new number's daily send volume
// should climb gradually as it builds a sending history, never jumping from e.g.
// 20 messages one day to 1,000 the next (which is what gets numbers flagged/banned).
// The cap is a random number within that week's range, picked once per calendar
// day and cached so it doesn't change mid-day.
const WARMUP_START_KEY = "werzio_wa_warmup_start"; // first day this salon ever sent a WhatsApp message
const WARMUP_CAP_KEY   = "werzio_wa_warmup_cap";   // { date, cap } — today's chosen ceiling

function getWarmupStartDate(): string {
  const key = locationUserKey(WARMUP_START_KEY);
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const today = new Date().toISOString().slice(0, 10);
  localStorage.setItem(key, today);
  return today;
}

/** 1-indexed day count since the warm-up start date (start date itself = day 1). */
function daysSinceWarmupStart(startDate: string): number {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1;
}

function warmupTierRange(dayNum: number): [number, number] {
  if (dayNum <= 7)  return [30, 40];    // Week 1
  if (dayNum <= 14) return [40, 80];    // Week 2
  if (dayNum <= 21) return [80, 180];   // Week 3
  return [180, 300];                    // After a month
}

/** Today's warm-up daily send ceiling — random within the current week's tier, cached per calendar day. */
function getTodaysWarmupCap(): number {
  const todayKey = new Date().toISOString().slice(0, 10);
  const cacheKey = locationUserKey(WARMUP_CAP_KEY);
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null") as { date: string; cap: number } | null;
    if (cached && cached.date === todayKey) return cached.cap;
  } catch { /* recompute below */ }

  const dayNum = daysSinceWarmupStart(getWarmupStartDate());
  const [min, max] = warmupTierRange(dayNum);
  const cap = Math.round(min + Math.random() * (max - min));
  localStorage.setItem(cacheKey, JSON.stringify({ date: todayKey, cap }));
  return cap;
}

// sendAfter: unix ms timestamp — scheduler skips item until Date.now() >= sendAfter
// phone/clientName/serviceNames/date/startTime: snapshotted at enqueue time so the
// message can still send (with correct template variables) even if the appointment
// record is deleted before the delay elapses. Always preserve these via `...item`
// when requeuing for a retry — rebuilding a bare-bones object silently throws this
// safety net away, which is exactly what happened before this fix.
type QueueItem = {
  id: string; retries: number; sendAfter?: number;
  phone?: string; clientName?: string;
  serviceNames?: string[]; date?: string; startTime?: string;
};

function getQueue(storageKey: string): QueueItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(locationUserKey(storageKey)) || "[]") as (string | QueueItem)[];
    // Migrate old string[] format → {id, retries} format
    return raw.map((item) => typeof item === "string" ? { id: item, retries: 0 } : item);
  } catch { return []; }
}

function setQueue(storageKey: string, items: QueueItem[]) {
  localStorage.setItem(locationUserKey(storageKey), JSON.stringify(items));
}

export interface PendingQueueItem {
  type: "confirmation" | "followup" | "cancellation" | "birthday";
  apptId: string;
  clientName: string;
  phone: string;
  serviceNames?: string[];
  date?: string;
  startTime?: string;
  retries: number;
  sendAfter?: number;
}

/**
 * Snapshot of everything currently sitting in this browser's WhatsApp send
 * queues — these queues only ever live in localStorage (see QueueItem above),
 * so this is only ever a view of what THIS device has queued, not a global
 * view across every device the salon uses.
 */
export function getPendingWhatsAppQueue(): PendingQueueItem[] {
  if (typeof window === "undefined") return [];
  const fromQueue = (type: PendingQueueItem["type"], key: string): PendingQueueItem[] =>
    getQueue(key).map((item) => ({
      type,
      apptId: item.id,
      clientName: item.clientName || "",
      phone: item.phone || "",
      serviceNames: item.serviceNames,
      date: item.date,
      startTime: item.startTime,
      retries: item.retries,
      sendAfter: item.sendAfter,
    }));
  return [
    ...fromQueue("confirmation", CONFIRM_QUEUE_KEY),
    ...fromQueue("followup", FOLLOWUP_QUEUE_KEY),
    ...fromQueue("cancellation", CANCEL_QUEUE_KEY),
    ...fromQueue("birthday", BIRTHDAY_QUEUE_KEY),
  ];
}

export function purgeQueuedAppointmentMessages(apptIds: Iterable<string>): void {
  if (typeof window === "undefined") return;
  const ids = new Set(Array.from(apptIds).filter(Boolean));
  if (ids.size === 0) return;
  setQueue(CONFIRM_QUEUE_KEY, getQueue(CONFIRM_QUEUE_KEY).filter((item) => !ids.has(item.id)));
  setQueue(FOLLOWUP_QUEUE_KEY, getQueue(FOLLOWUP_QUEUE_KEY).filter((item) => !ids.has(item.id)));
  setQueue(CANCEL_QUEUE_KEY, getQueue(CANCEL_QUEUE_KEY).filter((item) => !ids.has(item.id)));
  clearReminderSendAts(ids);
}

type DbQueueKind = "groupalert" | "followup" | "cancellation" | "reminder" | "birthday" | "winback" | "lowstock" | "manual";

function dbScheduledAt(delayMs = 0): string {
  return new Date(Date.now() + delayMs).toISOString();
}

function followupWindowExpired(appt: { date: string; startTime: string }): boolean {
  const wasender = settingsStore.wasender as { followupDelayMinutes?: number };
  const rawDelayMinutes = Number(wasender.followupDelayMinutes ?? 1440);
  const delayMinutes = Number.isFinite(rawDelayMinutes) ? rawDelayMinutes : 1440;
  const startMs = appointmentStartMs(appt.date, appt.startTime, timezoneFromSettings(settingsStore as unknown as Record<string, unknown>));
  if (startMs == null) return false;
  return Date.now() > startMs + delayMinutes * MINUTE_MS + FOLLOWUP_STALE_GRACE_MS;
}

async function queueDbWhatsAppMessage(payload: {
  kind: DbQueueKind;
  phone: string;
  text: string;
  clientName?: string;
  apptId?: string;
  apptDate?: string;
  apptTime?: string;
  service?: string;
  scheduledAt?: string;
  dedupeKey?: string;
}): Promise<boolean> {
  const response = await fetch("/api/whatsapp/queue-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Queue message failed: HTTP ${response.status}`);
  const data = await response.json().catch(() => ({})) as { ok?: boolean; queued?: boolean; skipped?: boolean };
  return data.ok === true && data.queued === true && data.skipped !== true;
}

/** Queue a new-booking alert to the salon WhatsApp group in the shared DB queue. */
export async function sendGroupBookingAlert(appt: {
  id?: string;
  clientName: string;
  serviceNames: string[];
  date: string;
  startTime: string;
  totalAmount?: number;
  guests?: { name: string; serviceNames: string[] }[];
}): Promise<void> {
  if (typeof window === "undefined") return;

  // Scoped to this one booking — this function has no queue of its own (it fires
  // once, immediately, from the booking-creation call site), so a caller-side
  // double-invocation for the same appointment is the only way this could
  // duplicate; guard it here too rather than trusting every call site. Checked
  // synchronously up front (fails fast on a duplicate call), but only actually
  // marked sent once every validation gate below has passed — a config problem
  // (no credentials, no group linked) must not permanently block a later, valid
  // attempt for the same booking.
  const sentKey = appt.id ? `newbooking_${appt.id}` : undefined;
  if (sentKey && alreadySent(sentKey)) return;

  // Never announce a booking to the group after its own appointment time has
  // already passed (backdated/historical entries, bulk imports, etc) — same
  // rule as the client-facing confirmation just above.
  if (appointmentStartHasPassed(appt.date, appt.startTime, timezoneFromSettings(settingsStore as unknown as Record<string, unknown>))) return;

  const ws = settingsStore.wasender as {
    provider?: string;
    apiKey: string;
    botSailorApiToken?: string;
    zaptickApiKey?: string;
    chakraAccessToken?: string;
    bookingGroupJid?: string;
    autoGroupBooking?: boolean;
    enabled?: boolean;
  };

  // Master "WhatsApp Automation" toggle — skip entirely while off, and don't mark
  // sent, so turning it back on later never flushes a backlog of alerts for
  // bookings that came in while it was paused. This function only ever fires once
  // per booking (no queue/retry of its own), so "skip now" means "never sent".
  if (ws.enabled === false) return;

  if (ws.provider === "botsailor") { console.warn("⚠️ New Booking group alert skipped — BotSailor doesn't support sending to groups."); return; }
  if (ws.provider === "chakra") { console.warn("⚠️ New Booking group alert skipped — ChakraHQ (Meta Cloud API) doesn't support sending to groups."); return; }
  if (ws.provider === "ycloud") { console.warn("⚠️ New Booking group alert skipped — YCloud (Meta Cloud API) doesn't support sending to groups."); return; }
  if (!ws.autoGroupBooking) { console.warn("⚠️ New Booking group alert disabled — enable \"New Booking Group Alert\" in Account → WhatsApp Settings"); return; }
  const hasCredentials = whatsAppConnected(ws);
  if (!hasCredentials) { console.warn("⚠️ New Booking group alert skipped — no WhatsApp provider credentials set"); return; }
  if (!ws.bookingGroupJid?.endsWith("@g.us")) { console.warn("⚠️ New Booking group alert skipped — no WhatsApp group linked in Account → WhatsApp Settings"); return; }

  const tpl = (settingsStore.whatsapp as { newBooking?: string }).newBooking ||
    "📅 New Booking! {{name}} has booked {{service}} on {{date}} at {{time}} at {{salon_name}}. Total: PKR {{amount}}.";

  const salonName = settingsStore.salon.name as string;
  const text = fillTemplate(tpl, {
    ...buildVars(appt, salonName),
    amount: appt.totalAmount != null ? String(appt.totalAmount) : "",
  });

  const queued = await queueDbWhatsAppMessage({
    kind: "groupalert",
    phone: ws.bookingGroupJid,
    text,
    clientName: "Group",
    apptId: appt.id,
    apptDate: appt.date,
    apptTime: appt.startTime,
    scheduledAt: dbScheduledAt(MESSAGE_JITTER_MIN_MS + Math.random() * (MESSAGE_JITTER_MAX_MS - MESSAGE_JITTER_MIN_MS)),
    dedupeKey: sentKey,
  });
  if (queued && sentKey) markSent(sentKey);
}

/** Call when a new appointment is booked — queues confirmation in the shared DB queue so it drains even if this browser closes. */
export async function enqueueWhatsAppConfirmation(apptId: string): Promise<void> {
  if (typeof window === "undefined") return;
  // Master "WhatsApp Automation" toggle — skip queueing entirely while off, so
  // there's nothing sitting around to flush the moment it's re-enabled.
  if ((settingsStore.wasender as { enabled?: boolean }).enabled === false) return;
  const appt = getStoredAppointments().find(a => a.id === apptId);
  if (!appt) return;
  // Never queue a confirmation for a booking that was already in the past the
  // moment it was added to the system (backdated/historical entries, bulk
  // imports, etc). This check happens once, here, at enqueue time — it does not
  // conflict with always sending an already-queued confirmation even if pacing
  // delay later nudges it slightly past a genuinely future appointment's start
  // time (see the confirmation drain loop below); that's normal processing
  // drift for a real booking, not a backdated one.
  if (appointmentStartHasPassed(appt.date, appt.startTime, timezoneFromSettings(settingsStore as unknown as Record<string, unknown>))) return;
  // Snapshot phone/name/service/date/time now so the message can still send with
  // the right details even if the appointment record is deleted before this fires.
  const clients = getStoredClients();
  const client = clients.find(c => c.id === appt.clientId);
  const phone = client?.phone ? normalizePhone(client.phone) : "";
  if (!phone) return;

  const response = await fetch("/api/whatsapp/queue-confirmation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointment: appt, phone }),
  });
  if (!response.ok) throw new Error(`Queue confirmation failed: HTTP ${response.status}`);
}

export type ResendConfirmationResult = "queued" | "already-sent" | "no-phone" | "not-found" | "disabled" | "failed";

/**
 * Manually (re)sends a booking confirmation — the "Send Confirmation" button in
 * the appointment detail view, for when staff want it sent right now rather
 * than waiting on (or in place of) the automatic one queued at booking time.
 * Unlike enqueueWhatsAppConfirmation, this bypasses the "already sent" /
 * "already queued" guards, which exist to stop automation duplicating a send,
 * not to stop a person from deliberately asking for one — but it still honors
 * the salon's own WhatsApp Automation off-switch and every config check
 * (missing credentials, no template, etc.).
 */
export async function resendWhatsAppConfirmation(apptId: string): Promise<ResendConfirmationResult> {
  if (typeof window === "undefined") return "failed";
  if ((settingsStore.wasender as { enabled?: boolean }).enabled === false) return "disabled";
  const appt = getStoredAppointments().find(a => a.id === apptId);
  if (!appt) return "not-found";
  const clients = getStoredClients();
  const client = clients.find(c => c.id === appt.clientId);
  const phone = client?.phone ? normalizePhone(client.phone) : "";
  if (!phone) return "no-phone";
  try {
    const response = await fetch("/api/whatsapp/queue-confirmation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appointment: appt, phone, force: true }),
    });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; queued?: boolean; reason?: string };
    if (!response.ok || !data.ok) return "failed";
    if (data.queued) return "queued";
    return data.reason === "already-sent" || data.reason === "already-sent-same-visit" ? "already-sent" : "disabled";
  } catch {
    return "failed";
  }
}

/** Call when an appointment is marked completed — sends follow-up after the configured delay. */
export function enqueueWhatsAppFollowup(apptId: string) {
  if (typeof window === "undefined") return;
  // Master "WhatsApp Automation" toggle — skip queueing entirely while off, so
  // there's nothing sitting around to flush the moment it's re-enabled.
  if ((settingsStore.wasender as { enabled?: boolean }).enabled === false) return;
  const delayMinutes = (settingsStore.wasender as { followupDelayMinutes?: number }).followupDelayMinutes ?? 1440;
  const delayMs = delayMinutes * 60 * 1000;
  // On top of the configured base delay (24h by default), add a random 30-120 min
  // jitter so every customer's follow-up lands at a clearly different time instead
  // of clustering within minutes of each other when appointments are completed
  // close together (a tight cluster of automated sends looks bot-like to WhatsApp).
  const jitterMs = (30 + Math.random() * 90) * 60_000;
  // Snapshot phone/name/service/date/time now so the message can still send with
  // the right details even if the appointment record is deleted before this fires
  // (this is what caused follow-ups to fail as "Unknown client" with no phone).
  const appt = getStoredAppointments().find(a => a.id === apptId);
  if (!appt) return;
  const clients = getStoredClients();
  const client = clients.find(c => c.id === appt.clientId);
  const phone = client?.phone ? normalizePhone(client.phone) : "";
  if (!phone) return;
  // Scoped to this one booking, not the client overall — see enqueueWhatsAppConfirmation.
  if (alreadySent(`followup_${apptId}`)) return;
  const tpl = (settingsStore.whatsapp as { followup?: string }).followup;
  if (!tpl) return;
  const salonName = settingsStore.salon.name as string;
  const text = fillTemplate(tpl, buildVars(appt, salonName));
  void queueDbWhatsAppMessage({
    kind: "followup",
    phone,
    text,
    clientName: appt.clientName,
    apptId,
    apptDate: appt.date,
    apptTime: appt.startTime,
    service: appt.serviceNames.join(", "),
    scheduledAt: dbScheduledAt(delayMs + jitterMs),
    dedupeKey: `followup_${apptId}`,
  }).catch((err) => console.warn("⚠️ Follow-up queue failed", err));
}

/** Call when an appointment is cancelled — sends a win-back discount message after the configured delay. */
export function enqueueWhatsAppCancellation(apptId: string) {
  if (typeof window === "undefined") return;
  // Master "WhatsApp Automation" toggle — skip queueing entirely while off, so
  // there's nothing sitting around to flush the moment it's re-enabled.
  if ((settingsStore.wasender as { enabled?: boolean }).enabled === false) return;
  const delayMinutes = (settingsStore.wasender as { cancellationDelayMinutes?: number }).cancellationDelayMinutes ?? 1440;
  const delayMs = delayMinutes * 60 * 1000;
  // On top of the configured base delay (24h by default), add a random 15-20 min
  // jitter so this win-back offer never lands at exactly the same clock-round
  // interval after every cancellation.
  const jitterMs = (15 + Math.random() * 5) * 60_000;
  if (alreadySent(`cancel_${apptId}`)) return;
  // Snapshot phone + name now so the message can fire even if the appointment record is deleted
  const appt = getStoredAppointments().find(a => a.id === apptId);
  if (!appt) return;
  const clients = getStoredClients();
  const client = clients.find(c => c.id === appt.clientId);
  const phone = client?.phone ? normalizePhone(client.phone) : "";
  if (!phone) return;
  const cancelSettings = settingsStore.wasender as { cancelDiscount?: string; cancelDiscountEnabled?: boolean };
  const cancelTpl = (settingsStore.whatsapp as { cancellation: string; cancellationNoDiscount?: string })[
    cancelSettings.cancelDiscountEnabled === false ? "cancellationNoDiscount" : "cancellation"
  ] || (settingsStore.whatsapp as { cancellation: string }).cancellation;
  if (!cancelTpl) return;
  const salonName = settingsStore.salon.name as string;
  const cancelDiscount = cancelSettings.cancelDiscountEnabled === false ? "" : (cancelSettings.cancelDiscount || "10%");
  const text = fillTemplate(cancelTpl, { ...buildVars(appt, salonName), discount: cancelDiscount });
  void queueDbWhatsAppMessage({
    kind: "cancellation",
    phone,
    text,
    clientName: appt.clientName,
    apptId,
    apptDate: appt.date,
    apptTime: appt.startTime,
    service: appt.serviceNames.join(", "),
    scheduledAt: dbScheduledAt(delayMs + jitterMs),
    dedupeKey: `cancellation_${apptId}`,
  }).catch((err) => console.warn("⚠️ Cancellation queue failed", err));
}

type ProviderConfig = WhatsAppSafetyConfig & {
  provider?: string;
  apiKey?: string;
  botSailorApiToken?: string;
  botSailorPhoneNumberId?: string;
  zaptickApiKey?: string;
  chakraAccessToken?: string;
  chakraPluginId?: string;
  chakraWhatsappPhoneNumberId?: string;
};

// Natural, randomized pacing applied before *every* logged outcome — a successful
// send, a failed send, or an instant validation failure (missing phone, appointment
// not found, etc.) — not just real network attempts. A validation failure never
// touches the network, but if it skipped this gate it could still log at the exact
// same timestamp as a real send processed earlier in the same tick (e.g. two
// different message types landing in the log at the same minute), which looks
// exactly like an unpaced burst even though only one real message went out.
//
// Base pacing (for anything not in one of the dedicated tiers below — cancellation,
// birthday, lowstock, invoice) is a random 5-10 minutes between every logged item,
// with longer escalating breaks every 10th/50th/100th one (see minNaturalGapMs).
// This floor always applies regardless of the optional WhatsApp Safety toggle or
// provider — the Safety setting and WaSender's rate limit can only make the gap
// longer, never shorter. Also always runs for the very first item of a fresh page
// load — e.g. right after WhatsApp gets reconfigured with a backlog queued up while
// it was disconnected — so that backlog's first item doesn't fire instantly before
// pacing kicks in for the rest. Runs client-side via setTimeout — never inside the
// API route — so it can never block a serverless request into a platform timeout.
//
// Confirmation (5-10 min), new-booking group alert (5-10 min with random seconds),
// reminder (25-30 min), and
// follow-up (20-35 min) each use their own dedicated gate/clock instead of this
// shared floor — see the tier gates above.
async function applyPacingGate(providerConfig: ProviderConfig, msgType?: WaMsgType): Promise<void> {
  if (msgType === "newbooking") { await newBookingTierGate(); return; }
  if (msgType === "confirmation") { await fastTierGate(); return; }
  if (msgType === "reminder") { await reminderTierGate(); return; }
  if (msgType === "followup") { await followupTierGate(); return; }
  const selectedProvider = providerConfig.provider ?? "wasender";
  const targetGapMs = Math.max(
    getWhatsAppRandomDelayMs(providerConfig),
    selectedProvider === "wasender" ? SEND_RATE_LIMIT_MS : 0,
    minNaturalGapMs(sentCount),
  );
  const elapsedSinceLast = lastSentAt > 0 ? Date.now() - lastSentAt : 0;
  const wait = targetGapMs - elapsedSinceLast;
  if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
  lastSentAt = Date.now();
  sentCount += 1;
}

/**
 * Confirmations can be queued independently per browser/device (see
 * enqueueWhatsAppConfirmation) as well as sent directly by other tooling that
 * talks to the WhatsApp provider without going through this queue. The local
 * `alreadySent` guard only knows about sends this browser made, so before
 * actually sending a confirmation, check the shared server-side log too —
 * otherwise a confirmation sent one way can still get duplicated by the other.
 */
async function hasServerSideLog(apptId: string, type: WaMsgType): Promise<boolean> {
  const user = getCurrentUser();
  if (!user) return false;
  try {
    const res = await fetch(`/api/wa/messages?userId=${encodeURIComponent(user.id)}&apptId=${encodeURIComponent(apptId)}&type=${encodeURIComponent(type)}`);
    const data = await res.json() as { ok?: boolean; exists?: boolean };
    return data.ok === true && data.exists === true;
  } catch {
    return false;
  }
}

async function hasServerSideLogByPhone(phone: string, type: WaMsgType, since: string): Promise<boolean> {
  const user = getCurrentUser();
  if (!user) return false;
  try {
    const res = await fetch(`/api/wa/messages?userId=${encodeURIComponent(user.id)}&phone=${encodeURIComponent(phone)}&type=${encodeURIComponent(type)}&since=${encodeURIComponent(since)}`);
    const data = await res.json() as { ok?: boolean; exists?: boolean };
    return data.ok === true && data.exists === true;
  } catch {
    return false;
  }
}

async function callSendApi(
  phone: string,
  text: string,
  logMeta: { type: WaMsgType; clientName: string; apptId?: string; apptDate?: string; service?: string },
  options: { skipPacing?: boolean } = {},
): Promise<boolean> {
  if (!phone.trim()) return false;
  const providerConfig = settingsStore.wasender as WhatsAppSafetyConfig & {
    provider?: "wasender" | "botsailor" | "zaptick" | "chakra" | "ycloud";
    apiKey: string;
    botSailorApiToken?: string;
    botSailorPhoneNumberId?: string;
    zaptickApiKey?: string;
    chakraAccessToken?: string;
    chakraPluginId?: string;
    chakraWhatsappPhoneNumberId?: string;
  };

  // A manual "Send now" is one message the owner asked for, so it must not sit
  // behind the 5-7 min automation gap. The server-side safety checks (quiet
  // hours, opt-in, daily caps) in /api/whatsapp/send still apply. Moving the
  // pacing clock forward keeps the next automated send spaced after this one.
  if (options.skipPacing) {
    lastSentAt = Date.now();
    sentCount += 1;
  } else {
    await applyPacingGate(providerConfig, logMeta.type);
  }

  // Warm-up ramp: never let today's effective daily limit exceed the number's
  // warm-up ceiling, even if the salon's own Safety setting allows more.
  const warmupCap = getTodaysWarmupCap();
  const effectiveDailyLimit = Math.min(providerConfig.dailySendLimit ?? warmupCap, warmupCap);

  // Intent drives which safety rules apply (see checkWhatsAppSafety):
  //   marketing → quiet hours + opt-in required + daily/recipient caps
  //   utility   → none of the above (still paced, still capped by daily send limit)
  //   internal  → owner-facing alerts, no client-safety rules at all
  // Follow-ups are transactional (thank-you/feedback), not a promotional discount
  // push like birthday/cancellation offers, so they stay in "utility" — no quiet
  // hours, no hard opt-in block (opt-in is only *recommended* for these, not
  // enforced).
  const messageIntent =
    logMeta.type === "lowstock" ? "internal"
    : ["cancellation", "birthday"].includes(logMeta.type) ? "marketing"
    : "utility";

  // Real per-client opt-in status — without this, blockMarketingWithoutOptIn in
  // Account → WhatsApp Safety has nothing to check against. For marketing sends,
  // unknown phones are treated as not opted-in by the safety layer.
  const matchedClient = getStoredClients().find((c) => c.phone && normalizePhone(c.phone) === phone);
  const recipientOptedIn = matchedClient ? !matchedClient.whatsappOptedOut : undefined;

  let ok = false;
  let skipped = false;
  let errorReason: string | undefined;
  try {
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...providerConfig,
        dailySendLimit: effectiveDailyLimit,
        phone,
        text,
        messageIntent,
        messageType: logMeta.type,
        recipientOptedIn,
      }),
    });
    const data = await res.json() as { ok?: boolean; skipped?: boolean; errorReason?: string };
    skipped = data.skipped === true;
    if (skipped) return true;
    ok = data.ok === true;
    if (!ok) errorReason = data.errorReason || `HTTP ${res.status}`;
  } catch (err) {
    ok = false;
    errorReason = String(err);
  }
  if (!skipped) {
    appendLog({ type: logMeta.type, clientName: logMeta.clientName, phone, status: ok ? "sent" : "failed", templateId: "direct", error: errorReason, apptId: logMeta.apptId, apptDate: logMeta.apptDate, service: logMeta.service });
  }
  return ok;
}

function to12h(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  const h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${suffix}`;
}

/**
 * What {{service}} reads as. One person's booking names the service they came
 * for; a booking covering several related people names each of them with their
 * own services, since "Facial" alone tells the mother nothing about what her
 * daughter is booked for.
 */
function serviceText(appt: {
  clientName: string;
  serviceNames: string[];
  guests?: { name: string; serviceNames: string[] }[];
}): string {
  if (!appt.guests?.length) return appt.serviceNames[0] || "";
  return [
    { name: appt.clientName, serviceNames: appt.serviceNames },
    ...appt.guests,
  ]
    .filter((p) => p.serviceNames.length > 0)
    .map((p) => `${p.name}: ${p.serviceNames.join(", ")}`)
    .join("; ");
}

function buildVars(appt: {
  clientName: string;
  serviceNames: string[];
  date: string;
  startTime: string;
  guests?: { name: string; serviceNames: string[] }[];
}, salonName: string): Record<string, string> {
  return {
    name: appt.clientName,
    service: serviceText(appt),
    date: appt.date,
    time: to12h(appt.startTime),
    salon_name: salonName,
  };
}

const BIRTHDAY_SENT_KEY = "werzio_wa_birthday_sent";
// Clients whose birthday wish is being sent by hand right now. The background
// scheduler skips them, so it can't re-queue or double-send them mid-send.
const birthdaySendsInFlight = new Set<string>();

// Same quiet-day rule as the server (lib/birthday-queue.ts): with 1-5 birthdays,
// send early — first 10-25 min from now, then 35-55 min between each.
const BIRTHDAY_EARLY_DAY_MAX = 5;
function earlyBirthdayOffsets(count: number): number[] {
  const offsets: number[] = [];
  let offset = randBetween(10 * 60_000, 25 * 60_000);
  for (let i = 0; i < count; i++) {
    offsets.push(offset);
    offset += randBetween(35 * 60_000, 55 * 60_000);
  }
  return offsets;
}

function birthdaySpreadDelay(index: number, total: number): number {
  const safeTotal = Math.max(1, total);
  const slotMs = getTodaysBirthdaySpreadWindowMs() / safeTotal;
  return Math.floor(index * slotMs + Math.random() * slotMs);
}

/**
 * Client-side birthday check — runs as part of the scheduler loop.
 * The server-side cron (/api/cron/birthday) is the primary mechanism;
 * this acts as a same-day backup when the dashboard is open.
 */
export async function checkBirthdayReminders(force = false, queueNewBirthdays = true): Promise<void> {
  if (typeof window === "undefined") return;

  const ws = settingsStore.wasender as { provider?: string; apiKey: string; botSailorApiToken?: string; zaptickApiKey?: string; chakraAccessToken?: string; autoReminder: boolean; enabled?: boolean };
  const bd = settingsStore.birthday as {
    autoBirthday: boolean;
    birthdayDiscountEnabled?: boolean;
    birthdayDiscount: string;
  };

  // Master "WhatsApp Automation" toggle — same bypass convention as autoBirthday
  // below: the "Send Birthday Now" test button (force=true) is an explicit manual
  // override, so it still works even while automation is paused.
  if (!force && ws.enabled === false) return;
  if (!force && !bd.autoBirthday) return;
  if (!force && !whatsAppConnected(ws)) return;

  const birthdayTemplate = (settingsStore.whatsapp as { birthday: string; birthdayNoDiscount?: string })[
    bd.birthdayDiscountEnabled === false ? "birthdayNoDiscount" : "birthday"
  ] || (settingsStore.whatsapp as { birthday: string }).birthday;
  if (!birthdayTemplate) return;

  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const year = String(today.getFullYear());

  const sent: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem(locationUserKey(BIRTHDAY_SENT_KEY)) || "{}"); } catch { return {}; }
  })();

  const clients = getStoredClients();
  const salonName = settingsStore.salon.name as string;
  const birthdayClients = clients.filter((client) => {
    if (!client.dob || !client.phone) return false;
    const [, dobMonth, dobDay] = client.dob.split("-").map(Number);
    return dobMonth === today.getMonth() + 1 && dobDay === today.getDate();
  });
  const birthdayQueue = getQueue(BIRTHDAY_QUEUE_KEY);
  const queuedIds = new Set(birthdayQueue.map((item) => item.id));
  const newQueueItems: QueueItem[] = [];
  let scheduleIndex = 0;

  if (queueNewBirthdays) {
    const earlyOffsets = birthdayClients.length <= BIRTHDAY_EARLY_DAY_MAX ? earlyBirthdayOffsets(birthdayClients.length) : null;
    // Determine the start of today for server log checks
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    
    for (const client of birthdayClients) {
      const sentKey = `${client.id}_${year}`;
      if (sent[sentKey]) continue;
      if (queuedIds.has(client.id)) continue;
      if (birthdaySendsInFlight.has(client.id)) continue;

      const phone = normalizePhone(client.phone);
      if (!phone) continue;
      
      // Check if the server cron already sent this birthday message today
      if (await hasServerSideLogByPhone(phone, "birthday", todayStart)) {
        sent[sentKey] = todayKey;
        localStorage.setItem(locationUserKey(BIRTHDAY_SENT_KEY), JSON.stringify(sent));
        continue;
      }
      
      newQueueItems.push({
        id: client.id,
        retries: 0,
        sendAfter: Date.now() + (earlyOffsets ? earlyOffsets[scheduleIndex] : birthdaySpreadDelay(scheduleIndex, birthdayClients.length)),
        phone,
        clientName: client.name,
      });
      scheduleIndex++;
    }
    if (newQueueItems.length > 0) {
      setQueue(BIRTHDAY_QUEUE_KEY, [...birthdayQueue, ...newQueueItems]);
    }
  }

  const queue = getQueue(BIRTHDAY_QUEUE_KEY);
  const remaining: QueueItem[] = [];
  let sentOneThisTick = false;
  const todayStartCheck = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();

  for (const item of queue) {
    if (birthdaySendsInFlight.has(item.id)) continue;
    const client = clients.find((candidate) => candidate.id === item.id);
    const clientName = client?.name ?? item.clientName ?? "there";
    const phone = item.phone ?? (client?.phone ? normalizePhone(client.phone) : "");
    const sentKey = `${item.id}_${year}`;
    if (sent[sentKey]) continue;
    if (!phone) continue;

    // On initial load (queueNewBirthdays), or if the item is due, check the server log
    // This purges items that the server cron sent while they were sitting in the local queue
    const isDue = !item.sendAfter || Date.now() >= item.sendAfter;
    if ((queueNewBirthdays || isDue) && await hasServerSideLogByPhone(phone, "birthday", todayStartCheck)) {
      sent[sentKey] = todayKey;
      localStorage.setItem(locationUserKey(BIRTHDAY_SENT_KEY), JSON.stringify(sent));
      continue;
    }

    if (!isDue) { remaining.push(item); continue; }

    if (sentOneThisTick) {
      remaining.push({ ...item, sendAfter: Date.now() + randBetween(BIRTHDAY_NEXT_SEND_MIN_MS, BIRTHDAY_NEXT_SEND_MAX_MS) });
      continue;
    }

    const text = fillTemplate(birthdayTemplate, {
      name: clientName,
      salon_name: salonName,
      discount: bd.birthdayDiscountEnabled === false ? "" : (bd.birthdayDiscount || "a special treat"),
    });

    console.log(`Birthday wish queued → ${clientName} (${phone})`);
    const ok = await callSendApi(phone, text, { type: "birthday", clientName });
    sentOneThisTick = true;

    if (ok) {
      sent[sentKey] = todayKey;
      localStorage.setItem(locationUserKey(BIRTHDAY_SENT_KEY), JSON.stringify(sent));
    } else if (item.retries < MAX_RETRIES - 1) {
      remaining.push({ ...item, retries: item.retries + 1, sendAfter: Date.now() + nextRetryDelayMs() });
    }
  }
  // Re-read before writing: a manual "Send now" may have removed an item while
  // this loop was awaiting network calls, and writing the stale snapshot back
  // would resurrect it.
  const stillQueued = new Set(getQueue(BIRTHDAY_QUEUE_KEY).map((item) => item.id));
  setQueue(BIRTHDAY_QUEUE_KEY, remaining.filter((item) => stillQueued.has(item.id) && !birthdaySendsInFlight.has(item.id)));
}

export type SendBirthdayNowResult = "sent" | "already-sent" | "not-queued" | "no-template" | "failed";

/**
 * Manual "Send now" for one queued birthday wish — skips the remaining spread
 * delay but still goes through callSendApi, so pacing and safety rules apply.
 * The item is pulled from the queue before sending so a scheduler tick running
 * at the same time can't send it a second time; on failure it goes back in.
 */
export async function sendQueuedBirthdayNow(clientId: string): Promise<SendBirthdayNowResult> {
  if (typeof window === "undefined") return "failed";
  const item = getQueue(BIRTHDAY_QUEUE_KEY).find((candidate) => candidate.id === clientId);
  if (!item) return "not-queued";
  if (birthdaySendsInFlight.has(clientId)) return "not-queued";
  birthdaySendsInFlight.add(clientId);
  try {
    return await sendQueuedBirthdayItem(clientId, item);
  } finally {
    birthdaySendsInFlight.delete(clientId);
  }
}

async function sendQueuedBirthdayItem(clientId: string, item: QueueItem): Promise<SendBirthdayNowResult> {

  const bd = settingsStore.birthday as { birthdayDiscountEnabled?: boolean; birthdayDiscount: string };
  const birthdayTemplate = (settingsStore.whatsapp as { birthday: string; birthdayNoDiscount?: string })[
    bd.birthdayDiscountEnabled === false ? "birthdayNoDiscount" : "birthday"
  ] || (settingsStore.whatsapp as { birthday: string }).birthday;
  if (!birthdayTemplate) return "no-template";

  const client = getStoredClients().find((candidate) => candidate.id === clientId);
  const clientName = client?.name ?? item.clientName ?? "there";
  const phone = item.phone ?? (client?.phone ? normalizePhone(client.phone) : "");
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const sentKey = `${clientId}_${today.getFullYear()}`;
  const sent: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem(locationUserKey(BIRTHDAY_SENT_KEY)) || "{}"); } catch { return {}; }
  })();
  const markBirthdaySent = () => {
    sent[sentKey] = todayKey;
    localStorage.setItem(locationUserKey(BIRTHDAY_SENT_KEY), JSON.stringify(sent));
  };

  setQueue(BIRTHDAY_QUEUE_KEY, getQueue(BIRTHDAY_QUEUE_KEY).filter((candidate) => candidate.id !== clientId));
  if (!phone) return "failed";

  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  if (sent[sentKey] || await hasServerSideLogByPhone(phone, "birthday", todayStart)) {
    markBirthdaySent();
    return "already-sent";
  }

  const text = fillTemplate(birthdayTemplate, {
    name: clientName,
    salon_name: settingsStore.salon.name as string,
    discount: bd.birthdayDiscountEnabled === false ? "" : (bd.birthdayDiscount || "a special treat"),
  });
  const ok = await callSendApi(phone, text, { type: "birthday", clientName }, { skipPacing: true });
  if (ok) {
    markBirthdaySent();
    // Also clear the server-side birthday queue so the cron doesn't send it again.
    await fetch("/api/whatsapp/birthday-sent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, year: String(today.getFullYear()) }),
    }).catch(() => { /* the cron's own sent-today check below is the backstop */ });
    return "sent";
  }
  setQueue(BIRTHDAY_QUEUE_KEY, [...getQueue(BIRTHDAY_QUEUE_KEY), { ...item, retries: item.retries + 1, sendAfter: Date.now() + nextRetryDelayMs() }]);
  return "failed";
}

export async function runWhatsAppScheduler(): Promise<void> {
  if (typeof window === "undefined") return;
  if (schedulerRunning) return;
  schedulerRunning = true;

  try { await runSchedulerInternal(); } finally { schedulerRunning = false; }
}

/** Returns true when the current local time falls within the salon's opening hours for today. */
function isWithinSalonHours(): boolean {
  const hoursConfig = settingsStore.hours as Array<{ day: string; open: boolean; from: string; to: string }>;
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const now = new Date();
  const todayHours = hoursConfig.find(h => h.day === dayNames[now.getDay()]);
  if (!todayHours || !todayHours.open) return false;
  const [fromH, fromM] = todayHours.from.split(":").map(Number);
  const [toH, toM]     = todayHours.to.split(":").map(Number);
  const nowMin  = now.getHours() * 60 + now.getMinutes();
  return nowMin >= fromH * 60 + fromM && nowMin <= toH * 60 + toM;
}

async function runSchedulerInternal(): Promise<void> {
  const ws = settingsStore.wasender as {
    enabled?: boolean;
    provider?: string;
    apiKey: string;
    botSailorApiToken?: string;
    zaptickApiKey?: string;
    chakraAccessToken?: string;
    ownerPhone: string;
    autoReminder: boolean;
    reminderHours: number;
    autoConfirmation: boolean;
    autoFollowup: boolean;
    autoCancellation: boolean;
    autoLowStock: boolean;
  };

  // Check if WhatsApp automation is enabled
  if (ws.enabled === false) return;

  if (!whatsAppConnected(ws)) return;

  const waTpl = settingsStore.whatsapp as {
    reminder: string;
    confirmation: string;
    followup: string;
    cancellation: string;
  };

  const appointments = getStoredAppointments();
  const clients = getStoredClients();
  const salonName = settingsStore.salon.name as string;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  // Reminders, follow-ups, cancellations, birthdays, and low-stock alerts only
  // fire during salon opening hours so clients aren't messaged at midnight.
  // Booking confirmations always fire immediately regardless of the hour.
  const openNow = isWithinSalonHours();


  function clientPhone(clientId: string): string {
    const client = clients.find((c) => c.id === clientId);
    return client?.phone ? normalizePhone(client.phone) : "";
  }

  // Confirmations should always land in the client's chat before any reminder does —
  // skip reminders for appointments still waiting on a queued confirmation (it sends
  // after a deliberate 0-5 min delay, see enqueueWhatsAppConfirmation) so a same-day
  // booking's reminder can't win the race and arrive first.
  const pendingConfirmIds = new Set(getQueue(CONFIRM_QUEUE_KEY).map((item) => item.id));

  // 1. Appointment reminders — send X hours before appointment (only during salon hours).
  // A walk-in booked today for later today never gets a reminder — the confirmation
  // that just went out makes an advance-notice reminder redundant. This only applies
  // when the booking itself was ALSO made today (appt.createdAt), not merely whenever
  // the appointment happens to fall on today's date — an appointment booked days or
  // weeks ago that's simply due today still needs its reminder.
  // Gated by both the Account → WhatsApp automation toggle (ws.autoReminder) and the
  // Settings → Notifications toggle (notifications.apptReminder) — either one turned off
  // stops reminders from being queued.
  const notifications = settingsStore.notifications as { apptReminder?: boolean };
  if (openNow && ws.autoReminder && notifications.apptReminder !== false && waTpl.reminder) {
    for (const appt of appointments) {
      if (appt.status === "cancelled" || appt.status === "no-show" || appt.status === "completed") continue;
      if (appt.date === todayKey && appt.createdAt?.slice(0, 10) === todayKey) continue;
      if (ws.autoConfirmation && pendingConfirmIds.has(appt.id)) continue;
      const apptTimeMs = appointmentStartMs(appt.date, appt.startTime, timezoneFromSettings(settingsStore as unknown as Record<string, unknown>));
      // Scoped to this one appointment, not the client overall — sentKey is keyed by
      // appt.id, so a client with two distinct upcoming appointments both due for a
      // reminder still gets one reminder per appointment, not just one total.
      const sentKey = `reminder_${appt.id}`;
      const phone = clientPhone(appt.clientId);
      if (phone && apptTimeMs != null && !alreadySent(sentKey) && reminderIsInSendWindow(apptTimeMs, ws.reminderHours, now.getTime())) {
        // Wait out this reminder's own 5-10 min jitter (from when it first became
        // due) before sending — see getReminderSendAt.
        if (Date.now() < getReminderSendAt(appt.id)) continue;
        const text = fillTemplate(waTpl.reminder, buildVars(appt, salonName));
        const queued = await queueDbWhatsAppMessage({
          kind: "reminder",
          phone,
          text,
          clientName: appt.clientName,
          apptId: appt.id,
          apptDate: appt.date,
          apptTime: appt.startTime,
          service: appt.serviceNames.join(", "),
          scheduledAt: dbScheduledAt(REMINDER_TIER_MIN_MS + Math.random() * (REMINDER_TIER_MAX_MS - REMINDER_TIER_MIN_MS)),
          dedupeKey: sentKey,
        }).catch((err) => {
          console.warn("⚠️ Reminder queue failed", err);
          return false;
        });
        if (queued) { markSent(sentKey); clearReminderSendAt(appt.id); }
      }
    }
  }

  // 2. Booking confirmations — drain the confirm queue (one retry after 30-60 min on failure)
  if (ws.autoConfirmation && waTpl.confirmation) {
    const queue = getQueue(CONFIRM_QUEUE_KEY);
    const remaining: QueueItem[] = [];
    for (const item of queue) {
      // Retry delay — keep waiting if last attempt was too recent
      if (item.sendAfter && Date.now() < item.sendAfter) { remaining.push(item); continue; }
      const appt = appointments.find((a) => a.id === item.id);
      if (!appt) continue;
      // A confirmation queued while automation was off (or during a long pacing
      // backlog) can sit for hours or days — by the time the queue drains, the
      // appointment's start time may already have passed, same-day or otherwise.
      // Confirming a booking that's already happened (or been missed) isn't useful
      // — drop it instead of sending, rather than the previous "send it late
      // anyway" behavior.
      if (appointmentStartHasPassed(appt.date, appt.startTime, timezoneFromSettings(settingsStore as unknown as Record<string, unknown>))) continue;
      const phone = clientPhone(appt.clientId);
      const clientName = appt.clientName;
      if (!phone) {
        continue;
      }
      const sentKey = `confirm_${item.id}`;
      if (alreadySent(sentKey)) continue;
      // This browser's own queue only knows about sends it made itself — check
      // the shared server-side log too, since another device (or a direct,
      // out-of-band send) may have already confirmed this same booking.
      if (await hasServerSideLog(item.id, "confirmation")) { markSent(sentKey); continue; }
      const serviceNames = appt.serviceNames;
      const date = appt.date;
      const startTime = appt.startTime;
      const text = fillTemplate(waTpl.confirmation, buildVars({ clientName, serviceNames, date, startTime, guests: appt.guests }, salonName));
      const ok = await callSendApi(phone, text, { type: "confirmation", clientName, apptId: item.id, apptDate: date, service: serviceText({ clientName, serviceNames, guests: appt.guests }) });
      if (ok) {
        markSent(sentKey);
      } else if (item.retries < MAX_RETRIES - 1) {
        remaining.push({ ...item, retries: item.retries + 1, sendAfter: Date.now() + nextRetryDelayMs() });
      }
    }
    setQueue(CONFIRM_QUEUE_KEY, remaining);
  }

  // 3. Legacy local follow-up queue migration.
  // New follow-ups are queued directly in the shared DB queue by
  // enqueueWhatsAppFollowup(). Older browsers may still have follow-ups sitting
  // in localStorage from before that migration. Do not send those directly from
  // this browser, or they will appear in the message log without ever appearing
  // in the DB queue details. Move due legacy items into the DB queue instead.
  if (ws.autoFollowup && waTpl.followup) {
    const queue = getQueue(FOLLOWUP_QUEUE_KEY);
    const remaining: QueueItem[] = [];
    for (const item of queue) {
      if (item.sendAfter && Date.now() < item.sendAfter) { remaining.push(item); continue; }
      const appt = appointments.find((a) => a.id === item.id);
      if (!appt) continue;
      if (followupWindowExpired(appt)) continue;
      const phone = clientPhone(appt.clientId);
      const clientName = appt.clientName;
      if (!phone) {
        continue;
      }
      const sentKey = `followup_${item.id}`;
      if (alreadySent(sentKey)) continue;
      if (await hasServerSideLog(item.id, "followup")) { markSent(sentKey); continue; }
      const serviceNames = appt.serviceNames;
      const date = appt.date;
      const startTime = appt.startTime;
      const text = fillTemplate(waTpl.followup, buildVars({ clientName, serviceNames, date, startTime }, salonName));
      const queued = await queueDbWhatsAppMessage({
        kind: "followup",
        phone,
        text,
        clientName,
        apptId: item.id,
        apptDate: date,
        apptTime: startTime,
        service: serviceNames.join(", "),
        scheduledAt: dbScheduledAt(30 * 60_000 + Math.random() * 90 * 60_000),
        dedupeKey: sentKey,
      }).catch((err) => {
        console.warn("⚠️ Legacy follow-up queue migration failed", err);
        return false;
      });
      if (queued) {
        markSent(sentKey);
      } else if (item.retries < MAX_RETRIES - 1) {
        remaining.push({ ...item, retries: item.retries + 1, sendAfter: Date.now() + nextRetryDelayMs() });
      }
    }
    setQueue(FOLLOWUP_QUEUE_KEY, remaining);
  }

  // 4. Cancellation win-back — retries once after a 30-60 min delay on failure.
  const cancelSettings = settingsStore.wasender as { cancelDiscount?: string; cancelDiscountEnabled?: boolean };
  const cancelTpl = (settingsStore.whatsapp as { cancellation: string; cancellationNoDiscount?: string })[
    cancelSettings.cancelDiscountEnabled === false ? "cancellationNoDiscount" : "cancellation"
  ] || (settingsStore.whatsapp as { cancellation: string }).cancellation;
  if (ws.autoCancellation && cancelTpl) {
    const queue = getQueue(CANCEL_QUEUE_KEY);
    const remaining: QueueItem[] = [];
    for (const item of queue) {
      if (item.sendAfter && Date.now() < item.sendAfter) { remaining.push(item); continue; }
      const sentKey = `cancel_${item.id}`;
      if (alreadySent(sentKey)) continue;
      const appt = appointments.find((a) => a.id === item.id);
      if (!appt) continue;
      const phone = clientPhone(appt.clientId);
      const clientName = appt.clientName;
      if (!phone) {
        continue;
      }
      const cancelDiscount = cancelSettings.cancelDiscountEnabled === false ? "" : (cancelSettings.cancelDiscount || "10%");
      const text = fillTemplate(cancelTpl, { ...buildVars(appt, salonName), discount: cancelDiscount });
      const ok = await callSendApi(phone, text, { type: "cancellation", clientName });
      if (ok) {
        markSent(sentKey);
      } else if (item.retries < MAX_RETRIES - 1) {
        remaining.push({ ...item, retries: item.retries + 1, sendAfter: Date.now() + nextRetryDelayMs() });
      }
    }
    setQueue(CANCEL_QUEUE_KEY, remaining);
  }

  // 5. Low stock alerts (only during salon hours)
  if (openNow) await checkLowStockAlerts();

  // 6. Birthday reminders are queued during salon hours, but queued birthday
  // messages continue processing after close so the spread window can finish.
  await checkBirthdayReminders(false, openNow);
}


/** Call this whenever inventory is saved to send alerts immediately for newly-low items. */
export async function checkLowStockAlerts(): Promise<void> {
  if (typeof window === "undefined") return;

  const ws = settingsStore.wasender as {
    provider?: string; apiKey: string; botSailorApiToken?: string; zaptickApiKey?: string; chakraAccessToken?: string; autoLowStock: boolean; ownerPhone: string; bookingGroupJid?: string; enabled?: boolean;
  };
  // Master "WhatsApp Automation" toggle — this function is called directly from
  // the inventory page too (not just the gated scheduler tick), so it needs its
  // own check.
  if (ws.enabled === false) return;
  if (!ws.autoLowStock) { console.warn("⚠️ Low stock alerts disabled — enable in Account → WhatsApp Settings"); return; }
  // BotSailor and ChakraHQ (both Meta Cloud API) don't support sending to groups
  // (same restriction as the New Booking group alert), so the group target only
  // applies for the WaSender/Zaptick providers.
  const groupJid = ws.provider !== "botsailor" && ws.provider !== "chakra" && ws.bookingGroupJid?.endsWith("@g.us") ? ws.bookingGroupJid : "";
  if (!ws.ownerPhone && !groupJid) { console.warn("⚠️ No owner phone or linked WhatsApp group set — add one in Account → WhatsApp Settings"); return; }
  if (!whatsAppConnected(ws)) { console.warn("⚠️ No WhatsApp provider credentials set — add them in Account → WhatsApp Settings"); return; }

  const lowstockTemplate = (settingsStore.whatsapp as { lowstock: string }).lowstock;
  if (!lowstockTemplate) { console.warn("⚠️ No low stock template found in WhatsApp Settings"); return; }

  const today = new Date().toISOString().slice(0, 10);
  const sent: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem(locationUserKey(LOW_STOCK_SENT_KEY)) || "{}"); } catch { return {}; }
  })();

  const inventory = getStoredInventory();
  const newlyLow = inventory.filter(
    (item) => item.currentStock <= item.minStock && sent[item.id] !== today,
  );
  if (newlyLow.length === 0) return;

  const salonName = settingsStore.salon.name as string;
  const itemList = newlyLow.map((i) => `${i.name} (${i.currentStock} ${i.unit} left)`).join(", ");

  const text = fillTemplate(lowstockTemplate, {
    items: itemList,
    count: String(newlyLow.length),
    salon_name: salonName,
  });

  // Send to the owner's own number and the linked salon WhatsApp group — either or
  // both, whichever are configured — so the whole team can see it, not just one phone.
  const stockKey = newlyLow.map((i) => i.id).sort().join("_");
  let queuedAny = false;
  if (ws.ownerPhone) {
    console.log("📦 Sending low stock alert for:", newlyLow.map((i) => i.name), "→", normalizePhone(ws.ownerPhone));
    const queued = await queueDbWhatsAppMessage({
      kind: "lowstock",
      phone: normalizePhone(ws.ownerPhone),
      text,
      clientName: "Owner",
      scheduledAt: dbScheduledAt(MESSAGE_JITTER_MIN_MS + Math.random() * (MESSAGE_JITTER_MAX_MS - MESSAGE_JITTER_MIN_MS)),
      dedupeKey: `lowstock_owner_${today}_${stockKey}`,
    }).catch((err) => {
      console.warn("⚠️ Low stock owner queue failed", err);
      return false;
    });
    queuedAny = queuedAny || queued;
    console.log("📦 Low stock alert (owner) result:", queued ? "queued ✅" : "not queued");
  }
  if (groupJid) {
    console.log("📦 Sending low stock alert for:", newlyLow.map((i) => i.name), "→ linked group");
    const queued = await queueDbWhatsAppMessage({
      kind: "lowstock",
      phone: groupJid,
      text,
      clientName: "Group",
      scheduledAt: dbScheduledAt(MESSAGE_JITTER_MIN_MS + Math.random() * (MESSAGE_JITTER_MAX_MS - MESSAGE_JITTER_MIN_MS)),
      dedupeKey: `lowstock_group_${today}_${stockKey}`,
    }).catch((err) => {
      console.warn("⚠️ Low stock group queue failed", err);
      return false;
    });
    queuedAny = queuedAny || queued;
    console.log("📦 Low stock alert (group) result:", queued ? "queued ✅" : "not queued");
  }

  if (queuedAny) {
    newlyLow.forEach((i) => { sent[i.id] = today; });
    localStorage.setItem(locationUserKey(LOW_STOCK_SENT_KEY), JSON.stringify(sent));
  }
}
