ALTER TABLE "profiles" ADD COLUMN "cover_animation" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cover_motion" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_cover_motion" CHECK (cover_motion IN ('once', 'loop'));