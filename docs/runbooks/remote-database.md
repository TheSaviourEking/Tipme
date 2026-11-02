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

## The connection budget

Every API copy and worker works out its own pool from the server's limit. There is nothing to size by hand, and a plan change needs no deploy.

**The rule** (`planBudget`, `packages/database/src/connection-budget.ts`):

```text
usable = max_connections - reserved - margin
         (and no more than the role's or database's own CONNECTION LIMIT)
unit   = usable / (api_processes x 1 + worker_processes x 2)
API pool    = floor(unit)     clamped to 1..10
worker pool = floor(unit x 2) clamped to 1..4
```

- `reserved` is read from the server: `superuser_reserved_connections` plus `reserved_connections` where the version has it.
- `margin` is `DATABASE_BUDGET_MARGIN`, default 7: Aiven's own sessions (5 measured, 2 November 2026, an assumption until `backend_type` is checked, below) and 2 for one-off tasks.
- `api_processes` and `worker_processes` are stated in Compose for the worst moment, not guessed: production says 6 (both colours, 3 copies each) and 2. `scripts/production-compose.test.mjs` fails if they stop matching the replicas.

| `max_connections` | usable | API pool | worker pool | steady (3 copies) | mid-deploy (6 copies) | fits?                             |
| ----------------- | ------ | -------- | ----------- | ----------------- | --------------------- | --------------------------------- |
| 15                | 5      | 1        | 1           | 5                 | 8                     | **No: over by 3 during a deploy** |
| 20                | 10     | 1        | 2           | 7                 | 10                    | Yes                               |
| 50                | 40     | 4        | 4           | 20                | 32                    | Yes                               |
| 100               | 90     | 9        | 4           | 35                | 62                    | Yes                               |

These assume 3 reserved. Aiven says some services reserve 6; the server's own setting decides.

### Every source of connections in production

| Source                                                                | Role             | Connections     | When                                                             |
| --------------------------------------------------------------------- | ---------------- | --------------- | ---------------------------------------------------------------- |
| API copies, serving colour                                            | `tipme_runtime`  | 3 x API pool    | always                                                           |
| API copies, other colour                                              | `tipme_runtime`  | 3 x API pool    | a deploy or rollback only                                        |
| `worker-a`, `worker-b`                                                | `tipme_runtime`  | 2 x worker pool | always; replaced one at a time, so never 3                       |
| `db-roles`                                                            | Aiven's admin    | 1               | deploy, before and after migrating, before the new colour starts |
| `migrate`                                                             | `tipme_migrator` | 1               | deploy, before the new colour starts                             |
| `ops:grant-owner`, `set-email`, `move-photos-to-r2` and other scripts | as run           | 1 each          | by hand: from the margin                                         |
| A person's `psql`, Aiven's console                                    | as run           | 1 each          | by hand: from the margin                                         |
| Aiven's own sessions                                                  | `postgres`       | 5 measured      | always: from the margin                                          |
| Web app on Vercel                                                     | none             | 0               | talks to the API; `apps/web` has no database client              |
| Release check, `watch-production`                                     | none             | 0               | HTTP only                                                        |
| Staging                                                               | its own Postgres | 0 here          | not on Aiven                                                     |

**How long both colours run.** `start_idle_colour` waits for all three new copies to pass their 10 s health check, then for the public API to answer with the new version, then `switch_to_idle` stops the old colour, which drains for 7 s and closes in up to 10 s more. So about 25 to 40 s in a good deploy. A new colour that never becomes healthy can keep both up for about 2 minutes (12 tries at 10 s) before it is stopped. This is read from the scripts, not timed in production.

### If the limit changes, or the server is full

- **A plan change:** each process reads the limit at startup and every minute (`DATABASE_BUDGET_REFRESH_MS`) and resizes with no restart. node-postgres reads `max` each time it opens a connection, so going up is immediate; going down closes the extras as they free up.
- **Refused (SQLSTATE 53300):** the process halves its pool for 60 s (never below the minimum) and stops trying new connections for 0.5 s, doubling to 8 s. Open connections keep working. Those requests get a 503 before any work starts.
- **The read fails:** the process starts on a pool of 1, logs `database.budget_read_failed`, and tries again next minute. It never refuses to start.
- **An emergency:** `DATABASE_POOL_MAX` (API) and `WORKER_DATABASE_POOL_MAX` override the computed size. Deploying the same version applies them.

### Under a surge, what happens first

1. Requests queue inside a copy for a free connection. Pages get slower.
2. After `DATABASE_POOL_CONNECT_TIMEOUT_MS` (5 s) a request gets a 503 `DEPENDENCY_UNAVAILABLE`, logged with `cause: pool_wait_timeout`. It waited before touching anything, so nothing is half done, and a retry with the same `Idempotency-Key` is safe.
3. Signed-in reads retry once by themselves (`apiFetch`). Writes never do.
4. Readiness stays up while a copy is busy, so the edge doesn't take copies out and pile the traffic on the others. It goes down only when connections stop coming back for 15 s or a new one can't be made.

Workers are separate: their jobs wait or retry, and money waits in Postgres.

### Checking it

Read-only, as any role. Only `backend_type` can tell background processes from hidden sessions: blank user names alone can't.

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SELECT backend_type, usename, state, count(*)
  FROM pg_stat_activity GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

- Client sessions compete for slots (`backend_type = 'client backend'`). Background processes (`walwriter`, `checkpointer`, `autovacuum launcher` and so on) don't. If Aiven's client sessions are not 5, change `DATABASE_BUDGET_MARGIN`.
- At steady state expect `tipme_runtime` to show the "steady" column, or fewer. Readiness keeps one connection open per copy.
- Staff can read one copy's view at `GET /v1/ops/database-budget`: the limit, its share, current use, and whether it was cut after a refusal.
- Each process logs `database.budget` at startup and whenever a number changes, and warns if the minimum pools don't fit (`overcommitted: true`).
- To tell one 503 from another, search the API log for `http.dependency_unavailable`, or Sentry for its `PersistenceError` title. `cause` is `sqlstate` (with `sql_state`), `pool_wait_timeout`, `connect_timeout`, `connection_lost`, `network` (with `errno`) or `unknown`. A worker's `job.failed` has `db_failure` and `sql_state`. A 53300 can be the process's own back-off repeating the server's answer, so count `database.budget_refused` for real refusals.

### Why no PgBouncer now, and what transaction mode would break

We connect directly. If PgBouncer is added later in transaction mode, each transaction may run on a different server connection, so:

- **Safe:** `pg_advisory_xact_lock` and `SET LOCAL`, the only forms in the code. They end with their transaction.
- **Breaks:** any session `SET`, session advisory lock, `LISTEN`/`NOTIFY` or named prepared statement. None exist today, and new code must not add them.
- **Migrations and `db-roles`** should keep connecting directly.
- **The budget's read** would see PgBouncer's view through a pooled connection, so `max_connections` would no longer describe what the clients share. Set `DATABASE_POOL_MAX` explicitly, or rework the rule.

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
