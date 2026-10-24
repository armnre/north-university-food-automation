import type { Env } from '../env.js';

export type VerifyResult = { code: number; refId?: string; cardPan?: string };
export interface PaymentGateway {
  readonly name: string;
  request(input: { amountRial: bigint; description: string; callbackUrl: string; mobile?: string }): Promise<{ authority: string }>;
  verify(input: { amountRial: bigint; authority: string }): Promise<VerifyResult>;
  startPayUrl(authority: string): string;
}

/** Zarinpal REST v4. Amounts are sent in IRR. Codes 100 (verified) and 101 (already verified) are both success. */
export class ZarinpalGateway implements PaymentGateway {
  readonly name: string;
  private base: string;
  constructor(
    private merchantId: string,
    sandbox: boolean,
  ) {
    this.name = sandbox ? 'zarinpal-sandbox' : 'zarinpal';
    this.base = sandbox ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com';
  }
  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.base}/pg/v4/payment/${path}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return (await res.json()) as { data?: { code?: number; authority?: string; ref_id?: number; card_pan?: string }; errors?: { code?: number } | unknown[] };
  }
  async request(i: { amountRial: bigint; description: string; callbackUrl: string; mobile?: string }) {
    const r = await this.post('request', {
      merchant_id: this.merchantId,
      amount: Number(i.amountRial),
      currency: 'IRR',
      description: i.description,
      callback_url: i.callbackUrl,
      metadata: i.mobile ? { mobile: i.mobile } : undefined,
    });
    if (r.data?.code !== 100 || !r.data.authority)
      throw new Error(`zarinpal request failed (${(r.errors as { code?: number })?.code ?? r.data?.code ?? 'unknown'})`);
    return { authority: r.data.authority };
  }
  async verify(i: { amountRial: bigint; authority: string }) {
    const r = await this.post('verify', { merchant_id: this.merchantId, amount: Number(i.amountRial), authority: i.authority });
    const code = r.data?.code ?? (r.errors as { code?: number })?.code ?? -1;
    return { code, refId: r.data?.ref_id != null ? String(r.data.ref_id) : undefined, cardPan: r.data?.card_pan };
  }
  startPayUrl(authority: string) {
    return `${this.base}/pg/StartPay/${encodeURIComponent(authority)}`;
  }
}

/** Returns null when online payment is disabled. Env validation already forbids sandbox in production. */
export function gatewayFromEnv(env: Env): PaymentGateway | null {
  if (!env.ONLINE_PAYMENT_ENABLED) return null;
  if (env.ALLOW_SANDBOX_GATEWAY && env.NODE_ENV !== 'production')
    return new ZarinpalGateway(env.ZARINPAL_MERCHANT_ID ?? '00000000-0000-0000-0000-000000000000', true);
  if (!env.ZARINPAL_MERCHANT_ID) throw new Error('ZARINPAL_MERCHANT_ID missing');
  return new ZarinpalGateway(env.ZARINPAL_MERCHANT_ID, false);
}
