import { db } from "./db";

const MINUTE_MS = 60 * 1000;
const FOLLOWUP_MIN_GAP_MS = 15 * MINUTE_MS;
const FOLLOWUP_MAX_GAP_MS = 20 * MINUTE_MS;

/**
 * Moves a follow-up's send time so it lands at least 15 min (plus random jitter
 * up to 20 min) away from every other pending follow-up for the salon. Follow-ups
 * for a busy evening all fall due around the same time the next day, and without
 * this they queue minutes apart — a burst from one number.
 */
export async function spacedFollowupScheduledAt(userId: string, scheduledAt: string): Promise<string> {
  let wantedMs = Date.parse(scheduledAt);
  if (!Number.isFinite(wantedMs)) return scheduledAt;
  // Each step moves past at least one existing row, so this ends; the cap is a safety net.
  for (let step = 0; step < 100; step++) {
    const result = await db.execute({
      sql: `SELECT MAX(scheduled_at) AS ts FROM wa_booking_send_queue
            WHERE user_id = ? AND kind = 'followup' AND status = 'pending'
              AND scheduled_at > ? AND scheduled_at < ?`,
      args: [
        userId,
        new Date(wantedMs - FOLLOWUP_MIN_GAP_MS).toISOString(),
        new Date(wantedMs + FOLLOWUP_MIN_GAP_MS).toISOString(),
      ],
    });
    const clashMs = Date.parse(String(result.rows[0]?.ts ?? ""));
    if (!Number.isFinite(clashMs)) break;
    wantedMs = clashMs + FOLLOWUP_MIN_GAP_MS + Math.floor(Math.random() * (FOLLOWUP_MAX_GAP_MS - FOLLOWUP_MIN_GAP_MS));
  }
  return new Date(wantedMs).toISOString();
}
