/**
 * POST /api/public/payment-proof
 *
 * A customer's payment screenshot for a booking they just made in the client
 * app. Public — the customer isn't logged in — so it only accepts a proof for
 * an appointment that already exists in that salon, and only a small image.
 *
 * Body: { salonId, appointmentId, method, dataUrl }
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { savePaymentProof } from "@/lib/payment-proofs";
import type { Appointment } from "@/lib/types";

/** The app sends a downscaled JPEG, typically 150–400 KB; this leaves room without inviting abuse. */
const MAX_DATA_URL_CHARS = 2_500_000;
const METHODS = new Set(["jazzcash", "easypaisa", "bank"]);

export async function POST(req: NextRequest) {
  const limit = await rateLimit("public-payment-proof", clientIp(req), { maxAttempts: 10, windowMs: 10 * 60 * 1000, blockMs: 30 * 60 * 1000 });
  if (limit.blocked) {
    return Response.json({ ok: false, error: "Too many uploads. Please try again later." }, { status: 429 });
  }

  let body: { salonId?: string; appointmentId?: string; method?: string; dataUrl?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const { salonId, appointmentId, method = "", dataUrl = "" } = body;
  if (!salonId || !appointmentId) {
    return Response.json({ ok: false, error: "Missing booking details." }, { status: 400 });
  }
  if (!METHODS.has(method)) {
    return Response.json({ ok: false, error: "Unknown payment method." }, { status: 400 });
  }
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) {
    return Response.json({ ok: false, error: "Please upload a JPG or PNG image." }, { status: 400 });
  }
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    return Response.json({ ok: false, error: "That image is too large." }, { status: 413 });
  }

  try {
    const row = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${salonId}_appointments`] });
    let appointments: Appointment[] = [];
    try { appointments = row.rows.length ? JSON.parse(row.rows[0].data as string) : []; } catch { /* none */ }
    if (!appointments.some((a) => a.id === appointmentId)) {
      return Response.json({ ok: false, error: "We couldn't find that booking." }, { status: 404 });
    }

    await savePaymentProof(salonId, appointmentId, method, dataUrl);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[public/payment-proof] error:", err);
    return Response.json({ ok: false, error: "Couldn't save the screenshot. Please try again." }, { status: 500 });
  }
}
