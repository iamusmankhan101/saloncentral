"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { getStoredAppointments } from "@/lib/storage";
import { getSalonInvoices } from "@/lib/salon-invoices";
import { getExpenses, saveExpenses, addExpense, updateExpense, type Expense, type ExpenseCategory } from "@/lib/expenses";
import { getManualCashIncome, saveManualCashIncome, type ManualCashIncome } from "@/lib/cash-flow-income";
import type { Appointment } from "@/lib/types";
import MobilePageHeader from "@/components/mobile-page-header";
import PageTitle from "@/components/page-title";
import { fmtCurrency as fmt } from "@/lib/format";
import { syncFromDB } from "@/lib/turso-sync";
import { getSectionOptions, getActiveSection } from "@/lib/sections";
import {
  Plus, Trash2, TrendingUp, TrendingDown,
  Wallet, X, Download, Pencil, Check, CalendarCheck, ShoppingBag, Upload, FileSpreadsheet,
  Banknote, CreditCard, Lock, AlertCircle, RefreshCw,
} from "lucide-react";

type Period = "today" | "7d" | "30d" | "1y" | "custom";

const PERIODS: { key: Period; label: string; days: number }[] = [
  { key: "today",  label: "Today",   days: 1   },
  { key: "7d",     label: "7 Days",  days: 7   },
  { key: "30d",    label: "Month",   days: 30  },
  { key: "1y",     label: "1 Year",  days: 365 },
  { key: "custom", label: "Custom",  days: 0   },
];

export const EXPENSE_CATEGORIES: { key: ExpenseCategory; label: string; color: string }[] = [
  { key: "rent",          label: "Rent",                color: "#ef4444" },
  { key: "water_bill",    label: "Water Bill",          color: "#0ea5e9" },
  { key: "electricity_bill", label: "Electricity Bill", color: "#f59e0b" },
  { key: "committee",     label: "Committee",           color: "#14b8a6" },
  { key: "salaries",      label: "Staff Salaries",      color: "#f97316" },
  { key: "utilities",     label: "Utilities",           color: "#eab308" },
  { key: "supplies",      label: "Products & Supplies", color: "#22c55e" },
  { key: "equipment",     label: "Equipment",           color: "#3b82f6" },
  { key: "marketing",     label: "Marketing",           color: "#8b5cf6" },
  { key: "food",          label: "Food & Tea",          color: "#ec4899" },
  { key: "miscellaneous", label: "Miscellaneous",       color: "#6b7280" },
];

const PAYMENT_METHODS = ["cash", "jazzcash", "easypaisa", "bank", "card"];
const PAYMENT_LABELS: Record<string, string> = {
  cash: "Cash", jazzcash: "JazzCash", easypaisa: "EasyPaisa",
  bank: "Bank Transfer", card: "Card",
};
const PAYMENT_COLORS: Record<string, string> = {
  cash: "#22c55e", jazzcash: "#f97316", easypaisa: "#10b981",
  bank: "#3b82f6", card: "#6366f1",
};
const PAYMENT_STATUSES = [
  { key: "paid", label: "Paid" },
  { key: "pending", label: "Pending / unpaid" },
] as const;
const MAX_BILL_IMAGE_BYTES = 2 * 1024 * 1024;
const VIEWABLE_BILL_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function expensePaymentStatus(expense: Expense): "paid" | "pending" {
  return expense.paymentStatus === "pending" ? "pending" : "paid";
}

function toDateStr(d: Date) { return d.toLocaleDateString("en-CA"); }

function getDaysArr(count: number, end: string): string[] {
  const arr: string[] = [];
  const e = new Date(end + "T12:00:00");
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(e); d.setDate(d.getDate() - i);
    arr.push(toDateStr(d));
  }
  return arr;
}

function getDaysInRange(start: string, end: string): string[] {
  const arr: string[] = [];
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  let limit = 366;
  while (s <= e && limit-- > 0) { arr.push(toDateStr(s)); s.setDate(s.getDate() + 1); }
  return arr;
}

function monthlyBarsRange(start: string, end: string): { label: string; key: string }[] {
  const arr: { label: string; key: string }[] = [];
  const s = new Date(start + "T12:00:00"); s.setDate(1);
  const e = new Date(end + "T12:00:00"); e.setDate(1);
  let limit = 36;
  while (s <= e && limit-- > 0) {
    arr.push({ label: s.toLocaleDateString("en-PK", { month: "short" }), key: toDateStr(s).substring(0, 7) });
    s.setMonth(s.getMonth() + 1);
  }
  return arr;
}

const EMPTY_FORM = {
  date: "",
  category: "miscellaneous" as ExpenseCategory,
  description: "",
  amount: "",
  paymentMethod: "cash",
  paymentStatus: "paid" as "paid" | "pending",
  billImageDataUrl: undefined as string | undefined,
  billImageName: undefined as string | undefined,
  notes: "",
  section: "",
};

export default function CashFlowPage() {
  const [period, setPeriod]           = useState<Period>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd]     = useState("");
  const [expenses, setExpenses]       = useState<Expense[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [posInvoices, setPosInvoices] = useState<ReturnType<typeof getSalonInvoices>>([]);
  const [posInvoiceAppointmentIds, setPosInvoiceAppointmentIds] = useState<string[]>([]);
  const [manualIncome, setManualIncome] = useState<ManualCashIncome[]>([]);
  const [today, setToday]             = useState("");
  const [showForm, setShowForm]       = useState(false);
  const [editId, setEditId]           = useState<string | null>(null);
  const [form, setForm]               = useState({ ...EMPTY_FORM });
  const [formError, setFormError]     = useState("");
  const [hoveredBar, setHoveredBar]   = useState<number | null>(null);
  const [fileMessage, setFileMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; title: string } | null>(null);
  const [expenseSyncFailed, setExpenseSyncFailed] = useState(false);
  const [retryingExpenseSync, setRetryingExpenseSync] = useState(false);
  const importInputRef                 = useRef<HTMLInputElement>(null);
  const expenseFormRef                 = useRef<HTMLDivElement>(null);

  // Cash flow visibility by dashboard section: only "All Sections" sees
  // everything combined — Men's and Women's are each restricted to their own
  // income and expenses, symmetrically. Matches Revenue's rule.
  const activeSection = getActiveSection();
  const cashFlowScoped = activeSection !== "all";

  useEffect(() => {
    let cancelled = false;
    syncFromDB().finally(() => {
      if (cancelled) return;
      const t = toDateStr(new Date());
      setToday(t);
      setCustomEnd(t);
      setCustomStart(t);
      setForm(f => ({ ...f, date: t }));
      // Untagged expenses are shared overhead that can't be attributed to one
      // section, so a restricted view excludes them — same for manual income,
      // which has no section field to filter by at all.
      setExpenses(getExpenses().filter(e => !cashFlowScoped || e.section === activeSection));
      setAppointments(getStoredAppointments().filter(a => !cashFlowScoped || a.section === activeSection));
      // Keep every POS-linked appointment id separately, including unpaid
      // invoices, so an appointment checked out as "unpaid" doesn't leak into
      // the completed-appointment income fallback below just because its
      // invoice was excluded from the paid-only posInvoices list.
      const allPosInvoices = getSalonInvoices()
        .filter(inv => !inv.source || inv.source === "pos")
        .filter(inv => !cashFlowScoped || inv.section === activeSection);
      setPosInvoiceAppointmentIds(allPosInvoices.map(inv => inv.appointmentId).filter((id): id is string => !!id));
      setPosInvoices(allPosInvoices.filter(inv => inv.status === "paid"));
      setManualIncome(cashFlowScoped ? [] : getManualCashIncome());
    });
    return () => { cancelled = true; };
  }, [cashFlowScoped, activeSection]);

  useEffect(() => {
    if (!showForm || !editId) return;
    expenseFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [showForm, editId]);

  const cfg = PERIODS.find(p => p.key === period)!;

  const filterEnd = period === "custom" ? customEnd : today;

  const rangeStart = useMemo(() => {
    if (!today) return "";
    if (period === "custom") return customStart;
    if (period === "today") return today;
    const d = new Date(today); d.setDate(d.getDate() - (cfg.days - 1));
    return toDateStr(d);
  }, [period, today, customStart, cfg.days]);

  const periodExpenses = useMemo(() =>
    expenses
      .filter(e => e.date >= rangeStart && e.date <= filterEnd)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [expenses, rangeStart, filterEnd]);

  const posLinkedAppointmentIds = useMemo(() =>
    new Set(posInvoiceAppointmentIds),
    [posInvoiceAppointmentIds]);

  const periodIncome = useMemo(() => {
    if (period === "custom" && (!customStart || !customEnd || customStart > customEnd)) return 0;
    const appts = appointments.filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date >= rangeStart && a.date <= filterEnd);
    const pos   = posInvoices.filter(inv => inv.date >= rangeStart && inv.date <= filterEnd);
    const manual = manualIncome.filter(entry => entry.date >= rangeStart && entry.date <= filterEnd);
    return appts.reduce((s, a) => s + a.totalAmount, 0) + pos.reduce((s, inv) => s + inv.total, 0) + manual.reduce((s, entry) => s + entry.amount, 0);
  }, [appointments, posInvoices, posLinkedAppointmentIds, manualIncome, rangeStart, filterEnd, period, customStart, customEnd]);

  const periodIncomeRows = useMemo(() => {
    if (period === "custom" && (!customStart || !customEnd || customStart > customEnd)) return [];
    const apptRows = appointments
      .filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date >= rangeStart && a.date <= filterEnd)
      .map(a => ({
        id: a.id,
        date: a.date,
        client: a.clientName,
        description: a.serviceNames.join(", ") || "Appointment",
        source: "appointment" as const,
        paymentMethod: "",
        amount: a.totalAmount,
        sortKey: a.date + "T" + (a.startTime || "00:00"),
      }));
    const posRows = posInvoices
      .filter(inv => inv.date >= rangeStart && inv.date <= filterEnd)
      .map(inv => ({
        id: inv.id,
        date: inv.date,
        client: inv.clientName,
        description: inv.items.map(it => it.description).join(", ") || "POS Sale",
        source: "pos" as const,
        paymentMethod: inv.paymentMethod,
        amount: inv.total,
        sortKey: inv.date + "T" + inv.createdAt.slice(11, 16),
      }));
    const manualRows = manualIncome
      .filter(entry => entry.date >= rangeStart && entry.date <= filterEnd)
      .map(entry => ({
        id: entry.id,
        date: entry.date,
        client: entry.category || "Imported Income",
        description: entry.description,
        source: "manual" as const,
        paymentMethod: "",
        amount: entry.amount,
        sortKey: entry.date + "T" + entry.createdAt.slice(11, 16),
      }));
    return [...apptRows, ...posRows, ...manualRows].sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [appointments, posInvoices, posLinkedAppointmentIds, manualIncome, rangeStart, filterEnd, period, customStart, customEnd]);

  // Income split by how it was actually collected. Appointments completed without a
  // POS checkout and manual/imported entries carry no payment method — bucketed as
  // cash, the same "untracked → cash" convention the Excel export already uses.
  const periodIncomeSplit = useMemo(() => {
    if (period === "custom" && (!customStart || !customEnd || customStart > customEnd)) return { cash: 0, online: 0 };
    const appts = appointments.filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date >= rangeStart && a.date <= filterEnd);
    const pos    = posInvoices.filter(inv => inv.date >= rangeStart && inv.date <= filterEnd);
    const manual = manualIncome.filter(entry => entry.date >= rangeStart && entry.date <= filterEnd);
    let cash = appts.reduce((s, a) => s + a.totalAmount, 0) + manual.reduce((s, e) => s + e.amount, 0);
    let online = 0;
    pos.forEach(inv => {
      if ((inv.paymentMethod || "cash") === "cash") cash += inv.total;
      else online += inv.total;
    });
    return { cash, online };
  }, [appointments, posInvoices, posLinkedAppointmentIds, manualIncome, rangeStart, filterEnd, period, customStart, customEnd]);

  const paidPeriodExpenses = useMemo(
    () => periodExpenses.filter(expense => expensePaymentStatus(expense) === "paid"),
    [periodExpenses],
  );
  const pendingExpense = periodExpenses.reduce((s, e) => s + (expensePaymentStatus(e) === "pending" ? e.amount : 0), 0);
  const totalExpense = paidPeriodExpenses.reduce((s, e) => s + e.amount, 0);
  const netCashFlow  = periodIncome - totalExpense;

  // Paid expenses split by how they were actually settled, mirroring the income
  // split above: anything without a tracked method counts as cash.
  const periodExpenseSplit = useMemo(() => {
    let cash = 0, online = 0;
    paidPeriodExpenses.forEach(e => {
      if ((e.paymentMethod || "cash") === "cash") cash += e.amount;
      else online += e.amount;
    });
    return { cash, online };
  }, [paidPeriodExpenses]);

  const netCashIncome   = periodIncomeSplit.cash   - periodExpenseSplit.cash;
  const netOnlineIncome = periodIncomeSplit.online - periodExpenseSplit.online;

  const categoryBreakdown = useMemo(() => {
    const map: Record<string, number> = {};
    paidPeriodExpenses.forEach(e => { map[e.category] = (map[e.category] ?? 0) + e.amount; });
    return EXPENSE_CATEGORIES
      .map(c => ({ ...c, amount: map[c.key] ?? 0 }))
      .filter(c => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  }, [paidPeriodExpenses]);

  // Chart: income vs expense per day (or month for 1y / long custom)
  const chartData = useMemo(() => {
    if (!today) return [] as { label: string; income: number; expense: number }[];
    if (period === "custom") {
      if (!customStart || !customEnd || customStart > customEnd) return [];
      const days = getDaysInRange(customStart, customEnd);
      if (days.length > 62) {
        return monthlyBarsRange(customStart, customEnd).map(({ label, key }) => {
          const income =
            appointments.filter(a => a.status === "completed" && !posInvoices.some(inv => inv.appointmentId === a.id) && a.date.startsWith(key)).reduce((s, a) => s + a.totalAmount, 0) +
            posInvoices.filter(inv => inv.date.startsWith(key)).reduce((s, inv) => s + inv.total, 0) +
            manualIncome.filter(entry => entry.date.startsWith(key)).reduce((s, entry) => s + entry.amount, 0);
          const expense = expenses.filter(e => e.date.startsWith(key) && expensePaymentStatus(e) === "paid").reduce((s, e) => s + e.amount, 0);
          return { label, income, expense };
        });
      }
      return days.map(date => {
        const d = new Date(date + "T12:00:00");
        const label = days.length > 14 ? String(d.getDate()) : d.toLocaleDateString("en-PK", { weekday: "short" });
        const income =
          appointments.filter(a => a.status === "completed" && !posInvoices.some(inv => inv.appointmentId === a.id) && a.date === date).reduce((s, a) => s + a.totalAmount, 0) +
          posInvoices.filter(inv => inv.date === date).reduce((s, inv) => s + inv.total, 0) +
          manualIncome.filter(entry => entry.date === date).reduce((s, entry) => s + entry.amount, 0);
        const expense = expenses.filter(e => e.date === date && expensePaymentStatus(e) === "paid").reduce((s, e) => s + e.amount, 0);
        return { label, income, expense };
      });
    }
    if (period === "1y") {
      return Array.from({ length: 12 }, (_, i) => {
        const d = new Date(today); d.setDate(1); d.setMonth(d.getMonth() - (11 - i));
        const key = toDateStr(d).substring(0, 7);
        const income =
          appointments.filter(a => a.status === "completed" && !posInvoices.some(inv => inv.appointmentId === a.id) && a.date.startsWith(key)).reduce((s, a) => s + a.totalAmount, 0) +
          posInvoices.filter(inv => inv.date.startsWith(key)).reduce((s, inv) => s + inv.total, 0) +
          manualIncome.filter(entry => entry.date.startsWith(key)).reduce((s, entry) => s + entry.amount, 0);
        const expense = expenses.filter(e => e.date.startsWith(key) && expensePaymentStatus(e) === "paid").reduce((s, e) => s + e.amount, 0);
        return { label: d.toLocaleDateString("en-PK", { month: "short" }), income, expense };
      });
    }
    return getDaysArr(cfg.days, today).map(date => {
      const d = new Date(date + "T12:00:00");
      const label = period === "30d" ? String(d.getDate()) : d.toLocaleDateString("en-PK", { weekday: "short" });
      const income =
        appointments.filter(a => a.status === "completed" && !posInvoices.some(inv => inv.appointmentId === a.id) && a.date === date).reduce((s, a) => s + a.totalAmount, 0) +
        posInvoices.filter(inv => inv.date === date).reduce((s, inv) => s + inv.total, 0) +
        manualIncome.filter(entry => entry.date === date).reduce((s, entry) => s + entry.amount, 0);
      const expense = expenses.filter(e => e.date === date && expensePaymentStatus(e) === "paid").reduce((s, e) => s + e.amount, 0);
      return { label, income, expense };
    });
  }, [period, today, customStart, customEnd, appointments, posInvoices, manualIncome, expenses, cfg.days]);

  const maxChart = Math.max(...chartData.flatMap(d => [d.income, d.expense]), 1);

  // Form helpers
  function openAdd() {
    setEditId(null);
    setFormError("");
    setForm({ ...EMPTY_FORM, date: today });
    setShowForm(true);
  }

  function openEdit(exp: Expense) {
    setEditId(exp.id);
    setFormError("");
    setForm({
      date: exp.date,
      category: exp.category,
      description: exp.description,
      amount: String(exp.amount),
      paymentMethod: exp.paymentMethod,
      paymentStatus: expensePaymentStatus(exp),
      billImageDataUrl: exp.billImageDataUrl,
      billImageName: exp.billImageName,
      notes: exp.notes ?? "",
      section: exp.section ?? "",
    });
    setShowForm(true);
  }

  function handleBillImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!VIEWABLE_BILL_IMAGE_TYPES.has(file.type)) {
      setFormError("Please upload a JPG, PNG, WebP, or GIF bill image.");
      return;
    }
    if (file.size > MAX_BILL_IMAGE_BYTES) {
      setFormError("Bill image must be smaller than 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setFormError("The bill image could not be read.");
        return;
      }
      setForm(f => ({ ...f, billImageDataUrl: reader.result as string, billImageName: file.name }));
      setFormError("");
    };
    reader.onerror = () => setFormError("The bill image could not be read.");
    reader.readAsDataURL(file);
  }

  async function retryExpenseSync() {
    setRetryingExpenseSync(true);
    try {
      const [expensesSaved, incomeSaved] = await Promise.all([
        saveExpenses(getExpenses()),
        saveManualCashIncome(getManualCashIncome()),
      ]);
      setExpenseSyncFailed(!expensesSaved || !incomeSaved);
    } finally {
      setRetryingExpenseSync(false);
    }
  }

  async function handleSave() {
    const amt = parseFloat(form.amount);
    if (!form.date) {
      setFormError("Please select an expense date.");
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setFormError("Please enter an amount greater than zero.");
      return;
    }

    const description = form.description.trim()
      || EXPENSE_CATEGORIES.find(category => category.key === form.category)?.label
      || "Expense";
    const billImagePatch = { billImageDataUrl: form.billImageDataUrl, billImageName: form.billImageName };

    // Locked to the active dashboard section when one is restricted (e.g.
    // Women's) — an expense added from that view can only belong to it.
    // From the Men's/All view, the form's own picker decides.
    const expenseSection = cashFlowScoped ? activeSection : (form.section || undefined);

    try {
      let dbSaved: boolean;
      if (editId) {
        dbSaved = await updateExpense(editId, { date: form.date, category: form.category, description, amount: amt, paymentMethod: form.paymentMethod, paymentStatus: form.paymentStatus, ...billImagePatch, notes: form.notes.trim() || undefined, section: expenseSection });
      } else {
        ({ dbSaved } = await addExpense({ date: form.date, category: form.category, description, amount: amt, paymentMethod: form.paymentMethod, paymentStatus: form.paymentStatus, ...billImagePatch, notes: form.notes.trim() || undefined, section: expenseSection }));
      }
      setExpenseSyncFailed(!dbSaved);
      setExpenses(getExpenses().filter(e => !cashFlowScoped || e.section === activeSection));
      setFormError("");
      setShowForm(false);
      setEditId(null);
    } catch {
      setFormError("The expense could not be saved. Please try again.");
    }
  }

  function handleDelete(id: string) {
    try {
      setExpenses((prev) => {
        const latest = getExpenses().filter(e => !cashFlowScoped || e.section === activeSection);
        const source = latest.some((expense) => expense.id === id) ? latest : prev;
        const updated = source.filter((expense) => expense.id !== id);
        saveExpenses(getExpenses().filter((expense) => expense.id !== id));
        return updated;
      });
      if (editId === id) {
        setShowForm(false);
        setEditId(null);
      }
    } catch {
      setFormError("The expense could not be deleted. Please try again.");
    }
  }

  function expenseKey(expense: Pick<Expense, "date" | "category" | "description" | "amount" | "paymentMethod">) {
    return [
      expense.date,
      expense.category,
      expense.description.trim().toLowerCase(),
      expense.amount.toFixed(2),
      expense.paymentMethod,
    ].join("|");
  }

  function incomeKey(income: Pick<ManualCashIncome, "date" | "category" | "description" | "amount">) {
    return [income.date, income.category.trim().toLowerCase(), income.description.trim().toLowerCase(), income.amount.toFixed(2)].join("|");
  }

  async function importCashFlow(file: File) {
    setFileMessage(null);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("The workbook does not contain a worksheet.");

      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      if (rows.length === 0) throw new Error("The import file has no cash-flow rows.");

      const categoryMap = new Map<string, ExpenseCategory>();
      EXPENSE_CATEGORIES.forEach(category => {
        categoryMap.set(category.key, category.key);
        categoryMap.set(category.label.toLowerCase(), category.key);
      });
      function field(row: Record<string, unknown>, ...names: string[]) {
        const normalized = new Map(
          Object.entries(row).map(([key, value]) => [key.trim().toLowerCase().replace(/[_-]+/g, " "), value]),
        );
        for (const name of names) {
          const value = normalized.get(name);
          if (value !== undefined) return value;
        }
        return "";
      }

      function parseDate(value: unknown): string {
        if (value instanceof Date && !Number.isNaN(value.getTime())) return toDateStr(value);
        if (typeof value === "number") {
          const parsed = XLSX.SSF.parse_date_code(value);
          if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
        }
        const text = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        const parsed = new Date(text);
        return Number.isNaN(parsed.getTime()) ? "" : toDateStr(parsed);
      }

      const importedExpenses: Expense[] = [];
      const importedIncome: ManualCashIncome[] = [];
      const errors: string[] = [];
      rows.forEach((row, index) => {
        const line = index + 2;
        
        // Skip completely empty rows
        const hasAnyData = Object.values(row).some(val => {
          const str = String(val).trim();
          return str !== "" && str !== "0" && str !== "undefined" && str !== "null";
        });
        if (!hasAnyData) return;
        
        const date = parseDate(field(row, "date"));
        const categoryRaw = String(field(row, "category")).trim().toLowerCase();
        const category = categoryMap.get(categoryRaw);
        const categoryLabel = String(field(row, "category")).trim();
        const description = String(field(row, "service description", "description")).trim();
        const parseAmount = (value: unknown) => {
          const text = String(value).replace(/[,₨\s]/g, "").trim();
          return text === "" ? 0 : Number(text);
        };
        const incomeAmount = parseAmount(field(row, "income intake amount", "income amount", "income"));
        const expenseAmount = parseAmount(field(row, "expense amount", "amount", "amount pkr"));

        const rowErrors: string[] = [];
        if (!date) rowErrors.push("invalid date");
        if (!categoryLabel) rowErrors.push("missing category");
        if (!description) rowErrors.push("missing service description");
        if (!Number.isFinite(incomeAmount) || incomeAmount < 0) rowErrors.push("invalid income amount");
        if (!Number.isFinite(expenseAmount) || expenseAmount < 0) rowErrors.push("invalid expense amount");
        if (incomeAmount <= 0 && expenseAmount <= 0) rowErrors.push("income or expense amount is required");
        if (expenseAmount > 0 && !category) {
          const validCategories = EXPENSE_CATEGORIES.map(c => c.label).join(", ");
          rowErrors.push(`invalid expense category "${categoryLabel}". Valid categories: ${validCategories}`);
        }
        if (rowErrors.length > 0) {
          errors.push(`Row ${line}: ${rowErrors.join(", ")}`);
          return;
        }

        const createdAt = new Date().toISOString();
        if (incomeAmount > 0) {
          importedIncome.push({ id: crypto.randomUUID(), date, category: categoryLabel, description, amount: incomeAmount, createdAt });
        }
        if (expenseAmount > 0) {
          importedExpenses.push({
            id: crypto.randomUUID(), date, category: category!, description, amount: expenseAmount,
            paymentMethod: "cash", paymentStatus: "paid", notes: "Imported from cash-flow workbook", createdAt,
          });
        }
      });

      if (errors.length > 0) {
        const displayErrors = errors.slice(0, 10);
        const remainingCount = errors.length - 10;
        const errorMessage = displayErrors.join(" · ") + (remainingCount > 0 ? ` · ${remainingCount} more error(s). Fix the shown errors first.` : "");
        throw new Error(errorMessage);
      }

      // Import against everything that is stored, not against the section-scoped
      // view this page is holding: `expenses`/`manualIncome` exclude the other
      // sections (and manual income entirely) while a section is selected, so
      // saving a list built from them would delete all of it — the same trap the
      // Payouts page documents in persistPayouts().
      const storedExpenses = getExpenses();
      const storedIncome = getManualCashIncome();
      const existingExpenseKeys = new Set(storedExpenses.map(expenseKey));
      const uniqueExpenses = importedExpenses.filter(expense => {
        const key = expenseKey(expense);
        if (existingExpenseKeys.has(key)) return false;
        existingExpenseKeys.add(key);
        return true;
      });
      const existingIncomeKeys = new Set(storedIncome.map(incomeKey));
      const uniqueIncome = importedIncome.filter(income => {
        const key = incomeKey(income);
        if (existingIncomeKeys.has(key)) return false;
        existingIncomeKeys.add(key);
        return true;
      });
      const skipped = (importedExpenses.length - uniqueExpenses.length) + (importedIncome.length - uniqueIncome.length);
      if (uniqueExpenses.length === 0 && uniqueIncome.length === 0) {
        setFileMessage({ type: "error", text: skipped ? `No rows imported. ${skipped} duplicate row(s) were skipped.` : "No valid rows were found." });
        return;
      }

      const mergedExpenses = [...storedExpenses, ...uniqueExpenses];
      const mergedIncome = [...storedIncome, ...uniqueIncome];
      const [expensesSaved, incomeSaved] = await Promise.all([
        saveExpenses(mergedExpenses),
        saveManualCashIncome(mergedIncome),
      ]);
      setExpenseSyncFailed(!expensesSaved || !incomeSaved);

      console.log("✅ Cash Flow Import Complete:", {
        importedIncome: uniqueIncome.length,
        importedExpenses: uniqueExpenses.length,
        totalIncome: mergedIncome.length,
        totalExpenses: mergedExpenses.length,
        sampleIncome: uniqueIncome.slice(0, 2),
        sampleExpenses: uniqueExpenses.slice(0, 2),
      });
      
      setExpenses(mergedExpenses.filter(e => !cashFlowScoped || e.section === activeSection));
      setManualIncome(cashFlowScoped ? [] : mergedIncome);
      
      // Auto-expand the date range to show imported data
      const allDates = [...uniqueExpenses.map(e => e.date), ...uniqueIncome.map(i => i.date)];
      if (allDates.length > 0) {
        const minDate = allDates.reduce((min, d) => d < min ? d : min);
        const maxDate = allDates.reduce((max, d) => d > max ? d : max);
        
        console.log("📅 Imported date range:", { minDate, maxDate, currentRange: { rangeStart, filterEnd } });
        
        // If imported data is outside current period, switch to custom range
        if (minDate < rangeStart || maxDate > filterEnd) {
          console.log("🔄 Switching to custom period to show imported data");
          setPeriod("custom");
          setCustomStart(minDate < rangeStart ? minDate : rangeStart);
          setCustomEnd(maxDate > filterEnd ? maxDate : filterEnd);
        }
      }
      
      setFileMessage({
        type: "success",
        text: `Imported ${uniqueIncome.length} income and ${uniqueExpenses.length} expense entr${uniqueIncome.length + uniqueExpenses.length === 1 ? "y" : "ies"}${skipped ? `; skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}` : ""}.`,
      });
    } catch (error) {
      setFileMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to import this file." });
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  async function exportExcel() {
    setFileMessage(null);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();

      // ── Daily cash-flow sheet ──────────────────────────────────────────────
      // Columns: Date | Card | Cash | Old Account | New Account | Total Income | Expense
      //   Card        = card payments
      //   Cash        = cash payments
      //   Old Account = bank transfer
      //   New Account = JazzCash + EasyPaisa + Raast

      type DayBucket = { card: number; cash: number; bank: number; newAccount: number; expense: number };
      const dayMap: Record<string, DayBucket> = {};

      // Initialise every date in the selected range with zeros
      const rangeDates = getDaysInRange(rangeStart || filterEnd, filterEnd);
      rangeDates.forEach(d => { dayMap[d] = { card: 0, cash: 0, bank: 0, newAccount: 0, expense: 0 }; });

      // All paid invoices (appointments + POS — both carry paymentMethod)
      const allPaidInvoices = getSalonInvoices().filter(
        inv => inv.status === "paid" && inv.date >= (rangeStart || filterEnd) && inv.date <= filterEnd
          && (!cashFlowScoped || inv.section === activeSection),
      );
      allPaidInvoices.forEach(inv => {
        if (!dayMap[inv.date]) dayMap[inv.date] = { card: 0, cash: 0, bank: 0, newAccount: 0, expense: 0 };
        const pm = inv.paymentMethod ?? "";
        if      (pm === "card")                                   dayMap[inv.date].card       += inv.total;
        else if (pm === "cash")                                   dayMap[inv.date].cash       += inv.total;
        else if (pm === "bank")                                   dayMap[inv.date].bank       += inv.total;
        else if (pm === "jazzcash" || pm === "easypaisa" || pm === "raast")
                                                                  dayMap[inv.date].newAccount += inv.total;
        else                                                      dayMap[inv.date].cash       += inv.total; // untracked → cash
      });

      // Completed appointments not linked to a POS invoice — same "Appointment" source
      // income counted in periodIncome/the PDF's Income Log, but with no payment method
      // of its own, so it falls into Cash like an untracked invoice (same convention as
      // the untracked-payment-method invoices above). Without this loop the daily sheet's
      // Total Income column silently omits every appointment-sourced sale.
      appointments
        .filter(a => a.status === "completed" && !posLinkedAppointmentIds.has(a.id) && a.date >= (rangeStart || filterEnd) && a.date <= filterEnd
          && (!cashFlowScoped || a.section === activeSection))
        .forEach(a => {
          if (!dayMap[a.date]) dayMap[a.date] = { card: 0, cash: 0, bank: 0, newAccount: 0, expense: 0 };
          dayMap[a.date].cash += a.totalAmount;
        });

      // Manual imported income → cash column
      manualIncome
        .filter(e => e.date >= (rangeStart || filterEnd) && e.date <= filterEnd)
        .forEach(e => {
          if (!dayMap[e.date]) dayMap[e.date] = { card: 0, cash: 0, bank: 0, newAccount: 0, expense: 0 };
          dayMap[e.date].cash += e.amount;
        });

      // Expenses aggregated per day
      paidPeriodExpenses.forEach(e => {
        if (!dayMap[e.date]) dayMap[e.date] = { card: 0, cash: 0, bank: 0, newAccount: 0, expense: 0 };
        dayMap[e.date].expense += e.amount;
      });

      // Build sorted rows (oldest → newest)
      const cashFlowRows = Object.keys(dayMap)
        .sort()
        .map(date => {
          const b = dayMap[date];
          const totalIncome = b.card + b.cash + b.bank + b.newAccount;
          return {
            Date:           date,
            Card:           b.card       || 0,
            Cash:           b.cash       || 0,
            "Old Account":  b.bank       || 0,
            "New Account":  b.newAccount || 0,
            "Total Income": totalIncome  || 0,
            Expense:        b.expense    || 0,
          };
        });

      const cashFlowSheet = XLSX.utils.json_to_sheet(cashFlowRows, {
        header: ["Date", "Card", "Cash", "Old Account", "New Account", "Total Income", "Expense"],
      });
      cashFlowSheet["!cols"] = [
        { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 15 }, { wch: 12 },
      ];

      // ── Summary sheet ──────────────────────────────────────────────────────
      const summaryRows = [
        ["Cash Flow Report"],
        ["Period", rangeStart === filterEnd ? rangeStart : `${rangeStart} to ${filterEnd}`],
        ["Total Income (PKR)", periodIncome],
        ["Paid Expenses (PKR)", totalExpense],
        ["Pending Expenses (PKR)", pendingExpense],
        ["Net Cash Flow (PKR)", netCashFlow],
        ["Cash Income (PKR)", periodIncomeSplit.cash],
        ["Cash Expenses (PKR)", periodExpenseSplit.cash],
        ["Net Cash Income (PKR)", netCashIncome],
        ["Online Income (PKR)", periodIncomeSplit.online],
        ["Online Expenses (PKR)", periodExpenseSplit.online],
        ["Net Online Income (PKR)", netOnlineIncome],
        ["Exported At", new Date().toISOString()],
      ];

      // ── Detailed expense rows ──────────────────────────────────────────────
      const expenseRows = periodExpenses.map(expense => ({
        Date: expense.date,
        Category: EXPENSE_CATEGORIES.find(c => c.key === expense.category)?.label ?? expense.category,
        Description: expense.description,
        "Amount (PKR)": expense.amount,
        "Payment Method": PAYMENT_LABELS[expense.paymentMethod] ?? expense.paymentMethod,
        Status: expensePaymentStatus(expense) === "pending" ? "Pending / unpaid" : "Paid",
        "Bill Image": expense.billImageName ?? "",
        Notes: expense.notes ?? "",
      }));

      XLSX.utils.book_append_sheet(workbook, cashFlowSheet, "Cash Flow");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Summary");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(expenseRows), "Expenses");
      XLSX.writeFile(workbook, `salon-central-cash-flow-${rangeStart || "report"}-${filterEnd || "report"}.xlsx`);
      setFileMessage({ type: "success", text: "Excel report exported successfully." });
    } catch {
      setFileMessage({ type: "error", text: "Unable to export the Excel report." });
    }
  }

  // PDF Export
  function exportPDF() {
    if (period === "custom" && (!customStart || !customEnd || customStart > customEnd)) {
      alert("Please select a valid start and end date for the custom range before downloading.");
      return;
    }

    const now = new Date();
    const periodLabel = period === "custom" ? `${rangeStart} → ${filterEnd}` : cfg.label;
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Cash Flow Report</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Montserrat',sans-serif;background:#fff;color:#1a1a2e;font-size:13px}
    .page{max-width:820px;margin:0 auto;padding:40px 48px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:24px;border-bottom:2px solid #f0f0f8}
    .logo-img{position:relative;overflow:hidden;width:104px;height:51px}
    .logo-img img{position:absolute;width:117.52%;height:241.61%;max-width:none;left:-9.14%;top:-66%}
    .report-meta{text-align:right}
    .report-title{font-size:16px;font-weight:800;color:#7C3AED}
    .report-sub{font-size:12px;color:#6b6b8a;margin-top:4px}
    .report-gen{font-size:11px;color:#c0c0d0;margin-top:2px}
    .stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:28px}
    .stat-card{background:#F5F3FF;border-radius:12px;padding:16px;border:1px solid #EDE9FE}
    .stat-label{font-size:10px;font-weight:700;color:#a0a0b8;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px}
    .stat-value{font-size:20px;font-weight:800;color:#7C3AED}
    .stat-sub{font-size:10px;color:#a0a0b8;margin-top:4px}
    .section{margin-bottom:28px}
    .section-title{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:4px}
    .section-sub{font-size:11px;color:#a0a0b8;margin-bottom:16px}
    table{width:100%;border-collapse:collapse}
    thead tr{background:#F5F3FF}
    th{font-size:10px;font-weight:700;color:#a0a0b8;letter-spacing:.07em;text-transform:uppercase;padding:10px 14px;text-align:left;border-bottom:1px solid #f0f0f8}
    td{padding:10px 14px;font-size:12px;border-bottom:1px solid #f8f8fc}
    tr:last-child td{border-bottom:none}
    .total-row td{font-weight:700;background:#fef2f2;color:#ef4444;border-top:1px solid #f0f0f8}
    .cat-badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
    .net-pos{color:#059669}.net-neg{color:#ef4444}
    .income-total td{font-weight:700;background:#F5F3FF;color:#7C3AED;border-top:1px solid #f0f0f8}
    .src-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
    .footer{margin-top:36px;padding-top:20px;border-top:1px solid #f0f0f8;display:flex;justify-content:space-between}
    .footer-txt{font-size:11px;color:#c0c0d0}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{padding:24px 32px}}
  </style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <div class="logo-img"><img src="${window.location.origin}/salon-central-logo.png" alt="Salon Central"/></div>
      <div style="font-size:12px;color:#a0a0b8;margin-top:6px">Salon Management Platform</div>
    </div>
    <div class="report-meta">
      <div class="report-title">Cash Flow Report — ${periodLabel}</div>
      <div class="report-sub">${rangeStart} to ${filterEnd}</div>
      <div class="report-gen">Generated ${now.toLocaleDateString("en-PK", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} · ${now.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}</div>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Total Income</div>
      <div class="stat-value">${fmt(periodIncome)}</div>
      <div class="stat-sub">From appointments & POS</div>
    </div>
    <div class="stat-card" style="background:#fef2f2;border-color:#fecaca">
      <div class="stat-label">Paid Expenses</div>
      <div class="stat-value" style="color:#ef4444">${fmt(totalExpense)}</div>
      <div class="stat-sub">${pendingExpense > 0 ? `${fmt(pendingExpense)} pending` : `${periodExpenses.length} entries logged`}</div>
    </div>
    <div class="stat-card" style="background:${netCashFlow >= 0 ? "#f0fdf4" : "#fef2f2"};border-color:${netCashFlow >= 0 ? "#bbf7d0" : "#fecaca"}">
      <div class="stat-label">Net Cash Flow</div>
      <div class="stat-value ${netCashFlow >= 0 ? "net-pos" : "net-neg"}">${netCashFlow >= 0 ? "" : "-"}${fmt(Math.abs(netCashFlow))}</div>
      <div class="stat-sub">${netCashFlow >= 0 ? "Surplus" : "Deficit"}</div>
    </div>
    <div class="stat-card" style="background:${netCashIncome >= 0 ? "#f0fdf4" : "#fef2f2"};border-color:${netCashIncome >= 0 ? "#bbf7d0" : "#fecaca"}">
      <div class="stat-label">Net Cash Income</div>
      <div class="stat-value ${netCashIncome >= 0 ? "net-pos" : "net-neg"}">${netCashIncome >= 0 ? "" : "-"}${fmt(Math.abs(netCashIncome))}</div>
      <div class="stat-sub">${fmt(periodIncomeSplit.cash)} in − ${fmt(periodExpenseSplit.cash)} cash expenses</div>
    </div>
    <div class="stat-card" style="background:${netOnlineIncome >= 0 ? "#eff6ff" : "#fef2f2"};border-color:${netOnlineIncome >= 0 ? "#bfdbfe" : "#fecaca"}">
      <div class="stat-label">Net Online Income</div>
      <div class="stat-value ${netOnlineIncome >= 0 ? "net-pos" : "net-neg"}">${netOnlineIncome >= 0 ? "" : "-"}${fmt(Math.abs(netOnlineIncome))}</div>
      <div class="stat-sub">${fmt(periodIncomeSplit.online)} in − ${fmt(periodExpenseSplit.online)} online expenses</div>
    </div>
  </div>

  ${periodIncomeRows.length > 0 ? `
  <div class="section">
    <div class="section-title">Income Log</div>
    <div class="section-sub">All income entries for this period</div>
    <table>
      <thead><tr><th>Date</th><th>Client</th><th>Description</th><th>Source</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>
        ${periodIncomeRows.map(row => `
        <tr>
          <td>${row.date}</td>
          <td style="font-weight:600">${row.client}</td>
          <td style="color:#6b6b8a">${row.description}</td>
          <td><span class="src-badge" style="background:${row.source === "pos" ? "#fffbeb" : "#F5F3FF"};color:${row.source === "pos" ? "#d97706" : "#7C3AED"}">${row.source === "pos" ? "POS Sale" : row.source === "manual" ? "Imported Income" : "Appointment"}</span></td>
          <td style="text-align:right;font-weight:700;color:#7C3AED">${fmt(row.amount)}</td>
        </tr>`).join("")}
        <tr class="income-total">
          <td colspan="4"><strong>Total Income</strong></td>
          <td style="text-align:right"><strong>${fmt(periodIncome)}</strong></td>
        </tr>
      </tbody>
    </table>
  </div>` : ""}

  ${categoryBreakdown.length > 0 ? `
  <div class="section">
    <div class="section-title">Expenses by Category</div>
    <div class="section-sub">Breakdown for ${periodLabel}</div>
    <table>
      <thead><tr><th>Category</th><th style="text-align:right">Amount</th><th style="text-align:right">% of Total</th></tr></thead>
      <tbody>
        ${categoryBreakdown.map(c => `
        <tr>
          <td><span class="cat-badge" style="background:${c.color}18;color:${c.color}">${c.label}</span></td>
          <td style="text-align:right;font-weight:700;color:${c.color}">${fmt(c.amount)}</td>
          <td style="text-align:right;color:#6b6b8a">${totalExpense > 0 ? ((c.amount / totalExpense) * 100).toFixed(1) : "0"}%</td>
        </tr>`).join("")}
        <tr class="total-row">
          <td><strong>Total Expenses</strong></td>
          <td style="text-align:right"><strong>${fmt(totalExpense)}</strong></td>
          <td style="text-align:right"><strong>100%</strong></td>
        </tr>
      </tbody>
    </table>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Expense Log</div>
    <div class="section-sub">All entries for this period</div>
    <table>
      <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Payment</th><th>Status</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>
        ${periodExpenses.map(e => {
          const cat = EXPENSE_CATEGORIES.find(c => c.key === e.category);
          const status = expensePaymentStatus(e);
          return `<tr>
            <td>${e.date}</td>
            <td><span class="cat-badge" style="background:${cat?.color ?? "#888"}18;color:${cat?.color ?? "#888"}">${cat?.label ?? e.category}</span></td>
            <td>${e.description}</td>
            <td>${PAYMENT_LABELS[e.paymentMethod] ?? e.paymentMethod}</td>
            <td>${status === "pending" ? "Pending / unpaid" : "Paid"}</td>
            <td style="text-align:right;font-weight:700;color:#ef4444">${fmt(e.amount)}</td>
          </tr>`;
        }).join("")}
        <tr class="total-row">
          <td colspan="5"><strong>Paid Expenses</strong>${pendingExpense > 0 ? ` · Pending ${fmt(pendingExpense)}` : ""}</td>
          <td style="text-align:right"><strong>${fmt(totalExpense)}</strong></td>
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

  // Input style shorthand
  const inputSt: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1.5px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", background: "#fafafa", outline: "none", boxSizing: "border-box" };
  const labelSt: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#a0a0b8", letterSpacing: "0.05em", textTransform: "uppercase", display: "block", marginBottom: 6 };

  return (
    <div style={{ background: "#ffffff", minHeight: "100vh" }}>
      <MobilePageHeader title="Cash Flow" subtitle={cfg.label} action={{ label: "Add Expense", onClick: openAdd }} />

      <div className="dash-page dashboard-polish desktop-only" style={{ background: "#ffffff", display: "flex", flexDirection: "column", gap: 20, paddingTop: 20, minHeight: "100vh" }}>

        {/* ── Header row ──────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <PageTitle
            icon={<Wallet size={24} />}
            title="Cash Flow"
            subtitle={
              (cashFlowScoped ? `Restricted to ${activeSection} only · ` : "") +
              (rangeStart === filterEnd ? rangeStart : `${rangeStart} → ${filterEnd}`)
            }
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {/* Period tabs */}
            <div style={{ display: "flex", background: "#fff", border: "1px solid #e3e0eb", borderRadius: 14, padding: 5, gap: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.01)" }}>
              {PERIODS.map(p => (
                <button key={p.key} onClick={() => setPeriod(p.key)} style={{
                  padding: "9px 20px", borderRadius: 10, border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: period === p.key ? 750 : 600,
                  background: period === p.key ? "var(--accent-gradient)" : "transparent",
                  color: period === p.key ? "#fff" : "#6b6b8a", transition: "all 0.15s",
                  boxShadow: period === p.key ? "0 3px 10px var(--accent-glow)" : "none",
                }}>{p.label}</button>
              ))}
            </div>
            {/* Custom date range */}
            {period === "custom" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--accent)", borderRadius: 12, padding: "8px 14px", background: "rgba(124, 58, 237, 0.04)" }}>
                <input type="date" value={customStart} max={customEnd || today} onChange={e => setCustomStart(e.target.value)}
                  style={{ border: "none", background: "transparent", fontSize: 13, color: "#1a1a2e", outline: "none", cursor: "pointer", fontWeight: 600 }} />
                <span style={{ color: "var(--accent)", fontWeight: 800, fontSize: 13 }}>→</span>
                <input type="date" value={customEnd} min={customStart} max={today} onChange={e => setCustomEnd(e.target.value)}
                  style={{ border: "none", background: "transparent", fontSize: 13, color: "#1a1a2e", outline: "none", cursor: "pointer", fontWeight: 600 }} />
              </div>
            )}
            <button onClick={exportPDF} style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 12, border: "1px solid #e3e0eb", background: "#fff", color: "#6b6b8a", fontSize: 13, fontWeight: 750, cursor: "pointer", transition: "all 0.15s" }} className="hover-bg-light">
              <Download size={15} /> PDF
            </button>
            <button onClick={exportExcel} style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 12, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#059669", fontSize: 13, fontWeight: 750, cursor: "pointer", transition: "all 0.15s" }} className="hover-scale">
              <FileSpreadsheet size={15} /> Excel
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={event => {
                const file = event.target.files?.[0];
                if (file) void importCashFlow(file);
              }}
              style={{ display: "none" }}
            />
            <button onClick={() => importInputRef.current?.click()} style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 12, border: "1px solid #e3e0eb", background: "#fff", color: "var(--accent)", fontSize: 13, fontWeight: 750, cursor: "pointer", transition: "all 0.15s" }} className="hover-bg-light">
              <Upload size={15} /> Import
            </button>
            <a href="/templates/cash-flow-import-template.xlsx" download style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 12, border: "1px solid #e3e0eb", background: "#fff", color: "#6b6b8a", fontSize: 13, fontWeight: 750, textDecoration: "none", transition: "all 0.15s" }} className="hover-bg-light">
              <Download size={15} /> Template
            </a>
            <button onClick={openAdd} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 12, border: "none", cursor: "pointer", background: "var(--accent-gradient)", color: "#fff", fontSize: 13, fontWeight: 750, boxShadow: "0 4px 14px var(--accent-glow)", transition: "all 0.18s ease" }} className="hover-scale page-header-btn">
              <Plus size={16} /> Add Expense
            </button>
          </div>
        </div>

        {fileMessage && (
          <div style={{
            padding: "12px 18px",
            borderRadius: 12,
            border: `1px solid ${fileMessage.type === "success" ? "#a7f3d0" : "#fecaca"}`,
            background: fileMessage.type === "success" ? "#ecfdf5" : "#fef2f2",
            color: fileMessage.type === "success" ? "#047857" : "#b91c1c",
            fontSize: 13,
            fontWeight: 700,
            boxShadow: `0 4px 12px ${fileMessage.type === "success" ? "rgba(5,150,105,0.05)" : "rgba(220,38,38,0.05)"}`
          }}>
            {fileMessage.text}
          </div>
        )}

        {/* ── Summary strip ───────────────────────────────────────────── */}
        <div className="stats-grid-3">
          {[
            { label: "Income",    value: fmt(periodIncome),  color: "var(--accent)", bg: "rgba(124, 58, 237, 0.08)", sub: "Appointments & POS",          icon: TrendingUp  },
            { label: "Expenses",  value: fmt(totalExpense),  color: "#ef4444", bg: "#fef2f2", sub: pendingExpense > 0 ? `${fmt(pendingExpense)} pending` : `${periodExpenses.length} entries logged`, icon: TrendingDown },
            { label: "Net Flow",  value: (netCashFlow < 0 ? "−" : "+") + fmt(Math.abs(netCashFlow)), color: netCashFlow >= 0 ? "#059669" : "#ef4444", bg: netCashFlow >= 0 ? "#ecfdf5" : "#fef2f2", sub: netCashFlow >= 0 ? "Surplus" : "Deficit", icon: Wallet },
          ].map(({ label, value, color, bg, sub, icon: Icon }) => (
            <div key={label} style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.02)" }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={22} color={color} />
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
                <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, fontWeight: 500 }}>{sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Cash vs Online split (income, then net of same-method expenses) ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "Cash",   value: fmt(periodIncomeSplit.cash),   color: "#059669", bg: "#ecfdf5", sub: "Cash-in-hand income",                icon: Banknote   },
            { label: "Online", value: fmt(periodIncomeSplit.online), color: "#2563eb", bg: "#eff6ff", sub: "Card, bank & mobile wallet income",   icon: CreditCard },
            {
              label: "Net Cash",
              value: (netCashIncome < 0 ? "−" : "+") + fmt(Math.abs(netCashIncome)),
              color: netCashIncome >= 0 ? "#059669" : "#ef4444",
              bg: netCashIncome >= 0 ? "#ecfdf5" : "#fef2f2",
              sub: `${fmt(periodIncomeSplit.cash)} in − ${fmt(periodExpenseSplit.cash)} cash expenses`,
              icon: Wallet,
            },
            {
              label: "Net Online",
              value: (netOnlineIncome < 0 ? "−" : "+") + fmt(Math.abs(netOnlineIncome)),
              color: netOnlineIncome >= 0 ? "#2563eb" : "#ef4444",
              bg: netOnlineIncome >= 0 ? "#eff6ff" : "#fef2f2",
              sub: `${fmt(periodIncomeSplit.online)} in − ${fmt(periodExpenseSplit.online)} online expenses`,
              icon: Wallet,
            },
          ].map(({ label, value, color, bg, sub, icon: Icon }) => (
            <div key={label} style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.02)" }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={22} color={color} />
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
                <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, fontWeight: 500 }}>{sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Chart (compact) ─────────────────────────────────────────── */}
        {chartData.length > 1 && (
          <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", padding: "18px 24px", boxShadow: "0 8px 28px rgba(38,25,75,.04)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e" }}>Income vs Expenses</span>
              <div style={{ display: "flex", gap: 16 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b6b8a", fontWeight: 600 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--accent)", display: "inline-block" }} /> Income
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b6b8a", fontWeight: 600 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "#ef4444", display: "inline-block" }} /> Expenses
                </span>
              </div>
            </div>
            <div style={{ position: "relative", height: 140 }}>
              {[0, 50, 100].map(pct => (
                <div key={pct} style={{ position: "absolute", bottom: `${pct}%`, left: 0, right: 0, height: 1, background: "#f0f0f5" }} />
              ))}
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: chartData.length > 20 ? 3 : 6 }}>
                {chartData.map((bar, i) => {
                  const ih = maxChart > 0 ? (bar.income / maxChart) * 100 : 0;
                  const eh = maxChart > 0 ? (bar.expense / maxChart) * 100 : 0;
                  const hov = hoveredBar === i;
                  return (
                    <div key={i} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", gap: 2, position: "relative", transition: "all 0.15s" }}
                      onMouseEnter={() => setHoveredBar(i)} onMouseLeave={() => setHoveredBar(null)}>
                      {hov && (bar.income > 0 || bar.expense > 0) && (
                        <div style={{ position: "absolute", bottom: `${Math.max(ih, eh) + 8}%`, left: "50%", transform: "translateX(-50%)", background: "#1a1a2e", color: "#fff", fontSize: 12, fontWeight: 750, padding: "8px 12px", borderRadius: 8, whiteSpace: "nowrap", zIndex: 10, pointerEvents: "none", boxShadow: "0 8px 16px rgba(0,0,0,0.2)" }}>
                          <div style={{ color: "#c4b5fd" }}>In: {fmt(bar.income)}</div>
                          <div style={{ color: "#fca5a5", marginTop: 2 }}>Ex: {fmt(bar.expense)}</div>
                        </div>
                      )}
                      <div style={{ flex: 1, height: `${Math.max(ih, 0.5)}%`, background: "var(--accent)", borderRadius: "4px 4px 0 0", opacity: hov ? 1 : 0.8, transition: "opacity 0.15s" }} />
                      <div style={{ flex: 1, height: `${Math.max(eh, 0.5)}%`, background: "#ef4444", borderRadius: "4px 4px 0 0", opacity: hov ? 1 : 0.8, transition: "opacity 0.15s" }} />
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", gap: chartData.length > 20 ? 3 : 6, paddingTop: 8 }}>
              {chartData.map((bar, i) => (
                <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "#9898b0", fontWeight: 600, overflow: "hidden" }}>{bar.label}</div>
              ))}
            </div>
          </div>
        )}

        {/* ── Add / Edit form (slide-in) ───────────────────────────────── */}
        {showForm && (
          <div ref={expenseFormRef} style={{ background: "#fff", borderRadius: 12, border: "1.5px solid #7C3AED", padding: "18px 20px", marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#1a1a2e" }}>{editId ? "Edit Expense" : "New Expense"}</span>
              <button onClick={() => { setShowForm(false); setEditId(null); setFormError(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#b0b0c8" }}><X size={16} /></button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              <div>
                <label style={labelSt}>Date</label>
                <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={inputSt} />
              </div>
              <div>
                <label style={labelSt}>Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as ExpenseCategory }))} style={inputSt}>
                  {EXPENSE_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Payment</label>
                <select value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))} style={inputSt}>
                  {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Status</label>
                <select value={form.paymentStatus} onChange={e => setForm(f => ({ ...f, paymentStatus: e.target.value as "paid" | "pending" }))} style={inputSt}>
                  {PAYMENT_STATUSES.map(status => <option key={status.key} value={status.key}>{status.label}</option>)}
                </select>
              </div>
              <div>
                <label style={labelSt}>Amount (PKR)</label>
                <input type="number" value={form.amount} onChange={e => { setForm(f => ({ ...f, amount: e.target.value })); setFormError(""); }} placeholder="0" min={0.01} step="0.01" style={inputSt} />
              </div>
              <div>
                <label style={labelSt}>Section</label>
                {cashFlowScoped ? (
                  <div style={{ ...inputSt, display: "flex", alignItems: "center", gap: 6, color: "#7C3AED", fontWeight: 700, background: "#faf9fd" }}>
                    <Lock size={12} /> {activeSection} (locked)
                  </div>
                ) : (
                  <select value={form.section} onChange={e => setForm(f => ({ ...f, section: e.target.value }))} style={inputSt}>
                    <option value="">Shared / Unassigned</option>
                    {getSectionOptions(expenses).map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelSt}>Description <span style={{ fontWeight: 500, textTransform: "none" }}>(optional)</span></label>
                <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Shampoo & conditioner restock" style={inputSt} />
              </div>
              <div>
                <label style={labelSt}>Notes</label>
                <input type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" style={inputSt} />
              </div>
              <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: 10, borderRadius: 10, border: "1px dashed #d8d4e8", background: "#faf9fd" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 12px", borderRadius: 8, border: "1px solid #e8e8f0", background: "#fff", color: "#6b46c1", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                  <Upload size={14} /> Upload bill image
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleBillImageChange} style={{ display: "none" }} />
                </label>
                {form.billImageDataUrl ? (
                  <>
                    <a href={form.billImageDataUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 700, color: "#059669", textDecoration: "none" }}>
                      {form.billImageName || "Bill image"}
                    </a>
                    <button type="button" onClick={() => setForm(f => ({ ...f, billImageDataUrl: undefined, billImageName: undefined }))} style={{ border: "none", background: "transparent", color: "#dc2626", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                      Remove
                    </button>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: "#9898b0", fontWeight: 600 }}>Optional — receipt or bill photo</span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 14, alignItems: "center" }}>
              {formError && <div role="alert" style={{ color: "#dc2626", fontSize: 12, fontWeight: 700, marginRight: "auto" }}>{formError}</div>}
              <button onClick={() => { setShowForm(false); setEditId(null); setFormError(""); }} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #e8e8f0", background: "#fff", fontSize: 12, color: "#6b6b8a", cursor: "pointer", fontWeight: 600, marginLeft: formError ? 0 : "auto" }}>Cancel</button>
              <button onClick={handleSave} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 20px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#5B21B6,#9333EA)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                <Check size={13} /> {editId ? "Save Changes" : "Save"}
              </button>
            </div>
          </div>
        )}

        {/* ── Income + Expense tables side by side ────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

          {/* Income table */}
          <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", overflow: "hidden" }}>
            <div style={{ padding: "18px 20px", borderBottom: "1px solid #f0f0f5", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(124, 58, 237, 0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <TrendingUp size={16} color="var(--accent)" />
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e", letterSpacing: "-0.01em" }}>
                  Income
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#9898b0", marginLeft: 8 }}>{periodIncomeRows.length} entries · {fmt(periodIncome)}</span>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 90px", padding: "10px 20px", background: "#faf9fd", borderBottom: "1px solid #f0f0f5" }}>
              {["DATE", "CLIENT / SERVICE", "AMOUNT"].map((h, i) => (
                <div key={i} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em", textAlign: i === 2 ? "right" : "left" }}>{h}</div>
              ))}
            </div>

            {periodIncomeRows.length === 0 ? (
              <div style={{ padding: "48px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>💜</div>
                <div style={{ fontSize: 14, color: "#1a1a2e", fontWeight: 800 }}>No income this period</div>
              </div>
            ) : periodIncomeRows.map((row, i) => (
              <div key={row.id} className="hover-bg-row" style={{ display: "grid", gridTemplateColumns: "80px 1fr 90px", padding: "12px 20px", borderBottom: i === periodIncomeRows.length - 1 ? "none" : "1px solid #f8f8fc", alignItems: "center", transition: "background 0.15s" }}>
                <div style={{ fontSize: 12, color: "#9898b0", fontWeight: 500 }}>{row.date}</div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: row.source === "pos" ? "#fffbeb" : "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {row.source === "pos"
                        ? <ShoppingBag size={12} color="#d97706" />
                        : row.source === "manual"
                          ? <Upload size={12} color="var(--accent)" />
                          : <CalendarCheck size={12} color="var(--accent)" />}
                    </div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{row.client}</span>
                        {row.paymentMethod && (
                          <span style={{
                            fontSize: 9, fontWeight: 800, letterSpacing: "0.03em", textTransform: "uppercase",
                            padding: "2px 7px", borderRadius: 20, flexShrink: 0,
                            color: row.paymentMethod === "cash" ? "#059669" : "#2563eb",
                            background: row.paymentMethod === "cash" ? "#ecfdf5" : "#eff6ff",
                          }}>
                            {row.paymentMethod === "cash" ? "Cash" : "Online"}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, fontWeight: 500 }} title={row.description}>
                        {row.description.length > 28 ? row.description.slice(0, 28) + "…" : row.description}
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)", textAlign: "right" }}>{fmt(row.amount)}</div>
              </div>
            ))}

            {periodIncomeRows.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 90px", padding: "12px 20px", background: "#faf9fd", borderTop: "1px solid #f0f0f5" }}>
                <div style={{ gridColumn: "1 / 3", fontSize: 12, fontWeight: 800, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total</div>
                <div style={{ fontSize: 14, fontWeight: 850, color: "var(--accent)", textAlign: "right" }}>{fmt(periodIncome)}</div>
              </div>
            )}
          </div>

          {/* Expense table */}
          <div style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", overflow: "hidden" }}>
            <div style={{ padding: "18px 20px", borderBottom: "1px solid #f0f0f5", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <TrendingDown size={16} color="#ef4444" />
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e", letterSpacing: "-0.01em" }}>
                  Expenses
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#9898b0", marginLeft: 8 }}>{periodExpenses.length} entries · {fmt(totalExpense)} paid{pendingExpense > 0 ? ` · ${fmt(pendingExpense)} pending` : ""}</span>
                  {expenseSyncFailed && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 10, fontSize: 11, fontWeight: 700, color: "#dc2626" }}>
                      <AlertCircle size={11} /> Not synced to server — saved on this device only
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {expenseSyncFailed && (
                <button type="button" onClick={retryExpenseSync} disabled={retryingExpenseSync}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10, border: "1.5px solid #dc2626", background: "#fff", color: "#dc2626", fontSize: 12, fontWeight: 750, cursor: retryingExpenseSync ? "default" : "pointer", opacity: retryingExpenseSync ? 0.6 : 1 }}>
                  <RefreshCw size={14} /> {retryingExpenseSync ? "Retrying…" : "Retry Sync"}
                </button>
              )}
              {!showForm && (
                <button onClick={openAdd} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10, border: "1.5px solid #ef4444", background: "transparent", color: "#ef4444", fontSize: 12, fontWeight: 750, cursor: "pointer", transition: "all 0.15s" }} className="hover-bg-light">
                  <Plus size={14} /> Add
                </button>
              )}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "80px 110px 1fr 70px 92px 80px 32px 32px", padding: "10px 20px", background: "#faf9fd", borderBottom: "1px solid #f0f0f5" }}>
              {["DATE", "CATEGORY", "DESCRIPTION", "BILL", "STATUS", "AMOUNT", "", ""].map((h, i) => (
                <div key={i} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em" }}>{h}</div>
              ))}
            </div>

            {periodExpenses.length === 0 ? (
              <div style={{ padding: "48px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>💸</div>
                <div style={{ fontSize: 14, color: "#1a1a2e", fontWeight: 800 }}>No expenses logged</div>
                <div style={{ fontSize: 12, color: "#9898b0", marginTop: 4 }}>Click &ldquo;Add&rdquo; to start tracking.</div>
              </div>
            ) : periodExpenses.map((exp, i) => {
              const cat = EXPENSE_CATEGORIES.find(c => c.key === exp.category);
              const payColor = PAYMENT_COLORS[exp.paymentMethod];
              const status = expensePaymentStatus(exp);
              return (
                <div key={exp.id} className="hover-bg-row" style={{ display: "grid", gridTemplateColumns: "80px 110px 1fr 70px 92px 80px 32px 32px", padding: "12px 20px", borderBottom: i === periodExpenses.length - 1 ? "none" : "1px solid #f8f8fc", alignItems: "center", transition: "background 0.15s" }}>
                  <div style={{ fontSize: 12, color: "#9898b0", fontWeight: 500 }}>{exp.date}</div>
                  <div>
                    <span style={{ fontSize: 10, fontWeight: 750, color: cat?.color ?? "#888", background: `${cat?.color ?? "#888"}15`, padding: "3px 8px", borderRadius: 20, textTransform: "uppercase", letterSpacing: "0.03em" }}>{cat?.label ?? exp.category}</span>
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{exp.description}</div>
                    {exp.notes && <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{exp.notes}</div>}
                    {exp.paymentMethod && <div style={{ fontSize: 11, color: payColor ?? "#9898b0", marginTop: 2, fontWeight: 600 }}>{PAYMENT_LABELS[exp.paymentMethod] ?? exp.paymentMethod}</div>}
                  </div>
                  <div>
                    {exp.billImageDataUrl ? (
                      <button
                        type="button"
                        title={exp.billImageName || "View bill image"}
                        aria-label={`View bill image for ${exp.description}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setPreviewImage({ src: exp.billImageDataUrl!, title: exp.billImageName || exp.description || "Bill image" });
                        }}
                        style={{ width: 44, height: 44, padding: 0, border: "1px solid #e8e8f0", borderRadius: 8, background: "#faf9fd", cursor: "pointer", overflow: "hidden", boxShadow: "0 2px 6px rgba(0,0,0,0.04)", position: "relative" }}
                      >
                        <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b46c1", fontSize: 10, fontWeight: 850 }}>View</span>
                        <img
                          src={exp.billImageDataUrl}
                          alt=""
                          onError={(event) => { event.currentTarget.style.display = "none"; }}
                          style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#fff" }}
                        />
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, color: "#c8c8d8", fontWeight: 700 }}>—</span>
                    )}
                  </div>
                  <div>
                    <span style={{ fontSize: 10, fontWeight: 800, color: status === "pending" ? "#b45309" : "#059669", background: status === "pending" ? "#fef3c7" : "#dcfce7", padding: "3px 8px", borderRadius: 20, textTransform: "uppercase" }}>{status === "pending" ? "Pending" : "Paid"}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#ef4444" }}>{fmt(exp.amount)}</div>
                  <button type="button" aria-label={`Edit expense: ${exp.description}`} title="Edit expense" onClick={() => openEdit(exp)} style={{ background: "none", border: "none", cursor: "pointer", color: "#c8c8d8", padding: 4, display: "flex", alignItems: "center", transition: "color 0.15s" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "var(--accent)")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#c8c8d8")}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" aria-label={`Delete expense: ${exp.description}`} title="Delete expense" onClick={() => handleDelete(exp.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#c8c8d8", padding: 4, display: "flex", alignItems: "center", transition: "color 0.15s" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#ef4444")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#c8c8d8")}>
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}

            {periodExpenses.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "80px 110px 1fr 70px 92px 80px 32px 32px", padding: "12px 20px", background: "#faf9fd", borderTop: "1px solid #f0f0f5" }}>
                <div style={{ gridColumn: "1 / 6", fontSize: 12, fontWeight: 800, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total</div>
                <div style={{ fontSize: 14, fontWeight: 850, color: "#ef4444" }}>{fmt(totalExpense)} paid{pendingExpense > 0 ? ` · ${fmt(pendingExpense)} pending` : ""}</div>
                <div /><div />
              </div>
            )}
          </div>

        </div>{/* /2-col grid */}

      </div>{/* /desktop-only */}
      {previewImage && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewImage(null)}
          style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(15, 10, 35, 0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <div onClick={(event) => event.stopPropagation()} style={{ width: "min(92vw, 780px)", maxHeight: "88vh", background: "#fff", borderRadius: 14, overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,0.28)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", borderBottom: "1px solid #f0f0f5" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{previewImage.title}</div>
              <button type="button" onClick={() => setPreviewImage(null)} style={{ width: 32, height: 32, border: "none", borderRadius: 8, background: "#faf9fd", color: "#6b6b8a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }} aria-label="Close bill image preview">
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: 14, maxHeight: "calc(88vh - 57px)", overflow: "auto", background: "#faf9fd" }}>
              <div style={{ position: "relative", minHeight: 180, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <a href={previewImage.src} target="_blank" rel="noreferrer" style={{ position: "absolute", zIndex: 0, color: "#6b46c1", fontSize: 13, fontWeight: 850, textDecoration: "none" }}>
                  Open bill image
                </a>
                <img
                  src={previewImage.src}
                  alt={previewImage.title}
                  onError={(event) => { event.currentTarget.style.display = "none"; }}
                  style={{ position: "relative", zIndex: 1, display: "block", maxWidth: "100%", height: "auto", margin: "0 auto", borderRadius: 10, background: "#fff" }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
