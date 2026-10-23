# سامانه اتوماسیون تغذیه دانشگاه شمال

نسخهٔ تولیدی و کاملاً مستقل (Standalone) سامانهٔ رزرو و توزیع غذای دانشجویی دانشگاه شمال، پیاده‌سازی‌شده با معماری **Monorepo** مبتنی بر **Node.js 22 LTS**، **Fastify 5**، **Drizzle ORM**، **PostgreSQL 16/15** و **React 18 + Vite PWA** (فارسی، راست‌به‌چپ، بدون هرگونه وابستگی خارجی).

---

## ویژگی‌های کلیدی نسخهٔ مستقل

- **رزرو چندغذایی در یک وعده:** امکان انتخاب چند غذای مختلف در یک روز و یک وعده (صبحانه/ناهار/شام) با جلوگیری اتمیک از رزرو تکراری همان آیتم منو (`offering_id`) برای یک حساب.
- **پرداخت مستقیم درگاه (Zarinpal v4) و کسر خودکار اعتبار:** تسویهٔ مستقیم سبد غذا از طریق درگاه بانکی بدون نیاز به شارژ دستی کیف پول توسط دانشجو؛ کسر خودکار اعتبار بازپرداخت قبلی، رعایت کف ۱۰٬۰۰۰ ریال شاپرک، تسویهٔ آیتم‌به‌آیتم با `SAVEPOINT` و انتقال وجه آیتم‌های تکمیل‌ظرفیت‌شده به اعتبار حساب.
- **دفتر کل حسابداری دوطرفه (Double-Entry Append-Only):** ثبت تراکنش‌های غیرقابل‌ویرایش و غیرقابل‌حذف در سطح تریگر PostgreSQL با جمع صفر (`SUM(amount_rial) = 0`) و آشتی‌سازی دوره‌ای خودکار.
- **تحویل سریع با بلیط تمام‌صفحهٔ QR و کد ۸ کاراکتری:** نمایش کد ۸ کاراکتری خوانا (بدون پیشوند `R-`) برای دانشجو، پذیرش هر دو حالت با/بدون `R-` توسط اپراتور، قفل ردیف اتمیک در تحویل هم‌زمان و پشتیبانی از فهرست آفلاین سلف.
- **وب‌اپلیکیشن پیش‌رونده (PWA) کاملاً بومی:** فونت محلی `Vazirmatn`، آیکن‌ها و لوگوی برداری داخلی، صفحهٔ آفلاین فارسی، راهنمای نصب اندروید/iOS و عدم کش مسیرهای `/api` و `/uploads` در Service Worker.
- **فرآیند پس‌زمینهٔ مستقل (`food-worker`):** زمان‌بند مبتنی بر `Asia/Tehran` با قفل مشورتی `pg_try_advisory_lock` و ثبت تاریخچه در `job_runs` (ثبت `NoShow`، آشتی‌سازی پرداخت‌های در انتظار، پاک‌سازی نشست‌ها/کپچاها و بررسی سلامت دفتر کل).
- **امنیت دفاع در عمق:** کوکی نشست `__Host-sid` (`HttpOnly; Secure; SameSite=Strict`)، توکن CSRF زمان‌ثابت، هش `Argon2id` برای کارکنان با مهاجرت خودکار هش‌های قدیمی `PBKDF2`، هش `HMAC-SHA256` با `pepper` برای کد ملی (بدون ذخیره یا لاگ کد ملی خام)، تفکیک نقش‌های دیتابیس (`food_migrator` و `food_app`) و بررسی بایت‌های جادویی و پاک‌سازی متادیتای EXIF در آپلود تصویر غذا.

---

## ساختار مخزن

```text
north-university-food-automation/
├── apps/
│   ├── api/            # سرویس REST API (Fastify 5 + Drizzle + PostgreSQL) و پردازشگر پس‌زمینه (worker.ts)
│   └── web/            # وب‌اپلیکیشن PWA فارسی/RTL (React 18 + Vite + Tailwind + Workbox)
├── packages/
│   ├── shared/         # اسکیماهای Zod، ماتریس RBAC، خطاها، محاسبات ریال/تومان و تقویم تهران
│   └── components/     # کامپوننت‌های پایهٔ رابط کاربری (Radix UI + Tailwind)
├── deploy/             # اسکریپت‌های استقرار Plesk/Ubuntu 24.04، واحدهای systemd، پشتیبان‌گیری و nginx
├── docs/               # مستندات کامل معماری، امنیت، پرداخت، لغو، دیتابیس، عملیات و استقرار
└── scripts/            # اسکن عدم وجود راز، آزمون بار autocannon و اسکریپت‌های کمکی
```

---

## پیش‌نیازها و راه‌اندازی محلی

- **Node.js:** نسخهٔ `>= 22.0.0` (LTS)
- **PostgreSQL:** نسخهٔ ۱۵ یا ۱۶ (برای اجرای تست‌های یکپارچه نیازی به نصب دستی نیست؛ در صورت خالی بودن `TEST_DATABASE_URL` از PostgreSQL داخلی استفاده می‌شود)

```bash
# ۱. نصب وابستگی‌ها
npm ci

# ۲. کپی فایل متغیرهای محیطی برای توسعهٔ محلی
cp .env.example .env
# مقادیر DATABASE_URL، CSRF_SECRET و NATIONAL_ID_PEPPER را در .env مقداردهی کنید

# ۳. اجرای مهاجرت‌ها و داده‌های پایه (وعده‌ها، تنظیمات، سلف مرکزی)
npm run db:migrate
npm run db:seed

# ۴. اجرای هم‌زمان API و فرانت‌اند در محیط توسعه
npm run dev
```

---

## دستورات کنترل کیفیت و تست

```bash
npm run secrets:check      # اسکن مخزن برای اطمینان از نبود راز، کلید خصوصی یا لینک خارجی فرانت‌اند
npm audit                  # بررسی آسیب‌پذیری‌های وابستگی‌ها (۰ آسیب‌پذیری)
npm run lint               # بررسی قواعد ESLint
npm run typecheck          # بررسی نوع‌ها در تمام workspaceها و اسکریپت‌ها
npm run test               # اجرای تست‌های واحد (@food/shared)
npm run test:integration   # اجرای ۱۳۲ تست یکپارچه روی PostgreSQL واقعی
npm run loadtest           # آزمون بار autocannon و رقابت ۵۰ درخواست روی آخرین ۱۰ ظرفیت
npm run test:e2e           # آزمون سرتاسری Playwright (نیازمند مرورگر Chromium)
npm run build              # کامپایل کامل بستهٔ مشترک، API و فرانت‌اند PWA
```

---

## فهرست مستندات (`docs/`)

- [`docs/DEPLOY.md`](docs/DEPLOY.md) — راهنمای گام‌به‌گام استقرار روی سرور Ubuntu 24.04 + Plesk + PostgreSQL 16 (دامنهٔ نمونه `dining.example.edu`)
- [`docs/PAYMENTS.md`](docs/PAYMENTS.md) — معماری پرداخت مستقیم زرین‌پال، کسر خودکار اعتبار، قانون ۱۰٬۰۰۰ ریال شاپرک و آشتی‌سازی
- [`docs/CANCELLATION.md`](docs/CANCELLATION.md) — وضعیت لغو رزرو در نسخهٔ اول و راهنمای فعال‌سازی مجدد لغو دانشجویی
- [`docs/SECURITY.md`](docs/SECURITY.md) — کنترل‌های امنیتی، مدیریت نشست/CSRF و تحلیل ریسک ورود دانشجویی
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — معماری کلان سامانه و جریان داده
- [`docs/DATABASE.md`](docs/DATABASE.md) — مدل داده، قیدها، تریگرهای Append-Only و نقش‌های PostgreSQL
- [`docs/API.md`](docs/API.md) — مرجع مسیرهای REST API
- [`docs/RBAC.md`](docs/RBAC.md) — ماتریس نقش‌ها، مجوزها و تفکیک وظایف
- [`docs/RESERVATIONS.md`](docs/RESERVATIONS.md) — قوانین رزرو چندغذایی، هم‌زمانی و چرخهٔ وضعیت
- [`docs/WALLET_AND_LEDGER.md`](docs/WALLET_AND_LEDGER.md) — دفتر کل دوطرفه و کیف پول اعتبار بازپرداخت
- [`docs/QR_DELIVERY.md`](docs/QR_DELIVERY.md) — تحویل در سلف با QR، کد ۸ کاراکتری و همگام‌سازی آفلاین
- [`docs/EXCEL_IMPORT.md`](docs/EXCEL_IMPORT.md) — واردسازی امن اکسل دانشجویان، پیش‌نمایش و بازگردانی (Undo)
- [`docs/OPERATIONS_RUNBOOK.md`](docs/OPERATIONS_RUNBOOK.md) — کتابچهٔ عملیات روزانه، پایش و رفع اشکال
- [`docs/TESTING.md`](docs/TESTING.md) — راهبرد تست واحد، یکپارچه، بار و سرتاسری
- [`deploy/restore.md`](deploy/restore.md) — دستورالعمل بازیابی از پشتیبان (Disaster Recovery)
