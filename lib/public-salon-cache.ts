/**
 * Cache for a salon's public booking-page data (services, staff names, public
 * settings) served by /api/public/salon. It lives in Next's shared data cache
 * (shared by every server instance on Vercel), so booking pages, the client app
 * and loyalty cards don't re-read three large salon_data rows on every visit.
 *
 * Anything that changes services, staff or settings must call
 * invalidatePublicSalon(salonId) after writing, so changes show immediately;
 * the cache also expires on its own after PUBLIC_SALON_TTL_S as a safety net.
 * Only the already-filtered public fields are cached — never keys or pay data.
 */

import { revalidateTag } from "next/cache";

export const PUBLIC_SALON_TTL_S = 300;

export function publicSalonTag(salonId: string): string {
  return `public-salon:${salonId}`;
}

/** Drop the salon's cached public data now. Never throws: a failed purge only means it expires on the TTL. */
export function invalidatePublicSalon(salonId: string): void {
  try {
    revalidateTag(publicSalonTag(salonId), { expire: 0 });
  } catch (err) {
    console.error("[public-salon-cache] invalidate failed:", err);
  }
}
