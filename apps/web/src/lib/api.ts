/**
 * لایهٔ ارتباط با بک‌اند.
 *
 * جایگزین کامل `zitejs/api`:
 *  - `fetch` تایپ‌شده با `credentials: 'include'` (نشست در کوکی HttpOnly)
 *  - هدر `X-CSRF-Token` از کوکی `csrf` برای همهٔ متدهای غیر GET
 *  - مدیریت خطای یکسان (پیام فارسی از `{ error: { code, message } }`)
 *  - ریدایرکت به ورود در `401` از طریق رویداد `food:unauthorized`
 *
 * هیچ توکنی در `sessionStorage`/`localStorage` نگه داشته نمی‌شود.
 */

const API_BASE = '/api/v1';
export const UNAUTHORIZED_EVENT = 'food:unauthorized';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(message: string, code: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: 'اطلاعات واردشده معتبر نیست.',
  401: 'نشست شما معتبر نیست؛ دوباره وارد شوید.',
  403: 'شما به این بخش دسترسی ندارید.',
  404: 'مورد درخواستی یافت نشد.',
  409: 'این مورد با اطلاعات موجود تداخل دارد.',
  423: 'ورود موقتاً مسدود شده است. چند دقیقه دیگر دوباره تلاش کنید.',
  428: 'برای ادامه، کد امنیتی را وارد کنید.',
  429: 'تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره امتحان کنید.',
  500: 'خطای غیرمنتظره در سامانه رخ داد. دوباره تلاش کنید.',
};

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export type RequestOptions = {
  body?: unknown;
  query?: Record<string, unknown>;
  /** برای پاسخ‌های غیر JSON (مثل دانلود فایل) */
  raw?: boolean;
  signal?: AbortSignal;
};

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${path}${buildQuery(options.query)}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const csrf = readCookie('csrf');
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, credentials: 'include', signal: options.signal, redirect: 'follow' });
  } catch {
    throw new ApiError('ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید.', 'NETWORK', 0);
  }

  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { path } }));
  }

  if (options.raw) {
    if (!response.ok) throw await toApiError(response);
    return (await response.blob()) as unknown as T;
  }

  const text = await response.text();
  const parsed: unknown = text ? safeJson(text) : null;
  if (!response.ok) {
    throw toApiErrorFromBody(response.status, parsed);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  return toApiErrorFromBody(response.status, text ? safeJson(text) : null);
}

function toApiErrorFromBody(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
  const message = error?.message && /[\u0600-\u06FF]/.test(error.message) ? error.message : (FALLBACK_MESSAGES[status] ?? 'خطای نامشخص رخ داد.');
  return new ApiError(message, error?.code ?? 'INTERNAL', status, error?.details ?? {});
}

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>, options?: { raw?: boolean; signal?: AbortSignal }) =>
    request<T>('GET', path, { query, raw: options?.raw, signal: options?.signal }),
  post: <T>(path: string, body?: unknown, query?: Record<string, unknown>) => request<T>('POST', path, { body, query }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, { body }),
  upload: <T>(path: string, file: File, query?: Record<string, unknown>, fieldName = 'file') => {
    const form = new FormData();
    form.append(fieldName, file);
    return request<T>('POST', path, { body: form, query });
  },
};

// ---------------------------------------------------------------------------
// قرارداد توابع: همان نام‌ها و همان شکل ورودی‌های نسخهٔ قبلی (بدون `token`)
// تا صفحه‌های فرانت‌اند بدون بازنویسی کار کنند. نگاشت به REST در همین لایه است.
// ---------------------------------------------------------------------------

export type SetupStatus = { needsSetup: boolean; setupCodeConfigured: boolean };
export type Captcha = { captchaId: string; kind: 'Math' | 'Text'; imageSvg: string; expiresAt: string; required: boolean };
export type LoginResult = { ok: true; kind: 'student' | 'employee' | 'staff'; mustChangePassword: boolean; newDevice: boolean };

export const authSetupStatus = () => api.get<SetupStatus>('/auth/setup-status');
export const authSetupAdmin = (input: { setupCode: string; username: string; fullName: string; password: string }) =>
  api.post<SetupStatus>('/auth/setup-admin', input);
export const authCaptcha = () => api.get<Captcha>('/auth/captcha');
export const authStudentLogin = (input: { studentNumber: string; nationalId: string; captchaId?: string; captchaAnswer?: string }) =>
  api.post<LoginResult>('/auth/student/login', input);
export const authStaffLogin = (input: { username: string; password: string; captchaId?: string; captchaAnswer?: string }) =>
  api.post<LoginResult>('/auth/staff/login', input);
export const authEmployeeLogin = (input: { username: string; password: string; captchaId?: string; captchaAnswer?: string }) =>
  api.post<LoginResult>('/auth/employee/login', input);
export const authLogout = () => api.post<{ ok: true; revoked: number }>('/auth/logout');
export const authLogoutAll = () => api.post<{ ok: true; revoked: number }>('/auth/logout-all');
export const authChangePassword = (input: { currentPassword: string; newPassword: string }) =>
  api.post<{ ok: true; revoked: number }>('/auth/change-password', input);

export type SessionItem = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};
export const authSessions = () => api.get<{ sessions: SessionItem[] }>('/auth/sessions');
export const authRevokeSession = (sessionId: string) => api.delete<{ ok: true; revoked: number }>('/auth/sessions', { sessionId });

export type StudentMe = {
  id: string;
  studentNumber: string;
  fullName: string;
  faculty: string;
  major: string;
  degree: string;
  entryYear: number | null;
  nationalIdMasked: string;
  status: string;
  balanceRial: number;
  customerGroup: 'Student';
  lastLoginAt: string | null;
  previousLogin: { at: string; ip: string | null; userAgent: string | null } | null;
};
export type EmployeeMe = {
  id: string;
  username: string;
  fullName: string;
  department: string;
  mobile: string | null;
  customerGroup: 'Employee' | 'Faculty' | 'Contractor';
  status: string;
  balanceRial: number;
  accountId: string;
};
export type StaffMe = {
  id: string;
  username: string;
  fullName: string;
  status: string;
  role: string;
  permissions: string[];
  /** سازگاری با نام قدیمی `perms` در کامپوننت‌ها */
  perms: string[];
  contractorId: string | null;
  cafeteriaId: string | null;
  mustChangePassword: boolean;
};
export type Me = { kind: 'student'; student: StudentMe } | { kind: 'employee'; employee: EmployeeMe } | { kind: 'staff'; staff: StaffMe };

/** `/auth/me` — فیلد `perms` برای سازگاری با منوی فعلی از `permissions` پر می‌شود. */
export async function authMe(): Promise<Me> {
  const me = await api.get<Me>('/auth/me');
  if (me.kind === 'staff') return { kind: 'staff', staff: { ...me.staff, perms: me.staff.permissions ?? [] } };
  return me;
}

// --- داشبورد و دانشجویان ---------------------------------------------------
export const adminDashboard = () => api.get<Record<string, unknown>>('/admin/dashboard');

export type StudentListQuery = {
  search?: string;
  status?: string;
  faculty?: string;
  major?: string;
  degree?: string;
  entryYear?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
};
export const adminStudents = (query: StudentListQuery = {}) => api.get<Record<string, unknown>>('/admin/students', query);
/** گزارش کامل یک دانشجو (مطابق `studentReportResponseSchema` در @food/shared). */
export type StudentReport = {
  profile: {
    id: string;
    studentNumber: string;
    fullName: string;
    faculty: string;
    major: string;
    degree: string;
    entryYear: number | null;
    status: string;
    nationalIdMasked: string;
    addedAt: string | null;
    removedAt: string | null;
    lastLoginAt: string | null;
    lastImport: string | null;
  };
  stats: {
    balanceRial: number;
    creditsRial: number;
    debitsRial: number;
    total: number;
    reserved: number;
    delivered: number;
    cancelled: number;
    noShow: number;
    expired: number;
    rejected: number;
    spentRial: number;
    refundedRial: number;
  };
  reservations: {
    id: string;
    code: string;
    status: string;
    priceRial: number;
    createdAt: string | null;
    serviceDate: string;
    mealSlot: string;
    food: string;
    cafeteria: string;
    deliveredAt: string | null;
  }[];
  ledger: { trackingCode: string; type: string; amountRial: number; reason: string; createdAt: string; balanceAfter: number | null }[];
};

export const adminStudentReport = (input: { studentId: string } | string) => {
  const id = typeof input === 'string' ? input : input.studentId;
  return api.get<StudentReport>(`/admin/students/${id}/report`);
};
export const adminStudentStatus = (input: { studentId: string; status: string; reason?: string }) =>
  api.patch<{ ok: true }>(`/admin/students/${input.studentId}/status`, { status: input.status, reason: input.reason });

// --- ممیزی -----------------------------------------------------------------
export type AuditQuery = { search?: string; action?: string; actorType?: string; from?: string; to?: string; offset?: number; limit?: number };
export const auditList = (query: AuditQuery = {}) => api.get<{ logs: unknown[]; total: number; hasMore: boolean }>('/audit', query);
export const auditActions = () => api.get<{ actions: string[] }>('/audit/actions');

// --- کاتالوگ ---------------------------------------------------------------
export type CatalogItem =
  | { kind: 'contractor'; id?: string; name: string; contractNumber: string; contactPhone?: string; isActive: boolean }
  | { kind: 'cafeteria'; id?: string; name: string; location: string; contractorId?: string | null; isActive: boolean }
  | {
      kind: 'food';
      id?: string;
      name: string;
      description: string;
      category?: string;
      imagePath?: string;
      calories?: number | null;
      defaultPriceRial?: number | null;
      defaultCapacity?: number | null;
      isActive: boolean;
    };

export const catalogList = () => api.get<Record<string, unknown>>('/catalog');
export const catalogSave = (input: { item: CatalogItem }) =>
  input.item.id
    ? api.put<{ id: string }>(`/catalog/${input.item.kind}/${input.item.id}`, { item: input.item })
    : api.post<{ id: string }>('/catalog', { item: input.item });
export const uploadFoodImage = (file: File) =>
  api.upload<{
    url: string;
    mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
    sizeBytes: number;
    width: number | null;
    height: number | null;
  }>('/uploads/food-image', file);

// --- منو و وعده‌ها ---------------------------------------------------------
export type OfferingQuery = { from?: string; to?: string; cafeteriaId?: string; mealSlot?: string; status?: string; foodId?: string };
export const offeringsList = (query: OfferingQuery = {}) => api.get<{ offerings: unknown[] }>('/offerings', query);

export type OfferingUpsert = {
  id?: string;
  serviceDate: string;
  mealSlot: string;
  foodId: string;
  cafeteriaId?: string;
  capacity: number;
  reserveOpensAt?: string;
  reserveDeadline: string;
  cancelDeadline?: string | null;
  status?: string;
  /** سازگاری با فرم قدیمی: `active` به وضعیت نگاشت می‌شود. */
  active?: boolean;
  notes: string;
  /** سازگاری با فرم قدیمی: یک قیمت برای همهٔ گروه‌ها */
  priceRial?: number;
  prices?: { all?: number; Student?: number; Employee?: number; Faculty?: number; Contractor?: number };
  reason?: string;
};

export const offeringSave = (input: OfferingUpsert) => {
  const prices = input.prices ?? { all: Number(input.priceRial ?? 0) };
  const status = input.status ?? (input.active === false ? 'Draft' : 'Published');
  const body = {
    serviceDate: input.serviceDate,
    mealSlot: input.mealSlot,
    foodId: input.foodId,
    cafeteriaId: input.cafeteriaId,
    capacity: input.capacity,
    reserveOpensAt: input.reserveOpensAt,
    reserveDeadline: input.reserveDeadline,
    cancelDeadline: input.cancelDeadline ?? null,
    status,
    notes: input.notes ?? '',
    prices,
    reason: input.reason,
  };
  return input.id ? api.put<{ id: string }>(`/offerings/${input.id}`, body) : api.post<{ id: string }>('/offerings', body);
};

export type BulkInput = {
  mode: 'items' | 'copy';
  items?: {
    serviceDate: string;
    mealSlot: string;
    foodId: string;
    cafeteriaId?: string;
    capacity: number;
    priceRial?: number;
    prices?: { all?: number; Student?: number; Employee?: number; Faculty?: number; Contractor?: number };
    reserveDeadline: string;
    cancelDeadline?: string;
    notes?: string;
    status?: string;
  }[];
  sourceFrom?: string;
  sourceTo?: string;
  targetStart?: string;
  repeat?: number;
};

export const offeringsBulk = (input: BulkInput) =>
  api.post<{ created: number; skipped: number }>('/offerings/bulk', {
    mode: input.mode,
    sourceFrom: input.sourceFrom,
    sourceTo: input.sourceTo,
    targetStart: input.targetStart,
    repeat: input.repeat ?? 1,
    items: input.items?.map((item) => ({
      serviceDate: item.serviceDate,
      mealSlot: item.mealSlot,
      foodId: item.foodId,
      cafeteriaId: item.cafeteriaId,
      capacity: item.capacity,
      reserveDeadline: item.reserveDeadline,
      cancelDeadline: item.cancelDeadline,
      notes: item.notes ?? '',
      status: item.status ?? 'Published',
      prices: item.prices ?? { all: Number(item.priceRial ?? 0) },
    })),
  });

export const offeringStatus = (id: string, body: { status: string; reason: string; confirmText?: string }) =>
  api.patch<{ id: string; status: string; cancelledReservations: number; refundedRial: number; notified: number; failed: number }>(
    `/offerings/${id}/status`,
    body,
  );

// --- امور دانشجو/کارمند ---------------------------------------------------
export const studentMenu = (input: { from: string; to: string }) => api.get<Record<string, unknown>>('/me/menu', input);
export const studentReserve = (input: { offeringId: string; idempotencyKey: string }) =>
  api.post<{ reservationId: string; code: string; priceRial: number; balanceRial: number; replay: boolean }>('/me/reservations', input);
/** سبد خرید: `offeringIds` (شکل قدیمی) به `items` نگاشت می‌شود. */
export const studentCheckout = (input: { offeringIds?: string[]; items?: { offeringId: string }[]; idempotencyKey: string }) =>
  api.post<Record<string, unknown>>('/me/checkout', {
    items: (input.items ?? (input.offeringIds ?? []).map((offeringId) => ({ offeringId }))).slice(0, 30),
    idempotencyKey: input.idempotencyKey,
  });
export type PaymentItemResultDto = {
  offeringId: string;
  foodName: string;
  serviceDate: string;
  mealSlotTitle: string;
  priceRial: number;
  ok: boolean;
  reservationId: string | null;
  code: string | null;
  error: string | null;
  errorCode: string | null;
};

export type CheckoutStartDto = {
  mode: 'instant' | 'gateway';
  paymentId: string | null;
  redirectUrl: string | null;
  totalRial: number;
  creditUsedRial: number;
  payableRial: number;
  creditRemainingNote: string | null;
  items: PaymentItemResultDto[];
  balanceRial: number;
  replay: boolean;
  message: string;
};

export type PaymentResultDto = {
  paymentId: string;
  status: 'Pending' | 'Paid' | 'Failed' | 'NeedsReview';
  gateway: string;
  totalRial: number;
  creditUsedRial: number;
  amountRial: number;
  refundedToWalletRial: number;
  refId: string | null;
  trackingCode: string | null;
  createdAt: string;
  verifiedAt: string | null;
  items: PaymentItemResultDto[];
  balanceRial: number;
  message: string;
};

export const checkoutStart = (input: { items: { offeringId: string }[]; idempotencyKey: string }) =>
  api.post<CheckoutStartDto>('/payments/checkout/start', input);
export const paymentResult = (paymentId: string) =>
  api.post<PaymentResultDto>('/payments/result', { paymentId });
export const studentReservations = () => api.get<Record<string, unknown>>('/me/reservations');
export const reissueQr = (id: string) => api.post<{ id: string; qrToken: string; issuedAt: string }>(`/me/reservations/${id}/qr/reissue`);
export const studentWallet = () => api.get<Record<string, unknown>>('/me/wallet');
export const paymentStatus = () =>
  api.get<{ enabled: boolean; gateway: string; minPayableRial: number; message: string }>('/payments/status');
export const studentNotifications = () => api.get<Record<string, unknown>>('/me/notifications');
export const markNotificationsRead = (notificationIds?: string[]) => api.post<{ ok: true }>('/me/notifications/read', { notificationIds });

// --- رزروها (مدیریت) ------------------------------------------------------
export type AdminReservationQuery = {
  from?: string;
  to?: string;
  cafeteriaId?: string;
  offeringId?: string;
  status?: string;
  customerGroup?: string;
  search?: string;
  offset?: number;
  limit?: number;
};
export const reservationsAdminList = (query: AdminReservationQuery = {}) =>
  api.get<{ reservations: unknown[]; total: number; hasMore: boolean }>('/reservations', query);
export const adminCancelReservation = (id: string, reason: string) =>
  api.post<{ id: string; status: string; refundedRial: number; balanceRial: number }>(`/reservations/${id}/cancel`, { reason });

// --- تحویل ---------------------------------------------------------------
export const deliveryScan = (input: { qrToken: string } | string) =>
  api.post<Record<string, unknown>>('/delivery/scan', { qrToken: typeof input === 'string' ? input : input.qrToken });
export const deliveryConfirm = (input: { qrToken: string; clientEventId?: string; deviceId?: string; scannedAt?: string } | string) =>
  api.post<Record<string, unknown>>('/delivery/confirm', typeof input === 'string' ? { qrToken: input } : input);
export const deliveryStats = () => api.get<Record<string, unknown>>('/delivery/stats');
export const offlineManifest = (cafeteriaId?: string) => api.get<Record<string, unknown>>('/delivery/offline-manifest', { cafeteriaId });
export const offlineSync = (events: unknown[]) => api.post<Record<string, unknown>>('/delivery/sync', { events });
export const offlineConflicts = () => api.get<{ conflicts: unknown[] }>('/delivery/offline-conflicts');

// --- مالی ----------------------------------------------------------------
export const financeAdjust = (input: {
  studentNumber?: string;
  identifier?: string;
  subject?: 'student' | 'employee';
  direction: 'credit' | 'debit';
  amountRial: number;
  reason: string;
  idempotencyKey: string;
}) =>
  api.post<{ trackingCode: string; balanceRial: number; amountRial: number; replay: boolean }>('/finance/adjust', {
    subject: input.subject ?? 'student',
    identifier: input.identifier ?? input.studentNumber ?? '',
    direction: input.direction,
    amountRial: input.amountRial,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  });

export const financeLedger = (query: { type?: string; search?: string; from?: string; to?: string; customerGroup?: string; offset?: number; limit?: number } = {}) =>
  api.get<Record<string, unknown>>('/finance/ledger', query);
export const financePayments = (query: { status?: 'Pending' | 'Paid' | 'Failed' | 'NeedsReview'; offset?: number; limit?: number } = {}) =>
  api.get<{
    payments: {
      id: string;
      gateway: string;
      status: 'Pending' | 'Paid' | 'Failed' | 'NeedsReview';
      amountRial: number;
      totalRial: number;
      creditUsedRial: number;
      authority: string | null;
      refId: string | null;
      callbackCount: number;
      lastError: string | null;
      createdAt: string;
      verifiedAt: string | null;
      resolvedAt: string | null;
      resolutionNote: string | null;
      holderIdentifier: string;
      holderName: string;
    }[];
    needsReviewCount: number;
  }>('/finance/payments', query);
export const resolveFinancePayment = (id: string, body: { action: 'retry_settle' | 'mark_failed'; reason: string }) =>
  api.post<{ status: 'Paid' | 'Failed' | 'NeedsReview' }>(`/finance/payments/${id}/resolve`, body);
export const financeReconcile = () => api.get<Record<string, unknown>>('/finance/reconcile');

// --- واردسازی اکسل -------------------------------------------------------
/** آپلود فایل xlsx به سرور (پارس سمت سرور با exceljs). */
export const importPreview = (file: File, options: { policy: string; fullSync: boolean; sheet?: string }) =>
  api.upload<Record<string, unknown>>('/imports/preview', file, { policy: options.policy, fullSync: String(options.fullSync), sheet: options.sheet });
export const importCommit = (input: { batchId: string; approvedConflicts?: number[] } | string, approvedConflicts?: number[]) => {
  const batchId = typeof input === 'string' ? input : input.batchId;
  const conflicts = typeof input === 'string' ? approvedConflicts : input.approvedConflicts;
  return api.post<Record<string, unknown>>(`/imports/${batchId}/commit`, { approvedConflicts: conflicts });
};
export const importCancel = (input: { batchId: string } | string) =>
  api.post<{ ok: true }>(`/imports/${typeof input === 'string' ? input : input.batchId}/cancel`);
export const importUndo = (id: string) => api.post<{ batchId: string; undone: number; blocked: number; reason: string | null }>(`/imports/${id}/undo`);
export const importList = () => api.get<{ batches: unknown[] }>('/imports');

// --- اعلان‌ها -------------------------------------------------------------
export const notificationsAdmin = (input?: { send?: { title: string; body: string; audience?: string; identifier?: string; studentNumber?: string; sendSms?: boolean } }) => {
  if (!input?.send) return api.get<Record<string, unknown>>('/notifications/admin');
  const send = input.send;
  return api.post<Record<string, unknown>>('/notifications/admin', {
    title: send.title,
    body: send.body,
    audience: send.audience ?? (send.studentNumber ? 'account' : 'broadcast'),
    identifier: send.studentNumber ?? send.identifier,
    sendSms: send.sendSms ?? false,
  });
};

// --- گزارش‌ها -------------------------------------------------------------
export const reportsSummary = (query: { from: string; to: string; cafeteriaId?: string; mealSlot?: string; customerGroup?: string }) =>
  api.get<Record<string, unknown>>('/reports/summary', query);
export const reportsAdvanced = (query: { from: string; to: string; cafeteriaId?: string; customerGroup?: string }) =>
  api.get<Record<string, unknown>>('/reports/advanced', query);
export const reportSummaryCsvUrl = (query: Record<string, unknown>) => `${API_BASE}/reports/summary.csv${buildQuery(query)}`;
export const reportSummaryXlsxUrl = (query: Record<string, unknown>) => `${API_BASE}/reports/summary.xlsx${buildQuery(query)}`;
export const reportLedgerCsvUrl = (query: Record<string, unknown>) => `${API_BASE}/reports/ledger.csv${buildQuery(query)}`;
export const reportLedgerXlsxUrl = (query: Record<string, unknown>) => `${API_BASE}/reports/ledger.xlsx${buildQuery(query)}`;

// --- تنظیمات -------------------------------------------------------------
export type SettingsPayload = {
  values: Record<string, string>;
  meta: { key: string; kind: string; labelFa: string; descriptionFa: string; min: number | null; max: number | null; unit: string | null; defaultValue: string }[];
  mealSlots: { id: string; code: string; title: string; startTime: string; endTime: string; isActive: boolean }[];
  jobRuns: { job: string; status: string; startedAt: string; finishedAt: string | null; message: string | null }[];
  payment: { enabled: boolean; merchantConfigured: boolean; gateway: string };
};
export const settingsManage = (input?: { values?: Record<string, string | number | boolean>; mealSlots?: unknown[] }) =>
  input && (input.values !== undefined || input.mealSlots !== undefined)
    ? api.put<SettingsPayload>('/settings', input)
    : api.get<SettingsPayload>('/settings');

// --- کارکنان و کارمندان --------------------------------------------------
export type StaffUpsert = {
  id?: string;
  username: string;
  fullName: string;
  role: string;
  status: string;
  contractorId?: string | null;
  cafeteriaId?: string | null;
  password?: string;
  mustChangePassword?: boolean;
};
export const staffList = () => api.get<{ users: unknown[]; manageableRoles: string[] }>('/staff');
export const staffSave = (input: StaffUpsert) =>
  input.id ? api.put<{ id: string }>(`/staff/${input.id}`, input) : api.post<{ id: string }>('/staff', input);
export const staffResetPassword = (id: string, body: { newPassword?: string; mustChangePassword?: boolean } = {}) =>
  api.post<{ ok: true; temporaryPassword: string | null; sessionsRevoked: number }>(`/staff/${id}/reset-password`, body);

export type EmployeeUpsert = {
  id?: string;
  username: string;
  fullName: string;
  customerGroup: 'Employee' | 'Faculty' | 'Contractor';
  department?: string;
  mobile?: string;
  personnelCode?: string;
  nationalIdLast4?: string;
  status: 'Active' | 'Disabled';
  password?: string;
};
export const employeesList = (query: { search?: string; customerGroup?: string; status?: string; offset?: number; limit?: number } = {}) =>
  api.get<Record<string, unknown>>('/employees', query);
export const employeeSave = (input: EmployeeUpsert) =>
  input.id
    ? api.put<{ id: string; temporaryPassword: string | null }>(`/employees/${input.id}`, input)
    : api.post<{ id: string; temporaryPassword: string | null }>('/employees', input);
export const employeeResetPassword = (id: string, body: { newPassword?: string } = {}) =>
  api.post<{ ok: true; temporaryPassword: string | null; sessionsRevoked: number }>(`/employees/${id}/reset-password`, body);
export const employeesBulk = (file: File) => api.upload<{ created: number; skipped: number; downloadUrl: string }>('/employees/bulk', file);
export const downloadEmployeeCredentials = () => api.get<Blob>('/employees/credentials', undefined, { raw: true });
