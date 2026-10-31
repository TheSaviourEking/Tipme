-- TipMe's database roles (ADR-0013). Plain SQL, run as the database's admin: the superuser of
-- staging's local Postgres (bootstrap-roles.sh), or a managed database's admin that owns the
-- database and has CREATEROLE but is not a superuser, such as Aiven's avnadmin (db-roles.js).
-- Passwords come from the session settings tipme.runtime_password, tipme.migrator_password and
-- tipme.backup_password; the callers set them and allow only letters, digits, '-' and '_'.
DO $$
DECLARE
  is_super boolean;
  can_replicate boolean;
  r record;
BEGIN
  SELECT rolsuper, rolreplication INTO is_super, can_replicate
    FROM pg_roles WHERE rolname = current_user;
  FOR r IN
    SELECT * FROM (VALUES ('tipme_runtime', 'runtime'), ('tipme_migrator', 'migrator'),
                          ('tipme_backup', 'backup')) AS v(role, setting)
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r.role) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r.role);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', r.role,
                   current_setting('tipme.' || r.setting || '_password'));
  END LOOP;
  -- Physical base backups need REPLICATION, which only a role that has it may grant. A managed
  -- database is backed up by its provider, so its backup role makes logical dumps only.
  IF is_super OR can_replicate THEN
    ALTER ROLE tipme_backup REPLICATION;
  END IF;
  -- A non-superuser admin hands objects to the migrator and sets its default privileges below,
  -- which needs membership; as the role's creator it may grant that to itself.
  IF NOT is_super AND NOT pg_has_role(current_user, 'tipme_migrator', 'SET') THEN
    EXECUTE format('GRANT tipme_migrator TO %I', current_user);
  END IF;
END
$$;

DO $$
DECLARE
  object record;
BEGIN
  FOR object IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (
        -- A sequence owned by a table column moves with its table.
        SELECT FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      )
  LOOP
    IF object.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO tipme_migrator', object.nspname, object.relname);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO tipme_migrator', object.nspname, object.relname);
    END IF;
  END LOOP;

  FOR object IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND t.typtype IN ('d', 'e')
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO tipme_migrator', object.nspname, object.typname);
    EXECUTE format(
      'GRANT USAGE ON TYPE %I.%I TO tipme_runtime, tipme_backup',
      object.nspname,
      object.typname
    );
  END LOOP;

  FOR object IN
    SELECT n.nspname, p.proname, p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND p.prokind IN ('f', 'p', 'a')
  LOOP
    EXECUTE format(
      'ALTER ROUTINE %I.%I(%s) OWNER TO tipme_migrator',
      object.nspname,
      object.proname,
      pg_get_function_identity_arguments(object.oid)
    );
  END LOOP;
END
$$;

-- Drizzle records applied migrations in its own schema: the migrator must own it to record the
-- next migration, and the backup role reads it for the manifest and the dump.
DO $$
DECLARE
  object record;
BEGIN
  IF to_regnamespace('drizzle') IS NOT NULL THEN
    EXECUTE 'ALTER SCHEMA drizzle OWNER TO tipme_migrator';
    FOR object IN
      SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'drizzle' AND c.relkind IN ('r', 'S')
        AND NOT EXISTS (
          -- A sequence owned by a table column moves with its table.
          SELECT FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
        )
    LOOP
      IF object.relkind = 'S' THEN
        EXECUTE format('ALTER SEQUENCE drizzle.%I OWNER TO tipme_migrator', object.relname);
      ELSE
        EXECUTE format('ALTER TABLE drizzle.%I OWNER TO tipme_migrator', object.relname);
      END IF;
    END LOOP;
    EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO tipme_backup';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO tipme_backup';
    EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO tipme_backup';
  END IF;
END
$$;

-- On a brand-new database the migrator creates the drizzle schema; deploy.sh runs this file
-- again after migrating, which applies these grants then.

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tipme_runtime, tipme_migrator, tipme_backup',
                 current_database());
  -- The migrator creates the drizzle schema on a brand-new database.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO tipme_migrator', current_database());
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tipme_runtime, tipme_backup;
GRANT USAGE, CREATE ON SCHEMA public TO tipme_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tipme_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tipme_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tipme_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO tipme_backup;

DO $$
BEGIN
  IF to_regclass('public.backup_runs') IS NOT NULL THEN
    EXECUTE 'GRANT INSERT ON TABLE public.backup_runs TO tipme_backup';
  END IF;
  IF to_regclass('public.backup_retention_runs') IS NOT NULL THEN
    EXECUTE 'GRANT INSERT ON TABLE public.backup_retention_runs TO tipme_backup';
  END IF;
END
$$;

ALTER DEFAULT PRIVILEGES FOR ROLE tipme_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tipme_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE tipme_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tipme_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE tipme_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO tipme_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE tipme_migrator IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO tipme_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE tipme_migrator IN SCHEMA public
  GRANT USAGE ON TYPES TO tipme_runtime, tipme_backup;
