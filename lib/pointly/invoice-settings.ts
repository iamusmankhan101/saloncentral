/**
 * lib/invoice-settings.ts
 *
 * What prints on every Pointly subscription invoice besides the payment: who
 * it's from ("Billed From") and where to pay (a bank account). Both are set by
 * a platform admin — Invoice details and Payment methods tabs of the console —
 * and these are the fallbacks until they are. Mirrors Salon Central's
 * lib/billing-constants.ts.
 *
 * Kept free of the database client so the invoice (a client component) can
 * import the types and defaults. The storage is Pointly's lib/invoice-settings-db.ts (this is a copy of pointly/lib/invoice-settings.ts).
 */

export interface BilledFrom {
  name: string;
  tagline: string;
  phone: string;
  email: string;
  address: string;
}

export const DEFAULT_BILLED_FROM: BilledFrom = {
  name: "Pointly",
  tagline: "Point of sale for your business",
  phone: "+92 302 9646928",
  email: "",
  address: "Lahore, Pakistan",
};

export const BILLED_FROM_FIELDS: { key: keyof BilledFrom; label: string; placeholder: string; hint?: string }[] = [
  { key: "name",    label: "Business name", placeholder: DEFAULT_BILLED_FROM.name },
  { key: "tagline", label: "Tagline",       placeholder: DEFAULT_BILLED_FROM.tagline },
  { key: "phone",   label: "Phone",         placeholder: DEFAULT_BILLED_FROM.phone },
  { key: "email",   label: "Email",         placeholder: "billing@example.com", hint: "Optional — leave empty to hide it." },
  { key: "address", label: "Address",       placeholder: DEFAULT_BILLED_FROM.address },
];

/** A bank account a business can be told to pay into. */
export interface PaymentMethod {
  id: string;
  /** Admin-facing name, e.g. "Tareez Tech — Alfalah". Never printed on the invoice. */
  label: string;
  bankName: string;
  bankTitle: string;
  accountNumber: string;
  iban: string;
  createdAt: string;
}

/** Printed on the invoice of any business that hasn't been assigned a payment method. */
export const DEFAULT_BANK_DETAILS: Pick<PaymentMethod, "bankName" | "bankTitle" | "accountNumber" | "iban"> = {
  bankName: "Bank Alfalah",
  bankTitle: "TAREEZ TECH",
  accountNumber: "02291011176553",
  iban: "PK90ALFH0229001011176553",
};

export type PayTo = Pick<PaymentMethod, "bankName" | "bankTitle" | "accountNumber" | "iban">;
