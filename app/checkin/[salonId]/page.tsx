"use client";

/**
 * Staff self check-in, opened by scanning the attendance QR at reception
 * (see lib/attendance-checkin.ts). Signs the staff member in if needed, reads
 * the phone's location, and checks them in — or out, on the second scan.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, Clock, LogIn, LogOut, MapPin, AlertCircle, Loader2 } from "lucide-react";
import { time12 } from "@/lib/attendance-checkin";

interface Status {
  ok: boolean;
  error?: string;
  salonName?: string;
  signedIn?: boolean;
  staffName?: string;
  locationSet?: boolean;
  today?: { status: string; checkIn: string | null; checkOut: string | null } | null;
}

const STATUS_LABEL: Record<string, string> = { present: "Present", late: "Late", "half-day": "Half-day" };

// useSearchParams needs a Suspense boundary to build.
export default function CheckinPage() {
  return <Suspense fallback={null}><CheckinView /></Suspense>;
}

function CheckinView() {
  const { salonId } = useParams<{ salonId: string }>();
  const token = useSearchParams().get("t") ?? "";
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    fetch(`/api/attendance/checkin?s=${encodeURIComponent(salonId)}&t=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Status) => setStatus(d))
      .catch(() => setStatus({ ok: false, error: "Couldn't reach Salon Central. Check your internet and try again." }));
  }, [salonId, token]);
  useEffect(() => { load(); }, [load]);

  function getPosition(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("unsupported"));
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      let pos: GeolocationPosition;
      try {
        pos = await getPosition();
      } catch (err) {
        const denied = (err as GeolocationPositionError)?.code === 1;
        setMessage({ ok: false, text: denied
          ? "Location access is blocked. Allow location for this site in your browser settings, then try again."
          : "Couldn't get your location. Make sure Location / GPS is on and try again." });
        return;
      }
      const res = await fetch("/api/attendance/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ s: salonId, t: token, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      });
      const d = await res.json();
      if (!d.ok) { setMessage({ ok: false, text: d.error ?? "Check-in failed. Please try again." }); return; }
      setMessage({ ok: true, text: d.action === "in"
        ? `Checked in at ${time12(d.time)}${d.status === "late" ? " — marked Late" : ""}. Have a great day!`
        : `Checked out at ${time12(d.time)}. See you next time!` });
      setStatus((s) => (s ? { ...s, today: d.today } : s));
    } catch {
      setMessage({ ok: false, text: "Couldn't reach Salon Central. Check your internet and try again." });
    } finally {
      setBusy(false);
    }
  }

  const today = status?.today;
  const done = !!today?.checkIn && !!today?.checkOut;
  const nextAction: "in" | "out" = today?.checkIn ? "out" : "in";
  const signInHref = `/sign-in?next=${encodeURIComponent(`/checkin/${salonId}?t=${token}`)}`;

  return (
    <main style={{ minHeight: "100dvh", background: "linear-gradient(160deg,#5B21B6,#9333EA)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "inherit" }}>
      <div style={{ width: "100%", maxWidth: 420, background: "#fff", borderRadius: 24, padding: "28px 22px", boxShadow: "0 24px 60px rgba(0,0,0,0.25)", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, margin: "0 auto 14px", background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", color: "#7C3AED" }}>
          <Clock size={26} />
        </div>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#7C3AED", letterSpacing: "0.08em", textTransform: "uppercase" }}>Staff Attendance</div>
        <h1 style={{ margin: "6px 0 4px", fontSize: 22, fontWeight: 900, color: "#1a1a2e" }}>{status?.salonName ?? "Check in"}</h1>

        {!status ? (
          <div style={{ padding: 30, color: "#9898b0" }}><Loader2 size={22} className="spin" /></div>
        ) : !status.ok ? (
          <Notice ok={false} text={status.error ?? "This check-in code isn't valid."} />
        ) : !status.signedIn ? (
          <>
            <p style={{ color: "#6b6b8a", fontSize: 14, lineHeight: 1.5, margin: "10px 0 20px" }}>Sign in with your staff login to check in. You only need to do this once on this phone.</p>
            <a href={signInHref} style={primaryBtn}><LogIn size={18} /> Sign in to check in</a>
          </>
        ) : status.error ? (
          <Notice ok={false} text={status.error} />
        ) : (
          <>
            <div style={{ fontSize: 15, color: "#4a4a6a", marginBottom: 18 }}>Hi <strong style={{ color: "#1a1a2e" }}>{status.staffName}</strong></div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
              <TimeBox label="Checked in" value={today?.checkIn ? time12(today.checkIn) : "—"} sub={today?.checkIn ? STATUS_LABEL[today.status] : undefined} />
              <TimeBox label="Checked out" value={today?.checkOut ? time12(today.checkOut) : "—"} />
            </div>

            {message && <Notice ok={message.ok} text={message.text} />}

            {!done && (
              <button type="button" onClick={submit} disabled={busy || status.locationSet === false}
                style={{ ...primaryBtn, width: "100%", border: "none", cursor: busy ? "wait" : "pointer", opacity: busy || status.locationSet === false ? 0.7 : 1, background: nextAction === "out" ? "linear-gradient(135deg,#dc2626,#ef4444)" : primaryBtn.background }}>
                {busy ? <Loader2 size={18} className="spin" /> : nextAction === "in" ? <LogIn size={18} /> : <LogOut size={18} />}
                {busy ? "Checking your location…" : nextAction === "in" ? "Check in" : "Check out"}
              </button>
            )}
            {status.locationSet === false && <Notice ok={false} text="The salon hasn't set its location for check-in yet. Ask the owner to finish setup on the Attendance page." />}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: 11, color: "#9898b0", marginTop: 14 }}>
              <MapPin size={12} /> Your location is only used to confirm you&apos;re at the salon.
            </div>
          </>
        )}
      </div>
      <style>{`.spin { animation: ckspin 0.9s linear infinite; } @keyframes ckspin { to { transform: rotate(360deg); } }`}</style>
    </main>
  );
}

const primaryBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "15px 18px", borderRadius: 14,
  background: "linear-gradient(135deg,#5B21B6,#9333EA)", color: "#fff", fontSize: 16, fontWeight: 800, textDecoration: "none",
};

function TimeBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#faf9fd", border: "1px solid #ede9fe", borderRadius: 14, padding: "12px 10px" }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 900, color: "#1a1a2e", marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, fontWeight: 700, color: sub === "Late" ? "#d97706" : "#059669", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Notice({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div role={ok ? "status" : "alert"} style={{ display: "flex", gap: 8, alignItems: "flex-start", textAlign: "left", padding: "12px 14px", borderRadius: 12, margin: "6px 0 14px", fontSize: 13, fontWeight: 600, lineHeight: 1.45,
      background: ok ? "#ecfdf5" : "#fef2f2", color: ok ? "#047857" : "#b91c1c", border: `1px solid ${ok ? "#a7f3d0" : "#fecaca"}` }}>
      {ok ? <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />}
      <span>{text}</span>
    </div>
  );
}
