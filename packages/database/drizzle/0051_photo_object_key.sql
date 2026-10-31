ALTER TABLE "profile_avatars" ALTER COLUMN "bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_avatars" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "profile_avatars" ADD CONSTRAINT "profile_avatars_one_place" CHECK ((bytes IS NULL) <> (object_key IS NULL));