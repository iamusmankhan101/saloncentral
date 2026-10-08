"use client";

import './onlineBooking.css';
import { useState, useMemo, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle, Clock, Calendar, User, Scissors, ChevronRight, ChevronLeft, ChevronDown, Check, Search, X, Phone, MapPin, ImageUp, Loader2 } from "lucide-react";
import { availableMethods, MethodDetails, MethodIcon, PaymentStyles, type PayMethod, type PublicPayments } from "@/app/client/[salonId]/payment-options";
import { fileToResizedDataUrl } from "@/lib/image";
import {
  getStoredAppointments,
  saveAppointments,
  getStoredClients,
  saveClients,
  getStoredStaff,
  getStoredServices,
} from "@/lib/storage";
import type { Appointment, Client, Staff, Service } from "@/lib/types";
import { settingsStore } from "@/lib/settings-store";
import { salonNow } from "@/lib/appointment-time";
import { fmtCurrency as fmt } from "@/lib/format";
import { enqueueWhatsAppConfirmation, normalizePhone } from "@/lib/whatsapp-scheduler";
import { getDefaultLocationId } from "@/lib/locations";
import { busySlots, isSlotFree, resourcesFree, type BusySlot } from "@/lib/availability";
import { resolveSalonTheme, type SalonTheme } from "@/lib/salon-theme";
import { categoryLabel, groupByCategory, groupBySubcategory } from "@/lib/service-groups";

/** How far ahead the date row reaches. */
const DAYS_AHEAD = 21;

interface BusinessHour {
  day: string;
  open: boolean;
  from: string;
  to: string;
}

const DEFAULT_BUSINESS_HOURS: BusinessHour[] = [
  { day: "Monday",    open: true, from: "09:00", to: "20:00" },
  { day: "Tuesday",   open: true, from: "09:00", to: "20:00" },
  { day: "Wednesday", open: true, from: "09:00", to: "20:00" },
  { day: "Thursday",  open: true, from: "09:00", to: "20:00" },
  { day: "Friday",    open: true, from: "09:00", to: "20:00" },
  { day: "Saturday",  open: true, from: "10:00", to: "18:00" },
  { day: "Sunday",    open: false, from: "10:00", to: "18:00" },
];

function addMinutes(timeStr: string, mins: number): string {
  const [h, m] = timeStr.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function createId(prefix: string) {
  return `${prefix}_${Date.now()}`;
}

/** Local YYYY-MM-DD — toISOString() gives tomorrow's date to evening users east of UTC. */
function localYmd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function generateTimeSlots(from: string, to: string, durationMin: number): string[] {
  const start = timeToMinutes(from);
  const end   = timeToMinutes(to);
  const slots: string[] = [];
  for (let t = start; t + Math.max(durationMin, 30) <= end; t += 30) {
    slots.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return slots;
}

function fmtTime12(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtDate(s: string) {
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

function OnlineBookingInner({ salonIdOverride }: { salonIdOverride?: string }) {
  const searchParams = useSearchParams();
  // Present when accessed by external customers: from /book/<slug>, or the
  // older /online-booking?salon=<id> link.
  const salonId = salonIdOverride ?? searchParams.get("salon");

  const [appointments, setAppointments] = useState<Appointment[]>(() => salonId ? [] : getStoredAppointments());
  const [clients, setClients]           = useState<Client[]>(() => salonId ? [] : getStoredClients());
  const [staffList, setStaffList]       = useState<Staff[]>(() => salonId ? [] : getStoredStaff());
  const [services, setServices]         = useState<Service[]>(() => salonId ? [] : getStoredServices());
  const [remoteSettings, setRemoteSettings] = useState<Record<string, unknown> | null>(null);
  // True once the salon's data has arrived (or failed) — the theme waits on it
  // so the page doesn't flash the default colour before the salon's own.
  const [loaded, setLoaded] = useState(!salonId);
  const [theme, setTheme] = useState<SalonTheme | null>(null);
  // When the page was opened — the date row counts forward from this day.
  const [openedAt] = useState(() => Date.now());

  // When accessed with ?salon=xxx, load everything from the DB instead of localStorage
  useEffect(() => {
    if (!salonId) return;
    fetch(`/api/public/salon?salonId=${encodeURIComponent(salonId)}`)
      .then((r) => r.json())
      .then((data: { ok: boolean; services: Service[]; staff: Staff[]; settings: Record<string, unknown>; appointments: Appointment[] }) => {
        if (!data.ok) return;
        setServices(data.services ?? []);
        setStaffList(data.staff ?? []);
        setAppointments(data.appointments ?? []);
        setRemoteSettings(data.settings ?? null);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [salonId]);

  const [step, setStep]                         = useState<1 | 2 | 3 | "success">(1);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [selectedStaffId, setSelectedStaffId]   = useState("");
  const [selectedDate, setSelectedDate]         = useState("");
  const [selectedTime, setSelectedTime]         = useState("");
  const [name, setName]                         = useState("");
  const [phone, setPhone]                       = useState("");
  const [notes, setNotes]                       = useState("");
  const [payMethod, setPayMethod]               = useState<PayMethod | "">("");
  /** Id of the saved booking — the payment screenshot is attached to it. */
  const [bookedId, setBookedId]                 = useState("");
  const [booking, setBooking]                   = useState(false);
  const [bookError, setBookError]               = useState("");
  const [serviceSearch, setServiceSearch]       = useState("");
  // Categories the customer has expanded. All start folded so the menu fits on one screen.
  const [openCats, setOpenCats]                 = useState<Set<string>>(new Set());
  const [remoteBusy, setRemoteBusy]             = useState<BusySlot[]>([]);
  const [remoteKinds, setRemoteKinds]           = useState<Record<string, string>>({});

  // Taken times for an external customer. Only dates and stylist ids come
  // back — never who booked. If this fails every slot shows, and the server
  // still refuses a clash on confirm.
  const loadBusy = useCallback(() => {
    if (!salonId) return;
    fetch(`/api/public/availability?salonId=${encodeURIComponent(salonId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { ok: boolean; busy?: BusySlot[]; resourceKinds?: Record<string, string> }) => { if (d.ok) { setRemoteBusy(d.busy ?? []); setRemoteKinds(d.resourceKinds ?? {}); } })
      .catch(() => {});
  }, [salonId]);
  useEffect(() => { loadBusy(); }, [loadBusy]);

  // Use remote settings (when external customer) or local settingsStore (owner's device)
  const rawHoursSource = salonId
    ? ((remoteSettings?.hours ?? []) as BusinessHour[])
    : (settingsStore.hours as BusinessHour[]);
  const hoursSource = Array.isArray(rawHoursSource) && rawHoursSource.length > 0
    ? rawHoursSource
    : DEFAULT_BUSINESS_HOURS;

  function getHoursForDate(date: string): BusinessHour | undefined {
    if (!date) return undefined;
    const [y, m, d] = date.split("-").map(Number);
    const dayName = new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long" });
    return hoursSource.find((h) => h.day === dayName) ?? DEFAULT_BUSINESS_HOURS.find((h) => h.day === dayName);
  }

  const availableServices  = selectedStaffId
    ? services.filter((s) => s.assignedStaffIds.includes(selectedStaffId))
    : services;
  const selectedServices   = services.filter((s) => selectedServiceIds.includes(s.id));

  // The menu folded by category, biggest first; a search shows its matches flat instead.
  const searchQuery = serviceSearch.trim().toLowerCase();
  const searchMatches = searchQuery
    ? availableServices.filter((sv) => sv.name.toLowerCase().includes(searchQuery) || (sv.category ?? "").toLowerCase().includes(searchQuery))
    : [];
  const serviceGroups = useMemo(() => groupByCategory(availableServices), [availableServices]);
  function toggleCat(cat: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }
  const totalDuration      = selectedServices.reduce((sum, s) => sum + s.durationMin, 0);
  const totalPrice         = selectedServices.reduce((sum, s) => sum + s.price, 0);
  const selectedHours      = getHoursForDate(selectedDate);
  const dateIsOpen         = !selectedDate || !selectedHours || selectedHours.open;
  // The salon's clock, not the visitor's — a customer abroad must see the salon's today.
  const timezone           = ((salonId ? remoteSettings?.salon : settingsStore.salon) as { timezone?: string } | undefined)?.timezone;
  const today              = salonNow(timezone).date;

  // On the salon's own device the appointments are already here in full.
  const busy = useMemo(
    () => (salonId ? remoteBusy : busySlots(appointments, today)),
    [salonId, remoteBusy, appointments, today],
  );

  const activeStaff = staffList.filter((st) => st.isActive !== false).map((st) => st.id);
  // Stylists who can do every chosen service; unassigned services are open to anyone.
  const eligibleStaff = activeStaff.filter((id) =>
    selectedServices.every((sv) => !sv.assignedStaffIds?.length || sv.assignedStaffIds.includes(id)));

  // Clinics: rooms/machines the chosen treatments need, and what kind each is.
  const resourceKinds: Record<string, string> = salonId
    ? remoteKinds
    : Object.fromEntries((((settingsStore as { clinic?: { resources?: { id: string; kind: string; locationId?: string }[] } }).clinic?.resources) ?? []).filter((r) => (r.locationId ?? "main") === getDefaultLocationId()).map((r) => [r.id, r.kind]));
  const wantedResources = [...new Set(selectedServices.flatMap((s) => (s as { resourceIds?: string[] }).resourceIds ?? []))];

  /** Free start times on `date` for the chosen services and stylist. */
  function slotsFor(date: string): string[] {
    const hours = getHoursForDate(date);
    if (!hours?.open || totalDuration <= 0) return [];
    // Today: hide times that have already started, plus a short buffer to get there.
    const earliest = date === today ? salonNow(timezone).minutes + 30 : 0;
    return generateTimeSlots(hours.from, hours.to, totalDuration).filter((slot) =>
      timeToMinutes(slot) >= earliest &&
      isSlotFree(
        busy,
        { date, start: slot, end: addMinutes(slot, totalDuration) },
        selectedStaffId, eligibleStaff, activeStaff,
      ) &&
      resourcesFree(busy, { date, start: slot, end: addMinutes(slot, totalDuration) }, wantedResources, resourceKinds));
  }
  const timeSlots = selectedDate ? slotsFor(selectedDate) : [];

  // The date row: the next three weeks, with closed and fully booked days marked.
  const days = step === 2 ? Array.from({ length: DAYS_AHEAD }, (_, i) => {
    const [by, bm, bd] = salonNow(timezone, openedAt).date.split("-").map(Number);
    const base = new Date(by, bm - 1, bd);
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const value = localYmd(d);
    const open = getHoursForDate(value)?.open !== false;
    return {
      value, open,
      full: open && slotsFor(value).length === 0,
      dow: i === 0 ? "Today" : i === 1 ? "Tmrw" : d.toLocaleDateString("en-US", { weekday: "short" }),
      dom: d.getDate(),
      month: d.toLocaleDateString("en-US", { month: "short" }),
    };
  }) : [];

  function toggleService(id: string) {
    setSelectedServiceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    setSelectedTime("");
  }

  async function handleBook() {
    // Guards against a double-click/double-tap firing this twice before the step
    // changes to "success" on the next render — without this, each call generates
    // its own appointment (createId() has no random component, just Date.now(), so
    // two calls within the same millisecond can even collide on the same id) and
    // independently sends its own confirmation + group alert.
    if (booking) return;
    setBooking(true);
    setBookError("");

    const normalizedPhone = normalizePhone(phone);
    const existing = clients.find(
      (c) => normalizePhone(c.phone) === normalizedPhone
    );
    let finalClientId = existing ? existing.id : createId("c");
    const newClientObj: Client | undefined = existing ? undefined : {
      id: finalClientId, name, phone: normalizedPhone, gender: "female",
      locationId: getDefaultLocationId(),
      tags: ["New"], source: "web",
      createdAt: selectedDate || new Date().toISOString().split("T")[0],
      totalVisits: 1, totalSpend: totalPrice,
      lastVisitDate: selectedDate, averageRating: 5.0,
    };

    const startTime = selectedTime || selectedHours?.from || "10:00";
    const appt: Appointment = {
      id: createId("a"),
      clientId: finalClientId,
      clientName: name,
      staffId:   selectedStaffId || "any",
      staffName: selectedStaffId
        ? (staffList.find((s) => s.id === selectedStaffId)?.name ?? "Any Stylist")
        : "Any Stylist",
      serviceIds:   selectedServiceIds,
      serviceNames: selectedServices.map((s) => s.name),
      date:         selectedDate,
      startTime,
      endTime:      addMinutes(startTime, totalDuration || 60),
      status:       "booked",
      totalAmount:  totalPrice,
      source:       "web",
      // Written into the notes so the desk sees how the customer means to pay.
      notes:        [notes.trim(), `Payment: ${chosenPay.label}`].filter(Boolean).join("\n"),
      createdAt:    new Date().toISOString(),
    };

    if (salonId) {
      // External customer — save directly to DB under the salon's userId.
      // Server handles the WhatsApp confirmation to the client. Waits for the
      // answer: "Booking Confirmed!" must mean the booking was actually saved.
      try {
        const res = await fetch("/api/public/booking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            salonId, appointment: appt, client: newClientObj ?? undefined,
            clientPhone: normalizedPhone, checkAvailability: true,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.taken) {
          // Someone else took this time first — back to the times, freshly loaded.
          loadBusy();
          setSelectedTime("");
          setStep(2);
          setBookError(data.error);
          setBooking(false);
          return;
        }
        if (!res.ok || !data.ok) {
          setBookError(data.error || "We couldn't place your booking. Please try again or call the salon.");
          setBooking(false);
          return;
        }
      } catch {
        setBookError("No connection. Check your internet and try again.");
        setBooking(false);
        return;
      }
    } else {
      // On the salon's own device — use localStorage
      const updatedAppts = [appt, ...appointments];
      setAppointments(updatedAppts);
      saveAppointments(updatedAppts);

      if (newClientObj) {
        const updated = [newClientObj, ...clients];
        setClients(updated); saveClients(updated);
      } else {
        const updated = clients.map((c) =>
          c.id === finalClientId
            ? { ...c, totalVisits: c.totalVisits + 1, totalSpend: c.totalSpend + appt.totalAmount, lastVisitDate: appt.date }
            : c
        );
        setClients(updated); saveClients(updated);
      }

      // Queue confirmation message to client via the scheduler
      enqueueWhatsAppConfirmation(appt.id);
    }

    // Fire the dashboard popup notification (cross-tab via localStorage, same-tab via event)
    const alertPayload = {
      bookingId: appt.id,
      clientName: name,
      serviceNames: selectedServices.map((s) => s.name),
      date: selectedDate,
      startTime,
      totalAmount: totalPrice,
      ts: Date.now(),
    };
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("werzio_new_booking_alert", { detail: alertPayload }));
      localStorage.setItem("werzio_new_booking_notify", JSON.stringify(alertPayload));
    }

    setBookedId(appt.id);
    setStep("success");
  }

  /** A category's rows, under sub-headings when the salon has sub-categories. */
  function renderGroupRows(items: Service[]) {
    const subs = groupBySubcategory(items);
    if (subs.length === 1 && subs[0][0] === null) return <div className="svcRows">{items.map(renderServiceRow)}</div>;
    return subs.map(([sub, rows]) => (
      <div key={sub ?? "_"} className="svcSubgroup">
        {sub && <div className="svcSub">{sub}</div>}
        <div className="svcRows">{rows.map(renderServiceRow)}</div>
      </div>
    ));
  }

  function renderServiceRow(sv: Service) {
    const checked = selectedServiceIds.includes(sv.id);
    return (
      <button key={sv.id} className={`svcRow ${checked ? "selected" : ""}`} onClick={() => toggleService(sv.id)} aria-pressed={checked}>
        <span className="svcRowCheck">{checked && <Check size={12} strokeWidth={3} />}</span>
        <span className="svcRowName">{sv.name}</span>
        <span className="svcRowDur"><Clock size={11} /> {sv.durationMin}m</span>
        <span className="svcRowPrice">{fmt(sv.price)}</span>
      </button>
    );
  }

  function resetAll() {
    setSelectedServiceIds([]); setSelectedStaffId("");
    setSelectedDate(""); setSelectedTime("");
    setName(""); setPhone(""); setNotes(""); setPayMethod(""); setBookedId("");
    setBooking(false); setBookError("");
    setStep(1);
  }

  const salonName = salonId
    ? ((remoteSettings?.salon as { name?: string })?.name ?? "Salon")
    : (settingsStore.salon.name as string);
  const salonLogo = salonId
    ? ((remoteSettings?.salon as { logo?: string })?.logo ?? "")
    : ((settingsStore.salon as { logo?: string }).logo ?? "");
  const salonInfo = (salonId ? remoteSettings?.salon : settingsStore.salon) as { phone?: string; address?: string } | undefined;
  // Same payment options as the client app. A customer's link gets the
  // server's public subset; the salon's own device reads its settings, keeping
  // only the methods switched on.
  const payMethods = useMemo(() => {
    if (salonId) return availableMethods(remoteSettings?.payments as PublicPayments | undefined);
    const raw = (settingsStore.payments ?? {}) as Record<string, unknown> & { payAtCounter?: boolean };
    const on = (k: string) => {
      const m = raw[k] as ({ enabled?: boolean } & Record<string, string>) | undefined;
      return m?.enabled ? (m as { number?: string; title?: string; bankName?: string; accountNumber?: string; iban?: string }) : undefined;
    };
    return availableMethods({ payAtCounter: raw.payAtCounter !== false, jazzcash: on("jazzcash"), easypaisa: on("easypaisa"), bank: on("bank") });
  }, [salonId, remoteSettings]);
  const chosenPay = payMethods.find((m) => m.id === payMethod) ?? payMethods[0];
  const salonAccent = salonId
    ? (remoteSettings?.appearance as { accent?: string } | undefined)?.accent
    : (settingsStore.appearance as { accent?: string }).accent;

  // The salon's own colour — the one it picked, else its logo's, else the
  // house purple — same rule as the client app (lib/salon-theme.ts).
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    resolveSalonTheme({ chosenAccent: salonAccent, logo: salonLogo })
      .then((t) => { if (!cancelled) setTheme(t); });
    return () => { cancelled = true; };
  }, [loaded, salonAccent, salonLogo]);

  return (
    <div
      className="pageWrapper"
      data-ready={theme ? "" : undefined}
      style={(theme?.vars ?? {}) as React.CSSProperties}
    >
      {/* Salon header, in the salon's colours */}
      <header className="bkHero">
        <div className="bkHeroInner">
          {salonLogo ? (
            // eslint-disable-next-line @next/next/no-img-element -- salon-uploaded logo
            <img className="bkLogo" src={salonLogo} alt={`${salonName} logo`} suppressHydrationWarning />
          ) : (
            <div className="bkLogo bkLogoFallback"><Scissors size={24} /></div>
          )}
          <div className="bkHeroText">
            <div className="bkEyebrow">Book an appointment</div>
            <h1 className="bkSalonName" suppressHydrationWarning>{salonName}</h1>
            {(salonInfo?.phone || salonInfo?.address) && (
              <div className="bkChips">
                {salonInfo?.phone && (
                  <a className="bkChip" href={`tel:${salonInfo.phone}`}><Phone size={13} /> Call</a>
                )}
                {salonInfo?.address && (
                  <a
                    className="bkChip"
                    href={`https://maps.google.com/?q=${encodeURIComponent(salonInfo.address)}`}
                    target="_blank" rel="noreferrer"
                  >
                    <MapPin size={13} /> Directions
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Booking card */}
      <section className="bookingSection">
        <div className="bookingCard">

          {/* ── Progress bar ── */}
          {step !== "success" && (
            <div className="progressBar">
              {([
                { n: 1, label: "Services" },
                { n: 2, label: "Date & Time" },
                { n: 3, label: "Your Info" },
              ] as { n: 1|2|3; label: string }[]).map(({ n, label }, idx) => (
                <div key={n} className="progressTrack">
                  <div className={`progressStep ${(step as number) >= n ? "active" : ""}`}>
                    <div className="progressDot">
                      {(step as number) > n ? <Check size={11} /> : n}
                    </div>
                    <span className="progressLabel">{label}</span>
                  </div>
                  {idx < 2 && <div className={`progressLine ${(step as number) > n ? "filled" : ""}`} />}
                </div>
              ))}
            </div>
          )}

          {/* ══ STEP 1: Services ══ */}
          {step === 1 && (
            <div className="stepContent">
              <div className="stepHeader">
                <div className="stepIconWrap"><Scissors size={18} /></div>
                <div>
                  <h2 className="stepTitle">Choose Your Services</h2>
                  <p className="stepSubtitle">Select one or more services to book</p>
                </div>
              </div>

              {staffList.length > 0 && (
                <div className="staffRow">
                  <button className={`staffChip ${!selectedStaffId ? "active" : ""}`} onClick={() => { setSelectedStaffId(""); setSelectedTime(""); }}>
                    Any Stylist
                  </button>
                  {staffList.map((st) => (
                    <button key={st.id} className={`staffChip ${selectedStaffId === st.id ? "active" : ""}`} onClick={() => { setSelectedStaffId(st.id); setSelectedTime(""); }}>
                      {st.name}
                    </button>
                  ))}
                </div>
              )}

              {availableServices.length > 6 && (
                <div className="svcSearch">
                  <Search size={15} />
                  <input
                    value={serviceSearch}
                    onChange={(e) => setServiceSearch(e.target.value)}
                    placeholder={`Search ${availableServices.length} services`}
                    aria-label="Search services"
                  />
                  {serviceSearch && (
                    <button onClick={() => setServiceSearch("")} aria-label="Clear search"><X size={14} /></button>
                  )}
                </div>
              )}

              <div className="svcMenu">
                {availableServices.length === 0 ? (
                  <div className="emptyState">No services available.</div>
                ) : searchQuery ? (
                  searchMatches.length === 0
                    ? <div className="emptyState">No services match &ldquo;{serviceSearch}&rdquo;.</div>
                    : <div className="svcRows">{searchMatches.map(renderServiceRow)}</div>
                ) : serviceGroups.length === 1 ? (
                  renderGroupRows(serviceGroups[0][1])
                ) : serviceGroups.map(([cat, items]) => {
                  const open = openCats.has(cat);
                  const picked = items.filter((sv) => selectedServiceIds.includes(sv.id)).length;
                  const from = Math.min(...items.map((sv) => sv.price || 0));
                  return (
                    <div key={cat} className={`svcGroup ${open ? "open" : ""}`}>
                      <button className="svcGroupHead" onClick={() => toggleCat(cat)} aria-expanded={open}>
                        <span className="svcGroupText">
                          <span className="svcGroupName">{categoryLabel(cat)}</span>
                          <span className="svcGroupMeta">{items.length} service{items.length === 1 ? "" : "s"} · from {fmt(from)}</span>
                        </span>
                        {picked > 0 && <span className="svcGroupBadge">{picked}</span>}
                        <ChevronDown size={18} className="svcGroupChev" />
                      </button>
                      {open && <div className="svcGroupBody">{renderGroupRows(items)}</div>}
                    </div>
                  );
                })}
              </div>

              <div className="stepNav">
                <button className={`btnNext ${selectedServiceIds.length > 0 ? "active" : "disabled"}`} disabled={selectedServiceIds.length === 0} onClick={() => setStep(2)}>
                  {selectedServiceIds.length === 0 ? "Select a service" : (
                    <>
                      <span className="btnNextMeta">{selectedServiceIds.length} · {fmt(totalPrice)}</span>
                      Continue <ChevronRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ══ STEP 2: Date & Time ══ */}
          {step === 2 && (
            <div className="stepContent">
              <div className="stepHeader">
                <div className="stepIconWrap"><Calendar size={18} /></div>
                <div>
                  <h2 className="stepTitle">Pick a Date & Time</h2>
                  <p className="stepSubtitle">Choose when you'd like to come in</p>
                </div>
              </div>

              <div className="formGroup">
                <label className="formLabel">Date</label>
                <div className="dayStrip">
                  {days.map((d) => (
                    <button
                      key={d.value}
                      disabled={!d.open || d.full}
                      className={`dayCell ${selectedDate === d.value ? "selected" : ""}`}
                      onClick={() => { setSelectedDate(d.value); setSelectedTime(""); setBookError(""); }}
                    >
                      <span className="dayDow">{d.dow}</span>
                      <span className="dayDom">{d.dom}</span>
                      <span className="dayMonth">{!d.open ? "Closed" : d.full ? "Full" : d.month}</span>
                    </button>
                  ))}
                </div>
              </div>

              {bookError && <div className="dateWarning">{bookError}</div>}

              {selectedDate && dateIsOpen && timeSlots.length > 0 && (
                <div className="formGroup">
                  <label className="formLabel">Available Times</label>
                  <div className="timeGrid">
                    {timeSlots.map((slot) => (
                      <button key={slot} className={`timeSlot ${selectedTime === slot ? "selected" : ""}`} onClick={() => { setSelectedTime(slot); setBookError(""); }}>
                        {fmtTime12(slot)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!selectedDate && <div className="emptyState">Pick a day above to see available times.</div>}

              {selectedDate && dateIsOpen && timeSlots.length === 0 && (
                <div className="emptyState">Fully booked on this date — please try another day{selectedStaffId ? " or stylist" : ""}.</div>
              )}

              <div className="stepNav">
                <button className="btnBack" onClick={() => setStep(1)}><ChevronLeft size={16} /> Back</button>
                <button
                  className={`btnNext ${selectedDate && dateIsOpen && selectedTime ? "active" : "disabled"}`}
                  disabled={!selectedDate || !dateIsOpen || !selectedTime}
                  onClick={() => setStep(3)}
                >
                  Continue <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}

          {/* ══ STEP 3: Contact info ══ */}
          {step === 3 && (
            <div className="stepContent">
              <div className="stepHeader">
                <div className="stepIconWrap"><User size={18} /></div>
                <div>
                  <h2 className="stepTitle">Your Information</h2>
                  <p className="stepSubtitle">We'll use this to confirm your booking</p>
                </div>
              </div>

              {/* Mini booking summary */}
              <div className="bookingSummaryStrip">
                <div className="summaryItem"><Calendar size={13} /><span>{fmtDate(selectedDate)}</span></div>
                <div className="summaryItem"><Clock size={13} /><span>{fmtTime12(selectedTime)} · {totalDuration} min</span></div>
                <div className="summaryItem"><Scissors size={13} /><span>{selectedServices.map((s) => s.name).join(", ")}</span></div>
              </div>

              <div className="formGroup">
                <label className="formLabel">Full Name *</label>
                <input type="text" className="cleanInput" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your full name" />
              </div>

              <div className="formGroup">
                <label className="formLabel">Phone Number *</label>
                <input type="tel" className="cleanInput" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0300-1234567 or +971 50 123 4567" />
              </div>

              <div className="formGroup">
                <label className="formLabel">How will you pay?</label>
                <div className="payOptions">
                  {payMethods.map((m) => (
                    <button key={m.id} type="button" className={`payOpt${chosenPay.id === m.id ? " payOptOn" : ""}`}
                      onClick={() => setPayMethod(m.id)} aria-pressed={chosenPay.id === m.id}>
                      <MethodIcon id={m.id} size={32} />
                      <span className="payOptText">
                        <span className="payOptLabel">{m.label}</span>
                        <span className="payOptSub">{m.sub}</span>
                      </span>
                      <span className="payRadio" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="formGroup">
                <label className="formLabel">Notes (optional)</label>
                <textarea className="cleanTextarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any special requests…" rows={3} />
              </div>

              {bookError && <div className="dateWarning">{bookError}</div>}

              <div className="totalRow">
                <span>Total</span>
                <span className="totalAmount">{fmt(totalPrice)}</span>
              </div>

              <div className="stepNav">
                <button className="btnBack" onClick={() => setStep(2)}><ChevronLeft size={16} /> Back</button>
                <button
                  className={`btnNext ${name.trim() && phone.trim() && !booking ? "active" : "disabled"}`}
                  disabled={!name.trim() || !phone.trim() || booking}
                  onClick={handleBook}
                >
                  {booking ? "Booking…" : <>Confirm Booking <Check size={16} /></>}
                </button>
              </div>
            </div>
          )}

          {/* ══ SUCCESS ══ */}
          {step === "success" && (
            <div className="successScreen">
              <div className="successIconWrap"><CheckCircle size={52} /></div>
              <h2 className="successTitle">Booking Confirmed!</h2>
              <p className="successSubtitle">Your appointment at <strong suppressHydrationWarning>{salonName}</strong> is all set.</p>

              <div className="successDetails">
                <div className="successRow"><span className="successLabel">Name</span><span className="successValue">{name}</span></div>
                <div className="successRow"><span className="successLabel">Services</span><span className="successValue">{selectedServices.map((s) => s.name).join(", ")}</span></div>
                <div className="successRow"><span className="successLabel">Date</span><span className="successValue">{fmtDate(selectedDate)}</span></div>
                <div className="successRow"><span className="successLabel">Time</span><span className="successValue">{fmtTime12(selectedTime)}</span></div>
                <div className="successRow"><span className="successLabel">Duration</span><span className="successValue">{totalDuration} min</span></div>
                <div className="successRow"><span className="successLabel">Payment</span><span className="successValue">{chosenPay.label}</span></div>
                <div className="successRow highlight"><span className="successLabel">Total</span><span className="successValue">{fmt(totalPrice)}</span></div>
              </div>

              {chosenPay.id !== "counter" && (
                <section className="po-card payDone">
                  <div className="po-card-title">Send {fmt(totalPrice)} via {chosenPay.label}</div>
                  <MethodDetails method={chosenPay} />
                  {salonId && bookedId && <ProofUpload salonId={salonId} appointmentId={bookedId} method={chosenPay.id} />}
                </section>
              )}

              <p className="successNote">We&apos;ll send you a WhatsApp confirmation shortly. See you soon!</p>
              <button className="btnBookAnother" onClick={resetAll}>Book Another Appointment</button>
            </div>
          )}
        </div>
      </section>

      <footer className="bkFooter">Powered by <strong>Salon Central</strong></footer>
      <PaymentStyles />
    </div>
  );
}

/** The online booking form — shared by /online-booking and /book/[slug]. */
export function OnlineBookingView({ salonId }: { salonId?: string }) {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#f6f5f9" }} />}>
      <OnlineBookingInner salonIdOverride={salonId} />
    </Suspense>
  );
}

/** Lets the customer send their transfer screenshot — same endpoint as the client app. */
function ProofUpload({ salonId, appointmentId, method }: { salonId: string; appointmentId: string; method: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onFile(file: File | undefined) {
    if (!file) return;
    setState("uploading");
    setMessage("");
    try {
      const dataUrl = await fileToResizedDataUrl(file, 1400, 0.8);
      const res = await fetch("/api/public/payment-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salonId, appointmentId, method, dataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Upload failed. Please try again.");
      setState("done");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Upload failed. Please try again.");
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="payProof">
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      {state === "done" ? (
        <div className="payProofOk"><CheckCircle size={16} /> Screenshot sent to the salon</div>
      ) : (
        <button type="button" className="payProofBtn" disabled={state === "uploading"} onClick={() => inputRef.current?.click()}>
          {state === "uploading" ? <><Loader2 size={16} className="paySpin" /> Uploading…</> : <><ImageUp size={16} /> {state === "error" ? "Try again" : "Upload payment screenshot"}</>}
        </button>
      )}
      {message && <div className="dateWarning">{message}</div>}
    </div>
  );
}
