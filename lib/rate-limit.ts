/**
 * lib/rate-limit.ts
 *
 * Per-IP / per-account rate limiter for sign-in, signup, password change,
 * public booking and the like, to slow down brute-force and spam. Keyed by
 * (bucket, key) so different endpoints don't share a counter.
 *
 * Counts live in the database (rate_limits), shared by every server instance:
 * Vercel runs several at once, and a per-instance count let an attacker
 * multiply their attempts by however many instances answered. Each attempt is
 * one atomic upsert, so concurrent requests can't both slip under the limit.
 * If the database can't be reached the in-memory counter below is used
 * instead, rather than locking everyone out.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";

interface RateEntry {
  attempts: number;
  windowStart: number;
  blockedUntil?: number;
}

export interface RateLimitOptions {
  windowMs?: number;
  maxAttempts?: number;
  blockMs?: number;
}

const DEFAULT_WINDOW_MS   = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BLOCK_MS    = 30 * 60 * 1000; // 30 minutes

const buckets = new Map<string, Map<string, RateEntry>>();

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export type RateLimitResult = { blocked: boolean; retryAfter?: number };

let tableReady: Promise<unknown> | null = null;
function ensureTable() {
  tableReady ??= db.execute(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket        TEXT NOT NULL,
      key           TEXT NOT NULL,
      attempts      INTEGER NOT NULL,
      window_start  INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, key)
    )
  `)
    // Stale-row clean-up (DELETE … WHERE window_start < ?).
    .then(() => db.execute("CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start)").catch(() => {}))
    .then(() => undefined)
    .catch((err) => { tableReady = null; throw err; });
  return tableReady;
}

/**
 * Records one attempt for (bucket, key) and reports whether it should be
 * blocked. Same rules as the in-memory version: while blocked nothing moves;
 * a window that has run out starts again at 1; going over maxAttempts within
 * the window blocks for blockMs. (SQLite evaluates every SET expression
 * against the row as it was before the update.)
 */
export async function rateLimit(bucket: string, key: string, opts: RateLimitOptions = {}): Promise<RateLimitResult> {
  const now = Date.now();
  try {
    await ensureTable();
    const result = await db.execute({
      sql: `INSERT INTO rate_limits (bucket, key, attempts, window_start, blocked_until)
            VALUES (:bucket, :key, 1, :now, 0)
            ON CONFLICT (bucket, key) DO UPDATE SET
              attempts = CASE
                WHEN rate_limits.blocked_until > :now THEN rate_limits.attempts
                WHEN :now - rate_limits.window_start > :window THEN 1
                ELSE rate_limits.attempts + 1 END,
              window_start = CASE
                WHEN rate_limits.blocked_until <= :now AND :now - rate_limits.window_start > :window THEN :now
                ELSE rate_limits.window_start END,
              blocked_until = CASE
                WHEN rate_limits.blocked_until > :now THEN rate_limits.blocked_until
                WHEN :now - rate_limits.window_start <= :window AND rate_limits.attempts + 1 > :max THEN :now + :block
                ELSE rate_limits.blocked_until END
            RETURNING blocked_until`,
      args: {
        bucket, key, now,
        window: opts.windowMs ?? DEFAULT_WINDOW_MS,
        max: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        block: opts.blockMs ?? DEFAULT_BLOCK_MS,
      },
    });
    const blockedUntil = Number(result.rows[0]?.blocked_until ?? 0);
    return blockedUntil > now ? { blocked: true, retryAfter: Math.ceil((blockedUntil - now) / 1000) } : { blocked: false };
  } catch (err) {
    console.warn("[rate-limit] database unavailable, using this instance's own count:", err);
    return memoryRateLimit(bucket, key, opts);
  }
}

/** Clear a (bucket, key) counter — call on success so legitimate users aren't penalized. */
export async function rateLimitClear(bucket: string, key: string): Promise<void> {
  buckets.get(bucket)?.delete(key);
  await db.execute({ sql: "DELETE FROM rate_limits WHERE bucket = ? AND key = ?", args: [bucket, key] }).catch(() => {});
}

/** Drops counters nobody has touched in a day and that aren't blocking; run from the nightly cron. */
export async function pruneRateLimits(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await db.execute({
    sql: "DELETE FROM rate_limits WHERE window_start < ? AND blocked_until < ?",
    args: [cutoff, Date.now()],
  }).catch(() => {});
}

/** The per-instance fallback, used only while the database is unreachable. */
function memoryRateLimit(
  bucket: string,
  key: string,
  opts: RateLimitOptions = {},
): { blocked: boolean; retryAfter?: number } {
  const windowMs    = opts.windowMs    ?? DEFAULT_WINDOW_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const blockMs     = opts.blockMs     ?? DEFAULT_BLOCK_MS;

  let store = buckets.get(bucket);
  if (!store) { store = new Map(); buckets.set(bucket, store); }

  const now = Date.now();
  const e = store.get(key);

  if (!e) {
    store.set(key, { attempts: 1, windowStart: now });
    return { blocked: false };
  }

  if (e.blockedUntil && now < e.blockedUntil) {
    return { blocked: true, retryAfter: Math.ceil((e.blockedUntil - now) / 1000) };
  }

  if (now - e.windowStart > windowMs) {
    store.set(key, { attempts: 1, windowStart: now });
    return { blocked: false };
  }

  e.attempts++;
  if (e.attempts > maxAttempts) {
    e.blockedUntil = now + blockMs;
    return { blocked: true, retryAfter: Math.ceil(blockMs / 1000) };
  }

  return { blocked: false };
}

// Periodically prune stale entries across all buckets so the maps don't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const store of buckets.values()) {
    for (const [k, e] of store) {
      const expired   = now - e.windowStart > DEFAULT_WINDOW_MS * 2;
      const unblocked = !e.blockedUntil || now > e.blockedUntil;
      if (expired && unblocked) store.delete(k);
    }
  }
}, 10 * 60 * 1000);
