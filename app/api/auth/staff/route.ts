import { NextRequest } from "next/server";
import { getStaffUsersForOwner, getUserById, upsertStaffUser } from "@/lib/auth-db";
import { getSessionUserId, MAX_PASSWORD_LENGTH } from "@/lib/api-auth";

const STAFF_PERMISSIONS = ["dashboard", "calendar", "appointments", "clients", "pos", "invoices"];
const MANAGER_PERMISSIONS = ["*"];
// Must list every page key the Roles & Permissions screen offers, or a tick is
// silently dropped on save.
const ALL_PERMISSION_KEYS = new Set([
  "dashboard", "calendar", "floor", "appointments", "clients", "pos", "invoices", "loyalty",
  "revenue", "cash-flow", "inventory", "services", "staff", "attendance", "payouts", "messages", "try-on",
  "account", "billing",
  "medical", "consent-forms", "leads", "rooms", "aftercare", "waitlist", "clinic-reports",
]);

/** The branch a manager administers; owners aren't limited to one. */
const managerBranch = (actor: { role: string; locationId?: string }) => actor.role === "manager" ? (actor.locationId || "main") : null;

async function getAuthorizedActor(req: NextRequest) {
  const actorId = await getSessionUserId(req);
  if (!actorId) return { error: Response.json({ ok: false, error: "Not authenticated." }, { status: 401 }) };

  const actor = await getUserById(actorId);
  if (!actor || actor.approvalStatus !== "approved" || actor.accountFrozen) {
    return { error: Response.json({ ok: false, error: "Not authenticated." }, { status: 401 }) };
  }
  if (!["owner", "manager"].includes(actor.role)) {
    return { error: Response.json({ ok: false, error: "Only salon owners or managers can manage staff access." }, { status: 403 }) };
  }

  return { actor };
}

export async function GET(req: NextRequest) {
  const { actor, error } = await getAuthorizedActor(req);
  if (error) return error;

  const users = await getStaffUsersForOwner(actor!.salonOwnerId || actor!.id);
  // A branch admin only sees the logins of their own branch.
  const branch = managerBranch(actor!);
  return Response.json({ ok: true, users: branch ? users.filter((u) => (u.locationId || "main") === branch) : users });
}

export async function POST(req: NextRequest) {
  const { actor, error } = await getAuthorizedActor(req);
  if (error) return error;

  const body = await req.json() as {
    staffId?: string; name?: string; email?: string; phone?: string; password?: string; locationId?: string;
    role?: string; permissions?: string[];
  };
  if (!body.staffId || !body.name || !body.email || !body.locationId) {
    return Response.json({ ok: false, error: "Staff name, email, ID and assigned location are required." }, { status: 400 });
  }

  if (body.password && (body.password.length < 8 || body.password.length > MAX_PASSWORD_LENGTH)) {
    return Response.json({ ok: false, error: `Password must be 8–${MAX_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }

  // A branch admin can only add or change logins in their own branch — never
  // move someone into another branch, or take over another branch's login by
  // sending its staff id or email.
  const branch = managerBranch(actor!);
  if (branch) {
    if (body.locationId !== branch) {
      return Response.json({ ok: false, error: "You can only manage logins for your own branch." }, { status: 403 });
    }
    const existing = (await getStaffUsersForOwner(actor!.salonOwnerId || actor!.id))
      .find((u) => u.staffId === body.staffId || u.email.toLowerCase() === body.email!.trim().toLowerCase());
    if (existing && (existing.locationId || "main") !== branch) {
      return Response.json({ ok: false, error: "That login belongs to another branch." }, { status: 403 });
    }
  }

  const isManager = body.role === "manager";
  const requestedPermissions = Array.isArray(body.permissions)
    ? body.permissions.filter((permission) => ALL_PERMISSION_KEYS.has(permission))
    : STAFF_PERMISSIONS;
  const permissions = isManager
    ? MANAGER_PERMISSIONS
    : Array.from(new Set(["dashboard", ...requestedPermissions]));

  try {
    const user = await upsertStaffUser({
      salonOwnerId: actor!.salonOwnerId || actor!.id,
      staffId: body.staffId,
      name: body.name,
      salonName: actor!.salonName,
      email: body.email,
      phone: body.phone || "",
      password: body.password,
      role: isManager ? "manager" : "staff",
      permissions,
      locationId: body.locationId,
    });
    return Response.json({ ok: true, user });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save staff login.";
    const status = message.includes("already exists") ? 409 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
