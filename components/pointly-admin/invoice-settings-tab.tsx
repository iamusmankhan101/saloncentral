"use client";

// Payment methods and Invoice details tabs of the admin console — what prints
// on every business's subscription invoice besides the payment itself.
// Everything is read from and written through /api/admin/invoice-settings.
// Same shape as Salon Central's admin tabs of the same names.

import { useEffect, useState } from "react";
import { AlertTriangle, FileText, Landmark, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Modal } from "./ui";
import {
  BILLED_FROM_FIELDS, DEFAULT_BANK_DETAILS, DEFAULT_BILLED_FROM,
  type BilledFrom, type PaymentMethod,
} from "@/lib/pointly/invoice-settings";

type Toast = (toast: { tone: "ok" | "bad"; text: string }) => void;

type Settings = { billedFrom: BilledFrom; methods: PaymentMethod[] };

async function call(body?: Record<string, unknown>): Promise<Settings & { method?: PaymentMethod }> {
  const res = await fetch("/api/admin/pointly/invoice-settings", body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) }
    : { cache: "no-store", credentials: "same-origin" });
  const data = await res.json() as { ok: boolean; error?: string } & Partial<Settings> & { method?: PaymentMethod };
  if (!data.ok) throw new Error(data.error || "That didn't go through.");
  return data as Settings & { method?: PaymentMethod };
}

const card: React.CSSProperties = {
  background: "#fff", border: "1px solid #ececf4", borderRadius: 16, overflow: "hidden", boxShadow: "0 6px 18px rgba(30,20,10,0.04)",
};
const fieldLabel: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 800, color: "#6b6b8a", marginBottom: 6, letterSpacing: "0.04em", textTransform: "uppercase",
};

function Loading({ what }: { what: string }) {
  return <div style={{ ...card, padding: 48, textAlign: "center", fontSize: 13, color: "#9898b0", fontWeight: 650 }}>Loading {what}…</div>;
}

// ─── Payment methods ──────────────────────────────────────────────────────────

type MethodDraft = { id: string | null; label: string; bankName: string; bankTitle: string; accountNumber: string; iban: string };
const METHOD_FIELDS: { key: Exclude<keyof MethodDraft, "id">; label: string; hint?: string; mono?: boolean }[] = [
  { key: "label", label: "Label", hint: "Only you see this — e.g. “Tareez Tech — Alfalah”." },
  { key: "bankName", label: "Bank name", hint: "e.g. Bank Alfalah" },
  { key: "bankTitle", label: "Account title" },
  { key: "accountNumber", label: "Account number", mono: true },
  { key: "iban", label: "IBAN", mono: true },
];

export function PaymentMethodsTab({ onToast }: { onToast: Toast }) {
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [draft, setDraft] = useState<MethodDraft | null>(null);
  const [deleting, setDeleting] = useState<PaymentMethod | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call().then((data) => setMethods(data.methods)).catch((err) => {
      onToast({ tone: "bad", text: err instanceof Error ? err.message : "Could not load payment methods." });
      setMethods([]);
    });
  }, [onToast]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const { id, ...fields } = draft;
      const data = await call(id ? { action: "update-method", id, ...fields } : { action: "create-method", ...fields });
      setMethods(data.methods);
      onToast({ tone: "ok", text: id ? `Saved ${fields.label}.` : `Added ${fields.label}.` });
      setDraft(null);
    } catch (err) {
      onToast({ tone: "bad", text: err instanceof Error ? err.message : "Failed to save." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      const data = await call({ action: "delete-method", id: deleting.id });
      setMethods(data.methods);
      onToast({ tone: "ok", text: `Deleted ${deleting.label}.` });
      setDeleting(null);
    } catch (err) {
      onToast({ tone: "bad", text: err instanceof Error ? err.message : "Failed to delete." });
    } finally {
      setBusy(false);
    }
  }

  if (!methods) return <Loading what="payment methods" />;
  const draftValid = draft && METHOD_FIELDS.every(({ key }) => draft[key].trim());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <style>{`
        .pm-row { display: grid; grid-template-columns: 1.1fr 0.9fr 1fr 1fr 1.3fr 80px; gap: 12px; align-items: center; padding: 13px 18px; }
        @media (max-width: 900px) {
          .pm-row { grid-template-columns: 1fr auto; row-gap: 4px; }
          .pm-head { display: none !important; }
          .pm-cell-extra { grid-column: 1 / -1; }
        }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "#6b6b8a" }}>
          Bank accounts you can assign to a business on the Billing tab (tag button). A business without one shows the default account.
        </div>
        <button type="button" className="ac-btn ac-btn-primary"
          onClick={() => setDraft({ id: null, label: "", bankName: "", bankTitle: "", accountNumber: "", iban: "" })}>
          <Plus size={14} /> Add payment method
        </button>
      </div>

      <div style={card}>
        <div className="pm-row pm-head" style={{ background: "#fafafd", borderBottom: "1px solid #ececf4", fontSize: 10.5, fontWeight: 800, color: "#8b8ba3", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          <span>Label</span><span>Bank</span><span>Account title</span><span>Account number</span><span>IBAN</span><span />
        </div>
        {methods.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", fontSize: 13, color: "#9898b0" }}>
            No payment methods yet — every business&apos;s invoice shows the default account ({DEFAULT_BANK_DETAILS.bankTitle}, {DEFAULT_BANK_DETAILS.bankName}) until you add one.
          </div>
        ) : methods.map((m, i) => (
          <div key={m.id} className="pm-row" style={{ borderTop: i ? "1px solid #f4f4f8" : "none" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{m.label}</div>
            <div className="pm-cell-extra" style={{ fontSize: 12.5, color: "#4a4a6a" }}>{m.bankName || "—"}</div>
            <div className="pm-cell-extra" style={{ fontSize: 12.5, color: "#4a4a6a" }}>{m.bankTitle}</div>
            <div className="pm-cell-extra" style={{ fontSize: 12.5, color: "#4a4a6a", fontFamily: "ui-monospace, monospace" }}>{m.accountNumber}</div>
            <div className="pm-cell-extra" style={{ fontSize: 12.5, color: "#4a4a6a", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{m.iban}</div>
            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", gridRow: 1, gridColumn: "-2 / -1" }}>
              <button type="button" className="ac-btn" style={{ padding: "7px 9px" }} title="Edit" aria-label={`Edit ${m.label}`}
                onClick={() => setDraft({ id: m.id, label: m.label, bankName: m.bankName, bankTitle: m.bankTitle, accountNumber: m.accountNumber, iban: m.iban })}>
                <Pencil size={13} />
              </button>
              <button type="button" className="ac-btn" style={{ padding: "7px 9px", color: "#b91c1c" }} title="Delete" aria-label={`Delete ${m.label}`}
                onClick={() => setDeleting(m)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <Modal
          title={draft.id ? "Edit payment method" : "New payment method"}
          icon={<Landmark size={18} color="#EA580C" />}
          onClose={() => { if (!busy) setDraft(null); }}
          footer={<>
            <button type="button" className="ac-btn" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className="ac-btn ac-btn-primary" disabled={busy || !draftValid} onClick={save}>
              <Save size={13} /> {busy ? "Saving…" : "Save"}
            </button>
          </>}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {METHOD_FIELDS.map(({ key, label, hint, mono }) => (
              <label key={key}>
                <span style={fieldLabel}>{label}</span>
                <input className="ac-input" value={draft[key]} disabled={busy} autoFocus={key === "label"}
                  style={mono ? { fontFamily: "ui-monospace, monospace" } : undefined}
                  onChange={(e) => setDraft((d) => d && { ...d, [key]: e.target.value })} />
                {hint && <span style={{ display: "block", fontSize: 10.5, color: "#a5a5bb", marginTop: 4 }}>{hint}</span>}
              </label>
            ))}
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal
          title="Delete payment method?"
          icon={<AlertTriangle size={18} color="#b91c1c" />}
          onClose={() => { if (!busy) setDeleting(null); }}
          footer={<>
            <button type="button" className="ac-btn" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="ac-btn" disabled={busy} onClick={remove}
              style={{ background: "#b91c1c", borderColor: "#b91c1c", color: "#fff" }}>
              <Trash2 size={13} /> {busy ? "Deleting…" : "Delete"}
            </button>
          </>}
        >
          <div style={{ fontSize: 13, color: "#4a4a6a", lineHeight: 1.6 }}>
            Delete <strong>{deleting.label}</strong>? Any business using it will show the default account ({DEFAULT_BANK_DETAILS.bankTitle}) on its invoices.
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Invoice details ──────────────────────────────────────────────────────────

export function InvoiceDetailsTab({ onToast }: { onToast: Toast }) {
  const [saved, setSaved] = useState<BilledFrom | null>(null);
  const [draft, setDraft] = useState<BilledFrom>(DEFAULT_BILLED_FROM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    call().then((data) => { setSaved(data.billedFrom); setDraft(data.billedFrom); }).catch((err) =>
      onToast({ tone: "bad", text: err instanceof Error ? err.message : "Could not load invoice details." }));
  }, [onToast]);

  const dirty = saved !== null && BILLED_FROM_FIELDS.some(({ key }) => draft[key] !== saved[key]);

  async function save() {
    setSaving(true);
    try {
      const data = await call({ action: "save-billed-from", ...draft });
      setSaved(data.billedFrom);
      setDraft(data.billedFrom);
      onToast({ tone: "ok", text: "Saved — every business's invoice now shows these details." });
    } catch (err) {
      onToast({ tone: "bad", text: err instanceof Error ? err.message : "Failed to save." });
    } finally {
      setSaving(false);
    }
  }

  if (!saved) return <Loading what="invoice details" />;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
      <div style={card}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f6", fontSize: 13.5, fontWeight: 800, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 8 }}>
          <FileText size={15} color="#EA580C" /> Billed From
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, color: "#8b8ba3", lineHeight: 1.6 }}>
            Shown at the top of every business&apos;s subscription invoice.
          </div>
          {BILLED_FROM_FIELDS.map(({ key, label, placeholder, hint }) => (
            <label key={key}>
              <span style={fieldLabel}>{label}</span>
              <input className="ac-input" value={draft[key]} placeholder={placeholder} disabled={saving}
                onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))} />
              {hint && <span style={{ display: "block", fontSize: 10.5, color: "#a5a5bb", marginTop: 4 }}>{hint}</span>}
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="ac-btn" disabled={!dirty || saving} onClick={() => setDraft(saved)}>Undo changes</button>
            <button type="button" className="ac-btn ac-btn-primary" disabled={!dirty || saving || !draft.name.trim()} onClick={save}>
              <Save size={13} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f6", fontSize: 13.5, fontWeight: 800, color: "#1a1a2e" }}>Preview</div>
        <div style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: "-0.03em", color: "#EA580C" }}>{draft.name || "—"}</div>
          {draft.tagline && <div style={{ fontSize: 12, color: "#8b8ba3", marginTop: 4 }}>{draft.tagline}</div>}
          <div style={{ fontSize: 12, color: "#55556f", marginTop: 8, lineHeight: 1.6 }}>
            {[draft.address, draft.phone, draft.email].filter(Boolean).map((line) => <div key={line}>{line}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
