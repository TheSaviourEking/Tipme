# ADR-0013 — Least-privilege staging database roles

Date: 2026-10-24
Status: Accepted for staging; production remains blocked on the validation decisions in `docs/00-DECISIONS.md`.
Owners: Engineering

## Context

The staging Compose anchor loaded the complete `staging.env` into the API, worker, migration, and backup containers. Every application process connected as the PostgreSQL bootstrap superuser. The same broad environment also exposed unrelated application and off-site storage credentials to services that did not need them.

## Decision

- Keep `tipme` as the PostgreSQL bootstrap/admin role. It is used by the database container and the explicit, one-shot restore service only.
- Use `tipme_runtime` for the API and worker. It can connect, use the application schema, read and write application tables, and use their sequences; it cannot create schemas or databases.
- Use `tipme_migrator` for release migrations. It owns application objects, can create objects in the application schema, and receives default privileges for runtime and backup access.
- Use `tipme_backup` for scheduled logical and physical backups. It can read application tables/sequences, insert backup-run records, and connect with replication privileges. It cannot write application data.
- Provision or reconcile these roles with the idempotent `deploy/postgres/bootstrap-roles.sh` from the deploy script. Run it before the backup and migration and again after migrations, so existing volumes and newly created tables are covered.
- Explicitly map only each service's required configuration. The optional rclone service reads a separate `/srv/tipme/offsite.env`; bucket credentials do not enter the application environment.
- Keep restore drills and incident restores in a separate one-shot service with database-admin credentials. Never run that service continuously.
- Require distinct URL-safe passwords for the admin, runtime, migration, and backup roles. Do not reset or recreate an existing PostgreSQL volume as a rollout method.

## Rollout and rollback

The first release using this ADR reconciles roles on the existing staging database before taking a backup or running migrations. Old releases remain compatible because the original `tipme` role remains available for rollback. A restore from a logical backup must be followed by role reconciliation before application services resume.

This decision applies only to the pretend-payment staging environment. Production roles, secrets management, and migration policy require separate approval after the open product, legal, provider, and infrastructure decisions are resolved.

## Validation

- `scripts/deploy-scripts.test.mjs`:
  - role setup runs before the backup and again after migrating;
  - a reused or missing role password stops the deploy before Compose runs;
  - every setting the API and worker read is passed to them, so nothing silently takes its default.
- A rehearsal on a throwaway Postgres 16 container, holding a database migrated and seeded by the owner role (as staging is today):
  - the role setup runs twice and leaves nothing owned by `tipme`;
  - the migrator runs migrations, records them and creates tables;
  - the runtime role uses old and new tables, but cannot create or drop tables or read the migration journal;
  - the backup role takes a logical and a base backup, but cannot change data;
  - the restore drill passes.

## Corrections made while moving this onto dev (2026-10-25)

- **Sequences owned by a table column** (e.g. a `serial` id) cannot change owner on their own. The first version tried to, so the role setup failed on staging's data. They now move with their table.
- **The `drizzle` schema**, where applied migrations are recorded, was left owned by `tipme`. The migrator could not record a migration, and the backup role could not read it for the manifest. The migrator now owns it, the backup role can read it, and the migrator may create it on a new database.
- **Two API settings added in PR-013** (`RATE_LIMIT_REPORTS_PER_HOUR`, `RATE_LIMIT_AVATARS_PER_HOUR`) were missing from the API's settings list. They are now passed, and the test above keeps the list complete.
