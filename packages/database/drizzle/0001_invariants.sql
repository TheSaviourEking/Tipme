-- Financial invariants enforced by the database itself (ADR-0002, ADR-0006).
-- Code is careful; the database is the last line of defence.

-- 1. History is append-only: ledger rows and status transitions can never be edited or deleted.
CREATE FUNCTION tipme_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER status_transitions_append_only BEFORE UPDATE OR DELETE ON status_transitions
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint

-- 2. Every entry uses its transaction's and its account's currency.
CREATE FUNCTION tipme_entry_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency <> (SELECT currency FROM ledger_transactions WHERE id = NEW.transaction_id)
     OR NEW.currency <> (SELECT currency FROM ledger_accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'ledger entry currency % does not match its transaction or account', NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_currency BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tipme_entry_currency();
--> statement-breakpoint

-- 3. Every transaction balances (debits = credits, at least two entries), checked at COMMIT so
--    entries can be inserted one by one inside the transaction.
CREATE FUNCTION tipme_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_count integer;
  net numeric;
BEGIN
  SELECT count(*), coalesce(sum(CASE side WHEN 'debit' THEN amount_minor ELSE -amount_minor END), 0)
    INTO entry_count, net
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF entry_count < 2 OR net <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction % (% entries, net %)', NEW.transaction_id, entry_count, net
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tipme_transaction_balanced();
--> statement-breakpoint

-- A transaction with no entries at all fires no entry trigger, so check it from its own row too.
CREATE FUNCTION tipme_transaction_has_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM ledger_entries WHERE transaction_id = NEW.id) < 2 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction % (fewer than 2 entries)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_has_entries AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tipme_transaction_has_entries();
