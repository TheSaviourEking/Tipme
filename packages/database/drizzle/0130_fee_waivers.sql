CREATE TABLE "fee_waiver_notices" (
	"rule_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_waiver_notices_rule_id_kind_pk" PRIMARY KEY("rule_id","kind"),
	CONSTRAINT "fee_waiver_notices_kind" CHECK ("fee_waiver_notices"."kind" IN ('started', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "fee_waivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"profile_id" uuid,
	"business_id" uuid,
	"fee" text NOT NULL,
	"payer" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"reason" text NOT NULL,
	"set_by" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_waivers_scope" CHECK ("fee_waivers"."scope" IN ('kind', 'account')),
	CONSTRAINT "fee_waivers_kind" CHECK ("fee_waivers"."kind" IN ('individual', 'business', 'giving')),
	CONSTRAINT "fee_waivers_fee" CHECK ("fee_waivers"."fee" IN ('tip', 'withdrawal')),
	CONSTRAINT "fee_waivers_payer" CHECK ("fee_waivers"."payer" IN ('tipme', 'account', 'inherit')),
	CONSTRAINT "fee_waivers_account" CHECK (("fee_waivers"."scope" = 'kind' AND "fee_waivers"."profile_id" IS NULL AND "fee_waivers"."business_id" IS NULL)
        OR ("fee_waivers"."scope" = 'account' AND "fee_waivers"."kind" = 'individual' AND "fee_waivers"."profile_id" IS NOT NULL AND "fee_waivers"."business_id" IS NULL)
        OR ("fee_waivers"."scope" = 'account' AND "fee_waivers"."kind" = 'business' AND "fee_waivers"."business_id" IS NOT NULL AND "fee_waivers"."profile_id" IS NULL)),
	CONSTRAINT "fee_waivers_inherit" CHECK ("fee_waivers"."payer" <> 'inherit' OR "fee_waivers"."scope" = 'account'),
	CONSTRAINT "fee_waivers_business_tip" CHECK (NOT ("fee_waivers"."kind" = 'business' AND "fee_waivers"."fee" = 'tip')),
	CONSTRAINT "fee_waivers_window" CHECK ("fee_waivers"."ends_at" IS NULL OR "fee_waivers"."ends_at" > "fee_waivers"."starts_at"),
	CONSTRAINT "fee_waivers_reason" CHECK (char_length("fee_waivers"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "fee_waiver_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "waived_fee_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD COLUMN "fee_waiver_id" uuid;--> statement-breakpoint
ALTER TABLE "fee_waiver_notices" ADD CONSTRAINT "fee_waiver_notices_rule_id_fee_waivers_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."fee_waivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_waivers_kind_key" ON "fee_waivers" USING btree ("kind","fee","starts_at" DESC NULLS LAST) WHERE scope = 'kind';--> statement-breakpoint
CREATE INDEX "fee_waivers_profile_key" ON "fee_waivers" USING btree ("profile_id","fee","starts_at" DESC NULLS LAST) WHERE profile_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "fee_waivers_business_key" ON "fee_waivers" USING btree ("business_id","fee","starts_at" DESC NULLS LAST) WHERE business_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_fee_waiver_id_fee_waivers_id_fk" FOREIGN KEY ("fee_waiver_id") REFERENCES "public"."fee_waivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD CONSTRAINT "tip_quotes_fee_waiver_id_fee_waivers_id_fk" FOREIGN KEY ("fee_waiver_id") REFERENCES "public"."fee_waivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK (kind IN ('tip', 'weekly_report', 'moment', 'collect_reminder', 'collect_verified', 'collect_name_recheck', 'dispute_hold', 'fee_waiver_started', 'fee_waiver_ended', 'business_invitation', 'business_verified', 'business_share_held_back'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_waived_fee" CHECK (waived_fee_minor >= 0 AND (waived_fee_minor = 0 OR fee_waiver_id IS NOT NULL));--> statement-breakpoint
-- Fee waiver rules are history (W16), like plan_fee_rates (0118): never edited, deleted or truncated
-- (tests opt in). A change is a newer row for the same key. The switch carry-over is Task 5's own
-- migration (pre-flight ruling R2), shipped with the code that stops reading the switch.
CREATE TRIGGER fee_waivers_append_only BEFORE UPDATE OR DELETE ON fee_waivers
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER fee_waivers_no_truncate BEFORE TRUNCATE ON fee_waivers
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
