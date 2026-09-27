"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Printer } from "lucide-react";
import SalonCentralWordmark from "@/components/salon-central-wordmark";
import type { Invoice } from "@/lib/invoices";
import { DEFAULT_BANK_DETAILS, DEFAULT_BILLED_FROM, type BilledFrom } from "@/lib/billing-constants";

function fmt(n: number) { return "PKR " + n.toLocaleString("en-PK"); }
function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-PK", { year: "numeric", month: "long", day: "numeric" });
}
function fmtShortDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" });
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  paid:    { color: "#059669", label: "PAID"    },
  unpaid:  { color: "#d97706", label: "UNPAID"  },
  overdue: { color: "#dc2626", label: "OVERDUE" },
};

const PRINT_STYLES = `
  @media print {
    body > *:not(#werzio-invoice-portal) { display: none !important; }
    #werzio-invoice-portal {
      display: block !important; position: fixed !important;
      inset: 0 !important; background: #fff !important;
      z-index: 99999 !important; overflow: visible !important;
    }
    .iv-overlay  { background: transparent !important; padding: 0 !important; overflow: visible !important; }
    .iv-no-print { display: none !important; }
    .iv-sheet    { box-shadow: none !important; border-radius: 0 !important; max-width: 100% !important; width: 100% !important; }
    @page { size: A4 portrait; margin: 18mm 16mm; }
  }
`;

interface Props {
  invoice: Invoice;
  onClose: () => void;
  /** Per-salon bank account override — defaults to the platform's if omitted. */
  bankDetails?: { bankName: string; title: string; accountNumber: string; iban: string };
  /** Admin-set "Billed From" details — defaults to the platform's if omitted. */
  billedFrom?: BilledFrom;
}

function BilledFromLines({ billedFrom }: { billedFrom: BilledFrom }) {
  return (
    <>
      {[billedFrom.tagline, billedFrom.email, billedFrom.phone, billedFrom.address]
        .filter(Boolean)
        .map((line) => <div key={line}>{line}</div>)}
    </>
  );
}

export default function InvoiceViewer({ invoice, onClose, bankDetails = DEFAULT_BANK_DETAILS, billedFrom = DEFAULT_BILLED_FROM }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  const st = STATUS_STYLE[invoice.status] ?? STATUS_STYLE.unpaid;
  const billingContact = [billedFrom.email, billedFrom.phone].filter(Boolean).join(" or ");

  const content = (
    <div id="werzio-invoice-portal">
      <style>{PRINT_STYLES}</style>

      <div
        className="iv-overlay"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", overflowY: "auto" }}
      >
        <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Toolbar */}
          <div className="iv-no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", opacity: 0.9 }}>{invoice.number}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => window.print()}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.15)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                <Printer size={14} /> Print / Save PDF
              </button>
              <button type="button" onClick={onClose} aria-label="Close invoice"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.15)", cursor: "pointer" }}>
                <X size={16} color="#fff" />
              </button>
            </div>
          </div>

          {/* Invoice Sheet */}
          <div className="iv-sheet" style={{ background: "#fff", borderRadius: 4, boxShadow: "0 24px 80px rgba(0,0,0,0.3)", fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>
            <div style={{ padding: "52px 56px" }}>

              {/* ── HEADER: Salon Central left, INVOICE right ── */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 48 }}>
                {/* Left: Salon Central branding */}
                <div>
                  <div style={{ marginBottom: 18 }}>
                    <SalonCentralWordmark />
                  </div>
                  <div style={{ fontSize: 12, color: "#555", lineHeight: 2 }}>
                    <BilledFromLines billedFrom={billedFrom} />
                  </div>
                </div>

                {/* Right: INVOICE label + number + status */}
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 38, fontWeight: 900, color: "#111", letterSpacing: "-1px", lineHeight: 1 }}>INVOICE</div>
                  <div style={{ fontSize: 14, color: "#7C3AED", fontWeight: 700, marginTop: 8 }}>{invoice.number}</div>
                  <div style={{ marginTop: 12, display: "inline-block", padding: "4px 16px", border: `1.5px solid ${st.color}`, borderRadius: 20, fontSize: 11, fontWeight: 800, color: st.color, letterSpacing: "0.08em" }}>
                    {st.label}
                  </div>
                </div>
              </div>

              {/* ── DATE ROW ── */}
              <div style={{ display: "grid", gridTemplateColumns: invoice.periodStart && invoice.periodEnd ? "1.4fr 1fr 1fr 1fr" : "1fr 1fr 1fr", gap: 0, marginBottom: 40, borderTop: "1px solid #ddd", borderBottom: "1px solid #ddd", padding: "16px 0" }}>
                {[
                  ...(invoice.periodStart && invoice.periodEnd
                    ? [{ label: "Billing Period", value: `${fmtShortDate(invoice.periodStart)} – ${fmtShortDate(invoice.periodEnd)}` }]
                    : []),
                  { label: "Issue Date", value: fmtDate(invoice.issuedDate) },
                  { label: "Due Date",   value: fmtDate(invoice.dueDate) },
                  { label: "Paid Date",  value: invoice.paidDate ? fmtDate(invoice.paidDate) : "—" },
                ].map(({ label, value }, i) => (
                  <div key={label} style={{ paddingLeft: i === 0 ? 0 : 24, borderLeft: i > 0 ? "1px solid #e0e0e0" : "none" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* ── BILLED FROM / TO ── */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginBottom: 40 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Billed From</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 4 }}>{billedFrom.name}</div>
                  <div style={{ fontSize: 12, color: "#555", lineHeight: 2 }}>
                    <BilledFromLines billedFrom={billedFrom} />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Billed To</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 4 }}>{invoice.salonName}</div>
                  <div style={{ fontSize: 12, color: "#555", lineHeight: 2 }}>
                    {invoice.userName  && <div>{invoice.userName}</div>}
                    {invoice.userEmail && <div>{invoice.userEmail}</div>}
                    {invoice.userPhone && <div>{invoice.userPhone}</div>}
                    <div>Pakistan</div>
                  </div>
                </div>
              </div>

              {/* ── ITEMS TABLE ── */}
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 28 }}>
                <thead>
                  <tr style={{ background: "#f0f0f0", borderTop: "1px solid #ccc", borderBottom: "1px solid #ccc" }}>
                    {["Description", "Qty", "Unit Price", "Total"].map((h, i) => (
                      <th key={h} style={{ padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#111", textTransform: "capitalize", textAlign: i === 0 ? "left" : "right", letterSpacing: "0.03em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #e8e8e8" }}>
                      <td style={{ padding: "13px 14px", fontSize: 13, color: "#111" }}>
                        {item.description}
                        {invoice.periodStart && invoice.periodEnd && (
                          <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>
                            {fmtShortDate(invoice.periodStart)} – {fmtShortDate(invoice.periodEnd)}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "13px 14px", fontSize: 13, color: "#555", textAlign: "right" }}>{item.qty}</td>
                      <td style={{ padding: "13px 14px", fontSize: 13, color: "#555", textAlign: "right" }}>{fmt(item.unitPrice)}</td>
                      <td style={{ padding: "13px 14px", fontSize: 13, fontWeight: 700, color: "#111", textAlign: "right" }}>{fmt(item.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* ── TOTALS ── */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 40 }}>
                <div style={{ width: 280 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 13, color: "#555", borderBottom: "1px solid #e8e8e8" }}>
                    <span style={{ fontWeight: 600 }}>Subtotal</span><span style={{ fontWeight: 700, color: "#111" }}>{fmt(invoice.subtotal)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 13, color: "#555", borderBottom: "1px solid #e8e8e8" }}>
                    <span>Tax</span><span>PKR 0</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", fontSize: 15, borderTop: "2px solid #111", marginTop: 4 }}>
                    <span style={{ fontWeight: 800, color: "#111" }}>Total Due</span>
                    <span style={{ fontWeight: 900, color: "#111" }}>{fmt(invoice.total)}</span>
                  </div>
                </div>
              </div>

              {/* ── PAYMENT DETAILS ── */}
              <div style={{ marginBottom: 36, border: "1px solid #e8e8e8", borderRadius: 10, padding: "16px 18px", background: "#fafafa" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#111", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Payment Details</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <tbody>
                    {[
                      ["Bank Name:", bankDetails.bankName],
                      ["Account Title:", bankDetails.title],
                      ["Account Number:", bankDetails.accountNumber],
                      ["IBAN:", bankDetails.iban],
                    ].filter(([, value]) => value).map(([label, value]) => (
                      <tr key={label}>
                        <td style={{ padding: "4px 0", color: "#555", width: "34%" }}>{label}</td>
                        <td style={{ padding: "4px 0", color: "#111", fontWeight: 800 }}>{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── TERMS ── */}
              <div style={{ marginBottom: 36 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#111", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Terms</div>
                <div style={{ fontSize: 12, color: "#555", lineHeight: 1.9 }}>
                  Payment is due within 7 days of the invoice date. Late payments may result in service suspension.<br />
                  {billingContact ? `For billing queries, contact ${billingContact}.` : ""}
                </div>
              </div>

              {/* ── FOOTER ── */}
              <div style={{ borderTop: "1px solid #e0e0e0", paddingTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 12, color: "#555" }}>
                  Thank you for choosing <strong style={{ color: "#111" }}>Salon Central</strong> — powering your salon's success.
                </div>
                <SalonCentralWordmark compact />
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
