/**
 * GET  /api/account/mcp-keys  — list this salon's MCP API keys (metadata only, never the raw key).
 * POST /api/account/mcp-keys  — generate a new key. Body: { label?: string, scope?: "read" | "read_write" }.
 *
 * Session-cookie authed (resolveActor), same as every other dashboard-scoped
 * route — the external bearer-key auth in lib/mcp-auth.ts is only for the
 * actual MCP endpoint (app/api/mcp/route.ts), not for managing the keys.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { ensureMcpKeysTable, generateMcpKey } from "@/lib/mcp-auth";

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  // An API key reads the whole account, so only the owner can manage them.
  if (actor.role !== "owner") return Response.json({ ok: false, error: "Only the account owner can manage API keys." }, { status: 403 });

  await ensureMcpKeysTable();
  const result = await db.execute({
    sql: `SELECT id, key_prefix, label, scope, created_at, last_used_at, revoked_at
          FROM mcp_api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    args: [actor.userId],
  });

  const keys = result.rows.map((row) => ({
    id: row.id,
    prefix: row.key_prefix,
    label: row.label,
    scope: row.scope,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revoked: row.revoked_at != null,
  }));
  return Response.json({ ok: true, keys });
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  // An API key reads the whole account, so only the owner can manage them.
  if (actor.role !== "owner") return Response.json({ ok: false, error: "Only the account owner can manage API keys." }, { status: 403 });

  let body: { label?: string; scope?: "read" | "read_write" };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const label = (body.label || "Poke").trim().slice(0, 60) || "Poke";
  const scope: "read" | "read_write" = body.scope === "read" ? "read" : "read_write";

  await ensureMcpKeysTable();
  const { raw, hash, prefix } = generateMcpKey();
  const id = "mcpk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO mcp_api_keys (id, user_id, location_id, key_hash, key_prefix, label, scope, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, actor.userId, actor.locationId, hash, prefix, label, scope, now],
  });

  // The raw key is returned exactly once — it is never retrievable again after this response.
  return Response.json({ ok: true, id, key: raw, prefix, label, scope, createdAt: now });
}
