CREATE TABLE "release_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"issues_closed" integer
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN "rehearsal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "rehearsal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "rehearsal_run_id" uuid;