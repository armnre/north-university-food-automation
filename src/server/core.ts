// Shared server-side logic. Lives outside src/api so it is NOT an endpoint.
import { zite } from 'zitejs/db';
import { ZiteError, type ZiteErrorCode } from 'zitejs/backend';

// Write helper: SDK input types require every field; we pass partial records.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = zite as any;

export type StaffRole = 'SuperAdmin' | 'StudentAffairs' | 'Contractor' | 'Operator' | 'Finance';
export type Perm =
  | 'dashboard' | 'students' | 'import' | 'users' | 'catalog' | 'menu' | 'reservations'
  | 'delivery' | 'finance' | 'financeWrite' | 'reports' | 'audit' | 'settings' | 'notify' | 'contractor';

export const ROLE_PERMS: Record<StaffRole, Perm[]> = {
  SuperAdmin: ['dashboard', 'students', 'import', 'users', 'catalog', 'menu', 'reservations', 'delivery', 'finance', 'reports', 'audit', 'settings', 'notify'],
  StudentAffairs: ['dashboard', 'students', 'import', 'notify'],
  Contractor: ['contractor'],
  Operator: ['delivery'],
  Finance: ['dashboard', 'finance', 'financeWrite', 'reports'],
};

export function fail(code: string, userMessage: string): never {
  throw new ZiteError({ code: code as ZiteErrorCode, message: userMessage, userFacingMessage: userMessage });
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256(s: string) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
export function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function randomCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map((x) => alphabet[x % alphabet.length]).join('');
}

/** Keyed hash (HMAC-SHA256) of a national id — raw value is never stored. */
export async function hashNationalId(nid: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(process.env.ZITE_NATIONAL_ID_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(nid)));
}

/** PBKDF2-SHA256 (Argon2id is not available in the Worker runtime — see docs/SECURITY.md). */
const ITER = 100000;
export async function hashPassword(pw: string, saltHex = randomHex(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${saltHex}$${hex(bits)}`;
}
export async function verifyPassword(pw: string, stored: string) {
  const [, , salt] = stored.split('$');
  if (!salt) return false;
  const again = await hashPassword(pw, salt);
  if (again.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < again.length; i++) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

export function normalizeDigits(s: string) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s\u200c-]/g, '')
    .trim();
}

/** Iranian national id checksum validation. */
export function isValidNationalId(raw: string) {
  const c = normalizeDigits(raw);
  if (!/^\d{10}$/.test(c) || /^(\d)\1{9}$/.test(c)) return false;
  const check = +c[9];
  const s = c.split('').slice(0, 9).reduce((a, d, i) => a + +d * (10 - i), 0) % 11;
  return s < 2 ? check === s : check === 11 - s;
}

export const tehranToday = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
export const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

// ---------- Throttling ----------
const MAX_FAILS = 5;
const LOCK_MIN = 15;
export async function checkThrottle(key: string) {
  const row = await zite.loginThrottle.findOne({ filters: { key } });
  if (row?.lockedUntil && new Date(row.lockedUntil) > new Date()) {
    fail('TOO_MANY_REQUESTS', 'به دلیل تلاش‌های ناموفق متعدد، ورود موقتاً مسدود شده است. چند دقیقه بعد دوباره تلاش کنید.');
  }
  return row;
}
export async function recordFailure(key: string, failures: number) {
  const n = failures + 1;
  const lockedUntil = n >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
  await db.loginThrottle.bulkCreate({ records: [{ key, failures: n >= MAX_FAILS ? 0 : n, lockedUntil }], matchOn: ['key'] });
  // progressive delay against guessing
  await new Promise((r) => setTimeout(r, Math.min(300 * n, 1500)));
  return n >= MAX_FAILS;
}
export async function clearThrottle(key: string) {
  await db.loginThrottle.bulkCreate({ records: [{ key, failures: 0, lockedUntil: null }], matchOn: ['key'] });
}

// ---------- Sessions ----------
export async function createSession(subjectType: 'Student' | 'Staff', subjectId: string, hours: number) {
  const token = randomHex(32);
  await db.sessions.create({ record: { tokenHash: await sha256(token), subjectType, subjectId, expiresAt: new Date(Date.now() + hours * 3600000).toISOString(), revoked: false } });
  return token;
}

async function loadSession(token: string) {
  if (!token || token.length !== 64) fail('UNAUTHORIZED', 'نشست شما معتبر نیست. دوباره وارد شوید.');
  const s = await zite.sessions.findOne({ filters: { tokenHash: await sha256(token) } });
  if (!s || s.revoked || !s.expiresAt || new Date(s.expiresAt) < new Date()) fail('UNAUTHORIZED', 'نشست شما منقضی شده است. دوباره وارد شوید.');
  return s;
}

export async function requireStudent(token: string) {
  const s = await loadSession(token);
  if (s.subjectType !== 'Student') fail('FORBIDDEN', 'این بخش مخصوص دانشجویان است.');
  const student = await zite.students.findOne({ id: s.subjectId! });
  if (!student || student.status !== 'Active') fail('FORBIDDEN', 'حساب دانشجویی شما فعال نیست.');
  return student;
}

export async function requireStaff(token: string, perm?: Perm) {
  const s = await loadSession(token);
  if (s.subjectType !== 'Staff') fail('FORBIDDEN', 'دسترسی به این بخش مجاز نیست.');
  const staff = await zite.staffUsers.findOne({ id: s.subjectId! });
  if (!staff || staff.status !== 'Active') fail('FORBIDDEN', 'حساب کاربری شما غیرفعال است.');
  const role = staff.role as StaffRole;
  if (perm && !ROLE_PERMS[role]?.includes(perm)) fail('FORBIDDEN', 'شما مجوز انجام این عملیات را ندارید.');
  return { ...staff, role };
}

export async function revokeSession(token: string) {
  const s = await zite.sessions.findOne({ filters: { tokenHash: await sha256(token) } });
  if (s) await db.sessions.update({ id: s.id, record: { revoked: true } });
}

// ---------- Audit ----------
export async function audit(actor: { type: string; id: string; label: string }, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}) {
  await db.auditLogs.create({ record: { action, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, targetType, targetId, details: JSON.stringify(details) } });
}
export const staffActor = (s: { id: string; username?: string; fullName?: string }) => ({ type: 'Staff', id: s.id, label: s.fullName || s.username || '' });
export const studentActor = (s: { id: string; studentNumber?: string }) => ({ type: 'Student', id: s.id, label: s.studentNumber || '' });

// ---------- Ledger ----------
/** Balance is always derived from the immutable ledger — never a stored column. */
export async function balanceOf(studentId: string) {
  const r = await zite.sql({
    query: `SELECT COALESCE(SUM(e."amountRial"),0) AS b FROM "LedgerEntries" e JOIN "LedgerEntriesStudents" l ON l."ledgerEntriesId" = e.id WHERE l."studentsId" = $1`,
    params: [studentId],
  });
  return Number(r.rows[0]?.b ?? 0);
}

/** Idempotent ledger post: upsert on idempotency key so retries never double-post. */
export async function postLedger(e: { studentId: string; type: string; amount: number; counter: string; reservationId?: string; actorStaffId?: string; reason: string; key: string }) {
  if (!Number.isInteger(e.amount) || e.amount === 0) fail('BAD_REQUEST', 'مبلغ نامعتبر است.');
  const existing = await zite.ledgerEntries.findOne({ filters: { idempotencyKey: e.key } });
  if (existing) return existing;
  const res = await db.ledgerEntries.bulkCreate({
    records: [{
      trackingCode: `TX-${randomCode(10)}`, student: [e.studentId], type: e.type, amountRial: e.amount, counterAccount: e.counter,
      reservation: e.reservationId ? [e.reservationId] : null, actorStaff: e.actorStaffId ? [e.actorStaffId] : null,
      reason: e.reason, idempotencyKey: e.key,
    }],
    matchOn: ['idempotencyKey'],
  });
  return res.records[0];
}

export async function addHistory(reservationId: string, from: string, to: string, actor: string, note: string) {
  await db.reservationHistory.create({ record: { reservation: [reservationId], fromStatus: from, toStatus: to, actor, note } });
}

export async function getSetting(key: string, fallback = '') {
  const r = await zite.systemSettings.findOne({ filters: { key } });
  return r?.value ?? fallback;
}
