CREATE TABLE "collect_reserve_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"condition" text NOT NULL,
	"active" boolean NOT NULL,
	"detail" text,
	"read_at" timestamp with time zone NOT NULL,
	"alerted_at" timestamp with time zone,
	"alert_claimed_at" timestamp with time zone,
	"owners_emailed_at" timestamp with time zone,
	CONSTRAINT "collect_reserve_alerts_provider" CHECK (provider ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "collect_reserve_alerts_condition" CHECK (condition IN ('auto_payout', 'unreadable', 'unlisted_negative')),
	CONSTRAINT "collect_reserve_alerts_detail" CHECK (detail IS NULL OR char_length(detail) <= 32)
);
--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" DROP CONSTRAINT "collect_reserve_readings_amounts";--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" DROP CONSTRAINT "collect_reserve_readings_level";--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "share_transfers" DROP CONSTRAINT "share_transfers_kind";--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" ADD COLUMN "owners_emailed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "collect_reserve_alerts_latest" ON "collect_reserve_alerts" USING btree ("provider","condition","read_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_one_collect_return" ON "share_transfers" USING btree ("parent_id") WHERE kind = 'collect_return' AND status <> 'cancelled';--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" ADD CONSTRAINT "collect_reserve_readings_amounts" CHECK (held_minor >= 0 AND critical_minor >= 0 AND critical_minor <= warning_minor);--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" ADD CONSTRAINT "collect_reserve_readings_level" CHECK (own_minor IS NULL OR (level IS NOT NULL AND level = CASE
          WHEN held_minor > 0 AND own_minor < 0 THEN 'breach'
          WHEN available_minor < 0 OR own_minor < critical_minor THEN 'critical'
          WHEN own_minor < warning_minor THEN 'warning'
          ELSE 'ok' END));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_fee_adjusted', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed', 'support_request', 'pro_collect_unknown', 'pro_refund_failed', 'share_transfer_stuck', 'tip_refund_failed', 'collect_transfer_stuck', 'collect_transfer_review', 'collect_in_debt', 'collect_invariant_broken', 'collect_reserve_low', 'collect_auto_payout_on', 'collect_recon_mismatch', 'collect_same_bank', 'dispute_opened', 'dispute_deadline', 'dispute_fee_unposted', 'collect_refund_gap', 'collect_own_money_wait'));--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_kind" CHECK (kind IN ('sweep', 'recover', 'fee_return', 'holdback_repay', 'collect_sweep', 'collect_recover', 'collect_return'));