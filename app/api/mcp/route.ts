import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyMcpToken, mcpActorFrom, blobKey, type McpKeyActor } from "@/lib/mcp-auth";
import { rateLimit } from "@/lib/rate-limit";
import { appointmentStartMs, appointmentStartHasPassed, timezoneFromSettings, type SalonHoursDay } from "@/lib/appointment-time";
import { createBooking } from "@/lib/booking";
import type { Client, Appointment, Staff, Service, InventoryItem } from "@/lib/types";
import type { SalonInvoice } from "@/lib/salon-invoices";

const MAX_BOOKING_HORIZON_DAYS = 90;
const MAX_AGENT_BOOKINGS_PER_DAY = 20;
const MAX_REVENUE_RANGE_DAYS = 366;
const MAX_DAILY_REVENUE_RANGE_DAYS = 92;

// ── shared data-access helpers ──────────────────────────────────────────────

async function ensureSalonDataTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS salon_data (
      entity     TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

async function readBlob<T>(actor: McpKeyActor, entity: string): Promise<T[]> {
  const result = await db.execute({
    sql: "SELECT data FROM salon_data WHERE entity = ?",
    args: [blobKey(actor, entity)],
  });
  if (result.rows.length === 0) return [];
  try {
    return JSON.parse(result.rows[0].data as string) as T[];
  } catch {
    return [];
  }
}

function errorContent(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function clientSummary(c: Client) {
  return {
    id: c.id, name: c.name, phone: c.phone, email: c.email ?? null, gender: c.gender ?? null, dob: c.dob ?? null,
    tags: c.tags, source: c.source, createdAt: c.createdAt,
    totalVisits: c.totalVisits, totalSpend: c.totalSpend, lastVisitDate: c.lastVisitDate ?? null,
    averageRating: c.averageRating ?? null, notes: c.notes ?? null,
    loyaltyPoints: c.loyaltyPoints ?? 0, loyaltyPointsEarned: c.loyaltyPointsEarned ?? 0,
    whatsappOptedOut: c.whatsappOptedOut ?? false,
  };
}

/** Per-key rate limit, checked at the top of every tool call. Returns error content if blocked, else null. */
async function checkKeyRateLimit(actor: McpKeyActor) {
  const limit = await rateLimit("mcp-api-key", actor.keyId, { maxAttempts: 60, windowMs: 60_000, blockMs: 5 * 60_000 });
  if (limit.blocked) {
    return errorContent(`Rate limit exceeded. Try again in ${limit.retryAfter ?? 60} seconds.`);
  }
  return null;
}

const dateStrSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected date in YYYY-MM-DD format.");

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayNameForDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Statuses that actually hold a real slot on the calendar — a cancelled/no-show
// appointment must not block a new booking from reusing that time.
const BLOCKING_STATUSES = new Set(["booked", "confirmed", "arrived", "in-progress", "completed"]);

async function computeAvailability(actor: McpKeyActor, date: string, staffId?: string, serviceId?: string) {
  const [settingsRows, services, staffList, appointments] = await Promise.all([
    db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [blobKey(actor, "settings")] }),
    readBlob<Service>(actor, "services"),
    readBlob<Staff>(actor, "staff"),
    readBlob<Appointment>(actor, "appointments"),
  ]);
  const settings = settingsRows.rows.length > 0 ? JSON.parse(settingsRows.rows[0].data as string) : {};
  const timezone = timezoneFromSettings(settings);
  const hours = settings?.hours as SalonHoursDay[] | undefined;

  const service = serviceId ? services.find((s) => s.id === serviceId) : undefined;
  const durationMin = service?.durationMin ?? 30;

  const today = hours?.find((h) => h.day === weekdayNameForDateStr(date));
  if (!today || !today.open) {
    return { available: false, reason: "Salon is closed that day.", staff: [] as { staffId: string; staffName: string; slots: string[] }[] };
  }

  const startMin = timeToMinutes(today.from);
  const endMin = timeToMinutes(today.to);
  const grid: string[] = [];
  for (let t = startMin; t + Math.max(durationMin, 30) <= endMin; t += 30) grid.push(minutesToTime(t));

  const candidates = staffId
    ? staffList.filter((s) => s.id === staffId)
    : staffList.filter((s) => s.isActive && (!service || service.assignedStaffIds.includes(s.id)));

  if (candidates.length === 0) {
    return { available: false, reason: staffId ? "Staff member not found." : "No eligible staff for this service.", staff: [] as { staffId: string; staffName: string; slots: string[] }[] };
  }

  const results = candidates.map((staff) => {
    const staffAppts = appointments.filter((a) => a.staffId === staff.id && a.date === date && BLOCKING_STATUSES.has(a.status));
    const busyRanges = staffAppts
      .map((a) => {
        const s = appointmentStartMs(a.date, a.startTime, timezone);
        const e = appointmentStartMs(a.date, a.endTime, timezone);
        return s != null && e != null ? [s, e] as const : null;
      })
      .filter((r): r is readonly [number, number] => r !== null);

    const slots = grid.filter((slotTime) => {
      const slotStart = appointmentStartMs(date, slotTime, timezone);
      if (slotStart == null) return false;
      const slotEnd = slotStart + durationMin * 60_000;
      return !busyRanges.some(([bs, be]) => slotStart < be && bs < slotEnd);
    });

    return { staffId: staff.id, staffName: staff.name, slots };
  });

  return { available: results.some((r) => r.slots.length > 0), reason: null as string | null, staff: results };
}

// ── MCP server + tools ───────────────────────────────────────────────────────

const baseHandler = createMcpHandler(
  (server) => {
    server.tool(
      "list_services",
      "List the salon's active services with price and duration.",
      {},
      async (_args, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const services = await readBlob<Service>(actor, "services");
        const active = services.filter((s) => s.isActive !== false).map((s) => ({
          id: s.id, name: s.name, category: s.category, durationMin: s.durationMin, price: s.price,
        }));
        return jsonContent(active);
      },
    );

    server.tool(
      "list_staff",
      "List the salon's staff members, including role, specialties, contact info, and pay (commission rate or salary).",
      { includeInactive: z.boolean().optional() },
      async ({ includeInactive }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const staff = await readBlob<Staff>(actor, "staff");
        const list = (includeInactive ? staff : staff.filter((s) => s.isActive)).map((s) => ({
          id: s.id, name: s.name, phone: s.phone, email: s.email ?? null, role: s.role,
          specialties: s.specialties, isActive: s.isActive,
          payType: s.payType ?? "commission", commissionRate: s.commissionRate ?? null, baseSalary: s.baseSalary ?? null,
        }));
        return jsonContent(list);
      },
    );

    server.tool(
      "find_client",
      "Search the salon's clients by name or phone number substring. Returns full client details for matches.",
      { query: z.string().min(1, "query is required") },
      async ({ query }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const clients = await readBlob<Client>(actor, "clients");
        const q = query.trim().toLowerCase();
        const qDigits = q.replace(/\D/g, "");
        const matches = clients
          .filter((c) => c.name.toLowerCase().includes(q) || (qDigits && c.phone.replace(/\D/g, "").includes(qDigits)))
          .slice(0, 10)
          .map(clientSummary);
        return jsonContent(matches);
      },
    );

    server.tool(
      "list_clients",
      "List all of the salon's clients (paginated), with full profile details including notes, tags, loyalty points, and lifetime visit/spend stats.",
      { limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
      async ({ limit, offset }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const clients = await readBlob<Client>(actor, "clients");
        const start = offset ?? 0;
        const pageSize = limit ?? 100;
        const page = clients.slice(start, start + pageSize).map(clientSummary);
        return jsonContent({ total: clients.length, offset: start, limit: pageSize, clients: page });
      },
    );

    server.tool(
      "get_client",
      "Full profile for a single client by id, including notes, tags, loyalty, and their recent appointment history.",
      { clientId: z.string().min(1) },
      async ({ clientId }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const [clients, appointments] = await Promise.all([
          readBlob<Client>(actor, "clients"),
          readBlob<Appointment>(actor, "appointments"),
        ]);
        const client = clients.find((c) => c.id === clientId);
        if (!client) return errorContent("clientId not found.");

        const history = appointments
          .filter((a) => a.clientId === clientId)
          .sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime))
          .slice(0, 20)
          .map((a) => ({ id: a.id, date: a.date, startTime: a.startTime, serviceNames: a.serviceNames, staffName: a.staffName, status: a.status, totalAmount: a.totalAmount }));

        return jsonContent({ ...clientSummary(client), recentAppointments: history });
      },
    );

    server.tool(
      "list_inventory",
      "List the salon's inventory/stock items with current stock levels, cost, and retail price.",
      {},
      async (_args, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const items = await readBlob<InventoryItem>(actor, "inventory");
        const list = items.map((i) => ({
          id: i.id, name: i.name, brand: i.brand, category: i.category, unit: i.unit,
          currentStock: i.currentStock, minStock: i.minStock, lowStock: i.currentStock <= i.minStock,
          costPrice: i.costPrice, retailPrice: i.retailPrice ?? null, supplier: i.supplier ?? null, lastRestocked: i.lastRestocked ?? null,
        }));
        return jsonContent(list);
      },
    );

    server.tool(
      "list_invoices",
      "List the salon's POS/checkout invoices for a date range, with line items, discount, tax, total, and payment status.",
      { startDate: dateStrSchema, endDate: dateStrSchema.optional(), status: z.enum(["paid", "unpaid"]).optional() },
      async ({ startDate, endDate, status }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        const rangeEnd = endDate ?? startDate;
        if (rangeEnd < startDate) return errorContent("endDate must be on or after startDate.");

        await ensureSalonDataTable();
        const invoices = await readBlob<SalonInvoice>(actor, "salon_invoices");
        const matches = invoices
          .filter((inv) => inv.date >= startDate && inv.date <= rangeEnd && (!status || inv.status === status))
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 500)
          .map((inv) => ({
            id: inv.id, number: inv.number, appointmentId: inv.appointmentId ?? null,
            clientName: inv.clientName, clientPhone: inv.clientPhone, staffName: inv.staffName,
            items: inv.items, subtotal: inv.subtotal, discountAmount: inv.discountAmount, taxAmount: inv.taxAmount, total: inv.total,
            paymentMethod: inv.paymentMethod, status: inv.status, date: inv.date, notes: inv.notes ?? null,
          }));
        return jsonContent({ startDate, endDate: rangeEnd, count: matches.length, invoices: matches });
      },
    );

    server.tool(
      "get_salon_info",
      "The salon's business profile: name, contact info, address, currency, timezone, business hours, and loyalty program settings. Never includes WhatsApp/API credentials.",
      {},
      async (_args, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const settingsRows = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [blobKey(actor, "settings")] });
        const settings = settingsRows.rows.length > 0 ? JSON.parse(settingsRows.rows[0].data as string) : {};
        const salon = settings?.salon ?? {};
        const loyalty = settings?.loyalty ?? {};

        return jsonContent({
          name: salon.name ?? null, phone: salon.phone ?? null, email: salon.email ?? null,
          address: salon.address ?? null, city: salon.city ?? null,
          currency: salon.currency ?? null, timezone: salon.timezone ?? null,
          hours: settings?.hours ?? [],
          loyalty: {
            enabled: loyalty.enabled ?? false, pointsPerRupee: loyalty.pointsPerRupee ?? null, rupeePerPoint: loyalty.rupeePerPoint ?? null,
          },
        });
      },
    );

    server.tool(
      "check_availability",
      "Find open appointment slots for a given date, optionally narrowed to a specific staff member and/or service.",
      {
        date: dateStrSchema,
        staffId: z.string().optional(),
        serviceId: z.string().optional(),
      },
      async ({ date, staffId, serviceId }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const result = await computeAvailability(actor, date, staffId, serviceId);
        return jsonContent(result);
      },
    );

    server.tool(
      "list_appointments",
      "List the salon's appointments. Pass `date` for a single day (defaults to today), or `startDate`/`endDate` for a range. Optionally narrow to one client with clientId.",
      {
        date: dateStrSchema.optional(),
        startDate: dateStrSchema.optional(),
        endDate: dateStrSchema.optional(),
        clientId: z.string().optional(),
      },
      async ({ date, startDate, endDate, clientId }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();
        const [settingsRows, appointments] = await Promise.all([
          db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [blobKey(actor, "settings")] }),
          readBlob<Appointment>(actor, "appointments"),
        ]);
        const settings = settingsRows.rows.length > 0 ? JSON.parse(settingsRows.rows[0].data as string) : {};
        const timezone = timezoneFromSettings(settings);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
        const rangeStart = startDate ?? date ?? today;
        const rangeEnd = endDate ?? date ?? rangeStart;
        if (rangeEnd < rangeStart) return errorContent("endDate must be on or after startDate.");

        const matches = appointments
          .filter((a) => a.date >= rangeStart && a.date <= rangeEnd && (!clientId || a.clientId === clientId))
          .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
          .slice(0, 500)
          .map((a) => ({
            id: a.id, clientId: a.clientId, clientName: a.clientName, staffName: a.staffName, serviceNames: a.serviceNames,
            date: a.date, startTime: a.startTime, endTime: a.endTime, status: a.status, totalAmount: a.totalAmount,
          }));
        return jsonContent({ startDate: rangeStart, endDate: rangeEnd, count: matches.length, appointments: matches });
      },
    );

    server.tool(
      "get_revenue_summary",
      "The salon's exact recognized revenue total for a date range — the same number shown on the dashboard's Revenue Management page. Use this instead of adding up list_appointments/list_services yourself: that misses POS checkout add-ons (retail products, discounts, tiered pricing) and can double-count or under-count, since an appointment's booked price can differ from what was actually charged at checkout.",
      {
        startDate: dateStrSchema,
        endDate: dateStrSchema.optional(),
      },
      async ({ startDate, endDate }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        const rangeEnd = endDate ?? startDate;
        if (rangeEnd < startDate) return errorContent("endDate must be on or after startDate.");
        const spanDays = (new Date(`${rangeEnd}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000;
        if (spanDays > MAX_REVENUE_RANGE_DAYS) return errorContent(`Range too wide — max ${MAX_REVENUE_RANGE_DAYS} days.`);

        await ensureSalonDataTable();
        const [appointments, invoices] = await Promise.all([
          readBlob<Appointment>(actor, "appointments"),
          readBlob<SalonInvoice>(actor, "salon_invoices"),
        ]);

        // Mirrors app/(dashboard)/dashboard/revenue/page.tsx exactly: completed
        // appointments' totalAmount (reconciled to the real POS total when the
        // appointment itself was checked out through POS) PLUS standalone/walk-in
        // invoices only — appointment-linked invoices are excluded here because
        // that same amount is already counted via the appointment's totalAmount,
        // and including both would double-count that visit.
        const inRange = (d: string) => d >= startDate && d <= rangeEnd;
        const completedAppts = appointments.filter((a) => a.status === "completed" && inRange(a.date));
        const standaloneInvoices = invoices.filter((inv) => !inv.appointmentId && inRange(inv.date));

        const appointmentRevenue = completedAppts.reduce((s, a) => s + a.totalAmount, 0);
        const posRevenue = standaloneInvoices.reduce((s, inv) => s + inv.total, 0);
        const unpaidPosInvoices = standaloneInvoices.filter((inv) => inv.status === "unpaid");
        const unpaidPosRevenue = unpaidPosInvoices.reduce((s, inv) => s + inv.total, 0);
        const totalRevenue = appointmentRevenue + posRevenue;
        const transactionCount = completedAppts.length + standaloneInvoices.length;

        return jsonContent({
          startDate,
          endDate: rangeEnd,
          totalRevenue,
          appointmentRevenue,
          posRevenue,
          unpaidPosRevenue,
          appointmentCount: completedAppts.length,
          invoiceCount: standaloneInvoices.length,
          avgTicket: transactionCount > 0 ? Math.round(totalRevenue / transactionCount) : 0,
          note:
            "totalRevenue matches the dashboard's Revenue Management page: it's recognized revenue (includes unpaid invoices as booked/owed), not cash actually collected. " +
            (unpaidPosRevenue > 0 ? `Of posRevenue, ${unpaidPosRevenue} is still unpaid.` : "All included invoices are paid."),
        });
      },
    );

    server.tool(
      "get_daily_revenue",
      "Recognized revenue broken down day-by-day for a date range — the per-day numbers behind get_revenue_summary's total. Use this when asked for revenue on a specific day, or for a trend/breakdown across multiple days, instead of calling get_revenue_summary once per day.",
      {
        startDate: dateStrSchema,
        endDate: dateStrSchema.optional(),
      },
      async ({ startDate, endDate }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        const rangeEnd = endDate ?? startDate;
        if (rangeEnd < startDate) return errorContent("endDate must be on or after startDate.");
        const spanDays = (new Date(`${rangeEnd}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000 + 1;
        if (spanDays > MAX_DAILY_REVENUE_RANGE_DAYS) {
          return errorContent(`Range too wide for a daily breakdown — max ${MAX_DAILY_REVENUE_RANGE_DAYS} days. Use get_revenue_summary for a single total over a wider range.`);
        }

        await ensureSalonDataTable();
        const [appointments, invoices] = await Promise.all([
          readBlob<Appointment>(actor, "appointments"),
          readBlob<SalonInvoice>(actor, "salon_invoices"),
        ]);

        // Same recognized-revenue definition as get_revenue_summary, just bucketed per day.
        const inRange = (d: string) => d >= startDate && d <= rangeEnd;
        const completedAppts = appointments.filter((a) => a.status === "completed" && inRange(a.date));
        const standaloneInvoices = invoices.filter((inv) => !inv.appointmentId && inRange(inv.date));

        const byDay = new Map<string, { appointmentRevenue: number; posRevenue: number; appointmentCount: number; invoiceCount: number }>();
        for (let t = new Date(`${startDate}T00:00:00Z`).getTime(); t <= new Date(`${rangeEnd}T00:00:00Z`).getTime(); t += 86_400_000) {
          byDay.set(new Date(t).toISOString().slice(0, 10), { appointmentRevenue: 0, posRevenue: 0, appointmentCount: 0, invoiceCount: 0 });
        }
        completedAppts.forEach((a) => {
          const bucket = byDay.get(a.date);
          if (bucket) { bucket.appointmentRevenue += a.totalAmount; bucket.appointmentCount++; }
        });
        standaloneInvoices.forEach((inv) => {
          const bucket = byDay.get(inv.date);
          if (bucket) { bucket.posRevenue += inv.total; bucket.invoiceCount++; }
        });

        const days = Array.from(byDay.entries()).map(([date, d]) => ({
          date,
          revenue: d.appointmentRevenue + d.posRevenue,
          appointmentRevenue: d.appointmentRevenue,
          posRevenue: d.posRevenue,
          transactionCount: d.appointmentCount + d.invoiceCount,
        }));

        return jsonContent({
          startDate,
          endDate: rangeEnd,
          totalRevenue: days.reduce((s, d) => s + d.revenue, 0),
          days,
        });
      },
    );

    server.tool(
      "book_appointment",
      "Book a new appointment for a client. Provide either an existing clientId (from find_client) or a clientName/clientPhone for a new client. If staffId is omitted it's auto-assigned when exactly one eligible stylist can perform the service(s). Call check_availability first to pick an open slot.",
      {
        clientId: z.string().optional(),
        clientName: z.string().optional(),
        clientPhone: z.string().optional(),
        serviceIds: z.array(z.string()).min(1, "At least one serviceId is required."),
        staffId: z.string().optional(),
        date: dateStrSchema,
        startTime: z.string().regex(/^\d{2}:\d{2}$/, "Expected time in HH:MM 24-hour format."),
        notes: z.string().optional(),
      },
      async ({ clientId, clientName, clientPhone, serviceIds, staffId, date, startTime, notes }, extra) => {
        const actor = mcpActorFrom(extra.authInfo);
        if (!actor) return errorContent("Unauthorized.");
        if (actor.scope !== "read_write") return errorContent("This key is read-only and cannot book appointments.");
        const limited = await checkKeyRateLimit(actor);
        if (limited) return limited;

        await ensureSalonDataTable();

        const [settingsRows, services, staffList, appointments, clients] = await Promise.all([
          db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [blobKey(actor, "settings")] }),
          readBlob<Service>(actor, "services"),
          readBlob<Staff>(actor, "staff"),
          readBlob<Appointment>(actor, "appointments"),
          readBlob<Client>(actor, "clients"),
        ]);
        const settings = settingsRows.rows.length > 0 ? JSON.parse(settingsRows.rows[0].data as string) : {};
        const timezone = timezoneFromSettings(settings);
        const salonId = actor.userId;

        // ── date bounds — nothing in the app validates this today (not even the
        // human-facing form), but an unsupervised external caller needs it. ──
        if (appointmentStartHasPassed(date, startTime, timezone)) {
          return errorContent("That date/time has already passed.");
        }
        const horizonMs = appointmentStartMs(date, startTime, timezone);
        if (horizonMs != null && horizonMs - Date.now() > MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60_000) {
          return errorContent(`Bookings can't be made more than ${MAX_BOOKING_HORIZON_DAYS} days in advance.`);
        }

        // ── resolve services ──
        const selectedServices = serviceIds.map((id) => services.find((s) => s.id === id)).filter((s): s is Service => !!s);
        if (selectedServices.length !== serviceIds.length) {
          return errorContent("One or more serviceIds were not found.");
        }
        const totalDuration = selectedServices.reduce((sum, s) => sum + s.durationMin, 0);
        const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);
        const endTime = minutesToTime(timeToMinutes(startTime) + totalDuration);

        // ── resolve staff ──
        const eligibleStaff = staffList.filter((s) => s.isActive && selectedServices.every((sv) => sv.assignedStaffIds.includes(s.id)));
        let resolvedStaff: Staff | undefined;
        if (staffId) {
          resolvedStaff = eligibleStaff.find((s) => s.id === staffId);
          if (!resolvedStaff) return errorContent("staffId is not an active stylist eligible for the selected service(s).");
        } else if (eligibleStaff.length === 1) {
          resolvedStaff = eligibleStaff[0];
        } else {
          return errorContent(
            eligibleStaff.length === 0
              ? "No active staff can perform the selected service(s)."
              : `Multiple stylists can perform this — specify staffId. Options: ${eligibleStaff.map((s) => `${s.name} (${s.id})`).join(", ")}`,
          );
        }

        // ── resolve client (existing or new) ──
        let resolvedClient: Client | undefined;
        if (clientId) {
          resolvedClient = clients.find((c) => c.id === clientId);
          if (!resolvedClient) return errorContent("clientId not found.");
        } else {
          if (!clientName) return errorContent("Provide either clientId or clientName for a new client.");
          resolvedClient = {
            id: "c_agent_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            name: clientName,
            phone: clientPhone || "",
            tags: [],
            source: "agent",
            createdAt: new Date().toISOString().slice(0, 10),
            totalVisits: 0,
            totalSpend: 0,
          };
        }
        // ── idempotency: the same existing client retrying the exact same slot
        // returns the existing booking instead of erroring or double-booking —
        // an LLM caller is far more likely than a human to blindly retry an
        // ambiguous/timed-out call. Only meaningful when booking for an
        // already-known clientId — a brand-new client has no stable identity
        // across separate calls to dedupe against. ──
        const sameSlot = appointments.filter((a) => a.staffId === resolvedStaff!.id && a.date === date && a.startTime === startTime && BLOCKING_STATUSES.has(a.status));
        const existingForSameClient = clientId ? sameSlot.find((a) => a.clientId === clientId) : undefined;
        if (existingForSameClient) {
          return jsonContent({ ok: true, duplicate: true, appointment: existingForSameClient });
        }

        // ── real conflict: a different client already holds this slot ──
        if (sameSlot.length > 0) {
          const availability = await computeAvailability(actor, date, resolvedStaff.id);
          const alternatives = availability.staff[0]?.slots.slice(0, 5) ?? [];
          return errorContent(
            `${resolvedStaff.name} already has an appointment at ${startTime} on ${date}. ` +
            (alternatives.length > 0 ? `Nearby open slots: ${alternatives.join(", ")}.` : "No other slots are open that day."),
          );
        }

        // ── circuit breaker: cap MCP-sourced bookings per salon per day — this
        // is brand-new, unvalidated write logic handed to an unsupervised
        // external caller, so bound the blast radius of a runaway loop/bug. ──
        const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
        const agentBookingsToday = appointments.filter((a) => a.source === "agent" && (a.createdAt ?? "").slice(0, 10) === todayStr).length;
        if (agentBookingsToday >= MAX_AGENT_BOOKINGS_PER_DAY) {
          return errorContent("Daily limit for AI-assisted bookings reached for this salon. Please try again tomorrow or book directly.");
        }

        const appointment: Appointment = {
          id: "a_agent_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          clientId: resolvedClient.id,
          clientName: resolvedClient.name,
          staffId: resolvedStaff.id,
          staffName: resolvedStaff.name,
          serviceIds: selectedServices.map((s) => s.id),
          serviceNames: selectedServices.map((s) => s.name),
          date,
          startTime,
          endTime,
          status: "booked",
          totalAmount,
          notes,
          source: "agent",
          createdAt: new Date().toISOString(),
        };

        const result = await createBooking(salonId, appointment, clientId ? undefined : resolvedClient, clientPhone || resolvedClient.phone, "AI assistant");
        if (!result.ok) return errorContent("Failed to create the booking.");
        return jsonContent({ ok: true, duplicate: result.duplicate, appointment });
      },
    );
  },
  { serverInfo: { name: "salon-central-mcp", version: "1.0.0" } },
  { streamableHttpEndpoint: "/api/mcp", disableSse: true },
);

const handler = withMcpAuth(baseHandler, verifyMcpToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
