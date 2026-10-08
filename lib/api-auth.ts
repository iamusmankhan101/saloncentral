/**
 * lib/api-auth.ts
 *
 * Shared server-side authorization helper for API routes that read/write
 * per-salon data. Resolves which salon's data the caller may access from
 * their own session cookie — never from a client-supplied userId/salonId —
 * so one tenant can't read or overwrite another tenant's data by passing a
 * different id in the query string or request body.
 */

import { NextRequest } from "next/server";
import { COOKIE_NAME, tokenId, verifySessionToken } from "./session";
import { getUserById, isSessionValid, type SessionDevice } from "./auth-db";
import { clientIp } from "./rate-limit";

/** Longest password accepted when setting one — bounds the PBKDF2 work per request. */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * The caller's login-account id, or null. Checks the cookie's signature AND
 * the sessions table, so a token that was signed out, revoked by a password
 * change, or killed by an account freeze stops working immediately instead of
 * living on until its 7-day expiry. Every API route should authenticate
 * through this (or resolveActor/requireAdmin, which use it).
 */
export async function getSessionUserId(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const userId = token ? verifySessionToken(token) : null;
  if (!userId || !token) return null;
  return (await isSessionValid(tokenId(token), sessionDeviceFromRequest(req))) ? userId : null;
}

export interface ResolvedActor {
  /** The salon-owner id that scopes the data (staff resolve to their owner's id). */
  userId: string;
  /** The caller's own login-account id (differs from userId for staff/manager). */
  actorId: string;
  locationId: string;
  role: "owner" | "manager" | "staff" | "admin";
}

/**
 * Verifies the session cookie and resolves the caller's data scope.
 * Staff are pinned to their salon owner's id and their assigned location.
 * Managers resolve to their owner's id the same way — a manager row has its
 * own distinct id (upsertStaffUser mints "staff_user_...", separate from the
 * owner's id), so falling through to `actor.id` here would scope every read
 * and write to an empty salon under the manager's own account instead of the
 * real one. A manager assigned a specific branch is likewise pinned to it,
 * exactly like staff — only when a manager has no assigned branch (a
 * cross-branch manager, if that's ever configured) is the client-requested
 * location honored. Only an actual owner/admin can freely browse branches.
 * Returns null when there's no valid session — callers must respond 401.
 */
export async function resolveActor(
  req: NextRequest,
  requestedLocationId = "main",
): Promise<ResolvedActor | null> {
  const actorId = await getSessionUserId(req);
  const actor = actorId ? await getUserById(actorId) : null;
  if (!actor) return null;
  if (actor.role !== "admin" && (actor.approvalStatus !== "approved" || actor.accountFrozen)) return null;

  if (actor.role === "staff") {
    return {
      userId: actor.salonOwnerId || actor.id,
      actorId: actor.id,
      locationId: actor.locationId || "main",
      role: actor.role,
    };
  }
  if (actor.role === "manager") {
    // A manager is one branch's admin: always their own branch, never one the
    // request asks for. One with no branch recorded (older logins) gets the
    // main branch rather than the run of every branch.
    return {
      userId: actor.salonOwnerId || actor.id,
      actorId: actor.id,
      locationId: actor.locationId || "main",
      role: actor.role,
    };
  }
  return { userId: actor.id, actorId: actor.id, locationId: requestedLocationId, role: actor.role };
}

/**
 * For platform-admin-only endpoints that act on an arbitrary target user
 * (e.g. approving another salon's payment, changing their plan) — verifies
 * the caller's own session has role "admin". Returns null otherwise, in
 * which case the route must respond 401/403. Unlike resolveActor, this does
 * NOT resolve a data-owner id — the target user id comes from the request
 * body/query as an explicit admin action, not the caller's own scope.
 */
export async function requireAdmin(req: NextRequest): Promise<boolean> {
  const actorId = await getSessionUserId(req);
  const actor = actorId ? await getUserById(actorId) : null;
  return actor?.role === "admin";
}

/** Browser, IP and rough location of the request — stored with a new session for the admin devices view. */
export function sessionDeviceFromRequest(req: NextRequest): SessionDevice {
  const city = req.headers.get("x-vercel-ip-city");
  const ip = clientIp(req);
  return {
    userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    ip: ip === "unknown" ? null : ip,
    city: city ? decodeURIComponent(city) : null,
    country: req.headers.get("x-vercel-ip-country"),
  };
}
