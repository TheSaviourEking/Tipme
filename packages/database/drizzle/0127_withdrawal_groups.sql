ALTER TABLE "payouts" ADD COLUMN "withdrawal_group_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "group_part" smallint;--> statement-breakpoint
CREATE INDEX "payouts_withdrawal_group" ON "payouts" USING btree ("withdrawal_group_id") WHERE withdrawal_group_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_group_part" CHECK ((withdrawal_group_id IS NULL) = (group_part IS NULL));