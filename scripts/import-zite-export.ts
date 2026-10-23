#!/usr/bin/env tsx
/**
 * انتقال داده از خروجی Zite به پایگاه دادهٔ جدید.
 *
 *   npm run import:zite -- --input ./zite-export --dry-run
 *   npm run import:zite -- --input ./zite-export/zite-dump.json
 *
 * ورودی:
 *   - پوشه‌ای با یک فایل JSON یا CSV به ازای هر جدول (`students.json`, `reservations.csv`, …)
 *   - یا یک فایل JSON به شکل `{ "students": [...], "reservations": [...] , ... }`
 *
 * قواعد (مطابق صورت‌مسئله):
 *   ۱. ردیف‌های `isDemo` حذف می‌شوند.
 *   ۲. `national_id_hash` فقط وقتی منتقل می‌شود که pepper یکسان باشد
 *      (NATIONAL_ID_PEPPER === ZITE_NATIONAL_ID_PEPPER). در غیر این صورت ورود
 *      دانشجویان پس از انتقال ممکن نخواهد بود و اسکریپت هشدار می‌دهد.
 *   ۳. دفتر کل قدیمی (تک‌طرفه) به دفتر دوطرفه تبدیل می‌شود و
 *      **موجودی هر حساب = مجموع دفتر کل قدیمی** بررسی و گزارش می‌شود.
 *   ۴. کد ملی خام در هیچ خروجی/ذخیره‌ای نیست (خروجی Zite هم فقط hash داشت).
 *   ۵. `--dry-run` هیچ چیزی نمی‌نویسد؛ فقط گزارش می‌دهد.
 *   ۶. نوشتن در یک تراکنش انجام می‌شود (همه یا هیچ).
 *
 * اگر دادهٔ تولیدی واقعی در دسترس نباشد، این اسکریپت با دادهٔ نمونه در
 * `apps/api/test/unit/zite-import.test.ts` تست می‌شود.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { sql } from 'drizzle-orm';
import { readEnv } from '../apps/api/src/config/env.js';
import { createDb, createPool } from '../apps/api/src/db/client.js';
import {
  accounts,
  auditLogs,
  cafeterias,
  contractors,
  deliveries,
  foods,
  importBatches,
  ledgerEntries,
  ledgerTransactions,
  mealOfferings,
  mealSlots,
  notifications,
  offeringPrices,
  reservationHistory,
  reservations,
  staffUsers,
  students,
  systemSettings,
} from '../apps/api/src/db/schema/index.js';
import { runMigrations } from '../apps/api/src/db/migrate.js';
import { seedProduction } from '../apps/api/src/db/seed.js';

// ---------------------------------------------------------------------------
// ورودی و گزارش
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

type Report = {
  read: Record<string, number>;
  written: Record<string, number>;
  skippedDemo: number;
  skippedRows: { table: string; reason: string; count: number }[];
  balanceChecks: { accounts: number; matched: number; mismatched: { accountId: string; oldSum: number; newBalance: number }[] };
  warnings: string[];
};

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv: string[]): { input: string; dryRun: boolean; oldPepper?: string; importSessions: boolean; skipMigrate: boolean } {
  const out = { input: '', dryRun: false, oldPepper: undefined as string | undefined, importSessions: false, skipMigrate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--input' || key === '-i') out.input = String(argv[i + 1] ?? '');
    else if (key === '--dry-run') out.dryRun = true;
    else if (key === '--old-pepper') out.oldPepper = String(argv[i + 1] ?? '');
    else if (key === '--import-sessions') out.importSessions = true;
    else if (key === '--skip-migrate') out.skipMigrate = true;
  }
  return out;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function readTables(input: string): Tables {
  if (!input || !existsSync(input)) throw new Error(`مسیر ورودی یافت نشد: ${input || '(خالی)'}`);
  const tables: Tables = {};

  if (statSync(input).isDirectory()) {
    for (const file of readdirSync(input)) {
      const full = path.join(input, file);
      if (!statSync(full).isFile()) continue;
      const name = path.basename(file, path.extname(file));
      const content = readFileSync(full, 'utf8');
      tables[name] = file.toLowerCase().endsWith('.csv') ? parseCsv(content) : (JSON.parse(content) as Row[]);
    }
    return tables;
  }

  const parsed = JSON.parse(readFileSync(input, 'utf8')) as Tables | Row[];
  if (Array.isArray(parsed)) throw new Error('فایل JSON باید به شکل { "tableName": [...] } باشد.');
  return parsed;
}

/** پارس CSV ساده (بدون وابستگی) — فقط برای خروجی‌های سادهٔ Zite. */
function parseCsv(content: string): Row[] {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0] ?? '');
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row: Row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') inQuotes = false;
      else current += ch ?? '';
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(current);
      current = '';
    } else current += ch ?? '';
  }
  out.push(current);
  return out.map((v) => v.trim());
}

const str = (row: Row, key: string): string => {
  const value = row[key];
  return value == null ? '' : String(value);
};
const num = (row: Row, key: string, fallback = 0): number => {
  const value = Number(row[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
};
const bool = (row: Row, key: string, fallback = false): boolean => {
  const value = row[key];
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
};
const dateOrNull = (row: Row, key: string): Date | null => {
  const value = row[key];
  if (value == null || value === '') return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
/** روابط در خروجی Zite ممکن است رشته، آرایه یا `{id}` باشند. */
const relationId = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value == null || value === '') return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first = value[0] as { id?: string } | string;
    return typeof first === 'string' ? first : String(first?.id ?? '');
  }
  if (typeof value === 'object') return String((value as { id?: string }).id ?? '');
  return String(value);
};

// ---------------------------------------------------------------------------
// نگاشت وضعیت‌ها و حساب‌های سیستمی
// ---------------------------------------------------------------------------

const STUDENT_STATUS_MAP: Record<string, string> = {
  Active: 'Active',
  Inactive: 'OnLeave',
  Removed: 'Removed',
  OnLeave: 'OnLeave',
  Withdrawn: 'Withdrawn',
  Graduated: 'Graduated',
};

const SYSTEM_ACCOUNT_MAP: Record<string, 'MEAL_REVENUE' | 'MANUAL_CASH' | 'GATEWAY_CLEARING' | 'WITHDRAWAL_ESCROW' | 'TREASURY'> = {
  'meal-revenue': 'MEAL_REVENUE',
  mealRevenue: 'MEAL_REVENUE',
  'manual-cash': 'MANUAL_CASH',
  manualCash: 'MANUAL_CASH',
  'payment-gateway': 'GATEWAY_CLEARING',
  paymentGateway: 'GATEWAY_CLEARING',
};

const LEDGER_TYPE_MAP: Record<string, string> = {
  ManualCredit: 'ManualCredit',
  ManualDebit: 'ManualDebit',
  OnlinePayment: 'OnlinePayment',
  ReservationDebit: 'ReservationDebit',
  CancellationRefund: 'CancellationRefund',
  CapacityRefund: 'AdminRefund',
  WithdrawalHold: 'WithdrawalHold',
  WithdrawalPaid: 'WithdrawalPaid',
  WithdrawalRelease: 'WithdrawalRelease',
};

const SETTING_KEYS_ALLOWED = new Set(['supportText', 'helpText', 'reservationPolicyNote', 'cancellationPolicyNote']);

// ---------------------------------------------------------------------------
// اجرای انتقال
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!args.input) {
    log('کاربرد: npm run import:zite -- --input <path-to-export> [--dry-run] [--old-pepper <value>]');
    process.exit(1);
  }

  const envCheck = readEnv();
  if (!envCheck.ok) {
    log(`پیکربندی محیط نامعتبر است:\n- ${envCheck.issues.join('\n- ')}`);
    process.exit(1);
  }
  const env = envCheck.env;

  const tables = readTables(args.input);
  const report: Report = {
    read: {},
    written: {},
    skippedDemo: 0,
    skippedRows: [],
    balanceChecks: { accounts: 0, matched: 0, mismatched: [] },
    warnings: [],
  };
  for (const [name, rows] of Object.entries(tables)) report.read[name] = rows.length;

  // بررسی pepper
  const oldPepper = args.oldPepper ?? process.env.ZITE_NATIONAL_ID_PEPPER ?? '';
  const pepperMatches = Boolean(oldPepper) && oldPepper === env.NATIONAL_ID_PEPPER;
  if (!pepperMatches) {
    report.warnings.push(
      'pepper کد ملی یکسان نیست (یا ZITE_NATIONAL_ID_PEPPER داده نشده). در نتیجه national_id_hash منتقل نمی‌شود و ورود دانشجویان پس از انتقال ممکن نخواهد بود؛ باید فهرست دانشجویان با کد ملی مجدداً از معاونت گرفته و واردسازی اکسل انجام شود.',
    );
  }

  const demoFiltered = (rows: Row[]): Row[] => {
    const kept = rows.filter((row) => !bool(row, 'isDemo'));
    report.skippedDemo += rows.length - kept.length;
    return kept;
  };

  log(`خواندن خروجی Zite از ${args.input}`);
  for (const [name, count] of Object.entries(report.read)) log(`  - ${name}: ${count} ردیف`);
  if (report.skippedDemo > 0) log(`ردیف‌های isDemo حذف می‌شوند (در مرحلهٔ نوشتن).`);

  if (args.dryRun) {
    const counts = summarize(tables, demoFiltered, pepperMatches, report);
    log('\n=== گزارش dry-run (هیچ داده‌ای نوشته نشد) ===');
    printReport(counts, report);
    return;
  }

  if (!args.skipMigrate) {
    log('اجرای migrationها…');
    await runMigrations({ connectionString: env.DATABASE_MIGRATOR_URL || env.DATABASE_URL });
  }

  const pool = createPool(env.DATABASE_URL, 2, 'food-zite-import');
  const db = createDb(pool);
  try {
    await seedProduction(db);
    const counts = await db.transaction(async (tx) => summarizeAndWrite(tables, tx, demoFiltered, pepperMatches, report));

    // بررسی موجودی هر حساب = مجموع دفتر کل قدیمی
    await verifyBalances(tables, db, report);

    log('\n=== گزارش انتقال ===');
    printReport(counts, report);
    if (report.balanceChecks.mismatched.length > 0) {
      log('هشدار: موجودی برخی حساب‌ها با مجموع دفتر کل قدیمی نمی‌خواند. جزئیات بالا را بررسی کنید.');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

type Counts = Record<string, number>;

/** فقط شمارش (برای dry-run). */
function summarize(tables: Tables, demoFiltered: (rows: Row[]) => Row[], pepperMatches: boolean, report: Report): Counts {
  const counts: Counts = {};
  const add = (table: string, rows: Row[]) => {
    counts[table] = (counts[table] ?? 0) + rows.length;
  };
  add('contractors', demoFiltered(tables.contractors ?? []));
  add('cafeterias', demoFiltered(tables.cafeterias ?? []));
  add('foods', demoFiltered(tables.foods ?? []));
  add('staff_users', tables.staffUsers ?? []);
  add('students', tables.students ?? []);
  add('accounts', tables.students ?? []);
  counts['meal_slots'] = 3;
  add('meal_offerings', demoFiltered(tables.mealOfferings ?? []));
  add('offering_prices', demoFiltered(tables.mealOfferings ?? []));
  add('reservations', tables.reservations ?? []);
  add('reservation_history', tables.reservationHistory ?? []);
  add('ledger_transactions', tables.ledgerEntries ?? []);
  counts['ledger_entries'] = (counts['ledger_entries'] ?? 0) + (tables.ledgerEntries ?? []).length * 2;
  add('deliveries', tables.deliveries ?? []);
  add('audit_logs', tables.auditLogs ?? []);
  add('import_batches', tables.importBatches ?? []);
  add('notifications', tables.notifications ?? []);
  add(
    'system_settings',
    (tables.systemSettings ?? []).filter((row) => SETTING_KEYS_ALLOWED.has(str(row, 'key'))),
  );
  if (!pepperMatches) {
    report.skippedRows.push({
      table: 'students',
      reason: 'national_id_hash به دلیل تفاوت pepper منتقل نمی‌شود',
      count: (tables.students ?? []).length,
    });
  }
  return counts;
}

type Writer = {
  insert: ReturnType<typeof createDb>['insert'];
  execute: ReturnType<typeof createDb>['execute'];
  select: ReturnType<typeof createDb>['select'];
  update: ReturnType<typeof createDb>['update'];
};

/** شمارش + نوشتن واقعی در یک تراکنش. */
async function summarizeAndWrite(
  tables: Tables,
  tx: Writer,
  demoFiltered: (rows: Row[]) => Row[],
  pepperMatches: boolean,
  report: Report,
): Promise<Counts> {
  const counts: Counts = {};
  const bump = (table: string, n = 1) => {
    counts[table] = (counts[table] ?? 0) + n;
  };

  // --- پیمانکاران و سلف‌ها ---
  const contractorIdMap = new Map<string, string>();
  for (const row of demoFiltered(tables.contractors ?? [])) {
    const [created] = await tx
      .insert(contractors)
      .values({
        name: str(row, 'name').slice(0, 150) || 'پیمانکار منتقل‌شده',
        contractNumber: str(row, 'contractNumber').slice(0, 80),
        contactPhone: str(row, 'contactPhone') ? str(row, 'contactPhone').slice(0, 30) : null,
        isActive: bool(row, 'active', true),
      })
      .returning({ id: contractors.id });
    if (created && row.id) contractorIdMap.set(String(row.id), created.id);
    bump('contractors');
  }

  const cafeteriaIdMap = new Map<string, string>();
  for (const row of demoFiltered(tables.cafeterias ?? [])) {
    const oldContractor = relationId(row, 'contractor');
    const [created] = await tx
      .insert(cafeterias)
      .values({
        name: str(row, 'name').slice(0, 150) || 'سلف منتقل‌شده',
        location: str(row, 'location').slice(0, 200),
        contractorId: oldContractor ? (contractorIdMap.get(oldContractor) ?? null) : null,
        isActive: bool(row, 'active', true),
      })
      .returning({ id: cafeterias.id });
    if (created && row.id) cafeteriaIdMap.set(String(row.id), created.id);
    bump('cafeterias');
  }
  if (cafeteriaIdMap.size === 0) {
    const [fallback] = await tx.select({ id: cafeterias.id }).from(cafeterias).limit(1);
    if (fallback) cafeteriaIdMap.set('__default__', fallback.id);
  }

  // --- غذاها ---
  const foodIdMap = new Map<string, string>();
  for (const row of demoFiltered(tables.foods ?? [])) {
    const [created] = await tx
      .insert(foods)
      .values({
        name: str(row, 'name').slice(0, 150) || 'غذای منتقل‌شده',
        description: str(row, 'description'),
        category: str(row, 'category').slice(0, 60),
        imagePath: str(row, 'imageUrl') ? str(row, 'imageUrl').slice(0, 1000) : null,
        defaultPriceRial: row.defaultPriceRial == null ? null : num(row, 'defaultPriceRial'),
        defaultCapacity: row.defaultCapacity == null ? null : num(row, 'defaultCapacity'),
        isActive: bool(row, 'active', true),
      })
      .returning({ id: foods.id });
    if (created && row.id) foodIdMap.set(String(row.id), created.id);
    bump('foods');
  }

  // --- وعده‌ها ---
  const slots = await tx.select().from(mealSlots);
  const slotByCode = new Map(slots.map((s) => [s.code, s]));

  // --- کارکنان ---
  for (const row of tables.staffUsers ?? []) {
    const passwordHash = str(row, 'passwordHash');
    if (!passwordHash) {
      report.skippedRows.push({ table: 'staffUsers', reason: 'passwordHash خالی', count: 1 });
      continue;
    }
    const contractorOld = relationId(row, 'contractor');
    const cafeteriaOld = relationId(row, 'cafeteria');
    await tx
      .insert(staffUsers)
      .values({
        username: str(row, 'username').toLowerCase().slice(0, 64),
        fullName: str(row, 'fullName').slice(0, 200) || str(row, 'username'),
        passwordHash: passwordHash.slice(0, 255), // PBKDF2 قدیمی در اولین ورود به Argon2id تبدیل می‌شود
        role: mapRole(str(row, 'role')),
        status: str(row, 'status') === 'Disabled' ? 'Disabled' : 'Active',
        contractorId: contractorOld ? (contractorIdMap.get(contractorOld) ?? null) : null,
        cafeteriaId: cafeteriaOld ? (cafeteriaIdMap.get(cafeteriaOld) ?? null) : null,
        mustChangePassword: true,
      })
      .onConflictDoNothing();
    bump('staff_users');
  }

  // --- دانشجویان و حساب‌ها ---
  const accountIdByStudentOldId = new Map<string, string>();
  for (const row of tables.students ?? []) {
    const studentNumber = str(row, 'studentNumber').trim();
    if (!studentNumber) {
      report.skippedRows.push({ table: 'students', reason: 'شمارهٔ دانشجویی خالی', count: 1 });
      continue;
    }
    const oldHash = str(row, 'nationalIdHash');
    const nationalIdHash = pepperMatches && /^[a-f0-9]{64}$/i.test(oldHash) ? oldHash.toLowerCase() : placeholderHash(studentNumber);
    const [student] = await tx
      .insert(students)
      .values({
        studentNumber: studentNumber.slice(0, 20),
        fullName: str(row, 'fullName').slice(0, 200) || studentNumber,
        faculty: str(row, 'faculty').slice(0, 200),
        major: str(row, 'major').slice(0, 200),
        degree: str(row, 'degree').slice(0, 100),
        entryYear: row.entryYear == null || row.entryYear === '' ? null : num(row, 'entryYear'),
        nationalIdHash,
        nationalIdLast4: str(row, 'nationalIdLastDigits').slice(-4),
        status: STUDENT_STATUS_MAP[str(row, 'status')] ?? 'Active',
        addedAt: dateOrNull(row, 'addedAt') ?? new Date(),
        removedAt: dateOrNull(row, 'removedAt'),
      })
      .onConflictDoUpdate({
        target: students.studentNumber,
        set: {
          fullName: str(row, 'fullName').slice(0, 200) || studentNumber,
          faculty: str(row, 'faculty').slice(0, 200),
          major: str(row, 'major').slice(0, 200),
          degree: str(row, 'degree').slice(0, 100),
          status: STUDENT_STATUS_MAP[str(row, 'status')] ?? 'Active',
        },
      })
      .returning({ id: students.id });
    bump('students');
    if (!student) continue;

    const [account] = await tx
      .insert(accounts)
      .values({
        kind: 'Student',
        studentId: student.id,
        customerGroup: 'Student',
        balanceRial: 0,
        isActive: STUDENT_STATUS_MAP[str(row, 'status')] === 'Active',
      })
      .onConflictDoNothing({ target: accounts.studentId })
      .returning({ id: accounts.id });
    if (account && row.id) accountIdByStudentOldId.set(String(row.id), account.id);
    bump('accounts');
  }

  // --- آیتم‌های منو + قیمت‌ها ---
  const offeringIdMap = new Map<string, string>();
  for (const row of demoFiltered(tables.mealOfferings ?? [])) {
    const mealType = str(row, 'mealType') || 'Lunch';
    const slot = slotByCode.get(mealType) ?? slotByCode.get('Lunch');
    const foodOld = relationId(row, 'food');
    const cafeteriaOld = relationId(row, 'cafeteria');
    const foodId = foodOld ? foodIdMap.get(foodOld) : undefined;
    const cafeteriaId = (cafeteriaOld ? cafeteriaIdMap.get(cafeteriaOld) : undefined) ?? cafeteriaIdMap.get('__default__');
    if (!slot || !foodId || !cafeteriaId) {
      report.skippedRows.push({ table: 'mealOfferings', reason: 'وعده/غذا/سلف نگاشت نشد', count: 1 });
      continue;
    }
    const serviceDate = String(str(row, 'serviceDate')).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      report.skippedRows.push({ table: 'mealOfferings', reason: 'serviceDate نامعتبر', count: 1 });
      continue;
    }
    const reserveDeadline = dateOrNull(row, 'reserveDeadline') ?? new Date(`${serviceDate}T00:00:00Z`);
    const [created] = await tx
      .insert(mealOfferings)
      .values({
        serviceDate,
        mealSlotId: slot.id,
        foodId,
        cafeteriaId,
        capacity: Math.max(1, num(row, 'capacity', 1)),
        reservedCount: 0,
        reserveOpensAt: new Date(Math.min(reserveDeadline.getTime() - 86_400_000, Date.now())),
        reserveDeadline,
        cancelDeadline: dateOrNull(row, 'cancelDeadline'),
        status: bool(row, 'active', true) ? 'Published' : 'Draft',
        notes: str(row, 'notes'),
        publishedAt: bool(row, 'active', true) ? new Date() : null,
      })
      .onConflictDoNothing()
      .returning({ id: mealOfferings.id });
    if (!created) continue;
    if (row.id) offeringIdMap.set(String(row.id), created.id);
    bump('meal_offerings');

    const price = num(row, 'priceRial', 0);
    await tx
      .insert(offeringPrices)
      .values({ offeringId: created.id, customerGroup: 'Student', priceRial: Math.max(0, price) })
      .onConflictDoNothing();
    bump('offering_prices');
  }

  // --- رزروها ---
  const reservationIdMap = new Map<string, string>();
  const reservedCountByOffering = new Map<string, number>();
  const sortedReservations = [...(tables.reservations ?? [])].sort((a, b) => num(a, 'seq') - num(b, 'seq'));
  for (const row of sortedReservations) {
    const studentOld = relationId(row, 'student');
    const offeringOld = relationId(row, 'offering');
    const accountId = studentOld ? accountIdByStudentOldId.get(studentOld) : undefined;
    const offeringId = offeringOld ? offeringIdMap.get(offeringOld) : undefined;
    if (!accountId || !offeringId) {
      report.skippedRows.push({ table: 'reservations', reason: 'حساب یا وعدهٔ نگاشت‌نشده', count: 1 });
      continue;
    }
    const [offering] = await tx
      .select({ serviceDate: mealOfferings.serviceDate, mealSlotId: mealOfferings.mealSlotId, cafeteriaId: mealOfferings.cafeteriaId })
      .from(mealOfferings)
      .where(sql`${mealOfferings.id} = ${offeringId}`)
      .limit(1);
    if (!offering) continue;

    const status = mapReservationStatus(str(row, 'status'));
    const [created] = await tx
      .insert(reservations)
      .values({
        code: normalizeReservationCode(str(row, 'code')),
        accountId,
        offeringId,
        serviceDate: offering.serviceDate,
        mealSlotId: offering.mealSlotId,
        cafeteriaId: offering.cafeteriaId,
        priceAtBooking: Math.max(0, num(row, 'priceAtBooking')),
        customerGroupAtBooking: 'Student',
        status,
        idempotencyKey: `zite:${str(row, 'idempotencyKey') || String(row.id ?? Math.random())}`.slice(0, 160),
        qrToken: /^[a-f0-9]{48}$/i.test(str(row, 'qrToken')) ? str(row, 'qrToken').toLowerCase() : null,
        qrIssuedAt: /^[a-f0-9]{48}$/i.test(str(row, 'qrToken')) ? new Date() : null,
        deliveredAt: dateOrNull(row, 'deliveredAt'),
      })
      .onConflictDoNothing()
      .returning({ id: reservations.id });
    if (!created) {
      report.skippedRows.push({ table: 'reservations', reason: 'تکراری/نقض یکتایی', count: 1 });
      continue;
    }
    if (row.id) reservationIdMap.set(String(row.id), created.id);
    bump('reservations');
    if (status === 'Reserved' || status === 'Delivered') {
      reservedCountByOffering.set(offeringId, (reservedCountByOffering.get(offeringId) ?? 0) + 1);
    }
  }

  // reserved_count باید با رزروهای زنده بخواند
  for (const [offeringId, count] of reservedCountByOffering) {
    await tx
      .update(mealOfferings)
      .set({ reservedCount: sql`LEAST(${count}, capacity)` })
      .where(sql`${mealOfferings.id} = ${offeringId}`);
  }

  // --- تاریخچهٔ رزرو ---
  for (const row of tables.reservationHistory ?? []) {
    const reservationOld = relationId(row, 'reservation');
    const reservationId = reservationOld ? reservationIdMap.get(reservationOld) : undefined;
    if (!reservationId) continue;
    await tx.insert(reservationHistory).values({
      reservationId,
      fromStatus: str(row, 'fromStatus'),
      toStatus: str(row, 'toStatus') || 'Reserved',
      actorType: 'System',
      actorLabel: str(row, 'actor').slice(0, 120),
      note: str(row, 'note'),
    });
    bump('reservation_history');
  }

  // --- دفتر کل: تک‌طرفه ← دوطرفه ---
  const balanceByAccount = new Map<string, number>();
  const ledgerRows = [...(tables.ledgerEntries ?? [])].sort((a, b) => num(a, 'seq') - num(b, 'seq'));
  for (const row of ledgerRows) {
    const studentOld = relationId(row, 'student');
    const accountId = studentOld ? accountIdByStudentOldId.get(studentOld) : undefined;
    const amount = num(row, 'amountRial');
    if (!accountId || amount === 0) {
      report.skippedRows.push({ table: 'ledgerEntries', reason: 'حساب نگاشت نشد یا مبلغ صفر', count: 1 });
      continue;
    }
    const type = LEDGER_TYPE_MAP[str(row, 'type')] ?? 'Correction';
    const systemAccount = SYSTEM_ACCOUNT_MAP[str(row, 'counterAccount')] ?? 'TREASURY';
    const trackingCode = normalizeTrackingCode(str(row, 'trackingCode'));
    const [txRow] = await tx
      .insert(ledgerTransactions)
      .values({
        type: type as 'ManualCredit',
        idempotencyKey: `zite:${str(row, 'idempotencyKey') || String(row.id ?? Math.random())}`.slice(0, 200),
        referenceType: relationId(row, 'reservation') ? 'Reservation' : 'Import',
        referenceId: null,
        reason: (str(row, 'reason') || 'انتقال از سامانهٔ قبلی').slice(0, 1000),
        actorType: relationId(row, 'actorStaff') ? 'Staff' : 'System',
        actorId: null,
        trackingCode,
      })
      .onConflictDoNothing()
      .returning({ id: ledgerTransactions.id });
    if (!txRow) continue;

    const runningBalance = (balanceByAccount.get(accountId) ?? 0) + amount;
    await tx.insert(ledgerEntries).values([
      { transactionId: txRow.id, accountId, systemAccount: null, amountRial: amount, balanceAfter: Math.max(0, runningBalance) },
      { transactionId: txRow.id, accountId: null, systemAccount, amountRial: -amount, balanceAfter: null },
    ]);
    balanceByAccount.set(accountId, runningBalance);
    bump('ledger_transactions');
    bump('ledger_entries', 2);
  }

  // اعمال موجودی نهایی روی accounts (با بررسی منفی‌نشدن)
  for (const [accountId, balance] of balanceByAccount) {
    const safe = Math.max(0, balance);
    if (safe !== balance) {
      report.warnings.push(`موجودی حساب ${accountId} در دادهٔ قدیمی منفی بود (${balance}) و به صفر تنظیم شد.`);
    }
    await tx
      .update(accounts)
      .set({ balanceRial: safe })
      .where(sql`${accounts.id} = ${accountId}`);
  }

  // --- تحویل‌ها ---
  for (const row of tables.deliveries ?? []) {
    const reservationOld = relationId(row, 'reservation');
    const reservationId = reservationOld ? reservationIdMap.get(reservationOld) : undefined;
    const operator = await firstStaffId(tx);
    if (!operator) break;
    const cafeteria = cafeteriaIdMap.get('__default__') ?? [...cafeteriaIdMap.values()][0];
    if (!cafeteria) break;
    await tx.insert(deliveries).values({
      reservationId: reservationId ?? null,
      operatorId: operator,
      cafeteriaId: cafeteria,
      outcome: mapDeliveryOutcome(str(row, 'outcome')),
      source: 'Online',
      message: 'انتقال از سامانهٔ قبلی',
    });
    bump('deliveries');
  }

  // --- ممیزی ---
  for (const row of tables.auditLogs ?? []) {
    await tx.insert(auditLogs).values({
      actorType: mapActorType(str(row, 'actorType')),
      actorLabel: str(row, 'actorLabel').slice(0, 160),
      action: str(row, 'action').slice(0, 80) || 'zite.import',
      targetType: str(row, 'targetType').slice(0, 60),
      targetId: str(row, 'targetId').slice(0, 64),
      details: { migratedFrom: 'zite', raw: sanitizeDetails(str(row, 'details')) },
      createdAt: dateOrNull(row, 'created_at') ?? dateOrNull(row, 'createdAt') ?? new Date(),
    });
    bump('audit_logs');
  }

  // --- دسته‌های واردسازی (فقط متادیتا؛ stagedData منتقل نمی‌شود) ---
  for (const row of tables.importBatches ?? []) {
    await tx.insert(importBatches).values({
      fileName: str(row, 'fileName').slice(0, 200) || 'import-from-zite',
      status: ['Preview', 'Committed', 'Cancelled', 'Failed'].includes(str(row, 'status'))
        ? (str(row, 'status') as 'Committed')
        : 'Committed',
      policy: str(row, 'policy') === 'RejectAllOnError' ? 'RejectAllOnError' : 'SkipInvalidRows',
      fullSync: bool(row, 'fullSync'),
      totalRows: num(row, 'totalRows'),
      validRows: num(row, 'validRows'),
      errorRows: num(row, 'errorRows'),
      newRows: num(row, 'newRows'),
      changedRows: num(row, 'changedRows'),
      returningRows: num(row, 'returningRows'),
      removedRows: num(row, 'removedRows'),
      fileFingerprint: /^[a-f0-9]{64}$/i.test(str(row, 'fileFingerprint')) ? str(row, 'fileFingerprint').toLowerCase() : null,
      committedAt: dateOrNull(row, 'createdAt') ?? new Date(),
    });
    bump('import_batches');
  }

  // --- اعلان‌ها ---
  for (const row of tables.notifications ?? []) {
    const studentOld = relationId(row, 'student');
    const accountId = studentOld ? accountIdByStudentOldId.get(studentOld) : undefined;
    await tx.insert(notifications).values({
      title: str(row, 'title').slice(0, 200) || 'اعلان',
      body: str(row, 'body'),
      audience: accountId ? 'Account' : 'Broadcast',
      accountId: accountId ?? null,
      createdAt: dateOrNull(row, 'createdAt') ?? new Date(),
    });
    bump('notifications');
  }

  // --- تنظیمات (فقط چهار متن شناخته‌شده) ---
  for (const row of tables.systemSettings ?? []) {
    const key = str(row, 'key');
    if (!SETTING_KEYS_ALLOWED.has(key)) {
      report.skippedRows.push({ table: 'systemSettings', reason: `کلید ناشناخته ${key}`, count: 1 });
      continue;
    }
    await tx
      .insert(systemSettings)
      .values({ key, value: sql`to_jsonb(${str(row, 'value')}::text)` })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: sql`to_jsonb(${str(row, 'value')}::text)` } });
    bump('system_settings');
  }

  if (!pepperMatches) {
    report.skippedRows.push({
      table: 'students',
      reason: 'national_id_hash به دلیل تفاوت pepper با مقدار موقت جایگزین شد',
      count: (tables.students ?? []).length,
    });
  }

  return counts;
}

async function firstStaffId(tx: Writer): Promise<string | null> {
  const rows = await tx.select({ id: staffUsers.id }).from(staffUsers).limit(1);
  return rows[0]?.id ?? null;
}

function mapRole(role: string): 'SuperAdmin' | 'StudentAffairs' | 'NutritionManager' | 'Contractor' | 'Operator' | 'Finance' {
  switch (role) {
    case 'SuperAdmin':
      return 'SuperAdmin';
    case 'StudentAffairs':
      return 'StudentAffairs';
    case 'Contractor':
      return 'Contractor';
    case 'Operator':
      return 'Operator';
    case 'Finance':
      return 'Finance';
    default:
      return 'NutritionManager';
  }
}

function mapReservationStatus(status: string): 'Reserved' | 'Delivered' | 'Cancelled' | 'Rejected' | 'Expired' | 'NoShow' {
  switch (status) {
    case 'Delivered':
      return 'Delivered';
    case 'Cancelled':
      return 'Cancelled';
    case 'Rejected':
      return 'Rejected';
    case 'Expired':
      return 'Expired';
    case 'NoShow':
      return 'NoShow';
    default:
      return 'Reserved';
  }
}

function mapDeliveryOutcome(outcome: string): 'Accepted' | 'Duplicate' | 'Invalid' | 'Cancelled' {
  switch (outcome) {
    case 'Duplicate':
      return 'Duplicate';
    case 'Invalid':
      return 'Invalid';
    case 'Cancelled':
      return 'Cancelled';
    default:
      return 'Accepted';
  }
}

function mapActorType(actorType: string): 'Staff' | 'Student' | 'System' | 'Anonymous' {
  switch (actorType) {
    case 'Staff':
      return 'Staff';
    case 'Student':
      return 'Student';
    case 'Anonymous':
      return 'Anonymous';
    default:
      return 'System';
  }
}

/** کد رزرو باید با `^R-[A-Z0-9]{8,12}$` مطابقت کند. */
function normalizeReservationCode(code: string): string {
  const cleaned = String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^R/, '');
  const padded = (cleaned || 'MIGRATED').padEnd(8, 'X').slice(0, 12);
  return `R-${padded}`;
}

/** کد رهگیری باید با `^TX-[A-Z0-9]{8,16}$` مطابقت کند. */
function normalizeTrackingCode(code: string): string {
  const cleaned = String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^TX/, '');
  const padded = (cleaned || 'MIGRATED').padEnd(8, 'X').slice(0, 16);
  return `TX-${padded}`;
}

/** hash موقت برای وقتی که pepper یکسان نیست (ورود تا واردسازی مجدد ممکن نیست). */
function placeholderHash(studentNumber: string): string {
  let hash = 0;
  for (const ch of `migrated:${studentNumber}`) hash = (hash * 31 + ch.charCodeAt(0)) % 0xffffffff;
  return `ffffffff${hash.toString(16).padStart(8, '0')}`.padEnd(64, '0').slice(0, 64);
}

/** جزئیات ممیزی قدیمی پاک‌سازی می‌شود تا دادهٔ حساس منتقل نشود. */
function sanitizeDetails(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (/national|password|token|iban|secret/i.test(key)) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return { note: 'unparsable-details' };
  }
}

/** بررسی نهایی: موجودی هر حساب = مجموع دفتر کل قدیمی. */
async function verifyBalances(tables: Tables, db: ReturnType<typeof createDb>, report: Report): Promise<void> {
  const expected = new Map<string, number>();
  for (const row of tables.ledgerEntries ?? []) {
    const studentOld = relationId(row, 'student');
    const studentNumber = str(row, 'studentNumber');
    const key = studentOld || studentNumber;
    if (!key) continue;
    expected.set(key, (expected.get(key) ?? 0) + num(row, 'amountRial'));
  }

  // نگاشت کلید قدیمی → حساب جدید از روی شمارهٔ دانشجویی
  const studentRows = await db.execute(
    sql`SELECT s.student_number AS sn, a.id AS account_id, a.balance_rial AS balance FROM accounts a JOIN students s ON s.id = a.student_id`,
  );
  const byNumber = new Map<string, { accountId: string; balance: number }>();
  for (const row of ((studentRows as unknown as { rows: { sn: string; account_id: string; balance: string }[] }).rows ?? []) as {
    sn: string;
    account_id: string;
    balance: string;
  }[]) {
    byNumber.set(row.sn, { accountId: row.account_id, balance: Number(row.balance) });
  }

  const oldToNumber = new Map<string, string>();
  for (const row of tables.students ?? []) oldToNumber.set(String(row.id ?? ''), str(row, 'studentNumber'));

  let checked = 0;
  let matched = 0;
  for (const [key, sum] of expected) {
    const studentNumber = oldToNumber.get(key) ?? key;
    const account = byNumber.get(studentNumber);
    if (!account) continue;
    checked += 1;
    if (Math.max(0, sum) === account.balance) matched += 1;
    else report.balanceChecks.mismatched.push({ accountId: account.accountId, oldSum: sum, newBalance: account.balance });
  }
  report.balanceChecks.accounts = checked;
  report.balanceChecks.matched = matched;
}

function printReport(counts: Counts, report: Report): void {
  log(`ردیف‌های isDemo حذف‌شده: ${report.skippedDemo}`);
  for (const [table, count] of Object.entries(counts)) log(`  ${table}: ${count}`);
  if (report.skippedRows.length) {
    log('\nردیف‌های منتقل‌نشده:');
    const grouped = new Map<string, number>();
    for (const item of report.skippedRows) {
      const key = `${item.table}: ${item.reason}`;
      grouped.set(key, (grouped.get(key) ?? 0) + item.count);
    }
    for (const [key, count] of grouped) log(`  - ${key} (${count})`);
  }
  log(`\nتطبیق موجودی حساب‌ها: ${report.balanceChecks.matched}/${report.balanceChecks.accounts} مطابق`);
  if (report.balanceChecks.mismatched.length) {
    for (const item of report.balanceChecks.mismatched.slice(0, 20)) {
      log(`  - حساب ${item.accountId}: مجموع قدیمی ${item.oldSum} ≠ موجودی جدید ${item.newBalance}`);
    }
  }
  if (report.warnings.length) {
    log('\nهشدارها:');
    for (const warning of report.warnings) log(`  - ${warning}`);
  }
}

main().catch((error) => {
  process.stderr.write(`انتقال ناموفق بود: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
