CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"file" text NOT NULL,
	"version" text NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "backup_runs_kind" CHECK (kind IN ('logical', 'base'))
);
--> statement-breakpoint
CREATE INDEX "backup_runs_kind_finished" ON "backup_runs" USING btree ("kind","finished_at");