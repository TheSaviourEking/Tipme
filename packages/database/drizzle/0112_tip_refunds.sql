ALTER TYPE "public"."entity_type" ADD VALUE 'tip_refund';--> statement-breakpoint
CREATE TABLE "tip_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tip_id" uuid NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text NOT NULL,
	"failure" text,
	"provider_refund_reference" text,
	"refunded_minor" bigint,
	"refund_fee_minor" bigint,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_refunds_status" CHECK ("tip_refunds"."status" IN ('REQUESTED', 'PROCESSING', 'UNKNOWN', 'PAID', 'FAILED')),
	CONSTRAINT "tip_refunds_failure" CHECK ("tip_refunds"."failure" IS NULL OR ("tip_refunds"."status" = 'FAILED' AND "tip_refunds"."failure" IN ('bank_transfer', 'not_refundable', 'refused', 'partner_failed'))),
	CONSTRAINT "tip_refunds_amount_positive" CHECK ("tip_refunds"."amount_minor" > 0),
	CONSTRAINT "tip_refunds_currency_iso" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD CONSTRAINT "tip_refunds_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD CONSTRAINT "tip_refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD CONSTRAINT "tip_refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_refunds_one_per_tip" ON "tip_refunds" USING btree ("tip_id") WHERE "tip_refunds"."status" <> 'FAILED';--> statement-breakpoint
CREATE INDEX "tip_refunds_open" ON "tip_refunds" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_fee_adjusted', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed', 'support_request', 'pro_collect_unknown', 'pro_refund_failed', 'share_transfer_stuck', 'tip_refund_failed'));