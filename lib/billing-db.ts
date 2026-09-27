/**
 * lib/billing-db.ts
 * Server-side billing state stored in Turso (SQLite).
 *
 * Billing model — 7-day demo, then 30-day rolling cycles (not calendar months):
 *   • billing_anchor  = signup_date + 7 days    (first invoice issued after demo)
 *   • cycle_index     = floor((today − anchor) / 30)  starting at 0
 *   • period_start    = anchor + cycle_index × 30 days
 *   • due_date        = period_start + 30 days  (30 days to pay)
 *   • overdue on      due_date                  (no extra grace)
 *   • suspended on    due_date                  (no extra grace)
 *
 * Invoice ID format : {userId}_{period_start}   e.g.  user_123_2026-05-15
 * Invoice number    : INV-{YYYYMMDD}              e.g.  INV-20260515
 */

import { db } from "@/lib/db";
import type { InValue } from "@libsql/client";
import { DEFAULT_BANK_DETAILS } from "@/lib/billing-constants";

export { DEFAULT_BANK_DETAILS };

// ─── Billing constants ────────────────────────────────────────────────────────
export const TRIAL_DAYS = 7;
export const BILLING_CYCLE_DAYS = 30;
export const INVOICE_DUE_DAYS = 30;
export const OVERDUE_GRACE_DAYS = 0;     // overdue immediately at invoice due_date
export const SUSPENSION_GRACE_DAYS = 0;  // suspend immediately at due_date

// ─── Schema ───────────────────────────────────────────────────────────────────

export async function ensureBillingTables(): Promise<void> {
  // Core tables
  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_users (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL,
      owner_name        TEXT NOT NULL,
      salon_name        TEXT NOT NULL,
      phone             TEXT,
      plan_id           TEXT NOT NULL,
      plan_name         TEXT NOT NULL,
      plan_price        INTEGER NOT NULL,
      billing_term_months INTEGER NOT NULL DEFAULT 1,
      trial_start       TEXT NOT NULL,
      is_demo_signup    INTEGER NOT NULL DEFAULT 0,
      billing_anchor    TEXT,
      suspended         INTEGER NOT NULL DEFAULT 0,
      suspension_reason TEXT,
      created_at        TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_invoices (
      id                    TEXT PRIMARY KEY,
      user_id               TEXT NOT NULL,
      number                TEXT NOT NULL,
      amount                INTEGER NOT NULL,
      status                TEXT NOT NULL DEFAULT 'unpaid',
      period_start          TEXT NOT NULL DEFAULT '',
      issued_date           TEXT NOT NULL,
      due_date              TEXT NOT NULL,
      paid_date             TEXT,
      notified_issued_at    TEXT,
      notified_overdue_at   TEXT,
      notified_suspended_at TEXT,
      created_at            TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES billing_users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_run_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      mode               TEXT NOT NULL,
      run_at             TEXT NOT NULL,
      invoices_generated INTEGER DEFAULT 0,
      emails_sent        INTEGER DEFAULT 0,
      users_suspended    INTEGER DEFAULT 0
    )
  `);

  // A reusable library of bank accounts an admin can pick from per salon —
  // e.g. different DBAs/legal entities — rather than typing one-off details
  // into every salon's row. A salon with no payment_method_id picked falls
  // back to DEFAULT_BANK_DETAILS below.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      bank_name       TEXT NOT NULL DEFAULT '',
      bank_title      TEXT NOT NULL,
      account_number  TEXT NOT NULL,
      iban            TEXT NOT NULL,
      created_at      TEXT NOT NULL
    )
  `);

  // ── Migrations: add columns that may not exist in older deployments ──────────
  for (const [table, column, def] of [
    ["billing_users",    "billing_anchor",    "TEXT"],
    ["billing_users",    "is_demo_signup",    "INTEGER NOT NULL DEFAULT 0"],
    ["billing_users",    "billing_term_months", "INTEGER NOT NULL DEFAULT 1"],
    ["billing_invoices", "period_start",      "TEXT NOT NULL DEFAULT ''"],
    // Which payment_methods row (if any) this salon's invoice should show —
    // null means "use DEFAULT_BANK_DETAILS", so existing accounts are unaffected.
    ["billing_users",    "payment_method_id", "TEXT"],
    // Added after payment_methods' initial release — backfills existing rows
    // with an empty string rather than leaving them without the column.
    ["payment_methods",  "bank_name",         "TEXT NOT NULL DEFAULT ''"],
    // Whether an admin manually re-dated this invoice (via /api/billing/set-due-date).
    // When set, later price/term/plan changes keep the manual date instead of
    // recomputing it and silently undoing the admin's extension.
    ["billing_invoices", "due_date_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
      .catch(() => { /* column already exists — ignore */ });
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BillingUser {
  id: string;
  email: string;
  ownerName: string;
  salonName: string;
  phone: string;
  planId: string;
  planName: string;
  planPrice: number;
  billingTermMonths: number;
  trialStart: string;     // YYYY-MM-DD
  /** True only for accounts that picked "7-Day Demo" at sign-up — everyone
   *  else (Starter/Pro/Premium chosen directly) is billed from day one. */
  isDemoSignup: boolean;
  billingAnchor: string | null; // YYYY-MM-DD — set on first invoice, null until then
  suspended: boolean;
  suspensionReason: string | null;
  createdAt: string;
  /** Which payment_methods row this salon's invoice shows — null means "use DEFAULT_BANK_DETAILS". */
  paymentMethodId: string | null;
}

export interface PaymentMethod {
  id: string;
  label: string;         // shown in the admin's dropdown, e.g. "Tareez Tech — Bank Alfalah"
  bankName: string;      // the bank itself, e.g. "Bank Alfalah"
  bankTitle: string;     // the account title, e.g. "TAREEZ TECH"
  accountNumber: string;
  iban: string;
  createdAt: string;
}

export interface BillingInvoice {
  id: string;
  userId: string;
  number: string;
  amount: number;
  status: "unpaid" | "paid" | "overdue";
  periodStart: string;    // YYYY-MM-DD — start of the 30-day period
  issuedDate: string;
  dueDate: string;
  paidDate: string | null;
  notifiedIssuedAt: string | null;
  notifiedOverdueAt: string | null;
  notifiedSuspendedAt: string | null;
  createdAt: string;
}

export interface BillingAdminSummary {
  userId: string;
  planId: string;
  planName: string;
  billingTermMonths: number;
  trialStart: string;
  invoiceDueDate: string | null;
  /** Id of the current (newest-period) unpaid/overdue invoice — the one the
   *  salon's own Billing page shows as "latest", so admins can re-date the
   *  invoice the salon actually sees rather than an older unpaid one. */
  invoiceId: string | null;
}

// ─── Row → typed objects ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToUser(r: any): BillingUser {
  const billingTermMonths = Math.max(1, Math.floor(Number(r.billing_term_months) || 1));
  return {
    id:               r.id as string,
    email:            r.email as string,
    ownerName:        r.owner_name as string,
    salonName:        r.salon_name as string,
    phone:            (r.phone as string) ?? "",
    planId:           r.plan_id as string,
    planName:         r.plan_name as string,
    planPrice:        r.plan_price as number,
    billingTermMonths,
    trialStart:       r.trial_start as string,
    isDemoSignup:     (r.is_demo_signup as number) === 1,
    billingAnchor:    (r.billing_anchor as string) ?? null,
    suspended:        (r.suspended as number) === 1,
    suspensionReason: (r.suspension_reason as string) ?? null,
    createdAt:        r.created_at as string,
    paymentMethodId:  (r.payment_method_id as string) || null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToInvoice(r: any): BillingInvoice {
  return {
    id:                   r.id as string,
    userId:               r.user_id as string,
    number:               r.number as string,
    amount:               r.amount as number,
    status:               r.status as BillingInvoice["status"],
    periodStart:          (r.period_start as string) ?? "",
    issuedDate:           r.issued_date as string,
    dueDate:              r.due_date as string,
    paidDate:             (r.paid_date as string) ?? null,
    notifiedIssuedAt:     (r.notified_issued_at as string) ?? null,
    notifiedOverdueAt:    (r.notified_overdue_at as string) ?? null,
    notifiedSuspendedAt:  (r.notified_suspended_at as string) ?? null,
    createdAt:            r.created_at as string,
  };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Add N days to a YYYY-MM-DD string, returns YYYY-MM-DD. */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Difference in whole days (a − b). Positive if a is later. */
function daysDiff(a: string, b: string): number {
  const ms = new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Compute the billing anchor. The very first invoice is issued on this date.
 * Only accounts that actually picked "7-Day Demo" at sign-up get the trial
 * week — everyone who chose Starter/Pro/Premium directly is billed from
 * their signup date with no free period.
 */
export function computeBillingAnchor(signupDate: string, isDemoSignup: boolean): string {
  return isDemoSignup ? addDays(signupDate, TRIAL_DAYS) : signupDate;
}

/** Returns true if today is still within the demo period before first billing. */
export function isInTrial(signupDate: string, isDemoSignup: boolean): boolean {
  if (!isDemoSignup) return false;
  const today  = new Date().toISOString().slice(0, 10);
  const anchor = computeBillingAnchor(signupDate, isDemoSignup);
  return today < anchor;
}

/**
 * Given a billing anchor, return the period_start for the 30-day cycle that
 * contains `today`.  Returns null if today is still before the anchor.
 */
export function currentPeriodStart(anchor: string, today?: string, cycleDays = BILLING_CYCLE_DAYS): string | null {
  const t = today ?? new Date().toISOString().slice(0, 10);
  const elapsed = daysDiff(t, anchor);
  if (elapsed < 0) return null;                        // still in trial
  const safeCycleDays = Math.max(1, cycleDays);
  const cycleIndex = Math.floor(elapsed / safeCycleDays);
  return addDays(anchor, cycleIndex * safeCycleDays);
}

function billingCycleDays(termMonths: number): number {
  return Math.max(1, termMonths) * BILLING_CYCLE_DAYS;
}

// ─── Billing Users ─────────────────────────────────────────────────────────────

export async function upsertBillingUser(
  user: Omit<BillingUser, "billingTermMonths" | "billingAnchor" | "suspended" | "suspensionReason" | "createdAt" | "paymentMethodId"> & { billingTermMonths?: BillingUser["billingTermMonths"] }
): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO billing_users (id, email, owner_name, salon_name, phone, plan_id, plan_name, plan_price, billing_term_months, trial_start, is_demo_signup, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email       = excluded.email,
        owner_name  = excluded.owner_name,
        salon_name  = excluded.salon_name,
        phone       = excluded.phone,
        plan_id     = excluded.plan_id,
        plan_name   = excluded.plan_name,
        plan_price  = excluded.plan_price,
        billing_term_months = excluded.billing_term_months
    `,
    args: [
      user.id, user.email, user.ownerName, user.salonName, user.phone,
      user.planId, user.planName, user.planPrice, user.billingTermMonths ?? 1, user.trialStart, user.isDemoSignup ? 1 : 0,
      new Date().toISOString(),
    ],
  });
}

export async function getBillingUser(id: string): Promise<BillingUser | null> {
  const res = await db.execute({ sql: "SELECT * FROM billing_users WHERE id = ?", args: [id] });
  return res.rows.length ? rowToUser(res.rows[0]) : null;
}

export async function getAllActiveBillingUsers(): Promise<BillingUser[]> {
  const res = await db.execute("SELECT * FROM billing_users");
  return res.rows.map(rowToUser);
}

export async function getBillingAdminSummaries(userIds: string[]): Promise<Map<string, BillingAdminSummary>> {
  await ensureBillingTables();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => "?").join(", ");
  const res = await db.execute({
    sql: `
      SELECT
        bu.id,
        bu.plan_id,
        bu.plan_name,
        bu.trial_start,
        bu.is_demo_signup,
        bu.billing_term_months,
        (
          SELECT bi.due_date
          FROM billing_invoices bi
          WHERE bi.user_id = bu.id
            AND bi.status IN ('unpaid', 'overdue')
          ORDER BY bi.period_start DESC
          LIMIT 1
        ) AS invoice_due_date,
        (
          SELECT bi.id
          FROM billing_invoices bi
          WHERE bi.user_id = bu.id
            AND bi.status IN ('unpaid', 'overdue')
          ORDER BY bi.period_start DESC
          LIMIT 1
        ) AS invoice_id
      FROM billing_users bu
      WHERE bu.id IN (${placeholders})
    `,
    args: ids as InValue[],
  });

  const summaries = new Map<string, BillingAdminSummary>();
  for (const row of res.rows) {
    const userId = row.id as string;
    const trialStart = row.trial_start as string;
    const isDemoSignup = (row.is_demo_signup as number) === 1;
    const billingTermMonths = Math.max(1, Math.floor(Number(row.billing_term_months) || 1));
    const invoiceDueDate = (row.invoice_due_date as string | null) ?? addDays(computeBillingAnchor(trialStart, isDemoSignup), billingCycleDays(billingTermMonths));
    summaries.set(userId, {
      userId,
      planId: row.plan_id as string,
      planName: row.plan_name as string,
      billingTermMonths,
      trialStart,
      invoiceDueDate,
      invoiceId: (row.invoice_id as string | null) ?? null,
    });
  }
  return summaries;
}

export async function suspendUser(userId: string, reason: string): Promise<void> {
  await db.execute({
    sql: "UPDATE billing_users SET suspended = 1, suspension_reason = ? WHERE id = ?",
    args: [reason, userId],
  });
}

/** Admin override: set a custom term price for a user, independent of their plan tier. */
export async function setCustomPlanPrice(userId: string, price: number, billingTermMonths = 1): Promise<void> {
  await db.execute({
    sql: "UPDATE billing_users SET plan_price = ?, billing_term_months = ? WHERE id = ?",
    args: [price, billingTermMonths, userId],
  });
}

/** Admin: point this salon's invoice at a payment_methods row (or null to fall back to DEFAULT_BANK_DETAILS). */
export async function setPaymentMethodForUser(userId: string, paymentMethodId: string | null): Promise<void> {
  await db.execute({
    sql: `UPDATE billing_users SET payment_method_id = ? WHERE id = ?`,
    args: [paymentMethodId, userId],
  });
}

// ─── Payment Methods (admin-managed library of bank accounts) ────────────────

function rowToPaymentMethod(r: Record<string, unknown>): PaymentMethod {
  return {
    id:            r.id as string,
    label:         r.label as string,
    bankName:      (r.bank_name as string) ?? "",
    bankTitle:     r.bank_title as string,
    accountNumber: r.account_number as string,
    iban:          r.iban as string,
    createdAt:     r.created_at as string,
  };
}

export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  await ensureBillingTables();
  const res = await db.execute("SELECT * FROM payment_methods ORDER BY created_at ASC");
  return res.rows.map((r) => rowToPaymentMethod(r as unknown as Record<string, unknown>));
}

export async function createPaymentMethod(input: { label: string; bankName: string; bankTitle: string; accountNumber: string; iban: string }): Promise<PaymentMethod> {
  await ensureBillingTables();
  const id = `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO payment_methods (id, label, bank_name, bank_title, account_number, iban, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, input.label.trim(), input.bankName.trim(), input.bankTitle.trim(), input.accountNumber.trim(), input.iban.trim(), createdAt],
  });
  return { id, label: input.label.trim(), bankName: input.bankName.trim(), bankTitle: input.bankTitle.trim(), accountNumber: input.accountNumber.trim(), iban: input.iban.trim(), createdAt };
}

export async function updatePaymentMethod(id: string, input: { label: string; bankName: string; bankTitle: string; accountNumber: string; iban: string }): Promise<void> {
  await ensureBillingTables();
  await db.execute({
    sql: `UPDATE payment_methods SET label = ?, bank_name = ?, bank_title = ?, account_number = ?, iban = ? WHERE id = ?`,
    args: [input.label.trim(), input.bankName.trim(), input.bankTitle.trim(), input.accountNumber.trim(), input.iban.trim(), id],
  });
}

/** Deletes the payment method — salons pointed at it fall back to DEFAULT_BANK_DETAILS. */
export async function deletePaymentMethod(id: string): Promise<void> {
  await ensureBillingTables();
  await db.execute({ sql: `UPDATE billing_users SET payment_method_id = NULL WHERE payment_method_id = ?`, args: [id] });
  await db.execute({ sql: `DELETE FROM payment_methods WHERE id = ?`, args: [id] });
}

export async function getPaymentMethod(id: string): Promise<PaymentMethod | null> {
  await ensureBillingTables();
  const res = await db.execute({ sql: "SELECT * FROM payment_methods WHERE id = ?", args: [id] });
  return res.rows.length ? rowToPaymentMethod(res.rows[0] as unknown as Record<string, unknown>) : null;
}

/** Resolves what should actually be shown on a salon's invoice — their picked method, or the platform default. */
export async function resolveBankDetailsForUser(user: BillingUser): Promise<{ bankName: string; title: string; accountNumber: string; iban: string }> {
  if (user.paymentMethodId) {
    const method = await getPaymentMethod(user.paymentMethodId);
    if (method) return { bankName: method.bankName, title: method.bankTitle, accountNumber: method.accountNumber, iban: method.iban };
  }
  return DEFAULT_BANK_DETAILS;
}

export async function unsuspendUser(userId: string): Promise<void> {
  await db.execute({
    sql: "UPDATE billing_users SET suspended = 0, suspension_reason = NULL WHERE id = ?",
    args: [userId],
  });
}

/** Persist the billing_anchor once it's computed for the first time. */
async function setBillingAnchor(userId: string, anchor: string): Promise<void> {
  await db.execute({
    sql: "UPDATE billing_users SET billing_anchor = ? WHERE id = ? AND (billing_anchor IS NULL OR billing_anchor = '')",
    args: [anchor, userId],
  });
}

/**
 * Admin override: change the date a salon started. Before its first invoice the
 * billing schedule (demo end, first due date) follows the new date, so the
 * saved anchor is cleared to be recomputed from it. Once invoices exist the
 * anchor stays put — moving it would start a second, overlapping invoice cycle
 * — and the admin re-dates the open invoice with its own due-date control.
 */
export async function updateTrialStart(userId: string, startDate: string): Promise<{ scheduleMoved: boolean }> {
  const invoices = await db.execute({ sql: "SELECT 1 FROM billing_invoices WHERE user_id = ? LIMIT 1", args: [userId] });
  const scheduleMoved = invoices.rows.length === 0;
  await db.execute({
    sql: scheduleMoved
      ? "UPDATE billing_users SET trial_start = ?, billing_anchor = NULL WHERE id = ?"
      : "UPDATE billing_users SET trial_start = ? WHERE id = ?",
    args: [startDate, userId],
  });
  return { scheduleMoved };
}

// ─── Billing Invoices — 30-day cycles ─────────────────────────────────────────

function invoiceId(userId: string, periodStart: string): string {
  return `${userId}_${periodStart}`;
}

function invoiceNumber(periodStart: string): string {
  // INV-YYYYMMDD  e.g. INV-20260515
  return "INV-" + periodStart.replace(/-/g, "");
}

/**
 * Idempotently create the invoice for the 30-day period that contains today.
 * Returns null if still in trial.
 */
export async function getOrCreate30DayInvoice(
  user: BillingUser
): Promise<{ invoice: BillingInvoice; created: boolean } | null> {
  const anchor = user.billingAnchor ?? computeBillingAnchor(user.trialStart, user.isDemoSignup);
  const periodStart = currentPeriodStart(anchor, undefined, billingCycleDays(user.billingTermMonths));
  if (!periodStart) return null;  // still in trial

  // Persist the anchor if not yet saved
  if (!user.billingAnchor) await setBillingAnchor(user.id, anchor);

  const id = invoiceId(user.id, periodStart);

  // Return existing invoice if already created for this period
  const existing = await db.execute({ sql: "SELECT * FROM billing_invoices WHERE id = ?", args: [id] });
  if (existing.rows.length) {
    return { invoice: rowToInvoice(existing.rows[0]), created: false };
  }

  // Create new invoice
  const dueDate = addDays(periodStart, billingCycleDays(user.billingTermMonths));
  const now     = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO billing_invoices
            (id, user_id, number, amount, status, period_start, issued_date, due_date, created_at)
          VALUES (?, ?, ?, ?, 'unpaid', ?, ?, ?, ?)`,
    args: [id, user.id, invoiceNumber(periodStart), user.planPrice, periodStart, periodStart, dueDate, now],
  });

  const created = await db.execute({ sql: "SELECT * FROM billing_invoices WHERE id = ?", args: [id] });
  return { invoice: rowToInvoice(created.rows[0]), created: true };
}

/**
 * Get the invoice for the current 30-day cycle (if it exists).
 * Used when approving payments / unsuspending.
 */
export async function getCurrentCycleInvoice(userId: string): Promise<BillingInvoice | null> {
  // Get the user's billing anchor first
  const user = await getBillingUser(userId);
  if (!user) return null;

  const anchor = user.billingAnchor ?? computeBillingAnchor(user.trialStart, user.isDemoSignup);
  const periodStart = currentPeriodStart(anchor, undefined, billingCycleDays(user.billingTermMonths));
  if (!periodStart) return null;

  const id = invoiceId(userId, periodStart);
  const res = await db.execute({ sql: "SELECT * FROM billing_invoices WHERE id = ?", args: [id] });
  return res.rows.length ? rowToInvoice(res.rows[0]) : null;
}

/**
 * Get all invoices for a user that are unpaid/overdue (any cycle).
 */
export async function getAllUnpaidInvoicesForUser(userId: string): Promise<BillingInvoice[]> {
  const res = await db.execute({
    sql: "SELECT * FROM billing_invoices WHERE user_id = ? AND status IN ('unpaid', 'overdue') ORDER BY period_start ASC",
    args: [userId],
  });
  return res.rows.map(rowToInvoice);
}

/**
 * All invoices that are unpaid/overdue AND at least OVERDUE_GRACE_DAYS past their due_date.
 * Overdue/suspension triggers on day 40 (due_date + 3).
 * Used by the daily cron.
 */
export async function getAllUnpaidOverdueInvoices(): Promise<BillingInvoice[]> {
  const today = new Date().toISOString().slice(0, 10);
  // Only trigger if today >= due_date + OVERDUE_GRACE_DAYS
  const overdueThreshold = addDays(today, -OVERDUE_GRACE_DAYS);
  const res = await db.execute({
    sql: "SELECT * FROM billing_invoices WHERE status IN ('unpaid','overdue') AND due_date <= ?",
    args: [overdueThreshold],
  });
  return res.rows.map(rowToInvoice);
}

export async function markInvoiceOverdue(id: string): Promise<void> {
  await db.execute({
    sql: "UPDATE billing_invoices SET status = 'overdue' WHERE id = ? AND status = 'unpaid'",
    args: [id],
  });
}

/**
 * Admin override: re-price an invoice that hasn't been paid yet (e.g. after a
 * custom price change). The recomputed due date only applies when the invoice
 * wasn't manually re-dated by an admin — a manual extension is preserved so
 * the salon never sees its due date silently snap back.
 */
export async function updateInvoiceAmount(invoiceId: string, amount: number, dueDate?: string): Promise<void> {
  await db.execute({
    sql: dueDate
      ? "UPDATE billing_invoices SET amount = ?, due_date = CASE WHEN due_date_overridden = 1 THEN due_date ELSE ? END WHERE id = ? AND status IN ('unpaid', 'overdue')"
      : "UPDATE billing_invoices SET amount = ? WHERE id = ? AND status IN ('unpaid', 'overdue')",
    args: dueDate ? [amount, dueDate, invoiceId] : [amount, invoiceId],
  });
}

/** Admin override: push/pull an unpaid invoice's due date without touching its amount. */
export async function updateInvoiceDueDate(invoiceId: string, dueDate: string): Promise<void> {
  await db.execute({
    sql: "UPDATE billing_invoices SET due_date = ?, due_date_overridden = 1 WHERE id = ? AND status IN ('unpaid', 'overdue')",
    args: [dueDate, invoiceId],
  });
}

export async function markInvoicePaidDB(invoiceId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db.execute({
    sql: "UPDATE billing_invoices SET status = 'paid', paid_date = ? WHERE id = ?",
    args: [today, invoiceId],
  });
}

export async function stampInvoiceNotification(
  id: string,
  field: "notified_issued_at" | "notified_overdue_at" | "notified_suspended_at"
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({ sql: `UPDATE billing_invoices SET ${field} = ? WHERE id = ?`, args: [now, id] });
}

// ─── Run log ──────────────────────────────────────────────────────────────────

export async function logBillingRun(
  mode: string, invoicesGenerated: number, emailsSent: number, usersSuspended: number
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO billing_run_log (mode, run_at, invoices_generated, emails_sent, users_suspended) VALUES (?, ?, ?, ?, ?)",
    args: [mode, new Date().toISOString(), invoicesGenerated, emailsSent, usersSuspended],
  });
}
