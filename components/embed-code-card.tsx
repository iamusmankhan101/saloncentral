"use client";

/**
 * "Embed on your website" — copy-paste code for salons with custom-coded sites
 * (the WordPress plugin does the same job for WordPress). The snippet frames the
 * booking page, which goes card-only when embedded, and resizes to fit using
 * the height/step messages the booking page posts (app/online-booking/booking-view.tsx).
 */

import { useState, type CSSProperties } from "react";

/** The booking link plus layout/colour, exactly what the WordPress plugin builds. */
export function embedSrc(url: string, layout: "list" | "grid", accent: string): string {
  const u = new URL(url);
  if (/^#[0-9a-f]{6}$/i.test(accent)) u.searchParams.set("accent", accent.slice(1).toLowerCase());
  if (layout === "grid") u.searchParams.set("layout", "grid");
  return u.toString();
}

export function embedCode(src: string): string {
  // Messages are only trusted from the address the form itself is loaded from.
  const origin = new URL(src).origin;
  return `<!-- Salon Central booking form -->
<iframe id="salon-central-booking"
  src="${src}"
  title="Book an appointment" loading="lazy"
  style="width:100%;height:900px;border:0;display:block"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  referrerpolicy="strict-origin-when-cross-origin"></iframe>
<script>
  // Resizes the form to fit, and scrolls it into view on each step.
  window.addEventListener("message", function (e) {
    if (e.origin !== "${origin}") return;
    var f = document.getElementById("salon-central-booking");
    if (!f || e.source !== f.contentWindow) return;
    var d = e.data || {}, h = Number(d.height);
    if (d.type === "salon-central:height" && isFinite(h) && h > 0) f.style.height = Math.min(Math.ceil(h), 20000) + "px";
    if (d.type === "salon-central:step" && d.step !== 1) { var t = f.getBoundingClientRect().top; if (t < 0) window.scrollBy({ top: t - 20, behavior: "smooth" }); }
  });
</script>`;
}

const chip = (active: boolean): CSSProperties => ({
  border: `1px solid ${active ? "#6d28d9" : "#e4e0ee"}`, background: active ? "#f5f3ff" : "#fff",
  color: active ? "#6d28d9" : "#29263d", borderRadius: 9, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
});

export default function EmbedCodeCard({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<"list" | "grid">("grid");
  const [useOwnColour, setUseOwnColour] = useState(false);
  const [colour, setColour] = useState("#7c3aed");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");

  if (!url) return null;
  const src = embedSrc(url, layout, useOwnColour ? colour : "");
  const code = embedCode(src);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ color: "#29263d", fontSize: 12, fontWeight: 800 }}>Embed on your website</div>
          <div style={{ fontSize: 12, color: "#9995ad", marginTop: 2 }}>Put the booking form on your own website — paste one piece of code. Using WordPress? Ask us for the plugin instead.</div>
        </div>
        <button type="button" onClick={() => setOpen(!open)} style={chip(open)}>
          {open ? "Hide" : "Get embed code"}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#6b6b8a", marginRight: 2 }}>Layout</span>
              <button type="button" style={chip(layout === "grid")} onClick={() => setLayout("grid")}>Grid (shorter)</button>
              <button type="button" style={chip(layout === "list")} onClick={() => setLayout("list")}>List</button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#6b6b8a", marginRight: 2 }}>Button colour</span>
              <button type="button" style={chip(!useOwnColour)} onClick={() => setUseOwnColour(false)}>Salon colour</button>
              <label style={{ ...chip(useOwnColour), display: "flex", alignItems: "center", gap: 6 }}>
                <input type="color" value={colour} aria-label="Button colour"
                  onChange={(e) => { setColour(e.target.value); setUseOwnColour(true); }}
                  style={{ width: 22, height: 18, border: "none", padding: 0, background: "none", cursor: "pointer" }} />
                Match my website
              </label>
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#6b6b8a" }}>Your code — give this to whoever builds your website</span>
              <button type="button" onClick={() => void copy()}
                style={{ border: "none", background: "#6d28d9", color: "#fff", borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                {copied === "ok" ? "Copied ✓" : "Copy code"}
              </button>
            </div>
            <textarea readOnly value={code} rows={9} onFocus={(e) => e.currentTarget.select()} aria-label="Embed code"
              style={{ width: "100%", boxSizing: "border-box", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5,
                lineHeight: 1.5, padding: 12, borderRadius: 10, border: "1px solid #e4e0ee", background: "#faf9fd", color: "#29263d", resize: "vertical" }} />
            {copied === "fail" && <div style={{ fontSize: 12, fontWeight: 700, color: "#dc2626", marginTop: 6 }}>Couldn&apos;t copy — click in the box, select all and copy it by hand.</div>}
            <div style={{ fontSize: 11.5, color: "#9995ad", marginTop: 6, lineHeight: 1.5 }}>
              Paste it where the form should appear: in your site&apos;s HTML, or an &ldquo;Embed&rdquo; / &ldquo;Custom code&rdquo; block on Wix, Squarespace, Webflow or Shopify.
            </div>
          </div>

          <div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#6b6b8a", marginRight: 2 }}>Preview</span>
              <button type="button" style={chip(device === "desktop")} onClick={() => setDevice("desktop")}>Desktop</button>
              <button type="button" style={chip(device === "mobile")} onClick={() => setDevice("mobile")}>Mobile</button>
            </div>
            <div style={{ background: "#f4f3f8", borderRadius: 12, padding: 12, display: "flex", justifyContent: "center" }}>
              <iframe key={src} src={src} title="Booking form preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{ width: device === "mobile" ? 375 : "100%", maxWidth: "100%", height: 560, border: "1px solid #e4e0ee", borderRadius: device === "mobile" ? 24 : 10, background: "#fff" }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
