/**
 * lib/payment-proofs.ts
 *
 * Payment screenshots customers upload from the client app after booking with
 * JazzCash, EasyPaisa or a bank transfer.
 *
 * Kept in their own table rather than on the appointment: appointments live in
 * one JSON blob per salon that every dashboard device downloads and re-saves
 * whole, so a few hundred KB of image per booking would slow every sync — and
 * a dashboard saving its older copy of that blob would wipe out a proof added
 * after it loaded. Here each proof is one row, fetched only when staff open it.
 */

import { db } from "./db";

export interface PaymentProofMeta {
  appointmentId: string;
  method: string;
  createdAt: string;
}

export async function ensurePaymentProofTable(): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payment_proofs (
      salon_id       TEXT NOT NULL,
      appointment_id TEXT NOT NULL,
      method         TEXT NOT NULL,
      image          TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      PRIMARY KEY (salon_id, appointment_id)
    )
  `);
}

/** One proof per appointment — a second upload replaces the first (a clearer shot, say). */
export async function savePaymentProof(salonId: string, appointmentId: string, method: string, image: string): Promise<void> {
  await ensurePaymentProofTable();
  await db.execute({
    sql: `INSERT OR REPLACE INTO payment_proofs (salon_id, appointment_id, method, image, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [salonId, appointmentId, method, image, new Date().toISOString()],
  });
}

export async function listPaymentProofs(salonId: string): Promise<PaymentProofMeta[]> {
  await ensurePaymentProofTable();
  const res = await db.execute({
    sql: "SELECT appointment_id, method, created_at FROM payment_proofs WHERE salon_id = ? ORDER BY created_at DESC",
    args: [salonId],
  });
  return res.rows.map((r) => ({
    appointmentId: String(r.appointment_id),
    method: String(r.method),
    createdAt: String(r.created_at),
  }));
}

export async function getPaymentProofImage(salonId: string, appointmentId: string): Promise<string | null> {
  await ensurePaymentProofTable();
  const res = await db.execute({
    sql: "SELECT image FROM payment_proofs WHERE salon_id = ? AND appointment_id = ?",
    args: [salonId, appointmentId],
  });
  return res.rows.length ? String(res.rows[0].image) : null;
}
