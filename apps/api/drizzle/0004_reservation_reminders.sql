-- Migration 0004: Meal reminder idempotency table (`reservation_reminders`)
-- Ensures each `Reserved` ticket receives at most one reminder notification/SMS.

CREATE TABLE IF NOT EXISTS "reservation_reminders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reservation_id" uuid NOT NULL REFERENCES "public"."reservations"("id") ON DELETE CASCADE,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sms_queued" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reservation_reminders_reservation_id_key"
  ON "reservation_reminders" USING btree ("reservation_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "reservation_reminders_sent_at_idx"
  ON "reservation_reminders" USING btree ("sent_at");
--> statement-breakpoint

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'food_app') THEN
    GRANT SELECT, INSERT ON TABLE public.reservation_reminders TO food_app;
    REVOKE UPDATE, DELETE ON TABLE public.reservation_reminders FROM food_app;
  END IF;
END
$do$;
