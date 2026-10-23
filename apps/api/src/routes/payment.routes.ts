import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  checkoutStartRequestSchema,
  checkoutStartResponseSchema,
  paymentResultRequestSchema,
  paymentResultResponseSchema,
} from '@food/shared';
import {
  getPaymentResult,
  handleGatewayCallback,
  resolveGateway,
  sandboxRedirectHtml,
  startCheckout,
} from '../services/payment.service.js';
import { getSettings } from '../services/settings.service.js';
import type { CustomerAuth, ServiceDeps } from '../types.js';

/**
 * درگاه پرداخت مستقیم رزرو غذا:
 *  - `POST /payments/checkout/start`   : شروع تسویهٔ سبد (کسر خودکار اعتبار + رزرو فوری یا انتقال به درگاه)
 *  - `GET /payments/zarinpal/callback` : بازگشت عمومی از درگاه (verify سمت سرور حتی در Status!=OK، idempotent)
 *  - `POST /payments/result`           : دریافت رسید کامل پرداخت با کنترل مالکیت حساب
 *  - `GET /payments/sandbox/redirect`  : درگاه آزمایشی (فقط محیط غیر production)
 *  - `GET /payments/status`            : وضعیت فعال بودن پرداخت اینترنتی برای UI
 */
export function paymentRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/checkout/start',
      {
        schema: {
          body: checkoutStartRequestSchema,
          response: { 200: checkoutStartResponseSchema },
          tags: ['payments'],
          summary: 'شروع تسویهٔ سبد رزرو غذا (کسر خودکار اعتبار قبلی + پرداخت مستقیم درگاه)',
        },
        preValidation: app.requireCustomer,
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 30), timeWindow: '5 minutes' } },
      },
      async (request) => {
        const auth = request.auth as CustomerAuth;
        return startCheckout(deps, {
          auth,
          items: request.body.items,
          idempotencyKey: request.body.idempotencyKey,
          ip: request.clientIp,
          userAgent: request.headers['user-agent'],
        });
      },
    );

    app.get(
      '/zarinpal/callback',
      {
        schema: {
          querystring: z.object({
            Authority: z.string().max(200).optional(),
            authority: z.string().max(200).optional(),
            Status: z.string().max(20).optional(),
            status: z.string().max(20).optional(),
            paymentId: z.string().uuid().optional(),
          }),
          response: { 200: z.string(), 303: z.string() },
          tags: ['payments'],
          summary: 'بازگشت از درگاه زرین‌پال (عمومی، بدون وابستگی به کوکی نشست)',
        },
        config: { rateLimit: false },
      },
      async (request, reply) => {
        const query = request.query;
        const status = (query.Status ?? query.status ?? 'NOK').toUpperCase();
        const result = await handleGatewayCallback(deps, {
          paymentId: query.paymentId,
          authority: query.Authority ?? query.authority,
          status,
          ip: request.clientIp,
        });

        const targetUrl = `/payment/result?paymentId=${encodeURIComponent(result.paymentId)}`;
        const ok = result.status === 'paid';
        const message =
          result.status === 'paid'
            ? result.failed === 0
              ? `پرداخت و رزرو ${result.succeeded} وعده با موفقیت انجام شد. کد رهگیری: ${result.trackingCode}`
              : `پرداخت تأیید شد (${result.trackingCode})؛ ${result.succeeded} وعده رزرو شد و بابت ${result.failed} آیتم ناموفق اعتبار به کیف پول منتقل گردید.`
            : result.status === 'needs_review'
              ? result.message
              : result.message;

        void reply.status(303).header('location', targetUrl).type('text/html; charset=utf-8');
        return callbackHtml({ ok, status: result.status, message, returnTo: targetUrl });
      },
    );

    app.post(
      '/result',
      {
        schema: {
          body: paymentResultRequestSchema,
          response: { 200: paymentResultResponseSchema },
          tags: ['payments'],
          summary: 'دریافت رسید و نتیجهٔ پرداخت کاربر جاری',
        },
        preValidation: app.requireCustomer,
      },
      async (request) => {
        const auth = request.auth as CustomerAuth;
        return getPaymentResult(deps, { auth, paymentId: request.body.paymentId });
      },
    );

    app.get(
      '/sandbox/redirect',
      {
        schema: {
          querystring: z.object({ authority: z.string().max(200), amount: z.coerce.number().int().min(0).max(500_000_000).default(0) }),
          response: { 200: z.string() },
          tags: ['payments'],
          summary: 'درگاه آزمایشی (فقط محیط غیر production)',
        },
        config: { rateLimit: false },
      },
      async (request, reply) => {
        void reply.type('text/html; charset=utf-8');
        return sandboxRedirectHtml(deps, request.query.authority, request.query.amount);
      },
    );

    app.get(
      '/status',
      {
        schema: {
          response: {
            200: z.object({
              enabled: z.boolean(),
              gateway: z.string(),
              minPayableRial: z.number().int(),
              message: z.string(),
            }),
          },
          tags: ['payments'],
          summary: 'وضعیت پرداخت آنلاین برای UI',
        },
        config: { rateLimit: false },
      },
      async () => {
        const settings = await getSettings(deps);
        const gateway = settings.onlinePaymentEnabled ? resolveGateway(deps) : null;
        const enabled = Boolean(gateway);
        return {
          enabled,
          gateway: gateway ? gateway.name : 'none',
          minPayableRial: Math.max(settings.minGatewayPayableRial, 10_000),
          message: enabled ? 'پرداخت مستقیم از درگاه بانکی فعال است.' : 'درگاه پرداخت اینترنتی در حال حاضر فعال نیست.',
        };
      },
    );
  };
}

/** صفحهٔ بازگشت از درگاه: بدون script (سازگار با CSP سخت‌گیرانه) به همراه هدایت فوری ۳۰۳. */
function callbackHtml(input: { ok: boolean; status: 'paid' | 'failed' | 'needs_review'; message: string; returnTo: string }): string {
  const safeMessage = escapeHtml(input.message);
  const safeReturn = escapeHtml(input.returnTo);
  const title = input.ok ? 'پرداخت موفق' : input.status === 'needs_review' ? 'در حال بررسی پرداخت' : 'پرداخت ناموفق';
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="1;url=${safeReturn}">
<title>${title}</title>
</head>
<body>
<h1>${title}</h1>
<p>${safeMessage}</p>
<p><a href="${safeReturn}">مشاهدهٔ رسید پرداخت</a></p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
