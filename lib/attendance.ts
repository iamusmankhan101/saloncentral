import { locationUserKey } from "./locations";
import { persistEntity } from "./turso-sync";
import { settingsStore } from "./settings-store";

export type AttendanceStatus = "present" | "absent" | "late" | "half-day" | "leave" | "week-off";

export interface AttendanceRecord {
  id: string;
  staffId: string;
  date: string;        // YYYY-MM-DD
  status: AttendanceStatus;
  /** Clock-in time, "HH:MM" 24h local. Optional — the register still works as a plain status marker. */
  checkIn?: string;
  /** Clock-out time, "HH:MM" 24h local. A value at or before checkIn is read as a shift running past midnight. */
  checkOut?: string;
  notes?: string;
  /** "qr" when the staff member checked in themselves by scanning the reception code. */
  method?: "qr";
  createdAt: string;
  updatedAt: string;
}

/** Hours in a full working day when neither the staff member nor the salon overrides it. */
export const DEFAULT_STANDARD_HOURS = 8;

/**
 * Weekly offs when the salon has not said otherwise: none.
 *
 * Deliberately empty. A salon's weekend is its busiest trading period, not its
 * closing day, so defaulting to Saturday and Sunday — as an office would —
 * quietly hands every stylist two days off a week they don't actually take. Day
 * numbers are JS `getDay()`, 0 being Sunday; a salon that closes on Mondays
 * stores [1].
 */
export const DEFAULT_WEEKLY_OFF_DAYS: number[] = [];

/**
 * Days a leave or absence is charged double for: the weekend, by default.
 *
 * A stylist off on a Saturday costs the salon far more than one off on a Tuesday,
 * so those days are charged at DEFAULT_PEAK_DAY_MULTIPLIER — one weekend day off
 * spends two days of the leave allowance, and one weekend day absent costs two
 * days of pay credit. Both the days and the multiplier are configurable.
 */
export const DEFAULT_PEAK_DAYS = [0, 6];
export const DEFAULT_PEAK_DAY_MULTIPLIER = 2;

type StaffLike = {
  weeklyOffDays?: number[];
  paidLeavesPerMonth?: number;
  standardHoursPerDay?: number;
} | null | undefined;

interface AttendanceSettings {
  leavesPerMonth?: number;
  weeklyOffDays?: number[];
  peakDays?: number[];
  peakDayMultiplier?: number;
}

function attendanceSettings(): AttendanceSettings {
  return (settingsStore.attendance as AttendanceSettings | undefined) ?? {};
}

/** Which weekdays are charged double, and by how much. */
export function peakDayRule(): { days: number[]; multiplier: number } {
  const settings = attendanceSettings();
  const days = Array.isArray(settings.peakDays)
    ? settings.peakDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : DEFAULT_PEAK_DAYS;
  const raw = Number(settings.peakDayMultiplier);
  // A multiplier below 1 would make a peak-day absence cheaper than an ordinary
  // one, which inverts the whole point of the rule.
  const multiplier = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_PEAK_DAY_MULTIPLIER;
  return { days, multiplier };
}

/**
 * How many days one dated day counts for. 1 everywhere except the salon's peak
 * days, where a leave or an absence is charged at the configured multiplier.
 */
export function dayWeightFor(date: string): number {
  const parsed = new Date(date + "T12:00:00");
  if (Number.isNaN(parsed.getTime())) return 1;
  const { days, multiplier } = peakDayRule();
  return days.includes(parsed.getDay()) ? multiplier : 1;
}

/**
 * Which weekdays this person is off: their own override if set, else the salon's,
 * else the default weekend.
 *
 * An explicitly empty list means "no weekly off" and is honoured — someone who
 * works every day is a real arrangement, and falling through to the salon default
 * would quietly give them days off they don't take.
 */
export function weeklyOffDaysFor(staff?: StaffLike): number[] {
  const own = staff?.weeklyOffDays;
  if (Array.isArray(own)) return own.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const salon = attendanceSettings().weeklyOffDays;
  if (Array.isArray(salon)) return salon.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return DEFAULT_WEEKLY_OFF_DAYS;
}

/** Whether YYYY-MM-DD falls on one of this person's weekly offs. */
export function isWeeklyOff(staff: StaffLike, date: string): boolean {
  const parsed = new Date(date + "T12:00:00");
  if (Number.isNaN(parsed.getTime())) return false;
  return weeklyOffDaysFor(staff).includes(parsed.getDay());
}

/**
 * Paid leave days allowed per month: the person's own figure if set, else the
 * salon-wide default from Settings, else none. 0 is a real answer (no paid
 * leave), so only an absent value falls through.
 */
export function leaveAllowanceFor(staff?: StaffLike): number {
  const own = Number(staff?.paidLeavesPerMonth);
  if (Number.isFinite(own) && own >= 0 && staff?.paidLeavesPerMonth != null) return own;
  const salon = Number(attendanceSettings().leavesPerMonth);
  if (Number.isFinite(salon) && salon >= 0) return salon;
  return 0;
}

/** Scheduled weekly offs between two YYYY-MM-DD dates, inclusive. */
export function countScheduledOffDays(staff: StaffLike, start: string, end: string): number {
  const offDays = weeklyOffDaysFor(staff);
  if (offDays.length === 0) return 0;
  const from = new Date(start + "T12:00:00");
  const to = new Date(end + "T12:00:00");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return 0;
  let count = 0;
  for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    if (offDays.includes(d.getDay())) count++;
  }
  return count;
}

function minutesFromTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Hours between check-in and check-out, or null when either is missing/invalid.
 *
 * A check-out at or before the check-in is treated as the next day rather than a
 * negative shift — a salon closing at 01:00 is an ordinary late night, and the
 * alternative (clamping to zero) would silently wipe out a full evening's work.
 */
export function hoursWorked(record: Pick<AttendanceRecord, "checkIn" | "checkOut">): number | null {
  if (!record.checkIn || !record.checkOut) return null;
  const start = minutesFromTime(record.checkIn);
  const end = minutesFromTime(record.checkOut);
  if (start == null || end == null) return null;
  const span = end > start ? end - start : end + 24 * 60 - start;
  return span / 60;
}

/** Length of a staff member's own shift in hours, or null when they have none. A shift past midnight wraps. */
export function shiftHours(staff?: { shiftStart?: string; shiftEnd?: string } | null): number | null {
  if (!staff?.shiftStart || !staff?.shiftEnd) return null;
  const hours = hoursWorked({ checkIn: staff.shiftStart, checkOut: staff.shiftEnd });
  return hours && hours > 0 ? hours : null;
}

/**
 * When `staff` should be in by on `date`: their own shift start, else the
 * salon's opening time that weekday. Null on a day the salon is closed and
 * they have no shift of their own.
 */
export function expectedStartFor(staff: { shiftStart?: string } | null | undefined, date: string): string | null {
  if (staff?.shiftStart) return staff.shiftStart;
  const hours = settingsStore.hours as { day: string; open: boolean; from: string }[] | undefined;
  const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
  const today = Array.isArray(hours) ? hours.find((h) => h.day === weekday) : undefined;
  return today?.open && today.from ? today.from : null;
}

/**
 * A full working day for this staff member: their own override if set, else the
 * salon-wide standard from Settings, else 8. Anything non-positive falls through
 * to the default rather than dividing pro-rated pay by zero.
 */
export function standardHoursFor(staff?: { standardHoursPerDay?: number; shiftStart?: string; shiftEnd?: string } | null): number {
  const own = Number(staff?.standardHoursPerDay);
  if (Number.isFinite(own) && own > 0) return own;
  const shift = shiftHours(staff);
  if (shift) return shift;
  const salon = Number((settingsStore.attendance as { standardHoursPerDay?: number } | undefined)?.standardHoursPerDay);
  if (Number.isFinite(salon) && salon > 0) return salon;
  return DEFAULT_STANDARD_HOURS;
}

/** Current local time as "HH:MM", for the clock-in/clock-out buttons. */
export function nowTimeString(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// How much of a working day each status counts for when pro-rating a salary.
// "leave" defaults to unpaid — a staff member's own paidLeavesPerMonth (see
// lib/types.ts) grants the first N leave days per period full credit instead;
// see the `paidLeaveAllowance` param on getAttendanceSummary below.
const CREDIT_WEIGHT: Record<AttendanceStatus, number> = {
  present: 1,
  late: 1,
  "half-day": 0.5,
  absent: 0,
  leave: 0,
  // Never actually read: a scheduled off is not a working day, so it is left out
  // of both the credit and the day count rather than weighted (see the summary).
  "week-off": 0,
};

export interface AttendanceSummary {
  present: number;
  absent: number;
  late: number;
  halfDay: number;
  leave: number;
  /** Of the `leave` count above, how many fell within the paid allowance. */
  paidLeave: number;
  /** The allowance those paid leaves were measured against, for display. */
  leaveAllowance: number;
  /** Allowance left, floored at 0. */
  leaveRemaining: number;
  /** Leave days taken beyond the allowance — the unpaid ones. */
  leaveOverBy: number;
  /** Days explicitly marked as a weekly off. Excluded from markedDays. */
  weekOff: number;
  /** Extra days the peak-day rule charged on top of the raw day counts. */
  peakExtraDays: number;
  /** Weekly offs the roster says fall in this period, marked or not. */
  scheduledOffDays: number;
  markedDays: number;
  /** Weighted credit ÷ marked days — 1 when nothing is marked (safe default: full pay). */
  creditFactor: number;
  /** Total hours actually clocked across days that have both a check-in and check-out. */
  hoursWorked: number;
  /** Standard hours × those same days, so the two numbers are directly comparable. */
  expectedHours: number;
  /** How many days in range had both times recorded (the rest fall back to status-only credit). */
  daysWithTimes: number;
  /** expectedHours − hoursWorked, floored at 0. Hours over the standard aren't subtracted back out. */
  shortfallHours: number;
}

const KEY = "werzio_attendance";

export function getAttendance(): AttendanceRecord[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(locationUserKey(KEY)) ?? "[]"); } catch { return []; }
}

export function saveAttendance(list: AttendanceRecord[]): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return persistEntity("attendance", list);
}

/** Upserts the one record for (staffId, date) — a register only ever needs a single status per staff per day. */
export function setAttendanceStatus(staffId: string, date: string, status: AttendanceStatus, notes?: string): AttendanceRecord {
  const list = getAttendance();
  const now = new Date().toISOString();
  const existing = list.find((r) => r.staffId === staffId && r.date === date);
  let record: AttendanceRecord;
  if (existing) {
    record = { ...existing, status, notes: notes ?? existing.notes, updatedAt: now };
    saveAttendance(list.map((r) => (r.id === existing.id ? record : r)));
  } else {
    record = { id: crypto.randomUUID(), staffId, date, status, notes, createdAt: now, updatedAt: now };
    saveAttendance([record, ...list]);
  }
  return record;
}

/**
 * Upserts the check-in/check-out times for (staffId, date), leaving the status
 * alone. Recording a time on an unmarked day implies the person turned up, so a
 * new record defaults to "present" rather than forcing a second click.
 */
export function setAttendanceTimes(
  staffId: string,
  date: string,
  times: { checkIn?: string; checkOut?: string },
): AttendanceRecord {
  const list = getAttendance();
  const now = new Date().toISOString();
  const existing = list.find((r) => r.staffId === staffId && r.date === date);
  // "" clears a time; undefined leaves whatever is already stored.
  const merge = (next: string | undefined, prev: string | undefined) =>
    next === undefined ? prev : (next || undefined);
  let record: AttendanceRecord;
  if (existing) {
    record = {
      ...existing,
      checkIn: merge(times.checkIn, existing.checkIn),
      checkOut: merge(times.checkOut, existing.checkOut),
      updatedAt: now,
    };
    saveAttendance(list.map((r) => (r.id === existing.id ? record : r)));
  } else {
    record = {
      id: crypto.randomUUID(), staffId, date, status: "present",
      checkIn: times.checkIn || undefined, checkOut: times.checkOut || undefined,
      createdAt: now, updatedAt: now,
    };
    saveAttendance([record, ...list]);
  }
  return record;
}

export function deleteAttendanceRecord(id: string): void {
  saveAttendance(getAttendance().filter((r) => r.id !== id));
}

/**
 * @param paidLeaveAllowance How many "leave" days within this exact period count
 *   as fully paid (a staff member's `paidLeavesPerMonth`, treated as a flat
 *   per-period allowance rather than split across calendar-month boundaries,
 *   consistent with how the rest of this feature treats "the period being
 *   evaluated" as the unit, not a strict calendar month). Leaves beyond the
 *   allowance stay unpaid. Defaults to 0 (no paid leave).
 * @param staff The staff member, used only to work out how many weekly offs the
 *   roster puts in this period. Omit it and scheduledOffDays reports 0 — every
 *   other number is unaffected.
 */
export function getAttendanceSummary(
  staffId: string,
  start: string,
  end: string,
  records?: AttendanceRecord[],
  paidLeaveAllowance = 0,
  standardHours = DEFAULT_STANDARD_HOURS,
  staff?: StaffLike,
): AttendanceSummary {
  const inRange = (records ?? getAttendance()).filter((r) => r.staffId === staffId && r.date >= start && r.date <= end);
  const summary: AttendanceSummary = {
    present: 0, absent: 0, late: 0, halfDay: 0, leave: 0, paidLeave: 0,
    leaveAllowance: paidLeaveAllowance, leaveRemaining: paidLeaveAllowance, leaveOverBy: 0,
    weekOff: 0, peakExtraDays: 0,
    scheduledOffDays: staff === undefined ? 0 : countScheduledOffDays(staff, start, end),
    markedDays: 0, creditFactor: 1,
    hoursWorked: 0, expectedHours: 0, daysWithTimes: 0, shortfallHours: 0,
  };
  const perDay = standardHours > 0 ? standardHours : DEFAULT_STANDARD_HOURS;
  let credit = 0;
  let leaveSeen = 0;
  for (const r of inRange) {
    // A scheduled off is not a working day: counting it would either dilute the
    // pay-credit percentage (as a free full day) or drag it down (as an unworked
    // one). Neither is true of a day nobody was rostered to work.
    if (r.status === "week-off") {
      summary.weekOff++;
      continue;
    }
    // A day off on a peak trading day is charged as several: it spends that many
    // days of the leave allowance, and an absence on one costs that many days of
    // pay credit. Weighting the denominator as well as the numerator is what
    // makes it bite — one Saturday absence then hurts exactly as much as two
    // ordinary ones, rather than just being one bad day among more days.
    const weight = r.status === "leave" || r.status === "absent" ? dayWeightFor(r.date) : 1;
    summary.markedDays += weight;
    summary.peakExtraDays += weight - 1;
    if (r.status === "leave") {
      summary.leave++;
      leaveSeen += weight;
      const isPaid = leaveSeen <= paidLeaveAllowance;
      if (isPaid) { summary.paidLeave++; credit += weight; }
      // unpaid leave contributes 0, same as CREDIT_WEIGHT.leave
    } else {
      if (r.status === "present") summary.present++;
      else if (r.status === "absent") summary.absent++;
      else if (r.status === "late") summary.late++;
      else if (r.status === "half-day") summary.halfDay++;

      // A day with both times clocked is measured, not assumed: credit becomes
      // the fraction of a standard day actually worked. Absent days are skipped
      // — a stray pair of times on a day marked absent shouldn't pay out.
      const worked = r.status === "absent" ? null : hoursWorked(r);
      if (worked != null) {
        summary.daysWithTimes++;
        summary.hoursWorked += worked;
        summary.expectedHours += perDay;
        // Capped at a full day: hours beyond the standard don't earn extra,
        // and they must not be allowed to offset another day's shortfall.
        credit += Math.min(1, worked / perDay);
      } else {
        credit += CREDIT_WEIGHT[r.status];
      }
    }
  }
  summary.leaveRemaining = Math.max(0, paidLeaveAllowance - leaveSeen);
  summary.leaveOverBy = Math.max(0, leaveSeen - paidLeaveAllowance);
  summary.creditFactor = summary.markedDays > 0 ? credit / summary.markedDays : 1;
  summary.hoursWorked = Math.round(summary.hoursWorked * 100) / 100;
  summary.shortfallHours = Math.max(0, Math.round((summary.expectedHours - summary.hoursWorked) * 100) / 100);
  return summary;
}
