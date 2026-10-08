/**
 * /api/settings
 *
 * GET  — fetch the authenticated caller's salon settings object from Turso
 * POST { data }  — upsert settings (full object) for the authenticated caller
 *
 * Stored in salon_data table under key "{userId}_settings", where userId is
 * always resolved from the caller's own session (never a client-supplied id).
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { mergeSalonSettingsSave, settingsForSalon } from "@/lib/whatsapp-credentials";
import { backupExistingSalonData } from "@/lib/data-backup";

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS salon_data (
      entity     TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    await ensureTable();
    const result = await db.execute({
      sql: "SELECT data, updated_at FROM salon_data WHERE entity = ?",
      args: [`${actor.userId}_settings`],
    });
    if (result.rows.length === 0) return Response.json({ ok: true, data: null, updatedAt: null });
    return Response.json({
      ok: true,
      // WhatsApp provider keys are admin-managed and never leave the server.
      data: settingsForSalon(JSON.parse(result.rows[0].data as string)),
      updatedAt: result.rows[0].updated_at as string,
    });
  } catch (err) {
    console.error("[settings] GET error:", err);
    return Response.json({ ok: true, data: null });
  }
}

type Json = Record<string, unknown>;

/**
 * A branch admin's (or staff member's) browser saves the whole settings
 * object, which includes every branch. They may change their own branch's
 * details and rooms, but the branch list, the other branches, the account's
 * own type and which branch the owner has open are kept as stored.
 */
function protectOtherBranches(incoming: Json, stored: Json | null, ownBranch: string): Json {
  if (!stored) return incoming;
  type Loc = { id: string };
  type Res = { locationId?: string };
  const storedLocs = (stored.locations as { items?: Loc[] } | undefined) ?? {};
  const incomingItems = ((incoming.locations as { items?: Loc[] } | undefined)?.items) ?? [];
  const mine = incomingItems.find((l) => l.id === ownBranch);
  const locations = {
    ...storedLocs,
    items: (storedLocs.items ?? []).map((l) => (l.id === ownBranch && mine ? { ...mine, id: l.id } : l)),
  };
  const storedClinic = (stored.clinic ?? {}) as Json;
  const incomingClinic = (incoming.clinic ?? {}) as Json;
  const here = (r: Res) => (r.locationId ?? "main") === ownBranch;
  const resources = [
    ...((storedClinic.resources as Res[] | undefined) ?? []).filter((r) => !here(r)),
    ...((incomingClinic.resources as Res[] | undefined) ?? []).filter(here),
  ];
  const storedSalon = (stored.salon ?? {}) as Json;
  const salon = { ...((incoming.salon ?? {}) as Json), businessType: storedSalon.businessType };
  return { ...incoming, salon, locations, clinic: { ...incomingClinic, resources } };
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { data: object };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const { data } = body;
  if (!data) return Response.json({ ok: false, error: "Missing fields" }, { status: 400 });

  try {
    await ensureTable();
    await backupExistingSalonData(`${actor.userId}_settings`, actor.userId);
    // Keep the admin-managed WhatsApp provider setup as stored — the browser
    // never has it, so its copy would otherwise wipe the keys.
    const existing = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${actor.userId}_settings`] });
    let stored: Record<string, unknown> | null = null;
    try { stored = existing.rows.length ? JSON.parse(existing.rows[0].data as string) : null; } catch { stored = null; }
    let toSave = mergeSalonSettingsSave(data as Record<string, unknown>, stored);
    if (actor.role !== "owner" && actor.role !== "admin") toSave = protectOtherBranches(toSave, stored, actor.locationId);
    await db.execute({
      sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
      args: [`${actor.userId}_settings`, JSON.stringify(toSave), new Date().toISOString()],
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[settings] POST error:", err);
    return Response.json({ ok: false, error: "DB write failed" }, { status: 500 });
  }
}
