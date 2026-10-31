# Runbook: a remote (managed) Postgres for production

Production's database is a managed Postgres on **Aiven** (owner, 31 October 2026). Aiven provides its backups and point-in-time recovery, so none of staging's WAL archiving, base backups or retention runs against it. The API, worker and migrations reach it over the network.

## What the app requires

- **TLS with a checked certificate.** In production, the API and worker refuse to start when `DATABASE_URL` points across the network without `sslmode=verify-full` (or `verify-ca`). A database on the same host or Docker network (`postgres`, `localhost`, `127.0.0.1`) is exempt.
- **The CA certificate as a file** named in the URL: `sslrootcert=/run/secrets/db-ca.pem`. node-postgres reads it from the URL, as `packages/database/test/connection.test.mjs` proves.
- **Three roles**, each with only its job (ADR-0013):

  | Role             | Used by                | Can                                  |
  | ---------------- | ---------------------- | ------------------------------------ |
  | `tipme_runtime`  | API, worker            | read and write data                  |
  | `tipme_migrator` | migrations             | own the tables and change the schema |
  | `tipme_backup`   | optional logical dumps | read only                            |

  On a managed database the backup role gets no `REPLICATION`. Aiven does physical backups itself.

## Setting it up (once)

1. **Create the database.**
   - In Aiven, create the PostgreSQL 16 service in the region you choose, then a database named `tipme` (Databases tab).
   - Download the service's **CA certificate**.
   - Note the admin user (`avnadmin`), its password, the host and the port.
2. **Put the CA on the server:**
   ```sh
   sudo install -d -o deploy -m 700 /srv/tipme/production
   install -m 644 ca.pem /srv/tipme/production/db-ca.pem
   ```
3. **Set up the roles** as `avnadmin`, using the app image. It's the same `roles.sql` staging uses: plain SQL that works as a superuser or as a `CREATEROLE` admin that owns the database.
   ```sh
   # Passwords: at least 16 letters, digits, '-' or '_'. Generate three; keep them only in the env file.
   docker run --rm --env-file /srv/tipme/production.env \
     -v /srv/tipme/production/db-ca.pem:/run/secrets/db-ca.pem:ro \
     tipme-app:<version> node packages/database/dist/scripts/db-roles.js
   ```
   It reads `DATABASE_ADMIN_URL`, `POSTGRES_RUNTIME_PASSWORD`, `POSTGRES_MIGRATOR_PASSWORD` and `POSTGRES_BACKUP_PASSWORD`, and prints "Database roles are set up." Running it again is safe.
4. **Migrate as the migrator,** naming the database on purpose:
   ```sh
   docker run --rm --env-file /srv/tipme/production.env \
     -e DATABASE_URL="$MIGRATION_DATABASE_URL" -e MIGRATE_CONFIRM_DATABASE=tipme \
     -v /srv/tipme/production/db-ca.pem:/run/secrets/db-ca.pem:ro \
     tipme-app:<version> node packages/database/dist/scripts/release-migrate.js
   ```
   Then **run step 3 again**, so the new tables get their grants.

## The settings (`/srv/tipme/production.env`, mode 600)

```sh
# Aiven admin: only for db-roles.js. Never given to the API or worker.
DATABASE_ADMIN_URL=postgres://avnadmin:<password>@<host>:<port>/tipme?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem
# The API and worker.
DATABASE_URL=postgres://tipme_runtime:<runtime password>@<host>:<port>/tipme?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem
# Migrations.
MIGRATION_DATABASE_URL=postgres://tipme_migrator:<migrator password>@<host>:<port>/tipme?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem
POSTGRES_RUNTIME_PASSWORD=
POSTGRES_MIGRATOR_PASSWORD=
POSTGRES_BACKUP_PASSWORD=
```

Every container that connects mounts the CA at `/run/secrets/db-ca.pem`, read-only.

## Not done yet (production environment work)

- **A production Compose project for this server.** It has no local `postgres`, `backup` or `retention` services, and its own Redis, network and env file.
- **Ports 80 and 443.** Done: the edge Caddy (`deploy/edge`, project `tipme-edge`) owns them and routes both API hosts. Production's API copies must be the containers `tipme-production-api-{blue,green}-{1,2,3}` (project `tipme-production`) on the external network `edge-production`; the edge lists those six names.
- **A `deploy-production` workflow** that runs the role setup and migrations above as its steps.
- **Allowing only this server** in Aiven's IP allow-list.

These are part of the live pilot's production environment (`docs/superpowers/specs/2026-10-31-live-pilot-design.md` §6.6).

## Checking it

```sh
# From the server: the app's view of the database (readiness includes it).
curl -s https://api.usetipme.xyz/health/ready
```

If the API refuses to start with a `DATABASE_URL` error, the URL is missing `sslmode=verify-full`. If it starts but can't connect, check the CA path inside the container and Aiven's IP allow-list.
