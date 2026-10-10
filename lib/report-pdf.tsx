import {
  Document, Page, View, Text, Image, StyleSheet, renderToBuffer,
  Svg, Defs, LinearGradient, Stop, Rect, Circle,
} from "@react-pdf/renderer";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
  /** Day book for `date` — same rules as the Revenue page's Ledger tab. */
  ledger?: {
    opening: number;
    totalIn: number;
    totalOut: number;
    rows: { description: string; detail: string; moneyIn: number; moneyOut: number }[];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pkr(n: number) {
  return "PKR " + Math.round(n).toLocaleString("en-PK");
}

// Plain "-": the built-in Helvetica has no U+2212 minus glyph.
function signedPkr(n: number) {
  return (n < 0 ? "-" : "") + pkr(Math.abs(n));
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
    backgroundColor: "#f7f6fb",
    paddingBottom: 48,
  },

  // Top bar (logo on white) and purple hero band
  topBar: {
    backgroundColor: "#ffffff", padding: "16 32", flexDirection: "row",
    justifyContent: "space-between", alignItems: "center", borderBottom: "1 solid #ece9f5",
  },
  logo: { height: 30, width: 62 },
  logoText: { fontSize: 16, fontFamily: "Helvetica-Bold", color: "#7C3AED" },
  pill: {
    backgroundColor: "#F5F3FF", color: "#6D28D9", fontSize: 7, fontFamily: "Helvetica-Bold",
    letterSpacing: 1, textTransform: "uppercase", padding: "4 9", borderRadius: 9, alignSelf: "flex-end",
  },
  topDate: { fontSize: 9, color: "#4a4a6a", marginTop: 5, textAlign: "right", fontFamily: "Helvetica-Bold" },
  hero: { height: 104, position: "relative" },
  heroBg: { position: "absolute", top: 0, left: 0 },
  heroContent: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: "0 32", height: 104 },
  heroLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "rgba(255,255,255,0.7)", letterSpacing: 1, textTransform: "uppercase" },
  heroSalon: { fontSize: 20, fontFamily: "Helvetica-Bold", color: "#ffffff", marginTop: 4 },
  heroSub: { fontSize: 8, color: "rgba(255,255,255,0.75)", marginTop: 3 },
  heroAmount: { fontSize: 24, fontFamily: "Helvetica-Bold", color: "#ffffff", marginTop: 4, textAlign: "right" },

  // Body
  body: { padding: "6 32 0 32" },

  // Stat cards row
  statRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  statCard: {
    flex: 1, backgroundColor: "#ffffff", borderRadius: 8, padding: "10 12",
    border: "1 solid #ece9f5", borderLeftWidth: 3,
  },
  statLabel: { fontSize: 6.5, fontFamily: "Helvetica-Bold", color: "#9898b0", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 5 },
  statValue: { fontSize: 14, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  statSub: { fontSize: 7, color: "#9898b0" },

  // Warning box
  warningBox: {
    backgroundColor: "#fffbeb", borderRadius: 8, padding: "9 12",
    marginBottom: 12, border: "1 solid #fde68a", borderLeftWidth: 3, borderLeftColor: "#f59e0b",
  },
  warningText: { fontSize: 9, color: "#92400e", fontFamily: "Helvetica-Bold" },

  // Section heading
  sectionHead: { flexDirection: "row", alignItems: "center", marginBottom: 7, marginTop: 14 },
  sectionBar: { width: 3, height: 12, backgroundColor: "#7C3AED", borderRadius: 2, marginRight: 7 },
  sectionTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", color: "#1a1a2e" },

  // Table
  table: { border: "1 solid #ece9f5", borderRadius: 8, overflow: "hidden", marginBottom: 4, backgroundColor: "#ffffff" },
  tableHeaderRow: { flexDirection: "row", backgroundColor: "#F5F3FF", borderBottom: "1 solid #ece9f5" },
  tableHeaderCell: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "#6D28D9", textTransform: "uppercase", letterSpacing: 0.6, padding: "7 10" },
  tableRow: { flexDirection: "row", borderBottom: "1 solid #f0f0f8" },
  tableRowAlt: { flexDirection: "row", borderBottom: "1 solid #f0f0f8", backgroundColor: "#fcfbff" },
  tableCell: { fontSize: 9, color: "#4a4a6a", padding: "7 10" },
  tableCellBold: { fontSize: 9, color: "#1a1a2e", fontFamily: "Helvetica-Bold", padding: "7 10" },
  tableCellGreen: { fontSize: 9, color: "#059669", fontFamily: "Helvetica-Bold", padding: "7 10" },
  tableCellPurple: { fontSize: 9, color: "#7C3AED", fontFamily: "Helvetica-Bold", padding: "7 10" },
  tableCellRight: { textAlign: "right" },

  // Transactions list
  txRow: { flexDirection: "row", borderBottom: "1 solid #f0f0f8", padding: "6 10", alignItems: "center" },
  txRowAlt: { flexDirection: "row", borderBottom: "1 solid #f0f0f8", padding: "6 10", alignItems: "center", backgroundColor: "#fafafa" },

  // No-data
  emptyBox: {
    alignItems: "center", padding: "26 0", marginTop: 4, backgroundColor: "#ffffff",
    borderRadius: 10, border: "1 dashed #d8d2ee",
  },
  emptyTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", color: "#5B21B6", marginBottom: 4 },
  emptySub: { fontSize: 8.5, color: "#9898b0" },

  // Footer
  footer: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: "#ffffff", borderTop: "1 solid #ece9f5",
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
    <View style={[s.statCard, { borderLeftColor: color }]}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, { color }]}>{value}</Text>
      {sub ? <Text style={s.statSub}>{sub}</Text> : null}
    </View>
  );
}

// ─── Main PDF Document ────────────────────────────────────────────────────────

const PAGE_WIDTH = 595.28; // A4 in points

// A short section moves to the next page whole rather than leaving its heading behind.
// A long one has to split, so its column titles repeat on each page instead (`fixed` header rows).
const keepTogether = (rows: number) => rows <= 15;

function DailyReportPDF({ data, logo }: { data: DailyReportData; logo?: Buffer }) {
  const { salonName, ownerName, date, invoices, ledger } = data;

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

        {/* Top bar */}
        <View style={s.topBar}>
          {logo
            // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
            ? <Image src={{ data: logo, format: "png" }} style={s.logo} />
            : <Text style={s.logoText}>Salon Central</Text>}
          <View>
            <Text style={s.pill}>Daily Sales Report</Text>
            <Text style={s.topDate}>{fmtDate(date)}</Text>
          </View>
        </View>

        {/* Hero: salon + the day's headline number */}
        <View style={s.hero}>
          <Svg style={s.heroBg} width={PAGE_WIDTH} height={104}>
            <Defs>
              <LinearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor="#4C1D95" />
                <Stop offset="1" stopColor="#8B5CF6" />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={PAGE_WIDTH} height={104} fill="url(#hero)" />
            <Circle cx={PAGE_WIDTH - 40} cy={-10} r={70} fill="#ffffff" fillOpacity={0.07} />
            <Circle cx={PAGE_WIDTH - 150} cy={120} r={48} fill="#ffffff" fillOpacity={0.05} />
          </Svg>
          <View style={s.heroContent}>
            <View>
              <Text style={s.heroLabel}>Salon</Text>
              <Text style={s.heroSalon}>{salonName}</Text>
              <Text style={s.heroSub}>Prepared for {ownerName}</Text>
            </View>
            <View>
              <Text style={[s.heroLabel, { textAlign: "right" }]}>Revenue collected</Text>
              <Text style={s.heroAmount}>{pkr(revenue)}</Text>
              <Text style={[s.heroSub, { textAlign: "right" }]}>
                {paid.length} paid sale{paid.length !== 1 ? "s" : ""}{unpaid.length > 0 ? ` · ${unpaid.length} unpaid` : ""}
              </Text>
            </View>
          </View>
        </View>

        <View style={s.body}>

          {/* Stats */}
          <SectionHead title="Summary" />
          <View style={s.statRow}>
            <StatCard label="Paid Sales" value={String(paid.length)} sub={`${unpaid.length} unpaid`} color="#7C3AED" />
            <StatCard label="Average Ticket" value={avgTicket > 0 ? pkr(avgTicket) : "—"} sub="per paid sale" color="#0284c7" />
            <StatCard label="Discounts Given" value={totalDisc > 0 ? pkr(totalDisc) : "None"} color="#d97706" />
            <StatCard label="Still Owed" value={outstanding > 0 ? pkr(outstanding) : "None"} sub="unpaid today" color="#dc2626" />
          </View>

          {/* Outstanding warning */}
          {outstanding > 0 && (
            <View style={s.warningBox}>
              <Text style={s.warningText}>
                {unpaid.length} unpaid transaction{unpaid.length !== 1 ? "s" : ""} — {pkr(outstanding)} outstanding
              </Text>
            </View>
          )}

          {!hasData && (
            <View style={s.emptyBox}>
              <Text style={s.emptyTitle}>No sales recorded today</Text>
              <Text style={s.emptySub}>Sales you ring up in the Salon Central POS will appear here.</Text>
            </View>
          )}

          {/* Payment Methods */}
          {methodEntries.length > 0 && (
            <View wrap={!keepTogether(methodEntries.length)}>
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
            <View wrap={!keepTogether(topItems.length)}>
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
            <View wrap={!keepTogether(staffEntries.length)}>
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
            <View wrap={!keepTogether(invoices.length)}>
              <SectionHead title={`All Transactions (${invoices.length})`} />
              <View style={s.table}>
                <View style={s.tableHeaderRow} fixed>
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

          {/* Ledger (day book) */}
          {ledger && (() => {
            let balance = ledger.opening;
            const closing = ledger.opening + ledger.totalIn - ledger.totalOut;
            const totalRow = (label: string, value: string, color: string) => (
              <View style={[s.tableRow, { backgroundColor: "#f5f3ff" }]} wrap={false}>
                <Text style={[s.tableCellBold, { flex: 4 }]}>{label}</Text>
                <Text style={[s.tableCellBold, { flex: 2, textAlign: "right", color }]}>{value}</Text>
              </View>
            );
            return (
              <View wrap={!keepTogether(ledger.rows.length)}>
                <SectionHead title="Ledger · Day Book" />
                <View style={s.table}>
                  <View style={s.tableHeaderRow} fixed>
                    <Text style={[s.tableHeaderCell, { flex: 4 }]}>Entry</Text>
                    <Text style={[s.tableHeaderCell, { flex: 1.5, textAlign: "right" }]}>Money In</Text>
                    <Text style={[s.tableHeaderCell, { flex: 1.5, textAlign: "right" }]}>Money Out</Text>
                    <Text style={[s.tableHeaderCell, { flex: 1.8, textAlign: "right" }]}>Balance</Text>
                  </View>
                  {totalRow("Opening balance", signedPkr(ledger.opening), "#6b6b8a")}
                  {ledger.rows.length === 0 && (
                    <View style={s.tableRow}><Text style={[s.tableCell, { flex: 1, textAlign: "center" }]}>No entries today</Text></View>
                  )}
                  {ledger.rows.map((r, i) => {
                    balance += r.moneyIn - r.moneyOut;
                    return (
                      <View key={i} style={i % 2 === 0 ? s.tableRow : s.tableRowAlt} wrap={false}>
                        <View style={{ flex: 4, padding: "6 10" }}>
                          <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold" }}>{r.description}</Text>
                          <Text style={{ fontSize: 7, color: "#9898b0", marginTop: 1, textTransform: "capitalize" }}>{r.detail}</Text>
                        </View>
                        <Text style={[s.tableCellGreen, { flex: 1.5, textAlign: "right" }]}>{r.moneyIn ? pkr(r.moneyIn) : ""}</Text>
                        <Text style={[s.tableCellBold, { flex: 1.5, textAlign: "right", color: "#dc2626" }]}>{r.moneyOut ? pkr(r.moneyOut) : ""}</Text>
                        <Text style={[s.tableCell, { flex: 1.8, textAlign: "right" }]}>{signedPkr(balance)}</Text>
                      </View>
                    );
                  })}
                  {totalRow(`Today: ${pkr(ledger.totalIn)} in · ${pkr(ledger.totalOut)} out`, signedPkr(ledger.totalIn - ledger.totalOut), "#1a1a2e")}
                  {totalRow("Closing balance", signedPkr(closing), closing >= 0 ? "#7C3AED" : "#dc2626")}
                </View>
              </View>
            );
          })()}
        </View>

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text style={s.footerBold}>Salon Central · Daily Sales Report · {salonName}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `Generated ${generatedAt} · Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function generateDailyReportPdf(data: DailyReportData): Promise<Buffer> {
  // Bundled for the cron route via outputFileTracingIncludes in next.config.ts; falls back to the text wordmark.
  const logo = await readFile(path.join(process.cwd(), "public", "report-logo.png")).catch(() => undefined);
  const buffer = await renderToBuffer(<DailyReportPDF data={data} logo={logo} />);
  return Buffer.from(buffer);
}
