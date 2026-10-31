CREATE TABLE "email_code_lockouts" (
	"email" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hmac" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_codes_purpose" CHECK (purpose IN ('sign_in', 'email_change', 'recovery_email', 'recovery', 'recovery_new_email'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_hash" text;--> statement-breakpoint
CREATE INDEX "email_codes_email_created" ON "email_codes" USING btree ("email","created_at");--> statement-breakpoint
-- A verified address must belong to one live account from here on. If an address was verified on
-- several, the most recently verified keeps it and the others simply become unverified.
UPDATE "users" u SET "email_verified_at" = NULL
 WHERE u."email_verified_at" IS NOT NULL AND u."deleted_at" IS NULL AND EXISTS (
   SELECT 1 FROM "users" o
    WHERE lower(o."email") = lower(u."email") AND o."id" <> u."id"
      AND o."email_verified_at" IS NOT NULL AND o."deleted_at" IS NULL
      AND (o."email_verified_at", o."id") > (u."email_verified_at", u."id"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_verified_email" ON "users" USING btree (lower("email")) WHERE email_verified_at IS NOT NULL AND deleted_at IS NULL;