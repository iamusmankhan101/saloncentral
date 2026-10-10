"use client";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  Globe,
  CheckCircle2,
  Clock,
  Scissors,
  CalendarDays,
  Users,
  BarChart2,
  Smartphone,
  ChevronDown,
} from "lucide-react";
import Navbar from "./Navbar";
import Footer from "./Footer";
import DemoModal from "./DemoModal";
import styles from "./SchedulingFeaturePage.module.css";
import { siteConfig } from "@/lib/seo";

/* ─── hero booking phone ─────────────────────────────────── */
function HeroBooking() {
  return (
    <div className={styles.heroCard} aria-label="Salon Central online booking preview">
      <div className={styles.heroCardTop}>
        <div>
          <span>Online Booking</span>
          <strong>Glow Studio</strong>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 999, background: "#dcfce7", color: "#166534", fontSize: "0.72rem", fontWeight: 900 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#16a34a", display: "inline-block" }} />
          Live
        </div>
      </div>

      {/* form preview */}
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: "0.7rem", fontWeight: 900, color: "#746b83" }}>Your Name</label>
          <div style={{ padding: "10px 12px", borderRadius: 10, background: "#f8f7ff", border: "1px solid #ede9fe", fontSize: "0.85rem", color: "#17112a", fontWeight: 600 }}>Sana Nawaz</div>
        </div>
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: "0.7rem", fontWeight: 900, color: "#746b83" }}>Phone Number</label>
          <div style={{ padding: "10px 12px", borderRadius: 10, background: "#f8f7ff", border: "1px solid #ede9fe", fontSize: "0.85rem", color: "#17112a", fontWeight: 600 }}>0300 1234567</div>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontSize: "0.7rem", fontWeight: 900, color: "#746b83" }}>Select Services</label>
          {[
            { name: "Hair Color", dur: "90 min", price: "PKR 4,500", checked: true },
            { name: "Keratin Treatment", dur: "120 min", price: "PKR 6,000", checked: false },
            { name: "Hydra Facial", dur: "60 min", price: "PKR 3,200", checked: false },
          ].map((s) => (
            <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, background: s.checked ? "#ede9fe" : "#f8f7ff", border: `1px solid ${s.checked ? "#c4b5fd" : "#ede9fe"}` }}>
              <div style={{ width: 16, height: 16, borderRadius: 4, background: s.checked ? "#7c3aed" : "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {s.checked && <CheckCircle2 size={11} color="#fff" />}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "0.82rem", fontWeight: 800, color: "#17112a" }}>{s.name}</div>
                <div style={{ fontSize: "0.68rem", color: "#746b83" }}>{s.dur}</div>
              </div>
              <span style={{ fontSize: "0.78rem", fontWeight: 900, color: "#7c3aed" }}>{s.price}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: "9px 12px", borderRadius: 10, background: "#dcfce7", border: "1px solid #bbf7d0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 900, color: "#166534" }}>
            <div>Open 09:00 to 20:00</div>
            <div style={{ opacity: 0.7 }}>Wed 28 May 2026</div>
          </div>
          <div style={{ fontSize: "0.82rem", fontWeight: 900, color: "#166534" }}>PKR 4,500</div>
        </div>
      </div>

      <div className={styles.floatingNote} style={{ right: -20, top: 220 }}>
        <CheckCircle2 size={15} />
        <span>Booking confirmed!</span>
      </div>
    </div>
  );
}

/* ─── feature row visuals ───────────────────────────────── */
function SharePanel() {
  return (
    <div className={styles.checkoutPanel}>
      <div style={{ fontSize: "0.7rem", fontWeight: 900, color: "#746b83", marginBottom: 10 }}>YOUR BOOKING LINK</div>
      <div style={{ padding: "12px 14px", borderRadius: 12, background: "#f5f3ff", border: "1px solid #ede9fe", fontSize: "0.82rem", fontWeight: 800, color: "#7c3aed", marginBottom: 14, wordBreak: "break-all" }}>
        app.saloncentral.xyz/book/your-salon
      </div>
      {[
        { platform: "Instagram Bio", icon: "📸", action: "Link in bio" },
        { platform: "WhatsApp Status", icon: "💬", action: "Share link" },
        { platform: "Google Maps", icon: "📍", action: "Website field" },
        { platform: "Facebook Page", icon: "📘", action: "Book Now button" },
      ].map((p) => (
        <div key={p.platform} className={styles.checkoutBody}>
          <div>
            <span>{p.icon} {p.platform}</span>
            <strong style={{ color: "#7c3aed" }}>{p.action}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

function WebsitePanel() {
  const badge = (bg: string, text: string) => (
    <div style={{ width: 34, height: 34, borderRadius: 10, background: bg, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.78rem", fontWeight: 900, flexShrink: 0 }}>{text}</div>
  );
  return (
    <div className={styles.checkoutPanel}>
      <div style={{ fontSize: "0.7rem", fontWeight: 900, color: "#746b83", marginBottom: 10 }}>ON YOUR OWN WEBSITE</div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", borderRadius: 12, border: "1px solid #ede9fe", marginBottom: 10 }}>
        {badge("#21759b", "W")}
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: "0.88rem", color: "#17112a" }}>WordPress plugin</strong>
          <div style={{ fontSize: "0.74rem", color: "#746b83", marginTop: 2 }}>Install, paste your booking link, add the &ldquo;Salon Central Booking&rdquo; block.</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {["Grid layout", "List layout", "Your colours"].map((t) => (
              <span key={t} style={{ fontSize: "0.66rem", fontWeight: 800, color: "#7c3aed", background: "#f5f3ff", borderRadius: 999, padding: "3px 8px" }}>{t}</span>
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", borderRadius: 12, border: "1px solid #ede9fe" }}>
        {badge("#17112a", "</>")}
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: "0.88rem", color: "#17112a" }}>Any website: copy-paste code</strong>
          <div style={{ fontSize: "0.74rem", color: "#746b83", marginTop: 2 }}>Custom-coded, Wix, Squarespace, Webflow or Shopify.</div>
          <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "#17112a", color: "#c4b5fd", fontFamily: "ui-monospace, Menlo, monospace", fontSize: "0.66rem", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            &lt;iframe src=&quot;app.saloncentral.xyz/book/your-salon&quot;&gt;
          </div>
        </div>
      </div>
    </div>
  );
}

function ServicesPanel() {
  const services = [
    { name: "Hair Color", dur: "90 min", price: "PKR 4,500", cat: "Hair", color: "#7c3aed" },
    { name: "Hydra Facial", dur: "60 min", price: "PKR 3,200", cat: "Skin", color: "#0284c7" },
    { name: "Nail Extension", dur: "75 min", price: "PKR 2,800", cat: "Nails", color: "#ec4899" },
    { name: "Bridal Makeup", dur: "180 min", price: "PKR 18,000", cat: "Bridal", color: "#d97706" },
  ];
  return (
    <div className={styles.staffPanel}>
      <div style={{ fontSize: "0.78rem", fontWeight: 900, color: "#17112a", marginBottom: 12 }}>
        All services · Select multiple
      </div>
      {services.map((s) => (
        <div key={s.name} className={styles.staffRow}>
          <div className={styles.avatarSmall} style={{ background: s.color + "22", color: s.color, fontSize: "0.6rem", fontWeight: 900 }}>
            {s.cat[0]}
          </div>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: "0.88rem", color: "#17112a" }}>{s.name}</strong>
            <span style={{ fontSize: "0.7rem" }}>{s.dur}</span>
          </div>
          <em style={{ color: s.color }}>{s.price}</em>
        </div>
      ))}
    </div>
  );
}

function BusinessHoursPanel() {
  const days = [
    { day: "Monday",    open: true,  hours: "09:00 to 20:00" },
    { day: "Tuesday",   open: true,  hours: "09:00 to 20:00" },
    { day: "Wednesday", open: true,  hours: "09:00 to 20:00" },
    { day: "Saturday",  open: true,  hours: "10:00 to 18:00" },
    { day: "Sunday",    open: false, hours: "Closed" },
  ];
  return (
    <div className={styles.staffPanel}>
      <div className={styles.blockHeader} style={{ marginBottom: 12 }}>
        <Clock size={16} />
        <span style={{ fontWeight: 900, fontSize: "0.82rem", color: "#17112a" }}>Business hours enforcement</span>
      </div>
      {days.map((d) => (
        <div key={d.day} className={styles.staffRow}>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: "0.85rem", color: "#17112a" }}>{d.day}</strong>
          </div>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: "0.72rem",
              fontWeight: 900,
              background: d.open ? "#dcfce7" : "#fee2e2",
              color: d.open ? "#166534" : "#dc2626",
            }}
          >
            {d.hours}
          </span>
        </div>
      ))}
    </div>
  );
}

function ClientAutoPanel() {
  return (
    <div className={styles.checkoutPanel}>
      <div style={{ fontSize: "0.78rem", fontWeight: 900, color: "#17112a", marginBottom: 10 }}>
        Client auto-created from booking
      </div>
      <div className={styles.clientStrip}>
        <div className={styles.avatar}>SN</div>
        <div>
          <strong style={{ color: "#17112a", fontSize: "0.92rem" }}>Sana Nawaz</strong>
          <span>New · Source: Web · 0300 1234567</span>
        </div>
      </div>
      {[
        { label: "Tagged as",    value: "New",     purple: false, green: false, tag: true },
        { label: "Source",       value: "Web booking", purple: true },
        { label: "Total visits", value: "1" },
        { label: "Total spend",  value: "PKR 4,500" },
      ].map((row) => (
        <div key={row.label} className={styles.checkoutBody}>
          <div>
            <span>{row.label}</span>
            <strong style={{ color: row.purple ? "#7c3aed" : "#17112a" }}>{row.value}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardPanel() {
  const appts = [
    { client: "Sana Nawaz",  service: "Hair Color",   status: "Booked",    src: "web",   color: "#6366f1" },
    { client: "Fatima Ali",  service: "Hydra Facial", status: "Confirmed", src: "web",   color: "#0891b2" },
    { client: "Walk-in",     service: "Nails",         status: "Arrived",  src: "staff", color: "#059669" },
  ];
  return (
    <div className={styles.staffPanel}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: "0.78rem", fontWeight: 900, color: "#17112a" }}>
        <span>Today's appointments</span>
        <span style={{ color: "#7c3aed" }}>3 total</span>
      </div>
      {appts.map((a) => (
        <div key={a.client} className={styles.staffRow}>
          <div className={styles.avatarSmall} style={{ background: a.color + "22", color: a.color, fontSize: "0.6rem", fontWeight: 900 }}>
            {a.client[0]}
          </div>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: "0.85rem", color: "#17112a" }}>{a.client}</strong>
            <span style={{ fontSize: "0.7rem" }}>{a.service} · {a.src === "web" ? "🌐 Web" : "Staff"}</span>
          </div>
          <span style={{ padding: "3px 9px", borderRadius: 999, fontSize: "0.7rem", fontWeight: 900, background: a.color + "18", color: a.color }}>
            {a.status}
          </span>
        </div>
      ))}
    </div>
  );
}

function SummaryPanel() {
  return (
    <div className={styles.checkoutPanel}>
      <div style={{ fontSize: "0.78rem", fontWeight: 900, color: "#17112a", marginBottom: 12 }}>Booking summary</div>
      {[
        { label: "Services selected", value: "Hair Color" },
        { label: "Total duration",    value: "90 min" },
        { label: "Total price",       value: "PKR 4,500", purple: true },
        { label: "Date",              value: "Wed 28 May 2026" },
        { label: "Salon hours",       value: "Open 09:00 to 20:00", green: true },
      ].map((row) => (
        <div key={row.label} className={styles.checkoutBody}>
          <div>
            <span>{row.label}</span>
            <strong style={{ color: row.purple ? "#7c3aed" : row.green ? "#059669" : "#17112a" }}>
              {row.value}
            </strong>
          </div>
        </div>
      ))}
      <button type="button">Book Appointment</button>
    </div>
  );
}

/* ─── feature rows ──────────────────────────────────────── */
const rows = [
  {
    eyebrow: "Shareable booking link",
    title: "One link. Share it anywhere clients find you",
    body: "Every Salon Central salon gets a public booking page. Add the link to your Instagram bio, WhatsApp status, Google Maps website field, or Facebook Book Now button. Clients book directly without calling or DMing.",
    visual: <SharePanel />,
  },
  {
    eyebrow: "Your own website",
    title: "Take bookings right on your own website",
    body: "Already have a salon website? Put the booking form on it. On WordPress, install the Salon Central Booking plugin and add the booking block to any page. On any other site (custom-coded, Wix, Squarespace, Webflow or Shopify) copy one piece of embed code from your dashboard. Choose a grid or list layout and a button colour that matches your site, and every booking lands straight in your Salon Central calendar.",
    visual: <WebsitePanel />,
  },
  {
    eyebrow: "Service catalogue",
    title: "Clients browse and select exactly what they want",
    body: "Your full service menu is displayed with names, durations, and prices. Clients tick multiple services in a single booking, and the total duration and price calculate automatically so there are no surprises.",
    visual: <ServicesPanel />,
  },
  {
    eyebrow: "Business hours",
    title: "Closed days block bookings automatically",
    body: "The booking page reads your configured business hours. If a client picks a Sunday (or any closed day), a red warning appears and the submit button stays disabled. Open days show hours in green so clients know exactly when to come.",
    visual: <BusinessHoursPanel />,
  },
  {
    eyebrow: "Booking summary",
    title: "Duration and price totals calculated before confirming",
    body: "As the client selects services and a date, a live summary card shows total duration, total price, and salon hours for that day. No guessing: clients see exactly what they are booking before they submit.",
    visual: <SummaryPanel />,
  },
  {
    eyebrow: "Client auto-creation",
    title: "New clients are added to your system on their first booking",
    body: "When a client books online, Salon Central checks their phone number. If they are new, a client profile is created automatically: tagged as New, source set to Web, with visit count and spend tracked from day one.",
    visual: <ClientAutoPanel />,
  },
  {
    eyebrow: "Dashboard integration",
    title: "Web bookings appear in your calendar and appointments instantly",
    body: "Every online booking lands immediately in your dashboard: visible in the appointments list, the calendar, and the client's profile. Staff see the source as Web so they know it came through the booking page.",
    visual: <DashboardPanel />,
  },
];

const faqs = [
  {
    q: "What is online salon booking software?",
    a: "Online salon booking software allows clients to book appointments anytime without calling your salon. Salon Central's online salon booking system lets beauty salons, hair salons, spas, and barber shops accept appointments 24/7 while automatically updating your salon calendar.",
  },
  {
    q: "How does Salon Central's online booking system work?",
    a: "Salon Central's salon online booking system provides every salon with a branded online booking page where customers can choose services, preferred staff members, available dates, and time slots. Every booking is instantly synced with your appointment calendar.",
  },
  {
    q: "Can clients book appointments 24/7?",
    a: "Yes. Salon Central's online booking software for salons allows customers to schedule appointments anytime, even outside business hours. This helps salons capture more bookings without requiring staff to answer calls.",
  },
  {
    q: "Can customers choose their preferred stylist or beautician?",
    a: "Absolutely. During the booking process, clients can select their preferred stylist, beautician, therapist, or barber based on availability. Salon Central's salon appointment booking software automatically updates each staff member's schedule.",
  },
  {
    q: "Does the online booking system prevent double bookings?",
    a: "Yes. Salon Central's online appointment scheduling system checks staff availability in real time before confirming a booking. This prevents double bookings and scheduling conflicts while keeping your salon calendar accurate.",
  },
  {
    q: "Can clients reschedule or cancel appointments online?",
    a: "Yes. Customers can easily reschedule or cancel their appointments through your online salon booking page, while your salon calendar updates automatically to reflect the changes.",
  },
  {
    q: "Does online booking work with the salon POS and CRM?",
    a: "Yes. Every booking made through Salon Central's online booking software for salons automatically creates or updates the client profile, appointment history, salon CRM, and salon POS, giving you a complete customer record in one platform.",
  },
  {
    q: "Can I accept online bookings for multiple salon branches?",
    a: "Yes. Whether you operate one salon or multiple locations, Salon Central's salon online booking system lets customers choose their preferred branch, available staff, and appointment time while keeping each location's calendar organized.",
  },
  {
    q: "Can I customize my online booking page?",
    a: "Absolutely. You can customize your online booking system for beauty salons with your salon logo, branding, available services, staff members, operating hours, and booking rules, creating a professional booking experience for your clients.",
  },
  {
    q: "Can I add online booking to my WordPress website?",
    a: "Yes. Salon Central has a WordPress booking plugin for salons. Install it, paste your booking link, and add the Salon Central Booking block (or the [salon_central_booking] shortcode) to any page. Choose a grid or list layout and match the button colour to your website. Every booking goes straight into your Salon Central calendar.",
  },
  {
    q: "Can I add the booking form to a custom-coded website?",
    a: "Yes. In your Salon Central dashboard, open Account, then Online Booking Link, then Get embed code. Pick your layout and colour, preview it on desktop and mobile, and copy the code. Paste it into any website (custom HTML, React, Wix, Squarespace, Webflow or Shopify) and the booking form appears on your page, resizing itself to fit.",
  },
  {
    q: "Why choose Salon Central for online salon booking?",
    a: "Salon Central offers a complete online salon booking solution with online booking software for salons, salon appointment booking software, online appointment scheduling, salon POS, client management, inventory, invoicing, payroll, loyalty programs, and WhatsApp automation. Whether you run a beauty salon, hair salon, spa, nail salon, or barber shop, Salon Central helps you accept more bookings, reduce no-shows, and grow your business from one cloud-based platform.",
  },
];

function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section
      style={{ maxWidth: 860, margin: "0 auto", padding: "84px 5%" }}
      aria-label="Online booking FAQs"
    >
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <span style={{ fontSize: "0.8rem", fontWeight: 800, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          FAQs
        </span>
        <h2 style={{ marginTop: 8 }}>Online Salon Booking Software: Frequently Asked Questions</h2>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {faqs.map((item, i) => {
          const isOpen = openIndex === i;
          return (
            <div
              key={item.q}
              style={{
                border: "1px solid #e8e8f0",
                borderRadius: 14,
                background: "#fff",
                overflow: "hidden",
              }}
            >
              <button
                type="button"
                onClick={() => setOpenIndex(isOpen ? null : i)}
                aria-expanded={isOpen}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "18px 22px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: "1rem",
                  fontWeight: 700,
                  color: "#17112a",
                }}
              >
                {item.q}
                <ChevronDown
                  size={18}
                  color="#7c3aed"
                  style={{ flexShrink: 0, transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "none" }}
                />
              </button>
              {isOpen && (
                <div style={{ padding: "0 22px 20px", fontSize: "0.92rem", lineHeight: 1.65, color: "#4b4459" }}>
                  {item.a}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.a,
    },
  })),
};

/* ─── page ──────────────────────────────────────────────── */
const breadcrumbJsonLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: siteConfig.url },
    { "@type": "ListItem", position: 2, name: "Features", item: `${siteConfig.url}/#features` },
    { "@type": "ListItem", position: 3, name: "Online Booking", item: `${siteConfig.url}/features/online-booking` },
  ],
};

export default function OnlineBookingFeaturePage() {
  const [demoOpen, setDemoOpen] = useState(false);
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <Navbar />
      <main className={styles.page}>

        {/* ── hero ── */}
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <div className={styles.kicker}>
                <Globe size={16} />
                Online booking page
              </div>
              <h1>Let clients book while you focus on the salon</h1>
              <p>
                Salon Central gives your salon a public booking page where clients browse services, pick a date, and confirm their appointment, all without a single DM or phone call from your team.
              </p>
              <div className={styles.heroActions}>
                <button type="button" onClick={() => setDemoOpen(true)} className={styles.primaryCta}>
                  Get started <ArrowRight size={17} />
                </button>
                <Link href="/#pricing" className={styles.secondaryCta}>
                  View pricing
                </Link>
              </div>
            </div>
            <div className={styles.heroVisual}>
              <div className={styles.imageChip}>
                <Image src="/salon-central-logo.png" alt="Salon Central logo" width={96} height={96} />
                <span>Salon Central OS</span>
              </div>
              <HeroBooking />
            </div>
          </div>
          <div className={styles.wave} aria-hidden="true" />
        </section>

        {/* ── feature rows ── */}
        <section className={styles.featureStack}>
          {rows.map((row, index) => (
            <article key={row.title} className={`${styles.featureRow} ${index % 2 ? styles.flip : ""}`}>
              <div className={styles.rowCopy}>
                <span>{row.eyebrow}</span>
                <h2>{row.title}</h2>
                <p>{row.body}</p>
              </div>
              <div className={styles.rowVisual}>{row.visual}</div>
            </article>
          ))}
        </section>

        {/* ── cta band ── */}
        <section className={styles.ctaBand}>
          <div>
            <span>Included in all plans including Free</span>
            <h2>Your booking page is ready the moment you sign up</h2>
          </div>
          <div className={styles.ctaActions}>
            <button type="button" onClick={() => setDemoOpen(true)} className={styles.primaryCta}>
              Get started <ArrowRight size={17} />
            </button>
            <Link href="/#pricing" className={styles.secondaryDark}>View pricing</Link>
          </div>
        </section>

        {/* ── mini stats ── */}
        <section className={styles.miniStats} aria-label="Online booking advantages">
          <div>
            <Smartphone size={19} />
            <strong>Share anywhere</strong>
            <span>Instagram, WhatsApp, Google Maps, Facebook, or right on your own website.</span>
          </div>
          <div>
            <Scissors size={19} />
            <strong>Multi-service booking</strong>
            <span>Clients pick multiple services in one booking with live duration and price totals.</span>
          </div>
          <div>
            <CalendarDays size={19} />
            <strong>Hours enforced</strong>
            <span>Closed days block bookings automatically: no accidental out-of-hours requests.</span>
          </div>
          <div>
            <Users size={19} />
            <strong>Auto client profiles</strong>
            <span>New clients are added to your system the moment their first booking is submitted.</span>
          </div>
        </section>

        <FaqSection />
      </main>
      <Footer />
      <DemoModal open={demoOpen} onClose={() => setDemoOpen(false)} />
    </>
  );
}
