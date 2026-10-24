# گزارش واقعی تست اسکریپت‌ها و بستهٔ استقرار (`docs/DEPLOY_TEST_LOG.md`)

این سند خروجی واقعی تست‌هایی را که روی اسکریپت‌های پوشهٔ `deploy/` در محیط ساخت فعلی اجرا شده‌اند ثبت می‌کند و مواردی را که به دلیل محدودیت زیرساخت محیط آزمون قابل اجرا نبوده‌اند به‌صورت شفاف با وضعیت **«اجرا نشد»** مشخص می‌سازد.

---

## ۱. جدول خلاصهٔ وضعیت تست‌های استقرار

| مورد آزمون                                                               | وضعیت                       | جزئیات و علت                                                                                                                                                             |
| ------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| بررسی نحوی شل (`bash -n deploy/*.sh`)                                    | **اجرا شد (موفق)**          | هر ۷ اسکریپت (`preflight.sh`, `provision.sh`, `build-release.sh`, `deploy.sh`, `backup.sh`, `restore-drill.sh`, `healthcheck.sh`) بدون خطای نحوی                         |
| اجرای `deploy/preflight.sh` در محیط محلی                                 | **اجرا شد (موفق در تشخیص)** | تشخیص صحیح دیسک (`19GB`)، پردازندهٔ Xeon، Node `v22.22.3`، اجرای واقعی `argon2` و `sharp`، و تشخیص دقیق نبود `5432`/`nginx`/`age` و هشدار نبود مقصد بکاپ برون‌سروری      |
| ساخت بستهٔ انتشار تولیدی (`deploy/build-release.sh`)                     | **اجرا شد (موفق)**          | تولید بستهٔ مستقل `53 MB` با `npm ci --omit=dev`، `0 vulnerabilities`، بازسازی `argon2`/`sharp` و ساخت کامل PWA (`sw.js` با ۹۷ فایل precache)                            |
| استخراج بستهٔ انتشار خارج از مخزن + اجرای تولیدی (`NODE_ENV=production`) | **اجرا شد (موفق)**          | اجرای واقعی `dist/cli/migrate.js` (هر ۵ مهاجرت)، `dist/cli/seed.js` (۱۴ تنظیم، ۳ وعده، سلف مرکزی) و `dist/server.js` با `SERVE_STATIC=true` روی PostgreSQL واقعی         |
| تست منطق `deploy/backup.sh` و `deploy/restore-drill.sh`                  | **اجرا شد (موفق)**          | ۳ سناریوی کامل خودکار در `apps/api/test/unit/deploy-backup.test.ts` (رمزنگاری، `.sha256`، نگه‌داری ۱۴ روزه، رد کلید خصوصی روی سرور، محافظت نام دیتابیس و بررسی تراز صفر) |
| اجرای کامل `sudo ./deploy/provision.sh` روی Ubuntu 24.04                 | **اجرا نشد**                | محیط سندباکس فاقد دسترسی `root` واقعی به `systemd`، کاربر سیستمی `postgres` و بسته‌های سیستم‌عامل سرور هدف است                                                           |
| اجرای `sudo ./deploy/deploy.sh` با جابه‌جایی واحدهای `systemd`           | **اجرا نشد**                | سرویس‌دهندهٔ `systemd` (`systemctl restart food-api.service`) در محیط کانتینر سندباکس فعال نیست (منطق مهاجرت، seed و سرور داخل بسته به‌صورت مستقیم تست شد)               |
| تست `vhost_nginx.conf`، `nginx -t` و پنل Plesk                           | **اجرا نشد**                | باینری‌های `nginx` و `plesk` در محیط سندباکس نصب نیستند و دسترسی شبکه/SSH به سرور دانشگاه (`<SERVER_IP>`) وجود ندارد                                                     |
| اجرای `docker compose -f docker-compose.dev.yml up`                      | **اجرا نشد**                | باینری و دیمن `docker` روی ماشین سندباکس نصب نیست                                                                                                                        |

---

## ۲. خروجی واقعی اجرای `deploy/preflight.sh` در محیط آزمون

فرمان اجراشده:

```bash
FOOD_NODE_BIN="$(command -v node)" FOOD_RELEASE_DIR="$(pwd)" ./deploy/preflight.sh
```

خروجی واقعی ثبت‌شده:

```text
=== ۱. سیستم‌عامل، زمان و منابع سخت‌افزاری ===
  [OK]   سیستم‌عامل: Debian GNU/Linux 12 (bookworm)
  [WARN] منطقهٔ زمانی سرور 'Etc/UTC' است (پیشنهاد: Asia/Tehran؛ البته کد برنامه صراحتاً با Asia/Tehran محاسبه می‌کند)
  [OK]   فضای خالی دیسک روی /opt: حدود 19GB
  [OK]   فضای خالی مسیر پشتیبان (/var/backups): حدود 19GB
  [OK]   پردازنده: Intel(R) Xeon(R) Processor @ 2.60GHz (AVX2=avx2)
=== ۲. بررسی عدم تداخل پورت‌ها و سرویس‌های همسایه ===
  [OK]   پورت داخلی 127.0.0.1:3101 آزاد است
=== ۳. بررسی PostgreSQL محلی (بدون تغییر دیتابیس‌ها) ===
  [FAIL] پورت 5432 فعال نیست؛ سرویس postgresql را بررسی کنید
  [WARN] ابزار psql یا کاربر postgres برای بررسی دقیق نسخه در دسترس نیست
=== ۴. بررسی Node.js اختصاصی ۲۲ و ماژول‌های بومی (argon2 / sharp) ===
  [OK]   باینری اختصاصی Node.js یافت شد: /usr/local/bin/node (v22.22.3)
  [OK]   تست اجرای واقعی argon2 روی CPU سرور موفقیت‌آمیز بود
  [OK]   تست اجرای واقعی sharp روی CPU سرور موفقیت‌آمیز بود
=== ۵. بررسی nginx و Plesk ===
  [FAIL] nginx یافت نشد
  [WARN] ابزار Plesk در PATH نیست (در صورت سرور غیر Plesk نادیده بگیرید)
=== ۶. بررسی ابزار رمزنگاری بکاپ (age) و مقصد پشتیبان خارج از سرور ===
  [WARN] ابزار age هنوز نصب نیست (توسط provision.sh یا با دستور apt-get install -y age نصب می‌شود)
  [WARN] متغیر BACKUP_AGE_RECIPIENT هنوز در /etc/food/app.env تنظیم نشده است (پیش از فعال‌سازی بکاپ شبانه الزامی است)
  [WARN] مقصد انتقال خارج از سرور (BACKUP_RSYNC_TARGET / BACKUP_SCP_TARGET) تنظیم نشده است — بدون نسخه‌ی خارج از سرور، بکاپ ناقص است!
نتیجه: 2 مورد خطای بحرانی شناسایی شد.
```

---

## ۳. خروجی واقعی ساخت و اجرای مستقل بستهٔ تولیدی (`deploy/build-release.sh`)

بستهٔ انتشار تولیدی با `./deploy/build-release.sh` ساخته شد (`53 MB`، `558` پکیج تولیدی بدون وابستگی‌های توسعه، `found 0 vulnerabilities`)، در مسیر موقت خارج از مخزن استخراج گردید و با `NODE_ENV=production` و `SERVE_STATIC=true` به PostgreSQL واقعی متصل شد:

```text
MIGRATE: مهاجرت پایگاه داده… (postgres://food_smoke:***@127.0.0.1:55491/food_automation?sslmode=disable)
فایل‌های migration: 0000_init.sql, 0001_triggers_and_grants.sql, 0002_offering_level_unique.sql, 0003_direct_checkout_payments.sql, 0004_reservation_reminders.sql
انجام شد. 5 migration اعمال شده است (موجود: 5).
SEED: seed تولیدی انجام شد: {"mealSlots":3,"settings":14,"cafeteriaCreated":true}
READY: 200 {"status":"ready","database":"up","migrations":{"applied":5,"available":5},"worker":{"lastRunAt":null}}
SETUP_STATUS: 200 {"needsSetup":true,"setupCodeConfigured":true}
MANIFEST: 200 application/manifest+json
SW: 200 6213 bytes
```
