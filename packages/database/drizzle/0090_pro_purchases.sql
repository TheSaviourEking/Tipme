ALTER TYPE "public"."entity_type" ADD VALUE 'pro_purchase';--> statement-breakpoint
ALTER TYPE "public"."operation_type" ADD VALUE 'pro_sale';--> statement-breakpoint
CREATE TABLE "pro_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"method" text NOT NULL,
	"price_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"provider_reference" text,
	"checkout_url" text,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"start_claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"fee_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pro_purchases_idempotency" UNIQUE("profile_id","idempotency_key"),
	CONSTRAINT "pro_purchases_status" CHECK ("pro_purchases"."status" IN ('PENDING', 'COLLECTING', 'UNKNOWN', 'PAID', 'FAILED', 'EXPIRED', 'REVIEW')),
	CONSTRAINT "pro_purchases_method" CHECK ("pro_purchases"."method" IN ('card', 'bank_transfer', 'balance', 'saved_card')),
	CONSTRAINT "pro_purchases_amount_positive" CHECK ("pro_purchases"."amount_minor" > 0),
	CONSTRAINT "pro_purchases_fee" CHECK ("pro_purchases"."fee_minor" IS NULL OR ("pro_purchases"."fee_minor" >= 0 AND "pro_purchases"."fee_minor" <= "pro_purchases"."amount_minor")),
	CONSTRAINT "pro_purchases_currency_iso" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD COLUMN "pro_purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "pro_purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_price_id_pro_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."pro_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pro_purchases_one_open" ON "pro_purchases" USING btree ("profile_id") WHERE "pro_purchases"."status" IN ('PENDING', 'COLLECTING', 'UNKNOWN');--> statement-breakpoint
CREATE UNIQUE INDEX "pro_purchases_provider_reference" ON "pro_purchases" USING btree ("provider","provider_reference") WHERE "pro_purchases"."provider_reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pro_purchases_open" ON "pro_purchases" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_pro_purchase_id_pro_purchases_id_fk" FOREIGN KEY ("pro_purchase_id") REFERENCES "public"."pro_purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_pro_purchase_id_pro_purchases_id_fk" FOREIGN KEY ("pro_purchase_id") REFERENCES "public"."pro_purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed'));