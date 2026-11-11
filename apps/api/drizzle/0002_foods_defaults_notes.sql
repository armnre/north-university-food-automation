ALTER TABLE "foods" ADD COLUMN "default_price_rial" bigint;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "default_capacity" integer;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "suitable_meals" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_offerings" ADD COLUMN "notes" text DEFAULT '' NOT NULL;