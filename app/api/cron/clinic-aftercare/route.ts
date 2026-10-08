/**
 * /api/cron/clinic-aftercare — daily, for aesthetic clinics on Pro/Premium
 * with WhatsApp connected. Queues (never sends directly):
 *   • aftercare steps — "day N after treatment" messages (lib/clinic-aftercare.ts)
 *   • package reminders — sessions left, the day after one is used
 *   • plan reminders — the next treatment-plan session coming due, if nothing is booked
 * into wa_booking_send_queue as kind "aftercare", which /api/cron/booking-queue
 * drains with the usual pacing, opening hours and safety limits. Queue ids
 * are deterministic, so a step is only ever queued once; a step due in the
 * last two days still goes out if a run was missed.
 *
 * Secured with Authorization: Bearer {CRON_SECRET}.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getBillingUser } from "@/lib/billing-db";
import { timezoneFromSettings } from "@/lib/appointment-time";
import { activeWhatsAppCredential, ycloudConfigOf, type WhatsAppProviderConfig } from "@/lib/whatsapp-provider";
import { listPerformances } from "@/lib/inventory-usage";
import { addDays, businessTypeOf, packagesForClient, planProgress } from "@/lib/clinic-core";
import { aftercareFlows, fillAftercare, flowsForService, type ClinicAutomationSettings } from "@/lib/clinic-aftercare";
import { ensureWinbackTables } from "@/lib/winback-queue";
import type { TreatmentPlan } from "@/lib/clinic";
import type { Appointment, Client, Service } from "@/lib/types";
import type { SalonInvoice } from "@/lib/salon-invoices";

export const maxDuration = 300;
const WHATSAPP_PLANS = new Set(["pro", "basic", "premium"]);
const CATCH_UP_DAYS = 2;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Same key scheme as /api/db: the main branch has no branch part in its key. */
async function load<T>(userId: string, locationId: string, entity: string): Promise<T[]> {
  const key = locationId === "main" ? `${userId}_${entity}` : `${userId}_${locationId}_${entity}`;
  const r = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [key] });
  if (!r.rows.length) return [];
  const parsed = JSON.parse(r.rows[0].data as string);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function normalizePhone(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = `92${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith("3")) d = `92${d}`;
  return d;
}

/** One clinic branch: its own patients, sales, appointments and plans. */
async function runForBranch(userId: string, locationId: string, settings: Record<string, unknown>): Promise<number> {
  const clinicSettings = (settings.clinic ?? {}) as ClinicAutomationSettings;
  const tz = timezoneFromSettings(settings);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const clinicName = (settings.salon as { name?: string } | undefined)?.name || "our clinic";

  const [clients, appointments, invoices, services, plans] = await Promise.all([
    load<Client>(userId, locationId, "clients"), load<Appointment>(userId, locationId, "appointments"), load<SalonInvoice>(userId, locationId, "salon_invoices"),
    load<Service>(userId, locationId, "services"), load<TreatmentPlan>(userId, locationId, "treatment_plans"),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const now = new Date();
  let queued = 0;

  async function queue(id: string, client: Client, text: string, date: string) {
    const phone = normalizePhone(client.phone);
    if (phone.length < 10) return;
    // Spread across the next hour; the drainer still paces and waits for opening hours.
    const scheduledAt = new Date(now.getTime() + Math.round(Math.random() * 60) * 60_000).toISOString();
    const r = await db.execute({
      sql: `INSERT OR IGNORE INTO wa_booking_send_queue
              (id, user_id, kind, phone, text, client_name, appt_date, appt_time, service, scheduled_at, status, attempts, created_at)
            VALUES (?, ?, 'aftercare', ?, ?, ?, ?, NULL, NULL, ?, 'pending', 0, ?)`,
      args: [id, userId, phone, text, client.name, date, scheduledAt, now.toISOString()],
    });
    queued += Number(r.rowsAffected || 0);
  }
  const first = (c: Client) => c.name.split(" ")[0] || c.name;
  const inWindow = (date: string) => date <= today && date >= addDays(today, -CATCH_UP_DAYS);

  // Aftercare steps — one per client, flow, visit day and step.
  if (clinicSettings.autoAftercare !== false) {
    const flows = aftercareFlows(clinicSettings);
    for (const p of listPerformances(invoices, appointments, services, { from: addDays(today, -400) })) {
      const client = p.clientId ? clientById.get(p.clientId) : undefined;
      if (!client) continue;
      for (const f of flowsForService(p.service, flows)) {
        for (const step of f.steps) {
          if (step.day < 1 || !inWindow(addDays(p.date, step.day))) continue;
          await queue(`aftercare_${client.id}_${f.id}_${p.date}_d${step.day}`, client,
            fillAftercare(step.message, { name: first(client), treatment: p.service.name, clinic: clinicName }), p.date);
        }
      }
    }
  }

  // Package sessions left, the day after one is used.
  if (clinicSettings.packageReminders !== false) {
    const buyers = new Set(invoices.filter((inv) => inv.clientId && inv.items.some((l) => l.packagePurchase)).map((inv) => inv.clientId!));
    for (const clientId of buyers) {
      const client = clientById.get(clientId);
      if (!client) continue;
      for (const pkg of packagesForClient(clientId, invoices, today)) {
        const lastUse = pkg.usedOn[pkg.usedOn.length - 1]?.date;
        if (!lastUse || pkg.remaining <= 0 || pkg.expired || !inWindow(addDays(lastUse, 1))) continue;
        await queue(`aftercare_pkg_${pkg.id}_${pkg.used}`, client,
          `Hi ${first(client)}, you have ${pkg.remaining} of ${pkg.sessions} sessions left in your ${pkg.name} at ${clinicName}${pkg.expiresAt ? ` (valid until ${pkg.expiresAt})` : ""}. Reply to book your next session.`, lastUse);
      }
    }
  }

  // Next plan session due within 3 days (or up to a week overdue) with nothing booked.
  if (clinicSettings.planReminders !== false) {
    for (const plan of plans) {
      if (plan.closed) continue;
      const client = clientById.get(plan.clientId);
      if (!client) continue;
      const next = planProgress(plan, invoices, appointments, services, today).sessions.find((s) => s.status !== "done");
      if (!next || next.date > addDays(today, 3) || next.date < addDays(today, -7)) continue;
      const booked = appointments.some((a) => a.clientId === plan.clientId && a.date >= today && !["cancelled", "no-show", "completed"].includes(a.status));
      if (booked) continue;
      await queue(`aftercare_plan_${plan.id}_${next.n}`, client,
        `Hi ${first(client)}, session ${next.n} of ${plan.sessions} of your ${plan.title} is due ${next.date < today ? "now" : `on ${next.date}`}. Reply to book a time at ${clinicName}.`, next.date);
    }
  }
  return queued;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    await ensureWinbackTables(); // creates wa_booking_send_queue if this deployment hasn't yet
    const rows = await db.execute("SELECT entity, data FROM salon_data WHERE entity LIKE '%_settings'");
    let salons = 0;
    let queued = 0;
    for (const row of rows.rows) {
      const userId = String(row.entity).replace(/_settings$/, "");
      try {
        const settings = JSON.parse(row.data as string) as Record<string, unknown>;
        // A salon can run several branches, each a salon or a clinic.
        const branches = ((settings.locations as { items?: { id: string }[] } | undefined)?.items ?? []).map((l) => l.id);
        const clinicBranches = (branches.length ? branches : ["main"]).filter((id) => businessTypeOf(settings, id) === "clinic");
        if (clinicBranches.length === 0) continue;
        const ws = (settings.wasender ?? {}) as Record<string, unknown>;
        if (ws.enabled === false) continue;
        const providerConfig: WhatsAppProviderConfig = {
          provider: (ws.provider as WhatsAppProviderConfig["provider"]) || "wasender",
          apiKey: ws.apiKey as string | undefined, botSailorApiToken: ws.botSailorApiToken as string | undefined,
          botSailorPhoneNumberId: ws.botSailorPhoneNumberId as string | undefined, zaptickApiKey: ws.zaptickApiKey as string | undefined,
          chakraAccessToken: ws.chakraAccessToken as string | undefined, ...ycloudConfigOf(ws),
        };
        if (!activeWhatsAppCredential(providerConfig)) continue;
        const billing = await getBillingUser(userId).catch(() => null);
        if (!billing || !WHATSAPP_PLANS.has(billing.planId)) continue;
        salons++;
        for (const locationId of clinicBranches) queued += await runForBranch(userId, locationId, settings);
      } catch (err) {
        console.error("[clinic-aftercare] salon failed:", userId, err);
      }
    }
    console.log("[clinic-aftercare] done:", { salons, queued });
    return Response.json({ ok: true, salons, queued });
  } catch (err) {
    console.error("[clinic-aftercare]", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
