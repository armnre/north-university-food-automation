# PROJECT_STATE — سامانه رزرو غذای دانشگاه شمال

شاخه: `release/postgres-backend` (از کامیت `2dae8eb5e54ecdce6c95d1999992190fbb46e636`)
تگ پشتیبان: `backup/before-revert-20261024` روی `main` قبلی (`4949c21`). `main` دست نخورده؛ force push انجام نشده.

## نقطه‌ی شروع (ممیزی مرحله ۰ — اجراشده واقعی)
- مونوریپوی npm با workspaces `apps/*`, `automations/*`, `packages/*`. تنها اپ: `apps/north-university-food-automation` (React 18 + Vite + Tailwind + shadcn، RTL، PWA).
- `package.json` ریشه فقط `zitejs@0.9.136` و اسکریپت `typecheck: zitejs check` دارد؛ lint/test/CI در این کامیت **وجود ندارد** (CI و e2e در `main` قبلی بود، نه در این کامیت).
- بک‌اند: ۳۷ endpoint در `src/api/*.ts` + منطق مشترک در `src/server/{core,delivery,queries,reserve}.ts` (≈۱۷۶۰ خط). داده در Zite DB با ۱۶ جدول (`zite.schema.json`). ۴۴ فراخوانی `zite.sql` خام.
- ارتباط فرانت: import مستقیم از `zitejs/api` در ۲۴ فایل؛ نشست = توکن مات در `sessionStorage` که به‌عنوان `token` در ورودی هر endpoint فرستاده می‌شود.
- موجود: ورود دانشجو (شماره دانشجویی+کد ملی) و کارکنان، نشست با SHA-256، RBAC، رزرو، کیف پول/دفتر کل، ایمپورت اکسل (پارس سمت کلاینت)، تحویل QR، گزارش‌ها، اعلان، تنظیمات، PWA.
- ناقص/مشکل‌دار:
  - **امنیتی بحرانی:** `studentCheckout` بدون هیچ پرداخت واقعی `OnlinePayment` به کیف پول اعتبار می‌دهد («درگاه آزمایشی») ← باید حذف شود.
  - رزرو با الگوی insert-then-verify (بدون تراکنش/قفل) پیاده شده.
  - لغو، درگاه واقعی، worker، اسکن آفلاین، کارمندان (`Employee`)، قیمت هر گروه، تست، CI، بسته‌ی استقرار وجود ندارد.
- جزئیات: `docs/MIGRATION_MAP.md`.

## محیط اجرای عامل (Zite AI)
- Debian 12، Node 22.23، npm 10.9، ۶۴ هسته. **PostgreSQL نصب نیست** (امکان `embedded-postgres` بررسی می‌شود). SSH به سرور دانشگاه: **ندارم**. مرورگر برای اسکرین‌شات: بررسی نشده.
- push به GitHub از طریق API (اتصال github) انجام می‌شود، نه `git push` مستقیم.

## وضعیت مراحل
| مرحله | وضعیت |
|---|---|
| ۰ بازگشت و ممیزی | انجام شد |
| ۱ پایه‌ی بک‌اند و دیتابیس | **عمدتاً انجام شد** (جزئیات پایین) |
| ۲ احراز هویت، نشست، RBAC | **انجام شد** (به‌جز موارد ذکرشده) |
| ۳ پورت endpointها | **انجام شد** (۳۷/۳۷ + endpointهای جدید؛ موارد باز پایین) |
| ۴ adapter فرانت | **بخش‌های ۱ تا ۳ انجام شد** (جزئیات پایین) |
| ۵ تا ۹ | انجام نشده |

## مرحله ۴ — بخش ۳ (۲۰۲۶-۱۰-۲۴)
- اجرای واقعی: `npm ci`، `tsc` وب (standalone) و `vite build` بدون خطا؛ `tsc` API پس از build پکیج shared بدون خطا؛ ۹ تست واحد و **۴۷/۴۷ تست یکپارچه** روی PostgreSQL واقعی سبز.
- تطبیق خودکار مسیرها: هر ۵۰ مسیر adapter در سرور وجود دارد.
- **باگ رفع‌شده:** نام مجوزهای منوی کارکنان (`finance`، `dashboard`…) با ماتریس RBAC سرور (`financeRead`، `dashboardView`…) نمی‌خواند ← منو برای همه خالی بود. اصلاح در StaffApp/KitchenDashboard/StudentsPage.
- **باگ مالی رفع‌شده:** «برداشت دستی» مبلغ مثبت می‌فرستاد (فیلد direction را سرور نمی‌شناسد) ← اکنون مبلغ علامت‌دار ارسال می‌شود.
- امور مالی با شکل پاسخ جدید (`reconciliation`، `owner`، `balanceAfter`) تطبیق داده شد.
- صفحه‌های جدید: «پرداخت‌های نیازمند بررسی» (واریز/ناموفق با یادداشت، استعلام معلق‌ها) و «کارمندان» (فهرست، جست‌وجو، ساخت/ویرایش، غیرفعال‌سازی، رمز موقت یک‌بارمصرف).
- باقی‌مانده: تطبیق شکل پاسخ سایر صفحه‌ها (داشبورد، گزارش‌ها، رزروها، کاربران…) با اجرای واقعی؛ ساخت گروهی کارمندان در UI؛ e2e.

## مرحله ۴ — بخش ۲ (۲۰۲۶-۱۰-۲۴)
- «بلیط‌های من»: لغو رزرو با تأیید (فقط وقتی لغو فعال و مهلت باقی است؛ بازپرداخت به کیف پول) و صدور کیو‌آر جدید (کیو‌آر قبلی باطل).
- ایمپورت: دکمه‌ی «بازگردانی» فقط روی آخرین دسته‌ی ثبت‌شده، با تأیید؛ وضعیت Undone.
- کامپوننت مشترک ConfirmButton (AlertDialog + toast).
- **حذف بک‌اند قدیمی Zite:** پوشه‌های `src/api` (۳۷ endpoint) و `src/server` حذف شد؛ منطق آن‌ها در `apps/api` است. اپ دیگر روی runtime زایت اجرا نمی‌شود و فقط با `build:standalone` ساخته می‌شود.
- نتیجه: `tsc -p tsconfig.standalone.json` ← فقط دو خطای «qrcode/xlsx در محیط عامل نصب نیست». build/e2e اجرا نشد.
- باقی‌مانده: پنل NeedsReview پرداخت، مدیریت کارمندان، تطبیق شکل پاسخ‌ها با API در حال اجرا.

## مرحله ۴ — بخش ۱ (نتیجه‌ی واقعی، ۲۰۲۶-۱۰-۲۴)
- `src/lib/api.ts`: adapter با همان نام ۳۷ تابع قبلی روی `/api/v1` (کوکی HttpOnly، CSRF دوطرفه با `x-csrf-token`، `ApiError` با code/details، رویداد `session-expired` روی ۴۰۱). همه‌ی importهای `zitejs/api` در صفحه‌ها به adapter تغییر کرد؛ `zitejs/upload` ← `src/lib/upload.ts`.
- `session.tsx`: بدون توکن در sessionStorage؛ وضعیت فقط از `GET /auth/me`؛ کارمند به صفحه‌های سلف‌سرویس نگاشت می‌شود.
- صفحه‌های کم‌شده: کپچا در ورود، زبانه‌ی ورود کارمند، صفحه‌ی تغییر رمز اجباری، صفحه‌ی `/payment/result` بعد از زرین‌پال. پیام «درگاه آزمایشی» حذف شد.
- ایمپورت: فایل `.xlsx` واقعی (multipart) + نگاشت ستون‌ها به سرور فرستاده می‌شود.
- `vite.standalone.config.ts` + اسکریپت‌های `dev:standalone`/`build:standalone`/`typecheck:standalone` (بدون runtime زایت؛ proxy به API).
- نتیجه: `tsc -p tsconfig.standalone.json` روی کل فرانت (بدون src/api و src/server) ← فقط دو خطای «ماژول qrcode/xlsx در محیط عامل نصب نیست» (در package.json اپ هستند). **build کامل و تست e2e اجرا نشد.**
- باقی‌مانده‌ی مرحله ۴: تطبیق شکل پاسخ‌ها صفحه‌به‌صفحه با API در حال اجرا، لغو رزرو و صدور دوباره‌ی QR در فرانت، پنل NeedsReview، مدیریت کارمندان، Undo ایمپورت، حذف `src/api` و `src/server` قدیمی.

## مرحله ۳ — بخش ۲ (نتیجه‌ی واقعی، ۲۰۲۶-۱۰-۲۴)
- ساخته‌شده: finance (دفتر کل + شارژ/تعدیل دستی `MANUAL_CASH` با سقف و idempotency، فقط Finance)، staff و employees (سلسله‌مراتب `canManage`، ایمپورت گروهی کارمند با اعتبارنامه‌ی یک‌بار-نمایش)، admin (داشبورد، دانشجویان، گزارش دانشجو، تغییر وضعیت + ابطال نشست)، audit، لیست رزروها، اعلان‌ها، تنظیمات (فقط SuperAdmin، اعتبارسنجی بازه، audit قبل/بعد)، ایمپورت اکسل سمت سرور با `exceljs` (magic bytes، ۵MB، ۱۰٬۰۰۰ ردیف، پیش‌نمایش جدا، CSV خطا با محافظ injection، قفل batch، تأیید صریح تعارض کد ملی، fullSync فقط Removed، Undo آخرین batch)، پرداخت زرین‌پال v4 (کسر اعتبار، تسویه‌ی بدون درگاه وقتی payable=0، حداقل ۱۰٬۰۰۰ ریال، verify اجباری حتی با Status≠OK، پذیرش ۱۰۰/۱۰۱، SAVEPOINT هر آیتم، NeedsReview + پنل تعیین‌تکلیف، reconcile)، گزارش‌ها (summary، advanced با گزارش هدررفت و بخش مالی فقط برای `reportsFinance`، خروجی CSV/Excel بدون کد ملی)، آپلود تصویر غذا (magic bytes، ۲MB، sharp ≤۱۲۰۰px بدون متادیتا، **مسیر جایگزین بدون sharp** با حذف EXIF، ذخیره خارج از public)، `me/profile` (آخرین ورود قبلی).
- **درگاه آزمایشی کامیت هدف حذف شد:** هیچ مسیری بدون verify موفق یا تعیین‌تکلیف دستی ثبت‌شده در audit اعتبار نمی‌دهد (تست payments).
- `docs/API.md` خودکار از رجیستری (۶۷ route) با `npm run docs:api`.
- نتیجه‌ی واقعی: lint exit 0؛ typecheck بدون خطا؛ تست واحد shared 9/9 و api 9/9؛ **تست یکپارچه روی PostgreSQL 16: ۴۷/۴۷** (شامل ۲۰ callback هم‌زمان ⇒ یک تسویه، verify ناموفق ⇒ بدون اعتبار، NeedsReview، ایمپورت با دو commit هم‌زمان ⇒ یکی، عدم ذخیره‌ی کد ملی خام در students/import_rows/audit، تعارض و Undo، خروجی CSV امن، آپلود SVG جعلی رد).
- باز/اجرا‌نشده: OpenAPI (فعلاً `docs/API.md` جایگزین)، ارتباط واقعی با sandbox زرین‌پال (تست‌ها با gateway جعلی؛ شبکه‌ی واقعی تست نشد)، مسیر بدون sharp فقط تست واحد دارد (روی سرور در preflight آزموده می‌شود)، نمای چاپ RTL گزارش در فرانت (مرحله ۴).

## مرحله ۳ — بخش ۱ (نتیجه‌ی واقعی)
- ساخته‌شده: دفتر کل دوطرفه (`services/ledger.ts`)، موتور رزرو تراکنشی با قفل حساب/وعده و افزایش اتمیک ظرفیت (`services/reserve.ts`)، لغو و بازپرداخت (`services/cancel.ts`)، تحویل exactly-once و manifest آفلاین (`services/delivery.ts`)، مسیرهای `me/*`، `catalog`، `offerings` (قیمت هر گروه، کپی روز/هفته، تمام‌شد/لغو وعده با تایپ «تایید»، دسته‌های ۱۰۰تایی)، لغو اداری رزرو، `delivery/*` (scan، confirm، stats، offline-manifest، sync).
- migration `0002` (ستون‌های پیش‌فرض غذا و `notes` وعده).
- تست یکپارچه روی PostgreSQL 16 → **30/30**، از جمله: ۵۰ رزرو هم‌زمان برای ظرفیت ۱۰ ⇒ دقیقاً ۱۰ موفق؛ کلید idempotency یکسان هم‌زمان ⇒ یک رزرو؛ ناوردایی دفتر کل (مجموع صفر، موجودی = مجموع ورودی‌ها، بدون منفی)؛ لغو غیرفعال به‌صورت پیش‌فرض + IDOR؛ «تمام شد» با بازپرداخت ۱۲۰ رزرو؛ دو تأیید هم‌زمان تحویل ⇒ یکی موفق؛ manifest بدون توکن خام؛ دو دستگاه آفلاین ⇒ Accepted + OfflineConflict؛ ماتریس نقش × route (اکنون با routeهای واقعی مجوزدار فعال است).
- یافته و رفع: درایور drizzle برای SQL خام `timestamptz` را رشته برمی‌گرداند؛ مقایسه‌ی رشته با Date بی‌صدا غلط می‌شد. با `toDate()` در همه‌ی مسیرها اصلاح و با تست پوشش داده شد.
- باقی‌مانده‌ی مرحله ۳: finance، staff/employees، admin، audit، reservations list، notifications، settings، reports/export، imports، payments (زرین‌پال)، uploads.

## مرحله ۲ — نتیجه‌ی واقعی
- `npm run lint` → exit 0؛ `npm run typecheck` → بدون خطا.
- تست واحد api (env، getClientIp) → 7/7.
- `npm run test:integration` روی PostgreSQL 16 واقعی → **21/21**: ورود دانشجو با ارقام فارسی، یکسانی پاسخ موجود/ناموجود، کپچا از تلاش سوم، قفل (شناسه+IP) بدون قفل‌شدن صاحب حساب از IP دیگر، ابطال نشست با تغییر وضعیت، تعویض اجباری رمز + ابطال نشست‌های دیگر، CSRF و Origin، ورود کارمند و logout-all، setup-admin یک‌بار، هدرهای امنیتی، health/ready، پیش‌فرض رد برای route بدون مجوز، ماتریس نقش × route.
- `docs/RBAC.md` خودکار تولید و با `docs:rbac:check` کنترل می‌شود.
- **توجه صادقانه:** در این لحظه همه‌ی routeهای ثبت‌شده `public` یا `authenticated`اند؛ حلقه‌ی بررسی مجوز به‌ازای هر نقش با routeهای مرحله ۳ واقعاً به کار می‌افتد.
- باقی‌مانده: تست «ممنوعیت ساخت حساب هم‌سطح» به endpointهای staff/employees در مرحله ۳ وابسته است (منطق `canManage` در shared تست واحد دارد). تست Argon2id روی CPU بدون AVX2 فقط روی سرور ممکن است.

## مرحله ۱ — نتیجه‌ی واقعی دستورها (۲۰۲۶-۱۰-۲۴، محیط Zite AI)
- `npm run lint` → exit 0
- `npm run typecheck` → بدون خطا (shared + api)
- `npm test` (Vitest، shared) → 9/9 پاس
- `npm run test:integration` روی **PostgreSQL 16 واقعی** (embedded-postgres 16.14) → 8/8 پاس: یکتایی شماره دانشجویی/hash کد ملی، `balance_rial >= 0`، قیود ظرفیت، ایندکس یکتای جزئی رزرو فعال (+ چند غذا در یک وعده، رزرو مجدد پس از لغو)، رد تراکنش نامتوازن در COMMIT، append-only بودن `audit_logs`/`ledger_*` (هم GRANT برای `food_app` هم trigger حتی برای مالک)، ممنوعیت DELETE فیزیکی برای `food_app`.
- `tsc` build → `dist/cli/{migrate,seed,create-admin}.js` بدون نیاز به tsx.

### ساخته‌شده
- `packages/shared`: نرمال‌سازی ارقام، اعتبارسنجی کد ملی، ریال bigint، زمان تهران، ماتریس RBAC + `CAN_MANAGE` + تولید Markdown.
- `apps/api`: اعتبارسنجی env با Zod (در production: sandbox ممنوع، merchant الزامی، https الزامی)، اسکیمای Drizzle (۲۶ جدول)، migrationهای `0000_init` و `0001_integrity` (triggerها و GRANTها)، seed تولیدی idempotent (وعده‌ها، تنظیمات پیش‌فرض، ۴ حساب سیستمی، سلف مرکزی)، Argon2id با hash ساختگی برای هم‌زمان‌سازی.
- ریشه: اسکریپت‌های dev/build/lint/typecheck/format:check/test/test:integration/db:*، eslint 9، prettier، husky، `docker-compose.dev.yml` (فقط توسعه)، `.env.example` خالی.

### هنوز انجام نشده در مرحله ۱
- سرور Fastify (`server.ts`، pino، requestId) ← همراه مرحله ۲.
- دادهٔ دمو برای development و `import-zite-export.ts` (اختیاری).
- جابه‌جایی `apps/north-university-food-automation` به `apps/web` ← مرحله ۴ (با adapter).
- `test:e2e` هنوز placeholder است (مرحله ۶).

## گام بعد
مرحله ۴: adapter فرانت (alias `zitejs/api` ← REST)، حذف Zite، صفحه‌های کم‌شده؛ سپس توقف اجباری ۱.
- مرحله ۴ بخش ۴: تطبیق قرارداد پاسخ‌ها با API واقعی (داشبورد، ایمپورت، تنظیمات، کاربران، اعلان‌ها، رزروها، دانشجویان، گزارش مدیریتی) با probe روی PostgreSQL واقعی.


## feat/production-ready — گام ۱ (۱۴۰۵/۰۸/۰۲)

انتقال: commit از طریق GitHub API (اتصال GitHub در Zite)؛ `git push` در این محیط ممکن نبود چون توکن در shell در دسترس نیست. هیچ توکنی در ریپو نیست.

| مورد | وضعیت |
|---|---|
| worker جدا (`src/worker.ts` → `dist/worker.js`، SIGTERM/SIGINT امن، لاگ pino، زمان‌بندی با ساعت تهران) | نوشته شد؛ **اجرا نشده** |
| قفل `pg_try_advisory_lock` و ثبت هر اجرا در `job_runs` | نوشته شد؛ تست در CI |
| reconcile-pending-payments هر ۱۰ دقیقه (همان `settlePayment` ایدمپوتنت؛ خطای شبکه ⇒ Pending؛ NeedsReview ⇒ هشدار audit) | نوشته شد؛ تست در CI |
| reconcile-ledger و cleanup شبانه | نوشته شد؛ تست در CI |
| mark-no-show، send-meal-reminders، drain-sms-outbox، نمایش آخرین اجرا در UI | **انجام نشد** — گام بعد |
| اسکریپت‌های `dev:worker`، `start`، `start:worker` | اضافه شد |
| CI (`.github/workflows/ci.yml`، ماتریس PostgreSQL 16/15) | در صورت مجوز workflow اضافه شد؛ نتیجه = اولین اجرای Actions |
| `test/integration/worker.test.ts` (بدون callback، اجرای دوباره، callback متأخر، دو worker هم‌زمان، مرز نیمه‌شب تهران) | نوشته شد؛ **محلی اجرا نشد** (دیسک ۱٫۴GB، بدون PostgreSQL) |
| فاز ۱ (راستی‌آزمایی کامل) و فازهای ۳ تا ۱۰ | **انجام نشد** |
