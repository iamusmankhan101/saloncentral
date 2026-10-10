"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AlertTriangle, CreditCard, LayoutDashboard, User, Users, ClipboardList, CheckCircle, XCircle, X, CalendarCheck, WifiOff, MapPin, Plus, Trash2 } from "lucide-react";
import type { WaLogEntry } from "@/lib/whatsapp-scheduler";
import Sidebar from "@/components/sidebar";
import FloorTopBar from "@/components/floor-top-bar";
import OfflineStatus from "@/components/offline-status";
import { getCurrentUser, checkServerSession, signOut } from "@/lib/auth";
import { applyAppearanceSettings, SETTINGS_CHANGED_EVENT, reloadSettings, settingsStore } from "@/lib/settings-store";
import { runWhatsAppScheduler } from "@/lib/whatsapp-scheduler";
import { startOfflineFlush, syncFromDB, syncLocalDataToDB } from "@/lib/turso-sync";
import { checkInvoiceNotifications } from "@/lib/invoice-notifier";
import { getStoredInventory, getStoredStaff, getStoredServices } from "@/lib/storage";
import { getActiveSection, setActiveSection, getSectionOptions } from "@/lib/sections";
import type { Invoice } from "@/lib/invoices";
import { PLAN_CONFIGS, getCurrentPlanId, type PlanId } from "@/lib/plan-limits";
import { setActivePlan } from "@/lib/payment-requests";
import { addSalonLocation, clearLocationLocalData, getActiveLocationFilter, getSalonLocations, removeSalonLocation, setActiveLocationFilter, type SalonLocation } from "@/lib/locations";
import { whatsAppConnected } from "@/lib/whatsapp-scheduler";
import { settleServiceConsumption } from "@/lib/inventory-consumption";
import { businessTypeOf } from "@/lib/clinic-core";

// ─── Notification chime ───────────────────────────────────────────────────────

function playChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    [[523.25, 0], [659.25, 0.18], [783.99, 0.36]].forEach(([freq, delay]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.35, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.9);
      osc.start(now + delay);
      osc.stop(now + delay + 0.9);
    });
  } catch { /* not supported */ }
}

// ─── Suspension gate overlay ──────────────────────────────────────────────────

function SuspensionGate({ reason }: { reason: string | null }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 999,
      background: "rgba(10,10,20,0.82)",
      display: "flex", alignItems: "center", justifyContent: "center",
      backdropFilter: "blur(6px)",
      padding: 24,
    }}>
      <div style={{
        background: "#fff", borderRadius: 20, maxWidth: 460, width: "100%",
        boxShadow: "0 24px 80px rgba(0,0,0,0.4)", overflow: "hidden",
      }}>
        {/* Red header */}
        <div style={{ background: "linear-gradient(135deg,#dc2626,#ef4444)", padding: "28px 32px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <AlertTriangle size={24} color="#fff" />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.75)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em" }}>Account Status</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#fff", marginTop: 2 }}>Account Suspended</div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "28px 32px" }}>
          <p style={{ fontSize: 14, color: "#4a4a6a", lineHeight: 1.75, margin: "0 0 20px" }}>
            Your Salon Central plan has been <strong style={{ color: "#dc2626" }}>suspended</strong> due to a missed invoice payment.
            Your data is safe — access will be restored within minutes of payment confirmation.
          </p>

          {reason && (
            <div style={{ padding: "12px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 12, color: "#991b1b", marginBottom: 20, lineHeight: 1.6 }}>
              {reason}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Link
              href="/dashboard/billing"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                padding: "13px 0", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg,#5B21B6,#9333EA)",
                fontSize: 14, fontWeight: 700, color: "#fff", textDecoration: "none",
              }}
            >
              <CreditCard size={16} /> Go to Billing &amp; Pay
            </Link>
            <div style={{ fontSize: 11, color: "#b0b0c8", textAlign: "center", lineHeight: 1.6 }}>
              Submit your payment screenshot in Billing. Admin reviews within minutes.<br />
              Questions? Contact <strong>support@saloncentral.xyz</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardLocationSwitcher({ onLocationChange }: { onLocationChange: (locationId: string) => Promise<void> }) {
  const [locations, setLocations] = useState<SalonLocation[]>(() => getSalonLocations());
  const [activeLocation, setActiveLocation] = useState(() => getActiveLocationFilter());
  const [showAddLocation, setShowAddLocation] = useState(false);
  const [locationForm, setLocationForm] = useState<{ name: string; address: string; city: string; businessType: "salon" | "clinic" }>({ name: "", address: "", city: "", businessType: "salon" });
  const [locationError, setLocationError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [showManageLocations, setShowManageLocations] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [manageError, setManageError] = useState("");

  useEffect(() => {
    function refresh() {
      setLocations(getSalonLocations());
      setActiveLocation(getActiveLocationFilter());
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // A focused <input type="number"> silently increments/decrements by its
  // step on every mouse-wheel notch in Chrome/Firefox/Edge — including an
  // incidental scroll while the cursor just happens to be resting over the
  // field (very easy in a form) — AND on every ArrowUp/ArrowDown keypress,
  // which is just as easy to bump by accident (e.g. tabbing through a form
  // and hitting an arrow key out of habit). That's how a salary typed as
  // 12000 quietly becomes 11999: one accidental key or scroll tick, not a
  // rounding/precision bug. Blurring on wheel, and blocking the arrow-key
  // step (site-wide, not per-input), stops the value from changing either way.
  useEffect(() => {
    function blurNumberInputOnWheel() {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.type === "number") el.blur();
    }
    function blockNumberStepArrowKeys(e: KeyboardEvent) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.type === "number") e.preventDefault();
    }
    document.addEventListener("wheel", blurNumberInputOnWheel, { passive: true });
    document.addEventListener("keydown", blockNumberStepArrowKeys);
    return () => {
      document.removeEventListener("wheel", blurNumberInputOnWheel);
      document.removeEventListener("keydown", blockNumberStepArrowKeys);
    };
  }, []);

  async function changeLocation(locationId: string) {
    if (locationId === activeLocation || switching) return;
    setSwitching(true);
    const nextId = setActiveLocationFilter(locationId);
    setActiveLocation(nextId);
    setLocations(getSalonLocations());
    try {
      await onLocationChange(nextId);
    } finally {
      setSwitching(false);
    }
  }

  function handleAddLocation() {
    setLocationError("");
    try {
      const location = addSalonLocation(locationForm);
      setShowAddLocation(false);
      setLocationForm({ name: "", address: "", city: "", businessType: "salon" });
      void changeLocation(location.id);
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : "Unable to add this location.");
    }
  }

  async function handleDeleteLocation(locationId: string) {
    if (deletingId) return;
    setDeletingId(locationId);
    setManageError("");
    try {
      const { nextActiveId } = removeSalonLocation(locationId);
      clearLocationLocalData(locationId);
      // Best-effort cleanup of this branch's rows in the shared DB — local
      // cleanup already happened, so a failed fetch just leaves orphaned rows
      // that no branch will ever read again.
      try {
        await fetch(`/api/db?locationId=${encodeURIComponent(locationId)}`, { method: "DELETE" });
      } catch (err) {
        console.warn("[locations] Failed to delete branch rows from DB:", err);
      }
      setLocations(getSalonLocations());
      // If the deleted branch was active, switch the dashboard onto the new
      // active branch and re-sync its data so pages remount with fresh state.
      if (activeLocation === locationId) {
        setActiveLocation(nextActiveId);
        setSwitching(true);
        try {
          await onLocationChange(nextActiveId);
        } finally {
          setSwitching(false);
        }
      }
      setConfirmingDeleteId(null);
    } catch (error) {
      setManageError(error instanceof Error ? error.message : "Unable to delete this location.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      margin: "16px 20px 0",
      padding: "12px 14px",
      border: "1px solid rgba(124,58,237,0.13)",
      borderRadius: 16,
      background: "linear-gradient(135deg, rgba(124,58,237,0.06), rgba(255,255,255,0.95))",
      boxShadow: "0 10px 28px rgba(35,20,70,0.045)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
          background: "var(--accent-gradient)",
          boxShadow: "0 5px 16px var(--accent-glow)",
          flexShrink: 0,
        }}>
          <MapPin size={17} color="#fff" />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 850, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.09em" }}>
            Active Location
          </div>
          <div style={{ fontSize: 12, color: "#777792", fontWeight: 650, marginTop: 2 }}>
            All appointments, sales, stock, staff and reports belong to this branch.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <select
          value={activeLocation}
          onChange={(e) => void changeLocation(e.target.value)}
          disabled={switching}
          style={{
            minWidth: 180,
            padding: "9px 34px 9px 12px",
            borderRadius: 12,
            border: "1px solid #ddd6fe",
            background: "#fff",
            color: "#1a1a2e",
            fontSize: 13,
            fontWeight: 800,
            outline: "none",
            cursor: switching ? "wait" : "pointer",
            opacity: switching ? 0.65 : 1,
            boxShadow: "0 3px 10px rgba(38,25,75,0.04)",
          }}
          aria-label="Select active dashboard location"
        >
          {locations.map((location) => (
            <option key={location.id} value={location.id}>{location.name}{businessTypeOf(settingsStore as Parameters<typeof businessTypeOf>[0], location.id) === "clinic" ? " (Clinic)" : ""}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => { setLocationError(""); setShowAddLocation(true); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 13px",
            borderRadius: 12,
            border: "1px solid #ddd6fe",
            background: "#fff",
            color: "var(--accent)",
            fontSize: 12,
            fontWeight: 850,
            cursor: "pointer",
            boxShadow: "0 3px 10px rgba(38,25,75,0.04)",
          }}
        >
          <Plus size={13} /> Add Location
        </button>
        <button
          type="button"
          onClick={() => { setManageError(""); setConfirmingDeleteId(null); setShowManageLocations(true); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 13px",
            borderRadius: 12,
            border: "1px solid #fecaca",
            background: "#fff",
            color: "#dc2626",
            fontSize: 12,
            fontWeight: 850,
            cursor: "pointer",
            boxShadow: "0 3px 10px rgba(38,25,75,0.04)",
          }}
        >
          <Trash2 size={13} /> Manage
        </button>
      </div>
    </div>
    {showAddLocation && (
      <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,15,35,0.45)", backdropFilter: "blur(4px)", display: "grid", placeItems: "center", padding: 20 }}>
        <div style={{ width: "min(520px, 100%)", background: "#fff", borderRadius: 20, boxShadow: "0 24px 80px rgba(25,15,50,0.25)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 22px", borderBottom: "1px solid #eeeaf6" }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#1a1a2e" }}>Add New Location</div>
              <div style={{ fontSize: 12, color: "#8a8aa3", marginTop: 3 }}>Create a separate branch workspace.</div>
            </div>
            <button type="button" onClick={() => setShowAddLocation(false)} style={{ border: 0, background: "#f5f3ff", width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", cursor: "pointer", color: "#766f8c" }} aria-label="Close add location form">
              <X size={17} />
            </button>
          </div>
          <div style={{ padding: 22, display: "grid", gap: 16 }}>
            <label style={{ display: "grid", gap: 7, fontSize: 12, fontWeight: 800, color: "#55536b" }}>
              Branch Name
              <input
                autoFocus
                value={locationForm.name}
                onChange={(event) => { setLocationForm((form) => ({ ...form, name: event.target.value })); setLocationError(""); }}
                placeholder="e.g. DHA Branch"
                style={{ padding: "12px 14px", border: "1px solid #ddd8e9", borderRadius: 12, outline: "none", fontSize: 14 }}
              />
            </label>
            <label style={{ display: "grid", gap: 7, fontSize: 12, fontWeight: 800, color: "#55536b" }}>
              Address
              <input
                value={locationForm.address}
                onChange={(event) => { setLocationForm((form) => ({ ...form, address: event.target.value })); setLocationError(""); }}
                placeholder="Street, block, building"
                style={{ padding: "12px 14px", border: "1px solid #ddd8e9", borderRadius: 12, outline: "none", fontSize: 14 }}
              />
            </label>
            <label style={{ display: "grid", gap: 7, fontSize: 12, fontWeight: 800, color: "#55536b" }}>
              City
              <input
                value={locationForm.city}
                onChange={(event) => setLocationForm((form) => ({ ...form, city: event.target.value }))}
                placeholder="e.g. Karachi"
                style={{ padding: "12px 14px", border: "1px solid #ddd8e9", borderRadius: 12, outline: "none", fontSize: 14 }}
              />
            </label>
            <div style={{ display: "grid", gap: 7, fontSize: 12, fontWeight: 800, color: "#55536b" }}>
              Branch Type
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }} role="radiogroup" aria-label="Branch type">
                {([["salon", "Salon / Spa", "Clients, services, stylists"], ["clinic", "Aesthetic Clinic", "Patients, consent, treatment records"]] as const).map(([id, title, sub]) => (
                  <button key={id} type="button" role="radio" aria-checked={locationForm.businessType === id}
                    onClick={() => setLocationForm((form) => ({ ...form, businessType: id }))}
                    style={{ textAlign: "left", padding: "10px 12px", borderRadius: 12, cursor: "pointer", border: `2px solid ${locationForm.businessType === id ? "#7C3AED" : "#ddd8e9"}`, background: locationForm.businessType === id ? "#f5f3ff" : "#fff" }}>
                    <div style={{ fontSize: 13, fontWeight: 850, color: "#1a1a2e" }}>{title}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#9898b0", marginTop: 2 }}>{sub}</div>
                  </button>
                ))}
              </div>
            </div>
            {locationError && <div role="alert" style={{ padding: "10px 12px", borderRadius: 10, background: "#fef2f2", color: "#b91c1c", fontSize: 12, fontWeight: 700 }}>{locationError}</div>}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "16px 22px", borderTop: "1px solid #eeeaf6", background: "#fcfbfe" }}>
            <button type="button" onClick={() => setShowAddLocation(false)} style={{ padding: "10px 17px", borderRadius: 11, border: "1px solid #ddd8e9", background: "#fff", color: "#68647b", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>Cancel</button>
            <button type="button" onClick={handleAddLocation} style={{ padding: "10px 18px", borderRadius: 11, border: 0, background: "var(--accent-gradient)", color: "#fff", fontSize: 13, fontWeight: 850, cursor: "pointer", boxShadow: "0 5px 14px var(--accent-glow)" }}>
              Add Location
            </button>
          </div>
        </div>
      </div>
    )}
    {showManageLocations && (
      <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,15,35,0.45)", backdropFilter: "blur(4px)", display: "grid", placeItems: "center", padding: 20 }}>
        <div style={{ width: "min(560px, 100%)", background: "#fff", borderRadius: 20, boxShadow: "0 24px 80px rgba(25,15,50,0.25)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 22px", borderBottom: "1px solid #eeeaf6" }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#1a1a2e" }}>Manage Locations</div>
              <div style={{ fontSize: 12, color: "#8a8aa3", marginTop: 3 }}>Delete a branch and its data permanently.</div>
            </div>
            <button type="button" onClick={() => setShowManageLocations(false)} style={{ border: 0, background: "#f5f3ff", width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", cursor: "pointer", color: "#766f8c" }} aria-label="Close manage locations">
              <X size={17} />
            </button>
          </div>
          <div style={{ padding: 22, display: "grid", gap: 12, maxHeight: "55vh", overflowY: "auto" }}>
            {locations.map((location) => {
              const isActive = location.id === activeLocation;
              const isLast = locations.length <= 1;
              const isConfirming = confirmingDeleteId === location.id;
              const isDeleting = deletingId === location.id;
              return (
                <div key={location.id} style={{ border: `1px solid ${isActive ? "#ddd6fe" : "#eeeaf6"}`, borderRadius: 14, background: isActive ? "#faf8ff" : "#fff", padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", background: isActive ? "var(--accent-gradient)" : "#f1f0f6", flexShrink: 0 }}>
                        <MapPin size={15} color={isActive ? "#fff" : "#8a8aa3"} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{location.name}</span>
                          {isActive && <span style={{ fontSize: 9, fontWeight: 850, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--accent)", background: "#ede9fe", padding: "2px 7px", borderRadius: 6 }}>Active</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "#9898b0", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {[location.address, location.city].filter(Boolean).join(" · ") || "No address set"}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isLast || isDeleting || !!deletingId}
                      onClick={() => { setManageError(""); setConfirmingDeleteId(isConfirming ? null : location.id); }}
                      style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 10, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 12, fontWeight: 800, cursor: isLast ? "not-allowed" : "pointer", opacity: isLast || isDeleting ? 0.45 : 1 }}
                    >
                      <Trash2 size={13} /> {isConfirming ? "Cancel" : "Delete"}
                    </button>
                  </div>
                  {isLast && <div style={{ fontSize: 11, color: "#b0b0c8", marginTop: 8 }}>You can&apos;t delete your only location — add another branch first.</div>}
                  {isConfirming && !isLast && (
                    <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 12, background: "#fef2f2", border: "1px solid #fecaca" }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#991b1b" }}>Delete “{location.name}” permanently?</div>
                      <div style={{ fontSize: 11.5, color: "#b91c1c", marginTop: 4, lineHeight: 1.6 }}>
                        All appointments, clients, staff, services, inventory, sales and WhatsApp data for this branch will be permanently deleted. This cannot be undone.
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
                        <button type="button" onClick={() => setConfirmingDeleteId(null)} style={{ padding: "8px 14px", borderRadius: 9, border: "1px solid #fecaca", background: "#fff", color: "#991b1b", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Cancel</button>
                        <button type="button" onClick={() => void handleDeleteLocation(location.id)} disabled={isDeleting} style={{ padding: "8px 14px", borderRadius: 9, border: 0, background: "#dc2626", color: "#fff", fontSize: 12, fontWeight: 850, cursor: isDeleting ? "wait" : "pointer", opacity: isDeleting ? 0.7 : 1 }}>
                          {isDeleting ? "Deleting…" : "Delete Permanently"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {manageError && <div role="alert" style={{ padding: "10px 22px", background: "#fef2f2", color: "#b91c1c", fontSize: 12, fontWeight: 700 }}>{manageError}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "16px 22px", borderTop: "1px solid #eeeaf6", background: "#fcfbfe" }}>
            <button type="button" onClick={() => setShowManageLocations(false)} style={{ padding: "10px 17px", borderRadius: 11, border: "1px solid #ddd8e9", background: "#fff", color: "#68647b", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>Close</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// A persistent "which section am I working" switcher — same-branch equivalent
// of DashboardLocationSwitcher, but far lighter: no separate data partition,
// just a default filter value every section-aware page (Staff, Services,
// Inventory, Clients, Appointments, POS) initializes from on mount. Only
// rendered once at least one staff member or service is actually tagged, so
// salons that don't use sections never see it.
function DashboardSectionSwitcher({ onSectionChange, compact = false }: { onSectionChange: (section: string) => void; compact?: boolean }) {
  const [options, setOptions] = useState<string[]>(() => getSectionOptions([...getStoredStaff(), ...getStoredServices()]));
  const [hasTagged, setHasTagged] = useState(() => [...getStoredStaff(), ...getStoredServices()].some((r) => r.section));
  const [activeSection, setActiveSectionState] = useState(() => getActiveSection());

  useEffect(() => {
    function refresh() {
      const records = [...getStoredStaff(), ...getStoredServices()];
      setOptions(getSectionOptions(records));
      setHasTagged(records.some((r) => r.section));
      setActiveSectionState(getActiveSection());
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  if (!hasTagged) return null;

  function changeSection(section: string) {
    if (section === activeSection) return;
    setActiveSection(section);
    setActiveSectionState(section);
    onSectionChange(section);
  }

  if (compact) {
    return (
      <select value={activeSection} onChange={(e) => changeSection(e.target.value)} aria-label="Select active dashboard section">
        <option value="all">All Sections</option>
        {options.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    );
  }

  return (
    <div className="section-switcher" style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      margin: "10px 20px 0",
      padding: "12px 14px",
      border: "1px solid rgba(124,58,237,0.13)",
      borderRadius: 16,
      background: "linear-gradient(135deg, rgba(124,58,237,0.06), rgba(255,255,255,0.95))",
      boxShadow: "0 10px 28px rgba(35,20,70,0.045)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
          background: "var(--accent-gradient)",
          boxShadow: "0 5px 16px var(--accent-glow)",
          flexShrink: 0,
        }}>
          <Users size={17} color="#fff" />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 850, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.09em" }}>
            Active Section
          </div>
          <div className="section-switcher-help" style={{ fontSize: 12, color: "#777792", fontWeight: 650, marginTop: 2 }}>
            Everything, including revenue, filters to this section. Switch to All Sections to see both combined.
          </div>
        </div>
      </div>

      <select
        value={activeSection}
        onChange={(e) => changeSection(e.target.value)}
        className="section-switcher-select"
        style={{
          minWidth: 160,
          padding: "9px 34px 9px 12px",
          borderRadius: 12,
          border: "1px solid #ddd6fe",
          background: "#fff",
          color: "#1a1a2e",
          fontSize: 13,
          fontWeight: 800,
          outline: "none",
          cursor: "pointer",
          boxShadow: "0 3px 10px rgba(38,25,75,0.04)",
        }}
        aria-label="Select active dashboard section"
      >
        <option value="all">All Sections</option>
        {options.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const [isReady,    setIsReady]    = useState(false);
  const [suspended,  setSuspended]  = useState(false);
  const [suspReason, setSuspReason] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toasts, setToasts] = useState<Array<WaLogEntry & { toastId: number }>>([]);
  const [bookingAlerts, setBookingAlerts] = useState<Array<{
    alertId: number;
    bookingId?: string;
    clientName: string;
    serviceNames: string[];
    date: string;
    startTime: string;
    totalAmount: number;
  }>>([]);
  const seenBookingAlertIds = useRef(new Set<string>());
  const [lowStockCount,     setLowStockCount]     = useState(0);
  const [outStockCount,     setOutStockCount]     = useState(0);
  const [unpaidInvoice, setUnpaidInvoice] = useState<{ number: string; amount: number; status: string; dueDate: string } | null>(null);
  const [invoiceBadgeDismissed, setInvoiceBadgeDismissed] = useState(false);
  const [waStatus,      setWaStatus]       = useState<"unknown" | "connected" | "disconnected">("unknown");
  const [waBannerDismissed, setWaBannerDismissed] = useState(false);
  const [locationRenderKey, setLocationRenderKey] = useState(() => getActiveLocationFilter());
  const [sectionRenderKey, setSectionRenderKey] = useState(() => getActiveSection());

  // A platform admin is not a salon account — they have no salon data, so
  // every salon-specific effect below is skipped for them.
  const isAdmin = getCurrentUser()?.role === "admin";

  async function handleLocationChange(locationId: string) {
    await syncFromDB();
    setLocationRenderKey(locationId);
  }

  function handleSectionChange(section: string) {
    setSectionRenderKey(section);
  }

  // Auth guard
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const user = getCurrentUser();
      if (!user) {
        router.replace("/sign-in");
        return;
      }
      // A platform admin is not a salon account — no salon features exist for
      // them. Any salon route (including the salon dashboard) bounces to the
      // admin panel, and only /dashboard/admin is reachable.
      if (user.role === "admin" && !pathname.startsWith("/dashboard/admin")) {
        router.replace("/dashboard/admin");
        return;
      }
      if (user.role === "staff") {
        if (user.locationId) setActiveLocationFilter(user.locationId);
        const key = pathname === "/dashboard"
          ? "dashboard"
          : pathname.replace("/dashboard/", "").split("/")[0];
        
        // Check owner-only routes
        const ownerOnlyRoutes = ["account", "billing", "admin", "migrate", "settings"];
        if (ownerOnlyRoutes.includes(key)) {
          router.replace("/dashboard");
          return;
        }
        
        const permissions = user.permissions || [];
        if (!permissions.includes("*") && !permissions.includes(key)) {
          router.replace("/dashboard");
          return;
        }
      }
      
      // Manager can access most pages, but not owner-only pages
      if (user.role === "manager") {
        // Pinned to their assigned branch client-side too, matching the
        // server-side pin in resolveActor() — otherwise the branch switcher
        // (or a stale local selection) could point local reads/writes at a
        // different branch than what the server actually scopes their data to.
        if (user.locationId) setActiveLocationFilter(user.locationId);
        const key = pathname === "/dashboard"
          ? "dashboard"
          : pathname.replace("/dashboard/", "").split("/")[0];
        const ownerOnlyRoutes = ["admin", "billing", "migrate"];
        if (ownerOnlyRoutes.includes(key)) {
          router.replace("/dashboard");
          return;
        }
      }

      // Staff and managers inherit the salon owner's subscription. Fetch the
      // authoritative plan before rendering so limits never fall back to Free
      // on a different browser/device with an empty local cache.
      const dataOwnerId = user.salonOwnerId || user.id;
      let resolvedPlanId: PlanId = getCurrentPlanId();
      try {
        const response = await fetch(`/api/billing/user?userId=${encodeURIComponent(dataOwnerId)}`);
        const data = await response.json() as { ok?: boolean; planId?: string };
        if (data.ok && data.planId) {
          setActivePlan(data.planId);
          resolvedPlanId = data.planId as PlanId;
        }
      } catch {
        // Keep the last cached plan when offline.
      }
      if (resolvedPlanId !== "premium") {
        const mainLocationId = getSalonLocations()[0]?.id ?? "main";
        if (getActiveLocationFilter() !== mainLocationId) setActiveLocationFilter(mainLocationId);
      }
      setIsReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [router, pathname]);

  // Session liveness check — getCurrentUser() above only reads a local cache
  // and can't tell the 7-day session cookie has died server-side, so a tab
  // left open past expiry would otherwise keep rendering normally while
  // every background save (expenses, invoices, etc.) silently 401s for as
  // long as nobody notices. Check right away, then periodically, so a dead
  // session surfaces as a re-login prompt instead of days of un-synced data.
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;

    async function verify() {
      const alive = await checkServerSession();
      if (cancelled || alive) return;
      await signOut();
      router.replace("/sign-in?expired=1");
    }

    verify();
    const interval = window.setInterval(verify, 30 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [isReady, router]);

  // Appearance
  useEffect(() => {
    applyAppearanceSettings();
    window.addEventListener(SETTINGS_CHANGED_EVENT, applyAppearanceSettings);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, applyAppearanceSettings);
  }, []);

  // Data sync + invoice notifications + suspension check
  // Settings reload happens AFTER syncFromDB so Turso data is in localStorage first
  useEffect(() => {
    if (!isReady) return;
    if (isAdmin) return;
    const user = getCurrentUser();
    if (!user) return;
    const dataOwnerId = user.salonOwnerId || user.id;

    // Start watching for the connection coming back before the first sync, so
    // a device that opens the dashboard already offline still flushes whatever
    // it queued in the last session the moment it reconnects.
    startOfflineFlush();

    syncFromDB().then(async () => {
      await syncLocalDataToDB();
      // Take services performed on any device off service-consumed stock.
      settleServiceConsumption();
      reloadSettings();
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
      runWhatsAppScheduler();

      // After DB sync, check for unpaid invoices from the authoritative billing DB
      const planId = getCurrentPlanId() as PlanId;
      const plan = PLAN_CONFIGS[planId];
      if (plan && plan.price > 0) {
        fetch(`/api/billing/invoices?userId=${encodeURIComponent(dataOwnerId)}`)
          .then((r) => r.json())
          .then((data: { ok: boolean; invoices?: Invoice[] }) => {
            if (!data.ok || !data.invoices) return;
            // Only surface the banner once the invoice is actually due (or overdue) —
            // not the moment it's issued, which can be weeks before the due date.
            const today = new Date().toISOString().slice(0, 10);
            const unpaid = data.invoices.filter((inv) => inv.status !== "paid" && inv.dueDate <= today);
            if (unpaid.length > 0) {
              const oldest = unpaid[unpaid.length - 1]; // oldest = last in desc-sorted list
              setUnpaidInvoice({ number: oldest.number, amount: oldest.total, status: oldest.status, dueDate: oldest.dueDate });
              setInvoiceBadgeDismissed(false);
            }
          })
          .catch(() => { /* fail open */ });
      }
    });
    checkInvoiceNotifications();

    // Check suspension status
    if (user.role !== "staff") fetch(`/api/billing/status?userId=${encodeURIComponent(dataOwnerId)}`)
      .then((r) => r.json())
      .then((data: { ok: boolean; suspended?: boolean; reason?: string | null }) => {
        if (data.ok && data.suspended) {
          setSuspended(true);
          setSuspReason(data.reason ?? null);
        }
      })
      .catch(() => { /* fail open */ });
  }, [isReady, isAdmin]);

  // WhatsApp scheduler — first run is triggered by syncFromDB.then() above
  // so existing clients are already in localStorage when it first fires.
  // Polls on a jittered ~45-90s cadence (self-rescheduling setTimeout) instead of a
  // fixed setInterval — an exact, unchanging tick period is itself a detectable bot
  // pattern, so the gap is randomized every time just like the message pacing is.
  useEffect(() => {
    if (!isReady || isAdmin) return;
    let timeoutId: number;
    const scheduleNext = () => {
      const jitterMs = 45_000 + Math.random() * 45_000; // 45-90s
      timeoutId = window.setTimeout(() => {
        runWhatsAppScheduler();
        scheduleNext();
      }, jitterMs);
    };
    scheduleNext();
    return () => window.clearTimeout(timeoutId);
  }, [isReady, isAdmin]);

  // WhatsApp connection status check
  useEffect(() => {
    if (!isReady || isAdmin) return;
    const config = settingsStore.wasender as { provider?: "wasender" | "botsailor" | "zaptick" | "chakra" | "ycloud"; apiKey: string; botSailorApiToken?: string; botSailorPhoneNumberId?: string; zaptickApiKey?: string; chakraAccessToken?: string; chakraPluginId?: string; chakraWhatsappPhoneNumberId?: string };
    // Keys are admin-managed and stay on the server; it checks with its own.
    if (!whatsAppConnected(config)) return;

    async function checkWa() {
      try {
        const res  = await fetch("/api/whatsapp/status");
        if (!res.ok) return; // server error — keep current status, don't flip to disconnected
        const data = await res.json() as { connected?: boolean };
        setWaStatus(data.connected ? "connected" : "disconnected");
        if (data.connected) setWaBannerDismissed(false); // reset so banner can reappear on next disconnect
      } catch {
        // Network error — don't change state; avoid false-positive "disconnected" banner
      }
    }

    checkWa();
    // 30 min interval — WaSender free plan allows only 1 req/min total.
    // The server also caches for 15 min, so two browser polls in quick succession
    // will only hit WaSender once.
    const interval = window.setInterval(checkWa, 30 * 60_000);
    // Don't re-check on every focus — that burns rate limit needlessly.
    return () => { window.clearInterval(interval); };
  }, [isReady, isAdmin]);

  // Persistent low-stock badge
  useEffect(() => {
    if (!isReady || isAdmin) return;
    function checkStock() {
      const inv = getStoredInventory();
      setOutStockCount(inv.filter((i) => i.currentStock === 0).length);
      setLowStockCount(inv.filter((i) => i.currentStock > 0 && i.currentStock <= i.minStock).length);
    }
    checkStock();
    const interval = window.setInterval(checkStock, 60_000);
    window.addEventListener("focus", checkStock);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", checkStock); };
  }, [isReady, isAdmin]);


  // WhatsApp message toast notifications
  useEffect(() => {
    function onWaMessage(e: Event) {
      const entry = (e as CustomEvent<WaLogEntry>).detail;
      const toastId = Date.now();
      setToasts((prev) => [...prev.slice(-4), { ...entry, toastId }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
      }, 5000);
    }
    window.addEventListener("werzio_wa_message_logged", onWaMessage);
    return () => window.removeEventListener("werzio_wa_message_logged", onWaMessage);
  }, []);

  // New booking popup + chime
  useEffect(() => {
    if (!isReady || isAdmin) return;

    type BookingAlert = {
      bookingId?: string;
      clientName: string;
      serviceNames: string[];
      date: string;
      startTime: string;
      totalAmount: number;
      ts?: number;
    };

    function showBookingAlert(detail: BookingAlert) {
      const dedupeId = detail.bookingId
        || `${detail.clientName}|${detail.date}|${detail.startTime}|${detail.ts ?? ""}`;
      if (seenBookingAlertIds.current.has(dedupeId)) return;
      seenBookingAlertIds.current.add(dedupeId);
      playChime();
      const alertId = Date.now();
      // A new booking replaces an older visible popup. Each popup now represents
      // exactly the booking event that triggered it.
      setBookingAlerts([{ ...detail, alertId }]);
    }

    // BroadcastChannel — propagates to ALL open tabs in the same browser instantly
    const channel = new BroadcastChannel("werzio_booking_alerts");
    channel.onmessage = (e: MessageEvent) => {
      try { showBookingAlert(e.data); } catch { /* ignore */ }
    };

    function broadcast(detail: BookingAlert) {
      showBookingAlert(detail);
      channel.postMessage(detail); // notify every other open tab
    }

    // Same-tab: custom event (when booking page and dashboard share a window)
    function onNewBooking(e: Event) {
      broadcast((e as CustomEvent).detail);
    }

    // Cross-tab fallback: localStorage storage event (same browser, different tab)
    function onStorage(e: StorageEvent) {
      if (e.key !== "werzio_new_booking_notify" || !e.newValue) return;
      // Every dashboard tab receives this event independently. Do not rebroadcast
      // it or each tab will multiply the same popup through BroadcastChannel.
      try { showBookingAlert(JSON.parse(e.newValue)); } catch { /* ignore */ }
    }

    window.addEventListener("werzio_new_booking_alert", onNewBooking);
    window.addEventListener("storage", onStorage);

    // Poll for new online bookings every 5 s — catches bookings from external devices
    const user = getCurrentUser();
    let lastSeenId: string | null = null;
    // When the appointments last changed on the server — the poll sends it back so an
    // unchanged list costs one tiny read instead of re-sending every appointment.
    let lastUpdatedAt = "";

    async function pollNewBookings() {
      if (!user) return;
      try {
        const salonId = encodeURIComponent(user.salonOwnerId || user.id);
        const res = await fetch(`/api/public/salon?salonId=${salonId}&only=appointments&since=${encodeURIComponent(lastUpdatedAt)}`);
        if (!res.ok) return;
        const data = await res.json() as { ok: boolean; unchanged?: boolean; updatedAt?: string; appointments?: Array<{ id: string; clientName: string; serviceNames: string[]; date: string; startTime: string; totalAmount: number; source?: string }> };
        if (!data.ok || data.unchanged) return;
        lastUpdatedAt = data.updatedAt ?? "";
        if (!Array.isArray(data.appointments) || data.appointments.length === 0) return;

        const latest = data.appointments[0]; // newest is first (prepended on save)
        if (lastSeenId === null) {
          // First poll — just record the baseline, don't fire popup
          lastSeenId = latest.id;
          return;
        }
        if (latest.id !== lastSeenId) {
          const lastSeenIndex = data.appointments.findIndex((a) => a.id === lastSeenId);
          
          // If the last seen ID is not in the list anymore (e.g. deleted), just update the baseline
          if (lastSeenIndex === -1) {
            lastSeenId = latest.id;
            return;
          }

          lastSeenId = latest.id;
          // This table also receives staff-created appointments (walk-in/manual/whatsapp) —
          // only pop the alert for bookings made through the online booking page or by an
          // external AI agent (Poke, via MCP) — staff should see those live too, since
          // nobody on-site chose to add them.
          if (latest.source === "web" || latest.source === "agent") {
            // Only surface the booking that just arrived. Older unseen records
            // must not be replayed as a stack of popups.
            showBookingAlert({
              bookingId:   latest.id,
              clientName:  latest.clientName,
              serviceNames: latest.serviceNames ?? [],
              date:        latest.date,
              startTime:   latest.startTime,
              totalAmount: latest.totalAmount ?? 0,
            });
            // Auto-sync the new data into localStorage so the notification panel (bell) updates immediately
            syncFromDB().then(() => {
              window.dispatchEvent(new Event("werzio_data_synced"));
            });
          }
        }
      } catch { /* network error — try again next tick */ }
    }

    pollNewBookings(); // run immediately to set baseline
    const pollInterval = window.setInterval(pollNewBookings, 5_000);

    return () => {
      window.removeEventListener("werzio_new_booking_alert", onNewBooking);
      window.removeEventListener("storage", onStorage);
      channel.close();
      window.clearInterval(pollInterval);
    };
  }, [isReady, isAdmin]);

  if (!isReady) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f7f7fb", color: "#7C3AED", fontSize: 13, fontWeight: 700 }}>
        Loading workspace...
      </div>
    );
  }

  // The platform admin console is full-screen with its own top bar: it manages
  // every salon rather than one, so none of the salon chrome applies to it.
  if (isAdmin && pathname.startsWith("/dashboard/admin")) {
    return <>{children}</>;
  }

  // Billing page is always accessible even when suspended
  const isBillingPage = pathname === "/dashboard/billing";
  // POS has its own internal Customer/Catalog/Cart tab bar on mobile — showing the
  // global bottom-nav on top of it stacks two toolbars and eats screen space from
  // an already tight checkout flow, so it's hidden here specifically.
  const isPosPage = pathname === "/dashboard/pos";
  // The Salon Floor is a full-width live map: a top header replaces the left
  // sidebar there, and the sidebar only opens as a drawer from its ☰ button.
  const isFloorPage = pathname === "/dashboard/floor";

  const bottomTabs = [
    { href: "/dashboard",             icon: LayoutDashboard, label: "Dashboard"    },
    { href: "/dashboard/appointments", icon: ClipboardList,   label: "Appointments" },
    { href: "/dashboard/billing",      icon: CreditCard,      label: "Billing"      },
    { href: "/dashboard/account",      icon: User,            label: "Account"      },
  ];

  const leftTabs  = bottomTabs.slice(0, 2);
  const rightTabs = bottomTabs.slice(2);

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Slide-out Backdrop Overlay */}
      <div
        className={`mobile-overlay ${sidebarOpen ? "active" : ""}`}
        onClick={() => setSidebarOpen(false)}
        style={isFloorPage && sidebarOpen ? { display: "block" } : undefined}
      />

      {(!isFloorPage || sidebarOpen) && <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />}
      <main className={isPosPage ? "pos-page-main" : ""} style={isFloorPage ? {
        marginLeft: 0,
        flex: 1,
        minWidth: 0,
        minHeight: "100vh",
        background: "#eef0f6",
        overflow: "auto",
      } : {
        marginLeft: "var(--sidebar-width)",
        flex: 1,
        minHeight: "100vh",
        background: "#ffffff",
        overflow: "auto",
        borderRadius: "20px 0 0 20px",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.08)",
      }}>
        {isFloorPage && (
          <FloorTopBar
            onMenu={() => setSidebarOpen(true)}
            sectionSwitcher={!isAdmin && <DashboardSectionSwitcher compact onSectionChange={handleSectionChange} />}
          />
        )}
        {/* WhatsApp disconnection banner */}
        {waStatus === "disconnected" && !waBannerDismissed && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "11px 20px",
            background: "linear-gradient(90deg,#78350f,#92400e)",
            borderRadius: "20px 0 0 0",
          }}>
            <WifiOff size={16} color="#fcd34d" style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, fontSize: 13, color: "#fef3c7", fontWeight: 600 }}>
              WhatsApp disconnected — your phone may have lost internet. Automated messages are paused until reconnected.
            </div>
            <a
              href="/dashboard/settings"
              style={{ fontSize: 12, fontWeight: 700, color: "#fcd34d", textDecoration: "none",
                       background: "rgba(255,255,255,0.12)", padding: "5px 12px", borderRadius: 8, whiteSpace: "nowrap" }}
            >
              Open Settings
            </a>
            <button
              type="button"
              onClick={() => setWaBannerDismissed(true)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#fcd34d", padding: 4, flexShrink: 0 }}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {/* Branch switching is an owner/admin-only capability — a manager is
            always pinned to their one assigned branch (server-enforced in
            resolveActor()), so showing them a switcher that can't actually
            move their data anywhere would just be a dead, confusing control.
            Admins have no salon at all, so neither switcher is shown to them. */}
        {!isFloorPage && getCurrentUser()?.role === "owner" && getCurrentPlanId() === "premium" && (
          <DashboardLocationSwitcher onLocationChange={handleLocationChange} />
        )}
        {!isAdmin && !isFloorPage && <DashboardSectionSwitcher onSectionChange={handleSectionChange} />}
        <div key={`${locationRenderKey}::${sectionRenderKey}`}>{children}</div>
      </main>

      {/* Mobile Bottom Navigation Bar */}
      {!isPosPage && !isAdmin && (
      <nav className="bottom-nav">
        {/* Left tabs */}
        {leftTabs.map((tab) => {
          const isActive = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`bottom-nav-item ${isActive ? "active" : ""}`}
            >
              <tab.icon size={20} />
              <span>{tab.label}</span>
              {isActive && <div className="bottom-nav-active-dot" />}
            </Link>
          );
        })}

        {/* Center logo badge — opens sidebar */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="bottom-nav-logo-badge"
          aria-label="Open menu"
        >
          <img src="/salon-central-logo.png" alt="Salon Central" />
        </button>

        {/* Right tabs */}
        {rightTabs.map((tab) => {
          const isActive = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`bottom-nav-item ${isActive ? "active" : ""}`}
            >
              <tab.icon size={20} />
              <span>{tab.label}</span>
              {isActive && <div className="bottom-nav-active-dot" />}
            </Link>
          );
        })}
      </nav>
      )}

      {/* Suspension gate — shown over everything except the billing page */}
      {suspended && !isBillingPage && <SuspensionGate reason={suspReason} />}

      {/* Offline / unsynced indicator — renders nothing when there's nothing to say */}
      <OfflineStatus />

      {/* Bottom-right persistent alert badges (stacked) */}
      <div style={{ position: "fixed", bottom: 90, right: 16, zIndex: 90, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>

        {/* Salon Central subscription invoice reminder */}
        {unpaidInvoice && !invoiceBadgeDismissed && (
          <div style={{
            background: "#fff",
            borderRadius: 16,
            boxShadow: "0 8px 32px rgba(0,0,0,0.14), 0 0 0 1px rgba(217,119,6,0.15)",
            overflow: "hidden",
            width: 248,
            animation: "stockPulse 3s ease-in-out infinite",
          }}>
            {/* Coloured top bar */}
            <div style={{
              background: unpaidInvoice.status === "overdue"
                ? "linear-gradient(135deg,#dc2626,#ef4444)"
                : "linear-gradient(135deg,#d97706,#f59e0b)",
              padding: "10px 12px",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ position: "relative", width: 8, height: 8 }}>
                  <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "#fff", opacity: 0.6, animation: "stockPulse 1.5s ease-in-out infinite" }} />
                  <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "#fff" }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", letterSpacing: "0.04em" }}>
                  {unpaidInvoice.status === "overdue" ? "Invoice Overdue" : "Invoice Due"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setInvoiceBadgeDismissed(true)}
                style={{ background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 6, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
              >
                <X size={12} color="#fff" />
              </button>
            </div>

            {/* Invoice detail */}
            <div style={{ padding: "12px 14px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", marginBottom: 2 }}>
                Salon Central Subscription
              </div>
              <div style={{ fontSize: 11, color: "#9898b0", marginBottom: 10 }}>
                {unpaidInvoice.number} · Due {unpaidInvoice.dueDate}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: unpaidInvoice.status === "overdue" ? "#dc2626" : "#d97706" }}>
                  PKR {unpaidInvoice.amount.toLocaleString()}
                </span>
                <Link
                  href="/dashboard/billing"
                  style={{
                    fontSize: 11, fontWeight: 700,
                    color: "#fff",
                    background: unpaidInvoice.status === "overdue" ? "#dc2626" : "#d97706",
                    padding: "5px 12px", borderRadius: 8,
                    textDecoration: "none",
                  }}
                >
                  Pay Now →
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* Low-stock / out-of-stock badge */}
        {(outStockCount > 0 || lowStockCount > 0) && (
          <Link
            href="/dashboard/inventory"
            className="stock-pill"
            aria-label={`${outStockCount + lowStockCount} stock items need restocking`}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              borderRadius: 24,
              background: outStockCount > 0 ? "linear-gradient(135deg,#dc2626,#ef4444)" : "linear-gradient(135deg,#d97706,#f59e0b)",
              boxShadow: outStockCount > 0
                ? "0 4px 20px rgba(220,38,38,0.4), 0 0 0 3px rgba(220,38,38,0.15)"
                : "0 4px 20px rgba(217,119,6,0.4),  0 0 0 3px rgba(217,119,6,0.15)",
              textDecoration: "none",
              animation: "stockPulse 2.5s ease-in-out infinite",
            }}
          >
            <AlertTriangle size={14} color="#fff" style={{ flexShrink: 0 }} />
            {/* Phones show just the icon and this count, so it doesn't cover the page. */}
            <span className="stock-pill-count">{outStockCount + lowStockCount}</span>
            <div className="stock-pill-text" style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", whiteSpace: "nowrap" }}>
                {outStockCount > 0 && `${outStockCount} Out of Stock`}
                {outStockCount > 0 && lowStockCount > 0 && "  ·  "}
                {lowStockCount > 0 && `${lowStockCount} Low Stock`}
              </span>
              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.8)", fontWeight: 600 }}>Tap to restock</span>
            </div>
          </Link>
        )}

      </div>

      {/* New Booking Popup Alerts */}
      {bookingAlerts.length > 0 && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 10000, display: "flex", flexDirection: "column", gap: 12, maxWidth: 340 }}>
          {bookingAlerts.map((alert) => (
            <div key={alert.alertId} style={{
              background: "#fff",
              borderRadius: 16,
              boxShadow: "0 8px 40px rgba(0,0,0,0.18), 0 0 0 2px #7C3AED22",
              overflow: "hidden",
              animation: "slideInRight 0.3s cubic-bezier(0.34,1.56,0.64,1)",
            }}>
              {/* Header */}
              <div style={{ background: "linear-gradient(135deg,#5B21B6,#7C3AED)", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <CalendarCheck size={18} color="#fff" />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.75)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Online Booking</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>New Booking!</div>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Dismiss booking notification for ${alert.clientName}`}
                  onClick={() => setBookingAlerts((prev) => prev.filter((a) => a.alertId !== alert.alertId))}
                  style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
                >
                  <X size={14} color="#fff" />
                </button>
              </div>

              {/* Body */}
              <div style={{ padding: "14px 16px" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 8 }}>{alert.clientName}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {alert.serviceNames.length > 0 && (
                    <div style={{ fontSize: 12, color: "#555" }}>
                      <span style={{ fontWeight: 600, color: "#333" }}>Service: </span>{alert.serviceNames.join(", ")}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: "#555" }}>
                    <span style={{ fontWeight: 600, color: "#333" }}>Date: </span>
                    {new Date(alert.date + "T00:00:00").toLocaleDateString("en-PK", { weekday: "short", month: "short", day: "numeric" })}
                    {" · "}
                    {(() => {
                      const [h, m] = alert.startTime.split(":").map(Number);
                      const suffix = h >= 12 ? "PM" : "AM";
                      return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${suffix}`;
                    })()}
                  </div>
                  {alert.totalAmount > 0 && (
                    <div style={{ fontSize: 12, color: "#555" }}>
                      <span style={{ fontWeight: 600, color: "#333" }}>Amount: </span>PKR {alert.totalAmount.toLocaleString("en-PK")}
                    </div>
                  )}
                </div>
              </div>

            </div>
          ))}
        </div>
      )}

      {/* WhatsApp message toast notifications */}
      {toasts.length > 0 && (
        <div style={{ position: "fixed", bottom: 80, right: 20, zIndex: 9999, display: "flex", flexDirection: "column", gap: 10, maxWidth: 320 }}>
          {toasts.map((t) => (
            <div key={t.toastId} style={{
              background: "#fff",
              borderRadius: 14,
              boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
              border: `1.5px solid ${t.status === "sent" ? "#bbf7d0" : "#fecaca"}`,
              padding: "12px 14px",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              animation: "slideInRight 0.25s ease",
            }}>
              {t.status === "sent"
                ? <CheckCircle size={18} color="#059669" style={{ flexShrink: 0, marginTop: 1 }} />
                : <XCircle    size={18} color="#dc2626" style={{ flexShrink: 0, marginTop: 1 }} />
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: t.status === "sent" ? "#059669" : "#dc2626" }}>
                  {t.status === "sent" ? "WhatsApp Sent" : "WhatsApp Failed"}
                </div>
                <div style={{ fontSize: 12, color: "#4a4a6a", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.clientName} · {t.type.replace("_", " ")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((x) => x.toastId !== t.toastId))}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "#9ca3af", flexShrink: 0 }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
