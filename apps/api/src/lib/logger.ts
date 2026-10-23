import pino, { type Logger } from 'pino';
import type { AppEnv } from '../config/env.js';

/**
 * لاگ ساختاریافته با pino.
 *
 * قاعدهٔ امنیتی: هیچ دادهٔ حساسی (کد ملی خام، رمز، توکن نشست، شبا، کوکی)
 * لاگ نمی‌شود. مسیرهای زیر به‌صورت خودکار redact می‌شوند و تست واحد
 * `no-sensitive-data-in-logs` این فهرست را بررسی می‌کند.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-forwarded-for"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.nationalId',
  '*.nationalIdHash',
  '*.iban',
  '*.ibanEncrypted',
  '*.token',
  '*.qrToken',
  '*.setupCode',
  '*.csrfToken',
  '*.answerHash',
  '*.passwordHash',
  '*.DATABASE_URL',
  '*.NATIONAL_ID_PEPPER',
  '*.DATA_ENCRYPTION_KEY',
  '*.CSRF_SECRET',
  '*.SETUP_CODE',
  '*.KAVENEGAR_API_KEY',
  '*.ZARINPAL_MERCHANT_ID',
];

export function createLogger(env: AppEnv, name = 'food-api'): Logger {
  return pino({
    name,
    level: env.LOG_LEVEL,
    base: { env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // در توسعه می‌توان با LOG_PRETTY=1 خروجی خوانا گرفت (وابستگی dev: pino-pretty)
    transport:
      env.NODE_ENV === 'development' && process.env.LOG_PRETTY === '1'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
  });
}

/** لاگر بی‌صدا برای تست‌ها. */
export function createSilentLogger(name = 'food-test'): Logger {
  return pino({ name, level: 'silent' });
}
