import { locationUserKey } from "./locations";
import { persistEntity } from "./turso-sync";

/**
 * A POS sale put on hold before checkout — the cart and everything rung up
 * with it — so the till can serve someone else and come back to it later,
 * from this or any other device. It stays held until it's completed or
 * discarded; nothing about it counts as a sale until then.
 *
 * `cart` is the POS page's own cart line shape, kept opaque here so the page
 * stays the one place that defines it.
 */
export interface HeldSale<CartLine = unknown> {
  id: string;
  heldAt: string;           // ISO — first put on hold
  clientId?: string;
  clientName: string;       // "Walk-in Customer" when no client was picked
  staffId?: string;
  cart: CartLine[];
  itemCount: number;
  total: number;            // PKR, as shown when held — for the list only
  discount: number;
  discType: "flat" | "pct";
  discount2: number;
  discType2: "flat" | "pct";
  loyaltyRedeem: number;
  notes: string;
  guests: { name: string; clientId?: string; phone?: string }[];
  isAdvance: boolean;
  advanceValue: number;
  advanceType: "flat" | "pct";
  checkoutAppointmentId?: string;
  checkoutGroupIds?: string[];
  apptBanner?: string;
}

const KEY = "werzio_held_sales";

export function getHeldSales<CartLine = unknown>(): HeldSale<CartLine>[] {
  if (typeof window === "undefined") return [];
  try {
    const list = JSON.parse(localStorage.getItem(locationUserKey(KEY)) ?? "[]") as HeldSale<CartLine>[];
    return Array.isArray(list) ? list.sort((a, b) => (a.heldAt < b.heldAt ? 1 : -1)) : [];
  } catch {
    return [];
  }
}

/** Adds a held sale, or replaces it when one with the same id is already held (holding a resumed sale again). */
export function saveHeldSale(sale: HeldSale): Promise<boolean> {
  const others = getHeldSales().filter((s) => s.id !== sale.id);
  return persistEntity("held_sales", [sale, ...others], { inferDeletes: false });
}

/** Removes a held sale once it's been completed or discarded — on every device. */
export function removeHeldSale(id: string): Promise<boolean> {
  return persistEntity("held_sales", getHeldSales().filter((s) => s.id !== id), { deletedIds: [id], inferDeletes: false });
}
