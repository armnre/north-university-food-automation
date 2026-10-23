import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2 as pbkdf2Cb,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import argon2, { type HashOptions } from 'argon2';

/**
 * توابع رمزنگاری سامانه.
 *
 *  - توکن نشست/QR: تصادفی ۲۵۶/۱۹۲ بیتی؛ در دیتابیس فقط SHA-256 ذخیره می‌شود.
 *  - کد ملی: HMAC-SHA256 با pepper (مقدار خام هرگز ذخیره نمی‌شود).
 *  - رمز عبور: Argon2id. رمزهای قدیمی PBKDF2 در اولین ورود موفق rehash می‌شوند.
 *  - شبای بانکی: AES-256-GCM.
 */

/** پارامترهای Argon2id مطابق توصیهٔ OWASP (حافظهٔ متوسط برای سرور دانشگاه). */
export const ARGON2_OPTIONS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * hash ساختگی ثابت: برای یکسان‌سازی زمان پاسخ وقتی نام کاربری وجود ندارد
 * (جلوگیری از user enumeration از طریق timing).
 */
export const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0ZHVtbXlzYQ$Qk9nZXNfaGVyZV9mb3JfdGltaW5nX2VxdWFsaXphdGlvbg';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** کد تصادفی بدون کاراکترهای مبهم (0/O/1/I) — برای کد رزرو و کد رهگیری. */
export function randomCode(length = 8, alphabet: string = CODE_ALPHABET): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return out;
}

/** کد رهگیری مالی: `TX-XXXXXXXXXX` */
export function newTrackingCode(): string {
  return `TX-${randomCode(10)}`;
}

/** کد رزرو: `R-XXXXXXXX` */
export function newReservationCode(): string {
  return `R-${randomCode(8)}`;
}

/** HMAC-SHA256 با pepper — برای کد ملی و شناسه‌های ورود. */
export function hmacSha256Hex(key: string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** مقایسهٔ زمان‌ثابت دو رشته (بدون افشای طول/محتوا از طریق timing). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // برای یکسان‌سازی زمان، یک مقایسهٔ بی‌اثر هم انجام می‌دهیم.
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** هش رمز عبور با Argon2id. */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { ...ARGON2_OPTIONS, raw: false });
}

/**
 * بررسی رمز عبور؛ هم Argon2id و هم قالب قدیمی PBKDF2 (میراث Zite) را می‌پذیرد.
 * اگر رکورد یافت نشود، هش ساختگی verify می‌شود تا زمان پاسخ یکسان بماند.
 */
export async function verifyPassword(plain: string, storedHash: string | null | undefined): Promise<boolean> {
  const hash = storedHash && storedHash.length > 0 ? storedHash : DUMMY_PASSWORD_HASH;
  try {
    if (hash.startsWith('pbkdf2$')) return verifyLegacyPbkdf2(plain, hash);
    if (hash.startsWith('$argon2')) return await argon2.verify(hash, plain);
    return false;
  } catch {
    return false;
  }
}

/** آیا هش نیاز به rehash دارد (قالب قدیمی یا پارامترهای ضعیف‌تر)؟ */
export function passwordNeedsRehash(storedHash: string | null | undefined): boolean {
  if (!storedHash) return true;
  if (storedHash.startsWith('pbkdf2$')) return true;
  if (!storedHash.startsWith('$argon2id$')) return true;
  try {
    return argon2.needsRehash(storedHash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/** قالب قدیمی: `pbkdf2$<iterations>$<saltHex>$<hashHex>` (فقط برای مهاجرت در ورود). */
async function verifyLegacyPbkdf2(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const saltHex = parts[2] ?? '';
  const expectedHex = parts[3] ?? '';
  if (!Number.isInteger(iterations) || iterations <= 0 || !/^[a-f0-9]+$/i.test(saltHex) || !/^[a-f0-9]+$/i.test(expectedHex)) {
    return false;
  }
  const derived = await pbkdf2Async(plain, saltHex, iterations);
  return safeEqual(derived.toLowerCase(), expectedHex.toLowerCase());
}

/** ساخت هش PBKDF2 قدیمی — فقط برای تست مسیر مهاجرت رمز. */
export async function legacyPbkdf2Hash(plain: string, iterations = 100_000, saltHex = randomHex(16)): Promise<string> {
  const derived = await pbkdf2Async(plain, saltHex, iterations);
  return `pbkdf2$${iterations}$${saltHex}$${derived}`;
}

function pbkdf2Async(plain: string, saltHex: string, iterations: number): Promise<string> {
  return new Promise((resolve, reject) => {
    pbkdf2Cb(plain, Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256', (err, key) =>
      err ? reject(err) : resolve(key.toString('hex')),
    );
  });
}

// ---------------------------------------------------------------------------
// AES-256-GCM برای شبای بانکی
// ---------------------------------------------------------------------------

export type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(String(hex ?? '').replace(/^0x/, ''), 'hex');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY باید ۳۲ بایت (۶۴ کاراکتر hex) باشد.');
  return key;
}

export function encryptText(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromHex(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload: EncryptedPayload = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(payload);
}

export function decryptText(payloadJson: string, keyHex: string): string {
  const payload = JSON.parse(payloadJson) as EncryptedPayload;
  if (payload?.v !== 1) throw new Error('قالب دادهٔ رمزنگاری‌شده نامعتبر است.');
  const decipher = createDecipheriv('aes-256-gcm', keyFromHex(keyHex), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.ct, 'base64')), decipher.final()]).toString('utf8');
}

/** کلید idempotency پایدار برای یک عملیات (ترکیب سوژه + کلید کلاینت). */
export function idempotencyKey(scope: string, subjectId: string, clientKey: string): string {
  return `${scope}:${subjectId}:${clientKey}`.slice(0, 200);
}

export const newId = (): string => randomUUID();
