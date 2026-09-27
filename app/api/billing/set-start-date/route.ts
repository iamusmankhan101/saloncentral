/**
 * POST /api/billing/set-start-date
 * Admin-only: changes the date a salon started (shown as "Started" in the Admin
 * panel's Users tab), e.g. to correct an account created ahead of go-live.
 * Before the salon's first invoice this also moves its billing schedule; after
 * that, existing invoices keep their dates (see updateTrialStart).
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { ensureBillingTables, getBillingUser, updateTrialStart } from "@/lib/billing-db";

export async function POST(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  let body: { userId?: string; startDate?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const userId = body.userId?.trim();
  const startDate = body.startDate?.trim();
  if (!userId) {
    return Response.json({ ok: false, error: "Missing userId." }, { status: 400 });
  }
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(startDate + "T00:00:00Z"))) {
    return Response.json({ ok: false, error: "Invalid startDate (expected YYYY-MM-DD)." }, { status: 400 });
  }

  try {
    await ensureBillingTables();
    if (!(await getBillingUser(userId))) {
      return Response.json({ ok: false, error: "No billing record for this salon." }, { status: 404 });
    }
    const { scheduleMoved } = await updateTrialStart(userId, startDate);
    return Response.json({ ok: true, startDate, scheduleMoved });
  } catch (err) {
    console.error("[billing/set-start-date] error:", err);
    return Response.json({ ok: false, error: "Failed to update start date." }, { status: 500 });
  }
}
