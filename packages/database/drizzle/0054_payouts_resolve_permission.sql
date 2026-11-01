ALTER TYPE "public"."transition_cause" ADD VALUE 'staff';--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_resolution_outcome";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolution_outcome" CHECK (resolution_outcome IS NULL OR (status = 'resolved' AND resolution_outcome IN ('resolved_by_provider', 'recipient_owes', 'written_off', 'staff_confirmed_absent')));--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve'));--> statement-breakpoint
-- ensureOwnerRole runs only when an owner is granted, so an existing role gets this here.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", 'payouts.resolve' FROM "roles" WHERE "id" = 'owner'
ON CONFLICT DO NOTHING;
