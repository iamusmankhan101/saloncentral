"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check, X, Crown, AlertTriangle, Smartphone, Building2, Copy,
  BadgeCheck, ImagePlus, Clock, Eye, CheckCircle, AlertCircle,
  Zap, Sparkles, Lock, Shield, CreditCard,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { addPaymentRequest, setActivePlan, getPaymentRequests, type PaymentMethod } from "@/lib/payment-requests";
import type { Invoice, InvoiceStatus } from "@/lib/invoices";
import InvoiceViewer from "@/components/invoice-viewer";
import MobilePageHeader from "@/components/mobile-page-header";
import PageTitle from "@/components/page-title";
import {
  PLAN_CONFIGS, ORDERED_PLANS, getCurrentPlanId,
  type PlanId, type PlanConfig,
} from "@/lib/plan-limits";
import { DEFAULT_BANK_DETAILS } from "@/lib/billing-constants";

// ─── Constants ────────────────────────────────────────────────────────────────

const EP_DETAILS  = { name: "Muhammad Usman Khan", phone: "03058562523" };
const CONTACT_SALES_URL = "https://wa.me/+923058562523?text=Hi%2C%20I%27m%20interested%20in%20a%20Salon%20Central%20plan.";
const DEMO_DAYS = 7;

const STATUS_META: Record<InvoiceStatus, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  paid:    { label: "Paid",    color: "#059669", bg: "#ecfdf5", icon: CheckCircle },
  unpaid:  { label: "Unpaid",  color: "#d97706", bg: "#fffbeb", icon: Clock },
  overdue: { label: "Overdue", color: "#dc2626", bg: "#fef2f2", icon: AlertCircle },
};

const PLAN_ICONS: Record<PlanId, React.ElementType> = {
  free:    Sparkles,
  starter: Building2,
  pro:     Zap,
  premium: Crown,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-PK", { year: "numeric", month: "short", day: "numeric" });
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function termLabel(months: number) {
  return `${months} month${months === 1 ? "" : "s"}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EasypaisaLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="40" height="40" rx="10" fill="#2DC84D" />
      <text x="20" y="27" textAnchor="middle" fontSize="20" fontWeight="900" fontFamily="Arial,sans-serif" fill="#fff">e</text>
    </svg>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f4f5f7", borderRadius: 8, padding: "9px 12px" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{value}</span>
        <button onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 6, color: copied ? "#059669" : "#9898b0" }}>
          {copied ? <BadgeCheck size={13} /> : <Copy size={13} />}
          <span style={{ fontSize: 10, fontWeight: 700 }}>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </div>
  );
}

// ─── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({
  plan, isCurrent, isPopular, hidePricing, onDowngrade, salonPrice, salonTermMonths = 1,
}: {
  plan: PlanConfig;
  isCurrent: boolean;
  isPopular: boolean;
  hidePricing?: boolean;
  onDowngrade: () => void;
  /**
   * What this salon actually pays for the plan (its billing record's term
   * price, which an admin can set per salon). Only passed for the current plan —
   * the other cards show the standard list price.
   */
  salonPrice?: number | null;
  salonTermMonths?: number;
}) {
  const Icon = PLAN_ICONS[plan.id];
  const shownPrice = salonPrice && salonPrice > 0 ? salonPrice : plan.price;
  const priceSuffix = salonPrice && salonPrice > 0 && salonTermMonths > 1 ? `/ ${termLabel(salonTermMonths)}` : "/ month";

  return (
    <div style={{
      background: "#fff",
      borderRadius: 20,
      border: `2px solid ${isCurrent ? plan.color : isPopular ? plan.color + "40" : "#ebebf0"}`,
      padding: 0,
      display: "flex",
      flexDirection: "column",
      position: "relative",
      overflow: "hidden",
      boxShadow: isCurrent ? `0 6px 28px ${plan.color}22` : isPopular ? `0 4px 20px ${plan.color}14` : "none",
      transition: "transform 0.15s",
    }}>
      {/* Popular / Current ribbon */}
      {(isCurrent || isPopular) && (
        <div style={{
          position: "absolute", top: 0, right: 0,
          background: isCurrent ? plan.color : plan.color + "cc",
          color: "#fff",
          fontSize: 10, fontWeight: 800,
          padding: "5px 14px 5px 20px",
          borderRadius: "0 18px 0 14px",
          letterSpacing: "0.07em",
        }}>
          {isCurrent ? "CURRENT" : "POPULAR"}
        </div>
      )}

      {/* Header */}
      <div style={{ background: plan.gradient, padding: "22px 24px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon size={19} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Salon Central</div>
            <div style={{ fontSize: 19, fontWeight: 900, color: "#fff", lineHeight: 1 }}>{plan.name}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          {plan.price === 0
            ? <span style={{ fontSize: 34, fontWeight: 900, color: "#fff" }}>Free</span>
            : hidePricing
              ? <span style={{ fontSize: 24, fontWeight: 900, color: "#fff" }}>Contact Sales</span>
            : <>
                <span style={{ fontSize: 14, fontWeight: 800, color: "rgba(255,255,255,0.82)" }}>PKR</span>
                <span style={{ fontSize: 34, fontWeight: 900, color: "#fff", letterSpacing: "-1px" }}>{shownPrice.toLocaleString("en-PK")}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.72)" }}>{priceSuffix}</span>
              </>
          }
        </div>
      </div>

      {/* Features */}
      <div style={{ padding: "18px 22px", flex: 1, display: "flex", flexDirection: "column", gap: 0 }}>
        {plan.features.map(f => (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0", borderBottom: "1px solid #f8f8fc" }}>
            <div style={{ width: 18, height: 18, borderRadius: "50%", background: plan.color + "18", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Check size={10} color={plan.color} />
            </div>
            <span style={{ fontSize: 12, color: "#4a4a6a" }}>{f}</span>
          </div>
        ))}
        {plan.lockedFeatures.map(f => (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0", borderBottom: "1px solid #f8f8fc", opacity: 0.45 }}>
            <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#e8e8f0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Lock size={9} color="#9898b0" />
            </div>
            <span style={{ fontSize: 12, color: "#9898b0" }}>{f}</span>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div style={{ padding: "0 22px 20px" }}>
        {isCurrent ? (
          <div style={{ padding: "11px 0", borderRadius: 12, border: `1.5px solid ${plan.color}40`, background: plan.bg, fontSize: 13, fontWeight: 700, color: plan.color, textAlign: "center" }}>
            ✓ Your current plan
          </div>
        ) : plan.price === 0 ? (
          <button onClick={onDowngrade}
            style={{ width: "100%", padding: "11px 0", borderRadius: 12, border: "1.5px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}>
            Downgrade to Free
          </button>
        ) : (
          <a href={CONTACT_SALES_URL} target="_blank" rel="noopener noreferrer"
            style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: plan.gradient, fontSize: 13, fontWeight: 800, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: `0 4px 16px ${plan.color}40` }}>
            <Smartphone size={14} /> Contact Sales
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const [activePlanId, setActivePlanId] = useState<PlanId>(() => getCurrentPlanId());
  const [showModal,    setShowModal]    = useState<PlanId | null>(null);
  const [payMethod,    setPayMethod]    = useState<PaymentMethod>("easypaisa");
  const [screenshot,   setScreenshot]  = useState<{ base64: string; name: string } | null>(null);
  const [submitting,   setSubmitting]  = useState(false);
  const [submitted,    setSubmitted]   = useState(false);
  const [hasPending,   setHasPending]  = useState(false);
  const [invoices,     setInvoices]    = useState<Invoice[]>([]);
  const [viewInvoice,  setViewInvoice] = useState<Invoice | null>(null);
  const [actualPrice,  setActualPrice] = useState<number | null>(null);
  const [billingTermMonths, setBillingTermMonths] = useState(1);
  const [trialStart,   setTrialStart]  = useState<string | null>(null);
  const [isDemoSignup, setIsDemoSignup] = useState(false);
  const [planLoaded,   setPlanLoaded]  = useState(false);
  const [bankDetails,  setBankDetails] = useState(DEFAULT_BANK_DETAILS);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const user = getCurrentUser();
    if (!user) return;

    // Fetch authoritative plan from database
    fetch(`/api/billing/user?userId=${user.id}`)
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          const planId = data.planId as PlanId;
          setActivePlanId(planId);
          // Admin may have set a custom negotiated price for this salon —
          // prefer it over the static plan-tier price when displaying.
          if (typeof data.planPrice === "number") setActualPrice(data.planPrice);
          if (typeof data.billingTermMonths === "number") setBillingTermMonths(Math.max(1, Math.floor(data.billingTermMonths)));
          if (typeof data.trialStart === "string") setTrialStart(data.trialStart);
          setIsDemoSignup(data.isDemoSignup === true);
          if (data.bankTitle && data.bankAccountNumber && data.bankIban) {
            setBankDetails({ bankName: data.bankName ?? "", title: data.bankTitle, accountNumber: data.bankAccountNumber, iban: data.bankIban });
          }

          // Also update localStorage for backward compatibility
          if (planId !== "free") {
            setActivePlan(planId);
          }
        }
      })
      .catch(err => {
        console.error("[billing] Failed to fetch user plan:", err);
        // Fallback to localStorage
        setActivePlanId(getCurrentPlanId());
      })
      .finally(() => setPlanLoaded(true));

    // Fetch authoritative invoice history from the billing database — this is
    // the same table the admin-approval flow marks paid, so it always
    // reflects real payment status instead of a locally-recomputed guess.
    fetch(`/api/billing/invoices?userId=${user.id}`)
      .then(res => res.json())
      .then(data => {
        if (data.ok) setInvoices(data.invoices);
      })
      .catch(err => console.error("[billing] Failed to fetch invoices:", err));

    queueMicrotask(() => {
      setHasPending(getPaymentRequests().some(r => r.userId === user.id && r.status === "pending"));
    });
  }, [submitted]);

  const currentPlan = PLAN_CONFIGS[activePlanId];
  const displayPrice = actualPrice ?? currentPlan.price;
  const billingTermText = termLabel(billingTermMonths);
  const demoEndsAt = trialStart ? addDays(trialStart, DEMO_DAYS) : null;
  // Only accounts that actually picked "7-Day Demo" at sign-up get the demo
  // window — someone who paid for Starter/Pro/Premium directly is billed
  // from day one and should never see "no pricing shown" hide their price.
  const isDemoActive = isDemoSignup && !!demoEndsAt && new Date().toISOString().slice(0, 10) < demoEndsAt;
  // Until the authoritative plan/trial data has loaded, assume pricing should
  // stay hidden rather than flashing real prices for accounts that turn out
  // to be in an active demo window.
  const hidePricing = !planLoaded || isDemoActive;
  const currentPlanSubtitle = !planLoaded
    ? "Loading plan…"
    : isDemoActive
      ? `7-day demo active until ${fmtDate(demoEndsAt)}`
      : displayPrice === 0
        ? "Free forever · no billing"
        : billingTermMonths === 1
          ? `PKR ${displayPrice.toLocaleString("en-PK")} for 1 month`
          : `PKR ${displayPrice.toLocaleString("en-PK")} for ${billingTermText}`;
  const desktopPlanSubtitle = !planLoaded
    ? "Loading plan…"
    : isDemoActive
    ? `7-day demo active until ${fmtDate(demoEndsAt)} · no pricing shown`
    : displayPrice === 0
      ? "Free forever · no billing"
      : `PKR ${displayPrice.toLocaleString("en-PK")} for ${billingTermText} · billed every ${billingTermText}`;
  const upgradePlan = showModal ? PLAN_CONFIGS[showModal] : null;
  const latestInvoice = invoices[0];

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setScreenshot({ base64: reader.result as string, name: file.name });
    reader.readAsDataURL(file);
  }

  function handleSubmit() {
    if (!upgradePlan) return;
    const user = getCurrentUser();
    setSubmitting(true);
    addPaymentRequest({
      userId:            user?.id ?? "guest",
      userEmail:         user?.email ?? "",
      userName:          user?.ownerName ?? "",
      salonName:         user?.salonName ?? "",
      planId:            upgradePlan.id,
      planName:          upgradePlan.label,
      amount:            upgradePlan.price,
      payMethod,
      screenshotBase64:  screenshot?.base64 ?? null,
      screenshotName:    screenshot?.name ?? null,
    });
    setTimeout(() => {
      setSubmitting(false);
      setSubmitted(true);
      setHasPending(true);
      setTimeout(() => { setSubmitted(false); setShowModal(null); setScreenshot(null); }, 2000);
    }, 800);
  }

  function handleDowngrade() {
    setActivePlan("free");
    setActivePlanId("free");
  }

  const COMPARISON_ROWS: Array<{ feature: string } & Record<(typeof ORDERED_PLANS)[number], string>> = [
    { feature: "Appointments",           starter: "Unlimited",     pro: "Unlimited",     premium: "Unlimited" },
    { feature: "Staff members",          starter: "Unlimited",     pro: "Unlimited",     premium: "Unlimited" },
    { feature: "Clients",                starter: "Unlimited",     pro: "Unlimited",     premium: "Unlimited" },
    { feature: "POS products",           starter: "Unlimited",     pro: "Unlimited",     premium: "Unlimited" },
    { feature: "Invoicing",              starter: "✓",             pro: "✓",             premium: "✓" },
    { feature: "Revenue analytics",      starter: "Full",          pro: "Full",          premium: "Full" },
    { feature: "Inventory",              starter: "Full",          pro: "Full",          premium: "Full" },
    { feature: "WhatsApp automation",    starter: "—",             pro: "✓",             premium: "✓" },
    { feature: "Virtual Try-On (AI)",    starter: "—",             pro: "—",             premium: "✓" },
    { feature: "Multi-location branches", starter: "—",            pro: "—",             premium: "✓" },
    { feature: "Price",                  starter: "Contact Sales", pro: "Contact Sales", premium: "Contact Sales" },
  ];

  return (
    <div className="dashboard-polish" style={{ background: "#f4f5f7", minHeight: "100vh" }}>

      {/* Shared overlays */}
      {viewInvoice && <InvoiceViewer invoice={viewInvoice} onClose={() => setViewInvoice(null)} bankDetails={bankDetails} />}

      {/* ── Payment modal (bottom-sheet on mobile) ── */}
      {showModal && upgradePlan && (
        <div onClick={() => setShowModal(null)} className="modal-overlay" style={{ zIndex: 100 }}>
          <div onClick={e => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 22, width: 490, boxShadow: "0 28px 80px rgba(0,0,0,0.25)", overflowX: "hidden", maxHeight: "94vh", overflowY: "auto" }}>

            {/* Modal header */}
            <div style={{ background: upgradePlan.gradient, padding: "22px 26px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {(() => { const Icon = PLAN_ICONS[upgradePlan.id]; return <Icon size={20} color="#fff" />; })()}
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Upgrade to</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>
                    {upgradePlan.label} — PKR {upgradePlan.price.toLocaleString("en-PK")}
                    <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.75 }}>/mo</span>
                  </div>
                </div>
              </div>
              <button onClick={() => setShowModal(null)} style={{ background: "rgba(255,255,255,0.2)", border: "none", cursor: "pointer", padding: 7, borderRadius: 9, display: "flex" }}>
                <X size={16} color="#fff" />
              </button>
            </div>

            <div style={{ padding: "22px 26px", display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ padding: "12px 14px", borderRadius: 10, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 12, color: "#92400e", lineHeight: 1.6 }}>
                Send <strong>PKR {upgradePlan.price.toLocaleString("en-PK")}</strong> to either account below, attach your payment screenshot, then click Submit. Your plan will be activated once verified by admin (usually within a few hours).
              </div>

              {/* Payment method tabs */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {([
                  { id: "easypaisa" as const, label: "EasyPaisa", color: "#2DC84D", bg: "#f0fdf4" },
                  { id: "bank"      as const, label: "Bank Transfer", color: "#0369a1", bg: "#e0f2fe" },
                ]).map(({ id, label, color, bg }) => (
                  <button key={id} type="button" onClick={() => setPayMethod(id)}
                    style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderRadius: 12, border: `2px solid ${payMethod === id ? color : "#e8e8f0"}`, background: payMethod === id ? bg : "#fafafd", cursor: "pointer" }}>
                    {id === "easypaisa" ? <EasypaisaLogo size={26} /> : (
                      <div style={{ width: 26, height: 26, borderRadius: 7, background: payMethod === id ? color + "20" : "#f0f0f8", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Building2 size={13} color={payMethod === id ? color : "#b0b0c8"} />
                      </div>
                    )}
                    <span style={{ fontSize: 13, fontWeight: 700, color: payMethod === id ? color : "#6b6b8a" }}>{label}</span>
                  </button>
                ))}
              </div>

              {/* EasyPaisa details */}
              {payMethod === "easypaisa" && (
                <div style={{ borderRadius: 12, border: "1px solid #bbf7d0", background: "#f0fdf4", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <EasypaisaLogo size={34} />
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#065f46" }}>EasyPaisa</div>
                      <div style={{ fontSize: 11, color: "#6b9e7e" }}>Send payment to this account</div>
                    </div>
                  </div>
                  <CopyField label="Account Name" value={EP_DETAILS.name} />
                  <CopyField label="Mobile Number" value={EP_DETAILS.phone} />
                </div>
              )}

              {/* Bank details */}
              {payMethod === "bank" && (
                <div style={{ borderRadius: 12, border: "1px solid #bae6fd", background: "#eff6ff", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: "#dbeafe", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Building2 size={16} color="#0369a1" />
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#0c4a6e" }}>Bank Transfer</div>
                      <div style={{ fontSize: 11, color: "#6b8fa8" }}>Transfer to this account</div>
                    </div>
                  </div>
                  {bankDetails.bankName && <CopyField label="Bank Name" value={bankDetails.bankName} />}
                  <CopyField label="Account Title" value={bankDetails.title} />
                  <CopyField label="Account Number" value={bankDetails.accountNumber} />
                  <CopyField label="IBAN" value={bankDetails.iban} />
                </div>
              )}

              {/* Screenshot upload */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Payment Screenshot</div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
                {screenshot ? (
                  <div style={{ borderRadius: 12, border: "1px solid #d1d5db", overflow: "hidden", position: "relative" }}>
                    <img src={screenshot.base64} alt="Payment screenshot" style={{ width: "100%", maxHeight: 200, objectFit: "cover", display: "block" }} />
                    <button onClick={() => setScreenshot(null)}
                      style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.55)", border: "none", borderRadius: "50%", width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                      <X size={13} color="#fff" />
                    </button>
                    <div style={{ padding: "8px 12px", background: "#f9fafb", borderTop: "1px solid #e5e7eb", fontSize: 11, color: "#6b7280", display: "flex", alignItems: "center", gap: 6 }}>
                      <BadgeCheck size={13} color="#059669" />{screenshot.name}
                    </div>
                  </div>
                ) : (
                  <button onClick={() => fileRef.current?.click()}
                    style={{ width: "100%", padding: "22px", borderRadius: 12, border: "2px dashed #d1d5db", background: "#fafafa", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: "#f0f0f8", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <ImagePlus size={18} color="#9898b0" />
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#6b6b8a" }}>Click to attach screenshot</div>
                    <div style={{ fontSize: 11, color: "#b0b0c8" }}>PNG, JPG, WEBP supported</div>
                  </button>
                )}
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setShowModal(null)} style={{ flex: 1, padding: "12px 0", borderRadius: 11, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
                <button onClick={handleSubmit} disabled={submitting || submitted}
                  style={{ flex: 2, padding: "12px 0", borderRadius: 11, border: "none", background: submitted ? "#ecfdf5" : submitting ? "#e8e8f0" : upgradePlan.gradient, fontSize: 13, fontWeight: 700, color: submitted ? "#059669" : submitting ? "#aaaabc" : "#fff", cursor: submitting ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                  {submitted ? <><BadgeCheck size={15} /> Submitted!</> : submitting ? "Submitting…" : "Submit Payment Request"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ MOBILE LAYOUT ══════════ */}

      {/* Mobile app bar */}
      <MobilePageHeader
        title="Billing & Plans"
        subtitle={currentPlan.label}
      />

      {/* Mobile current plan card */}
      <div className="mobile-only" style={{ margin: "12px 16px 0" }}>
        <div style={{ background: currentPlan.gradient, borderRadius: 20, padding: "20px 22px", boxShadow: `0 8px 28px ${currentPlan.color}28` }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Active Plan</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
            <div style={{ width: 50, height: 50, borderRadius: 14, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {(() => { const Icon = PLAN_ICONS[activePlanId]; return <Icon size={22} color="#fff" />; })()}
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 900, color: "#fff", lineHeight: 1.1 }}>{currentPlan.label}</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.78)", marginTop: 3 }}>
                {currentPlanSubtitle}
              </div>
            </div>
          </div>
          {latestInvoice && (
            <button onClick={() => setViewInvoice(latestInvoice)}
              style={{ width: "100%", padding: "10px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.15)", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Eye size={14} /> View Latest Invoice
            </button>
          )}
        </div>
      </div>

      {/* Mobile alert banners */}
      {hasPending && (
        <div className="mobile-alert-banner mobile-only" style={{ background: "#eff6ff", border: "1px solid #bae6fd", color: "#0c4a6e" }}>
          <Clock size={16} color="#0369a1" style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>
            Payment under admin review. Plan upgrades once verified.
          </div>
        </div>
      )}
      {latestInvoice && latestInvoice.status !== "paid" && (
        <div
          className="mobile-alert-banner mobile-only"
          style={{ background: latestInvoice.status === "overdue" ? "#fef2f2" : "#fffbeb", border: `1px solid ${latestInvoice.status === "overdue" ? "#fecaca" : "#fde68a"}`, color: latestInvoice.status === "overdue" ? "#991b1b" : "#92400e", cursor: "pointer" }}
          onClick={() => setViewInvoice(latestInvoice)}
        >
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>
            Invoice {latestInvoice.number} · PKR {latestInvoice.total.toLocaleString("en-PK")} is {latestInvoice.status === "overdue" ? "overdue" : `due ${fmtDate(latestInvoice.dueDate)}`}
          </div>
          <Eye size={14} style={{ flexShrink: 0 }} />
        </div>
      )}

      {/* Mobile plan cards — horizontal swipeable carousel */}
      <div className="mobile-only">
        <div className="mobile-section-header">Choose Your Plan</div>
        <div style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 16px 16px", scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
          {ORDERED_PLANS.map(planId => (
            <div key={planId} style={{ flexShrink: 0, width: "78vw", maxWidth: 320, scrollSnapAlign: "start" }}>
              <PlanCard
                plan={PLAN_CONFIGS[planId]}
                isCurrent={planId === activePlanId}
                isPopular={planId === "pro"}
                hidePricing={hidePricing}
                onDowngrade={handleDowngrade}
                salonPrice={planId === activePlanId ? actualPrice : null}
                salonTermMonths={billingTermMonths}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Mobile feature comparison — horizontally scrollable */}
      <div className="mobile-only">
        <div className="mobile-section-header" style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Shield size={13} color="#9898b0" /> Feature Comparison
        </div>
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", paddingLeft: 16, scrollbarWidth: "none" }}>
          <div style={{ minWidth: 460, marginRight: 16, background: "#fff", borderRadius: 16, border: "1px solid #ebebf0", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: `1.4fr repeat(${ORDERED_PLANS.length}, 1fr)`, padding: "10px 14px", background: "#f4f4fc", borderBottom: "1px solid #f0f0f8" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#9898b0", textTransform: "uppercase" }}>Feature</div>
              {ORDERED_PLANS.map(p => (
                <div key={p} style={{ fontSize: 10, fontWeight: 800, color: PLAN_CONFIGS[p].color, textTransform: "uppercase" }}>{PLAN_CONFIGS[p].name}</div>
              ))}
            </div>
            {COMPARISON_ROWS.map((row, i) => (
              <div key={row.feature} style={{ display: "grid", gridTemplateColumns: `1.4fr repeat(${ORDERED_PLANS.length}, 1fr)`, padding: "10px 14px", background: i % 2 === 0 ? "#fff" : "#fafafd", borderBottom: "1px solid #f4f4f8", alignItems: "center" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#3a3a5a" }}>{row.feature}</div>
                {ORDERED_PLANS.map((planId) => {
                  const val = row[planId];
                  return (
                  <div key={planId} style={{ fontSize: 11, fontWeight: val === "—" ? 400 : 600, color: val === "—" ? "#c8c8d8" : val === "✓" || val === "Full" || val === "Unlimited" ? "#059669" : "#4a4a6a" }}>
                    {val}
                  </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile invoice history */}
      {invoices.length > 0 && (
        <div className="mobile-only">
          <div className="mobile-section-header">Invoice History</div>
          <div className="mobile-list" style={{ padding: "0 16px 24px" }}>
            {invoices.map((inv) => {
              const sm = STATUS_META[inv.status];
              const Icon = sm.icon;
              return (
                <div key={inv.id} className="mobile-list-card" onClick={() => setViewInvoice(inv)}>
                  <div className="mobile-list-icon" style={{ background: sm.bg }}>
                    <Icon size={18} color={sm.color} />
                  </div>
                  <div className="mobile-list-body">
                    <div className="mobile-list-title">{inv.number}</div>
                    {inv.periodStart && inv.periodEnd && (
                      <div className="mobile-list-sub">{fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}</div>
                    )}
                    <div className="mobile-list-sub">Issued {fmtDate(inv.issuedDate)} · Due {fmtDate(inv.dueDate)}</div>
                  </div>
                  <div className="mobile-list-right">
                    <div className="mobile-list-amount" style={{ color: "#7C3AED" }}>PKR {inv.total.toLocaleString("en-PK")}</div>
                    <span className="mobile-badge" style={{ background: sm.bg, color: sm.color }}>
                      {sm.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══════════ DESKTOP LAYOUT ══════════ */}
      <div className="dash-page desktop-only" style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 24 }}>

        {/* Page header */}
        <PageTitle
          icon={<CreditCard size={24} />}
          title="Billing & Plans"
          subtitle="Manage your subscription and view invoice history"
        />

        {/* Pending notice */}
        {hasPending && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", background: "#eff6ff", border: "1px solid #bae6fd", borderRadius: 12 }}>
            <Clock size={16} color="#0369a1" />
            <div style={{ fontSize: 13, color: "#0c4a6e" }}>
              You have a <strong>pending payment request</strong> under admin review. Your plan will be upgraded once payment is verified.
            </div>
          </div>
        )}

        {/* Current plan banner */}
        <div style={{ background: currentPlan.gradient, borderRadius: 18, padding: "24px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 52, height: 52, borderRadius: 15, background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {(() => { const Icon = PLAN_ICONS[activePlanId]; return <Icon size={24} color="#fff" />; })()}
            </div>
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em" }}>Active Plan</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", marginTop: 2 }}>{currentPlan.label}</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 3 }}>
                {desktopPlanSubtitle}
              </div>
            </div>
          </div>
          {latestInvoice && (
            <button onClick={() => setViewInvoice(latestInvoice)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.15)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
              <Eye size={14} /> Latest Invoice
            </button>
          )}
        </div>

        {/* Overdue invoice alert */}
        {latestInvoice && latestInvoice.status !== "paid" && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", background: latestInvoice.status === "overdue" ? "#fef2f2" : "#fffbeb", border: `1px solid ${latestInvoice.status === "overdue" ? "#fecaca" : "#fde68a"}`, borderRadius: 12 }}>
            <AlertTriangle size={16} color={latestInvoice.status === "overdue" ? "#dc2626" : "#d97706"} />
            <div style={{ fontSize: 13, color: latestInvoice.status === "overdue" ? "#991b1b" : "#92400e" }}>
              Invoice <strong>{latestInvoice.number}</strong> of <strong>PKR {latestInvoice.total.toLocaleString("en-PK")}</strong> is{" "}
              {latestInvoice.status === "overdue" ? <strong>overdue</strong> : <>due on <strong>{fmtDate(latestInvoice.dueDate)}</strong></>}.{" "}
              <button onClick={() => setViewInvoice(latestInvoice)} style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 700, textDecoration: "underline", fontSize: 13, color: "inherit", padding: 0 }}>View invoice →</button>
            </div>
          </div>
        )}

        {/* Pricing plans */}
        <div>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#1a1a2e", marginBottom: 6 }}>Choose Your Plan</div>
          <div style={{ fontSize: 13, color: "#9898b0", marginBottom: 18 }}>Upgrade anytime — pay via EasyPaisa or bank transfer</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {ORDERED_PLANS.map(planId => (
              <PlanCard
                key={planId}
                plan={PLAN_CONFIGS[planId]}
                isCurrent={planId === activePlanId}
                isPopular={planId === "pro"}
                hidePricing={hidePricing}
                onDowngrade={handleDowngrade}
                salonPrice={planId === activePlanId ? actualPrice : null}
                salonTermMonths={billingTermMonths}
              />
            ))}
          </div>
        </div>

        {/* Feature comparison table */}
        <div style={{ background: "#fff", borderRadius: 18, border: "1px solid #ebebf0", overflow: "hidden" }}>
          <div style={{ padding: "18px 24px 14px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", gap: 10 }}>
            <Shield size={18} color="#7C3AED" />
            <div style={{ fontWeight: 800, fontSize: 15, color: "#1a1a2e" }}>Feature Comparison</div>
          </div>
          {COMPARISON_ROWS.map((row, i) => (
            <div key={row.feature} style={{ display: "grid", gridTemplateColumns: `1fr repeat(${ORDERED_PLANS.length}, 1fr)`, padding: "11px 24px", background: i % 2 === 0 ? "#fff" : "#fafafd", borderBottom: "1px solid #f4f4f8", alignItems: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#3a3a5a" }}>{row.feature}</div>
              {ORDERED_PLANS.map((planId) => {
                const val = row[planId];
                return (
                <div key={planId} style={{ fontSize: 12, color: val === "—" ? "#c8c8d8" : val.startsWith("✓") || val === "Full" || val === "Unlimited" ? "#059669" : "#4a4a6a", fontWeight: val === "—" ? 400 : 600 }}>
                  {val}
                </div>
                );
              })}
            </div>
          ))}
          <div style={{ display: "grid", gridTemplateColumns: `1fr repeat(${ORDERED_PLANS.length}, 1fr)`, padding: "11px 24px", background: "#f4f4fc" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Feature</div>
            {ORDERED_PLANS.map(p => (
              <div key={p} style={{ fontSize: 11, fontWeight: 800, color: PLAN_CONFIGS[p].color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {PLAN_CONFIGS[p].name}
              </div>
            ))}
          </div>
        </div>

        {/* Invoice history */}
        {invoices.length > 0 && (
          <div style={{ background: "#fff", borderRadius: 18, border: "1px solid #ebebf0", overflow: "hidden" }}>
            <div style={{ padding: "18px 24px 14px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: "#1a1a2e" }}>Invoice History</div>
              <div style={{ fontSize: 12, color: "#9898b0" }}>Generated every {billingTermText}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px 110px 100px 48px", padding: "10px 24px", borderBottom: "1px solid #f0f0f8", background: "#fafafa" }}>
              {["INVOICE", "ISSUED", "DUE DATE", "AMOUNT", "STATUS", ""].map(h => (
                <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#b0b0c8", letterSpacing: "0.08em" }}>{h}</div>
              ))}
            </div>
            {invoices.map((inv, i) => {
              const sm = STATUS_META[inv.status];
              const Icon = sm.icon;
              return (
                <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px 110px 100px 48px", padding: "13px 24px", borderBottom: i < invoices.length - 1 ? "1px solid #f4f4f8" : "none", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>{inv.number}</div>
                    {inv.periodStart && inv.periodEnd && (
                      <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}</div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#6b6b8a" }}>{fmtDate(inv.issuedDate)}</div>
                  <div style={{ fontSize: 12, color: "#6b6b8a" }}>{fmtDate(inv.dueDate)}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>PKR {inv.total.toLocaleString("en-PK")}</div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, background: sm.bg, fontSize: 11, fontWeight: 700, color: sm.color }}>
                    <Icon size={10} /> {sm.label}
                  </div>
                  <button onClick={() => setViewInvoice(inv)}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 8, border: "1px solid #e8e8f0", background: "#fff", cursor: "pointer" }}>
                    <Eye size={13} color="#9898b0" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>{/* /desktop-only */}
    </div>
  );
}
