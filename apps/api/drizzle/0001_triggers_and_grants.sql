-- ============================================================================
-- 0001_triggers_and_grants.sql
-- ----------------------------------------------------------------------------
-- قیدهای رفتاری که با Drizzle قابل بیان نیستند:
--   ۱) نگهداری خودکار `updated_at`
--   ۲) append-only بودن دفتر کل، ممیزی، تاریخچهٔ رزرو و لاگ تحویل
--   ۳) ممنوعیت حذف فیزیکی رکوردهای مالی/دانشجو/رزرو/غذا
--      (استثنا: offering_prices، import_rows، sessions، login_attempts، captchas،
--       notifications و notification_outbox که دادهٔ مالی/ممیزی نیستند)
--   ۴) مجموع صفر هر تراکنش دفتر کل (constraint trigger تعویق‌پذیر)
--   ۵) سازگاری ستون‌های denormalized رزرو با وعدهٔ مربوطه
--   ۶) کلید خارجی students.last_import_batch_id (برای پرهیز از وابستگی حلقوی ماژول‌ها)
--   ۷) نقش‌های دیتابیسی food_migrator (مالک schema) و food_app (فقط DML)
--
-- این فایل با `drizzle-kit generate --custom` ساخته شده و توسط
-- `npm run db:migrate` اعمال می‌شود.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ۱) به‌روزرسانی خودکار updated_at
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

--> statement-breakpoint

DO $do$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'updated_at' AND NOT a.attisdropped
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_set_updated_at', t);
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END
$do$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- ۲) append-only: هیچ UPDATE یا DELETE روی این جدول‌ها مجاز نیست
--    (دفاع در عمق: علاوه بر REVOKE در سطح نقش food_app)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'جدول % فقط افزودنی (append-only) است؛ % مجاز نیست.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

--> statement-breakpoint

DO $do$
DECLARE
  t text;
  append_only constant text[] := ARRAY[
    'ledger_transactions', 'ledger_entries', 'audit_logs', 'reservation_history', 'deliveries'
  ];
BEGIN
  FOREACH t IN ARRAY append_only LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_append_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t);
  END LOOP;
END
$do$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- ۳) ممنوعیت حذف فیزیکی (حذف نرم با status/deleted_at/is_active انجام می‌شود)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'حذف فیزیکی رکورد در جدول % مجاز نیست؛ از غیرفعال‌سازی یا حذف نرم استفاده کنید.', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

--> statement-breakpoint

DO $do$
DECLARE
  t text;
  protected_tables constant text[] := ARRAY[
    'students', 'employees', 'staff_users', 'accounts',
    'contractors', 'cafeterias', 'foods', 'meal_slots', 'meal_offerings',
    'reservations', 'reservation_history', 'deliveries',
    'ledger_transactions', 'ledger_entries', 'payments', 'withdrawal_requests',
    'audit_logs', 'import_batches'
  ];
BEGIN
  FOREACH t IN ARRAY protected_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_hard_delete ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_no_hard_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_delete()', t);
  END LOOP;
END
$do$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- ۴) دفتر کل دوطرفه: مجموع amount_rial هر تراکنش باید صفر باشد.
--    CONSTRAINT TRIGGER با DEFERRABLE INITIALLY DEFERRED ⇒ بررسی در لحظهٔ COMMIT،
--    بنابراین ترتیب درج ورودی‌ها در یک تراکنش مهم نیست.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_check_zero_sum() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  total bigint;
  entries integer;
BEGIN
  SELECT COALESCE(SUM(amount_rial), 0), COUNT(*) INTO total, entries
  FROM public.ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF total <> 0 THEN
    RAISE EXCEPTION 'تراکنش دفتر کل % تراز نیست (مجموع = % ریال)', NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;

  IF entries < 2 THEN
    RAISE EXCEPTION 'تراکنش دفتر کل % باید حداقل دو ورودی (بدهکار و بستانکار) داشته باشد', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$fn$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_ledger_zero_sum ON public.ledger_entries;

CREATE CONSTRAINT TRIGGER trg_ledger_zero_sum
AFTER INSERT ON public.ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.ledger_check_zero_sum();

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- ۵) سازگاری ستون‌های denormalized رزرو با وعده
--    service_date / meal_slot_id / cafeteria_id همیشه از meal_offerings گرفته می‌شوند
--    تا ایندکس یکتای جزئی «یک رزرو فعال در هر وعده» قابل اتکا باشد.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reservations_sync_denormalized() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  o record;
BEGIN
  SELECT service_date, meal_slot_id, cafeteria_id INTO o
  FROM public.meal_offerings WHERE id = NEW.offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'وعدهٔ % وجود ندارد', NEW.offering_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.service_date := o.service_date;
  NEW.meal_slot_id := o.meal_slot_id;
  NEW.cafeteria_id := o.cafeteria_id;
  RETURN NEW;
END;
$fn$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_reservations_sync_denormalized ON public.reservations;

CREATE TRIGGER trg_reservations_sync_denormalized
BEFORE INSERT ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.reservations_sync_denormalized();

--> statement-breakpoint

-- تغییر روز/وعده/سلف یک آیتم منو که رزرو دارد ممنوع است (رزروها denormalized هستند).
CREATE OR REPLACE FUNCTION public.meal_offerings_protect_slot() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.reserved_count > 0 AND (
       NEW.service_date <> OLD.service_date
    OR NEW.meal_slot_id <> OLD.meal_slot_id
    OR NEW.cafeteria_id <> OLD.cafeteria_id
  ) THEN
    RAISE EXCEPTION 'برای وعده‌ای که % رزرو دارد، تاریخ، نوع وعده و سلف قابل تغییر نیست.', OLD.reserved_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_meal_offerings_protect_slot ON public.meal_offerings;

CREATE TRIGGER trg_meal_offerings_protect_slot
BEFORE UPDATE ON public.meal_offerings
FOR EACH ROW EXECUTE FUNCTION public.meal_offerings_protect_slot();

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- ۶) کلید خارجی که در ماژول‌های schema تعریف نشد (وابستگی حلقوی بین identity ↔ system)
-- ----------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'students_last_import_batch_id_fkey' AND conrelid = 'public.students'::regclass
  ) THEN
    ALTER TABLE public.students
      ADD CONSTRAINT students_last_import_batch_id_fkey
      FOREIGN KEY (last_import_batch_id) REFERENCES public.import_batches (id) ON DELETE SET NULL;
  END IF;
END
$do$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- ۷) نقش‌های دیتابیسی
--    food_migrator : مالک schema، فقط برای اجرای migration
--    food_app      : فقط DML؛ بدون UPDATE/DELETE روی جدول‌های append-only
--
--    رمز نقش‌ها در این فایل نیست (secret در SQL commit نمی‌شود).
--    اسکریپت `npm run db:migrate` در صورت وجود DB_APP_ROLE_PASSWORD /
--    DB_MIGRATOR_ROLE_PASSWORD آن‌ها را از env می‌خواند و با ALTER ROLE تعیین می‌کند.
-- ----------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'food_migrator') THEN
    CREATE ROLE food_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'food_app') THEN
    CREATE ROLE food_app NOLOGIN;
  END IF;
END
$do$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO food_app;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO food_app;

--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO food_app;

--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO food_app;

--> statement-breakpoint

-- تفکیک وظایف در سطح دیتابیس: برنامه اجرایی نمی‌تواند ممیزی یا دفتر کل را دستکاری کند.
REVOKE UPDATE, DELETE ON
  public.audit_logs,
  public.ledger_transactions,
  public.ledger_entries,
  public.reservation_history,
  public.deliveries
FROM food_app;

--> statement-breakpoint

-- محدودیت‌های محافظتی برای اتصال برنامه
ALTER ROLE food_app SET statement_timeout = '30s';

--> statement-breakpoint

ALTER ROLE food_app SET idle_in_transaction_session_timeout = '120s';

--> statement-breakpoint

ALTER ROLE food_app SET lock_timeout = '10s';

--> statement-breakpoint

COMMENT ON SCHEMA public IS 'سامانه اتوماسیون تغذیه دانشگاه شمال — نقش اجرایی food_app فقط DML دارد؛ migration با food_migrator اجرا می‌شود.';
