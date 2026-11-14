CREATE TABLE "display_setting_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"changed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "display_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "display_settings_reason" CHECK (char_length("display_settings"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "display_setting_changes" ADD CONSTRAINT "display_setting_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_settings" ADD CONSTRAINT "display_settings_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "display_setting_changes_key" ON "display_setting_changes" USING btree ("key","created_at");