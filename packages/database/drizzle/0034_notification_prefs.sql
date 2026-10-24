ALTER TABLE "profiles" ADD COLUMN "notify_tip_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "notify_weekly_reports" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "notify_milestones" boolean DEFAULT true NOT NULL;