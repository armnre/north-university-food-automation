import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const hmac = (key: string, v: string) => createHmac('sha256', key).update(v).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'; // no ambiguous chars (0/O, 1/I, 5/S, 8/B, 2/Z)
export const randomCode = (len = 8) => Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
export const trackingCode = () => `TX-${randomCode(10)}`;
