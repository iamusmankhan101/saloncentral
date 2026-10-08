/**
 * Aesthetic clinic mode.
 *
 * A salon account picks "Aesthetic Clinic" at sign-up (or later in Account →
 * Salon Profile), stored as settings.salon.businessType. Clinic mode keeps the
 * whole salon app and adds the clinical side on top: a medical profile on the
 * client (Client.medical), consultations, treatment plans, signed consent
 * forms, clinical photos, session packages and a patient timeline.
 *
 * Consultations, plans, consents and photos are synced entity lists like any
 * other (lib/turso-sync.ts). Packages and plan progress are not stored at all:
 * they are counted from invoices and completed appointments, the same records
 * stock consumption counts from, so they can't drift out of step with what was
 * actually sold and done — deleting a sale corrects them automatically.
 */

import { useEffect, useState } from "react";
import { settingsStore, SETTINGS_CHANGED_EVENT } from "./settings-store";
import { locationUserKey } from "./locations";
import { persistEntity } from "./turso-sync";
import type { Appointment, InventoryItem, InventoryUnit, Service } from "./types";
import { convertUnits } from "./inventory-usage";
import type { SalonInvoice } from "./salon-invoices";
import type { PrescriptionItem, Prescription } from "./clinic-prescription";
import { activeMembership, addDays, packagesForClient, planProgress, todayKey } from "./clinic-core";
export * from "./clinic-core";

// ─── Business type & wording ─────────────────────────────────────────────────

export type BusinessType = "salon" | "clinic";

export function businessType(): BusinessType {
  return (settingsStore.salon as { businessType?: string }).businessType === "clinic" ? "clinic" : "salon";
}

/**
 * Clinic mode for components. Starts false and switches after mount, because
 * settings live in localStorage the server can't see — reading them during the
 * first render would make the server and browser HTML disagree.
 */
export function useIsClinic(): boolean {
  const [clinic, setClinic] = useState(false);
  useEffect(() => {
    const read = () => setClinic(businessType() === "clinic");
    read();
    window.addEventListener(SETTINGS_CHANGED_EVENT, read);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, read);
  }, []);
  return clinic;
}

const CLINIC_TERMS: Record<string, string> = {
  Clients: "Patients", Client: "Patient", clients: "patients", client: "patient",
  Services: "Treatments", Service: "Treatment", services: "treatments", service: "treatment",
  "Salon Floor": "Clinic Floor",
};

/** The clinic's word for a salon word, when in clinic mode. */
export function term(word: string, clinic: boolean): string {
  return clinic ? CLINIC_TERMS[word] ?? word : word;
}

// ─── Records ─────────────────────────────────────────────────────────────────

export const CONCERNS = [
  "Acne", "Pigmentation", "Wrinkles", "Hair loss", "Scars", "Skin tightening", "Fat reduction",
  "Volume loss", "Dull skin", "Unwanted hair",
] as const;

export interface Consultation {
  id: string;
  clientId: string;
  /** YYYY-MM-DD. */
  date: string;
  practitionerId?: string;
  practitionerName?: string;
  concerns: string[];
  concernOther?: string;
  assessment: {
    skinType?: string;
    skinCondition?: string;
    previousTreatments?: string;
    allergies?: string;
    medications?: string;
    contraindications?: string;
  };
  recommendation: {
    serviceIds: string[];
    sessions?: number;
    intervalWeeks?: number;
    notes?: string;
  };
  notes?: string;
  createdAt: string;
}

export interface TreatmentPlan {
  id: string;
  clientId: string;
  title: string;
  /**
   * The treatments a session consists of. A session is a visit date on which
   * any of them was sold or completed — "Hydrafacial + Chemical Peel" done on
   * one day is one session, not two.
   */
  serviceIds: string[];
  sessions: number;
  intervalDays: number;
  /** YYYY-MM-DD. Only treatments on or after this date count towards the plan. */
  startDate: string;
  consultationId?: string;
  notes?: string;
  closed?: boolean;
  createdAt: string;
}

export interface ConsentTemplate {
  id: string;
  title: string;
  body: string;
  /** Treatments that need this form. */
  serviceIds: string[];
  /** Treatment names containing any of these also need it — so the defaults apply before anything is linked. */
  keywords?: string[];
  /** How long a signature stays valid: 0 = sign before every session. */
  validDays: number;
}

export interface ConsentRecord {
  id: string;
  clientId: string;
  templateId: string;
  /** Snapshot of the form as signed — later template edits don't change what was agreed. */
  title: string;
  body: string;
  /** PNG data URL of the drawn signature. */
  signature: string;
  signedName: string;
  /** ISO time. */
  signedAt: string;
  staffId?: string;
  staffName?: string;
}

export const PHOTO_STAGES = ["Before", "Day 7", "Day 14", "Day 30", "After"] as const;
export const PHOTO_ANGLES = ["Front", "Left", "Right", "Close-up", "Full body"] as const;

export interface ClinicPhoto {
  id: string;
  clientId: string;
  url: string;
  /** YYYY-MM-DD the photo was taken. */
  date: string;
  stage: string;
  angle: string;
  /** Treatment area, free text ("Forehead", "Left cheek"). */
  area?: string;
  serviceId?: string;
  planId?: string;
  note?: string;
  createdAt: string;
}

// ─── Prescriptions & skincare regimes ────────────────────────────────────────

export { REGIME_TIMES, prescriptionText } from "./clinic-prescription";
export type { PrescriptionItem, Prescription } from "./clinic-prescription";
export interface PrescriptionTemplate {
  id: string;
  name: string;
  items: PrescriptionItem[];
  notes?: string;
}

/** Starting regimes; the clinic saves its own from any prescription. */
export const DEFAULT_PRESCRIPTION_TEMPLATES: PrescriptionTemplate[] = [
  { id: "rx-basic", name: "Basic skincare", items: [
    { time: "Morning", product: "Gentle cleanser", frequency: "Daily" },
    { time: "Morning", product: "Vitamin C serum", frequency: "Daily", instructions: "2–3 drops on dry skin" },
    { time: "Morning", product: "Sunscreen SPF 50", frequency: "Daily", instructions: "Reapply every 2–3 hours outdoors" },
    { time: "Night", product: "Gentle cleanser", frequency: "Daily" },
    { time: "Night", product: "Retinol 0.3%", frequency: "Alternate nights", duration: "4 weeks, then nightly", instructions: "Pea-sized amount; stop if irritated" },
    { time: "Night", product: "Moisturiser", frequency: "Daily" },
  ] },
  { id: "rx-acne", name: "Acne regime", items: [
    { time: "Morning", product: "Salicylic acid cleanser", frequency: "Daily" },
    { time: "Morning", product: "Oil-free sunscreen SPF 50", frequency: "Daily" },
    { time: "Night", product: "Salicylic acid cleanser", frequency: "Daily" },
    { time: "Night", product: "Adapalene 0.1% gel", frequency: "Nightly", duration: "12 weeks", instructions: "Thin layer on affected areas only" },
    { time: "Night", product: "Non-comedogenic moisturiser", frequency: "Daily" },
  ] },
  { id: "rx-pigment", name: "Pigmentation regime", items: [
    { time: "Morning", product: "Gentle cleanser", frequency: "Daily" },
    { time: "Morning", product: "Niacinamide 10% serum", frequency: "Daily" },
    { time: "Morning", product: "Tinted sunscreen SPF 50", frequency: "Daily", instructions: "Essential — pigmentation returns without it" },
    { time: "Night", product: "Azelaic acid 15%", frequency: "Nightly", duration: "8–12 weeks" },
    { time: "Night", product: "Moisturiser", frequency: "Daily" },
  ] },
  { id: "rx-post", name: "Post-procedure care", items: [
    { time: "Morning", product: "Gentle cleanser", frequency: "Daily", duration: "7 days", instructions: "Lukewarm water, pat dry" },
    { time: "Morning", product: "Sunscreen SPF 50", frequency: "Daily", instructions: "Avoid direct sun for 2 weeks" },
    { time: "Night", product: "Barrier repair cream", frequency: "Twice daily", duration: "7 days" },
    { time: "As needed", product: "Cold compress", frequency: "As needed", duration: "First 48 hours", instructions: "No makeup, actives, sauna or exercise for 24–48 hours" },
  ] },
];

export function prescriptionTemplates(): PrescriptionTemplate[] {
  const own = (settingsStore.clinic as { prescriptionTemplates?: PrescriptionTemplate[] }).prescriptionTemplates;
  return [...DEFAULT_PRESCRIPTION_TEMPLATES, ...(Array.isArray(own) ? own : [])];
}

// ─── Leads ───────────────────────────────────────────────────────────────────

export const LEAD_STAGES = [
  { id: "new", label: "New Lead" }, { id: "contacted", label: "Contacted" }, { id: "consultation", label: "Consultation" },
  { id: "treatment", label: "Treatment" }, { id: "package", label: "Package" }, { id: "followup", label: "Follow-up" },
  { id: "lost", label: "Lost" },
] as const;
export type LeadStage = typeof LEAD_STAGES[number]["id"];

export const LEAD_SOURCES = ["Instagram", "Facebook", "WhatsApp", "Website", "Walk-in", "Referral", "Google", "TikTok", "Other"] as const;

export interface Lead {
  id: string;
  name: string;
  phone: string;
  source: string;
  interest?: string;
  stage: LeadStage;
  /** Expected value (PKR), for the pipeline total. */
  value?: number;
  notes?: string;
  /** Set once converted: the patient record it became. */
  clientId?: string;
  /** For referral leads: the patient who referred them. */
  referredBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Treatment charting & face map ───────────────────────────────────────────

export type ChartType = "botox" | "filler" | "laser" | "peel" | "general";

/** Treatment-specific fields, so each record captures what matters for that treatment. */
export const CHART_TYPES: { id: ChartType; label: string; faceMap?: "units" | "ml"; fields: { key: string; label: string; placeholder?: string }[] }[] = [
  { id: "botox", label: "Botox / toxin", faceMap: "units", fields: [
    { key: "dilution", label: "Dilution", placeholder: "e.g. 100u in 2.5 ml saline" },
    { key: "areas", label: "Injection areas", placeholder: "Forehead, glabella, crow's feet" },
    { key: "technique", label: "Technique / needle", placeholder: "30G, intramuscular" },
  ] },
  { id: "filler", label: "Dermal filler", faceMap: "ml", fields: [
    { key: "areas", label: "Injection areas", placeholder: "Cheeks, lips" },
    { key: "technique", label: "Technique", placeholder: "Cannula 25G / needle, bolus / linear threading" },
    { key: "anaesthetic", label: "Anaesthetic", placeholder: "Topical EMLA / lidocaine in product" },
  ] },
  { id: "laser", label: "Laser / energy device", fields: [
    { key: "machine", label: "Machine" }, { key: "area", label: "Treatment area" },
    { key: "energy", label: "Energy", placeholder: "J" }, { key: "fluence", label: "Fluence", placeholder: "J/cm²" },
    { key: "pulse", label: "Pulse duration", placeholder: "ms" }, { key: "spot", label: "Spot size", placeholder: "mm" },
    { key: "frequency", label: "Frequency", placeholder: "Hz" }, { key: "shots", label: "Number of shots" },
    { key: "cooling", label: "Cooling", placeholder: "Contact / cryo" },
  ] },
  { id: "peel", label: "Chemical peel", fields: [
    { key: "concentration", label: "Concentration", placeholder: "e.g. Glycolic 35%" }, { key: "layers", label: "Layers" },
    { key: "time", label: "Application time", placeholder: "minutes" }, { key: "reaction", label: "Skin reaction", placeholder: "Erythema, frosting level" },
    { key: "neutraliser", label: "Neutraliser" }, { key: "aftercare", label: "Aftercare given" },
  ] },
  { id: "general", label: "Other treatment", fields: [{ key: "area", label: "Treatment area" }, { key: "settings", label: "Settings / details" }] },
];

export interface ChartProduct {
  itemId?: string;
  name: string;
  batchId?: string;
  /** Snapshot, so the record still reads right if the batch is later removed. */
  batchNumber?: string;
  expiry?: string;
  amount: number;
  unit: InventoryUnit;
}

/** One injection point on the face map: position in the 200×260 diagram, the region it falls in, and the dose. */
export interface FacePoint { x: number; y: number; region: string; amount: number }

export interface TreatmentChart {
  id: string;
  clientId: string;
  /** YYYY-MM-DD. */
  date: string;
  type: ChartType;
  serviceId?: string;
  practitionerId?: string;
  practitionerName?: string;
  products: ChartProduct[];
  fields: Record<string, string>;
  facePoints?: FacePoint[];
  notes?: string;
  createdAt: string;
}

/** Named face regions (centres in the 200×260 diagram) — a click is labelled with the nearest. */
export const FACE_REGIONS: { name: string; x: number; y: number }[] = [
  { name: "Forehead", x: 100, y: 52 }, { name: "Glabella", x: 100, y: 88 },
  { name: "Left temple", x: 38, y: 82 }, { name: "Right temple", x: 162, y: 82 },
  { name: "Left crow's feet", x: 42, y: 108 }, { name: "Right crow's feet", x: 158, y: 108 },
  { name: "Left tear trough", x: 72, y: 122 }, { name: "Right tear trough", x: 128, y: 122 },
  { name: "Bunny lines", x: 100, y: 118 }, { name: "Nose", x: 100, y: 140 },
  { name: "Left cheek", x: 58, y: 145 }, { name: "Right cheek", x: 142, y: 145 },
  { name: "Left nasolabial", x: 80, y: 165 }, { name: "Right nasolabial", x: 120, y: 165 },
  { name: "Upper lip", x: 100, y: 172 }, { name: "Lower lip", x: 100, y: 186 },
  { name: "Left marionette", x: 78, y: 196 }, { name: "Right marionette", x: 122, y: 196 },
  { name: "Chin", x: 100, y: 214 }, { name: "Left jawline", x: 54, y: 198 }, { name: "Right jawline", x: 146, y: 198 },
];

export function faceRegionAt(x: number, y: number): string {
  let best = FACE_REGIONS[0];
  let bestD = Infinity;
  for (const r of FACE_REGIONS) {
    const d = (r.x - x) ** 2 + (r.y - y) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best.name;
}

/** How much of each batch the charts have used, in the batch's item unit. */
export function batchUsage(charts: TreatmentChart[], items: InventoryItem[]): Map<string, number> {
  const unitOf = new Map(items.map((i) => [i.id, i.unit]));
  const used = new Map<string, number>();
  for (const c of charts) {
    for (const p of c.products) {
      if (!p.batchId || !p.itemId) continue;
      const unit = unitOf.get(p.itemId);
      const amount = unit ? convertUnits(p.amount, p.unit, unit) ?? p.amount : p.amount;
      used.set(p.batchId, (used.get(p.batchId) ?? 0) + amount);
    }
  }
  return used;
}

// ─── Waiting list ────────────────────────────────────────────────────────────

export interface WaitlistEntry {
  id: string;
  clientId?: string;
  name: string;
  phone: string;
  /** What they want, free text or treatment names. */
  wants: string;
  /** YYYY-MM-DD they'd like, if any. */
  preferredDate?: string;
  /** "Morning", "Evening", "After 5pm"… */
  preferredTime?: string;
  notes?: string;
  status: "waiting" | "booked" | "removed";
  createdAt: string;
}

type ClinicEntity = "consultations" | "treatment_plans" | "consents" | "clinic_photos" | "prescriptions" | "leads" | "treatment_charts" | "waitlist";

function readList<T>(entity: ClinicEntity): T[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(locationUserKey(`werzio_${entity}`)) ?? "[]");
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

/** Saves the full list; only ids in `deletedIds` are deleted (lib/turso-sync.ts persistEntity). */
function writeList<T>(entity: ClinicEntity, list: T[], deletedIds: string[] = []): Promise<boolean> {
  return persistEntity(entity, list, { deletedIds, inferDeletes: false });
}

export const getConsultations = () => readList<Consultation>("consultations");
export const saveConsultations = (list: Consultation[], deletedIds?: string[]) => writeList("consultations", list, deletedIds);
export const getTreatmentPlans = () => readList<TreatmentPlan>("treatment_plans");
export const saveTreatmentPlans = (list: TreatmentPlan[], deletedIds?: string[]) => writeList("treatment_plans", list, deletedIds);
export const getConsents = () => readList<ConsentRecord>("consents");
export const saveConsents = (list: ConsentRecord[], deletedIds?: string[]) => writeList("consents", list, deletedIds);
export const getClinicPhotos = () => readList<ClinicPhoto>("clinic_photos");
export const saveClinicPhotos = (list: ClinicPhoto[], deletedIds?: string[]) => writeList("clinic_photos", list, deletedIds);
export const getPrescriptions = () => readList<Prescription>("prescriptions");
export const savePrescriptions = (list: Prescription[], deletedIds?: string[]) => writeList("prescriptions", list, deletedIds);
export const getTreatmentCharts = () => readList<TreatmentChart>("treatment_charts");
export const saveTreatmentCharts = (list: TreatmentChart[], deletedIds?: string[]) => writeList("treatment_charts", list, deletedIds);
export const getWaitlist = () => readList<WaitlistEntry>("waitlist");
export const saveWaitlist = (list: WaitlistEntry[], deletedIds?: string[]) => writeList("waitlist", list, deletedIds);
export const getLeads = () => readList<Lead>("leads");
export const saveLeads = (list: Lead[], deletedIds?: string[]) => writeList("leads", list, deletedIds);

/**
 * Records who opened or changed a patient's clinical record (app/api/clinic/audit).
 * Fire-and-forget: a failed log must never block clinical work.
 */
export function audit(action: "view" | "create" | "edit" | "delete" | "sign" | "download" | "send" | "upload", entity: string, clientId: string | undefined, detail?: string): void {
  if (typeof window === "undefined" || !clientId) return;
  fetch("/api/clinic/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, entity, clientId, detail }), keepalive: true }).catch(() => {});
}

/** Getter → what to call the record in the audit log. */
const AUDIT_NAMES = new Map<() => unknown[], string>();

/** Adds or replaces one record by id, against the freshest stored list. */
export function upsertRecord<T extends { id: string }>(get: () => T[], save: (list: T[]) => Promise<boolean>, record: T): T[] {
  const list = get();
  const exists = list.some((r) => r.id === record.id);
  const next = exists ? list.map((r) => r.id === record.id ? record : r) : [record, ...list];
  save(next);
  const name = AUDIT_NAMES.get(get);
  if (name) audit(exists ? "edit" : "create", name, (record as { clientId?: string }).clientId);
  return next;
}

export function removeRecord<T extends { id: string }>(get: () => T[], save: (list: T[], deletedIds?: string[]) => Promise<boolean>, id: string): T[] {
  const list = get();
  const gone = list.find((r) => r.id === id);
  const next = list.filter((r) => r.id !== id);
  save(next, [id]);
  const name = AUDIT_NAMES.get(get);
  if (name && gone) audit("delete", name, (gone as { clientId?: string }).clientId);
  return next;
}

// Clinical records are audited; leads and the waiting list aren't patient records.
AUDIT_NAMES.set(getConsultations, "consultation").set(getTreatmentPlans, "treatment plan").set(getConsents, "consent")
  .set(getClinicPhotos, "photo").set(getPrescriptions, "prescription").set(getTreatmentCharts, "treatment record");

export const newId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// ─── Consent templates ───────────────────────────────────────────────────────

const STANDARD_TERMS = `I confirm that I have given an accurate and complete medical history, including allergies, medications, pregnancy or breastfeeding, and previous treatments, and that I will tell the clinic about any change.

I understand that results vary from person to person, are not guaranteed, and that more than one session may be needed.

I have had the opportunity to ask questions, and all my questions have been answered to my satisfaction. I agree to follow the aftercare instructions given to me.

I consent to photographs being taken for my medical record. They will not be shared or used for any other purpose without my separate written permission.`;

function template(id: string, title: string, about: string, risks: string, keywords: string[]): ConsentTemplate {
  return {
    id, title, keywords, serviceIds: [], validDays: 365,
    body: `${about}\n\nPossible side effects and risks include: ${risks}. I understand that rare but serious complications can occur, and that I should contact the clinic straight away if I have any concerns after treatment.\n\n${STANDARD_TERMS}`,
  };
}

/**
 * Starting wording only. Every clinic must have its own doctor or legal
 * adviser review and adapt these before use — they are edited in Consent Forms.
 */
export const DEFAULT_CONSENT_TEMPLATES: ConsentTemplate[] = [
  template("botox", "Botox (Botulinum Toxin) Consent",
    "I consent to treatment with botulinum toxin injections to temporarily relax selected facial muscles. I understand the effect usually lasts 3–4 months and repeat treatment is needed to maintain it.",
    "bruising, swelling, redness or pain at injection sites, headache, temporary eyelid or brow drooping, asymmetry, flu-like symptoms, and allergic reaction",
    ["botox", "botulinum", "anti-wrinkle", "dysport"]),
  template("filler", "Dermal Filler Consent",
    "I consent to injection of hyaluronic acid dermal filler to add volume or contour to the treated areas. I understand the result lasts several months and the product is gradually absorbed.",
    "swelling, bruising, tenderness, lumps or unevenness, infection, allergic reaction, and rarely blockage of a blood vessel which can cause skin damage or, very rarely, vision problems",
    ["filler", "hyaluronic"]),
  template("lip-filler", "Lip Filler Consent",
    "I consent to injection of hyaluronic acid filler into the lips to add volume, shape or definition.",
    "significant swelling for several days, bruising, tenderness, lumps, asymmetry, cold-sore flare-up, infection, allergic reaction, and rarely blockage of a blood vessel",
    ["lip"]),
  template("prp", "PRP (Platelet-Rich Plasma) Consent",
    "I consent to a sample of my own blood being drawn, processed into platelet-rich plasma, and injected or applied to the treatment area.",
    "pain, bruising or swelling at the blood draw and treatment sites, temporary redness, infection, and minimal or no visible improvement",
    ["prp", "platelet", "vampire"]),
  template("laser", "Laser Treatment Consent",
    "I consent to laser or light-based treatment of the agreed area. I confirm I have not had recent sun exposure, tanning or self-tan, and will protect the area from the sun as advised.",
    "redness, swelling, discomfort, blistering, burns, crusting, temporary or permanent darkening or lightening of the skin, scarring, and incomplete results",
    ["laser", "ipl", "hair removal"]),
  template("chemical-peel", "Chemical Peel Consent",
    "I consent to a chemical peel, in which a chemical solution is applied to the skin to remove its outer layers and improve tone and texture.",
    "stinging, redness, peeling, sensitivity, cold-sore flare-up, temporary or permanent pigment changes, infection and scarring",
    ["peel"]),
  template("microneedling", "Microneedling Consent",
    "I consent to microneedling, in which fine needles create controlled micro-injuries in the skin to stimulate collagen and repair.",
    "redness, swelling and sensitivity for a few days, pinpoint bleeding, dryness or flaking, breakouts, infection, and pigment changes",
    ["microneedling", "dermapen", "derma pen"]),
  template("hair", "Hair Restoration Treatment Consent",
    "I consent to the agreed hair restoration treatment (such as PRP, mesotherapy or exosome therapy) to the scalp.",
    "scalp tenderness, swelling, redness, headache, temporary shedding, infection, and minimal or no visible regrowth",
    ["hair loss", "hair restoration", "mesotherapy", "scalp"]),
  template("body", "Body Contouring Consent",
    "I consent to the agreed non-surgical body contouring treatment (such as fat-freezing, radiofrequency or injection lipolysis) to the agreed area.",
    "redness, swelling, bruising, numbness or tingling, tenderness, firmness, uneven results, and rarely an increase in fat in the treated area",
    ["contour", "cryolipolysis", "fat freez", "lipolysis", "body"]),
];

export function consentTemplates(): ConsentTemplate[] {
  const saved = (settingsStore.clinic as { consentTemplates?: ConsentTemplate[] | null }).consentTemplates;
  return Array.isArray(saved) ? saved : DEFAULT_CONSENT_TEMPLATES;
}

/** Templates that apply to a treatment: linked by id, or matched on its name. */
export function templatesForService(service: Pick<Service, "id" | "name">, templates = consentTemplates()): ConsentTemplate[] {
  const name = service.name.toLowerCase();
  return templates.filter((t) => t.serviceIds.includes(service.id)
    || (t.keywords ?? []).some((k) => k.trim() && name.includes(k.trim().toLowerCase())));
}

export function consentIsValid(template: ConsentTemplate, record: ConsentRecord, nowMs = Date.now()): boolean {
  const signed = Date.parse(record.signedAt);
  if (!Number.isFinite(signed)) return false;
  if (template.validDays <= 0) return new Date(signed).toLocaleDateString("en-CA") === new Date(nowMs).toLocaleDateString("en-CA");
  return nowMs - signed < template.validDays * 86_400_000;
}

/** Consent forms these treatments need that the client hasn't got a valid signature for. */
export function missingConsents(
  clientId: string,
  services: Pick<Service, "id" | "name">[],
  consents: ConsentRecord[],
  templates = consentTemplates(),
  nowMs = Date.now(),
): ConsentTemplate[] {
  const needed = new Map<string, ConsentTemplate>();
  for (const s of services) for (const t of templatesForService(s, templates)) needed.set(t.id, t);
  const mine = consents.filter((c) => c.clientId === clientId);
  return [...needed.values()].filter((t) => !mine.some((c) => c.templateId === t.id && consentIsValid(t, c, nowMs)));
}

// ─── Patient timeline (derived) ──────────────────────────────────────────────

export type TimelineKind = "appointment" | "consultation" | "consent" | "photos" | "plan" | "payment" | "package" | "due" | "prescription" | "membership" | "chart";

export interface TimelineEvent {
  date: string;
  /** Sort key within a day. */
  time: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
}

export function patientTimeline(input: {
  clientId: string;
  appointments: Appointment[];
  invoices: SalonInvoice[];
  consultations: Consultation[];
  plans: TreatmentPlan[];
  consents: ConsentRecord[];
  photos: ClinicPhoto[];
  services: Service[];
  prescriptions?: Prescription[];
  charts?: TreatmentChart[];
}): TimelineEvent[] {
  const { clientId, services } = input;
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? "Treatment";
  const events: TimelineEvent[] = [];

  for (const a of input.appointments) {
    if (a.clientId !== clientId) continue;
    const status = a.status === "completed" ? "" : ` · ${a.status.replace("-", " ")}`;
    events.push({ date: a.date, time: a.startTime || "", kind: "appointment", title: a.serviceNames.join(", ") || "Appointment", detail: `${a.staffName ? `with ${a.staffName}` : ""}${status}`.trim() });
  }
  for (const inv of input.invoices) {
    if (inv.clientId !== clientId) continue;
    const time = (inv.createdAt ?? "").slice(11, 16);
    events.push({ date: inv.date, time, kind: "payment", title: `Invoice ${inv.number} · PKR ${Math.round(inv.total).toLocaleString("en-PK")}`, detail: inv.status === "paid" ? "Paid" : inv.status === "partial" ? "Advance paid" : "Unpaid" });
    for (const line of inv.items) {
      if (line.packagePurchase) events.push({ date: inv.date, time, kind: "package", title: `Package bought: ${line.description}`, detail: `${line.packagePurchase.sessions * Math.max(1, line.qty)} sessions` });
      if (line.packageId) events.push({ date: inv.date, time, kind: "package", title: `Package session used: ${line.description}` });
      if (line.membershipPurchase) events.push({ date: inv.date, time, kind: "membership", title: `Membership: ${line.description}`, detail: `Until ${line.membershipPurchase.until} · ${line.membershipPurchase.discountPercent}% off` });
    }
  }
  for (const c of input.consultations) {
    if (c.clientId !== clientId) continue;
    const concerns = [...c.concerns, c.concernOther].filter(Boolean).join(", ");
    events.push({ date: c.date, time: c.createdAt.slice(11, 16), kind: "consultation", title: "Consultation", detail: [concerns, c.practitionerName && `by ${c.practitionerName}`].filter(Boolean).join(" · ") });
  }
  for (const ch of input.charts ?? []) {
    if (ch.clientId !== clientId) continue;
    const dose = ch.facePoints?.length ? ` · ${Math.round(ch.facePoints.reduce((s, p) => s + p.amount, 0) * 100) / 100} ${CHART_TYPES.find((t) => t.id === ch.type)?.faceMap ?? ""} on face map` : "";
    events.push({ date: ch.date, time: ch.createdAt.slice(11, 16), kind: "chart", title: `Treatment record: ${ch.serviceId ? nameOf(ch.serviceId) : CHART_TYPES.find((t) => t.id === ch.type)?.label ?? "Treatment"}`, detail: `${ch.products.map((p) => `${p.name} ${p.amount}${p.unit}${p.batchNumber ? ` (batch ${p.batchNumber})` : ""}`).join(", ")}${dose}` || undefined });
  }
  for (const rx of input.prescriptions ?? []) {
    if (rx.clientId !== clientId) continue;
    events.push({ date: rx.date, time: rx.createdAt.slice(11, 16), kind: "prescription", title: "Prescription / skincare plan", detail: rx.items.map((i) => i.product).slice(0, 4).join(", ") });
  }
  for (const c of input.consents) {
    if (c.clientId !== clientId) continue;
    events.push({ date: new Date(c.signedAt).toLocaleDateString("en-CA"), time: new Date(c.signedAt).toTimeString().slice(0, 5), kind: "consent", title: `Consent signed: ${c.title}`, detail: c.staffName ? `witnessed by ${c.staffName}` : undefined });
  }
  const photoGroups = new Map<string, number>();
  for (const p of input.photos) {
    if (p.clientId !== clientId) continue;
    const key = `${p.date}|${p.stage}|${p.serviceId ?? ""}`;
    photoGroups.set(key, (photoGroups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of photoGroups) {
    const [date, stage, serviceId] = key.split("|");
    events.push({ date, time: "23:58", kind: "photos", title: `${stage} photos (${count})`, detail: serviceId ? nameOf(serviceId) : undefined });
  }
  for (const plan of input.plans) {
    if (plan.clientId !== clientId) continue;
    events.push({ date: plan.createdAt.slice(0, 10), time: plan.createdAt.slice(11, 16), kind: "plan", title: `Treatment plan: ${plan.title}`, detail: `${plan.sessions} sessions, every ${Math.round(plan.intervalDays / 7)} weeks` });
    if (plan.closed) continue;
    const next = planProgress(plan, input.invoices, input.appointments, services).sessions.find((s) => s.status !== "done");
    if (next) events.push({ date: next.date, time: "23:59", kind: "due", title: `Session ${next.n} of ${plan.sessions} due`, detail: plan.title });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}
