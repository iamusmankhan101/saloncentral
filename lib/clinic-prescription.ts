/**
 * Prescriptions / skincare regimes — the record and its WhatsApp text.
 * Kept free of browser code so the server can format the message it sends
 * (app/api/clinic/whatsapp-send); lib/clinic.ts re-exports all of it.
 */

export const REGIME_TIMES = ["Morning", "Night", "As needed"] as const;

export interface PrescriptionItem {
  time: string;
  product: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
}

export interface Prescription {
  id: string;
  clientId: string;
  /** YYYY-MM-DD. */
  date: string;
  practitionerId?: string;
  practitionerName?: string;
  items: PrescriptionItem[];
  notes?: string;
  createdAt: string;
}

/** A prescription as a WhatsApp-ready message. */
export function prescriptionText(rx: Prescription, patientName: string, clinicName: string): string {
  const lines = [`*${clinicName}* — Skincare plan for ${patientName} (${rx.date})`];
  for (const time of [...new Set(rx.items.map((i) => i.time))]) {
    lines.push("", `*${time}*`);
    for (const i of rx.items.filter((x) => x.time === time)) {
      const extra = [i.dosage, i.frequency, i.duration].filter(Boolean).join(", ");
      lines.push(`• ${i.product}${extra ? ` — ${extra}` : ""}${i.instructions ? `\n   _${i.instructions}_` : ""}`);
    }
  }
  if (rx.notes) lines.push("", rx.notes);
  if (rx.practitionerName) lines.push("", `— ${rx.practitionerName}`);
  return lines.join("\n");
}
