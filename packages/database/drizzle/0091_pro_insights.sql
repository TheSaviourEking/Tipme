CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "campaigns_profile_slug" UNIQUE("profile_id","slug"),
	CONSTRAINT "campaigns_name_length" CHECK (char_length(name) BETWEEN 1 AND 40),
	CONSTRAINT "campaigns_slug_format" CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "monthly_recaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"month" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_recaps_once" UNIQUE("profile_id","month"),
	CONSTRAINT "monthly_recaps_month" CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid,
	"topic" text NOT NULL,
	"body" text NOT NULL,
	"priority" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_requests_issue_id_unique" UNIQUE("issue_id"),
	CONSTRAINT "support_requests_topic" CHECK (topic IN ('withdrawal', 'tip', 'page', 'account', 'pro', 'other')),
	CONSTRAINT "support_requests_body_length" CHECK (char_length(body) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "tip_campaigns" (
	"tip_id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "priority" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_recaps" ADD CONSTRAINT "monthly_recaps_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_campaigns" ADD CONSTRAINT "tip_campaigns_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_campaigns" ADD CONSTRAINT "tip_campaigns_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_profile_active" ON "campaigns" USING btree ("profile_id") WHERE stopped_at IS NULL;--> statement-breakpoint
CREATE INDEX "support_requests_user" ON "support_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tip_campaigns_campaign" ON "tip_campaigns" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "analytics_events_campaign" ON "analytics_events" USING btree ("campaign_id","at_minute") WHERE campaign_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported', 'share_report', 'balance_below_zero', 'pro_amount_mismatch', 'pro_late_payment', 'pro_conflict', 'pro_reversed', 'support_request'));