"use client";
import styles from "./Features.module.css";
import {
  CalendarDays, Package, Users, Check, Wallet, Megaphone, Gift, Banknote,
  UserCog, ShoppingCart, Wand2, Coins, Scissors,
  Sparkles, FileSpreadsheet,
} from "lucide-react";

/* ── helpers ───────────────────────────────────────────────── */
function hexToRgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ── mini UI previews ─────────────────────────────────────── */

function AppointmentPreview() {
  const slots = ["9:00 AM","10:30 AM","12:00 PM","2:00 PM","3:30 PM"];
  return (
    <div className={styles.prev}>
      <div className={styles.prevDateRow}>
        {["M","T","W","T","F","S","S"].map((d,i) => (
          <div key={i} className={`${styles.prevDay} ${i===2?styles.prevDayActive:""}`}>{d}</div>
        ))}
      </div>
      <div className={styles.prevSlots}>
        {slots.map((s,i) => (
          <div key={s} className={`${styles.prevSlot} ${i===1?styles.prevSlotPick:""}`}>
            {s}{i===1 && <span className={styles.prevSlotBadge}>Selected</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function WhatsAppPreview() {
  return (
    <div className={styles.prev}>
      <div className={styles.waHeader}>
        <div className={styles.waAvatar}>W</div>
        <div>
          <div className={styles.waName}>Glow Studio</div>
          <div className={styles.waStatus}>● Automated</div>
        </div>
      </div>
      <div className={styles.waMsgs}>
        <div className={styles.waTag}>Birthday Offer</div>
        <div className={`${styles.waMsg} ${styles.waMsgOut}`}>
          🎂 Happy Birthday Sana! Enjoy <strong>20% off</strong> your next visit this week.
        </div>
        <div className={styles.waTag}>Loyalty Reward</div>
        <div className={`${styles.waMsg} ${styles.waMsgOut}`}>
          🏆 You&apos;ve earned a free blow dry! Book your next appointment to redeem.
        </div>
      </div>
    </div>
  );
}

function ClientPreview() {
  const selected = new Set(["1-0", "0-3", "2-2"]);
  return (
    <div className={`${styles.prev} ${styles.importPreview}`}>
      <span className={styles.importCsvBadge}>
        <FileSpreadsheet size={11} /> CSV
      </span>
      <div className={styles.importGrid}>
        {Array.from({ length: 4 }).map((_, row) => (
          <div className={styles.importGridRow} key={row}>
            {Array.from({ length: 4 }).map((_, col) => (
              <span
                key={col}
                className={`${styles.importCell} ${selected.has(`${row}-${col}`) ? styles.importCellSelected : ""}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={styles.importBtn}>
        <Sparkles size={13} />
        Import
      </div>
    </div>
  );
}

function BillingPreview() {
  return (
    <div className={styles.prev}>
      <div className={styles.invoiceCard}>
        <div className={styles.invoiceHeader}>
          <span className={styles.invoiceNum}>Invoice #INV-042</span>
          <span className={styles.invoicePaid}>Paid</span>
        </div>
        {[
          { svc: "Hair Color", amt: "₨4,500" },
          { svc: "Blow Dry",   amt: "₨800" },
        ].map(r => (
          <div key={r.svc} className={styles.invoiceLine}>
            <span>{r.svc}</span><span>{r.amt}</span>
          </div>
        ))}
        <div className={styles.invoiceTotal}>
          <span>Total</span><span>₨5,300</span>
        </div>
      </div>
      <div className={styles.billingStats}>
        {[
          { label: "Today's Sales", value: "₨42,500", c: "#7c3aed" },
          { label: "Pending",       value: "₨8,200",  c: "#d97706" },
        ].map(s => (
          <div key={s.label} className={styles.billingStat}>
            <div className={styles.billingStatVal} style={{ color: s.c }}>{s.value}</div>
            <div className={styles.billingStatLabel}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InventoryPreview() {
  const items = [
    {name:"Loreal Hair Color",  stock:3,  max:20, warn:true},
    {name:"Wella Developer",    stock:12, max:20},
    {name:"OPI Nail Polish",    stock:48, max:60},
    {name:"Skin Serum SPF50",   stock:5,  max:30, warn:true},
  ];
  return (
    <div className={styles.prev}>
      <div className={styles.invStats}>
        <div className={styles.invStat}>
          <div className={styles.invStatVal}>68</div>
          <div className={styles.invStatLabel}>Products</div>
        </div>
        <div className={styles.invStat}>
          <div className={styles.invStatVal} style={{ color: "#ef4444" }}>2</div>
          <div className={styles.invStatLabel}>Low Stock</div>
        </div>
        <div className={styles.invStat}>
          <div className={styles.invStatVal} style={{ color: "#059669" }}>5</div>
          <div className={styles.invStatLabel}>Suppliers</div>
        </div>
      </div>
      <div className={styles.invGrid}>
        {items.map(it=>(
          <div key={it.name} className={styles.invRow}>
            <div className={styles.invName}>{it.name}</div>
            <div className={styles.invRight}>
              <div className={styles.invBar}>
                <div className={styles.invFill}
                  style={{
                    width:`${(it.stock/it.max)*100}%`,
                    background: it.warn ? "#ef4444" : "#d97706",
                  }} />
              </div>
              <span className={styles.invCount} style={{color:it.warn?"#ef4444":undefined}}>
                {it.warn ? `⚠ ${it.stock}` : it.stock}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StaffPreview() {
  const staff = [
    { name: "Ayesha Khan", role: "Senior Stylist", color: "#7c3aed", pct: 88, rev: "₨182K" },
    { name: "Bilal Ahmed", role: "Barber",          color: "#0891b2", pct: 64, rev: "₨96K" },
    { name: "Sana Malik",  role: "Nail Artist",     color: "#db2777", pct: 45, rev: "₨58K" },
  ];
  return (
    <div className={styles.prev}>
      {staff.map((s) => (
        <div key={s.name} className={styles.staffRow}>
          <div className={styles.staffAvatar} style={{ background: s.color + "22", color: s.color }}>
            {s.name.split(" ").map((w) => w[0]).join("")}
          </div>
          <div className={styles.staffInfo}>
            <div className={styles.staffName}>{s.name}</div>
            <div className={styles.staffRole}>{s.role}</div>
            <div className={styles.staffBar}>
              <div className={styles.staffFill} style={{ width: `${s.pct}%`, background: s.color }} />
            </div>
          </div>
          <div className={styles.staffRev}>{s.rev}</div>
        </div>
      ))}
    </div>
  );
}

function PayrollPreview() {
  const payouts = [
    { name: "Ayesha Khan", role: "Senior Stylist", amount: "₨18,200", status: "pending" as const },
    { name: "Bilal Ahmed", role: "Barber",          amount: "₨9,600",  status: "paid" as const },
    { name: "Sana Malik",  role: "Nail Artist",     amount: "₨5,800",  status: "paid" as const },
  ];
  return (
    <div className={styles.prev}>
      {payouts.map((p) => (
        <div key={p.name} className={styles.payoutRow}>
          <div>
            <div className={styles.payoutName}>{p.name}</div>
            <div className={styles.payoutRole}>{p.role}</div>
          </div>
          <div className={styles.payoutRight}>
            <span className={styles.payoutAmount}>{p.amount}</span>
            <span className={`${styles.payoutBadge} ${p.status === "paid" ? styles.payoutBadgePaid : styles.payoutBadgePending}`}>
              {p.status === "paid" ? "Paid" : "Pending"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ServiceMenuPreview() {
  const services = [
    { name: "Haircut & Style", price: "₨2,500",        tag: null },
    { name: "Hair Color",      price: "₨4,000 to 7,000",  tag: "Variable" },
    { name: "Bridal Combo",    price: "₨15,000",        tag: "Deal" },
    { name: "Manicure",        price: "₨1,200",        tag: null },
  ];
  return (
    <div className={styles.prev}>
      {services.map((s) => (
        <div key={s.name} className={styles.svcRow}>
          <div className={styles.svcInfo}>
            <span className={styles.svcName}>{s.name}</span>
            {s.tag && (
              <span className={`${styles.svcTag} ${s.tag === "Deal" ? styles.svcTagDeal : styles.svcTagVariable}`}>{s.tag}</span>
            )}
          </div>
          <span className={styles.svcPrice}>{s.price}</span>
        </div>
      ))}
    </div>
  );
}

function POSPreview() {
  const items = [
    { name: "Balayage Color",      price: "₨6,500" },
    { name: "Keratin Treatment",   price: "₨8,000" },
    { name: "Argan Oil Retail",    price: "₨1,200" },
  ];
  const methods = ["Cash", "JazzCash", "Card"];
  return (
    <div className={styles.prev}>
      <div className={styles.invoiceCard}>
        {items.map((r) => (
          <div key={r.name} className={styles.invoiceLine}>
            <span>{r.name}</span><span>{r.price}</span>
          </div>
        ))}
        <div className={styles.invoiceTotal}>
          <span>Total</span><span>₨15,700</span>
        </div>
      </div>
      <div className={styles.posPayRow}>
        {methods.map((m, i) => (
          <div key={m} className={`${styles.posPayChip} ${i === 1 ? styles.posPayChipActive : ""}`}>{m}</div>
        ))}
      </div>
      <div className={styles.obBtn}>Charge ₨15,700</div>
    </div>
  );
}

function VirtualTryOnPreview() {
  const colors = ["#7c3aed", "#db2777", "#d97706", "#059669"];
  return (
    <div className={styles.prev}>
      <div className={styles.vtFrame}>
        <div className={styles.vtFace}>
          <div className={styles.vtHair} />
          <div className={styles.vtFaceCircle} />
          <div className={styles.vtScanLine} />
        </div>
        <div className={styles.vtLabel}>AI Hairstyle Preview</div>
        <div className={styles.vtColors}>
          {colors.map((c) => <div key={c} className={styles.vtColor} style={{ background: c }} />)}
        </div>
        <div className={styles.vtResult}>✓ Look saved to client profile</div>
      </div>
    </div>
  );
}

function LoyaltyPreview() {
  return (
    <div className={styles.prev}>
      <div className={styles.loyaltyCard}>
        <div className={styles.loyaltyTop}>
          <span>LOYALTY CARD</span>
          <span className={styles.loyaltyTier}>🥇 Gold</span>
        </div>
        <div className={styles.loyaltyLabel}>POINTS BALANCE</div>
        <div className={styles.loyaltyPoints}>2,480</div>
        <div className={styles.loyaltyValue}>≈ ₨2,480 redeemable</div>
        <div className={styles.loyaltyProgress}>
          <div className={styles.loyaltyProgressFill} />
        </div>
        <div className={styles.loyaltyNext}>520 points to Platinum</div>
      </div>
      <div className={styles.loyaltyStats}>
        <span>Auto-earn at POS</span>
        <span>Google Wallet</span>
      </div>
    </div>
  );
}

function CashFlowPreview() {
  const bars = [
    { income: 56, expense: 25 },
    { income: 76, expense: 42 },
    { income: 62, expense: 31 },
    { income: 91, expense: 48 },
    { income: 72, expense: 36 },
  ];

  return (
    <div className={styles.prev}>
      <div className={styles.cashStats}>
        <div><span>Income</span><strong className={styles.cashIncome}>₨285K</strong></div>
        <div><span>Expenses</span><strong className={styles.cashExpense}>₨96K</strong></div>
        <div><span>Net Flow</span><strong className={styles.cashNet}>+₨189K</strong></div>
      </div>
      <div className={styles.cashChart}>
        {bars.map((bar, index) => (
          <div className={styles.cashBarGroup} key={index}>
            <div className={styles.cashBarIncome} style={{ height: `${bar.income}%` }} />
            <div className={styles.cashBarExpense} style={{ height: `${bar.expense}%` }} />
          </div>
        ))}
      </div>
      <div className={styles.cashLegend}>
        <span><i className={styles.cashIncomeDot} />Income</span>
        <span><i className={styles.cashExpenseDot} />Expenses</span>
      </div>
    </div>
  );
}

/* ── feature card data ─────────────────────────────────────── */
const features = [
  {
    icon: Users,
    color: "#7c3aed",
    title: "Client Management",
    desc: "Every client profile in one place: from first visit to VIP loyalty.",
    bullets: ["Customer database", "Visit history", "Notes and preferences", "Before/after photos"],
    preview: <ClientPreview />,
  },
  {
    icon: CalendarDays,
    color: "#0891b2",
    title: "Appointment Booking",
    desc: "Seamless booking for clients and staff, with zero double-bookings, even right on your own website.",
    bullets: ["Online booking", "Staff scheduling", "Automatic reminders", "Cancellation management"],
    preview: <AppointmentPreview />,
  },
  {
    icon: Scissors,
    color: "#4f46e5",
    title: "Service Management",
    desc: "Build your service menu: fixed or variable pricing, custom categories, and bundled deals.",
    bullets: ["Fixed or variable/range pricing", "Custom service categories", "Deals & multi-service packages", "Per-service staff assignment"],
    preview: <ServiceMenuPreview />,
  },
  {
    icon: ShoppingCart,
    color: "#2563eb",
    title: "Point of Sale",
    desc: "Checkout clients in seconds and accept every payment method your salon takes.",
    bullets: ["Cash, JazzCash, EasyPaisa, Raast, card & bank", "Auto-generated invoices", "WhatsApp receipts"],
    preview: <POSPreview />,
  },
  {
    icon: Wallet,
    color: "#059669",
    title: "Billing & Payments",
    desc: "Invoicing, payment tracking, and daily sales reports: all automated.",
    bullets: ["Invoices", "Payment tracking", "Daily sales reports"],
    preview: <BillingPreview />,
  },
  {
    icon: Megaphone,
    color: "#db2777",
    title: "Marketing",
    desc: "Keep clients coming back with targeted messages and loyalty programmes.",
    bullets: ["SMS reminders", "WhatsApp promotions", "Birthday offers", "Loyalty rewards"],
    preview: <WhatsAppPreview />,
  },
  {
    icon: Package,
    color: "#d97706",
    title: "Inventory",
    desc: "Track stock, get low-stock alerts, and manage suppliers without spreadsheets.",
    bullets: ["Product stock", "Low-stock alerts", "Supplier management"],
    preview: <InventoryPreview />,
  },
  {
    icon: UserCog,
    color: "#0284c7",
    title: "Staff Management",
    desc: "Roles, service assignments, and performance tracking for every team member.",
    bullets: ["Role-based staff profiles", "Per-service staff assignment", "Revenue per stylist"],
    preview: <StaffPreview />,
  },
  {
    icon: Coins,
    color: "#ea580c",
    title: "Payroll Management",
    desc: "Pay commission or fixed salary, with amounts calculated for you and a full payout history.",
    bullets: ["Commission % or fixed salary per staff", "Auto-calculated payout amounts", "Pending & paid payout history", "One-click mark as paid"],
    preview: <PayrollPreview />,
  },
  {
    icon: Gift,
    color: "#9333ea",
    title: "Loyalty Points",
    desc: "Turn every visit into a reason to return with automatic points, rewards, and membership tiers.",
    bullets: ["Automatic points at POS", "Redeemable discounts", "Bronze-to-Platinum tiers", "Digital & Google Wallet cards"],
    preview: <LoyaltyPreview />,
  },
  {
    icon: Banknote,
    color: "#0f766e",
    title: "Cash Flow",
    desc: "See money coming in and going out, with a live view of your salon's real financial position.",
    bullets: ["Appointment & POS income", "Categorized expenses", "Net cash-flow charts", "PDF, Excel & data import"],
    preview: <CashFlowPreview />,
  },
  {
    icon: Wand2,
    color: "#c026d3",
    title: "Virtual Try-On",
    desc: "Let clients preview a hairstyle or color on their own photo with AI before they book.",
    bullets: ["AI-powered hairstyle preview", "Custom color try-on", "Saved to the client's profile"],
    preview: <VirtualTryOnPreview />,
  },
];

// Rendered twice back-to-back so the marquee track can loop seamlessly:
// animating the first copy fully offscreen lands exactly on the second's start.
const loopedFeatures = [...features, ...features];

export default function Features() {
  return (
    <section className={styles.section} id="features">
      <div className={`${styles.header} text-center`}>
        <div className="section-label" data-animate data-delay="0">✦ Everything You Need</div>
        <h2 className="section-title" data-animate data-delay="0.1">Powerful Features Built<br />for Pakistan&apos;s Salons</h2>
        <p className="section-sub" data-animate data-delay="0.2">
          Twelve modules, one dashboard: salon POS software, CRM, and booking, built for beauty
          salons, spas, and hair salons across Pakistan.
        </p>
      </div>

      <div className={styles.carouselWrap} data-animate data-delay="0.15">
        <div className={styles.carousel}>
          {loopedFeatures.map((f, i) => {
            const Icon = f.icon;
            const isDuplicate = i >= features.length;
            return (
              <div
                key={`${f.title}-${i}`}
                className={styles.card}
                aria-hidden={isDuplicate}
                style={{
                  ["--accent" as string]: f.color,
                  ["--accent-shadow" as string]: hexToRgba(f.color, 0.18),
                }}
              >
                <div className={styles.cardGlow} style={{ background: `linear-gradient(135deg, ${hexToRgba(f.color, 0.07)} 0%, transparent 60%)` }} />
                <div className={styles.cardTop}>
                  <div className={styles.iconBox} style={{ background: f.color + "18", color: f.color }}>
                    <Icon size={20} />
                  </div>
                  <h3 className={styles.cardTitle}>{f.title}</h3>
                  <p className={styles.cardDesc}>{f.desc}</p>
                  <ul className={styles.cardBullets}>
                    {f.bullets.map(b => (
                      <li key={b}>
                        <Check size={11} color={f.color} strokeWidth={2.5} />
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={styles.cardPreview}>
                  {f.preview}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
