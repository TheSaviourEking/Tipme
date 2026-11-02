ALTER TABLE "staff" ADD COLUMN "enrolled_at" timestamp with time zone;--> statement-breakpoint
-- Null only for someone clearly invited (staff.added on record) and with no sign of ever enrolling.
-- Any other history counts as enrolled, so an old owner is never treated as a mere invitee.
UPDATE "staff" s
SET "enrolled_at" = COALESCE(
  (SELECT t."confirmed_at" FROM "staff_totp" t WHERE t."user_id" = s."user_id"),
  (SELECT min(a."created_at") FROM "audit_events" a
    WHERE a."action" = 'ops.authenticator_enrolled' AND a."subject_id" = s."user_id"::text),
  s."granted_at"
)
WHERE EXISTS (
    SELECT 1 FROM "staff_totp" t
    WHERE t."user_id" = s."user_id" AND t."confirmed_at" IS NOT NULL
  )
  OR EXISTS (
    SELECT 1 FROM "audit_events" a
    WHERE a."action" = 'ops.authenticator_enrolled' AND a."subject_id" = s."user_id"::text
  )
  OR NOT EXISTS (
    SELECT 1 FROM "audit_events" a
    WHERE a."action" = 'staff.added' AND a."subject_id" = s."user_id"::text
  );
