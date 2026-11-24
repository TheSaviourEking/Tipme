CREATE TABLE "provider_split_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid,
	"business_id" uuid,
	"checked_at" timestamp with time zone NOT NULL,
	"ledger_minor" bigint NOT NULL,
	"providers" jsonb NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "provider_split_checks_owner" CHECK ((profile_id IS NULL) <> (business_id IS NULL)),
	CONSTRAINT "provider_split_checks_outcome" CHECK (outcome IN ('ok', 'short', 'over', 'partial'))
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "provider_split_checks" ADD CONSTRAINT "provider_split_checks_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_split_checks" ADD CONSTRAINT "provider_split_checks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_split_checks_profile" ON "provider_split_checks" USING btree ("profile_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_split_checks_business" ON "provider_split_checks" USING btree ("business_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_fee_adjusted', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed', 'support_request', 'pro_collect_unknown', 'pro_refund_failed', 'share_transfer_stuck', 'tip_refund_failed', 'collect_transfer_stuck', 'collect_transfer_review', 'collect_in_debt', 'collect_invariant_broken', 'collect_reserve_low', 'collect_auto_payout_on', 'collect_recon_mismatch', 'collect_same_bank', 'dispute_opened', 'dispute_deadline', 'dispute_fee_unposted', 'collect_refund_gap', 'collect_own_money_wait', 'provider_split_short', 'provider_unconnected_money'));