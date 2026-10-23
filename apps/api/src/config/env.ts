import { z } from 'zod';

/**
 * اعتبارسنجی متغیرهای محیطی در startup با Zod.
 *
 * قاعده: نبودِ هر کلید ضروری ⇒ اپلیکیشن بالا نمی‌آید (fail fast).
 * هیچ مقدار پیش‌فرض برای secretها وجود ندارد.
 */

const boolFromText = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v == null || v === '') return fallback;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      return fallback;
    });

const intFromText = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v == null || v.trim() === '') return fallback;
      const n = Number(v.trim());
      return Number.isSafeInteger(n) ? n : fallback;
    });

const HEX_64 = /^[a-fA-F0-9]{64}$/;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: intFromText(3001).pipe(z.number().int().min(1).max(65535)),
    PUBLIC_BASE_URL: z
      .string()
      .optional()
      .transform((v) => (v ? v.replace(/\/+$/, '') : '')),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUSTED_PROXY_HOPS: intFromText(0).pipe(z.number().int().min(0).max(5)),
    BODY_LIMIT_BYTES: intFromText(6_291_456).pipe(z.number().int().min(10_240).max(104_857_600)),

    DATABASE_URL: z.string().min(10, 'DATABASE_URL الزامی است'),
    DATABASE_MIGRATOR_URL: z.string().optional(),
    DATABASE_POOL_MAX: intFromText(10).pipe(z.number().int().min(1).max(100)),
    DB_APP_ROLE: z.string().default('food_app'),
    DB_MIGRATOR_ROLE: z.string().default('food_migrator'),
    DB_APP_ROLE_PASSWORD: z.string().optional(),
    DB_MIGRATOR_ROLE_PASSWORD: z.string().optional(),

    CSRF_SECRET: z.string().min(32, 'CSRF_SECRET باید حداقل ۳۲ کاراکتر باشد'),
    NATIONAL_ID_PEPPER: z.string().min(32, 'NATIONAL_ID_PEPPER باید حداقل ۳۲ کاراکتر باشد'),
    DATA_ENCRYPTION_KEY: z.string().regex(HEX_64, 'DATA_ENCRYPTION_KEY باید ۶۴ کاراکتر hex (۳۲ بایت) باشد'),
    SETUP_CODE: z.string().min(16).optional(),

    SESSION_COOKIE_NAME: z.string().min(3).default('__Host-sid'),
    SESSION_TTL_STUDENT_HOURS: intFromText(12).pipe(z.number().int().min(1).max(720)),
    SESSION_TTL_STAFF_HOURS: intFromText(8).pipe(z.number().int().min(1).max(720)),
    SESSION_ABSOLUTE_MAX_HOURS: intFromText(168).pipe(z.number().int().min(1).max(720)),

    ONLINE_PAYMENT_ENABLED: boolFromText(false),
    ZARINPAL_MERCHANT_ID: z.string().optional(),
    ALLOW_SANDBOX_GATEWAY: boolFromText(false),

    SMS_PROVIDER: z.enum(['console', 'kavenegar']).default('console'),
    KAVENEGAR_API_KEY: z.string().optional(),
    KAVENEGAR_SENDER: z.string().optional(),
    SMS_MAX_ATTEMPTS: intFromText(3).pipe(z.number().int().min(1).max(10)),

    /** محدودیت هر IP روی مسیرهای ورود (تعداد در بازهٔ زیر) */
    RATE_LIMIT_LOGIN_ROUTE_MAX: intFromText(20).pipe(z.number().int().min(1).max(1_000_000)),
    /** آستانهٔ شکست‌های یک IP (از همهٔ شناسه‌ها) برای تشدید به کپچا */
    RATE_LIMIT_LOGIN_MAX: intFromText(200).pipe(z.number().int().min(1).max(100_000)),
    RATE_LIMIT_LOGIN_WINDOW_SECONDS: intFromText(900).pipe(z.number().int().min(10).max(86_400)),
    /** محدودیت عملیات نوشتنی حساس (رزرو، لغو، شارژ، برداشت) بر اساس IP */
    RATE_LIMIT_WRITE_MAX: intFromText(60).pipe(z.number().int().min(1).max(1_000_000)),
    RATE_LIMIT_WRITE_WINDOW_SECONDS: intFromText(300).pipe(z.number().int().min(1).max(86_400)),
    /** محدودیت اسکن تحویل (اپراتور سلف با دستگاه موبایل) */
    RATE_LIMIT_SCAN_MAX: intFromText(240).pipe(z.number().int().min(1).max(1_000_000)),
    RATE_LIMIT_DEFAULT_MAX: intFromText(300).pipe(z.number().int().min(1).max(1_000_000)),
    RATE_LIMIT_DEFAULT_WINDOW_SECONDS: intFromText(60).pipe(z.number().int().min(1).max(86_400)),

    SERVE_STATIC: boolFromText(false),
    WEB_DIST_PATH: z.string().optional(),

    ALLOW_DEMO_SEED: boolFromText(false),
    TEST_DATABASE_URL: z.string().optional(),
    TEST_PG_PORT: intFromText(55432).pipe(z.number().int().min(1024).max(65535)),
  })
  .superRefine((env, ctx) => {
    const isProd = env.NODE_ENV === 'production';

    if (isProd) {
      if (!env.PUBLIC_BASE_URL) {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'در production تنظیم PUBLIC_BASE_URL الزامی است.' });
      } else if (!/^https:\/\//.test(env.PUBLIC_BASE_URL)) {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'PUBLIC_BASE_URL باید https باشد.' });
      }
      if (env.SESSION_COOKIE_NAME !== '__Host-sid') {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_NAME'],
          message: 'در production نام کوکی نشست باید __Host-sid باشد.',
        });
      }
      if (env.ALLOW_SANDBOX_GATEWAY) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOW_SANDBOX_GATEWAY'],
          message: 'درگاه sandbox در production ممنوع است.',
        });
      }
      if (env.ALLOW_DEMO_SEED) {
        ctx.addIssue({ code: 'custom', path: ['ALLOW_DEMO_SEED'], message: 'دادهٔ نمونه در production ممنوع است.' });
      }
      if (env.HOST !== '127.0.0.1' && env.HOST !== 'localhost' && env.HOST !== '::1') {
        ctx.addIssue({
          code: 'custom',
          path: ['HOST'],
          message: 'API باید فقط به لوپ‌بک بایند شود؛ دسترسی بیرونی از طریق nginx است.',
        });
      }
    }

    if (env.ONLINE_PAYMENT_ENABLED) {
      if (!env.ZARINPAL_MERCHANT_ID && !env.ALLOW_SANDBOX_GATEWAY) {
        ctx.addIssue({
          code: 'custom',
          path: ['ZARINPAL_MERCHANT_ID'],
          message: 'پرداخت اینترنتی فعال است اما ZARINPAL_MERCHANT_ID تنظیم نشده است.',
        });
      }
      if (!isProd && !env.ZARINPAL_MERCHANT_ID && !env.ALLOW_SANDBOX_GATEWAY) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOW_SANDBOX_GATEWAY'],
          message: 'برای فعال‌کردن پرداخت بدون merchant واقعی، ALLOW_SANDBOX_GATEWAY=true لازم است.',
        });
      }
    }

    if (env.SMS_PROVIDER === 'kavenegar' && !env.KAVENEGAR_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['KAVENEGAR_API_KEY'], message: 'SMS_PROVIDER=kavenegar بدون کلید API مجاز نیست.' });
    }
  });

export type AppEnv = z.output<typeof envSchema>;

/** خواندن و اعتبارسنجی env؛ در صورت خطا فهرست مشکلات را برمی‌گرداند. */
export function readEnv(raw: NodeJS.ProcessEnv = process.env): { ok: true; env: AppEnv } | { ok: false; issues: string[] } {
  const parsed = envSchema.safeParse({ ...raw });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
    return { ok: false, issues };
  }
  return { ok: true, env: parsed.data };
}

let cached: AppEnv | null = null;

/** env اعتبارسنجی‌شدهٔ فرآیند (یک بار بارگذاری می‌شود). */
export function getEnv(): AppEnv {
  if (cached) return cached;
  const result = readEnv();
  if (!result.ok) {
    throw new Error(`پیکربندی محیط نامعتبر است:\n- ${result.issues.join('\n- ')}`);
  }
  cached = result.env;
  return cached;
}

/** فقط برای تست: کش env را پاک می‌کند. */
export function resetEnvCache(): void {
  cached = null;
}

/** مقدار تستی کامل env (بدون secret واقعی) برای تست‌های یکپارچه. */
export function testEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3001',
    LOG_LEVEL: 'silent',
    TRUSTED_PROXY_HOPS: '0',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:55432/food_test',
    CSRF_SECRET: 'test-csrf-secret-0123456789abcdef0123456789abcdef',
    NATIONAL_ID_PEPPER: 'test-national-id-pepper-0123456789abcdef',
    DATA_ENCRYPTION_KEY: 'a'.repeat(64),
    SESSION_COOKIE_NAME: 'sid',
    RATE_LIMIT_LOGIN_ROUTE_MAX: '1000000',
    RATE_LIMIT_WRITE_MAX: '1000000',
    RATE_LIMIT_DEFAULT_MAX: '1000000',
    RATE_LIMIT_WRITE_WINDOW_SECONDS: '300',
    RATE_LIMIT_SCAN_MAX: '1000000',
    SMS_PROVIDER: 'console',
    ONLINE_PAYMENT_ENABLED: 'false',
    ALLOW_SANDBOX_GATEWAY: 'false',
    ...overrides,
  };
}
