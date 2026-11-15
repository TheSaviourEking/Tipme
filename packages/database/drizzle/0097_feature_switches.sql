CREATE TABLE "feature_switch_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"changed_by" uuid,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feature_switch_changes_source" CHECK ("feature_switch_changes"."source" IN ('default', 'env', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "feature_switches" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "feature_switches_source" CHECK ("feature_switches"."source" IN ('default', 'env', 'staff')),
	CONSTRAINT "feature_switches_reason" CHECK (char_length("feature_switches"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" DROP CONSTRAINT "staff_permission_overrides_known";--> statement-breakpoint
ALTER TABLE "feature_switch_changes" ADD CONSTRAINT "feature_switch_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_switch_changes" ADD CONSTRAINT "feature_switch_changes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_switches" ADD CONSTRAINT "feature_switches_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_switch_changes_key" ON "feature_switch_changes" USING btree ("key","created_at");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish', 'pro.price', 'switches.manage'));--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish', 'pro.price', 'switches.manage'));