ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "tip_presets_minor" bigint[];--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "min_tip_minor" bigint;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_plan" CHECK (plan IN ('free', 'pro'));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_min_tip" CHECK (min_tip_minor IS NULL OR (min_tip_minor BETWEEN 100000 AND 10000000 AND min_tip_minor % 100 = 0));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tip_presets" CHECK (tip_presets_minor IS NULL OR cardinality(tip_presets_minor) BETWEEN 1 AND 4);--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan'));--> statement-breakpoint
-- Owners already enrolled get the new permission too (new grants get every permission anyway).
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT 'owner', 'pages.plan' WHERE EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'owner')
ON CONFLICT DO NOTHING;
