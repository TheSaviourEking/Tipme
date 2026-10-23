CREATE TABLE "message_flags" (
	"tip_id" uuid PRIMARY KEY NOT NULL,
	"hidden_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone,
	"report_reason" text,
	CONSTRAINT "message_flags_reason" CHECK (report_reason IS NULL OR report_reason IN ('abusive', 'spam', 'other'))
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "message_flags" ADD CONSTRAINT "message_flags_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payout_failed', 'payout_conflict', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported'));