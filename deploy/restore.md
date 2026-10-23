# راهنمای بازیابی از نسخهٔ پشتیبان (`deploy/restore.md`)

این راهنما مراحل دقیق بازیابی پایگاه دادهٔ `food_automation` و تصاویر آپلودشدهٔ غذا را در سرور تولیدی دانشگاه شمال شرح می‌دهد.

> **هشدار ایمنی حیاتی:** روی این سرور سایر سرویس‌های زنده (از جمله `shomaldoc` و دیتابیس‌های آن) در حال اجرا هستند. هرگز دستور `systemctl restart postgresql` یا دستوری که دیتابیس‌های دیگر را تغییر دهد اجرا نکنید؛ فقط روی دیتابیس `food_automation` و سرویس‌های `food-api` / `food-worker` عملیات انجام دهید.

---

## ۱. بررسی سلامت فایل پشتیبان پیش از بازیابی

فایل‌های پشتیبان روزانه در مسیر `/var/backups/food/` با مجوز `0600` ذخیره می‌شوند:

```bash
sudo ls -lh /var/backups/food/
sudo pg_restore --list /var/backups/food/db-food_automation-YYYYMMDD-HHMMSS.dump | head -n 30
```

---

## ۲. تمرین بازیابی غیرمخرب روی دیتابیس آزمایشی موقت (توصیه‌شده)

پیش از جایگزینی دیتابیس اصلی، همیشه یک بار بازیابی را روی دیتابیس موقت `food_restore_verify` آزمایش کنید:

```bash
DUMP_FILE="/var/backups/food/db-food_automation-YYYYMMDD-HHMMSS.dump"

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS food_restore_verify;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE food_restore_verify OWNER food_migrator ENCODING 'UTF8' TEMPLATE template0;"
sudo -u postgres pg_restore --no-owner --role=food_migrator -d food_restore_verify "${DUMP_FILE}"

# راستی‌آزمایی معادلهٔ حسابداری دوطرفه (باید 0 برگرداند)
sudo -u postgres psql -d food_restore_verify -Atqc "SELECT COALESCE(SUM(amount_rial), 0) FROM ledger_entries;"

# حذف دیتابیس موقت پس از اطمینان
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE food_restore_verify;"
```

---

## ۳. بازیابی کامل روی محیط تولیدی (Disaster Recovery)

۱. **توقف سرویس‌های اپلیکیشن تغذیه** (برای قطع اتصالات فعال `food_app`):

```bash
sudo systemctl stop food-worker.service food-api.service
```

۲. **گرفتن یک دامپ اضطراری از وضعیت فعلی پیش از بازنویسی**:

```bash
sudo /opt/food/backup.sh || true
```

۳. **بازسازی دیتابیس `food_automation` و بازیابی دامپ**:

```bash
DUMP_FILE="/var/backups/food/db-food_automation-YYYYMMDD-HHMMSS.dump"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'food_automation' AND pid <> pg_backend_pid();
DROP DATABASE food_automation;
CREATE DATABASE food_automation OWNER food_migrator ENCODING 'UTF8' TEMPLATE template0;
SQL

sudo -u postgres pg_restore -v --exit-on-error -d food_automation "${DUMP_FILE}"

sudo -u postgres psql -v ON_ERROR_STOP=1 -d food_automation <<'SQL'
GRANT CONNECT ON DATABASE food_automation TO food_migrator, food_app;
GRANT USAGE ON SCHEMA public TO food_app;
SQL
```

۴. **بازیابی تصاویر غذا (در صورت نیاز)**:

```bash
UPLOADS_ARCHIVE="/var/backups/food/uploads-YYYYMMDD-HHMMSS.tar.gz"
sudo mkdir -p /opt/food/shared/uploads
sudo tar -xzf "${UPLOADS_ARCHIVE}" -C /opt/food/shared/uploads
sudo chown -R food:food /opt/food/shared/uploads
sudo chmod 0750 /opt/food/shared/uploads
```

۵. **اجرای مهاجرت‌های احتمالی جدیدتر و راه‌اندازی مجدد سرویس‌ها**:

```bash
sudo bash -c 'set -a && . /etc/food/app.env && set +a && cd /opt/food/current && /opt/food/node/current/bin/node apps/api/dist/cli/migrate.js'
sudo systemctl start food-api.service food-worker.service
curl -fsS http://127.0.0.1:3101/api/ready
```

۶. **بررسی آشتی‌سازی دفتر کل از پنل امور مالی**:
پس از بالا آمدن سامانه، با نقش `Finance` یا `SuperAdmin` خروجی `GET /api/v1/finance/reconcile` را بررسی کنید تا `healthy: true` گزارش شود.
