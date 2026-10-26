CREATE TABLE "avatars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avatars_profile_id_unique" UNIQUE("profile_id"),
	CONSTRAINT "avatars_size" CHECK (octet_length(bytes) <= 400000)
);
--> statement-breakpoint
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;