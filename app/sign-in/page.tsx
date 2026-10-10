"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Eye, EyeOff, KeyRound, LockKeyhole, Mail, ShieldCheck, Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import styles from "../auth.module.css";

// Sign-in diagnostics (see lib/signin-log.ts). sendBeacon survives the page
// navigating away on success; fetch keepalive is the fallback.
function report(event: string, email?: string, detail?: string) {
  try {
    const body = JSON.stringify({ event, email, detail });
    if (!navigator.sendBeacon?.("/api/auth/signin-log", body)) {
      fetch("/api/auth/signin-log", { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch {
    /* diagnostics must never break sign-in */
  }
}

/**
 * Where to go after signing in, from ?next= — only this site's own paths (the
 * QR attendance page sends staff here and back), never another site.
 */
function safeNextPath(): string | null {
  if (typeof window === "undefined") return null;
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}

type SignedInUser = { id: string } & Record<string, unknown>;
type TwoFactorStep = { challengeId: string; method: "email" | "totp"; emailHint?: string };

/** Last step of every sign-in path: cache the user and load the dashboard. */
function finishSignIn(user: SignedInUser) {
  localStorage.setItem("werzio_auth_session", user.id);
  localStorage.setItem(`werzio_user_cache_${user.id}`, JSON.stringify(user));
  // Hard navigation, not router.replace: the dashboard is gated by an
  // httpOnly cookie checked in middleware.ts, and Next's client router
  // cache can still be holding the pre-login "redirected to /sign-in"
  // result for /dashboard from earlier in the session. A soft nav can
  // silently reuse that stale result; a full document load (same as a
  // manual refresh, which is why that "fixes" it) re-runs middleware
  // against the cookie that was just set.
  window.location.href = safeNextPath() ?? "/dashboard";
}

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [rateLocked, setRateLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verifiedMessage, setVerifiedMessage] = useState(false);
  const [portal, setPortal] = useState<"admin" | "staff">("admin");
  const [twoFactor, setTwoFactor] = useState<TwoFactorStep | null>(null);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    report("page_loaded");
    const onError = (e: ErrorEvent) => report("js_error", undefined, `${e.message} @ ${e.filename}:${e.lineno}`);
    const onRejection = (e: PromiseRejectionEvent) => report("js_error", undefined, String(e.reason));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    if (getCurrentUser()) router.replace(safeNextPath() ?? "/dashboard");

    queueMicrotask(() => {
      const params = new URLSearchParams(window.location.search);
      // Arriving from the attendance QR — that's always a staff login.
      if (safeNextPath()?.startsWith("/checkin/")) setPortal("staff");
      if (params.get("verified") === "true") setVerifiedMessage(true);
      // Arriving from Google sign-in: the password-free first step is done, the code step is next.
      const challenge = params.get("challenge");
      if (challenge) setTwoFactor({ challengeId: challenge, method: params.get("method") === "totp" ? "totp" : "email" });

      const oauthErr = params.get("error");
      if (oauthErr === "google_cancelled") setError("Google sign-in was cancelled.");
      else if (oauthErr === "account_pending") setError("Your account has been created and is waiting for admin approval.");
      else if (oauthErr === "account_rejected") setError("Your account request was not approved. Please contact Salon Central support.");
      else if (oauthErr === "account_frozen") setError("Your account has been frozen by Salon Central. Please contact support to resolve this.");
      else if (oauthErr === "twofa_failed") setError("We couldn't send your sign-in code. Please try again.");
      else if (oauthErr === "google_unverified_email") setError("Your Google account's email isn't verified. Verify it with Google, or sign in with your password.");
      else if (oauthErr) setError("Google sign-in failed. Please try again.");
      else if (params.get("expired") === "1") setError("Your session expired. Please sign in again to keep your data syncing.");
    });
  }, [router]);

  function handleSubmit() {
    report("button_pressed", email, rateLocked ? "rate_locked" : submitting ? "already_submitting" : undefined);
    if (rateLocked || submitting) return;
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setError("");
    setSubmitting(true);

    // Without a timeout, a slow or blocked connection leaves the button looking
    // dead — the user gets no feedback at all while the request hangs.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);

    fetch("/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password, portal }),
      signal: controller.signal,
    })
      .then(async res => {
        const data = await res.json().catch(() => ({ ok: false, error: `Server error (${res.status}). Please try again.` })) as { ok: boolean; error?: string; retryAfter?: number; user?: SignedInUser; twoFactor?: TwoFactorStep };
        if (!data.ok) {
          report("error", email, `${res.status}: ${data.error ?? ""}`);
          if (res.status === 429) {
            setRateLocked(true);
            setError(data.error || "Too many attempts. Please wait before trying again.");
            // Auto-unlock the button after retryAfter seconds
            if (data.retryAfter) {
              setTimeout(() => { setRateLocked(false); setError(""); }, data.retryAfter * 1000);
            }
          } else {
            setError(data.error || "Unable to sign in.");
          }
          setSubmitting(false);
          return;
        }
        if (data.twoFactor) {
          report("2fa_step", email, data.twoFactor.method);
          setTwoFactor(data.twoFactor);
          setPassword("");
          setSubmitting(false);
          return;
        }
        report("success", email);
        finishSignIn(data.user!);
      })
      .catch(err => {
        console.error("[sign-in] Error:", err);
        setSubmitting(false);
        const timedOut = err instanceof DOMException && err.name === "AbortError";
        report(timedOut ? "timeout" : "network_error", email, String(err));
        setError(
          err instanceof DOMException && err.name === "AbortError"
            ? "The server is taking too long to respond. Please check your internet connection (try mobile data or a VPN) and try again."
            : "Couldn't reach the server. Please check your internet connection and try again.",
        );
      })
      .finally(() => window.clearTimeout(timeout));
  }

  async function submitCode() {
    if (!twoFactor || submitting) return;
    if (code.replace(/\D/g, "").length !== 6) { setError("Enter the 6-digit code."); return; }
    setError(""); setNotice(""); setSubmitting(true);
    try {
      const res = await fetch("/api/auth/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", challengeId: twoFactor.challengeId, code }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "Server error. Please try again." })) as { ok: boolean; error?: string; user?: SignedInUser };
      if (!data.ok || !data.user) {
        setError(data.error || "That code isn't right.");
        setCode("");
        // An expired or used-up sign-in has to start again from the password.
        if (/sign in again/i.test(data.error ?? "")) setTwoFactor(null);
        setSubmitting(false);
        return;
      }
      report("success", email || undefined, "2fa");
      finishSignIn(data.user);
    } catch {
      setError("Couldn't reach the server. Please check your internet connection and try again.");
      setSubmitting(false);
    }
  }

  async function resendCode() {
    if (!twoFactor) return;
    setError(""); setNotice("");
    try {
      const res = await fetch("/api/auth/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resend", challengeId: twoFactor.challengeId }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) setNotice("A new code is on its way.");
      else setError(data.error || "Couldn't send a new code.");
    } catch {
      setError("Couldn't reach the server. Please try again.");
    }
  }

  function backToPassword() {
    setTwoFactor(null); setCode(""); setError(""); setNotice("");
    window.history.replaceState(null, "", window.location.pathname);
  }

  return (
    <main className={styles.authPage}>
      {/* Plain image request, so the visit is logged even if the page's JS never runs. */}
      <img src="/api/auth/signin-log?event=html_loaded" alt="" width={1} height={1} style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} />
      <div className={styles.authShell}>
        <section className={styles.brandPanel}>
          <div className={styles.brandTop}>
            <img src="/salon-central-logo.png" alt="Salon Central" />
          </div>

          <div className={styles.brandContent}>
            <div className={styles.eyebrow}>Salon OS</div>
            <h1 className={styles.headline}>Bookings, clients, staff, and revenue in one calm workspace.</h1>
            <p className={styles.supportingText}>Manage the day from your front desk or phone with a dashboard designed for busy beauty teams.</p>
            <div className={styles.brandStats}>
              <span className={styles.statPill}>WhatsApp booking</span>
              <span className={styles.statPill}>Client history</span>
              <span className={styles.statPill}>PKR reports</span>
            </div>
          </div>

          <div className={styles.brandBottom}>
            <div className={styles.miniCard}>
              <div className={styles.miniCardTitle}>Today at a glance</div>
              <div className={styles.miniCardText}>Appointments, stylists, and payments stay in sync.</div>
            </div>
          </div>
        </section>

        <section className={styles.formPanel}>
          <div className={styles.formCard}>
            {twoFactor ? (
              <>
                <div className={styles.formHeader}>
                  <h2 className={styles.formTitle}>Enter your code</h2>
                  <p className={styles.formSubtitle}>
                    {twoFactor.method === "totp"
                      ? "Open your authenticator app and enter the 6-digit code for Salon Central."
                      : `We emailed a 6-digit code to ${twoFactor.emailHint ?? "your email"}. It expires in 10 minutes.`}
                  </p>
                </div>
                <label className={styles.field}>
                  <span className={styles.label}>Sign-in code</span>
                  <div className={styles.inputWrap}>
                    <KeyRound size={16} className={styles.inputIcon} />
                    <input className={styles.input} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                      placeholder="123456" value={code} style={{ letterSpacing: "0.3em", fontWeight: 700 }}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      onKeyDown={(e) => e.key === "Enter" && submitCode()} />
                  </div>
                </label>
                {notice && <div style={{ fontSize: 13, color: "#059669", fontWeight: 600, marginBottom: 12 }}>{notice}</div>}
                {error && <div className={styles.error}>{error}</div>}
                <button type="button" onClick={submitCode} disabled={submitting} className={styles.primaryButton}
                  style={submitting ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                  {submitting ? "Checking…" : <><span>Verify &amp; sign in</span> <ArrowRight size={14} /></>}
                </button>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13 }}>
                  <button type="button" onClick={backToPassword} style={{ background: "none", border: "none", color: "#77738a", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: 0 }}>
                    <ArrowLeft size={14} /> Back
                  </button>
                  {twoFactor.method === "email" && (
                    <button type="button" onClick={resendCode} style={{ background: "none", border: "none", color: "#6d28d9", fontWeight: 700, cursor: "pointer", padding: 0 }}>
                      Resend code
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
            <div className={styles.formHeader}>
              <h2 className={styles.formTitle}>{portal === "admin" ? "Admin login" : "Staff login"}</h2>
              <p className={styles.formSubtitle}>
                {portal === "admin"
                  ? "Full access for salon owners and managers."
                  : "Sign in to your assigned salon workspace."}
              </p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: 4, borderRadius: 12, background: "#f3f0fa", marginBottom: 20 }}>
              {([
                { key: "admin", label: "Admin", Icon: ShieldCheck },
                { key: "staff", label: "Staff", Icon: Users },
              ] as const).map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setPortal(key); setError(""); }}
                  style={{
                    border: "none", borderRadius: 9, padding: "10px 12px", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                    background: portal === key ? "#fff" : "transparent",
                    color: portal === key ? "#6d28d9" : "#77738a",
                    fontWeight: 700, boxShadow: portal === key ? "0 2px 8px rgba(40,20,80,.08)" : "none",
                  }}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </div>

            {verifiedMessage && (
              <div style={{ padding: "12px 16px", borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0", marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#059669", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 12, color: "#fff" }}>✓</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#065f46", fontWeight: 600 }}>
                    Email verified successfully! You can now sign in.
                  </div>
                </div>
              </div>
            )}

            <label className={styles.field}>
              <span className={styles.label}>Email</span>
              <div className={styles.inputWrap}>
                <Mail size={16} className={styles.inputIcon} />
                <input className={styles.input} type="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
              </div>
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Password</span>
              <div className={styles.inputWrap}>
                <LockKeyhole size={16} className={styles.inputIcon} />
                <input className={`${styles.input} ${styles.passwordInput}`} type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
                <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"} className={styles.iconButton}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            {error && <div className={styles.error}>{error}</div>}

            <button type="button" onClick={handleSubmit} disabled={rateLocked || submitting} className={styles.primaryButton}
              style={rateLocked || submitting ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
              {rateLocked ? "Too many attempts — wait and retry" : submitting ? "Signing in…" : <><span>Sign in</span> <ArrowRight size={14} /></>}
            </button>

            <p className={styles.footerText}>
              New to Salon Central? <Link href="/sign-up" className={styles.footerLink}>Create an account</Link>
            </p>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
