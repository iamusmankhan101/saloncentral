"use client";

/**
 * Create a business straight from the console, and edit an account's contact
 * details. Both post to /api/admin/users and hand the refreshed account list
 * back to the page.
 */

import { useState } from "react";
import { Copy, Pencil, UserPlus } from "lucide-react";
import { Modal } from "./ui";
import type { PlatformStats, PlatformUser } from "@/lib/pointly/types";
import { BUSINESS_TYPES, SIGNUP_BUSINESS_TYPE_IDS, type BusinessTypeId } from "@/lib/pointly/business-types";
import { PLAN_IDS, PLANS, planPriceLabel, type PlanId } from "@/lib/pointly/plans";

type ListUpdate = { users: PlatformUser[]; stats: PlatformStats };
type Toast = (toast: { tone: "ok" | "bad"; text: string }) => void;

const label: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 800, color: "#6b6b8a", marginBottom: 6,
  letterSpacing: "0.04em", textTransform: "uppercase",
};

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/admin/pointly/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ ok: boolean; error?: string; password?: string; created?: { id: string; email: string } } & Partial<ListUpdate>>;
}

export function CreateAccountModal({ onClose, onDone, onToast }: {
  onClose: () => void;
  onDone: (update: ListUpdate, createdId: string) => void;
  onToast: Toast;
}) {
  const [form, setForm] = useState({
    ownerName: "", businessName: "", email: "", phone: "", password: "",
    businessType: "restaurant" as BusinessTypeId, plan: "starter" as PlanId,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.ownerName.trim() && form.businessName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())
    && (form.password === "" || form.password.length >= 8);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const data = await post({ action: "create", ...form });
      if (!data.ok || !data.users || !data.stats || !data.created) { setError(data.error || "Could not create the account."); return; }
      onDone({ users: data.users, stats: data.stats }, data.created.id);
      if (data.password) setIssued({ email: data.created.email, password: data.password });
      else { onToast({ tone: "ok", text: `Created ${form.businessName.trim()}.` }); onClose(); }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (issued) {
    return (
      <Modal title="Account created" icon={<UserPlus size={17} color="#047857" />} onClose={onClose}
        footer={<button type="button" className="ac-btn ac-btn-primary" onClick={onClose}>Done</button>}>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "#6b6b8a", lineHeight: 1.65 }}>
          <strong style={{ color: "#1a1a2e" }}>{issued.email}</strong> is approved and can sign in now on the Admin tab.
          This password is shown once — pass it on and ask them to change it in Settings → Security.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderRadius: 12, background: "#f8f8fc", border: "1px dashed #d6d6e6" }}>
          <code style={{ flex: 1, fontSize: 15, fontWeight: 800, letterSpacing: "0.06em", color: "#1a1a2e", wordBreak: "break-all" }}>{issued.password}</code>
          <button type="button" className="ac-btn" onClick={() => {
            navigator.clipboard?.writeText(`${issued.email}\n${issued.password}`)
              .then(() => onToast({ tone: "ok", text: "Email and password copied." }))
              .catch(() => onToast({ tone: "bad", text: "Copy failed — select it by hand." }));
          }}>
            <Copy size={13} /> Copy
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="New business account" icon={<UserPlus size={17} color="#c2410c" />} width={540} onClose={onClose}
      footer={
        <>
          <button type="button" className="ac-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ac-btn ac-btn-primary" disabled={busy || !valid} onClick={submit}>
            <UserPlus size={13} /> {busy ? "Creating…" : "Create account"}
          </button>
        </>
      }>
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <span style={label}>Type of business</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
            {SIGNUP_BUSINESS_TYPE_IDS.map((id) => {
              const on = form.businessType === id;
              return (
                <button key={id} type="button" aria-pressed={on} onClick={() => set("businessType", id)} title={BUSINESS_TYPES[id].name}
                  style={{
                    padding: "9px 4px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 800,
                    border: `1.5px solid ${on ? "#EA580C" : "#e4e4ef"}`, background: on ? "#fff7ed" : "#fff", color: on ? "#c2410c" : "#43435f",
                  }}>
                  {BUSINESS_TYPES[id].shortName}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={label} htmlFor="ca-business">Business name</label>
            <input id="ca-business" className="ac-input" autoFocus placeholder={BUSINESS_TYPES[form.businessType].exampleName}
              value={form.businessName} onChange={(e) => set("businessName", e.target.value)} />
          </div>
          <div>
            <label style={label} htmlFor="ca-owner">Owner name</label>
            <input id="ca-owner" className="ac-input" value={form.ownerName} onChange={(e) => set("ownerName", e.target.value)} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={label} htmlFor="ca-email">Email (their login)</label>
            <input id="ca-email" className="ac-input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </div>
          <div>
            <label style={label} htmlFor="ca-phone">Phone (optional)</label>
            <input id="ca-phone" className="ac-input" type="tel" placeholder="+92 300 1234567" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={label} htmlFor="ca-plan">Plan</label>
            <select id="ca-plan" className="ac-input" style={{ cursor: "pointer" }} value={form.plan} onChange={(e) => set("plan", e.target.value as PlanId)}>
              {PLAN_IDS.map((id) => <option key={id} value={id}>{PLANS[id].name} — {planPriceLabel(PLANS[id])}</option>)}
            </select>
          </div>
          <div>
            <label style={label} htmlFor="ca-password">Password (optional)</label>
            <input id="ca-password" className="ac-input" type="text" autoComplete="off" placeholder="Leave empty to generate"
              value={form.password} onChange={(e) => set("password", e.target.value)} />
            {form.password.length > 0 && form.password.length < 8 && (
              <div style={{ fontSize: 11, color: "#b91c1c", fontWeight: 650, marginTop: 5 }}>At least 8 characters.</div>
            )}
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: "#8b8ba3", lineHeight: 1.55 }}>
          The account is approved straight away — no sign-up or approval step. Set a custom price or record a payment from the Billing tab.
        </div>
        {error && <div style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c" }}>{error}</div>}
      </div>
    </Modal>
  );
}

export function EditProfileModal({ user, onClose, onDone, onToast }: {
  user: PlatformUser;
  onClose: () => void;
  onDone: (update: ListUpdate) => void;
  onToast: Toast;
}) {
  const [form, setForm] = useState({
    ownerName: user.ownerName ?? "",
    businessName: user.businessName ?? "",
    email: user.email,
    phone: user.phone ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const isTeam = Boolean(user.businessOwnerId);
  const emailChanged = form.email.trim().toLowerCase() !== user.email;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const data = await post({ action: "update-profile", userId: user.id, ...form });
      if (!data.ok || !data.users || !data.stats) { setError(data.error || "Could not save."); return; }
      onDone({ users: data.users, stats: data.stats });
      onToast({ tone: "ok", text: `Saved ${form.ownerName.trim() || form.email}.` });
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit details" icon={<Pencil size={16} color="#c2410c" />} width={500} onClose={onClose}
      footer={
        <>
          <button type="button" className="ac-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ac-btn ac-btn-primary" disabled={busy || !form.ownerName.trim() || !form.email.trim()} onClick={submit}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      }>
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={label} htmlFor="ep-owner">Name</label>
            <input id="ep-owner" className="ac-input" autoFocus value={form.ownerName} onChange={(e) => set("ownerName", e.target.value)} />
          </div>
          <div>
            <label style={label} htmlFor="ep-business">Business name</label>
            <input id="ep-business" className="ac-input" value={form.businessName} disabled={isTeam}
              title={isTeam ? "Follows the business owner's account" : undefined}
              onChange={(e) => set("businessName", e.target.value)} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={label} htmlFor="ep-email">Email (login)</label>
            <input id="ep-email" className="ac-input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </div>
          <div>
            <label style={label} htmlFor="ep-phone">Phone</label>
            <input id="ep-phone" className="ac-input" type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
        </div>
        {emailChanged && (
          <div style={{ padding: "10px 12px", borderRadius: 10, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 11.5, color: "#92400e", lineHeight: 1.55 }}>
            They&apos;ll sign in with the new email from now on. Their password doesn&apos;t change.
          </div>
        )}
        {!isTeam && (
          <div style={{ fontSize: 11.5, color: "#8b8ba3" }}>A new business name also shows on this business&apos;s team logins.</div>
        )}
        {error && <div style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c" }}>{error}</div>}
      </div>
    </Modal>
  );
}
