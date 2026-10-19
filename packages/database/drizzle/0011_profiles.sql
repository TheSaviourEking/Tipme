CREATE TABLE "handle_holds" (
	"handle_lower" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "page_state" text DEFAULT 'not_live' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "craft" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avatar_path" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "socials" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "bio_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "socials_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "phone_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "email_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "qr_style" text DEFAULT 'purple' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_unique" UNIQUE("user_id");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_page_state" CHECK (page_state IN ('live', 'not_live', 'deleted'));--> statement-breakpoint
-- Pages that existed before PR-008 were public demo pages: they stay live.
UPDATE profiles SET page_state = 'live';
