-- Business sign-up (R19): the "verified" moment is for businesses verified from now on. Every
-- manager already on a verified or suspended business has, in effect, seen it: existing
-- businesses don't change.
UPDATE "business_managers" m
   SET "verified_seen_at" = now()
  FROM "businesses" b
 WHERE b."id" = m."business_id"
   AND b."status" <> 'pending'
   AND m."verified_seen_at" IS NULL;
