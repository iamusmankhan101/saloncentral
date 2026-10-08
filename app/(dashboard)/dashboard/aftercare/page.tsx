"use client";

/**
 * Aftercare & follow-up messages for aesthetic clinics: which automatic
 * WhatsApp messages go out, and the day-by-day wording per treatment. Sent by
 * the daily cron app/api/cron/clinic-aftercare (Pro / Premium, WhatsApp connected).
 */

import { useEffect, useState } from "react";
import { Check, HeartPulse, Plus, RotateCcw, Trash2, X } from "lucide-react";
import PageTitle from "@/components/page-title";
import { saveSettings, settingsStore } from "@/lib/settings-store";
import { getStoredServices } from "@/lib/storage";
import { getCurrentPlan } from "@/lib/plan-limits";
import { newId } from "@/lib/clinic";
import { DEFAULT_AFTERCARE_FLOWS, aftercareFlows, type AftercareFlow, type ClinicAutomationSettings } from "@/lib/clinic-aftercare";
import type { Service } from "@/lib/types";

const INP: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" };
const clinicSettings = () => settingsStore.clinic as ClinicAutomationSettings;

export default function AftercarePage() {
  const [flows, setFlows] = useState<AftercareFlow[]>([]);
  const [toggles, setToggles] = useState({ autoAftercare: true, packageReminders: true, planReminders: true });
  const [services, setServices] = useState<Service[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasWhatsApp, setHasWhatsApp] = useState(true);

  useEffect(() => {
    const c = clinicSettings();
    setFlows(aftercareFlows(c).map((f) => ({ ...f, steps: f.steps.map((s) => ({ ...s })) })));
    setToggles({ autoAftercare: c.autoAftercare !== false, packageReminders: c.packageReminders !== false, planReminders: c.planReminders !== false });
    setServices(getStoredServices().filter((s) => s.isActive !== false));
    setHasWhatsApp(getCurrentPlan().whatsapp);
  }, []);

  const change = (next: AftercareFlow[]) => { setFlows(next); setDirty(true); };
  const update = (id: string, patch: Partial<AftercareFlow>) => change(flows.map((f) => f.id === id ? { ...f, ...patch } : f));

  async function save() {
    Object.assign(settingsStore.clinic, { ...toggles, aftercareFlows: flows });
    await saveSettings();
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#fff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 18 }}>
      <PageTitle icon={<HeartPulse size={24} />} title="Aftercare & Follow-ups"
        subtitle="Automatic WhatsApp messages after each treatment, plus package and treatment-plan reminders." />

      {!hasWhatsApp && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 12.5, color: "#92400e", fontWeight: 600 }}>
          Automatic WhatsApp messages are part of the Pro and Premium plans. You can set them up now; they start sending once you upgrade.
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Toggle on={toggles.autoAftercare} onChange={(v) => { setToggles((t) => ({ ...t, autoAftercare: v })); setDirty(true); }} label="Aftercare messages" sub="Day 1, 7, 14… after each treatment, per the schedules below" />
        <Toggle on={toggles.packageReminders} onChange={(v) => { setToggles((t) => ({ ...t, packageReminders: v })); setDirty(true); }} label="Package reminders" sub="“You have 3 sessions left” the day after a package session is used" />
        <Toggle on={toggles.planReminders} onChange={(v) => { setToggles((t) => ({ ...t, planReminders: v })); setDirty(true); }} label="Plan reminders" sub="“Your next session is due” when a plan session falls due and nothing is booked" />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={save} disabled={!dirty}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 800, cursor: dirty ? "pointer" : "default",
            background: saved ? "#ecfdf5" : dirty ? "#7C3AED" : "#e8e8f0", color: saved ? "#059669" : dirty ? "#fff" : "#9898b0" }}>
          <Check size={14} /> {saved ? "Saved" : "Save changes"}
        </button>
        <button type="button" onClick={() => { const f: AftercareFlow = { id: newId("af"), name: "New schedule", keywords: [], serviceIds: [], steps: [{ day: 1, message: "Hi {name}, thank you for your {treatment} at {clinic}. " }] }; change([...flows, f]); setOpenId(f.id); }}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "1px solid #e4e4ee", background: "#fff", fontSize: 13, fontWeight: 800, color: "#6b6b8a", cursor: "pointer" }}>
          <Plus size={14} /> New schedule
        </button>
        <button type="button" onClick={() => { if (window.confirm("Replace all schedules with the built-in ones?")) change(DEFAULT_AFTERCARE_FLOWS.map((f) => ({ ...f, steps: f.steps.map((s) => ({ ...s })) }))); }}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "1px solid #e4e4ee", background: "#fff", fontSize: 13, fontWeight: 800, color: "#6b6b8a", cursor: "pointer" }}>
          <RotateCcw size={14} /> Restore built-in schedules
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: "#9898b0" }}>In messages, {"{name}"} is the patient&rsquo;s first name, {"{treatment}"} the treatment and {"{clinic}"} your clinic name. Messages wait for opening hours and are spaced out like your other WhatsApp messages.</div>

      {flows.map((f) => {
        const open = openId === f.id;
        return (
          <div key={f.id} style={{ border: "1px solid #e8e8f0", borderRadius: 14, overflow: "hidden" }}>
            <button type="button" onClick={() => setOpenId(open ? null : f.id)}
              style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "13px 16px", border: "none", background: open ? "#faf9ff" : "#fff", cursor: "pointer", textAlign: "left" }}>
              <HeartPulse size={16} color="#7C3AED" />
              <span style={{ flex: 1, fontSize: 14, fontWeight: 800, color: "#1a1a2e" }}>{f.name}</span>
              <span style={{ fontSize: 11.5, color: "#8a8aa3" }}>Days {f.steps.map((s) => s.day).join(", ")}</span>
            </button>
            {open && (
              <div style={{ padding: "4px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
                  <label><Small>Name</Small><input value={f.name} onChange={(e) => update(f.id, { name: e.target.value })} style={INP} /></label>
                  <label><Small>Applies to treatment names containing</Small>
                    <input value={f.keywords.join(", ")} onChange={(e) => update(f.id, { keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) })} placeholder="botox, anti-wrinkle" style={INP} /></label>
                </div>
                <div>
                  <Small>Or these treatments</Small>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {services.map((s) => {
                      const on = f.serviceIds.includes(s.id);
                      return <button key={s.id} type="button" aria-pressed={on} onClick={() => update(f.id, { serviceIds: on ? f.serviceIds.filter((x) => x !== s.id) : [...f.serviceIds, s.id] })}
                        style={{ padding: "4px 9px", borderRadius: 20, cursor: "pointer", fontSize: 11.5, fontWeight: 700, border: `1.5px solid ${on ? "#7C3AED" : "#e4e4ee"}`, background: on ? "#f5f3ff" : "#fff", color: on ? "#7C3AED" : "#6b6b8a" }}>{s.name}</button>;
                    })}
                  </div>
                </div>
                {f.steps.map((s, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "90px 1fr 32px", gap: 8, alignItems: "start" }}>
                    <label><Small>Day</Small><input type="number" min={1} value={s.day} onChange={(e) => update(f.id, { steps: f.steps.map((x, idx) => idx === i ? { ...x, day: Math.max(1, Math.round(Number(e.target.value) || 1)) } : x) })} style={INP} /></label>
                    <label><Small>Message</Small><textarea rows={3} value={s.message} onChange={(e) => update(f.id, { steps: f.steps.map((x, idx) => idx === i ? { ...x, message: e.target.value } : x) })} style={{ ...INP, resize: "vertical", lineHeight: 1.5 }} /></label>
                    <button type="button" aria-label="Remove step" onClick={() => update(f.id, { steps: f.steps.filter((_, idx) => idx !== i) })}
                      style={{ marginTop: 20, border: "none", background: "#fef2f2", borderRadius: 8, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><X size={13} color="#dc2626" /></button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={() => update(f.id, { steps: [...f.steps, { day: (f.steps[f.steps.length - 1]?.day ?? 0) + 7, message: "" }] })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 11px", borderRadius: 8, border: "1px solid #e4e4ee", background: "#fff", fontSize: 12, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}><Plus size={12} /> Add step</button>
                  <button type="button" onClick={() => { if (window.confirm(`Delete the ${f.name} schedule?`)) change(flows.filter((x) => x.id !== f.id)); }}
                    style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 11px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff", fontSize: 12, fontWeight: 700, color: "#dc2626", cursor: "pointer" }}><Trash2 size={12} /> Delete schedule</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Toggle({ on, onChange, label, sub }: { on: boolean; onChange: (v: boolean) => void; label: string; sub: string }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", border: "1px solid #ececf4", borderRadius: 12, cursor: "pointer", flex: "1 1 240px" }}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3, accentColor: "#7C3AED" }} />
      <span><span style={{ display: "block", fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{label}</span><span style={{ fontSize: 11.5, color: "#8a8aa3" }}>{sub}</span></span>
    </label>
  );
}

function Small({ children }: { children: React.ReactNode }) {
  return <span style={{ display: "block", fontSize: 10.5, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{children}</span>;
}
