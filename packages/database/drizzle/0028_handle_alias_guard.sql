-- PR-011: an old handle (handle_aliases) belongs to its page for good. Enforced here, not only in
-- the application, so a release that predates aliases (after a rollback) cannot give it to
-- someone else. Both writes take the same per-handle lock first, so concurrent ones serialise.
CREATE FUNCTION tipme_profile_handle_not_alias() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tipme.handle:' || NEW.handle_lower));
  IF EXISTS (
    SELECT 1 FROM handle_aliases
     WHERE handle_lower = NEW.handle_lower AND profile_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'handle % is an old handle of another page', NEW.handle_lower
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER profiles_handle_not_alias BEFORE INSERT OR UPDATE OF handle_lower ON profiles
  FOR EACH ROW EXECUTE FUNCTION tipme_profile_handle_not_alias();
--> statement-breakpoint
CREATE FUNCTION tipme_alias_not_other_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tipme.handle:' || NEW.handle_lower));
  IF EXISTS (
    SELECT 1 FROM profiles
     WHERE handle_lower = NEW.handle_lower AND id <> NEW.profile_id
  ) THEN
    RAISE EXCEPTION 'handle % belongs to another page', NEW.handle_lower
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER handle_aliases_not_other_profile BEFORE INSERT OR UPDATE ON handle_aliases
  FOR EACH ROW EXECUTE FUNCTION tipme_alias_not_other_profile();
