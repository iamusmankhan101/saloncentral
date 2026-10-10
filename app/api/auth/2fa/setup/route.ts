/**
 * /api/auth/2fa/setup — Settings → Security, for owners and admins.
 *   GET                                  → { available, enabled, method }
 *   POST { action: "enable" }            → turn two-step sign-in on
 *   POST { action: "disable-start" }     → sends/asks for a code to confirm turning it off → { challengeId, method }
 *   POST { action: "disable-confirm", challengeId, code } → turns it off
 *   POST { action: "start" }             → QR code + key for an authenticator app
 *   POST { action: "confirm", code }     → switch to the app once its first code checks out
 *   POST { action: "use-email", code }   → back to emailed codes (needs a current app code)
 */

import { NextRequest } from "next/server";
import QRCode from "qrcode";
import { getSessionUserId } from "@/lib/api-auth";
import { getUserById } from "@/lib/auth-db";
import { rateLimit } from "@/lib/rate-limit";
import { beginTotpSetup, canUseTwoFactor, confirmTotpSetup, confirmTwoFactorOff, getTwoFactorStatus, setTwoFactorEnabled, startChallenge, switchToEmail } from "@/lib/two-factor";

async function currentUser(req: NextRequest) {
  const userId = await getSessionUserId(req);
  return userId ? getUserById(userId) : null;
}

export async function GET(req: NextRequest) {
  const user = await currentUser(req);
  if (!user) return Response.json({ ok: false, error: "Not signed in." }, { status: 401 });
  if (!canUseTwoFactor(user)) return Response.json({ ok: true, available: false });
  return Response.json({ ok: true, available: true, ...(await getTwoFactorStatus(user.id)) });
}

export async function POST(req: NextRequest) {
  const user = await currentUser(req);
  if (!user) return Response.json({ ok: false, error: "Not signed in." }, { status: 401 });
  if (!canUseTwoFactor(user)) return Response.json({ ok: false, error: "Two-step sign-in isn't used for this account." }, { status: 400 });

  let body: { action?: "enable" | "disable-start" | "disable-confirm" | "start" | "confirm" | "use-email"; code?: string; challengeId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (body.action === "enable") {
    await setTwoFactorEnabled(user.id, true);
    return Response.json({ ok: true, ...(await getTwoFactorStatus(user.id)) });
  }
  if (body.action === "disable-start") {
    const { challengeId, method } = await startChallenge(user);
    return Response.json({ ok: true, challengeId, method });
  }

  if (body.action === "start") {
    const { secret, otpauthUrl } = await beginTotpSetup(user);
    const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
    return Response.json({ ok: true, secret, qr }, { headers: { "Cache-Control": "no-store" } });
  }

  // Code checks are guessable six digits, so they share a per-user limit.
  const limit = await rateLimit("2fa-setup", user.id, { maxAttempts: 10, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 });
  if (limit.blocked) return Response.json({ ok: false, error: "Too many attempts. Please try again later." }, { status: 429 });
  const code = String(body.code ?? "").replace(/\D/g, "");

  if (body.action === "confirm") {
    return (await confirmTotpSetup(user.id, code))
      ? Response.json({ ok: true, method: "totp" })
      : Response.json({ ok: false, error: "That code isn't right. Check the app and try again." }, { status: 400 });
  }
  if (body.action === "disable-confirm") {
    const error = await confirmTwoFactorOff(user.id, String(body.challengeId ?? ""), code);
    return error
      ? Response.json({ ok: false, error }, { status: 400 })
      : Response.json({ ok: true, enabled: false });
  }
  if (body.action === "use-email") {
    return (await switchToEmail(user.id, code))
      ? Response.json({ ok: true, method: "email" })
      : Response.json({ ok: false, error: "Enter the current code from your authenticator app." }, { status: 400 });
  }
  return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
}
