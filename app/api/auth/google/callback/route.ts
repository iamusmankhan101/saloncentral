/**
 * GET /api/auth/google/callback
 * Handles the OAuth 2.0 redirect from Google.
 * Exchanges the code for tokens, fetches user info, finds or creates a local
 * account, and sets the same HTTP-only session cookie used by email/password login.
 */

import { NextRequest, NextResponse } from "next/server";
import { needsTwoFactor, startChallenge } from "@/lib/two-factor";
import { findOrCreateGoogleUser } from "@/lib/auth-db";
import { createSessionToken, COOKIE_NAME, cookieOptions, tokenId } from "@/lib/session";
import { createDbSession } from "@/lib/auth-db";
import { sessionDeviceFromRequest } from "@/lib/api-auth";

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const APP_URL       = process.env.NEXT_PUBLIC_APP_URL  ?? "http://localhost:3000";
const REDIRECT      = `${APP_URL}/api/auth/google/callback`;

function clearOAuthCookies(res: NextResponse) {
  res.cookies.set("g_oauth_state",   "", { maxAge: 0, path: "/" });
  res.cookies.set("g_pkce_verifier", "", { maxAge: 0, path: "/" });
}

function failRedirect(req: NextRequest, reason: string) {
  const dest = new URL("/sign-in", req.url);
  dest.searchParams.set("error", reason);
  const res = NextResponse.redirect(dest);
  clearOAuthCookies(res);
  return res;
}

interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  name?: string;
  email_verified?: boolean;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code  = searchParams.get("code");
  const state = searchParams.get("state");

  // Google returns ?error=access_denied when user cancels
  if (searchParams.get("error")) return failRedirect(req, "google_cancelled");

  const storedState = req.cookies.get("g_oauth_state")?.value;
  const verifier    = req.cookies.get("g_pkce_verifier")?.value;

  if (!code || !state || !storedState || !verifier) return failRedirect(req, "google_invalid");
  if (state !== storedState) return failRedirect(req, "google_csrf");

  // Exchange authorisation code for access token
  let tokenData: GoogleTokenResponse;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT,
        grant_type:    "authorization_code",
        code_verifier: verifier,
      }),
    });
    tokenData = await tokenRes.json() as GoogleTokenResponse;
  } catch {
    return failRedirect(req, "google_token_error");
  }

  if (!tokenData.access_token) return failRedirect(req, "google_token_error");

  // Fetch the user's Google profile
  let profile: GoogleUserInfo;
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    profile = await userRes.json() as GoogleUserInfo;
  } catch {
    return failRedirect(req, "google_userinfo_error");
  }

  if (!profile.sub || !profile.email) return failRedirect(req, "google_incomplete_profile");

  // Find existing account or create a new one
  let user;
  try {
    user = await findOrCreateGoogleUser({
      googleId:      profile.sub,
      email:         profile.email,
      name:          profile.name ?? profile.email.split("@")[0],
      // Treat a missing flag as unverified rather than trusting it.
      emailVerified: profile.email_verified === true,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Google email is not verified.") {
      return failRedirect(req, "google_unverified_email");
    }
    console.error("[google/callback] DB error:", err);
    return failRedirect(req, "google_db_error");
  }
  if (user.accountFrozen) return failRedirect(req, "account_frozen");

  if (user.role !== "admin" && user.approvalStatus !== "approved") {
    return failRedirect(req, user.approvalStatus === "rejected" ? "account_rejected" : "account_pending");
  }

  // Owners and admins confirm a code first: the sign-in page picks the challenge up from the URL.
  if (await needsTwoFactor(user)) {
    let challenge;
    try {
      challenge = await startChallenge(user);
    } catch (err) {
      console.error("[google/callback] 2FA challenge failed:", err);
      return failRedirect(req, "twofa_failed");
    }
    const dest = new URL("/sign-in", req.url);
    dest.searchParams.set("challenge", challenge.challengeId);
    dest.searchParams.set("method", challenge.method);
    const res = NextResponse.redirect(dest);
    clearOAuthCookies(res);
    return res;
  }

  // Issue session (identical to email/password login path)
  const token     = createSessionToken(user.id);
  const expiresAt = new Date(Date.now() + cookieOptions.maxAge * 1000);
  await createDbSession(tokenId(token), user.id, expiresAt, sessionDeviceFromRequest(req));

  // Redirect to a thin client bridge that syncs localStorage before hitting the dashboard
  const dest = new URL("/auth/google/complete", req.url);
  const res  = NextResponse.redirect(dest);
  clearOAuthCookies(res);
  res.cookies.set(COOKIE_NAME, token, cookieOptions);
  return res;
}
