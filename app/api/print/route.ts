/**
 * POST /api/print
 * Sends an ESC/POS receipt to a LAN thermal printer via TCP (port 9100).
 * Body: { invoice, salonName, salonPhone, salonAddress, printerIp, printerPort? }
 */

import { NextRequest } from "next/server";
import * as net from "net";
import { resolveActor } from "@/lib/api-auth";

// ── ESC/POS helpers ────────────────────────────────────────────────────────────

const ESC = 0x1b;
const GS  = 0x1d;

const CMD = {
  init:        Buffer.from([ESC, 0x40]),
  alignLeft:   Buffer.from([ESC, 0x61, 0x00]),
  alignCenter: Buffer.from([ESC, 0x61, 0x01]),
  alignRight:  Buffer.from([ESC, 0x61, 0x02]),
  boldOn:      Buffer.from([ESC, 0x45, 0x01]),
  boldOff:     Buffer.from([ESC, 0x45, 0x00]),
  /**
   * Double-strike: the head passes the same line twice. Stacked on top of the
   * emphasis that is now on for the whole receipt (see buildReceipt), it is
   * what separates a heading from the body once every line is already bold —
   * and it is the darkest a line gets without doubling its size.
   */
  heavyOn:     Buffer.from([ESC, 0x47, 0x01]),
  heavyOff:    Buffer.from([ESC, 0x47, 0x00]),
  doubleOn:    Buffer.from([GS,  0x21, 0x11]),  // double width + height
  doubleOff:   Buffer.from([GS,  0x21, 0x00]),
  cut:         Buffer.from([GS,  0x56, 0x00]),  // full cut
  lf:          Buffer.from([0x0a]),
};

function text(s: string): Buffer {
  return Buffer.from(s + "\n", "utf8");
}

/**
 * GS v 0 — print a raster bit image. The bitmap arrives already sized,
 * thresholded and packed by the browser (see lib/escpos-raster.ts); all this
 * does is put the width and height in front of it, each as a low/high byte
 * pair. Width is counted in BYTES and height in DOT ROWS, which is the detail
 * worth remembering: passing dots where bytes are expected prints a garbled
 * band eight times too wide and then eats the rest of the receipt as image
 * data.
 */
function rasterImage(widthBytes: number, height: number, bitmap: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([GS, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff]),
    bitmap,
  ]);
}

/** Guards against a malformed or oversized bitmap wedging the print head. */
const MAX_LOGO_BYTES = 120_000;

function logoBuffer(logo: ReceiptData["logo"]): Buffer | null {
  if (!logo?.base64 || !logo.widthBytes || !logo.height) return null;
  if (!Number.isInteger(logo.widthBytes) || !Number.isInteger(logo.height)) return null;
  if (logo.widthBytes < 1 || logo.widthBytes > 72 || logo.height < 1 || logo.height > 2047) return null;

  let bitmap: Buffer;
  try {
    bitmap = Buffer.from(logo.base64, "base64");
  } catch {
    return null;
  }
  // The printer reads exactly widthBytes * height bytes and treats whatever
  // follows as more image data, so a short buffer doesn't print a clipped logo
  // — it swallows the invoice text into the bitmap.
  const expected = logo.widthBytes * logo.height;
  if (bitmap.length !== expected || expected > MAX_LOGO_BYTES) return null;
  return rasterImage(logo.widthBytes, logo.height, bitmap);
}

function divider(char = "-", len = 32): Buffer {
  return text(char.repeat(len));
}

function padLine(left: string, right: string, width = 32): Buffer {
  const gap = Math.max(1, width - left.length - right.length);
  return text(left + " ".repeat(gap) + right);
}

/** Greedy word wrap, so fixed sentences fit whatever paper is loaded. */
function wrap(sentence: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of sentence.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Characters per line at ESC/POS Font A, by paper width. 58mm paper fits 32
 * characters and 80mm fits 48. This used to be hard-coded to 32 under a comment
 * claiming it was the 80mm figure, so every 80mm receipt printed half-width.
 */
const CHARS_PER_LINE: Record<number, number> = { 58: 32, 80: 48 };
const DEFAULT_PAPER_MM = 80;

function buildReceipt(data: ReceiptData): Buffer {
  const W = CHARS_PER_LINE[data.paperWidthMm ?? DEFAULT_PAPER_MM] ?? CHARS_PER_LINE[DEFAULT_PAPER_MM];
  const chunks: Buffer[] = [];
  const push = (...bufs: Buffer[]) => chunks.push(...bufs);

  // ── Header ────────────────────────────────────────────────────────────────
  push(CMD.init);
  /**
   * Emphasis stays on from here to the cut. Font A at regular weight is a
   * single dot column per stem, which on a head that is cold, worn, or fed
   * cheap paper prints grey and patchy — the "low ink" look, except there is no
   * ink. Bold lays a second column against each stem, so a dropped element
   * thins a character instead of erasing it. ESC @ above clears this, so it has
   * to be set after the init, not before.
   */
  push(CMD.boldOn);
  push(CMD.alignCenter);
  // The mark goes above the name, and only if it survived validation — a salon
  // with no logo, or one whose bitmap didn't arrive intact, still gets a
  // receipt that starts cleanly at the salon name.
  const logo = logoBuffer(data.logo);
  if (logo) push(logo, CMD.lf);
  push(CMD.heavyOn, CMD.doubleOn);
  push(text(data.salonName.toUpperCase()));
  push(CMD.doubleOff, CMD.heavyOff);

  if (data.salonAddress) push(text(data.salonAddress));
  if (data.salonPhone)   push(text(`Tel: ${data.salonPhone}`));

  push(CMD.lf);
  push(divider("=", W));

  // ── Invoice meta ──────────────────────────────────────────────────────────
  push(CMD.alignLeft);
  push(CMD.heavyOn, text(`Invoice: ${data.invoice.number}`), CMD.heavyOff);
  push(text(`Date   : ${data.invoice.date}${receiptTime(data.invoice) ? `  ${receiptTime(data.invoice)}` : ""}`));
  push(text(`Client : ${data.invoice.clientName}`));
  if (data.invoice.clientPhone) push(text(`Phone  : ${data.invoice.clientPhone}`));
  if (data.invoice.staffName)   push(text(`Staff  : ${data.invoice.staffName}`));

  push(divider("-", W));

  // ── Items ──────────────────────────────────────────────────────────────────
  push(CMD.heavyOn, padLine("ITEM", "TOTAL", W), CMD.heavyOff);
  push(divider("-", W));

  // One bill covering several people prints a heading per person.
  let currentPerson: string | null = null;
  const splitByPerson = data.invoice.items.some((i) => i.guestName?.trim());
  for (const item of data.invoice.items) {
    if (splitByPerson) {
      const person = item.guestName?.trim() || data.invoice.clientName;
      if (person !== currentPerson) {
        currentPerson = person;
        push(CMD.heavyOn);
        for (const line of wrap(person.toUpperCase(), W)) push(text(line));
        push(CMD.heavyOff);
      }
    }
    const label = item.qty > 1 ? `${item.description} x${item.qty}` : item.description;
    const price  = `${data.currency} ${item.total.toFixed(0)}`;
    // Wrap long labels
    if (label.length > W - price.length - 1) {
      push(text(label));
      push(CMD.alignRight, text(price), CMD.alignLeft);
    } else {
      push(padLine(label, price, W));
    }
  }

  push(divider("-", W));

  // ── Totals ────────────────────────────────────────────────────────────────
  push(padLine("Subtotal", `${data.currency} ${data.invoice.subtotal.toFixed(0)}`, W));

  if (data.invoice.discountAmount > 0)
    push(padLine("Discount", `-${data.currency} ${data.invoice.discountAmount.toFixed(0)}`, W));

  if (data.invoice.taxAmount > 0)
    push(padLine("Tax", `${data.currency} ${data.invoice.taxAmount.toFixed(0)}`, W));

  push(CMD.heavyOn);
  push(padLine("TOTAL", `${data.currency} ${data.invoice.total.toFixed(0)}`, W));
  push(CMD.heavyOff);

  if (data.invoice.paymentMethod) {
    const METHOD: Record<string, string> = {
      cash: "Cash", jazzcash: "JazzCash", easypaisa: "EasyPaisa",
      raast: "Raast", card: "Card", bank: "Bank Transfer",
    };
    push(padLine("Payment", METHOD[data.invoice.paymentMethod] ?? data.invoice.paymentMethod, W));
  }

  const isPaid = data.invoice.status === "paid";
  const isAdvance = data.invoice.status === "partial";

  if (isAdvance) {
    const advance = data.invoice.advanceAmount ?? 0;
    const balance = Math.max(0, data.invoice.total - advance);
    const advancePct = data.invoice.total > 0 && advance > 0 ? Math.round((advance / data.invoice.total) * 100) : 0;
    push(padLine(`Advance paid (${advancePct}%)`, `${data.currency} ${advance.toFixed(0)}`, W));
    push(CMD.heavyOn);
    push(padLine("BALANCE DUE", `${data.currency} ${balance.toFixed(0)}`, W));
    push(CMD.heavyOff);
  }

  push(CMD.alignCenter, CMD.heavyOn);
  push(text(isPaid ? "** PAID **" : isAdvance ? "** ADVANCE PAID **" : "** UNPAID **"));
  push(CMD.heavyOff);

  // The refund terms have to be on the customer's copy, not just the PDF.
  if (isAdvance) {
    for (const line of wrap("Advance payment is non-refundable.", W)) push(text(line));
  }
  push(CMD.heavyOn);
  for (const line of wrap("Payment is non-refundable.", W)) push(text(line));
  push(CMD.heavyOff);

  if (data.invoice.notes) {
    push(CMD.alignLeft);
    push(divider("-", W));
    push(text(`Note: ${data.invoice.notes}`));
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  push(divider("=", W));
  push(CMD.alignCenter);
  push(text("Thank you for your visit!"));
  push(text("We hope to see you again soon."));
  push(CMD.lf, CMD.lf, CMD.lf);
  push(CMD.cut);

  return Buffer.concat(chunks);
}

// ── TCP send ───────────────────────────────────────────────────────────────────

function sendToprinter(ip: string, port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Printer connection timed out (5s). Check the IP and LAN cable."));
    }, 5000);

    socket.connect(port, ip, () => {
      socket.write(data, (err) => {
        clearTimeout(timeout);
        socket.destroy();
        if (err) reject(err);
        else resolve();
      });
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Mirrors invoiceTimeLabel() in lib/salon-invoices.ts (not imported: that module
 * is browser-side storage code). Pakistan time, and only when the invoice was
 * created on its own date.
 */
function receiptTime(inv: { date: string; createdAt?: string }): string {
  const created = new Date(inv.createdAt ?? "");
  if (!inv.createdAt || Number.isNaN(created.getTime())) return "";
  if (created.toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }) !== inv.date) return "";
  return created.toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Karachi" });
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReceiptData {
  /** Loaded paper width in mm — 80 or 58. Defaults to 80 (48 characters). */
  paperWidthMm?: number;
  /**
   * The salon logo, already rasterized to 1-bit by the browser. Optional: it is
   * absent when the salon has no logo, and dropped when it fails validation.
   */
  logo?: { widthBytes: number; height: number; base64: string };
  salonName: string;
  salonPhone: string;
  salonAddress: string;
  currency: string;
  invoice: {
    number: string;
    date: string;
    /** ISO moment the invoice was created — its time is printed beside the date. */
    createdAt?: string;
    clientName: string;
    clientPhone: string;
    staffName: string;
    items: { description: string; qty: number; total: number; guestName?: string }[];
    subtotal: number;
    discountAmount: number;
    taxAmount: number;
    total: number;
    paymentMethod: string;
    status: string;
    /** Set only on a "partial" sale — the amount taken up front. */
    advanceAmount?: number;
    notes?: string;
  };
}

// ── Route ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Signed-in users only: this opens a raw TCP connection to whatever
  // address it's given, so left public it's a free network probe.
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Not authenticated." }, { status: 401 });

  let body: ReceiptData & { printerIp: string; printerPort?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { printerIp, printerPort = 9100, ...receiptData } = body;

  if (!printerIp) {
    return Response.json({ ok: false, error: "printerIp is required" }, { status: 400 });
  }

  try {
    const receipt = buildReceipt(receiptData);
    await sendToprinter(printerIp, printerPort, receipt);
    return Response.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[thermal-print] error:", msg);
    return Response.json({ ok: false, error: msg }, { status: 502 });
  }
}
