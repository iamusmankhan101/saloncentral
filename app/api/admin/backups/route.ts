import { NextRequest } from "next/server";
import type { InValue } from "@libsql/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/api-auth";
import {
  ensureDatabaseBackupTable,
  ensureSalonDataBackupTable,
  listSalonBackupBundles,
  pruneOldBackups,
  restoreSalonBackupBundle,
  restoreSalonDataBackup,
  snapshotAllSalonBundles,
  snapshotFullDatabase,
} from "@/lib/data-backup";

// The first prune after a long gap can have thousands of expired rows to clear.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  const userId = req.nextUrl.searchParams.get("userId");
  const entity = req.nextUrl.searchParams.get("entity");
  const kind = req.nextUrl.searchParams.get("kind");
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") || 100), 1), 500);

  try {
    if (kind === "database") {
      await ensureDatabaseBackupTable();
      const result = await db.execute({
        sql: `SELECT id, reason, table_count, total_rows, created_at
              FROM database_backups
              ORDER BY created_at DESC
              LIMIT ?`,
        args: [limit],
      });
      return Response.json({
        ok: true,
        backups: result.rows.map((row) => ({
          id: row.id,
          reason: row.reason,
          tableCount: row.table_count,
          totalRows: row.total_rows,
          createdAt: row.created_at,
        })),
      });
    }

    // Deep-dive view: the raw one-row-per-entity-per-write history (not shown
    // in the admin UI by default — it's what "before-write" safety copies
    // look like, dozens per salon per day). Kept available for troubleshooting
    // a specific entity, but "bundles" below is the normal restore point.
    if (kind === "writes") {
      await ensureSalonDataBackupTable();
      const filters: string[] = [];
      const args: InValue[] = [];
      if (userId) {
        filters.push("user_id = ?");
        args.push(userId);
      }
      if (entity) {
        filters.push("entity = ?");
        args.push(entity);
      }
      args.push(limit);

      const result = await db.execute({
        sql: `SELECT id, user_id, entity, location_id, data_kind, record_count, reason, source_updated_at, created_at
              FROM salon_data_backups
              ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
              ORDER BY created_at DESC
              LIMIT ?`,
        args,
      });

      return Response.json({
        ok: true,
        backups: result.rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          entity: row.entity,
          locationId: row.location_id,
          dataKind: row.data_kind,
          recordCount: row.record_count,
          reason: row.reason,
          sourceUpdatedAt: row.source_updated_at,
          createdAt: row.created_at,
        })),
      });
    }

    // Default: one row per salon per backup run — the normal restore point.
    const bundles = await listSalonBackupBundles(userId ?? undefined, limit);
    return Response.json({ ok: true, bundles });
  } catch (err) {
    console.error("[admin/backups] GET error:", err);
    return Response.json({ ok: false, error: "Could not load backups." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  let body: { action?: "snapshot-all" | "restore" | "restore-bundle"; backupId?: string; bundleId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  try {
    if (body.action === "snapshot-all") {
      // Same order as the daily cron — clear expired backups before taking new ones.
      await pruneOldBackups();
      const [salonBundles, database] = await Promise.all([
        snapshotAllSalonBundles("manual-snapshot"),
        snapshotFullDatabase("manual-snapshot"),
      ]);
      return Response.json({ ok: true, salonBundles, database });
    }

    if (body.action === "restore-bundle") {
      if (!body.bundleId) return Response.json({ ok: false, error: "Missing bundleId." }, { status: 400 });
      const restored = await restoreSalonBackupBundle(body.bundleId);
      if (!restored) return Response.json({ ok: false, error: "Backup not found." }, { status: 404 });
      return Response.json({ ok: true, restored });
    }

    // Deep-dive restore of a single entity from the "writes" view above.
    if (body.action === "restore") {
      if (!body.backupId) return Response.json({ ok: false, error: "Missing backupId." }, { status: 400 });
      const restored = await restoreSalonDataBackup(body.backupId);
      if (!restored) return Response.json({ ok: false, error: "Backup not found." }, { status: 404 });
      return Response.json({
        ok: true,
        restored: {
          id: restored.id,
          userId: restored.userId,
          entity: restored.entity,
          locationId: restored.locationId,
          dataKind: restored.dataKind,
          recordCount: restored.recordCount,
          createdAt: restored.createdAt,
        },
      });
    }

    return Response.json({ ok: false, error: "Unsupported action." }, { status: 400 });
  } catch (err) {
    console.error("[admin/backups] POST error:", err);
    // Admin-only, so the real reason is shown instead of a generic message.
    return Response.json({ ok: false, error: `Backup operation failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
