SELECT 'CREATE ROLE tipme_runtime LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tipme_runtime')
\gexec
ALTER ROLE tipme_runtime LOGIN PASSWORD :'runtime_password';

SELECT 'CREATE ROLE tipme_migrator LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tipme_migrator')
\gexec
ALTER ROLE tipme_migrator LOGIN PASSWORD :'migrator_password';

SELECT 'CREATE ROLE tipme_backup LOGIN REPLICATION'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tipme_backup')
\gexec
ALTER ROLE tipme_backup LOGIN REPLICATION PASSWORD :'backup_password';

DO $$
DECLARE
  object record;
BEGIN
  FOR object IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relowner = 'tipme'::regrole
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
      AND t.typowner = 'tipme'::regrole
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
      AND p.proowner = 'tipme'::regrole
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

REVOKE ALL ON DATABASE tipme FROM PUBLIC;
GRANT CONNECT ON DATABASE tipme TO tipme_runtime, tipme_migrator, tipme_backup;
-- The migrator creates the drizzle schema on a brand-new database.
GRANT CREATE ON DATABASE tipme TO tipme_migrator;

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
