/**
 * lib/plans.ts
 *
 * The subscription tiers an account can be on, and what each one unlocks.
 * Deliberately isomorphic — no `window`, no DB, no imports beyond types — so
 * the same table gates the UI in the browser and the writes on the server.
 *
 * Two entitlements are sold: loyalty and branches. Basic is the whole
 * single-location counter without the loyalty programme; Pro adds loyalty and
 * multi-branch. Everything branch-shaped (lib/locations.ts, the Branches
 * settings section, the dashboard branch switcher, /api/db, /api/settings) asks
 * `supportsMultiBranch()`, and everything loyalty-shaped asks
 * `supportsLoyalty()` (via `loyaltyActive()` in lib/loyalty.ts), rather than
 * testing for "pro" by name, so adding a tier later is a change to this file.
 *
 * Basic keeps the id "starter" — that is what users.plan already holds for
 * every existing account — and only its display name changed.
 *
 * A plan lives on the account row (users.plan) and is set by a platform admin
 * from the /admin console — this build has no self-serve billing, so there is
 * nothing else that could move an account between tiers.
 */

export type PlanId = "starter" | "pro";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Monthly price in PKR, as sold on the marketing site. */
  pricePkr: number;
  blurb: string;
  /** Loyalty points, tiers and redemption at the till. */
  loyalty: boolean;
  /**
   * Hard ceiling on branches. Pro is capped rather than unlimited because the
   * branch list rides inside the business settings blob, which syncs as one
   * JSON row — this is a sanity limit, not a commercial one.
   */
  maxBranches: number;
  highlights: string[];
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  starter: {
    id: "starter",
    name: "Basic",
    pricePkr: 3499,
    blurb: "The whole counter for one shop — POS, stock, clients, invoices and reporting for a single location.",
    loyalty: false,
    maxBranches: 1,
    highlights: [
      "One branch",
      "POS, products, clients and invoices",
      "Revenue and cash flow reporting",
      "Staff logins with per-module access",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    pricePkr: 5999,
    blurb: "Basic, plus a loyalty programme that runs itself at the till and every branch you run on one account.",
    loyalty: true,
    maxBranches: 20,
    highlights: [
      "Loyalty points, tiers and redemption at the till",
      "Up to 20 branches",
      "Separate stock, staff, clients and takings per branch",
      "Switch branches without signing out",
      "Pin each staff login to the branch they work at",
    ],
  },
};

export const DEFAULT_PLAN_ID: PlanId = "starter";
export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

/** Anything unrecognised (null, a legacy value, a hand-edited row) is Basic. */
export function normalizePlanId(value: unknown): PlanId {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (PLAN_IDS as string[]).includes(id) ? (id as PlanId) : DEFAULT_PLAN_ID;
}

export function planById(value: unknown): PlanDefinition {
  return PLANS[normalizePlanId(value)];
}

/** The plan carried by a user record (client AuthUser or server User alike). */
export function planFor(user: { plan?: unknown } | null | undefined): PlanDefinition {
  return planById(user?.plan);
}

export function maxBranchesFor(value: unknown): number {
  return planById(value).maxBranches;
}

/** True when the plan may run more than one branch — the multi-branch gate. */
export function supportsMultiBranch(value: unknown): boolean {
  return maxBranchesFor(value) > 1;
}

/** True when the plan includes the loyalty programme. */
export function supportsLoyalty(value: unknown): boolean {
  return planById(value).loyalty;
}

/** "PKR 5,999/month" — the price line shown wherever a plan is named. */
export function planPriceLabel(plan: PlanDefinition): string {
  return `PKR ${plan.pricePkr.toLocaleString("en-US")}/month`;
}

/** The tier a business has to be on before branches become available. */
export const MULTI_BRANCH_PLAN = PLANS.pro;

/** The tier a business has to be on before loyalty becomes available. */
export const LOYALTY_PLAN = PLANS.pro;
