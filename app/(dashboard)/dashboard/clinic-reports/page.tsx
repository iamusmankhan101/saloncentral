"use client";

/**
 * Clinic owner's dashboard: today at a glance, then a month's money, patients,
 * revenue by type and practitioner performance. Everything is counted from the
 * same invoices, appointments and clients the rest of the app uses — revenue
 * through revenueAmount() so totals agree with the Revenue page.
 */

import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import PageTitle from "@/components/page-title";
import { getStoredAppointments, getStoredClients, getStoredStaff, getStoredServices, subscribeToStoredData } from "@/lib/storage";
import { getSalonInvoices, revenueAmount, balanceDue, type SalonInvoice } from "@/lib/salon-invoices";
import { getExpenses, type Expense } from "@/lib/expenses";
import { revenueInPeriod, invoiceBelongsTo } from "@/lib/payouts";
import { appointmentHasStaff } from "@/lib/appointment-staff";
import { getLeads, todayKey, type Lead } from "@/lib/clinic";
import { fmtCurrency as fmt } from "@/lib/format";
import type { Appointment, Client, Service, Staff } from "@/lib/types";

interface Data { appts: Appointment[]; invoices: SalonInvoice[]; clients: Client[]; staff: Staff[]; services: Service[]; expenses: Expense[]; leads: Lead[] }

const monthEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).toLocaleDateString("en-CA"); };
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Tile({ label, value, sub, color = "#7C3AED" }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div style={{ flex: "1 1 160px", padding: "14px 16px", borderRadius: 14, border: "1px solid #ececf4", background: "#fff" }}>
      <div style={{ fontSize: 22, fontWeight: 900, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 5 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#8a8aa3", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function ClinicReportsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));

  useEffect(() => {
    const load = () => setData({
      appts: getStoredAppointments(), invoices: getSalonInvoices(), clients: getStoredClients(), staff: getStoredStaff(),
      services: getStoredServices(), expenses: getExpenses(), leads: getLeads(),
    });
    load();
    return subscribeToStoredData(load);
  }, []);

  const r = useMemo(() => {
    if (!data) return null;
    const today = todayKey();
    const from = `${month}-01`;
    const to = monthEnd(month);
    const inMonth = (d?: string) => !!d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
    const live = (a: Appointment) => a.status !== "cancelled";

    const todayInv = data.invoices.filter((i) => i.date === today);
    const todayAppts = data.appts.filter((a) => a.date === today);
    const todayStats = {
      appointments: todayAppts.filter(live).length,
      revenue: todayInv.reduce((s, i) => s + revenueAmount(i), 0),
      newPatients: data.clients.filter((c) => c.createdAt?.slice(0, 10) === today).length,
      packages: todayInv.reduce((n, i) => n + i.items.filter((l) => l.packagePurchase).reduce((q, l) => q + Math.max(1, l.qty), 0), 0),
      pending: data.invoices.reduce((s, i) => s + (i.status === "unpaid" ? i.total : balanceDue(i)), 0),
      noShows: todayAppts.filter((a) => a.status === "no-show").length,
    };

    const inv = data.invoices.filter((i) => inMonth(i.date));
    const revenue = inv.reduce((s, i) => s + revenueAmount(i), 0);
    const expenses = data.expenses.filter((e) => inMonth(e.date)).reduce((s, e) => s + (e.amount || 0), 0);
    const byType = { treatments: 0, packages: 0, memberships: 0, products: 0 };
    for (const i of inv) for (const l of i.items) {
      if (l.packagePurchase) byType.packages += l.total;
      else if (l.membershipPurchase) byType.memberships += l.total;
      else if (l.type === "product") byType.products += l.total;
      else byType.treatments += l.total;
    }

    // Patients seen this month: anyone billed or with a completed appointment.
    const seen = new Set<string>([
      ...inv.map((i) => i.clientId).filter((x): x is string => !!x),
      ...data.appts.filter((a) => a.status === "completed" && inMonth(a.date)).map((a) => a.clientId),
    ]);
    const newIds = new Set(data.clients.filter((c) => inMonth(c.createdAt)).map((c) => c.id));
    const returning = [...seen].filter((id) => !newIds.has(id)).length;
    const payers = new Set(inv.filter((i) => i.clientId && revenueAmount(i) > 0).map((i) => i.clientId!));

    const monthAppts = data.appts.filter((a) => inMonth(a.date));
    const doctors = data.staff.filter((s) => s.isActive).map((s) => {
      const mine = monthAppts.filter((a) => appointmentHasStaff(a, s.id));
      const closed = mine.filter((a) => ["completed", "no-show", "cancelled"].includes(a.status));
      const packages = inv.filter((i) => invoiceBelongsTo(i, s)).reduce((n, i) => n + i.items.filter((l) => l.packagePurchase).reduce((q, l) => q + Math.max(1, l.qty), 0), 0);
      return {
        staff: s, appointments: mine.filter(live).length, completion: pct(mine.filter((a) => a.status === "completed").length, closed.length),
        revenue: revenueInPeriod(s, data.appts, data.services, from, to, data.invoices), packages,
      };
    }).filter((d) => d.appointments > 0 || d.revenue > 0 || d.packages > 0).sort((a, b) => b.revenue - a.revenue);

    const monthLeads = data.leads.filter((l) => inMonth(l.createdAt));
    return {
      todayStats, revenue, expenses, profit: revenue - expenses, byType, newPatients: newIds.size, returning,
      returningRate: pct(returning, seen.size), avgValue: payers.size ? revenue / payers.size : 0,
      noShowRate: pct(monthAppts.filter((a) => a.status === "no-show").length, monthAppts.filter(live).length),
      leads: monthLeads.length, converted: monthLeads.filter((l) => l.clientId).length, doctors,
    };
  }, [data, month]);

  if (!r) return null;
  const t = r.todayStats;

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#f7f7fb", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 22 }}>
      <PageTitle icon={<BarChart3 size={24} />} title="Clinic Reports" subtitle="Today at a glance, and how the month is going." />

      <section>
        <div style={{ fontSize: 14, fontWeight: 900, color: "#1a1a2e", marginBottom: 10 }}>Today</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Tile label="Appointments" value={t.appointments} />
          <Tile label="Revenue" value={fmt(t.revenue)} color="#059669" />
          <Tile label="New patients" value={t.newPatients} color="#0284c7" />
          <Tile label="Packages sold" value={t.packages} color="#b45309" />
          <Tile label="Pending payments" value={fmt(t.pending)} sub="All unpaid bills and balances" color="#dc2626" />
          <Tile label="No-shows" value={t.noShows} color="#6b7280" />
        </div>
      </section>

      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: "#1a1a2e", flex: 1 }}>Month</div>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
            style={{ padding: "8px 10px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13 }} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <Tile label="Revenue" value={fmt(r.revenue)} color="#059669" />
          <Tile label="Expenses" value={fmt(r.expenses)} color="#dc2626" />
          <Tile label="Profit" value={fmt(r.profit)} color={r.profit >= 0 ? "#059669" : "#dc2626"} />
          <Tile label="Avg patient value" value={fmt(r.avgValue)} sub="Revenue ÷ paying patients" />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <Tile label="New patients" value={r.newPatients} color="#0284c7" />
          <Tile label="Returning patients" value={r.returning} sub={`${r.returningRate} of patients seen`} color="#0284c7" />
          <Tile label="No-show rate" value={r.noShowRate} color="#6b7280" />
          <Tile label="Leads → patients" value={`${r.converted} / ${r.leads}`} sub={pct(r.converted, r.leads) + " converted"} color="#b45309" />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Tile label="Treatment revenue" value={fmt(r.byType.treatments)} />
          <Tile label="Package revenue" value={fmt(r.byType.packages)} />
          <Tile label="Membership revenue" value={fmt(r.byType.memberships)} />
          <Tile label="Product sales" value={fmt(r.byType.products)} />
        </div>
        <div style={{ fontSize: 11, color: "#9898b0", marginTop: 6 }}>Revenue by type is from bill lines before bill-level discounts.</div>
      </section>

      <section>
        <div style={{ fontSize: 14, fontWeight: 900, color: "#1a1a2e", marginBottom: 10 }}>Practitioner performance</div>
        {r.doctors.length === 0 ? <div style={{ fontSize: 13, color: "#9898b0" }}>No activity this month.</div> : (
          <div style={{ overflowX: "auto", background: "#fff", border: "1px solid #ececf4", borderRadius: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#9898b0", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {["Practitioner", "Appointments", "Completion", "Revenue", "Packages sold"].map((h) => <th key={h} style={{ padding: "10px 12px", borderBottom: "1px solid #ececf4" }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {r.doctors.map((d) => (
                  <tr key={d.staff.id}>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #f4f4f8", fontWeight: 800 }}>{d.staff.name}</td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #f4f4f8" }}>{d.appointments}</td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #f4f4f8" }}>{d.completion}</td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #f4f4f8", fontWeight: 800, color: "#059669" }}>{fmt(d.revenue)}</td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #f4f4f8" }}>{d.packages}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
