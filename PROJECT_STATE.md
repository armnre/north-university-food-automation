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
| ۳ تا ۹ | انجام نشده |

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
مرحله ۳: پورت endpointها (catalog، offerings، me/menu، رزرو تراکنشی، …).
