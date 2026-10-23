import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

/**
 * ثبت اسکرین‌شات از صفحات کلیدی سامانه (نیازمند مرورگر Chromium نصب‌شده توسط Playwright).
 * در محیط‌هایی که باینری مرورگر نصب نشده باشد، بدون تولید دادهٔ ساختگی پیام شفاف چاپ می‌کند.
 */

async function main(): Promise<void> {
  const baseUrl = process.env.SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:3001';
  const outDir = resolve(process.cwd(), 'docs/screenshots');
  await mkdir(outDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    console.warn(
      'باینری مرورگر Chromium در این محیط نصب نیست (برای نصب: npx playwright install chromium). اجرای اسکرین‌شات رد شد:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(0);
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'fa-IR',
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.screenshot({ path: resolve(outDir, 'login-mobile.png'), fullPage: true });
    console.info(`اسکرین‌شات‌ها در مسیر ${outDir} ذخیره شدند.`);
  } finally {
    await browser.close();
  }
}

void main();
