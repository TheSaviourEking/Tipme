CREATE TABLE "changelog_entries" (
	"pr_number" integer PRIMARY KEY NOT NULL,
	"merge_sha" text NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"pr_title" text NOT NULL,
	"staff_text" text NOT NULL,
	"user_text" text,
	"audience" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_text" text,
	"published_audience" text,
	"published_revision" integer,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"staging_at" timestamp with time zone,
	"live_at" timestamp with time zone,
	"live_version" text,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" uuid,
	"withdrawn_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changelog_entries_pr_number" CHECK ("changelog_entries"."pr_number" > 0),
	CONSTRAINT "changelog_entries_merge_sha" CHECK ("changelog_entries"."merge_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "changelog_entries_pr_title" CHECK (char_length("changelog_entries"."pr_title") <= 256),
	CONSTRAINT "changelog_entries_staff_text" CHECK (char_length("changelog_entries"."staff_text") BETWEEN 1 AND 1000),
	CONSTRAINT "changelog_entries_user_text" CHECK ("changelog_entries"."user_text" IS NULL OR char_length("changelog_entries"."user_text") BETWEEN 1 AND 280),
	CONSTRAINT "changelog_entries_audience" CHECK ("changelog_entries"."audience" IN ('staff', 'everyone', 'pro', 'early_access')),
	CONSTRAINT "changelog_entries_audience_staff" CHECK (("changelog_entries"."audience" = 'staff') = ("changelog_entries"."user_text" IS NULL)),
	CONSTRAINT "changelog_entries_revision" CHECK ("changelog_entries"."revision" >= 1),
	CONSTRAINT "changelog_entries_published_text" CHECK ("changelog_entries"."published_text" IS NULL OR char_length("changelog_entries"."published_text") BETWEEN 1 AND 280),
	CONSTRAINT "changelog_entries_published_audience" CHECK ("changelog_entries"."published_audience" IS NULL OR "changelog_entries"."published_audience" IN ('staff', 'everyone', 'pro', 'early_access')),
	CONSTRAINT "changelog_entries_published_together" CHECK (("changelog_entries"."published_audience" IS NULL AND "changelog_entries"."published_revision" IS NULL AND "changelog_entries"."published_text" IS NULL)
        OR ("changelog_entries"."published_audience" IS NOT NULL AND "changelog_entries"."published_revision" IS NOT NULL
            AND ("changelog_entries"."published_audience" = 'staff') = ("changelog_entries"."published_text" IS NULL))),
	CONSTRAINT "changelog_entries_live_version" CHECK ("changelog_entries"."live_version" IS NULL OR "changelog_entries"."live_version" ~ '^[0-9a-f]{12}$'),
	CONSTRAINT "changelog_entries_withdrawn_together" CHECK (("changelog_entries"."withdrawn_at" IS NULL AND "changelog_entries"."withdrawn_by" IS NULL AND "changelog_entries"."withdrawn_reason" IS NULL)
        OR ("changelog_entries"."withdrawn_at" IS NOT NULL AND "changelog_entries"."withdrawn_by" IS NOT NULL
            AND "changelog_entries"."withdrawn_reason" IS NOT NULL AND char_length("changelog_entries"."withdrawn_reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "changelog_reads" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"seen_through" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" DROP CONSTRAINT "staff_permission_overrides_known";--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_reads" ADD CONSTRAINT "changelog_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changelog_entries_user_list" ON "changelog_entries" USING btree ("live_at" DESC NULLS LAST,"pr_number" DESC NULLS LAST) WHERE "changelog_entries"."withdrawn_at" IS NULL AND "changelog_entries"."published_audience" <> 'staff';--> statement-breakpoint
CREATE INDEX "changelog_entries_merged" ON "changelog_entries" USING btree ("merged_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "changelog_entries_pending" ON "changelog_entries" USING btree ("pr_number") WHERE "changelog_entries"."live_at" IS NULL AND "changelog_entries"."withdrawn_at" IS NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish'));--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish'));--> statement-breakpoint
-- ensureOwnerRole runs only when an owner is granted, so the existing owner gets both here.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", p FROM "roles", unnest(ARRAY['changelog.edit', 'changelog.publish']) AS p WHERE "id" = 'owner'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The owner's default (6 Nov 2026): every staff role can edit and ask; release_check stays fixed.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", 'changelog.edit' FROM "roles" WHERE "id" NOT IN ('owner', 'release_check')
ON CONFLICT DO NOTHING;
