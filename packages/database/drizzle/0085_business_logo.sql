CREATE TABLE "business_logos" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"bytes" "bytea",
	"object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_logos_one_place" CHECK ((bytes IS NULL) <> (object_key IS NULL))
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "logo_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_logos" ADD CONSTRAINT "business_logos_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;