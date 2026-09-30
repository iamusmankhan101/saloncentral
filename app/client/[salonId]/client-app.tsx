"use client";

/**
 * The customer-facing app shell for /client/[salonId].
 *
 * Structured like a native app rather than a page: a compact sticky app bar,
 * a scrollable body, and a persistent booking CTA pinned above the home
 * indicator. The earlier layout spent the whole first screen on a header, so
 * the service menu — the reason anyone scans the code — started below the
 * fold.
 *
 * The QR code may also carry ?station= (which chair), ?staff= or ?c= (a known
 * customer id); those ride along into the push subscription so a broadcast can
 * later be narrowed to one person.
 */

import { Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import {
  BellRing, BellOff, CalendarPlus, Check, ChevronRight, Clock, CreditCard,
  MapPin, Phone, Scissors, Search, Sparkles, Wallet, X,
} from "lucide-react";
import type { Service } from "@/lib/types";
import InstallPrompt from "@/components/install-prompt";
import BookingSheet, { type BusinessHour, type PublicStaff } from "./booking-sheet";
import ServiceGroups from "./service-groups";
import { categoryLabel } from "@/lib/service-groups";
import { PaymentSheet, type PublicPayments } from "./payment-options";
import { resolveSalonTheme, type SalonTheme } from "@/lib/salon-theme";
import {
  checkPushSupport, getExistingSubscription, subscribeToPush, unsubscribeFromPush,
} from "@/lib/push-client";

interface SalonSettings {
  salon?: { name?: string; phone?: string; address?: string; logo?: string; currency?: string };
  appearance?: { accent?: string };
  hours?: BusinessHour[];
  payments?: PublicPayments;
}

interface SalonResponse {
  ok: boolean;
  error?: string;
  services?: Service[];
  staff?: PublicStaff[];
  settings?: SalonSettings;
}

function money(amount: number, currency = "PKR") {
  return `${currency} ${Math.round(amount).toLocaleString("en-PK")}`;
}

export default function ClientApp({ salonId }: { salonId: string }) {
  return (
    // useSearchParams needs a Suspense boundary for this route to stay statically shell-rendered.
    <Suspense fallback={<LoadingScreen />}>
      <ClientAppInner salonId={salonId} />
    </Suspense>
  );
}

/** Skeleton rather than a spinner: the shell is identical to the loaded layout,
 *  so the page doesn't visibly jump when data arrives. */
function LoadingScreen() {
  return (
    <div className="ca-root">
      <div className="ca-bar">
        <div className="ca-skel" style={{ width: 34, height: 34, borderRadius: 11 }} />
        <div className="ca-skel" style={{ width: 130, height: 15, borderRadius: 6 }} />
      </div>
      <div style={{ padding: "16px 16px 0", display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="ca-skel" style={{ height: 86, borderRadius: 18 }} />
        <div className="ca-skel" style={{ height: 62, borderRadius: 16 }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="ca-skel" style={{ height: 56, borderRadius: 14 }} />
        ))}
      </div>
      <Styles />
    </div>
  );
}

function ClientAppInner({ salonId }: { salonId: string }) {
  const searchParams = useSearchParams();
  const station  = searchParams.get("station");
  const clientId = searchParams.get("c");

  const [data, setData]       = useState<SalonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("all");
  const [search, setSearch]   = useState("");

  const [theme, setTheme]     = useState<SalonTheme | null>(null);

  const [subscribed, setSubscribed]   = useState(false);
  const [busy, setBusy]               = useState(false);
  const [pushMsg, setPushMsg]         = useState("");
  const [pushBlocked, setPushBlocked] = useState(false);
  const [offersHidden, setOffersHidden] = useState(false);

  // null = closed; "" = open with nothing preselected; an id = opened from that service's row.
  const [bookingFor, setBookingFor] = useState<string | null>(null);
  const [payOpen, setPayOpen]       = useState(false);

  // Remember which salon this device belongs to, so /client — the start_url
  // baked into apps installed before the per-salon manifest shipped — can send
  // them back here instead of showing a dead end.
  useEffect(() => {
    try {
      window.localStorage.setItem("salon-central:last-salon", salonId);
    } catch {
      /* private mode / blocked storage — the QR link still works */
    }
  }, [salonId]);

  // ─── Load the public salon data ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/salon?salonId=${encodeURIComponent(salonId)}`)
      .then((r) => r.json())
      .then((d: SalonResponse) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData({ ok: false, error: "Couldn't load this salon." }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [salonId]);

  // ─── Resolve this salon's colours ──────────────────────────────────────────
  // Reading the logo means decoding an image, so it can't be done during
  // render. resolveSalonTheme never rejects — a salon with no colour and no
  // readable logo resolves to the house purple.
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    resolveSalonTheme({
      chosenAccent: data.settings?.appearance?.accent,
      logo: data.settings?.salon?.logo,
    }).then((resolved) => { if (!cancelled) setTheme(resolved); });
    return () => { cancelled = true; };
  }, [data]);

  // ─── Reflect the device's existing push state ──────────────────────────────
  useEffect(() => {
    const support = checkPushSupport();
    if (!support.supported) {
      setPushMsg(support.reason);
      setPushBlocked(true);
      return;
    }
    if (Notification.permission === "denied") {
      setPushBlocked(true);
      setPushMsg("Notifications are blocked for this site in your browser settings.");
      return;
    }
    getExistingSubscription().then((sub) => setSubscribed(Boolean(sub)));
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setPushMsg("");
    const result = await subscribeToPush({ salonId, clientId });
    if (result.ok) {
      setSubscribed(true);
      setPushMsg("You're in — we'll let you know about offers and openings.");
    } else {
      setPushMsg(result.error);
      if (result.permissionDenied) setPushBlocked(true);
    }
    setBusy(false);
  }, [salonId, clientId]);

  const disable = useCallback(async () => {
    setBusy(true);
    await unsubscribeFromPush();
    setSubscribed(false);
    setPushMsg("Notifications turned off.");
    setBusy(false);
  }, []);

  const salon    = data?.settings?.salon ?? {};
  const currency = salon.currency || "PKR";
  const salonName = salon.name || "Our Salon";

  // Only live, bookable services — retired ones shouldn't appear on a menu.
  const services = useMemo(
    () => (data?.services ?? []).filter((s) => s.isActive !== false),
    [data],
  );

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of services) seen.set(s.category, (seen.get(s.category) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [services]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return services.filter((s) => {
      if (category !== "all" && s.category !== category) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
    });
  }, [services, category, search]);

  const serviceRow = (s: Service) => (
    <li key={s.id} className="ca-item" role="button" tabIndex={0}
      aria-label={`Book ${s.name}`}
      onClick={() => setBookingFor(s.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBookingFor(s.id); } }}
    >
      <div className="ca-item-main">
        <div className="ca-item-name">{s.name}</div>
        {s.description && <div className="ca-item-desc">{s.description}</div>}
      </div>
      <span className="ca-item-dur"><Clock size={11} /> {s.durationMin}m</span>
      <div className="ca-item-price">
        {s.variablePrice && s.priceRangeMin != null && s.priceRangeMax != null
          ? <>{money(s.priceRangeMin, currency)}<span className="ca-item-plus">+</span></>
          : money(s.price, currency)}
      </div>
    </li>
  );

  if (loading) return <LoadingScreen />;

  if (!data?.ok) {
    return (
      <div className="ca-root" style={{ display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 320 }}>
          <Scissors size={34} color="#c4c2d4" />
          <h1 style={{ fontSize: 17, color: "#1a1a2e", margin: "14px 0 6px" }}>Salon not found</h1>
          <p style={{ fontSize: 13.5, color: "#8b8ba3", lineHeight: 1.6 }}>
            {data?.error ?? "This link may have expired. Please ask reception for a fresh QR code."}
          </p>
        </div>
        <Styles />
      </div>
    );
  }

  // The skeleton is neutral grey, so holding it until the accent resolves is
  // what keeps a gold salon from flashing purple on every open.
  if (!theme) return <LoadingScreen />;

  const showOffers = !subscribed && !offersHidden && !pushBlocked;

  return (
    <div className="ca-root" style={theme.vars as CSSProperties}>
      {/* ── App bar ───────────────────────────────────────────────────────── */}
      <header className="ca-bar">
        {salon.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={salon.logo} alt="" className="ca-bar-logo" />
        ) : (
          <div className="ca-bar-logo ca-bar-logo-fallback"><Scissors size={16} /></div>
        )}
        <div className="ca-bar-text">
          <div className="ca-bar-name">{salonName}</div>
          {station && <div className="ca-bar-sub">Station {station}</div>}
        </div>
        <button
          onClick={subscribed ? disable : enable}
          disabled={busy || pushBlocked}
          aria-label={subscribed ? "Turn off notifications" : "Enable offers and notifications"}
          className={`ca-bell${subscribed ? " ca-bell-on" : ""}`}
        >
          {subscribed ? <BellRing size={17} /> : <BellOff size={17} />}
        </button>
      </header>

      <main className="ca-main">
        {/* ── Salon card ──────────────────────────────────────────────────── */}
        <section className="ca-hero">
          <div className="ca-hero-title">
            {station ? `Welcome to chair ${station}` : "Welcome in"}
          </div>
          <div className="ca-hero-name">{salonName}</div>
          <div className="ca-hero-actions">
            {salon.phone && (
              <a href={`tel:${salon.phone}`} className="ca-chip">
                <Phone size={13} /> Call
              </a>
            )}
            {salon.address && (
              <a
                href={`https://maps.google.com/?q=${encodeURIComponent(salon.address)}`}
                target="_blank"
                rel="noreferrer"
                className="ca-chip"
              >
                <MapPin size={13} /> Directions
              </a>
            )}
          </div>
        </section>

        {/* ── Offers opt-in ───────────────────────────────────────────────── */}
        {showOffers && (
          <section className="ca-offer">
            <div className="ca-offer-icon"><Sparkles size={17} /></div>
            <div className="ca-offer-text">
              <div className="ca-offer-title">Get offers & reminders</div>
              <div className="ca-offer-sub">Discounts and last-minute slots. No spam.</div>
            </div>
            <button onClick={enable} disabled={busy} className="ca-offer-btn">
              {busy ? "…" : "Enable"}
            </button>
            <button onClick={() => setOffersHidden(true)} aria-label="Dismiss" className="ca-offer-x">
              <X size={14} />
            </button>
          </section>
        )}

        {subscribed && pushMsg && (
          <div className="ca-note ca-note-ok"><Check size={14} /> {pushMsg}</div>
        )}
        {!subscribed && pushMsg && (
          <div className="ca-note ca-note-warn">{pushMsg}</div>
        )}

        <InstallPrompt accent={theme.accent} />

        {/* ── Quick actions ───────────────────────────────────────────────── */}
        <section className="ca-quick">
          <button onClick={() => setBookingFor("")} className="ca-quick-item">
            <CalendarPlus size={17} className="ca-quick-icon" />
            <span>Book</span>
            <ChevronRight size={15} color="#c4c2d4" style={{ marginLeft: "auto" }} />
          </button>
          <button onClick={() => setPayOpen(true)} className="ca-quick-item">
            <Wallet size={17} className="ca-quick-icon" />
            <span>Payment options</span>
            <ChevronRight size={15} color="#c4c2d4" style={{ marginLeft: "auto" }} />
          </button>
          <a href={`/loyalty-card/${encodeURIComponent(salonId)}`} className="ca-quick-item">
            <CreditCard size={17} className="ca-quick-icon" />
            <span>Loyalty card</span>
            <ChevronRight size={15} color="#c4c2d4" style={{ marginLeft: "auto" }} />
          </a>
        </section>

        {/* ── Services ────────────────────────────────────────────────────── */}
        <section className="ca-services">
          <div className="ca-sticky">
            <div className="ca-search">
              <Search size={15} color="#a3a1b8" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${services.length} services`}
                aria-label="Search services"
              />
              {search && (
                <button onClick={() => setSearch("")} aria-label="Clear search" className="ca-search-x">
                  <X size={14} />
                </button>
              )}
            </div>

            {categories.length > 1 && (
              <div className="ca-cats">
                <Chip label="All" active={category === "all"} onClick={() => setCategory("all")} />
                {categories.map(([cat, count]) => (
                  <Chip
                    key={cat}
                    label={`${categoryLabel(cat)} ${count}`}
                    active={category === cat}
                    onClick={() => setCategory(cat)}
                  />
                ))}
              </div>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="ca-empty">
              {search ? `No services match "${search}".` : "No services listed yet — please ask at reception."}
            </p>
          ) : !search.trim() ? (
            // The full menu folds by category; a chosen category opens under its
            // sub-headings; a search shows its matches flat.
            <ServiceGroups services={visible} renderRow={serviceRow} formatMoney={(n) => money(n, currency)} />
          ) : (
            <ul className="ca-list">{visible.map(serviceRow)}</ul>
          )}
        </section>

        <p className="ca-footer">Powered by Salon Central</p>
      </main>

      {/* ── Persistent booking CTA ────────────────────────────────────────── */}
      <div className="ca-cta">
        <button onClick={() => setBookingFor("")} className="ca-cta-btn">
          <CalendarPlus size={17} /> Book appointment
        </button>
      </div>

      {bookingFor !== null && (
        <BookingSheet
          salonId={salonId}
          salonName={salonName}
          services={services}
          staff={data.staff ?? []}
          hours={data.settings?.hours ?? []}
          initialServiceId={bookingFor || undefined}
          formatMoney={(n) => money(n, currency)}
          payments={data.settings?.payments}
          salonPhone={salon.phone}
          onClose={() => setBookingFor(null)}
        />
      )}

      {payOpen && (
        <PaymentSheet payments={data.settings?.payments} salonPhone={salon.phone} onClose={() => setPayOpen(false)} />
      )}

      <Styles />
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`ca-chip-cat${active ? " ca-chip-cat-on" : ""}`}>
      {label}
    </button>
  );
}

/**
 * Kept as one style block rather than inline styles: hover/active/focus states,
 * sticky positioning and the skeleton animation can't be expressed inline, and
 * tap feedback is most of what separates an app from a web page on a phone.
 */
function Styles() {
  return (
    <style>{`
      .ca-root {
        min-height: 100vh;
        min-height: 100dvh;
        background: #f6f5fa;
        color: #1a1a2e;
        -webkit-font-smoothing: antialiased;
      }
      .ca-root * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }

      /* ── App bar ── */
      .ca-bar {
        position: sticky; top: 0; z-index: 20;
        display: flex; align-items: center; gap: 10px;
        padding: calc(10px + env(safe-area-inset-top)) 14px 10px;
        background: rgba(246,245,250,.88);
        backdrop-filter: saturate(180%) blur(14px);
        -webkit-backdrop-filter: saturate(180%) blur(14px);
        border-bottom: 1px solid rgba(26,26,46,.06);
      }
      .ca-bar-logo {
        width: 34px; height: 34px; border-radius: 11px; object-fit: cover;
        background: #fff; border: 1px solid rgba(26,26,46,.07); flex-shrink: 0;
      }
      .ca-bar-logo-fallback { display: grid; place-items: center; color: var(--ca-accent, #7C3AED); }
      .ca-bar-text { min-width: 0; flex: 1; }
      .ca-bar-name {
        font-size: 15px; font-weight: 700; letter-spacing: -.01em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ca-bar-sub { font-size: 11.5px; color: #8b8ba3; margin-top: 1px; }
      .ca-bell {
        flex-shrink: 0; width: 34px; height: 34px; border-radius: 11px; cursor: pointer;
        display: grid; place-items: center;
        border: 1px solid rgba(26,26,46,.08); background: #fff; color: #8b8ba3;
        transition: transform .12s ease, background .15s ease, color .15s ease;
      }
      .ca-bell:active { transform: scale(.92); }
      .ca-bell-on { background: var(--ca-accent, #7C3AED); border-color: var(--ca-accent, #7C3AED); color: #fff; }
      .ca-bell:disabled { opacity: .45; cursor: not-allowed; }

      /* ── Body ── */
      .ca-main {
        padding: 12px 14px 0;
        display: flex; flex-direction: column; gap: 12px;
        /* clear the pinned CTA */
        padding-bottom: calc(86px + env(safe-area-inset-bottom));
        max-width: 560px; margin: 0 auto;
      }

      .ca-hero {
        background: var(--ca-accent-gradient, linear-gradient(135deg, #7C3AED 0%, #9333ea 100%));
        color: #fff; border-radius: 18px; padding: 16px 18px;
        box-shadow: 0 8px 22px var(--ca-accent-shadow, rgba(124,58,237,.22));
      }
      .ca-hero-title { font-size: 12px; font-weight: 700; opacity: .85; letter-spacing: .02em; }
      .ca-hero-name { font-size: 20px; font-weight: 800; letter-spacing: -.02em; margin-top: 3px; line-height: 1.25; }
      .ca-hero-actions { display: flex; gap: 8px; margin-top: 13px; flex-wrap: wrap; }
      .ca-chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 7px 13px; border-radius: 999px;
        background: rgba(255,255,255,.18); color: #fff;
        font-size: 12.5px; font-weight: 650; text-decoration: none;
        transition: background .15s ease, transform .12s ease;
      }
      .ca-chip:active { transform: scale(.96); background: rgba(255,255,255,.3); }

      /* ── Offers ── */
      .ca-offer {
        position: relative; display: flex; align-items: center; gap: 11px;
        background: #fff; border: 1px solid rgba(26,26,46,.06);
        border-radius: 16px; padding: 13px 14px;
        box-shadow: 0 2px 10px rgba(38,25,75,.04);
      }
      .ca-offer-icon {
        flex-shrink: 0; width: 36px; height: 36px; border-radius: 11px;
        background: var(--ca-accent-dim, rgba(124,58,237,.08)); display: grid; place-items: center;
        color: var(--ca-accent, #7C3AED);
      }
      .ca-offer-text { min-width: 0; flex: 1; }
      .ca-offer-title { font-size: 14px; font-weight: 700; }
      .ca-offer-sub { font-size: 12px; color: #8b8ba3; margin-top: 2px; line-height: 1.45; }
      .ca-offer-btn {
        flex-shrink: 0; border: none; border-radius: 10px; cursor: pointer;
        background: var(--ca-accent, #7C3AED); color: #fff; font-size: 13px; font-weight: 750;
        padding: 9px 15px; transition: transform .12s ease;
      }
      .ca-offer-btn:active { transform: scale(.94); }
      .ca-offer-btn:disabled { opacity: .6; }
      .ca-offer-x {
        position: absolute; top: 6px; right: 6px; border: none; background: transparent;
        color: #c4c2d4; cursor: pointer; padding: 4px; line-height: 0; border-radius: 6px;
      }

      .ca-note {
        display: flex; align-items: center; gap: 7px;
        font-size: 12.5px; line-height: 1.5; border-radius: 12px; padding: 10px 13px;
      }
      .ca-note-ok   { background: #ecfdf5; color: #047857; }
      .ca-note-warn { background: #fffbeb; color: #b45309; }

      /* ── Quick actions ── */
      .ca-quick { display: flex; flex-direction: column; gap: 1px; border-radius: 16px; overflow: hidden; }
      .ca-quick-item {
        display: flex; align-items: center; gap: 11px;
        background: #fff; padding: 14px 15px; text-decoration: none; color: #1a1a2e;
        font-size: 14px; font-weight: 650; transition: background .15s ease;
        width: 100%; border: none; font-family: inherit; text-align: left; cursor: pointer;
      }
      .ca-quick-item:active { background: var(--ca-accent-dim, rgba(124,58,237,.08)); }
      /* The row's label stays near-black; only the leading icon carries the brand. */
      .ca-quick-icon { color: var(--ca-accent, #7C3AED); flex-shrink: 0; }

      /* ── Services ── */
      /* No overflow:hidden here — it would make this the sticky header's scroll
         container, permanently offsetting it by its top value and killing the stick.
         Corners are rounded on the children that actually paint instead. */
      .ca-services { background: #fff; border-radius: 18px; }
      .ca-sticky {
        position: sticky; top: calc(54px + env(safe-area-inset-top)); z-index: 10;
        background: rgba(255,255,255,.96);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        padding: 12px 14px 10px; border-bottom: 1px solid rgba(26,26,46,.05);
        border-radius: 18px 18px 0 0;
      }
      .ca-search {
        display: flex; align-items: center; gap: 8px;
        background: #f2f1f7; border-radius: 11px; padding: 9px 12px;
      }
      .ca-search input {
        flex: 1; min-width: 0; border: none; background: transparent; outline: none;
        font-size: 14px; font-family: inherit; color: #1a1a2e;
      }
      .ca-search input::placeholder { color: #a3a1b8; }
      .ca-search-x { border: none; background: transparent; color: #a3a1b8; cursor: pointer; padding: 2px; line-height: 0; }

      .ca-cats {
        display: flex; gap: 7px; overflow-x: auto; margin-top: 10px;
        scrollbar-width: none; -webkit-overflow-scrolling: touch;
      }
      .ca-cats::-webkit-scrollbar { display: none; }
      .ca-chip-cat {
        flex-shrink: 0; padding: 6px 13px; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(26,26,46,.09); background: #fff; color: #6b6b8a;
        font-size: 12.5px; font-weight: 650; text-transform: capitalize; white-space: nowrap;
        transition: transform .12s ease;
      }
      .ca-chip-cat:active { transform: scale(.95); }
      .ca-chip-cat-on { background: var(--ca-accent, #7C3AED); border-color: var(--ca-accent, #7C3AED); color: #fff; }

      .ca-list { list-style: none; margin: 0; padding: 0; }
      .ca-list > li + li { border-top: 1px solid #f4f2f9; }
      /* One line per service — name, time, price — so the menu stays short. */
      .ca-item {
        display: flex; gap: 10px; align-items: center;
        padding: 11px 15px;
        cursor: pointer; transition: background .15s ease;
      }
      .ca-item:active { background: var(--ca-accent-dim, rgba(124,58,237,.08)); }
      .ca-list > .ca-item:last-child { border-radius: 0 0 18px 18px; }
      .ca-item-main { min-width: 0; flex: 1; }
      .ca-item-name { font-size: 14px; font-weight: 650; line-height: 1.35; }
      .ca-item-desc {
        font-size: 12px; color: #8b8ba3; margin-top: 2px; line-height: 1.4;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ca-item-dur {
        flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px;
        font-size: 11.5px; color: #a3a1b8; white-space: nowrap;
      }
      .ca-item-price {
        flex-shrink: 0; min-width: 78px; text-align: right;
        font-size: 13.5px; font-weight: 800; color: var(--ca-accent, #7C3AED); white-space: nowrap;
      }
      .ca-item-plus { opacity: .6; margin-left: 1px; }
      .ca-empty { margin: 0; padding: 22px 16px 26px; font-size: 13.5px; color: #a3a1b8; text-align: center; }
      .ca-footer { text-align: center; font-size: 11px; color: #b9b7c9; margin: 2px 0 0; }

      /* ── Pinned CTA ── */
      .ca-cta {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
        padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
        background: linear-gradient(to top, #f6f5fa 62%, rgba(246,245,250,0));
        pointer-events: none;
      }
      .ca-cta-btn {
        pointer-events: auto;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        max-width: 532px; margin: 0 auto;
        padding: 15px 20px; border-radius: 15px;
        background: var(--ca-accent, #7C3AED); color: #fff; text-decoration: none;
        font-size: 15px; font-weight: 750; letter-spacing: -.01em;
        box-shadow: 0 8px 22px var(--ca-accent-glow, rgba(124,58,237,.3));
        transition: transform .12s ease;
        width: 100%; border: none; font-family: inherit; cursor: pointer;
      }
      .ca-cta-btn:active { transform: scale(.975); }

      /* ── Skeleton ── */
      .ca-skel {
        background: linear-gradient(90deg, #ecebf3 25%, #f5f4f9 50%, #ecebf3 75%);
        background-size: 200% 100%;
        animation: ca-shimmer 1.4s ease-in-out infinite;
      }
      @keyframes ca-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }

      @media (prefers-reduced-motion: reduce) {
        .ca-skel { animation: none; }
        .ca-root *, .ca-root *::before { transition: none !important; }
      }
    `}</style>
  );
}
