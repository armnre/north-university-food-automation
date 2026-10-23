import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { handleGatewayCallback, sanitizeReturnTo, sandboxRedirectHtml } from '../services/payment.service.js';
import { getSettings } from '../services/settings.service.js';
import type { ServiceDeps } from '../types.js';

/**
 * درگاه پرداخت.
 *  - `GET /payments/zarinpal/callback` : بازگشت از درگاه (verify سمت سرور، idempotent)
 *  - `GET /payments/sandbox/redirect`  : فقط در محیط غیر production با پرچم sandbox
 *  - `GET /payments/status`            : وضعیت فعال بودن پرداخت برای UI
 */
export function paymentRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/zarinpal/callback',
      {
        schema: {
          querystring: z.object({
            Authority: z.string().max(200).optional(),
            authority: z.string().max(200).optional(),
            Status: z.string().max(10).optional(),
            status: z.string().max(10).optional(),
            paymentId: z.string().uuid().optional(),
          }),
          response: { 200: z.string() },
          tags: ['payments'],
          summary: 'بازگشت از درگاه زرین‌پال',
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

        const returnTo = sanitizeReturnTo(result.returnTo);
        const ok = result.status === 'paid';
        const message =
          result.status === 'paid'
            ? `شارژ کیف پول با موفقیت انجام شد. کد رهگیری: ${result.trackingCode}${result.replay ? ' (این پیام قبلاً هم نمایش داده شده است)' : ''}`
            : result.status === 'needs_review'
              ? 'پرداخت شما در حال بررسی است. در صورت عدم شارژ، با امور مالی تماس بگیرید.'
              : 'پرداخت ناموفق بود یا تکمیل نشد؛ مبلغی از حساب شما کسر نشده است.';

        void reply.type('text/html; charset=utf-8');
        return callbackHtml({ ok, message, returnTo });
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
        const merchantConfigured = Boolean(deps.env.ZARINPAL_MERCHANT_ID);
        const sandbox = !merchantConfigured && deps.env.ALLOW_SANDBOX_GATEWAY && deps.env.NODE_ENV !== 'production';
        const enabled = settings.onlinePaymentEnabled && (merchantConfigured || sandbox);
        return {
          enabled,
          gateway: merchantConfigured ? 'zarinpal' : sandbox ? 'sandbox' : 'none',
          minPayableRial: settings.minGatewayPayableRial,
          message: enabled ? 'پرداخت اینترنتی فعال است.' : 'درگاه پرداخت اینترنتی در حال حاضر فعال نیست.',
        };
      },
    );
  };
}

/** صفحهٔ بازگشت از درگاه: بدون script (سازگار با CSP سخت‌گیرانه) و با ریدایرکت داخلی. */
function callbackHtml(input: { ok: boolean; message: string; returnTo: string }): string {
  const safeMessage = escapeHtml(input.message);
  const safeReturn = escapeHtml(input.returnTo);
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="4;url=${safeReturn}">
<title>نتیجهٔ پرداخت</title>
</head>
<body>
<h1>${input.ok ? 'پرداخت موفق' : 'پرداخت ناموفق / در حال بررسی'}</h1>
<p>${safeMessage}</p>
<p><a href="${safeReturn}">بازگشت به سامانه</a></p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
