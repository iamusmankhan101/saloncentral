"use client";

/**
 * The console's Billing tab: who has paid, who is due, what the platform is
 * collecting, and the form for recording a payment. Everything is read from
 * and written through /api/admin/billing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Ban, CalendarClock, CheckCircle2, Clock, Download, MessageCircle,
  Plus, Receipt, Search, Tag, TrendingUp, Wallet,
} from "lucide-react";
import { Modal, Pill, StatCard } from "./ui";
import { PLAN_IDS, PLANS, planPriceLabel, type PlanId } from "@/lib/pointly/plans";
import {
  billingStatus, cycleLabel, daysBetween, durationLabel, MAX_PAYMENT_DAYS, MAX_PAYMENT_MONTHS, monthlyPrice,
  nextPeriodStart, PAYMENT_METHODS, PAYMENT_MONTH_OPTIONS, periodEnd, priceForPeriod, todayIso, whatsAppNumber,
  type BillingAccount, type BillingStatus, type BillingSummary, type PeriodLength, type SubscriptionPayment,
} from "@/lib/pointly/billing";

type Toast = (toast: { tone: "ok" | "bad"; text: string }) => void;
type StatusFilter = "all" | BillingStatus;

const STATUS_STYLE: Record<BillingStatus, { label: string; color: string; bg: string }> = {
  paid:         { label: "Paid",       color: "#047857", bg: "#ecfdf5" },
  "due-soon":   { label: "Due soon",   color: "#b45309", bg: "#fffbeb" },
  overdue:      { label: "Overdue",    color: "#b91c1c", bg: "#fef2f2" },
  "never-paid": { label: "Never paid", color: "#6b6b8a", bg: "#f3f4f6" },
};

const PLAN_STYLE: Record<PlanId, { color: string; bg: string }> = {
  starter: { color: "#6b6b8a", bg: "#f3f4f6" },
  pro:     { color: "#c2410c", bg: "#fff7ed" },
};

function pkr(amount: number): string {
  return `PKR ${Math.round(amount).toLocaleString("en-US")}`;
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "Paid until" is exclusive, so the last covered day is the one before it. */
function lastCoveredDay(paidUntil: string): string {
  const [y, m, d] = paidUntil.split("-").map(Number);
  return todayIso(new Date(y, m - 1, d - 1));
}

function dueLine(account: BillingAccount): string {
  if (account.daysLeft === null) return "No payment recorded";
  if (account.daysLeft <= 0) {
    const late = -account.daysLeft;
    return late === 0 ? "Due today" : `${late} day${late === 1 ? "" : "s"} overdue`;
  }
  return `${account.daysLeft} day${account.daysLeft === 1 ? "" : "s"} left`;
}

function reminderLink(account: BillingAccount): string | null {
  const number = whatsAppNumber(account.phone);
  if (!number) return null;
  const plan = PLANS[account.plan];
  const name = account.ownerName?.split(" ")[0] || "there";
  const renewal = cycleLabel(account.monthlyPricePkr, account.billingCycleMonths);
  const when = account.paidUntil
    ? account.daysLeft !== null && account.daysLeft <= 0
      ? `ended on ${fmtDay(lastCoveredDay(account.paidUntil))}`
      : `runs until ${fmtDay(lastCoveredDay(account.paidUntil))}`
    : "is ready to start";
  const message =
    `Hi ${name}, this is Pointly. Your ${plan.name} subscription for ${account.businessName} ${when}. ` +
    `The renewal is ${renewal}. Reply here once you've paid and we'll update your account. Thank you!`;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

function downloadCsv(filename: string, rows: Record<string, string | number>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (value: string | number) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.map(escape).join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const label = { display: "block", fontSize: 11, fontWeight: 800, color: "#6b6b8a", marginBottom: 6, letterSpacing: "0.04em", textTransform: "uppercase" } as const;

type DurationUnit = "months" | "days" | "until";

interface RecordDraft {
  ownerId: string;
  plan: PlanId;
  unit: DurationUnit;
  /** Months or days, as typed. */
  count: string;
  /** Last day covered, for unit "until". */
  until: string;
  amount: string;
  method: string;
  paidAt: string;
  reference: string;
  note: string;
}

/** The monthly price a draft is charged at: the account's own price for its plan, else list. */
function draftMonthly(draft: Pick<RecordDraft, "plan">, account: BillingAccount | undefined): number {
  return monthlyPrice(PLANS[draft.plan].pricePkr, account && account.plan === draft.plan ? account.customPricePkr : null);
}

/**
 * The period a draft buys, or null while it's incomplete. "Until" is turned
 * into days from where the period will start, so it lands on exactly that day.
 */
function draftLength(draft: RecordDraft, account: BillingAccount | undefined): PeriodLength | null {
  const n = Number(draft.count);
  if (draft.unit === "months") return Number.isInteger(n) && n >= 1 && n <= MAX_PAYMENT_MONTHS ? { months: n } : null;
  if (draft.unit === "days") return Number.isInteger(n) && n >= 1 && n <= MAX_PAYMENT_DAYS ? { days: n } : null;
  if (!draft.until || !draft.paidAt) return null;
  const start = nextPeriodStart(account?.paidUntil ?? null, draft.paidAt);
  const days = daysBetween(start, draft.until) + 1;
  return days >= 1 && days <= MAX_PAYMENT_DAYS ? { days } : null;
}

/** Re-prices a draft after its account, plan or duration changed. */
function repriced(draft: RecordDraft, account: BillingAccount | undefined): RecordDraft {
  const length = draftLength(draft, account);
  return length ? { ...draft, amount: String(priceForPeriod(draftMonthly(draft, account), length)) } : draft;
}

function draftFor(account: BillingAccount | undefined): RecordDraft {
  const plan = account?.plan ?? "starter";
  return repriced({
    ownerId: account?.id ?? "",
    plan,
    unit: "months",
    count: String(account?.billingCycleMonths ?? 1),
    until: "",
    amount: "",
    method: "Bank transfer",
    paidAt: todayIso(),
    reference: "",
    note: "",
  }, account);
}

interface TermsDraft {
  ownerId: string;
  useCustom: boolean;
  price: string;
  cycle: string;
}

export default function BillingTab({ refreshKey, recordRequest, onToast }: {
  /** Bumped by the console's Refresh button. */
  refreshKey: number;
  /** Set from the Accounts tab's row menu to open the payment form (or the pricing dialog) on one account. */
  recordRequest: { ownerId: string; nonce: number; kind?: "payment" | "terms" } | null;
  onToast: Toast;
}) {
  const [accounts, setAccounts] = useState<BillingAccount[]>([]);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [payments, setPayments] = useState<SubscriptionPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [view, setView] = useState<"accounts" | "payments">("accounts");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [draft, setDraft] = useState<RecordDraft | null>(null);
  const [terms, setTerms] = useState<TermsDraft | null>(null);
  const [voidFor, setVoidFor] = useState<SubscriptionPayment | null>(null);
  const [voidReason, setVoidReason] = useState("");

  type Overview = { accounts: BillingAccount[]; summary: BillingSummary; payments: SubscriptionPayment[] };
  const apply = useCallback((data: Overview) => {
    setAccounts(data.accounts);
    setSummary(data.summary);
    setPayments(data.payments);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/pointly/billing", { cache: "no-store", credentials: "same-origin" });
      const data = await res.json() as { ok: boolean; error?: string } & Partial<Overview>;
      if (!data.ok || !data.accounts || !data.summary || !data.payments) throw new Error(data.error || "Could not load billing.");
      apply(data as Overview);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load billing.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    const timer = window.setTimeout(() => { load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  // Opened from the Accounts tab — waits for the account list so the form can
  // prefill that business's current plan.
  useEffect(() => {
    if (!recordRequest || loading) return;
    const timer = window.setTimeout(() => {
      const account = accounts.find((a) => a.id === recordRequest.ownerId);
      if (recordRequest.kind === "terms") { if (account) openTerms(account); }
      else setDraft(draftFor(account));
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordRequest?.nonce, loading]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const order: Record<BillingStatus, number> = { overdue: 0, "due-soon": 1, "never-paid": 2, paid: 3 };
    return accounts
      .filter((a) => statusFilter === "all" || a.status === statusFilter)
      .filter((a) => !q || [a.businessName, a.ownerName, a.email, a.phone].some((v) => (v || "").toLowerCase().includes(q)))
      .sort((a, b) => order[a.status] - order[b.status] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.businessName.localeCompare(b.businessName));
  }, [accounts, search, statusFilter]);

  const visiblePayments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return payments.filter((p) => !q || [p.businessName, p.ownerEmail, p.reference ?? "", p.method].some((v) => v.toLowerCase().includes(q)));
  }, [payments, search]);

  // The latest live payment per account — the only one the server lets you void.
  const voidable = useMemo(() => {
    const latest = new Map<string, SubscriptionPayment>();
    for (const p of payments) {
      if (p.voidedAt) continue;
      const current = latest.get(p.ownerId);
      if (!current || p.periodEnd > current.periodEnd || (p.periodEnd === current.periodEnd && p.createdAt > current.createdAt)) {
        latest.set(p.ownerId, p);
      }
    }
    return new Set([...latest.values()].map((p) => p.id));
  }, [payments]);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/pointly/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; error?: string } & Partial<Overview>;
      if (!data.ok) throw new Error(data.error || "That didn't go through.");
      if (data.accounts && data.summary && data.payments) apply(data as Overview);
      return true;
    } catch (err) {
      onToast({ tone: "bad", text: err instanceof Error ? err.message : "That didn't go through." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openTerms(account: BillingAccount) {
    setTerms({
      ownerId: account.id,
      useCustom: account.customPricePkr !== null,
      price: String(account.customPricePkr ?? PLANS[account.plan].pricePkr),
      cycle: String(account.billingCycleMonths ?? 1),
    });
  }

  async function submitTerms() {
    if (!terms) return;
    const ok = await post({
      action: "set-terms",
      ownerId: terms.ownerId,
      customPricePkr: terms.useCustom ? Number(terms.price) : null,
      billingCycleMonths: Number(terms.cycle),
    });
    if (ok) {
      const account = accounts.find((a) => a.id === terms.ownerId);
      onToast({ tone: "ok", text: `Pricing updated for ${account?.businessName || "the account"}.` });
      setTerms(null);
    }
  }

  async function submitPayment() {
    if (!draft) return;
    const length = draftLength(draft, accounts.find((a) => a.id === draft.ownerId));
    if (!length) return;
    const ok = await post({
      action: "record",
      ownerId: draft.ownerId,
      plan: draft.plan,
      ...length,
      amountPkr: Number(draft.amount),
      method: draft.method,
      paidAt: draft.paidAt,
      reference: draft.reference,
      note: draft.note,
    });
    if (ok) {
      const account = accounts.find((a) => a.id === draft.ownerId);
      onToast({ tone: "ok", text: `Payment recorded for ${account?.businessName || "the account"}.` });
      setDraft(null);
    }
  }

  async function submitVoid() {
    if (!voidFor) return;
    const ok = await post({ action: "void", paymentId: voidFor.id, reason: voidReason });
    if (ok) {
      onToast({ tone: "ok", text: "Payment voided." });
      setVoidFor(null);
    }
  }

  const draftAccount = draft ? accounts.find((a) => a.id === draft.ownerId) : undefined;
  const draftAmount = Number(draft?.amount);
  const draftLen = draft ? draftLength(draft, draftAccount) : null;
  const draftValid = Boolean(draft && draft.ownerId && draft.amount !== "" && draftAmount >= 0 && draft.paidAt && draftLen);
  const draftPreview = draft && draftAccount && draft.paidAt && draftLen
    ? (() => {
        const start = nextPeriodStart(draftAccount.paidUntil, draft.paidAt);
        const end = periodEnd(start, draftLen);
        return { start, end, status: billingStatus(end) };
      })()
    : null;
  const draftMonthlyPrice = draft ? draftMonthly(draft, draftAccount) : 0;
  const expectedAmount = draft && draftLen ? priceForPeriod(draftMonthlyPrice, draftLen) : 0;
  const termsAccount = terms ? accounts.find((a) => a.id === terms.ownerId) : undefined;
  const termsPrice = terms ? (terms.useCustom ? Number(terms.price) : PLANS[termsAccount?.plan ?? "starter"].pricePkr) : 0;
  const termsCycle = terms ? Number(terms.cycle) : 0;
  const termsValid = Boolean(terms && Number.isInteger(termsCycle) && termsCycle >= 1 && termsCycle <= MAX_PAYMENT_MONTHS
    && (!terms.useCustom || (terms.price !== "" && termsPrice >= 0)));

  const tabs = (
    <div style={{ display: "flex", gap: 6, background: "#ececf4", padding: 3, borderRadius: 11 }}>
      {([
        { key: "accounts", label: "Subscriptions" },
        { key: "payments", label: "Payment history" },
      ] as const).map(({ key, label: text }) => (
        <button key={key} type="button" onClick={() => setView(key)} style={{
          border: "none", cursor: "pointer", padding: "7px 12px", borderRadius: 9, fontFamily: "inherit",
          fontSize: 12.5, fontWeight: 800,
          background: view === key ? "#fff" : "transparent",
          color: view === key ? "#1a1a2e" : "#8b8ba3",
          boxShadow: view === key ? "0 1px 3px rgba(0,0,0,.08)" : "none",
        }}>{text}</button>
      ))}
    </div>
  );

  return (
    <>
      <style>{`
        .bt-row {
          display: grid;
          grid-template-columns: minmax(200px, 2fr) 130px minmax(120px, 1fr) minmax(130px, 1fr) minmax(120px, 1fr) 200px;
          gap: 12px; align-items: center; padding: 11px 16px;
        }
        .bt-pay {
          display: grid;
          grid-template-columns: 100px minmax(180px, 2fr) 80px 110px minmax(110px, 1fr) minmax(150px, 1.2fr) 70px;
          gap: 12px; align-items: center; padding: 11px 16px;
        }
        @media (max-width: 1100px) {
          .bt-row { grid-template-columns: minmax(180px, 2fr) 120px minmax(120px, 1fr) minmax(120px, 1fr) 180px; }
          .bt-col-last { display: none; }
          .bt-pay { grid-template-columns: 96px minmax(160px, 2fr) 110px minmax(110px, 1fr) 70px; }
          .bt-pay-plan, .bt-pay-period { display: none; }
        }
        @media (max-width: 720px) {
          .bt-row { grid-template-columns: 1fr auto; row-gap: 8px; }
          .bt-col-plan, .bt-col-until { display: none; }
          .bt-pay { grid-template-columns: 1fr auto; row-gap: 4px; }
          .bt-pay-method { display: none; }
        }
      `}</style>

      {error && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 12,
          background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c",
          fontSize: 12.5, fontWeight: 650, marginBottom: 14,
        }}>
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {/* ── Revenue ────────────────────────────────────────────────────────── */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
          <StatCard icon={<TrendingUp size={17} />} label="Monthly recurring revenue" value={pkr(summary.mrrPkr)}
            hint={`${PLAN_IDS.map((id) => `${summary.payingByPlan[id]} ${PLANS[id].name}`).join(" · ")} paying`} tone="#047857" />
          <StatCard icon={<Wallet size={17} />} label="Collected this month" value={pkr(summary.collectedThisMonthPkr)}
            hint={`Last month ${pkr(summary.collectedLastMonthPkr)}`} />
          <StatCard icon={<AlertTriangle size={17} />} label="Overdue" value={summary.overdue}
            hint={summary.overdue ? "Past their paid-until date" : "Nobody overdue"} tone="#b91c1c" />
          <StatCard icon={<CalendarClock size={17} />} label="Due in 7 days" value={summary.dueSoon}
            hint={`${summary.neverPaid} never paid`} tone="#b45309" />
          <StatCard icon={<Receipt size={17} />} label="Collected all time" value={pkr(summary.collectedAllTimePkr)}
            hint={`Full MRR if all paid: ${pkr(summary.potentialMrrPkr)}`} tone="#7c3aed" />
        </div>
      )}

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        {tabs}
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
          <Search size={15} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "#a5a5bb" }} />
          <input className="ac-input" style={{ paddingLeft: 34 }}
            placeholder={view === "accounts" ? "Search business, owner, email or phone" : "Search business, email, method or reference"}
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {view === "accounts" && (
          <select className="ac-input" style={{ width: "auto", minWidth: 140, cursor: "pointer" }}
            value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Filter by payment status">
            <option value="all">All statuses</option>
            <option value="overdue">Overdue</option>
            <option value="due-soon">Due soon</option>
            <option value="never-paid">Never paid</option>
            <option value="paid">Paid</option>
          </select>
        )}
        {view === "payments" && (
          <button type="button" className="ac-btn" disabled={visiblePayments.length === 0} onClick={() => downloadCsv(
            `pointly-payments-${todayIso()}.csv`,
            visiblePayments.map((p) => ({
              "Paid on": p.paidAt, Business: p.businessName, Email: p.ownerEmail, Plan: PLANS[p.plan].name,
              Duration: durationLabel(p), "Amount (PKR)": p.amountPkr, Method: p.method, Reference: p.reference ?? "",
              "Period start": p.periodStart, "Paid until": p.periodEnd, "Recorded by": p.recordedByEmail,
              Note: p.note ?? "", Voided: p.voidedAt ? `Yes — ${p.voidReason ?? ""}` : "",
            })),
          )}>
            <Download size={14} /> Export CSV
          </button>
        )}
        <button type="button" className="ac-btn ac-btn-primary" disabled={loading || accounts.length === 0}
          onClick={() => setDraft(draftFor(undefined))}>
          <Plus size={14} /> Record payment
        </button>
      </div>

      {/* ── Subscriptions ──────────────────────────────────────────────────── */}
      {view === "accounts" ? (
        <div style={{ background: "#fff", border: "1px solid #ececf4", borderRadius: 16, overflow: "hidden", boxShadow: "0 6px 18px rgba(30,20,10,0.04)" }}>
          <div className="bt-row" style={{
            background: "#fafafd", borderBottom: "1px solid #ececf4",
            fontSize: 10.5, fontWeight: 800, color: "#8b8ba3", letterSpacing: "0.06em", textTransform: "uppercase",
          }}>
            <span>Business</span>
            <span className="bt-col-plan">Plan</span>
            <span>Status</span>
            <span className="bt-col-until">Paid until</span>
            <span className="bt-col-last">Last payment</span>
            <span />
          </div>

          {loading ? (
            <div style={{ padding: "56px 20px", textAlign: "center", color: "#9898b0", fontSize: 13, fontWeight: 650 }}>Loading billing…</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: "56px 20px", textAlign: "center", color: "#9898b0", fontSize: 13, fontWeight: 650 }}>
              {accounts.length === 0 ? "No business accounts yet." : "No accounts match."}
            </div>
          ) : visible.map((account) => {
            const reminder = account.status !== "paid" ? reminderLink(account) : null;
            return (
              <div key={account.id} className="bt-row ac-user-row" style={{ borderBottom: "1px solid #f3f3f9" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {account.businessName || "—"}
                    {account.accountFrozen && <span style={{ color: "#1d4ed8", fontWeight: 800, fontSize: 11 }}> · frozen</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "#9898b0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {account.ownerName} · {account.email}
                  </div>
                </div>
                <div className="bt-col-plan">
                  <Pill label={PLANS[account.plan].name} {...PLAN_STYLE[account.plan]} />
                  <div style={{ fontSize: 11, color: account.customPricePkr !== null ? "#7c3aed" : "#a5a5bb", marginTop: 3, fontWeight: account.customPricePkr !== null ? 750 : 500, lineHeight: 1.35 }}
                    title={`${cycleLabel(account.monthlyPricePkr, account.billingCycleMonths)} · ${account.customPricePkr !== null ? `custom price, list is ${pkr(PLANS[account.plan].pricePkr)}/month` : "list price"}`}>
                    {pkr(account.monthlyPricePkr)}/mo
                    {(account.billingCycleMonths ?? 1) > 1 && (
                      <div style={{ fontWeight: 600, color: "#8b8ba3" }}>billed every {account.billingCycleMonths} mo</div>
                    )}
                  </div>
                </div>
                <div>
                  <Pill {...STATUS_STYLE[account.status]} />
                  <div style={{ fontSize: 11, color: "#a5a5bb", marginTop: 3 }}>{dueLine(account)}</div>
                </div>
                <div className="bt-col-until" style={{ fontSize: 12.5, fontWeight: 700, color: "#43435f" }}>
                  {account.paidUntil ? fmtDay(lastCoveredDay(account.paidUntil)) : "—"}
                </div>
                <div className="bt-col-last" style={{ fontSize: 12, color: "#6b6b8a" }}>
                  {account.lastPayment ? (
                    <>
                      <div style={{ fontWeight: 700, color: account.lastPayment.amountPkr > 0 ? "#43435f" : "#047857" }}>
                        {account.lastPayment.amountPkr > 0 ? pkr(account.lastPayment.amountPkr) : "Free period"}
                      </div>
                      <div style={{ fontSize: 11, color: "#a5a5bb" }}>{fmtDay(account.lastPayment.paidAt)}{account.lastPayment.amountPkr > 0 ? ` · ${account.lastPayment.method}` : ""}</div>
                    </>
                  ) : "—"}
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  {reminder && (
                    <a className="ac-btn" href={reminder} target="_blank" rel="noopener noreferrer" title="Send a payment reminder on WhatsApp"
                      style={{ padding: "7px 9px", textDecoration: "none", color: "#047857" }}>
                      <MessageCircle size={13} />
                    </a>
                  )}
                  <button type="button" className="ac-btn" style={{ padding: "7px 9px" }} title="Pricing & billing cycle" onClick={() => openTerms(account)}>
                    <Tag size={13} />
                  </button>
                  <button type="button" className="ac-btn" style={{ padding: "7px 11px" }} onClick={() => setDraft(draftFor(account))}>
                    <Plus size={13} /> Payment
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Payment history ────────────────────────────────────────────── */
        <div style={{ background: "#fff", border: "1px solid #ececf4", borderRadius: 16, overflow: "hidden", boxShadow: "0 6px 18px rgba(30,20,10,0.04)" }}>
          <div className="bt-pay" style={{
            background: "#fafafd", borderBottom: "1px solid #ececf4",
            fontSize: 10.5, fontWeight: 800, color: "#8b8ba3", letterSpacing: "0.06em", textTransform: "uppercase",
          }}>
            <span>Paid on</span>
            <span>Business</span>
            <span className="bt-pay-plan">Plan</span>
            <span>Amount</span>
            <span className="bt-pay-method">Method</span>
            <span className="bt-pay-period">Covers</span>
            <span />
          </div>
          {loading ? (
            <div style={{ padding: "56px 20px", textAlign: "center", color: "#9898b0", fontSize: 13, fontWeight: 650 }}>Loading payments…</div>
          ) : visiblePayments.length === 0 ? (
            <div style={{ padding: "56px 20px", textAlign: "center", color: "#9898b0" }}>
              <Receipt size={26} style={{ opacity: 0.4 }} />
              <div style={{ fontSize: 13.5, fontWeight: 750, color: "#6b6b8a", marginTop: 10 }}>No payments recorded yet</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Record one when a business pays and it appears here.</div>
            </div>
          ) : visiblePayments.map((p) => (
            <div key={p.id} className="bt-pay" style={{ borderBottom: "1px solid #f3f3f9", opacity: p.voidedAt ? 0.55 : 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#43435f" }}>{fmtDay(p.paidAt)}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.businessName}
                </div>
                <div style={{ fontSize: 11, color: "#a5a5bb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.voidedAt ? `Voided${p.voidReason ? ` — ${p.voidReason}` : ""}` : `by ${p.recordedByEmail}${p.note ? ` · ${p.note}` : ""}`}
                </div>
              </div>
              <div className="bt-pay-plan"><Pill label={PLANS[p.plan].name} {...PLAN_STYLE[p.plan]} /></div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e", textDecoration: p.voidedAt ? "line-through" : "none" }}>
                {p.amountPkr > 0 ? pkr(p.amountPkr) : "Free"}
              </div>
              <div className="bt-pay-method" style={{ fontSize: 12, color: "#6b6b8a", minWidth: 0 }}>
                <div>{p.method}</div>
                {p.reference && <div style={{ fontSize: 11, color: "#a5a5bb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.reference}</div>}
              </div>
              <div className="bt-pay-period" style={{ fontSize: 12, color: "#6b6b8a" }}>
                {durationLabel(p)} · {fmtDay(p.periodStart)} – {fmtDay(lastCoveredDay(p.periodEnd))}
              </div>
              <div style={{ textAlign: "right" }}>
                {voidable.has(p.id) && (
                  <button type="button" className="ac-btn ac-btn-danger" style={{ padding: "6px 9px" }} title="Void this payment"
                    onClick={() => { setVoidReason(""); setVoidFor(p); }}>
                    <Ban size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Record payment ─────────────────────────────────────────────────── */}
      {draft && (
        <Modal
          title="Record a payment"
          icon={<Wallet size={17} color="#047857" />}
          width={520}
          onClose={() => setDraft(null)}
          footer={
            <>
              <button type="button" className="ac-btn" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="ac-btn ac-btn-primary" disabled={busy || !draftValid} onClick={submitPayment}>
                <CheckCircle2 size={13} /> {draft.amount !== "" && draftAmount === 0 ? "Record free period" : `Record ${draftAmount > 0 ? pkr(draftAmount) : "payment"}`}
              </button>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <label style={label} htmlFor="bt-owner">Business</label>
              <select id="bt-owner" className="ac-input" style={{ cursor: "pointer" }} value={draft.ownerId}
                onChange={(e) => {
                  const account = accounts.find((a) => a.id === e.target.value);
                  setDraft(repriced({
                    ...draft, ownerId: e.target.value, plan: account?.plan ?? draft.plan,
                    count: draft.unit === "months" ? String(account?.billingCycleMonths ?? draft.count) : draft.count,
                  }, account));
                }}>
                <option value="">Choose a business…</option>
                {[...accounts].sort((a, b) => a.businessName.localeCompare(b.businessName)).map((a) => (
                  <option key={a.id} value={a.id}>{a.businessName} — {a.email}</option>
                ))}
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={label} htmlFor="bt-plan">Plan</label>
                <select id="bt-plan" className="ac-input" style={{ cursor: "pointer" }} value={draft.plan}
                  onChange={(e) => setDraft(repriced({ ...draft, plan: e.target.value as PlanId }, draftAccount))}>
                  {PLAN_IDS.map((id) => <option key={id} value={id}>{PLANS[id].name} — {planPriceLabel(PLANS[id])}</option>)}
                </select>
                {draftAccount?.customPricePkr !== null && draftAccount?.customPricePkr !== undefined && draftAccount.plan === draft.plan && (
                  <div style={{ fontSize: 11, color: "#7c3aed", fontWeight: 700, marginTop: 5 }}>Custom price {pkr(draftAccount.customPricePkr)}/month</div>
                )}
              </div>
              <div>
                <label style={label} htmlFor="bt-unit">Duration</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {draft.unit === "until" ? (
                    <input id="bt-count" className="ac-input" type="date" aria-label="Last day covered"
                      min={draftAccount ? nextPeriodStart(draftAccount.paidUntil, draft.paidAt || todayIso()) : undefined}
                      value={draft.until} onChange={(e) => setDraft(repriced({ ...draft, until: e.target.value }, draftAccount))} />
                  ) : (
                    <input id="bt-count" className="ac-input" type="number" min={1} inputMode="numeric" aria-label={`Number of ${draft.unit}`}
                      max={draft.unit === "months" ? MAX_PAYMENT_MONTHS : MAX_PAYMENT_DAYS} style={{ width: 76, flex: "0 0 auto" }}
                      value={draft.count} onChange={(e) => setDraft(repriced({ ...draft, count: e.target.value }, draftAccount))} />
                  )}
                  <select id="bt-unit" className="ac-input" style={{ cursor: "pointer", flex: "0 0 96px", paddingRight: 4 }} value={draft.unit}
                    onChange={(e) => {
                      const unit = e.target.value as DurationUnit;
                      setDraft(repriced({ ...draft, unit, count: unit === "days" ? "30" : unit === "months" ? "1" : draft.count }, draftAccount));
                    }}>
                    <option value="months">months</option>
                    <option value="days">days</option>
                    <option value="until">until…</option>
                  </select>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: -4 }}>
              {PAYMENT_MONTH_OPTIONS.map((m) => {
                const on = draft.unit === "months" && Number(draft.count) === m;
                return (
                  <button key={m} type="button" className="ac-btn"
                    style={{ padding: "5px 10px", fontSize: 11.5, borderColor: on ? "#EA580C" : undefined, color: on ? "#c2410c" : undefined, background: on ? "#fff7ed" : undefined }}
                    onClick={() => setDraft(repriced({ ...draft, unit: "months", count: String(m) }, draftAccount))}>
                    {m} mo
                  </button>
                );
              })}
              {draftLen && (
                <span style={{ fontSize: 11.5, color: "#8b8ba3", alignSelf: "center", marginLeft: 4 }}>
                  = {draftLen.days !== undefined ? `${draftLen.days} day${draftLen.days === 1 ? "" : "s"}` : `${draftLen.months} month${draftLen.months === 1 ? "" : "s"}`} at {pkr(draftMonthlyPrice)}/month
                </span>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={label} htmlFor="bt-amount">Amount received (PKR)</label>
                <input id="bt-amount" className="ac-input" type="number" min={0} inputMode="numeric" value={draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
                {draft.amount !== "" && draftAmount === 0 ? (
                  <div style={{ fontSize: 11, color: "#047857", fontWeight: 650, marginTop: 5 }}>Recorded as a free period</div>
                ) : draftAmount > 0 && draftLen && draftAmount !== expectedAmount && (
                  <div style={{ fontSize: 11, color: "#b45309", fontWeight: 650, marginTop: 5 }}>
                    Their price for this period is {pkr(expectedAmount)}
                  </div>
                )}
              </div>
              <div>
                <label style={label} htmlFor="bt-paid-at">Received on</label>
                <input id="bt-paid-at" className="ac-input" type="date" max={todayIso()} value={draft.paidAt}
                  onChange={(e) => setDraft(repriced({ ...draft, paidAt: e.target.value }, draftAccount))} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={label} htmlFor="bt-method">Paid by</label>
                <select id="bt-method" className="ac-input" style={{ cursor: "pointer" }} value={draft.method}
                  onChange={(e) => setDraft({ ...draft, method: e.target.value })}>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label style={label} htmlFor="bt-ref">Reference (optional)</label>
                <input id="bt-ref" className="ac-input" maxLength={120} placeholder="Transaction ID" value={draft.reference}
                  onChange={(e) => setDraft({ ...draft, reference: e.target.value })} />
              </div>
            </div>

            <div>
              <label style={label} htmlFor="bt-note">Note (optional)</label>
              <input id="bt-note" className="ac-input" maxLength={300} value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </div>

            {draftAccount && draftPreview && (
              <div style={{ padding: "12px 14px", borderRadius: 12, background: "#f0fdf4", border: "1px solid #bbf7d0", fontSize: 12.5, color: "#14532d", lineHeight: 1.6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 800 }}>
                  <Clock size={14} /> Covers {fmtDay(draftPreview.start)} – {fmtDay(lastCoveredDay(draftPreview.end))}
                </div>
                <div style={{ color: "#166534", marginTop: 2 }}>
                  {draftAccount.paidUntil && draftAccount.paidUntil > draft.paidAt
                    ? `Added on after their current period, which runs to ${fmtDay(lastCoveredDay(draftAccount.paidUntil))}.`
                    : "Starts on the day the money was received."}
                  {draftPreview.status.status === "overdue" && " This period has already ended, so the account will still show as overdue."}
                </div>
                {draftAccount.plan !== draft.plan && (
                  <div style={{ marginTop: 6, fontWeight: 700, color: "#9a3412" }}>
                    The account moves from {PLANS[draftAccount.plan].name} to {PLANS[draft.plan].name} when you record this.
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Pricing & billing cycle ────────────────────────────────────────── */}
      {terms && termsAccount && (
        <Modal
          title={`Pricing — ${termsAccount.businessName}`}
          icon={<Tag size={17} color="#7c3aed" />}
          width={480}
          onClose={() => setTerms(null)}
          footer={
            <>
              <button type="button" className="ac-btn" onClick={() => setTerms(null)}>Cancel</button>
              <button type="button" className="ac-btn ac-btn-primary" disabled={busy || !termsValid} onClick={submitTerms}>
                <CheckCircle2 size={13} /> Save pricing
              </button>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <span style={label}>Monthly price</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { custom: false, title: "List price", sub: `${pkr(PLANS[termsAccount.plan].pricePkr)}/month · ${PLANS[termsAccount.plan].name}` },
                  { custom: true, title: "Custom price", sub: "A negotiated rate for this business" },
                ].map((option) => {
                  const on = terms.useCustom === option.custom;
                  return (
                    <button key={option.title} type="button" onClick={() => setTerms({ ...terms, useCustom: option.custom })} aria-pressed={on}
                      style={{
                        textAlign: "left", padding: "10px 12px", borderRadius: 11, cursor: "pointer", fontFamily: "inherit",
                        border: `1.5px solid ${on ? "#7c3aed" : "#ececf4"}`, background: on ? "#f5f3ff" : "#fff",
                      }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: on ? "#6d28d9" : "#1a1a2e" }}>{option.title}</div>
                      <div style={{ fontSize: 11, color: "#8b8ba3", marginTop: 2 }}>{option.sub}</div>
                    </button>
                  );
                })}
              </div>
              {terms.useCustom && (
                <div style={{ marginTop: 10 }}>
                  <label style={label} htmlFor="bt-custom-price">Custom price per month (PKR)</label>
                  <input id="bt-custom-price" className="ac-input" type="number" min={0} inputMode="numeric" autoFocus
                    value={terms.price} onChange={(e) => setTerms({ ...terms, price: e.target.value })} />
                  {terms.price !== "" && termsPrice < PLANS[termsAccount.plan].pricePkr && (
                    <div style={{ fontSize: 11, color: "#7c3aed", fontWeight: 650, marginTop: 5 }}>
                      {termsPrice === 0 ? "Free — no charge each month" : `${Math.round((1 - termsPrice / PLANS[termsAccount.plan].pricePkr) * 100)}% off the list price`}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <label style={label} htmlFor="bt-cycle">Billing cycle</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input id="bt-cycle" className="ac-input" type="number" min={1} max={MAX_PAYMENT_MONTHS} inputMode="numeric"
                  style={{ width: 80 }} value={terms.cycle} onChange={(e) => setTerms({ ...terms, cycle: e.target.value })} />
                <span style={{ fontSize: 12.5, color: "#6b6b8a" }}>month{termsCycle === 1 ? "" : "s"} per payment</span>
                {PAYMENT_MONTH_OPTIONS.map((m) => (
                  <button key={m} type="button" className="ac-btn" style={{ padding: "5px 9px", fontSize: 11.5 }}
                    onClick={() => setTerms({ ...terms, cycle: String(m) })}>{m}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#8b8ba3", marginTop: 5 }}>New payments for this business start from this many months.</div>
            </div>

            {termsValid && (
              <div style={{ padding: "12px 14px", borderRadius: 12, background: "#f5f3ff", border: "1px solid #ddd6fe", fontSize: 12.5, color: "#4c1d95", lineHeight: 1.6 }}>
                <div style={{ fontWeight: 800 }}>{cycleLabel(termsPrice, termsCycle)}</div>
                <div>Shown to the business in Settings → Subscription, and used for MRR and payment reminders.</div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Void payment ───────────────────────────────────────────────────── */}
      {voidFor && (
        <Modal
          title="Void this payment"
          icon={<Ban size={17} color="#b91c1c" />}
          onClose={() => setVoidFor(null)}
          footer={
            <>
              <button type="button" className="ac-btn" onClick={() => setVoidFor(null)}>Cancel</button>
              <button type="button" className="ac-btn ac-btn-danger" disabled={busy} onClick={submitVoid}>
                <Ban size={13} /> Void payment
              </button>
            </>
          }
        >
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "#6b6b8a", lineHeight: 1.65 }}>
            <strong style={{ color: "#1a1a2e" }}>{pkr(voidFor.amountPkr)}</strong> from <strong style={{ color: "#1a1a2e" }}>{voidFor.businessName}</strong>,
            received {fmtDay(voidFor.paidAt)}. Their paid-until date goes back to where it was before this payment.
            The entry stays in the history, marked void. Their plan isn&apos;t changed.
          </p>
          <label style={label} htmlFor="bt-void-reason">Reason</label>
          <input id="bt-void-reason" className="ac-input" autoFocus maxLength={300} placeholder="e.g. Recorded against the wrong account"
            value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
        </Modal>
      )}
    </>
  );
}
