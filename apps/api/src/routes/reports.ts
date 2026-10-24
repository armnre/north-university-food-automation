import type { FastifyInstance, FastifyRequest } from 'fastify';
import ExcelJS from 'exceljs';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { hasPermission } from '@food/shared';
import type { Db } from '../db/client.js';
import { requirePrincipal } from '../lib/auth.js';
import { n } from '../lib/customer.js';
import { fail } from '../lib/errors.js';
import { csvSafe } from '../services/imports.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filters = z.object({
  from: day,
  to: day,
  cafeteriaId: z.string().uuid().optional(),
  mealType: z.string().max(20).optional(),
  customerGroup: z.enum(['Student', 'Employee']).optional(),
});
type F = z.infer<typeof filters>;

function parse(req: FastifyRequest): F {
  const f = filters.parse(req.query);
  if (f.from > f.to) fail('BAD_REQUEST', 'بازه‌ی تاریخ نامعتبر است.');
  return f;
}

/** Contractors only see their own cafeterias (scope enforced server-side). */
function scope(req: FastifyRequest, f: F): SQL {
  const p = requirePrincipal(req);
  const parts: SQL[] = [sql`o.service_date BETWEEN ${f.from}::date AND ${f.to}::date`];
  if (f.cafeteriaId) parts.push(sql`o.cafeteria_id = ${f.cafeteriaId}`);
  if (f.mealType) parts.push(sql`lower(ms.code) = lower(${f.mealType})`);
  if (p.role === 'Contractor') parts.push(sql`c.contractor_id = ${p.contractorId ?? '00000000-0000-0000-0000-000000000000'}`);
  return sql.join(parts, sql` AND `);
}

async function summary(db: Db, req: FastifyRequest, f: F) {
  const g = f.customerGroup ? sql`AND r.customer_group = ${f.customerGroup}` : sql``;
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT o.id, o.service_date::text AS date, ms.code AS meal, fd.name AS food, c.name AS cafeteria, o.capacity, o.status,
      count(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered','NoShow') ${g}) AS reserved,
      count(r.id) FILTER (WHERE r.status = 'Delivered' ${g}) AS delivered,
      count(r.id) FILTER (WHERE r.status = 'Cancelled' ${g}) AS cancelled,
      count(r.id) FILTER (WHERE r.status = 'NoShow' ${g}) AS no_show,
      COALESCE(sum(r.price_rial) FILTER (WHERE r.status IN ('Reserved','Delivered','NoShow') ${g}), 0) AS value
    FROM meal_offerings o JOIN meal_slots ms ON ms.id=o.meal_slot_id JOIN foods fd ON fd.id=o.food_id JOIN cafeterias c ON c.id=o.cafeteria_id
    LEFT JOIN reservations r ON r.offering_id=o.id
    WHERE ${scope(req, f)} GROUP BY o.id, ms.code, ms.sort_order, fd.name, c.name ORDER BY o.service_date, ms.sort_order, fd.name LIMIT 5000`);
  const rows = r.rows.map((x) => ({
    offeringId: String(x.id),
    date: String(x.date),
    mealType: String(x.meal),
    food: String(x.food),
    cafeteria: String(x.cafeteria),
    status: String(x.status),
    capacity: n(x.capacity as number),
    reserved: n(x.reserved as bigint),
    delivered: n(x.delivered as bigint),
    cancelled: n(x.cancelled as bigint),
    noShow: n(x.no_show as bigint),
    valueRial: n(x.value as bigint),
  }));
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, x) => s + (x[k] as number), 0);
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
    scopedToContractor: requirePrincipal(req).role === 'Contractor',
  };
}

export function reportRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/v1/reports/summary', { config: { access: 'reportsRead' } }, async (req) => summary(db, req, parse(req)));

  app.get('/api/v1/reports/advanced', { config: { access: 'reportsRead' } }, async (req) => {
    const f = parse(req);
    const p = requirePrincipal(req);
    const w = scope(req, f);
    const base = sql`FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id JOIN meal_slots ms ON ms.id=o.meal_slot_id JOIN foods fd ON fd.id=o.food_id JOIN cafeterias c ON c.id=o.cafeteria_id JOIN accounts a ON a.id=r.account_id LEFT JOIN students s ON s.id=a.student_id WHERE ${w}`;
    const agg = sql`count(*) FILTER (WHERE r.status IN ('Reserved','Delivered','NoShow')) AS reserved, count(*) FILTER (WHERE r.status='Delivered') AS delivered, count(*) FILTER (WHERE r.status='Cancelled') AS cancelled, count(*) FILTER (WHERE r.status='NoShow') AS no_show, COALESCE(sum(r.price_rial) FILTER (WHERE r.status IN ('Reserved','Delivered','NoShow')),0) AS value`;
    const [daily, meals, foods, faculty, groups] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`SELECT o.service_date::text AS k, ${agg} ${base} GROUP BY 1 ORDER BY 1`),
      db.execute<Record<string, unknown>>(sql`SELECT ms.code AS k, ${agg} ${base} GROUP BY 1 ORDER BY 1`),
      db.execute<Record<string, unknown>>(sql`SELECT fd.name AS k, ${agg} ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
      db.execute<Record<string, unknown>>(sql`SELECT COALESCE(s.faculty, 'کارکنان') AS k, ${agg} ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`),
      db.execute<Record<string, unknown>>(sql`SELECT r.customer_group::text AS k, ${agg} ${base} GROUP BY 1`),
    ]);
    const grp = (rows: Record<string, unknown>[]) =>
      rows.map((x) => ({
        key: String(x.k),
        reserved: n(x.reserved as bigint),
        delivered: n(x.delivered as bigint),
        cancelled: n(x.cancelled as bigint),
        noShow: n(x.no_show as bigint),
        valueRial: n(x.value as bigint),
      }));
    const out: Record<string, unknown> = {
      daily: grp(daily.rows).map(({ key, ...r }) => ({ date: key, ...r })),
      meals: grp(meals.rows),
      foods: grp(foods.rows),
      faculty: grp(faculty.rows),
      customerGroups: grp(groups.rows),
    };
    out.waste = grp(foods.rows)
      .filter((x) => x.noShow > 0)
      .map((x) => ({ food: x.key, noShow: x.noShow, wasteRial: x.reserved ? Math.round((x.valueRial / x.reserved) * x.noShow) : 0 }));
    if (hasPermission(p.role, 'reportsFinance')) {
      const [ledger, sys, pay, recon] = await Promise.all([
        db.execute<Record<string, unknown>>(
          sql`SELECT t.type AS k, count(DISTINCT t.id) AS c, COALESCE(sum(e.amount_rial) FILTER (WHERE a.kind='Customer'),0) AS amount FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id JOIN accounts a ON a.id=e.account_id WHERE (t.created_at AT TIME ZONE 'Asia/Tehran')::date BETWEEN ${f.from}::date AND ${f.to}::date GROUP BY 1 ORDER BY 1`,
        ),
        db.execute<Record<string, unknown>>(sql`SELECT code, balance_rial FROM accounts WHERE kind='System' ORDER BY code`),
        db.execute<Record<string, unknown>>(sql`SELECT status::text AS k, count(*) AS c, COALESCE(sum(amount_rial),0) AS amount FROM payments GROUP BY 1`),
        db.execute<Record<string, unknown>>(sql`SELECT started_at, ok, detail FROM job_runs WHERE job='reconcile-ledger' ORDER BY started_at DESC LIMIT 1`),
      ]);
      const offline = await db.execute<{ c: bigint }>(sql`SELECT count(*) AS c FROM deliveries WHERE outcome='OfflineConflict'`);
      const w2 = await db.execute<Record<string, unknown>>(
        sql`SELECT count(*) AS accounts, COALESCE(sum(balance_rial),0) AS total, count(*) FILTER (WHERE balance_rial>0) AS positive, COALESCE(max(balance_rial),0) AS max FROM accounts WHERE kind='Customer'`,
      );
      out.ledger = ledger.rows.map((x) => ({ type: String(x.k), count: n(x.c as bigint), amountRial: n(x.amount as bigint) }));
      out.systemAccounts = sys.rows.map((x) => ({ code: String(x.code), balanceRial: n(x.balance_rial as bigint) }));
      out.payments = pay.rows.map((x) => ({ status: String(x.k), count: n(x.c as bigint), amountRial: n(x.amount as bigint) }));
      out.lastReconcile = recon.rows[0] ? { at: String(recon.rows[0].started_at), ok: !!recon.rows[0].ok, detail: recon.rows[0].detail } : null;
      out.offlineConflicts = n(offline.rows[0]?.c);
      const wr = w2.rows[0]!;
      out.wallets = { accounts: n(wr.accounts as bigint), totalRial: n(wr.total as bigint), positive: n(wr.positive as bigint), maxRial: n(wr.max as bigint) };
    }
    return out;
  });

  /** CSV (UTF-8 BOM, CSV-injection-safe) or Excel export of the summary report. Never contains national ids. */
  app.get('/api/v1/reports/export', { config: { access: 'reportsRead' } }, async (req, reply) => {
    const f = parse(req);
    const { format } = z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }).parse({ format: (req.query as Record<string, string>).format });
    const s = await summary(db, req, f);
    const head = ['تاریخ', 'وعده', 'غذا', 'سلف', 'وضعیت', 'ظرفیت', 'رزرو', 'تحویل', 'لغو', 'غیبت', 'مبلغ (ریال)'];
    const rows = s.rows.map((r) => [
      r.date,
      r.mealType,
      r.food,
      r.cafeteria,
      r.status,
      r.capacity,
      r.reserved,
      r.delivered,
      r.cancelled,
      r.noShow,
      r.valueRial,
    ]);
    const name = `report-${f.from}-${f.to}`;
    if (format === 'csv') {
      const body = '\ufeff' + [head, ...rows].map((r) => r.map((v) => csvSafe(String(v))).join(',')).join('\n');
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`).send(body);
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('گزارش', { views: [{ rightToLeft: true }] });
    ws.addRow(head).font = { bold: true };
    for (const r of rows) ws.addRow(r.map((v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v)));
    ws.columns.forEach((c) => {
      c.width = 16;
    });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}.xlsx"`)
      .send(buf);
  });
}
