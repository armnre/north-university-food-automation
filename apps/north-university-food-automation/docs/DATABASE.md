# DATABASE (Zite Database — PostgreSQL)

| جدول | نقش | فیلدهای کلیدی |
|---|---|---|
| Students | دانشجو | studentNumber (متن، حفظ صفر ابتدایی)، nationalIdHash (HMAC)، nationalIdLastDigits، status |
| StaffUsers | کاربر مدیریتی | username، passwordHash (PBKDF2)، role، status، contractor→، cafeteria→ |
| Sessions | نشست | tokenHash (SHA-256)، subjectType، subjectId، expiresAt، revoked |
| LoginThrottle | محدودیت تلاش | key، failures، lockedUntil |
| Contractors / Cafeterias / Foods | کاتالوگ | active (غیرفعال‌سازی به‌جای حذف)، isDemo |
| MealOfferings | وعده | serviceDate، mealType، food→، cafeteria→، priceRial، capacity، reserveDeadline، cancelDeadline |
| Reservations | رزرو | code، student→، offering→، priceAtBooking، status، idempotencyKey، qrToken، seq (autonumber) |
| ReservationHistory | تاریخچه وضعیت | from/to، actor |
| LedgerEntries | دفترکل | trackingCode، type، amountRial (علامت‌دار)، counterAccount، reservation→، actorStaff→، idempotencyKey، seq |
| Deliveries | تلاش‌های تحویل | reservation→، operator→، outcome (Accepted/Duplicate)، seq |
| AuditLogs | ممیزی | action، actor، target، details(JSON) |
| ImportBatches | واردسازی | status، policy، شمارنده‌ها، stagedData (فقط هش)، errorReport، fileFingerprint |
| Notifications | اعلان | student→ (خالی = همگانی) |
| SystemSettings | تنظیمات | key/value |

## محدودیت‌های شناخته‌شده (صادقانه)
- Zite Database امکان تعریف UNIQUE/CHECK/FK سفارشی و تراکنش چندعبارتی را از طریق SDK نمی‌دهد. یکتایی با `bulkCreate({matchOn})` (upsert) و بررسی سمت سرور اعمال می‌شود. در نسخه‌ی مستقل باید constraintهای واقعی اضافه شوند (پیشنهاد در ZITE_PORTABILITY.md).
- ایندکس‌ها توسط Zite مدیریت می‌شوند.
- سوابق مالی و ممیزی هیچ مسیر حذف/ویرایشی در API ندارند؛ اما مدیر workspace از UI دیتابیس Zite دسترسی مستقیم دارد — باید با سیاست سازمانی کنترل شود.
