import { and, eq, sql } from 'drizzle-orm';
import type { CustomerGroup } from '@food/shared';
import { normalizeDigits } from '@food/shared';
import { accounts, employees, students } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps, Tx } from '../types.js';

/**
 * حساب کیف پول و دارندگان آن (دانشجو / کارمند).
 * هر دانشجو و هر کارمند دقیقاً یک حساب دارد (قید یکتایی در دیتابیس).
 */

export type AccountHolder = {
  accountId: string;
  kind: 'Student' | 'Employee';
  customerGroup: CustomerGroup;
  balanceRial: number;
  isActive: boolean;
  holderId: string;
  /** شمارهٔ دانشجویی یا نام کاربری — برای نمایش و جستجو (نه دادهٔ حساس). */
  identifier: string;
  fullName: string;
  subjectStatus: string;
};

/** ساخت حساب برای دانشجو اگر وجود ندارد (idempotent). */
export async function ensureStudentAccount(target: Tx | ServiceDeps['db'], studentId: string): Promise<string> {
  const existing = await target.select({ id: accounts.id }).from(accounts).where(eq(accounts.studentId, studentId)).limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await target
    .insert(accounts)
    .values({ kind: 'Student', studentId, customerGroup: 'Student', balanceRial: 0, isActive: true })
    .onConflictDoNothing({ target: accounts.studentId })
    .returning({ id: accounts.id });
  if (created) return created.id;
  const again = await target.select({ id: accounts.id }).from(accounts).where(eq(accounts.studentId, studentId)).limit(1);
  if (!again[0]) throw new AppError('INTERNAL', 'ساخت حساب کیف پول ممکن نشد.');
  return again[0].id;
}

/** ساخت حساب برای کارمند/هیئت‌علمی/پیمانکار دانشگاه اگر وجود ندارد. */
export async function ensureEmployeeAccount(
  target: Tx | ServiceDeps['db'],
  employeeId: string,
  customerGroup: 'Employee' | 'Faculty' | 'Contractor',
): Promise<string> {
  const existing = await target.select({ id: accounts.id }).from(accounts).where(eq(accounts.employeeId, employeeId)).limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await target
    .insert(accounts)
    .values({ kind: 'Employee', employeeId, customerGroup, balanceRial: 0, isActive: true })
    .onConflictDoNothing({ target: accounts.employeeId })
    .returning({ id: accounts.id });
  if (created) return created.id;
  const again = await target.select({ id: accounts.id }).from(accounts).where(eq(accounts.employeeId, employeeId)).limit(1);
  if (!again[0]) throw new AppError('INTERNAL', 'ساخت حساب کیف پول ممکن نشد.');
  return again[0].id;
}

/** قفل ردیف `accounts` (`FOR UPDATE OF a`) و خواندن هم‌زمان اطلاعات دارندهٔ حساب در یک پرس‌وجوی واحد. */
export async function lockAccountHolderForUpdate(target: Tx, accountId: string): Promise<AccountHolder | null> {
  const rows = await target.execute(
    sql`
      SELECT a.id AS "accountId", a.kind, a.customer_group AS "customerGroup", a.balance_rial::text AS "balanceRial", a.is_active AS "isActive",
             s.id AS "studentId", s.student_number AS "studentIdentifier", s.full_name AS "studentName", s.status AS "studentStatus",
             e.id AS "employeeId", e.username AS "employeeIdentifier", e.full_name AS "employeeName", e.status AS "employeeStatus"
      FROM accounts a
      LEFT JOIN students s ON s.id = a.student_id
      LEFT JOIN employees e ON e.id = a.employee_id
      WHERE a.id = ${accountId}
      FOR UPDATE OF a`,
  );
  const row = (rows as unknown as { rows: Record<string, unknown>[] }).rows?.[0];
  if (!row) return null;
  const kind = String(row.kind) === 'Student' ? 'Student' : 'Employee';
  return {
    accountId: String(row.accountId),
    kind,
    customerGroup: String(row.customerGroup) as CustomerGroup,
    balanceRial: Number(row.balanceRial ?? 0),
    isActive: Boolean(row.isActive),
    holderId: kind === 'Student' ? String(row.studentId) : String(row.employeeId),
    identifier: kind === 'Student' ? String(row.studentIdentifier ?? '') : String(row.employeeIdentifier ?? ''),
    fullName: kind === 'Student' ? String(row.studentName ?? '') : String(row.employeeName ?? ''),
    subjectStatus: kind === 'Student' ? String(row.studentStatus ?? 'Active') : String(row.employeeStatus ?? 'Active'),
  };
}

/** اطلاعات کامل دارندهٔ حساب (برای منو، رزرو، تحویل و مالی). */
export async function getAccountHolder(target: Tx | ServiceDeps['db'], accountId: string): Promise<AccountHolder | null> {
  const rows = await target.execute(
    sql`
      SELECT a.id AS "accountId", a.kind, a.customer_group AS "customerGroup", a.balance_rial::text AS "balanceRial", a.is_active AS "isActive",
             s.id AS "studentId", s.student_number AS "studentIdentifier", s.full_name AS "studentName", s.status AS "studentStatus",
             e.id AS "employeeId", e.username AS "employeeIdentifier", e.full_name AS "employeeName", e.status AS "employeeStatus"
      FROM accounts a
      LEFT JOIN students s ON s.id = a.student_id
      LEFT JOIN employees e ON e.id = a.employee_id
      WHERE a.id = ${accountId}
      LIMIT 1`,
  );
  const row = (rows as unknown as { rows: Record<string, unknown>[] }).rows?.[0];
  if (!row) return null;
  const kind = String(row.kind) === 'Student' ? 'Student' : 'Employee';
  return {
    accountId: String(row.accountId),
    kind,
    customerGroup: String(row.customerGroup) as CustomerGroup,
    balanceRial: Number(row.balanceRial ?? 0),
    isActive: Boolean(row.isActive),
    holderId: kind === 'Student' ? String(row.studentId) : String(row.employeeId),
    identifier: kind === 'Student' ? String(row.studentIdentifier ?? '') : String(row.employeeIdentifier ?? ''),
    fullName: kind === 'Student' ? String(row.studentName ?? '') : String(row.employeeName ?? ''),
    subjectStatus: kind === 'Student' ? String(row.studentStatus ?? 'Active') : String(row.employeeStatus ?? 'Active'),
  };
}

/** یافتن حساب از روی شناسه (شمارهٔ دانشجویی یا نام کاربری کارمند) — برای شارژ دستی. */
export async function findAccountByIdentifier(
  target: Tx | ServiceDeps['db'],
  subject: 'student' | 'employee',
  identifier: string,
): Promise<AccountHolder | null> {
  const normalized =
    subject === 'student'
      ? normalizeDigits(identifier)
      : String(identifier ?? '')
          .trim()
          .toLowerCase();
  if (!normalized) return null;

  const found =
    subject === 'student'
      ? await target
          .select({ id: accounts.id })
          .from(accounts)
          .innerJoin(students, eq(students.id, accounts.studentId))
          .where(eq(students.studentNumber, normalized))
          .limit(1)
      : await target
          .select({ id: accounts.id })
          .from(accounts)
          .innerJoin(employees, eq(employees.id, accounts.employeeId))
          .where(eq(employees.username, normalized))
          .limit(1);

  if (!found[0]) return null;
  return getAccountHolder(target, found[0].id);
}

/**
 * فعال بودن حساب برای عملیات مالی: حساب فعال + وضعیت دانشجو `Active`
 * (برای کارمند: وضعیت `Active`).
 */
export function assertAccountUsable(holder: AccountHolder | null): AccountHolder {
  if (!holder) throw new AppError('NOT_FOUND', 'حساب کیف پول یافت نشد.');
  if (!holder.isActive) throw new AppError('ACCOUNT_INACTIVE', 'حساب کیف پول شما غیرفعال است.');
  if (holder.kind === 'Student' && holder.subjectStatus !== 'Active') {
    throw new AppError('ACCOUNT_INACTIVE', 'حساب دانشجویی شما فعال نیست. با معاونت دانشجویی تماس بگیرید.');
  }
  if (holder.kind === 'Employee' && holder.subjectStatus !== 'Active') {
    throw new AppError('ACCOUNT_INACTIVE', 'حساب کاربری شما غیرفعال است.');
  }
  return holder;
}

/** غیرفعال/فعال‌سازی حساب (هم‌زمان با تغییر وضعیت دانشجو/کارمند). */
export async function setAccountActive(target: Tx | ServiceDeps['db'], accountId: string, isActive: boolean): Promise<void> {
  await target
    .update(accounts)
    .set({ isActive })
    .where(and(eq(accounts.id, accountId)));
}
