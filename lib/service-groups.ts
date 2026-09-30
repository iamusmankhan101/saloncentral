/**
 * How services are grouped for display: by category, then by the optional
 * sub-category inside it. Shared by the customer booking menus (client app
 * and online booking page) so both read the same way as the Services page.
 */

import type { Service } from "./types";

/** Display names for the built-in category values; custom categories show as typed. */
const BUILT_IN_LABELS: Record<string, string> = {
  hair: "Hair Care",
  skin: "Skin Care",
  nails: "Nails",
  bridal: "Bridal",
  piercing: "Ear Piercing",
  package: "Deals & Packages",
};

export function categoryLabel(category: string | undefined): string {
  const cat = category?.trim() || "Other";
  return BUILT_IN_LABELS[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
}

/** Categories with their services, biggest first. Keys are the raw category values. */
export function groupByCategory<T extends Pick<Service, "category">>(services: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const s of services) {
    const cat = s.category?.trim() || "Other";
    groups.set(cat, [...(groups.get(cat) ?? []), s]);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

/**
 * A category's services split by sub-category, in the order each sub-category
 * first appears (the salon's own menu order). Services without one come first
 * under a null heading. A category with no sub-categories at all comes back as
 * a single null group, so callers can skip headings entirely.
 */
export function groupBySubcategory<T extends Pick<Service, "subcategory">>(services: T[]): [string | null, T[]][] {
  const groups = new Map<string | null, T[]>();
  const loose = services.filter((s) => !s.subcategory?.trim());
  if (loose.length) groups.set(null, loose);
  for (const s of services) {
    const sub = s.subcategory?.trim();
    if (sub) groups.set(sub, [...(groups.get(sub) ?? []), s]);
  }
  return [...groups.entries()];
}
