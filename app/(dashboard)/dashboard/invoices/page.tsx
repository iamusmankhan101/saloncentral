"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Search, Eye, Trash2, CheckCircle, Clock, Pencil, FileEdit,
  ReceiptText, ShoppingCart, TrendingUp, Users, MessageSquare,
} from "lucide-react";
import {
  getSalonInvoices, deleteSalonInvoice, cancelInvoiceOnFbr, markSalonInvoicePaid, updateSalonInvoice, localDateKey, balanceDue, advancePercent,
  paymentMethodLabel, type SalonInvoice,
} from "@/lib/salon-invoices";
import type { PaymentMethod } from "@/lib/types";
import { getStoredAppointments, saveAppointments, getStoredClients, saveClients } from "@/lib/storage";
import { returnToStock, settledConsumption } from "@/lib/inventory-consumption";
import { settingsStore } from "@/lib/settings-store";
import { syncFromDB } from "@/lib/turso-sync";
import SalonInvoicePrint from "@/components/salon-invoice-print";
import SalonInvoiceEdit from "@/components/salon-invoice-edit";
import { queueInvoiceReceipt } from "@/lib/whatsapp-receipt";
import MobilePageHeader from "@/components/mobile-page-header";
import PageTitle from "@/components/page-title";
import { fmtCurrency as fmt } from "@/lib/format";
import { getActiveSection } from "@/lib/sections";

function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-PK", { month: "short", day: "numeric", year: "numeric" });
}

function fmtCreatedAt(value: string) {
  const createdAt = new Date(value);
  if (Number.isNaN(createdAt.getTime())) return "—";
  return createdAt.toLocaleString("en-PK", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Karachi",
  });
}

const STATUS_META = {
  paid:    { label: "Paid",    color: "#059669", bg: "#ecfdf5", icon: CheckCircle },
  unpaid:  { label: "Unpaid",  color: "#d97706", bg: "#fffbeb", icon: Clock },
  // Advance taken, balance still owed — its own colour so it reads as neither
  // settled nor untouched at a glance.
  partial: { label: "Advance", color: "#0284c7", bg: "#e0f2fe", icon: Clock },
};

const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", jazzcash: "JazzCash", easypaisa: "EasyPaisa",
  raast: "Raast", card: "Card", bank: "Bank Transfer", "": "—",
};

const PAYMENT_METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "cash",      label: "Cash" },
  { value: "jazzcash",  label: "JazzCash" },
  { value: "easypaisa", label: "EasyPaisa" },
  { value: "raast",     label: "Raast" },
  { value: "card",      label: "Card" },
  { value: "bank",      label: "Bank Transfer" },
];

function StatCard({ label, value, sub, color = "var(--accent)", bg = "rgba(124, 58, 237, 0.08)", icon }: {
  label: string; value: string; sub?: string; color?: string; bg?: string; icon?: React.ReactNode;
}) {
  return (
    <div style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.02)", flex: 1 }}>
      {icon && <div style={{ width: 46, height: 46, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color }}>{icon}</div>}
      <div>
        <div style={{ fontSize: 24, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, fontWeight: 500 }}>{sub}</div>}
      </div>
    </div>
  );
}

export default function InvoicesPage() {
  const [invoices, setInvoices]         = useState<SalonInvoice[]>([]);
  const [search, setSearch]             = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "paid" | "unpaid">("all");
  const [viewingInvoice, setViewingInvoice] = useState<SalonInvoice | null>(null);
  /** Outcome of re-sending an edited invoice on WhatsApp, shown briefly as a toast. */
  const [resendNotice, setResendNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /** Invoice id currently sending on WhatsApp via the manual "Send WhatsApp" button. */
  const [sendingWaId, setSendingWaId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm]   = useState<string | null>(null);
  const [markPaidPromptId, setMarkPaidPromptId] = useState<string | null>(null);
  const [markPaidDate, setMarkPaidDate] = useState(() => localDateKey());
  const [editDateInvoice, setEditDateInvoice] = useState<SalonInvoice | null>(null);
  const [editDateValue, setEditDateValue] = useState("");
  const [editingInvoice, setEditingInvoice] = useState<SalonInvoice | null>(null);

  const salon = settingsStore.salon;
  // Strict-locked to the active dashboard section, same rule as Revenue/Cash
  // Flow/POS — "All Sections" sees everything, a specific section sees only
  // its own invoices.
  const activeSection = getActiveSection();

  function reload() {
    // Only show POS-originated invoices (source === "pos", or legacy ones with no source)
    const all = getSalonInvoices();
    const pos = all
      .filter((inv) => !inv.source || inv.source === "pos")
      .filter((inv) => activeSection === "all" || inv.section === activeSection);
    setInvoices(pos);
  }

  useEffect(() => {
    let cancelled = false;
    syncFromDB().finally(() => {
      if (!cancelled) reload();
    });
    return () => { cancelled = true; };
  }, []);
  // Reset to today each time the prompt opens for a new invoice, so a
  // previously-picked backdate doesn't silently carry over to the next one.
  useEffect(() => {
    if (!markPaidPromptId) return;
    queueMicrotask(() => setMarkPaidDate(localDateKey()));
  }, [markPaidPromptId]);

  // Deep-link support: opening /dashboard/invoices?id=<invoiceId> (e.g. from a
  // notification) auto-opens that invoice's detail view once data has loaded.
  useEffect(() => {
    if (invoices.length === 0) return;
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    const inv = invoices.find((i) => i.id === id);
    if (inv) queueMicrotask(() => setViewingInvoice(inv));
  }, [invoices]);

  const stats = useMemo(() => {
    const paid   = invoices.filter((i) => i.status === "paid");
    const unpaid = invoices.filter((i) => i.status === "unpaid");
    const uniqueClients = new Set(invoices.map((i) => i.clientPhone || i.clientName)).size;
    // Billed amount before any discount is applied — subtotal, not total.
    const billedAmount = invoices.reduce((s, i) => s + i.subtotal, 0);
    const totalDiscount = invoices.reduce((s, i) => s + i.discountAmount + (i.discount2Amount ?? 0), 0);
    return {
      total:        invoices.length,
      paidCount:    paid.length,
      unpaidCount:  unpaid.length,
      revenue:      paid.reduce((s, i) => s + i.total, 0),
      outstanding:  unpaid.reduce((s, i) => s + i.total, 0),
      uniqueClients,
      billedAmount,
      discountedTotal: invoices.reduce((s, i) => s + i.total, 0),
      totalDiscount,
    };
  }, [invoices]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return invoices
      .filter((inv) => {
        const matchSearch = !q ||
          inv.clientName.toLowerCase().includes(q) ||
          inv.number.toLowerCase().includes(q) ||
          inv.staffName.toLowerCase().includes(q);
        const matchStatus = filterStatus === "all" || inv.status === filterStatus;
        return matchSearch && matchStatus;
      })
      // Newest first — explicit rather than relying on storage order, which
      // can get reshuffled by a DB sync merge (see syncFromDB in turso-sync.ts).
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [invoices, search, filterStatus]);

  function confirmMarkPaid(method: PaymentMethod) {
    if (!markPaidPromptId) return;
    const id = markPaidPromptId;
    const wasPartial = invoices.find((inv) => inv.id === id)?.status === "partial";
    markSalonInvoicePaid(id, method, markPaidDate);
    reload();
    if (viewingInvoice?.id === id) {
      setViewingInvoice((prev) => prev ? { ...prev, status: "paid", paymentMethod: method, paidDate: markPaidDate } : prev);
    }
    setMarkPaidPromptId(null);
    // Collecting the balance settles an invoice the client already has a copy
    // of, so send the paid-in-full version the same way an edit does.
    if (wasPartial) {
      const settled = getSalonInvoices().find((inv) => inv.id === id);
      if (settled) void resendEditedInvoice(settled);
    }
  }

  function openEditDate(inv: SalonInvoice) {
    setEditDateInvoice(inv);
    setEditDateValue(inv.date);
  }

  function confirmEditDate() {
    if (!editDateInvoice || !editDateValue) return;
    // Keep paidDate in step with date when it was already set, so revenue
    // reporting (which prefers paidDate over date where both exist) moves to
    // the new day along with the invoice instead of staying pinned to the old one.
    const updated: SalonInvoice = {
      ...editDateInvoice,
      date: editDateValue,
      paidDate: editDateInvoice.paidDate ? editDateValue : editDateInvoice.paidDate,
    };
    updateSalonInvoice(updated);
    reload();
    if (viewingInvoice?.id === updated.id) setViewingInvoice(updated);
    setEditDateInvoice(null);
  }

  function handleInvoiceSaved(updated: SalonInvoice) {
    reload();
    if (viewingInvoice?.id === updated.id) setViewingInvoice(updated);
    void resendEditedInvoice(updated);
  }

  // The client already has the old copy on WhatsApp, so every edit sends the
  // revised invoice again (one message per invoice, replacing any still queued).
  async function resendEditedInvoice(updated: SalonInvoice) {
    const client = updated.clientId ? getStoredClients().find((c) => c.id === updated.clientId) : undefined;
    const phone = updated.clientPhone || client?.phone || "";
    const name = updated.clientName || client?.name || "";
    if (!phone) {
      setResendNotice({ ok: false, text: "Invoice updated — no phone number on it, so it wasn't sent on WhatsApp." });
    } else {
      const result = await queueInvoiceReceipt(updated, { name, phone }, { resend: true });
      setResendNotice(
        result === "queued" ? { ok: true, text: `Updated invoice ${updated.number} will be sent to ${name || phone} on WhatsApp shortly.` }
        : result === "skipped" ? { ok: false, text: "Invoice updated — WhatsApp automation is off, so it wasn't sent." }
        : { ok: false, text: `Invoice updated, but it couldn't be queued on WhatsApp. Check Settings → WhatsApp.` }
      );
    }
    setTimeout(() => setResendNotice(null), 6000);
  }

  // Manual "Send WhatsApp" button — for when staff want this exact invoice sent
  // (or sent again) right now, rather than relying on the automatic send made
  // at checkout. Uses the same resend path as an edit, since it's the same
  // ask: get this invoice, as it stands, onto the client's WhatsApp.
  async function sendInvoiceOnWhatsApp(inv: SalonInvoice) {
    setSendingWaId(inv.id);
    const client = inv.clientId ? getStoredClients().find((c) => c.id === inv.clientId) : undefined;
    const phone = inv.clientPhone || client?.phone || "";
    const name = inv.clientName || client?.name || "";
    if (!phone) {
      setResendNotice({ ok: false, text: `${inv.number} has no phone number on it, so it can't be sent on WhatsApp.` });
    } else {
      const result = await queueInvoiceReceipt(inv, { name, phone }, { resend: true });
      setResendNotice(
        result === "queued" ? { ok: true, text: `${inv.number} will be sent to ${name || phone} on WhatsApp shortly.` }
        : result === "skipped" ? { ok: false, text: "WhatsApp automation is off in Settings, so it wasn't sent." }
        : { ok: false, text: `Couldn't send ${inv.number} on WhatsApp. Check Settings → WhatsApp.` }
      );
    }
    setSendingWaId(null);
    setTimeout(() => setResendNotice(null), 6000);
  }

  async function handleDelete(id: string) {
    const invoice = getSalonInvoices().find((item) => item.id === id);
    // A bill FBR already has must be cancelled there first (credit note);
    // otherwise FBR keeps a sale the salon no longer shows.
    const fbrError = invoice ? await cancelInvoiceOnFbr(invoice) : null;
    if (fbrError) {
      setDeleteConfirm(null);
      setResendNotice({ ok: false, text: `${invoice?.number} wasn't deleted — FBR couldn't be updated: ${fbrError}` });
      setTimeout(() => setResendNotice(null), 8000);
      return;
    }
    // The sale is undone, so the products its services used go back on the
    // shelf — measured while the invoice and its appointment still exist.
    const linked = getStoredAppointments().filter((appt) => appt.id === invoice?.appointmentId && appt.status === "completed");
    const usedUp = invoice ? settledConsumption([invoice], linked) : new Map<string, number>();
    deleteSalonInvoice(id);
    returnToStock(usedUp, `Invoice ${invoice?.number ?? ""} deleted`.trim());
    if (invoice?.appointmentId) {
      const appointments = getStoredAppointments();
      // completedAt cleared too: completing it again is a new use of products.
      const updatedAppointments = appointments.map((appt) =>
        appt.id === invoice.appointmentId && appt.status === "completed"
          ? { ...appt, status: "booked" as const, totalAmount: 0, completedAt: undefined }
          : appt
      );
      saveAppointments(updatedAppointments);
    }
    // A deleted invoice previously left the client's visit/revenue totals stuck at
    // their old inflated value forever (nothing else ever recomputes them), so
    // reverse the exact increment the POS sale applied when the invoice was created.
    if (invoice?.clientId) {
      const clients = getStoredClients();
      const updatedClients = clients.map((c) =>
        c.id === invoice.clientId
          ? { ...c, totalVisits: Math.max(0, c.totalVisits - 1), totalSpend: Math.max(0, c.totalSpend - invoice.total) }
          : c
      );
      saveClients(updatedClients);
    }
    setDeleteConfirm(null);
    reload();
    if (viewingInvoice?.id === id) setViewingInvoice(null);
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "9px 12px", borderRadius: 8,
    border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e",
    background: "#fff", outline: "none", boxSizing: "border-box",
  };

  return (
    <div className="dashboard-polish" style={{ background: "#f4f5f7", minHeight: "100vh" }}>

      {resendNotice && (
        <div role="status" style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 200, maxWidth: "calc(100vw - 32px)", padding: "12px 18px", borderRadius: 12, background: resendNotice.ok ? "#ecfdf5" : "#fffbeb", border: `1px solid ${resendNotice.ok ? "#a7f3d0" : "#fde68a"}`, color: resendNotice.ok ? "#065f46" : "#92400e", fontSize: 13, fontWeight: 600, boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
          {resendNotice.text}
        </div>
      )}

      {/* Mobile header */}
      <MobilePageHeader
        title="POS Invoices"
        subtitle={`${stats.total} transactions · ${stats.paidCount} paid`}
      />

      {/* Mobile stat scroll */}
      <div className="mobile-stat-scroll mobile-only">
        {[
          { label: "Total",     value: String(stats.total),     color: "#7C3AED" },
          { label: "Total Amount", value: fmt(stats.billedAmount), color: "#4338ca" },
          { label: "Discounted Price", value: fmt(stats.discountedTotal), color: "#059669" },
          { label: "Total Discount", value: fmt(stats.totalDiscount), color: "#dc2626" },
          { label: "Revenue",   value: fmt(stats.revenue),      color: "#059669" },
          { label: "Outstanding", value: fmt(stats.outstanding), color: "#d97706" },
          { label: "Clients",   value: String(stats.uniqueClients), color: "#0284c7" },
        ].map((s) => (
          <div key={s.label} className="mobile-stat-card">
            <div className="mobile-stat-card-label">{s.label}</div>
            <div className="mobile-stat-card-value" style={{ fontSize: s.value.length > 8 ? 13 : 18, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Mobile search */}
      <div className="mobile-search-bar mobile-only">
        <Search size={16} color="#9898b0" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search invoices…" />
      </div>

      {/* Mobile filter chips */}
      <div className="mobile-filter-row mobile-only">
        {(["all", "paid", "unpaid"] as const).map((s) => (
          <button key={s} type="button" className={`mobile-filter-chip ${filterStatus === s ? "active" : ""}`} onClick={() => setFilterStatus(s)}>
            {s === "all" ? "All" : s === "paid" ? "Paid" : "Unpaid"}
          </button>
        ))}
      </div>

      {/* Mobile list */}
      <div className="mobile-only">
        {filtered.length === 0 ? (
          <div className="mobile-empty">
            <div className="mobile-empty-icon"><ShoppingCart size={26} color="#c8c8e0" /></div>
            <div className="mobile-empty-title">No POS transactions yet</div>
            <div className="mobile-empty-sub">Complete a sale through the POS to see it here.</div>
          </div>
        ) : filtered.map((inv) => {
          const sm = STATUS_META[inv.status];
          const Icon = sm.icon;
          return (
            <div key={inv.id} className="mobile-list-card" onClick={() => setViewingInvoice(inv)}>
              <div className="mobile-list-icon" style={{ background: sm.bg }}><Icon size={18} color={sm.color} /></div>
              <div className="mobile-list-body">
                <div className="mobile-list-title">{inv.clientName}</div>
                <div className="mobile-list-sub">{inv.number} · {fmtDate(inv.date)}{inv.staffName ? ` · ${inv.staffName}` : ""}</div>
              </div>
              <div className="mobile-list-right">
                <div className="mobile-list-amount">{fmt(inv.total)}</div>
                <span className="mobile-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); openEditDate(inv); }}
                title="Change date"
                style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, marginLeft: 6 }}
              >
                <Pencil size={12} color="#9898b0" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Overlays */}
      {viewingInvoice && (
        <SalonInvoicePrint
          invoice={viewingInvoice}
          salonName={salon.name as string}
          salonPhone={salon.phone as string}
          salonEmail={salon.email as string}
          salonAddress={salon.address as string}
          onClose={() => setViewingInvoice(null)}
          onMarkPaid={() => setMarkPaidPromptId(viewingInvoice.id)}
          onEdit={() => setEditingInvoice(viewingInvoice)}
          onSendWhatsApp={() => sendInvoiceOnWhatsApp(viewingInvoice)}
          sendingWhatsApp={sendingWaId === viewingInvoice.id}
        />
      )}
      {editingInvoice && (
        <SalonInvoiceEdit
          invoice={editingInvoice}
          onClose={() => setEditingInvoice(null)}
          onSaved={handleInvoiceSaved}
        />
      )}
      {deleteConfirm && (
        <div onClick={() => setDeleteConfirm(null)} className="modal-overlay" style={{ zIndex: 250 }}>
          <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 16, padding: "28px 32px", maxWidth: 360, width: "100%", boxShadow: "0 16px 50px rgba(0,0,0,0.2)", textAlign: "center" }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Trash2 size={22} color="#dc2626" />
            </div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 6 }}>Delete Invoice?</div>
            <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 24 }}>This action cannot be undone.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={() => setDeleteConfirm(null)} style={{ padding: "9px 20px", borderRadius: 9, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} style={{ padding: "9px 20px", borderRadius: 9, border: "none", background: "#dc2626", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {markPaidPromptId && (
        <div onClick={() => setMarkPaidPromptId(null)} className="modal-overlay" style={{ zIndex: 250 }}>
          <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 16, padding: "28px 32px", maxWidth: 360, width: "100%", boxShadow: "0 16px 50px rgba(0,0,0,0.2)", textAlign: "center" }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <CheckCircle size={22} color="#059669" />
            </div>
            {(() => {
              const promptInvoice = invoices.find((inv) => inv.id === markPaidPromptId);
              const balance = promptInvoice ? balanceDue(promptInvoice) : 0;
              return promptInvoice?.status === "partial" ? (
                <>
                  <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 6 }}>Collect the balance</div>
                  <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 12 }}>
                    Advance of {fmt(promptInvoice.advanceAmount ?? 0)} ({advancePercent(promptInvoice)}%) already received on {promptInvoice.number}.
                  </div>
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 14, fontWeight: 800, color: "#b45309" }}>
                    Balance due {fmt(balance)}
                  </div>
                  <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 16 }}>How was the balance paid?</div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 6 }}>How was this paid?</div>
                  <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 16 }}>Select a payment method to mark this invoice paid.</div>
                </>
              );
            })()}
            <div style={{ textAlign: "left", marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
                Date paid
              </label>
              <input
                type="date"
                value={markPaidDate}
                max={localDateKey()}
                onChange={(e) => setMarkPaidDate(e.target.value)}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", background: "#faf9fd" }}
              />
              <div style={{ fontSize: 11, color: "#9898b0", marginTop: 5 }}>Defaults to today — change it if this was actually paid earlier.</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
              {PAYMENT_METHOD_OPTIONS.map((pm) => (
                <button
                  key={pm.value}
                  onClick={() => confirmMarkPaid(pm.value)}
                  style={{ padding: "10px 12px", borderRadius: 9, border: "1px solid #e8e8f0", background: "#faf9fd", fontSize: 13, fontWeight: 700, color: "#1a1a2e", cursor: "pointer" }}
                  className="hover-bg-light"
                >
                  {pm.label}
                </button>
              ))}
            </div>
            <button onClick={() => setMarkPaidPromptId(null)} style={{ padding: "8px 20px", borderRadius: 9, border: "none", background: "none", fontSize: 13, fontWeight: 600, color: "#9898b0", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}
      {editDateInvoice && (
        <div onClick={() => setEditDateInvoice(null)} className="modal-overlay" style={{ zIndex: 250 }}>
          <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 16, padding: "28px 32px", maxWidth: 360, width: "100%", boxShadow: "0 16px 50px rgba(0,0,0,0.2)", textAlign: "center" }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Pencil size={20} color="#7C3AED" />
            </div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 6 }}>Change Invoice Date</div>
            <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 16 }}>{editDateInvoice.number} · {editDateInvoice.clientName}</div>
            <div style={{ textAlign: "left", marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
                Invoice date
              </label>
              <input
                type="date"
                value={editDateValue}
                onChange={(e) => setEditDateValue(e.target.value)}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", background: "#faf9fd", boxSizing: "border-box" }}
              />
              <div style={{ fontSize: 11, color: "#9898b0", marginTop: 5 }}>
                {editDateInvoice.appointmentId
                  ? "This invoice is linked to an appointment — revenue reports follow the appointment's date, so this won't move the revenue day."
                  : "Revenue reports will move to reflect the new date."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={() => setEditDateInvoice(null)} style={{ padding: "9px 20px", borderRadius: 9, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
              <button onClick={confirmEditDate} disabled={!editDateValue} style={{ padding: "9px 20px", borderRadius: 9, border: "none", background: "#7C3AED", fontSize: 13, fontWeight: 700, color: "#fff", cursor: editDateValue ? "pointer" : "not-allowed", opacity: editDateValue ? 1 : 0.6 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Desktop layout */}
      <div className="dash-page dashboard-polish desktop-only" style={{ background: "#ffffff", display: "flex", flexDirection: "column", gap: 20, paddingTop: 20, minHeight: "100vh" }}>

        {/* Page header */}
        <PageTitle
          icon={<ShoppingCart size={24} />}
          title="POS Invoices"
          subtitle={activeSection === "all" ? "Receipts from completed POS transactions" : `Restricted to ${activeSection} only`}
        />

        {/* Stats */}
        <div className="stats-grid-4">
          <StatCard label="Total Transactions" value={String(stats.total)}        sub={`${stats.paidCount} paid · ${stats.unpaidCount} unpaid`} icon={<ReceiptText size={22} />} bg="rgba(124, 58, 237, 0.08)" color="var(--accent)" />
          <StatCard label="Revenue Collected"  value={fmt(stats.revenue)}         icon={<TrendingUp size={22} />} bg="#ecfdf5" color="#059669" />
          <StatCard label="Outstanding"        value={fmt(stats.outstanding)}      sub={`${stats.unpaidCount} unpaid`} icon={<Clock size={22} />} bg="#fffbeb" color="#d97706" />
          <StatCard label="Unique Clients"     value={String(stats.uniqueClients)} icon={<Users size={22} />} bg="#f0f9ff" color="#0284c7" />
        </div>

        {/* Billing breakdown — total billed before discount, the discounted total clients actually owe, and the amount discounted away */}
        <div className="stats-grid-4">
          <StatCard label="Total Amount"    value={fmt(stats.billedAmount)}     sub="Before discount" icon={<ReceiptText size={22} />} bg="#eef2ff" color="#4338ca" />
          <StatCard label="Discounted Price" value={fmt(stats.discountedTotal)} sub="After discount" icon={<TrendingUp size={22} />} bg="#ecfdf5" color="#059669" />
          <StatCard label="Total Discount"  value={fmt(stats.totalDiscount)}    sub="Amount saved" icon={<Clock size={22} />} bg="#fef2f2" color="#dc2626" />
        </div>

        {/* Table card */}
        <div className="table-scroll-wrap" style={{ background: "#fff", borderRadius: 18, border: "1px solid rgba(226,223,235,.95)", boxShadow: "0 8px 28px rgba(38,25,75,.04)", overflow: "hidden" }}>

          {/* Toolbar */}
          <div style={{ padding: "16px 24px", borderBottom: "1px solid #f0f0f5", display: "flex", alignItems: "center", gap: 12, background: "#fff" }}>
            <div style={{ flex: 1, position: "relative" }}>
              <Search size={15} color="#b0b0c8" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by client, invoice #, or staff…"
                style={{ ...inputStyle, paddingLeft: 38, maxWidth: 360, borderRadius: 12, border: "1px solid #e3e0eb", padding: "10px 14px 10px 38px", boxShadow: "0 2px 8px rgba(0,0,0,0.01)", transition: "border-color 0.15s" }}
              />
            </div>
            {(["all", "paid", "unpaid"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                style={{
                  padding: "9px 20px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 750, transition: "all 0.15s",
                  border: filterStatus === s ? "none" : "1px solid #e3e0eb",
                  background: filterStatus === s ? "var(--accent-gradient)" : "#fff",
                  color: filterStatus === s ? "#fff" : "#6b6b8a",
                  boxShadow: filterStatus === s ? "0 3px 10px var(--accent-glow)" : "none",
                }}
                className={filterStatus !== s ? "hover-bg-light" : ""}
              >
                {s === "all" ? "All" : s === "paid" ? "Paid" : "Unpaid"}
              </button>
            ))}
          </div>

          <div className="table-scroll-inner">
            <div className="invoice-table-inner" style={{ background: "#fff" }}>

              {/* Column headers */}
              <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 150px 110px 120px 80px 110px 100px 100px", padding: "12px 24px", borderBottom: "1px solid #f0f0f5", background: "#faf9fd", alignItems: "center" }}>
                {["Invoice #", "Client", "Staff", "Date", "Created", "Items", "Method", "Amount", "Actions"].map((h) => (
                  <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>{h}</div>
                ))}
              </div>

              {filtered.length === 0 ? (
                <div style={{ padding: "64px 24px", textAlign: "center" }}>
                  <div style={{ width: 64, height: 64, borderRadius: 16, background: "rgba(226,223,235,0.5)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", boxShadow: "0 4px 12px rgba(0,0,0,0.02)" }}>
                    <ShoppingCart size={28} color="#9898b0" />
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>No POS transactions yet</div>
                  <div style={{ fontSize: 13, color: "#9898b0", fontWeight: 500 }}>
                    Complete a sale through the <strong style={{ color: "var(--accent)", fontWeight: 700 }}>POS</strong> to see invoices here.
                  </div>
                </div>
              ) : filtered.map((inv, i) => {
                const sm = STATUS_META[inv.status];
                const StatusIcon = sm.icon;
                return (
                  <div
                    key={inv.id}
                    className="hover-bg-row"
                    style={{
                      display: "grid", gridTemplateColumns: "150px 1fr 150px 110px 120px 80px 110px 100px 100px",
                      padding: "16px 24px",
                      borderBottom: i < filtered.length - 1 ? "1px solid #f8f8fc" : "none",
                      alignItems: "center", transition: "background 0.15s",
                    }}
                  >
                    {/* Invoice # */}
                    <div style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)", fontFamily: "monospace", letterSpacing: "-0.02em" }}>{inv.number}</div>

                    {/* Client */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{inv.clientName}</div>
                      {inv.clientPhone && <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, fontWeight: 500 }}>{inv.clientPhone}</div>}
                    </div>

                    {/* Staff */}
                    <div style={{ fontSize: 13, color: "#4a4a6a", fontWeight: 600 }}>{inv.staffName || "—"}</div>

                    {/* Date */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 500 }}>{fmtDate(inv.date)}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditDate(inv); }}
                        title="Change date"
                        style={{ width: 22, height: 22, borderRadius: 6, border: "none", background: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
                        className="hover-bg-light"
                      >
                        <Pencil size={11} color="#b0b0c8" />
                      </button>
                    </div>

                    {/* Created */}
                    <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 650, whiteSpace: "nowrap" }}>{fmtCreatedAt(inv.createdAt)}</div>

                    {/* Items count */}
                    <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 500 }}>{inv.items.length} item{inv.items.length !== 1 ? "s" : ""}</div>

                    {/* Payment method */}
                    <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 500 }}>
                      {paymentMethodLabel(inv, METHOD_LABELS)}
                      {inv.cardApprovalCode && <div style={{ fontSize: 10.5, color: "#9999b0" }}>Approval {inv.cardApprovalCode}{inv.cardLast4 ? ` · ••${inv.cardLast4}` : ""}</div>}
                    </div>

                    {/* Amount */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{fmt(inv.total)}</div>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, padding: "3px 8px", borderRadius: 20, background: sm.bg, fontSize: 10, fontWeight: 750, color: sm.color, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        <StatusIcon size={10} /> {inv.status === "partial" ? `${sm.label} ${advancePercent(inv)}%` : sm.label}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => sendInvoiceOnWhatsApp(inv)}
                        disabled={sendingWaId === inv.id}
                        title="Send on WhatsApp"
                        style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #bbf7d0", background: "#f0fdf4", display: "flex", alignItems: "center", justifyContent: "center", cursor: sendingWaId === inv.id ? "default" : "pointer", opacity: sendingWaId === inv.id ? 0.5 : 1, transition: "all 0.15s" }}
                        className="hover-scale"
                      >
                        <MessageSquare size={14} color="#059669" />
                      </button>
                      <button
                        onClick={() => setViewingInvoice(inv)}
                        title="View / Print"
                        style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}
                        className="hover-bg-light"
                      >
                        <Eye size={14} color="#9898b0" />
                      </button>
                      <button
                        onClick={() => setEditingInvoice(inv)}
                        title="Edit Invoice"
                        style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}
                        className="hover-bg-light"
                      >
                        <FileEdit size={14} color="#9898b0" />
                      </button>
                      {(inv.status === "unpaid" || inv.status === "partial") && (
                        <button
                          onClick={() => setMarkPaidPromptId(inv.id)}
                          title={inv.status === "partial" ? `Collect balance ${fmt(balanceDue(inv))}` : "Mark Paid"}
                          style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #bbf7d0", background: "#f0fdf4", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}
                          className="hover-scale"
                        >
                          <CheckCircle size={14} color="#059669" />
                        </button>
                      )}
                      <button
                        onClick={() => setDeleteConfirm(inv.id)}
                        title="Delete"
                        style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}
                        className="hover-scale"
                      >
                        <Trash2 size={14} color="#dc2626" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
