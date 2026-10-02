"use client";

import type { CSSProperties } from "react";
import { TimeSelect } from "@/components/time-select";
import { shiftHours } from "@/lib/attendance";

/** "Shift timing" start/end pickers for the staff forms. Both or neither — blank follows the salon's hours. */
export default function ShiftFields({ start, end, onChange, inputStyle }: {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
  inputStyle: CSSProperties;
}) {
  const hours = shiftHours({ shiftStart: start, shiftEnd: end });
  const half = !!start !== !!end;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Shift Timing</label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center" }}>
        <TimeSelect value={start} onChange={(v) => onChange(v, end)} placeholder="Start" style={inputStyle} />
        <span style={{ fontSize: 12, color: "#9898b0" }}>to</span>
        <TimeSelect value={end} onChange={(v) => onChange(start, v)} placeholder="End" style={inputStyle} />
      </div>
      <div style={{ fontSize: 11, color: half ? "#d97706" : "#b0b0c8" }}>
        {half
          ? "Pick both a start and an end time."
          : hours
            ? <>A {Math.round(hours * 10) / 10}-hour shift. Checking in after the start counts as Late. <button type="button" onClick={() => onChange("", "")} style={{ background: "none", border: "none", padding: 0, color: "#7C3AED", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Use salon hours</button></>
            : "Leave blank to follow the salon's opening hours (Settings → Business Hours)."}
      </div>
    </div>
  );
}
