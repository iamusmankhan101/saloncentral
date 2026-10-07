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
import { consumptionHistory, itemsWithServiceRates, unitsConsumedSince } from "./inventory-usage";
import type { SalonInvoice } from "./salon-invoices";
import type { Appointment, InventoryItem } from "./types";

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

/**
 * What these sales/appointments have already taken off stock, per item — for
 * putting it back when they are deleted or un-completed. Call it while they
 * still exist. Only settled amounts count (performed before the item's
 * stockCountedAt); anything not yet settled simply never gets deducted once
 * the records are gone. Pass a linked appointment along with its invoice so
 * the pair is counted once, at the time it was really deducted.
 */
export function settledConsumption(invoices: SalonInvoice[], appointments: Appointment[]): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof window === "undefined" || (!invoices.length && !appointments.length)) return out;
  const services = getStoredServices();
  for (const item of getStoredInventory()) {
    const mark = Date.parse(item.stockCountedAt ?? "");
    if (!mark) continue;
    const qty = consumptionHistory(invoices, appointments, services, item)
      .filter((e) => e.at <= mark)
      .reduce((sum, e) => sum + e.qty, 0);
    if (qty > 0) out.set(item.id, round4(qty));
  }
  return out;
}

/** Adds `amounts` (from settledConsumption) back onto stock, logged as returned. */
export function returnToStock(amounts: Map<string, number>, note: string): void {
  if (!amounts.size) return;
  saveInventory(getStoredInventory().map((item) => {
    const qty = amounts.get(item.id);
    return qty ? { ...item, currentStock: round4(item.currentStock + qty) } : item;
  }), { reason: "returned", note });
}
