"use client";

/**
 * Owner setup for QR attendance check-in (see lib/attendance-checkin.ts): save
 * the salon's position, choose the allowed distance and the Late rule, and
 * print the code staff scan at reception.
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { MapPin, Printer, Download, RefreshCw, X, Check, AlertCircle } from "lucide-react";
import { settingsStore, saveSettings } from "@/lib/settings-store";
import { getCurrentUser } from "@/lib/auth";
import {
  DEFAULT_CHECKIN_RADIUS, DEFAULT_LATE_AFTER_MINUTES, newCheckinToken, type QrCheckinSettings,
} from "@/lib/attendance-checkin";

function currentConfig(): QrCheckinSettings | undefined {
  return (settingsStore.attendance as { qrCheckin?: QrCheckinSettings } | undefined)?.qrCheckin;
}

export default function QrCheckinSetup({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<QrCheckinSettings>(() => currentConfig() ?? {
    token: newCheckinToken(), radius: DEFAULT_CHECKIN_RADIUS, lateAfterMinutes: DEFAULT_LATE_AFTER_MINUTES,
  });
  const [qr, setQr] = useState("");
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const user = getCurrentUser();
  const salonId = user?.salonOwnerId || user?.id || "";
  const link = typeof window !== "undefined" ? `${window.location.origin}/checkin/${encodeURIComponent(salonId)}?t=${config.token}` : "";

  useEffect(() => {
    if (!link) return;
    QRCode.toDataURL(link, { width: 640, margin: 2, errorCorrectionLevel: "M", color: { dark: "#1a1a2e", light: "#ffffff" } })
      .then(setQr).catch(() => setQr(""));
  }, [link]);

  async function persist(next: QrCheckinSettings, okText: string) {
    setSaving(true);
    (settingsStore.attendance as Record<string, unknown>).qrCheckin = next;
    const ok = await saveSettings();
    setSaving(false);
    setConfig(next);
    setNotice(ok ? { ok: true, text: okText } : { ok: false, text: "Saved on this device, but it didn't reach the server. Check your internet and press Save again." });
  }

  function useThisLocation() {
    if (!navigator.geolocation) { setNotice({ ok: false, text: "This browser can't share its location." }); return; }
    setLocating(true);
    setNotice(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const accuracy = Math.round(pos.coords.accuracy);
        persist(
          { ...config, lat: pos.coords.latitude, lng: pos.coords.longitude },
          accuracy > 100
            ? `Location saved, but it's only accurate to about ${accuracy} m. For best results, do this on a phone with GPS on, inside the salon.`
            : `Salon location saved (accurate to about ${accuracy} m).`,
        );
      },
      (err) => {
        setLocating(false);
        setNotice({ ok: false, text: err.code === 1
          ? "Location access is blocked. Allow location for this site in your browser settings, then try again."
          : "Couldn't get this device's location. Turn on Location / GPS and try again." });
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }

  function printCode() {
    const w = window.open("", "_blank", "width=600,height=800");
    if (!w || !qr) return;
    const salon = String((settingsStore.salon as { name?: string })?.name ?? "");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Staff Check-in</title>
      <style>body{font-family:Arial,sans-serif;text-align:center;padding:40px}h1{margin:0 0 6px;font-size:30px}p{color:#555;font-size:16px;margin:6px 0}img{width:340px;height:340px;margin:24px 0}</style></head>
      <body><h1>Staff Check-in</h1><p>${salon.replace(/[<>&]/g, "")}</p><img src="${qr}" alt="Check-in QR" />
      <p><strong>Scan with your phone camera to check in and out.</strong></p><p>Sign in with your staff login the first time.</p>
      <script>window.onload=function(){window.print()}</script></body></html>`);
    w.document.close();
  }

  const located = config.lat != null && config.lng != null;
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 };
  const select: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid #e3e0eb", background: "#fff", fontSize: 13, color: "#1a1a2e" };
  const btn: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 14px", borderRadius: 10, border: "1px solid #e3e0eb", background: "#fff", color: "#4a4a6a", fontSize: 13, fontWeight: 700, cursor: "pointer", textDecoration: "none" };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 150 }}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: 520, maxWidth: "100%", maxHeight: "92dvh", overflowY: "auto", padding: "22px 22px 26px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: "#1a1a2e" }}>QR Check-in</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "#f5f5fa", borderRadius: 8, width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><X size={16} /></button>
        </div>
        <p style={{ fontSize: 13, color: "#6b6b8a", lineHeight: 1.5, margin: "0 0 18px" }}>
          Staff scan this code at reception with their phone to check in and out. Their phone must be at the salon, and they sign in with their own staff login (create these in Account → Roles &amp; Permissions).
        </p>

        {notice && (
          <div role={notice.ok ? "status" : "alert"} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 14, padding: "10px 12px", borderRadius: 10, fontSize: 12.5, fontWeight: 600,
            background: notice.ok ? "#ecfdf5" : "#fef2f2", color: notice.ok ? "#047857" : "#b91c1c" }}>
            {notice.ok ? <Check size={15} style={{ flexShrink: 0 }} /> : <AlertCircle size={15} style={{ flexShrink: 0 }} />} {notice.text}
          </div>
        )}
        {/* Step 1: location */}
        <div style={{ border: "1px solid #ede9fe", borderRadius: 14, padding: 14, marginBottom: 14, background: located ? "#fff" : "#faf9fd" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e", marginBottom: 4 }}>1. Salon location</div>
          <div style={{ fontSize: 12, color: located ? "#059669" : "#b45309", fontWeight: 600, marginBottom: 10 }}>
            {located ? "✓ Location saved" : "Not set — stand inside the salon and tap the button below."}
          </div>
          <button type="button" onClick={useThisLocation} disabled={locating || saving} style={{ ...btn, background: "var(--accent-gradient)", color: "#fff", border: "none" }}>
            <MapPin size={15} /> {locating ? "Getting location…" : located ? "Update to this device's location" : "Use this device's location"}
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
            <label style={{ display: "block" }}>
              <span style={label}>Allowed distance</span>
              <select value={config.radius} onChange={(e) => persist({ ...config, radius: Number(e.target.value) }, "Allowed distance saved.")} style={select}>
                {[50, 100, 200, 300, 500].map((m) => <option key={m} value={m}>Within {m} m</option>)}
              </select>
            </label>
            <label style={{ display: "block" }}>
              <span style={label}>Late if after opening +</span>
              <select value={config.lateAfterMinutes} onChange={(e) => persist({ ...config, lateAfterMinutes: Number(e.target.value) }, "Late rule saved.")} style={select}>
                {[0, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m === 0 ? "At opening time" : `${m} min after`}</option>)}
              </select>
            </label>
          </div>
        </div>

        {/* Step 2: the code */}
        <div style={{ border: "1px solid #ede9fe", borderRadius: 14, padding: 14, textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a2e", marginBottom: 10, textAlign: "left" }}>2. Print the code for reception</div>
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- local data: URL
            <img src={qr} alt="Staff check-in QR code" style={{ width: 220, height: 220, opacity: located ? 1 : 0.35 }} />
          ) : <div style={{ height: 220 }} />}
          {!located && <div style={{ fontSize: 12, color: "#b45309", fontWeight: 600, marginBottom: 8 }}>Set the salon location first — check-ins are refused until then.</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 6 }}>
            <button type="button" onClick={() => persist(config, "Check-in code saved.").then(printCode)} disabled={!qr} style={btn}><Printer size={15} /> Print</button>
            <a href={qr || undefined} download="staff-checkin-qr.png" onClick={() => { if (!currentConfig()) persist(config, "Check-in code saved."); }} style={btn}><Download size={15} /> Download</a>
            <button type="button" onClick={() => {
              if (window.confirm("Make a new code? Every printed copy of the current code will stop working.")) persist({ ...config, token: newCheckinToken() }, "New code created — print it and replace the old one.");
            }} style={{ ...btn, color: "#dc2626", borderColor: "#fecaca" }}><RefreshCw size={15} /> New code</button>
          </div>
        </div>

      </div>
    </div>
  );
}
