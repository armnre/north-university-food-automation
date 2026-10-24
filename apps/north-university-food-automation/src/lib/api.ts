/**
 * Adapter: same function names/signatures the pages used from zitejs/api, backed by the
 * Fastify REST API (/api/v1). Session = HttpOnly cookie; token inputs are ignored.
 * State-changing requests send the double-submit CSRF header.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type In = Record<string, any>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: any) { super(message); }
}

const BASE: string = (import.meta as any).env?.VITE_API_BASE ?? '';
const csrfCookie = () => document.cookie.split('; ').find((c) => c.startsWith('__Host-csrf='))?.split('=')[1];
let csrfPromise: Promise<void> | null = null;
async function ensureCsrf() {
  if (csrfCookie()) return;
  csrfPromise ??= fetch(BASE + '/api/v1/auth/csrf', { credentials: 'include' }).then(() => undefined).finally(() => { csrfPromise = null; });
  await csrfPromise;
}

async function request(method: string, path: string, input?: In, raw?: BodyInit): Promise<any> {
  const data: In = { ...(input ?? {}) };
  delete data.token;
  let url = BASE + '/api/v1' + path.replace(/:(\w+)/g, (_, k) => { const v = data[k]; delete data[k]; return encodeURIComponent(String(v)); });
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined = raw;
  if (method === 'GET') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    if ([...q].length) url += '?' + q.toString();
  } else {
    await ensureCsrf();
    headers['x-csrf-token'] = csrfCookie() ?? '';
    if (!raw) { headers['content-type'] = 'application/json'; body = JSON.stringify(data); }
  }
  const res = await fetch(url, { method, headers, body, credentials: 'include' });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error ?? {};
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(e.message || 'خطا در ارتباط با سرور. دوباره تلاش کنید.', res.status, e.code ?? 'ERROR', e.details);
  }
  return json;
}

const ep = (method: string, path: string) => (input?: In): Promise<any> => request(method, path, input);

// auth
export const authMe = ep('GET', '/auth/me');
export const authLogout = ep('POST', '/auth/logout');
export const authSetupStatus = ep('GET', '/auth/setup-status');
export const authSetupAdmin = ep('POST', '/auth/setup-admin');
export const authStudentLogin = async (i: In) => ({ token: 'cookie', ...(await request('POST', '/auth/student/login', i)) });
export const authStaffLogin = async (i: In) => ({ token: 'cookie', ...(await request('POST', '/auth/staff/login', i)) });
export const authEmployeeLogin = async (i: In) => ({ token: 'cookie', ...(await request('POST', '/auth/employee/login', i)) });
export const authChangePassword = ep('POST', '/auth/change-password');
export const authLogoutAll = ep('POST', '/auth/logout-all');
// admin
export const adminDashboard = ep('GET', '/admin/dashboard');
export const adminStudents = ep('GET', '/admin/students');
export const adminStudentReport = (i: In) => request('GET', '/admin/students/:studentId/report', i);
export const adminStudentStatus = (i: In) => request('PATCH', '/admin/students/:studentId/status', i);
export const auditList = ep('GET', '/audit');
// catalog / offerings
export const catalogList = ep('GET', '/catalog');
export const catalogSave = ep('PUT', '/catalog');
export const offeringsList = ep('GET', '/offerings');
export const offeringSave = ep('PUT', '/offerings');
export const offeringsBulk = ep('POST', '/offerings/bulk');
// delivery
export const deliveryScan = ep('POST', '/delivery/scan');
export const deliveryConfirm = ep('POST', '/delivery/confirm');
export const deliveryStats = ep('GET', '/delivery/stats');
// finance
export const financeAdjust = ep('POST', '/finance/adjust');
export const financeLedger = ep('GET', '/finance/ledger');
export const paymentsNeedsReview = ep('GET', '/payments/needs-review');
export const paymentResolve = ep('POST', '/payments/:id/resolve');
export const paymentsReconcile = ep('POST', '/payments/reconcile');
export const employeesList = ep('GET', '/employees');
export const employeeSave = ep('PUT', '/employees');
export const employeesBulk = ep('POST', '/employees/bulk');
// imports — preview uploads the real .xlsx; the server parses and validates it
type ImpSummary = { total?: number; NEW?: number; UPDATE?: number; UNCHANGED?: number; CONFLICT?: number; ERROR?: number; REMOVED?: number; policy?: string };
const IMPORT_KIND: Record<string, string> = { NEW: 'new', UPDATE: 'changed', UNCHANGED: 'unchanged', ERROR: 'error', CONFLICT: 'conflict' };
const impSummary = (s: ImpSummary) => ({ total: s.total ?? 0, valid: (s.total ?? 0) - (s.ERROR ?? 0), errors: s.ERROR ?? 0, new: s.NEW ?? 0, changed: s.UPDATE ?? 0, unchanged: s.UNCHANGED ?? 0, conflicts: s.CONFLICT ?? 0, returning: 0, removed: s.REMOVED ?? 0 });
/** Server import history → shape the import page renders. */
export const importList = async (i?: In) => {
  const r = await request('GET', '/imports', i);
  return {
    batches: (r.batches as { id: string; fileName: string; status: string; summary: ImpSummary; createdAt: string; createdBy: string }[]).map((b) => {
      const s = impSummary(b.summary ?? {});
      return { id: b.id, fileName: b.fileName, status: b.status, totalRows: s.total, validRows: s.valid, errorRows: s.errors, newRows: s.new, changedRows: s.changed, errorReport: '[]', createdAt: b.createdAt, uploadedBy: b.createdBy };
    }),
  };
};
export const importCancel = (i: In) => request('POST', '/imports/:batchId/cancel', i);
export const importCommit = async (i: In) => {
  const r = await request('POST', '/imports/:batchId/commit', i);
  return { ...r, written: (r.created ?? 0) + (r.updated ?? 0), removed: r.removed ?? 0 };
};
export const importUndo = (i: In) => request('POST', '/imports/:batchId/undo', i);
export const importApproveConflict = (i: In) => request('POST', '/imports/:batchId/approve-conflict', i);
export const importPreview = async (i: { file: File; policy: string; fullSync: boolean; mapping?: Record<string, string> } & In) => {
  const fd = new FormData();
  fd.set('policy', i.policy);
  fd.set('fullSync', String(i.fullSync));
  if (i.mapping) fd.set('mapping', JSON.stringify(i.mapping));
  fd.set('file', i.file, i.file.name);
  const r = await request('POST', '/imports/preview', undefined, fd);
  const sum = r.summary as ImpSummary;
  return {
    ...r,
    summary: impSummary(sum),
    blocked: (sum.ERROR ?? 0) > 0 && i.policy !== 'SkipInvalidRows',
    duplicateOfCommitted: false,
    rows: (r.rows as { kind: string }[]).map((x) => ({ ...x, kind: IMPORT_KIND[x.kind] ?? x.kind })),
    removed: (r.removed as string[]).map((sn) => ({ id: sn, studentNumber: sn, fullName: '', faculty: '', major: '', status: 'Active' })),
  };
};
// notifications / settings / staff / reports / reservations
export const notificationsAdmin = (i?: In) => (i?.send ? request('POST', '/notifications', i.send) : request('GET', '/notifications'));
export const settingsManage = (i?: In) => (i?.values ? request('PUT', '/settings', { values: i.values, mealSlots: i.mealSlots }) : request('GET', '/settings'));
export const staffList = ep('GET', '/staff');
export const staffSave = ep('PUT', '/staff');
export const reportsSummary = async (i?: In) => {
  const r = await request('GET', '/reports/summary', i);
  return { ...r, rows: (r.rows as { offeringId: string; mealType: string }[]).map((x) => ({ ...x, id: x.offeringId, meal: x.mealType })) };
};
export const reportsAdvanced = ep('GET', '/reports/advanced');
export const reservationsAdminList = async (i?: In) => {
  const q: In = { limit: 100, ...(i ?? {}) };
  const r = await request('GET', '/reservations', q);
  const list = r.reservations as { priceRial: number }[];
  return { ...r, reservations: list.map((x) => ({ ...x, priceAtBooking: x.priceRial })), hasMore: Number(q.offset ?? 0) + list.length < r.total };
};
// student self-service
export const studentMenu = ep('GET', '/me/menu');
export const studentNotifications = ep('GET', '/me/notifications');
export const studentReservations = ep('GET', '/me/reservations');
export const studentReserve = ep('POST', '/me/reserve');
export const studentWallet = ep('GET', '/me/wallet');
export const studentProfile = ep('GET', '/me/profile');
export const studentReissueQr = (i: In) => request('POST', '/me/reservations/:id/reissue-qr', i);
export const studentCancelReservation = (i: In) => request('POST', '/me/reservations/:id/cancel', i);
export const paymentResult = (paymentId: string): Promise<StudentCheckoutOutputType> => request('POST', '/payments/result', { paymentId });

/**
 * Checkout: credit-only orders settle immediately; otherwise the browser leaves for Zarinpal and
 * comes back to /payment/result (this promise then never resolves, by design).
 */
export async function studentCheckout(i: In): Promise<StudentCheckoutOutputType> {
  const r = await request('POST', '/payments/checkout/start', i);
  if (r.redirectUrl) { window.location.assign(r.redirectUrl); return new Promise(() => undefined); }
  return paymentResult(r.paymentId);
}

export async function uploadFoodImage(file: File): Promise<{ url: string }> {
  const fd = new FormData();
  fd.set('file', file, file.name);
  return request('POST', '/uploads/food-image', undefined, fd);
}

export type StudentCheckoutOutputType = {
  paymentId: string; status: string; paidRial: number; creditUsedRial: number; trackingCode: string | null; createdAt: string;
  results: { offeringId: string; ok: boolean; code?: string; error?: string }[];
};
export type AdminStudentReportOutputType = any;
