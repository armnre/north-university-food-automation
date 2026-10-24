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
| ۱ تا ۹ | انجام نشده |

## گام بعد
مرحله ۱: اسکلت `apps/api` (Fastify 5 + Drizzle) و `packages/shared`، اسکیمای PostgreSQL، migration و تست قیدها روی PostgreSQL واقعی.
