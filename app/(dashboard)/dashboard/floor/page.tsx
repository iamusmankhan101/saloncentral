"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Armchair, Users, Wallet, Clock, X, Check, Plus, Minus, LocateFixed } from "lucide-react";
import { getStoredAppointments, getStoredStaff, subscribeToStoredData } from "@/lib/storage";
import { getSalonInvoices, revenueAmount, localDateKey, type SalonInvoice } from "@/lib/salon-invoices";
import { getAttendance } from "@/lib/attendance";
import { settingsStore } from "@/lib/settings-store";
import { syncFromDB } from "@/lib/turso-sync";
import { getActiveSection, inSection } from "@/lib/sections";
import { fmtCurrency as fmt } from "@/lib/format";
import PageTitle from "@/components/page-title";
import MobilePageHeader from "@/components/mobile-page-header";
import { Box, FloorRing, Person, Tag, iso, pts } from "@/components/floor-sprites";
import type { Appointment } from "@/lib/types";

/**
 * Salon Floor — a live, game-style map of the salon. Everyone on it is real:
 * clients walk in when their appointment is marked Arrived, take a chair when
 * it goes In Progress and walk out when it's done; stylists on duty (from
 * Attendance, or anyone with a booking today) wait at a free chair and work
 * at their client's. Appointments don't record a chair, so a client keeps
 * whichever chair was free when they sat down.
 */

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function time12(t: string) {
  const m = toMin(t);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const clockLabel = () => new Date().toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit", second: "2-digit" });

// ── Layout ────────────────────────────────────────────────────────────────────

const PER_ROW = 6;
const SPACING = 2.6;
const ROW_GAP = 3.4;
const CORRIDOR_X = 0.45;
const SPEED = 2.4; // floor units per second

function layoutFor(chairCount: number) {
  const rows = Math.ceil(chairCount / PER_ROW);
  const W = Math.max(11, Math.min(chairCount, PER_ROW) * SPACING + 2);
  const D = rows * ROW_GAP + 4.6;
  const aisles = Array.from({ length: rows }, (_, r) => 0.9 + r * ROW_GAP + 2.3);
  const frontAisle = aisles[aisles.length - 1];
  const chair = (i: number) => ({ x: 1 + (i % PER_ROW) * SPACING, y: 0.9 + Math.floor(i / PER_ROW) * ROW_GAP });
  return {
    W, D, aisles, frontAisle, chair,
    door: { x: -0.7, y: frontAisle },
    clientSeat: (i: number) => { const c = chair(i); return { x: c.x + 0.7, y: c.y + 0.45, z: 0.5 }; },
    stylistSpot: (i: number) => { const c = chair(i); return { x: c.x + 1.65, y: c.y + 0.9, z: 0 }; },
    sofaSeat: (k: number) => k < 4 ? { x: W - 4.1 + k * 0.9, y: D - 1.4, z: 0.45 } : { x: W - 4.3 + (k - 4) * 0.75, y: D - 0.55, z: 0 },
    spareSpot: (j: number) => ({ x: W - 1.2 - (j % 6) * 0.8, y: frontAisle + 0.8 + Math.floor(j / 6) * 0.7, z: 0 }),
    desk: { x: 0.8, y: D - 2.3 },
  };
}
type Layout = ReturnType<typeof layoutFor>;

/** The aisle a point walks along: the one just in front of its chair row. */
function aisleFor(y: number, L: Layout) {
  return L.aisles.find((a) => y <= a + 0.01) ?? L.frontAisle;
}

/** Walk out to the aisle, along it (via the side corridor when changing rows), then in to the spot. */
function pathTo(from: { x: number; y: number }, to: { x: number; y: number }, L: Layout) {
  const a1 = aisleFor(from.y, L);
  const a2 = aisleFor(to.y, L);
  const steps = a1 === a2
    ? [{ x: from.x, y: a1 }, { x: to.x, y: a1 }, to]
    : [{ x: from.x, y: a1 }, { x: CORRIDOR_X, y: a1 }, { x: CORRIDOR_X, y: a2 }, { x: to.x, y: a2 }, to];
  return steps.filter((p, i) => i === steps.length - 1 || Math.hypot(p.x - from.x, p.y - from.y) > 0.05);
}

// ── Live entities ─────────────────────────────────────────────────────────────

interface Ent {
  id: string;
  kind: "client" | "staff";
  color: string;
  x: number; y: number;
  /** Where they're headed, and the seat height once they get there. */
  goal: { x: number; y: number; z: number };
  path: { x: number; y: number }[];
  leaving: boolean;
  working: boolean;
  chair?: number;
  bubble?: { text: string; until: number };
}

interface FeedItem { id: number; time: string; text: string }
interface Pop { id: number; text: string; born: number }

export default function SalonFloorPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [salesToday, setSalesToday] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [pops, setPops] = useState<Pop[]>([]);
  const [, setFrame] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const ents = useRef(new Map<string, Ent>());
  const chairOf = useRef(new Map<string, number>());
  const lastStatus = useRef(new Map<string, string>());
  const seenInvoices = useRef<Set<string> | null>(null);
  const firstLoad = useRef(true);
  const feedId = useRef(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);

  const chairCount = Math.min(24, Math.max(1, Number((settingsStore.salon as { chairCount?: number }).chairCount) || 4));
  const L = layoutFor(chairCount);

  const say = useCallback((text: string) => {
    setFeed((f) => [{ id: ++feedId.current, time: new Date().toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" }), text }, ...f].slice(0, 6));
  }, []);

  // ── Read the data and point everyone at where they should be ──
  const load = useCallback(() => {
    const today = localDateKey();
    const section = getActiveSection();
    const appts = getStoredAppointments().filter((a) => a.date === today && inSection(a, section));
    const staffList = getStoredStaff();
    const invoices = getSalonInvoices().filter((i) => i.date === today && inSection(i, section));
    const attendance = getAttendance().filter((r) => r.date === today);
    setAppointments(appts);
    setSalesToday(invoices.reduce((s, i) => s + revenueAmount(i), 0));

    const first = firstLoad.current;
    const now = Date.now();
    const byStart = (a: Appointment, b: Appointment) => toMin(a.startTime) - toMin(b.startTime) || a.id.localeCompare(b.id);
    const inProgress = appts.filter((a) => a.status === "in-progress").sort(byStart);
    const arrived = appts.filter((a) => a.status === "arrived").sort(byStart);

    // Chairs: a seated client keeps their chair; newcomers take the lowest free one.
    const keep = new Map<string, number>();
    for (const a of inProgress) { const c = chairOf.current.get(a.id); if (c != null && c < chairCount) keep.set(a.id, c); }
    const taken = new Set(keep.values());
    for (const a of inProgress) {
      if (keep.has(a.id)) continue;
      let free = 0;
      while (taken.has(free)) free++;
      if (free < chairCount) { keep.set(a.id, free); taken.add(free); }
    }
    chairOf.current = keep;

    const spawn = (id: string, kind: Ent["kind"], color: string, at: { x: number; y: number; z: number }): Ent => {
      const start = first ? at : L.door;
      const e: Ent = { id, kind, color, x: start.x, y: start.y, goal: at, path: first ? [] : pathTo(start, at, L), leaving: false, working: false };
      ents.current.set(id, e);
      return e;
    };
    const send = (e: Ent, to: { x: number; y: number; z: number }) => {
      if (Math.hypot(e.goal.x - to.x, e.goal.y - to.y) < 0.05 && !e.leaving) return;
      e.leaving = false;
      e.goal = to;
      e.path = pathTo(e, to, L);
    };

    // Clients
    const present = new Set<string>();
    let spare = 0;
    for (const a of inProgress) {
      const chair = keep.get(a.id);
      const at = chair != null ? L.clientSeat(chair) : L.sofaSeat(arrived.length + spare++);
      const id = `appt:${a.id}`;
      present.add(id);
      const e = ents.current.get(id) ?? spawn(id, "client", "#e5e7eb", at);
      e.chair = chair;
      send(e, at);
    }
    arrived.forEach((a, k) => {
      const id = `appt:${a.id}`;
      present.add(id);
      const e = ents.current.get(id) ?? spawn(id, "client", "#e5e7eb", L.sofaSeat(k));
      e.chair = undefined;
      send(e, L.sofaSeat(k));
    });

    // Stylists on duty: anyone with a client today (finished ones included — they
    // don't go home after one client), plus anyone checked in on Attendance.
    // Clocking out on Attendance is what takes them off the floor.
    const clockedOut = new Set(attendance.filter((r) => r.checkOut).map((r) => r.staffId));
    const onDuty = new Set(attendance.filter((r) => ["present", "late", "half-day"].includes(r.status)).map((r) => r.staffId));
    for (const a of appts) if (!["cancelled", "no-show"].includes(a.status) && a.staffId) onDuty.add(a.staffId);
    for (const id of clockedOut) onDuty.delete(id);
    const busyChairByStaff = new Map<string, number>();
    for (const a of inProgress) { const c = keep.get(a.id); if (c != null && a.staffId && !busyChairByStaff.has(a.staffId)) busyChairByStaff.set(a.staffId, c); }
    const freeChairs = Array.from({ length: chairCount }, (_, i) => i).filter((i) => !taken.has(i));
    let idle = 0;
    for (const s of staffList.filter((st) => st.isActive && onDuty.has(st.id)).slice(0, 12)) {
      const id = `staff:${s.id}`;
      present.add(id);
      const busy = busyChairByStaff.get(s.id);
      const at = busy != null ? L.stylistSpot(busy)
        : idle < freeChairs.length ? L.stylistSpot(freeChairs[idle++])
        : L.spareSpot(idle++ - freeChairs.length);
      const e = ents.current.get(id) ?? spawn(id, "staff", s.color || "#7C3AED", at);
      e.color = s.color || "#7C3AED";
      e.chair = busy;
      send(e, at);
    }

    // Anyone no longer on the floor walks out of the door.
    for (const e of ents.current.values()) {
      if (present.has(e.id) || e.leaving) continue;
      e.leaving = true;
      e.working = false;
      e.goal = { ...L.door, z: 0 };
      e.path = pathTo(e, L.door, L);
    }

    // ── What changed since the last look → activity feed ──
    if (!first) {
      for (const a of appts) {
        const before = lastStatus.current.get(a.id);
        if (before === a.status) continue;
        const e = ents.current.get(`appt:${a.id}`);
        if (a.status === "arrived") { say(`${a.clientName} arrived`); if (e) e.bubble = { text: "👋", until: now + 4000 }; }
        else if (a.status === "in-progress") { say(`${a.clientName} sat in Chair ${(keep.get(a.id) ?? 0) + 1} with ${firstName(a.staffName)}`); if (e) e.bubble = { text: "✨", until: now + 4000 }; }
        else if (a.status === "completed") say(`${a.clientName} finished with ${firstName(a.staffName)}`);
        else if (a.status === "no-show") say(`${a.clientName} didn't show up`);
        else if (!before && (a.status === "booked" || a.status === "confirmed")) say(`New booking: ${a.clientName} at ${time12(a.startTime)}`);
      }
    }
    lastStatus.current = new Map(appts.map((a) => [a.id, a.status]));

    const fresh: SalonInvoice[] = seenInvoices.current ? invoices.filter((i) => !seenInvoices.current!.has(i.id)) : [];
    seenInvoices.current = new Set(invoices.map((i) => i.id));
    for (const inv of fresh) {
      say(`Paid ${fmt(revenueAmount(inv))} · ${inv.clientName}`);
      setPops((p) => [...p, { id: ++feedId.current, text: `+${fmt(revenueAmount(inv))}`, born: now }]);
    }
    if (first) say(`Floor open · ${[...onDuty].length} staff on duty`);
    firstLoad.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chairCount, say]);

  useEffect(() => {
    load();
    const unsubscribe = subscribeToStoredData(load);
    // A board left open at reception: pull other devices' changes every 30s.
    const timer = setInterval(() => { syncFromDB().finally(load); }, 30_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [load]);

  // ── Game loop: move everyone a little each frame ──
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastPaint = 0;
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const e of [...ents.current.values()]) {
        let budget = SPEED * dt;
        while (budget > 0 && e.path.length) {
          const p = e.path[0];
          const dist = Math.hypot(p.x - e.x, p.y - e.y);
          if (dist <= budget) { e.x = p.x; e.y = p.y; e.path.shift(); budget -= dist; }
          else { e.x += ((p.x - e.x) / dist) * budget; e.y += ((p.y - e.y) / dist) * budget; budget = 0; }
        }
        if (e.leaving && !e.path.length) ents.current.delete(e.id);
        e.working = e.kind === "staff" && e.chair != null && !e.path.length;
      }
      if (now - lastPaint > 33) { lastPaint = now; setFrame(now); } // ~30fps is plenty
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!pops.length) return;
    const t = setTimeout(() => setPops((p) => p.filter((x) => Date.now() - x.born < 2600)), 2700);
    return () => clearTimeout(t);
  }, [pops]);

  // ── Derived view ──
  const t = performance.now() / 1000;
  const minute = nowMin();
  const hour = new Date().getHours();
  const night = hour >= 18 || hour < 7;
  const byStart = (a: Appointment, b: Appointment) => toMin(a.startTime) - toMin(b.startTime);
  const seatedAppts = new Map<number, Appointment>();
  for (const a of appointments) { const c = chairOf.current.get(a.id); if (a.status === "in-progress" && c != null) seatedAppts.set(c, a); }
  const inService = appointments.filter((a) => a.status === "in-progress").length;
  const waiting = appointments.filter((a) => a.status === "arrived").sort(byStart);
  const upcoming = appointments.filter((a) => (a.status === "booked" || a.status === "confirmed") && toMin(a.startTime) >= minute - 15).sort(byStart);
  const onDutyCount = [...ents.current.values()].filter((e) => e.kind === "staff" && !e.leaving).length;
  const appt = selected != null ? seatedAppts.get(selected) : undefined;
  const busy = seatedAppts.size;
  const { W, D } = L;

  // Everything that stands on the floor is drawn far-to-near so nearer things overlap farther ones.
  const drawables: { depth: number; node: ReactNode }[] = [];
  const add = (depth: number, node: ReactNode) => drawables.push({ depth, node });

  for (let i = 0; i < chairCount; i++) {
    const { x, y } = L.chair(i);
    const a = seatedAppts.get(i);
    const pick = () => setSelected(a ? (selected === i ? null : i) : null);
    const base = x + y + 1.2;
    add(base - 1.4, (
      <g key={`m${i}`}>
        <Box x={x - 0.1} y={y - 0.75} w={1.6} d={0.25} h={0.9} color="#ffffff" />
        <Box x={x + 0.05} y={y - 0.7} z={0.9} w={1.3} d={0.1} h={1.3} color={a ? "#c4b5fd" : night ? "#bfdbfe" : "#dbeafe"} />
        {night && <circle cx={iso(x + 0.7, y - 0.65, 2.35)[0]} cy={iso(x + 0.7, y - 0.65, 2.35)[1]} r={5} fill="#fde68a" opacity={0.9} />}
      </g>
    ));
    add(base - 0.6, (
      <g key={`c${i}`} onClick={pick} style={{ cursor: a ? "pointer" : "default" }}>
        {a && <FloorRing x={x + 0.7} y={y + 0.6} pct={((minute - toMin(a.startTime)) / Math.max(1, toMin(a.endTime) - toMin(a.startTime))) * 100} />}
        {selected === i && <polygon points={pts([[x - 0.3, y - 0.5, 0], [x + 2.2, y - 0.5, 0], [x + 2.2, y + 1.8, 0], [x - 0.3, y + 1.8, 0]])} fill="rgba(124,58,237,0.10)" stroke="#7C3AED" strokeWidth={1.5} />}
        <Box x={x + 0.35} y={y + 0.25} w={0.7} d={0.7} h={0.15} color="#9ca3af" />
        <Box x={x + 0.2} y={y + 0.15} z={0.15} w={1} d={0.9} h={0.35} color={a ? "#7C3AED" : "#c7c2e8"} />
      </g>
    ));
    add(base + 0.05, <g key={`b${i}`} onClick={pick} style={{ cursor: a ? "pointer" : "default" }}><Box x={x + 0.2} y={y + 0.85} z={0.5} w={1} d={0.2} h={0.5} color={a ? "#6d28d9" : "#b8b2de"} /></g>);
  }

  // Reception desk (with a receptionist) and the waiting sofa.
  add(L.desk.x + L.desk.y + 1.3, <g key="rcp"><Person id="reception" x={L.desk.x + 1.6} y={L.desk.y - 0.35} z={0} color="#1e1b4b" t={t} /></g>);
  add(L.desk.x + L.desk.y + 2.1, (
    <g key="desk">
      <Box x={L.desk.x} y={L.desk.y} w={3.2} d={1} h={1.1} color="#ffffff" />
      <Box x={L.desk.x} y={L.desk.y} z={1.1} w={3.2} d={1} h={0.08} color="#a78bfa" />
      <Box x={L.desk.x + 0.4} y={L.desk.y + 0.2} z={1.18} w={0.6} d={0.4} h={0.35} color="#334155" />
    </g>
  ));
  add(W - 4.6 + D - 2.1, <g key="sofaBack"><Box x={W - 4.6} y={D - 2.1} w={3.8} d={0.25} h={1} color="#f9a8d4" /></g>);
  add(W - 2.7 + D - 1.4 - 0.01, <g key="sofa"><Box x={W - 4.6} y={D - 1.9} w={3.8} d={1} h={0.45} color="#fbcfe8" /></g>);

  // Plants
  for (const [px, py] of [[W - 0.8, 0.6], [0.6, D - 0.6], [W - 0.6, D - 3]]) {
    const [cx, cy] = iso(px, py, 1.1);
    add(px + py, (
      <g key={`p${px}${py}`}>
        <Box x={px - 0.25} y={py - 0.25} w={0.5} d={0.5} h={0.5} color="#e7e5e4" />
        <circle cx={cx} cy={cy} r={15} fill="#86efac" />
        <circle cx={cx - 5} cy={cy - 4} r={9} fill="#4ade80" />
      </g>
    ));
  }

  // People
  for (const e of ents.current.values()) {
    const arrivedAtSeat = !e.path.length && !e.leaving;
    const seated = e.kind === "client" && arrivedAtSeat && e.goal.z > 0;
    const z = seated ? e.goal.z : 0;
    // A seated client sits between the chair seat and its backrest, or on top of the sofa.
    const depth = !seated ? e.x + e.y
      : e.chair != null ? L.chair(e.chair).x + L.chair(e.chair).y + 1.2 - 0.3
      : W - 2.7 + D - 1.4 + e.x * 0.001;
    const onClick = e.chair != null ? () => setSelected(selected === e.chair ? null : e.chair!) : undefined;
    add(depth, (
      <g key={e.id} onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
        <Person id={e.id} x={e.x} y={e.y} z={z} color={e.color} tall={e.kind === "staff"} t={t}
          walking={e.path.length > 0} working={e.working} seated={seated} selected={e.chair != null && e.chair === selected} />
        {e.bubble && e.bubble.until > Date.now() && (() => { const [bx, by] = iso(e.x, e.y, z + 1.7); return <text x={bx} y={by} fontSize={16} textAnchor="middle">{e.bubble.text}</text>; })()}
      </g>
    ));
  }
  drawables.sort((a, b) => a.depth - b.depth);

  // Camera
  const corners = [iso(0, 0, 2.6), iso(W, 0, 2.6), iso(W, D), iso(0, D), iso(0, 0)];
  const minX = Math.min(...corners.map((c) => c[0])) - 50;
  const maxX = Math.max(...corners.map((c) => c[0])) + 50;
  const minY = Math.min(...corners.map((c) => c[1])) - 50;
  const maxY = Math.max(...corners.map((c) => c[1])) + 30;
  const vbW = maxX - minX;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const unitsPerPx = () => vbW / (svgRef.current?.clientWidth || vbW);

  const [doorX0, doorY0] = iso(0, L.frontAisle - 0.6);
  const [doorX1, doorY1] = iso(0, L.frontAisle + 0.6);

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 16 }}>
      <style>{`@keyframes floorPulse{0%,100%{opacity:1}50%{opacity:.25}} @keyframes feedIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
      <MobilePageHeader title="Salon Floor" subtitle={`${busy} of ${chairCount} chairs busy`} />
      <div className="page-header desktop-only">
        <PageTitle icon={<Armchair size={24} />} title="Salon Floor" subtitle="Live view of your chairs, waiting area and upcoming bookings" />
      </div>

      {/* ── Stat cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {[
          { icon: <Armchair size={18} />, label: "Chairs busy", value: `${busy} / ${chairCount}`, note: inService > busy ? `+${inService - busy} more in service` : `${chairCount - busy} free · ${onDutyCount} staff on floor` },
          { icon: <Users size={18} />, label: "Clients in salon", value: String(inService + waiting.length), note: `${waiting.length} waiting` },
          { icon: <Wallet size={18} />, label: "Sales today", value: fmt(salesToday), note: "from invoices" },
          { icon: <Clock size={18} />, label: "Next booking", value: upcoming[0] ? time12(upcoming[0].startTime) : "—", note: upcoming[0] ? upcoming[0].clientName : "No more today" },
        ].map((c) => (
          <div key={c.label} style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 14, border: "1px solid #ece9f5", background: "#fff", boxShadow: "0 4px 14px rgba(30,27,75,0.05)" }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, background: "#F5F3FF", color: "#7C3AED", display: "grid", placeItems: "center", flexShrink: 0 }}>{c.icon}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "#6b6b8a", fontWeight: 600 }}>{c.label}</div>
              <div style={{ fontSize: 19, fontWeight: 800, color: "#1a1a2e", lineHeight: 1.2 }}>{c.value}</div>
              <div style={{ fontSize: 11, color: "#9898b0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.note}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* ── Floor map ── */}
        <div style={{ position: "relative", flex: "1 1 520px", minWidth: 0, borderRadius: 18, background: night ? "linear-gradient(180deg,#1e1b4b,#312e81)" : "linear-gradient(180deg,#eef0fb,#f7f7fd)", border: "1px solid #ece9f5", overflow: "hidden", touchAction: "none" }}>
          <svg ref={svgRef} viewBox={`${minX} ${minY} ${vbW} ${maxY - minY}`} style={{ width: "100%", height: "auto", display: "block", fontFamily: "inherit", cursor: drag.current ? "grabbing" : "grab", userSelect: "none" }}
            role="img" aria-label="Live map of the salon floor"
            onPointerDown={(ev) => { drag.current = { x: ev.clientX, y: ev.clientY, px: pan.x, py: pan.y, moved: false }; }}
            onPointerMove={(ev) => {
              const d = drag.current;
              if (!d) return;
              const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
              if (d.moved) setPan({ x: d.px + dx * unitsPerPx(), y: d.py + dy * unitsPerPx() });
            }}
            onPointerUp={() => { setTimeout(() => { drag.current = null; }, 0); }}
            onPointerLeave={() => { drag.current = null; }}
            onClickCapture={(ev) => { if (drag.current?.moved) ev.stopPropagation(); }}
          >
            <g transform={`translate(${pan.x} ${pan.y}) translate(${midX} ${midY}) scale(${zoom}) translate(${-midX} ${-midY})`}>
              {/* Floor, tiles and walls */}
              <polygon points={pts([[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]])} fill={night ? "#e9e7f5" : "#ffffff"} stroke="#e3e0f0" />
              {Array.from({ length: Math.ceil(W) * Math.ceil(D) }, (_, k) => {
                const i = k % Math.ceil(W), j = Math.floor(k / Math.ceil(W));
                if ((i + j) % 2 || i + 1 > W || j + 1 > D) return null;
                return <polygon key={`t${k}`} points={pts([[i, j, 0], [i + 1, j, 0], [i + 1, j + 1, 0], [i, j + 1, 0]])} fill={night ? "#dedbee" : "#f6f5fc"} />;
              })}
              <polygon points={pts([[0, 0, 0], [W, 0, 0], [W, 0, 2.6], [0, 0, 2.6]])} fill={night ? "#c7c2e8" : "#e4e2f7"} />
              <polygon points={pts([[0, 0, 0], [0, D, 0], [0, D, 2.6], [0, 0, 2.6]])} fill={night ? "#b4aedd" : "#d6d3f0"} />
              <polygon points={pts([[0, L.frontAisle - 0.6, 0], [0, L.frontAisle + 0.6, 0], [0, L.frontAisle + 0.6, 2], [0, L.frontAisle - 0.6, 2]])} fill="#a78bfa" />
              <line x1={doorX0} y1={doorY0} x2={doorX1} y2={doorY1} stroke="#7C3AED" strokeWidth={3} />
              <text {...{ x: iso(0, L.frontAisle, 2.3)[0], y: iso(0, L.frontAisle, 2.3)[1] }} fontSize={10} fontWeight={800} fill="#ffffff" stroke="#4c1d95" strokeWidth={3} paintOrder="stroke" textAnchor="middle">ENTRANCE</text>
              {/* Path along the front aisle */}
              <polyline points={pts([[0, L.frontAisle, 0], [W - 0.5, L.frontAisle, 0]])} stroke="#e9d5ff" strokeWidth={6} strokeDasharray="10 10" fill="none" />

              {drawables.map((d) => d.node)}

              {/* Labels on top of everything */}
              {Array.from({ length: chairCount }, (_, i) => {
                const { x, y } = L.chair(i);
                const a = seatedAppts.get(i);
                const left = a ? toMin(a.endTime) - minute : 0;
                return <Tag key={`l${i}`} x={x + 0.7} y={y - 0.3} z={2.75} tone={a ? (left < 0 ? "warn" : "busy") : "free"}
                  text={a ? `${firstName(a.staffName) || `Chair ${i + 1}`} · ${left > 0 ? `${left}m left` : left === 0 ? "finishing" : `${-left}m over`}` : `Chair ${i + 1} · Free`} />;
              })}
              <Tag x={L.desk.x + 1.6} y={L.desk.y + 0.5} z={2.1} tone="info" text={upcoming.length ? `Reception · ${upcoming.length} coming` : "Reception"} />
              <Tag x={W - 2.7} y={D - 1.5} z={2.1} tone="info" text={waiting.length ? `Waiting · ${waiting.length}` : "Waiting area"} />
              {pops.map((p) => {
                const age = (Date.now() - p.born) / 1000;
                const [px, py] = iso(L.desk.x + 1.6, L.desk.y + 0.5, 2.6);
                return <text key={p.id} x={px} y={py - age * 28} textAnchor="middle" fontSize={16} fontWeight={900} fill="#059669" opacity={Math.max(0, 1 - age / 2.6)} stroke="#fff" strokeWidth={3} paintOrder="stroke">💰 {p.text}</text>;
              })}
            </g>
          </svg>

          {/* HUD */}
          <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, background: "rgba(255,255,255,0.92)", boxShadow: "0 4px 14px rgba(30,27,75,0.12)", fontSize: 12, fontWeight: 800, color: "#1a1a2e" }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: "#10b981", animation: "floorPulse 1.4s infinite" }} /> LIVE <span style={{ fontWeight: 600, color: "#6b6b8a", fontVariantNumeric: "tabular-nums" }}>{clockLabel()}</span>
          </div>
          <div style={{ position: "absolute", top: 12, right: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { label: "Zoom in", icon: <Plus size={15} />, on: () => setZoom((z) => Math.min(2.2, z + 0.2)) },
              { label: "Zoom out", icon: <Minus size={15} />, on: () => setZoom((z) => Math.max(0.6, z - 0.2)) },
              { label: "Reset view", icon: <LocateFixed size={15} />, on: () => { setZoom(1); setPan({ x: 0, y: 0 }); } },
            ].map((b) => (
              <button key={b.label} type="button" aria-label={b.label} title={b.label} onClick={b.on}
                style={{ width: 32, height: 32, borderRadius: 9, border: "none", background: "rgba(255,255,255,0.92)", boxShadow: "0 4px 14px rgba(30,27,75,0.12)", display: "grid", placeItems: "center", cursor: "pointer", color: "#1a1a2e" }}>{b.icon}</button>
            ))}
          </div>
          <div style={{ position: "absolute", left: 12, bottom: 12, width: "min(300px, calc(100% - 24px))", padding: "10px 12px", borderRadius: 14, background: "rgba(255,255,255,0.94)", boxShadow: "0 8px 24px rgba(30,27,75,0.14)", pointerEvents: "none" }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: "#7C3AED", textTransform: "uppercase", marginBottom: 6 }}>Activity</div>
            {feed.slice(0, 4).map((f) => (
              <div key={f.id} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0", animation: "feedIn .4s ease-out" }}>
                <span style={{ color: "#9898b0", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{f.time}</span>
                <span style={{ color: "#1a1a2e", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Side panel ── */}
        <div style={{ flex: "0 1 300px", minWidth: 260, display: "flex", flexDirection: "column", gap: 12 }}>
          {appt ? (
            <div style={{ borderRadius: 16, border: "1px solid #ece9f5", padding: 16, background: "#fff", boxShadow: "0 8px 24px rgba(30,27,75,0.08)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: "#7C3AED", textTransform: "uppercase" }}>Chair {selected! + 1}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a2e", marginTop: 2 }}>{appt.clientName}</div>
                </div>
                <button type="button" aria-label="Close" onClick={() => setSelected(null)} style={{ border: "none", background: "#f4f4f9", borderRadius: 8, width: 28, height: 28, display: "grid", placeItems: "center", cursor: "pointer" }}><X size={14} /></button>
              </div>
              {[
                ["Stylist", appt.staffName || "—"],
                ["Services", appt.serviceNames.join(", ") || "—"],
                ["Started", time12(appt.startTime)],
                ["Expected finish", time12(appt.endTime)],
                ["Amount", fmt(appt.totalAmount || 0)],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid #f1f0f8", fontSize: 12 }}>
                  <span style={{ color: "#6b6b8a" }}>{k}</span><span style={{ color: "#1a1a2e", fontWeight: 700, textAlign: "right" }}>{v}</span>
                </div>
              ))}
              {(() => {
                const total = Math.max(1, toMin(appt.endTime) - toMin(appt.startTime));
                const pct = Math.min(100, Math.max(0, ((minute - toMin(appt.startTime)) / total) * 100));
                return (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ height: 6, borderRadius: 3, background: "#ede9fe" }}><div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: "#7C3AED" }} /></div>
                    <div style={{ fontSize: 11, color: "#6b6b8a", marginTop: 6 }}>{Math.round(pct)}% through the appointment</div>
                  </div>
                );
              })()}
              <Link href="/dashboard/appointments" style={{ display: "block", marginTop: 12, textAlign: "center", padding: "9px 0", borderRadius: 10, background: "#7C3AED", color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>Open in Appointments</Link>
            </div>
          ) : (
            <div style={{ borderRadius: 16, border: "1px dashed #d9d4ee", padding: 16, fontSize: 12, color: "#6b6b8a", background: "#fcfbff", lineHeight: 1.6 }}>
              Tap a busy chair to see who&apos;s in it. Clients walk in when their appointment is marked <b>Arrived</b>, take a chair at <b>In Progress</b>, and leave when it&apos;s <b>Completed</b>. Drag the map to look around.
            </div>
          )}

          <div style={{ borderRadius: 16, border: "1px solid #ece9f5", padding: 14, background: "#fff" }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Waiting ({waiting.length})</div>
            {waiting.length === 0 && <div style={{ fontSize: 12, color: "#9898b0" }}>No one waiting</div>}
            {waiting.map((w) => (
              <div key={w.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "5px 0" }}>
                <span style={{ color: "#1a1a2e", fontWeight: 600 }}>{w.clientName}</span><span style={{ color: "#6b6b8a" }}>{time12(w.startTime)} · {firstName(w.staffName)}</span>
              </div>
            ))}
            <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", margin: "12px 0 8px" }}>Coming up ({upcoming.length})</div>
            {upcoming.length === 0 && <div style={{ fontSize: 12, color: "#9898b0" }}>Nothing else booked today</div>}
            {upcoming.slice(0, 6).map((u) => (
              <div key={u.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "5px 0" }}>
                <span style={{ color: "#1a1a2e", fontWeight: 600 }}>{u.clientName}</span><span style={{ color: "#6b6b8a" }}>{time12(u.startTime)} · {firstName(u.staffName)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Client journey ── */}
      {appt && (
        <div style={{ borderRadius: 16, border: "1px solid #ece9f5", padding: "14px 18px", background: "#fff" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", marginBottom: 12 }}>Client journey · {appt.clientName}</div>
          <div style={{ display: "flex", alignItems: "center" }}>
            {[
              { label: "Booked", sub: appt.source === "walk-in" ? "Walk-in" : "Booked", done: true },
              { label: "Arrived", sub: "Checked in", done: true },
              { label: "In chair", sub: time12(appt.startTime), done: true, current: true },
              { label: "Paid", sub: `ETA ${time12(appt.endTime)}`, done: false },
            ].map((s, i, all) => (
              <div key={s.label} style={{ display: "flex", alignItems: "center", flex: i < all.length - 1 ? 1 : "0 0 auto" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                  <div style={{ width: 26, height: 26, borderRadius: 13, display: "grid", placeItems: "center", background: s.done ? "#7C3AED" : "#ede9fe", color: "#fff", boxShadow: s.current ? "0 0 0 4px rgba(124,58,237,0.2)" : "none" }}>
                    {s.done ? <Check size={14} /> : null}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#1a1a2e", marginTop: 6 }}>{s.label}</div>
                  <div style={{ fontSize: 10, color: "#9898b0" }}>{s.sub}</div>
                </div>
                {i < all.length - 1 && <div style={{ flex: 1, height: 2, background: all[i + 1].done ? "#7C3AED" : "#ede9fe", margin: "0 4px 30px" }} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
