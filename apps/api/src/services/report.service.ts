import { tehranToday } from '@food/shared';
import type { AuthContext, ServiceDeps } from '../types.js';
import { rawSql } from '../db/raw.js';

/**
 * گزارش‌ها و داشبورد.
 *
 *  - پیمانکار فقط دادهٔ سلف‌های قرارداد خودش را می‌بیند (scope خودکار).
 *  - کد ملی در هیچ خروجی‌ای وجود ندارد (فقط ماسک).
 *  - بازهٔ تاریخ شمسی/روز سرویس (date) است.
 */

export type ReportFilters = {
  from: string;
  to: string;
  cafeteriaId?: string;
  mealSlot?: string;
  customerGroup?: string;
  contractorId?: string;
};

/** گزارش عملیاتی/مالی به تفکیک هر وعده. */
export async function reportsSummary(deps: ServiceDeps, filters: ReportFilters) {
  const params: unknown[] = [filters.from, filters.to];
  const where: string[] = ['o.service_date BETWEEN $1::date AND $2::date'];
  if (filters.cafeteriaId) {
    params.push(filters.cafeteriaId);
    where.push(`c.id = $${params.length}::uuid`);
  }
  if (filters.mealSlot) {
    params.push(filters.mealSlot);
    where.push(`ms.code = $${params.length}`);
  }
  if (filters.customerGroup) {
    params.push(filters.customerGroup);
    where.push(`a.customer_group = $${params.length}`);
  }
  if (filters.contractorId) {
    params.push(filters.contractorId);
    where.push(`EXISTS (SELECT 1 FROM cafeterias cc WHERE cc.id = c.id AND cc.contractor_id = $${params.length}::uuid)`);
  }

  const result = await deps.db.execute(
    rawSql(
      `SELECT o.id, o.service_date AS date, ms.code AS "mealSlot", ms.title AS "mealSlotTitle", c.name AS cafeteria,
              f.name AS food, o.capacity,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered,
              COUNT(r.id) FILTER (WHERE r.status = 'Cancelled')::int AS cancelled,
              COUNT(r.id) FILTER (WHERE r.status = 'NoShow')::int AS "noShow",
              COALESCE(SUM(r.price_at_booking) FILTER (WHERE r.status IN ('Reserved','Delivered')),0)::text AS value
       FROM meal_offerings o
       JOIN meal_slots ms ON ms.id = o.meal_slot_id
       JOIN cafeterias c ON c.id = o.cafeteria_id
       JOIN foods f ON f.id = o.food_id
       LEFT JOIN reservations r ON r.offering_id = o.id
       LEFT JOIN accounts a ON a.id = r.account_id
       WHERE ${where.join(' AND ')}
       GROUP BY o.id, ms.code, ms.title, ms.sort_order, c.name, f.name
       ORDER BY o.service_date, ms.sort_order
       LIMIT 2000`,
      params,
    ),
  );

  const rows = (((result as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    date: String(row.date ?? '').slice(0, 10),
    mealSlot: String(row.mealSlot ?? ''),
    mealSlotTitle: String(row.mealSlotTitle ?? ''),
    cafeteria: String(row.cafeteria ?? ''),
    food: String(row.food ?? ''),
    capacity: Number(row.capacity ?? 0),
    reserved: Number(row.reserved ?? 0),
    delivered: Number(row.delivered ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    noShow: Number(row.noShow ?? 0),
    valueRial: Number(row.value ?? 0),
  }));

  const sum = (key: 'capacity' | 'reserved' | 'delivered' | 'cancelled' | 'noShow' | 'valueRial') =>
    rows.reduce((acc, row) => acc + row[key], 0);

  return {
    rows,
    totals: {
      capacity: sum('capacity'),
      reserved: sum('reserved'),
      delivered: sum('delivered'),
      cancelled: sum('cancelled'),
      noShow: sum('noShow'),
      valueRial: sum('valueRial'),
    },
    scoped: filters.contractorId ? 'contractor' : null,
  };
}

/** گزارش تحلیلی پیشرفته (روند روزانه، غذاها، دانشکده‌ها، مالی، کیف پول‌ها). */
export async function reportsAdvanced(deps: ServiceDeps, filters: ReportFilters): Promise<Record<string, unknown>> {
  const params = [filters.from, filters.to];
  const cafeteriaFilter = filters.cafeteriaId ? `AND o.cafeteria_id = $3::uuid` : '';
  const groupFilter = filters.customerGroup ? `AND a.customer_group = $4` : '';
  const allParams =
    filters.cafeteriaId && filters.customerGroup
      ? [...params, filters.cafeteriaId, filters.customerGroup]
      : filters.cafeteriaId
        ? [...params, filters.cafeteriaId]
        : filters.customerGroup
          ? [...params, null, filters.customerGroup]
          : params;

  const daily = await deps.db.execute(
    rawSql(
      `SELECT o.service_date AS d,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered,
              COUNT(r.id) FILTER (WHERE r.status = 'Cancelled')::int AS cancelled,
              COUNT(r.id) FILTER (WHERE r.status = 'NoShow')::int AS "noShow",
              COALESCE(SUM(r.price_at_booking) FILTER (WHERE r.status IN ('Reserved','Delivered')),0)::text AS value
       FROM meal_offerings o
       LEFT JOIN reservations r ON r.offering_id = o.id
       LEFT JOIN accounts a ON a.id = r.account_id
       WHERE o.service_date BETWEEN $1::date AND $2::date ${cafeteriaFilter} ${groupFilter}
       GROUP BY o.service_date ORDER BY o.service_date`,
      allParams,
    ),
  );

  const foods = await deps.db.execute(
    rawSql(
      `SELECT f.name AS k,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered,
              COUNT(r.id) FILTER (WHERE r.status = 'Cancelled')::int AS cancelled,
              COUNT(r.id) FILTER (WHERE r.status = 'NoShow')::int AS "noShow",
              COALESCE(SUM(r.price_at_booking) FILTER (WHERE r.status IN ('Reserved','Delivered')),0)::text AS value
       FROM meal_offerings o JOIN foods f ON f.id = o.food_id
       LEFT JOIN reservations r ON r.offering_id = o.id
       LEFT JOIN accounts a ON a.id = r.account_id
       WHERE o.service_date BETWEEN $1::date AND $2::date ${cafeteriaFilter} ${groupFilter}
       GROUP BY f.name ORDER BY reserved DESC LIMIT 20`,
      allParams,
    ),
  );

  const faculty = await deps.db.execute(
    rawSql(
      `SELECT COALESCE(NULLIF(s.faculty,''),'نامشخص') AS k,
              COUNT(DISTINCT a.id)::int AS students,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered,
              COALESCE(SUM(r.price_at_booking) FILTER (WHERE r.status IN ('Reserved','Delivered')),0)::text AS value
       FROM reservations r
       JOIN meal_offerings o ON o.id = r.offering_id
       JOIN accounts a ON a.id = r.account_id
       JOIN students s ON s.id = a.student_id
       WHERE o.service_date BETWEEN $1::date AND $2::date ${cafeteriaFilter}
       GROUP BY 1 ORDER BY reserved DESC LIMIT 30`,
      filters.cafeteriaId ? [...params, filters.cafeteriaId] : params,
    ),
  );

  const byGroup = await deps.db.execute(
    rawSql(
      `SELECT a.customer_group AS k,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered,
              COUNT(r.id) FILTER (WHERE r.status = 'Cancelled')::int AS cancelled,
              COUNT(r.id) FILTER (WHERE r.status = 'NoShow')::int AS "noShow",
              COALESCE(SUM(r.price_at_booking) FILTER (WHERE r.status IN ('Reserved','Delivered')),0)::text AS value
       FROM reservations r
       JOIN meal_offerings o ON o.id = r.offering_id
       JOIN accounts a ON a.id = r.account_id
       WHERE o.service_date BETWEEN $1::date AND $2::date ${cafeteriaFilter}
       GROUP BY 1 ORDER BY 1`,
      filters.cafeteriaId ? [...params, filters.cafeteriaId] : params,
    ),
  );

  const ledger = await deps.db.execute(
    rawSql(
      `SELECT t.type AS k, COUNT(*)::int AS c, COALESCE(SUM(e.amount_rial),0)::text AS amount
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE (e.created_at AT TIME ZONE 'Asia/Tehran')::date BETWEEN $1::date AND $2::date
       GROUP BY t.type ORDER BY t.type`,
      params,
    ),
  );

  const wallets = await deps.db.execute(
    rawSql(
      `SELECT COUNT(*)::int AS accounts, COALESCE(SUM(balance_rial),0)::text AS total,
              COUNT(*) FILTER (WHERE balance_rial > 0)::int AS positive,
              COALESCE(MAX(balance_rial),0)::text AS max
       FROM accounts WHERE is_active = true`,
    ),
  );

  const studentsStats = await deps.db.execute(
    rawSql(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'Active')::int AS active,
              COUNT(*) FILTER (WHERE status = 'OnLeave')::int AS on_leave,
              COUNT(*) FILTER (WHERE status = 'Graduated')::int AS graduated,
              COUNT(*) FILTER (WHERE status = 'Withdrawn')::int AS withdrawn,
              COUNT(*) FILTER (WHERE status = 'Removed')::int AS removed
       FROM students WHERE deleted_at IS NULL`,
    ),
  );

  const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []) as T[];
  const groupOf = (result: unknown) =>
    rowsOf<Record<string, unknown>>(result).map((row) => ({
      key: String(row.k ?? ''),
      students: Number(row.students ?? 0),
      reserved: Number(row.reserved ?? 0),
      delivered: Number(row.delivered ?? 0),
      cancelled: Number(row.cancelled ?? 0),
      noShow: Number(row.noShow ?? 0),
      valueRial: Number(row.value ?? 0),
    }));

  const walletRow = rowsOf<Record<string, unknown>>(wallets)[0] ?? {};
  const studentRow = rowsOf<Record<string, unknown>>(studentsStats)[0] ?? {};

  return {
    daily: rowsOf<Record<string, unknown>>(daily).map((row) => ({
      date: String(row.d ?? '').slice(0, 10),
      reserved: Number(row.reserved ?? 0),
      delivered: Number(row.delivered ?? 0),
      cancelled: Number(row.cancelled ?? 0),
      noShow: Number(row.noShow ?? 0),
      valueRial: Number(row.value ?? 0),
    })),
    foods: groupOf(foods),
    faculty: groupOf(faculty),
    byCustomerGroup: groupOf(byGroup),
    ledger: rowsOf<Record<string, unknown>>(ledger).map((row) => ({
      type: String(row.k ?? ''),
      count: Number(row.c ?? 0),
      amountRial: Number(row.amount ?? 0),
    })),
    wallets: {
      accounts: Number(walletRow.accounts ?? 0),
      totalRial: Number(walletRow.total ?? 0),
      positive: Number(walletRow.positive ?? 0),
      maxRial: Number(walletRow.max ?? 0),
    },
    students: {
      total: Number(studentRow.total ?? 0),
      active: Number(studentRow.active ?? 0),
      onLeave: Number(studentRow.on_leave ?? 0),
      graduated: Number(studentRow.graduated ?? 0),
      withdrawn: Number(studentRow.withdrawn ?? 0),
      removed: Number(studentRow.removed ?? 0),
    },
  };
}

/** داشبورد مدیریتی بر اساس نقش. */
export async function adminDashboard(deps: ServiceDeps, auth: Extract<AuthContext, { kind: 'staff' }>): Promise<Record<string, unknown>> {
  const today = tehranToday();
  const showMoney = auth.role === 'SuperAdmin' || auth.role === 'Finance';
  const scopeCafeteria = auth.role === 'Operator' ? auth.cafeteriaId : null;

  const todayStats = await deps.db.execute(
    rawSql(
      `SELECT COALESCE(SUM(o.capacity),0)::int AS capacity,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered,
              COUNT(r.id) FILTER (WHERE r.status = 'Cancelled')::int AS cancelled,
              COUNT(r.id) FILTER (WHERE r.status = 'NoShow')::int AS "noShow"
       FROM meal_offerings o
       LEFT JOIN reservations r ON r.offering_id = o.id
       WHERE o.service_date = $1::date ${scopeCafeteria ? 'AND o.cafeteria_id = $2::uuid' : ''}`,
      scopeCafeteria ? [today, scopeCafeteria] : [today],
    ),
  );

  const trend = await deps.db.execute(
    rawSql(
      `SELECT o.service_date AS d,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered,
              COUNT(r.id) FILTER (WHERE r.status = 'NoShow')::int AS "noShow"
       FROM meal_offerings o LEFT JOIN reservations r ON r.offering_id = o.id
       WHERE o.service_date BETWEEN ($1::date - 13) AND ($1::date + 7) ${scopeCafeteria ? 'AND o.cafeteria_id = $2::uuid' : ''}
       GROUP BY o.service_date ORDER BY o.service_date`,
      scopeCafeteria ? [today, scopeCafeteria] : [today],
    ),
  );

  const byMeal = await deps.db.execute(
    rawSql(
      `SELECT ms.code AS meal, ms.title,
              COALESCE(SUM(o.capacity),0)::int AS capacity,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved
       FROM meal_offerings o JOIN meal_slots ms ON ms.id = o.meal_slot_id
       LEFT JOIN reservations r ON r.offering_id = o.id
       WHERE o.service_date = $1::date ${scopeCafeteria ? 'AND o.cafeteria_id = $2::uuid' : ''}
       GROUP BY ms.code, ms.title, ms.sort_order ORDER BY ms.sort_order`,
      scopeCafeteria ? [today, scopeCafeteria] : [today],
    ),
  );

  const studentStats = await deps.db.execute(
    rawSql(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='Active')::int AS active FROM students WHERE deleted_at IS NULL`),
  );
  const lastImport = await deps.db.execute(
    rawSql(`SELECT file_name AS "fileName", status, total_rows AS "totalRows", valid_rows AS "validRows", error_rows AS "errorRows", created_at AS "createdAt"
             FROM import_batches ORDER BY created_at DESC LIMIT 1`),
  );
  const needsReview = await deps.db.execute(rawSql(`SELECT COUNT(*)::int AS n FROM payments WHERE status = 'NeedsReview'`));
  const money = showMoney
    ? await deps.db.execute(
        rawSql(`SELECT COALESCE(SUM(balance_rial),0)::text AS liability, COUNT(*)::int AS accounts FROM accounts WHERE is_active = true`),
      )
    : null;

  const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []) as T[];
  const todayRow = rowsOf<Record<string, unknown>>(todayStats)[0] ?? {};
  const studentRow = rowsOf<Record<string, unknown>>(studentStats)[0] ?? {};
  const importRow = rowsOf<Record<string, unknown>>(lastImport)[0];
  const moneyRow = money ? (rowsOf<Record<string, unknown>>(money)[0] ?? {}) : null;

  return {
    today,
    role: auth.role,
    activeStudents: Number(studentRow.active ?? 0),
    totalStudents: Number(studentRow.total ?? 0),
    todayCapacity: Number(todayRow.capacity ?? 0),
    todayReserved: Number(todayRow.reserved ?? 0),
    todayDelivered: Number(todayRow.delivered ?? 0),
    todayCancelled: Number(todayRow.cancelled ?? 0),
    todayNoShow: Number(todayRow.noShow ?? 0),
    trend: rowsOf<Record<string, unknown>>(trend).map((row) => ({
      date: String(row.d ?? '').slice(0, 10),
      reserved: Number(row.reserved ?? 0),
      delivered: Number(row.delivered ?? 0),
      noShow: Number(row.noShow ?? 0),
    })),
    byMeal: rowsOf<Record<string, unknown>>(byMeal).map((row) => ({
      meal: String(row.meal ?? ''),
      title: String(row.title ?? ''),
      capacity: Number(row.capacity ?? 0),
      reserved: Number(row.reserved ?? 0),
    })),
    lastImport: importRow
      ? {
          fileName: String(importRow.fileName ?? ''),
          status: String(importRow.status ?? ''),
          totalRows: Number(importRow.totalRows ?? 0),
          validRows: Number(importRow.validRows ?? 0),
          errorRows: Number(importRow.errorRows ?? 0),
          createdAt: new Date(String(importRow.createdAt)).toISOString(),
        }
      : null,
    money: moneyRow
      ? {
          liabilityRial: Number(moneyRow.liability ?? 0),
          accounts: Number(moneyRow.accounts ?? 0),
          needsReview: Number(rowsOf<Record<string, unknown>>(needsReview)[0]?.n ?? 0),
        }
      : null,
  };
}

/** گزارش محدود پیمانکار (فقط سلف‌های قرارداد خودش). */
export async function contractorReport(
  deps: ServiceDeps,
  auth: Extract<AuthContext, { kind: 'staff' }>,
  filters: { from: string; to: string },
) {
  if (!auth.contractorId) {
    return {
      rows: [],
      totals: { capacity: 0, reserved: 0, delivered: 0, cancelled: 0, noShow: 0, valueRial: 0 },
      scoped: 'contractor',
    };
  }
  const summary = await reportsSummary(deps, { ...filters, contractorId: auth.contractorId });
  return { ...summary, scoped: 'contractor' };
}
