# PROJECT_STATE — وضعیت واقعی پروژه

> آخرین به‌روزرسانی: ۲۰۲۶-۱۰-۲۳ · شاخه: `arena/51e0bded-north-university-food-automati`
> این فایل وضعیت **واقعی** کار را ثبت می‌کند. هر چه «انجام شد» نوشته شده، اجرا و تست شده است؛
> هر چه «انجام نشد» نوشته شده، با دلیل مشخص شده است.

## ۱. معماری فعلی

```
apps/web        React 18 + Vite 8 + Tailwind 3 (فرانت‌اند قبلی، بدون بازنویسی UI)
apps/api        Fastify 5 + Drizzle ORM 0.45 + PostgreSQL 15 (TypeScript strict، ESM)
packages/shared نوع‌ها، اسکیماهای Zod (قرارداد REST)، ماتریس RBAC، توابع دامنه‌ای
packages/components فقط کامپوننت‌های UI واقعاً استفاده‌شده
scripts/        import-zite-export.ts، fix-workspace-hoisting.mjs
docs/           مستندات (API.md بازنویسی شد؛ بقیه در مرحلهٔ ۹ بازنویسی می‌شوند)
```

- وابستگی به Zite **کاملاً حذف** شد: `zitejs` از همهٔ package.jsonها، `zite.*.json`،
  `src/api/*` (۳۷ endpoint زیت)، `src/server/*` و پلاگین‌های Vite.
- لایه‌بندی بک‌اند: `routes` → `services` → `repositories` (منطق کسب‌وکار در route نیست).
- Redis استفاده نمی‌شود؛ محدودیت نرخ ورود، کپچا و قفل‌ها در PostgreSQL پیاده شده‌اند.

## ۲. وضعیت مراحل

### مرحله ۱ — پایه و دیتابیس: **انجام شد**

- ورک‌اسپیس‌ها، `tsconfig.base.json` strict، eslint flat config، prettier، husky + lint-staged،
  `docker-compose.dev.yml`، دو پیکربندی vitest (واحد/یکپارچه).
- اسکیمای ۲۹ جدول با قیدهای واقعی (CHECK، UNIQUE، ایندکس یکتای جزئی
  «یک رزرو فعال در هر (حساب، روز سرویس، وعده)»).
- migration ورژن‌دار: `0000_init` (تولید با drizzle-kit) و `0001_triggers_and_grants`
  (سفارشی): triggerهای append-only برای دفتر کل/ممیزی/تاریچه/تحویل، ممنوعیت حذف فیزیکی
  ۱۹ جدول، constraint trigger تعویق‌پذیر «مجموع صفر هر تراکنش»، همگام‌سازی ستون‌های
  denormalized رزرو، محافظت از تغییر روز/وعده/سلف آیتم منوی دارای رزرو،
  ساخت نقش‌های `food_migrator`/`food_app` با GRANT/REVOKE و `statement_timeout`.
- seed تولیدی idempotent (وعده‌ها، تنظیمات، سلف مرکزی) + seed دمو فقط با
  `NODE_ENV=development` و `ALLOW_DEMO_SEED=true`.
- **۳۱ تست یکپارچه** روی PostgreSQL ۱۵ واقعی همهٔ قیدهای بالا را تأیید می‌کنند
  (شامل تست واقعی GRANTها با اتصال به نقش `food_app`).
- ⚠️ `docker compose up` در این محیط **اجرا نشد** (Docker موجود نیست). به‌جای آن،
  تست‌ها یک PostgreSQL ۱۵ واقعی را از بستهٔ npm `embedded-postgres` راه‌اندازی می‌کنند؛
  `docker-compose.dev.yml` برای توسعه‌دهندگان دارای Docker نوشته شده ولی اجرا نشده است.

### مرحله ۲ — احراز هویت، نشست و RBAC: **انجام شد**

- ورود دانشجو (شمارهٔ دانشجویی + کد ملی HMAC-SHA256 با pepper، `timingSafeEqual`،
  اعتبارسنجی رقم کنترلی، نرمال‌سازی ارقام فارسی/عربی)، ورود کارکنان و کارمندان با
  Argon2id + verify روی hash ساختگی برای نام کاربری ناموجود + rehash خودکار PBKDF2 قدیمی.
- `GET /auth/me`، `logout`، `logout-all`، فهرست/ابطال نشست‌ها، `change-password`
  (حداقل ۱۰ کاراکتر، نامساوی با نام کاربری، ابطال سایر نشست‌ها، تعویض اجباری در اولین ورود)،
  `setup-status`/`setup-admin` با `SETUP_CODE` و CLI `npm run create-admin`.
- محدودیت تلاش: قفل ۵ شکست/۱۵ دقیقه روی **(identifier_hash + IP)**، یکسان بودن رفتار
  شناسهٔ موجود/ناموجود، کپچا از تلاش سوم (شمارندهٔ کلی شناسه)، `auth.suspicious` از ۳۰ شکست،
  تشدید IP (۲۰۰ شکست) بدون مسدودسازی سخت، `getClientIp` با `TRUSTED_PROXY_HOPS`
  از **انتهای** زنجیرهٔ `X-Forwarded-For`.
- کپچای SVG یک‌بارمصرف (ساخت خود سامانه؛ فقط HMAC پاسخ ذخیره می‌شود).
- نشست: توکن ۲۵۶ بیتی، فقط SHA-256 در دیتابیس، انقضای ۱۲/۸ ساعت، تمدید لغزان،
  سقف مطلق ۷ روز، ابطال خودکار هنگام غیرفعال‌سازی/تغییر وضعیت/ریست/تغییر رمز.
- RBAC: ماتریس مجوز در `packages/shared/src/permissions.ts` (تنها منبع حقیقت)،
  محافظت همهٔ مسیرها با `requirePermission` در `preValidation` (پیش‌فرض: رد)،
  سلسله‌مراتب ساخت حساب، تفکیک وظایف (مدیر ارشد `financeWrite` ندارد).
- helmet + CSP سخت‌گیرانه (`default-src 'none'`)، `X-Frame-Options: DENY`، `Referrer-Policy`،
  `Permissions-Policy` با `camera=(self)`، CORS خاموش، bodyLimit/timeout،
  `@fastify/rate-limit` (حافظهٔ پروسه برای مسیرهای عمومی؛ مسیرهای حساس از env).
- **۴۵ تست یکپارچه**: auth (۳۱) + ماتریس کامل نقش × endpoint (۱۴).

### مرحله ۳ — پورت کامل endpointها: **انجام شد**

- همهٔ ۴۳ متد endpoint قدیمی به REST منتقل شدند (جدول مطابقت در `docs/API.md`)
  به‌علاوهٔ مسیرهای جدید برای ویژگی‌های کم‌شده.
- رزرو در **یک تراکنش** با قفل ردیف حساب و وعده، افزایش اتمیک ظرفیت، کسر اتمیک موجودی،
  دفتر کل دوطرفه با `balance_after` و idempotency، و نگاشت نقض ایندکس یکتا به
  «برای این وعده قبلاً رزرو کرده‌اید». الگوی «insert-then-verify» کاملاً حذف شد.
- سبد خرید بدون «اعتبار رایگان»: هر آیتم در تراکنش مستقل، گزارش کسری موجودی.
- تحویل اتمیک (`UPDATE … WHERE status='Reserved' RETURNING`)، ثبت همهٔ تلاش‌ها در `deliveries`،
  بازهٔ اسکن، صف آفلاین با `sha256(token)` و `client_event_id` یکتا، `OfflineConflict`.
- مالی: شارژ/برداشت دستی با دلیل الزامی، سقف از تنظیمات، idempotency، قفل حساب؛
  درگاه زرین‌پال پشت Feature Flag + adapter sandbox (فقط غیر production) + callback
  idempotent + `NeedsReview` با هشدار به مدیر ارشد؛ برداشت وجه با شبا (mod-97 + AES-256-GCM).
- لغو و بازپرداخت، لغو اداری، «تمام شد»/«لغو وعده» با بازپرداخت دسته‌ای ۱۰۰تایی،
  NoShow با job، تنظیمات سیستم با اعتبارسنجی بازه و ممیزی قبل/بعد.
- ایمپورت اکسل سمت سرور با `exceljs` (multipart، فقط xlsx، ≤۵MB، ≤۱۰٬۰۰۰ ردیف، بدون ماکرو)،
  ثبت در یک تراکنش با قفل ردیف دسته، تعارض کد ملی با تأیید صریح، `fullSync` با `Removed`
  و ابطال نشست‌ها، Undo فقط برای ردیف‌های جدید بدون فعالیت، پاک‌سازی ۷ روزه.
- فرانت‌اند: `src/lib/api.ts` (کلاینت fetch تایپ‌شده + CSRF + رویداد ۴۰۱)،
  `session.tsx` از `/auth/me` (حذف `sessionStorage`)، Vite proxy برای `/api`،
  حذف `xlsx` از فرانت، بازنویسی Checkout برای حذف پول رایگان.
- `scripts/import-zite-export.ts` با `--dry-run`، حذف `isDemo`، بررسی یکسانی pepper،
  تبدیل دفتر کل تک‌طرفه به دوطرفه و گزارش تطبیق موجودی هر حساب.
- **۵۱ تست یکپارچه** جدید (جریان‌های کسب‌وکار ۳۵ + ایمپورت ۱۶).

### مرحله ۴ تا ۹: **انجام نشد** (منتظر پیام «ادامه»)

مطابق صورت‌مسئله، کار پس از مرحلهٔ ۳ متوقف شد. بنابراین:

- مرحله ۴ (قواعد کسب‌وکار تکمیلی/پرداخت واقعی/اعلان پیامکی): بخش‌هایی که پیش‌نیاز
  مرحله ۳ بودند پیاده شده‌اند (لغو/بازپرداخت، SoldOut/Cancelled، درگاه پشت flag،
  برداشت وجه، بازهٔ اسکن، NoShow، تنظیمات)؛ اما **صف پیامک کاوه‌نگار، یادآوری وعده،
  UI اختصاصی شارژ/برداشت/کارمندان و QR تمام‌صفحه ساخته نشده‌اند**.
- مرحله ۵ (worker): `src/worker.ts` **نوشته نشده**؛ تابع‌های jobها
  (`markNoShows`, `reconcileLedger`, `reconcilePendingPayments`, `deleteExpiredSessions`,
  `purgeLoginAttempts`, `deleteStaleCaptchas`, `cleanupImportRows`) آماده‌اند اما
  پروسهٔ زمان‌بند و قفل `pg_try_advisory_lock` و جدول `job_runs` هنوز driver ندارند.
- مرحله ۶ (گزارش‌ها/UI جدید/PWA): انجام نشد (صفحه‌های جدید، DataTable، PWA، آفلاین UI).
- مرحله ۷ (تست بار، E2E Playwright، CI): انجام نشد. تست‌های واحد (۲۵) و یکپارچه (۱۲۷) نوشته و اجرا شدند.
- مرحله ۸ (استقرار Plesk/systemd/nginx/backup): انجام نشد.
- مرحله ۹ (بازنویسی همهٔ مستندات، ممیزی امنیتی نهایی، تگ v1.0.0): انجام نشد؛
  فقط `docs/API.md` بازنویسی شد.

## ۳. نتایج واقعی اجرا (در این محیط)

| فرمان                                              | نتیجه                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck` (shared + api + web + scripts) | **۰ خطا**                                                           |
| `npm run lint` (eslint flat)                       | **۰ خطا، ۰ هشدار**                                                  |
| `npm run test` (واحد، vitest)                      | **۲۵/۲۵ موفق**                                                      |
| `npm run test:integration` (PostgreSQL ۱۵ واقعی)   | **۱۲۷/۱۲۷ موفق** (۵ فایل)                                           |
| `npm run build --workspace @food/api` (`tsc`)      | موفق → `apps/api/dist/server.js`                                    |
| `vite build` (فرانت‌اند)                           | موفق → `apps/web/dist` (۱٫۱۸MB JS تک‌chunk؛ کاهش حجم در مرحلهٔ ۶)   |
| `npm run test:e2e`                                 | **اجرا نشد** — Playwright/مرورگر نصب نیست (مرحلهٔ ۷)                |
| `docker compose up`                                | **اجرا نشد** — Docker در این محیط موجود نیست                        |
| تست بار (autocannon/k6)                            | **اجرا نشد** (مرحلهٔ ۷)؛ فقط تست رقابت ۵۰ درخواست هم‌زمان نوشته شده |
| `npm run db:migrate` روی سرور واقعی                | **اجرا نشد** — سرور دانشگاه در دسترس نیست                           |

نکتهٔ محیطی: PostgreSQL در این sandbox با بستهٔ npm `embedded-postgres`
(باینری‌های رسمی PG 15.18) اجرا می‌شود؛ بنابراین تست‌های یکپارچه روی
**PostgreSQL واقعی** و نه mock اجرا شده‌اند.

## ۴. موارد باز / تصمیم‌های لازم از دانشگاه

1. اطلاعات سرور (نسخهٔ Plesk/Ubuntu، Node، PostgreSQL، دامنه، SSL، منابع، سیاست بکاپ).
2. `ZARINPAL_MERCHANT_ID` و تأیید سیاست پرداخت (تا آن زمان `ONLINE_PAYMENT_ENABLED=false`).
3. سرویس پیامک (کاوه‌نگار) و **شمارهٔ موبایل دانشجویان** — جدول `students` ستون موبایل
   ندارد (مطابق صورت‌مسئله)، بنابراین یادآوری پیامکی برای دانشجویان ممکن نیست و
   فقط اعلان درون‌برنامه‌ای ارسال می‌شود.
4. سیاست بازگشت وجه برای `NoShow` (فعلاً: بدون بازگشت وجه).
5. تأیید ریسک «ورود دانشجو بدون رمز» (شمارهٔ دانشجویی + کد ملی کافی است).
6. pepper کد ملی قدیمی (`ZITE_NATIONAL_ID_PEPPER`) برای انتقال داده؛ بدون آن
   `national_id_hash` منتقل نمی‌شود و ورود دانشجویان نیازمند واردسازی مجدد است.

## ۵. بدهی‌های فنی شناخته‌شده

- `src/worker.ts` و زمان‌بندی jobها (مرحلهٔ ۵).
- صفحه‌های جدید UI و PWA/آفلاین سمت کلاینت (مرحلهٔ ۶).
- تست E2E، تست بار و CI (مرحلهٔ ۷).
- `deploy/` (systemd، nginx، backup، deploy.sh) و `docs/DEPLOY.md` (مرحلهٔ ۸).
- بازنویسی بقیهٔ مستندات `docs/` که هنوز از نسخهٔ Zite حرف می‌زنند
  (`ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `RESERVATIONS.md`, `QR_DELIVERY.md`,
  `EXCEL_IMPORT.md`, `WALLET_AND_LEDGER.md`, `RBAC.md`, `TESTING.md`, `OPERATIONS_RUNBOOK.md`).
- باندل فرانت‌اند تک‌chunk و بزرگ است (code-splitting در مرحلهٔ ۶).
- `packages/components` فاقد تست است (کامپوننت‌های shadcn دست‌نخورده).
