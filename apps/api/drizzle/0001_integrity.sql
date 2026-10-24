-- Append-only enforcement for financial and audit tables.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% forbidden)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
-- Every ledger transaction must sum to zero and have >= 2 entries; checked at COMMIT.
CREATE OR REPLACE FUNCTION check_ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s numeric; n int;
BEGIN
  SELECT COALESCE(SUM(amount_rial), 0), COUNT(*) INTO s, n FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF s <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum=%, entries=%)', NEW.transaction_id, s, n USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_balanced();
--> statement-breakpoint
-- Least-privilege grants for the runtime role, applied only when the role exists (created by deploy/provision.sh).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'food_app') THEN
    GRANT USAGE ON SCHEMA public TO food_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO food_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, ledger_transactions FROM food_app;
    -- physical deletes only for ephemeral housekeeping tables
    GRANT DELETE ON sessions, login_attempts, captchas, import_rows, notification_outbox TO food_app;
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO food_app', current_user);
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO food_app;
  END IF;
END $$;
