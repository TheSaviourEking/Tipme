CREATE TABLE "payout_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"destination_reference" text NOT NULL,
	"bank_code" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_last4" char(4) NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone,
	CONSTRAINT "payout_destinations_status" CHECK (status IN ('usable', 'pending_review', 'rejected')),
	CONSTRAINT "payout_destinations_last4" CHECK (account_last4 ~ '^[0-9]{4}$'),
	CONSTRAINT "payout_destinations_provider" CHECK (provider ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "provider_fee_credits" (
	"account_reference" text NOT NULL,
	"provider" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"transfer_reference" text PRIMARY KEY NOT NULL,
	"payout_id" uuid NOT NULL,
	"used_by_payout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_fee_credits_amount_positive" CHECK (amount_minor > 0),
	CONSTRAINT "provider_fee_credits_provider" CHECK (provider ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "withdrawal_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	CONSTRAINT "withdrawal_holds_reason" CHECK (reason IN ('reversal', 'in_debt', 'unexpected_payout'))
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "resolution_outcome" text;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD COLUMN "manual_payouts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD COLUMN "payout_capabilities_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "destination_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "fee_minor" bigint;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "fee_transfer_reference" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "start_uncertain_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "account_reference" text;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_fee_credits" ADD CONSTRAINT "provider_fee_credits_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_fee_credits" ADD CONSTRAINT "provider_fee_credits_used_by_payout_id_payouts_id_fk" FOREIGN KEY ("used_by_payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_holds" ADD CONSTRAINT "withdrawal_holds_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_holds" ADD CONSTRAINT "withdrawal_holds_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destinations_active" ON "payout_destinations" USING btree ("profile_id","provider") WHERE replaced_at IS NULL;--> statement-breakpoint
CREATE INDEX "provider_fee_credits_unspent" ON "provider_fee_credits" USING btree ("account_reference","provider") WHERE used_by_payout_id IS NULL;--> statement-breakpoint
CREATE INDEX "withdrawal_holds_active" ON "withdrawal_holds" USING btree ("profile_id") WHERE released_at IS NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_destination_id_payout_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."payout_destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolution_outcome" CHECK (resolution_outcome IS NULL OR (status = 'resolved' AND resolution_outcome IN ('resolved_by_provider', 'recipient_owes', 'written_off')));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_fee_not_negative" CHECK (fee_minor IS NULL OR fee_minor >= 0);