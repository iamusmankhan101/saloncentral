/**
 * Every stock change that isn't a service using products up: restocks,
 * wastage, counts, retail sales, purchases, returns. Service consumption is
 * not logged here — it is derived from the sales and appointments themselves
 * (lib/inventory-usage.ts consumptionHistory) — so the item's full history is
 * the two merged.
 *
 * Append-only with unique ids, so the sync's union-by-id merge never loses an
 * entry written on another device.
 */

import { locationUserKey } from "./locations";
import { persistEntity } from "./turso-sync";
import type { InventoryItem } from "./types";

export type StockChangeReason =
  | "opening" | "restock" | "wastage" | "correction" | "sold" | "purchase" | "returned" | "import";

export const STOCK_REASON_LABEL: Record<StockChangeReason, string> = {
  opening: "Opening stock",
  restock: "Restocked",
  wastage: "Wastage",
  correction: "Stock count correction",
  sold: "Sold at POS",
  purchase: "Purchase (Expenses)",
  returned: "Returned to stock",
  import: "Excel import",
};

export interface StockLogEntry {
  id: string;
  itemId: string;
  /** Signed, in the item's unit: +5000 restocked, −1 wasted. */
  change: number;
  stockAfter: number;
  reason: StockChangeReason;
  note?: string;
  /** ISO time. */
  at: string;
}

export interface StockChange {
  reason: StockChangeReason;
  note?: string;
}

const KEY = "werzio_inventory_log";

export function getInventoryLog(): StockLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(locationUserKey(KEY)) ?? "[]") as StockLogEntry[];
  } catch {
    return [];
  }
}

/**
 * Logs each item whose stock differs between `before` and `after`. An item
 * new in `after` is its opening stock whatever the reason given.
 */
export function logStockChanges(before: InventoryItem[], after: InventoryItem[], { reason, note }: StockChange): void {
  const was = new Map(before.map((i) => [i.id, i.currentStock]));
  const at = new Date().toISOString();
  const entries: StockLogEntry[] = [];
  for (const item of after) {
    const prev = was.get(item.id);
    const change = Math.round((item.currentStock - (prev ?? 0)) * 10_000) / 10_000;
    if (!change) continue;
    entries.push({
      id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      itemId: item.id, change, stockAfter: item.currentStock,
      reason: prev === undefined ? "opening" : reason,
      ...(note ? { note } : {}), at,
    });
  }
  // ponytail: one ever-growing synced list; trim old entries if it gets heavy.
  if (entries.length) persistEntity("inventory_log", [...getInventoryLog(), ...entries]);
}
