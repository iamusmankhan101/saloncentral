"use client";

import { useState, useEffect } from "react";
import { getStoredServices, saveServices, getStoredStaff, getStoredInventory, subscribeToStoredData } from "@/lib/storage";
import type { InventoryItem, Service, Staff } from "@/lib/types";
import { X, Plus, Clock, Scissors, DollarSign, Users, Sparkles, Check, Pencil, Trash2, Package as PackageIcon, Search, Lock, Upload, Download, FileSpreadsheet, ChevronDown, Boxes } from "lucide-react";
import { getSectionOptions, getActiveSection, inSection, defaultSectionForNewRecord } from "@/lib/sections";
import PageTitle from "@/components/page-title";
import MobilePageHeader from "@/components/mobile-page-header";

const CATEGORY_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  hair:   { label: "Hair Care", bg: "#EDE9FE", color: "#7C3AED" },
  skin:   { label: "Skin Care", bg: "#e0f2fe", color: "#0369a1" },
  nails:  { label: "Nails",     bg: "#ecfdf5", color: "#059669" },
  bridal: { label: "Bridal",    bg: "#fdf2f8", color: "#db2777" },
  piercing: { label: "Ear Piercing", bg: "#fff7ed", color: "#c2410c" },
  package: { label: "Deals & Packages", bg: "#fef9c3", color: "#a16207" },
};

const PRESET_CATEGORIES = ["hair", "skin", "nails", "bridal", "piercing", "package"];
const catLabel = (cat: string) => CATEGORY_LABELS[cat]?.label ?? (cat.charAt(0).toUpperCase() + cat.slice(1));

import { fmtCurrency as fmt } from "@/lib/format";

const SERVICE_EXPORT_COLS = [
  "Service ID", "Name", "Description", "Category", "Sub-category", "Section", "Duration (Min)",
  "Variable Price", "Price", "Min Price", "Max Price", "Included Services", "Assigned Staff", "Active",
];

type ServiceImportRecord = { service: Service; assignedStaffNames: string[]; includedServiceNames: string[]; mode: "add" | "update" };
type ServiceImportResult = { added: number; updated: number; skipped: number; errors: string[] };

function splitList(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseActive(value: unknown): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["false", "no", "inactive", "0"].includes(raw);
}

function parseBool(value: unknown): boolean {
  return ["true", "yes", "1"].includes(String(value ?? "").trim().toLowerCase());
}

function servicesToRows(list: Service[], staffList: Staff[]) {
  return list.map((sv) => {
    const assignedStaff = staffList.filter((st) => sv.assignedStaffIds.includes(st.id)).map((st) => st.name);
    const includedServices = (sv.packageServiceIds ?? [])
      .map((id) => list.find((s) => s.id === id)?.name)
      .filter((n): n is string => Boolean(n));
    return {
      "Service ID": sv.id,
      "Name": sv.name,
      "Description": sv.description ?? "",
      "Category": sv.category,
      "Sub-category": sv.subcategory ?? "",
      "Section": sv.section ?? "",
      "Duration (Min)": sv.durationMin,
      "Variable Price": sv.variablePrice ? "Yes" : "No",
      "Price": sv.variablePrice ? "" : sv.price,
      "Min Price": sv.variablePrice ? (sv.priceRangeMin ?? "") : "",
      "Max Price": sv.variablePrice ? (sv.priceRangeMax ?? "") : "",
      "Included Services": includedServices.join(", "),
      "Assigned Staff": assignedStaff.join(", "),
      "Active": sv.isActive ? "Yes" : "No",
    };
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportServices(list: Service[], staffList: Staff[], format: "xlsx" | "csv") {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(servicesToRows(list, staffList), { header: SERVICE_EXPORT_COLS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Services");
  const date = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const csv = XLSX.utils.sheet_to_csv(ws);
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `services-${date}.csv`);
  } else {
    XLSX.writeFile(wb, `services-${date}.xlsx`);
  }
}

// ── Import Modal ──────────────────────────────────────────────────────────────
function ServiceImportModal({ existing, staffList, onClose, onImport }: {
  existing: Service[];
  staffList: Staff[];
  onClose: () => void;
  onImport: (records: ServiceImportRecord[]) => ServiceImportResult;
}) {
  const [step, setStep] = useState<"pick" | "preview" | "done">("pick");
  const [parsed, setParsed] = useState<ServiceImportRecord[]>([]);
  const [result, setResult] = useState<ServiceImportResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleFile(file: File) {
    setError("");
    setLoading(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
      if (rows.length === 0) {
        setError("File is empty or unreadable.");
        setLoading(false);
        return;
      }

      const byId = new Map(existing.map((sv) => [sv.id, sv]));
      const byName = new Map(existing.map((sv) => [sv.name.trim().toLowerCase(), sv]));
      const records: ServiceImportRecord[] = [];
      const usedIds = new Set(existing.map((sv) => sv.id));

      for (const row of rows) {
        const name = String(row["Name"] ?? row["name"] ?? "").trim();
        if (!name) continue;

        const rawId = String(row["Service ID"] ?? row["ID"] ?? row["id"] ?? "").trim();
        const existingService = (rawId && byId.get(rawId)) || byName.get(name.toLowerCase());
        const id = existingService?.id ?? (rawId || `sv_imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        if (!existingService && usedIds.has(id)) continue;
        usedIds.add(id);

        const rawCategory = String(row["Category"] ?? row["category"] ?? "").trim().toLowerCase();
        const isPackage = rawCategory === "package" || rawCategory === "deal" || rawCategory === "deals & packages";
        const category = isPackage ? "package" : (rawCategory || existingService?.category || "hair");
        const variablePrice = parseBool(row["Variable Price"] ?? row["Variable"]);
        const priceRangeMin = Number(row["Min Price"] ?? row["Price Range Min"] ?? "");
        const priceRangeMax = Number(row["Max Price"] ?? row["Price Range Max"] ?? "");
        const flatPrice = Number(row["Price"] ?? "");
        const durationMin = Number(row["Duration (Min)"] ?? row["Duration"] ?? row["Duration Min"] ?? "");

        records.push({
          mode: existingService ? "update" : "add",
          assignedStaffNames: splitList(row["Assigned Staff"] ?? row["Staff"]),
          includedServiceNames: splitList(row["Included Services"] ?? row["Services"]),
          service: {
            id,
            name,
            description: String(row["Description"] ?? row["description"] ?? "").trim() || existingService?.description,
            category,
            subcategory: String(row["Sub-category"] ?? row["Subcategory"] ?? row["subcategory"] ?? "").trim()
              || existingService?.subcategory
              || undefined,
            section: String(row["Section"] ?? row["section"] ?? "").trim()
              || existingService?.section
              || defaultSectionForNewRecord()
              || undefined,
            durationMin: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : (existingService?.durationMin ?? 30),
            price: variablePrice
              ? (Number.isFinite(priceRangeMin) ? priceRangeMin : 0)
              : (Number.isFinite(flatPrice) ? flatPrice : (existingService?.price ?? 0)),
            variablePrice,
            priceRangeMin: variablePrice && Number.isFinite(priceRangeMin) ? priceRangeMin : undefined,
            priceRangeMax: variablePrice && Number.isFinite(priceRangeMax) ? priceRangeMax : undefined,
            packageServiceIds: isPackage ? [] : undefined,
            customServices: existingService?.customServices,
            assignedStaffIds: [],
            multiStylist: existingService?.multiStylist,
            isActive: parseActive(row["Active"] ?? row["Status"]),
          },
        });
      }

      setParsed(records);
      setStep("preview");
    } catch (e) {
      setError(`Could not read file: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function downloadTemplate() {
    const XLSX = await import("xlsx");
    const sample = [
      {
        "Service ID": "", "Name": "Hydrafacial Premium", "Description": "Deep hydrating facial treatment",
        "Category": "skin", "Sub-category": "Facials", "Section": "", "Duration (Min)": 60, "Variable Price": "No",
        "Price": 3500, "Min Price": "", "Max Price": "", "Included Services": "", "Assigned Staff": "Sara Ahmed", "Active": "Yes",
      },
      {
        "Service ID": "", "Name": "Bridal Glow Combo", "Description": "",
        "Category": "package", "Sub-category": "", "Section": "", "Duration (Min)": 180, "Variable Price": "No",
        "Price": 15000, "Min Price": "", "Max Price": "", "Included Services": "Hydrafacial Premium, Haircut", "Assigned Staff": "", "Active": "Yes",
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sample, { header: SERVICE_EXPORT_COLS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Services Template");
    XLSX.writeFile(wb, "services-import-template.xlsx");
  }

  function confirmImport() {
    const importResult = onImport(parsed);
    setResult(importResult);
    setStep("done");
  }

  const addCount = parsed.filter((record) => record.mode === "add").length;
  const updateCount = parsed.filter((record) => record.mode === "update").length;
  const staffNames = new Set(staffList.map((st) => st.name.toLowerCase()));
  const serviceNames = new Set([...existing.map((s) => s.name.toLowerCase()), ...parsed.map((r) => r.service.name.toLowerCase())]);
  const missingStaffCount = parsed.reduce((count, record) => count + record.assignedStaffNames.filter((name) => !staffNames.has(name.toLowerCase())).length, 0);
  const missingIncludedCount = parsed.reduce((count, record) => count + record.includedServiceNames.filter((name) => !serviceNames.has(name.toLowerCase())).length, 0);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 540, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#5B21B6,#9333EA)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <FileSpreadsheet size={18} color="#fff" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Import Services</div>
              <div style={{ fontSize: 11, color: "#9898b0" }}>XLSX or CSV file</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}><X size={18} color="#9898b0" /></button>
        </div>

        {step === "pick" && (
          <>
            <label style={{ display: "block", border: "2px dashed #ddd6fe", borderRadius: 14, padding: "32px 20px", textAlign: "center", cursor: "pointer", background: "#faf9ff" }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              <Upload size={28} color="#7C3AED" style={{ marginBottom: 10 }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: "#5B21B6", marginBottom: 4 }}>Click to choose file or drag & drop</div>
              <div style={{ fontSize: 12, color: "#9898b0" }}>Supports .xlsx, .xls, .csv</div>
            </label>
            {loading && <div style={{ textAlign: "center", marginTop: 16, color: "#7C3AED", fontSize: 13, fontWeight: 600 }}>Reading file...</div>}
            {error && <div style={{ marginTop: 12, padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 13, color: "#dc2626" }}>{error}</div>}

            <div style={{ marginTop: 18, padding: "14px 16px", background: "#f5f3ff", borderRadius: 12, fontSize: 12, color: "#5B21B6", lineHeight: 1.8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <strong style={{ fontSize: 12 }}>Column format</strong>
                <button onClick={downloadTemplate} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 8, border: "1px solid #c4b5fd", background: "#fff", fontSize: 11, fontWeight: 700, color: "#5B21B6", cursor: "pointer", whiteSpace: "nowrap" }}>
                  <Download size={12} /> Download Template
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px", fontSize: 11 }}>
                {[
                  ["Name", "Required"], ["Duration (Min)", "Required"], ["Price", "Required unless Variable Price"], ["Category", "hair / skin / nails / bridal / piercing / package / custom"],
                  ["Included Services", "Comma-separated, for Category = package"], ["Assigned Staff", "Comma-separated staff names"], ["Variable Price", "Yes / No"], ["Active", "Yes / No"],
                ].map(([col, hint]) => <div key={col}><strong>{col}</strong>: {hint}</div>)}
              </div>
            </div>
          </>
        )}

        {step === "preview" && (
          <>
            <div style={{ padding: "14px 16px", background: "#f8f7ff", border: "1px solid #e9d5ff", borderRadius: 12, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e" }}>{parsed.length} service{parsed.length === 1 ? "" : "s"} ready</div>
              <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 4 }}>
                {addCount} new, {updateCount} update{updateCount === 1 ? "" : "s"}
                {missingStaffCount ? `, ${missingStaffCount} unmatched staff assignment${missingStaffCount === 1 ? "" : "s"}` : ""}
                {missingIncludedCount ? `, ${missingIncludedCount} unmatched included service${missingIncludedCount === 1 ? "" : "s"}` : ""}
              </div>
            </div>
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid #f0f0f8", borderRadius: 12 }}>
              {parsed.slice(0, 8).map((record) => (
                <div key={record.service.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid #f8f8fc" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>{record.service.name}</div>
                    <div style={{ fontSize: 11, color: "#9898b0" }}>{catLabel(record.service.category)} · {record.service.durationMin}m</div>
                  </div>
                  <span style={{ alignSelf: "center", fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "3px 8px", background: record.mode === "add" ? "#ecfdf5" : "#eff6ff", color: record.mode === "add" ? "#059669" : "#2563eb" }}>{record.mode === "add" ? "Add" : "Update"}</span>
                </div>
              ))}
              {parsed.length > 8 && <div style={{ padding: "10px 12px", fontSize: 12, color: "#9898b0" }}>+{parsed.length - 8} more</div>}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={() => setStep("pick")} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}>Back</button>
              <button onClick={confirmImport} disabled={parsed.length === 0} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: parsed.length ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 700, color: parsed.length ? "#fff" : "#b0b0c8", cursor: parsed.length ? "pointer" : "not-allowed" }}>Import Services</button>
            </div>
          </>
        )}

        {step === "done" && result && (
          <div style={{ textAlign: "center", padding: "24px 8px 8px" }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}><Check size={28} color="#059669" /></div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1a1a2e", marginBottom: 6 }}>Import Complete</div>
            <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 20 }}>{result.added} added, {result.updated} updated{result.skipped ? `, ${result.skipped} skipped` : ""}.</div>
            <button onClick={onClose} style={{ padding: "10px 32px", borderRadius: 10, border: "none", background: "#7C3AED", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add/Edit Service Modal ────────────────────────────────────────────────────
function AddEditServiceModal({ onClose, onSave, staffList, servicesList, inventoryList, serviceToEdit }: {
  onClose: () => void; onSave: (s: Service) => void; staffList: Staff[]; servicesList: Service[]; inventoryList: InventoryItem[]; serviceToEdit?: Service;
}) {
  const isEditing = !!serviceToEdit;
  const isEditingPackage = serviceToEdit?.category === "package";
  const editedCategoryIsCustom = !!serviceToEdit && !isEditingPackage && !PRESET_CATEGORIES.includes(serviceToEdit.category);
  // Services this package can bundle — excludes other packages (no nesting) and itself.
  const selectableServices = servicesList.filter((s) => !s.packageServiceIds?.length && s.id !== serviceToEdit?.id);

  const [form, setForm] = useState({
    isPackage:         isEditingPackage,
    packageServiceIds: serviceToEdit?.packageServiceIds ?? [] as string[],
    customServices:    serviceToEdit?.customServices ?? [] as { name: string; price?: number; durationMin?: number }[],
    name:             serviceToEdit?.name ?? "",
    description:      serviceToEdit?.description ?? "",
    category:         editedCategoryIsCustom ? "custom" : (serviceToEdit?.category ?? "hair"),
    customCategory:   editedCategoryIsCustom ? serviceToEdit!.category : "",
    subcategory:      serviceToEdit?.subcategory ?? "",
    section:          serviceToEdit?.section ?? defaultSectionForNewRecord(),
    durationMin:      serviceToEdit ? String(serviceToEdit.durationMin) : "60",
    price:            serviceToEdit ? String(serviceToEdit.price) : "",
    variablePrice:    serviceToEdit?.variablePrice ?? false,
    priceRangeMin:    serviceToEdit?.priceRangeMin ? String(serviceToEdit.priceRangeMin) : "",
    priceRangeMax:    serviceToEdit?.priceRangeMax ? String(serviceToEdit.priceRangeMax) : "",
    assignedStaffIds: serviceToEdit?.assignedStaffIds ?? [] as string[],
    multiStylist:     serviceToEdit?.multiStylist ?? false,
    inventoryUsage:   serviceToEdit?.inventoryUsage ?? [] as string[],
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const [done, setDone] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customDuration, setCustomDuration] = useState("");
  const [usageItemId, setUsageItemId] = useState("");

  const price = Number(form.price) || 0;
  const rangeMin = Number(form.priceRangeMin) || 0;
  const rangeMax = Number(form.priceRangeMax) || 0;
  const durationMin = Number(form.durationMin);
  const canSubmit = Boolean(
    form.name.trim()
    && (form.variablePrice
      ? (form.priceRangeMin && form.priceRangeMax && rangeMin > 0 && rangeMax >= rangeMin)
      : (Number.isFinite(price) && price > 0))
    && Number.isFinite(durationMin)
    && durationMin > 0
    && (form.isPackage ? form.packageServiceIds.length >= 2 : (form.category !== "custom" || form.customCategory.trim())),
  );

  const includedServices = selectableServices.filter((s) => form.packageServiceIds.includes(s.id));
  const includedTotal    = includedServices.reduce((s, sv) => s + sv.price, 0);
  const includedDuration = includedServices.reduce((s, sv) => s + sv.durationMin, 0);

  // Suggest a deal price/duration = sum of the included services' price/duration;
  // both remain editable afterward.
  const recalcPackageTotals = (ids: string[]) => {
    const included = selectableServices.filter((s) => ids.includes(s.id));
    const sumDuration = included.reduce((s, sv) => s + sv.durationMin, 0);
    const sumPrice    = included.reduce((s, sv) => s + sv.price, 0);
    if (sumDuration > 0) set("durationMin", String(sumDuration));
    set("price", sumPrice > 0 ? String(sumPrice) : "");
  };

  const togglePackageService = (id: string) => {
    const cur = form.packageServiceIds.includes(id)
      ? form.packageServiceIds.filter((x: string) => x !== id)
      : [...form.packageServiceIds, id];
    set("packageServiceIds", cur);
    recalcPackageTotals(cur);
  };

  // Suggest a single service's price/duration = sum of its added components; still editable after.
  const recalcComponentTotals = (customs: typeof form.customServices) => {
    const sumDuration = customs.reduce((s, cs) => s + (cs.durationMin ?? 0), 0);
    const sumPrice    = customs.reduce((s, cs) => s + (cs.price ?? 0), 0);
    if (sumDuration > 0) set("durationMin", String(sumDuration));
    set("price", sumPrice > 0 ? String(sumPrice) : "");
  };

  const addCustomService = () => {
    if (!customName.trim()) return;
    const entry = {
      name:        customName.trim(),
      price:       customPrice ? Number(customPrice) : undefined,
      durationMin: customDuration ? Number(customDuration) : undefined,
    };
    const cur = [...form.customServices, entry];
    set("customServices", cur);
    recalcComponentTotals(cur);
    setCustomName(""); setCustomPrice(""); setCustomDuration("");
  };

  const removeCustomService = (idx: number) => {
    const cur = form.customServices.filter((_, i) => i !== idx);
    set("customServices", cur);
    recalcComponentTotals(cur);
  };

  const addUsage = () => {
    if (!usageItemId || form.inventoryUsage.includes(usageItemId)) return;
    set("inventoryUsage", [...form.inventoryUsage, usageItemId]);
    setUsageItemId("");
  };

  const removeUsage = (itemId: string) =>
    set("inventoryUsage", form.inventoryUsage.filter((id) => id !== itemId));

  const toggleStaff = (id: string) => {
    const cur = [...form.assignedStaffIds];
    set("assignedStaffIds", cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  };

  const handleSave = () => {
    if (!canSubmit) return;
    onSave({
      id:               serviceToEdit?.id ?? "sv" + Date.now(),
      name:             form.name.trim(),
      description:      form.description.trim() || undefined,
      category:         form.isPackage ? "package" : (form.category === "custom" ? form.customCategory.trim() : form.category),
      subcategory:      !form.isPackage && form.subcategory.trim() ? form.subcategory.trim() : undefined,
      section:          form.section || undefined,
      durationMin,
      price:            form.variablePrice ? rangeMin : price,
      variablePrice:    form.variablePrice,
      priceRangeMin:    form.variablePrice ? rangeMin : undefined,
      priceRangeMax:    form.variablePrice ? rangeMax : undefined,
      packageServiceIds: form.isPackage ? form.packageServiceIds : undefined,
      customServices:   !form.isPackage && form.customServices.length > 0 ? form.customServices : undefined,
      assignedStaffIds: form.assignedStaffIds,
      multiStylist:     form.multiStylist && form.assignedStaffIds.length >= 2 ? true : undefined,
      inventoryUsage:   form.inventoryUsage.length > 0 ? form.inventoryUsage : undefined,
      isActive:         serviceToEdit?.isActive ?? true,
    });
    setDone(true);
  };

  if (done) return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 360, padding: "48px 32px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 28, color: "#059669" }}>✓</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: "#1a1a2e", marginBottom: 8 }}>{isEditing ? "Service Updated" : "Service Added"}</div>
        <div style={{ fontSize: 13, color: "#9898b0", marginBottom: 24 }}>{isEditing ? "The service has been updated." : "The service has been saved."}</div>
        <button onClick={onClose} style={{ padding: "10px 32px", borderRadius: 10, background: "#7C3AED", border: "none", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );

  return (
    <div onClick={onClose} className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet" style={{ background: "#fff", borderRadius: 20, width: 460, maxHeight: "90vh", overflowY: "auto", overflowX: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "22px 24px 18px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>{isEditing ? "Edit Service" : "Add Service"}</div>
          <button type="button" onClick={onClose} aria-label="Close service form" style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}><X size={18} color="#6b6b8a" /></button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
          style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}
        >
          <div style={{ display: "flex", gap: 6, background: "#f4f4f9", border: "1px solid #e3e0eb", borderRadius: 12, padding: 4 }}>
            {([["single", "Single Service"], ["package", "Deal / Package"]] as const).map(([val, label]) => {
              const active = (val === "package") === form.isPackage;
              return (
                <button key={val} type="button" onClick={() => set("isPackage", val === "package")}
                  style={{
                    flex: 1, padding: "9px 0", borderRadius: 9, border: "none",
                    background: active ? "var(--accent-gradient)" : "transparent",
                    color: active ? "#fff" : "#6b6b8a", fontSize: 13, fontWeight: 750, cursor: "pointer",
                    boxShadow: active ? "0 4px 10px var(--accent-glow)" : "none", transition: "all 0.18s ease",
                  }}>
                  {label}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {form.isPackage ? "Deal / Package Name" : "Service Name"}
            </label>
            <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={form.isPackage ? "e.g. Bridal Glow Combo" : "e.g. Hydrafacial Premium"}
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Description <span style={{ textTransform: "none", fontWeight: 500, color: "#c0c0d0" }}>(optional)</span>
            </label>
            <textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={2}
              placeholder={form.isPackage ? "What's included, ideal for, or any details clients should know…" : "Short description clients will see, e.g. what it treats or includes"}
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", resize: "vertical", fontFamily: "inherit" }} />
          </div>

          {form.isPackage ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Duration (Minutes)</label>
              <input type="number" value={form.durationMin} onChange={(e) => set("durationMin", e.target.value)} placeholder="e.g. 60"
                style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Category</label>
                <select value={form.category} onChange={(e) => set("category", e.target.value)}
                  style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                  <option value="hair">Hair Care</option>
                  <option value="skin">Skin Care</option>
                  <option value="nails">Nails</option>
                  <option value="bridal">Bridal</option>
                  <option value="piercing">Ear Piercing</option>
                  <option value="custom">Custom…</option>
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Duration (Minutes)</label>
                <input type="number" value={form.durationMin} onChange={(e) => set("durationMin", e.target.value)} placeholder="e.g. 60"
                  style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
              </div>
            </div>
          )}
          {!form.isPackage && form.category === "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Custom Category Name</label>
              <input type="text" value={form.customCategory} onChange={(e) => set("customCategory", e.target.value)} placeholder="e.g. Massage"
                style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
            </div>
          )}

          {!form.isPackage && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Sub-category <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>(optional)</span>
              </label>
              <input type="text" list="subcategory-options" value={form.subcategory} onChange={(e) => set("subcategory", e.target.value)}
                placeholder="e.g. Keratin, Men's Haircuts"
                style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
              {/* Suggests the sub-categories already used in this category, so the same group isn't typed two ways. */}
              <datalist id="subcategory-options">
                {Array.from(new Set(servicesList
                  .filter((s) => s.category === (form.category === "custom" ? form.customCategory.trim() : form.category))
                  .map((s) => s.subcategory)
                  .filter((x): x is string => Boolean(x))))
                  .map((sub) => <option key={sub} value={sub} />)}
              </datalist>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Salon Section</label>
            <select value={form.section} onChange={(e) => set("section", e.target.value)}
              style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none", background: "#fff" }}>
              <option value="">Unassigned</option>
              {getSectionOptions(servicesList).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {form.isPackage && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Included Services (select 2 or more)
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto", border: "1px solid #e8e8f0", borderRadius: 8, padding: 8 }}>
                {selectableServices.map((sv) => {
                  const checked = form.packageServiceIds.includes(sv.id);
                  return (
                    <div key={sv.id} onClick={() => togglePackageService(sv.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "#fef9c3" : "transparent" }}>
                      <div style={{ width: 16, height: 16, borderRadius: 4, border: "1px solid #a16207", display: "flex", alignItems: "center", justifyContent: "center", background: checked ? "#a16207" : "#fff", flexShrink: 0 }}>
                        {checked && <Check size={11} color="#fff" strokeWidth={3} />}
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e", flex: 1 }}>{sv.name}</span>
                      <span style={{ fontSize: 11, color: "#9898b0" }}>{fmt(sv.price)} · {sv.durationMin}m</span>
                    </div>
                  );
                })}
                {selectableServices.length === 0 && <div style={{ fontSize: 12, color: "#9898b0", padding: "6px 8px" }}>Add some individual services first</div>}
              </div>

              {includedServices.length > 0 && (
                <div style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 500 }}>
                  Booked separately: <strong style={{ color: "#1a1a2e" }}>{fmt(includedTotal)}</strong> for {includedDuration} min
                </div>
              )}
            </div>
          )}
          {!form.isPackage && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Components <span style={{ textTransform: "none", fontWeight: 500, color: "#c0c0d0" }}>(optional — add 1 or more to auto-calculate price &amp; duration)</span>
              </label>
              {form.customServices.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {form.customServices.map((cs, idx) => (
                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, background: "#F5F3FF" }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e", flex: 1 }}>{cs.name}</span>
                      <span style={{ fontSize: 11, color: "#9898b0" }}>
                        {cs.price ? fmt(cs.price) : "—"} {cs.durationMin ? `· ${cs.durationMin}m` : ""}
                      </span>
                      <button type="button" onClick={() => removeCustomService(idx)} aria-label={`Remove ${cs.name}`}
                        style={{ background: "none", border: "none", cursor: "pointer", display: "flex", padding: 2 }}>
                        <X size={13} color="#7C3AED" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <input type="text" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Component name"
                  style={{ flex: "2 1 120px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 12, color: "#1a1a2e", outline: "none" }} />
                <input type="number" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} placeholder="Price"
                  style={{ flex: "1 1 60px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 12, color: "#1a1a2e", outline: "none" }} />
                <input type="number" value={customDuration} onChange={(e) => setCustomDuration(e.target.value)} placeholder="Mins"
                  style={{ flex: "1 1 60px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 12, color: "#1a1a2e", outline: "none" }} />
                <button type="button" onClick={addCustomService} disabled={!customName.trim()}
                  style={{ flexShrink: 0, padding: "8px 12px", borderRadius: 8, border: "none", background: customName.trim() ? "#7C3AED" : "#e8e8f0", color: customName.trim() ? "#fff" : "#b0b0c8", fontSize: 12, fontWeight: 700, cursor: customName.trim() ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 4 }}>
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>
          )}
          {!form.isPackage && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Products Used <span style={{ textTransform: "none", fontWeight: 500, color: "#c0c0d0" }}>(optional — counted each time this service is done)</span>
              </label>
              {form.inventoryUsage.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {form.inventoryUsage.map((itemId) => {
                    const item = inventoryList.find((i) => i.id === itemId);
                    return (
                      <div key={itemId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, background: "#F5F3FF" }}>
                        <Boxes size={13} color="#7C3AED" style={{ flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e", flex: 1 }}>
                          {item ? `${item.brand ? item.brand + " " : ""}${item.name}` : "Deleted product"}
                        </span>
                        <button type="button" onClick={() => removeUsage(itemId)} aria-label={`Remove ${item?.name ?? "product"}`}
                          style={{ background: "none", border: "none", cursor: "pointer", display: "flex", padding: 2 }}>
                          <X size={13} color="#7C3AED" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <select value={usageItemId} onChange={(e) => setUsageItemId(e.target.value)}
                  style={{ flex: "3 1 180px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 12, color: "#1a1a2e", outline: "none", background: "#fff" }}>
                  <option value="">Choose a product…</option>
                  {inventoryList
                    .filter((item) => !form.inventoryUsage.includes(item.id))
                    .map((item) => (
                      <option key={item.id} value={item.id}>{item.brand ? `${item.brand} ` : ""}{item.name}</option>
                    ))}
                </select>
                <button type="button" onClick={addUsage} disabled={!usageItemId}
                  style={{ flexShrink: 0, padding: "8px 12px", borderRadius: 8, border: "none", background: usageItemId ? "#7C3AED" : "#e8e8f0", color: usageItemId ? "#fff" : "#b0b0c8", fontSize: 12, fontWeight: 700, cursor: usageItemId ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 4 }}>
                  <Plus size={13} /> Add
                </button>
              </div>
              {inventoryList.length === 0 && <div style={{ fontSize: 12, color: "#9898b0" }}>No products in Inventory yet.</div>}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {!form.variablePrice && (
              <>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{form.isPackage ? "Deal Price (PKR)" : "Price (PKR)"}</label>
                <input type="number" value={form.price} onChange={(e) => set("price", e.target.value)} placeholder="e.g. 3500"
                  style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
              </>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 2 }}>
              <input type="checkbox" checked={form.variablePrice} onChange={(e) => set("variablePrice", e.target.checked)}
                style={{ width: 14, height: 14, accentColor: "#7C3AED", cursor: "pointer" }} />
              <span style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 500 }}>Price is not fixed (varies per client, charge decided at checkout)</span>
            </label>
          </div>
          {form.variablePrice && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Min Price (PKR)</label>
                <input type="number" value={form.priceRangeMin} onChange={(e) => set("priceRangeMin", e.target.value)} placeholder="e.g. 3500"
                  style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Max Price (PKR)</label>
                <input type="number" value={form.priceRangeMax} onChange={(e) => set("priceRangeMax", e.target.value)} placeholder="e.g. 6000"
                  style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #e8e8f0", fontSize: 13, color: "#1a1a2e", outline: "none" }} />
              </div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {form.multiStylist ? "Stylist Team" : "Assign Stylists"}
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 140, overflowY: "auto", border: "1px solid #e8e8f0", borderRadius: 8, padding: 8 }}>
              {staffList.map((st) => {
                const checked = form.assignedStaffIds.includes(st.id);
                return (
                  <div key={st.id} onClick={() => toggleStaff(st.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "#f4f0fe" : "transparent" }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: "1px solid #7C3AED", display: "flex", alignItems: "center", justifyContent: "center", background: checked ? "#7C3AED" : "#fff" }}>
                      {checked && <Check size={11} color="#fff" strokeWidth={3} />}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#1a1a2e" }}>{st.name}</span>
                  </div>
                );
              })}
              {staffList.length === 0 && <div style={{ fontSize: 12, color: "#9898b0", padding: "6px 8px" }}>No staff added yet</div>}
            </div>
            {form.assignedStaffIds.length >= 2 && (
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginTop: 2 }}>
                <input type="checkbox" checked={form.multiStylist} onChange={(e) => set("multiStylist", e.target.checked)}
                  style={{ width: 14, height: 14, accentColor: "#7C3AED", cursor: "pointer", marginTop: 2, flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: "#6b6b8a", fontWeight: 500 }}>
                  These stylists work together as a team on this service (e.g. bridal hair + makeup done jointly) — not individually interchangeable. Informational only; doesn&rsquo;t change booking or payroll.
                </span>
              </label>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
            <button type="submit" disabled={!canSubmit} style={{ flex: 2, padding: "11px 0", borderRadius: 10, border: "none", background: canSubmit ? "#7C3AED" : "#e8e8f0", fontSize: 13, fontWeight: 600, color: canSubmit ? "#fff" : "#b0b0c8", cursor: canSubmit ? "pointer" : "not-allowed" }}>
              {isEditing ? "Save Changes" : "Add Service"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Delete Confirm Modal ──────────────────────────────────────────────────────
function DeleteConfirmModal({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 340, maxWidth: "100%", padding: "32px 28px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <Trash2 size={22} color="#dc2626" />
        </div>
        <div style={{ fontWeight: 700, fontSize: 17, color: "#1a1a2e", marginBottom: 8 }}>Delete Service?</div>
        <div style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 24 }}>
          This will permanently delete <strong>{name}</strong> and cannot be undone.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #e8e8f0", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6b6b8a", cursor: "pointer" }}>Cancel</button>
          <button onClick={onConfirm} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#dc2626", fontSize: 13, fontWeight: 600, color: "#fff", cursor: "pointer" }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
  const [filter, setFilter] = useState("all");
  // Sub-category within the selected category tab; "all" shows every group.
  const [subFilter, setSubFilter] = useState("all");
  const [sectionFilter, setSectionFilter] = useState(() => getActiveSection());
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  useEffect(() => {
    const load = () => {
      setServices(getStoredServices());
      setStaff(getStoredStaff());
      setInventory(getStoredInventory());
    };
    load();
    // Re-read whenever a DB sync (or another tab) rewrites localStorage, so this
    // page never keeps showing — or saving from — a list that is missing
    // services added on another terminal.
    return subscribeToStoredData(load);
  }, []);

  const handleSaveService = (savedService: Service) => {
    setServices((current) => {
      const exists = current.some((service) => service.id === savedService.id);
      const updated = exists
        ? current.map((service) => service.id === savedService.id ? savedService : service)
        : [...current, savedService];
      saveServices(updated);
      return updated;
    });
  };

  const toggleServiceStatus = (id: string) => {
    const updated = services.map(s => s.id === id ? { ...s, isActive: !s.isActive } : s);
    setServices(updated);
    saveServices(updated);
  };

  const handleDeleteService = (id: string) => {
    const updated = services.filter(s => s.id !== id);
    setServices(updated);
    saveServices(updated, [id]);
    setDeleteTarget(null);
  };

  const handleImportServices = (records: ServiceImportRecord[]): ServiceImportResult => {
    const byId = new Map(services.map((sv) => [sv.id, sv]));
    let added = 0;
    let updated = 0;
    const skipped = 0;

    for (const record of records) {
      if (byId.has(record.service.id)) updated += 1;
      else added += 1;
      byId.set(record.service.id, record.service);
    }

    const nextServices = Array.from(byId.values());

    for (const record of records) {
      const sv = nextServices.find((s) => s.id === record.service.id);
      if (!sv) continue;
      sv.assignedStaffIds = record.assignedStaffNames
        .map((name) => staff.find((st) => st.name.toLowerCase() === name.toLowerCase())?.id)
        .filter((id): id is string => Boolean(id));
      if (sv.category === "package") {
        sv.packageServiceIds = record.includedServiceNames
          .map((name) => nextServices.find((s) => s.id !== sv.id && s.name.toLowerCase() === name.toLowerCase())?.id)
          .filter((id): id is string => Boolean(id));
      }
    }

    setServices(nextServices);
    saveServices(nextServices);
    return { added, updated, skipped, errors: [] };
  };

  // Sub-categories of the selected category tab, in the order they first appear.
  const subcategoryTabs = filter === "all" ? [] : Array.from(new Set(
    services.filter(s => s.category === filter).map(s => s.subcategory).filter((x): x is string => Boolean(x))
  ));
  const filteredServices = services
    .filter(s => filter === "all" || s.category === filter)
    .filter(s => subFilter === "all" || s.subcategory === subFilter)
    .filter(s => inSection(s, sectionFilter))
    .filter(s => !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase()));
  const customCategories = Array.from(new Set(services.map(s => s.category))).filter(c => !PRESET_CATEGORIES.includes(c));
  const tabCategories = ["all", ...PRESET_CATEGORIES, ...customCategories];
  const tabSections = ["all", ...getSectionOptions(services)];

  const totalCount  = services.length;
  const maxPrice    = services.reduce((m, s) => s.price > m ? s.price : m, 0);
  const avgDuration = totalCount > 0 ? Math.round(services.reduce((s, a) => s + a.durationMin, 0) / totalCount) : 0;
  const activeCount = services.filter(s => s.isActive).length;

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#ffffff", minHeight: "100vh", display: "flex", flexDirection: "column", gap: 20 }}>
      {(showAdd || editingService) && (
        <AddEditServiceModal
          onClose={() => { setShowAdd(false); setEditingService(null); }}
          onSave={handleSaveService}
          staffList={staff}
          servicesList={services}
          inventoryList={inventory}
          serviceToEdit={editingService ?? undefined}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          name={deleteTarget.name}
          onConfirm={() => handleDeleteService(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {showImport && (
        <ServiceImportModal
          existing={services}
          staffList={staff}
          onClose={() => setShowImport(false)}
          onImport={handleImportServices}
        />
      )}

      {/* Native mobile app bar */}
      <MobilePageHeader
        title="Services"
        subtitle={`${services.length} services · ${activeCount} active`}
        action={{ label: "Add", icon: <Plus size={14} />, onClick: () => setShowAdd(true) }}
      />

      {/* Header */}
      <div className="dashboard-topbar page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <PageTitle
          icon={<Scissors size={24} />}
          title="Services"
          subtitle={
            <>
            {services.length} salon services · <span style={{ color: "var(--accent)", fontWeight: 700 }}>{activeCount} active</span>
            </>
          }
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => setShowImport(true)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 12, border: "1px solid #e3e0eb", background: "#fff", fontSize: 13, fontWeight: 750, color: "#6b6b8a", cursor: "pointer", transition: "all 0.18s ease" }}
            className="hover-bg-light"
          >
            <Upload size={15} /> Import
          </button>
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowExportMenu((open) => !open)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 12, border: "1px solid #bbf7d0", background: "#f0fdf4", fontSize: 13, fontWeight: 750, color: "#059669", cursor: "pointer", transition: "all 0.18s ease" }}
            >
              <Download size={15} /> Export <ChevronDown size={12} style={{ transform: showExportMenu ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
            </button>
            {showExportMenu && (
              <>
                <div onClick={() => setShowExportMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
                <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 20, width: 188, background: "#fff", border: "1px solid #e8e8f0", borderRadius: 12, boxShadow: "0 12px 34px rgba(16, 24, 40, 0.12)", padding: 6 }}>
                  {[
                    { fmt: "xlsx" as const, label: "Excel (.xlsx)" },
                    { fmt: "csv" as const, label: "CSV (.csv)" },
                  ].map(({ fmt, label }) => (
                    <button key={fmt} onClick={() => { setShowExportMenu(false); exportServices(filteredServices, staff, fmt); }}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", border: "none", background: "transparent", borderRadius: 8, fontSize: 12, fontWeight: 700, color: "#1a1a2e", cursor: "pointer", textAlign: "left" }} className="hover-bg-light">
                      <FileSpreadsheet size={14} color="#059669" /> {label}
                    </button>
                  ))}
                  <div style={{ padding: "7px 10px 4px", fontSize: 10, color: "#9898b0", borderTop: "1px solid #f0f0f8", marginTop: 4 }}>Exports {filteredServices.length} visible services</div>
                </div>
              </>
            )}
          </div>
          <button onClick={() => setShowAdd(true)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 12, border: "none", background: "var(--accent-gradient)", fontSize: 13, fontWeight: 750, color: "#fff", boxShadow: "0 4px 14px var(--accent-glow)", cursor: "pointer", transition: "all 0.18s ease" }} className="page-header-btn">
            <Plus size={16} /> Add Service
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid-4" style={{ marginBottom: 4 }}>
        {[
          { label: "Total Services",    value: totalCount,       icon: <Scissors size={18} />,  color: "var(--accent)", bg: "rgba(124, 58, 237, 0.08)" },
          { label: "Active Services",   value: activeCount,      icon: <Sparkles size={18} />,  color: "#059669", bg: "rgba(5, 150, 105, 0.08)" },
          { label: "Average Duration",  value: `${avgDuration} min`, icon: <Clock size={18} />, color: "#3b82f6", bg: "rgba(59, 130, 246, 0.08)" },
          { label: "Highest Price",     value: fmt(maxPrice),    icon: <DollarSign size={18} />, color: "#db2777", bg: "rgba(219, 39, 119, 0.08)" },
        ].map((stat, i) => (
          <div key={i} style={{
            background: "#fff",
            borderRadius: 18,
            border: "1px solid rgba(226,223,235,.95)",
            boxShadow: "0 8px 28px rgba(38,25,75,.04)",
            padding: "20px",
            display: "flex",
            alignItems: "center",
            gap: 16
          }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: stat.bg, color: stat.color, display: "flex", alignItems: "center", justifyContent: "center" }}>{stat.icon}</div>
            <div>
              <div style={{ fontSize: 11, color: "#9898b0", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em" }}>{stat.label}</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#1a1a2e", marginTop: 6, letterSpacing: "-0.01em" }}>{stat.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid #e3e0eb", borderRadius: 12, padding: "10px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.01)" }}>
        <Search size={15} color="#b0b0c8" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search services by name…"
          style={{ flex: 1, border: "none", outline: "none", fontSize: 13, color: "#1a1a2e", background: "transparent" }} />
        {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", padding: 0 }}><X size={14} color="#b0b0c8" /></button>}
      </div>

      {/* Category filter */}
      <div className="filter-tabs" style={{ display: "flex", gap: 6, background: "#f4f4f9", border: "1px solid #e3e0eb", borderRadius: 12, padding: 4, alignSelf: "flex-start", marginBottom: 4 }}>
        {tabCategories.map((cat) => {
          const active = filter === cat;
          return (
            <button key={cat} onClick={() => { setFilter(cat); setSubFilter("all"); }}
              style={{
                padding: "7px 16px",
                borderRadius: 9,
                border: "none",
                background: active ? "var(--accent-gradient)" : "transparent",
                color: active ? "#fff" : "#6b6b8a",
                fontSize: 13,
                fontWeight: 750,
                cursor: "pointer",
                boxShadow: active ? "0 4px 10px var(--accent-glow)" : "none",
                transition: "all 0.18s ease"
              }}>
              {cat === "all" ? "All Services" : catLabel(cat)}
            </button>
          );
        })}
      </div>

      {/* Sub-category chips — only when the chosen category has any */}
      {subcategoryTabs.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignSelf: "flex-start", marginTop: -8 }}>
          {["all", ...subcategoryTabs].map((sub) => {
            const active = subFilter === sub;
            return (
              <button key={sub} onClick={() => setSubFilter(sub)}
                style={{
                  padding: "6px 13px", borderRadius: 999, cursor: "pointer",
                  border: `1px solid ${active ? "#7C3AED" : "#e3e0eb"}`,
                  background: active ? "#F5F3FF" : "#fff",
                  color: active ? "#7C3AED" : "#6b6b8a",
                  fontSize: 12, fontWeight: 750,
                }}>
                {sub === "all" ? `All ${catLabel(filter)}` : sub}
                <span style={{ marginLeft: 6, opacity: 0.6 }}>
                  {services.filter(s => s.category === filter && (sub === "all" || s.subcategory === sub)).length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Section filter — locked to the active dashboard section when one is
          set; switch the global "Active Section" control to see another. */}
      {getActiveSection() !== "all" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-start", padding: "8px 14px", borderRadius: 12, background: "#f5f3ff", border: "1px solid #ddd6fe" }}>
          <Lock size={13} color="#7C3AED" />
          <span style={{ fontSize: 12, fontWeight: 750, color: "#7C3AED" }}>Showing {getActiveSection()} + unassigned services</span>
        </div>
      ) : (
        <div className="filter-tabs" style={{ display: "flex", gap: 6, background: "#f4f4f9", border: "1px solid #e3e0eb", borderRadius: 12, padding: 4, alignSelf: "flex-start", marginBottom: 4 }}>
          {tabSections.map((sec) => {
            const active = sectionFilter === sec;
            return (
              <button key={sec} onClick={() => setSectionFilter(sec)}
                style={{
                  padding: "7px 16px",
                  borderRadius: 9,
                  border: "none",
                  background: active ? "var(--accent-gradient)" : "transparent",
                  color: active ? "#fff" : "#6b6b8a",
                  fontSize: 13,
                  fontWeight: 750,
                  cursor: "pointer",
                  boxShadow: active ? "0 4px 10px var(--accent-glow)" : "none",
                  transition: "all 0.18s ease"
                }}>
                {sec === "all" ? "All Sections" : sec}
              </button>
            );
          })}
        </div>
      )}

      {/* Service cards */}
      {filteredServices.length === 0 ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "#b0b0c8" }}>
          <Scissors size={36} style={{ display: "block", margin: "0 auto 12px" }} />
          <div style={{ fontSize: 15, fontWeight: 700 }}>No services yet</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Click &quot;Add Service&quot; to get started</div>
        </div>
      ) : (
        <div className="cards-grid-auto">
          {filteredServices.map((sv) => {
            const badge    = CATEGORY_LABELS[sv.category] || { label: catLabel(sv.category), bg: "#f3f4f6", color: "#4b5563" };
            const assigned = staff.filter((st) => sv.assignedStaffIds.includes(st.id));
            const isPkg = sv.category === "package";
            const includedNames = isPkg
              ? (sv.packageServiceIds
                  ?.map((id) => services.find((s) => s.id === id)?.name)
                  .filter((n): n is string => Boolean(n)) ?? [])
              : undefined;
            const componentNames = !isPkg ? sv.customServices?.map((cs) => cs.name) : undefined;
            return (
              <div key={sv.id} style={{ background: "#fff", padding: "24px", display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                  <div>
                    <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", background: badge.bg, color: badge.color, padding: "3px 10px", borderRadius: 20, letterSpacing: "0.05em", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {includedNames && <PackageIcon size={10} />}
                      {badge.label}
                      {sv.subcategory && <span style={{ opacity: 0.7 }}>· {sv.subcategory}</span>}
                    </span>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e", marginTop: 12, letterSpacing: "-0.01em" }}>{sv.name}</div>
                    {sv.description && (
                      <div style={{ fontSize: 12, color: "#6b6b8a", marginTop: 4, lineHeight: 1.4 }}>{sv.description}</div>
                    )}
                    {includedNames && includedNames.length > 0 && (
                      <div style={{ fontSize: 11, color: "#9898b0", marginTop: 4 }}>Includes: {includedNames.join(", ")}</div>
                    )}
                    {componentNames && componentNames.length > 0 && (
                      <div style={{ fontSize: 11, color: "#9898b0", marginTop: 4 }}>Made of: {componentNames.join(", ")}</div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button type="button" onClick={() => setEditingService(sv)} aria-label={`Edit ${sv.name}`}
                      style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #EDE9FE", background: "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}
                      className="hover-bg-light">
                      <Pencil size={14} color="#7C3AED" />
                    </button>
                    <button type="button" onClick={() => setDeleteTarget(sv)} aria-label={`Delete ${sv.name}`}
                      style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #fee2e2", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}>
                      <Trash2 size={14} color="#dc2626" />
                    </button>
                    <button type="button" onClick={() => toggleServiceStatus(sv.id)} aria-label={`${sv.isActive ? "Deactivate" : "Activate"} ${sv.name}`} aria-pressed={sv.isActive} style={{ width: 40, height: 20, padding: 0, border: "none", borderRadius: 10, background: sv.isActive ? "#059669" : "#e0e0ec", cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
                      <div style={{ position: "absolute", top: 2, left: sv.isActive ? 22 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                    </button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, borderTop: "1px solid #f8f8fc", borderBottom: "1px solid #f8f8fc", padding: "14px 0" }}>
                  <div>
                    <div style={{ fontSize: 10, color: "#9898b0", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em" }}>Price</div>
                    <div style={{ fontSize: 16, fontWeight: 900, color: "var(--accent)", marginTop: 4 }}>
                      {sv.variablePrice
                        ? (sv.priceRangeMin && sv.priceRangeMax ? `${fmt(sv.priceRangeMin)} - ${fmt(sv.priceRangeMax)}` : "Varies")
                        : fmt(sv.price)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#9898b0", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em" }}>Duration</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}><Clock size={13} color="#9898b0" />{sv.durationMin} min</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#9898b0", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10, display: "flex", alignItems: "center", gap: 4 }}>
                    <Users size={12} /> {sv.multiStylist ? "Stylist Team" : "Assigned Staff"} ({assigned.length})
                    {sv.multiStylist && (
                      <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", color: "#7C3AED", background: "#F5F3FF", padding: "2px 7px", borderRadius: 20, letterSpacing: "0.04em" }}>Team</span>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {assigned.length > 0 ? assigned.map((st) => (
                      <span key={st.id} style={{ fontSize: 11, fontWeight: 600, color: st.color, background: st.color + "12", padding: "3px 10px", borderRadius: 12 }}>{st.name}</span>
                    )) : <span style={{ fontSize: 12, color: "#9898b0", fontStyle: "italic", fontWeight: 500 }}>No staff assigned</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
