# مدل پایگاه داده و قیدهای یکپارچگی (`docs/DATABASE.md`)

پایگاه دادهٔ سامانه بر بستر **PostgreSQL 15 / 16** با **Drizzle ORM** و چهار فایل مهاجرت ترتیبی در `apps/api/drizzle/` پیاده‌سازی شده است:

- `0000_init.sql` — جداول پایه، کلیدهای خارجی و قیدهای `CHECK` / `UNIQUE`
- `0001_triggers_and_grants.sql` — تریگرهای Append-Only، تریگر تراز دوطرفهٔ دفتر کل، ممنوعیت `DELETE` فیزیکی و مجوزهای نقش‌های `food_migrator` و `food_app`
- `0002_offering_level_unique.sql` — مجاز کردن رزرو چند غذای متفاوت در یک وعده و ایجاد ایندکس یکتای جزئی روی `(account_id, offering_id)` برای وضعیت‌های زنده
- `0003_direct_checkout_payments.sql` — ستون‌های تسویهٔ مستقیم سبد در جدول `payments` (`items_json`، `credit_used_rial`، `settled_at` و غیره)

> **قاعدهٔ مهم توسعه:** هر فایل `.sql` جدید در `apps/api/drizzle/` باید هم‌زمان در `apps/api/drizzle/meta/_journal.json` ثبت شود؛ مسیر `/api/ready` برابری تعداد مهاجرت‌های اعمال‌شده با فایل‌های موجود را کنترل می‌کند.

---

## ۱. جداول اصلی

| جدول                                               | نقش                            | قیدها و نکات کلیدی                                                                                                                                            |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `students`                                         | پروندهٔ دانشجویان              | یکتایی `student_number` و `national_id_hash` (HMAC-SHA256)؛ کد ملی خام هرگز ذخیره نمی‌شود (`national_id_last4` فقط ۴ رقم آخر)                                 |
| `employees`                                        | مشتریان کارمند / هیئت‌علمی     | نام کاربری یکتا، هش رمز Argon2id و گروه قیمتی (`Employee` / `Faculty` / `Contractor`)                                                                         |
| `staff_users`                                      | کاربران پنل مدیریت و اپراتورها | نقش‌های شش‌گانه، هش رمز Argon2id، وضعیت فعال/غیرفعال و محدودهٔ سلف یا پیمانکار                                                                                |
| `accounts`                                         | حساب کیف پول اعتبار مشتریان    | `balance_rial >= 0` (قید `CHECK` دیتابیس)؛ متناظر یک‌به‌یک با دانشجو یا کارمند                                                                                |
| `sessions`                                         | نشست‌های فعال                  | ذخیرهٔ صرفاً `token_hash` (SHA-256)، زمان انقضای نسبی/مطلق، IP و وضعیت ابطال                                                                                  |
| `contractors`, `cafeterias`, `meal_slots`, `foods` | کاتالوگ پایه                   | غیرفعال‌سازی نرم (`is_active`)، مسیر نسبی تصویر غذا در `foods.image_path`                                                                                     |
| `meal_offerings` و `offering_prices`               | برنامهٔ غذایی و قیمت گروه‌ها   | قید `reserved_count >= 0 AND reserved_count <= capacity` و جدول تاریخچهٔ تغییر قیمت `offering_price_history`                                                  |
| `reservations` و `reservation_history`             | رزروها و تاریخچهٔ وضعیت        | ایندکس یکتای جزئی `reservations_one_live_per_offering` روی `(account_id, offering_id) WHERE status IN ('Reserved', 'Delivered')`؛ کلید `idempotency_key` یکتا |
| `payments`                                         | تراکنش‌های درگاه مستقیم        | وضعیت‌های `Pending                                                                                                                                            | Verified | Failed | NeedsReview`، ذخیرهٔ اقلام سبد (`items_json`)، مبلغ اعتبار کسرشده و کد مرجع درگاه |
| `ledger_transactions` و `ledger_entries`           | دفتر کل حسابداری دوطرفه        | فقط افزودنی (Append-Only)؛ تریگر Constraint Deferred تضمین می‌کند جمع `amount_rial` در هر تراکنش دقیقاً صفر باشد                                              |
| `deliveries`                                       | ثبت تلاش‌ها و تحویل‌های سلف    | فقط افزودنی؛ ثبت اپراتور، روش اسکن، نتیجه (`Accepted` / `Duplicate` / ...) و کلید آفلاین                                                                      |
| `import_batches` و `import_rows`                   | واردسازی اکسل دانشجویان        | پیش‌نمایش مرحله‌ای بدون ذخیرهٔ کد ملی خام، اثرانگشت فایل و پشتیبانی از بازگردانی آخرین دسته                                                                   |
| `audit_logs`                                       | لاگ ممیزی امنیتی و مدیریتی     | فقط افزودنی؛ ثبت کنشگر، هدف، مقادیر قبل/بعد و IP                                                                                                              |
| `job_runs`                                         | تاریخچهٔ اجرای کارهای پس‌زمینه | ثبت زمان شروع/پایان، وضعیت و خلاصهٔ خروجی jobهای `food-worker`                                                                                                |

---

## ۲. تفکیک نقش‌های دیتابیس و تریگرهای محافظ

1. **نقش `food_migrator`:** مالک جداول و تنها نقشی که اجازهٔ اجرای مهاجرت‌های ساختار (DDL) در زمان استقرار را دارد.
2. **نقش اجرایی `food_app`:** سرویس‌های `food-api` و `food-worker` در زمان اجرا فقط با این نقش متصل می‌شوند؛ این نقش فاقد مجوز DDL و فاقد مجوز `DELETE` روی جداول کسب‌وکار است.
3. **ممنوعیت حذف فیزیکی و تغییر سوابق مالی:**
   - اجرای `DELETE` روی ۱۸ جدول اصلی کسب‌وکار با تریگر PostgreSQL مسدود است (پاک‌سازی دوره‌ای فقط روی جداول موقت مانند `sessions`، `login_attempts`، `captchas`، `import_rows` و `job_runs` مجاز است).
   - اجرای `UPDATE` و `DELETE` روی `ledger_transactions`، `ledger_entries`، `audit_logs`، `reservation_history` و `deliveries` در سطح دیتابیس خطا برمی‌گرداند.
