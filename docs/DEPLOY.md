# راهنمای استقرار روی سرور Plesk / Ubuntu

این راهنما سامانه را **کنار سایت‌های دیگر سرور** بالا می‌آورد، بدون اینکه به آن‌ها دست بزند:

| چیز | محل | اثر روی بقیه سایت‌ها |
|---|---|---|
| کد برنامه | `/opt/food-automation` (کاربر `foodapp`) | ندارد |
| تنظیمات محرمانه | `/etc/food-automation.env` | ندارد |
| بک‌اند و ورکر | سرویس‌های `food-api` و `food-worker` روی `127.0.0.1:3101` (از بیرون باز نیست) | ندارد |
| دیتابیس | `food_automation` با نقش‌های `food_app` و `food_migrator` | ندارد |
| فایل‌های آپلودی | `/var/lib/food-automation/uploads` | ندارد |
| فرانت | `httpdocs` همان دامنه | فقط همین دامنه |
| nginx | `vhost_nginx.conf` همان دامنه (Additional nginx directives) | فقط همین دامنه |

> اگر پورت 3101 روی سرور گرفته است: `PORT=3201` را جلوی دستورات بگذارید.

## پیش از شروع
1. در Plesk دامنه (یا ساب‌دامنه) را بسازید، مثلاً `food.example.ac.ir`. نوع هاستینگ: Website hosting.
2. دسترسی SSH با کاربر sudo.

## نصب اولیه (یک‌بار)
```bash
cd /tmp
git clone https://github.com/armnre/north-university-food-automation.git
sudo DOMAIN=food.example.ac.ir bash north-university-food-automation/deploy/install.sh
```
اسکریپت: Node 22 و PostgreSQL را (اگر نیست) نصب می‌کند، کاربر و دیتابیس و رمزهای تصادفی می‌سازد، سرویس‌ها را تعریف می‌کند، nginx همان دامنه را تنظیم می‌کند، build و migration را اجرا و سرویس را بالا می‌آورد.

**بعد از نصب:**
- SSL: Plesk ← Domains ← دامنه ← SSL/TLS Certificates ← Let's Encrypt.
- کد `SETUP_CODE` که چاپ شد را برای ساخت اولین مدیر کل استفاده کنید.
- از `/etc/food-automation.env` نسخه‌ی امن بگیرید. **`NATIONAL_ID_PEPPER` هرگز نباید تغییر کند** (ورود همه‌ی کاربران به آن وابسته است).

## به‌روزرسانی (هر بار که تغییر جدید push شد)
```bash
sudo DOMAIN=food.example.ac.ir bash /opt/food-automation/deploy/update.sh
```
مراحل خودکار: دریافت کد ← build ← بکاپ دیتابیس ← migration ← انتشار فرانت ← ری‌استارت ← بررسی سلامت.
اگر هر مرحله خطا بدهد، کد و فرانت به نسخه‌ی قبل برمی‌گردند.

## اگر سرور از قبل نسخه‌ای را اجرا می‌کند
اگر قبلاً دستی نصب کرده‌اید و مسیرها فرق دارد، با متغیر بدهید:
```bash
sudo DOMAIN=... APP_DIR=/مسیر/فعلی APP_USER=کاربر_فعلی bash deploy/update.sh
```
فایل `/etc/food-automation.env` باید وجود داشته باشد (از روی `.env.example` بسازید).

## دستورات مفید
```bash
systemctl status food-api food-worker        # وضعیت
journalctl -u food-api -f                    # لاگ زنده
curl http://127.0.0.1:3101/api/ready         # سلامت
ls /var/backups/food-automation              # بکاپ‌ها (۱۴ بکاپ آخر نگه داشته می‌شود)
```

## بازگرداندن دیتابیس از بکاپ
```bash
sudo systemctl stop food-api food-worker
sudo -u postgres pg_restore --clean --if-exists -d food_automation /var/backups/food-automation/db-YYYYMMDD-HHMMSS.dump
sudo systemctl start food-api food-worker
```

## ورود دانشجویان از اکسل
پنل مدیر ← واردسازی دانشجویان. تا ۱۰٬۰۰۰ ردیف و ۱۰ مگابایت در هر فایل. ستون‌های فایل دانشگاه (با «ي» و «ك» عربی) خودکار تشخیص داده می‌شوند.
