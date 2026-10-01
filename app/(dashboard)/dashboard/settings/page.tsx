"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Store, Clock, Bell, Palette, Shield, Smartphone, ChevronRight, Check, Sparkles, Banknote, PrinterIcon } from "lucide-react";
import { settingsStore, saveSettings } from "@/lib/settings-store";
import { rasterizeLogoForThermal } from "@/lib/escpos-raster";
import { getActiveLocationFilter, locationName, updateActiveLocationDetails } from "@/lib/locations";
import PageTitle from "@/components/page-title";

const SECTIONS = [
  { id: "salon",         label: "Salon Profile",  icon: Store },
  { id: "hours",         label: "Business Hours", icon: Clock },
  { id: "notifications", label: "Notifications",  icon: Bell },
  { id: "appearance",    label: "Appearance",     icon: Palette },
  { id: "security",      label: "Security",       icon: Shield },
  { id: "whatsapp",      label: "WhatsApp",       icon: Smartphone },
  { id: "ai",            label: "AI Integrations", icon: Sparkles },
  { id: "decidr",        label: "Decidr Loyalty",  icon: Banknote },
  { id: "printer",       label: "Thermal Printer", icon: PrinterIcon },
];

const inp: CSSProperties = {
  width: "100%", padding: "10px 14px", borderRadius: 12,
  border: "1px solid #e3e0eb", fontSize: 13, color: "#1a1a2e",
  outline: "none", background: "#fff", boxSizing: "border-box",
  transition: "border-color 0.15s", boxShadow: "0 2px 8px rgba(0,0,0,0.01)",
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{label}</label>
      {hint && <div style={{ fontSize: 11, color: "#9898b0", marginBottom: 2 }}>{hint}</div>}
      {children}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <div onClick={onChange} style={{ width: 44, height: 24, borderRadius: 12, background: value ? "var(--accent)" : "#e3e0eb", cursor: "pointer", position: "relative", transition: "all 0.25s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: value ? 23 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "all 0.25s", boxShadow: "0 2px 6px rgba(0,0,0,0.15)" }} />
    </div>
  );
}

function SavedBanner() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#ecfdf5", borderRadius: 8, fontSize: 13, color: "#059669", fontWeight: 500 }}>
      <Check size={14} /> Changes saved successfully.
    </div>
  );
}

function SaveBar({ onSave }: { onSave: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 16, borderTop: "1px solid #f0f0f5", marginTop: 16 }}>
      <button onClick={onSave} style={{ padding: "10px 24px", borderRadius: 12, border: "none", background: "var(--accent-gradient)", fontSize: 13, fontWeight: 750, color: "#fff", cursor: "pointer", transition: "all 0.15s", boxShadow: "0 4px 14px var(--accent-glow)" }} className="hover-scale">
        Save Changes
      </button>
    </div>
  );
}

function SalonProfile() {
  const [form, setForm] = useState({ ...settingsStore.salon });
  const [saved, setSaved] = useState(false);
  const activeLocation = getActiveLocationFilter();
  const [branchName, setBranchName] = useState(() => locationName(activeLocation));
  const set = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));
  const save = () => {
    Object.assign(settingsStore.salon, form);
    updateActiveLocationDetails({ name: branchName, address: form.address, city: form.city });
    saveSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {saved && <SavedBanner />}
      <div style={{ padding: "10px 14px", borderRadius: 10, background: "#f5f3ff", color: "#6d28d9", fontSize: 12, fontWeight: 700 }}>
        Editing location: {branchName || locationName(activeLocation)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="Branch Name"><input value={branchName} onChange={(e) => setBranchName(e.target.value)} style={inp} /></Field>
        <Field label="Salon Name"><input value={form.name} onChange={(e) => set("name", e.target.value)} style={inp} /></Field>
        <Field label="Phone"><input value={form.phone} onChange={(e) => set("phone", e.target.value)} style={inp} /></Field>
        <Field label="Email"><input value={form.email} onChange={(e) => set("email", e.target.value)} style={inp} /></Field>
        <Field label="City"><input value={form.city} onChange={(e) => set("city", e.target.value)} style={inp} /></Field>
      </div>
      <Field label="Address"><input value={form.address} onChange={(e) => set("address", e.target.value)} style={inp} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="Currency">
          <select value={form.currency} onChange={(e) => set("currency", e.target.value)} style={inp}>
            <option value="PKR">PKR — Pakistani Rupee</option>
            <option value="USD">USD — US Dollar</option>
            <option value="AED">AED — UAE Dirham</option>
          </select>
        </Field>
        <Field label="Timezone">
          <select value={form.timezone} onChange={(e) => set("timezone", e.target.value)} style={inp}>
            <option value="Asia/Karachi">Asia/Karachi (PKT +5:00)</option>
            <option value="Asia/Dubai">Asia/Dubai (GST +4:00)</option>
            <option value="UTC">UTC</option>
          </select>
        </Field>
      </div>
      <SaveBar onSave={save} />
    </div>
  );
}

function BusinessHours() {
  const [hours, setHours] = useState(() => (settingsStore.hours as any[]).map((h: any) => ({ ...h })));
  const [saved, setSaved] = useState(false);
  const toggle = (i: number) => setHours((h: any[]) => h.map((r: any, idx: number) => idx === i ? { ...r, open: !r.open } : r));
  const setTime = (i: number, k: "from" | "to", v: string) => setHours((h: any[]) => h.map((r: any, idx: number) => idx === i ? { ...r, [k]: v } : r));
  const save = () => { hours.forEach((h: any, i: number) => Object.assign(settingsStore.hours[i], h)); saveSettings(); setSaved(true); setTimeout(() => setSaved(false), 3000); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {saved && <SavedBanner />}
      {hours.map((row: any, i: number) => (
        <div key={row.day} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 16px", background: "#f9f9fb", borderRadius: 10 }}>
          <div style={{ width: 100, fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>{row.day}</div>
          <Toggle value={row.open} onChange={() => toggle(i)} />
          {row.open ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
              <input type="time" value={row.from} onChange={(e) => setTime(i, "from", e.target.value)} style={{ ...inp, width: 120 }} />
              <span style={{ fontSize: 12, color: "#9898b0" }}>to</span>
              <input type="time" value={row.to} onChange={(e) => setTime(i, "to", e.target.value)} style={{ ...inp, width: 120 }} />
            </div>
          ) : (
            <span style={{ fontSize: 12, color: "#b0b0c8", fontStyle: "italic" }}>Closed</span>
          )}
        </div>
      ))}
      <SaveBar onSave={save} />
    </div>
  );
}

function Notifications() {
  const [prefs, setPrefs] = useState({ ...settingsStore.notifications });
  const [saved, setSaved] = useState(false);
  const toggle = (k: keyof typeof prefs) => setPrefs((p: any) => ({ ...p, [k]: !p[k] }));
  const save = () => { Object.assign(settingsStore.notifications, prefs); saveSettings(); setSaved(true); setTimeout(() => setSaved(false), 3000); };
  const reminderHours = Number(settingsStore.wasender.reminderHours) || 24;
  const rows = [
    { section: "Appointments", items: [
      { key: "apptReminder", label: "Appointment reminders", hint: `Send reminder ${reminderHours}h before (change lead time in Account → WhatsApp)` },
      { key: "apptConfirm",  label: "Booking confirmations", hint: "Notify client on booking" },
      { key: "noShow",       label: "No-show alerts",        hint: "Alert staff on no-shows" },
    ]},
    { section: "Reports", items: [
      { key: "dailySummary",  label: "Daily summary",    hint: "End-of-day revenue report" },
      { key: "weeklySummary", label: "Weekly summary",   hint: "Every Monday morning" },
      { key: "lowStock",      label: "Low stock alerts", hint: "When items fall below minimum" },
    ]},
    { section: "Channels", items: [
      { key: "whatsappNotify", label: "WhatsApp notifications", hint: "Send via WhatsApp" },
      { key: "emailNotify",    label: "Email notifications",    hint: "Send via email" },
    ]},
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {saved && <SavedBanner />}
      {rows.map(({ section, items }) => (
        <div key={section}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>{section}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {items.map(({ key, label, hint }) => (
              <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#f9f9fb", borderRadius: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e" }}>{label}</div>
                  <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{hint}</div>
                </div>
                <Toggle value={prefs[key as keyof typeof prefs]} onChange={() => toggle(key as keyof typeof prefs)} />
              </div>
            ))}
          </div>
        </div>
      ))}
      <SaveBar onSave={save} />
    </div>
  );
}

function Appearance() {
  const [form, setForm] = useState({ ...settingsStore.appearance });
  const [saved, setSaved] = useState(false);
  const colors = ["#7C3AED", "#db2777", "#0369a1", "#059669", "#d97706", "#dc2626"];
  const save = () => { Object.assign(settingsStore.appearance, form); saveSettings(); setSaved(true); setTimeout(() => setSaved(false), 3000); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {saved && <SavedBanner />}
      <Field label="Accent Color" hint="Used for buttons, highlights, and active states.">
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          {colors.map((c) => (
            <div key={c} onClick={() => setForm((f: any) => ({ ...f, accent: c }))} style={{ width: 32, height: 32, borderRadius: "50%", background: c, cursor: "pointer", boxShadow: form.accent === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : "none", transition: "all 0.15s" }} />
          ))}
        </div>
      </Field>
      <Field label="Date Format">
        <select value={form.dateFormat} onChange={(e) => setForm((f: any) => ({ ...f, dateFormat: e.target.value }))} style={inp}>
          <option>DD/MM/YYYY</option><option>MM/DD/YYYY</option><option>YYYY-MM-DD</option>
        </select>
      </Field>
      <Field label="Time Format">
        <select value={form.timeFormat} onChange={(e) => setForm((f: any) => ({ ...f, timeFormat: e.target.value }))} style={inp}>
          <option>12-hour (1:00pm)</option><option>24-hour (13:00)</option>
        </select>
      </Field>
      <SaveBar onSave={save} />
    </div>
  );
}

function Security() {
  const [form, setForm] = useState({ current: "", newPass: "", confirm: "" });
  const [saved, setSaved] = useState(false);
  const set = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));
  const canSave = form.current.length > 0 && form.newPass.length > 0 && form.newPass === form.confirm;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {saved && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#ecfdf5", borderRadius: 12, fontSize: 13, color: "#059669", fontWeight: 500 }}><Check size={14} /> Password updated successfully.</div>}
      <Field label="Current Password"><input type="password" value={form.current} onChange={(e) => set("current", e.target.value)} placeholder="••••••••" style={inp} /></Field>
      <Field label="New Password"><input type="password" value={form.newPass} onChange={(e) => set("newPass", e.target.value)} placeholder="••••••••" style={inp} /></Field>
      <Field label="Confirm New Password">
        <input type="password" value={form.confirm} onChange={(e) => set("confirm", e.target.value)} placeholder="••••••••" style={{ ...inp, borderColor: form.confirm && form.confirm !== form.newPass ? "#dc2626" : "#e3e0eb" }} />
        {form.confirm && form.confirm !== form.newPass && <div style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>Passwords do not match.</div>}
      </Field>
      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 16, borderTop: "1px solid #f0f0f5", marginTop: 16 }}>
        <button
          onClick={() => { if (canSave) { setSaved(true); setForm({ current: "", newPass: "", confirm: "" }); setTimeout(() => setSaved(false), 3000); } }}
          style={{ padding: "10px 24px", borderRadius: 12, border: "none", background: canSave ? "var(--accent-gradient)" : "#e3e0eb", fontSize: 13, fontWeight: 750, color: canSave ? "#fff" : "#9898b0", cursor: canSave ? "pointer" : "not-allowed", transition: "all 0.15s", boxShadow: canSave ? "0 4px 14px var(--accent-glow)" : "none" }}
          className={canSave ? "hover-scale" : ""}>
          Update Password
        </button>
      </div>
    </div>
  );
}

function WhatsAppSection() {
  const [form, setForm] = useState({ ...settingsStore.whatsapp });
  const [saved, setSaved] = useState(false);
  const ws = settingsStore.wasender;
  const activeCredential = ws.provider === "botsailor" ? ws.botSailorApiToken : ws.provider === "zaptick" ? ws.zaptickApiKey : ws.apiKey;
  const isConfigured = Boolean(activeCredential)
    && (ws.provider !== "botsailor" || Boolean(ws.botSailorPhoneNumberId));
  const [connectionState, setConnectionState] = useState<"checking" | "connected" | "disconnected" | "not-configured">(
    isConfigured ? "checking" : "not-configured",
  );

  useEffect(() => {
    if (!isConfigured) {
      setConnectionState("not-configured");
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({
      provider: ws.provider || "wasender",
      apiKey: ws.apiKey,
      botSailorApiToken: ws.botSailorApiToken || "",
      botSailorPhoneNumberId: ws.botSailorPhoneNumberId || "",
      zaptickApiKey: ws.zaptickApiKey || "",
      force: "1",
    });
    fetch(`/api/whatsapp/status?${params}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { connected?: boolean }) => setConnectionState(data.connected ? "connected" : "disconnected"))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setConnectionState("disconnected");
        }
      });
    return () => controller.abort();
  }, [isConfigured, ws.apiKey, ws.botSailorApiToken, ws.botSailorPhoneNumberId, ws.provider, ws.zaptickApiKey]);

  const save = () => { Object.assign(settingsStore.whatsapp, form); saveSettings(); setSaved(true); setTimeout(() => setSaved(false), 3000); };
  const connected = connectionState === "connected";
  const checking = connectionState === "checking";
  const statusTitle = checking
    ? "Checking WhatsApp…"
    : connected
      ? "WhatsApp Connected"
      : connectionState === "not-configured"
        ? "WhatsApp Not Configured"
        : "WhatsApp Disconnected";
  const statusDescription = checking
    ? "Verifying your provider connection"
    : connected
      ? `${ws.provider === "botsailor" ? "BotSailor" : "WaSender"} connection is active`
      : connectionState === "not-configured"
        ? "Add provider credentials in Account settings"
        : "The configured provider could not be reached";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {saved && <SavedBanner />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px", background: connected ? "#ecfdf5" : checking ? "#fffbeb" : "#fef2f2", borderRadius: 12, border: `1px solid ${connected ? "#bbf7d0" : checking ? "#fde68a" : "#fecaca"}` }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: connected ? "#059669" : checking ? "#b45309" : "#dc2626" }}>{statusTitle}</div>
          <div style={{ fontSize: 12, color: "#9898b0", marginTop: 2 }}>{statusDescription}</div>
        </div>
        <a href="/dashboard/account" style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #7C3AED", background: "#fff", fontSize: 12, fontWeight: 600, color: "#7C3AED", cursor: "pointer", textDecoration: "none" }}>
          {isConfigured ? "Manage" : "Configure"}
        </a>
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.08em" }}>Message Templates</div>
      {([
        { key: "reminder" as const,     label: "Appointment Reminder" },
        { key: "confirmation" as const, label: "Booking Confirmation" },
        { key: "followup" as const,     label: "Follow-up Message" },
      ]).map(({ key, label }) => (
        <Field key={key} label={label} hint="Variables: {name} {service} {date} {time}">
          <textarea value={form[key]} onChange={(e) => { const v = e.target.value; setForm((f: any) => ({ ...f, [key]: v })); }} rows={3} style={{ ...inp, resize: "none", lineHeight: 1.6 }} />
        </Field>
      ))}
      <SaveBar onSave={save} />
    </div>
  );
}

function AIIntegrations() {
  const [form, setForm] = useState({ 
    huggingFaceToken: (settingsStore.replicate as any)?.apiToken || "",
  });
  const [saved, setSaved] = useState(false);
  const save = () => { 
    if (!settingsStore.replicate) {
      (settingsStore as any).replicate = {};
    }
    (settingsStore.replicate as any).apiToken = form.huggingFaceToken;
    saveSettings();
    setSaved(true); 
    setTimeout(() => setSaved(false), 3000); 
  };
  
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {saved && <SavedBanner />}
      
      <div style={{ padding: "14px 16px", background: "#faf8ff", borderRadius: 10, border: "1px solid #EDE9FE" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#7C3AED", marginBottom: 6 }}>✨ Virtual Try-On with Stable Diffusion</div>
        <div style={{ fontSize: 12, color: "#6b6b8a", lineHeight: 1.6 }}>
          The virtual try-on feature uses free Stable Diffusion AI. No API key required! 
          Optionally add a Hugging Face token below for faster processing and higher rate limits.
        </div>
      </div>

      <Field 
        label="Hugging Face Token (Optional)" 
        hint="Get a free token at huggingface.co/settings/tokens · Enables faster AI generation"
      >
        <input 
          type="password" 
          value={form.huggingFaceToken} 
          onChange={(e) => setForm((f) => ({ ...f, huggingFaceToken: e.target.value }))} 
          placeholder="hf_••••••••••••••••••••••••••••••••" 
          style={inp} 
        />
      </Field>

      <div style={{ padding: "12px 14px", background: "#f9f9fb", borderRadius: 8, fontSize: 11, color: "#6b6b8a", lineHeight: 1.6 }}>
        <strong style={{ color: "#1a1a2e" }}>How to get a token:</strong>
        <ol style={{ margin: "8px 0 0 0", paddingLeft: 20 }}>
          <li>Visit <a href="https://huggingface.co/join" target="_blank" rel="noopener noreferrer" style={{ color: "#7C3AED" }}>huggingface.co</a> and sign up (free)</li>
          <li>Go to Settings → Access Tokens</li>
          <li>Create a new token with "Read" permissions</li>
          <li>Copy and paste it above</li>
        </ol>
      </div>

      <SaveBar onSave={save} />
    </div>
  );
}

function DecidrLoyalty() {
  const cb = settingsStore.cashback as { enabled: boolean; apiKey: string };
  const [form, setForm] = useState({ enabled: cb.enabled, apiKey: cb.apiKey });
  const [saved, setSaved] = useState(false);
  const save = () => {
    Object.assign(settingsStore.cashback, form);
    saveSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };
  const active = form.enabled && !!form.apiKey;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {saved && <SavedBanner />}

      <div style={{ padding: "14px 16px", background: active ? "#f0fdf4" : "#faf8ff", borderRadius: 10, border: `1px solid ${active ? "#6ee7b7" : "#ede9fe"}`, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: active ? "#dcfce7" : "#ede9fe", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Banknote size={18} color={active ? "#059669" : "#7C3AED"} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#065f46" : "#5b21b6" }}>
            {active ? "Cashback active — customers earn on every sale" : "Connect your Decidr cashback account"}
          </div>
          <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, lineHeight: 1.5 }}>
            {active
              ? "Balance is fetched automatically at checkout. Staff can also apply redemptions before completing a sale."
              : "Paste your API key below to automatically award and redeem cashback at POS checkout."}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#f9f9fb", borderRadius: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>Enable Decidr Cashback</div>
          <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>Award and redeem cashback at every POS checkout</div>
        </div>
        <Toggle value={form.enabled} onChange={() => setForm(f => ({ ...f, enabled: !f.enabled }))} />
      </div>

      <Field label="API Key" hint="Copy from your Decidr dashboard → POS tab → Generate Key">
        <input
          type="password"
          value={form.apiKey}
          onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
          placeholder="dlk_••••••••••••••••••••••••••••••••"
          style={inp}
        />
      </Field>

      <div style={{ padding: "12px 14px", background: "#f9f9fb", borderRadius: 8, fontSize: 11, color: "#6b6b8a", lineHeight: 1.7 }}>
        <div style={{ fontWeight: 700, color: "#1a1a2e", marginBottom: 6 }}>How to connect</div>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Sign in at <strong>loyalty.trydecidr.xyz</strong> with your Cashback Card account</li>
          <li>Open the <strong>POS</strong> tab and click <strong>Generate API Key</strong></li>
          <li>Copy the key (starts with <code style={{ fontFamily: "monospace", background: "#ededf4", padding: "1px 5px", borderRadius: 3 }}>dlk_</code>) and paste it above</li>
          <li>Enable the toggle, save — cashback is live at checkout</li>
        </ol>
      </div>

      <SaveBar onSave={save} />
    </div>
  );
}

function ThermalPrinterSection() {
  const p = settingsStore.printer as { enabled: boolean; ip: string; port: number; paperWidthMm?: number };
  const [form, setForm] = useState({ enabled: p.enabled, ip: p.ip, port: p.port || 9100, paperWidthMm: p.paperWidthMm || 80 });
  const [saved, setSaved]     = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState("");

  function save() {
    Object.assign(settingsStore.printer, form);
    saveSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function testPrint() {
    if (!form.ip) { setTestMsg("Enter a printer IP first."); return; }
    setTesting(true);
    setTestMsg("");
    try {
      // The test receipt carries the logo too — rasterizing it is the part of a
      // real receipt most likely to come out wrong (a logo too faint, too big,
      // or inverted), and this is where it can be checked without ringing up a
      // sale to do it.
      const salonLogo = (settingsStore.salon as { logo?: string }).logo || "";
      const logoRaster = salonLogo
        ? await rasterizeLogoForThermal(salonLogo, form.paperWidthMm)
        : null;
      const res = await fetch("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          printerIp: form.ip, printerPort: form.port, paperWidthMm: form.paperWidthMm,
          logo: logoRaster ?? undefined,
          salonName: (settingsStore.salon as { name: string }).name,
          salonPhone: (settingsStore.salon as { phone: string }).phone,
          salonAddress: (settingsStore.salon as { address: string }).address,
          currency: "PKR",
          invoice: {
            number: "TEST-001", date: new Date().toISOString().slice(0, 10),
            clientName: "Test Client", clientPhone: "", staffName: "Staff",
            items: [{ description: "Connection Test", qty: 1, total: 0 }],
            subtotal: 0, discountAmount: 0, taxAmount: 0, total: 0,
            paymentMethod: "cash", status: "paid", notes: "Printer test — if you see this, it works!",
          },
        }),
      });
      const json = await res.json();
      setTestMsg(json.ok ? "✓ Test receipt printed successfully!" : `✗ ${json.error}`);
    } catch (e: unknown) {
      setTestMsg(`✗ ${e instanceof Error ? e.message : "Failed"}`);
    } finally {
      setTesting(false);
    }
  }

  const connected = form.enabled && !!form.ip;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {saved && <SavedBanner />}

      {/* Status banner */}
      <div style={{ padding: "14px 16px", background: connected ? "#f0fdf4" : "#faf8ff", borderRadius: 10, border: `1px solid ${connected ? "#6ee7b7" : "#ede9fe"}`, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: connected ? "#dcfce7" : "#ede9fe", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <PrinterIcon size={18} color={connected ? "#059669" : "#7C3AED"} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: connected ? "#065f46" : "#5b21b6" }}>
            {connected ? "Thermal printer connected" : "No printer configured"}
          </div>
          <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>
            {connected ? `Sending to ${form.ip}:${form.port} — Speed-X 400ul (ESC/POS)` : "Enter the printer's LAN IP address to enable direct receipt printing."}
          </div>
        </div>
      </div>

      {/* Enable toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#f9f9fb", borderRadius: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a2e" }}>Enable Thermal Printing</div>
          <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>Show thermal print button on invoices</div>
        </div>
        <Toggle value={form.enabled} onChange={() => setForm(f => ({ ...f, enabled: !f.enabled }))} />
      </div>

      {/* IP */}
      <Field label="Printer IP Address" hint="Assign a static IP to the printer in your router. e.g. 192.168.1.100">
        <input
          type="text" value={form.ip} placeholder="192.168.1.100"
          onChange={e => setForm(f => ({ ...f, ip: e.target.value }))}
          style={inp}
        />
      </Field>

      {/* Port */}
      <Field label="Port" hint="Default is 9100 for all ESC/POS LAN printers — don't change unless needed.">
        <input
          type="number" value={form.port} min={1} max={65535}
          onChange={e => setForm(f => ({ ...f, port: parseInt(e.target.value) || 9100 }))}
          style={{ ...inp, maxWidth: 140 }}
        />
      </Field>

      {/* USB printers can't use any of this — say so before they fill in an IP. */}
      <div style={{ padding: "12px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, fontSize: 11.5, color: "#92400e", lineHeight: 1.7, marginBottom: 4 }}>
        <strong>USB printer?</strong> This section only reaches printers with a network port
        (LAN/Ethernet). A USB-only model — the Speed-X SP-200u, for example — has no IP address
        to send to. Install its Windows driver on the till PC, then use{" "}
        <strong>Print 80mm Receipt</strong> on any invoice to print through the driver instead.
      </div>

      {/* Paper width */}
      <Field label="Paper Width" hint="Must match the roll actually loaded. 80mm prints 48 characters per line, 58mm prints 32 — the wrong setting is what makes receipts come out too narrow or overflow.">
        <select
          value={form.paperWidthMm}
          onChange={e => setForm(f => ({ ...f, paperWidthMm: parseInt(e.target.value) || 80 }))}
          style={{ ...inp, maxWidth: 220 }}
        >
          <option value={80}>80 mm (standard — Speed-X 400ul)</option>
          <option value={58}>58 mm (compact roll)</option>
        </select>
      </Field>

      {/* Setup guide */}
      <div style={{ padding: "12px 14px", background: "#f9f9fb", borderRadius: 8, fontSize: 11, color: "#6b6b8a", lineHeight: 1.7 }}>
        <div style={{ fontWeight: 700, color: "#1a1a2e", marginBottom: 6 }}>Setup guide (Speed-X 400ul)</div>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Connect the printer to your router with an RJ-45 LAN cable</li>
          <li>Print a self-test page (hold Feed button on power-on) — note the IP shown</li>
          <li>In your router admin, assign that IP as a static/reserved address</li>
          <li>Enter the IP above, save, then click <strong>Test Print</strong></li>
        </ol>
      </div>

      {/* Test result */}
      {testMsg && (
        <div style={{ padding: "10px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
          background: testMsg.startsWith("✓") ? "#f0fdf4" : "#fef2f2",
          color: testMsg.startsWith("✓") ? "#065f46" : "#991b1b",
          border: `1px solid ${testMsg.startsWith("✓") ? "#6ee7b7" : "#fca5a5"}`,
        }}>
          {testMsg}
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={testPrint} disabled={testing} style={{
          padding: "10px 20px", borderRadius: 9, border: "1.5px solid #e8e8f0",
          background: "#fff", fontSize: 13, fontWeight: 700, color: "#5a5a7a",
          cursor: testing ? "not-allowed" : "pointer", opacity: testing ? 0.6 : 1,
        }}>
          {testing ? "Printing…" : "Test Print"}
        </button>
        <SaveBar onSave={save} />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [active, setActive] = useState("salon");

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", padding: "32px 32px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <div className="page-header" style={{ marginBottom: 4 }}>
        <PageTitle icon={<Shield size={24} />} title="Settings" subtitle="Manage your salon preferences" />
      </div>

      <div className="settings-layout" style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 24, alignItems: "start" }}>
        <div className="settings-nav" style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", boxShadow: "0 4px 16px rgba(0,0,0,0.02)", overflow: "hidden", padding: "8px 0" }}>
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const isActive = active === id;
            return (
              <button key={id} onClick={() => setActive(id)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", background: isActive ? "var(--accent-light)" : "transparent", border: "none", borderLeft: `3px solid ${isActive ? "var(--accent)" : "transparent"}`, cursor: "pointer", transition: "all 0.15s" }} className={isActive ? "" : "hover-bg-light"}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Icon size={16} color={isActive ? "var(--accent)" : "#6b6b8a"} />
                  <span style={{ fontSize: 13, fontWeight: isActive ? 750 : 500, color: isActive ? "var(--accent-dark)" : "#1a1a2e" }}>{label}</span>
                </div>
                <ChevronRight size={14} color={isActive ? "var(--accent)" : "#d0d0e0"} />
              </button>
            );
          })}
        </div>

        <div className="settings-content" style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", padding: "30px 32px" }}>
          {SECTIONS.map(({ id, label }) => (
            <div key={id} style={{ display: active === id ? "block" : "none" }}>
              <div style={{ fontWeight: 800, fontSize: 18, color: "#1a1a2e", marginBottom: 24 }}>{label}</div>
              {id === "salon"         && <SalonProfile />}
              {id === "hours"         && <BusinessHours />}
              {id === "notifications" && <Notifications />}
              {id === "appearance"    && <Appearance />}
              {id === "security"      && <Security />}
              {id === "whatsapp"      && <WhatsAppSection />}
              {id === "ai"            && <AIIntegrations />}
              {id === "decidr"        && <DecidrLoyalty />}
              {id === "printer"       && <ThermalPrinterSection />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
