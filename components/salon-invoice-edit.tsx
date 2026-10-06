"use client";

import { useMemo, useState } from "react";
import { X, Plus, Trash2, Save } from "lucide-react";
import {
  updateSalonInvoice, newBlankItem, reviseInvoiceOnFbr, fbrRelevantChange,
  type SalonInvoice, type SalonInvoiceItem,
} from "@/lib/salon-invoices";
import type { PaymentMethod } from "@/lib/types";
import { getStoredServices, getStoredAppointments, saveAppointments } from "@/lib/storage";
import { upsoldLineIds } from "@/lib/upsell";
import { fmtCurrency as fmt } from "@/lib/format";

const METHOD_OPTIONS: { value: PaymentMethod | ""; label: string }[] = [
  { value: "",          label: "— Not set —" },
  { value: "cash",      label: "Cash" },
  { value: "jazzcash",  label: "JazzCash" },
  { value: "easypaisa", label: "EasyPaisa" },
  { value: "raast",     label: "Raast" },
  { value: "card",      label: "Card" },
  { value: "bank",      label: "Bank Transfer" },
];

interface Props {
  invoice: SalonInvoice;
  onClose: () => void;
  onSaved: (updated: SalonInvoice) => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8,
  border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e",
  background: "#fff", outline: "none", boxSizing: "border-box",
};

export default function SalonInvoiceEdit({ invoice, onClose, onSaved }: Props) {
  const [items,          setItems]          = useState<SalonInvoiceItem[]>(invoice.items.map(i => ({ ...i })));
  const [discount,       setDiscount]       = useState<number>(invoice.discountAmount || 0);
  const [discount2,      setDiscount2]      = useState<number>(invoice.discount2Amount || 0);
  const [notes,          setNotes]          = useState(invoice.notes || "");
  const [paymentMethod,  setPaymentMethod]  = useState<PaymentMethod | "">(invoice.paymentMethod || "");
  const [saving,         setSaving]         = useState(false);
  const [saveError,      setSaveError]      = useState("");
  const [pickedServiceId, setPickedServiceId] = useState("");

  // Read once: nothing in this modal changes the catalogue or the booking.
  const services = useMemo(() => getStoredServices().filter(sv => sv.isActive), []);
  const appointment = useMemo(
    () => invoice.appointmentId ? getStoredAppointments().find(a => a.id === invoice.appointmentId) : undefined,
    [invoice.appointmentId],
  );
  // Flagged live off the edited items, so a service added below is marked the
  // moment it appears rather than after saving.
  const upsoldIds = useMemo(
    () => upsoldLineIds({ ...invoice, items }, appointment),
    [invoice, items, appointment],
  );

  const subtotal = Math.max(0, Math.round(items.reduce((s, i) => s + i.qty * i.unitPrice, 0)));
  const clampedDiscount  = Math.min(Math.max(0, Math.round(discount)), subtotal);
  const clampedDiscount2 = Math.min(Math.max(0, Math.round(discount2)), Math.max(0, subtotal - clampedDiscount));
  const total = Math.max(0, subtotal - clampedDiscount - clampedDiscount2 + invoice.taxAmount) + (invoice.fbrFee || 0);

  function updateItem(id: string, patch: Partial<SalonInvoiceItem>) {
    setItems(list => list.map(i => {
      if (i.id !== id) return i;
      const next = { ...i, ...patch };
      next.total = Math.round(next.qty * next.unitPrice);
      return next;
    }));
  }

  function removeItem(id: string) {
    setItems(list => list.filter(i => i.id !== id));
  }

  function addItem() {
    setItems(list => [...list, { ...newBlankItem(), upsell: true }]);
  }

  /** Lets the flag be corrected by hand — an addition that was really a fix. */
  function toggleUpsell(id: string) {
    setItems(list => list.map(i => i.id === id ? { ...i, upsell: !i.upsell } : i));
  }

  /**
   * Adds a line from the service list rather than a blank one.
   *
   * A hand-typed line still counts as an upsell — it isn't on the booking — but
   * it carries no sourceId, so it can't be matched back to the service if it is
   * ever renamed, and it can't be split across a team service's stylists. Picking
   * from the list fills in the name, the price and that link in one go.
   */
  function addService() {
    const service = services.find(sv => sv.id === pickedServiceId);
    if (!service) return;
    setItems(list => [...list, {
      ...newBlankItem(),
      // The bill already existed, so a service added now was sold during the
      // visit. Correctable with the chip on the line if it wasn't.
      upsell: true,
      sourceId: service.id,
      description: service.name,
      unitPrice: service.price,
      total: service.price,
    }]);
    setPickedServiceId("");
  }

  async function handleSave() {
    if (saving || items.length === 0) return;
    setSaving(true);
    setSaveError("");
    let updated: SalonInvoice = {
      ...invoice,
      items,
      subtotal,
      discountAmount: clampedDiscount,
      discount2Amount: clampedDiscount2,
      total,
      paymentMethod,
      notes: notes.trim(),
    };
    // FBR already holds this bill — cancel it there and re-file the edited one.
    if (invoice.fbrInvoiceNumber && fbrRelevantChange(invoice, updated)) {
      const revised = await reviseInvoiceOnFbr(invoice, updated);
      if ("error" in revised) { setSaveError(revised.error); setSaving(false); return; }
      updated = revised.invoice;
    }
    updateSalonInvoice(updated);

    // Commission is computed from the appointment's totalAmount, not the bill,
    // so a service added here has to move that figure too. Without it an upsell
    // added after checkout would earn its incentive but not the ordinary
    // commission on the same service — the money would only half arrive.
    if (appointment && total !== appointment.totalAmount) {
      const all = getStoredAppointments();
      saveAppointments(all.map(a => a.id === appointment.id ? { ...a, totalAmount: total } : a));
    }

    onSaved(updated);
    setSaving(false);
    onClose();
  }

  return (
    <div onClick={onClose} className="modal-overlay" style={{ zIndex: 320 }}>
      <div onClick={e => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 16, maxWidth: 620, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 16px 50px rgba(0,0,0,0.2)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px 16px", borderBottom: "1px solid #f0f0f5", position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e" }}>Edit Invoice</div>
            <div style={{ fontSize: 12, color: "#9898b0", marginTop: 2 }}>{invoice.number} · {invoice.clientName}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e8e8f0", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <X size={15} color="#9898b0" />
          </button>
        </div>

        <div style={{ padding: "18px 24px 24px" }}>

          {/* Items */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Items</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {items.map(item => (
                <div key={item.id} style={{ display: "grid", gridTemplateColumns: "1fr 56px 90px 90px 28px", gap: 6, alignItems: "center" }}>
                  <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <input value={item.description} onChange={e => updateItem(item.id, { description: e.target.value })}
                      placeholder="Description" style={inputStyle} />
                    {item.type === "service" && (
                      <button type="button" onClick={() => toggleUpsell(item.id)}
                        title={upsoldIds.has(item.id)
                          ? "Counts towards the stylist's upsell incentive — click to unmark"
                          : "Mark as an upsell, so it counts towards the stylist's incentive"}
                        style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, letterSpacing: "0.04em", padding: "3px 7px", borderRadius: 20, cursor: "pointer",
                          color: upsoldIds.has(item.id) ? "#92400e" : "#c0c0d0",
                          background: upsoldIds.has(item.id) ? "#fffbeb" : "#fff",
                          border: upsoldIds.has(item.id) ? "1px solid #fde68a" : "1px dashed #e8e8f0" }}>
                        UPSELL
                      </button>
                    )}
                  </div>
                  <input type="number" min={0} value={item.qty} onChange={e => updateItem(item.id, { qty: Math.max(0, Number(e.target.value) || 0) })}
                    style={{ ...inputStyle, textAlign: "right" }} />
                  <input type="number" min={0} value={item.unitPrice} onChange={e => updateItem(item.id, { unitPrice: Math.max(0, Number(e.target.value) || 0) })}
                    style={{ ...inputStyle, textAlign: "right" }} />
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", textAlign: "right" }}>{fmt(item.total)}</div>
                  <button type="button" onClick={() => removeItem(item.id)} title="Remove item"
                    style={{ width: 28, height: 28, borderRadius: 7, border: "none", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                    <Trash2 size={12} color="#dc2626" />
                  </button>
                </div>
              ))}
              {items.length === 0 && (
                <div style={{ fontSize: 12, color: "#c8c8e0", textAlign: "center", padding: "12px 0" }}>No items — add at least one below.</div>
              )}
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <select value={pickedServiceId} onChange={e => setPickedServiceId(e.target.value)}
                style={{ ...inputStyle, width: "auto", flex: "2 1 180px", minWidth: 0 }}>
                <option value="">Add a service…</option>
                {services.map(sv => (
                  <option key={sv.id} value={sv.id}>{sv.name} — {fmt(sv.price)}</option>
                ))}
              </select>
              <button type="button" onClick={addService} disabled={!pickedServiceId}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 8, border: "none", background: pickedServiceId ? "#7C3AED" : "#e8e8f0", fontSize: 12, fontWeight: 700, color: pickedServiceId ? "#fff" : "#b0b0c8", cursor: pickedServiceId ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}>
                <Plus size={13} /> Add Service
              </button>
              <button type="button" onClick={addItem}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: "1px dashed #d8d4ea", background: "#faf9fd", fontSize: 12, fontWeight: 700, color: "#7C3AED", cursor: "pointer", whiteSpace: "nowrap" }}>
                <Plus size={13} /> Custom Line
              </button>
            </div>
            {upsoldIds.size > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: "#92400e", lineHeight: 1.6 }}>
                {upsoldIds.size} line{upsoldIds.size === 1 ? "" : "s"} marked as an upsell
                {appointment ? ` (booked: ${appointment.serviceNames.join(", ") || "nothing"})` : ""} — these count
                towards {invoice.staffName || appointment?.staffName || "the stylist"}&rsquo;s upsell incentive in Payouts.
                Click a UPSELL chip to change it.
              </div>
            )}
          </div>

          {/* Discounts */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Discount (PKR)</label>
              <input type="number" min={0} value={discount || ""} onChange={e => setDiscount(Math.max(0, Number(e.target.value) || 0))}
                placeholder="0" style={inputStyle} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Discount 2 (PKR)</label>
              <input type="number" min={0} value={discount2 || ""} onChange={e => setDiscount2(Math.max(0, Number(e.target.value) || 0))}
                placeholder="0" style={inputStyle} />
            </div>
          </div>

          {/* Payment method */}
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Payment Method</label>
            <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as PaymentMethod | "")} style={inputStyle}>
              {METHOD_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>

          {/* Notes */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
          </div>

          {/* Totals preview */}
          <div style={{ borderRadius: 12, background: "#faf9fd", border: "1px solid #f0f0f8", padding: "12px 14px", marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b6b8a", marginBottom: 4 }}>
              <span>Subtotal</span><span style={{ fontWeight: 700, color: "#1a1a2e" }}>{fmt(subtotal)}</span>
            </div>
            {clampedDiscount > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#059669", marginBottom: 4, fontWeight: 700 }}>
                <span>Discount</span><span>−{fmt(clampedDiscount)}</span>
              </div>
            )}
            {clampedDiscount2 > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#059669", marginBottom: 4, fontWeight: 700 }}>
                <span>Discount 2</span><span>−{fmt(clampedDiscount2)}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 800, color: "#1a1a2e", paddingTop: 6, borderTop: "1px solid #eae7f5", marginTop: 4 }}>
              <span>Total</span><span>{fmt(total)}</span>
            </div>
          </div>

          {saveError && (
            <div style={{ marginBottom: 12, padding: "10px 14px", background: "#fef2f2", borderRadius: 10, fontSize: 12, color: "#dc2626", fontWeight: 700 }}>{saveError}</div>
          )}
          {/* Actions */}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose}
              style={{ padding: "10px 18px", borderRadius: 9, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}>
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving || items.length === 0}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 20px", borderRadius: 9, border: "none", background: "#7C3AED", fontSize: 13, fontWeight: 700, color: "#fff", cursor: items.length === 0 ? "not-allowed" : "pointer", opacity: items.length === 0 ? 0.6 : 1 }}>
              <Save size={14} /> {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
