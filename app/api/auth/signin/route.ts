/**
 * POST /api/auth/signin
 * Authenticate user with rate limiting and account lockout.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateCredentials } from "@/lib/auth-db";
import { createSessionToken, COOKIE_NAME, cookieOptions, tokenId } from "@/lib/session";
import { createDbSession } from "@/lib/auth-db";
import { clientIp, rateLimit, rateLimitClear } from "@/lib/rate-limit";
import { logSigninEvent } from "@/lib/signin-log";

const BLOCK_MS = 30 * 60 * 1000; // 30-minute lockout

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  // Check rate limit before doing any work
  const limit = rateLimit("signin", ip, { maxAttempts: 10, blockMs: BLOCK_MS });
  if (limit.blocked) {
    await logSigninEvent(req, "server", "ip_rate_limited");
    const minutes = Math.ceil((limit.retryAfter ?? BLOCK_MS / 1000) / 60);
    return Response.json(
      { ok: false, error: `Too many failed attempts. Try again in ${minutes} minute${minutes !== 1 ? "s" : ""}.`, retryAfter: limit.retryAfter },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter ?? 0) } },
    );
  }

  let body: { email: string; password: string; portal?: "admin" | "staff" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const { email, password } = body;

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return Response.json({ ok: false, error: "Missing email or password." }, { status: 400 });
  }
  if (password.length > 1024) {
    return Response.json({ ok: false, error: "Invalid email or password." }, { status: 401 });
  }

  // Per-account limit too: the per-IP one alone lets an attacker spreading
  // guesses across many IPs keep hammering a single account.
  const emailKey = email.trim().toLowerCase();
  const emailLimit = rateLimit("signin-email", emailKey, { maxAttempts: 10, blockMs: BLOCK_MS });
  if (emailLimit.blocked) {
    await logSigninEvent(req, "server", "email_rate_limited", email);
    const minutes = Math.ceil((emailLimit.retryAfter ?? BLOCK_MS / 1000) / 60);
    return Response.json(
      { ok: false, error: `Too many failed attempts. Try again in ${minutes} minute${minutes !== 1 ? "s" : ""}.`, retryAfter: emailLimit.retryAfter },
      { status: 429, headers: { "Retry-After": String(emailLimit.retryAfter ?? 0) } },
    );
  }

  try {
    const user = await validateCredentials(email, password);
    const isStaff = user.role === "staff";
    if ((body.portal === "staff" && !isStaff) || (body.portal === "admin" && isStaff)) {
      await logSigninEvent(req, "server", "wrong_portal", email, `portal=${body.portal} role=${user.role}`);
      return Response.json(
        { ok: false, error: `This account belongs to the ${isStaff ? "Staff" : "Admin"} login.` },
        { status: 403 },
      );
    }

    // Success — clear the rate-limit counter for this IP
    rateLimitClear("signin", ip);
    rateLimitClear("signin-email", emailKey);

    const res = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        ownerName: user.ownerName,
        salonName: user.salonName,
        phone: user.phone,
        role: user.role,
        emailVerified: user.emailVerified,
        approvalStatus: user.approvalStatus,
        accountFrozen: user.accountFrozen,
        freezeReason: user.freezeReason,
        createdAt: user.createdAt,
        salonOwnerId: user.salonOwnerId,
        staffId: user.staffId,
        locationId: user.locationId,
        permissions: user.permissions,
      },
    });

    // Persist session in DB so it can be immediately revoked on signout
    const token = createSessionToken(user.id);
    const expiresAt = new Date(Date.now() + cookieOptions.maxAge * 1000);
    await createDbSession(tokenId(token), user.id, expiresAt);

    // Set HTTP-only cookie — not readable by JavaScript
    res.cookies.set(COOKIE_NAME, token, cookieOptions);
    await logSigninEvent(req, "server", "success", email, `role=${user.role}`);
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Authentication failed.";
    await logSigninEvent(req, "server", "failed", email, message);

    if (message === "Invalid email or password.") {
      return Response.json({ ok: false, error: message }, { status: 401 });
    }
    if (message.includes("waiting for admin approval") || message.includes("not approved") || message.includes("has been frozen")) {
      return Response.json({ ok: false, error: message }, { status: 403 });
    }

    console.error("[auth/signin] Unexpected error:", message);
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
