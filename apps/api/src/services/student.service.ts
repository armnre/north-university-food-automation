import { sql } from 'drizzle-orm';
import { maskNationalId, STUDENT_STATUSES } from '@food/shared';
import { accounts, students } from '../db/schema/index.js';
import { AppError, fail } from '../lib/errors.js';
import type { Actor, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { revokeAllSessionsForSubject } from './session.service.js';
import { setAccountActive } from './account.service.js';
import { rawSql } from '../db/raw.js';

/** مدیریت دانشجویان: فهرست با facet، گزارش کامل و تغییر وضعیت. */

export type StudentListFilters = {
  search?: string;
  status?: string;
  faculty?: string;
  major?: string;
  degree?: string;
  entryYear?: number;
  sort?: 'studentNumber' | 'fullName' | 'balance' | 'reservations' | 'addedAt' | 'removedAt' | 'status';
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
};

const SORT_COLUMNS: Record<string, string> = {
  studentNumber: 's.student_number',
  fullName: 's.full_name',
  balance: 'balance',
  reservations: 'reservations',
  addedAt: 's.added_at',
  removedAt: 's.removed_at',
  status: 's.status',
};

export async function listStudents(deps: ServiceDeps, filters: StudentListFilters) {
  const params: unknown[] = [];
  const where: string[] = ['s.deleted_at IS NULL'];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    where.push(`(s.student_number ILIKE ${p(like)} OR s.full_name ILIKE ${p(like)} OR s.major ILIKE ${p(like)})`);
  }
  if (filters.status) where.push(`s.status = ${p(filters.status)}`);
  if (filters.faculty) where.push(`s.faculty = ${p(filters.faculty)}`);
  if (filters.major) where.push(`s.major = ${p(filters.major)}`);
  if (filters.degree) where.push(`s.degree = ${p(filters.degree)}`);
  if (filters.entryYear) where.push(`s.entry_year = ${p(filters.entryYear)}`);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const order = SORT_COLUMNS[filters.sort ?? 'studentNumber'] ?? 's.student_number';
  const dir = filters.dir === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 2000);
  const offset = Math.max(filters.offset ?? 0, 0);

  const baseFrom = `FROM students s
    LEFT JOIN accounts a ON a.student_id = s.id`;
  const balanceExpr = `COALESCE(a.balance_rial, 0)::text`;
  const reservationsExpr = `(SELECT COUNT(*) FROM reservations r WHERE r.account_id = a.id AND r.status IN ('Reserved','Delivered'))`;

  const rowsResult = await deps.db.execute(
    rawSql(
      `SELECT s.id, s.student_number AS "studentNumber", s.full_name AS "fullName", s.faculty, s.major, s.degree,
              s.entry_year AS "entryYear", s.status, s.national_id_last4 AS "nationalIdLast4",
              s.added_at AS "addedAt", s.removed_at AS "removedAt", s.last_login_at AS "lastLoginAt",
              ${balanceExpr} AS balance, ${reservationsExpr}::int AS reservations
       ${baseFrom} ${whereSql}
       ORDER BY ${order} ${dir} NULLS LAST
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
  );

  const countResult = await deps.db.execute(rawSql(`SELECT COUNT(*)::int AS n ${baseFrom} ${whereSql}`, params));

  const facet = async (column: string) => {
    const result = await deps.db.execute(
      rawSql(
        `SELECT COALESCE(${column}::text,'') AS value, COUNT(*)::int AS count ${baseFrom} ${whereSql} GROUP BY 1 ORDER BY 2 DESC LIMIT 100`,
        params,
      ),
    );
    return ((result as unknown as { rows: { value: string; count: number }[] }).rows ?? []).map((r) => ({
      value: r.value,
      count: Number(r.count),
    }));
  };

  const [statusFacet, facultyFacet, majorFacet, degreeFacet, yearFacet] = await Promise.all([
    facet('s.status'),
    facet('s.faculty'),
    facet('s.major'),
    facet('s.degree'),
    facet('s.entry_year'),
  ]);

  const rows = ((rowsResult as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  const total = Number(((countResult as unknown as { rows: { n: number }[] }).rows ?? [])[0]?.n ?? rows.length);

  return {
    total,
    facets: { status: statusFacet, faculty: facultyFacet, major: majorFacet, degree: degreeFacet, entryYear: yearFacet },
    students: rows.map((row) => ({
      id: String(row.id),
      studentNumber: String(row.studentNumber ?? ''),
      fullName: String(row.fullName ?? ''),
      faculty: String(row.faculty ?? ''),
      major: String(row.major ?? ''),
      degree: String(row.degree ?? ''),
      entryYear: row.entryYear == null ? null : Number(row.entryYear),
      status: String(row.status ?? 'Active'),
      nationalIdMasked: maskNationalId(String(row.nationalIdLast4 ?? '')),
      balanceRial: Number(row.balance ?? 0),
      reservations: Number(row.reservations ?? 0),
      addedAt: row.addedAt ? new Date(String(row.addedAt)).toISOString() : null,
      removedAt: row.removedAt ? new Date(String(row.removedAt)).toISOString() : null,
      lastLoginAt: row.lastLoginAt ? new Date(String(row.lastLoginAt)).toISOString() : null,
    })),
  };
}

/** گزارش کامل یک دانشجو (پروفایل، کیف پول، رزروها و دفتر کل). */
export async function studentReport(deps: ServiceDeps, studentId: string) {
  const profileRows = await deps.db.execute(
    rawSql(
      `SELECT s.id, s.student_number AS "studentNumber", s.full_name AS "fullName", s.faculty, s.major, s.degree,
              s.entry_year AS "entryYear", s.status, s.national_id_last4 AS "nationalIdLast4",
              s.added_at AS "addedAt", s.removed_at AS "removedAt", s.last_login_at AS "lastLoginAt",
              a.id AS "accountId", a.balance_rial::text AS "balanceRial",
              b.file_name AS "batchName"
       FROM students s
       LEFT JOIN accounts a ON a.student_id = s.id
       LEFT JOIN import_batches b ON b.id = s.last_import_batch_id
       WHERE s.id = $1`,
      [studentId],
    ),
  );
  const profile = ((profileRows as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
  if (!profile) fail('NOT_FOUND', 'دانشجو یافت نشد.');

  const accountId = profile.accountId ? String(profile.accountId) : null;

  const reservationRows = accountId
    ? await deps.db.execute(
        rawSql(
          `SELECT r.id, r.code, r.status, r.price_at_booking::text AS "priceRial", r.created_at AS "createdAt",
                  r.service_date AS "serviceDate", r.delivered_at AS "deliveredAt",
                  ms.code AS "mealSlot", f.name AS food, c.name AS cafeteria
           FROM reservations r
           JOIN meal_slots ms ON ms.id = r.meal_slot_id
           JOIN meal_offerings o ON o.id = r.offering_id
           JOIN foods f ON f.id = o.food_id
           JOIN cafeterias c ON c.id = r.cafeteria_id
           WHERE r.account_id = $1
           ORDER BY r.service_date DESC, r.created_at DESC
           LIMIT 1000`,
          [accountId],
        ),
      )
    : { rows: [] };

  const ledgerRows = accountId
    ? await deps.db.execute(
        rawSql(
          `SELECT t.tracking_code AS "trackingCode", t.type, e.amount_rial::text AS "amountRial", t.reason,
                  e.created_at AS "createdAt", e.balance_after::text AS "balanceAfter"
           FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
           WHERE e.account_id = $1
           ORDER BY e.created_at DESC
           LIMIT 1000`,
          [accountId],
        ),
      )
    : { rows: [] };

  const reservations = ((reservationRows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  const entries = ((ledgerRows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];

  const countBy = (status: string) => reservations.filter((r) => String(r.status) === status).length;
  const credits = entries.filter((e) => Number(e.amountRial) > 0).reduce((acc, e) => acc + Number(e.amountRial), 0);
  const debits = entries.filter((e) => Number(e.amountRial) < 0).reduce((acc, e) => acc - Number(e.amountRial), 0);
  const refunded = entries
    .filter((e) => ['CancellationRefund', 'MealUnavailableRefund', 'AdminRefund', 'WithdrawalRelease'].includes(String(e.type)))
    .reduce((acc, e) => acc + Number(e.amountRial), 0);

  return {
    profile: {
      id: String(profile.id),
      studentNumber: String(profile.studentNumber ?? ''),
      fullName: String(profile.fullName ?? ''),
      faculty: String(profile.faculty ?? ''),
      major: String(profile.major ?? ''),
      degree: String(profile.degree ?? ''),
      entryYear: profile.entryYear == null ? null : Number(profile.entryYear),
      status: String(profile.status ?? 'Active'),
      nationalIdMasked: maskNationalId(String(profile.nationalIdLast4 ?? '')),
      addedAt: profile.addedAt ? new Date(String(profile.addedAt)).toISOString() : null,
      removedAt: profile.removedAt ? new Date(String(profile.removedAt)).toISOString() : null,
      lastLoginAt: profile.lastLoginAt ? new Date(String(profile.lastLoginAt)).toISOString() : null,
      lastImport: profile.batchName ? String(profile.batchName) : null,
    },
    stats: {
      balanceRial: Number(profile.balanceRial ?? 0),
      creditsRial: credits,
      debitsRial: debits,
      total: reservations.length,
      reserved: countBy('Reserved'),
      delivered: countBy('Delivered'),
      cancelled: countBy('Cancelled'),
      noShow: countBy('NoShow'),
      expired: countBy('Expired'),
      rejected: countBy('Rejected'),
      spentRial: reservations
        .filter((r) => ['Reserved', 'Delivered'].includes(String(r.status)))
        .reduce((acc, r) => acc + Number(r.priceRial), 0),
      refundedRial: refunded,
    },
    reservations: reservations.map((r) => ({
      id: String(r.id),
      code: String(r.code ?? ''),
      status: String(r.status ?? ''),
      priceRial: Number(r.priceRial ?? 0),
      createdAt: r.createdAt ? new Date(String(r.createdAt)).toISOString() : null,
      serviceDate: String(r.serviceDate ?? '').slice(0, 10),
      mealSlot: String(r.mealSlot ?? ''),
      food: String(r.food ?? ''),
      cafeteria: String(r.cafeteria ?? ''),
      deliveredAt: r.deliveredAt ? new Date(String(r.deliveredAt)).toISOString() : null,
    })),
    ledger: entries.map((e) => ({
      trackingCode: String(e.trackingCode ?? ''),
      type: String(e.type ?? ''),
      amountRial: Number(e.amountRial ?? 0),
      reason: String(e.reason ?? ''),
      createdAt: new Date(String(e.createdAt)).toISOString(),
      balanceAfter: e.balanceAfter == null ? null : Number(e.balanceAfter),
    })),
  };
}

/**
 * تغییر وضعیت دانشجو.
 * تغییر به هر وضعیت غیر از `Active` ⇒ ابطال همهٔ نشست‌ها و غیرفعال‌سازی حساب
 * (حذف فیزیکی انجام نمی‌شود).
 */
export async function setStudentStatus(
  deps: ServiceDeps,
  input: { studentId: string; status: (typeof STUDENT_STATUSES)[number]; reason?: string; actor: Actor; ip: string },
): Promise<{ ok: true; sessionsRevoked: number }> {
  if (!STUDENT_STATUSES.includes(input.status)) {
    throw new AppError('VALIDATION', 'وضعیت انتخاب‌شده معتبر نیست.');
  }

  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(students)
      .where(sql`${students.id} = ${input.studentId}`)
      .limit(1);
    const student = rows[0];
    if (!student) fail('NOT_FOUND', 'دانشجو یافت نشد.');

    const isActive = input.status === 'Active';
    await tx
      .update(students)
      .set({ status: input.status, removedAt: isActive ? null : new Date() })
      .where(sql`${students.id} = ${input.studentId}`);

    const accountRows = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.studentId} = ${input.studentId}`)
      .limit(1);
    if (accountRows[0]) await setAccountActive(tx, accountRows[0].id, isActive);

    const revoked = isActive ? 0 : await revokeAllSessionsForSubject(tx, 'Student', input.studentId, 'status_changed');

    await writeAudit(tx, {
      actor: input.actor,
      action: 'student.status',
      targetType: 'Student',
      targetId: input.studentId,
      details: { from: student.status, to: input.status, reason: input.reason ?? null, sessionsRevoked: revoked },
      ip: input.ip,
    });

    return { ok: true as const, sessionsRevoked: revoked };
  });
}
