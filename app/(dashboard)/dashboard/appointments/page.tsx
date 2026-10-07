"use client";

import { appointmentStaffIds } from "@/lib/appointment-staff";
import { resolveGuestClientIds, creditsFromAppointments, applyClientCredits } from "@/lib/appointment-credit";
import { useState, useMemo, useEffect, useRef } from "react";
import { getStoredAppointments, saveAppointments, getStoredClients, saveClients, getStoredStaff, getStoredServices } from "@/lib/storage";
import { getSalonInvoices, saveSalonInvoices } from "@/lib/salon-invoices";
import { recordDeletions } from "@/lib/turso-sync";
import type { Appointment, AppointmentFeedback, AppointmentStatus, Client, Staff, Service } from "@/lib/types";
import { Search, Filter, X, Clock, User, Users, Scissors, Tag, ChevronDown, Plus, CalendarDays, CheckCircle2, ArrowRight, ShoppingCart, Camera, Trash2, Upload, Download, FileSpreadsheet, Check, Star, AlertTriangle, MessageSquare } from "lucide-react";
import { enqueueWhatsAppConfirmation, enqueueWhatsAppFollowup, enqueueWhatsAppCancellation, sendGroupBookingAlert, purgeQueuedAppointmentMessages, normalizePhone, resendWhatsAppConfirmation } from "@/lib/whatsapp-scheduler";
import { awardPoints } from "@/lib/loyalty";
import { settingsStore } from "@/lib/settings-store";
import { getCurrentPlan, isAtLimit, thisMonthCount } from "@/lib/plan-limits";
import { getSectionOptions, getActiveSection, inSection } from "@/lib/sections";
import PageTitle from "@/components/page-title";
import MobilePageHeader from "@/components/mobile-page-header";
import { PaymentProofBadge, PaymentProofSection, usePaymentProofs } from "@/components/payment-proof";
import type { PaymentProofMeta } from "@/lib/payment-proofs";

const STATUS: Record<AppointmentStatus, { label: string; color: string; bg: string }> = {
  booked:        { label: "Booked",      color: "#6366f1", bg: "#EEF2FF" },
  confirmed:     { label: "Confirmed",   color: "#059669", bg: "#ecfdf5" },
  arrived:       { label: "Arrived",     color: "#9333EA", bg: "#F5F3FF" },
  "in-progress": { label: "In Progress", color: "#d97706", bg: "#fffbeb" },
  completed:     { label: "Completed",   color: "#16a34a", bg: "#f0fdf4" },
  "no-show":     { label: "No Show",     color: "#dc2626", bg: "#fef2f2" },
  cancelled:     { label: "Cancelled",   color: "#6b7280", bg: "#f9fafb" },
};

const ALL_STATUSES = Object.keys(STATUS) as AppointmentStatus[];

import { fmtCurrency as fmt } from "@/lib/format";
import { TimeSelect } from "@/components/time-select";
import { returnToStock, settleServiceConsumption, settledConsumption } from "@/lib/inventory-consumption";

function fmtDate(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${ampm}`;
}

function appointmentCreatedAt(appt: Appointment): Date | null {
  if (appt.createdAt?.includes("T")) {
    const parsed = new Date(appt.createdAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const idTimestamp = /^a_(\d{13})/.exec(appt.id)?.[1];
  if (idTimestamp) {
    const parsed = new Date(Number(idTimestamp));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (appt.createdAt) {
    const parsed = new Date(appt.createdAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function fmtCreatedAt(appt: Appointment) {
  const createdAt = appointmentCreatedAt(appt);
  if (!createdAt) return "—";
  return createdAt.toLocaleString("en-PK", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Karachi",
  });
}

function toMin(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function addMinutes(timeStr: string, mins: number): string {
  const [h, m] = timeStr.split(":").map(Number);
  const totalMins = h * 60 + m + mins;
  const newH = Math.floor(totalMins / 60) % 24;
  const newM = totalMins % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

const selectStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e",
  outline: "none", background: "#fff",
};

// ── Import / Export ────────────────────────────────────────────────────────────
const APPOINTMENT_EXPORT_COLS = [
  "Appointment ID", "Date", "Start Time", "End Time", "Client Name", "Client Phone",
  "Staff Name", "Services", "Status", "Total Amount", "Notes", "Source", "Created At",
];

type AppointmentImportRecord = {
  appt: Appointment;
  mode: "add" | "update";
  matchedClient: boolean;
  matchedStaff: boolean;
  unmatchedServiceNames: string[];
};
type AppointmentImportResult = { added: number; updated: number; skipped: number; errors: string[] };

function splitList(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeStatus(value: unknown): AppointmentStatus {
  const raw = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return (ALL_STATUSES as string[]).includes(raw) ? (raw as AppointmentStatus) : "booked";
}

function normalizeSource(value: unknown): Appointment["source"] {
  const raw = String(value ?? "").trim().toLowerCase();
  const allowed: Appointment["source"][] = ["whatsapp", "walk-in", "web", "manual", "agent"];
  return (allowed as string[]).includes(raw) ? (raw as Appointment["source"]) : "manual";
}

function appointmentsToRows(list: Appointment[], clients: Client[]) {
  const phoneByClientId = new Map(clients.map((c) => [c.id, c.phone]));
  return list.map((a) => ({
    "Appointment ID": a.id,
    "Date": a.date,
    "Start Time": a.startTime,
    "End Time": a.endTime,
    "Client Name": a.clientName,
    "Client Phone": phoneByClientId.get(a.clientId) ?? "",
    "Staff Name": a.staffName,
    "Services": a.serviceNames.join(", "),
    "Status": STATUS[a.status]?.label ?? a.status,
    "Total Amount": a.totalAmount,
    "Notes": a.notes ?? "",
    "Source": a.source,
    "Created At": a.createdAt ?? "",
  }));
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportAppointments(list: Appointment[], clients: Client[], format: "xlsx" | "csv") {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(appointmentsToRows(list, clients), { header: APPOINTMENT_EXPORT_COLS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Appointments");
  const date = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const csv = XLSX.utils.sheet_to_csv(ws);
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `appointments-${date}.csv`);
  } else {
    XLSX.writeFile(wb, `appointments-${date}.xlsx`);
  }
}

// ── Import Modal ──────────────────────────────────────────────────────────────
function AppointmentImportModal({ existing, clients, staffList, services, onClose, onImport }: {
  existing: Appointment[];
  clients: Client[];
  staffList: Staff[];
  services: Service[];
  onClose: () => void;
  onImport: (records: AppointmentImportRecord[]) => AppointmentImportResult;
}) {
  const [step, setStep] = useState<"pick" | "preview" | "done">("pick");
  const [parsed, setParsed] = useState<AppointmentImportRecord[]>([]);
  const [result, setResult] = useState<AppointmentImportResult | null>(null);
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

      const byId = new Map(existing.map((a) => [a.id, a]));
      const clientByPhone = new Map(clients.filter((c) => c.phone).map((c) => [c.phone.replace(/\s/g, ""), c]));
      const clientByName = new Map(clients.map((c) => [c.name.trim().toLowerCase(), c]));
      const staffByName = new Map(staffList.map((s) => [s.name.trim().toLowerCase(), s]));
      const serviceByName = new Map(services.map((s) => [s.name.trim().toLowerCase(), s]));

      const records: AppointmentImportRecord[] = [];
      const usedIds = new Set(existing.map((a) => a.id));

      for (const row of rows) {
        const date = String(row["Date"] ?? row["date"] ?? "").trim();
        const startTime = String(row["Start Time"] ?? row["StartTime"] ?? row["start time"] ?? "").trim();
        if (!date || !startTime) continue;

        const rawId = String(row["Appointment ID"] ?? row["ID"] ?? row["id"] ?? "").trim();
        const existingAppt = rawId ? byId.get(rawId) : undefined;
        const id = existingAppt?.id ?? (rawId || `a_imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        if (!existingAppt && usedIds.has(id)) continue;
        usedIds.add(id);

        const clientPhone = String(row["Client Phone"] ?? row["Phone"] ?? "").trim();
        const clientName = String(row["Client Name"] ?? row["Client"] ?? "").trim();
        const matchedClientObj = (clientPhone && clientByPhone.get(clientPhone.replace(/\s/g, ""))) || (clientName && clientByName.get(clientName.toLowerCase())) || undefined;

        const staffName = String(row["Staff Name"] ?? row["Staff"] ?? "").trim();
        const matchedStaffObj = staffByName.get(staffName.toLowerCase());

        const serviceNamesRaw = splitList(row["Services"] ?? row["Service"]);
        const matchedServices = serviceNamesRaw.map((name) => serviceByName.get(name.toLowerCase())).filter((s): s is Service => Boolean(s));
        const unmatchedServiceNames = serviceNamesRaw.filter((name) => !serviceByName.has(name.toLowerCase()));

        const sumDuration = matchedServices.reduce((s, sv) => s + sv.durationMin, 0);
        const sumPrice = matchedServices.reduce((s, sv) => s + sv.price, 0);

        const rawEndTime = String(row["End Time"] ?? row["EndTime"] ?? "").trim();
        const endTime = rawEndTime || addMinutes(startTime, sumDuration || 30);

        const rawTotalText = String(row["Total Amount"] ?? row["Total"] ?? "").trim();
        const rawTotal = Number(rawTotalText);
        const totalAmount = rawTotalText !== "" && Number.isFinite(rawTotal) ? rawTotal : sumPrice;

        records.push({
          mode: existingAppt ? "update" : "add",
          matchedClient: Boolean(matchedClientObj),
          matchedStaff: Boolean(matchedStaffObj),
          unmatchedServiceNames,
          appt: {
            id,
            clientId: matchedClientObj?.id ?? existingAppt?.clientId ?? "",
            clientName: matchedClientObj?.name ?? clientName ?? existingAppt?.clientName ?? "",
            staffId: matchedStaffObj?.id ?? existingAppt?.staffId ?? "",
            staffName: matchedStaffObj?.name ?? staffName ?? existingAppt?.staffName ?? "",
            section: matchedStaffObj?.section ?? existingAppt?.section,
            serviceIds: matchedServices.length ? matchedServices.map((s) => s.id) : (existingAppt?.serviceIds ?? []),
            serviceNames: matchedServices.length ? matchedServices.map((s) => s.name) : (existingAppt?.serviceNames ?? serviceNamesRaw),
            date,
            startTime,
            endTime,
            status: normalizeStatus(row["Status"] ?? row["status"]),
            totalAmount,
            notes: String(row["Notes"] ?? row["notes"] ?? "").trim() || existingAppt?.notes,
            source: normalizeSource(row["Source"] ?? row["source"]),
            createdAt: existingAppt?.createdAt ?? new Date().toISOString(),
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
      "Appointment ID": "",
      "Date": "2026-08-01",
      "Start Time": "14:00",
      "End Time": "",
      "Client Name": "Ayesha Khan",
      "Client Phone": "923001234567",
      "Staff Name": "Sara Ahmed",
      "Services": "Haircut, Blowdry",
      "Status": "booked",
      "Total Amount": "",
      "Notes": "",
      "Source": "manual",
      "Created At": "",
    }];
    const ws = XLSX.utils.json_to_sheet(sample, { header: APPOINTMENT_EXPORT_COLS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Appointments Template");
    XLSX.writeFile(wb, "appointments-import-template.xlsx");
  }

  function confirmImport() {
    const importResult = onImport(parsed);
    setResult(importResult);
    setStep("done");
  }

  const addCount = parsed.filter((record) => record.mode === "add").length;
  const updateCount = parsed.filter((record) => record.mode === "update").length;
  const missingClientCount = parsed.filter((record) => !record.matchedClient).length;
  const missingStaffCount = parsed.filter((record) => !record.matchedStaff).length;
  const missingServiceCount = parsed.reduce((count, record) => count + record.unmatchedServiceNames.length, 0);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 540, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#5B21B6,#9333EA)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <FileSpreadsheet size={18} color="#fff" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Import Appointments</div>
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
                  ["Date", "Required, YYYY-MM-DD"], ["Start Time", "Required, HH:MM (24h)"], ["Client Name / Phone", "At least one, to match a client"], ["Staff Name", "Matched by name"],
                  ["Services", "Comma-separated service names"], ["Status", ALL_STATUSES.join(" / ")], ["Total Amount", "Optional — sums services if blank"], ["Source", "manual / walk-in / web / whatsapp / agent"],
                ].map(([col, hint]) => <div key={col}><strong>{col}</strong>: {hint}</div>)}
              </div>
            </div>
          </>
        )}

        {step === "preview" && (
          <>
            <div style={{ padding: "14px 16px", background: "#f8f7ff", border: "1px solid #e9d5ff", borderRadius: 12, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e" }}>{parsed.length} appointment{parsed.length === 1 ? "" : "s"} ready</div>
              <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 4 }}>
                {addCount} new, {updateCount} update{updateCount === 1 ? "" : "s"}
                {missingClientCount ? `, ${missingClientCount} unmatched client${missingClientCount === 1 ? "" : "s"}` : ""}
                {missingStaffCount ? `, ${missingStaffCount} unmatched staff` : ""}
                {missingServiceCount ? `, ${missingServiceCount} unmatched service${missingServiceCount === 1 ? "" : "s"}` : ""}
              </div>
            </div>
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid #f0f0f8", borderRadius: 12 }}>
              {parsed.slice(0, 8).map((record) => (
                <div key={record.appt.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid #f8f8fc" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{record.appt.clientName || "Unmatched client"}</div>
                    <div style={{ fontSize: 11, color: "#9898b0" }}>{record.appt.date} · {record.appt.startTime} · {record.appt.staffName || "Unassigned"}</div>
                  </div>
                  <span style={{ alignSelf: "center", fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "3px 8px", background: record.mode === "add" ? "#ecfdf5" : "#eff6ff", color: record.mode === "add" ? "#059669" : "#2563eb" }}>{record.mode === "add" ? "Add" : "Update"}</span>
                </div>
              ))}
              {parsed.length > 8 && <div style={{ padding: "10px 12px", fontSize: 12, color: "#9898b0" }}>+{parsed.length - 8} more</div>}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={() => setStep("pick")} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}>Back</button>
              <button onClick={confirmImport} disabled={parsed.length === 0} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: parsed.length ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 700, color: parsed.length ? "#fff" : "#b0b0c8", cursor: parsed.length ? "pointer" : "not-allowed" }}>Import Appointments</button>
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

// ── Shared sub-components ─────────────────────────────────────────────────────

function InfoRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ marginTop: 2 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
        <div style={{ fontSize: 13, color: "#1a1a2e" }}>{children}</div>
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
      {children}
    </div>
  );
}

function FilterSelect({ label, value, onChange, children, disabled }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: disabled ? "#faf9fd" : "#fff", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.75 : 1 }}>
        {children}
      </select>
    </div>
  );
}

// ── Detail Modal ──────────────────────────────────────────────────────────────

/**
 * Star rating. Read-only when `onChange` is omitted, so the same component
 * serves the editor in the detail modal and the badge in the list.
 */
function Stars({ value, onChange, size = 15 }: { value?: number; onChange?: (n: number) => void; size?: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const on = (value ?? 0) >= n;
        const star = <Star size={size} fill={on ? "#f59e0b" : "none"} color={on ? "#f59e0b" : "#d0d0e0"} />;
        if (!onChange) return <span key={n} style={{ display: "inline-flex" }}>{star}</span>;
        return (
          <button key={n} type="button" aria-label={`${n} star${n === 1 ? "" : "s"}`}
            // Clicking the current rating clears it — otherwise a mis-tapped star
            // can never be undone, and 1 star is not a neutral place to leave it.
            onClick={() => onChange(value === n ? 0 : n)}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "inline-flex" }}>
            {star}
          </button>
        );
      })}
    </span>
  );
}

/**
 * What the list rows show of a visit's feedback: the rating, and an unresolved
 * complaint. A complaint that has been dealt with is deliberately quiet — the
 * flag is there to be chased, so leaving it up after it is settled trains people
 * to ignore it.
 */
function FeedbackBadge({ feedback }: { feedback?: AppointmentFeedback }) {
  if (!feedback) return null;
  const openComplaint = !!feedback.complaint && !feedback.complaintResolved;
  if (!feedback.rating && !openComplaint) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 3 }}>
      {feedback.rating ? <Stars value={feedback.rating} size={11} /> : null}
      {openComplaint && (
        <span title={feedback.complaint} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, fontWeight: 800, color: "#dc2626", background: "#fef2f2", padding: "2px 6px", borderRadius: 20, whiteSpace: "nowrap" }}>
          <AlertTriangle size={9} /> COMPLAINT
        </span>
      )}
    </span>
  );
}

const FLOW_STEPS: AppointmentStatus[] = ["booked", "confirmed", "arrived", "in-progress", "completed"];

function DetailModal({ appt, onClose, clients, staffList, allServices, onStatusChange, onSaveFeedback, proof }: {
  appt: Appointment; onClose: () => void; clients: Client[]; staffList: Staff[];
  /** The customer's payment screenshot, when they sent one from the client app. */
  proof?: PaymentProofMeta;
  allServices: Service[]; onStatusChange: (apptId: string, status: AppointmentStatus) => void;
  onSaveFeedback: (apptId: string, feedback: AppointmentFeedback | undefined) => void;
}) {
  const [currentStatus, setCurrentStatus] = useState<AppointmentStatus>(appt.status);
  const [confirmSendStatus, setConfirmSendStatus] = useState<"idle" | "sending" | "sent" | "info" | "error">("idle");
  const [confirmSendNote, setConfirmSendNote] = useState("");
  const [rating, setRating] = useState(appt.feedback?.rating ?? 0);
  const [review, setReview] = useState(appt.feedback?.review ?? "");
  const [complaint, setComplaint] = useState(appt.feedback?.complaint ?? "");
  const [complaintResolved, setComplaintResolved] = useState(appt.feedback?.complaintResolved ?? false);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const cfg          = STATUS[currentStatus];
  const [photos, setPhotos] = useState<{ before?: string; after?: string }>({});
  // A ref (not state) so it latches synchronously — a rapid double-click/double-tap
  // on Cancel/No Show/Complete fires this handler twice before React re-renders to
  // hide the button (isTerminal only updates on the next render), which previously
  // could enqueue two separate WhatsApp sends for the same status change.
  const terminalLockRef = useRef(false);

  const handlePhotoUpload = (side: "before" | "after", file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => setPhotos((p) => ({ ...p, [side]: e.target?.result as string }));
    reader.readAsDataURL(file);
  };
  const staff        = staffList.find((s) => s.id === appt.staffId);
  const services     = allServices.filter((s) => appt.serviceIds.includes(s.id));
  const teamStaffIds = Array.from(new Set(services.filter((s) => s.multiStylist && s.assignedStaffIds.length >= 2).flatMap((s) => s.assignedStaffIds)));
  const teamStaff    = teamStaffIds.map((sid) => staffList.find((s) => s.id === sid)).filter((s): s is Staff => Boolean(s));
  const bookedStaff  = appointmentStaffIds(appt).map((sid, i) =>
    staffList.find((s) => s.id === sid) ?? { id: sid, name: appt.staffNames?.[i] ?? "Stylist", color: undefined }
  );
  const client       = clients.find((c) => c.id === appt.clientId);
  const durationMin  = toMin(appt.endTime) - toMin(appt.startTime);
  const flowIdx      = FLOW_STEPS.indexOf(currentStatus);
  const nextStep     = flowIdx !== -1 && flowIdx < FLOW_STEPS.length - 1 ? FLOW_STEPS[flowIdx + 1] : null;
  const isTerminal   = ["completed", "cancelled", "no-show"].includes(currentStatus);

  function saveFeedback() {
    const trimmedReview = review.trim();
    const trimmedComplaint = complaint.trim();
    // Clearing every field removes the record rather than storing an empty one,
    // so "has feedback" stays a simple presence check everywhere else.
    const hasAnything = rating > 0 || trimmedReview || trimmedComplaint;
    onSaveFeedback(appt.id, hasAnything ? {
      rating: rating > 0 ? rating : undefined,
      review: trimmedReview || undefined,
      complaint: trimmedComplaint || undefined,
      complaintResolved: trimmedComplaint ? complaintResolved : undefined,
      recordedAt: new Date().toISOString(),
    } : undefined);
    setFeedbackSaved(true);
    window.setTimeout(() => setFeedbackSaved(false), 2000);
  }

  function changeStatus(newStatus: AppointmentStatus) {
    if (terminalLockRef.current) return;
    if (["completed", "cancelled", "no-show"].includes(newStatus)) terminalLockRef.current = true;
    setCurrentStatus(newStatus);
    onStatusChange(appt.id, newStatus);
  }

  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 480, maxHeight: "92vh", overflowY: "auto", overflowX: "hidden", boxShadow: "0 24px 70px rgba(0,0,0,0.22)" }}>

        {/* Header */}
        <div style={{ background: `linear-gradient(135deg, ${cfg.color}18, ${cfg.color}08)`, padding: "20px 24px 18px", borderBottom: `2px solid ${cfg.color}22`, position: "relative" }}>
          <button onClick={onClose} style={{ position: "absolute", top: 14, right: 14, background: "rgba(0,0,0,0.06)", border: "none", cursor: "pointer", padding: 6, borderRadius: 8, display: "flex" }}>
            <X size={16} color="#6b6b8a" />
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: `linear-gradient(135deg, ${cfg.color}33, ${cfg.color}18)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800, color: cfg.color, flexShrink: 0 }}>
              {appt.clientName.charAt(0)}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 800, fontSize: 18, color: "#1a1a2e" }}>{appt.clientName}</div>
                {(appt.guests?.length ?? 0) > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", color: "#be185d", background: "#fdf2f8", border: "1px solid #fbcfe8", padding: "3px 9px", borderRadius: 20, letterSpacing: "0.04em" }}>
                    Family booking · {appt.guests!.length + 1} people
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#9898b0", marginTop: 2 }}>
                {client?.phone && <span>{client.phone} · </span>}
                {fmtDate(appt.date)} · {fmtTime(appt.startTime)}–{fmtTime(appt.endTime)}
              </div>
            </div>
          </div>

          {/* Manual booking-confirmation send — for when staff want it sent
              right now rather than waiting on (or in place of) the automatic
              one already queued at booking time. On a multi-day booking this
              sends each day's own confirmation, one WhatsApp message per day,
              matching how they were queued when the booking was made. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={confirmSendStatus === "sending"}
              onClick={async () => {
                setConfirmSendStatus("sending");
                setConfirmSendNote("");
                const groupIds = appt.bookingGroupId
                  ? getStoredAppointments().filter((a) => a.bookingGroupId === appt.bookingGroupId).map((a) => a.id)
                  : [appt.id];
                const results = await Promise.all(groupIds.map((id) => resendWhatsAppConfirmation(id)));
                const queued = results.filter((r) => r === "queued").length;
                const already = results.filter((r) => r === "already-sent").length;
                if (queued > 0) {
                  setConfirmSendStatus("sent");
                  setConfirmSendNote(
                    groupIds.length > 1
                      ? `Sending ${queued} of ${groupIds.length} day${groupIds.length > 1 ? "s" : ""}${already > 0 ? ` (${already} already sent)` : ""} shortly.`
                      : "Will send shortly."
                  );
                } else if (already === results.length) {
                  setConfirmSendStatus("info");
                  setConfirmSendNote("Already sent.");
                } else {
                  const reason = results.find((r) => r !== "queued" && r !== "already-sent");
                  setConfirmSendStatus("error");
                  setConfirmSendNote(
                    reason === "no-phone" ? "No phone number on file."
                    : reason === "disabled" ? "WhatsApp automation is off in Settings."
                    : reason === "not-found" ? "Appointment not found."
                    : "Couldn't send — check Settings → WhatsApp."
                  );
                }
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: "1px solid #ddd6fe", background: "#f5f3ff", color: "#7C3AED", fontSize: 12, fontWeight: 700, cursor: confirmSendStatus === "sending" ? "default" : "pointer", opacity: confirmSendStatus === "sending" ? 0.6 : 1 }}>
              <MessageSquare size={13} />
              {confirmSendStatus === "sending" ? "Sending…" : (appt.totalDays ?? 1) > 1 ? `Send Confirmation (${appt.totalDays} days)` : "Send Confirmation"}
            </button>
            {confirmSendNote && (
              <span style={{ fontSize: 11, fontWeight: 600, color: confirmSendStatus === "error" ? "#dc2626" : confirmSendStatus === "info" ? "#9898b0" : "#059669" }}>
                {confirmSendNote}
              </span>
            )}
          </div>

          {/* Linear stepper */}
          <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
            {FLOW_STEPS.map((step, i) => {
              const stepCfg  = STATUS[step];
              const isDone   = flowIdx > i || (currentStatus === "completed" && i === FLOW_STEPS.length - 1);
              const isCurr   = flowIdx === i && !isTerminal;
              const isPast   = flowIdx > i;
              return (
                <div key={step} style={{ display: "flex", alignItems: "center", flex: i < FLOW_STEPS.length - 1 ? 1 : 0 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: "50%",
                      background: isDone || isCurr ? stepCfg.color : "#e8e8f0",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      border: isCurr ? `2px solid ${stepCfg.color}` : "2px solid transparent",
                      boxShadow: isCurr ? `0 0 0 3px ${stepCfg.color}28` : "none",
                      transition: "all 0.2s",
                    }}>
                      {isPast || (currentStatus === "completed" && step === "completed")
                        ? <CheckCircle2 size={14} color="#fff" />
                        : <div style={{ width: 8, height: 8, borderRadius: "50%", background: isCurr ? "#fff" : "#c8c8d8" }} />
                      }
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, color: isCurr ? stepCfg.color : isPast ? "#6b7280" : "#c8c8d8", textTransform: "capitalize", whiteSpace: "nowrap" }}>
                      {step === "in-progress" ? "In Progress" : step.charAt(0).toUpperCase() + step.slice(1)}
                    </span>
                  </div>
                  {i < FLOW_STEPS.length - 1 && (
                    <div style={{ flex: 1, height: 2, background: flowIdx > i ? cfg.color : "#e8e8f0", margin: "0 4px", marginBottom: 16, transition: "background 0.2s" }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Terminal badges */}
          {currentStatus === "no-show" && (
            <div style={{ marginTop: 8, display: "inline-block", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 20, padding: "3px 12px", fontSize: 11, fontWeight: 700, color: "#dc2626" }}>No Show</div>
          )}
          {currentStatus === "cancelled" && (
            <div style={{ marginTop: 8, display: "inline-block", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 20, padding: "3px 12px", fontSize: 11, fontWeight: 700, color: "#6b7280" }}>Cancelled</div>
          )}
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Info rows */}
          <InfoRow icon={<User size={14} color="#9898b0" />} label={teamStaff.length >= 2 ? "Stylist Team" : bookedStaff.length >= 2 ? "Stylists" : "Stylist"}>
            {teamStaff.length >= 2 ? (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                {teamStaff.map((s) => (
                  <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: s.color, display: "inline-block" }} />
                    {s.name}
                  </span>
                ))}
                <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#7C3AED", background: "#F5F3FF", padding: "2px 7px", borderRadius: 20, letterSpacing: "0.04em" }}>Team</span>
              </div>
            ) : bookedStaff.length >= 2 ? (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                {bookedStaff.map((s, i) => (
                  <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: s.color ?? "#ccc", display: "inline-block" }} />
                    {s.name}{i === 0 && <span style={{ fontSize: 10, color: "#9898b0" }}>(lead)</span>}
                  </span>
                ))}
              </div>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: staff?.color ?? "#ccc", display: "inline-block" }} />
                {appt.staffName || "—"}
              </span>
            )}
          </InfoRow>

          <InfoRow icon={<Scissors size={14} color="#9898b0" />} label="Services">
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {services.length > 0 ? (() => {
                // Split appt.totalAmount (the actual amount charged at booking
                // time) across services proportionally to their current catalog
                // prices, rather than showing each service's live catalog price
                // directly — a service's price can be edited after the
                // appointment was booked, and totalAmount is a snapshot that
                // never gets recalculated, so showing live prices here could add
                // up to a different number than "Total Amount" below.
                // Hand-set booking prices (servicePrices) weight the split when present.
                const weightOf = (sv: Service) => appt.servicePrices?.[appt.serviceIds.indexOf(sv.id)] ?? sv.price;
                const liveSum = services.reduce((s, sv) => s + weightOf(sv), 0);
                return services.map((sv) => (
                  <div key={sv.id} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{sv.name}</span>
                    <span style={{ color: "#7C3AED", fontWeight: 600 }}>
                      {fmt(liveSum > 0 ? appt.totalAmount * (weightOf(sv) / liveSum) : appt.totalAmount / services.length)}
                    </span>
                  </div>
                ));
              })() : appt.serviceNames.map((name) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{name}</span>
                </div>
              ))}
            </div>
          </InfoRow>

          {(appt.guests?.length ?? 0) > 0 && (
            <InfoRow icon={<Users size={14} color="#9898b0" />} label="Also in this booking">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {appt.guests!.map((g, gi) => (
                  <div key={`${g.name}-${gi}`}>
                    <div style={{ fontWeight: 700, color: "#1a1a2e" }}>{g.name}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 3 }}>
                      {g.serviceNames.map((n, i) => (
                        <div key={`${n}-${i}`} style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>{n}</span>
                          <span style={{ color: "#7C3AED", fontWeight: 600 }}>{fmt(g.servicePrices?.[i] ?? 0)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </InfoRow>
          )}

          {(appt.totalDays ?? 1) > 1 && (
            <InfoRow icon={<CalendarDays size={14} color="#9898b0" />} label="Booking">
              Day {appt.dayNumber} of {appt.totalDays}
            </InfoRow>
          )}

          <InfoRow icon={<Clock size={14} color="#9898b0" />} label="Duration">
            {fmtTime(appt.startTime)} – {fmtTime(appt.endTime)} <span style={{ color: "#9898b0", fontSize: 11 }}>({durationMin} min)</span>
          </InfoRow>

          {appt.notes && (
            <InfoRow icon={<Tag size={14} color="#9898b0" />} label="Notes">{appt.notes}</InfoRow>
          )}

          {proof && <PaymentProofSection appointmentId={appt.id} proof={proof} />}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#f9f8ff", borderRadius: 12, border: "1px solid #ede9fe" }}>
            <span style={{ fontSize: 13, color: "#6b6b8a", fontWeight: 600 }}>Total Amount</span>
            <span style={{ fontSize: 22, fontWeight: 900, color: "#7C3AED" }}>{fmt(appt.totalAmount)}</span>
          </div>

          {/* ── Before & After Photos ── */}
          {(currentStatus === "in-progress" || currentStatus === "completed") && (
            <div style={{ borderTop: "1px solid #f0f0f8", paddingTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                Before &amp; After Photos
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {(["before", "after"] as const).map((side) => (
                  <div key={side}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{side}</div>
                    {photos[side] ? (
                      <div style={{ position: "relative", borderRadius: 10, overflow: "hidden" }}>
                        <img src={photos[side]} alt={side} style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} />
                        <button
                          onClick={() => setPhotos((p) => ({ ...p, [side]: undefined }))}
                          style={{ position: "absolute", top: 5, right: 5, width: 22, height: 22, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                        >
                          <X size={11} color="#fff" />
                        </button>
                      </div>
                    ) : (
                      <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, height: 100, borderRadius: 10, border: "2px dashed #a78bfa", background: "#faf5ff", cursor: "pointer" }}>
                        <Camera size={18} color="#a78bfa" />
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#a78bfa" }}>Upload {side}</span>
                        <input type="file" accept="image/*" style={{ display: "none" }}
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhotoUpload(side, f); }} />
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Status workflow ── */}
          {!isTerminal && nextStep && (
            <div style={{ borderTop: "1px solid #f0f0f8", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.07em" }}>Update Status</div>

              {/* Primary next-step button */}
              <button type="button" onClick={() => changeStatus(nextStep)}
                style={{ width: "100%", padding: "13px 0", borderRadius: 12, border: "none", background: `linear-gradient(135deg, ${STATUS[nextStep].color}dd, ${STATUS[nextStep].color})`, color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: `0 4px 14px ${STATUS[nextStep].color}44` }}>
                <ArrowRight size={16} />
                Mark as {STATUS[nextStep].label}
              </button>

              {/* Skip / secondary actions */}
              <div style={{ display: "flex", gap: 8 }}>
                {FLOW_STEPS.filter(s => s !== currentStatus && s !== nextStep && !["completed"].includes(s)).map(s => (
                  <button key={s} type="button" onClick={() => changeStatus(s)}
                    style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: `1.5px solid ${STATUS[s].color}44`, background: STATUS[s].bg, color: STATUS[s].color, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    {STATUS[s].label}
                  </button>
                ))}
                <button type="button" onClick={() => changeStatus("no-show")}
                  style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: "1.5px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  No Show
                </button>
                <button type="button" onClick={() => changeStatus("cancelled")}
                  style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: "1.5px solid #e5e7eb", background: "#f9fafb", color: "#6b7280", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Completed state */}
          {currentStatus === "completed" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "#ecfdf5", borderRadius: 12, border: "1px solid #bbf7d0" }}>
              <CheckCircle2 size={18} color="#059669" />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#065f46" }}>Appointment Completed</div>
                <div style={{ fontSize: 11, color: "#047857", marginTop: 1 }}>Client stats updated · Follow-up WhatsApp queued</div>
              </div>
            </div>
          )}

          {/* Review & complaint — only once the visit has actually happened */}
          {currentStatus === "completed" && (
            <div style={{ border: "1px solid #ebebf0", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <MessageSquare size={15} color="#7C3AED" />
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>Customer Review &amp; Complaint</span>
                </div>
                {appt.feedback?.recordedAt && (
                  <span style={{ fontSize: 10, color: "#b0b0c8", fontWeight: 600 }}>
                    Recorded {new Date(appt.feedback.recordedAt).toLocaleDateString("en-PK", { day: "numeric", month: "short" })}
                  </span>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Rating</span>
                <Stars value={rating} onChange={setRating} size={20} />
                {rating > 0 && <span style={{ fontSize: 11, color: "#b0b0c8" }}>{rating}/5 · tap again to clear</span>}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Review</label>
                <textarea value={review} onChange={(e) => setReview(e.target.value)} rows={2}
                  placeholder="What the client said about the visit…"
                  style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", resize: "vertical", fontFamily: "inherit" }} />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Complaint</label>
                <textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} rows={2}
                  placeholder="Anything the client was unhappy about…"
                  style={{ padding: "9px 12px", borderRadius: 8, border: complaint.trim() ? "1px solid #fecaca" : "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", resize: "vertical", fontFamily: "inherit", background: complaint.trim() ? "#fffafa" : "#fff" }} />
                {complaint.trim() && (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={complaintResolved} onChange={(e) => setComplaintResolved(e.target.checked)}
                      style={{ width: 14, height: 14, accentColor: "#059669", cursor: "pointer" }} />
                    <span style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 600 }}>Resolved</span>
                  </label>
                )}
              </div>

              <button type="button" onClick={saveFeedback}
                style={{ alignSelf: "flex-start", padding: "8px 18px", borderRadius: 9, border: "none", background: feedbackSaved ? "#059669" : "#7C3AED", color: "#fff", fontSize: 12.5, fontWeight: 750, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                {feedbackSaved ? "Saved" : "Save Feedback"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Create Modal ──────────────────────────────────────────────────────────────

// Checkout is offered from the moment of booking (to take an advance) until the
// appointment has an invoice. Cancelled / no-show bookings have nothing to bill.
const CHECKOUT_STATUSES: AppointmentStatus[] = ["booked", "confirmed", "arrived", "in-progress", "completed"];

/** Before the client arrives, checkout means taking an advance — POS opens with it switched on. */
function checkoutHref(apptId: string, status: AppointmentStatus): string {
  const advance = status === "booked" || status === "confirmed";
  return `/dashboard/pos?appointmentId=${encodeURIComponent(apptId)}${advance ? "&advance=1" : ""}`;
}

/** " +2" when other stylists are booked alongside the lead, for compact rows. */
function extraStylistsLabel(appt: Appointment): string {
  const extra = appointmentStaffIds(appt).length - 1;
  return extra > 0 ? ` +${extra}` : "";
}

/** One day of a booking. A multi-day booking is saved as one appointment per day. */
type DayForm = {
  date: string; startTime: string; staffId: string; extraStaffIds: string[];
  serviceIds: string[]; prices: Record<string, string>;
  /** Related people seen in the same visit and billed together with the main client. */
  guests: { key: string; clientId?: string; name: string; phone: string; serviceIds: string[]; prices: Record<string, string> }[];
  /** Whose services the checklist is picking — "" is the main client. */
  activeGuestKey: string;
};

const MAX_BOOKING_DAYS = 30;
const emptyDay = (): DayForm => ({ date: "", startTime: "", staffId: "", extraStaffIds: [], serviceIds: [], prices: {}, guests: [], activeGuestKey: "" });

/** YYYY-MM-DD `n` days after `date`, in local time. */
function addDaysToDateKey(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The price typed for a service against one person, or its catalog price when left blank. */
function personServicePrice(prices: Record<string, string>, svc: Service): number {
  const raw = prices[svc.id];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : svc.price;
}

function CreateModal({ onClose, onAdd, clients, staffList, allServices }: { onClose: () => void; onAdd: (appts: Appointment[], newClients: Client[]) => void; clients: Client[]; staffList: Staff[]; allServices: Service[] }) {
  const [form, setForm] = useState({ clientId: "", notes: "" });
  const [days, setDays] = useState<DayForm[]>(() => [emptyDay()]);
  const [activeDay, setActiveDay] = useState(0);
  const day = days[activeDay] ?? days[0];
  const updateDay = (fn: (d: DayForm) => DayForm) =>
    setDays((ds) => ds.map((d, i) => (i === activeDay ? fn(d) : d)));
  const [done, setDone] = useState(false);
  const [createdApptId, setCreatedApptId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // useState updates aren't applied synchronously, so a fast double-click can fire
  // handleBook twice before React re-renders to disable the button — both calls
  // would then read the same stale `submitting === false`. A ref flips immediately,
  // so the second call sees it set within the same tick and bails out.
  const submittingRef = useRef(false);
  const [newClient, setNewClient] = useState(false);
  const [newClientForm, setNewClientForm] = useState({ name: "", phone: "", email: "", dob: "" });
  const [newClientSaved, setNewClientSaved] = useState(false);

  // Searchable client picker — typing filters the client list live and shows
  // matches, so staff never have to scroll a long native <select> to find someone.
  const [clientQuery, setClientQuery] = useState("");
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const clientBoxRef = useRef<HTMLDivElement>(null);

  // Keep the search box text in sync whenever a client gets selected from
  // outside a keystroke (picking a suggestion, or the duplicate-client flow in
  // the "new client" panel handing control back here). Deliberately does NOT
  // react to clientId being cleared — that happens on every keystroke below,
  // and re-syncing then would overwrite what the user is actively typing.
  useEffect(() => {
    if (form.clientId && form.clientId !== "__new__") {
      const c = clients.find((cl) => cl.id === form.clientId);
      if (c) setClientQuery(c.name);
    }
  }, [form.clientId, clients]);

  // Close the dropdown on an outside click rather than on blur, so clicking a
  // suggestion (which blurs the input first) still registers as a selection.
  useEffect(() => {
    if (!clientDropdownOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (clientBoxRef.current && !clientBoxRef.current.contains(e.target as Node)) {
        setClientDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [clientDropdownOpen]);

  const clientDisplayName = newClient
    ? newClientForm.name.trim()
    : clients.find((c) => c.id === form.clientId)?.name ?? "";
  const clientQueryTrimmed = clientQuery.trim().toLowerCase();
  const clientMatches = (clientQueryTrimmed
    ? clients.filter((c) => c.name.toLowerCase().includes(clientQueryTrimmed) || c.phone.includes(clientQueryTrimmed))
    : clients
  ).slice(0, 8);

  const pickClient = (c: Client) => {
    set("clientId", c.id);
    setClientQuery(c.name);
    setClientDropdownOpen(false);
  };

  const set = (k: string, v: string) => {
    if (k === "date") {
      // Later days still without a date follow on from this one, so a 3-day
      // booking only needs its first date picked.
      setDays((ds) => ds.map((d, i) =>
        i === activeDay ? { ...d, date: v }
          : i > activeDay && !d.date && v ? { ...d, date: addDaysToDateKey(v, i - activeDay) }
          : d));
    } else if (k === "staffId") {
      // The lead can't also be listed as an additional stylist.
      updateDay((d) => ({ ...d, staffId: v, extraStaffIds: d.extraStaffIds.filter((id) => id !== v) }));
    } else if (k === "startTime") {
      updateDay((d) => ({ ...d, [k]: v }));
    } else {
      setForm((f) => ({ ...f, [k]: v }));
    }
  };

  const changeDayCount = (n: number) => {
    const count = Math.max(1, Math.min(MAX_BOOKING_DAYS, Math.floor(n) || 1));
    setDays((ds) => {
      if (count <= ds.length) return ds.slice(0, count);
      const next = [...ds];
      while (next.length < count) {
        const prev = next[next.length - 1];
        next.push({ ...emptyDay(), date: prev.date ? addDaysToDateKey(prev.date, 1) : "", startTime: prev.startTime });
      }
      return next;
    });
    setActiveDay((a) => Math.min(a, count - 1));
  };

  const toggleExtraStylist = (staffId: string) =>
    updateDay((d) => ({
      ...d,
      extraStaffIds: d.extraStaffIds.includes(staffId) ? d.extraStaffIds.filter((id) => id !== staffId) : [...d.extraStaffIds, staffId],
    }));

  const setServicePrice = (serviceId: string, value: string) =>
    updateActivePerson((p) => ({ ...p, prices: { ...p.prices, [serviceId]: value } }));
  const setNC = (k: string, v: string) => setNewClientForm((f) => ({ ...f, [k]: v }));
  const canSaveNewClient = newClientForm.name.trim();

  // Suggest existing clients while typing a "new" client's name, so staff don't
  // accidentally create a duplicate record for someone already in the system.
  const nameQuery = newClientForm.name.trim().toLowerCase();
  const existingNameMatches = nameQuery.length >= 2
    ? clients.filter((c) => c.name.toLowerCase().includes(nameQuery)).slice(0, 5)
    : [];

  const selectExistingClient = (c: Client) => {
    setNewClient(false);
    setNewClientSaved(false);
    setNewClientForm({ name: "", phone: "", email: "", dob: "" });
    set("clientId", c.id);
  };

  // Services are the master control — the stylist is derived from what's selected, so
  // the checklist always shows the full catalog rather than narrowing by staffId.
  const availableServices = allServices;
  const [serviceQuery, setServiceQuery] = useState("");
  const serviceNeedle = serviceQuery.trim().toLowerCase();
  const visibleServices = serviceNeedle
    ? availableServices.filter((s) => s.name.toLowerCase().includes(serviceNeedle) || String(s.category ?? "").toLowerCase().includes(serviceNeedle))
    : availableServices;

  const lookupServices = (ids: string[]) =>
    ids.map((id) => allServices.find((s) => s.id === id)).filter((s): s is Service => Boolean(s));
  const servicesForDay = (d: DayForm) => lookupServices(d.serviceIds);
  /** Every service booked that day, the main client's and the guests'. */
  const allServicesForDay = (d: DayForm) => [...servicesForDay(d), ...d.guests.flatMap((g) => lookupServices(g.serviceIds))];
  const dayTotal = (d: DayForm) =>
    servicesForDay(d).reduce((sum, s) => sum + personServicePrice(d.prices, s), 0)
    + d.guests.reduce((sum, g) => sum + lookupServices(g.serviceIds).reduce((gs, s) => gs + personServicePrice(g.prices, s), 0), 0);
  const dayServiceCount = (d: DayForm) => d.serviceIds.length + d.guests.reduce((n, g) => n + g.serviceIds.length, 0);
  const dayIsComplete = (d: DayForm) => !!d.staffId && dayServiceCount(d) > 0 && !!d.date && !!d.startTime
    && d.guests.every((g) => g.name.trim() && g.serviceIds.length > 0);

  // The checklist below edits whichever person is selected on this day.
  const activeGuest = day.guests.find((g) => g.key === day.activeGuestKey);
  const activeServiceIds = activeGuest ? activeGuest.serviceIds : day.serviceIds;
  const activePrices = activeGuest ? activeGuest.prices : day.prices;
  const updateActivePerson = (fn: (p: { serviceIds: string[]; prices: Record<string, string> }) => { serviceIds: string[]; prices: Record<string, string> }) =>
    updateDay((d) => {
      if (!d.activeGuestKey) { const next = fn({ serviceIds: d.serviceIds, prices: d.prices }); return { ...d, ...next }; }
      return { ...d, guests: d.guests.map((g) => (g.key === d.activeGuestKey ? { ...g, ...fn({ serviceIds: g.serviceIds, prices: g.prices }) } : g)) };
    });

  const addGuest = () =>
    updateDay((d) => {
      const key = `g_${Date.now()}_${d.guests.length}`;
      return { ...d, guests: [...d.guests, { key, name: "", phone: "", serviceIds: [], prices: {} }], activeGuestKey: key };
    });
  const removeGuest = (key: string) =>
    updateDay((d) => ({ ...d, guests: d.guests.filter((g) => g.key !== key), activeGuestKey: d.activeGuestKey === key ? "" : d.activeGuestKey }));
  const setGuestName = (key: string, name: string) =>
    updateDay((d) => ({ ...d, guests: d.guests.map((g) => (g.key === key ? { ...g, name, clientId: clients.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())?.id } : g)) }));
  const setGuestPhone = (key: string, phone: string) =>
    updateDay((d) => ({ ...d, guests: d.guests.map((g) => (g.key === key ? { ...g, phone } : g)) }));
  const setActivePerson = (key: string) => updateDay((d) => ({ ...d, activeGuestKey: key }));

  // Stylist eligibility and duration cover everyone seen in the same visit.
  const selectedServices = allServicesForDay(day);
  const teamService = selectedServices.find((s) => s.multiStylist && s.assignedStaffIds.length >= 2);
  const isTeamBooking = !!teamService;
  const teamStaff = isTeamBooking
    ? teamService!.assignedStaffIds.map((sid) => staffList.find((s) => s.id === sid)).filter((s): s is Staff => Boolean(s))
    : [];
  /** Active stylists who can perform every currently-selected service. */
  const eligibleStaffIds = selectedServices.length > 0
    ? staffList.filter((s) => s.isActive && selectedServices.every((sv) => sv.assignedStaffIds.includes(s.id))).map((s) => s.id)
    : staffList.filter((s) => s.isActive).map((s) => s.id);

  // Selecting a service auto-assigns the stylist(s): the full team for a team service,
  // or the single eligible stylist when the chosen service(s) narrow it down to one.
  const toggleService = (id: string) =>
    updateDay((f) => {
      const current = f.activeGuestKey ? (f.guests.find((g) => g.key === f.activeGuestKey)?.serviceIds ?? []) : f.serviceIds;
      const nextIds = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
      const serviceIds = f.activeGuestKey ? f.serviceIds : nextIds;
      const guests = f.activeGuestKey ? f.guests.map((g) => (g.key === f.activeGuestKey ? { ...g, serviceIds: nextIds } : g)) : f.guests;
      const everyId = [...serviceIds, ...guests.flatMap((g) => g.serviceIds)];
      const selected = allServices.filter((s) => everyId.includes(s.id));
      const team = selected.find((s) => s.multiStylist && s.assignedStaffIds.length >= 2);
      let staffId = f.staffId;
      if (team) {
        staffId = team.assignedStaffIds[0];
      } else if (selected.length === 0) {
        staffId = "";
      } else if (!staffId) {
        // Suggest a stylist only when nobody's picked yet, and only when
        // exactly one is usually assigned to everything selected. Any stylist
        // can be picked by hand (see the dropdown below) — a manual choice is
        // never cleared just because a newly toggled service isn't in their
        // usual list.
        const eligible = staffList.filter((s) => s.isActive && selected.every((sv) => sv.assignedStaffIds.includes(s.id))).map((s) => s.id);
        if (eligible.length === 1) staffId = eligible[0];
      }
      return { ...f, serviceIds, guests, staffId, extraStaffIds: f.extraStaffIds.filter((id) => id !== staffId) };
    });
  const totalDuration = selectedServices.reduce((sum, s) => sum + s.durationMin, 0);
  const totalPrice = dayTotal(day);
  const grandTotal = days.reduce((sum, d) => sum + dayTotal(d), 0);
  const isMultiDay = days.length > 1;
  const canSubmit = (newClient ? newClientSaved : !!form.clientId) && days.every(dayIsComplete);

  const handleBook = () => {
    // Guards against a double-click/double-submit creating two separate
    // appointments (and two separate confirmation messages) for the same booking —
    // canSubmit alone doesn't change just because a submission is already in flight.
    // Checked via ref (not just the submitting state) because a fast double-click
    // can fire this handler twice before React commits the re-render that would
    // disable the button — the ref flips synchronously, the state doesn't.
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);

    let finalClientId = form.clientId;
    let finalClientName = "";
    let newClientObj: Client | undefined = undefined;

    if (newClient) {
      const newId = "c_" + Date.now();
      // Zero-initialized — credited below through the same map that credits an
      // existing main client and every guest, so nothing is counted twice.
      newClientObj = {
        id: newId,
        name: newClientForm.name.trim(),
        phone: normalizePhone(newClientForm.phone),
        email: newClientForm.email || undefined,
        dob: newClientForm.dob || undefined,
        gender: "female",
        tags: ["New"],
        source: "walk-in",
        createdAt: days[0].date || new Date().toISOString().split("T")[0],
        totalVisits: 0,
        totalSpend: 0,
        averageRating: 5.0,
      };
      finalClientId = newId;
      finalClientName = newClientForm.name;
    } else {
      const existing = clients.find((c) => c.id === form.clientId);
      finalClientName = existing?.name ?? "";
    }

    const now = Date.now();
    const bookingGroupId = isMultiDay ? `bg_${now}` : undefined;
    const source = newClient ? "walk-in" : (clients.find((c) => c.id === form.clientId)?.source ?? "walk-in");
    const createdAt = new Date().toISOString();

    // Every guest across every day resolves to a client id in one pass, so the
    // same person typed on two different days becomes one client record, not
    // two — dayIndex tags each entry so it can be matched back to its day below.
    const flatGuests = days.flatMap((d, di) => d.guests
      .filter((g) => g.name.trim() && g.serviceIds.length > 0)
      .map((g) => ({ ...g, dayIndex: di })));
    const { guests: resolvedGuests, newClients: newGuestClients } = resolveGuestClientIds(flatGuests, days[0].date || new Date().toISOString().split("T")[0]);

    const appts: Appointment[] = days.map((d, i) => {
      const staffObj = staffList.find((s) => s.id === d.staffId);
      // A team service already names its team through the service; extra
      // stylists only apply to an ordinary booking.
      const extras = servicesForDay(d).some((s) => s.multiStylist && s.assignedStaffIds.length >= 2)
        ? []
        : d.extraStaffIds.map((id) => staffList.find((s) => s.id === id)).filter((s): s is Staff => Boolean(s));
      const svcs = servicesForDay(d);
      const prices = svcs.map((s) => personServicePrice(d.prices, s));
      const guests = resolvedGuests
        .filter((g) => g.dayIndex === i)
        .map((g) => {
          const gsvcs = lookupServices(g.serviceIds);
          return {
            clientId: g.clientId!,
            name: g.name.trim(),
            serviceIds: gsvcs.map((s) => s.id),
            serviceNames: gsvcs.map((s) => s.name),
            servicePrices: gsvcs.map((s) => personServicePrice(g.prices, s)),
          };
        });
      return {
        id: i === 0 ? `a_${now}` : `a_${now}_${i + 1}`,
        clientId: finalClientId,
        clientName: finalClientName,
        staffId: d.staffId,
        staffName: staffObj?.name ?? "",
        section: staffObj?.section,
        ...(extras.length > 0 ? {
          staffIds: [d.staffId, ...extras.map((s) => s.id)],
          staffNames: [staffObj?.name ?? "", ...extras.map((s) => s.name)],
        } : {}),
        serviceIds: svcs.map((s) => s.id),
        serviceNames: svcs.map((s) => s.name),
        servicePrices: prices,
        date: d.date,
        startTime: d.startTime,
        endTime: addMinutes(d.startTime, allServicesForDay(d).reduce((sum, s) => sum + s.durationMin, 0)),
        status: "booked",
        ...(guests.length > 0 ? { guests } : {}),
        // Covers everyone on the booking — the main client pays the lot.
        totalAmount: dayTotal(d),
        source,
        notes: form.notes || undefined,
        createdAt,
        ...(bookingGroupId ? { bookingGroupId, dayNumber: i + 1, totalDays: days.length } : {}),
      };
    });

    try {
      onAdd(appts, [...(newClientObj ? [newClientObj] : []), ...newGuestClients]);
      setCreatedApptId(appts[0].id);
      setDone(true);
    } catch (error) {
      console.error("[appointments] Could not create appointment", error);
      // Booking creation must never be blocked by a non-critical side effect
      // such as WhatsApp scheduling. Keep the modal usable and visible.
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 380, maxWidth: "100%", padding: "48px 32px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 28 }}>✓</div>
          <div style={{ fontWeight: 700, fontSize: 18, color: "#1a1a2e", marginBottom: 8 }}>Appointment Created</div>
          <div style={{ fontSize: 13, color: "#9898b0", marginBottom: 24 }}>
            {isMultiDay
              ? `${days.length}-day booking saved — one appointment per day, ${fmt(grandTotal)} in total.`
              : "The appointment has been booked successfully."}
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {/* Straight to POS with this booking in the cart and Advance switched on,
                so the deposit is taken and billed while the client is still here. */}
            {createdApptId && (
              <a href={checkoutHref(createdApptId, "booked")} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 20px", borderRadius: 10, background: "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                <ShoppingCart size={14} /> Checkout
              </a>
            )}
            <button onClick={onClose} style={{ padding: "10px 32px", borderRadius: 10, background: createdApptId ? "#fff" : "#7C3AED", border: createdApptId ? "1px solid #e0e0ea" : "none", color: createdApptId ? "#4a4a6a" : "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 500, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>

        {/* Header */}
        <div style={{ padding: "22px 24px 18px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "#EDE9FE", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CalendarDays size={18} color="#7C3AED" />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>New Appointment</div>
              <div style={{ fontSize: 12, color: "#9898b0" }}>Fill in the details below</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 6, display: "flex" }}>
            <X size={18} color="#6b6b8a" />
          </button>
        </div>

        {/* Form */}
        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 18 }}>

          <FormField label="Client">
            {!newClient ? (
              <div style={{ display: "flex", gap: 8 }}>
                <div ref={clientBoxRef} style={{ position: "relative", flex: 1 }}>
                  <input
                    value={clientQuery}
                    onChange={(e) => {
                      const val = e.target.value;
                      setClientQuery(val);
                      setClientDropdownOpen(true);
                      // Auto-select once what's typed exactly matches exactly one
                      // client's name — no click needed for the common case of
                      // typing a known client's full name. Ambiguous (0 or 2+
                      // exact matches) falls back to picking from the list below.
                      const exact = clients.filter((c) => c.name.trim().toLowerCase() === val.trim().toLowerCase());
                      if (val.trim() && exact.length === 1) set("clientId", exact[0].id);
                      else if (form.clientId) set("clientId", "");
                    }}
                    onFocus={() => setClientDropdownOpen(true)}
                    placeholder="Select a client…"
                    style={{ ...selectStyle, width: "100%", boxSizing: "border-box", paddingRight: 32 }}
                  />
                  <ChevronDown size={15} color="#9898b0" style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
                  {clientDropdownOpen && (
                    <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#fff", border: "1px solid #e8e8f0", borderRadius: 8, boxShadow: "0 8px 20px rgba(0,0,0,0.1)", zIndex: 10, maxHeight: 240, overflowY: "auto" }}>
                      {clientMatches.length === 0 ? (
                        <div style={{ padding: "10px 12px", fontSize: 12, color: "#9898b0" }}>No clients match &quot;{clientQuery}&quot;.</div>
                      ) : clientMatches.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => pickClient(c)}
                          style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: form.clientId === c.id ? "#F5F3FF" : "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", gap: 1 }}
                          className="hover-bg-light"
                        >
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{c.name}</span>
                          <span style={{ fontSize: 11, color: "#9898b0" }}>{c.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { setNewClient(true); setNewClientSaved(false); set("clientId", "__new__"); }}
                  style={{ padding: "9px 14px", borderRadius: 8, border: "1px dashed #7C3AED", background: "#F5F3FF", fontSize: 12, fontWeight: 600, color: "#7C3AED", cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5 }}
                >
                  <Plus size={13} /> New
                </button>
              </div>
            ) : (
              <div style={{ border: "1px solid #EDE9FE", borderRadius: 10, padding: "14px", background: "#F5F3FF", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#7C3AED" }}>New Client</span>
                  <button type="button" onClick={() => { setNewClient(false); setNewClientSaved(false); set("clientId", ""); }} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", padding: 0 }}>
                    <X size={14} color="#9898b0" />
                  </button>
                </div>
                {newClientSaved ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#059669", fontWeight: 600 }}>
                    <span>✓</span> {newClientForm.name}{newClientForm.phone ? ` · ${newClientForm.phone}` : ""}
                  </div>
                ) : (
                  <>
                    <div style={{ position: "relative" }}>
                      <input value={newClientForm.name} onChange={(e) => setNC("name", e.target.value)} placeholder="Full name *"
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #e8e8f0", fontSize: 13, outline: "none", background: "#fff", boxSizing: "border-box" }} />
                      {existingNameMatches.length > 0 && (
                        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#fff", border: "1px solid #e8e8f0", borderRadius: 8, boxShadow: "0 8px 20px rgba(0,0,0,0.1)", zIndex: 10, overflow: "hidden" }}>
                          <div style={{ padding: "6px 10px", fontSize: 10, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #f0f0f8" }}>
                            Existing client{existingNameMatches.length > 1 ? "s" : ""} found
                          </div>
                          {existingNameMatches.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => selectExistingClient(c)}
                              style={{ width: "100%", textAlign: "left", padding: "8px 10px", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", gap: 1 }}
                              className="hover-bg-light"
                            >
                              <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{c.name}</span>
                              <span style={{ fontSize: 11, color: "#9898b0" }}>{c.phone}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <input value={newClientForm.phone} onChange={(e) => setNC("phone", e.target.value)} placeholder="Phone number (optional)"
                      style={{ padding: "8px 10px", borderRadius: 7, border: "1px solid #e8e8f0", fontSize: 13, outline: "none", background: "#fff" }} />
                    <input value={newClientForm.email} onChange={(e) => setNC("email", e.target.value)} placeholder="Email (optional)"
                      style={{ padding: "8px 10px", borderRadius: 7, border: "1px solid #e8e8f0", fontSize: 13, outline: "none", background: "#fff" }} />
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Date of Birth
                      <input type="date" value={newClientForm.dob} onChange={(e) => setNC("dob", e.target.value)}
                        style={{ padding: "8px 10px", borderRadius: 7, border: "1px solid #e8e8f0", fontSize: 13, outline: "none", background: "#fff", color: "#1a1a2e" }} />
                    </label>
                    <button
                      type="button"
                      onClick={() => canSaveNewClient && setNewClientSaved(true)}
                      style={{ padding: "8px 0", borderRadius: 8, border: "none", background: canSaveNewClient ? "#7C3AED" : "#e8e8f0", fontSize: 12, fontWeight: 600, color: canSaveNewClient ? "#fff" : "#b0b0c8", cursor: canSaveNewClient ? "pointer" : "not-allowed" }}
                    >
                      Save Client
                    </button>
                  </>
                )}
              </div>
            )}
          </FormField>

          <FormField label="Number of days">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid #e8e8f0", borderRadius: 10, overflow: "hidden" }}>
                <button type="button" aria-label="One day fewer" onClick={() => changeDayCount(days.length - 1)} disabled={days.length <= 1}
                  style={{ width: 38, height: 38, border: "none", background: "#fff", fontSize: 18, color: days.length <= 1 ? "#d0d0e0" : "#7C3AED", cursor: days.length <= 1 ? "not-allowed" : "pointer" }}>−</button>
                <input type="number" min={1} max={MAX_BOOKING_DAYS} value={days.length} onChange={(e) => { if (e.target.value !== "") changeDayCount(Number(e.target.value)); }} aria-label="Number of days"
                  style={{ width: 48, height: 38, border: "none", borderLeft: "1px solid #e8e8f0", borderRight: "1px solid #e8e8f0", textAlign: "center", fontSize: 14, fontWeight: 700, color: "#1a1a2e", outline: "none" }} />
                <button type="button" aria-label="One more day" onClick={() => changeDayCount(days.length + 1)} disabled={days.length >= MAX_BOOKING_DAYS}
                  style={{ width: 38, height: 38, border: "none", background: "#fff", fontSize: 18, color: "#7C3AED", cursor: "pointer" }}>+</button>
              </div>
              <span style={{ fontSize: 12, color: "#9898b0" }}>{isMultiDay ? "Set the date, stylist, services and prices for each day." : "Single-day appointment"}</span>
            </div>
          </FormField>

          {isMultiDay && (
            <div role="tablist" aria-label="Booking days" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
              {days.map((d, i) => {
                const active = i === activeDay;
                const complete = dayIsComplete(d);
                return (
                  <button key={i} type="button" role="tab" aria-selected={active} onClick={() => setActiveDay(i)}
                    style={{ flexShrink: 0, textAlign: "left", padding: "8px 12px", borderRadius: 10, cursor: "pointer", border: `1px solid ${active ? "#7C3AED" : "#e8e8f0"}`, background: active ? "#F5F3FF" : "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: active ? "#7C3AED" : "#1a1a2e" }}>
                      Day {i + 1}
                      <span title={complete ? "Complete" : "Needs date, time, stylist and a service"} style={{ width: 6, height: 6, borderRadius: "50%", background: complete ? "#059669" : "#f59e0b" }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#9898b0", whiteSpace: "nowrap" }}>
                      {d.date || "No date"} · {fmt(dayTotal(d))}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <FormField label={isTeamBooking ? "Stylist Team" : "Stylist"}>
            {isTeamBooking ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, border: "1px solid #EDE9FE", background: "#F5F3FF", borderRadius: 10, padding: "10px 12px" }}>
                  {teamStaff.map((s) => (
                    <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: s.color, display: "inline-block" }} />
                      {s.name}
                    </span>
                  ))}
                  <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#7C3AED", background: "#fff", padding: "2px 7px", borderRadius: 20, letterSpacing: "0.04em" }}>Team</span>
                </div>
                <div style={{ fontSize: 11, color: "#9898b0" }}>Auto-assigned — this service is done together by the full stylist team.</div>
              </div>
            ) : (
              <select
                value={day.staffId}
                onChange={(e) => set("staffId", e.target.value)}
                style={selectStyle}
              >
                <option value="">Select a stylist…</option>
                {/* Every active stylist can be picked — assignment to a service is a
                    hint for auto-selecting one when it's unambiguous, not a lock on
                    who's allowed to do the work. A stylist not usually assigned to
                    this service is still selectable, just labelled as such. */}
                {staffList.filter((s) => s.isActive).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.role.replace(/-/g, " ")}
                    {selectedServices.length > 0 && !eligibleStaffIds.includes(s.id) ? " (not usually assigned)" : ""}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          {!isTeamBooking && day.staffId && (
            <FormField label={`Additional stylists${day.extraStaffIds.length > 0 ? ` (${day.extraStaffIds.length})` : " (optional)"}`}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {staffList.filter((s) => s.isActive && s.id !== day.staffId).map((s) => {
                  const on = day.extraStaffIds.includes(s.id);
                  return (
                    <button key={s.id} type="button" aria-pressed={on} onClick={() => toggleExtraStylist(s.id)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 600, border: `1px solid ${on ? "#7C3AED" : "#e8e8f0"}`, background: on ? "#F5F3FF" : "#fff", color: on ? "#7C3AED" : "#4a4a6a" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color ?? "#ccc" }} />
                      {s.name}
                      {on && <Check size={12} />}
                    </button>
                  );
                })}
              </div>
              {day.extraStaffIds.length > 0 && (
                <div style={{ fontSize: 11, color: "#9898b0", marginTop: 6 }}>The booking shows on each stylist&apos;s calendar, and its revenue is split evenly between them for commission.</div>
              )}
            </FormField>
          )}

          {/* People sharing this appointment and its bill */}
          <FormField label="People in this appointment">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {[{ key: "", label: `${clientDisplayName || "Main client"} (main)`, count: day.serviceIds.length },
                ...day.guests.map((g) => ({ key: g.key, label: g.name.trim() || "Unnamed", count: g.serviceIds.length }))].map((person) => {
                const on = day.activeGuestKey === person.key;
                return (
                  <button key={person.key || "__main"} type="button" onClick={() => setActivePerson(person.key)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 600, border: `1px solid ${on ? "#7C3AED" : "#e8e8f0"}`, background: on ? "#F5F3FF" : "#fff", color: on ? "#7C3AED" : "#4a4a6a" }}>
                    {person.label}
                    <span style={{ fontSize: 10, color: "#9898b0" }}>{person.count} service{person.count === 1 ? "" : "s"}</span>
                  </button>
                );
              })}
              <button type="button" onClick={addGuest}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 12px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 700, border: "1px dashed #c4b5fd", background: "#fff", color: "#7C3AED" }}>
                <Plus size={12} /> Add person
              </button>
            </div>
            {day.guests.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                {day.guests.map((g) => (
                  <div key={g.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        value={g.name}
                        onChange={(e) => setGuestName(g.key, e.target.value)}
                        onFocus={() => setActivePerson(g.key)}
                        list="appt-guest-clients"
                        placeholder="Name (e.g. daughter, or pick a saved client)"
                        style={{ ...selectStyle, flex: 1 }} />
                      <button type="button" onClick={() => removeGuest(g.key)} aria-label={`Remove ${g.name || "person"}`}
                        style={{ border: "1px solid #f0e9ff", background: "#fff", borderRadius: 9, width: 38, height: 38, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <X size={14} color="#9898b0" />
                      </button>
                    </div>
                    {/* An existing client already has a phone on file — only ask for one
                        when this name doesn't match anybody, since it's about to become
                        a new client record. */}
                    {g.name.trim() && !g.clientId ? (
                      <input
                        value={g.phone}
                        onChange={(e) => setGuestPhone(g.key, e.target.value)}
                        onFocus={() => setActivePerson(g.key)}
                        placeholder="Phone number (optional)"
                        style={{ ...selectStyle, marginLeft: 0 }} />
                    ) : g.clientId ? (
                      <div style={{ fontSize: 11, color: "#059669", fontWeight: 600 }}>✓ Existing client</div>
                    ) : null}
                  </div>
                ))}
                <datalist id="appt-guest-clients">
                  {clients.slice(0, 200).map((c) => <option key={c.id} value={c.name} />)}
                </datalist>
                <div style={{ fontSize: 11, color: "#9898b0" }}>
                  Everyone is seen in this one appointment and billed on one invoice. The visit, spend and loyalty points go to the main client.
                </div>
              </div>
            )}
          </FormField>

          <FormField label={`Services${activeGuest ? ` for ${activeGuest.name.trim() || "this person"}` : ""}${activeServiceIds.length > 0 ? ` (${activeServiceIds.length} selected)` : ""}`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {availableServices.length > 0 && (
                <div style={{ position: "relative", marginBottom: 2 }}>
                  <Search size={14} color="#9898b0" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
                  <input
                    type="search"
                    value={serviceQuery}
                    onChange={(e) => setServiceQuery(e.target.value)}
                    placeholder="Search services…"
                    style={{ ...selectStyle, paddingLeft: 34 }}
                  />
                </div>
              )}
              {availableServices.length === 0 ? (
                <div style={{ fontSize: 13, color: "#b0b0c8", padding: "8px 0" }}>No services set up yet.</div>
              ) : visibleServices.length === 0 ? (
                <div style={{ fontSize: 13, color: "#b0b0c8", padding: "8px 0" }}>No services match “{serviceQuery.trim()}”.</div>
              ) : visibleServices.map((sv) => {
                const checked = activeServiceIds.includes(sv.id);
                const chargedPrice = personServicePrice(activePrices, sv);
                const isTeam = sv.multiStylist && sv.assignedStaffIds.length >= 2;
                const teamNames = isTeam ? sv.assignedStaffIds.map((sid) => staffList.find((s) => s.id === sid)?.name).filter(Boolean) : [];
                return (
                  <label key={sv.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "9px 12px", borderRadius: 8, border: `1px solid ${checked ? "#7C3AED" : "#e8e8f0"}`, background: checked ? "#F5F3FF" : "#fff", cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleService(sv.id)} style={{ accentColor: "#7C3AED", width: 14, height: 14 }} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 6 }}>
                            {sv.name}
                            {isTeam && (
                              <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#7C3AED", background: "#F5F3FF", padding: "2px 7px", borderRadius: 20, letterSpacing: "0.04em" }}>Team</span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: "#9898b0" }}>{sv.durationMin} min</div>
                        </div>
                      </div>
                      {checked ? (
                        // Editable once ticked, so a package or negotiated rate can be
                        // charged per service per day. Blank falls back to the list price.
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                          <input
                            type="number"
                            min={0}
                            inputMode="numeric"
                            value={activePrices[sv.id] ?? String(sv.price)}
                            onChange={(e) => setServicePrice(sv.id, e.target.value)}
                            aria-label={`Price for ${sv.name}`}
                            style={{ width: 100, padding: "6px 8px", borderRadius: 8, border: "1px solid #d8d0f8", background: "#fff", textAlign: "right", fontSize: 13, fontWeight: 600, color: "#7C3AED", outline: "none" }}
                          />
                          {chargedPrice !== sv.price && (
                            <span style={{ fontSize: 10, color: "#9898b0" }}>List {fmt(sv.price)}</span>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#7C3AED" }}>{fmt(sv.price)}</span>
                      )}
                    </div>
                    {isTeam && (
                      <div style={{ fontSize: 11, color: "#7C3AED", paddingLeft: 24 }}>Worked together by: {teamNames.join(", ")}</div>
                    )}
                  </label>
                );
              })}
            </div>
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FormField label="Date">
              {/* iPhone shows an empty date box with no hint, so overlay one until a date is picked. */}
              <div style={{ position: "relative" }}>
                <input type="date" value={day.date} onChange={(e) => set("date", e.target.value)} aria-label="Date" style={{ ...selectStyle, color: day.date ? "#1a1a2e" : "transparent" }} />
                {!day.date && (
                  <span className="date-placeholder" style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#9898b0", pointerEvents: "none" }}>Select date</span>
                )}
              </div>
            </FormField>
            <FormField label="Start Time">
              <TimeSelect value={day.startTime} onChange={(v) => set("startTime", v)} style={selectStyle} />
            </FormField>
          </div>

          <FormField label="Notes (optional)">
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Any special requests or notes…" rows={2} style={{ ...selectStyle, resize: "none", lineHeight: 1.5 }} />
          </FormField>

          {isMultiDay ? (
            <div style={{ background: "#F5F3FF", border: "1px solid #EDE9FE", borderRadius: 10, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
              {days.map((d, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b6b8a" }}>
                  <span>Day {i + 1}{d.date ? ` · ${d.date}` : ""} · {dayServiceCount(d)} service{dayServiceCount(d) === 1 ? "" : "s"}{d.guests.length > 0 ? ` · ${d.guests.length + 1} people` : ""}</span>
                  <span style={{ fontWeight: 600 }}>{fmt(dayTotal(d))}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #EDE9FE", paddingTop: 8, marginTop: 2 }}>
                <div style={{ fontSize: 12, color: "#7C3AED" }}>{days.length} days total</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#7C3AED" }}>{fmt(grandTotal)}</div>
              </div>
            </div>
          ) : dayServiceCount(day) > 0 && (
            <div style={{ background: "#F5F3FF", border: "1px solid #EDE9FE", borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 12, color: "#7C3AED" }}>{totalDuration} min total</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#7C3AED" }}>{fmt(totalPrice)}</div>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>
              Cancel
            </button>
            <button
              onClick={handleBook}
              disabled={!canSubmit || submitting}
              style={{ flex: 2, padding: "11px 0", borderRadius: 10, border: "none", background: canSubmit && !submitting ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 600, color: canSubmit && !submitting ? "#fff" : "#b0b0c8", cursor: canSubmit && !submitting ? "pointer" : "not-allowed" }}
            >
              {submitting ? "Booking…" : isMultiDay ? `Book ${days.length} Days` : "Book Appointment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Cancellations Tab ─────────────────────────────────────────────────────────

function CancellationsTab({ appointments, staffList, onReschedule, onSelect }: {
  appointments: Appointment[];
  staffList: Staff[];
  onReschedule: () => void;
  onSelect: (a: Appointment) => void;
}) {
  const cancelled = appointments
    .filter((a) => a.status === "cancelled" || a.status === "no-show")
    .sort((a, b) => b.date.localeCompare(a.date));

  const totalCancelled = cancelled.filter((a) => a.status === "cancelled").length;
  const totalNoShow    = cancelled.filter((a) => a.status === "no-show").length;
  const lostRevenue    = cancelled.reduce((s, a) => s + a.totalAmount, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {[
          { label: "Cancelled",    value: totalCancelled,  color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
          { label: "No Shows",     value: totalNoShow,     color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
          { label: "Lost Revenue", value: fmt(lostRevenue),color: "#7C3AED", bg: "#f5f3ff", border: "#ddd6fe" },
        ].map((s) => (
          <div key={s.label} style={{
            background: s.bg,
            border: `1px solid ${s.border}`,
            borderRadius: 16,
            padding: "16px 20px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.01)"
          }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: s.color, letterSpacing: "-0.02em" }}>{s.value}</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: s.color, opacity: 0.8, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 6 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* List */}
      <div style={{
        background: "#fff",
        borderRadius: 18,
        border: "1px solid rgba(226,223,235,.95)",
        boxShadow: "0 8px 28px rgba(38,25,75,.04)",
        overflow: "hidden"
      }}>
        {/* Desktop: dense grid table */}
        <div className="desktop-only">
        <div style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 130px 1.5fr 120px 110px 150px",
          padding: "12px 20px",
          borderBottom: "1px solid #f0f0f5",
          background: "#faf9fd"
        }}>
          {["CLIENT", "DATE", "SERVICE", "STYLIST", "STATUS", "ACTIONS"].map((h) => (
            <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em" }}>{h}</div>
          ))}
        </div>

        {cancelled.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "#b0b0c8", fontSize: 14 }}>
            No cancellations or no-shows yet.
          </div>
        ) : (
          cancelled.map((appt, i) => {
            const staff      = staffList.find((s) => s.id === appt.staffId);
            const isLast     = i === cancelled.length - 1;
            const isCancelled = appt.status === "cancelled";
            return (
              <div
                key={appt.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.2fr 130px 1.5fr 120px 110px 150px",
                  padding: "14px 20px",
                  borderBottom: isLast ? "none" : "1px solid #f8f8fc",
                  alignItems: "center",
                  transition: "background 0.2s"
                }}
                className="hover-bg-row"
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#6b6b8a", flexShrink: 0, border: "1.5px solid rgba(255,255,255,0.8)", boxShadow: "0 2px 4px rgba(0,0,0,0.04)" }}>
                    {appt.clientName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", letterSpacing: "-0.01em" }}>{appt.clientName}</div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, fontWeight: 500 }}>{fmt(appt.totalAmount)} lost</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, color: "#1a1a2e", fontWeight: 650 }}>{fmtDate(appt.date)}</div>
                  <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, display: "flex", alignItems: "center", gap: 3, fontWeight: 500 }}>
                    <Clock size={10} />
                    <span>{fmtTime(appt.startTime)}</span>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 550 }}>
                  {appt.serviceNames.join(", ")}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: staff?.color ?? "#ccc", flexShrink: 0, border: "1.5px solid rgba(255,255,255,0.8)", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }} />
                  <span style={{ fontSize: 13, color: "#1a1a2e", fontWeight: 600 }}>{appt.staffName.split(" ")[0]}{extraStylistsLabel(appt)}</span>
                </div>
                <div>
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 10,
                    fontWeight: 800,
                    color: isCancelled ? "#dc2626" : "#d97706",
                    background: isCancelled ? "#fef2f2" : "#fffbeb",
                    padding: "3px 10px",
                    borderRadius: 20
                  }}>
                    <span style={{ width: 4, height: 4, borderRadius: "50%", background: isCancelled ? "#dc2626" : "#d97706" }} />
                    {isCancelled ? "Cancelled" : "No Show"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => onSelect(appt)}
                    style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", fontSize: 11, fontWeight: 700, color: "#6b6b8a", cursor: "pointer", transition: "all 0.15s" }}
                    className="hover-bg-light"
                  >
                    View
                  </button>
                  <button
                    onClick={onReschedule}
                    style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "var(--accent-gradient)", fontSize: 11, fontWeight: 800, color: "#fff", cursor: "pointer", boxShadow: "0 2px 6px var(--accent-glow)", transition: "transform 0.15s" }}
                    className="hover-scale"
                  >
                    Reschedule
                  </button>
                </div>
              </div>
            );
          })
        )}
        </div>{/* /desktop-only */}

        {/* Mobile: stacked card list */}
        <div className="mobile-only">
          {cancelled.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#b0b0c8", fontSize: 14 }}>
              No cancellations or no-shows yet.
            </div>
          ) : (
            cancelled.map((appt, i) => {
              const staff = staffList.find((s) => s.id === appt.staffId);
              const isLast = i === cancelled.length - 1;
              const isCancelled = appt.status === "cancelled";
              return (
                <div key={appt.id} style={{ padding: "14px 16px", borderBottom: isLast ? "none" : "1px solid #f8f8fc", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#6b6b8a", flexShrink: 0 }}>
                      {appt.clientName.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{appt.clientName}</div>
                      <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{appt.serviceNames.join(", ")}</div>
                    </div>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 800, color: isCancelled ? "#dc2626" : "#d97706", background: isCancelled ? "#fef2f2" : "#fffbeb", padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}>
                      <span style={{ width: 4, height: 4, borderRadius: "50%", background: isCancelled ? "#dc2626" : "#d97706" }} />
                      {isCancelled ? "Cancelled" : "No Show"}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 44 }}>
                    <div style={{ fontSize: 11, color: "#9898b0", display: "flex", alignItems: "center", gap: 4, fontWeight: 500 }}>
                      <Clock size={10} />
                      <span>{fmtDate(appt.date)} · {fmtTime(appt.startTime)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#9898b0", fontWeight: 600 }}>{fmt(appt.totalAmount)} lost</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 44, gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: staff?.color ?? "#ccc", flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: "#4a4a6a", fontWeight: 600 }}>{appt.staffName.split(" ")[0]}{extraStylistsLabel(appt)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => onSelect(appt)}
                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", fontSize: 11, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}
                      >
                        View
                      </button>
                      <button
                        onClick={onReschedule}
                        style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "var(--accent-gradient)", fontSize: 11, fontWeight: 800, color: "#fff", cursor: "pointer" }}
                      >
                        Reschedule
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {cancelled.length > 0 && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid #eef0f5", background: "#faf9fd", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 750, color: "#6b6b8a" }}>{cancelled.length} records total</span>
            <span style={{ fontSize: 14, fontWeight: 900, color: "#dc2626" }}>− {fmt(lostRevenue)} lost revenue</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AppointmentsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | "all">("all");
  const [staffFilter, setStaffFilter] = useState<string>("all");
  const [sectionFilter, setSectionFilter] = useState<string>(() => getActiveSection());
  const [dateFilter, setDateFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<"apptDateDesc" | "apptDateAsc" | "createdDesc" | "createdAsc">("apptDateDesc");
  const [selected, setSelected] = useState<Appointment | null>(null);
  const paymentProofs = usePaymentProofs();
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [tab, setTab] = useState<"appointments" | "cancellations">("appointments");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [invoicedApptIds, setInvoicedApptIds] = useState<Set<string>>(new Set());

  const plan         = getCurrentPlan();
  const monthCount   = thisMonthCount(appointments);
  const apptLimited  = isAtLimit(plan.appointmentsPerMonth, monthCount);

  useEffect(() => {
    setAppointments(getStoredAppointments());
    setClients(getStoredClients());
    setStaffList(getStoredStaff());
    setServices(getStoredServices());
    // A multi-day booking is billed on one invoice linked to a single day, so
    // every day of that booking counts as invoiced.
    const invoiced = new Set(
      getSalonInvoices().filter((inv) => inv.appointmentId).map((inv) => inv.appointmentId as string)
    );
    const storedAppts = getStoredAppointments();
    const invoicedGroups = new Set(storedAppts.filter((a) => a.bookingGroupId && invoiced.has(a.id)).map((a) => a.bookingGroupId));
    for (const a of storedAppts) if (a.bookingGroupId && invoicedGroups.has(a.bookingGroupId)) invoiced.add(a.id);
    setInvoicedApptIds(invoiced);
  }, []);

  // Deep-link support: opening /dashboard/appointments?id=<apptId> (e.g. from the
  // "Today's Appointments" card on the main dashboard) auto-opens that appointment's
  // detail modal once its data has loaded.
  useEffect(() => {
    if (appointments.length === 0) return;
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    const appt = appointments.find((a) => a.id === id);
    if (appt) setSelected(appt);
  }, [appointments]);

  const filtered = useMemo(() => {
    return [...appointments]
      .sort((a, b) => {
        if (sortBy === "createdDesc" || sortBy === "createdAsc") {
          const aMs = appointmentCreatedAt(a)?.getTime() ?? 0;
          const bMs = appointmentCreatedAt(b)?.getTime() ?? 0;
          return sortBy === "createdDesc" ? bMs - aMs : aMs - bMs;
        }
        if (b.date !== a.date) return sortBy === "apptDateAsc" ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
        const aTime = a.startTime || "";
        const bTime = b.startTime || "";
        return sortBy === "apptDateAsc" ? aTime.localeCompare(bTime) : bTime.localeCompare(aTime);
      })
      .filter((a) => {
        if (statusFilter !== "all" && a.status !== statusFilter) return false;
        if (staffFilter !== "all" && !appointmentStaffIds(a).includes(staffFilter)) return false;
        if (!inSection(a, sectionFilter)) return false;
        if (dateFilter && a.date !== dateFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          return a.clientName.toLowerCase().includes(q) || a.serviceNames.some((s) => s.toLowerCase().includes(q)) || a.staffName.toLowerCase().includes(q);
        }
        return true;
      });
  }, [appointments, search, statusFilter, staffFilter, sectionFilter, dateFilter, sortBy]);

  const totalRevenue = filtered
    .filter((a) => a.status === "completed")
    .reduce((s, a) => s + a.totalAmount, 0);
  const activeFilters = [statusFilter !== "all", staffFilter !== "all", getActiveSection() === "all" && sectionFilter !== "all", !!dateFilter].filter(Boolean).length;

  const allChecked = filtered.length > 0 && filtered.every(a => checkedIds.has(a.id));
  const someChecked = filtered.some(a => checkedIds.has(a.id));

  function toggleCheck(id: string) {
    setCheckedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allChecked) {
      setCheckedIds(prev => {
        const next = new Set(prev);
        filtered.forEach(a => next.delete(a.id));
        return next;
      });
    } else {
      setCheckedIds(prev => {
        const next = new Set(prev);
        filtered.forEach(a => next.add(a.id));
        return next;
      });
    }
  }

  function deleteChecked() {
    if (!checkedIds.size) return;
    if (!window.confirm(`Delete ${checkedIds.size} appointment${checkedIds.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    const deletedIds = new Set(checkedIds);
    purgeQueuedAppointmentMessages(deletedIds);
    const linkedInvoices = getSalonInvoices().filter((invoice) => invoice.appointmentId && deletedIds.has(invoice.appointmentId));
    // Asked rather than assumed: deleting a mistaken visit should put its
    // products back, but clearing out old history must not refill the shelf.
    const usedUp = settledConsumption(linkedInvoices, appointments.filter((a) => deletedIds.has(a.id)));
    if (usedUp.size > 0 && window.confirm("Put the products these appointments used back into stock?\n\nOK = yes, they weren't really used.\nCancel = no, keep stock as it is.")) {
      returnToStock(usedUp, `${deletedIds.size} appointment${deletedIds.size > 1 ? "s" : ""} deleted`);
    }
    if (linkedInvoices.length > 0) {
      // Tombstone them, or the shorter list below is undone by the next sync —
      // see lib/deleted-records.ts.
      recordDeletions("salon_invoices", linkedInvoices.map((invoice) => invoice.id));
      saveSalonInvoices(getSalonInvoices().filter((invoice) => !invoice.appointmentId || !deletedIds.has(invoice.appointmentId)));
    }
    recordDeletions("appointments", [...deletedIds]);
    const deletedAppts = appointments.filter((a) => deletedIds.has(a.id));
    setAppointments(prev => {
      const updated = prev.filter(a => !deletedIds.has(a.id));
      saveAppointments(updated);
      return updated;
    });
    // Booking an appointment credits the client with a visit/spend right away (see
    // onAdd above), so deleting it must reverse that same credit — otherwise the
    // client's totals stay inflated forever, exactly like the invoice-delete bug.
    // Reverses every guest's own credit too, the same way it was applied.
    setClients((prev) => {
      const credits = creditsFromAppointments(deletedAppts);
      const updated = applyClientCredits(prev, credits, -1);
      saveClients(updated);
      return updated;
    });
    setCheckedIds(new Set());
  }

  const handleImportAppointments = (records: AppointmentImportRecord[]): AppointmentImportResult => {
    const byId = new Map(appointments.map((a) => [a.id, a]));
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const record of records) {
      if (!record.appt.date || !record.appt.startTime) {
        skipped += 1;
        continue;
      }
      if (byId.has(record.appt.id)) updated += 1;
      else added += 1;
      byId.set(record.appt.id, record.appt);
    }

    const nextAppointments = Array.from(byId.values());
    setAppointments(nextAppointments);
    saveAppointments(nextAppointments);
    return { added, updated, skipped, errors: [] };
  };

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 20 }}>

      {selected && (
        <DetailModal
          appt={selected}
          proof={paymentProofs.get(selected.id)}
          onClose={() => setSelected(null)}
          clients={clients}
          staffList={staffList}
          allServices={services}
          onSaveFeedback={(apptId, feedback) => {
            setAppointments((prev) => {
              const updated = prev.map((a) => a.id === apptId ? { ...a, feedback } : a);
              saveAppointments(updated);
              return updated;
            });
            setSelected((prev) => prev && prev.id === apptId ? { ...prev, feedback } : prev);
          }}
          onStatusChange={(apptId, newStatus) => {
            setAppointments((prev) => {
              // The first completion time is kept: re-completing must not
              // re-time the visit after stock was settled, or it deducts twice.
              const completedAt = newStatus === "completed" ? new Date().toISOString() : undefined;
              const updated = prev.map((a) => a.id === apptId ? { ...a, status: newStatus, completedAt: a.completedAt ?? completedAt } : a);
              saveAppointments(updated);
              return updated;
            });
            setSelected((prev) => prev ? { ...prev, status: newStatus } : null);
            // After the save above lands: a completed service uses up its products.
            if (newStatus === "completed") window.setTimeout(() => settleServiceConsumption(), 0);

            if (newStatus === "cancelled" || newStatus === "no-show") {
              enqueueWhatsAppCancellation(apptId);
            }
            if (newStatus === "completed") {
              enqueueWhatsAppFollowup(apptId);
              const appt = appointments.find((a) => a.id === apptId);
              if (appt?.clientId) {
                setClients((prev) => {
                  const loyaltySettings = settingsStore.loyalty as Parameters<typeof awardPoints>[2];
                  const updated = prev.map((c) => {
                    if (c.id !== appt.clientId) return c;
                    const withVisit = { ...c, totalVisits: c.totalVisits + 1, totalSpend: c.totalSpend + appt.totalAmount, lastVisitDate: appt.date };
                    return awardPoints(withVisit, appt.totalAmount, loyaltySettings, appt.id);
                  });
                  saveClients(updated);
                  return updated;
                });
              }
            }
          }}
        />
      )}
      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          clients={clients}
          staffList={staffList}
          allServices={services}
          onAdd={(newAppts, newClients) => {
            // Computed and persisted directly (not via setState updater callbacks) so
            // saveClients() has actually run — and getStoredClients() can see the new
            // client — before enqueueWhatsAppConfirmation reads it below. React defers
            // calling a setState updater function to its own batch after this handler
            // returns, so calling saveClients() *inside* a setClients(prev => ...)
            // updater does not make it available synchronously to code later in this
            // same function, even placed after it.
            //
            // Merged onto a fresh read from storage, not the `appointments`/`clients`
            // props (captured at this render). Those go stale the instant a second
            // booking is created before this component re-renders, which would let a
            // fast double-submit silently overwrite the first booking with the second.
            const updatedAppts = [...newAppts, ...getStoredAppointments()];
            saveAppointments(updatedAppts);
            setAppointments(updatedAppts);

            // One map credits the main client (in full, for every day) and every
            // guest (their own share only) — new clients and existing ones alike,
            // so nothing here is baked in twice.
            const pool = [...newClients, ...getStoredClients()];
            const credits = creditsFromAppointments(newAppts);
            const updatedClients = applyClientCredits(pool, credits, 1);
            saveClients(updatedClients);
            setClients(updatedClients);

            for (const newAppt of newAppts) {
              enqueueWhatsAppConfirmation(newAppt.id).catch((error) => {
                console.warn("[appointments] WhatsApp confirmation queue skipped", error);
              });
              // sendGroupBookingAlert is async — a bare try/catch around the call site
              // only catches synchronous throws, not a later rejection inside the
              // returned promise, so that rejection must be caught here instead.
              sendGroupBookingAlert(newAppt).catch((error) => {
                console.warn("[appointments] WhatsApp group alert skipped", error);
              });
            }
          }}
        />
      )}
      {showImport && (
        <AppointmentImportModal
          existing={appointments}
          clients={clients}
          staffList={staffList}
          services={services}
          onClose={() => setShowImport(false)}
          onImport={handleImportAppointments}
        />
      )}

      {/* Page header */}
      <div className="dashboard-topbar page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <PageTitle
          icon={<CalendarDays size={24} />}
          title="Appointments"
          subtitle={<>{filtered.length} appointments · <span style={{ color: "var(--accent)", fontWeight: 700 }}>{fmt(totalRevenue)} total</span></>}
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
                    <button key={fmt} onClick={() => { setShowExportMenu(false); exportAppointments(filtered, clients, fmt); }}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", border: "none", background: "transparent", borderRadius: 8, fontSize: 12, fontWeight: 700, color: "#1a1a2e", cursor: "pointer", textAlign: "left" }} className="hover-bg-light">
                      <FileSpreadsheet size={14} color="#059669" /> {label}
                    </button>
                  ))}
                  <div style={{ padding: "7px 10px 4px", fontSize: 10, color: "#9898b0", borderTop: "1px solid #f0f0f8", marginTop: 4 }}>Exports {filtered.length} visible appointments</div>
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => !apptLimited && setShowCreate(true)}
            title={apptLimited ? `Free plan: 30 appointments/month limit reached. Upgrade to Pro for unlimited.` : ""}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 20px",
              borderRadius: 12,
              border: "none",
              background: apptLimited ? "#e8e8f0" : "var(--accent-gradient)",
              fontSize: 13,
              fontWeight: 750,
              color: apptLimited ? "#aaaabc" : "#fff",
              boxShadow: apptLimited ? "none" : "0 4px 14px var(--accent-glow)",
              cursor: apptLimited ? "not-allowed" : "pointer",
              transition: "all 0.18s ease"
            }}
            className={!apptLimited ? "page-header-btn" : ""}
          >
            <Plus size={16} />
            New Appointment
            {apptLimited && <span style={{ fontSize: 11, background: "#dc2626", color: "#fff", borderRadius: 20, padding: "1px 7px", marginLeft: 2 }}>Limit reached</span>}
          </button>
        </div>
      </div>

      {/* Native mobile app bar */}
      <MobilePageHeader
        title="Appointments"
        subtitle={`${filtered.length} · ${fmt(totalRevenue)}`}
        action={{ label: apptLimited ? "Limit reached" : "New", icon: <Plus size={14} />, onClick: () => !apptLimited && setShowCreate(true) }}
      />

      {/* Free-plan usage bar */}
      {plan.appointmentsPerMonth !== -1 && (
        <div style={{
          padding: "14px 20px",
          borderRadius: 14,
          background: apptLimited ? "#fef2f2" : monthCount >= plan.appointmentsPerMonth * 0.8 ? "#fffbeb" : "#faf9fd",
          border: `1px solid ${apptLimited ? "#fecaca" : monthCount >= plan.appointmentsPerMonth * 0.8 ? "#fde68a" : "rgba(124, 58, 237, 0.1)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          boxShadow: "0 4px 12px rgba(38,25,75,0.02)"
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: apptLimited ? "#dc2626" : "var(--accent)", marginBottom: 6 }}>
              {apptLimited ? "Monthly limit reached" : `${monthCount} / ${plan.appointmentsPerMonth} appointments this month`}
            </div>
            <div style={{ height: 6, borderRadius: 99, background: "#eef0f5", overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 99, background: apptLimited ? "#dc2626" : monthCount >= plan.appointmentsPerMonth * 0.8 ? "#d97706" : "var(--accent-gradient)", width: `${Math.min(100, (monthCount / plan.appointmentsPerMonth) * 100)}%`, transition: "width 0.3s" }} />
            </div>
          </div>
          <a href="/dashboard/billing" style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap", background: "#fff", border: "1px solid rgba(124, 58, 237, 0.15)", borderRadius: 8, padding: "6px 12px", boxShadow: "0 2px 6px rgba(0,0,0,0.02)", transition: "all 0.15s" }} className="hover-bg-light">
            Upgrade Plan
          </a>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, background: "#f4f4f9", border: "1px solid #e3e0eb", borderRadius: 12, padding: 4, alignSelf: "flex-start" }}>
        {([["appointments", "All Appointments"], ["cancellations", "Cancellations"]] as const).map(([t, label]) => {
          const cancCount = appointments.filter((a) => a.status === "cancelled" || a.status === "no-show").length;
          const isActive = tab === t;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "7px 18px",
                borderRadius: 9,
                border: "none",
                background: isActive ? "var(--accent-gradient)" : "transparent",
                color: isActive ? "#fff" : "#6b6b8a",
                fontSize: 13,
                fontWeight: 755,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                boxShadow: isActive ? "0 4px 10px var(--accent-glow)" : "none",
                transition: "all 0.18s ease"
              }}
            >
              {label}
              {t === "cancellations" && cancCount > 0 && (
                <span style={{
                  fontSize: 10,
                  fontWeight: 800,
                  background: isActive ? "rgba(255,255,255,0.25)" : "#fef2f2",
                  color: isActive ? "#fff" : "#dc2626",
                  borderRadius: 20,
                  padding: "1px 7px"
                }}>
                  {cancCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "cancellations" ? (
        <CancellationsTab appointments={appointments} staffList={staffList} onReschedule={() => setShowCreate(true)} onSelect={setSelected} />
      ) : (<>

      {/* Search + filter bar */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid #e3e0eb", borderRadius: 12, padding: "10px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.01)", transition: "border-color 0.15s" }}>
          <Search size={15} color="#b0b0c8" style={{ flexShrink: 0 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by client, service, or stylist…"
            style={{ flex: 1, border: "none", outline: "none", fontSize: 13, color: "#1a1a2e", background: "transparent" }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", padding: 0 }}>
              <X size={14} color="#b0b0c8" />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "10px 18px",
            borderRadius: 12,
            border: `1px solid ${activeFilters > 0 ? "var(--accent-light)" : "#e3e0eb"}`,
            background: activeFilters > 0 ? "rgba(124, 58, 237, 0.04)" : "#fff",
            fontSize: 13,
            fontWeight: 750,
            color: activeFilters > 0 ? "var(--accent)" : "#6b6b8a",
            cursor: "pointer",
            transition: "all 0.15s"
          }}
          className="hover-bg-light"
        >
          <Filter size={14} />
          Filters
          {activeFilters > 0 && (
            <span style={{ background: "var(--accent-gradient)", color: "#fff", borderRadius: "50%", width: 18, height: 18, fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px var(--accent-glow)" }}>
              {activeFilters}
            </span>
          )}
          <ChevronDown size={13} style={{ transform: showFilters ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </button>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="appt-filter-panel" style={{
          background: "#fff",
          border: "1px solid rgba(226,223,235,.95)",
          borderRadius: 14,
          padding: "16px 20px",
          display: "flex",
          gap: 20,
          flexWrap: "wrap",
          alignItems: "flex-end",
          boxShadow: "0 8px 24px rgba(38,25,75,.03)"
        }}>
          <FilterSelect label="Status" value={statusFilter} onChange={(v) => setStatusFilter(v as AppointmentStatus | "all")}>
            <option value="all">All Statuses</option>
            {ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
          </FilterSelect>
          <FilterSelect label="Stylist" value={staffFilter} onChange={setStaffFilter}>
            <option value="all">All Stylists</option>
            {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </FilterSelect>
          {/* Locked to the active dashboard section when one is set — switch
              the global "Active Section" control to see other appointments. */}
          <FilterSelect label="Section" value={sectionFilter} onChange={setSectionFilter} disabled={getActiveSection() !== "all"}>
            {getActiveSection() !== "all" ? (
              <option value={getActiveSection()}>{getActiveSection()} (locked)</option>
            ) : (
              <>
                <option value="all">All Sections</option>
                {getSectionOptions(appointments).map((s) => <option key={s} value={s}>{s}</option>)}
              </>
            )}
          </FilterSelect>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={{ fontSize: 11, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Date</label>
            <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #e3e0eb", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }} />
          </div>
          <FilterSelect label="Sort by" value={sortBy} onChange={(v) => setSortBy(v as typeof sortBy)}>
            <option value="apptDateDesc">Appointment date (newest first)</option>
            <option value="apptDateAsc">Appointment date (oldest first)</option>
            <option value="createdDesc">Created (newest first)</option>
            <option value="createdAsc">Created (oldest first)</option>
          </FilterSelect>
          {activeFilters > 0 && (
            <button onClick={() => { setStatusFilter("all"); setStaffFilter("all"); if (getActiveSection() === "all") setSectionFilter("all"); setDateFilter(""); }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", fontSize: 12, fontWeight: 700, color: "#dc2626", cursor: "pointer", transition: "all 0.15s" }}>
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Bulk action bar */}
      {someChecked && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 12, background: "#1a1a2e", color: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{checkedIds.size} selected</span>
          <button
            onClick={deleteChecked}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 8, border: "none", background: "#ef4444", color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
          >
            <Trash2 size={13} /> Delete
          </button>
          <button
            onClick={() => setCheckedIds(new Set())}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#ccc", fontSize: 12, fontWeight: 750, cursor: "pointer" }}
          >
            <X size={12} /> Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="table-scroll-wrap" style={{
        background: "#fff",
        borderRadius: 18,
        border: "1px solid rgba(226,223,235,.95)",
        boxShadow: "0 8px 28px rgba(38,25,75,.04)",
        overflow: "hidden"
      }}>
        {/* Desktop: dense scrollable table */}
        <div className="desktop-only">
        <div className="table-scroll-inner">
        <div className="appt-table-inner">
        <div style={{ display: "grid", gridTemplateColumns: "40px 1.2fr 130px 120px 1.5fr 120px 110px 90px 110px", padding: "12px 20px", borderBottom: "1px solid #f0f0f5", background: "#faf9fd" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={allChecked}
              ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }}
              onChange={toggleAll}
              style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#7C3AED" }}
            />
          </div>
          {["CLIENT", "DATE", "CREATED", "SERVICE", "STYLIST", "STATUS", "AMOUNT", ""].map((h) => (
            <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em" }}>{h}</div>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "#b0b0c8", fontSize: 14 }}>No appointments match your filters.</div>
        ) : (
          filtered.map((appt, i) => {
            const cfg = STATUS[appt.status];
            const staff = staffList.find((s) => s.id === appt.staffId);
            const isTeamAppt = services.some((s) => appt.serviceIds.includes(s.id) && s.multiStylist && s.assignedStaffIds.length >= 2);
            const isLast = i === filtered.length - 1;
            const isChecked = checkedIds.has(appt.id);
            return (
              <div
                key={appt.id}
                onClick={() => setSelected(appt)}
                style={{ display: "grid", gridTemplateColumns: "40px 1.2fr 130px 120px 1.5fr 120px 110px 90px 110px", padding: "14px 20px", borderBottom: isLast ? "none" : "1px solid #f8f8fc", alignItems: "center", cursor: "pointer", background: isChecked ? "#F5F3FF" : "transparent", transition: "background 0.2s" }}
                className="hover-bg-row"
              >
                <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleCheck(appt.id)}
                    style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#7C3AED" }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: (staff?.color ?? "#7C3AED") + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: staff?.color ?? "#7C3AED", flexShrink: 0, border: "1.5px solid rgba(255,255,255,0.8)", boxShadow: "0 2px 4px rgba(0,0,0,0.04)" }}>
                    {appt.clientName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", letterSpacing: "-0.01em" }}>{appt.clientName}</span>
                      {(appt.guests?.length ?? 0) > 0 && (
                        <span title={`Also billed: ${appt.guests!.map((g) => g.name).join(", ")}`} style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#be185d", background: "#fdf2f8", padding: "2px 6px", borderRadius: 20, letterSpacing: "0.04em", flexShrink: 0 }}>Family +{appt.guests!.length}</span>
                      )}
                      {paymentProofs.has(appt.id) && <PaymentProofBadge />}
                    </div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, textTransform: "capitalize", fontWeight: 500 }}>{appt.source}</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, color: "#1a1a2e", fontWeight: 650 }}>{fmtDate(appt.date)}</div>
                  <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, display: "flex", alignItems: "center", gap: 3, fontWeight: 500 }}>
                    <Clock size={10} />
                    <span>{fmtTime(appt.startTime)}</span>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 650, whiteSpace: "nowrap" }}>{fmtCreatedAt(appt)}</div>
                <div style={{ fontSize: 13, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 550 }}>
                  {appt.serviceNames.join(", ")}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: staff?.color ?? "#ccc", flexShrink: 0, border: "1.5px solid rgba(255,255,255,0.8)", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }} />
                  <span style={{ fontSize: 13, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{appt.staffName.split(" ")[0]}{extraStylistsLabel(appt)}</span>
                  {isTeamAppt && (
                    <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#7C3AED", background: "#F5F3FF", padding: "2px 6px", borderRadius: 20, letterSpacing: "0.04em", flexShrink: 0 }}>Team</span>
                  )}
                  {(appt.totalDays ?? 1) > 1 && (
                    <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#b45309", background: "#fffbeb", padding: "2px 6px", borderRadius: 20, letterSpacing: "0.04em", flexShrink: 0 }}>Day {appt.dayNumber}/{appt.totalDays}</span>
                  )}
                </div>
                <div>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 800, color: cfg.color, background: cfg.bg, padding: "3px 10px", borderRadius: 20, whiteSpace: "nowrap" }}>
                    <span style={{ width: 4, height: 4, borderRadius: "50%", background: cfg.color }} />
                    {cfg.label}
                  </span>
                  <FeedbackBadge feedback={appt.feedback} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)" }}>{fmt(appt.totalAmount)}</div>
                {/* Checkout button — visible for arrived / in-progress / completed, until it's actually been invoiced */}
                <div onClick={(e) => e.stopPropagation()}>
                  {CHECKOUT_STATUSES.includes(appt.status) && !invoicedApptIds.has(appt.id) ? (
                    <a
                      href={checkoutHref(appt.id, appt.status)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: "var(--accent-gradient)", color: "#fff", fontSize: 11, fontWeight: 800, textDecoration: "none", whiteSpace: "nowrap", boxShadow: "0 3px 8px var(--accent-glow)" }}
                    >
                      <ShoppingCart size={11} /> Checkout
                    </a>
                  ) : <span />}
                </div>
              </div>
            );
          })
        )}
        </div>{/* /appt-table-inner */}
        </div>{/* /table-scroll-inner */}
        </div>{/* /desktop-only */}

        {/* Mobile: stacked card list */}
        <div className="mobile-only">
          {filtered.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#b0b0c8", fontSize: 14 }}>No appointments match your filters.</div>
          ) : (
            filtered.map((appt, i) => {
              const cfg = STATUS[appt.status];
              const staff = staffList.find((s) => s.id === appt.staffId);
              const isTeamAppt = services.some((s) => appt.serviceIds.includes(s.id) && s.multiStylist && s.assignedStaffIds.length >= 2);
              const isLast = i === filtered.length - 1;
              const canCheckout = CHECKOUT_STATUSES.includes(appt.status) && !invoicedApptIds.has(appt.id);
              return (
                <div
                  key={appt.id}
                  onClick={() => setSelected(appt)}
                  style={{ padding: "14px 16px", borderBottom: isLast ? "none" : "1px solid #f8f8fc", display: "flex", flexDirection: "column", gap: 8, cursor: "pointer" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 34, height: 34, borderRadius: "50%", background: (staff?.color ?? "#7C3AED") + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: staff?.color ?? "#7C3AED", flexShrink: 0 }}>
                      {appt.clientName.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{appt.clientName}</span>
                        {(appt.guests?.length ?? 0) > 0 && (
                          <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#be185d", background: "#fdf2f8", padding: "2px 6px", borderRadius: 20, letterSpacing: "0.04em", flexShrink: 0 }}>Family +{appt.guests!.length}</span>
                        )}
                        {paymentProofs.has(appt.id) && <PaymentProofBadge />}
                      </div>
                      <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{appt.serviceNames.join(", ")}</div>
                    </div>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 800, color: cfg.color, background: cfg.bg, padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}>
                      <span style={{ width: 4, height: 4, borderRadius: "50%", background: cfg.color }} />
                      {cfg.label}
                    </span>
                  </div>
                  {appt.feedback && (
                    <div style={{ paddingLeft: 44 }}><FeedbackBadge feedback={appt.feedback} /></div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 44 }}>
                    <div style={{ fontSize: 11, color: "#9898b0", display: "flex", alignItems: "center", gap: 4, fontWeight: 500 }}>
                      <Clock size={10} />
                      <span>{fmtDate(appt.date)} · {fmtTime(appt.startTime)}</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)" }}>{fmt(appt.totalAmount)}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 44, gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: staff?.color ?? "#ccc", flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: "#4a4a6a", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{appt.staffName.split(" ")[0]}{extraStylistsLabel(appt)}</span>
                      {isTeamAppt && (
                        <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#7C3AED", background: "#F5F3FF", padding: "2px 6px", borderRadius: 20, letterSpacing: "0.04em", flexShrink: 0 }}>Team</span>
                      )}
                      {(appt.totalDays ?? 1) > 1 && (
                        <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#b45309", background: "#fffbeb", padding: "2px 6px", borderRadius: 20, letterSpacing: "0.04em", flexShrink: 0 }}>Day {appt.dayNumber}/{appt.totalDays}</span>
                      )}
                    </div>
                    {canCheckout && (
                      <a
                        href={checkoutHref(appt.id, appt.status)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: "var(--accent-gradient)", color: "#fff", fontSize: 11, fontWeight: 800, textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        <ShoppingCart size={11} /> Checkout
                      </a>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {filtered.length > 0 && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid #eef0f5", background: "#faf9fd", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 750, color: "#6b6b8a" }}>{filtered.length} appointments total</span>
            <span style={{ fontSize: 15, fontWeight: 900, color: "var(--accent)" }}>{fmt(totalRevenue)}</span>
          </div>
        )}
      </div>{/* /table-scroll-wrap */}
      </>)}
    </div>
  );
}
