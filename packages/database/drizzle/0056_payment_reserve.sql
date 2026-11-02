CREATE TABLE "payment_reserve_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"currency" char(3) NOT NULL,
	"available_minor" bigint,
	"threshold_minor" bigint NOT NULL,
	"low" boolean,
	"read_at" timestamp with time zone NOT NULL,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "payment_reserve_readings_currency_iso" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_reserve_readings_provider" CHECK (provider ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "payment_reserve_readings_known" CHECK ((available_minor IS NULL AND low IS NULL)
        OR (available_minor IS NOT NULL AND low IS NOT NULL AND low = (available_minor < threshold_minor)))
);
--> statement-breakpoint
CREATE INDEX "payment_reserve_readings_latest" ON "payment_reserve_readings" USING btree ("provider","currency","read_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_reserve_readings_read_at" ON "payment_reserve_readings" USING btree ("read_at" DESC NULLS LAST);