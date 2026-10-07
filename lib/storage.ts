import { APPOINTMENTS as mockAppointments, CLIENTS as mockClients, STAFF as mockStaff, SERVICES as mockServices, INVENTORY as mockInventory } from "./mock-data";
import type { Appointment, Client, Staff, Service, InventoryItem } from "./types";
import { persistEntity, DATA_SYNCED_EVENT } from "./turso-sync";
import { userKey } from "./auth";
import { getActiveLocationFilter, locationUserKey } from "./locations";
import { logStockChanges, type StockChange } from "./inventory-log";

const SCHEMA_VERSION = "v6";

// All keys are scoped per user so different salon accounts never share data
const K = {
  appointments:  "werzio_appointments",
  clients:       "werzio_clients",
  staff:         "werzio_staff",
  services:      "werzio_services",
  inventory:     "werzio_inventory",
  schemaVersion: "werzio_schema_version",
};

function checkSchema() {
  if (typeof window === "undefined") return;
  const vk = locationUserKey(K.schemaVersion);
  const ver = localStorage.getItem(vk);
  if (ver !== SCHEMA_VERSION) {
    // Only the legacy Main Branch needs the old schema reset behavior.
    // New branches start with clean, empty stores.
    if (getActiveLocationFilter() === "main") {
      localStorage.removeItem(userKey(K.appointments));
      localStorage.removeItem(userKey(K.clients));
      localStorage.removeItem(userKey(K.staff));
      localStorage.removeItem(userKey(K.services));
      localStorage.removeItem(userKey(K.inventory));
    }
    localStorage.setItem(vk, SCHEMA_VERSION);
  }
}

function initialData<T>(mock: T[]): T[] {
  return getActiveLocationFilter() === "main" ? mock : [];
}

function normalizeClientPhone(raw?: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("3")) return `92${digits}`;
  return digits;
}

function normalizeClients(clients: Client[]): Client[] {
  return clients.map((client) => ({ ...client, phone: normalizeClientPhone(client.phone) }));
}

export function getStoredAppointments(): Appointment[] {
  if (typeof window === "undefined") return mockAppointments;
  checkSchema();
  const key = locationUserKey(K.appointments);
  const saved = localStorage.getItem(key);
  if (!saved) {
    const initial = initialData(mockAppointments);
    localStorage.setItem(key, JSON.stringify(initial));
    return initial;
  }
  return JSON.parse(saved);
}

export function saveAppointments(appts: Appointment[]) {
  if (typeof window !== "undefined") {
    checkSchema();
    persistEntity("appointments", appts);
  }
}

export function getStoredClients(): Client[] {
  if (typeof window === "undefined") return mockClients;
  checkSchema();
  const key = locationUserKey(K.clients);
  const saved = localStorage.getItem(key);
  if (!saved) {
    const initial = normalizeClients(initialData(mockClients));
    localStorage.setItem(key, JSON.stringify(initial));
    return initial;
  }
  const parsed = JSON.parse(saved) as Client[];
  const normalized = normalizeClients(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
    localStorage.setItem(key, JSON.stringify(normalized));
  }
  return normalized;
}

/**
 * @param deletedIds ids this save is deliberately deleting. Anything else that
 *   is missing from `clients` is treated as a stale snapshot and put back, not
 *   deleted — see PersistOptions.inferDeletes in lib/turso-sync.ts.
 */
export function saveClients(clients: Client[], deletedIds: string[] = []) {
  if (typeof window !== "undefined") {
    checkSchema();
    persistEntity("clients", normalizeClients(clients), { deletedIds, inferDeletes: false });
  }
}

export function getStoredStaff(): Staff[] {
  if (typeof window === "undefined") return mockStaff;
  checkSchema();
  const key = locationUserKey(K.staff);
  const saved = localStorage.getItem(key);
  if (!saved) {
    const initial = initialData(mockStaff);
    localStorage.setItem(key, JSON.stringify(initial));
    return initial;
  }
  return JSON.parse(saved);
}

/** @param deletedIds see saveClients — absence alone never deletes a staff member. */
export function saveStaff(staffList: Staff[], deletedIds: string[] = []) {
  if (typeof window !== "undefined") {
    checkSchema();
    persistEntity("staff", staffList, { deletedIds, inferDeletes: false });
  }
}

export function getStoredServices(): Service[] {
  if (typeof window === "undefined") return mockServices;
  checkSchema();
  const key = locationUserKey(K.services);
  const saved = localStorage.getItem(key);
  if (!saved) {
    const initial = initialData(mockServices);
    localStorage.setItem(key, JSON.stringify(initial));
    return initial;
  }
  return JSON.parse(saved);
}

/** @param deletedIds see saveClients — absence alone never deletes a service. */
export function saveServices(servicesList: Service[], deletedIds: string[] = []) {
  if (typeof window !== "undefined") {
    checkSchema();
    persistEntity("services", servicesList, { deletedIds, inferDeletes: false });
  }
}

export function getStoredInventory(): InventoryItem[] {
  if (typeof window === "undefined") return mockInventory;
  checkSchema();
  const key = locationUserKey(K.inventory);
  const saved = localStorage.getItem(key);
  if (!saved) {
    const initial = initialData(mockInventory);
    localStorage.setItem(key, JSON.stringify(initial));
    return initial;
  }
  return JSON.parse(saved);
}

/** @param change why stock moved, for the stock history; omit for service consumption, which is derived instead. */
export function saveInventory(items: InventoryItem[], change?: StockChange) {
  if (typeof window !== "undefined") {
    checkSchema();
    if (change) logStockChanges(getStoredInventory(), items, change);
    persistEntity("inventory", items);
  }
}

/**
 * Calls `onChange` whenever this browser's stored salon data may have changed
 * behind a page's back: a DB sync finished, another tab wrote to localStorage,
 * or the user came back to a tab that has been idle. Returns an unsubscribe.
 *
 * Listing pages read localStorage once on mount and then keep the list in React
 * state, so without this a tab open since the morning shows — and saves from —
 * a snapshot that predates everything added on any other device since.
 */
export function subscribeToStoredData(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent) => {
    // Only the entity arrays matter; ignore the sync bookkeeping keys.
    if (event.key && !event.key.startsWith("werzio_")) return;
    if (event.key && event.key.includes("werzio_sync_arrived_")) return;
    onChange();
  };

  window.addEventListener(DATA_SYNCED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onChange);
  return () => {
    window.removeEventListener(DATA_SYNCED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onChange);
  };
}
