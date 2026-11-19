ALTER TYPE "public"."operation_type" ADD VALUE 'collect_transfer';--> statement-breakpoint
ALTER TYPE "public"."operation_type" ADD VALUE 'dispute_fee';--> statement-breakpoint
CREATE TABLE "collect_reserve_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"currency" char(3) NOT NULL,
	"available_minor" bigint,
	"held_minor" bigint NOT NULL,
	"own_minor" bigint,
	"warning_minor" bigint NOT NULL,
	"critical_minor" bigint NOT NULL,
	"level" text,
	"read_at" timestamp with time zone NOT NULL,
	"alerted_at" timestamp with time zone,
	"alert_claimed_at" timestamp with time zone,
	CONSTRAINT "collect_reserve_readings_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "collect_reserve_readings_provider" CHECK (provider ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "collect_reserve_readings_amounts" CHECK (held_minor >= 0 AND critical_minor >= 0 AND critical_minor < warning_minor),
	CONSTRAINT "collect_reserve_readings_own" CHECK ((available_minor IS NULL AND own_minor IS NULL AND level IS NULL)
        OR (available_minor IS NOT NULL AND own_minor IS NOT NULL AND own_minor = available_minor - held_minor)),
	CONSTRAINT "collect_reserve_readings_level" CHECK (own_minor IS NULL OR (level IS NOT NULL AND level = CASE
          WHEN own_minor < 0 THEN 'breach'
          WHEN own_minor < critical_minor THEN 'critical'
          WHEN own_minor < warning_minor THEN 'warning'
          ELSE 'ok' END))
);
--> statement-breakpoint
CREATE TABLE "collect_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cap_minor" bigint NOT NULL,
	"cap_days" integer NOT NULL,
	"reminder_days" integer[] NOT NULL,
	"delay_hours" integer NOT NULL,
	"delay_for_days" integer NOT NULL,
	"first_withdrawal_cap_minor" bigint NOT NULL,
	"new_daily_limit_minor" bigint NOT NULL,
	"new_daily_limit_days" integer NOT NULL,
	"reserve_warning_minor" bigint NOT NULL,
	"reserve_critical_minor" bigint NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" uuid,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collect_settings_cap_minor" CHECK (cap_minor BETWEEN 1000000 AND 50000000),
	CONSTRAINT "collect_settings_cap_days" CHECK (cap_days BETWEEN 7 AND 90),
	CONSTRAINT "collect_settings_reminder_days" CHECK (cardinality(reminder_days) BETWEEN 1 AND 10
        AND array_position(reminder_days, NULL) IS NULL
        AND 1 <= ALL (reminder_days) AND cap_days > ALL (reminder_days)),
	CONSTRAINT "collect_settings_delay" CHECK (delay_hours BETWEEN 0 AND 72 AND delay_for_days BETWEEN 0 AND 30),
	CONSTRAINT "collect_settings_first_withdrawal_cap" CHECK (first_withdrawal_cap_minor > 0),
	CONSTRAINT "collect_settings_new_daily_limit" CHECK (new_daily_limit_minor > 0 AND new_daily_limit_days BETWEEN 0 AND 365),
	CONSTRAINT "collect_settings_reserve" CHECK (reserve_critical_minor >= 0 AND reserve_critical_minor < reserve_warning_minor),
	CONSTRAINT "collect_settings_reason" CHECK (char_length(reason) > 0)
);
--> statement-breakpoint
CREATE TABLE "collect_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"tip_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"business_id" uuid,
	"refund_id" uuid,
	"dispute_id" uuid,
	"account_reference" text,
	"provider" text NOT NULL,
	"environment" "provider_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text NOT NULL,
	"review_reason" text,
	"idempotency_key" text NOT NULL,
	"transfer_reference" text,
	"charge_reference" text,
	"release_after" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collect_transfers_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "collect_transfers_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "collect_transfers_kind" CHECK (kind IN ('share', 'back')),
	CONSTRAINT "collect_transfers_status" CHECK (status IN ('waiting', 'ready', 'sent', 'unknown', 'paid', 'cancelled', 'review')),
	CONSTRAINT "collect_transfers_amount" CHECK (amount_minor > 0),
	CONSTRAINT "collect_transfers_attempts" CHECK (attempts >= 0),
	CONSTRAINT "collect_transfers_provider" CHECK (provider ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "collect_transfers_back_source" CHECK ((kind = 'share' AND refund_id IS NULL AND dispute_id IS NULL)
        OR (kind = 'back' AND (refund_id IS NULL) <> (dispute_id IS NULL))),
	CONSTRAINT "collect_transfers_key" CHECK ((kind = 'share' AND idempotency_key = 'tipme-collect-' || tip_id::text)
        OR (kind = 'back' AND idempotency_key = 'tipme-collect-back-' || coalesce(refund_id, dispute_id)::text)),
	CONSTRAINT "collect_transfers_review_reason" CHECK ((review_reason IS NULL OR review_reason IN ('dispute', 'same_bank', 'provider', 'refund', 'staff'))
        AND (status <> 'review' OR review_reason IS NOT NULL)),
	CONSTRAINT "collect_transfers_account" CHECK (status IN ('waiting', 'cancelled', 'review') OR account_reference IS NOT NULL),
	CONSTRAINT "collect_transfers_paid" CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"partner_dispute_id" text NOT NULL,
	"tip_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"respond_by" timestamp with time zone,
	"evidence_state" text DEFAULT 'none' NOT NULL,
	"fee_minor" bigint,
	"fee_currency" char(3),
	"set_aside_minor" bigint,
	"held_minor" bigint DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_partner_dispute_id_unique" UNIQUE("partner_dispute_id"),
	CONSTRAINT "disputes_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "disputes_provider" CHECK (provider ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "disputes_amount" CHECK (amount_minor > 0),
	CONSTRAINT "disputes_status" CHECK (status IN ('open', 'responded', 'won', 'lost', 'closed')),
	CONSTRAINT "disputes_evidence_state" CHECK (evidence_state IN ('none', 'draft', 'submitted')),
	CONSTRAINT "disputes_fee" CHECK ((fee_minor IS NULL OR fee_minor >= 0) AND (fee_currency IS NULL OR fee_currency ~ '^[A-Z]{3}$')),
	CONSTRAINT "disputes_set_aside" CHECK (set_aside_minor IS NULL OR set_aside_minor >= 0),
	CONSTRAINT "disputes_held" CHECK (held_minor >= 0 AND held_minor <= amount_minor)
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_business_payable";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "share_transfers" DROP CONSTRAINT "share_transfers_kind";--> statement-breakpoint
DROP INDEX "share_transfers_one_sweep";--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "account_hash" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "collection_mode" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "collect_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "collect_legal_name" text;--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD COLUMN "collection_mode" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "collect_settings" ADD CONSTRAINT "collect_settings_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_settings" ADD CONSTRAINT "collect_settings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_refund_id_tip_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."tip_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collect_reserve_readings_latest" ON "collect_reserve_readings" USING btree ("provider","currency","read_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collect_settings_effective_from" ON "collect_settings" USING btree ("effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "collect_transfers_one_share" ON "collect_transfers" USING btree ("tip_id") WHERE kind = 'share';--> statement-breakpoint
CREATE INDEX "collect_transfers_due" ON "collect_transfers" USING btree ("status","next_try_at");--> statement-breakpoint
CREATE INDEX "collect_transfers_profile" ON "collect_transfers" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "disputes_tip" ON "disputes" USING btree ("tip_id");--> statement-breakpoint
CREATE INDEX "disputes_status" ON "disputes" USING btree ("status","respond_by");--> statement-breakpoint
CREATE INDEX "payout_destinations_account_hash" ON "payout_destinations" USING btree ("account_hash") WHERE account_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_one_sweep" ON "share_transfers" USING btree ("tip_id") WHERE kind IN ('sweep', 'collect_sweep');--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_fee_adjusted', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed', 'support_request', 'pro_collect_unknown', 'pro_refund_failed', 'share_transfer_stuck', 'tip_refund_failed', 'collect_transfer_stuck', 'collect_transfer_review', 'collect_in_debt', 'collect_invariant_broken', 'collect_reserve_low', 'collect_auto_payout_on', 'collect_recon_mismatch', 'collect_same_bank', 'dispute_opened', 'dispute_deadline', 'dispute_fee_unposted', 'collect_refund_gap'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_business_payable" CHECK ((code <> 'business_payable' OR business_id IS NOT NULL) AND (business_id IS NULL OR code IN ('business_payable', 'held_for_recipients')));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK (kind IN ('tip', 'weekly_report', 'moment', 'collect_reminder', 'collect_verified', 'dispute_hold', 'business_invitation', 'business_verified', 'business_share_held_back'));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_collection_mode" CHECK (collection_mode IN ('direct', 'collect'));--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_kind" CHECK (kind IN ('sweep', 'recover', 'fee_return', 'holdback_repay', 'collect_sweep'));--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD CONSTRAINT "tip_quotes_collection_mode" CHECK (collection_mode IN ('direct', 'collect'));--> statement-breakpoint
-- You collect (ADR-0016, PROPOSED; plan Task 3). Hand-written below the generated part, as 0118.
-- Settings are history (like plan_fee_rates, 0118): never edited, deleted or truncated (tests opt in).
-- No row is seeded: with none, the coded defaults (COLLECT_DEFAULTS, spec section 9) are in force.
CREATE TRIGGER collect_settings_append_only BEFORE UPDATE OR DELETE ON collect_settings
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER collect_settings_no_truncate BEFORE TRUNCATE ON collect_settings
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint
-- Pre-flight ruling P2: a reversal of a collected tip. Its payment debited held_for_recipients (the
-- money TipMe holds on its own partner account for a person or a business) instead of
-- provider_clearing, so its refund and dispute postings (packages/domain ledger.ts) take back the held
-- money (a credit there), pay what TipMe absorbs out of its own balance (a credit on
-- platform_clearing) and book that as a cost (a debit on dispute_fee_expense, dispute_loss_expense or
-- refund_loss_expense). 0083 refused all three.
--
-- Only a reversal of a payment that debited held_for_recipients gains them:
--   - held_for_recipients follows the mirror rule and its per-account cap, the other way round: each
--     reversal entry there is a credit, and all reversals together take back at most what the payment
--     held for that owner;
--   - platform_clearing may only be credited and the three You collect costs only debited, with no cap,
--     as provider_clearing and provider_fee_expense below: the transaction still balances, so what
--     leaves TipMe's balance is exactly what the capped lines took back plus TipMe's own costs.
-- Every other reversal (direct and Pro) runs exactly as 0083: for it `holds` is false, so the branches
-- added here are skipped and `paid < 0` is refused as `paid <= 0` was.
CREATE OR REPLACE FUNCTION tipme_reversal_within_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original uuid;
  account_code text;
  paid numeric;
  taken numeric;
  holds boolean := false;
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
  IF account_code IN ('held_for_recipients', 'platform_clearing', 'dispute_fee_expense',
                      'dispute_loss_expense', 'refund_loss_expense') THEN
    SELECT EXISTS (
      SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE e.transaction_id = original AND a.code = 'held_for_recipients' AND e.side = 'debit'
    ) INTO holds;
  END IF;
  IF holds AND account_code <> 'held_for_recipients' THEN
    IF NEW.side <> (CASE account_code WHEN 'platform_clearing' THEN 'credit' ELSE 'debit' END)::ledger_side THEN
      RAISE EXCEPTION 'a reversal of a collected tip only pays out of TipMe''s own balance, as its cost'
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
  -- A payment's credit is taken back by debits; only a held amount (a debit) is taken back by credits.
  IF paid = 0
     OR (paid < 0 AND NOT (holds AND account_code = 'held_for_recipients'))
     OR NEW.side <> (CASE WHEN paid > 0 THEN 'debit' ELSE 'credit' END)::ledger_side
     OR abs(taken) > abs(paid) OR sign(taken) = sign(paid) THEN
    RAISE EXCEPTION 'a reversal takes back at most what the payment put on each account, as its mirror'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_reversal_within_payment';
  END IF;
  RETURN NULL;
END;
$$;
