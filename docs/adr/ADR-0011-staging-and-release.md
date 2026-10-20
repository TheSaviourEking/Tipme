# ADR-0011 — Staging, the release check, backups and rollback

Date: 2026-10-20
Status: ACCEPTED for staging (PR-010). Production will copy this setup after D-03 to D-08. The VPS, DNS and Vercel project are not provisioned yet ("I'd get the VPS and you wire it in later").
Owners: Engineering

## Context

The user's release-day bar: "everything must be proven to work … from the tips to the admin dashboard … cohesively". The proof must run "on the app anywhere it's set up". It must clean up after itself or stay read-only where real people are, and keep money and audit records unchangeable ("Both"). Staging is a VPS plus Vercel for the web app, on the user's domain.

## Decision

### Staging layout

- **Web app on Vercel:** `https://staging.<domain>` (`apps/web/vercel.json`).
- **One VPS:** `https://api.staging.<domain>`, running Docker Compose (`deploy/compose.staging.yml`):
  - Caddy, the only published service (80/443, automatic HTTPS);
  - the API and the worker (one image, built from a git commit);
  - Postgres 16;
  - Redis 7;
  - a daily backup container;
  - an optional rclone off-site copy.

  Postgres, Redis and the worker sit on a network with no internet route. The API is on the network with internet access because it must tell Vercel a page changed; it is not otherwise restricted.

- **Same site:** the two hosts are the same site, so the existing credentialed CORS and the SameSite=Lax session cookie work unchanged.

### Private by password (preview mode)

- **The gate:** with `DEPLOYMENT_MODE=preview`, both hosts require one signed ticket cookie, `__Secure-tipme_preview` with `Domain=staging.<domain>`, valid 12 hours. It is set by the web app's `/preview-login`.
  - **API side:** a deny-by-default middleware.
  - **Web side:** a Next `proxy.ts`.
- **What passes without the cookie:**
  - health and release info;
  - the release check's bearer-token routes;
  - signed provider webhooks;
  - server-to-server calls carrying a key derived from the password.
- **Credentials:** in preview every browser call to the API is credentialed, so the cookie reaches it; production keeps checkout calls uncredentialed.
- **Compatibility:** the ticket format matches the other session's `scripts/preview/gateway.mjs`.

### What a copy is

- `RELEASE_KIND=test|live` (default `live`) and `GIT_SHA`, reported by `GET /health/release` along with the mode and whether payments are live.
- The full release check runs only where the copy says `test`.

### The release check (`pnpm release:check`)

- **Read-only** (any copy):
  - health and release info, with no live payments and the expected version;
  - the preview gate refuses the pretend inbox without the password;
  - public pages: LCP ≤ 2.0 s on a throttled phone, and axe;
  - `/dashboard` and `/ops` are noindex;
  - outsiders get 404 from admin.
- **Full** (`test` copies, with `RELEASE_CHECK_TOKEN` and a `release_check` staff account):
  - It opens a rehearsal run. The recipient's page is tagged with the run (`profiles.rehearsal_run_id`); events and issues about it carry `rehearsal`.
  - It plays: QR visit → tip → paid → dashboard and notification → admin sees a provider problem and resolves it → withdraw everything → admin money and recipient numbers unchanged.
  - At the end it deletes the account through the normal flow. If TipMe refuses because the deliberately broken tip is still unresolved (money is never released or deleted to make cleanup easier), it takes the page offline instead.
  - It finishes the run, which closes the run's open issues as `system` with reason "release check".
- **Hidden everywhere:** health and visibility metrics, the funnel, the default issues inbox and the top pages exclude rehearsal data.
- **Kept exactly as written:** the ledger, status history, audit and provider events.
- **The `release_check` role** has `issues.view`, `issues.resolve`, `analytics.view` and `audit.view`. It is granted only with `pnpm ops:grant-owner --role release_check`. On a server, that command must name its database (`TIPME_CONFIRM_DATABASE`).

### Deploys, migrations and rollback

- **Deploy:** `deploy/scripts/deploy.sh <sha>` builds `tipme-app:<sha>`, takes a backup, migrates (guarded: `MIGRATE_CONFIRM_DATABASE` plus a backup first), switches, waits for health and the right version, and records the version. If the new version is unhealthy, it puts the previous one back.
- **Migrations are forward-only and must stay compatible with the previous release** (expand, then contract in a later release). Rollback therefore never runs a down-migration.
  - `deploy/scripts/rollback.sh` switches back to the previous image.
  - The web app rolls back in Vercel (Instant Rollback).
- **Proven by a drill:** A → B (with a migration) → back to A → full check green.

### Backups

- **What:** a daily `pg_dump -Fc` taken inside a `REPEATABLE READ` snapshot exported to `pg_dump`. Its manifest is computed in that same snapshot: row counts, ledger totals per currency, latest migration.
- **Protection:** encrypted with AES-256-GCM under `BACKUP_KEY`, which must also be kept off the server. Files are mode 600, 14 kept.
- **The restore drill:**
  1. checks the file's checksum and decrypts it (a wrong key fails);
  2. restores into `tipme_restore_drill` (never the live database);
  3. compares the counts, ledger totals and migration with the manifest, and checks every ledger transaction balances.
- **A real restore** (`restore.js`, incident only) needs the database named, drops and recreates it, so nothing a later migration added survives, restores, and proves the result the same way.

## Rationale

- **Images built on the server from a commit:** no registry account is needed, the rollback image is already there, and the version is the commit.
- **One check for every copy:** release-day proof does not depend on where the copy runs. The copy's own declaration, not the operator, decides what may run.
- **Filters instead of deletion:** they keep the user's two wishes together. Nothing visible remains, and nothing trustworthy is erased.

## Consequences

- **Rate of full runs:** with the default of 3 sign-in codes per number per hour, the full check can run about 3 times an hour on a real copy. `RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR` exists for local drills only.
- **Rehearsal accounts may accumulate:** each full run whose cleanup meets the unresolved-tip refusal leaves one tagged, offline, synthetic account.
- **Not yet proven on the real server:** the VPS's memory, TLS and DNS, Vercel's build, and the off-site bucket are unproven until wiring-in. The staging runbook lists the first-run checks.

## Validation evidence

`docs/PR-010-VERIFICATION.md`.
