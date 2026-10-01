"use client";

import { appointmentHasStaff } from "@/lib/appointment-staff";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getStoredAppointments, getStoredClients, getStoredStaff } from "@/lib/storage";
import { getSalonInvoices, revenueAmount } from "@/lib/salon-invoices";
import type { AppointmentStatus, Appointment, Client, Staff } from "@/lib/types";
import type { SalonInvoice } from "@/lib/salon-invoices";
import DashboardHeader from "@/components/dashboard-header";
import MobilePageHeader from "@/components/mobile-page-header";
import { MoreHorizontal, TrendingUp, Calendar, Users, Award, Clock, ArrowUpRight, Tag, Star } from "lucide-react";
import { fmtCurrency as fmt } from "@/lib/format";
import { syncFromDB } from "@/lib/turso-sync";
import { getActiveSection, inSection } from "@/lib/sections";

function fmtTime(t: string) {
  const [hourValue, minuteValue] = t.split(":").map(Number);
  if (!Number.isFinite(hourValue) || !Number.isFinite(minuteValue)) return t;
  const period = hourValue < 12 ? "AM" : "PM";
  const hour = hourValue % 12 || 12;
  return `${hour}:${String(minuteValue).padStart(2, "0")} ${period}`;
}

const STATUS_CONFIG: Record<AppointmentStatus, { label: string; color: string; bg: string }> = {
  booked:        { label: "Booked",      color: "#6366f1", bg: "#EEF2FF" },
  confirmed:     { label: "Confirmed",   color: "#059669", bg: "#ecfdf5" },
  arrived:       { label: "Arrived",     color: "#9333EA", bg: "#F5F3FF" },
  "in-progress": { label: "In Progress", color: "#d97706", bg: "#fffbeb" },
  completed:     { label: "Completed",   color: "#16a34a", bg: "#f0fdf4" },
  "no-show":     { label: "No Show",     color: "#dc2626", bg: "#fef2f2" },
  cancelled:     { label: "Cancelled",   color: "#6b7280", bg: "#f9fafb" },
};

function Avatar({ name, color = "#9333EA", bg = "#F5F3FF" }: { name: string; color?: string; bg?: string }) {
  return (
    <div style={{
      width: 36,
      height: 36,
      borderRadius: "50%",
      background: bg,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 13,
      fontWeight: 700,
      color,
      flexShrink: 0,
      border: "1.5px solid rgba(255,255,255,0.8)",
      boxShadow: "0 2px 6px rgba(0,0,0,0.05)"
    }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function Card({ title, subtitle, icon: Icon, children }: { title: string; subtitle: string; icon?: React.ComponentType<{ size: number; color?: string }>; children: React.ReactNode }) {
  return (
    <div style={{
      background: "#fff",
      borderRadius: 18,
      border: "1px solid rgba(226,223,235,.95)",
      boxShadow: "0 8px 28px rgba(38,25,75,.04)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      transition: "transform .2s ease, box-shadow .2s ease",
    }}>
      <div style={{ padding: "20px 20px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #f8f8fc" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {Icon && (
            <div style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: "rgba(124, 58, 237, 0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent)"
            }}>
              <Icon size={16} />
            </div>
          )}
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: "#1a1a2e", letterSpacing: "-0.01em" }}>{title}</div>
            <div style={{ fontSize: 11, color: "#a0a0b8", marginTop: 2, fontWeight: 500 }}>{subtitle}</div>
          </div>
        </div>
        <button style={{ background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }} className="hover-bg-light">
          <MoreHorizontal size={18} color="#c0c0d0" />
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [posInvoices, setPosInvoices] = useState<SalonInvoice[]>([]);
  const [posInvoiceAppointmentIds, setPosInvoiceAppointmentIds] = useState<string[]>([]);
  const [today] = useState(() => new Date().toLocaleDateString("en-CA"));

  useEffect(() => {
    let cancelled = false;
    syncFromDB().finally(() => {
      if (cancelled) return;
      setAppointments(getStoredAppointments());
      setClients(getStoredClients());
      setStaffList(getStoredStaff());
      // Revenue is only recognized once an invoice is actually paid. Keep every
      // POS-linked appointment id separately, including unpaid invoices, so
      // unpaid/credit invoices do not leak in through completed appointments.
      const allPosInvoices = getSalonInvoices().filter(inv => !inv.source || inv.source === "pos");
      setPosInvoiceAppointmentIds(allPosInvoices.map(inv => inv.appointmentId).filter((id): id is string => !!id));
      // "partial" joins "paid" here: an advance is money actually collected, so
      // it belongs in revenue — but only the advance itself, which is what
      // revenueAmount() returns for that status.
      setPosInvoices(allPosInvoices.filter(inv => inv.status === "paid" || inv.status === "partial"));
    });
    return () => { cancelled = true; };
  }, []);

  const todayAppts = appointments.filter((a) => a.date === today);
  // Everything on this page, including the revenue figures, is scoped to the
  // active dashboard section: only "All Sections" sees everything combined —
  // Men's and Women's are each restricted to their own data, symmetrically.
  // Matches the Revenue and Cash Flow pages' identical rule.
  const activeSection = getActiveSection();
  const todayApptsScoped = todayAppts.filter((a) => inSection(a, activeSection));
  const staffListScoped = staffList.filter((s) => inSection(s, activeSection));
  const clientsScoped = clients.filter((c) => inSection(c, activeSection));

  const revenueScoped = activeSection !== "all";
  const appointmentsForRevenue = revenueScoped ? appointments.filter((a) => a.section === activeSection) : appointments;
  const posInvoicesForRevenue = revenueScoped ? posInvoices.filter((inv) => inv.section === activeSection) : posInvoices;
  const todayApptsForRevenue = revenueScoped ? todayAppts.filter((a) => a.section === activeSection) : todayAppts;

  const posLinkedAppointmentIds = useMemo(() =>
    new Set(posInvoiceAppointmentIds),
    [posInvoiceAppointmentIds]);
  const revenueLast7Days = useMemo(() => {
    const totals = new Map<string, number>();
    appointmentsForRevenue.forEach((appointment) => {
      if (appointment.status === "completed" && !posLinkedAppointmentIds.has(appointment.id)) {
        totals.set(appointment.date, (totals.get(appointment.date) ?? 0) + appointment.totalAmount);
      }
    });
    posInvoicesForRevenue.forEach((invoice) => {
      // A credit invoice paid off later counts toward the day it was actually
      // paid, not the day it was originally issued.
      const revenueDate = invoice.paidDate || invoice.date;
      totals.set(revenueDate, (totals.get(revenueDate) ?? 0) + revenueAmount(invoice));
    });

    const endDate = new Date(`${today}T12:00:00`);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(endDate);
      date.setDate(endDate.getDate() - (6 - index));
      const dateKey = date.toLocaleDateString("en-CA");
      return { date: dateKey, total: totals.get(dateKey) ?? 0 };
    });
  }, [appointmentsForRevenue, posLinkedAppointmentIds, posInvoicesForRevenue, today]);

  const maxRevenue = Math.max(...revenueLast7Days.map((day) => day.total), 0);
  const axisMax = maxRevenue > 0 ? Math.ceil((maxRevenue * 1.2) / 1000) * 1000 : 60000;
  const yAxisLabels = [axisMax, axisMax * 0.75, axisMax * 0.5, axisMax * 0.25, 0]
    .map((value) => value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(Math.round(value)));
  const topClients = [...clientsScoped].sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 5);
  const todayCompletedAppts = todayApptsForRevenue.filter((appointment) => appointment.status === "completed" && !posLinkedAppointmentIds.has(appointment.id));
  const todayPosInvoices = posInvoicesForRevenue.filter((invoice) => (invoice.paidDate || invoice.date) === today);
  const todayTotal = todayCompletedAppts.reduce((s, a) => s + a.totalAmount, 0) + todayPosInvoices.reduce((s, invoice) => s + revenueAmount(invoice), 0);
  const todayTransactionCount = todayCompletedAppts.length + todayPosInvoices.length;
  const avgTicket = todayTransactionCount > 0 ? todayTotal / todayTransactionCount : 0;
  const activeStaffCount = staffListScoped.length;
  const scopedTodayTotal = todayApptsScoped.reduce((s, a) => s + a.totalAmount, 0);

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Header */}
      <DashboardHeader />
      <MobilePageHeader title="Dashboard" subtitle="Salon Overview" />

      {/* Stats Row */}
      <div className="stats-grid-4 dash-stats" style={{ marginBottom: 4 }}>
        {/* Stat 1: Today's Revenue */}
        <div style={{
          background: "#fff",
          borderRadius: 18,
          border: "1px solid rgba(226,223,235,.95)",
          boxShadow: "0 8px 28px rgba(38,25,75,.04)",
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "relative",
          overflow: "hidden"
        }}>
          <div style={{
            position: "absolute",
            bottom: -10,
            right: -10,
            opacity: 0.04,
            color: "var(--accent)"
          }}>
            <TrendingUp size={80} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#a0a0b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Today's Revenue</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#1a1a2e", marginTop: 6 }}>{fmt(todayTotal)}</div>
            <div style={{ fontSize: 11, color: "#059669", fontWeight: 600, display: "flex", alignItems: "center", gap: 3, marginTop: 4 }}>
              <ArrowUpRight size={12} />
              <span>{revenueScoped ? `${activeSection} only` : "Gross earnings · combined"}</span>
            </div>
          </div>
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: "rgba(124, 58, 237, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--accent)"
          }}>
            <TrendingUp size={20} />
          </div>
        </div>

        {/* Stat 2: Today's Bookings */}
        <div style={{
          background: "#fff",
          borderRadius: 18,
          border: "1px solid rgba(226,223,235,.95)",
          boxShadow: "0 8px 28px rgba(38,25,75,.04)",
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "relative",
          overflow: "hidden"
        }}>
          <div style={{
            position: "absolute",
            bottom: -10,
            right: -10,
            opacity: 0.04,
            color: "#3b82f6"
          }}>
            <Calendar size={80} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#a0a0b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Today's Bookings</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#1a1a2e", marginTop: 6 }}>{todayApptsScoped.length}</div>
            <div style={{ fontSize: 11, color: "#6b6b8a", fontWeight: 600, marginTop: 4 }}>
              {todayApptsScoped.filter(a => a.status === 'completed').length} completed today
            </div>
          </div>
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: "rgba(59, 130, 246, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#3b82f6"
          }}>
            <Calendar size={20} />
          </div>
        </div>

        {/* Stat 3: Active Stylists */}
        <div style={{
          background: "#fff",
          borderRadius: 18,
          border: "1px solid rgba(226,223,235,.95)",
          boxShadow: "0 8px 28px rgba(38,25,75,.04)",
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "relative",
          overflow: "hidden"
        }}>
          <div style={{
            position: "absolute",
            bottom: -10,
            right: -10,
            opacity: 0.04,
            color: "#059669"
          }}>
            <Users size={80} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#a0a0b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Stylists Today</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#1a1a2e", marginTop: 6 }}>{activeStaffCount}</div>
            <div style={{ fontSize: 11, color: "#059669", fontWeight: 600, marginTop: 4 }}>
              All systems active
            </div>
          </div>
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: "rgba(5, 150, 105, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#059669"
          }}>
            <Users size={20} />
          </div>
        </div>

        {/* Stat 4: Average Ticket */}
        <div style={{
          background: "#fff",
          borderRadius: 18,
          border: "1px solid rgba(226,223,235,.95)",
          boxShadow: "0 8px 28px rgba(38,25,75,.04)",
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "relative",
          overflow: "hidden"
        }}>
          <div style={{
            position: "absolute",
            bottom: -10,
            right: -10,
            opacity: 0.04,
            color: "#f59e0b"
          }}>
            <Tag size={80} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#a0a0b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Average Ticket</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#1a1a2e", marginTop: 6 }}>{fmt(avgTicket)}</div>
            <div style={{ fontSize: 11, color: "#6b6b8a", fontWeight: 600, marginTop: 4 }}>
              Per appointment today
            </div>
          </div>
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: "rgba(245, 158, 11, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#f59e0b"
          }}>
            <Tag size={20} />
          </div>
        </div>
      </div>

      {/* Top 3 cards */}
      <div className="dash-grid-3">

        {/* Card 1: Today Appointments */}
        <Card title="Today's Appointments" subtitle={`${todayApptsScoped.length} scheduled`} icon={Calendar}>
          {todayApptsScoped.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#a0a0b8", fontSize: 12 }}>
              No appointments scheduled for today.
            </div>
          ) : (
            todayApptsScoped.slice(0, 5).map((appt) => {
              const cfg = STATUS_CONFIG[appt.status] || { color: "#6b7280", bg: "#f9fafb", label: appt.status };
              return (
                <div
                  key={appt.id}
                  onClick={() => router.push(`/dashboard/appointments?id=${appt.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") router.push(`/dashboard/appointments?id=${appt.id}`); }}
                  style={{
                    padding: "12px 20px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    borderBottom: "1px solid #f8f8fc",
                    transition: "background 0.2s",
                    cursor: "pointer",
                  }} className="hover-bg-row">
                  <Avatar name={appt.clientName} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: "#1a1a2e" }}>{appt.clientName}</span>
                      <span style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: cfg.color
                      }} title={cfg.label} />
                    </div>
                    <div style={{ fontSize: 11, color: "#6b6b8a", marginTop: 2, fontWeight: 500 }}>{appt.serviceNames.join(", ")}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 800,
                      color: "var(--accent)",
                      background: "rgba(124, 58, 237, 0.05)",
                      padding: "3px 8px",
                      borderRadius: 6,
                      fontFamily: "monospace"
                    }}>
                      {fmtTime(appt.startTime)}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#9898b0" }}>
                      {fmt(appt.totalAmount)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </Card>

        {/* Card 2: Staff Status */}
        <Card title="Staff Status" subtitle="Active stylists today" icon={Users}>
          {staffListScoped.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#a0a0b8", fontSize: 12 }}>
              No staff members registered.
            </div>
          ) : (
            staffListScoped.map((s) => {
              const staffTodayAppts = todayApptsScoped.filter((a) => appointmentHasStaff(a, s.id));
              const busy = staffTodayAppts.some((a) => a.status === "in-progress" || a.status === "arrived");
              return (
                <div
                  key={s.id}
                  onClick={() => router.push(`/dashboard/staff/${s.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") router.push(`/dashboard/staff/${s.id}`); }}
                  style={{
                    padding: "12px 20px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    borderBottom: "1px solid #f8f8fc",
                    transition: "background 0.2s",
                    cursor: "pointer",
                  }} className="hover-bg-row">
                  <Avatar name={s.name} color={s.color} bg={s.color + "15"} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#1a1a2e" }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: "#6b6b8a", marginTop: 2, textTransform: "capitalize", fontWeight: 500 }}>
                      {s.role.replace(/-/g, " ")} · <span style={{ color: "#9898b0" }}>{staffTodayAppts.length} {staffTodayAppts.length === 1 ? "booking" : "bookings"}</span>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 10,
                    fontWeight: 800,
                    color: busy ? "#d97706" : "#059669",
                    background: busy ? "#fffbeb" : "#ecfdf5",
                    padding: "4px 10px",
                    borderRadius: 20,
                    display: "flex",
                    alignItems: "center",
                    gap: 5
                  }}>
                    <span style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: busy ? "#d97706" : "#059669",
                      animation: busy ? "none" : "pulse 1.8s infinite"
                    }} />
                    {busy ? "Busy" : "Active"}
                  </span>
                </div>
              );
            })
          )}
        </Card>

        {/* Card 3: Top Clients */}
        <Card title="Top Clients" subtitle="By lifetime spend" icon={Star}>
          {topClients.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#a0a0b8", fontSize: 12 }}>
              No client history yet.
            </div>
          ) : (
            (() => {
              const maxSpend = topClients[0]?.totalSpend || 1;
              return topClients.map((client) => {
                const pct = (client.totalSpend / maxSpend) * 100;
                const tag = client.tags[0] || "Client";
                return (
                  <div
                    key={client.id}
                    onClick={() => router.push(`/dashboard/clients/${client.id}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") router.push(`/dashboard/clients/${client.id}`); }}
                    style={{
                      padding: "14px 20px",
                      borderBottom: "1px solid #f8f8fc",
                      transition: "background 0.2s",
                      cursor: "pointer",
                    }} className="hover-bg-row">
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <Avatar name={client.name} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 700, fontSize: 13, color: "#1a1a2e" }}>{client.name}</span>
                          <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)" }}>{fmt(client.totalSpend)}</span>
                        </div>
                        {/* Progress bar and tag */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                          <div style={{ flex: 1, height: 4, background: "#f0f0f5", borderRadius: 2 }}>
                            <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent-gradient)", borderRadius: 2 }} />
                          </div>
                          <span style={{
                            fontSize: 9,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            color: tag.toLowerCase() === "vip" ? "#db2777" : "#6b7280",
                            background: tag.toLowerCase() === "vip" ? "#fdf2f8" : "#f3f4f6",
                            padding: "2px 6px",
                            borderRadius: 4,
                            letterSpacing: "0.05em"
                          }}>
                            {tag}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              });
            })()
          )}
        </Card>
      </div>

      {/* Bottom 2 cards */}
      <div className="dash-grid-bottom">

        {/* Revenue Bar Chart */}
        <div style={{
          background: "#fff",
          borderRadius: 18,
          border: "1px solid rgba(226,223,235,.95)",
          boxShadow: "0 8px 28px rgba(38,25,75,.04)",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          flex: 1
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  background: "rgba(124, 58, 237, 0.06)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)"
                }}>
                  <TrendingUp size={16} />
                </div>
                <span style={{ fontWeight: 800, fontSize: 15, color: "#1a1a2e", letterSpacing: "-0.01em" }}>Revenue Trend</span>
              </div>
              <div style={{ fontSize: 11, color: "#a0a0b8", marginTop: 4, fontWeight: 500, paddingLeft: 40 }}>Last 7 days of performance</div>
            </div>
            
            {/* Weekly Total Badge */}
            {(() => {
              const weeklyTotal = revenueLast7Days.reduce((s, d) => s + d.total, 0);
              return (
                <div style={{
                  background: "var(--accent-gradient)",
                  padding: "6px 14px",
                  borderRadius: 10,
                  color: "#fff",
                  boxShadow: "0 4px 12px var(--accent-glow)",
                  textAlign: "right"
                }}>
                  <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", opacity: 0.8, letterSpacing: "0.05em" }}>Weekly Total</div>
                  <div style={{ fontSize: 13, fontWeight: 900, marginTop: 1 }}>{fmt(weeklyTotal)}</div>
                </div>
              );
            })()}
          </div>
          
          {/* Chart body */}
          <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 200 }}>
            {/* Y-axis labels */}
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", paddingBottom: 30, height: 180 }}>
              {yAxisLabels.map((l) => (
                <div key={l} style={{ fontSize: 10, color: "#b0b0c8", fontWeight: 600, textAlign: "right", width: 28 }}>{l}</div>
              ))}
            </div>
            
            {/* Bars + x-axis */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              {/* Grid + bars */}
              <div style={{ height: 180, position: "relative", width: "100%" }}>
                {/* Horizontal grid lines */}
                {[0, 25, 50, 75, 100].map((pct) => (
                  <div key={pct} style={{ position: "absolute", bottom: `${pct}%`, left: 0, right: 0, height: 1, borderBottom: "1px dashed #eef0f5" }} />
                ))}
                {/* Bars */}
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: 12, padding: "0 4px" }}>
                  {revenueLast7Days.map((day) => {
                    const pct = maxRevenue > 0 ? (day.total / axisMax) * 100 : 0;
                    const isToday = day.date === today;
                    return (
                      <div
                        key={day.date}
                        title={`${day.date}: ${fmt(day.total)}`}
                        style={{
                          flex: 1,
                          height: `${pct}%`,
                          minHeight: day.total > 0 ? 4 : 0,
                          background: isToday ? "var(--accent-gradient)" : "linear-gradient(to top, #c4b5fd, #ddd6fe)",
                          borderRadius: "8px 8px 0 0",
                          position: "relative",
                          cursor: "pointer",
                          boxShadow: isToday ? "0 4px 12px var(--accent-glow)" : "none",
                        }}
                        className="chart-bar"
                      >
                        {/* Tooltip on hover */}
                        <div className="chart-tooltip" style={{
                          position: "absolute",
                          top: -35,
                          left: "50%",
                          transform: "translateX(-50%)",
                          background: "#1a1a2e",
                          color: "#fff",
                          padding: "4px 8px",
                          borderRadius: 6,
                          fontSize: 10,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          pointerEvents: "none",
                          opacity: 0,
                          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                          transition: "opacity 0.15s, transform 0.15s"
                        }}>
                          {fmt(day.total)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {maxRevenue === 0 && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#a0a0b8", fontSize: 12, textAlign: "center", padding: 20 }}>
                    Complete an appointment to see revenue here.
                  </div>
                )}
              </div>
              
              {/* X-axis labels */}
              <div style={{ display: "flex", gap: 12, paddingTop: 12 }}>
                {revenueLast7Days.map((day) => {
                  const isToday = day.date === today;
                  const label = new Date(day.date).toLocaleDateString("en-PK", { weekday: "short" });
                  return (
                    <div key={day.date} style={{ flex: 1, textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: isToday ? "var(--accent)" : "#9898b0", fontWeight: isToday ? 800 : 600 }}>{label}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Services Table */}
        <div style={{
          background: "#fff",
          borderRadius: 18,
          border: "1px solid rgba(226,223,235,.95)",
          boxShadow: "0 8px 28px rgba(38,25,75,.04)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column"
        }}>
          <div style={{ padding: "20px 20px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #f8f8fc" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                background: "rgba(124, 58, 237, 0.06)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--accent)"
              }}>
                <Award size={16} />
              </div>
              <span style={{ fontWeight: 800, fontSize: 15, color: "#1a1a2e", letterSpacing: "-0.01em" }}>Today's Services</span>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", background: "#f4f4f9", padding: "4px 10px", borderRadius: 20 }}>
              {todayApptsScoped.length} total
            </span>
          </div>
          
          {/* Table header — desktop grid only, replaced by a stacked list on mobile */}
          <div className="desktop-only" style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 0.8fr 1fr 1fr",
            padding: "10px 20px",
            background: "#faf9fd",
            borderBottom: "1px solid #f0f0f5"
          }}>
            {["SERVICE", "STAFF", "STATUS", "AMOUNT"].map((h) => (
              <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>

          {/* Rows */}
          <div style={{ flex: 1, overflowY: "auto", maxHeight: 260 }}>
            {todayApptsScoped.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "#a0a0b8", fontSize: 12 }}>
                No services logged for today.
              </div>
            ) : (
              todayApptsScoped.map((appt) => {
                const cfg = STATUS_CONFIG[appt.status] || { color: "#6b7280", bg: "#f9fafb", label: appt.status };
                return (
                  <div key={appt.id}>
                    {/* Desktop: 4-column grid row */}
                    <div className="desktop-only hover-bg-row" style={{
                      display: "grid",
                      gridTemplateColumns: "1.2fr 0.8fr 1fr 1fr",
                      padding: "14px 20px",
                      borderBottom: "1px solid #f8f8fc",
                      alignItems: "center",
                      transition: "background 0.2s"
                    }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>{appt.serviceNames[0]}</div>
                        <div style={{ fontSize: 11, color: "#9898b0", marginTop: 3, display: "flex", alignItems: "center", gap: 4, fontWeight: 500 }}>
                          <Clock size={10} />
                          <span>{fmtTime(appt.startTime)}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: "#4a4a6a", fontWeight: 600 }}>{appt.staffName.split(" ")[0]}</div>
                      <div>
                        <span style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 10,
                          fontWeight: 800,
                          color: cfg.color,
                          background: cfg.bg,
                          padding: "3px 8px",
                          borderRadius: 20,
                          whiteSpace: "nowrap"
                        }}>
                          <span style={{ width: 4, height: 4, borderRadius: "50%", background: cfg.color }} />
                          {cfg.label}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)" }}>{fmt(appt.totalAmount)}</div>
                    </div>

                    {/* Mobile: stacked row, matching the "Today's Appointments" card pattern above */}
                    <div className="mobile-only mobile-only-flex" style={{ alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid #f8f8fc" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{appt.serviceNames[0]}</div>
                        <div style={{ fontSize: 11, color: "#9898b0", marginTop: 3, display: "flex", alignItems: "center", gap: 4, fontWeight: 500 }}>
                          <Clock size={10} />
                          <span>{fmtTime(appt.startTime)}</span>
                          <span>· {appt.staffName.split(" ")[0]}</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                        <span style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 9,
                          fontWeight: 800,
                          color: cfg.color,
                          background: cfg.bg,
                          padding: "3px 7px",
                          borderRadius: 20,
                          whiteSpace: "nowrap"
                        }}>
                          <span style={{ width: 4, height: 4, borderRadius: "50%", background: cfg.color }} />
                          {cfg.label}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)" }}>{fmt(appt.totalAmount)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          
          {/* Footer total — sum of the rows actually shown above (scoped to the
              active section), not the combined business-wide total; that
              figure lives in the "Today's Revenue" stat card instead. */}
          {todayApptsScoped.length > 0 && (
            <div style={{
              padding: "16px 20px",
              borderTop: "1px solid #eef0f5",
              background: "#faf9fd",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center"
            }}>
              <span style={{ fontSize: 12, fontWeight: 750, color: "#6b6b8a" }}>{activeSection === "all" ? "Total Revenue" : `${activeSection} Total`}</span>
              <span style={{ fontSize: 16, fontWeight: 900, color: "var(--accent)" }}>{fmt(scopedTodayTotal)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
