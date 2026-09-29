"use client";

/**
 * /dashboard/client-app
 *
 * Two staff-facing jobs in one place, because they're two halves of the same
 * loop: print the QR codes that put the client app in customers' hands, then
 * push offers to the customers who installed it.
 *
 * QR codes are rendered server-side (lib/qr.ts) and returned as base64 data
 * URLs, so the print sheet works with no third-party image host — the codes
 * still print if the salon's internet drops mid-job.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BellRing, Check, Copy, Download, Loader2, Plus, Printer,
  QrCode, Send, Smartphone, Trash2, Users, Wallet,
} from "lucide-react";
import PageTitle from "@/components/page-title";
import { Toggle } from "@/components/settings-sections";
import { saveSettings, settingsStore } from "@/lib/settings-store";

type QrType = "salon" | "station" | "booking" | "loyalty";

interface QrCard {
  key: string;
  type: QrType;
  targetId: string;
  label: string;
  dataUrl: string;
  targetUrl: string;
}

const QR_PRESETS: { type: QrType; label: string; hint: string }[] = [
  { type: "salon",    label: "Client App",    hint: "Service menu, offers opt-in and install prompt" },
  { type: "booking",  label: "Online Booking", hint: "Straight into the booking flow" },
  { type: "loyalty",  label: "Loyalty Card",   hint: "Claim or view a digital loyalty card" },
];

export default function ClientAppPage() {
  const [cards, setCards]   = useState<QrCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState("");
  const [copied, setCopied] = useState("");

  // Station (chair) codes
  const [stationInput, setStationInput] = useState("");
  const [addingStation, setAddingStation] = useState(false);

  // Push broadcast
  const [configured, setConfigured] = useState(false);
  const [subscribers, setSubscribers] = useState(0);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState("");

  const printRef = useRef<HTMLDivElement>(null);

  // ─── Fetch one QR code ─────────────────────────────────────────────────────
  const fetchQr = useCallback(async (type: QrType, targetId: string, label: string): Promise<QrCard | null> => {
    // "salon" is the sentinel the route uses for "no sub-target".
    const segment = encodeURIComponent(targetId || "salon");
    const res = await fetch(`/api/qr/${segment}?type=${type}&size=420`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      setError(data?.error ?? "Couldn't generate QR code.");
      return null;
    }
    return {
      key: `${type}:${targetId}`,
      type,
      targetId,
      label,
      dataUrl: data.dataUrl,
      targetUrl: data.targetUrl,
    };
  }, []);

  // ─── Initial load: the four standard codes + push status ───────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const results = await Promise.all(
        QR_PRESETS.map((p) => fetchQr(p.type, "", p.label)),
      );
      if (!cancelled) {
        setCards(results.filter((c): c is QrCard => c !== null));
        setLoading(false);
      }
    })();

    fetch("/api/notifications/broadcast")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d?.ok) return;
        setConfigured(Boolean(d.configured));
        setSubscribers(Number(d.subscribers ?? 0));
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [fetchQr]);

  // ─── Add a per-chair code ──────────────────────────────────────────────────
  async function addStation(event: React.FormEvent) {
    event.preventDefault();
    const id = stationInput.trim();
    if (!id) return;
    if (cards.some((c) => c.type === "station" && c.targetId === id)) {
      setError(`Station "${id}" already has a code.`);
      return;
    }

    setAddingStation(true);
    setError("");
    const card = await fetchQr("station", id, `Station ${id}`);
    if (card) {
      setCards((prev) => [...prev, card]);
      setStationInput("");
    }
    setAddingStation(false);
  }

  function removeCard(key: string) {
    setCards((prev) => prev.filter((c) => c.key !== key));
  }

  function copyLink(card: QrCard) {
    navigator.clipboard.writeText(card.targetUrl);
    setCopied(card.key);
    setTimeout(() => setCopied(""), 1600);
  }

  /**
   * Prints in a detached window rather than window.print() on the dashboard:
   * the sidebar, sticky headers and CSS variables here would otherwise all
   * land on the sheet.
   */
  function printSheet() {
    const win = window.open("", "_blank", "width=900,height=1000");
    if (!win) return;

    const tiles = cards.map((c) => `
      <figure>
        <img src="${c.dataUrl}" alt="${escapeHtml(c.label)} QR code" />
        <figcaption>
          <strong>${escapeHtml(c.label)}</strong>
          <span>${escapeHtml(c.targetUrl)}</span>
        </figcaption>
      </figure>
    `).join("");

    win.document.write(`
      <!doctype html><html><head><meta charset="utf-8" />
      <title>Salon QR Codes</title>
      <style>
        @page { size: A4; margin: 14mm; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; color: #1a1a2e; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        p.sub { font-size: 12px; color: #777790; margin: 0 0 20px; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        figure { break-inside: avoid; margin: 0; border: 1px solid #e3e0eb; border-radius: 12px;
                 padding: 16px; text-align: center; }
        img { width: 100%; max-width: 230px; height: auto; }
        figcaption { margin-top: 10px; }
        figcaption strong { display: block; font-size: 14px; }
        figcaption span { display: block; font-size: 9px; color: #9898b0; word-break: break-all; margin-top: 4px; }
      </style></head>
      <body>
        <h1>Scan to open our app</h1>
        <p class="sub">Point your phone camera at the code.</p>
        <div class="grid">${tiles}</div>
      </body></html>
    `);
    win.document.close();
    // Give the data-URL images a tick to decode before the print dialog opens.
    win.onload = () => { win.focus(); win.print(); };
  }

  // ─── Send a broadcast ──────────────────────────────────────────────────────
  async function sendBroadcast(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !message.trim()) return;

    setSending(true);
    setSendResult("");
    try {
      const res = await fetch("/api/notifications/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: message.trim(),
          url: linkUrl.trim() || undefined,
          tag: "salon-offer",
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setSendResult(data?.error ?? "Couldn't send the notification.");
      } else {
        const pruned = data.pruned ? `, ${data.pruned} expired device(s) removed` : "";
        setSendResult(`Sent to ${data.sent} device(s)${data.failed ? `, ${data.failed} failed` : ""}${pruned}.`);
        setTitle("");
        setMessage("");
        setLinkUrl("");
        setSubscribers((n) => Math.max(0, n - Number(data.pruned ?? 0)));
      }
    } catch {
      setSendResult("Couldn't reach the server.");
    }
    setSending(false);
  }

  return (
    <div className="dash-page dashboard-polish" style={{
      minHeight: "100vh", background: "#fff", padding: "28px 32px 48px",
      display: "flex", flexDirection: "column", gap: 20,
    }}>
      <PageTitle
        icon={<Smartphone size={24} />}
        title="Client App"
        subtitle="Print QR codes and send offers to customers who installed your app"
        right={
          <button onClick={printSheet} disabled={cards.length === 0} style={primaryBtn}>
            <Printer size={15} /> Print all codes
          </button>
        }
      />

      {error && (
        <div style={{ ...noticeStyle, background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca" }}>
          {error}
        </div>
      )}

      {/* ── Push broadcast ──────────────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--accent, #7C3AED)", fontSize: 12, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            <BellRing size={16} /> Push a message
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 750, color: "#6b6b8a" }}>
            <Users size={15} /> {subscribers} subscribed device{subscribers === 1 ? "" : "s"}
          </div>
        </div>

        {!configured && (
          <div style={{ ...noticeStyle, background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a", marginBottom: 14 }}>
            Push isn&apos;t configured yet. Generate a key pair with{" "}
            <code style={codeStyle}>npx web-push generate-vapid-keys</code>, add them as{" "}
            <code style={codeStyle}>VAPID_PUBLIC_KEY</code> and <code style={codeStyle}>VAPID_PRIVATE_KEY</code>, then redeploy.
          </div>
        )}

        <form onSubmit={sendBroadcast} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title — e.g. 20% off blow-dry this Friday"
            maxLength={80}
            style={inputStyle}
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message — keep it short; phones truncate long text."
            maxLength={300}
            rows={3}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
          />
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="Opens when tapped (optional) — e.g. /online-booking"
            style={inputStyle}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button
              type="submit"
              disabled={sending || !configured || subscribers === 0 || !title.trim() || !message.trim()}
              style={{
                ...primaryBtn,
                opacity: sending || !configured || subscribers === 0 || !title.trim() || !message.trim() ? 0.5 : 1,
              }}
            >
              {sending
                ? <><Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Sending…</>
                : <><Send size={15} /> Send to {subscribers} device{subscribers === 1 ? "" : "s"}</>}
            </button>
            {sendResult && <span style={{ fontSize: 13, fontWeight: 700, color: "#6b6b8a" }}>{sendResult}</span>}
          </div>
        </form>
      </section>

      <PaymentDetailsCard />

      {/* ── Station codes ───────────────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--accent, #7C3AED)", fontSize: 12, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
          <QrCode size={16} /> Per-chair codes
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "#777790", lineHeight: 1.6, maxWidth: 680 }}>
          Give each styling chair its own code so you know where a customer scanned from. The chair
          number rides along in the link as <code style={codeStyle}>?station=</code>.
        </p>
        <form onSubmit={addStation} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={stationInput}
            onChange={(e) => setStationInput(e.target.value)}
            placeholder="Chair or station name — e.g. 3, or Mirror A"
            maxLength={40}
            style={{ ...inputStyle, flex: "1 1 260px" }}
          />
          <button type="submit" disabled={addingStation || !stationInput.trim()} style={{ ...primaryBtn, opacity: addingStation || !stationInput.trim() ? 0.5 : 1 }}>
            {addingStation ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={15} />} Add code
          </button>
        </form>
      </section>

      {/* ── The codes ───────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: "grid", placeItems: "center", padding: 60 }}>
          <Loader2 size={26} color="#9898b0" style={{ animation: "spin 1s linear infinite" }} />
        </div>
      ) : (
        <div ref={printRef} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
          {cards.map((card) => {
            const preset = QR_PRESETS.find((p) => p.type === card.type);
            return (
              <div key={card.key} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12, alignItems: "center", textAlign: "center" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={card.dataUrl} alt={`${card.label} QR code`} width={190} height={190}
                  style={{ borderRadius: 12, border: "1px solid #f0eef6" }} />
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>{card.label}</div>
                  <div style={{ fontSize: 12, color: "#9898b0", marginTop: 4, lineHeight: 1.5 }}>
                    {preset?.hint ?? "Opens the client app with this chair pre-tagged"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                  <button onClick={() => copyLink(card)} style={smallBtn}>
                    {copied === card.key ? <Check size={13} /> : <Copy size={13} />}
                    {copied === card.key ? "Copied" : "Copy link"}
                  </button>
                  <a
                    href={`/api/qr/${encodeURIComponent(card.targetId || "salon")}?type=${card.type}&format=png&size=1000`}
                    download={`qr-${card.type}${card.targetId ? `-${card.targetId}` : ""}.png`}
                    style={{ ...smallBtn, textDecoration: "none" }}
                  >
                    <Download size={13} /> PNG
                  </a>
                  {card.type === "station" && (
                    <button onClick={() => removeCard(card.key)} style={{ ...smallBtn, color: "#dc2626" }}>
                      <Trash2 size={13} /> Remove
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 10.5, color: "#b4b2c6", wordBreak: "break-all" }}>{card.targetUrl}</div>
              </div>
            );
          })}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

interface PaymentSettings {
  payAtCounter: boolean;
  jazzcash:  { enabled: boolean; number: string; title: string };
  easypaisa: { enabled: boolean; number: string; title: string };
  bank:      { enabled: boolean; bankName: string; title: string; accountNumber: string; iban: string };
}

/**
 * The salon's own accounts, shown to customers in the client app's "Payment
 * options" and at the end of booking. Everything switched on here is public —
 * anyone with the app link can see it.
 */
function PaymentDetailsCard() {
  const [form, setForm] = useState<PaymentSettings>(() => structuredClone(settingsStore.payments as PaymentSettings));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  function set<K extends "jazzcash" | "easypaisa" | "bank">(method: K, patch: Partial<PaymentSettings[K]>) {
    setForm((f) => ({ ...f, [method]: { ...f[method], ...patch } }));
    setResult(null);
  }

  function problem(): string {
    if (form.jazzcash.enabled && !form.jazzcash.number.trim()) return "Add your JazzCash number, or switch JazzCash off.";
    if (form.easypaisa.enabled && !form.easypaisa.number.trim()) return "Add your EasyPaisa number, or switch EasyPaisa off.";
    if (form.bank.enabled && !form.bank.accountNumber.trim() && !form.bank.iban.trim())
      return "Add your bank account number or IBAN, or switch bank transfer off.";
    return "";
  }

  async function save() {
    const issue = problem();
    if (issue) { setResult({ ok: false, text: issue }); return; }
    setSaving(true);
    settingsStore.payments = structuredClone(form);
    const ok = await saveSettings();
    setSaving(false);
    setResult(ok
      ? { ok: true, text: "Saved — customers will see this in your app." }
      : { ok: false, text: "Saved on this device, but it didn't reach the server. Check your connection and save again." });
  }

  const row = (label: string, on: boolean, toggle: (v: boolean) => void, fields?: React.ReactNode, hint?: string) => (
    <div style={{ border: "1px solid #eeecf4", borderRadius: 14, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 750, color: "#1a1a2e" }}>{label}</div>
          {hint && <div style={{ fontSize: 12, color: "#9898b0", marginTop: 2 }}>{hint}</div>}
        </div>
        <Toggle value={on} onChange={toggle} />
      </div>
      {on && fields && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginTop: 12 }}>
          {fields}
        </div>
      )}
    </div>
  );

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--accent, #7C3AED)", fontSize: 12, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
        <Wallet size={16} /> Customer payments
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "#777790", lineHeight: 1.6, maxWidth: 680 }}>
        How customers can pay you. These show in your app under &ldquo;Payment options&rdquo; and when someone books.
        Anything switched on here is visible to anyone with your app link.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {row("Pay at counter / POS", form.payAtCounter,
          (v) => { setForm((f) => ({ ...f, payAtCounter: v })); setResult(null); },
          undefined, "Cash or card when they visit")}
        {row("JazzCash", form.jazzcash.enabled, (v) => set("jazzcash", { enabled: v }), <>
          <input value={form.jazzcash.number} onChange={(e) => set("jazzcash", { number: e.target.value })} placeholder="JazzCash number — e.g. 0300 1234567" style={inputStyle} />
          <input value={form.jazzcash.title} onChange={(e) => set("jazzcash", { title: e.target.value })} placeholder="Account title" style={inputStyle} />
        </>)}
        {row("EasyPaisa", form.easypaisa.enabled, (v) => set("easypaisa", { enabled: v }), <>
          <input value={form.easypaisa.number} onChange={(e) => set("easypaisa", { number: e.target.value })} placeholder="EasyPaisa number — e.g. 0345 1234567" style={inputStyle} />
          <input value={form.easypaisa.title} onChange={(e) => set("easypaisa", { title: e.target.value })} placeholder="Account title" style={inputStyle} />
        </>)}
        {row("Bank transfer", form.bank.enabled, (v) => set("bank", { enabled: v }), <>
          <input value={form.bank.bankName} onChange={(e) => set("bank", { bankName: e.target.value })} placeholder="Bank name — e.g. Meezan Bank" style={inputStyle} />
          <input value={form.bank.title} onChange={(e) => set("bank", { title: e.target.value })} placeholder="Account title" style={inputStyle} />
          <input value={form.bank.accountNumber} onChange={(e) => set("bank", { accountNumber: e.target.value })} placeholder="Account number" style={inputStyle} />
          <input value={form.bank.iban} onChange={(e) => set("bank", { iban: e.target.value })} placeholder="IBAN — e.g. PK36MEZN0000000000000000" style={inputStyle} />
        </>)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
        <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
          {saving ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={15} />} Save payment details
        </button>
        {result && (
          <span style={{ fontSize: 13, fontWeight: 700, color: result.ok ? "#047857" : "#dc2626" }}>{result.text}</span>
        )}
      </div>
    </section>
  );
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(226,223,235,.95)",
  borderRadius: 18,
  padding: 20,
  boxShadow: "0 8px 28px rgba(38,25,75,.04)",
};

const inputStyle: React.CSSProperties = {
  padding: "11px 14px", borderRadius: 12, border: "1px solid #e3e0eb",
  fontSize: 13.5, color: "#1a1a2e", fontFamily: "inherit", outline: "none", width: "100%",
};

const primaryBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 12,
  background: "var(--accent-gradient, #7C3AED)", color: "#fff", padding: "10px 18px",
  fontSize: 13, fontWeight: 800, cursor: "pointer",
};

const smallBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, padding: "7px 12px",
  borderRadius: 10, border: "1px solid #e3e0eb", background: "#fff",
  fontSize: 12, fontWeight: 750, color: "#6b6b8a", cursor: "pointer",
};

const noticeStyle: React.CSSProperties = {
  borderRadius: 12, padding: "12px 16px", fontSize: 13, lineHeight: 1.6,
};

const codeStyle: React.CSSProperties = {
  background: "rgba(0,0,0,.05)", padding: "1px 6px", borderRadius: 5, fontSize: 12,
};
