"use client";

/** Admin panel: set and test one salon's WhatsApp provider setup (salons never see it). */

import { useEffect, useState } from "react";
import { X, Check, AlertCircle, Loader2 } from "lucide-react";

type Setup = Record<string, string>;
type Provider = "wasender" | "botsailor" | "zaptick" | "chakra" | "ycloud";

const TEMPLATE_KINDS: [string, string][] = [
  ["Reminder", "Reminder"], ["Confirmation", "Confirmation"], ["Followup", "Follow-up"],
  ["Cancellation", "Cancellation"], ["Birthday", "Birthday"], ["Winback", "Win-back"],
];

const FIELDS: Record<Provider, [key: string, label: string, secret?: boolean][]> = {
  wasender: [["apiKey", "WaSender API Key", true]],
  botsailor: [["botSailorApiToken", "BotSailor API Token", true], ["botSailorPhoneNumberId", "WhatsApp Phone Number ID"],
    ...TEMPLATE_KINDS.map(([k, l]) => [`botSailorTemplate${k}`, `${l} template`] as [string, string])],
  zaptick: [["zaptickApiKey", "Zaptick API Key", true]],
  chakra: [["chakraAccessToken", "ChakraHQ Access Token", true], ["chakraPluginId", "Plugin ID"], ["chakraWhatsappPhoneNumberId", "WhatsApp Phone Number ID"],
    ...TEMPLATE_KINDS.map(([k, l]) => [`chakraTemplate${k}`, `${l} template`] as [string, string])],
  ycloud: [["ycloudApiKey", "YCloud API Key", true], ["ycloudFromNumber", "Salon's WhatsApp number (e.g. +923001234567)"],
    ["ycloudTemplateLanguage", "Template language (e.g. en)"], ["ycloudTemplateDefault", "Default template (used when no specific one)"],
    ...TEMPLATE_KINDS.map(([k, l]) => [`ycloudTemplate${k}`, `${l} template`] as [string, string])],
};

export default function AdminWhatsAppModal({ userId, salonName, onClose }: { userId: string; salonName: string; onClose: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch(`/api/admin/whatsapp?userId=${encodeURIComponent(userId)}`)
      .then((r) => r.json())
      .then((d) => { if (!d.ok) throw new Error(d.error); setSetup(Object.fromEntries(Object.entries(d.setup ?? {}).map(([k, v]) => [k, String(v ?? "")]))); })
      .catch((e) => { setSetup({ provider: "wasender" }); setNotice({ ok: false, text: e instanceof Error && e.message ? e.message : "Couldn't load this salon's WhatsApp setup." }); });
  }, [userId]);

  const provider = ((setup?.provider as Provider) || "wasender");
  const set = (k: string, v: string) => setSetup((s) => ({ ...(s ?? {}), [k]: v }));

  async function save() {
    setBusy("save"); setNotice(null);
    try {
      const r = await fetch("/api/admin/whatsapp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, setup }) });
      const d = await r.json();
      setNotice(d.ok ? { ok: true, text: d.connected ? "Saved. The salon now shows WhatsApp as connected." : "Saved — but no API key is set, so WhatsApp stays off for this salon." } : { ok: false, text: d.error || "Save failed." });
    } catch { setNotice({ ok: false, text: "Save failed — check your connection." }); }
    setBusy("");
  }

  async function test() {
    setBusy("test"); setNotice(null);
    try {
      const r = await fetch("/api/admin/whatsapp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, test: true }) });
      const d = await r.json();
      setNotice({ ok: !!d.connected, text: d.connected ? `Connected${d.status ? ` (${d.status})` : ""}.` : (d.message || d.error || "Not connected.") });
    } catch { setNotice({ ok: false, text: "Couldn't reach the provider." }); }
    setBusy("");
  }

  const input: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid #e3e0eb", fontSize: 13, color: "#1a1a2e", background: "#fff", boxSizing: "border-box" };
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#8e89a3", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 5 };
  const btn = (primary: boolean): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: busy ? "wait" : "pointer",
    border: primary ? "none" : "1px solid #ddd6fe", background: primary ? "linear-gradient(135deg,#5B21B6,#9333EA)" : "#fff", color: primary ? "#fff" : "#6d28d9" });

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 200 }}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: 560, maxWidth: "100%", maxHeight: "90dvh", overflowY: "auto", padding: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: "#1a1a2e" }}>WhatsApp connection</div>
            <div style={{ fontSize: 12, color: "#8e89a3", marginTop: 2 }}>{salonName}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "#f5f5fa", borderRadius: 8, width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><X size={16} /></button>
        </div>
        <p style={{ fontSize: 12, color: "#6b6b8a", lineHeight: 1.5, margin: "6px 0 16px" }}>
          Only you can see these. The salon just sees whether WhatsApp is connected; its message settings (reminders, templates, groups) stay in its own Account page.
        </p>

        {!setup ? (
          <div style={{ padding: 30, textAlign: "center", color: "#9898b0" }}><Loader2 size={20} /></div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <label>
              <span style={label}>Provider</span>
              <select value={provider} onChange={(e) => set("provider", e.target.value)} style={input}>
                <option value="wasender">WaSenderAPI</option>
                <option value="botsailor">BotSailor</option>
                <option value="zaptick">Zaptick.io</option>
                <option value="chakra">ChakraHQ</option>
                <option value="ycloud">YCloud (official, no markup)</option>
              </select>
            </label>
            {provider === "ycloud" && (
              <div style={{ fontSize: 12, color: "#4a4a6a", background: "#f5f3ff", border: "1px solid #ede9fe", borderRadius: 10, padding: "10px 12px", lineHeight: 1.55 }}>
                In YCloud, create <strong>Utility</strong> templates with one variable, e.g. <code>{"Update from your salon: {{1}} Thank you!"}</code> (the app fills in the whole message; Meta rejects a variable at the very start or end), get them approved, and enter their names here.
                One <strong>Default template</strong> is enough to start; per-type ones are optional. Without any template, messages only reach customers who messaged the salon in the last 24 hours.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {FIELDS[provider].map(([key, text, secret]) => (
                <label key={key} style={{ gridColumn: secret ? "1 / -1" : undefined }}>
                  <span style={label}>{text}</span>
                  <input type={secret ? "password" : "text"} autoComplete="off" value={setup[key] ?? ""} onChange={(e) => set(key, e.target.value)} style={input} />
                </label>
              ))}
            </div>
            {notice && (
              <div role={notice.ok ? "status" : "alert"} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, fontSize: 12.5, fontWeight: 600,
                background: notice.ok ? "#ecfdf5" : "#fef2f2", color: notice.ok ? "#047857" : "#b91c1c" }}>
                {notice.ok ? <Check size={15} style={{ flexShrink: 0 }} /> : <AlertCircle size={15} style={{ flexShrink: 0 }} />} {notice.text}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" onClick={test} disabled={!!busy} style={btn(false)}>{busy === "test" ? "Testing…" : "Test saved connection"}</button>
              <button type="button" onClick={save} disabled={!!busy} style={btn(true)}>{busy === "save" ? "Saving…" : "Save"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
