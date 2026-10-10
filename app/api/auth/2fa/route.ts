/**
 * POST /api/auth/2fa
 * Second sign-in step (lib/two-factor.ts).
 *   { action: "verify", challengeId, code } → session cookie + user, like /api/auth/signin
 *   { action: "resend", challengeId }       → a fresh emailed code
 */

import { NextRequest } from "next/server";
import { getUserById } from "@/lib/auth-db";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logSigninEvent } from "@/lib/signin-log";
import { completeSignIn, resendChallenge, verifyChallenge } from "@/lib/two-factor";

export async function POST(req: NextRequest) {
  // Per-challenge attempts are capped in verifyChallenge; this caps one IP working through many.
  const limit = await rateLimit("2fa", clientIp(req), { maxAttempts: 20, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 });
  if (limit.blocked) {
    return Response.json({ ok: false, error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  let body: { action?: "verify" | "resend"; challengeId?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  if (typeof body.challengeId !== "string" || !body.challengeId) {
    return Response.json({ ok: false, error: "This sign-in has expired. Please sign in again." }, { status: 400 });
  }

  try {
    if (body.action === "resend") {
      const result = await resendChallenge(body.challengeId);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    const { userId, error } = await verifyChallenge(body.challengeId, String(body.code ?? ""));
    if (!userId) {
      await logSigninEvent(req, "server", "2fa_failed", undefined, error);
      return Response.json({ ok: false, error }, { status: 401 });
    }

    // Re-check the account: it may have been frozen or disapproved since the password step.
    const user = await getUserById(userId);
    if (!user || user.accountFrozen || (user.role !== "admin" && user.approvalStatus !== "approved")) {
      return Response.json({ ok: false, error: "This account can't sign in right now. Please contact Salon Central support." }, { status: 403 });
    }
    return await completeSignIn(req, user); // picks only safe fields for the response
  } catch (err) {
    console.error("[auth/2fa] Error:", err);
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
