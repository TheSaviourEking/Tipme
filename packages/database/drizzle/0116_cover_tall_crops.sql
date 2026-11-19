-- Tall crops of a cover (4:5, for the phone hero of the Studio styles Stage and Horizon) live
-- beside the width renditions, told apart by `shape`. Existing rows are the wide copies. drizzle-kit
-- generated these statements with the primary key before the column it names; reordered by hand
-- so the column exists first. The table is small (at most three rows per cover).
ALTER TABLE "profile_cover_renditions" ADD COLUMN "shape" text DEFAULT 'wide' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_cover_renditions" DROP CONSTRAINT "profile_cover_renditions_width";--> statement-breakpoint
ALTER TABLE "profile_cover_renditions" DROP CONSTRAINT "profile_cover_renditions_profile_id_width_pk";--> statement-breakpoint
ALTER TABLE "profile_cover_renditions" ADD CONSTRAINT "profile_cover_renditions_profile_id_shape_width_pk" PRIMARY KEY("profile_id","shape","width");--> statement-breakpoint
ALTER TABLE "profile_cover_renditions" ADD CONSTRAINT "profile_cover_renditions_width" CHECK ((shape = 'wide' AND width IN (640, 1080, 1600)) OR (shape = 'tall' AND width IN (480, 720)));
