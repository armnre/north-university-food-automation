# API (Zite endpoints)

همه‌ی endpointها ورودی `token` (نشست) دارند، به‌جز ورود و راه‌اندازی. خطاها با پیام فارسی و کد (UNAUTHORIZED، FORBIDDEN، BAD_REQUEST، CONFLICT، NOT_FOUND، PAYMENT_REQUIRED، TOO_MANY_REQUESTS) برمی‌گردند.

| Endpoint | مجوز | توضیح |
|---|---|---|
| authStudentLogin | عمومی | شماره دانشجویی + کد ملی → token |
| authStaffLogin | عمومی | نام کاربری + رمز → token |
| authSetupStatus / authSetupAdmin | عمومی + ZITE_SETUP_CODE | ساخت اولین مدیر ارشد (فقط وقتی هیچ کاربری نیست) |
| authMe / authLogout | نشست | پروفایل / لغو نشست |
| studentMenu, studentReserve, studentCancel, studentReservations, studentWallet, studentNotifications | دانشجو | فقط داده‌های خود دانشجو (IDOR: مالکیت سمت سرور بررسی می‌شود) |
| adminDashboard | dashboard | KPIها؛ بخش مالی فقط SuperAdmin/Finance |
| adminStudents | SuperAdmin/StudentAffairs/Finance | جست‌وجو؛ کد ملی هرگز برنمی‌گردد |
| adminStudentStatus | students | فعال/غیرفعال با دلیل |
| importPreview / importCommit / importCancel / importList | import | واردسازی Excel |
| staffList / staffSave | users | کاربران و نقش‌ها |
| catalogList / catalogSave | catalog | غذا، سلف، پیمانکار |
| offeringsList / offeringSave | menu | وعده‌ها |
| reservationsAdminList | reservations | رزروها |
| deliveryScan / deliveryConfirm / deliveryStats | delivery | QR |
| financeLedger / financeAdjust | finance / financeWrite | دفترکل و عملیات دستی |
| reportsSummary | SuperAdmin/Finance/Contractor(محدود) | گزارش |
| auditList | audit | ممیزی |
| settingsManage | settings | تنظیمات |
| notificationsAdmin | notify | اعلان |

## Idempotency
- `studentReserve.idempotencyKey`: کلید یکتا برای هر تلاش؛ ارسال مجدد همان کلید همان رزرو را برمی‌گرداند.
- `financeAdjust.idempotencyKey`: جلوگیری از ثبت دوباره در retry.
- کلیدهای داخلی دفترکل: `res:{id}:debit`، `res:{id}:refund`، `res:{id}:reject-refund`، `manual:{staff}:{key}`.
