# QR DELIVERY

- QR فقط حاوی توکن تصادفی ۴۸ رقم هگز (۱۹۲ بیت) است؛ بدون کد ملی، نام یا مبلغ.
- deliveryScan: اعتبارسنجی سمت سرور → ready | already | cancelled | invalid | wrongCafeteria | wrongDay | expired.
- deliveryConfirm: درج سطر Delivery، سپس قدیمی‌ترین سطر Accepted برنده است؛ بقیه Duplicate می‌شوند → دو اسکن هم‌زمان هرگز دو تحویل موفق نمی‌دهند.
- ثبت زمان، اپراتور و ممیزی.
- اسکن دوربین با BarcodeDetector؛ در نبود دوربین، ورود دستی/اسکنر سخت‌افزاری (همان مسیر سرور — حالت جعلی نیست).
