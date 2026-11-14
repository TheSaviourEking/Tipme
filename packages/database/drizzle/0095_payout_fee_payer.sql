-- Users pay their own withdrawal fee (owner, 12 Nov 2026). Every payout already here keeps TipMe paying
-- (fee_payer defaults to tipme), so withdrawals in flight at the release finish under the old rule.
ALTER TABLE "payouts" ADD COLUMN "fee_payer" text DEFAULT 'tipme' NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "user_fee_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_fee_payer" CHECK (fee_payer IN ('tipme', 'user'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_fee" CHECK (user_fee_minor >= 0 AND (fee_payer = 'user' OR user_fee_minor = 0));