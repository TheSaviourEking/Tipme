CREATE TABLE "business_pro_auto_renew" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"enabled" boolean NOT NULL,
	"provider" text,
	"customer_reference" text,
	"payment_method_reference" text,
	"failed_period_id" uuid,
	"set_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_pro_auto_renew_source" CHECK (source IN ('balance', 'saved_card'))
);
--> statement-breakpoint
ALTER TABLE "pro_periods" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pro_purchases" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "pro_lapsed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pro_periods" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "pro_prices" ADD COLUMN "plan" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD COLUMN "bought_by" uuid;--> statement-breakpoint
ALTER TABLE "business_pro_auto_renew" ADD CONSTRAINT "business_pro_auto_renew_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_pro_auto_renew" ADD CONSTRAINT "business_pro_auto_renew_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_periods" ADD CONSTRAINT "pro_periods_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_bought_by_users_id_fk" FOREIGN KEY ("bought_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pro_periods_business_one_scheduled" ON "pro_periods" USING btree ("business_id") WHERE "pro_periods"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX "pro_prices_plan_effective_from" ON "pro_prices" USING btree ("plan","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "pro_purchases_business_one_open" ON "pro_purchases" USING btree ("business_id") WHERE "pro_purchases"."status" IN ('PENDING', 'COLLECTING', 'UNKNOWN');--> statement-breakpoint
ALTER TABLE "pro_periods" ADD CONSTRAINT "pro_periods_business_start" UNIQUE("business_id","starts_at");--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_business_idempotency" UNIQUE("business_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_plan" CHECK (plan IN ('free', 'pro'));--> statement-breakpoint
ALTER TABLE "pro_periods" ADD CONSTRAINT "pro_periods_owner" CHECK (("pro_periods"."profile_id" IS NULL) <> ("pro_periods"."business_id" IS NULL));--> statement-breakpoint
ALTER TABLE "pro_prices" ADD CONSTRAINT "pro_prices_plan" CHECK ("pro_prices"."plan" IN ('personal', 'business'));--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_owner" CHECK (("pro_purchases"."profile_id" IS NULL) <> ("pro_purchases"."business_id" IS NULL));--> statement-breakpoint
ALTER TABLE "pro_purchases" ADD CONSTRAINT "pro_purchases_bought_by" CHECK (("pro_purchases"."business_id" IS NULL) = ("pro_purchases"."bought_by" IS NULL));