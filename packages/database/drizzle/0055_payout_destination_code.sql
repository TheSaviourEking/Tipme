ALTER TABLE "email_codes" DROP CONSTRAINT "email_codes_purpose";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_codes" ADD CONSTRAINT "email_codes_purpose" CHECK (purpose IN ('sign_in', 'email_change', 'recovery_email', 'recovery', 'recovery_new_email', 'payout_destination'));