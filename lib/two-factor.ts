/**
 * lib/two-factor.ts
 * Second sign-in step for salon owners and platform admins (staff skip it).
 *
 * After the password (or Google) check succeeds, no session is issued yet. A
 * short-lived challenge is created instead, and the session only comes from
 * /api/auth/2fa once the code checks out:
 *   email — a 6-digit code emailed to the account, valid 10 minutes (default)
 *   totp  — a code from an authenticator app, set up in Settings → Security
 * A code is asked for on every sign-in; devices aren't remembered.
 * It's on by default and each owner/admin can switch it off in Account → Security
 * (switching off needs a code too, so a stolen session can't do it).
 */

import { NextRequest, NextResponse } from "next/server";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { Resend } from "resend";
import { db } from "@/lib/db";
import { createDbSession, ensureAuthTables, type AuthUser } from "@/lib/auth-db";
import { createSessionToken, COOKIE_NAME, cookieOptions, tokenId, getSecret } from "@/lib/session";
import { sessionDeviceFromRequest } from "@/lib/api-auth";
import { logSigninEvent } from "@/lib/signin-log";

export type TwoFactorMethod = "email" | "totp";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 4; // first email + 3 resends

/** Roles that can use two-step sign-in at all (staff never do). */
export function canUseTwoFactor(user: Pick<AuthUser, "role">): boolean {
  return user.role === "owner" || user.role === "admin";
}

/** Whether this sign-in needs a code: an owner/admin who hasn't switched it off. */
export async function needsTwoFactor(user: Pick<AuthUser, "id" | "role">): Promise<boolean> {
  return canUseTwoFactor(user) && (await readSettings(user.id)).enabled;
}

let challengesReady: Promise<void> | null = null;
function ensureChallengesTable(): Promise<void> {
  challengesReady ??= (async () => {
    await ensureAuthTables(); // also adds users.twofa_method / totp_secret / totp_pending
    await db.execute(`CREATE TABLE IF NOT EXISTS twofa_challenges (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      method     TEXT NOT NULL,
      code_hash  TEXT,
      attempts   INTEGER NOT NULL DEFAULT 0,
      sends      INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL
    )`);
  })().catch((err) => { challengesReady = null; throw err; });
  return challengesReady;
}

// ─── TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) ────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of str.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const num = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(num).padStart(6, "0");
}

/** Accepts the current code and one step either side, for phone clocks that drift. */
// ponytail: a code can be replayed within its ~90s window; store the last used step per user if that matters.
export function verifyTotp(secret: Buffer, code: string, now = Date.now()): boolean {
  const step = Math.floor(now / 30_000);
  return [-1, 0, 1].some((d) => safeEqual(totpAt(secret, step + d), code));
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Authenticator secrets are encrypted at rest (AES-256-GCM, key derived from SESSION_SECRET).
// Rotating SESSION_SECRET makes them unreadable; an admin password reset puts the user back on email codes.
function secretKey(): Buffer {
  return createHash("sha256").update(`${getSecret()}:totp`).digest();
}
function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}
function decryptSecret(stored: string): string | null {
  try {
    const [iv, tag, enc] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ─── Per-user settings ────────────────────────────────────────────────────────

async function readSettings(userId: string): Promise<{ enabled: boolean; method: TwoFactorMethod; secret: string | null; pending: string | null }> {
  await ensureChallengesTable();
  const res = await db.execute({ sql: "SELECT twofa_enabled, twofa_method, totp_secret, totp_pending FROM users WHERE id = ?", args: [userId] });
  const row = res.rows[0];
  const secret = row?.totp_secret ? decryptSecret(String(row.totp_secret)) : null;
  const pending = row?.totp_pending ? decryptSecret(String(row.totp_pending)) : null;
  // An unreadable authenticator secret falls back to email rather than locking the owner out.
  const method: TwoFactorMethod = row?.twofa_method === "totp" && secret ? "totp" : "email";
  return { enabled: Number(row?.twofa_enabled ?? 1) !== 0, method, secret, pending };
}

export async function getTwoFactorStatus(userId: string): Promise<{ enabled: boolean; method: TwoFactorMethod }> {
  const { enabled, method } = await readSettings(userId);
  return { enabled, method };
}

/** On is instant. Off goes through confirmTwoFactorOff with a code from startChallenge. */
export async function setTwoFactorEnabled(userId: string, enabled: boolean): Promise<void> {
  await ensureChallengesTable();
  await db.execute({ sql: "UPDATE users SET twofa_enabled = ? WHERE id = ?", args: [enabled ? 1 : 0, userId] });
}

/** Turns it off once the code for a challenge started by this same user checks out. */
export async function confirmTwoFactorOff(userId: string, challengeId: string, code: string): Promise<string | null> {
  const { userId: owner, error } = await verifyChallenge(challengeId, code);
  if (!owner) return error ?? "That code isn't right.";
  if (owner !== userId) return "That code isn't for this account.";
  await setTwoFactorEnabled(userId, false);
  return null;
}

export async function getTwoFactorMethod(userId: string): Promise<TwoFactorMethod> {
  return (await readSettings(userId)).method;
}

/** Starts authenticator setup: a new secret, kept pending until the first code confirms it. */
export async function beginTotpSetup(user: Pick<AuthUser, "id" | "email">): Promise<{ secret: string; otpauthUrl: string }> {
  await ensureChallengesTable();
  const secret = base32Encode(randomBytes(20));
  await db.execute({ sql: "UPDATE users SET totp_pending = ? WHERE id = ?", args: [encryptSecret(secret), user.id] });
  const label = encodeURIComponent(`Salon Central:${user.email}`);
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Salon%20Central&algorithm=SHA1&digits=6&period=30` };
}

export async function confirmTotpSetup(userId: string, code: string): Promise<boolean> {
  const { pending } = await readSettings(userId);
  if (!pending || !verifyTotp(base32Decode(pending), code)) return false;
  await db.execute({
    sql: "UPDATE users SET twofa_method = 'totp', totp_secret = ?, totp_pending = NULL WHERE id = ?",
    args: [encryptSecret(pending), userId],
  });
  return true;
}

/** Back to email codes. Needs a current app code, so a stolen session alone can't downgrade it. */
export async function switchToEmail(userId: string, code: string): Promise<boolean> {
  const { method, secret } = await readSettings(userId);
  if (method === "totp" && (!secret || !verifyTotp(base32Decode(secret), code))) return false;
  await db.execute({ sql: "UPDATE users SET twofa_method = 'email', totp_secret = NULL, totp_pending = NULL WHERE id = ?", args: [userId] });
  return true;
}

// ─── Sign-in challenges ───────────────────────────────────────────────────────

function hashCode(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}${"•".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

async function emailCode(email: string, code: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not configured.");
  const { error } = await new Resend(apiKey).emails.send({
    from: "Salon Central <noreply@saloncentral.xyz>",
    to: [email],
    subject: `${code} is your Salon Central sign-in code`,
    text: `Your Salon Central sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't try to sign in, change your password — someone may know it.`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:24px 0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;border:1px solid #e8e8f0;overflow:hidden">
    <div style="padding:20px 32px;border-bottom:1px solid #ece9f5"><img src="${(process.env.NEXT_PUBLIC_APP_URL || "https://app.saloncentral.xyz").replace(/\/$/, "")}/report-logo.png" alt="Salon Central" width="74" height="36" style="display:block;border:0;color:#7C3AED;font-weight:900"></div>
    <div style="padding:28px 32px;text-align:center">
      <div style="font-size:15px;color:#1a1a2e;font-weight:700">Your sign-in code</div>
      <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#5B21B6;margin:16px 0;padding:14px 0;background:#F5F3FF;border-radius:12px">${code}</div>
      <div style="font-size:13px;color:#6b6b8a;line-height:1.6">Enter it on the sign-in page. It expires in <strong>10 minutes</strong>.</div>
      <div style="font-size:12px;color:#9898b0;line-height:1.6;margin-top:18px">Didn't try to sign in? Someone may know your password — change it in Settings → Security.</div>
    </div>
  </div></body></html>`,
  });
  if (error) throw new Error(error.message);
}

export interface ChallengeInfo { challengeId: string; method: TwoFactorMethod; emailHint?: string }

export async function startChallenge(user: Pick<AuthUser, "id" | "email">): Promise<ChallengeInfo> {
  await ensureChallengesTable();
  const method = await getTwoFactorMethod(user.id);
  const id = randomBytes(24).toString("base64url");
  const code = method === "email" ? String(randomInt(0, 1_000_000)).padStart(6, "0") : null;
  // Old, finished-with challenges go as new ones are made.
  await db.execute({ sql: "DELETE FROM twofa_challenges WHERE expires_at < ?", args: [new Date().toISOString()] });
  await db.execute({
    sql: "INSERT INTO twofa_challenges (id, user_id, method, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
    args: [id, user.id, method, code ? hashCode(id, code) : null, new Date(Date.now() + CODE_TTL_MS).toISOString()],
  });
  if (code) await emailCode(user.email, code);
  return { challengeId: id, method, ...(method === "email" ? { emailHint: maskEmail(user.email) } : {}) };
}

async function loadChallenge(id: string) {
  await ensureChallengesTable();
  const res = await db.execute({
    sql: "SELECT c.*, u.email FROM twofa_challenges c JOIN users u ON u.id = c.user_id WHERE c.id = ?",
    args: [id],
  });
  const row = res.rows[0];
  if (!row || String(row.expires_at) < new Date().toISOString()) return null;
  return row;
}

export async function resendChallenge(id: string): Promise<{ ok: boolean; error?: string }> {
  const row = await loadChallenge(id);
  if (!row) return { ok: false, error: "This sign-in has expired. Please sign in again." };
  if (row.method !== "email") return { ok: false, error: "Use the code from your authenticator app." };
  if (Number(row.sends) >= MAX_SENDS) return { ok: false, error: "Too many codes sent. Please sign in again." };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.execute({
    sql: "UPDATE twofa_challenges SET code_hash = ?, sends = sends + 1, attempts = 0, expires_at = ? WHERE id = ?",
    args: [hashCode(id, code), new Date(Date.now() + CODE_TTL_MS).toISOString(), id],
  });
  await emailCode(String(row.email), code);
  return { ok: true };
}

/** Checks a code. On success the challenge is used up and the user id comes back. */
export async function verifyChallenge(id: string, code: string): Promise<{ userId?: string; error?: string }> {
  const row = await loadChallenge(id);
  if (!row) return { error: "This sign-in has expired. Please sign in again." };
  if (Number(row.attempts) >= MAX_ATTEMPTS) {
    await db.execute({ sql: "DELETE FROM twofa_challenges WHERE id = ?", args: [id] });
    return { error: "Too many wrong codes. Please sign in again." };
  }
  await db.execute({ sql: "UPDATE twofa_challenges SET attempts = attempts + 1 WHERE id = ?", args: [id] });

  const clean = code.replace(/\D/g, "");
  let ok = false;
  if (clean.length === 6) {
    if (row.method === "email") {
      ok = !!row.code_hash && safeEqual(hashCode(id, clean), String(row.code_hash));
    } else {
      const { secret } = await readSettings(String(row.user_id));
      ok = !!secret && verifyTotp(base32Decode(secret), clean);
    }
  }
  if (!ok) return { error: "That code isn't right. Check it and try again." };

  await db.execute({ sql: "DELETE FROM twofa_challenges WHERE id = ?", args: [id] });
  return { userId: String(row.user_id) };
}

// ─── Finishing sign-in ────────────────────────────────────────────────────────

/** Issues the session cookie and returns the user — the last step of every sign-in path. */
export async function completeSignIn(req: NextRequest, user: AuthUser): Promise<NextResponse> {
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
  await createDbSession(tokenId(token), user.id, expiresAt, sessionDeviceFromRequest(req));
  // Set HTTP-only cookie — not readable by JavaScript
  res.cookies.set(COOKIE_NAME, token, cookieOptions);
  await logSigninEvent(req, "server", "success", user.email, `role=${user.role}`);
  return res;
}
