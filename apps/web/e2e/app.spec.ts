import { expect, test } from '@playwright/test';

test.describe('سناریوی سرتاسری دانشجو و اپراتور سلف (RTL / فارسی)', () => {
  test('ورود دانشجو، انتخاب چند غذا در یک وعده، تسویه، نمایش بلیط ۸ کاراکتری بدون R- و تحویل توسط اپراتور', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fa');

    // ورود دانشجو با شماره دانشجویی و کد ملی معتبر (رقم کنترلی صحیح)
    await page.getByLabel('شماره دانشجویی').fill('402123456');
    await page.getByLabel('کد ملی').fill('0010000011');
    await page.getByRole('button', { name: 'ورود به سامانه' }).click();

    await expect(page.getByText(/سلام، سارا/)).toBeVisible();

    // رفتن به منوی غذا و افزودن دو غذای متفاوت در همان وعدهٔ ناهار
    await page.getByRole('link', { name: /رزرو غذا/ }).click();
    const addButtons = page.getByRole('button', { name: 'افزودن' });
    await expect(addButtons).toHaveCount(2);
    await addButtons.nth(0).click();
    await addButtons.nth(0).click();

    // باز کردن سبد و ثبت قطعی با اعتبار بازپرداخت موجود
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

    // خروج از حساب در نمای موبایل
    await page.getByRole('button', { name: 'باز کردن منو' }).click();
    await page.getByRole('button', { name: /خروج از حساب/ }).click();

    // ورود اپراتور سلف و تحویل غذا با کد ۸ کاراکتری بدون پیشوند R-
    await page.getByRole('tab', { name: /کارکنان/ }).click();
    await page.getByLabel('نام کاربری').fill('operator1');
    await page.getByLabel('رمز عبور').fill('Operator#2026!');
    await page.getByRole('button', { name: 'ورود کارکنان' }).click();

    await page.goto('/delivery');
    await page.getByPlaceholder('کد تحویل ۸ رقمی یا محتوای QR').fill(manualCodeText);
    await page.getByRole('button', { name: 'بررسی' }).click();

    await expect(page.getByText('رزرو معتبر و آماده‌ی تحویل')).toBeVisible();
    await expect(page.getByText(/سارا محمدی/)).toBeVisible();

    await page.getByRole('button', { name: 'ثبت تحویل' }).click();
    await expect(page.getByText('تحویل با موفقیت ثبت شد')).toBeVisible();
  });
});
