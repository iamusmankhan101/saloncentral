const DEFAULT_TIMEZONE = "Asia/Karachi";

function parseDateTimeParts(date: string, time: string) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    !Number.isInteger(hour) || !Number.isInteger(minute) ||
    month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) return null;

  return { year, month, day, hour, minute };
}

function partsInTimezone(instantMs: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map(part => [part.type, part.value]));
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
  };
}

export function timezoneFromSettings(settings: Record<string, unknown> | null | undefined): string {
  const salon = settings?.salon as { timezone?: string } | undefined;
  const wasender = settings?.wasender as { quietHoursTimezone?: string } | undefined;
  return salon?.timezone || wasender?.quietHoursTimezone || DEFAULT_TIMEZONE;
}

export function appointmentStartMs(date: string, time: string, timezone = DEFAULT_TIMEZONE): number | null {
  const target = parseDateTimeParts(date, time);
  if (!target) return null;

  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let guess = targetAsUtc;

  for (let i = 0; i < 3; i++) {
    const actual = partsInTimezone(guess, timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const diff = actualAsUtc - targetAsUtc;
    if (diff === 0) break;
    guess -= diff;
  }

  return guess;
}

export function appointmentStartHasPassed(date: string, time: string, timezone = DEFAULT_TIMEZONE, nowMs = Date.now()): boolean {
  const startMs = appointmentStartMs(date, time, timezone);
  return startMs != null && startMs <= nowMs;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface SalonHoursDay {
  day: string;
  open: boolean;
  from: string;
  to: string;
}

// dayOffset is calendar days, computed by treating the timezone-local y/m/d as
// a plain UTC date and shifting it — we only need date arithmetic here, not an
// exact instant, so this avoids re-deriving timezone offsets per offset step.
function localDateStrInTimezone(instantMs: number, timezone: string, dayOffset: number): string {
  const p = partsInTimezone(instantMs, timezone);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, "0");
  const d = String(base.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The salon's own "today" (YYYY-MM-DD) and minutes since midnight. Booking
 * pages use this instead of the visitor's clock, so a customer in another
 * country sees the salon's today and can't pick a time that has already
 * passed at the salon. An unknown timezone falls back to the default.
 */
export function salonNow(timezone = DEFAULT_TIMEZONE, nowMs = Date.now()): { date: string; minutes: number } {
  let tz = timezone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = DEFAULT_TIMEZONE; }
  const p = partsInTimezone(nowMs, tz);
  return { date: localDateStrInTimezone(nowMs, tz, 0), minutes: p.hour * 60 + p.minute };
}

function weekdayNameForDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Noon UTC sidesteps any DST-adjacent edge case when reading back the day of week.
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

/** True when `nowMs` falls inside the salon's configured open hours for today. */
export function isWithinSalonHours(hours: SalonHoursDay[] | undefined, timezone: string, nowMs = Date.now()): boolean {
  if (!hours || hours.length === 0) return true;
  const todayStr = localDateStrInTimezone(nowMs, timezone, 0);
  const today = hours.find((h) => h.day === weekdayNameForDateStr(todayStr));
  if (!today || !today.open) return false;
  const startMs = appointmentStartMs(todayStr, today.from, timezone);
  const endMs = appointmentStartMs(todayStr, today.to, timezone);
  if (startMs == null || endMs == null) return true;
  return nowMs >= startMs && nowMs <= endMs;
}

/**
 * The next instant (absolute ms) the salon is open, starting from `nowMs`.
 * Returns `nowMs` itself if already open. Returns null if no open day is
 * found in the next week (hours misconfigured / salon closed every day) —
 * callers should treat that as "don't block on this."
 */
export function nextSalonOpenMs(hours: SalonHoursDay[] | undefined, timezone: string, nowMs = Date.now()): number | null {
  if (!hours || hours.length === 0) return nowMs;
  for (let offset = 0; offset <= 7; offset++) {
    const dateStr = localDateStrInTimezone(nowMs, timezone, offset);
    const entry = hours.find((h) => h.day === weekdayNameForDateStr(dateStr));
    if (!entry || !entry.open) continue;
    const startMs = appointmentStartMs(dateStr, entry.from, timezone);
    const endMs = appointmentStartMs(dateStr, entry.to, timezone);
    if (startMs == null || endMs == null) continue;
    if (offset === 0) {
      if (nowMs < startMs) return startMs;
      if (nowMs <= endMs) return nowMs;
      continue;
    }
    return startMs;
  }
  return null;
}
