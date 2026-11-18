CREATE TABLE "plan_fee_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"free_bps" integer NOT NULL,
	"pro_bps" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" uuid,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_fee_rates_free_bps" CHECK ("plan_fee_rates"."free_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "plan_fee_rates_pro_bps" CHECK ("plan_fee_rates"."pro_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "plan_fee_rates_pro_not_above_free" CHECK ("plan_fee_rates"."pro_bps" <= "plan_fee_rates"."free_bps"),
	CONSTRAINT "plan_fee_rates_reason" CHECK (char_length("plan_fee_rates"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "plan_fee_rates" ADD CONSTRAINT "plan_fee_rates_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_fee_rates" ADD CONSTRAINT "plan_fee_rates_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_fee_rates_effective_from" ON "plan_fee_rates" USING btree ("effective_from");--> statement-breakpoint
-- The owner's decision, 18 Nov 2026: TipMe's share per plan is an admin setting. Rates are history
-- (like pro_prices, 0087): never edited, deleted or truncated (tests opt in).
CREATE TRIGGER plan_fee_rates_append_only BEFORE UPDATE OR DELETE ON plan_fee_rates
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER plan_fee_rates_no_truncate BEFORE TRUNCATE ON plan_fee_rates
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint
-- The starting rates: Free 5% (500 bps) and Pro 3% (300 bps), from this release, for new quotes only
-- (quotes already shown keep their recorded fee). Set by the owner, not by a staff member here, with a
-- system audit row like a staff change (plan_fees.changed). The id is fixed, so it is written once.
WITH added AS (
  INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, set_by, approved_by, reason, created_at)
  VALUES ('00000000-0000-4000-8000-000000000503', 500, 300, clock_timestamp(), NULL, NULL,
    'Owner''s decision, 18 Nov 2026: Free 5% and Pro 3% per tip, payment and withdrawal fees included',
    clock_timestamp())
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO audit_events (id, staff_user_id, action, permission, subject_type, subject_id, reason, created_at)
SELECT gen_random_uuid(), NULL, 'plan_fees.changed', 'fees.manage', 'plan_fee_rates', added.id::text,
       'Owner''s decision, 18 Nov 2026: Free 5% and Pro 3% per tip, payment and withdrawal fees included [change: {"from":{"freeBps":"700","proBps":"500"},"to":{"freeBps":"500","proBps":"300"},"approvedBy":null}]',
       clock_timestamp()
  FROM added;
