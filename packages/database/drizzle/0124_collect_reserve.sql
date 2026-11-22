ALTER TABLE "collect_reserve_readings" DROP CONSTRAINT "collect_reserve_readings_amounts";--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" DROP CONSTRAINT "collect_reserve_readings_level";--> statement-breakpoint
ALTER TABLE "share_transfers" DROP CONSTRAINT "share_transfers_kind";--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" ADD CONSTRAINT "collect_reserve_readings_amounts" CHECK (held_minor >= 0 AND critical_minor >= 0 AND critical_minor <= warning_minor);--> statement-breakpoint
ALTER TABLE "collect_reserve_readings" ADD CONSTRAINT "collect_reserve_readings_level" CHECK (own_minor IS NULL OR (level IS NOT NULL AND level = CASE
          WHEN held_minor > 0 AND own_minor < 0 THEN 'breach'
          WHEN available_minor < 0 OR own_minor < critical_minor THEN 'critical'
          WHEN own_minor < warning_minor THEN 'warning'
          ELSE 'ok' END));--> statement-breakpoint
ALTER TABLE "share_transfers" ADD CONSTRAINT "share_transfers_kind" CHECK (kind IN ('sweep', 'recover', 'fee_return', 'holdback_repay', 'collect_sweep', 'collect_recover', 'collect_return'));