export type InvoiceStatus = "paid" | "unpaid" | "overdue";

export interface InvoiceItem {
  description: string;
  qty: number;
  unitPrice: number;
  total: number;
}

export interface Invoice {
  id: string;
  number: string;         // e.g. INV-2026-05
  userId: string;
  userName: string;
  salonName: string;
  userEmail: string;
  userPhone: string;
  planId: string;
  planName: string;
  items: InvoiceItem[];
  subtotal: number;
  tax: number;            // 0 for now
  total: number;
  issuedDate: string;     // YYYY-MM-DD (same day-of-month as plan activation)
  dueDate: string;        // YYYY-MM-DD (7 days after issued)
  status: InvoiceStatus;
  paidDate: string | null;
  /** Service period this invoice covers (YYYY-MM-DD, end exclusive-style: 20 Sep → 20 Oct). */
  periodStart?: string;
  periodEnd?: string;
}

import { userKey } from "./auth";

const BASE_KEY = "werzio_invoices";

export function getInvoices(): Invoice[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(userKey(BASE_KEY)) || "[]"); } catch { return []; }
}

export function saveInvoices(list: Invoice[]) {
  if (typeof window !== "undefined") localStorage.setItem(userKey(BASE_KEY), JSON.stringify(list));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function invoiceNumber(year: number, month: number): string {
  return `INV-${year}-${String(month).padStart(2, "0")}`;
}

function buildInvoice(
  year: number,
  month: number,
  day: number,
  user: { id: string; ownerName: string; salonName: string; email: string; phone: string },
  plan: { id: string; name: string; price: number },
  status: InvoiceStatus,
  paidDate: string | null,
): Invoice {
  // Clamp day to the last day of the given month (e.g. day 31 in April → 30)
  const lastDay = new Date(year, month, 0).getDate();
  const clampedDay = Math.min(day, lastDay);
  const issuedDate = `${year}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
  const dueDate = addDays(issuedDate, 7);
  const item: InvoiceItem = {
    description: `${plan.name} Plan — Monthly Subscription`,
    qty: 1,
    unitPrice: plan.price,
    total: plan.price,
  };
  return {
    id: `${user.id}_${year}_${month}`,
    number: invoiceNumber(year, month),
    userId: user.id,
    userName: user.ownerName,
    salonName: user.salonName,
    userEmail: user.email,
    userPhone: user.phone,
    planId: plan.id,
    planName: plan.name,
    items: [item],
    subtotal: plan.price,
    tax: 0,
    total: plan.price,
    issuedDate,
    dueDate,
    status,
    paidDate,
  };
}

/**
 * Auto-generate monthly invoices starting from the plan activation date.
 * Skips months that already have an invoice. Marks past unpaid as "overdue".
 */
export function syncInvoices(
  user: { id: string; ownerName: string; salonName: string; email: string; phone: string },
  plan: { id: string; name: string; price: number },
  startDate: string,   // account creation / plan activation date YYYY-MM-DD
): Invoice[] {
  const existing = getInvoices();
  const existingIds = new Set(existing.map((i) => i.id));

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Re-evaluate status of existing unpaid/overdue invoices with current grace period
  const OVERDUE_GRACE = 3;
  let existingChanged = false;
  const reEvaluated = existing.map((inv) => {
    if (inv.status === "paid") return inv;
    const overdueCutoff = addDays(inv.dueDate, OVERDUE_GRACE);
    const shouldBeOverdue = today >= overdueCutoff;
    if (shouldBeOverdue && inv.status !== "overdue") { existingChanged = true; return { ...inv, status: "overdue" as InvoiceStatus }; }
    if (!shouldBeOverdue && inv.status === "overdue") { existingChanged = true; return { ...inv, status: "unpaid" as InvoiceStatus }; }
    return inv;
  });

  // First invoice is issued 30 days after signup, then every month after that
  const firstBillingDate = addDays(startDate, 30);
  const start = new Date(firstBillingDate);
  const activationDay = start.getDate(); // e.g. 15 if first billing falls on July 15

  const newInvoices: Invoice[] = [];

  let y = start.getFullYear();
  let m = start.getMonth() + 1; // 1-based

  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    const id = `${user.id}_${y}_${m}`;
    if (!existingIds.has(id)) {
      // Use actual activation day so invoice date matches when the user signed up
      const lastDay = new Date(y, m, 0).getDate();
      const day = Math.min(activationDay, lastDay);
      const issuedDate = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dueDate = addDays(issuedDate, 7);
      let status: InvoiceStatus = "unpaid";
      if (today >= addDays(dueDate, 3)) status = "overdue";
      newInvoices.push(buildInvoice(y, m, activationDay, user, plan, status, null));
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }

  if (newInvoices.length > 0 || existingChanged) {
    const merged = [...newInvoices, ...reEvaluated].sort(
      (a, b) => b.issuedDate.localeCompare(a.issuedDate)
    );
    saveInvoices(merged);
    return merged;
  }

  return reEvaluated.sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));
}

export function markInvoicePaid(id: string): void {
  const list = getInvoices();
  const updated = list.map((inv) =>
    inv.id === id
      ? { ...inv, status: "paid" as InvoiceStatus, paidDate: new Date().toISOString().slice(0, 10) }
      : inv
  );
  saveInvoices(updated);
}
