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
