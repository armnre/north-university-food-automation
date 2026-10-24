import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../lib/errors.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function sniffImage(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

type SharpFn = (input: Buffer) => {
  rotate(): ReturnType<SharpFn>;
  resize(o: object): ReturnType<SharpFn>;
  webp(o: object): ReturnType<SharpFn>;
  toBuffer(): Promise<Buffer>;
};
let sharpLoad: Promise<SharpFn | null> | undefined;
/** sharp is optional at runtime: if its native binary cannot load (e.g. CPU without required features) we fall back. */
export const loadSharp = () => (sharpLoad ??= import('sharp').then((m) => m.default as unknown as SharpFn).catch(() => null));

/**
 * Validates by magic bytes, re-encodes with sharp (≤1200px, metadata/EXIF stripped). Fallback without sharp:
 * only JPEG/PNG/WebP that passed magic-byte checks are stored as-is, with JPEG APP1 (EXIF) segments stripped.
 */
export async function storeFoodImage(uploadDir: string, buf: Buffer): Promise<{ fileName: string; processed: boolean }> {
  if (buf.length > MAX_IMAGE_BYTES) fail('BAD_REQUEST', 'حجم تصویر بیش از ۲ مگابایت است.');
  const kind = sniffImage(buf);
  if (!kind) fail('BAD_REQUEST', 'فقط تصویر JPEG، PNG یا WebP پذیرفته می‌شود.');
  const dir = path.join(uploadDir, 'foods');
  await mkdir(dir, { recursive: true });
  const sharp = await loadSharp();
  if (sharp) {
    let out: Buffer;
    try {
      out = await sharp(buf).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch {
      fail('BAD_REQUEST', 'تصویر معتبر نیست.');
    }
    const fileName = `${randomUUID()}.webp`;
    await writeFile(path.join(dir, fileName), out, { mode: 0o640 });
    return { fileName, processed: true };
  }
  const data = kind === 'jpeg' ? stripJpegExif(buf) : buf;
  const fileName = `${randomUUID()}.${kind === 'jpeg' ? 'jpg' : kind}`;
  await writeFile(path.join(dir, fileName), data, { mode: 0o640 });
  return { fileName, processed: false };
}

export function stripJpegExif(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]!;
    if (marker === 0xda) break; // start of scan: rest is image data
    const len = buf.readUInt16BE(i + 2);
    if (marker !== 0xe1) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}
