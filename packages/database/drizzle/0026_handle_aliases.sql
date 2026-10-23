CREATE TABLE "handle_aliases" (
	"handle_lower" text PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handle_aliases" ADD CONSTRAINT "handle_aliases_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handle_aliases_profile" ON "handle_aliases" USING btree ("profile_id");