CREATE TABLE "business_invitation_blocks" (
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_invitation_blocks_business_id_user_id_pk" PRIMARY KEY("business_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "business_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"manager_role" text,
	"target" text NOT NULL,
	"email_lower" text,
	"invited_profile_id" uuid,
	"code_sha256" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"declined_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "business_invitations_code_sha256_unique" UNIQUE("code_sha256"),
	CONSTRAINT "business_invitations_kind" CHECK (kind IN ('staff', 'manager')),
	CONSTRAINT "business_invitations_target" CHECK (target IN ('email', 'link', 'user') AND (target = 'email') = (email_lower IS NOT NULL) AND (target = 'user') = (invited_profile_id IS NOT NULL)),
	CONSTRAINT "business_invitations_role" CHECK ((kind = 'staff' AND manager_role IS NULL AND location_id IS NOT NULL) OR (kind = 'manager' AND manager_role IN ('owner', 'location_manager') AND (manager_role = 'owner') = (location_id IS NULL))),
	CONSTRAINT "business_invitations_outcome" CHECK ((accepted_at IS NOT NULL)::int + (declined_at IS NOT NULL)::int + (revoked_at IS NOT NULL)::int <= 1 AND (accepted_at IS NULL) = (accepted_by IS NULL))
);
--> statement-breakpoint
CREATE TABLE "business_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_locations_slug" UNIQUE("business_id","slug"),
	CONSTRAINT "business_locations_slug_rule" CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$'),
	CONSTRAINT "business_locations_text" CHECK (char_length(name) BETWEEN 1 AND 60 AND char_length(address) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "business_managers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"location_id" uuid,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "business_managers_role" CHECK (role IN ('owner', 'location_manager')),
	CONSTRAINT "business_managers_location" CHECK ((role = 'owner') = (location_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "business_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"shown_name" text NOT NULL,
	"show_photo" boolean DEFAULT true NOT NULL,
	"share_amounts" boolean DEFAULT false NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"left_by" text,
	CONSTRAINT "business_members_shown_name" CHECK (char_length(shown_name) BETWEEN 1 AND 30),
	CONSTRAINT "business_members_left" CHECK ((left_at IS NULL) = (left_by IS NULL) AND (left_by IS NULL OR left_by IN ('self', 'manager', 'tipme', 'account_deleted')))
);
--> statement-breakpoint
CREATE TABLE "business_note_flags" (
	"tip_id" uuid PRIMARY KEY NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"reported_by" text NOT NULL,
	"reason" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"outcome" text,
	CONSTRAINT "business_note_flags_reported" CHECK (reported_by IN ('member', 'manager') AND reason IN ('abusive', 'spam', 'other')),
	CONSTRAINT "business_note_flags_review" CHECK ((reviewed_at IS NULL) = (outcome IS NULL) AND (outcome IS NULL OR outcome IN ('restored', 'removed')))
);
--> statement-breakpoint
CREATE TABLE "business_notes" (
	"tip_id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_notes_tags" CHECK (cardinality(tags) <= 5 AND tags <@ ARRAY['friendly', 'fast', 'extra_mile', 'great_advice', 'made_my_day']::text[]),
	CONSTRAINT "business_notes_body" CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 280),
	CONSTRAINT "business_notes_something" CHECK (cardinality(tags) > 0 OR body IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "business_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_by" text NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	CONSTRAINT "business_shifts_started_by" CHECK (started_by IN ('self', 'manager')),
	CONSTRAINT "business_shifts_ended" CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_by IS NULL OR ended_by IN ('self', 'manager', 'expired', 'left')))
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"created_by" uuid NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_slug_unique" UNIQUE("slug"),
	CONSTRAINT "businesses_slug" CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
	CONSTRAINT "businesses_name" CHECK (char_length(name) BETWEEN 1 AND 80),
	CONSTRAINT "businesses_status" CHECK (status IN ('pending', 'verified', 'suspended')),
	CONSTRAINT "businesses_contact" CHECK (char_length(contact_name) BETWEEN 1 AND 80 AND char_length(contact_email) BETWEEN 3 AND 254 AND (contact_phone IS NULL OR char_length(contact_phone) <= 32)),
	CONSTRAINT "businesses_suspended" CHECK ((status = 'suspended') = (suspended_at IS NOT NULL) AND (suspended_at IS NULL OR suspended_reason IS NOT NULL)),
	CONSTRAINT "businesses_verified" CHECK (status = 'pending' OR verified_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_kind";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_known";--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" DROP CONSTRAINT "staff_permission_overrides_known";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "business_member_id" uuid;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "business_location_id" uuid;--> statement-breakpoint
ALTER TABLE "business_invitation_blocks" ADD CONSTRAINT "business_invitation_blocks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_invitation_blocks" ADD CONSTRAINT "business_invitation_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_location_id_business_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_invited_profile_id_profiles_id_fk" FOREIGN KEY ("invited_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_managers" ADD CONSTRAINT "business_managers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_managers" ADD CONSTRAINT "business_managers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_managers" ADD CONSTRAINT "business_managers_location_id_business_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_managers" ADD CONSTRAINT "business_managers_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_location_id_business_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_note_flags" ADD CONSTRAINT "business_note_flags_tip_id_business_notes_tip_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."business_notes"("tip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_note_flags" ADD CONSTRAINT "business_note_flags_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_notes" ADD CONSTRAINT "business_notes_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_notes" ADD CONSTRAINT "business_notes_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_shifts" ADD CONSTRAINT "business_shifts_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_invitation_blocks_user" ON "business_invitation_blocks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "business_invitations_business" ON "business_invitations" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "business_invitations_email" ON "business_invitations" USING btree ("email_lower") WHERE email_lower IS NOT NULL;--> statement-breakpoint
CREATE INDEX "business_invitations_profile" ON "business_invitations" USING btree ("invited_profile_id") WHERE invited_profile_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "business_managers_open" ON "business_managers" USING btree ("business_id","user_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "business_managers_user" ON "business_managers" USING btree ("user_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "business_members_open" ON "business_members" USING btree ("location_id","profile_id") WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX "business_members_profile" ON "business_members" USING btree ("profile_id") WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX "business_notes_member" ON "business_notes" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "business_shifts_open" ON "business_shifts" USING btree ("member_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "business_shifts_member_started" ON "business_shifts" USING btree ("member_id","started_at");--> statement-breakpoint
CREATE INDEX "businesses_created_by" ON "businesses" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "businesses_status_created" ON "businesses" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_invitation_id_business_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."business_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_business_member_id_business_members_id_fk" FOREIGN KEY ("business_member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_business_location_id_business_locations_id_fk" FOREIGN KEY ("business_location_id") REFERENCES "public"."business_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_invitation_once" ON "notifications" USING btree ("kind","invitation_id") WHERE invitation_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tips_business_location_completed" ON "tips" USING btree ("business_location_id","completed_at") WHERE business_location_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tips_business_member" ON "tips" USING btree ("business_member_id") WHERE business_member_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_kind" CHECK (kind IN ('payment_mismatch', 'payment_conflict', 'payment_unresolved', 'payment_attempt_unresolved', 'payment_account_unresolved', 'payment_account_setup_failed', 'payment_reversed', 'payment_settlement_currency', 'payout_failed', 'payout_conflict', 'payout_unexpected', 'payout_unresolved', 'payout_fee_short', 'payout_held', 'provider_in_debt', 'provider_event_conflict', 'stuck_tip', 'unmatched_event', 'pending_recovery', 'message_reported', 'profile_reported', 'account_takeover_reported', 'reserve_empty', 'provider_key_refused', 'staff_acted_alone', 'staff_approval_pending', 'staff_last_approver_removed', 'username_take_back_unnoticed', 'username_take_back_overdue', 'business_waiting', 'business_note_reported'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK (kind IN ('tip', 'weekly_report', 'moment', 'business_invitation', 'business_verified'));--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage'));--> statement-breakpoint
ALTER TABLE "staff_permission_overrides" ADD CONSTRAINT "staff_permission_overrides_known" CHECK (permission IN ('issues.view', 'issues.resolve', 'pages.suspend', 'recoveries.cancel', 'analytics.view', 'market.edit', 'audit.view', 'payments.recheck', 'private.view', 'pages.plan', 'search.view', 'fees.manage', 'providers.manage', 'recoveries.manage', 'payouts.resolve', 'email.read', 'email.export', 'payments.repair', 'staff.manage', 'usernames.manage', 'businesses.manage'));--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_business_pair" CHECK ((business_member_id IS NULL) = (business_location_id IS NULL));--> statement-breakpoint
-- ensureOwnerRole runs only when an owner is granted, so an existing owner gets the new one here.
-- release_check and custom roles get it only when someone with staff.manage ticks it.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", p FROM "roles", unnest(ARRAY['businesses.manage']) AS p WHERE "id" = 'owner'
ON CONFLICT DO NOTHING;
