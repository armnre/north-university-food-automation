#!/usr/bin/env tsx
import process from 'node:process';
import { appliedMigrationCount, listMigrations, runMigrations } from '../db/migrate.js';

/**
 * `npm run db:migrate`
 *
 * اجرای migrationهای ورژن‌دار با نقش مالک schema (`food_migrator`).
 * `drizzle-kit push` در این پروژه ممنوع است.
 *
 * فقط متغیرهای پایگاه داده لازم است (نه همهٔ secretها) تا migration را
 * بتوان پیش از پیکربندی کامل اجرا کرد.
 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`متغیر محیطی ${name} تنظیم نشده است.`);
    process.exit(1);
  }
  return value;
}

const migratorUrl = process.env.DATABASE_MIGRATOR_URL?.trim() || required('DATABASE_URL');

const log = (message: string): void => {
  console.log(message);
};

log(`مهاجرت پایگاه داده… (${migratorUrl.replace(/:[^:@/]+@/, ':***@')})`);
const available = listMigrations();
log(`فایل‌های migration: ${available.join(', ')}`);

try {
  const result = await runMigrations({
    connectionString: migratorUrl,
    appRole: process.env.DB_APP_ROLE?.trim() || 'food_app',
    migratorRole: process.env.DB_MIGRATOR_ROLE?.trim() || 'food_migrator',
    appRolePassword: process.env.DB_APP_ROLE_PASSWORD?.trim() || undefined,
    migratorRolePassword: process.env.DB_MIGRATOR_ROLE_PASSWORD?.trim() || undefined,
    log,
  });
  const applied = await appliedMigrationCount(migratorUrl);
  log(`انجام شد. ${applied} migration اعمال شده است (موجود: ${available.length}).`);
  if (applied < available.length) {
    log('هشدار: تعداد migrationهای اعمال‌شده کمتر از فایل‌های موجود است.');
    process.exitCode = 1;
  }
  void result;
} catch (error) {
  console.error('مهاجرت ناموفق بود:', error instanceof Error ? error.message : error);
  process.exit(1);
}
