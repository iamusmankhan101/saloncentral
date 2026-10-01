"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { BEAUTY_PROFILES } from "@/lib/mock-data";
import { getStoredAppointments, getStoredClients, saveClients, subscribeToStoredData } from "@/lib/storage";
import { getSalonInvoices, type SalonInvoice } from "@/lib/salon-invoices";
import type { Client, Appointment } from "@/lib/types";
import { Search, X, Plus, Phone, Mail, Calendar, Heart, Tag, MapPin, ChevronDown, Camera, ExternalLink, Trash2, Download, Upload, FileSpreadsheet } from "lucide-react";
import { getCurrentPlan, isAtLimit } from "@/lib/plan-limits";
import { uploadImage } from "@/lib/image";
import { SETTINGS_CHANGED_EVENT, settingsStore } from "@/lib/settings-store";
import { getTier, TIER_META, nextTierThreshold, pointsToRupees, type LoyaltySettings } from "@/lib/loyalty";
import { clientLocationId, getActiveLocationFilter, getDefaultLocationId, getSalonLocations, locationName, type SalonLocation } from "@/lib/locations";
import { getSectionOptions, getActiveSection, inSection, defaultSectionForNewRecord } from "@/lib/sections";
import { normalizePhone } from "@/lib/whatsapp-scheduler";
import PageTitle from "@/components/page-title";
import MobilePageHeader from "@/components/mobile-page-header";

const STATUS_CONFIG = {
  booked:        { color: "#6366f1", bg: "#eef2ff" },
  confirmed:     { color: "#059669", bg: "#ecfdf5" },
  arrived:       { color: "#9333EA", bg: "#f5f3ff" },
  "in-progress": { color: "#d97706", bg: "#fffbeb" },
};

const TAG_COLORS: Record<string, { color: string; bg: string }> = {
  VIP:      { color: "#7C3AED", bg: "#EDE9FE" },
  Regular:  { color: "#059669", bg: "#ecfdf5" },
  Bridal:   { color: "#db2777", bg: "#fdf2f8" },
  New:      { color: "#0369a1", bg: "#e0f2fe" },
  "At-Risk":{ color: "#dc2626", bg: "#fef2f2" },
};

import { fmtCurrency as fmt } from "@/lib/format";

function fmtDate(s?: string) {
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Delete All Confirm Modal ──────────────────────────────────────────────────
/**
 * The client's photo, falling back to their initial. One component so the list,
 * the mobile rows and the detail header can't drift apart, and so a photo that
 * fails to decode degrades to the initial rather than a broken-image icon.
 */
function ClientAvatar({ name, photo, size, style }: {
  name: string; photo?: string; size: number; style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: "50%", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden", ...style,
  };
  if (photo && !failed) {
    return (
      <div style={base}>
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from localStorage, not an optimisable remote asset */}
        <img src={photo} alt={name} onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  return <div style={base}>{name.charAt(0).toUpperCase()}</div>;
}

/** Circular photo picker used by both the add form and the edit form. */
function ClientPhotoPicker({ name, photo, onChange }: {
  name: string; photo?: string; onChange: (photo: string | undefined) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function pick(file?: File) {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      onChange(await uploadImage(file, "clients"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not use that image.");
    } finally {
      setBusy(false);
      // Clear the input so re-picking the same file still fires onChange.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <ClientAvatar name={name || "?"} photo={photo} size={64} style={{
        background: "linear-gradient(135deg, #5B21B6, #9333EA)", color: "#fff",
        fontSize: 24, fontWeight: 700, border: "2px solid #ede9fe",
      }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
            style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #e8e8f0", background: "#fff", fontSize: 12, fontWeight: 700, color: "#7C3AED", cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Uploading…" : photo ? "Change Photo" : "Upload Photo"}
          </button>
          {photo && (
            <button type="button" onClick={() => { onChange(undefined); setError(""); }}
              style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #fee2e2", background: "#fff", fontSize: 12, fontWeight: 700, color: "#dc2626", cursor: "pointer" }}>
              Remove
            </button>
          )}
        </div>
        {error
          ? <div style={{ fontSize: 11, color: "#dc2626", fontWeight: 600 }}>{error}</div>
          : <div style={{ fontSize: 11, color: "#b0b0c8" }}>JPG or PNG. Resized and uploaded automatically.</div>}
        <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={(e) => pick(e.target.files?.[0])} />
      </div>
    </div>
  );
}

function DeleteAllConfirmModal({ count, onConfirm, onCancel }: { count: number; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 360, maxWidth: "100%", padding: "28px 24px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)", textAlign: "center" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <Trash2 size={22} color="#dc2626" />
        </div>
        <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 8 }}>Delete All Clients?</div>
        <div style={{ fontSize: 13, color: "#6b6b8a", lineHeight: 1.6, marginBottom: 24 }}>
          This will permanently delete all <strong>{count} client{count !== 1 ? "s" : ""}</strong>. This action cannot be undone.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#dc2626", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            Delete All
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete Confirm Modal ──────────────────────────────────────────────────────
function DeleteConfirmModal({ clientName, onConfirm, onCancel }: { clientName: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 340, maxWidth: "100%", padding: "28px 24px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)", textAlign: "center" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <Trash2 size={22} color="#dc2626" />
        </div>
        <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 8 }}>Delete Client?</div>
        <div style={{ fontSize: 13, color: "#6b6b8a", lineHeight: 1.6, marginBottom: 24 }}>
          This will permanently delete <strong>{clientName}</strong> and all their data. This cannot be undone.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#dc2626", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Client Detail Panel ───────────────────────────────────────────────────────
function ClientPanel({ client, onClose, appointments, locations, onUpdate, onDelete }: { client: Client; onClose: () => void; appointments: Appointment[]; locations: SalonLocation[]; onUpdate?: (c: Client) => void; onDelete?: (id: string) => void }) {
  const panelRouter = useRouter();
  const allClientAppts   = appointments.filter((a) => a.clientId === client.id);
  const completedAppts   = allClientAppts.filter((a) => a.status === "completed").sort((a, b) => b.date.localeCompare(a.date));
  const posInvoices      = getSalonInvoices().filter((inv) => inv.clientId === client.id && inv.source === "pos");
  const upcomingAppts    = allClientAppts.filter((a) => !["completed","cancelled","no-show"].includes(a.status)).sort((a, b) => a.date.localeCompare(b.date));

  // Use stored accumulated values (include POS + all devices)
  const apptVisits   = completedAppts.length;
  const apptSpend    = completedAppts.reduce((s, a) => s + a.totalAmount, 0);
  const liveVisits   = Math.max(client.totalVisits ?? 0, apptVisits + posInvoices.length);
  const liveSpend    = Math.max(client.totalSpend  ?? 0, apptSpend + posInvoices.reduce((s, inv) => s + inv.total, 0));
  const liveLastVisit = client.lastVisitDate ?? completedAppts[0]?.date;
  const liveAvgTicket = liveVisits ? Math.round(liveSpend / liveVisits) : 0;

  // Loyalty — use the stored earned/balance fields (maintained by the loyalty system),
  // but floor-reconcile upward from liveSpend so un-synced older records still show correctly
  const loyalty = settingsStore.loyalty as LoyaltySettings;
  const storedEarned  = client.loyaltyPointsEarned ?? 0;
  const storedBalance = client.loyaltyPoints ?? 0;
  // liveSpend already includes both completed appointments + POS invoices (computed above)
  const computedEarned = Math.floor(liveSpend * (loyalty.pointsPerRupee ?? 0.01));
  const liveEarned    = Math.max(storedEarned, computedEarned);
  const redeemed      = Math.max(0, storedEarned - storedBalance);
  const liveBalance   = Math.max(storedBalance, liveEarned - redeemed);
  const loyaltyTier   = getTier(liveEarned, loyalty);
  const tierMeta      = TIER_META[loyaltyTier];
  const pointsValue   = Math.round(pointsToRupees(liveBalance, loyalty.rupeePerPoint ?? 1));
  const nextTier      = nextTierThreshold(liveEarned, loyalty);

  // Unified visit history: completed appointments + POS invoices, sorted by date desc
  type HistoryEntry = { kind: "appt"; data: Appointment } | { kind: "pos"; data: SalonInvoice };
  const historyEntries: HistoryEntry[] = [
    ...completedAppts.map((a): HistoryEntry => ({ kind: "appt", data: a })),
    ...posInvoices.map((inv): HistoryEntry => ({ kind: "pos", data: inv })),
  ].sort((a, b) => {
    const da = a.data.date;
    const db = b.data.date;
    return db.localeCompare(da);
  });
  const profile = BEAUTY_PROFILES.find((p) => p.clientId === client.id);
  const [editing, setEditing] = useState(false);
  const [editPhoto, setEditPhoto] = useState<string | undefined>(client.photo);
  const [editForm, setEditForm] = useState({
    name: client.name,
    phone: client.phone,
    email: client.email ?? "",
    dob: client.dob ?? "",
    source: client.source,
    tag: client.tags[0] ?? "",
    notes: client.notes ?? "",
    locationId: clientLocationId(client),
  });
  const [saved, setSaved] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const setE = (k: string, v: string) => setEditForm((f) => ({ ...f, [k]: v }));
  const [visitPhotos, setVisitPhotos] = useState<Record<string, { before?: string; after?: string }>>({});
  const [expandedVisit, setExpandedVisit] = useState<string | null>(null);

  const handlePhotoUpload = (apptId: string, side: "before" | "after", file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setVisitPhotos((prev) => ({ ...prev, [apptId]: { ...prev[apptId], [side]: e.target?.result as string } }));
    };
    reader.readAsDataURL(file);
  };

  const displayName = saved ? editForm.name : client.name;
  const displayPhone = saved ? editForm.phone : client.phone;
  const displayEmail = saved ? editForm.email : client.email;
  const displayDob = saved ? editForm.dob : client.dob;
  const displaySource = saved ? editForm.source : client.source;
  const displayNotes = saved ? editForm.notes : client.notes;
  const displayLocationId = saved ? editForm.locationId : clientLocationId(client);

  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {showDeleteConfirm && (
        <DeleteConfirmModal
          clientName={client.name}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={() => { onDelete?.(client.id); onClose(); }}
        />
      )}
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 500, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>

        {/* Header */}
        <div style={{ background: "linear-gradient(135deg, #EDE9FE, #fdf2f8)", padding: "28px 24px 20px", borderBottom: "1px solid #f0f0f8", position: "relative" }}>
          <div style={{ position: "absolute", top: 16, right: 16, display: "flex", gap: 8 }}>
            <button
              onClick={() => { onClose(); panelRouter.push(`/dashboard/clients/${client.id}`); }}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 7, border: "1px solid #EDE9FE", background: "#7C3AED", fontSize: 11, fontWeight: 600, color: "#fff", cursor: "pointer" }}
            >
              <ExternalLink size={11} /> Full Profile
            </button>
            {!editing && (
              <button onClick={() => setEditing(true)} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #EDE9FE", background: "#fff", fontSize: 11, fontWeight: 600, color: "#7C3AED", cursor: "pointer" }}>
                Edit
              </button>
            )}
            <button onClick={() => setShowDeleteConfirm(true)} title="Delete client" style={{ display: "flex", alignItems: "center", padding: "5px 8px", borderRadius: 7, border: "1px solid #fecaca", background: "#fef2f2", cursor: "pointer" }}>
              <Trash2 size={13} color="#dc2626" />
            </button>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}>
              <X size={18} color="#6b6b8a" />
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <ClientAvatar name={displayName} photo={saved ? editPhoto : client.photo} size={64} style={{
              background: "linear-gradient(135deg, #5B21B6, #9333EA)", fontSize: 24, fontWeight: 700, color: "#fff",
            }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 20, color: "#1a1a2e" }}>{displayName}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {(saved ? [editForm.tag].filter(Boolean) : client.tags).map((tag) => {
                  const tc = TAG_COLORS[tag] ?? { color: "#6b7280", bg: "#f9fafb" };
                  return <span key={tag} style={{ fontSize: 11, fontWeight: 600, color: tc.color, background: tc.bg, padding: "2px 10px", borderRadius: 20 }}>{tag}</span>;
                })}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Stats — live-computed from appointment history */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
              {[
                { label: "Visits",     value: liveVisits,            color: "#7C3AED", bg: "#f5f3ff" },
                { label: "Total Spend",value: fmt(liveSpend),        color: "#059669", bg: "#ecfdf5" },
                { label: "Avg Ticket", value: liveAvgTicket ? fmt(liveAvgTicket) : "—", color: "#0284c7", bg: "#f0f9ff" },
                { label: "Upcoming",   value: upcomingAppts.length,  color: "#d97706", bg: "#fffbeb" },
              ].map((s) => (
                <div key={s.label} style={{ background: s.bg, borderRadius: 12, padding: "12px 10px", textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 900, color: s.color, lineHeight: 1 }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: "#9898b0", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 4 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Loyalty row — only when enabled */}
            {loyalty.enabled && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderRadius: 12, background: tierMeta.bg, border: `1px solid ${tierMeta.color}28` }}>
                <div style={{ fontSize: 20, lineHeight: 1 }}>{tierMeta.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 5, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 18, fontWeight: 900, color: tierMeta.color, lineHeight: 1 }}>{liveBalance.toLocaleString()}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: tierMeta.color }}>pts balance</span>
                    <span style={{ fontSize: 11, color: "#9898b0" }}>· {fmt(pointsValue)}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#9898b0", marginTop: 3 }}>
                    {liveEarned.toLocaleString()} lifetime earned
                    {nextTier ? ` · ${nextTier.needed} to ${TIER_META[nextTier.tier].emoji} ${TIER_META[nextTier.tier].label}` : " · Top tier!"}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, color: tierMeta.color, background: "#fff", border: `1px solid ${tierMeta.color}40`, borderRadius: 20, padding: "3px 10px", flexShrink: 0 }}>
                  {tierMeta.label}
                </span>
              </div>
            )}
          </div>

          {/* Visit History — appointments + POS merged */}
          {historyEntries.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                Visit History <span style={{ fontWeight: 400 }}>({historyEntries.length})</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {historyEntries.slice(0, 10).map((entry) => {
                  if (entry.kind === "pos") {
                    const inv = entry.data;
                    const isExpanded = expandedVisit === inv.id;
                    return (
                      <div key={inv.id}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: isExpanded ? "10px 10px 0 0" : 10, background: "#f0fdf4", border: "1px solid #bbf7d0", borderBottom: isExpanded ? "none" : undefined }}>
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, color: "#059669", background: "#dcfce7", padding: "1px 6px", borderRadius: 20, border: "1px solid #bbf7d0" }}>POS</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e" }}>{inv.items.map((it) => it.description).join(", ")}</span>
                            </div>
                            <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{fmtDate(inv.date)} · {inv.staffName || "—"} · {inv.paymentMethod || "cash"}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: "#059669" }}>{fmt(inv.total)}</div>
                            <button onClick={() => setExpandedVisit(isExpanded ? null : inv.id)}
                              style={{ display: "flex", alignItems: "center", padding: "4px 7px", borderRadius: 20, border: "none", cursor: "pointer", background: "#dcfce7", fontSize: 10, fontWeight: 700, color: "#059669" }}>
                              {isExpanded ? "▲" : "▼"}
                            </button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div style={{ background: "#f9fffe", border: "1px solid #bbf7d0", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "10px 12px" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#059669", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>Items</div>
                            {inv.items.map((it, i) => (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#1a1a2e", marginBottom: 4 }}>
                                <span>{it.description}{it.qty > 1 ? ` ×${it.qty}` : ""}</span>
                                <span style={{ fontWeight: 700 }}>{fmt(it.unitPrice * it.qty)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }

                  const a = entry.data;
                  const photos = visitPhotos[a.id] ?? {};
                  const photoCount = [photos.before, photos.after].filter(Boolean).length;
                  const isExpanded = expandedVisit === a.id;
                  return (
                    <div key={a.id}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: isExpanded ? "10px 10px 0 0" : 10, background: "#f9f9fb", border: "1px solid #f0f0f8", borderBottom: isExpanded ? "none" : "1px solid #f0f0f8" }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e" }}>{a.serviceNames.join(", ")}</div>
                          <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{fmtDate(a.date)} · {a.staffName || "—"}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ fontSize: 13, fontWeight: 800, color: "#7C3AED" }}>{fmt(a.totalAmount)}</div>
                          <button
                            onClick={() => setExpandedVisit(isExpanded ? null : a.id)}
                            style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 20, border: "none", cursor: "pointer", background: photoCount > 0 ? "#ede9fe" : "#f3f4f6" }}
                          >
                            <Camera size={11} color={photoCount > 0 ? "#7C3AED" : "#9ca3af"} />
                            <span style={{ fontSize: 10, fontWeight: 700, color: photoCount > 0 ? "#7C3AED" : "#9ca3af" }}>
                              {photoCount > 0 ? photoCount : "Add"}
                            </span>
                          </button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div style={{ background: "#f5f3ff", border: "1px solid #ede9fe", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "12px" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            {(["before", "after"] as const).map((side) => (
                              <div key={side}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{side}</div>
                                {photos[side] ? (
                                  <div style={{ position: "relative", borderRadius: 8, overflow: "hidden" }}>
                                    <img src={photos[side]} alt={side} style={{ width: "100%", height: 100, objectFit: "cover", display: "block" }} />
                                    <button
                                      onClick={() => setVisitPhotos((prev) => ({ ...prev, [a.id]: { ...prev[a.id], [side]: undefined } }))}
                                      style={{ position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                                    >
                                      <X size={10} color="#fff" />
                                    </button>
                                  </div>
                                ) : (
                                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, height: 90, borderRadius: 8, border: "2px dashed #a78bfa", background: "#faf5ff", cursor: "pointer" }}>
                                    <Camera size={16} color="#a78bfa" />
                                    <span style={{ fontSize: 10, fontWeight: 600, color: "#a78bfa" }}>Upload {side}</span>
                                    <input type="file" accept="image/*" style={{ display: "none" }}
                                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhotoUpload(a.id, side, f); }} />
                                  </label>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {liveLastVisit && (
                <div style={{ fontSize: 11, color: "#b0b0c8", marginTop: 6 }}>Last visit: {fmtDate(liveLastVisit)}</div>
              )}
            </div>
          )}

          {/* Upcoming appointments */}
          {upcomingAppts.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>Upcoming</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {upcomingAppts.slice(0, 3).map((a) => {
                  const sc = STATUS_CONFIG[a.status as keyof typeof STATUS_CONFIG] ?? { color: "#6b7280", bg: "#f9fafb" };
                  return (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: 10, background: sc.bg, border: `1px solid ${sc.color}22` }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e" }}>{a.serviceNames.join(", ")}</div>
                        <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>{fmtDate(a.date)} · {a.staffName || "—"}</div>
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 700, color: sc.color, background: "rgba(255,255,255,0.8)", borderRadius: 20, padding: "2px 8px", border: `1px solid ${sc.color}33` }}>
                        {a.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Contact — view or edit */}
          {editing ? (
            <PanelSection title="Edit Details">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <ClientPhotoPicker name={editForm.name} photo={editPhoto} onChange={setEditPhoto} />
                {[
                  { label: "Full Name", key: "name", type: "text", placeholder: "Full name" },
                  { label: "Phone", key: "phone", type: "text", placeholder: "Phone number" },
                  { label: "Email", key: "email", type: "email", placeholder: "Email address" },
                  { label: "Date of Birth", key: "dob", type: "date", placeholder: "" },
                ].map(({ label, key, type, placeholder }) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
                    <input type={type} value={editForm[key as keyof typeof editForm]} onChange={(e) => setE(key, e.target.value)} placeholder={placeholder}
                      style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
                  </div>
                ))}
                <div className="client-form-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Source</label>
                    <select value={editForm.source} onChange={(e) => setE("source", e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                      {["whatsapp", "walk-in", "web", "manual"].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Location</label>
                    <select value={editForm.locationId} onChange={(e) => setE("locationId", e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                      {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Tag</label>
                    <select value={editForm.tag} onChange={(e) => setE("tag", e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                      <option value="">None</option>
                      {Object.keys(TAG_COLORS).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Notes</label>
                  <textarea
                    value={editForm.notes}
                    onChange={(e) => setE("notes", e.target.value)}
                    rows={3}
                    placeholder="Preferences, allergies, or other client notes…"
                    style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", resize: "vertical", fontFamily: "inherit" }}
                  />
                </div>
                <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
                  <button onClick={() => { setEditing(false); setEditForm({ name: client.name, phone: client.phone, email: client.email ?? "", dob: client.dob ?? "", source: client.source, tag: client.tags[0] ?? "", notes: client.notes ?? "", locationId: clientLocationId(client) }); }}
                    style={{ flex: 1, padding: "10px 0", borderRadius: 9, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>
                    Cancel
                  </button>
                  <button onClick={() => {
                    const updatedC: Client = {
                      ...client,
                      name: editForm.name,
                      phone: normalizePhone(editForm.phone),
                      email: editForm.email || undefined,
                      photo: editPhoto,
                      dob: editForm.dob || undefined,
                      source: editForm.source as any,
                      locationId: editForm.locationId,
                      tags: editForm.tag ? [editForm.tag] : [],
                      notes: editForm.notes.trim() || undefined,
                    };
                    onUpdate?.(updatedC);
                    setSaved(true);
                    setEditing(false);
                  }}
                    style={{ flex: 2, padding: "10px 0", borderRadius: 9, border: "none", background: "#7C3AED", fontSize: 13, fontWeight: 600, color: "#fff", cursor: "pointer" }}>
                    Save Changes
                  </button>
                </div>
              </div>
            </PanelSection>
          ) : (
            <PanelSection title="Contact & Info">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <InfoLine icon={<Phone size={13} color="#9898b0" />} label={formatPhoneDisplay(displayPhone)} />
                {displayEmail && <InfoLine icon={<Mail size={13} color="#9898b0" />} label={displayEmail} />}
                {displayDob && <InfoLine icon={<Calendar size={13} color="#9898b0" />} label={`DOB: ${fmtDate(displayDob)}`} />}
                <InfoLine icon={<Tag size={13} color="#9898b0" />} label={`Source: ${displaySource}`} />
                <InfoLine icon={<MapPin size={13} color="#9898b0" />} label={`Location: ${locationName(displayLocationId)}`} />
                <InfoLine icon={<Calendar size={13} color="#9898b0" />} label={`Last visit: ${fmtDate(liveLastVisit ?? client.lastVisitDate)}`} />
                {displayNotes && (
                  <div style={{ marginTop: 4, padding: "9px 11px", borderRadius: 8, background: "#f9f9fb", color: "#6b6b8a", fontSize: 12, lineHeight: 1.55 }}>
                    {displayNotes}
                  </div>
                )}
              </div>
            </PanelSection>
          )}

          {/* WhatsApp marketing opt-in — governs birthday offers & cancellation win-backs only; booking confirmations and reminders always send regardless. */}
          <PanelSection title="WhatsApp Marketing">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e" }}>
                  {client.whatsappOptedOut ? "Opted out of marketing messages" : "Receives marketing messages"}
                </div>
                <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2 }}>
                  Birthday offers and cancellation win-backs only. Booking confirmations and reminders are unaffected.
                </div>
              </div>
              <button
                type="button"
                onClick={() => onUpdate?.({ ...client, whatsappOptedOut: !client.whatsappOptedOut })}
                aria-label={client.whatsappOptedOut ? "Opt client back into marketing messages" : "Opt client out of marketing messages"}
                aria-pressed={!client.whatsappOptedOut}
                style={{ width: 40, height: 22, padding: 0, border: "none", borderRadius: 11, background: client.whatsappOptedOut ? "#e0e0ec" : "#059669", cursor: "pointer", position: "relative", flexShrink: 0, transition: "background 0.2s" }}
              >
                <div style={{ position: "absolute", top: 2, left: client.whatsappOptedOut ? 2 : 20, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
              </button>
            </div>
          </PanelSection>

          {/* Beauty Profile */}
          {profile && (
            <PanelSection title="Beauty Profile">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {profile.skinType && (
                  <div style={{ fontSize: 13, color: "#1a1a2e" }}>Skin type: <span style={{ fontWeight: 600 }}>{profile.skinType}</span></div>
                )}
                {profile.allergies.length > 0 && (
                  <div style={{ fontSize: 13, color: "#dc2626" }}>⚠ Allergies: {profile.allergies.join(", ")}</div>
                )}
                {profile.nailPrefs && (
                  <div style={{ fontSize: 13, color: "#1a1a2e" }}>Nail prefs: {profile.nailPrefs}</div>
                )}
                {profile.hairFormulas.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Hair Formulas</div>
                    {profile.hairFormulas.map((f, i) => (
                      <div key={i} style={{ background: "#f9f9fb", borderRadius: 8, padding: "10px 12px", marginBottom: 6, fontSize: 12, color: "#1a1a2e", lineHeight: 1.7 }}>
                        <span style={{ fontWeight: 600 }}>{f.brand}</span> · {f.shade} · {f.developer} · {f.ratio} · {f.processingTime}min
                        {f.notes && <div style={{ color: "#9898b0", marginTop: 2 }}>{f.notes}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {profile.notes && <div style={{ fontSize: 12, color: "#6b6b8a", fontStyle: "italic" }}>{profile.notes}</div>}
              </div>
            </PanelSection>
          )}

        </div>
      </div>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0c8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

/** "923234233372" → "+92 323 4233372" — purely cosmetic, doesn't touch the stored value. */
function formatPhoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("92") && digits.length === 12) {
    return `+92 ${digits.slice(2, 5)} ${digits.slice(5)}`;
  }
  return phone;
}

function InfoLine({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {icon}
      <span style={{ fontSize: 13, color: "#1a1a2e", textTransform: "capitalize" }}>{label}</span>
    </div>
  );
}

// ── Add Client Modal ──────────────────────────────────────────────────────────
function AddClientModal({ onClose, onAdd, locations, allowLocationSelection, clients }: { onClose: () => void; onAdd: (c: Client) => void; locations: SalonLocation[]; allowLocationSelection: boolean; clients: Client[] }) {
  const [done, setDone] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", dob: "", source: "whatsapp", tag: "", section: defaultSectionForNewRecord(), notes: "", locationId: getDefaultLocationId() });
  const [photo, setPhoto] = useState<string | undefined>(undefined);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const canSubmit = form.name.trim();

  const handleAdd = () => {
    if (!canSubmit) return;
    const newClient: Client = {
      id: "c_" + Date.now(),
      name: form.name.trim(),
      phone: normalizePhone(form.phone),
      locationId: allowLocationSelection ? form.locationId : getDefaultLocationId(),
      email: form.email || undefined,
      photo,
      gender: "female",
      dob: form.dob || undefined,
      tags: form.tag ? [form.tag] : ["New"],
      section: form.section || undefined,
      source: form.source as any,
      createdAt: new Date().toISOString().split("T")[0],
      totalVisits: 0,
      totalSpend: 0,
      lastVisitDate: "",
      averageRating: 0.0,
      notes: form.notes || undefined,
    };
    onAdd(newClient);
    setDone(true);
  };

  if (done) return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 360, maxWidth: "100%", padding: "48px 32px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 28 }}>✓</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: "#1a1a2e", marginBottom: 8 }}>Client Added</div>
        <div style={{ fontSize: 13, color: "#9898b0", marginBottom: 24 }}>The new client has been created.</div>
        <button onClick={onClose} style={{ padding: "10px 32px", borderRadius: 10, background: "#7C3AED", border: "none", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );

  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 440, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "22px 24px 18px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>Add New Client</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}><X size={18} color="#6b6b8a" /></button>
        </div>
        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <ClientPhotoPicker name={form.name} photo={photo} onChange={setPhoto} />
          {[
            { label: "Full Name *", key: "name", placeholder: "e.g. Amna Siddiqui", type: "text" },
            { label: "Phone", key: "phone", placeholder: "Optional · e.g. 0321-1234567", type: "text" },
            { label: "Email", key: "email", placeholder: "e.g. amna@email.com", type: "email" },
            { label: "Date of Birth", key: "dob", placeholder: "", type: "date" },
          ].map(({ label, key, placeholder, type }) => (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
              <input type={type} value={form[key as keyof typeof form]} onChange={(e) => set(key, e.target.value)} placeholder={placeholder}
                style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            </div>
          ))}
          <div className="client-form-3" style={{ display: "grid", gridTemplateColumns: `repeat(${allowLocationSelection ? 4 : 3}, minmax(0, 1fr))`, gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Source</label>
              <select value={form.source} onChange={(e) => set("source", e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                {["whatsapp", "walk-in", "web", "manual"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {allowLocationSelection && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Location</label>
                <select value={form.locationId} onChange={(e) => set("locationId", e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                  {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Tag</label>
              <select value={form.tag} onChange={(e) => set("tag", e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                <option value="">None</option>
                {Object.keys(TAG_COLORS).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Section</label>
              <select value={form.section} onChange={(e) => set("section", e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                <option value="">Unassigned</option>
                {getSectionOptions(clients).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Notes & Preferences</label>
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="e.g. Sensitive scalp, prefers morning appointments, no strong fragrances…"
              rows={3}
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
            />
          </div>
          <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
            <button onClick={handleAdd} style={{ flex: 2, padding: "11px 0", borderRadius: 10, border: "none", background: canSubmit ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 600, color: canSubmit ? "#fff" : "#b0b0c8", cursor: canSubmit ? "pointer" : "not-allowed" }}>
              Add Client
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Export helpers ────────────────────────────────────────────────────────────
const EXPORT_COLS = [
  "Name","Phone","Email","Gender","Date of Birth","Location","Source","Tags","Notes",
  "Total Visits","Total Spend","Loyalty Points","Created At",
];

function clientsToRows(list: Client[]) {
  return list.map((c) => ({
    "Name":           c.name,
    "Phone":          c.phone,
    "Email":          c.email ?? "",
    "Gender":         c.gender ?? "",
    "Date of Birth":  c.dob ?? "",
    "Location":       locationName(clientLocationId(c)),
    "Source":         c.source,
    "Tags":           c.tags.join(", "),
    "Notes":          c.notes ?? "",
    "Total Visits":   c.totalVisits,
    "Total Spend":    c.totalSpend,
    "Loyalty Points": c.loyaltyPoints ?? 0,
    "Created At":     c.createdAt,
  }));
}

async function exportClients(list: Client[], format: "xlsx" | "csv") {
  const XLSX = await import("xlsx");
  const ws   = XLSX.utils.json_to_sheet(clientsToRows(list), { header: EXPORT_COLS });
  const wb   = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Clients");
  const date = new Date().toISOString().slice(0,10);
  if (format === "csv") {
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `clients-${date}.csv`; a.click();
  } else {
    XLSX.writeFile(wb, `clients-${date}.xlsx`);
  }
}

// ── Import Modal ──────────────────────────────────────────────────────────────
type ImportResult = { added: number; skipped: number; errors: string[] };

function ImportModal({ existing, onClose, onImport }: {
  existing: Client[];
  onClose: () => void;
  onImport: (newClients: Client[]) => void;
}) {
  const [step, setStep]     = useState<"pick" | "preview" | "done">("pick");
  const [parsed, setParsed] = useState<Client[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);

  async function handleFile(file: File) {
    setError(""); setLoading(true);
    try {
      const XLSX   = await import("xlsx");
      const buf    = await file.arrayBuffer();
      const wb     = XLSX.read(buf, { type: "array" });
      const ws     = wb.Sheets[wb.SheetNames[0]];
      const rows   = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
      if (rows.length === 0) { setError("File is empty or unreadable."); setLoading(false); return; }

      const existingPhones = new Set(existing.map((c) => c.phone.replace(/\s/g, "")));
      const newClients: Client[] = [];
      const locations = getSalonLocations();

      for (const row of rows) {
        const name  = String(row["Name"] ?? row["name"] ?? "").trim();
        const phone = String(row["Phone"] ?? row["phone"] ?? row["Phone Number"] ?? "").replace(/\s/g,"").trim();
        if (!name || !phone) continue; // skip blank rows
        if (existingPhones.has(phone)) continue; // skip duplicates
        existingPhones.add(phone);

        const gender = String(row["Gender"] ?? "").toLowerCase();
        const importedLocation = String(row["Location"] ?? row["location"] ?? row["Branch"] ?? "").trim();
        const matchedLocation = locations.find((location) => location.name.toLowerCase() === importedLocation.toLowerCase() || location.id === importedLocation);
        newClients.push({
          id:          `imp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          name,
          phone,
          locationId:   matchedLocation?.id ?? getDefaultLocationId(),
          email:       String(row["Email"] ?? row["email"] ?? "").trim() || undefined,
          gender:      (["female","male","other"].includes(gender) ? gender : undefined) as Client["gender"],
          dob:         String(row["Date of Birth"] ?? row["DOB"] ?? row["dob"] ?? "").trim() || undefined,
          source:      "manual",
          tags:        String(row["Tags"] ?? row["tags"] ?? "").split(",").map(t=>t.trim()).filter(Boolean),
          notes:       String(row["Notes"] ?? row["notes"] ?? "").trim() || undefined,
          totalVisits: Number(row["Total Visits"] ?? 0) || 0,
          totalSpend:  Number(row["Total Spend"]  ?? 0) || 0,
          loyaltyPoints: Number(row["Loyalty Points"] ?? 0) || 0,
          createdAt:   String(row["Created At"] ?? new Date().toISOString().slice(0,10)),
        });
      }
      setParsed(newClients);
      setStep("preview");
    } catch (e) {
      setError(`Could not read file: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  }

  function confirmImport() {
    const skipped = 0;
    onImport(parsed);
    setResult({ added: parsed.length, skipped, errors: [] });
    setStep("done");
  }

  return (
    <div onClick={onClose} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16 }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#fff",borderRadius:18,width:"100%",maxWidth:520,padding:28,boxShadow:"0 20px 60px rgba(0,0,0,0.2)" }}>

        {/* Header */}
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#5B21B6,#9333EA)",display:"flex",alignItems:"center",justifyContent:"center" }}>
              <FileSpreadsheet size={18} color="#fff" />
            </div>
            <div>
              <div style={{ fontSize:15,fontWeight:800,color:"#1a1a2e" }}>Import Clients</div>
              <div style={{ fontSize:11,color:"#9898b0" }}>XLSX or CSV file</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background:"none",border:"none",cursor:"pointer",display:"flex" }}><X size={18} color="#9898b0" /></button>
        </div>

        {/* Step: pick file */}
        {step === "pick" && (
          <>
            <label style={{ display:"block",border:"2px dashed #ddd6fe",borderRadius:14,padding:"32px 20px",textAlign:"center",cursor:"pointer",background:"#faf9ff",transition:"border-color 0.2s" }}
              onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)handleFile(f);}}>
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display:"none" }} onChange={e=>{const f=e.target.files?.[0];if(f)handleFile(f);}} />
              <Upload size={28} color="#7C3AED" style={{ marginBottom:10 }} />
              <div style={{ fontSize:14,fontWeight:700,color:"#5B21B6",marginBottom:4 }}>Click to choose file or drag & drop</div>
              <div style={{ fontSize:12,color:"#9898b0" }}>Supports .xlsx, .xls, .csv</div>
            </label>
            {loading && <div style={{ textAlign:"center",marginTop:16,color:"#7C3AED",fontSize:13,fontWeight:600 }}>Reading file…</div>}
            {error  && <div style={{ marginTop:12,padding:"10px 14px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:10,fontSize:13,color:"#dc2626" }}>{error}</div>}

            {/* Column guide + download template */}
            <div style={{ marginTop:18,padding:"14px 16px",background:"#f5f3ff",borderRadius:12,fontSize:12,color:"#5B21B6",lineHeight:1.8 }}>
              <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6 }}>
                <strong style={{ fontSize:12 }}>Column format</strong>
                <button
                  onClick={async () => {
                    const XLSX = await import("xlsx");
                    const sample = [
                      { "Name":"Sara Ahmed",  "Phone":"923001234567","Email":"sara@example.com","Gender":"female","Date of Birth":"1995-04-12","Location":"Main Branch","Source":"walk-in","Tags":"VIP, Regular","Notes":"Prefers mornings","Total Visits":5,"Total Spend":12500,"Loyalty Points":350,"Created At":"2024-01-15" },
                      { "Name":"Ali Hassan",  "Phone":"923009876543","Email":"ali@example.com", "Gender":"male",  "Date of Birth":"1988-11-30","Location":"Main Branch","Source":"whatsapp","Tags":"Regular",      "Notes":"",              "Total Visits":2,"Total Spend":4800, "Loyalty Points":120,"Created At":"2024-03-22" },
                      { "Name":"Hina Malik",  "Phone":"923011112233","Email":"",                "Gender":"female","Date of Birth":"",          "Location":"Main Branch","Source":"manual",  "Tags":"Bridal",       "Notes":"Bridal package", "Total Visits":1,"Total Spend":8000, "Loyalty Points":200,"Created At":"2024-06-01" },
                    ];
                    const ws = XLSX.utils.json_to_sheet(sample, { header: EXPORT_COLS });
                    // Bold the header row
                    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
                    for (let c = range.s.c; c <= range.e.c; c++) {
                      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
                      if (cell) cell.s = { font: { bold: true } };
                    }
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, "Clients Template");
                    XLSX.writeFile(wb, "clients-import-template.xlsx");
                  }}
                  style={{ display:"flex",alignItems:"center",gap:5,padding:"5px 12px",borderRadius:8,border:"1px solid #c4b5fd",background:"#fff",fontSize:11,fontWeight:700,color:"#5B21B6",cursor:"pointer",whiteSpace:"nowrap" }}>
                  <Download size={12} /> Download Template
                </button>
              </div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"2px 16px",fontSize:11 }}>
                {[
                  ["Name","Required — client full name"],
                  ["Phone","Required — with country code"],
                  ["Email","Optional"],
                  ["Gender","female / male / other"],
                  ["Date of Birth","YYYY-MM-DD format"],
                  ["Location","Branch name, e.g. Main Branch"],
                  ["Source","walk-in / whatsapp / manual"],
                  ["Tags","Comma-separated, e.g. VIP, Regular"],
                  ["Notes","Any freeform note"],
                  ["Total Visits","Number"],
                  ["Total Spend","Amount in PKR"],
                  ["Loyalty Points","Number"],
                  ["Created At","YYYY-MM-DD format"],
                ].map(([col, hint]) => (
                  <div key={col}>
                    <span style={{ fontWeight:700,color:"#4c1d95" }}>{col}</span>
                    <span style={{ color:"#7c3aed",marginLeft:4 }}>— {hint}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Step: preview */}
        {step === "preview" && (
          <>
            <div style={{ padding:"12px 16px",background:"#f0fdf4",border:"1px solid #86efac",borderRadius:12,marginBottom:16,fontSize:13,color:"#14532d",fontWeight:600 }}>
              ✓ Found <strong>{parsed.length}</strong> new client{parsed.length!==1?"s":""} ready to import
            </div>
            {parsed.length > 0 && (
              <div style={{ maxHeight:240,overflowY:"auto",border:"1px solid #e8e8f0",borderRadius:12,marginBottom:16 }}>
                <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
                  <thead><tr style={{ background:"#f5f3ff" }}>
                    {["Name","Phone","Email","Tags"].map(h=><th key={h} style={{ padding:"8px 12px",textAlign:"left",fontWeight:700,color:"#5B21B6",fontSize:11 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {parsed.slice(0,50).map((c,i)=>(
                      <tr key={c.id} style={{ borderTop:"1px solid #f0f0f8",background:i%2===0?"#fff":"#fdfcff" }}>
                        <td style={{ padding:"7px 12px",fontWeight:600,color:"#1a1a2e" }}>{c.name}</td>
                        <td style={{ padding:"7px 12px",color:"#6b6b8a" }}>{c.phone}</td>
                        <td style={{ padding:"7px 12px",color:"#6b6b8a" }}>{c.email||"—"}</td>
                        <td style={{ padding:"7px 12px",color:"#6b6b8a" }}>{c.tags.join(", ")||"—"}</td>
                      </tr>
                    ))}
                    {parsed.length>50&&<tr><td colSpan={4} style={{ padding:"8px 12px",color:"#9898b0",fontSize:11,textAlign:"center" }}>…and {parsed.length-50} more</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
            {parsed.length === 0 && (
              <div style={{ padding:"20px",textAlign:"center",color:"#9898b0",fontSize:13 }}>No new clients found — all rows already exist or are missing Name/Phone.</div>
            )}
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>setStep("pick")} style={{ flex:1,padding:"11px 0",borderRadius:10,border:"1px solid #e8e8f0",background:"#fff",fontSize:13,fontWeight:600,color:"#6b6b8a",cursor:"pointer" }}>Back</button>
              <button onClick={confirmImport} disabled={parsed.length===0}
                style={{ flex:2,padding:"11px 0",borderRadius:10,border:"none",background:parsed.length>0?"linear-gradient(135deg,#5B21B6,#9333EA)":"#e8e8f0",fontSize:13,fontWeight:700,color:parsed.length>0?"#fff":"#b0b0c8",cursor:parsed.length>0?"pointer":"not-allowed" }}>
                Import {parsed.length} Client{parsed.length!==1?"s":""}
              </button>
            </div>
          </>
        )}

        {/* Step: done */}
        {step === "done" && result && (
          <div style={{ textAlign:"center",padding:"12px 0" }}>
            <div style={{ fontSize:44,marginBottom:12 }}>🎉</div>
            <div style={{ fontSize:18,fontWeight:800,color:"#1a1a2e",marginBottom:6 }}>Import Complete!</div>
            <div style={{ fontSize:14,color:"#6b6b8a",marginBottom:20 }}>
              <strong style={{ color:"#059669" }}>{result.added}</strong> client{result.added!==1?"s":""} added successfully
            </div>
            <button onClick={onClose} style={{ padding:"11px 36px",borderRadius:10,border:"none",background:"linear-gradient(135deg,#5B21B6,#9333EA)",fontSize:13,fontWeight:700,color:"#fff",cursor:"pointer" }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ClientsPage() {
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState(() => getActiveLocationFilter());
  const [sectionFilter, setSectionFilter] = useState(() => getActiveSection());
  const [sortFilter, setSortFilter] = useState("none");
  const [selected, setSelected] = useState<Client | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteSelected, setShowDeleteSelected] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [locations, setLocations] = useState<SalonLocation[]>(() => getSalonLocations());

  const [clients, setClients] = useState<Client[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);

  useEffect(() => {
    const load = () => {
      const storedAppts   = getStoredAppointments();
      const storedClients = getStoredClients();

      // Recompute stats from completed appointments, but never decrease below POS-recorded values
      const synced = storedClients.map((c) => {
        const withLocation = { ...c, locationId: c.locationId || getDefaultLocationId() };
        const done = storedAppts.filter((a) => a.clientId === c.id && a.status === "completed");
        if (done.length === 0) return withLocation;
        const apptVisits    = done.length;
        const apptSpend     = done.reduce((s, a) => s + a.totalAmount, 0);
        const lastVisitDate = done.sort((a, b) => b.date.localeCompare(a.date))[0].date;
        // Use the higher of stored (POS-tracked) vs appointment-computed values
        const totalVisits = Math.max(c.totalVisits || 0, apptVisits);
        const totalSpend  = Math.max(c.totalSpend  || 0, apptSpend);
        return { ...withLocation, totalVisits, totalSpend, lastVisitDate };
      });

      // Persist only if something actually changed
      if (JSON.stringify(synced) !== JSON.stringify(storedClients)) {
        saveClients(synced);
      }

      setClients(synced);
      setAppointments(storedAppts);
    };
    load();
    // Re-read on every DB sync / cross-tab write / tab refocus, so this page
    // never keeps showing — or saving from — a list that predates clients added
    // on another terminal.
    return subscribeToStoredData(load);
  }, []);

  useEffect(() => {
    function refreshLocations() {
      setLocations(getSalonLocations());
      setLocationFilter(getActiveLocationFilter());
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, refreshLocations);
    window.addEventListener("focus", refreshLocations);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refreshLocations);
      window.removeEventListener("focus", refreshLocations);
    };
  }, []);

  const plan          = getCurrentPlan();
  const clientLimited = isAtLimit(plan.clientLimit, clients.length);

  const filtered = useMemo(() => {
    const result = clients.filter((c) => {
      if (tagFilter !== "all" && !c.tags.includes(tagFilter)) return false;
      if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
      if (locationFilter !== "all" && clientLocationId(c) !== locationFilter) return false;
      if (!inSection(c, sectionFilter)) return false;
      if (search) {
        const q = search.toLowerCase();
        return c.name.toLowerCase().includes(q) || c.phone.includes(q) || (c.email ?? "").toLowerCase().includes(q);
      }
      return true;
    });
    if (sortFilter === "topSpend")  return [...result].sort((a, b) => b.totalSpend  - a.totalSpend);
    if (sortFilter === "lowSpend")  return [...result].sort((a, b) => a.totalSpend  - b.totalSpend);
    if (sortFilter === "topVisits") return [...result].sort((a, b) => b.totalVisits - a.totalVisits);
    return result;
  }, [clients, search, tagFilter, sourceFilter, locationFilter, sectionFilter, sortFilter]);

  const allTags = Array.from(new Set(clients.flatMap((c) => c.tags)));
  const allSources = Array.from(new Set(clients.map((c) => c.source)));
  const activeFilters = [tagFilter !== "all", sourceFilter !== "all", getActiveSection() === "all" && sectionFilter !== "all", sortFilter !== "none"].filter(Boolean).length;

  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id));
  const someFilteredSelected = filtered.some((c) => selectedIds.has(c.id));

  const toggleSelectAll = (checked: boolean) => {
    if (!checked) {
      setSelectedIds((prev) => { const next = new Set(prev); filtered.forEach((c) => next.delete(c.id)); return next; });
    } else {
      setSelectedIds((prev) => { const next = new Set(prev); filtered.forEach((c) => next.add(c.id)); return next; });
    }
  };

  const setOneSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const openClient = (client: Client) => {
    setSelected(client);
  };

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 20 }}>

      {selected && (
        <ClientPanel
          client={selected}
          onClose={() => setSelected(null)}
          appointments={appointments}
          locations={locations}
          onUpdate={(updatedC) => {
            setClients((prevClients) => {
              const updatedList = prevClients.map((c) => c.id === updatedC.id ? updatedC : c);
              saveClients(updatedList);
              return updatedList;
            });
            setSelected(updatedC);
          }}
          onDelete={(id) => {
            setClients((prevClients) => {
              const updated = prevClients.filter((c) => c.id !== id);
              saveClients(updated, [id]);
              return updated;
            });
            setSelected(null);
          }}
        />
      )}
      {showAdd && (
        <AddClientModal
          onClose={() => setShowAdd(false)}
          locations={locations}
          allowLocationSelection={plan.multiLocation}
          clients={clients}
          onAdd={(newC) => {
            setClients((prevClients) => {
              const updated = [newC, ...prevClients];
              saveClients(updated);
              return updated;
            });
          }}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          clientName={deleteTarget.name}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            setClients((prev) => {
              const updated = prev.filter((c) => c.id !== deleteTarget.id);
              saveClients(updated, [deleteTarget.id]);
              return updated;
            });
            setDeleteTarget(null);
          }}
        />
      )}
      {showDeleteAll && (
        <DeleteAllConfirmModal
          count={clients.length}
          onCancel={() => setShowDeleteAll(false)}
          onConfirm={() => {
            saveClients([], clients.map((c) => c.id));
            setClients([]);
            setSelectedIds(new Set());
            setShowDeleteAll(false);
          }}
        />
      )}
      {showImport && (
        <ImportModal
          existing={clients}
          onClose={() => setShowImport(false)}
          onImport={(newClients) => {
            setClients((prev) => {
              const merged = [...newClients, ...prev];
              saveClients(merged);
              return merged;
            });
          }}
        />
      )}

      {showDeleteSelected && (
        <DeleteAllConfirmModal
          count={selectedIds.size}
          onCancel={() => setShowDeleteSelected(false)}
          onConfirm={() => {
            setClients((prev) => {
              const updated = prev.filter((c) => !selectedIds.has(c.id));
              saveClients(updated, [...selectedIds]);
              return updated;
            });
            setSelectedIds(new Set());
            setShowDeleteSelected(false);
          }}
        />
      )}

      {/* Native mobile app bar */}
      <MobilePageHeader
        title="Clients"
        subtitle={`${filtered.length} clients`}
        action={{ label: clientLimited ? "Limit reached" : "Add", icon: <Plus size={14} />, onClick: () => !clientLimited && setShowAdd(true) }}
      />

      {/* Header */}
      <div className="dashboard-topbar page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <PageTitle
          icon={<Heart size={24} />}
          title="Clients"
          subtitle={
            <>
            {filtered.length} clients
            {locationFilter !== "all" && <span style={{ marginLeft: 8, color: "var(--accent)", fontWeight: 700 }}>· {locationName(locationFilter)}</span>}
            {plan.clientLimit !== -1 && <span style={{ marginLeft: 8, color: clientLimited ? "#dc2626" : "#b0b0c8", fontWeight: 700 }}>· {clients.length}/{plan.clientLimit} on Free plan</span>}
            </>
          }
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {clients.length > 0 && (
            <button
              onClick={() => setShowDeleteAll(true)}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 12, border: "1px solid #fecaca", background: "#fef2f2", fontSize: 13, fontWeight: 750, color: "#dc2626", cursor: "pointer", transition: "all 0.15s" }}
              className="hover-bg-light"
            >
              <Trash2 size={14} /> Delete All
            </button>
          )}

          {/* Import button */}
          <button
            onClick={() => setShowImport(true)}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 12, border: "1px solid rgba(124, 58, 237, 0.15)", background: "rgba(124, 58, 237, 0.04)", fontSize: 13, fontWeight: 750, color: "var(--accent)", cursor: "pointer", transition: "all 0.15s" }}
            className="hover-bg-light"
          >
            <Upload size={14} /> Import
          </button>

          {/* Export dropdown */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowExportMenu((v) => !v)}
              disabled={clients.length === 0}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 12, border: "1px solid rgba(124, 58, 237, 0.15)", background: "rgba(124, 58, 237, 0.04)", fontSize: 13, fontWeight: 750, color: clients.length === 0 ? "#b0b0c8" : "var(--accent)", cursor: clients.length === 0 ? "not-allowed" : "pointer", transition: "all 0.15s" }}
              className="hover-bg-light"
            >
              <Download size={14} /> Export <ChevronDown size={12} style={{ transform: showExportMenu ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
            </button>
            {showExportMenu && (
              <>
                <div onClick={() => setShowExportMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
                <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "#fff", border: "1px solid #e8e8f0", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.08)", zIndex: 20, minWidth: 160, overflow: "hidden" }}>
                  {[
                    { fmt: "xlsx" as const, label: "Excel (.xlsx)", icon: "📊" },
                    { fmt: "csv"  as const, label: "CSV (.csv)",   icon: "📄" },
                  ].map(({ fmt, label, icon }) => (
                    <button key={fmt} onClick={() => { setShowExportMenu(false); exportClients(filtered.length < clients.length ? filtered : clients, fmt); }}
                      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "11px 16px", border: "none", background: "none", fontSize: 13, fontWeight: 750, color: "#1a1a2e", cursor: "pointer", textAlign: "left", transition: "background 0.15s" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f5f3ff")}
                      onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                      <span>{icon}</span>{label}
                    </button>
                  ))}
                  {filtered.length < clients.length && (
                    <div style={{ padding: "6px 16px 10px", fontSize: 11, color: "#9898b0", borderTop: "1px solid #f0f0f8" }}>
                      Exports {filtered.length} filtered clients
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => !clientLimited && setShowAdd(true)}
            title={clientLimited ? `Free plan: ${plan.clientLimit} client limit reached. Upgrade to Pro for unlimited.` : ""}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 12, border: "none", background: clientLimited ? "#e8e8f0" : "var(--accent-gradient)", fontSize: 13, fontWeight: 750, color: clientLimited ? "#aaaabc" : "#fff", boxShadow: clientLimited ? "none" : "0 4px 14px var(--accent-glow)", cursor: clientLimited ? "not-allowed" : "pointer", transition: "all 0.18s ease" }}
            className={!clientLimited ? "page-header-btn" : ""}
          >
            <Plus size={16} /> Add Client
            {clientLimited && <span style={{ fontSize: 10, background: "#dc2626", color: "#fff", borderRadius: 20, padding: "1px 7px" }}>Limit reached</span>}
          </button>
        </div>
      </div>

      {clientLimited && (
        <div style={{
          padding: "14px 20px",
          borderRadius: 14,
          background: "#fef2f2",
          border: "1px solid #fecaca",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          boxShadow: "0 4px 12px rgba(220,38,38,0.03)"
        }}>
          <span style={{ fontSize: 13, color: "#991b1b", fontWeight: 700 }}>
            Free plan allows up to {plan.clientLimit} clients. Upgrade to Pro for unlimited client management.
          </span>
          <a href="/dashboard/billing" style={{ fontSize: 11, fontWeight: 800, color: "#7C3AED", textDecoration: "none", whiteSpace: "nowrap", background: "#fff", border: "1px solid rgba(124,58,237,0.15)", borderRadius: 8, padding: "6px 12px", boxShadow: "0 2px 6px rgba(0,0,0,0.02)", transition: "all 0.15s" }} className="hover-bg-light">Upgrade Plan</a>
        </div>
      )}

      {/* Search + filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid #e3e0eb", borderRadius: 12, padding: "10px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.01)", transition: "border-color 0.15s" }}>
          <Search size={15} color="#b0b0c8" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, phone, or email…"
            style={{ flex: 1, border: "none", outline: "none", fontSize: 13, color: "#1a1a2e", background: "transparent" }} />
          {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", padding: 0 }}><X size={14} color="#b0b0c8" /></button>}
        </div>
        <button onClick={() => setShowFilters(!showFilters)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 18px", borderRadius: 12, border: `1px solid ${activeFilters > 0 ? "var(--accent-light)" : "#e3e0eb"}`, background: activeFilters > 0 ? "rgba(124, 58, 237, 0.04)" : "#fff", fontSize: 13, fontWeight: 750, color: activeFilters > 0 ? "var(--accent)" : "#6b6b8a", cursor: "pointer", transition: "all 0.15s" }} className="hover-bg-light">
          Filter
          {activeFilters > 0 && <span style={{ background: "var(--accent-gradient)", color: "#fff", borderRadius: "50%", width: 18, height: 18, fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px var(--accent-glow)" }}>{activeFilters}</span>}
          <ChevronDown size={13} style={{ transform: showFilters ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#b0b0c8", fontWeight: 600 }}>
          {filtered.length} client{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {showFilters && (
        <div style={{
          background: "#fff",
          border: "1px solid rgba(226,223,235,.95)",
          borderRadius: 14,
          padding: "16px 20px",
          display: "flex",
          gap: 20,
          flexWrap: "wrap",
          alignItems: "flex-end",
          boxShadow: "0 8px 24px rgba(38,25,75,.03)"
        }}>
          {[
            { label: "Tag", value: tagFilter, onChange: setTagFilter, options: [["all", "All Tags"], ...allTags.map((t) => [t, t])] },
            { label: "Source", value: sourceFilter, onChange: setSourceFilter, options: [["all", "All Sources"], ...allSources.map((s) => [s, s])] },
            {
              // Locked to the active dashboard section when one is set — switch
              // the global "Active Section" control to see other clients.
              label: "Section", value: sectionFilter, onChange: setSectionFilter,
              options: getActiveSection() !== "all"
                ? [[getActiveSection(), `${getActiveSection()} (locked)`]]
                : [["all", "All Sections"], ...getSectionOptions(clients).map((s) => [s, s])],
              locked: getActiveSection() !== "all",
            },
            { label: "Sort By", value: sortFilter, onChange: setSortFilter, options: [["none", "Default"], ["topSpend", "Top Spenders"], ["lowSpend", "Low Spenders"], ["topVisits", "Top Visits"]] },
          ].map(({ label, value, onChange, options, locked }) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
              <select value={value} onChange={(e) => onChange(e.target.value)} disabled={locked} style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #e3e0eb", fontSize: 13, color: "#1a1a2e", outline: "none", background: locked ? "#faf9fd" : "#fff", cursor: locked ? "not-allowed" : "pointer", opacity: locked ? 0.75 : 1 }}>
                {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          ))}
          {activeFilters > 0 && (
            <button onClick={() => { setTagFilter("all"); setSourceFilter("all"); if (getActiveSection() === "all") setSectionFilter("all"); setSortFilter("none"); }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", fontSize: 12, fontWeight: 700, color: "#dc2626", cursor: "pointer", transition: "all 0.15s" }}>Clear all</button>
          )}
        </div>
      )}

      {/* Selection action bar */}
      {someFilteredSelected && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 12, background: "#1a1a2e", color: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{selectedIds.size} client{selectedIds.size !== 1 ? "s" : ""} selected</span>
          <button
            onClick={() => setShowDeleteSelected(true)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 8, border: "none", background: "#dc2626", fontSize: 12, fontWeight: 800, color: "#fff", cursor: "pointer" }}>
            <Trash2 size={13} /> Delete Selected
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#ccc", fontSize: 12, fontWeight: 750, cursor: "pointer" }}>
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="table-scroll-wrap" style={{
        background: "#fff",
        borderRadius: 18,
        border: "1px solid rgba(226,223,235,.95)",
        boxShadow: "0 8px 28px rgba(38,25,75,.04)",
        overflow: "hidden"
      }}>
        {/* Desktop: dense scrollable table */}
        <div className="desktop-only">
        <div className="table-scroll-inner">
        <div className="client-table-inner" style={{ background: "#fff" }}>
        <div style={{ display: "grid", gridTemplateColumns: "40px 1.2fr 1.1fr 1fr 1fr 1.1fr 90px 110px 130px", padding: "12px 20px", borderBottom: "1px solid #f0f0f5", background: "#faf9fd", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <input
              type="checkbox"
              aria-label="Select all visible clients"
              checked={allFilteredSelected}
              ref={el => { if (el) el.indeterminate = someFilteredSelected && !allFilteredSelected; }}
              onChange={(event) => toggleSelectAll(event.currentTarget.checked)}
              style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#7C3AED" }}
            />
          </div>
          {["CLIENT", "PHONE", "LOCATION", "SOURCE", "LAST VISIT", "VISITS", "TOTAL SPEND", ""].map((h) => (
            <div key={h} style={{ fontSize: 10, fontWeight: 800, color: "#8e89a3", letterSpacing: "0.08em" }}>{h}</div>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "#b0b0c8", fontSize: 14 }}>No clients match your search.</div>
        ) : filtered.map((client, i) => {
          const isLast = i === filtered.length - 1;
          const isChecked = selectedIds.has(client.id);
          return (
            <div
              key={client.id}
              tabIndex={0}
              aria-label={`Open ${client.name}'s profile`}
              onClick={() => openClient(client)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openClient(client);
                }
              }}
              style={{ display: "grid", gridTemplateColumns: "40px 1.2fr 1.1fr 1fr 1fr 1.1fr 90px 110px 130px", padding: "14px 20px", borderBottom: isLast ? "none" : "1px solid #f8f8fc", alignItems: "center", cursor: "pointer", background: isChecked ? "#F5F3FF" : "transparent", transition: "background 0.2s" }}
              className="hover-bg-row"
            >
              {/* Checkbox */}
              <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center" }}>
                <input
                  type="checkbox"
                  aria-label={`Select ${client.name}`}
                  checked={isChecked}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    setOneSelected(client.id, event.currentTarget.checked);
                  }}
                  style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#7C3AED" }}
                />
              </div>
              {/* Client */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ClientAvatar name={client.name} photo={client.photo} size={34} style={{
                  background: "linear-gradient(135deg, #9333EA15, #ec489915)", fontSize: 13, fontWeight: 700,
                  color: "#9333EA", border: "1.5px solid rgba(255,255,255,0.8)", boxShadow: "0 2px 4px rgba(0,0,0,0.04)",
                }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e", letterSpacing: "-0.01em" }}>{client.name}</div>
                  <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                    {client.tags.map((tag) => {
                      const tc = TAG_COLORS[tag] ?? { color: "#6b6b8a", bg: "#F5F3FF" };
                      return <span key={tag} style={{ fontSize: 9, fontWeight: 800, color: tc.color, background: tc.bg, padding: "1px 6px", borderRadius: 10, textTransform: "uppercase", letterSpacing: "0.02em" }}>{tag}</span>;
                    })}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 13, color: "#1a1a2e", fontWeight: 600 }}>{client.phone}</div>
              <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 700 }}>{locationName(clientLocationId(client))}</div>
              <div style={{ fontSize: 12, color: "#6b6b8a", textTransform: "capitalize", fontWeight: 500 }}>{client.source}</div>
              <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 500 }}>{fmtDate(client.lastVisitDate)}</div>
              <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{client.totalVisits}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)" }}>{fmt(client.totalSpend)}</div>
              <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openClient(client);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", fontSize: 11, fontWeight: 700, color: "#6b6b8a", cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.15s" }}
                  className="hover-bg-light"
                >
                  <ExternalLink size={11} /> View
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${client.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDeleteTarget(client);
                  }}
                  title="Delete client"
                  style={{ display: "flex", alignItems: "center", padding: "6px 8px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", cursor: "pointer", transition: "all 0.15s" }}
                >
                  <Trash2 size={12} color="#dc2626" />
                </button>
              </div>
            </div>
          );
        })}
        </div>{/* /client-table-inner */}
        </div>{/* /table-scroll-inner */}
        </div>{/* /desktop-only */}

        {/* Mobile: stacked card list */}
        <div className="mobile-only">
          {filtered.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#b0b0c8", fontSize: 14 }}>No clients match your search.</div>
          ) : filtered.map((client, i) => {
            const isLast = i === filtered.length - 1;
            return (
              <div
                key={client.id}
                onClick={() => openClient(client)}
                style={{ padding: "14px 16px", borderBottom: isLast ? "none" : "1px solid #f8f8fc", display: "flex", flexDirection: "column", gap: 8, cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <ClientAvatar name={client.name} photo={client.photo} size={34} style={{
                    background: "linear-gradient(135deg, #9333EA15, #ec489915)", fontSize: 13, fontWeight: 700, color: "#9333EA",
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 750, color: "#1a1a2e" }}>{client.name}</div>
                    <div style={{ fontSize: 11, color: "#9898b0", marginTop: 1 }}>{client.phone}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)" }}>{fmt(client.totalSpend)}</div>
                    <div style={{ fontSize: 10, color: "#9898b0", marginTop: 1 }}>{client.totalVisits} visit{client.totalVisits !== 1 ? "s" : ""}</div>
                  </div>
                </div>
                {client.tags.length > 0 && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", paddingLeft: 44 }}>
                    {client.tags.map((tag) => {
                      const tc = TAG_COLORS[tag] ?? { color: "#6b6b8a", bg: "#F5F3FF" };
                      return <span key={tag} style={{ fontSize: 9, fontWeight: 800, color: tc.color, background: tc.bg, padding: "1px 6px", borderRadius: 10, textTransform: "uppercase", letterSpacing: "0.02em" }}>{tag}</span>;
                    })}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 44, gap: 8 }}>
                  <div style={{ fontSize: 11, color: "#9898b0" }}>
                    {locationName(clientLocationId(client))} · <span style={{ textTransform: "capitalize" }}>{client.source}</span> · {fmtDate(client.lastVisitDate)}
                  </div>
                  <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); openClient(client); }}
                      style={{ display: "flex", alignItems: "center", padding: "6px 10px", borderRadius: 8, border: "1px solid #e3e0eb", background: "#fff", cursor: "pointer" }}
                    >
                      <ExternalLink size={12} color="#6b6b8a" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${client.name}`}
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setDeleteTarget(client); }}
                      style={{ display: "flex", alignItems: "center", padding: "6px 8px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", cursor: "pointer" }}
                    >
                      <Trash2 size={12} color="#dc2626" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>{/* /table-scroll-wrap */}
    </div>
  );
}
