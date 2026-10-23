import { expect, test } from '@playwright/test';

test.describe('سناریوی سرتاسری دانشجو و اپراتور سلف (RTL / فارسی)', () => {
  test('ورود دانشجو، انتخاب چند غذا در یک وعده، تسویه، نمایش بلیط ۸ کاراکتری بدون R- و تحویل توسط اپراتور', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fa');

    // ورود دانشجو با شماره دانشجویی و کد ملی
    await page.getByPlaceholder('مثلاً ۴۰۱۱۲۳۴۵۶').fill('402123456');
    await page.getByPlaceholder('۱۰ رقم بدون خط تیره').fill('0010000018');
    await page.getByRole('button', { name: /ورود به سامانه/ }).click();

    await expect(page.getByText('سارا محمدی').first()).toBeVisible();

    // رفتن به منوی غذا و افزودن دو غذای متفاوت در همان وعدهٔ ناهار
    await page.goto('/menu');
    const addButtons = page.getByRole('button', { name: 'افزودن' });
    await expect(addButtons).toHaveCount(2);
    await addButtons.nth(0).click();
    await addButtons.nth(1).click();

    // باز کردن سبد و ثبت قطعی با اعتبار بازپرداخت موجود
    await page.getByRole('button', { name: /جمع فاکتور/ }).click();
    await page.getByRole('button', { name: /ثبت قطعی رزرو/ }).click();

    // بررسی صفحهٔ رزروها: عدم وجود دکمهٔ لغو برای دانشجو و دریافت کد ۸ کاراکتری بدون R-
    await page.goto('/reservations');
    await expect(page.getByRole('button', { name: /لغو رزرو/ })).toHaveCount(0);

    await page.getByRole('button', { name: /کیو‌آر|بلیط/ }).first().click();
    const ticketDialog = page.getByRole('dialog');
    await expect(ticketDialog).toBeVisible();

    const manualCodeText = (await ticketDialog.locator('.tracking-\\[0\\.22em\\]').innerText()).trim();
    expect(manualCodeText).toMatch(/^[A-Z2-9]{8}$/);
    expect(manualCodeText.startsWith('R-')).toBe(false);

    await page.getByRole('button', { name: 'بستن بلیط' }).click();
    await page.getByRole('button', { name: /خروج از حساب/ }).first().click();

    // ورود اپراتور سلف و تحویل غذا با کد ۸ کاراکتری بدون پیشوند R-
    await page.getByRole('tab', { name: /کارکنان/ }).click();
    await page.locator('input[autocomplete="username"]').fill('operator1');
    await page.locator('input[type="password"]').fill('Operator#2026!');
    await page.getByRole('button', { name: /ورود کارکنان/ }).click();

    await page.goto('/delivery');
    await page.getByPlaceholder(/کد تحویل/i).fill(manualCodeText);
    await page.getByRole('button', { name: /بررسی و تحویل|ثبت تحویل/ }).click();

    await expect(page.getByText(/سارا محمدی/)).toBeVisible();
  });
});
