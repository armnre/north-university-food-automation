CREATE TYPE "public"."account_kind" AS ENUM('Customer', 'System');--> statement-breakpoint
CREATE TYPE "public"."customer_group" AS ENUM('Student', 'Employee');--> statement-breakpoint
CREATE TYPE "public"."delivery_outcome" AS ENUM('Accepted', 'AlreadyDelivered', 'WrongCafeteria', 'OutOfWindow', 'NotFound', 'Cancelled', 'OfflineConflict');--> statement-breakpoint
CREATE TYPE "public"."employee_kind" AS ENUM('Staff', 'Faculty', 'Contractor');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('Previewed', 'Committing', 'Committed', 'Cancelled', 'Undone');--> statement-breakpoint
CREATE TYPE "public"."offering_status" AS ENUM('Draft', 'Published', 'SoldOut', 'Cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('Pending', 'Paid', 'Failed', 'NeedsReview');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('Reserved', 'Delivered', 'Cancelled', 'NoShow', 'Rejected');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('SuperAdmin', 'StudentAffairs', 'NutritionManager', 'Finance', 'Contractor', 'Operator');--> statement-breakpoint
CREATE TYPE "public"."student_status" AS ENUM('Active', 'OnLeave', 'Withdrawn', 'Graduated', 'Removed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "account_kind" DEFAULT 'Customer' NOT NULL,
	"code" text,
	"student_id" uuid,
	"employee_id" uuid,
	"balance_rial" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_balance_ck" CHECK ("accounts"."kind" = 'System' OR "accounts"."balance_rial" >= 0),
	CONSTRAINT "accounts_owner_ck" CHECK (("accounts"."kind" = 'System' AND "accounts"."code" IS NOT NULL AND "accounts"."student_id" IS NULL AND "accounts"."employee_id" IS NULL)
    OR ("accounts"."kind" = 'Customer' AND num_nonnulls("accounts"."student_id", "accounts"."employee_id") = 1))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"data" jsonb,
	"ip" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cafeterias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"contractor_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "captchas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contract_number" text,
	"contact_phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid,
	"operator_id" uuid NOT NULL,
	"cafeteria_id" uuid,
	"outcome" "delivery_outcome" NOT NULL,
	"client_event_id" uuid,
	"device_id" text,
	"offline" boolean DEFAULT false NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"kind" "employee_kind" DEFAULT 'Staff' NOT NULL,
	"personnel_code" text,
	"mobile" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"image_path" text,
	"calories" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'students' NOT NULL,
	"file_name" text,
	"status" "import_status" DEFAULT 'Previewed' NOT NULL,
	"full_sync" boolean DEFAULT false NOT NULL,
	"summary" jsonb,
	"created_by" uuid NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"action" text NOT NULL,
	"student_number" text,
	"payload" jsonb,
	"errors" jsonb,
	"conflict_approved" boolean DEFAULT false NOT NULL,
	"student_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_nonzero_ck" CHECK ("ledger_entries"."amount_rial" <> 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"tracking_code" text NOT NULL,
	"reason" text,
	"actor" text NOT NULL,
	"reservation_id" uuid,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_hash" text NOT NULL,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_date" date NOT NULL,
	"meal_slot_id" uuid NOT NULL,
	"food_id" uuid NOT NULL,
	"cafeteria_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	"reserved_count" integer DEFAULT 0 NOT NULL,
	"status" "offering_status" DEFAULT 'Draft' NOT NULL,
	"reserve_opens_at" timestamp with time zone,
	"reserve_deadline" timestamp with time zone NOT NULL,
	"cancel_deadline" timestamp with time zone,
	"meal_starts_at" timestamp with time zone NOT NULL,
	"meal_ends_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_offerings_capacity_ck" CHECK ("meal_offerings"."capacity" > 0),
	CONSTRAINT "meal_offerings_reserved_ck" CHECK ("meal_offerings"."reserved_count" >= 0 AND "meal_offerings"."reserved_count" <= "meal_offerings"."capacity"),
	CONSTRAINT "meal_offerings_window_ck" CHECK ("meal_offerings"."meal_starts_at" < "meal_offerings"."meal_ends_at" AND "meal_offerings"."reserve_deadline" <= "meal_offerings"."meal_starts_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_slots_time_ck" CHECK ("meal_slots"."start_time" ~ '^[0-2][0-9]:[0-5][0-9]$' AND "meal_slots"."end_time" ~ '^[0-2][0-9]:[0-5][0-9]$' AND "meal_slots"."start_time" < "meal_slots"."end_time")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"recipient" text NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"audience" text DEFAULT 'personal' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"kind" text DEFAULT 'info' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offering_prices" (
	"offering_id" uuid NOT NULL,
	"customer_group" "customer_group" NOT NULL,
	"price_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offering_prices_offering_id_customer_group_pk" PRIMARY KEY("offering_id","customer_group"),
	CONSTRAINT "offering_prices_ck" CHECK ("offering_prices"."price_rial" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"authority" text,
	"amount_rial" bigint NOT NULL,
	"credit_used_rial" bigint DEFAULT 0 NOT NULL,
	"status" "payment_status" DEFAULT 'Pending' NOT NULL,
	"items" jsonb NOT NULL,
	"ref_id" text,
	"card_pan" text,
	"gateway_code" integer,
	"review_note" text,
	"reviewed_by" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount_rial" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reservation_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reservation_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"account_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"customer_group" "customer_group" NOT NULL,
	"price_rial" bigint NOT NULL,
	"status" "reservation_status" DEFAULT 'Reserved' NOT NULL,
	"idempotency_key" text NOT NULL,
	"qr_token" text NOT NULL,
	"payment_id" uuid,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_price_ck" CHECK ("reservations"."price_rial" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_subject_ck" CHECK ("sessions"."subject_type" IN ('student','employee','staff'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"full_name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"cafeteria_id" uuid,
	"contractor_id" uuid,
	"mobile" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_number" text NOT NULL,
	"national_id_hash" text NOT NULL,
	"national_id_last4" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"faculty" text,
	"major" text,
	"degree" text,
	"entry_year" smallint,
	"mobile" text,
	"status" "student_status" DEFAULT 'Active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_import_batch_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_last4_ck" CHECK ("students"."national_id_last4" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cafeterias" ADD CONSTRAINT "cafeterias_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_operator_id_staff_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_cafeteria_id_cafeterias_id_fk" FOREIGN KEY ("cafeteria_id") REFERENCES "public"."cafeterias"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_offerings" ADD CONSTRAINT "meal_offerings_meal_slot_id_meal_slots_id_fk" FOREIGN KEY ("meal_slot_id") REFERENCES "public"."meal_slots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_offerings" ADD CONSTRAINT "meal_offerings_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_offerings" ADD CONSTRAINT "meal_offerings_cafeteria_id_cafeterias_id_fk" FOREIGN KEY ("cafeteria_id") REFERENCES "public"."cafeterias"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offering_prices" ADD CONSTRAINT "offering_prices_offering_id_meal_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."meal_offerings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reservation_history" ADD CONSTRAINT "reservation_history_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reservation_reminders" ADD CONSTRAINT "reservation_reminders_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reservations" ADD CONSTRAINT "reservations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offering_id_meal_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."meal_offerings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_cafeteria_id_cafeterias_id_fk" FOREIGN KEY ("cafeteria_id") REFERENCES "public"."cafeterias"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_student_uq" ON "accounts" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_employee_uq" ON "accounts" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_code_uq" ON "accounts" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cafeterias_contractor_idx" ON "cafeterias" USING btree ("contractor_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deliveries_client_event_uq" ON "deliveries" USING btree ("client_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_res_idx" ON "deliveries" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_cafe_idx" ON "deliveries" USING btree ("cafeteria_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employees_username_uq" ON "employees" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_rows_batch_idx" ON "import_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_job_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entries_tx_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_tx_idem_uq" ON "ledger_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_tx_tracking_uq" ON "ledger_transactions" USING btree ("tracking_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_tx_created_idx" ON "ledger_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_ident_idx" ON "login_attempts" USING btree ("identifier_hash","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_offerings_date_idx" ON "meal_offerings" USING btree ("service_date","cafeteria_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_offerings_slot_idx" ON "meal_offerings" USING btree ("meal_slot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_offerings_food_idx" ON "meal_offerings" USING btree ("food_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meal_slots_code_uq" ON "meal_slots" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_pending_idx" ON "notification_outbox" USING btree ("next_attempt_at") WHERE "notification_outbox"."sent_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_account_idx" ON "notifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_authority_uq" ON "payments" USING btree ("authority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservation_history_res_idx" ON "reservation_history" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_reminders_res_uq" ON "reservation_reminders" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_idem_uq" ON "reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_qr_uq" ON "reservations" USING btree ("qr_token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_code_uq" ON "reservations" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_active_uq" ON "reservations" USING btree ("account_id","offering_id") WHERE "reservations"."status" IN ('Reserved','Delivered');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservations_offering_idx" ON "reservations" USING btree ("offering_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservations_account_idx" ON "reservations" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_subject_idx" ON "sessions" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_users_username_uq" ON "staff_users" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_users_cafeteria_idx" ON "staff_users" USING btree ("cafeteria_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "students_student_number_uq" ON "students" USING btree ("student_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "students_national_id_hash_uq" ON "students" USING btree ("national_id_hash");