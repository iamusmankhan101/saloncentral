"use client";

/**
 * Two-step sign-in card (lib/two-factor.ts) for Account → Security and Settings → Security.
 * Owners and admins only; renders nothing for staff.
 *   - On/Off switch. Off needs a code (emailed, or from the app), so a stolen session can't do it.
 *   - While on: email codes (default) or an authenticator app.
 */

import { useEffect, useState, type CSSProperties } from "react";

type Status = { available: boolean; enabled?: boolean; method?: "email" | "totp" };

const inp: CSSProperties = {
  width: 140, padding: "9px 12px", borderRadius: 10, border: "1px solid #e3e0eb", fontSize: 14,
  letterSpacing: "0.3em", fontWeight: 700, outline: "none", color: "#1a1a2e", background: "#fff",
};

export default function TwoStepSignIn() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [mode, setMode] = useState<"idle" | "turning-off" | "to-email">("idle");
  const [offChallenge, setOffChallenge] = useState<{ challengeId: string; method: "email" | "totp" } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    fetch("/api/auth/2fa/setup", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => d.ok && setStatus(d))
      .catch(() => {});
  }, []);

  async function call(body: Record<string, string>) {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/auth/2fa/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) setError(data.error || "Something went wrong.");
      return data.ok ? data : null;
    } catch {
      setError("Couldn't reach the server.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function reset(message = "") {
    setMode("idle"); setOffChallenge(null); setSetup(null); setCode(""); setError(""); setDone(message);
  }

  async function toggle() {
    if (busy || !status) return;
    setDone("");
    if (!status.enabled) {
      const d = await call({ action: "enable" });
      if (d) { setStatus({ available: true, enabled: true, method: d.method }); reset("Two-step sign-in is on."); }
      return;
    }
    // Turning off: get a code first (emailed now, or read from the app).
    const d = await call({ action: "disable-start" });
    if (d) { setOffChallenge({ challengeId: d.challengeId, method: d.method }); setMode("turning-off"); setCode(""); }
  }

  if (!status?.available) return null;
  const on = !!status.enabled;
  const usingApp = status.method === "totp";
  const btn = (primary: boolean): CSSProperties => ({
    padding: "9px 16px", borderRadius: 10, border: primary ? "none" : "1px solid #e3e0eb", fontSize: 13, fontWeight: 700,
    background: primary ? "#7c3aed" : "#fff", color: primary ? "#fff" : "#6b6b8a", cursor: busy ? "not-allowed" : "pointer",
  });
  const codeInput = (
    <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} autoFocus
      aria-label="6-digit code" onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={inp} />
  );

  return (
    <div style={{ padding: 18, borderRadius: 14, border: `1px solid ${on ? "#ddd6fe" : "#e4e4ee"}`, background: on ? "#faf8ff" : "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Two-step sign-in</div>
          <div style={{ fontSize: 12.5, color: "#6b6b8a", marginTop: 4, lineHeight: 1.5 }}>
            {!on
              ? "Off — anyone with your password can sign in. Turn it on to also ask for a code."
              : usingApp
                ? "On — you enter a code from your authenticator app every time you sign in."
                : "On — we email you a 6-digit code every time you sign in."}
          </div>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-label="Two-step sign-in" onClick={toggle} disabled={busy || mode !== "idle"}
          style={{ width: 46, height: 26, borderRadius: 999, border: "none", padding: 3, flexShrink: 0, cursor: busy || mode !== "idle" ? "not-allowed" : "pointer",
            background: on ? "#7c3aed" : "#d4d4de", transition: "background .15s" }}>
          <span style={{ display: "block", width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.2)",
            transform: on ? "translateX(20px)" : "none", transition: "transform .15s" }} />
        </button>
      </div>

      {done && <div style={{ marginTop: 12, fontSize: 13, color: "#059669", fontWeight: 600 }}>{done}</div>}

      {mode === "turning-off" && offChallenge && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: "#4a4a6a", lineHeight: 1.6 }}>
          {offChallenge.method === "totp"
            ? "To turn it off, enter the current code from your authenticator app:"
            : "To turn it off, enter the 6-digit code we just emailed you:"}
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {codeInput}
            <button type="button" style={btn(true)} disabled={busy || code.length !== 6}
              onClick={async () => {
                const d = await call({ action: "disable-confirm", challengeId: offChallenge.challengeId, code });
                if (d) { setStatus({ ...status, enabled: false }); reset("Two-step sign-in is off."); }
              }}>
              {busy ? "Checking…" : "Turn off"}
            </button>
            <button type="button" style={btn(false)} disabled={busy} onClick={() => reset()}>Cancel</button>
          </div>
        </div>
      )}

      {on && mode === "idle" && !usingApp && !setup && (
        <button type="button" style={{ ...btn(false), marginTop: 14 }} disabled={busy}
          onClick={async () => { setDone(""); const d = await call({ action: "start" }); if (d) { setSetup({ qr: d.qr, secret: d.secret }); setCode(""); } }}>
          Use an authenticator app instead
        </button>
      )}

      {on && setup && (
        <div style={{ marginTop: 14, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL QR code */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={160} height={160} style={{ borderRadius: 10, background: "#fff", border: "1px solid #eee" }} />
          <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: "#4a4a6a", lineHeight: 1.6 }}>
            1. Scan this with Google Authenticator, Microsoft Authenticator or similar.<br />
            Can&apos;t scan? Enter this key: <code style={{ fontWeight: 700, wordBreak: "break-all" }}>{setup.secret}</code><br />
            2. Type the 6-digit code the app shows:
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              {codeInput}
              <button type="button" style={btn(true)} disabled={busy || code.length !== 6}
                onClick={async () => { const d = await call({ action: "confirm", code }); if (d) { setStatus({ ...status, method: "totp" }); reset("Authenticator app is set up — use it next time you sign in."); } }}>
                {busy ? "Checking…" : "Use this app"}
              </button>
              <button type="button" style={btn(false)} disabled={busy} onClick={() => reset()}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {on && usingApp && mode === "idle" && (
        <button type="button" style={{ ...btn(false), marginTop: 14 }} onClick={() => { setMode("to-email"); setDone(""); setCode(""); }}>
          Switch back to email codes
        </button>
      )}
      {on && mode === "to-email" && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: "#4a4a6a" }}>
          Enter the current code from your authenticator app to confirm:
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {codeInput}
            <button type="button" style={btn(true)} disabled={busy || code.length !== 6}
              onClick={async () => { const d = await call({ action: "use-email", code }); if (d) { setStatus({ ...status, method: "email" }); reset("Switched to email codes."); } }}>
              {busy ? "Checking…" : "Switch to email"}
            </button>
            <button type="button" style={btn(false)} disabled={busy} onClick={() => reset()}>Cancel</button>
          </div>
        </div>
      )}

      {error && <div style={{ marginTop: 10, fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{error}</div>}
    </div>
  );
}
