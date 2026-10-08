/**
 * Public side of remote consent signing (/consent/[token]).
 *   GET  ?token=…  → the form to sign, or that it's already signed / expired
 *   POST { token, name, signature, agreed } → records the signature
 * The token is the only key: 24 random bytes, single use, expires after a week.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { appendSignedConsent, ensureConsentRequestTable } from "@/lib/consent-requests";
import type { ConsentRecord } from "@/lib/clinic";

const MAX_SIGNATURE_CHARS = 400_000;

async function load(token: string) {
  await ensureConsentRequestTable();
  const r = await db.execute({ sql: "SELECT * FROM consent_requests WHERE token = ?", args: [token] });
  return r.rows[0];
}

async function clinicName(userId: string): Promise<string> {
  const r = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${userId}_settings`] }).catch(() => null);
  try { return (r?.rows.length ? JSON.parse(r.rows[0].data as string)?.salon?.name : "") || "Clinic"; } catch { return "Clinic"; }
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) return Response.json({ ok: false, error: "Missing link." }, { status: 400 });
  try {
    const row = await load(token);
    if (!row) return Response.json({ ok: false, error: "This signing link isn't valid." }, { status: 404 });
    if (row.signed_at) return Response.json({ ok: true, signed: true, clinicName: await clinicName(String(row.user_id)), title: row.title });
    if (String(row.expires_at) < new Date().toISOString()) return Response.json({ ok: false, error: "This signing link has expired. Ask the clinic for a new one." }, { status: 410 });
    return Response.json({
      ok: true, signed: false, clinicName: await clinicName(String(row.user_id)),
      title: row.title, body: row.body, patientName: row.client_name,
    });
  } catch (err) {
    console.error("[public/consent GET]", err);
    return Response.json({ ok: false, error: "Couldn't load the form." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const limit = await rateLimit("public-consent", clientIp(req), { maxAttempts: 10, windowMs: 10 * 60 * 1000, blockMs: 30 * 60 * 1000 });
  if (limit.blocked) return Response.json({ ok: false, error: "Too many attempts. Please try again later." }, { status: 429 });

  const body = await req.json().catch(() => null) as { token?: string; name?: string; signature?: string; agreed?: boolean } | null;
  const name = (body?.name ?? "").trim().slice(0, 200);
  const signature = body?.signature ?? "";
  if (!body?.token || !body.agreed || name.length < 2) return Response.json({ ok: false, error: "Please confirm, and type your full name." }, { status: 400 });
  if (!signature.startsWith("data:image/png;base64,") || signature.length > MAX_SIGNATURE_CHARS) {
    return Response.json({ ok: false, error: "Please sign in the box." }, { status: 400 });
  }

  try {
    const row = await load(body.token);
    if (!row) return Response.json({ ok: false, error: "This signing link isn't valid." }, { status: 404 });
    if (row.signed_at) return Response.json({ ok: true, alreadySigned: true });
    if (String(row.expires_at) < new Date().toISOString()) return Response.json({ ok: false, error: "This signing link has expired." }, { status: 410 });

    const signedAt = new Date().toISOString();
    // Claim the link first: a double tap must not record two signatures.
    const claim = await db.execute({ sql: "UPDATE consent_requests SET signed_at = ? WHERE token = ? AND signed_at IS NULL", args: [signedAt, body.token] });
    if (!claim.rowsAffected) return Response.json({ ok: true, alreadySigned: true });

    const record: ConsentRecord = {
      id: `consent_remote_${body.token.slice(0, 12)}`, clientId: String(row.client_id), templateId: String(row.template_id),
      title: String(row.title), body: String(row.body), signature, signedName: name, signedAt, staffName: "Signed remotely (patient's own device)",
    };
    try {
      await appendSignedConsent(String(row.user_id), String(row.location_id), record);
    } catch (err) {
      // Free the link again so the patient can retry rather than being stuck.
      await db.execute({ sql: "UPDATE consent_requests SET signed_at = NULL WHERE token = ?", args: [body.token] }).catch(() => {});
      throw err;
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[public/consent POST]", err);
    return Response.json({ ok: false, error: "Couldn't save your signature. Please try again." }, { status: 500 });
  }
}
