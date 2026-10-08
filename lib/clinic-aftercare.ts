/**
 * Treatment-specific aftercare & follow-up messages (aesthetic clinics).
 *
 * A flow is a list of "day N after the treatment" WhatsApp messages for the
 * treatments it matches (linked ids, or name keywords — so the defaults work
 * before anything is linked). The daily cron app/api/cron/clinic-aftercare
 * queues each step once, plus two reminders: sessions left in a package after
 * one is used, and the next session of a treatment plan coming due.
 * Isomorphic: the cron and the settings page share it.
 */

import type { Service } from "./types";

export interface AftercareStep {
  /** Days after the treatment date. */
  day: number;
  /** {name}, {treatment} and {clinic} are filled in. */
  message: string;
}

export interface AftercareFlow {
  id: string;
  name: string;
  serviceIds: string[];
  keywords: string[];
  steps: AftercareStep[];
}

export interface ClinicAutomationSettings {
  autoAftercare?: boolean;
  aftercareFlows?: AftercareFlow[] | null;
  /** "You have N sessions left" the day after a package session is used. */
  packageReminders?: boolean;
  /** "Your next session is due" a few days before a plan session falls due. */
  planReminders?: boolean;
}

const flow = (id: string, name: string, keywords: string[], steps: [number, string][]): AftercareFlow =>
  ({ id, name, keywords, serviceIds: [], steps: steps.map(([day, message]) => ({ day, message })) });

export const DEFAULT_AFTERCARE_FLOWS: AftercareFlow[] = [
  flow("af-botox", "Botox", ["botox", "botulinum", "anti-wrinkle", "dysport"], [
    [1, "Hi {name}, thank you for your {treatment} at {clinic} yesterday. For the first 24 hours: stay upright for 4 hours, avoid touching or massaging the area, and skip the gym, sauna and alcohol. Message us if anything worries you."],
    [7, "Hi {name}, it's been a week since your {treatment}. Results should be showing now — how are you finding it? Reply with any questions."],
    [14, "Hi {name}, your {treatment} should be at its full effect by now. If anything looks uneven, reply here and we'll book a quick review."],
    [90, "Hi {name}, it's been about 3 months since your {treatment} at {clinic} — the usual time for a top-up. Reply to book your next appointment."],
  ]),
  flow("af-filler", "Dermal filler", ["filler", "hyaluronic", "lip"], [
    [1, "Hi {name}, thank you for visiting {clinic}. Some swelling and bruising after {treatment} is normal. Use a cold compress, avoid pressure on the area, and skip exercise, heat and alcohol for 24–48 hours. Contact us straight away if you notice severe pain, skin colour changes or vision problems."],
    [7, "Hi {name}, how is your {treatment} settling? Swelling should be going down now. Reply with a photo if you'd like us to check."],
    [14, "Hi {name}, your {treatment} has now settled. If you'd like a review, reply and we'll book you in."],
  ]),
  flow("af-laser", "Laser", ["laser", "ipl", "hair removal"], [
    [1, "Hi {name}, after your {treatment}: keep the area cool and moisturised, avoid sun, hot showers and exfoliating for 48 hours, and use SPF 50 daily."],
    [7, "Hi {name}, how is your skin after your {treatment} at {clinic}? Any redness should have settled. Reply if you have concerns."],
    [28, "Hi {name}, your next {treatment} session is due soon — sessions work best spaced about 4 weeks apart. Reply to book."],
  ]),
  flow("af-peel", "Chemical peel", ["peel"], [
    [1, "Hi {name}, after your {treatment}: don't pick or peel flaking skin, use a gentle cleanser and moisturiser, and wear SPF 50 every day."],
    [3, "Hi {name}, peeling and tightness around now is normal after a {treatment}. Keep moisturising and stay out of the sun."],
    [21, "Hi {name}, your skin has renewed since your {treatment}. Ready for the next session? Reply to book."],
  ]),
  flow("af-micro", "Microneedling / PRP", ["microneedling", "dermapen", "prp", "platelet"], [
    [1, "Hi {name}, after your {treatment}: no makeup for 24 hours, avoid sun, exercise and active skincare for 48 hours, and keep your skin clean and moisturised."],
    [7, "Hi {name}, how is your skin a week after your {treatment}? Reply with any questions."],
    [30, "Hi {name}, it's time for your next {treatment} session at {clinic}. Reply to book."],
  ]),
  flow("af-facial", "Facial / Hydrafacial", ["hydrafacial", "facial"], [
    [3, "Hi {name}, how is your skin after your {treatment} at {clinic}? Remember SPF and plenty of water."],
    [30, "Hi {name}, it's been a month since your {treatment} — the ideal time for your next one. Reply to book."],
  ]),
];

export function aftercareFlows(clinic: ClinicAutomationSettings | undefined): AftercareFlow[] {
  return Array.isArray(clinic?.aftercareFlows) ? clinic!.aftercareFlows! : DEFAULT_AFTERCARE_FLOWS;
}

/** Flows that apply to a treatment — linked by id or matched on its name. */
export function flowsForService(service: Pick<Service, "id" | "name">, flows: AftercareFlow[]): AftercareFlow[] {
  const name = service.name.toLowerCase();
  return flows.filter((f) => f.serviceIds.includes(service.id) || f.keywords.some((k) => k.trim() && name.includes(k.trim().toLowerCase())));
}

export function fillAftercare(message: string, vars: { name: string; treatment: string; clinic: string }): string {
  return message.replace(/\{(name|treatment|clinic)\}/g, (_, k: keyof typeof vars) => vars[k]);
}
