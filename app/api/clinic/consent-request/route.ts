/**
 * POST /api/clinic/consent-request — creates a signing link for one patient
 * and one consent form (lib/consent-requests.ts). Scoped to the caller's own
 * salon and branch from the session.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { CONSENT_LINK_DAYS, ensureConsentRequestTable, newConsentToken } from "@/lib/consent-requests";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    clientId?: string; clientName?: string; templateId?: string; title?: string; body?: string; locationId?: string;
  } | null;
  // Branch as the browser has it active; resolveActor pins staff to their own.
  const actor = await resolveActor(req, typeof body?.locationId === "string" && body.locationId ? body.locationId : "main");
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const ok = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (!body || !ok(body.clientId, 200) || !ok(body.clientName, 200) || !ok(body.templateId, 200) || !ok(body.title, 300) || !ok(body.body, 20_000)) {
    return Response.json({ ok: false, error: "Missing or invalid form details." }, { status: 400 });
  }

  try {
    await ensureConsentRequestTable();
    const token = newConsentToken();
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO consent_requests (token, user_id, location_id, client_id, client_name, template_id, title, body, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [token, actor.userId, actor.locationId, body.clientId!, body.clientName!.trim(), body.templateId!, body.title!.trim(), body.body!,
        new Date(now).toISOString(), new Date(now + CONSENT_LINK_DAYS * 86_400_000).toISOString()],
    });
    return Response.json({ ok: true, token });
  } catch (err) {
    console.error("[clinic/consent-request]", err);
    return Response.json({ ok: false, error: "Could not create the signing link." }, { status: 500 });
  }
}
