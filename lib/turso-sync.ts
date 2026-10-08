import { getCurrentUser, userKey } from "./auth";
import { getActiveLocationFilter, locationUserKey } from "./locations";
import { appendDeletions, getDeletedRecords, DELETED_RECORDS_ENTITY } from "./deleted-records";
import {
  entityStorageKey,
  noteSyncedArrivals,
  pickNewer,
  recordId,
  reconcileSave,
  sameRecordContent,
} from "./sync-records";
import {
  clearPending,
  isDefinitelyOffline,
  listPending,
  markPending,
  type PendingWrite,
} from "./offline-queue";

const ENTITIES = ["clients", "appointments", "staff", "services", "inventory", "salon_invoices", "expenses", "attendance", "payouts", "cash_flow_income", "held_sales", "inventory_log", "consultations", "treatment_plans", "consents", "clinic_photos", "prescriptions", "leads", "treatment_charts", "waitlist", DELETED_RECORDS_ENTITY] as const;
type Entity = typeof ENTITIES[number];

/**
 * Fired on `window` after syncFromDB() has finished rewriting localStorage.
 * Pages that hold entity lists in React state listen for it (see
 * subscribeToStoredData in lib/storage.ts) and re-read.
 */
export const DATA_SYNCED_EVENT = "werzio_data_synced";

/**
 * On app load: pull all data from Turso into the user-scoped localStorage slots.
 * Only runs when a user is logged in (getCurrentUser() returns non-null).
 */
export async function syncFromDB(): Promise<void> {
  const user = getCurrentUser();
  if (!user) return;
  const dataOwnerId = user.salonOwnerId || user.id;
  const locationId = getActiveLocationFilter();

  // Sync core entities (clients, appointments, staff, services, inventory)
  await Promise.all(
    ENTITIES.map(async (entity) => {
      try {
        const res = await fetch(
          `/api/db?entity=${entity}&userId=${encodeURIComponent(dataOwnerId)}&locationId=${encodeURIComponent(locationId)}`,
        );
        if (!res.ok) return;
        const incoming = await res.json() as unknown[];
        if (!Array.isArray(incoming) || incoming.length === 0) {
          // Turso has nothing for this entity yet on this account/location — if this
          // browser is holding local data that predates sync support (e.g. expenses,
          // which only started syncing after this check was added), push it up now
          // instead of waiting for the next add/edit to trigger a save. Awaited so a
          // later syncFromDB() can't race ahead and see the still-empty DB row.
          try {
            const lsRaw = localStorage.getItem(locationUserKey(`werzio_${entity}`, locationId));
            const local = lsRaw ? JSON.parse(lsRaw) as unknown[] : [];
            if (Array.isArray(local) && local.length > 0) {
              await fetch("/api/db", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entity, data: local, userId: dataOwnerId, locationId }),
              }).catch(() => {});
            }
          } catch { /* ignore */ }
          return;
        }

        // Merge by id instead of blindly overwriting: any record that exists only in
        // localStorage (e.g. added while offline, or not yet pushed to Turso) is kept
        // rather than dropped just because the DB's copy didn't have it. Without this,
        // a DB row that is behind (or was raced by a smaller concurrent save) silently
        // truncates whatever the browser already had — this is how the expenses total
        // dropped from 400k+ to a handful of recent entries.
        const lsRaw = localStorage.getItem(entityStorageKey(entity, locationId));
        const localList: Record<string, unknown>[] = [];
        if (lsRaw) {
          try { localList.push(...(JSON.parse(lsRaw) as Record<string, unknown>[])); } catch { /* ignore */ }
        }
        const incomingIds = new Set((incoming as Record<string, unknown>[]).map(recordId));
        const localOnly = localList.filter(r => !incomingIds.has(recordId(r)));
        const localIds = new Set(localList.map(recordId));

        // Ids this sync is pulling in from another device. reconcileSave() must
        // not read them as deletes when a page that snapshotted its state
        // before they landed saves that older list back (see lib/sync-records.ts).
        noteSyncedArrivals(
          entity,
          (incoming as Record<string, unknown>[]).map(recordId).filter(id => id && !localIds.has(id)),
          locationId,
        );

        // True once the merge below has kept a local copy that differs from the
        // DB's, i.e. this browser holds an edit Turso has not got yet.
        let localWon = false;
        let merged: Record<string, unknown>[];

        if (entity === "clients") {
          // Additionally: never overwrite a client's numeric progress (loyalty pts,
          // visits, spend) with a staler value from DB — guards against the race where
          // a POS save completes after syncFromDB already started its fetch.
          const localById: Record<string, Record<string, unknown>> = {};
          localList.forEach(c => { localById[recordId(c)] = c; });
          merged = (incoming as Record<string, unknown>[]).map(dbClient => {
            const lc = localById[recordId(dbClient)];
            if (!lc) return dbClient;
            const base = pickNewer(lc, dbClient);
            if (base === lc && !sameRecordContent(lc, dbClient)) localWon = true;
            return {
              ...base,
              loyaltyPoints:       Math.max(Number(lc.loyaltyPoints       ?? 0), Number(dbClient.loyaltyPoints       ?? 0)),
              loyaltyPointsEarned: Math.max(Number(lc.loyaltyPointsEarned ?? 0), Number(dbClient.loyaltyPointsEarned ?? 0)),
              totalVisits:         Math.max(Number(lc.totalVisits          ?? 0), Number(dbClient.totalVisits          ?? 0)),
              totalSpend:          Math.max(Number(lc.totalSpend           ?? 0), Number(dbClient.totalSpend           ?? 0)),
            };
          });
        } else {
          // For a record both sides hold, keep whichever copy was edited last
          // (`_updatedAt`, stamped by reconcileSave on every save). This used to
          // prefer the local copy unconditionally, which protected an
          // in-flight save from being reverted by the pre-edit DB row — but it
          // also meant an edit made on another PC could never arrive here, and
          // syncLocalDataToDB() then pushed this browser's stale copy back over
          // it. Ties still go local, so a locally-saved edit whose push failed
          // (stamped now) beats the DB's older copy, and legacy records that
          // predate stamping behave exactly as they did before.
          const localById: Record<string, Record<string, unknown>> = {};
          localList.forEach(r => { localById[recordId(r)] = r; });
          merged = (incoming as Record<string, unknown>[]).map(dbRecord => {
            const lc = localById[recordId(dbRecord)];
            if (!lc) return dbRecord;
            const winner = pickNewer(lc, dbRecord);
            if (winner === lc && !sameRecordContent(lc, dbRecord)) localWon = true;
            return winner;
          });
        }

        const union = [...merged, ...localOnly];
        localStorage.setItem(entityStorageKey(entity, locationId), JSON.stringify(union));

        if (localOnly.length > 0 || localWon) {
          // Push the reconciled (union) list back up so Turso stops being behind.
          // It has to be the *merged* list, not the DB's own rows: this browser
          // is holding either records Turso has never seen or a newer copy of
          // one it has, and pushing `incoming` back would just echo the stale
          // version straight back at it.
          fetch("/api/db", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entity, data: union, userId: dataOwnerId, locationId }),
          }).catch(() => {});
        }
      } catch { /* keep localStorage */ }
    }),
  );

  // Deletes have to survive the union merge above. A record deleted on this
  // device still exists in every other device's localStorage (and, for
  // invoices, in the WhatsApp receipt queue that the salon_invoices GET merges
  // from), so without this pass the merge quietly brings it back a few minutes
  // later — which is exactly how deleted invoices reappeared. Tombstones are
  // unioned across devices by the same loop, so by the time it finishes we hold
  // every deletion any device has recorded.
  applyDeletions(locationId);

  // Sync settings
  try {
    const res = await fetch(`/api/settings?userId=${encodeURIComponent(dataOwnerId)}`);
    if (res.ok) {
      const { data, updatedAt } = await res.json() as { data: object | null; updatedAt: string | null };
      if (data && typeof data === "object") {
        // saveSettingsToDB() (lib/turso-sync.ts) is fire-and-forget from most
        // callers and can still be in flight — or can have failed outright —
        // when syncFromDB() runs on the very next page load/navigation. Without
        // this check, a just-saved edit (salon name, logo, etc.) gets silently
        // overwritten by the stale row this GET just fetched, which is exactly
        // what "settings revert after refresh" looks like from the outside.
        const localSavedAt = localStorage.getItem(userKey("werzio_settings_saved_at"));
        const localIsNewer = !!localSavedAt && !!updatedAt && localSavedAt > updatedAt;
        if (!localIsNewer) {
          localStorage.setItem(userKey("werzio_settings"), JSON.stringify(data));
        }
      }
    }
  } catch { /* keep localStorage */ }

  // Sync loyalty transaction history — same merge-by-id protection as the
  // ENTITIES loop above (saveLoyaltyHistoryToDB is fire-and-forget from most
  // callers, so a blind overwrite here could revert a just-awarded/redeemed
  // transaction the same way settings used to revert on refresh).
  try {
    const res = await fetch(`/api/loyalty?userId=${encodeURIComponent(dataOwnerId)}&locationId=${encodeURIComponent(locationId)}`);
    if (res.ok) {
      const { data: incoming } = await res.json() as { data: Record<string, unknown>[] };
      if (Array.isArray(incoming)) {
        const lsRaw = localStorage.getItem(locationUserKey("werzio_loyalty_history", locationId));
        const localList: Record<string, unknown>[] = [];
        if (lsRaw) {
          try { localList.push(...(JSON.parse(lsRaw) as Record<string, unknown>[])); } catch { /* ignore */ }
        }
        const incomingIds = new Set(incoming.map(r => r.id as string));
        const localOnly = localList.filter(r => !incomingIds.has(r.id as string));
        const localById: Record<string, Record<string, unknown>> = {};
        localList.forEach(r => { localById[r.id as string] = r; });
        const merged = incoming.map(dbRecord => localById[dbRecord.id as string] ?? dbRecord);
        const union = [...merged, ...localOnly];
        if (union.length > 0) {
          localStorage.setItem(locationUserKey("werzio_loyalty_history", locationId), JSON.stringify(union));
        }
        if (localOnly.length > 0) {
          fetch("/api/loyalty", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: dataOwnerId, locationId, data: union }),
          }).catch(() => {});
        }
      }
    }
  } catch { /* keep localStorage */ }

  // Every listing page reads localStorage once, when it mounts. This sync just
  // rewrote it underneath whatever pages are currently open — including a POS
  // terminal that has been sitting on the same screen since this morning — so
  // tell them to re-read. Without it those pages keep rendering (and saving
  // from) a snapshot that is missing everything added on any other device.
  window.dispatchEvent(new Event(DATA_SYNCED_EVENT));
}

/**
 * Removes every tombstoned record from the local entity lists, and re-pushes any
 * list this actually changed so Turso matches what the browser now shows (the
 * union push in syncFromDB may have just sent a resurrected row back up).
 */
function applyDeletions(locationId: string): void {
  if (typeof window === "undefined") return;
  const tombstones = getDeletedRecords(locationId);
  if (tombstones.length === 0) return;

  for (const entity of ENTITIES) {
    if (entity === DELETED_RECORDS_ENTITY) continue;
    const ids = new Set(tombstones.filter((t) => t.entity === entity).map((t) => t.id));
    if (ids.size === 0) continue;

    const key = locationUserKey(`werzio_${entity}`, locationId);
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const list = JSON.parse(raw) as { id?: string }[];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((r) => !ids.has(String(r?.id ?? "")));
      if (kept.length === list.length) continue;
      localStorage.setItem(key, JSON.stringify(kept));
      saveToDB(entity, kept);
    } catch { /* leave this entity alone */ }
  }
}

/**
 * Tombstones `ids` as deleted for `entity` — locally first, then in Turso — so
 * neither this browser's next sync nor another device can merge them back in.
 * Call this from every delete path alongside the usual "save the shorter list"
 * write; on its own, that write is not a durable delete (see lib/deleted-records.ts).
 */
export function recordDeletions(entity: Entity, ids: string[]): Promise<boolean> {
  const list = appendDeletions(entity, ids);
  if (list.length === 0) return Promise.resolve(false);
  return saveToDB(DELETED_RECORDS_ENTITY, list);
}

/**
 * POSTs with up to 3 attempts and exponential back-off (1s/2s/4s), resolving
 * true/false with the outcome instead of throwing. Every "save to Turso"
 * function in this file is built on this — a save that silently gives up
 * after one failed attempt is exactly how data (expenses, invoices, settings)
 * has gone missing or reverted after a refresh in the past. New save
 * functions should use this too rather than a bare fire-and-forget fetch.
 */
async function retryFetch(url: string, options: RequestInit, label: string, tries = 3): Promise<boolean> {
  // Don't spend 1s + 2s + 4s proving what the browser already knows. The
  // caller queues the write and it goes up on reconnect instead.
  if (isDefinitelyOffline()) return false;
  try {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return true;
  } catch (err) {
    if (tries <= 1) {
      console.warn(`[${label}] failed after all retries:`, err);
      return false;
    }
    const delay = 2 ** (3 - tries) * 1000; // 1s, 2s, 4s
    await new Promise(res => setTimeout(res, delay));
    return retryFetch(url, options, label, tries - 1);
  }
}

/**
 * Re-push the browser's currently visible local data to Turso. This runs after
 * syncFromDB() has merged DB + localStorage, so it does not ask the user to log
 * out and does not drop records that only existed locally during a sync gap.
 */
export async function syncLocalDataToDB(): Promise<boolean> {
  const user = getCurrentUser();
  if (!user || typeof window === "undefined") return false;
  const dataOwnerId = user.salonOwnerId || user.id;
  const locationId = getActiveLocationFilter();

  const results = await Promise.all(
    ENTITIES.map(async (entity) => {
      try {
        const raw = localStorage.getItem(locationUserKey(`werzio_${entity}`, locationId));
        if (!raw) return true;
        const data = JSON.parse(raw) as unknown;
        if (!Array.isArray(data)) return true;

        const body = JSON.stringify({ entity, data, userId: dataOwnerId, locationId });
        return retryFetch(
          "/api/db",
          { method: "POST", headers: { "Content-Type": "application/json" }, body },
          `syncLocalDataToDB:${entity}`,
        );
      } catch (err) {
        console.warn(`[syncLocalDataToDB:${entity}] skipped:`, err);
        return false;
      }
    }),
  );

  return results.every(Boolean);
}

/**
 * Push the updated list to Turso under the user-scoped key. Most callers
 * don't await it (fire-and-forget, doesn't block the UI), but a caller that
 * needs to know whether the write actually landed (e.g. POS checkout, so it
 * can warn the cashier instead of silently losing the sale from every device
 * but the one that rang it up) can await the result.
 */
export async function saveToDB(entity: Entity, data: unknown[], locationId?: string): Promise<boolean> {
  const user = getCurrentUser();
  if (!user) return false;
  const dataOwnerId = user.salonOwnerId || user.id;
  // Explicit when flushing the outbox: the queued write belongs to whichever
  // branch was active when it was made, which may not be the active one now.
  const loc = locationId ?? getActiveLocationFilter();

  const body = JSON.stringify({ entity, data, userId: dataOwnerId, locationId: loc });
  const ok = await retryFetch("/api/db", { method: "POST", headers: { "Content-Type": "application/json" }, body }, `saveToDB:${entity}`);
  trackWrite({ kind: "entity", entity, locationId: loc }, ok);
  return ok;
}

/**
 * Queues a failed write for retry on reconnect, or clears it once it lands.
 *
 * Called on every outcome rather than only on failure: a save that succeeds
 * after an offline spell is exactly what should empty the outbox, and routing
 * both outcomes through one place keeps the queue from drifting out of step
 * with what Turso actually holds.
 */
function trackWrite(w: PendingWrite, ok: boolean): void {
  if (ok) clearPending(w);
  else markPending(w);
}

export interface PersistOptions {
  locationId?: string;
  /** Ids this save is deliberately deleting — see ReconcileOptions.deletedIds. */
  deletedIds?: string[];
  /**
   * Whether a record missing from `list` counts as a delete. Pass `false` (and
   * declare deletes via `deletedIds`) for any entity whose pages hold a
   * long-lived in-memory copy of the list — see ReconcileOptions.inferDeletes.
   */
  inferDeletes?: boolean;
}

/**
 * The one way an entity list should be written. It reconciles the list against
 * what this browser already holds (see lib/sync-records.ts) before persisting:
 *
 *   • records whose content changed get an `_updatedAt` stamp, so the merge on
 *     the other PC — and on the server — can tell a real edit from a stale copy
 *     instead of guessing;
 *   • ids in `options.deletedIds` are tombstoned, which is what actually makes a
 *     delete stick now that POST /api/db unions rather than overwrites;
 *   • records that simply aren't in `list` are put back unless the caller opted
 *     into `inferDeletes`, so a page saving a stale snapshot can't wipe records
 *     it never knew about.
 *
 * Resolves false if either the record write or the tombstone write failed, so
 * callers that already surface a sync warning keep working.
 */
export async function persistEntity(entity: Entity, list: unknown[], options: PersistOptions = {}): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const loc = options.locationId ?? getActiveLocationFilter();
  const { records, removedIds } = reconcileSave(entity, list, {
    locationId: loc,
    deletedIds: options.deletedIds,
    inferDeletes: options.inferDeletes,
  });
  localStorage.setItem(entityStorageKey(entity, loc), JSON.stringify(records));

  // Tombstones go up first so the record write that follows is already filtered
  // against them server-side. (Out of order it still converges — the next GET
  // strips tombstoned records and rewrites the row — but only after a delay
  // during which another device could pull the deleted record back in.)
  const tombstoned = removedIds.length === 0 ? true : await recordDeletions(entity, removedIds);
  const saved = await saveToDB(entity, records);
  return saved && tombstoned;
}

/**
 * Save settings object to Turso. Most callers still don't await it, but the
 * caller does need to know whether the write actually landed (see
 * saveSettings() in lib/settings-store.ts) since a silently-failed save
 * previously looked identical to a successful one until the next refresh
 * quietly reverted it.
 */
export async function saveSettingsToDB(data: object): Promise<boolean> {
  const user = getCurrentUser();
  if (!user) return false;
  const body = JSON.stringify({ userId: user.salonOwnerId || user.id, data });
  const ok = await retryFetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body }, "saveSettingsToDB");
  trackWrite({ kind: "settings" }, ok);
  return ok;
}

/**
 * Save loyalty transaction history to Turso. Still fire-and-forget from most
 * callers, but no longer gives up silently on the first network hiccup.
 */
export async function saveLoyaltyHistoryToDB(data: unknown[], locationId?: string): Promise<boolean> {
  const user = getCurrentUser();
  if (!user) return false;
  const loc = locationId ?? getActiveLocationFilter();

  const body = JSON.stringify({
    userId: user.salonOwnerId || user.id,
    locationId: loc,
    data,
  });
  const ok = await retryFetch("/api/loyalty", { method: "POST", headers: { "Content-Type": "application/json" }, body }, "saveLoyaltyHistoryToDB");
  trackWrite({ kind: "loyalty", locationId: loc }, ok);
  return ok;
}

/**
 * Push the latest loyalty points / profile to an existing Google Wallet pass.
 * Fire-and-forget. Pass `client` so the handler uses fresh data directly and
 * avoids a Turso re-fetch race (saveToDB is async and may not have settled yet).
 */
export function syncWalletPass(clientId: string, client?: unknown): void {
  const user = getCurrentUser();
  if (!user) return;

  fetch("/api/wallet/loyalty", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ salonId: user.salonOwnerId || user.id, clientId, client }),
  }).catch(() => {});
}

// ─── Outbox flush ────────────────────────────────────────────────────────────

/**
 * Pushes everything the outbox still owes Turso.
 *
 * Each entry is resolved against localStorage *now* rather than against
 * whatever the data looked like when the write first failed, so a record
 * edited five times during an outage syncs once, in its final state. An entry
 * whose data has since vanished locally is dropped rather than retried
 * forever — there is nothing left to push.
 *
 * Returns the number of entries that landed. Entries that fail stay queued.
 */
export async function flushPendingWrites(): Promise<number> {
  if (typeof window === "undefined") return 0;
  if (!getCurrentUser()) return 0;

  const pending = listPending();
  if (pending.length === 0) return 0;
  if (isDefinitelyOffline()) return 0;

  let flushed = 0;
  // Sequential on purpose: these are whole-list writes to the same few rows,
  // and firing them together is how a slow connection turns into a pile of
  // half-applied pushes racing each other.
  for (const item of pending) {
    try {
      const sent = await flushOne(item);
      if (sent) flushed++;
    } catch (err) {
      console.warn("[flushPendingWrites] entry failed, staying queued:", err);
    }
  }
  return flushed;
}

function readLocalList(key: string): unknown[] | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function flushOne(item: PendingWrite): Promise<boolean> {
  switch (item.kind) {
    case "entity": {
      const list = readLocalList(entityStorageKey(item.entity as Entity, item.locationId));
      // Nothing local to push — the queue entry outlived its data (cleared
      // branch, signed-out cleanup). Drop it instead of retrying forever.
      if (!list) { clearPending(item); return false; }
      return saveToDB(item.entity as Entity, list, item.locationId);
    }
    case "loyalty": {
      const list = readLocalList(locationUserKey("werzio_loyalty_history", item.locationId));
      if (!list) { clearPending(item); return false; }
      return saveLoyaltyHistoryToDB(list, item.locationId);
    }
    case "settings": {
      const raw = localStorage.getItem(userKey("werzio_settings"));
      if (!raw) { clearPending(item); return false; }
      try {
        return await saveSettingsToDB(JSON.parse(raw) as object);
      } catch {
        clearPending(item);
        return false;
      }
    }
  }
}

/** Set once the listeners are attached — this is wired from the dashboard
 *  layout, which remounts on navigation. */
let flushListenersAttached = false;

/**
 * Flushes the outbox whenever the connection comes back.
 *
 * Listens on three signals because none is reliable alone: `online` fires on
 * reconnect but not when a laptop wakes with wifi already up; a tab returning
 * to the foreground catches that case; and the initial call covers a reload
 * that happens while still offline and then recovers. All three funnel into
 * the same flush, which no-ops when the queue is empty.
 */
export function startOfflineFlush(): void {
  if (typeof window === "undefined" || flushListenersAttached) return;
  flushListenersAttached = true;

  const attempt = () => { flushPendingWrites().catch(() => {}); };

  window.addEventListener("online", attempt);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") attempt();
  });
  attempt();
}
