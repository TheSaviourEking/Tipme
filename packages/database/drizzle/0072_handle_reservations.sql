CREATE TABLE "handle_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle_lower" text NOT NULL,
	"source" text NOT NULL,
	"take_back_id" uuid,
	"reason" text NOT NULL,
	"reserved_by" uuid,
	"reserved_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	CONSTRAINT "handle_reservations_source" CHECK ("handle_reservations"."source" IN ('staff', 'take_back')),
	CONSTRAINT "handle_reservations_released" CHECK ("handle_reservations"."released_at" IS NULL OR ("handle_reservations"."released_by" IS NOT NULL AND "handle_reservations"."release_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "handle_reservations" ADD CONSTRAINT "handle_reservations_reserved_by_users_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_reservations" ADD CONSTRAINT "handle_reservations_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handle_reservations_active" ON "handle_reservations" USING btree ("handle_lower") WHERE released_at IS NULL;--> statement-breakpoint
-- Staff reservations (username reservation spec, section 3.4). Enforced here as well as in the
-- application, so a release that predates reservations (after a rollback) cannot hand a reserved
-- name to a page or keep it as an old username. Every write takes the same per-handle lock as 0028
-- first, so a reservation and a claim or rename of the same name at the same moment serialise and
-- exactly one wins. A take-back completion (PR 2) moves the page off the name before it writes the
-- reservation, so it needs no exception.
CREATE FUNCTION tipme_profile_handle_not_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tipme.handle:' || NEW.handle_lower));
  IF EXISTS (
    SELECT 1 FROM handle_reservations
     WHERE handle_lower = NEW.handle_lower AND released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'handle % is reserved', NEW.handle_lower
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER profiles_handle_not_reserved BEFORE INSERT OR UPDATE OF handle_lower ON profiles
  FOR EACH ROW EXECUTE FUNCTION tipme_profile_handle_not_reserved();
--> statement-breakpoint
CREATE FUNCTION tipme_alias_handle_not_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tipme.handle:' || NEW.handle_lower));
  IF EXISTS (
    SELECT 1 FROM handle_reservations
     WHERE handle_lower = NEW.handle_lower AND released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'handle % is reserved', NEW.handle_lower
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER handle_aliases_not_reserved BEFORE INSERT OR UPDATE ON handle_aliases
  FOR EACH ROW EXECUTE FUNCTION tipme_alias_handle_not_reserved();
--> statement-breakpoint
CREATE FUNCTION tipme_reservation_not_held() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tipme.handle:' || NEW.handle_lower));
  IF NEW.released_at IS NULL AND (
    EXISTS (SELECT 1 FROM profiles WHERE handle_lower = NEW.handle_lower)
    OR EXISTS (SELECT 1 FROM handle_aliases WHERE handle_lower = NEW.handle_lower)
  ) THEN
    RAISE EXCEPTION 'handle % belongs to a page', NEW.handle_lower
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER handle_reservations_not_held BEFORE INSERT ON handle_reservations
  FOR EACH ROW EXECUTE FUNCTION tipme_reservation_not_held();
