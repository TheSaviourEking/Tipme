CREATE TABLE "plan_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_changes_plan" CHECK ("plan_changes"."plan" IN ('free', 'pro'))
);
--> statement-breakpoint
ALTER TABLE "plan_changes" ADD CONSTRAINT "plan_changes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_changes_profile_at" ON "plan_changes" USING btree ("profile_id","changed_at");