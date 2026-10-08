import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { branchScope } from "@/lib/branch-scope";
import { db } from "@/lib/db";

const LIMIT = 200;

export interface QueueDetailItem {
  id: string;
  kind: string;
  phone: string;
  clientName: string;
  apptDate: string | null;
  apptTime: string | null;
  scheduledAt: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  source: "booking" | "pos";
  invoiceNumber?: string;
}

export async function GET(request: NextRequest) {
  const actor = await resolveActor(request);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    const booking = await db.execute({
      sql: `SELECT id, kind, phone, client_name, appt_date, appt_time, scheduled_at, status, attempts, last_error, created_at, sent_at
            FROM wa_booking_send_queue
            WHERE user_id = ? AND status = 'pending'
            ORDER BY scheduled_at ASC
            LIMIT ?`,
      args: [actor.userId, LIMIT],
    });
    const recentBooking = await db.execute({
      sql: `SELECT id, kind, phone, client_name, appt_date, appt_time, scheduled_at, status, attempts, last_error, created_at, sent_at
            FROM wa_booking_send_queue
            WHERE user_id = ? AND status <> 'pending'
            ORDER BY COALESCE(sent_at, created_at) DESC
            LIMIT ?`,
      args: [actor.userId, LIMIT],
    });
    const pos = await db.execute({
      sql: `SELECT id, invoice_id, invoice_number, phone, client_name, scheduled_at, status, attempts, last_error, created_at, sent_at
            FROM wa_pos_receipt_queue
            WHERE user_id = ? AND status = 'pending'
            ORDER BY scheduled_at ASC
            LIMIT ?`,
      args: [actor.userId, LIMIT],
    });
    const recentPos = await db.execute({
      sql: `SELECT id, invoice_id, invoice_number, phone, client_name, scheduled_at, status, attempts, last_error, created_at, sent_at
            FROM wa_pos_receipt_queue
            WHERE user_id = ? AND status <> 'pending'
            ORDER BY COALESCE(sent_at, created_at) DESC
            LIMIT ?`,
      args: [actor.userId, LIMIT],
    });

    const items: QueueDetailItem[] = [
      ...booking.rows.map((r): QueueDetailItem => ({
        id: r.id as string,
        kind: r.kind as string,
        phone: r.phone as string,
        clientName: r.client_name as string,
        apptDate: (r.appt_date as string) ?? null,
        apptTime: (r.appt_time as string) ?? null,
        scheduledAt: r.scheduled_at as string,
        status: r.status as string,
        attempts: Number(r.attempts ?? 0),
        lastError: (r.last_error as string) ?? null,
        createdAt: r.created_at as string,
        sentAt: (r.sent_at as string) ?? null,
        source: "booking",
      })),
      ...recentBooking.rows.map((r): QueueDetailItem => ({
        id: r.id as string,
        kind: r.kind as string,
        phone: r.phone as string,
        clientName: r.client_name as string,
        apptDate: (r.appt_date as string) ?? null,
        apptTime: (r.appt_time as string) ?? null,
        scheduledAt: r.scheduled_at as string,
        status: r.status as string,
        attempts: Number(r.attempts ?? 0),
        lastError: (r.last_error as string) ?? null,
        createdAt: r.created_at as string,
        sentAt: (r.sent_at as string) ?? null,
        source: "booking",
      })),
      ...pos.rows.map((r): QueueDetailItem => ({
        id: r.invoice_id as string,
        kind: "invoice",
        phone: r.phone as string,
        clientName: r.client_name as string,
        apptDate: null,
        apptTime: null,
        scheduledAt: r.scheduled_at as string,
        status: r.status as string,
        attempts: Number(r.attempts ?? 0),
        lastError: (r.last_error as string) ?? null,
        createdAt: r.created_at as string,
        sentAt: (r.sent_at as string) ?? null,
        source: "pos",
        invoiceNumber: r.invoice_number as string,
      })),
      ...recentPos.rows.map((r): QueueDetailItem => ({
        id: r.invoice_id as string,
        kind: "invoice",
        phone: r.phone as string,
        clientName: r.client_name as string,
        apptDate: null,
        apptTime: null,
        scheduledAt: r.scheduled_at as string,
        status: r.status as string,
        attempts: Number(r.attempts ?? 0),
        lastError: (r.last_error as string) ?? null,
        createdAt: r.created_at as string,
        sentAt: (r.sent_at as string) ?? null,
        source: "pos",
        invoiceNumber: r.invoice_number as string,
      })),
    ].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      if (a.status === "pending") return a.scheduledAt.localeCompare(b.scheduledAt);
      return (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt);
    });

    // A branch's manager/staff only see their own branch's clients' messages.
    const scope = await branchScope(actor);
    return Response.json({ ok: true, items: scope ? items.filter((i) => scope.hasPhone(i.phone)) : items });
  } catch (error) {
    console.error("[whatsapp/queue-details]", error);
    return Response.json({ ok: false, error: "Could not load queue details." }, { status: 500 });
  }
}
