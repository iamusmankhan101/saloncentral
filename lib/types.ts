// ─── Core Types ───────────────────────────────────────────────────────────────

export type AppointmentStatus =
  | "booked"
  | "confirmed"
  | "arrived"
  | "in-progress"
  | "completed"
  | "no-show"
  | "cancelled";

export type PaymentMethod =
  | "cash"
  | "jazzcash"
  | "easypaisa"
  | "raast"
  | "card"
  | "bank";

export type StaffRole =
  | "owner"
  | "manager"
  | "senior-stylist"
  | "junior-stylist"
  | "receptionist"
  | "trainee"
  | "hair"
  | "aesthetic";
// Staff also accept arbitrary custom role names entered by the user, the same
// way Services accept custom categories below.
export type StaffRoleValue = StaffRole | (string & {});

export type ServiceCategory = "hair" | "skin" | "nails" | "bridal" | "piercing" | "other";
// Services also accept arbitrary custom category names entered by the user.
export type ServiceCategoryValue = ServiceCategory | (string & {});

export type StaffPayType = "commission" | "salary" | "both";

export interface Staff {
  id: string;
  name: string;
  phone: string;
  photo?: string;
  role: StaffRoleValue;
  /** Which salon section this staff member belongs to (e.g. "Men's", "Women's"), for salons that run both from one branch. Free text, cosmetic only. */
  section?: string;
  specialties: string[];
  color: string;
  isActive: boolean;
  email?: string;
  /** How this staff member is paid. Defaults to "commission" when unset. */
  payType?: StaffPayType;
  /** Commission percentage of revenue generated (e.g. 30 for 30%). Used when payType is "commission" or "both". */
  commissionRate?: number;
  /** Fixed pay-period amount (PKR). Used when payType is "salary" or "both". */
  baseSalary?: number;
  /**
   * Extra commission %, paid only on services sold beyond what the client
   * booked (see lib/upsell.ts). Stacks on top of any ordinary commission rather
   * than replacing it — the upsold service is still revenue the stylist earns
   * their normal rate on; this rewards having made the sale at all. Applies
   * whatever the pay type, so a salaried stylist can still earn on upselling.
   */
  upsellCommissionRate?: number;
  /** How many "Leave" attendance days per month/pay period count as fully paid before further leaves start reducing salary. Defaults to 0 (unpaid) when unset. */
  paidLeavesPerMonth?: number;
  /** A full working day for this person, in hours. Overrides the salon-wide standard (Settings → Attendance) for part-timers and split shifts. */
  standardHoursPerDay?: number;
  /**
   * This person's own working hours, "HH:MM" 24h — e.g. "11:00"–"20:00". Both
   * or neither. Decides when a check-in counts as Late, and (when no
   * standardHoursPerDay is set) how long their full day is. Unset follows the
   * salon's opening hours.
   */
  shiftStart?: string;
  shiftEnd?: string;
  /**
   * Weekdays this person is off each week, as JS `getDay()` numbers (0 = Sunday).
   * Overrides the salon-wide roster in Settings → Attendance, for the stylist who
   * takes Monday instead of the weekend. An empty array means no weekly off at
   * all and is honoured as such; leave the field unset to follow the salon.
   */
  weeklyOffDays?: number[];
}

export interface Service {
  id: string;
  name: string;
  description?: string;
  category: ServiceCategoryValue;
  /**
   * Optional grouping inside the category — "Keratin" or "Men's Haircuts"
   * under Hair Care. Free text. Groups the service list on the Services page
   * and in the customer booking menus, so a big category opens as short
   * labelled groups instead of one long list.
   */
  subcategory?: string;
  /** Which salon section this service belongs to (e.g. "Men's", "Women's"). Free text, cosmetic only. */
  section?: string;
  durationMin: number;
  price: number;
  variablePrice?: boolean;
  priceRangeMin?: number;
  priceRangeMax?: number;
  /** When present (2+ ids), this Service is a Deal/Package bundling these other service ids under one price. */
  packageServiceIds?: string[];
  /** Ad-hoc services bundled into this Deal/Package that aren't part of the master service list. */
  customServices?: { name: string; price?: number; durationMin?: number }[];
  /**
   * Inventory item ids this service uses on the client — the colour a dye job
   * opens, not something sold over the counter. The list drives "how often was
   * this reached for"; how much stock each performance takes is optional and
   * comes from inventoryAmounts or inventoryServicesPerUnit below. Retail sales
   * stay on the invoice as product lines; this is the back-bar side, which
   * never appears on a bill.
   */
  inventoryUsage?: string[];
  /**
   * The service recipe: per product in inventoryUsage, the exact amount one
   * performance uses — "80 ml of keratin cream". `unit` may differ from the
   * item's own when they convert (ml ↔ l, g ↔ kg). Takes priority over
   * inventoryServicesPerUnit for the same product.
   */
  inventoryAmounts?: Record<string, { qty: number; unit: InventoryUnit }>;
  /**
   * Makes this a prepaid session package (aesthetic clinics): selling it at POS
   * gives the client `sessions` sessions of `serviceId`, each redeemed at POS
   * as a zero-priced line. Counts are derived from invoices — lib/clinic.ts.
   */
  sessionPackage?: { serviceId: string; sessions: number; validityDays?: number };
  /** Rooms/machines this treatment can use — one free of each kind is booked with it (lib/clinic-resources.ts). */
  resourceIds?: string[];
  /** Makes this a membership: selling it makes the client a member for `months` (lib/clinic.ts). */
  membership?: { months: number; discountPercent: number; perks?: string };
  /**
   * Per product in inventoryUsage: how many of *this* service one unit lasts
   * (e.g. a dye packet lasts 5 colour services). Each performance then takes
   * 1/N of a unit off stock. Falls back to the item's own servicesPerUnit.
   */
  inventoryServicesPerUnit?: Record<string, number>;
  assignedStaffIds: string[];
  /** When true, all of assignedStaffIds work together as a team on this service (e.g. bridal hair + makeup done jointly), rather than assignedStaffIds being a pool of individually-eligible stylists. Informational only — doesn't affect booking, calendar, or payroll. */
  multiStylist?: boolean;
  isActive: boolean;
}

export interface Client {
  id: string;
  name: string;
  phone: string;
  locationId?: string;
  email?: string;
  gender?: "female" | "male" | "other";
  dob?: string;
  photo?: string;
  preferredStaffId?: string;
  tags: string[];
  /** Which salon section this client is associated with (e.g. "Men's", "Women's"). Free text, cosmetic only. */
  section?: string;
  source: "whatsapp" | "walk-in" | "web" | "manual" | "agent";
  createdAt: string;
  totalVisits: number;
  totalSpend: number;
  lastVisitDate?: string;
  averageRating?: number;
  notes?: string;
  loyaltyPoints?: number;
  loyaltyPointsEarned?: number;
  /** Client has opted out of marketing WhatsApp messages (birthday offers, cancellation win-back). Transactional messages (confirmations, reminders) are unaffected. */
  whatsappOptedOut?: boolean;
  /** Aesthetic-clinic medical profile (lib/clinic.ts). Absent for salon clients. */
  medical?: MedicalProfile;
  /** The client who referred them; both earn the referral credit on their first paid visit. */
  referredBy?: string;
  /** ISO time that credit was given — set once, so it's never paid twice. */
  referralRewardedAt?: string;
}

/** Fitzpatrick skin phototype, I (always burns) to VI (never burns). */
export type FitzpatrickType = "I" | "II" | "III" | "IV" | "V" | "VI";

/** A clinic patient's medical background. Free text where clinics word things their own way. */
export interface MedicalProfile {
  address?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  allergies?: string;
  medicalHistory?: string;
  medications?: string;
  previousTreatments?: string;
  skinType?: string;
  fitzpatrick?: FitzpatrickType;
  contraindications?: string;
  complications?: string;
  /** ISO time of the last edit. */
  updatedAt?: string;
}

export type LoyaltyTxType = "earn" | "redeem" | "adjust";

export interface LoyaltyTransaction {
  id: string;
  clientId: string;
  type: LoyaltyTxType;
  points: number;
  note: string;
  date: string;
  appointmentId?: string;
}

export interface BeautyProfile {
  clientId: string;
  hairFormulas: {
    brand: string;
    shade: string;
    developer: string;
    ratio: string;
    processingTime: number;
    notes?: string;
  }[];
  skinType?: "oily" | "dry" | "combination" | "sensitive";
  allergies: string[];
  nailPrefs?: string;
  notes?: string;
}

export interface Appointment {
  id: string;
  clientId: string;
  clientName: string;
  staffId: string;
  staffName: string;
  serviceIds: string[];
  serviceNames: string[];
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  totalAmount: number;
  notes?: string;
  source: "whatsapp" | "walk-in" | "web" | "manual" | "agent";
  createdAt?: string;
  /** Which salon section this appointment belongs to — derived from the assigned staff member's section. Free text, cosmetic only. */
  section?: string;
  /**
   * What the client said about the visit, taken at the desk on the way out.
   *
   * Distinct from the `client_feedback` table behind Dashboard → Feedback, which
   * holds what clients submit themselves through the link sent after a visit.
   * This is the counter conversation — the complaint made in person that would
   * otherwise never be written down — so it lives on the appointment, is
   * editable by staff, and syncs with everything else on the record.
   *
   * Only meaningful once the appointment is completed.
   */
  feedback?: AppointmentFeedback;
  /**
   * Price charged for each service, index-aligned with `serviceIds`. Set when the
   * booking was priced by hand (e.g. a bridal package); absent on older records,
   * which fall back to the catalog price.
   */
  servicePrices?: number[];
  /**
   * A booking that runs over several days is stored as one appointment per day,
   * all sharing this id, so each day keeps its own date, stylist and services
   * while checkout can still bill the whole booking on one invoice.
   */
  bookingGroupId?: string;
  /** 1-based position of this day within its booking group. */
  dayNumber?: number;
  /** How many days the booking group spans. */
  totalDays?: number;
  /**
   * Every stylist booked on this appointment when there is more than one, lead
   * (`staffId`) first. Read through lib/appointment-staff.ts, which falls back
   * to `staffId` alone for single-stylist bookings.
   */
  staffIds?: string[];
  /** Names matching `staffIds`, for display without a staff lookup. */
  staffNames?: string[];
  /**
   * Related people seen in the same visit and billed together (a mother and
   * daughter, say). Their services are extra to the main client's `serviceIds`,
   * and `totalAmount` covers everybody. The visit, the spend and the loyalty
   * points all stay with the main client, who pays.
   */
  guests?: AppointmentGuest[];
  /** ISO time the appointment was marked completed — when its products were used up. */
  completedAt?: string;
  /** Rooms/machines it holds (aesthetic clinics, lib/clinic-resources.ts). */
  resourceIds?: string[];
}

export interface AppointmentGuest {
  /** Set when this person is a saved client; absent for a name typed at the desk. */
  clientId?: string;
  name: string;
  serviceIds: string[];
  serviceNames: string[];
  /** Index-aligned with `serviceIds`. */
  servicePrices: number[];
}

export interface AppointmentFeedback {
  /** 1–5. Absent when the client gave a comment but no score. */
  rating?: number;
  review?: string;
  complaint?: string;
  /** Whether the complaint has been dealt with. Meaningless without one. */
  complaintResolved?: boolean;
  /** ISO timestamp of the last edit, for "recorded on" display. */
  recordedAt: string;
}

export interface Payment {
  id: string;
  appointmentId: string;
  serviceAmount: number;
  tip: number;
  discountAmount: number;
  method: PaymentMethod;
  createdAt: string;
}

export interface DailyRevenue {
  date: string;
  total: number;
  appointments: number;
  avgTicket: number;
  byMethod: Partial<Record<PaymentMethod, number>>;
  tips: number;
}

export type InventoryCategory = "hair-color" | "skin-care" | "nail" | "tools" | "consumables" | "retail";
export type InventoryUnit = "ml" | "l" | "g" | "kg" | "pcs" | "pair" | "box" | "bottle" | "tube";

export interface InventoryItem {
  id: string;
  name: string;
  brand: string;
  category: InventoryCategory;
  /** Which salon section this item belongs to (e.g. "Men's", "Women's"). Free text, cosmetic only. */
  section?: string;
  unit: InventoryUnit;
  currentStock: number;
  minStock: number;
  costPrice: number;
  retailPrice?: number;
  variablePrice?: boolean;
  priceRangeMin?: number;
  priceRangeMax?: number;
  barcode?: string;
  supplier?: string;
  lastRestocked?: string;
  notes?: string;
  /**
   * How many service performances one unit lasts, e.g. 5 for a dye tube that
   * covers about five colour services. When set, each performance of a service
   * that uses this item (Service.inventoryUsage) takes 1/servicesPerUnit off
   * currentStock — see lib/inventory-consumption.ts.
   */
  servicesPerUnit?: number;
  /** ISO time currentStock was last counted or brought up to date; only services after it reduce stock. */
  stockCountedAt?: string;
  /** YYYY-MM-DD. */
  expiryDate?: string;
  /** false hides the item from POS and from service recipes; unset means active. */
  isActive?: boolean;
}
