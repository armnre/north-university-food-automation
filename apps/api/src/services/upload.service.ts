import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { AppEnv } from '../config/env.js';
import { randomHex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { Actor, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';

export type DetectedImageFormat = 'jpeg' | 'png' | 'webp';

export type UploadedFoodImage = {
  url: string;
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  width: number | null;
  height: number | null;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALLOWED_DECLARED_MIMES = new Set(['', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/octet-stream']);

export const SAFE_UPLOAD_FILE_RE = /^[a-f0-9]{32}\.(webp|jpg|png)$/;

/** مسیر مطلق پوشهٔ ذخیرهٔ تصاویر آپلودشده. */
export function resolveUploadDir(env: AppEnv): string {
  return isAbsolute(env.UPLOAD_DIR) ? env.UPLOAD_DIR : resolve(process.cwd(), env.UPLOAD_DIR);
}

/** تشخیص فرمت واقعی فایل از روی magic bytes (بدون اعتماد به پسوند یا Content-Type). */
export function detectImageFormatByMagicBytes(buffer: Buffer): DetectedImageFormat | null {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return null;
}

type SharpFactory = (
  input?: Buffer,
  options?: { limitInputPixels?: number; failOn?: 'none' | 'truncated' | 'error' | 'warning' },
) => {
  rotate: () => {
    resize: (opts: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }) => {
      webp: (opts: { quality: number }) => {
        toBuffer: (opts: { resolveWithObject: true }) => Promise<{
          data: Buffer;
          info: { width: number; height: number };
        }>;
      };
    };
  };
};

let sharpLoaderPromise: Promise<SharpFactory | null> | null = null;

async function loadSharp(deps: ServiceDeps): Promise<SharpFactory | null> {
  if (deps.env.SHARP_DISABLE) return null;
  if (!sharpLoaderPromise) {
    sharpLoaderPromise = import('sharp')
      .then((mod) => (mod.default as unknown as SharpFactory) ?? null)
      .catch((error: unknown) => {
        deps.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'بارگذاری sharp ممکن نشد؛ حالت جایگزین امن حذف متادیتا فعال شد',
        );
        return null;
      });
  }
  return sharpLoaderPromise;
}

/** آپلود، اعتبارسنجی magic-bytes، تغییر اندازه تا حداکثر ۱۲۰۰px و حذف متادیتای EXIF. */
export async function saveFoodImageUpload(
  deps: ServiceDeps,
  input: {
    buffer: Buffer;
    declaredMimeType?: string;
    originalFileName?: string;
    truncated?: boolean;
    actor: Actor;
    ip: string;
  },
): Promise<UploadedFoodImage> {
  const maxBytes = deps.env.FOOD_IMAGE_MAX_BYTES;
  if (input.truncated || input.buffer.length > maxBytes) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    throw new AppError('VALIDATION', `حجم تصویر نباید بیشتر از ${maxMb} مگابایت باشد.`);
  }
  if (input.buffer.length === 0) {
    throw new AppError('VALIDATION', 'فایل تصویر خالی است.');
  }

  const normalizedMime = (input.declaredMimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (!ALLOWED_DECLARED_MIMES.has(normalizedMime)) {
    throw new AppError('VALIDATION', 'فقط تصاویر با فرمت JPEG، PNG یا WebP مجاز هستند.');
  }

  const format = detectImageFormatByMagicBytes(input.buffer);
  if (!format) {
    throw new AppError('VALIDATION', 'محتوای فایل یک تصویر معتبر JPEG، PNG یا WebP نیست.');
  }

  const sharpFn = await loadSharp(deps);
  let outputBuffer: Buffer;
  let ext: 'webp' | 'jpg' | 'png';
  let mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  let width: number | null;
  let height: number | null;

  if (sharpFn) {
    try {
      // بدون فراخوانی withMetadata() همهٔ متادیتای EXIF/XMP/IPTC/GPS حذف می‌شود.
      const processed = await sharpFn(input.buffer, {
        limitInputPixels: 40_000_000,
        failOn: 'error',
      })
        .rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });

      outputBuffer = processed.data;
      ext = 'webp';
      mimeType = 'image/webp';
      width = processed.info.width ?? null;
      height = processed.info.height ?? null;
    } catch {
      throw new AppError('VALIDATION', 'تصویر ارسالی آسیب‌دیده یا نامعتبر است.');
    }
  } else {
    const fallback = stripMetadataWithoutSharp(input.buffer, format);
    outputBuffer = fallback.data;
    ext = fallback.ext;
    mimeType = fallback.mimeType;
    width = fallback.width;
    height = fallback.height;
  }

  const uploadDir = resolveUploadDir(deps.env);
  await mkdir(uploadDir, { recursive: true, mode: 0o750 });

  const fileName = `${randomHex(16)}.${ext}`;
  const fullPath = resolve(uploadDir, fileName);
  await writeFile(fullPath, outputBuffer, { mode: 0o640, flag: 'wx' });

  await writeAudit(deps.db, {
    actor: input.actor,
    action: 'upload.food_image',
    targetType: 'FoodImage',
    targetId: fileName,
    details: {
      fileName,
      mimeType,
      sizeBytes: outputBuffer.length,
      width,
      height,
      usedSharp: Boolean(sharpFn),
    },
    ip: input.ip,
  });

  return {
    url: `/uploads/${fileName}`,
    mimeType,
    sizeBytes: outputBuffer.length,
    width,
    height,
  };
}

function stripMetadataWithoutSharp(
  buffer: Buffer,
  format: DetectedImageFormat,
): {
  data: Buffer;
  ext: 'jpg' | 'png' | 'webp';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number | null;
  height: number | null;
} {
  if (format === 'jpeg') {
    const res = stripJpegMetadata(buffer);
    return { data: res.data, ext: 'jpg', mimeType: 'image/jpeg', width: res.width, height: res.height };
  }
  if (format === 'png') {
    const res = stripPngMetadata(buffer);
    return { data: res.data, ext: 'png', mimeType: 'image/png', width: res.width, height: res.height };
  }
  const res = stripWebpMetadata(buffer);
  return { data: res.data, ext: 'webp', mimeType: 'image/webp', width: res.width, height: res.height };
}

/** حذف سگمنت‌های متادیتای JPEG (APP1..APP15 شامل EXIF/GPS/XMP و COM). */
function stripJpegMetadata(buffer: Buffer): { data: Buffer; width: number | null; height: number | null } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new AppError('VALIDATION', 'ساختار فایل JPEG معتبر نیست.');
  }
  const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  let width: number | null = null;
  let height: number | null = null;
  let sawSof = false;
  let sawSos = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new AppError('VALIDATION', 'ساختار فایل JPEG آسیب‌دیده است.');
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset]!;
    offset += 1;

    if (marker === 0xd9) {
      chunks.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      chunks.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (offset + 2 > buffer.length) {
      throw new AppError('VALIDATION', 'ساختار فایل JPEG ناقص است.');
    }
    const segLen = buffer.readUInt16BE(offset);
    if (segLen < 2 || offset + segLen > buffer.length) {
      throw new AppError('VALIDATION', 'طول سگمنت JPEG نامعتبر است.');
    }

    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (segLen >= 7) {
        height = buffer.readUInt16BE(offset + 3);
        width = buffer.readUInt16BE(offset + 5);
        sawSof = true;
      }
    }

    // حذف APP1..APP15 (شامل EXIF/GPS/XMP/IPTC) و COM (0xFE)؛ نگه داشتن APP0 (JFIF)
    const dropSegment = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!dropSegment) {
      chunks.push(Buffer.from([0xff, marker]));
      chunks.push(buffer.subarray(offset, offset + segLen));
    }
    offset += segLen;

    if (marker === 0xda) {
      sawSos = true;
      const eoiIndex = findJpegEoi(buffer, offset);
      if (eoiIndex < 0) {
        throw new AppError('VALIDATION', 'پایان تصویر JPEG یافت نشد.');
      }
      chunks.push(buffer.subarray(offset, eoiIndex + 2));
      break;
    }
  }

  if (!sawSof || !sawSos || !width || !height || width > 10_000 || height > 10_000) {
    throw new AppError('VALIDATION', 'تصویر JPEG معتبر نیست یا ابعاد آن خارج از محدودهٔ مجاز است.');
  }
  return { data: Buffer.concat(chunks), width, height };
}

function findJpegEoi(buffer: Buffer, from: number): number {
  for (let i = buffer.length - 2; i >= from; i -= 1) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) return i;
  }
  return -1;
}

const PNG_ALLOWED_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/** نگه‌داشتن چانک‌های حیاتی PNG و حذف متادیتای eXIf/tEXt/iTXt/zTXt. */
function stripPngMetadata(buffer: Buffer): { data: Buffer; width: number; height: number } {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AppError('VALIDATION', 'ساختار فایل PNG معتبر نیست.');
  }
  const chunks: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const total = 12 + length;
    if (length > 20_000_000 || offset + total > buffer.length) {
      throw new AppError('VALIDATION', 'طول چانک PNG نامعتبر است.');
    }
    if (type === 'IHDR') {
      if (sawIhdr || length !== 13) throw new AppError('VALIDATION', 'هدر PNG نامعتبر است.');
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      sawIhdr = true;
    }
    if (type === 'IDAT') sawIdat = true;
    if (PNG_ALLOWED_CHUNKS.has(type)) {
      chunks.push(buffer.subarray(offset, offset + total));
    }
    offset += total;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }

  if (!sawIhdr || !sawIdat || !sawIend || width < 1 || height < 1 || width > 10_000 || height > 10_000) {
    throw new AppError('VALIDATION', 'تصویر PNG معتبر نیست یا ابعاد آن خارج از محدودهٔ مجاز است.');
  }
  return { data: Buffer.concat(chunks), width, height };
}

const WEBP_ALLOWED_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

/** حذف چانک‌های متادیتای EXIF و XMP از ظرف RIFF/WebP. */
function stripWebpMetadata(buffer: Buffer): { data: Buffer; width: number | null; height: number | null } {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new AppError('VALIDATION', 'ساختار فایل WebP معتبر نیست.');
  }
  const kept: Buffer[] = [];
  let offset = 12;
  let sawFrame = false;

  while (offset + 8 <= buffer.length) {
    const fourCc = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const padded = chunkSize + (chunkSize % 2);
    if (chunkSize > 20_000_000 || offset + 8 + padded > buffer.length) {
      throw new AppError('VALIDATION', 'چانک WebP نامعتبر است.');
    }
    if (fourCc === 'VP8 ' || fourCc === 'VP8L') sawFrame = true;
    if (WEBP_ALLOWED_CHUNKS.has(fourCc)) {
      kept.push(buffer.subarray(offset, offset + 8 + padded));
    }
    offset += 8 + padded;
  }

  if (!sawFrame || kept.length === 0) {
    throw new AppError('VALIDATION', 'تصویر WebP فاقد فریم تصویری معتبر است.');
  }

  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'ascii');
  return { data: Buffer.concat([header, body]), width: null, height: null };
}
