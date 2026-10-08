"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { getStoredClients, saveClients, getStoredAppointments, getStoredServices } from "@/lib/storage";
import { getSalonInvoices } from "@/lib/salon-invoices";
import type { Client } from "@/lib/types";
import {
  getTier, TIER_META, nextTierThreshold, pointsToRupees,
  getClientHistory, adjustPoints, redeemPoints,
  type LoyaltySettings, type LoyaltyReward,
} from "@/lib/loyalty";
import { settingsStore, saveSettings } from "@/lib/settings-store";
import { getActiveSection, inSection } from "@/lib/sections";
import { getCurrentUser } from "@/lib/auth";
import { fmtCurrency as fmt } from "@/lib/format";
import {
  Gift, Star, Search, Settings2, ChevronRight, TrendingUp,
  Award, Users, Plus, Minus, X, CreditCard, Printer, Share2,
  QrCode, Copy, ExternalLink, Smartphone,
} from "lucide-react";
import PageTitle from "@/components/page-title";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function TierBadge({ tier }: { tier: ReturnType<typeof getTier> }) {
  const m = TIER_META[tier];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 10px", borderRadius: 20,
      background: m.bg, color: m.color,
      fontSize: 11, fontWeight: 700,
    }}>
      {m.emoji} {m.label}
    </span>
  );
}

function StatCard({ icon, label, value, sub, color, bg }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; color: string; bg?: string;
}) {
  return (
    <div style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.02)", flex: 1 }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: bg || (color + "18"), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color }}>{icon}</div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, fontWeight: 500 }}>{sub}</div>}
      </div>
    </div>
  );
}

// ── Digital Loyalty Card ───────────────────────────────────────────────────────

const TIER_CARD_STYLES: Record<ReturnType<typeof getTier>, { bg: string; shimmer: string; text: string; sub: string; chip: string }> = {
  platinum: { bg: "linear-gradient(135deg,#2e1065 0%,#6d28d9 55%,#a855f7 100%)", shimmer: "rgba(255,255,255,0.14)", text: "#fff", sub: "rgba(255,255,255,0.72)", chip: "#c084fc" },
  gold:     { bg: "linear-gradient(135deg,#2e1065 0%,#7c3aed 55%,#c084fc 100%)", shimmer: "rgba(255,255,255,0.13)", text: "#fff", sub: "rgba(255,255,255,0.72)", chip: "#d8b4fe" },
  silver:   { bg: "linear-gradient(135deg,#1e1b4b 0%,#5b21b6 55%,#9333ea 100%)", shimmer: "rgba(255,255,255,0.11)", text: "#fff", sub: "rgba(255,255,255,0.7)", chip: "#c4b5fd" },
  bronze:   { bg: "linear-gradient(135deg,#1e1b4b 0%,#4c1d95 55%,#7c3aed 100%)", shimmer: "rgba(255,255,255,0.10)", text: "#fff", sub: "rgba(255,255,255,0.68)", chip: "#a78bfa" },
  none:     { bg: "linear-gradient(135deg,#1e1b4b 0%,#4c1d95 50%,#7C3AED 100%)", shimmer: "rgba(255,255,255,0.10)", text: "#fff", sub: "rgba(255,255,255,0.68)", chip: "#a78bfa" },
};

function formatCardNumber(id: string): string {
  const hex = id.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().padEnd(16, "0").slice(0, 16);
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)} ${hex.slice(12, 16)}`;
}

function shortMemberId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8).padEnd(6, "0");
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const TIER_ICON: Record<ReturnType<typeof getTier>, typeof Award> = {
  platinum: Award, gold: Award, silver: Star, bronze: Star, none: Gift,
};

function DigitalCard({
  client, settings, salonName, salonLogo, printRef,
}: {
  client: Client;
  settings: LoyaltySettings;
  salonName: string;
  salonLogo: string;
  printRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const tier    = getTier(client.loyaltyPointsEarned ?? 0, settings);
  const balance = client.loyaltyPoints ?? 0;
  const earned  = client.loyaltyPointsEarned ?? 0;
  const next    = nextTierThreshold(earned, settings);
  const cs      = TIER_CARD_STYLES[tier];
  const meta    = TIER_META[tier];
  const memberId = shortMemberId(client.id);
  const progress = next ? Math.min(100, (earned / (earned + next.needed)) * 100) : 100;
  const TierIcon = TIER_ICON[tier];

  return (
    <div ref={printRef} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Card face */}
      <div style={{
        position: "relative", borderRadius: 26, overflow: "hidden",
        background: cs.bg, padding: "26px 26px 22px",
        maxWidth: 420, width: "100%", margin: "0 auto",
        boxShadow: "0 16px 48px rgba(0,0,0,0.28)",
        fontFamily: "inherit",
        userSelect: "none",
      }}>
        {/* Watermark badge icon */}
        <TierIcon size={168} color={cs.text} strokeWidth={1} style={{ position: "absolute", top: -34, right: -30, opacity: 0.10, transform: "rotate(-10deg)" }} />
        {/* Shimmer overlay */}
        <div style={{
          position: "absolute", inset: 0,
          background: `radial-gradient(ellipse at 20% 15%, ${cs.shimmer} 0%, transparent 60%)`,
          pointerEvents: "none",
        }} />

        {/* Top row: salon logo/name + tier badge */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Logo or fallback icon */}
            <div style={{
              width: 42, height: 42, borderRadius: "50%",
              background: "rgba(255,255,255,0.18)", display: "grid", placeItems: "center",
              overflow: "hidden", flexShrink: 0, border: "1.5px solid rgba(255,255,255,0.32)",
            }}>
              {salonLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={salonLogo} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <Gift size={19} color={cs.text} />
              )}
            </div>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: cs.sub, letterSpacing: "0.12em", textTransform: "uppercase" }}>Loyalty Member</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: cs.text, letterSpacing: "0.01em", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{salonName}</div>
            </div>
          </div>
          {/* Tier badge */}
          <div style={{
            background: "rgba(255,255,255,0.18)", borderRadius: 20,
            padding: "5px 13px", fontSize: 11, fontWeight: 800, color: cs.text,
            backdropFilter: "blur(4px)", display: "flex", alignItems: "center", gap: 5,
          }}>
            {meta.emoji} {meta.label}
          </div>
        </div>

        {/* Points — hero */}
        <div style={{ marginTop: 30, position: "relative", textAlign: "center" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: cs.sub, letterSpacing: "0.14em", textTransform: "uppercase" }}>Points Balance</div>
          <div style={{ fontSize: 46, fontWeight: 900, color: cs.text, lineHeight: 1.1, letterSpacing: "-0.02em" }}>
            {balance.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: cs.sub, marginTop: 2 }}>
            ≈ {fmt(pointsToRupees(balance, settings.rupeePerPoint))} redeemable
          </div>
        </div>

        {/* Ticket-style perforation */}
        <div style={{ margin: "24px 0 18px", position: "relative", borderTop: "1.5px dashed rgba(255,255,255,0.3)" }} />

        {/* Bottom row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
              background: "rgba(255,255,255,0.16)", border: "1px solid rgba(255,255,255,0.28)",
              display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800, color: cs.text,
            }}>
              {initials(client.name)}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: cs.text }}>{client.name}</div>
              <div style={{ fontSize: 9, color: cs.sub, letterSpacing: "0.1em", marginTop: 2 }}>MEMBER · {memberId}</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8, fontWeight: 700, color: cs.sub, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>Lifetime</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: cs.text }}>{earned.toLocaleString()} pts</div>
          </div>
        </div>
      </div>

      {/* Progress to next tier */}
      {next && (
        <div style={{ background: "#f7f7fb", borderRadius: 14, padding: "14px 16px", maxWidth: 420, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e" }}>
              Progress to {TIER_META[next.tier].emoji} {TIER_META[next.tier].label}
            </div>
            <div style={{ fontSize: 11, color: "#9898b0" }}>{next.needed} pts needed</div>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: "#e8e8f0", overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 4,
              background: "linear-gradient(90deg,#7C3AED,#9333EA)",
              width: `${progress}%`, transition: "width 0.6s ease",
            }} />
          </div>
        </div>
      )}
      {!next && (
        <div style={{ background: "#f3e8ff", borderRadius: 14, padding: "12px 16px", maxWidth: 420, width: "100%", margin: "0 auto", boxSizing: "border-box", textAlign: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#6b21a8" }}>💎 Top Tier Achieved — Platinum Member!</div>
        </div>
      )}

      {/* Tier benefits */}
      <div style={{ background: "#f7f7fb", borderRadius: 14, padding: "14px 16px", maxWidth: 420, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e", marginBottom: 10 }}>Your Benefits</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            `Earn ${settings.pointsPerRupee} pts per Rs. 1 spent`,
            `Every 100 pts = ${fmt(pointsToRupees(100, settings.rupeePerPoint))} discount`,
            tier === "platinum" ? "Priority bookings + exclusive rewards" :
            tier === "gold"     ? "Early access to promotions" :
            tier === "silver"   ? "Monthly double-points days" : "Welcome bonus on next visit",
          ].map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#5a5a7a" }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: "#7C3AED", flexShrink: 0 }} />
              {b}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Client Points Modal ────────────────────────────────────────────────────────

function ClientModal({
  client, settings, onClose, onUpdate,
}: {
  client: Client;
  settings: LoyaltySettings;
  onClose: () => void;
  onUpdate: (c: Client) => void;
}) {
  const tier     = getTier(client.loyaltyPointsEarned ?? 0, settings);
  const balance  = client.loyaltyPoints ?? 0;
  const earned   = client.loyaltyPointsEarned ?? 0;
  const next     = nextTierThreshold(earned, settings);
  const history  = getClientHistory(client.id);
  const cardRef  = useRef<HTMLDivElement>(null);

  const [tab, setTab]         = useState<"overview" | "history" | "adjust" | "card">("overview");
  const [adjType, setAdjType] = useState<"add" | "redeem">("add");
  const [adjPts, setAdjPts]   = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [saving, setSaving]   = useState(false);
  const [copied, setCopied]   = useState(false);
  const [walletMsg, setWalletMsg] = useState("");

  function handlePrint() {
    const el = cardRef.current;
    if (!el) return;
    const w = window.open("", "_blank", "width=520,height=640");
    if (!w) return;
    w.document.write(`
      <html><head><title>Loyalty Card — ${client.name}</title>
      <style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f7f7fb;font-family:sans-serif}@media print{body{background:#fff}}</style>
      </head><body>${el.innerHTML}<script>window.onload=()=>window.print()<\/script></body></html>
    `);
    w.document.close();
  }

  function handleShare() {
    const cardNum = formatCardNumber(client.id);
    const text = `${client.name}'s GlowBook Loyalty Card\nTier: ${TIER_META[tier].emoji} ${TIER_META[tier].label}\nPoints: ${balance.toLocaleString()}\nCard: ${cardNum}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleWallet(platform: "apple" | "google") {
    setWalletMsg("");
    const salonId = getCurrentUser()?.id;
    if (!salonId) {
      setWalletMsg("Sign in is required before wallet passes can be issued.");
      return;
    }

    const logo = settingsStore.salon?.logo ?? "";
    const res = await fetch("/api/wallet/loyalty", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform,
        salonId,
        client,
        salonLogo: logo.startsWith("https://") ? logo : "",
      }),
    });
    const json = await res.json() as { ok: boolean; url?: string; error?: string };
    if (json.ok && json.url) {
      window.location.href = json.url;
      return;
    }
    setWalletMsg(json.error || `${platform === "apple" ? "Apple" : "Google"} Wallet is not configured yet.`);
  }

  function handleAdjust() {
    const pts = parseInt(adjPts, 10);
    if (!pts || pts <= 0) return;
    setSaving(true);
    const clients = getStoredClients();
    let updated: Client;
    if (adjType === "add") {
      updated = adjustPoints(client, pts, adjNote || "Manual adjustment");
    } else {
      updated = redeemPoints(client, pts, adjNote || "Manual redemption");
    }
    const newClients = clients.map((c) => c.id === updated.id ? updated : c);
    saveClients(newClients);
    onUpdate(updated);
    setAdjPts("");
    setAdjNote("");
    setSaving(false);
  }

  const tierMeta = TIER_META[tier];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "#fff", borderRadius: 20, width: "100%", maxWidth: 520,
        maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
      }}>
        {/* Header */}
        <div style={{ padding: "22px 24px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1a1a2e" }}>{client.name}</div>
            <div style={{ marginTop: 6 }}><TierBadge tier={tier} /></div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9898b0" }}><X size={20} /></button>
        </div>

        {/* Points summary */}
        <div style={{ padding: "16px 24px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ background: tierMeta.bg, borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: tierMeta.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>Balance</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: tierMeta.color, marginTop: 4 }}>{balance.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: tierMeta.color + "99", marginTop: 2 }}>≈ {fmt(pointsToRupees(balance, settings.rupeePerPoint))}</div>
          </div>
          <div style={{ background: "#f7f7fb", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Lifetime Earned</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: "#1a1a2e", marginTop: 4 }}>{earned.toLocaleString()}</div>
            {next ? (
              <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{next.needed} pts to {TIER_META[next.tier].emoji} {TIER_META[next.tier].label}</div>
            ) : (
              <div style={{ fontSize: 11, color: "#6b21a8", marginTop: 2 }}>💎 Top tier achieved!</div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #f0f0f8", padding: "0 24px" }}>
          {(["overview", "history", "adjust", "card"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "10px 14px", fontSize: 12, fontWeight: 700,
              color: tab === t ? "#7C3AED" : "#9898b0",
              borderBottom: tab === t ? "2px solid #7C3AED" : "2px solid transparent",
              textTransform: "capitalize",
              display: "flex", alignItems: "center", gap: 5,
            }}>
              {t === "card" && <CreditCard size={12} />}
              {t}
            </button>
          ))}
        </div>

        <div style={{ overflowY: "auto", flex: 1, padding: "16px 24px 24px" }}>
          {tab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {next && (
                <div style={{ background: "#f7f7fb", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e", marginBottom: 8 }}>
                    Progress to {TIER_META[next.tier].emoji} {TIER_META[next.tier].label}
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "#e8e8f0", overflow: "hidden" }}>
                    <div style={{
                      height: "100%", borderRadius: 4, background: "linear-gradient(90deg,#7C3AED,#9333EA)",
                      width: `${Math.min(100, ((earned / (earned + next.needed)) * 100))}%`,
                      transition: "width 0.6s ease",
                    }} />
                  </div>
                  <div style={{ fontSize: 11, color: "#9898b0", marginTop: 6 }}>{next.needed} more points needed</div>
                </div>
              )}
              <div style={{ background: "#f7f7fb", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e", marginBottom: 6 }}>Earning Rate</div>
                <div style={{ fontSize: 13, color: "#5a5a7a" }}>
                  Every <strong>Rs. {Math.round(1 / settings.pointsPerRupee)}</strong> spent = <strong>1 point</strong>
                </div>
                <div style={{ fontSize: 13, color: "#5a5a7a", marginTop: 4 }}>
                  100 points = <strong>{fmt(pointsToRupees(100, settings.rupeePerPoint))}</strong> discount
                </div>
              </div>
              <div style={{ background: "#f7f7fb", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e", marginBottom: 4 }}>Redeemable Value</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#7C3AED" }}>
                  {fmt(pointsToRupees(balance, settings.rupeePerPoint))}
                </div>
                <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>from {balance} points</div>
              </div>
            </div>
          )}

          {tab === "history" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {history.length === 0 ? (
                <div style={{ textAlign: "center", color: "#9898b0", fontSize: 13, padding: "32px 0" }}>No transactions yet</div>
              ) : history.map((tx) => (
                <div key={tx.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 14px", background: "#f7f7fb", borderRadius: 10,
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{tx.note}</div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{fmtDate(tx.date)}</div>
                  </div>
                  <div style={{
                    fontSize: 14, fontWeight: 800,
                    color: tx.points > 0 ? "#059669" : "#dc2626",
                  }}>
                    {tx.points > 0 ? "+" : ""}{tx.points} pts
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "adjust" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 8 }}>
                {(["add", "redeem"] as const).map((t) => (
                  <button key={t} onClick={() => setAdjType(t)} style={{
                    flex: 1, padding: "10px", borderRadius: 10, border: "none", cursor: "pointer",
                    fontWeight: 700, fontSize: 13,
                    background: adjType === t ? "#7C3AED" : "#f0f0f8",
                    color: adjType === t ? "#fff" : "#5a5a7a",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}>
                    {t === "add" ? <Plus size={14} /> : <Minus size={14} />}
                    {t === "add" ? "Add Points" : "Redeem Points"}
                  </button>
                ))}
              </div>
              <input
                type="number" min={1} placeholder="Points"
                value={adjPts} onChange={(e) => setAdjPts(e.target.value)}
                style={{ padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e8e8f0", fontSize: 14, fontWeight: 600, outline: "none" }}
              />
              <input
                type="text" placeholder="Note (optional)"
                value={adjNote} onChange={(e) => setAdjNote(e.target.value)}
                style={{ padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e8e8f0", fontSize: 14, outline: "none" }}
              />
              {adjType === "redeem" && adjPts && (
                <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#92400e", fontWeight: 600 }}>
                  Redeeming {adjPts} pts = {fmt(pointsToRupees(parseInt(adjPts) || 0, settings.rupeePerPoint))} discount
                </div>
              )}
              <button onClick={handleAdjust} disabled={!adjPts || saving} style={{
                padding: "12px", borderRadius: 12, border: "none", cursor: "pointer",
                background: "linear-gradient(135deg,#7C3AED,#9333EA)", color: "#fff",
                fontWeight: 700, fontSize: 14,
                opacity: !adjPts ? 0.5 : 1,
              }}>
                {adjType === "add" ? "Add Points" : "Redeem Points"}
              </button>
            </div>
          )}

          {tab === "card" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handlePrint} style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "10px", borderRadius: 10, border: "1.5px solid #e8e8f0",
                  background: "#fff", fontSize: 13, fontWeight: 700, color: "#5a5a7a", cursor: "pointer",
                }}>
                  <Printer size={14} /> Print Card
                </button>
                <button onClick={handleShare} style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "10px", borderRadius: 10, border: "none",
                  background: copied ? "#f0fdf4" : "linear-gradient(135deg,#7C3AED,#9333EA)",
                  fontSize: 13, fontWeight: 700,
                  color: copied ? "#059669" : "#fff", cursor: "pointer",
                }}>
                  <Share2 size={14} /> {copied ? "Copied!" : "Copy Details"}
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <button onClick={() => handleWallet("apple")} style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "10px", borderRadius: 10, border: "none",
                  background: "#1a1a2e", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
                }}>
                  <Smartphone size={14} /> Apple Wallet
                </button>
                <button onClick={() => handleWallet("google")} style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "10px", borderRadius: 10, border: "1.5px solid #e8e8f0",
                  background: "#fff", color: "#1a1a2e", fontSize: 13, fontWeight: 800, cursor: "pointer",
                }}>
                  <Smartphone size={14} /> Google Wallet
                </button>
              </div>
              {walletMsg && (
                <div style={{ padding: "10px 12px", borderRadius: 10, background: "#fffbeb", color: "#92400e", fontSize: 12, fontWeight: 700 }}>
                  {walletMsg}
                </div>
              )}
              {/* The card */}
              <DigitalCard
                client={client}
                settings={settings}
                salonName={(settingsStore.salon as { name: string }).name}
                salonLogo={(settingsStore.salon as { logo: string }).logo}
                printRef={cardRef}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Settings Panel ─────────────────────────────────────────────────────────────

/** "Redeem for a free service" list: which services, for how many points. */
function RewardsEditor({ rewards, onChange }: { rewards: LoyaltyReward[]; onChange: (r: LoyaltyReward[]) => void }) {
  const services = useMemo(() => getStoredServices().filter((s) => s.isActive !== false), []);
  const [serviceId, setServiceId] = useState("");
  const [points, setPoints] = useState("");
  const inp: React.CSSProperties = { padding: "9px 10px", borderRadius: 9, border: "1.5px solid #e8e8f0", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#fff" };
  function add() {
    const pts = Math.round(Number(points));
    if (!serviceId || !(pts > 0)) return;
    onChange([...rewards.filter((r) => r.serviceId !== serviceId), { id: crypto.randomUUID(), serviceId, points: pts }]);
    setServiceId(""); setPoints("");
  }
  return (
    <div style={{ borderTop: "1px solid #f0f0f8", paddingTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#5a5a7a", marginBottom: 4 }}>Free-service rewards</div>
      <div style={{ fontSize: 11, color: "#9898b0", marginBottom: 10 }}>Besides the cash discount, clients can spend points on a free service at POS.</div>
      {rewards.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {rewards.map((r) => {
            const svc = services.find((s) => s.id === r.serviceId);
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, background: "#f5f3ff" }}>
                <Gift size={14} color="#7C3AED" style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{svc?.name ?? "Deleted service"}{svc ? <span style={{ color: "#9898b0", fontWeight: 500 }}> · worth {fmt(svc.price)}</span> : null}</span>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#7C3AED", whiteSpace: "nowrap" }}>{r.points.toLocaleString()} pts</span>
                <button type="button" aria-label={`Remove ${svc?.name ?? "reward"}`} onClick={() => onChange(rewards.filter((x) => x.id !== r.id))}
                  style={{ border: "none", background: "none", cursor: "pointer", color: "#9898b0", display: "flex" }}><X size={14} /></button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={{ ...inp, flex: 1, minWidth: 0 }}>
          <option value="">Choose a service…</option>
          {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {fmt(s.price)}</option>)}
        </select>
        <input type="number" min={1} value={points} onChange={(e) => setPoints(e.target.value)} placeholder="Points" aria-label="Points needed" style={{ ...inp, width: 86 }} />
        <button type="button" onClick={add} disabled={!serviceId || !(Number(points) > 0)}
          style={{ border: "none", borderRadius: 9, padding: "0 12px", fontSize: 12, fontWeight: 800, cursor: "pointer", background: serviceId && Number(points) > 0 ? "#7C3AED" : "#e8e8f0", color: serviceId && Number(points) > 0 ? "#fff" : "#b0b0c8" }}>
          Add
        </button>
      </div>
    </div>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const s = settingsStore.loyalty as LoyaltySettings;
  const [form, setForm] = useState({ ...s });
  const [saved, setSaved] = useState(false);

  function save() {
    Object.assign(settingsStore.loyalty, form);
    saveSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const F = (k: keyof typeof form, num?: boolean) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = num ? parseFloat(e.target.value) || 0 : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "#fff", borderRadius: 20, width: "100%", maxWidth: 440,
        boxShadow: "0 24px 60px rgba(0,0,0,0.18)", padding: "28px 28px 24px",
        maxHeight: "92dvh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#1a1a2e" }}>Loyalty Settings</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9898b0" }}><X size={20} /></button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Enable toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#f7f7fb", borderRadius: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#1a1a2e" }}>Enable Loyalty Program</div>
              <div style={{ fontSize: 12, color: "#9898b0" }}>Points auto-awarded on completion</div>
            </div>
            <div
              onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
              style={{
                width: 44, height: 24, borderRadius: 12, cursor: "pointer", transition: "background 0.2s",
                background: form.enabled ? "#7C3AED" : "#d1d5db", position: "relative",
              }}
            >
              <div style={{
                position: "absolute", top: 2, left: form.enabled ? 22 : 2,
                width: 20, height: 20, borderRadius: 10, background: "#fff",
                transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </div>
          </div>

          {/* Earning rate */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#5a5a7a", display: "block", marginBottom: 6 }}>
              Points per Rupee spent
            </label>
            <input
              type="number" step="0.01" min="0.01" value={form.pointsPerRupee}
              onChange={F("pointsPerRupee", true)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e8e8f0", fontSize: 14, outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ fontSize: 11, color: "#9898b0", marginTop: 4 }}>
              e.g. 0.01 = 1 pt per Rs. 100 · 0.1 = 1 pt per Rs. 10
            </div>
          </div>

          {/* Redemption value */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#5a5a7a", display: "block", marginBottom: 6 }}>
              Rupees per point (redemption value)
            </label>
            <input
              type="number" step="0.5" min="0.5" value={form.rupeePerPoint}
              onChange={F("rupeePerPoint", true)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e8e8f0", fontSize: 14, outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ fontSize: 11, color: "#9898b0", marginTop: 4 }}>
              e.g. 1 = 100 pts → Rs. 100 off
            </div>
          </div>

          {/* Referral credit */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#5a5a7a", display: "block", marginBottom: 6 }}>
              Referral credit (Rs.) for both people
            </label>
            <input
              type="number" step="100" min="0" value={form.referralCredit ?? 0}
              onChange={F("referralCredit", true)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e8e8f0", fontSize: 14, outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ fontSize: 11, color: "#9898b0", marginTop: 4 }}>
              e.g. 1000 — when a referred client pays for their first visit, they and whoever referred them each get Rs. 1,000 in points. Set &ldquo;Referred by&rdquo; on the client&rsquo;s profile. 0 = off.
            </div>
          </div>

          {/* Free-service rewards */}
          <RewardsEditor rewards={form.rewards ?? []} onChange={(rewards) => setForm((f) => ({ ...f, rewards }))} />

          {/* Tier thresholds */}
          <div style={{ borderTop: "1px solid #f0f0f8", paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#5a5a7a", marginBottom: 10 }}>Tier Thresholds (lifetime pts)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {(["silverMin", "goldMin", "platinumMin"] as const).map((k) => (
                <div key={k}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: TIER_META[k === "silverMin" ? "silver" : k === "goldMin" ? "gold" : "platinum"].color, display: "block", marginBottom: 4 }}>
                    {TIER_META[k === "silverMin" ? "silver" : k === "goldMin" ? "gold" : "platinum"].emoji} {k === "silverMin" ? "Silver" : k === "goldMin" ? "Gold" : "Platinum"}
                  </label>
                  <input
                    type="number" min={1} value={form[k]}
                    onChange={F(k, true)}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1.5px solid #e8e8f0", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <button onClick={save} style={{
          marginTop: 20, width: "100%", padding: "13px", borderRadius: 12, border: "none", cursor: "pointer",
          background: "linear-gradient(135deg,#7C3AED,#9333EA)", color: "#fff", fontWeight: 700, fontSize: 15,
        }}>
          {saved ? "Saved ✓" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function LoyaltyPage() {
  const [clients, setClients]         = useState<Client[]>([]);
  const [allAppts, setAllAppts]       = useState<ReturnType<typeof getStoredAppointments>>([]);
  const [allInvoices, setAllInvoices] = useState<ReturnType<typeof getSalonInvoices>>([]);
  const [search, setSearch]           = useState("");
  const [selected, setSelected]       = useState<Client | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [tierFilter, setTierFilter]   = useState<string>("all");
  const [claimUrl, setClaimUrl]       = useState("");
  const [qrCopied, setQrCopied]       = useState(false);

  const settings = settingsStore.loyalty as LoyaltySettings;
  // Strict-locked to the active dashboard section — the leaderboard/points
  // system is built from clients, same rule as the Clients page.
  const activeSection = getActiveSection();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const ls = settingsStore.loyalty as LoyaltySettings;
      const storedClients  = getStoredClients();
      const storedAppts    = getStoredAppointments();
      const storedInvoices = getSalonInvoices();

      // Persist any upward corrections to localStorage (only increase, never lower).
      let changed = false;
      const corrected = storedClients.map((c) => {
        const apptSpend = storedAppts
          .filter((a) => a.clientId === c.id && a.status === "completed")
          .reduce((s, a) => s + a.totalAmount, 0);
        const posSpend = storedInvoices
          .filter((inv) => inv.clientId === c.id && inv.source === "pos")
          .reduce((s, inv) => s + inv.total, 0);
        const liveSpend   = Math.max(c.totalSpend ?? 0, apptSpend + posSpend);
        const computed    = Math.floor(liveSpend * ls.pointsPerRupee);
        const newEarned   = Math.max(c.loyaltyPointsEarned ?? 0, computed);
        if (newEarned === (c.loyaltyPointsEarned ?? 0)) return c;
        const redeemed    = Math.max(0, (c.loyaltyPointsEarned ?? 0) - (c.loyaltyPoints ?? 0));
        changed = true;
        return { ...c, loyaltyPointsEarned: newEarned, loyaltyPoints: Math.max(0, newEarned - redeemed) };
      });

      // The point-correction save always writes the full, unfiltered list —
      // only the displayed leaderboard is scoped to the active section.
      if (changed) saveClients(corrected);
      setClients(corrected.filter((c) => inSection(c, activeSection)));
      setAllAppts(storedAppts);
      setAllInvoices(storedInvoices);

      const user = getCurrentUser();
      if (user && typeof window !== "undefined") {
        setClaimUrl(`${window.location.origin}/loyalty-card/${encodeURIComponent(user.id)}`);
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  function handleUpdate(updated: Client) {
    setClients((prev) => {
      const next = prev.map((c) => c.id === updated.id ? updated : c);
      saveClients(next);
      return next;
    });
    setSelected(updated);
  }

  // Compute live loyalty values per client — same formula as the client quick-view
  // panel so leaderboard and panel always agree.
  const enriched = useMemo(() => {
    const ls = settings;
    return clients.map((c) => {
      const apptSpend = allAppts
        .filter((a) => a.clientId === c.id && a.status === "completed")
        .reduce((s, a) => s + a.totalAmount, 0);
      const posSpend = allInvoices
        .filter((inv) => inv.clientId === c.id && inv.source === "pos")
        .reduce((s, inv) => s + inv.total, 0);
      const liveSpend    = Math.max(c.totalSpend ?? 0, apptSpend + posSpend);
      const computed     = Math.floor(liveSpend * (ls.pointsPerRupee ?? 0.01));
      const earned       = Math.max(c.loyaltyPointsEarned ?? 0, computed);
      const redeemed     = Math.max(0, (c.loyaltyPointsEarned ?? 0) - (c.loyaltyPoints ?? 0));
      const balance      = Math.max(c.loyaltyPoints ?? 0, earned - redeemed);
      return { client: c, tier: getTier(earned, ls), balance, earned };
    });
  }, [clients, allAppts, allInvoices, settings]);

  const filtered = useMemo(() => {
    return enriched
      .filter((e) => {
        if (search && !e.client.name.toLowerCase().includes(search.toLowerCase()) &&
            !e.client.phone.includes(search)) return false;
        if (tierFilter !== "all" && e.tier !== tierFilter) return false;
        return true;
      })
      .sort((a, b) => b.earned - a.earned);
  }, [enriched, search, tierFilter]);

  const totalPts      = enriched.reduce((s, e) => s + e.balance, 0);
  const totalEarned   = enriched.reduce((s, e) => s + e.earned, 0);
  const activeMembers = enriched.filter((e) => e.earned > 0).length;
  const platCount     = enriched.filter((e) => e.tier === "platinum").length;
  const qrSrc = claimUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=${encodeURIComponent(claimUrl)}`
    : "";

  const TIER_FILTERS = [
    { value: "all",      label: "All Members" },
    { value: "platinum", label: "💎 Platinum" },
    { value: "gold",     label: "🥇 Gold" },
    { value: "silver",   label: "🥈 Silver" },
    { value: "bronze",   label: "🥉 Bronze" },
  ];

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#ffffff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <PageTitle icon={<Gift size={24} />} title="Loyalty Program" subtitle={activeSection === "all" ? "Reward your clients, grow retention" : `Restricted to ${activeSection} only`} />
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={() => setShowSettings(true)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "10px 18px",
            borderRadius: 12, border: "1px solid #e3e0eb", background: "#fff",
            fontSize: 13, fontWeight: 750, color: "#6b6b8a", cursor: "pointer", transition: "all 0.15s"
          }} className="hover-bg-light">
            <Settings2 size={16} /> Settings
          </button>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, padding: "10px 18px",
            borderRadius: 12, border: "none",
            background: settings.enabled ? "#f0fdf4" : "#fef2f2",
            fontSize: 13, fontWeight: 800,
            color: settings.enabled ? "#059669" : "#dc2626",
            boxShadow: settings.enabled ? "0 4px 12px rgba(5,150,105,0.06)" : "none"
          }}>
            {settings.enabled ? "● Active" : "● Paused"}
          </div>
        </div>
      </div>

      {/* Universal QR */}
      <div className="loyalty-qr" style={{
        display: "grid", gridTemplateColumns: "220px 1fr", gap: 24, alignItems: "center",
        background: "#fff", border: "1px solid rgba(226,223,235,.95)", borderRadius: 18, padding: 20,
        boxShadow: "0 8px 28px rgba(38,25,75,.04)"
      }}>
        <div style={{ width: 190, height: 190, borderRadius: 16, background: "rgba(124, 58, 237, 0.04)", border: "1px solid rgba(124, 58, 237, 0.1)", display: "grid", placeItems: "center", overflow: "hidden" }}>
          {qrSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrSrc} alt="Universal salon loyalty QR code" width={168} height={168} />
          ) : (
            <QrCode size={64} color="#9898b0" />
          )}
        </div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, color: "#7C3AED", fontSize: 12, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            <QrCode size={16} /> Universal Salon QR
          </div>
          <h2 style={{ margin: "0 0 8px", color: "#1a1a2e", fontSize: 22, lineHeight: 1.15 }}>One QR code for every customer loyalty card</h2>
          <p style={{ margin: "0 0 14px", color: "#777790", fontSize: 13, lineHeight: 1.6, maxWidth: 720 }}>
            Print this QR at reception or share the link. Customers scan it, enter their phone number, and instantly view or claim their digital loyalty card.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(claimUrl);
                setQrCopied(true);
                setTimeout(() => setQrCopied(false), 1800);
              }}
              disabled={!claimUrl}
              style={{ display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 12, background: "var(--accent-gradient)", color: "#fff", padding: "10px 18px", fontSize: 13, fontWeight: 800, cursor: "pointer", transition: "all 0.15s", boxShadow: "0 4px 14px var(--accent-glow)" }}
              className="hover-scale"
            >
              <Copy size={15} /> {qrCopied ? "Copied" : "Copy Link"}
            </button>
            <a href={claimUrl || "#"} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #e3e0eb", borderRadius: 12, background: "#fff", color: "#6b6b8a", padding: "10px 18px", fontSize: 13, fontWeight: 800, textDecoration: "none", transition: "all 0.15s" }} className="hover-bg-light">
              <ExternalLink size={15} /> Open Claim Page
            </a>
          </div>
          {claimUrl && <div style={{ marginTop: 12, color: "#9898b0", fontSize: 11, wordBreak: "break-all" }}>{claimUrl}</div>}
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid-4">
        <StatCard icon={<Users size={22} />}     label="Active Members"    value={activeMembers.toString()} sub={`of ${clients.length} clients`} color="var(--accent)" bg="rgba(124, 58, 237, 0.08)" />
        <StatCard icon={<Star size={22} />}       label="Total Points Balance" value={totalPts.toLocaleString()} sub={`≈ ${fmt(totalPts * settings.rupeePerPoint)}`} color="#d97706" bg="#fffbeb" />
        <StatCard icon={<TrendingUp size={22} />} label="Lifetime Earned"   value={totalEarned.toLocaleString()} sub="all time" color="#059669" bg="#ecfdf5" />
        <StatCard icon={<Award size={22} />}      label="Platinum Members"  value={platCount.toString()} sub="top tier" color="#6b21a8" bg="#f3e8ff" />
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 240px", minWidth: 0 }}>
          <Search size={15} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#9898b0" }} />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients..."
            style={{ width: "100%", padding: "10px 14px 10px 38px", borderRadius: 12, border: "1px solid #e3e0eb", fontSize: 13, outline: "none", background: "#fff", boxSizing: "border-box", boxShadow: "0 2px 8px rgba(0,0,0,0.01)", transition: "border-color 0.15s" }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {TIER_FILTERS.map((f) => (
            <button key={f.value} onClick={() => setTierFilter(f.value)} style={{
              padding: "9px 18px", borderRadius: 20, cursor: "pointer",
              fontSize: 13, fontWeight: 750, transition: "all 0.15s",
              background: tierFilter === f.value ? "var(--accent)" : "#fff",
              color: tierFilter === f.value ? "#fff" : "#6b6b8a",
              border: tierFilter === f.value ? "none" : "1px solid #e3e0eb",
              boxShadow: tierFilter === f.value ? "0 4px 12px rgba(124, 58, 237, 0.2)" : "none"
            }} className={tierFilter !== f.value ? "hover-bg-light" : ""}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Leaderboard */}
      <div className="table-scroll-wrap" style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", overflow: "hidden" }}>
        <div style={{ padding: "18px 24px", borderBottom: "1px solid #f0f0f5", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a2e" }}>Client Leaderboard</div>
          <div style={{ fontSize: 13, color: "#9898b0", fontWeight: 600 }}>{filtered.length} clients</div>
        </div>

        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "64px 24px", color: "#9898b0" }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: "rgba(226,223,235,0.5)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", boxShadow: "0 4px 12px rgba(0,0,0,0.02)" }}>
              <Gift size={32} color="#9898b0" />
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>No members yet</div>
            <div style={{ fontSize: 13, color: "#9898b0", fontWeight: 500 }}>Points are awarded when appointments are marked completed</div>
          </div>
        ) : (
          <div className="table-scroll-inner loyalty-table-inner">
            {/* Table header */}
            <div className="loyalty-row" style={{
              display: "grid", gridTemplateColumns: "40px 1fr 120px 100px 100px 80px 36px",
              padding: "12px 24px", background: "#faf9fd",
              fontSize: 10, fontWeight: 800, color: "#8e89a3", textTransform: "uppercase", letterSpacing: "0.08em",
              gap: 12, alignItems: "center"
            }}>
              <div>#</div><div>Client</div><div>Tier</div>
              <div style={{ textAlign: "right" }}>Balance</div>
              <div style={{ textAlign: "right" }}>Lifetime</div>
              <div style={{ textAlign: "right" }}>Value</div>
              <div />
            </div>
            {filtered.map((e, i) => (
              <div
                key={e.client.id}
                onClick={() => setSelected(e.client)}
                className="hover-bg-row loyalty-row"
                style={{
                  display: "grid", gridTemplateColumns: "40px 1fr 120px 100px 100px 80px 36px",
                  padding: "16px 24px", gap: 12, alignItems: "center",
                  borderBottom: i < filtered.length - 1 ? "1px solid #f8f8fc" : "none", cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                {/* Rank */}
                <div style={{ fontSize: 14, fontWeight: 850, color: i < 3 ? "var(--accent)" : "#9898b0" }}>
                  {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
                </div>

                {/* Name */}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 750, color: "#1a1a2e" }}>{e.client.name}</div>
                  <div style={{ fontSize: 12, color: "#9898b0", fontWeight: 500 }}>{e.client.phone}</div>
                </div>

                {/* Tier */}
                <div><TierBadge tier={e.tier} /></div>

                {/* Balance */}
                <div style={{ textAlign: "right", fontSize: 14, fontWeight: 800, color: "#7C3AED" }}>
                  {e.balance.toLocaleString()}
                </div>

                {/* Lifetime */}
                <div style={{ textAlign: "right", fontSize: 13, color: "#5a5a7a", fontWeight: 600 }}>
                  {e.earned.toLocaleString()}
                </div>

                {/* Redeemable value */}
                <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: "#059669" }}>
                  {fmt(pointsToRupees(e.balance, settings.rupeePerPoint))}
                </div>

                <ChevronRight size={16} color="#d0d0e0" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {selected && (
        <ClientModal
          client={selected}
          settings={settings}
          onClose={() => setSelected(null)}
          onUpdate={handleUpdate}
        />
      )}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
