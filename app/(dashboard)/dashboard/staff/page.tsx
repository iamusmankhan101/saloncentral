"use client";

import { appointmentHasStaff } from "@/lib/appointment-staff";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getStoredStaff, saveStaff, getStoredServices, saveServices, getStoredAppointments, subscribeToStoredData } from "@/lib/storage";
import type { Staff, Service, StaffRole, StaffRoleValue, StaffPayType, Appointment } from "@/lib/types";
import { X, Plus, Check, ChevronRight, Trash2, UserCog, Pencil, Lock, Upload, Download, FileSpreadsheet, ChevronDown } from "lucide-react";
import { getCurrentPlan, isAtLimit } from "@/lib/plan-limits";
import { getSectionOptions, getActiveSection, inSection, defaultSectionForNewRecord } from "@/lib/sections";
import PageTitle from "@/components/page-title";
import MobilePageHeader from "@/components/mobile-page-header";

const ROLE_COLORS: Record<string, { color: string; bg: string }> = {
  owner:           { color: "#7C3AED", bg: "#EDE9FE" },
  manager:         { color: "#0369a1", bg: "#e0f2fe" },
  "senior-stylist":{ color: "#059669", bg: "#ecfdf5" },
  "junior-stylist":{ color: "#d97706", bg: "#fffbeb" },
  receptionist:    { color: "#db2777", bg: "#fdf2f8" },
  trainee:         { color: "#6b7280", bg: "#f9fafb" },
  hair:            { color: "#0369a1", bg: "#e0f2fe" },
  aesthetic:       { color: "#be185d", bg: "#fdf2f8" },
};

import { fmtCurrency as fmt } from "@/lib/format";
import { revenueInPeriod, ALL_TIME_START, ALL_TIME_END } from "@/lib/payouts";
import { upsellInPeriod, upsellIncentive } from "@/lib/upsell";
import { getSalonInvoices, type SalonInvoice } from "@/lib/salon-invoices";
import ShiftFields from "@/components/shift-fields";
import WeeklyOffFields from "@/components/weekly-off-fields";

/**
 * Appointment count and revenue for one staff member's card.
 *
 * Revenue goes through revenueInPeriod rather than summing appointment totals
 * here, so it counts walk-in sales rung up at POS as well as booked work, and
 * agrees with the figure Payouts pays commission on. A salon that books nothing
 * used to show every stylist at zero however much they had taken.
 *
 * The appointment count stays a count of appointments — walk-ins aren't
 * appointments, and quietly folding them in would make the label a lie.
 */
function getStaffStats(staff: Staff, appointments: Appointment[], services: Service[], invoices: SalonInvoice[]) {
  const mine = appointments.filter((a) => appointmentHasStaff(a, staff.id));
  const upsold = upsellInPeriod(staff, invoices, appointments, services, ALL_TIME_START, ALL_TIME_END).value;
  return {
    total: mine.length,
    revenue: Math.round(revenueInPeriod(staff, appointments, services, ALL_TIME_START, ALL_TIME_END, invoices)),
    upsoldValue: Math.round(upsold),
    // Shown only where a rate is set — an incentive of zero against real upsold
    // value reads as a bug rather than as "no rate configured".
    upsellIncentive: upsellIncentive(upsold, staff.upsellCommissionRate),
  };
}


const STAFF_EXPORT_COLS = [
  "Staff ID", "Name", "Phone", "Email", "Role", "Section", "Active", "Pay Type",
  "Commission Rate", "Base Salary", "Paid Leaves / Month", "Specialties", "Assigned Services", "Color",
];

const STAFF_ROLES = Object.keys(ROLE_COLORS) as StaffRole[];
/** Sentinel select value that reveals the free-text role field — never stored. */
const CUSTOM_ROLE = "__custom__";

/** Custom roles already in use, so the second person with one can just pick it. */
function customRolesInUse(list: Staff[]): string[] {
  return Array.from(new Set(list.map((s) => s.role)))
    .filter((r): r is string => !!r && !STAFF_ROLES.includes(r as StaffRole))
    .sort();
}
const STAFF_PAY_TYPES: StaffPayType[] = ["commission", "salary", "both"];

type StaffImportRecord = { staff: Staff; assignedServiceNames: string[]; mode: "add" | "update" };
type StaffImportResult = { added: number; updated: number; skipped: number; errors: string[] };

function splitList(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseActive(value: unknown): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["false", "no", "inactive", "0"].includes(raw);
}

function normalizeRole(value: unknown): StaffRoleValue {
  const raw = String(value ?? "").trim();
  if (!raw) return "junior-stylist";
  const role = raw.toLowerCase().replace(/\s+/g, "-") as StaffRole;
  // An unrecognised value is a custom role the salon uses, not bad data — keep
  // it as typed rather than silently relabelling the person junior-stylist.
  return STAFF_ROLES.includes(role) ? role : raw;
}

function normalizePayType(value: unknown): StaffPayType {
  const payType = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "-") as StaffPayType;
  return STAFF_PAY_TYPES.includes(payType) ? payType : "commission";
}

function staffToRows(list: Staff[], servicesList: Service[]) {
  return list.map((staff) => {
    const assignedServices = servicesList.filter((service) => service.assignedStaffIds.includes(staff.id)).map((service) => service.name);
    return {
      "Staff ID": staff.id,
      "Name": staff.name,
      "Phone": staff.phone,
      "Email": staff.email ?? "",
      "Role": staff.role,
      "Section": staff.section ?? "",
      "Active": staff.isActive ? "Yes" : "No",
      "Pay Type": staff.payType ?? "commission",
      "Commission Rate": staff.commissionRate ?? "",
      "Base Salary": staff.baseSalary ?? "",
      "Paid Leaves / Month": staff.paidLeavesPerMonth ?? "",
      "Standard Hours / Day": staff.standardHoursPerDay ?? "",
      "Shift Start": staff.shiftStart ?? "",
      "Shift End": staff.shiftEnd ?? "",
      "Specialties": staff.specialties.join(", "),
      "Assigned Services": assignedServices.join(", "),
      "Color": staff.color,
    };
  });
}

async function exportStaff(list: Staff[], servicesList: Service[], format: "xlsx" | "csv") {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(staffToRows(list, servicesList), { header: STAFF_EXPORT_COLS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Staff");
  const date = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `staff-${date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else {
    XLSX.writeFile(wb, `staff-${date}.xlsx`);
  }
}

// ── Staff Form Modal (Add & Edit) ─────────────────────────────────────────────
function StaffFormModal({ onClose, onSave, staff, servicesList, staffList }: { onClose: () => void; onSave: (s: Staff, assignedServiceIds: string[]) => void; staff?: Staff; servicesList: Service[]; staffList: Staff[] }) {
  const [done, setDone] = useState(false);
  const [form, setForm] = useState({
    name: staff?.name ?? "",
    phone: staff?.phone ?? "",
    role: staff && !STAFF_ROLES.includes(staff.role as StaffRole) ? CUSTOM_ROLE : (staff?.role ?? ""),
    customRole: staff && !STAFF_ROLES.includes(staff.role as StaffRole) ? staff.role : "",
    section: staff?.section ?? defaultSectionForNewRecord(),
    payType: staff?.payType ?? "commission",
    commissionRate: staff?.commissionRate ? String(staff.commissionRate) : "",
    baseSalary: staff?.baseSalary ? String(staff.baseSalary) : "",
    paidLeavesPerMonth: staff?.paidLeavesPerMonth != null ? String(staff.paidLeavesPerMonth) : "",
    upsellCommissionRate: staff?.upsellCommissionRate != null ? String(staff.upsellCommissionRate) : "",
    standardHoursPerDay: staff?.standardHoursPerDay != null ? String(staff.standardHoursPerDay) : "",
    shiftStart: staff?.shiftStart ?? "",
    shiftEnd: staff?.shiftEnd ?? "",
  });
  // null = follow the salon roster; an array (empty included) = this person's own.
  const [offDays, setOffDays] = useState<number[] | null>(staff?.weeklyOffDays ?? null);
  const sectionOptions = getSectionOptions(staffList);
  // The role being edited is already the selected option, so don't list it twice.
  const existingCustomRoles = customRolesInUse(staffList).filter((r) => r !== staff?.role);

  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>(() => {
    if (staff) {
      return servicesList.filter(s => s.assignedStaffIds.includes(staff.id)).map(s => s.id);
    }
    return [];
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const canSubmit = form.name && form.phone && form.role
    && (form.role !== CUSTOM_ROLE || form.customRole.trim());

  const toggleService = (id: string) => {
    const current = [...selectedServiceIds];
    if (current.includes(id)) {
      setSelectedServiceIds(current.filter(x => x !== id));
    } else {
      setSelectedServiceIds([...current, id]);
    }
  };

  const handleSave = () => {
    if (!canSubmit) return;

    // Determine specialties from selected services names
    const selectedServices = servicesList.filter(s => selectedServiceIds.includes(s.id));
    const specialtiesArray = selectedServices.map(s => s.name);

    const colors = ["#8B5CF6", "#f472b6", "#34d399", "#fb923c", "#38bdf8", "#ec4899", "#f59e0b", "#6366f1"];
    const color = staff?.color ?? colors[Math.floor(Math.random() * colors.length)];

    const savedStaff: Staff = {
      id: staff?.id ?? "s" + Date.now(),
      name: form.name,
      phone: form.phone,
      email: staff?.email ?? "",
      role: form.role === CUSTOM_ROLE ? form.customRole.trim() : form.role,
      section: form.section || undefined,
      specialties: specialtiesArray,
      color,
      isActive: staff?.isActive ?? true,
      payType: form.payType as StaffPayType,
      commissionRate: (form.payType === "commission" || form.payType === "both") && form.commissionRate ? Number(form.commissionRate) : undefined,
      baseSalary: (form.payType === "salary" || form.payType === "both") && form.baseSalary ? Number(form.baseSalary) : undefined,
      paidLeavesPerMonth: form.paidLeavesPerMonth !== "" && Number(form.paidLeavesPerMonth) >= 0 ? Number(form.paidLeavesPerMonth) : undefined,
      standardHoursPerDay: Number(form.standardHoursPerDay) > 0 ? Number(form.standardHoursPerDay) : undefined,
      shiftStart: form.shiftStart && form.shiftEnd ? form.shiftStart : undefined,
      shiftEnd: form.shiftStart && form.shiftEnd ? form.shiftEnd : undefined,
      upsellCommissionRate: form.upsellCommissionRate !== "" && Number(form.upsellCommissionRate) > 0 ? Number(form.upsellCommissionRate) : undefined,
      weeklyOffDays: offDays ?? undefined,
    };

    onSave(savedStaff, selectedServiceIds);
    setDone(true);
  };

  if (done) return (
    <div onClick={onClose} className="modal-overlay" style={{ zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 360, maxWidth: "100%", padding: "48px 32px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 28, color: "#059669", fontWeight: "bold" }}>✓</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: "#1a1a2e", marginBottom: 8 }}>Staff Member Saved</div>
        <div style={{ fontSize: 13, color: "#9898b0", marginBottom: 24 }}>The staff member record has been updated.</div>
        <button onClick={onClose} style={{ padding: "10px 32px", borderRadius: 10, background: "#7C3AED", border: "none", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );

  return (
    <div onClick={onClose} className="modal-overlay" style={{ zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 440, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "22px 24px 18px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>{staff ? "Edit Staff Member" : "Add Staff Member"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}><X size={18} color="#6b6b8a" /></button>
        </div>
        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Full Name</label>
            <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Sara Ahmed"
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Phone</label>
            <input type="text" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="e.g. 0300-1234567"
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Salon Role</label>
            <select value={form.role} onChange={(e) => set("role", e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
              <option value="">Select a role…</option>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{r.replace(/-/g, " ")}</option>)}
              {existingCustomRoles.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value={CUSTOM_ROLE}>Custom…</option>
            </select>
          </div>
          {form.role === CUSTOM_ROLE && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Custom Role Name</label>
              <input type="text" value={form.customRole} onChange={(e) => set("customRole", e.target.value)} placeholder="e.g. Nail Technician"
                style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Salon Section</label>
            <select value={form.section} onChange={(e) => set("section", e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
              <option value="">Unassigned</option>
              {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
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
              <input type="number" min="0" max="100" value={form.commissionRate} onChange={(e) => set("commissionRate", e.target.value)} placeholder="e.g. 30"
                style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            </div>
          )}
          {(form.payType === "salary" || form.payType === "both") && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Base Salary (PKR / pay period)</label>
                <input type="number" min="0" value={form.baseSalary} onChange={(e) => set("baseSalary", e.target.value)} placeholder="e.g. 30000"
                  style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
              </div>
            </>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Upsell Incentive (%)</label>
            <input type="number" min="0" max="100" value={form.upsellCommissionRate} onChange={(e) => set("upsellCommissionRate", e.target.value)} placeholder="e.g. 10"
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            <div style={{ fontSize: 11, color: "#b0b0c8" }}>Extra commission on services sold beyond what the client booked, paid on top of any normal commission. Leave blank for none.</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Paid Leaves / Month</label>
            <input type="number" min="0" value={form.paidLeavesPerMonth} onChange={(e) => set("paidLeavesPerMonth", e.target.value)} placeholder="e.g. 2"
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            <div style={{ fontSize: 11, color: "#b0b0c8" }}>Leave days marked in Attendance, up to this many per pay period, are paid in full; further leaves reduce salary. Leave blank to use the salon default from Settings → Business Hours.</div>
          </div>

          <WeeklyOffFields value={offDays} onChange={setOffDays} />

          <ShiftFields start={form.shiftStart} end={form.shiftEnd}
            onChange={(a, b) => setForm((f) => ({ ...f, shiftStart: a, shiftEnd: b }))}
            inputStyle={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }} />

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Standard Hours / Day</label>
            <input type="number" min="0" step="0.5" value={form.standardHoursPerDay} onChange={(e) => set("standardHoursPerDay", e.target.value)} placeholder="e.g. 8"
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            <div style={{ fontSize: 11, color: "#b0b0c8" }}>A full working day for this person. Leave blank to use their shift length, or the salon standard from Settings → Business Hours.</div>
          </div>

          <div style={{ padding: "10px 12px", borderRadius: 10, background: "#f5f3ff", color: "#6d28d9", fontSize: 12, lineHeight: 1.55, fontWeight: 650 }}>
            Staff login, password, and page permissions are managed separately in <strong>Account → Roles & Permissions</strong>.
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Assign Services (Dropdown Selection)</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 150, overflowY: "auto", border: "1px solid #e8e8f0", borderRadius: 8, padding: 8 }}>
              {servicesList.length > 0 ? servicesList.map((sv) => {
                const checked = selectedServiceIds.includes(sv.id);
                return (
                  <div key={sv.id} onClick={() => toggleService(sv.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "#f4f0fe" : "transparent" }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: "1px solid #7C3AED", display: "flex", alignItems: "center", justifyContent: "center", background: checked ? "#7C3AED" : "#fff" }}>
                      {checked && <Check size={11} color="#fff" strokeWidth={3} />}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e" }}>
                      {sv.name} <span style={{ fontSize: 11, color: "#9898b0" }}>— {fmt(sv.price)}</span>
                    </span>
                  </div>
                );
              }) : <div style={{ fontSize: 12, color: "#9898b0", fontStyle: "italic", padding: "8px 0" }}>No salon services found. Please add services first.</div>}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
            <button onClick={handleSave} disabled={!canSubmit} style={{ flex: 2, padding: "11px 0", borderRadius: 10, border: "none", background: canSubmit ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 600, color: canSubmit ? "#fff" : "#b0b0c8", cursor: canSubmit ? "pointer" : "not-allowed" }}>
              {staff ? "Save Changes" : "Add Staff"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ── Import Modal ──────────────────────────────────────────────────────────────
function StaffImportModal({ existing, servicesList, onClose, onImport }: {
  existing: Staff[];
  servicesList: Service[];
  onClose: () => void;
  onImport: (records: StaffImportRecord[]) => StaffImportResult;
}) {
  const [step, setStep] = useState<"pick" | "preview" | "done">("pick");
  const [parsed, setParsed] = useState<StaffImportRecord[]>([]);
  const [result, setResult] = useState<StaffImportResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleFile(file: File) {
    setError("");
    setLoading(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
      if (rows.length === 0) {
        setError("File is empty or unreadable.");
        setLoading(false);
        return;
      }

      const byId = new Map(existing.map((staff) => [staff.id, staff]));
      const byPhone = new Map(existing.filter((staff) => staff.phone).map((staff) => [staff.phone.replace(/\s/g, ""), staff]));
      const records: StaffImportRecord[] = [];
      const usedIds = new Set(existing.map((staff) => staff.id));

      for (const row of rows) {
        const name = String(row["Name"] ?? row["name"] ?? "").trim();
        const phone = String(row["Phone"] ?? row["phone"] ?? row["Phone Number"] ?? "").trim();
        if (!name || !phone) continue;

        const rawId = String(row["Staff ID"] ?? row["ID"] ?? row["id"] ?? "").trim();
        const existingStaff = (rawId && byId.get(rawId)) || byPhone.get(phone.replace(/\s/g, ""));
        const id = existingStaff?.id ?? (rawId || `staff_imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        if (!existingStaff && usedIds.has(id)) continue;
        usedIds.add(id);

        const payType = normalizePayType(row["Pay Type"] ?? row["PayType"]);
        const commissionRate = Number(row["Commission Rate"] ?? row["Commission"] ?? "");
        const baseSalary = Number(row["Base Salary"] ?? row["Salary"] ?? "");
        const paidLeavesPerMonth = Number(row["Paid Leaves / Month"] ?? row["Paid Leaves"] ?? "");
        const standardHoursPerDay = Number(row["Standard Hours / Day"] ?? row["Standard Hours"] ?? "");
        // Excel may hand back "11:00", "11:00 AM" or a day fraction (0.4583…).
        const toHHMM = (v: unknown): string => {
          if (typeof v === "number" && v >= 0 && v < 1) { const m = Math.round(v * 1440); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }
          const t = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(String(v ?? "").trim());
          if (!t) return "";
          let h = Number(t[1]) % 12 + (t[3] && t[3].toLowerCase() === "pm" ? 12 : 0);
          if (!t[3]) h = Number(t[1]);
          return h < 24 && Number(t[2]) < 60 ? `${String(h).padStart(2, "0")}:${t[2]}` : "";
        };
        const shiftStart = toHHMM(row["Shift Start"]), shiftEnd = toHHMM(row["Shift End"]);
        const assignedServiceNames = splitList(row["Assigned Services"] ?? row["Services"]);
        const specialties = splitList(row["Specialties"]).length ? splitList(row["Specialties"]) : assignedServiceNames;

        records.push({
          mode: existingStaff ? "update" : "add",
          assignedServiceNames,
          staff: {
            id,
            name,
            phone,
            email: String(row["Email"] ?? row["email"] ?? "").trim() || existingStaff?.email || "",
            role: normalizeRole(row["Role"] ?? row["role"]),
            section: String(row["Section"] ?? row["section"] ?? "").trim()
              || defaultSectionForNewRecord()
              || undefined,
            specialties,
            color: String(row["Color"] ?? row["color"] ?? "").trim() || existingStaff?.color || "#8B5CF6",
            isActive: parseActive(row["Active"] ?? row["Status"]),
            payType,
            commissionRate: (payType === "commission" || payType === "both") && Number.isFinite(commissionRate) ? commissionRate : undefined,
            baseSalary: (payType === "salary" || payType === "both") && Number.isFinite(baseSalary) ? baseSalary : undefined,
            paidLeavesPerMonth: (payType === "salary" || payType === "both") && Number.isFinite(paidLeavesPerMonth) ? paidLeavesPerMonth : undefined,
            standardHoursPerDay: Number.isFinite(standardHoursPerDay) && standardHoursPerDay > 0 ? standardHoursPerDay : undefined,
            shiftStart: shiftStart && shiftEnd ? shiftStart : undefined,
            shiftEnd: shiftStart && shiftEnd ? shiftEnd : undefined,
          },
        });
      }

      setParsed(records);
      setStep("preview");
    } catch (e) {
      setError(`Could not read file: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function downloadTemplate() {
    const XLSX = await import("xlsx");
    const sample = [{
      "Staff ID": "",
      "Name": "Sara Ahmed",
      "Phone": "923001234567",
      "Email": "sara@example.com",
      "Role": "senior-stylist",
      "Section": "Hair",
      "Active": "Yes",
      "Pay Type": "both",
      "Commission Rate": 30,
      "Base Salary": 25000,
      "Paid Leaves / Month": 2,
      "Specialties": "Haircut, Blowdry",
      "Assigned Services": "Haircut, Blowdry",
      "Color": "#8B5CF6",
    }];
    const ws = XLSX.utils.json_to_sheet(sample, { header: STAFF_EXPORT_COLS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Staff Template");
    XLSX.writeFile(wb, "staff-import-template.xlsx");
  }

  function confirmImport() {
    const importResult = onImport(parsed);
    setResult(importResult);
    setStep("done");
  }

  const addCount = parsed.filter((record) => record.mode === "add").length;
  const updateCount = parsed.filter((record) => record.mode === "update").length;
  const serviceNames = new Set(servicesList.map((service) => service.name.toLowerCase()));
  const missingServiceCount = parsed.reduce((count, record) => count + record.assignedServiceNames.filter((name) => !serviceNames.has(name.toLowerCase())).length, 0);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 540, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#5B21B6,#9333EA)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <FileSpreadsheet size={18} color="#fff" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Import Staff</div>
              <div style={{ fontSize: 11, color: "#9898b0" }}>XLSX or CSV file</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}><X size={18} color="#9898b0" /></button>
        </div>

        {step === "pick" && (
          <>
            <label style={{ display: "block", border: "2px dashed #ddd6fe", borderRadius: 14, padding: "32px 20px", textAlign: "center", cursor: "pointer", background: "#faf9ff" }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              <Upload size={28} color="#7C3AED" style={{ marginBottom: 10 }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: "#5B21B6", marginBottom: 4 }}>Click to choose file or drag & drop</div>
              <div style={{ fontSize: 12, color: "#9898b0" }}>Supports .xlsx, .xls, .csv</div>
            </label>
            {loading && <div style={{ textAlign: "center", marginTop: 16, color: "#7C3AED", fontSize: 13, fontWeight: 600 }}>Reading file...</div>}
            {error && <div style={{ marginTop: 12, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 13, color: "#dc2626" }}>{error}</div>}

            <div style={{ marginTop: 18, padding: "14px 16px", background: "#f5f3ff", borderRadius: 12, fontSize: 12, color: "#5B21B6", lineHeight: 1.8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <strong style={{ fontSize: 12 }}>Column format</strong>
                <button onClick={downloadTemplate} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 8, border: "1px solid #c4b5fd", background: "#fff", fontSize: 11, fontWeight: 700, color: "#5B21B6", cursor: "pointer", whiteSpace: "nowrap" }}>
                  <Download size={12} /> Download Template
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px", fontSize: 11 }}>
                {[
                  ["Name", "Required"], ["Phone", "Required"], ["Role", `${STAFF_ROLES.join(" / ")} / or any custom role`], ["Pay Type", "commission / salary / both"],
                  ["Assigned Services", "Comma-separated service names"], ["Specialties", "Comma-separated"], ["Active", "Yes / No"], ["Section", "Optional"],
                ].map(([col, hint]) => <div key={col}><strong>{col}</strong>: {hint}</div>)}
              </div>
            </div>
          </>
        )}

        {step === "preview" && (
          <>
            <div style={{ padding: "14px 16px", background: "#f8f7ff", border: "1px solid #e9d5ff", borderRadius: 12, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e" }}>{parsed.length} staff record{parsed.length === 1 ? "" : "s"} ready</div>
              <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 4 }}>{addCount} new, {updateCount} update{updateCount === 1 ? "" : "s"}{missingServiceCount ? `, ${missingServiceCount} unmatched service assignment${missingServiceCount === 1 ? "" : "s"}` : ""}</div>
            </div>
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid #f0f0f8", borderRadius: 12 }}>
              {parsed.slice(0, 8).map((record) => (
                <div key={record.staff.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid #f8f8fc" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{record.staff.name}</div>
                    <div style={{ fontSize: 11, color: "#9898b0" }}>{record.staff.phone} · {record.staff.role}</div>
                  </div>
                  <span style={{ alignSelf: "center", fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "3px 8px", background: record.mode === "add" ? "#ecfdf5" : "#eff6ff", color: record.mode === "add" ? "#059669" : "#2563eb" }}>{record.mode === "add" ? "Add" : "Update"}</span>
                </div>
              ))}
              {parsed.length > 8 && <div style={{ padding: "10px 12px", fontSize: 12, color: "#9898b0" }}>+{parsed.length - 8} more</div>}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={() => setStep("pick")} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}>Back</button>
              <button onClick={confirmImport} disabled={parsed.length === 0} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: parsed.length ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 700, color: parsed.length ? "#fff" : "#b0b0c8", cursor: parsed.length ? "pointer" : "not-allowed" }}>Import Staff</button>
            </div>
          </>
        )}

        {step === "done" && result && (
          <div style={{ textAlign: "center", padding: "24px 8px 8px" }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Check size={28} color="#059669" /></div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1a1a2e", marginBottom: 6 }}>Import Complete</div>
            <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 20 }}>{result.added} added, {result.updated} updated{result.skipped ? `, ${result.skipped} skipped` : ""}.</div>
            <button onClick={onClose} style={{ padding: "10px 32px", borderRadius: 10, border: "none", background: "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Delete Confirm Modal ──────────────────────────────────────────────────────
function DeleteConfirmModal({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 340, maxWidth: "100%", padding: "32px 28px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <Trash2 size={22} color="#dc2626" />
        </div>
        <div style={{ fontWeight: 700, fontSize: 17, color: "#1a1a2e", marginBottom: 8 }}>Delete Staff Member?</div>
        <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 24 }}>
          This will permanently delete <strong>{name}</strong> and cannot be undone.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
          <button onClick={onConfirm} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#dc2626", fontSize: 13, fontWeight: 600, color: "#fff", cursor: "pointer" }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function StaffPage() {
  const router = useRouter();
  const [showAdd, setShowAdd]       = useState(false);
  const [editingStaff, setEditingStaff] = useState<Staff | null>(null);
  const [staffList, setStaffList]   = useState<Staff[]>([]);
  const [servicesList, setServicesList] = useState<Service[]>([]);
  const [appointmentsList, setAppointmentsList] = useState<Appointment[]>([]);
  const [invoicesList, setInvoicesList] = useState<SalonInvoice[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Staff | null>(null);
  const [sectionFilter, setSectionFilter] = useState(() => getActiveSection());
  const [showImport, setShowImport] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const plan        = getCurrentPlan();
  const activeCount = staffList.filter((s) => s.isActive).length;
  const staffLimited = isAtLimit(plan.staffLimit, activeCount);
  const visibleStaff = staffList.filter((s) => inSection(s, sectionFilter));

  useEffect(() => {
    const load = () => {
      setStaffList(getStoredStaff());
      setServicesList(getStoredServices());
      setAppointmentsList(getStoredAppointments());
      setInvoicesList(getSalonInvoices());
    };
    queueMicrotask(load);
    // See the services page: a tab left open all day must not keep rendering the
    // snapshot it read on mount.
    return subscribeToStoredData(load);
  }, []);

  const handleSaveStaff = (savedStaff: Staff, assignedServiceIds: string[]) => {
    const exists = staffList.some((s) => s.id === savedStaff.id);
    const updatedStaffList = exists
      ? staffList.map((s) => (s.id === savedStaff.id ? savedStaff : s))
      : [...staffList, savedStaff];
    setStaffList(updatedStaffList);
    saveStaff(updatedStaffList);

    const updatedServicesList = servicesList.map((sv) => {
      const isAssigned = assignedServiceIds.includes(sv.id);
      const hasStaff   = sv.assignedStaffIds.includes(savedStaff.id);
      if (isAssigned && !hasStaff)  return { ...sv, assignedStaffIds: [...sv.assignedStaffIds, savedStaff.id] };
      if (!isAssigned && hasStaff)  return { ...sv, assignedStaffIds: sv.assignedStaffIds.filter((id) => id !== savedStaff.id) };
      return sv;
    });
    setServicesList(updatedServicesList);
    saveServices(updatedServicesList);
  };

  const handleDeleteStaff = (id: string) => {
    const updated = staffList.filter((s) => s.id !== id);
    setStaffList(updated);
    saveStaff(updated, [id]);
    // Remove this staff member from all service assignments
    const updatedServices = servicesList.map((sv) => ({
      ...sv,
      assignedStaffIds: sv.assignedStaffIds.filter((sid) => sid !== id),
    }));
    setServicesList(updatedServices);
    saveServices(updatedServices);
    setDeleteTarget(null);
  };


  const handleImportStaff = (records: StaffImportRecord[]): StaffImportResult => {
    const byId = new Map(staffList.map((staff) => [staff.id, staff]));
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const record of records) {
      if (!record.staff.name || !record.staff.phone) {
        skipped += 1;
        continue;
      }
      if (byId.has(record.staff.id)) updated += 1;
      else added += 1;
      byId.set(record.staff.id, record.staff);
    }

    const importedIds = new Set(records.map((record) => record.staff.id));
    const nextStaff = Array.from(byId.values());
    const nextServices = servicesList.map((service) => ({
      ...service,
      assignedStaffIds: service.assignedStaffIds.filter((id) => !importedIds.has(id)),
    }));

    for (const record of records) {
      const assignedNames = new Set(record.assignedServiceNames.map((name) => name.toLowerCase()));
      for (const service of nextServices) {
        if (assignedNames.has(service.name.toLowerCase()) && !service.assignedStaffIds.includes(record.staff.id)) {
          service.assignedStaffIds.push(record.staff.id);
        }
      }
    }

    setStaffList(nextStaff);
    saveStaff(nextStaff);
    setServicesList(nextServices);
    saveServices(nextServices);
    return { added, updated, skipped, errors: [] };
  };

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 20 }}>

      {(showAdd || editingStaff) && (
        <StaffFormModal
          servicesList={servicesList}
          staffList={staffList}
          staff={editingStaff ?? undefined}
          onClose={() => { setShowAdd(false); setEditingStaff(null); }}
          onSave={handleSaveStaff}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          name={deleteTarget.name}
          onConfirm={() => handleDeleteStaff(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {showImport && (
        <StaffImportModal
          existing={staffList}
          servicesList={servicesList}
          onClose={() => setShowImport(false)}
          onImport={handleImportStaff}
        />
      )}

      {/* Native mobile app bar */}
      <MobilePageHeader
        title="Staff"
        subtitle={`${staffList.length} team members`}
        action={{ label: staffLimited ? "Limit reached" : "Add", icon: <Plus size={14} />, onClick: () => !staffLimited && setShowAdd(true) }}
      />

      {/* Header */}
      <div className="dashboard-topbar page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <PageTitle
          icon={<UserCog size={24} />}
          title="Staff"
          subtitle={
            <>
            {staffList.length} team members
            {plan.staffLimit !== -1 && <span style={{ marginLeft: 8, color: staffLimited ? "#dc2626" : "#b0b0c8", fontWeight: 700 }}>· {activeCount}/{plan.staffLimit} active</span>}
            </>
          }
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => setShowImport(true)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 12, border: "1px solid #e3e0eb", background: "#fff", fontSize: 13, fontWeight: 750, color: "#6b6b8a", cursor: "pointer", transition: "all 0.18s ease" }}
            className="hover-bg-light"
          >
            <Upload size={15} /> Import
          </button>
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowExportMenu((open) => !open)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 12, border: "1px solid #bbf7d0", background: "#f0fdf4", fontSize: 13, fontWeight: 750, color: "#059669", cursor: "pointer", transition: "all 0.18s ease" }}
            >
              <Download size={15} /> Export <ChevronDown size={12} style={{ transform: showExportMenu ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
            </button>
            {showExportMenu && (
              <>
                <div onClick={() => setShowExportMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
                <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 20, width: 188, background: "#fff", border: "1px solid #e8e8f0", borderRadius: 12, boxShadow: "0 12px 34px rgba(16, 24, 40, 0.12)", padding: 6 }}>
                  {[
                    { fmt: "xlsx" as const, label: "Excel (.xlsx)" },
                    { fmt: "csv" as const, label: "CSV (.csv)" },
                  ].map(({ fmt, label }) => (
                    <button key={fmt} onClick={() => { setShowExportMenu(false); exportStaff(visibleStaff, servicesList, fmt); }}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", border: "none", background: "transparent", borderRadius: 8, fontSize: 12, fontWeight: 700, color: "#1a1a2e", cursor: "pointer", textAlign: "left" }} className="hover-bg-light">
                      <FileSpreadsheet size={14} color="#059669" /> {label}
                    </button>
                  ))}
                  <div style={{ padding: "7px 10px 4px", fontSize: 10, color: "#9898b0", borderTop: "1px solid #f0f0f8", marginTop: 4 }}>Exports {visibleStaff.length} visible staff</div>
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => !staffLimited && setShowAdd(true)}
            title={staffLimited ? `Free plan: ${plan.staffLimit} active staff limit reached. Upgrade to Pro for unlimited.` : ""}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 12, border: "none", background: staffLimited ? "#e8e8f0" : "var(--accent-gradient)", fontSize: 13, fontWeight: 750, color: staffLimited ? "#aaaabc" : "#fff", boxShadow: staffLimited ? "none" : "0 4px 14px var(--accent-glow)", cursor: staffLimited ? "not-allowed" : "pointer", transition: "all 0.18s ease" }}
            className={!staffLimited ? "page-header-btn" : ""}
          >
            <Plus size={16} /> Add Staff
            {staffLimited && <span style={{ fontSize: 10, background: "#dc2626", color: "#fff", borderRadius: 20, padding: "1px 7px" }}>Limit reached</span>}
          </button>
        </div>
      </div>

      {/* Free-plan staff limit banner */}
      {staffLimited && (
        <div style={{
          padding: "14px 20px",
          borderRadius: 14,
          background: "#fef2f2",
          border: "1px solid #fecaca",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          boxShadow: "0 4px 12px rgba(220,38,38,0.03)"
        }}>
          <span style={{ fontSize: 13, color: "#991b1b", fontWeight: 700 }}>
            Free plan allows up to {plan.staffLimit} active staff members. Deactivate a member or upgrade to add more.
          </span>
          <a href="/dashboard/billing" style={{ fontSize: 11, fontWeight: 800, color: "#7C3AED", textDecoration: "none", whiteSpace: "nowrap", background: "#fff", border: "1px solid rgba(124,58,237,0.15)", borderRadius: 8, padding: "6px 12px", boxShadow: "0 2px 6px rgba(0,0,0,0.02)", transition: "all 0.15s" }} className="hover-bg-light">Upgrade Plan</a>
        </div>
      )}

      {/* Section filter — locked to the active dashboard section when one is
          set; the only way to see another section's staff is to switch the
          global "Active Section" control, not from this page. */}
      {getActiveSection() !== "all" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-start", padding: "8px 14px", borderRadius: 12, background: "#f5f3ff", border: "1px solid #ddd6fe" }}>
          <Lock size={13} color="#7C3AED" />
          <span style={{ fontSize: 12, fontWeight: 750, color: "#7C3AED" }}>Showing {getActiveSection()} + unassigned staff</span>
        </div>
      ) : (() => {
        const sectionTabs = ["all", ...getSectionOptions(staffList)];
        return (
          <div className="filter-tabs" style={{ display: "flex", gap: 6, background: "#f4f4f9", border: "1px solid #e3e0eb", borderRadius: 12, padding: 4, alignSelf: "flex-start", marginBottom: 4 }}>
            {sectionTabs.map((sec) => {
              const active = sectionFilter === sec;
              return (
                <button key={sec} onClick={() => setSectionFilter(sec)}
                  style={{
                    padding: "7px 16px",
                    borderRadius: 9,
                    border: "none",
                    background: active ? "var(--accent-gradient)" : "transparent",
                    color: active ? "#fff" : "#6b6b8a",
                    fontSize: 13,
                    fontWeight: 750,
                    cursor: "pointer",
                    boxShadow: active ? "0 4px 10px var(--accent-glow)" : "none",
                    transition: "all 0.18s ease"
                  }}>
                  {sec === "all" ? "All Sections" : sec}
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* Cards grid */}
      <div className="cards-grid-auto">
        {visibleStaff.map((s) => {
          const stats = getStaffStats(s, appointmentsList, servicesList, invoicesList);
          const role  = ROLE_COLORS[s.role] ?? { color: "#6b7280", bg: "#f9fafb" };
          return (
            <div
              key={s.id}
              onClick={() => router.push(`/dashboard/staff/${s.id}`)}
              style={{ background: "#fff", padding: "24px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 16 }}
            >
              {/* Top row */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 48, height: 48, borderRadius: "50%", background: s.color + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: s.color, border: "1.5px solid rgba(255,255,255,0.8)", boxShadow: "0 2px 4px rgba(0,0,0,0.04)" }}>
                    {s.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15, color: "#1a1a2e", letterSpacing: "-0.01em" }}>{s.name}</div>
                    <span style={{ display: "inline-block", fontSize: 10, fontWeight: 800, color: role.color, background: role.bg, padding: "2px 8px", borderRadius: 20, textTransform: "capitalize", marginTop: 4 }}>
                      {s.role.replace(/-/g, " ")}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 10,
                    fontWeight: 800,
                    color: s.isActive ? "#059669" : "#dc2626",
                    background: s.isActive ? "#ecfdf5" : "#fef2f2",
                    padding: "3px 8px",
                    borderRadius: 20
                  }}>
                    <span style={{ width: 4, height: 4, borderRadius: "50%", background: s.isActive ? "#059669" : "#dc2626" }} />
                    {s.isActive ? "Active" : "Inactive"}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingStaff(s); }}
                    aria-label={`Edit ${s.name}`}
                    style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #EDE9FE", background: "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}
                    className="hover-bg-light"
                  >
                    <Pencil size={13} color="#7C3AED" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(s); }}
                    aria-label={`Delete ${s.name}`}
                    style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #fee2e2", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}
                  >
                    <Trash2 size={13} color="#dc2626" />
                  </button>
                </div>
              </div>

              {/* Specialties */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {s.specialties.length > 0
                  ? s.specialties.slice(0, 3).map((sp) => (
                    <span key={sp} style={{ fontSize: 11, fontWeight: 600, color: s.color, background: s.color + "10", padding: "3px 10px", borderRadius: 12 }}>{sp}</span>
                  ))
                  : <span style={{ fontSize: 11, color: "#9898b0", fontStyle: "italic", fontWeight: 500 }}>No specialties</span>}
              </div>

              {/* Stats + view profile CTA */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, borderTop: "1px solid #f8f8fc", paddingTop: 14, alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 10, color: "#9898b0", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em" }}>Appointments</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: "#1a1a2e", marginTop: 4 }}>{stats.total}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#9898b0", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em" }}>Revenue</div>
                  <div style={{ fontSize: 14, fontWeight: 900, color: "var(--accent)", marginTop: 4 }}>{fmt(stats.revenue)}</div>
                  {stats.upsoldValue > 0 && (
                    <div style={{ fontSize: 10, color: "#b45309", fontWeight: 700, marginTop: 2 }}>
                      {fmt(stats.upsoldValue)} upsold
                      {stats.upsellIncentive > 0 && ` · ${fmt(stats.upsellIncentive)} incentive`}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: "50%", background: "#f0eeff", transition: "transform 0.15s" }} className="hover-scale">
                  <ChevronRight size={14} color="#7C3AED" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
