/**
 * FBR POS integration — reports each sale to FBR and gets back the fiscal
 * invoice number that has to be printed (with its QR code) on the receipt.
 *
 * Every salon registers its own POS with FBR (IRIS → POS registration) and
 * gets a POS ID and an access token; those are entered in Account settings
 * and read here on the server, never trusted from the request.
 */

import type { SalonInvoice } from "@/lib/salon-invoices";

const FBR_URLS = {
  sandbox: "https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData",
  live: "https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData",
};

export interface FbrConfig {
  enabled: boolean;
  posId: string;
  token: string;
  sandbox: boolean;
  /** PCT (tariff) code FBR assigned to the salon's services. */
  pctCode: string;
}

/** Read the FBR block out of the salon settings object (settingsStore.salon). */
export function resolveFbrConfig(salon: unknown): FbrConfig {
  const s = (salon ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    enabled: s.fbrEnabled === true,
    posId: str(s.fbrPosId),
    token: str(s.fbrToken),
    sandbox: s.fbrSandbox !== false,
    pctCode: str(s.fbrPctCode),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "2026-10-06 18:50:00" in Pakistan time — the format FBR expects. */
function fbrDateTime(iso: string): string {
  const d = new Date(iso);
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toLocaleString("sv-SE", { timeZone: "Asia/Karachi" });
}

/**
 * The FBR PostData body for one sale. Invoice-level discount and tax are
 * spread over the lines in proportion to each line's price, with the last
 * line taking the rounding remainder so the lines add up to the totals exactly.
 */
export function buildFbrPayload(invoice: SalonInvoice, config: FbrConfig) {
  const tax = invoice.taxAmount || 0;
  const saleValue = round2(invoice.total - tax);
  const discount = round2(Math.max(0, invoice.subtotal + tax - invoice.total));
  const taxRate = saleValue > 0 ? round2((tax / saleValue) * 100) : 0;
  const base = invoice.subtotal || 1;

  let usedSale = 0, usedTax = 0, usedDiscount = 0;
  const items = invoice.items.map((item, i) => {
    const last = i === invoice.items.length - 1;
    const share = item.total / base;
    const lineSale = last ? round2(saleValue - usedSale) : round2(saleValue * share);
    const lineTax = last ? round2(tax - usedTax) : round2(tax * share);
    const lineDiscount = last ? round2(discount - usedDiscount) : round2(discount * share);
    usedSale += lineSale; usedTax += lineTax; usedDiscount += lineDiscount;
    return {
      ItemCode: item.sourceId || item.id,
      ItemName: item.description || (item.type === "product" ? "Product" : "Service"),
      Quantity: item.qty || 1,
      PCTCode: config.pctCode,
      TaxRate: taxRate,
      SaleValue: lineSale,
      TotalAmount: round2(lineSale + lineTax),
      TaxCharged: lineTax,
      Discount: lineDiscount,
      FurtherTax: 0,
      InvoiceType: 1,
      RefUSIN: null,
    };
  });

  return {
    InvoiceNumber: "",
    POSID: Number(config.posId),
    USIN: invoice.number,
    DateTime: fbrDateTime(invoice.createdAt),
    BuyerName: invoice.clientName,
    BuyerPhoneNumber: invoice.clientPhone || "",
    TotalBillAmount: round2(invoice.total),
    TotalQuantity: invoice.items.reduce((s, i) => s + (i.qty || 1), 0),
    TotalSaleValue: saleValue,
    TotalTaxCharged: round2(tax),
    Discount: discount,
    FurtherTax: 0,
    // FBR modes: 1 cash, 2 card. Wallets and bank transfers have no code of
    // their own, so they go as cash.
    PaymentMode: invoice.paymentMethod === "card" ? 2 : 1,
    RefUSIN: null,
    InvoiceType: 1,
    Items: items,
  };
}

/** Sends the sale to FBR. Returns the fiscal invoice number, or a readable error. */
export async function reportToFbr(
  invoice: SalonInvoice,
  config: FbrConfig,
): Promise<{ ok: true; fbrInvoiceNumber: string } | { ok: false; error: string }> {
  if (!config.posId || !config.token) return { ok: false, error: "FBR POS ID or token is missing in Account settings." };
  if (!Number.isFinite(Number(config.posId))) return { ok: false, error: "FBR POS ID must be a number." };

  try {
    const res = await fetch(config.sandbox ? FBR_URLS.sandbox : FBR_URLS.live, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(buildFbrPayload(invoice, config)),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({})) as { InvoiceNumber?: string; Code?: string; Response?: string; Errors?: unknown };
    if (res.ok && data.Code === "100" && data.InvoiceNumber) {
      return { ok: true, fbrInvoiceNumber: data.InvoiceNumber };
    }
    const detail = data.Errors ? ` ${typeof data.Errors === "string" ? data.Errors : JSON.stringify(data.Errors)}` : "";
    return { ok: false, error: `FBR rejected the invoice (${data.Code || res.status}): ${data.Response || res.statusText}${detail}` };
  } catch (err) {
    return { ok: false, error: `Couldn't reach FBR: ${err instanceof Error ? err.message : String(err)}` };
  }
}
