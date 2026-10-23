import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from './client.js';

/**
 * اجرای SQL پارامتری‌شده.
 *
 * چرا این لایه؟ پرس‌وجوهای گزارش/فهرست این سامانه فیلترهای پویا دارند و
 * خوانایی SQL خام (با `$1..$n`) از قطعه‌بندی درایو بهتر است. این تابع همان
 * متن SQL را به قطعه‌های Drizzle تبدیل می‌کند تا **همهٔ مقدارها به‌صورت
 * پارامتر بایند شوند** (بدون الحاق رشته‌ای ⇒ بدون SQL injection).
 *
 * توجه: فقط `$n` به‌عنوان پارامتر تفسیر می‌شود. برای LIMIT/OFFSET که باید
 * مستقیم در متن بیایند، از `inlineLimit`/`inlineOffset` استفاده کنید.
 */
export function rawSql(text: string, params: unknown[] = []): SQL {
  const parts: SQL[] = [];
  const pattern = /\$(\d+)/g;
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const chunk = text.slice(last, match.index);
    if (chunk) parts.push(sql.raw(chunk));
    const index = Number(match[1]) - 1;
    const value = params[index];
    if (Array.isArray(value)) {
      // آرایه‌ها به شکل `ARRAY[...]` بایند می‌شوند تا `= ANY($1::uuid[])` درست کار کند
      parts.push(
        sql`ARRAY[${sql.join(
          value.map((item) => sql`${item ?? null}`),
          sql`, `,
        )}]`,
      );
    } else {
      parts.push(sql`${value ?? null}`);
    }
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  const tail = text.slice(last);
  if (tail) parts.push(sql.raw(tail));
  return parts.length ? sql.join(parts) : sql`${text}`;
}

/** اجرای پرس‌وجو و گرفتن ردیف‌ها. */
export async function executeRaw<T = Record<string, unknown>>(target: Db | Tx, text: string, params: unknown[] = []): Promise<T[]> {
  const result = await target.execute(rawSql(text, params));
  const rows = (result as unknown as { rows?: T[] }).rows;
  return rows ?? [];
}

/** اجرای پرس‌وجو و گرفتن اولین ردیف. */
export async function executeRawOne<T = Record<string, unknown>>(target: Db | Tx, text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await executeRaw<T>(target, text, params);
  return rows[0] ?? null;
}

/** LIMIT امن (عدد صحیح) برای الحاق مستقیم در متن SQL. */
export function inlineLimit(value: number, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function inlineOffset(value: number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}
