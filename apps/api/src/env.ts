import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3101),
    PUBLIC_BASE_URL: z.string().url(),
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    NATIONAL_ID_PEPPER: z.string().min(32),
    CSRF_SECRET: z.string().min(32),
    SETUP_CODE: z.string().min(16).optional(),
    UPLOAD_DIR: z.string().min(1),
    WEB_DIST_PATH: z.string().optional(),
    BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .default(6 * 1024 * 1024),
    ONLINE_PAYMENT_ENABLED: bool,
    ZARINPAL_MERCHANT_ID: z.string().optional(),
    ALLOW_SANDBOX_GATEWAY: bool,
    SMS_PROVIDER: z.enum(['console', 'kavenegar']).default('console'),
    KAVENEGAR_API_KEY: z.string().optional(),
    KAVENEGAR_SENDER: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production') {
      if (e.ALLOW_SANDBOX_GATEWAY) ctx.addIssue({ code: 'custom', path: ['ALLOW_SANDBOX_GATEWAY'], message: 'sandbox gateway is forbidden in production' });
      if (e.ONLINE_PAYMENT_ENABLED && !e.ZARINPAL_MERCHANT_ID)
        ctx.addIssue({ code: 'custom', path: ['ZARINPAL_MERCHANT_ID'], message: 'required when ONLINE_PAYMENT_ENABLED=true' });
      if (e.SMS_PROVIDER === 'kavenegar' && !e.KAVENEGAR_API_KEY)
        ctx.addIssue({ code: 'custom', path: ['KAVENEGAR_API_KEY'], message: 'required for kavenegar' });
      if (!e.PUBLIC_BASE_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'must be https in production' });
    }
  });

export type Env = z.infer<typeof schema>;

/** Parses env at startup; a missing/invalid key aborts boot. Values are never printed. */
export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(src);
  if (!r.success) {
    const keys = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${keys}`);
  }
  return r.data;
}
