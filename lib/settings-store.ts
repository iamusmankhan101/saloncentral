// Settings persisted to localStorage so changes survive page refreshes

import { activeCredential, isProviderField } from "./whatsapp-credentials";
import { userKey, getCurrentUser } from "./auth";
import { saveSettingsToDB } from "./turso-sync";

const STORAGE_KEY = "werzio_settings";
const SAVED_AT_KEY = "werzio_settings_saved_at";
export const SETTINGS_CHANGED_EVENT = "werzio_settings_changed";

const defaults = {
  replicate: {
    apiToken: "",
  },
  huggingface: {
    apiToken: "",
  },
  salon: {
    name: "Amna's Salon",
    phone: "0300-1234567",
    email: "amna@werzio.pk",
    address: "Block 5, Gulshan-e-Iqbal, Karachi",
    city: "Karachi",
    currency: "PKR",
    timezone: "Asia/Karachi",
    logo: "",
  },
  locations: {
    activeLocationId: "main",
    items: [
      {
        id: "main",
        name: "Main Branch",
        address: "Block 5, Gulshan-e-Iqbal, Karachi",
        city: "Karachi",
      },
    ],
  },
  // Persistent "which salon section am I working" context (e.g. "Men's" /
  // "Women's") — distinct from locations, which are separate physical
  // branches. "all" means every page shows both sections combined.
  activeSection: "all",
  wasender: {
    provider: "wasender" as "wasender" | "botsailor" | "zaptick" | "chakra",
    apiKey: "",
    botSailorApiToken: "",
    botSailorPhoneNumberId: "",
    botSailorTemplateReminder: "",
    botSailorTemplateConfirmation: "",
    botSailorTemplateFollowup: "",
    botSailorTemplateCancellation: "",
    botSailorTemplateBirthday: "",
    botSailorTemplateWinback: "",
    zaptickApiKey: "",
    chakraAccessToken: "",
    chakraPluginId: "",
    chakraWhatsappPhoneNumberId: "",
    chakraTemplateReminder: "",
    chakraTemplateConfirmation: "",
    chakraTemplateFollowup: "",
    chakraTemplateCancellation: "",
    chakraTemplateBirthday: "",
    chakraTemplateWinback: "",
    ownerPhone: "",
    bookingGroupJid: "",
    autoReminder: true,
    reminderHours: 24,
    autoConfirmation: true,
    autoFollowup: true,
    followupDelayMinutes: 1440,
    autoCancellation: true,
    cancellationDelayMinutes: 1440,
    cancelDiscountEnabled: true,
    cancelDiscount: "10%",
    autoLowStock: true,
    autoNewBooking: true,
    autoGroupBooking: false,
    autoPosThankYou: true,
    safetyEnabled: true,
    emergencyPause: false,
    dailySendLimit: 300,
    perRecipientDailyLimit: 12,
    recipientCooldownSeconds: 15,
    randomDelayMinSeconds: 300,
    randomDelayMaxSeconds: 600,
    quietHoursEnabled: true,
    quietHoursStart: "21:00",
    quietHoursEnd: "09:00",
    quietHoursTimezone: "Asia/Karachi",
    blockMarketingWithoutOptIn: true,
  },
  hours: [
    { day: "Monday",    open: true,  from: "09:00", to: "20:00" },
    { day: "Tuesday",   open: true,  from: "09:00", to: "20:00" },
    { day: "Wednesday", open: true,  from: "09:00", to: "20:00" },
    { day: "Thursday",  open: true,  from: "09:00", to: "20:00" },
    { day: "Friday",    open: true,  from: "09:00", to: "20:00" },
    { day: "Saturday",  open: true,  from: "10:00", to: "18:00" },
    { day: "Sunday",    open: false, from: "10:00", to: "18:00" },
  ],
  attendance: {
    // A full working day in hours — what the register measures clocked time
    // against, and what salary pro-ration treats as one whole day.
    standardHoursPerDay: 8,
    // Paid leave days a month for staff with no figure of their own. 0 keeps the
    // previous behaviour — nobody gains paid leave until the salon sets this.
    leavesPerMonth: 0,
    // Weekly offs for the whole salon, as JS getDay() numbers (0 = Sunday). Empty
    // by default: a salon trades through the weekend, so no day is assumed off
    // until the salon says which. Individual staff can override on their record.
    weeklyOffDays: [] as number[],
    // Days a leave or an absence is charged double on — the weekend, where a
    // missing stylist costs the most. Set peakDayMultiplier to 1 to switch the
    // rule off without clearing the day list.
    peakDays: [0, 6],
    peakDayMultiplier: 2,
  },
  notifications: {
    apptReminder: true,
    apptConfirm: true,
    noShow: true,
    dailySummary: true,
    weeklySummary: false,
    lowStock: true,
    whatsappNotify: true,
    emailNotify: false,
  },
  appearance: {
    accent: "#7C3AED",
    dateFormat: "DD/MM/YYYY",
    timeFormat: "12-hour (1:00pm)",
  },
  whatsapp: {
    connected: true,
    reminder: "Hi {{name}}, this is a reminder that your {{service}} appointment at {{salon_name}} is on {{date}} at {{time}}. See you soon! 💜",
    confirmation: "Hi {{name}}, your {{service}} booking on {{date}} at {{time}} is confirmed at {{salon_name}}. We look forward to seeing you! 💜",
    followup: "Hi {{name}}, thank you for visiting {{salon_name}}! We hope you loved your {{service}}. We'd love to see you again soon 💜",
    cancellation: "Hi {{name}}, we noticed your appointment at {{salon_name}} was cancelled. We'd love to have you back — enjoy {{discount}} off your next booking! Just reply to reschedule 💜",
    cancellationNoDiscount: "Hi {{name}}, we noticed your appointment at {{salon_name}} was cancelled. We'd love to have you back — just reply here and we’ll help you reschedule 💜",
    newBooking: "📅 New Booking! {{name}} has booked {{service}} on {{date}} at {{time}} at {{salon_name}}. Total: PKR {{amount}}.",
    lowstock: "⚠️ Low Stock Alert from {{salon_name}}: {{count}} item(s) running low — {{items}}. Please restock soon.",
    birthday: "🎂 Happy Birthday {{name}}! Wishing you a beautiful day from all of us at {{salon_name}}. As a birthday gift, enjoy {{discount}} off your next visit — book anytime this week 💜",
    birthdayNoDiscount: "🎂 Happy Birthday {{name}}! Wishing you a beautiful day from all of us at {{salon_name}}. We hope your day is full of joy and glow 💜",
    winback: "Hi {{name}}, it's been a while since your last visit to {{salon_name}} — we've missed you! Come back and enjoy {{discount}} off your next appointment. Just reply here to book 💜",
    winbackNoDiscount: "Hi {{name}}, it's been a while since your last visit to {{salon_name}} — we've missed you! We'd love to see you again, just reply here whenever you'd like to book 💜",
    posThankYou: "Thank you so much for visiting {{salon_name}} today, {{name}}! We hope you loved your experience — see you again soon 💜",
  },
  birthday: {
    autoBirthday: true,
    birthdayTemplateId: "",
    birthdayDiscountEnabled: true,
    birthdayDiscount: "",
  },
  // Win-back messages for clients who haven't visited in a long time. Defaults
  // to off — see WINBACK_DEFAULTS in lib/winback.ts for why this one automation
  // has to be switched on deliberately.
  winback: {
    autoWinback: false,
    winbackDaysInactive: 90,
    winbackCooldownDays: 180,
    winbackDiscountEnabled: true,
    winbackDiscount: "",
    winbackDailyLimit: 15,
  },
  loyalty: {
    enabled: true,
    pointsPerRupee: 0.01,
    rupeePerPoint: 1,
    silverMin: 500,
    goldMin: 2000,
    platinumMin: 5000,
  },
  cashback: {
    enabled: false,
    apiKey: "",
  },
  // How customers can pay, shown in the client app and at booking. Public by
  // design — /api/public/salon hands the enabled ones to anyone with the link.
  payments: {
    payAtCounter: true,
    jazzcash:  { enabled: false, number: "", title: "" },
    easypaisa: { enabled: false, number: "", title: "" },
    bank:      { enabled: false, bankName: "", title: "", accountNumber: "", iban: "" },
  },
  printer: {
    enabled: false,
    ip: "",
    port: 9100,
    // Loaded paper width in mm: 80 (48 chars/line) or 58 (32). Defaults to 80,
    // matching the Speed-X 400ul this section documents — the receipt builder
    // used to hard-code 32 characters, which printed half-width on 80mm rolls.
    paperWidthMm: 80,
  },
};

function load() {
  if (typeof window === "undefined") return structuredClone(defaults);
  try {
    const raw = localStorage.getItem(userKey(STORAGE_KEY));
    const user = getCurrentUser();
    const dynamicDefaults = structuredClone(defaults);
    if (user) {
      if (user.salonName) dynamicDefaults.salon.name = user.salonName;
      if (user.phone) dynamicDefaults.salon.phone = user.phone;
      if (user.email) dynamicDefaults.salon.email = user.email;
    }
    if (!raw) return dynamicDefaults;
    // Deep merge so new default keys are always present
    const saved = JSON.parse(raw);
    const wasender = { ...dynamicDefaults.wasender, ...saved.wasender };
    // Migrate the old anti-ban default (1–3 minutes) to the safer 5–10 minute
    // default, while preserving any custom non-default values a salon chose.
    if (wasender.randomDelayMinSeconds === 60 && wasender.randomDelayMaxSeconds === 180) {
      wasender.randomDelayMinSeconds = dynamicDefaults.wasender.randomDelayMinSeconds;
      wasender.randomDelayMaxSeconds = dynamicDefaults.wasender.randomDelayMaxSeconds;
    }
    // WhatsApp provider keys are admin-managed and kept on the server. A copy
    // cached before that change is dropped here, keeping only the fact that one
    // was set — the next settings sync replaces it with the server's `connected`.
    const cached = wasender as Record<string, unknown>;
    if (cached.connected === undefined && activeCredential(cached)) cached.connected = true;
    for (const k of Object.keys(cached)) if (isProviderField(k)) cached[k] = "";

    return {
      replicate: { ...dynamicDefaults.replicate, ...saved.replicate },
      huggingface: { ...dynamicDefaults.huggingface, ...saved.huggingface },
      salon: {
        ...dynamicDefaults.salon,
        ...saved.salon,
        name: saved.salon?.name && saved.salon.name !== "Amna's Salon"
          ? saved.salon.name
          : (user?.salonName || dynamicDefaults.salon.name),
        phone: saved.salon?.phone && saved.salon.phone !== "0300-1234567"
          ? saved.salon.phone
          : (user?.phone || dynamicDefaults.salon.phone),
        email: saved.salon?.email && saved.salon.email !== "amna@werzio.pk"
          ? saved.salon.email
          : (user?.email || dynamicDefaults.salon.email),
      },
      wasender,
      locations: {
        ...dynamicDefaults.locations,
        ...saved.locations,
        items: Array.isArray(saved.locations?.items) && saved.locations.items.length > 0
          ? saved.locations.items
          : dynamicDefaults.locations.items,
      },
      activeSection: typeof saved.activeSection === "string" ? saved.activeSection : dynamicDefaults.activeSection,
      hours: saved.hours ?? structuredClone(dynamicDefaults.hours),
      attendance: { ...dynamicDefaults.attendance, ...saved.attendance },
      notifications: { ...dynamicDefaults.notifications, ...saved.notifications },
      appearance: { ...dynamicDefaults.appearance, ...saved.appearance },
      whatsapp: { ...dynamicDefaults.whatsapp, ...saved.whatsapp },
      birthday: { ...dynamicDefaults.birthday, ...saved.birthday },
      winback:  { ...dynamicDefaults.winback,  ...saved.winback  },
      loyalty:  { ...dynamicDefaults.loyalty,  ...saved.loyalty  },
      cashback: { ...dynamicDefaults.cashback, ...saved.cashback },
      printer:  { ...dynamicDefaults.printer,  ...saved.printer  },
      payments: {
        ...dynamicDefaults.payments,
        ...saved.payments,
        jazzcash:  { ...dynamicDefaults.payments.jazzcash,  ...saved.payments?.jazzcash },
        easypaisa: { ...dynamicDefaults.payments.easypaisa, ...saved.payments?.easypaisa },
        bank:      { ...dynamicDefaults.payments.bank,      ...saved.payments?.bank },
      },
    };
  } catch {
    return structuredClone(defaults);
  }
}

function persist() {
  if (typeof window === "undefined") return;
  localStorage.setItem(userKey(STORAGE_KEY), JSON.stringify(settingsStore));
  // Stamped so syncFromDB() can tell a locally-saved edit apart from stale
  // server data — see the settings block in lib/turso-sync.ts for why this
  // matters (the DB push below is fire-and-forget and can still be in flight,
  // or can fail silently, when the next page load's sync runs).
  localStorage.setItem(userKey(SAVED_AT_KEY), new Date().toISOString());
}

export const settingsStore = load();

export function reloadSettings() {
  const newSettings = load();
  // Clear and update settingsStore in place so existing imports get the new data
  for (const key of Object.keys(settingsStore)) {
    delete (settingsStore as any)[key];
  }
  Object.assign(settingsStore, newSettings);
}

/**
 * Call after mutating any section to persist changes. Saves locally (always,
 * synchronously) and returns the Turso write's outcome — most callers don't
 * await it (fire-and-forget, doesn't block the UI), but a caller that wants
 * to confirm the save actually reached the shared database (e.g. the Salon
 * Profile form) can await the result and warn on failure instead of the
 * change silently reverting on the next refresh.
 */
export function saveSettings(): Promise<boolean> {
  persist();
  const dbSaved = saveSettingsToDB(settingsStore);
  applyAppearanceSettings();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
  }
  return dbSaved;
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized;
  const num = Number.parseInt(value, 16);
  if (Number.isNaN(num)) return { r: 124, g: 58, b: 237 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function applyAppearanceSettings() {
  if (typeof document === "undefined") return;
  // Brand gradient: always locked to the purple palette regardless of any saved value
  const GRAD_START = "#5B21B6";
  const GRAD_END   = "#9333EA";
  const ACCENT     = "#7C3AED";
  const { r, g, b } = hexToRgb(ACCENT);
  document.documentElement.style.setProperty("--accent",            ACCENT);
  document.documentElement.style.setProperty("--accent-dark",       GRAD_START);
  document.documentElement.style.setProperty("--accent-end",        GRAD_END);
  document.documentElement.style.setProperty("--accent-light",      "#A78BFA");
  document.documentElement.style.setProperty("--accent-gradient",   `linear-gradient(135deg, ${GRAD_START} 0%, ${GRAD_END} 100%)`);
  document.documentElement.style.setProperty("--accent-gradient-r", `linear-gradient(135deg, ${GRAD_END} 0%, ${GRAD_START} 100%)`);
  document.documentElement.style.setProperty("--accent-dim",        `rgba(${r}, ${g}, ${b}, 0.10)`);
  document.documentElement.style.setProperty("--accent-glow",       `rgba(${r}, ${g}, ${b}, 0.28)`);
}
