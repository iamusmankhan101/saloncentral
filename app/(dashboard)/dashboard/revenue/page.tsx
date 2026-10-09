"use client";

import { useState, useEffect, useMemo } from "react";
import { getStoredAppointments } from "@/lib/storage";
import { getSalonInvoices, revenueAmount, balanceDue, paymentMethodLabel } from "@/lib/salon-invoices";
import { getExpenses, type Expense, type ExpenseCategory } from "@/lib/expenses";
import { getManualCashIncome, PETTY_CASH_CATEGORY, type ManualCashIncome } from "@/lib/cash-flow-income";
import { getActiveSection } from "@/lib/sections";
import type { Appointment } from "@/lib/types";
import MobilePageHeader from "@/components/mobile-page-header";
import PageTitle from "@/components/page-title";
import {
  Download, ArrowUpRight, ArrowDownRight,
  TrendingUp, TrendingDown, CalendarDays, Percent, ChevronLeft,
  ChevronDown, ChevronUp, Receipt, Clock, Wallet, Search, Printer,
} from "lucide-react";

import { fmtCurrency as fmt } from "@/lib/format";
import { syncFromDB } from "@/lib/turso-sync";
const fmtK = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000   ? `${Math.round(n / 1_000)}K`
  : String(Math.round(n));

function computeYLabels(maxVal: number): string[] {
  const step = maxVal <= 10_000 ? 2_500 : maxVal <= 50_000 ? 10_000 : maxVal <= 200_000 ? 50_000 : maxVal <= 1_000_000 ? 250_000 : 500_000;
  const top = Math.ceil(maxVal / step) * step || step;
  return [top, top * 0.75, top * 0.5, top * 0.25, 0].map(v => fmtK(v));
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

type Period = "today" | "7d" | "14d" | "30d" | "1y" | "custom";

const PERIODS: { key: Period; label: string; days: number }[] = [
  { key: "today",  label: "Today",   days: 1   },
  { key: "7d",     label: "7 Days",  days: 7   },
  { key: "14d",    label: "14 Days", days: 14  },
  { key: "30d",    label: "Month",   days: 30  },
  { key: "1y",     label: "1 Year",  days: 365 },
  { key: "custom", label: "Custom",  days: 0   },
];

const METHOD_COLORS: Record<string, string> = {
  cash: "#22c55e", jazzcash: "#f97316", easypaisa: "#10b981",
  raast: "#3b82f6", card: "#6366f1", bank: "#9333EA",
};
const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", jazzcash: "JazzCash", easypaisa: "EasyPaisa",
  raast: "Raast", card: "Card", bank: "Bank Transfer",
};

// Mirrors EXPENSE_CATEGORIES on the Cash Flow page (app/(dashboard)/dashboard/cash-flow/page.tsx)
// — kept local rather than imported since page files in this app are self-contained.
const EXPENSE_CATEGORIES: { key: ExpenseCategory; label: string; color: string }[] = [
  { key: "rent",          label: "Rent",                color: "#ef4444" },
  { key: "water_bill",    label: "Water Bill",          color: "#0ea5e9" },
  { key: "electricity_bill", label: "Electricity Bill", color: "#f59e0b" },
  { key: "internet_bill", label: "Internet Bill",    color: "#6366f1" },
  { key: "committee",     label: "Committee",           color: "#14b8a6" },
  { key: "salaries",      label: "Staff Salaries",      color: "#f97316" },
  { key: "utilities",     label: "Utilities",           color: "#eab308" },
  { key: "supplies",      label: "Products & Supplies", color: "#22c55e" },
  { key: "equipment",     label: "Equipment",           color: "#3b82f6" },
  { key: "marketing",     label: "Marketing",           color: "#8b5cf6" },
  { key: "food",          label: "Food & Tea",          color: "#ec4899" },
  { key: "miscellaneous", label: "Miscellaneous",       color: "#6b7280" },
];
const EXPENSE_LABELS: Record<string, string> = Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c.key, c.label]));
const EXPENSE_COLORS: Record<string, string> = Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c.key, c.color]));

type RevTab = "overview" | "net" | "ledger";

function toDateStr(d: Date) { return d.toLocaleDateString("en-CA"); }

function fmtTime(t: string) {
  const [hourValue, minuteValue] = t.split(":").map(Number);
  if (!Number.isFinite(hourValue) || !Number.isFinite(minuteValue)) return t;
  const period = hourValue < 12 ? "AM" : "PM";
  return `${hourValue % 12 || 12}:${String(minuteValue).padStart(2, "0")} ${period}`;
}

function fmtShortDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-PK", { day: "numeric", month: "short" });
}

function getDaysArray(count: number): string[] {
  const arr: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    arr.push(toDateStr(d));
  }
  return arr;
}

function getDaysInRange(start: string, end: string): string[] {
  const arr: string[] = [];
  const cur = new Date(start + "T12:00:00");
  const endDate = new Date(end + "T12:00:00");
  while (cur <= endDate && arr.length < 366) {
    arr.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return arr;
}


/** Opens a report in a new tab and brings up the print dialog ("Save as PDF"). */
function printHtml(html: string) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) {
    URL.revokeObjectURL(url);
    alert("Pop-up was blocked. Please allow pop-ups for this site to download the PDF.");
    return;
  }
  win.addEventListener("load", () => {
    win.focus();
    win.print();
    URL.revokeObjectURL(url);
  });
}

interface ChartBar {
  label: string;
  value: number;
  isCurrentPeriod: boolean;
  monthKey: string; // "YYYY-MM" for 1y, "YYYY-MM-DD" for daily views
}

export default function RevenuePage() {
  const [tab, setTab]                   = useState<RevTab>("overview");
  const [period, setPeriod]             = useState<Period>("today");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [posInvoices, setPosInvoices]   = useState<ReturnType<typeof getSalonInvoices>>([]);
  const [posInvoiceAppointmentIds, setPosInvoiceAppointmentIds] = useState<string[]>([]);
  const [outstandingInvoices, setOutstandingInvoices] = useState<ReturnType<typeof getSalonInvoices>>([]);
  const [manualIncome, setManualIncome] = useState<ManualCashIncome[]>([]);
  const [expenses, setExpenses]         = useState<Expense[]>([]);
  const [today, setToday]               = useState("");
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [hoveredBar, setHoveredBar]     = useState<number | null>(null);
  const [dailyReportOpen, setDailyReportOpen] = useState(true);
  const [customStart, setCustomStart]   = useState(() => toDateStr(new Date()));
  const [customEnd, setCustomEnd]       = useState(() => toDateStr(new Date()));

  // Revenue visibility by dashboard section: only "All Sections" sees
  // everything combined (with per-row section tags, added below) — Men's and
  // Women's are each restricted to their own revenue, symmetrically.
  const activeSection = getActiveSection();
  const revenueScoped = activeSection !== "all";

  useEffect(() => {
    let cancelled = false;
    syncFromDB().finally(() => {
      if (cancelled) return;
      setToday(toDateStr(new Date()));
      setAppointments(
        getStoredAppointments()
          .filter(a => !revenueScoped || a.section === activeSection)
      );
      // Match Cash Flow: count paid POS invoices as the source of truth. Keep
      // every POS-linked appointment id separately, including unpaid invoices,
      // so unpaid/credit invoices do not leak in through completed appointments.
      const allPosInvoices = getSalonInvoices()
        .filter(inv => !inv.source || inv.source === "pos")
        .filter(inv => !revenueScoped || inv.section === activeSection);
      setPosInvoiceAppointmentIds(allPosInvoices.map(inv => inv.appointmentId).filter((id): id is string => !!id));
      setPosInvoices(allPosInvoices.filter(inv => inv.status === "paid"));
      setOutstandingInvoices(allPosInvoices.filter(inv => inv.status !== "paid"));
      // Cash Flow's "Import" feature records income (e.g. bulk-uploaded past
      // sales) as ManualCashIncome entries rather than salon invoices — Cash
      // Flow already counts these, so Revenue needs the same source or it
      // undercounts every imported entry. These have no section of their own,
      // so a section-restricted view can't attribute them and excludes them.
      setManualIncome(revenueScoped ? [] : getManualCashIncome().filter(entry => entry.category !== PETTY_CASH_CATEGORY));
      // Untagged expenses are shared overhead (rent, general salaries, etc.)
      // that can't be attributed to one section, so a restricted view excludes
      // them too — only expenses explicitly tagged to the active section count
      // against it, same rule as manual income above.
      setExpenses(
        getExpenses().filter(e => !revenueScoped || e.section === activeSection)
      );
    });
    return () => { cancelled = true; };
  }, [revenueScoped, activeSection]);

  // Reset drill-down when period changes
  useEffect(() => { setSelectedMonth(null); }, [period]);

  const cfg = PERIODS.find(p => p.key === period)!;

  const filterEnd = period === "custom" ? customEnd : today;

  const rangeStart = useMemo(() => {
    if (!today) return "";
    if (period === "custom") return customStart;
    const d = new Date(today); d.setDate(d.getDate() - (cfg.days - 1));
    return toDateStr(d);
  }, [period, today, customStart]);

  const prevEnd = useMemo(() => {
    if (!today || period === "custom") return "";
    const d = new Date(today); d.setDate(d.getDate() - cfg.days);
    return toDateStr(d);
  }, [period, today]);

  const prevStart = useMemo(() => {
    if (!today || period === "custom") return "";
    const d = new Date(today); d.setDate(d.getDate() - cfg.days * 2 + 1);
    return toDateStr(d);
  }, [period, today]);

  const posLinkedAppointmentIds = useMemo(() =>
    new Set(posInvoiceAppointmentIds),
    [posInvoiceAppointmentIds]);

  const currentAppts = useMemo(() =>
    appointments.filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date >= rangeStart && a.date <= filterEnd),
    [appointments, posLinkedAppointmentIds, rangeStart, filterEnd]);

  const prevAppts = useMemo(() =>
    appointments.filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date >= prevStart && a.date <= prevEnd),
    [appointments, posLinkedAppointmentIds, prevStart, prevEnd]);

  // POS invoices in current / previous range
  const currentPos = useMemo(() =>
    posInvoices.filter(inv => inv.date >= rangeStart && inv.date <= filterEnd),
    [posInvoices, rangeStart, filterEnd]);

  const prevPos = useMemo(() =>
    posInvoices.filter(inv => inv.date >= prevStart && inv.date <= prevEnd),
    [posInvoices, prevStart, prevEnd]);

  // Imported/manual cash income in current / previous range (see Cash Flow's
  // identical manualIncome filtering)
  const currentManual = useMemo(() =>
    manualIncome.filter(entry => entry.date >= rangeStart && entry.date <= filterEnd),
    [manualIncome, rangeStart, filterEnd]);

  const prevManual = useMemo(() =>
    manualIncome.filter(entry => entry.date >= prevStart && entry.date <= prevEnd),
    [manualIncome, prevStart, prevEnd]);

  const totalRevenue = useMemo(() =>
    currentAppts.reduce((s, a) => s + a.totalAmount, 0) + currentPos.reduce((s, inv) => s + revenueAmount(inv), 0) + currentManual.reduce((s, e) => s + e.amount, 0),
    [currentAppts, currentPos, currentManual]);

  const prevRevenue = useMemo(() =>
    prevAppts.reduce((s, a) => s + a.totalAmount, 0) + prevPos.reduce((s, inv) => s + revenueAmount(inv), 0) + prevManual.reduce((s, e) => s + e.amount, 0),
    [prevAppts, prevPos, prevManual]);

  const totalCount = currentAppts.length + currentPos.length + currentManual.length;
  const prevCount  = prevAppts.length  + prevPos.length  + prevManual.length;
  const avgTicket  = totalCount ? totalRevenue / totalCount : 0;
  const prevAvg    = prevCount  ? prevRevenue  / prevCount  : 0;

  const revChange = prevRevenue ? ((totalRevenue - prevRevenue) / prevRevenue) * 100 : 0;
  const cntChange = prevCount   ? ((totalCount   - prevCount)   / prevCount)   * 100 : 0;
  const avgChange = prevAvg     ? ((avgTicket    - prevAvg)     / prevAvg)     * 100 : 0;

  // ── Chart data (1y / custom-long = monthly bars, else daily) ────────────────
  const chartData = useMemo((): ChartBar[] => {
    if (!today) return [];

    // Helper: build monthly bars from a set of dates
    const monthlyBars = (start: string, end: string): ChartBar[] => {
      const monthMap: Record<string, number> = {};
      const cur = new Date(start + "T12:00:00");
      const endDate = new Date(end + "T12:00:00");
      while (cur <= endDate) {
        monthMap[toDateStr(cur).substring(0, 7)] = 0;
        cur.setMonth(cur.getMonth() + 1); cur.setDate(1);
      }
      appointments.forEach(a => {
        if (a.status === "completed" && !posLinkedAppointmentIds.has(a.id)) { const k = a.date.substring(0, 7); if (k in monthMap) monthMap[k] += a.totalAmount; }
      });
      posInvoices.forEach(inv => { const k = inv.date.substring(0, 7); if (k in monthMap) monthMap[k] += revenueAmount(inv); });
      manualIncome.forEach(entry => { const k = entry.date.substring(0, 7); if (k in monthMap) monthMap[k] += entry.amount; });
      const keys = Object.keys(monthMap).sort();
      return keys.map((key, idx) => {
        const d = new Date(key + "-01T12:00:00");
        return { label: d.toLocaleDateString("en-PK", { month: "short" }), value: monthMap[key], isCurrentPeriod: idx === keys.length - 1, monthKey: key };
      });
    };

    if (period === "1y") return monthlyBars(rangeStart, today);

    if (period === "custom") {
      if (!customStart || !customEnd || customStart > customEnd) return [];
      const days = getDaysInRange(customStart, customEnd);
      if (days.length > 62) return monthlyBars(customStart, customEnd);
      const byDay: Record<string, number> = {};
      days.forEach(d => { byDay[d] = 0; });
      appointments.forEach(a => { if (a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date in byDay) byDay[a.date] += a.totalAmount; });
      posInvoices.forEach(inv => { if (inv.date in byDay) byDay[inv.date] += revenueAmount(inv); });
      manualIncome.forEach(entry => { if (entry.date in byDay) byDay[entry.date] += entry.amount; });
      return days.map((date, idx) => {
        const d = new Date(date + "T12:00:00");
        const label = days.length > 14 ? String(d.getDate()) : d.toLocaleDateString("en-PK", { weekday: "short" });
        return { label, value: byDay[date], isCurrentPeriod: idx === days.length - 1, monthKey: date };
      });
    }

    const days = getDaysArray(cfg.days);
    const byDay: Record<string, number> = {};
    days.forEach(d => { byDay[d] = 0; });
    appointments.forEach(a => { if (a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date in byDay) byDay[a.date] += a.totalAmount; });
    posInvoices.forEach(inv => { if (inv.date in byDay) byDay[inv.date] += revenueAmount(inv); });
    manualIncome.forEach(entry => { if (entry.date in byDay) byDay[entry.date] += entry.amount; });
    return days.map((date, idx) => {
      const d = new Date(date + "T12:00:00");
      const label = period === "30d" ? String(d.getDate()) : d.toLocaleDateString("en-PK", { weekday: "short" });
      return { label, value: byDay[date], isCurrentPeriod: idx === days.length - 1, monthKey: date };
    });
  }, [appointments, posLinkedAppointmentIds, posInvoices, manualIncome, period, today, rangeStart, customStart, customEnd]);

  // ── Drill-down: daily rows for the selected month ─────────────────────────
  const drillRows = useMemo(() => {
    if (!selectedMonth) return null;
    const [y, m] = selectedMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const rows: { date: string; dow: string; count: number; revenue: number }[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const appts = appointments.filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date === date);
      const pos   = posInvoices.filter(inv => inv.date === date);
      const manual = manualIncome.filter(entry => entry.date === date);
      const dow   = new Date(date + "T12:00:00").toLocaleDateString("en-PK", { weekday: "short" });
      rows.push({
        date, dow,
        count:   appts.length + pos.length + manual.length,
        revenue: appts.reduce((s, a) => s + a.totalAmount, 0) + pos.reduce((s, inv) => s + inv.total, 0) + manual.reduce((s, e) => s + e.amount, 0),
      });
    }
    return rows.reverse();
  }, [selectedMonth, appointments, posLinkedAppointmentIds, posInvoices, manualIncome]);

  // Drill-down totals
  const drillTotal   = drillRows ? drillRows.reduce((s, r) => s + r.revenue, 0) : 0;
  const drillCount   = drillRows ? drillRows.reduce((s, r) => s + r.count, 0) : 0;
  const drillAvg     = drillCount ? drillTotal / drillCount : 0;

  // Expenses for the drilled-into month — same paid-only filter as periodExpenses
  // below, just scoped to the selected month instead of the page's date range.
  const drillExpenses = useMemo(() => {
    if (!selectedMonth) return 0;
    const [y, m] = selectedMonth.split("-").map(Number);
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    return expenses
      .filter(e => e.date >= monthStart && e.date <= monthEnd && e.paymentStatus !== "pending")
      .reduce((s, e) => s + e.amount, 0);
  }, [selectedMonth, expenses]);
  const drillNetProfit = drillTotal - drillExpenses;

  // ── Default daily rows (no drill-down) ────────────────────────────────────
  const dailyRows = useMemo(() => {
    if (!today) return [] as { date: string; dow: string; count: number; revenue: number }[];
    const days = period === "custom" && customStart && customEnd && customStart <= customEnd
      ? getDaysInRange(customStart, customEnd)
      : getDaysArray(Math.min(cfg.days, 31));
    const byDay: Record<string, { count: number; revenue: number }> = {};
    days.forEach(d => { byDay[d] = { count: 0, revenue: 0 }; });
    currentAppts.forEach(a => {
      if (a.date in byDay) { byDay[a.date].count++; byDay[a.date].revenue += a.totalAmount; }
    });
    currentPos.forEach(inv => {
      if (inv.date in byDay) { byDay[inv.date].count++; byDay[inv.date].revenue += inv.total; }
    });
    currentManual.forEach(entry => {
      if (entry.date in byDay) { byDay[entry.date].count++; byDay[entry.date].revenue += entry.amount; }
    });
    return days.map(date => ({
      date,
      dow: new Date(date + "T12:00:00").toLocaleDateString("en-PK", { weekday: "short" }),
      ...byDay[date],
    })).reverse();
  }, [currentAppts, currentPos, currentManual, period, today, customStart, customEnd]);

  const methodBreakdown = useMemo(() => {
    const invoices = getSalonInvoices().filter((inv) => {
      if (inv.status !== "paid") return false;
      if (inv.source && inv.source !== "pos") return false;
      if (revenueScoped && inv.section !== activeSection) return false;
      return inv.date >= rangeStart && inv.date <= filterEnd;
    });
    const totals: Record<string, number> = {};
    invoices.forEach(inv => {
      if (!inv.paymentMethod) return;
      totals[inv.paymentMethod] = (totals[inv.paymentMethod] ?? 0) + inv.total;
    });
    const grand = Object.values(totals).reduce((s, v) => s + v, 0) || 1;
    return Object.entries(totals)
      .map(([method, amount]) => ({ method, amount, pct: (amount / grand) * 100 }))
      .sort((a, b) => b.amount - a.amount);
  }, [rangeStart, filterEnd, revenueScoped, activeSection]);

  // Custom selections drive a combined report for their entire date range.
  // Preset periods keep this card as today's operational snapshot.
  const customReportRange = period === "custom" && customStart <= customEnd;
  const reportStart = customReportRange ? customStart : today;
  const reportEnd = customReportRange ? customEnd : today;
  const reportHasMultipleDays = reportStart !== reportEnd;
  const reportAppts = useMemo(() =>
    appointments
      .filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date >= reportStart && a.date <= reportEnd)
      .sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`)),
    [appointments, posLinkedAppointmentIds, reportStart, reportEnd]);

  const reportPos = useMemo(() =>
    posInvoices
      .filter(inv => inv.date >= reportStart && inv.date <= reportEnd)
      .sort((a, b) => `${a.date}T${a.createdAt}`.localeCompare(`${b.date}T${b.createdAt}`)),
    [posInvoices, reportStart, reportEnd]);

  const reportManual = useMemo(() =>
    manualIncome
      .filter(entry => entry.date >= reportStart && entry.date <= reportEnd)
      .sort((a, b) => `${a.date}T${a.createdAt}`.localeCompare(`${b.date}T${b.createdAt}`)),
    [manualIncome, reportStart, reportEnd]);

  const reportRevenue = reportAppts.reduce((s, a) => s + a.totalAmount, 0) + reportPos.reduce((s, inv) => s + inv.total, 0) + reportManual.reduce((s, e) => s + e.amount, 0);
  const reportCount   = reportAppts.length + reportPos.length + reportManual.length;
  const reportAvg     = reportCount ? reportRevenue / reportCount : 0;

  const reportMethodBreakdown = useMemo(() => {
    const totals: Record<string, number> = {};
    reportPos.forEach(inv => {
      if (!inv.paymentMethod) return;
      totals[inv.paymentMethod] = (totals[inv.paymentMethod] ?? 0) + inv.total;
    });
    return Object.entries(totals)
      .map(([method, amount]) => ({ method, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [reportPos]);

  const topServices = useMemo(() => {
    const map: Record<string, { name: string; count: number; revenue: number }> = {};
    currentAppts.forEach(a => {
      const k = a.serviceNames[0] ?? "Other";
      if (!map[k]) map[k] = { name: k, count: 0, revenue: 0 };
      map[k].count++; map[k].revenue += a.totalAmount;
    });
    currentPos.forEach(inv => {
      inv.items.forEach(item => {
        const k = item.description || "POS Sale";
        if (!map[k]) map[k] = { name: k, count: 0, revenue: 0 };
        map[k].count += item.qty; map[k].revenue += item.total;
      });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, 6);
  }, [currentAppts, currentPos]);

  // ── Net profit ─────────────────────────────────────────────────────────────
  // Net Profit = Revenue − all logged Expenses (rent, utilities, marketing, etc,
  // including the "salaries" category) for the selected period. Only expenses
  // marked paid count — a pending/unpaid bill isn't a cost that's actually hit
  // the salon yet, matching the same paid-only filter the Cash Flow page uses.
  const periodExpenses = useMemo(() =>
    expenses.filter(e => e.date >= rangeStart && e.date <= filterEnd && e.paymentStatus !== "pending"),
    [expenses, rangeStart, filterEnd]);

  const totalExpenses = useMemo(() => periodExpenses.reduce((s, e) => s + e.amount, 0), [periodExpenses]);

  const expenseByCategory = useMemo(() => {
    const totals: Record<string, number> = {};
    periodExpenses.forEach(e => { totals[e.category] = (totals[e.category] ?? 0) + e.amount; });
    const grand = Object.values(totals).reduce((s, v) => s + v, 0) || 1;
    return Object.entries(totals)
      .map(([category, amount]) => ({ category, amount, pct: (amount / grand) * 100 }))
      .sort((a, b) => b.amount - a.amount);
  }, [periodExpenses]);

  const netProfit = totalRevenue - totalExpenses;
  const netMarginPct = totalRevenue ? (netProfit / totalRevenue) * 100 : 0;

  // ── Net profit by payment channel ──────────────────────────────────────────
  // Same bucketing convention the Cash Flow page uses: an appointment closed
  // without a POS checkout, an imported/manual entry, or anything with no
  // tracked method counts as cash; card, bank and mobile wallets are online.
  const revenueByChannel = useMemo(() => {
    let cash = currentAppts.reduce((s, a) => s + a.totalAmount, 0) + currentManual.reduce((s, e) => s + e.amount, 0);
    let online = 0;
    currentPos.forEach(inv => {
      if ((inv.paymentMethod || "cash") === "cash") cash += inv.total;
      else online += inv.total;
    });
    return { cash, online };
  }, [currentAppts, currentPos, currentManual]);

  const expensesByChannel = useMemo(() => {
    let cash = 0, online = 0;
    periodExpenses.forEach(e => {
      if ((e.paymentMethod || "cash") === "cash") cash += e.amount;
      else online += e.amount;
    });
    return { cash, online };
  }, [periodExpenses]);

  const netProfitByChannel = useMemo(() => ({
    cash:   revenueByChannel.cash   - expensesByChannel.cash,
    online: revenueByChannel.online - expensesByChannel.online,
  }), [revenueByChannel, expensesByChannel]);

  const maxChart = Math.max(...chartData.map(d => d.value), 1);

  const yLabels = useMemo(() => computeYLabels(maxChart), [maxChart]);

  // ── Hourly breakdown for "today" — a single day of daily bars is just one
  // bar filling the whole width, which reads as a broken chart rather than a
  // trend. Break it into hours instead and render as a line, so "today" still
  // shows a shape even with one day of data.
  const hourlyChartData = useMemo(() => {
    if (period !== "today") return [] as { hour: number; label: string; value: number }[];
    const byHour = Array.from({ length: 24 }, () => 0);
    currentAppts.forEach(a => {
      const h = Number(a.startTime.split(":")[0]);
      if (h >= 0 && h < 24) byHour[h] += a.totalAmount;
    });
    currentPos.forEach(inv => {
      const h = new Date(inv.createdAt).getHours();
      if (h >= 0 && h < 24) byHour[h] += inv.total;
    });
    currentManual.forEach(entry => {
      const h = new Date(entry.createdAt).getHours();
      if (h >= 0 && h < 24) byHour[h] += entry.amount;
    });
    return byHour.map((value, hour) => ({ hour, label: hourLabel(hour), value }));
  }, [period, currentAppts, currentPos, currentManual]);

  const maxHourly = Math.max(...hourlyChartData.map(d => d.value), 1);
  const hourlyYLabels = useMemo(() => computeYLabels(maxHourly), [maxHourly]);

  // Selected month label e.g. "November 2025"
  const selectedMonthLabel = selectedMonth
    ? new Date(selectedMonth + "-01T12:00:00").toLocaleDateString("en-PK", { month: "long", year: "numeric" })
    : "";

  function Trend({ change }: { change: number }) {
    const up = change >= 0;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600, color: up ? "#22c55e" : "#ef4444" }}>
        {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
        {Math.abs(change).toFixed(1)}% vs prev period
      </div>
    );
  }

  // ── PDF Export ─────────────────────────────────────────────────────────────
  function exportPDF() {
    if (period === "custom" && (!customStart || !customEnd || customStart > customEnd)) {
      alert("Please select a valid start and end date for the custom range before downloading.");
      return;
    }

    const now = new Date();
    const isYearDrill = !!selectedMonth;

    // For 1y or long custom (>62 days) we aggregate monthly; otherwise daily
    const customDayCount = period === "custom"
      ? getDaysInRange(customStart, customEnd).length : 0;
    const useMonthlyTable = !isYearDrill && (period === "1y" || (period === "custom" && customDayCount > 62));

    // Build PDF table rows independent of the UI's capped dailyRows
    let tableRows: { date: string; dow: string; count: number; revenue: number }[];
    if (isYearDrill) {
      tableRows = drillRows ?? [];
    } else if (useMonthlyTable) {
      // Monthly aggregation over the full selected range
      const monthlyMap: Record<string, { count: number; revenue: number }> = {};
      const cur = new Date(rangeStart + "T12:00:00"); cur.setDate(1);
      const endD = new Date(filterEnd + "T12:00:00");
      while (cur <= endD) {
        const key = toDateStr(cur).substring(0, 7);
        monthlyMap[key] = { count: 0, revenue: 0 };
        cur.setMonth(cur.getMonth() + 1);
      }
      currentAppts.forEach(a => {
        const key = a.date.substring(0, 7);
        if (key in monthlyMap) { monthlyMap[key].count++; monthlyMap[key].revenue += a.totalAmount; }
      });
      currentPos.forEach(inv => {
        const key = inv.date.substring(0, 7);
        if (key in monthlyMap) { monthlyMap[key].count++; monthlyMap[key].revenue += inv.total; }
      });
      currentManual.forEach(entry => {
        const key = entry.date.substring(0, 7);
        if (key in monthlyMap) { monthlyMap[key].count++; monthlyMap[key].revenue += entry.amount; }
      });
      tableRows = Object.keys(monthlyMap).sort().reverse().map(key => ({
        date: key,
        dow: new Date(key + "-01T12:00:00").toLocaleDateString("en-PK", { month: "long", year: "numeric" }),
        count: monthlyMap[key].count,
        revenue: monthlyMap[key].revenue,
      }));
    } else {
      // Full daily rows for the period — no cap
      const days = getDaysInRange(rangeStart, filterEnd);
      const byDay: Record<string, { count: number; revenue: number }> = {};
      days.forEach(d => { byDay[d] = { count: 0, revenue: 0 }; });
      currentAppts.forEach(a => {
        if (a.date in byDay) { byDay[a.date].count++; byDay[a.date].revenue += a.totalAmount; }
      });
      currentPos.forEach(inv => {
        if (inv.date in byDay) { byDay[inv.date].count++; byDay[inv.date].revenue += inv.total; }
      });
      currentManual.forEach(entry => {
        if (entry.date in byDay) { byDay[entry.date].count++; byDay[entry.date].revenue += entry.amount; }
      });
      tableRows = days.map(date => ({
        date,
        dow: new Date(date + "T12:00:00").toLocaleDateString("en-PK", { weekday: "short" }),
        count: byDay[date].count,
        revenue: byDay[date].revenue,
      })).reverse();
    }

    const pdfTotal   = isYearDrill ? drillTotal   : totalRevenue;
    const pdfCount   = isYearDrill ? drillCount   : totalCount;
    const pdfAvg     = isYearDrill ? drillAvg     : avgTicket;
    const pdfExpenses    = isYearDrill ? drillExpenses    : totalExpenses;
    const pdfNetProfit = isYearDrill ? drillNetProfit : netProfit;
    const pdfNetMarginPct = pdfTotal ? (pdfNetProfit / pdfTotal) * 100 : 0;
    const periodLabel = period === "custom" ? `${rangeStart} → ${filterEnd}` : cfg.label;
    const pdfTitle   = isYearDrill ? `${selectedMonthLabel} — Daily Detail` : `Revenue Report — ${periodLabel}`;
    const pdfRange   = isYearDrill ? selectedMonthLabel : `${rangeStart} to ${filterEnd}`;

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Salon Central ${pdfTitle}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Montserrat', sans-serif; background: #fff; color: #1a1a2e; font-size: 13px; }
    .page { max-width: 820px; margin: 0 auto; padding: 40px 48px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #f0f0f8; }
    .logo-img { position:relative; overflow:hidden; width:104px; height:51px; }
    .logo-img img { position:absolute; width:117.52%; height:241.61%; max-width:none; left:-9.14%; top:-66%; }
    .logo-sub  { font-size: 12px; color: #a0a0b8; margin-top: 6px; }
    .report-meta { text-align: right; }
    .report-title { font-size: 16px; font-weight: 800; color: #7C3AED; }
    .report-sub   { font-size: 12px; color: #6b6b8a; margin-top: 4px; }
    .report-gen   { font-size: 11px; color: #c0c0d0; margin-top: 2px; }
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 28px; }
    .stat-card  { background: #F5F3FF; border-radius: 12px; padding: 16px; border: 1px solid #EDE9FE; }
    .stat-label { font-size: 10px; font-weight: 700; color: #a0a0b8; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px; }
    .stat-value { font-size: 20px; font-weight: 800; color: #7C3AED; }
    .stat-value.expense { color: #dc2626; }
    .stat-value.profit { color: ${pdfNetProfit >= 0 ? "#059669" : "#dc2626"}; }
    .stat-sub   { font-size: 10px; color: #a0a0b8; margin-top: 4px; }
    .section { margin-bottom: 28px; }
    .section-title { font-size: 14px; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
    .section-sub   { font-size: 11px; color: #a0a0b8; margin-bottom: 16px; }
    .chart-area   { display: flex; align-items: flex-end; gap: 5px; height: 130px; border-bottom: 2px solid #f0f0f8; padding: 0 2px; }
    .bar-wrap     { flex: 1; display: flex; align-items: flex-end; height: 100%; }
    .bar          { width: 100%; border-radius: 4px 4px 0 0; min-height: 2px; }
    .bar-labels   { display: flex; gap: 5px; padding-top: 6px; }
    .bar-lbl      { flex: 1; text-align: center; font-size: 9px; color: #c0c0d0; overflow: hidden; }
    .methods-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .method-row   { border: 1px solid #f0f0f8; border-radius: 10px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
    .method-dot   { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 8px; flex-shrink: 0; }
    .method-name  { font-weight: 600; font-size: 13px; display: flex; align-items: center; }
    .method-pct   { font-size: 11px; color: #a0a0b8; margin-top: 2px; }
    .method-amount{ font-weight: 700; color: #7C3AED; font-size: 13px; }
    .svc-grid     { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .svc-card     { border: 1px solid #f0f0f8; border-radius: 10px; padding: 12px 14px; }
    .svc-name     { font-weight: 600; font-size: 12px; color: #1a1a2e; margin-bottom: 4px; }
    .svc-count    { font-size: 10px; color: #a0a0b8; }
    .svc-rev      { font-weight: 700; color: #7C3AED; font-size: 13px; margin-top: 6px; }
    table         { width: 100%; border-collapse: collapse; }
    thead tr      { background: #F5F3FF; }
    th { font-size: 10px; font-weight: 700; color: #a0a0b8; letter-spacing: 0.07em; text-transform: uppercase; padding: 10px 14px; text-align: left; border-bottom: 1px solid #f0f0f8; }
    td { padding: 10px 14px; font-size: 12px; border-bottom: 1px solid #f8f8fc; }
    tr:last-child td { border-bottom: none; }
    .total-row td { font-weight: 700; background: #F5F3FF; color: #7C3AED; border-top: 1px solid #f0f0f8; }
    .amount { font-weight: 700; color: #7C3AED; }
    .muted  { color: #a0a0b8; }
    .footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #f0f0f8; display: flex; justify-content: space-between; }
    .footer-txt { font-size: 11px; color: #c0c0d0; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page { padding: 24px 32px; } }
  </style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <div class="logo-img"><img src="${window.location.origin}/salon-central-logo.png" alt="Salon Central" /></div>
      <div class="logo-sub">Salon Management Platform</div>
    </div>
    <div class="report-meta">
      <div class="report-title">${pdfTitle}</div>
      <div class="report-sub">${pdfRange}</div>
      <div class="report-gen">Generated ${now.toLocaleDateString("en-PK", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} · ${now.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}</div>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value">${fmt(pdfTotal)}</div>
      <div class="stat-sub">${!isYearDrill ? (revChange >= 0 ? "▲" : "▼") + " " + Math.abs(revChange).toFixed(1) + "% vs prev" : pdfRange}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Paid Expenses</div>
      <div class="stat-value expense">${fmt(pdfExpenses)}</div>
      <div class="stat-sub">Total expenses</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Net Profit</div>
      <div class="stat-value profit">${fmt(pdfNetProfit)}</div>
      <div class="stat-sub">${pdfNetMarginPct.toFixed(1)}% net margin</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Appointments</div>
      <div class="stat-value">${pdfCount}</div>
      <div class="stat-sub">Completed services</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Avg Ticket</div>
      <div class="stat-value">${fmt(pdfAvg)}</div>
      <div class="stat-sub">Per appointment</div>
    </div>
  </div>

  ${!isYearDrill ? `
  <div class="section">
    <div class="section-title">Net Profit by Payment Channel</div>
    <div class="section-sub">Revenue minus paid expenses, split by how each was settled</div>
    <table>
      <thead>
        <tr>
          <th>Channel</th>
          <th style="text-align:right">Revenue</th>
          <th style="text-align:right">Expenses</th>
          <th style="text-align:right">Net Profit</th>
        </tr>
      </thead>
      <tbody>
        ${[
          { label: "Cash",   revenue: revenueByChannel.cash,   expenses: expensesByChannel.cash,   net: netProfitByChannel.cash   },
          { label: "Online", revenue: revenueByChannel.online, expenses: expensesByChannel.online, net: netProfitByChannel.online },
        ].map(c => `
          <tr>
            <td>${c.label}</td>
            <td style="text-align:right">${fmt(c.revenue)}</td>
            <td style="text-align:right;color:#dc2626">−${fmt(c.expenses)}</td>
            <td style="text-align:right;font-weight:700;color:${c.net >= 0 ? "#059669" : "#dc2626"}">${fmt(c.net)}</td>
          </tr>`).join("")}
        <tr class="total-row">
          <td>Total</td>
          <td style="text-align:right">${fmt(pdfTotal)}</td>
          <td style="text-align:right">−${fmt(pdfExpenses)}</td>
          <td style="text-align:right">${fmt(pdfNetProfit)}</td>
        </tr>
      </tbody>
    </table>
  </div>
  ` : ""}

  ${!isYearDrill ? `
  <div class="section">
    <div class="section-title">Revenue Trend</div>
    <div class="section-sub">${useMonthlyTable ? "Monthly" : "Daily"} breakdown · ${pdfRange}</div>
    <div class="chart-area">
      ${chartData.map(d => {
        const h = maxChart > 0 ? Math.max(2, Math.round((d.value / maxChart) * 100)) : 2;
        return `<div class="bar-wrap"><div class="bar" style="height:${h}%;background:${d.isCurrentPeriod ? "#7C3AED" : "#DDD6FE"}"></div></div>`;
      }).join("")}
    </div>
    <div class="bar-labels">${chartData.map(d => `<div class="bar-lbl">${d.label}</div>`).join("")}</div>
  </div>
  <div class="section">
    <div class="section-title">Payment Methods</div>
    <div class="section-sub">Revenue by channel</div>
    <div class="methods-grid">
      ${methodBreakdown.map(m => `
      <div class="method-row">
        <div>
          <div class="method-name"><span class="method-dot" style="background:${METHOD_COLORS[m.method] ?? "#888"}"></span>${METHOD_LABELS[m.method] ?? m.method}</div>
          <div class="method-pct">${m.pct.toFixed(0)}% of total</div>
        </div>
        <div class="method-amount">${fmt(m.amount)}</div>
      </div>`).join("")}
    </div>
  </div>
  ${topServices.length > 0 ? `
  <div class="section">
    <div class="section-title">Top Services by Revenue</div>
    <div class="section-sub">Most profitable this period</div>
    <div class="svc-grid">
      ${topServices.map(s => `
      <div class="svc-card">
        <div class="svc-name">${s.name}</div>
        <div class="svc-count">${s.count} appointment${s.count !== 1 ? "s" : ""}</div>
        <div class="svc-rev">${fmt(s.revenue)}</div>
      </div>`).join("")}
    </div>
  </div>` : ""}` : ""}

  <div class="section">
    <div class="section-title">${isYearDrill ? selectedMonthLabel + " — Daily Breakdown" : (useMonthlyTable ? "Monthly Breakdown" : "Daily Breakdown")}</div>
    <div class="section-sub">Complete breakdown · ${pdfRange}</div>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Day</th>
          <th style="text-align:center">Appts</th>
          <th style="text-align:right">Revenue</th>
          <th style="text-align:right">Avg Ticket</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows.map(row => {
          const avg = row.count ? row.revenue / row.count : 0;
          return `
          <tr>
            <td>${row.date}</td>
            <td class="muted">${row.dow ?? ""}</td>
            <td style="text-align:center">${row.count}</td>
            <td class="amount" style="text-align:right">${fmt(row.revenue)}</td>
            <td style="text-align:right" class="muted">${avg ? fmt(avg) : "—"}</td>
          </tr>`;
        }).join("")}
        <tr class="total-row">
          <td colspan="2"><strong>Total</strong></td>
          <td style="text-align:center"><strong>${pdfCount}</strong></td>
          <td style="text-align:right"><strong>${fmt(pdfTotal)}</strong></td>
          <td style="text-align:right"><strong>${fmt(pdfAvg)}</strong></td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="footer">
    <div class="footer-txt">Salon Central · Salon Management Platform</div>
    <div class="footer-txt">Confidential · For internal use only</div>
  </div>
</div>
</body>
</html>`;

    printHtml(html);
  }

  // ── Table rows to display ──────────────────────────────────────────────────
  const tableRows    = selectedMonth ? (drillRows ?? []) : dailyRows;
  const tableTotal   = selectedMonth ? drillTotal   : totalRevenue;
  const tableCount   = selectedMonth ? drillCount   : totalCount;
  const tableAvg     = selectedMonth ? drillAvg     : avgTicket;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh" }}>

      {/* ── Native mobile app bar ── */}
      <MobilePageHeader
        title="Revenue"
        subtitle={cfg.label}
        action={{ label: "Export PDF", onClick: exportPDF }}
      />

      {/* ── Mobile period tabs ── */}
      <div className="mobile-tab-bar mobile-only">
        {PERIODS.map((p) => (
          <button key={p.key} type="button" className={`mobile-tab-btn ${period === p.key ? "active" : ""}`} onClick={() => setPeriod(p.key)}>{p.label}</button>
        ))}
      </div>

      {/* ── Mobile custom range (the desktop picker lives in the desktop-only block) ── */}
      {period === "custom" && (
        <div className="mobile-only" style={{ margin: "10px 16px 0", padding: "12px 14px", background: "#fff", border: "1.5px solid #7C3AED", borderRadius: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#6b6b8a" }}>
              From
              <input type="date" value={customStart} max={customEnd || undefined} onChange={e => setCustomStart(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid #e8e8f0", color: "#1a1a2e", outline: "none", boxSizing: "border-box", background: "#fff" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#6b6b8a" }}>
              To
              <input type="date" value={customEnd} min={customStart} onChange={e => setCustomEnd(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid #e8e8f0", color: "#1a1a2e", outline: "none", boxSizing: "border-box", background: "#fff" }} />
            </label>
          </div>
          {customStart && customEnd && customStart <= customEnd && (
            <div style={{ fontSize: 11, color: "#7C3AED", fontWeight: 700, marginTop: 8 }}>
              {(n => `${n} day${n === 1 ? "" : "s"} selected`)(getDaysInRange(customStart, customEnd).length)}
            </div>
          )}
        </div>
      )}

      {/* ── Mobile hero revenue card ── */}
      <div className="mobile-only">
        <div className="mobile-hero-card">
          <div className="mobile-hero-label">Total Revenue · {cfg.label}</div>
          <div className="mobile-hero-value">{fmt(totalRevenue)}</div>
          <div className="mobile-hero-sub" style={{ color: revChange >= 0 ? "#4ade80" : "#f87171" }}>
            {revChange >= 0 ? "▲" : "▼"} {Math.abs(revChange).toFixed(1)}% vs previous {cfg.label.toLowerCase()}
          </div>
        </div>

        {/* Mobile stats scroll */}
        <div className="mobile-stat-scroll">
          {[
            { label: "Appointments", value: String(totalCount), color: "#3b82f6", change: cntChange },
            { label: "Avg Ticket",   value: fmtK(avgTicket),   color: "#059669", change: avgChange },
          ].map((s) => (
            <div key={s.label} className="mobile-stat-card">
              <div className="mobile-stat-card-label">{s.label}</div>
              <div className="mobile-stat-card-value" style={{ color: s.color }}>{s.value}</div>
              {s.change !== 0 && <div className="mobile-stat-card-sub" style={{ color: s.change >= 0 ? "#059669" : "#dc2626" }}>{s.change >= 0 ? "▲" : "▼"} {Math.abs(s.change).toFixed(1)}%</div>}
            </div>
          ))}
        </div>

        {/* Mobile payment methods */}
        {methodBreakdown.length > 0 && (
          <>
            <div className="mobile-section-header">By Payment Method</div>
            <div style={{ padding: "0 16px" }}>
              {methodBreakdown.slice(0, 4).map((m) => (
                <div key={m.method} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: METHOD_COLORS[m.method] ?? "#888", flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e", flex: 1 }}>{METHOD_LABELS[m.method]}</span>
                  <span style={{ fontSize: 12, color: "#9898b0" }}>{m.pct.toFixed(0)}%</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED", minWidth: 80, textAlign: "right" }}>{fmt(m.amount)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Mobile daily table */}
        {dailyRows.length > 0 && (
          <>
            <div className="mobile-section-header">Daily Breakdown</div>
            <div className="mobile-list">
              {dailyRows.slice(0, 10).map((row) => (
                <div key={row.date} className="mobile-list-card">
                  <div className="mobile-list-icon" style={{ background: row.date === today ? "#ede9fe" : "#f4f4fb" }}>
                    <CalendarDays size={16} color={row.date === today ? "#7C3AED" : "#9898b0"} />
                  </div>
                  <div className="mobile-list-body">
                    <div className="mobile-list-title">{row.date === today ? "Today" : row.date}</div>
                    <div className="mobile-list-sub">{row.count} appointment{row.count !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="mobile-list-right">
                    <div className="mobile-list-amount" style={{ color: "#7C3AED" }}>{fmt(row.revenue)}</div>
                    <div style={{ fontSize: 11, color: "#9898b0" }}>{row.count ? fmt(row.revenue / row.count) : "—"} avg</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Desktop layout ── */}
      <div className="dash-page dashboard-polish desktop-only" style={{ background: "#ffffff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Title + controls */}
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <PageTitle
          icon={<TrendingUp size={24} />}
          title="Revenue"
          subtitle={revenueScoped ? `Restricted to ${activeSection} revenue only` : "Track your salon's financial performance — combined across all sections"}
        />
        <div className="rev-header-controls" style={{ display: "flex", gap: 12, marginLeft: "auto" }}>
          <div className="rev-period-selector segment-control">
            {PERIODS.map(p => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={`segment-btn ${period === p.key ? "active" : ""}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            onClick={exportPDF}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 12, border: "1px solid #e3e0eb", cursor: "pointer", background: "#fff", color: "#6b6b8a", fontSize: 13, fontWeight: 750, transition: "all 0.15s" }}
            className="hover-bg-light"
          >
            <Download size={15} /> Export PDF
          </button>
        </div>
      </div>

      {/* Custom date range picker */}
      {period === "custom" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1.5px solid #7C3AED", borderRadius: 12, padding: "10px 18px", marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#7C3AED" }}>Date Range</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 600 }}>From</label>
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
          </div>
          <span style={{ color: "#c0c0d0", fontSize: 16 }}>→</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 600 }}>To</label>
            <input type="date" value={customEnd} min={customStart} onChange={e => setCustomEnd(e.target.value)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
          </div>
          {customStart && customEnd && customStart <= customEnd && (
            <span style={{ fontSize: 12, color: "#a0a0b8", marginLeft: 4 }}>
              {getDaysInRange(customStart, customEnd).length} days
            </span>
          )}
        </div>
      )}

      {/* Content tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #f0f0f8" }}>
        {([
          { key: "overview", label: "Overview" },
          { key: "net",      label: "Net Profit" },
          { key: "ledger",   label: "Ledger" },
        ] as { key: RevTab; label: string }[]).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "10px 16px", fontSize: 13, fontWeight: 700,
            color: tab === t.key ? "#7C3AED" : "#9898b0",
            borderBottom: tab === t.key ? "2px solid #7C3AED" : "2px solid transparent",
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
      <>
      {/* Empty state banner */}
      {appointments.filter(a => a.status === "completed").length === 0 && posInvoices.length === 0 && manualIncome.length === 0 && (
        <div style={{ background: "#f8f9ff", border: "1px solid #e0e0f8", borderRadius: 10, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: "#6b6b8a", display: "flex", alignItems: "center", gap: 10 }}>
          <TrendingUp size={16} color="#a0a0c8" />
          No completed appointments yet — revenue figures will appear here once you complete your first appointment.
        </div>
      )}

      {/* Stat cards */}
      <div className="stats-grid-3">
        {[
          { label: "Total Revenue", value: fmt(totalRevenue), change: revChange, icon: TrendingUp,   color: "var(--accent)", bg: "rgba(124, 58, 237, 0.08)", showTrend: true  },
          { label: "Appointments",  value: String(totalCount), change: cntChange, icon: CalendarDays, color: "#3b82f6", bg: "#eff6ff", showTrend: true  },
          { label: "Revenue Growth", value: `${revChange >= 0 ? "+" : ""}${revChange.toFixed(1)}%`, change: revChange, icon: Percent, color: revChange >= 0 ? "#059669" : "#dc2626", bg: revChange >= 0 ? "#f0fdf4" : "#fef2f2", showTrend: false },
        ].map(({ label, value, change, icon: Icon, color, bg, showTrend }) => (
          <div key={label} style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.02)", flex: 1 }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color }}>
              <Icon size={24} color={color} />
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
              {showTrend && <div style={{ marginTop: 2 }}><Trend change={change} /></div>}
            </div>
          </div>
        ))}
      </div>

      {/* ── Daily Report ── */}
      <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", overflow: "hidden" }}>
        {/* Header */}
        <div
          style={{ padding: "18px 24px", borderBottom: dailyReportOpen ? "1px solid #f0f0f8" : "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
          onClick={() => setDailyReportOpen(o => !o)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Receipt size={17} color="#7C3AED" />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "#1a1a2e" }}>Daily Report</div>
              <div style={{ fontSize: 12, color: "#a0a0b8", marginTop: 2 }}>
                {reportHasMultipleDays ? `${reportStart} → ${reportEnd} · Combined range activity` : `${reportStart} · ${reportStart === today ? "Today’s activity" : "Selected day activity"}`}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#a0a0b8", letterSpacing: "0.06em", textTransform: "uppercase" }}>Revenue</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#7C3AED" }}>{fmt(reportRevenue)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#a0a0b8", letterSpacing: "0.06em", textTransform: "uppercase" }}>Appts</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#3b82f6" }}>{reportCount}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#a0a0b8", letterSpacing: "0.06em", textTransform: "uppercase" }}>Avg Ticket</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#059669" }}>{reportCount ? fmt(reportAvg) : "—"}</div>
            </div>
            <div style={{ color: "#c0c0d0" }}>
              {dailyReportOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </div>
          </div>
        </div>

        {dailyReportOpen && (
          <>
            {/* Column headers */}
            <div style={{ display: "grid", gridTemplateColumns: "90px 1.4fr 1.4fr 1fr 1fr 110px", padding: "9px 24px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
              {[reportHasMultipleDays ? "DATE / TIME" : "TIME", "CLIENT", "SERVICE / ITEM", "STAFF", "PAYMENT", "AMOUNT"].map(h => (
                <div key={h} style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
              ))}
            </div>

            {/* Appointment rows */}
            {reportAppts.length === 0 && reportPos.length === 0 && reportManual.length === 0 ? (
              <div style={{ padding: "32px 24px", textAlign: "center", fontSize: 13, color: "#c0c0d0" }}>
                No transactions found for {reportHasMultipleDays ? `${reportStart} to ${reportEnd}` : reportStart}
              </div>
            ) : (
              <>
                {reportAppts.map((a) => (
                  <div key={a.id} style={{ display: "grid", gridTemplateColumns: "90px 1.4fr 1.4fr 1fr 1fr 110px", padding: "11px 24px", borderBottom: "1px solid #f8f8fc", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b6b8a" }}>
                      <Clock size={12} color="#c0c0d0" />
                      {reportHasMultipleDays ? `${fmtShortDate(a.date)} · ` : ""}{fmtTime(a.startTime)}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {a.clientName}
                      {a.section && <span style={{ fontSize: 10, fontWeight: 700, background: "#F5F3FF", color: "#7C3AED", padding: "1px 7px", borderRadius: 20 }}>{a.section}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#6b6b8a" }}>{a.serviceNames.join(", ") || "—"}</div>
                    <div style={{ fontSize: 12, color: "#6b6b8a" }}>{a.staffName}</div>
                    <div>
                      <span style={{ fontSize: 11, background: "#f0f0f8", color: "#6b6b8a", padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>Appointment</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{fmt(a.totalAmount)}</div>
                  </div>
                ))}

                {reportPos.map((inv) => (
                  <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "90px 1.4fr 1.4fr 1fr 1fr 110px", padding: "11px 24px", borderBottom: "1px solid #f8f8fc", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b6b8a" }}>
                      <Clock size={12} color="#c0c0d0" />
                      {reportHasMultipleDays ? `${fmtShortDate(inv.date)} · ` : ""}
                      {inv.createdAt ? new Date(inv.createdAt).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit", hour12: true }) : "—"}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {inv.clientName || "Walk-in"}
                      {inv.section && <span style={{ fontSize: 10, fontWeight: 700, background: "#F5F3FF", color: "#7C3AED", padding: "1px 7px", borderRadius: 20 }}>{inv.section}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#6b6b8a" }}>{inv.items.map(it => it.description).join(", ") || "POS Sale"}</div>
                    <div style={{ fontSize: 12, color: "#6b6b8a" }}>{inv.staffName || "—"}</div>
                    <div>
                      <span style={{
                        fontSize: 11,
                        background: METHOD_COLORS[inv.paymentMethod] ? `${METHOD_COLORS[inv.paymentMethod]}18` : "#f0f0f8",
                        color: METHOD_COLORS[inv.paymentMethod] ?? "#6b6b8a",
                        padding: "2px 8px", borderRadius: 20, fontWeight: 700,
                      }}>
                        {METHOD_LABELS[inv.paymentMethod] ?? inv.paymentMethod ?? "—"}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{fmt(inv.total)}</div>
                  </div>
                ))}

                {reportManual.map((entry) => (
                  <div key={entry.id} style={{ display: "grid", gridTemplateColumns: "90px 1.4fr 1.4fr 1fr 1fr 110px", padding: "11px 24px", borderBottom: "1px solid #f8f8fc", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b6b8a" }}>
                      <Clock size={12} color="#c0c0d0" />
                      {reportHasMultipleDays ? fmtShortDate(entry.date) : "—"}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{entry.category || "Imported Income"}</div>
                    <div style={{ fontSize: 12, color: "#6b6b8a" }}>{entry.description || "—"}</div>
                    <div style={{ fontSize: 12, color: "#6b6b8a" }}>—</div>
                    <div>
                      <span style={{ fontSize: 11, background: "#F5F3FF", color: "#7C3AED", padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>Imported</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{fmt(entry.amount)}</div>
                  </div>
                ))}

                {/* Footer totals */}
                <div style={{ display: "grid", gridTemplateColumns: "90px 1.4fr 1.4fr 1fr 1fr 110px", padding: "11px 24px", background: "#fafafa", borderTop: "1px solid #f0f0f8", alignItems: "center" }}>
                  <div />
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e" }}>Total · {reportCount} transactions</div>
                  <div />
                  <div />
                  {/* Payment method pills */}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {reportMethodBreakdown.map(m => (
                      <span key={m.method} style={{ fontSize: 10, background: `${METHOD_COLORS[m.method] ?? "#888"}18`, color: METHOD_COLORS[m.method] ?? "#888", padding: "2px 7px", borderRadius: 20, fontWeight: 700 }}>
                        {METHOD_LABELS[m.method] ?? m.method} {fmt(m.amount)}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#7C3AED" }}>{fmt(reportRevenue)}</div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Revenue bar chart */}
      <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", padding: "26px 30px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>Revenue Trend</div>
            <div style={{ fontSize: 12, color: "#a0a0b8", marginTop: 3 }}>
              {period === "1y" ? "Monthly breakdown" : period === "today" ? "Hourly breakdown" : "Daily breakdown"} · {rangeStart} → {filterEnd}
              {period === "1y" && (
                <span style={{ marginLeft: 8, fontSize: 11, color: "#9333EA", fontWeight: 600 }}>
                  Click a bar to drill into that month
                </span>
              )}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#7C3AED" }}>{fmt(totalRevenue)}</div>
            <div style={{ fontSize: 12, color: "#a0a0b8", marginTop: 2 }}>{cfg.label} total</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 14 }}>
          {/* Y-axis */}
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", paddingBottom: 26, minWidth: 40 }}>
            {(period === "today" ? hourlyYLabels : yLabels).map((l, i) => (
              <div key={`${l}-${i}`} style={{ fontSize: 10, color: "#c0c0d0", textAlign: "right" }}>{l}</div>
            ))}
          </div>

          {period === "today" ? (
            /* Hourly line chart — a single daily bar just fills the whole
               width, so "today" gets an hour-by-hour line instead. */
            <div style={{ flex: 1 }}>
              <div style={{ position: "relative", height: 230 }}>
                {[0, 25, 50, 75, 100].map(pct => (
                  <div key={pct} style={{ position: "absolute", bottom: `${pct}%`, left: 0, right: 0, height: 1, background: "#f0f0f8" }} />
                ))}

                <svg viewBox="0 0 1000 230" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                  <defs>
                    <linearGradient id="revenueLineFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7C3AED" stopOpacity="0.28" />
                      <stop offset="100%" stopColor="#7C3AED" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {(() => {
                    const pts = hourlyChartData.map((d, i) => {
                      const x = (i / (hourlyChartData.length - 1)) * 1000;
                      const y = 230 - Math.max(d.value, 0) / maxHourly * 230;
                      return [x, y];
                    });
                    const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
                    const area = `${line} L1000,230 L0,230 Z`;
                    return (
                      <>
                        <path d={area} fill="url(#revenueLineFill)" stroke="none" />
                        <path d={line} fill="none" stroke="#7C3AED" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
                      </>
                    );
                  })()}
                </svg>

                {/* Hover columns + tooltip + hover dot */}
                <div style={{ position: "absolute", inset: 0, display: "flex" }}>
                  {hourlyChartData.map((pt, i) => {
                    const isHovered = hoveredBar === i;
                    const bottomPct = Math.max(pt.value, 0) / maxHourly * 100;
                    return (
                      <div
                        key={i}
                        style={{ flex: 1, position: "relative", cursor: "default" }}
                        onMouseEnter={() => setHoveredBar(i)}
                        onMouseLeave={() => setHoveredBar(null)}
                      >
                        {/* Always-visible point on the line for this hour */}
                        <div style={{
                          position: "absolute", bottom: `${bottomPct}%`, left: "50%",
                          transform: "translate(-50%, 50%)",
                          width: isHovered ? 9 : 6, height: isHovered ? 9 : 6, borderRadius: "50%",
                          background: "#7C3AED", border: "2px solid #fff",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
                          transition: "width 0.15s, height 0.15s",
                        }} />
                        {isHovered && (
                          <div style={{
                            position: "absolute", bottom: `${bottomPct + 4}%`, left: "50%", transform: "translateX(-50%)",
                            background: "#1a1a2e", color: "#fff", fontSize: 11, fontWeight: 700,
                            padding: "5px 9px", borderRadius: 7, whiteSpace: "nowrap", zIndex: 10,
                            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                            pointerEvents: "none",
                          }}>
                            {fmt(pt.value)}
                            <div style={{ fontSize: 9, fontWeight: 500, color: "#a78bfa", textAlign: "center", marginTop: 1 }}>{pt.label}</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* X-axis labels — every 3rd hour to avoid crowding 24 labels */}
              <div style={{ display: "flex", paddingTop: 8 }}>
                {hourlyChartData.map((pt, i) => (
                  <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "#c0c0d0" }}>
                    {i % 3 === 0 ? pt.label : ""}
                  </div>
                ))}
              </div>
            </div>
          ) : (
          /* Bars */
          <div style={{ flex: 1 }}>
            <div style={{ position: "relative", height: 230 }}>
              {[0, 25, 50, 75, 100].map(pct => (
                <div key={pct} style={{ position: "absolute", bottom: `${pct}%`, left: 0, right: 0, height: 1, background: "#f0f0f8" }} />
              ))}
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: period === "30d" ? 4 : period === "1y" ? 7 : 10 }}>
                {chartData.map((bar, i) => {
                  const h = maxChart > 0 ? (bar.value / maxChart) * 100 : 0;
                  const isHovered = hoveredBar === i;
                  const isSelected = period === "1y" && selectedMonth === bar.monthKey;
                  const isClickable = period === "1y";
                  const barBg = isSelected
                    ? "linear-gradient(135deg, #5B21B6 0%, #350e7a 100%)"
                    : bar.isCurrentPeriod
                    ? "#7C3AED"
                    : isHovered
                    ? "#8B5CF6"
                    : "linear-gradient(180deg, #A78BFA 0%, #DDD6FE 100%)";

                  return (
                    <div
                      key={i}
                      style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", cursor: isClickable ? "pointer" : "default", position: "relative" }}
                      onClick={() => { if (isClickable) setSelectedMonth(isSelected ? null : bar.monthKey); }}
                      onMouseEnter={() => setHoveredBar(i)}
                      onMouseLeave={() => setHoveredBar(null)}
                    >
                      {/* Tooltip */}
                      {isHovered && (
                        <div style={{
                          position: "absolute", bottom: `${h + 2}%`, left: "50%", transform: "translateX(-50%)",
                          background: "#1a1a2e", color: "#fff", fontSize: 11, fontWeight: 700,
                          padding: "5px 9px", borderRadius: 7, whiteSpace: "nowrap", zIndex: 10,
                          boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                          pointerEvents: "none",
                        }}>
                          {fmt(bar.value)}
                          {isClickable && (
                            <div style={{ fontSize: 9, fontWeight: 500, color: "#8B5CF6", textAlign: "center", marginTop: 1 }}>
                              {isSelected ? "Click to close" : "Click to expand"}
                            </div>
                          )}
                        </div>
                      )}
                      <div style={{
                        width: "100%",
                        height: `${Math.max(h, 0.4)}%`,
                        background: barBg,
                        borderRadius: "5px 5px 0 0",
                        transition: "height 0.4s ease, background 0.15s",
                        outline: isSelected ? "2px solid #5B21B6" : "none",
                        outlineOffset: 1,
                      }} />
                    </div>
                  );
                })}
              </div>
            </div>
            {/* X-axis labels */}
            <div style={{ display: "flex", gap: period === "30d" ? 4 : period === "1y" ? 7 : 10, paddingTop: 8 }}>
              {chartData.map((bar, i) => {
                const isSelected = period === "1y" && selectedMonth === bar.monthKey;
                return (
                  <div
                    key={i}
                    onClick={() => { if (period === "1y") setSelectedMonth(isSelected ? null : bar.monthKey); }}
                    style={{
                      flex: 1, textAlign: "center",
                      fontSize: period === "30d" ? 9 : 11,
                      color: isSelected ? "#5B21B6" : bar.isCurrentPeriod ? "#7C3AED" : "#c0c0d0",
                      fontWeight: (isSelected || bar.isCurrentPeriod) ? 700 : 400,
                      overflow: "hidden",
                      cursor: period === "1y" ? "pointer" : "default",
                    }}
                  >
                    {bar.label}
                  </div>
                );
              })}
            </div>
          </div>
          )}
        </div>
      </div>

      {/* Payment methods + Top services */}
      <div className="dash-grid-bottom">
        {/* Payment Methods */}
        <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", padding: "26px 30px" }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 4 }}>Payment Methods</div>
          <div style={{ fontSize: 12, color: "#a0a0b8", marginBottom: 22 }}>Revenue by channel</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {methodBreakdown.map(m => (
              <div key={m.method}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: METHOD_COLORS[m.method] ?? "#888", flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{METHOD_LABELS[m.method]}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: "#a0a0b8", fontWeight: 500 }}>{m.pct.toFixed(0)}%</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{fmt(m.amount)}</span>
                  </div>
                </div>
                <div style={{ height: 6, background: "#f0f0f8", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${m.pct}%`, background: METHOD_COLORS[m.method] ?? "#888", borderRadius: 4, transition: "width 0.6s ease" }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Services */}
        <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", padding: "26px 30px" }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 4 }}>Top Services</div>
          <div style={{ fontSize: 12, color: "#a0a0b8", marginBottom: 22 }}>Most profitable this period</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {topServices.length === 0 ? (
              <div style={{ fontSize: 13, color: "#c0c0d0", textAlign: "center", padding: "24px 0" }}>No data for this period</div>
            ) : topServices.map((s, i) => {
              const pct = topServices[0].revenue > 0 ? (s.revenue / topServices[0].revenue) * 100 : 0;
              const barColors = ["#7C3AED", "#9333EA", "#A78BFA", "#d8b4fe", "#EDE9FE", "#F5F3FF"];
              return (
                <div key={s.name}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#c0c0d0", width: 16, textAlign: "center" }}>{i + 1}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{s.name}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, color: "#a0a0b8" }}>{s.count}×</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{fmt(s.revenue)}</span>
                    </div>
                  </div>
                  <div style={{ height: 5, background: "#f0f0f8", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: barColors[i] ?? "#DDD6FE", borderRadius: 3, transition: "width 0.6s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Daily / Monthly breakdown table */}
      <div className="table-scroll-wrap" style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", overflow: "hidden" }}>
        {/* Table header */}
        <div style={{ padding: "18px 24px 14px", borderBottom: "1px solid #f0f0f8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            {selectedMonth ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={() => setSelectedMonth(null)}
                  style={{ display: "flex", alignItems: "center", gap: 5, background: "#f0f0f8", border: "none", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#6b6b8a" }}
                >
                  <ChevronLeft size={14} /> All months
                </button>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#1a1a2e" }}>{selectedMonthLabel}</div>
                <span style={{ fontSize: 11, background: "#F5F3FF", border: "1px solid #EDE9FE", color: "#5B21B6", padding: "3px 10px", borderRadius: 20, fontWeight: 600 }}>
                  Daily detail
                </span>
              </div>
            ) : (
              <div style={{ fontWeight: 700, fontSize: 15, color: "#1a1a2e" }}>
                {period === "1y" ? "Daily Breakdown" : "Daily Breakdown"}
              </div>
            )}
            <div style={{ fontSize: 12, color: "#a0a0b8", marginTop: 4 }}>
              {selectedMonth
                ? `${drillRows?.length ?? 0} days · ${fmt(drillTotal)} total`
                : period === "1y" ? "Last 31 days shown — click a chart bar to drill into a month" : `Last ${Math.min(cfg.days, 31)} days`}
            </div>
          </div>

          {/* Drill mini stats */}
          {selectedMonth && drillRows && (
            <div style={{ display: "flex", gap: 20 }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#a0a0b8", fontWeight: 600 }}>APPOINTMENTS</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#3b82f6" }}>{drillCount}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#a0a0b8", fontWeight: 600 }}>AVG TICKET</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#059669" }}>{fmt(drillAvg)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#a0a0b8", fontWeight: 600 }}>TOTAL</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#7C3AED" }}>{fmt(drillTotal)}</div>
              </div>
            </div>
          )}
        </div>

        <div className="table-scroll-inner"><div className="rev-table-inner">
        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 100px 1.2fr 1.2fr", padding: "10px 24px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
          {["DATE", "DAY", "APPTS", "REVENUE", "AVG TICKET"].map(h => (
            <div key={h} style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
          ))}
        </div>

        {/* Rows */}
        {tableRows.length === 0 ? (
          <div style={{ padding: "32px 24px", textAlign: "center", fontSize: 13, color: "#c0c0d0" }}>
            No data for this period
          </div>
        ) : tableRows.map((row, i) => {
          const isToday = row.date === today;
          const avg = row.count ? row.revenue / row.count : 0;
          return (
            <div
              key={row.date}
              style={{
                display: "grid", gridTemplateColumns: "1.6fr 1fr 100px 1.2fr 1.2fr",
                padding: "11px 24px",
                borderBottom: i === tableRows.length - 1 ? "none" : "1px solid #f8f8fc",
                alignItems: "center",
                background: isToday ? "#fdf8ff" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: isToday ? 700 : 500, color: isToday ? "#7C3AED" : "#1a1a2e" }}>{row.date}</span>
                {isToday && <span style={{ fontSize: 10, background: "linear-gradient(135deg, #5B21B6, #9333EA)", color: "#fff", padding: "2px 8px", borderRadius: 20, fontWeight: 700 }}>Today</span>}
              </div>
              <div style={{ fontSize: 13, color: "#6b6b8a" }}>{row.dow}</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e" }}>{row.count}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: row.revenue > 0 ? "#7C3AED" : "#c0c0d0" }}>{fmt(row.revenue)}</div>
              <div style={{ fontSize: 13, color: "#6b6b8a" }}>{avg ? fmt(avg) : "—"}</div>
            </div>
          );
        })}

        {/* Footer totals */}
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 100px 1.2fr 1.2fr", padding: "13px 24px", background: "#fafafa", borderTop: "1px solid #f0f0f8" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>
            {selectedMonth ? selectedMonthLabel : `Total (${cfg.label})`}
          </div>
          <div />
          <div style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{tableCount}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{fmt(tableTotal)}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#6b6b8a" }}>{tableAvg ? fmt(tableAvg) : "—"}</div>
        </div>
        </div></div>{/* /rev-table-inner /table-scroll-inner */}
      </div>{/* /table-scroll-wrap */}
      </>
      )}{/* /tab === "overview" */}

      {tab === "net" && (
        <NetProfitView
          period={cfg.label} rangeStart={rangeStart} filterEnd={filterEnd}
          totalRevenue={totalRevenue} totalExpenses={totalExpenses} netProfit={netProfit}
          netMarginPct={netMarginPct} expenseByCategory={expenseByCategory}
          revenueByChannel={revenueByChannel} expensesByChannel={expensesByChannel}
          netProfitByChannel={netProfitByChannel}
        />
      )}

      {tab === "ledger" && (
        <LedgerView
          rangeStart={rangeStart} filterEnd={filterEnd} today={today} outstandingInvoices={outstandingInvoices}
          appointments={appointments} posLinkedAppointmentIds={posLinkedAppointmentIds}
          posInvoices={posInvoices} manualIncome={manualIncome} expenses={expenses}
        />
      )}

      </div>{/* /desktop-only */}
    </div>
  );
}

// ── Net Profit tab ───────────────────────────────────────────────────────────
function NetProfitView({
  period, rangeStart, filterEnd, totalRevenue, totalExpenses, netProfit, netMarginPct, expenseByCategory,
  revenueByChannel, expensesByChannel, netProfitByChannel,
}: {
  period: string; rangeStart: string; filterEnd: string;
  totalRevenue: number; totalExpenses: number; netProfit: number; netMarginPct: number;
  expenseByCategory: { category: string; amount: number; pct: number }[];
  revenueByChannel: { cash: number; online: number };
  expensesByChannel: { cash: number; online: number };
  netProfitByChannel: { cash: number; online: number };
}) {
  const channels = [
    { key: "cash",   label: "Cash",   color: "#059669", revenue: revenueByChannel.cash,   expenses: expensesByChannel.cash,   net: netProfitByChannel.cash   },
    { key: "online", label: "Online", color: "#2563eb", revenue: revenueByChannel.online, expenses: expensesByChannel.online, net: netProfitByChannel.online },
  ];
  return (
    <>
      <div className="stats-grid-3">
        {[
          { label: "Total Revenue",  value: fmt(totalRevenue),  icon: TrendingUp,   color: "var(--accent)", bg: "rgba(124, 58, 237, 0.08)" },
          { label: "Total Expenses", value: fmt(totalExpenses), icon: TrendingDown, color: "#dc2626", bg: "#fef2f2" },
          { label: "Net Profit",     value: fmt(netProfit),   icon: Wallet,       color: netProfit >= 0 ? "#059669" : "#dc2626", bg: netProfit >= 0 ? "#f0fdf4" : "#fef2f2" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.02)", flex: 1 }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color }}>
              <Icon size={24} color={color} />
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="dash-grid-bottom">
        {/* P&L summary */}
        <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", padding: "26px 30px" }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 4 }}>Net Profit Summary</div>
          <div style={{ fontSize: 12, color: "#a0a0b8", marginBottom: 22 }}>{rangeStart} → {filterEnd} · {period}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#6b6b8a" }}>Revenue</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1a1a2e" }}>{fmt(totalRevenue)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#6b6b8a" }}>− Expenses (all categories)</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#dc2626" }}>−{fmt(totalExpenses)}</span>
            </div>
            <div style={{ height: 1, background: "#f0f0f8" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1a1a2e" }}>= Net Profit</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: netProfit >= 0 ? "#059669" : "#dc2626" }}>{fmt(netProfit)}</span>
            </div>
            <div style={{ fontSize: 12, color: "#a0a0b8" }}>{netMarginPct.toFixed(1)}% net margin</div>

            <div style={{ height: 1, background: "#f0f0f8", marginTop: 8 }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Net profit by payment channel
            </div>
            {channels.map(c => (
              <div key={c.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: c.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{c.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#a0a0b8", marginTop: 3, marginLeft: 19 }}>
                    {fmt(c.revenue)} revenue − {fmt(c.expenses)} expenses
                  </div>
                </div>
                <span style={{ fontSize: 15, fontWeight: 800, color: c.net >= 0 ? c.color : "#dc2626", whiteSpace: "nowrap" }}>
                  {fmt(c.net)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Expenses by category */}
        <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", padding: "26px 30px" }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 4 }}>Expenses by Category</div>
          <div style={{ fontSize: 12, color: "#a0a0b8", marginBottom: 22 }}>Paid expenses this period</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {expenseByCategory.length === 0 ? (
              <div style={{ fontSize: 13, color: "#c0c0d0", textAlign: "center", padding: "24px 0" }}>
                No expenses logged for this period — add them on the Cash Flow page.
              </div>
            ) : expenseByCategory.map(e => (
              <div key={e.category}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: EXPENSE_COLORS[e.category] ?? "#888", flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{EXPENSE_LABELS[e.category] ?? e.category}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: "#a0a0b8", fontWeight: 500 }}>{e.pct.toFixed(0)}%</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#dc2626" }}>{fmt(e.amount)}</span>
                  </div>
                </div>
                <div style={{ height: 6, background: "#f0f0f8", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${e.pct}%`, background: EXPENSE_COLORS[e.category] ?? "#888", borderRadius: 4, transition: "width 0.6s ease" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Ledger tab (day book, account books, money owed) ─────────────────────────
// Every row belongs to the account the money moved through (its payment method).
// Like Cash Flow, a missing method means cash: walk-in appointments without a POS
// checkout and imported income carry no method at all.
type LedgerRow = {
  id: string; date: string; sortKey: string; description: string; detail: string;
  account: string; category: string; moneyIn: number; moneyOut: number;
};
type OwedRow = { id: string; name: string; detail: string; date: string; amount: number };

const ACCOUNT_ORDER = Object.keys(METHOD_LABELS);
const accountLabel = (key: string) => METHOD_LABELS[key] ?? key;
// EXPENSE_LABELS leaves out refunds (they aren't charted as spending), but the ledger lists them.
const expenseLabel = (key: string) => EXPENSE_LABELS[key] ?? (key === "refunds" ? "Refunds" : key);

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function daysOld(date: string, today: string) {
  if (!today) return 0;
  return Math.max(0, Math.round((new Date(`${today}T12:00:00`).getTime() - new Date(`${date}T12:00:00`).getTime()) / 86_400_000));
}

function ageStyle(days: number) {
  if (days > 60) return { color: "#b91c1c", background: "#fef2f2" };
  if (days > 30) return { color: "#c2410c", background: "#fff7ed" };
  return { color: "#6b6b8a", background: "#f4f4f8" };
}

function OwedCard({ title, sub, rows, today, color }: { title: string; sub: string; rows: OwedRow[]; today: string; color: string }) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const over30 = rows.filter(r => daysOld(r.date, today) > 30).reduce((s, r) => s + r.amount, 0);
  return (
    <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #f0f0f5" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>{title}</div>
          <div style={{ fontSize: 20, fontWeight: 850, color }}>{fmt(total)}</div>
        </div>
        <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>
          {sub} · {rows.length} open{over30 > 0 && <span style={{ color: "#c2410c", fontWeight: 700 }}> · {fmt(over30)} over 30 days</span>}
        </div>
      </div>
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {rows.length === 0 ? (
          <div style={{ padding: "24px 20px", textAlign: "center", fontSize: 12, color: "#9898b0" }}>Nothing outstanding</div>
        ) : rows.map(r => {
          const days = daysOld(r.date, today);
          return (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 20px", borderBottom: "1px solid #f8f8fc" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                <div style={{ fontSize: 11, color: "#9898b0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.detail} · {r.date}</div>
              </div>
              <span style={{ ...ageStyle(days), fontSize: 10, fontWeight: 750, padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
                {days === 0 ? "Today" : `${days}d old`}
              </span>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", minWidth: 80, textAlign: "right" }}>{fmt(r.amount)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LedgerView({ rangeStart, filterEnd, today, appointments, posLinkedAppointmentIds, posInvoices, outstandingInvoices, manualIncome, expenses }: {
  rangeStart: string; filterEnd: string; today: string;
  appointments: Appointment[]; posLinkedAppointmentIds: Set<string>;
  posInvoices: ReturnType<typeof getSalonInvoices>; outstandingInvoices: ReturnType<typeof getSalonInvoices>;
  manualIncome: ManualCashIncome[]; expenses: Expense[];
}) {
  const [account, setAccount]   = useState("all");
  const [flow, setFlow]         = useState<"all" | "in" | "out">("all");
  const [category, setCategory] = useState("all");
  const [search, setSearch]     = useState("");

  // Same sources and rules as the Overview and Net Profit tabs: completed
  // appointments without a POS checkout, paid POS invoices, imported income,
  // and every expense that isn't still pending.
  const allRows = useMemo((): LedgerRow[] => [
    ...appointments
      .filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id))
      .map(a => ({ id: a.id, date: a.date, sortKey: a.date + "T" + (a.startTime || "00:00"),
        description: a.clientName || "Appointment", detail: a.serviceNames.join(", ") || "Appointment",
        account: "cash", category: "Appointments", moneyIn: a.totalAmount, moneyOut: 0 })),
    ...posInvoices.map(inv => ({ id: inv.id, date: inv.date, sortKey: inv.date + "T" + inv.createdAt.slice(11, 16),
      description: inv.clientName || "POS Sale",
      detail: `POS ${inv.number} · ${inv.paymentMethod ? paymentMethodLabel(inv, METHOD_LABELS) : "Cash"}`,
      account: inv.paymentMethod || "cash", category: "POS Sales", moneyIn: revenueAmount(inv), moneyOut: 0 })),
    ...manualIncome.map(entry => ({ id: entry.id, date: entry.date, sortKey: entry.date + "T" + entry.createdAt.slice(11, 16),
      description: entry.description || "Income", detail: entry.category || "Imported income",
      account: "cash", category: entry.category || "Imported income", moneyIn: entry.amount, moneyOut: 0 })),
    ...expenses
      .filter(e => e.paymentStatus !== "pending")
      .map(e => ({ id: e.id, date: e.date, sortKey: e.date + "T" + e.createdAt.slice(11, 16),
        description: e.description || expenseLabel(e.category),
        detail: `${expenseLabel(e.category)} · ${accountLabel(e.paymentMethod || "cash")}`,
        account: e.paymentMethod || "cash", category: expenseLabel(e.category), moneyIn: 0, moneyOut: e.amount })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey)),
  [appointments, posLinkedAppointmentIds, posInvoices, manualIncome, expenses]);

  // Balance of every account as at the end of the period.
  const accounts = useMemo(() => {
    const balances = new Map<string, number>();
    for (const row of allRows) {
      if (row.date > filterEnd) break;
      balances.set(row.account, (balances.get(row.account) ?? 0) + row.moneyIn - row.moneyOut);
    }
    const rank = (key: string) => (ACCOUNT_ORDER.indexOf(key) + 1) || 99;
    return [...balances].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [allRows, filterEnd]);

  const categories = useMemo(() => [...new Set(allRows.map(r => r.category))].sort(), [allRows]);

  // The selected account's book: its own opening balance and running balance.
  const { opening, rows, totalIn, totalOut } = useMemo(() => {
    let balance = 0, totalIn = 0, totalOut = 0;
    const rows: (LedgerRow & { balance: number })[] = [];
    for (const row of allRows) {
      if (account !== "all" && row.account !== account) continue;
      if (row.date > filterEnd) break;
      if (row.date < rangeStart) { balance += row.moneyIn - row.moneyOut; continue; }
      totalIn += row.moneyIn; totalOut += row.moneyOut;
      rows.push({ ...row, balance: 0 });
    }
    const opening = balance;
    rows.forEach(row => { balance += row.moneyIn - row.moneyOut; row.balance = balance; });
    return { opening, rows, totalIn, totalOut };
  }, [allRows, account, rangeStart, filterEnd]);
  const closing = opening + totalIn - totalOut;

  // Filters only hide rows — each row keeps its place in the book's running balance.
  const query = search.trim().toLowerCase();
  const shown = rows.filter(r =>
    (flow === "all" || (flow === "in" ? r.moneyIn > 0 : r.moneyOut > 0)) &&
    (category === "all" || r.category === category) &&
    (!query || `${r.description} ${r.detail}`.toLowerCase().includes(query)));
  const isFiltered = shown.length !== rows.length;
  const shownIn  = shown.reduce((s, r) => s + r.moneyIn, 0);
  const shownOut = shown.reduce((s, r) => s + r.moneyOut, 0);

  // Money still to come in (unpaid / part-paid bills) and to go out (pending expenses), as of today.
  const owedToMe = useMemo((): OwedRow[] => outstandingInvoices
    .map(inv => ({ id: inv.id, name: inv.clientName || "Walk-in client", date: inv.date,
      detail: `${inv.number}${inv.status === "partial" ? " · part-paid" : ""}${inv.clientPhone ? ` · ${inv.clientPhone}` : ""}`,
      amount: inv.status === "partial" ? balanceDue(inv) : inv.total }))
    .filter(r => r.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date)),
  [outstandingInvoices]);
  const iOwe = useMemo((): OwedRow[] => expenses
    .filter(e => e.paymentStatus === "pending")
    .map(e => ({ id: e.id, name: e.description || expenseLabel(e.category), date: e.date,
      detail: expenseLabel(e.category), amount: e.amount }))
    .sort((a, b) => a.date.localeCompare(b.date)),
  [expenses]);

  const bookName = account === "all" ? "All accounts" : `${accountLabel(account)} book`;
  const filterNote = [
    flow !== "all" && (flow === "in" ? "Money in only" : "Money out only"),
    category !== "all" && category,
    query && `Search “${search.trim()}”`,
  ].filter(Boolean).join(" · ");

  const signed = (n: number) => (n < 0 ? "−" : "") + fmt(Math.abs(n));

  async function exportLedger() {
    const XLSX = await import("xlsx");
    const sheetRows = [
      { Date: rangeStart, Description: "Opening balance", Details: "", Account: "", "Money In": "", "Money Out": "", Balance: opening },
      ...shown.map(row => ({ Date: row.date, Description: row.description, Details: row.detail, Account: accountLabel(row.account),
        "Money In": row.moneyIn || "", "Money Out": row.moneyOut || "", Balance: row.balance })),
      ...(isFiltered ? [{ Date: "", Description: "Total of shown entries", Details: "", Account: "", "Money In": shownIn, "Money Out": shownOut, Balance: "" }] : []),
      { Date: filterEnd, Description: "Closing balance", Details: "", Account: "", "Money In": totalIn, "Money Out": totalOut, Balance: closing },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), "Ledger");
    XLSX.writeFile(wb, `ledger-${account}-${rangeStart}-to-${filterEnd}.xlsx`);
  }

  function printStatement() {
    const e = escapeHtml;
    const money = (n: number) => (n ? fmt(n) : "");
    const now = new Date();
    const body = shown.map(r => `<tr><td>${r.date}</td><td><b>${e(r.description)}</b><div class="muted">${e(r.detail)}</div></td>
      <td class="num in">${money(r.moneyIn)}</td><td class="num out">${money(r.moneyOut)}</td><td class="num">${signed(r.balance)}</td></tr>`).join("");
    printHtml(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${e(bookName)} ${rangeStart} to ${filterEnd}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Montserrat', sans-serif; color: #1a1a2e; font-size: 12px; }
  .page { max-width: 820px; margin: 0 auto; padding: 40px 48px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; margin-bottom: 24px; border-bottom: 2px solid #f0f0f8; }
  .logo-img { position:relative; overflow:hidden; width:104px; height:51px; }
  .logo-img img { position:absolute; width:117.52%; height:241.61%; max-width:none; left:-9.14%; top:-66%; }
  .title { font-size: 16px; font-weight: 800; color: #7C3AED; text-align: right; }
  .sub { font-size: 11px; color: #6b6b8a; margin-top: 3px; text-align: right; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }
  .stat { background: #F5F3FF; border: 1px solid #EDE9FE; border-radius: 10px; padding: 12px; }
  .stat-l { font-size: 9px; font-weight: 700; color: #a0a0b8; letter-spacing: .06em; text-transform: uppercase; }
  .stat-v { font-size: 16px; font-weight: 800; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 9px; font-weight: 700; color: #a0a0b8; letter-spacing: .07em; text-transform: uppercase; padding: 8px 10px; text-align: left; background: #F5F3FF; }
  td { padding: 8px 10px; border-bottom: 1px solid #f3f3f8; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; font-weight: 700; }
  .in { color: #059669; } .out { color: #dc2626; }
  .muted { color: #a0a0b8; font-size: 10px; margin-top: 2px; }
  .edge td { background: #faf9fd; font-weight: 800; }
  .foot { margin-top: 28px; padding-top: 14px; border-top: 1px solid #f0f0f8; font-size: 10px; color: #c0c0d0; display: flex; justify-content: space-between; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page { padding: 24px 32px; } }
</style></head><body><div class="page">
  <div class="header">
    <div class="logo-img"><img src="${window.location.origin}/salon-central-logo.png" alt="Salon Central" /></div>
    <div><div class="title">Ledger Statement — ${e(bookName)}</div><div class="sub">${rangeStart} to ${filterEnd}</div>
    ${filterNote ? `<div class="sub">${e(filterNote)}</div>` : ""}</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-l">Opening balance</div><div class="stat-v">${signed(opening)}</div></div>
    <div class="stat"><div class="stat-l">Money in</div><div class="stat-v in">${fmt(totalIn)}</div></div>
    <div class="stat"><div class="stat-l">Money out</div><div class="stat-v out">${fmt(totalOut)}</div></div>
    <div class="stat"><div class="stat-l">Closing balance</div><div class="stat-v">${signed(closing)}</div></div>
  </div>
  <table><thead><tr><th>Date</th><th>Description</th><th class="num">Money in</th><th class="num">Money out</th><th class="num">Balance</th></tr></thead><tbody>
    <tr class="edge"><td>${rangeStart}</td><td>Opening balance</td><td></td><td></td><td class="num">${signed(opening)}</td></tr>
    ${body || `<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">No entries</td></tr>`}
    ${isFiltered ? `<tr class="edge"><td></td><td>Total of shown entries</td><td class="num in">${fmt(shownIn)}</td><td class="num out">${fmt(shownOut)}</td><td></td></tr>` : ""}
    <tr class="edge"><td>${filterEnd}</td><td>Closing balance</td><td class="num in">${fmt(totalIn)}</td><td class="num out">${fmt(totalOut)}</td><td class="num">${signed(closing)}</td></tr>
  </tbody></table>
  <div class="foot"><span>Generated ${now.toLocaleDateString("en-PK", { year: "numeric", month: "long", day: "numeric" })} · Salon Central</span><span>Confidential</span></div>
</div></body></html>`);
  }

  const cols = "90px 1.4fr 1.2fr 110px 110px 120px";
  const cell = { fontSize: 12, color: "#6b6b8a" } as const;
  const control = { padding: "7px 10px", borderRadius: 10, border: "1px solid #e3e0eb", background: "#fff", fontSize: 12, color: "#1a1a2e" } as const;
  const button = { ...control, display: "flex", alignItems: "center", gap: 6, color: "var(--accent)", fontWeight: 750, cursor: "pointer" } as const;
  return (
    <>
      {/* Account books — click one to see only its money */}
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 2 }}>
        {[["all", accounts.reduce((s, [, b]) => s + b, 0)] as [string, number], ...accounts].map(([key, balance]) => {
          const active = account === key;
          return (
            <button key={key} type="button" onClick={() => setAccount(key)} aria-pressed={active} style={{
              flex: "0 0 auto", minWidth: 150, textAlign: "left", cursor: "pointer", padding: "12px 16px", borderRadius: 14,
              border: active ? "2px solid var(--accent)" : "1px solid rgba(226,223,235,0.9)",
              background: active ? "#F5F3FF" : "#fff",
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 6 }}>
                {key !== "all" && <span style={{ width: 8, height: 8, borderRadius: "50%", background: METHOD_COLORS[key] ?? "#9898b0" }} />}
                {key === "all" ? "All accounts" : accountLabel(key)}
              </div>
              <div style={{ fontSize: 18, fontWeight: 850, color: balance < 0 ? "#dc2626" : "#1a1a2e", marginTop: 4 }}>{signed(balance)}</div>
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        {[
          { label: "Opening Balance", value: signed(opening), color: "#6b6b8a" },
          { label: "Money In",  value: fmt(totalIn),  color: "#059669" },
          { label: "Money Out", value: fmt(totalOut), color: "#dc2626" },
          { label: "Closing Balance", value: signed(closing), color: closing >= 0 ? "var(--accent)" : "#dc2626" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "16px 20px" }}>
            <div style={{ fontSize: 22, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        <OwedCard title="Owed to me" sub="Unpaid & part-paid client bills" rows={owedToMe} today={today} color="#059669" />
        <OwedCard title="I owe" sub="Pending expense bills" rows={iOwe} today={today} color="#dc2626" />
      </div>

      <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #f0f0f5", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>
            {account === "all" ? "Day Book" : bookName}
            <span style={{ fontSize: 12, fontWeight: 600, color: "#9898b0", marginLeft: 6 }}>
              {rangeStart} → {filterEnd} · {isFiltered ? `${shown.length} of ${rows.length}` : rows.length} entries
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label style={{ ...control, display: "flex", alignItems: "center", gap: 6 }}>
              <Search size={13} color="#9898b0" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or detail"
                aria-label="Search ledger" style={{ border: "none", outline: "none", fontSize: 12, width: 150, background: "transparent" }} />
            </label>
            <select value={flow} onChange={e => setFlow(e.target.value as typeof flow)} aria-label="Money in or out" style={control}>
              <option value="all">In &amp; out</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </select>
            <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category" style={control}>
              <option value="all">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="button" onClick={exportLedger} style={button}><Download size={14} /> Excel</button>
            <button type="button" onClick={printStatement} style={button}><Printer size={14} /> PDF</button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 760 }}>
            <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 20px", background: "#faf9fd", borderBottom: "1px solid #f0f0f5" }}>
              {["DATE", "DESCRIPTION", "DETAILS", "MONEY IN", "MONEY OUT", "BALANCE"].map((h, i) => (
                <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em", textAlign: i >= 3 ? "right" : "left" }}>{h}</div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 20px", borderBottom: "1px solid #f8f8fc", background: "#fcfcfe" }}>
              <div style={cell}>{rangeStart}</div>
              <div style={{ ...cell, fontWeight: 750, color: "#1a1a2e" }}>Opening balance</div>
              <div /><div /><div />
              <div style={{ ...cell, fontWeight: 800, color: "#1a1a2e", textAlign: "right" }}>{signed(opening)}</div>
            </div>
            {shown.length === 0 ? (
              <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
                {rows.length === 0 ? "No entries in this period" : "No entries match these filters"}
              </div>
            ) : shown.map(row => (
              <div key={row.id} style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 20px", borderBottom: "1px solid #f8f8fc", alignItems: "center" }}>
                <div style={cell}>{row.date}</div>
                <div style={{ ...cell, fontWeight: 700, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.description}>{row.description}</div>
                <div style={{ ...cell, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.detail}>{row.detail}</div>
                <div style={{ ...cell, fontWeight: 750, color: "#059669", textAlign: "right" }}>{row.moneyIn ? fmt(row.moneyIn) : ""}</div>
                <div style={{ ...cell, fontWeight: 750, color: "#dc2626", textAlign: "right" }}>{row.moneyOut ? fmt(row.moneyOut) : ""}</div>
                <div style={{ ...cell, fontWeight: 800, color: row.balance >= 0 ? "#1a1a2e" : "#dc2626", textAlign: "right" }}>{signed(row.balance)}</div>
              </div>
            ))}
            {isFiltered && (
              <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 20px", borderBottom: "1px solid #f0f0f5" }}>
                <div />
                <div style={{ ...cell, fontWeight: 750, color: "#1a1a2e" }}>Total of shown entries</div>
                <div />
                <div style={{ ...cell, fontWeight: 800, color: "#059669", textAlign: "right" }}>{fmt(shownIn)}</div>
                <div style={{ ...cell, fontWeight: 800, color: "#dc2626", textAlign: "right" }}>{fmt(shownOut)}</div>
                <div />
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: cols, padding: "12px 20px", background: "#faf9fd" }}>
              <div style={cell}>{filterEnd}</div>
              <div style={{ ...cell, fontWeight: 800, color: "#1a1a2e" }}>Closing balance</div>
              <div />
              <div style={{ ...cell, fontWeight: 800, color: "#059669", textAlign: "right" }}>{fmt(totalIn)}</div>
              <div style={{ ...cell, fontWeight: 800, color: "#dc2626", textAlign: "right" }}>{fmt(totalOut)}</div>
              <div style={{ ...cell, fontWeight: 850, color: closing >= 0 ? "var(--accent)" : "#dc2626", textAlign: "right" }}>{signed(closing)}</div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#b0b0c8", lineHeight: 1.6 }}>
        Each account&rsquo;s balance is everything in minus everything out through it up to {filterEnd || "today"}; sales and
        imported income with no payment method count as cash. Pending expenses, unpaid invoices and petty cash top-ups stay
        out of the books until they&rsquo;re paid — they show under Owed to me / I owe instead.
      </div>
    </>
  );
}
