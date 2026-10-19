CREATE TABLE "fee_free_credits" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"remaining" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fee_free_credits_not_negative" CHECK (remaining >= 0)
);
--> statement-breakpoint
CREATE TABLE "moments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"shared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moments_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "reward_budget" (
	"month" text PRIMARY KEY NOT NULL,
	"spent_minor" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"moment_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"fee_free_count" integer DEFAULT 0 NOT NULL,
	"cash_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_grants_moment_id_unique" UNIQUE("moment_id")
);
--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD COLUMN "waived_platform_fee_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "celebration_moment_id" uuid;--> statement-breakpoint
ALTER TABLE "fee_free_credits" ADD CONSTRAINT "fee_free_credits_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_grants" ADD CONSTRAINT "reward_grants_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_grants" ADD CONSTRAINT "reward_grants_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moments_profile_created" ON "moments" USING btree ("profile_id","created_at");--> statement-breakpoint
-- A reward given is a record: never edited or deleted.
CREATE TRIGGER reward_grants_append_only BEFORE UPDATE OR DELETE ON reward_grants
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER reward_grants_no_truncate BEFORE TRUNCATE ON reward_grants
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
