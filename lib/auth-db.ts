/**
 * lib/auth-db.ts
 * Database-backed authentication using Turso (SQLite)
 */

import { db } from "@/lib/db";
import type { InValue } from "@libsql/client";
import { randomBytes, randomInt, pbkdf2Sync, timingSafeEqual } from "crypto";
import { sendWelcomeEmail } from "@/lib/welcome-email";

// ─── Password hashing ─────────────────────────────────────────────────────────

function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(plain, salt, 120_000, 64, "sha512").toString("hex");
  return `pbkdf2:${salt}:${hash}`;
}

function verifyPassword(plain: string, stored: string): boolean {
  if (stored.startsWith("pbkdf2:")) {
    const parts = stored.split(":");
    if (parts.length !== 3) return false;
    const [, salt, expectedHash] = parts;
    const derived = pbkdf2Sync(plain, salt, 120_000, 64, "sha512").toString("hex");
    // Constant-time comparison to prevent timing attacks
    try {
      return timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(expectedHash, "hex"));
    } catch { return false; }
  }
  // Legacy plaintext — accept and caller upgrades on next login
  const a = Buffer.from(plain);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export { hashPassword, verifyPassword };
export type ApprovalStatus = "pending" | "approved" | "rejected";

// ─── Schema ───────────────────────────────────────────────────────────────────

let authTablesReady: Promise<void> | null = null;

async function ensureAuthTablesUncached(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL UNIQUE,
      password          TEXT NOT NULL,
      owner_name        TEXT NOT NULL,
      salon_name        TEXT NOT NULL,
      phone             TEXT,
      role              TEXT NOT NULL DEFAULT 'owner',
      email_verified    INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      google_id         TEXT
    )
  `);

  // Add google_id column to existing tables that were created before this column was added
  await db.execute("ALTER TABLE users ADD COLUMN google_id TEXT").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN salon_owner_id TEXT").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN staff_id TEXT").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN permissions TEXT").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN location_id TEXT").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN account_frozen INTEGER NOT NULL DEFAULT 0").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN freeze_reason TEXT").catch(() => {});
  // Two-step sign-in (lib/two-factor.ts): method, and the authenticator secret (encrypted) once set up.
  await db.execute("ALTER TABLE users ADD COLUMN twofa_method TEXT NOT NULL DEFAULT 'email'").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN totp_secret TEXT").catch(() => {});
  await db.execute("ALTER TABLE users ADD COLUMN totp_pending TEXT").catch(() => {});

  // Create index for faster email lookups
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
  `).catch(() => { /* index already exists */ });

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)
  `).catch(() => {});
}

export async function ensureAuthTables(): Promise<void> {
  authTablesReady ||= ensureAuthTablesUncached().catch((error) => {
    authTablesReady = null;
    throw error;
  });
  return authTablesReady;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  password: string;
  ownerName: string;
  salonName: string;
  phone: string;
  role: "owner" | "manager" | "staff" | "admin";
  salonOwnerId?: string;
  staffId?: string;
  locationId?: string;
  permissions?: string[];
  emailVerified: boolean;
  approvalStatus: ApprovalStatus;
  accountFrozen: boolean;
  freezeReason: string | null;
  createdAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  ownerName: string;
  salonName: string;
  phone: string;
  role: "owner" | "manager" | "staff" | "admin";
  salonOwnerId?: string;
  staffId?: string;
  locationId?: string;
  permissions?: string[];
  emailVerified: boolean;
  approvalStatus: ApprovalStatus;
  accountFrozen: boolean;
  freezeReason: string | null;
  createdAt: string;
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToUser(r: any): User {
  return {
    id: r.id as string,
    email: r.email as string,
    password: r.password as string,
    ownerName: r.owner_name as string,
    salonName: r.salon_name as string,
    phone: (r.phone as string) ?? "",
    role: r.role as User["role"],
    salonOwnerId: (r.salon_owner_id as string) || undefined,
    staffId: (r.staff_id as string) || undefined,
    locationId: (r.location_id as string) || undefined,
    permissions: r.permissions ? JSON.parse(r.permissions as string) : undefined,
    emailVerified: (r.email_verified as number) === 1,
    approvalStatus: ((r.approval_status as string | undefined) || "approved") as ApprovalStatus,
    accountFrozen: (r.account_frozen as number) === 1,
    freezeReason: (r.freeze_reason as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function withoutPassword(user: User): AuthUser {
  const { password: _password, ...rest } = user;
  void _password;
  return rest;
}

// ─── User operations ──────────────────────────────────────────────────────────

export async function createUser(input: {
  email: string;
  password: string;
  ownerName: string;
  salonName: string;
  phone: string;
  role?: "owner" | "manager" | "staff" | "admin";
  emailVerified?: boolean;
  approvalStatus?: ApprovalStatus;
}): Promise<AuthUser> {
  await ensureAuthTables();

  const id = "user_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
  const createdAt = new Date().toISOString().split("T")[0];

  try {
    await db.execute({
      sql: `INSERT INTO users (id, email, password, owner_name, salon_name, phone, role, email_verified, approval_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.email.trim().toLowerCase(),
        hashPassword(input.password),
        input.ownerName.trim(),
        input.salonName?.trim() || input.ownerName.trim(),
        input.phone?.trim() || "",
        input.role || "owner",
        input.emailVerified ? 1 : 0,
        input.approvalStatus ?? ((input.role || "owner") === "owner" ? "pending" : "approved"),
        createdAt,
      ],
    });

    const user = await getUserById(id);
    if (!user) throw new Error("Failed to create user");
    return withoutPassword(user);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("UNIQUE constraint failed")) {
      throw new Error("An account with this email already exists.");
    }
    throw err;
  }
}

export async function upsertStaffUser(input: {
  salonOwnerId: string;
  staffId: string;
  name: string;
  salonName: string;
  email: string;
  phone: string;
  password?: string;
  role?: "manager" | "staff";
  permissions: string[];
  locationId: string;
}): Promise<AuthUser> {
  await ensureAuthTables();
  const existing = await db.execute({
    sql: "SELECT * FROM users WHERE staff_id = ? AND salon_owner_id = ?",
    args: [input.staffId, input.salonOwnerId],
  });

  if (existing.rows.length) {
    const current = rowToUser(existing.rows[0]);
    const password = input.password ? hashPassword(input.password) : current.password;
    await db.execute({
      sql: `UPDATE users SET email = ?, password = ?, owner_name = ?, salon_name = ?,
            phone = ?, role = ?, permissions = ?, location_id = ? WHERE id = ?`,
      args: [
        input.email.trim().toLowerCase(), password, input.name.trim(), input.salonName,
        input.phone, input.role || "staff", JSON.stringify(input.permissions), input.locationId, current.id,
      ],
    });
    // A new password must lock out anyone still signed in with the old one.
    if (input.password) await revokeAllSessionsForUser(current.id);
    const updated = await getUserById(current.id);
    if (!updated) throw new Error("Failed to update staff login.");
    return withoutPassword(updated);
  }

  if (!input.password || input.password.length < 8) {
    throw new Error("Staff password must be at least 8 characters.");
  }

  const id = `staff_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.execute({
    sql: `INSERT INTO users
          (id, email, password, owner_name, salon_name, phone, role, email_verified,
           approval_status, created_at, salon_owner_id, staff_id, permissions, location_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'approved', ?, ?, ?, ?, ?)`,
    args: [
      id, input.email.trim().toLowerCase(), hashPassword(input.password), input.name.trim(),
      input.salonName, input.phone, input.role || "staff",
      new Date().toISOString().slice(0, 10), input.salonOwnerId, input.staffId,
      JSON.stringify(input.permissions), input.locationId,
    ],
  });
  const created = await getUserById(id);
  if (!created) throw new Error("Failed to create staff login.");
  return withoutPassword(created);
}

/** Every login account on the platform (salon owners, managers, and staff) — admin use only. */
export async function getAllUsers(): Promise<AuthUser[]> {
  await ensureAuthTables();
  const res = await db.execute("SELECT * FROM users ORDER BY created_at DESC");
  return res.rows.map((row) => withoutPassword(rowToUser(row)));
}

export async function getStaffUsersForOwner(salonOwnerId: string): Promise<AuthUser[]> {
  await ensureAuthTables();
  const res = await db.execute({
    sql: "SELECT * FROM users WHERE salon_owner_id = ? AND staff_id IS NOT NULL ORDER BY owner_name COLLATE NOCASE ASC",
    args: [salonOwnerId],
  });
  return res.rows.map((row) => withoutPassword(rowToUser(row)));
}

export async function getUserById(id: string): Promise<User | null> {
  await ensureAuthTables();
  const res = await db.execute({
    sql: "SELECT * FROM users WHERE id = ?",
    args: [id],
  });
  return res.rows.length ? rowToUser(res.rows[0]) : null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  await ensureAuthTables();
  const res = await db.execute({
    sql: "SELECT * FROM users WHERE email = ?",
    args: [email.trim().toLowerCase()],
  });
  return res.rows.length ? rowToUser(res.rows[0]) : null;
}

export async function updateUserApprovalStatus(id: string, approvalStatus: ApprovalStatus): Promise<AuthUser> {
  await ensureAuthTables();
  const user = await getUserById(id);
  if (!user) throw new Error("User not found.");
  if (user.role === "admin") throw new Error("Admin accounts cannot be disapproved.");

  await db.execute({
    sql: "UPDATE users SET approval_status = ? WHERE id = ?",
    args: [approvalStatus, id],
  });

  const updated = await getUserById(id);
  if (!updated) throw new Error("Failed to update approval status.");
  return withoutPassword(updated);
}

/**
 * Freeze (or unfreeze) an account. A frozen account cannot log in and its
 * active sessions are revoked immediately so any already-open dashboard is
 * locked out. Retains an optional human-readable reason (e.g. "unpaid invoice").
 */
export async function updateAccountFreeze(
  id: string,
  frozen: boolean,
  reason: string | null = null,
): Promise<AuthUser> {
  await ensureAuthTables();
  const user = await getUserById(id);
  if (!user) throw new Error("User not found.");
  if (user.role === "admin") throw new Error("Admin accounts cannot be frozen.");

  await db.execute({
    sql: "UPDATE users SET account_frozen = ?, freeze_reason = ? WHERE id = ?",
    args: [frozen ? 1 : 0, frozen ? (reason ?? null) : null, id],
  });

  // Kick any already-active sessions so the freeze applies immediately.
  if (frozen) await revokeAllSessionsForUser(id);

  const updated = await getUserById(id);
  if (!updated) throw new Error("Failed to update account status.");
  return withoutPassword(updated);
}

/**
 * Admin reset: replaces the password with a random temporary one, signs the account
 * out everywhere, and returns the new password — the only time it exists in plain
 * text. No 0/O/1/l/I, so it can be read out or typed from a phone without mistakes.
 */
export async function resetUserPassword(id: string): Promise<string> {
  await ensureAuthTables();
  const user = await getUserById(id);
  if (!user) throw new Error("User not found.");
  if (user.role === "admin") throw new Error("Admin passwords can't be reset here.");

  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const password = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join("");
  // Also back to emailed sign-in codes: a reset is usually a locked-out owner, often with a lost phone.
  await db.execute({
    sql: "UPDATE users SET password = ?, twofa_method = 'email', totp_secret = NULL, totp_pending = NULL WHERE id = ?",
    args: [hashPassword(password), id],
  });
  await revokeAllSessionsForUser(id);
  return password;
}

/** Revoke every active session for a user (used when an account is frozen). */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await ensureSessionsTable();
  await db.execute({
    sql: "UPDATE sessions SET revoked = 1 WHERE user_id = ?",
    args: [userId],
  });
}

export async function verifyUserEmail(email: string): Promise<AuthUser> {
  await ensureAuthTables();
  
  const user = await getUserByEmail(email);
  if (!user) throw new Error("Account not found.");

  await db.execute({
    sql: "UPDATE users SET email_verified = 1 WHERE email = ?",
    args: [email.trim().toLowerCase()],
  });

  return withoutPassword({ ...user, emailVerified: true });
}

export async function updateUser(
  id: string,
  updates: Partial<Pick<User, "ownerName" | "salonName" | "phone">>
): Promise<AuthUser> {
  await ensureAuthTables();

  const user = await getUserById(id);
  if (!user) throw new Error("User not found.");

  const fields: string[] = [];
  const args: InValue[] = [];

  if (updates.ownerName !== undefined) {
    fields.push("owner_name = ?");
    args.push(updates.ownerName.trim());
  }
  if (updates.salonName !== undefined) {
    fields.push("salon_name = ?");
    args.push(updates.salonName.trim());
  }
  if (updates.phone !== undefined) {
    fields.push("phone = ?");
    args.push(updates.phone.trim());
  }

  if (fields.length === 0) return withoutPassword(user);

  args.push(id);
  await db.execute({
    sql: `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
    args,
  });

  const updated = await getUserById(id);
  if (!updated) throw new Error("Failed to update user");
  return withoutPassword(updated);
}

// ─── Sessions table ───────────────────────────────────────────────────────────

let sessionsTableReady: Promise<void> | null = null;

async function ensureSessionsTableUncached(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Device details for the admin "logged-in devices" view. Sessions created
  // before these columns existed simply show as an unknown device.
  for (const col of ["created_at TEXT", "last_seen_at TEXT", "user_agent TEXT", "ip TEXT", "city TEXT", "country TEXT"]) {
    await db.execute(`ALTER TABLE sessions ADD COLUMN ${col}`).catch(() => {});
  }
  await db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)").catch(() => {});
}

async function ensureSessionsTable(): Promise<void> {
  sessionsTableReady ||= ensureSessionsTableUncached().catch((error) => {
    sessionsTableReady = null;
    throw error;
  });
  return sessionsTableReady;
}

export interface SessionDevice {
  userAgent: string | null;
  ip: string | null;
  city: string | null;
  country: string | null;
}

/** Persist a new session. `id` should be SHA-256(token) — never the raw token. */
export async function createDbSession(id: string, userId: string, expiresAt: Date, device?: SessionDevice): Promise<void> {
  await ensureSessionsTable();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT OR REPLACE INTO sessions (id, user_id, expires_at, revoked, created_at, last_seen_at, user_agent, ip, city, country)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    args: [id, userId, expiresAt.toISOString(), now, now, device?.userAgent ?? null, device?.ip ?? null, device?.city ?? null, device?.country ?? null],
  });
}

/** Immediately revoke a session so it can never be reused. */
export async function revokeDbSession(id: string): Promise<void> {
  await ensureSessionsTable();
  await db.execute({
    sql: "UPDATE sessions SET revoked = 1 WHERE id = ?",
    args: [id],
  });
}

// last_seen_at is refreshed at most this often, so normal API traffic doesn't
// turn every request into a DB write.
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Returns true if the session exists AND is not revoked AND has not expired.
 * Pass `device` to also keep the admin devices view current: last_seen_at is
 * refreshed, and a session opened before device tracking existed gets its
 * browser/location filled in from this request.
 */
export async function isSessionValid(id: string, device?: SessionDevice): Promise<boolean> {
  await ensureSessionsTable();
  const res = await db.execute({
    sql: "SELECT revoked, expires_at, last_seen_at, user_agent FROM sessions WHERE id = ?",
    args: [id],
  });
  if (!res.rows.length) return false;
  const row = res.rows[0];
  if ((row.revoked as number) === 1) return false;
  if (new Date(row.expires_at as string) < new Date()) return false;

  const now = new Date().toISOString();
  if (device && !row.user_agent && device.userAgent) {
    db.execute({
      sql: "UPDATE sessions SET last_seen_at = ?, user_agent = ?, ip = ?, city = ?, country = ? WHERE id = ?",
      args: [now, device.userAgent, device.ip, device.city, device.country, id],
    }).catch(() => {});
  } else {
    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at as string).getTime() : 0;
    if (Date.now() - lastSeen > LAST_SEEN_INTERVAL_MS) {
      db.execute({
        sql: "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
        args: [now, id],
      }).catch(() => {});
    }
  }
  return true;
}

export interface ActiveSession {
  id: string;
  userId: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  city: string | null;
  country: string | null;
}

/** Signed-in (not revoked, not expired) sessions for one account, most recently active first. */
export async function listActiveSessions(userId: string): Promise<ActiveSession[]> {
  await ensureSessionsTable();
  const res = await db.execute({
    sql: `SELECT id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, city, country
          FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ?
          ORDER BY COALESCE(last_seen_at, created_at, '') DESC`,
    args: [userId, new Date().toISOString()],
  });
  return res.rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    createdAt: (r.created_at as string) ?? null,
    lastSeenAt: (r.last_seen_at as string) ?? null,
    expiresAt: r.expires_at as string,
    userAgent: (r.user_agent as string) ?? null,
    ip: (r.ip as string) ?? null,
    city: (r.city as string) ?? null,
    country: (r.country as string) ?? null,
  }));
}

/** Number of signed-in devices per account, for every account that has at least one. */
export async function countActiveSessionsByUser(): Promise<Map<string, number>> {
  await ensureSessionsTable();
  const res = await db.execute({
    sql: "SELECT user_id, COUNT(*) AS n FROM sessions WHERE revoked = 0 AND expires_at > ? GROUP BY user_id",
    args: [new Date().toISOString()],
  });
  return new Map(res.rows.map((r) => [r.user_id as string, Number(r.n)]));
}

/** Revoke one session, but only if it belongs to `userId` (guards against a mismatched id). */
export async function revokeUserSession(userId: string, sessionId: string): Promise<void> {
  await ensureSessionsTable();
  await db.execute({
    sql: "UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?",
    args: [sessionId, userId],
  });
}

// ─── Periodic cleanup (call from a cron or on-demand) ────────────────────────
export async function pruneExpiredSessions(): Promise<void> {
  await ensureSessionsTable();
  await db.execute({
    sql: "DELETE FROM sessions WHERE expires_at < ?",
    args: [new Date().toISOString()],
  });
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

export async function findOrCreateGoogleUser(profile: {
  googleId: string;
  email: string;
  name: string;
  emailVerified: boolean;
}): Promise<AuthUser> {
  await ensureAuthTables();

  // 1. Find by google_id (returning user)
  const byGoogle = await db.execute({
    sql: "SELECT * FROM users WHERE google_id = ?",
    args: [profile.googleId],
  });
  if (byGoogle.rows.length) return withoutPassword(rowToUser(byGoogle.rows[0]));

  // 2. Find by email (existing account — link google_id). Only when Google
  // vouches for the address — otherwise anyone could attach a Google account
  // claiming someone else's email and take over their login.
  if (!profile.emailVerified) throw new Error("Google email is not verified.");
  const existing = await getUserByEmail(profile.email);
  if (existing) {
    await db.execute({
      sql: "UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?",
      args: [profile.googleId, existing.id],
    });
    return withoutPassword({ ...existing, emailVerified: true });
  }

  // 3. Create new account (Google accounts always have verified email)
  const id = "user_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
  const createdAt = new Date().toISOString().split("T")[0];
  const unusablePassword = hashPassword(randomBytes(32).toString("hex"));

  await db.execute({
    sql: `INSERT INTO users (id, email, password, owner_name, salon_name, phone, role, email_verified, approval_status, created_at, google_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
    args: [
      id,
      profile.email.trim().toLowerCase(),
      unusablePassword,
      profile.name.trim(),
      profile.name.trim(),
      "",
      "owner",
      createdAt,
      profile.googleId,
    ],
  });

  const user = await getUserById(id);
  if (!user) throw new Error("Failed to create Google user");
  // Same "sign-up received" email as the sign-up form sends.
  await sendWelcomeEmail(user, { pending: true });
  return withoutPassword(user);
}

// Hash of a random value nobody knows — verified against when the email has no
// account so a miss costs the same PBKDF2 work as a wrong password.
// Built on first use so importing this module doesn't pay for a PBKDF2 run.
let dummyHash: string | null = null;

export async function validateCredentials(
  email: string,
  password: string
): Promise<AuthUser> {
  const user = await getUserByEmail(email);
  // Always run the full hash even when user is null to prevent timing-based
  // user-enumeration (attacker measuring response time to detect valid emails)
  const valid = verifyPassword(password, user?.password ?? (dummyHash ||= hashPassword(randomBytes(32).toString("hex")))) && !!user;
  if (!user || !valid) throw new Error("Invalid email or password.");
  if (user.approvalStatus === "pending") {
    throw new Error("Your account has been created and is waiting for admin approval.");
  }
  if (user.approvalStatus === "rejected") {
    throw new Error("Your account request was not approved. Please contact Salon Central support.");
  }
  if (user.accountFrozen) {
    const reason = user.freezeReason
      ? ` Reason given: ${user.freezeReason}.`
      : "";
    throw new Error(`Your account has been frozen by Salon Central.${reason} Please contact support to resolve this.`);
  }
  // Upgrade legacy plaintext password to hashed format on first successful login
  if (!user.password.startsWith("pbkdf2:")) {
    await db.execute({
      sql: "UPDATE users SET password = ? WHERE id = ?",
      args: [hashPassword(password), user.id],
    });
  }
  return withoutPassword(user);
}
