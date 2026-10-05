/**
 * Win-back targeting — clients who haven't visited the salon in a long time.
 *
 * A "lapsed" client is one who has been in at least once but hasn't come back
 * within the salon's configured inactivity window, has no upcoming booking, and
 * hasn't opted out of WhatsApp marketing. Shared by the /api/cron/winback scan,
 * the manual "Queue Now" route, and the WhatsApp Messaging page's live count, so
 * all three agree on exactly who counts as lapsed rather than each re-deriving it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Daily win-back volume. This is bulk marketing to dormant numbers — the send
// pattern most likely to get a WhatsApp number flagged — so it is fixed here
// rather than configurable. The exact number varies day to day inside this range
// (see todaysWinbackCap) rather than being the same round figure every morning.
export const WINBACK_DAILY_MIN = 15;
export const WINBACK_DAILY_MAX = 20;

export interface WinbackConfig {
  autoWinback: boolean;
  /** A client is lapsed once this many days have passed since their last visit. */
  daysInactive: number;
  /** Never send the same client another win-back until this many days have passed. */
  cooldownDays: number;
  discountEnabled: boolean;
  discount: string;
  /** Also message clients on file who have never visited at all (leads). They
   * share the daily cap and cooldown, and go after the lapsed clients. */
  includeNeverVisited: boolean;
}

// Off by default, unlike the other automations: turning this on messages every
// dormant client the salon has ever had, so it has to be a deliberate choice by
// the owner rather than something that starts firing on its own after an update.
export const WINBACK_DEFAULTS: WinbackConfig = {
  autoWinback: false,
  daysInactive: 90,
  cooldownDays: 180,
  discountEnabled: true,
  discount: "",
  includeNeverVisited: false,
};

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

/** Read the winback block out of a raw settings object (localStorage or salon_data). */
export function resolveWinbackConfig(settings: unknown): WinbackConfig {
  const raw = (settings as { winback?: Record<string, unknown> } | null)?.winback ?? {};
  return {
    autoWinback: raw.autoWinback === true,
    daysInactive: positiveNumber(raw.winbackDaysInactive, WINBACK_DEFAULTS.daysInactive),
    cooldownDays: positiveNumber(raw.winbackCooldownDays, WINBACK_DEFAULTS.cooldownDays),
    discountEnabled: raw.winbackDiscountEnabled !== false,
    discount: typeof raw.winbackDiscount === "string" ? raw.winbackDiscount : "",
    includeNeverVisited: raw.winbackIncludeNeverVisited === true,
  };
}

export interface WinbackClient {
  id: string;
  name: string;
  phone?: string;
  lastVisitDate?: string;
  totalVisits?: number;
  whatsappOptedOut?: boolean;
  section?: string;
}

export interface WinbackAppointment {
  clientId: string;
  date: string;
  status: string;
}

/**
 * A POS or manual invoice. For salons that ring people up at the till rather
 * than booking them in, this is the only record that a visit happened — a client
 * can easily have no appointment at all and a blank lastVisitDate.
 */
export interface WinbackInvoice {
  clientId?: string;
  date: string;
}

export interface LapsedClient {
  client: WinbackClient;
  /** YYYY-MM-DD of the most recent completed visit. */
  lastVisit: string;
  daysSinceVisit: number;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isValidDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);
}

/**
 * The client's real last visit: the newest of the stored lastVisitDate and the
 * newest completed appointment. The stored field can lag behind (it's written by
 * whichever screen completed the visit), so neither source alone is reliable.
 */
export function effectiveLastVisit(
  client: WinbackClient,
  appointments: WinbackAppointment[],
  invoices: WinbackInvoice[] = [],
): string | undefined {
  let latest = isValidDay(client.lastVisitDate) ? client.lastVisitDate.slice(0, 10) : undefined;
  const consider = (value: string) => {
    if (!isValidDay(value)) return;
    const date = value.slice(0, 10);
    if (!latest || date > latest) latest = date;
  };
  for (const appt of appointments) {
    if (appt.clientId !== client.id) continue;
    if (appt.status !== "completed") continue;
    consider(appt.date);
  }
  for (const invoice of invoices) {
    if (invoice.clientId !== client.id) continue;
    consider(invoice.date);
  }
  return latest;
}

/** A booking still on the calendar means they're already coming back — don't nag. */
function hasUpcomingBooking(clientId: string, appointments: WinbackAppointment[], todayKey: string): boolean {
  return appointments.some((appt) =>
    appt.clientId === clientId
    && isValidDay(appt.date)
    && appt.date.slice(0, 10) >= todayKey
    && !["completed", "cancelled", "no-show"].includes(appt.status));
}

/** Why the clients who didn't qualify were left out — drives the empty-state copy. */
export interface WinbackAudience {
  lapsed: LapsedClient[];
  /** Reachable clients with no recorded visit and no upcoming booking — only
   * messaged when includeNeverVisited is on. */
  neverVisited: WinbackClient[];
  totalClients: number;
  excluded: {
    noPhone: number;
    optedOut: number;
    neverVisited: number;
    visitedRecently: number;
    upcomingBooking: number;
  };
}

/**
 * Everyone eligible for a win-back message, longest-absent first — so a capped
 * run reaches the clients who've been gone the longest before the rest — plus a
 * tally of why everyone else was skipped. "No lapsed clients" is a legitimate
 * answer, so the caller needs to be able to say *which* reason produced it.
 */
export function summarizeWinbackAudience(
  clients: WinbackClient[],
  appointments: WinbackAppointment[],
  daysInactive: number,
  nowMs = Date.now(),
  invoices: WinbackInvoice[] = [],
): WinbackAudience {
  const today = dayKey(nowMs);
  const lapsed: LapsedClient[] = [];
  const neverVisited: WinbackClient[] = [];
  const excluded = { noPhone: 0, optedOut: 0, neverVisited: 0, visitedRecently: 0, upcomingBooking: 0 };

  for (const client of clients) {
    if (!client.phone?.trim()) { excluded.noPhone++; continue; }
    if (client.whatsappOptedOut) { excluded.optedOut++; continue; }

    const lastVisit = effectiveLastVisit(client, appointments, invoices);
    const lastVisitMs = lastVisit ? Date.parse(`${lastVisit}T00:00:00Z`) : NaN;
    // Never visited at all — a lead, not a lapsed client. Kept separately so the
    // salon can opt in to messaging them too.
    if (!lastVisit || !Number.isFinite(lastVisitMs)) {
      excluded.neverVisited++;
      if (!hasUpcomingBooking(client.id, appointments, today)) neverVisited.push(client);
      continue;
    }
    const daysSinceVisit = Math.floor((nowMs - lastVisitMs) / DAY_MS);
    if (daysSinceVisit < daysInactive) { excluded.visitedRecently++; continue; }

    if (hasUpcomingBooking(client.id, appointments, today)) { excluded.upcomingBooking++; continue; }

    lapsed.push({ client, lastVisit, daysSinceVisit });
  }

  lapsed.sort((a, b) => b.daysSinceVisit - a.daysSinceVisit);
  return { lapsed, neverVisited, totalClients: clients.length, excluded };
}

/** Just the eligible clients — see summarizeWinbackAudience for the exclusion tally. */
export function findLapsedClients(
  clients: WinbackClient[],
  appointments: WinbackAppointment[],
  daysInactive: number,
  nowMs = Date.now(),
  invoices: WinbackInvoice[] = [],
): LapsedClient[] {
  return summarizeWinbackAudience(clients, appointments, daysInactive, nowMs, invoices).lapsed;
}

// Deterministic 0-1 from a seed string, so the same salon on the same day always
// lands on the same number — the nightly cron and a manual "Queue Now" have to
// agree on today's budget without persisting it anywhere.
function hashToUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

/**
 * How many win-backs this salon may send today: a stable random pick inside
 * WINBACK_DAILY_MIN..MAX. The day-to-day variation matters — sending an
 * identical round number every single day is itself a bot signature.
 */
export function todaysWinbackCap(userId: string, salonDayKey: string): number {
  const span = WINBACK_DAILY_MAX - WINBACK_DAILY_MIN + 1;
  return WINBACK_DAILY_MIN + Math.floor(hashToUnit(`${userId}:${salonDayKey}`) * span);
}

/** Variables available to the win-back template. */
export function winbackTemplateVars(input: {
  clientName: string;
  salonName: string;
  discount: string;
  lastVisit?: string;
  daysSinceVisit?: number;
}): Record<string, string> {
  return {
    name: input.clientName,
    salon_name: input.salonName,
    discount: input.discount,
    last_visit: input.lastVisit ?? "",
    days: input.daysSinceVisit == null ? "" : String(input.daysSinceVisit),
  };
}
