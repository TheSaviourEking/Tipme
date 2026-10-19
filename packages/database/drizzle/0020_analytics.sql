CREATE TABLE "analytics_daily" (
	"date" date NOT NULL,
	"metric" text NOT NULL,
	"dimension" text DEFAULT '' NOT NULL,
	"value" bigint NOT NULL,
	CONSTRAINT "analytics_daily_date_metric_dimension_pk" PRIMARY KEY("date","metric","dimension")
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at_minute" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"flow_id" uuid,
	"surface" text,
	"channel" text,
	"handle" text,
	"returning" boolean,
	"device" text,
	"dedupe_key" text,
	CONSTRAINT "analytics_events_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "analytics_events_device" CHECK (device IS NULL OR device IN ('mobile', 'desktop')),
	CONSTRAINT "analytics_events_minute" CHECK (at_minute = date_trunc('minute', at_minute))
);
--> statement-breakpoint
CREATE INDEX "analytics_events_at" ON "analytics_events" USING btree ("at_minute");