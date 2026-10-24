import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { canManage, hasPermission, normalizeDigits, ROLE_PERMISSIONS, STAFF_ROLES, tehranDate, type StaffRole } from '@food/shared';
import type { Db } from '../db/client.js';
import { requirePrincipal } from '../lib/auth.js';
import { randomCode } from '../lib/crypto.js';
import { iso, MEAL_TYPE, n } from '../lib/customer.js';
import { fail } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { audit } from '../services/audit.js';
import { postLedger, systemAccountId } from '../services/ledger.js';
import { revokeAllForSubject } from '../services/sessions.js';
import { getSettings, num } from '../services/settings.js';
import { DEFAULT_SETTINGS } from '../db/seed.js';

const page = { offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50) };
const like = (s?: string) => (s ? `%${s.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null);
const tempPassword = () => `${randomCode(5)}-${randomCode(5)}-${randomCode(4)}`;

function staffRole(req: Parameters<typeof requirePrincipal>[0]): StaffRole {
  const p = requirePrincipal(req);
  if (p.subjectType !== 'staff') fail('FORBIDDEN', 'شما به این بخش دسترسی ندارید.');
  return p.role as StaffRole;
}

export function adminRoutes(app: FastifyInstance, db: Db) {
  // ── finance ────────────────────────────────────────────────────────────
  app.get('/api/v1/finance/ledger', { config: { access: 'financeRead' } }, async (req) => {
    const q = z
      .object({ type: z.string().max(40).optional(), search: z.string().max(80).optional(), from: z.string().optional(), to: z.string().optional(), ...page })
      .parse(req.query);
    const s = like(q.search ? normalizeDigits(q.search) : undefined);
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT e.id, t.tracking_code, t.type, e.amount_rial, e.balance_after, t.reason, t.actor, e.created_at, st.student_number, COALESCE(st.first_name||' '||st.last_name, em.first_name||' '||em.last_name, a.code) AS owner
      FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN accounts a ON a.id=e.account_id
      LEFT JOIN students st ON st.id=a.student_id LEFT JOIN employees em ON em.id=a.employee_id
      WHERE a.kind='Customer' AND (${q.type ?? null}::text IS NULL OR t.type=${q.type ?? null})
        AND (${s}::text IS NULL OR t.tracking_code ILIKE ${s} OR st.student_number ILIKE ${s} OR em.username ILIKE ${s})
        AND (${q.from ?? null}::date IS NULL OR e.created_at >= (${q.from ?? null}::date::timestamp AT TIME ZONE 'Asia/Tehran'))
        AND (${q.to ?? null}::date IS NULL OR e.created_at < ((${q.to ?? null}::date + 1)::timestamp AT TIME ZONE 'Asia/Tehran'))
      ORDER BY e.created_at DESC, e.id LIMIT ${q.limit + 1} OFFSET ${q.offset}`);
    const recon = await db.execute<{ unbalanced: number; drift: number }>(sql`
      SELECT (SELECT count(*) FROM (SELECT 1 FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_rial) <> 0) x)::int AS unbalanced,
             (SELECT count(*) FROM (SELECT a.id FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id HAVING a.balance_rial <> COALESCE(sum(e.amount_rial),0)) y)::int AS drift`);
    return {
      entries: r.rows
        .slice(0, q.limit)
        .map((x) => ({
          id: x.id,
          trackingCode: x.tracking_code,
          type: x.type,
          amountRial: n(x.amount_rial as bigint),
          balanceAfter: n(x.balance_after as bigint),
          reason: x.reason ?? '',
          actor: x.actor,
          createdAt: iso(x.created_at as Date),
          studentNumber: x.student_number ?? null,
          owner: x.owner ?? '',
        })),
      hasMore: r.rows.length > q.limit,
      reconciliation: { healthy: recon.rows[0]!.unbalanced === 0 && recon.rows[0]!.drift === 0, ...recon.rows[0] },
    };
  });

  app.post('/api/v1/finance/adjust', { config: { access: 'financeWrite' } }, async (req) => {
    const p = requirePrincipal(req);
    const b = z
      .object({
        studentNumber: z.string().max(30).optional(),
        employeeUsername: z.string().max(50).optional(),
        amountRial: z
          .number()
          .int()
          .refine((v) => v !== 0),
        reason: z.string().trim().min(5).max(300),
        idempotencyKey: z.string().min(8).max(80),
        kind: z.enum(['MANUAL_CASH', 'ManualAdjust']).default('MANUAL_CASH'),
      })
      .parse(req.body);
    const s = await getSettings(db);
    if (Math.abs(b.amountRial) > num(s, 'max_manual_adjust_rial')) fail('BAD_REQUEST', 'مبلغ بیش از سقف مجاز تعدیل دستی است.');
    return db.transaction(async (tx) => {
      const a = await tx.execute<{ id: string }>(
        b.studentNumber
          ? sql`SELECT a.id FROM accounts a JOIN students s ON s.id=a.student_id WHERE s.student_number=${normalizeDigits(b.studentNumber)} FOR UPDATE OF a`
          : sql`SELECT a.id FROM accounts a JOIN employees e ON e.id=a.employee_id WHERE lower(e.username)=${(b.employeeUsername ?? '').toLowerCase()} FOR UPDATE OF a`,
      );
      if (!a.rows[0]) fail('NOT_FOUND', 'حساب پیدا نشد.');
      const cash = await systemAccountId(tx, 'manual-cash');
      const amt = BigInt(b.amountRial);
      const r = await postLedger(tx, {
        type: b.kind,
        idempotencyKey: `adjust:${p.id}:${b.idempotencyKey}`,
        actor: p.actor,
        reason: b.reason,
        lines: [
          { accountId: a.rows[0].id, amount: amt },
          { accountId: cash, amount: -amt },
        ],
      });
      if (!r.replay) {
        await audit(tx, {
          actor: p.actor,
          action: 'finance.adjust',
          entityType: 'Account',
          entityId: a.rows[0].id,
          data: { amount: b.amountRial, reason: b.reason, kind: b.kind, tracking: r.trackingCode },
          requestId: req.id,
        });
        await tx.execute(
          sql`INSERT INTO notifications (account_id, title, body, kind) VALUES (${a.rows[0].id}, ${amt > 0n ? 'شارژ حساب' : 'تعدیل حساب'}, ${`${amt > 0n ? 'افزایش' : 'کاهش'} اعتبار به مبلغ ${(amt < 0n ? -amt : amt).toString()} ریال — ${b.reason}`}, 'finance')`,
        );
      }
      const bal = await tx.execute<{ balance_rial: bigint }>(sql`SELECT balance_rial FROM accounts WHERE id=${a.rows[0].id}`);
      return { trackingCode: r.trackingCode, balanceRial: n(bal.rows[0]!.balance_rial), replay: r.replay };
    });
  });

  // ── staff users ────────────────────────────────────────────────────────
  app.get('/api/v1/staff', { config: { access: 'staffManage' } }, async (req) => {
    const role = staffRole(req);
    const r = await db.execute<Record<string, unknown>>(
      sql`SELECT su.id, su.username, su.full_name, su.role, su.active, su.cafeteria_id, su.contractor_id, su.mobile, su.last_login_at, cf.name AS cafeteria_name FROM staff_users su LEFT JOIN cafeterias cf ON cf.id=su.cafeteria_id ORDER BY su.role, su.full_name`,
    );
    return {
      staff: r.rows.map((x) => ({
        id: x.id,
        username: x.username,
        fullName: x.full_name,
        role: x.role,
        active: x.active,
        cafeteriaId: x.cafeteria_id,
        cafeteriaName: x.cafeteria_name ?? '',
        contractorId: x.contractor_id,
        mobile: x.mobile ?? '',
        lastLoginAt: iso(x.last_login_at as Date),
        perms: ROLE_PERMISSIONS[x.role as StaffRole],
        editable: canManage(role, x.role as StaffRole),
      })),
      manageableRoles: STAFF_ROLES.filter((r2) => canManage(role, r2)),
    };
  });

  app.put('/api/v1/staff', { config: { access: 'staffManage' } }, async (req) => {
    const p = requirePrincipal(req);
    const role = staffRole(req);
    const b = z
      .object({
        id: z.string().uuid().optional(),
        username: z
          .string()
          .trim()
          .min(3)
          .max(50)
          .regex(/^[a-zA-Z0-9._-]+$/),
        fullName: z.string().trim().min(2).max(100),
        role: z.enum(STAFF_ROLES),
        active: z.boolean(),
        cafeteriaId: z.string().uuid().nullable().optional(),
        contractorId: z.string().uuid().nullable().optional(),
        mobile: z.string().max(20).optional(),
        resetPassword: z.boolean().optional(),
      })
      .parse(req.body);
    if (!canManage(role, b.role)) fail('FORBIDDEN', 'شما اجازه‌ی ساخت یا ویرایش این نقش را ندارید.');
    if (b.role === 'Operator' && !b.cafeteriaId) fail('BAD_REQUEST', 'برای کارمند سلف باید سلف مشخص شود.');
    return db.transaction(async (tx) => {
      let temp: string | null = null;
      let id = b.id;
      if (id) {
        const cur = await tx.execute<{ role: StaffRole; active: boolean }>(sql`SELECT role, active FROM staff_users WHERE id=${id} FOR UPDATE`);
        if (!cur.rows[0]) fail('NOT_FOUND', 'کاربر پیدا نشد.');
        if (!canManage(role, cur.rows[0].role)) fail('FORBIDDEN', 'شما اجازه‌ی ویرایش این کاربر را ندارید.');
        if (b.resetPassword) temp = tempPassword();
        await tx.execute(sql`UPDATE staff_users SET username=${b.username}, full_name=${b.fullName}, role=${b.role}, active=${b.active}, cafeteria_id=${b.cafeteriaId ?? null}, contractor_id=${b.contractorId ?? null}, mobile=${b.mobile ?? null},
          password_hash=COALESCE(${temp ? await hashPassword(temp) : null}, password_hash), must_change_password=(must_change_password OR ${!!temp}), updated_at=now() WHERE id=${id}`);
        if (!b.active || temp || cur.rows[0].role !== b.role) await revokeAllForSubject(tx as unknown as Db, 'staff', id);
      } else {
        temp = tempPassword();
        const r = await tx
          .execute<{ id: string }>(
            sql`INSERT INTO staff_users (username, full_name, role, active, cafeteria_id, contractor_id, mobile, password_hash, must_change_password, created_by)
          VALUES (${b.username}, ${b.fullName}, ${b.role}, ${b.active}, ${b.cafeteriaId ?? null}, ${b.contractorId ?? null}, ${b.mobile ?? null}, ${await hashPassword(temp)}, true, ${p.id}) RETURNING id`,
          )
          .catch((e) => {
            if ((e as { cause?: { code?: string } }).cause?.code === '23505') fail('CONFLICT', 'این نام کاربری قبلاً استفاده شده است.');
            throw e;
          });
        id = r.rows[0]!.id;
      }
      await audit(tx, {
        actor: p.actor,
        action: b.id ? 'staff.update' : 'staff.create',
        entityType: 'StaffUser',
        entityId: id,
        data: { role: b.role, active: b.active, passwordReset: !!temp },
        requestId: req.id,
      });
      return { id, temporaryPassword: temp };
    });
  });

  // ── employees (customers) ──────────────────────────────────────────────
  app.get('/api/v1/employees', { config: { access: 'employeesManage' } }, async (req) => {
    const q = z.object({ search: z.string().max(80).optional(), ...page }).parse(req.query);
    const s = like(q.search);
    const r = await db.execute<
      Record<string, unknown>
    >(sql`SELECT e.id, e.username, e.first_name, e.last_name, e.kind, e.personnel_code, e.mobile, e.active, e.last_login_at, a.balance_rial, count(*) OVER()::int AS total
      FROM employees e LEFT JOIN accounts a ON a.employee_id=e.id WHERE (${s}::text IS NULL OR e.username ILIKE ${s} OR e.first_name||' '||e.last_name ILIKE ${s} OR e.personnel_code ILIKE ${s})
      ORDER BY e.last_name, e.first_name LIMIT ${q.limit} OFFSET ${q.offset}`);
    return {
      total: Number(r.rows[0]?.total ?? 0),
      employees: r.rows.map((x) => ({
        id: x.id,
        username: x.username,
        firstName: x.first_name,
        lastName: x.last_name,
        kind: x.kind,
        personnelCode: x.personnel_code ?? '',
        mobile: x.mobile ?? '',
        active: x.active,
        lastLoginAt: iso(x.last_login_at as Date),
        balanceRial: n(x.balance_rial as bigint),
      })),
    };
  });

  const empSchema = z.object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(50)
      .regex(/^[a-zA-Z0-9._-]+$/),
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    kind: z.enum(['Staff', 'Faculty', 'Contractor']).default('Staff'),
    personnelCode: z.string().max(30).optional(),
    mobile: z.string().max(20).optional(),
  });
  async function createEmployee(tx: Parameters<Parameters<Db['transaction']>[0]>[0], actorId: string, e: z.infer<typeof empSchema>) {
    const temp = tempPassword();
    const r = await tx.execute<{
      id: string;
    }>(sql`INSERT INTO employees (username, first_name, last_name, kind, personnel_code, mobile, password_hash, must_change_password, created_by)
      VALUES (${e.username}, ${e.firstName}, ${e.lastName}, ${e.kind}, ${e.personnelCode ?? null}, ${e.mobile ?? null}, ${await hashPassword(temp)}, true, ${actorId}) RETURNING id`);
    await tx.execute(sql`INSERT INTO accounts (kind, employee_id) VALUES ('Customer', ${r.rows[0]!.id})`);
    return { id: r.rows[0]!.id, temp };
  }

  app.put('/api/v1/employees', { config: { access: 'employeesManage' } }, async (req) => {
    const p = requirePrincipal(req);
    if (!canManage(staffRole(req), 'Employee')) fail('FORBIDDEN', 'شما به این بخش دسترسی ندارید.');
    const b = empSchema.extend({ id: z.string().uuid().optional(), active: z.boolean().default(true), resetPassword: z.boolean().optional() }).parse(req.body);
    return db.transaction(async (tx) => {
      let temp: string | null = null;
      let id = b.id;
      if (id) {
        if (b.resetPassword) temp = tempPassword();
        const r =
          await tx.execute(sql`UPDATE employees SET username=${b.username}, first_name=${b.firstName}, last_name=${b.lastName}, kind=${b.kind}, personnel_code=${b.personnelCode ?? null}, mobile=${b.mobile ?? null}, active=${b.active},
          password_hash=COALESCE(${temp ? await hashPassword(temp) : null}, password_hash), must_change_password=(must_change_password OR ${!!temp}), updated_at=now() WHERE id=${id} RETURNING id`);
        if (!r.rows[0]) fail('NOT_FOUND', 'کارمند پیدا نشد.');
        if (!b.active || temp) await revokeAllForSubject(tx as unknown as Db, 'employee', id);
      } else {
        try {
          const c = await createEmployee(tx, p.id, b);
          id = c.id;
          temp = c.temp;
        } catch (e) {
          if ((e as { cause?: { code?: string } }).cause?.code === '23505') fail('CONFLICT', 'این نام کاربری قبلاً استفاده شده است.');
          throw e;
        }
      }
      await audit(tx, {
        actor: p.actor,
        action: b.id ? 'employee.update' : 'employee.create',
        entityType: 'Employee',
        entityId: id,
        data: { active: b.active, passwordReset: !!temp },
        requestId: req.id,
      });
      return { id, temporaryPassword: temp };
    });
  });

  /** Bulk create ≤300 employees; returns a one-time credentials CSV that is never stored. */
  app.post('/api/v1/employees/bulk', { config: { access: 'employeesManage' } }, async (req) => {
    const p = requirePrincipal(req);
    if (!canManage(staffRole(req), 'Employee')) fail('FORBIDDEN', 'شما به این بخش دسترسی ندارید.');
    const b = z.object({ rows: z.array(empSchema).min(1).max(300) }).parse(req.body);
    const dup = b.rows.map((r) => r.username.toLowerCase()).filter((u, i, a) => a.indexOf(u) !== i);
    if (dup.length) fail('BAD_REQUEST', `نام کاربری تکراری در فایل: ${[...new Set(dup)].slice(0, 5).join('، ')}`);
    return db.transaction(async (tx) => {
      const creds: string[] = ['username,full_name,temporary_password'];
      for (const r of b.rows) {
        try {
          const c = await createEmployee(tx, p.id, r);
          creds.push([r.username, `${r.firstName} ${r.lastName}`, c.temp].map(csvCell).join(','));
        } catch (e) {
          if ((e as { cause?: { code?: string } }).cause?.code === '23505') fail('CONFLICT', `نام کاربری «${r.username}» قبلاً وجود دارد. هیچ ردیفی ثبت نشد.`);
          throw e;
        }
      }
      await audit(tx, { actor: p.actor, action: 'employee.bulk-create', entityType: 'Employee', data: { count: b.rows.length }, requestId: req.id });
      return { created: b.rows.length, credentialsCsv: '\ufeff' + creds.join('\n') };
    });
  });

  // ── students (admin) ───────────────────────────────────────────────────
  app.get('/api/v1/admin/students', { config: { access: 'studentsRead' } }, async (req) => {
    const q = z
      .object({ search: z.string().max(80).optional(), status: z.string().max(20).optional(), faculty: z.string().max(100).optional(), ...page })
      .parse(req.query);
    const s = like(q.search ? normalizeDigits(q.search) : undefined);
    const r = await db.execute<
      Record<string, unknown>
    >(sql`SELECT s.id, s.student_number, s.first_name, s.last_name, s.faculty, s.major, s.degree, s.entry_year, s.status, s.national_id_last4, s.last_login_at, a.balance_rial, count(*) OVER()::int AS total
      FROM students s LEFT JOIN accounts a ON a.student_id=s.id
      WHERE s.deleted_at IS NULL AND (${s}::text IS NULL OR s.student_number ILIKE ${s} OR s.first_name||' '||s.last_name ILIKE ${s}) AND (${q.status ?? null}::text IS NULL OR s.status::text=${q.status ?? null}) AND (${q.faculty ?? null}::text IS NULL OR s.faculty=${q.faculty ?? null})
      ORDER BY s.student_number LIMIT ${q.limit} OFFSET ${q.offset}`);
    const facets = await db.execute<{ status: string; faculty: string | null; c: number }>(
      sql`SELECT status::text, faculty, count(*)::int c FROM students WHERE deleted_at IS NULL GROUP BY 1,2`,
    );
    return {
      total: Number(r.rows[0]?.total ?? 0),
      students: r.rows.map((x) => ({
        id: x.id,
        studentNumber: x.student_number,
        fullName: `${x.first_name} ${x.last_name}`,
        faculty: x.faculty ?? '',
        major: x.major ?? '',
        degree: x.degree ?? '',
        entryYear: x.entry_year,
        status: x.status,
        nationalIdMasked: `******${x.national_id_last4}`,
        lastLoginAt: iso(x.last_login_at as Date),
        balanceRial: n(x.balance_rial as bigint),
      })),
      facets: { byStatus: agg(facets.rows, 'status'), byFaculty: agg(facets.rows, 'faculty') },
    };
  });

  app.patch('/api/v1/admin/students/:id/status', { config: { access: 'studentsWrite' } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ status: z.enum(['Active', 'OnLeave', 'Withdrawn', 'Graduated', 'Removed', 'Inactive']), reason: z.string().max(300).optional() })
      .parse(req.body);
    const status = b.status === 'Inactive' ? 'OnLeave' : b.status;
    return db.transaction(async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`UPDATE students SET status=${status}::student_status, updated_at=now() WHERE id=${id} AND deleted_at IS NULL RETURNING id`,
      );
      if (!r.rows[0]) fail('NOT_FOUND', 'دانشجو پیدا نشد.');
      if (status !== 'Active') await revokeAllForSubject(tx as unknown as Db, 'student', id);
      await audit(tx, {
        actor: p.actor,
        action: 'student.status',
        entityType: 'Student',
        entityId: id,
        data: { status, reason: b.reason ?? null },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  app.get('/api/v1/admin/students/:id/report', { config: { access: 'studentsRead' } }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = (
      await db.execute<Record<string, unknown>>(
        sql`SELECT s.*, a.id AS account_id, a.balance_rial FROM students s LEFT JOIN accounts a ON a.student_id=s.id WHERE s.id=${id}`,
      )
    ).rows[0];
    if (!s) fail('NOT_FOUND', 'دانشجو پیدا نشد.');
    const [res, led] = await Promise.all([
      db.execute<
        Record<string, unknown>
      >(sql`SELECT r.id, r.code, r.status, r.price_rial, r.created_at, r.delivered_at, o.service_date, ms.code AS slot, f.name AS food, cf.name AS cafeteria
        FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id JOIN meal_slots ms ON ms.id=o.meal_slot_id JOIN foods f ON f.id=o.food_id JOIN cafeterias cf ON cf.id=o.cafeteria_id
        WHERE r.account_id=${s.account_id as string} ORDER BY o.service_date DESC LIMIT 300`),
      db.execute<Record<string, unknown>>(
        sql`SELECT t.tracking_code, t.type, e.amount_rial, e.balance_after, t.reason, e.created_at FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account_id=${s.account_id as string} ORDER BY e.created_at DESC LIMIT 300`,
      ),
    ]);
    const count = (st: string) => res.rows.filter((r) => r.status === st).length;
    return {
      profile: {
        id: s.id,
        studentNumber: s.student_number,
        fullName: `${s.first_name} ${s.last_name}`,
        faculty: s.faculty ?? '',
        major: s.major ?? '',
        degree: s.degree ?? '',
        entryYear: s.entry_year,
        status: s.status,
        nationalIdMasked: `******${s.national_id_last4}`,
        mobile: s.mobile ?? '',
        lastLoginAt: iso(s.last_login_at as Date),
      },
      wallet: { balanceRial: n(s.balance_rial as bigint) },
      stats: { reserved: count('Reserved'), delivered: count('Delivered'), noShow: count('NoShow'), cancelled: count('Cancelled') },
      reservations: res.rows.map((r) => ({
        id: r.id,
        code: String(r.code).replace(/^R-/, ''),
        status: r.status,
        priceRial: n(r.price_rial as bigint),
        createdAt: iso(r.created_at as Date),
        deliveredAt: iso(r.delivered_at as Date),
        serviceDate: r.service_date,
        mealType: MEAL_TYPE[r.slot as string],
        foodName: r.food,
        cafeteriaName: r.cafeteria,
      })),
      ledger: led.rows.map((l) => ({
        trackingCode: l.tracking_code,
        type: l.type,
        amountRial: n(l.amount_rial as bigint),
        balanceAfter: n(l.balance_after as bigint),
        reason: l.reason ?? '',
        createdAt: iso(l.created_at as Date),
      })),
    };
  });

  app.get('/api/v1/admin/dashboard', { config: { access: 'dashboardView' } }, async (req) => {
    const p = requirePrincipal(req);
    const today = tehranDate();
    const r = await db.execute<Record<string, number>>(sql`SELECT
      (SELECT count(*) FROM students WHERE status='Active' AND deleted_at IS NULL)::int AS active_students,
      (SELECT count(*) FROM students WHERE deleted_at IS NULL)::int AS total_students,
      (SELECT count(*) FROM employees WHERE active)::int AS active_employees,
      (SELECT COALESCE(sum(capacity),0) FROM meal_offerings WHERE service_date=${today} AND status IN ('Published','SoldOut'))::int AS today_capacity,
      (SELECT count(*) FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id WHERE o.service_date=${today} AND r.status IN ('Reserved','Delivered'))::int AS today_reserved,
      (SELECT count(*) FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id WHERE o.service_date=${today} AND r.status='Delivered')::int AS today_delivered,
      (SELECT count(*) FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id WHERE o.service_date=${today} AND r.status='Cancelled')::int AS today_cancelled,
      (SELECT COALESCE(sum(r.price_rial),0) FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id WHERE o.service_date=${today} AND r.status IN ('Reserved','Delivered','NoShow'))::bigint AS today_value,
      (SELECT count(*) FROM payments WHERE status='NeedsReview')::int AS needs_review,
      (SELECT count(*) FROM deliveries WHERE outcome='OfflineConflict' AND created_at > now() - interval '7 days')::int AS offline_conflicts`);
    const trend = await db.execute<{ d: string; reserved: number; delivered: number; no_show: number }>(sql`SELECT to_char(o.service_date,'YYYY-MM-DD') AS d,
      count(*) FILTER (WHERE r.status IN ('Reserved','Delivered','NoShow'))::int reserved, count(*) FILTER (WHERE r.status='Delivered')::int delivered, count(*) FILTER (WHERE r.status='NoShow')::int no_show
      FROM meal_offerings o LEFT JOIN reservations r ON r.offering_id=o.id WHERE o.service_date BETWEEN (${today}::date - 13) AND ${today}::date GROUP BY 1 ORDER BY 1`);
    const byMeal = await db.execute<{ code: string; capacity: number; reserved: number }>(sql`SELECT ms.code, sum(o.capacity)::int AS capacity,
      sum((SELECT count(*) FROM reservations r WHERE r.offering_id=o.id AND r.status IN ('Reserved','Delivered')))::int AS reserved
      FROM meal_offerings o JOIN meal_slots ms ON ms.id=o.meal_slot_id
      WHERE o.service_date=${today} AND o.status IN ('Published','SoldOut') GROUP BY ms.code, ms.start_time ORDER BY ms.start_time`);
    const imp = await db.execute<Record<string, unknown>>(
      sql`SELECT file_name, status, summary, created_at FROM import_batches ORDER BY created_at DESC LIMIT 1`,
    );
    let money: { credits: number; debits: number; refunds: number; liability: number } | null = null;
    if (hasPermission(p.role, 'financeRead')) {
      const m = await db.execute<Record<string, bigint>>(sql`SELECT
        COALESCE(sum(e.amount_rial) FILTER (WHERE t.type IN ('MANUAL_CASH','ManualAdjust','OnlinePayment') AND e.amount_rial > 0),0)::bigint AS credits,
        COALESCE(-sum(e.amount_rial) FILTER (WHERE t.type='ReservationDebit'),0)::bigint AS debits,
        COALESCE(sum(e.amount_rial) FILTER (WHERE t.type LIKE '%Refund'),0)::bigint AS refunds,
        (SELECT COALESCE(sum(balance_rial),0) FROM accounts WHERE kind='Customer')::bigint AS liability
        FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN accounts a ON a.id=e.account_id WHERE a.kind='Customer'`);
      const x = m.rows[0]!;
      money = { credits: n(x.credits!), debits: n(x.debits!), refunds: n(x.refunds!), liability: n(x.liability!) };
    }
    const k = r.rows[0]!;
    const li = imp.rows[0];
    const sm = (li?.summary ?? {}) as Record<string, number>;
    return {
      today,
      kpis: {
        activeStudents: k.active_students,
        totalStudents: k.total_students,
        activeEmployees: k.active_employees,
        todayCapacity: k.today_capacity,
        todayReserved: k.today_reserved,
        todayDelivered: k.today_delivered,
        todayCancelled: k.today_cancelled,
        todayValueRial: Number(k.today_value),
        needsReview: k.needs_review,
        offlineConflicts: k.offline_conflicts,
      },
      trend: trend.rows.map((t) => ({ date: t.d, reserved: t.reserved, delivered: t.delivered, noShow: t.no_show })),
      byMeal: byMeal.rows.map((m) => ({ meal: MEAL_TYPE[m.code] ?? m.code, capacity: m.capacity, reserved: m.reserved })),
      lastImport: li
        ? {
            fileName: li.file_name as string,
            status: li.status as string,
            totalRows: sm.total ?? 0,
            errorRows: sm.ERROR ?? 0,
            newRows: sm.NEW ?? 0,
            updatedRows: sm.UPDATE ?? 0,
            createdAt: iso(li.created_at as Date),
          }
        : null,
      money,
    };
  });

  // ── audit / reservations / notifications / settings ────────────────────
  app.get('/api/v1/audit', { config: { access: 'auditRead' } }, async (req) => {
    const q = z.object({ search: z.string().max(80).optional(), ...page }).parse(req.query);
    const s = like(q.search);
    const r = await db.execute<Record<string, unknown>>(sql`SELECT id, actor, action, entity_type, entity_id, data, ip, created_at FROM audit_logs
      WHERE (${s}::text IS NULL OR action ILIKE ${s} OR actor ILIKE ${s} OR entity_id ILIKE ${s}) ORDER BY created_at DESC LIMIT ${q.limit + 1} OFFSET ${q.offset}`);
    return {
      events: r.rows
        .slice(0, q.limit)
        .map((x) => ({
          id: x.id,
          actor: x.actor,
          action: x.action,
          entityType: x.entity_type ?? '',
          entityId: x.entity_id ?? '',
          data: x.data,
          ip: x.ip ?? '',
          createdAt: iso(x.created_at as Date),
        })),
      hasMore: r.rows.length > q.limit,
    };
  });

  app.get('/api/v1/reservations', { config: { access: 'reservationsRead' } }, async (req) => {
    const p = requirePrincipal(req);
    const q = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        cafeteriaId: z.string().uuid().optional(),
        offeringId: z.string().uuid().optional(),
        status: z.string().max(20).optional(),
        search: z.string().max(80).optional(),
        ...page,
      })
      .parse(req.query);
    const s = like(q.search ? normalizeDigits(q.search) : undefined);
    const contractor = p.role === 'Contractor' ? p.contractorId : null;
    const r = await db.execute<
      Record<string, unknown>
    >(sql`SELECT r.id, r.code, r.status, r.price_rial, r.customer_group, r.created_at, r.delivered_at, o.service_date, ms.code AS slot, f.name AS food, cf.name AS cafeteria,
        COALESCE(st.student_number, em.username) AS owner_id, COALESCE(st.first_name||' '||st.last_name, em.first_name||' '||em.last_name) AS owner_name, count(*) OVER()::int AS total
      FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id JOIN meal_slots ms ON ms.id=o.meal_slot_id JOIN foods f ON f.id=o.food_id JOIN cafeterias cf ON cf.id=o.cafeteria_id
      JOIN accounts a ON a.id=r.account_id LEFT JOIN students st ON st.id=a.student_id LEFT JOIN employees em ON em.id=a.employee_id
      WHERE r.status <> 'Rejected' AND (${q.from ?? null}::date IS NULL OR o.service_date >= ${q.from ?? null}::date) AND (${q.to ?? null}::date IS NULL OR o.service_date <= ${q.to ?? null}::date)
        AND (${q.cafeteriaId ?? null}::uuid IS NULL OR o.cafeteria_id=${q.cafeteriaId ?? null}::uuid) AND (${q.offeringId ?? null}::uuid IS NULL OR o.id=${q.offeringId ?? null}::uuid)
        AND (${q.status ?? null}::text IS NULL OR r.status::text=${q.status ?? null}) AND (${contractor}::uuid IS NULL OR cf.contractor_id=${contractor}::uuid)
        AND (${s}::text IS NULL OR r.code ILIKE ${s} OR st.student_number ILIKE ${s} OR em.username ILIKE ${s})
      ORDER BY o.service_date DESC, r.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`);
    return {
      total: Number(r.rows[0]?.total ?? 0),
      reservations: r.rows.map((x) => ({
        id: x.id,
        code: String(x.code).replace(/^R-/, ''),
        status: x.status,
        priceRial: n(x.price_rial as bigint),
        customerGroup: x.customer_group,
        createdAt: iso(x.created_at as Date),
        deliveredAt: iso(x.delivered_at as Date),
        serviceDate: x.service_date,
        mealType: MEAL_TYPE[x.slot as string],
        foodName: x.food,
        cafeteriaName: x.cafeteria,
        studentNumber: x.owner_id,
        studentName: x.owner_name,
      })),
    };
  });

  app.get('/api/v1/notifications', { config: { access: 'notificationsSend' } }, async () => {
    const r = await db.execute<
      Record<string, unknown>
    >(sql`SELECT n.id, n.title, n.body, n.audience, n.created_at, st.student_number FROM notifications n LEFT JOIN accounts a ON a.id=n.account_id LEFT JOIN students st ON st.id=a.student_id
      WHERE n.kind='info' ORDER BY n.created_at DESC LIMIT 100`);
    return {
      notifications: r.rows.map((x) => ({
        id: x.id,
        title: x.title,
        body: x.body,
        audience: x.audience,
        createdAt: iso(x.created_at as Date),
        studentNumber: x.student_number ?? null,
      })),
    };
  });

  app.post('/api/v1/notifications', { config: { access: 'notificationsSend' } }, async (req) => {
    const p = requirePrincipal(req);
    const b = z
      .object({
        title: z.string().trim().min(2).max(150),
        body: z.string().trim().min(2).max(2000),
        studentNumber: z.string().max(20).optional(),
        audience: z.enum(['all', 'students', 'employees']).default('all'),
      })
      .parse(req.body);
    let accountId: string | null = null;
    if (b.studentNumber) {
      const a = await db.execute<{ id: string }>(
        sql`SELECT a.id FROM accounts a JOIN students s ON s.id=a.student_id WHERE s.student_number=${normalizeDigits(b.studentNumber)}`,
      );
      if (!a.rows[0]) fail('NOT_FOUND', 'دانشجو پیدا نشد.');
      accountId = a.rows[0].id;
    }
    const r = await db.execute<{ id: string }>(
      sql`INSERT INTO notifications (account_id, audience, title, body, kind) VALUES (${accountId}, ${accountId ? 'personal' : b.audience}, ${b.title}, ${b.body}, 'info') RETURNING id`,
    );
    await audit(db, {
      actor: p.actor,
      action: 'notification.send',
      entityType: 'Notification',
      entityId: r.rows[0]!.id,
      data: { personal: !!accountId, audience: b.audience },
      requestId: req.id,
    });
    return { id: r.rows[0]!.id };
  });

  app.get('/api/v1/settings', { config: { access: 'authenticated' } }, async (req) => {
    const p = requirePrincipal(req);
    const s = await getSettings(db);
    const isStaff = p.subjectType === 'staff';
    const slots = await db.execute<Record<string, unknown>>(sql`SELECT code, title, start_time, end_time FROM meal_slots ORDER BY sort_order`);
    const jobs = isStaff
      ? await db.execute<Record<string, unknown>>(sql`SELECT DISTINCT ON (job) job, started_at, finished_at, ok FROM job_runs ORDER BY job, started_at DESC`)
      : { rows: [] };
    const pub = {
      support_text: s.support_text,
      help_text: s.help_text,
      policy_text: s.policy_text,
      student_cancellation_enabled: s.student_cancellation_enabled,
      online_payment_enabled: s.online_payment_enabled,
    };
    return {
      values: isStaff ? s : pub,
      mealSlots: slots.rows.map((x) => ({ code: x.code, title: x.title, startTime: x.start_time, endTime: x.end_time })),
      jobs: jobs.rows.map((j) => ({ job: j.job, startedAt: iso(j.started_at as Date), finishedAt: iso(j.finished_at as Date), ok: j.ok })),
    };
  });

  const settingsSchema = z
    .object({
      student_cancellation_enabled: z.boolean(),
      cancel_cutoff_hours: z.number().int().min(0).max(168),
      noshow_grace_minutes: z.number().int().min(0).max(240),
      noshow_refund: z.boolean(),
      scan_window_before_minutes: z.number().int().min(0).max(240),
      scan_window_after_minutes: z.number().int().min(0).max(240),
      min_gateway_payable_rial: z.number().int().min(10000).max(10_000_000),
      online_payment_enabled: z.boolean(),
      reminderHoursBeforeMeal: z.number().int().min(0).max(48),
      max_manual_adjust_rial: z.number().int().min(0).max(1_000_000_000),
      support_text: z.string().max(3000),
      help_text: z.string().max(3000),
      policy_text: z.string().max(5000),
    })
    .partial()
    .strict();

  app.put('/api/v1/settings', { config: { access: 'settingsWrite' } }, async (req) => {
    const p = requirePrincipal(req);
    const b = z
      .object({
        values: settingsSchema.default({}),
        mealSlots: z
          .array(
            z.object({
              code: z.enum(['breakfast', 'lunch', 'dinner']),
              startTime: z.string().regex(/^[0-2]\d:[0-5]\d$/),
              endTime: z.string().regex(/^[0-2]\d:[0-5]\d$/),
            }),
          )
          .optional(),
      })
      .parse(req.body);
    return db.transaction(async (tx) => {
      const before = await getSettings(tx);
      for (const [key, value] of Object.entries(b.values)) {
        if (!(key in DEFAULT_SETTINGS)) continue;
        await tx.execute(
          sql`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${p.actor}, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        );
        await audit(tx, {
          actor: p.actor,
          action: 'settings.update',
          entityType: 'Setting',
          entityId: key,
          data: { before: before[key] ?? null, after: value },
          requestId: req.id,
        });
      }
      for (const sl of b.mealSlots ?? []) {
        if (sl.startTime >= sl.endTime) fail('BAD_REQUEST', 'ساعت شروع وعده باید قبل از پایان آن باشد.');
        await tx.execute(sql`UPDATE meal_slots SET start_time=${sl.startTime}, end_time=${sl.endTime}, updated_at=now() WHERE code=${sl.code}`);
        await audit(tx, { actor: p.actor, action: 'settings.meal-slot', entityType: 'MealSlot', entityId: sl.code, data: sl, requestId: req.id });
      }
      return { values: await getSettings(tx) };
    });
  });
}

function agg(rows: { c: number; [k: string]: unknown }[], key: string) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = String(r[key] ?? '—');
    m.set(k, (m.get(k) ?? 0) + r.c);
  }
  return [...m].map(([value, count]) => ({ value, count }));
}
export const csvCell = (v: string) => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
