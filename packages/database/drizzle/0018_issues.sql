CREATE TABLE "issue_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"staff_user_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_notes_length" CHECK (char_length(text) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject" jsonb NOT NULL,
	"summary" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "issues_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payout_failed', 'payout_conflict', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery')),
	CONSTRAINT "issues_severity" CHECK (severity IN ('money', 'account', 'info')),
	CONSTRAINT "issues_status" CHECK (status IN ('open', 'resolved')),
	CONSTRAINT "issues_resolution" CHECK ((status = 'open') = (resolved_at IS NULL AND resolved_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE "issue_notes" ADD CONSTRAINT "issue_notes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_notes_issue" ON "issue_notes" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issues_status_opened" ON "issues" USING btree ("status","opened_at");--> statement-breakpoint
-- Notes are part of the record: never edited, deleted or truncated (ADR-0010).
CREATE TRIGGER issue_notes_append_only BEFORE UPDATE OR DELETE ON issue_notes
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER issue_notes_no_truncate BEFORE TRUNCATE ON issue_notes
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
