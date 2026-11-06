-- Business release 2, PR R2-A: a reversal follows the payment partner's refund guide
-- (docs.bachs.io/guides/refunds): "Fees already charged are not returned." So a refund takes back
-- what the payment owed (each account the payment credited: the person's and the business's parts,
-- TipMe's fee, the provider fee it recovered), while the partner balance drops by the whole refund
-- and the provider fee, plus any fee the refund itself carries, stays TipMe's expense.
--
-- The mirror rule and the per-account cap of 0079 (section 6) stay for every account the payment
-- credited: a reversal entry there is a debit, and all reversals of the payment together take back at
-- most what it credited. On TipMe's own side of the partner balance, a reversal may only credit
-- provider_clearing (money leaving it) and only debit provider_fee_expense (a cost TipMe bears),
-- with no cap: the transaction still balances (ledger_entries_balanced), so what leaves the partner
-- balance is exactly what the capped lines took back plus TipMe's own refund fees.
CREATE OR REPLACE FUNCTION tipme_reversal_within_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original uuid;
  account_code text;
  paid numeric;
  taken numeric;
BEGIN
  SELECT reverses_transaction_id INTO original FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF original IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT code INTO account_code FROM ledger_accounts WHERE id = NEW.account_id;
  IF account_code = 'provider_clearing' OR account_code = 'provider_fee_expense' THEN
    IF NEW.side <> (CASE account_code WHEN 'provider_clearing' THEN 'credit' ELSE 'debit' END)::ledger_side THEN
      RAISE EXCEPTION 'a reversal only takes money out of the partner balance, and never takes back a fee'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_reversal_within_payment';
    END IF;
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tipme.reversal.' || original::text, 0));
  -- What the payment put on this account: credits positive, debits negative.
  SELECT coalesce(sum(CASE side WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0)
    INTO paid FROM ledger_entries WHERE transaction_id = original AND account_id = NEW.account_id;
  -- What every reversal of the payment, this one included, has put on it.
  SELECT coalesce(sum(CASE e.side WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
    INTO taken
    FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
   WHERE t.reverses_transaction_id = original AND e.account_id = NEW.account_id;
  IF paid <= 0
     OR NEW.side <> 'debit'::ledger_side
     OR abs(taken) > abs(paid) OR sign(taken) = sign(paid) THEN
    RAISE EXCEPTION 'a reversal takes back at most what the payment put on each account, as its mirror'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_reversal_within_payment';
  END IF;
  RETURN NULL;
END;
$$;
