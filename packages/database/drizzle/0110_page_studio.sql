CREATE TABLE "page_studios" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"published_check_version" integer,
	"rev" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_image_files" (
	"image_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea",
	"object_key" text,
	CONSTRAINT "studio_image_files_image_id_name_pk" PRIMARY KEY("image_id","name"),
	CONSTRAINT "studio_image_files_one_place" CHECK ((bytes IS NULL) <> (object_key IS NULL)),
	CONSTRAINT "studio_image_files_name" CHECK (name ~ '^(master|(square|wide|tall|strip)-(480|960|1440))$')
);
--> statement-breakpoint
CREATE TABLE "studio_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"focal_x" integer DEFAULT 50 NOT NULL,
	"focal_y" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_images_focal" CHECK (focal_x BETWEEN 0 AND 100 AND focal_y BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "studio_video_checks" (
	"url" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "studio_video_checks_status" CHECK (status IN ('ok', 'gone', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "page_studios" ADD CONSTRAINT "page_studios_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_image_files" ADD CONSTRAINT "studio_image_files_image_id_studio_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."studio_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_images" ADD CONSTRAINT "studio_images_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_images_profile" ON "studio_images" USING btree ("profile_id");