/**
 * POST /api/clinic/whatsapp-send — sends clinic documents to a patient on
 * WhatsApp automatically, through the salon's own connected provider:
 *   { kind: "text", phone, text }                          a consent signing link
 *   { kind: "prescription", phone, patientName, prescription }   PDF + regime text
 *   { kind: "consent", phone, consent }                     signed consent PDF
 *
 * Pro and Premium only (the plans with WhatsApp automation) — checked here
 * against billing, not trusted from the browser. Provider keys are read
 * server-side; the browser never has them. Where a provider can't send PDFs,
 * the prescription still goes out as a text message.
 */

import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { getBillingUser } from "@/lib/billing-db";
import { loadWhatsAppConfig } from "@/lib/whatsapp-config-server";
import { activeWhatsAppCredential, sendWhatsAppMessage, ycloudConfigOf, type WhatsAppProviderConfig } from "@/lib/whatsapp-provider";
import { sendWhatsAppDocument } from "@/lib/whatsapp-invoice-send";
import { checkWhatsAppSafety, recordWhatsAppSafetySend, type WhatsAppSafetyConfig } from "@/lib/whatsapp-safety";
import { renderConsentPdf, renderPrescriptionPdf, type ClinicPdfHeader } from "@/lib/clinic-pdf";
import { prescriptionText, type Prescription } from "@/lib/clinic-prescription";
import type { ConsentRecord } from "@/lib/clinic";

const WHATSAPP_PLANS = new Set(["pro", "basic", "premium"]);

interface Body {
  kind?: "text" | "prescription" | "consent";
  phone?: string;
  text?: string;
  clinic?: ClinicPdfHeader;
  patientName?: string;
  prescription?: Prescription;
  consent?: ConsentRecord;
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const billing = await getBillingUser(actor.userId).catch(() => null);
  if (!billing || !WHATSAPP_PLANS.has(billing.planId)) {
    return Response.json({ ok: false, error: "Automatic WhatsApp sending is part of the Pro and Premium plans.", upgrade: true }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as Body | null;
  const phone = (body?.phone ?? "").replace(/\D/g, "");
  if (!body?.kind || phone.length < 10) return Response.json({ ok: false, error: "The patient needs a valid phone number." }, { status: 400 });

  const ws = await loadWhatsAppConfig(actor.userId);
  const providerConfig: WhatsAppProviderConfig = {
    provider: (ws.provider as WhatsAppProviderConfig["provider"]) || "wasender",
    apiKey: ws.apiKey as string | undefined,
    botSailorApiToken: ws.botSailorApiToken as string | undefined,
    botSailorPhoneNumberId: ws.botSailorPhoneNumberId as string | undefined,
    zaptickApiKey: ws.zaptickApiKey as string | undefined,
    chakraAccessToken: ws.chakraAccessToken as string | undefined,
    ...ycloudConfigOf(ws),
  };
  if (!activeWhatsAppCredential(providerConfig)) {
    return Response.json({ ok: false, error: "WhatsApp isn't connected for this clinic yet." }, { status: 400 });
  }
  const safety = ws as WhatsAppSafetyConfig;
  const check = checkWhatsAppSafety({ phone, intent: "utility", config: safety });
  if (!check.ok) return Response.json({ ok: false, error: check.error, retryAfter: check.retryAfter }, { status: check.status });

  const clinic: ClinicPdfHeader = { name: body.clinic?.name || billing.salonName || "Clinic", phone: body.clinic?.phone, address: body.clinic?.address };

  try {
    let ok = false;
    let error: string | undefined;
    if (body.kind === "text" && body.text?.trim()) {
      const r = await sendWhatsAppMessage(providerConfig, phone, body.text.slice(0, 4000), { messageType: "manual" });
      ok = r.ok; error = r.ok ? undefined : r.errorReason;
    } else if (body.kind === "prescription" && Array.isArray(body.prescription?.items)) {
      const rx = body.prescription!;
      const name = body.patientName || "Patient";
      const text = prescriptionText(rx, name, clinic.name);
      const doc = await sendWhatsAppDocument({
        pdf: await renderPrescriptionPdf(clinic, name, rx), fileName: `Prescription ${rx.date}.pdf`,
        caption: text, phone, providerConfig,
      });
      ok = doc.ok; error = doc.error;
      // Provider can't carry a PDF (Zaptick, ChakraHQ): the plan itself still goes out.
      if (!ok && !doc.skipped) {
        const r = await sendWhatsAppMessage(providerConfig, phone, text, { messageType: "manual" });
        ok = r.ok; error = r.ok ? undefined : r.errorReason;
      }
    } else if (body.kind === "consent" && body.consent?.signature?.startsWith("data:image/png;base64,")) {
      const c = body.consent;
      const doc = await sendWhatsAppDocument({
        pdf: await renderConsentPdf(clinic, c), fileName: `${c.title}.pdf`,
        caption: `Your signed ${c.title} from ${clinic.name}, for your records.`, phone, providerConfig,
      });
      ok = doc.ok; error = doc.error;
    } else {
      return Response.json({ ok: false, error: "Nothing to send." }, { status: 400 });
    }
    if (!ok) return Response.json({ ok: false, error: error || "WhatsApp send failed." }, { status: 502 });
    recordWhatsAppSafetySend({ phone, config: safety });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[clinic/whatsapp-send]", err);
    return Response.json({ ok: false, error: "WhatsApp send failed." }, { status: 500 });
  }
}
