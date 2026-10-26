CREATE INDEX "ledger_transactions_tip" ON "ledger_transactions" USING btree ("tip_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_payout" ON "ledger_transactions" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_reference" ON "payment_attempts" USING btree ("provider_reference");--> statement-breakpoint
CREATE INDEX "payment_attempts_reference_end" ON "payment_attempts" USING btree (lower(right("provider_reference", 6)));--> statement-breakpoint
CREATE INDEX "payouts_reference" ON "payouts" USING btree ("provider_reference");--> statement-breakpoint
CREATE INDEX "payouts_reference_end" ON "payouts" USING btree (lower(right("provider_reference", 6)));--> statement-breakpoint
CREATE INDEX "profiles_handle_prefix" ON "profiles" USING btree ("handle_lower" text_pattern_ops);