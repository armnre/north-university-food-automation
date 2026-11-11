# ماتریس RBAC

> این فایل خودکار از `packages/shared/src/rbac.ts` تولید می‌شود (`npm run docs:rbac`). دستی ویرایش نکنید.

| مجوز | SuperAdmin | StudentAffairs | NutritionManager | Finance | Contractor | Operator | Student | Employee |
|---|---|---|---|---|---|---|---|---|
| `dashboardView` — مشاهده داشبورد مدیریت | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `studentsRead` — مشاهده دانشجویان | ✓ | ✓ |  | ✓ |  |  |  |  |
| `studentsWrite` — تغییر وضعیت دانشجو | ✓ | ✓ |  |  |  |  |  |  |
| `employeesManage` — مدیریت کارمندان | ✓ | ✓ |  |  |  |  |  |  |
| `importsManage` — ایمپورت اکسل دانشجویان | ✓ | ✓ |  |  |  |  |  |  |
| `catalogWrite` — مدیریت پیمانکار/سلف/غذا | ✓ |  | ✓ |  |  |  |  |  |
| `menuWrite` — مدیریت منو و قیمت | ✓ |  | ✓ |  |  |  |  |  |
| `menuRead` — مشاهده منو و آمار آشپزخانه | ✓ |  | ✓ |  | ✓ | ✓ |  |  |
| `reservationsRead` — مشاهده رزروها | ✓ | ✓ | ✓ |  | ✓ |  |  |  |
| `reservationsAdminCancel` — لغو اداری رزرو و لغو/اتمام وعده | ✓ |  | ✓ |  |  |  |  |  |
| `deliveryScan` — اسکن و تحویل غذا |  |  |  |  |  | ✓ |  |  |
| `financeRead` — مشاهده دفتر کل | ✓ |  |  | ✓ |  |  |  |  |
| `financeWrite` — شارژ/تعدیل دستی |  |  |  | ✓ |  |  |  |  |
| `paymentsReview` — تعیین‌تکلیف پرداخت‌های NeedsReview | ✓ |  |  |  |  |  |  |  |
| `reportsRead` — گزارش‌ها | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `reportsFinance` — گزارش‌های مالی کل | ✓ |  |  | ✓ |  |  |  |  |
| `notificationsSend` — ارسال اعلان | ✓ | ✓ | ✓ |  |  |  |  |  |
| `staffManage` — مدیریت کاربران کارکنان | ✓ | ✓ | ✓ |  |  |  |  |  |
| `settingsWrite` — ویرایش تنظیمات | ✓ |  |  |  |  |  |  |  |
| `auditRead` — مشاهده رخدادهای حسابرسی | ✓ | ✓ |  |  |  |  |  |  |
| `selfService` — منو، رزرو، کیف پول و اعلان‌های شخصی |  |  |  |  |  |  | ✓ | ✓ |

## سلسله‌مراتب ساخت حساب
- **SuperAdmin**: StudentAffairs، NutritionManager، Finance، Contractor، Operator، Employee
- **StudentAffairs**: Employee
- **NutritionManager**: Operator، Contractor
- **Finance**: —
- **Contractor**: —
- **Operator**: —
