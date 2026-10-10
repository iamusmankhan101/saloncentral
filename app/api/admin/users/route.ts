/**
 * GET /api/admin/users
 * Admin-only: lists every login account on the platform — salon owners,
 * managers, and staff — for the Admin panel's Users tab. Distinct from
 * /api/billing/users, which is one row per salon's billing record, not
 * every individual account that can log in to it.
 */

import { NextRequest } from "next/server";
import { getAllUsers, getUserById, updateUserApprovalStatus, updateAccountFreeze, resetUserPassword, countActiveSessionsByUser, type ApprovalStatus } from "@/lib/auth-db";
import { sendWelcomeEmail } from "@/lib/welcome-email";
import { canUseTwoFactor, getAllTwoFactorStatuses, setTwoFactorEnabled } from "@/lib/two-factor";
import { requireAdmin } from "@/lib/api-auth";
import { getBillingAdminSummaries } from "@/lib/billing-db";

export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  try {
    const users = await getAllUsers();
    const ownerIds = users.filter((user) => user.role === "owner").map((user) => user.id);
    const [billingSummaries, deviceCounts, twoFactor] = await Promise.all([
      getBillingAdminSummaries(ownerIds),
      countActiveSessionsByUser(),
      getAllTwoFactorStatuses(),
    ]);
    const enrichedUsers = users.map((user) => {
      const billing = user.role === "owner" ? billingSummaries.get(user.id) : null;
      return {
        ...user,
        planName: billing?.planName ?? null,
        planId: billing?.planId ?? null,
        startedDate: billing?.trialStart ?? null,
        invoiceDueDate: billing?.invoiceDueDate ?? null,
        invoiceId: billing?.invoiceId ?? null,
        activeDevices: deviceCounts.get(user.id) ?? 0,
        // Only owners and admins use two-step sign-in; null for everyone else.
        twoFactor: canUseTwoFactor(user) ? twoFactor.get(user.id) ?? { enabled: true, method: "email" } : null,
      };
    });
    return Response.json({ ok: true, users: enrichedUsers });
  } catch (err) {
    console.error("[admin/users] Error fetching users:", err);
    return Response.json({ ok: false, error: "Failed to fetch users." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  let body: { userId?: string; approvalStatus?: ApprovalStatus; action?: "freeze" | "unfreeze" | "reset-password" | "twofa-on" | "twofa-off"; reason?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!body.userId) {
    return Response.json({ ok: false, error: "Missing userId." }, { status: 400 });
  }

  try {
    if (body.action === "twofa-on" || body.action === "twofa-off") {
      const target = await getUserById(body.userId);
      if (!target || !canUseTwoFactor(target)) {
        return Response.json({ ok: false, error: "Two-step sign-in only applies to salon owners and admins." }, { status: 400 });
      }
      await setTwoFactorEnabled(target.id, body.action === "twofa-on");
      return Response.json({ ok: true, enabled: body.action === "twofa-on" });
    }

    if (body.action === "reset-password") {
      // The plain password goes back to the admin once, in this response, and is never stored or logged.
      const password = await resetUserPassword(body.userId);
      return Response.json({ ok: true, password }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "freeze" || body.action === "unfreeze") {
      const frozen = body.action === "freeze";
      const reason = frozen ? body.reason?.trim() || "No reason provided." : null;
      const user = await updateAccountFreeze(body.userId, frozen, reason);
      return Response.json({ ok: true, user });
    }

    if (!body.approvalStatus) {
      return Response.json({ ok: false, error: "Missing action or approvalStatus." }, { status: 400 });
    }
    if (!["pending", "approved", "rejected"].includes(body.approvalStatus)) {
      return Response.json({ ok: false, error: "Invalid approval status." }, { status: 400 });
    }

    const before = await getUserById(body.userId);
    const user = await updateUserApprovalStatus(body.userId, body.approvalStatus);
    // Only on the change to approved, so re-clicking Approve doesn't send it again.
    if (user.role === "owner" && user.approvalStatus === "approved" && before?.approvalStatus !== "approved") {
      await sendWelcomeEmail(user, { pending: false });
    }
    return Response.json({ ok: true, user });
  } catch (err) {
    console.error("[admin/users] Update error:", err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Failed to update user." }, { status: 500 });
  }
}
