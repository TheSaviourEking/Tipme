ALTER TABLE "business_managers" ADD COLUMN "shown_name" text;--> statement-breakpoint
ALTER TABLE "business_managers" ADD COLUMN "verified_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_managers" ADD CONSTRAINT "business_managers_shown_name" CHECK (shown_name IS NULL OR char_length(shown_name) BETWEEN 1 AND 60);