ALTER TABLE "profiles" DROP CONSTRAINT "profiles_min_tip";--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_tip_presets_range";--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_min_tip" CHECK (min_tip_minor IS NULL OR (min_tip_minor >= 100000 AND min_tip_minor % 100 = 0));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tip_presets_range" CHECK (tip_presets_minor IS NULL OR min_tip_minor <= ALL (tip_presets_minor));