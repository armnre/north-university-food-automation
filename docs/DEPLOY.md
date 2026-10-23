# راهنمای استقرار تولیدی روی سرور دانشگاه شمال (`docs/DEPLOY.md`)

این سند بر اساس مشخصات واقعی سرور دانشگاه شمال و الگوی عملیاتی استاندارد همین سرور (`shomaldoc`) تدوین شده است.

---

## ۱. مشخصات تأییدشدهٔ سرور هدف و اصول عدم تداخل

- **سیستم‌عامل:** Ubuntu 24.04.5 LTS
- **پردازنده:** ۶ هسته `Intel Xeon E5-2670` (معماری Sandy Bridge: دارای `AVX`، **فاقد `AVX2`**)
- **حافظه و دیسک:** حدود `9.7 GiB` رم (`~8.1 GiB` آزاد) + `4 GiB` swap و حدود `81 GB` فضای خالی XFS؛ منطقهٔ زمانی `Asia/Tehran`
- **وب‌سرور و پنل:** Plesk با `nginx` در جلوی Apache
- **سرویس‌های همسایه (خط قرمز عملیاتی):**
  - سرویس `shomaldoc` روی پورت `3080` و سایت‌های استاتیک دیگر (مانند `portal.example.edu`) روی همین سرور فعال هستند. **هرگز** سرویس‌ها، دیتابیس‌ها، Node اختصاصی یا تنظیمات nginx آن‌ها را ویرایش یا ری‌استارت نکنید.
  - **هرگز** از افزونهٔ _Plesk Node.js Toolkit_ استفاده نکنید و Node سیستمی (`v18.19.1`) را تغییر ندهید.
  - **PostgreSQL `16.15`** به صورت مشترک روی `127.0.0.1:5432` و `::1:5432` در حال اجراست؛ هرگز دیتابیس‌ها یا نقش‌های موجود را تغییر ندهید و سرویس `postgresql` را ری‌استارت نکنید.

---

## ۲. معماری چیدمان فایل‌ها و پورت‌ها در سرور

| مؤلفه                                | مسیر / مقدار                                                                        | مالک و مجوز                               |
| ------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| کاربر سیستمی اجرا                    | `food:food` (`/usr/sbin/nologin`)                                                   | بدون دسترسی شل                            |
| باینری ایزولهٔ Node 22 LTS           | `/opt/food/node/current/bin/node`                                                   | `root:root` (`0755`)                      |
| نسخه‌های انتشار و لینک فعال          | `/opt/food/releases/<timestamp>` ← `/opt/food/current`                              | `root:root` (`0755`)                      |
| تصاویر آپلودشدهٔ غذا                 | `/opt/food/shared/uploads`                                                          | `food:food` (`0750`)                      |
| فایل متغیرهای محیطی و اسرار          | `/etc/food/app.env`                                                                 | `root:food` (`0640`)                      |
| پشتیبان‌های روزانه (۱۴ روز نگه‌داری) | `/var/backups/food`                                                                 | `root:root` (`0700` پوشه، `0600` فایل‌ها) |
| پورت داخلی سرویس API                 | `127.0.0.1:3101` (`TRUSTED_PROXY_HOPS=1`)                                           | فقط قابل دسترس از loopback محلی           |
| دیتابیس و نقش‌های PostgreSQL         | دیتابیس `food_automation`، نقش مهاجرت `food_migrator`، نقش اجرایی `food_app`        | جداسازی کامل DDL و DML                    |
| واحدهای systemd                      | `food-api.service`، `food-worker.service`، `food-backup.timer`، `food-health.timer` | سخت‌سازی‌شده (`ProtectSystem=strict`)     |

---

## ۳. انتخاب دامنه و پیکربندی DNS / گواهی TLS

کد سامانه هیچ دامنه‌ای را هاردکد نکرده و صرفاً از متغیر `PUBLIC_BASE_URL` در `/etc/food/app.env` پیروی می‌کند. دو گزینه روی این سرور وجود دارد:

### گزینهٔ الف (توصیه‌شده برای راه‌اندازی فوری): زیردامنهٔ دانشگاهی (`dining.example.edu` / `<YOUR_SUBDOMAIN>`)

1. در صورت وجود گواهی وایلدکارد معتبر دانشگاه (`*.example.edu`) روی سرور، می‌توانید مستقیماً از آن استفاده کنید.
2. یک رکورد `A` برای دامنهٔ سامانه (`<YOUR_SUBDOMAIN>`) به آدرس IP سرور (`<SERVER_IP>`) ثبت کنید.
3. در پنل Plesk زیردامنهٔ موردنظر را ایجاد کرده، گواهی TLS و گزینهٔ _Permanent SEO-safe 301 redirect from HTTP to HTTPS_ را فعال کنید.
4. در `/etc/food/app.env` مقدار `PUBLIC_BASE_URL=https://dining.example.edu` (دامنهٔ واقعی خود) را قرار دهید.

### گزینهٔ ب (دامنهٔ مستقل): دامنهٔ مجزا (`food.example.org` / `<YOUR_DOMAIN>`)

1. اگر دامنهٔ مستقل روی IP سرور (`<SERVER_IP>`) تعریف شده است، ابتدا از فعال بودن رکوردهای DNS (`NS` / `A`) مطمئن شوید.
2. نیم‌سرورها یا رکورد `A` دامنه را به `<SERVER_IP>` متصل کنید و از انتشار سراسری DNS با `dig +short A <YOUR_DOMAIN>` مطمئن شوید.
3. سپس در Plesk گواهی رایگان Let's Encrypt (یا گواهی تجاری واردشده) را برای دامنه صادر و فعال کنید.
4. در `/etc/food/app.env` مقدار `PUBLIC_BASE_URL=https://food.example.org` (دامنهٔ واقعی خود) را قرار دهید.

> **نکتهٔ مهم درگاه زرین‌پال:** دامنهٔ ثبت‌شده در پنل پذیرندگان زرین‌پال برای دریافت `ZARINPAL_MERCHANT_ID` **باید دقیقاً** با دامنهٔ `PUBLIC_BASE_URL` یکسان باشد؛ در غیر این صورت زرین‌پال درخواست ایجاد تراکنش با آدرس بازگشت (`callback_url`) دامنهٔ متفاوت را رد خواهد کرد.

---

## ۴. مراحل استقرار گام‌به‌گام

### گام ۱: ساخت بستهٔ انتشار ازپیش‌کامپایل‌شده (توصیه‌شده — بدون نیاز به اینترنت روی سرور)

از آنجا که دسترسی سرورهای داخل ایران به `registry.npmjs.org`، `github.com` یا `nodejs.org` ممکن است محدود یا ناپایدار باشد، بستهٔ کامل انتشار را روی یک ماشین لینوکس `x86_64` (یا در GitHub Actions) با Node 22 بسازید:

```bash
# روی ماشین ساخت (دارای لینوکس x86_64 و Node 22):
./deploy/build-release.sh
# خروجی: food-release-<sha>.tar.gz

# همچنین در صورت عدم دسترسی سرور به nodejs.org، آرشیو رسمی Node 22 لینوکس را دانلود کنید:
# node-v22.22.3-linux-x64.tar.xz
```

فایل‌های `food-release-<sha>.tar.gz` و (در بار اول) پوشهٔ `deploy/` و آرشیو Node 22 را با `scp` به `/tmp/` سرور منتقل کنید.

### گام ۲: اجرای بررسی پیش‌نیازها (غیرتخریبی)

```bash
sudo bash /tmp/deploy/preflight.sh
```

این اسکریپت فضای دیسک، اجرای PostgreSQL 16 روی پورت `5432`، آزاد بودن پورت `3101` و فعال ماندن `shomaldoc` روی `3080` را بدون هیچ تغییری بررسی می‌کند.

### گام ۳: اجرای اسکریپت آماده‌سازی اولیه (`provision.sh`)

```bash
# اگر آرشیو Node 22 را به سرور منتقل کرده‌اید:
sudo NODE_TARBALL=/tmp/node-v22.22.3-linux-x64.tar.xz PUBLIC_BASE_URL=https://dining.example.edu bash /tmp/deploy/provision.sh

# یا اگر سرور به nodejs.org دسترسی مستقیم دارد:
sudo PUBLIC_BASE_URL=https://dining.example.edu bash /tmp/deploy/provision.sh
```

سپس فایل `/etc/food/app.env` را بازبینی کنید:

- مقدار `SETUP_CODE` تولیدشده را برای ساخت اولین مدیر ارشد یادداشت کنید.
- در صورت آماده بودن مرچنت زرین‌پال، `ZARINPAL_MERCHANT_ID` و `ONLINE_PAYMENT_ENABLED=true` را تنظیم کنید (در غیر این صورت با `ONLINE_PAYMENT_ENABLED=false` بالا بیاورید).
- اگر در مرحلهٔ بعد اسکریپت استقرار هشدار عدم پشتیبانی CPU از باینری `sharp` را چاپ کرد (به‌علت نبود `AVX2` در Xeon E5-2670)، `SHARP_DISABLE=true` را در `/etc/food/app.env` قرار دهید تا مسیر امن پاک‌سازی متادیتای داخلی فعال شود.

### گام ۴: استقرار اتمیک نسخه (`deploy.sh`)

```bash
# روش پیش‌فرض (از بستهٔ آماده بدون نیاز به اینترنت):
sudo bash /tmp/deploy/deploy.sh --tarball /tmp/food-release-<sha>.tar.gz

# روش جایگزین (فقط در صورتی که سرور به GitHub و npm دسترسی کامل دارد):
# sudo bash /opt/food/current/deploy/deploy.sh --git /path/to/repo
```

اسکریپت `deploy.sh` به‌ترتیب:

1. بسته را در `/opt/food/releases/<timestamp>` باز می‌کند.
2. اجرای واقعی `argon2` و `sharp` را روی CPU سرور تست می‌کند.
3. مهاجرت‌های Drizzle را با نقش `food_migrator` و داده‌های پایه (`meal_slots`، `system_settings`، `سلف مرکزی`) را اجرا می‌کند.
4. لینک `/opt/food/current` را به‌صورت اتمیک جابه‌جا کرده و `food-api` و `food-worker` را ری‌استارت می‌کند.
5. پاسخ `http://127.0.0.1:3101/api/ready` را بررسی می‌کند و در صورت بروز خطا به‌طور خودکار به نسخهٔ قبلی Rollback می‌کند.

### گام ۵: اتصال Plesk nginx به پورت داخلی `3101`

> **هشدار:** هرگز فایل‌های تولیدشدهٔ خودکار Plesk (مانند `nginx.conf` در ریشهٔ دامنه) را دستی ویرایش نکنید.

1. در پنل Plesk برای دامنهٔ موردنظر (`dining.example.edu` یا دامنهٔ واقعی دانشگاه) به **Hosting & DNS → Apache & nginx Settings** بروید و تیک **Proxy mode** را بردارید تا درخواست‌ها به Apache ارسال نشوند.
2. فایل نمونهٔ پروکسی را در مسیر استاندارد Plesk کپی و بازآرایی کنید:

```bash
DOMAIN="dining.example.edu" # دامنهٔ واقعی سامانه را جایگزین کنید

sudo nginx -t
sudo cp /opt/food/current/deploy/nginx-vhost_nginx.conf.example "/var/www/vhosts/system/${DOMAIN}/conf/vhost_nginx.conf"
sudo plesk sbin httpdmng --reconfigure-domain "${DOMAIN}"
sudo nginx -t && sudo systemctl reload nginx
```

3. در صورت نیاز به **بازگشت سریع (Rollback)** تنظیمات nginx دامنه:

```bash
sudo rm -f "/var/www/vhosts/system/${DOMAIN}/conf/vhost_nginx.conf"
sudo plesk sbin httpdmng --reconfigure-domain "${DOMAIN}"
sudo nginx -t && sudo systemctl reload nginx
```

---

## ۵. راه‌اندازی اولیهٔ مدیر ارشد و آزمون دود (Smoke Test)

1. آدرس `https://<domain>/api/ready` را باز کنید؛ باید `{"status":"ready","db":"up","migrations":{"ok":true,...}}` برگردد.
2. وارد صفحهٔ اصلی سامانه شوید، زبانهٔ **کارکنان** را انتخاب کنید و با استفاده از مقدار `SETUP_CODE` موجود در `/etc/food/app.env` اولین حساب **مدیر ارشد (`SuperAdmin`)** را بسازید (یا از خط فرمان سرور دستور زیر را اجرا کنید):

```bash
sudo bash -c 'set -a && . /etc/food/app.env && set +a && cd /opt/food/current && /opt/food/node/current/bin/node apps/api/dist/cli/create-admin.js'
```

3. بلافاصله پس از ساخت اولین مدیر ارشد، مقدار `SETUP_CODE=` را در `/etc/food/app.env` خالی کرده و `sudo systemctl restart food-api.service` را اجرا کنید.
4. وضعیت سرویس‌ها و تایمر پشتیبان‌گیری را بررسی کنید:

```bash
systemctl status food-api.service food-worker.service food-backup.timer food-health.timer
journalctl -u food-api.service -u food-worker.service -n 50 --no-pager
```
