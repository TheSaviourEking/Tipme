CREATE TABLE "live_payment_switches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"live" boolean NOT NULL,
	"provider" text NOT NULL,
	"version" text NOT NULL,
	"switched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "live_payment_switches_latest" ON "live_payment_switches" USING btree ("switched_at" DESC NULLS LAST,"id" DESC NULLS LAST);