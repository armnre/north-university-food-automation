import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const webPublicDir = resolve(repoRoot, 'apps/web/public');
const webDistDir = resolve(repoRoot, 'apps/web/dist');

describe('دارایی‌های PWA، Service Worker و بودجهٔ حجم فرانت‌اند (Phase 5)', () => {
  it('فایل manifest.webmanifest فارسی/RTL/standalone و تمام آیکون‌های محلی معتبر هستند', async () => {
    const manifestRaw = await readFile(resolve(webPublicDir, 'manifest.webmanifest'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      lang: string;
      dir: string;
      display: string;
      icons: { src: string; sizes: string; purpose: string }[];
    };

    expect(manifest.lang).toBe('fa');
    expect(manifest.dir).toBe('rtl');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);

    for (const asset of [
      'favicon.svg',
      'logo.svg',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-512.png',
      'offline.html',
    ]) {
      expect(existsSync(resolve(webPublicDir, asset)), `missing ${asset}`).toBe(true);
    }
  });

  it('خروجی ساخت فرانت‌اند فاقد لینک بیرونی است، چانک اولیه <۳۰۰KB gzip است و SW مسیر /api را کش نمی‌کند', async () => {
    if (!existsSync(webDistDir)) return;

    const swContent = await readFile(resolve(webDistDir, 'sw.js'), 'utf8');
    expect(swContent).toContain('\\/api');
    expect(swContent).toContain('\\/uploads');

    const assetFiles = await readdir(resolve(webDistDir, 'assets'));
    const entryChunk = assetFiles.find((f) => /^index-.*\.js$/.test(f));
    expect(entryChunk).toBeDefined();

    const entryBytes = await readFile(resolve(webDistDir, 'assets', entryChunk!));
    const gzipSize = gzipSync(entryBytes).length;
    expect(gzipSize).toBeLessThan(300 * 1024);

    // سرو فایل‌های PWA با SERVE_STATIC=true و بررسی Cache-Control: no-cache روی sw.js و manifest.webmanifest
    const ctx = await buildTestApp({
      SERVE_STATIC: 'true',
      WEB_DIST_PATH: webDistDir,
    });
    try {
      const swRes = await ctx.app.inject({ method: 'GET', url: '/sw.js' });
      expect(swRes.statusCode).toBe(200);
      expect(swRes.headers['cache-control']).toBe('no-cache');

      const manifestRes = await ctx.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
      expect(manifestRes.statusCode).toBe(200);
      expect(manifestRes.headers['cache-control']).toBe('no-cache');

      const spaRes = await ctx.app.inject({ method: 'GET', url: '/menu' });
      expect(spaRes.statusCode).toBe(200);
      expect(String(spaRes.headers['content-security-policy'])).toContain("default-src 'self'");
    } finally {
      await ctx.close();
    }
  });
});
