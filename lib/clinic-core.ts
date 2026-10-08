/**
 * The derived parts of clinic mode — packages, memberships and treatment-plan
 * progress, all counted from invoices and completed appointments. No browser
 * code here, so the server's aftercare cron (app/api/cron/clinic-aftercare)
 * can use the same rules as the screens. lib/clinic.ts re-exports all of it.
 */

import { clientServiceDates } from "./inventory-usage";
import type { Appointment, Service } from "./types";
import type { SalonInvoice } from "./salon-invoices";
import type { TreatmentPlan } from "./clinic";

export const todayKey = () => new Date().toLocaleDateString("en-CA");

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

// ─── Packages (derived from invoices) ────────────────────────────────────────

export interface PatientPackage {
  /** `${invoiceId}:${lineId}` of the line that sold it — what redemption lines point at. */
  id: string;
  clientId: string;
  name: string;
  serviceId: string;
  sessions: number;
  used: number;
  remaining: number;
  /** Each session used, oldest first. */
  usedOn: { date: string; invoiceNumber: string }[];
  purchasedOn: string;
  expiresAt?: string;
  expired: boolean;
  invoiceNumber: string;
  price: number;
  /** Whether the sale that bought it is fully paid. */
  paid: boolean;
}

export function packagesForClient(clientId: string, invoices: SalonInvoice[], today = todayKey()): PatientPackage[] {
  const used = new Map<string, { date: string; invoiceNumber: string }[]>();
  for (const inv of invoices) {
    for (const line of inv.items) {
      if (!line.packageId) continue;
      const list = used.get(line.packageId) ?? [];
      for (let i = 0; i < Math.max(1, line.qty); i++) list.push({ date: inv.date, invoiceNumber: inv.number });
      used.set(line.packageId, list);
    }
  }
  const out: PatientPackage[] = [];
  for (const inv of invoices) {
    if (inv.clientId !== clientId) continue;
    for (const line of inv.items) {
      if (!line.packagePurchase || line.guestName) continue;
      const id = `${inv.id}:${line.id}`;
      // Refunded: whatever was left is cancelled.
      const refunded = (inv.refunds ?? []).some((r) => r.lineIds?.includes(line.id));
      const bought = line.packagePurchase.sessions * Math.max(1, line.qty);
      const usedOn = (used.get(id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
      const expiresAt = line.packagePurchase.expiresAt;
      const sessions = refunded ? Math.min(bought, (used.get(id) ?? []).length) : bought;
      out.push({
        id, clientId, name: line.description + (refunded ? " (refunded)" : ""), serviceId: line.packagePurchase.serviceId, sessions,
        used: usedOn.length, remaining: Math.max(0, sessions - usedOn.length), usedOn,
        purchasedOn: inv.date, expiresAt, expired: !!expiresAt && expiresAt < today,
        invoiceNumber: inv.number, price: line.total, paid: inv.status === "paid",
      });
    }
  }
  return out.sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn));
}

/** Packages that can still pay for a session of `serviceId`. */
export function usablePackages(clientId: string, serviceId: string, invoices: SalonInvoice[]): PatientPackage[] {
  return packagesForClient(clientId, invoices).filter((p) => p.serviceId === serviceId && p.remaining > 0 && !p.expired);
}

// ─── Memberships (derived from invoices, like packages) ──────────────────────

export interface ActiveMembership {
  /** `${invoiceId}:${lineId}` of the sale — what included-treatment lines point at. */
  id: string;
  name: string;
  included: { serviceId: string; perMonth: number }[];
  discountPercent: number;
  perks?: string;
  /** YYYY-MM-DD of the last day it covers. */
  until: string;
  invoiceNumber: string;
}

/** The client's membership covering `today`, the longest-running if several overlap. */
export function activeMembership(clientId: string, invoices: SalonInvoice[], today = todayKey()): ActiveMembership | null {
  let best: ActiveMembership | null = null;
  for (const inv of invoices) {
    if (inv.clientId !== clientId) continue;
    for (const line of inv.items) {
      const m = line.membershipPurchase;
      if (!m || line.guestName || m.from > today || m.until < today) continue;
      if ((inv.refunds ?? []).some((r) => r.lineIds?.includes(line.id))) continue;
      if (!best || m.until > best.until) best = { id: `${inv.id}:${line.id}`, name: line.description, discountPercent: m.discountPercent, perks: m.perks, until: m.until, invoiceNumber: inv.number, included: m.included ?? [] };
    }
  }
  return best;
}

/** Included uses of `serviceId` left this calendar month (YYYY-MM of `today`) on a membership. */
export function membershipAllowanceLeft(m: ActiveMembership, serviceId: string, invoices: SalonInvoice[], today = todayKey()): number {
  const perMonth = m.included.find((x) => x.serviceId === serviceId)?.perMonth ?? 0;
  if (perMonth <= 0) return 0;
  const month = today.slice(0, 7);
  let used = 0;
  for (const inv of invoices) {
    if (!inv.date.startsWith(month)) continue;
    for (const line of inv.items) if (line.membershipUse === m.id && line.sourceId === serviceId) used += Math.max(1, line.qty);
  }
  return Math.max(0, perMonth - used);
}

/** Last day a membership of `months` bought today covers. */
export function membershipUntil(from: string, months: number): string {
  const d = new Date(`${from}T12:00:00`);
  d.setMonth(d.getMonth() + Math.max(1, months));
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA");
}

// ─── Treatment plan progress (derived) ───────────────────────────────────────

export interface PlanSession {
  n: number;
  /** YYYY-MM-DD: when it was done, or when it's due. */
  date: string;
  status: "done" | "upcoming" | "overdue";
}

export function planProgress(
  plan: TreatmentPlan,
  invoices: SalonInvoice[],
  appointments: Appointment[],
  services: Service[],
  today = todayKey(),
): { done: number; remaining: number; sessions: PlanSession[] } {
  const visitDates = new Set<string>();
  for (const serviceId of plan.serviceIds) {
    for (const d of clientServiceDates(plan.clientId, serviceId, invoices, appointments, services)) {
      if (d >= plan.startDate) visitDates.add(d);
    }
  }
  const doneDates = [...visitDates].sort().slice(0, plan.sessions);
  const sessions: PlanSession[] = [];
  let last: string | undefined = doneDates[doneDates.length - 1];
  for (let n = 1; n <= plan.sessions; n++) {
    if (n <= doneDates.length) { sessions.push({ n, date: doneDates[n - 1], status: "done" }); continue; }
    const date: string = last ? addDays(last, plan.intervalDays) : plan.startDate;
    sessions.push({ n, date, status: date < today ? "overdue" : "upcoming" });
    last = date;
  }
  return { done: doneDates.length, remaining: plan.sessions - doneDates.length, sessions };
}

