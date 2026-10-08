"use client";

/**
 * Lead pipeline (aesthetic clinics): New → Contacted → Consultation →
 * Treatment → Package → Follow-up, plus where the money actually came from.
 * Leads are a synced entity (lib/clinic.ts). Revenue per source is counted
 * from the converted patient's invoices since the lead came in, so it shows
 * what each channel really earned rather than how many enquiries it produced.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Megaphone, Plus, Send, Trash2, UserPlus, X } from "lucide-react";
import PageTitle from "@/components/page-title";
import { getStoredClients, saveClients, subscribeToStoredData } from "@/lib/storage";
import { getSalonInvoices, type SalonInvoice } from "@/lib/salon-invoices";
import { normalizePhone } from "@/lib/whatsapp-scheduler";
import { fmtCurrency as fmt } from "@/lib/format";
import {
  LEAD_SOURCES, LEAD_STAGES, getConsultations, getLeads, newId, removeRecord, saveLeads, todayKey, upsertRecord,
  type Consultation, type Lead, type LeadStage,
} from "@/lib/clinic";
import type { Client } from "@/lib/types";

const INP: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" };
const STAGE_COLOR: Record<LeadStage, string> = {
  new: "#0284c7", contacted: "#7c3aed", consultation: "#d97706", treatment: "#059669", package: "#b45309", followup: "#0891b2", lost: "#9ca3af",
};
const stageIndex = (s: LeadStage) => LEAD_STAGES.findIndex((x) => x.id === s);

function clientSourceFor(source: string): Client["source"] {
  if (source === "WhatsApp") return "whatsapp";
  if (source === "Walk-in") return "walk-in";
  if (["Website", "Instagram", "Facebook", "Google", "TikTok"].includes(source)) return "web";
  return "manual";
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<SalonInvoice[]>([]);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [showLost, setShowLost] = useState(false);

  useEffect(() => {
    const load = () => { setLeads(getLeads()); setClients(getStoredClients()); setInvoices(getSalonInvoices()); setConsultations(getConsultations()); };
    load();
    return subscribeToStoredData(load);
  }, []);

  const save = (lead: Lead) => setLeads(upsertRecord(getLeads, saveLeads, { ...lead, updatedAt: new Date().toISOString() }));
  const move = (lead: Lead, dir: 1 | -1) => {
    const order = LEAD_STAGES.filter((s) => s.id !== "lost");
    const i = order.findIndex((s) => s.id === lead.stage);
    const next = order[Math.min(order.length - 1, Math.max(0, i + dir))];
    if (next) save({ ...lead, stage: next.id });
  };

  /** Makes the lead a patient — or links the existing patient with the same number. */
  function convert(lead: Lead) {
    const phone = normalizePhone(lead.phone);
    const all = getStoredClients();
    let client = all.find((c) => phone && normalizePhone(c.phone) === phone);
    if (!client) {
      client = {
        id: newId("c"), name: lead.name.trim(), phone, tags: ["New", lead.source], source: clientSourceFor(lead.source),
        createdAt: todayKey(), totalVisits: 0, totalSpend: 0, ...(lead.referredBy ? { referredBy: lead.referredBy } : {}),
      };
      saveClients([client, ...all]);
      setClients([client, ...all]);
    }
    save({ ...lead, clientId: client.id, stage: stageIndex(lead.stage) < stageIndex("consultation") ? "consultation" : lead.stage });
  }

  // Funnel and revenue per source.
  const bySource = useMemo(() => {
    const rows = new Map<string, { leads: number; consultations: number; treatments: number; revenue: number }>();
    for (const lead of leads) {
      const r = rows.get(lead.source) ?? { leads: 0, consultations: 0, treatments: 0, revenue: 0 };
      r.leads++;
      const since = lead.createdAt.slice(0, 10);
      const paid = lead.clientId ? invoices.filter((inv) => inv.clientId === lead.clientId && inv.date >= since && inv.status !== "unpaid") : [];
      const consulted = !!lead.clientId && consultations.some((c) => c.clientId === lead.clientId);
      if (consulted || (lead.stage !== "lost" && stageIndex(lead.stage) >= stageIndex("consultation"))) r.consultations++;
      if (paid.length > 0 || (lead.stage !== "lost" && stageIndex(lead.stage) >= stageIndex("treatment"))) r.treatments++;
      r.revenue += paid.reduce((sum, inv) => sum + (inv.total || 0), 0);
      rows.set(lead.source, r);
    }
    return [...rows.entries()].sort((a, b) => b[1].revenue - a[1].revenue || b[1].leads - a[1].leads);
  }, [leads, invoices, consultations]);

  const open = leads.filter((l) => l.stage !== "lost");
  const pipelineValue = open.reduce((sum, l) => sum + (l.value || 0), 0);
  const stages = LEAD_STAGES.filter((s) => showLost || s.id !== "lost");
  const clientName = (id?: string) => clients.find((c) => c.id === id)?.name;

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#fff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageTitle icon={<Megaphone size={24} />} title="Leads"
        subtitle={`${open.length} open leads · ${fmt(pipelineValue)} in the pipeline`}
        right={
          <button type="button" onClick={() => setEditing({ id: newId("lead"), name: "", phone: "", source: "Instagram", stage: "new", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "none", background: "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
            <Plus size={14} /> Add lead
          </button>
        } />

      {/* Pipeline board */}
      <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 6 }}>
        {stages.map((stage) => {
          const col = leads.filter((l) => l.stage === stage.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          return (
            <div key={stage.id} style={{ flex: "0 0 230px", background: "#fafafd", border: "1px solid #ececf4", borderRadius: 14, padding: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: STAGE_COLOR[stage.id] }} />
                <span style={{ fontSize: 12.5, fontWeight: 900, color: "#1a1a2e", flex: 1 }}>{stage.label}</span>
                <span style={{ fontSize: 11.5, fontWeight: 800, color: "#9898b0" }}>{col.length}</span>
              </div>
              {col.map((lead) => (
                <div key={lead.id} style={{ background: "#fff", border: "1px solid #ececf4", borderRadius: 10, padding: "9px 10px", marginBottom: 8 }}>
                  <button type="button" onClick={() => setEditing(lead)} style={{ border: "none", background: "none", padding: 0, textAlign: "left", cursor: "pointer", width: "100%" }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{lead.name}</div>
                    <div style={{ fontSize: 11, color: "#8a8aa3" }}>{lead.source}{lead.interest ? ` · ${lead.interest}` : ""}{lead.value ? ` · ${fmt(lead.value)}` : ""}</div>
                  </button>
                  {lead.clientId && (
                    <Link href={`/dashboard/clients/${lead.clientId}`} style={{ fontSize: 11, fontWeight: 800, color: "#059669", textDecoration: "none" }}>
                      ✓ Patient: {clientName(lead.clientId) ?? "open"}
                    </Link>
                  )}
                  <div style={{ display: "flex", gap: 4, marginTop: 7 }}>
                    {stage.id !== "lost" && <>
                      <button type="button" aria-label="Back a stage" onClick={() => move(lead, -1)} style={{ border: "1px solid #ececf4", background: "#fff", borderRadius: 7, padding: 4, cursor: "pointer", display: "flex" }}><ChevronLeft size={13} /></button>
                      <button type="button" aria-label="Next stage" onClick={() => move(lead, 1)} style={{ border: "1px solid #ececf4", background: "#fff", borderRadius: 7, padding: 4, cursor: "pointer", display: "flex" }}><ChevronRight size={13} /></button>
                    </>}
                    {lead.phone && (
                      <a href={`https://wa.me/${normalizePhone(lead.phone)}`} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp"
                        style={{ border: "1px solid #ececf4", borderRadius: 7, padding: 4, display: "flex", color: "#16a34a" }}><Send size={13} /></a>
                    )}
                    {!lead.clientId && (
                      <button type="button" onClick={() => convert(lead)} title="Create the patient record (or link the existing one)"
                        style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "#f5f3ff", color: "#7C3AED", borderRadius: 7, padding: "4px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                        <UserPlus size={12} /> Patient
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <label style={{ fontSize: 12, color: "#6b6b8a", display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={showLost} onChange={(e) => setShowLost(e.target.checked)} /> Show lost leads
      </label>

      {/* Marketing analytics */}
      <section>
        <div style={{ fontSize: 15, fontWeight: 900, color: "#1a1a2e", marginBottom: 4 }}>Where patients &amp; revenue come from</div>
        <div style={{ fontSize: 12, color: "#9898b0", marginBottom: 10 }}>Revenue is what converted leads have paid since they came in.</div>
        {bySource.length === 0 ? <div style={{ fontSize: 13, color: "#9898b0" }}>Add leads to see this.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#9898b0", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {["Source", "Leads", "Consultations", "Treatments", "Conversion", "Revenue"].map((h) => <th key={h} style={{ padding: "8px 10px", borderBottom: "1px solid #ececf4" }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {bySource.map(([source, r]) => (
                  <tr key={source}>
                    <td style={{ padding: "9px 10px", borderBottom: "1px solid #f4f4f8", fontWeight: 800 }}>{source}</td>
                    <td style={{ padding: "9px 10px", borderBottom: "1px solid #f4f4f8" }}>{r.leads}</td>
                    <td style={{ padding: "9px 10px", borderBottom: "1px solid #f4f4f8" }}>{r.consultations}</td>
                    <td style={{ padding: "9px 10px", borderBottom: "1px solid #f4f4f8" }}>{r.treatments}</td>
                    <td style={{ padding: "9px 10px", borderBottom: "1px solid #f4f4f8" }}>{Math.round((r.treatments / r.leads) * 100)}%</td>
                    <td style={{ padding: "9px 10px", borderBottom: "1px solid #f4f4f8", fontWeight: 800, color: "#059669" }}>{fmt(r.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <LeadForm initial={editing} clients={clients} onClose={() => setEditing(null)}
          onSave={(l) => { save(l); setEditing(null); }}
          onDelete={leads.some((l) => l.id === editing.id) ? () => { setLeads(removeRecord(getLeads, saveLeads, editing.id)); setEditing(null); } : undefined} />
      )}
    </div>
  );
}

function LeadForm({ initial, clients, onClose, onSave, onDelete }: {
  initial: Lead; clients: Client[]; onClose: () => void; onSave: (l: Lead) => void; onDelete?: () => void;
}) {
  const [l, setL] = useState(initial);
  const valid = l.name.trim().length > 1;
  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 520, maxHeight: "92vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 900, color: "#1a1a2e" }}>{onDelete ? "Lead" : "New lead"}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "rgba(0,0,0,0.06)", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}><X size={14} /></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ gridColumn: "1 / -1" }}><Lbl>Name</Lbl><input value={l.name} onChange={(e) => setL({ ...l, name: e.target.value })} style={INP} /></label>
          <label><Lbl>Phone</Lbl><input value={l.phone} onChange={(e) => setL({ ...l, phone: e.target.value })} inputMode="tel" style={INP} /></label>
          <label><Lbl>Source</Lbl>
            <select value={l.source} onChange={(e) => setL({ ...l, source: e.target.value })} style={INP}>{LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label><Lbl>Interested in</Lbl><input value={l.interest ?? ""} placeholder="e.g. Botox" onChange={(e) => setL({ ...l, interest: e.target.value })} style={INP} /></label>
          <label><Lbl>Expected value (PKR)</Lbl><input type="number" min={0} value={l.value ?? ""} onChange={(e) => setL({ ...l, value: Number(e.target.value) || undefined })} style={INP} /></label>
          <label><Lbl>Stage</Lbl>
            <select value={l.stage} onChange={(e) => setL({ ...l, stage: e.target.value as LeadStage })} style={INP}>{LEAD_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
          {l.source === "Referral" && (
            <label><Lbl>Referred by</Lbl>
              <select value={l.referredBy ?? ""} onChange={(e) => setL({ ...l, referredBy: e.target.value || undefined })} style={INP}>
                <option value="">—</option>
                {[...clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
          )}
          <label style={{ gridColumn: "1 / -1" }}><Lbl>Notes</Lbl><textarea rows={3} value={l.notes ?? ""} onChange={(e) => setL({ ...l, notes: e.target.value })} style={{ ...INP, resize: "vertical" }} /></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" disabled={!valid} onClick={() => onSave(l)}
            style={{ padding: "10px 16px", borderRadius: 10, border: "none", background: valid ? "#7C3AED" : "#e8e8f0", color: valid ? "#fff" : "#9898b0", fontSize: 13, fontWeight: 800, cursor: valid ? "pointer" : "not-allowed" }}>Save</button>
          {onDelete && (
            <button type="button" onClick={() => { if (window.confirm("Delete this lead?")) onDelete(); }}
              style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 14px", borderRadius: 10, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <span style={{ display: "block", fontSize: 10.5, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{children}</span>;
}
