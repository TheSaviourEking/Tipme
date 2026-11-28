CREATE TABLE "fee_waiver_account_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"profile_id" uuid,
	"business_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_waiver_account_notices_kind" CHECK ("fee_waiver_account_notices"."kind" IN ('ended')),
	CONSTRAINT "fee_waiver_account_notices_account" CHECK ((profile_id IS NULL) <> (business_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "fee_waiver_account_notices" ADD CONSTRAINT "fee_waiver_account_notices_rule_id_fee_waivers_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."fee_waivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waiver_account_notices" ADD CONSTRAINT "fee_waiver_account_notices_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waiver_account_notices" ADD CONSTRAINT "fee_waiver_account_notices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_waiver_account_notices_profile" ON "fee_waiver_account_notices" USING btree ("rule_id","kind","profile_id") WHERE profile_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_waiver_account_notices_business" ON "fee_waiver_account_notices" USING btree ("rule_id","kind","business_id") WHERE business_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payouts_fee_waiver" ON "payouts" USING btree ("fee_waiver_id") WHERE fee_waiver_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tip_quotes_fee_waiver" ON "tip_quotes" USING btree ("fee_waiver_id","profile_id") WHERE fee_waiver_id IS NOT NULL;