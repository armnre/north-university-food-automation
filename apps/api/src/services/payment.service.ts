import { eq, sql } from 'drizzle-orm';
import {
  payments,
  reservations,
  type PaymentCartItem,
  type PaymentSettlementItemResult,
  type PaymentSettlementResult,
} from '../db/schema/index.js';
import { AppError, fail } from '../lib/errors.js';
import { randomHex } from '../lib/crypto.js';
import type { Actor, CustomerAuth, ServiceDeps, Tx } from '../types.js';
import { writeAudit } from './audit.service.js';
import { lockAccountsForUpdate, postLedger } from './ledger.service.js';
import { getSettings } from './settings.service.js';
import { assertAccountUsable, getAccountHolder } from './account.service.js';
import { alertFinanceAndAdmins, createNotification, employeeMobile, queueSms } from './notification.service.js';
import { reserveInLockedTx, validateOfferingForCheckout } from './reservation.service.js';
import { rawSql } from '../db/raw.js';

/**
 * پرداخت مستقیم درگاه برای سبد رزرو غذا (زرین‌پال v4 + درگاه آزمایشی غیراجرایی).
 *
 * اصول تغییرناپذیر:
 *  ۱) هیچ مسیر شارژ مستقیم کیف پول وجود ندارد؛ پرداخت فقط بابت سبد رزرو غذاست.
 *  ۲) اگر کاربر اعتبار بازگشتی قبلی در کیف پول داشته باشد، ابتدا به‌صورت خودکار کسر می‌شود؛
 *     اگر کل مبلغ پوشش داده شود (`payableRial === 0`)، رزرو بدون درگاه و اتمیک ثبت می‌شود.
 *  ۳) در بازگشت از درگاه (`callback`)، حتی اگر `Status !== 'OK'` باشد، پیش از ثبت `Failed`
 *     وضعیت واقعی با `verify` درگاه استعلام می‌شود.
 *  ۴) تسویهٔ پس از تأیید در یک تراکنش واحد PostgreSQL با قفل ردیف `payments` و `accounts`
 *     و `SAVEPOINT` مستقل برای هر آیتم انجام می‌شود: اگر آیتمی حین پرداخت ظرفیتش پر یا
 *     مهلتش تمام شده باشد، سهم پرداختیِ استفاده‌نشده در اعتبار داخلی کیف پول کاربر باقی می‌ماند.
 *  ۵) اگر درگاه پرداخت را تأیید کند ولی مرحلهٔ داخلی خطای غیرمنتظره بدهد، وضعیت پرداخت
 *     `NeedsReview` ثبت شده و به امور مالی و مدیر ارشد هشدار فوری ارسال می‌شود (هرگز ناموفق بی‌صدا نیست).
 */

export type GatewayRequestResult = { redirectUrl: string; authority: string };
export type GatewayVerifyResult = {
  ok: boolean;
  code?: number;
  refId?: string;
  amountRial?: number;
  alreadyVerified?: boolean;
  message?: string;
};

export interface PaymentGateway {
  readonly name: 'zarinpal' | 'sandbox';
  request(input: { amountRial: number; returnUrl: string; description: string; orderId: string }): Promise<GatewayRequestResult>;
  verify(input: { authority: string; status: string; amountRial: number }): Promise<GatewayVerifyResult>;
}

/** آداپتور رسمی زرین‌پال v4 با واحد صریح ریال (`currency: 'IRR'`). */
export function createZarinpalGateway(merchantId: string, baseUrl = 'https://api.zarinpal.com/pg/v4/payment'): PaymentGateway {
  return {
    name: 'zarinpal',
    async request({ amountRial, returnUrl, description, orderId }) {
      const response = await fetch(`${baseUrl}/request.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          merchant_id: merchantId,
          currency: 'IRR',
          amount: Math.trunc(amountRial),
          callback_url: returnUrl,
          description,
          metadata: { order_id: orderId },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as {
        data?: { code?: number; message?: string; authority?: string };
        errors?: { code?: number; message?: string };
      };
      const authority = payload.data?.authority;
      if (!response.ok || !authority || payload.data?.code !== 100) {
        throw new AppError('PAYMENT_NEEDS_REVIEW', 'ارتباط با درگاه پرداخت بانکی برقرار نشد. لطفاً لحظاتی بعد دوباره تلاش کنید.');
      }
      return { redirectUrl: `https://www.zarinpal.com/pg/StartPay/${authority}`, authority };
    },

    async verify({ authority, amountRial }) {
      if (!authority) {
        return { ok: false, code: -1, message: 'شناسهٔ ارجاع درگاه (Authority) یافت نشد.' };
      }
      // حتی اگر پارامتر کوئری Status!=OK باشد، برای اطمینان از عدم کسر وجه با زرین‌پال چک می‌کنیم.
      const response = await fetch(`${baseUrl}/verify.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          merchant_id: merchantId,
          amount: Math.trunc(amountRial),
          authority,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as {
        data?: { code?: number; message?: string; ref_id?: number | string };
        errors?: { code?: number; message?: string };
      };
      const code = payload.data?.code;
      if (code === 100 || code === 101) {
        return {
          ok: true,
          code,
          refId: String(payload.data?.ref_id ?? ''),
          amountRial: Math.trunc(amountRial),
          alreadyVerified: code === 101,
        };
      }
      return {
        ok: false,
        code: code ?? payload.errors?.code ?? -1,
        message: payload.data?.message ?? payload.errors?.message ?? 'تأیید پرداخت توسط درگاه انجام نشد.',
      };
    },
  };
}

/**
 * آداپتور آزمایشی (`sandbox`) — فقط در محیط غیر `production` و با `ALLOW_SANDBOX_GATEWAY=true`.
 */
export function createSandboxGateway(): PaymentGateway {
  return {
    name: 'sandbox',
    async request({ amountRial }) {
      const authority = `sandbox_${randomHex(8)}`;
      return { redirectUrl: `/api/v1/payments/sandbox/redirect?authority=${authority}&amount=${amountRial}`, authority };
    },
    async verify({ authority, status, amountRial }) {
      if (!authority) return { ok: false, code: -1, message: 'authority_missing' };
      const paid = status === 'OK' || authority.startsWith('sandbox_paid_');
      if (paid) {
        return { ok: true, code: 100, refId: `sbx_${authority.slice(-10)}`, amountRial };
      }
      return { ok: false, code: -51, message: 'پرداخت آزمایشی لغو شد یا ناموفق بود.' };
    },
  };
}

export function resolveGateway(deps: ServiceDeps): PaymentGateway | null {
  if ('gatewayOverride' in deps && deps.gatewayOverride !== undefined) {
    return deps.gatewayOverride ?? null;
  }
  if (!deps.env.ONLINE_PAYMENT_ENABLED) return null;
  if (deps.env.ZARINPAL_MERCHANT_ID) return createZarinpalGateway(deps.env.ZARINPAL_MERCHANT_ID);
  if (deps.env.ALLOW_SANDBOX_GATEWAY && deps.env.NODE_ENV !== 'production') return createSandboxGateway();
  return null;
}

/** فقط مسیرهای داخلی مجازند (جلوگیری از open redirect). */
export function sanitizeReturnTo(value: string | undefined, fallback = '/wallet'): string {
  const path = String(value ?? fallback);
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  if (/^\/[a-zA-Z0-9/_?=&.%-]*$/.test(path) === false) return fallback;
  if (/https?:|javascript:|data:/i.test(path)) return fallback;
  return path.slice(0, 200);
}

export type CheckoutStartResult = {
  mode: 'instant' | 'gateway';
  paymentId: string | null;
  redirectUrl: string | null;
  totalRial: number;
  creditUsedRial: number;
  payableRial: number;
  creditRemainingNote: string | null;
  items: PaymentSettlementItemResult[];
  balanceRial: number;
  replay: boolean;
  message: string;
};

/**
 * شروع فرآیند تسویه و رزرو سبد خرید:
 *  - اگر اعتبار کیف پول کل سبد را پوشش دهد ⇒ رزرو اتمیک فوری بدون رفتن به درگاه.
 *  - در غیر این صورت ⇒ کسر برنامه‌ریزی‌شدهٔ اعتبار قبلی + انتقال به درگاه برای مابه‌التفاوت.
 */
export async function startCheckout(
  deps: ServiceDeps,
  input: {
    auth: CustomerAuth;
    items: { offeringId: string }[];
    idempotencyKey: string;
    ip: string;
    userAgent?: string;
  },
): Promise<CheckoutStartResult> {
  const rawIds = input.items.map((i) => i.offeringId);
  if (rawIds.length === 0) fail('VALIDATION', 'سبد خرید خالی است.');
  const uniqueIds = [...new Set(rawIds)];
  if (uniqueIds.length !== rawIds.length) {
    fail('VALIDATION', 'امکان انتخاب تکراری یک غذا در یک سفارش وجود ندارد.');
  }

  const holder = assertAccountUsable(await getAccountHolder(deps.db, input.auth.accountId));
  const paymentIdemKey = `checkout:${holder.accountId}:${input.idempotencyKey}`;

  // بازپخش درخواست تکراری در حالت درگاه
  const existingPayment = await deps.db.select().from(payments).where(eq(payments.idempotencyKey, paymentIdemKey)).limit(1);
  if (existingPayment[0]) {
    const p = existingPayment[0];
    const redirectUrl =
      p.authority && p.gateway === 'zarinpal'
        ? `https://www.zarinpal.com/pg/StartPay/${p.authority}`
        : p.authority
          ? `/api/v1/payments/sandbox/redirect?authority=${p.authority}&amount=${Number(p.amountRial)}`
          : null;
    return {
      mode: 'gateway',
      paymentId: p.id,
      redirectUrl,
      totalRial: Number(p.totalRial),
      creditUsedRial: Number(p.creditUsedRial),
      payableRial: Number(p.amountRial),
      creditRemainingNote: null,
      items: p.resultJson?.items ?? [],
      balanceRial: holder.balanceRial,
      replay: true,
      message: 'درخواست پرداخت پیش‌تر ثبت شده است.',
    };
  }

  // بازپخش درخواست تکراری در حالت فوری (بدون درگاه)
  const firstInstantKey = `checkout-instant:${holder.accountId}:${input.idempotencyKey}:0:${uniqueIds[0]}`;
  const priorInstant = await deps.db.select().from(reservations).where(eq(reservations.idempotencyKey, firstInstantKey)).limit(1);
  if (priorInstant[0]) {
    const replayItems: PaymentSettlementItemResult[] = [];
    let total = 0;
    for (const [idx, offeringId] of uniqueIds.entries()) {
      const k = `checkout-instant:${holder.accountId}:${input.idempotencyKey}:${idx}:${offeringId}`;
      const r = (await deps.db.select().from(reservations).where(eq(reservations.idempotencyKey, k)).limit(1))[0];
      if (r) {
        total += Number(r.priceAtBooking);
        replayItems.push({
          offeringId,
          foodName: 'وعدهٔ رزروشده',
          serviceDate: r.serviceDate,
          mealSlotTitle: '',
          priceRial: Number(r.priceAtBooking),
          ok: true,
          reservationId: r.id,
          code: r.code,
          error: null,
          errorCode: null,
        });
      }
    }
    return {
      mode: 'instant',
      paymentId: null,
      redirectUrl: null,
      totalRial: total,
      creditUsedRial: total,
      payableRial: 0,
      creditRemainingNote: null,
      items: replayItems,
      balanceRial: holder.balanceRial,
      replay: true,
      message: 'این سفارش پیش‌تر با موفقیت ثبت شده است.',
    };
  }

  // اعتبارسنجی همهٔ آیتم‌های سبد پیش از هرگونه اقدام مالی
  const validatedItems: PaymentCartItem[] = [];
  for (const offeringId of uniqueIds) {
    const valid = await validateOfferingForCheckout(deps.db, {
      accountId: holder.accountId,
      customerGroup: holder.customerGroup,
      offeringId,
    });
    validatedItems.push({
      offeringId: valid.offeringId,
      priceAtStartRial: valid.priceRial,
      foodName: valid.foodName,
      serviceDate: valid.serviceDate,
      mealSlotTitle: valid.mealSlotTitle,
    });
  }

  const totalRial = validatedItems.reduce((sum, item) => sum + item.priceAtStartRial, 0);
  const actor: Actor =
    input.auth.kind === 'student'
      ? { type: 'Student', id: input.auth.studentId, label: input.auth.studentNumber }
      : { type: 'Employee', id: input.auth.employeeId, label: input.auth.username };

  // حالت ۱: اعتبار فعلی کل مبلغ را پوشش می‌دهد ⇒ رزرو اتمیک بدون درگاه
  if (holder.balanceRial >= totalRial) {
    return deps.db.transaction(async (tx) => {
      const locked = await lockAccountsForUpdate(tx, [holder.accountId]);
      const lockedAccount = locked.get(holder.accountId);
      if (!lockedAccount) fail('NOT_FOUND', 'حساب کیف پول یافت نشد.');
      const freshHolder = assertAccountUsable(await getAccountHolder(tx, holder.accountId));
      if (freshHolder.balanceRial < totalRial) {
        fail('INSUFFICIENT_BALANCE', 'موجودی اعتبار شما هم‌زمان تغییر کرده است؛ لطفاً دوباره اقدام کنید.');
      }

      const settledItems: PaymentSettlementItemResult[] = [];
      for (const [idx, item] of validatedItems.entries()) {
        const res = await reserveInLockedTx(tx, deps, {
          accountId: holder.accountId,
          customerGroup: freshHolder.customerGroup,
          actor,
          holderKind: freshHolder.kind,
          employeeId: freshHolder.kind === 'Employee' ? freshHolder.holderId : undefined,
          offeringId: item.offeringId,
          idemKey: `checkout-instant:${holder.accountId}:${input.idempotencyKey}:${idx}:${item.offeringId}`,
          expectedPriceRial: item.priceAtStartRial,
          note: 'رزرو با کسر خودکار از اعتبار کیف پول',
          ip: input.ip,
          userAgent: input.userAgent,
        });
        settledItems.push({
          offeringId: item.offeringId,
          foodName: item.foodName,
          serviceDate: item.serviceDate,
          mealSlotTitle: item.mealSlotTitle,
          priceRial: res.priceRial,
          ok: true,
          reservationId: res.reservationId,
          code: res.code,
          error: null,
          errorCode: null,
        });
      }

      const finalBalance = (await lockAccountsForUpdate(tx, [holder.accountId])).get(holder.accountId)?.balanceRial ?? 0;
      return {
        mode: 'instant' as const,
        paymentId: null,
        redirectUrl: null,
        totalRial,
        creditUsedRial: totalRial,
        payableRial: 0,
        creditRemainingNote: null,
        items: settledItems,
        balanceRial: finalBalance,
        replay: false,
        message: 'رزرو شما با استفاده از اعتبار کیف پول با موفقیت ثبت شد.',
      };
    });
  }

  // حالت ۲: نیاز به پرداخت از درگاه بانکی
  const settings = await getSettings(deps);
  const gateway = settings.onlinePaymentEnabled ? resolveGateway(deps) : null;
  if (!settings.onlinePaymentEnabled || !gateway) {
    throw new AppError(
      'PAYMENT_GATEWAY_DISABLED',
      'درگاه پرداخت اینترنتی در حال حاضر فعال نیست. لطفاً بعداً تلاش کنید یا با امور مالی تغذیه تماس بگیرید.',
    );
  }

  const minPayable = Math.max(settings.minGatewayPayableRial, 10_000);
  if (totalRial < minPayable) {
    fail(
      'VALIDATION',
      `حداقل مبلغ قابل پرداخت در درگاه بانکی ${(minPayable / 10).toLocaleString('fa-IR')} تومان (${minPayable.toLocaleString('fa-IR')} ریال) است.`,
    );
  }

  const rawPayable = totalRial - holder.balanceRial;
  let payableRial = rawPayable;
  let creditUsedRial = holder.balanceRial;
  let creditRemainingNote: string | null = null;

  if (rawPayable < minPayable) {
    payableRial = minPayable;
    creditUsedRial = totalRial - minPayable;
    const keptCredit = holder.balanceRial - creditUsedRial;
    creditRemainingNote = `به دلیل حداقل مبلغ تراکنش درگاه بانکی (${(minPayable / 10).toLocaleString('fa-IR')} تومان)، مبلغ ${(keptCredit / 10).toLocaleString('fa-IR')} تومان از اعتبار شما برای رزروهای بعدی در کیف پول باقی می‌ماند.`;
  }

  const base = deps.env.PUBLIC_BASE_URL || '';
  const callbackUrl = `${base}/api/v1/payments/zarinpal/callback`;

  const [payment] = await deps.db
    .insert(payments)
    .values({
      accountId: holder.accountId,
      gateway: gateway.name,
      amountRial: payableRial,
      totalRial,
      creditUsedRial,
      cartItems: validatedItems,
      status: 'Pending',
      idempotencyKey: paymentIdemKey,
      returnTo: '/payment/result',
      authority: null,
    })
    .returning({ id: payments.id });

  let redirectUrl: string;
  try {
    const requested = await gateway.request({
      amountRial: payableRial,
      returnUrl: `${callbackUrl}?paymentId=${payment!.id}`,
      description: `رزرو غذای دانشگاه شمال (${validatedItems.length} وعده)`,
      orderId: payment!.id,
    });
    redirectUrl = requested.redirectUrl;
    await deps.db
      .update(payments)
      .set({ authority: requested.authority })
      .where(sql`${payments.id} = ${payment!.id}`);
  } catch (error) {
    await deps.db
      .update(payments)
      .set({ status: 'Failed', lastError: 'gateway_request_failed' })
      .where(sql`${payments.id} = ${payment!.id}`);
    throw error instanceof AppError
      ? error
      : new AppError('PAYMENT_NEEDS_REVIEW', 'ارتباط با درگاه پرداخت بانکی برقرار نشد. لطفاً دوباره تلاش کنید.');
  }

  await writeAudit(deps.db, {
    actor,
    action: 'payment.checkout_start',
    targetType: 'Payment',
    targetId: payment!.id,
    details: {
      totalRial,
      creditUsedRial,
      payableRial,
      gateway: gateway.name,
      itemCount: validatedItems.length,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    mode: 'gateway',
    paymentId: payment!.id,
    redirectUrl,
    totalRial,
    creditUsedRial,
    payableRial,
    creditRemainingNote,
    items: [],
    balanceRial: holder.balanceRial,
    replay: false,
    message: 'در حال انتقال به درگاه پرداخت بانکی...',
  };
}

export type CallbackOutcome =
  | {
      status: 'paid';
      paymentId: string;
      trackingCode: string;
      amountRial: number;
      succeeded: number;
      failed: number;
      refundedToWalletRial: number;
      replay: boolean;
    }
  | { status: 'failed'; paymentId: string; message: string }
  | { status: 'needs_review'; paymentId: string; message: string };

/**
 * پردازش بازگشت از درگاه (`GET /payments/zarinpal/callback`):
 *  - مسیر عمومی است و به کوکی نشست وابسته نیست (با `paymentId` یا `Authority` کار می‌کند).
 *  - حتی اگر `Status !== 'OK'` باشد، پیش از ثبت `Failed` با درگاه `verify` می‌شود.
 *  - تسویه با قفل ردیف `payments` و `accounts` کاملاً idempotent است.
 */
export async function handleGatewayCallback(
  deps: ServiceDeps,
  input: { paymentId?: string; authority?: string; status: string; ip: string },
): Promise<CallbackOutcome> {
  const initialRows = input.paymentId
    ? await deps.db.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1)
    : input.authority
      ? await deps.db.select().from(payments).where(eq(payments.authority, input.authority)).limit(1)
      : [];
  const found = initialRows[0];
  if (!found) fail('NOT_FOUND', 'پرداخت یافت نشد.');

  const paymentId = found.id;
  await deps.db
    .update(payments)
    .set({ callbackCount: sql`${payments.callbackCount} + 1` })
    .where(eq(payments.id, paymentId));

  // اگر قبلاً تسویه شده، بدون تماس دوباره با درگاه همان نتیجه برگردانده می‌شود
  if (found.status === 'Paid' && found.resultJson) {
    return {
      status: 'paid',
      paymentId,
      trackingCode: found.resultJson.trackingCode,
      amountRial: Number(found.amountRial),
      succeeded: found.resultJson.succeeded,
      failed: found.resultJson.failed,
      refundedToWalletRial: found.resultJson.refundedToWalletRial,
      replay: true,
    };
  }
  if (found.status === 'Failed') {
    return { status: 'failed', paymentId, message: 'این پرداخت ناموفق بوده است؛ مبلغی از حساب شما کسر نشده است.' };
  }
  if (found.status === 'NeedsReview') {
    if (found.verifiedAt && found.lastError === 'settlement_failed') {
      return settleVerifiedPayment(deps, { paymentId, refId: found.refId ?? '', gatewayName: found.gateway, ip: input.ip });
    }
    return {
      status: 'needs_review',
      paymentId,
      message: 'پرداخت شما در صف بررسی امور مالی قرار دارد.',
    };
  }

  const gateway = resolveGateway(deps);
  if (!gateway) {
    await markPaymentFailedIfPending(deps, paymentId, 'gateway_disabled', input.ip);
    return { status: 'failed', paymentId, message: 'درگاه پرداخت غیرفعال است.' };
  }

  const authority = found.authority ?? input.authority ?? '';
  if (!authority) {
    await markPaymentFailedIfPending(deps, paymentId, 'authority_missing', input.ip);
    return { status: 'failed', paymentId, message: 'شناسهٔ ارجاع درگاه یافت نشد.' };
  }

  // استعلام مستقیم از درگاه (حتی اگر Status!=OK باشد)
  let verification: GatewayVerifyResult;
  try {
    verification = await gateway.verify({
      authority,
      status: input.status,
      amountRial: Number(found.amountRial),
    });
  } catch (error) {
    deps.log.error({ err: error, paymentId }, 'خطای ارتباطی هنگام verify پرداخت با درگاه');
    await markPaymentNeedsReview(deps, {
      paymentId,
      reason: 'verify_network_error',
      refId: null,
      verifiedAt: null,
      ip: input.ip,
      alertBody: `خطای شبکه هنگام استعلام تأیید پرداخت ${paymentId} از درگاه؛ نیازمند بررسی خودکار یا دستی امور مالی.`,
    });
    return {
      status: 'needs_review',
      paymentId,
      message: 'ارتباط با درگاه برای تأیید نهایی برقرار نشد؛ وضعیت پرداخت به‌صورت خودکار بررسی می‌شود.',
    };
  }

  if (!verification.ok) {
    const changed = await markPaymentFailedIfPending(deps, paymentId, (verification.message ?? 'verify_failed').slice(0, 200), input.ip);
    if (!changed) {
      // اگر درخواست هم‌زمان دیگری آن را Paid کرده باشد، وضعیت واقعی را بازخوانی می‌کنیم
      const reloaded = (await deps.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1))[0];
      if (reloaded?.status === 'Paid' && reloaded.resultJson) {
        return {
          status: 'paid',
          paymentId,
          trackingCode: reloaded.resultJson.trackingCode,
          amountRial: Number(reloaded.amountRial),
          succeeded: reloaded.resultJson.succeeded,
          failed: reloaded.resultJson.failed,
          refundedToWalletRial: reloaded.resultJson.refundedToWalletRial,
          replay: true,
        };
      }
    }
    return {
      status: 'failed',
      paymentId,
      message: 'پرداخت تأیید نشد یا توسط کاربر لغو گردید؛ مبلغی از حساب شما کسر نشده است.',
    };
  }

  // تطبیق دقیق مبلغ
  if (verification.amountRial != null && Number(verification.amountRial) !== Number(found.amountRial)) {
    await markPaymentNeedsReview(deps, {
      paymentId,
      reason: 'amount_mismatch',
      refId: verification.refId ?? null,
      verifiedAt: new Date(),
      ip: input.ip,
      alertBody: `مغایرت مبلغ در پرداخت ${paymentId}: مبلغ مورد انتظار ${found.amountRial} ریال، گزارش درگاه ${verification.amountRial} ریال.`,
    });
    return {
      status: 'needs_review',
      paymentId,
      message: 'مبلغ گزارش‌شده توسط درگاه با سفارش مطابقت ندارد و برای بررسی به امور مالی ارجاع شد.',
    };
  }

  return settleVerifiedPayment(deps, {
    paymentId,
    refId: verification.refId ?? '',
    gatewayName: gateway.name,
    ip: input.ip,
  });
}

async function markPaymentFailedIfPending(deps: ServiceDeps, paymentId: string, reason: string, ip: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(payments)
      .set({ status: 'Failed', lastError: reason.slice(0, 200) })
      .where(sql`${payments.id} = ${paymentId} AND ${payments.status} = 'Pending'`)
      .returning({ id: payments.id });
    if (updated.length > 0) {
      await writeAudit(tx, {
        actor: { type: 'Gateway', id: paymentId, label: 'gateway' },
        action: 'payment.failed',
        targetType: 'Payment',
        targetId: paymentId,
        details: { reason },
        ip,
      });
      return true;
    }
    return false;
  });
}

async function markPaymentNeedsReview(
  deps: ServiceDeps,
  input: {
    paymentId: string;
    reason: string;
    refId: string | null;
    verifiedAt: Date | null;
    ip: string;
    alertBody: string;
  },
): Promise<void> {
  await deps.db
    .update(payments)
    .set({
      status: 'NeedsReview',
      lastError: input.reason.slice(0, 200),
      ...(input.refId != null ? { refId: input.refId.slice(0, 120) } : {}),
      ...(input.verifiedAt != null ? { verifiedAt: input.verifiedAt } : {}),
    })
    .where(sql`${payments.id} = ${input.paymentId} AND ${payments.status} IN ('Pending','NeedsReview')`);

  await writeAudit(deps.db, {
    actor: { type: 'Gateway', id: input.paymentId, label: 'gateway' },
    action: 'payment.needs_review',
    targetType: 'Payment',
    targetId: input.paymentId,
    details: { reason: input.reason, refId: input.refId },
    ip: input.ip,
  });

  await alertFinanceAndAdmins(deps, {
    title: 'پرداخت نیازمند بررسی فوری',
    body: input.alertBody,
    event: 'system.alert',
  });
}

/**
 * تسویهٔ اتمیک و idempotent پرداخت تأییدشده در یک تراکنش واحد:
 *  ۱) قفل ردیف `payments` (`FOR UPDATE`) — جلوگیری کامل از پردازش هم‌زمان دو callback.
 *  ۲) قفل ردیف `accounts` (`FOR UPDATE`).
 *  ۳) ثبت تراکنش دفتر کل `OnlinePayment` به مبلغ پرداخت درگاه.
 *  ۴) رزرو تک‌تک آیتم‌های سبد در `SAVEPOINT` مستقل؛ اگر آیتمی شکست خورد، سهم پرداختیِ
 *     آن به‌صورت خودکار در اعتبار داخلی کیف پول دانشجو باقی می‌ماند.
 *  ۵) ذخیرهٔ رسید کامل در `payments.result_json` و تغییر وضعیت به `Paid`.
 */
export async function settleVerifiedPayment(
  deps: ServiceDeps,
  input: { paymentId: string; refId: string; gatewayName: string; ip: string; forceSimulateInternalError?: boolean },
): Promise<CallbackOutcome> {
  try {
    if (input.forceSimulateInternalError) {
      throw new Error('simulated_internal_settlement_failure');
    }

    const settled = await deps.db.transaction(async (tx) => {
      const lockRows = await tx.execute(rawSql(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [input.paymentId]));
      const row = ((lockRows as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
      if (!row) fail('NOT_FOUND', 'پرداخت یافت نشد.');

      const currentStatus = String(row.status);
      const amountRial = Number(row.amount_rial ?? 0);
      const creditIntendedRial = Number(row.credit_used_rial ?? 0);
      const accountId = String(row.account_id);

      if (currentStatus === 'Paid' && row.result_json) {
        const prev = row.result_json as PaymentSettlementResult;
        return {
          replay: true,
          trackingCode: prev.trackingCode,
          amountRial,
          succeeded: prev.succeeded,
          failed: prev.failed,
          refundedToWalletRial: prev.refundedToWalletRial,
        };
      }

      const lockedAccounts = await lockAccountsForUpdate(tx, [accountId]);
      const balanceBeforeGateway = lockedAccounts.get(accountId)?.balanceRial ?? 0;
      const holder = await getAccountHolder(tx, accountId);
      if (!holder) fail('NOT_FOUND', 'حساب کاربر یافت نشد.');

      // ثبت واریز درگاه در دفتر کل دوطرفه
      const ledger = await postLedger(tx, deps, {
        type: 'OnlinePayment',
        idempotencyKey: `online-payment:${input.paymentId}`,
        reason: 'پرداخت مستقیم درگاه بابت رزرو غذا',
        actor: { type: 'Gateway', id: input.paymentId, label: input.gatewayName },
        referenceType: 'Payment',
        referenceId: input.paymentId,
        legs: [
          { accountId, amountRial },
          { systemAccount: 'GATEWAY_CLEARING', amountRial: -amountRial },
        ],
      });

      const txCodeRow = await tx.execute(rawSql(`SELECT tracking_code FROM ledger_transactions WHERE id = $1`, [ledger.transactionId]));
      const trackingCode = String(((txCodeRow as unknown as { rows: { tracking_code: string }[] }).rows ?? [])[0]?.tracking_code ?? '');

      const cartItems: PaymentCartItem[] = Array.isArray(row.cart_items) ? (row.cart_items as PaymentCartItem[]) : [];
      const itemResults: PaymentSettlementItemResult[] = [];
      const customerActor: Actor =
        holder.kind === 'Student'
          ? { type: 'Student', id: holder.holderId, label: holder.identifier }
          : { type: 'Employee', id: holder.holderId, label: holder.identifier };

      // رزرو هر آیتم در SAVEPOINT مستقل تا شکست یک آیتم واریز درگاه یا سایر آیتم‌ها را باطل نکند
      for (const [idx, item] of cartItems.entries()) {
        try {
          const res = await tx.transaction(async (spTx: Tx) =>
            reserveInLockedTx(spTx, deps, {
              accountId,
              customerGroup: holder.customerGroup,
              actor: customerActor,
              holderKind: holder.kind,
              employeeId: holder.kind === 'Employee' ? holder.holderId : undefined,
              offeringId: item.offeringId,
              idemKey: `payment-res:${input.paymentId}:${idx}:${item.offeringId}`,
              expectedPriceRial: item.priceAtStartRial,
              note: `رزرو از طریق پرداخت درگاه (${trackingCode})`,
              ip: input.ip,
            }),
          );
          itemResults.push({
            offeringId: item.offeringId,
            foodName: item.foodName,
            serviceDate: item.serviceDate,
            mealSlotTitle: item.mealSlotTitle,
            priceRial: res.priceRial,
            ok: true,
            reservationId: res.reservationId,
            code: res.code,
            error: null,
            errorCode: null,
          });
        } catch (itemErr) {
          if (!(itemErr instanceof AppError)) throw itemErr;
          itemResults.push({
            offeringId: item.offeringId,
            foodName: item.foodName,
            serviceDate: item.serviceDate,
            mealSlotTitle: item.mealSlotTitle,
            priceRial: item.priceAtStartRial,
            ok: false,
            reservationId: null,
            code: null,
            error: itemErr.message,
            errorCode: itemErr.code,
          });
        }
      }

      const spentRial = itemResults.filter((i) => i.ok).reduce((sum, i) => sum + i.priceRial, 0);
      const creditCap = Math.min(balanceBeforeGateway, creditIntendedRial);
      const creditUsedActual = Math.min(creditCap, spentRial);
      const gatewayUsedRial = Math.max(0, spentRial - creditUsedActual);
      const refundedToWalletRial = Math.max(0, amountRial - gatewayUsedRial);
      const finalBalance = (await lockAccountsForUpdate(tx, [accountId])).get(accountId)?.balanceRial ?? 0;

      const succeeded = itemResults.filter((i) => i.ok).length;
      const failed = itemResults.length - succeeded;

      const settlementResult: PaymentSettlementResult = {
        trackingCode,
        paidFromGatewayRial: amountRial,
        creditUsedRial: creditUsedActual,
        refundedToWalletRial,
        balanceRial: finalBalance,
        succeeded,
        failed,
        items: itemResults,
      };

      await tx
        .update(payments)
        .set({
          status: 'Paid',
          refId: input.refId.slice(0, 120) || (row.ref_id ? String(row.ref_id) : null),
          verifiedAt: row.verified_at instanceof Date ? row.verified_at : new Date(),
          resultJson: settlementResult,
          lastError: null,
        })
        .where(eq(payments.id, input.paymentId));

      await writeAudit(tx, {
        actor: { type: 'Gateway', id: input.paymentId, label: input.gatewayName },
        action: 'payment.settled',
        targetType: 'Payment',
        targetId: input.paymentId,
        details: {
          amountRial,
          trackingCode,
          refId: input.refId,
          succeeded,
          failed,
          refundedToWalletRial,
        },
        ip: input.ip,
      });

      if (failed > 0 && refundedToWalletRial > 0) {
        await createNotification(tx, {
          title: 'انتقال وجه آیتم رزرو‌نشده به اعتبار کیف پول',
          body: `پرداخت شما تأیید شد (${trackingCode}) اما ${failed} آیتم به علت تغییر ظرفیت یا شرایط ثبت نشد و مبلغ ${(refundedToWalletRial / 10).toLocaleString('fa-IR')} تومان به اعتبار کیف پول شما منتقل گردید.`,
          audience: 'Account',
          accountId,
          event: 'wallet.topped_up',
        });
      }

      if (holder.kind === 'Employee' && succeeded > 0) {
        const mobile = await employeeMobile(tx, holder.holderId);
        await queueSms(tx, {
          recipient: mobile,
          message: `پرداخت و رزرو ${succeeded} وعده غذای شما ثبت شد. کد رهگیری: ${trackingCode}`,
          accountId,
        });
      }

      return {
        replay: ledger.replay,
        trackingCode,
        amountRial,
        succeeded,
        failed,
        refundedToWalletRial,
      };
    });

    return {
      status: 'paid',
      paymentId: input.paymentId,
      trackingCode: settled.trackingCode,
      amountRial: settled.amountRial,
      succeeded: settled.succeeded,
      failed: settled.failed,
      refundedToWalletRial: settled.refundedToWalletRial,
      replay: settled.replay,
    };
  } catch (error) {
    deps.log.error({ err: error, paymentId: input.paymentId }, 'خطای داخلی پس از verify موفق درگاه پرداخت');
    await markPaymentNeedsReview(deps, {
      paymentId: input.paymentId,
      reason: 'settlement_failed',
      refId: input.refId,
      verifiedAt: new Date(),
      ip: input.ip,
      alertBody: `پرداخت ${input.paymentId} با کد مرجع ${input.refId || '—'} در درگاه تأیید شد اما ثبت داخلی با خطا مواجه گردید. وضعیت: NeedsReview.`,
    });
    return {
      status: 'needs_review',
      paymentId: input.paymentId,
      message: 'پرداخت شما در بانک تأیید شد اما تکمیل رزرو نیازمند بررسی است و به امور مالی اطلاع داده شد.',
    };
  }
}

/** دریافت نتیجهٔ کامل یک پرداخت برای نمایش در صفحهٔ رسید مشتری (با کنترل مالکیت حساب). */
export async function getPaymentResult(deps: ServiceDeps, input: { auth: CustomerAuth; paymentId: string }) {
  const rows = await deps.db.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1);
  const p = rows[0];
  if (!p || p.accountId !== input.auth.accountId) {
    fail('NOT_FOUND', 'اطلاعات این پرداخت یافت نشد.');
  }

  // اگر هنوز Pending است و کاربر زودتر از callback به صفحهٔ نتیجه رسیده، یک‌بار استعلام می‌کنیم
  if (p.status === 'Pending' && p.authority && resolveGateway(deps)) {
    await handleGatewayCallback(deps, {
      paymentId: p.id,
      authority: p.authority,
      status: 'OK',
      ip: '127.0.0.1',
    });
  }

  const fresh = (await deps.db.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1))[0]!;
  const holder = await getAccountHolder(deps.db, input.auth.accountId);
  const balanceRial = holder?.balanceRial ?? input.auth.balanceRial;
  const result = fresh.resultJson;

  const status = fresh.status as 'Pending' | 'Paid' | 'Failed' | 'NeedsReview';
  let message = 'پرداخت در انتظار تأیید درگاه است.';
  if (status === 'Paid') {
    if (result && result.failed === 0) {
      message = `پرداخت و رزرو ${result.succeeded} وعده با موفقیت انجام شد.`;
    } else if (result && result.succeeded > 0) {
      message = `${result.succeeded} وعده رزرو شد و مبلغ ${(result.refundedToWalletRial / 10).toLocaleString('fa-IR')} تومان بابت آیتم‌های ناموفق به اعتبار کیف پول شما منتقل گردید.`;
    } else {
      message = `پرداخت شما تأیید شد اما به علت تکمیل ظرفیت یا پایان مهلت، کل مبلغ به اعتبار کیف پول شما منتقل گردید.`;
    }
  } else if (status === 'Failed') {
    message = 'پرداخت انجام نشد یا لغو گردید. در صورت کسر وجه بانکی، مبلغ ظرف ۷۲ ساعت توسط شبکهٔ شاپرک بازگردانده می‌شود.';
  } else if (status === 'NeedsReview') {
    message = 'پرداخت شما در صف بررسی خودکار و امور مالی قرار دارد. لطفاً از پرداخت مجدد خودداری فرمایید.';
  }

  return {
    paymentId: fresh.id,
    status,
    gateway: fresh.gateway,
    totalRial: Number(fresh.totalRial),
    creditUsedRial: result ? result.creditUsedRial : Number(fresh.creditUsedRial),
    amountRial: Number(fresh.amountRial),
    refundedToWalletRial: result?.refundedToWalletRial ?? 0,
    refId: fresh.refId ?? null,
    trackingCode: result?.trackingCode ?? null,
    createdAt: fresh.createdAt.toISOString(),
    verifiedAt: fresh.verifiedAt ? fresh.verifiedAt.toISOString() : null,
    items:
      result?.items ??
      (fresh.cartItems ?? []).map((item) => ({
        offeringId: item.offeringId,
        foodName: item.foodName,
        serviceDate: item.serviceDate,
        mealSlotTitle: item.mealSlotTitle,
        priceRial: item.priceAtStartRial,
        ok: false,
        reservationId: null,
        code: null,
        error: status === 'Failed' ? 'پرداخت تکمیل نشد.' : null,
        errorCode: null,
      })),
    balanceRial: result?.balanceRial ?? balanceRial,
    message,
  };
}

/**
 * آشتی‌سازی دوره‌ای پرداخت‌ها (توسط worker هر ۱۵ دقیقه):
 *  ۱) پرداخت‌های `Pending` قدیمی‌تر از ۳۰ دقیقه را با درگاه استعلام می‌کند:
 *     اگر واقعاً پرداخت شده باشد تسویه و رزرو (یا اعتبار بازگشتی) ثبت می‌شود؛ وگرنه `Failed` می‌گردد.
 *  ۲) پرداخت‌های `NeedsReview` که درگاه آن‌ها را تأیید کرده ولی تسویهٔ داخلی خطا داده بود (`settlement_failed`)
 *     را به‌صورت idempotent مجدداً تسویه می‌کند.
 */
export async function reconcilePendingPayments(
  deps: ServiceDeps,
  olderThanMinutes = 30,
): Promise<{ checked: number; settled: number; markedFailed: number; needsReviewRetried: number }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const pendingRows = await deps.db
    .select()
    .from(payments)
    .where(sql`${payments.status} = 'Pending' AND ${payments.createdAt} < ${cutoff}`)
    .limit(100);

  const gateway = resolveGateway(deps);
  let settled = 0;
  let markedFailed = 0;

  for (const row of pendingRows) {
    if (row.authority && gateway) {
      try {
        const verification = await gateway.verify({
          authority: row.authority,
          status: 'OK',
          amountRial: Number(row.amountRial),
        });
        if (verification.ok) {
          const outcome = await settleVerifiedPayment(deps, {
            paymentId: row.id,
            refId: verification.refId ?? '',
            gatewayName: gateway.name,
            ip: '127.0.0.1',
          });
          if (outcome.status === 'paid') settled += 1;
          continue;
        }
      } catch (err) {
        deps.log.warn({ err, paymentId: row.id }, 'خطای موقت در استعلام آشتی‌سازی پرداخت Pending');
        continue;
      }
    }

    const updated = await deps.db
      .update(payments)
      .set({ status: 'Failed', lastError: 'timed_out_pending' })
      .where(sql`${payments.id} = ${row.id} AND ${payments.status} = 'Pending'`)
      .returning({ id: payments.id });
    if (updated.length > 0) {
      markedFailed += 1;
      await writeAudit(deps.db, {
        actor: { type: 'System', id: '', label: 'worker' },
        action: 'payment.reconcile_timeout',
        targetType: 'Payment',
        targetId: row.id,
        details: { amountRial: Number(row.amountRial) },
      });
    }
  }

  // تلاش مجدد برای پرداخت‌های تأییدشده‌ای که تسویهٔ داخلی‌شان موقتاً خطا داده بود
  const retryableRows = await deps.db
    .select()
    .from(payments)
    .where(sql`${payments.status} = 'NeedsReview' AND ${payments.verifiedAt} IS NOT NULL AND ${payments.lastError} = 'settlement_failed'`)
    .limit(50);

  let needsReviewRetried = 0;
  for (const row of retryableRows) {
    const outcome = await settleVerifiedPayment(deps, {
      paymentId: row.id,
      refId: row.refId ?? '',
      gatewayName: row.gateway,
      ip: '127.0.0.1',
    });
    if (outcome.status === 'paid') needsReviewRetried += 1;
  }

  return { checked: pendingRows.length, settled, markedFailed, needsReviewRetried };
}

/** فهرست پرداخت‌های درگاه برای پنل امور مالی (به‌ویژه صف `NeedsReview`). */
export async function listFinancePayments(deps: ServiceDeps, query: { status?: string; limit?: number; offset?: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.status) {
    params.push(query.status);
    where.push(`p.status = $${params.length}`);
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  const rows = await deps.db.execute(
    rawSql(
      `SELECT p.id, p.gateway, p.status, p.amount_rial::text AS "amountRial",
              p.total_rial::text AS "totalRial", p.credit_used_rial::text AS "creditUsedRial",
              p.authority, p.ref_id AS "refId", p.callback_count AS "callbackCount",
              p.last_error AS "lastError", p.created_at AS "createdAt", p.verified_at AS "verifiedAt",
              p.resolved_at AS "resolvedAt", p.resolution_note AS "resolutionNote",
              COALESCE(s.student_number, e.username, '—') AS "holderIdentifier",
              COALESCE(s.full_name, e.full_name, '—') AS "holderName"
       FROM payments p
       JOIN accounts a ON a.id = p.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE WHEN p.status = 'NeedsReview' THEN 0 ELSE 1 END, p.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
  );

  const countRow = await deps.db.execute(rawSql(`SELECT COUNT(*)::int AS n FROM payments WHERE status = 'NeedsReview'`, []));
  const needsReviewCount = Number(((countRow as unknown as { rows: { n: number }[] }).rows ?? [])[0]?.n ?? 0);

  const list = (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    gateway: String(r.gateway),
    status: String(r.status) as 'Pending' | 'Paid' | 'Failed' | 'NeedsReview',
    amountRial: Number(r.amountRial ?? 0),
    totalRial: Number(r.totalRial ?? 0),
    creditUsedRial: Number(r.creditUsedRial ?? 0),
    authority: r.authority == null ? null : String(r.authority),
    refId: r.refId == null ? null : String(r.refId),
    callbackCount: Number(r.callbackCount ?? 0),
    lastError: r.lastError == null ? null : String(r.lastError),
    createdAt: new Date(String(r.createdAt)).toISOString(),
    verifiedAt: r.verifiedAt ? new Date(String(r.verifiedAt)).toISOString() : null,
    resolvedAt: r.resolvedAt ? new Date(String(r.resolvedAt)).toISOString() : null,
    resolutionNote: r.resolutionNote == null ? null : String(r.resolutionNote),
    holderIdentifier: String(r.holderIdentifier ?? '—'),
    holderName: String(r.holderName ?? '—'),
  }));

  return { payments: list, needsReviewCount };
}

/** تعیین تکلیف دستی پرداخت `NeedsReview` توسط امور مالی. */
export async function resolveFinancePayment(
  deps: ServiceDeps,
  input: {
    paymentId: string;
    action: 'retry_settle' | 'mark_failed';
    reason: string;
    staffId: string;
    actor: Actor;
    ip: string;
  },
) {
  const row = (await deps.db.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1))[0];
  if (!row) fail('NOT_FOUND', 'پرداخت یافت نشد.');
  if (row.status !== 'NeedsReview') {
    fail('CONFLICT', `فقط پرداخت‌های در وضعیت NeedsReview قابل تعیین تکلیف هستند (وضعیت فعلی: ${row.status}).`);
  }

  if (input.action === 'retry_settle') {
    const outcome = await settleVerifiedPayment(deps, {
      paymentId: row.id,
      refId: row.refId ?? 'manual_finance_verify',
      gatewayName: row.gateway,
      ip: input.ip,
    });
    if (outcome.status === 'paid') {
      await deps.db
        .update(payments)
        .set({ resolvedBy: input.staffId, resolvedAt: new Date(), resolutionNote: input.reason.trim() })
        .where(eq(payments.id, row.id));
      await writeAudit(deps.db, {
        actor: input.actor,
        action: 'payment.resolve_settled',
        targetType: 'Payment',
        targetId: row.id,
        details: { reason: input.reason.trim() },
        ip: input.ip,
      });
    }
    return { status: outcome.status === 'paid' ? ('Paid' as const) : ('NeedsReview' as const) };
  }

  // mark_failed
  await deps.db
    .update(payments)
    .set({
      status: 'Failed',
      resolvedBy: input.staffId,
      resolvedAt: new Date(),
      resolutionNote: input.reason.trim(),
    })
    .where(sql`${payments.id} = ${row.id} AND ${payments.status} = 'NeedsReview'`);

  await writeAudit(deps.db, {
    actor: input.actor,
    action: 'payment.resolve_failed',
    targetType: 'Payment',
    targetId: row.id,
    details: { reason: input.reason.trim() },
    ip: input.ip,
  });

  return { status: 'Failed' as const };
}

/** صفحهٔ sandbox برای توسعه: شبیه‌سازی بازگشت از درگاه. */
export function sandboxRedirectHtml(deps: ServiceDeps, authority: string, amountRial: number): string {
  if (deps.env.NODE_ENV === 'production' || !deps.env.ALLOW_SANDBOX_GATEWAY) {
    throw new AppError('FORBIDDEN', 'درگاه آزمایشی در این محیط غیرفعال است.');
  }
  const callback = `/api/v1/payments/zarinpal/callback?authority=${encodeURIComponent(authority)}`;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>درگاه پرداخت آزمایشی</title></head>
<body style="font-family:Tahoma,sans-serif;text-align:center;padding:40px;background:#f8fafc;color:#0f172a">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
<h2>درگاه پرداخت آزمایشی (محیط غیرعملیاتی)</h2>
<p style="font-size:18px;font-weight:bold">مبلغ قابل پرداخت: ${(amountRial / 10).toLocaleString('fa-IR')} تومان</p>
<p style="margin-top:24px"><a href="${callback}&Status=OK" style="display:block;padding:12px;background:#16a34a;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold">پرداخت موفق و تکمیل رزرو</a></p>
<p style="margin-top:12px"><a href="${callback}&Status=NOK" style="display:block;padding:12px;background:#dc2626;color:#fff;border-radius:10px;text-decoration:none">انصراف / پرداخت ناموفق</a></p>
</div>
</body></html>`;
}
