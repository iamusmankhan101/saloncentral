"use client";

// Building blocks shared by the admin console's tabs.

import { useEffect } from "react";
import { X } from "lucide-react";

// ─── Small building blocks ────────────────────────────────────────────────────

export function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{
      display: "inline-block", padding: "3px 9px", borderRadius: 20, background: bg,
      color, fontSize: 10.5, fontWeight: 800, letterSpacing: "0.02em", whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

export function StatCard({ icon, label, value, hint, tone = "#EA580C" }: {
  icon: React.ReactNode; label: string; value: string | number; hint?: string; tone?: string;
}) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #ececf4", borderRadius: 16, padding: "14px 16px",
      boxShadow: "0 6px 18px rgba(30,20,10,0.04)", display: "flex", alignItems: "center", gap: 12,
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 12, display: "grid", placeItems: "center",
        background: `${tone}14`, color: tone, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 21, fontWeight: 900, color: "#1a1a2e", lineHeight: 1.1, letterSpacing: "-0.03em" }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#8b8ba3", marginTop: 2 }}>{label}</div>
        {hint && <div style={{ fontSize: 10.5, color: "#a5a5bb", marginTop: 1 }}>{hint}</div>}
      </div>
    </div>
  );
}

export function Modal({ title, icon, children, onClose, footer, width = 460 }: {
  title: string; icon?: React.ReactNode; children: React.ReactNode;
  onClose: () => void; footer: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(15,12,20,0.45)",
        display: "grid", placeItems: "center", padding: 16, backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: "100%", maxWidth: width, background: "#fff", borderRadius: 18,
          boxShadow: "0 30px 70px rgba(20,12,8,0.3)", overflow: "hidden",
          maxHeight: "90vh", display: "flex", flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: "1px solid #f0f0f6" }}>
          {icon}
          <div style={{ flex: 1, fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{
            border: "none", background: "#f5f5fa", borderRadius: 9, padding: 6, cursor: "pointer", color: "#6b6b8a",
          }}>
            <X size={15} />
          </button>
        </div>
        <div style={{ padding: 18, overflowY: "auto" }}>{children}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "13px 18px", borderTop: "1px solid #f0f0f6", background: "#fcfcfe" }}>
          {footer}
        </div>
      </div>
    </div>
  );
}

