CREATE TABLE "plan_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_changes_plan" CHECK ("plan_changes"."plan" IN ('free', 'pro'))
);
--> statement-breakpoint
ALTER TABLE "plan_changes" ADD CONSTRAINT "plan_changes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_changes_profile_at" ON "plan_changes" USING btree ("profile_id","changed_at");--> statement-breakpoint
-- Ruling G6: every page Pro at the release gets one `pro` row, at its first paid month's start,
-- else at the first instant of this Lagos month. Safe to run again (pages with a row are skipped).
INSERT INTO "plan_changes" ("id", "profile_id", "plan", "changed_at")
SELECT gen_random_uuid(), p."id", 'pro',
       COALESCE(
         (SELECT MIN(pp."starts_at") FROM "pro_periods" pp WHERE pp."profile_id" = p."id"),
         date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'
       )
  FROM "profiles" p
 WHERE p."plan" = 'pro'
   AND NOT EXISTS (SELECT 1 FROM "plan_changes" c WHERE c."profile_id" = p."id");
