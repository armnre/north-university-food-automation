# کتابچهٔ گام‌به‌گام راهبر سرور (Ubuntu 24.04 + Plesk) — `deploy/ADMIN_RUNBOOK_FA.md`

این راهنمای عملیاتی مخصوص مدیر زیرساخت و راهبر سرور دانشگاه شمال است تا بدون نیاز به دانش داخلی کد، سامانهٔ اتوماسیون تغذیه را به صورت ایمن کنار سرویس‌های موجود سرور نصب، پیکربندی، پایش و نگهداری کند.

---

## قوانین طلایی ایمنی پیش از شروع (هم‌زیستی با سرویس‌های موجود)

1. **عدم لمس سرویس‌های همسایه:** روی سرور `<SERVER_IP>`، سرویس `shomaldoc` روی پورت `3080` و سایر سایت‌های دانشگاه فعال هستند. هرگز تنظیمات، پوشه‌ها یا سرویس‌های آن‌ها را تغییر ندهید.
2. **PostgreSQL 16 مشترک:** هرگز دستور `systemctl restart postgresql` را اجرا نکنید و به دیتابیس‌های دیگر دست نزنید. اسکریپت‌های این پروژه صرفاً دیتابیس `food_automation` (و در تمرین ماهانه `food_restore_test`) و دو نقش `food_migrator` و `food_app` را مدیریت می‌کنند.
3. **عدم استفاده از Plesk Node.js Toolkit:** باینری Node سیستمی سرور (`v18`) دست‌نخورده باقی می‌ماند؛ این سامانه از Node 22 LTS ایزوله در مسیر `/opt/food/node/current` استفاده می‌کند.
4. **پورت داخلی اختصاصی:** سرویس API تغذیه فقط روی `127.0.0.1:3101` شنود می‌کند و از بیرون سرور مسدود است؛ فقط `nginx` مدیریت‌شده توسط Plesk با HTTPS به آن پروکسی می‌کند.

---

## گام ۱: تولید کلید رمزنگاری پشتیبان (`age`) روی کامپیوتر امن مدیر

> **هشدار امنیتی:** کلید خصوصی بکاپ هرگز نباید روی سرور قرار گیرد. اسکریپت `backup.sh` در صورت مشاهدهٔ کلید خصوصی روی سرور متوقف می‌شود.

روی کامپیوتر مدیریتی خود (خارج از سرور):

```bash
age-keygen -o food-backup-master.key
chmod 0400 food-backup-master.key
```

- فایل `food-backup-master.key` را در گاوصندوق امن مرکز داده و یک نسخهٔ آفلاین ذخیره کنید.
- رشتهٔ **کلید عمومی** (که با `age1...` شروع می‌شود) را یادداشت کنید تا در گام ۴ داخل `/etc/food/app.env` قرار دهید.

---

## گام ۲: ساخت بستهٔ انتشار و انتقال به سرور

روی ایستگاه کاری لینوکس (`x86_64` با Node 22) یا از خروجی GitHub Actions، بستهٔ ازپیش‌کامپایل‌شده را بسازید تا سرور ایران نیازی به دسترسی به `npmjs` نداشته باشد:

```bash
./deploy/build-release.sh /tmp/food-release.tar.gz
```

همچنین اگر سرور دسترسی مستقیم به `nodejs.org` ندارد، آرشیو رسمی لینوکس ۶۴ بیتی Node 22 LTS و فایل چک‌سام رسمی آن را دانلود کرده و همراه بسته به سرور منتقل کنید:

```bash
# انتقال بستهٔ برنامه و اسکریپت‌ها به سرور
scp /tmp/food-release.tar.gz root@<SERVER_IP>:/tmp/

# (اختیاری — در صورت محدودیت اینترنت سرور به nodejs.org)
scp node-v22.22.3-linux-x64.tar.xz SHASUMS256.txt root@<SERVER_IP>:/tmp/
```

---

## گام ۳: بررسی پیش‌نیازها (`preflight.sh`) و آماده‌سازی اولیه (`provision.sh`)

وارد سرور شوید (`ssh root@<SERVER_IP>`) و ابتدا بسته را در یک پوشهٔ موقت باز کنید تا اسکریپت‌های استقرار در دسترس قرار گیرند:

```bash
mkdir -p /tmp/food-bootstrap
tar -xzf /tmp/food-release.tar.gz -C /tmp/food-bootstrap

# ۱) بررسی غیرتخریبی وضعیت سرور پیش از نصب
/tmp/food-bootstrap/deploy/preflight.sh || true
```

اکنون `provision.sh` را اجرا کنید (این اسکریپت کاربر `food`، مسیرهای `/opt/food` و `/var/backups/food`، باینری Node 22 با بررسی چک‌سام SHA-256، دیتابیس `food_automation`، فایل `/etc/food/app.env` با مجوز `0640` و تایمرهای `systemd` را نصب می‌کند):

```bash
# حالت الف: اگر فایل آرشیو Node 22 را در گام ۲ به /tmp منتقل کرده‌اید (توصیه‌شده):
sudo NODE_TARBALL=/tmp/node-v22.22.3-linux-x64.tar.xz \
     NODE_SHASUMS_FILE=/tmp/SHASUMS256.txt \
     PUBLIC_BASE_URL=https://dining.example.edu \
     /tmp/food-bootstrap/deploy/provision.sh

# حالت ب: اگر سرور به nodejs.org دسترسی مستقیم دارد:
sudo PUBLIC_BASE_URL=https://dining.example.edu \
     /tmp/food-bootstrap/deploy/provision.sh
```

---

## گام ۴: تکمیل تنظیمات محیطی در `/etc/food/app.env`

فایل `/etc/food/app.env` را با ویرایشگر باز کنید (`sudo nano /etc/food/app.env`) و مقادیر عملیاتی دانشگاه را وارد نمایید:

```dotenv
# ۱. آدرس نهایی سامانه روی اینترنت (دقیقاً مطابق دامنهٔ Plesk، بدون / انتهایی)
PUBLIC_BASE_URL=https://dining.example.edu

# ۲. کلید عمومی بکاپ (از گام ۱) و مقصد انتقال خارج از سرور
# هشدار: بدون نسخه‌ی خارج از سرور، بکاپ ناقص است!
BACKUP_AGE_RECIPIENT=age1...
BACKUP_RSYNC_TARGET=foodbackup@backup.example.edu:/srv/backups/north-food/

# ۳. درگاه پرداخت مستقیم زرین‌پال (در صورت آماده بودن مرچنت دانشگاه)
ONLINE_PAYMENT_ENABLED=true
ZARINPAL_MERCHANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ALLOW_SANDBOX_GATEWAY=false

# ۴. سامانهٔ پیامکی کاوه‌نگار (اختیاری؛ در صورت عدم تنظیم، SMS_PROVIDER=console بماند)
SMS_PROVIDER=kavenegar
KAVENEGAR_API_KEY=...
KAVENEGAR_SENDER=...
```

مقدار تصادفی `SETUP_CODE` را نیز که `provision.sh` تولید کرده یادداشت کنید (فقط برای گام ۶ نیاز دارید):

```bash
sudo grep '^SETUP_CODE=' /etc/food/app.env
```

---

## گام ۵: استقرار اتمیک نسخه (`deploy.sh`)

```bash
sudo /tmp/food-bootstrap/deploy/deploy.sh --tarball /tmp/food-release.tar.gz
```

این اسکریپت:

1. بسته را در `/opt/food/releases/<timestamp>` باز می‌کند.
2. سلامت اجرای `argon2` و `sharp` را روی پردازندهٔ سرور تست می‌کند (اگر هشدار نبود `AVX2` برای `sharp` نمایش داده شد، `SHARP_DISABLE=true` را در `/etc/food/app.env` بگذارید).
3. مهاجرت‌های دیتابیس را با نقش `food_migrator` و داده‌های پایه (وعده‌ها، تنظیمات و سلف مرکزی) را اعمال می‌کند.
4. لینک `/opt/food/current` را اتمیک جابه‌جا کرده و `food-api.service` و `food-worker.service` را بالا می‌آورد.
5. پاسخ `http://127.0.0.1:3101/api/ready` را بررسی می‌کند (و در صورت خطا خودکار به نسخهٔ قبلی برمی‌گردد).

اکنون `preflight.sh` را دوباره اجرا کنید تا مطمئن شوید همهٔ تیک‌ها سبز هستند:

```bash
sudo /opt/food/current/deploy/preflight.sh
```

---

## گام ۶: پیکربندی دامنه، گواهی SSL و پروکسی nginx در Plesk

1. وارد پنل **Plesk** سرور شوید و زیردامنه یا دامنهٔ سامانه (مانند `dining.example.edu`) را در بخش **Websites & Domains** ایجاد کنید.
2. در بخش **SSL/TLS Certificates** همان دامنه:
   - اگر گواهی وایلدکارد معتبر دانشگاه موجود است، آن را انتخاب کنید؛ یا روی **Install a free basic certificate provided by Let's Encrypt** کلیک کنید.
   - گزینهٔ **Permanent SEO-safe 301 redirect from HTTP to HTTPS** را روشن کنید.
3. در تنظیمات دامنه در Plesk، وارد **Apache & nginx Settings** شوید:
   - گزینهٔ **Proxy mode** (ارسال ترافیک به Apache) را **خاموش (Uncheck)** کنید تا تمام ترافیک مستقیماً توسط `nginx` به سرویس Node پروکسی شود.
   - محتوای فایل `/opt/food/current/deploy/nginx-vhost_nginx.conf.example` را در کادر **Additional nginx directives** کپی کنید (یا در مسیر `/var/www/vhosts/system/<DOMAIN>/conf/vhost_nginx.conf` قرار دهید).
4. در خط فرمان سرور، صحت تنظیمات `nginx` را پیش از اعمال آزمایش کنید:

```bash
sudo nginx -t
sudo plesk repair web <YOUR_DOMAIN> -y
# یا در صورت ویرایش مستقیم: sudo systemctl reload nginx
```

5. از مرورگر بیرونی آدرس `https://<YOUR_DOMAIN>/api/ready` را باز کنید؛ باید وضعیت `"status":"ready"` با گواهی HTTPS معتبر دیده شود.

---

## گام ۷: ساخت اولین حساب مدیر ارشد با `SETUP_CODE` و حذف فوری آن (بسیار مهم)

1. آدرس `https://<YOUR_DOMAIN>/login` را در مرورگر باز کنید و زبانهٔ **ورود کارکنان** را انتخاب کنید.
2. سامانه به دلیل نبود هیچ کاربری در حالت «راه‌اندازی اولیه» قرار دارد؛ فرم ساخت اولین **مدیر ارشد (`SuperAdmin`)** نمایش داده می‌شود.
3. نام کاربری، نام کامل، رمز عبور قوی (حداقل ۱۲ کاراکتر) و مقدار `SETUP_CODE` (یادداشت‌شده در گام ۴) را وارد و ثبت کنید.
   - _(روش جایگزین از خط فرمان سرور)_:
     ```bash
     sudo bash -c 'set -a && . /etc/food/app.env && set +a && cd /opt/food/current && /opt/food/node/current/bin/node apps/api/dist/cli/create-admin.js'
     ```
4. **حذف الزامی `SETUP_CODE` بلافاصله پس از ساخت مدیر ارشد:**
   فایل `/etc/food/app.env` را ویرایش کرده و مقدار `SETUP_CODE` را خالی کنید (`SETUP_CODE=`)، سپس سرویس API را ری‌استارت نمایید:

```bash
sudo sed -i 's/^SETUP_CODE=.*/SETUP_CODE=/' /etc/food/app.env
sudo systemctl restart food-api.service
curl -fsS http://127.0.0.1:3101/api/v1/auth/setup-status
```

خروجی دستور آخر باید `{"needsSetup":false,"setupCodeConfigured":false}` باشد. پاک‌سازی پوشهٔ موقت نصب را نیز انجام دهید:

```bash
rm -rf /tmp/food-bootstrap /tmp/food-release.tar.gz
```

---

## گام ۸: دستورات روزمرهٔ پایش، بروزرسانی و پشتیبان‌گیری

```bash
# بررسی وضعیت سرویس‌ها و تایمرها
sudo systemctl status food-api.service food-worker.service food-backup.timer food-restore-drill.timer food-health.timer

# مشاهدهٔ زندهٔ لاگ‌های سرویس API و کارگر پس‌زمینه
sudo journalctl -u food-api.service -u food-worker.service -f

# اجرای دستی پشتیبان‌گیری رمزنگاری‌شده و بررسی خروجی
sudo /opt/food/backup.sh
sudo ls -lh /var/backups/food/

# اجرای دستی تمرین ماهانهٔ بازیابی (بدون اثر روی دیتابیس اصلی)
sudo /opt/food/restore-drill.sh

# بروزرسانی به نسخهٔ جدید در آینده (با حفظ خودکار ۵ نسخهٔ قبلی و Rollback خودکار در خطا)
sudo /opt/food/current/deploy/deploy.sh --tarball /tmp/food-release-new.tar.gz
```
