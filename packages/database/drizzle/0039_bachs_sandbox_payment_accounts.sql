CREATE TYPE "public"."payment_account_status" AS ENUM('CREATING', 'UNKNOWN', 'ONBOARDING', 'ACTIVE', 'RESTRICTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."provider_environment" AS ENUM('sandbox', 'live');--> statement-breakpoint
ALTER TYPE "public"."attempt_status" ADD VALUE 'STARTING' BEFORE 'INITIATED';--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"environment" "provider_environment" NOT NULL,
	"provider_account_reference" text,
	"status" "payment_account_status" NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"fee_collector" text DEFAULT 'unknown' NOT NULL,
	"requirements_due" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_accounts_profile_provider_environment" UNIQUE("profile_id","provider","environment"),
	CONSTRAINT "payment_accounts_provider_environment_reference" UNIQUE("provider","environment","provider_account_reference"),
	CONSTRAINT "payment_accounts_fee_collector" CHECK (fee_collector IN ('platform', 'connected_account', 'unknown')),
	CONSTRAINT "payment_accounts_requirements_bound" CHECK (cardinality(requirements_due) <= 50),
	CONSTRAINT "payment_accounts_active_can_charge" CHECK (status <> 'ACTIVE' OR charges_enabled)
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "start_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION tipme_check_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  allowed := CASE TG_TABLE_NAME
    WHEN 'tips' THEN ARRAY[
      'DRAFT>AWAITING_PAYMENT', 'DRAFT>CANCELLED',
      'AWAITING_PAYMENT>PENDING_VERIFICATION', 'AWAITING_PAYMENT>SUCCEEDED', 'AWAITING_PAYMENT>FAILED', 'AWAITING_PAYMENT>CANCELLED',
      'PENDING_VERIFICATION>SUCCEEDED', 'PENDING_VERIFICATION>FAILED', 'PENDING_VERIFICATION>CANCELLED']
    WHEN 'payment_attempts' THEN ARRAY[
      'CREATED>STARTING', 'CREATED>INITIATED', 'CREATED>PENDING', 'CREATED>VERIFIED_SUCCEEDED', 'CREATED>VERIFIED_FAILED', 'CREATED>EXPIRED', 'CREATED>UNKNOWN',
      'STARTING>INITIATED', 'STARTING>PENDING', 'STARTING>VERIFIED_SUCCEEDED', 'STARTING>VERIFIED_FAILED', 'STARTING>UNKNOWN',
      'INITIATED>PENDING', 'INITIATED>VERIFIED_SUCCEEDED', 'INITIATED>VERIFIED_FAILED', 'INITIATED>EXPIRED', 'INITIATED>UNKNOWN',
      'PENDING>VERIFIED_SUCCEEDED', 'PENDING>VERIFIED_FAILED', 'PENDING>EXPIRED', 'PENDING>UNKNOWN',
      'UNKNOWN>PENDING', 'UNKNOWN>VERIFIED_SUCCEEDED', 'UNKNOWN>VERIFIED_FAILED']
    WHEN 'payouts' THEN ARRAY[
      'REQUESTED>PROCESSING', 'REQUESTED>PAID', 'REQUESTED>FAILED',
      'PROCESSING>PAID', 'PROCESSING>FAILED', 'PAID>REVERSED']
  END;
  IF NOT (OLD.status::text || '>' || NEW.status::text) = ANY (allowed) THEN
    RAISE EXCEPTION 'status transition % -> % is not allowed on %', OLD.status, NEW.status, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;