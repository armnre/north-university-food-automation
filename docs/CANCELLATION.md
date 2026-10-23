# سیاست لغو رزرو و راهنمای فعال‌سازی مجدد (`docs/CANCELLATION.md`)

بر اساس تصمیم محصولی نسخهٔ اول سامانه اتوماسیون تغذیه دانشگاه شمال، **امکان لغو رزرو توسط خود دانشجو غیرفعال است**، اما **زیرساخت کامل فنی، حسابداری و ممیزی لغو در بک‌اند حفظ و تست شده است** تا هم نیازهای عملیاتی مدیریت پوشش داده شود و هم در صورت تغییر آیین‌نامهٔ دانشگاه در آینده، بدون بازنویسی هستهٔ مالی قابل فعال‌سازی باشد.

---

## ۱. وضعیت فعلی در نسخهٔ اول (Production v1)

1. **سمت دانشجو / کارمند (مشتری سلف):**
   - تنظیم پیش‌فرض سیستم در دیتابیس و کد: `student_cancellation_enabled = false`.
   - مسیر HTTP لغو توسط مشتری (`POST /api/v1/me/reservations/:id/cancel`) از روتر عمومی حذف شده است.
   - تابع سرویس `cancelOwnReservation` در صورت فراخوانی وقتی `student_cancellation_enabled = false` باشد، با خطای `403 FORBIDDEN` درخواست را مسدود می‌کند.
   - در رابط کاربری دانشجو (`MyReservations.tsx` و کارت‌های منو)، دکمهٔ «لغو رزرو» و فیلد `canCancel` حذف شده‌اند و فیلد `cancelDeadline` نیز از فرم تعریف وعده مخفی شده است.

2. **عملیات لغو فعال برای مدیریت و سیستم:**
   - **لغو اداری تک‌رزرو (`POST /api/v1/reservations/:id/cancel`):** کاربران دارای مجوز `reservationCancel` (مانند مدیر تغذیه و مدیر ارشد) می‌توانند با ثبت دلیل الزامی (حداقل ۵ کاراکتر)، رزرو مشخصی را لغو کنند؛ مبلغ دقیق رزرو (`price_at_booking`) به‌صورت خودکار و اتمیک به اعتبار کیف پول دانشجو بازگردانده می‌شود.
   - **بستن اضطراری وعده («تمام شد» / «لغو وعده» — `PATCH /api/v1/offerings/:id/status`):** تغییر وضعیت یک وعده به `SoldOut` (اتمام موجودی آشپزخانه) یا `Cancelled` (لغو وعده) تمام رزروهای فعال (`Reserved`) آن وعده را به‌صورت دسته‌ای لغو کرده، وجه همهٔ آن‌ها را به اعتبار حساب دانشجویان برمی‌گرداند و اعلان فارسی ارسال می‌کند.
   - **گزارش‌گیری تفکیک‌شده:** در تمام گزارش‌های مدیریتی و مالی (`GET /api/v1/reports/summary` و خروجی‌های اکسل/CSV)، تعداد رزروهای `Cancelled` به صورت کاملاً جداگانه از `NoShow` (عدم مراجعه) شمارش و گزارش می‌شود.

---

## ۲. جزئیات زیرساخت حفظ‌شده در بک‌اند

منطق هسته در `apps/api/src/services/reservation.service.ts` (`cancelReservationInternal` و `cancelOwnReservation`) پیاده‌سازی و در `apps/api/test/integration/business.test.ts` به طور کامل روی PostgreSQL واقعی تست شده است:

- بررسی مالکیت حساب (جلوگیری از IDOR با پاسخ `404`).
- جلوگیری از لغو رزروهای تحویل‌شده (`Delivered`)، لغوشدهٔ قبلی (`Cancelled`) یا عدم‌مراجعه (`NoShow`) با قفل ردیف `FOR UPDATE`.
- محاسبهٔ مهلت لغو (`computeCancelDeadline`) به وقت `Asia/Tehran`: اگر `meal_offerings.cancel_deadline` مقدار داشته باشد ملاک است؛ در غیر این صورت `شروع وعده − cancel_cutoff_hours` محاسبه می‌شود.
- کاهش اتمیک `meal_offerings.reserved_count`، ثبت تراکنش بازپرداخت دوطرفه (`CancellationRefund`) در `ledger_transactions` / `ledger_entries`، درج رکورد در `reservation_history` و ثبت لاگ ممیزی در `audit_logs`.

---

## ۳. راهنمای گام‌به‌گام فعال‌سازی لغو دانشجویی در نسخه‌های آینده

اگر دانشگاه تصمیم بگیرد لغو رزرو توسط خود دانشجو (تا پیش از ساعت مهلت مقرر) فعال شود، مراحل زیر کافی است:

1. **فعال‌سازی مسیر HTTP در بک‌اند (`apps/api/src/routes/me.routes.ts`):**
   مسیر `POST /reservations/:id/cancel` را به `cancelOwnReservation(deps, { auth, reservationId, reason, ip })` متصل کنید.
2. **افزودن دکمهٔ لغو در فرانت‌اند (`apps/web/src/pages/student/MyReservations.tsx`):**
   بر اساس تنظیم `student_cancellation_enabled` و نرسیدن به `cancelDeadline`، دکمهٔ لغو همراه با دیالوگ تأیید را برای رزروهای دارای وضعیت `Reserved` نمایش دهید و در صورت نیاز فیلد اختیاری `cancelDeadline` را در `OfferingsPage.tsx` بازگردانید.
3. **فعال‌سازی تنظیم سیستمی از پنل مدیریت (`SettingsPage`):**
   مقدار `student_cancellation_enabled` را به `true` تغییر دهید و `cancel_cutoff_hours` (مثلاً ۲۴ ساعت پیش از شروع وعده) را مطابق آیین‌نامهٔ رفاهی دانشگاه تنظیم نمایید.
4. **اجرای تست‌های یکپارچه:**
   دستور `npm run test:integration` را اجرا کنید (سناریوی تست `زیرساخت لغو دانشجو (وقتی student_cancellation_enabled=true شود)` هم‌اکنون در `business.test.ts` فعال است و صحت بازپرداخت، مهلت شمسی، IDOR و جلوگیری پس از تحویل را راستی‌آزمایی می‌کند).
