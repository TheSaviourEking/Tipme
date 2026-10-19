CREATE TYPE "public"."account_kind" AS ENUM('asset', 'liability', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('CREATED', 'INITIATED', 'PENDING', 'VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'EXPIRED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('tip', 'attempt', 'payout');--> statement-breakpoint
CREATE TYPE "public"."ledger_side" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."operation_type" AS ENUM('payment', 'payout');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."profile_visibility" AS ENUM('public', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."tip_status" AS ENUM('DRAFT', 'AWAITING_PAYMENT', 'PENDING_VERIFICATION', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."transition_cause" AS ENUM('provider_event', 'system', 'expiry');--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"kind" "account_kind" NOT NULL,
	"currency" char(3) NOT NULL,
	"profile_id" uuid,
	CONSTRAINT "ledger_accounts_identity" UNIQUE NULLS NOT DISTINCT("code","currency","profile_id"),
	CONSTRAINT "ledger_accounts_currency_iso" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"profile_id" uuid,
	"side" "ledger_side" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledger_entries_amount_positive" CHECK (amount_minor > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_type" "operation_type" NOT NULL,
	"operation_key" text NOT NULL,
	"currency" char(3) NOT NULL,
	"tip_id" uuid,
	"payout_id" uuid,
	"trace_id" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "ledger_transactions_currency_iso" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"trace" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbox_events_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "outbox_events_dedupe_key" CHECK (dedupe_key !~ ':')
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider" text,
	"provider_reference" text,
	"status" "attempt_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_number" UNIQUE("intent_id","attempt_number"),
	CONSTRAINT "payment_attempts_provider_reference" UNIQUE("provider","provider_reference")
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"quote_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" "tip_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_idempotency" UNIQUE("profile_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payout_items" (
	"payout_id" uuid NOT NULL,
	"tip_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "payout_items_payout_id_tip_id_pk" PRIMARY KEY("payout_id","tip_id")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" "payout_status" NOT NULL,
	"provider" text,
	"provider_reference" text,
	"idempotency_key" text NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payouts_provider_reference" UNIQUE("provider","provider_reference"),
	CONSTRAINT "payouts_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "payouts_amount_positive" CHECK (amount_minor > 0)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"handle" text NOT NULL,
	"handle_lower" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"visibility" "profile_visibility" DEFAULT 'public' NOT NULL,
	"status" "profile_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_handle_lower_unique" UNIQUE("handle_lower")
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_id" uuid,
	"payout_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_outcome" text,
	CONSTRAINT "provider_events_provider_event" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "provider_events_verified" CHECK (signature_verified)
);
--> statement-breakpoint
CREATE TABLE "status_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"cause" "transition_cause" NOT NULL,
	"provider_event_id" uuid,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tip_messages" (
	"tip_id" uuid PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_messages_length" CHECK (char_length(body) BETWEEN 1 AND 280)
);
--> statement-breakpoint
CREATE TABLE "tip_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"tip_minor" bigint NOT NULL,
	"platform_fee_minor" bigint NOT NULL,
	"provider_fee_minor" bigint NOT NULL,
	"payer_total_minor" bigint NOT NULL,
	"recipient_net_minor" bigint NOT NULL,
	"fee_policy_version" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_quotes_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "tip_quotes_amounts" CHECK (tip_minor > 0 AND platform_fee_minor >= 0 AND provider_fee_minor >= 0 AND recipient_net_minor > 0),
	CONSTRAINT "tip_quotes_payer_total" CHECK (payer_total_minor = tip_minor),
	CONSTRAINT "tip_quotes_net" CHECK (recipient_net_minor = tip_minor - platform_fee_minor - provider_fee_minor)
);
--> statement-breakpoint
CREATE TABLE "tips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"gross_minor" bigint NOT NULL,
	"status" "tip_status" NOT NULL,
	"payer_display_label" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tips_intent_id_unique" UNIQUE("intent_id"),
	CONSTRAINT "tips_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "tips_gross_positive" CHECK (gross_minor > 0),
	CONSTRAINT "tips_label_length" CHECK (payer_display_label IS NULL OR char_length(payer_display_label) <= 60)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_quote_id_tip_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."tip_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_provider_event_id_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_messages" ADD CONSTRAINT "tip_messages_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_quotes" ADD CONSTRAINT "tip_quotes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished" ON "outbox_events" USING btree ("created_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_items_active_tip" ON "payout_items" USING btree ("tip_id") WHERE active;--> statement-breakpoint
CREATE INDEX "status_transitions_entity" ON "status_transitions" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "tips_profile_created" ON "tips" USING btree ("profile_id","created_at");