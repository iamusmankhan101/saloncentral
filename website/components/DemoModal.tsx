"use client";
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, User, Mail, Phone, Calendar, Loader2, CheckCircle, MessageCircle } from "lucide-react";
import styles from "./DemoModal.module.css";

// Same sales number as the site's "Contact Sales" links; the success screen opens a chat to it
// with the booking pre-typed.
const WHATSAPP_NUMBER = "923029646928";

function whatsAppLink(f: { name: string; email: string; phone: string; datetime: string }) {
  const when = f.datetime
    ? new Date(f.datetime).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })
    : "Any time";
  const text = [
    "Hi Salon Central! I'd like to book a demo 👋",
    "",
    `Name: ${f.name}`,
    `Phone: ${f.phone}`,
    `Email: ${f.email}`,
    `Preferred time: ${when}`,
  ].join("\n");
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function DemoModal({ open, onClose, onSuccess }: Props) {
  const [form, setForm]     = useState({ name: "", email: "", phone: "", datetime: "" });
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError]   = useState("");
  const [waLink, setWaLink] = useState("");
  const firstRef            = useRef<HTMLInputElement>(null);

  // focus first field on open
  useEffect(() => {
    if (open) {
      setStatus("idle");
      setError("");
      setTimeout(() => firstRef.current?.focus(), 100);
    }
  }, [open]);

  // close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const change = (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const submit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus("loading");
    setError("");

    // Client-side duplicate check via localStorage
    const stored: string[] = JSON.parse(localStorage.getItem("demoEmails") ?? "[]");
    if (stored.includes(form.email.toLowerCase().trim())) {
      setStatus("error");
      setError("This email has already been registered. We'll be in touch soon!");
      return;
    }

    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      localStorage.setItem("demoEmails", JSON.stringify([...stored, form.email.toLowerCase().trim()]));
      setWaLink(whatsAppLink(form));
      setStatus("success");
      onSuccess?.();
      setForm({ name: "", email: "", phone: "", datetime: "" });
    } catch (err: unknown) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>

        {/* close */}
        <button className={styles.close} onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        {status === "success" ? (
          <div className={styles.success}>
            <CheckCircle size={48} className={styles.successIcon} />
            <h2>Request Sent!</h2>
            <p>One last step: send us your booking on WhatsApp so we can confirm your demo time.</p>
            <a href={waLink} target="_blank" rel="noopener noreferrer" className={`btn ${styles.doneBtn} ${styles.waBtn}`}>
              <MessageCircle size={18} /> Send on WhatsApp
            </a>
          </div>
        ) : (
          <>
            <div className={styles.header}>
              <div className={styles.badge}>✦ Book a Demo</div>
              <h2 className={styles.title}>See Salon Central in Action</h2>
              <p className={styles.sub}>Fill in your details and we&apos;ll schedule a personalised demo for your salon.</p>
            </div>

            <form onSubmit={submit} className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>Full Name</label>
                <div className={styles.inputWrap}>
                  <User size={15} className={styles.inputIcon} />
                  <input
                    ref={firstRef}
                    name="name"
                    type="text"
                    placeholder="Amna Nawaz"
                    value={form.name}
                    onChange={change}
                    required
                    className={styles.input}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Email Address</label>
                <div className={styles.inputWrap}>
                  <Mail size={15} className={styles.inputIcon} />
                  <input
                    name="email"
                    type="email"
                    placeholder="amna@glowstudio.pk"
                    value={form.email}
                    onChange={change}
                    required
                    className={styles.input}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Phone Number</label>
                <div className={styles.inputWrap}>
                  <Phone size={15} className={styles.inputIcon} />
                  <input
                    name="phone"
                    type="tel"
                    placeholder="+92 300 1234567"
                    value={form.phone}
                    onChange={change}
                    required
                    className={styles.input}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Preferred Date & Time</label>
                <div className={styles.inputWrap}>
                  <Calendar size={15} className={styles.inputIcon} />
                  <input
                    name="datetime"
                    type="datetime-local"
                    value={form.datetime}
                    onChange={change}
                    required
                    className={styles.input}
                  />
                </div>
              </div>

              {status === "error" && (
                <p className={styles.errorMsg}>{error}</p>
              )}

              <button
                type="submit"
                disabled={status === "loading"}
                className={`btn btn-primary ${styles.submitBtn}`}
              >
                {status === "loading" ? (
                  <><Loader2 size={16} className={styles.spin} /> Sending…</>
                ) : (
                  "Book My Demo →"
                )}
              </button>
            </form>
          </>
        )}

      </div>
    </div>,
    document.body
  );
}
