ALTER TABLE "profiles" ADD COLUMN "handle_changes_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "handle_changes_extra" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_handle_changes" CHECK (handle_changes_used >= 0 AND handle_changes_extra >= 0);