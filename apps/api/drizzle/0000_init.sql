CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(20) NOT NULL,
	"student_id" uuid,
	"employee_id" uuid,
	"customer_group" varchar(20) NOT NULL,
	"balance_rial" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_balance_non_negative" CHECK ("accounts"."balance_rial" >= 0),
	CONSTRAINT "accounts_balance_safe_range" CHECK ("accounts"."balance_rial" <= 9000000000000000),
	CONSTRAINT "accounts_kind_check" CHECK ("accounts"."kind" IN ('Student','Employee')),
	CONSTRAINT "accounts_customer_group_check" CHECK ("accounts"."customer_group" IN ('Student','Employee','Faculty','Contractor')),
	CONSTRAINT "accounts_subject_exclusive" CHECK (("accounts"."student_id" IS NULL) <> ("accounts"."employee_id" IS NULL)),
	CONSTRAINT "accounts_kind_matches_subject" CHECK (("accounts"."kind" = 'Student' AND "accounts"."student_id" IS NOT NULL) OR ("accounts"."kind" = 'Employee' AND "accounts"."employee_id" IS NOT NULL)),
	CONSTRAINT "accounts_group_matches_kind" CHECK (("accounts"."kind" = 'Student' AND "accounts"."customer_group" = 'Student') OR ("accounts"."kind" = 'Employee' AND "accounts"."customer_group" <> 'Student'))
);
--> statement-breakpoint
CREATE TABLE "captchas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_hash" varchar(64) NOT NULL,
	"kind" varchar(10) DEFAULT 'Math' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captchas_kind_check" CHECK ("captchas"."kind" IN ('Math','Text'))
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"customer_group" varchar(20) DEFAULT 'Employee' NOT NULL,
	"national_id_last4" varchar(4),
	"mobile" varchar(20),
	"must_change_password" boolean DEFAULT true NOT NULL,
	"status" varchar(20) DEFAULT 'Active' NOT NULL,
	"personnel_code" varchar(40),
	"department" varchar(200) DEFAULT '' NOT NULL,
	"created_by" uuid,
	"password_changed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "employees_customer_group_check" CHECK ("employees"."customer_group" IN ('Employee','Faculty','Contractor')),
	CONSTRAINT "employees_status_check" CHECK ("employees"."status" IN ('Active','Disabled')),
	CONSTRAINT "employees_username_check" CHECK ("employees"."username" ~ '^[a-z0-9._-]{3,64}$')
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_hash" varchar(64) NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"ip" varchar(64) DEFAULT '' NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_attempts_subject_type_check" CHECK ("login_attempts"."subject_type" IN ('Student','Employee','Staff'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"subject_id" uuid NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(400),
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_subject_type_check" CHECK ("sessions"."subject_type" IN ('Student','Employee','Staff')),
	CONSTRAINT "sessions_token_hash_check" CHECK (char_length("sessions"."token_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"role" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'Active' NOT NULL,
	"contractor_id" uuid,
	"cafeteria_id" uuid,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"password_changed_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "staff_users_role_check" CHECK ("staff_users"."role" IN ('SuperAdmin','StudentAffairs','NutritionManager','Contractor','Operator','Finance')),
	CONSTRAINT "staff_users_status_check" CHECK ("staff_users"."status" IN ('Active','Disabled')),
	CONSTRAINT "staff_users_username_check" CHECK ("staff_users"."username" ~ '^[a-z0-9._-]{3,64}$')
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_number" varchar(20) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"faculty" varchar(200) DEFAULT '' NOT NULL,
	"major" varchar(200) DEFAULT '' NOT NULL,
	"degree" varchar(100) DEFAULT '' NOT NULL,
	"entry_year" integer,
	"national_id_hash" varchar(64) NOT NULL,
	"national_id_last4" varchar(4) DEFAULT '' NOT NULL,
	"status" varchar(20) DEFAULT 'Active' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"last_import_batch_id" uuid,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "students_status_check" CHECK ("students"."status" IN ('Active','OnLeave','Withdrawn','Graduated','Removed')),
	CONSTRAINT "students_student_number_check" CHECK (char_length("students"."student_number") BETWEEN 5 AND 20),
	CONSTRAINT "students_national_id_hash_check" CHECK (char_length("students"."national_id_hash") = 64),
	CONSTRAINT "students_national_id_last4_check" CHECK (char_length("students"."national_id_last4") <= 4)
);
--> statement-breakpoint
CREATE TABLE "cafeterias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"location" varchar(200) DEFAULT '' NOT NULL,
	"contractor_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"contract_number" varchar(80) DEFAULT '' NOT NULL,
	"contact_phone" varchar(30),
	"contract_from" date,
	"contract_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" varchar(60) DEFAULT '' NOT NULL,
	"image_path" varchar(1000),
	"calories" integer,
	"default_price_rial" bigint,
	"default_capacity" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "foods_calories_check" CHECK ("foods"."calories" IS NULL OR "foods"."calories" BETWEEN 0 AND 100000),
	CONSTRAINT "foods_default_price_check" CHECK ("foods"."default_price_rial" IS NULL OR "foods"."default_price_rial" BETWEEN 0 AND 100000000),
	CONSTRAINT "foods_default_capacity_check" CHECK ("foods"."default_capacity" IS NULL OR "foods"."default_capacity" BETWEEN 1 AND 100000)
);
--> statement-breakpoint
CREATE TABLE "meal_offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_date" date NOT NULL,
	"meal_slot_id" uuid NOT NULL,
	"food_id" uuid NOT NULL,
	"cafeteria_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	"reserved_count" integer DEFAULT 0 NOT NULL,
	"reserve_opens_at" timestamp with time zone NOT NULL,
	"reserve_deadline" timestamp with time zone NOT NULL,
	"cancel_deadline" timestamp with time zone,
	"status" varchar(20) DEFAULT 'Draft' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status_reason" text,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meal_offerings_capacity_positive" CHECK ("meal_offerings"."capacity" > 0),
	CONSTRAINT "meal_offerings_capacity_max" CHECK ("meal_offerings"."capacity" <= 100000),
	CONSTRAINT "meal_offerings_reserved_non_negative" CHECK ("meal_offerings"."reserved_count" >= 0),
	CONSTRAINT "meal_offerings_reserved_within_capacity" CHECK ("meal_offerings"."reserved_count" <= "meal_offerings"."capacity"),
	CONSTRAINT "meal_offerings_status_check" CHECK ("meal_offerings"."status" IN ('Draft','Published','Closed','Cancelled','SoldOut')),
	CONSTRAINT "meal_offerings_deadline_order" CHECK ("meal_offerings"."reserve_deadline" >= "meal_offerings"."reserve_opens_at")
);
--> statement-breakpoint
CREATE TABLE "meal_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"title" varchar(60) NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_slots_code_check" CHECK ("meal_slots"."code" IN ('Breakfast','Lunch','Dinner')),
	CONSTRAINT "meal_slots_time_check" CHECK ("meal_slots"."end_time" > "meal_slots"."start_time")
);
--> statement-breakpoint
CREATE TABLE "offering_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_id" uuid NOT NULL,
	"customer_group" varchar(20) NOT NULL,
	"from_price_rial" bigint,
	"to_price_rial" bigint NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offering_prices" (
	"offering_id" uuid NOT NULL,
	"customer_group" varchar(20) NOT NULL,
	"price_rial" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "offering_prices_offering_id_customer_group_pk" PRIMARY KEY("offering_id","customer_group"),
	CONSTRAINT "offering_prices_group_check" CHECK ("offering_prices"."customer_group" IN ('Student','Employee','Faculty','Contractor')),
	CONSTRAINT "offering_prices_price_non_negative" CHECK ("offering_prices"."price_rial" >= 0),
	CONSTRAINT "offering_prices_price_max" CHECK ("offering_prices"."price_rial" <= 100000000)
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid,
	"operator_id" uuid NOT NULL,
	"cafeteria_id" uuid NOT NULL,
	"outcome" varchar(24) NOT NULL,
	"client_event_id" varchar(64),
	"device_id" varchar(120) DEFAULT '' NOT NULL,
	"source" varchar(20) DEFAULT 'Online' NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	CONSTRAINT "deliveries_outcome_check" CHECK ("deliveries"."outcome" IN ('Accepted','Duplicate','Invalid','WrongDay','OutsideWindow','Cancelled','Expired','WrongCafeteria','OfflineConflict')),
	CONSTRAINT "deliveries_source_check" CHECK ("deliveries"."source" IN ('Online','OfflineSync'))
);
--> statement-breakpoint
CREATE TABLE "reservation_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"from_status" varchar(20) DEFAULT '' NOT NULL,
	"to_status" varchar(20) NOT NULL,
	"actor_type" varchar(20) DEFAULT 'System' NOT NULL,
	"actor_id" uuid,
	"actor_label" varchar(120) DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(24) NOT NULL,
	"account_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"meal_slot_id" uuid NOT NULL,
	"cafeteria_id" uuid NOT NULL,
	"price_at_booking" bigint NOT NULL,
	"customer_group_at_booking" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'Reserved' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"qr_token" varchar(48),
	"qr_issued_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_status_check" CHECK ("reservations"."status" IN ('Reserved','Delivered','Cancelled','Rejected','Expired','NoShow')),
	CONSTRAINT "reservations_group_check" CHECK ("reservations"."customer_group_at_booking" IN ('Student','Employee','Faculty','Contractor')),
	CONSTRAINT "reservations_price_non_negative" CHECK ("reservations"."price_at_booking" >= 0),
	CONSTRAINT "reservations_price_safe_range" CHECK ("reservations"."price_at_booking" <= 9000000000000000),
	CONSTRAINT "reservations_qr_token_shape" CHECK ("reservations"."qr_token" IS NULL OR "reservations"."qr_token" ~ '^[a-f0-9]{48}$'),
	CONSTRAINT "reservations_code_shape" CHECK ("reservations"."code" ~ '^R-[A-Z0-9]{8,12}$'),
	CONSTRAINT "reservations_cancel_requires_reason" CHECK ("reservations"."status" <> 'Cancelled' OR "reservations"."cancel_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid,
	"system_account" varchar(30),
	"amount_rial" bigint NOT NULL,
	"balance_after" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_non_zero" CHECK ("ledger_entries"."amount_rial" <> 0),
	CONSTRAINT "ledger_entries_amount_safe_range" CHECK ("ledger_entries"."amount_rial" BETWEEN -9000000000000000 AND 9000000000000000),
	CONSTRAINT "ledger_entries_side_exclusive" CHECK (("ledger_entries"."account_id" IS NULL) <> ("ledger_entries"."system_account" IS NULL)),
	CONSTRAINT "ledger_entries_system_account_check" CHECK ("ledger_entries"."system_account" IS NULL OR "ledger_entries"."system_account" IN ('MEAL_REVENUE','MANUAL_CASH','GATEWAY_CLEARING','WITHDRAWAL_ESCROW','TREASURY')),
	CONSTRAINT "ledger_entries_balance_after_only_for_account" CHECK (("ledger_entries"."account_id" IS NOT NULL) = ("ledger_entries"."balance_after" IS NOT NULL)),
	CONSTRAINT "ledger_entries_balance_after_non_negative" CHECK ("ledger_entries"."balance_after" IS NULL OR "ledger_entries"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(40) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"reference_type" varchar(40),
	"reference_id" uuid,
	"reason" text NOT NULL,
	"actor_type" varchar(20) DEFAULT 'System' NOT NULL,
	"actor_id" uuid,
	"tracking_code" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_type_check" CHECK ("ledger_transactions"."type" IN ('ManualCredit','ManualDebit','OnlinePayment','ReservationDebit','CancellationRefund','MealUnavailableRefund','AdminRefund','WithdrawalHold','WithdrawalPaid','WithdrawalRelease','Correction')),
	CONSTRAINT "ledger_transactions_reason_required" CHECK (char_length("ledger_transactions"."reason") >= 5),
	CONSTRAINT "ledger_transactions_tracking_shape" CHECK ("ledger_transactions"."tracking_code" ~ '^TX-[A-Z0-9]{8,16}$')
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"gateway" varchar(30) NOT NULL,
	"authority" varchar(120),
	"ref_id" varchar(120),
	"amount_rial" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'Pending' NOT NULL,
	"callback_count" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"idempotency_key" varchar(200) NOT NULL,
	"return_to" varchar(500) DEFAULT '/wallet' NOT NULL,
	"last_error" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('Pending','Paid','Failed','NeedsReview')),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_rial" > 0),
	CONSTRAINT "payments_gateway_check" CHECK ("payments"."gateway" IN ('zarinpal','sandbox')),
	CONSTRAINT "payments_return_to_internal" CHECK ("payments"."return_to" ~ '^/[a-zA-Z0-9/_?=&.%-]*$')
);
--> statement-breakpoint
CREATE TABLE "withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"iban_encrypted" text NOT NULL,
	"iban_last4" varchar(4) NOT NULL,
	"status" varchar(20) DEFAULT 'Pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"reason" text,
	"bank_reference" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_requests_status_check" CHECK ("withdrawal_requests"."status" IN ('Pending','Approved','Paid','Rejected','Cancelled')),
	CONSTRAINT "withdrawal_requests_amount_positive" CHECK ("withdrawal_requests"."amount_rial" > 0),
	CONSTRAINT "withdrawal_requests_amount_safe_range" CHECK ("withdrawal_requests"."amount_rial" <= 9000000000000000),
	CONSTRAINT "withdrawal_requests_iban_last4_shape" CHECK ("withdrawal_requests"."iban_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "withdrawal_requests_reject_requires_reason" CHECK ("withdrawal_requests"."status" <> 'Rejected' OR "withdrawal_requests"."reason" IS NOT NULL),
	CONSTRAINT "withdrawal_requests_paid_requires_reference" CHECK ("withdrawal_requests"."status" <> 'Paid' OR "withdrawal_requests"."bank_reference" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"actor_id" uuid,
	"actor_label" varchar(160) DEFAULT '' NOT NULL,
	"action" varchar(80) NOT NULL,
	"target_type" varchar(60) DEFAULT '' NOT NULL,
	"target_id" varchar(64) DEFAULT '' NOT NULL,
	"details" jsonb,
	"ip" varchar(64) DEFAULT '' NOT NULL,
	"user_agent" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("audit_logs"."actor_type" IN ('Staff','Student','Employee','System','Anonymous','Gateway'))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"uploaded_by" uuid,
	"status" varchar(20) DEFAULT 'Preview' NOT NULL,
	"policy" varchar(30) DEFAULT 'SkipInvalidRows' NOT NULL,
	"full_sync" boolean DEFAULT false NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"new_rows" integer DEFAULT 0 NOT NULL,
	"changed_rows" integer DEFAULT 0 NOT NULL,
	"unchanged_rows" integer DEFAULT 0 NOT NULL,
	"returning_rows" integer DEFAULT 0 NOT NULL,
	"removed_rows" integer DEFAULT 0 NOT NULL,
	"conflict_rows" integer DEFAULT 0 NOT NULL,
	"file_fingerprint" varchar(64),
	"error_report" jsonb,
	"approved_conflicts" jsonb,
	"committed_at" timestamp with time zone,
	"committed_by" uuid,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_status_check" CHECK ("import_batches"."status" IN ('Preview','Committed','Cancelled','Failed','Undone')),
	CONSTRAINT "import_batches_policy_check" CHECK ("import_batches"."policy" IN ('RejectAllOnError','SkipInvalidRows')),
	CONSTRAINT "import_batches_counts_non_negative" CHECK ("import_batches"."total_rows" >= 0 AND "import_batches"."valid_rows" >= 0 AND "import_batches"."error_rows" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"student_number" varchar(20) DEFAULT '' NOT NULL,
	"full_name" varchar(200) DEFAULT '' NOT NULL,
	"faculty" varchar(200) DEFAULT '' NOT NULL,
	"major" varchar(200) DEFAULT '' NOT NULL,
	"degree" varchar(100) DEFAULT '' NOT NULL,
	"entry_year" integer,
	"national_id_hash" varchar(64) DEFAULT '' NOT NULL,
	"national_id_last4" varchar(4) DEFAULT '' NOT NULL,
	"kind" varchar(20) DEFAULT 'new' NOT NULL,
	"student_id" uuid,
	"errors" jsonb,
	"changes" jsonb,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_kind_check" CHECK ("import_rows"."kind" IN ('new','changed','unchanged','returning','conflict','error')),
	CONSTRAINT "import_rows_no_raw_national_id" CHECK ("import_rows"."national_id_hash" = '' OR char_length("import_rows"."national_id_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" varchar(60) NOT NULL,
	"status" varchar(20) DEFAULT 'Running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"message" text,
	"details" jsonb,
	"worker_id" varchar(80) DEFAULT '' NOT NULL,
	CONSTRAINT "job_runs_status_check" CHECK ("job_runs"."status" IN ('Running','Ok','Failed','Skipped')),
	CONSTRAINT "job_runs_finished_after_start" CHECK ("job_runs"."finished_at" IS NULL OR "job_runs"."finished_at" >= "job_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid,
	"recipient" varchar(20) DEFAULT '' NOT NULL,
	"account_id" uuid,
	"message" text NOT NULL,
	"status" varchar(20) DEFAULT 'Queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(300),
	"provider_message_id" varchar(120),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_status_check" CHECK ("notification_outbox"."status" IN ('Queued','Sent','Failed','Skipped')),
	CONSTRAINT "notification_outbox_attempts_bound" CHECK ("notification_outbox"."attempts" >= 0 AND "notification_outbox"."attempts" <= 20)
);
--> statement-breakpoint
CREATE TABLE "notification_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"subject_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_reads_subject_check" CHECK ("notification_reads"."subject_type" IN ('Account','Staff'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"audience" varchar(20) DEFAULT 'Broadcast' NOT NULL,
	"account_id" uuid,
	"staff_user_id" uuid,
	"event" varchar(60),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_audience_check" CHECK ("notifications"."audience" IN ('Broadcast','Account','Staff')),
	CONSTRAINT "notifications_audience_target" CHECK (("notifications"."audience" = 'Broadcast' AND "notifications"."account_id" IS NULL AND "notifications"."staff_user_id" IS NULL)
        OR ("notifications"."audience" = 'Account' AND "notifications"."account_id" IS NOT NULL AND "notifications"."staff_user_id" IS NULL)
        OR ("notifications"."audience" = 'Staff' AND "notifications"."staff_user_id" IS NOT NULL AND "notifications"."account_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar(60) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_cafeteria_id_cafeterias_id_fk" FOREIGN KEY ("cafeteria_id") REFERENCES "public"."cafeterias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cafeterias" ADD CONSTRAINT "cafeterias_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_offerings" ADD CONSTRAINT "meal_offerings_meal_slot_id_meal_slots_id_fk" FOREIGN KEY ("meal_slot_id") REFERENCES "public"."meal_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_offerings" ADD CONSTRAINT "meal_offerings_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_offerings" ADD CONSTRAINT "meal_offerings_cafeteria_id_cafeterias_id_fk" FOREIGN KEY ("cafeteria_id") REFERENCES "public"."cafeterias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offering_price_history" ADD CONSTRAINT "offering_price_history_offering_id_meal_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."meal_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offering_prices" ADD CONSTRAINT "offering_prices_offering_id_meal_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."meal_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_operator_id_staff_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_cafeteria_id_cafeterias_id_fk" FOREIGN KEY ("cafeteria_id") REFERENCES "public"."cafeterias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_history" ADD CONSTRAINT "reservation_history_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offering_id_meal_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."meal_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_meal_slot_id_meal_slots_id_fk" FOREIGN KEY ("meal_slot_id") REFERENCES "public"."meal_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cafeteria_id_cafeterias_id_fk" FOREIGN KEY ("cafeteria_id") REFERENCES "public"."cafeterias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_delivered_by_staff_users_id_fk" FOREIGN KEY ("delivered_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_reviewed_by_staff_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_staff_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_student_id_key" ON "accounts" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_employee_id_key" ON "accounts" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "captchas_expires_at_idx" ON "captchas" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_username_key" ON "employees" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_personnel_code_key" ON "employees" USING btree ("personnel_code");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("status");--> statement-breakpoint
CREATE INDEX "employees_customer_group_idx" ON "employees" USING btree ("customer_group");--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_ip_idx" ON "login_attempts" USING btree ("identifier_hash","ip","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_idx" ON "login_attempts" USING btree ("identifier_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_subject_idx" ON "sessions" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_username_key" ON "staff_users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "staff_users_role_idx" ON "staff_users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "staff_users_status_idx" ON "staff_users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "staff_users_contractor_idx" ON "staff_users" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "staff_users_cafeteria_idx" ON "staff_users" USING btree ("cafeteria_id");--> statement-breakpoint
CREATE UNIQUE INDEX "students_student_number_key" ON "students" USING btree ("student_number");--> statement-breakpoint
CREATE UNIQUE INDEX "students_national_id_hash_key" ON "students" USING btree ("national_id_hash");--> statement-breakpoint
CREATE INDEX "students_status_idx" ON "students" USING btree ("status");--> statement-breakpoint
CREATE INDEX "students_faculty_idx" ON "students" USING btree ("faculty");--> statement-breakpoint
CREATE INDEX "students_last_import_batch_idx" ON "students" USING btree ("last_import_batch_id");--> statement-breakpoint
CREATE INDEX "cafeterias_contractor_idx" ON "cafeterias" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "cafeterias_active_idx" ON "cafeterias" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "contractors_name_active_key" ON "contractors" USING btree ("name") WHERE "contractors"."is_active" = true;--> statement-breakpoint
CREATE INDEX "contractors_active_idx" ON "contractors" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "foods_active_idx" ON "foods" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "foods_category_idx" ON "foods" USING btree ("category");--> statement-breakpoint
CREATE INDEX "meal_offerings_service_date_slot_idx" ON "meal_offerings" USING btree ("service_date","meal_slot_id");--> statement-breakpoint
CREATE INDEX "meal_offerings_cafeteria_date_idx" ON "meal_offerings" USING btree ("cafeteria_id","service_date");--> statement-breakpoint
CREATE INDEX "meal_offerings_food_idx" ON "meal_offerings" USING btree ("food_id");--> statement-breakpoint
CREATE INDEX "meal_offerings_status_idx" ON "meal_offerings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_offerings_unique_slot_food" ON "meal_offerings" USING btree ("service_date","meal_slot_id","cafeteria_id","food_id") WHERE "meal_offerings"."status" <> 'Cancelled' AND "meal_offerings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_slots_code_key" ON "meal_slots" USING btree ("code");--> statement-breakpoint
CREATE INDEX "offering_price_history_offering_idx" ON "offering_price_history" USING btree ("offering_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_client_event_id_key" ON "deliveries" USING btree ("client_event_id");--> statement-breakpoint
CREATE INDEX "deliveries_reservation_idx" ON "deliveries" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "deliveries_cafeteria_received_idx" ON "deliveries" USING btree ("cafeteria_id","received_at");--> statement-breakpoint
CREATE INDEX "deliveries_operator_idx" ON "deliveries" USING btree ("operator_id","received_at");--> statement-breakpoint
CREATE INDEX "reservation_history_reservation_idx" ON "reservation_history" USING btree ("reservation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_code_key" ON "reservations" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_idempotency_key" ON "reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_qr_token_key" ON "reservations" USING btree ("qr_token");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_one_live_per_slot" ON "reservations" USING btree ("account_id","service_date","meal_slot_id") WHERE "reservations"."status" IN ('Reserved','Delivered');--> statement-breakpoint
CREATE INDEX "reservations_account_status_idx" ON "reservations" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "reservations_offering_status_idx" ON "reservations" USING btree ("offering_id","status");--> statement-breakpoint
CREATE INDEX "reservations_service_date_idx" ON "reservations" USING btree ("service_date","status");--> statement-breakpoint
CREATE INDEX "reservations_cafeteria_date_idx" ON "reservations" USING btree ("cafeteria_id","service_date");--> statement-breakpoint
CREATE INDEX "reservations_created_at_idx" ON "reservations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_created_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_system_account_idx" ON "ledger_entries" USING btree ("system_account");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key" ON "ledger_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_tracking_code" ON "ledger_transactions" USING btree ("tracking_code");--> statement-breakpoint
CREATE INDEX "ledger_transactions_created_at_idx" ON "ledger_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_transactions_reference_idx" ON "ledger_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_authority_key" ON "payments" USING btree ("authority");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_account_created_idx" ON "payments" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_created_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_account_idx" ON "withdrawal_requests" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_status_created_idx" ON "withdrawal_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "import_batches_status_idx" ON "import_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "import_batches_created_at_idx" ON "import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "import_batches_fingerprint_idx" ON "import_batches" USING btree ("file_fingerprint");--> statement-breakpoint
CREATE INDEX "import_rows_batch_idx" ON "import_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_student_number_idx" ON "import_rows" USING btree ("student_number");--> statement-breakpoint
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_reads_unique" ON "notification_reads" USING btree ("notification_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "notifications_account_created_idx" ON "notifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_staff_created_idx" ON "notifications" USING btree ("staff_user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");