ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view'));--> statement-breakpoint
-- Owners already enrolled get the new permission too (new grants get every permission anyway).
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT 'owner', 'search.view' WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'owner')
ON CONFLICT DO NOTHING;
