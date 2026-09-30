"use client";

/**
 * Services folded into one collapsible row per category, shared by the client
 * app's menu and the booking sheet's service step.
 *
 * A salon's menu runs to dozens of services; laid out flat it was a scroll of
 * several phone screens before reaching anything past the first category.
 * Folded, the whole menu fits on roughly one screen and a customer opens only
 * the category they came for.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Service } from "@/lib/types";
import { categoryLabel, groupByCategory, groupBySubcategory } from "@/lib/service-groups";

/** A category's rows, under sub-headings when the salon has sub-categories. */
function GroupRows({ items, renderRow }: { items: Service[]; renderRow: (s: Service) => ReactNode }) {
  const subs = groupBySubcategory(items);
  if (subs.length === 1 && subs[0][0] === null) return <ul className="sg-rows">{items.map(renderRow)}</ul>;
  return (
    <>
      {subs.map(([sub, rows]) => (
        <div key={sub ?? "_"} className="sg-subgroup">
          {sub && <div className="sg-sub">{sub}</div>}
          <ul className="sg-rows">{rows.map(renderRow)}</ul>
        </div>
      ))}
    </>
  );
}

export default function ServiceGroups({
  services, renderRow, formatMoney, selectedIds = [], initiallyOpen = [],
}: {
  services: Service[];
  renderRow: (s: Service) => ReactNode;
  formatMoney: (n: number) => string;
  /** Ids already picked; a folded category shows how many of them it holds. */
  selectedIds?: string[];
  initiallyOpen?: string[];
}) {
  const groups = groupByCategory(services);
  const [open, setOpen] = useState<Set<string>>(() => new Set(initiallyOpen));

  // One category needs no folding.
  if (groups.length <= 1) return <GroupRows items={services} renderRow={renderRow} />;

  const toggle = (cat: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });

  return (
    <div className="sg-root">
      {groups.map(([cat, items]) => {
        const isOpen = open.has(cat);
        const from = Math.min(...items.map((s) => (s.variablePrice && s.priceRangeMin != null ? s.priceRangeMin : s.price) || 0));
        const picked = items.filter((s) => selectedIds.includes(s.id)).length;
        return (
          <section key={cat} className={`sg-group${isOpen ? " sg-open" : ""}`}>
            <button className="sg-head" onClick={() => toggle(cat)} aria-expanded={isOpen}>
              <span className="sg-head-main">
                <span className="sg-head-name">{categoryLabel(cat)}</span>
                <span className="sg-head-meta">
                  {items.length} service{items.length === 1 ? "" : "s"} · from {formatMoney(from)}
                </span>
              </span>
              {picked > 0 && <span className="sg-badge">{picked}</span>}
              <ChevronDown size={17} className="sg-chev" />
            </button>
            {isOpen && <div className="sg-body"><GroupRows items={items} renderRow={renderRow} /></div>}
          </section>
        );
      })}
      <style>{`
        .sg-root { display: flex; flex-direction: column; }
        .sg-group + .sg-group { border-top: 1px solid #f1eff7; }
        .sg-head {
          width: 100%; display: flex; align-items: center; gap: 10px; text-align: left;
          padding: 13px 15px; background: transparent; border: none; cursor: pointer;
          font: inherit; color: #1a1a2e;
        }
        .sg-head:active { background: var(--ca-accent-dim, rgba(124,58,237,.08)); }
        .sg-head-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .sg-head-name { font-size: 14.5px; font-weight: 750; text-transform: capitalize; }
        .sg-head-meta { font-size: 11.5px; color: #8b8ba3; margin-top: 2px; }
        .sg-badge {
          min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
          background: var(--ca-accent, #7C3AED); color: #fff;
          font-size: 11px; font-weight: 800; display: grid; place-items: center;
        }
        .sg-chev { color: #b9b7c9; flex-shrink: 0; transition: transform .18s ease; }
        .sg-open .sg-chev { transform: rotate(180deg); color: var(--ca-accent, #7C3AED); }
        .sg-open .sg-head { background: #faf9fd; }
        .sg-rows { list-style: none; margin: 0; padding: 0; }
        .sg-rows > li + li { border-top: 1px solid #f4f2f9; }
        .sg-open .sg-body { border-top: 1px solid #f1eff7; }
        .sg-sub {
          padding: 10px 15px 6px; background: #faf9fd;
          font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
          color: var(--ca-accent, #7C3AED);
        }
        .sg-subgroup + .sg-subgroup { border-top: 1px solid #f1eff7; }
      `}</style>
    </div>
  );
}
