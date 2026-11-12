import { afterEach, describe, expect, it, vi } from 'vitest';
import { SamanGateway } from '../../src/services/gateway.js';

type Call = { url: string; body: Record<string, unknown> };
function mockFetch(responses: unknown[]) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = responses.shift();
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
const gw = () => new SamanGateway('14000000');

describe('SamanGateway', () => {
  it('requests a token with amount, ResNum from pid and a clean RedirectUrl', async () => {
    const calls = mockFetch([{ status: 1, token: 'TKN' }]);
    const r = await gw().request({ amountRial: 4_000_000n, description: 'x', callbackUrl: 'https://diningshomal.ir/api/v1/payments/saman/callback?pid=abc', mobile: '09120000000' });
    expect(r.authority).toBe('TKN');
    expect(calls[0]!.url).toBe('https://sep.shaparak.ir/onlinepg/onlinepg');
    expect(calls[0]!.body).toMatchObject({ action: 'token', TerminalId: '14000000', Amount: 4000000, ResNum: 'abc', RedirectUrl: 'https://diningshomal.ir/api/v1/payments/saman/callback', CellNumber: '09120000000' });
  });
  it('throws when Saman refuses the token', async () => {
    mockFetch([{ status: -1, errorCode: '5', errorDesc: 'bad terminal' }]);
    await expect(gw().request({ amountRial: 1000n, description: 'x', callbackUrl: 'https://a.b/c' })).rejects.toThrow(/token failed/);
  });
  it('throws on HTTP errors', async () => {
    mockFetch([new Response('nope', { status: 502 })]);
    await expect(gw().request({ amountRial: 1000n, description: 'x', callbackUrl: 'https://a.b/c' })).rejects.toThrow(/http 502/);
  });
  it('builds the SendToken pay URL', () => expect(gw().startPayUrl('a b')).toBe('https://sep.shaparak.ir/OnlinePG/SendToken?token=a%20b'));
  it('verifies a successful payment with matching amount', async () => {
    const calls = mockFetch([{ ResultCode: 0, Success: true, TransactionDetail: { RRN: '123', MaskedPan: '6037****1234', OrginalAmount: 4000000 } }]);
    const r = await gw().verify({ amountRial: 4_000_000n, authority: 'TKN', refNum: 'REF' });
    expect(r).toEqual({ code: 100, refId: '123', cardPan: '6037****1234' });
    expect(calls[0]!.body).toEqual({ RefNum: 'REF', TerminalNumber: 14000000 });
  });
  it('treats ResultCode 2 (already verified) as success', async () => {
    mockFetch([{ ResultCode: 2, TransactionDetail: { OrginalAmount: 5000 } }]);
    expect((await gw().verify({ amountRial: 5000n, authority: 't', refNum: 'R' })).code).toBe(101);
  });
  it('reverses and fails when the verified amount differs', async () => {
    const calls = mockFetch([{ ResultCode: 0, TransactionDetail: { OrginalAmount: 1000 } }, { ResultCode: 0 }]);
    expect((await gw().verify({ amountRial: 5000n, authority: 't', refNum: 'R' })).code).toBe(-2000);
    expect(calls[1]!.url).toMatch(/ReverseTransaction$/);
  });
  it('fails on a non-success result code', async () => {
    mockFetch([{ ResultCode: -2 }]);
    expect((await gw().verify({ amountRial: 5000n, authority: 't', refNum: 'R' })).code).toBeLessThan(0);
  });
  it('refuses to verify without RefNum', async () => {
    await expect(gw().verify({ amountRial: 1n, authority: 't' })).rejects.toThrow(/RefNum/);
  });
});
