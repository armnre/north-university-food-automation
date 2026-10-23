import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, tehranToday } from '@food/shared';
import { buildTestApp, loginStaff, loginStudent, type TestApp } from '../helpers/app.js';
import { getTestDb, resetDatabase } from '../helpers/db.js';
import { createOffering, createStaff, createStudent, resetBaseCache, seedBase } from '../helpers/fixtures.js';

/** تزریق سگمنت APP1 (EXIF/GPS ساختگی) پس از SOI در فایل JPEG برای آزمون حذف متادیتا. */
function injectFakeExifIntoJpeg(jpeg: Buffer, markerText: string): Buffer {
  expect(jpeg[0]).toBe(0xff);
  expect(jpeg[1]).toBe(0xd8);
  const payload = Buffer.from(`Exif\0\0${markerText}`, 'utf8');
  const segLen = payload.length + 2;
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(segLen, 2);
  payload.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

describe('آپلود امن تصویر غذا (Phase 4)', () => {
  const db = getTestDb();
  let uploadDir = '';
  let ctx: TestApp;

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'food-uploads-test-'));
    ctx = await buildTestApp({
      UPLOAD_DIR: uploadDir,
      FOOD_IMAGE_MAX_BYTES: String(2 * 1024 * 1024),
    });
  });

  beforeEach(async () => {
    await resetDatabase(db);
    resetBaseCache();
    await seedBase(db);
  });

  afterAll(async () => {
    await ctx.close();
    if (uploadDir) {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  it('تصویر بزرگ JPEG را به ≤۱۲۰۰px تغییر اندازه می‌دهد، EXIF را حذف می‌کند، با کش سرو می‌کند و در منوی دانشجو نمایش می‌دهد', async () => {
    const kitchenStaff = await createStaff(db, { role: 'NutritionManager', username: 'kitchen_img' });
    const staffClient = await loginStaff(ctx.app, kitchenStaff.username, kitchenStaff.password);

    const rawJpeg = await sharp({
      create: {
        width: 1800,
        height: 1200,
        channels: 3,
        background: { r: 22, g: 101, b: 52 },
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    const jpegWithExif = injectFakeExifIntoJpeg(rawJpeg, 'GPS_SECRET_36_4681_52_3500');
    expect(jpegWithExif.includes(Buffer.from('GPS_SECRET_36_4681_52_3500'))).toBe(true);

    const uploadRes = await staffClient.upload<{
      url: string;
      mimeType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
    }>('/api/v1/uploads/food-image', {
      name: '../../ghormeh sabzi.jpeg',
      buffer: jpegWithExif,
      mimeType: 'image/jpeg',
    });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.url).toMatch(/^\/uploads\/[a-f0-9]{32}\.webp$/);
    expect(uploadRes.body.mimeType).toBe('image/webp');
    expect(uploadRes.body.width).toBe(1200);
    expect(uploadRes.body.height).toBe(800);

    // بررسی فایل ذخیره‌شده روی دیسک: عدم وجود متادیتای EXIF/GPS
    const savedName = uploadRes.body.url.replace('/uploads/', '');
    const savedBytes = await readFile(join(uploadDir, savedName));
    expect(savedBytes.includes(Buffer.from('GPS_SECRET_36_4681_52_3500'))).toBe(false);

    // سرو فایل استاتیک با هدرهای امنیتی و کش
    const serveRes = await ctx.app.inject({ method: 'GET', url: uploadRes.body.url });
    expect(serveRes.statusCode).toBe(200);
    expect(serveRes.headers['content-type']).toBe('image/webp');
    expect(serveRes.headers['x-content-type-options']).toBe('nosniff');
    expect(String(serveRes.headers['cache-control'])).toContain('max-age=2592000');
    const etag = String(serveRes.headers['etag'] ?? '');
    expect(etag.length).toBeGreaterThan(4);

    const cachedRes = await ctx.app.inject({
      method: 'GET',
      url: uploadRes.body.url,
      headers: { 'if-none-match': etag },
    });
    expect(cachedRes.statusCode).toBe(304);

    // ذخیرهٔ غذا با imagePath و بررسی خروجی /me/menu برای دانشجو
    const createFoodRes = await staffClient.post<{ id: string }>('/api/v1/catalog', {
      item: {
        kind: 'food',
        name: 'چلوخورش قورمه‌سبزی مخصوص',
        description: 'با گوشت گوساله و لیموعمانی',
        category: 'خورشتی',
        imagePath: uploadRes.body.url,
        defaultPriceRial: 150_000,
        defaultCapacity: 120,
        isActive: true,
      },
    });
    expect(createFoodRes.status).toBe(200);

    const serviceDate = addDays(tehranToday(), 2);
    await createOffering(db, {
      foodId: createFoodRes.body.id,
      serviceDate,
      mealSlot: 'Lunch',
      priceStudent: 150_000,
    });

    const student = await createStudent(db, { studentNumber: '402991001' });
    const studentClient = await loginStudent(ctx.app, student.studentNumber, student.nationalId);
    const menuRes = await studentClient.get<{ offerings: { foodId: string; imagePath: string | null }[] }>('/api/v1/me/menu', {
      from: serviceDate,
      to: serviceDate,
    });
    expect(menuRes.status).toBe(200);
    const item = menuRes.body.offerings.find((o) => o.foodId === createFoodRes.body.id);
    expect(item?.imagePath).toBe(uploadRes.body.url);
  });

  it('دسترسی بدون مجوز foods (دانشجو و اپراتور سلف) را با ۴۰۳ رد می‌کند', async () => {
    const tinyPng = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 150, b: 50 } },
    })
      .png()
      .toBuffer();

    const student = await createStudent(db, { studentNumber: '402991002' });
    const studentClient = await loginStudent(ctx.app, student.studentNumber, student.nationalId);
    const sRes = await studentClient.upload('/api/v1/uploads/food-image', {
      name: 'food.png',
      buffer: tinyPng,
      mimeType: 'image/png',
    });
    expect(sRes.status).toBe(403);

    const operator = await createStaff(db, { role: 'Operator', username: 'op_no_foods' });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);
    const oRes = await opClient.upload('/api/v1/uploads/food-image', {
      name: 'food.png',
      buffer: tinyPng,
      mimeType: 'image/png',
    });
    expect(oRes.status).toBe(403);
  });

  it('فایل بزرگ‌تر از ۲ مگابایت، فایل SVG تغییرنام‌یافته (magic-bytes جعلی) و مسیرهای traversal را رد می‌کند', async () => {
    const planner = await createStaff(db, { role: 'NutritionManager', username: 'planner_img' });
    const client = await loginStaff(ctx.app, planner.username, planner.password);

    // ۱) فایل بزرگ‌تر از ۲ مگابایت
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 4096, 0xff);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    oversized[2] = 0xff;
    const bigRes = await client.upload<{ error: { code: string } }>('/api/v1/uploads/food-image', {
      name: 'huge.jpg',
      buffer: oversized,
      mimeType: 'image/jpeg',
    });
    expect(bigRes.status).toBe(400);
    expect(bigRes.body.error.code).toBe('VALIDATION');

    // ۲) SVG مخرب با پسوند و Content-Type جعلی image/jpeg
    const disguisedSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'utf8');
    const svgRes = await client.upload<{ error: { code: string } }>('/api/v1/uploads/food-image', {
      name: 'innocent.jpg',
      buffer: disguisedSvg,
      mimeType: 'image/jpeg',
    });
    expect(svgRes.status).toBe(400);
    expect(svgRes.body.error.code).toBe('VALIDATION');

    // ۳) تلاش برای خواندن فایل‌های غیرمجاز در /uploads
    const trav1 = await ctx.app.inject({ method: 'GET', url: '/uploads/..%2Fpackage.json' });
    expect(trav1.statusCode).toBe(404);
    const trav2 = await ctx.app.inject({ method: 'GET', url: '/uploads/0123456789abcdef0123456789abcdef.svg' });
    expect(trav2.statusCode).toBe(404);
  });

  it('در حالت fallback بدون sharp (پردازنده‌های فاقد AVX2) نیز متادیتای EXIF را از JPEG حذف و فایل را ذخیره می‌کند', async () => {
    const fallbackDir = await mkdtemp(join(tmpdir(), 'food-uploads-fallback-'));
    const fallbackCtx = await buildTestApp({
      UPLOAD_DIR: fallbackDir,
      SHARP_DISABLE: 'true',
    });

    try {
      const manager = await createStaff(db, { role: 'NutritionManager', username: 'kitchen_fallback' });
      const client = await loginStaff(fallbackCtx.app, manager.username, manager.password);

      const baseJpeg = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 180, g: 120, b: 30 } },
      })
        .jpeg({ quality: 80 })
        .toBuffer();
      const withExif = injectFakeExifIntoJpeg(baseJpeg, 'FALLBACK_GPS_EXIF_DATA');

      const res = await client.upload<{
        url: string;
        mimeType: string;
        width: number | null;
        height: number | null;
      }>('/api/v1/uploads/food-image', {
        name: 'kabab.jpg',
        buffer: withExif,
        mimeType: 'image/jpeg',
      });

      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/^\/uploads\/[a-f0-9]{32}\.jpg$/);
      expect(res.body.mimeType).toBe('image/jpeg');
      expect(res.body.width).toBe(400);
      expect(res.body.height).toBe(300);

      const saved = await readFile(join(fallbackDir, res.body.url.replace('/uploads/', '')));
      expect(saved.includes(Buffer.from('FALLBACK_GPS_EXIF_DATA'))).toBe(false);
    } finally {
      await fallbackCtx.close();
      await rm(fallbackDir, { recursive: true, force: true });
    }
  });
});
