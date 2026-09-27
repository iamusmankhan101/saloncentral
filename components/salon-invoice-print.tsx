"use client";

import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Printer, CheckCircle, Pencil, MessageSquare } from "lucide-react";
import { ADVANCE_NON_REFUNDABLE_NOTE, PAYMENT_NON_REFUNDABLE_NOTE, balanceDue, advancePercent, invoiceItemsByPerson, invoiceTimeLabel, type SalonInvoice } from "@/lib/salon-invoices";
import { settingsStore } from "@/lib/settings-store";
import SalonCentralWordmark from "@/components/salon-central-wordmark";
import { fmtCurrency as fmt } from "@/lib/format";
import { rasterizeLogoForThermal } from "@/lib/escpos-raster";

/**
 * An amount with its currency word in a span of its own, so the 80mm rules can
 * hide the currency inside the items table without touching the totals.
 */
function Money({ n }: { n: number }) {
  const s = fmt(n);
  const gap = s.indexOf(" ");
  if (gap < 0) return <>{s}</>;
  return <><span className="sip-cur">{s.slice(0, gap)} </span>{s.slice(gap + 1)}</>;
}

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-PK", {
    year: "numeric", month: "long", day: "numeric",
  });
}

const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", jazzcash: "JazzCash", easypaisa: "EasyPaisa",
  raast: "Raast", card: "Card", bank: "Bank Transfer", "": "—",
};

const PRINT_STYLES = `
  @media print {
    body > *:not(#salon-invoice-portal) { display: none !important; }
    #salon-invoice-portal {
      display: block !important; position: fixed !important;
      inset: 0 !important; background: #fff !important;
      z-index: 99999 !important; overflow: visible !important;
    }
    .sip-overlay  { background: transparent !important; padding: 0 !important; overflow: visible !important; }
    .sip-no-print { display: none !important; }
    .sip-sheet    { border-radius: 0 !important; box-shadow: none !important; max-width: 100% !important; width: 100% !important; margin: 0 !important; }
    @page { size: A4 portrait; margin: 18mm 16mm; }
  }
`;

/**
 * The page box for a roll print, in mm — the printer's *printable* window, not
 * the 80mm of paper. Handing the driver the full 80mm made it shrink-to-fit the
 * page down onto what the head can actually reach and then align the scaled
 * block inside that window rather than on the paper, so two equal gutters
 * printed as unequal margin. Sized to the window instead, the mapping is 1:1 and
 * the gutters below are the only margin there is, which is what keeps the block
 * centred on the roll.
 *
 * Raising this past the head's real reach brings the shrink-to-fit back: 76mm
 * was tried on the Speed-X and printed off-centre again, which puts the real
 * window at the 72mm an 80mm roll is normally specified for. Don't raise it
 * without a test print to compare.
 */
const RECEIPT_WIDTH_MM = 72;
/** Left/right margin inside the page box. Equal by construction — see above. */
const RECEIPT_GUTTER_MM = 3;

/**
 * 80mm roll layout for a USB/driver-attached thermal printer (Speed-X SP-200u
 * and friends), where the ESC/POS-over-TCP path doesn't apply — there is no IP
 * to send to, so the receipt goes out through the OS print driver instead.
 *
 * The sheet's own spacing is set inline, so every override here needs
 * !important to win. The A4 sheet lays its header, party details, totals and
 * footer out in side-by-side columns, which cannot survive a 72mm roll — two
 * 20mm columns break "SI-2026-0004" and "8 September 2026" mid-word — so the
 * blocks below are collapsed into a single stacked column for the receipt.
 *
 * The rules are built from one template because they are needed in two places:
 * inside @media print for the actual output, and on screen for a single
 * synchronous measurement of how tall the receipt comes out (see
 * measureReceiptHeightMm) — the page box has to be given that height, and the
 * print-only copy is invisible to any measurement.
 */
function receiptLayoutRules(scope: string): string {
  return `
    ${scope} .sip-sheet { width: ${RECEIPT_WIDTH_MM}mm !important; max-width: ${RECEIPT_WIDTH_MM}mm !important; margin: 0 auto !important; font-size: 11px !important; line-height: 1.35 !important; border-radius: 0 !important; box-shadow: none !important; }
    /* The single padded wrapper inside the sheet — A4 margins would eat the roll.
       The page box is already the printable window (see RECEIPT_WIDTH_MM), so
       these two gutters are the whole of the left/right margin and have to stay
       equal: anything asymmetric here prints visibly off-centre on the roll. */
    ${scope} .sip-sheet > div { padding: 0 ${RECEIPT_GUTTER_MM}mm !important; }
    /* The A4 header carries 48px of air below it and the sheet used to add 3mm
       above it; on a roll that lands under the printer's own ~20mm feed gap and
       reads as a blank top third, so the salon name starts at the first line. */
    ${scope} .sip-sheet .sip-head { margin-top: 0 !important; }
    /* overflow-wrap:anywhere so a long email or address breaks instead of
       overflowing the roll — word-break alone leaves unbroken tokens hanging. */
    ${scope} .sip-sheet * { font-size: 11px !important; letter-spacing: 0 !important; overflow-wrap: anywhere !important; }

    /* ── Ink ───────────────────────────────────────────────────────────────────
       The head burns one dot value — there is no grey. The A4 sheet's #555
       body text, #aaa placeholders and #e8e8e8 hairlines are all dithered down
       to a scatter of dots, which is what reads as weak, patchy ink on the
       roll (and fades further as the paper ages). Everything is pushed to pure
       black and to bold: at 11px on a 72mm roll a regular weight is one dot
       column per stem, so a single cold or worn head element drops out of the
       letter. print-color-adjust keeps the browser from lightening any of it
       back on the way to the driver, and font-smoothing:none stops the
       antialiased grey fringe that prints as a ragged edge. */
    ${scope} .sip-sheet, ${scope} .sip-sheet * {
      color: #000 !important;
      font-weight: 700 !important;
      border-color: #000 !important;
      opacity: 1 !important;
      text-shadow: none !important;
      -webkit-font-smoothing: none !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    /* The one thing that must stay white, or the whole receipt inverts. */
    ${scope} .sip-sheet { background: #fff !important; }
    /* The amounts are what the customer checks, so they keep the extra weight
       the A4 sheet gives them rather than flattening into the rule above. */
    ${scope} .sip-sheet .sip-totals-box, ${scope} .sip-sheet .sip-totals-box * { font-weight: 800 !important; }
    /* Headings stay only slightly larger, so the salon name still reads first. */
    ${scope} .sip-sheet h1, ${scope} .sip-sheet h2, ${scope} .sip-sheet .sip-biz { font-size: 13px !important; font-weight: 800 !important; }
    /* ── Invoice number ────────────────────────────────────────────────────
       Promoted into the header and given the only type size on the receipt
       larger than the salon name, because it is what both sides quote when a
       sale is queried. The meta-table row it duplicates is dropped rather than
       printed twice — 72mm of paper does not have room to say it twice. */
    ${scope} .sip-sheet .sip-invno { display: block !important; font-size: 14px !important; font-weight: 800 !important; margin-top: 1.5mm !important; letter-spacing: 0.04em !important; }
    ${scope} .sip-sheet .sip-invno-row { display: none !important; }

    /* ── Salon logo ────────────────────────────────────────────────────────
       The A4 sheet hangs the logo to the right of the salon name at 90px tall.
       On a 72mm roll that is most of the column, and beside the name rather
       than above it, so the receipt header is rebuilt here: the block centres
       and reverses (the logo is the second child in the DOM, so column-reverse
       lifts it above the name without touching the A4 markup).
       Capped in mm because what matters is how much paper it costs — 18mm of
       an 80mm roll, before a single line of the sale.
       The filter binarises the mark to solid black, because the head has one
       dot value and no grey: anything in between is dithered into a speckle,
       which is what made the logo print washed out. CSS has no threshold
       filter, so this builds one — brightness(0.5543) scales the cut point onto
       contrast's pivot (0.5 / 0.5543 = 0.902 = 230/255) and contrast(10000%)
       then drives everything below it to black and everything above it to
       white, with a transition band about two levels wide. 230 is the same
       BLACK_THRESHOLD the ESC/POS path uses (lib/escpos-raster.ts), so the two
       thermal paths render the same logo identically — change one and change
       the other. The cut sits near white because salon logos are fine line art
       in light brand tones: at a 170 cut, a thin gold ring and the lettering
       inside it fell above the threshold and printed as a broken circle around
       an empty middle. */
    ${scope} .sip-sheet .sip-head {
      display: flex !important;
      flex-direction: column-reverse !important;
      align-items: center !important;
      text-align: center !important;
      margin-bottom: 8px !important;
    }
    ${scope} .sip-sheet .sip-logo {
      display: block !important;
      width: auto !important;
      height: auto !important;
      max-width: 40mm !important;
      max-height: 20mm !important;
      object-fit: contain !important;
      margin: 0 auto 2mm !important;
      filter: grayscale(1) brightness(0.5543) contrast(10000%) !important;
    }
    /* The stand-in for a missing logo stays hidden: it is a 90px solid-black
       disc, which on thermal is ~24mm of pure burn for two initials the salon
       name repeats on the very next line. */
    ${scope} .sip-sheet .sip-logo-fallback { display: none !important; }
    /* The wordmark's own image is sized in percentages of this wrapper, so
       shrinking the wrapper scales the mark with it — but only while the 104:51
       ratio holds, otherwise the crop inside slips. Sized in mm because what
       matters is how much of the roll it takes: 14mm, and the height follows. */
    ${scope} .sip-sheet .sip-foot [aria-label="Salon Central"] { width: 14mm !important; height: 6.87mm !important; }
    /* Every side-by-side block becomes one stacked column. (.sip-head is stacked
       too, but by the flex rule above — it needs the logo lifted above the name,
       and a display:block here would silently win and put it back beside.) */
    ${scope} .sip-sheet .sip-parties,
    ${scope} .sip-sheet .sip-totals,
    ${scope} .sip-sheet .sip-foot { display: block !important; margin-bottom: 8px !important; }
    ${scope} .sip-sheet .sip-parties > div + div { margin-top: 8px !important; }
    /* The totals box is a fixed 280px (~74mm) pinned right on A4. */
    ${scope} .sip-sheet .sip-totals-box { width: 100% !important; }
    ${scope} .sip-sheet table { width: 100% !important; table-layout: fixed !important; }
    ${scope} .sip-sheet td, ${scope} .sip-sheet th { padding: 2px 0 !important; word-break: break-word !important; }

    /* ── Items table ───────────────────────────────────────────────────────
       The A4 header cells are nowrap, which on a roll made "Unit Price" spill
       out of its cell and collide with its neighbours ("QtyUnit Price Amount").
       Widths are absolute rather than percentages because the three numeric
       columns need a known number of digits, not a share of the paper: at 17%
       each the amounts wrapped to "PKR" / "30,000" on two lines. */
    ${scope} .sip-sheet .sip-items th,
    ${scope} .sip-sheet .sip-items td { white-space: normal !important; padding: 3px 0 !important; vertical-align: top !important; }
    /* The tint is on the row, not the cells, so clearing only the cells left the
       band showing through behind them — and a flat grey has to be dithered,
       which prints as the same speckle the greys above were causing. */
    ${scope} .sip-sheet .sip-items th,
    ${scope} .sip-sheet .sip-items thead tr { background: transparent !important; }
    ${scope} .sip-sheet .sip-items th:nth-child(1),
    ${scope} .sip-sheet .sip-items td:nth-child(1) { width: auto !important; padding-right: 2mm !important; }
    ${scope} .sip-sheet .sip-items th:nth-child(2),
    ${scope} .sip-sheet .sip-items td:nth-child(2) { width: 7mm !important; }
    ${scope} .sip-sheet .sip-items th:nth-child(3),
    ${scope} .sip-sheet .sip-items td:nth-child(3) { width: 14mm !important; }
    ${scope} .sip-sheet .sip-items th:nth-child(4),
    ${scope} .sip-sheet .sip-items td:nth-child(4) { width: 15mm !important; }
    ${scope} .sip-sheet .sip-items th:not(:first-child),
    ${scope} .sip-sheet .sip-items td:not(:first-child) { padding-left: 1.5mm !important; }
    /* One currency word per line costs ~9mm of a 72mm roll and repeats on every
       row; the totals below still carry it, which is where it is read. */
    ${scope} .sip-sheet .sip-items .sip-cur { display: none !important; }
  `;
}

/**
 * Kept in the document at all times but inert: it only bites while the portal
 * carries .sip-measuring, which is added and removed inside one synchronous
 * block, so the 80mm state is never painted to the screen.
 */
const RECEIPT_MEASURE_STYLES = receiptLayoutRules(".sip-measuring");

/**
 * `size` takes one or two lengths, or the bare keyword `auto` — never a length
 * paired with `auto`. The original `size: 80mm auto` was therefore invalid, was
 * dropped, and left `size: A4 portrait` above still in force, which is what
 * printed a 72mm strip down the left edge of an A4 page. `auto` alone is valid
 * but only defers to the destination's own paper, so a Save-as-PDF still came
 * out A4. Naming both lengths is what actually produces a receipt-shaped page,
 * and the height has to be measured because a fixed one would feed (and on a
 * continuous roll, waste) the same length of paper for every sale.
 */
function receiptPrintStyles(pageHeightMm: number): string {
  return `
  @media print {
    @page { size: ${RECEIPT_WIDTH_MM}mm ${pageHeightMm}mm; margin: 0; }
    html, body { width: ${RECEIPT_WIDTH_MM}mm !important; margin: 0 !important; padding: 0 !important; background: #fff !important; }
    #salon-invoice-portal { position: static !important; width: ${RECEIPT_WIDTH_MM}mm !important; }
${receiptLayoutRules("")}
  }
`;
}

/** CSS px are 1/96in by definition, and an inch is 25.4mm. */
const PX_PER_MM = 96 / 25.4;
/** Blank tail so the last line clears the cutter, and a floor for tiny sales.
 *  Kept short: the printer already feeds ~20mm past the head to reach the tear
 *  bar, and that feed reads as blank paper at the top of the next receipt. */
const RECEIPT_TAIL_MM = 3;
const MIN_RECEIPT_MM = 60;
/** Used only if the sheet cannot be found — a long page beats a clipped one. */
const FALLBACK_RECEIPT_MM = 297;

interface Props {
  invoice: SalonInvoice;
  salonName: string;
  salonPhone: string;
  /** Accepted but not printed — invoices show the phone as the contact. */
  salonEmail?: string;
  salonAddress: string;
  onClose: () => void;
  onMarkPaid?: () => void;
  onEdit?: () => void;
  onSendWhatsApp?: () => void;
  sendingWhatsApp?: boolean;
}

export default function SalonInvoicePrint({
  invoice, salonName, salonPhone, salonAddress,
  onClose, onMarkPaid, onEdit, onSendWhatsApp, sendingWhatsApp,
}: Props) {
  const [mounted, setMounted]           = useState(false);
  const [thermalStatus, setThermalStatus] = useState<"idle" | "printing" | "ok" | "error">("idle");
  // Which stylesheet the next window.print() should use. Reset afterwards so the
  // browser's own Print command still produces the full-page A4 invoice.
  const [printMode, setPrintMode] = useState<"a4" | "receipt">("a4");
  // Height of the page box for the next receipt print, measured just before it.
  const [receiptPageMm, setReceiptPageMm] = useState(FALLBACK_RECEIPT_MM);
  const [thermalError, setThermalError]   = useState("");

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  const itemGroups = invoiceItemsByPerson(invoice);
  const isPaid   = invoice.status === "paid";
  const isAdvance = invoice.status === "partial";
  const logo     = (settingsStore.salon as { logo?: string }).logo || "";
  const initials = salonName.split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const printer  = settingsStore.printer as { enabled: boolean; ip: string; port: number; paperWidthMm?: number };

  async function thermalPrint() {
    if (!printer.ip) {
      setThermalError("No printer IP set. Go to Settings → Thermal Printer.");
      setThermalStatus("error");
      return;
    }
    setThermalStatus("printing");
    setThermalError("");
    try {
      const paperWidthMm = printer.paperWidthMm || 80;
      // Rasterized here rather than in the route because the logo is a data URL
      // in whatever format the salon uploaded, and only the browser can decode
      // it. Returns null for "no logo" and for "logo wouldn't decode" alike —
      // both simply print a receipt without a mark.
      const logoRaster = logo ? await rasterizeLogoForThermal(logo, paperWidthMm) : null;
      const res = await fetch("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          printerIp: printer.ip,
          printerPort: printer.port || 9100,
          paperWidthMm,
          logo: logoRaster ?? undefined,
          salonName,
          salonPhone,
          salonAddress,
          currency: "PKR",
          invoice,
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Print failed");
      setThermalStatus("ok");
      setTimeout(() => setThermalStatus("idle"), 3000);
    } catch (e: unknown) {
      setThermalError(e instanceof Error ? e.message : "Print failed");
      setThermalStatus("error");
    }
  }

  /**
   * How tall this receipt is once it is laid out at 80mm, so the page box can
   * be sized to it. The receipt rules live inside @media print, where nothing
   * on screen can measure them, so the portal is flipped into the same layout
   * via .sip-measuring just long enough to read it back. getBoundingClientRect
   * forces the layout synchronously, so the class is on and off again within a
   * single frame and the narrow state never reaches the screen.
   */
  function measureReceiptHeightMm(): number {
    const portal = document.getElementById("salon-invoice-portal");
    const sheet = portal?.querySelector(".sip-sheet") as HTMLElement | null;
    if (!portal || !sheet) return FALLBACK_RECEIPT_MM;

    portal.classList.add("sip-measuring");
    const heightPx = sheet.getBoundingClientRect().height;
    portal.classList.remove("sip-measuring");

    if (!heightPx) return FALLBACK_RECEIPT_MM;
    return Math.max(MIN_RECEIPT_MM, Math.ceil(heightPx / PX_PER_MM) + RECEIPT_TAIL_MM);
  }

  // The <style> swap has to be committed to the DOM before the (synchronous)
  // print dialog opens, so this waits a paint rather than calling print() inline.
  function printReceipt80mm() {
    setReceiptPageMm(measureReceiptHeightMm());
    setPrintMode("receipt");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.print();
      setPrintMode("a4");
    }));
  }

  const content = (
    <div id="salon-invoice-portal">
      {/* The measure rules stay mounted in both modes — printReceipt80mm reads
          the 80mm height back before it can switch printMode. */}
      <style>{(printMode === "receipt" ? PRINT_STYLES + receiptPrintStyles(receiptPageMm) : PRINT_STYLES) + RECEIPT_MEASURE_STYLES}</style>

      <div
        className="sip-overlay"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", overflowY: "auto" }}
      >
        <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Toolbar */}
          <div className="sip-no-print" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", opacity: 0.9 }}>{invoice.number} · {invoice.clientName}</span>
            <div style={{ display: "flex", gap: 8 }}>
              {(invoice.status === "unpaid" || invoice.status === "partial") && onMarkPaid && (
                <button onClick={e => { e.stopPropagation(); onMarkPaid(); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "1px solid #6ee7b7", background: "rgba(5,150,105,0.25)", fontSize: 12, fontWeight: 700, color: "#6ee7b7", cursor: "pointer" }}>
                  <CheckCircle size={13} /> {invoice.status === "partial" ? `Collect ${fmt(balanceDue(invoice))}` : "Mark Paid"}
                </button>
              )}
              {printer.enabled && (
                <button onClick={thermalPrint} disabled={thermalStatus === "printing"}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", fontSize: 12, fontWeight: 700, cursor: "pointer",
                    background: thermalStatus === "ok" ? "rgba(5,150,105,0.35)" : thermalStatus === "error" ? "rgba(220,38,38,0.35)" : "rgba(124,58,237,0.35)",
                    color: "#fff", opacity: thermalStatus === "printing" ? 0.6 : 1,
                  }}>
                  <Printer size={14} />
                  {thermalStatus === "printing" ? "Printing…" : thermalStatus === "ok" ? "Sent!" : thermalStatus === "error" ? "Failed" : "Thermal Print"}
                </button>
              )}
              {thermalStatus === "error" && thermalError && (
                <span style={{ fontSize: 11, color: "#fca5a5", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={thermalError}>
                  {thermalError}
                </span>
              )}
              {onSendWhatsApp && (
                <button onClick={e => { e.stopPropagation(); onSendWhatsApp(); }} disabled={sendingWhatsApp}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.15)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: sendingWhatsApp ? "default" : "pointer", opacity: sendingWhatsApp ? 0.6 : 1 }}>
                  <MessageSquare size={14} /> {sendingWhatsApp ? "Sending…" : "Send WhatsApp"}
                </button>
              )}
              {onEdit && (
                <button onClick={e => { e.stopPropagation(); onEdit(); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.15)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                  <Pencil size={14} /> Edit
                </button>
              )}
              <button onClick={printReceipt80mm}
                title="Print an 80mm roll receipt through the printer's own driver — use this for a USB thermal printer"
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 9, border: "1px solid #d8d8e4", background: "#fff", color: "#4a4a6a", fontSize: 12.5, fontWeight: 750, cursor: "pointer" }}>
                <Printer size={14} /> Print 80mm Receipt
              </button>
              <button onClick={() => window.print()}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.15)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                <Printer size={14} /> Print / Save PDF
              </button>
              <button type="button" onClick={onClose} aria-label="Close invoice"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.15)", cursor: "pointer" }}>
                <X size={16} color="#fff" />
              </button>
            </div>
          </div>

          {/* Invoice Sheet */}
          <div className="sip-sheet" style={{ background: "#fff", borderRadius: 4, boxShadow: "0 24px 80px rgba(0,0,0,0.3)", fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>
            <div style={{ padding: "48px 52px" }}>

              {/* ── HEADER: Company left, Logo right ── */}
              <div className="sip-head" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 48 }}>
                <div>
                  <div className="sip-biz" style={{ fontSize: 16, fontWeight: 800, color: "#111", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>{salonName}</div>
                  <div style={{ fontSize: 12, color: "#555", lineHeight: 2 }}>
                    {salonAddress && <div>{salonAddress}</div>}
                    {salonPhone   && <div>{salonPhone}</div>}
                  </div>
                  {/* Receipt only — on a roll the invoice number belongs in the
                      header, not eight lines down in the meta table. Hidden
                      inline so A4 and the on-screen sheet are unchanged; the
                      80mm rules switch it on (a CSS !important beats inline). */}
                  <div className="sip-invno" style={{ display: "none" }}>{invoice.number}</div>
                </div>

                {/* Logo */}
                {logo ? (
                  <img className="sip-logo" src={logo} alt={salonName} style={{ height: 90, maxWidth: 160, objectFit: "contain" }} />
                ) : (
                  <div className="sip-logo-fallback" style={{ width: 90, height: 90, borderRadius: "50%", background: "#111", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 28, fontWeight: 900, color: "#fff", letterSpacing: "-1px" }}>{initials}</span>
                  </div>
                )}
              </div>

              {/* ── BILL TO / INVOICE ── */}
              <div className="sip-parties" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginBottom: 40 }}>
                {/* Bill To */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#111", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Bill To</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 4 }}>{invoice.clientName}</div>
                  <div style={{ fontSize: 12, color: "#555", lineHeight: 1.9 }}>
                    {invoice.clientPhone && <div>{invoice.clientPhone}</div>}
                  </div>
                </div>

                {/* Invoice details */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#111", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Invoice</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <tbody>
                      {[
                        ["Invoice No:", invoice.number],
                        ["Issue Date:", [fmtDate(invoice.date), invoiceTimeLabel(invoice)].filter(Boolean).join(", ")],
                        ...(invoice.staffName ? [["Stylist:", invoice.staffName]] : []),
                        ["Payment:", METHOD_LABELS[invoice.paymentMethod ?? ""] ?? "—"],
                        ["Status:", isPaid ? "PAID" : isAdvance ? "ADVANCE PAID" : "UNPAID"],
                      ].map(([label, value]) => (
                        <tr key={label} className={label === "Invoice No:" ? "sip-invno-row" : undefined}>
                          <td style={{ padding: "3px 0", color: "#555", width: "45%" }}>{label}</td>
                          <td style={{ padding: "3px 0", color: "#111", fontWeight: 600, textAlign: "right" }}>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── ITEMS TABLE ── */}
              <table className="sip-items" style={{ width: "100%", borderCollapse: "collapse", marginBottom: 28 }}>
                <thead>
                  <tr style={{ background: "#f0f0f0", borderTop: "1px solid #ccc", borderBottom: "1px solid #ccc" }}>
                    {["Description", "Qty", "Unit Price", "Amount"].map((h, i) => (
                      <th key={h} style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, color: "#111", textTransform: "capitalize", letterSpacing: "0.03em", textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {itemGroups.map((group, gi) => (
                    <Fragment key={group.name ?? `g${gi}`}>
                      {/* One bill covering several people gets a heading per person. */}
                      {group.name && (
                        <tr>
                          <td colSpan={4} style={{ padding: "12px 12px 6px", fontSize: 11, fontWeight: 800, color: "#111", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                            {group.name}{gi === 0 ? " (main)" : ""}
                          </td>
                        </tr>
                      )}
                      {group.items.map((item) => (
                        <tr key={item.id} style={{ borderBottom: "1px solid #e8e8e8" }}>
                          <td style={{ padding: "11px 12px", fontSize: 12, color: "#111" }}>
                            {item.description}
                            {item.dayBreakdown?.map((d) => (
                              <div key={d.label} style={{ fontSize: 11, color: "#666", marginTop: 3 }}>
                                {d.label} — <Money n={d.amount} />
                              </div>
                            ))}
                          </td>
                          <td style={{ padding: "11px 12px", fontSize: 12, color: "#555", textAlign: "right" }}>{item.qty}</td>
                          <td style={{ padding: "11px 12px", fontSize: 12, color: "#555", textAlign: "right" }}><Money n={item.unitPrice} /></td>
                          <td style={{ padding: "11px 12px", fontSize: 12, color: "#111", fontWeight: 600, textAlign: "right" }}><Money n={item.total} /></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  {invoice.items.length === 0 && (
                    <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", fontSize: 12, color: "#aaa" }}>No items</td></tr>
                  )}
                </tbody>
              </table>

              {/* ── TOTALS ── */}
              <div className="sip-totals" style={{ display: "flex", justifyContent: "flex-end", marginBottom: 40 }}>
                <div className="sip-totals-box" style={{ width: 280 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: "#555", borderBottom: "1px solid #e8e8e8" }}>
                    <span style={{ fontWeight: 600 }}>Subtotal</span><span style={{ fontWeight: 700, color: "#111" }}>{fmt(invoice.subtotal)}</span>
                  </div>
                  {invoice.taxAmount > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: "#555", borderBottom: "1px solid #e8e8e8" }}>
                      <span>Tax</span><span>{fmt(invoice.taxAmount)}</span>
                    </div>
                  )}
                  {invoice.discountAmount > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: "#555", borderBottom: "1px solid #e8e8e8" }}>
                      <span>Discount</span><span>−{fmt(invoice.discountAmount)}</span>
                    </div>
                  )}
                  {(invoice.discount2Amount ?? 0) > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: "#555", borderBottom: "1px solid #e8e8e8" }}>
                      <span>Discount 2</span><span>−{fmt(invoice.discount2Amount!)}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", fontSize: 14, borderTop: "2px solid #111", marginTop: 4 }}>
                    <span style={{ fontWeight: 800, color: "#111" }}>Total</span>
                    <span style={{ fontWeight: 900, color: "#111" }}>{fmt(invoice.total)}</span>
                  </div>
                  {isAdvance && (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13, color: "#555" }}>
                        <span>Advance paid ({advancePercent(invoice)}%)</span><span style={{ fontWeight: 700 }}>{fmt(invoice.advanceAmount ?? 0)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13, color: "#b45309" }}>
                        <span style={{ fontWeight: 800 }}>Balance due</span>
                        <span style={{ fontWeight: 900 }}>{fmt(balanceDue(invoice))}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {isAdvance && (
                <div style={{ marginBottom: 24, fontSize: 12, fontWeight: 800, color: "#b45309" }}>
                  {ADVANCE_NON_REFUNDABLE_NOTE}
                </div>
              )}

              {/* ── PAYMENT STATUS ── */}
              {isPaid && invoice.paymentMethod && (
                <div style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 12, color: "#059669", fontWeight: 700 }}>✓ Paid via {METHOD_LABELS[invoice.paymentMethod] ?? invoice.paymentMethod}</div>
                </div>
              )}

              {/* ── NOTES ── */}
              {invoice.notes && (
                <div style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#111", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Notes</div>
                  <div style={{ fontSize: 12, color: "#555", lineHeight: 1.8 }}>{invoice.notes}</div>
                </div>
              )}

              {/* ── TERMS ── */}
              <div style={{ marginBottom: 36 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#111", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Terms</div>
                <div style={{ fontSize: 12, color: "#555", lineHeight: 1.8 }}>
                  Payment is due upon receipt. Thank you for your business!
                  <br />
                  <strong style={{ color: "#111" }}>{PAYMENT_NON_REFUNDABLE_NOTE}</strong>
                  {salonPhone && <>
                    <br />
                    For queries, contact us at {salonPhone}.
                  </>}
                </div>
              </div>

              {/* ── FOOTER ── */}
              <div className="sip-foot" style={{ borderTop: "1px solid #e0e0e0", paddingTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 12, color: "#555" }}>
                  Thank you for visiting <strong style={{ color: "#111" }}>{salonName}</strong>!
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, color: "#aaa" }}>Powered by</span>
                  <SalonCentralWordmark compact />
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
