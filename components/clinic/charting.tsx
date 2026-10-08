"use client";

/**
 * Treatment charting for the patient's clinical record: treatment-specific
 * fields (CHART_TYPES in lib/clinic.ts), products used with their batch, and
 * for injectables a clickable face map whose points become part of the record.
 */

import { useMemo, useRef, useState } from "react";
import { Check, Plus, Syringe, Trash2, X } from "lucide-react";
import {
  CHART_TYPES, FACE_REGIONS, batchUsage, faceRegionAt, getTreatmentCharts, newId, removeRecord, saveTreatmentCharts, todayKey, upsertRecord,
  type ChartProduct, type ChartType, type FacePoint, type TreatmentChart,
} from "@/lib/clinic";
import { compatibleUnits } from "@/lib/inventory-usage";
import type { Client, InventoryItem, InventoryUnit, Service, Staff } from "@/lib/types";

const ACCENT = "#7C3AED";
const INP: React.CSSProperties = { width: "100%", padding: "9px 11px", borderRadius: 9, border: "1px solid #e4e4ee", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff", boxSizing: "border-box" };
const BTN: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: "none", background: ACCENT, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer" };
const BTN_GHOST: React.CSSProperties = { ...BTN, background: "#fff", color: "#6b6b8a", border: "1px solid #e4e4ee" };
const LBL: React.CSSProperties = { display: "block", fontSize: 10.5, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 };
const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" });
const round = (n: number) => Math.round(n * 100) / 100;

export interface ChartData { charts: TreatmentChart[]; inventory: InventoryItem[]; services: Service[]; staff: Staff[] }

export default function ChartsTab({ client, data, onChange }: { client: Client; data: ChartData; onChange: () => void }) {
  const [editing, setEditing] = useState<TreatmentChart | null>(null);
  const mine = data.charts.filter((c) => c.clientId === client.id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const typeOf = (t: ChartType) => CHART_TYPES.find((x) => x.id === t)!;
  const nameOf = (id?: string) => data.services.find((s) => s.id === id)?.name;
  const blank = (): TreatmentChart => ({ id: newId("chart"), clientId: client.id, date: todayKey(), type: "botox", products: [], fields: {}, facePoints: [], createdAt: new Date().toISOString() });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button type="button" onClick={() => setEditing(blank())} style={BTN}><Plus size={14} /> New treatment record</button>
      </div>
      {mine.length === 0 ? (
        <div style={{ padding: "28px 12px", textAlign: "center", fontSize: 12.5, color: "#9898b0" }}>No treatment records yet. Record the product, batch, dose and settings each time a treatment is done.</div>
      ) : mine.map((c) => {
        const t = typeOf(c.type);
        const total = (c.facePoints ?? []).reduce((s, p) => s + p.amount, 0);
        return (
          <button key={c.id} type="button" onClick={() => setEditing(c)}
            style={{ display: "block", width: "100%", textAlign: "left", border: "1px solid #ececf4", borderRadius: 12, padding: "12px 14px", marginBottom: 10, background: "#fff", cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Syringe size={15} color={ACCENT} />
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 800, color: "#1a1a2e" }}>{fmtDate(c.date)} · {nameOf(c.serviceId) ?? t.label}</span>
              {c.practitionerName && <span style={{ fontSize: 11.5, color: "#8a8aa3" }}>{c.practitionerName}</span>}
            </div>
            <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 5, lineHeight: 1.55 }}>
              {c.products.map((p) => `${p.name} ${p.amount} ${p.unit}${p.batchNumber ? ` · batch ${p.batchNumber}` : ""}`).join(" | ") || "No products recorded"}
              {t.faceMap && total > 0 && <> · <strong>{round(total)} {t.faceMap}</strong> across {c.facePoints!.length} points</>}
            </div>
          </button>
        );
      })}
      {editing && (
        <ChartForm initial={editing} data={data} onClose={() => setEditing(null)}
          onDelete={mine.some((c) => c.id === editing.id) ? () => { removeRecord(getTreatmentCharts, saveTreatmentCharts, editing.id); setEditing(null); onChange(); } : undefined}
          onSave={(c) => { upsertRecord(getTreatmentCharts, saveTreatmentCharts, c); setEditing(null); onChange(); }} />
      )}
    </div>
  );
}

function ChartForm({ initial, data, onClose, onSave, onDelete }: {
  initial: TreatmentChart; data: ChartData; onClose: () => void; onSave: (c: TreatmentChart) => void; onDelete?: () => void;
}) {
  const [c, setC] = useState<TreatmentChart>(initial);
  const type = CHART_TYPES.find((t) => t.id === c.type)!;
  const used = useMemo(() => batchUsage(data.charts.filter((x) => x.id !== c.id), data.inventory), [data.charts, data.inventory, c.id]);
  const items = data.inventory.filter((i) => i.isActive !== false);
  const total = round((c.facePoints ?? []).reduce((s, p) => s + p.amount, 0));
  const setProduct = (i: number, patch: Partial<ChartProduct>) => setC((x) => ({ ...x, products: x.products.map((p, idx) => idx === i ? { ...p, ...patch } : p) }));

  function pickItem(i: number, itemId: string) {
    const item = data.inventory.find((x) => x.id === itemId);
    setProduct(i, { itemId: item?.id, name: item ? `${item.brand ? `${item.brand} ` : ""}${item.name}` : "", unit: item?.unit ?? "ml", batchId: undefined, batchNumber: undefined, expiry: undefined });
  }

  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 900, maxHeight: "94vh", overflowY: "auto", padding: "18px 20px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 900, color: "#1a1a2e" }}>Treatment record</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "rgba(0,0,0,0.06)", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}><X size={14} /></button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
          <label><span style={LBL}>Type</span>
            <select value={c.type} onChange={(e) => setC({ ...c, type: e.target.value as ChartType, fields: {} })} style={INP}>
              {CHART_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select></label>
          <label><span style={LBL}>Treatment</span>
            <select value={c.serviceId ?? ""} onChange={(e) => setC({ ...c, serviceId: e.target.value || undefined })} style={INP}>
              <option value="">—</option>
              {data.services.filter((s) => s.isActive !== false && !s.sessionPackage && !s.membership).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <label><span style={LBL}>Date</span><input type="date" value={c.date} onChange={(e) => setC({ ...c, date: e.target.value })} style={INP} /></label>
          <label><span style={LBL}>Practitioner</span>
            <select value={c.practitionerId ?? ""} onChange={(e) => { const s = data.staff.find((x) => x.id === e.target.value); setC({ ...c, practitionerId: s?.id, practitionerName: s?.name }); }} style={INP}>
              <option value="">—</option>
              {data.staff.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
        </div>

        {/* Products & batches */}
        <div style={{ fontSize: 13, fontWeight: 900, color: "#1a1a2e", margin: "18px 0 8px" }}>Products used</div>
        {c.products.map((p, i) => {
          const item = data.inventory.find((x) => x.id === p.itemId);
          const today = todayKey();
          const batches = (item?.batches ?? []).map((b) => ({ ...b, left: round(b.qty - (used.get(b.id) ?? 0)), expired: !!b.expiry && b.expiry < today }));
          const units = item ? compatibleUnits(item.unit) : [p.unit];
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1.6fr 0.8fr 0.8fr 34px", gap: 6, marginBottom: 6 }}>
              <select value={p.itemId ?? ""} onChange={(e) => pickItem(i, e.target.value)} style={INP} aria-label="Product">
                <option value="">{p.itemId ? "" : p.name || "Choose product…"}</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.brand ? `${it.brand} ` : ""}{it.name}</option>)}
              </select>
              <select value={p.batchId ?? ""} aria-label="Batch" style={INP} disabled={!batches.length}
                onChange={(e) => { const b = batches.find((x) => x.id === e.target.value); setProduct(i, { batchId: b?.id, batchNumber: b?.number, expiry: b?.expiry }); }}>
                <option value="">{batches.length ? "Batch / lot…" : "No batches recorded"}</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id} disabled={b.expired && b.id !== p.batchId}>
                    {b.number}{b.expiry ? ` · exp ${b.expiry}` : ""} · {b.left} left{b.expired ? " · EXPIRED" : ""}
                  </option>
                ))}
              </select>
              <input type="number" min={0} step="any" value={p.amount || ""} onChange={(e) => setProduct(i, { amount: Number(e.target.value) || 0 })} placeholder="Amount" style={INP} aria-label="Amount" />
              <select value={p.unit} onChange={(e) => setProduct(i, { unit: e.target.value as InventoryUnit })} style={INP} aria-label="Unit">
                {units.map((u) => <option key={u}>{u}</option>)}
              </select>
              <button type="button" aria-label="Remove product" onClick={() => setC({ ...c, products: c.products.filter((_, idx) => idx !== i) })}
                style={{ border: "none", background: "#fef2f2", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><X size={13} color="#dc2626" /></button>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setC({ ...c, products: [...c.products, { name: "", amount: 0, unit: type.faceMap === "ml" ? "ml" : type.faceMap === "units" ? "units" : "ml" }] })} style={BTN_GHOST}><Plus size={13} /> Add product</button>
          {type.faceMap && total > 0 && c.products.length > 0 && c.products[0].amount !== total && (
            <button type="button" onClick={() => setProduct(0, { amount: total, unit: type.faceMap === "units" ? "units" : "ml" })} style={BTN_GHOST}>Use face-map total ({total} {type.faceMap})</button>
          )}
        </div>

        {/* Treatment-specific fields */}
        <div style={{ fontSize: 13, fontWeight: 900, color: "#1a1a2e", margin: "18px 0 8px" }}>{type.label} details</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
          {type.fields.map((f) => (
            <label key={f.key}><span style={LBL}>{f.label}</span>
              <input value={c.fields[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setC({ ...c, fields: { ...c.fields, [f.key]: e.target.value } })} style={INP} /></label>
          ))}
        </div>

        {type.faceMap && (
          <>
            <div style={{ fontSize: 13, fontWeight: 900, color: "#1a1a2e", margin: "18px 0 8px" }}>Face map <span style={{ fontWeight: 600, color: "#9898b0", fontSize: 12 }}>— tap where each injection went</span></div>
            <FaceMap unit={type.faceMap} points={c.facePoints ?? []} onChange={(facePoints) => setC({ ...c, facePoints })} />
          </>
        )}

        <label style={{ display: "block", marginTop: 16 }}><span style={LBL}>Practitioner notes</span>
          <textarea rows={3} value={c.notes ?? ""} onChange={(e) => setC({ ...c, notes: e.target.value })} style={{ ...INP, resize: "vertical" }} /></label>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={() => onSave({ ...c, products: c.products.filter((p) => p.name.trim() && p.amount > 0) })} style={BTN}><Check size={14} /> Save record</button>
          <button type="button" onClick={onClose} style={BTN_GHOST}>Cancel</button>
          {onDelete && <button type="button" onClick={() => { if (window.confirm("Delete this treatment record?")) onDelete(); }} style={{ ...BTN_GHOST, marginLeft: "auto", color: "#dc2626", borderColor: "#fecaca" }}><Trash2 size={13} /> Delete</button>}
        </div>
      </div>
    </div>
  );
}

/** Front-of-face diagram; a tap adds a point labelled with its region, then each dose is editable. */
export function FaceMap({ unit, points, onChange }: { unit: "units" | "ml"; points: FacePoint[]; onChange: (p: FacePoint[]) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const step = unit === "units" ? 2 : 0.1;
  const lastAmount = points[points.length - 1]?.amount ?? (unit === "units" ? 4 : 0.5);
  const total = round(points.reduce((s, p) => s + p.amount, 0));
  const byRegion = new Map<string, number>();
  for (const p of points) byRegion.set(p.region, round((byRegion.get(p.region) ?? 0) + p.amount));

  function add(e: React.MouseEvent<SVGSVGElement>) {
    const r = svgRef.current!.getBoundingClientRect();
    const x = round(((e.clientX - r.left) / r.width) * 200);
    const y = round(((e.clientY - r.top) / r.height) * 260);
    onChange([...points, { x, y, region: faceRegionAt(x, y), amount: lastAmount }]);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 280px) 1fr", gap: 16, alignItems: "start" }} className="face-map">
      <svg ref={svgRef} viewBox="0 0 200 260" onClick={add} role="img" aria-label="Face map — click to add an injection point"
        style={{ width: "100%", background: "#fffaf6", borderRadius: 14, border: "1px solid #f0e6dd", cursor: "crosshair", touchAction: "manipulation" }}>
        <ellipse cx="100" cy="132" rx="78" ry="108" fill="#fdf1e7" stroke="#d9c3b0" strokeWidth="1.5" />
        <ellipse cx="22" cy="125" rx="7" ry="18" fill="#fdf1e7" stroke="#d9c3b0" />
        <ellipse cx="178" cy="125" rx="7" ry="18" fill="#fdf1e7" stroke="#d9c3b0" />
        <path d="M28 88 Q40 22 100 20 Q160 22 172 88" fill="none" stroke="#c9b2a0" strokeWidth="1" strokeDasharray="3 3" />
        <path d="M55 96 Q72 86 89 94" fill="none" stroke="#8b6f5c" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M111 94 Q128 86 145 96" fill="none" stroke="#8b6f5c" strokeWidth="2.5" strokeLinecap="round" />
        <ellipse cx="72" cy="109" rx="12" ry="5" fill="#fff" stroke="#8b6f5c" /><circle cx="72" cy="109" r="3" fill="#5b4636" />
        <ellipse cx="128" cy="109" rx="12" ry="5" fill="#fff" stroke="#8b6f5c" /><circle cx="128" cy="109" r="3" fill="#5b4636" />
        <path d="M100 108 L93 146 Q100 152 107 146" fill="none" stroke="#b9987f" strokeWidth="1.5" />
        <path d="M80 178 Q90 170 100 174 Q110 170 120 178 Q100 182 80 178 Z" fill="#e9a4a0" stroke="#c97f7a" />
        <path d="M80 178 Q100 196 120 178" fill="#e39893" stroke="#c97f7a" />
        {FACE_REGIONS.map((r) => <circle key={r.name} cx={r.x} cy={r.y} r="1.2" fill="#d9c3b0" />)}
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="5" fill={ACCENT} fillOpacity="0.85" stroke="#fff" strokeWidth="1.2" />
            <text x={p.x + 6.5} y={p.y + 3} fontSize="7.5" fontWeight="700" fill="#4c1d95">{p.amount}</text>
          </g>
        ))}
      </svg>
      <div>
        <div style={{ fontSize: 13, fontWeight: 900, color: ACCENT, marginBottom: 8 }}>Total: {total} {unit}</div>
        {points.length === 0 ? <div style={{ fontSize: 12, color: "#9898b0" }}>Tap the face to add injection points.</div> : points.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
            <span style={{ flex: 1, fontSize: 12.5, color: "#1a1a2e" }}>{i + 1}. {p.region}</span>
            <input type="number" min={0} step={step} value={p.amount} aria-label={`Dose at ${p.region}`}
              onChange={(e) => onChange(points.map((x, idx) => idx === i ? { ...x, amount: Number(e.target.value) || 0 } : x))}
              style={{ ...INP, width: 72, padding: "5px 7px" }} />
            <span style={{ fontSize: 11, color: "#9898b0", width: 30 }}>{unit}</span>
            <button type="button" aria-label="Remove point" onClick={() => onChange(points.filter((_, idx) => idx !== i))}
              style={{ border: "none", background: "#fef2f2", borderRadius: 6, padding: 5, cursor: "pointer", display: "flex" }}><X size={11} color="#dc2626" /></button>
          </div>
        ))}
        {byRegion.size > 1 && (
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 9, background: "#faf9ff", fontSize: 11.5, color: "#5b21b6", lineHeight: 1.6 }}>
            {[...byRegion.entries()].map(([r, a]) => `${r} → ${a} ${unit}`).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}
