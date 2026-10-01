"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, XCircle, Clock, ImageIcon, ChevronDown, ChevronUp, Shield, Store, Pencil, Save, Ban, Trash2, AlertTriangle, X, ReceiptText, Users as UsersIcon, BadgeCheck, Landmark, Archive, Database, RotateCcw, Lock, LockOpen, Snowflake, LayoutDashboard, Banknote, LogOut, RefreshCw, FileText, ShoppingCart, Monitor, Smartphone, Tablet } from "lucide-react";
import { getCurrentUser, signOut } from "@/lib/auth";
import PointlyConsole from "@/components/pointly-admin/console";
import {
  getPaymentRequests,
  updatePaymentRequest,
  setActivePlan,
  type PaymentRequest,
  type PaymentStatus,
} from "@/lib/payment-requests";
import type { Invoice } from "@/lib/invoices";

import { fmtCurrency as fmt } from "@/lib/format";
import { PLAN_CONFIGS, ORDERED_PLANS, type PlanId } from "@/lib/plan-limits";
import { DEFAULT_BANK_DETAILS, DEFAULT_BILLED_FROM, type BilledFrom } from "@/lib/billing-constants";

interface BillingUserRow {
  id: string;
  email: string;
  ownerName: string;
  salonName: string;
  planId: string;
  planName: string;
  planPrice: number;
  billingTermMonths: number;
  suspended: boolean;
  suspensionReason: string | null;
  paymentMethodId: string | null;
}

interface PaymentMethodRow {
  id: string;
  label: string;
  bankName: string;
  bankTitle: string;
  accountNumber: string;
  iban: string;
  createdAt: string;
}

interface AccountUserRow {
  id: string;
  email: string;
  ownerName: string;
  salonName: string;
  phone: string;
  role: "owner" | "manager" | "staff" | "admin";
  salonOwnerId?: string;
  staffId?: string;
  emailVerified: boolean;
  approvalStatus: "pending" | "approved" | "rejected";
  accountFrozen: boolean;
  freezeReason: string | null;
  planName: string | null;
  planId: string | null;
  startedDate: string | null;
  invoiceDueDate: string | null;
  invoiceId: string | null;
  activeDevices: number;
  createdAt: string;
}

interface DeviceSessionRow {
  id: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  userAgent: string | null;
  ip: string | null;
  city: string | null;
  country: string | null;
  current: boolean;
}

const USERS_GRID_COLUMNS = "minmax(240px,1.4fr) minmax(160px,1fr) minmax(140px,0.9fr) 96px 116px 120px 110px 130px 200px 120px 200px";
const BILLING_TERMS = [1, 3, 6, 12] as const;
type BillingTermMonths = number;

function isPresetBillingTerm(months: number) {
  return BILLING_TERMS.includes(months as (typeof BILLING_TERMS)[number]);
}

const ROLE_META: Record<AccountUserRow["role"], { label: string; color: string; bg: string }> = {
  admin:   { label: "Admin",   color: "#7C3AED", bg: "#f5f3ff" },
  owner:   { label: "Owner",   color: "#0284c7", bg: "#e0f2fe" },
  manager: { label: "Manager", color: "#d97706", bg: "#fffbeb" },
  staff:   { label: "Staff",   color: "#6b6b8a", bg: "#f4f5f7" },
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
}

// Account signup dates are stored date-only ("YYYY-MM-DD"), not a full timestamp
// — appending T12:00:00 keeps the displayed day from shifting a day back in
// timezones behind UTC (midnight UTC parses as the previous day locally).
function fmtSignupDate(dateOnly: string) {
  return new Date(`${dateOnly}T12:00:00`).toLocaleDateString("en-PK", { dateStyle: "medium" });
}

function fmtOptionalDate(dateOnly: string | null) {
  return dateOnly ? fmtSignupDate(dateOnly) : "—";
}

const STATUS_META: Record<PaymentStatus, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  pending:  { label: "Pending",  color: "#d97706", bg: "#fffbeb", icon: Clock },
  approved: { label: "Approved", color: "#059669", bg: "#ecfdf5", icon: CheckCircle },
  rejected: { label: "Rejected", color: "#dc2626", bg: "#fef2f2", icon: XCircle },
};

function StatusBadge({ status }: { status: PaymentStatus }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, background: m.bg, border: `1px solid ${m.color}44`, fontSize: 11, fontWeight: 700, color: m.color }}>
      <Icon size={11} /> {m.label}
    </span>
  );
}

function RequestCard({ req, onUpdate }: { req: PaymentRequest; onUpdate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  function act(status: PaymentStatus) {
    setLoading(true);
    updatePaymentRequest(req.id, status, note || undefined);
    if (status === "approved") {
      setActivePlan(req.planId);
      
      // Update plan in database
      fetch("/api/billing/update-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: req.userId, planId: req.planId }),
      }).catch((e) => console.warn("[billing/update-plan] failed:", e));
      
      // Mark the current cycle's invoice paid + unsuspend in Turso + send "account restored" email (server-side)
      fetch("/api/billing/unsuspend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: req.userId }),
      }).catch((e) => console.warn("[billing/unsuspend] failed:", e));
    }
    setTimeout(() => { setLoading(false); onUpdate(); }, 400);
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: `1px solid ${req.status === "pending" ? "#fde68a" : "#ebebf0"}`, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
      {/* Card header */}
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }} onClick={() => setExpanded((p) => !p)}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: "#f0f0f8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 800, color: "#7C3AED", flexShrink: 0 }}>
          {req.userName.charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#1a1a2e" }}>{req.userName} <span style={{ fontWeight: 400, color: "#9898b0" }}>· {req.salonName}</span></div>
          <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 2 }}>{req.userEmail} · {fmtDate(req.submittedAt)}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#7C3AED" }}>{fmt(req.amount)}</div>
            <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1 }}>{req.planName} · {req.payMethod === "easypaisa" ? "EasyPaisa" : "Bank Transfer"}</div>
          </div>
          <StatusBadge status={req.status} />
          {expanded ? <ChevronUp size={16} color="#9898b0" /> : <ChevronDown size={16} color="#9898b0" />}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ borderTop: "1px solid #f0f0f8", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Screenshot */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Payment Screenshot</div>
            {req.screenshotBase64 ? (
              <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #e5e7eb" }}>
                <img src={req.screenshotBase64} alt="Payment proof" style={{ width: "100%", maxHeight: 320, objectFit: "contain", background: "#f9fafb", display: "block" }} />
                {req.screenshotName && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "#6b7280", background: "#f9fafb", borderTop: "1px solid #e5e7eb" }}>{req.screenshotName}</div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px", background: "#f9fafb", borderRadius: 10, border: "1px dashed #d1d5db" }}>
                <ImageIcon size={16} color="#9898b0" />
                <span style={{ fontSize: 12, color: "#9898b0" }}>No screenshot attached</span>
              </div>
            )}
          </div>

          {/* Review note */}
          {req.status === "pending" && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Note (optional)</div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the user..."
                style={{ width: "100%", padding: "10px 13px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", resize: "vertical", minHeight: 60, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
          )}

          {req.reviewNote && (
            <div style={{ padding: "10px 14px", borderRadius: 9, background: "#f4f5f7", fontSize: 12, color: "#6b6b8a" }}>
              <strong>Note:</strong> {req.reviewNote}
            </div>
          )}

          {req.reviewedAt && (
            <div style={{ fontSize: 11, color: "#9898b0" }}>Reviewed on {fmtDate(req.reviewedAt)}</div>
          )}

          {/* Actions */}
          {req.status === "pending" && (
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => act("rejected")} disabled={loading}
                style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #fecaca", background: "#fef2f2", fontSize: 13, fontWeight: 700, color: "#dc2626", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <XCircle size={14} /> Reject
              </button>
              <button onClick={() => act("approved")} disabled={loading}
                style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: loading ? "#e8e8f0" : "linear-gradient(135deg,#059669,#10b981)", fontSize: 13, fontWeight: 700, color: loading ? "#aaaabc" : "#fff", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <CheckCircle size={14} /> Approve & Activate Plan
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlanCell({ row, onSaved }: { row: BillingUserRow; onSaved: (userId: string, planId: string, planName: string, planPrice: number) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changePlan(planId: string) {
    if (planId === row.planId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/update-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, planId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to change plan");
      const plan = PLAN_CONFIGS[planId as PlanId];
      onSaved(row.id, planId, plan.name, plan.price);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change plan");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <select
        value={row.planId}
        disabled={saving}
        onChange={(e) => changePlan(e.target.value)}
        style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e4e4ee", fontSize: 12, outline: "none", color: "#1a1a2e", background: "#fff", cursor: saving ? "not-allowed" : "pointer" }}
      >
        {ORDERED_PLANS.map((id) => (
          <option key={id} value={id}>{PLAN_CONFIGS[id].name}</option>
        ))}
      </select>
      {error && <div style={{ fontSize: 11, color: "#dc2626" }}>{error}</div>}
    </div>
  );
}

function PriceCell({ row, onSaved }: { row: BillingUserRow; onSaved: (userId: string, price: number, termMonths: BillingTermMonths) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(row.planPrice));
  const [termMonths, setTermMonths] = useState<BillingTermMonths>(row.billingTermMonths ?? 1);
  const [termMode, setTermMode] = useState(isPresetBillingTerm(row.billingTermMonths ?? 1) ? String(row.billingTermMonths ?? 1) : "custom");
  const [discountPct, setDiscountPct] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const monthlyBasePrice = PLAN_CONFIGS[row.planId as PlanId]?.price ?? row.planPrice;
  const termBasePrice = monthlyBasePrice * termMonths;

  function applyDiscount() {
    const pct = Number(discountPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError("Enter a discount between 0-100%");
      return;
    }
    setError(null);
    setValue(String(Math.round(termBasePrice * (1 - pct / 100))));
  }

  async function save() {
    const price = Number(value);
    if (!Number.isFinite(price) || price < 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!Number.isFinite(termMonths) || termMonths < 1) {
      setError("Enter at least 1 billing month");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/set-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, price, termMonths }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      onSaved(row.id, price, termMonths);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{fmt(row.planPrice)}</div>
          <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1 }}>{row.billingTermMonths ?? 1} month{(row.billingTermMonths ?? 1) > 1 ? "s" : ""}</div>
        </div>
        <button onClick={() => { setValue(String(row.planPrice)); setTermMonths(row.billingTermMonths ?? 1); setTermMode(isPresetBillingTerm(row.billingTermMonths ?? 1) ? String(row.billingTermMonths ?? 1) : "custom"); setEditing(true); }}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 6, color: "#9898b0", display: "flex" }} title="Edit billing term and price">
          <Pencil size={13} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={termMode}
          onChange={(e) => {
            const nextMode = e.target.value;
            setTermMode(nextMode);
            if (nextMode !== "custom") {
              const next = Number(nextMode) as BillingTermMonths;
              setTermMonths(next);
              setValue(String(Math.round(monthlyBasePrice * next)));
            }
          }}
          disabled={saving}
          style={{ width: 104, padding: "6px 8px", borderRadius: 8, border: "1px solid #e4e4ee", fontSize: 12, outline: "none", background: "#fff" }}
        >
          {BILLING_TERMS.map((term) => <option key={term} value={term}>{term} month{term > 1 ? "s" : ""}</option>)}
          <option value="custom">Custom</option>
        </select>
        {termMode === "custom" && (
          <input
            type="number"
            min={1}
            value={termMonths}
            onChange={(e) => {
              const raw = Number(e.target.value);
              setTermMonths(Number.isFinite(raw) ? Math.floor(raw) : 0);
            }}
            disabled={saving}
            title="Custom billing months"
            style={{ width: 72, padding: "6px 8px", borderRadius: 8, border: "1px solid #e4e4ee", fontSize: 13, outline: "none" }}
          />
        )}
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={saving}
          style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #e4e4ee", fontSize: 13, outline: "none" }}
        />
        <button onClick={save} disabled={saving}
          style={{ background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 8, padding: "6px 8px", cursor: saving ? "not-allowed" : "pointer", color: "#059669", display: "flex" }} title="Save">
          <Save size={13} />
        </button>
        <button onClick={() => { setEditing(false); setError(null); }} disabled={saving}
          style={{ background: "#f4f5f7", border: "1px solid #e4e4ee", borderRadius: 8, padding: "6px 8px", cursor: "pointer", color: "#6b6b8a", display: "flex" }} title="Cancel">
          <Ban size={13} />
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="number"
          min={0}
          max={100}
          placeholder="Discount %"
          value={discountPct}
          onChange={(e) => setDiscountPct(e.target.value)}
          disabled={saving}
          title={`Base term price: ${fmt(termBasePrice)}`}
          style={{ width: 90, padding: "6px 8px", borderRadius: 8, border: "1px solid #e4e4ee", fontSize: 12, outline: "none" }}
        />
        <button onClick={applyDiscount} disabled={saving}
          style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: "6px 10px", cursor: saving ? "not-allowed" : "pointer", color: "#7C3AED", fontSize: 11, fontWeight: 700 }} title="Apply discount off base term price">
          Apply %
        </button>
      </div>
      {error && <div style={{ fontSize: 11, color: "#dc2626" }}>{error}</div>}
    </div>
  );
}

function DeleteAccountModal({ row, onClose, onDeleted }: { row: BillingUserRow; onClose: () => void; onDeleted: (userId: string) => void }) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = confirmText.trim() === row.salonName;

  async function handleDelete() {
    if (!matches) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, confirmSalonName: confirmText.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to delete account");
      onDeleted(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete account");
      setDeleting(false);
    }
  }

  return (
    <div onClick={deleting ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,17,27,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 440, maxWidth: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <AlertTriangle size={18} color="#dc2626" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Delete salon account</div>
            <div style={{ fontSize: 12, color: "#9898b0" }}>This cannot be undone</div>
          </div>
          <button onClick={onClose} disabled={deleting} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9898b0" }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, color: "#4a4a6a", lineHeight: 1.6 }}>
            This permanently deletes <strong>{row.salonName}</strong> ({row.email}) — their login, staff accounts, appointments, clients, staff, services, inventory, invoices, settings, and billing history. There is no undo.
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", marginBottom: 6 }}>
              Type <strong>{row.salonName}</strong> to confirm
            </div>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={deleting}
              placeholder={row.salonName}
              style={{ width: "100%", padding: "10px 13px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, outline: "none", boxSizing: "border-box" }}
            />
          </div>
          {error && <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} disabled={deleting}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: deleting ? "not-allowed" : "pointer" }}>
              Cancel
            </button>
            <button onClick={handleDelete} disabled={!matches || deleting}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "none", background: !matches || deleting ? "#f4f5f7" : "#dc2626", fontSize: 13, fontWeight: 700, color: !matches || deleting ? "#c4c4d4" : "#fff", cursor: !matches || deleting ? "not-allowed" : "pointer" }}>
              {deleting ? "Deleting…" : "Delete Permanently"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaymentMethodModal({ row, methods, onClose, onSaved }: {
  row: BillingUserRow;
  methods: PaymentMethodRow[];
  onClose: () => void;
  onSaved: (userId: string, paymentMethodId: string | null) => void;
}) {
  const [selected, setSelected] = useState(row.paymentMethodId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/set-payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, paymentMethodId: selected || null }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      onSaved(row.id, selected || null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={saving ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,17,27,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 440, maxWidth: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Landmark size={18} color="#7C3AED" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Invoice payment details</div>
            <div style={{ fontSize: 12, color: "#9898b0" }}>{row.salonName}</div>
          </div>
          <button onClick={onClose} disabled={saving} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9898b0" }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, color: "#6b6b8a", lineHeight: 1.6 }}>
            Which bank account should show on this salon&apos;s invoice? Manage the list under the <strong>Payment Methods</strong> tab.
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", marginBottom: 6 }}>Payment Method</div>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={saving}
              style={{ width: "100%", padding: "10px 13px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#fff" }}>
              <option value="">— Platform Default ({DEFAULT_BANK_DETAILS.title}) —</option>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>{m.label} ({m.bankName ? `${m.bankName} — ` : ""}{m.bankTitle})</option>
              ))}
            </select>
            {methods.length === 0 && (
              <div style={{ fontSize: 11, color: "#d97706", marginTop: 6 }}>No payment methods created yet — add one under the Payment Methods tab first.</div>
            )}
          </div>
          {error && <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} disabled={saving}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: saving ? "not-allowed" : "pointer" }}>
              Cancel
            </button>
            <button onClick={save} disabled={saving}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "none", background: saving ? "#f4f5f7" : "#7C3AED", fontSize: 13, fontWeight: 700, color: saving ? "#c4c4d4" : "#fff", cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InvoicesModal({ row, onClose, onMarkedPaid }: { row: BillingUserRow; onClose: () => void; onMarkedPaid: (userId: string) => void }) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [dueEdits, setDueEdits] = useState<Record<string, string>>({});
  const [savingDueId, setSavingDueId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadInvoices() {
    setLoading(true);
    setError(null);
    fetch(`/api/billing/invoices?userId=${encodeURIComponent(row.id)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || "Failed to load invoices");
        setInvoices(data.invoices ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load invoices"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadInvoices(); }, [row.id]);

  async function markPaid(invoice: Invoice) {
    if (invoice.status === "paid" || markingId) return;
    if (!window.confirm(`Mark ${invoice.number} as paid for ${row.salonName}?`)) return;
    setMarkingId(invoice.id);
    setError(null);
    try {
      const res = await fetch("/api/billing/mark-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, invoiceId: invoice.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to mark invoice paid");
      setInvoices((prev) => prev.map((inv) => (
        inv.id === invoice.id
          ? { ...inv, status: "paid", paidDate: new Date().toISOString().slice(0, 10) }
          : inv
      )));
      onMarkedPaid(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark invoice paid");
    } finally {
      setMarkingId(null);
    }
  }

  async function saveDueDate(invoice: Invoice) {
    const newDue = dueEdits[invoice.id];
    if (!newDue || newDue === invoice.dueDate || savingDueId) return;
    setSavingDueId(invoice.id);
    setError(null);
    try {
      const res = await fetch("/api/billing/set-due-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, invoiceId: invoice.id, dueDate: newDue }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update due date");
      setInvoices((prev) => prev.map((inv) => (inv.id === invoice.id ? { ...inv, dueDate: newDue } : inv)));
      setDueEdits((prev) => { const next = { ...prev }; delete next[invoice.id]; return next; });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update due date");
    } finally {
      setSavingDueId(null);
    }
  }

  return (
    <div onClick={markingId ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,17,27,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 720, maxWidth: "100%", maxHeight: "86vh", overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <ReceiptText size={18} color="#7C3AED" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>{row.salonName} invoices</div>
            <div style={{ fontSize: 12, color: "#9898b0" }}>{row.ownerName} · {row.email}</div>
          </div>
          <button onClick={onClose} disabled={!!markingId} style={{ background: "none", border: "none", cursor: markingId ? "not-allowed" : "pointer", padding: 4, color: "#9898b0" }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 20, overflowY: "auto", maxHeight: "calc(86vh - 80px)" }}>
          {error && <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 9, background: "#fef2f2", color: "#dc2626", fontSize: 12, fontWeight: 700 }}>{error}</div>}
          {loading ? (
            <div style={{ padding: 48, textAlign: "center", fontSize: 13, color: "#9898b0" }}>Loading invoices…</div>
          ) : invoices.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", fontSize: 13, color: "#9898b0" }}>No invoices found for this salon.</div>
          ) : (
            <div style={{ border: "1px solid #ebebf0", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.1fr 190px 110px 110px 130px", padding: "10px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
                {["INVOICE", "DUE DATE", "AMOUNT", "STATUS", "ACTION"].map((h) => (
                  <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
                ))}
              </div>
              {invoices.map((invoice, i) => {
                const paid = invoice.status === "paid";
                const dueDraft = dueEdits[invoice.id];
                const changed = !!dueDraft && dueDraft !== invoice.dueDate;
                return (
                  <div key={invoice.id} style={{ display: "grid", gridTemplateColumns: "1.1fr 190px 110px 110px 130px", padding: "13px 14px", alignItems: "center", borderBottom: i < invoices.length - 1 ? "1px solid #f4f4f8" : "none" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{invoice.number}</div>
                      <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1 }}>{invoice.planName}</div>
                    </div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="date"
                          value={dueDraft ?? invoice.dueDate}
                          onChange={(e) => setDueEdits((prev) => ({ ...prev, [invoice.id]: e.target.value }))}
                          disabled={paid || !!savingDueId}
                          title={paid ? "Paid invoices can't be re-dated" : "Change the due date"}
                          style={{ fontSize: 11, padding: "5px 6px", borderRadius: 7, border: "1px solid #e4e4ee", outline: "none", width: 138, color: paid ? "#b0b0c8" : "#1a1a2e", background: paid ? "#f8f8fc" : "#fff", cursor: paid ? "not-allowed" : "text" }}
                        />
                        {changed && !paid && (
                          <button
                            onClick={() => saveDueDate(invoice)}
                            disabled={!!savingDueId}
                            title="Save new due date"
                            style={{ padding: "5px 9px", borderRadius: 7, border: "none", background: savingDueId === invoice.id ? "#e4e4ee" : "#7C3AED", color: "#fff", fontSize: 11, fontWeight: 800, cursor: savingDueId ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                          >
                            {savingDueId === invoice.id ? "Saving…" : "Save"}
                          </button>
                        )}
                      </div>
                      {paid && <div style={{ fontSize: 10, color: "#9898b0", marginTop: 2 }}>Paid — locked</div>}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#7C3AED" }}>{fmt(invoice.total)}</div>
                    <div>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 16, background: paid ? "#ecfdf5" : invoice.status === "overdue" ? "#fef2f2" : "#fffbeb", border: `1px solid ${paid ? "#6ee7b7" : invoice.status === "overdue" ? "#fecaca" : "#fde68a"}`, fontSize: 10, fontWeight: 800, color: paid ? "#059669" : invoice.status === "overdue" ? "#dc2626" : "#d97706", textTransform: "capitalize" }}>
                        {invoice.status}
                      </span>
                    </div>
                    <button
                      onClick={() => markPaid(invoice)}
                      disabled={paid || !!markingId}
                      style={{ padding: "8px 10px", borderRadius: 9, border: paid ? "1px solid #e8e8f0" : "none", background: paid ? "#f8f8fc" : "#059669", color: paid ? "#b0b0c8" : "#fff", fontSize: 12, fontWeight: 800, cursor: paid || markingId ? "not-allowed" : "pointer" }}
                    >
                      {paid ? "Paid" : markingId === invoice.id ? "Marking…" : "Mark Paid"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SalonAccountsPanel() {
  const [rows, setRows] = useState<BillingUserRow[]>([]);
  const [methods, setMethods] = useState<PaymentMethodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BillingUserRow | null>(null);
  const [invoiceTarget, setInvoiceTarget] = useState<BillingUserRow | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<BillingUserRow | null>(null);
  const [unsuspendingId, setUnsuspendingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/billing/users")
      .then((res) => res.json())
      .then((data) => { if (data.ok) setRows(data.users); })
      .finally(() => setLoading(false));
    fetch("/api/billing/payment-methods")
      .then((res) => res.json())
      .then((data) => { if (data.ok) setMethods(data.methods); });
  }, []);

  function handleSaved(userId: string, price: number, termMonths: BillingTermMonths) {
    setRows((prev) => prev.map((r) => (r.id === userId ? { ...r, planPrice: price, billingTermMonths: termMonths } : r)));
  }

  function handlePlanSaved(userId: string, planId: string, planName: string, planPrice: number) {
    setRows((prev) => prev.map((r) => (r.id === userId ? { ...r, planId, planName, planPrice: planPrice * (r.billingTermMonths ?? 1) } : r)));
  }

  function handleDeleted(userId: string) {
    setRows((prev) => prev.filter((r) => r.id !== userId));
    setDeleteTarget(null);
  }

  function handleMarkedPaid(userId: string) {
    setRows((prev) => prev.map((r) => (r.id === userId ? { ...r, suspended: false, suspensionReason: null } : r)));
  }

  async function unsuspend(row: BillingUserRow) {
    if (unsuspendingId) return;
    if (!window.confirm(`Restore access for ${row.salonName}? This lifts the billing suspension without marking any invoice as paid.`)) return;
    setUnsuspendingId(row.id);
    try {
      const res = await fetch("/api/billing/unsuspend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, markPaid: false }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to unsuspend account");
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, suspended: false, suspensionReason: null } : r)));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to unsuspend account");
    } finally {
      setUnsuspendingId(null);
    }
  }

  function handlePaymentMethodSaved(userId: string, paymentMethodId: string | null) {
    setRows((prev) => prev.map((r) => (r.id === userId ? { ...r, paymentMethodId } : r)));
  }

  const filtered = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.salonName.toLowerCase().includes(q) || r.ownerName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
  });

  if (loading) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", padding: "48px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
        Loading salon accounts…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by salon, owner, or email…"
        style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #e4e4ee", fontSize: 13, outline: "none", maxWidth: 340 }}
      />
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 130px 190px 210px 96px 40px 44px", padding: "10px 20px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
          {["SALON", "PLAN", "STATUS", "TERM / PRICE", "INVOICES", "", ""].map((h, i) => (
            <div key={i} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
          ))}
        </div>
        {filtered.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>No salon accounts found</div>
        ) : (
          filtered.map((row, i) => (
            <div key={row.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 130px 190px 210px 96px 40px 44px", padding: "14px 20px", alignItems: "center", borderBottom: i < filtered.length - 1 ? "1px solid #f4f4f8" : "none" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>{row.salonName}</div>
                <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1 }}>{row.ownerName} · {row.email}</div>
              </div>
              <PlanCell row={row} onSaved={handlePlanSaved} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {row.suspended ? (
                  <>
                    <span title={row.suspensionReason ?? undefined} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 16, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 10, fontWeight: 700, color: "#dc2626" }}>Suspended</span>
                    <button onClick={() => unsuspend(row)} disabled={!!unsuspendingId}
                      title={row.suspensionReason ?? "Account suspended — restore access"}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 8, border: "none", background: unsuspendingId === row.id ? "#e4e4ee" : "#059669", color: "#fff", fontSize: 10, fontWeight: 800, cursor: unsuspendingId ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
                      <RotateCcw size={10} /> {unsuspendingId === row.id ? "Restoring…" : "Unsuspend"}
                    </button>
                  </>
                ) : (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 16, background: "#ecfdf5", border: "1px solid #6ee7b7", fontSize: 10, fontWeight: 700, color: "#059669" }}>Active</span>
                )}
              </div>
              <PriceCell row={row} onSaved={handleSaved} />
              <button onClick={() => setInvoiceTarget(row)}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, width: 78, padding: "7px 0", borderRadius: 9, border: "1px solid #ddd6fe", background: "#f5f3ff", color: "#7C3AED", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                <ReceiptText size={12} /> View
              </button>
              <button onClick={() => setPaymentTarget(row)}
                title={row.paymentMethodId ? `Payment method: ${methods.find(m => m.id === row.paymentMethodId)?.label ?? "custom"}` : "Invoice payment details (using platform default)"}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: 6, color: row.paymentMethodId ? "#7C3AED" : "#c4c4d4", display: "flex", justifySelf: "start" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "#7C3AED")}
                onMouseLeave={(e) => (e.currentTarget.style.color = row.paymentMethodId ? "#7C3AED" : "#c4c4d4")}>
                <Landmark size={14} />
              </button>
              <button onClick={() => setDeleteTarget(row)} title="Delete account"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: 6, color: "#c4c4d4", display: "flex", justifySelf: "start" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "#dc2626")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "#c4c4d4")}>
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      {deleteTarget && (
        <DeleteAccountModal row={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={handleDeleted} />
      )}
      {invoiceTarget && (
        <InvoicesModal row={invoiceTarget} onClose={() => setInvoiceTarget(null)} onMarkedPaid={handleMarkedPaid} />
      )}
      {paymentTarget && (
        <PaymentMethodModal row={paymentTarget} methods={methods} onClose={() => setPaymentTarget(null)} onSaved={handlePaymentMethodSaved} />
      )}
    </div>
  );
}

function PaymentMethodFormModal({ editing, onClose, onSaved }: {
  editing: PaymentMethodRow | null; // null = creating a new one
  onClose: () => void;
  onSaved: (method: PaymentMethodRow) => void;
}) {
  const [label, setLabel]                 = useState(editing?.label ?? "");
  const [bankName, setBankName]           = useState(editing?.bankName ?? "");
  const [bankTitle, setBankTitle]         = useState(editing?.bankTitle ?? "");
  const [accountNumber, setAccountNumber] = useState(editing?.accountNumber ?? "");
  const [iban, setIban]                   = useState(editing?.iban ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/payment-methods", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, label, bankName, bankTitle, accountNumber, iban } : { label, bankName, bankTitle, accountNumber, iban }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      onSaved(editing ? { id: editing.id, label, bankName, bankTitle, accountNumber, iban, createdAt: editing.createdAt } : data.method);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 13px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, outline: "none", boxSizing: "border-box" };

  return (
    <div onClick={saving ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,17,27,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 440, maxWidth: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Landmark size={18} color="#7C3AED" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>{editing ? "Edit payment method" : "New payment method"}</div>
          </div>
          <button onClick={onClose} disabled={saving} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9898b0" }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", marginBottom: 6 }}>Label <span style={{ color: "#c4c4d4", fontWeight: 500 }}>(shown in the dropdown, e.g. &quot;Tareez Tech — Alfalah&quot;)</span></div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", marginBottom: 6 }}>Bank Name <span style={{ color: "#c4c4d4", fontWeight: 500 }}>(e.g. &quot;Bank Alfalah&quot;)</span></div>
            <input value={bankName} onChange={(e) => setBankName(e.target.value)} disabled={saving} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", marginBottom: 6 }}>Account Title</div>
            <input value={bankTitle} onChange={(e) => setBankTitle(e.target.value)} disabled={saving} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", marginBottom: 6 }}>Account Number</div>
            <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} disabled={saving} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b6b8a", marginBottom: 6 }}>IBAN</div>
            <input value={iban} onChange={(e) => setIban(e.target.value)} disabled={saving} style={inputStyle} />
          </div>
          {error && <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} disabled={saving}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: saving ? "not-allowed" : "pointer" }}>
              Cancel
            </button>
            <button onClick={save} disabled={saving || !label.trim() || !bankName.trim() || !bankTitle.trim() || !accountNumber.trim() || !iban.trim()}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "none", background: saving ? "#f4f5f7" : "#7C3AED", fontSize: 13, fontWeight: 700, color: saving ? "#c4c4d4" : "#fff", cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeletePaymentMethodModal({ method, onClose, onDeleted }: { method: PaymentMethodRow; onClose: () => void; onDeleted: (id: string) => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/payment-methods?id=${encodeURIComponent(method.id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to delete");
      onDeleted(method.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <div onClick={deleting ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,17,27,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 400, maxWidth: "100%", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <AlertTriangle size={18} color="#dc2626" />
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Delete payment method</div>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, color: "#4a4a6a", lineHeight: 1.6 }}>
            Delete <strong>{method.label}</strong>? Any salon currently pointed at this method will fall back to the platform default.
          </div>
          {error && <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} disabled={deleting}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: deleting ? "not-allowed" : "pointer" }}>
              Cancel
            </button>
            <button onClick={handleDelete} disabled={deleting}
              style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "none", background: deleting ? "#f4f5f7" : "#dc2626", fontSize: 13, fontWeight: 700, color: deleting ? "#c4c4d4" : "#fff", cursor: deleting ? "not-allowed" : "pointer" }}>
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaymentMethodsPanel() {
  const [methods, setMethods] = useState<PaymentMethodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [formTarget, setFormTarget] = useState<PaymentMethodRow | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<PaymentMethodRow | null>(null);

  useEffect(() => {
    fetch("/api/billing/payment-methods")
      .then((res) => res.json())
      .then((data) => { if (data.ok) setMethods(data.methods); })
      .finally(() => setLoading(false));
  }, []);

  function handleSaved(method: PaymentMethodRow) {
    setMethods((prev) => {
      const exists = prev.some((m) => m.id === method.id);
      return exists ? prev.map((m) => (m.id === method.id ? method : m)) : [...prev, method];
    });
  }

  function handleDeleted(id: string) {
    setMethods((prev) => prev.filter((m) => m.id !== id));
    setDeleteTarget(null);
  }

  if (loading) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", padding: "48px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
        Loading payment methods…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, color: "#6b6b8a" }}>
          The bank accounts available to assign per-salon on the Salon Accounts tab.
        </div>
        <button onClick={() => setFormTarget("new")}
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 10, border: "none", background: "#7C3AED", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
          <Landmark size={14} /> Add Payment Method
        </button>
      </div>

      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 0.9fr 1fr 1fr 1.2fr 88px", padding: "10px 20px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
          {["LABEL", "BANK NAME", "ACCOUNT TITLE", "ACCOUNT NUMBER", "IBAN", ""].map((h) => (
            <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
          ))}
        </div>
        {methods.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
            No payment methods yet — every salon shows the platform default ({DEFAULT_BANK_DETAILS.title}) until you add one.
          </div>
        ) : (
          methods.map((m, i) => (
            <div key={m.id} style={{ display: "grid", gridTemplateColumns: "1fr 0.9fr 1fr 1fr 1.2fr 88px", padding: "14px 20px", alignItems: "center", borderBottom: i < methods.length - 1 ? "1px solid #f4f4f8" : "none" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>{m.label}</div>
              <div style={{ fontSize: 12, color: "#4a4a6a" }}>{m.bankName || "—"}</div>
              <div style={{ fontSize: 12, color: "#4a4a6a" }}>{m.bankTitle}</div>
              <div style={{ fontSize: 12, color: "#4a4a6a", fontFamily: "monospace" }}>{m.accountNumber}</div>
              <div style={{ fontSize: 12, color: "#4a4a6a", fontFamily: "monospace" }}>{m.iban}</div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => setFormTarget(m)} title="Edit"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: 6, color: "#9898b0", display: "flex" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#7C3AED")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#9898b0")}>
                  <Pencil size={13} />
                </button>
                <button onClick={() => setDeleteTarget(m)} title="Delete"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: 6, color: "#9898b0", display: "flex" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#dc2626")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#9898b0")}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {formTarget && (
        <PaymentMethodFormModal
          editing={formTarget === "new" ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onSaved={handleSaved}
        />
      )}
      {deleteTarget && (
        <DeletePaymentMethodModal method={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={handleDeleted} />
      )}
    </div>
  );
}

const FREEZE_PRESETS = [
  "Unpaid invoice",
  "Overdue payment",
  "Violation of terms",
  "Suspicious activity",
  "Duplicate account",
];

function FreezeAccountModal({ row, onClose, onFrozen }: {
  row: AccountUserRow;
  onClose: () => void;
  onFrozen: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  async function confirm() {
    if (loading) return;
    setLoading(true);
    const ok = await onFrozen(reason.trim());
    if (ok) onClose();
    else setLoading(false);
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 440, maxWidth: "100%", padding: "32px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Snowflake size={20} color="#dc2626" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 17, color: "#1a1a2e" }}>Freeze this account?</div>
            <div style={{ fontSize: 12, color: "#9898b0", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.ownerName} · {row.salonName} ({row.email})
            </div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: "#6b6b8a", lineHeight: 1.6, marginBottom: 14 }}>
          The account will be locked immediately — {row.ownerName.split(" ")[0]} will be signed out of every device and blocked from logging in until you unfreeze it.
        </div>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Reason</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {FREEZE_PRESETS.map((p) => (
            <button key={p} onClick={() => setReason(p)}
              style={{ padding: "6px 10px", borderRadius: 8, border: `1px solid ${reason === p ? "#dc2626" : "#e8e8f0"}`, background: reason === p ? "#fef2f2" : "#fff", fontSize: 11, fontWeight: 700, color: reason === p ? "#dc2626" : "#6b6b8a", cursor: "pointer" }}>
              {p}
            </button>
          ))}
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Or type a custom reason…"
          rows={3}
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: "1px solid #e4e4ee", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit", color: "#1a1a2e" }}
        />
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button onClick={onClose} disabled={loading} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: loading ? "not-allowed" : "pointer" }}>Cancel</button>
          <button onClick={confirm} disabled={loading}
            style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#dc2626", fontSize: 13, fontWeight: 700, color: "#fff", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Snowflake size={14} /> {loading ? "Freezing…" : "Freeze Account"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Rough "Chrome on Windows"-style label from a user-agent string. */
function describeDevice(ua: string | null): { label: string; kind: "phone" | "tablet" | "computer" } {
  if (!ua) return { label: "Unknown device", kind: "computer" };
  const os =
    /iPhone/.test(ua) ? "iPhone" :
    /iPad/.test(ua) ? "iPad" :
    /Android/.test(ua) ? "Android" :
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X|Macintosh/.test(ua) ? "Mac" :
    /CrOS/.test(ua) ? "Chromebook" :
    /Linux/.test(ua) ? "Linux" : "Unknown OS";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\/|Opera/.test(ua) ? "Opera" :
    /SamsungBrowser/.test(ua) ? "Samsung Internet" :
    /Firefox|FxiOS/.test(ua) ? "Firefox" :
    /Chrome|CriOS/.test(ua) ? "Chrome" :
    /Safari/.test(ua) ? "Safari" : "Browser";
  const kind = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "tablet"
    : /iPhone|Mobile|Android/.test(ua) ? "phone" : "computer";
  return { label: `${browser} on ${os}`, kind };
}

function fmtAgo(iso: string | null) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 5) return "Active now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function DevicesModal({ row, onClose, onCountChange }: {
  row: AccountUserRow;
  onClose: () => void;
  onCountChange: (userId: string, count: number) => void;
}) {
  const [sessions, setSessions] = useState<DeviceSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/sessions?userId=${encodeURIComponent(row.id)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || "Failed to load devices.");
        setSessions(data.sessions);
        onCountChange(row.id, data.sessions.length);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load devices."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  async function signOut(sessionId: string | "all") {
    if (busyId) return;
    if (sessionId === "all" && !confirm(`Sign ${row.ownerName} out of all ${sessions.length} devices?`)) return;
    setBusyId(sessionId);
    setError(null);
    try {
      const res = await fetch("/api/admin/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionId === "all" ? { userId: row.id, all: true } : { userId: row.id, sessionId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to sign out device.");
      const next = sessionId === "all" ? [] : sessions.filter((s) => s.id !== sessionId);
      setSessions(next);
      onCountChange(row.id, next.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sign out device.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 560, maxWidth: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "24px 24px 16px" }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Monitor size={20} color="#7C3AED" />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 17, color: "#1a1a2e" }}>
              {loading ? "Logged-in devices" : `Logged in on ${sessions.length} device${sessions.length === 1 ? "" : "s"}`}
            </div>
            <div style={{ fontSize: 12, color: "#9898b0", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.ownerName} · {row.email}
            </div>
          </div>
          <button onClick={onClose} title="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "#9898b0", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ overflowY: "auto", padding: "0 24px", flex: 1 }}>
          {error && (
            <div style={{ padding: "10px 14px", borderRadius: 9, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12, color: "#dc2626", fontWeight: 700, marginBottom: 12 }}>{error}</div>
          )}
          {loading ? (
            <div style={{ padding: 32, textAlign: "center", fontSize: 13, color: "#9898b0" }}>Loading devices…</div>
          ) : sessions.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", fontSize: 13, color: "#9898b0" }}>Not logged in on any device.</div>
          ) : (
            sessions.map((s) => {
              const device = describeDevice(s.userAgent);
              const Icon = device.kind === "phone" ? Smartphone : device.kind === "tablet" ? Tablet : Monitor;
              const place = [s.city, s.country].filter(Boolean).join(", ");
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid #f4f4f8" }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: "#f4f4f9", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={17} color="#6b6b8a" />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {s.userAgent ? device.label : "Unknown device (logged in before tracking started)"}
                      {s.current && <span style={{ fontSize: 10, fontWeight: 800, color: "#059669", background: "#ecfdf5", padding: "2px 7px", borderRadius: 10 }}>This device</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>
                      {[place, s.ip].filter(Boolean).join(" · ") || "Location unknown"}
                    </div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1 }}>
                      Last active: {fmtAgo(s.lastSeenAt ?? s.createdAt)}{s.createdAt ? ` · Logged in ${fmtDate(s.createdAt)}` : ""}
                    </div>
                  </div>
                  <button onClick={() => signOut(s.id)} disabled={!!busyId}
                    title="Sign this device out"
                    style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", gap: 4, cursor: busyId ? "not-allowed" : "pointer", flexShrink: 0 }}>
                    <LogOut size={12} /> {busyId === s.id ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div style={{ display: "flex", gap: 10, padding: "16px 24px 24px" }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Close</button>
          {sessions.length > 1 && (
            <button onClick={() => signOut("all")} disabled={!!busyId}
              style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#dc2626", fontSize: 13, fontWeight: 700, color: "#fff", cursor: busyId ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <LogOut size={14} /> {busyId === "all" ? "Signing out…" : "Sign out all devices"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const ADMIN_CARD: React.CSSProperties = {
  background: "#fff", border: "1px solid #ececf4", borderRadius: 16,
  boxShadow: "0 6px 18px rgba(30,20,10,0.04)", minWidth: 0,
};

function AdminStatCard({ label, value, sub, icon: Icon, color }: { label: string; value: string; sub: string; icon: React.ElementType; color: string }) {
  return (
    <div style={{ ...ADMIN_CARD, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 38, height: 38, borderRadius: 12, background: `${color}14`, display: "grid", placeItems: "center", color, flexShrink: 0 }}>
        <Icon size={17} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 21, fontWeight: 900, color: "#1a1a2e", lineHeight: 1.1, letterSpacing: "-0.03em" }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#8b8ba3", marginTop: 2 }}>{label}</div>
        <div style={{ fontSize: 10.5, color: "#a5a5bb", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
      </div>
    </div>
  );
}

function AdminSectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ ...ADMIN_CARD, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f6", fontSize: 13.5, fontWeight: 850, color: "#1a1a2e" }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function AdminStatusChip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, background: "#fff", border: `1px solid ${color}44`, fontSize: 11, fontWeight: 700, color }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

function AdminDashboardPanel() {
  const [users, setUsers] = useState<AccountUserRow[]>([]);
  const [requests] = useState<PaymentRequest[]>(() => (typeof window === "undefined" ? [] : getPaymentRequests()));
  const [lastBackup, setLastBackup] = useState<{ createdAt: string; totalRows: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/users").then((res) => res.json()).then((d) => { if (d.ok) setUsers(d.users); }),
      fetch("/api/admin/backups?kind=database&limit=1").then((res) => res.json()).then((d) => {
        if (d.ok && d.backups?.[0]) setLastBackup({ createdAt: d.backups[0].createdAt, totalRows: d.backups[0].totalRows });
      }),
    ]).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", padding: "48px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
        Loading dashboard…
      </div>
    );
  }

  const owners = users.filter((u) => u.role === "owner");
  const staff = users.filter((u) => u.role === "staff");
  const managers = users.filter((u) => u.role === "manager");
  const frozen = users.filter((u) => u.accountFrozen);
  const awaitingApproval = owners.filter((u) => u.approvalStatus === "pending");
  const withPlan = owners.filter((u) => u.planId && u.planId !== "free");
  const mrr = withPlan.reduce((sum, u) => sum + (PLAN_CONFIGS[u.planId as PlanId]?.price ?? 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = owners.filter((u) => u.invoiceDueDate && u.invoiceDueDate < today);

  const pendingRequests = requests.filter((r) => r.status === "pending");
  const approvedRequests = requests.filter((r) => r.status === "approved");
  const rejectedRequests = requests.filter((r) => r.status === "rejected");
  const pendingValue = pendingRequests.reduce((s, r) => s + (r.amount || 0), 0);

  const planCounts = (["free", "starter", "pro", "premium"] as const).map((id) => ({
    id,
    name: PLAN_CONFIGS[id].name,
    price: PLAN_CONFIGS[id].price,
    count: owners.filter((u) => u.planId === id).length,
  }));
  const planMax = Math.max(...planCounts.map((p) => p.count), 1);

  const recentSignups = [...users]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 6);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Primary stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
        <AdminStatCard label="Salon Accounts" value={String(owners.length)} sub={`${withPlan.length} on a paid plan`} icon={Store} color="#0284c7" />
        <AdminStatCard label="Total Accounts" value={String(users.length)} sub={`${managers.length} manager · ${staff.length} staff`} icon={UsersIcon} color="#7C3AED" />
        <AdminStatCard label="Pending Payments" value={String(pendingRequests.length)} sub={pendingValue > 0 ? `≈ ${fmt(pendingValue)} awaiting review` : "Nothing waiting"} icon={Clock} color="#d97706" />
        <AdminStatCard label="Monthly Recurring" value={fmt(mrr)} sub={`${withPlan.length} active subscriptions`} icon={Banknote} color="#059669" />
      </div>

      {/* Status chips row */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <AdminStatusChip label={`${awaitingApproval.length} awaiting approval`} color={awaitingApproval.length ? "#d97706" : "#059669"} />
        <AdminStatusChip label={`${frozen.length} frozen accounts`} color={frozen.length ? "#dc2626" : "#059669"} />
        <AdminStatusChip label={`${overdue.length} invoices overdue`} color={overdue.length ? "#dc2626" : "#059669"} />
        <AdminStatusChip label={`${approvedRequests.length} approved · ${rejectedRequests.length} rejected`} color="#6b6b8a" />
        <AdminStatusChip
          label={lastBackup ? `Last backup ${fmtDate(lastBackup.createdAt)} · ${lastBackup.totalRows.toLocaleString()} rows` : "No backup yet"}
          color="#0369a1"
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        {/* Plan distribution */}
        <AdminSectionCard title="Plan Distribution">
          {planCounts.map((p) => (
            <div key={p.id} style={{ padding: "12px 18px", borderBottom: "1px solid #f4f4f8" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#4a4a6a" }}>{p.name}</span>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e" }}>
                  {p.count} <span style={{ fontWeight: 500, color: "#9898b0" }}>salon{p.count === 1 ? "" : "s"}</span>
                </span>
              </div>
              <div style={{ height: 6, background: "#f0f0f5", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${(p.count / planMax) * 100}%`, height: "100%", background: p.id === "free" ? "#94a3b8" : p.id === "starter" ? "#0ea5e9" : p.id === "pro" ? "#7C3AED" : "#d97706", borderRadius: 3 }} />
              </div>
              <div style={{ fontSize: 10, color: "#b0b0c8", marginTop: 4 }}>{p.price > 0 ? `${fmt(p.price)}/mo` : "Free forever"}</div>
            </div>
          ))}
        </AdminSectionCard>

        {/* Payment requests overview */}
        <AdminSectionCard title="Payment Requests">
          {requests.length === 0 ? (
            <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12, color: "#9898b0" }}>No payment requests yet.</div>
          ) : (
            [
              { label: "Pending", n: pendingRequests.length, color: "#d97706", bg: "#fffbeb" },
              { label: "Approved", n: approvedRequests.length, color: "#059669", bg: "#ecfdf5" },
              { label: "Rejected", n: rejectedRequests.length, color: "#dc2626", bg: "#fef2f2" },
            ].map((row) => (
              <div key={row.label} style={{ padding: "12px 18px", borderBottom: "1px solid #f4f4f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700, color: row.color }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: row.color }} /> {row.label}
                </span>
                <span style={{ fontSize: 15, fontWeight: 900, color: "#1a1a2e" }}>{row.n}</span>
              </div>
            ))
          )}
        </AdminSectionCard>
      </div>

      {/* Recent signups */}
      <AdminSectionCard title="Recent Signups">
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(220px,1.4fr) minmax(160px,1fr) 120px 140px 110px", padding: "10px 18px", background: "#fafafa", borderBottom: "1px solid #f4f4f8", minWidth: 780 }}>
            {["NAME / EMAIL", "SALON", "ROLE", "SIGNED UP", "PLAN"].map((h) => (
              <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>
          {recentSignups.length === 0 ? (
            <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12, color: "#9898b0" }}>No accounts yet.</div>
          ) : (
            recentSignups.map((u, i) => {
              const role = ROLE_META[u.role] ?? ROLE_META.staff;
              return (
                <div key={u.id} style={{ display: "grid", gridTemplateColumns: "minmax(220px,1.4fr) minmax(160px,1fr) 120px 140px 110px", padding: "11px 18px", alignItems: "center", borderBottom: i < recentSignups.length - 1 ? "1px solid #f4f4f8" : "none", minWidth: 780 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.ownerName}</div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                  </div>
                  <div style={{ fontSize: 12, color: "#6b6b8a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.salonName}</div>
                  <div>
                    <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 9px", borderRadius: 16, background: role.bg, border: `1px solid ${role.color}44`, fontSize: 10, fontWeight: 700, color: role.color }}>{role.label}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#9898b0" }}>{fmtSignupDate(u.createdAt)}</div>
                  <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 700 }}>{u.planName ?? "—"}</div>
                </div>
              );
            })
          )}
        </div>
      </AdminSectionCard>
    </div>
  );
}

function UsersPanel() {
  const [rows, setRows] = useState<AccountUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<AccountUserRow["role"] | "all">("all");
  const [updatingApproval, setUpdatingApproval] = useState<string | null>(null);
  const [freezeTarget, setFreezeTarget] = useState<AccountUserRow | null>(null);
  const [devicesTarget, setDevicesTarget] = useState<AccountUserRow | null>(null);
  const [dueDrafts, setDueDrafts] = useState<Record<string, string>>({});
  const [savingDueId, setSavingDueId] = useState<string | null>(null);
  const [dueError, setDueError] = useState<string | null>(null);
  const [startDrafts, setStartDrafts] = useState<Record<string, string>>({});
  const [savingStartId, setSavingStartId] = useState<string | null>(null);

  function loadUsers() {
    return fetch("/api/admin/users")
      .then((res) => res.json())
      .then((data) => { if (data.ok) setRows(data.users); });
  }

  useEffect(() => {
    loadUsers().finally(() => setLoading(false));
  }, []);

  const filtered = rows.filter((r) => {
    if (roleFilter !== "all" && r.role !== roleFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      r.ownerName.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      r.salonName.toLowerCase().includes(q) ||
      r.phone.toLowerCase().includes(q)
    );
  });

  const counts = {
    all: rows.length,
    owner: rows.filter((r) => r.role === "owner").length,
    manager: rows.filter((r) => r.role === "manager").length,
    staff: rows.filter((r) => r.role === "staff").length,
    admin: rows.filter((r) => r.role === "admin").length,
  };

  async function updateApproval(userId: string, approvalStatus: AccountUserRow["approvalStatus"]) {
    setUpdatingApproval(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, approvalStatus }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update approval.");
      setRows((prev) => prev.map((row) => row.id === userId ? { ...row, approvalStatus } : row));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update approval.");
    } finally {
      setUpdatingApproval(null);
    }
  }

  async function updateFreeze(userId: string, frozen: boolean, reason?: string): Promise<boolean> {
    setUpdatingApproval(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frozen ? { userId, action: "freeze", reason } : { userId, action: "unfreeze" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update account status.");
      setRows((prev) => prev.map((row) =>
        row.id === userId ? { ...row, accountFrozen: frozen, freezeReason: frozen ? (reason?.trim() || null) : null } : row
      ));
      return true;
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update account status.");
      return false;
    } finally {
      setUpdatingApproval(null);
    }
  }

  async function saveStartDate(row: AccountUserRow) {
    const newStart = startDrafts[row.id];
    if (!newStart || newStart === row.startedDate?.slice(0, 10) || savingStartId) return;
    setSavingStartId(row.id);
    setDueError(null);
    try {
      const res = await fetch("/api/billing/set-start-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, startDate: newStart }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update start date");
      setStartDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
      // Before a salon's first invoice its due date follows the start date — reload
      // so the Invoice Due column shows the recomputed date.
      if (data.scheduleMoved) await loadUsers();
      else setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, startedDate: newStart } : r)));
    } catch (e) {
      setDueError(e instanceof Error ? e.message : "Failed to update start date");
    } finally {
      setSavingStartId(null);
    }
  }

  async function saveDueDate(row: AccountUserRow) {
    const newDue = dueDrafts[row.id];
    if (!row.invoiceId || !newDue || newDue === row.invoiceDueDate || savingDueId) return;
    setSavingDueId(row.id);
    setDueError(null);
    try {
      const res = await fetch("/api/billing/set-due-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: row.id, invoiceId: row.invoiceId, dueDate: newDue }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update due date");
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, invoiceDueDate: newDue } : r)));
      setDueDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
    } catch (e) {
      setDueError(e instanceof Error ? e.message : "Failed to update due date");
    } finally {
      setSavingDueId(null);
    }
  }

  if (loading) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", padding: "48px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
        Loading users…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {freezeTarget && (
        <FreezeAccountModal
          row={freezeTarget}
          onClose={() => setFreezeTarget(null)}
          onFrozen={async (reason) => {
            const ok = await updateFreeze(freezeTarget.id, true, reason);
            return ok;
          }}
        />
      )}
      {devicesTarget && (
        <DevicesModal
          row={devicesTarget}
          onClose={() => setDevicesTarget(null)}
          onCountChange={(userId, count) => setRows((prev) => prev.map((r) => (r.id === userId ? { ...r, activeDevices: count } : r)))}
        />
      )}
      {dueError && (
        <div style={{ padding: "10px 14px", borderRadius: 9, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12, color: "#dc2626", fontWeight: 700 }}>
          {dueError}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, salon, or phone…"
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #e4e4ee", fontSize: 13, outline: "none", minWidth: 280, flex: 1, maxWidth: 340 }}
        />
        <div style={{ display: "flex", gap: 6 }}>
          {(["all", "owner", "manager", "staff", "admin"] as const).map((r) => (
            <button key={r} onClick={() => setRoleFilter(r)}
              style={{
                padding: "7px 12px", borderRadius: 9, fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "capitalize",
                border: `1.5px solid ${roleFilter === r ? "#7C3AED" : "#ebebf0"}`,
                background: roleFilter === r ? "#f5f3ff" : "#fff",
                color: roleFilter === r ? "#7C3AED" : "#6b6b8a",
              }}>
              {r === "all" ? "All" : ROLE_META[r].label} {r !== "all" && `(${counts[r]})`}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflowX: "auto", overflowY: "hidden" }}>
        <div style={{ minWidth: 1730 }}>
          <div style={{ display: "grid", gridTemplateColumns: USERS_GRID_COLUMNS, padding: "10px 20px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
          {["NAME / EMAIL", "SALON", "PHONE", "ROLE", "APPROVAL", "STATUS", "DEVICES", "PLAN", "STARTED", "INVOICE DUE", "ACTIONS"].map((h) => (
            <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
          ))}
          </div>
        {filtered.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>No users found</div>
        ) : (
          filtered.map((row, i) => {
            const role = ROLE_META[row.role] ?? ROLE_META.staff;
            return (
              <div key={row.id} style={{ display: "grid", gridTemplateColumns: USERS_GRID_COLUMNS, padding: "14px 20px", alignItems: "center", borderBottom: i < filtered.length - 1 ? "1px solid #f4f4f8" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 10, background: "#f0f0f8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#7C3AED", flexShrink: 0 }}>
                    {row.ownerName.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.ownerName}</div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.email}</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#6b6b8a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.salonName}</div>
                <div style={{ fontSize: 12, color: "#6b6b8a" }}>{row.phone || "—"}</div>
                <div>
                  <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 9px", borderRadius: 16, background: role.bg, border: `1px solid ${role.color}44`, fontSize: 10, fontWeight: 700, color: role.color }}>
                    {role.label}
                  </span>
                </div>
                <div>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 16,
                    background: row.approvalStatus === "approved" ? "#ecfdf5" : row.approvalStatus === "rejected" ? "#fef2f2" : "#fffbeb",
                    color: row.approvalStatus === "approved" ? "#059669" : row.approvalStatus === "rejected" ? "#dc2626" : "#d97706",
                    fontSize: 11, fontWeight: 800, textTransform: "capitalize",
                  }}>
                    {row.approvalStatus === "approved" ? <BadgeCheck size={13} /> : row.approvalStatus === "rejected" ? <XCircle size={13} /> : <Clock size={13} />}
                    {row.approvalStatus}
                  </span>
                </div>
                <div>
                  <span title={row.accountFrozen && row.freezeReason ? row.freezeReason : undefined}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 16,
                      background: row.accountFrozen ? "#fef2f2" : "#f0fdf4",
                      color: row.accountFrozen ? "#dc2626" : "#059669",
                      fontSize: 11, fontWeight: 800, textTransform: "capitalize",
                    }}>
                    {row.accountFrozen ? <Lock size={12} /> : <BadgeCheck size={12} />}
                    {row.accountFrozen ? "Frozen" : "Active"}
                  </span>
                </div>
                <div>
                  <button onClick={() => setDevicesTarget(row)}
                    title="See which devices this account is logged in on"
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 16, cursor: "pointer",
                      border: `1px solid ${row.activeDevices > 0 ? "#ddd6fe" : "#ebebf0"}`,
                      background: row.activeDevices > 0 ? "#f5f3ff" : "#fff",
                      color: row.activeDevices > 0 ? "#7C3AED" : "#9898b0",
                      fontSize: 11, fontWeight: 800,
                    }}>
                    <Monitor size={12} /> {row.activeDevices}
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 700 }}>{row.planName ?? "—"}</div>
                <div>
                  {row.role === "owner" && row.startedDate ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <input
                        type="date"
                        value={startDrafts[row.id] ?? row.startedDate.slice(0, 10)}
                        onChange={(e) => setStartDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        disabled={!!savingStartId}
                        title="Change the date this salon started. Before its first invoice, this also moves when billing begins."
                        style={{ fontSize: 11, padding: "5px 6px", borderRadius: 7, border: "1px solid #e4e4ee", outline: "none", width: 138, color: "#1a1a2e", background: "#fff", cursor: savingStartId ? "not-allowed" : "text" }}
                      />
                      {!!startDrafts[row.id] && startDrafts[row.id] !== row.startedDate.slice(0, 10) && (
                        <button
                          onClick={() => saveStartDate(row)}
                          disabled={!!savingStartId}
                          title="Save new start date"
                          style={{ padding: "5px 9px", borderRadius: 7, border: "none", background: savingStartId === row.id ? "#e4e4ee" : "#7C3AED", color: "#fff", fontSize: 11, fontWeight: 800, cursor: savingStartId ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                        >
                          {savingStartId === row.id ? "Saving…" : "Save"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "#9898b0" }}>{fmtOptionalDate(row.startedDate)}</div>
                  )}
                </div>
                <div>
                  {row.role === "owner" && row.invoiceId ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <input
                        type="date"
                        value={dueDrafts[row.id] ?? row.invoiceDueDate ?? ""}
                        onChange={(e) => setDueDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        disabled={!!savingDueId}
                        title="Change the due date of the salon's next unpaid invoice"
                        style={{ fontSize: 11, padding: "5px 6px", borderRadius: 7, border: "1px solid #e4e4ee", outline: "none", width: 138, color: "#1a1a2e", background: "#fff", cursor: savingDueId ? "not-allowed" : "text" }}
                      />
                      {!!dueDrafts[row.id] && dueDrafts[row.id] !== row.invoiceDueDate && (
                        <button
                          onClick={() => saveDueDate(row)}
                          disabled={!!savingDueId}
                          title="Save new due date"
                          style={{ padding: "5px 9px", borderRadius: 7, border: "none", background: savingDueId === row.id ? "#e4e4ee" : "#7C3AED", color: "#fff", fontSize: 11, fontWeight: 800, cursor: savingDueId ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                        >
                          {savingDueId === row.id ? "Saving…" : "Save"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "#9898b0" }}>{fmtOptionalDate(row.invoiceDueDate)}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {row.role === "owner" && row.approvalStatus !== "approved" && (
                    <button onClick={() => updateApproval(row.id, "approved")} disabled={updatingApproval === row.id}
                      style={{ padding: "7px 10px", borderRadius: 8, border: "none", background: "#059669", color: "#fff", fontSize: 11, fontWeight: 800, cursor: updatingApproval === row.id ? "not-allowed" : "pointer" }}>
                      Approve
                    </button>
                  )}
                  {row.role === "owner" && row.approvalStatus !== "rejected" && (
                    <button onClick={() => updateApproval(row.id, "rejected")} disabled={updatingApproval === row.id}
                      style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: 11, fontWeight: 800, cursor: updatingApproval === row.id ? "not-allowed" : "pointer" }}>
                      Disapprove
                    </button>
                  )}
                  {row.role !== "admin" && !row.accountFrozen && (
                    <button onClick={() => setFreezeTarget(row)} disabled={updatingApproval === row.id}
                      title="Freeze this account (blocks login and access)"
                      style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", gap: 4, cursor: updatingApproval === row.id ? "not-allowed" : "pointer" }}>
                      <Snowflake size={12} /> Freeze
                    </button>
                  )}
                  {row.role !== "admin" && row.accountFrozen && (
                    <button onClick={() => updateFreeze(row.id, false)} disabled={updatingApproval === row.id}
                      title={row.freezeReason ? `Frozen: ${row.freezeReason}` : "Frozen account"}
                      style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#059669", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", gap: 4, cursor: updatingApproval === row.id ? "not-allowed" : "pointer" }}>
                      <LockOpen size={12} /> Unfreeze
                    </button>
                  )}
                  {row.role === "admin" && <span style={{ fontSize: 11, color: "#c4c4d4" }}>—</span>}
                </div>
              </div>
            );
          })
        )}
        </div>
      </div>
    </div>
  );
}

interface DatabaseBackupRow {
  id: string;
  reason: string;
  tableCount: number;
  totalRows: number;
  createdAt: string;
}

interface SalonBundleRow {
  id: string;
  userId: string;
  reason: string;
  entityCount: number;
  totalRecords: number;
  createdAt: string;
}

const REASON_META: Record<string, { label: string; color: string; bg: string }> = {
  "scheduled-snapshot": { label: "Daily", color: "#0369a1", bg: "#eff6ff" },
  "before-write": { label: "Before write", color: "#6b6b8a", bg: "#f4f4f9" },
  "manual-snapshot": { label: "Manual", color: "#7C3AED", bg: "#f5f3ff" },
  "before-account-delete": { label: "Before delete", color: "#dc2626", bg: "#fef2f2" },
};

function ReasonBadge({ reason }: { reason: string }) {
  const meta = REASON_META[reason] ?? { label: reason, color: "#6b6b8a", bg: "#f4f4f9" };
  return (
    <span style={{ fontSize: 10, fontWeight: 800, color: meta.color, background: meta.bg, borderRadius: 20, padding: "3px 9px", textTransform: "uppercase", letterSpacing: "0.03em", whiteSpace: "nowrap" }}>
      {meta.label}
    </span>
  );
}

function RestoreBundleModal({ bundle, userLabel, onClose, onRestored }: {
  bundle: SalonBundleRow;
  userLabel: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");

  async function confirmRestore() {
    setRestoring(true);
    setError("");
    try {
      const res = await fetch("/api/admin/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore-bundle", bundleId: bundle.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Restore failed.");
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed.");
      setRestoring(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 440, maxWidth: "100%", padding: "32px 28px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#fffbeb", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <RotateCcw size={22} color="#d97706" />
        </div>
        <div style={{ fontWeight: 700, fontSize: 17, color: "#1a1a2e", marginBottom: 8 }}>Restore this backup?</div>
        <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 8 }}>
          This overwrites <strong>all</strong> of <strong>{userLabel}</strong>&rsquo;s data — {bundle.entityCount} data type{bundle.entityCount === 1 ? "" : "s"}, {bundle.totalRecords.toLocaleString()} records — with the snapshot from {fmtDate(bundle.createdAt)}.
        </div>
        <div style={{ fontSize: 12, color: "#9898b0", marginBottom: 20 }}>
          A safety backup of the current data is taken automatically before restoring, so this itself can be undone.
        </div>
        {error && <div style={{ marginBottom: 14, padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 12, color: "#dc2626" }}>{error}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} disabled={restoring} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: restoring ? "not-allowed" : "pointer" }}>Cancel</button>
          <button onClick={confirmRestore} disabled={restoring} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#d97706", fontSize: 13, fontWeight: 600, color: "#fff", cursor: restoring ? "not-allowed" : "pointer" }}>
            {restoring ? "Restoring…" : "Restore Everything"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BackupsPanel() {
  const [dbBackups, setDbBackups] = useState<DatabaseBackupRow[]>([]);
  const [bundles, setBundles] = useState<SalonBundleRow[]>([]);
  const [users, setUsers] = useState<AccountUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [userFilter, setUserFilter] = useState("all");
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<SalonBundleRow | null>(null);

  function loadBundles(userId: string) {
    const query = userId === "all" ? "" : `&userId=${encodeURIComponent(userId)}`;
    return fetch(`/api/admin/backups?limit=100${query}`)
      .then((res) => res.json())
      .then((data) => { if (data.ok) setBundles(data.bundles); });
  }

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/backups?kind=database&limit=60").then((res) => res.json()).then((data) => { if (data.ok) setDbBackups(data.backups); }),
      loadBundles("all"),
      fetch("/api/admin/users").then((res) => res.json()).then((data) => { if (data.ok) setUsers(data.users); }),
    ]).finally(() => setLoading(false));
  }, []);

  function userLabel(userId: string): string {
    const user = users.find((u) => u.id === userId);
    return user ? `${user.salonName} (${user.email})` : userId;
  }

  async function runManualBackup() {
    setRunning(true);
    setMessage("");
    setMessageIsError(false);
    try {
      const res = await fetch("/api/admin/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "snapshot-all" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Backup failed.");
      setMessage(`Backup complete — ${data.salonBundles.bundlesCreated} salon${data.salonBundles.bundlesCreated === 1 ? "" : "s"} backed up, ${data.database.totalRows.toLocaleString()} rows archived.`);
      await Promise.all([
        fetch("/api/admin/backups?kind=database&limit=60").then((res) => res.json()).then((d) => { if (d.ok) setDbBackups(d.backups); }),
        loadBundles(userFilter),
      ]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Backup failed.");
      setMessageIsError(true);
    } finally {
      setRunning(false);
    }
  }

  function handleUserFilterChange(userId: string) {
    setUserFilter(userId);
    loadBundles(userId);
  }

  if (loading) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", padding: "48px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
        Loading backups…
      </div>
    );
  }

  const latestDb = dbBackups[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {restoreTarget && (
        <RestoreBundleModal
          bundle={restoreTarget}
          userLabel={userLabel(restoreTarget.userId)}
          onClose={() => setRestoreTarget(null)}
          onRestored={() => { setRestoreTarget(null); setMessage("Restored successfully."); setMessageIsError(false); loadBundles(userFilter); }}
        />
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "#6b6b8a", maxWidth: 560 }}>
          A full database archive plus one backup per salon (everything that salon has — clients, appointments, staff, and the rest — bundled together) run automatically every day at 4:15 AM.
          Daily backups are kept for 30 days; manual snapshots are kept forever.
        </div>
        <button onClick={runManualBackup} disabled={running}
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 10, border: "none", background: "#7C3AED", fontSize: 13, fontWeight: 700, color: "#fff", cursor: running ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
          <Archive size={14} /> {running ? "Running…" : "Run Backup Now"}
        </button>
      </div>

      {message && (
        <div style={{ padding: "10px 16px", background: messageIsError ? "#fef2f2" : "#f0fdf4", border: `1px solid ${messageIsError ? "#fecaca" : "#bbf7d0"}`, borderRadius: 10, fontSize: 12, color: messageIsError ? "#dc2626" : "#059669", fontWeight: 600 }}>
          {message}
        </div>
      )}

      {/* Full database archive */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Database size={15} color="#7C3AED" />
          <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>Full Database Archives</div>
          {latestDb && <span style={{ fontSize: 11, color: "#9898b0" }}>— last run {fmtDate(latestDb.createdAt)}</span>}
        </div>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 90px", padding: "10px 20px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
            {["CREATED", "TABLES", "TOTAL ROWS", "REASON"].map((h) => (
              <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>
          {dbBackups.length === 0 ? (
            <div style={{ padding: "32px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>No full-database archives yet.</div>
          ) : (
            dbBackups.map((b, i) => (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 90px", padding: "12px 20px", alignItems: "center", borderBottom: i < dbBackups.length - 1 ? "1px solid #f4f4f8" : "none" }}>
                <div style={{ fontSize: 12, color: "#4a4a6a" }}>{fmtDate(b.createdAt)}</div>
                <div style={{ fontSize: 12, color: "#4a4a6a" }}>{b.tableCount}</div>
                <div style={{ fontSize: 12, color: "#4a4a6a" }}>{b.totalRows.toLocaleString()}</div>
                <div><ReasonBadge reason={b.reason} /></div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Daily salon backups */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Archive size={15} color="#7C3AED" />
            <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>Daily Salon Backups</div>
          </div>
          <select value={userFilter} onChange={(e) => handleUserFilterChange(e.target.value)}
            style={{ padding: "7px 12px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 12, color: "#1a1a2e", outline: "none", background: "#fff" }}>
            <option value="all">All salons</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.salonName} ({u.email})</option>)}
          </select>
        </div>
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 110px 100px 130px 70px", padding: "10px 20px", background: "#fafafa", borderBottom: "1px solid #f0f0f8" }}>
            {["SALON", "DATA TYPES", "RECORDS", "CREATED", ""].map((h) => (
              <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>
          {bundles.length === 0 ? (
            <div style={{ padding: "32px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>No backups for this filter yet.</div>
          ) : (
            bundles.map((b, i) => (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 110px 100px 130px 70px", padding: "12px 20px", alignItems: "center", borderBottom: i < bundles.length - 1 ? "1px solid #f4f4f8" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{userLabel(b.userId)}</div>
                  <ReasonBadge reason={b.reason} />
                </div>
                <div style={{ fontSize: 12, color: "#4a4a6a" }}>{b.entityCount}</div>
                <div style={{ fontSize: 12, color: "#4a4a6a" }}>{b.totalRecords.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: "#9898b0" }}>{fmtDate(b.createdAt)}</div>
                <button onClick={() => setRestoreTarget(b)} title="Restore this backup"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: 6, color: "#9898b0", display: "flex" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#d97706")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#9898b0")}>
                  <RotateCcw size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const BILLED_FROM_FIELDS: { key: keyof BilledFrom; label: string; placeholder: string; hint?: string }[] = [
  { key: "name",    label: "Business name", placeholder: DEFAULT_BILLED_FROM.name },
  { key: "tagline", label: "Tagline",       placeholder: DEFAULT_BILLED_FROM.tagline },
  { key: "phone",   label: "Phone",         placeholder: DEFAULT_BILLED_FROM.phone },
  { key: "email",   label: "Email",         placeholder: "billing@example.com", hint: "Optional — leave empty to hide it." },
  { key: "address", label: "Address",       placeholder: DEFAULT_BILLED_FROM.address },
];

function InvoiceDetailsPanel() {
  const [saved, setSaved] = useState<BilledFrom | null>(null);
  const [draft, setDraft] = useState<BilledFrom>(DEFAULT_BILLED_FROM);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/billing/billed-from")
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || "Could not load invoice details.");
        setSaved(data.billedFrom);
        setDraft(data.billedFrom);
      })
      .catch((e) => setMessage({ ok: false, text: e instanceof Error ? e.message : "Could not load invoice details." }));
  }, []);

  const dirty = saved !== null && BILLED_FROM_FIELDS.some(({ key }) => draft[key] !== saved[key]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/billing/billed-from", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save.");
      setSaved(data.billedFrom);
      setDraft(data.billedFrom);
      setMessage({ ok: true, text: "Saved — every salon's invoice now shows these details." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Failed to save." });
    } finally {
      setSaving(false);
    }
  }

  const input: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid #e4e4ef", borderRadius: 10, padding: "9px 11px",
    fontSize: 13, color: "#1a1a2e", background: "#fff", outline: "none", fontFamily: "inherit",
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
      <AdminSectionCard title="Billed From">
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, color: "#8b8ba3", lineHeight: 1.6 }}>
            Shown at the top of every salon&apos;s invoice and in its &ldquo;Billed From&rdquo; section.
          </div>
          {BILLED_FROM_FIELDS.map(({ key, label, placeholder, hint }) => (
            <label key={key} style={{ display: "block" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#6b6b8a", marginBottom: 6, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</div>
              <input
                style={input}
                value={draft[key]}
                placeholder={placeholder}
                disabled={saved === null || saving}
                onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
              />
              {hint && <div style={{ fontSize: 10.5, color: "#a5a5bb", marginTop: 4 }}>{hint}</div>}
            </label>
          ))}
          {message && (
            <div style={{ fontSize: 12, fontWeight: 650, color: message.ok ? "#047857" : "#b91c1c" }}>{message.text}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="ac-btn" disabled={!dirty || saving} onClick={() => saved && setDraft(saved)}>
              Undo changes
            </button>
            <button type="button" className="ac-btn" disabled={!dirty || saving || !draft.name.trim()} onClick={save}
              style={{ background: "#7C3AED", borderColor: "#7C3AED", color: "#fff", opacity: !dirty || saving ? 0.55 : 1 }}>
              <Save size={13} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </AdminSectionCard>

      <AdminSectionCard title="Preview">
        <div style={{ padding: "22px 24px", fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Billed From</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 4 }}>{draft.name || "—"}</div>
          <div style={{ fontSize: 12, color: "#555", lineHeight: 2 }}>
            {[draft.tagline, draft.email, draft.phone, draft.address].filter(Boolean).map((line) => <div key={line}>{line}</div>)}
          </div>
        </div>
      </AdminSectionCard>
    </div>
  );
}

type AdminTab = "dashboard" | "requests" | "salons" | "paymentMethods" | "invoiceDetails" | "users" | "backups" | "pointly";

const ADMIN_TABS: { key: AdminTab; label: string; title: string; sub: string; Icon: React.ElementType }[] = [
  { key: "dashboard",      label: "Overview",         title: "Overview",         sub: "Platform-wide view of salons, accounts, payments and backups.", Icon: LayoutDashboard },
  { key: "requests",       label: "Payment requests", title: "Payment requests", sub: "Review and approve payment requests from salons.",                Icon: Clock },
  { key: "salons",         label: "Salon accounts",   title: "Salon accounts",   sub: "Manage salon accounts and set custom pricing.",                   Icon: Store },
  { key: "paymentMethods", label: "Payment methods",  title: "Payment methods",  sub: "The bank accounts shown on salon invoices.",                     Icon: Landmark },
  { key: "invoiceDetails", label: "Invoice details",  title: "Invoice details",  sub: "The business details shown in the “Billed From” section of salon invoices.", Icon: FileText },
  { key: "users",          label: "Users",            title: "Users",            sub: "Every login on the platform — owners, managers, staff and admins.", Icon: UsersIcon },
  { key: "backups",        label: "Backups",          title: "Backups",          sub: "Browse, trigger and restore database backups.",                   Icon: Archive },
  { key: "pointly",        label: "Pointly",          title: "Pointly",          sub: "Accounts, billing and activity for Pointly.",                     Icon: ShoppingCart },
];

export default function AdminPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [filter, setFilter] = useState<PaymentStatus | "all">("all");
  const [tab, setTab] = useState<AdminTab>(() => {
    if (typeof window === "undefined") return "dashboard";
    const t = new URLSearchParams(window.location.search).get("tab");
    return ADMIN_TABS.some((item) => item.key === t) ? (t as AdminTab) : "dashboard";
  });
  // Bumped by Refresh — each panel loads its own data on mount, so remounting
  // it is the simplest way to reload whichever tab is open.
  const [refreshKey, setRefreshKey] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const user = getCurrentUser();
    if (!user || user.role !== "admin") {
      router.replace("/dashboard");
      return;
    }
    queueMicrotask(() => {
      setIsAdmin(true);
      setChecking(false);
      setRequests(getPaymentRequests());
    });
  }, [router]);

  function refresh() {
    setRequests(getPaymentRequests());
  }

  function goTab(next: AdminTab) {
    setTab(next);
    window.history.replaceState(null, "", `?tab=${next}`);
  }

  async function handleSignOut() {
    await signOut();
    window.location.href = "/sign-in";
  }

  if (checking || !isAdmin) return null;

  const filtered = filter === "all" ? requests : requests.filter((r) => r.status === filter);
  const counts = { all: requests.length, pending: requests.filter((r) => r.status === "pending").length, approved: requests.filter((r) => r.status === "approved").length, rejected: requests.filter((r) => r.status === "rejected").length };
  const current = ADMIN_TABS.find((item) => item.key === tab) ?? ADMIN_TABS[0];

  return (
    <div style={{ minHeight: "100vh", background: "#f4f5f7" }}>
      <style>{`
        .ac-btn {
          display: inline-flex; align-items: center; gap: 7px; border-radius: 10px;
          padding: 9px 13px; font-size: 12.5px; font-weight: 700; cursor: pointer;
          border: 1px solid #e4e4ef; background: #fff; color: #43435f; white-space: nowrap;
          font-family: inherit;
        }
        .ac-btn:hover { background: #fafaff; border-color: #d6d6e6; }
        .ac-btn:disabled { opacity: .55; cursor: not-allowed; }
      `}</style>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header style={{
        background: "#0d0d14", padding: "12px 20px", display: "flex", alignItems: "center",
        gap: 14, flexWrap: "wrap", position: "sticky", top: 0, zIndex: 60,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <img src="/salon-central-favicon.png" alt="" style={{ width: 26, height: 26, borderRadius: 7, background: "#fff" }} />
          <span style={{ fontSize: 14, fontWeight: 850, color: "#fff", letterSpacing: "-0.02em" }}>Salon Central</span>
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20,
          background: "rgba(124,58,237,0.16)", border: "1px solid rgba(167,139,250,0.35)",
        }}>
          <Shield size={12} color="#c4b5fd" />
          <span style={{ fontSize: 10.5, fontWeight: 800, color: "#c4b5fd", letterSpacing: "0.07em" }}>ADMIN CONSOLE</span>
        </div>

        <div style={{ flex: 1 }} />

        <button type="button" onClick={handleSignOut} className="ac-btn" style={{
          background: "transparent", border: "1px solid #26263a", color: "#fca5a5",
        }}>
          <LogOut size={13} /> Sign out
        </button>
      </header>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "20px 16px 80px" }}>
        {/* ── Heading ────────────────────────────────────────────────────── */}
        {/* The Pointly tab brings its own heading and Refresh. */}
        {tab !== "pointly" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 900, color: "#1a1a2e", letterSpacing: "-0.04em" }}>
              {current.title}
            </h1>
            <div style={{ fontSize: 12, color: "#9898b0", fontWeight: 600, marginTop: 4 }}>
              {current.sub}
            </div>
          </div>
          <button type="button" className="ac-btn" onClick={() => { refresh(); setRefreshKey((n) => n + 1); }}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        )}

        {/* ── Tabs ───────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: "1px solid #e8e8f2", overflowX: "auto", scrollbarWidth: "none" }}>
          {ADMIN_TABS.map(({ key, label, Icon }) => {
            const count = key === "requests" ? counts.pending : 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => goTab(key)}
                style={{
                  border: "none", background: "transparent", cursor: "pointer", padding: "9px 13px", flexShrink: 0, whiteSpace: "nowrap",
                  display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontFamily: "inherit",
                  fontWeight: 800, color: tab === key ? "#6D28D9" : "#8b8ba3",
                  borderBottom: tab === key ? "2px solid #7C3AED" : "2px solid transparent",
                  marginBottom: -1,
                }}
              >
                <Icon size={14} /> {label}
                {count > 0 && (
                  <span title={`${count} awaiting review`} style={{ fontSize: 10.5, fontWeight: 900, color: "#fff", background: "#b45309", borderRadius: 20, padding: "1px 7px" }}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div key={refreshKey} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {tab === "dashboard" ? (
        <AdminDashboardPanel />
      ) : tab === "requests" ? (
        <>
          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {(["all", "pending", "approved", "rejected"] as const).map((s) => {
              const meta = s === "all" ? { label: "Total", color: "#7C3AED", bg: "#EDE9FE" } : { label: STATUS_META[s].label, color: STATUS_META[s].color, bg: STATUS_META[s].bg };
              return (
                <button key={s} onClick={() => setFilter(s)}
                  style={{ ...ADMIN_CARD, background: filter === s ? meta.bg : "#fff", border: `1px solid ${filter === s ? meta.color : "#ececf4"}`, padding: "14px 16px", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
                  <div style={{ fontSize: 21, fontWeight: 900, color: meta.color, lineHeight: 1.1, letterSpacing: "-0.03em" }}>{counts[s]}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: filter === s ? meta.color : "#8b8ba3", marginTop: 2 }}>{meta.label}</div>
                </button>
              );
            })}
          </div>

          {/* Requests */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.length === 0 ? (
              <div style={{ ...ADMIN_CARD, padding: "56px 20px", textAlign: "center", color: "#9898b0" }}>
                <Clock size={26} style={{ opacity: 0.4 }} />
                <div style={{ fontSize: 13.5, fontWeight: 750, color: "#6b6b8a", marginTop: 10 }}>No {filter === "all" ? "" : filter} requests</div>
              </div>
            ) : (
              filtered.map((req) => <RequestCard key={req.id} req={req} onUpdate={refresh} />)
            )}
          </div>
        </>
      ) : tab === "salons" ? (
        <SalonAccountsPanel />
      ) : tab === "paymentMethods" ? (
        <PaymentMethodsPanel />
      ) : tab === "invoiceDetails" ? (
        <InvoiceDetailsPanel />
      ) : tab === "backups" ? (
        <BackupsPanel />
      ) : tab === "pointly" ? (
        <PointlyConsole />
      ) : (
        <UsersPanel />
      )}
        </div>
      </div>
    </div>
  );
}
