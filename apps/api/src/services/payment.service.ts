import { sql } from 'drizzle-orm';
import { payments } from '../db/schema/index.js';
import { AppError, fail } from '../lib/errors.js';
import { randomHex } from '../lib/crypto.js';
import type { ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { postLedger } from './ledger.service.js';
import { getAccountHolder } from './account.service.js';
import { alertSuperAdmins, createNotification, employeeMobile, queueSms } from './notification.service.js';
import { rawSql } from '../db/raw.js';

/**
 * پرداخت آنلاین (زرین‌پال پشت Feature Flag).
 *
 * قواعد:
 *  - تا وقتی `online_payment_enabled=false` یا merchant تنظیم نشده، شارژ آنلاین
 *    غیرفعال است و شارژ فقط دستی توسط امور مالی انجام می‌شود.
 *  - adapter sandbox **فقط** وقتی `NODE_ENV !== 'production'` و
 *    `ALLOW_SANDBOX_GATEWAY=true` مجاز است (اعتبارسنجی env در startup).
 *  - callback سمت سرور verify می‌شود، **idempotent** است (تکراری/هم‌زمان = یک واریز)،
 *    مبلغ تطبیق می‌شود و اگر verify موفق ولی ثبت دفتر کل خطا بدهد ⇒ `NeedsReview`
 *    + هشدار به مدیر ارشد (نه «ناموفق» بی‌صدا).
 */

export type GatewayRequestResult = { redirectUrl: string; authority: string };
export type GatewayVerifyResult = { ok: boolean; refId?: string; amountRial?: number; message?: string };

export interface PaymentGateway {
  readonly name: string;
  request(input: { amountRial: number; returnUrl: string; description: string; orderId: string }): Promise<GatewayRequestResult>;
  verify(input: { authority: string; status: string; amountRial: number }): Promise<GatewayVerifyResult>;
}

/** adapter زرین‌پال (merchant از env). */
export function createZarinpalGateway(merchantId: string, baseUrl = 'https://api.zarinpal.com/pg/v4/payment'): PaymentGateway {
  return {
    name: 'zarinpal',
    async request({ amountRial, returnUrl, description }) {
      const response = await fetch(`${baseUrl}/request.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          merchant_id: merchantId,
          // زرین‌پال مبلغ را به تومان می‌گیرد
          amount: Math.trunc(amountRial / 10),
          callback_url: returnUrl,
          description,
          metadata: {},
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as {
        data?: { code: number; message: string; authority?: string; fee_type?: string };
        errors?: { code: number; message: string };
      };
      const authority = payload.data?.authority;
      if (!response.ok || !authority || payload.data?.code !== 100) {
        throw new AppError('PAYMENT_NEEDS_REVIEW', 'ارتباط با درگاه پرداخت برقرار نشد. دوباره تلاش کنید یا با امور مالی تماس بگیرید.');
      }
      return { redirectUrl: `https://www.zarinpal.com/pg/StartPay/${authority}`, authority };
    },
    async verify({ authority, status, amountRial }) {
      if (status !== 'OK') return { ok: false, message: 'پرداخت توسط کاربر تکمیل نشد.' };
      const response = await fetch(`${baseUrl}/verify.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ merchant_id: merchantId, amount: Math.trunc(amountRial / 10), authority }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as {
        data?: { code: number; message: string; ref_id?: number };
        errors?: { message: string };
      };
      const code = payload.data?.code;
      if (code === 100 || code === 101) {
        return { ok: true, refId: String(payload.data?.ref_id ?? ''), amountRial };
      }
      return { ok: false, message: payload.data?.message ?? payload.errors?.message ?? 'تأیید پرداخت ناموفق بود.' };
    },
  };
}

/**
 * adapter sandbox — فقط برای توسعه/تست.
 * در production با `ALLOW_SANDBOX_GATEWAY=true` اپلیکیشن بالا نمی‌آید (اعتبارسنجی env).
 */
export function createSandboxGateway(): PaymentGateway {
  return {
    name: 'sandbox',
    async request({ amountRial }) {
      const authority = `sandbox_${randomHex(8)}`;
      return { redirectUrl: `/api/v1/payments/sandbox/redirect?authority=${authority}&amount=${amountRial}`, authority };
    },
    async verify({ status, amountRial }) {
      return { ok: status === 'OK', refId: `sandbox_ref_${randomHex(6)}`, amountRial };
    },
  };
}

export function resolveGateway(deps: ServiceDeps): PaymentGateway | null {
  if (!deps.env.ONLINE_PAYMENT_ENABLED) return null;
  if (deps.env.ZARINPAL_MERCHANT_ID) return createZarinpalGateway(deps.env.ZARINPAL_MERCHANT_ID);
  if (deps.env.ALLOW_SANDBOX_GATEWAY && deps.env.NODE_ENV !== 'production') return createSandboxGateway();
  return null;
}

/** فقط مسیرهای داخلی مجازند (جلوگیری از open redirect). */
export function sanitizeReturnTo(value: string | undefined): string {
  const path = String(value ?? '/wallet');
  if (!path.startsWith('/') || path.startsWith('//')) return '/wallet';
  if (/^\/[a-zA-Z0-9/_?=&.%-]*$/.test(path) === false) return '/wallet';
  if (/https?:|javascript:|data:/i.test(path)) return '/wallet';
  return path.slice(0, 200);
}

export type CallbackResult =
  | { status: 'paid'; trackingCode: string; amountRial: number; returnTo: string; replay: boolean }
  | { status: 'failed'; message: string; returnTo: string }
  | { status: 'needs_review'; message: string; returnTo: string };

/**
 * پردازش callback درگاه: verify سمت سرور، تطبیق مبلغ و ثبت دفتر کل — idempotent.
 * دو callback هم‌زمان با قفل ردیف `payments` سریال می‌شوند ⇒ فقط یک واریز.
 */
export async function handleGatewayCallback(
  deps: ServiceDeps,
  input: { paymentId?: string; authority?: string; status: string; ip: string },
): Promise<CallbackResult> {
  const gateway = resolveGateway(deps);

  const result = await deps.db.transaction(async (tx) => {
    const rows = input.paymentId
      ? await tx.execute(rawSql(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [input.paymentId]))
      : await tx.execute(rawSql(`SELECT * FROM payments WHERE authority = $1 FOR UPDATE`, [input.authority ?? '']));
    const payment = ((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
    if (!payment) fail('NOT_FOUND', 'پرداخت یافت نشد.');

    const paymentId = String(payment.id);
    const amount = Number(String(payment.amount_rial ?? '0'));
    const status = String(payment.status);
    const returnTo = sanitizeReturnTo(String(payment.return_to ?? '/wallet'));
    const accountId = String(payment.account_id);

    await tx
      .update(payments)
      .set({ callbackCount: sql`${payments.callbackCount} + 1` })
      .where(sql`${payments.id} = ${paymentId}`);

    if (status === 'Paid') {
      // callback تکراری ⇒ همان نتیجهٔ قبلی، بدون واریز دوم
      const existing = await tx.execute(
        rawSql(`SELECT tracking_code FROM ledger_transactions WHERE idempotency_key = $1 LIMIT 1`, [`online-payment:${paymentId}`]),
      );
      const trackingCode = String(((existing as unknown as { rows: { tracking_code: string }[] }).rows ?? [])[0]?.tracking_code ?? '');
      return {
        status: 'paid' as const,
        trackingCode,
        amountRial: amount,
        returnTo,
        replay: true,
        paymentId,
        accountId,
      };
    }
    if (status === 'NeedsReview') {
      return {
        status: 'needs_review' as const,
        message: 'این پرداخت در حال بررسی است.',
        returnTo,
        paymentId,
        accountId,
        amountRial: amount,
      };
    }
    if (status === 'Failed') {
      return {
        status: 'failed' as const,
        message: 'این پرداخت پیش‌تر ناموفق ثبت شده است.',
        returnTo,
        paymentId,
        accountId,
        amountRial: amount,
      };
    }

    if (!gateway) {
      await tx
        .update(payments)
        .set({ status: 'Failed', lastError: 'gateway_disabled' })
        .where(sql`${payments.id} = ${paymentId}`);
      return { status: 'failed' as const, message: 'درگاه پرداخت غیرفعال است.', returnTo, paymentId, accountId, amountRial: amount };
    }

    const verification = await gateway.verify({
      authority: String(payment.authority ?? ''),
      status: input.status,
      amountRial: amount,
    });

    if (!verification.ok) {
      await tx
        .update(payments)
        .set({ status: 'Failed', lastError: (verification.message ?? 'verify_failed').slice(0, 200) })
        .where(sql`${payments.id} = ${paymentId}`);
      await writeAudit(tx, {
        actor: { type: 'Gateway', id: paymentId, label: gateway.name },
        action: 'payment.failed',
        targetType: 'Payment',
        targetId: paymentId,
        details: { amountRial: amount },
        ip: input.ip,
      });
      return {
        status: 'failed' as const,
        message: 'پرداخت تأیید نشد؛ مبلغی از حساب شما کسر نشده است.',
        returnTo,
        paymentId,
        accountId,
        amountRial: amount,
      };
    }

    // تطبیق مبلغ: اگر درگاه مبلغ متفاوتی گزارش کند ⇒ NeedsReview (واریز انجام نمی‌شود)
    if (verification.amountRial != null && Number(verification.amountRial) !== amount) {
      await tx
        .update(payments)
        .set({ status: 'NeedsReview', lastError: 'amount_mismatch' })
        .where(sql`${payments.id} = ${paymentId}`);
      await writeAudit(tx, {
        actor: { type: 'Gateway', id: paymentId, label: gateway.name },
        action: 'payment.needs_review',
        targetType: 'Payment',
        targetId: paymentId,
        details: { expectedRial: amount, reportedRial: Number(verification.amountRial) },
        ip: input.ip,
      });
      return {
        status: 'needs_review' as const,
        message: 'مبلغ گزارش‌شده توسط درگاه با مبلغ درخواست مطابقت ندارد؛ در حال بررسی است.',
        returnTo,
        paymentId,
        accountId,
        amountRial: amount,
      };
    }

    await tx
      .update(payments)
      .set({ status: 'Paid', refId: (verification.refId ?? '').slice(0, 120), verifiedAt: new Date() })
      .where(sql`${payments.id} = ${paymentId} AND ${payments.status} = 'Pending'`);

    return { status: 'paid_pending_ledger' as const, paymentId, accountId, amountRial: amount, returnTo, refId: verification.refId ?? '' };
  });

  if (result.status === 'paid') {
    return {
      status: 'paid',
      trackingCode: result.trackingCode,
      amountRial: result.amountRial,
      returnTo: result.returnTo,
      replay: result.replay,
    };
  }
  if (result.status === 'needs_review') {
    return { status: 'needs_review', message: result.message, returnTo: result.returnTo };
  }
  if (result.status === 'failed') {
    return { status: 'failed', message: result.message, returnTo: result.returnTo };
  }

  // ثبت دفتر کل پس از commit وضعیت پرداخت؛ اگر خطا دهد ⇒ NeedsReview + هشدار مدیر ارشد
  try {
    const posted = await deps.db.transaction(async (tx) => {
      const ledger = await postLedger(tx, deps, {
        type: 'OnlinePayment',
        idempotencyKey: `online-payment:${result.paymentId}`,
        reason: 'شارژ کیف پول از طریق درگاه پرداخت',
        actor: { type: 'Gateway', id: result.paymentId, label: 'zarinpal' },
        referenceType: 'Payment',
        referenceId: result.paymentId,
        legs: [
          { accountId: result.accountId, amountRial: result.amountRial },
          { systemAccount: 'GATEWAY_CLEARING', amountRial: -result.amountRial },
        ],
      });

      const tracking = await tx.execute(rawSql(`SELECT tracking_code FROM ledger_transactions WHERE id = $1`, [ledger.transactionId]));
      const trackingCode = String(((tracking as unknown as { rows: { tracking_code: string }[] }).rows ?? [])[0]?.tracking_code ?? '');

      await writeAudit(tx, {
        actor: { type: 'Gateway', id: result.paymentId, label: 'zarinpal' },
        action: 'payment.paid',
        targetType: 'Payment',
        targetId: result.paymentId,
        details: { amountRial: result.amountRial, trackingCode },
        ip: input.ip,
      });

      await createNotification(tx, {
        title: 'شارژ کیف پول موفق',
        body: `مبلغ ${result.amountRial / 10} تومان به کیف پول شما اضافه شد. کد رهگیری: ${trackingCode}`,
        audience: 'Account',
        accountId: result.accountId,
        event: 'wallet.topped_up',
      });

      return { trackingCode, replay: ledger.replay };
    });

    const holder = await getAccountHolder(deps.db, result.accountId);
    if (holder?.kind === 'Employee') {
      const mobile = await employeeMobile(deps.db, holder.holderId);
      await queueSms(deps.db, {
        recipient: mobile,
        message: `کیف پول شما به مبلغ ${result.amountRial / 10} تومان شارژ شد.`,
        accountId: result.accountId,
      });
    }

    return {
      status: 'paid',
      trackingCode: posted.trackingCode,
      amountRial: result.amountRial,
      returnTo: result.returnTo,
      replay: posted.replay,
    };
  } catch (error) {
    await deps.db
      .update(payments)
      .set({ status: 'NeedsReview', lastError: 'ledger_post_failed' })
      .where(sql`${payments.id} = ${result.paymentId}`);
    await alertSuperAdmins(deps, {
      title: 'پرداخت نیازمند بررسی',
      body: `پرداخت ${result.paymentId} توسط درگاه تأیید شد اما ثبت دفتر کل ناموفق بود. وضعیت به «نیازمند بررسی» تغییر کرد.`,
      event: 'system.alert',
    });
    deps.log.error({ err: error, paymentId: result.paymentId }, 'ثبت دفتر کل پس از verify موفق ناموفق بود');
    return {
      status: 'needs_review',
      message: 'پرداخت شما تأیید شد اما ثبت آن در کیف پول در حال بررسی است. در صورت عدم شارژ، با امور مالی تماس بگیرید.',
      returnTo: result.returnTo,
    };
  }
}

/** استعلام پرداخت‌های Pending قدیمی (job `payments-reconcile`). */
export async function reconcilePendingPayments(
  deps: ServiceDeps,
  olderThanMinutes = 10,
): Promise<{ checked: number; markedFailed: number }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const rows = await deps.db
    .select({ id: payments.id, authority: payments.authority, amountRial: payments.amountRial })
    .from(payments)
    .where(sql`${payments.status} = 'Pending' AND ${payments.createdAt} < ${cutoff}`)
    .limit(100);

  let markedFailed = 0;
  for (const row of rows) {
    await deps.db
      .update(payments)
      .set({ status: 'Failed', lastError: 'timed_out_pending' })
      .where(sql`${payments.id} = ${row.id} AND ${payments.status} = 'Pending'`);
    markedFailed += 1;
    await writeAudit(deps.db, {
      actor: { type: 'System', id: '', label: 'worker' },
      action: 'payment.reconcile_timeout',
      targetType: 'Payment',
      targetId: row.id,
      details: { amountRial: Number(row.amountRial) },
    });
  }
  return { checked: rows.length, markedFailed };
}

/** صفحهٔ sandbox برای توسعه: شبیه‌سازی بازگشت از درگاه. */
export function sandboxRedirectHtml(deps: ServiceDeps, authority: string, amountRial: number): string {
  if (deps.env.NODE_ENV === 'production' || !deps.env.ALLOW_SANDBOX_GATEWAY) {
    throw new AppError('FORBIDDEN', 'درگاه آزمایشی در این محیط غیرفعال است.');
  }
  const callback = `/api/v1/payments/zarinpal/callback?authority=${encodeURIComponent(authority)}`;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>درگاه آزمایشی</title></head>
<body style="font-family:Tahoma,sans-serif;text-align:center;padding:40px">
<h2>درگاه پرداخت آزمایشی</h2>
<p>مبلغ: ${amountRial / 10} تومان</p>
<p><a href="${callback}&Status=OK">پرداخت موفق (بازگشت)</a></p>
<p><a href="${callback}&Status=NOK">پرداخت ناموفق (بازگشت)</a></p>
</body></html>`;
}
