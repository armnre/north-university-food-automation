import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';

/** تولید الگوریتمی کد ملی تستی معتبر در حافظه (بدون نوشتن کد ملی خام در کد منبع). */
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

async function buildStudentExcelBuffer(
  rows: Array<{ studentNumber: string; fullName: string; nationalId: string; faculty: string; major: string }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Students');
  ws.addRow(['شماره دانشجویی', 'نام و نام خانوادگی', 'کد ملی', 'دانشکده', 'رشته', 'مقطع', 'سال ورود']);
  for (const r of rows) {
    ws.addRow([r.studentNumber, r.fullName, r.nationalId, r.faculty, r.major, 'کارشناسی', 1402]);
  }
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

async function logoutMobileOrDesktop(page: Page): Promise<void> {
  const mobileMenuBtn = page.getByRole('button', { name: 'باز کردن منو' });
  if (await mobileMenuBtn.isVisible()) {
    await mobileMenuBtn.click();
  }
  await page.getByRole('button', { name: /خروج از حساب/ }).click();
  await expect(page.getByRole('button', { name: 'ورود به سامانه' })).toBeVisible();
}

test.describe('سناریوی سرتاسری کامل سامانهٔ تغذیه (RTL / فارسی / آنلاین و آفلاین)', () => {
  test('۱. ورود دانشجو، رزرو چندغذا با اعتبار، بلیط بدون پیشوند R- و تحویل آنلاین اپراتور', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fa');

    await page.getByLabel('شماره دانشجویی').fill('402123456');
    await page.getByLabel('کد ملی').fill(syntheticNationalId(1));
    await page.getByRole('button', { name: 'ورود به سامانه' }).click();

    await expect(page.getByText(/سلام، سارا/)).toBeVisible();

    // افزودن دو غذای متفاوت در همان وعدهٔ ناهار
    await page.getByRole('link', { name: /رزرو غذا/ }).click();
    const addButtons = page.getByRole('button', { name: 'افزودن' });
    await expect(addButtons).toHaveCount(2);
    await addButtons.nth(0).click();
    await addButtons.nth(0).click();

    // ثبت قطعی با اعتبار موجود در کیف پول
    await page.getByText('جمع فاکتور').click();
    await page.getByRole('button', { name: /ثبت قطعی رزرو/ }).click();
    await expect(page.getByText(/وعده رزرو شد/)).toBeVisible();
    await page.getByRole('button', { name: /مشاهدهٔ رزروها و بستن/ }).click();

    // بررسی صفحهٔ رزروها: عدم وجود دکمهٔ لغو برای دانشجو و دریافت کد ۸ کاراکتری بدون R-
    await page.goto('/reservations');
    await expect(page.getByRole('button', { name: /لغو رزرو/ })).toHaveCount(0);

    await page.getByText('چلوکباب کوبیده زعفرانی').first().click();
    const ticketDialog = page.getByRole('dialog', { name: 'بلیط تحویل غذا' });
    await expect(ticketDialog).toBeVisible();

    const manualCodeText = (await ticketDialog.locator('.font-mono.text-2xl').first().innerText()).trim();
    expect(manualCodeText).toMatch(/^[A-Z2-9]{8}$/);
    expect(manualCodeText.startsWith('R-')).toBe(false);

    await page.getByRole('button', { name: 'بستن بلیط' }).click();
    await logoutMobileOrDesktop(page);

    // ورود اپراتور سلف و تحویل غذا با کد ۸ کاراکتری بدون پیشوند R-
    await page.getByRole('tab', { name: /کارکنان/ }).click();
    await page.getByLabel('نام کاربری').fill('operator1');
    await page.getByLabel('رمز عبور').fill('Operator#2026!');
    await page.getByRole('button', { name: 'ورود کارکنان' }).click();

    const manualInput = page.getByPlaceholder('کد تحویل ۸ کاراکتری یا محتوای QR');
    await expect(manualInput).toBeVisible();
    await manualInput.fill(manualCodeText);
    await page.getByRole('button', { name: 'بررسی' }).click();

    await expect(page.getByText('رزرو معتبر و آماده‌ی تحویل')).toBeVisible();
    await expect(page.getByText(/سارا محمدی/)).toBeVisible();

    await page.getByRole('button', { name: 'ثبت تحویل' }).click();
    await expect(page.getByText('تحویل با موفقیت ثبت شد')).toBeVisible();
  });

  test('۲. چرخهٔ کامل: ایمپورت دانشجو ← ساخت غذا ← رزرو چندغذا با درگاه sandbox ← اسکن آفلاین و همگام‌سازی ← گزارش مدیر', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);

    // گام الف: ورود معاونت دانشجویی و ایمپورت فایل اکسل دانشجوی جدید
    await page.goto('/login');
    await page.getByRole('tab', { name: /کارکنان/ }).click();
    await page.getByLabel('نام کاربری').fill('affairs1');
    await page.getByLabel('رمز عبور').fill('Affairs#2026!');
    await page.getByRole('button', { name: 'ورود کارکنان' }).click();
    await expect(page.getByRole('button', { name: 'ورود کارکنان' })).toBeHidden();

    await page.goto('/import');
    const xlsxBuffer = await buildStudentExcelBuffer([
      {
        studentNumber: '402123456',
        fullName: 'سارا محمدی',
        nationalId: syntheticNationalId(1),
        faculty: 'فنی و مهندسی',
        major: 'مهندسی کامپیوتر',
      },
      {
        studentNumber: '402654321',
        fullName: 'امیر رضایی',
        nationalId: syntheticNationalId(2),
        faculty: 'فنی و مهندسی',
        major: 'مهندسی برق',
      },
    ]);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'students-term.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: xlsxBuffer,
    });
    await page.getByRole('button', { name: 'بررسی و پیش‌نمایش' }).click();
    await expect(page.getByText('امیر رضایی')).toBeVisible();
    await page.getByRole('button', { name: 'تأیید نهایی و ثبت' }).click();
    await page.getByRole('button', { name: 'ثبت نهایی' }).click();
    await expect(page.getByText('واردسازی کامل شد')).toBeVisible();
    await logoutMobileOrDesktop(page);

    // گام ب: ورود مدیر تغذیه و افزودن غذا به کتابخانه
    await page.getByRole('tab', { name: /کارکنان/ }).click();
    await page.getByLabel('نام کاربری').fill('nutrition1');
    await page.getByLabel('رمز عبور').fill('Nutrition#2026!');
    await page.getByRole('button', { name: 'ورود کارکنان' }).click();
    await expect(page.getByRole('button', { name: 'ورود کارکنان' })).toBeHidden();

    await page.goto('/foods');
    await page.getByRole('button', { name: 'غذای جدید' }).click();
    await page.getByLabel('نام غذا').fill('زرشک‌پلو با مرغ مجلسی');
    await page.getByRole('button', { name: /پلویی/ }).click();
    await page.getByRole('button', { name: 'ذخیره' }).click();
    await expect(page.getByText('زرشک‌پلو با مرغ مجلسی')).toBeVisible();
    await logoutMobileOrDesktop(page);

    // گام ج: ورود دانشجوی تازه‌ایمپورت‌شده (موجودی صفر) و تسویهٔ ۲ غذا از طریق درگاه پرداخت آزمایشی (sandbox)
    await page.getByLabel('شماره دانشجویی').fill('402654321');
    await page.getByLabel('کد ملی').fill(syntheticNationalId(2));
    await page.getByRole('button', { name: 'ورود به سامانه' }).click();
    await expect(page.getByText(/سلام، امیر/)).toBeVisible();

    await page.getByRole('link', { name: /رزرو غذا/ }).click();
    const addButtons = page.getByRole('button', { name: 'افزودن' });
    await expect(addButtons).toHaveCount(2);
    await addButtons.nth(0).click();
    await addButtons.nth(0).click();

    await page.getByText('جمع فاکتور').click();
    await page.getByRole('button', { name: 'پرداخت اینترنتی و ثبت رزرو' }).click();

    // صفحهٔ درگاه آزمایشی sandbox -> کلیک روی پرداخت موفق -> هدایت ۳۰۳ به /payment/result
    await expect(page.getByText('درگاه پرداخت آزمایشی')).toBeVisible();
    await page.getByRole('link', { name: 'پرداخت موفق و تکمیل رزرو' }).click();
    await expect(page.getByRole('heading', { name: 'پرداخت تأیید شد' })).toBeVisible();

    // گام د: استخراج هر دو کد تحویل ۸ کاراکتری از صفحهٔ بلیط‌های دانشجو
    await page.goto('/reservations');
    await page.getByText('چلوکباب کوبیده زعفرانی').first().click();
    const dialog1 = page.getByRole('dialog', { name: 'بلیط تحویل غذا' });
    await expect(dialog1).toBeVisible();
    const code1 = (await dialog1.locator('.font-mono.text-2xl').first().innerText()).trim();
    await page.getByRole('button', { name: 'بستن بلیط' }).click();

    await page.getByText('چلوخورش قورمه‌سبزی').first().click();
    const dialog2 = page.getByRole('dialog', { name: 'بلیط تحویل غذا' });
    await expect(dialog2).toBeVisible();
    const code2 = (await dialog2.locator('.font-mono.text-2xl').first().innerText()).trim();
    await page.getByRole('button', { name: 'بستن بلیط' }).click();
    expect(code1).not.toBe(code2);
    await logoutMobileOrDesktop(page);

    // گام هـ: ورود اپراتور سلف، دریافت مانیفست آفلاین، اسکن آنلاین بلیط ۱ و اسکن آفلاین بلیط ۲ با context.setOffline(true)
    await page.getByRole('tab', { name: /کارکنان/ }).click();
    await page.getByLabel('نام کاربری').fill('operator1');
    await page.getByLabel('رمز عبور').fill('Operator#2026!');
    await page.getByRole('button', { name: 'ورود کارکنان' }).click();

    const manualInput = page.getByPlaceholder('کد تحویل ۸ کاراکتری یا محتوای QR');
    await expect(manualInput).toBeVisible();
    await expect(page.getByText(/پشتیبان آفلاین آماده است/)).toBeVisible();

    // اسکن آنلاین بلیط اول
    await manualInput.fill(code1);
    await page.getByRole('button', { name: 'بررسی' }).click();
    await expect(page.getByText('رزرو معتبر و آماده‌ی تحویل')).toBeVisible();
    await page.getByRole('button', { name: 'ثبت تحویل' }).click();
    await expect(page.getByText('تحویل با موفقیت ثبت شد')).toBeVisible();
    await page.getByRole('button', { name: 'اسکن بعدی' }).click();

    // قطع شبکه در سطح مرورگر (Playwright offline mode)
    await context.setOffline(true);
    await expect(page.getByTestId('delivery-connection-badge')).toContainText('آفلاین');
    await expect(page.getByText(/پذیرش آفلاین موقت است/)).toBeVisible();

    // اسکن آفلاین بلیط دوم -> پذیرش موقت و افزوده شدن به صف IndexedDB
    await manualInput.fill(code2);
    await page.getByRole('button', { name: 'اسکن آفلاین' }).click();
    await expect(page.getByText('پذیرش موقت (آفلاین) ثبت شد')).toBeVisible();
    await expect(page.getByText(/امیر رضایی/)).toBeVisible();
    await expect(page.getByTestId('delivery-connection-badge')).toContainText('۱ رویداد در صف');
    await page.getByRole('button', { name: 'اسکن بعدی' }).click();

    // تلاش برای اسکن تکراری همان بلیط در همان دستگاه آفلاین -> جلوگیری فوری
    await manualInput.fill(code2);
    await page.getByRole('button', { name: 'اسکن آفلاین' }).click();
    await expect(page.getByText('این رزرو قبلاً تحویل یا اسکن شده است')).toBeVisible();
    await expect(page.getByTestId('delivery-connection-badge')).toContainText('۲ رویداد در صف');
    await page.getByRole('button', { name: 'اسکن بعدی' }).click();

    // اتصال مجدد شبکه و همگام‌سازی خودکار/دستی صف آفلاین با سرور
    await context.setOffline(false);
    const syncNowBtn = page.getByRole('button', { name: 'همگام‌سازی اکنون' });
    if (await syncNowBtn.isEnabled().catch(() => false)) {
      await syncNowBtn.click();
    }
    await expect(page.getByTestId('delivery-connection-badge')).toContainText('آنلاین · ۰ رویداد در صف', {
      timeout: 15_000,
    });
    await expect(page.getByText('ثبت نهایی در سرور').first()).toBeVisible();
    await logoutMobileOrDesktop(page);

    // گام و: ورود مدیر ارشد و مشاهدهٔ گزارش تجمیعی تحویل‌ها
    await page.getByRole('tab', { name: /کارکنان/ }).click();
    await page.getByLabel('نام کاربری').fill('superadmin1');
    await page.getByLabel('رمز عبور').fill('SuperAdmin#2026!');
    await page.getByRole('button', { name: 'ورود کارکنان' }).click();
    await expect(page.getByRole('button', { name: 'ورود کارکنان' })).toBeHidden();

    await page.goto('/reports');
    await expect(page.getByText('چلوکباب کوبیده زعفرانی').first()).toBeVisible();
    await expect(page.getByText('چلوخورش قورمه‌سبزی').first()).toBeVisible();
  });
});
