# API

> خودکار از رجیستری routeهای Fastify تولید می‌شود (`npm run docs:api`). 67 route.

همه‌ی پاسخ‌های خطا: `{ "error": { "code", "message", "details?" } }` با پیام فارسی. درخواست‌های تغییردهنده به کوکی نشست `__Host-sid` و هدر `x-csrf-token` (برابر کوکی `__Host-csrf`) نیاز دارند. مبالغ به ریال صحیح‌اند.

مسیرهای بیرون از `/api/v1`: `GET /api/health`، `GET /api/ready`، `GET /uploads/foods/:name`.

| متد | مسیر | دسترسی |
|---|---|---|
| `GET` | `/api/v1/admin/dashboard` | `dashboardView` — مشاهده داشبورد مدیریت |
| `GET` | `/api/v1/admin/students` | `studentsRead` — مشاهده دانشجویان |
| `GET` | `/api/v1/admin/students/:id/report` | `studentsRead` — مشاهده دانشجویان |
| `PATCH` | `/api/v1/admin/students/:id/status` | `studentsWrite` — تغییر وضعیت دانشجو |
| `GET` | `/api/v1/audit` | `auditRead` — مشاهده رخدادهای حسابرسی |
| `GET` | `/api/v1/auth/captcha` | عمومی |
| `POST` | `/api/v1/auth/change-password` | هر کاربر واردشده |
| `GET` | `/api/v1/auth/csrf` | عمومی |
| `POST` | `/api/v1/auth/employee/login` | عمومی |
| `POST` | `/api/v1/auth/logout` | هر کاربر واردشده |
| `POST` | `/api/v1/auth/logout-all` | هر کاربر واردشده |
| `GET` | `/api/v1/auth/me` | هر کاربر واردشده |
| `GET` | `/api/v1/auth/sessions` | هر کاربر واردشده |
| `DELETE` | `/api/v1/auth/sessions/:id` | هر کاربر واردشده |
| `POST` | `/api/v1/auth/setup-admin` | عمومی |
| `GET` | `/api/v1/auth/setup-status` | عمومی |
| `POST` | `/api/v1/auth/staff/login` | عمومی |
| `POST` | `/api/v1/auth/student/login` | عمومی |
| `GET` | `/api/v1/catalog` | `menuRead` — مشاهده منو و آمار آشپزخانه |
| `PUT` | `/api/v1/catalog` | `catalogWrite` — مدیریت پیمانکار/سلف/غذا |
| `POST` | `/api/v1/delivery/confirm` | `deliveryScan` — اسکن و تحویل غذا |
| `GET` | `/api/v1/delivery/offline-manifest` | `deliveryScan` — اسکن و تحویل غذا |
| `POST` | `/api/v1/delivery/scan` | `deliveryScan` — اسکن و تحویل غذا |
| `GET` | `/api/v1/delivery/stats` | `deliveryScan` — اسکن و تحویل غذا |
| `POST` | `/api/v1/delivery/sync` | `deliveryScan` — اسکن و تحویل غذا |
| `GET` | `/api/v1/employees` | `employeesManage` — مدیریت کارمندان |
| `PUT` | `/api/v1/employees` | `employeesManage` — مدیریت کارمندان |
| `POST` | `/api/v1/employees/bulk` | `employeesManage` — مدیریت کارمندان |
| `POST` | `/api/v1/finance/adjust` | `financeWrite` — شارژ/تعدیل دستی |
| `GET` | `/api/v1/finance/ledger` | `financeRead` — مشاهده دفتر کل |
| `GET` | `/api/v1/imports` | `importsManage` — ایمپورت اکسل دانشجویان |
| `POST` | `/api/v1/imports/:id/approve-conflict` | `importsManage` — ایمپورت اکسل دانشجویان |
| `POST` | `/api/v1/imports/:id/cancel` | `importsManage` — ایمپورت اکسل دانشجویان |
| `POST` | `/api/v1/imports/:id/commit` | `importsManage` — ایمپورت اکسل دانشجویان |
| `POST` | `/api/v1/imports/:id/undo` | `importsManage` — ایمپورت اکسل دانشجویان |
| `POST` | `/api/v1/imports/preview` | `importsManage` — ایمپورت اکسل دانشجویان |
| `GET` | `/api/v1/me/menu` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `GET` | `/api/v1/me/notifications` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `GET` | `/api/v1/me/profile` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `GET` | `/api/v1/me/reservations` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `POST` | `/api/v1/me/reservations/:id/cancel` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `POST` | `/api/v1/me/reservations/:id/reissue-qr` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `POST` | `/api/v1/me/reserve` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `GET` | `/api/v1/me/wallet` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `GET` | `/api/v1/notifications` | `notificationsSend` — ارسال اعلان |
| `POST` | `/api/v1/notifications` | `notificationsSend` — ارسال اعلان |
| `GET` | `/api/v1/offerings` | `menuRead` — مشاهده منو و آمار آشپزخانه |
| `PUT` | `/api/v1/offerings` | `menuWrite` — مدیریت منو و قیمت |
| `POST` | `/api/v1/offerings/:id/cancel` | `reservationsAdminCancel` — لغو اداری رزرو و لغو/اتمام وعده |
| `POST` | `/api/v1/offerings/:id/sold-out` | `reservationsAdminCancel` — لغو اداری رزرو و لغو/اتمام وعده |
| `POST` | `/api/v1/offerings/bulk` | `menuWrite` — مدیریت منو و قیمت |
| `POST` | `/api/v1/payments/:id/resolve` | `paymentsReview` — تعیین‌تکلیف پرداخت‌های NeedsReview |
| `POST` | `/api/v1/payments/checkout/start` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `GET` | `/api/v1/payments/needs-review` | `paymentsReview` — تعیین‌تکلیف پرداخت‌های NeedsReview |
| `POST` | `/api/v1/payments/reconcile` | `paymentsReview` — تعیین‌تکلیف پرداخت‌های NeedsReview |
| `POST` | `/api/v1/payments/result` | `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |
| `GET` | `/api/v1/payments/zarinpal/callback` | عمومی |
| `GET` | `/api/v1/reports/advanced` | `reportsRead` — گزارش‌ها |
| `GET` | `/api/v1/reports/export` | `reportsRead` — گزارش‌ها |
| `GET` | `/api/v1/reports/summary` | `reportsRead` — گزارش‌ها |
| `GET` | `/api/v1/reservations` | `reservationsRead` — مشاهده رزروها |
| `POST` | `/api/v1/reservations/:id/cancel` | `reservationsAdminCancel` — لغو اداری رزرو و لغو/اتمام وعده |
| `GET` | `/api/v1/settings` | هر کاربر واردشده |
| `PUT` | `/api/v1/settings` | `settingsWrite` — ویرایش تنظیمات |
| `GET` | `/api/v1/staff` | `staffManage` — مدیریت کاربران کارکنان |
| `PUT` | `/api/v1/staff` | `staffManage` — مدیریت کاربران کارکنان |
| `POST` | `/api/v1/uploads/food-image` | `catalogWrite` — مدیریت پیمانکار/سلف/غذا |
