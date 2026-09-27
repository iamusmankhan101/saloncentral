/**
 * GET /api/billing/user
 * Returns the authenticated caller's own billing information from the database.
 */

import { NextRequest } from "next/server";
import { DEFAULT_BANK_DETAILS, getBilledFrom, getBillingUser, resolveBankDetailsForUser } from "@/lib/billing-db";
import { resolveActor } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    const billingUser = await getBillingUser(actor.userId);
    const billedFrom = await getBilledFrom();

    if (!billingUser) {
      // User not found in billing DB - they're on free plan
      return Response.json({
        ok: true,
        planId: "free",
        planName: "Free",
        planPrice: 0,
        billingTermMonths: 1,
        suspended: false,
        isDemoSignup: false,
        bankName: DEFAULT_BANK_DETAILS.bankName,
        bankTitle: DEFAULT_BANK_DETAILS.title,
        bankAccountNumber: DEFAULT_BANK_DETAILS.accountNumber,
        bankIban: DEFAULT_BANK_DETAILS.iban,
        billedFrom,
      });
    }

    // Per-salon picked payment method if the admin assigned one, else the
    // platform default — callers don't need to know which.
    const bankDetails = await resolveBankDetailsForUser(billingUser);

    return Response.json({
      ok: true,
      planId: billingUser.planId,
      planName: billingUser.planName,
      planPrice: billingUser.planPrice,
      billingTermMonths: billingUser.billingTermMonths,
      suspended: billingUser.suspended,
      suspensionReason: billingUser.suspensionReason,
      trialStart: billingUser.trialStart,
      isDemoSignup: billingUser.isDemoSignup,
      bankName: bankDetails.bankName,
      bankTitle: bankDetails.title,
      bankAccountNumber: bankDetails.accountNumber,
      bankIban: bankDetails.iban,
      billedFrom,
    });
  } catch (err) {
    console.error("[billing/user] Error fetching billing user:", err);
    return Response.json({ ok: false, error: "Failed to fetch billing information." }, { status: 500 });
  }
}
