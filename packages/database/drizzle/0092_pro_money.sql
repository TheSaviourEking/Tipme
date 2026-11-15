ALTER TYPE "public"."entity_type" ADD VALUE 'pro_refund';--> statement-breakpoint
ALTER TYPE "public"."operation_type" ADD VALUE 'pro_refund';--> statement-breakpoint
CREATE TABLE "pro_auto_renew" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean NOT NULL,
	"customer_reference" text,
	"payment_method_reference" text,
	"failed_period_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pro_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purchase_id" uuid NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider_refund_reference" text,
	"refunded_minor" bigint,
	"refund_fee_minor" bigint,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pro_refunds_status" CHECK ("pro_refunds"."status" IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'PAID', 'FAILED')),
	CONSTRAINT "pro_refunds_amount_positive" CHECK ("pro_refunds"."amount_minor" > 0),
	CONSTRAINT "pro_refunds_currency_iso" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD COLUMN "account_reference" text;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD COLUMN "charge_reference" text;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD COLUMN "save_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD COLUMN "renews_period_id" uuid;--> statement-breakpoint
ALTER TABLE "pro_auto_renew" ADD CONSTRAINT "pro_auto_renew_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_refunds" ADD CONSTRAINT "pro_refunds_purchase_id_pro_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."pro_purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_refunds" ADD CONSTRAINT "pro_refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_refunds" ADD CONSTRAINT "pro_refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pro_refunds_one_per_purchase" ON "pro_refunds" USING btree ("purchase_id") WHERE "pro_refunds"."status" <> 'FAILED';--> statement-breakpoint
CREATE INDEX "pro_refunds_open" ON "pro_refunds" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_renews_period_id_unique" UNIQUE("renews_period_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed', 'support_request', 'pro_collect_unknown', 'pro_refund_failed'));