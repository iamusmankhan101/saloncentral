"use client";

import './onlineBooking.css';
import { useState, useMemo, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle, Clock, Calendar, User, Scissors, ChevronRight, ChevronLeft, ChevronDown, MessageSquare, Check, Search, X } from "lucide-react";
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
import { fmtCurrency as fmt } from "@/lib/format";
import { enqueueWhatsAppConfirmation, normalizePhone } from "@/lib/whatsapp-scheduler";
import { getDefaultLocationId } from "@/lib/locations";
import { busySlots, isSlotFree, type BusySlot } from "@/lib/availability";

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
      .catch(() => {});
  }, [salonId]);

  const [step, setStep]                         = useState<1 | 2 | 3 | "success">(1);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [selectedStaffId, setSelectedStaffId]   = useState("");
  const [selectedDate, setSelectedDate]         = useState("");
  const [selectedTime, setSelectedTime]         = useState("");
  const [name, setName]                         = useState("");
  const [phone, setPhone]                       = useState("");
  const [notes, setNotes]                       = useState("");
  const [booking, setBooking]                   = useState(false);
  const [bookError, setBookError]               = useState("");
  const [serviceSearch, setServiceSearch]       = useState("");
  // Categories the customer has expanded. All start folded so the menu fits on one screen.
  const [openCats, setOpenCats]                 = useState<Set<string>>(new Set());
  const [remoteBusy, setRemoteBusy]             = useState<BusySlot[]>([]);

  // Taken times for an external customer. Only dates and stylist ids come
  // back — never who booked. If this fails every slot shows, and the server
  // still refuses a clash on confirm.
  const loadBusy = useCallback(() => {
    if (!salonId) return;
    fetch(`/api/public/availability?salonId=${encodeURIComponent(salonId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { ok: boolean; busy?: BusySlot[] }) => { if (d.ok) setRemoteBusy(d.busy ?? []); })
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
  const serviceGroups = useMemo(() => {
    const groups = new Map<string, Service[]>();
    for (const sv of availableServices) {
      const cat = sv.category?.trim() || "Other";
      groups.set(cat, [...(groups.get(cat) ?? []), sv]);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [availableServices]);
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
  const today              = localYmd(new Date());

  // On the salon's own device the appointments are already here in full.
  const busy = useMemo(
    () => (salonId ? remoteBusy : busySlots(appointments, today)),
    [salonId, remoteBusy, appointments, today],
  );

  const timeSlots = useMemo(() => {
    if (!selectedDate || !selectedHours?.open || totalDuration <= 0) return [];
    const activeStaff = staffList.filter((st) => st.isActive !== false).map((st) => st.id);
    // Stylists who can do every chosen service; unassigned services are open to anyone.
    const eligible = activeStaff.filter((id) =>
      selectedServices.every((sv) => !sv.assignedStaffIds?.length || sv.assignedStaffIds.includes(id)));
    const now = new Date();
    // Today: hide times that have already started, plus a short buffer to get there.
    const earliest = selectedDate === today ? now.getHours() * 60 + now.getMinutes() + 30 : 0;
    return generateTimeSlots(selectedHours.from, selectedHours.to, totalDuration).filter((slot) =>
      timeToMinutes(slot) >= earliest &&
      isSlotFree(
        busy,
        { date: selectedDate, start: slot, end: addMinutes(slot, totalDuration) },
        selectedStaffId, eligible, activeStaff,
      ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, selectedHours, totalDuration, busy, selectedStaffId, staffList, selectedServiceIds, today]);

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
      notes:        notes || undefined,
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

    setStep("success");
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
    setName(""); setPhone(""); setNotes("");
    setBooking(false); setBookError("");
    setStep(1);
  }

  const salonName = salonId
    ? ((remoteSettings?.salon as { name?: string })?.name ?? "Salon")
    : (settingsStore.salon.name as string);
  const salonLogo = salonId
    ? ((remoteSettings?.salon as { logo?: string })?.logo ?? "")
    : ((settingsStore.salon as { logo?: string }).logo ?? "");

  return (
    <div className="pageWrapper">
      {/* Navbar */}
      <header className="topNavbar">
        <div className="brandRow">
          {salonLogo && (
            // eslint-disable-next-line @next/next/no-img-element -- salon-uploaded data URL
            <img className="brandLogoImg" src={salonLogo} alt={`${salonName} logo`} suppressHydrationWarning />
          )}
          <div className="brandLogoArea">
            <div className="brandLogoText" suppressHydrationWarning>{salonName}</div>
            <div className="brandPoweredBy">powered by <span className="brandPoweredByName">Salon Central</span></div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="heroSection">
        <div className="heroOverlay" />
        <div className="heroCenterContent">
          <h1 className="heroBrandName">Online Booking</h1>
          <div className="heroRule"><span className="heroDiamond" /></div>
          <p className="heroBrandSubtitle">Beauty Bar</p>
        </div>
      </section>

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
                  <div className="svcRows">{serviceGroups[0][1].map(renderServiceRow)}</div>
                ) : serviceGroups.map(([cat, items]) => {
                  const open = openCats.has(cat);
                  const picked = items.filter((sv) => selectedServiceIds.includes(sv.id)).length;
                  const from = Math.min(...items.map((sv) => sv.price || 0));
                  return (
                    <div key={cat} className={`svcGroup ${open ? "open" : ""}`}>
                      <button className="svcGroupHead" onClick={() => toggleCat(cat)} aria-expanded={open}>
                        <span className="svcGroupText">
                          <span className="svcGroupName">{cat}</span>
                          <span className="svcGroupMeta">{items.length} service{items.length === 1 ? "" : "s"} · from {fmt(from)}</span>
                        </span>
                        {picked > 0 && <span className="svcGroupBadge">{picked}</span>}
                        <ChevronDown size={18} className="svcGroupChev" />
                      </button>
                      {open && <div className="svcRows">{items.map(renderServiceRow)}</div>}
                    </div>
                  );
                })}
              </div>

              {selectedServiceIds.length > 0 && (
                <div className="selectionSummary">
                  <span>{selectedServiceIds.length} service{selectedServiceIds.length > 1 ? "s" : ""} · {totalDuration} min</span>
                  <span className="selectionTotal">{fmt(totalPrice)}</span>
                </div>
              )}

              <button className={`btnNext ${selectedServiceIds.length > 0 ? "active" : "disabled"}`} disabled={selectedServiceIds.length === 0} onClick={() => setStep(2)}>
                Continue <ChevronRight size={16} />
              </button>
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
                <input
                  type="date"
                  className="cleanInput"
                  value={selectedDate}
                  min={today}
                  onChange={(e) => { setSelectedDate(e.target.value); setSelectedTime(""); }}
                />
                {selectedDate && selectedHours && !selectedHours.open && (
                  <div className="dateWarning">We're closed on {selectedHours.day}. Please pick another date.</div>
                )}
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
                <input type="tel" className="cleanInput" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0300-1234567" />
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
                <div className="successRow highlight"><span className="successLabel">Total</span><span className="successValue">{fmt(totalPrice)}</span></div>
              </div>

              <p className="successNote">💜 We'll send you a WhatsApp confirmation shortly. See you soon!</p>
              <button className="btnBookAnother" onClick={resetAll}>Book Another Appointment</button>
            </div>
          )}
        </div>
      </section>

      <div className="floatingChatBubble" onClick={() => alert("Live support coming soon!")}>
        <MessageSquare size={22} />
      </div>
    </div>
  );
}

/** The online booking form — shared by /online-booking and /book/[slug]. */
export function OnlineBookingView({ salonId }: { salonId?: string }) {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#0a0a0f" }} />}>
      <OnlineBookingInner salonIdOverride={salonId} />
    </Suspense>
  );
}
