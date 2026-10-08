/**
 * /api/whatsapp/queue-delete
 *
 * Removes a single row from one of the two WhatsApp send queues, so a message
 * that should never go out (wrong number, cancelled appointment, a receipt for
 * a sale that was rung up twice) can be pulled before the drain cron picks it
 * up — and so the "recently processed" list can be tidied afterwards.
 *
 * Deleting a queue row is NOT the same as un-sending: nothing here touches
 * wa_message_logs, which is what requeue-failed and the drain cron consult to
 * decide whether a client has already received something. Clearing a 'sent'
 * row therefore only clears the display, and can never cause a second copy of
 * the same message to be delivered.
 *
 * The two queues are keyed differently — wa_booking_send_queue by its own row
 * id, wa_pos_receipt_queue by invoice_id (see the PRIMARY KEYs in
 * queue-status/route.ts) — which is why the caller has to say which queue the
 * row came from. queue-details/route.ts already reports that as `source`.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveActor } from "@/lib/api-auth";
import { branchScope } from "@/lib/branch-scope";

type QueueSource = "booking" | "pos";

const TARGETS: Record<QueueSource, { table: string; idColumn: string }> = {
  booking: { table: "wa_booking_send_queue", idColumn: "id" },
  pos:     { table: "wa_pos_receipt_queue",  idColumn: "invoice_id" },
};

function isQueueSource(value: unknown): value is QueueSource {
  return value === "booking" || value === "pos";
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { source?: unknown; id?: unknown };

  if (!isQueueSource(body.source)) {
    return Response.json({ ok: false, error: "source must be \"booking\" or \"pos\"." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return Response.json({ ok: false, error: "id is required." }, { status: 400 });
  }

  const { table, idColumn } = TARGETS[body.source];

  try {
    // …and a branch's manager/staff only their own branch's clients' messages.
    const scope = await branchScope(actor);
    if (scope) {
      const row = await db.execute({ sql: `SELECT phone FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`, args: [actor.userId, id] });
      if (row.rows.length && !scope.hasPhone(row.rows[0].phone as string)) {
        return Response.json({ ok: false, error: "That message belongs to another branch." }, { status: 403 });
      }
    }
    // Scoped to the caller's own salon, so a staff account can never reach
    // another salon's queue by guessing an id.
    const result = await db.execute({
      sql: `DELETE FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`,
      args: [actor.userId, id],
    });

    if (result.rowsAffected === 0) {
      return Response.json({ ok: false, error: "That message is no longer in the queue." }, { status: 404 });
    }

    return Response.json({ ok: true, deleted: result.rowsAffected });
  } catch (error) {
    console.error("[whatsapp/queue-delete]", error);
    return Response.json({ ok: false, error: "Could not delete the queued message." }, { status: 500 });
  }
}
