-- A ledger transaction's entries can only be written in the database transaction that created it.
-- Without this, a later transaction could append a balanced pair to an existing operation and
-- change its postings after the fact (append-only must mean the whole posting, not just rows).

-- Creating a ledger transaction opens it for the rest of the current database transaction only
-- (set_config with is_local = true is discarded at COMMIT or ROLLBACK).
CREATE FUNCTION tipme_open_ledger_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('tipme.open_txn_' || replace(NEW.id::text, '-', '_'), 'open', true);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_open AFTER INSERT ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION tipme_open_ledger_transaction();
--> statement-breakpoint
CREATE FUNCTION tipme_entry_requires_open_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('tipme.open_txn_' || replace(NEW.transaction_id::text, '-', '_'), true) IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'ledger transaction % is closed: entries must be posted when it is created', NEW.transaction_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_open_transaction BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tipme_entry_requires_open_transaction();
