import { z } from 'zod';
import { CUSTOMER_GROUPS, OFFERING_STATUSES, RESERVATION_STATUSES, STAFF_ROLES, STUDENT_STATUSES } from '../constants.js';
import { idempotencyKeySchema, rialSchema, serviceDateSchema, sortDirectionSchema, timeSchema, uuidSchema } from './common.js';

/** قرارداد کاتالوگ، منو، قیمت‌گذاری، رزرو، تحویل، مالی، واردسازی، اعلان، گزارش و تنظیمات. */

// ---------------------------------------------------------------------------
// دانشجویان (معاونت دانشجویی)
// ---------------------------------------------------------------------------
export const studentsQuerySchema = z.object({
  search: z.string().max(100).optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  faculty: z.string().max(200).optional(),
  major: z.string().max(200).optional(),
  degree: z.string().max(100).optional(),
  entryYear: z.coerce.number().int().min(1300).max(1500).optional(),
  sort: z.enum(['studentNumber', 'fullName', 'balance', 'reservations', 'addedAt', 'removedAt', 'status']).default('studentNumber'),
  dir: sortDirectionSchema,
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(2000).default(50),
});

export const studentSummarySchema = z.object({
  id: uuidSchema,
  studentNumber: z.string(),
  fullName: z.string(),
  faculty: z.string(),
  major: z.string(),
  degree: z.string(),
  entryYear: z.number().int().nullable(),
  status: z.string(),
  nationalIdMasked: z.string(),
  balanceRial: z.number().int(),
  reservations: z.number().int(),
  addedAt: z.string().nullable(),
  removedAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
});

export const studentsResponseSchema = z.object({
  total: z.number().int(),
  facets: z.object({
    status: z.array(z.object({ value: z.string(), count: z.number().int() })),
    faculty: z.array(z.object({ value: z.string(), count: z.number().int() })),
    major: z.array(z.object({ value: z.string(), count: z.number().int() })),
    degree: z.array(z.object({ value: z.string(), count: z.number().int() })),
    entryYear: z.array(z.object({ value: z.string(), count: z.number().int() })),
  }),
  students: z.array(studentSummarySchema),
});

export const studentStatusRequestSchema = z.object({
  status: z.enum(STUDENT_STATUSES),
  reason: z.string().trim().min(5, 'دلیل تغییر وضعیت الزامی است.').max(500).optional(),
});

export const studentReportResponseSchema = z.object({
  profile: z.object({
    id: uuidSchema,
    studentNumber: z.string(),
    fullName: z.string(),
    faculty: z.string(),
    major: z.string(),
    degree: z.string(),
    entryYear: z.number().int().nullable(),
    status: z.string(),
    nationalIdMasked: z.string(),
    addedAt: z.string().nullable(),
    removedAt: z.string().nullable(),
    lastLoginAt: z.string().nullable(),
    lastImport: z.string().nullable(),
  }),
  stats: z.object({
    balanceRial: z.number().int(),
    creditsRial: z.number().int(),
    debitsRial: z.number().int(),
    total: z.number().int(),
    reserved: z.number().int(),
    delivered: z.number().int(),
    cancelled: z.number().int(),
    noShow: z.number().int(),
    expired: z.number().int(),
    rejected: z.number().int(),
    spentRial: z.number().int(),
    refundedRial: z.number().int(),
  }),
  reservations: z.array(
    z.object({
      id: uuidSchema,
      code: z.string(),
      status: z.string(),
      priceRial: z.number().int(),
      createdAt: z.string().nullable(),
      serviceDate: z.string(),
      mealSlot: z.string(),
      food: z.string(),
      cafeteria: z.string(),
      deliveredAt: z.string().nullable(),
    }),
  ),
  ledger: z.array(
    z.object({
      trackingCode: z.string(),
      type: z.string(),
      amountRial: z.number().int(),
      reason: z.string(),
      createdAt: z.string(),
      balanceAfter: z.number().int().nullable(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// کاتالوگ: پیمانکار، سلف، غذا
// ---------------------------------------------------------------------------
export const contractorUpsertSchema = z.object({
  kind: z.literal('contractor'),
  id: uuidSchema.optional(),
  name: z.string().trim().min(2, 'نام پیمانکار الزامی است.').max(150),
  contractNumber: z.string().trim().max(80).default(''),
  contactPhone: z.string().trim().max(30).optional(),
  contractFrom: serviceDateSchema.optional(),
  contractTo: serviceDateSchema.optional(),
  isActive: z.boolean().default(true),
});

export const cafeteriaUpsertSchema = z.object({
  kind: z.literal('cafeteria'),
  id: uuidSchema.optional(),
  name: z.string().trim().min(2, 'نام سلف الزامی است.').max(150),
  location: z.string().trim().max(200).default(''),
  contractorId: uuidSchema.nullable().optional(),
  isActive: z.boolean().default(true),
});

export const foodUpsertSchema = z.object({
  kind: z.literal('food'),
  id: uuidSchema.optional(),
  name: z.string().trim().min(2, 'نام غذا الزامی است.').max(150),
  description: z.string().trim().max(1000).default(''),
  category: z.string().trim().max(60).optional(),
  imagePath: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .refine((v) => !v || /^(https:\/\/|\/)/.test(v), 'آدرس تصویر باید با https یا / شروع شود.'),
  calories: z.number().int().min(0).max(100000).nullable().optional(),
  defaultPriceRial: z.number().int().min(0).max(100_000_000).nullable().optional(),
  defaultCapacity: z.number().int().min(1).max(100_000).nullable().optional(),
  isActive: z.boolean().default(true),
});

export const catalogItemSchema = z.discriminatedUnion('kind', [contractorUpsertSchema, cafeteriaUpsertSchema, foodUpsertSchema]);

export const catalogSaveRequestSchema = z.object({ item: catalogItemSchema });

export const catalogResponseSchema = z.object({
  contractors: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      contractNumber: z.string(),
      contactPhone: z.string().nullable(),
      contractFrom: z.string().nullable(),
      contractTo: z.string().nullable(),
      isActive: z.boolean(),
    }),
  ),
  cafeterias: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      location: z.string(),
      contractorId: z.string().nullable(),
      contractorName: z.string(),
      isActive: z.boolean(),
    }),
  ),
  foods: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      description: z.string(),
      category: z.string(),
      imagePath: z.string().nullable(),
      calories: z.number().int().nullable(),
      defaultPriceRial: z.number().int().nullable(),
      defaultCapacity: z.number().int().nullable(),
      isActive: z.boolean(),
    }),
  ),
  mealSlots: z.array(
    z.object({
      id: uuidSchema,
      code: z.string(),
      title: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      isActive: z.boolean(),
    }),
  ),
});

export const foodImageUploadResponseSchema = z.object({
  url: z.string(),
  mimeType: z.enum(['image/webp', 'image/jpeg', 'image/png']),
  sizeBytes: z.number().int().min(1),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
});

// ---------------------------------------------------------------------------
// منو و قیمت‌گذاری
// ---------------------------------------------------------------------------
/** قیمت هر گروه مشتری. نبودِ یک گروه ⇒ آن گروه این وعده را نمی‌بیند. */
export const offeringPricesInputSchema = z.object({
  /** یک قیمت برای همهٔ گروه‌ها (میان‌بر). */
  all: rialSchema.optional(),
  Student: rialSchema.optional(),
  Employee: rialSchema.optional(),
  Faculty: rialSchema.optional(),
  Contractor: rialSchema.optional(),
});

export const offeringUpsertRequestSchema = z.object({
  id: uuidSchema.optional(),
  serviceDate: serviceDateSchema,
  mealSlot: z.enum(['Breakfast', 'Lunch', 'Dinner']),
  foodId: uuidSchema,
  cafeteriaId: uuidSchema.optional(),
  capacity: z.number().int().min(1, 'ظرفیت باید حداقل ۱ باشد.').max(100_000),
  reserveOpensAt: z.iso.datetime({ offset: true }).optional(),
  reserveDeadline: z.iso.datetime({ offset: true }),
  cancelDeadline: z.iso.datetime({ offset: true }).nullable().optional(),
  status: z.enum(OFFERING_STATUSES).default('Draft'),
  notes: z.string().trim().max(1000).default(''),
  prices: offeringPricesInputSchema,
  /** دلیل تغییر قیمت پس از انتشار (الزامی وقتی وعده رزرو دارد). */
  reason: z.string().trim().max(500).optional(),
});

export const offeringsQuerySchema = z.object({
  from: serviceDateSchema.optional(),
  to: serviceDateSchema.optional(),
  cafeteriaId: uuidSchema.optional(),
  mealSlot: z.enum(['Breakfast', 'Lunch', 'Dinner']).optional(),
  status: z.enum(OFFERING_STATUSES).optional(),
  foodId: uuidSchema.optional(),
});

export const offeringDtoSchema = z.object({
  id: uuidSchema,
  serviceDate: z.string(),
  mealSlot: z.string(),
  mealSlotTitle: z.string(),
  foodId: z.string(),
  foodName: z.string(),
  foodDescription: z.string(),
  imagePath: z.string().nullable(),
  cafeteriaId: z.string(),
  cafeteriaName: z.string(),
  capacity: z.number().int(),
  reserved: z.number().int(),
  delivered: z.number().int(),
  cancelled: z.number().int(),
  noShow: z.number().int(),
  remaining: z.number().int(),
  status: z.string(),
  notes: z.string(),
  reserveOpensAt: z.string(),
  reserveDeadline: z.string(),
  cancelDeadline: z.string().nullable(),
  prices: z.array(z.object({ customerGroup: z.string(), priceRial: z.number().int() })),
  /** قیمت مؤثر برای گروه مشتریِ کاربر جاری (فقط در /me/menu). */
  myPriceRial: z.number().int().nullable(),
  /** قیمت نمایشی برای گروه Student (یا اولین قیمت موجود) — سازگاری با UI فعلی. */
  priceRial: z.number().int(),
  /** `status === 'Published'` — سازگاری با UI فعلی. */
  active: z.boolean(),
  statusReason: z.string().nullable(),
});

export const offeringsResponseSchema = z.object({ offerings: z.array(offeringDtoSchema) });

export const offeringBulkRequestSchema = z.object({
  mode: z.enum(['items', 'copy']),
  items: z
    .array(
      z.object({
        serviceDate: serviceDateSchema,
        mealSlot: z.enum(['Breakfast', 'Lunch', 'Dinner']),
        foodId: uuidSchema,
        cafeteriaId: uuidSchema.optional(),
        capacity: z.number().int().min(1).max(100_000),
        reserveDeadline: z.iso.datetime({ offset: true }),
        cancelDeadline: z.iso.datetime({ offset: true }).optional(),
        notes: z.string().trim().max(1000).default(''),
        prices: offeringPricesInputSchema,
        status: z.enum(OFFERING_STATUSES).default('Published'),
      }),
    )
    .max(300)
    .optional(),
  sourceFrom: serviceDateSchema.optional(),
  sourceTo: serviceDateSchema.optional(),
  targetStart: serviceDateSchema.optional(),
  repeat: z.coerce.number().int().min(1).max(12).default(1),
});

export const offeringBulkResponseSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
});

/** «تمام شد» / «لغو وعده» — با دلیل اجباری و تأیید با تایپ. */
export const offeringStatusChangeRequestSchema = z.object({
  status: z.enum(['SoldOut', 'Cancelled', 'Published', 'Closed']),
  reason: z.string().trim().min(5, 'دلیل این تغییر الزامی است.').max(500),
  /** تأیید با تایپ: باید دقیقاً برابر عبارت خواسته‌شده باشد. */
  confirmText: z.string().trim().max(60).optional(),
});

export const offeringStatusChangeResponseSchema = z.object({
  id: uuidSchema,
  status: z.string(),
  cancelledReservations: z.number().int(),
  refundedRial: z.number().int(),
  notified: z.number().int(),
  failed: z.number().int(),
});

// ---------------------------------------------------------------------------
// رزرو (دانشجو/کارمند) و سبد خرید
// ---------------------------------------------------------------------------
export const meMenuQuerySchema = z.object({
  from: serviceDateSchema,
  to: serviceDateSchema,
});

export const meMenuResponseSchema = z.object({
  today: z.string(),
  offerings: z.array(
    offeringDtoSchema.extend({
      open: z.boolean(),
      myReservationId: z.string().nullable(),
      myStatus: z.string().nullable(),
      cancelDeadline: z.string().nullable(),
    }),
  ),
  policyNote: z.string(),
  settings: z.object({ onlinePaymentEnabled: z.boolean() }),
});

export const createReservationRequestSchema = z.object({
  offeringId: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const createReservationResponseSchema = z.object({
  reservationId: uuidSchema,
  code: z.string(),
  priceRial: z.number().int(),
  balanceRial: z.number().int(),
  replay: z.boolean(),
});

/**
 * سبد خرید: هر آیتم در تراکنش مستقل رزرو می‌شود.
 * **هیچ اعتباری بدون پرداخت تأییدشده ثبت نمی‌شود** (حذف «پول رایگان» نسخهٔ قبلی).
 */
export const checkoutRequestSchema = z.object({
  items: z
    .array(z.object({ offeringId: uuidSchema }))
    .min(1)
    .max(30),
  idempotencyKey: idempotencyKeySchema,
});

export const checkoutItemResultSchema = z.object({
  offeringId: uuidSchema,
  ok: z.boolean(),
  code: z.string().nullable(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  priceRial: z.number().int(),
});

export const checkoutResponseSchema = z.object({
  results: z.array(checkoutItemResultSchema),
  succeeded: z.number().int(),
  failed: z.number().int(),
  paidRial: z.number().int(),
  balanceRial: z.number().int(),
  /** مجموع مبلغ آیتم‌هایی که به دلیل کسری موجودی ناموفق بودند. */
  shortfallRial: z.number().int(),
});

export const myReservationsResponseSchema = z.object({
  today: z.string(),
  reservations: z.array(
    z.object({
      id: uuidSchema,
      code: z.string(),
      status: z.enum(RESERVATION_STATUSES),
      priceRial: z.number().int(),
      createdAt: z.string(),
      serviceDate: z.string(),
      mealSlot: z.string(),
      mealSlotTitle: z.string(),
      foodName: z.string(),
      cafeteriaName: z.string(),
      deliveredAt: z.string().nullable(),
      cancelDeadline: z.string().nullable(),
      qrToken: z.string().nullable(),
    }),
  ),
});

export const cancelReservationResponseSchema = z.object({
  id: uuidSchema,
  status: z.enum(RESERVATION_STATUSES),
  refundedRial: z.number().int(),
  balanceRial: z.number().int(),
});

export const adminCancelReservationRequestSchema = z.object({
  reason: z.string().trim().min(5, 'دلیل لغو اداری الزامی است.').max(500),
});

export const adminReservationsQuerySchema = z.object({
  from: serviceDateSchema.optional(),
  to: serviceDateSchema.optional(),
  cafeteriaId: uuidSchema.optional(),
  offeringId: uuidSchema.optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  customerGroup: z.enum(CUSTOMER_GROUPS).optional(),
  search: z.string().max(80).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const adminReservationDtoSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  status: z.string(),
  priceRial: z.number().int(),
  createdAt: z.string(),
  offeringId: z.string(),
  serviceDate: z.string(),
  mealSlot: z.string(),
  foodName: z.string(),
  cafeteriaId: z.string(),
  cafeteriaName: z.string(),
  cancelDeadline: z.string().nullable(),
  accountId: z.string(),
  customerGroup: z.string(),
  holderName: z.string(),
  holderIdentifier: z.string(),
  deliveredAt: z.string().nullable(),
  canCancel: z.boolean(),
});

export const adminReservationsResponseSchema = z.object({
  reservations: z.array(adminReservationDtoSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
});

export const reissueQrResponseSchema = z.object({
  id: uuidSchema,
  qrToken: z.string(),
  issuedAt: z.string(),
});

// ---------------------------------------------------------------------------
// تحویل (سلف)
// ---------------------------------------------------------------------------
export const deliveryScanInfoSchema = z.object({
  reservationId: uuidSchema,
  code: z.string(),
  holderName: z.string(),
  holderIdentifier: z.string(),
  customerGroup: z.string(),
  foodName: z.string(),
  mealSlot: z.string(),
  serviceDate: z.string(),
  cafeteriaName: z.string(),
});

export const deliveryScanRequestSchema = z.object({
  qrToken: z.string().trim().min(4).max(200),
});

export const deliveryScanResponseSchema = z.object({
  state: z.enum([
    'ready',
    'delivered',
    'already',
    'cancelled',
    'invalid',
    'wrongCafeteria',
    'wrongDay',
    'expired',
    'outsideWindow',
    'noShow',
    'offlineConflict',
  ]),
  info: deliveryScanInfoSchema.nullable(),
  message: z.string(),
  deliveredAt: z.string().nullable(),
  deliveredBy: z.string().nullable(),
});

export const deliveryConfirmRequestSchema = deliveryScanRequestSchema.extend({
  /** شناسهٔ یکتای رویداد سمت کلاینت (برای idempotency و صف آفلاین). */
  clientEventId: z.string().trim().min(8).max(64).optional(),
  deviceId: z.string().trim().max(120).optional(),
  scannedAt: z.iso.datetime({ offset: true }).optional(),
});

export const deliveryStatsResponseSchema = z.object({
  today: z.string(),
  cafeteriaId: z.string().nullable(),
  cafeteriaName: z.string(),
  scanWindow: z.object({ from: z.string(), to: z.string() }).nullable(),
  byMeal: z.array(
    z.object({
      mealSlot: z.string(),
      title: z.string(),
      reserved: z.number().int(),
      delivered: z.number().int(),
      remaining: z.number().int(),
    }),
  ),
  recent: z.array(
    z.object({
      at: z.string(),
      code: z.string(),
      holderName: z.string(),
      holderIdentifier: z.string(),
      food: z.string(),
      mealSlot: z.string(),
      outcome: z.string(),
    }),
  ),
  totals: z.object({ reserved: z.number().int(), delivered: z.number().int(), remaining: z.number().int(), rejected: z.number().int() }),
});

/** فهرست آفلاین: فقط hash توکن‌ها (خود توکن هرگز در IndexedDB ذخیره نمی‌شود). */
export const offlineManifestResponseSchema = z.object({
  today: z.string(),
  cafeteriaId: z.string(),
  generatedAt: z.string(),
  reservations: z.array(
    z.object({
      reservationId: uuidSchema,
      code: z.string(),
      qrTokenHash: z.string(),
      holderName: z.string(),
      holderIdentifier: z.string(),
      foodName: z.string(),
      mealSlot: z.string(),
      windowFrom: z.string(),
      windowTo: z.string(),
    }),
  ),
});

export const offlineSyncRequestSchema = z.object({
  events: z
    .array(
      z.object({
        clientEventId: z.string().trim().min(8).max(64),
        reservationId: uuidSchema,
        qrTokenHash: z.string().regex(/^[a-f0-9]{64}$/, 'hash نامعتبر است.'),
        scannedAt: z.iso.datetime({ offset: true }),
        deviceId: z.string().trim().max(120).default(''),
      }),
    )
    .min(1)
    .max(500),
});

export const offlineSyncResponseSchema = z.object({
  accepted: z.number().int(),
  duplicate: z.number().int(),
  conflict: z.number().int(),
  invalid: z.number().int(),
  results: z.array(
    z.object({
      clientEventId: z.string(),
      outcome: z.string(),
      message: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// مالی
// ---------------------------------------------------------------------------
export const financeAdjustRequestSchema = z.object({
  subject: z.enum(['student', 'employee']),
  identifier: z.string().trim().min(3).max(64),
  direction: z.enum(['credit', 'debit']),
  amountRial: z.number().int().min(1).max(5_000_000_000),
  reason: z.string().trim().min(5, 'دلیل تراکنش دستی الزامی است (حداقل ۵ کاراکتر).').max(500),
  idempotencyKey: idempotencyKeySchema,
});

export const financeAdjustResponseSchema = z.object({
  trackingCode: z.string(),
  balanceRial: z.number().int(),
  amountRial: z.number().int(),
  replay: z.boolean(),
});

export const financeLedgerQuerySchema = z.object({
  type: z.string().max(40).optional(),
  search: z.string().max(80).optional(),
  from: serviceDateSchema.optional(),
  to: serviceDateSchema.optional(),
  customerGroup: z.enum(CUSTOMER_GROUPS).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ledgerEntryDtoSchema = z.object({
  id: uuidSchema,
  trackingCode: z.string(),
  type: z.string(),
  amountRial: z.number().int(),
  systemAccount: z.string().nullable(),
  reason: z.string(),
  createdAt: z.string(),
  holderIdentifier: z.string(),
  holderName: z.string(),
  customerGroup: z.string(),
  actor: z.string().nullable(),
  balanceAfter: z.number().int().nullable(),
});

export const financeLedgerResponseSchema = z.object({
  entries: z.array(ledgerEntryDtoSchema),
  totals: z.array(z.object({ type: z.string(), count: z.number().int(), total: z.number().int() })),
  systemAccounts: z.array(z.object({ account: z.string(), label: z.string(), balanceRial: z.number().int() })),
  mismatches: z.array(z.object({ kind: z.string(), reference: z.string(), expected: z.number().int(), actual: z.number().int() })),
  hasMore: z.boolean(),
});

export const walletResponseSchema = z.object({
  balanceRial: z.number().int(),
  customerGroup: z.string(),
  onlinePaymentEnabled: z.boolean(),
  transactions: z.array(
    z.object({
      id: uuidSchema,
      trackingCode: z.string(),
      type: z.string(),
      typeLabel: z.string(),
      amountRial: z.number().int(),
      reason: z.string(),
      createdAt: z.string(),
      balanceAfter: z.number().int(),
    }),
  ),
});

export const checkoutStartRequestSchema = z.object({
  items: z
    .array(z.object({ offeringId: uuidSchema }))
    .min(1)
    .max(30),
  idempotencyKey: idempotencyKeySchema,
});

export const paymentItemResultSchema = z.object({
  offeringId: uuidSchema,
  foodName: z.string(),
  serviceDate: serviceDateSchema,
  mealSlotTitle: z.string(),
  priceRial: z.number().int(),
  ok: z.boolean(),
  reservationId: uuidSchema.nullable(),
  code: z.string().nullable(),
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
});

export const checkoutStartResponseSchema = z.object({
  mode: z.enum(['instant', 'gateway']),
  paymentId: uuidSchema.nullable(),
  redirectUrl: z.string().nullable(),
  totalRial: z.number().int(),
  creditUsedRial: z.number().int(),
  payableRial: z.number().int(),
  creditRemainingNote: z.string().nullable(),
  items: z.array(paymentItemResultSchema),
  balanceRial: z.number().int(),
  replay: z.boolean(),
  message: z.string(),
});

export const paymentResultRequestSchema = z.object({
  paymentId: uuidSchema,
});

export const paymentResultResponseSchema = z.object({
  paymentId: uuidSchema,
  status: z.enum(['Pending', 'Paid', 'Failed', 'NeedsReview']),
  gateway: z.string(),
  totalRial: z.number().int(),
  creditUsedRial: z.number().int(),
  amountRial: z.number().int(),
  refundedToWalletRial: z.number().int(),
  refId: z.string().nullable(),
  trackingCode: z.string().nullable(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
  items: z.array(paymentItemResultSchema),
  balanceRial: z.number().int(),
  message: z.string(),
});

export const financePaymentDtoSchema = z.object({
  id: uuidSchema,
  gateway: z.string(),
  status: z.enum(['Pending', 'Paid', 'Failed', 'NeedsReview']),
  amountRial: z.number().int(),
  totalRial: z.number().int(),
  creditUsedRial: z.number().int(),
  authority: z.string().nullable(),
  refId: z.string().nullable(),
  callbackCount: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  holderIdentifier: z.string(),
  holderName: z.string(),
});

export const financePaymentsResponseSchema = z.object({
  payments: z.array(financePaymentDtoSchema),
  needsReviewCount: z.number().int(),
});

export const financePaymentResolveRequestSchema = z.object({
  action: z.enum(['retry_settle', 'mark_failed']),
  reason: z.string().trim().min(5, 'ثبت دلیل و مستند بررسی بانکی الزامی است (حداقل ۵ کاراکتر).').max(500),
});

// ---------------------------------------------------------------------------
// واردسازی اکسل
// ---------------------------------------------------------------------------
export const importPreviewQuerySchema = z.object({
  policy: z.enum(['RejectAllOnError', 'SkipInvalidRows']).default('SkipInvalidRows'),
  fullSync: z
    .string()
    .optional()
    .transform((v) => (v == null ? true : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()))),
  sheet: z.string().max(80).optional(),
});

export const importRowDtoSchema = z.object({
  rowNumber: z.number().int(),
  studentNumber: z.string(),
  fullName: z.string(),
  faculty: z.string(),
  major: z.string(),
  degree: z.string(),
  entryYear: z.number().int().nullable(),
  nationalIdMasked: z.string(),
  kind: z.string(),
  errors: z.array(z.string()),
  changes: z.array(z.string()),
});

export const importPreviewResponseSchema = z.object({
  batchId: uuidSchema,
  fileName: z.string(),
  summary: z.object({
    total: z.number().int(),
    valid: z.number().int(),
    errors: z.number().int(),
    new: z.number().int(),
    changed: z.number().int(),
    unchanged: z.number().int(),
    returning: z.number().int(),
    conflicts: z.number().int(),
    removed: z.number().int(),
  }),
  duplicateOfCommitted: z.boolean(),
  blocked: z.boolean(),
  massRemovalWarning: z.boolean(),
  rows: z.array(importRowDtoSchema),
  errorReport: z.array(z.object({ rowNumber: z.number().int(), studentNumber: z.string(), errors: z.array(z.string()) })),
  conflicts: z.array(z.object({ rowNumber: z.number().int(), studentNumber: z.string(), fullName: z.string() })),
  removed: z.array(z.object({ id: uuidSchema, studentNumber: z.string(), fullName: z.string(), faculty: z.string(), status: z.string() })),
});

export const importCommitRequestSchema = z.object({
  /** شمارهٔ ردیف‌هایی که معاونت تعارض کد ملی‌شان را صریحاً تأیید کرده است. */
  approvedConflicts: z.array(z.number().int().min(1).max(100_000)).max(10_000).optional(),
});

export const importCommitResponseSchema = z.object({
  batchId: uuidSchema,
  status: z.string(),
  written: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
  conflictsSkipped: z.number().int(),
  sessionsRevoked: z.number().int(),
  replay: z.boolean(),
});

export const importListResponseSchema = z.object({
  batches: z.array(
    z.object({
      id: uuidSchema,
      fileName: z.string(),
      status: z.string(),
      policy: z.string(),
      fullSync: z.boolean(),
      totalRows: z.number().int(),
      validRows: z.number().int(),
      errorRows: z.number().int(),
      newRows: z.number().int(),
      changedRows: z.number().int(),
      removedRows: z.number().int(),
      conflictRows: z.number().int(),
      createdAt: z.string(),
      committedAt: z.string().nullable(),
      uploadedBy: z.string().nullable(),
      canUndo: z.boolean(),
    }),
  ),
});

export const importUndoResponseSchema = z.object({
  batchId: uuidSchema,
  undone: z.number().int(),
  blocked: z.number().int(),
  reason: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// اعلان‌ها
// ---------------------------------------------------------------------------
export const notificationDtoSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  personal: z.boolean(),
  read: z.boolean(),
});

export const meNotificationsResponseSchema = z.object({
  notifications: z.array(notificationDtoSchema),
  unread: z.number().int(),
  supportText: z.string(),
  helpText: z.string(),
});

export const markNotificationsReadRequestSchema = z.object({
  notificationIds: z.array(uuidSchema).max(200).optional(),
});

export const adminNotifyRequestSchema = z.object({
  title: z.string().trim().min(2).max(150),
  body: z.string().trim().min(2).max(2000),
  audience: z.enum(['broadcast', 'account', 'staff']).default('broadcast'),
  /** شمارهٔ دانشجویی / نام کاربری کارمند — وقتی audience = account */
  identifier: z.string().trim().max(64).optional(),
  staffUserId: uuidSchema.optional(),
  sendSms: z.boolean().default(false),
});

export const adminNotificationsResponseSchema = z.object({
  notifications: z.array(
    z.object({
      id: uuidSchema,
      title: z.string(),
      body: z.string(),
      audience: z.string(),
      recipientLabel: z.string().nullable(),
      createdAt: z.string(),
      smsStatus: z.string().nullable(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// گزارش‌ها و ممیزی
// ---------------------------------------------------------------------------
export const reportsSummaryQuerySchema = z.object({
  from: serviceDateSchema,
  to: serviceDateSchema,
  cafeteriaId: uuidSchema.optional(),
  mealSlot: z.enum(['Breakfast', 'Lunch', 'Dinner']).optional(),
  customerGroup: z.enum(CUSTOMER_GROUPS).optional(),
});

export const reportsSummaryResponseSchema = z.object({
  rows: z.array(
    z.object({
      id: uuidSchema,
      date: z.string(),
      mealSlot: z.string(),
      mealSlotTitle: z.string(),
      cafeteria: z.string(),
      food: z.string(),
      capacity: z.number().int(),
      reserved: z.number().int(),
      delivered: z.number().int(),
      cancelled: z.number().int(),
      noShow: z.number().int(),
      valueRial: z.number().int(),
    }),
  ),
  totals: z.object({
    capacity: z.number().int(),
    reserved: z.number().int(),
    delivered: z.number().int(),
    cancelled: z.number().int(),
    noShow: z.number().int(),
    valueRial: z.number().int(),
  }),
  scoped: z.string().nullable(),
});

export const reportsAdvancedQuerySchema = z.object({
  from: serviceDateSchema,
  to: serviceDateSchema,
  cafeteriaId: uuidSchema.optional(),
  customerGroup: z.enum(CUSTOMER_GROUPS).optional(),
});

/** خروجی گزارش پیشرفته ساختار بزرگی دارد؛ در docs/API.md مستند شده است. */
export const reportsAdvancedResponseSchema = z.record(z.string(), z.unknown());

export const auditQuerySchema = z.object({
  search: z.string().max(80).optional(),
  action: z.string().max(80).optional(),
  actorType: z.string().max(20).optional(),
  actorId: uuidSchema.optional(),
  targetType: z.string().max(60).optional(),
  targetId: z.string().max(64).optional(),
  from: serviceDateSchema.optional(),
  to: serviceDateSchema.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const auditResponseSchema = z.object({
  logs: z.array(
    z.object({
      id: uuidSchema,
      action: z.string(),
      actorType: z.string(),
      actorLabel: z.string(),
      targetType: z.string(),
      targetId: z.string(),
      details: z.record(z.string(), z.unknown()).nullable(),
      ip: z.string(),
      createdAt: z.string(),
    }),
  ),
  total: z.number().int(),
  hasMore: z.boolean(),
});

export const dashboardResponseSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// کارکنان و کارمندان
// ---------------------------------------------------------------------------
export const staffUpsertRequestSchema = z.object({
  id: uuidSchema.optional(),
  username: z.string().trim().min(3).max(64),
  fullName: z.string().trim().min(2).max(200),
  role: z.enum(STAFF_ROLES),
  status: z.enum(['Active', 'Disabled']).default('Active'),
  contractorId: uuidSchema.nullable().optional(),
  cafeteriaId: uuidSchema.nullable().optional(),
  password: z.string().min(10).max(200).optional(),
  mustChangePassword: z.boolean().optional(),
});

export const staffListResponseSchema = z.object({
  users: z.array(
    z.object({
      id: uuidSchema,
      username: z.string(),
      fullName: z.string(),
      role: z.string(),
      status: z.string(),
      contractorId: z.string().nullable(),
      contractorName: z.string().nullable(),
      cafeteriaId: z.string().nullable(),
      cafeteriaName: z.string().nullable(),
      mustChangePassword: z.boolean(),
      lastLoginAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  manageableRoles: z.array(z.string()),
});

export const resetPasswordRequestSchema = z.object({
  newPassword: z.string().min(10).max(200).optional(),
  mustChangePassword: z.boolean().default(true),
});

export const resetPasswordResponseSchema = z.object({
  ok: z.literal(true),
  /** رمز تصادفی تولیدشده — فقط یک بار برگردانده می‌شود و ذخیره نمی‌شود. */
  temporaryPassword: z.string().nullable(),
  sessionsRevoked: z.number().int(),
});

export const employeeUpsertRequestSchema = z.object({
  id: uuidSchema.optional(),
  username: z.string().trim().min(3).max(64),
  fullName: z.string().trim().min(2).max(200),
  customerGroup: z.enum(['Employee', 'Faculty', 'Contractor']),
  department: z.string().trim().max(200).default(''),
  mobile: z
    .string()
    .trim()
    .max(20)
    .optional()
    .refine((v) => !v || /^0?9\d{9}$/.test(v.replace(/\D/g, '')), 'شمارهٔ موبایل معتبر نیست.'),
  personnelCode: z.string().trim().max(40).optional(),
  nationalIdLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'فقط ۴ رقم آخر کد ملی ذخیره می‌شود.')
    .optional(),
  status: z.enum(['Active', 'Disabled']).default('Active'),
  password: z.string().min(10).max(200).optional(),
  mustChangePassword: z.boolean().optional(),
});

export const employeeListQuerySchema = z.object({
  search: z.string().max(100).optional(),
  customerGroup: z.enum(['Employee', 'Faculty', 'Contractor']).optional(),
  status: z.enum(['Active', 'Disabled']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const employeeListResponseSchema = z.object({
  total: z.number().int(),
  employees: z.array(
    z.object({
      id: uuidSchema,
      username: z.string(),
      fullName: z.string(),
      customerGroup: z.string(),
      department: z.string(),
      mobile: z.string().nullable(),
      personnelCode: z.string().nullable(),
      nationalIdMasked: z.string(),
      status: z.string(),
      balanceRial: z.number().int(),
      mustChangePassword: z.boolean(),
      lastLoginAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// تنظیمات
// ---------------------------------------------------------------------------
export const mealSlotUpdateSchema = z.object({
  id: uuidSchema,
  title: z.string().trim().min(1).max(60),
  startTime: timeSchema,
  endTime: timeSchema,
  isActive: z.boolean().default(true),
});

export const settingsUpdateRequestSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  mealSlots: z.array(mealSlotUpdateSchema).max(10).optional(),
});

export const settingsResponseSchema = z.object({
  values: z.record(z.string(), z.string()),
  meta: z.array(
    z.object({
      key: z.string(),
      kind: z.string(),
      labelFa: z.string(),
      descriptionFa: z.string(),
      min: z.number().nullable(),
      max: z.number().nullable(),
      unit: z.string().nullable(),
      defaultValue: z.string(),
    }),
  ),
  mealSlots: z.array(
    z.object({
      id: uuidSchema,
      code: z.string(),
      title: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      isActive: z.boolean(),
    }),
  ),
  jobRuns: z.array(
    z.object({
      job: z.string(),
      status: z.string(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  payment: z.object({ enabled: z.boolean(), merchantConfigured: z.boolean(), gateway: z.string() }),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  uptimeSeconds: z.number().int(),
});

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not-ready']),
  database: z.enum(['up', 'down']),
  migrations: z.object({ applied: z.number().int(), available: z.number().int() }),
  worker: z.object({ lastRunAt: z.string().nullable() }).nullable(),
});
