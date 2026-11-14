ALTER TABLE "campaigns" ADD COLUMN "page_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "headline" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "cover_design" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "cover_colour" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "cover_animation" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "cover_motion" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_headline_length" CHECK (char_length(headline) BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_description_length" CHECK (char_length(description) BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_cover_motion" CHECK (cover_motion IN ('once', 'loop'));