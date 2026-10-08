"use client";

/**
 * The clinical side of a patient's profile, shown on /dashboard/clients/[id]
 * in aesthetic-clinic mode: timeline, medical profile, consultations,
 * treatment plans and packages, consent forms and clinical photos.
 * Data and the rules behind it live in lib/clinic.ts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CalendarDays, Camera, Check, ClipboardList, FileSignature, ListChecks,
  Package, Plus, Stethoscope, Trash2, X, Columns2, Receipt, Images, Clock,
} from "lucide-react";
import { getStoredAppointments, getStoredClients, getStoredServices, getStoredStaff, saveClients, subscribeToStoredData } from "@/lib/storage";
import { getSalonInvoices } from "@/lib/salon-invoices";
import { getCurrentUser } from "@/lib/auth";
import { canAccessHref } from "@/components/sidebar";
import { uploadImage } from "@/lib/image";
import {
  CONCERNS, PHOTO_ANGLES, PHOTO_STAGES, consentIsValid, consentTemplates, getClinicPhotos, getConsents,
  getConsultations, getTreatmentPlans, newId, packagesForClient, patientTimeline, planProgress, removeRecord,
  saveClinicPhotos, saveConsents, saveConsultations, saveTreatmentPlans, todayKey, upsertRecord,
  type ClinicPhoto, type ConsentRecord, type ConsentTemplate, type Consultation, type TimelineKind, type TreatmentPlan,
} from "@/lib/clinic";
import type { Appointment, Client, FitzpatrickType, MedicalProfile, Service, Staff } from "@/lib/types";
import type { SalonInvoice } from "@/lib/salon-invoices";

// ─── Shared bits ─────────────────────────────────────────────────────────────

const ACCENT = "#7C3AED";
const INP: React.CSSProperties = { width: "100%", padding: "9px 11px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff", boxSizing: "border-box" };
const BTN: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: "none", background: ACCENT, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer" };
const BTN_GHOST: React.CSSProperties = { ...BTN, background: "#fff", color: "#6b6b8a", border: "1px solid #e4e4ee" };

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10.5, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{children}</div>;
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <label style={{ display: "block", gridColumn: full ? "1 / -1" : undefined }}><Label>{label}</Label>{children}</label>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "28px 12px", textAlign: "center", fontSize: 12.5, color: "#9898b0", lineHeight: 1.6 }}>{children}</div>;
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: wide ? 860 : 620, maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 70px rgba(0,0,0,0.22)" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #f0f0f5", flexShrink: 0 }}>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 900, color: "#1d1d2f" }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "rgba(0,0,0,0.06)", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
            <X size={14} color="#6b6b8a" />
          </button>
        </div>
        <div style={{ overflowY: "auto", padding: "18px 20px 20px" }}>{children}</div>
      </div>
    </div>
  );
}

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" });

/** Multi-select of treatments as removable chips plus a picker. */
function TreatmentPicker({ services, value, onChange }: { services: Service[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {value.map((id) => (
        <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 20, background: "#f5f3ff", color: ACCENT, fontSize: 12, fontWeight: 700 }}>
          {services.find((s) => s.id === id)?.name ?? "Deleted treatment"}
          <button type="button" onClick={() => onChange(value.filter((v) => v !== id))} aria-label="Remove" style={{ border: "none", background: "none", cursor: "pointer", display: "flex", padding: 0 }}><X size={11} color={ACCENT} /></button>
        </span>
      ))}
      <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} style={{ ...INP, width: "auto", flex: "1 1 180px", padding: "6px 9px" }}>
        <option value="">+ Add treatment…</option>
        {services.filter((s) => s.isActive !== false && !value.includes(s.id) && !s.sessionPackage).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

type Tab = "timeline" | "medical" | "consultations" | "plans" | "consent" | "photos";
const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "timeline", label: "Timeline", icon: Clock },
  { id: "medical", label: "Medical", icon: Stethoscope },
  { id: "consultations", label: "Consultations", icon: ClipboardList },
  { id: "plans", label: "Plans & Packages", icon: ListChecks },
  { id: "consent", label: "Consent", icon: FileSignature },
  { id: "photos", label: "Photos", icon: Camera },
];

interface Data {
  appointments: Appointment[];
  invoices: SalonInvoice[];
  services: Service[];
  staff: Staff[];
  consultations: Consultation[];
  plans: TreatmentPlan[];
  consents: ConsentRecord[];
  photos: ClinicPhoto[];
}

function loadData(): Data {
  return {
    appointments: getStoredAppointments(), invoices: getSalonInvoices(), services: getStoredServices(), staff: getStoredStaff(),
    consultations: getConsultations(), plans: getTreatmentPlans(), consents: getConsents(), photos: getClinicPhotos(),
  };
}

export default function PatientClinicalRecord({ client, onClientChange }: { client: Client; onClientChange: (c: Client) => void }) {
  const [tab, setTab] = useState<Tab>("timeline");
  const [data, setData] = useState<Data | null>(null);
  const [allowed, setAllowed] = useState(true);

  useEffect(() => {
    setAllowed(canAccessHref(getCurrentUser(), "/dashboard/medical"));
    const refresh = () => setData(loadData());
    refresh();
    return subscribeToStoredData(refresh);
  }, []);

  if (!data) return null;
  const refresh = () => setData(loadData());
  const allergies = client.medical?.allergies?.trim();

  return (
    <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #e8e8f0", overflow: "hidden" }}>
      <div style={{ padding: "14px 18px 0", borderBottom: "1px solid #f0f0f8" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Stethoscope size={17} color={ACCENT} />
          <div style={{ fontSize: 15, fontWeight: 900, color: "#1a1a2e" }}>Clinical Record</div>
        </div>
        {allowed && allergies && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", marginBottom: 12, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 12.5, fontWeight: 700, color: "#b91c1c" }}>
            <AlertTriangle size={14} /> Allergies: {allergies}
          </div>
        )}
        {allowed && (
          <div role="tablist" style={{ display: "flex", gap: 2, overflowX: "auto" }}>
            {TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 12px", border: "none", background: "none", cursor: "pointer", whiteSpace: "nowrap",
                  fontSize: 12.5, fontWeight: 800, color: tab === id ? ACCENT : "#8a8aa3", borderBottom: `2px solid ${tab === id ? ACCENT : "transparent"}` }}>
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: 18 }}>
        {!allowed ? (
          <Empty>Medical records are restricted. Ask the owner to give you the &ldquo;Medical Records&rdquo; permission.</Empty>
        ) : tab === "timeline" ? <TimelineTab client={client} data={data} />
          : tab === "medical" ? <MedicalTab client={client} onSaved={onClientChange} />
          : tab === "consultations" ? <ConsultationsTab client={client} data={data} onChange={refresh} onPlanCreated={() => { refresh(); setTab("plans"); }} />
          : tab === "plans" ? <PlansTab client={client} data={data} onChange={refresh} />
          : tab === "consent" ? <ConsentTab client={client} data={data} onChange={refresh} />
          : <PhotosTab client={client} data={data} onChange={refresh} />}
      </div>
    </div>
  );
}

// ─── Timeline ────────────────────────────────────────────────────────────────

const KIND_STYLE: Record<TimelineKind, { color: string; icon: React.ElementType }> = {
  appointment: { color: "#0284c7", icon: CalendarDays },
  consultation: { color: ACCENT, icon: ClipboardList },
  consent: { color: "#059669", icon: FileSignature },
  photos: { color: "#db2777", icon: Images },
  plan: { color: "#d97706", icon: ListChecks },
  payment: { color: "#475569", icon: Receipt },
  package: { color: "#7c3aed", icon: Package },
  due: { color: "#d97706", icon: Clock },
};

function TimelineTab({ client, data }: { client: Client; data: Data }) {
  const events = useMemo(() => patientTimeline({ clientId: client.id, ...data }), [client.id, data]);
  const today = todayKey();
  if (events.length === 0) return <Empty>Nothing recorded yet. Consultations, treatments, consents, photos and payments will appear here in date order.</Empty>;
  let shownToday = false;
  return (
    <div style={{ position: "relative", paddingLeft: 4 }}>
      {events.map((e, i) => {
        const { color, icon: Icon } = KIND_STYLE[e.kind];
        const marker = !shownToday && e.date > today;
        if (marker) shownToday = true;
        return (
          <div key={i}>
            {marker && <div style={{ margin: "6px 0 10px 34px", fontSize: 10.5, fontWeight: 900, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.08em" }}>— Today · upcoming below —</div>}
            <div style={{ display: "flex", gap: 12, paddingBottom: 14, opacity: e.date > today ? 0.75 : 1 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={14} color={color} /></div>
                {i < events.length - 1 && <div style={{ width: 2, flex: 1, background: "#f0f0f6", marginTop: 4 }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#9898b0" }}>{fmtDate(e.date)}</div>
                <div style={{ fontSize: 13.5, fontWeight: 750, color: "#1a1a2e" }}>{e.title}</div>
                {e.detail && <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 1 }}>{e.detail}</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Medical ─────────────────────────────────────────────────────────────────

const FITZPATRICK: { value: FitzpatrickType; label: string }[] = [
  { value: "I", label: "I — always burns, never tans" }, { value: "II", label: "II — usually burns, tans minimally" },
  { value: "III", label: "III — sometimes burns, tans gradually" }, { value: "IV", label: "IV — rarely burns, tans well" },
  { value: "V", label: "V — very rarely burns, tans very easily" }, { value: "VI", label: "VI — never burns" },
];

function MedicalTab({ client, onSaved }: { client: Client; onSaved: (c: Client) => void }) {
  const [form, setForm] = useState<MedicalProfile>(() => ({ ...client.medical }));
  const [saved, setSaved] = useState(false);
  const set = (k: keyof MedicalProfile, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const text = (k: keyof MedicalProfile, label: string, placeholder = "", full = true) => (
    <Field label={label} full={full}>
      <textarea rows={2} value={(form[k] as string) ?? ""} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} style={{ ...INP, resize: "vertical", lineHeight: 1.5 }} />
    </Field>
  );

  function save() {
    const medical: MedicalProfile = Object.fromEntries(Object.entries({ ...form, updatedAt: new Date().toISOString() })
      .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v)) as MedicalProfile;
    const updated: Client = { ...client, medical };
    saveClients(getStoredClients().map((c) => c.id === client.id ? updated : c));
    onSaved(updated);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
      <Field label="Address" full><input value={form.address ?? ""} onChange={(e) => set("address", e.target.value)} style={INP} /></Field>
      <Field label="Emergency contact name"><input value={form.emergencyContactName ?? ""} onChange={(e) => set("emergencyContactName", e.target.value)} style={INP} /></Field>
      <Field label="Emergency contact phone"><input value={form.emergencyContactPhone ?? ""} onChange={(e) => set("emergencyContactPhone", e.target.value)} style={INP} inputMode="tel" /></Field>
      {text("allergies", "Allergies", "e.g. lidocaine, latex, penicillin — shown as a warning on every tab")}
      {text("medicalHistory", "Medical history", "Conditions, surgeries, pregnancy / breastfeeding")}
      {text("medications", "Current medications", "Including blood thinners, isotretinoin, supplements")}
      {text("previousTreatments", "Previous aesthetic treatments", "What, where, when")}
      <Field label="Skin type"><input value={form.skinType ?? ""} placeholder="Oily, dry, combination, sensitive…" onChange={(e) => set("skinType", e.target.value)} style={INP} /></Field>
      <Field label="Fitzpatrick skin type">
        <select value={form.fitzpatrick ?? ""} onChange={(e) => set("fitzpatrick", e.target.value)} style={INP}>
          <option value="">Not assessed</option>
          {FITZPATRICK.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </Field>
      {text("contraindications", "Contraindications", "Anything that rules out or limits a treatment")}
      {text("complications", "Previous complications", "Reactions or complications from earlier treatments")}
      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" onClick={save} style={BTN}>{saved ? <><Check size={14} /> Saved</> : "Save medical profile"}</button>
        {client.medical?.updatedAt && <span style={{ fontSize: 11, color: "#9898b0" }}>Last updated {fmtDate(client.medical.updatedAt)}</span>}
      </div>
    </div>
  );
}

// ─── Consultations ───────────────────────────────────────────────────────────

function ConsultationsTab({ client, data, onChange, onPlanCreated }: { client: Client; data: Data; onChange: () => void; onPlanCreated: () => void }) {
  const [editing, setEditing] = useState<Consultation | null>(null);
  const mine = data.consultations.filter((c) => c.clientId === client.id).sort((a, b) => b.date.localeCompare(a.date));
  const nameOf = (id: string) => data.services.find((s) => s.id === id)?.name ?? "Deleted treatment";

  function blank(): Consultation {
    const m = client.medical ?? {};
    return {
      id: newId("cons"), clientId: client.id, date: todayKey(), concerns: [], createdAt: new Date().toISOString(),
      assessment: { skinType: m.skinType, previousTreatments: m.previousTreatments, allergies: m.allergies, medications: m.medications, contraindications: m.contraindications },
      recommendation: { serviceIds: [] },
    };
  }

  function createPlan(c: Consultation) {
    const ids = c.recommendation.serviceIds;
    if (ids.length === 0) return;
    const plan: TreatmentPlan = {
      id: newId("plan"), clientId: client.id, consultationId: c.id, serviceIds: ids,
      title: ids.map(nameOf).join(" + "), sessions: c.recommendation.sessions || 1,
      intervalDays: (c.recommendation.intervalWeeks || 3) * 7, startDate: todayKey(),
      notes: c.recommendation.notes, createdAt: new Date().toISOString(),
    };
    upsertRecord(getTreatmentPlans, saveTreatmentPlans, plan);
    onPlanCreated();
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button type="button" onClick={() => setEditing(blank())} style={BTN}><Plus size={14} /> New consultation</button>
      </div>
      {mine.length === 0 ? <Empty>No consultations yet.</Empty> : mine.map((c) => {
        const hasPlan = data.plans.some((p) => p.consultationId === c.id);
        return (
          <div key={c.id} style={{ border: "1px solid #ececf4", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: "#1a1a2e", flex: 1 }}>{fmtDate(c.date)}{c.practitionerName ? ` · ${c.practitionerName}` : ""}</div>
              {!hasPlan && c.recommendation.serviceIds.length > 0 && <button type="button" onClick={() => createPlan(c)} style={{ ...BTN, padding: "6px 10px", fontSize: 11.5 }}><ListChecks size={13} /> Create treatment plan</button>}
              {hasPlan && <span style={{ fontSize: 11, fontWeight: 800, color: "#059669" }}>✓ Plan created</span>}
              <button type="button" onClick={() => setEditing(c)} style={{ ...BTN_GHOST, padding: "6px 10px", fontSize: 11.5 }}>Open</button>
            </div>
            <div style={{ fontSize: 12.5, color: "#6b6b8a", marginTop: 6, lineHeight: 1.55 }}>
              <strong>Concerns:</strong> {[...c.concerns, c.concernOther].filter(Boolean).join(", ") || "—"}<br />
              <strong>Recommended:</strong> {c.recommendation.serviceIds.map(nameOf).join(" + ") || "—"}
              {c.recommendation.sessions ? ` · ${c.recommendation.sessions} sessions` : ""}{c.recommendation.intervalWeeks ? `, every ${c.recommendation.intervalWeeks} weeks` : ""}
            </div>
          </div>
        );
      })}
      {editing && (
        <ConsultationForm initial={editing} services={data.services} staff={data.staff}
          onClose={() => setEditing(null)}
          onDelete={mine.some((c) => c.id === editing.id) ? () => { removeRecord(getConsultations, saveConsultations, editing.id); setEditing(null); onChange(); } : undefined}
          onSave={(c) => { upsertRecord(getConsultations, saveConsultations, c); setEditing(null); onChange(); }} />
      )}
    </div>
  );
}

function ConsultationForm({ initial, services, staff, onClose, onSave, onDelete }: {
  initial: Consultation; services: Service[]; staff: Staff[]; onClose: () => void; onSave: (c: Consultation) => void; onDelete?: () => void;
}) {
  const [c, setC] = useState<Consultation>(initial);
  const setA = (k: keyof Consultation["assessment"], v: string) => setC((x) => ({ ...x, assessment: { ...x.assessment, [k]: v } }));
  const setR = (patch: Partial<Consultation["recommendation"]>) => setC((x) => ({ ...x, recommendation: { ...x.recommendation, ...patch } }));
  const toggleConcern = (k: string) => setC((x) => ({ ...x, concerns: x.concerns.includes(k) ? x.concerns.filter((v) => v !== k) : [...x.concerns, k] }));
  const area = (k: keyof Consultation["assessment"], label: string) => (
    <Field label={label}><textarea rows={2} value={c.assessment[k] ?? ""} onChange={(e) => setA(k, e.target.value)} style={{ ...INP, resize: "vertical" }} /></Field>
  );

  return (
    <Modal title="Consultation" onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <Field label="Date"><input type="date" value={c.date} onChange={(e) => setC({ ...c, date: e.target.value })} style={INP} /></Field>
        <Field label="Practitioner">
          <select value={c.practitionerId ?? ""} onChange={(e) => { const s = staff.find((x) => x.id === e.target.value); setC({ ...c, practitionerId: s?.id, practitionerName: s?.name }); }} style={INP}>
            <option value="">—</option>
            {staff.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Patient concern</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {CONCERNS.map((k) => {
              const on = c.concerns.includes(k);
              return <button key={k} type="button" onClick={() => toggleConcern(k)} aria-pressed={on}
                style={{ padding: "6px 11px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 700, border: `1.5px solid ${on ? ACCENT : "#e4e4ee"}`, background: on ? "#f5f3ff" : "#fff", color: on ? ACCENT : "#6b6b8a" }}>{k}</button>;
            })}
          </div>
          <input value={c.concernOther ?? ""} onChange={(e) => setC({ ...c, concernOther: e.target.value })} placeholder="Other concern…" style={{ ...INP, marginTop: 8 }} />
        </div>
        <div style={{ gridColumn: "1 / -1", fontSize: 13, fontWeight: 900, color: "#1a1a2e", marginTop: 4 }}>Assessment</div>
        <Field label="Skin type"><input value={c.assessment.skinType ?? ""} onChange={(e) => setA("skinType", e.target.value)} style={INP} /></Field>
        {area("skinCondition", "Skin condition")}
        {area("previousTreatments", "Previous treatments")}
        {area("allergies", "Allergies")}
        {area("medications", "Medications")}
        {area("contraindications", "Contraindications")}
        <div style={{ gridColumn: "1 / -1", fontSize: 13, fontWeight: 900, color: "#1a1a2e", marginTop: 4 }}>Doctor&rsquo;s recommendation</div>
        <div style={{ gridColumn: "1 / -1" }}><Label>Recommended treatment</Label><TreatmentPicker services={services} value={c.recommendation.serviceIds} onChange={(serviceIds) => setR({ serviceIds })} /></div>
        <Field label="Sessions"><input type="number" min={1} value={c.recommendation.sessions ?? ""} onChange={(e) => setR({ sessions: Number(e.target.value) || undefined })} style={INP} /></Field>
        <Field label="Interval (weeks)"><input type="number" min={1} value={c.recommendation.intervalWeeks ?? ""} onChange={(e) => setR({ intervalWeeks: Number(e.target.value) || undefined })} style={INP} /></Field>
        <Field label="Recommendation notes" full><textarea rows={2} value={c.recommendation.notes ?? ""} onChange={(e) => setR({ notes: e.target.value })} style={{ ...INP, resize: "vertical" }} /></Field>
        <Field label="Consultation notes" full><textarea rows={3} value={c.notes ?? ""} onChange={(e) => setC({ ...c, notes: e.target.value })} style={{ ...INP, resize: "vertical" }} /></Field>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <button type="button" onClick={() => onSave(c)} style={BTN}><Check size={14} /> Save consultation</button>
        <button type="button" onClick={onClose} style={BTN_GHOST}>Cancel</button>
        {onDelete && <button type="button" onClick={() => { if (window.confirm("Delete this consultation?")) onDelete(); }} style={{ ...BTN_GHOST, marginLeft: "auto", color: "#dc2626", borderColor: "#fecaca" }}><Trash2 size={13} /> Delete</button>}
      </div>
    </Modal>
  );
}

// ─── Plans & packages ────────────────────────────────────────────────────────

function PlansTab({ client, data, onChange }: { client: Client; data: Data; onChange: () => void }) {
  const [editing, setEditing] = useState<TreatmentPlan | null>(null);
  const plans = data.plans.filter((p) => p.clientId === client.id).sort((a, b) => Number(!!a.closed) - Number(!!b.closed) || b.createdAt.localeCompare(a.createdAt));
  const packages = packagesForClient(client.id, data.invoices);
  const nameOf = (id: string) => data.services.find((s) => s.id === id)?.name ?? "Deleted treatment";
  const blank = (): TreatmentPlan => ({ id: newId("plan"), clientId: client.id, title: "", serviceIds: [], sessions: 6, intervalDays: 21, startDate: todayKey(), createdAt: new Date().toISOString() });
  const STATUS = { done: { label: "Done", color: "#059669" }, upcoming: { label: "Upcoming", color: "#0284c7" }, overdue: { label: "Overdue", color: "#dc2626" } };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <section>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 900, color: "#1a1a2e" }}>Treatment plans</div>
          <button type="button" onClick={() => setEditing(blank())} style={BTN}><Plus size={14} /> New plan</button>
        </div>
        {plans.length === 0 ? <Empty>No treatment plans. Create one here or from a consultation.</Empty> : plans.map((plan) => {
          const prog = planProgress(plan, data.invoices, data.appointments, data.services);
          const pct = Math.round((prog.done / plan.sessions) * 100);
          return (
            <div key={plan.id} style={{ border: "1px solid #ececf4", borderRadius: 12, padding: "12px 14px", marginBottom: 10, opacity: plan.closed ? 0.6 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 850, color: "#1a1a2e" }}>{plan.title || plan.serviceIds.map(nameOf).join(" + ")}{plan.closed ? " · closed" : ""}</div>
                  <div style={{ fontSize: 12, color: "#6b6b8a" }}><strong style={{ color: ACCENT }}>{prog.done} / {plan.sessions} sessions completed</strong> · {prog.remaining} remaining · every {Math.round(plan.intervalDays / 7)} weeks</div>
                </div>
                <button type="button" onClick={() => setEditing(plan)} style={{ ...BTN_GHOST, padding: "6px 10px", fontSize: 11.5 }}>Edit</button>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "#f0f0f6", margin: "10px 0", overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: ACCENT }} /></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 6 }}>
                {prog.sessions.map((s) => (
                  <div key={s.n} style={{ padding: "6px 9px", borderRadius: 8, background: "#fafafd", border: "1px solid #f0f0f6", fontSize: 11.5 }}>
                    <div style={{ fontWeight: 800, color: "#1a1a2e" }}>Session {s.n}</div>
                    <div style={{ color: "#8a8aa3" }}>{fmtDate(s.date)}</div>
                    <div style={{ fontWeight: 800, color: STATUS[s.status].color }}>{s.status === "done" ? "✓ " : ""}{STATUS[s.status].label}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: "#9898b0", lineHeight: 1.5 }}>Sessions are ticked off automatically when the treatment is completed on an appointment or rung up at POS.</div>
      </section>

      <section>
        <div style={{ fontSize: 14, fontWeight: 900, color: "#1a1a2e", marginBottom: 10 }}>Packages</div>
        {packages.length === 0 ? <Empty>No packages bought. Sell one at POS — mark a treatment as a session package on the Treatments page first.</Empty> : packages.map((p) => (
          <div key={p.id} style={{ border: "1px solid #ececf4", borderRadius: 12, padding: "12px 14px", marginBottom: 10, opacity: p.expired || p.remaining === 0 ? 0.65 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Package size={16} color={ACCENT} />
              <div style={{ flex: 1, fontSize: 14, fontWeight: 850, color: "#1a1a2e" }}>{p.name}</div>
              <span style={{ fontSize: 11, fontWeight: 800, color: p.paid ? "#059669" : "#d97706" }}>{p.paid ? "Paid" : "Balance due"} · {p.invoiceNumber}</span>
            </div>
            <div style={{ fontSize: 12.5, color: "#6b6b8a", marginTop: 4 }}>
              <strong style={{ color: ACCENT }}>{p.sessions} purchased · {p.used} used · {p.remaining} remaining</strong> · covers {nameOf(p.serviceId)}
            </div>
            <div style={{ fontSize: 11.5, color: p.expired ? "#dc2626" : "#8a8aa3", marginTop: 3 }}>
              Bought {fmtDate(p.purchasedOn)} · {p.expiresAt ? `${p.expired ? "Expired" : "Expires"} ${fmtDate(p.expiresAt)}` : "No expiry"} · PKR {Math.round(p.price).toLocaleString("en-PK")}
              {p.usedOn.length > 0 && <> · Used: {p.usedOn.map((u) => fmtDate(u.date)).join(", ")}</>}
            </div>
          </div>
        ))}
      </section>

      {editing && (
        <Modal title={data.plans.some((p) => p.id === editing.id) ? "Edit treatment plan" : "New treatment plan"} onClose={() => setEditing(null)}>
          <PlanForm initial={editing} services={data.services}
            onSave={(p) => { upsertRecord(getTreatmentPlans, saveTreatmentPlans, p); setEditing(null); onChange(); }}
            onDelete={data.plans.some((p) => p.id === editing.id) ? () => { removeRecord(getTreatmentPlans, saveTreatmentPlans, editing.id); setEditing(null); onChange(); } : undefined} />
        </Modal>
      )}
    </div>
  );
}

function PlanForm({ initial, services, onSave, onDelete }: { initial: TreatmentPlan; services: Service[]; onSave: (p: TreatmentPlan) => void; onDelete?: () => void }) {
  const [p, setP] = useState(initial);
  const valid = p.serviceIds.length > 0 && p.sessions > 0 && p.intervalDays > 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <Field label="Plan name" full><input value={p.title} placeholder="e.g. Acne Treatment Plan" onChange={(e) => setP({ ...p, title: e.target.value })} style={INP} /></Field>
      <div style={{ gridColumn: "1 / -1" }}><Label>Treatment each session</Label><TreatmentPicker services={services} value={p.serviceIds} onChange={(serviceIds) => setP({ ...p, serviceIds })} /></div>
      <Field label="Sessions"><input type="number" min={1} value={p.sessions || ""} onChange={(e) => setP({ ...p, sessions: Math.max(0, Math.round(Number(e.target.value))) })} style={INP} /></Field>
      <Field label="Every (weeks)"><input type="number" min={1} value={Math.round(p.intervalDays / 7) || ""} onChange={(e) => setP({ ...p, intervalDays: Math.max(0, Math.round(Number(e.target.value) * 7)) })} style={INP} /></Field>
      <Field label="Start date"><input type="date" value={p.startDate} onChange={(e) => setP({ ...p, startDate: e.target.value })} style={INP} /></Field>
      <Field label="Status">
        <select value={p.closed ? "closed" : "active"} onChange={(e) => setP({ ...p, closed: e.target.value === "closed" || undefined })} style={INP}>
          <option value="active">Active</option><option value="closed">Closed</option>
        </select>
      </Field>
      <Field label="Notes" full><textarea rows={2} value={p.notes ?? ""} onChange={(e) => setP({ ...p, notes: e.target.value })} style={{ ...INP, resize: "vertical" }} /></Field>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
        <button type="button" disabled={!valid} onClick={() => onSave(p)} style={{ ...BTN, opacity: valid ? 1 : 0.5, cursor: valid ? "pointer" : "not-allowed" }}><Check size={14} /> Save plan</button>
        {onDelete && <button type="button" onClick={() => { if (window.confirm("Delete this treatment plan?")) onDelete(); }} style={{ ...BTN_GHOST, marginLeft: "auto", color: "#dc2626", borderColor: "#fecaca" }}><Trash2 size={13} /> Delete</button>}
      </div>
    </div>
  );
}

// ─── Consent ─────────────────────────────────────────────────────────────────

function ConsentTab({ client, data, onChange }: { client: Client; data: Data; onChange: () => void }) {
  const templates = consentTemplates();
  const [signing, setSigning] = useState<ConsentTemplate | null>(null);
  const [viewing, setViewing] = useState<ConsentRecord | null>(null);
  const mine = data.consents.filter((c) => c.clientId === client.id).sort((a, b) => b.signedAt.localeCompare(a.signedAt));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8, marginBottom: 20 }}>
        {templates.map((t) => {
          const last = mine.find((c) => c.templateId === t.id);
          const valid = last && consentIsValid(t, last);
          return (
            <div key={t.id} style={{ border: `1px solid ${valid ? "#bbf7d0" : "#ececf4"}`, background: valid ? "#f0fdf4" : "#fff", borderRadius: 12, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#1a1a2e" }}>{t.title}</div>
                <div style={{ fontSize: 11, color: valid ? "#059669" : "#9898b0", fontWeight: 700 }}>
                  {valid ? `Signed ${fmtDate(last!.signedAt)}` : last ? "Expired — sign again" : "Not signed"}
                </div>
              </div>
              <button type="button" onClick={() => setSigning(t)} style={{ ...BTN, padding: "6px 10px", fontSize: 11.5, background: valid ? "#fff" : ACCENT, color: valid ? ACCENT : "#fff", border: valid ? `1px solid ${ACCENT}` : "none" }}>
                <FileSignature size={13} /> Sign
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 14, fontWeight: 900, color: "#1a1a2e", marginBottom: 8 }}>Signed forms</div>
      {mine.length === 0 ? <Empty>No consent forms signed yet.</Empty> : mine.map((c) => (
        <button key={c.id} type="button" onClick={() => setViewing(c)}
          style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 6, border: "1px solid #ececf4", borderRadius: 10, background: "#fff", cursor: "pointer", textAlign: "left" }}>
          <FileSignature size={15} color="#059669" />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{c.title}</span>
          <span style={{ fontSize: 11.5, color: "#8a8aa3" }}>{new Date(c.signedAt).toLocaleString("en-PK", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        </button>
      ))}
      {signing && (
        <SignConsent template={signing} client={client} staff={data.staff} onClose={() => setSigning(null)}
          onSigned={(rec) => { upsertRecord(getConsents, saveConsents, rec); setSigning(null); onChange(); }} />
      )}
      {viewing && (
        <Modal title={viewing.title} onClose={() => setViewing(null)}>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5, color: "#3a3a52", lineHeight: 1.65 }}>{viewing.body}</div>
          <div style={{ marginTop: 16, padding: 12, border: "1px solid #ececf4", borderRadius: 10 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- signature is an inline PNG data URL */}
            <img src={viewing.signature} alt={`Signature of ${viewing.signedName}`} style={{ maxWidth: "100%", height: 90, objectFit: "contain" }} />
            <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 6 }}>
              Signed by <strong>{viewing.signedName}</strong> on {new Date(viewing.signedAt).toLocaleString("en-PK")}
              {viewing.staffName ? <> · witnessed by <strong>{viewing.staffName}</strong></> : null}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Finger / stylus / mouse signature on a canvas. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const drew = useRef(false);

  useEffect(() => {
    const canvas = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1a1a2e";
  }, []);

  const point = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    drew.current = false;
    onChange(null);
  };

  return (
    <div>
      <canvas ref={ref} aria-label="Signature pad"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const ctx = ref.current!.getContext("2d")!; ctx.beginPath(); ctx.moveTo(...point(e)); }}
        onPointerMove={(e) => { if (!drawing.current) return; const ctx = ref.current!.getContext("2d")!; ctx.lineTo(...point(e)); ctx.stroke(); drew.current = true; }}
        onPointerUp={() => { drawing.current = false; if (drew.current) onChange(ref.current!.toDataURL("image/png")); }}
        style={{ width: "100%", height: 160, border: "1.5px dashed #c4b5fd", borderRadius: 12, background: "#fcfbff", touchAction: "none", display: "block", cursor: "crosshair" }} />
      <button type="button" onClick={clear} style={{ ...BTN_GHOST, padding: "5px 10px", fontSize: 11.5, marginTop: 6 }}>Clear signature</button>
    </div>
  );
}

function SignConsent({ template, client, staff, onClose, onSigned }: {
  template: ConsentTemplate; client: Client; staff: Staff[]; onClose: () => void; onSigned: (r: ConsentRecord) => void;
}) {
  const user = getCurrentUser();
  const [name, setName] = useState(client.name);
  const [signature, setSignature] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [staffId, setStaffId] = useState(user?.staffId ?? "");
  const ready = !!signature && agreed && name.trim().length > 1;

  return (
    <Modal title={template.title} onClose={onClose}>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "#3a3a52", lineHeight: 1.65, maxHeight: "38vh", overflowY: "auto", padding: "12px 14px", border: "1px solid #ececf4", borderRadius: 10, background: "#fafafd" }}>
        {template.body}
      </div>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "14px 0", fontSize: 13, color: "#1a1a2e", cursor: "pointer", lineHeight: 1.5 }}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3, accentColor: ACCENT }} />
        I have read and understood this form, my questions have been answered, and I consent to the treatment.
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Field label="Patient name"><input value={name} onChange={(e) => setName(e.target.value)} style={INP} /></Field>
        <Field label="Witnessed by">
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} style={INP}>
            <option value="">—</option>
            {staff.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      <Label>Patient signature</Label>
      <SignaturePad onChange={setSignature} />
      <button type="button" disabled={!ready}
        onClick={() => {
          const witness = staff.find((s) => s.id === staffId);
          onSigned({
            id: newId("consent"), clientId: client.id, templateId: template.id, title: template.title, body: template.body,
            signature: signature!, signedName: name.trim(), signedAt: new Date().toISOString(), staffId: witness?.id, staffName: witness?.name,
          });
        }}
        style={{ ...BTN, width: "100%", justifyContent: "center", marginTop: 14, padding: "12px 0", opacity: ready ? 1 : 0.5, cursor: ready ? "pointer" : "not-allowed" }}>
        <Check size={15} /> Save signed consent
      </button>
    </Modal>
  );
}

// ─── Photos ──────────────────────────────────────────────────────────────────

function PhotosTab({ client, data, onChange }: { client: Client; data: Data; onChange: () => void }) {
  const [meta, setMeta] = useState({ serviceId: "", stage: "Before", angle: "Front", area: "", date: todayKey() });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [compare, setCompare] = useState<[ClinicPhoto, ClinicPhoto] | null>(null);
  const [viewing, setViewing] = useState<ClinicPhoto | null>(null);
  const mine = data.photos.filter((p) => p.clientId === client.id);
  const nameOf = (id?: string) => (id ? data.services.find((s) => s.id === id)?.name : undefined) ?? "General";

  // Treatment → stage, stages in the order a course runs.
  const groups = useMemo(() => {
    const byTreatment = new Map<string, ClinicPhoto[]>();
    for (const p of mine) byTreatment.set(p.serviceId ?? "", [...(byTreatment.get(p.serviceId ?? "") ?? []), p]);
    const stageRank = (s: string) => { const i = (PHOTO_STAGES as readonly string[]).indexOf(s); return i < 0 ? 50 : i; };
    return [...byTreatment.entries()].map(([serviceId, photos]) => ({
      serviceId,
      photos: photos.sort((a, b) => a.date.localeCompare(b.date) || stageRank(a.stage) - stageRank(b.stage)),
    }));
  }, [mine]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setError("");
    try {
      const added: ClinicPhoto[] = [];
      for (const file of Array.from(files)) {
        const url = await uploadImage(file, "patients", 1600);
        added.push({ id: newId("photo"), clientId: client.id, url, date: meta.date, stage: meta.stage, angle: meta.angle,
          area: meta.area.trim() || undefined, serviceId: meta.serviceId || undefined, createdAt: new Date().toISOString() });
      }
      saveClinicPhotos([...added, ...getClinicPhotos()]);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function togglePick(id: string) {
    setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]);
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, padding: 12, border: "1px solid #ececf4", borderRadius: 12, background: "#fafafd", marginBottom: 16 }}>
        <Field label="Treatment">
          <select value={meta.serviceId} onChange={(e) => setMeta({ ...meta, serviceId: e.target.value })} style={INP}>
            <option value="">General</option>
            {data.services.filter((s) => s.isActive !== false && !s.sessionPackage).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Stage">
          <select value={meta.stage} onChange={(e) => setMeta({ ...meta, stage: e.target.value })} style={INP}>
            {PHOTO_STAGES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Angle">
          <select value={meta.angle} onChange={(e) => setMeta({ ...meta, angle: e.target.value })} style={INP}>
            {PHOTO_ANGLES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Area"><input value={meta.area} placeholder="e.g. Forehead" onChange={(e) => setMeta({ ...meta, area: e.target.value })} style={INP} /></Field>
        <Field label="Date"><input type="date" value={meta.date} onChange={(e) => setMeta({ ...meta, date: e.target.value })} style={INP} /></Field>
        <label style={{ ...BTN, alignSelf: "end", justifyContent: "center", opacity: uploading ? 0.6 : 1 }}>
          <Camera size={14} /> {uploading ? "Uploading…" : "Add photos"}
          <input type="file" accept="image/*" multiple disabled={uploading} style={{ display: "none" }} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        </label>
        {error && <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#dc2626", fontWeight: 700 }}>{error}</div>}
      </div>

      {mine.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, fontSize: 12, color: "#6b6b8a" }}>
          <Columns2 size={14} color={ACCENT} />
          <span style={{ flex: 1 }}>Tick two photos to compare them side by side.</span>
          <button type="button" disabled={picked.length !== 2}
            onClick={() => { const [a, b] = picked.map((id) => mine.find((p) => p.id === id)!).sort((x, y) => x.date.localeCompare(y.date)); setCompare([a, b]); }}
            style={{ ...BTN, padding: "6px 10px", fontSize: 11.5, opacity: picked.length === 2 ? 1 : 0.45, cursor: picked.length === 2 ? "pointer" : "not-allowed" }}>
            Compare
          </button>
        </div>
      )}

      {mine.length === 0 ? <Empty>No photos yet. Pick the treatment, stage and angle above, then add photos.</Empty> : groups.map((g) => (
        <div key={g.serviceId} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13.5, fontWeight: 900, color: "#1a1a2e", marginBottom: 8 }}>{nameOf(g.serviceId)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
            {g.photos.map((p) => (
              <div key={p.id} style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: `2px solid ${picked.includes(p.id) ? ACCENT : "#ececf4"}` }}>
                <button type="button" onClick={() => setViewing(p)} style={{ display: "block", padding: 0, border: "none", width: "100%", cursor: "zoom-in", background: "#f4f4f8" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- Cloudinary URL, sized by the upload */}
                  <img src={p.url} alt={`${p.stage} ${p.angle}`} style={{ width: "100%", height: 130, objectFit: "cover", display: "block" }} />
                </button>
                <input type="checkbox" checked={picked.includes(p.id)} onChange={() => togglePick(p.id)} aria-label="Select for comparison"
                  style={{ position: "absolute", top: 6, left: 6, width: 17, height: 17, accentColor: ACCENT }} />
                <div style={{ padding: "5px 7px", fontSize: 10.5, lineHeight: 1.35 }}>
                  <div style={{ fontWeight: 850, color: "#1a1a2e" }}>{p.stage} · {p.angle}</div>
                  <div style={{ color: "#8a8aa3" }}>{fmtDate(p.date)}{p.area ? ` · ${p.area}` : ""}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {compare && <CompareSlider before={compare[0]} after={compare[1]} onClose={() => setCompare(null)} />}
      {viewing && (
        <Modal title={`${viewing.stage} · ${viewing.angle} · ${fmtDate(viewing.date)}`} onClose={() => setViewing(null)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element -- Cloudinary URL */}
          <img src={viewing.url} alt={`${viewing.stage} ${viewing.angle}`} style={{ width: "100%", maxHeight: "65vh", objectFit: "contain", borderRadius: 10, background: "#111" }} />
          <div style={{ display: "flex", alignItems: "center", marginTop: 10, fontSize: 12, color: "#6b6b8a" }}>
            <span style={{ flex: 1 }}>{nameOf(viewing.serviceId)}{viewing.area ? ` · ${viewing.area}` : ""}</span>
            <button type="button" onClick={() => { if (window.confirm("Delete this photo?")) { removeRecord(getClinicPhotos, saveClinicPhotos, viewing.id); setViewing(null); onChange(); } }}
              style={{ ...BTN_GHOST, color: "#dc2626", borderColor: "#fecaca", padding: "6px 10px", fontSize: 11.5 }}><Trash2 size={13} /> Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Before | After slider: the after photo is revealed from the left as the handle moves. */
function CompareSlider({ before, after, onClose }: { before: ClinicPhoto; after: ClinicPhoto; onClose: () => void }) {
  const [pos, setPos] = useState(50);
  return (
    <Modal title="Before | After" onClose={onClose} wide>
      <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", background: "#111", borderRadius: 12, overflow: "hidden", userSelect: "none" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Cloudinary URL */}
        <img src={before.url} alt="Before" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
        {/* eslint-disable-next-line @next/next/no-img-element -- Cloudinary URL */}
        <img src={after.url} alt="After" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", clipPath: `inset(0 0 0 ${pos}%)` }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${pos}%`, width: 2, background: "#fff", boxShadow: "0 0 6px rgba(0,0,0,0.5)" }} />
        <span style={{ position: "absolute", top: 10, left: 10, padding: "3px 8px", borderRadius: 6, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 11, fontWeight: 800 }}>{before.stage} · {fmtDate(before.date)}</span>
        <span style={{ position: "absolute", top: 10, right: 10, padding: "3px 8px", borderRadius: 6, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 11, fontWeight: 800 }}>{after.stage} · {fmtDate(after.date)}</span>
      </div>
      <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="Before / after position" style={{ width: "100%", marginTop: 12, accentColor: ACCENT }} />
    </Modal>
  );
}
