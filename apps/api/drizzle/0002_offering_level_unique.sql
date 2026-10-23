-- مهاجرت 0002: تغییر قید یکتایی رزرو فعال از سطح وعده (روز + وعده) به سطح آیتم منو (offering_id)
-- تصمیم محصول: هر دانشجو می‌تواند در یک وعده از یک روز چند غذای مختلف رزرو کند،
-- اما رزرو تکراری همان غذا (همان offering_id) مجاز نیست.

DROP INDEX IF EXISTS "reservations_one_live_per_slot";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reservations_one_live_per_offering"
  ON "reservations" USING btree ("account_id", "offering_id")
  WHERE "reservations"."status" IN ('Reserved', 'Delivered');--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "reservations_account_slot_idx"
  ON "reservations" USING btree ("account_id", "service_date", "meal_slot_id");
