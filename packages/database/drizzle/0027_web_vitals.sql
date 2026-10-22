CREATE TABLE "web_vitals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at_minute" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"page" text NOT NULL,
	"device" text NOT NULL,
	CONSTRAINT "web_vitals_metric" CHECK (metric IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')),
	CONSTRAINT "web_vitals_device" CHECK (device IN ('mobile', 'desktop')),
	CONSTRAINT "web_vitals_minute" CHECK (at_minute = date_trunc('minute', at_minute))
);
--> statement-breakpoint
CREATE INDEX "web_vitals_at" ON "web_vitals" USING btree ("at_minute");