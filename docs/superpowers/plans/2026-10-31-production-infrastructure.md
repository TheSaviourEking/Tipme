# Production Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run TipMe production from `main` on the staging server: one shared edge Caddy, three API copies and two workers on Aiven, blue/green deploys with no dropped requests, a hand-run `deploy-production` workflow gated on staging's full check, and a production watcher.

**Architecture:** Three Docker Compose projects (`tipme-edge`, `tipme-staging`, `tipme-production`) joined only through two external networks (`edge-staging`, `edge-production`). The edge Caddy finds production copies by DNS (`prod-api` alias) and sends traffic only to copies whose `/health/ready` passes; a stopping copy fails readiness first, then drains. `deploy-production.sh` starts the idle colour on the new version, waits for it, stops the old colour, then replaces workers one at a time.

**Tech Stack:** Bash deploy scripts tested with fake `docker`/`curl` (`node:test`), Docker Compose, Caddy 2 (dynamic `a` upstreams, active health checks), GitHub Actions (`workflow_dispatch`, `production` environment), NestJS config (zod), k6 for the rehearsal.

**Spec:** `docs/superpowers/specs/2026-10-31-production-launch-design.md` (payments parts: `2026-10-31-live-pilot-design.md`, planned separately in `2026-10-31-live-payments.md`).

## Global Constraints

- Hosts: web `https://usetipme.xyz` (Vercel), API `https://api.usetipme.xyz`; staging API stays `api.staging.usetipme.xyz`.
- Production compose project name `tipme-production`; edge project `tipme-edge`; external networks `edge-staging`, `edge-production`; API network alias `prod-api`; colours `api-blue`, `api-green`, 3 copies each; workers ×2.
- Edge: round-robin; active health check `GET /health/ready` every 2 s; `lb_try_duration 5s`; Let's Encrypt; staging's security headers; no preview password on production.
- `TRUST_PROXY_HOPS=1` in production. API copy memory limit about 384 MB.
- Production env file `/srv/tipme-production/production.env`, mode 600, owned by the production deploy user; every secret fresh, nothing copied from staging. Production gets its own deploy user and SSH key (owner, Q10).
- No volume, network, env file or secret shared between staging and production.
- Migrations additive and backward-compatible (AGENTS.md); deploy order: `db-roles` → migrate (as migrator, `MIGRATE_BACKUP_DONE=1` because Aiven backs up continuously) → `db-roles` again → switch.
- Commit status `release/staging-full` with description `tree <sha>` (mirrors `ci/tested-tree` in `scripts/ci-reuse.mjs`).
- `deploy-production` only by `workflow_dispatch` from `main`, GitHub environment `production` with owner approval. A merge to `main` never deploys production.
- Workflow files must be identical on `dev` and `main`.
- Production watcher every 5 minutes, Slack through `ALERT_WEBHOOK_URL`.
- Production config refuses: mock or sandbox providers, a preview password, a database without a checked certificate, pretend mail domains, `RELEASE_KIND=test`.
- Never echo env-file values in scripts, logs or test output.

## Review Focus

- **Readiness with a slow database:** if Aiven is slow, all copies may fail `/health/ready` at once and Caddy would have no upstream. Expected: the edge answers 503 fast (not hang), and a deploy's health wait fails and leaves the old colour serving. Test in Task 5 (`an unhealthy new colour leaves the old one serving and stops the new one`).
- **A deploy started while another is running** (two dispatches, or a retry). Expected: the second waits on a lock or refuses; colours are never both stopped. Test in Task 5 (`a second deploy while one runs is refused`).
- **First production deploy** (no current colour, no `colours` state file). Expected: blue starts, nothing is stopped, state records `active=blue`. Test in Task 5.
- **Staging deploy after the edge move:** staging's compose no longer has `caddy`; rolling staging back to a version whose files still define `caddy` would start a second Caddy that fights for ports 80/443. Expected: `app_services` never starts `caddy` once the edge exists. Test in Task 3.
- **SIGTERM during a long request** (a photo upload). Expected: readiness flips to 503 at once, the request still finishes within the drain window. Test in Task 2.

---

### Task 1: Production config refusals (API and worker)

**Files:**

- Modify: `apps/api/src/config.ts` (`superRefine`, after the R2 check)
- Modify: `apps/worker/src/config.ts` (same rules)
- Test: `apps/api/test/config.test.mjs`, `apps/worker/test/config.test.mjs`

**Interfaces:**

- Produces: `isProductionCopy(config): boolean` = `DEPLOYMENT_MODE === 'production' && NODE_ENV === 'production'`, exported from `packages/observability` next to `parseConfig` (the payments plan reuses it).

- [ ] **Step 1: Write the failing tests** (both apps; a `production` base object with every required setting, `DATABASE_URL` on a remote host with `sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem`)

```js
test('production refuses a preview password', () => {
  assert.throws(
    () => loadApiConfig({ ...production, PREVIEW_PASSWORD: 'x'.repeat(32) }),
    /PREVIEW_PASSWORD/,
  );
});
test('production refuses pretend mail domains', () => {
  assert.throws(
    () =>
      loadApiConfig({
        ...production,
        MAIL_PRETEND_DOMAINS: 'release-check.usetipme.xyz',
      }),
    /MAIL_PRETEND_DOMAINS/,
  );
});
test('production refuses RELEASE_KIND=test and a release-check token', () => {
  assert.throws(
    () => loadApiConfig({ ...production, RELEASE_KIND: 'test' }),
    /RELEASE_KIND/,
  );
  assert.throws(
    () => loadApiConfig({ ...production, RELEASE_CHECK_TOKEN: 'x'.repeat(32) }),
    /RELEASE_CHECK_TOKEN/,
  );
});
test('the production base itself loads', () => {
  assert.equal(loadApiConfig(production).DEPLOYMENT_MODE, 'production');
});
```

Worker test: the same three refusals where the worker reads the setting (`MAIL_PRETEND_DOMAINS`, `RELEASE_KIND`).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @tipme/api build && node --test apps/api/test/config.test.mjs` (and the worker's)
Expected: the new refusal tests FAIL (config loads); the base test passes.

- [ ] **Step 3: Implement** the refusals in each `superRefine`, guarded by `isProductionCopy(config)`; messages name the setting only, never its value.

- [ ] **Step 4: Run to verify they pass** (same commands). Expected: PASS, whole files green.

- [ ] **Step 5: Commit** `feat(config): refuse preview, pretend and test settings on a production copy`

---

### Task 2: Drain before shutdown

**Files:**

- Modify: `apps/api/src/main.ts`, `apps/api/src/health/health.controller.ts` (and its service), `apps/api/src/config.ts`
- Test: `apps/api/test/readiness.test.mjs`

**Interfaces:**

- Produces: config `SHUTDOWN_DRAIN_MS` (int, 0–30000, default `5000`); `HealthService.startDraining(): void`; while draining, `GET /health/ready` answers 503 with `{ status: 'draining' }` and `/health/live` stays 200.

- [ ] **Step 1: Write the failing tests**

```js
test('after SIGTERM readiness answers 503 draining at once, liveness stays 200', async (t) => {
  /* boot app with SHUTDOWN_DRAIN_MS=300, call the exported stop(), then GET /health/ready → 503 { status: 'draining' }, /health/live → 200 */
});
test('a request in flight when draining starts still completes', async (t) => {
  /* slow test route or a held upload; start it, trigger stop, assert 200 */
});
test('the app closes after the drain window', async (t) => {
  /* stop() resolves after ≥ 300 ms and the port is closed */
});
```

Export `stop` from a new `apps/api/src/shutdown.ts` (`createShutdown(app, health, drainMs): () => Promise<void>`) so the test can call it without signals.

- [ ] **Step 2: Run to verify they fail.** Run: `pnpm --filter @tipme/api build && node --test apps/api/test/readiness.test.mjs`. Expected: FAIL (`createShutdown` not exported).

- [ ] **Step 3: Implement `createShutdown`:** `health.startDraining()`, wait `drainMs` (Caddy's 2 s checks see 503 and stop routing), then `app.close()` (Node finishes in-flight requests), then `shutdownTelemetry()`. `main.ts` uses it for SIGTERM and SIGINT.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(api): fail readiness and drain before closing on SIGTERM`

---

### Task 3: The edge Caddy, and staging moved behind it

**Files:**

- Create: `deploy/edge/Caddyfile`, `deploy/edge/compose.edge.yml`, `scripts/edge-caddy.test.mjs`
- Modify: `deploy/compose.staging.yml` (remove `caddy`; `api` joins external `edge-staging` with alias `staging-api`), `deploy/scripts/lib.sh` (`app_services` never lists `caddy`), `scripts/deploy-scripts.test.mjs`, `.github/workflows/ci.yml` (job `edge-config` running the new test), `docs/runbooks/staging.md` (one-off move step)
- Delete: `deploy/Caddyfile` (after the move; staging versions that still carry it are covered by the `app_services` change)

**Interfaces:**

- Produces: networks `edge-staging` and `edge-production` (external, created by `deploy/edge/setup-networks.sh`, idempotent); the edge reads `ACME_EMAIL`, `STAGING_API_HOST`, `PRODUCTION_API_HOST` from `/srv/tipme-edge/edge.env`.

Caddyfile, production site (directives fixed here; values from Global Constraints):

```caddyfile
{$PRODUCTION_API_HOST} {
	encode zstd gzip
	header { Strict-Transport-Security "max-age=31536000"; X-Content-Type-Options nosniff; -Server }
	reverse_proxy {
		dynamic a prod-api 4000 { refresh 2s }
		lb_policy round_robin
		lb_try_duration 5s
		lb_try_interval 250ms
		health_uri /health/ready
		health_interval 2s
		health_timeout 1s
		health_status 200
	}
}
```

The staging site is today's block with `reverse_proxy staging-api:4000 { health_uri /health/live }`.

- [ ] **Step 1: Write the failing tests**

`scripts/edge-caddy.test.mjs` (skips with a message when `docker` is absent; CI always has it): creates a throwaway network, starts two tiny upstream containers aliased `prod-api` (a 10-line Node server answering `/health/ready` 200 or 503 by a file flag, and `/who` with its name) and one aliased `staging-api`, and Caddy with the real Caddyfile on `http://` hosts (`auto_https off` via an env-selected global block for the test only).

```js
test('both hosts route to their own project', ...);           // Host: staging → staging-api; production → a prod-api
test('production spreads requests over every ready copy', ...); // 20 requests hit both copies
test('a copy failing readiness gets no traffic', ...);          // flip one to 503, wait 3 s, 20 requests all hit the other
test('a copy stopped mid-traffic costs no failed request', ...);// steady requests while `docker stop` one copy: 0 non-200
```

`scripts/deploy-scripts.test.mjs`:

```js
test('a staging version whose files still define caddy never starts it', () => {
  /* fake `config --services` includes caddy; deploy; assert no `up ... caddy` in calls.log */
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test scripts/edge-caddy.test.mjs scripts/deploy-scripts.test.mjs`. Expected: edge tests FAIL (no `deploy/edge/Caddyfile`); the caddy test FAILS (`caddy` started).

- [ ] **Step 3: Implement** the edge files, `setup-networks.sh`, the staging compose change, and `app_services` without `caddy`. Runbook step: create networks, start the edge (`docker compose -p tipme-edge -f compose.edge.yml up -d`) right after `docker compose -p tipme-staging stop caddy`; about a minute's notice; certificates move by mounting staging's existing `caddy_data` volume into the edge once, then the edge owns `tipme-edge_caddy_data`.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS; `docker run --rm -v $PWD/deploy/edge:/etc/caddy caddy:2 caddy validate --config /etc/caddy/Caddyfile` exits 0.

- [ ] **Step 5: Commit** `feat(deploy): one edge Caddy for staging and production`

---

### Task 4: Production compose and its settings

**Files:**

- Create: `deploy/compose.production.yml`, `deploy/production.env.example`
- Test: `scripts/production-compose.test.mjs`

**Interfaces:**

- Consumes: Task 1's refusals, Task 2's `SHUTDOWN_DRAIN_MS`, Task 3's networks.
- Produces: services `api-blue`, `api-green` (each `deploy.replicas: 3`, image `tipme-app:${TIPME_BLUE_VERSION}` / `${TIPME_GREEN_VERSION}`, network `edge-production` alias `prod-api`, plus `internal` and `egress`, `mem_limit: 384m`, `stop_grace_period: 20s`, healthcheck `/health/ready`), `worker-a`, `worker-b` (image `tipme-app:${TIPME_VERSION}`), `redis` (internal only, AOF on, named volume), tools under profile `tools`: `migrate`, `db-roles` (`node scripts/db-roles.js`, reads `DATABASE_ADMIN_URL`). The Aiven CA mounted read-only at `/run/secrets/db-ca.pem` from `${TIPME_HOME}/db-ca.pem` in every service that talks to Postgres. No `postgres`, `backup`, `retention` or `caddy` service. Fixed environment: `DEPLOYMENT_MODE=production`, `NODE_ENV=production`, `RELEASE_KIND=live`, `TRUST_PROXY_HOPS=1`, `HOST=0.0.0.0`, `SENTRY_ENVIRONMENT=production`, `POINT_IN_TIME_RECOVERY=off` (Aiven's, not ours).

- [ ] **Step 1: Write the failing tests** (parse with `docker compose config --format json` when docker exists, else the `yaml` package already in the repo)

```js
test('production passes every setting the API and worker read (no silent defaults)', ...); // mirror of the staging test: every key in apiConfigSchema/workerConfigSchema shape is set or deliberately defaulted (list them)
test('production has no database, backup, caddy or preview service and publishes no port', ...);
test('both colours carry the prod-api alias on edge-production only; redis is internal only', ...);
test('every Postgres client mounts the CA read-only and no service mounts a staging path', ...); // no '/srv/tipme/' (staging home) in any volume
test('production.env.example names every ${VAR} the compose file reads, with no values for secrets', ...);
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test scripts/production-compose.test.mjs`. Expected: FAIL (file missing).

- [ ] **Step 3: Write** `compose.production.yml` and `production.env.example` (grouped as spec §6.7's table; secrets blank with a `openssl rand` hint; `SITE_INDEXING` documented as a Vercel setting).

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(deploy): production compose on Aiven with two API colours`

---

### Task 5: Blue/green deploy and rollback scripts

**Files:**

- Modify: `deploy/scripts/lib.sh` (stack-aware: `TIPME_STACK=staging|production` picks `ENV_FILE`, compose file name, and default `TIPME_HOME` `/srv/tipme` or `/srv/tipme-production`; staging behaviour unchanged)
- Create: `deploy/scripts/deploy-production.sh`, `deploy/scripts/rollback-production.sh`
- Test: `scripts/deploy-production.test.mjs` (reuses the `stage()` fake-docker harness; extract it to `scripts/test-support/fake-server.mjs` and import it from both test files)

**Interfaces:**

- Consumes: Task 4's services.
- Produces: state file `$RELEASES/colours` with lines `blue=<version>`, `green=<version>`, `active=blue|green`; lock `$RELEASES/.deploy.lock` (`flock -n`); `deploy-production.sh <version>`; `rollback-production.sh` (to `version_before`).

Order inside `deploy-production.sh` (spec §6.5): `shipped` → `up -d --wait redis` → `run --rm db-roles` → `MIGRATE_CONFIRM_DATABASE=$(setting MIGRATE_CONFIRM_DATABASE) MIGRATE_BACKUP_DONE=1 run --rm migrate` → `run --rm db-roles` → idle colour `up -d --wait --no-deps api-<idle>` with `TIPME_<IDLE>_VERSION=<version>` (the active colour's variable keeps its version) → `wait_healthy` against the public host until `/health/release` shows the version → `stop -t 20 api-<active>` → `up -d --wait --no-deps worker-a`, then `worker-b` → record, `set_current`, `prune_versions` (never prunes either colour's version).

- [ ] **Step 1: Write the failing tests**

```js
test('first deploy starts blue ×3, stops nothing, records active=blue', ...);
test('roles, then migrations with the backup flag and database named, then roles, all before any colour starts', ...);
test('the idle colour starts on the new version, the old colour stops only after it is healthy', ...); // order in calls.log
test('workers are replaced one at a time after the switch', ...);
test('an unhealthy new colour leaves the old one serving and stops the new one', ...); // FAKE_BROKEN; exit 1; active unchanged; `stop api-green` logged
test('rollback starts the previous version on the idle colour and switches back', ...);
test('a second deploy while one runs is refused', ...); // hold the lock
test('a version that was never shipped is refused before anything runs', ...);
test('redis is never restarted by a deploy', ...); // no `up` without --no-deps that names redis after the first deploy, no `restart redis`
test('staging deploys are unchanged', ...); // existing deploy-scripts tests still pass on the extracted harness
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test scripts/deploy-production.test.mjs scripts/deploy-scripts.test.mjs`. Expected: production tests FAIL (script missing); staging tests PASS.

- [ ] **Step 3: Implement** the lib changes and both scripts. Production `preflight` checks the CA file exists and the three role passwords are present and distinct (names only in messages).

- [ ] **Step 4: Run to verify they pass.** Expected: PASS, both files.

- [ ] **Step 5: Commit** `feat(deploy): blue/green production deploys and rollback`

---

### Task 6: The staging-tree gate

**Files:**

- Create: `scripts/staging-pass.mjs`, `scripts/staging-pass.test.mjs`
- Modify: `.github/workflows/deploy-staging.yml` (after a `--full` release check passes: `node scripts/staging-pass.mjs record`; the read-only fallback records nothing)

**Interfaces:**

- Produces: `STAGING_CONTEXT = 'release/staging-full'`; `stagingPassed(tree, statuses): boolean` (newest `release/staging-full` status is `success` with description `tree <tree>`); CLI `record` (records GITHUB_SHA's tree as a status on GITHUB_SHA) and `check <sha> [--staging-version <sha>]` (exit 0 when one of the candidates below carries a passing status for `<sha>`'s tree; else exit 1 printing `Tree <tree> has no full staging pass.`).

`check` looks at: the `main` commit itself, its parents, and the PR heads of the merge (as `candidateHeads` in `ci-reuse.mjs`), plus the `dev` commit staging deployed (`/health/release` version of staging, passed as `--staging-version`). Reuse `ci-reuse.mjs`'s `gh` helper by exporting it.

- [ ] **Step 1: Write the failing tests**

```js
test('a success with the same tree passes', () => assert.equal(stagingPassed(T, [{ context: 'release/staging-full', state: 'success', description: `tree ${T}` }]), true));
test('a newer failure hides an older success', ...);
test('another tree, another context, or a malformed sha does not pass', ...);
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test scripts/staging-pass.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `staging-pass.mjs` and the staging workflow step (needs `statuses: write`, already granted to that job by #65).

- [ ] **Step 4: Run to verify they pass**, plus `docker run --rm -v $PWD:/repo -w /repo rhysd/actionlint:1.7.7`. Expected: PASS, actionlint clean.

- [ ] **Step 5: Commit** `feat(ci): record staging's full pass by file tree`

---

### Task 7: The `deploy-production` workflow and the read-only check on a live copy

**Files:**

- Create: `.github/workflows/deploy-production.yml`, `scripts/ship-production.sh`
- Modify: `scripts/release-check.mjs` (a live copy runs the read-only check; `--full` refused), its tests (`scripts/release-check.test.mjs`; create if absent, driving the script against a stub `/health/release` server)
- Test: `scripts/ship-production.test.mjs` (as `ship-staging.test.mjs`)

**Interfaces:**

- Consumes: Task 5's scripts, Task 6's `check`.
- Produces: workflow inputs `override_reason` (string, optional); repository variables `PRODUCTION_SSH`, `PRODUCTION_WEB_URL`, `PRODUCTION_API_URL`; secret `PRODUCTION_SSH_KEY` in environment `production`. `ship-production.sh <version>` tars `compose.production.yml scripts` into `/srv/tipme-production/releases/<version>/`, `docker save | ssh docker load`, runs `deploy-production.sh`.

Workflow: `on: workflow_dispatch`; refuses unless `github.ref == 'refs/heads/main'`; job `gate` runs `staging-pass.mjs check` (an override needs a non-empty `override_reason`, written to the job summary); job `deploy` with `environment: production` (owner approval) builds the image once, ships, deploys, then `pnpm release:check --web $PRODUCTION_WEB_URL --api $PRODUCTION_API_URL --expect-version $VERSION` (never `--full`); Slack notify as staging does; `concurrency: deploy-production` without cancel.

Release check change: replace `if (info.paymentsLive) stop(...)` with: live → `--full` refused with the message `--full refused: this copy takes real payments.`; read-only runs and also asserts `paymentProvider` equals `--expect-provider` when given, and that `POST /v1/webhooks/bachs` unsigned answers 401.

- [ ] **Step 1: Write the failing tests**

```js
test('a live copy runs the read-only check', ...);         // stub reports paymentsLive: true → exit 0, read-only suite started (RELEASE_FULL=0)
test('a live copy refuses --full', ...);                   // exit 1, message above
test('an unexpected provider fails the check', ...);       // --expect-provider bachs-live vs stub bachs-sandbox → exit 1
test('ship-production copies only production files to the production home', ...);
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test scripts/release-check.test.mjs scripts/ship-production.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** the workflow, ship script and release-check change.

- [ ] **Step 4: Run to verify they pass** and actionlint. Expected: PASS, clean.

- [ ] **Step 5: Commit** `feat(ci): hand-run production deploys gated on staging`

---

### Task 8: Production watcher

**Files:**

- Create: `.github/workflows/watch-production.yml`, `scripts/watch-production.mjs`, `scripts/watch-production.test.mjs`

**Interfaces:**

- Consumes: `/health/ready`, `/health/release` (`paymentsLive`, `paymentProvider`), and, once the payments plan ships, `/health/payments` `{ reserveLow: boolean }` (a 404 there is reported as "reserve not watched yet", not a failure).
- Produces: `checkProduction({ web, api, expectLive, fetchImpl }): Promise<string[]>` (problems; empty when healthy).

Checks: API ready; web `GET /` 200; `paymentsLive === expectLive` (from repository variable `PRODUCTION_PAYMENTS_LIVE`, `true|false`); `reserveLow` false; `POST /v1/webhooks/bachs` unsigned → 401. Any problem: post `{"text": ...}` to `ALERT_WEBHOOK_URL` and exit 1. Cron `*/5 * * * *`; job `if: vars.PRODUCTION_API_URL != ''`.

- [ ] **Step 1: Write the failing tests** (stub fetch)

```js
test('a healthy production reports nothing', ...);
test('payments live not matching the activation state is a problem', ...);
test('a low reserve is a problem; a missing reserve endpoint is not', ...);
test('a webhook endpoint that accepts unsigned calls is a problem', ...);
test('an API that does not answer within 10 s is a problem, not a hang', ...);
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test scripts/watch-production.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.** External uptime ping on `/health/live` is a runbook step (Task 9), no code.

- [ ] **Step 4: Run to verify they pass** and actionlint. Expected: PASS.

- [ ] **Step 5: Commit** `feat(ops): watch production every five minutes`

---

### Task 9: Local rehearsal with load, and the production runbook

**Files:**

- Create: `scripts/rehearse-production.sh`, `deploy/local/compose.production-rehearsal.yml` (adds a Postgres 16 container with a throwaway CA and server certificate, so `verify-full` is exercised; overrides `DATABASE_*` URLs to it; edge on `http://` local hosts), `tests/load/no-downtime.k6.js`, `docs/runbooks/production.md`
- Modify: `docs/agent/HANDOFF.md` (production section)

**Interfaces:**

- Consumes: everything above.

`rehearse-production.sh`: builds `tipme-app:<A>` and `tipme-app:<B>` (B = A with a trivial label so versions differ), creates networks, starts the edge, deploys A with `deploy-production.sh` (`TIPME_HOME` in a temp dir, real docker), starts k6 (`grafana/k6` container on `edge-production`'s host) at 30 requests/s for 90 s against `GET /health/ready` and a public profile read, deploys B during the run, then rolls back to A during the run. Passes only if k6 reports `http_req_failed` rate `0` and both version switches show in `/health/release`.

`docs/runbooks/production.md`: server setup (user `tipme-prod`, its own SSH key in the `production` environment, `/srv/tipme-production` mode 700, `production.env` mode 600, the CA file; note that Docker group membership on one machine is root-equivalent, accepted for now); the edge move (Task 3); Aiven setup (roles via `db-roles`, CA download, plan per Q8); restore drill (fork the latest backup, open it, compare row counts of `profiles`, `tips`, `ledger_entries`, delete the fork, record date and result here); external uptime ping on `/health/live`; deploy, rollback and override procedure; launch-day steps 1–6 from spec §6.11, pointing to the live-payments activation runbook for steps 4–5.

- [ ] **Step 1: Write the load script** with threshold `http_req_failed: ['rate==0']`.
- [ ] **Step 2: Run the rehearsal before Task 2's drain is in the image** (check out its parent for image A and B) to confirm it can fail. Expected: k6 threshold FAILS (dropped requests on the switch). If it does not fail, raise the rate until it does and record the rate in the runbook.
- [ ] **Step 3: Run it on this branch.** Run: `scripts/rehearse-production.sh`. Expected: `http_req_failed ... 0.00%`, both switches seen, exit 0. Paste the k6 summary into the PR.
- [ ] **Step 4: Write the runbook and handoff section.**
- [ ] **Step 5: Commit** `docs(ops): production runbook and a no-downtime rehearsal`

---

## Owner actions this plan needs (not code)

Create the `tipme-prod` user, SSH key and `production` environment with required reviewer; repository variables and secrets in Task 7–8; Aiven database, roles and CA; DNS for `api.usetipme.xyz` to the server; DMARC fixed to one record; the edge move window.
