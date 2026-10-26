CREATE TABLE "profile_avatars" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_avatars" ADD CONSTRAINT "profile_avatars_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;