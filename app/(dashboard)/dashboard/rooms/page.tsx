"use client";

/**
 * Treatment rooms and machines (aesthetic clinics): the list itself, and a
 * day view of who holds each one. Which treatments use which is set on the
 * treatment; booking then refuses overlaps — see lib/clinic-resources.ts.
 */

import { useEffect, useState } from "react";
import { Check, DoorOpen, Plus, Trash2 } from "lucide-react";
import PageTitle from "@/components/page-title";
import { saveSettings, settingsStore } from "@/lib/settings-store";
import { getStoredAppointments, getStoredServices, subscribeToStoredData } from "@/lib/storage";
import { newId, todayKey } from "@/lib/clinic";
import type { ClinicResource, ResourceKind } from "@/lib/clinic-resources";
import { getActiveLocationFilter } from "@/lib/locations";
import type { Appointment, Service } from "@/lib/types";

const INP: React.CSSProperties = { padding: "9px 11px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" };

const allStored = () => ((settingsStore.clinic as { resources?: ClinicResource[] }).resources ?? []).map((r) => ({ ...r }));
const here = (r: ClinicResource) => (r.locationId ?? "main") === getActiveLocationFilter();

export default function RoomsPage() {
  const [resources, setResources] = useState<ClinicResource[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [date, setDate] = useState(todayKey());
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ResourceKind>("room");

  useEffect(() => {
    // This branch's rooms only; other branches' are kept as they are on save.
    setResources(allStored().filter(here));
    const load = () => { setAppointments(getStoredAppointments()); setServices(getStoredServices()); };
    load();
    return subscribeToStoredData(load);
  }, []);

  const edit = (next: ClinicResource[]) => { setResources(next); setDirty(true); };

  async function save() {
    (settingsStore.clinic as { resources: ClinicResource[] }).resources = [...allStored().filter((r) => !here(r)), ...resources.filter((r) => r.name.trim())];
    await saveSettings();
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  const dayAppts = appointments.filter((a) => a.date === date && a.resourceIds?.length && !["cancelled", "no-show"].includes(a.status))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const usedBy = (id: string) => services.filter((s) => s.resourceIds?.includes(id)).map((s) => s.name);

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#fff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageTitle icon={<DoorOpen size={24} />} title="Rooms & Machines"
        subtitle="Treatment rooms and devices. Link them to treatments on the Treatments page; bookings can't overlap on the same one." />

      <section style={{ border: "1px solid #e8e8f0", borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Laser Machine 1, Room 2" style={{ ...INP, flex: "1 1 220px" }} />
          <select value={kind} onChange={(e) => setKind(e.target.value as ResourceKind)} style={INP}>
            <option value="room">Room</option>
            <option value="machine">Machine / device</option>
          </select>
          <button type="button" disabled={!name.trim()}
            onClick={() => { const loc = getActiveLocationFilter(); edit([...resources, { id: newId("res"), name: name.trim(), kind, ...(loc !== "main" ? { locationId: loc } : {}) }]); setName(""); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: "none", background: name.trim() ? "#7C3AED" : "#e8e8f0", color: name.trim() ? "#fff" : "#9898b0", fontSize: 13, fontWeight: 800, cursor: name.trim() ? "pointer" : "default" }}>
            <Plus size={14} /> Add
          </button>
        </div>
        {resources.length === 0 ? (
          <div style={{ fontSize: 13, color: "#9898b0", padding: "8px 0" }}>No rooms or machines yet.</div>
        ) : resources.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid #f4f4f8", flexWrap: "wrap" }}>
            <span style={{ fontSize: 16 }}>{r.kind === "machine" ? "⚙️" : "🚪"}</span>
            <input value={r.name} onChange={(e) => edit(resources.map((x) => x.id === r.id ? { ...x, name: e.target.value } : x))} style={{ ...INP, flex: "1 1 200px" }} />
            <span style={{ fontSize: 11.5, color: "#8a8aa3", flex: "2 1 200px" }}>{usedBy(r.id).join(", ") || "Not linked to a treatment yet"}</span>
            <button type="button" aria-label={`Remove ${r.name}`}
              onClick={() => { if (window.confirm(`Remove ${r.name}? Treatments linked to it stop booking it.`)) edit(resources.filter((x) => x.id !== r.id)); }}
              style={{ border: "1px solid #fecaca", background: "#fff", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
              <Trash2 size={13} color="#dc2626" />
            </button>
          </div>
        ))}
        <button type="button" onClick={save} disabled={!dirty}
          style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 800, cursor: dirty ? "pointer" : "default",
            background: saved ? "#ecfdf5" : dirty ? "#7C3AED" : "#e8e8f0", color: saved ? "#059669" : dirty ? "#fff" : "#9898b0" }}>
          <Check size={14} /> {saved ? "Saved" : "Save"}
        </button>
      </section>

      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: "#1a1a2e", flex: 1 }}>Bookings by room &amp; machine</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={INP} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {resources.map((r) => {
            const mine = dayAppts.filter((a) => a.resourceIds!.includes(r.id));
            return (
              <div key={r.id} style={{ border: "1px solid #e8e8f0", borderRadius: 12, padding: 12 }}>
                <div style={{ fontSize: 13.5, fontWeight: 850, color: "#1a1a2e", marginBottom: 8 }}>{r.kind === "machine" ? "⚙️" : "🚪"} {r.name}</div>
                {mine.length === 0 ? <div style={{ fontSize: 12, color: "#9898b0" }}>Free all day</div> : mine.map((a) => (
                  <div key={a.id} style={{ padding: "7px 9px", marginBottom: 6, borderRadius: 8, background: "#f5f3ff", fontSize: 12 }}>
                    <div style={{ fontWeight: 800, color: "#5b21b6" }}>{a.startTime}–{a.endTime}</div>
                    <div style={{ color: "#1a1a2e" }}>{a.clientName} · {a.serviceNames.join(", ")}</div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
