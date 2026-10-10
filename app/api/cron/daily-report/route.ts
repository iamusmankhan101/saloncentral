/**
 * /api/cron/daily-report
 *
 * Runs daily at 16:00 UTC (9 PM PKT) via Vercel Cron.
 * For every active salon, fetches today's POS sales from Turso and emails
 * a summary report to the salon owner.
 *
 * Secured with Authorization: Bearer {CRON_SECRET}
 */

import { NextRequest } from "next/server";
import { Resend } from "resend";
import { db } from "@/lib/db";
import { getAllActiveBillingUsers } from "@/lib/billing-db";
import { generateDailyReportPdf } from "@/lib/report-pdf";

// ─── Auth ─────────────────────────────────────────────────────────────────────

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SalonInvoiceItem {
  description: string;
  type: "service" | "product";
  qty: number;
  unitPrice: number;
  total: number;
}

interface SalonInvoice {
  id: string;
  number: string;
  clientName: string;
  staffName: string;
  items: SalonInvoiceItem[];
  subtotal: number;
  discountAmount: number;
  total: number;
  paymentMethod: string;
  cardTerminal?: string;
  date: string;
  status: "paid" | "unpaid";
  source?: "pos" | "manual";
}

interface Appointment {
  id: string;
  date: string;
  startTime?: string;
  status: string;
  clientName?: string;
  serviceNames?: string[];
  totalAmount: number;
}

interface CashEntry {
  id: string;
  date: string;
  createdAt?: string;
  category?: string;
  description?: string;
  amount: number;
  paymentMethod?: string;
  paymentStatus?: "paid" | "pending";
}

interface LedgerRow { sortKey: string; date: string; description: string; detail: string; moneyIn: number; moneyOut: number }

interface Ledger { opening: number; rows: LedgerRow[]; totalIn: number; totalOut: number }

interface SalonSettings {
  salon?: {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
  };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getSalonData<T>(userId: string, entity: string): Promise<T | null> {
  try {
    const res = await db.execute({
      sql: "SELECT data FROM salon_data WHERE entity = ?",
      args: [`${userId}_${entity}`],
    });
    if (res.rows.length === 0) return null;
    return JSON.parse(res.rows[0].data as string) as T;
  } catch {
    return null;
  }
}

/** Ids tombstoned as deleted (lib/deleted-records.ts) — the raw rows still hold them until the next dashboard read. */
async function getDeletedIds(userId: string): Promise<Set<string>> {
  const rows = await getSalonData<{ id?: string; entity?: string }[]>(userId, "deleted_records");
  return new Set((Array.isArray(rows) ? rows : []).map((r) => `${r.entity}:${r.id}`));
}

// ─── Ledger (day book) ────────────────────────────────────────────────────────

/**
 * Same sources and rules as the Revenue page's Ledger tab: completed
 * appointments without a POS checkout, paid POS invoices, imported income
 * (minus petty cash), and every expense that isn't still pending.
 */
function buildLedger(
  date: string,
  posInvoices: SalonInvoice[],
  appointments: Appointment[],
  income: CashEntry[],
  expenses: CashEntry[],
): Ledger {
  const linked = new Set(posInvoices.map((inv) => (inv as { appointmentId?: string }).appointmentId).filter(Boolean));
  const time = (iso?: string) => (iso ?? "").slice(11, 16) || "00:00";
  const all: LedgerRow[] = [
    ...appointments
      .filter((a) => a.status === "completed" && !linked.has(a.id))
      .map((a) => ({ sortKey: a.date + "T" + (a.startTime || "00:00"), date: a.date,
        description: a.clientName || "Appointment", detail: a.serviceNames?.join(", ") || "Appointment",
        moneyIn: a.totalAmount || 0, moneyOut: 0 })),
    ...posInvoices
      .filter((inv) => inv.status === "paid")
      .map((inv) => ({ sortKey: inv.date + "T" + time((inv as { createdAt?: string }).createdAt), date: inv.date,
        description: inv.clientName || "POS Sale", detail: `POS · ${METHOD_LABELS[inv.paymentMethod] ?? inv.paymentMethod ?? "Cash"}`,
        moneyIn: inv.total || 0, moneyOut: 0 })),
    ...income
      .filter((e) => e.category !== "Petty Cash")
      .map((e) => ({ sortKey: e.date + "T" + time(e.createdAt), date: e.date,
        description: e.description || "Income", detail: e.category || "Imported income",
        moneyIn: e.amount || 0, moneyOut: 0 })),
    ...expenses
      .filter((e) => e.paymentStatus !== "pending")
      .map((e) => {
        const category = (e.category ?? "other").replace(/_/g, " ");
        return { sortKey: e.date + "T" + time(e.createdAt), date: e.date,
          description: e.description || category, detail: `${category} · ${METHOD_LABELS[e.paymentMethod ?? "cash"] ?? e.paymentMethod}`,
          moneyIn: 0, moneyOut: e.amount || 0 };
      }),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  let opening = 0, totalIn = 0, totalOut = 0;
  const rows: LedgerRow[] = [];
  for (const row of all) {
    if (row.date > date) break;
    if (row.date < date) { opening += row.moneyIn - row.moneyOut; continue; }
    totalIn += row.moneyIn; totalOut += row.moneyOut;
    rows.push(row);
  }
  return { opening, rows, totalIn, totalOut };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function signedPkr(n: number) {
  return (n < 0 ? "−" : "") + pkr(Math.abs(n));
}


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

// ─── Email builder ────────────────────────────────────────────────────────────

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://app.saloncentral.xyz").replace(/\/$/, "");

function buildReportEmail(
  ownerName: string,
  salonName: string,
  date: string,
  invoices: SalonInvoice[],
  ledger: Ledger,
): { subject: string; html: string; text: string } {
  const paid   = invoices.filter((i) => i.status === "paid");
  const unpaid = invoices.filter((i) => i.status === "unpaid");

  const revenue     = paid.reduce((s, i) => s + i.total, 0);
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

  // Top items
  const itemMap: Record<string, { qty: number; revenue: number; type: string }> = {};
  for (const inv of invoices) {
    for (const item of inv.items) {
      if (!itemMap[item.description]) itemMap[item.description] = { qty: 0, revenue: 0, type: item.type };
      itemMap[item.description].qty     += item.qty;
      itemMap[item.description].revenue += item.total;
    }
  }
  const topItems = Object.entries(itemMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 8);

  // Staff performance
  const staffMap: Record<string, { count: number; revenue: number }> = {};
  for (const inv of paid) {
    const s = inv.staffName || "Unassigned";
    if (!staffMap[s]) staffMap[s] = { count: 0, revenue: 0 };
    staffMap[s].count++;
    staffMap[s].revenue += inv.total;
  }
  const staffRows = Object.entries(staffMap).sort((a, b) => b[1].revenue - a[1].revenue);

  const hasData = invoices.length > 0;

  const subject = hasData
    ? `📊 Daily Report — ${salonName} · ${pkr(revenue)} · ${paid.length} sales`
    : `📊 Daily Report — ${salonName} · No sales today`;

  const statCard = (label: string, value: string, sub: string, color: string) => `
    <td style="width:25%;padding:0 6px;vertical-align:top">
      <div style="background:#fff;border-radius:10px;padding:16px 14px;border:1px solid #ebebf0;text-align:center">
        <div style="font-size:11px;font-weight:700;color:#b0b0c8;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px">${label}</div>
        <div style="font-size:20px;font-weight:900;color:${color};line-height:1;margin-bottom:4px">${value}</div>
        ${sub ? `<div style="font-size:11px;color:#9898b0">${sub}</div>` : ""}
      </div>
    </td>`;

  const methodRows = Object.entries(byMethod)
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([m, d]) => `
      <tr>
        <td style="padding:9px 12px;font-size:13px;color:#4a4a6a;border-bottom:1px solid #f4f4f8">${METHOD_LABELS[m] ?? m}</td>
        <td style="padding:9px 12px;font-size:13px;color:#1a1a2e;font-weight:700;text-align:center;border-bottom:1px solid #f4f4f8">${d.count}</td>
        <td style="padding:9px 12px;font-size:13px;color:#059669;font-weight:800;text-align:right;border-bottom:1px solid #f4f4f8">${pkr(d.amount)}</td>
      </tr>`)
    .join("");

  const itemRowsHtml = topItems.map(([name, d], i) => `
    <tr style="background:${i % 2 === 1 ? "#fafafa" : "#fff"}">
      <td style="padding:9px 12px;font-size:13px;color:#1a1a2e;font-weight:600;border-bottom:1px solid #f4f4f8">${name}</td>
      <td style="padding:9px 12px;font-size:11px;color:#9898b0;text-align:center;border-bottom:1px solid #f4f4f8;text-transform:capitalize">${d.type}</td>
      <td style="padding:9px 12px;font-size:13px;color:#4a4a6a;text-align:center;border-bottom:1px solid #f4f4f8">${d.qty}</td>
      <td style="padding:9px 12px;font-size:13px;color:#7C3AED;font-weight:800;text-align:right;border-bottom:1px solid #f4f4f8">${pkr(d.revenue)}</td>
    </tr>`)
    .join("");

  const staffRowsHtml = staffRows.map(([name, d], i) => `
    <tr style="background:${i % 2 === 1 ? "#fafafa" : "#fff"}">
      <td style="padding:9px 12px;font-size:13px;color:#1a1a2e;font-weight:600;border-bottom:1px solid #f4f4f8">${name}</td>
      <td style="padding:9px 12px;font-size:13px;color:#4a4a6a;text-align:center;border-bottom:1px solid #f4f4f8">${d.count}</td>
      <td style="padding:9px 12px;font-size:13px;color:#059669;font-weight:800;text-align:right;border-bottom:1px solid #f4f4f8">${pkr(d.revenue)}</td>
    </tr>`)
    .join("");

  const tableHeader = (cols: string[]) => `
    <tr style="background:linear-gradient(135deg,#5B21B6,#9333EA)">
      ${cols.map((c) => `<th style="padding:9px 12px;font-size:10px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:0.08em;text-align:left">${c}</th>`).join("")}
    </tr>`;

  const sectionHead = (title: string) => `
    <div style="font-size:13px;font-weight:800;color:#1a1a2e;margin:24px 0 10px;display:flex;align-items:center;gap:8px">
      <div style="width:3px;height:16px;background:linear-gradient(135deg,#5B21B6,#9333EA);border-radius:2px;display:inline-block;vertical-align:middle;margin-right:6px"></div>
      ${title}
    </div>`;

  const closing = ledger.opening + ledger.totalIn - ledger.totalOut;
  const ledgerRowsHtml = ledger.rows.map((r, i) => `
    <tr style="background:${i % 2 === 1 ? "#fafafa" : "#fff"}">
      <td style="padding:9px 12px;font-size:13px;color:#1a1a2e;font-weight:600;border-bottom:1px solid #f4f4f8">${esc(r.description)}<div style="font-size:11px;color:#9898b0;font-weight:400;text-transform:capitalize">${esc(r.detail)}</div></td>
      <td style="padding:9px 12px;font-size:13px;color:#059669;font-weight:700;text-align:right;border-bottom:1px solid #f4f4f8">${r.moneyIn ? pkr(r.moneyIn) : ""}</td>
      <td style="padding:9px 12px;font-size:13px;color:#dc2626;font-weight:700;text-align:right;border-bottom:1px solid #f4f4f8">${r.moneyOut ? pkr(r.moneyOut) : ""}</td>
    </tr>`)
    .join("");
  const ledgerTotalRow = (label: string, value: string, color: string) => `
    <tr style="background:#f8f8fc">
      <td style="padding:9px 12px;font-size:12px;font-weight:800;color:#4a4a6a;border-bottom:1px solid #f4f4f8">${label}</td>
      <td colspan="2" style="padding:9px 12px;font-size:13px;font-weight:900;color:${color};text-align:right;border-bottom:1px solid #f4f4f8">${value}</td>
    </tr>`;
  const ledgerHtml = `
      ${sectionHead("Ledger · Day Book")}
      <table style="width:100%;border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #ebebf0">
        ${tableHeader(["Entry", "Money In", "Money Out"])}
        ${ledgerTotalRow("Opening balance", signedPkr(ledger.opening), "#6b6b8a")}
        ${ledgerRowsHtml || `<tr><td colspan="3" style="padding:12px;font-size:13px;color:#9898b0;text-align:center">No entries today</td></tr>`}
        ${ledgerTotalRow(`Today: ${pkr(ledger.totalIn)} in · ${pkr(ledger.totalOut)} out`, "", "#1a1a2e")}
        ${ledgerTotalRow("Closing balance", signedPkr(closing), closing >= 0 ? "#7C3AED" : "#dc2626")}
      </table>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e8e8f0;box-shadow:0 4px 24px rgba(0,0,0,0.07)">

    <!-- Logo bar (tables, not flex, so Outlook and Gmail lay it out the same) -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #ece9f5">
      <tr>
        <td style="padding:20px 36px">
          <img src="${APP_URL}/report-logo.png" alt="Salon Central" width="74" height="36" style="display:block;border:0;color:#7C3AED;font-size:18px;font-weight:900">
        </td>
        <td style="padding:20px 36px;text-align:right">
          <span style="display:inline-block;background:#F5F3FF;color:#6D28D9;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;padding:5px 10px;border-radius:999px">Daily Sales Report</span>
          <div style="color:#4a4a6a;font-size:13px;font-weight:700;margin-top:6px">${fmtDate(date)}</div>
        </td>
      </tr>
    </table>

    <!-- Hero: salon + the day's headline number -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#5B21B6;background-image:linear-gradient(135deg,#4C1D95,#8B5CF6)">
      <tr>
        <td style="padding:26px 36px">
          <div style="color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Salon</div>
          <div style="color:#fff;font-size:22px;font-weight:800;margin-top:4px">${salonName}</div>
          <div style="color:rgba(255,255,255,0.75);font-size:12px;margin-top:3px">Prepared for ${ownerName}</div>
        </td>
        <td style="padding:26px 36px;text-align:right">
          <div style="color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Revenue collected</div>
          <div style="color:#fff;font-size:26px;font-weight:900;margin-top:4px;white-space:nowrap">${pkr(revenue)}</div>
          <div style="color:rgba(255,255,255,0.75);font-size:12px;margin-top:3px">${paid.length} paid sale${paid.length !== 1 ? "s" : ""}${unpaid.length ? ` · ${unpaid.length} unpaid` : ""}</div>
        </td>
      </tr>
    </table>

    <div style="padding:28px 36px">

      ${hasData ? `
      <!-- Stat cards -->
      <table style="width:100%;border-collapse:separate;border-spacing:0;margin-bottom:8px" cellpadding="0" cellspacing="0">
        <tr>
          ${statCard("Transactions", String(paid.length), `${unpaid.length} unpaid`, "#7C3AED")}
          ${statCard("Revenue", paid.length > 0 ? (revenue >= 100000 ? `${(revenue/1000).toFixed(1)}k` : pkr(revenue).replace("PKR ", "")) : "—", paid.length > 0 ? "PKR" : "", "#059669")}
          ${statCard("Avg Ticket", avgTicket > 0 ? pkr(avgTicket).replace("PKR ", "") : "—", avgTicket > 0 ? "PKR" : "", "#0284c7")}
          ${statCard("Discounts", totalDisc > 0 ? pkr(totalDisc).replace("PKR ","") : "0", totalDisc > 0 ? "PKR saved" : "", "#d97706")}
        </tr>
      </table>

      ${outstanding > 0 ? `
      <div style="margin:16px 0;padding:12px 16px;background:#fffbeb;border-radius:10px;border:1px solid #fde68a;font-size:13px;color:#92400e;font-weight:700">
        ⚠️ ${unpaid.length} unpaid transaction${unpaid.length !== 1 ? "s" : ""} totalling <strong>${pkr(outstanding)}</strong> outstanding
      </div>` : ""}

      ${methodRows ? `
      ${sectionHead("Payment Methods")}
      <table style="width:100%;border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #ebebf0">
        ${tableHeader(["Method", "Txns", "Amount"])}
        ${methodRows}
      </table>` : ""}

      ${topItems.length > 0 ? `
      ${sectionHead("Top Items Sold")}
      <table style="width:100%;border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #ebebf0">
        ${tableHeader(["Item", "Type", "Qty", "Revenue"])}
        ${itemRowsHtml}
      </table>` : ""}

      ${staffRows.length > 1 ? `
      ${sectionHead("Staff Performance")}
      <table style="width:100%;border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #ebebf0">
        ${tableHeader(["Staff Member", "Sales", "Revenue"])}
        ${staffRowsHtml}
      </table>` : ""}

      ` : `
      <!-- No sales state -->
      <div style="text-align:center;padding:40px 24px">
        <div style="width:64px;height:64px;background:#f4f5f7;border-radius:18px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px">📭</div>
        <div style="font-size:16px;font-weight:800;color:#1a1a2e;margin-bottom:8px">No sales recorded today</div>
        <div style="font-size:13px;color:#9898b0;line-height:1.7">There were no POS transactions for ${fmtDate(date)}. Open the POS to start recording sales.</div>
      </div>
      `}

      ${ledgerHtml}

      <p style="color:#9898b0;font-size:12px;line-height:1.7;margin:24px 0 0;padding-top:20px;border-top:1px solid #f0f0f8">
        Hi ${ownerName}, this is your automated end-of-day summary. Log in to your <strong>Salon Central dashboard</strong> for full reports and analytics.
      </p>
    </div>

    <div style="background:#f8f8fc;padding:16px 36px;border-top:1px solid #ebebf0;text-align:center;color:#b0b0c8;font-size:11px;line-height:1.7">
      Salon Central · Salon Management Platform · <a href="https://saloncentral.xyz" style="color:#7C3AED;text-decoration:none">saloncentral.xyz</a><br>
      Automated daily report — generated ${new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" })} PKT
    </div>
  </div>
</body>
</html>`;

  const ledgerText =
    `Ledger (Day Book):\n  Opening balance: ${signedPkr(ledger.opening)}\n` +
    ledger.rows.map((r) => `  • ${r.description} (${r.detail}): ${r.moneyIn ? `+${pkr(r.moneyIn)}` : `-${pkr(r.moneyOut)}`}`).join("\n") +
    (ledger.rows.length ? "\n" : "") +
    `  Money in: ${pkr(ledger.totalIn)} · Money out: ${pkr(ledger.totalOut)}\n  Closing balance: ${signedPkr(closing)}\n\n`;

  const text = hasData
    ? `Daily Sales Report — ${salonName}\n${fmtDate(date)}\n\n` +
      `Transactions: ${paid.length} (${unpaid.length} unpaid)\n` +
      `Revenue: ${pkr(revenue)}\nOutstanding: ${pkr(outstanding)}\nAvg Ticket: ${pkr(avgTicket)}\n\n` +
      `Top Items:\n${topItems.map(([n, d]) => `  • ${n}: ${d.qty}× — ${pkr(d.revenue)}`).join("\n")}\n\n` +
      ledgerText + `— Salon Central`
    : `Daily Sales Report — ${salonName}\n${fmtDate(date)}\n\nNo POS transactions recorded today.\n\n` + ledgerText + `— Salon Central`;

  return { subject, html, text };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return Response.json({ ok: false, error: "RESEND_API_KEY not configured" }, { status: 500 });
  }

  const resend  = new Resend(apiKey);
  const today   = new Date().toISOString().slice(0, 10);
  let emailsSent = 0;
  let skipped    = 0;

  const users = await getAllActiveBillingUsers();

  for (const user of users) {
    if (user.suspended) { skipped++; continue; }

    // Load POS invoices and the other ledger sources from Turso, minus anything deleted
    const deleted = await getDeletedIds(user.id);
    const load = async <T extends { id: string }>(entity: string) =>
      ((await getSalonData<T[]>(user.id, entity)) ?? []).filter((r) => !deleted.has(`${entity}:${r.id}`));
    const posInvoices = (await load<SalonInvoice>("salon_invoices")).filter((inv) => !inv.source || inv.source === "pos");
    const invoices = posInvoices.filter((inv) => inv.date === today);
    const ledger = buildLedger(
      today,
      posInvoices,
      await load<Appointment>("appointments"),
      await load<CashEntry>("cash_flow_income"),
      await load<CashEntry>("expenses"),
    );

    // Load settings for possible custom salon name
    const settings = await getSalonData<SalonSettings>(user.id, "settings");
    const salonName = settings?.salon?.name || user.salonName || "Your Salon";

    // Determine recipient: prefer settings email, fall back to billing email
    const toEmail = settings?.salon?.email || user.email;

    const { subject, html, text } = buildReportEmail(user.ownerName, salonName, today, invoices, ledger);

    // Generate PDF attachment
    let pdfBuffer: Buffer | undefined;
    try {
      pdfBuffer = await generateDailyReportPdf({ salonName, ownerName: user.ownerName, date: today, invoices, ledger });
    } catch (e) {
      console.error(`[daily-report] PDF generation failed for ${user.email}:`, e);
    }

    const dateSlug = today.replace(/-/g, "");
    const filename = `daily-report-${dateSlug}.pdf`;

    try {
      const { error } = await resend.emails.send({
        from:    "Salon Central Reports <noreply@saloncentral.xyz>",
        replyTo: "support@saloncentral.xyz",
        to:      [toEmail],
        subject,
        html,
        text,
        attachments: pdfBuffer
          ? [{ filename, content: pdfBuffer }]
          : [],
      });

      if (error) {
        console.error(`[daily-report] Resend error for ${user.email}:`, error.message);
      } else {
        emailsSent++;
        console.log(`[daily-report] ✓ ${user.email} — ${invoices.length} invoices, ${pkr(invoices.filter(i=>i.status==="paid").reduce((s,i)=>s+i.total,0))}${pdfBuffer ? " + PDF attached" : ""}`);
      }
    } catch (e) {
      console.error(`[daily-report] Exception for ${user.email}:`, e);
    }
  }

  return Response.json({ ok: true, date: today, emailsSent, skipped });
}
