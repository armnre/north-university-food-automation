# درگاه سامان کیش (SEP) و اینماد

## درگاه سامان
- آدرس بازگشت (Callback): `https://diningshomal.ir/api/v1/payments/saman/callback` (POST فرم)
- IP سرور که باید نزد سامان ثبت شود: `185.129.168.87` (احراز هویت Verify/Reverse با IP است)
- تنظیمات `.env` سرور API:
  ```
  ONLINE_PAYMENT_ENABLED=true
  PAYMENT_PROVIDER=saman
  SAMAN_TERMINAL_ID=15321785
  PUBLIC_BASE_URL=https://diningshomal.ir
  ```
- روند: دریافت توکن → هدایت به `sep.shaparak.ir/OnlinePG/SendToken` → بازگشت POST → Verify سمت سرور با RefNum و تطبیق مبلغ (در صورت مغایرت Reverse).
- پرداختی که بازگشتش نرسد Verify نمی‌شود و سامان حدود ۳۰ دقیقه بعد خودکار برگشت می‌زند؛ سیستم بعد از ۶۰ دقیقه آن را «ناموفق» ثبت می‌کند.
- در تنظیمات سامانه، «پرداخت آنلاین» را هم روشن کنید.

## اینماد
- کد متای تأیید دامنه را در `VITE_ENAMAD_META` و شناسه/کد نشان را در `VITE_ENAMAD_ID` و `VITE_ENAMAD_CODE` بگذارید و وب را دوباره build کنید.
- صفحات «درباره ما / تماس با ما / قوانین» در پایین صفحه ورود هستند و متنشان از تنظیمات (اطلاعات تماس، راهنما، سیاست رزرو) خوانده می‌شود.
