/**
 * PDFs for aesthetic clinics: a signed consent form and a prescription /
 * skincare plan. Rendered server-side like the invoice PDF (lib/salon-invoice-pdf.tsx).
 */

import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { ConsentRecord, Prescription } from "@/lib/clinic";

export interface ClinicPdfHeader { name: string; phone?: string; address?: string }

const s = StyleSheet.create({
  page: { padding: 48, fontFamily: "Helvetica", fontSize: 10, color: "#111111", lineHeight: 1.45 },
  clinic: { fontSize: 15, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.5 },
  clinicLine: { fontSize: 9, color: "#555555", marginTop: 3 },
  rule: { borderBottomWidth: 1, borderBottomColor: "#dddddd", marginVertical: 16 },
  title: { fontSize: 14, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  meta: { fontSize: 9, color: "#555555", marginBottom: 2 },
  body: { fontSize: 10, marginTop: 12 },
  sigBox: { marginTop: 24, borderWidth: 1, borderColor: "#cccccc", borderRadius: 4, padding: 12 },
  sig: { height: 70, objectFit: "contain", alignSelf: "flex-start" },
  label: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#777777", textTransform: "uppercase", marginBottom: 4 },
  section: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },
  item: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: "#eeeeee" },
  product: { width: "38%", fontFamily: "Helvetica-Bold" },
  detail: { width: "62%", color: "#333333" },
  footer: { position: "absolute", bottom: 32, left: 48, right: 48, fontSize: 8, color: "#888888", textAlign: "center" },
});

function Header({ clinic }: { clinic: ClinicPdfHeader }) {
  return (
    <View>
      <Text style={s.clinic}>{clinic.name}</Text>
      {clinic.address ? <Text style={s.clinicLine}>{clinic.address}</Text> : null}
      {clinic.phone ? <Text style={s.clinicLine}>{clinic.phone}</Text> : null}
      <View style={s.rule} />
    </View>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" });

export function renderConsentPdf(clinic: ClinicPdfHeader, c: ConsentRecord): Promise<Buffer> {
  return renderToBuffer(
    <Document title={c.title}>
      <Page size="A4" style={s.page}>
        <Header clinic={clinic} />
        <Text style={s.title}>{c.title}</Text>
        <Text style={s.meta}>Patient: {c.signedName}</Text>
        <Text style={s.meta}>Signed: {when(c.signedAt)} (Pakistan time)</Text>
        {c.staffName ? <Text style={s.meta}>Witness: {c.staffName}</Text> : null}
        <Text style={s.body}>{c.body}</Text>
        <View style={s.sigBox} wrap={false}>
          <Text style={s.label}>Patient signature</Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
          <Image src={c.signature} style={s.sig} />
          <Text style={s.meta}>{c.signedName} · {when(c.signedAt)}</Text>
        </View>
        <Text style={s.footer} fixed>Signed electronically. Record ID {c.id}.</Text>
      </Page>
    </Document>,
  );
}

export function renderPrescriptionPdf(clinic: ClinicPdfHeader, patientName: string, rx: Prescription): Promise<Buffer> {
  const times = [...new Set(rx.items.map((i) => i.time))];
  return renderToBuffer(
    <Document title={`Prescription — ${patientName}`}>
      <Page size="A4" style={s.page}>
        <Header clinic={clinic} />
        <Text style={s.title}>Prescription &amp; Skincare Plan</Text>
        <Text style={s.meta}>Patient: {patientName}</Text>
        <Text style={s.meta}>Date: {rx.date}</Text>
        {rx.practitionerName ? <Text style={s.meta}>Prescribed by: {rx.practitionerName}</Text> : null}
        {times.map((time) => (
          <View key={time} wrap={false}>
            <Text style={s.section}>{time}</Text>
            {rx.items.filter((i) => i.time === time).map((i, idx) => (
              <View key={idx} style={s.item}>
                <Text style={s.product}>{i.product}</Text>
                <Text style={s.detail}>
                  {[i.dosage, i.frequency, i.duration].filter(Boolean).join(" · ")}
                  {i.instructions ? `\n${i.instructions}` : ""}
                </Text>
              </View>
            ))}
          </View>
        ))}
        {rx.notes ? <><Text style={s.section}>Notes</Text><Text>{rx.notes}</Text></> : null}
        <Text style={s.footer} fixed>Follow these instructions unless your practitioner tells you otherwise. Stop and contact the clinic if you have a reaction.</Text>
      </Page>
    </Document>,
  );
}
