import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { reportToFbr, resolveFbrConfig } from "@/lib/fbr";
import { loadSalonSettings } from "@/lib/winback-queue";
import type { SalonInvoice } from "@/lib/salon-invoices";

/**
 * POST /api/fbr/invoice — { invoice, creditNote? } → { ok, fbrInvoiceNumber } | { ok: false, error }
 * With creditNote, cancels the invoice's current FBR invoice instead of filing it.
 *
 * The FBR credentials come from the salon's saved settings, not the request,
 * so a sale can only ever be reported under the salon's own POS ID.
 */
export async function POST(request: NextRequest) {
  const actor = await resolveActor(request);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as { invoice?: SalonInvoice; creditNote?: boolean } | null;
  const invoice = body?.invoice;
  if (!invoice?.number || !Array.isArray(invoice.items)) {
    return Response.json({ ok: false, error: "Invalid invoice" }, { status: 400 });
  }

  const settings = await loadSalonSettings(actor.userId);
  const config = resolveFbrConfig(settings?.salon);
  if (!config.enabled) return Response.json({ ok: false, error: "FBR reporting is turned off in Account settings." }, { status: 400 });

  if (body?.creditNote && !invoice.fbrInvoiceNumber) {
    return Response.json({ ok: false, error: "This invoice was never reported to FBR." }, { status: 400 });
  }
  const result = await reportToFbr(invoice, config, body?.creditNote === true);
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
