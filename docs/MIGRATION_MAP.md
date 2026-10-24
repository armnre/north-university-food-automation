# جدول مطابقت مهاجرت (Zite ← REST)

منبع: کامیت `2dae8eb`، پوشه‌ی `apps/north-university-food-automation/src/api` (۳۷ endpoint). هیچ endpointی جا نیفتاده است؛ تست `scripts/check-migration-map` (مرحله ۳) باید این را خودکار تأیید کند.

| endpoint فعلی (Zite) | مسیر REST جدید | جدول‌های PostgreSQL | مصرف‌کننده در فرانت |
|---|---|---|---|
| `adminDashboard` | `GET /api/v1/admin/dashboard` | students, accounts, reservations, deliveries, ledger_* | AdminDashboard.tsx |
| `adminStudentReport` | `GET /api/v1/admin/students/:id/report` | students, accounts, reservations, deliveries, ledger_* | StudentReportSheet.tsx |
| `adminStudentStatus` | `PATCH /api/v1/admin/students/:id/status` | students, accounts, reservations, deliveries, ledger_* | StudentsPage.tsx |
| `adminStudents` | `GET /api/v1/admin/students` | students, accounts, reservations, deliveries, ledger_* | StudentsPage.tsx |
| `auditList` | `GET /api/v1/audit` | audit_logs | AuditPage.tsx |
| `authLogout` | `POST /api/v1/auth/logout` | staff_users, students, employees, sessions, login_attempts, captchas, audit_logs | session.tsx |
| `authMe` | `GET /api/v1/auth/me` | staff_users, students, employees, sessions, login_attempts, captchas, audit_logs | session.tsx |
| `authSetupAdmin` | `POST /api/v1/auth/setup-admin` | staff_users, students, employees, sessions, login_attempts, captchas, audit_logs | LoginPage.tsx |
| `authSetupStatus` | `GET /api/v1/auth/setup-status` | staff_users, students, employees, sessions, login_attempts, captchas, audit_logs | LoginPage.tsx |
| `authStaffLogin` | `POST /api/v1/auth/staff/login` | staff_users, students, employees, sessions, login_attempts, captchas, audit_logs | LoginPage.tsx |
| `authStudentLogin` | `POST /api/v1/auth/student/login` | staff_users, students, employees, sessions, login_attempts, captchas, audit_logs | LoginPage.tsx |
| `catalogList` | `GET /api/v1/catalog` | contractors, cafeterias, foods | CatalogPage.tsx, FoodsPage.tsx, OfferingsPage.tsx, ReportsPage.tsx, ReservationsPage.tsx |
| `catalogSave` | `PUT /api/v1/catalog/{contractors|cafeterias|foods}/:id?` | contractors, cafeterias, foods | CatalogPage.tsx, FoodsPage.tsx |
| `deliveryConfirm` | `POST /api/v1/delivery/confirm` | reservations, deliveries | DeliveryPage.tsx |
| `deliveryScan` | `POST /api/v1/delivery/scan` | reservations, deliveries | DeliveryPage.tsx |
| `deliveryStats` | `GET /api/v1/delivery/stats` | reservations, deliveries | DeliveryPage.tsx |
| `financeAdjust` | `POST /api/v1/finance/adjust` | ledger_transactions, ledger_entries, accounts, audit_logs | FinancePage.tsx |
| `financeLedger` | `GET /api/v1/finance/ledger` | ledger_transactions, ledger_entries, accounts, audit_logs | FinancePage.tsx |
| `importCancel` | `POST /api/v1/imports/:id/cancel` | import_batches, import_rows, students, sessions | ImportPage.tsx |
| `importCommit` | `POST /api/v1/imports/:id/commit` | import_batches, import_rows, students, sessions | ImportPage.tsx |
| `importList` | `GET /api/v1/imports` | import_batches, import_rows, students, sessions | ImportPage.tsx |
| `importPreview` | `POST /api/v1/imports/preview (multipart .xlsx)` | import_batches, import_rows, students, sessions | ImportPage.tsx |
| `notificationsAdmin` | `GET|POST /api/v1/notifications` | notifications, notification_outbox | NotifyPage.tsx |
| `offeringSave` | `PUT /api/v1/offerings/:id?` | meal_offerings, offering_prices, meal_slots | OfferingsPage.tsx |
| `offeringsBulk` | `POST /api/v1/offerings/bulk` | meal_offerings, offering_prices, meal_slots | MenuTools.tsx |
| `offeringsList` | `GET /api/v1/offerings` | meal_offerings, offering_prices, meal_slots | KitchenDashboard.tsx, OfferingsPage.tsx |
| `reportsAdvanced` | `GET /api/v1/reports/advanced` | reservations, deliveries, ledger_* | ManagementReports.tsx |
| `reportsSummary` | `GET /api/v1/reports/summary` | reservations, deliveries, ledger_* | ReportsPage.tsx |
| `reservationsAdminList` | `GET /api/v1/reservations` | reservations, reservation_history | OfferingsPage.tsx, ReservationsPage.tsx |
| `settingsManage` | `GET|PUT /api/v1/settings` | system_settings, audit_logs | SettingsPage.tsx |
| `staffList` | `GET /api/v1/staff` | staff_users, audit_logs | UsersPage.tsx |
| `staffSave` | `PUT /api/v1/staff/:id?` | staff_users, audit_logs | UsersPage.tsx |
| `studentCheckout` | `POST /api/v1/payments/checkout/start (+ GET /payments/zarinpal/callback, POST /payments/result)` | meal_offerings, reservations, accounts, ledger_*, payments, notifications | Checkout.tsx |
| `studentMenu` | `GET /api/v1/me/menu` | meal_offerings, reservations, accounts, ledger_*, payments, notifications | MenuPage.tsx |
| `studentNotifications` | `GET /api/v1/me/notifications` | meal_offerings, reservations, accounts, ledger_*, payments, notifications | NotificationsPage.tsx, StudentApp.tsx |
| `studentReservations` | `GET /api/v1/me/reservations` | meal_offerings, reservations, accounts, ledger_*, payments, notifications | MyReservations.tsx, StudentDashboard.tsx |
| `studentReserve` | `POST /api/v1/me/reserve` | meal_offerings, reservations, accounts, ledger_*, payments, notifications | — (استفاده‌نشده؛ رزرو فقط از سبد) |
| `studentWallet` | `GET /api/v1/me/wallet` | meal_offerings, reservations, accounts, ledger_*, payments, notifications | StudentDashboard.tsx, WalletPage.tsx |

## endpointهای جدید (بدون معادل در Zite)
`POST /auth/employee/login`، `POST /auth/logout-all`، `GET/DELETE /auth/sessions`، `POST /auth/change-password`، `GET /auth/captcha`، `/employees` (CRUD + ایمپورت)، `POST /me/reservations/:id/cancel`، `POST /me/reservations/:id/reissue-qr`، `GET /me/profile`، `POST /offerings/:id/sold-out`، `POST /offerings/:id/cancel`، `GET /delivery/offline-manifest`، `POST /delivery/sync`، `POST /imports/:id/undo`، `GET /reports/export`، `POST /payments/reconcile`، `GET /payments/needs-review`، `POST /uploads/food-image`، `GET /health`، `GET /ready`.

## وابستگی‌های Zite در فرانت که باید حذف شوند
- `zitejs/api` در ۲۴ فایل صفحه/کامپوننت ← با alias در Vite به `src/lib/api.ts` (adapter) نگاشت می‌شود تا **صفحه‌ها دست نخورند**.
- `zitejs/upload` در `FoodsPage.tsx` ← `uploadFoodImage` در همان adapter.
- `packages/components/lib/legacyAuth.ts` و پارامتر `token` در ورودی همه‌ی endpointها ← کوکی HttpOnly؛ adapter پارامتر `token` را نادیده می‌گیرد.
