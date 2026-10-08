"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  MessageSquare, CheckCircle2, XCircle, Clock, Send, RefreshCw,
  Zap, Bell, ThumbsUp, Package, ChevronRight, Phone, Copy, Check,
  Eye, EyeOff, Save, TrendingUp, Wifi, WifiOff, CalendarDays, AlertCircle, Cake, CalendarX, Heart, X, ListChecks, UserMinus, RotateCcw, Trash2, Search, Users,
} from "lucide-react";
import DashboardHeader from "@/components/dashboard-header";
import MobilePageHeader from "@/components/mobile-page-header";
import { saveSettings, settingsStore, SETTINGS_CHANGED_EVENT } from "@/lib/settings-store";
import { getStoredAppointments, getStoredClients } from "@/lib/storage";
import { getSalonInvoices } from "@/lib/salon-invoices";
import { getActiveSection, inSection } from "@/lib/sections";
import { getWaLogs, WaLogEntry, WaMsgType, checkBirthdayReminders, getPendingWhatsAppQueue, PendingQueueItem, sendQueuedBirthdayNow } from "@/lib/whatsapp-scheduler";
import { isFakePlaceholderPhone } from "@/lib/whatsapp-provider";
import { getCurrentUser } from "@/lib/auth";
import { locationUserKey } from "@/lib/locations";
import { getCurrentPlan } from "@/lib/plan-limits";
import type { QueueDetailItem } from "@/app/api/whatsapp/queue-details/route";
import { summarizeWinbackAudience, resolveWinbackConfig, WINBACK_DAILY_MIN, WINBACK_DAILY_MAX, WINBACK_DEFAULTS } from "@/lib/winback";
import type { Client } from "@/lib/types";
import { whatsAppConnected } from "@/lib/whatsapp-scheduler";

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_META: Record<WaMsgType, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  reminder:     { label: "Reminder",     color: "#7C3AED", bg: "rgba(124,58,237,0.1)",  icon: Bell },
  confirmation: { label: "Confirmation", color: "#059669", bg: "rgba(5,150,105,0.1)",   icon: CheckCircle2 },
  followup:     { label: "Follow-up",    color: "#0284c7", bg: "rgba(2,132,199,0.1)",   icon: ThumbsUp },
  cancellation: { label: "Cancellation", color: "#dc2626", bg: "rgba(220,38,38,0.1)",   icon: CalendarX },
  lowstock:     { label: "Low Stock",    color: "#ea580c", bg: "rgba(234,88,12,0.1)",   icon: Package },
  manual:       { label: "Manual",       color: "#6b7280", bg: "rgba(107,114,128,0.1)", icon: Send },
  birthday:     { label: "Birthday",     color: "#db2777", bg: "rgba(219,39,119,0.1)",  icon: Cake },
  winback:      { label: "Win-back",     color: "#0d9488", bg: "rgba(13,148,136,0.1)",  icon: UserMinus },
  thankyou:     { label: "Thank You",    color: "#c026d3", bg: "rgba(192,38,211,0.1)",  icon: Heart },
  newbooking:   { label: "New Booking",  color: "#6366f1", bg: "rgba(99,102,241,0.1)",  icon: CalendarDays },
  invoice:      { label: "Invoice",      color: "#2563eb", bg: "rgba(37,99,235,0.1)",   icon: MessageSquare },
  aftercare:    { label: "Aftercare",    color: "#7c3aed", bg: "rgba(124,58,237,0.1)",  icon: Heart },
};

const SAMPLE_VARS: Record<string, string> = {
  name: "Fatima",
  service: "Haircut & Style",
  date: new Date().toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" }),
  time: "3:00pm",
  salon_name: (settingsStore.salon as { name: string }).name,
  items: "Loreal Hair Color (2 left), OPI Nail Polish (1 left)",
  count: "2",
  discount: "10%",
  amount: "2500",
  last_visit: new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10),
  days: "120",
};

function isVisibleWaLog(log: WaLogEntry): boolean {
  return log.phone.endsWith("@g.us") || !isFakePlaceholderPhone(log.phone);
}

type TplCfg = { key: string; noDiscountKey?: string; label: string; description: string; vars: string[]; noDiscountVars?: string[]; color: string; icon: React.ElementType };

const TPL_CONFIG: TplCfg[] = [
  { key: "reminder",     label: "Appointment Reminder",    description: "Sent automatically X hours before the appointment",         vars: ["name","service","date","time","salon_name"], color: "#7C3AED", icon: Bell },
  { key: "confirmation", label: "Booking Confirmation",    description: "Sent when a new appointment is booked",                     vars: ["name","service","date","time","salon_name"], color: "#059669", icon: CheckCircle2 },
  { key: "followup",     label: "Follow-up Message",       description: "Sent 24h after appointment is marked as completed",         vars: ["name","service","salon_name"],               color: "#0284c7", icon: ThumbsUp },
  { key: "cancellation", noDiscountKey: "cancellationNoDiscount", label: "Cancellation Win-back", description: "Sent after cancellation. Supports separate discount and no-discount wording", vars: ["name","salon_name","discount"], noDiscountVars: ["name","salon_name"], color: "#dc2626", icon: CalendarX },
  { key: "lowstock",     label: "Low Stock Alert",         description: "Sent once daily to your WhatsApp when stock is low",        vars: ["items","count","salon_name"],                color: "#ea580c", icon: Package },
  { key: "birthday", noDiscountKey: "birthdayNoDiscount", label: "Birthday Greeting", description: "Queued on each client's birthday. Supports separate discount and no-discount wording", vars: ["name","salon_name","discount"], noDiscountVars: ["name","salon_name"], color: "#db2777", icon: Cake },
  { key: "winback", noDiscountKey: "winbackNoDiscount", label: "Win-back (Lapsed Clients)", description: "Sent to clients who haven't visited in a long time. Supports separate discount and no-discount wording", vars: ["name","salon_name","discount","last_visit","days"], noDiscountVars: ["name","salon_name","last_visit","days"], color: "#0d9488", icon: UserMinus },
  { key: "winbackNeverVisited", noDiscountKey: "winbackNeverVisitedNoDiscount", label: "Win-back (Never Visited)", description: "Sent to clients on file who have never visited, when that option is on in Win-back Messages", vars: ["name","salon_name","discount"], noDiscountVars: ["name","salon_name"], color: "#0d9488", icon: UserMinus },
  { key: "posThankYou",  label: "POS Thank You",           description: "Included in the invoice message caption after a POS sale", vars: ["name","salon_name"],                          color: "#c026d3", icon: Heart },
];

const FILTERS: { value: WaMsgType | "all"; label: string }[] = [
  { value: "all",          label: "All" },
  { value: "reminder",     label: "Reminders" },
  { value: "confirmation", label: "Confirmations" },
  { value: "followup",     label: "Follow-ups" },
  { value: "cancellation", label: "Cancellations" },
  { value: "birthday",     label: "Birthdays" },
  { value: "winback",      label: "Win-back" },
  { value: "thankyou",     label: "Thank You" },
  { value: "lowstock",     label: "Low Stock" },
  { value: "newbooking",   label: "New Booking" },
  { value: "invoice",      label: "Invoice" },
  { value: "manual",       label: "Manual" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  const d = new Date(iso);
  const isToday = d.toDateString() === new Date().toDateString();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return d.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });
  if (isYesterday) return "Yesterday " + d.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-PK", { day: "2-digit", month: "short" }) + " · " + d.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-PK", { weekday: "long", day: "2-digit", month: "short" });
}

// Only counts items still on their first attempt — a message that already failed
// once and is waiting out its retry delay isn't "queued" in the sense this banner
// means (new, not-yet-attempted work); it's a failed send retrying, which shows up
// in the Failed stat and Message Log instead.
function getQueueLength(baseKey: string): number {
  try {
    const items = JSON.parse(localStorage.getItem(locationUserKey(baseKey)) || "[]") as { retries?: number }[];
    return items.filter((item) => !item.retries).length;
  } catch { return 0; }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Badge({ type }: { type: string }) {
  const m = TYPE_META[type as WaMsgType] ?? TYPE_META.manual;
  const Icon = m.icon;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 20, background: m.bg, color: m.color, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
      <Icon size={10} /> {m.label}
    </span>
  );
}

function StatusChip({ status }: { status: "sent" | "failed" }) {
  const ok = status === "sent";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: ok ? "#059669" : "#dc2626", background: ok ? "rgba(5,150,105,0.08)" : "rgba(220,38,38,0.08)", padding: "3px 8px", borderRadius: 20 }}>
      {ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      {ok ? "Sent" : "Failed"}
    </span>
  );
}

function AutoCard({ icon: Icon, label, enabled, color }: {
  icon: React.ElementType; label: string; enabled: boolean; color: string;
}) {
  return (
    <div style={{ padding: "11px 14px", borderRadius: 10, border: `1px solid ${enabled ? color + "25" : "#e8e8f4"}`, background: enabled ? color + "06" : "#fafafd", display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: enabled ? color + "15" : "#f0f0f8", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={14} color={enabled ? color : "#b0b0c8"} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#1d1d2f" }}>{label}</div>
        <div style={{ fontSize: 10, color: enabled ? "#059669" : "#9999b0", marginTop: 1 }}>
          {enabled ? "✓ Active" : "Disabled"}
        </div>
      </div>
      <div style={{ width: 7, height: 7, borderRadius: "50%", background: enabled ? "#22c55e" : "#e0e0e8", flexShrink: 0, boxShadow: enabled ? "0 0 6px #22c55e80" : "none" }} />
    </div>
  );
}

// ─── Template Card ────────────────────────────────────────────────────────────

function getDiscountInitial(key: string): string {
  if (key === "cancellation") return (settingsStore.wasender as Record<string, string>).cancelDiscount ?? "10%";
  if (key === "birthday")     return (settingsStore.birthday  as Record<string, string>).birthdayDiscount ?? "";
  if (key === "winback")      return (settingsStore.winback   as Record<string, string>).winbackDiscount ?? "";
  return "";
}

function getDiscountEnabledInitial(key: string): boolean {
  if (key === "cancellation") return (settingsStore.wasender as { cancelDiscountEnabled?: boolean }).cancelDiscountEnabled !== false;
  if (key === "birthday")     return (settingsStore.birthday  as { birthdayDiscountEnabled?: boolean }).birthdayDiscountEnabled !== false;
  if (key === "winback")      return (settingsStore.winback   as { winbackDiscountEnabled?: boolean }).winbackDiscountEnabled !== false;
  return false;
}

function TemplateCard({ cfg }: { cfg: TplCfg }) {
  const wa = settingsStore.whatsapp as Record<string, string>;
  const hasDiscount = Boolean(cfg.noDiscountKey);
  const [textWithDiscount, setTextWithDiscount] = useState(wa[cfg.key] || "");
  const [textNoDiscount, setTextNoDiscount] = useState(cfg.noDiscountKey ? (wa[cfg.noDiscountKey] || "") : "");
  const [discount, setDiscount]   = useState(() => getDiscountInitial(cfg.key));
  const [discountEnabled, setDiscountEnabled] = useState(() => getDiscountEnabledInitial(cfg.key));
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const dirtyRef = useRef(false);
  const Icon = cfg.icon;

  const text = hasDiscount && !discountEnabled ? textNoDiscount : textWithDiscount;
  const activeVars = hasDiscount && !discountEnabled ? (cfg.noDiscountVars || cfg.vars.filter((v) => v !== "discount")) : cfg.vars;
  const setActiveText = (updater: string | ((value: string) => string)) => {
    const setNext = (current: string) => typeof updater === "function" ? updater(current) : updater;
    if (hasDiscount && !discountEnabled) setTextNoDiscount(setNext);
    else setTextWithDiscount(setNext);
  };
  const liveVars: Record<string, string> = { ...SAMPLE_VARS, discount: discountEnabled ? (discount || SAMPLE_VARS.discount) : "" };
  const preview  = text.replace(/\{\{(\w+)\}\}/g, (_, k) => liveVars[k] ?? `{{${k}}}`);
  const charCount = text.length;

  useEffect(() => {
    function onSettingsChanged() {
      if (dirtyRef.current) return;
      const fresh = (settingsStore.whatsapp as Record<string, string>)[cfg.key] || "";
      const freshNoDiscount = cfg.noDiscountKey ? ((settingsStore.whatsapp as Record<string, string>)[cfg.noDiscountKey] || "") : "";
      setTextWithDiscount(fresh);
      setTextNoDiscount(freshNoDiscount);
      setDiscount(getDiscountInitial(cfg.key));
      setDiscountEnabled(getDiscountEnabledInitial(cfg.key));
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
  }, [cfg.key, cfg.noDiscountKey]);

  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }
  function save() {
    (settingsStore.whatsapp as Record<string, string>)[cfg.key] = textWithDiscount;
    if (cfg.noDiscountKey) (settingsStore.whatsapp as Record<string, string>)[cfg.noDiscountKey] = textNoDiscount;
    if (cfg.key === "cancellation") {
      (settingsStore.wasender as Record<string, string | boolean>).cancelDiscount = discount;
      (settingsStore.wasender as Record<string, string | boolean>).cancelDiscountEnabled = discountEnabled;
    }
    if (cfg.key === "birthday") {
      (settingsStore.birthday as Record<string, string | boolean>).birthdayDiscount = discount;
      (settingsStore.birthday as Record<string, string | boolean>).birthdayDiscountEnabled = discountEnabled;
    }
    if (cfg.key === "winback") {
      (settingsStore.winback as Record<string, string | boolean>).winbackDiscount = discount;
      (settingsStore.winback as Record<string, string | boolean>).winbackDiscountEnabled = discountEnabled;
    }
    saveSettings();
    dirtyRef.current = false;
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #e8e8f0", borderRadius: 16, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", gap: 12, background: cfg.color + "05" }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: cfg.color + "15", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={17} color={cfg.color} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1d1d2f" }}>{cfg.label}</div>
          <div style={{ fontSize: 11, color: "#9999b0", marginTop: 2 }}>{cfg.description}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={() => setShowPreview((p) => !p)}
            style={{ display: "flex", alignItems: "center", gap: 5, border: `1px solid ${showPreview ? cfg.color + "50" : "#e8e8f0"}`, background: showPreview ? cfg.color + "10" : "#fff", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, color: showPreview ? cfg.color : "#9999b0", cursor: "pointer" }}>
            {showPreview ? <EyeOff size={11} /> : <Eye size={11} />} Preview
          </button>
          <button type="button" onClick={copy}
            style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid #e8e8f0", background: "#fff", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, color: copied ? "#059669" : "#9999b0", cursor: "pointer" }}>
            {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {activeVars.map((v) => (
            <button key={v} type="button" onClick={() => setActiveText((t) => t + `{{${v}}}`)} title="Click to insert"
              style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 9px", borderRadius: 20, background: cfg.color + "10", border: `1px solid ${cfg.color}28`, color: cfg.color, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              + {`{{${v}}}`}
            </button>
          ))}
        </div>

        {/* Discount field for templates that use {{discount}} */}
        {hasDiscount && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: cfg.color + "06", border: `1px solid ${cfg.color}20` }}>
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: cfg.color, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 2 }}>Discount Option</div>
              <div style={{ fontSize: 10, color: "#9999b0" }}>{discountEnabled ? "Editing discount template" : "Editing no-discount template"}</div>
            </div>
            <button
              type="button"
              onClick={() => { dirtyRef.current = true; setDiscountEnabled((v) => !v); }}
              aria-label={`${discountEnabled ? "Disable" : "Enable"} discount for ${cfg.label}`}
              style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: discountEnabled ? cfg.color : "#d1d5db", position: "relative", flexShrink: 0, transition: "background 0.2s" }}
            >
              <span style={{ position: "absolute", top: 3, left: discountEnabled ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
            </button>
            <input
              type="text"
              value={discount}
              onChange={e => { dirtyRef.current = true; setDiscount(e.target.value); }}
              disabled={!discountEnabled}
              placeholder="e.g. 10%, 15%, PKR 500"
              style={{ flex: 1, padding: "7px 12px", borderRadius: 8, border: `1.5px solid ${discountEnabled ? cfg.color + "40" : "#e5e7eb"}`, fontSize: 13, fontWeight: 700, color: discountEnabled ? "#1d1d2f" : "#9ca3af", background: discountEnabled ? "#fff" : "#f9fafb", outline: "none", minWidth: 0 }}
            />
          </div>
        )}

        <textarea value={text} onChange={(e) => { dirtyRef.current = true; setActiveText(e.target.value); }} rows={4}
          placeholder={`Write your ${cfg.label.toLowerCase()} message here…`}
          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #e4e4ee", fontSize: 13, color: "#1d1d2f", lineHeight: 1.65, resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />

        {showPreview && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#9999b0", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>Preview — sample data</div>
            <div style={{ background: "#e5ddd5", borderRadius: 12, padding: "14px", backgroundImage: "url('https://www.transparenttextures.com/patterns/45-degree-fabric-light.png')" }}>
              <div style={{ background: "#dcf8c6", borderRadius: "12px 12px 2px 12px", padding: "10px 14px", maxWidth: "90%", marginLeft: "auto", fontSize: 13, color: "#1d1d2f", lineHeight: 1.6, whiteSpace: "pre-wrap", boxShadow: "0 1px 2px rgba(0,0,0,0.15)" }}>
                {preview || <span style={{ color: "#b0b0c8", fontStyle: "italic" }}>Write a message above to preview</span>}
                <div style={{ fontSize: 10, color: "#7a9a7a", textAlign: "right", marginTop: 5 }}>
                  {new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })} ✓✓
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 2 }}>
          <div style={{ fontSize: 11, color: charCount > 1000 ? "#dc2626" : "#b0b0c8" }}>
            {charCount} chars {charCount > 1000 && "· Consider shortening"}
          </div>
          <button type="button" onClick={save}
            style={{ display: "flex", alignItems: "center", gap: 6, border: "none", borderRadius: 9, padding: "8px 18px", fontSize: 12, fontWeight: 800, cursor: "pointer", transition: "all 0.15s", background: saved ? "#ecfdf5" : `linear-gradient(135deg, ${cfg.color}, ${cfg.color}cc)`, color: saved ? "#059669" : "#fff" }}>
            {saved ? <><Check size={12} /> Saved</> : <><Save size={12} /> Save Template</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

// Plan gate lives in its own component so every hook below runs unconditionally —
// hooks after an early return change order the moment the gate flips.
export default function MessagesPage() {
  const waPlan = getCurrentPlan();
  if (!waPlan.whatsapp) {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f6f9", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ maxWidth: 460, width: "100%", margin: "0 auto", textAlign: "center", padding: "0 24px" }}>
          <div style={{ width: 72, height: 72, borderRadius: 20, background: "linear-gradient(135deg,#5B21B6,#9333EA)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", boxShadow: "0 8px 28px rgba(91,33,182,0.35)" }}>
            <span style={{ fontSize: 34 }}>💬</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#1a1a2e", marginBottom: 10 }}>WhatsApp Automation</div>
          <div style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.7, marginBottom: 28 }}>
            Automated WhatsApp reminders, booking confirmations, follow-ups, and low-stock alerts are available on the <strong>Salon Central Pro</strong> and <strong>Salon Central Premium</strong> plans.
          </div>
          <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #ebebf0", padding: "20px 22px", marginBottom: 24, textAlign: "left", display: "flex", flexDirection: "column", gap: 10 }}>
            {["Appointment reminders sent automatically", "Booking confirmation messages", "Post-visit follow-up messages", "Low inventory stock alerts", "Manual WhatsApp sends with templates"].map(f => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ fontSize: 11 }}>✓</span>
                </div>
                <span style={{ fontSize: 13, color: "#374151" }}>{f}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: "#9898b0" }}>Current plan:</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: waPlan.color, background: waPlan.bg, borderRadius: 20, padding: "2px 12px", border: `1px solid ${waPlan.color}30` }}>{waPlan.label}</span>
          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <a href="/dashboard/billing" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "13px 28px", borderRadius: 12, background: "linear-gradient(135deg,#7C3AED,#9333EA)", color: "#fff", fontSize: 14, fontWeight: 800, textDecoration: "none", boxShadow: "0 4px 16px rgba(124,58,237,0.38)" }}>
              Contact Sales for Pro →
            </a>
            <a href="/dashboard/billing" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "13px 28px", borderRadius: 12, background: "linear-gradient(135deg,#9333EA,#A855F7)", color: "#fff", fontSize: 14, fontWeight: 800, textDecoration: "none", boxShadow: "0 4px 16px rgba(147,51,234,0.38)" }}>
              Contact Sales for Premium →
            </a>
          </div>
        </div>
      </div>
    );
  }
  return <MessagesPageContent />;
}

function MessagesPageContent() {
  const [tab, setTab]           = useState<"messages" | "templates">("messages");
  const [logs, setLogs]         = useState<WaLogEntry[]>([]);
  const [clients, setClients]   = useState<Client[]>([]);
  const [filter, setFilter]     = useState<WaMsgType | "all">("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadingLogs, setLoadingLogs] = useState(true);
  // Accurate stat-card counts, computed server-side over the FULL log table
  // (see /api/wa/messages `stats` mode) — not derived from the row-limited
  // `logs` list below, which is only ever a recent slice for the table.
  const [serverStats, setServerStats] = useState<{ todayCount: number; weekSent: number; weekFailed: number; weekCount: number } | null>(null);

  // Birthday reminder settings
  const bdDefaults = settingsStore.birthday as { autoBirthday: boolean; birthdayDiscount: string; birthdayDiscountEnabled?: boolean };
  const [bdEnabled,    setBdEnabled]    = useState(bdDefaults.autoBirthday);
  const [bdDiscountEnabled, setBdDiscountEnabled] = useState(bdDefaults.birthdayDiscountEnabled !== false);
  const [bdDiscount,   setBdDiscount]   = useState(bdDefaults.birthdayDiscount);
  const [bdSaving,     setBdSaving]     = useState(false);
  const [bdSaved,      setBdSaved]      = useState(false);
  const [bdSending,    setBdSending]    = useState(false);
  const [bdSendDone,   setBdSendDone]   = useState(false);

  // Win-back (lapsed client) settings
  const wbDefaults = resolveWinbackConfig(settingsStore);
  const [wbEnabled,     setWbEnabled]     = useState(wbDefaults.autoWinback);
  const [wbDays,        setWbDays]        = useState(String(wbDefaults.daysInactive));
  const [wbCooldown,    setWbCooldown]    = useState(String(wbDefaults.cooldownDays));
  const [wbNeverVisited, setWbNeverVisited] = useState(wbDefaults.includeNeverVisited);
  const [wbSaving,      setWbSaving]      = useState(false);
  const [wbSaved,       setWbSaved]       = useState(false);
  const [wbSending,     setWbSending]     = useState(false);
  const [wbResult,      setWbResult]      = useState<{ ok: boolean; message: string } | null>(null);
  const [showWbPicker,  setShowWbPicker]  = useState(false);
  const [resending,     setResending]     = useState(false);
  const [resendResult,  setResendResult]  = useState<{ ok: boolean; message: string } | null>(null);

  // Recomputed as the days field is edited so the owner sees how many clients a
  // given window actually reaches before committing to it. Invoices count as
  // visits alongside appointments — a till-driven salon may have no appointments
  // at all.
  const winbackAudience = useMemo(() => {
    const days = Number(wbDays);
    if (!Number.isFinite(days) || days <= 0) return null;
    return summarizeWinbackAudience(
      clients,
      getStoredAppointments(),
      days,
      Date.now(),
      getSalonInvoices().map((invoice) => ({ clientId: invoice.clientId, date: invoice.date })),
    );
  }, [clients, wbDays]);
  const lapsedClients = winbackAudience?.lapsed ?? [];
  const neverVisitedClients = winbackAudience?.neverVisited ?? [];
  const winbackTargetCount = lapsedClients.length + (wbNeverVisited ? neverVisitedClients.length : 0);
  // Everyone the picker can offer: lapsed first (longest gone at the top), then
  // never-visited — listed whatever that checkbox says, since picking is explicit.
  const winbackCandidates = useMemo<WinbackCandidate[]>(() => [
    ...(winbackAudience?.lapsed ?? []).map(({ client, lastVisit, daysSinceVisit }) => ({ id: client.id, name: client.name, phone: client.phone ?? "", note: `Last visit ${lastVisit} · ${daysSinceVisit} days ago` })),
    ...(winbackAudience?.neverVisited ?? []).map((client) => ({ id: client.id, name: client.name, phone: client.phone ?? "", note: "Never visited" })),
  ], [winbackAudience]);

  // "Nobody qualifies" is often the correct answer, so say which rule produced it
  // rather than leaving the owner to guess whether the feature is broken.
  const winbackEmptyReason = useMemo(() => {
    if (!winbackAudience) return "Enter a number of days above.";
    const { totalClients, excluded } = winbackAudience;
    if (totalClients === 0) return "No clients on file for this location/section yet.";
    const parts: string[] = [];
    if (excluded.visitedRecently) parts.push(`${excluded.visitedRecently} visited within ${wbDays} days`);
    if (excluded.neverVisited) parts.push(`${excluded.neverVisited} have no recorded visit`);
    if (excluded.upcomingBooking) parts.push(`${excluded.upcomingBooking} already have an upcoming booking`);
    if (excluded.optedOut) parts.push(`${excluded.optedOut} opted out of marketing`);
    if (excluded.noPhone) parts.push(`${excluded.noPhone} have no phone number`);
    return `None of your ${totalClients} clients qualify: ${parts.join(", ")}.`;
  }, [winbackAudience, wbDays]);

  const todayBirthdayClients = useMemo(() => {
    const today = new Date();
    return clients.filter((c) => {
      if (!c.dob || !c.phone) return false;
      const [, m, d] = c.dob.split("-").map(Number);
      return m === today.getMonth() + 1 && d === today.getDate();
    });
  }, [clients]);

  async function saveBirthdaySettings() {
    setBdSaving(true);
    // Persist locally
    const bd = settingsStore.birthday as Record<string, unknown>;
    bd.autoBirthday     = bdEnabled;
    bd.birthdayDiscountEnabled = bdDiscountEnabled;
    bd.birthdayDiscount = bdDiscount;
    saveSettings();
    setBdSaving(false);
    setBdSaved(true);
    setTimeout(() => setBdSaved(false), 2500);
  }

  async function sendBirthdayNow() {
    setBdSending(true);
    await checkBirthdayReminders(true); // force=true bypasses the "already sent" dedup
    setBdSending(false);
    setBdSendDone(true);
    setTimeout(() => setBdSendDone(false), 3000);
    setRefreshKey((k) => k + 1);
  }

  function saveWinbackSettings() {
    setWbSaving(true);
    const wb = settingsStore.winback as Record<string, unknown>;
    wb.autoWinback = wbEnabled;
    wb.winbackDaysInactive = Number(wbDays) > 0 ? Number(wbDays) : WINBACK_DEFAULTS.daysInactive;
    wb.winbackCooldownDays = Number(wbCooldown) > 0 ? Number(wbCooldown) : WINBACK_DEFAULTS.cooldownDays;
    delete wb.winbackDailyLimit; // retired — the daily cap is fixed at 15-20
    wb.winbackIncludeNeverVisited = wbNeverVisited;
    const dbSaved = saveSettings();
    setWbSaving(false);
    setWbSaved(true);
    setTimeout(() => setWbSaved(false), 2500);
    return dbSaved;
  }

  // Queues server-side (unlike the birthday test send, which runs in this tab) so
  // the batch keeps draining across its multi-hour spread even if this page closes.
  /** @param clientIds only these clients (the picker); omit to queue everyone eligible. */
  async function queueWinbackNow(clientIds?: string[]) {
    setWbSending(true);
    setWbResult(null);
    try {
      // The server reads the saved settings, so unsaved edits (days, never-visited) must land first.
      await saveWinbackSettings();
      const res = await fetch("/api/whatsapp/queue-winback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clientIds ? { clientIds } : {}),
      });
      const data = await res.json() as { ok?: boolean; queued?: number; eligible?: number; skipped?: number; dailyCap?: number; error?: string };
      if (data.ok && clientIds) {
        const queued = data.queued ?? 0;
        const left = clientIds.length - queued;
        setWbResult({
          ok: queued > 0,
          message: `Queued ${queued} of the ${clientIds.length} client${clientIds.length === 1 ? "" : "s"} you picked, spread over the next 7\u20138 hours.`
            + (left > 0 ? ` ${left} not queued \u2014 today\u2019s limit of ${data.dailyCap ?? WINBACK_DAILY_MAX} reached, messaged within the cooldown, already in the queue, or no valid number. Pick the rest again tomorrow.` : ""),
        });
        if (queued > 0) setShowWbPicker(false);
      } else if (data.ok) {
        setWbResult({
          ok: true,
          message: data.queued
            ? `Queued ${data.queued} win-back message${data.queued > 1 ? "s" : ""}, spread over the next 7\u20138 hours${data.skipped ? ` · ${data.skipped} held back (daily cap or cooldown)` : ""}.`
            : `Nothing to queue — today's limit of ${data.dailyCap ?? WINBACK_DAILY_MAX} is used up, or every lapsed client is inside their cooldown window.`,
        });
      } else {
        setWbResult({ ok: false, message: data.error || "Could not queue win-back messages." });
      }
    } catch {
      setWbResult({ ok: false, message: "Network error — could not reach the server." });
    } finally {
      setWbSending(false);
      setRefreshKey((k) => k + 1);
    }
  }

  // Puts invoices and win-backs that gave up after their retries back in the
  // queue rather than sending here — they go out on the same paced schedule as
  // any other automated message, 25-45 min apart, and anything already
  // delivered is skipped so no client gets the same message twice.
  async function resendFailed() {
    setResending(true);
    setResendResult(null);
    try {
      const res = await fetch("/api/whatsapp/requeue-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kinds: ["invoice", "winback"] }),
      });
      const data = await res.json() as { ok?: boolean; invoiceRequeued?: number; winbackRequeued?: number; skippedAlreadySent?: number; skippedDuplicate?: number; error?: string };
      if (data.ok) {
        const total = (data.invoiceRequeued ?? 0) + (data.winbackRequeued ?? 0);
        setResendResult({
          ok: true,
          message: total
            ? `Requeued ${data.invoiceRequeued ?? 0} invoice${(data.invoiceRequeued ?? 0) === 1 ? "" : "s"} and ${data.winbackRequeued ?? 0} win-back${(data.winbackRequeued ?? 0) === 1 ? "" : "s"}, going out 25-45 min apart${data.skippedAlreadySent ? ` · ${data.skippedAlreadySent} skipped (already delivered)` : ""}.`
            : "Nothing to resend — no invoices or win-backs have used up their retries.",
        });
        if (data.skippedDuplicate) setResendResult((r) => r && {
          ...r,
          message: `${r.message} ${data.skippedDuplicate} duplicate invoice${data.skippedDuplicate === 1 ? " was" : "s were"} held back (same client, day and amount).`,
        });
      } else {
        setResendResult({ ok: false, message: data.error || "Could not resend failed messages." });
      }
    } catch {
      setResendResult({ ok: false, message: "Network error — could not reach the server." });
    } finally {
      setResending(false);
      setRefreshKey((k) => k + 1);
    }
  }

  // Load logs: try Turso first, fall back to localStorage
  useEffect(() => {
    async function load() {
      setLoadingLogs(true);
      const user = getCurrentUser();
      if (user) {
        try {
          const res = await fetch(`/api/wa/messages?userId=${encodeURIComponent(user.id)}&limit=200`);
          if (res.ok) {
            const data = await res.json() as { ok: boolean; logs: WaLogEntry[] };
            if (data.ok && Array.isArray(data.logs) && data.logs.length > 0) {
              setLogs(data.logs.filter(isVisibleWaLog));
              setLoadingLogs(false);
              setClients(getStoredClients().filter(c => inSection(c, getActiveSection())));
              void loadStats(user.id);
              return;
            }
          }
        } catch { /* fall through to localStorage */ }
      }
      // Fallback: localStorage
      setLogs(getWaLogs().filter(isVisibleWaLog));
      setClients(getStoredClients().filter(c => inSection(c, getActiveSection())));
      setLoadingLogs(false);
      setServerStats(null); // no server to ask — stat cards fall back to the (capped) local log list
    }
    async function loadStats(userId: string) {
      // "Today" is the salon's local calendar day, not the server's UTC day —
      // computed here in the browser so it matches whatever timezone the
      // owner is actually in.
      const todaySince = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
      const weekSince = new Date(Date.now() - 7 * 86_400_000).toISOString();
      try {
        const res = await fetch(`/api/wa/messages?userId=${encodeURIComponent(userId)}&stats=1&todaySince=${encodeURIComponent(todaySince)}&weekSince=${encodeURIComponent(weekSince)}`);
        const data = await res.json() as { ok: boolean; todayCount?: number; weekSent?: number; weekFailed?: number; weekCount?: number };
        if (data.ok) {
          setServerStats({ todayCount: data.todayCount ?? 0, weekSent: data.weekSent ?? 0, weekFailed: data.weekFailed ?? 0, weekCount: data.weekCount ?? 0 });
        }
      } catch { /* stat cards fall back to the (capped) local log list */ }
    }
    load();
  }, [refreshKey]);

  useEffect(() => {
    function onMessageLogged(event: Event) {
      const entry = (event as CustomEvent<WaLogEntry>).detail;
      if (!entry?.id) return;
      if (!isVisibleWaLog(entry)) return;
      setLogs((current) => current.some((item) => item.id === entry.id) ? current : [entry, ...current]);
    }
    window.addEventListener("werzio_wa_message_logged", onMessageLogged);
    return () => window.removeEventListener("werzio_wa_message_logged", onMessageLogged);
  }, []);

  // Queue counts change outside this page (background scheduler + server queues).
  // Poll so the banner cannot get stuck showing a stale non-zero count after the
  // queue has actually drained.
  const [queueCounts, setQueueCounts] = useState({ confirm: 0, followup: 0, booking: 0, pos: 0, due: 0 });
  const [pendingQueue, setPendingQueue] = useState<PendingQueueItem[]>([]);
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [queueDetails, setQueueDetails] = useState<QueueDetailItem[]>([]);
  const [queueDetailsLoading, setQueueDetailsLoading] = useState(false);
  const [bdInstantSendingId, setBdInstantSendingId] = useState<string | null>(null);
  const [bdInstantResult, setBdInstantResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function sendQueuedBirthdayInstant(item: PendingQueueItem) {
    setBdInstantSendingId(item.apptId);
    setBdInstantResult(null);
    const name = item.clientName || "client";
    try {
      const result = await sendQueuedBirthdayNow(item.apptId);
      setBdInstantResult(
        result === "sent" ? { ok: true, message: `Birthday message sent to ${name}.` }
        : result === "already-sent" ? { ok: true, message: `${name} already received today's birthday message.` }
        : result === "not-queued" ? { ok: false, message: `${name} is no longer in the queue.` }
        : result === "no-template" ? { ok: false, message: "No birthday template is set up." }
        : { ok: false, message: `Could not send to ${name} — it will retry automatically.` },
      );
    } catch {
      setBdInstantResult({ ok: false, message: `Could not send to ${name}.` });
    } finally {
      setBdInstantSendingId(null);
      setPendingQueue(getPendingWhatsAppQueue());
      setRefreshKey((k) => k + 1);
      setTimeout(() => setBdInstantResult(null), 4000);
    }
  }

  async function openQueueDetails() {
    setShowQueueModal(true);
    setQueueDetailsLoading(true);
    try {
      const res = await fetch("/api/whatsapp/queue-details", { cache: "no-store" });
      const data = await res.json() as { ok?: boolean; items?: QueueDetailItem[] };
      setQueueDetails(data.ok && data.items ? data.items : []);
    } catch {
      setQueueDetails([]);
    } finally {
      setQueueDetailsLoading(false);
    }
  }

  useEffect(() => {
    async function refreshQueueCounts() {
      setPendingQueue(getPendingWhatsAppQueue());
      let booking = 0;
      let pos = 0;
      let due = 0;
      try {
        const res = await fetch("/api/whatsapp/queue-status", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json() as {
            ok?: boolean;
            bookingPending?: number;
            posPending?: number;
            totalDue?: number;
          };
          if (data.ok) {
            booking = data.bookingPending ?? 0;
            pos = data.posPending ?? 0;
            due = data.totalDue ?? 0;
          }
        }
      } catch { /* DB queue status is best-effort; local queues still show below */ }
      setQueueCounts({
        confirm: getQueueLength("werzio_wa_confirm_queue"),
        followup: getQueueLength("werzio_wa_followup_queue"),
        booking,
        pos,
        due,
      });
    }
    void refreshQueueCounts();
    const interval = window.setInterval(refreshQueueCounts, 5000);
    window.addEventListener("werzio_wa_message_logged", refreshQueueCounts);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("werzio_wa_message_logged", refreshQueueCounts);
    };
  }, []);

  const ws = settingsStore.wasender as {
    enabled?: boolean; provider?: "wasender" | "botsailor" | "zaptick" | "chakra" | "ycloud"; apiKey: string; botSailorApiToken?: string; botSailorPhoneNumberId?: string; zaptickApiKey?: string; chakraAccessToken?: string; chakraPluginId?: string; chakraWhatsappPhoneNumberId?: string; ownerPhone: string;
    autoReminder: boolean; autoConfirmation: boolean; autoFollowup: boolean;
    autoCancellation: boolean; autoLowStock: boolean;
  };
  // Keys are admin-managed and stay on the server; it reports `connected`.
  const isConfigured = whatsAppConnected(ws);
  const [testingConn, setTestingConn] = useState(false);
  const [connStatus, setConnStatus] = useState<{ ok: boolean; message?: string; status?: string } | null>(null);
  // Use the real API result when available; null = still checking, true/false = known
  const isConnected = isConfigured ? (connStatus === null ? null : connStatus.ok) : false;

  async function testConnection() {
    if (!isConfigured || testingConn) return;
    setTestingConn(true);
    setConnStatus(null);
    try {
      const res = await fetch("/api/whatsapp/status?force=1");
      const data = await res.json() as { ok: boolean; connected: boolean; status?: string; message?: string; error?: string };
      setConnStatus({ ok: data.connected, message: data.message || data.error, status: data.status });
    } catch {
      setConnStatus({ ok: false, message: "Network error" });
    } finally {
      setTestingConn(false);
    }
  }

  // Auto-check real connection status on mount so the banner reflects reality
  useEffect(() => {
    if (isConfigured) testConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() =>
    filter === "all" ? logs : logs.filter((l) => l.type === filter),
    [logs, filter],
  );

  // Stats — prefer serverStats (accurate, computed over the full log table);
  // fall back to deriving from the row-limited `logs` list only when the
  // server call didn't come back (e.g. offline, using the localStorage log).
  const localTodayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const weekAgo     = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const todayCount  = serverStats ? serverStats.todayCount : logs.filter((l) => l.timestamp >= localTodayStart).length;
  const weekSent    = serverStats ? serverStats.weekSent   : logs.filter((l) => l.timestamp >= weekAgo && l.status === "sent").length;
  const weekFailed  = serverStats ? serverStats.weekFailed : logs.filter((l) => l.timestamp >= weekAgo && l.status === "failed").length;
  const weekCount   = serverStats ? serverStats.weekCount  : weekSent + weekFailed;
  const failCount   = weekFailed;
  const successRate = weekCount > 0 ? Math.round((weekSent / weekCount) * 100) : 100;
  const totalQueue = queueCounts.confirm + queueCounts.followup + queueCounts.booking + queueCounts.pos;

  // Group logs by day
  const grouped = useMemo(() => {
    const groups: { day: string; items: WaLogEntry[] }[] = [];
    for (const log of filtered) {
      const day = dayLabel(log.timestamp);
      const last = groups[groups.length - 1];
      if (last?.day === day) last.items.push(log);
      else groups.push({ day, items: [log] });
    }
    return groups;
  }, [filtered]);

  function openWa(phone: string, message?: string) {
    const num = phone.replace(/\D/g, "");
    window.open(message ? `https://wa.me/${num}?text=${encodeURIComponent(message)}` : `https://wa.me/${num}`, "_blank");
  }

  return (
    <div className="dashboard-polish" style={{ minHeight: "100vh", background: "#f5f6f9" }}>
      <div className="dashboard-topbar" style={{ paddingLeft: 25 }}>
        <DashboardHeader title="WhatsApp Messaging" subtitle="Send & manage client messages" icon={<MessageSquare size={24} />} />
      </div>

      {/* ── Native mobile app bar ── */}
      <MobilePageHeader
        title="WhatsApp"
        subtitle={isConnected ? "Connected · Live" : "Not configured"}
        action={{ label: "Settings", href: "/dashboard/account" }}
      />

      {/* ── Mobile connection status ── */}
      <div className="mobile-only" style={{ margin: "10px 16px 0", padding: "12px 14px", borderRadius: 16, display: "flex", alignItems: "center", gap: 10, background: isConnected ? "linear-gradient(135deg,#4C1D95,#9333EA)" : "#1a1a2e", color: "#fff" }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {isConnected ? <Wifi size={18} /> : <WifiOff size={18} />}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>{isConnected ? "WhatsApp Connected" : "Not Configured"}</div>
          <div style={{ fontSize: 10, opacity: 0.72, marginTop: 2 }}>{isConnected ? "WaSenderAPI connected" : "Tap Settings to connect"}</div>
        </div>
        {isConnected && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 8px #4ade80", flexShrink: 0 }} />}
      </div>

      {/* ── Mobile stats ── */}
      <div className="mobile-stat-scroll mobile-only">
        {[
          { label: "Today",    value: todayCount,       color: "#7C3AED" },
          { label: "This Week", value: weekCount,       color: "#0284c7" },
          { label: "Failed",   value: failCount,        color: "#dc2626" },
          { label: "Success",  value: `${successRate}%`, color: "#059669" },
        ].map((s) => (
          <div key={s.label} className="mobile-stat-card">
            <div className="mobile-stat-card-label">{s.label}</div>
            <div className="mobile-stat-card-value" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* ── Mobile tab bar ── */}
      <div className="mobile-tab-bar mobile-only">
        {[{ id: "messages", label: "Messages" }, { id: "templates", label: "Templates" }].map((t) => (
          <button key={t.id} type="button" className={`mobile-tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id as typeof tab)}>{t.label}</button>
        ))}
      </div>

      {/* ── Mobile: Message log list ── */}
      {tab === "messages" && (
        <div className="mobile-only">
          {filtered.length === 0 ? (
            <div className="mobile-empty">
              <div className="mobile-empty-icon"><MessageSquare size={26} color="#c8c8e0" /></div>
              <div className="mobile-empty-title">No messages yet</div>
              <div className="mobile-empty-sub">{isConnected ? "Messages appear here once the scheduler sends them." : "Connect WhatsApp in Account settings."}</div>
            </div>
          ) : (
            <>
              <div className="mobile-filter-row">
                {FILTERS.map((f) => (
                  <button key={f.value} type="button" className={`mobile-filter-chip ${filter === f.value ? "active" : ""}`} onClick={() => setFilter(f.value)}>{f.label}</button>
                ))}
              </div>
              <div className="mobile-list">
                {filtered.map((log) => {
                  const m = TYPE_META[log.type as WaMsgType] ?? TYPE_META.manual;
                  const Icon = m.icon;
                  return (
                    <div key={log.id} className="mobile-list-card">
                      <div className="mobile-list-icon" style={{ background: m.bg }}><Icon size={18} color={m.color} /></div>
                      <div className="mobile-list-body">
                        <div className="mobile-list-title">{log.clientName}</div>
                        <div className="mobile-list-sub">{log.phone} · {fmtTime(log.timestamp)}</div>
                      </div>
                      <div className="mobile-list-right">
                        <span className="mobile-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>
                        <span className="mobile-badge" style={{ background: log.status === "sent" ? "#ecfdf5" : "#fef2f2", color: log.status === "sent" ? "#059669" : "#dc2626" }}>{log.status === "sent" ? "✓ Sent" : "✗ Failed"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Mobile: Templates ── */}
      {tab === "templates" && (
        <div className="mobile-only" style={{ padding: "0 16px 24px" }}>
          <div style={{ marginTop: 10, padding: "12px 14px", borderRadius: 14, background: "#f5f4ff", border: "1px solid #ddd6fe", marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#5B21B6", marginBottom: 4 }}>💡 How templates work</div>
            <div style={{ fontSize: 12, color: "#6a6a8a", lineHeight: 1.65 }}>Write your message, copy it, then paste when creating a template in Meta Business Manager. Click variable chips to insert them.</div>
          </div>
          {TPL_CONFIG.map((cfg) => <TemplateCard key={cfg.key} cfg={cfg} />)}
        </div>
      )}

      <div className="dash-page desktop-only" style={{ paddingTop: 0 }}>

        {/* ── Connection Banner ─────────────────────────────────────────── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 22px", borderRadius: 16, marginBottom: 22,
          background: isConnected === true
            ? "linear-gradient(135deg, #4C1D95 0%, #7C3AED 60%, #9333EA 100%)"
            : isConnected === false
              ? "linear-gradient(135deg,#7f1d1d,#991b1b)"
              : "#1a1a2e",
          boxShadow: isConnected === true ? "0 4px 24px rgba(124,58,237,0.35)" : "0 2px 12px rgba(0,0,0,0.12)",
          color: "#fff",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 13, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {isConnected === true ? <Wifi size={22} /> : <WifiOff size={22} />}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: "-0.01em" }}>
                {isConnected === true  && "WhatsApp Connected"}
                {isConnected === false && "WhatsApp Disconnected"}
                {isConnected === null  && "WhatsApp — Checking…"}
                {!isConfigured         && "WhatsApp Not Configured"}
              </div>
              <div style={{ fontSize: 11, opacity: 0.72, marginTop: 3 }}>
                {isConnected === true  && "WaSenderAPI connected · Scheduler runs every 60s"}
                {isConnected === false && (connStatus?.message || "Phone may have lost internet — automated messages paused")}
                {isConnected === null  && "Verifying connection with WaSender…"}
                {!isConfigured         && "Go to Account → WhatsApp Settings to connect your number"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {/* Status pill — only when we have a real result */}
            {isConfigured && connStatus && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, background: connStatus.ok ? "rgba(74,222,128,0.15)" : "rgba(239,68,68,0.18)", borderRadius: 20, padding: "5px 10px", border: `1px solid ${connStatus.ok ? "rgba(74,222,128,0.4)" : "rgba(239,68,68,0.4)"}` }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: connStatus.ok ? "#4ade80" : "#ef4444", boxShadow: connStatus.ok ? "0 0 8px #4ade80" : "0 0 8px #ef4444" }} />
                <span style={{ fontSize: 11, fontWeight: 700 }}>{connStatus.ok ? `Active (${connStatus.status || "CONNECTED"})` : (connStatus.message || "Session error")}</span>
              </div>
            )}
            {/* Checking spinner pill */}
            {isConfigured && isConnected === null && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.12)", borderRadius: 20, padding: "5px 12px" }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#fcd34d", boxShadow: "0 0 8px #fcd34d" }} />
                <span style={{ fontSize: 11, fontWeight: 700 }}>Checking…</span>
              </div>
            )}
            {isConfigured && (
              <button type="button" onClick={testConnection} disabled={testingConn}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.28)", borderRadius: 9, padding: "7px 12px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: testingConn ? "wait" : "pointer", opacity: testingConn ? 0.7 : 1 }}>
                <Wifi size={11} /> {testingConn ? "Testing…" : "Test Connection"}
              </button>
            )}
            <a href="/dashboard/account"
              style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.28)", borderRadius: 9, padding: "8px 14px", color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
              {isConfigured ? "Settings" : "Configure"} <ChevronRight size={12} />
            </a>
          </div>
        </div>

        {/* ── Stats Row ─────────────────────────────────────────────────── */}
        <div className="stats-grid-4" style={{ marginBottom: 24 }}>
          {[
            { label: "Sent Today",    value: todayCount,  icon: Send,        color: "#7C3AED", sub: "messages dispatched" },
            { label: "This Week",     value: weekCount,   icon: TrendingUp,  color: "#0284c7", sub: "last 7 days" },
            { label: "Failed",        value: failCount,   icon: XCircle,     color: "#dc2626", sub: failCount > 0 ? "check API credentials" : "all clear ✓" },
            { label: "Success Rate",  value: `${successRate}%`, icon: Zap,   color: "#059669", sub: `${weekSent} of ${weekCount} sent this week` },
          ].map(({ label, value, icon: Icon, color, sub }) => (
            <div key={label} style={{ background: "#fff", border: "1px solid #ebebf5", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, right: 0, width: 80, height: 80, borderRadius: "0 16px 0 100%", background: color + "08" }} />
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: "#9999b0", fontWeight: 600 }}>{label}</div>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: color + "15", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon size={15} color={color} />
                </div>
              </div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#1d1d2f", lineHeight: 1 }}>{value}</div>
              <div style={{ fontSize: 11, color: "#b0b0c8", marginTop: 6 }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* ── Tab Switcher ──────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 4, background: "#ecedf5", borderRadius: 12, padding: 4, marginBottom: 22, width: "fit-content" }}>
          {[
            { id: "messages",  label: "Message Log",  badge: logs.length > 0 ? logs.length : null },
            { id: "templates", label: "Templates",    badge: null },
          ].map(({ id, label, badge }) => (
            <button key={id} type="button" onClick={() => setTab(id as typeof tab)}
              style={{ display: "flex", alignItems: "center", gap: 7, border: "none", borderRadius: 9, padding: "8px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", background: tab === id ? "#fff" : "transparent", color: tab === id ? "#1d1d2f" : "#9999b0", boxShadow: tab === id ? "0 1px 6px rgba(0,0,0,0.10)" : "none", transition: "all 0.15s" }}>
              {label}
              {badge !== null && (
                <span style={{ background: tab === id ? "var(--accent)" : "#c8c8e0", color: "#fff", borderRadius: 20, fontSize: 10, fontWeight: 800, padding: "1px 7px", minWidth: 20, textAlign: "center" }}>
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ══════════════════ TEMPLATES TAB ══════════════════ */}
        {tab === "templates" && (
          <div>
            <div style={{ background: "linear-gradient(135deg, #f5f4ff, #fdf4ff)", border: "1px solid #ddd6fe", borderRadius: 14, padding: "16px 20px", marginBottom: 22, display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>💡</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#5B21B6", marginBottom: 4 }}>How templates work</div>
                <div style={{ fontSize: 12, color: "#6a6a8a", lineHeight: 1.65 }}>
                  Write your message, <strong>Copy</strong> it, then paste it when creating a WhatsApp template in Meta Business Manager.
                  Click any <code style={{ background: "#ede9fe", borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>{"{{variable}}"}</code> chip to insert it into the message.
                  Use <strong>Preview</strong> to see how it looks with sample client data.
                </div>
              </div>
            </div>
            <div className="two-col-grid" style={{ gap: 18 }}>
              {TPL_CONFIG.map((cfg) => <TemplateCard key={cfg.key} cfg={cfg} />)}
            </div>
          </div>
        )}

        {/* ══════════════════ MESSAGES TAB ══════════════════ */}
        {tab === "messages" && (
          <div className="sidebar-layout">

            {/* ── Left: Message Log ── */}
            <div style={{ background: "#fff", border: "1px solid #e8e8f0", borderRadius: 18, overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }}>

              {/* Log header */}
              <div style={{ padding: "16px 20px", borderBottom: "1px solid #f0f0f8", background: "#fafafd" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#1d1d2f", flexShrink: 0 }}>Message Log</div>
                    {loadingLogs && <div style={{ fontSize: 11, color: "#9999b0" }}>Loading…</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <button type="button" onClick={resendFailed} disabled={resending}
                      title="Resend invoices and win-backs that failed every retry — 25-45 min apart, skipping anything already delivered"
                      style={{ border: "1px solid #e8e8f0", background: "#fff", borderRadius: 8, padding: "6px 10px", cursor: resending ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "#6a6a8a" }}>
                      <RotateCcw size={13} color="#9999b0" />
                      {resending ? "Requeueing…" : "Resend failed"}
                    </button>
                    <button type="button" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh"
                      style={{ border: "1px solid #e8e8f0", background: "#fff", borderRadius: 8, padding: "6px 8px", cursor: "pointer", display: "flex", alignItems: "center" }}>
                      <RefreshCw size={13} color="#9999b0" />
                    </button>
                  </div>
                </div>
                {resendResult && (
                  <div style={{ marginBottom: 10, padding: "8px 11px", borderRadius: 8, fontSize: 11, fontWeight: 600, lineHeight: 1.55, background: resendResult.ok ? "#f0fdfa" : "#fef2f2", border: `1px solid ${resendResult.ok ? "#ccfbf1" : "#fecaca"}`, color: resendResult.ok ? "#115e59" : "#991b1b" }}>
                    {resendResult.message}
                  </div>
                )}
                {/* Filter pills — horizontally scrollable so they never clip on narrow panels */}
                <div style={{ display: "flex", gap: 3, background: "#f0f0f8", borderRadius: 9, padding: "3px", overflowX: "auto", scrollbarWidth: "none" }}>
                  {FILTERS.map((f) => (
                    <button key={f.value} type="button" onClick={() => setFilter(f.value)}
                      style={{ border: "none", borderRadius: 7, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", background: filter === f.value ? "#fff" : "transparent", color: filter === f.value ? "#1d1d2f" : "#9999b0", boxShadow: filter === f.value ? "0 1px 4px rgba(0,0,0,0.08)" : "none", transition: "all 0.12s", whiteSpace: "nowrap", flexShrink: 0 }}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Log body */}
              {filtered.length === 0 ? (
                <div style={{ padding: "60px 32px", textAlign: "center" }}>
                  <div style={{ width: 64, height: 64, borderRadius: 18, background: "linear-gradient(135deg, #f0f0f8, #e8e8f8)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
                    <MessageSquare size={26} color="#c8c8e0" />
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#9999b0", marginBottom: 8 }}>No messages yet</div>
                  <div style={{ fontSize: 12, color: "#c0c0d0", lineHeight: 1.65, maxWidth: 280, margin: "0 auto" }}>
                    {isConnected
                      ? "Messages will appear here once the WhatsApp scheduler sends them."
                      : "Connect your WhatsApp number in Account → WhatsApp Settings to start sending automated messages."}
                  </div>
                  {!isConnected && (
                    <a href="/dashboard/account" style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 18, padding: "9px 18px", borderRadius: 10, background: "linear-gradient(135deg,#5B21B6,#9333EA)", color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
                      Configure WhatsApp <ChevronRight size={13} />
                    </a>
                  )}
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <div style={{ minWidth: 600 }}>
                  {grouped.map(({ day, items }) => (
                    <div key={day}>
                      {/* Day separator */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px 6px", background: "#fafafd" }}>
                        <div style={{ height: 1, flex: 1, background: "#ededf5" }} />
                        <span style={{ fontSize: 10, fontWeight: 800, color: "#aaaabc", textTransform: "uppercase", letterSpacing: "0.08em", flexShrink: 0 }}>{day}</span>
                        <div style={{ height: 1, flex: 1, background: "#ededf5" }} />
                      </div>
                      {items.map((log) => (
                        <div key={log.id}
                          style={{ display: "grid", gridTemplateColumns: "110px 1fr 150px 120px 80px", alignItems: "center", padding: "10px 20px", borderBottom: "1px solid #f8f8fc", gap: 12, transition: "background 0.1s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#fafafe")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                          <div style={{ fontSize: 11, color: "#aaaabc", fontVariantNumeric: "tabular-nums" }}>{fmtTime(log.timestamp)}</div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "#1d1d2f" }}>{log.clientName}</div>
                            {log.templateId && <div style={{ fontSize: 10, color: "#b0b0c8", marginTop: 1 }}>tpl: {log.templateId}</div>}
                            {log.status === "failed" && log.error && (
                              <div style={{ fontSize: 10, color: "#dc2626", marginTop: 2, display: "flex", alignItems: "center", gap: 3 }}>
                                <AlertCircle size={9} /> {log.error}
                              </div>
                            )}
                          </div>
                          <button type="button" onClick={() => openWa(log.phone)} title={log.phone}
                            style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "1px solid #e8e8f0", borderRadius: 7, padding: "4px 10px", cursor: "pointer", color: "#6a6a8a", fontSize: 11, fontWeight: 600, minWidth: 0, overflow: "hidden" }}>
                            <Phone size={11} style={{ flexShrink: 0 }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.phone}</span>
                          </button>
                          <Badge type={log.type} />
                          <StatusChip status={log.status} />
                        </div>
                      ))}
                    </div>
                  ))}
                  </div>
                </div>
              )}
            </div>

            {/* ── Right column ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Automation Status */}
              <div style={{ background: "#fff", border: "1px solid #e8e8f0", borderRadius: 18, padding: "20px", boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#1d1d2f", marginBottom: 14 }}>Automation Status</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <AutoCard icon={Bell}         label="Appointment Reminder"  enabled={ws.autoReminder}     color="#7C3AED" />
                  <AutoCard icon={CheckCircle2} label="Booking Confirmation"  enabled={ws.autoConfirmation} color="#059669" />
                  <AutoCard icon={ThumbsUp}     label="Follow-up Message"     enabled={ws.autoFollowup}     color="#0284c7" />
                  <AutoCard icon={CalendarX}    label="Cancellation Win-back"    enabled={ws.autoCancellation} color="#dc2626" />
                  <AutoCard icon={Package}      label="Low Stock Alert"          enabled={ws.autoLowStock}     color="#ea580c" />
                  <AutoCard icon={Cake}         label="Birthday Reminder"     enabled={bdEnabled}           color="#db2777" />
                  <AutoCard icon={UserMinus}    label="Win-back (Lapsed)"     enabled={wbEnabled}           color="#0d9488" />
                </div>

                <div style={{ marginTop: 12, padding: "10px 13px", borderRadius: 10, background: totalQueue > 0 ? "#fffbeb" : "#f8f8fc", border: `1px solid ${totalQueue > 0 ? "#fde68a" : "#e8e8f0"}`, fontSize: 12, color: totalQueue > 0 ? "#92400e" : "#6b6b8a", fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Clock size={13} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>
                    {totalQueue > 0 ? (
                      <>
                        {totalQueue} message{totalQueue > 1 ? "s" : ""} queued
                        {queueCounts.pos > 0 ? ` · ${queueCounts.pos} POS receipt${queueCounts.pos > 1 ? "s" : ""}` : ""}
                        {queueCounts.booking > 0 ? ` · ${queueCounts.booking} booking message${queueCounts.booking > 1 ? "s" : ""}` : ""}
                        {queueCounts.due > 0 ? " · due now" : " · waiting for scheduled time"}
                      </>
                    ) : "No pending queue · view recent queue activity"}
                  </span>
                  <button type="button" onClick={openQueueDetails}
                    style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 5, border: `1px solid ${totalQueue > 0 ? "#fde68a" : "#e8e8f0"}`, background: "#fff", borderRadius: 7, padding: "4px 9px", fontSize: 11, fontWeight: 700, color: totalQueue > 0 ? "#92400e" : "#6b6b8a", cursor: "pointer" }}>
                    <ListChecks size={12} /> View details
                  </button>
                </div>

                {(pendingQueue.length > 0 || bdInstantResult) && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #f0f0f5", paddingTop: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "#7c7c9a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                      Queued on this device ({pendingQueue.length})
                    </div>
                    {bdInstantResult && (
                      <div style={{ marginBottom: 8, padding: "7px 10px", borderRadius: 8, fontSize: 11.5, fontWeight: 600, background: bdInstantResult.ok ? "#ecfdf5" : "#fef2f2", border: `1px solid ${bdInstantResult.ok ? "#a7f3d0" : "#fca5a5"}`, color: bdInstantResult.ok ? "#065f46" : "#991b1b" }}>
                        {bdInstantResult.message}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                      {pendingQueue.map((item, i) => {
                        const waitingUntil = item.sendAfter && item.sendAfter > Date.now() ? item.sendAfter : null;
                        return (
                          <div key={`${item.type}_${item.apptId}_${i}`}
                            style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", borderRadius: 9, background: "#f8f8fc", border: "1px solid #e8e8f0", fontSize: 12 }}>
                            <span style={{
                              flexShrink: 0, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em",
                              padding: "3px 7px", borderRadius: 6,
                              color: item.type === "confirmation" ? "#059669" : item.type === "followup" ? "#0284c7" : item.type === "cancellation" ? "#dc2626" : "#db2777",
                              background: item.type === "confirmation" ? "#ecfdf5" : item.type === "followup" ? "#eff6ff" : item.type === "cancellation" ? "#fef2f2" : "#fdf2f8",
                            }}>
                              {item.type}
                            </span>
                            <div style={{ flex: "1 1 120px", minWidth: 0 }}>
                              <div style={{ fontWeight: 700, color: "#1d1d2f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {item.clientName || "Unknown client"}
                              </div>
                              {(item.date || item.serviceNames?.length) && (
                                <div style={{ color: "#9999b0", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {item.serviceNames?.[0] ? `${item.serviceNames[0]} · ` : ""}{item.date}{item.startTime ? ` ${item.startTime}` : ""}
                                </div>
                              )}
                            </div>
                            <div style={{ flexShrink: 0, textAlign: "right", fontSize: 11, color: item.retries > 0 ? "#dc2626" : "#92400e", fontWeight: 600 }}>
                              {item.retries > 0
                                ? (waitingUntil ? `retry ${new Date(waitingUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "retrying")
                                : (waitingUntil ? new Date(waitingUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "due now")}
                            </div>
                            {item.type === "birthday" && (
                              <button type="button" onClick={() => void sendQueuedBirthdayInstant(item)} disabled={bdInstantSendingId !== null}
                                title="Send this birthday message now instead of waiting for its scheduled time"
                                style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 4, border: "1px solid #fbcfe8", background: "#fff", borderRadius: 7, padding: "4px 8px", fontSize: 11, fontWeight: 700, color: "#db2777", cursor: bdInstantSendingId !== null ? "wait" : "pointer", opacity: bdInstantSendingId !== null && bdInstantSendingId !== item.apptId ? 0.5 : 1 }}>
                                <Send size={11} /> {bdInstantSendingId === item.apptId ? "Sending…" : "Send now"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!isConnected && (
                  <div style={{ marginTop: 12, padding: "10px 13px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12, color: "#991b1b", fontWeight: 600, display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                    No API credentials configured — automation is paused.
                  </div>
                )}
              </div>

              {/* Birthday Reminder Settings */}
              <div style={{ background: "#fff", border: "1px solid #fce7f3", borderRadius: 18, padding: "20px", boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(219,39,119,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Cake size={16} color="#db2777" />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 900, color: "#1d1d2f" }}>Birthday Reminders</div>
                    <div style={{ fontSize: 11, color: "#9999b0", marginTop: 1 }}>1-5 birthdays go out early in the day, 35-55 min apart · 6+ are spread across ~6-8 hours</div>
                  </div>
                  {/* Toggle */}
                  <button type="button" onClick={() => setBdEnabled((v) => !v)}
                    style={{ marginLeft: "auto", width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: bdEnabled ? "#db2777" : "#d1d5db", transition: "background 0.2s", position: "relative", flexShrink: 0 }}>
                    <span style={{ position: "absolute", top: 3, left: bdEnabled ? 20 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Today's birthday clients */}
                  <div style={{ padding: "10px 12px", borderRadius: 9, background: todayBirthdayClients.length > 0 ? "#fdf2f8" : "#f8f8fc", border: `1px solid ${todayBirthdayClients.length > 0 ? "#fce7f3" : "#e8e8f0"}`, fontSize: 11, color: todayBirthdayClients.length > 0 ? "#9d174d" : "#6b6b8a", lineHeight: 1.6 }}>
                    {todayBirthdayClients.length > 0
                      ? <><strong>🎂 {todayBirthdayClients.length} client{todayBirthdayClients.length > 1 ? "s have" : " has"} a birthday today:</strong> {todayBirthdayClients.map((c) => c.name).join(", ")}</>
                      : "No clients have a birthday today. Make sure clients have their Date of Birth saved in their profile."}
                  </div>

                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 5 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: "#7c7c9a", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Discount / Gift (optional)
                      </label>
                      <button
                        type="button"
                        onClick={() => setBdDiscountEnabled((v) => !v)}
                        aria-label={`${bdDiscountEnabled ? "Disable" : "Enable"} birthday discount`}
                        style={{ width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: bdDiscountEnabled ? "#db2777" : "#d1d5db", transition: "background 0.2s", position: "relative", flexShrink: 0 }}
                      >
                        <span style={{ position: "absolute", top: 3, left: bdDiscountEnabled ? 20 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                      </button>
                    </div>
                    <input
                      value={bdDiscount}
                      onChange={(e) => setBdDiscount(e.target.value)}
                      disabled={!bdDiscountEnabled}
                      placeholder="e.g. 15% off or a free blow-dry"
                      style={{ width: "100%", height: 36, padding: "0 12px", borderRadius: 9, border: `1px solid ${bdDiscountEnabled ? "#e4e4ee" : "#e5e7eb"}`, fontSize: 13, color: bdDiscountEnabled ? "#29293d" : "#9ca3af", background: bdDiscountEnabled ? "#fff" : "#f9fafb", outline: "none", boxSizing: "border-box" }}
                    />
                    <div style={{ fontSize: 10, color: "#b0b0c8", marginTop: 4 }}>
                      {bdDiscountEnabled ? <>Inserted as {"{{discount}}"} in the birthday template</> : <>Discount is off — {"{{discount}}"} will be blank if used in the template</>}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={saveBirthdaySettings} disabled={bdSaving}
                      style={{ flex: 1, border: "none", borderRadius: 10, padding: "10px 0", fontSize: 12, fontWeight: 800, cursor: bdSaving ? "not-allowed" : "pointer", background: bdSaved ? "#ecfdf5" : "linear-gradient(135deg,#be185d,#db2777)", color: bdSaved ? "#059669" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, boxShadow: bdSaved ? "none" : "0 3px 10px rgba(219,39,119,0.3)" }}>
                      {bdSaved ? <><Check size={13} /> Saved</> : bdSaving ? "Saving…" : <><Save size={13} /> Save</>}
                    </button>
                    <button type="button" onClick={sendBirthdayNow} disabled={bdSending || todayBirthdayClients.length === 0}
                      title={todayBirthdayClients.length === 0 ? "No clients have a birthday today" : "Queue birthday messages across 4 hours"}
                      style={{ flex: 1, border: "1px solid #fce7f3", borderRadius: 10, padding: "10px 0", fontSize: 12, fontWeight: 800, cursor: (bdSending || todayBirthdayClients.length === 0) ? "not-allowed" : "pointer", background: bdSendDone ? "#ecfdf5" : "#fff3f8", color: bdSendDone ? "#059669" : "#db2777", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, opacity: todayBirthdayClients.length === 0 ? 0.5 : 1 }}>
                      {bdSendDone ? <><Check size={13} /> Queued!</> : bdSending ? "Queueing…" : <><Send size={13} /> Queue Now</>}
                    </button>
                  </div>
                </div>
              </div>

              {/* Win-back — clients who haven't visited in a long time */}
              <div style={{ background: "#fff", border: "1px solid #ccfbf1", borderRadius: 18, padding: "20px", boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(13,148,136,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <UserMinus size={16} color="#0d9488" />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 900, color: "#1d1d2f" }}>Win-back Messages</div>
                    <div style={{ fontSize: 11, color: "#9999b0", marginTop: 1 }}>Reaches clients who haven&rsquo;t been in for a while &mdash; 15\u201320 a day, spread over 7\u20138 hours</div>
                  </div>
                  <button type="button" onClick={() => setWbEnabled((v) => !v)}
                    aria-label={`${wbEnabled ? "Disable" : "Enable"} win-back messages`}
                    style={{ marginLeft: "auto", width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: wbEnabled ? "#0d9488" : "#d1d5db", transition: "background 0.2s", position: "relative", flexShrink: 0 }}>
                    <span style={{ position: "absolute", top: 3, left: wbEnabled ? 20 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ padding: "10px 12px", borderRadius: 9, background: lapsedClients.length > 0 ? "#f0fdfa" : "#f8f8fc", border: `1px solid ${lapsedClients.length > 0 ? "#ccfbf1" : "#e8e8f0"}`, fontSize: 11, color: lapsedClients.length > 0 ? "#115e59" : "#6b6b8a", lineHeight: 1.6 }}>
                    {lapsedClients.length > 0
                      ? <>
                          <strong>{lapsedClients.length} client{lapsedClients.length > 1 ? "s haven\u2019t" : " hasn\u2019t"} visited in {wbDays}+ days:</strong>{" "}
                          {lapsedClients.slice(0, 6).map((entry) => entry.client.name).join(", ")}{lapsedClients.length > 6 ? ` +${lapsedClients.length - 6} more` : ""}
                          {winbackTargetCount > WINBACK_DAILY_MIN && (
                            <div style={{ marginTop: 5, opacity: 0.85 }}>
                              The longest-absent {WINBACK_DAILY_MIN}&ndash;{WINBACK_DAILY_MAX} go out today; the rest follow on the days after.
                            </div>
                          )}
                        </>
                      : winbackEmptyReason}
                  </div>

                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", borderRadius: 9, border: "1px solid #e8e8f0", fontSize: 12, color: "#29293d", cursor: "pointer", lineHeight: 1.5 }}>
                    <input type="checkbox" checked={wbNeverVisited} onChange={(e) => setWbNeverVisited(e.target.checked)} style={{ marginTop: 2, accentColor: "#0d9488" }} />
                    <span>
                      <strong>Also message clients who have never visited</strong>
                      <span style={{ display: "block", fontSize: 11, color: "#9999b0" }}>
                        {neverVisitedClients.length > 0
                          ? `${neverVisitedClients.length} client${neverVisitedClients.length > 1 ? "s" : ""}: ${neverVisitedClients.slice(0, 4).map((c) => c.name).join(", ")}${neverVisitedClients.length > 4 ? ` +${neverVisitedClients.length - 4} more` : ""}. Sent after lapsed clients, same daily limit.`
                          : "No clients without a visit right now."}
                      </span>
                    </span>
                  </label>

                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#7c7c9a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                        Inactive for
                      </label>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="number" min={1} value={wbDays} onChange={(e) => setWbDays(e.target.value)}
                          style={{ width: "100%", height: 36, padding: "0 12px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#29293d", outline: "none", boxSizing: "border-box" }} />
                        <span style={{ fontSize: 11, color: "#9999b0", fontWeight: 700 }}>days</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#7c7c9a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                      Don&rsquo;t message the same client again for
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input type="number" min={1} value={wbCooldown} onChange={(e) => setWbCooldown(e.target.value)}
                        style={{ flex: 1, height: 36, padding: "0 12px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#29293d", outline: "none", boxSizing: "border-box" }} />
                      <span style={{ fontSize: 11, color: "#9999b0", fontWeight: 700 }}>days</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#b0b0c8", marginTop: 4 }}>
                      {WINBACK_DAILY_MIN}&ndash;{WINBACK_DAILY_MAX} messages a day (the exact number varies day to day), spread
                      over a random 7&ndash;8 hours with uneven gaps of at least 15 min &mdash; nothing goes out the moment it&rsquo;s queued.
                      Edit the wording and the discount on the Templates tab &rarr; Win-back (Lapsed Clients).
                    </div>
                  </div>

                  {wbResult && (
                    <div style={{ padding: "9px 12px", borderRadius: 9, fontSize: 11, fontWeight: 600, lineHeight: 1.55, background: wbResult.ok ? "#f0fdfa" : "#fef2f2", border: `1px solid ${wbResult.ok ? "#ccfbf1" : "#fecaca"}`, color: wbResult.ok ? "#115e59" : "#991b1b" }}>
                      {wbResult.message}
                    </div>
                  )}

                  <button type="button" onClick={() => setShowWbPicker(true)} disabled={winbackCandidates.length === 0}
                    style={{ border: "1px dashed #99f6e4", borderRadius: 10, padding: "9px 0", fontSize: 12, fontWeight: 800, cursor: winbackCandidates.length === 0 ? "not-allowed" : "pointer", background: "#fff", color: "#0d9488", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, opacity: winbackCandidates.length === 0 ? 0.5 : 1 }}>
                    <Users size={13} /> Choose clients to message
                  </button>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={saveWinbackSettings} disabled={wbSaving}
                      style={{ flex: 1, border: "none", borderRadius: 10, padding: "10px 0", fontSize: 12, fontWeight: 800, cursor: wbSaving ? "not-allowed" : "pointer", background: wbSaved ? "#ecfdf5" : "linear-gradient(135deg,#0f766e,#0d9488)", color: wbSaved ? "#059669" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, boxShadow: wbSaved ? "none" : "0 3px 10px rgba(13,148,136,0.3)" }}>
                      {wbSaved ? <><Check size={13} /> Saved</> : wbSaving ? "Saving…" : <><Save size={13} /> Save</>}
                    </button>
                    <button type="button" onClick={() => queueWinbackNow()} disabled={wbSending || winbackTargetCount === 0}
                      title={winbackTargetCount === 0 ? "No clients to message" : "Queue today\u2019s win-back messages, spread over 7\u20138 hours"}
                      style={{ flex: 1, border: "1px solid #ccfbf1", borderRadius: 10, padding: "10px 0", fontSize: 12, fontWeight: 800, cursor: (wbSending || winbackTargetCount === 0) ? "not-allowed" : "pointer", background: "#f0fdfa", color: "#0d9488", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, opacity: winbackTargetCount === 0 ? 0.5 : 1 }}>
                      {wbSending ? "Queueing…" : <><Send size={13} /> Queue Now</>}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {showWbPicker && (
        <WinbackPickerModal
          candidates={winbackCandidates}
          sending={wbSending}
          result={wbResult}
          onClose={() => setShowWbPicker(false)}
          onQueue={(ids) => queueWinbackNow(ids)}
        />
      )}

      {showQueueModal && (
        <QueueDetailsModal
          items={queueDetails}
          loading={queueDetailsLoading}
          onClose={() => setShowQueueModal(false)}
          onRefresh={openQueueDetails}
        />
      )}
    </div>
  );
}

// ─── Queue Details Modal ────────────────────────────────────────────────────

function badgeTypeForKind(kind: string): string {
  return kind === "groupalert" ? "newbooking" : kind;
}

function formatWhen(iso: string): { absolute: string; relative: string; overdue: boolean } {
  const target = new Date(iso).getTime();
  const diffMs = target - Date.now();
  const overdue = diffMs <= 0;
  const absolute = new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);

  let relative: string;
  if (minutes < 1) relative = "now";
  else if (minutes < 60) relative = `${minutes}m`;
  else if (hours < 24) relative = `${hours}h`;
  else relative = `${days}d`;

  return { absolute, relative: overdue ? `${relative} overdue` : `in ${relative}`, overdue };
}

interface WinbackCandidate { id: string; name: string; phone: string; note: string }

/**
 * Hand-pick who gets a win-back. Lists everyone the automation could reach;
 * the server still applies the daily limit, cooldown and duplicate checks to
 * whatever is picked, so this narrows the send but can never widen it.
 */
function WinbackPickerModal({ candidates, sending, result, onClose, onQueue }: {
  candidates: WinbackCandidate[];
  sending: boolean;
  result: { ok: boolean; message: string } | null;
  onClose: () => void;
  onQueue: (clientIds: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();
  const shown = q ? candidates.filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(q.replace(/\D/g, "") || q)) : candidates;
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.has(c.id));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 560, maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 70px rgba(0,0,0,0.22)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 20px", borderBottom: "1px solid #f0f0f5", flexShrink: 0 }}>
          <Users size={18} color="#0d9488" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: "#1d1d2f" }}>Choose Win-back Clients</div>
            <div style={{ fontSize: 11, color: "#9999b0", marginTop: 1 }}>{candidates.length} clients can get a win-back message</div>
          </div>
          <button type="button" onClick={onClose} title="Close"
            style={{ border: "none", background: "rgba(0,0,0,0.06)", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
            <X size={14} color="#6b6b8a" />
          </button>
        </div>

        <div style={{ padding: "12px 16px 8px", display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, border: "1px solid #e4e4ee", borderRadius: 9, padding: "0 10px", height: 36 }}>
            <Search size={14} color="#9999b0" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or phone"
              style={{ flex: 1, border: "none", outline: "none", fontSize: 13, color: "#29293d", minWidth: 0 }} />
          </div>
          <button type="button" disabled={shown.length === 0}
            onClick={() => setPicked((prev) => {
              const next = new Set(prev);
              for (const c of shown) { if (allShownPicked) next.delete(c.id); else next.add(c.id); }
              return next;
            })}
            style={{ border: "1px solid #ccfbf1", background: "#f0fdfa", color: "#0d9488", borderRadius: 9, padding: "0 12px", height: 36, fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
            {allShownPicked ? "Unselect shown" : `Select ${q ? "shown" : "all"}`}
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "0 10px 8px", flex: 1 }}>
          {shown.length === 0 ? (
            <div style={{ padding: 28, textAlign: "center", fontSize: 12, color: "#9999b0" }}>No matching clients.</div>
          ) : shown.map((c) => (
            <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 8px", borderBottom: "1px solid #f6f6fa", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} style={{ accentColor: "#0d9488", width: 15, height: 15, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#1d1d2f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ display: "block", fontSize: 11, color: "#9999b0" }}>{c.phone} · {c.note}</span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ padding: "12px 16px 16px", borderTop: "1px solid #f0f0f5", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          {result && !result.ok && (
            <div style={{ padding: "8px 11px", borderRadius: 9, fontSize: 11, fontWeight: 600, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" }}>{result.message}</div>
          )}
          <div style={{ fontSize: 11, color: "#9999b0", lineHeight: 1.5 }}>
            At most {WINBACK_DAILY_MIN}&ndash;{WINBACK_DAILY_MAX} win-backs go out a day (including the automatic ones). Clients messaged within the cooldown are skipped.
          </div>
          <button type="button" disabled={picked.size === 0 || sending} onClick={() => onQueue([...picked])}
            style={{ border: "none", borderRadius: 10, padding: "11px 0", fontSize: 13, fontWeight: 800, cursor: picked.size === 0 || sending ? "not-allowed" : "pointer", background: picked.size === 0 ? "#e8e8f0" : "linear-gradient(135deg,#0f766e,#0d9488)", color: picked.size === 0 ? "#b0b0c8" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
            {sending ? "Queueing…" : <><Send size={13} /> Queue {picked.size || ""} selected</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function QueueDetailsModal({ items, loading, onClose, onRefresh }: {
  items: QueueDetailItem[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  // Deleting is confirmed inline rather than in a second modal stacked on this
  // one — one click arms the row, the next click deletes it.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState("");

  const itemKey = (item: QueueDetailItem) => `${item.source}_${item.id}`;

  // Dropped from view the moment the DELETE succeeds. The counts in the header
  // behind this modal refresh on their own 5s timer, so re-fetching the whole
  // list here would only flash "Loading…" over every other row.
  const visibleItems = items.filter((item) => !removedKeys.includes(itemKey(item)));
  const pendingItems = visibleItems.filter((item) => item.status === "pending");
  const processedItems = visibleItems.filter((item) => item.status !== "pending");

  async function deleteItem(item: QueueDetailItem) {
    const key = itemKey(item);
    setDeletingKey(key);
    setDeleteError("");
    try {
      const res = await fetch("/api/whatsapp/queue-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: item.source, id: item.id }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || "Could not delete that message.");
      setRemovedKeys((keys) => [...keys, key]);
      setConfirmKey(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete that message.");
    } finally {
      setDeletingKey(null);
    }
  }

  const renderItem = (item: QueueDetailItem) => {
    const key = itemKey(item);
    const armed = confirmKey === key;
    const deleting = deletingKey === key;
    const when = formatWhen(item.scheduledAt);
    const processedAt = item.sentAt || item.createdAt;
    const processedLabel = processedAt
      ? new Date(processedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    const statusColor = item.status === "sent" ? "#059669" : item.status === "expired" ? "#6b7280" : "#dc2626";
    const statusBg = item.status === "sent" ? "#ecfdf5" : item.status === "expired" ? "#f3f4f6" : "#fef2f2";

    return (
      <div key={key}
        style={{ padding: "10px 12px", borderRadius: 12, background: armed ? "#fff7f7" : "#f8f8fc", border: `1px solid ${armed ? "#fca5a5" : "#e8e8f0"}`, opacity: deleting ? 0.55 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Badge type={badgeTypeForKind(item.kind)} />
          <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", color: statusColor, background: statusBg, borderRadius: 999, padding: "2px 7px" }}>
            {item.status}
          </span>
          {item.source === "pos" && item.invoiceNumber && (
            <span style={{ fontSize: 11, color: "#9999b0", fontWeight: 600 }}>#{item.invoiceNumber}</span>
          )}
          <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 800, color: item.status === "pending" && when.overdue ? "#dc2626" : item.status === "pending" ? "#92400e" : statusColor, whiteSpace: "nowrap" }}>
            {item.status === "pending" ? when.relative : processedLabel}
          </span>
          {armed ? (
            <span style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <button type="button" onClick={() => void deleteItem(item)} disabled={deleting}
                title={item.status === "pending" ? "Cancel this message so it is never sent" : "Remove this from the list"}
                style={{ border: "1px solid #dc2626", background: "#dc2626", color: "#fff", borderRadius: 7, padding: "3px 8px", fontSize: 10, fontWeight: 800, cursor: deleting ? "wait" : "pointer" }}>
                {deleting ? "…" : item.status === "pending" ? "Cancel send" : "Delete"}
              </button>
              <button type="button" onClick={() => setConfirmKey(null)} disabled={deleting}
                style={{ border: "1px solid #e8e8f0", background: "#fff", color: "#6b6b8a", borderRadius: 7, padding: "3px 7px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => { setDeleteError(""); setConfirmKey(key); }}
              title={item.status === "pending" ? "Cancel this queued message" : "Remove from list"}
              aria-label={item.status === "pending" ? "Cancel this queued message" : "Remove from list"}
              style={{ border: "none", background: "transparent", borderRadius: 6, padding: 3, cursor: "pointer", display: "flex", flexShrink: 0 }}>
              <Trash2 size={13} color="#b0b0c4" />
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#1d1d2f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.clientName || "Unknown client"}
          </div>
          <div style={{ fontSize: 11, color: "#9999b0", flexShrink: 0 }}>{item.phone}</div>
        </div>
        <div style={{ fontSize: 11, color: "#9999b0", marginTop: 2 }}>
          Scheduled {when.absolute}
          {item.apptDate ? ` · appointment ${item.apptDate}${item.apptTime ? ` ${item.apptTime}` : ""}` : ""}
          {item.attempts > 0 ? ` · attempt ${item.attempts}` : ""}
        </div>
        {item.lastError && (
          <div style={{ fontSize: 11, color: "#a16207", marginTop: 4, fontStyle: "italic" }}>{item.lastError}</div>
        )}
      </div>
    );
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 640, maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 70px rgba(0,0,0,0.22)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 20px", borderBottom: "1px solid #f0f0f5", flexShrink: 0 }}>
          <ListChecks size={18} color="#92400e" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: "#1d1d2f" }}>Queued Messages</div>
            <div style={{ fontSize: 11, color: "#9999b0", marginTop: 1 }}>
              {pendingItems.length} pending · {processedItems.length} recently processed — confirmations, reminders, follow-ups &amp; POS receipts
            </div>
          </div>
          <button type="button" onClick={onRefresh} title="Refresh"
            style={{ border: "1px solid #e8e8f0", background: "#fafafd", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
            <RefreshCw size={14} color="#6b6b8a" />
          </button>
          <button type="button" onClick={onClose} title="Close"
            style={{ border: "none", background: "rgba(0,0,0,0.06)", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
            <X size={14} color="#6b6b8a" />
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "10px 14px 16px" }}>
          {deleteError && (
            <div style={{ margin: "2px 2px 10px", padding: "8px 11px", borderRadius: 9, background: "#fef2f2", border: "1px solid #fca5a5", fontSize: 11.5, fontWeight: 600, color: "#991b1b" }}>
              {deleteError}
            </div>
          )}
          {loading ? (
            <div style={{ padding: "40px 0", textAlign: "center", fontSize: 13, color: "#9999b0" }}>Loading…</div>
          ) : visibleItems.length === 0 ? (
            <div style={{ padding: "40px 0", textAlign: "center", fontSize: 13, color: "#9999b0" }}>No pending or recent queue activity.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {pendingItems.length > 0 && (
                <section>
                  <div style={{ fontSize: 10, fontWeight: 900, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.07em", margin: "2px 2px 8px" }}>Pending</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{pendingItems.map(renderItem)}</div>
                </section>
              )}
              {processedItems.length > 0 && (
                <section>
                  <div style={{ fontSize: 10, fontWeight: 900, color: "#7c7c9a", textTransform: "uppercase", letterSpacing: "0.07em", margin: "2px 2px 8px" }}>Recently processed</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{processedItems.map(renderItem)}</div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
