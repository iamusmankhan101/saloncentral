/**
 * lib/signin-log.ts
 *
 * Diagnostic trail for sign-in attempts: page opened, button pressed, server
 * outcome, browser-side errors. Exists so a sign-in that "does nothing" for a
 * user we can't get screenshots from can be diagnosed from the DB alone.
 * Never stores passwords.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { clientIp } from "@/lib/rate-limit";

let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  tableReady ??= db.execute(`
    CREATE TABLE IF NOT EXISTS signin_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      source     TEXT NOT NULL,
      event      TEXT NOT NULL,
      email      TEXT,
      detail     TEXT,
      country    TEXT,
      city       TEXT,
      ip         TEXT,
      user_agent TEXT
    )
  `).then(() => undefined).catch((error) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.slice(0, max);
}

/** Best-effort — a logging failure must never break sign-in itself. */
export async function logSigninEvent(
  req: NextRequest,
  source: "client" | "server",
  event: string,
  email?: string | null,
  detail?: string | null,
): Promise<void> {
  try {
    await ensureTable();
    const city = req.headers.get("x-vercel-ip-city");
    await db.execute({
      sql: `INSERT INTO signin_log (created_at, source, event, email, detail, country, city, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        new Date().toISOString(),
        source,
        clip(event, 40) ?? "unknown",
        clip(email?.trim().toLowerCase(), 200),
        clip(detail, 500),
        req.headers.get("x-vercel-ip-country"),
        city ? decodeURIComponent(city) : null,
        clientIp(req),
        clip(req.headers.get("user-agent"), 300),
      ],
    });
  } catch (err) {
    console.error("[signin-log] Failed to write:", err);
  }
}
