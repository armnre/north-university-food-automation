# ZITE PORTABILITY

## واقعیت فعلی
این نسخه **روی runtime اختصاصی Zite** اجرا می‌شود: Cloudflare Worker برای endpointها و Zite Database. معماری درخواستی (Express/Fastify + PostgreSQL مستقل + Drizzle + migration) **در این محیط قابل اجرا و تست نیست** و پیاده‌سازی نشده است. ادعای قابلیت انتقال بدون build مستقل نمی‌کنیم.

## وابسته به Zite
`zitejs/db` (جداول + sql)، `zitejs/backend` (createEndpoint/ZiteError)، `zitejs/api` (فراخوانی تایپ‌شده)، Secrets، Zite Database UI.

## قابل‌انتقال تقریباً بدون تغییر
- تمام `src/pages`، `src/components`، `src/lib` (به‌جز `zitejs/api` → جایگزینی با کلاینت fetch به `/api/v1`)
- منطق `src/server/core.ts`: اعتبارسنجی کد ملی، HMAC، PBKDF2، RBAC، throttle، ledger — با جایگزینی `zite.*` با Repository
- اسکیماهای zod هر endpoint = قرارداد REST

## مسیر مهاجرت پیشنهادی
1. خروجی سورس از GitHub (اتصال GitHub در workspace برقرار است)
2. ساخت `apps/api` با Fastify + Drizzle؛ هر فایل `src/api/X.ts` → `POST /api/v1/X`
3. Schema Drizzle با UNIQUE(studentNumber)، UNIQUE(idempotencyKey)، UNIQUE(qrToken)، CHECK(capacity>0)، CHECK(priceRial>=0)، FKهای واقعی، partial unique index برای (student, serviceDate, mealType) WHERE status IN ('Reserved','Delivered')
4. رزرو/تحویل داخل تراکنش با `FOR UPDATE`
5. Argon2id و کوکی HttpOnly
6. مهاجرت داده: خروجی جداول Zite → اسکریپت import (هش‌های کد ملی با همان pepper معتبر می‌مانند)
