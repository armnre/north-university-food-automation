-- Migration 0003: Direct Gateway Checkout columns on `payments`
-- Supports multi-item cart checkout, automatic internal credit deduction,
-- settlement receipt (`result_json`), and Finance resolution of `NeedsReview` payments.

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "cart_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "total_rial" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "credit_used_rial" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "result_json" jsonb,
  ADD COLUMN IF NOT EXISTS "resolved_by" uuid REFERENCES "public"."staff_users"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "resolution_note" text;
--> statement-breakpoint

ALTER TABLE "payments"
  ALTER COLUMN "return_to" SET DEFAULT '/payment/result';
--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_total_non_negative" CHECK ("payments"."total_rial" >= 0),
  ADD CONSTRAINT "payments_credit_non_negative" CHECK ("payments"."credit_used_rial" >= 0);
