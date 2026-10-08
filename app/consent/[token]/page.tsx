"use client";

/** A patient signing a consent form on their own phone, from a link the clinic sent. */

import { use, useEffect, useState } from "react";
import { CheckCircle2, FileSignature, Loader2 } from "lucide-react";
import SignaturePad from "@/components/clinic/signature-pad";

interface Ctx { ok: boolean; error?: string; signed?: boolean; clinicName?: string; title?: string; body?: string; patientName?: string }

export default function RemoteConsentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/public/consent?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d: Ctx) => { setCtx(d); setName(d.patientName ?? ""); })
      .catch(() => setCtx({ ok: false, error: "Couldn't load the form. Check your connection." }));
  }, [token]);

  async function submit() {
    setSending(true); setError("");
    try {
      const res = await fetch("/api/public/consent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, signature, agreed }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || "Couldn't save your signature.");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your signature.");
    } finally {
      setSending(false);
    }
  }

  const ready = agreed && !!signature && name.trim().length > 1 && !sending;
  const shell = (children: React.ReactNode) => (
    <main style={{ minHeight: "100vh", background: "#f6f5fb", padding: "24px 16px", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", background: "#fff", borderRadius: 18, padding: "22px 20px", boxShadow: "0 8px 30px rgba(0,0,0,0.06)" }}>{children}</div>
    </main>
  );

  if (!ctx) return shell(<div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Loader2 size={26} className="spin" color="#7C3AED" /></div>);
  if (!ctx.ok) return shell(<p style={{ fontSize: 15, color: "#b91c1c", fontWeight: 700, textAlign: "center", padding: 20 }}>{ctx.error}</p>);
  if (done || ctx.signed) return shell(
    <div style={{ textAlign: "center", padding: "24px 8px" }}>
      <CheckCircle2 size={44} color="#059669" />
      <h1 style={{ fontSize: 20, margin: "12px 0 6px", color: "#1a1a2e" }}>Thank you — signed</h1>
      <p style={{ fontSize: 14, color: "#6b6b8a", margin: 0 }}>{ctx.title} has been sent to {ctx.clinicName}. You can close this page.</p>
    </div>,
  );

  return shell(
    <>
      <div style={{ fontSize: 13, fontWeight: 800, color: "#7C3AED" }}>{ctx.clinicName}</div>
      <h1 style={{ fontSize: 20, margin: "4px 0 14px", color: "#1a1a2e", display: "flex", alignItems: "center", gap: 8 }}><FileSignature size={20} /> {ctx.title}</h1>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 14, color: "#3a3a52", lineHeight: 1.65, padding: "14px 16px", border: "1px solid #ececf4", borderRadius: 12, background: "#fafafd", maxHeight: "45vh", overflowY: "auto" }}>{ctx.body}</div>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "16px 0", fontSize: 14, color: "#1a1a2e", lineHeight: 1.5 }}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 4, width: 18, height: 18, accentColor: "#7C3AED" }} />
        I have read and understood this form, my questions have been answered, and I consent to the treatment.
      </label>
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, fontWeight: 800, color: "#9898b0", marginBottom: 5 }}>FULL NAME</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name"
          style={{ width: "100%", boxSizing: "border-box", padding: "12px", borderRadius: 10, border: "1px solid #e4e4ee", fontSize: 16 }} />
      </label>
      <span style={{ display: "block", fontSize: 12, fontWeight: 800, color: "#9898b0", marginBottom: 5 }}>SIGN BELOW WITH YOUR FINGER</span>
      <SignaturePad onChange={setSignature} />
      {error && <p style={{ color: "#b91c1c", fontSize: 13, fontWeight: 700 }}>{error}</p>}
      <button type="button" onClick={submit} disabled={!ready}
        style={{ width: "100%", marginTop: 16, padding: "14px 0", borderRadius: 12, border: "none", fontSize: 16, fontWeight: 800,
          background: ready ? "#7C3AED" : "#e8e8f0", color: ready ? "#fff" : "#9898b0", cursor: ready ? "pointer" : "not-allowed" }}>
        {sending ? "Sending…" : "Sign and send"}
      </button>
    </>,
  );
}
