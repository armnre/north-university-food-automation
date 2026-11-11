import type { Env } from '../env.js';

export type VerifyResult = { code: number; refId?: string; cardPan?: string };
export interface PaymentGateway {
  readonly name: string;
  request(input: { amountRial: bigint; description: string; callbackUrl: string; mobile?: string }): Promise<{ authority: string }>;
  /** refNum: Saman's RefNum from the callback (required by Saman, ignored by Zarinpal). */
  verify(input: { amountRial: bigint; authority: string; refNum?: string }): Promise<VerifyResult>;
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

/**
 * Saman Kish (SEP) — https://sep.shaparak.ir, token-based IPG.
 * 1) POST /onlinepg/onlinepg {action:'token', TerminalId, Amount(IRR), ResNum, RedirectUrl, CellNumber} → {status:1, token}
 * 2) Browser → GET /OnlinePG/SendToken?token=…  (token valid ~20 min)
 * 3) Saman POSTs (form) back to RedirectUrl: State, Status(2 = OK), RefNum, ResNum, Token, Amount, Rrn, SecurePan…
 * 4) Server POST /verifyTxnRandomSessionkey/ipg/VerifyTransaction {RefNum, TerminalNumber} → ResultCode 0 (ok) / 2 (already verified).
 *    Saman authenticates these calls by the server's whitelisted IP; unverified payments are auto-reversed by Saman after ~30 min.
 * Verified amount must equal the requested amount; otherwise the transaction is reversed and treated as failed.
 */
export class SamanGateway implements PaymentGateway {
  readonly name = 'saman';
  private base = 'https://sep.shaparak.ir';
  constructor(private terminalId: string) {}
  private async post<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`saman http ${res.status}`);
    return (await res.json()) as T;
  }
  async request(i: { amountRial: bigint; description: string; callbackUrl: string; mobile?: string; resNum?: string }) {
    const url = new URL(i.callbackUrl);
    const resNum = i.resNum ?? url.searchParams.get('pid') ?? crypto.randomUUID();
    url.search = '';
    const r = await this.post<{ status?: number; token?: string; errorCode?: string; errorDesc?: string }>(`${this.base}/onlinepg/onlinepg`, {
      action: 'token',
      TerminalId: this.terminalId,
      Amount: Number(i.amountRial),
      ResNum: resNum,
      RedirectUrl: url.toString(),
      ...(i.mobile ? { CellNumber: i.mobile } : {}),
    });
    if (r.status !== 1 || !r.token) throw new Error(`saman token failed (${r.errorCode ?? 'unknown'}: ${r.errorDesc ?? ''})`);
    return { authority: r.token };
  }
  async verify(i: { amountRial: bigint; authority: string; refNum?: string }): Promise<VerifyResult> {
    if (!i.refNum) throw new Error('saman: RefNum not received yet');
    const body = { RefNum: i.refNum, TerminalNumber: Number(this.terminalId) };
    const r = await this.post<{ ResultCode?: number; Success?: boolean; TransactionDetail?: { RRN?: string; RefNum?: string; MaskedPan?: string; OrginalAmount?: number; AffectiveAmount?: number } }>(
      `${this.base}/verifyTxnRandomSessionkey/ipg/VerifyTransaction`,
      body,
    );
    const d = r.TransactionDetail ?? {};
    const okCode = r.ResultCode === 0 || r.ResultCode === 2;
    if (!okCode) return { code: -(Math.abs(r.ResultCode ?? 1) + 1000) };
    if (Number(d.OrginalAmount ?? d.AffectiveAmount) !== Number(i.amountRial)) {
      await this.post(`${this.base}/verifyTxnRandomSessionkey/ipg/ReverseTransaction`, body).catch(() => undefined);
      return { code: -2000 };
    }
    return { code: r.ResultCode === 0 ? 100 : 101, refId: d.RRN || i.refNum, cardPan: d.MaskedPan };
  }
  startPayUrl(authority: string) {
    return `${this.base}/OnlinePG/SendToken?token=${encodeURIComponent(authority)}`;
  }
}

/** Returns null when online payment is disabled. Env validation already forbids sandbox in production. */
export function gatewayFromEnv(env: Env): PaymentGateway | null {
  if (!env.ONLINE_PAYMENT_ENABLED) return null;
  if (env.PAYMENT_PROVIDER === 'saman') {
    if (!env.SAMAN_TERMINAL_ID) throw new Error('SAMAN_TERMINAL_ID missing');
    return new SamanGateway(env.SAMAN_TERMINAL_ID);
  }
  if (env.ALLOW_SANDBOX_GATEWAY && env.NODE_ENV !== 'production')
    return new ZarinpalGateway(env.ZARINPAL_MERCHANT_ID ?? '00000000-0000-0000-0000-000000000000', true);
  if (!env.ZARINPAL_MERCHANT_ID) throw new Error('ZARINPAL_MERCHANT_ID missing');
  return new ZarinpalGateway(env.ZARINPAL_MERCHANT_ID, false);
}
