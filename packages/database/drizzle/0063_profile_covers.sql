CREATE TABLE "profile_covers" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"bytes" "bytea",
	"object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_covers_one_place" CHECK ((bytes IS NULL) <> (object_key IS NULL))
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cover_design" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cover_colour" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cover_path" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cover_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_covers" ADD CONSTRAINT "profile_covers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;