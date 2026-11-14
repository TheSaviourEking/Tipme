CREATE TABLE "share_holdbacks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"tip_id" uuid NOT NULL,
	"recover_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"remaining_minor" bigint NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_holdbacks_recover_id_unique" UNIQUE("recover_id"),
	CONSTRAINT "share_holdbacks_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "share_holdbacks_amounts" CHECK (amount_minor > 0 AND remaining_minor >= 0 AND remaining_minor <= amount_minor),
	CONSTRAINT "share_holdbacks_settled" CHECK ((remaining_minor = 0) = (settled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "share_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tip_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"business_id" uuid,
	"profile_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"deliver_minor" bigint,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"out_reference" text,
	"in_reference" text,
	"reversal_transaction_id" uuid,
	"partner_reversal_id" text,
	"parent_id" uuid,
	"holdback_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_transfers_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "share_transfers_kind" CHECK (kind IN ('sweep', 'recover', 'fee_return', 'holdback_repay')),
	CONSTRAINT "share_transfers_status" CHECK (status IN ('waiting', 'out_sent', 'out_paid', 'in_sent', 'done', 'cancelled', 'gap', 'review')),
	CONSTRAINT "share_transfers_amount" CHECK (amount_minor > 0),
	CONSTRAINT "share_transfers_deliver" CHECK (deliver_minor IS NULL OR (deliver_minor >= 0 AND deliver_minor <= amount_minor)),
	CONSTRAINT "share_transfers_one_leg" CHECK (kind IN ('sweep', 'recover') OR status NOT IN ('waiting', 'out_sent', 'gap')),
	CONSTRAINT "share_transfers_links" CHECK ((kind = 'recover') = (reversal_transaction_id IS NOT NULL)
        AND (kind = 'fee_return') = (partner_reversal_id IS NOT NULL)
        AND (kind = 'holdback_repay') = (parent_id IS NOT NULL AND holdback_id IS NOT NULL)),
	CONSTRAINT "share_transfers_business" CHECK (kind = 'fee_return' OR business_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "payment_accounts" DROP CONSTRAINT "payment_accounts_active_can_charge";--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD COLUMN "receive_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD COLUMN "share_agreement_id" uuid;--> statement-breakpoint
ALTER TABLE "share_holdbacks" ADD CONSTRAINT "share_holdbacks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_holdbacks" ADD CONSTRAINT "share_holdbacks_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_holdbacks" ADD CONSTRAINT "share_holdbacks_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_holdbacks" ADD CONSTRAINT "share_holdbacks_recover_id_share_transfers_id_fk" FOREIGN KEY ("recover_id") REFERENCES "public"."share_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_reversal_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("reversal_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_parent_id_share_transfers_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."share_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_holdback_id_share_holdbacks_id_fk" FOREIGN KEY ("holdback_id") REFERENCES "public"."share_holdbacks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_holdbacks_open" ON "share_holdbacks" USING btree ("business_id","created_at") WHERE remaining_minor > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_one_sweep" ON "share_transfers" USING btree ("tip_id") WHERE kind = 'sweep';--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_once_per_reversal" ON "share_transfers" USING btree ("reversal_transaction_id") WHERE kind = 'recover';--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_fee_once" ON "share_transfers" USING btree ("partner_reversal_id") WHERE kind = 'fee_return';--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_once_per_holdback" ON "share_transfers" USING btree ("parent_id","holdback_id") WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "share_transfers_due" ON "share_transfers" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "share_transfers_business" ON "share_transfers" USING btree ("business_id","status");--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD CONSTRAINT "tip_quotes_share_agreement_id_share_agreements_id_fk" FOREIGN KEY ("share_agreement_id") REFERENCES "public"."share_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed', 'support_request', 'pro_collect_unknown', 'pro_refund_failed', 'share_transfer_stuck'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK (kind IN ('tip', 'weekly_report', 'moment', 'business_invitation', 'business_verified', 'business_share_held_back'));--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_receive_only_business" CHECK (NOT receive_only OR business_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_active_can_charge" CHECK (status <> 'ACTIVE' OR charges_enabled OR receive_only);