CREATE TABLE "email_recoveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"started_by" text NOT NULL,
	"staff_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_recoveries_started_by" CHECK (started_by IN ('self', 'staff'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_recoveries" ADD CONSTRAINT "email_recoveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_recoveries_user" ON "email_recoveries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_recoveries_due" ON "email_recoveries" USING btree ("effective_at") WHERE completed_at IS NULL AND cancelled_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_verified_recovery_email" ON "users" USING btree (lower("recovery_email")) WHERE recovery_email_verified_at IS NOT NULL AND deleted_at IS NULL;