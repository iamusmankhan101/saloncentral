/**
 * lib/business-types.ts
 *
 * The kind of business an account runs, picked once at sign-up, and how the
 * app adapts to it. Deliberately isomorphic, like lib/plans.ts — no `window`,
 * no DB — so the server can validate it and the browser can read it off the
 * cached AuthUser.
 *
 * A business type only tailors the existing app: what screens are called
 * (a café's "Products" is its "Menu"), which product categories and staff
 * roles are offered first, and which industry-specific panels show. It never
 * hides data — a record in a category the type doesn't feature still shows
 * and still edits.
 *
 * "general" is not offered at sign-up. It is what every account created before
 * this existed reads as, and it keeps the app exactly as it was for them.
 *
 * The type lives on the owner's row (users.business_type). Staff and manager
 * logins inherit it, see getEffectiveBusinessType() in lib/auth-db.ts.
 */

/** Mirrors InventoryCategory in Pointly's lib/types.ts. */
type InventoryCategory =
  | "general" | "food" | "drinks" | "apparel" | "electronics" | "supplies" | "tools" | "other";

export type BusinessTypeId = "general" | "restaurant" | "cafe" | "retail" | "salon";

export interface BusinessTypeDefinition {
  id: BusinessTypeId;
  name: string;
  /** The name on the sign-up picker's cards, where "Café / Coffee shop" won't fit. */
  shortName: string;
  /** What picking this type means, shown under the sign-up picker once it's chosen. */
  blurb: string;
  /** Example business name for the sign-up form. */
  exampleName: string;
  /** Sidebar and page title for /dashboard/products. */
  productsLabel: string;
  /** Singular of productsLabel, for buttons like "Add Menu Item". */
  productLabel: string;
  /** Sidebar and page title for /dashboard/clients. */
  clientsLabel: string;
  /** Singular of clientsLabel. */
  clientLabel: string;
  /** Product categories offered in pickers and filters, in this order. */
  categories: InventoryCategory[];
  /** Staff job titles the role picker offers before any custom ones. */
  roleSeed: string[];
  /** The skin/hair "Beauty Profile" on a client — salon-only. */
  beautyProfile: boolean;
  /**
   * Tables, open orders and the kitchen display (lib/restaurant.ts): the
   * Tables and Kitchen screens, and order types / send-to-kitchen on the POS.
   */
  restaurantMode: boolean;
  /**
   * Appointments and a service menu — a salon's bread and butter. Off, the
   * screens stop talking about appointments, services and specialties.
   */
  bookings: boolean;
  /** Men's / Women's style sections on staff, customers and products. */
  sections: boolean;
  /** What one sale is called in counts — "Appointments", "Orders", "Sales". */
  salesCountLabel: string;
  /** Example text for a customer's notes. */
  clientNotesHint: string;
  /** The last line of a printed receipt. Only a shop takes things back. */
  receiptFooter: string;
}

const ALL_CATEGORIES: InventoryCategory[] = [
  "general", "food", "drinks", "apparel", "electronics", "supplies", "tools", "other",
];

const SALON_ROLES = [
  "owner", "manager", "senior-stylist", "junior-stylist", "receptionist", "trainee", "hair", "aesthetic",
];

const RECEIPT_FOOTER = "We hope to see you again soon.";

export const BUSINESS_TYPES: Record<BusinessTypeId, BusinessTypeDefinition> = {
  general: {
    id: "general",
    name: "General",
    shortName: "General",
    blurb: "Every module, with the standard labels.",
    exampleName: "Raza Traders",
    productsLabel: "Products",
    productLabel: "Product",
    clientsLabel: "Clients",
    clientLabel: "Client",
    categories: ALL_CATEGORIES,
    roleSeed: SALON_ROLES,
    beautyProfile: true,
    restaurantMode: false,
    bookings: true,
    sections: true,
    salesCountLabel: "Appointments",
    clientNotesHint: "e.g. Sensitive scalp, prefers morning appointments…",
    receiptFooter: "Please keep this receipt for exchanges.",
  },
  restaurant: {
    id: "restaurant",
    name: "Restaurant",
    shortName: "Restaurant",
    blurb: "Dine-in, takeaway and delivery — with tables and a kitchen display.",
    exampleName: "Karahi House",
    productsLabel: "Menu",
    productLabel: "Menu Item",
    clientsLabel: "Customers",
    clientLabel: "Customer",
    categories: ["food", "drinks", "supplies", "general", "other"],
    roleSeed: ["owner", "manager", "chef", "cook", "waiter", "cashier", "kitchen-helper"],
    beautyProfile: false,
    restaurantMode: true,
    bookings: false,
    sections: false,
    salesCountLabel: "Orders",
    clientNotesHint: "e.g. Allergic to nuts, prefers the window table…",
    receiptFooter: RECEIPT_FOOTER,
  },
  cafe: {
    id: "cafe",
    name: "Café / Coffee shop",
    shortName: "Café",
    blurb: "Coffee, bakery and light food — with quick orders and a kitchen display.",
    exampleName: "Chai Corner",
    productsLabel: "Menu",
    productLabel: "Menu Item",
    clientsLabel: "Customers",
    clientLabel: "Customer",
    categories: ["drinks", "food", "supplies", "general", "other"],
    roleSeed: ["owner", "manager", "barista", "baker", "cashier", "server"],
    beautyProfile: false,
    restaurantMode: true,
    bookings: false,
    sections: false,
    salesCountLabel: "Orders",
    clientNotesHint: "e.g. Oat milk flat white, extra hot…",
    receiptFooter: RECEIPT_FOOTER,
  },
  retail: {
    id: "retail",
    name: "Retail / Mart",
    shortName: "Retail",
    blurb: "Shops, marts and groceries — with barcode scanning and stock alerts.",
    exampleName: "Raza Mart",
    productsLabel: "Products",
    productLabel: "Product",
    clientsLabel: "Customers",
    clientLabel: "Customer",
    categories: ALL_CATEGORIES,
    roleSeed: ["owner", "manager", "cashier", "sales-associate", "stock-keeper"],
    beautyProfile: false,
    restaurantMode: false,
    bookings: false,
    sections: false,
    salesCountLabel: "Sales",
    clientNotesHint: "e.g. Buys in bulk, prefers delivery on Fridays…",
    receiptFooter: "Please keep this receipt for exchanges.",
  },
  salon: {
    id: "salon",
    name: "Salon / Clinic",
    shortName: "Salon",
    blurb: "Salons, spas and clinics — with client profiles and staff commissions.",
    exampleName: "Glow Studio",
    productsLabel: "Products",
    productLabel: "Product",
    clientsLabel: "Clients",
    clientLabel: "Client",
    categories: ALL_CATEGORIES,
    roleSeed: SALON_ROLES,
    beautyProfile: true,
    restaurantMode: false,
    bookings: true,
    sections: true,
    salesCountLabel: "Appointments",
    clientNotesHint: "e.g. Sensitive scalp, prefers morning appointments…",
    receiptFooter: "Please keep this receipt for exchanges.",
  },
};

export const DEFAULT_BUSINESS_TYPE_ID: BusinessTypeId = "restaurant";
export const BUSINESS_TYPE_IDS = Object.keys(BUSINESS_TYPES) as BusinessTypeId[];

/** The choices on the sign-up form — everything except the legacy "general". */
export const SIGNUP_BUSINESS_TYPE_IDS: BusinessTypeId[] = ["restaurant", "cafe", "retail", "salon"];

/** Anything unrecognised (null, a legacy row, a hand-edited value) is General. */
export function normalizeBusinessTypeId(value: unknown): BusinessTypeId {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (BUSINESS_TYPE_IDS as string[]).includes(id) ? (id as BusinessTypeId) : DEFAULT_BUSINESS_TYPE_ID;
}

export function businessTypeById(value: unknown): BusinessTypeDefinition {
  return BUSINESS_TYPES[normalizeBusinessTypeId(value)];
}

/** The type carried by a user record (client AuthUser or server User alike). */
export function businessTypeFor(user: { businessType?: unknown } | null | undefined): BusinessTypeDefinition {
  return businessTypeById(user?.businessType);
}
