/**
 * lib/billing.ts
 *
 * Subscription billing shapes and date maths shared by the /admin console and
 * lib/billing-db.ts. Isomorphic like lib/plans.ts — no DB, no `window`.
 *
 * This build has no payment gateway: a business pays over WhatsApp, bank
 * transfer or cash, and a platform admin records the payment in the console.
 * Each payment buys a period — whole months, or a number of days for anything
 * off-cycle (a trial, a pro-rated top-up) — and an account's "paid until" date
 * is the end of the latest payment's period.
 *
 * Each business can also carry its own terms: a custom monthly price that
 * replaces its plan's list price (a negotiated rate), and a default billing
 * cycle the payment form starts from. Nothing is locked automatically when that
 * date passes — the console surfaces it and the admin decides (a reminder, a
 * freeze, or a move to Basic).
 */

import type { PlanId } from "./plans";

export const PAYMENT_METHODS = [
  "Bank transfer", "JazzCash", "EasyPaisa", "Raast", "Cash", "Card", "Other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Quick picks on the payment form; any whole number up to the limits below is accepted. */
export const PAYMENT_MONTH_OPTIONS = [1, 3, 6, 12] as const;
export const MAX_PAYMENT_MONTHS = 36;
export const MAX_PAYMENT_DAYS = 730;

/** Days before the paid-until date at which an account counts as "due soon". */
export const DUE_SOON_DAYS = 7;

export interface SubscriptionPayment {
  id: string;
  ownerId: string;
  /** Snapshots taken when the payment was recorded, so a deleted account's history still reads. */
  ownerEmail: string;
  businessName: string;
  plan: PlanId;
  /** 0 is a complimentary period — a trial or goodwill extension. */
  amountPkr: number;
  /** Whole months bought; 0 when the period was given in days instead. */
  months: number;
  /** Days bought, for a period that isn't whole months; null otherwise. */
  days: number | null;
  method: string;
  reference: string | null;
  note: string | null;
  /** YYYY-MM-DD the money was received. */
  paidAt: string;
  /** YYYY-MM-DD, inclusive. */
  periodStart: string;
  /** YYYY-MM-DD, exclusive — the new paid-until date. */
  periodEnd: string;
  recordedByEmail: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export type BillingStatus = "paid" | "due-soon" | "overdue" | "never-paid";

export interface BillingAccount {
  id: string;
  email: string;
  ownerName: string;
  businessName: string;
  phone: string;
  plan: PlanId;
  /** Negotiated monthly price in PKR, replacing the plan's list price; null = list price. */
  customPricePkr: number | null;
  /** What this business actually pays per month — custom price or list price. */
  monthlyPricePkr: number;
  /** Default period for a new payment, in months; null = 1. */
  billingCycleMonths: number | null;
  accountFrozen: boolean;
  approvalStatus: string;
  createdAt: string;
  paidUntil: string | null;
  status: BillingStatus;
  /** Whole days until paidUntil — negative once overdue, null when never paid. */
  daysLeft: number | null;
  lastPayment: { paidAt: string; amountPkr: number; method: string } | null;
  totalPaidPkr: number;
}

export interface BillingSummary {
  /** Monthly price of every account whose subscription is currently paid up. */
  mrrPkr: number;
  /** Monthly price of every billable account, paid or not — the ceiling MRR could reach. */
  potentialMrrPkr: number;
  collectedThisMonthPkr: number;
  collectedLastMonthPkr: number;
  collectedAllTimePkr: number;
  payingByPlan: Record<PlanId, number>;
  paid: number;
  dueSoon: number;
  overdue: number;
  neverPaid: number;
}

// ─── Dates (all as YYYY-MM-DD, local calendar days) ───────────────────────────

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Calendar-month addition that clamps to the last day of the target month, so
 * 31 Jan + 1 month is 28/29 Feb rather than spilling into March.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * Where a new payment's period begins: straight after the current one when the
 * account is still paid up (renewing early never loses days), otherwise on the
 * day the money arrived.
 */
export function nextPeriodStart(paidUntil: string | null, paidAt: string): string {
  return paidUntil && paidUntil > paidAt ? paidUntil : paidAt;
}

export function billingStatus(paidUntil: string | null, today = todayIso()): { status: BillingStatus; daysLeft: number | null } {
  if (!paidUntil) return { status: "never-paid", daysLeft: null };
  const daysLeft = daysBetween(today, paidUntil);
  if (daysLeft <= 0) return { status: "overdue", daysLeft };
  if (daysLeft <= DUE_SOON_DAYS) return { status: "due-soon", daysLeft };
  return { status: "paid", daysLeft };
}

/** The monthly price a business pays: its custom price when one is set, else the plan's. */
export function monthlyPrice(listPricePkr: number, customPricePkr: number | null | undefined): number {
  return customPricePkr !== null && customPricePkr !== undefined ? customPricePkr : listPricePkr;
}

/** A period of whole months, or of days. */
export type PeriodLength = { months: number; days?: undefined } | { days: number; months?: undefined };

/** End (exclusive) of a period that starts on `start`. */
export function periodEnd(start: string, length: PeriodLength): string {
  return length.days !== undefined ? addDays(start, length.days) : addMonths(start, length.months);
}

/** What a period costs at a monthly price — days are charged at 1/30 of a month. */
export function priceForPeriod(monthlyPricePkr: number, length: PeriodLength): number {
  return Math.round(length.days !== undefined ? (monthlyPricePkr * length.days) / 30 : monthlyPricePkr * length.months);
}

/** "3 months", "45 days". */
export function durationLabel(p: { months: number; days: number | null }): string {
  if (p.days) return `${p.days} day${p.days === 1 ? "" : "s"}`;
  return `${p.months} month${p.months === 1 ? "" : "s"}`;
}

/** "PKR 2,500/month", or "PKR 7,500 every 3 months" for a longer cycle. */
export function cycleLabel(monthlyPricePkr: number, cycleMonths: number | null): string {
  const months = cycleMonths && cycleMonths > 1 ? cycleMonths : 1;
  const amount = `PKR ${Math.round(monthlyPricePkr * months).toLocaleString("en-US")}`;
  return months === 1 ? `${amount}/month` : `${amount} every ${months} months`;
}

/** "0300 1234567" / "+92 300…" → "923001234567", the digits-only form wa.me takes. */
export function whatsAppNumber(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits.length >= 11 ? digits : null;
}
