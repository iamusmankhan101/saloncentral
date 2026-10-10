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
 *
 * The public part is cached per salon (lib/public-salon-cache.ts) and purged
 * whenever services, staff or settings are saved. Appointments are never cached.
 * ?only=appointments&since=<updatedAt> is the dashboard's cheap poll: it skips
 * the public data and, when nothing changed, doesn't send the appointments back.
 */

import { NextRequest } from "next/server";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { PUBLIC_SALON_TTL_S, publicSalonTag } from "@/lib/public-salon-cache";

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
    loyalty: publicLoyalty(settings.loyalty),
  };
}

/** What customers may see of the loyalty program: rates and free-service rewards. */
function publicLoyalty(raw: unknown): Json {
  const l = (raw && typeof raw === "object" ? raw : {}) as Json;
  if (l.enabled === false) return { enabled: false };
  const rewards = Array.isArray(l.rewards)
    ? (l.rewards as Json[])
        .filter((r) => typeof r?.serviceId === "string" && Number(r?.points) > 0)
        .map((r) => ({ serviceId: r.serviceId, points: Math.round(Number(r.points)) }))
    : [];
  return { enabled: true, rupeePerPoint: Number(l.rupeePerPoint) || 0, pointsPerRupee: Number(l.pointsPerRupee) || 0, rewards };
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
      "id", "name", "description", "category", "subcategory", "section", "durationMin", "price",
      "variablePrice", "priceRangeMin", "priceRangeMax", "packageServiceIds",
      "customServices", "assignedStaffIds", "multiStylist", "isActive", "resourceIds",
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

/** The salon's public data, from the shared cache when it's there (only filtered, public fields). */
function cachedPublicSalon(salonId: string) {
  return unstable_cache(
    async () => {
      const [servicesRow, staffRow, settingsRow] = await Promise.all([
        db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_services`] }),
        db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_staff`] }),
        db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_settings`] }),
      ]);
      return {
        services: publicServices(parse(servicesRow.rows, [])),
        staff: publicStaff(parse(staffRow.rows, [])),
        settings: publicSettings(parse(settingsRow.rows, {}) as Json),
      };
    },
    ["public-salon", salonId],
    { revalidate: PUBLIC_SALON_TTL_S, tags: [publicSalonTag(salonId)] },
  )();
}

/** The dashboard's 5-second new-booking poll: appointments only, and only when they changed. */
async function pollAppointments(salonId: string, since: string) {
  // CASE keeps the (large) data column unread when updated_at matches.
  const r = await db.execute({
    sql: "SELECT updated_at, CASE WHEN updated_at = ? THEN NULL ELSE data END AS data FROM salon_data WHERE entity = ?",
    args: [since, `${salonId}_appointments`],
  });
  if (r.rows.length === 0) return Response.json({ ok: true, appointments: [], updatedAt: "" });
  const updatedAt = String(r.rows[0].updated_at ?? "");
  if (r.rows[0].data === null) return Response.json({ ok: true, unchanged: true, updatedAt });
  return Response.json({ ok: true, appointments: parse(r.rows, []), updatedAt });
}

export async function GET(req: NextRequest) {
  const salonId = req.nextUrl.searchParams.get("salonId");
  if (!salonId) return Response.json({ ok: false, error: "Missing salonId" }, { status: 400 });

  try {
    const actor = await resolveActor(req).catch(() => null);
    const isOwnSalon = actor?.userId === salonId;

    if (req.nextUrl.searchParams.get("only") === "appointments") {
      if (!isOwnSalon) return Response.json({ ok: true, appointments: [] });
      return await pollAppointments(salonId, req.nextUrl.searchParams.get("since") ?? "");
    }

    const [publicData, apptRow] = await Promise.all([
      cachedPublicSalon(salonId),
      isOwnSalon
        ? db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_appointments`] })
        : Promise.resolve(null),
    ]);

    return Response.json({
      ok: true,
      ...publicData,
      appointments: apptRow ? parse(apptRow.rows, []) : [],
    });
  } catch (err) {
    console.error("[public/salon] error:", err);
    return Response.json({ ok: false, error: "Failed to load salon data" }, { status: 500 });
  }
}
