import { db } from "@/lib/db";

export type BackupReason =
  | "before-write"
  | "manual-snapshot"
  | "scheduled-snapshot"
  | "before-account-delete";

export interface SalonDataBackupRow {
  id: string;
  userId: string;
  entity: string;
  locationId: string;
  dataKind: string;
  data: string;
  recordCount: number;
  reason: BackupReason;
  sourceUpdatedAt: string | null;
  createdAt: string;
}

export interface DatabaseBackupArchive {
  id: string;
  reason: BackupReason;
  tableCount: number;
  totalRows: number;
  createdAt: string;
}

function backupId(): string {
  return `backup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function recordCountFor(data: string): number {
  // 0 rather than null for non-list data (e.g. settings, a single object) —
  // the live salon_data_backups table has record_count as NOT NULL, and
  // CREATE TABLE IF NOT EXISTS can't loosen that constraint on a table that
  // already exists, so passing null here fails the write outright.
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function dataKindFromEntity(entity: string): string {
  const parts = entity.split("_");
  const last = parts.at(-1) || entity;
  if (entity.endsWith("_salon_invoices")) return "salon_invoices";
  if (entity.endsWith("_loyalty_history")) return "loyalty_history";
  if (entity.endsWith("_held_sales")) return "held_sales";
  return last;
}

export function locationIdFromEntity(entity: string, userId: string): string {
  const suffix = entity === userId ? "" : entity.startsWith(`${userId}_`) ? entity.slice(userId.length + 1) : "";
  if (!suffix) return "main";
  const dataKind = dataKindFromEntity(entity);
  const bareKinds = new Set(["settings", "loyalty_history", "clients", "appointments", "staff", "services", "inventory", "expenses", "salon_invoices", "held_sales"]);
  if (bareKinds.has(suffix)) return "main";
  if (!suffix.endsWith(`_${dataKind}`)) return "main";
  const location = suffix.slice(0, -(dataKind.length + 1));
  return location || "main";
}

export async function ensureSalonDataBackupTable(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS salon_data_backups (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      entity            TEXT NOT NULL,
      location_id       TEXT NOT NULL DEFAULT 'main',
      data_kind         TEXT NOT NULL,
      data              TEXT NOT NULL,
      record_count      INTEGER,
      reason            TEXT NOT NULL,
      source_updated_at TEXT,
      created_at        TEXT NOT NULL
    )
  `);
  // Self-healing migration: CREATE TABLE IF NOT EXISTS above is a no-op once
  // the table already exists, so an older deployment of this table (created
  // back when this column was named "payload") never picks up a rename made
  // here in code — every write through backupExistingSalonData() (called
  // before nearly every salon_data/settings write) then fails outright with
  // "no column named data". Renaming in place on first use fixes it for good,
  // on this or any other environment/replica that's still on the old schema,
  // without a separate manual migration step.
  try {
    const cols = await db.execute(`PRAGMA table_info(salon_data_backups)`);
    const colNames = new Set(cols.rows.map(r => r.name as string));
    if (colNames.has("payload") && !colNames.has("data")) {
      await db.execute(`ALTER TABLE salon_data_backups RENAME COLUMN payload TO data`);
    }
  } catch (err) {
    console.error("[data-backup] Failed to migrate salon_data_backups.payload -> data:", err);
  }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_salon_data_backups_user_created ON salon_data_backups (user_id, created_at DESC)`).catch(() => {});
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_salon_data_backups_entity_created ON salon_data_backups (entity, created_at DESC)`).catch(() => {});
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function ensureDatabaseBackupTable(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS database_backups (
      id          TEXT PRIMARY KEY,
      reason      TEXT NOT NULL,
      table_count INTEGER NOT NULL,
      total_rows  INTEGER NOT NULL,
      data        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_database_backups_created ON database_backups (created_at DESC)`).catch(() => {});
}

export async function createSalonDataBackup(input: {
  userId: string;
  entity: string;
  data: string;
  reason: BackupReason;
  sourceUpdatedAt?: string | null;
}): Promise<string> {
  await ensureSalonDataBackupTable();
  const id = backupId();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO salon_data_backups
            (id, user_id, entity, location_id, data_kind, data, record_count, reason, source_updated_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.userId,
      input.entity,
      locationIdFromEntity(input.entity, input.userId),
      dataKindFromEntity(input.entity),
      input.data,
      recordCountFor(input.data),
      input.reason,
      input.sourceUpdatedAt ?? null,
      now,
    ],
  });
  return id;
}

export async function backupExistingSalonData(entity: string, userId: string, reason: BackupReason = "before-write"): Promise<string | null> {
  await ensureSalonDataBackupTable();
  const existing = await db.execute({
    sql: "SELECT data, updated_at FROM salon_data WHERE entity = ?",
    args: [entity],
  });
  if (existing.rows.length === 0) return null;
  return createSalonDataBackup({
    userId,
    entity,
    data: existing.rows[0].data as string,
    sourceUpdatedAt: (existing.rows[0].updated_at as string | undefined) ?? null,
    reason,
  });
}

export async function snapshotAllSalonData(reason: BackupReason = "manual-snapshot"): Promise<{ backupsCreated: number }> {
  await ensureSalonDataBackupTable();
  const rows = await db.execute("SELECT entity, data, updated_at FROM salon_data ORDER BY entity ASC");
  const users = await db.execute("SELECT id FROM users").catch(() => ({ rows: [] as Array<{ id: string }> }));
  const userIds = users.rows.map((row) => String(row.id)).sort((a, b) => b.length - a.length);
  let backupsCreated = 0;

  for (const row of rows.rows) {
    const entity = row.entity as string;
    const userId = userIds.find((id) => entity === id || entity.startsWith(`${id}_`)) ?? entity.split("_")[0];
    await createSalonDataBackup({
      userId,
      entity,
      data: row.data as string,
      sourceUpdatedAt: (row.updated_at as string | undefined) ?? null,
      reason,
    });
    backupsCreated++;
  }

  return { backupsCreated };
}

/**
 * The backup tables themselves are left out of the full archive. Including them
 * made every archive carry every earlier backup — salon_data_backups alone
 * reached gigabytes — until the archive grew too large to write and every
 * backup run (manual and daily) failed.
 */
const ARCHIVE_EXCLUDED_TABLES = ["database_backups", "salon_data_backups", "salon_backup_bundles"];

export async function snapshotFullDatabase(reason: BackupReason = "manual-snapshot"): Promise<DatabaseBackupArchive> {
  await ensureDatabaseBackupTable();
  const tables = await db.execute({ sql: `
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT IN (${ARCHIVE_EXCLUDED_TABLES.map(() => "?").join(", ")})
    ORDER BY name ASC
  `, args: ARCHIVE_EXCLUDED_TABLES });

  const archiveTables: Array<{ name: string; schema: string | null; rows: unknown[] }> = [];
  let totalRows = 0;

  for (const table of tables.rows) {
    const name = String(table.name);
    const rows = await db.execute(`SELECT * FROM ${quoteSqlIdentifier(name)}`);
    archiveTables.push({
      name,
      schema: (table.sql as string | null) ?? null,
      rows: rows.rows,
    });
    totalRows += rows.rows.length;
  }

  const id = backupId();
  const createdAt = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO database_backups (id, reason, table_count, total_rows, data, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, reason, archiveTables.length, totalRows, JSON.stringify({ tables: archiveTables }), createdAt],
  });

  return { id, reason, tableCount: archiveTables.length, totalRows, createdAt };
}

export async function snapshotSalonDataForOwner(userId: string, reason: BackupReason = "before-account-delete"): Promise<{ backupsCreated: number }> {
  await ensureSalonDataBackupTable();
  const rows = await db.execute({
    sql: "SELECT entity, data, updated_at FROM salon_data WHERE entity = ? OR entity LIKE ? ESCAPE '\\'",
    args: [userId, userId.replace(/[\\%_]/g, (c) => "\\" + c) + "\\_%"],
  });
  let backupsCreated = 0;
  for (const row of rows.rows) {
    await createSalonDataBackup({
      userId,
      entity: row.entity as string,
      data: row.data as string,
      sourceUpdatedAt: (row.updated_at as string | undefined) ?? null,
      reason,
    });
    backupsCreated++;
  }
  return { backupsCreated };
}

export async function restoreSalonDataBackup(backupIdToRestore: string): Promise<SalonDataBackupRow | null> {
  await ensureSalonDataBackupTable();
  const result = await db.execute({
    sql: `SELECT id, user_id, entity, location_id, data_kind, data, record_count, reason, source_updated_at, created_at
          FROM salon_data_backups
          WHERE id = ?`,
    args: [backupIdToRestore],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const backup: SalonDataBackupRow = {
    id: row.id as string,
    userId: row.user_id as string,
    entity: row.entity as string,
    locationId: row.location_id as string,
    dataKind: row.data_kind as string,
    data: row.data as string,
    recordCount: row.record_count == null ? 0 : Number(row.record_count),
    reason: row.reason as BackupReason,
    sourceUpdatedAt: (row.source_updated_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };

  await backupExistingSalonData(backup.entity, backup.userId, "before-write");
  await db.execute({
    sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
    args: [backup.entity, backup.data, new Date().toISOString()],
  });
  return backup;
}

// ── Bundled per-salon backups ──────────────────────────────────────────────
//
// snapshotAllSalonData() above writes one row per entity per salon (clients,
// appointments, staff, ...) — great for "undo my last edit", but it means a
// single salon with 11 data types shows up as 11 separate rows in any admin
// view, once per run. For "what did this salon's data look like on this day"
// that's noise, not signal. A bundle is the same underlying data, packaged as
// ONE row per salon per run — one thing to look at, one thing to restore.

export interface SalonBackupBundleSummary {
  id: string;
  userId: string;
  reason: BackupReason;
  entityCount: number;
  totalRecords: number;
  createdAt: string;
}

interface BundleEntity {
  entity: string;
  data: string;
  updatedAt: string | null;
}

export async function ensureSalonBackupBundleTable(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS salon_backup_bundles (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      reason        TEXT NOT NULL,
      entity_count  INTEGER NOT NULL,
      total_records INTEGER NOT NULL,
      data          TEXT NOT NULL,
      created_at    TEXT NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_salon_backup_bundles_user_created ON salon_backup_bundles (user_id, created_at DESC)`).catch(() => {});
}

async function insertBundle(userId: string, entities: BundleEntity[], reason: BackupReason): Promise<string> {
  await ensureSalonBackupBundleTable();
  const id = backupId();
  const now = new Date().toISOString();
  const totalRecords = entities.reduce((sum, e) => sum + recordCountFor(e.data), 0);
  await db.execute({
    sql: `INSERT INTO salon_backup_bundles (id, user_id, reason, entity_count, total_records, data, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, userId, reason, entities.length, totalRecords, JSON.stringify({ entities }), now],
  });
  return id;
}

/** One bundle per salon that currently has data — used by the daily cron and the admin "Run Backup Now" button. */
export async function snapshotAllSalonBundles(reason: BackupReason = "manual-snapshot"): Promise<{ bundlesCreated: number }> {
  await ensureSalonBackupBundleTable();
  const rows = await db.execute("SELECT entity, data, updated_at FROM salon_data ORDER BY entity ASC");
  const users = await db.execute("SELECT id FROM users").catch(() => ({ rows: [] as Array<{ id: string }> }));
  const userIds = users.rows.map((row) => String(row.id)).sort((a, b) => b.length - a.length);

  const byUser = new Map<string, BundleEntity[]>();
  for (const row of rows.rows) {
    const entity = row.entity as string;
    const userId = userIds.find((id) => entity === id || entity.startsWith(`${id}_`)) ?? entity.split("_")[0];
    const list = byUser.get(userId) ?? [];
    list.push({ entity, data: row.data as string, updatedAt: (row.updated_at as string | undefined) ?? null });
    byUser.set(userId, list);
  }

  let bundlesCreated = 0;
  for (const [userId, entities] of byUser) {
    if (entities.length === 0) continue;
    await insertBundle(userId, entities, reason);
    bundlesCreated++;
  }
  return { bundlesCreated };
}

export async function listSalonBackupBundles(userId?: string, limit = 100): Promise<SalonBackupBundleSummary[]> {
  await ensureSalonBackupBundleTable();
  const result = await db.execute(
    userId
      ? { sql: `SELECT id, user_id, reason, entity_count, total_records, created_at FROM salon_backup_bundles WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, args: [userId, limit] }
      : { sql: `SELECT id, user_id, reason, entity_count, total_records, created_at FROM salon_backup_bundles ORDER BY created_at DESC LIMIT ?`, args: [limit] },
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    reason: row.reason as BackupReason,
    entityCount: Number(row.entity_count),
    totalRecords: Number(row.total_records),
    createdAt: row.created_at as string,
  }));
}

export interface RestoredBundleSummary {
  id: string;
  userId: string;
  entityCount: number;
  createdAt: string;
}

/** Restores every entity in a bundle — a safety before-write copy of each entity's *current* data is taken first, same as the single-entity restore. */
export async function restoreSalonBackupBundle(bundleId: string): Promise<RestoredBundleSummary | null> {
  await ensureSalonBackupBundleTable();
  const result = await db.execute({
    sql: "SELECT id, user_id, entity_count, data, created_at FROM salon_backup_bundles WHERE id = ?",
    args: [bundleId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const userId = row.user_id as string;
  const parsed = JSON.parse(row.data as string) as { entities: BundleEntity[] };
  const now = new Date().toISOString();

  for (const entry of parsed.entities) {
    await backupExistingSalonData(entry.entity, userId, "before-write");
    await db.execute({
      sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
      args: [entry.entity, entry.data, now],
    });
  }

  return {
    id: row.id as string,
    userId,
    entityCount: Number(row.entity_count),
    createdAt: row.created_at as string,
  };
}

// Reasons intentionally excluded from auto-pruning: "manual-snapshot" (someone
// deliberately took it) and "before-account-delete" (the one safety net for a
// destructive, hard-to-notice-in-time action). Both stay forever. Everything
// else grows unbounded otherwise — "before-write" alone was ~470 rows/week.
const RETENTION_DAYS: Partial<Record<BackupReason, number>> = {
  "before-write": 7,
  "scheduled-snapshot": 30,
};

export interface BackupPruneResult {
  salonDataBackupsDeleted: number;
  databaseBackupsDeleted: number;
  salonBundlesDeleted: number;
}

export async function pruneOldBackups(): Promise<BackupPruneResult> {
  await ensureSalonDataBackupTable();
  await ensureDatabaseBackupTable();
  await ensureSalonBackupBundleTable();

  let salonDataBackupsDeleted = 0;
  let databaseBackupsDeleted = 0;
  let salonBundlesDeleted = 0;

  for (const [reason, days] of Object.entries(RETENTION_DAYS) as [BackupReason, number][]) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const salonResult = await db.execute({
      sql: "DELETE FROM salon_data_backups WHERE reason = ? AND created_at < ?",
      args: [reason, cutoff],
    });
    salonDataBackupsDeleted += Number(salonResult.rowsAffected ?? 0);

    const dbResult = await db.execute({
      sql: "DELETE FROM database_backups WHERE reason = ? AND created_at < ?",
      args: [reason, cutoff],
    });
    databaseBackupsDeleted += Number(dbResult.rowsAffected ?? 0);

    const bundleResult = await db.execute({
      sql: "DELETE FROM salon_backup_bundles WHERE reason = ? AND created_at < ?",
      args: [reason, cutoff],
    });
    salonBundlesDeleted += Number(bundleResult.rowsAffected ?? 0);
  }

  return { salonDataBackupsDeleted, databaseBackupsDeleted, salonBundlesDeleted };
}
