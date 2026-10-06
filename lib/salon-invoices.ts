// ─── Salon Client Invoicing ────────────────────────────────────────────────────
// These invoices are issued by the salon TO its clients (distinct from the
// platform subscription invoices in lib/invoices.ts which are issued by Salon Central
// TO the salon owner).

import type { PaymentMethod } from "@/lib/types";
import { persistEntity, recordDeletions } from "@/lib/turso-sync";
import { locationUserKey } from "@/lib/locations";

export type SalonInvoiceStatus = "paid" | "unpaid" | "partial";

export type SalonInvoiceItemType = "service" | "product";

export interface SalonInvoiceItem {
  id: string;
  type: SalonInvoiceItemType;
  /**
   * The Service or InventoryItem this line was rung up from. Recorded so back-bar
   * consumption can be counted per item long after the sale (see
   * lib/inventory-usage.ts) without matching on `description`, which is a free
   * text copy that drifts the moment a service is renamed. Absent on invoices
   * written before this field existed, and on hand-typed lines.
   */
  sourceId?: string;
  /**
   * Marks this line as sold on top of what the client originally came in for.
   *
   * Set automatically on any line added while editing an existing invoice — the
   * bill was written when the client arrived, so anything appended after that
   * was sold during the visit — and toggleable by hand for the cases that rule
   * misses. Needed because most salons take walk-ins with no booking to compare
   * the bill against, which is the only other way to tell an upsell from the
   * job the client came for.
   */
  upsell?: boolean;
  description: string;
  qty: number;
  unitPrice: number;
  total: number;
  /**
   * Who this line is for when one bill covers several related people (a mother
   * and daughter seen together, say). Absent on the main client's own lines,
   * which is every line on an ordinary single-person invoice.
   */
  guestName?: string;
  /**
   * Per-day prices when one line covers the same service on several days of a
   * multi-day booking (qty = number of days). Printed under the description.
   */
  dayBreakdown?: { label: string; amount: number }[];
}

/**
 * Invoice lines split per person, main client first, for invoices that cover
 * several related people. A single-person invoice comes back as one group with
 * no name, which renderers print as a plain list.
 */
export function invoiceItemsByPerson(invoice: Pick<SalonInvoice, "items" | "clientName">): { name: string | null; items: SalonInvoiceItem[] }[] {
  const groups: { name: string | null; items: SalonInvoiceItem[] }[] = [];
  for (const item of invoice.items) {
    const name = item.guestName?.trim() ? item.guestName.trim() : null;
    const existing = groups.find((g) => g.name === name);
    if (existing) existing.items.push(item);
    else groups.push({ name, items: [item] });
  }
  // Nothing to split — an ordinary invoice.
  if (groups.length <= 1 && !groups.some((g) => g.name)) return groups;
  return groups.map((g) => ({ ...g, name: g.name ?? invoice.clientName }));
}

export interface SalonInvoice {
  id: string;
  number: string;           // e.g. "SI-2026-0001"
  appointmentId?: string;   // optional link to an appointment
  clientId?: string;
  clientName: string;
  clientPhone: string;
  clientEmail?: string;
  staffName: string;
  /** Who made the sale. Absent on invoices written before this was recorded, where staffName is the only clue. */
  staffId?: string;
  items: SalonInvoiceItem[];
  subtotal: number;
  discountAmount: number;   // flat discount in PKR (primary discount + loyalty redemption combined)
  discount2Amount?: number; // flat discount in PKR — separate, additional discount stacked on top of discountAmount
  taxAmount: number;        // 0 for now; ready for future
  total: number;
  paymentMethod: PaymentMethod | "";
  /**
   * Card sales only. The card machine isn't connected to the POS, so the cashier
   * copies these off the machine's slip — they're what lets a day's card sales be
   * matched against each bank's settlement statement.
   */
  cardTerminal?: string;      // which machine took it, e.g. "HBL" (one of CARD_TERMINALS)
  cardApprovalCode?: string;  // approval / auth code printed on the slip
  cardLast4?: string;         // last 4 digits of the customer's card
  date: string;             // YYYY-MM-DD — when the invoice was issued
  paidDate?: string;        // YYYY-MM-DD — when it was actually marked paid; unset while unpaid
  status: SalonInvoiceStatus;
  /**
   * PKR taken up front on a "partial" sale (a 50% advance, typically). Unset on
   * every other status. The balance still owed is `total - advanceAmount`.
   */
  advanceAmount?: number;
  notes?: string;
  createdAt: string;        // ISO timestamp
  source?: "pos" | "manual";
  /** Which salon section this sale belongs to (e.g. "Men's", "Women's"). Free text, cosmetic only. */
  section?: string;
  /** Fiscal invoice number FBR issued for this sale; printed with its QR code. */
  fbrInvoiceNumber?: string;
  /** Why the last FBR report failed; cleared once it goes through. */
  fbrError?: string;
}

/**
 * Reports the invoice to FBR (when the salon has it switched on), saves the
 * result onto the invoice, and returns the updated copy. Never throws — a sale
 * that couldn't reach FBR is kept with fbrError so it can be sent again later.
 */
export async function reportInvoiceToFbr(invoice: SalonInvoice): Promise<SalonInvoice> {
  let updated: SalonInvoice;
  try {
    const res = await fetch("/api/fbr/invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice }),
    });
    const data = await res.json() as { ok: boolean; fbrInvoiceNumber?: string; error?: string };
    updated = data.ok && data.fbrInvoiceNumber
      ? { ...invoice, fbrInvoiceNumber: data.fbrInvoiceNumber, fbrError: undefined }
      : { ...invoice, fbrError: data.error || "FBR report failed" };
  } catch {
    updated = { ...invoice, fbrError: "No internet — couldn't reach FBR." };
  }
  updateSalonInvoice(updated);
  return updated;
}

/**
 * What this sale contributes to revenue totals.
 *
 * Only "partial" is special-cased, deliberately: it counts the advance actually
 * collected rather than the full ticket. "paid" and "unpaid" keep exactly the
 * behaviour they had before advances existed (both count their full total in
 * the revenue screens), so introducing advances doesn't quietly restate
 * historical figures.
 */
export function revenueAmount(inv: Pick<SalonInvoice, "status" | "total" | "advanceAmount">): number {
  return inv.status === "partial" ? (inv.advanceAmount ?? 0) : inv.total;
}

/** Still owed on a partial sale; 0 for anything else. */
export function balanceDue(inv: Pick<SalonInvoice, "status" | "total" | "advanceAmount">): number {
  return inv.status === "partial" ? Math.max(0, inv.total - (inv.advanceAmount ?? 0)) : 0;
}

/** What fraction of the total the advance is, as a whole number percent (e.g. 50); 0 when there's no advance or no total to divide by. */
export function advancePercent(inv: Pick<SalonInvoice, "total" | "advanceAmount">): number {
  const total = inv.total || 0;
  const advance = inv.advanceAmount ?? 0;
  return total > 0 && advance > 0 ? Math.round((advance / total) * 100) : 0;
}

/** The card machines the salon has. Card sales record which one took the payment. */
export const CARD_TERMINALS = ["Meezan Bank", "Bank Alfalah", "HBL", "UBL", "Keenu"] as const;

/** "Card · HBL" for a card sale with a known machine, otherwise just the method's own label. */
export function paymentMethodLabel(inv: Pick<SalonInvoice, "paymentMethod" | "cardTerminal">, labels: Record<string, string>): string {
  const base = labels[inv.paymentMethod] ?? inv.paymentMethod;
  return inv.paymentMethod === "card" && inv.cardTerminal ? `${base} · ${inv.cardTerminal}` : base;
}

/**
 * The time the invoice was created, e.g. "3:45 pm", in Pakistan time — fixed
 * rather than the viewer's zone because the WhatsApp PDF is built on the server,
 * which runs in UTC. Empty when the creation moment isn't on the invoice's own
 * date (a manual invoice dated after the fact), where the time it was typed in
 * would be misleading.
 */
export function invoiceTimeLabel(inv: Pick<SalonInvoice, "date" | "createdAt">): string {
  const created = new Date(inv.createdAt);
  if (!inv.createdAt || Number.isNaN(created.getTime())) return "";
  const createdDay = created.toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }); // YYYY-MM-DD
  if (createdDay !== inv.date) return "";
  return created.toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Karachi" });
}

/** Shown on any invoice carrying an advance, on screen and on the PDF. */
export const ADVANCE_NON_REFUNDABLE_NOTE = "Advance payment is non-refundable.";

/** Printed on every invoice — A4, PDF and thermal receipt. */
export const PAYMENT_NON_REFUNDABLE_NOTE = "Payment is non-refundable.";

// ─── Storage ──────────────────────────────────────────────────────────────────

const BASE_KEY     = "werzio_salon_invoices";
const BASE_COUNTER = "werzio_salon_invoice_counter";

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getSalonInvoices(): SalonInvoice[] {
  if (typeof window === "undefined") return [];
  try {
    const key = locationUserKey(BASE_KEY);
    const parsed = JSON.parse(localStorage.getItem(key) || "[]") as SalonInvoice[];
    let migrated = false;
    const invoices = parsed.map((invoice) => {
      if (invoice.source !== "pos" || !invoice.createdAt) return invoice;
      const createdAt = new Date(invoice.createdAt);
      if (Number.isNaN(createdAt.getTime())) return invoice;
      const utcDate = invoice.createdAt.slice(0, 10);
      const localDate = localDateKey(createdAt);
      if (invoice.date !== utcDate || invoice.date === localDate) return invoice;
      migrated = true;
      return { ...invoice, date: localDate };
    });
    if (migrated) {
      persistEntity("salon_invoices", invoices);
    }
    return invoices;
  } catch {
    return [];
  }
}

/**
 * Saves locally (always) and returns the Turso write's outcome so a caller
 * that needs to know whether the save actually reached the shared database
 * (POS checkout) can await it. Callers that don't care can call this without
 * awaiting — same fire-and-forget behavior as before.
 */
export function saveSalonInvoices(list: SalonInvoice[]): Promise<boolean> {
  if (typeof window !== "undefined") {
    return persistEntity("salon_invoices", list);
  }
  return Promise.resolve(false);
}

function nextInvoiceNumber(): string {
  if (typeof window === "undefined") return "SI-0001";
  const counterKey = locationUserKey(BASE_COUNTER);
  const n = parseInt(localStorage.getItem(counterKey) || "0", 10) + 1;
  localStorage.setItem(counterKey, String(n));
  const year = new Date().getFullYear();
  return `SI-${year}-${String(n).padStart(4, "0")}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Creates the invoice and awaits the Turso write, reporting whether it
 * actually landed — checkout can then warn the cashier on failure instead of
 * silently leaving the sale invisible on every device but the one that rang
 * it up (the previous fire-and-forget save could fail with nothing but a
 * console warning, which is how invoices went missing from the shared DB
 * while their WhatsApp receipts still sent).
 */
export async function createSalonInvoice(
  draft: Omit<SalonInvoice, "id" | "number" | "createdAt">
): Promise<{ invoice: SalonInvoice; dbSaved: boolean }> {
  const invoice: SalonInvoice = {
    ...draft,
    id: crypto.randomUUID(),
    number: nextInvoiceNumber(),
    createdAt: new Date().toISOString(),
  };
  const list = [invoice, ...getSalonInvoices()];
  const dbSaved = await saveSalonInvoices(list);
  return { invoice, dbSaved };
}

export function updateSalonInvoice(updated: SalonInvoice): void {
  const list = getSalonInvoices().map((inv) => (inv.id === updated.id ? updated : inv));
  saveSalonInvoices(list);
}

/**
 * Removing the invoice from the list is not enough on its own to make the
 * delete stick — the queued WhatsApp receipt and other devices' localStorage
 * both merge it back (see lib/deleted-records.ts), which is why deleted
 * invoices used to reappear minutes later. The tombstone is what makes it
 * permanent, so it is recorded first and awaited by callers that care.
 */
export async function deleteSalonInvoice(id: string): Promise<void> {
  const tombstoned = recordDeletions("salon_invoices", [id]);
  saveSalonInvoices(getSalonInvoices().filter((inv) => inv.id !== id));

  // A deleted invoice may still have a WhatsApp receipt queued from checkout —
  // cancel it so the client isn't sent an "Invoice" message for a sale that no
  // longer exists, and so the salon_invoices GET stops merging the queued copy
  // back into the invoice list.
  const cancelled = typeof window === "undefined"
    ? Promise.resolve()
    : fetch(`/api/whatsapp/queue-pos-receipt?invoiceId=${encodeURIComponent(id)}`, { method: "DELETE" })
        .then(() => undefined)
        .catch((err) => console.error("[salon-invoices] Failed to cancel queued receipt:", err));

  await Promise.all([tombstoned, cancelled]);
}

export function markSalonInvoicePaid(id: string, paymentMethod: PaymentMethod, paidDate?: string): void {
  const list = getSalonInvoices().map((inv) =>
    inv.id === id ? { ...inv, status: "paid" as SalonInvoiceStatus, paymentMethod, paidDate: paidDate || localDateKey() } : inv
  );
  saveSalonInvoices(list);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function calcTotals(
  items: SalonInvoiceItem[],
  discountAmount: number,
  taxRate = 0
): { subtotal: number; taxAmount: number; total: number } {
  const subtotal = Math.round(items.reduce((s, i) => s + i.total, 0));
  const discount = Math.min(Math.max(0, Math.round(discountAmount)), subtotal);
  const taxAmount = Math.round((subtotal - discount) * taxRate);
  const total = Math.max(0, Math.round(subtotal - discount + taxAmount));
  return { subtotal, taxAmount, total };
}

export function newBlankItem(): SalonInvoiceItem {
  return {
    id: crypto.randomUUID(),
    type: "service",
    description: "",
    qty: 1,
    unitPrice: 0,
    total: 0,
  };
}
