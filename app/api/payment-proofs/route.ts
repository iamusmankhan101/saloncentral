/**
 * GET /api/payment-proofs                     → which appointments have a screenshot
 * GET /api/payment-proofs?appointmentId=xxx   → that screenshot's image
 *
 * Staff-only view of the payment screenshots customers upload from the client
 * app (see lib/payment-proofs.ts). Scoped to the caller's own salon.
 */

import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { getPaymentProofImage, listPaymentProofs } from "@/lib/payment-proofs";

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const appointmentId = req.nextUrl.searchParams.get("appointmentId");
  try {
    if (appointmentId) {
      const image = await getPaymentProofImage(actor.userId, appointmentId);
      if (!image) return Response.json({ ok: false, error: "No screenshot for this appointment." }, { status: 404 });
      return Response.json({ ok: true, image }, { headers: { "Cache-Control": "private, max-age=300" } });
    }
    return Response.json(
      { ok: true, proofs: await listPaymentProofs(actor.userId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[payment-proofs] error:", err);
    return Response.json({ ok: false, error: "Couldn't load payment screenshots." }, { status: 500 });
  }
}
