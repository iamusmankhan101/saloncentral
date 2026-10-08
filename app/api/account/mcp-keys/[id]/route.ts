/**
 * DELETE /api/account/mcp-keys/:id — revoke an MCP API key.
 * Session-cookie authed; only revokes a key that belongs to the caller's own
 * salon (never trusts the id alone) so one salon can't revoke another's key
 * by guessing an id.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { ensureMcpKeysTable } from "@/lib/mcp-auth";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  // An API key reads the whole account, so only the owner can manage them.
  if (actor.role !== "owner") return Response.json({ ok: false, error: "Only the account owner can manage API keys." }, { status: 403 });

  const { id } = await params;
  await ensureMcpKeysTable();
  const result = await db.execute({
    sql: `UPDATE mcp_api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    args: [new Date().toISOString(), id, actor.userId],
  });

  if (result.rowsAffected === 0) {
    return Response.json({ ok: false, error: "Key not found." }, { status: 404 });
  }
  return Response.json({ ok: true });
}
