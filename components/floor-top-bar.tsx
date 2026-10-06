"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth";
import { NAV_GROUPS, canAccessHref } from "@/components/sidebar";

/**
 * Slim top header used instead of the left sidebar on full-screen pages (the
 * Salon Floor), so the 3D map gets the whole width. Quick links cover the
 * day-to-day pages; ☰ opens the full sidebar as a drawer for everything else.
 */
export default function FloorTopBar({ onMenu, sectionSwitcher }: { onMenu: () => void; sectionSwitcher?: ReactNode }) {
  const pathname = usePathname();
  const user = getCurrentUser();
  const links = NAV_GROUPS.slice(0, 2).flatMap((g) => g.items).filter((i) => !i.dynamicHref && canAccessHref(user, i.href));
  const name = user?.ownerName || user?.salonName || "";
  const initials = name.split(" ").filter(Boolean).map((w) => w[0]).join("").toUpperCase().slice(0, 2) || "SC";
  const role = user?.role === "owner" ? "Salon Admin" : user?.role === "manager" ? "Manager" : user?.role === "staff" ? "Staff" : "";

  return (
    <header className="ftb">
      <style>{`
        .ftb{position:sticky;top:0;z-index:40;height:60px;display:flex;align-items:center;gap:14px;padding:0 16px;background:#0d0d14;border-bottom:1px solid #18182a}
        .ftb-menu{width:36px;height:36px;border-radius:10px;border:1px solid #252538;background:rgba(255,255,255,.04);color:#c4c4dc;display:grid;place-items:center;cursor:pointer;flex-shrink:0}
        .ftb-menu:hover{color:#fff;background:rgba(124,58,237,.2)}
        .ftb-nav{display:flex;gap:2px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
        .ftb-nav::-webkit-scrollbar{display:none}
        .ftb-link{display:flex;align-items:center;gap:7px;padding:8px 12px;border-radius:10px;color:#9a9ab8;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap}
        .ftb-link:hover{color:#fff;background:rgba(255,255,255,.05)}
        .ftb-link.on{color:#fff;background:linear-gradient(135deg,#7C3AED,#6d28d9);box-shadow:0 4px 14px rgba(124,58,237,.35)}
        .ftb-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
        .ftb-right select{padding:7px 28px 7px 10px!important;border-radius:10px!important;border:1px solid #252538!important;background:#15151f!important;color:#e4e4f0!important;font-size:12px!important;min-width:0!important;box-shadow:none!important}
        .ftb-user{display:flex;align-items:center;gap:9px;padding:4px 10px 4px 4px;border-radius:12px;border:1px solid #252538;text-decoration:none}
        .ftb-avatar{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#7C3AED,#a855f7);color:#fff;font-size:11px;font-weight:800;display:grid;place-items:center}
        @media (max-width: 980px){ .ftb-nav{display:none} .ftb{justify-content:space-between} .ftb-user-text{display:none} }
      `}</style>

      <button type="button" className="ftb-menu" aria-label="Open menu" title="All pages" onClick={onMenu}><Menu size={17} /></button>
      <Link href="/dashboard" aria-label="Salon Central home" style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/salon-central-logo.png" alt="Salon Central" style={{ height: 26, width: "auto" }} />
      </Link>

      <nav className="ftb-nav" aria-label="Main">
        {links.map(({ href, icon: Icon, label }) => (
          <Link key={href} href={href} className={`ftb-link${pathname === href ? " on" : ""}`}>
            <Icon size={15} /> {label}
          </Link>
        ))}
      </nav>

      <div className="ftb-right">
        {sectionSwitcher}
        <Link href={user?.role === "staff" ? "/dashboard" : "/dashboard/account"} className="ftb-user">
          <span className="ftb-avatar">{initials}</span>
          <span className="ftb-user-text" style={{ lineHeight: 1.2 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#fff" }}>{name}</span>
            <span style={{ display: "block", fontSize: 10, color: "#7a7a9a" }}>{role}</span>
          </span>
        </Link>
      </div>
    </header>
  );
}
