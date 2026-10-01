"use client";

import type { CSSProperties } from "react";

/** "14:30" → "2:30 PM" */
function label12(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * A time picker that looks and works the same in every browser. Safari on Mac
 * renders <input type="time"> as a bare "--:-- --" field with no clock or
 * dropdown, so salon owners on Safari couldn't see how to pick a time.
 * Value is "HH:MM" 24h, same as the native input; "" means none picked.
 */
export function TimeSelect({ value, onChange, style, stepMin = 15, placeholder = "Select time" }: {
  value: string;
  onChange: (value: string) => void;
  style?: CSSProperties;
  stepMin?: number;
  placeholder?: string;
}) {
  const times: string[] = [];
  for (let t = 0; t < 24 * 60; t += stepMin) {
    times.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  // Keep a saved time that isn't on the grid (e.g. 10:07 from an import) selectable.
  if (value && !times.includes(value)) times.push(value);
  times.sort();

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
      <option value="">{placeholder}</option>
      {times.map((t) => <option key={t} value={t}>{label12(t)}</option>)}
    </select>
  );
}
