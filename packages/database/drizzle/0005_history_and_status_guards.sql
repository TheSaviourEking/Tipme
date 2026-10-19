-- Closes the remaining ways to rewrite history directly in SQL (PR-005 review minors).

-- 1. TRUNCATE skips row triggers, so refuse it on history tables. Test resets opt in with
--    SET LOCAL tipme.allow_truncate = 'on' inside their own transaction.
CREATE FUNCTION tipme_forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('tipme.allow_truncate', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'append-only table %: TRUNCATE is not allowed', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON ledger_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint
CREATE TRIGGER status_transitions_no_truncate BEFORE TRUNCATE ON status_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint

-- 2. Accounts are immutable once created (a currency change would silently re-denominate postings).
CREATE TRIGGER ledger_accounts_append_only BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint

-- 3. An entry's recipient must be its account's recipient.
CREATE FUNCTION tipme_entry_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile_id IS DISTINCT FROM (SELECT profile_id FROM ledger_accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'ledger entry profile does not match its account profile'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_profile BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tipme_entry_profile();
--> statement-breakpoint

-- 4. Status changes follow the PRD state machines even for direct UPDATEs. These lists mirror
--    TIP_TRANSITIONS / ATTEMPT_TRANSITIONS / PAYOUT_TRANSITIONS in @tipme/domain; the
--    transitions-parity integration test fails if the two ever drift apart.
CREATE FUNCTION tipme_check_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  allowed := CASE TG_TABLE_NAME
    WHEN 'tips' THEN ARRAY[
      'DRAFT>AWAITING_PAYMENT', 'DRAFT>CANCELLED',
      'AWAITING_PAYMENT>PENDING_VERIFICATION', 'AWAITING_PAYMENT>SUCCEEDED', 'AWAITING_PAYMENT>FAILED', 'AWAITING_PAYMENT>CANCELLED',
      'PENDING_VERIFICATION>SUCCEEDED', 'PENDING_VERIFICATION>FAILED', 'PENDING_VERIFICATION>CANCELLED']
    WHEN 'payment_attempts' THEN ARRAY[
      'CREATED>INITIATED', 'CREATED>PENDING', 'CREATED>VERIFIED_SUCCEEDED', 'CREATED>VERIFIED_FAILED', 'CREATED>EXPIRED', 'CREATED>UNKNOWN',
      'INITIATED>PENDING', 'INITIATED>VERIFIED_SUCCEEDED', 'INITIATED>VERIFIED_FAILED', 'INITIATED>EXPIRED', 'INITIATED>UNKNOWN',
      'PENDING>VERIFIED_SUCCEEDED', 'PENDING>VERIFIED_FAILED', 'PENDING>EXPIRED', 'PENDING>UNKNOWN',
      'UNKNOWN>VERIFIED_SUCCEEDED', 'UNKNOWN>VERIFIED_FAILED']
    WHEN 'payouts' THEN ARRAY[
      'REQUESTED>PROCESSING', 'REQUESTED>PAID', 'REQUESTED>FAILED',
      'PROCESSING>PAID', 'PROCESSING>FAILED', 'PAID>REVERSED']
  END;
  IF NOT (OLD.status::text || '>' || NEW.status::text) = ANY (allowed) THEN
    RAISE EXCEPTION 'status transition % -> % is not allowed on %', OLD.status, NEW.status, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tips_status_transition BEFORE UPDATE OF status ON tips
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION tipme_check_status_transition();
--> statement-breakpoint
CREATE TRIGGER payment_attempts_status_transition BEFORE UPDATE OF status ON payment_attempts
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION tipme_check_status_transition();
--> statement-breakpoint
CREATE TRIGGER payouts_status_transition BEFORE UPDATE OF status ON payouts
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION tipme_check_status_transition();
