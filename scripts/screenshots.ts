import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

/**
 * ثبت اسکرین‌شات واقعی از صفحات کلیدی سامانه (نیازمند مرورگر Chromium نصب‌شده توسط Playwright).
 * - در محیط‌هایی که باینری مرورگر قابل نصب نباشد، هرگز تصویر ساختگی تولید نمی‌کند و صادقانه پیام می‌دهد.
 * - در محیط CI (`CI=true`) که مرورگر نصب شده است، سرور آزمون سرتاسری را خودکار بالا آورده و تصاویر RTL واقعی را در `docs/screenshots/` ذخیره می‌کند.
 */

function syntheticNationalId(seed: number): string {
  const nine = String(seed).padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(nine[i]!) * (10 - i);
  }
  const rem = sum % 11;
  const check = rem < 2 ? rem : 11 - rem;
  return `${nine}${check}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* هنوز بالا نیامده است */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`سرور اسکرین‌شات روی ${baseUrl}/api/health در مهلت مقرر آماده نشد.`);
}

async function main(): Promise<void> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (process.env.CI) {
      console.error('خطا در اجرای مرورگر Chromium در محیط CI:', msg);
      process.exit(1);
    }
    console.warn(
      'باینری مرورگر Chromium در این محیط نصب نیست (برای نصب: npx playwright install chromium). هیچ اسکرین‌شات ساختگی تولید نشد:',
      msg,
    );
    process.exit(0);
  }

  const outDir = resolve(process.cwd(), 'docs/screenshots');
  await mkdir(outDir, { recursive: true });

  let serverProc: ChildProcess | null = null;
  let baseUrl = process.env.SCREENSHOT_BASE_URL?.trim() ?? '';

  try {
    if (!baseUrl) {
      const port = await findFreePort();
      baseUrl = `http://127.0.0.1:${port}`;
      serverProc = spawn(process.execPath, ['--import', 'tsx', 'apps/web/e2e/start-e2e-server.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, E2E_PORT: String(port) },
        stdio: 'inherit',
      });
      await waitForHealth(baseUrl);
    }

    // ۱. نماهای موبایل دانشجو و اپراتور (RTL)
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'fa-IR',
      timezoneId: 'Asia/Tehran',
    });
    const mPage = await mobileCtx.newPage();

    await mPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await mPage.screenshot({ path: resolve(outDir, '01-login-mobile.png'), fullPage: true });

    await mPage.getByLabel('شماره دانشجویی').fill('402123456');
    await mPage.getByLabel('کد ملی').fill(syntheticNationalId(1));
    await mPage.getByRole('button', { name: 'ورود به سامانه' }).click();
    await mPage.getByText(/سلام، سارا/).waitFor({ state: 'visible' });
    await mPage.screenshot({ path: resolve(outDir, '02-student-dashboard-mobile.png'), fullPage: true });

    await mPage.getByRole('link', { name: /رزرو غذا/ }).click();
    await mPage.getByRole('button', { name: 'افزودن' }).first().click();
    await mPage.screenshot({ path: resolve(outDir, '03-student-menu-cart-mobile.png'), fullPage: true });

    await mPage.getByText('جمع فاکتور').click();
    await mPage.getByRole('button', { name: /ثبت قطعی رزرو/ }).click();
    await mPage.getByRole('button', { name: /مشاهدهٔ رزروها و بستن/ }).click();

    await mPage.goto(`${baseUrl}/reservations`, { waitUntil: 'networkidle' });
    await mPage.getByText('چلوکباب کوبیده زعفرانی').first().click();
    await mPage.getByRole('dialog', { name: 'بلیط تحویل غذا' }).waitFor({ state: 'visible' });
    await mPage.screenshot({ path: resolve(outDir, '04-student-qr-ticket-mobile.png') });
    await mPage.getByRole('button', { name: 'بستن بلیط' }).click();

    await mPage.getByRole('button', { name: 'باز کردن منو' }).click();
    await mPage.getByRole('button', { name: /خروج از حساب/ }).click();

    await mPage.getByRole('tab', { name: /کارکنان/ }).click();
    await mPage.getByLabel('نام کاربری').fill('operator1');
    await mPage.getByLabel('رمز عبور').fill('Operator#2026!');
    await mPage.getByRole('button', { name: 'ورود کارکنان' }).click();
    await mPage.getByPlaceholder('کد تحویل ۸ کاراکتری یا محتوای QR').waitFor({ state: 'visible' });
    await mPage.getByText(/پشتیبان آفلاین آماده است/).waitFor({ state: 'visible' });
    await mPage.screenshot({ path: resolve(outDir, '05-operator-delivery-online-mobile.png'), fullPage: true });

    await mobileCtx.setOffline(true);
    await mPage.getByText(/پذیرش آفلاین موقت است/).waitFor({ state: 'visible' });
    await mPage.screenshot({ path: resolve(outDir, '06-operator-delivery-offline-mobile.png'), fullPage: true });
    await mobileCtx.setOffline(false);
    await mobileCtx.close();

    // ۲. نمای دسکتاپ پنل مدیریت ارشد
    const desktopCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'fa-IR',
      timezoneId: 'Asia/Tehran',
    });
    const dPage = await desktopCtx.newPage();
    await dPage.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
    await dPage.getByRole('tab', { name: /کارکنان/ }).click();
    await dPage.getByLabel('نام کاربری').fill('superadmin1');
    await dPage.getByLabel('رمز عبور').fill('SuperAdmin#2026!');
    await dPage.getByRole('button', { name: 'ورود کارکنان' }).click();
    await dPage.getByRole('heading', { name: 'داشبورد مدیریتی' }).waitFor({ state: 'visible' });
    await dPage.screenshot({ path: resolve(outDir, '07-admin-dashboard-desktop.png'), fullPage: true });
    await desktopCtx.close();

    console.info(`۷ اسکرین‌شات واقعی در مسیر ${outDir} ذخیره شد.`);
  } finally {
    await browser.close();
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
    }
  }
}

void main();
