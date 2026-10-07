import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createDbSession, getUserById, hashPassword, revokeAllSessionsForUser, verifyPassword } from "@/lib/auth-db";
import { createSessionToken, COOKIE_NAME, cookieOptions, tokenId } from "@/lib/session";
import { getSessionUserId, MAX_PASSWORD_LENGTH, sessionDeviceFromRequest } from "@/lib/api-auth";
import { rateLimit, rateLimitClear } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId(req);
  if (!userId) {
    return Response.json({ ok: false, error: "Invalid or expired session." }, { status: 401 });
  }

  // Slow down repeated wrong-password guesses against a valid session.
  const limit = await rateLimit("change-password", userId, { maxAttempts: 8, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 });
  if (limit.blocked) {
    return Response.json(
      { ok: false, error: "Too many attempts. Please try again later.", retryAfter: limit.retryAfter },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter ?? 0) } },
    );
  }

  let body: { currentPassword: string; newPassword: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return Response.json({ ok: false, error: "Missing required fields." }, { status: 400 });
  }
  if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > MAX_PASSWORD_LENGTH) {
    return Response.json({ ok: false, error: `New password must be 8–${MAX_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }

  try {
    const user = await getUserById(userId);
    if (!user) {
      return Response.json({ ok: false, error: "User not found." }, { status: 404 });
    }

    if (!verifyPassword(currentPassword, user.password)) {
      return Response.json({ ok: false, error: "Current password is incorrect." }, { status: 400 });
    }

    await db.execute({
      sql: "UPDATE users SET password = ? WHERE id = ?",
      args: [hashPassword(newPassword), userId],
    });

    // Sign out every other device — if the password changed because it
    // leaked, sessions opened with the old one must not survive. Then issue
    // this browser a fresh session so the person changing it stays signed in.
    await revokeAllSessionsForUser(userId);
    const token = createSessionToken(userId);
    await createDbSession(tokenId(token), userId, new Date(Date.now() + cookieOptions.maxAge * 1000), sessionDeviceFromRequest(req));

    await rateLimitClear("change-password", userId);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE_NAME, token, cookieOptions);
    return res;
  } catch (err) {
    console.error("[auth/change-password] Error:", err);
    return Response.json({ ok: false, error: "Failed to update password." }, { status: 500 });
  }
}
