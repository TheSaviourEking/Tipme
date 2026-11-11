CREATE TABLE "pro_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"purchase_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"grace_ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"paid_by" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pro_periods_purchase_id_unique" UNIQUE("purchase_id"),
	CONSTRAINT "pro_periods_profile_start" UNIQUE("profile_id","starts_at"),
	CONSTRAINT "pro_periods_status" CHECK ("pro_periods"."status" IN ('SCHEDULED', 'ACTIVE', 'GRACE', 'ENDED')),
	CONSTRAINT "pro_periods_paid_by" CHECK ("pro_periods"."paid_by" IN ('card', 'bank_transfer', 'balance', 'saved_card')),
	CONSTRAINT "pro_periods_times" CHECK ("pro_periods"."starts_at" < "pro_periods"."ends_at" AND "pro_periods"."ends_at" < "pro_periods"."grace_ends_at"),
	CONSTRAINT "pro_periods_amount_positive" CHECK ("pro_periods"."amount_minor" > 0),
	CONSTRAINT "pro_periods_currency_iso" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "staff_pro" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pro_periods" ADD CONSTRAINT "pro_periods_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pro_periods_one_scheduled" ON "pro_periods" USING btree ("profile_id") WHERE "pro_periods"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX "pro_periods_due" ON "pro_periods" USING btree ("status","ends_at");