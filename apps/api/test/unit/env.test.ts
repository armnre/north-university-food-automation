import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { getClientIp } from '../../src/lib/ip.js';
import type { FastifyRequest } from 'fastify';

const base = {
  PUBLIC_BASE_URL: 'https://dining.example.ir',
  DATABASE_URL: 'postgres://x',
  NATIONAL_ID_PEPPER: 'p'.repeat(40),
  CSRF_SECRET: 'c'.repeat(40),
  UPLOAD_DIR: '/tmp/u',
};

describe('env validation', () => {
  it('refuses to boot without required keys', () => expect(() => loadEnv({})).toThrow(/Invalid environment/));
  it('forbids sandbox gateway in production', () =>
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', ALLOW_SANDBOX_GATEWAY: 'true' })).toThrow(/sandbox/));
  it('requires merchant when online payment is enabled in production', () =>
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', ONLINE_PAYMENT_ENABLED: 'true' })).toThrow(/ZARINPAL_MERCHANT_ID/));
  it('never echoes secret values in the error', () => {
    try {
      loadEnv({ ...base, NATIONAL_ID_PEPPER: 'short-secret' });
    } catch (e) {
      expect(String(e)).not.toContain('short-secret');
    }
  });
});

describe('getClientIp', () => {
  const req = (xff: string | undefined) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as FastifyRequest;
  it('reads from the end of the chain (spoofed left entries ignored)', () => expect(getClientIp(req('1.1.1.1, 9.9.9.9'), 1)).toBe('9.9.9.9'));
  it('falls back to socket', () => expect(getClientIp(req(undefined), 1)).toBe('127.0.0.1'));
  it('hops=0 ignores header', () => expect(getClientIp(req('9.9.9.9'), 0)).toBe('127.0.0.1'));
});
