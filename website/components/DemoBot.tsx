"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import DemoModal from "./DemoModal";
import styles from "./DemoBot.module.css";

const ASK = "Hey there! 👋 Want to book a free demo of Salon Central?";
const SENT = "🎉 Nearly there! Tap the green button to send it to us on WhatsApp 💬";
const DONE = "Thanks! We'll confirm your demo on WhatsApp soon 💜";
const LATER = "No worries — tap me whenever you're ready! 💜";
// Tip the bot gives while the visitor is in each DemoModal field (keyed by the input's name).
const HINTS: Record<string, string> = {
  name: "Awesome! First up — what's your name? 😊",
  email: "Now your email, so we can send the invite 📧",
  phone: "A phone number, so we can confirm your slot 📱",
  datetime: "Pick any time that suits you — we'll confirm it ⏰",
};

/** The little purple blob. Pupils follow the cursor via --ex/--ey CSS vars set on the button. */
function Mascot() {
  return (
    <svg viewBox="0 0 80 80" className={styles.mascotSvg} aria-hidden="true">
      <defs>
        <radialGradient id="demoBotBody" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="55%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#5b21b6" />
        </radialGradient>
      </defs>
      <line x1="40" y1="19" x2="45" y2="7" stroke="#8b5cf6" strokeWidth="3" strokeLinecap="round" />
      <circle cx="45" cy="6" r="4" fill="#a78bfa" className={styles.antennaTip} />
      <ellipse cx="13" cy="52" rx="5" ry="7" fill="#7c3aed" transform="rotate(30 13 52)" />
      <g className={styles.waveArm}>
        <ellipse cx="68" cy="32" rx="5" ry="8" fill="#8b5cf6" transform="rotate(-25 68 32)" />
      </g>
      <circle cx="40" cy="45" r="26" fill="url(#demoBotBody)" />
      <g className={styles.eyes}>
        <g className={styles.pupils}>
          <ellipse cx="31" cy="41" rx="3.4" ry="4.4" fill="#1e1036" />
          <ellipse cx="49" cy="41" rx="3.4" ry="4.4" fill="#1e1036" />
          <circle cx="32.2" cy="39.4" r="1.2" fill="#fff" />
          <circle cx="50.2" cy="39.4" r="1.2" fill="#fff" />
        </g>
      </g>
      <circle cx="25" cy="49" r="3" fill="#f9a8d4" opacity="0.6" />
      <circle cx="55" cy="49" r="3" fill="#f9a8d4" opacity="0.6" />
      <path d="M35 51 Q40 56 45 51" stroke="#1e1036" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export default function DemoBot() {
  const [text, setText] = useState(""); // "" = speech bubble hidden
  const [typed, setTyped] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const bookedRef = useRef(false);
  const botRef = useRef<HTMLButtonElement>(null);
  const chars = Array.from(text);

  function say(t: string) {
    setText(t);
    setTyped(0);
  }

  // Greet visitors shortly after they arrive — unless this browser already booked a demo.
  useEffect(() => {
    try {
      if (JSON.parse(localStorage.getItem("demoEmails") ?? "[]").length > 0) return;
    } catch { /* storage blocked: just greet */ }
    const t = setTimeout(() => say(ASK), 2000);
    return () => clearTimeout(t);
  }, []);

  // Typewriter effect.
  useEffect(() => {
    if (typed >= chars.length) return;
    const t = setTimeout(() => setTyped(typed + 1), 35);
    return () => clearTimeout(t);
  }, [typed, chars.length]);

  // After the form closes, the parting message fades away on its own.
  useEffect(() => {
    if (formOpen || (text !== DONE && text !== LATER)) return;
    const t = setTimeout(() => setText(""), 6000);
    return () => clearTimeout(t);
  }, [formOpen, text]);

  // Coach the visitor field by field while the demo form is open.
  useEffect(() => {
    if (!formOpen) return;
    function onFocus(e: FocusEvent) {
      const hint = HINTS[(e.target as HTMLInputElement).name];
      if (hint && !bookedRef.current) say(hint);
    }
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [formOpen]);

  // Eyes follow the cursor.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const el = botRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      el.style.setProperty("--ex", `${(dx / d) * 2.5}px`);
      el.style.setProperty("--ey", `${(dy / d) * 2.5}px`);
    }
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  function openForm() {
    bookedRef.current = false;
    setFormOpen(true);
    say(HINTS.name);
  }

  function closeForm() {
    if (!formOpen) return; // DemoModal's Escape listener fires even while it's closed
    setFormOpen(false);
    say(bookedRef.current ? DONE : LATER);
  }

  const showButtons = text === ASK && typed >= chars.length;

  return (
    <>
      <div className={`${styles.bot} ${formOpen ? styles.botOverForm : ""}`}>
        {text && (
          <div className={styles.speech}>
            <div className={styles.speechBody}>
              <span className={styles.srOnly} aria-live="polite">{text}</span>
              <span aria-hidden="true">
                {chars.slice(0, typed).join("")}
                {typed < chars.length && <span className={styles.caret} />}
              </span>
              {showButtons && (
                <div className={styles.actions}>
                  <button type="button" className={styles.yesBtn} onClick={openForm}>Yes, book my demo</button>
                  <button type="button" className={styles.laterBtn} onClick={() => setText("")}>Maybe later</button>
                </div>
              )}
            </div>
            {!formOpen && (
              <button type="button" className={styles.speechClose} onClick={() => setText("")} aria-label="Hide message">
                <X size={12} />
              </button>
            )}
            <span className={styles.thoughtDot1} />
            <span className={styles.thoughtDot2} />
          </div>
        )}
        <button
          type="button"
          ref={botRef}
          className={styles.mascot}
          onClick={() => (formOpen ? undefined : text === ASK ? openForm() : say(ASK))}
          aria-label="Book a free demo"
        >
          <Mascot />
        </button>
      </div>

      <DemoModal
        open={formOpen}
        onClose={closeForm}
        onSuccess={() => { bookedRef.current = true; say(SENT); }}
      />
    </>
  );
}
