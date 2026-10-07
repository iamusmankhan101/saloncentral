/**
 * /api/cron/backup
 *
 * Creates one backup bundle per salon (all its data as a single restore
 * point) plus a complete database archive, then prunes anything past its
 * retention window (see RETENTION_DAYS in lib/data-backup.ts) so these
 * tables don't grow forever. Manual snapshots and before-account-delete
 * backups are never pruned. The old one-row-per-entity snapshotAllSalonData()
 * still runs implicitly via backupExistingSalonData() on every write
 * elsewhere in the app (the "before-write" safety net) — this cron no longer
 * duplicates that per entity, since a bundle already captures the same data
 * as one clean row per salon.
 */

import { NextRequest } from "next/server";
import { encryptPlaintextRows, pruneOldBackups, snapshotAllSalonBundles, snapshotFullDatabase } from "@/lib/data-backup";

// The first prune after a long gap can have thousands of expired rows to clear.
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Prune first and on its own: when it ran after the snapshot, a failing
    // snapshot also stopped expired backups from ever being cleared, so the
    // backup tables kept growing — which is what made the snapshot fail.
    const pruned = await pruneOldBackups();
    // Rows from before encryption was switched on, a batch a night.
    const encrypted = await encryptPlaintextRows();
    const [salonBundles, database] = await Promise.all([
      snapshotAllSalonBundles("scheduled-snapshot"),
      snapshotFullDatabase("scheduled-snapshot"),
    ]);
    console.log("[backup] scheduled backup complete:", { salonBundles, database, pruned, encrypted });
    return Response.json({ ok: true, salonBundles, database, pruned, encrypted });
  } catch (err) {
    console.error("[backup] scheduled snapshot error:", err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Backup failed." }, { status: 500 });
  }
}
