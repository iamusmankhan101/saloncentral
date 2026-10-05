export interface ManualCashIncome {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  createdAt: string;
}

const KEY = "werzio_cash_flow_income";

/** Cash put into the drawer (e.g. a float for small expenses) — money in hand, not money earned, so Revenue leaves it out. */
export const PETTY_CASH_CATEGORY = "Petty Cash";

export function getManualCashIncome(): ManualCashIncome[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(locationUserKey(KEY)) ?? "[]") as ManualCashIncome[];
  } catch {
    return [];
  }
}

/**
 * Saves locally (always) and returns the Turso write's outcome so a caller
 * can await it and warn the user instead of these entries staying invisible
 * on every device but the one they were imported/entered on.
 */
export function saveManualCashIncome(entries: ManualCashIncome[]): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return persistEntity("cash_flow_income", entries);
}
import { locationUserKey } from "./locations";
import { persistEntity } from "./turso-sync";
