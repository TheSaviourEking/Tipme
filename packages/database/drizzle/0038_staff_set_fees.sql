ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "custom_fee_bps" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_custom_fee_bps" CHECK (custom_fee_bps IS NULL OR custom_fee_bps BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage'));--> statement-breakpoint
-- Owners already enrolled get the new permission too (ADR-0014; new grants get every permission).
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT 'owner', 'fees.manage' WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'owner')
ON CONFLICT DO NOTHING;
