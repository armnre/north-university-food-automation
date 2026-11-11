-- نقش «مدیر تغذیه» حذف شد؛ وظایفش به «پیمانکار تغذیه» منتقل شده (یک سلف مرکزی، بدون شرکت پیمانکار).
UPDATE "staff_users" SET "role" = 'Contractor' WHERE "role" = 'NutritionManager';
