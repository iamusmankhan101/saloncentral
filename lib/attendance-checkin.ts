/**
 * QR attendance check-in — rules shared by the setup screen, the staff
 * check-in page and the API route that records it.
 *
 * A printed code at reception opens /checkin/<salonId>?t=<token>. The staff
 * member must be signed in with their own staff login, and their phone's
 * location must be within `radius` metres of the salon's saved position. The
 * token only proves the scan came from the salon's own printed code; the
 * staff login decides who is checking in, and the distance check stops a photo
 * of the code from working from home.
 */

export interface QrCheckinSettings {
  /** Secret in the printed QR. Resetting it retires every printed copy. */
  token: string;
  lat?: number;
  lng?: number;
  /** Allowed distance from the salon, in metres. */
  radius: number;
  /** Minutes after opening time before a check-in counts as Late. */
  lateAfterMinutes: number;
}

export const DEFAULT_CHECKIN_RADIUS = 100;
export const DEFAULT_LATE_AFTER_MINUTES = 15;
/** Phones reporting a fix worse than this are asked to turn on precise location. */
export const MAX_ACCEPTED_ACCURACY = 1000;
/** A second scan sooner than this after checking in is treated as a double scan, not a check-out. */
export const MIN_MINUTES_BEFORE_CHECKOUT = 5;

export function newCheckinToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Great-circle distance in metres. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Is a phone at `pos` (with a GPS uncertainty of `accuracy` metres) at the
 * salon? The uncertainty is given back, up to 150 m, so a phone indoors with a
 * weak fix isn't turned away from inside the building.
 */
export function isWithinSalon(
  settings: Pick<QrCheckinSettings, "lat" | "lng" | "radius">,
  pos: { lat: number; lng: number; accuracy: number },
): { ok: boolean; distance: number } {
  if (settings.lat == null || settings.lng == null) return { ok: false, distance: Infinity };
  const distance = distanceMeters({ lat: settings.lat, lng: settings.lng }, pos);
  const slack = Math.min(Math.max(pos.accuracy, 0), 150);
  return { ok: distance - slack <= settings.radius, distance };
}

/** "HH:MM" → minutes since midnight. */
export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "14:05" → "2:05 PM" */
export function time12(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
