CREATE TABLE "withdrawals_switch" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"paused" boolean NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "withdrawals_switch_one_row" CHECK (id = 'global')
);
