import { Document, Page, StyleSheet, Text, View, Image, renderToBuffer } from "@react-pdf/renderer";
import { renderQrDataUrl } from "@/lib/qr";
import { ADVANCE_NON_REFUNDABLE_NOTE, PAYMENT_NON_REFUNDABLE_NOTE, balanceDue, advancePercent, invoiceItemsByPerson, invoiceTimeLabel, type SalonInvoice } from "@/lib/salon-invoices";

const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", jazzcash: "JazzCash", easypaisa: "EasyPaisa",
  raast: "Raast", card: "Card", bank: "Bank Transfer", "": "—",
};

const styles = StyleSheet.create({
  page: { padding: 48, fontFamily: "Helvetica", fontSize: 9, color: "#111111" },

  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32 },
  salonName: { fontSize: 15, fontFamily: "Helvetica-Bold", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  salonLine: { fontSize: 9, color: "#555555", marginBottom: 4 },
  logo: { width: 70, height: 70, objectFit: "contain" },
  logoFallback: { width: 70, height: 70, borderRadius: 35, backgroundColor: "#111111", alignItems: "center", justifyContent: "center" },
  logoInitials: { color: "#ffffff", fontSize: 20, fontFamily: "Helvetica-Bold" },

  metaGrid: { flexDirection: "row", justifyContent: "space-between", marginBottom: 28 },
  metaCol: { width: "47%" },
  sectionLabel: { fontSize: 9, fontFamily: "Helvetica-Bold", textTransform: "uppercase", marginBottom: 8 },
  billName: { fontSize: 10, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  billLine: { fontSize: 9, color: "#555555", marginBottom: 3 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  metaRowLabel: { fontSize: 9, color: "#555555" },
  metaRowValue: { fontSize: 9, fontFamily: "Helvetica-Bold" },

  tableHeader: { flexDirection: "row", backgroundColor: "#f0f0f0", borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#cccccc", padding: 8 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e8e8e8", padding: 8 },
  description: { width: "46%" },
  dayBreakdown: { fontSize: 8, color: "#666666", marginTop: 2 },
  qty: { width: "10%", textAlign: "right" },
  amount: { width: "22%", textAlign: "right" },
  head: { fontFamily: "Helvetica-Bold", fontSize: 8 },
  cellMuted: { fontSize: 9, color: "#555555" },
  cellStrong: { fontSize: 9, fontFamily: "Helvetica-Bold" },

  summary: { marginLeft: "auto", width: "48%", marginTop: 12 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: "#e8e8e8" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderTopWidth: 2, borderTopColor: "#111111", marginTop: 2 },
  totalLabel: { fontSize: 10, fontFamily: "Helvetica-Bold" },
  totalValue: { fontSize: 10, fontFamily: "Helvetica-Bold" },

  paidLine: { fontSize: 9, color: "#059669", fontFamily: "Helvetica-Bold", marginTop: 24 },
  advanceNote: { fontSize: 9, color: "#b45309", fontFamily: "Helvetica-Bold", marginTop: 16 },
  notesBlock: { marginTop: 24 },
  personHeading: { fontSize: 9, fontFamily: "Helvetica-Bold", color: "#111111", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 10, marginBottom: 2 },
  termsBlock: { marginTop: 24 },
  termsText: { fontSize: 9, color: "#555555", lineHeight: 1.6 },

  footer: { position: "absolute", bottom: 40, left: 48, right: 48, borderTopWidth: 1, borderTopColor: "#e0e0e0", paddingTop: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  footerText: { fontSize: 9, color: "#555555" },
  footerBrand: { fontSize: 9, color: "#9898b0" },
});

function money(value: number) {
  return `PKR ${Math.round(value).toLocaleString("en-PK")}`;
}

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-PK", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function InvoiceDocument({ invoice, salon, fbrQr }: {
  invoice: SalonInvoice;
  salon: { name: string; phone?: string; email?: string; address?: string; logo?: string };
  fbrQr?: string;
}) {
  const isPaid   = invoice.status === "paid";
  const isAdvance = invoice.status === "partial";
  const advancePaid = invoice.advanceAmount ?? 0;
  const balanceRemaining = balanceDue(invoice);
  const salonName = salon.name || "Salon Central";
  const initials  = salonName.split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const methodLabel = METHOD_LABELS[invoice.paymentMethod ?? ""] ?? "—";

  return (
    <Document>
      <Page size="A4" style={styles.page}>

        {/* ── HEADER ── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.salonName}>{salonName}</Text>
            {!!salon.address && <Text style={styles.salonLine}>{salon.address}</Text>}
            {!!salon.phone   && <Text style={styles.salonLine}>{salon.phone}</Text>}
          </View>
          {salon.logo ? (
            <Image src={salon.logo} style={styles.logo} />
          ) : (
            <View style={styles.logoFallback}>
              <Text style={styles.logoInitials}>{initials}</Text>
            </View>
          )}
        </View>

        {/* ── BILL TO / INVOICE ── */}
        <View style={styles.metaGrid}>
          <View style={styles.metaCol}>
            <Text style={styles.sectionLabel}>Bill To</Text>
            <Text style={styles.billName}>{invoice.clientName}</Text>
            {!!invoice.clientPhone && <Text style={styles.billLine}>{invoice.clientPhone}</Text>}
          </View>
          <View style={styles.metaCol}>
            <Text style={styles.sectionLabel}>Invoice</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaRowLabel}>Invoice No:</Text>
              <Text style={styles.metaRowValue}>{invoice.number}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaRowLabel}>Issue Date:</Text>
              <Text style={styles.metaRowValue}>{[fmtDate(invoice.date), invoiceTimeLabel(invoice)].filter(Boolean).join(", ")}</Text>
            </View>
            {!!invoice.staffName && (
              <View style={styles.metaRow}>
                <Text style={styles.metaRowLabel}>Stylist:</Text>
                <Text style={styles.metaRowValue}>{invoice.staffName}</Text>
              </View>
            )}
            <View style={styles.metaRow}>
              <Text style={styles.metaRowLabel}>Payment:</Text>
              <Text style={styles.metaRowValue}>{methodLabel}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaRowLabel}>Status:</Text>
              <Text style={styles.metaRowValue}>{isPaid ? "PAID" : isAdvance ? "ADVANCE PAID" : "UNPAID"}</Text>
            </View>
          </View>
        </View>

        {/* ── ITEMS TABLE ── */}
        <View style={styles.tableHeader}>
          <Text style={[styles.description, styles.head]}>Description</Text>
          <Text style={[styles.qty, styles.head]}>Qty</Text>
          <Text style={[styles.amount, styles.head]}>Unit Price</Text>
          <Text style={[styles.amount, styles.head]}>Amount</Text>
        </View>
        {invoiceItemsByPerson(invoice).map((group, gi) => (
          <View key={group.name ?? `g${gi}`}>
            {/* One bill covering several people gets a heading per person. */}
            {!!group.name && (
              <Text style={styles.personHeading}>{gi === 0 ? `${group.name} (main)` : group.name}</Text>
            )}
            {group.items.map((item) => (
              <View key={item.id} style={styles.row}>
                <View style={styles.description}>
                  <Text style={styles.cellMuted}>{item.description}</Text>
                  {item.dayBreakdown?.map((d) => (
                    <Text key={d.label} style={styles.dayBreakdown}>{d.label} — {money(d.amount)}</Text>
                  ))}
                </View>
                <Text style={[styles.qty, styles.cellMuted]}>{item.qty}</Text>
                <Text style={[styles.amount, styles.cellMuted]}>{money(item.unitPrice)}</Text>
                <Text style={[styles.amount, styles.cellStrong]}>{money(item.total)}</Text>
              </View>
            ))}
          </View>
        ))}

        {/* ── TOTALS ── */}
        <View style={styles.summary}>
          <View style={styles.summaryRow}>
            <Text style={styles.cellMuted}>Subtotal</Text>
            <Text style={styles.cellStrong}>{money(invoice.subtotal)}</Text>
          </View>
          {invoice.taxAmount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.cellMuted}>Tax</Text>
              <Text style={styles.cellMuted}>{money(invoice.taxAmount)}</Text>
            </View>
          )}
          {invoice.discountAmount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.cellMuted}>Discount</Text>
              <Text style={styles.cellMuted}>-{money(invoice.discountAmount)}</Text>
            </View>
          )}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{money(invoice.total)}</Text>
          </View>
          {isAdvance && (
            <>
              <View style={styles.row}>
                <Text style={styles.cellMuted}>Advance paid ({advancePercent(invoice)}%)</Text>
                <Text style={styles.cellStrong}>{money(advancePaid)}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.cellMuted}>Balance due</Text>
                <Text style={styles.cellStrong}>{money(balanceRemaining)}</Text>
              </View>
            </>
          )}
        </View>

        {/* ── FBR ── */}
        {!!invoice.fbrInvoiceNumber && (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 16 }}>
            {!!fbrQr && <Image src={fbrQr} style={{ width: 64, height: 64, marginRight: 10 }} />}
            <View>
              <Text style={styles.sectionLabel}>FBR Invoice No.</Text>
              <Text style={styles.cellStrong}>{invoice.fbrInvoiceNumber}</Text>
              <Text style={styles.cellMuted}>Verify on FBR&apos;s Tax Asaan app</Text>
            </View>
          </View>
        )}

        {/* ── PAYMENT STATUS ── */}
        {isPaid && invoice.paymentMethod && (
          <Text style={styles.paidLine}>Paid via {methodLabel}</Text>
        )}

        {/* ── ADVANCE TERMS ──
             Printed only when an advance was actually taken, so ordinary
             fully-paid receipts aren't cluttered with a term that can't apply. */}
        {isAdvance && (
          <Text style={styles.advanceNote}>{ADVANCE_NON_REFUNDABLE_NOTE}</Text>
        )}

        {/* ── NOTES ── */}
        {!!invoice.notes && (
          <View style={styles.notesBlock}>
            <Text style={styles.sectionLabel}>Notes</Text>
            <Text style={styles.termsText}>{invoice.notes}</Text>
          </View>
        )}

        {/* ── TERMS ── */}
        <View style={styles.termsBlock}>
          <Text style={styles.sectionLabel}>Terms</Text>
          <Text style={styles.termsText}>
            Payment is due upon receipt. Thank you for your business!
            {"\n"}
            <Text style={{ fontFamily: "Helvetica-Bold", color: "#111111" }}>{PAYMENT_NON_REFUNDABLE_NOTE}</Text>
            {!!salon.phone && `\nFor queries, contact us at ${salon.phone}.`}
          </Text>
        </View>

        {/* ── FOOTER ── */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Thank you for visiting {salonName}!</Text>
          <Text style={styles.footerBrand}>Powered by Salon Central</Text>
        </View>

      </Page>
    </Document>
  );
}

export async function generateSalonInvoicePdf(
  invoice: SalonInvoice,
  salon: { name: string; phone?: string; email?: string; address?: string; logo?: string },
) {
  const fbrQr = invoice.fbrInvoiceNumber ? await renderQrDataUrl(invoice.fbrInvoiceNumber, { size: 192, margin: 1 }) : undefined;
  return renderToBuffer(<InvoiceDocument invoice={invoice} salon={salon} fbrQr={fbrQr} />);
}
