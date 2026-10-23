# PROJECT_STATE — وضعیت واقعی و نهایی پروژه

> آخرین به‌روزرسانی: ۲۰۲۶-۱۰-۲۴ (به وقت تهران) · شاخه: `arena/c6f4cb08-north-university-food-automati`
> این فایل وضعیت **واقعی** کار را ثبت می‌کند. هر چه «انجام و اجرا شد» نوشته شده، واقعاً اجرا و راستی‌آزمایی شده است؛ هر چه به دلیل محدودیت محیط اجرا نشده، صریح و صادقانه مستند شده است.

---

## ۱. معماری فعلی نسخهٔ مستقل تولیدی

```text
apps/web              React 18 + Vite 8 + Tailwind 3 + Workbox PWA (فارسی/RTL، صفر لینک خارجی)
apps/api              Fastify 5 + Drizzle ORM + PostgreSQL 16/15 + فرآیند مستقل worker.ts (Node >=22)
packages/shared       نوع‌ها، اسکیماهای Zod، ماتریس RBAC، خطاها، محاسبات ریال/تومان و زمان تهران
packages/components   کامپوننت‌های پایهٔ UI (Radix UI + Tailwind، با tsconfig اختصاصی)
deploy/               اسکریپت‌های preflight، provision، build-release، deploy، backup، systemd و Plesk nginx
docs/                 مستندات کامل بازنویسی‌شدهٔ نسخهٔ مستقل (DEPLOY, PAYMENTS, CANCELLATION, SECURITY, ...)
scripts/              check-no-secrets.mjs، loadtest.ts (autocannon)، screenshots.ts، import-zite-export.ts
.github/workflows/    پایپ‌لاین CI روی Node 22 و ماتریس PostgreSQL 16 و 15 + Playwright E2E
```

---

## ۲. خلاصهٔ فازهای تکمیل‌شده روی این شاخه

### فاز ۱ — تصمیم‌های محصولی A و C و بازطراحی کیف پول (B)

- **تصمیم A (رزرو چندغذایی در یک وعده):** مهاجرت `0002_offering_level_unique.sql` ایندکس قدیمی سطح وعده را حذف و ایندکس یکتای جزئی `reservations_one_live_per_offering` روی `(account_id, offering_id) WHERE status IN ('Reserved', 'Delivered')` را جایگزین کرد؛ کد خطای `DUPLICATE_OFFERING` و رابط کاربری سبد چندغذایی پیاده‌سازی شد.
- **تصمیم C (لغو رزرو):** `student_cancellation_enabled = false` و `noshow_refund = false` به عنوان پیش‌فرض تولیدی تثبیت شدند؛ مسیر HTTP و دکمهٔ لغو دانشجویی حذف شد، اما زیرساخت کامل لغو (`cancelReservationInternal`، لغو اداری با دلیل الزامی، بازپرداخت دسته‌ای `SoldOut`/`Cancelled` و شمارش مجزای `Cancelled` از `NoShow` در گزارش‌ها) حفظ و تست شد. انتخابگر سلف و مهلت لغو از فرم‌های منو مخفی و پیش‌فرض «سلف مرکزی» تنظیم گردید.
- **حذف شارژ کیف پول و برداشت شبا:** مسیرهای شارژ مستقیم کیف پول و برداشت بانکی شبا حذف شدند، `DATA_ENCRYPTION_KEY` اختیاری شد و صفحهٔ کیف پول به نمایشگر «اعتبار بازپرداخت و گردش حساب» تبدیل گردید.

### فاز ۲ — پرداخت مستقیم درگاه زرین‌پال v4 و تسویهٔ اتمیک سبد

- مهاجرت `0003_direct_checkout_payments.sql` و پیاده‌سازی کامل `POST /payments/checkout/start`، `GET /payments/zarinpal/callback` و `POST /payments/result`.
- کسر خودکار اعتبار بازپرداخت قبلی، تسویهٔ فوری بدون درگاه در صورت `payable = 0` و مدیریت دقیق قانون حداقل ۱۰٬۰۰۰ ریال شاپرک (`min_gateway_payable_rial`).
- استعلام اجباری `verify` سمت سرور حتی زمانی که `Status != OK` باشد، پذیرش idempotent کدهای `100` و `101`، تسویهٔ آیتم‌به‌آیتم سبد با `SAVEPOINT` (انتقال مبلغ آیتم‌های تکمیل‌ظرفیت‌شده به اعتبار کیف پول دانشجو) و قفل `NeedsReview` + هشدار و پنل تعیین‌تکلیف امور مالی در صورت خطای زیرساختی پس از تأیید بانک.

### فاز ۳ — فرآیند مستقل پس‌زمینه (`apps/api/src/worker.ts`)

- پیاده‌سازی زمان‌بند مستقل بر مبنای منطقهٔ زمانی `Asia/Tehran` با قفل مشورتی `pg_try_advisory_lock(20261023, lockId)`، ثبت تاریخچه در `job_runs`، لاگ ساخت‌یافته و خاموشی ایمن (`SIGTERM`/`SIGINT`):
  - `markNoShows`، `reconcilePendingPayments` (هر ۱۵ دقیقه)، `deleteExpiredSessions`، `purgeLoginAttempts`، `deleteStaleCaptchas`، `cleanupImportRows` و `reconcileLedger`.

### فاز ۴ — آپلود امن تصویر غذا

- پیاده‌سازی `POST /api/v1/uploads/food-image` با مجوز `foods`، بررسی بایت‌های جادویی واقعی (`JPEG`/`PNG`/`WebP`)، سقف ۲ مگابایت، تغییر اندازه با `sharp` به ≤۱۲۰۰ پیکسل و حذف متادیتای EXIF همراه با مسیر جایگزین امن حذف متادیتا برای پردازنده‌های فاقد `AVX2` (مانند Xeon E5-2670 سرور دانشگاه)، سرو با کش بلندمدت از `/uploads/:fileName` و آپلودر همراه با پیش‌نمایش در `FoodsPage.tsx` و کارت‌های منو.

### فاز ۵ — PWA فارسی/RTL، بلیط تمام‌صفحهٔ ۸ کاراکتری و بهینه‌سازی باندل

- حذف کامل لینک‌های خارجی (فونت محلی `@fontsource-variable/vazirmatn`، لوگوی برداری و آیکن‌های داخلی سبز/طلایی دانشگاه، مانیفست فارسی/RTL و صفحهٔ آفلاین فارسی).
- پیکربندی Workbox (`sw.js`) با استثنا کردن کامل `/api` و `/uploads` از کش، اعلان بروزرسانی نسخه و راهنمای نصب اندروید/iOS.
- بازطراحی دیالوگ بلیط تمام‌صفحه با کد ۸ کاراکتری درشت **بدون پیشوند `R-`**، دکمهٔ کپی و راهنمای نور صفحه؛ پذیرش هر دو حالت با و بدون `R-` در پنل اپراتور.
- بارگذاری تنبل مسیرها (`React.lazy`) و کاهش باندل اولیهٔ JS از ۱٫۱۸ مگابایت به **`79.02 kB` gzip** (`245.95 kB` خام).

### فاز ۶ و ۷ — امنیت، ارتقای Node >=22، رفع آسیب‌پذیری‌ها، آزمون بار و CI

- ارتقای `engines.node` به `>=22.0.0` در هر ۵ پکیج، ارتقا به `Vitest 5.0.5` و صفر کردن کامل آسیب‌پذیری‌های `npm audit` (**`0 vulnerabilities`** در ۹۶۰ پکیج).
- افزودن `scripts/check-no-secrets.mjs` (`npm run secrets:check`)، `scripts/loadtest.ts` (`autocannon`)، `apps/web/playwright.config.ts` + `apps/web/e2e/*` و پایپ‌لاین GitHub Actions در `.github/workflows/ci.yml` (Node 22 + ماتریس PostgreSQL 16 و 15 + Playwright).
- رفع باگ مرزی نیمه‌شب تهران (`23:30..23:59 Asia/Tehran`) در `createDeliverableOffering` تست‌های یکپارچه.

### فاز ۸ — بستهٔ استقرار Plesk / Ubuntu 24.04 و بازنویسی کامل مستندات

- تولید اسکریپت‌های `deploy/{preflight.sh,provision.sh,build-release.sh,deploy.sh,backup.sh,healthcheck.sh,restore.md,nginx-vhost_nginx.conf.example}`، واحدهای سخت‌سازی‌شدهٔ `systemd` (`food-api`, `food-worker`, تایمرهای بکاپ و سلامت) و `logrotate` دقیقاً منطبق بر الگوی عملیاتی سرور دانشگاه شمال (`shomaldoc` روی ۳۰۸۰ دست‌نخورده، سرویس غذا روی `127.0.0.1:3101`، `/opt/food`، `/etc/food/app.env`).
- نگارش `README.md`، `docs/DEPLOY.md`، `docs/PAYMENTS.md`، `docs/CANCELLATION.md` و بازنویسی کامل تمامی مستندات قدیمی `docs/*.md` بدون هیچ وابستگی به Zite.

### تکمیل نهایی — گام ۱ (پاک‌سازی اسرار/دامنه‌ها، مستند تصمیم‌ها، امنیت ورود دانشجو و تولید خودکار RBAC)

- حذف کامل IP واقعی سرور از تمامی فایل‌ها و جایگزینی با `<SERVER_IP>` و دامنه‌های نمونهٔ RFC (`dining.example.edu` / `food.example.org`)؛ گسترش `scripts/check-no-secrets.mjs` برای رد خودکار هرگونه IPv4 عمومی/خصوصی واقعی و دامنه‌های واقعی خارج از فهرست مجاز.
- ایجاد `docs/DECISIONS.md` با شرح ۵ تصمیم کلیدی، کلیدهای دقیق `system_settings` / مهاجرت‌های تغییر و تست‌های وابسته.
- ارتقای `docs/SECURITY.md` با تحلیل صریح ریسک ورود بدون رمز دانشجو و ۵ کنترل جبرانی؛ افزودن `lastLoginAt` و `previousLogin` به `/api/v1/auth/me`، نمایش «آخرین ورود» و مدیریت/ابطال نشست‌های فعال در `ProfilePage.tsx` دانشجو، و افزودن تست یکپارچهٔ اعلان «ورود از دستگاه جدید» (`security.new_login`).
- افزودن `packages/shared/src/rbac-doc.ts` و اسکریپت `npm run docs:rbac` (`scripts/generate-rbac-doc.ts`) برای تولید خودکار `docs/RBAC.md` از منبع واحد `permissions.ts` به همراه تست واحد عدم واگرایی مستندات (`time-and-rbac.test.ts`).

### تکمیل نهایی — گام ۲ (اسکن آفلاین سلف در فرانت‌اند با IndexedDB و همگام‌سازی مقاوم)

- حذف کد تحویل خام از خروجی `GET /api/v1/delivery/offline-manifest` و جایگزینی با زوج هش `qrTokenHash` و `codeHash` (`SHA-256`) با تابع مشترک `normalizeDeliveryToken` در `@food/shared`.
- پیاده‌سازی موتور آفلاین مرورگر در `apps/web/src/lib/offline-delivery.ts` با `idb` و سه store استاندارد (`manifest`، `queue`، `meta`)، هش `crypto.subtle`، به‌روزرسانی خودکار مانیفست در ورود، هر ۵ دقیقه و هنگام بازگشت آنلاین، پذیرش موقت با انسداد اسکن دوم در همان دستگاه، و ثبت تمام اسکن‌های معتبر/نامعتبر با `clientEventId` (UUID v4).
- همگام‌سازی دسته‌ای (حداکثر ۵۰ رویداد در هر درخواست) با backoff نمایی، دکمهٔ «همگام‌سازی اکنون» و اجرای خودکار روی `online` و `visibilitychange`؛ ارتقای کامل `DeliveryPage.tsx` (نشانگر وضعیت و شمارش صف، نوار هشدار «پذیرش آفلاین موقت است»، لیست صف و کارت هشدار تعارض) و افزودن `OfflineConflictsPanel.tsx` به صفحات مدیریتی رزروها و گزارش‌ها.
- راستی‌آزمایی precache شدن چانک `DeliveryPage` در `sw.js` بدون کش شدن `/api`، افزودن ۴ تست واحد `fake-indexeddb` (`apps/web/test/offline-delivery.test.ts`) و تست‌های یکپارچهٔ سرور شامل اسکن هم‌زمان یک بلیت در دو دستگاه آفلاین (`OfflineConflict`).

### تکمیل نهایی — گام ۳ (یادآوری خودکار وعدهٔ غذایی `send-meal-reminders` در کارگر پس‌زمینه)

- افزودن مهاجرت `0004_reservation_reminders.sql` (به‌همراه ثبت در `_journal.json` و اعطای فقط `SELECT, INSERT` به نقش اجرایی `food_app`) و جدول یکتای `reservation_reminders` برای تضمین idempotency کامل.
- پیاده‌سازی سرویس `apps/api/src/services/reminder.service.ts` و ثبت کار `send-meal-reminders` (هر ۱۰ دقیقه، قفل مشورتی `109` و ثبت در `job_runs`) در `worker-jobs.ts`: محاسبهٔ زمان شروع وعده به وقت تهران (`Asia/Tehran`)، فیلتر صرفاً رزروهای `Reserved` در بازهٔ `reminder_hours_before_meal`، ثبت اعلان درون‌برنامه‌ای و صف پیامک در `notification_outbox` در صورت وجود موبایل (و فقط اعلان درون‌برنامه‌ای در صورت نبود موبایل).
- ارتقای `SettingsPage.tsx` برای ویرایش و اعتبارسنجی عددی `reminder_hours_before_meal` و سایر پارامترهای زمانی به همراه جدول وضعیت آخرین اجرای کارهای `food-worker`؛ افزودن تست‌های یکپارچهٔ کامل در `worker.test.ts` و `schema.test.ts`.

### تکمیل نهایی — گام ۴ (آزمون بار و کارایی روی PostgreSQL واقعی، بهینه‌سازی قفل رزرو و `docs/PERF.md`)

- ارتقای `scripts/loadtest.ts` برای اجرای ۵ سناریوی کامل روی PostgreSQL واقعی (`15.18`): واردسازی اکسل ۵٬۰۰۰ سطر (`911 ms` پیش‌نمایش، `906 ms` کامیت) و ۲۰٬۰۰۰ سطر (`2,827 ms` پیش‌نمایش، `3,522 ms` کامیت)، رقابت ۳۰۰ رزرو هم‌زمان روی ظرفیت ۲۰۰ (`200` موفق، `100` رد، `0` موجودی منفی، تراز دفتر کل `0`، **`p95 = 1,320 ms < 1,500 ms`**)، ۱٬۰۰۰ ورود هم‌زمان دانشجو (`333 req/s`، ۰ خطا) + ۱۰۰ ورود هم‌زمان کارکنان Argon2id (`50 req/s` روی ۲ هسته)، ۲٬۰۰۰ خواندن هم‌زمان منو (`250 req/s`، ۰ خطا)، و ۲۰ callback هم‌زمان درگاه پرداخت برای یک پرداخت واحد (`76 ms`، دقیقاً ۱ تراکنش `OnlinePayment` و ۱ رزرو).
- بهینه‌سازی مسیر داغ رزرو و احراز هویت بر مبنای تحلیل گلوگاه و `EXPLAIN (ANALYZE, BUFFERS)`: تجمیع `resolveAuthContext` در یک `LEFT JOIN` تک‌دور و حذف نوشتن مکرر `last_seen_at` در هر درخواست، اجرای دسته‌ای `commitImport` تا ۲۵٬۰۰۰ سطر، و اجرای اتمیک افزایش ظرفیت + دفتر کل + رزرو + تاریخچه + ممیزی + اعلان در یک دستور CTE واحد (`p95` از `3,734 ms` به `1,320 ms` کاهش یافت)؛ ثبت کامل نتایج و مشخصات سخت‌افزار در `docs/PERF.md`.

---

## ۳. نتایج واقعی اجرای تست‌ها و ابزارها در این محیط

| فرمان                              | وضعیت اجرا               | نتیجهٔ واقعی ثبت‌شده                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run secrets:check`            | **اجرا شد**              | موفق (بررسی تمام فایل‌های مخزن؛ ۰ کلید/توکن/لینک خارجی غیرمجاز)                                                                                                                                                                 |
| `npm audit`                        | **اجرا شد**              | **`found 0 vulnerabilities`**                                                                                                                                                                                                   |
| `npm run lint`                     | **اجرا شد**              | **۰ خطا، ۰ هشدار**                                                                                                                                                                                                              |
| `npm run typecheck`                | **اجرا شد**              | **۰ خطا** در هر ۴ ورک‌اسپیس و `tsconfig.scripts.json`                                                                                                                                                                           |
| `npm run test`                     | **اجرا شد**              | **۳۰/۳۰ موفق** (Vitest 5.0.5 — شامل تست‌های آفلاین `fake-indexeddb` و تطبیق خودکار `RBAC.md`)                                                                                                                                   |
| `npm run test:integration`         | **اجرا شد**              | **موفق** روی PostgreSQL ۱۵ واقعی (`embedded-postgres`)                                                                                                                                                                          |
| `npm run loadtest`                 | **اجرا شد**              | موفق روی PostgreSQL 15.18 واقعی: اکسل ۵k (`911ms`/`906ms`) و ۲۰k (`2827ms`/`3522ms`)؛ ۳۰۰ رزرو روی ظرفیت ۲۰۰ (`200` موفق، `p95=1320ms`)؛ ۱٬۰۰۰ ورود دانشجو (`333 req/s`)؛ ۲٬۰۰۰ منو (`250 req/s`)؛ ۲۰ callback درگاه (`1` شارژ) |
| `npm run build`                    | **اجرا شد**              | موفق (`@food/shared`, `@food/api`, `@food/web` PWA + `sw.js`؛ چانک اولیه `79.02 kB` gzip)                                                                                                                                       |
| `bash -n deploy/*.sh`              | **اجرا شد**              | موفق (صحت نحوی تمام اسکریپت‌های استقرار و پشتیبان‌گیری)                                                                                                                                                                         |
| `npm run test:e2e` / `screenshots` | **در این محیط اجرا نشد** | پیکربندی و کد کامل در `apps/web/e2e/` و CI قرار دارد، اما باینری مرورگر Chromium در این محیط سندباکس نصب نیست و دسترسی دانلود باینری مرورگر مسدود است (در GitHub Actions CI اجرا می‌شود)                                        |
| ممیزی Lighthouse                   | **در این محیط اجرا نشد** | به دلیل نبود باینری Chrome/Chromium روی سیستم‌عامل سندباکس قابل اجرا نبود؛ تمامی الزامات فنی PWA (مانیفست، آیکن‌ها، آفلاین، فونت محلی، باندل `<80 kB` gzip، ابعاد لمسی و کنتراست) پیاده‌سازی و با `pwa.test.ts` تست شدند        |
| `docker compose up`                | **در این محیط اجرا نشد** | Docker روی ماشین سندباکس نصب نیست؛ تست‌های دیتابیس با PostgreSQL واقعی `embedded-postgres` اجرا شدند و PostgreSQL 16 نیز در GitHub Actions CI پیکربندی شده است                                                                  |
| استقرار روی سرور Plesk دانشگاه     | **در این محیط اجرا نشد** | دسترسی SSH به سرور دانشگاه (`<SERVER_IP>`) از محیط سندباکس وجود ندارد؛ بستهٔ کامل اسکریپت‌ها و مستندات اجرایی در `deploy/` و `docs/DEPLOY.md` آمادهٔ اجرا توسط مدیر سرور است                                                    |

---

## ۴. تصمیم معماری دربارهٔ مدل `Employee` (مشتریان کارمند / هیئت‌علمی)

جدول `employees` و مسیرهای مرتبط با آن با مجوز محدود (`StudentAffairs` / `SuperAdmin`) در کد حفظ شده‌اند؛ زیرا دانشگاه علاوه بر دانشجویان، به اساتید و کارمندان اداری نیز با تعرفهٔ گروه کاربری مجزا (`Employee` / `Faculty` / `Contractor`) در سلف مرکزی غذا ارائه می‌دهد و حذف آن نیازمند شکستن قیدهای کلید خارجی حساب‌ها در آینده می‌بود. در عین حال در رابط کاربری ورود پیش‌فرض، تمرکز اصلی بر ورود دانشجویان و کارکنان اجرایی حفظ شده است.
