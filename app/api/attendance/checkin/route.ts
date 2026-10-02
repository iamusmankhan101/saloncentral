/**
 * QR attendance check-in (see lib/attendance-checkin.ts).
 *
 * GET  ?s=<salonId>&t=<token>  → what the check-in page should show: salon
 *      name, whether the caller is signed in as one of this salon's staff, and
 *      today's check-in/out.
 * POST { s, t, lat, lng, accuracy } → checks in, or out if already checked in.
 *
 * The staff member is always taken from the caller's own session — never from
 * the request — and the record is written server-side so a staff phone never
 * needs the salon's attendance list.
 */

import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { getUserById } from "@/lib/auth-db";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { salonNow, timezoneFromSettings } from "@/lib/appointment-time";
import {
  DEFAULT_CHECKIN_RADIUS, DEFAULT_LATE_AFTER_MINUTES, MAX_ACCEPTED_ACCURACY, MIN_MINUTES_BEFORE_CHECKOUT,
  isWithinSalon, minutesToTime, time12, toMinutes, type QrCheckinSettings,
} from "@/lib/attendance-checkin";
import type { AttendanceRecord } from "@/lib/attendance";

type Json = Record<string, unknown>;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function storageKey(userId: string, locationId: string, entity: string): string {
  return locationId === "main" ? `${userId}_${entity}` : `${userId}_${locationId}_${entity}`;
}

async function loadJson(key: string): Promise<unknown> {
  const res = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [key] });
  if (!res.rows.length) return null;
  try { return JSON.parse(res.rows[0].data as string); } catch { return null; }
}

function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Salon settings + the check-in config, or an error the page can show. */
async function loadSalon(salonId: string, token: string) {
  if (!salonId || !token) return { error: "This check-in code is incomplete. Scan the code at reception again." };
  const settings = (await loadJson(`${salonId}_settings`)) as Json | null;
  const qr = (settings?.attendance as { qrCheckin?: QrCheckinSettings } | undefined)?.qrCheckin;
  if (!settings || !qr?.token || !tokensMatch(qr.token, token)) {
    return { error: "This check-in code is no longer valid. Ask the salon for the current code." };
  }
  const salonName = ((settings.salon as Json | undefined)?.name as string) || "Salon";
  return { settings, qr, salonName };
}

/** Who is checking in: a signed-in staff login belonging to this salon. */
async function loadStaff(req: NextRequest, salonId: string) {
  const actor = await resolveActor(req);
  if (!actor) return { signedIn: false as const };
  if (actor.userId !== salonId) return { signedIn: true as const, error: "You're signed in to a different salon's account." };
  const user = await getUserById(actor.actorId);
  if (!user?.staffId) {
    return { signedIn: true as const, error: "This login isn't linked to a staff member. Ask the salon owner to create your staff login in Account → Roles & Permissions." };
  }
  const staffList = (await loadJson(storageKey(salonId, actor.locationId, "staff"))) as { id: string; name?: string; isActive?: boolean; shiftStart?: string }[] | null;
  const staff = Array.isArray(staffList) ? staffList.find((s) => s.id === user.staffId) : undefined;
  if (!staff || staff.isActive === false) return { signedIn: true as const, error: "Your staff profile is missing or inactive at this salon." };
  return { signedIn: true as const, staffId: user.staffId, staffName: staff.name || user.ownerName, locationId: actor.locationId, shiftStart: staff.shiftStart };
}

function todayRecord(list: AttendanceRecord[], staffId: string, date: string) {
  return list.find((r) => r.staffId === staffId && r.date === date);
}

export async function GET(req: NextRequest) {
  const salonId = req.nextUrl.searchParams.get("s") ?? "";
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const salon = await loadSalon(salonId, token);
  if ("error" in salon) return Response.json({ ok: false, error: salon.error }, { status: 404 });

  const who = await loadStaff(req, salonId);
  const base = { ok: true, salonName: salon.salonName, locationSet: salon.qr.lat != null && salon.qr.lng != null };
  if (!who.signedIn) return Response.json({ ...base, signedIn: false });
  if ("error" in who) return Response.json({ ...base, signedIn: true, error: who.error });

  const { date } = salonNow(timezoneFromSettings(salon.settings));
  const list = ((await loadJson(storageKey(salonId, who.locationId, "attendance"))) ?? []) as AttendanceRecord[];
  const rec = todayRecord(Array.isArray(list) ? list : [], who.staffId, date);
  return Response.json({
    ...base, signedIn: true, staffName: who.staffName,
    today: rec ? { status: rec.status, checkIn: rec.checkIn ?? null, checkOut: rec.checkOut ?? null } : null,
  });
}

export async function POST(req: NextRequest) {
  const limit = rateLimit("attendance-checkin", clientIp(req), { maxAttempts: 20, windowMs: 10 * 60 * 1000, blockMs: 10 * 60 * 1000 });
  if (limit.blocked) return Response.json({ ok: false, error: "Too many attempts. Please wait a few minutes." }, { status: 429 });

  let body: { s?: string; t?: string; lat?: number; lng?: number; accuracy?: number };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const salonId = String(body.s ?? ""), token = String(body.t ?? "");

  const salon = await loadSalon(salonId, token);
  if ("error" in salon) return Response.json({ ok: false, error: salon.error }, { status: 404 });
  const who = await loadStaff(req, salonId);
  if (!who.signedIn) return Response.json({ ok: false, error: "Please sign in first." }, { status: 401 });
  if ("error" in who) return Response.json({ ok: false, error: who.error }, { status: 403 });

  // ── Location ───────────────────────────────────────────────────────────────
  const lat = Number(body.lat), lng = Number(body.lng), accuracy = Number(body.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return Response.json({ ok: false, error: "Your location couldn't be read. Allow location access and try again." }, { status: 400 });
  }
  if (salon.qr.lat == null || salon.qr.lng == null) {
    return Response.json({ ok: false, error: "The salon hasn't set its location for check-in yet. Ask the owner to finish QR check-in setup." }, { status: 409 });
  }
  if (!Number.isFinite(accuracy) || accuracy > MAX_ACCEPTED_ACCURACY) {
    return Response.json({ ok: false, error: "Your location is too imprecise. Turn on Precise Location / GPS and try again." }, { status: 400 });
  }
  const where = isWithinSalon({ lat: salon.qr.lat, lng: salon.qr.lng, radius: salon.qr.radius || DEFAULT_CHECKIN_RADIUS }, { lat, lng, accuracy });
  if (!where.ok) {
    const km = where.distance >= 1000 ? `${(where.distance / 1000).toFixed(1)} km` : `${Math.round(where.distance)} m`;
    return Response.json({ ok: false, error: `You need to be at the salon to check in — you're about ${km} away.` }, { status: 403 });
  }

  // ── Record ─────────────────────────────────────────────────────────────────
  const tz = timezoneFromSettings(salon.settings);
  const { date, minutes } = salonNow(tz);
  const time = minutesToTime(minutes);
  const key = storageKey(salonId, who.locationId, "attendance");
  const stored = await loadJson(key);
  const list = (Array.isArray(stored) ? stored : []) as (AttendanceRecord & { _updatedAt?: string })[];
  const existing = todayRecord(list, who.staffId, date);
  const nowIso = new Date().toISOString();

  let action: "in" | "out";
  let record: AttendanceRecord & { _updatedAt?: string; method?: string };
  if (!existing?.checkIn) {
    // Late when past the person's own shift start (else the salon's opening
    // time that day) + grace. A status the salon already set for
    // a working day (e.g. Half-day) is kept; Absent/Leave/Week Off are
    // overridden because the person evidently came in.
    const hours = salon.settings.hours as { day: string; open: boolean; from: string }[] | undefined;
    const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
    const today = Array.isArray(hours) ? hours.find((h) => h.day === weekday) : undefined;
    const lateAfter = salon.qr.lateAfterMinutes ?? DEFAULT_LATE_AFTER_MINUTES;
    const expectedStart = who.shiftStart || (today?.open && today.from ? today.from : "");
    const isLate = !!expectedStart && minutes > toMinutes(expectedStart) + lateAfter;
    const keep = existing && ["present", "late", "half-day"].includes(existing.status);
    const status = keep ? existing!.status : isLate ? "late" : "present";
    record = existing
      ? { ...existing, status, checkIn: time, method: "qr", updatedAt: nowIso, _updatedAt: nowIso }
      : { id: crypto.randomUUID(), staffId: who.staffId, date, status, checkIn: time, method: "qr", createdAt: nowIso, updatedAt: nowIso, _updatedAt: nowIso };
    action = "in";
  } else if (!existing.checkOut) {
    if (minutes - toMinutes(existing.checkIn) < MIN_MINUTES_BEFORE_CHECKOUT && minutes >= toMinutes(existing.checkIn)) {
      return Response.json({ ok: false, error: `You already checked in at ${time12(existing.checkIn)}. Scan again when you leave to check out.` }, { status: 409 });
    }
    record = { ...existing, checkOut: time, updatedAt: nowIso, _updatedAt: nowIso };
    action = "out";
  } else {
    return Response.json({ ok: false, error: `You've already checked in (${time12(existing.checkIn)}) and out (${time12(existing.checkOut)}) today.` }, { status: 409 });
  }

  const next = existing ? list.map((r) => (r === existing ? record : r)) : [record, ...list];
  await db.execute({
    sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
    args: [key, JSON.stringify(next), nowIso],
  });

  return Response.json({
    ok: true, action, staffName: who.staffName, time, status: record.status,
    today: { status: record.status, checkIn: record.checkIn ?? null, checkOut: record.checkOut ?? null },
  });
}
