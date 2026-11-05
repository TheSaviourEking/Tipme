ALTER TABLE "profiles" ADD COLUMN "thanks_line" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "thanks_style" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "thanks_signed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_messages" ADD COLUMN "may_show" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_thanks_line_length" CHECK (thanks_line IS NULL OR char_length(thanks_line) BETWEEN 1 AND 140);--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_thanks_style" CHECK (thanks_style IS NULL OR thanks_style IN ('paper', 'violet', 'night'));