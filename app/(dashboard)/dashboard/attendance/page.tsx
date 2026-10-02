"use client";

import { useState, useEffect, useMemo } from "react";
import { getStoredStaff } from "@/lib/storage";
import type { Staff } from "@/lib/types";
import { getActiveSection, inSection } from "@/lib/sections";
import {
  getAttendance, setAttendanceStatus, setAttendanceTimes, getAttendanceSummary,
  hoursWorked, nowTimeString, standardHoursFor, isWeeklyOff, leaveAllowanceFor, dayWeightFor, expectedStartFor,
  type AttendanceRecord, type AttendanceStatus,
} from "@/lib/attendance";
import { getStoredStaff as readStaff, saveStaff } from "@/lib/storage";
import PageTitle from "@/components/page-title";
import MobilePageHeader from "@/components/mobile-page-header";
import { ClipboardCheck, ChevronLeft, ChevronRight, CheckCheck, LogIn, LogOut, Clock, QrCode } from "lucide-react";
import QrCheckinSetup from "@/components/qr-checkin-setup";
import { settingsStore } from "@/lib/settings-store";
import { DEFAULT_LATE_AFTER_MINUTES, time12, toMinutes, type QrCheckinSettings } from "@/lib/attendance-checkin";
import { subscribeToStoredData } from "@/lib/storage";

const STATUS_META: Record<AttendanceStatus, { label: string; color: string; bg: string }> = {
  present:    { label: "Present",  color: "#059669", bg: "#ecfdf5" },
  late:       { label: "Late",     color: "#d97706", bg: "#fffbeb" },
  "half-day": { label: "Half-day", color: "#0284c7", bg: "#e0f2fe" },
  absent:     { label: "Absent",   color: "#dc2626", bg: "#fef2f2" },
  leave:      { label: "Leave",    color: "#7C3AED", bg: "#F5F3FF" },
  "week-off": { label: "Week Off", color: "#6b6b8a", bg: "#f4f4f9" },
};
const STATUS_ORDER: AttendanceStatus[] = ["present", "late", "half-day", "absent", "leave", "week-off"];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayStr(): string { return new Date().toLocaleDateString("en-CA"); }

function monthRange(dateStr: string): { start: string; end: string; label: string } {
  const [y, m] = dateStr.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const label = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return { start, end, label };
}

function fmtDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const today = todayStr();
  if (dateStr === today) return "Today";
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === yesterday.toLocaleDateString("en-CA")) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** 7.5 → "7h 30m", 8 → "8h". Minutes are dropped when they'd read as "0m". */
function fmtHours(hours: number): string {
  const whole = Math.floor(hours);
  const mins = Math.round((hours - whole) * 60);
  if (mins === 0) return `${whole}h`;
  if (mins === 60) return `${whole + 1}h`;
  return `${whole}h ${mins}m`;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

export default function AttendancePage() {
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [selectedDate, setSelectedDate] = useState(() => todayStr());
  const [showQrSetup, setShowQrSetup] = useState(false);
  const activeSection = getActiveSection();

  useEffect(() => {
    // Strict-locked to the active dashboard section, same rule as Staff.
    setStaffList(getStoredStaff().filter((s) => s.isActive && inSection(s, activeSection)));
    setRecords(getAttendance());
    // QR check-ins are written on the server by staff phones — pick them up
    // when a sync brings them in, without needing a page reload.
    return subscribeToStoredData(() => setRecords(getAttendance()));
  }, []);

  function refresh() { setRecords(getAttendance()); }

  function mark(staffId: string, status: AttendanceStatus) {
    setAttendanceStatus(staffId, selectedDate, status);
    refresh();
  }

  // Rostered-off staff are marked off rather than present: "everyone in today"
  // should never quietly put a person on the register for a day they don't work.
  function markAllPresent() {
    staffList.forEach((s) =>
      setAttendanceStatus(s.id, selectedDate, isWeeklyOff(s, selectedDate) ? "week-off" : "present"));
    refresh();
  }

  /**
   * Leave allowance is stored on the staff record, so it is edited against the
   * full list rather than the section-filtered one this page renders.
   */
  function setLeaveAllowance(staffId: string, value: string) {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    const next = trimmed === "" || !Number.isFinite(parsed) || parsed < 0 ? undefined : Math.floor(parsed);
    const all = readStaff();
    saveStaff(all.map((st) => (st.id === staffId ? { ...st, paidLeavesPerMonth: next } : st)));
    setStaffList((current) => current.map((st) => (st.id === staffId ? { ...st, paidLeavesPerMonth: next } : st)));
  }

  function setTime(staffId: string, field: "checkIn" | "checkOut", value: string) {
    setAttendanceTimes(staffId, selectedDate, { [field]: value });
    refresh();
  }

  // Stamps the current clock time. Only offered for today — stamping "now" onto
  // a past date would record a time that never happened; those days are edited
  // with the time inputs instead.
  function stampNow(staffId: string, field: "checkIn" | "checkOut") {
    const now = nowTimeString();
    const unmarked = !records.some((r) => r.staffId === staffId && r.date === selectedDate);
    setAttendanceTimes(staffId, selectedDate, { [field]: now });
    // Clocking in an unmarked person after their shift start (plus the same
    // grace QR check-in uses) marks them Late, like a QR scan would.
    if (field === "checkIn" && unmarked) {
      const start = expectedStartFor(staffList.find((s) => s.id === staffId), selectedDate);
      const grace = (settingsStore.attendance as { qrCheckin?: QrCheckinSettings } | undefined)?.qrCheckin?.lateAfterMinutes ?? DEFAULT_LATE_AFTER_MINUTES;
      if (start && toMinutes(now) > toMinutes(start) + grace) setAttendanceStatus(staffId, selectedDate, "late");
    }
    refresh();
  }

  const dayRecordByStaff = useMemo(() => {
    const map: Record<string, AttendanceRecord> = {};
    records.forEach((r) => { if (r.date === selectedDate) map[r.staffId] = r; });
    return map;
  }, [records, selectedDate]);

  const dayStatusByStaff = useMemo(() => {
    const map: Record<string, AttendanceStatus> = {};
    records.forEach((r) => { if (r.date === selectedDate) map[r.staffId] = r.status; });
    return map;
  }, [records, selectedDate]);

  const isToday = selectedDate === todayStr();
  // Busy-day rule: what a leave or absence on this date is charged as.
  const dayWeight = useMemo(() => dayWeightFor(selectedDate), [selectedDate]);

  const month = useMemo(() => monthRange(selectedDate), [selectedDate]);
  const monthlySummaries = useMemo(
    () => staffList.map((s) => ({
      staff: s,
      summary: getAttendanceSummary(s.id, month.start, month.end, records, leaveAllowanceFor(s), standardHoursFor(s), s),
      standardHours: standardHoursFor(s),
    })),
    [staffList, month, records],
  );

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 20 }}>
      {showQrSetup && <QrCheckinSetup onClose={() => setShowQrSetup(false)} />}

      <MobilePageHeader
        title="Attendance"
        subtitle={activeSection === "all" ? `${staffList.length} active staff` : `Restricted to ${activeSection} only`}
      />

      {/* Not dashboard-topbar (hidden on phones) — the date controls must stay
          reachable there; only the duplicate title is desktop-only. */}
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div className="desktop-only">
          <PageTitle
            icon={<ClipboardCheck size={24} />}
            title="Attendance"
            subtitle={activeSection === "all" ? `${staffList.length} active staff` : `Restricted to ${activeSection} only`}
          />
        </div>
        <div className="att-controls" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={() => setSelectedDate((d) => shiftDate(d, -1))} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft size={15} />
          </button>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 130 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{fmtDateLabel(selectedDate)}</div>
            <input type="date" value={selectedDate} max={todayStr()} onChange={(e) => e.target.value && setSelectedDate(e.target.value)} style={{ border: "none", background: "none", fontSize: 11, color: "#9898b0", cursor: "pointer" }} />
          </div>
          <button type="button" onClick={() => setSelectedDate((d) => shiftDate(d, 1))} disabled={selectedDate >= todayStr()} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", cursor: selectedDate >= todayStr() ? "not-allowed" : "pointer", opacity: selectedDate >= todayStr() ? 0.4 : 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronRight size={15} />
          </button>
          <button type="button" onClick={markAllPresent} disabled={staffList.length === 0} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: "none", background: "var(--accent-gradient)", color: "#fff", fontSize: 12, fontWeight: 750, cursor: staffList.length === 0 ? "not-allowed" : "pointer", opacity: staffList.length === 0 ? 0.5 : 1 }}>
            <CheckCheck size={14} /> Mark All Present
          </button>
          <button type="button" onClick={() => setShowQrSetup(true)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 14px", borderRadius: 10, border: "1px solid #ddd6fe", background: "#fff", color: "#6d28d9", fontSize: 13, fontWeight: 750, cursor: "pointer" }}>
            <QrCode size={14} /> QR Check-in
          </button>
        </div>
      </div>

      {/* Daily register */}
      {staffList.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center", color: "#b0b0c8" }}>
          <ClipboardCheck size={32} style={{ display: "block", margin: "0 auto 10px" }} />
          <div style={{ fontSize: 14, fontWeight: 700 }}>No active staff to mark</div>
        </div>
      ) : (
        <div className="cards-grid-auto">
          {staffList.map((s) => {
            const status = dayStatusByStaff[s.id];
            const record = dayRecordByStaff[s.id];
            const standard = standardHoursFor(s);
            const worked = record ? hoursWorked(record) : null;
            const overtime = worked != null && worked > standard;
            const short = worked != null && worked < standard;
            return (
              <div key={s.id} style={{ background: "#fff", padding: 18, display: "flex", flexDirection: "column", gap: 12, border: "1px solid #ebebf0", borderRadius: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: s.color + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: s.color, flexShrink: 0 }}>
                    {s.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: "#9898b0", textTransform: "capitalize" }}>
                      {s.role.replace(/-/g, " ")}
                      {s.shiftStart && s.shiftEnd && (
                        <span style={{ textTransform: "none" }}> · Shift {time12(s.shiftStart)} – {time12(s.shiftEnd)}</span>
                      )}
                      {isWeeklyOff(s, selectedDate) && (
                        <span style={{ textTransform: "none", color: STATUS_META["week-off"].color, fontWeight: 700 }}> · rostered off</span>
                      )}
                      {dayWeight > 1 && (
                        <span style={{ textTransform: "none", color: "#d97706", fontWeight: 700 }}> · leave/absence counts {dayWeight}×</span>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {STATUS_ORDER.map((st) => {
                    const meta = STATUS_META[st];
                    const active = status === st;
                    return (
                      <button
                        key={st}
                        type="button"
                        onClick={() => mark(s.id, st)}
                        style={{
                          padding: "6px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 750, cursor: "pointer",
                          border: `1.5px solid ${active ? meta.color : "#e8e8f0"}`,
                          background: active ? meta.bg : "#fff",
                          color: active ? meta.color : "#9898b0",
                          transition: "all 0.12s",
                        }}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>

                {/* Clocked time — hidden for absent/leave, where hours are meaningless */}
                {status !== "absent" && status !== "leave" && (
                  <div style={{ borderTop: "1px dashed #eeeef4", paddingTop: 11, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: "#8e89a3" }}>
                        IN
                        <input
                          type="time"
                          value={record?.checkIn ?? ""}
                          onChange={(e) => setTime(s.id, "checkIn", e.target.value)}
                          style={{ border: "1px solid #e8e8f0", borderRadius: 7, padding: "4px 6px", fontSize: 11.5, fontWeight: 700, color: "#1a1a2e", background: "#fff" }}
                        />
                      </label>
                      {isToday && !record?.checkIn && (
                        <button type="button" onClick={() => stampNow(s.id, "checkIn")} title="Clock in now"
                          style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: "1px solid #d1fae5", background: "#ecfdf5", color: "#059669", fontSize: 10.5, fontWeight: 750, cursor: "pointer" }}>
                          <LogIn size={11} /> Now
                        </button>
                      )}
                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 700, color: "#8e89a3" }}>
                        OUT
                        <input
                          type="time"
                          value={record?.checkOut ?? ""}
                          onChange={(e) => setTime(s.id, "checkOut", e.target.value)}
                          style={{ border: "1px solid #e8e8f0", borderRadius: 7, padding: "4px 6px", fontSize: 11.5, fontWeight: 700, color: "#1a1a2e", background: "#fff" }}
                        />
                      </label>
                      {isToday && record?.checkIn && !record?.checkOut && (
                        <button type="button" onClick={() => stampNow(s.id, "checkOut")} title="Clock out now"
                          style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: "1px solid #fee2e2", background: "#fef2f2", color: "#dc2626", fontSize: 10.5, fontWeight: 750, cursor: "pointer" }}>
                          <LogOut size={11} /> Now
                        </button>
                      )}
                    </div>
                    {record?.method === "qr" && record.checkIn && (
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#7C3AED" }}>Checked in by QR scan</div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9898b0" }}>
                      <Clock size={11} />
                      {worked == null ? (
                        <span>Standard day {fmtHours(standard)} — add both times to count hours</span>
                      ) : (
                        <>
                          <span style={{ fontWeight: 800, color: "#1a1a2e" }}>{fmtHours(worked)}</span>
                          <span>of {fmtHours(standard)}</span>
                          {short && (
                            <span style={{ padding: "1px 7px", borderRadius: 20, background: "#fffbeb", color: "#d97706", fontWeight: 750, fontSize: 10 }}>
                              {fmtHours(standard - worked)} short
                            </span>
                          )}
                          {overtime && (
                            <span style={{ padding: "1px 7px", borderRadius: 20, background: "#ecfdf5", color: "#059669", fontWeight: 750, fontSize: 10 }}>
                              +{fmtHours(worked - standard)}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Monthly summary */}
      {staffList.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e", marginBottom: 12 }}>{month.label} Summary</div>
          <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #ebebf0", overflow: "hidden", overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr repeat(5, 0.62fr) 0.7fr 1.05fr 0.8fr 1.05fr", padding: "10px 20px", background: "#faf9fd", borderBottom: "1px solid #f0f0f5", minWidth: 900 }}>
              {["STAFF", "PRESENT", "LATE", "HALF-DAY", "ABSENT", "LEAVE", "WEEK OFF", "MARKED", "HOURS", "PAY CREDIT", "LEAVES ALLOWED"].map((h) => (
                <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.06em" }}>{h}</div>
              ))}
            </div>
            {monthlySummaries.map(({ staff, summary, standardHours }) => (
              <div key={staff.id} style={{ display: "grid", gridTemplateColumns: "1.6fr repeat(5, 0.62fr) 0.7fr 1.05fr 0.8fr 1.05fr", padding: "12px 20px", borderBottom: "1px solid #f8f8fc", alignItems: "center", minWidth: 900 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>
                  {staff.name}
                  <span style={{ fontSize: 10, color: "#b0b0c8", fontWeight: 600, marginLeft: 6 }}>{fmtHours(standardHours)}/day</span>
                </div>
                <div style={{ fontSize: 12, color: STATUS_META.present.color, fontWeight: 700 }}>{summary.present}</div>
                <div style={{ fontSize: 12, color: STATUS_META.late.color, fontWeight: 700 }}>{summary.late}</div>
                <div style={{ fontSize: 12, color: STATUS_META["half-day"].color, fontWeight: 700 }}>{summary.halfDay}</div>
                <div style={{ fontSize: 12, color: STATUS_META.absent.color, fontWeight: 700 }}>{summary.absent}</div>
                <div style={{ fontSize: 12, color: STATUS_META.leave.color, fontWeight: 700 }}>
                  {summary.leave}
                  {summary.leaveOverBy > 0 && (
                    <div style={{ fontSize: 10, color: "#dc2626", fontWeight: 700 }}>{summary.leaveOverBy} unpaid</div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 700 }}>
                  {summary.weekOff}
                  <div style={{ fontSize: 10, color: "#b0b0c8", fontWeight: 600 }}>of {summary.scheduledOffDays}</div>
                </div>
                <div style={{ fontSize: 12, color: "#6b6b8a" }}>{summary.markedDays}</div>
                <div style={{ fontSize: 12, color: "#6b6b8a" }}>
                  {summary.daysWithTimes === 0 ? (
                    <span style={{ color: "#c8c8d8" }}>—</span>
                  ) : (
                    <>
                      <span style={{ fontWeight: 750, color: "#1a1a2e" }}>{fmtHours(summary.hoursWorked)}</span>
                      <span style={{ color: "#b0b0c8" }}> / {fmtHours(summary.expectedHours)}</span>
                      {summary.shortfallHours > 0 && (
                        <div style={{ fontSize: 10, color: "#d97706", fontWeight: 700 }}>{fmtHours(summary.shortfallHours)} short</div>
                      )}
                    </>
                  )}
                </div>
                <div style={{ fontSize: 12, fontWeight: 750, color: summary.creditFactor < 1 ? "#d97706" : "#059669" }}>
                  {Math.round(summary.creditFactor * 100)}%
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="number" min="0" step="1"
                    aria-label={`Paid leaves allowed per month for ${staff.name}`}
                    value={staff.paidLeavesPerMonth ?? ""}
                    placeholder={String(summary.leaveAllowance)}
                    onChange={(e) => setLeaveAllowance(staff.id, e.target.value)}
                    style={{ width: 52, padding: "5px 7px", borderRadius: 7, border: "1px solid #e8e8f0", fontSize: 12, color: "#1a1a2e", outline: "none" }}
                  />
                  <span style={{ fontSize: 11, color: summary.leaveOverBy > 0 ? "#dc2626" : "#9898b0", fontWeight: 600 }}>
                    {summary.leaveOverBy > 0 ? `${summary.leaveOverBy} over` : `${summary.leaveRemaining} left`}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#b0b0c8", marginTop: 8, lineHeight: 1.6 }}>
            Pay credit feeds salary pro-ration in Payouts for any staff member paid a fixed or partial salary.
            A day with both times clocked counts as the fraction of a standard day actually worked (hours over
            the standard don&rsquo;t add extra pay); days without times fall back to their status alone.
            Change the standard day in Settings, or per person on their Staff record.
          </div>
          <div style={{ fontSize: 11, color: "#b0b0c8", marginTop: 6, lineHeight: 1.6 }}>
            <strong style={{ color: "#8e89a3" }}>Leaves allowed</strong> is per month, editable above — blank follows the
            salon default in Settings → Business Hours. Leave days within the allowance are paid in full; the rest are
            unpaid. <strong style={{ color: "#8e89a3" }}>Week Off</strong> counts the rostered days off marked so far
            against how many the roster puts in {month.label} — the default weekend is two a week, and the days can be
            changed for the salon in Settings or for one person on their Staff record. Rostered days off are not
            absences and don&rsquo;t affect pay credit. A leave or absence on one of the salon&rsquo;s busy days counts
            as more than one day — the weekend at 2× by default, set in Settings → Business Hours — so those days
            spend the allowance faster and cost more pay credit.
          </div>
        </div>
      )}
    </div>
  );
}
