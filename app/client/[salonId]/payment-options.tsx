"use client";

/**
 * The salon's payment methods as the customer sees them — the "Payment
 * options" sheet on the client app, and the pay choice + details in booking.
 * Details come from /api/public/salon, which only includes methods the salon
 * switched on in Dashboard → Client App.
 */

import { useEffect, useState } from "react";
import { Building2, Check, Copy, Store, X } from "lucide-react";
import { EasypaisaLogo, JazzCashLogo } from "@/components/wallet-logos";

export interface PublicPayments {
  payAtCounter?: boolean;
  jazzcash?: { number?: string; title?: string };
  easypaisa?: { number?: string; title?: string };
  bank?: { bankName?: string; title?: string; accountNumber?: string; iban?: string };
}

export type PayMethod = "counter" | "jazzcash" | "easypaisa" | "bank";

export interface MethodInfo {
  id: PayMethod;
  label: string;
  sub: string;
  /** Label/value pairs a customer copies to send money. Empty for pay at counter. */
  fields: [string, string][];
}

/** The methods to offer, in the order they're shown. Never empty — the counter is the fallback. */
export function availableMethods(p: PublicPayments | undefined): MethodInfo[] {
  const out: MethodInfo[] = [];
  const wallet = (id: "jazzcash" | "easypaisa", label: string) => {
    const m = p?.[id];
    if (!m?.number?.trim()) return;
    out.push({
      id, label, sub: "Send from your mobile wallet",
      fields: [["Account title", m.title ?? ""], [`${label} number`, m.number]].filter(([, v]) => v.trim()) as [string, string][],
    });
  };
  wallet("jazzcash", "JazzCash");
  wallet("easypaisa", "EasyPaisa");
  const b = p?.bank;
  if (b?.accountNumber?.trim() || b?.iban?.trim()) {
    out.push({
      id: "bank", label: "Bank transfer", sub: b.bankName?.trim() || "Transfer to our bank account",
      fields: ([["Bank", b.bankName ?? ""], ["Account title", b.title ?? ""], ["Account number", b.accountNumber ?? ""], ["IBAN", b.iban ?? ""]] as [string, string][])
        .filter(([, v]) => v.trim()),
    });
  }
  if (p?.payAtCounter !== false || out.length === 0) {
    out.unshift({ id: "counter", label: "Pay at counter", sub: "Cash or card at the salon POS", fields: [] });
  }
  return out;
}

/** A method's badge: the wallet's own logo, or a tinted icon for counter and bank. */
export function MethodIcon({ id, size = 36 }: { id: PayMethod; size?: number }) {
  if (id === "jazzcash") return <JazzCashLogo size={size} />;
  if (id === "easypaisa") return <EasypaisaLogo size={size} />;
  return (
    <span className="po-icon" style={{ width: size, height: size }}>
      {id === "bank" ? <Building2 size={size * 0.47} /> : <Store size={size * 0.47} />}
    </span>
  );
}

/** One method's account details, each line with a copy button. */
export function MethodDetails({ method }: { method: MethodInfo }) {
  const [copied, setCopied] = useState("");
  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(""), 1500);
    }).catch(() => {});
  };
  if (method.fields.length === 0) return null;
  return (
    <div className="po-fields">
      {method.fields.map(([label, value]) => (
        <div key={label} className="po-field">
          <div className="po-field-text">
            <div className="po-field-label">{label}</div>
            <div className="po-field-value">{value}</div>
          </div>
          <button className="po-copy" onClick={() => copy(label, value)} aria-label={`Copy ${label}`}>
            {copied === label ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Full-height sheet listing every method with its details, opened from the app's home screen. */
export function PaymentSheet({ payments, salonPhone, onClose }: {
  payments?: PublicPayments; salonPhone?: string; onClose: () => void;
}) {
  const methods = availableMethods(payments);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div className="po-overlay" role="dialog" aria-modal="true" aria-label="Payment options" onClick={onClose}>
      <div className="po-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="po-head">
          <div className="po-head-title">Payment options</div>
          <button className="po-x" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="po-body">
          {methods.map((m) => (
            <section key={m.id} className="po-card">
              <div className="po-card-head">
                <MethodIcon id={m.id} />
                <span>
                  <span className="po-card-title">{m.label}</span>
                  <span className="po-card-sub">{m.sub}</span>
                </span>
              </div>
              <MethodDetails method={m} />
            </section>
          ))}
          {methods.some((m) => m.id !== "counter") && (
            <p className="po-note">
              After an online transfer, show the payment screenshot at the counter
              {salonPhone ? <> or send it on WhatsApp to <strong>{salonPhone}</strong></> : null}.
            </p>
          )}
        </div>
      </div>
      <PaymentStyles />
    </div>
  );
}

export function PaymentStyles() {
  return (
    <style>{`
      .po-overlay {
        position: fixed; inset: 0; z-index: 50; background: rgba(20,18,36,.42);
        display: flex; align-items: flex-end; justify-content: center;
      }
      .po-sheet {
        width: 100%; max-width: 560px; max-height: calc(100dvh - 40px);
        background: #f6f5fa; border-radius: 22px 22px 0 0;
        display: flex; flex-direction: column; overflow: hidden;
        padding-bottom: env(safe-area-inset-bottom);
      }
      .po-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px; }
      .po-head-title { font-size: 17px; font-weight: 800; letter-spacing: -.01em; color: #1a1a2e; }
      .po-x {
        width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center; cursor: pointer;
        background: #fff; border: 1px solid rgba(26,26,46,.08); color: #1a1a2e;
      }
      .po-body { overflow-y: auto; padding: 8px 14px 18px; display: flex; flex-direction: column; gap: 10px; }
      .po-card { background: #fff; border-radius: 16px; padding: 13px 14px; }
      .po-card-head { display: flex; align-items: center; gap: 11px; }
      .po-card-head > span:last-child { display: flex; flex-direction: column; }
      .po-icon {
        width: 36px; height: 36px; border-radius: 11px; flex-shrink: 0; display: grid; place-items: center;
        background: var(--ca-accent-dim, rgba(124,58,237,.08)); color: var(--ca-accent, #7C3AED);
      }
      .po-card-title { font-size: 14px; font-weight: 750; color: #1a1a2e; }
      .po-card-sub { font-size: 12px; color: #8b8ba3; margin-top: 1px; }
      .po-fields { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
      .po-field {
        display: flex; align-items: center; gap: 10px;
        background: #f6f5fa; border-radius: 11px; padding: 8px 8px 8px 12px;
      }
      .po-field-text { flex: 1; min-width: 0; }
      .po-field-label { font-size: 10.5px; font-weight: 700; color: #8b8ba3; text-transform: uppercase; letter-spacing: .04em; }
      .po-field-value { font-size: 14px; font-weight: 700; color: #1a1a2e; word-break: break-all; margin-top: 1px; }
      .po-copy {
        width: 32px; height: 32px; border-radius: 9px; flex-shrink: 0; cursor: pointer;
        display: grid; place-items: center; border: none;
        background: #fff; color: var(--ca-accent, #7C3AED);
      }
      .po-copy:active { transform: scale(.92); }
      .po-note { margin: 2px 4px 0; font-size: 12.5px; color: #6b6b8a; line-height: 1.55; }
    `}</style>
  );
}
