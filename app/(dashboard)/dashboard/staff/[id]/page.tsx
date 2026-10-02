"use client";

import { appointmentHasStaff } from "@/lib/appointment-staff";
import { useEffect, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Phone, Edit2, TrendingUp, Users, Calendar,
  CheckCircle2, XCircle, Scissors, Star, Award, Clock,
  BarChart2, ChevronRight, Briefcase,
} from "lucide-react";
import { getStoredStaff, getStoredAppointments, getStoredServices, saveStaff, saveServices } from "@/lib/storage";
import type { Staff, Appointment, Service, StaffPayType } from "@/lib/types";
import { fmtCurrency as fmt } from "@/lib/format";
import { Check, X, Plus, FileDown } from "lucide-react";
import { exportStaffPdf } from "@/lib/export-pdf";
import { settingsStore } from "@/lib/settings-store";
import { getActiveSection, inSection } from "@/lib/sections";
import { weeklyOffDaysFor } from "@/lib/attendance";
import { revenueInPeriod, invoiceBelongsTo, ALL_TIME_START, ALL_TIME_END } from "@/lib/payouts";
import { upsellInPeriod, upsellIncentive } from "@/lib/upsell";
import { getSalonInvoices, type SalonInvoice } from "@/lib/salon-invoices";

/** Sentinel select value that reveals the free-text role field — never stored. */
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CUSTOM_ROLE = "__custom__";

const ROLE_COLORS: Record<string, { color: string; bg: string }> = {
  owner:            { color: "#7C3AED", bg: "#EDE9FE" },
  manager:          { color: "#0369a1", bg: "#e0f2fe" },
  "senior-stylist": { color: "#059669", bg: "#ecfdf5" },
  "junior-stylist": { color: "#d97706", bg: "#fffbeb" },
  receptionist:     { color: "#db2777", bg: "#fdf2f8" },
  trainee:          { color: "#6b7280", bg: "#f9fafb" },
  hair:             { color: "#0369a1", bg: "#e0f2fe" },
  aesthetic:        { color: "#be185d", bg: "#fdf2f8" },
};
const PRESET_ROLES = Object.keys(ROLE_COLORS);

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  completed:    { label: "Completed",   color: "#059669", bg: "#ecfdf5" },
  "no-show":    { label: "No-show",     color: "#dc2626", bg: "#fef2f2" },
  cancelled:    { label: "Cancelled",   color: "#9ca3af", bg: "#f9fafb" },
  booked:       { label: "Booked",      color: "#7C3AED", bg: "#EDE9FE" },
  confirmed:    { label: "Confirmed",   color: "#0284c7", bg: "#e0f2fe" },
  arrived:      { label: "Arrived",     color: "#9333EA", bg: "#f5f3ff" },
  "in-progress":{ label: "In Progress", color: "#d97706", bg: "#fffbeb" },
};

function fmtDate(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function startOf(period: "week" | "month" | "lastMonth"): string {
  const d = new Date();
  if (period === "week") {
    const day = d.getDay();
    d.setDate(d.getDate() - day);
    return d.toISOString().slice(0, 10);
  }
  if (period === "month") {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }
  // last month
  const lm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return lm.toISOString().slice(0, 10);
}

function endOfLastMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().slice(0, 10);
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────
function EditModal({
  staff, servicesList, onClose, onSave,
}: {
  staff: Staff;
  servicesList: Service[];
  onClose: () => void;
  onSave: (s: Staff, assignedServiceIds: string[]) => void;
}) {
  const [form, setForm] = useState({
    name: staff.name,
    phone: staff.phone,
    role: PRESET_ROLES.includes(staff.role) ? (staff.role as string) : CUSTOM_ROLE,
    customRole: PRESET_ROLES.includes(staff.role) ? "" : (staff.role as string),
    payType: staff.payType ?? "commission",
    commissionRate: staff.commissionRate ? String(staff.commissionRate) : "",
    baseSalary: staff.baseSalary ? String(staff.baseSalary) : "",
    paidLeavesPerMonth: staff.paidLeavesPerMonth != null ? String(staff.paidLeavesPerMonth) : "",
    upsellCommissionRate: staff.upsellCommissionRate != null ? String(staff.upsellCommissionRate) : "",
    standardHoursPerDay: staff.standardHoursPerDay != null ? String(staff.standardHoursPerDay) : "",
  });
  // null = follow the salon roster; an array (empty included) = this person's own.
  const [offDays, setOffDays] = useState<number[] | null>(staff.weeklyOffDays ?? null);
  const usesSalonRoster = offDays === null;
  const salonOffDays = weeklyOffDaysFor(null);
  const salonOffLabel = salonOffDays.length === 0
    ? "no weekly off"
    : salonOffDays.map((d) => WEEKDAY_NAMES[d]).join(", ");
  // The first pick starts from the salon roster, so overriding a weekend means
  // adjusting two days rather than rebuilding the week from nothing.
  const toggleOffDay = (day: number) =>
    setOffDays((current) => {
      const base = current ?? salonOffDays;
      return base.includes(day) ? base.filter((d) => d !== day) : [...base, day].sort();
    });

  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>(
    servicesList.filter((s) => s.assignedStaffIds.includes(staff.id)).map((s) => s.id),
  );
  const [done, setDone] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const canSubmit = form.name && form.phone && form.role
    && (form.role !== CUSTOM_ROLE || form.customRole.trim());
  const existingCustomRoles = Array.from(new Set(getStoredStaff().map((s) => s.role)))
    .filter((r) => !!r && !PRESET_ROLES.includes(r) && r !== staff.role)
    .sort();

  const toggleService = (id: string) =>
    setSelectedServiceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const handleSave = () => {
    if (!canSubmit) return;
    const selectedServices = servicesList.filter((s) => selectedServiceIds.includes(s.id));
    const updatedStaff = {
      ...staff,
      name: form.name,
      phone: form.phone,
      role: form.role === CUSTOM_ROLE ? form.customRole.trim() : form.role,
      specialties: selectedServices.map((s) => s.name),
      payType: form.payType as StaffPayType,
      commissionRate: (form.payType === "commission" || form.payType === "both") && form.commissionRate ? Number(form.commissionRate) : undefined,
      baseSalary: (form.payType === "salary" || form.payType === "both") && form.baseSalary ? Number(form.baseSalary) : undefined,
      paidLeavesPerMonth: form.paidLeavesPerMonth !== "" && Number(form.paidLeavesPerMonth) >= 0 ? Number(form.paidLeavesPerMonth) : undefined,
      standardHoursPerDay: Number(form.standardHoursPerDay) > 0 ? Number(form.standardHoursPerDay) : undefined,
      upsellCommissionRate: form.upsellCommissionRate !== "" && Number(form.upsellCommissionRate) > 0 ? Number(form.upsellCommissionRate) : undefined,
      weeklyOffDays: offDays ?? undefined,
    };
    onSave(updatedStaff, selectedServiceIds);
    setDone(true);
  };

  const inp: React.CSSProperties = { padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", width: "100%", boxSizing: "border-box" };

  if (done) return (
    <div onClick={onClose} className="modal-overlay" style={{ zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 360, maxWidth: "100%", padding: "48px 32px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 28, color: "#059669" }}>✓</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: "#1a1a2e", marginBottom: 8 }}>Staff Updated</div>
        <button onClick={onClose} style={{ padding: "10px 32px", borderRadius: 10, background: "#7C3AED", border: "none", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );

  return (
    <div onClick={onClose} className="modal-overlay" style={{ zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 440, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "22px 24px 18px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>Edit Staff Member</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}><X size={18} color="#6b6b8a" /></button>
        </div>
        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Full Name</label>
            <input style={inp} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Phone</label>
            <input style={inp} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Role</label>
            <select style={{ ...inp, background: "#fff" }} value={form.role} onChange={(e) => set("role", e.target.value)}>
              <option value="">Select role…</option>
              {PRESET_ROLES.map((r) => <option key={r} value={r}>{r.replace(/-/g, " ")}</option>)}
              {existingCustomRoles.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value={CUSTOM_ROLE}>Custom…</option>
            </select>
          </div>
          {form.role === CUSTOM_ROLE && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Custom Role Name</label>
              <input type="text" style={inp} value={form.customRole} onChange={(e) => set("customRole", e.target.value)} placeholder="e.g. Nail Technician" />
            </div>
          )}

          <div style={{ padding: "10px 12px", borderRadius: 10, background: "#f5f3ff", color: "#6d28d9", fontSize: 12, lineHeight: 1.55, fontWeight: 650 }}>
            Staff login, password, and page permissions are managed separately in <strong>Account → Roles & Permissions</strong>.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Pay Type</label>
            <div style={{ display: "flex", gap: 6, background: "#f4f4f9", border: "1px solid #e3e0eb", borderRadius: 10, padding: 4 }}>
              {([["commission", "Commission"], ["salary", "Fixed Salary"], ["both", "Both"]] as const).map(([val, label]) => {
                const active = form.payType === val;
                return (
                  <button key={val} type="button" onClick={() => set("payType", val)}
                    style={{
                      flex: 1, padding: "8px 0", borderRadius: 8, border: "none",
                      background: active ? "#7C3AED" : "transparent",
                      color: active ? "#fff" : "#6b6b8a", fontSize: 12, fontWeight: 700, cursor: "pointer",
                      transition: "all 0.15s",
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          {(form.payType === "commission" || form.payType === "both") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Commission Rate (%)</label>
              <input type="number" min="0" max="100" style={inp} value={form.commissionRate} onChange={(e) => set("commissionRate", e.target.value)} placeholder="e.g. 30" />
            </div>
          )}
          {(form.payType === "salary" || form.payType === "both") && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Base Salary (PKR / pay period)</label>
                <input type="number" min="0" style={inp} value={form.baseSalary} onChange={(e) => set("baseSalary", e.target.value)} placeholder="e.g. 30000" />
              </div>
            </>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Upsell Incentive (%)</label>
            <input type="number" min="0" max="100" style={inp} value={form.upsellCommissionRate} onChange={(e) => set("upsellCommissionRate", e.target.value)} placeholder="e.g. 10" />
            <div style={{ fontSize: 11, color: "#b0b0c8" }}>Extra commission on services sold beyond what the client booked, paid on top of any normal commission. Leave blank for none.</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Paid Leaves / Month</label>
            <input type="number" min="0" style={inp} value={form.paidLeavesPerMonth} onChange={(e) => set("paidLeavesPerMonth", e.target.value)} placeholder="e.g. 2" />
            <div style={{ fontSize: 11, color: "#b0b0c8" }}>Leave days marked in Attendance, up to this many per pay period, are paid in full; further leaves reduce salary. Leave blank to use the salon default from Settings → Business Hours.</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Weekly Offs</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {WEEKDAY_NAMES.map((day, index) => {
                const on = (offDays ?? salonOffDays).includes(index);
                return (
                  <button key={day} type="button" onClick={() => toggleOffDay(index)}
                    style={{ padding: "6px 11px", borderRadius: 8, fontSize: 11.5, fontWeight: 750, cursor: "pointer",
                      border: `1.5px solid ${on ? "#7C3AED" : "#e8e8f0"}`, background: on ? "#F5F3FF" : "#fff",
                      color: on ? "#7C3AED" : "#9898b0" }}>
                    {day}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "#b0b0c8" }}>
              {usesSalonRoster
                ? `Following the salon roster (${salonOffLabel}). Pick days here to override it for this person.`
                : offDays!.length === 0
                  ? "No weekly off — works every day."
                  : `${offDays!.length} off day${offDays!.length === 1 ? "" : "s"} a week.`}
              {!usesSalonRoster && (
                <button type="button" onClick={() => setOffDays(null)}
                  style={{ marginLeft: 6, background: "none", border: "none", padding: 0, color: "#7C3AED", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  Use salon roster
                </button>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Standard Hours / Day</label>
            <input type="number" min="0" step="0.5" style={inp} value={form.standardHoursPerDay} onChange={(e) => set("standardHoursPerDay", e.target.value)} placeholder="e.g. 8" />
            <div style={{ fontSize: 11, color: "#b0b0c8" }}>A full working day for this person. Leave blank to use the salon standard from Settings → Business Hours.</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Assigned Services</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto", border: "1px solid #e8e8f0", borderRadius: 8, padding: 8 }}>
              {servicesList.length === 0
                ? <div style={{ fontSize: 12, color: "#9898b0", fontStyle: "italic" }}>No services added yet.</div>
                : servicesList.map((sv) => {
                  const checked = selectedServiceIds.includes(sv.id);
                  return (
                    <div key={sv.id} onClick={() => toggleService(sv.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "#f4f0fe" : "transparent" }}>
                      <div style={{ width: 16, height: 16, borderRadius: 4, border: "1px solid #7C3AED", display: "flex", alignItems: "center", justifyContent: "center", background: checked ? "#7C3AED" : "#fff", flexShrink: 0 }}>
                        {checked && <Check size={11} color="#fff" strokeWidth={3} />}
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e" }}>{sv.name} <span style={{ fontSize: 11, color: "#9898b0" }}>— {fmt(sv.price)}</span></span>
                    </div>
                  );
                })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
            <button onClick={handleSave} disabled={!canSubmit} style={{ flex: 2, padding: "11px 0", borderRadius: 10, border: "none", background: canSubmit ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 600, color: canSubmit ? "#fff" : "#b0b0c8", cursor: canSubmit ? "pointer" : "not-allowed" }}>
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────
function Section({ title, icon: Icon, children, action }: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ background: "#fff", borderRadius: 18, border: "1px solid #ebebf0", overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.04)" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #f4f4f8", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fafafd" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon size={15} color="#7C3AED" />
          <span style={{ fontSize: 13, fontWeight: 800, color: "#1d1d2f" }}>{title}</span>
        </div>
        {action}
      </div>
      <div style={{ padding: "16px 20px" }}>{children}</div>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string | number; sub?: string; icon: React.ElementType; color: string;
}) {
  return (
    <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #ebebf0", padding: "18px 20px", boxShadow: "0 1px 6px rgba(0,0,0,0.04)", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, right: 0, width: 70, height: 70, borderRadius: "0 16px 0 100%", background: color + "0d" }} />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "#9999b0", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: color + "15", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={14} color={color} />
        </div>
      </div>
      <div style={{ fontSize: 24, fontWeight: 900, color: "#1d1d2f", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#b0b0c8", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// ─── Mini bar component ───────────────────────────────────────────────────────
function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ flex: 1, height: 6, background: "#f0f0f8", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.4s ease" }} />
    </div>
  );
}

// ─── Revenue Period Row ───────────────────────────────────────────────────────
function RevRow({ label, value, pct, color }: { label: string; value: number; pct: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 88, fontSize: 12, color: "#6b6b8a", fontWeight: 600, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 8, background: "#f0f0f8", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.5s ease" }} />
      </div>
      <div style={{ width: 90, textAlign: "right", fontSize: 13, fontWeight: 700, color: "#1d1d2f", flexShrink: 0 }}>{fmt(value)}</div>
    </div>
  );
}

// ─── Main Profile Page ────────────────────────────────────────────────────────
export default function StaffProfilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [staff, setStaff]         = useState<Staff | null>(null);
  const [services, setServices]   = useState<Service[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [invoices, setInvoices] = useState<SalonInvoice[]>([]);
  const [showEdit, setShowEdit]   = useState(false);
  const [notFound, setNotFound]   = useState(false);

  useEffect(() => {
    const staffList = getStoredStaff();
    const found = staffList.find((s) => s.id === id);
    // Strict-locked, same as the Staff list — a staff member belonging to
    // another section is treated as not found rather than leaking through a
    // direct link, and their appointments/services list is scoped too.
    const activeSection = getActiveSection();
    if (!found || !inSection(found, activeSection)) { setNotFound(true); return; }
    setStaff(found);
    setServices(getStoredServices().filter(sv => inSection(sv, activeSection)));
    setAppointments(getStoredAppointments().filter(a => inSection(a, activeSection)));
    // Walk-in sales carry this stylist's revenue too — see revenueInPeriod.
    setInvoices(getSalonInvoices().filter(inv => inSection(inv, activeSection)));
  }, [id]);

  const handleSave = (updated: Staff, assignedServiceIds: string[]) => {
    const allStaff = getStoredStaff();
    const newList = allStaff.map((s) => (s.id === updated.id ? updated : s));
    saveStaff(newList);
    setStaff(updated);

    const allServices = getStoredServices();
    const newServices = allServices.map((sv) => {
      const isAssigned = assignedServiceIds.includes(sv.id);
      const hasStaff   = sv.assignedStaffIds.includes(updated.id);
      if (isAssigned && !hasStaff)  return { ...sv, assignedStaffIds: [...sv.assignedStaffIds, updated.id] };
      if (!isAssigned && hasStaff)  return { ...sv, assignedStaffIds: sv.assignedStaffIds.filter((x) => x !== updated.id) };
      return sv;
    });
    saveServices(newServices);
    setServices(newServices);
    setShowEdit(false);
  };

  // ── Computed stats ──────────────────────────────────────────────────────────
  const myAppts = useMemo(
    () => appointments.filter((a) => appointmentHasStaff(a, id ?? "")),
    [appointments, id],
  );

  // Read out as plain values before the memo: the React compiler can't preserve
  // memoization across optional property reads on a possibly-null object, and
  // these two are the only things the block needs from `staff`.
  const staffName = staff?.name ?? "";
  const staffUpsellRate = staff?.upsellCommissionRate;

  const stats = useMemo(() => {
    const completed  = myAppts.filter((a) => a.status === "completed");
    const noShow     = myAppts.filter((a) => a.status === "no-show");
    const upcoming   = myAppts.filter((a) => !["completed","cancelled","no-show"].includes(a.status));
    // A stylist's work reaches the books by two routes — a booked appointment, or
    // a walk-in rung up at the counter — and this page used to see only the
    // first, so a salon that books nothing showed every figure at zero. Money
    // goes through revenueInPeriod; the counts around it have to follow, or the
    // page reads "PKR 46,000 across 0 services".
    const staffRef = { id, name: staffName };
    const myWalkIns = invoices.filter((inv) => !inv.appointmentId && invoiceBelongsTo(inv, staffRef));

    const totalRev   = Math.round(revenueInPeriod(staffRef, appointments, services, ALL_TIME_START, ALL_TIME_END, invoices));
    // Service lines, not invoices: one sale can be three services done.
    const walkInServices = myWalkIns.reduce(
      (n, inv) => n + inv.items.filter((i) => i.type === "service").reduce((q, i) => q + Math.max(1, i.qty), 0), 0);
    const servicesDone = completed.length + walkInServices;
    // Per sale rather than per service — a ticket is what one client paid.
    const salesCount = completed.length + myWalkIns.length;
    const avgTicket  = salesCount ? totalRev / salesCount : 0;
    // Rate over appointments only: a walk-in cannot be a no-show.
    const noShowRate = myAppts.length ? Math.round((noShow.length / myAppts.length) * 100) : 0;

    const upsold = upsellInPeriod(staffRef, invoices, appointments, services, ALL_TIME_START, ALL_TIME_END);
    const upsoldValue = Math.round(upsold.value);
    const upsellPay = upsellIncentive(upsold.value, staffUpsellRate);

    const uniqueClients = new Set([
      ...myAppts.map((a) => a.clientId),
      ...myWalkIns.map((inv) => inv.clientId ?? `walkin:${inv.id}`),
    ].filter(Boolean)).size;

    // Revenue periods
    const weekStart      = startOf("week");
    const monthStart     = startOf("month");
    const lastMonthStart = startOf("lastMonth");
    const lastMonthEnd   = endOfLastMonth();

    const revWeek      = Math.round(revenueInPeriod(staffRef, appointments, services, weekStart, ALL_TIME_END, invoices));
    const revMonth     = Math.round(revenueInPeriod(staffRef, appointments, services, monthStart, ALL_TIME_END, invoices));
    const revLastMonth = Math.round(revenueInPeriod(staffRef, appointments, services, lastMonthStart, lastMonthEnd, invoices));

    // Top services
    const serviceCount: Record<string, number> = {};
    const serviceRevenue: Record<string, number> = {};
    for (const appt of completed) {
      for (const name of appt.serviceNames) {
        serviceCount[name]   = (serviceCount[name] ?? 0) + 1;
        serviceRevenue[name] = (serviceRevenue[name] ?? 0) + (appt.totalAmount ?? 0) / appt.serviceNames.length;
      }
    }
    for (const inv of myWalkIns) {
      for (const item of inv.items) {
        if (item.type !== "service") continue;
        const name = item.description.trim() || "Service";
        const qty = Math.max(1, item.qty);
        serviceCount[name]   = (serviceCount[name] ?? 0) + qty;
        serviceRevenue[name] = (serviceRevenue[name] ?? 0) + (item.total || 0);
      }
    }
    const topServices = Object.entries(serviceCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map(([name, count]) => ({ name, count, revenue: Math.round(serviceRevenue[name] ?? 0) }));

    // Unique clients list (last 5)
    const clientMap: Record<string, { name: string; visits: number; lastDate: string; spent: number }> = {};
    for (const appt of completed) {
      if (!clientMap[appt.clientId]) {
        clientMap[appt.clientId] = { name: appt.clientName, visits: 0, lastDate: appt.date, spent: 0 };
      }
      clientMap[appt.clientId].visits++;
      clientMap[appt.clientId].spent += appt.totalAmount ?? 0;
      if (appt.date > clientMap[appt.clientId].lastDate) clientMap[appt.clientId].lastDate = appt.date;
    }
    const topClients = Object.values(clientMap)
      .sort((a, b) => b.spent - a.spent)
      .slice(0, 6);

    return {
      total: myAppts.length, completed: completed.length, servicesDone, noShow: noShow.length,
      upsoldValue, upsellPay, upsellSales: upsold.lines.length,
      upcoming, totalRev, avgTicket, noShowRate, uniqueClients,
      revWeek, revMonth, revLastMonth, topServices, topClients,
    };
  }, [myAppts, id, appointments, services, invoices, staffName, staffUpsellRate]);

  const recentCompleted = useMemo(
    () => [...myAppts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12),
    [myAppts],
  );

  const assignedServices = services.filter((s) => s.assignedStaffIds.includes(id ?? ""));

  if (notFound) return (
    <div className="dash-page" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>👤</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#1a1a2e", marginBottom: 8 }}>Staff member not found</div>
        <button onClick={() => router.push("/dashboard/staff")} style={{ marginTop: 8, padding: "10px 24px", borderRadius: 10, background: "#7C3AED", border: "none", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Back to Staff
        </button>
      </div>
    </div>
  );

  if (!staff) return (
    <div className="dash-page" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
      <div style={{ fontSize: 13, color: "#9898b0" }}>Loading…</div>
    </div>
  );

  const role     = ROLE_COLORS[staff.role] ?? { color: "#6b7280", bg: "#f9fafb" };
  const maxRev   = Math.max(stats.revWeek, stats.revMonth, stats.revLastMonth, 1);
  const maxSvc   = stats.topServices[0]?.count ?? 1;

  return (
    <div className="dashboard-polish detail-page-polish" style={{ minHeight: "100vh", background: "#f4f5f7" }}>

      {showEdit && (
        <EditModal staff={staff} servicesList={services} onClose={() => setShowEdit(false)} onSave={handleSave} />
      )}

      {/* ── Header banner ────────────────────────────────────────────────── */}
      <div style={{ background: `linear-gradient(135deg, ${staff.color}22 0%, ${staff.color}08 100%)`, borderBottom: "1px solid #ebebf0" }}>
        <div className="dash-page" style={{ paddingTop: 20, paddingBottom: 28 }}>

          {/* Back nav */}
          <button
            onClick={() => router.push("/dashboard/staff")}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "#7C3AED", fontSize: 13, fontWeight: 700, marginBottom: 20, padding: 0 }}>
            <ArrowLeft size={15} /> All Staff
          </button>

          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            {/* Identity */}
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ width: 80, height: 80, borderRadius: "50%", background: staff.color + "30", border: `3px solid ${staff.color}50`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, fontWeight: 800, color: staff.color, flexShrink: 0 }}>
                {staff.name.charAt(0)}
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 900, color: "#1a1a2e", letterSpacing: "-0.01em" }}>{staff.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: role.color, background: role.bg, padding: "4px 12px", borderRadius: 20, textTransform: "capitalize" }}>
                    {staff.role.replace(/-/g, " ")}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: staff.isActive ? "#059669" : "#dc2626", background: staff.isActive ? "#ecfdf5" : "#fef2f2", padding: "4px 12px", borderRadius: 20 }}>
                    {staff.isActive ? "● Active" : "● Inactive"}
                  </span>
                  {staff.phone && (
                    <a href={`tel:${staff.phone}`} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6b6b8a", textDecoration: "none", background: "#fff", border: "1px solid #e8e8f0", padding: "4px 12px", borderRadius: 20 }}>
                      <Phone size={11} /> {staff.phone}
                    </a>
                  )}
                </div>
                {staff.specialties.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
                    {staff.specialties.map((sp) => (
                      <span key={sp} style={{ fontSize: 11, color: staff.color, background: staff.color + "18", padding: "2px 10px", borderRadius: 12 }}>{sp}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => exportStaffPdf(staff, appointments, settingsStore.salon.name as string)}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 18px", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", color: "#6b6b8a", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                <FileDown size={14} /> Export PDF
              </button>
              <button
                onClick={() => setShowEdit(true)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "1px solid #7C3AED", background: "#fff", color: "#7C3AED", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 1px 4px rgba(124,58,237,0.12)" }}>
                <Edit2 size={14} /> Edit Profile
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="dash-page" style={{ display: "flex", flexDirection: "column", gap: 22, paddingTop: 24 }}>

        {/* ── 6 Key stat cards ─────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 14 }}>
          <StatCard label="Total Revenue"      value={fmt(stats.totalRev)}    sub="appointments + POS sales"     icon={TrendingUp}   color="#7C3AED" />
          <StatCard label="Services Done"      value={stats.servicesDone}      sub="completed + sold at POS"      icon={CheckCircle2} color="#059669" />
          <StatCard label="Total Appointments" value={stats.total}             sub={`${stats.upcoming.length} upcoming`} icon={Calendar}  color="#0284c7" />
          <StatCard label="Avg Ticket"         value={fmt(stats.avgTicket)}    sub="per sale"                     icon={Star}         color="#d97706" />
          <StatCard label="Unique Clients"     value={stats.uniqueClients}     sub="clients served"               icon={Users}        color="#db2777" />
          <StatCard label="No-show Rate"       value={`${stats.noShowRate}%`}  sub={`${stats.noShow} no-shows`}  icon={XCircle}      color={stats.noShowRate > 20 ? "#dc2626" : "#9ca3af"} />
          <StatCard
            label="Upsold"
            value={fmt(stats.upsoldValue)}
            sub={staff?.upsellCommissionRate
              ? `${fmt(stats.upsellPay)} incentive at ${staff.upsellCommissionRate}%`
              : "no upsell rate set"}
            icon={TrendingUp}
            color="#d97706"
          />
        </div>

        {/* ── Revenue breakdown + Top services ─────────────────────────────── */}
        <div className="sd-two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>

          {/* Revenue by period */}
          <Section title="Revenue Breakdown" icon={BarChart2}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <RevRow label="This Week"   value={stats.revWeek}      pct={Math.round((stats.revWeek / maxRev) * 100)}      color="#7C3AED" />
              <RevRow label="This Month"  value={stats.revMonth}     pct={Math.round((stats.revMonth / maxRev) * 100)}     color="#059669" />
              <RevRow label="Last Month"  value={stats.revLastMonth} pct={Math.round((stats.revLastMonth / maxRev) * 100)} color="#0284c7" />
              <RevRow label="All Time"    value={stats.totalRev}     pct={100}                                              color="#d97706" />
            </div>
          </Section>

          {/* Top services */}
          <Section title="Top Services" icon={Scissors}>
            {stats.topServices.length === 0 ? (
              <div style={{ fontSize: 13, color: "#9898b0", fontStyle: "italic" }}>No services done yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {stats.topServices.map((svc) => (
                  <div key={svc.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 110, fontSize: 12, color: "#29293d", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }} title={svc.name}>{svc.name}</div>
                    <MiniBar value={svc.count} max={maxSvc} color="#7C3AED" />
                    <div style={{ width: 28, textAlign: "right", fontSize: 12, fontWeight: 700, color: "#7C3AED", flexShrink: 0 }}>{svc.count}×</div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* ── Recent Appointments ───────────────────────────────────────────── */}
        <Section title="Recent Appointments" icon={Clock}
          action={<span style={{ fontSize: 11, color: "#9999b0" }}>{myAppts.length} total</span>}>
          {recentCompleted.length === 0 ? (
            <div style={{ fontSize: 13, color: "#9898b0", fontStyle: "italic" }}>No appointments recorded yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="sd-appt-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 540 }}>
                <thead>
                  <tr style={{ background: "#fafafd" }}>
                    {["Date", "Client", "Services", "Status", "Amount"].map((h) => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#9999b0", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #f0f0f8" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentCompleted.map((appt, i) => {
                    const sm = STATUS_META[appt.status] ?? { label: appt.status, color: "#6b7280", bg: "#f9fafb" };
                    return (
                      <tr key={appt.id}
                        style={{ borderBottom: "1px solid #f8f8fc", background: i % 2 === 0 ? "#fff" : "#fafafd" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#f5f3ff")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = i % 2 === 0 ? "#fff" : "#fafafd")}>
                        <td style={{ padding: "10px 12px", fontSize: 12, color: "#6b6b8a", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtDate(appt.date)}</td>
                        <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, color: "#1d1d2f" }}>{appt.clientName}</td>
                        <td style={{ padding: "10px 12px", fontSize: 12, color: "#6b6b8a", maxWidth: 200 }}>
                          {appt.serviceNames.slice(0, 2).join(", ")}{appt.serviceNames.length > 2 && ` +${appt.serviceNames.length - 2}`}
                        </td>
                        <td style={{ padding: "10px 12px" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: sm.color, background: sm.bg, padding: "3px 9px", borderRadius: 20 }}>{sm.label}</span>
                        </td>
                        <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 700, color: "#7C3AED", whiteSpace: "nowrap" }}>{fmt(appt.totalAmount ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* ── Upcoming + Top clients + Assigned services (3-col on desktop) ── */}
        <div className="sd-three" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 22 }}>

          {/* Upcoming appointments */}
          <Section title="Upcoming" icon={Calendar}>
            {stats.upcoming.length === 0 ? (
              <div style={{ fontSize: 13, color: "#9898b0", fontStyle: "italic" }}>No upcoming appointments.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {stats.upcoming.slice(0, 6).map((appt) => {
                  const sm = STATUS_META[appt.status] ?? { label: appt.status, color: "#6b7280", bg: "#f9fafb" };
                  return (
                    <div key={appt.id} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px", borderRadius: 10, background: "#f9f9fb", border: "1px solid #f0f0f8" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#1d1d2f" }}>{appt.clientName}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: sm.color, background: sm.bg, padding: "2px 8px", borderRadius: 20 }}>{sm.label}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "#9898b0" }}>{fmtDate(appt.date)} · {appt.startTime}</div>
                      <div style={{ fontSize: 11, color: "#7C3AED", fontWeight: 600 }}>{appt.serviceNames[0]}</div>
                    </div>
                  );
                })}
                {stats.upcoming.length > 6 && (
                  <div style={{ fontSize: 11, color: "#9999b0", textAlign: "center" }}>+{stats.upcoming.length - 6} more</div>
                )}
              </div>
            )}
          </Section>

          {/* Top clients */}
          <Section title="Top Clients" icon={Users}>
            {stats.topClients.length === 0 ? (
              <div style={{ fontSize: 13, color: "#9898b0", fontStyle: "italic" }}>No clients served yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {stats.topClients.map((cl, i) => (
                  <div key={cl.name + i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 9, background: "#f9f9fb" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: staff.color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: staff.color, flexShrink: 0 }}>
                      {cl.name.charAt(0)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#1d1d2f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cl.name}</div>
                      <div style={{ fontSize: 10, color: "#9898b0", marginTop: 1 }}>{cl.visits} visit{cl.visits !== 1 ? "s" : ""} · last {fmtDate(cl.lastDate)}</div>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#7C3AED", flexShrink: 0 }}>{fmt(cl.spent)}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Assigned services */}
          <Section title="Assigned Services" icon={Award}>
            {assignedServices.length === 0 ? (
              <div style={{ fontSize: 13, color: "#9898b0", fontStyle: "italic" }}>No services assigned. Click Edit Profile to assign.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {assignedServices.map((sv) => (
                  <div key={sv.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: 9, background: "#f9f9fb", border: "1px solid #f0f0f8" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <Scissors size={12} color="#9898b0" />
                      <span style={{ fontSize: 13, color: "#1a1a2e", fontWeight: 500 }}>{sv.name}</span>
                    </div>
                    <span style={{ fontSize: 12, color: "#7C3AED", fontWeight: 700 }}>{fmt(sv.price)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

      </div>
    </div>
  );
}
