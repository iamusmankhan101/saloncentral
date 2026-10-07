/**
 * Service-based stock consumption: each time a service that uses an item is
 * performed, the item loses the service's recipe amount (Service.inventoryAmounts,
 * "80 ml") or, failing that, 1/N of a unit for "one unit lasts N services".
 *
 * Stock isn't decremented sale by sale — a booked client checked out at POS
 * leaves both an invoice and a completed appointment, and edits/deletes would
 * each need undoing. Instead `settleServiceConsumption` counts performances
 * since the item's `stockCountedAt` (lib/inventory-usage.ts, which already
 * avoids that double count), takes them off `currentStock` and moves the mark
 * to now. Running it again finds nothing new, so it is safe to call often:
 * on load, after a sale, after completing an appointment. A performance is
 * timed when it first completed (Appointment.completedAt is never moved), so
 * flipping an appointment's status back and forth can't deduct it twice.
 */

import { getStoredAppointments, getStoredInventory, getStoredServices, saveInventory } from "./storage";
import { getSalonInvoices } from "./salon-invoices";
import { itemsWithServiceRates, unitsConsumedSince } from "./inventory-usage";
import type { InventoryItem } from "./types";

/** Stock is kept to 4 decimals, so 15 g off a kg-stocked item (0.015) isn't rounded away. */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function consumesByService(item: InventoryItem, serviceRated?: Set<string>): boolean {
  return Number(item.servicesPerUnit) > 0 || !!serviceRated?.has(item.id);
}

/** Brings every service-consumed item's stock up to date. Returns how many items changed. */
export function settleServiceConsumption(): number {
  if (typeof window === "undefined") return 0;
  const inventory = getStoredInventory();
  const services = getStoredServices();
  const rated = itemsWithServiceRates(services);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const since = new Map<string, number>();
  let needsMark = false;
  for (const item of inventory) {
    if (!consumesByService(item, rated)) continue;
    if (!item.stockCountedAt) { needsMark = true; continue; } // starts counting from now
    since.set(item.id, Date.parse(item.stockCountedAt) || nowMs);
  }
  if (since.size === 0 && !needsMark) return 0;

  const used = since.size
    ? unitsConsumedSince(getSalonInvoices(), getStoredAppointments(), services, since, new Map(inventory.map((i) => [i.id, i])), nowMs)
    : new Map<string, number>();
  let changed = 0;
  const next = inventory.map((item) => {
    if (!consumesByService(item, rated)) return item;
    if (!item.stockCountedAt) { changed++; return { ...item, stockCountedAt: now }; }
    const units = used.get(item.id) ?? 0;
    if (!units) return item;
    changed++;
    return { ...item, currentStock: Math.max(0, round4(item.currentStock - units)), stockCountedAt: now };
  });
  if (changed) saveInventory(next);
  return changed;
}
