#!/usr/bin/env tsx
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { STAFF_ROLES, type StaffRole } from '@food/shared';
import { getEnv, readEnv } from '../config/env.js';
import { createDb, createPool } from '../db/client.js';
import { createStaffFromCli } from '../services/staff.service.js';
import { randomCode } from '../lib/crypto.js';
import { createSilentLogger } from '../lib/logger.js';

/**
 * `npm run create-admin -- --username admin --fullname "مدیر ارشد" --role SuperAdmin`
 *
 * ساخت حساب کارکنان از خط فرمان — تنها مسیر مجاز برای ساخت `SuperAdmin`
 * (در API ساخت نقش هم‌سطح ممنوع است تا ارتقای دسترسی ممکن نباشد).
 *
 * اگر رمز داده نشود، یک رمز تصادفی قوی تولید و **یک بار** چاپ می‌شود.
 */
type Args = { username?: string; fullName?: string; role?: StaffRole; password?: string; cafeteriaId?: string; contractorId?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--username') out.username = value;
    else if (key === '--fullname' || key === '--full-name') out.fullName = value;
    else if (key === '--role') out.role = value as StaffRole;
    else if (key === '--password') out.password = value;
    else if (key === '--cafeteria-id') out.cafeteriaId = value;
    else if (key === '--contractor-id') out.contractorId = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const readline = createInterface({ input: process.stdin, output: process.stdout });

const ask = async (question: string, fallback?: string): Promise<string> => {
  const answer = (await readline.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
  return answer || fallback || '';
};

try {
  const envCheck = readEnv();
  if (!envCheck.ok) {
    console.error(`پیکربندی محیط نامعتبر است:\n- ${envCheck.issues.join('\n- ')}`);
    process.exit(1);
  }
  const env = getEnv();

  const username = args.username ?? (await ask('نام کاربری'));
  const fullName = args.fullName ?? (await ask('نام و نام خانوادگی'));
  const roleText = args.role ?? ((await ask('نقش', 'SuperAdmin')) as StaffRole);
  if (!STAFF_ROLES.includes(roleText)) {
    console.error(`نقش نامعتبر. نقش‌های مجاز: ${STAFF_ROLES.join(', ')}`);
    process.exit(1);
  }

  const generatedPassword = `${randomCode(6)}-${randomCode(6)}-${randomCode(4)}`;
  const password = args.password ?? (await ask('رمز عبور (خالی ⇒ رمز تصادفی تولید می‌شود)')) ?? '';
  const finalPassword = password || generatedPassword;

  const pool = createPool(env.DATABASE_URL, 1, 'food-cli');
  const db = createDb(pool);
  const deps = { db, env, log: createSilentLogger('cli') };

  const created = await createStaffFromCli(deps, {
    username,
    fullName,
    role: roleText,
    password: finalPassword,
    cafeteriaId: args.cafeteriaId ?? null,
    contractorId: args.contractorId ?? null,
  });

  console.log(`حساب ساخته شد: id=${created.id} username=${username} role=${roleText}`);
  if (!password) {
    console.log(`رمز تصادفی (فقط یک بار نمایش داده می‌شود): ${generatedPassword}`);
  }
  console.log('در اولین ورود، تغییر رمز اجباری است.');
  await pool.end();
} catch (error) {
  console.error('ساخت حساب ناموفق بود:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  readline.close();
}
