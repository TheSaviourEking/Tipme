CREATE TABLE "handle_handover_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"handle_lower" text NOT NULL,
	"token_sha256" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "handle_handover_links_token_sha256_unique" UNIQUE("token_sha256"),
	CONSTRAINT "handle_handover_links_outcome" CHECK (("handle_handover_links"."used_at" IS NULL OR "handle_handover_links"."cancelled_at" IS NULL) AND ("handle_handover_links"."used_at" IS NULL) = ("handle_handover_links"."used_by" IS NULL) AND ("handle_handover_links"."cancelled_at" IS NULL) = ("handle_handover_links"."cancel_reason" IS NULL)),
	CONSTRAINT "handle_handover_links_expiry" CHECK ("handle_handover_links"."expires_at" > "handle_handover_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "handle_reservations" ADD COLUMN "handed_over_to" uuid;--> statement-breakpoint
ALTER TABLE "handle_handover_links" ADD CONSTRAINT "handle_handover_links_reservation_id_handle_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."handle_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_handover_links" ADD CONSTRAINT "handle_handover_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_handover_links" ADD CONSTRAINT "handle_handover_links_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_handover_links" ADD CONSTRAINT "handle_handover_links_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handle_handover_links_open" ON "handle_handover_links" USING btree ("reservation_id") WHERE used_at IS NULL AND cancelled_at IS NULL;--> statement-breakpoint
ALTER TABLE "handle_reservations" ADD CONSTRAINT "handle_reservations_handed_over_to_profiles_id_fk" FOREIGN KEY ("handed_over_to") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;