"use client";

/**
 * Waiting list: people who want a slot that isn't free yet. When one opens
 * (a cancellation, a no-show), message them from here — automatically on
 * Pro / Premium with WhatsApp connected, otherwise WhatsApp opens ready to send.
 */

import { useEffect, useState } from "react";
import { Check, Hourglass, Plus, Send, Trash2, X } from "lucide-react";
import PageTitle from "@/components/page-title";
import { getStoredClients, subscribeToStoredData } from "@/lib/storage";
import { settingsStore } from "@/lib/settings-store";
import { getCurrentPlan } from "@/lib/plan-limits";
import { normalizePhone, whatsAppConnected } from "@/lib/whatsapp-scheduler";
import { getWaitlist, newId, removeRecord, saveWaitlist, todayKey, upsertRecord, type WaitlistEntry } from "@/lib/clinic";
import type { Client } from "@/lib/types";

const INP: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" };
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-PK", { weekday: "short", day: "numeric", month: "short" });

export default function WaitlistPage() {
  const [list, setList] = useState<WaitlistEntry[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [adding, setAdding] = useState<WaitlistEntry | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [sent, setSent] = useState<Record<string, string>>({});

  // Read after mount: plan and WhatsApp setup live in this browser's storage.
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    const load = () => { setList(getWaitlist()); setClients(getStoredClients()); };
    load();
    setAuto(getCurrentPlan().whatsapp && whatsAppConnected(settingsStore.wasender as Parameters<typeof whatsAppConnected>[0]));
    return subscribeToStoredData(load);
  }, []);

  const salonName = (settingsStore.salon as { name?: string }).name || "us";
  const message = (e: WaitlistEntry) =>
    `Hi ${e.name.split(" ")[0]}, a slot has opened up at ${salonName}${e.preferredDate ? ` on ${fmtDate(e.preferredDate)}` : ""} for ${e.wants}. Reply to book it — first come, first served!`;
  const save = (e: WaitlistEntry) => setList(upsertRecord(getWaitlist, saveWaitlist, e));

  async function notify(e: WaitlistEntry) {
    setSent((s) => ({ ...s, [e.id]: "sending" }));
    try {
      const res = await fetch("/api/clinic/whatsapp-send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "text", phone: e.phone, text: message(e) }) });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!d.ok) throw new Error(d.error || "Send failed");
      setSent((s) => ({ ...s, [e.id]: "sent" }));
    } catch (err) {
      setSent((s) => ({ ...s, [e.id]: err instanceof Error ? err.message : "Send failed" }));
    }
  }

  const today = todayKey();
  const shown = list.filter((e) => showDone || e.status === "waiting")
    .sort((a, b) => (a.status === "waiting" ? 0 : 1) - (b.status === "waiting" ? 0 : 1) || (a.preferredDate ?? "9999").localeCompare(b.preferredDate ?? "9999") || a.createdAt.localeCompare(b.createdAt));
  const waiting = list.filter((e) => e.status === "waiting");

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#fff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 18 }}>
      <PageTitle icon={<Hourglass size={24} />} title="Waiting List"
        subtitle={`${waiting.length} waiting · ${waiting.filter((e) => e.preferredDate === today).length} want today`}
        right={
          <button type="button" onClick={() => setAdding({ id: newId("wait"), name: "", phone: "", wants: "", status: "waiting", createdAt: new Date().toISOString() })}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, border: "none", background: "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
            <Plus size={14} /> Add to waiting list
          </button>
        } />

      {shown.length === 0 ? <div style={{ fontSize: 13, color: "#9898b0", padding: 20, textAlign: "center" }}>Nobody is waiting. When a client wants a fully-booked slot, add them here and message them the moment something opens.</div>
        : shown.map((e) => (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid #ececf4", borderRadius: 12, opacity: e.status === "waiting" ? 1 : 0.55, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e" }}>{e.name} <span style={{ fontWeight: 600, color: "#9898b0", fontSize: 12 }}>{e.phone}</span></div>
              <div style={{ fontSize: 12.5, color: "#6b6b8a" }}>
                {e.wants}{e.preferredDate ? ` · ${fmtDate(e.preferredDate)}` : " · any day"}{e.preferredTime ? ` · ${e.preferredTime}` : ""}
                {e.status !== "waiting" ? ` · ${e.status}` : ""}
              </div>
              {e.notes && <div style={{ fontSize: 11.5, color: "#9898b0", marginTop: 2 }}>{e.notes}</div>}
            </div>
            {e.status === "waiting" && e.phone && (auto ? (
              <button type="button" onClick={() => notify(e)} disabled={sent[e.id] === "sending" || sent[e.id] === "sent"}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 11px", borderRadius: 8, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#15803d", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                <Send size={13} /> {sent[e.id] === "sent" ? "Sent ✓" : sent[e.id] === "sending" ? "Sending…" : "Slot opened — notify"}
              </button>
            ) : (
              <a href={`https://wa.me/${normalizePhone(e.phone)}?text=${encodeURIComponent(message(e))}`} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 11px", borderRadius: 8, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#15803d", fontSize: 12, fontWeight: 800, textDecoration: "none" }}>
                <Send size={13} /> Slot opened — notify
              </a>
            ))}
            {sent[e.id] && !["sending", "sent"].includes(sent[e.id]) && <span style={{ fontSize: 11.5, color: "#dc2626" }}>{sent[e.id]}</span>}
            {e.status === "waiting" && (
              <button type="button" onClick={() => save({ ...e, status: "booked" })}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 11px", borderRadius: 8, border: "1px solid #e4e4ee", background: "#fff", color: "#6b6b8a", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                <Check size={13} /> Booked
              </button>
            )}
            <button type="button" aria-label="Remove" onClick={() => setList(removeRecord(getWaitlist, saveWaitlist, e.id))}
              style={{ border: "1px solid #fecaca", background: "#fff", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}><Trash2 size={13} color="#dc2626" /></button>
          </div>
        ))}
      <label style={{ fontSize: 12, color: "#6b6b8a", display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={showDone} onChange={(ev) => setShowDone(ev.target.checked)} /> Show booked / removed
      </label>

      {adding && (
        <div onClick={() => setAdding(null)} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(ev) => ev.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 480, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
              <div style={{ flex: 1, fontSize: 16, fontWeight: 900, color: "#1a1a2e" }}>Add to waiting list</div>
              <button type="button" onClick={() => setAdding(null)} aria-label="Close" style={{ border: "none", background: "rgba(0,0,0,0.06)", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}><X size={14} /></button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label style={{ gridColumn: "1 / -1" }}><Small>Existing client (optional)</Small>
                <select value={adding.clientId ?? ""} style={INP}
                  onChange={(ev) => { const c = clients.find((x) => x.id === ev.target.value); setAdding({ ...adding, clientId: c?.id, name: c?.name ?? adding.name, phone: c?.phone ?? adding.phone }); }}>
                  <option value="">—</option>
                  {[...clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}
                </select></label>
              <label><Small>Name</Small><input value={adding.name} onChange={(ev) => setAdding({ ...adding, name: ev.target.value })} style={INP} /></label>
              <label><Small>Phone</Small><input value={adding.phone} inputMode="tel" onChange={(ev) => setAdding({ ...adding, phone: ev.target.value })} style={INP} /></label>
              <label style={{ gridColumn: "1 / -1" }}><Small>Wants</Small><input value={adding.wants} placeholder="e.g. Hydrafacial with Dr Sara" onChange={(ev) => setAdding({ ...adding, wants: ev.target.value })} style={INP} /></label>
              <label><Small>Preferred day</Small><input type="date" value={adding.preferredDate ?? ""} onChange={(ev) => setAdding({ ...adding, preferredDate: ev.target.value || undefined })} style={INP} /></label>
              <label><Small>Preferred time</Small><input value={adding.preferredTime ?? ""} placeholder="Morning / after 5pm" onChange={(ev) => setAdding({ ...adding, preferredTime: ev.target.value || undefined })} style={INP} /></label>
              <label style={{ gridColumn: "1 / -1" }}><Small>Notes</Small><input value={adding.notes ?? ""} onChange={(ev) => setAdding({ ...adding, notes: ev.target.value || undefined })} style={INP} /></label>
            </div>
            <button type="button" disabled={!adding.name.trim() || !adding.wants.trim()}
              onClick={() => { save({ ...adding, name: adding.name.trim(), wants: adding.wants.trim() }); setAdding(null); }}
              style={{ marginTop: 16, width: "100%", padding: "11px 0", borderRadius: 10, border: "none", background: adding.name.trim() && adding.wants.trim() ? "#7C3AED" : "#e8e8f0", color: adding.name.trim() && adding.wants.trim() ? "#fff" : "#9898b0", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Small({ children }: { children: React.ReactNode }) {
  return <span style={{ display: "block", fontSize: 10.5, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{children}</span>;
}
