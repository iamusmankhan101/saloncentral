import { saveLoyaltyHistoryToDB, syncWalletPass } from "./turso-sync";
import type { Client, LoyaltyTransaction } from "./types";
import { locationUserKey } from "./locations";

const HISTORY_KEY = "werzio_loyalty_history";

export type LoyaltyTier = "none" | "bronze" | "silver" | "gold" | "platinum";

export interface LoyaltySettings {
  enabled: boolean;
  pointsPerRupee: number;
  rupeePerPoint: number;
  silverMin: number;
  goldMin: number;
  platinumMin: number;
  /** Services a client can take free for a set number of points, besides the cash discount. */
  rewards?: LoyaltyReward[];
}

export interface LoyaltyReward {
  id: string;
  serviceId: string;
  /** Points it costs. */
  points: number;
}

export const TIER_META: Record<LoyaltyTier, { label: string; color: string; bg: string; emoji: string }> = {
  platinum: { label: "Platinum", color: "#6b21a8", bg: "#f3e8ff", emoji: "💎" },
  gold:     { label: "Gold",     color: "#92400e", bg: "#fef3c7", emoji: "🥇" },
  silver:   { label: "Silver",   color: "#374151", bg: "#f1f5f9", emoji: "🥈" },
  bronze:   { label: "Bronze",   color: "#78350f", bg: "#fef9c3", emoji: "🥉" },
  none:     { label: "Member",   color: "#7c3aed", bg: "#ede9fe", emoji: "⭐" },
};

export function getTier(lifetimeEarned: number, s: LoyaltySettings): LoyaltyTier {
  if (lifetimeEarned >= s.platinumMin) return "platinum";
  if (lifetimeEarned >= s.goldMin)     return "gold";
  if (lifetimeEarned >= s.silverMin)   return "silver";
  if (lifetimeEarned > 0)              return "bronze";
  return "none";
}

export function nextTierThreshold(lifetimeEarned: number, s: LoyaltySettings): { tier: LoyaltyTier; needed: number } | null {
  if (lifetimeEarned < s.silverMin)   return { tier: "silver",   needed: s.silverMin   - lifetimeEarned };
  if (lifetimeEarned < s.goldMin)     return { tier: "gold",     needed: s.goldMin     - lifetimeEarned };
  if (lifetimeEarned < s.platinumMin) return { tier: "platinum", needed: s.platinumMin - lifetimeEarned };
  return null;
}

export function calcPointsToEarn(amount: number, ppr: number): number {
  return Math.floor(amount * ppr);
}

export function pointsToRupees(points: number, rpp: number): number {
  return points * rpp;
}

// ── Transaction History ────────────────────────────────────────────────────────

export function getLoyaltyHistory(): LoyaltyTransaction[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(locationUserKey(HISTORY_KEY)) || "[]");
  } catch { return []; }
}

export function getClientHistory(clientId: string): LoyaltyTransaction[] {
  return getLoyaltyHistory().filter((t) => t.clientId === clientId);
}

function appendHistory(tx: Omit<LoyaltyTransaction, "id" | "date">, updatedClient?: unknown) {
  const history = getLoyaltyHistory();
  const entry: LoyaltyTransaction = {
    ...tx,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    date: new Date().toISOString(),
  };
  history.unshift(entry);
  if (history.length > 2000) history.length = 2000;
  localStorage.setItem(locationUserKey(HISTORY_KEY), JSON.stringify(history));
  saveLoyaltyHistoryToDB(history);
  // Pass the fresh client so the PATCH handler uses current data directly
  // instead of re-fetching from Turso (which may not have settled yet).
  syncWalletPass(tx.clientId, updatedClient);
  return entry;
}

// ── Mutations (return updated client) ──────────────────────────────────────────

export function awardPoints(
  client: Client,
  amount: number,
  settings: LoyaltySettings,
  appointmentId?: string,
): Client {
  if (!settings.enabled) { console.log("[awardPoints] skipped: loyalty disabled"); return client; }
  const pts = calcPointsToEarn(amount, settings.pointsPerRupee);
  console.log("[awardPoints] amount:", amount, "ppr:", settings.pointsPerRupee, "pts:", pts);
  if (pts <= 0) { console.log("[awardPoints] skipped: pts=0 (amount too small)"); return client; }
  const updated = {
    ...client,
    loyaltyPoints:       (client.loyaltyPoints       ?? 0) + pts,
    loyaltyPointsEarned: (client.loyaltyPointsEarned ?? 0) + pts,
  };
  appendHistory({ clientId: client.id, type: "earn", points: pts, note: `Earned for Rs. ${amount} appointment`, appointmentId }, updated);
  return updated;
}

/** Recompute a single client's earned points from their completed appointments.
 *  Preserves any manual redemptions. Returns the client unchanged if already correct. */
export function recomputeClientPoints(
  client: Client,
  completedSpend: number,
  settings: LoyaltySettings,
): Client {
  const correctEarned = Math.floor(completedSpend * settings.pointsPerRupee);
  if (client.loyaltyPointsEarned === correctEarned) return client;
  const redeemed  = Math.max(0, (client.loyaltyPointsEarned ?? 0) - (client.loyaltyPoints ?? 0));
  const newBalance = Math.max(0, correctEarned - redeemed);
  return { ...client, loyaltyPointsEarned: correctEarned, loyaltyPoints: newBalance };
}

export function redeemPoints(
  client: Client,
  points: number,
  note: string,
): Client {
  const balance = client.loyaltyPoints ?? 0;
  const actual  = Math.min(points, balance);
  if (actual <= 0) return client;
  const updated = { ...client, loyaltyPoints: balance - actual };
  appendHistory({ clientId: client.id, type: "redeem", points: -actual, note }, updated);
  return updated;
}

export function adjustPoints(
  client: Client,
  points: number,
  note: string,
): Client {
  const newBal    = Math.max(0, (client.loyaltyPoints ?? 0) + points);
  const newEarned = points > 0
    ? (client.loyaltyPointsEarned ?? 0) + points
    : (client.loyaltyPointsEarned ?? 0);
  const updated = { ...client, loyaltyPoints: newBal, loyaltyPointsEarned: newEarned };
  appendHistory({ clientId: client.id, type: "adjust", points, note }, updated);
  return updated;
}
