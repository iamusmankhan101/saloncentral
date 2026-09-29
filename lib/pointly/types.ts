/**
 * lib/pointly/types.ts
 *
 * The shapes Pointly's /api/admin/* routes return, for the Pointly tab of the
 * admin console (components/pointly-admin). Copied from Pointly's
 * lib/auth-db.ts, lib/admin-db.ts and lib/billing-db.ts — keep them in step
 * when those change. Types only: Pointly's data is never read from here, only
 * through app/api/admin/pointly.
 */

import type { PlanId } from "./plans";
import type { BusinessTypeId } from "./business-types";
import type { BillingStatus, SubscriptionPayment } from "./billing";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface AuthUser {
  id: string;
  email: string;
  ownerName: string;
  businessName: string;
  phone: string;
  role: "owner" | "manager" | "staff" | "admin";
  businessOwnerId?: string;
  staffId?: string;
  locationId?: string;
  permissions?: string[];
  emailVerified: boolean;
  approvalStatus: ApprovalStatus;
  accountFrozen: boolean;
  freezeReason: string | null;
  plan: PlanId;
  businessType: BusinessTypeId;
  customPricePkr: number | null;
  billingCycleMonths: number | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetId: string | null;
  targetEmail: string | null;
  detail: string | null;
}

export interface PlatformUser extends AuthUser {
  teamSize: number;
  ownerBusinessName?: string;
  activeSessions: number;
  storageBytes: number;
  branches: string[];
  lastActivity: string | null;
}

export interface PlatformStats {
  total: number;
  owners: number;
  managers: number;
  staff: number;
  admins: number;
  pending: number;
  rejected: number;
  frozen: number;
  newThisWeek: number;
  activeSessions: number;
  storageBytes: number;
}

export interface OwnSubscription {
  plan: PlanId;
  listPricePkr: number;
  monthlyPricePkr: number;
  customPrice: boolean;
  billingCycleMonths: number;
  paidUntil: string | null;
  status: BillingStatus;
  daysLeft: number | null;
  payments: Pick<SubscriptionPayment, "id" | "paidAt" | "amountPkr" | "months" | "days" | "method" | "periodStart" | "periodEnd" | "plan">[];
}
