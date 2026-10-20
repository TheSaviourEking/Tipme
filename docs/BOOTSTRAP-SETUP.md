# Bootstrap setup (PR-001/002)

This supplements the original setup instructions without replacing governance. Use Node **24.22.0** and pnpm **10.33.0**. `.nvmrc`, `.node-version`, `engines`, and `packageManager` pin them. `engine-strict` rejects the wrong runtime. No API keys, `.env` files, database schema, ORM or payment services are required to boot these shells.

```sh
nvm install
nvm use
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm dev
```

If Node was installed without Corepack, install Corepack using its official setup instructions before `corepack enable`. The package manager must be available before CI's Node cache setup; the workflow uses `pnpm/action-setup` for this reason.

Web: http://localhost:3000 (it binds to 127.0.0.1; browse with the same host name as `WEB_ORIGIN`, because the API accepts browser calls only from that exact origin). API liveness: http://127.0.0.1:4000/health. Both bind to loopback by default. Checkout routes exist since PR-007 (ADR-0008). Liveness says only that the process can respond, not that databases or payment services are ready. The worker emits structured startup/heartbeat/shutdown events to stdout and handles SIGTERM/SIGINT; it has no jobs or queue connection yet.

Since PR-004 the API and worker read the root `.env` with Node's `--env-file-if-exists` and refuse to start, naming the variable, when a setting is missing or invalid. Run `cp .env.example .env` once; the example holds local-only values. Next follows its normal `.env.local` convention. Do not insert real secrets into examples.

PR-004 adds a local trace viewer: `pnpm infra:up` also starts Jaeger (UI http://127.0.0.1:16686). With `pnpm dev` running, `pnpm trace:demo` sends a harmless diagnostic request through the API and worker and prints its trace link. See [find a trace](runbooks/find-a-trace.md).

## Local infrastructure

Start Docker Desktop/Engine first, then:

```sh
pnpm infra:up
docker compose ps
docker compose exec postgres pg_isready -U tipme_local -d tipme_local
docker compose exec redis redis-cli ping
pnpm infra:down
```

Compose binds both services to loopback and uses named volumes. `infra:down` retains data; never add `--volumes` unless you intentionally want to erase local data. Credentials in Compose are public development-only defaults. Image major tags are inherited from the kit, so patch updates can occur; these are local infrastructure, not production deployment pins.

`db:migrate` and `db:seed` deliberately fail with an explanation until ADR-0002 selects an ORM. Application shells do not connect to Postgres/Redis yet. No migration is run during setup, tests or CI.

## Commands and boundaries

- `pnpm dev`: all three long-running processes through Turbo; Ctrl-C stops them.
- `pnpm build`: shared packages first, then production app outputs.
- `pnpm typecheck`: shared dependencies built before consumers; web generates route types itself.
- `pnpm test`: builds and runs real HTTP API and worker-process tests using Node's test runner.
- `pnpm test:e2e`: builds the stack (web with `NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:4100`), resets and seeds `tipme_test`, starts web (3100), API (4100) and worker with test-only secrets (never `.env`), then checks desktop/mobile behaviour, guest checkout and accessibility in Chromium.
- `pnpm perf:lab`: after `pnpm test:e2e`, a throttled lab LCP sample (4× CPU, ~1.6 Mbps, 150 ms) for `/@tobi` and `/tip/<id>`. Lab only.
- `pnpm lint`: governance presence check followed by package linting.
- `pnpm format:check`: validates new source/config/docs while preserving original governance formatting.

The web shell is deliberately noindex and uses system fonts; domain/canonical profile metadata is deferred to PR-003. No remote font, analytics or payment scripts are loaded. The supplied CI template is retained for reference and has its execution trigger disabled; `ci.yml` is the active workflow.

## Database (PR-005)

After `pnpm infra:up`, run `pnpm db:migrate` and `pnpm db:seed` (fictional Ada and Tobi). Both refuse any non-local `DATABASE_URL`. The worker now needs `DATABASE_URL` (already in `.env.example`) because it relays committed outbox events to the job queue. Integration tests create and migrate a separate `tipme_test` database automatically. See ADR-0002 and ADR-0006.

## Mock payment provider (PR-006)

No real provider or money. With `pnpm infra:up`, `pnpm db:migrate`, `pnpm db:seed` and `pnpm dev` running, play a scenario:

```sh
pnpm mock:pay --scenario succeed        # also: decline, pending-then-succeed, duplicate, out-of-order,
                                        # wrong-amount, no-reply, forged, payout-paid, payout-failed
```

It prints the tip's status, the provider evidence and a trace link. `no-reply` is resolved by the worker's background check after about 2–3 minutes. `.env` needs `MOCK_PROVIDER_WEBHOOK_SECRET` (see `.env.example`) and `NODE_ENV=development`; the API refuses to start without `NODE_ENV`, because an unset value counts as production, where the mock is refused. See ADR-0007 and [the stuck-payment runbook](runbooks/payment-stuck-unknown.md).

## Guest checkout (PR-007)

`pnpm dev`, then open `WEB_ORIGIN` (default `http://localhost:3000`) — the API only accepts browser calls from that exact origin, so browse to the same host name. `.env` needs `STATUS_TOKEN_SECRET` (≥ 32 characters) and `NEXT_PUBLIC_API_ORIGIN` (default `http://localhost:4000`). On `/@ada` choose an amount, see the fee breakdown, tap Tip, pick an outcome on the pretend provider page, and the status screen shows what the server verified. Pretend payments only. See ADR-0008.

## Recipient accounts (PR-008)

- **Settings.** `.env` needs these (see `.env.example`; local values were generated and never printed):
  - `AUTH_CODE_SECRET` (at least 32 characters);
  - `WEB_REVALIDATE_SECRET` (the same value for the API and the web app);
  - `MESSAGING_PROVIDER=mock`;
  - optionally `REWARD_CASH_BUDGET_MINOR_PER_MONTH` for the worker.
  - The web app reads `WEB_REVALIDATE_SECRET` and `API_INTERNAL_ORIGIN` (the API as reached from the web server) from its own environment.
- **Sign in or sign up.** Open `/sign-up` or `/sign-in` and enter a phone number. The 6-digit code is in the **pretend inbox** at `/dev/inbox`; nothing is really sent until a messaging provider is approved.
- **Demo recipients:** Ada (`0800 000 0001`) and Tobi (`0800 000 0002`).
- **Weekly report:** `POST http://127.0.0.1:4000/v1/dev/jobs/weekly-report` (optionally `{"isoWeek":"2026-W42","handle":"tobi"}`) builds it now instead of waiting for Monday 07:00 in Lagos.
- **Pretend money:** withdrawals, cash rewards and fee-free tips are pretend. See ADR-0003, ADR-0009 and the [sign-in runbook](runbooks/sign-in-problems.md).

## Admin area (PR-009)

- **Settings.** The API needs `OPS_TOTP_KEY` (32 random bytes, base64; it seals staff authenticator secrets). The local `.env` has a generated value, never printed. Optional settings:
  - `ANALYTICS_ENABLED` (unset: on in development and test, off in production until D-07);
  - `RATE_LIMIT_ANALYTICS_PER_MIN` (default 120);
  - `OPS_TRACE_URL_TEMPLATE` (default: local Jaeger outside production).
- **Become the Owner:**
  1. Run `pnpm ops:grant-owner --phone 0800 000 0002` (any number). It prints a one-time enrolment code, valid 30 minutes.
  2. Open `/ops`, sign in with that number, enter the enrolment code and scan the QR code with an authenticator app.
- **Pages:**
  - Overview (health this week against last week);
  - Issues (the inbox, with evidence and actions);
  - Visibility (how visitors arrive);
  - Market (outside observations entered by hand);
  - Audit log;
  - Staff & roles.
- **What admin can't do:** admin never moves money, and every action needs a reason and is audited. See ADR-0010 and the [issues inbox runbook](runbooks/issues-inbox.md).

## Staging and release (PR-010)

- **Local copy of staging:** `pnpm staging:local:up` runs the same staging setup on this machine at `https://staging.localhost:8443` (web) and `https://api.staging.localhost:8443` (API), with a local certificate. It needs Docker. Secrets are generated into `deploy/local/staging.local.env` (git-ignored, never printed).
- **Release-check staff:** `node scripts/staging-local.mjs release-staff` grants and enrols it.
- **The check:** `node scripts/staging-local.mjs check` (read-only) or `check full`.
- **Drills:** `node scripts/rollback-drill.mjs <tag>` runs the rollback drill. `pnpm staging:local:down` stops everything.
- **The real staging server and Vercel:** [staging setup](runbooks/staging-setup.md), [deploy and rollback](runbooks/deploy-and-rollback.md), [backup and restore](runbooks/backup-and-restore.md), [release day](runbooks/release-day.md). See also ADR-0011.
