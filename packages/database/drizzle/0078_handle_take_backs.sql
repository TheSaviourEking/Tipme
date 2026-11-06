CREATE TABLE "handle_take_backs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"approval_request_id" uuid,
	"profile_id" uuid NOT NULL,
	"handle_lower" text NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"notice_days" integer NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone NOT NULL,
	"noticed_at" timestamp with time zone,
	"noticed_via" text,
	"banner_seen_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"notice_mail_id" uuid,
	"outcome" text,
	"new_handle" text,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"free_change_until" timestamp with time zone,
	"free_change_used_at" timestamp with time zone,
	CONSTRAINT "handle_take_backs_kind" CHECK ("handle_take_backs"."kind" IN ('current', 'old')),
	CONSTRAINT "handle_take_backs_category" CHECK ("handle_take_backs"."category" IN ('ordinary', 'impersonation', 'trademark', 'legal')),
	CONSTRAINT "handle_take_backs_notice_days" CHECK (("handle_take_backs"."category" = 'ordinary' AND "handle_take_backs"."notice_days" BETWEEN 7 AND 30) OR ("handle_take_backs"."category" <> 'ordinary' AND "handle_take_backs"."notice_days" BETWEEN 0 AND 7)),
	CONSTRAINT "handle_take_backs_state" CHECK ("handle_take_backs"."state" IN ('approved', 'noticed', 'due', 'done', 'cancelled')),
	CONSTRAINT "handle_take_backs_noticed_via" CHECK ("handle_take_backs"."noticed_via" IS NULL OR "handle_take_backs"."noticed_via" IN ('email', 'banner', 'unreached')),
	CONSTRAINT "handle_take_backs_outcome" CHECK ("handle_take_backs"."outcome" IS NULL OR "handle_take_backs"."outcome" IN ('user_chose', 'assigned', 'page_deleted', 'old_removed'))
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "handle_take_backs" ADD CONSTRAINT "handle_take_backs_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_take_backs" ADD CONSTRAINT "handle_take_backs_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_take_backs" ADD CONSTRAINT "handle_take_backs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_take_backs" ADD CONSTRAINT "handle_take_backs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_take_backs" ADD CONSTRAINT "handle_take_backs_notice_mail_id_mail_messages_id_fk" FOREIGN KEY ("notice_mail_id") REFERENCES "public"."mail_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_take_backs" ADD CONSTRAINT "handle_take_backs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handle_take_backs_open" ON "handle_take_backs" USING btree ("handle_lower") WHERE state IN ('approved', 'noticed', 'due');--> statement-breakpoint
CREATE INDEX "handle_take_backs_open_profile" ON "handle_take_backs" USING btree ("profile_id") WHERE state IN ('approved', 'noticed', 'due');--> statement-breakpoint
CREATE INDEX "handle_take_backs_state_due" ON "handle_take_backs" USING btree ("state","due_at");--> statement-breakpoint
-- Added NOT VALID, then validated, as for issues_kind below. No row can point anywhere yet: nothing
-- wrote take_back_id before this table existed.
ALTER TABLE "handle_reservations" ADD CONSTRAINT "handle_reservations_take_back_id_handle_take_backs_id_fk" FOREIGN KEY ("take_back_id") REFERENCES "public"."handle_take_backs"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "handle_reservations" VALIDATE CONSTRAINT "handle_reservations_take_back_id_handle_take_backs_id_fk";--> statement-breakpoint
-- issues can be large, so the widened check is added NOT VALID and then validated, the form the
-- plan's rollout rules ask for. drizzle runs this file in one transaction, so the lock taken by the
-- DROP above is held until commit either way; the split keeps the scan a separate, read-only step.
-- Every existing row passes: the list only grows.
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue')) NOT VALID;--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_kind";
