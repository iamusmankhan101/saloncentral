"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import styles from "../auth.module.css";

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

  useEffect(() => {
    if (getCurrentUser()) router.replace("/dashboard");

    queueMicrotask(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("verified") === "true") setVerifiedMessage(true);

      const oauthErr = params.get("error");
      if (oauthErr === "google_cancelled") setError("Google sign-in was cancelled.");
      else if (oauthErr === "account_pending") setError("Your account has been created and is waiting for admin approval.");
      else if (oauthErr === "account_rejected") setError("Your account request was not approved. Please contact Salon Central support.");
      else if (oauthErr === "account_frozen") setError("Your account has been frozen by Salon Central. Please contact support to resolve this.");
      else if (oauthErr === "google_unverified_email") setError("Your Google account's email isn't verified. Verify it with Google, or sign in with your password.");
      else if (oauthErr) setError("Google sign-in failed. Please try again.");
      else if (params.get("expired") === "1") setError("Your session expired. Please sign in again to keep your data syncing.");
    });
  }, [router]);

  function handleSubmit() {
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
        const data = await res.json().catch(() => ({ ok: false, error: `Server error (${res.status}). Please try again.` })) as { ok: boolean; error?: string; retryAfter?: number; user?: { id: string } & Record<string, unknown> };
        if (!data.ok) {
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
        localStorage.setItem("werzio_auth_session", data.user!.id);
        localStorage.setItem(`werzio_user_cache_${data.user!.id}`, JSON.stringify(data.user));
        // Hard navigation, not router.replace: the dashboard is gated by an
        // httpOnly cookie checked in middleware.ts, and Next's client router
        // cache can still be holding the pre-login "redirected to /sign-in"
        // result for /dashboard from earlier in the session. A soft nav can
        // silently reuse that stale result; a full document load (same as a
        // manual refresh, which is why that "fixes" it) re-runs middleware
        // against the cookie that was just set.
        window.location.href = "/dashboard";
      })
      .catch(err => {
        console.error("[sign-in] Error:", err);
        setSubmitting(false);
        setError(
          err instanceof DOMException && err.name === "AbortError"
            ? "The server is taking too long to respond. Please check your internet connection (try mobile data or a VPN) and try again."
            : "Couldn't reach the server. Please check your internet connection and try again.",
        );
      })
      .finally(() => window.clearTimeout(timeout));
  }

  return (
    <main className={styles.authPage}>
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
          </div>
        </section>
      </div>
    </main>
  );
}
