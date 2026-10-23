import { z } from 'zod';
import { STUDENT_STATUSES } from '../constants.js';

/** اجزای مشترک اسکیماهای REST. */

export const uuidSchema = z.uuid({ error: 'شناسهٔ معتبر نیست.' });

/** روز سرویس: `YYYY-MM-DD` (روز تقویمی تهران). */
export const serviceDateSchema = z
  .string({ error: 'تاریخ باید به قالب YYYY-MM-DD باشد.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ باید به قالب YYYY-MM-DD باشد.');

export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'ساعت باید به قالب HH:mm یا HH:mm:ss باشد.');

export const isoDateTimeSchema = z.iso.datetime({ offset: true, error: 'زمان باید ISO 8601 معتبر باشد.' });

/** مبلغ ریال (عدد صحیح). */
export const rialSchema = z
  .number({ error: 'مبلغ باید عدد باشد.' })
  .int('مبلغ باید عدد صحیح (ریال) باشد.')
  .min(0, 'مبلغ نمی‌تواند منفی باشد.')
  .max(100_000_000, 'مبلغ بیش از حد مجاز است.');

/** کلید idempotency از سمت کلاینت. */
export const idempotencyKeySchema = z
  .string({ error: 'کلید یکتایی درخواست الزامی است.' })
  .min(8, 'کلید یکتایی باید حداقل ۸ کاراکتر باشد.')
  .max(80, 'کلید یکتایی حداکثر ۸۰ کاراکتر است.');

/** صفحه‌بندی سرور. */
export const paginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');

/** متن آزاد با محدودیت طول (برای دلیل/یادداشت). */
export const reasonSchema = (min = 5, max = 500) =>
  z
    .string({ error: 'دلیل الزامی است.' })
    .trim()
    .min(min, `دلیل باید حداقل ${min} کاراکتر باشد.`)
    .max(max, `دلیل حداکثر ${max} کاراکتر است.`);

export const studentStatusSchema = z.enum(STUDENT_STATUSES);

/** بازهٔ تاریخ برای گزارش‌ها. */
export const dateRangeSchema = z.object({
  from: serviceDateSchema,
  to: serviceDateSchema,
});

/** پاسخ موفقیت ساده. */
export const okResponseSchema = z.object({ ok: z.literal(true) });

/** فیلدهای مشترک پاسخ‌های فهرست (برای صفحه‌بندی). */
export const listMetaSchema = z.object({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});
