CREATE TABLE "staff_permission_overrides" (
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"effect" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_permission_overrides_user_id_permission_pk" PRIMARY KEY("user_id","permission"),
	CONSTRAINT "staff_permission_overrides_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage')),
	CONSTRAINT "staff_permission_overrides_effect" CHECK (effect IN ('add', 'remove'))
);
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_lower" ON "roles" USING btree (lower("name"));--> statement-breakpoint
-- The built-in roles exist from here on, so a custom role can't take their names first.
INSERT INTO "roles" ("id", "name", "system") VALUES ('owner', 'Owner', true), ('release_check', 'Release check', true)
ON CONFLICT ("id") DO UPDATE SET "system" = true;--> statement-breakpoint
INSERT INTO "roles" ("id", "name", "description") VALUES
  (gen_random_uuid()::text, 'Support', 'Handles issues, finds people and pages, and suspends pages.'),
  (gen_random_uuid()::text, 'Finance', 'Reads the numbers, rechecks payments and manages fees.'),
  (gen_random_uuid()::text, 'Marketing', 'Reads the numbers and records market observations.');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p FROM "roles" r, unnest(ARRAY['issues.view', 'issues.resolve', 'search.view', 'pages.suspend']) AS p WHERE r."name" = 'Support' AND r."system" = false;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p FROM "roles" r, unnest(ARRAY['issues.view', 'search.view', 'analytics.view', 'payments.recheck', 'fees.manage']) AS p WHERE r."name" = 'Finance' AND r."system" = false;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p FROM "roles" r, unnest(ARRAY['analytics.view', 'market.edit']) AS p WHERE r."name" = 'Marketing' AND r."system" = false;
