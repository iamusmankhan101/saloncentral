"use client";

import { weeklyOffDaysFor } from "@/lib/attendance";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "Weekly Offs" day picker for the staff forms. `value` null = follow the salon
 * roster (Settings → Attendance); an array (empty included) = this person's own.
 */
export default function WeeklyOffFields({ value, onChange }: {
  value: number[] | null;
  onChange: (days: number[] | null) => void;
}) {
  const salonOffDays = weeklyOffDaysFor(null);
  const salonOffLabel = salonOffDays.length === 0
    ? "no weekly off"
    : salonOffDays.map((d) => WEEKDAY_NAMES[d]).join(", ");
  // The first pick starts from the salon roster, so overriding a weekend means
  // adjusting two days rather than rebuilding the week from nothing.
  const toggle = (day: number) => {
    const base = value ?? salonOffDays;
    onChange(base.includes(day) ? base.filter((d) => d !== day) : [...base, day].sort());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Weekly Offs</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {WEEKDAY_NAMES.map((day, index) => {
          const on = (value ?? salonOffDays).includes(index);
          return (
            <button key={day} type="button" onClick={() => toggle(index)} aria-pressed={on}
              style={{ padding: "6px 11px", borderRadius: 8, fontSize: 11.5, fontWeight: 750, cursor: "pointer",
                border: `1.5px solid ${on ? "#7C3AED" : "#e8e8f0"}`, background: on ? "#F5F3FF" : "#fff",
                color: on ? "#7C3AED" : "#9898b0" }}>
              {day}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: "#b0b0c8" }}>
        {value === null
          ? `Following the salon roster (${salonOffLabel}). Pick days here to override it for this person.`
          : value.length === 0
            ? "No weekly off — works every day."
            : `${value.length} off day${value.length === 1 ? "" : "s"} a week.`}
        {value !== null && (
          <button type="button" onClick={() => onChange(null)}
            style={{ marginLeft: 6, background: "none", border: "none", padding: 0, color: "#7C3AED", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            Use salon roster
          </button>
        )}
      </div>
    </div>
  );
}
