ALTER TABLE "profiles" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Social links (5 Nov 2026): the three fixed fields become the first entries of the ordered list,
-- in catalogue order (Facebook, Instagram, X). "socials" itself is left untouched.
UPDATE "profiles" SET "links" = (
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('platform', v.platform, 'url', "profiles"."socials" ->> v.platform) ORDER BY v.position),
    '[]'::jsonb
  )
  FROM (VALUES ('facebook', 1), ('instagram', 2), ('x', 3)) AS v(platform, position)
  WHERE jsonb_typeof("profiles"."socials" -> v.platform) = 'string'
    AND "profiles"."socials" ->> v.platform <> ''
)
WHERE "links" = '[]'::jsonb AND "socials" <> '{}'::jsonb;
