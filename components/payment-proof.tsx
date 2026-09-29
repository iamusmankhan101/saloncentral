"use client";

/**
 * Dashboard side of customer payment screenshots (lib/payment-proofs.ts):
 * which appointments have one, a badge for the list, and the image itself in
 * the appointment's detail modal. Images are fetched only when a modal opens,
 * so the list stays as light as it was.
 */

import { useEffect, useState } from "react";
import { ImageIcon, Loader2, X } from "lucide-react";
import type { PaymentProofMeta } from "@/lib/payment-proofs";
import { WalletLogo } from "@/components/wallet-logos";

const METHOD_LABEL: Record<string, string> = { jazzcash: "JazzCash", easypaisa: "EasyPaisa", bank: "Bank transfer" };

/** Appointment id → proof, refreshed every minute so a screenshot sent while the page is open shows up. */
export function usePaymentProofs(): Map<string, PaymentProofMeta> {
  const [proofs, setProofs] = useState<Map<string, PaymentProofMeta>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/payment-proofs", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: { ok: boolean; proofs?: PaymentProofMeta[] }) => {
          if (!cancelled && d.ok) setProofs(new Map((d.proofs ?? []).map((p) => [p.appointmentId, p])));
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  return proofs;
}

export function PaymentProofBadge() {
  return (
    <span
      title="Customer uploaded a payment screenshot"
      style={{
        display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0,
        fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em",
        color: "#047857", background: "#ecfdf5", padding: "2px 6px", borderRadius: 20,
      }}
    >
      <ImageIcon size={9} /> Paid proof
    </span>
  );
}

/** The screenshot in the appointment detail modal, with a full-size view on click. */
export function PaymentProofSection({ appointmentId, proof }: { appointmentId: string; proof: PaymentProofMeta }) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/payment-proofs?appointmentId=${encodeURIComponent(appointmentId)}`)
      .then((r) => r.json())
      .then((d: { ok: boolean; image?: string; error?: string }) => {
        if (cancelled) return;
        if (d.ok && d.image) setImage(d.image);
        else setError(d.error ?? "Couldn't load the screenshot.");
      })
      .catch(() => { if (!cancelled) setError("Couldn't load the screenshot."); });
    return () => { cancelled = true; };
  }, [appointmentId]);

  const uploaded = new Date(proof.createdAt).toLocaleString("en-PK", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });

  return (
    <div style={{ border: "1px solid #d1fae5", background: "#f0fdf4", borderRadius: 12, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <WalletLogo method={proof.method} size={22} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#065f46" }}>
            Payment screenshot · {METHOD_LABEL[proof.method] ?? proof.method}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 1 }}>
            Sent by the customer {uploaded} — check it against your account before marking paid.
          </div>
        </div>
      </div>
      {image ? (
        <button
          onClick={() => setZoom(true)}
          style={{ display: "block", width: "100%", padding: 0, border: "none", background: "#fff", borderRadius: 10, cursor: "zoom-in" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the proofs table */}
          <img src={image} alt="Payment screenshot" style={{ display: "block", width: "100%", maxHeight: 280, objectFit: "contain", borderRadius: 10 }} />
        </button>
      ) : error ? (
        <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b7280" }}>
          <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Loading screenshot…
        </div>
      )}

      {zoom && image && (
        <div
          onClick={() => setZoom(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(10,10,20,.85)", display: "grid", placeItems: "center", padding: 24, cursor: "zoom-out" }}
        >
          <button
            onClick={() => setZoom(false)}
            aria-label="Close"
            style={{ position: "absolute", top: 16, right: 16, width: 38, height: 38, borderRadius: 12, border: "none", background: "rgba(255,255,255,.15)", color: "#fff", display: "grid", placeItems: "center", cursor: "pointer" }}
          >
            <X size={18} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="Payment screenshot, full size" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }} />
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
