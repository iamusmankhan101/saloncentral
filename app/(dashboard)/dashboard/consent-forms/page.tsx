"use client";

/**
 * Consent form templates for aesthetic clinics (lib/clinic.ts). The built-in
 * wording is only a starting point — the clinic's own doctor or legal adviser
 * should review it — so every template is editable here, and saving stores the
 * clinic's own copy in settings. Signed consents keep a snapshot of the text
 * they were signed against, so editing a template never changes those.
 */

import { useEffect, useState } from "react";
import { Check, FileSignature, Plus, RotateCcw, Trash2 } from "lucide-react";
import PageTitle from "@/components/page-title";
import { saveSettings, settingsStore } from "@/lib/settings-store";
import { getStoredServices } from "@/lib/storage";
import { DEFAULT_CONSENT_TEMPLATES, consentTemplates, newId, type ConsentTemplate } from "@/lib/clinic";
import type { Service } from "@/lib/types";

const INP: React.CSSProperties = { width: "100%", padding: "9px 11px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff", boxSizing: "border-box" };
const LABEL: React.CSSProperties = { fontSize: 10.5, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5, display: "block" };

export default function ConsentFormsPage() {
  const [templates, setTemplates] = useState<ConsentTemplate[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setTemplates(consentTemplates().map((t) => ({ ...t })));
    setServices(getStoredServices().filter((s) => s.isActive !== false));
  }, []);

  const update = (id: string, patch: Partial<ConsentTemplate>) => {
    setTemplates((list) => list.map((t) => t.id === id ? { ...t, ...patch } : t));
    setDirty(true);
  };

  async function save() {
    (settingsStore.clinic as { consentTemplates: ConsentTemplate[] | null }).consentTemplates = templates;
    await saveSettings();
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  }

  function add() {
    const t: ConsentTemplate = { id: newId("consent_tpl"), title: "New consent form", body: "", serviceIds: [], keywords: [], validDays: 365 };
    setTemplates((list) => [...list, t]);
    setOpenId(t.id);
    setDirty(true);
  }

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#ffffff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 18 }}>
      <PageTitle icon={<FileSignature size={24} />} title="Consent Forms"
        subtitle="The forms patients sign before treatment. Have your doctor or legal adviser review the wording before use." />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={save} disabled={!dirty}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 800, cursor: dirty ? "pointer" : "default",
            background: saved ? "#ecfdf5" : dirty ? "#7C3AED" : "#e8e8f0", color: saved ? "#059669" : dirty ? "#fff" : "#9898b0" }}>
          <Check size={14} /> {saved ? "Saved" : "Save changes"}
        </button>
        <button type="button" onClick={add} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "1px solid #e4e4ee", background: "#fff", fontSize: 13, fontWeight: 800, color: "#6b6b8a", cursor: "pointer" }}>
          <Plus size={14} /> New form
        </button>
        <button type="button"
          onClick={() => { if (window.confirm("Replace all forms with the built-in wording? Your edits will be lost once you save.")) { setTemplates(DEFAULT_CONSENT_TEMPLATES.map((t) => ({ ...t }))); setDirty(true); } }}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "1px solid #e4e4ee", background: "#fff", fontSize: 13, fontWeight: 800, color: "#6b6b8a", cursor: "pointer" }}>
          <RotateCcw size={14} /> Restore built-in forms
        </button>
      </div>

      {templates.map((t) => {
        const open = openId === t.id;
        return (
          <div key={t.id} style={{ border: "1px solid #e8e8f0", borderRadius: 14, overflow: "hidden" }}>
            <button type="button" onClick={() => setOpenId(open ? null : t.id)}
              style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "14px 16px", border: "none", background: open ? "#faf9ff" : "#fff", cursor: "pointer", textAlign: "left" }}>
              <FileSignature size={16} color="#7C3AED" />
              <span style={{ flex: 1, fontSize: 14, fontWeight: 800, color: "#1a1a2e" }}>{t.title || "Untitled form"}</span>
              <span style={{ fontSize: 11.5, color: "#8a8aa3" }}>
                {t.validDays > 0 ? `Valid ${t.validDays} days` : "Every session"} · {t.serviceIds.length + (t.keywords?.length ?? 0) > 0 ? `${t.serviceIds.length} linked, ${t.keywords?.length ?? 0} keywords` : "Not linked to any treatment"}
              </span>
            </button>
            {open && (
              <div style={{ padding: "4px 16px 16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <label style={{ gridColumn: "1 / -1" }}><span style={LABEL}>Title</span>
                  <input value={t.title} onChange={(e) => update(t.id, { title: e.target.value })} style={INP} /></label>
                <label style={{ gridColumn: "1 / -1" }}><span style={LABEL}>Form text</span>
                  <textarea rows={12} value={t.body} onChange={(e) => update(t.id, { body: e.target.value })} style={{ ...INP, resize: "vertical", lineHeight: 1.55 }} /></label>
                <label><span style={LABEL}>Signature valid for</span>
                  <select value={t.validDays} onChange={(e) => update(t.id, { validDays: Number(e.target.value) })} style={INP}>
                    <option value={0}>Sign again every session</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={180}>6 months</option>
                    <option value={365}>1 year</option>
                  </select></label>
                <label><span style={LABEL}>Also required for treatment names containing</span>
                  <input value={(t.keywords ?? []).join(", ")} placeholder="botox, anti-wrinkle"
                    onChange={(e) => update(t.id, { keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) })} style={INP} /></label>
                <div style={{ gridColumn: "1 / -1" }}>
                  <span style={LABEL}>Required for these treatments</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {services.map((s) => {
                      const on = t.serviceIds.includes(s.id);
                      return (
                        <button key={s.id} type="button" aria-pressed={on}
                          onClick={() => update(t.id, { serviceIds: on ? t.serviceIds.filter((id) => id !== s.id) : [...t.serviceIds, s.id] })}
                          style={{ padding: "5px 10px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontWeight: 700, border: `1.5px solid ${on ? "#7C3AED" : "#e4e4ee"}`, background: on ? "#f5f3ff" : "#fff", color: on ? "#7C3AED" : "#6b6b8a" }}>
                          {s.name}
                        </button>
                      );
                    })}
                    {services.length === 0 && <span style={{ fontSize: 12, color: "#9898b0" }}>Add treatments first.</span>}
                  </div>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <button type="button" onClick={() => { if (window.confirm(`Delete "${t.title}"? Already-signed copies are kept.`)) { setTemplates((list) => list.filter((x) => x.id !== t.id)); setDirty(true); } }}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 9, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                    <Trash2 size={13} /> Delete form
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
