CREATE TABLE "pro_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" uuid,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pro_prices_amount_positive" CHECK ("pro_prices"."amount_minor" > 0),
	CONSTRAINT "pro_prices_currency_ngn" CHECK ("pro_prices"."currency" = 'NGN'),
	CONSTRAINT "pro_prices_reason" CHECK (char_length("pro_prices"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" DROP CONSTRAINT "staff_permission_overrides_known";--> statement-breakpoint
ALTER TABLE "pro_prices" ADD CONSTRAINT "pro_prices_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_prices" ADD CONSTRAINT "pro_prices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pro_prices_effective_from" ON "pro_prices" USING btree ("effective_from");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish', 'pro.price'));--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish', 'pro.price'));