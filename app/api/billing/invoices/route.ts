/**
 * GET /api/billing/invoices
 * Returns the signed-in salon's real invoice history from the billing database
 * (the same table the admin-approval flow and the daily cron write to).
 * A ?userId= is only honored for platform admins viewing another salon.
 */

import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { addDays, BILLING_CYCLE_DAYS, ensureBillingTables, getBillingUser, getOrCreate30DayInvoice } from "@/lib/billing-db";
import type { Invoice, InvoiceStatus } from "@/lib/invoices";

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) {
    return Response.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }
  const requested = req.nextUrl.searchParams.get("userId");
  const userId = actor.role === "admin" && requested ? requested : actor.userId;

  try {
    await ensureBillingTables();

    const user = await getBillingUser(userId);
    if (!user) {
      return Response.json({ ok: true, invoices: [] });
    }

    // Invoice generation normally happens via the daily cron, but that may not
    // have run yet for this user's billing period. Create it on demand here
    // too (idempotent) so the billing page never shows a blank invoice list.
    // Skip free-plan users — they have no billing cycle to invoice.
    if (user.planPrice > 0) {
      await getOrCreate30DayInvoice(user);
    }

    const res = await db.execute({
      sql: "SELECT * FROM billing_invoices WHERE user_id = ? ORDER BY period_start DESC",
      args: [userId],
    });

    const invoices: Invoice[] = res.rows.map((r) => {
      const amount = r.amount as number;
      return {
        id: r.id as string,
        number: r.number as string,
        userId: user.id,
        userName: user.ownerName,
        salonName: user.salonName,
        userEmail: user.email,
        userPhone: user.phone,
        planId: user.planId,
        planName: user.planName,
        items: [{
          description: `${user.planName} Plan — ${user.billingTermMonths === 1 ? "Monthly" : `${user.billingTermMonths} Months`} Subscription`,
          qty: 1,
          unitPrice: amount,
          total: amount,
        }],
        subtotal: amount,
        tax: 0,
        total: amount,
        issuedDate: r.issued_date as string,
        dueDate: r.due_date as string,
        status: r.status as InvoiceStatus,
        paidDate: (r.paid_date as string) ?? null,
        periodStart: r.period_start as string,
        periodEnd: addDays(r.period_start as string, Math.max(1, user.billingTermMonths) * BILLING_CYCLE_DAYS),
      };
    });

    return Response.json({ ok: true, invoices });
  } catch (err) {
    console.error("[billing/invoices] Error fetching invoices:", err);
    return Response.json({ ok: false, error: "Failed to fetch invoices." }, { status: 500 });
  }
}
