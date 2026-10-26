ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "platform_fee_bps" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_platform_fee_bps" CHECK (platform_fee_bps IS NULL OR platform_fee_bps BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'fees.manage'));--> statement-breakpoint
-- Existing owners get the new permission (ADR-0014); new owners get it from ensureOwnerRole.
INSERT INTO "role_permissions" ("role_id", "permission") SELECT 'owner', 'fees.manage' WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'owner') ON CONFLICT DO NOTHING;
