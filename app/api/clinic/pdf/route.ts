/**
 * POST /api/clinic/pdf — renders a signed consent or a prescription as a PDF
 * (lib/clinic-pdf.tsx). The browser sends the record it already holds; the
 * session check keeps this from being an open PDF service.
 */

import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { renderConsentPdf, renderPrescriptionPdf, type ClinicPdfHeader } from "@/lib/clinic-pdf";
import type { ConsentRecord, Prescription } from "@/lib/clinic";

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as {
    kind?: "consent" | "prescription"; clinic?: ClinicPdfHeader; patientName?: string; consent?: ConsentRecord; prescription?: Prescription;
  } | null;
  if (!body?.clinic?.name) return Response.json({ ok: false, error: "Missing clinic details." }, { status: 400 });

  try {
    let pdf: Buffer;
    let filename: string;
    if (body.kind === "consent" && body.consent?.signature?.startsWith("data:image/png;base64,")) {
      pdf = await renderConsentPdf(body.clinic, body.consent);
      filename = `${body.consent.title} - ${body.consent.signedName}`;
    } else if (body.kind === "prescription" && Array.isArray(body.prescription?.items)) {
      pdf = await renderPrescriptionPdf(body.clinic, body.patientName || "Patient", body.prescription!);
      filename = `Prescription - ${body.patientName || "patient"} - ${body.prescription!.date}`;
    } else {
      return Response.json({ ok: false, error: "Nothing to print." }, { status: 400 });
    }
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^\w .-]/g, "")}.pdf"`,
      },
    });
  } catch (err) {
    console.error("[clinic/pdf]", err);
    return Response.json({ ok: false, error: "Couldn't create the PDF." }, { status: 500 });
  }
}
