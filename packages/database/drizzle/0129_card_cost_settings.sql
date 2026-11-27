CREATE TABLE "card_cost_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rate_bps" integer NOT NULL,
	"fixed_minor" bigint NOT NULL,
	"margin_minor" bigint NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" uuid,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_cost_settings_rate_bps" CHECK ("card_cost_settings"."rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "card_cost_settings_fixed_minor" CHECK ("card_cost_settings"."fixed_minor" >= 0),
	CONSTRAINT "card_cost_settings_margin_minor" CHECK ("card_cost_settings"."margin_minor" >= 0),
	CONSTRAINT "card_cost_settings_reason" CHECK (char_length("card_cost_settings"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "card_cost_settings" ADD CONSTRAINT "card_cost_settings_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_cost_settings" ADD CONSTRAINT "card_cost_settings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_cost_settings_effective_from" ON "card_cost_settings" USING btree ("effective_from");--> statement-breakpoint
-- The owner's decision, 26 Nov 2026: what a card payment costs TipMe is an ops setting. Like
-- plan_fee_rates (0118) it is history: never edited, deleted or truncated (tests opt in). No seed:
-- with no row the coded defaults (2% + ₦45, margin ₦15) apply.
CREATE TRIGGER card_cost_settings_append_only BEFORE UPDATE OR DELETE ON card_cost_settings
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER card_cost_settings_no_truncate BEFORE TRUNCATE ON card_cost_settings
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
