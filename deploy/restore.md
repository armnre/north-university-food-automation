# راهنمای پشتیبان‌گیری رمزنگاری‌شده، انتقال خارج از سرور و بازیابی (`deploy/restore.md`)

این راهنما چرخهٔ کامل حفاظت از داده‌های پایگاه دادهٔ `food_automation` و تصاویر آپلودشدهٔ غذا را در سرور تولیدی دانشگاه شمال شرح می‌دهد: تولید کلید `age` خارج از سرور، انتقال برون‌سروری، تمرین خودکار بازیابی (`restore-drill.sh`) و بازیابی اضطراری (Disaster Recovery).

> **هشدار حیاتی ۱ — بدون نسخه‌ی خارج از سرور، بکاپ ناقص است!**
> ذخیرهٔ فایل‌های پشتیبان صرفاً در `/var/backups/food` روی همان سرور تولیدی در برابر خرابی دیسک، باج‌افزار یا حذف کل سرور هیچ حفاظتی ایجاد نمی‌کند. حتماً انتقال خودکار برون‌سروری (`BACKUP_RSYNC_TARGET` یا `BACKUP_SCP_TARGET` یا کشیدن از سرور پشتیبان مجزا) را فعال کنید. اسکریپت‌های `preflight.sh` و `backup.sh` در صورت نبود مقصد برون‌سروری هشدار صریح ثبت می‌کنند.

> **هشدار حیاتی ۲ — هم‌زیستی با سرویس‌های دیگر سرور:**
> روی این سرور سرویس‌های زندهٔ دیگر (از جمله `shomaldoc` روی پورت `3080`) و دیتابیس‌های آن‌ها روی PostgreSQL مشترک فعال هستند. **هرگز** دستور `systemctl restart postgresql` یا دستوری که دیتابیس‌های دیگر را لمس کند اجرا نکنید؛ تمام عملیات فقط روی `food_automation`، `food_restore_test` و سرویس‌های `food-api` / `food-worker` انجام می‌شود.

---

## ۱. تولید جفت‌کلید رمزنگاری `age` (فقط خارج از سرور تولیدی)

فایل‌های بکاپ روزانه با کلید عمومی `age` رمزنگاری می‌شوند. **کلید خصوصی هرگز نباید روی سرور تولیدی قرار گیرد** (اسکریپت `backup.sh` در صورت مشاهدهٔ کلید خصوصی روی سرور با خطا متوقف می‌شود).

۱. روی ایستگاه کاری امن مدیر سیستم یا سرور گاوصندوق آفلاین (نه روی سرور وب دانشگاه)، ابزار `age` را نصب و کلید تولید کنید:

```bash
age-keygen -o food-backup-master.key
chmod 0400 food-backup-master.key
```

۲. فایل `food-backup-master.key` را در دو محل امن و مستقل خارج از سرور (مثلاً گاوصندوق رمزنگاری‌شدهٔ مرکز دادهٔ دانشگاه و حافظهٔ سخت‌افزاری آفلاین) ذخیره کنید.

۳. فقط **کلید عمومی** نمایش‌داده‌شده (رشته‌ای که با `age1...` شروع می‌شود) را در `/etc/food/app.env` سرور تولیدی قرار دهید:

```dotenv
BACKUP_AGE_RECIPIENT=age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BACKUP_RETENTION_DAYS=14
```

---

## ۲. تنظیم انتقال خودکار به خارج از سرور (`rsync` / `scp`)

> **تأکید مجدد: بدون نسخه‌ی خارج از سرور، بکاپ ناقص است.**

دو الگوی استاندارد برای انتقال برون‌سروری وجود دارد:

### الگوی الف (توصیه‌شدهٔ امنیتی — کشیدن از سرور پشتیبان مستقل / Pull)

سرور پشتیبان مجزا (در شبکهٔ داخلی دانشگاه) هر شب ساعت `04:00` با کلید SSH محدود فقط‌خواندنی فایل‌های رمزنگاری‌شدهٔ `.age` و `.sha256` را از سرور تولیدی می‌کشد؛ به این ترتیب حتی در صورت نفوذ به سرور وب، مهاجم به سرور بکاپ دسترسی نوشتن/حذف ندارد:

```bash
rsync -az --ignore-existing root@<SERVER_IP>:/var/backups/food/ /srv/university-backups/food/
(cd /srv/university-backups/food && for f in *.sha256; do sha256sum --check "$f"; done)
```

### الگوی ب (ارسال خودکار از سرور تولیدی با `BACKUP_RSYNC_TARGET` یا `BACKUP_SCP_TARGET`)

یک حساب محدود (`foodbackup`) روی سرور ذخیره‌سازی شبکهٔ دانشگاه (`backup.example.edu`) بسازید، کلید SSH بدون عبارت عبور برای کاربر `root` تنظیم کنید و در `/etc/food/app.env` قرار دهید:

```dotenv
BACKUP_RSYNC_TARGET=foodbackup@backup.example.edu:/srv/backups/north-food/
# یا در صورت نبود rsync در مقصد:
# BACKUP_SCP_TARGET=foodbackup@backup.example.edu:/srv/backups/north-food/
```

در هر اجرای `deploy/backup.sh` (تایمر روزانهٔ `food-backup.timer` در ساعت `03:30`)، فایل‌های زیر تولید، بررسی و ارسال می‌شوند:

- `db-food_automation-YYYYMMDD-HHMMSS.dump.age` (دامپ رمزنگاری‌شده با مجوز `0600`)
- `db-food_automation-YYYYMMDD-HHMMSS.dump.age.sha256` (چک‌سام SHA-256)
- `uploads-YYYYMMDD-HHMMSS.tar.gz.age` و فایل `.sha256` متناظر

---

## ۳. تمرین دوره‌ای و خودکار بازیابی (`deploy/restore-drill.sh`)

بکاپ بدون تست بازیابی قابل اتکا نیست. اسکریپت `/opt/food/restore-drill.sh` دیتابیس موقت `food_restore_test` را می‌سازد، داده‌ها را بازیابی می‌کند و چهار شرط حیاتی را بررسی می‌کند:

1. حضور و شمارش رکوردهای تمام جدول‌های اصلی (`students`, `accounts`, `meal_offerings`, `reservations`, `ledger_transactions`, `ledger_entries`, `payments`, `reservation_reminders`).
2. تراز صفر دفتر کل دوطرفه (`SUM(amount_rial) = 0`) و نبود تراکنش نامتوازن.
3. برابری دقیق `accounts.balance_rial` با مجموع آرتیکل‌های `ledger_entries` هر حساب و نبود موجودی منفی.
4. سلامت قیدهای کلید خارجی (`pg_constraint`) و نبود ردیف‌های یتیم.

سپس دیتابیس موقت `food_restore_test` را به‌طور کامل پاک کرده و نتیجه را در `journald` ثبت می‌کند.

### ۳.۱ اجرای خودکار ماهانه روی سرور (تایمر `food-restore-drill.timer`)

واحد `food-restore-drill.timer` در روز اول هر ماه ساعت `04:15` اجرا می‌شود، چک‌سام آخرین فایل `.dump.age.sha256` را بررسی کرده و چرخهٔ کامل `pg_dump -> pg_restore -> چهار بررسی سلامت` را روی `food_restore_test` آزمایش می‌کند:

```bash
sudo systemctl status food-restore-drill.timer
sudo journalctl -u food-restore-drill.service -n 50 --no-pager
```

### ۳.۲ تمرین کامل رمزگشایی خارج از سرور (توصیه: هر فصل یک‌بار روی ماشین آزمایشی)

روی ماشین آزمایشی دارای PostgreSQL و فایل کلید خصوصی:

```bash
BACKUP_AGE_IDENTITY_FILE=/path/to/food-backup-master.key \
  BACKUP_PG_DIRECT=true \
  ./deploy/restore-drill.sh --encrypted /path/to/db-food_automation-YYYYMMDD-HHMMSS.dump.age
```

---

## ۴. بازیابی کامل در شرایط بحران (Disaster Recovery)

۱. **توقف سرویس‌های اپلیکیشن تغذیه** (بدون دست زدن به `postgresql` یا `shomaldoc`):

```bash
sudo systemctl stop food-worker.service food-api.service
```

۲. **انتقال فایل بکاپ رمزگشایی‌شده به مسیر موقت امن روی سرور**
ابتدا روی ایستگاه کاری امنِ مدیر (که کلید خصوصی `food-backup-master.key` روی آن است)، چک‌سام را بررسی و فایل `.age` را رمزگشایی کنید:

```bash
sha256sum --check db-food_automation-YYYYMMDD-HHMMSS.dump.age.sha256
age -d -i food-backup-master.key \
  -o db-food_automation-decrypted.dump \
  db-food_automation-YYYYMMDD-HHMMSS.dump.age

pg_restore --list db-food_automation-decrypted.dump | head -n 20
scp db-food_automation-decrypted.dump root@<SERVER_IP>:/root/
```

۳. **اجرای تمرین سریع روی `food_restore_test` پیش از جایگزینی دیتابیس اصلی**:

```bash
sudo /opt/food/restore-drill.sh --dump /root/db-food_automation-decrypted.dump
```

۴. **بازسازی دیتابیس `food_automation` و بازیابی دامپ**:

```bash
sudo chmod 0600 /root/db-food_automation-decrypted.dump
sudo chown postgres:postgres /root/db-food_automation-decrypted.dump

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'food_automation' AND pid <> pg_backend_pid();
DROP DATABASE food_automation;
CREATE DATABASE food_automation OWNER food_migrator ENCODING 'UTF8' TEMPLATE template0;
SQL

sudo -u postgres pg_restore -v --no-owner --role=food_migrator --exit-on-error \
  -d food_automation /root/db-food_automation-decrypted.dump

sudo -u postgres psql -v ON_ERROR_STOP=1 -d food_automation <<'SQL'
GRANT CONNECT ON DATABASE food_automation TO food_migrator, food_app;
GRANT USAGE ON SCHEMA public TO food_app;
SQL

sudo shred -u /root/db-food_automation-decrypted.dump
```

۵. **بازیابی تصاویر غذا (در صورت نیاز)**:
فایل `uploads-YYYYMMDD-HHMMSS.tar.gz.age` را روی ایستگاه امن با `age -d` باز کرده، به سرور منتقل کنید و استخراج نمایید:

```bash
sudo mkdir -p /opt/food/shared/uploads
sudo tar -xzf /root/uploads-decrypted.tar.gz -C /opt/food/shared/uploads
sudo chown -R food:food /opt/food/shared/uploads
sudo chmod 0750 /opt/food/shared/uploads
sudo shred -u /root/uploads-decrypted.tar.gz
```

۶. **اجرای مهاجرت‌های احتمالی جدیدتر و راه‌اندازی مجدد سرویس‌ها**:

```bash
sudo bash -c 'set -a && . /etc/food/app.env && set +a && cd /opt/food/current && /opt/food/node/current/bin/node apps/api/dist/cli/migrate.js'
sudo systemctl start food-api.service food-worker.service
curl -fsS http://127.0.0.1:3101/api/ready
```

۷. **تأیید نهایی آشتی‌سازی دفتر کل**:
با نقش `Finance` یا `SuperAdmin` وضعیت `GET /api/v1/finance/reconcile` را بررسی کنید تا `healthy: true` گزارش شود.
