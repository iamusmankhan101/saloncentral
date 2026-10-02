import { locationUserKey } from "./locations";
import { persistEntity } from "./turso-sync";
import { getStoredInventory, saveInventory } from "./storage";

export type ExpenseCategory =
  | "rent"
  | "water_bill"
  | "electricity_bill"
  | "committee"
  | "salaries"
  | "utilities"
  | "supplies"
  | "equipment"
  | "marketing"
  | "food"
  | "miscellaneous";

/** One product bought in an expense, e.g. Shampoo × 5 @ PKR 800. */
export interface ExpenseItem {
  name: string;
  qty: number;
  unitPrice: number;
  /** Set when the product was picked from Inventory — its stock goes up by `qty`. */
  inventoryItemId?: string;
}

export interface Expense {
  id: string;
  date: string;        // YYYY-MM-DD
  category: ExpenseCategory;
  description: string;
  amount: number;
  paymentMethod: string;
  paymentStatus?: "paid" | "pending";
  billImageDataUrl?: string;
  billImageName?: string;
  notes?: string;
  /** Products bought, name-wise. When present, `amount` is their total. */
  items?: ExpenseItem[];
  createdAt: string;   // ISO timestamp
  /** Which salon section this expense belongs to (e.g. "Men's", "Women's"). Untagged = shared overhead, excluded from a section-restricted view. */
  section?: string;
}

const KEY = "werzio_expenses";

export function getExpenses(): Expense[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(locationUserKey(KEY)) ?? "[]"); } catch { return []; }
}

/**
 * Saves locally (always) and returns the Turso write's outcome so a caller
 * that needs to know whether the save actually reached the shared database
 * can await it and warn the user instead of silently leaving the expense
 * invisible on every device but the one it was added on (the previous
 * fire-and-forget save could fail with nothing but a console warning).
 */
export function saveExpenses(list: Expense[]): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return persistEntity("expenses", list);
}

export async function addExpense(data: Omit<Expense, "id" | "createdAt">): Promise<{ expense: Expense; dbSaved: boolean }> {
  const entry: Expense = { ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const list = getExpenses();
  list.push(entry);
  const dbSaved = await saveExpenses(list);
  return { expense: entry, dbSaved };
}

export function deleteExpense(id: string): void {
  saveExpenses(getExpenses().filter(e => e.id !== id));
}

export async function updateExpense(id: string, patch: Partial<Omit<Expense, "id" | "createdAt">>): Promise<boolean> {
  return saveExpenses(getExpenses().map(e => e.id === id ? { ...e, ...patch } : e));
}

export function expenseItemsTotal(items: ExpenseItem[] | undefined): number {
  return (items ?? []).reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
}

/**
 * Brings Inventory stock in line with an expense's products changing from
 * `before` to `after` (an add passes before = [], a delete passes after = []).
 * Only the difference is applied, so editing an expense never double-counts.
 * Stock never goes below zero; a stock increase stamps today as last restocked.
 */
export function applyExpenseStock(before: ExpenseItem[] | undefined, after: ExpenseItem[] | undefined): void {
  const delta = new Map<string, number>();
  for (const item of before ?? []) if (item.inventoryItemId) delta.set(item.inventoryItemId, (delta.get(item.inventoryItemId) ?? 0) - item.qty);
  for (const item of after ?? []) if (item.inventoryItemId) delta.set(item.inventoryItemId, (delta.get(item.inventoryItemId) ?? 0) + item.qty);
  if (![...delta.values()].some((d) => d !== 0)) return;

  const today = new Date().toLocaleDateString("en-CA");
  const inventory = getStoredInventory();
  saveInventory(inventory.map((inv) => {
    const d = delta.get(inv.id) ?? 0;
    if (d === 0) return inv;
    return { ...inv, currentStock: Math.max(0, inv.currentStock + d), ...(d > 0 ? { lastRestocked: today } : {}) };
  }));
}
