# ARCHITECTURE

```
apps/app/
  src/            React + Vite + TypeScript + Tailwind (فرانت‌اند)
  src/pages/      student/* و staff/* — پنل‌های جدا بر اساس نقش
  src/api/*.ts    هر فایل = یک endpoint (Cloudflare Worker در Zite)
  src/server/     منطق مشترک بک‌اند: core.ts (احراز هویت، RBAC، دفترکل، ممیزی)، queries.ts، delivery.ts
  docs/
```
- فرانت‌اند فقط endpointهای `zitejs/api` را صدا می‌زند؛ اتصال مستقیم مرورگر به دیتابیس وجود ندارد.
- هر endpoint یک `token` نشست می‌گیرد و `requireStudent` / `requireStaff(perm)` را سمت سرور اجرا می‌کند.
- دیتابیس: Zite Database (PostgreSQL مدیریت‌شده). نوشتن از طریق SDK جدولی و خواندن تجمیعی با SQL پارامتری (`zite.sql`).

## مرز وابستگی به Zite
وابسته به Zite: `zitejs/db`، `zitejs/backend` (createEndpoint)، `zitejs/api`، runtime Worker، Secrets.
قابل‌انتقال: تمام کامپوننت‌های React، منطق اعتبارسنجی (zod)، الگوریتم‌های کد ملی، هش، رزرو، دفترکل و QR در `src/server` (با جایگزینی لایه‌ی دسترسی به داده).
