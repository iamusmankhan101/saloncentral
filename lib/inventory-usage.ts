// ─── Back-bar inventory usage ─────────────────────────────────────────────────
// How often each stock item gets reached for performing services on clients, as
// opposed to being sold over the counter.
//
// Counted in uses ("this colour was used on 43 clients this month"), and — where
// a service recipe gives an amount (Service.inventoryAmounts) — in quantity too.
//
// Nothing here is a separate log. A service records what it consumes per
// performance (Service.inventoryUsage), and the work already leaves two records
// behind — a POS sale and, when the client booked, a completed appointment — so
// usage is derived by walking those. That means it answers for history the
// moment a service is mapped, rather than only counting from the day the
// mapping was made, and it cannot drift out of step with the sales it is
// derived from.

import type { Appointment, InventoryItem, InventoryUnit, Service } from "@/lib/types";
import type { SalonInvoice } from "@/lib/salon-invoices";

export interface ServiceUsageBreakdown {
  serviceId: string;
  serviceName: string;
  /** Performances of this service that used the item. */
  times: number;
}

export interface ItemUsage {
  itemId: string;
  /** Service performances that used this item, across every service. */
  timesUsed: number;
  /** Which services account for it, biggest user first. */
  byService: ServiceUsageBreakdown[];
  /** YYYY-MM-DD of the most recent performance that used it. */
  lastUsedDate?: string;
}

export interface UsageWindow {
  /** YYYY-MM-DD, inclusive. Omit either end to leave it open. */
  from?: string;
  to?: string;
}

/** Dates are YYYY-MM-DD throughout, which compares correctly as a string. */
function inWindow(date: string, window: UsageWindow): boolean {
  if (!date) return false;
  if (window.from && date < window.from) return false;
  if (window.to && date > window.to) return false;
  return true;
}

/**
 * One performance of one service: the unit this module counts in. A cart line
 * selling the same service twice is two performances, so it consumes twice the
 * mapped quantity.
 */
interface Performance {
  service: Service;
  count: number;
  date: string;
  /** When it happened (ms): the POS sale's time, else the appointment's end time. */
  at: number;
  /** Client name, for the usage history. */
  who: string;
}

/**
 * The services actually performed when one line is sold.
 *
 * A Deal/Package is a single line on the bill but several services on the
 * client, and it is the bundled services that carry the product mappings — the
 * package itself maps nothing. Selling one has to consume what its members
 * consume, or every product used inside a deal would go uncounted. Usage is
 * attributed to the member that declares it (the keratin, not the bridal
 * combo), since that is where the quantity comes from.
 *
 * Packages cannot nest — the Services page excludes packages from the list a
 * package can bundle — so one level of expansion is the whole of it.
 */
function performedServices(service: Service, byId: Map<string, Service>): Service[] {
  const bundled = service.packageServiceIds ?? [];
  if (bundled.length === 0) return [service];
  const members = bundled.map((id) => byId.get(id)).filter((s): s is Service => !!s);
  // A package whose members have all been deleted still consumes its own
  // mapping, if it somehow has one, rather than silently consuming nothing.
  return members.length > 0 ? members : [service];
}

/**
 * The item ids a service uses.
 *
 * `inventoryUsage` briefly held `{ itemId, qty }` objects before quantities were
 * dropped, so anything saved in that window is still on the record and is read
 * here rather than migrated — a stored service is rewritten only when someone
 * edits it, and a mapping that silently stopped counting would be worse than a
 * three-line read.
 */
function usedItemIds(service: Service): string[] {
  const raw = service.inventoryUsage as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => typeof entry === "string" ? entry : (entry as { itemId?: unknown })?.itemId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Resolves an invoice line back to the service it was rung up from.
 *
 * `sourceId` is authoritative but only exists on sales made after it was added,
 * so the name is the fallback for everything older. Renaming a service breaks
 * that fallback for its past sales — unavoidable, since the old invoice records
 * no other trace of which service it was.
 */
function resolveService(
  line: { sourceId?: string; description: string },
  byId: Map<string, Service>,
  byName: Map<string, Service>,
): Service | undefined {
  if (line.sourceId) {
    const hit = byId.get(line.sourceId);
    if (hit) return hit;
  }
  return byName.get(line.description.trim().toLowerCase());
}

/**
 * Every service performance in the window, from both records of the work.
 *
 * A booked client that checks out through POS produces an invoice *and* a
 * completed appointment for the same visit, so appointments are only counted
 * when no invoice claims them — otherwise every booked sale would consume its
 * products twice.
 */
function collectPerformances(
  invoices: SalonInvoice[],
  appointments: Appointment[],
  services: Service[],
  window: UsageWindow,
): Performance[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const byName = new Map(services.map((s) => [s.name.trim().toLowerCase(), s]));
  const performances: Performance[] = [];
  const appointmentById = new Map(appointments.map((a) => [a.id, a]));

  // Invoices, at any status: an unpaid sale is work that was still performed,
  // and the products it used are gone whether or not the client has paid yet.
  const invoicedAppointmentIds = new Set<string>();
  for (const invoice of invoices) {
    if (invoice.appointmentId) invoicedAppointmentIds.add(invoice.appointmentId);
    if (!inWindow(invoice.date, window)) continue;
    for (const line of invoice.items) {
      if (line.type !== "service") continue;
      const sold = resolveService(line, byId, byName);
      if (!sold) continue;
      let at = Date.parse(invoice.createdAt) || new Date(`${invoice.date}T12:00:00`).getTime();
      const appointment = invoice.appointmentId ? appointmentById.get(invoice.appointmentId) : undefined;
      // An advance taken on a booking: nothing has been performed yet. It
      // counts once the appointment is completed.
      if (appointment && appointment.status !== "completed") continue;
      // Linked work is timed at its completion, not the sale: an appointment
      // completed and checked out later must not be taken off a second time at
      // the later sale, and one paid in advance is used up when it is done.
      // Lines added at the desk weren't booked, so they count from whichever
      // came last.
      const doneAt = Date.parse(appointment?.completedAt ?? "");
      if (doneAt) {
        const booked = appointment!.serviceIds.includes(sold.id) || appointment!.guests?.some((g) => g.serviceIds.includes(sold.id));
        at = booked ? doneAt : Math.max(at, doneAt);
      }
      for (const service of performedServices(sold, byId)) {
        performances.push({ service, count: Math.max(1, line.qty), date: invoice.date, at, who: invoice.clientName ?? "" });
      }
    }
  }

  for (const appointment of appointments) {
    if (appointment.status !== "completed") continue;
    if (invoicedAppointmentIds.has(appointment.id)) continue;
    if (!inWindow(appointment.date, window)) continue;
    for (const serviceId of appointment.serviceIds) {
      const booked = byId.get(serviceId);
      if (!booked) continue;
      for (const service of performedServices(booked, byId)) {
        // When it was marked completed; older records fall back to the booked end time.
        const at = Date.parse(appointment.completedAt ?? "")
          || new Date(`${appointment.date}T${appointment.endTime || appointment.startTime || "23:59"}:00`).getTime();
        performances.push({ service, count: 1, date: appointment.date, at, who: appointment.clientName });
      }
    }
  }

  return performances;
}

/**
 * Usage for every inventory item that any service consumed in the window,
 * keyed by item id. Items nothing consumed are absent rather than zeroed —
 * callers that show a full stock list supply their own zero.
 */
export function computeInventoryUsage(
  invoices: SalonInvoice[],
  appointments: Appointment[],
  services: Service[],
  window: UsageWindow = {},
): Map<string, ItemUsage> {
  const usage = new Map<string, ItemUsage>();

  for (const { service, count, date } of collectPerformances(invoices, appointments, services, window)) {
    for (const itemId of usedItemIds(service)) {
      let entry = usage.get(itemId);
      if (!entry) {
        entry = { itemId, timesUsed: 0, byService: [] };
        usage.set(itemId, entry);
      }
      entry.timesUsed += count;
      if (!entry.lastUsedDate || date > entry.lastUsedDate) entry.lastUsedDate = date;

      let breakdown = entry.byService.find((b) => b.serviceId === service.id);
      if (!breakdown) {
        breakdown = { serviceId: service.id, serviceName: service.name, times: 0 };
        entry.byService.push(breakdown);
      }
      breakdown.times += count;
    }
  }

  for (const entry of usage.values()) {
    entry.byService.sort((a, b) => b.times - a.times || a.serviceName.localeCompare(b.serviceName));
  }
  return usage;
}

/** Zero-filled usage for one item, so callers can render a row unconditionally. */
export function usageFor(usage: Map<string, ItemUsage>, itemId: string): ItemUsage {
  return usage.get(itemId) ?? { itemId, timesUsed: 0, byService: [] };
}

/** Services that map to an item — for the inventory item's own detail view. */
export function servicesUsingItem(services: Service[], itemId: string): Service[] {
  return services.filter((s) => usedItemIds(s).includes(itemId));
}

/** Units that convert into each other: [family, size in the family's smallest unit]. */
const UNIT_SCALE: Partial<Record<InventoryUnit, [string, number]>> = {
  ml: ["volume", 1], l: ["volume", 1000], g: ["mass", 1], kg: ["mass", 1000],
};

/** `qty` of `from` expressed in `to`, or undefined when they don't convert (ml → pcs). */
export function convertUnits(qty: number, from: InventoryUnit, to: InventoryUnit): number | undefined {
  if (from === to) return qty;
  const a = UNIT_SCALE[from];
  const b = UNIT_SCALE[to];
  return a && b && a[0] === b[0] ? (qty * a[1]) / b[1] : undefined;
}

/** Units a recipe amount for an item stocked in `unit` can be entered in. */
export function compatibleUnits(unit: InventoryUnit): InventoryUnit[] {
  const units = (Object.keys(UNIT_SCALE) as InventoryUnit[]).filter((u) => convertUnits(1, u, unit) !== undefined);
  return units.length ? units : [unit];
}

/**
 * How much of `item`'s stock, in its own unit, one performance of `service`
 * takes: the recipe amount when one is set, else 1/N from "one unit lasts N
 * services" (the service's own figure, then the item's). 0 = not consumed.
 */
export function amountPerPerformance(service: Service, item: InventoryItem): number {
  const recipe = service.inventoryAmounts?.[item.id];
  if (recipe && recipe.qty > 0) return convertUnits(recipe.qty, recipe.unit, item.unit) ?? 0;
  const perUnit = Number(service.inventoryServicesPerUnit?.[item.id]) || Number(item.servicesPerUnit) || 0;
  return perUnit > 0 ? 1 / perUnit : 0;
}

export interface ConsumptionEntry {
  at: number;
  date: string;
  serviceName: string;
  who: string;
  /** In the item's own unit. */
  qty: number;
}

/**
 * Every performance that used `item`, newest first, with the amount it took —
 * the item's consumption history. Derived from the same sales and completed
 * appointments the stock deduction is, so the two always agree.
 */
export function consumptionHistory(
  invoices: SalonInvoice[],
  appointments: Appointment[],
  services: Service[],
  item: InventoryItem,
): ConsumptionEntry[] {
  const out: ConsumptionEntry[] = [];
  for (const { service, count, date, at, who } of collectPerformances(invoices, appointments, services, {})) {
    if (!usedItemIds(service).includes(item.id)) continue;
    const qty = amountPerPerformance(service, item) * count;
    if (qty > 0) out.push({ at, date, serviceName: service.name, who, qty });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Units of stock used up per item strictly after its `since` time: each
 * performance of a service that uses the item takes amountPerPerformance().
 */
export function unitsConsumedSince(
  invoices: SalonInvoice[],
  appointments: Appointment[],
  services: Service[],
  sinceMsByItem: Map<string, number>,
  itemsById: Map<string, InventoryItem>,
  nowMs: number = Date.now(),
): Map<string, number> {
  const earliest = Math.min(...sinceMsByItem.values());
  if (!Number.isFinite(earliest)) return new Map();
  // Day-level pre-filter (cheap), then exact times per item.
  const from = new Date(earliest - 86_400_000).toISOString().slice(0, 10);
  const out = new Map<string, number>();
  for (const { service, count, at } of collectPerformances(invoices, appointments, services, { from })) {
    for (const itemId of usedItemIds(service)) {
      const since = sinceMsByItem.get(itemId);
      // Nothing timed in the future (a booking completed ahead of its slot with
      // no completion time): it counts once its time has passed, never twice.
      if (since === undefined || at <= since || at > nowMs) continue;
      const item = itemsById.get(itemId);
      const amount = item ? amountPerPerformance(service, item) : 0;
      if (amount <= 0) continue;
      out.set(itemId, (out.get(itemId) ?? 0) + count * amount);
    }
  }
  return out;
}

/** Items some service consumes by a recipe amount or a per-service "lasts N services" figure. */
export function itemsWithServiceRates(services: Service[]): Set<string> {
  const ids = new Set<string>();
  for (const s of services) {
    for (const [itemId, n] of Object.entries(s.inventoryServicesPerUnit ?? {})) {
      if (Number(n) > 0 && usedItemIds(s).includes(itemId)) ids.add(itemId);
    }
    for (const [itemId, r] of Object.entries(s.inventoryAmounts ?? {})) {
      if (Number(r?.qty) > 0 && usedItemIds(s).includes(itemId)) ids.add(itemId);
    }
  }
  return ids;
}
