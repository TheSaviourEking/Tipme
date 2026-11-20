ALTER TABLE "collect_transfers" ADD COLUMN "refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "share_step" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "disputes_unsettled" ON "disputes" USING btree ("created_at") WHERE settled_at IS NULL;--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_never_cancel_sent" CHECK (status <> 'cancelled' OR sent_at IS NULL OR refused_at IS NOT NULL);--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_refused" CHECK (refused_at IS NULL OR status IN ('review', 'cancelled'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_share_step" CHECK (share_step IS NULL OR share_step IN ('held', 'balance', 'none'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_settled" CHECK (settled_at IS NULL OR status IN ('won', 'lost', 'closed'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_decided" CHECK (decided_at IS NULL OR status IN ('won', 'lost', 'closed'));