ALTER TABLE "share_transfers" DROP CONSTRAINT "share_transfers_links";--> statement-breakpoint
ALTER TABLE "tip_refunds" DROP CONSTRAINT "tip_refunds_failure";--> statement-breakpoint
ALTER TABLE "share_transfers" ADD COLUMN "tip_refund_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD COLUMN "collect_plan" text;--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD COLUMN "gap_minor" bigint;--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD COLUMN "held_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD COLUMN "recovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_tip_refund_id_tip_refunds_id_fk" FOREIGN KEY ("tip_refund_id") REFERENCES "public"."tip_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_transfers_one_refund_recover" ON "share_transfers" USING btree ("tip_refund_id") WHERE kind = 'collect_recover';--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_links" CHECK ((kind = 'recover') = (reversal_transaction_id IS NOT NULL)
        AND (kind = 'fee_return') = (partner_reversal_id IS NOT NULL)
        AND (kind = 'holdback_repay') = (parent_id IS NOT NULL AND holdback_id IS NOT NULL)
        AND (kind = 'collect_recover') = (dispute_id IS NOT NULL OR tip_refund_id IS NOT NULL)
        AND (dispute_id IS NULL OR tip_refund_id IS NULL));--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD CONSTRAINT "tip_refunds_collect_plan" CHECK (("tip_refunds"."collect_plan" IS NULL OR "tip_refunds"."collect_plan" IN ('cancel_held', 'take_back', 'absorb'))
        AND ((COALESCE("tip_refunds"."collect_plan", '') = 'absorb') = ("tip_refunds"."gap_minor" IS NOT NULL))
        AND ("tip_refunds"."gap_minor" IS NULL OR "tip_refunds"."gap_minor" > 0)
        AND "tip_refunds"."held_minor" >= 0 AND "tip_refunds"."held_minor" <= "tip_refunds"."amount_minor"
        AND ("tip_refunds"."collect_plan" IS NOT NULL OR ("tip_refunds"."held_minor" = 0 AND "tip_refunds"."recovered_at" IS NULL)));--> statement-breakpoint
ALTER TABLE "tip_refunds" ADD CONSTRAINT "tip_refunds_failure" CHECK ("tip_refunds"."failure" IS NULL OR ("tip_refunds"."status" = 'FAILED' AND "tip_refunds"."failure" IN ('bank_transfer', 'not_refundable', 'refused', 'partner_failed', 'balance', 'not_recovered')));