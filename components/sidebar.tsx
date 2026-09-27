"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard, CalendarDays, Users, ClipboardList, MessageSquare,
  UserCog, BarChart3, Package, Globe, Sparkles, CreditCard, Scissors,
  CircleUserRound, LogOut, Shield, Wand2, ReceiptText, ShoppingCart,
  X, Gift, Banknote, ChevronRight, ChevronDown, MapPin, Check, Wallet, Star,
  ClipboardCheck, Store, Landmark, Archive, Smartphone, FileText,
} from "lucide-react";
import { AuthUser, getCurrentUser, signOut } from "@/lib/auth";
import { SETTINGS_CHANGED_EVENT, settingsStore, reloadSettings } from "@/lib/settings-store";
import { getCurrentPlan } from "@/lib/plan-limits";
import { getActiveLocationFilter, getSalonLocations, setActiveLocationFilter, type SalonLocation } from "@/lib/locations";

const NAV_GROUPS: {
  label: string;
  items: { href: string; icon: React.ElementType; label: string; dynamicHref?: boolean; newTab?: boolean }[];
}[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard",              icon: LayoutDashboard, label: "Dashboard"    },
      { href: "/dashboard/calendar",     icon: CalendarDays,    label: "Calendar"     },
      { href: "/dashboard/appointments", icon: ClipboardList,   label: "Appointments" },
    ],
  },
  {
    label: "Clients & Sales",
    items: [
      { href: "/dashboard/clients",  icon: Users,        label: "Clients"  },
      { href: "/dashboard/pos",      icon: ShoppingCart, label: "POS"      },
      { href: "/dashboard/invoices", icon: ReceiptText,  label: "Invoices" },
      { href: "/dashboard/loyalty",  icon: Gift,         label: "Loyalty"  },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/dashboard/revenue",    icon: BarChart3, label: "Revenue"   },
      { href: "/dashboard/cash-flow",  icon: Banknote,  label: "Cash Flow" },
      { href: "/dashboard/inventory",  icon: Package,   label: "Inventory" },
      { href: "/dashboard/services",   icon: Scissors,  label: "Services"  },
      { href: "/dashboard/staff",      icon: UserCog,   label: "Staff"     },
      { href: "/dashboard/attendance", icon: ClipboardCheck, label: "Attendance" },
      { href: "/dashboard/payouts",    icon: Wallet,    label: "Payouts"   },
    ],
  },
  {
    label: "Marketing",
    items: [
      { href: "/dashboard/messages", icon: MessageSquare, label: "WhatsApp"       },
      { href: "/dashboard/feedback", icon: Star,          label: "Feedback"       },
      { href: "/online-booking",     icon: Globe,         label: "Online Booking", dynamicHref: true, newTab: true },
      { href: "/dashboard/client-app", icon: Smartphone,  label: "Client App"     },
      { href: "/dashboard/try-on",   icon: Wand2,         label: "Virtual Try-On" },
    ],
  },
];

const SETTINGS_NAV = [
  { href: "/dashboard/account", icon: CircleUserRound, label: "Account" },
  { href: "/dashboard/billing", icon: CreditCard,      label: "Billing" },
];

// Platform-admin only. A real admin account has no salon — just the controls
// for running the platform: payment requests, salon accounts, payment
// methods, users, and backups.
const ADMIN_NAV: { tab: string; icon: React.ElementType; label: string }[] = [
  { tab: "dashboard",     icon: LayoutDashboard, label: "Dashboard" },
  { tab: "requests",      icon: Shield,     label: "Payment Requests" },
  { tab: "salons",        icon: Store,      label: "Salon Accounts" },
  { tab: "paymentMethods", icon: Landmark,  label: "Payment Methods" },
  { tab: "invoiceDetails", icon: FileText,  label: "Invoice Details" },
  { tab: "users",         icon: Users,      label: "Users" },
  { tab: "backups",       icon: Archive,    label: "Backups" },
];

export default function Sidebar({ isOpen, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router   = useRouter();
  const searchParams = useSearchParams();
  const [user,      setUser]      = useState<AuthUser | null>(null);
  const [salonName, setSalonName] = useState("Salon Central");
  const [salonLogo, setSalonLogo] = useState("");
  const [planBadge, setPlanBadge] = useState({ badge: "FREE", color: "#6b7280", bg: "#f9fafb" });
  const [profileOpen, setProfileOpen] = useState(false);
  const [locations, setLocations] = useState<SalonLocation[]>([]);
  const [activeLocationId, setActiveLocationId] = useState("main");
  const [multiLocationEnabled, setMultiLocationEnabled] = useState(false);
  // Short /book/<slug> link; the old ?salon=<id> link is the fallback until it loads.
  const [bookingPath, setBookingPath] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch("/api/booking-link", { cache: "no-store" })
      .then((res) => res.json() as Promise<{ ok?: boolean; slug?: string }>)
      .then((data) => { if (!cancelled && data.ok && data.slug) setBookingPath(`/book/${data.slug}`); })
      .catch(() => { /* keep the fallback link */ });
    return () => { cancelled = true; };
  }, [user]);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function sync() {
      reloadSettings();
      setUser(getCurrentUser());
      setSalonName(settingsStore.salon.name || getCurrentUser()?.salonName || "Salon Central");
      setSalonLogo(settingsStore.salon.logo || "");
      const plan = getCurrentPlan();
      setPlanBadge({ badge: plan.badge, color: plan.color, bg: plan.bg });
      setMultiLocationEnabled(plan.multiLocation);
      setLocations(getSalonLocations());
      setActiveLocationId(getActiveLocationFilter());
    }
    const t = window.setTimeout(sync, 0);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => { window.clearTimeout(t); window.removeEventListener(SETTINGS_CHANGED_EVENT, sync); };
  }, [pathname]);

  useEffect(() => {
    function closeProfileMenu(event: PointerEvent) {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileOpen(false);
    }
    document.addEventListener("pointerdown", closeProfileMenu);
    return () => document.removeEventListener("pointerdown", closeProfileMenu);
  }, []);

  async function handleSignOut() {
    await signOut();
    router.replace("/sign-in");
    router.refresh();
  }

  const initials = (user?.ownerName || salonName || "W")
    .split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  const isStaffUser = user?.role === "staff";
  const isAdminUser = user?.role === "admin";
  const canSwitchLocation = !isStaffUser && multiLocationEnabled && locations.length > 1;

  function switchLocation(locationId: string) {
    const nextId = setActiveLocationFilter(locationId);
    setActiveLocationId(nextId);
    setProfileOpen(false);
    window.location.reload();
  }
  
  const canAccess = (href: string) => {
    if (!isStaffUser) return true;
    if (user.permissions?.includes("*")) return true;
    const key = href === "/dashboard"
      ? "dashboard"
      : href.replace("/dashboard/", "").split("/")[0];
    return user.permissions?.includes(key) ?? false;
  };

  const NavItem = ({ href, icon: Icon, label, active: activeOverride, newTab }: { href: string; icon: React.ElementType; label: string; active?: boolean; newTab?: boolean }) => {
    const active = activeOverride !== undefined
      ? activeOverride
      : (pathname === href || (href !== "/dashboard" && pathname.startsWith(href)));
    return (
      <Link href={href} onClick={onClose} className={`sb-item${active ? " sb-active" : ""}`}
        {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        <span className="sb-item-icon"><Icon size={15} /></span>
        <span className="sb-item-label">{label}</span>
        {active && <span className="sb-item-dot" />}
      </Link>
    );
  };

  const adminTab = pathname.startsWith("/dashboard/admin")
    ? (searchParams.get("tab") ?? "dashboard")
    : "";

  return (
    <>
      <style>{`
        .sb-item {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 8px 11px;
          border-radius: 9px;
          font-size: 13px;
          font-weight: 500;
          color: #f5f3ff;
          text-decoration: none;
          transition: background 0.13s, color 0.13s;
          margin-bottom: 1px;
          position: relative;
        }
        .sb-item:hover {
          background: rgba(124,58,237,0.09);
          color: #fff;
        }
        .sb-active {
          background: linear-gradient(135deg,#5B21B6,#7C3AED) !important;
          color: #fff !important;
          font-weight: 650;
          box-shadow: 0 2px 14px rgba(91,33,182,0.38);
        }
        .sb-active .sb-item-icon { opacity: 1; }
        .sb-item-icon { opacity: 0.75; display: flex; align-items: center; flex-shrink: 0; }
        .sb-item-label { flex: 1; }
        .sb-item-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: rgba(255,255,255,0.6); flex-shrink: 0;
        }
        .sb-section {
          font-size: 10px;
          font-weight: 700;
          color: rgba(255,255,255,0.68);
          letter-spacing: 0.12em;
          text-transform: uppercase;
          padding: 10px 11px 5px;
        }
        .sb-nav::-webkit-scrollbar { width: 3px; }
        .sb-nav::-webkit-scrollbar-thumb { background: #222234; border-radius: 3px; }
        .sb-signout {
          width: 100%;
          border: 1px solid #1e1e2e;
          background: transparent;
          color: #fff;
          border-radius: 10px;
          padding: 9px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          transition: background 0.13s, color 0.13s, border-color 0.13s;
        }
        .sb-signout:hover {
          background: rgba(239,68,68,0.08);
          border-color: rgba(239,68,68,0.25);
          color: #f87171;
        }
        .sb-upgrade:hover { opacity: 0.88; }
        .sb-profile-menu-item {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: rgba(255,255,255,.82);
          font-size: 11px;
          font-weight: 600;
          text-decoration: none;
          cursor: pointer;
          box-sizing: border-box;
          text-align: left;
        }
        .sb-profile-menu-item:hover { background: rgba(124,58,237,.18); color: #fff; }
      `}</style>

      <aside
        className={isOpen ? "active" : ""}
        style={{
          width: "var(--sidebar-width)",
          height: "100vh",
          background: "#0d0d14",
          display: "flex",
          flexDirection: "column",
          position: "fixed",
          top: 0, left: 0,
          zIndex: 50,
          overflow: "hidden",
          borderRight: "1px solid #18182a",
        }}
      >

        {/* ── Logo row ─────────────────────────────────────── */}
        <div style={{
          padding: "15px 16px 13px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          borderBottom: "1px solid #18182a",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              aria-label="Close navigation"
              className="mobile-close-btn"
              onClick={onClose}
              style={{
                background: "rgba(255,255,255,0.04)", border: "1px solid #252538",
                color: "#5a5a82", cursor: "pointer", padding: "5px 6px",
                borderRadius: 8, display: "none", alignItems: "center", justifyContent: "center",
              }}
            >
              <X size={15} />
            </button>
            <img
              src="/salon-central-logo.png"
              alt="Salon Central"
              className="sidebar-logo"
              style={{ userSelect: "none", pointerEvents: "none" }}
            />
          </div>

          <div
            className="sidebar-live-badge"
            style={{
              display: "flex", alignItems: "center", gap: 5,
              background: "rgba(124,58,237,0.13)",
              border: "1px solid rgba(124,58,237,0.28)",
              borderRadius: 20, padding: "3px 9px 3px 6px",
            }}
          >
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: "#a78bfa", boxShadow: "0 0 7px #7C3AED",
            }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", letterSpacing: "0.07em" }}>LIVE</span>
          </div>
        </div>

        {/* ── Profile chip ─────────────────────────────────── */}
        <div ref={profileMenuRef} style={{ padding: "10px 12px 12px", borderBottom: "1px solid #18182a", position: "relative" }}>
          <button type="button" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen} aria-label="Open account menu" style={{
            width: "100%",
            display: "flex", alignItems: "center", gap: 10,
            padding: "11px 12px",
            borderRadius: 12,
            background: "linear-gradient(135deg,rgba(91,33,182,.22),rgba(30,27,75,.36))",
            border: "1px solid rgba(167,139,250,.18)",
            cursor: "pointer",
            textAlign: "left",
          }}>
            {/* Avatar */}
            <div style={{
              width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
              background: "linear-gradient(135deg,#7C3AED,#A855F7)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 800, color: "#fff",
              boxShadow: "0 2px 10px rgba(91,33,182,0.55)",
              border: "2px solid rgba(255,255,255,.82)",
            }}>
              {salonLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={salonLogo}
                  alt={`${salonName} logo`}
                  style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
                />
              ) : initials}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontWeight: 700, fontSize: 13, color: "#fff",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {user?.ownerName || salonName}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.68)", textTransform: "capitalize", marginTop: 2 }}>
                {user?.role === "admin" ? "Platform Admin" : user?.role === "owner" ? "Salon Admin" : user?.role === "manager" ? "Salon Manager" : user?.role || "Salon Admin"}
              </div>
            </div>

            <ChevronDown size={15} color="rgba(255,255,255,.72)" style={{ flexShrink: 0, transform: profileOpen ? "rotate(180deg)" : "none", transition: "transform .18s" }} />
          </button>

          {profileOpen && (
            <div style={{ marginTop: 7, padding: 6, borderRadius: 11, background: "#151522", border: "1px solid #292940", boxShadow: "0 12px 30px rgba(0,0,0,.32)" }}>
              {!isAdminUser && (
                <>
                  <Link href="/dashboard/account" onClick={() => { setProfileOpen(false); onClose?.(); }} className="sb-profile-menu-item">
                    <CircleUserRound size={13} /> {isStaffUser ? "My Account" : "Account & Salon Settings"}
                  </Link>
                  {!isStaffUser && (
                    <>
                      <Link href="/dashboard/account?section=roles" onClick={() => { setProfileOpen(false); onClose?.(); }} className="sb-profile-menu-item">
                        <Shield size={13} /> Roles & Permissions
                      </Link>
                      <Link href="/dashboard/billing" onClick={() => { setProfileOpen(false); onClose?.(); }} className="sb-profile-menu-item">
                        <CreditCard size={13} /> Billing & Current Plan
                      </Link>
                    </>
                  )}
                </>
              )}
              {!isAdminUser && canSwitchLocation && (
                <div style={{ borderTop: "1px solid #292940", marginTop: 5, paddingTop: 5 }}>
                  <div style={{ padding: "4px 10px 5px", fontSize: 9, fontWeight: 800, color: "#777794", textTransform: "uppercase", letterSpacing: ".08em" }}>Switch Location</div>
                  {locations.map((location) => (
                    <button key={location.id} type="button" onClick={() => switchLocation(location.id)} className="sb-profile-menu-item">
                      <MapPin size={13} />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{location.name}</span>
                      {location.id === activeLocationId && <Check size={12} color="#a78bfa" />}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" onClick={handleSignOut} className="sb-profile-menu-item" style={{ borderTop: "1px solid #292940", borderRadius: 0, marginTop: 5, paddingTop: 10, color: "#fca5a5" }}>
                <LogOut size={13} /> Sign Out
              </button>
            </div>
          )}
          {!isAdminUser && (
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 5px 0" }}>
            <span style={{
              borderRadius: 6, padding: "2px 7px",
              background: planBadge.bg + "18",
              border: `1px solid ${planBadge.color}40`,
              fontSize: 9, fontWeight: 800, color: planBadge.color, letterSpacing: "0.08em",
            }}>
              {planBadge.badge}
            </span>
          </div>
          )}
        </div>

        {/* ── Navigation ───────────────────────────────────── */}
        <nav className="sb-nav" style={{ flex: 1, padding: "6px 8px 8px", overflowY: "auto" }}>
          {isAdminUser ? (
            <>
              <div className="sb-section">Platform Admin</div>
              {ADMIN_NAV.map((item) => (
                <NavItem
                  key={item.tab}
                  href={`/dashboard/admin?tab=${item.tab}`}
                  icon={item.icon}
                  label={item.label}
                  active={adminTab === item.tab}
                />
              ))}
            </>
          ) : (
            <>
              {NAV_GROUPS.map((group) => {
                const visibleItems = group.items.filter((item) => canAccess(item.href));
                if (visibleItems.length === 0) return null;
                return (
                <div key={group.label}>
                  <div className="sb-section">{group.label}</div>
                  {visibleItems.map((item) => (
                    <NavItem
                      key={item.href}
                      href={item.dynamicHref && user ? (bookingPath ?? `${item.href}?salon=${encodeURIComponent(user.salonOwnerId || user.id)}`) : item.href}
                      icon={item.icon}
                      label={item.label}
                      newTab={item.newTab}
                    />
                  ))}
                </div>
              )})}

              {!isStaffUser && (
                <>
                  <div className="sb-section" style={{ paddingTop: 12 }}>Settings</div>
                  {SETTINGS_NAV.map((item) => <NavItem key={item.href} {...item} />)}
                </>
              )}
            </>
          )}
        </nav>

        {/* ── Bottom: upgrade + sign out ───────────────────── */}
        <div style={{ padding: "10px 12px 16px", borderTop: "1px solid #18182a" }}>
          {!isAdminUser && !isStaffUser && planBadge.badge !== "PREMIUM" && (
            <Link href="/dashboard/billing" className="sb-upgrade" style={{ display: "block", textDecoration: "none", marginBottom: 8, transition: "opacity 0.15s" }}>
              <div style={{
                borderRadius: 13,
                background: "linear-gradient(135deg,#5B21B6,#7C3AED)",
                border: "1px solid rgba(196,181,253,0.35)",
                boxShadow: "0 4px 20px rgba(124,58,237,0.35)",
                padding: "12px 13px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: "rgba(255,255,255,0.18)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    <Sparkles size={13} color="#fff" />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", flex: 1 }}>
                    {planBadge.badge === "FREE" ? "Upgrade to Pro" : "Upgrade to Premium"}
                  </span>
                  <ChevronRight size={13} color="#fff" style={{ flexShrink: 0 }} />
                </div>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.82)", lineHeight: 1.55, margin: 0 }}>
                  {planBadge.badge === "FREE"
                    ? "Unlimited appointments, staff & clients"
                    : "Multi-location branches & Virtual Try-On"}
                </p>
              </div>
            </Link>
          )}

          <button onClick={handleSignOut} className="sb-signout">
            <LogOut size={13} />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
