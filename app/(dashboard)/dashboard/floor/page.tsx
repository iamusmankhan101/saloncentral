"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Armchair, Users, Wallet, Clock, X, Check } from "lucide-react";
import { getStoredAppointments, getStoredStaff, subscribeToStoredData } from "@/lib/storage";
import { getSalonInvoices, revenueAmount, localDateKey } from "@/lib/salon-invoices";
import { settingsStore } from "@/lib/settings-store";
import { syncFromDB } from "@/lib/turso-sync";
import { getActiveSection, inSection } from "@/lib/sections";
import { fmtCurrency as fmt } from "@/lib/format";
import PageTitle from "@/components/page-title";
import MobilePageHeader from "@/components/mobile-page-header";
import type { Appointment, Staff } from "@/lib/types";

/**
 * Salon Floor — a live, isometric map of the salon: who is in which chair,
 * who is waiting, and what's coming up. Appointments don't record a chair, so
 * clients "in progress" are seated in start-time order; the chair count comes
 * from Account settings.
 */

// ── Isometric drawing ─────────────────────────────────────────────────────────

const U = 34; // pixels per floor unit
const COS = 0.866;

function iso(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * U * COS, (x + y) * U * 0.5 - z * U];
}
const pts = (list: [number, number, number][]) => list.map(([x, y, z]) => iso(x, y, z).join(",")).join(" ");

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const f = (c: number) => Math.round(c * (1 - amount));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** A solid box: top plus the two faces turned towards the viewer. */
function Box({ x, y, z = 0, w, d, h, color }: { x: number; y: number; z?: number; w: number; d: number; h: number; color: string }) {
  const t = z + h;
  return (
    <g>
      <polygon points={pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, t], [x + w, y, t]])} fill={shade(color, 0.14)} />
      <polygon points={pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, t], [x, y + d, t]])} fill={shade(color, 0.28)} />
      <polygon points={pts([[x, y, t], [x + w, y, t], [x + w, y + d, t], [x, y + d, t]])} fill={color} />
    </g>
  );
}

/** A simple standing or seated figure. */
function Person({ x, y, z, color, tall = false }: { x: number; y: number; z: number; color: string; tall?: boolean }) {
  const [cx, cy] = iso(x, y, z);
  const body = tall ? 30 : 20;
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx={9} ry={4} fill="rgba(30,27,75,0.12)" />
      <rect x={cx - 8} y={cy - body} width={16} height={body} rx={8} fill={color} />
      <circle cx={cx} cy={cy - body - 7} r={7.5} fill="#f2c9a5" />
      <path d={`M${cx - 7.5} ${cy - body - 8} a7.5 7.5 0 0 1 15 0 z`} fill="#3b2f2f" />
    </g>
  );
}

function Tag({ x, y, z, text, tone }: { x: number; y: number; z: number; text: string; tone: "busy" | "free" | "info" }) {
  const [cx, cy] = iso(x, y, z);
  const width = Math.max(44, text.length * 6.4 + 16);
  const bg = tone === "busy" ? "#7C3AED" : tone === "free" ? "#ffffff" : "#1e1b4b";
  const fg = tone === "free" ? "#059669" : "#ffffff";
  return (
    <g>
      <rect x={cx - width / 2} y={cy - 11} width={width} height={20} rx={10} fill={bg} stroke={tone === "free" ? "#d1fae5" : "none"} />
      <text x={cx} y={cy + 3} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={fg}>{text}</text>
    </g>
  );
}

// ── Data ──────────────────────────────────────────────────────────────────────

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function time12(t: string) {
  const m = toMin(t);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

const PER_ROW = 6;
const SPACING = 2.6;

export default function SalonFloorPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [salesToday, setSalesToday] = useState(0);
  const [minute, setMinute] = useState(nowMin());
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const load = () => {
      const today = localDateKey();
      const section = getActiveSection();
      setAppointments(getStoredAppointments().filter((a) => a.date === today && inSection(a, section)));
      setStaff(getStoredStaff());
      setSalesToday(getSalonInvoices().filter((i) => i.date === today && inSection(i, section)).reduce((s, i) => s + revenueAmount(i), 0));
      setMinute(nowMin());
    };
    load();
    const unsubscribe = subscribeToStoredData(load);
    // A board left open at reception: pull other devices' changes every minute.
    const timer = setInterval(() => { syncFromDB().finally(load); }, 60_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);

  const chairCount = Math.min(24, Math.max(1, Number((settingsStore.salon as { chairCount?: number }).chairCount) || 4));

  const { seated, overflow, waiting, upcoming } = useMemo(() => {
    const byStart = (a: Appointment, b: Appointment) => toMin(a.startTime) - toMin(b.startTime) || a.id.localeCompare(b.id);
    const inChair = appointments.filter((a) => a.status === "in-progress").sort(byStart);
    return {
      seated: inChair.slice(0, chairCount),
      overflow: inChair.length - Math.min(inChair.length, chairCount),
      waiting: appointments.filter((a) => a.status === "arrived").sort(byStart),
      upcoming: appointments.filter((a) => (a.status === "booked" || a.status === "confirmed") && toMin(a.startTime) >= minute - 15).sort(byStart),
    };
  }, [appointments, chairCount, minute]);

  const staffColor = (id: string) => staff.find((s) => s.id === id)?.color || "#7C3AED";

  // Floor size grows with the chair count.
  const rows = Math.ceil(chairCount / PER_ROW);
  const perRow = Math.min(chairCount, PER_ROW);
  const W = Math.max(11, perRow * SPACING + 2);
  const D = rows * 3.4 + 4.6;
  const chairPos = (i: number) => ({ x: 1 + (i % PER_ROW) * SPACING, y: 0.9 + Math.floor(i / PER_ROW) * 3.4 });

  const corners = [iso(0, 0, 2.6), iso(W, 0, 2.6), iso(W, D), iso(0, D), iso(0, 0)];
  const minX = Math.min(...corners.map((c) => c[0])) - 40;
  const maxX = Math.max(...corners.map((c) => c[0])) + 40;
  const minY = Math.min(...corners.map((c) => c[1])) - 40;
  const maxY = Math.max(...corners.map((c) => c[1])) + 30;

  const appt = selected != null ? seated[selected] : undefined;
  const busy = seated.length;

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 16 }}>
      <MobilePageHeader title="Salon Floor" subtitle={`${busy} of ${chairCount} chairs busy`} />
      <div className="page-header desktop-only">
        <PageTitle icon={<Armchair size={24} />} title="Salon Floor" subtitle="Live view of your chairs, waiting area and upcoming bookings" />
      </div>

      {/* ── Stat cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {[
          { icon: <Armchair size={18} />, label: "Chairs busy", value: `${busy} / ${chairCount}`, note: overflow > 0 ? `+${overflow} more in service` : `${chairCount - busy} free` },
          { icon: <Users size={18} />, label: "Clients in salon", value: String(busy + overflow + waiting.length), note: `${waiting.length} waiting` },
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
        <div style={{ flex: "1 1 520px", minWidth: 0, borderRadius: 18, background: "linear-gradient(180deg,#eef0fb,#f7f7fd)", border: "1px solid #ece9f5", overflow: "hidden" }}>
          <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} style={{ width: "100%", height: "auto", display: "block", fontFamily: "inherit" }} role="img" aria-label="Map of the salon floor">
            {/* Floor and walls */}
            <polygon points={pts([[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]])} fill="#ffffff" stroke="#e3e0f0" />
            {Array.from({ length: Math.floor(W) - 1 }, (_, i) => (
              <polyline key={`gx${i}`} points={pts([[i + 1, 0, 0], [i + 1, D, 0]])} stroke="#f1f0f8" fill="none" />
            ))}
            <polygon points={pts([[0, 0, 0], [W, 0, 0], [W, 0, 2.6], [0, 0, 2.6]])} fill="#e4e2f7" />
            <polygon points={pts([[0, 0, 0], [0, D, 0], [0, D, 2.6], [0, 0, 2.6]])} fill="#d6d3f0" />

            {/* Chairs, back-to-front so nearer ones paint over farther ones */}
            {Array.from({ length: chairCount }, (_, i) => {
              const { x, y } = chairPos(i);
              const a = seated[i];
              const isSel = selected === i;
              const left = a ? toMin(a.endTime) - minute : 0;
              return (
                <g key={i} onClick={() => setSelected(a ? (isSel ? null : i) : null)} style={{ cursor: a ? "pointer" : "default" }}>
                  {isSel && <polygon points={pts([[x - 0.3, y - 0.5, 0], [x + 2.1, y - 0.5, 0], [x + 2.1, y + 1.8, 0], [x - 0.3, y + 1.8, 0]])} fill="rgba(124,58,237,0.12)" stroke="#7C3AED" strokeWidth={1.5} />}
                  {/* Mirror station */}
                  <Box x={x - 0.1} y={y - 0.75} w={1.6} d={0.25} h={0.9} color="#ffffff" />
                  <Box x={x + 0.05} y={y - 0.7} z={0.9} w={1.3} d={0.1} h={1.3} color={a ? "#c4b5fd" : "#dbeafe"} />
                  {/* Chair */}
                  <Box x={x + 0.35} y={y + 0.25} w={0.7} d={0.7} h={0.15} color="#9ca3af" />
                  <Box x={x + 0.2} y={y + 0.15} z={0.15} w={1} d={0.9} h={0.35} color={a ? "#7C3AED" : "#c7c2e8"} />
                  {a && <Person x={x + 0.7} y={y + 0.45} z={0.5} color="#e5e7eb" />}
                  {/* Backrest faces away from the mirror, so it goes in front of the client */}
                  <Box x={x + 0.2} y={y + 0.85} z={0.5} w={1} d={0.2} h={0.5} color={a ? "#6d28d9" : "#b8b2de"} />
                  {a && <Person x={x + 1.65} y={y + 0.9} z={0} color={staffColor(a.staffId)} tall />}
                  <Tag x={x + 0.7} y={y - 0.3} z={2.7} tone={a ? "busy" : "free"}
                    text={a ? `${a.staffName.split(" ")[0] || "Chair " + (i + 1)} · ${left > 0 ? `${left}m left` : "finishing"}` : `Chair ${i + 1} · Free`} />
                </g>
              );
            })}

            {/* Reception desk */}
            <Box x={0.8} y={D - 2.3} w={3.2} d={1} h={1.1} color="#ffffff" />
            <Box x={0.8} y={D - 2.3} z={1.1} w={3.2} d={1} h={0.08} color="#a78bfa" />
            <Tag x={2.4} y={D - 1.8} z={2} tone="info" text={upcoming.length ? `Reception · ${upcoming.length} coming` : "Reception"} />

            {/* Waiting sofa */}
            <Box x={W - 4.6} y={D - 1.9} w={3.8} d={1} h={0.45} color="#fbcfe8" />
            <Box x={W - 4.6} y={D - 2.1} z={0} w={3.8} d={0.25} h={1} color="#f9a8d4" />
            {waiting.slice(0, 4).map((w, i) => (
              <Person key={w.id} x={W - 4.1 + i * 0.9} y={D - 1.4} z={0.45} color="#e5e7eb" />
            ))}
            <Tag x={W - 2.7} y={D - 1.5} z={2.1} tone="info" text={waiting.length ? `Waiting · ${waiting.length}` : "Waiting area"} />

            {/* Plants */}
            {[[W - 0.8, 0.6], [0.6, D - 0.6]].map(([px, py]) => {
              const [cx, cy] = iso(px, py, 1.1);
              return (
                <g key={`${px}-${py}`}>
                  <Box x={px - 0.25} y={py - 0.25} w={0.5} d={0.5} h={0.5} color="#e7e5e4" />
                  <circle cx={cx} cy={cy} r={15} fill="#86efac" />
                  <circle cx={cx - 5} cy={cy - 4} r={9} fill="#4ade80" />
                </g>
              );
            })}
          </svg>
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
            <div style={{ borderRadius: 16, border: "1px dashed #d9d4ee", padding: 16, fontSize: 12, color: "#6b6b8a", background: "#fcfbff" }}>
              Tap a busy chair to see who&apos;s in it. Clients appear in a chair when their appointment is marked <b>In Progress</b>, and on the sofa when marked <b>Arrived</b>.
            </div>
          )}

          <div style={{ borderRadius: 16, border: "1px solid #ece9f5", padding: 14, background: "#fff" }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Waiting ({waiting.length})</div>
            {waiting.length === 0 && <div style={{ fontSize: 12, color: "#9898b0" }}>No one waiting</div>}
            {waiting.map((w) => (
              <div key={w.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "5px 0" }}>
                <span style={{ color: "#1a1a2e", fontWeight: 600 }}>{w.clientName}</span><span style={{ color: "#6b6b8a" }}>{time12(w.startTime)} · {w.staffName.split(" ")[0]}</span>
              </div>
            ))}
            <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a2e", margin: "12px 0 8px" }}>Coming up ({upcoming.length})</div>
            {upcoming.length === 0 && <div style={{ fontSize: 12, color: "#9898b0" }}>Nothing else booked today</div>}
            {upcoming.slice(0, 6).map((u) => (
              <div key={u.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "5px 0" }}>
                <span style={{ color: "#1a1a2e", fontWeight: 600 }}>{u.clientName}</span><span style={{ color: "#6b6b8a" }}>{time12(u.startTime)} · {u.staffName.split(" ")[0]}</span>
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
