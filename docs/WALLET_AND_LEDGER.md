# WALLET & LEDGER

- هر تراکنش یک سطر علامت‌دار در LedgerEntries با `counterAccount` (meal-revenue، manual-cash). معادل double-entry: طرف دوم هر سطر حساب مقابل است؛ جمع حساب‌های دانشجو = −جمع حساب‌های مقابل.
- موجودی = SUM(amountRial) — هیچ ستون balance وجود ندارد.
- انواع: ManualCredit، ManualDebit، ReservationDebit، CancellationRefund، CapacityRefund.
- idempotency با upsert روی idempotencyKey.
- موجودی منفی ممنوع (بررسی قبل و بعد).
- حذف/ویرایش: هیچ endpointی وجود ندارد؛ اصلاح فقط با تراکنش جبرانی.
- تطبیق: صفحه‌ی امور مالی رزروهایی را که خالص دفترکلشان با وضعیت/قیمت سازگار نیست نمایش می‌دهد.
- درگاه: جدول payment_attempts عمداً ساخته نشده تا پیش از تصمیم مالک؛ نقطه‌ی اتصال آینده نوع جدید `GatewayCredit` در postLedger است.
