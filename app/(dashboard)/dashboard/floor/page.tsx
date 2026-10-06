"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Armchair, Users, Wallet, Search, Plus, Minus, RotateCcw, RotateCw, Home, X, Check, ChevronRight,
  Store, CalendarCheck, Scissors, UserRound, CreditCard,
} from "lucide-react";
import { getStoredAppointments, getStoredStaff, getStoredInventory, subscribeToStoredData } from "@/lib/storage";
import { getSalonInvoices, revenueAmount, localDateKey } from "@/lib/salon-invoices";
import { getAttendance } from "@/lib/attendance";
import { settingsStore } from "@/lib/settings-store";
import { syncFromDB } from "@/lib/turso-sync";
import { getActiveSection, inSection } from "@/lib/sections";
import { fmtCurrency as fmt } from "@/lib/format";
import { ACCENT, type ChairLabel, type FloorApi, type RosterPerson } from "@/components/salon-floor-3d";
import type { Appointment, InventoryItem, Staff } from "@/lib/types";

// three.js is large and browser-only — load it on this page alone.
const SalonFloor3D = dynamic(() => import("@/components/salon-floor-3d"), { ssr: false });

/**
 * Salon Floor — a live 3D map of the salon in the style of an operations
 * control room. Everyone on it is real: clients walk in when their
 * appointment is marked Arrived, take a chair at In Progress and walk out when
 * it's Completed; stylists on duty wait beside a free chair and work at their
 * client's. Appointments don't record a chair, so a client keeps whichever
 * chair was free when they sat down.
 */

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function time12(t: string) {
  const m = toMin(t);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const clockTime = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" }) : "";
};
function yesterdayKey() { const d = new Date(); d.setDate(d.getDate() - 1); return localDateKey(d); }

interface Toast { id: number; text: string }
type Tab = "chairs" | "stylists" | "bookings";

const card: React.CSSProperties = { background: "rgba(255,255,255,0.96)", borderRadius: 16, border: "1px solid #eef1f6", boxShadow: "0 10px 30px rgba(15,23,42,0.08)", backdropFilter: "blur(8px)" };
const chipStyle = (bg: string, fg: string): React.CSSProperties => ({ display: "inline-block", padding: "3px 9px", borderRadius: 7, background: bg, color: fg, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" });
const GREEN = { bg: "#e8f7ee", fg: "#16a34a" };
const BLUE = { bg: "#eaf0ff", fg: ACCENT };
const AMBER = { bg: "#fff4e0", fg: "#d97706" };
const GREY = { bg: "#f1f3f8", fg: "#64748b" };

function Bar({ pct, color = ACCENT }: { pct: number; color?: string }) {
  return <div style={{ height: 5, borderRadius: 3, background: "#e8ecf5" }}><div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", borderRadius: 3, background: color, transition: "width .6s" }} /></div>;
}

export default function SalonFloorPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [sales, setSales] = useState({ today: 0, yesterday: 0, paidAppts: new Map<string, string>() });
  const [onDuty, setOnDuty] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pops, setPops] = useState<{ id: number; text: string }[]>([]);
  const [bubbles, setBubbles] = useState<Record<string, { text: string; until: number }>>({});
  const [tab, setTab] = useState<Tab>("chairs");
  const [query, setQuery] = useState("");
  const [clock, setClock] = useState("");
  const [minute, setMinute] = useState(nowMin());

  const api = useRef<FloorApi | null>(null);
  const chairOf = useRef(new Map<string, number>());
  const lastStatus = useRef(new Map<string, string>());
  const seenInvoices = useRef<Set<string> | null>(null);
  const firstLoad = useRef(true);
  const seq = useRef(0);

  const salon = settingsStore.salon as { name?: string; address?: string; city?: string; chairCount?: number };
  const chairCount = Math.min(24, Math.max(1, Number(salon.chairCount) || 4));
  const night = (() => { const h = new Date().getHours(); return h >= 18 || h < 7; })();

  const toast = useCallback((text: string) => {
    const id = ++seq.current;
    setToasts((t) => [{ id, text }, ...t].slice(0, 3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const load = useCallback(() => {
    const today = localDateKey();
    const section = getActiveSection();
    const appts = getStoredAppointments().filter((a) => a.date === today && inSection(a, section));
    const allInvoices = getSalonInvoices().filter((i) => inSection(i, section));
    const todays = allInvoices.filter((i) => i.date === today);
    const attendance = getAttendance().filter((r) => r.date === today);
    setAppointments(appts);
    setStaff(getStoredStaff());
    setInventory(getStoredInventory().filter((i) => inSection(i, section)));
    setSales({
      today: todays.reduce((s, i) => s + revenueAmount(i), 0),
      yesterday: allInvoices.filter((i) => i.date === yesterdayKey()).reduce((s, i) => s + revenueAmount(i), 0),
      paidAppts: new Map(todays.filter((i) => i.appointmentId).map((i) => [i.appointmentId!, i.createdAt])),
    });

    // Stylists on duty: anyone with a client today, plus anyone checked in; clocking out takes them off.
    const out = new Set(attendance.filter((r) => r.checkOut).map((r) => r.staffId));
    const duty = new Set(attendance.filter((r) => ["present", "late", "half-day"].includes(r.status)).map((r) => r.staffId));
    for (const a of appts) if (!["cancelled", "no-show"].includes(a.status) && a.staffId) duty.add(a.staffId);
    for (const id of out) duty.delete(id);
    setOnDuty([...duty]);

    // Chairs: a seated client keeps their chair; newcomers take the lowest free one.
    const byStart = (a: Appointment, b: Appointment) => toMin(a.startTime) - toMin(b.startTime) || a.id.localeCompare(b.id);
    const keep = new Map<string, number>();
    const inProgress = appts.filter((a) => a.status === "in-progress").sort(byStart);
    for (const a of inProgress) { const c = chairOf.current.get(a.id); if (c != null && c < chairCount) keep.set(a.id, c); }
    const taken = new Set(keep.values());
    for (const a of inProgress) {
      if (keep.has(a.id)) continue;
      let free = 0;
      while (taken.has(free)) free++;
      if (free < chairCount) { keep.set(a.id, free); taken.add(free); }
    }
    chairOf.current = keep;

    // What changed → toasts, bubbles and money pops
    if (!firstLoad.current) {
      const now = Date.now();
      const bubble: Record<string, { text: string; until: number }> = {};
      for (const a of appts) {
        const before = lastStatus.current.get(a.id);
        if (before === a.status) continue;
        if (a.status === "arrived") { toast(`👋 ${a.clientName} arrived`); bubble[`appt:${a.id}`] = { text: "👋", until: now + 4000 }; }
        else if (a.status === "in-progress") { toast(`✂️ ${a.clientName} sat in Chair ${(keep.get(a.id) ?? 0) + 1} with ${firstName(a.staffName)}`); bubble[`appt:${a.id}`] = { text: "✨", until: now + 4000 }; }
        else if (a.status === "completed") toast(`✅ ${a.clientName} finished with ${firstName(a.staffName)}`);
        else if (!before && (a.status === "booked" || a.status === "confirmed")) toast(`📅 New booking: ${a.clientName} at ${time12(a.startTime)}`);
      }
      if (Object.keys(bubble).length) setBubbles((b) => ({ ...b, ...bubble }));
    }
    lastStatus.current = new Map(appts.map((a) => [a.id, a.status]));
    const fresh = seenInvoices.current ? todays.filter((i) => !seenInvoices.current!.has(i.id)) : [];
    seenInvoices.current = new Set(todays.map((i) => i.id));
    for (const inv of fresh) {
      toast(`💰 Paid ${fmt(revenueAmount(inv))} · ${inv.clientName}`);
      setPops((p) => [...p.slice(-5), { id: ++seq.current, text: `+${fmt(revenueAmount(inv))}` }]);
    }
    firstLoad.current = false;
    setMinute(nowMin());
  }, [chairCount, toast]);

  useEffect(() => {
    load();
    const unsubscribe = subscribeToStoredData(load);
    // A board left open at reception: pull other devices' changes every 30s.
    const sync = setInterval(() => { syncFromDB().finally(load); }, 30_000);
    const tick = setInterval(() => { setClock(new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })); setMinute(nowMin()); }, 1000);
    return () => { unsubscribe(); clearInterval(sync); clearInterval(tick); };
  }, [load]);

  // ── Derived ──
  const byStart = (a: Appointment, b: Appointment) => toMin(a.startTime) - toMin(b.startTime) || a.id.localeCompare(b.id);
  const seated = useMemo(() => {
    const m = new Map<number, Appointment>();
    for (const a of appointments) { const c = chairOf.current.get(a.id); if (a.status === "in-progress" && c != null) m.set(c, a); }
    return m;
  }, [appointments]);
  const inService = appointments.filter((a) => a.status === "in-progress").sort(byStart);
  const waiting = appointments.filter((a) => a.status === "arrived").sort(byStart);
  const upcoming = appointments.filter((a) => (a.status === "booked" || a.status === "confirmed") && toMin(a.startTime) >= minute - 30).sort(byStart);
  const done = appointments.filter((a) => a.status === "completed");
  const dutyStaff = staff.filter((s) => s.isActive && onDuty.includes(s.id)).slice(0, 12);
  const busyStaff = new Map<string, { chair: number; appt: Appointment }>();
  for (const [chair, a] of seated) if (a.staffId && !busyStaff.has(a.staffId)) busyStaff.set(a.staffId, { chair, appt: a });
  const progressOf = (a: Appointment) => (minute - toMin(a.startTime)) / Math.max(1, toMin(a.endTime) - toMin(a.startTime));

  const roster = useMemo<RosterPerson[]>(() => {
    const people: RosterPerson[] = [];
    let sofa = 0;
    for (const a of inService) {
      const chair = chairOf.current.get(a.id);
      people.push({ id: `appt:${a.id}`, kind: "client", color: "#eef1f6", spot: chair != null ? { type: "chair", index: chair } : { type: "sofa", index: sofa++ }, bubble: bubbles[`appt:${a.id}`] });
    }
    for (const a of waiting) people.push({ id: `appt:${a.id}`, kind: "client", color: "#eef1f6", spot: { type: "sofa", index: sofa++ }, bubble: bubbles[`appt:${a.id}`] });
    const freeChairs = Array.from({ length: chairCount }, (_, i) => i).filter((i) => !seated.has(i));
    let idle = 0;
    for (const s of dutyStaff) {
      const busy = busyStaff.get(s.id);
      const spot = busy ? { type: "station" as const, index: busy.chair }
        : idle < freeChairs.length ? { type: "station" as const, index: freeChairs[idle++] }
        : { type: "spare" as const, index: idle++ - freeChairs.length };
      people.push({ id: `staff:${s.id}`, kind: "staff", color: s.color || ACCENT, spot, working: !!busy });
    }
    return people;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointments, staff, onDuty, bubbles, chairCount]);

  const chairLabels: ChairLabel[] = Array.from({ length: chairCount }, (_, i) => {
    const a = seated.get(i);
    if (!a) return { text: `Chair ${i + 1} · Free`, tone: "free", progress: null };
    const left = toMin(a.endTime) - minute;
    return { text: `${firstName(a.staffName) || `Chair ${i + 1}`} · ${left > 0 ? `${left}m left` : left === 0 ? "finishing" : `${-left}m over`}`, tone: left < 0 ? "warn" : "busy", progress: progressOf(a) };
  });

  // The client the journey card follows: the selected chair, else the next one to finish.
  const focusAppt = (selected != null ? seated.get(selected) : undefined)
    ?? [...seated.values()].sort((a, b) => toMin(a.endTime) - toMin(b.endTime))[0]
    ?? waiting[0] ?? upcoming[0];
  const focusChair = focusAppt ? chairOf.current.get(focusAppt.id) : undefined;
  const selAppt = selected != null ? seated.get(selected) : undefined;

  const salesDelta = sales.yesterday > 0 ? Math.round(((sales.today - sales.yesterday) / sales.yesterday) * 100) : null;
  const stock = [...inventory].sort((a, b) => (a.currentStock / Math.max(1, a.minStock)) - (b.currentStock / Math.max(1, b.minStock))).slice(0, 4);

  const matches = query.trim()
    ? appointments.filter((a) => a.clientName.toLowerCase().includes(query.trim().toLowerCase()) && a.status !== "cancelled").slice(0, 6)
    : [];
  const goTo = (a: Appointment) => {
    setQuery("");
    const c = chairOf.current.get(a.id);
    if (a.status === "in-progress" && c != null) { setSelected(c); api.current?.focusChair(c); }
    else api.current?.focusPerson(`appt:${a.id}`);
  };
  const pickChair = (i: number | null) => { setSelected(i); if (i != null) api.current?.focusChair(i); };

  const statusChip = (a: Appointment) =>
    a.status === "in-progress" ? <span style={chipStyle(BLUE.bg, BLUE.fg)}>In chair</span>
    : a.status === "arrived" ? <span style={chipStyle(AMBER.bg, AMBER.fg)}>Waiting</span>
    : a.status === "completed" ? <span style={chipStyle(GREEN.bg, GREEN.fg)}>Done</span>
    : <span style={chipStyle(GREY.bg, GREY.fg)}>{a.status === "confirmed" ? "Confirmed" : "Booked"}</span>;

  const reached = (s: Appointment["status"]) => ["arrived", "in-progress", "completed"].includes(s);
  const journey = focusAppt ? [
    { label: "Booked", sub: clockTime(focusAppt.createdAt) || (focusAppt.source === "walk-in" ? "Walk-in" : "—"), state: "done" },
    { label: "Arrived", sub: reached(focusAppt.status) ? "Checked in" : time12(focusAppt.startTime), state: reached(focusAppt.status) ? "done" : "todo" },
    { label: "In chair", sub: time12(focusAppt.startTime), state: focusAppt.status === "in-progress" ? "current" : focusAppt.status === "completed" ? "done" : "todo" },
    { label: "Finished", sub: `${focusAppt.status === "completed" ? "" : "ETA "}${time12(focusAppt.endTime)}`, state: focusAppt.status === "completed" ? "done" : "todo" },
    { label: "Paid", sub: sales.paidAppts.has(focusAppt.id) ? clockTime(sales.paidAppts.get(focusAppt.id)) : "—", state: sales.paidAppts.has(focusAppt.id) ? "done" : "todo" },
  ] : [];

  return (
    <div className="sf-root">
      <style>{`
        .sf-root{position:relative;height:calc(100dvh - 32px);min-height:640px;border-radius:22px;overflow:hidden;background:${night ? "#1c2340" : "#eef1f8"};font-family:inherit}
        .sf-layer{position:absolute;z-index:2;box-sizing:border-box}
        .sf-root *{box-sizing:border-box}
        .sf-top{top:14px;left:14px;right:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;pointer-events:none}
        .sf-top>*{pointer-events:auto}
        .sf-stats{top:72px;left:14px;display:flex;gap:10px;flex-wrap:wrap;max-width:calc(100% - 440px)}
        .sf-ctrl{top:72px;right:384px;display:flex;flex-direction:column;gap:4px;padding:5px}
        .sf-panel{top:72px;right:14px;width:356px;max-height:calc(100% - 300px);overflow:auto}
        .sf-journey{left:14px;bottom:14px;width:calc(100% - 484px);max-width:900px;display:flex;gap:14px;align-items:stretch}
        .sf-table{right:14px;bottom:14px;width:440px}
        .sf-toasts{top:150px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
        .sf-btn{width:34px;height:34px;border:none;border-radius:9px;background:transparent;display:grid;place-items:center;cursor:pointer;color:#0f172a}
        .sf-btn:hover{background:#f1f4fa}
        .sf-row{display:grid;grid-template-columns:1.1fr 1.6fr auto auto;gap:10px;align-items:center;padding:8px 6px;border-radius:9px;cursor:pointer;font-size:12px}
        .sf-row:hover{background:#f6f8fc}
        @keyframes sfIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
        @keyframes sfPulse{0%,100%{opacity:1}50%{opacity:.3}}
        @media (max-width: 1180px){
          .sf-root{height:auto;min-height:0;overflow:visible;background:none;border-radius:0;display:flex;flex-direction:column;gap:12px}
          .sf-map{position:relative!important;inset:auto!important;height:62vh;min-height:380px;border-radius:20px;overflow:hidden;background:${night ? "#1c2340" : "#eef1f8"};order:2}
          .sf-layer{position:static;width:auto!important;max-width:none!important;max-height:none!important}
          .sf-top{order:0}.sf-stats{order:1;flex-wrap:nowrap!important;overflow-x:auto;padding-bottom:4px}.sf-stats>*{flex:0 0 auto}.sf-panel{order:3}.sf-journey{order:4;flex-direction:column}.sf-table{order:5}
          .sf-map .sf-ctrl{position:absolute;top:auto;bottom:12px;right:12px;flex-direction:row}
          .sf-map .sf-toasts{position:absolute;top:12px}
        }
      `}</style>

      {/* ── 3D map ── */}
      <div className="sf-map" style={{ position: "absolute", inset: 0 }}>
        <SalonFloor3D
          key={`${chairCount}-${night}`}
          chairCount={chairCount}
          salonName={salon.name || "Salon"}
          night={night}
          roster={roster}
          chairLabels={chairLabels}
          receptionLabel={upcoming.length ? `Reception · ${upcoming.length} coming` : "Reception"}
          waitingLabel={waiting.length ? `Waiting · ${waiting.length}` : ""}
          selectedChair={selected}
          onSelectChair={pickChair}
          pops={pops}
          apiRef={api}
        />
        <div className="sf-layer sf-ctrl" style={card}>
          <button type="button" className="sf-btn" aria-label="Zoom in" title="Zoom in" onClick={() => api.current?.zoom(0.75)}><Plus size={16} /></button>
          <button type="button" className="sf-btn" aria-label="Zoom out" title="Zoom out" onClick={() => api.current?.zoom(1.3)}><Minus size={16} /></button>
          <button type="button" className="sf-btn" aria-label="Rotate left" title="Rotate left" onClick={() => api.current?.rotate(-1)}><RotateCcw size={15} /></button>
          <button type="button" className="sf-btn" aria-label="Rotate right" title="Rotate right" onClick={() => api.current?.rotate(1)}><RotateCw size={15} /></button>
          <button type="button" className="sf-btn" aria-label="Reset view" title="Reset view" onClick={() => { setSelected(null); api.current?.home(); }}><Home size={15} /></button>
        </div>
        <div className="sf-layer sf-toasts">
          {toasts.map((t) => (
            <div key={t.id} style={{ ...card, padding: "8px 14px", fontSize: 12, fontWeight: 700, color: "#0f172a", animation: "sfIn .35s ease-out", whiteSpace: "nowrap" }}>{t.text}</div>
          ))}
        </div>
      </div>

      {/* ── Top bar: search, salon, live clock ── */}
      <div className="sf-layer sf-top">
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", height: 44, width: 380, maxWidth: "100%", position: "relative" }}>
          <Search size={16} color="#64748b" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search today's clients…" aria-label="Search today's clients"
            style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontSize: 13, color: "#0f172a", minWidth: 0 }} />
          {matches.length > 0 && (
            <div style={{ ...card, position: "absolute", top: 50, left: 0, right: 0, padding: 6, zIndex: 5 }}>
              {matches.map((a) => (
                <button key={a.id} type="button" onClick={() => goTo(a)} style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", gap: 8, border: "none", background: "none", padding: 8, borderRadius: 8, cursor: "pointer", fontSize: 12, textAlign: "left" }}>
                  <span><b style={{ color: "#0f172a" }}>{a.clientName}</b> <span style={{ color: "#64748b" }}>· {time12(a.startTime)} · {firstName(a.staffName)}</span></span>
                  {statusChip(a)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 10, padding: "6px 12px 6px 6px", height: 44 }}>
          <span style={{ background: ACCENT, color: "#fff", width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center" }}><Store size={15} /></span>
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{salon.name || "Salon"}</div>
            <div style={{ fontSize: 11, color: "#64748b" }}>{seated.size}/{chairCount} chairs busy · {waiting.length} waiting</div>
          </div>
        </div>
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 7, padding: "0 14px", height: 36, borderRadius: 999, fontSize: 12, fontWeight: 800, color: "#16a34a" }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: "#22c55e", animation: "sfPulse 1.4s infinite" }} /> Live <span style={{ color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>{clock}</span>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="sf-layer sf-stats">
        {[
          { icon: <Users size={18} />, label: "Clients today", value: String(done.length + inService.length + waiting.length), delta: `${inService.length + waiting.length} in salon`, sub: `${upcoming.length} still to come`, down: false },
          { icon: <Armchair size={18} />, label: "Chairs busy", value: `${seated.size}/${chairCount}`, delta: waiting.length ? `${waiting.length} waiting` : "", sub: `${dutyStaff.length} stylists on floor`, down: false },
          { icon: <Wallet size={18} />, label: "Sales today", value: fmt(sales.today), delta: salesDelta == null ? "" : `${salesDelta >= 0 ? "↑" : "↓"} ${Math.abs(salesDelta)}%`, sub: "vs yesterday", down: salesDelta != null && salesDelta < 0 },
        ].map((c) => (
          <div key={c.label} style={{ ...card, display: "flex", gap: 12, alignItems: "center", padding: "12px 16px 12px 12px", minWidth: 200 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, background: "#eaf0ff", color: ACCENT, display: "grid", placeItems: "center", flexShrink: 0 }}>{c.icon}</div>
            <div>
              <div style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{c.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 21, fontWeight: 800, color: "#0f172a" }}>{c.value}</span>
                {c.delta && <span style={{ fontSize: 11, fontWeight: 700, color: c.down ? "#dc2626" : "#16a34a" }}>{c.delta}</span>}
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>{c.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Right panel: chair detail, or the salon overview ── */}
      <div className="sf-layer sf-panel" style={{ ...card, padding: 16 }}>
        {selAppt ? (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: "#eaf0ff", color: ACCENT, display: "grid", placeItems: "center" }}><Armchair size={22} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: ACCENT, textTransform: "uppercase" }}>Chair {selected! + 1} · {firstName(selAppt.staffName)}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>{selAppt.clientName}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{selAppt.serviceNames.join(", ") || "Service"}</div>
              </div>
              <button type="button" aria-label="Close" onClick={() => setSelected(null)} className="sf-btn" style={{ border: "1px solid #e5e9f2", width: 30, height: 30 }}><X size={14} /></button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
              {statusChip(selAppt)}
              <span style={{ fontSize: 11, color: "#64748b" }}>Started {time12(selAppt.startTime)} · ends {time12(selAppt.endTime)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { k: "Progress", v: `${Math.round(Math.min(1, Math.max(0, progressOf(selAppt))) * 100)}%`, bar: progressOf(selAppt) * 100 },
                { k: "Time left", v: `${Math.max(0, toMin(selAppt.endTime) - minute)} min`, bar: null },
                { k: "Amount", v: fmt(selAppt.totalAmount || 0), bar: null },
                { k: "Stylist", v: selAppt.staffName || "—", bar: null },
              ].map((x) => (
                <div key={x.k} style={{ background: "#f6f8fc", borderRadius: 10, padding: "9px 10px" }}>
                  <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{x.k}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a", margin: "2px 0 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.v}</div>
                  {x.bar != null && <Bar pct={x.bar} />}
                </div>
              ))}
            </div>
            <Link href="/dashboard/appointments" style={{ display: "block", marginTop: 12, textAlign: "center", padding: "10px 0", borderRadius: 10, background: ACCENT, color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>Open in Appointments</Link>
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: "#eaf0ff", color: ACCENT, display: "grid", placeItems: "center" }}><Store size={22} /></div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: ACCENT, textTransform: "uppercase" }}>Salon · Today</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>{salon.name || "Salon"}</div>
                <div style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[salon.address, salon.city].filter(Boolean).join(", ")}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
              <span style={chipStyle(GREEN.bg, GREEN.fg)}>Open</span>
              <span style={{ fontSize: 11, color: "#64748b" }}>{seated.size} in chairs · {waiting.length} waiting · {upcoming.length} coming</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { k: "Chairs busy", v: `${seated.size} / ${chairCount}`, pct: (seated.size / chairCount) * 100, color: ACCENT },
                { k: "Stylists working", v: `${busyStaff.size} / ${dutyStaff.length}`, pct: dutyStaff.length ? (busyStaff.size / dutyStaff.length) * 100 : 0, color: "#22c55e" },
                { k: "Clients done", v: String(done.length), pct: null, color: "" },
                { k: "Sales today", v: fmt(sales.today), pct: null, color: "" },
              ].map((x) => (
                <div key={x.k} style={{ background: "#f6f8fc", borderRadius: 10, padding: "9px 10px" }}>
                  <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{x.k}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a", margin: "2px 0 5px" }}>{x.v}</div>
                  {x.pct != null && <Bar pct={x.pct} color={x.color} />}
                </div>
              ))}
            </div>
            {stock.length > 0 && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", margin: "14px 0 6px", fontSize: 12, fontWeight: 800, color: "#0f172a" }}>Products <span style={{ fontWeight: 500, color: "#94a3b8" }}>in stock</span></div>
                {stock.map((it) => {
                  const low = it.currentStock <= it.minStock;
                  return (
                    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 12 }}>
                      <div style={{ width: 26, height: 26, borderRadius: 7, background: "#eaf0ff", display: "grid", placeItems: "center", color: ACCENT, flexShrink: 0 }}><Scissors size={13} /></div>
                      <span style={{ flex: 1, color: "#0f172a", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                      <span style={{ fontWeight: 700, color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>{Math.round(it.currentStock * 10) / 10}</span>
                      <span style={{ ...chipStyle(low ? AMBER.bg : GREEN.bg, low ? AMBER.fg : GREEN.fg), minWidth: 66, textAlign: "center" }}>{low ? "Low Stock" : "In Stock"}</span>
                    </div>
                  );
                })}
              </>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", margin: "14px 0 6px", fontSize: 12, fontWeight: 800, color: "#0f172a" }}>Stylists <span style={{ fontWeight: 500, color: "#94a3b8" }}>{busyStaff.size}/{dutyStaff.length} working</span></div>
            {dutyStaff.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8" }}>No one on the floor yet</div>}
            {dutyStaff.slice(0, 5).map((s) => {
              const b = busyStaff.get(s.id);
              return (
                <div key={s.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 64px", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 12, cursor: b ? "pointer" : "default" }} onClick={() => b && pickChair(b.chair)}>
                  <b style={{ color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{firstName(s.name)}</b>
                  <span style={{ color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b ? `${b.appt.serviceNames[0] || "Service"} · ${firstName(b.appt.clientName)} · Chair ${b.chair + 1}` : "Free"}</span>
                  {b ? <Bar pct={progressOf(b.appt) * 100} color="#22c55e" /> : <span style={chipStyle(GREEN.bg, GREEN.fg)}>Free</span>}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* ── Bottom left: client journey ── */}
      <div className="sf-layer sf-journey">
        <div style={{ ...card, flex: 1, padding: "14px 18px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 800, color: "#0f172a" }}><UserRound size={16} color={ACCENT} /> Client Journey</div>
            <span style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{focusAppt ? `${focusAppt.clientName} · ${firstName(focusAppt.staffName)}` : "No clients yet today"}</span>
          </div>
          {focusAppt && (
            <div style={{ display: "flex", alignItems: "flex-start" }}>
              {journey.map((s, i) => {
                const Icon = [CalendarCheck, Check, Armchair, Scissors, CreditCard][i];
                const on = s.state === "done" || s.state === "current";
                return (
                  <div key={s.label} style={{ display: "flex", alignItems: "flex-start", flex: i < journey.length - 1 ? 1 : "0 0 auto" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                      <div style={{ width: s.state === "current" ? 34 : 28, height: s.state === "current" ? 34 : 28, borderRadius: 999, display: "grid", placeItems: "center", background: on ? ACCENT : "#fff", border: on ? "none" : "2px solid #d6dcea", color: on ? "#fff" : "#94a3b8", boxShadow: s.state === "current" ? "0 0 0 5px rgba(47,107,255,.18)" : "none" }}>
                        {s.state === "current" ? <Check size={16} /> : <Icon size={13} />}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#0f172a", marginTop: 6 }}>{s.label}</div>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>{s.sub}</div>
                    </div>
                    {i < journey.length - 1 && <div style={{ flex: 1, height: 2, marginTop: s.state === "current" ? 16 : 13, background: journey[i + 1].state === "todo" ? "#dbe1ee" : ACCENT }} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {focusAppt && (
          <button type="button" onClick={() => (focusChair != null && focusAppt.status === "in-progress" ? pickChair(focusChair) : goTo(focusAppt))}
            style={{ ...card, width: 260, padding: 14, display: "flex", gap: 12, alignItems: "center", cursor: "pointer", textAlign: "left" }}>
            <div style={{ width: 52, height: 52, borderRadius: 12, background: "#eaf0ff", color: ACCENT, display: "grid", placeItems: "center", flexShrink: 0 }}><Armchair size={24} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{focusAppt.clientName}</div>
              <div style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: "2px 0 5px" }}>{focusAppt.serviceNames.join(", ") || "Service"}</div>
              {statusChip(focusAppt)}
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>
                {focusChair != null && focusAppt.status === "in-progress" ? `Chair ${focusChair + 1} · ${Math.max(0, toMin(focusAppt.endTime) - minute)} min left` : `${time12(focusAppt.startTime)} · ${firstName(focusAppt.staffName)}`}
              </div>
            </div>
            <ChevronRight size={16} color="#94a3b8" />
          </button>
        )}
      </div>

      {/* ── Bottom right: chairs / stylists / bookings ── */}
      <div className="sf-layer sf-table" style={{ ...card, padding: 12 }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
          {([
            ["chairs", `Chairs ${seated.size}/${chairCount}`],
            ["stylists", `Stylists ${busyStaff.size}/${dutyStaff.length}`],
            ["bookings", `Bookings ${upcoming.length + waiting.length}`],
          ] as [Tab, string][]).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              style={{ border: tab === k ? "1px solid #e2e8f0" : "1px solid transparent", background: tab === k ? "#fff" : "transparent", boxShadow: tab === k ? "0 2px 8px rgba(15,23,42,.06)" : "none", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, color: tab === k ? "#0f172a" : "#64748b", cursor: "pointer" }}>{label}</button>
          ))}
        </div>
        <div style={{ maxHeight: 150, overflow: "auto" }}>
          {tab === "chairs" && Array.from({ length: chairCount }, (_, i) => {
            const a = seated.get(i);
            return (
              <div key={i} className="sf-row" onClick={() => a && pickChair(i)} style={{ background: selected === i ? "#eef3ff" : undefined }}>
                <b style={{ color: "#0f172a" }}>Chair {i + 1}</b>
                <span style={{ color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a ? `● ${a.clientName} · ${firstName(a.staffName)}` : "No client"}</span>
                <span style={chipStyle(a ? BLUE.bg : GREEN.bg, a ? BLUE.fg : GREEN.fg)}>{a ? "In service" : "Free"}</span>
                <span style={{ width: 40 }}>{a ? <Bar pct={progressOf(a) * 100} /> : null}</span>
              </div>
            );
          })}
          {tab === "stylists" && (dutyStaff.length ? dutyStaff.map((s) => {
            const b = busyStaff.get(s.id);
            return (
              <div key={s.id} className="sf-row" onClick={() => b && pickChair(b.chair)}>
                <b style={{ color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</b>
                <span style={{ color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b ? `● ${b.appt.clientName} · Chair ${b.chair + 1}` : "Waiting for a client"}</span>
                <span style={chipStyle(b ? BLUE.bg : GREEN.bg, b ? BLUE.fg : GREEN.fg)}>{b ? "With client" : "Free"}</span>
                <span style={{ width: 40 }}>{b ? <Bar pct={progressOf(b.appt) * 100} color="#22c55e" /> : null}</span>
              </div>
            );
          }) : <div style={{ fontSize: 12, color: "#94a3b8", padding: 8 }}>No stylists on the floor</div>)}
          {tab === "bookings" && ([...waiting, ...upcoming].length ? [...waiting, ...upcoming].map((a) => (
            <div key={a.id} className="sf-row" onClick={() => goTo(a)}>
              <b style={{ color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.clientName}</b>
              <span style={{ color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{time12(a.startTime)} · {firstName(a.staffName)}</span>
              {statusChip(a)}
              <ChevronRight size={14} color="#94a3b8" />
            </div>
          )) : <div style={{ fontSize: 12, color: "#94a3b8", padding: 8 }}>Nothing else booked today</div>)}
        </div>
      </div>
    </div>
  );
}
