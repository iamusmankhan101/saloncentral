"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle, XCircle, Loader2, RefreshCw } from "lucide-react";

function VerifyEmailInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [state, setState] = useState<"loading" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [retrying, setRetrying] = useState(false);

  const verify = useCallback(async (isRetry = false) => {
    const token = params.get("token");
    if (!token) {
      setState("error");
      setErrorMsg("No verification token found in this link.");
      return;
    }

    if (isRetry) setRetrying(true);
    else setState("loading");

    try {
      const res = await fetch(`/api/verify-email?token=${encodeURIComponent(token)}`);

      // Log response details for debugging
      console.log("[verify-email] Response status:", res.status);
      console.log("[verify-email] Response headers:", Object.fromEntries(res.headers.entries()));

      // Guard: if response is not JSON (e.g. server is restarting), treat as retryable
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setState("error");
        setErrorMsg("Server is starting up — please wait a moment and try again.");
        setRetrying(false);
        return;
      }

      let data: { ok: boolean; email?: string; error?: string };
      try {
        data = await res.json();
        console.log("[verify-email] Response data:", data);
      } catch (jsonErr) {
        console.error("[verify-email] Failed to parse JSON:", jsonErr);
        setState("error");
        setErrorMsg("Invalid response from server. Please try again.");
        setRetrying(false);
        return;
      }

      if (!data.ok || !data.email) {
        setState("error");
        // Show the actual error message from the API
        setErrorMsg(data.error || "Verification failed. Please try again.");
        setRetrying(false);
        return;
      }

      // Verifying an email doesn't sign anyone in — the link could have been
      // opened by anyone holding it — so send them to sign in with a password.
      setState("success");
      setTimeout(() => router.replace("/sign-in?verified=true"), 2500);
    } catch (err) {
      console.error("[verify-email] fetch failed:", err);
      setState("error");
      setErrorMsg(`Could not reach the server: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure you're connected, then click Retry.`);
      setRetrying(false);
    }
  }, [params, router]);

  useEffect(() => { verify(); }, [verify]);

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f7f7fb", padding: 24 }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: "40px 36px", maxWidth: 420, width: "100%", textAlign: "center", boxShadow: "0 8px 40px rgba(0,0,0,0.08)", border: "1px solid #ebebf0" }}>

        {/* Real Salon Central logo */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
          <img src="/salon-central-logo.png" alt="Salon Central" style={{ height: 36, width: "auto" }} />
        </div>

        {state === "loading" && (
          <>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
              <Loader2 size={48} color="#7C3AED" style={{ animation: "spin 1s linear infinite" }} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Verifying your email…</div>
            <p style={{ fontSize: 13, color: "#9898b0" }}>Just a moment while we confirm your account.</p>
          </>
        )}

        {state === "success" && (
          <>
            <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#ecfdf5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <CheckCircle size={36} color="#059669" />
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#1a1a2e", marginBottom: 8 }}>Email verified!</div>
            <p style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 20 }}>Your account is now active. Taking you to your dashboard…</p>
            <div style={{ height: 4, borderRadius: 4, background: "#ebebf0", overflow: "hidden" }}>
              <div style={{ height: "100%", background: "linear-gradient(90deg,#5B21B6,#9333EA)", width: "100%", animation: "shrink 2.5s linear forwards" }} />
            </div>
          </>
        )}

        {state === "error" && (
          <>
            <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <XCircle size={36} color="#dc2626" />
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#1a1a2e", marginBottom: 8 }}>Verification failed</div>
            <p style={{ fontSize: 13, color: "#6b6b8a", marginBottom: 24 }}>{errorMsg}</p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Show different actions based on error type */}
              {errorMsg.includes("already been used") || errorMsg.includes("invalid") || errorMsg.includes("expired") ? (
                <>
                  <a
                    href="/sign-up"
                    style={{
                      display: "inline-block", padding: "12px 28px", borderRadius: 10,
                      background: "linear-gradient(135deg,#5B21B6,#9333EA)", color: "#fff",
                      fontWeight: 700, fontSize: 13, textDecoration: "none", width: "100%",
                      boxSizing: "border-box", textAlign: "center",
                    }}
                  >
                    Request new verification email
                  </a>
                  <a
                    href="/sign-in"
                    style={{
                      display: "inline-block", padding: "12px 28px", borderRadius: 10,
                      background: "#f4f5f7", color: "#6b6b8a",
                      fontWeight: 700, fontSize: 13, textDecoration: "none", width: "100%",
                      boxSizing: "border-box", textAlign: "center",
                    }}
                  >
                    Go to sign in
                  </a>
                </>
              ) : (
                <>
                  {/* Retry button — works for transient network/server errors */}
                  <button
                    onClick={() => verify(true)}
                    disabled={retrying}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      padding: "12px 28px", borderRadius: 10,
                      background: retrying ? "#e8e8f0" : "linear-gradient(135deg,#5B21B6,#9333EA)",
                      color: retrying ? "#aaaabc" : "#fff",
                      fontWeight: 700, fontSize: 13, border: "none", cursor: retrying ? "not-allowed" : "pointer",
                      width: "100%",
                    }}
                  >
                    <RefreshCw size={14} style={retrying ? { animation: "spin 1s linear infinite" } : {}} />
                    {retrying ? "Retrying…" : "Retry verification"}
                  </button>

                  <a
                    href="/sign-in"
                    style={{
                      display: "inline-block", padding: "12px 28px", borderRadius: 10,
                      background: "#f4f5f7", color: "#6b6b8a",
                      fontWeight: 700, fontSize: 13, textDecoration: "none", width: "100%",
                      boxSizing: "border-box", textAlign: "center",
                    }}
                  >
                    Go to sign in
                  </a>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes shrink  { from { transform-origin: left; transform: scaleX(1); } to { transform-origin: left; transform: scaleX(0); } }
      `}</style>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailInner />
    </Suspense>
  );
}