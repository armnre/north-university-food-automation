# DEPLOYMENT — Plesk / Ubuntu

**وضعیت: انجام نشده.** بک‌اند فعلی روی Zite اجرا می‌شود و هنوز نسخه‌ی مستقل Node.js ساخته نشده؛ این سند برنامه‌ی هدف است و هیچ مرحله‌ای از آن تأییدشده نیست.

اطلاعات موردنیاز از سرور (هنوز دریافت نشده): نسخه‌ی Plesk و Ubuntu، Node.js موجود (هدف: 20 LTS)، دسترسی SSH، PostgreSQL (هدف 15+)، دامنه/SSL، منابع.

مراحل هدف:
1. کاربر لینوکس اختصاصی، `git clone`، `npm ci`
2. PostgreSQL: دیتابیس و کاربر با حداقل مجوز؛ `DATABASE_URL` فقط در env بک‌اند
3. `npm run build -w web` → فایل‌های استاتیک در document root (Plesk)
4. `npm run build -w api` → `node dist/server.js` با systemd (یا Plesk Node.js extension)
5. Migration نسخه‌بندی‌شده (`drizzle-kit generate` + `migrate`؛ نه `push`) پس از بکاپ
6. Reverse proxy در Plesk (nginx) از `/api` به `127.0.0.1:PORT`؛ پورت داخلی بسته در فایروال
7. SSL با Let's Encrypt در Plesk
8. Health check: `GET /api/health`
9. بکاپ: `pg_dump` روزانه + نگهداری ۱۴ روز + تست بازیابی ماهانه
10. Rollback: نگه‌داشتن build قبلی، migration معکوس یا بازیابی بکاپ
