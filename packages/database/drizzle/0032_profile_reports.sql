CREATE TABLE "profile_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"at_minute" timestamp with time zone NOT NULL,
	CONSTRAINT "profile_reports_reason" CHECK (reason IN ('impersonation', 'scam', 'abusive', 'other'))
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "profile_reports" ADD CONSTRAINT "profile_reports_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_reports_profile" ON "profile_reports" USING btree ("profile_id","at_minute");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payout_failed', 'payout_conflict', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported'));