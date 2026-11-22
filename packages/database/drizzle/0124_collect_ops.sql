ALTER TABLE "disputes" DROP CONSTRAINT "disputes_evidence_state";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" DROP CONSTRAINT "staff_permission_overrides_known";--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "evidence_text" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "evidence_files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "evidence_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "evidence_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "evidence_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "collect_name_recheck_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_evidence" CHECK (jsonb_typeof(evidence_files) = 'array' AND jsonb_array_length(evidence_files) <= 5
        AND evidence_attempt >= 0
        AND (evidence_state <> 'submitted' OR evidence_submitted_at IS NOT NULL)
        AND (evidence_state NOT IN ('sending', 'submitted') OR (evidence_text IS NOT NULL AND evidence_asked_at IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_evidence_state" CHECK (evidence_state IN ('none', 'draft', 'sending', 'submitted', 'refused'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK (kind IN ('tip', 'weekly_report', 'moment', 'collect_reminder', 'collect_verified', 'collect_name_recheck', 'dispute_hold', 'business_invitation', 'business_verified', 'business_share_held_back'));--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish', 'pro.price', 'switches.manage', 'announcements.send', 'collect.view', 'collect.manage'));--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage', 'changelog.edit', 'changelog.publish', 'pro.price', 'switches.manage', 'announcements.send', 'collect.view', 'collect.manage'));--> statement-breakpoint
-- ensureOwnerRole runs only when an owner is granted, so the existing owner gets the You collect
-- staff permissions here (as 0109 did for announcements.send). Safe to run twice.
INSERT INTO role_permissions (role_id, permission)
SELECT id, p FROM roles, (VALUES ('collect.view'), ('collect.manage')) AS v(p) WHERE id = 'owner'
ON CONFLICT DO NOTHING;
