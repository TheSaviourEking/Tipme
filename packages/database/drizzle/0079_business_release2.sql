ALTER TYPE "public"."operation_type" ADD VALUE 'reversal';--> statement-breakpoint
CREATE TABLE "share_agreements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"business_bps" integer NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_by_user" uuid NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"superseded_by" uuid,
	CONSTRAINT "share_agreements_bps" CHECK (business_bps IN (0, 1000, 2000, 3000, 5000)),
	CONSTRAINT "share_agreements_proposed_by" CHECK (proposed_by IN ('business', 'member')),
	CONSTRAINT "share_agreements_notice" CHECK (effective_from >= proposed_at + interval '14 days'),
	CONSTRAINT "share_agreements_answer" CHECK ((accepted_at IS NOT NULL)::int + (declined_at IS NOT NULL)::int + (withdrawn_at IS NOT NULL)::int <= 1),
	CONSTRAINT "share_agreements_ended" CHECK ((ended_at IS NULL AND superseded_by IS NULL) OR accepted_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "share_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_reports_reason" CHECK (reason IN ('pressure', 'wrong_share', 'other')),
	CONSTRAINT "share_reports_body" CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 280)
);
--> statement-breakpoint
CREATE TABLE "table_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"card_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"label" text NOT NULL,
	"code" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "table_cards_code_unique" UNIQUE("code"),
	CONSTRAINT "table_cards_label" CHECK (char_length(label) BETWEEN 1 AND 20),
	CONSTRAINT "table_cards_code" CHECK (code ~ '^[a-z2-7]{10}$')
);
--> statement-breakpoint
CREATE TABLE "team_tip_splits" (
	"tip_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "team_tip_splits_tip_id_member_id_pk" PRIMARY KEY("tip_id","member_id"),
	CONSTRAINT "team_tip_splits_positive" CHECK (amount_minor > 0)
);
--> statement-breakpoint
CREATE TABLE "tip_business_shares" (
	"tip_id" uuid PRIMARY KEY NOT NULL,
	"agreement_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"business_bps" integer NOT NULL,
	"share_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_business_shares_bps" CHECK (business_bps IN (1000, 2000, 3000, 5000)),
	CONSTRAINT "tip_business_shares_positive" CHECK (share_minor > 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_identity";--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "payment_accounts" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_destinations" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_quotes" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tips" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD COLUMN "reverses_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "team_location_id" uuid;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD COLUMN "team_location_id" uuid;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "team_location_id" uuid;--> statement-breakpoint
ALTER TABLE "share_agreements" ADD CONSTRAINT "share_agreements_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_agreements" ADD CONSTRAINT "share_agreements_proposed_by_user_users_id_fk" FOREIGN KEY ("proposed_by_user") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_agreements" ADD CONSTRAINT "share_agreements_superseded_by_share_agreements_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."share_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_reports" ADD CONSTRAINT "share_reports_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_reports" ADD CONSTRAINT "share_reports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_assignments" ADD CONSTRAINT "table_assignments_card_id_table_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."table_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_assignments" ADD CONSTRAINT "table_assignments_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_assignments" ADD CONSTRAINT "table_assignments_shift_id_business_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."business_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_assignments" ADD CONSTRAINT "table_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_cards" ADD CONSTRAINT "table_cards_location_id_business_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_cards" ADD CONSTRAINT "table_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_tip_splits" ADD CONSTRAINT "team_tip_splits_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_tip_splits" ADD CONSTRAINT "team_tip_splits_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_tip_splits" ADD CONSTRAINT "team_tip_splits_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_business_shares" ADD CONSTRAINT "tip_business_shares_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_business_shares" ADD CONSTRAINT "tip_business_shares_agreement_id_share_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."share_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_business_shares" ADD CONSTRAINT "tip_business_shares_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_agreements_in_force" ON "share_agreements" USING btree ("member_id") WHERE accepted_at IS NOT NULL AND ended_at IS NULL AND superseded_by IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "share_agreements_open" ON "share_agreements" USING btree ("member_id") WHERE accepted_at IS NULL AND declined_at IS NULL AND withdrawn_at IS NULL;--> statement-breakpoint
CREATE INDEX "share_agreements_member" ON "share_agreements" USING btree ("member_id","effective_from");--> statement-breakpoint
CREATE INDEX "share_reports_business" ON "share_reports" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "share_reports_member" ON "share_reports" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "table_assignments_open" ON "table_assignments" USING btree ("card_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "table_assignments_member" ON "table_assignments" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "table_assignments_shift" ON "table_assignments" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "table_cards_location" ON "table_cards" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "team_tip_splits_profile" ON "team_tip_splits" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "tip_business_shares_business" ON "tip_business_shares" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "tip_business_shares_agreement" ON "tip_business_shares" USING btree ("agreement_id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reverses_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("reverses_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_team_location_id_business_locations_id_fk" FOREIGN KEY ("team_location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD CONSTRAINT "tip_quotes_team_location_id_business_locations_id_fk" FOREIGN KEY ("team_location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_team_location_id_business_locations_id_fk" FOREIGN KEY ("team_location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_business" ON "ledger_entries" USING btree ("business_id") WHERE business_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_transactions_reverses" ON "ledger_transactions" USING btree ("reverses_transaction_id") WHERE reverses_transaction_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destinations_business_active" ON "payout_destinations" USING btree ("business_id","provider") WHERE replaced_at IS NULL AND business_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payouts_business_created" ON "payouts" USING btree ("business_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE business_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tips_team_location_created" ON "tips" USING btree ("team_location_id","created_at") WHERE team_location_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_identity" UNIQUE NULLS NOT DISTINCT("code","currency","profile_id","business_id");--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_business_provider_environment" UNIQUE("business_id","provider","environment");--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_team_idempotency" UNIQUE("team_location_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_one_owner" CHECK (profile_id IS NULL OR business_id IS NULL);--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_business_payable" CHECK ((code = 'business_payable') = (business_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reversal" CHECK ((operation_type::text = 'reversal') = (reverses_transaction_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_owner" CHECK ((profile_id IS NULL) <> (business_id IS NULL));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_recipient" CHECK ((profile_id IS NULL) <> (team_location_id IS NULL));--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_owner" CHECK ((profile_id IS NULL) <> (business_id IS NULL));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_owner" CHECK ((profile_id IS NULL) <> (business_id IS NULL));--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD CONSTRAINT "tip_quotes_recipient" CHECK ((profile_id IS NULL) <> (team_location_id IS NULL));--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_recipient" CHECK ((profile_id IS NULL) <> (team_location_id IS NULL));--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_team_no_member" CHECK (team_location_id IS NULL OR business_member_id IS NULL);--> statement-breakpoint
-- Business release 2 (plan R2-0 Task 27): what the database itself refuses, so no lane can write
-- a share, a split, an assignment or a reversal wrongly. Hand-written below the generated part.

-- 1. A share is fixed on a tip once (append-only) and only as agreed: the tip was made at the
--    agreement's membership (so a tip through the person's own page, with no member, never can be),
--    the agreement was accepted and in force when the tip was made, the business is the member's,
--    and the amount is exactly the agreed share of the tip's net, rounded down (Q9).
CREATE FUNCTION tipme_tip_business_share_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tip_member uuid;
  tip_made timestamptz;
  net bigint;
  agreement record;
  member_business uuid;
  successor_from timestamptz;
BEGIN
  SELECT t.business_member_id, t.created_at, q.recipient_net_minor
    INTO tip_member, tip_made, net
    FROM tips t
    JOIN payment_intents i ON i.id = t.intent_id
    JOIN tip_quotes q ON q.id = i.quote_id
   WHERE t.id = NEW.tip_id;
  SELECT * INTO agreement FROM share_agreements WHERE id = NEW.agreement_id;
  IF tip_member IS NULL OR tip_member IS DISTINCT FROM agreement.member_id THEN
    RAISE EXCEPTION 'a share needs a tip made at the agreement''s membership'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tip_business_shares_member';
  END IF;
  SELECT l.business_id INTO member_business
    FROM business_members m JOIN business_locations l ON l.id = m.location_id
   WHERE m.id = agreement.member_id;
  IF NEW.business_id IS DISTINCT FROM member_business THEN
    RAISE EXCEPTION 'a share goes only to the member''s own business'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tip_business_shares_business';
  END IF;
  SELECT effective_from INTO successor_from FROM share_agreements WHERE id = agreement.superseded_by;
  IF agreement.accepted_at IS NULL OR agreement.accepted_at > tip_made
     OR agreement.effective_from > tip_made
     OR (agreement.ended_at IS NOT NULL AND agreement.ended_at <= tip_made)
     OR (successor_from IS NOT NULL AND successor_from <= tip_made) THEN
    RAISE EXCEPTION 'the agreement was not in force when the tip was made'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tip_business_shares_in_force';
  END IF;
  IF NEW.business_bps <> agreement.business_bps
     OR NEW.share_minor <> (net * NEW.business_bps) / 10000 THEN
    RAISE EXCEPTION 'a share must be the agreed part of the tip''s net, rounded down'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tip_business_shares_amount';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tip_business_shares_valid BEFORE INSERT ON tip_business_shares
  FOR EACH ROW EXECUTE FUNCTION tipme_tip_business_share_valid();
--> statement-breakpoint
CREATE TRIGGER tip_business_shares_append_only BEFORE UPDATE OR DELETE ON tip_business_shares
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint

-- 2. A team tip's split (R2-D): each part is for a member at the tip's location, paid to that
--    member's own page, fixed once (append-only), and the parts add up to the tip's net at commit.
CREATE FUNCTION tipme_team_tip_split_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  team_location uuid;
  member_location uuid;
  member_profile uuid;
BEGIN
  SELECT team_location_id INTO team_location FROM tips WHERE id = NEW.tip_id;
  SELECT location_id, profile_id INTO member_location, member_profile
    FROM business_members WHERE id = NEW.member_id;
  IF team_location IS NULL OR member_location IS DISTINCT FROM team_location
     OR member_profile IS DISTINCT FROM NEW.profile_id THEN
    RAISE EXCEPTION 'a team split is for a member of the team tip''s location, to their own page'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'team_tip_splits_member';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER team_tip_splits_valid BEFORE INSERT ON team_tip_splits
  FOR EACH ROW EXECUTE FUNCTION tipme_team_tip_split_valid();
--> statement-breakpoint
CREATE TRIGGER team_tip_splits_append_only BEFORE UPDATE OR DELETE ON team_tip_splits
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE FUNCTION tipme_team_tip_split_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parts numeric;
  net bigint;
BEGIN
  SELECT coalesce(sum(amount_minor), 0) INTO parts FROM team_tip_splits WHERE tip_id = NEW.tip_id;
  SELECT q.recipient_net_minor INTO net
    FROM tips t
    JOIN payment_intents i ON i.id = t.intent_id
    JOIN tip_quotes q ON q.id = i.quote_id
   WHERE t.id = NEW.tip_id;
  IF parts <> net THEN
    RAISE EXCEPTION 'a team tip''s split (%) must add up to its net (%)', parts, net
      USING ERRCODE = 'check_violation', CONSTRAINT = 'team_tip_splits_total';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_tip_splits_total AFTER INSERT ON team_tip_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tipme_team_tip_split_total();
--> statement-breakpoint

-- 3. A table card is served by a member of its location, during that member's own shift, and
--    only while the card is in use.
CREATE FUNCTION tipme_table_assignment_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM table_cards c
      JOIN business_members m ON m.id = NEW.member_id AND m.location_id = c.location_id
      JOIN business_shifts s ON s.id = NEW.shift_id AND s.member_id = m.id
     WHERE c.id = NEW.card_id AND c.retired_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a table card is assigned to a member of its location, on their own shift'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'table_assignments_member';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER table_assignments_valid BEFORE INSERT ON table_assignments
  FOR EACH ROW EXECUTE FUNCTION tipme_table_assignment_valid();
--> statement-breakpoint

-- 4. A reversal (R2-A) takes back a tip's payment: the transaction it names is a payment of the
--    same tip, in the same currency. Its entries are R2-A's; the balance trigger still applies.
CREATE FUNCTION tipme_reversal_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reverses_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_transactions o
     WHERE o.id = NEW.reverses_transaction_id
       AND o.operation_type = 'payment'
       AND o.tip_id IS NOT NULL
       AND o.tip_id = NEW.tip_id
       AND o.currency = NEW.currency
  ) THEN
    RAISE EXCEPTION 'a reversal names a payment of the same tip, in its currency'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_transactions_reversal_target';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_reversal_target BEFORE INSERT ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION tipme_reversal_target();
--> statement-breakpoint

-- 5. An entry's business is its account's, as its profile is: a business_payable entry always
--    names the business, and no other entry names one.
CREATE FUNCTION tipme_entry_business() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_id IS DISTINCT FROM (SELECT business_id FROM ledger_accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'ledger entry business does not match its account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_entries_business_account';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_business BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tipme_entry_business();
