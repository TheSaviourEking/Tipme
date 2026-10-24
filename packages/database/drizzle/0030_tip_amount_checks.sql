-- Any inconsistent Pro amounts (none are written by the application) fall back to the standard ones.
UPDATE "profiles" SET "tip_presets_minor" = NULL, "min_tip_minor" = NULL
WHERE ("tip_presets_minor" IS NULL) <> ("min_tip_minor" IS NULL)
   OR ("tip_presets_minor" IS NOT NULL AND NOT ("min_tip_minor" <= ALL ("tip_presets_minor") AND 10000000 >= ALL ("tip_presets_minor")));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tip_amounts_together" CHECK ((tip_presets_minor IS NULL) = (min_tip_minor IS NULL));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tip_presets_range" CHECK (tip_presets_minor IS NULL OR (min_tip_minor <= ALL (tip_presets_minor) AND 10000000 >= ALL (tip_presets_minor)));