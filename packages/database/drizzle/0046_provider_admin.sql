CREATE TABLE "provider_overrides" (
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"set_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_overrides_kind_user_id_pk" PRIMARY KEY("kind","user_id"),
	CONSTRAINT "provider_overrides_kind" CHECK (kind IN ('mail', 'payment'))
);
--> statement-breakpoint
CREATE TABLE "provider_settings" (
	"kind" text PRIMARY KEY NOT NULL,
	"active_provider" text NOT NULL,
	"state" text DEFAULT 'stable' NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "provider_settings_kind" CHECK (kind IN ('mail', 'payment'))
);
--> statement-breakpoint
CREATE TABLE "provider_tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"target_hint" text,
	"token_sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"failure_code" text,
	"message_id" uuid,
	"tip_id" uuid,
	CONSTRAINT "provider_tests_token_sha256_unique" UNIQUE("token_sha256"),
	CONSTRAINT "provider_tests_kind" CHECK (kind IN ('mail', 'payment')),
	CONSTRAINT "provider_tests_status" CHECK (status IN ('pending', 'confirmed', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "provider_overrides" ADD CONSTRAINT "provider_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_tests" ADD CONSTRAINT "provider_tests_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_tests_recent" ON "provider_tests" USING btree ("kind","provider","started_at");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage'));--> statement-breakpoint
-- ensureOwnerRole runs only when an owner is granted, so an existing role gets these here.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", p.permission FROM "roles"
  CROSS JOIN (VALUES ('providers.manage'), ('recoveries.manage')) AS p(permission)
 WHERE "id" = 'owner'
ON CONFLICT DO NOTHING;
