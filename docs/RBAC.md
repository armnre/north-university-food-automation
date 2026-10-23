# RBAC

| مجوز                                | SuperAdmin     | StudentAffairs | Finance | Contractor | Operator        |
| ----------------------------------- | -------------- | -------------- | ------- | ---------- | --------------- |
| dashboard                           | ✓              | ✓              | ✓       |            |                 |
| students (تغییر وضعیت)              | ✓              | ✓              |         |            |                 |
| import                              | ✓              | ✓              |         |            |                 |
| users                               | ✓              |                |         |            |                 |
| catalog / menu / reservations       | ✓              |                |         |            |                 |
| delivery                            | ✓ (همه سلف‌ها) |                |         |            | ✓ (فقط سلف خود) |
| finance (مشاهده)                    | ✓              |                | ✓       |            |                 |
| financeWrite (شارژ/برداشت)          |                |                | ✓       |            |                 |
| reports                             | ✓              |                | ✓       |            |                 |
| contractor (گزارش محدود به قرارداد) |                |                |         | ✓          |                 |
| audit / settings                    | ✓              |                |         |            |                 |
| notify                              | ✓              | ✓              |         |            |                 |

منبع حقیقت: `ROLE_PERMS` در `src/server/core.ts`. منوی فرانت‌اند فقط بازتاب همین است؛ کنترل اصلی در هر endpoint است.
تفکیک وظایف: مدیر ارشد عمداً مجوز financeWrite ندارد.
