# راهنمای استقرار نسخه‌ی جدید روی diningshomal.ir

## مشخصات سرور (نباید تغییر کند)
| مورد | مقدار |
|---|---|
| سرویس | `shomal-dining` (systemd) — Node روی `127.0.0.1:3101` |
| مخزن اصلی | `/opt/shomal-dining` (git: `armnre/north-university-food-automation`, شاخه‌ی `main`) |
| نسخه‌های ساخته‌شده | `/opt/shomal-dining-rYYYYMMDDHHMM` (git worktree) |
| انتخاب نسخه‌ی فعال | `/etc/systemd/system/shomal-dining.service.d/release.conf` → `WorkingDirectory` |
| تنظیمات و رمزها | `/etc/shomal-dining/app.env` (فقط `WEB_DIST_PATH` عوض می‌شود) |
| فایل‌های آپلودی | `/opt/shomal-dining/shared/uploads` (ثابت؛ دست نزنید) |
| فایل‌های وب Plesk | `/var/www/vhosts/diningshomal.ir/httpdocs` (`.htaccess` حفظ شود) |
| دیتابیس | `shomal_dining` (نقش‌ها: `food_migrator`، `food_app`) |

سایت‌ها و دیتابیس‌های دیگر سرور (hamdaneshgah، nezarat، pazhoheshyar، shomaldoc) هیچ ارتباطی با این فرایند ندارند.

## به‌روزرسانی (روش خودکار)
```
cd /opt/shomal-dining && git fetch origin && git checkout origin/main -- deploy
bash /opt/shomal-dining/deploy/shomal-update.sh
```
اسکریپت: کد را می‌گیرد ← در پوشه‌ی جدید می‌سازد ← پشتیبان می‌گیرد ← سرویس را سوییچ می‌کند ← فایل‌های وب Plesk را به‌روز می‌کند ← سلامت را چک می‌کند. اگر سرویس بالا نیاید، خودکار به نسخه‌ی قبل برمی‌گردد.

## بازگشت دستی
```
bash /opt/shomal-dining/deploy/shomal-rollback.sh /root/shomal-backup-YYYYMMDDHHMM
```

## نکات مهم
- از `npm ci` استفاده نکنید (lock file با سرور هم‌خوان نیست)؛ اسکریپت `npm install` می‌زند.
- `npm run build` فقط API را می‌سازد. وب با `npm run build:standalone -w apps/north-university-food-automation` در `dist-web` ساخته می‌شود (`npm run build` وب، خروجی `dist` می‌دهد که به درد سرور نمی‌خورد).
- اگر نسخه‌ی جدید تغییر دیتابیس (migration) داشت، قبل از سوییچ با نقش `food_migrator` اجرا شود.
- پاک‌سازی نسخه‌های قدیمی (بعد از چند روز اطمینان): `cd /opt/shomal-dining && git worktree list` و سپس `git worktree remove --force /opt/shomal-dining-rXXXX`.
- لاگ‌ها: `journalctl -u shomal-dining -f`
