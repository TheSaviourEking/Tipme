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
- **Tunable** (limits, rates, lists): the rate limits and money tunables take the code defaults everywhere
  (owner, 14 Nov 2026): no deploy file names them, and the config keeps each as an optional override.
- **Display setting** (what the web app shows): moves to admin (owner, 14 Nov 2026): the pilot notice and
  the launch time.

Where: **A** API, **W** worker, **Web** the web app (Vercel), **P** production deploy files, **S** staging deploy
files.

## Product switches: moved to admin

Each is now a row in `feature_switches`, read through `featureOn(db, key)` (cached for 15 seconds in each process,
cleared at once in the process that changed it and, while live updates are on, in every API copy). A **money**
switch is a serious action (`feature_switch.set`: a reason, a fresh code and a second person when one exists); any
other needs a reason and a fresh code. Every change is in the audit log and the switch's own history.

| Variable                  | Switch key              | Money | Default | What it does                                                                                           | Where   |
| ------------------------- | ----------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `PRO_BILLING_ENABLED`     | `pro_billing`           | yes   | off     | Recipients may buy a Pro month (live money also needs the live gates below)                            | A P S   |
| `PRO_PAY_FROM_BALANCE`    | `pro_pay_from_balance`  | yes   | off     | Pay for Pro from the TipMe balance (waits on the partner's answer, plan Q1)                            | A P S   |
| `PRO_REFUNDS`             | `pro_refunds`           | yes   | off     | Staff refunds of card-paid Pro months (the payment history on the admin page view shows either way)    | A P S   |
| `PRO_AUTO_RENEW`          | `pro_auto_renew`        | yes   | off     | Auto-renew on a saved card: the offer (API) and the `pro.renew` sweep (worker), now one switch         | A W P S |
| `BUSINESS_SHARES_ENABLED` | `business_shares`       | yes   | off     | Business release 2 share agreements, a business's own balance, and the worker's share moves (option B) | A W P S |
| `TEAM_TIPS_ENABLED`       | `team_tips`             | yes   | off     | Tipping a whole business team (release 2). **Not built yet**: can't be turned on (see below)           | A P S   |
| `BUSINESS_ENABLED`        | `business`              | no    | off     | TipMe for businesses: every business route, and a tip's business member                                | A P S   |
| `ANALYTICS_ENABLED`       | `analytics`             | no    | on      | Anonymous, cookieless visit counts and server outcomes (owner, 9 Nov 2026; D-07 stays open)            | A W P S |
| `ADULT_PLATFORM_LINKS`    | `adult_platform_links`  | no    | on      | OnlyFans and Fansly links on Pro pages (`adult-platform-links.md`)                                     | A P S   |
| `SUPPORTER_RECOGNITION`   | `supporter_recognition` | no    | on      | The repeat supporters' tick box on Pro pages (`supporter-recognition.md`)                              | A P S   |

Registered for open pull requests, so they can read the switch instead of adding a variable:

| Variable                       | Switch key                     | Money | Default | Pull request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------ | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGE_STUDIO_ENABLED`          | `page_studio`                  | no    | off     | #210 `feat/page-studio-1` (no variable: the switch alone, owner 14 Nov 2026); #222 reads it. **Do not turn on until** the web reads #283's tall cover crops (`tall` on the public cover data) through `<picture>` with a media/aspect query, using them only where the cover box is 4:5 or taller, so Stage and Horizon photo covers meet the 2000 ms lab LCP (about 3.3 s on a phone without it; `tests/e2e-perf/lcp.spec.ts`, the parked real-photo test). Then, on merged dev, re-run `pnpm perf:lab` for `/@tobi` and every `/@style*` fixture first |
| `REFUND_FEE_RETURN`            | `refund_fee_return`            | yes   | off     | #193 `feat/business-r2-b`, wired in the API and the worker: a final refund is recorded at once instead of by two staff; that is all it does. A chargeback always returns TipMe's fee, with no switch (owner, 14 Nov 2026). No deploy file names the variable                                                                                                                                                                                                                                                                                             |
| `TIP_REFUNDS`                  | `tip_refunds`                  | yes   | off     | #221 `feat/tip-refund`: staff "Refund tip" (`tip.refund`, a second person); the supporter gets back the tip minus TipMe's fee. An approval after it is turned off records nothing; a refund already approved is still sent. No deploy file names the variable                                                                                                                                                                                                                                                                                            |
| `BUSINESS_PAYOUT_FEE_ABSORBED` | `business_payout_fee_absorbed` | yes   | off     | `feat/plan-fees-setting` (owner, 18 Nov 2026: "the admin should be able to set business fees too"): on, TipMe pays a business's payout fee from the payment reserve and the business receives the whole amount; off keeps today's rule (the business pays it from the amount). A withdrawal keeps the rule it was asked under. No deploy file names the variable                                                                                                                                                                                         |
| `YOU_COLLECT`                  | `you_collect`                  | yes   | off     | You collect plan, Task 3 (`feat/you-collect-3-schema`; ADR-0016, **PROPOSED**): new sign-ups would take tips through TipMe's own partner account and add bank details at their first withdrawal. **Not built yet**: can't be turned on (see below) until Task 16, after the owner accepts ADR-0016; D-04 and D-06 stay open. No deploy file names the variable                                                                                                                                                                                           |

Switches from merge train 2 (owner, 14 Nov 2026: each PR's flag became a switch before it shipped). None of
these variables was ever in a deploy file, so nothing needs deleting from the servers; each still seeds its
switch on a database with no row yet (local runs and the e2e stack, `playwright.config.ts`). Buying Business
Pro (Phase B) is not here.

| Variable                  | Switch key        | Money | Default | What it does                                                                                     | Pull request |
| ------------------------- | ----------------- | ----- | ------- | ------------------------------------------------------------------------------------------------ | ------------ |
| `BUSINESS_PRO_ENABLED`    | `business_pro`    | no    | off     | Business plans: staff and location limits, and the Business Pro price in admin. Needs `business` | #212         |
| `BUSINESS_SIGNUP_ENABLED` | `business_signup` | no    | off     | Signing up as a business with no personal page, the "verified" moment, the account switcher      | #211         |
| `BUSINESS_OWNERS_ENABLED` | `business_owners` | no    | off     | Co-owners and handover (Phase E). **Not built yet**: can't be turned on (see below)              | #211         |
| `CAMPAIGN_PAGES_ENABLED`  | `campaign_pages`  | no    | off     | A campaign link's own page (headline, description, cover) above the same tip area                | #220         |

### Switches with nothing built behind them (16 Nov 2026)

`team_tips` (its controller has no routes) and `business_owners` (only reported on `/health/release`; no screen or
route reads it) gate nothing yet, and nor does `you_collect` (19 Nov 2026: only its schema exists). They stay in `FEATURE_SWITCHES`, so stored rows and old variables stay valid, but
the catalogue marks them `notBuilt`: `/ops/switches` lists them with a "Not built yet" tag and no "Turn on", and the
API refuses turning one on with `409 SWITCH_NOT_BUILT`, before any approval is asked and again inside the change
itself (an approval asked earlier can't turn it on either). Turning one off always works. The PR that builds the
feature removes its `notBuilt` mark.

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
| `LIVE_CHECKOUT_HANDLES`                       | Who may take real tips while live payments are on       | A P       | Part of the live-money gate with `PAYMENTS_LIVE_ENABLED` (live-activation runbook). A tunable, but moving it needs the owner's word (owner, 14 Nov 2026: stays).                                                                                       |
| `REWARD_CASH_BUDGET_MINOR_PER_MONTH`          | Monthly cash rewards budget                             | W P S     | Must be 0 in production until D-05; the worker refuses any other value at start.                                                                                                                                                                       |
| `DEPLOYMENT_MODE`, `RELEASE_KIND`, `NODE_ENV` | What this copy is (production, preview, test)           | A W Web S | Decide what is allowed at all (mock providers, diagnostics, rehearsal settings) before anything else is read.                                                                                                                                          |
| `POINT_IN_TIME_RECOVERY`                      | Whether this copy keeps its own WAL and base backups    | A S       | Describes the machine's backups; `/health/backups` and the watcher depend on it.                                                                                                                                                                       |
| `DIAGNOSTICS_ENABLED`                         | Development-only diagnostic routes                      | A P S     | Mounted at start, refused in production; not a product feature.                                                                                                                                                                                        |
| `MAIL_DEFAULT_PROVIDER`                       | Mail provider until staff choose one in Providers       | A W P S   | Already a fallback only: staff choose the provider in admin. The deploy refuses a missing value so production never mails a pretend inbox.                                                                                                             |
| `SITE_INDEXING`                               | Search engines may index this copy (Vercel)             | Web       | A staging copy must never be indexed; it is read while rendering metadata, before any API answer.                                                                                                                                                      |
| `NEXT_PUBLIC_PRETEND_DELIVERY`                | The pretend inbox and crash pages in a production build | Web       | Built into the web bundle; test copies only.                                                                                                                                                                                                           |
| `NEXT_PUBLIC_PREVIEW_GATE`                    | Sends credentials to the password-gated preview         | Web       | Built into the bundle; describes the preview gateway.                                                                                                                                                                                                  |

## Product switch that stays in the environment

| Variable               | What it does                                                           | Where | Why it stays                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVE_UPDATES_ENABLED` | Live updates over text/event-stream; off, the stream routes answer 204 | A P S | The owner's decision (14 Nov 2026): it is wired at process start, deciding whether each API copy opens a Redis subscriber and takes stream slots, so it stays a setting that needs a restart. |

## Display settings: moved to admin

The web app's two Vercel settings (owner, 14 Nov 2026). Set at `/ops/switches`, under "What the web app shows",
with a reason and a fresh code (not money), audited, with history. The API serves them on its public
`/health/release` (`display`), which the web already reads; each web instance asks at most once a minute, so a
change shows within about a minute.

| Variable (Vercel)      | Setting                | What it does                                                                        |
| ---------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `PILOT_NOTICE`         | `pilot_notice`         | The pilot line where money moves; still shown only while payments are live          |
| `PRODUCTION_LAUNCH_AT` | `production_launch_at` | Before it, every page shows "coming soon"; none means TipMe is open (stored as UTC) |

- **Release day:** a display setting has no value until staff first set it. Until then the web keeps reading its
  own Vercel setting, so nothing changes on deploy. Once both are set at `/ops/switches`, delete the two Vercel
  lines and redeploy the web app.
- **If the API can't be read:** the web keeps the last value it read; with none, there is no pilot notice and no
  launch gate. That is what an unset `PILOT_NOTICE` and an unset `PRODUCTION_LAUNCH_AT` always meant.
- **The countdown check** (`tests/e2e/countdown.config.ts`, run by hand) runs the web app alone, so it starts a
  small stand-in API that answers "not set in admin", and the web keeps the run's `PRODUCTION_LAUNCH_AT`.

## Limits: set in admin

Stored with the display settings (the same table, reason, fresh code, audit and history), shown at `/ops/switches`
under "Limits". Each replaced no variable; while unset its default applies. Not served on `/health/release`.

| Setting                    | Default | Bounds      | What it does                                                                                                    |
| -------------------------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `announcement_daily_limit` | 300     | 1 – 100,000 | Most announcement emails (tests included) queued in any 24 hours; at the limit a send pauses (`admin-roles.md`) |

## Tunables: code defaults, overridable

| Variable                                                                                                                                                                                                                                                                                                                                                                          | What it does                                                  | Where | Why it stays                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_*` (20: quotes, intents, handles, analytics, reports, unsubscribe, avatars, cover designs, QR art, QR thumbs, bank resolve, bank read, business public, business note, live connect, auth, ops code, ops request, ops read, Studio drafts (`RATE_LIMIT_STUDIO_DRAFTS_PER_MIN`, default 60: saves, publishes and discards)) and `RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR` | Per-address and per-person request limits                     | A P S | Abuse protection (sign-in codes, bank look-ups). Owner, 14 Nov 2026: no deploy file names them; the code default is the value. The config keeps each as an optional override, for tests, e2e, drills and an emergency (add the line to the env file and the compose file). |
| `PARTNER_QUOTE_CACHE_SECONDS`                                                                                                                                                                                                                                                                                                                                                     | How long a withdrawal quote's provider answer is reused       | A P S | As the rate limits: code default (30 s), overridable.                                                                                                                                                                                                                      |
| `LIVE_MAX_STREAMS`, `LIVE_HEARTBEAT_MS`                                                                                                                                                                                                                                                                                                                                           | Open streams per API process; the stream's heartbeat          | A P S | Per-process capacity, sized to the machine.                                                                                                                                                                                                                                |
| `BACHS_RESERVE_ALERT_MINOR`                                                                                                                                                                                                                                                                                                                                                       | When the payment reserve counts as low                        | W P S | As the rate limits: code default (₦1,000), overridable.                                                                                                                                                                                                                    |
| `RECONCILE_INTERVAL_MS`, `RECONCILE_MIN_AGE_MS`                                                                                                                                                                                                                                                                                                                                   | How often and how late the worker asks about unconfirmed tips | W P S | Worker timing, read when its loops start.                                                                                                                                                                                                                                  |
| `SHUTDOWN_DRAIN_MS`                                                                                                                                                                                                                                                                                                                                                               | How long a stopping API copy drains                           | A P S | Tied to the edge's health-check timing.                                                                                                                                                                                                                                    |
| `BACKUP_RETAIN`, `BASE_BACKUPS`, `BASE_BACKUP_RETAIN`                                                                                                                                                                                                                                                                                                                             | Staging backups kept                                          | S     | Read by the backup loop, which has no admin.                                                                                                                                                                                                                               |
| `MAIL_FROM_DOMAIN`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO`                                                                                                                                                                                                                                                                                                        | Mail senders                                                  | W P S | Must match domains verified at the mail provider; a typo stops mail.                                                                                                                                                                                                       |

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

Counted on `dev` at 0a490475 (the two variables of open PRs are not on `dev`, so not counted).

| Class              | Variables                                                                   |
| ------------------ | --------------------------------------------------------------------------- |
| Secret             | 30                                                                          |
| Infrastructure     | 60                                                                          |
| Safety gate        | 13                                                                          |
| Product switch     | 11 (10 moved, `LIVE_UPDATES_ENABLED` stays); plus 2 registered for open PRs |
| Display setting    | 2 (both moved)                                                              |
| Tunable            | 34 (22 now code defaults only: 20 rate limits and 2 money tunables)         |
| **Total distinct** | **150**                                                                     |

| Deploy file                    | `dev` | After this change             | After the follow-up |
| ------------------------------ | ----- | ----------------------------- | ------------------- |
| `production.env.example` lines | 100   | 68                            | 68                  |
| `staging.env.example` lines    | 64    | 53                            | 53                  |
| `compose.production.yml` names | 99    | 77                            | 67                  |
| `compose.staging.yml` names    | 110   | 88                            | 78                  |
| Vercel (web) settings          | –     | 2 to delete once set in admin | –                   |

## The owner's answers (14 Nov 2026, on #216)

1. **Live updates** (`LIVE_UPDATES_ENABLED`) stays in the environment: it is wired at process start.
2. **The pilot notice and the launch time** move to admin as display settings (above), read by the web through
   `/health/release`, with the fallback above.
3. **`LIVE_CHECKOUT_HANDLES`** stays in the environment, next to `PAYMENTS_LIVE_ENABLED`.
4. **Rate limits and money tunables** leave the deploy files: the code defaults are the values, and the config
   keeps them as optional overrides for tests and emergencies.
5. **Team tips** is a money switch (a second person approves).

## Plan fees: TipMe's share per tip (owner, 18 Nov 2026)

Not a switch: two rates in basis points, Free and Pro, at `/ops/plan-fees` (table `plan_fee_rates`, append-only
history, read on every quote, no cache). They started at Free 500 (5%) and Pro 300 (3%), seeded by migration
`0118_plan_fee_rates` with a system audit row; with no row the coded defaults (`DEFAULT_PLAN_FEE_RATES`, the
same numbers) apply. A change is the serious action `plan_fees.change` (permission `fees.manage`, a reason, a
fresh code and a second person when one exists), audited as `plan_fees.changed` with from, to and approver. It
applies to new quotes only: a quote already shown keeps the fee it recorded, and paid tips and the ledger are
never touched. Bounds (owner, 18 Nov 2026): whole basis points 150 to 1000 (1.5% to 10%) on each plan, and Pro never above Free;
a move of more than 200 bps on either plan needs the explicit confirm (`confirmLargeChange` in the request, a
ticked box on the screen). Migration `0118` also cleared per-page deals no longer below the new rate (Free 500 and
up, Pro 300 and up), one `fee.capped` audit row each. A per-page fee staff set
(`fee.change`, ADR-0014) still wins below the plan's rate. A person's first 2 withdrawals each Lagos day are free
(`FREE_WITHDRAWALS_PER_DAY`); from the 3rd the partner's fee comes off the amount. Business tips use the staff member's own plan rate:
there is no separate business per-tip rate.
