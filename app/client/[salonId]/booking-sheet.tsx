"use client";

/**
 * In-app booking for /client/[salonId].
 *
 * A full-height sheet over the client app rather than a hop to /online-booking:
 * leaving for another page (in a new tab, no less) drops an installed app out
 * of standalone mode and loses the salon's theme. Posts to the same
 * /api/public/booking route as the online form, so the saved appointment,
 * client record and WhatsApp confirmation are identical either way.
 *
 * Rendered inside .ca-root so it inherits the salon's --ca-accent variables.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar, Check, CheckCircle2, ChevronLeft, Clock, ImageUp, Loader2, Scissors, User, Wallet, X,
} from "lucide-react";
import type { Appointment, Client, Service } from "@/lib/types";
import { normalizePhone } from "@/lib/whatsapp-scheduler";
import { isSlotFree, type BusySlot } from "@/lib/availability";
import { fileToResizedDataUrl } from "@/lib/image";
import ServiceGroups from "./service-groups";
import {
  availableMethods, MethodDetails, MethodIcon, PaymentStyles, type PayMethod, type PublicPayments,
} from "./payment-options";

export interface BusinessHour { day: string; open: boolean; from: string; to: string }
export interface PublicStaff { id: string; name: string; photo?: string }

const DEFAULT_HOURS: BusinessHour[] = [
  { day: "Monday",    open: true,  from: "09:00", to: "20:00" },
  { day: "Tuesday",   open: true,  from: "09:00", to: "20:00" },
  { day: "Wednesday", open: true,  from: "09:00", to: "20:00" },
  { day: "Thursday",  open: true,  from: "09:00", to: "20:00" },
  { day: "Friday",    open: true,  from: "09:00", to: "20:00" },
  { day: "Saturday",  open: true,  from: "10:00", to: "18:00" },
  { day: "Sunday",    open: false, from: "10:00", to: "18:00" },
];

/** How far ahead the day strip reaches. */
const DAYS_AHEAD = 21;
/** Remembers the customer's name/phone on this device so repeat bookings are two taps. */
const CONTACT_KEY = "salon-central:booking-contact";

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (n: number) =>
  `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const time12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
/** Local YYYY-MM-DD — toISOString() would give tomorrow's date to evening users east of UTC. */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const longDate = (s: string) =>
  parseYmd(s).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

type Step = "services" | "when" | "details" | "done";

export default function BookingSheet({
  salonId, salonName, services, staff, hours, initialServiceId, formatMoney, payments, salonPhone, onClose,
}: {
  salonId: string;
  salonName: string;
  services: Service[];
  staff: PublicStaff[];
  hours: BusinessHour[];
  initialServiceId?: string;
  formatMoney: (n: number) => string;
  payments?: PublicPayments;
  salonPhone?: string;
  onClose: () => void;
}) {
  const payMethods = availableMethods(payments);
  const [step, setStep]             = useState<Step>("services");
  const [serviceIds, setServiceIds] = useState<string[]>(initialServiceId ? [initialServiceId] : []);
  const [staffId, setStaffId]       = useState("");
  /** Stylist per service ("" = anyone), used when the picked services are done by different stylists. */
  const [staffFor, setStaffFor]     = useState<Record<string, string>>({});
  const [date, setDate]             = useState("");
  const [time, setTime]             = useState("");
  const [name, setName]             = useState("");
  const [phone, setPhone]           = useState("");
  const [notes, setNotes]           = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");
  const [payMethod, setPayMethod]   = useState<PayMethod>(() => availableMethods(payments)[0].id);
  const chosenPay = payMethods.find((m) => m.id === payMethod) ?? payMethods[0];
  const [busy, setBusy]             = useState<BusySlot[]>([]);
  /** Id of the booking once saved — the payment screenshot is attached to it. */
  const [bookedId, setBookedId]     = useState("");

  // Taken times, so they can be hidden. If this fails the customer still sees
  // every slot, and the server refuses a clash when they confirm.
  const loadBusy = useCallback(() => {
    fetch(`/api/public/availability?salonId=${encodeURIComponent(salonId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { ok: boolean; busy?: BusySlot[] }) => { if (d.ok) setBusy(d.busy ?? []); })
      .catch(() => {});
  }, [salonId]);
  useEffect(() => { loadBusy(); }, [loadBusy]);

  // Freeze the page behind the sheet so a scroll inside it doesn't drag the menu.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(CONTACT_KEY) ?? "null");
      if (saved?.name) setName(saved.name);
      if (saved?.phone) setPhone(saved.phone);
    } catch { /* storage blocked — the customer just types it */ }
  }, []);

  const hoursList = hours.length > 0 ? hours : DEFAULT_HOURS;
  const hoursFor = (d: string) => {
    const day = parseYmd(d).toLocaleDateString("en-US", { weekday: "long" });
    return hoursList.find((h) => h.day === day) ?? DEFAULT_HOURS.find((h) => h.day === day);
  };

  const selected      = services.filter((s) => serviceIds.includes(s.id));
  const totalDuration = selected.reduce((sum, s) => sum + (s.durationMin || 0), 0);
  const totalPrice    = selected.reduce((sum, s) => sum + (s.price || 0), 0);
  const hasVariable   = selected.some((s) => s.variablePrice);

  // Who can do a service. One with no assigned staff is open to anyone,
  // matching how the dashboard books it.
  const eligibleFor = (s: Service) =>
    staff.filter((st) => !s.assignedStaffIds?.length || s.assignedStaffIds.includes(st.id));

  // Services done by different stylists (a facial by one, a haircut by another)
  // get a stylist each — a single "who does everything" list would leave out
  // whoever does only one of them, or come up empty.
  const perService = selected.length > 1 &&
    new Set(selected.map((s) => eligibleFor(s).map((st) => st.id).join(","))).size > 1;
  // Only reached when every picked service shares the same stylists.
  const eligibleStaff = selected.length > 0 ? eligibleFor(selected[0]) : staff;

  const chosenFor = (s: Service) => (perService ? staffFor[s.id] ?? "" : staffId);
  /** The stylists named for this booking, lead first, without repeats. */
  const named = [...new Set(selected.map(chosenFor).filter(Boolean))];
  const staffName = (id: string) => staff.find((st) => st.id === id)?.name ?? "Any stylist";
  const stylistLabel = perService
    ? selected.map((s) => `${chosenFor(s) ? staffName(chosenFor(s)) : "Any stylist"} (${s.name})`).join(", ")
    : named[0] ? staffName(named[0]) : undefined;
  // Recomputes the free times whenever any stylist choice changes.
  const staffKey = selected.map((s) => `${s.id}:${chosenFor(s)}`).join("|");

  const allStaffIds = useMemo(() => staff.map((s) => s.id), [staff]);

  // Every bookable start time on `d`, skipping ones already taken.
  const freeSlotsFor = (d: string): string[] => {
    const h = hoursFor(d);
    if (!h?.open) return [];
    const need = Math.max(totalDuration, 30);
    const now = new Date();
    // Today: nothing that has already started, plus a short buffer to get there.
    const earliest = d === ymd(now) ? now.getHours() * 60 + now.getMinutes() + 30 : 0;
    const out: string[] = [];
    for (let t = toMin(h.from); t + need <= toMin(h.to); t += 30) {
      if (t < earliest) continue;
      const slot = { date: d, start: fromMin(t), end: fromMin(t + (totalDuration || 60)) };
      // Every service's stylist (or, for "anyone", someone who does it) must be free.
      const free = selected.every((s) =>
        isSlotFree(busy, slot, chosenFor(s), eligibleFor(s).map((st) => st.id), allStaffIds));
      if (free) out.push(slot.start);
    }
    return out;
  };

  const days = useMemo(() => {
    const out: { value: string; dow: string; dom: number; open: boolean; full: boolean }[] = [];
    const base = new Date();
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      const value = ymd(d);
      out.push({
        value,
        dow: i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" }),
        dom: d.getDate(),
        open: hoursFor(value)?.open !== false,
        full: freeSlotsFor(value).length === 0,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours, busy, staffKey, totalDuration, allStaffIds]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slots = useMemo(() => (date ? freeSlotsFor(date) : []), [date, busy, staffKey, totalDuration, allStaffIds, hours]);

  // Changing stylist can make the chosen time unavailable — drop it rather than book a clash.
  useEffect(() => {
    if (time && !slots.includes(time)) setTime("");
  }, [slots, time]);

  function toggle(id: string) {
    setServiceIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
    setTime("");
  }

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setError("");

    const normalizedPhone = normalizePhone(phone);
    const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const clientId = `c_${uid()}`;

    const appointment: Appointment = {
      id: `a_${uid()}`,
      clientId,
      clientName: name.trim(),
      staffId: named[0] ?? "any",
      staffName: named[0] ? staffName(named[0]) : "Any Stylist",
      // More than one stylist is recorded the same way the dashboard does it.
      ...(named.length > 1 ? { staffIds: named, staffNames: named.map(staffName) } : {}),
      serviceIds,
      serviceNames: selected.map((s) => s.name),
      date,
      startTime: time,
      endTime: fromMin(toMin(time) + (totalDuration || 60)),
      status: "booked",
      totalAmount: totalPrice,
      source: "web",
      // Written into the notes so the desk sees how the customer means to pay
      // wherever the appointment is shown.
      notes: [notes.trim(), `Payment: ${chosenPay.label}`].filter(Boolean).join("\n"),
      createdAt: new Date().toISOString(),
    };
    // The server matches on phone: a returning customer's record is updated,
    // and this one is only added when the number is new.
    const client: Client = {
      id: clientId, name: name.trim(), phone: normalizedPhone,
      locationId: "main", tags: ["New"], source: "web",
      createdAt: ymd(new Date()),
      totalVisits: 1, totalSpend: totalPrice, lastVisitDate: date, averageRating: 5.0,
    };

    try {
      const res = await fetch("/api/public/booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salonId, appointment, client, clientPhone: normalizedPhone, checkAvailability: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.taken) {
        // Someone else got there first — send them back to pick again with fresh times.
        loadBusy();
        setTime("");
        setStep("when");
        setError(data.error);
        setSubmitting(false);
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.error || "We couldn't place your booking. Please try again or call the salon.");
        setSubmitting(false);
        return;
      }
      try {
        window.localStorage.setItem(CONTACT_KEY, JSON.stringify({ name: name.trim(), phone: phone.trim() }));
      } catch { /* not essential */ }
      setBookedId(appointment.id);
      setStep("done");
    } catch {
      setError("No connection. Check your internet and try again.");
    }
    setSubmitting(false);
  }

  const back = () => {
    setError("");
    if (step === "when") setStep("services");
    else if (step === "details") setStep("when");
    else onClose();
  };

  const title = { services: "Choose services", when: "Pick a time", details: "Your details", done: "" }[step];
  const stepNo = { services: 1, when: 2, details: 3, done: 3 }[step];
  const phoneOk = phone.replace(/\D/g, "").length >= 10;

  return (
    <div className="bk-overlay" role="dialog" aria-modal="true" aria-label="Book an appointment">
      <div className="bk-sheet">
        {step !== "done" && (
          <header className="bk-head">
            <button className="bk-icon-btn" onClick={back} aria-label={step === "services" ? "Close" : "Back"}>
              {step === "services" ? <X size={18} /> : <ChevronLeft size={19} />}
            </button>
            <div className="bk-head-text">
              <div className="bk-head-title">{title}</div>
              <div className="bk-head-sub">Step {stepNo} of 3</div>
            </div>
          </header>
        )}
        {step !== "done" && (
          <div className="bk-progress"><div style={{ width: `${(stepNo / 3) * 100}%` }} /></div>
        )}

        <div className="bk-body">
          {/* ── 1. Services ── */}
          {step === "services" && (
            services.length === 0 ? (
              <p className="bk-empty">No services are open for booking yet — please call the salon.</p>
            ) : (
              <div className="bk-list">
                <ServiceGroups
                  services={services}
                  formatMoney={formatMoney}
                  selectedIds={serviceIds}
                  // Opened from a service's row: show that service's category, already ticked.
                  initiallyOpen={services.filter((s) => serviceIds.includes(s.id)).map((s) => s.category?.trim() || "Other")}
                  renderRow={(s) => {
                    const on = serviceIds.includes(s.id);
                    return (
                      <li key={s.id}>
                        <button className={`bk-svc${on ? " bk-svc-on" : ""}`} onClick={() => toggle(s.id)} aria-pressed={on}>
                          <span className="bk-check">{on && <Check size={13} strokeWidth={3} />}</span>
                          <span className="bk-svc-name">{s.name}</span>
                          <span className="bk-svc-meta"><Clock size={11} /> {s.durationMin}m</span>
                          <span className="bk-svc-price">
                            {s.variablePrice && s.priceRangeMin != null ? `${formatMoney(s.priceRangeMin)}+` : formatMoney(s.price)}
                          </span>
                        </button>
                      </li>
                    );
                  }}
                />
              </div>
            )
          )}

          {/* ── 2. Stylist, date, time ── */}
          {step === "when" && (
            <>
              {perService ? (
                <section className="bk-sec">
                  <div className="bk-label">Stylists</div>
                  {selected.map((s) => (
                    <div key={s.id} className="bk-per">
                      <div className="bk-per-name">{s.name}</div>
                      <div className="bk-scroll">
                        <button
                          className={`bk-pill${!chosenFor(s) ? " bk-pill-on" : ""}`}
                          onClick={() => setStaffFor((p) => ({ ...p, [s.id]: "" }))}
                        >
                          Anyone
                        </button>
                        {eligibleFor(s).map((st) => (
                          <button
                            key={st.id}
                            className={`bk-pill${chosenFor(s) === st.id ? " bk-pill-on" : ""}`}
                            onClick={() => setStaffFor((p) => ({ ...p, [s.id]: st.id }))}
                          >
                            {st.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ) : eligibleStaff.length > 0 && (
                <section className="bk-sec">
                  <div className="bk-label">Stylist</div>
                  <div className="bk-scroll">
                    <button className={`bk-pill${!staffId ? " bk-pill-on" : ""}`} onClick={() => setStaffId("")}>
                      Anyone available
                    </button>
                    {eligibleStaff.map((st) => (
                      <button
                        key={st.id}
                        className={`bk-pill${staffId === st.id ? " bk-pill-on" : ""}`}
                        onClick={() => setStaffId(st.id)}
                      >
                        {st.name}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className="bk-sec">
                <div className="bk-label">Date</div>
                <div className="bk-scroll">
                  {days.map((d) => (
                    <button
                      key={d.value}
                      disabled={!d.open || d.full}
                      className={`bk-day${date === d.value ? " bk-day-on" : ""}`}
                      onClick={() => { setDate(d.value); setTime(""); }}
                    >
                      <span className="bk-day-dow">{d.dow}</span>
                      <span className="bk-day-dom">{d.dom}</span>
                      {!d.open ? <span className="bk-day-closed">Closed</span>
                        : d.full && <span className="bk-day-closed">Full</span>}
                    </button>
                  ))}
                </div>
              </section>

              {error && <div className="bk-error">{error}</div>}

              {date && (
                <section className="bk-sec">
                  <div className="bk-label">Time</div>
                  {slots.length === 0 ? (
                    <p className="bk-empty">Fully booked on this day — try another date{named.length ? " or stylist" : ""}.</p>
                  ) : (
                    <div className="bk-times">
                      {slots.map((t) => (
                        <button key={t} className={`bk-time${time === t ? " bk-time-on" : ""}`} onClick={() => { setTime(t); setError(""); }}>
                          {time12(t)}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {/* ── 3. Contact details ── */}
          {step === "details" && (
            <>
              <Summary
                date={date} time={time} duration={totalDuration}
                services={selected.map((s) => s.name).join(", ")}
                stylist={stylistLabel}
              />
              <label className="bk-field">
                <span className="bk-label">Full name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
              </label>
              <label className="bk-field">
                <span className="bk-label">Phone (WhatsApp)</span>
                <input
                  type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 0300 1234567" autoComplete="tel"
                />
              </label>
              <section className="bk-sec">
                <div className="bk-label">How will you pay?</div>
                <div className="bk-pay">
                  {payMethods.map((m) => (
                    <button
                      key={m.id}
                      className={`bk-pay-opt${payMethod === m.id ? " bk-pay-on" : ""}`}
                      onClick={() => setPayMethod(m.id)}
                      aria-pressed={payMethod === m.id}
                    >
                      <MethodIcon id={m.id} size={34} />
                      <span className="bk-pay-text">
                        <span className="bk-pay-label">{m.label}</span>
                        <span className="bk-pay-sub">{m.sub}</span>
                      </span>
                      <span className="bk-radio" />
                    </button>
                  ))}
                </div>
              </section>
              <label className="bk-field">
                <span className="bk-label">Notes <em>(optional)</em></span>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Anything we should know?" />
              </label>
              {error && <div className="bk-error">{error}</div>}
            </>
          )}

          {/* ── Done ── */}
          {step === "done" && (
            <div className="bk-done">
              <div className="bk-done-icon"><CheckCircle2 size={44} /></div>
              <h2>You&apos;re booked!</h2>
              <p>See you at <strong>{salonName}</strong>. We&apos;ll send a confirmation on WhatsApp.</p>
              <Summary
                date={date} time={time} duration={totalDuration}
                services={selected.map((s) => s.name).join(", ")}
                stylist={stylistLabel}
                total={`${formatMoney(totalPrice)}${hasVariable ? "+" : ""}`}
                payment={chosenPay.label}
              />
              {chosenPay.id !== "counter" && (
                <section className="po-card bk-pay-done">
                  <div className="po-card-title">Send {formatMoney(totalPrice)}{hasVariable ? "+" : ""} via {chosenPay.label}</div>
                  <MethodDetails method={chosenPay} />
                  <ProofUpload salonId={salonId} appointmentId={bookedId} method={chosenPay.id} />
                  <p className="po-note">
                    You can also show the screenshot at the counter
                    {salonPhone ? <> or send it on WhatsApp to <strong>{salonPhone}</strong></> : null}.
                  </p>
                </section>
              )}
            </div>
          )}
        </div>

        {/* ── Footer action ── */}
        <footer className="bk-foot">
          {step === "services" && (
            <button className="bk-primary" disabled={serviceIds.length === 0} onClick={() => setStep("when")}>
              {serviceIds.length === 0
                ? "Select a service"
                : <>Continue · {serviceIds.length} · {formatMoney(totalPrice)}{hasVariable ? "+" : ""}</>}
            </button>
          )}
          {step === "when" && (
            <button className="bk-primary" disabled={!date || !time} onClick={() => setStep("details")}>
              {date && time ? <>Continue · {time12(time)}</> : "Pick a date and time"}
            </button>
          )}
          {step === "details" && (
            <button className="bk-primary" disabled={!name.trim() || !phoneOk || submitting} onClick={confirm}>
              {submitting ? "Booking…" : <>Confirm booking · {formatMoney(totalPrice)}{hasVariable ? "+" : ""}</>}
            </button>
          )}
          {step === "done" && (
            <button className="bk-primary" onClick={onClose}>Done</button>
          )}
        </footer>
      </div>
      <SheetStyles />
      <PaymentStyles />
    </div>
  );
}

/**
 * Lets the customer attach their transfer screenshot to the booking. Saved to
 * the salon's database and shown to staff on the appointment.
 */
function ProofUpload({ salonId, appointmentId, method }: { salonId: string; appointmentId: string; method: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [preview, setPreview] = useState("");
  const [message, setMessage] = useState("");

  async function onFile(file: File | undefined) {
    if (!file) return;
    setState("uploading");
    setMessage("");
    try {
      // Larger than a profile photo so the transaction ID stays readable.
      const dataUrl = await fileToResizedDataUrl(file, 1400, 0.8);
      setPreview(dataUrl);
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
    <div className="bk-proof">
      <input
        ref={inputRef} type="file" accept="image/*" hidden
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      {preview && (
        // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
        <img src={preview} alt="Payment screenshot" className="bk-proof-img" />
      )}
      {state === "done" ? (
        <div className="bk-proof-ok">
          <CheckCircle2 size={16} /> Screenshot sent to the salon
          <button className="bk-proof-link" onClick={() => inputRef.current?.click()}>Replace</button>
        </div>
      ) : (
        <button
          className="bk-proof-btn"
          disabled={state === "uploading" || !appointmentId}
          onClick={() => inputRef.current?.click()}
        >
          {state === "uploading"
            ? <><Loader2 size={16} className="bk-spin" /> Uploading…</>
            : <><ImageUp size={16} /> {state === "error" ? "Try again" : "Upload payment screenshot"}</>}
        </button>
      )}
      {message && <div className="bk-error">{message}</div>}
    </div>
  );
}

function Summary({ date, time, duration, services, stylist, total, payment }: {
  date: string; time: string; duration: number; services: string; stylist?: string; total?: string; payment?: string;
}) {
  return (
    <div className="bk-summary">
      <div><Calendar size={14} /> {longDate(date)}</div>
      <div><Clock size={14} /> {time12(time)} · {duration} min</div>
      <div><Scissors size={14} /> {services}</div>
      <div><User size={14} /> {stylist ?? "Any stylist"}</div>
      {payment && <div><Wallet size={14} /> {payment}</div>}
      {total && <div className="bk-summary-total"><span>Total</span><strong>{total}</strong></div>}
    </div>
  );
}

function SheetStyles() {
  return (
    <style>{`
      .bk-overlay {
        position: fixed; inset: 0; z-index: 50;
        background: rgba(20,18,36,.42);
        display: flex; align-items: flex-end; justify-content: center;
        animation: bk-fade .18s ease;
      }
      .bk-sheet {
        width: 100%; max-width: 560px;
        /* vh first: older iOS Safari has no dvh and would drop the height entirely,
           letting the sheet grow past the screen with nothing to scroll. */
        height: calc(100vh - 24px - env(safe-area-inset-top));
        height: calc(100dvh - 24px - env(safe-area-inset-top));
        background: #f6f5fa; border-radius: 22px 22px 0 0;
        display: flex; flex-direction: column; overflow: hidden;
        animation: bk-up .26s cubic-bezier(.2,.8,.2,1);
      }
      .bk-head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px; }
      .bk-icon-btn {
        width: 36px; height: 36px; border-radius: 11px; flex-shrink: 0; cursor: pointer;
        display: grid; place-items: center; color: #1a1a2e;
        background: #fff; border: 1px solid rgba(26,26,46,.08);
      }
      .bk-icon-btn:active { transform: scale(.92); }
      .bk-head-title { font-size: 16px; font-weight: 750; letter-spacing: -.01em; }
      .bk-head-sub { font-size: 11.5px; color: #8b8ba3; margin-top: 1px; }
      .bk-progress { height: 3px; background: rgba(26,26,46,.06); margin: 0 14px; border-radius: 3px; overflow: hidden; }
      .bk-progress > div { height: 100%; background: var(--ca-accent, #7C3AED); transition: width .25s ease; }

      /* min-height: 0 is what lets this scroll: a flex child defaults to
         min-height: auto, so it grew to the full service list and the sheet's
         overflow: hidden clipped the rest out of reach. */
      .bk-body {
        flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        padding: 14px; display: flex; flex-direction: column; gap: 14px;
      }
      .bk-body > * { flex-shrink: 0; }
      .bk-empty { margin: 0; padding: 18px 4px; font-size: 13.5px; color: #8b8ba3; text-align: center; }

      .bk-list { background: #fff; border-radius: 16px; overflow: hidden; }
      .bk-svc {
        width: 100%; display: flex; align-items: center; gap: 10px; text-align: left;
        padding: 11px 14px; background: transparent; border: none; cursor: pointer; color: #1a1a2e; font: inherit;
      }
      .bk-svc:active { background: var(--ca-accent-dim, rgba(124,58,237,.08)); }
      .bk-check {
        width: 22px; height: 22px; border-radius: 7px; flex-shrink: 0;
        border: 1.5px solid #d6d4e3; display: grid; place-items: center; color: #fff;
        transition: background .12s ease, border-color .12s ease;
      }
      .bk-svc-on .bk-check { background: var(--ca-accent, #7C3AED); border-color: var(--ca-accent, #7C3AED); }
      .bk-svc-name { flex: 1; min-width: 0; font-size: 14px; font-weight: 650; line-height: 1.35; }
      .bk-svc-meta { flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: #a3a1b8; white-space: nowrap; }
      .bk-svc-price { flex-shrink: 0; min-width: 72px; text-align: right; font-size: 13.5px; font-weight: 800; color: var(--ca-accent, #7C3AED); white-space: nowrap; }

      .bk-sec { display: flex; flex-direction: column; gap: 8px; }
      .bk-label { font-size: 12px; font-weight: 700; color: #6b6b8a; letter-spacing: .02em; }
      .bk-per { display: flex; flex-direction: column; gap: 6px; }
      .bk-per + .bk-per { margin-top: 4px; }
      .bk-per-name { font-size: 13px; font-weight: 650; color: #1a1a2e; }
      .bk-label em { font-weight: 500; font-style: normal; color: #a3a1b8; }
      .bk-scroll { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: 0 -14px; padding: 2px 14px; }
      .bk-scroll::-webkit-scrollbar { display: none; }
      .bk-pill {
        flex-shrink: 0; padding: 9px 15px; border-radius: 999px; cursor: pointer; white-space: nowrap;
        border: 1px solid rgba(26,26,46,.09); background: #fff; color: #1a1a2e; font: inherit; font-size: 13px; font-weight: 650;
      }
      .bk-pill-on, .bk-day-on, .bk-time-on {
        background: var(--ca-accent, #7C3AED) !important; border-color: var(--ca-accent, #7C3AED) !important; color: #fff !important;
      }
      .bk-day {
        flex-shrink: 0; width: 58px; padding: 9px 0 8px; border-radius: 14px; cursor: pointer;
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        border: 1px solid rgba(26,26,46,.08); background: #fff; color: #1a1a2e; font: inherit;
      }
      .bk-day:disabled { opacity: .4; cursor: not-allowed; }
      .bk-day-dow { font-size: 11px; font-weight: 650; opacity: .75; }
      .bk-day-dom { font-size: 18px; font-weight: 800; letter-spacing: -.02em; }
      .bk-day-closed { font-size: 9.5px; font-weight: 600; }
      .bk-times { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .bk-time {
        padding: 11px 0; border-radius: 12px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700;
        border: 1px solid rgba(26,26,46,.08); background: #fff; color: #1a1a2e;
      }
      .bk-pill:active, .bk-day:active, .bk-time:active { transform: scale(.95); }

      .bk-summary {
        background: #fff; border-radius: 16px; padding: 13px 15px;
        display: flex; flex-direction: column; gap: 8px; font-size: 13.5px; color: #1a1a2e;
      }
      .bk-summary > div { display: flex; align-items: flex-start; gap: 9px; line-height: 1.4; }
      .bk-summary svg { color: var(--ca-accent, #7C3AED); flex-shrink: 0; margin-top: 2px; }
      .bk-summary-total { justify-content: space-between; border-top: 1px solid #f1eff7; padding-top: 9px; margin-top: 2px; }
      .bk-summary-total strong { color: var(--ca-accent, #7C3AED); font-size: 15px; }

      .bk-field { display: flex; flex-direction: column; gap: 6px; }
      .bk-field input, .bk-field textarea {
        width: 100%; border: 1px solid rgba(26,26,46,.1); background: #fff; border-radius: 12px;
        padding: 12px 13px; font: inherit; font-size: 16px; color: #1a1a2e; outline: none; resize: none;
      }
      .bk-field input:focus, .bk-field textarea:focus { border-color: var(--ca-accent, #7C3AED); }
      .bk-pay { display: flex; flex-direction: column; gap: 8px; }
      .bk-pay-opt {
        display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; cursor: pointer;
        background: #fff; border: 1.5px solid transparent; border-radius: 14px; padding: 10px 12px;
        font: inherit; color: #1a1a2e;
      }
      .bk-pay-on { border-color: var(--ca-accent, #7C3AED); }
      .bk-pay-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .bk-pay-label { font-size: 14px; font-weight: 700; }
      .bk-pay-sub { font-size: 12px; color: #8b8ba3; margin-top: 1px; }
      .bk-radio { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #d6d4e3; flex-shrink: 0; }
      .bk-pay-on .bk-radio { border: 6px solid var(--ca-accent, #7C3AED); }
      .bk-pay-done { width: 100%; text-align: left; margin-top: 10px; }
      .bk-proof { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
      .bk-proof-btn {
        display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
        padding: 12px; border-radius: 12px; cursor: pointer; font: inherit; font-size: 14px; font-weight: 750;
        background: var(--ca-accent-dim, rgba(124,58,237,.08)); color: var(--ca-accent, #7C3AED);
        border: 1.5px dashed var(--ca-accent, #7C3AED);
      }
      .bk-proof-btn:disabled { opacity: .6; cursor: default; }
      .bk-proof-img { width: 100%; max-height: 260px; object-fit: contain; border-radius: 12px; background: #f6f5fa; }
      .bk-proof-ok { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 700; color: #047857; }
      .bk-proof-link { margin-left: auto; background: none; border: none; color: var(--ca-accent, #7C3AED); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
      .bk-spin { animation: bk-rot 1s linear infinite; }
      @keyframes bk-rot { to { transform: rotate(360deg) } }
      .bk-pay-done .po-note { margin: 10px 0 0; }
      .bk-error { background: #fef2f2; color: #b91c1c; font-size: 13px; border-radius: 12px; padding: 10px 13px; line-height: 1.5; }

      .bk-done { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding-top: 28px; }
      .bk-done-icon {
        width: 76px; height: 76px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 8px;
        background: var(--ca-accent-dim, rgba(124,58,237,.08)); color: var(--ca-accent, #7C3AED);
      }
      .bk-done h2 { margin: 0; font-size: 21px; font-weight: 800; letter-spacing: -.02em; }
      .bk-done p { margin: 0 0 14px; font-size: 13.5px; color: #6b6b8a; line-height: 1.55; max-width: 300px; }
      .bk-done .bk-summary { width: 100%; text-align: left; }

      .bk-foot { padding: 10px 14px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid rgba(26,26,46,.06); background: #f6f5fa; }
      .bk-primary {
        width: 100%; padding: 15px 18px; border-radius: 15px; border: none; cursor: pointer;
        background: var(--ca-accent, #7C3AED); color: #fff; font: inherit; font-size: 15px; font-weight: 750;
        box-shadow: 0 8px 22px var(--ca-accent-glow, rgba(124,58,237,.3));
      }
      .bk-primary:active:not(:disabled) { transform: scale(.975); }
      .bk-primary:disabled { background: #d6d4e3; box-shadow: none; cursor: not-allowed; }

      @keyframes bk-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes bk-up { from { transform: translateY(40px); opacity: .6 } to { transform: none; opacity: 1 } }
      @media (prefers-reduced-motion: reduce) { .bk-overlay, .bk-sheet { animation: none; } }
    `}</style>
  );
}
