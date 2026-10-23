# قرارداد REST — `docs/API.md`

همهٔ endpointها زیر `/api/v1` هستند (به‌جز `/api/health` و `/api/ready`).
فرانت‌اند و API هم‌دامنه (same-origin) سرو می‌شوند ⇒ **CORS خاموش** است.
نشست در کوکی `__Host-sid` (`HttpOnly; Secure; SameSite=Strict; Path=/`) و
محافظت CSRF با کوکی `csrf` + هدر `X-CSRF-Token` برای همهٔ متدهای غیر GET انجام می‌شود.

شکل پاسخ خطا در همهٔ مسیرها یکسان است:

```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "موجودی کیف پول شما کافی نیست؛ کسری ۱۲٬۰۰۰ تومان.", "details": { "shortfallRial": 120000 } } }
```

مستندات زندهٔ OpenAPI فقط در محیط غیر production در `/api/docs` در دسترس است
(اسکیماهای Zod همان قرارداد REST هستند).

## جدول مطابقت endpointهای قدیمی (Zite) با مسیرهای جدید

| endpoint قدیمی (`src/api/*.ts`) | مسیر جدید                                                                                                                               | مجوز                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `authSetupStatus`               | `GET /auth/setup-status`                                                                                                                | عمومی                                                                            |
| `authSetupAdmin`                | `POST /auth/setup-admin`                                                                                                                | عمومی + `SETUP_CODE`                                                             |
| `authStudentLogin`              | `POST /auth/student/login`                                                                                                              | عمومی                                                                            |
| `authStaffLogin`                | `POST /auth/staff/login`                                                                                                                | عمومی                                                                            |
| —                               | `POST /auth/employee/login`                                                                                                             | عمومی (جدید: کارمند/هیئت‌علمی)                                                   |
| `authMe`                        | `GET /auth/me`                                                                                                                          | نشست معتبر                                                                       |
| `authLogout`                    | `POST /auth/logout`                                                                                                                     | نشست معتبر                                                                       |
| —                               | `POST /auth/logout-all`                                                                                                                 | نشست معتبر (جدید)                                                                |
| —                               | `GET /auth/sessions` / `DELETE /auth/sessions`                                                                                          | نشست معتبر (جدید)                                                                |
| —                               | `POST /auth/change-password`                                                                                                            | کارکنان/کارمندان (جدید)                                                          |
| —                               | `GET /auth/captcha`                                                                                                                     | عمومی (جدید)                                                                     |
| `adminDashboard`                | `GET /admin/dashboard`                                                                                                                  | `dashboard` یا `contractorReports`                                               |
| `adminStudents`                 | `GET /admin/students`                                                                                                                   | `students`                                                                       |
| `adminStudentReport`            | `GET /admin/students/:id/report`                                                                                                        | `students` یا `finance`                                                          |
| `adminStudentStatus`            | `PATCH /admin/students/:id/status`                                                                                                      | `studentStatus`                                                                  |
| —                               | `GET /admin/reservations`                                                                                                               | `reservations` (جدید؛ معادل `reservationsAdminList` برای مدیران)                 |
| `auditList`                     | `GET /audit`                                                                                                                            | `audit`                                                                          |
| —                               | `GET /audit/actions`                                                                                                                    | `audit` (جدید)                                                                   |
| `catalogList`                   | `GET /catalog`                                                                                                                          | `catalog`/`foods`/`offerings`/`reports`/`finance`/`students`/`contractorReports` |
| `catalogSave`                   | `POST /catalog` و `PUT /catalog/:kind/:id`                                                                                              | `catalog` یا `foods`                                                             |
| `offeringsList`                 | `GET /offerings`                                                                                                                        | `offerings`/`delivery`/`reports`/`reservations`/…                                |
| `offeringSave`                  | `POST /offerings` و `PUT /offerings/:id`                                                                                                | `offerings`                                                                      |
| `offeringsBulk`                 | `POST /offerings/bulk`                                                                                                                  | `offerings`                                                                      |
| —                               | `PATCH /offerings/:id/status`                                                                                                           | `offerings` (جدید: «تمام شد»/«لغو وعده» با بازپرداخت خودکار)                     |
| `studentMenu`                   | `GET /me/menu`                                                                                                                          | دانشجو/کارمند                                                                    |
| `studentReserve`                | `POST /me/reservations`                                                                                                                 | دانشجو/کارمند                                                                    |
| `studentCheckout`               | `POST /me/checkout`                                                                                                                     | دانشجو/کارمند (بدون اعتبار رایگان)                                               |
| `studentReservations`           | `GET /me/reservations`                                                                                                                  | دانشجو/کارمند                                                                    |
| —                               | `POST /me/reservations/:id/cancel`                                                                                                      | دانشجو/کارمند (جدید)                                                             |
| —                               | `POST /me/reservations/:id/qr/reissue`                                                                                                  | دانشجو/کارمند (جدید)                                                             |
| `studentWallet`                 | `GET /me/wallet`                                                                                                                        | دانشجو/کارمند                                                                    |
| —                               | `POST /me/wallet/topup`                                                                                                                 | دانشجو/کارمند (جدید: درگاه پرداخت)                                               |
| —                               | `POST /me/withdrawals` / `GET /me/withdrawals`                                                                                          | دانشجو/کارمند (جدید)                                                             |
| `studentNotifications`          | `GET /me/notifications`                                                                                                                 | دانشجو/کارمند                                                                    |
| —                               | `POST /me/notifications/read`                                                                                                           | دانشجو/کارمند (جدید)                                                             |
| `reservationsAdminList`         | `GET /reservations`                                                                                                                     | `reservations`/`finance`/`students`                                              |
| —                               | `POST /reservations/:id/cancel`                                                                                                         | `reservationCancel` (جدید: لغو اداری)                                            |
| `deliveryScan`                  | `POST /delivery/scan`                                                                                                                   | `delivery` یا `deliveryAll`                                                      |
| `deliveryConfirm`               | `POST /delivery/confirm`                                                                                                                | `delivery` یا `deliveryAll`                                                      |
| `deliveryStats`                 | `GET /delivery/stats`                                                                                                                   | `delivery` یا `deliveryAll`                                                      |
| —                               | `GET /delivery/offline-manifest`                                                                                                        | `delivery`/`deliveryAll` (جدید: آفلاین)                                          |
| —                               | `POST /delivery/sync`                                                                                                                   | `delivery`/`deliveryAll` (جدید: صف آفلاین)                                       |
| —                               | `GET /delivery/offline-conflicts`                                                                                                       | `audit` یا `dashboard` (جدید)                                                    |
| `financeAdjust`                 | `POST /finance/adjust`                                                                                                                  | `financeWrite`                                                                   |
| `financeLedger`                 | `GET /finance/ledger`                                                                                                                   | `finance`                                                                        |
| —                               | `GET /finance/reconcile`                                                                                                                | `finance` یا `audit` (جدید)                                                      |
| —                               | `GET /finance/withdrawals` / `POST /finance/withdrawals/:id/review`                                                                     | `finance`/`financeWrite`/`withdrawalReview` (جدید)                               |
| `importPreview`                 | `POST /imports/preview` (multipart)                                                                                                     | `import`                                                                         |
| `importCommit`                  | `POST /imports/:id/commit`                                                                                                              | `import`                                                                         |
| `importCancel`                  | `POST /imports/:id/cancel`                                                                                                              | `import`                                                                         |
| `importList`                    | `GET /imports`                                                                                                                          | `import`                                                                         |
| —                               | `POST /imports/:id/undo`                                                                                                                | `import` (جدید)                                                                  |
| `notificationsAdmin`            | `GET /notifications/admin` و `POST /notifications/admin`                                                                                | `notify`                                                                         |
| `reportsSummary`                | `GET /reports/summary`                                                                                                                  | `reports`/`contractorReports`/`finance`                                          |
| `reportsAdvanced`               | `GET /reports/advanced`                                                                                                                 | `reports`/`finance`                                                              |
| —                               | `GET /reports/summary.csv` / `.xlsx` / `ledger.csv` / `.xlsx`                                                                           | همان مجوز گزارش‌ها (جدید)                                                        |
| `settingsManage`                | `GET /settings` و `PUT /settings`                                                                                                       | `settings`                                                                       |
| `staffList`                     | `GET /staff`                                                                                                                            | کارکنان (فقط نقش‌های قابل مدیریت)                                                |
| `staffSave`                     | `POST /staff` و `PUT /staff/:id`                                                                                                        | `users` یا `operators`                                                           |
| —                               | `POST /staff/:id/reset-password`                                                                                                        | `users` یا `operators` (جدید)                                                    |
| —                               | `GET/POST /employees`, `PUT /employees/:id`, `POST /employees/:id/reset-password`, `POST /employees/bulk`, `GET /employees/credentials` | `employees` (جدید)                                                               |
| —                               | `GET /payments/status`, `GET /payments/zarinpal/callback`, `GET /payments/sandbox/redirect`                                             | عمومی/درگاه (جدید)                                                               |
| —                               | `GET /api/health`, `GET /api/ready`                                                                                                     | عمومی (پایش)                                                                     |

**جمع:** هر ۴۳ متد endpoint قدیمی (۳۰ تابع در `src/api` نسخهٔ Zite) به REST منتقل شد.

شمار واقعی مسیرهای ثبت‌شده در اپ (خروجی `app.printRoutes()` پس از `app.ready()`):
۵۶ GET، ۳۷ POST، ۶ PUT، ۲ PATCH، ۱ DELETE.
این شمار شامل HEAD خودکار Fastify برای GETها و مسیرهای مستندات OpenAPI
(`/api/docs` در محیط غیر production) نیز هست؛ مسیرهای کسب‌وکار همان‌هایی هستند
که در جدول بالا فهرست شده‌اند.

## نکات قرارداد

- **مبالغ:** همهٔ مبلغ‌ها در API به **ریال** و عدد صحیح هستند؛ نمایش در UI به تومان.
- **تاریخ‌ها:** «روز سرویس» به قالب `YYYY-MM-DD` (روز تقویمی تهران) و لحظه‌ها ISO 8601 (UTC).
- **idempotency:** رزرو، سبد خرید، شارژ دستی و callback درگاه کلید idempotency می‌گیرند؛
  تکرار کلید همان نتیجهٔ قبلی را بدون اثر دوم برمی‌گرداند (`replay: true`).
- **صفحه‌بندی:** `offset`/`limit` با `total` و `hasMore`.
- **دادهٔ حساس:** کد ملی خام، رمز، شبا و توکن QR دیگران در هیچ پاسخی برنمی‌گردد
  (کد ملی فقط `••••••۱۲۳۴`، شبا فقط ماسک‌شده برای امور مالی).
