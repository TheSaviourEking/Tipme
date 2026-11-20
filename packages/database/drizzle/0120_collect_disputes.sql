ALTER TABLE "share_transfers" DROP CONSTRAINT "share_transfers_kind";--> statement-breakpoint
ALTER TABLE "share_transfers" DROP CONSTRAINT "share_transfers_one_leg";--> statement-breakpoint
ALTER TABLE "share_transfers" DROP CONSTRAINT "share_transfers_links";--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD COLUMN "refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "share_step" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD COLUMN "dispute_id" uuid;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD COLUMN "refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disputes_unsettled" ON "disputes" USING btree ("created_at") WHERE settled_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_one_collect_recover" ON "share_transfers" USING btree ("dispute_id") WHERE kind = 'collect_recover';--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_never_cancel_sent" CHECK (status <> 'cancelled' OR sent_at IS NULL OR refused_at IS NOT NULL);--> statement-breakpoint
ALTER TABLE "collect_transfers" ADD CONSTRAINT "collect_transfers_refused" CHECK (refused_at IS NULL OR status IN ('review', 'cancelled'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_share_step" CHECK (share_step IS NULL OR share_step IN ('held', 'balance', 'none'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_settled" CHECK (settled_at IS NULL OR status IN ('won', 'lost', 'closed'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_decided" CHECK (decided_at IS NULL OR status IN ('won', 'lost', 'closed'));--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_refused" CHECK (refused_at IS NULL OR status IN ('review', 'cancelled'));--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_kind" CHECK (kind IN ('sweep', 'recover', 'fee_return', 'holdback_repay', 'collect_sweep', 'collect_recover'));--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_one_leg" CHECK (kind IN ('sweep', 'recover', 'collect_recover') OR status NOT IN ('waiting', 'out_sent', 'gap'));--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_links" CHECK ((kind = 'recover') = (reversal_transaction_id IS NOT NULL)
        AND (kind = 'fee_return') = (partner_reversal_id IS NOT NULL)
        AND (kind = 'holdback_repay') = (parent_id IS NOT NULL AND holdback_id IS NOT NULL)
        AND (kind = 'collect_recover') = (dispute_id IS NOT NULL));--> statement-breakpoint
-- You collect (plan Task 9). Hand-written below the generated part, as 0119.
-- `refused_at` says a share's last send was definitely refused, so a dispute or refund may take it
-- although it was sent (the exception in collect_transfers_never_cancel_sent). It may only be set by
-- the move that records that refusal: from a sending state (ready, sent, unknown) into review. Never
-- on insert, never on or from a paid row, and never together with a cancel.
CREATE FUNCTION tipme_collect_refused_from_send() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.refused_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.refused_at IS NULL) THEN
    IF TG_OP = 'INSERT' OR NEW.status <> 'review' OR OLD.status NOT IN ('ready', 'sent', 'unknown') THEN
      RAISE EXCEPTION 'collect_transfers_refused_from_send: refused_at is set only when a send moves into review'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'collect_transfers_refused_from_send';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER collect_transfers_refused_from_send BEFORE INSERT OR UPDATE ON collect_transfers
  FOR EACH ROW EXECUTE FUNCTION tipme_collect_refused_from_send();
