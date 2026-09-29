"use client";

/**
 * The console's landing tab: what needs a decision today (approvals, overdue
 * payments, frozen accounts), how the platform is growing, and what was done
 * last. Every item links through to the tab or account where it's handled.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, Building2, CalendarClock, CheckCircle2, Shield, Snowflake,
  TrendingUp, UserCheck, UserX, Activity, Wallet,
} from "lucide-react";
import { Pill, StatCard } from "./ui";
import type { AuditEntry, PlatformStats, PlatformUser } from "@/lib/pointly/types";
import type { BillingAccount, BillingSummary } from "@/lib/pointly/billing";
import { BUSINESS_TYPE_IDS, BUSINESS_TYPES, businessTypeFor } from "@/lib/pointly/business-types";
import { PLAN_IDS, PLANS, normalizePlanId } from "@/lib/pointly/plans";

const card: React.CSSProperties = {
  background: "#fff", border: "1px solid #ececf4", borderRadius: 16, padding: "16px 18px",
  boxShadow: "0 6px 18px rgba(30,20,10,0.04)", minWidth: 0,
};
const heading: React.CSSProperties = { fontSize: 13.5, fontWeight: 850, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 8 };
const ACCENT = "#EA580C";

function pkr(n: number) {
  return `PKR ${Math.round(n).toLocaleString("en-US")}`;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function OverviewTab({ users, stats, refreshKey, actionLabel, busy, onApprove, onReject, onUnfreeze, onOpen, onRecordPayment, onGoto }: {
  users: PlatformUser[];
  stats: PlatformStats | null;
  refreshKey: number;
  actionLabel: Record<string, string>;
  busy: boolean;
  onApprove: (user: PlatformUser) => void;
  onReject: (user: PlatformUser) => void;
  onUnfreeze: (user: PlatformUser) => void;
  onOpen: (id: string) => void;
  onRecordPayment: (ownerId: string) => void;
  onGoto: (tab: "accounts" | "billing" | "activity", filter?: "pending" | "frozen") => void;
}) {
  const [billing, setBilling] = useState<{ accounts: BillingAccount[]; summary: BillingSummary } | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  // Read once per mount — "this week" doesn't need to tick while the tab is open.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/admin/pointly/billing", { cache: "no-store", credentials: "same-origin" }).then((r) => r.json()).catch(() => null),
      fetch("/api/admin/pointly/audit?limit=8", { cache: "no-store", credentials: "same-origin" }).then((r) => r.json()).catch(() => null),
    ]).then(([b, a]) => {
      if (cancelled) return;
      if (b?.ok) setBilling({ accounts: b.accounts, summary: b.summary });
      if (a?.entries) setAudit(a.entries);
    });
    return () => { cancelled = true; };
  }, [refreshKey, users]);

  const owners = useMemo(() => users.filter((u) => u.role === "owner" && !u.businessOwnerId), [users]);
  const pending = useMemo(() => users.filter((u) => u.approvalStatus === "pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [users]);
  const frozen = useMemo(() => users.filter((u) => u.accountFrozen), [users]);
  const unpaid = useMemo(
    () => (billing?.accounts ?? [])
      .filter((a) => a.status === "overdue" || a.status === "due-soon")
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
    [billing],
  );

  const weekAgo = now - 7 * 86_400_000;
  const activeThisWeek = owners.filter((u) => u.lastActivity && new Date(u.lastActivity).getTime() >= weekAgo).length;

  // Business sign-ups per day for the last 30 days (owners only — team logins
  // aren't new customers).
  const series = useMemo(() => {
    const days: { key: string; label: string; count: number }[] = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      days.push({ key: dayKey(d), label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), count: 0 });
    }
    const index = new Map(days.map((d, i) => [d.key, i]));
    for (const u of owners) {
      const i = index.get((u.createdAt || "").slice(0, 10));
      if (i !== undefined) days[i].count += 1;
    }
    return days;
  }, [owners]);
  const total30 = series.reduce((s, d) => s + d.count, 0);
  const max = Math.max(1, ...series.map((d) => d.count));

  const byType = BUSINESS_TYPE_IDS
    .map((id) => ({ id, label: BUSINESS_TYPES[id].name, count: owners.filter((u) => businessTypeFor(u).id === id).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  const byPlan = PLAN_IDS.map((id) => ({ id, label: PLANS[id].name, count: owners.filter((u) => normalizePlanId(u.plan) === id).length }));

  const attentionCount = pending.length + unpaid.length + frozen.length;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <style>{`
        .ov-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 14px; align-items: start; }
        .ov-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid #f3f3f9; }
        .ov-row:first-of-type { border-top: none; }
        @media (max-width: 960px) { .ov-grid { grid-template-columns: 1fr; } }
        @media (max-width: 520px) { .ov-kpis { grid-template-columns: 1fr 1fr !important; gap: 8px !important; } }
      `}</style>

      {/* ── Headline numbers ─────────────────────────────────────────────── */}
      <div className="ov-kpis" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <StatCard icon={<Building2 size={17} />} label="Businesses" value={owners.length} hint={`${total30} joined in 30 days`} tone="#0369a1" />
        <StatCard icon={<Activity size={17} />} label="Active this week" value={activeThisWeek} hint={`of ${owners.length} businesses`} tone="#047857" />
        <StatCard icon={<TrendingUp size={17} />} label="Monthly recurring revenue" value={billing ? pkr(billing.summary.mrrPkr) : "—"}
          hint={billing ? `${pkr(billing.summary.collectedThisMonthPkr)} collected this month` : "Loading…"} tone="#7c3aed" />
        <StatCard icon={<UserCheck size={17} />} label="Awaiting approval" value={pending.length} hint={pending.length ? "Needs a decision" : "All clear"} tone="#b45309" />
        <StatCard icon={<AlertTriangle size={17} />} label="Overdue payments" value={billing?.summary.overdue ?? "—"}
          hint={billing ? `${billing.summary.dueSoon} due in 7 days` : ""} tone="#b91c1c" />
      </div>

      <div className="ov-grid">
        {/* ── Needs attention ──────────────────────────────────────────── */}
        <section style={card} aria-labelledby="ov-attention">
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <div id="ov-attention" style={heading}>
              Needs attention
              {attentionCount > 0 && <Pill label={String(attentionCount)} color="#b45309" bg="#fffbeb" />}
            </div>
          </div>

          {attentionCount === 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "22px 0", color: "#047857", fontSize: 13, fontWeight: 700 }}>
              <CheckCircle2 size={18} /> All clear — nothing waiting on you.
            </div>
          )}

          {pending.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 850, color: "#8b8ba3", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Awaiting approval · {pending.length}
              </div>
              {pending.slice(0, 6).map((u) => (
                <div key={u.id} className="ov-row">
                  <button type="button" onClick={() => onOpen(u.id)} style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                    <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {u.businessName || u.ownerName} <span style={{ color: "#a5a5bb", fontWeight: 600 }}>· {businessTypeFor(u).shortName}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "#9898b0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {u.ownerName} · {u.email} · signed up {u.createdAt}
                    </div>
                  </button>
                  <button type="button" className="ac-btn" disabled={busy} style={{ padding: "6px 10px", color: "#047857" }} onClick={() => onApprove(u)}>
                    <UserCheck size={13} /> Approve
                  </button>
                  <button type="button" className="ac-btn ac-btn-danger" disabled={busy} style={{ padding: "6px 9px" }} onClick={() => onReject(u)} aria-label={`Reject ${u.email}`} title="Reject">
                    <UserX size={13} />
                  </button>
                </div>
              ))}
              {pending.length > 6 && (
                <button type="button" className="ac-btn" style={{ marginTop: 6 }} onClick={() => onGoto("accounts", "pending")}>
                  See all {pending.length} <ArrowRight size={13} />
                </button>
              )}
            </div>
          )}

          {unpaid.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 850, color: "#8b8ba3", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Payments due · {unpaid.length}
              </div>
              {unpaid.slice(0, 6).map((a) => {
                const overdue = a.status === "overdue";
                const days = Math.abs(a.daysLeft ?? 0);
                return (
                  <div key={a.id} className="ov-row">
                    <button type="button" onClick={() => onOpen(a.id)} style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                      <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.businessName}</div>
                      <div style={{ fontSize: 11.5, color: overdue ? "#b91c1c" : "#b45309", fontWeight: 650 }}>
                        {overdue ? (days === 0 ? "Due today" : `${days} day${days === 1 ? "" : "s"} overdue`) : `Due in ${days} day${days === 1 ? "" : "s"}`}
                        <span style={{ color: "#a5a5bb", fontWeight: 500 }}> · {pkr(a.monthlyPricePkr)}/mo</span>
                      </div>
                    </button>
                    <button type="button" className="ac-btn" style={{ padding: "6px 10px" }} onClick={() => onRecordPayment(a.id)}>
                      <Wallet size={13} /> Record
                    </button>
                  </div>
                );
              })}
              {unpaid.length > 6 && (
                <button type="button" className="ac-btn" style={{ marginTop: 6 }} onClick={() => onGoto("billing")}>
                  Open billing <ArrowRight size={13} />
                </button>
              )}
            </div>
          )}

          {frozen.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 850, color: "#8b8ba3", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Frozen · {frozen.length}
              </div>
              {frozen.slice(0, 4).map((u) => (
                <div key={u.id} className="ov-row">
                  <button type="button" onClick={() => onOpen(u.id)} style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                    <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{u.businessName || u.ownerName}</div>
                    <div style={{ fontSize: 11.5, color: "#9898b0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {u.email}{u.freezeReason ? ` · ${u.freezeReason}` : ""}
                    </div>
                  </button>
                  <button type="button" className="ac-btn" disabled={busy} style={{ padding: "6px 10px" }} onClick={() => onUnfreeze(u)}>
                    <Snowflake size={13} /> Unfreeze
                  </button>
                </div>
              ))}
              {frozen.length > 4 && (
                <button type="button" className="ac-btn" style={{ marginTop: 6 }} onClick={() => onGoto("accounts", "frozen")}>
                  See all {frozen.length} <ArrowRight size={13} />
                </button>
              )}
            </div>
          )}
        </section>

        <div style={{ display: "grid", gap: 14 }}>
          {/* ── Sign-ups (single series: the title names it, no legend) ── */}
          <section style={card} aria-labelledby="ov-signups">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <div id="ov-signups" style={heading}>New businesses · last 30 days</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#1a1a2e" }}>{total30}</div>
            </div>
            <div style={{ fontSize: 11.5, color: "#8b8ba3", minHeight: 16, marginTop: 2 }}>
              {hover !== null
                ? <><strong style={{ color: "#1a1a2e" }}>{series[hover].label}</strong> · {series[hover].count} sign-up{series[hover].count === 1 ? "" : "s"}</>
                : `${stats?.newThisWeek ?? 0} login${stats?.newThisWeek === 1 ? "" : "s"} added this week`}
            </div>
            <svg viewBox="0 0 300 96" width="100%" role="img" aria-label={`Business sign-ups per day for the last 30 days, ${total30} in total`}
              style={{ display: "block", marginTop: 8, overflow: "visible" }} onMouseLeave={() => setHover(null)}>
              <line x1="0" y1="80" x2="300" y2="80" stroke="#ececf4" strokeWidth="1" />
              <text x="0" y="8" fontSize="7" fill="#a5a5bb">{max}</text>
              <line x1="12" y1="5" x2="300" y2="5" stroke="#f3f3f9" strokeWidth="1" />
              {series.map((d, i) => {
                const slot = 300 / series.length;
                const w = slot - 2; // 2px surface gap between bars
                const h = d.count ? Math.max(3, (d.count / max) * 74) : 0;
                const x = i * slot + 1;
                return (
                  <g key={d.key} onMouseEnter={() => setHover(i)}>
                    {/* hit target taller than the mark */}
                    <rect x={x - 1} y={0} width={slot} height={82} fill="transparent" />
                    {h > 0 && (
                      <path d={`M${x},80 V${80 - h + 2} a2,2 0 0 1 2,-2 H${x + w - 2} a2,2 0 0 1 2,2 V80 Z`}
                        fill={ACCENT} opacity={hover === null || hover === i ? 1 : 0.45} />
                    )}
                    {h === 0 && hover === i && <rect x={x} y={78} width={w} height={2} fill="#d6d6e6" />}
                  </g>
                );
              })}
              <text x="0" y="94" fontSize="7" fill="#a5a5bb">{series[0].label}</text>
              <text x="300" y="94" fontSize="7" fill="#a5a5bb" textAnchor="end">Today</text>
            </svg>
          </section>

          {/* ── Mix ───────────────────────────────────────────────────────── */}
          <section style={card} aria-labelledby="ov-mix">
            <div id="ov-mix" style={heading}>Business mix</div>
            {[
              { title: "By type", rows: byType },
              { title: "By plan", rows: byPlan },
            ].map((group) => {
              const top = Math.max(1, ...group.rows.map((r) => r.count));
              return (
                <div key={group.title} style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 850, color: "#8b8ba3", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{group.title}</div>
                  {group.rows.length === 0 && <div style={{ fontSize: 12, color: "#a5a5bb" }}>No businesses yet.</div>}
                  {group.rows.map((r) => (
                    <div key={r.id} title={`${r.label}: ${r.count}`} style={{ display: "grid", gridTemplateColumns: "118px 1fr 28px", alignItems: "center", gap: 8, padding: "3px 0" }}>
                      <span style={{ fontSize: 12, fontWeight: 650, color: "#43435f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
                      <span style={{ height: 8, borderRadius: 4, background: "#f3f3f9", overflow: "hidden" }}>
                        <span style={{ display: "block", height: "100%", width: `${(r.count / top) * 100}%`, background: ACCENT, borderRadius: 4, minWidth: r.count ? 4 : 0 }} />
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", textAlign: "right" }}>{r.count}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </section>

          {/* ── Recent activity ──────────────────────────────────────────── */}
          <section style={card} aria-labelledby="ov-activity">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div id="ov-activity" style={heading}><Shield size={14} color="#8b8ba3" /> Recent admin activity</div>
              <button type="button" className="ac-btn" style={{ padding: "5px 9px", fontSize: 11.5 }} onClick={() => onGoto("activity")}>
                All <ArrowRight size={12} />
              </button>
            </div>
            {audit.length === 0 ? (
              <div style={{ fontSize: 12, color: "#a5a5bb", marginTop: 10 }}>Nothing yet.</div>
            ) : audit.slice(0, 6).map((e) => (
              <div key={e.id} className="ov-row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1a1a2e" }}>
                    {actionLabel[e.action] ?? e.action}
                    {e.targetEmail && <span style={{ color: "#8b8ba3", fontWeight: 600 }}> · {e.targetEmail}</span>}
                  </div>
                  {e.detail && <div style={{ fontSize: 11.5, color: "#a5a5bb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.detail}</div>}
                </div>
                <span style={{ fontSize: 11, color: "#a5a5bb", whiteSpace: "nowrap" }}>{ago(e.createdAt)}</span>
              </div>
            ))}
          </section>
        </div>
      </div>

      {billing === null && (
        <div style={{ fontSize: 11.5, color: "#a5a5bb", display: "flex", alignItems: "center", gap: 6 }}>
          <CalendarClock size={12} /> Loading billing…
        </div>
      )}
    </div>
  );
}
