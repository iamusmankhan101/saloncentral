/**
 * GET /api/public/salon?salonId=xxx
 *
 * Public salon data for the online booking page, the client app and the
 * loyalty card. No login required, so it returns ONLY what those pages show:
 * the salon's name/contact/logo, opening hours, accent colour, active services
 * and staff names. Settings hold WhatsApp/API keys and staff records hold
 * pay details and phone numbers, so everything is picked field by field —
 * never pass a stored object through whole.
 *
 * Appointments (client names and phones) are only returned to a logged-in
 * user of that same salon — the dashboard polls this for new online bookings.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";

type Json = Record<string, unknown>;

function pick(source: unknown, keys: string[]): Json {
  const out: Json = {};
  if (!source || typeof source !== "object") return out;
  for (const key of keys) {
    const value = (source as Json)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function publicSettings(settings: Json): Json {
  return {
    salon: pick(settings.salon, ["name", "phone", "address", "logo", "currency", "timezone"]),
    hours: Array.isArray(settings.hours)
      ? settings.hours.map((h) => pick(h, ["day", "open", "from", "to"]))
      : [],
    appearance: pick(settings.appearance, ["accent"]),
    payments: publicPayments(settings.payments),
  };
}

/** Only the methods the salon switched on, and only the fields a customer needs to pay. */
function publicPayments(raw: unknown): Json {
  const p = (raw && typeof raw === "object" ? raw : {}) as Json;
  const on = (key: string, fields: string[]) => {
    const m = p[key] as Json | undefined;
    return m?.enabled ? pick(m, fields) : undefined;
  };
  return {
    // Salons that saved settings before this existed still take payment at the desk.
    payAtCounter: p.payAtCounter !== false,
    jazzcash: on("jazzcash", ["number", "title"]),
    easypaisa: on("easypaisa", ["number", "title"]),
    bank: on("bank", ["bankName", "title", "accountNumber", "iban"]),
  };
}

function publicServices(services: unknown): Json[] {
  if (!Array.isArray(services)) return [];
  return services
    .filter((s) => (s as Json)?.isActive !== false)
    .map((s) => pick(s, [
      "id", "name", "description", "category", "section", "durationMin", "price",
      "variablePrice", "priceRangeMin", "priceRangeMax", "packageServiceIds",
      "customServices", "assignedStaffIds", "multiStylist", "isActive",
    ]));
}

function publicStaff(staff: unknown): Json[] {
  if (!Array.isArray(staff)) return [];
  return staff
    .filter((s) => (s as Json)?.isActive !== false)
    .map((s) => pick(s, ["id", "name", "photo", "role", "section", "specialties", "color", "isActive"]));
}

function parse(rows: ArrayLike<Record<string, unknown>>, fallback: unknown) {
  if (rows.length === 0) return fallback;
  try { return JSON.parse(rows[0].data as string); } catch { return fallback; }
}

export async function GET(req: NextRequest) {
  const salonId = req.nextUrl.searchParams.get("salonId");
  if (!salonId) return Response.json({ ok: false, error: "Missing salonId" }, { status: 400 });

  try {
    const actor = await resolveActor(req).catch(() => null);
    const isOwnSalon = actor?.userId === salonId;

    const [servicesRow, staffRow, settingsRow, apptRow] = await Promise.all([
      db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_services`] }),
      db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_staff`] }),
      db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_settings`] }),
      isOwnSalon
        ? db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_appointments`] })
        : Promise.resolve(null),
    ]);

    const settings = parse(settingsRow.rows, {}) as Json;

    return Response.json({
      ok: true,
      services: publicServices(parse(servicesRow.rows, [])),
      staff: publicStaff(parse(staffRow.rows, [])),
      settings: publicSettings(settings),
      appointments: apptRow ? parse(apptRow.rows, []) : [],
    });
  } catch (err) {
    console.error("[public/salon] error:", err);
    return Response.json({ ok: false, error: "Failed to load salon data" }, { status: 500 });
  }
}
