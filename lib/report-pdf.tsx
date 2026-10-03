import {
  Document, Page, View, Text, StyleSheet, renderToBuffer,
} from "@react-pdf/renderer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReportInvoice {
  number: string;
  clientName: string;
  staffName: string;
  items: { description: string; type: string; qty: number; total: number }[];
  discountAmount: number;
  total: number;
  paymentMethod: string;
  cardTerminal?: string;
  status: "paid" | "unpaid";
}

export interface DailyReportData {
  salonName: string;
  ownerName: string;
  date: string;                // YYYY-MM-DD
  invoices: ReportInvoice[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pkr(n: number) {
  return "PKR " + Math.round(n).toLocaleString("en-PK");
}

function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-PK", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", jazzcash: "JazzCash", easypaisa: "EasyPaisa",
  raast: "Raast", card: "Card", bank: "Bank Transfer",
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: "#1a1a2e",
    backgroundColor: "#f4f5f7",
    paddingBottom: 40,
  },

  // Header
  header: {
    backgroundColor: "#5B21B6",
    padding: "22 32 20 32",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerLeft: { flexDirection: "column" },
  headerBrand: { fontSize: 20, fontFamily: "Helvetica-Bold", color: "#ffffff", letterSpacing: 0 },
  headerSub: { fontSize: 9, color: "rgba(255,255,255,0.7)", marginTop: 2 },
  headerSalonName: { fontSize: 14, fontFamily: "Helvetica-Bold", color: "#ffffff", marginTop: 10 },
  headerRight: { alignItems: "flex-end" },
  headerLabel: { fontSize: 9, fontFamily: "Helvetica-Bold", color: "rgba(255,255,255,0.75)", textTransform: "uppercase", letterSpacing: 0.8 },
  headerDate: { fontSize: 10, color: "#ffffff", marginTop: 4, fontFamily: "Helvetica-Bold" },
  headerReport: { fontSize: 8, color: "rgba(255,255,255,0.65)", marginTop: 2 },

  // Body
  body: { padding: "16 32 0 32" },

  // Stat cards row
  statRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  statCard: {
    flex: 1, backgroundColor: "#ffffff", borderRadius: 8,
    padding: "12 10", alignItems: "center",
    border: "1 solid #e8e8f0",
  },
  statLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "#b0b0c8", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 },
  statValue: { fontSize: 16, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  statSub: { fontSize: 7, color: "#9898b0" },

  // Warning box
  warningBox: {
    backgroundColor: "#fffbeb", borderRadius: 8, padding: "10 12",
    marginBottom: 14, border: "1 solid #fde68a",
  },
  warningText: { fontSize: 9, color: "#92400e", fontFamily: "Helvetica-Bold" },

  // Section heading
  sectionHead: { flexDirection: "row", alignItems: "center", marginBottom: 6, marginTop: 12 },
  sectionBar: { width: 3, height: 12, backgroundColor: "#7C3AED", borderRadius: 2, marginRight: 7 },
  sectionTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", color: "#1a1a2e" },

  // Table
  table: { border: "1 solid #e8e8f0", borderRadius: 8, overflow: "hidden", marginBottom: 4 },
  tableHeaderRow: { flexDirection: "row", backgroundColor: "#5B21B6" },
  tableHeaderCell: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "#ffffff", textTransform: "uppercase", letterSpacing: 0.6, padding: "7 10" },
  tableRow: { flexDirection: "row", borderBottom: "1 solid #f0f0f8" },
  tableRowAlt: { flexDirection: "row", borderBottom: "1 solid #f0f0f8", backgroundColor: "#fafafa" },
  tableCell: { fontSize: 9, color: "#4a4a6a", padding: "7 10" },
  tableCellBold: { fontSize: 9, color: "#1a1a2e", fontFamily: "Helvetica-Bold", padding: "7 10" },
  tableCellGreen: { fontSize: 9, color: "#059669", fontFamily: "Helvetica-Bold", padding: "7 10" },
  tableCellPurple: { fontSize: 9, color: "#7C3AED", fontFamily: "Helvetica-Bold", padding: "7 10" },
  tableCellRight: { textAlign: "right" },

  // Transactions list
  txRow: { flexDirection: "row", borderBottom: "1 solid #f0f0f8", padding: "6 10", alignItems: "center" },
  txRowAlt: { flexDirection: "row", borderBottom: "1 solid #f0f0f8", padding: "6 10", alignItems: "center", backgroundColor: "#fafafa" },

  // No-data
  emptyBox: { alignItems: "center", padding: "40 0" },
  emptyTitle: { fontSize: 13, fontFamily: "Helvetica-Bold", color: "#9898b0", marginBottom: 6 },
  emptySub: { fontSize: 9, color: "#b0b0c8" },

  // Footer
  footer: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: "#f8f8fc", borderTop: "1 solid #e8e8f0",
    padding: "10 32", flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  footerText: { fontSize: 8, color: "#b0b0c8" },
  footerBold: { fontSize: 8, color: "#7C3AED", fontFamily: "Helvetica-Bold" },

  // Page number
  pageNum: { fontSize: 8, color: "#b0b0c8" },
});

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHead({ title }: { title: string }) {
  return (
    <View style={s.sectionHead}>
      <View style={s.sectionBar} />
      <Text style={s.sectionTitle}>{title}</Text>
    </View>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <View style={s.statCard}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, { color }]}>{value}</Text>
      {sub ? <Text style={s.statSub}>{sub}</Text> : null}
    </View>
  );
}

// ─── Main PDF Document ────────────────────────────────────────────────────────

function DailyReportPDF({ data }: { data: DailyReportData }) {
  const { salonName, ownerName, date, invoices } = data;

  const paid     = invoices.filter((i) => i.status === "paid");
  const unpaid   = invoices.filter((i) => i.status === "unpaid");
  const revenue  = paid.reduce((s, i) => s + i.total, 0);
  const outstanding = unpaid.reduce((s, i) => s + i.total, 0);
  const avgTicket   = paid.length > 0 ? revenue / paid.length : 0;
  const totalDisc   = invoices.reduce((s, i) => s + i.discountAmount, 0);

  // Payment method breakdown
  const byMethod: Record<string, { count: number; amount: number }> = {};
  for (const inv of paid) {
    // Card sales split per machine so each can be checked against that bank's statement.
    const m = inv.paymentMethod === "card" && inv.cardTerminal ? `Card · ${inv.cardTerminal}` : inv.paymentMethod || "other";
    if (!byMethod[m]) byMethod[m] = { count: 0, amount: 0 };
    byMethod[m].count++;
    byMethod[m].amount += inv.total;
  }
  const methodEntries = Object.entries(byMethod).sort((a, b) => b[1].amount - a[1].amount);

  // Top items
  const itemMap: Record<string, { qty: number; revenue: number; type: string }> = {};
  for (const inv of invoices) {
    for (const item of inv.items) {
      if (!itemMap[item.description]) itemMap[item.description] = { qty: 0, revenue: 0, type: item.type };
      itemMap[item.description].qty     += item.qty;
      itemMap[item.description].revenue += item.total;
    }
  }
  const topItems = Object.entries(itemMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 10);

  // Staff performance
  const staffMap: Record<string, { count: number; revenue: number }> = {};
  for (const inv of paid) {
    const name = inv.staffName || "Unassigned";
    if (!staffMap[name]) staffMap[name] = { count: 0, revenue: 0 };
    staffMap[name].count++;
    staffMap[name].revenue += inv.total;
  }
  const staffEntries = Object.entries(staffMap).sort((a, b) => b[1].revenue - a[1].revenue);

  const hasData = invoices.length > 0;
  const generatedAt = new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" }) + " PKT";

  return (
    <Document title={`Daily Report — ${salonName} — ${date}`} author="Salon Central">
      <Page size="A4" style={s.page}>

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerLeft}>
            <Text style={s.headerBrand}>Salon Central</Text>
            <Text style={s.headerSub}>Salon Management Platform</Text>
            <Text style={s.headerSalonName}>{salonName}</Text>
          </View>
          <View style={s.headerRight}>
            <Text style={s.headerLabel}>Daily Sales Report</Text>
            <Text style={s.headerDate}>{fmtDate(date)}</Text>
            <Text style={s.headerReport}>Prepared for {ownerName}</Text>
          </View>
        </View>

        <View style={s.body}>

          {/* Stats */}
          <View style={[s.sectionHead, { marginTop: 16 }]}>
            <View style={s.sectionBar} />
            <Text style={s.sectionTitle}>Summary</Text>
          </View>
          <View style={s.statRow}>
            <StatCard label="Paid Transactions" value={String(paid.length)} sub={`${unpaid.length} unpaid`} color="#7C3AED" />
            <StatCard label="Revenue Collected" value={pkr(revenue)} color="#059669" />
            <StatCard label="Average Ticket" value={avgTicket > 0 ? pkr(avgTicket) : "—"} color="#0284c7" />
            <StatCard label="Total Discounts" value={totalDisc > 0 ? pkr(totalDisc) : "None"} color="#d97706" />
          </View>

          {/* Outstanding warning */}
          {outstanding > 0 && (
            <View style={s.warningBox}>
              <Text style={s.warningText}>
                ⚠  {unpaid.length} unpaid transaction{unpaid.length !== 1 ? "s" : ""} — {pkr(outstanding)} outstanding
              </Text>
            </View>
          )}

          {!hasData && (
            <View style={s.emptyBox}>
              <Text style={s.emptyTitle}>No POS sales recorded today</Text>
              <Text style={s.emptySub}>Open the Salon Central POS to start recording transactions.</Text>
            </View>
          )}

          {/* Payment Methods */}
          {methodEntries.length > 0 && (
            <View>
              <SectionHead title="Payment Methods" />
              <View style={s.table}>
                <View style={s.tableHeaderRow}>
                  <Text style={[s.tableHeaderCell, { flex: 2 }]}>Method</Text>
                  <Text style={[s.tableHeaderCell, { flex: 1, textAlign: "center" }]}>Transactions</Text>
                  <Text style={[s.tableHeaderCell, { flex: 2, textAlign: "right" }]}>Amount Collected</Text>
                </View>
                {methodEntries.map(([m, d], i) => (
                  <View key={m} style={i % 2 === 0 ? s.tableRow : s.tableRowAlt}>
                    <Text style={[s.tableCellBold, { flex: 2 }]}>{METHOD_LABELS[m] ?? m}</Text>
                    <Text style={[s.tableCell, { flex: 1, textAlign: "center" }]}>{d.count}</Text>
                    <Text style={[s.tableCellGreen, { flex: 2, textAlign: "right" }]}>{pkr(d.amount)}</Text>
                  </View>
                ))}
                <View style={[s.tableRow, { backgroundColor: "#f5f3ff" }]}>
                  <Text style={[s.tableCellBold, { flex: 2 }]}>Total</Text>
                  <Text style={[s.tableCell, { flex: 1, textAlign: "center" }]}>{paid.length}</Text>
                  <Text style={[s.tableCellPurple, { flex: 2, textAlign: "right" }]}>{pkr(revenue)}</Text>
                </View>
              </View>
            </View>
          )}

          {/* Top Items */}
          {topItems.length > 0 && (
            <View>
              <SectionHead title="Top Items Sold" />
              <View style={s.table}>
                <View style={s.tableHeaderRow}>
                  <Text style={[s.tableHeaderCell, { flex: 4 }]}>Item</Text>
                  <Text style={[s.tableHeaderCell, { flex: 1.5 }]}>Type</Text>
                  <Text style={[s.tableHeaderCell, { flex: 1, textAlign: "center" }]}>Qty</Text>
                  <Text style={[s.tableHeaderCell, { flex: 2, textAlign: "right" }]}>Revenue</Text>
                </View>
                {topItems.map(([name, d], i) => (
                  <View key={name} style={i % 2 === 0 ? s.tableRow : s.tableRowAlt}>
                    <Text style={[s.tableCellBold, { flex: 4 }]}>{name}</Text>
                    <Text style={[s.tableCell, { flex: 1.5, textTransform: "capitalize" }]}>{d.type}</Text>
                    <Text style={[s.tableCell, { flex: 1, textAlign: "center" }]}>{d.qty}</Text>
                    <Text style={[s.tableCellPurple, { flex: 2, textAlign: "right" }]}>{pkr(d.revenue)}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Staff Performance */}
          {staffEntries.length > 1 && (
            <View>
              <SectionHead title="Staff Performance" />
              <View style={s.table}>
                <View style={s.tableHeaderRow}>
                  <Text style={[s.tableHeaderCell, { flex: 3 }]}>Staff Member</Text>
                  <Text style={[s.tableHeaderCell, { flex: 1, textAlign: "center" }]}>Sales</Text>
                  <Text style={[s.tableHeaderCell, { flex: 2, textAlign: "right" }]}>Revenue</Text>
                </View>
                {staffEntries.map(([name, d], i) => (
                  <View key={name} style={i % 2 === 0 ? s.tableRow : s.tableRowAlt}>
                    <Text style={[s.tableCellBold, { flex: 3 }]}>{name}</Text>
                    <Text style={[s.tableCell, { flex: 1, textAlign: "center" }]}>{d.count}</Text>
                    <Text style={[s.tableCellGreen, { flex: 2, textAlign: "right" }]}>{pkr(d.revenue)}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Transactions log */}
          {invoices.length > 0 && (
            <View>
              <SectionHead title={`All Transactions (${invoices.length})`} />
              <View style={s.table}>
                <View style={s.tableHeaderRow}>
                  <Text style={[s.tableHeaderCell, { flex: 1.5 }]}>Invoice #</Text>
                  <Text style={[s.tableHeaderCell, { flex: 2.5 }]}>Client</Text>
                  <Text style={[s.tableHeaderCell, { flex: 2 }]}>Staff</Text>
                  <Text style={[s.tableHeaderCell, { flex: 1.5 }]}>Method</Text>
                  <Text style={[s.tableHeaderCell, { flex: 1.5, textAlign: "right" }]}>Amount</Text>
                  <Text style={[s.tableHeaderCell, { flex: 1, textAlign: "center" }]}>Status</Text>
                </View>
                {invoices.map((inv, i) => (
                  <View key={inv.number} style={i % 2 === 0 ? s.tableRow : s.tableRowAlt}>
                    <Text style={[s.tableCellPurple, { flex: 1.5, fontFamily: "Courier" }]}>{inv.number}</Text>
                    <Text style={[s.tableCellBold, { flex: 2.5 }]}>{inv.clientName}</Text>
                    <Text style={[s.tableCell, { flex: 2 }]}>{inv.staffName || "—"}</Text>
                    <Text style={[s.tableCell, { flex: 1.5 }]}>{METHOD_LABELS[inv.paymentMethod] ?? inv.paymentMethod}</Text>
                    <Text style={[s.tableCellBold, { flex: 1.5, textAlign: "right" }]}>{pkr(inv.total)}</Text>
                    <Text style={[
                      s.tableCell, { flex: 1, textAlign: "center", fontFamily: "Helvetica-Bold",
                        color: inv.status === "paid" ? "#059669" : "#d97706" },
                    ]}>
                      {inv.status === "paid" ? "Paid" : "Unpaid"}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text style={s.footerBold}>Salon Central · Daily Sales Report · {salonName}</Text>
          <Text style={s.footerText}>Generated {generatedAt}</Text>
        </View>
      </Page>
    </Document>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function generateDailyReportPdf(data: DailyReportData): Promise<Buffer> {
  const buffer = await renderToBuffer(<DailyReportPDF data={data} />);
  return Buffer.from(buffer);
}
