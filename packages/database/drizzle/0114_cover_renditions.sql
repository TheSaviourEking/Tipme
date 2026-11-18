CREATE TABLE "profile_cover_renditions" (
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"width" integer NOT NULL,
	"bytes" "bytea",
	"object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_cover_renditions_profile_id_width_pk" PRIMARY KEY("profile_id","width"),
	CONSTRAINT "profile_cover_renditions_one_place" CHECK ((bytes IS NULL) <> (object_key IS NULL)),
	CONSTRAINT "profile_cover_renditions_width" CHECK (width IN (640, 1080, 1600))
);
--> statement-breakpoint
ALTER TABLE "profile_cover_renditions" ADD CONSTRAINT "profile_cover_renditions_profile_id_profile_covers_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile_covers"("profile_id") ON DELETE cascade ON UPDATE no action;