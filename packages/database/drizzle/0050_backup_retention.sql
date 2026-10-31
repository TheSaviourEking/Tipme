CREATE TABLE "backup_retention_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"outcome" text NOT NULL,
	"blocked" text DEFAULT '' NOT NULL,
	"retained_backups" integer NOT NULL,
	"boundary" text,
	"archive_bytes" bigint NOT NULL,
	"candidate_bytes" bigint NOT NULL,
	"deleted_bytes" bigint NOT NULL,
	"disk_free_bytes" bigint NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	CONSTRAINT "backup_retention_runs_mode" CHECK (mode IN ('dry-run', 'apply')),
	CONSTRAINT "backup_retention_runs_outcome" CHECK (outcome IN ('planned', 'applied', 'blocked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "recovery_drills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"base_file" text,
	"passed" boolean NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recovery_drills_kind" CHECK (kind IN ('pitr'))
);
--> statement-breakpoint
CREATE INDEX "backup_retention_runs_ran_at" ON "backup_retention_runs" USING btree ("ran_at");--> statement-breakpoint
CREATE INDEX "recovery_drills_ran_at" ON "recovery_drills" USING btree ("ran_at");