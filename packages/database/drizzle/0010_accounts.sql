CREATE TABLE "pretend_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "pretend_outbox_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel" text NOT NULL,
	"recipient_hint" text NOT NULL,
	"user_id" uuid,
	"subject" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pretend_outbox_channel" CHECK (channel IN ('whatsapp', 'sms', 'email'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_sha256" text NOT NULL,
	"device_label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_sha256_unique" UNIQUE("token_sha256")
);
--> statement-breakpoint
CREATE TABLE "sign_in_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hmac" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sign_in_codes_purpose" CHECK (purpose IN ('sign_in', 'change_phone'))
);
--> statement-breakpoint
CREATE TABLE "sign_in_lockouts" (
	"phone_e164" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sign_in_codes_phone_created" ON "sign_in_codes" USING btree ("phone_e164","created_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164_unique" UNIQUE("phone_e164");--> statement-breakpoint
-- What the pretend messenger "sent" is a record: never edited or deleted (development only).
CREATE TRIGGER pretend_outbox_append_only BEFORE UPDATE OR DELETE ON pretend_outbox
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER pretend_outbox_no_truncate BEFORE TRUNCATE ON pretend_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
