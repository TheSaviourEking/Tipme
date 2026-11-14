# Settings and switches

Owner's request, 14 Nov 2026: feature switches such as `PAGE_STUDIO_ENABLED` are set by staff in admin, the way
payment and email providers already are, and the system needs fewer environment variables.

This page is the audit of every environment variable the API, the worker and the web app read (from
`apps/api/src/config.ts`, `apps/worker/src/config.ts`, the shared shapes in `packages/payments`, `packages/mail`
and `packages/contracts`, the web app's `process.env` reads, `deploy/*.env.example` and `deploy/compose.*.yml`),
and what happens to each.

## Classes

- **Secret** (keys, tokens, passwords, signing secrets): stays in the environment. A database is the wrong place
  for a credential, and admin must never show one.
- **Infrastructure** (addresses, hosts, database and Redis, ports, origins, process counts, versions, logging):
  stays in the environment. It describes the machine, is needed before the database can be read, or differs per
  copy or per process.
- **Safety gate**: stays in the environment unless moving it is clearly safe. Each says why below.
- **Product switch** (a feature on or off): **moves to admin** (`/ops/switches`).
- **Tunable** (limits, rates, lists): moves to admin where safe. None moved in this change; see the owner
  questions.

Where: **A** API, **W** worker, **Web** the web app (Vercel), **P** production deploy files, **S** staging deploy
files.

## Product switches: moved to admin

Each is now a row in `feature_switches`, read through `featureOn(db, key)` (cached for 15 seconds in each process,
cleared at once in the process that changed it and, while live updates are on, in every API copy). A **money**
switch is a serious action (`feature_switch.set`: a reason, a fresh code and a second person when one exists); any
other needs a reason and a fresh code. Every change is in the audit log and the switch's own history.

| Variable                  | Switch key              | Money | Default | What it does                                                                                         | Where   |
| ------------------------- | ----------------------- | ----- | ------- | ---------------------------------------------------------------------------------------------------- | ------- |
| `PRO_BILLING_ENABLED`     | `pro_billing`           | yes   | off     | Recipients may buy a Pro month (live money also needs the live gates below)                          | A P S   |
| `PRO_PAY_FROM_BALANCE`    | `pro_pay_from_balance`  | yes   | off     | Pay for Pro from the TipMe balance (waits on the partner's answer, plan Q1)                          | A P S   |
| `PRO_REFUNDS`             | `pro_refunds`           | yes   | off     | Staff refunds of card-paid Pro months                                                                | A P S   |
| `PRO_AUTO_RENEW`          | `pro_auto_renew`        | yes   | off     | Auto-renew on a saved card: the offer (API) and the `pro.renew` sweep (worker), now one switch       | A W P S |
| `BUSINESS_SHARES_ENABLED` | `business_shares`       | yes   | off     | Business release 2 share agreements and a business's own balance; `tip.reverse` runs only with it on | A P S   |
| `TEAM_TIPS_ENABLED`       | `team_tips`             | yes   | off     | Tipping a whole business team (release 2). Treated as money: it splits a tip between people          | A P S   |
| `BUSINESS_ENABLED`        | `business`              | no    | off     | TipMe for businesses: every business route, and a tip's business member                              | A P S   |
| `ANALYTICS_ENABLED`       | `analytics`             | no    | on      | Anonymous, cookieless visit counts and server outcomes (owner, 9 Nov 2026; D-07 stays open)          | A W P S |
| `ADULT_PLATFORM_LINKS`    | `adult_platform_links`  | no    | on      | OnlyFans and Fansly links on Pro pages (`adult-platform-links.md`)                                   | A P S   |
| `SUPPORTER_RECOGNITION`   | `supporter_recognition` | no    | on      | The repeat supporters' tick box on Pro pages (`supporter-recognition.md`)                            | A P S   |

Registered for open pull requests, so they can read the switch instead of adding a variable:

| Variable              | Switch key          | Money | Default | Pull request                                                                                                                                      |
| --------------------- | ------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGE_STUDIO_ENABLED` | `page_studio`       | no    | off     | #210 `feat/page-studio-1` (declares the variable; nothing reads it yet)                                                                           |
| `REFUND_FEE_RETURN`   | `refund_fee_return` | yes   | off     | #193 `feat/business-r2-b`. Its variable defaults on with the pretend provider; the switch defaults off everywhere, as no money switch defaults on |

### Release day and after

1. **Nothing changes on deploy.** At start, each API and worker process writes any switch that has no row yet:
   from its old variable if that is set (`source: env`), otherwise from the code default (`source: default`). The
   first process to start wins, and the API and worker read the same values from the same file. The compose files
   still pass the old variables through for this one release, so the first start sees the server's current values.
2. **After that, the stored value wins.** A variable that is still set is ignored, and each start logs
   `feature_switch.env_ignored` naming it (never its value).
3. **Then delete the old lines** from `/srv/tipme/staging.env` and `/srv/tipme-production/production.env` once
   `/ops/switches` shows the expected values on that copy. The `.env.example` files no longer list them.
4. **Next release (follow-up):** remove the pass-through lines from `deploy/compose.*.yml` and the seed-only fields
   from the config schemas.

An unreadable switches table (an outage) never turns a feature on by itself: each process keeps the last value it
read, and before any read the code default, which is off for every money switch.

## Safety gates: stay in the environment

| Variable                                      | What it does                                            | Where     | Why it stays                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAYMENTS_LIVE_ENABLED`                       | Whether checkout takes real money (bachs-live only)     | A W P S   | The deploy script checks it together with `ALERT_WEBHOOK_URL` and compares it with what it was told to expect before any colour starts; the worker refuses to start live without the alert address. Moving it would take real money out of that check. |
| `PAYMENT_PROVIDER`                            | mock, bachs-sandbox or bachs-live                       | A W P S   | Chooses which credentials and adapter a process builds at start; production refuses mock and sandbox at start.                                                                                                                                         |
| `LIVE_CHECKOUT_HANDLES`                       | Who may take real tips while live payments are on       | A P       | Part of the live-money gate with `PAYMENTS_LIVE_ENABLED` (live-activation runbook). A tunable, but moving it needs the owner's word (question 3).                                                                                                      |
| `REWARD_CASH_BUDGET_MINOR_PER_MONTH`          | Monthly cash rewards budget                             | W P S     | Must be 0 in production until D-05; the worker refuses any other value at start.                                                                                                                                                                       |
| `DEPLOYMENT_MODE`, `RELEASE_KIND`, `NODE_ENV` | What this copy is (production, preview, test)           | A W Web S | Decide what is allowed at all (mock providers, diagnostics, rehearsal settings) before anything else is read.                                                                                                                                          |
| `POINT_IN_TIME_RECOVERY`                      | Whether this copy keeps its own WAL and base backups    | A S       | Describes the machine's backups; `/health/backups` and the watcher depend on it.                                                                                                                                                                       |
| `DIAGNOSTICS_ENABLED`                         | Development-only diagnostic routes                      | A P S     | Mounted at start, refused in production; not a product feature.                                                                                                                                                                                        |
| `MAIL_DEFAULT_PROVIDER`                       | Mail provider until staff choose one in Providers       | A W P S   | Already a fallback only: staff choose the provider in admin. The deploy refuses a missing value so production never mails a pretend inbox.                                                                                                             |
| `SITE_INDEXING`                               | Search engines may index this copy (Vercel)             | Web       | A staging copy must never be indexed; it is read while rendering metadata, before any API answer.                                                                                                                                                      |
| `NEXT_PUBLIC_PRETEND_DELIVERY`                | The pretend inbox and crash pages in a production build | Web       | Built into the web bundle; test copies only.                                                                                                                                                                                                           |
| `NEXT_PUBLIC_PREVIEW_GATE`                    | Sends credentials to the password-gated preview         | Web       | Built into the bundle; describes the preview gateway.                                                                                                                                                                                                  |

## Product switches that stay for now (owner questions)

| Variable               | What it does                                                           | Where | Why it stays                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVE_UPDATES_ENABLED` | Live updates over text/event-stream; off, the stream routes answer 204 | A P S | Wired at process start: it decides whether each API copy opens a Redis subscriber and takes stream slots. Switching it at run time means starting and stopping subscribers on every copy. Question 1. |
| `PILOT_NOTICE`         | "TipMe is in a pilot. Payments are real." on money pages (Vercel)      | Web   | Read by the web app from its own environment while rendering; the web app has no database. Moving it means the web reads it from the API on every money page. Question 2.                             |

## Tunables: stay for now

| Variable                                                                                                                                                                                                                                                                           | What it does                                                  | Where | Why it stays                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_*` (19: quotes, intents, handles, analytics, reports, unsubscribe, avatars, cover designs, QR art, QR thumbs, bank resolve, bank read, business public, business note, live connect, auth, ops code, ops request, ops read) and `RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR` | Per-address and per-person request limits                     | A P S | Abuse protection (sign-in codes, bank look-ups). Production sets none (all blank: code defaults). Tests, e2e and drills raise them per process through the environment. Question 4. |
| `PARTNER_QUOTE_CACHE_SECONDS`                                                                                                                                                                                                                                                      | How long a withdrawal quote's provider answer is reused       | A P S | Shares the provider's rate limit with payouts; a wrong value costs payouts. Question 4.                                                                                             |
| `LIVE_MAX_STREAMS`, `LIVE_HEARTBEAT_MS`                                                                                                                                                                                                                                            | Open streams per API process; the stream's heartbeat          | A P S | Per-process capacity, sized to the machine.                                                                                                                                         |
| `BACHS_RESERVE_ALERT_MINOR`                                                                                                                                                                                                                                                        | When the payment reserve counts as low                        | W P S | Money alerting; question 4.                                                                                                                                                         |
| `RECONCILE_INTERVAL_MS`, `RECONCILE_MIN_AGE_MS`                                                                                                                                                                                                                                    | How often and how late the worker asks about unconfirmed tips | W P S | Worker timing, read when its loops start.                                                                                                                                           |
| `SHUTDOWN_DRAIN_MS`                                                                                                                                                                                                                                                                | How long a stopping API copy drains                           | A P S | Tied to the edge's health-check timing.                                                                                                                                             |
| `BACKUP_RETAIN`, `BASE_BACKUPS`, `BASE_BACKUP_RETAIN`                                                                                                                                                                                                                              | Staging backups kept                                          | S     | Read by the backup loop, which has no admin.                                                                                                                                        |
| `PRODUCTION_LAUNCH_AT`                                                                                                                                                                                                                                                             | The coming-soon page's launch time (Vercel)                   | Web   | Read by the web app's proxy on every request, before any API answer. Question 2.                                                                                                    |
| `MAIL_FROM_DOMAIN`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO`                                                                                                                                                                                                         | Mail senders                                                  | W P S | Must match domains verified at the mail provider; a typo stops mail.                                                                                                                |

## Infrastructure: stays

| Variable                                                                                                                                                                                                         | What it does                                                 | Where       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------- |
| `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_ADMIN_URL`                                                                                                                                                   | Database roles (the URLs carry passwords: also secrets)      | A W P S     |
| `DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`, `DATABASE_POOL_CONNECT_TIMEOUT_MS`, `DATABASE_BUDGET_MARGIN`, `DATABASE_BUDGET_API_PROCESSES`, `DATABASE_BUDGET_WORKER_PROCESSES`, `DATABASE_BUDGET_REFRESH_MS` | Connection budget                                            | A W P S     |
| `REDIS_URL`, `QUEUE_PREFIX`                                                                                                                                                                                      | Redis and the queue/key namespace                            | A W P S     |
| `HOST`, `PORT`, `TRUST_PROXY_HOPS`, `API_HOST`, `ACME_EMAIL`, `HEALTH_BASE_URL`                                                                                                                                  | Listening and the edge                                       | A P S       |
| `WEB_ORIGIN`, `API_ORIGIN`, `WEB_REVALIDATE_URL`, `PREVIEW_COOKIE_DOMAIN`, `SITE_URL`, `NEXT_PUBLIC_API_ORIGIN`, `API_INTERNAL_ORIGIN`                                                                           | Origins and addresses                                        | A W Web P S |
| `TIPME_HOME`, `TIPME_VERSION`, `TIPME_BLUE_VERSION`, `TIPME_GREEN_VERSION`, `GIT_SHA`, `TIPME_BUILD_VERSION`, `TIPME_BACKUP_DIR`, `TIPME_OFFSITE_ENV_FILE`, `PG_ARCHIVE_MODE`, `PG_ARCHIVE_TIMEOUT`              | Deploy paths and versions                                    | A W Web P S |
| `MIGRATE_CONFIRM_DATABASE`, `MIGRATE_BACKUP_DONE`                                                                                                                                                                | Migration guards (the deploy script sets them)               | P S         |
| `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER_RATIO`, `API_METRICS_PORT`, `WORKER_METRICS_PORT`, `OPS_TRACE_URL_TEMPLATE`, `SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`             | Observability                                                | A W Web P S |
| `SES_REGION`, `ZEPTOMAIL_API_BASE`, `ZEPTOMAIL_BOUNCE_ADDRESS`, `SES_CONFIGURATION_SET`, `SES_CONFIGURATION_SET_UNTRACKED`, `SES_SNS_TOPIC_ARN`, `BACHS_PLATFORM_ORGANIZATION_ID`, `R2_ACCOUNT_ID`, `R2_BUCKET`  | Provider account identifiers (configured with their secrets) | A W P S     |
| `MAIL_PRETEND_DOMAINS`, `TRACE_PROBE_TEST_DELAY_MS`                                                                                                                                                              | Test copies only                                             | A W S       |
| `NEXT_RUNTIME`, `NEXT_PUBLIC_VERCEL_ENV`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_COMMIT_SHA`                                                                                                                        | Set by Next.js and Vercel                                    | Web         |

## Secrets: stay

`STATUS_TOKEN_SECRET`, `AUTH_CODE_SECRET`, `WEB_REVALIDATE_SECRET`, `OPS_TOTP_KEY`, `MAIL_SEAL_KEY`,
`CHANGELOG_SIGNING_SECRET`, `RELEASE_CHECK_TOKEN`, `PREVIEW_PASSWORD`, `MOCK_PROVIDER_WEBHOOK_SECRET`,
`BACHS_SANDBOX_API_KEY`, `BACHS_LIVE_API_KEY`, `BACHS_WEBHOOK_SECRET`, `BACHS_PREVIOUS_WEBHOOK_SECRET`,
`BACHS_LIVE_WEBHOOK_SECRET`, `BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET`, `ZEPTOMAIL_API_KEY`, `ZEPTOMAIL_WEBHOOK_KEY`,
`SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SENTRY_DSN`,
`NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `ALERT_WEBHOOK_URL` (the address is the credential), `BACKUP_KEY`,
`POSTGRES_PASSWORD`, `POSTGRES_RUNTIME_PASSWORD`, `POSTGRES_MIGRATOR_PASSWORD`, `POSTGRES_BACKUP_PASSWORD`.

## Counts

| Class                                                                                          | Variables |
| ---------------------------------------------------------------------------------------------- | --------- |
| Counted on `dev` at 0a490475 (the two variables of open PRs are not on `dev`, so not counted). |

| Class              | Variables                                                                   |
| ------------------ | --------------------------------------------------------------------------- |
| Secret             | 30                                                                          |
| Infrastructure     | 60                                                                          |
| Safety gate        | 13                                                                          |
| Product switch     | 12 (10 moved, 2 staying as owner questions); plus 2 registered for open PRs |
| Tunable            | 35                                                                          |
| **Total distinct** | **150**                                                                     |

## Questions for the owner

1. **Live updates** (`LIVE_UPDATES_ENABLED`): move it to admin too? It is wired at process start (a Redis
   subscriber per API copy), so switching it at run time is a bigger change than the others.
2. **Web app switches on Vercel** (`PILOT_NOTICE`, and the tunable `PRODUCTION_LAUNCH_AT`): move them too, with the
   web reading them from the API like the business switch? `SITE_INDEXING` stays either way.
3. **`LIVE_CHECKOUT_HANDLES`** (who may take real tips): leave it with `PAYMENTS_LIVE_ENABLED` in the environment,
   where the deploy checks live money, or move it to admin as a money setting with a second person?
4. **Rate limits and money tunables** (`RATE_LIMIT_*`, `PARTNER_QUOTE_CACHE_SECONDS`, `BACHS_RESERVE_ALERT_MINOR`):
   production sets none of them. Move them to admin as tunables in a follow-up, or simply drop them from the deploy
   files so the code defaults are the only values?
5. **Team tips** (`team_tips`) is treated as a money switch (second person). Agree?
