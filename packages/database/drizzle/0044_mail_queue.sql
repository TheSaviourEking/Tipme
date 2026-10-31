CREATE TABLE "mail_daily_stats" (
	"lagos_date" date NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mail_daily_stats_lagos_date_type_category_provider_kind_pk" PRIMARY KEY("lagos_date","type","category","provider","kind")
);
--> statement-breakpoint
CREATE TABLE "mail_message_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid,
	"kind" text NOT NULL,
	"provider" text,
	"provider_event_id" text,
	"link_key" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_message_events_kind" CHECK (kind IN ('queued', 'sent', 'send_failed', 'delivered', 'opened', 'clicked', 'soft_bounce', 'hard_bounce', 'complaint', 'suppressed', 'skipped_preference', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"user_id" uuid,
	"dedupe_key" text NOT NULL,
	"to_sealed" text,
	"to_hint" text NOT NULL,
	"data_sealed" text,
	"rendered_sealed" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer NOT NULL,
	"pinned_provider" text,
	"provider" text,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"final_at" timestamp with time zone,
	CONSTRAINT "mail_messages_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "mail_messages_category" CHECK (category IN ('security', 'account', 'transactional', 'engagement', 'marketing')),
	CONSTRAINT "mail_messages_status" CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'skipped', 'expired', 'bounced', 'complained'))
);
--> statement-breakpoint
CREATE TABLE "mail_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"engagement" boolean DEFAULT true NOT NULL,
	"marketing" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_suppressions" (
	"address_hmac" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"provider" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_suppressions_reason" CHECK (reason IN ('hard_bounce', 'complaint', 'repeated_soft_bounce', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "mail_message_events" ADD CONSTRAINT "mail_message_events_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_preferences" ADD CONSTRAINT "mail_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_message_events_provider_event" ON "mail_message_events" USING btree ("provider","provider_event_id") WHERE provider_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mail_message_events_message" ON "mail_message_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
CREATE INDEX "mail_messages_due" ON "mail_messages" USING btree ("status","priority","next_attempt_at");--> statement-breakpoint
CREATE INDEX "mail_messages_created" ON "mail_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mail_messages_type_created" ON "mail_messages" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "mail_messages_user_created" ON "mail_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_messages_provider_id" ON "mail_messages" USING btree ("provider","provider_message_id");