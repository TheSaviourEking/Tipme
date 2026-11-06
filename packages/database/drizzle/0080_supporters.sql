CREATE TABLE "supporters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"label" text NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supporters_profile_key" UNIQUE("profile_id","key_hash"),
	CONSTRAINT "supporters_key_hash_length" CHECK (octet_length(key_hash) = 32),
	CONSTRAINT "supporters_label_length" CHECK (char_length(label) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "tip_supporters" (
	"tip_id" uuid PRIMARY KEY NOT NULL,
	"supporter_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supporters" ADD CONSTRAINT "supporters_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_supporters" ADD CONSTRAINT "tip_supporters_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_supporters" ADD CONSTRAINT "tip_supporters_supporter_id_supporters_id_fk" FOREIGN KEY ("supporter_id") REFERENCES "public"."supporters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tip_supporters_supporter" ON "tip_supporters" USING btree ("supporter_id");