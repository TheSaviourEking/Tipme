CREATE TABLE "market_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"observed_on" date NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"value" numeric,
	"text" text,
	"source_url" text NOT NULL,
	"note" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_entries_category" CHECK (category IN ('competitor', 'social', 'app_store', 'press', 'other')),
	CONSTRAINT "market_entries_source_https" CHECK (source_url LIKE 'https://%')
);
--> statement-breakpoint
CREATE INDEX "market_entries_series" ON "market_entries" USING btree ("name","metric","observed_on");