"use client";

/**
 * What a client's loyalty points can buy — the salon's free-service rewards
 * plus the cash-discount rate. Shown in the client app and on the loyalty card
 * (with `balance`, it marks what can be claimed now).
 */

import { Gift, Check } from "lucide-react";

export interface PublicLoyalty {
  enabled?: boolean;
  rupeePerPoint?: number;
  pointsPerRupee?: number;
  rewards?: { serviceId: string; points: number }[];
}

export default function LoyaltyRewardsList({ loyalty, services, balance, accent = "#7C3AED", currency = "PKR" }: {
  loyalty?: PublicLoyalty;
  services: { id: string; name: string; price?: number }[];
  balance?: number;
  accent?: string;
  currency?: string;
}) {
  if (!loyalty?.enabled) return null;
  const rewards = (loyalty.rewards ?? [])
    .map((r) => ({ ...r, service: services.find((s) => s.id === r.serviceId) }))
    .filter((r) => r.service && r.points > 0)
    .sort((a, b) => a.points - b.points);
  const rpp = Number(loyalty.rupeePerPoint) || 0;
  const ppr = Number(loyalty.pointsPerRupee) || 0;
  if (!rewards.length && !rpp) return null;
  const money = (n: number) => `${currency} ${n.toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
  const known = typeof balance === "number";
  // Any service can be paid with points at the cash rate: list the ones the
  // balance covers in full (dearest first), skipping those with a set reward.
  const worth = known ? balance! * rpp : 0;
  const covered = known && rpp > 0
    ? services
        .filter((s) => (s.price ?? 0) > 0 && (s.price ?? 0) <= worth && !rewards.some((r) => r.serviceId === s.id))
        .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
        .slice(0, 5)
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rewards.map((r) => {
        const claimable = known && balance! >= r.points;
        return (
          <div key={r.serviceId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderRadius: 14, background: "#fff",
            border: `1.5px solid ${claimable ? accent : "#eeedf5"}` }}>
            <span style={{ width: 34, height: 34, borderRadius: 10, background: `${accent}14`, color: accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {claimable ? <Check size={17} /> : <Gift size={17} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 14, fontWeight: 750, color: "#1a1a2e" }}>Free {r.service!.name}</span>
              <span style={{ display: "block", fontSize: 12, color: "#8b8ba3", marginTop: 1 }}>
                {known
                  ? (claimable ? "You can claim this on your next visit" : `${(r.points - balance!).toLocaleString()} more points to go`)
                  : r.service!.price ? `Worth ${money(r.service!.price)}` : "Ask at the salon"}
              </span>
            </span>
            <span style={{ fontSize: 13, fontWeight: 800, color: accent, whiteSpace: "nowrap" }}>{r.points.toLocaleString()} pts</span>
          </div>
        );
      })}
      {covered.length > 0 && (
        <div style={{ padding: "11px 13px", borderRadius: 14, background: `${accent}0d`, border: `1px solid ${accent}26` }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: "#1a1a2e", marginBottom: 6 }}>Your points can get you, free:</div>
          {covered.map((s) => (
            <div key={s.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#3a3a52", padding: "3px 0" }}>
              <span style={{ minWidth: 0 }}>{s.name}</span>
              <span style={{ fontWeight: 700, color: accent, whiteSpace: "nowrap" }}>{Math.ceil((s.price ?? 0) / rpp).toLocaleString()} pts</span>
            </div>
          ))}
        </div>
      )}
      {rpp > 0 && (
        <div style={{ fontSize: 12, color: "#6b6b8a", lineHeight: 1.5, padding: "2px 4px" }}>
          {known
            ? <>Use your points on <strong>any service</strong>: they cover <strong>{money(worth)}</strong>, and if a service costs more you just pay the difference.<br /></>
            : <>Use your points on <strong>any service</strong>. If it costs more than your points cover, just pay the difference.<br /></>}
          Every point is worth <strong>{money(rpp)}</strong>
          {ppr > 0 ? <> · you earn {ppr >= 1 ? `${ppr} point${ppr === 1 ? "" : "s"} per ${currency} 1` : `1 point per ${money(Math.round(1 / ppr))}`} spent</> : null}.
        </div>
      )}
    </div>
  );
}
