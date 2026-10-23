#!/usr/bin/env node
/**
 * postinstall — رفع یک مشکل شناخته‌شدهٔ hoisting در این ورک‌اسپیس.
 *
 * چرا لازم است؟
 *   بستهٔ `drizzle-kit` در package.json منتشرشدهٔ خودش یک devDependency خراب
 *   به شکل `"drizzle-orm": "workspace:./drizzle-orm/dist"` دارد. npm به همین دلیل
 *   `drizzle-orm` را به‌جای ریشه، داخل `apps/api/node_modules` نصب می‌کند.
 *   `drizzle-kit` نسخهٔ `drizzle-orm` را با `await import('drizzle-orm/version')`
 *   (رزولوشن ESM که NODE_PATH را نادیده می‌گیرد) بررسی می‌کند و در نتیجه
 *   `drizzle-kit generate` با پیام «Please install latest version of drizzle-orm» متوقف می‌شود.
 *
 *   افزودن `drizzle-orm` به devDependencies ریشه هم ممکن نیست: peerOptionalهای آن
 *   (react-native / expo-sqlite) با react 18 فرانت‌اند تداخل دارند (ERESOLVE).
 *
 * راه‌حل: یک symlink نسبی در `node_modules` ریشه به همان نسخهٔ نصب‌شده در apps/api.
 *   این اسکریپت چیزی را در مخزن commit نمی‌کند (node_modules در .gitignore است) و
 *   اگر روزی npm این مشکل را رفع کند، بدون اثر اجرا می‌شود.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootTarget = join(root, 'node_modules', 'drizzle-orm');
const nested = join(root, 'apps', 'api', 'node_modules', 'drizzle-orm');

const log = (message) => process.stdout.write(`[postinstall] ${message}\n`);

if (existsSync(rootTarget)) {
  if (!lstatSync(rootTarget).isSymbolicLink()) {
    log('drizzle-orm در ریشهٔ node_modules نصب شده است؛ کاری انجام نشد.');
    process.exit(0);
  }
  rmSync(rootTarget, { force: true });
}

if (!existsSync(nested)) {
  log('drizzle-orm در apps/api/node_modules یافت نشد؛ symlink ساخته نشد.');
  process.exit(0);
}

mkdirSync(dirname(rootTarget), { recursive: true });
symlinkSync(join('..', 'apps', 'api', 'node_modules', 'drizzle-orm'), rootTarget, 'dir');
log('symlink ساخته شد: node_modules/drizzle-orm -> ../apps/api/node_modules/drizzle-orm');
