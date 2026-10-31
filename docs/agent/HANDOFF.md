# Current handoff — mail platform, staging backups and the live pilot (31 October 2026)

Read this first. It is written for an agent taking over with no memory of the previous session. Its state was checked at about 05:00 UTC on 31 October 2026.

## Ground rules that still apply

- Read `AGENTS.md`, the nearest scoped `AGENTS.md`, `docs/00-DECISIONS.md` and `docs/09-AGENT-PROMPT-PLAYBOOK.md`. Real money stays gated (`PAYMENTS_LIVE_ENABLED=false`) until the owner explicitly activates the live pilot (see §4).
- **Merging is the owner's.** Open PRs into `dev`. The owner merges them (`pnpm pr:merge <n>`, or GitHub). The agent's merge attempts were blocked as "merge without review".
- **Never print secrets.** Check settings by name only (`grep -c '^NAME=.\+'`). Values the owner pastes into chat must not be repeated.
- **Report command evidence:** the command and its pass/fail counts. Say plainly when a test wasn't watched failing first, or wasn't run.
- **Workflow files live on two branches.** Automatic staging deploys run `.github/workflows/deploy-staging.yml` **from `main`** (a `workflow_run` trigger) while checking out `dev`. A workflow change must land on both branches, or `dev` merged into `main`. This caused #54 and #56/#57.

## 1. Where things stand

**Merged into `dev`, all CI-green:**

- #45–#52: the mail platform, Tasks 1–24. #51 landed #46–#50, which had been merged into stacked branches by mistake.
- #53: the release check signs in by email.
- #57: the deploy workflow permission.
- #58: optional single sender address.
- #59: the #52 review fixes.
- #60: the WAL retention coordinator.

**On `main`:** `dev` merged as #55, plus #54 (workflow email setting and `.gitleaksignore`) and #56 (permission fix).

**No PRs are open.** This handoff's PR is the only new one.

**Staging** (`https://staging.usetipme.xyz`, API `https://api.staging.usetipme.xyz`):

- Running `90826c1` (#59). The deploy of #60 (`de92259`) started at 05:00 UTC; check `GET /health/release`.
- Payments: Bachs **sandbox**.
- **Mail:**
  - ZeptoMail's three settings are set in `/srv/tipme/staging.env`.
  - Sending is temporarily from `MAIL_FROM_ADDRESS=staging@usetipme.xyz`, because `staging-mail.usetipme.xyz` isn't verified in ZeptoMail yet. `MAIL_FROM_DOMAIN=usetipme.xyz`.
  - The owner reports email works. Confirm ZeptoMail is the **active** provider in Ops → Providers; the worker logs show `mock` or `zeptomail` per send.
- **Disk:** 38 GB of 48 GB used (79%). The WAL archive is about 27 GB (§2).
- **Production:** not built yet.
  - Its database will be on **Aiven** (managed; Aiven does its backups and point-in-time recovery).
  - Its API, worker, Redis and Caddy will run **on the same server as staging**, as a separate Compose project.
  - `usetipme.xyz` currently serves the web app from Vercel. `api.usetipme.xyz` doesn't exist.

**Server access:**

- `ssh tipme` (user `deploy`).
- `/srv/tipme/live/scripts/compose.sh <compose args>` runs Compose for the running version.
- Env file: `/srv/tipme/staging.env`, mode 600. Several backups of it sit beside it: `staging.env.bak-*`.
- The agent's edits to that file were sometimes blocked by the permission system. When that happens, give the owner the exact line instead.

## 2. Next, in priority order

### A. Staging backups: make them light, then let retention prune

**Owner direction (31 Oct):** "Staging should not be that serious with data/db management."

**Why it matters:**

- The WAL archive is 27 GB. `archive_timeout=300` writes a 16 MB segment every 5 minutes, idle or not (about 4.6 GB a day).
- Old pruning counted `.backup` markers, and an orphan marker kept WAL back to 25 October.
- Production will share this disk.

**What #60 built:**

- A `retention` service (`deploy/retention-loop.sh` runs `packages/database/src/scripts/backup-retention.ts`), dry run by default.
- `archive-wal.sh` now only copies. The old marker rule survives as `WAL_LEGACY_PRUNE=on`, which stops the disk filling during the dry run.
- Base backups are labelled with their own file name.
- Runs are recorded in `backup_retention_runs`, and drills in `recovery_drills`.
- `/health/backups` gained `retention`, and the watcher alerts on it.
- The runbook (`docs/runbooks/backup-and-restore.md` → "Backup retention") has the switch-to-apply checklist and the undo.

**To do:**

1. **Confirm #60 is deployed and the coordinator runs.**
   - `compose.sh logs --no-log-prefix --tail 400 retention`, or one run now: `compose.sh run --rm retention node packages/database/dist/scripts/backup-retention.js`.
   - `/health/backups` should show `retention` with `mode: dry-run`.
   - The retention container runs as root with only `DAC_OVERRIDE`, because the WAL files are `postgres`-owned with mode 600. If it can't read or delete them, look there first.
2. **Lighten staging,** per the owner's direction. Propose these to the owner as one small PR; the compose defaults are in `deploy/compose.staging.yml`:
   - `archive_timeout` from 300 to 1800, or turn off WAL archiving and base backups on staging altogether and keep only the nightly logical dumps. Either cuts WAL by 6× or more.
   - `RETENTION_KEEP_DAYS=1`, `RETENTION_MIN_KEEP=1`, `RETENTION_DRILL_MAX_AGE_DAYS=30`.
   - Optionally, compressed archived WAL. That changes the archive format and needs the restore command to decompress.
3. **Post the dry-run report the owner asked for:**
   - the inventory;
   - the verified recovery boundary;
   - the candidates, with sizes and reasons;
   - the space it would free;
   - the rollback plan;
   - the conditions for apply.

   Expect the orphan marker `000000010000000000000006.00000028.backup` (25 Oct 00:47; its file `tipme-base-20261025T004754Z-…` was pruned) to appear as a candidate.

4. **Switch to apply, following the runbook:**
   1. Run `/srv/tipme/live/scripts/pitr-drill.sh`. It records a pass.
   2. Set `RETENTION_MODE=apply`, `WAL_LEGACY_PRUNE=off` and `BASE_BACKUP_RETAIN=0`.
   3. Redeploy.
   4. Watch the next run.

   Never delete WAL by hand, never touch `pg_wal`, and never delete the `pgdata` volume.

### B. Release check: enrol the staff account by email (owner action, half done)

- `RELEASE_OPS_EMAIL=release@release-check.usetipme.xyz` is set as a GitHub `staging` secret. `RELEASE_OPS_TOTP_SECRET` still belongs to the old phone account. Until it's replaced, every deploy's full release check fails at staff sign-in (the deploy itself still ships).
- **Steps on the server.** No Node on the host: everything runs in the app image.

```sh
# 1. Grant the role; it prints a 10-character code, valid 30 minutes.
/srv/tipme/live/scripts/compose.sh run --rm -e TIPME_CONFIRM_DATABASE=tipme migrate \
  node packages/database/dist/scripts/grant-owner.js --email release@release-check.usetipme.xyz --role release_check
# 2. Get the email version of the enrol script onto the server. It isn't in the image; it is in dev since #53.
#    From a checkout: git show origin/dev:scripts/release-enrol.mjs | ssh tipme 'cat > /tmp/release-enrol.mjs'
# 3. Enrol through the internal network (the container can't reach the public address).
export RELEASE_PREVIEW_PASSWORD="$(grep '^PREVIEW_PASSWORD=' /srv/tipme/staging.env | cut -d= -f2-)"
export RELEASE_CHECK_TOKEN="$(grep '^RELEASE_CHECK_TOKEN=' /srv/tipme/staging.env | cut -d= -f2-)"
/srv/tipme/live/scripts/compose.sh run --rm --no-deps \
  -v /tmp/release-enrol.mjs:/repo/scripts/release-enrol.mjs:ro \
  -e RELEASE_PREVIEW_PASSWORD -e RELEASE_CHECK_TOKEN \
  migrate node scripts/release-enrol.mjs \
    --web https://staging.usetipme.xyz --api http://api:4000 \
    --email release@release-check.usetipme.xyz --code <CODE FROM STEP 1>
# 4. Put the printed secret in the GitHub staging secret RELEASE_OPS_TOTP_SECRET.
#    Delete RELEASE_OPS_PHONE. Then: rm /tmp/release-enrol.mjs; unset both variables.
```

- The owner's last attempts got as far as signing in. They failed only because they passed the example code `ABCDE23456` instead of running step 1.

### C. Mail: finish setup and the last two plan tasks

1. **ZeptoMail domain.**
   - Verify `staging-mail.usetipme.xyz` in the ZeptoMail agent: a DKIM TXT record and a bounce CNAME, set in Cloudflare by the owner, DNS only.
   - Then empty `MAIL_FROM_ADDRESS` and set `MAIL_FROM_DOMAIN=staging-mail.usetipme.xyz`. Each kind of email then has its own sender: `security@`, `notifications@`, `payments@`, `reports@`, `hello@`, `legal@`, `system@`.
   - ZeptoMail error **SM_111** means the sender's domain isn't verified in that agent.
2. **ZeptoMail webhook.**
   - URL: `https://api.staging.usetipme.xyz/v1/webhooks/mail/zeptomail`. It returns 401 unsigned, which is correct.
   - The event JSON shape was **inferred from ZeptoMail's docs**, with no real sample (ledger: Task 6 ruling). After real sends, check Ops → Email shows delivered, bounced and opened. If not, capture a real event and fix the parser in `packages/mail/src/zeptomail/webhook.ts`.
3. **DMARC.** `_dmarc.usetipme.xyz` still has **two** TXT records, which is invalid. The owner was given one merged record to keep: `v=DMARC1; p=none; rua=mailto:4bd6543375d141cb9886044475c5bb66@dmarc-reports.cloudflare.net,mailto:dmarc@usetipme.xyz; fo=1`.
4. **Task 25** of `docs/superpowers/plans/2026-10-30-mail-platform.md`: the onboarding series (days 1, 3 and 7), the payment-setup reminder, and policy notices with an ops broadcast.
   - The brief is in the plan.
   - The "guides and suggestions" switch (Task 24) controls nothing until Task 25 ships.
   - New email types must name a `sender`, which the registry test enforces.
5. **Task 26:** ADR-0017, `docs/runbooks/mail.md`, the D-11 note, the ADR-0003 addendum, the privacy and processor docs, the register entry for `@aws-sdk/client-sesv2`, and a **TODO for phone codes** (the owner's request).
6. **Final steps for the plan:**
   1. a whole-branch review by a fresh reviewer;
   2. a final message listing every ruling and deferred minor (both in `docs/superpowers/plans/2026-10-30-mail-platform-ledger.md`);
   3. then finishing-a-development-branch.

   The working ledger is `.superpowers/sdd/2026-10-30-mail-platform/progress.md` in the `.worktrees/mail-platform` worktree; that worktree is detached at `ce48cb7`.

7. **Owner decisions still open from the mail work:**
   - Per-address code limits let anyone delay someone's sign-in code for up to an hour. Accept it, or rate-limit per IP?
   - Whether changing the sign-in email should also need a code sent to the old address.
   - Confirm the "like-for-like" period comparisons in the email console.
   - Phone sign-in and link routes stay open only while the active mail provider is mock. Make sure that is so in production.

### D. Live pilot (real tips and payouts through Bachs live)

- The design is `docs/superpowers/specs/2026-10-31-live-pilot-design.md`. **It isn't approved yet.**
- **Answered by the owner:**
  - Bachs live Connect is active.
  - Anyone can sign up (no invitations); a pilot notice replaces terms.
  - Withdrawals happen only in TipMe's own screens, whenever the recipient likes.
  - TipMe pays all fees.
  - Reserve alert below ₦1,000.
  - Production database on Aiven, on the same server.
- **Still open:**
  - Q2 (ask Bachs): can a connected account's payout fee be billed to the platform? If not, how does TipMe make the recipient whole? The docs say the fee is charged on top, from the paying account; no platform option is documented.
  - Q3 (ask Bachs): can recipients move money themselves, or is there an automatic payout schedule?
  - Q4: is written confirmation from Bachs required?
  - Q5: may the owner alone settle money issues, with an audit trail?
  - Q6: will the owner pre-fund the reserve?
- **Next:** get answers, have the owner approve the design, then `superpowers:writing-plans`.
- Relevant Bachs documentation:
  - Payouts (`POST /v1/payouts` with `X-Account-Id`, fee on top, `payout.paid` / `payout.failed`)
  - Going live (`https://api.bachs.io`, `sk_live_`, a new webhook endpoint and secret, accounts recreated in live, capabilities start `restricted`)
  - Balances (`GET /v1/balances`)
  - Requirements (NIN or ID document; a `bank_account` destination)

### E. Approved designs with no plan yet

- `docs/superpowers/specs/2026-10-30-payment-provider-switching-design.md`: a switch moves everyone, per-account overrides, and a staged "switching in progress".
- `docs/superpowers/specs/2026-10-30-ops-account-overview-design.md`: growth figures for staff and recipients, username change count, each user's emails on their admin page.

### F. Smaller items

- **The `trace-flow` integration test fails locally** with "no Redis spans", **on plain `dev` too**. It probably comes from the local test Redis (`redis:7-alpine`, recreated 31 Oct). Check CI before assuming a code bug.
- **Rotate secrets the owner pasted into chat:**
  - the staging preview password and the release check token, in `staging.env` and the GitHub secrets together;
  - and the ZeptoMail values, if they were pasted.
- **Owner actions left from earlier:**
  - reply to AWS SES case 179320356100126 (production access was **denied**; SES stays in sandbox);
  - create an IAM send-only key if SES is wanted;
  - set an off-site backup bucket (`BACKUP_RCLONE_REMOTE`; none is configured);
  - set Vercel production environment variables when production exists;
  - rotate the Bachs webhook secret.
- **Old worktrees** under `.worktrees/`, about 20 of them, belong to finished work. Don't delete any without the owner's say; some may hold unpushed work.

## 3. Local testing on this Mac

- **Unit tests:** `pnpm -s --filter <pkg> test`; root scripts with `node --test scripts/<file>.test.mjs`. **Build first:** tests import `dist/`, so run `pnpm -s turbo run build`, and rebuild after switching branches.
- **Integration tests** need a throwaway Postgres and Redis. The agent used containers `tipme-mailtest-pg` (`postgres:16-alpine`, user, password and database `tipme_local` / `tipme_local_password` / `tipme_local`, port 127.0.0.1:5434) and `tipme-mailtest-redis` (`redis:7-alpine`, port 6380). Recreate them if they're gone (`docker run -d --rm …`). Never touch `tipme-postgres-1` or `tipme-redis-1`, which are the owner's local stack, or the `tipme-staging-*` containers.

```sh
B=$(grep -o "postgres://tipme_local:[^']*" packages/database/src/test-support.ts | head -1)
DATABASE_URL="${B/127.0.0.1:5432/127.0.0.1:5434}" REDIS_URL=redis://127.0.0.1:6380 TEST_CONCURRENCY=4 \
  node scripts/test-integration.mjs                       # the whole suite
DATABASE_URL="${B/127.0.0.1:5432/127.0.0.1:5434}" REDIS_URL=redis://127.0.0.1:6380 \
  node --test --test-concurrency=1 <files>                 # one or a few files
```

- **12 backup tests always fail on macOS** (Docker can't reach 127.0.0.1 there). They pass on CI.
- Under load, a handful of API tests are flaky (unsubscribe, readiness, handle rename). Run them alone before concluding anything.
- **e2e can't run locally:** port 4100 is held by another session's stack. CI is the evidence. Say so in the PR.
- **Before pushing:**
  - the pre-push hook runs the checks;
  - `pnpm -s api:openapi` must leave no diff;
  - `pnpm -s docs:generate` regenerates the docs the route-review test compares;
  - `scripts/deploy-scripts.test.mjs` requires every setting a service reads to be passed in `deploy/compose.staging.yml`.

## 4. What production needs before the pilot (summary of the 31 Oct checklist)

- **Code:**
  - a Bachs live adapter (`bachs-live`, live base URL and key, live webhook secret);
  - payouts through the provider;
  - the "Get paid" bank setup;
  - the pilot notice;
  - a reserve balance alert.
- **Infrastructure:**
  - `deploy/compose.production.yml` (Aiven connection URL; its own Redis, Caddy and network on the same host);
  - a manual `deploy-production` workflow from `main`;
  - Sentry for production;
  - `ALERT_WEBHOOK_URL` alerts (it is unset on staging);
  - the ZeptoMail production agent with `mail.usetipme.xyz` verified;
  - Vercel production environment variables;
  - fresh secrets.
- **The activation switch:** production starts with `PAYMENTS_LIVE_ENABLED=false`. The owner switches it on only after the conditions in the design's §6.8.

# Current handoff — PR #24 payer-total E2E correction (27 October 2026)

- Branch/worktree: `feat/provider-integrations-bachs` at
  `.worktrees/provider-integrations-bachs`; PR #24 is open and ready against
  `dev`.
- CI run `40500650198` passed static, security and integration. E2E had 17
  failures with one root cause: tests still required the intentionally removed
  “recipient receives … after fees” sentence before continuing through a tip.
- Updated only the browser-test contract: the shared helper and direct specs
  wait for the concise server-quoted “You pay …” total. The pricing test still
  verifies exact 8% and fee-free platform/net amounts from the quote response,
  without exposing them in the supporter UI.
- Passed after the correction: `pnpm typecheck` (15/15), `pnpm lint` (15/15),
  `pnpm test` (55/55 root; 18/18 workspace tasks), Playwright discovery (88
  tests), targeted Prettier and `git diff --check`.
- Full local E2E did not run: port 4100 is owned by the active
  `.worktrees/physical-interface` API and was not stopped. An earlier attempt
  found shared `tipme_test` partially migrated; it was not reset or modified.
  A disposable PostgreSQL instance initialized correctly, but Playwright still
  requires the occupied fixed API port. Next exact step: commit/push these test
  corrections, then require the clean PR E2E runner to pass before merge.

# Previous handoff — recipient onboarding, business page and tip purpose (27 October 2026)

- Branch: `feat/recipient-onboarding-and-tip-purpose`, based on current `origin/dev`. PR #21 was already merged; these follow-up changes are separate.
- Scope includes homepage/dashboard recipient onboarding, business coming-soon and mailto interest form, navbar and test-mode copy, optional structured tip purpose end-to-end, and the centred `/for-businesses` layout.
- The new optional purpose has contract validation, a database CHECK constraint, and a nullable `tips.purpose` column via `0039_tip_purpose`. The Bachs branch has since been rebased onto this merge and now follows it with `0040_bachs_sandbox_recovery`; the migration-number collision is resolved.
- PR CI run `40424132431` exposed a stale OpenAPI document, two stale onboarding assertions, and four visual mismatches. Follow-up commit `94ac1ab` fixed the document and assertions, and added failure-only PNG artifacts (3-day retention). CI run `40426539167` passed integration, security, static, Vercel, dashboard and welcome checks; only the four desktop/mobile visual snapshots failed.
- Reviewed CI expected/actual/diff images at desktop and mobile. The changes are intentional: optional purpose selector and approved navigation/footer/test-mode copy. The profile remains readable with no apparent overlap. Updated all eight Darwin/Linux snapshots; Darwin visual specs pass 4/4 using a temporary config against the built PR web app. Linux baselines match reviewed actuals from CI.
- Verified in this worktree: `pnpm build` (9/9), `pnpm api:openapi --check`, targeted Prettier, `git diff --check`, Playwright discovery (4 dashboard/welcome tests), and focused visual Playwright (4/4). Full local E2E was not run because port 4100 belongs to the active `.worktrees/physical-interface` API; it was left untouched. The local visual run did not reset or write to a database.
- Earlier checks also passed: `pnpm test` (54 root tests; all 18 package tasks), `pnpm typecheck` (15/15), `pnpm lint` (15/15), `pnpm build` (9/9), and `pnpm format:check`. Browser review of `/for-businesses` showed a centred desktop layout and no horizontal overflow at 400px.
- CI run `40431576309` passed after the code/baseline updates; final-head run `40432964292` also passed E2E, integration, static, security, and Vercel. PR #23 was subsequently merged into `dev` at `da0c62a`; its preview was deployed, with no production deployment or real payment.
- Next: product-owner review. Before merging with Bachs, resolve the `0039` migration collision and regenerate the journal/snapshot as needed. Keep the separate Bachs and physical-interface worktrees untouched.

# Current handoff — Bachs sandbox integration safety and routing (26 October 2026)

- Dedicated implementation worktree: `.worktrees/provider-integrations-bachs`,
  branch `feat/provider-integrations-bachs`, rebased onto `origin/dev` commit
  `da0c62a`. The rebase completed without remaining conflicts. Commits
  `0084177` and `788bd28` contain the funds-flow ADR and integration. Draft
  PR #24 is open against `dev`; the branch is published.
- The Bachs typed REST adapter, account persistence/onboarding API, one-shot
  checkout-start claim, durable unknown states, raw-body signature verification,
  scoped event correlation, fee-attribution gate, and audited staff recovery
  workflows are implemented. The API provider/event and database transition
  rules keep webhook/redirect evidence from marking a tip paid without
  authoritative verification.
- Reconciliation, expiry and staff re-check resolve historical providers by
  each persisted attempt/payout provider; focused database coverage exercises
  both mock and Bachs attempts. Bachs payout operations are explicitly
  unsupported.
- Checkout recovery accepts only a dashboard-found checkout on the matching
  open issue, verifies it using the persisted connected account and exact quote
  amount/currency, and leaves not-found/mismatch unlinked and `UNKNOWN`.
  Account recovery requires the recipient's verified email and explicit
  dashboard attestation, fetches provider status, then stores the mapping and
  resolves the issue transactionally. Payouts stay disabled.
- **Bachs sandbox is now selectable, user-approved, non-production only**:
  `PAYMENT_PROVIDER=bachs-sandbox` is accepted in `NODE_ENV=test` and
  password-protected preview (`DEPLOYMENT_MODE=preview`), never plain
  production. It requires an `sk_sandbox_` key and webhook secret;
  `PAYMENTS_LIVE_ENABLED` stays literal `false`. The checkout provider routes
  new attempts to Bachs; the worker no longer rejects it. UI: dashboard
  settings has a "Test payments" onboarding card (status, setup, continue,
  return re-sync); the tip form maps `PAYMENT_ACCOUNT_REQUIRED`,
  `PROVIDER_OUTCOME_UNKNOWN`, `DEPENDENCY_UNAVAILABLE`; labels say "Test
  payments". No provider checkout has been exercised end to end; a local
  profile-only browser smoke did not submit a checkout.
- Product-owner UI follow-up (27 October): the public tip quote displays only
  the exact payer total; fee breakdown, recipient net, and policy-version copy
  are removed without changing quote or payment calculations. This conflicts
  with PRD v1.1's fee-treatment disclosure requirement; revisit before enabling
  real payments.
- Verified the UI change with `pnpm --filter @tipme/web test` (55/55),
  `pnpm --filter @tipme/web lint`, `pnpm --filter @tipme/web build`,
  `pnpm typecheck` (15/15), targeted ESLint/Prettier, and `git diff --check`.
  Local browser smoke on Ada's profile selected NGN 5,000 and showed only
  “You pay NGN 5,000.00”; no checkout was submitted. E2E was not run because
  its global setup resets `tipme_test`.
- Migration `0040_bachs_sandbox_recovery` follows merged `0039_tip_purpose`.
  It combines the Bachs schema and issue-kind updates and preserves the custom
  status-transition function. The superseded `0039_bachs_sandbox_payment_accounts`
  and `0040_gorgeous_beast` migrations were removed; Drizzle generation reports
  no schema changes.
- Staging Compose forwards Bachs credentials to both API and worker and now
  forwards `RELEASE_KIND` to the worker. Staging env/runbook and ADR status
  match the test/preview-only provider gate. The Bachs webhook is documented
  as provider-signature protected in OpenAPI/access-control docs, with a
  regression test.
- Bachs cannot find checkout creation by TipMe's operation reference. Ambiguous
  writes stay `UNKNOWN` and are never retried. Platform-paid fee preference is
  not proof: connected-account, unknown or missing fee evidence stays pending.
  Dashboard settings includes recipient-facing sandbox setup guidance; payouts
  remain disabled.
- At implementation/CI time no Bachs credentials or provider requests were
  used; adapter tests used fake transport. See the later local sandbox
  validation below. D-01–D-07 and written provider/legal approval remain
  blockers. Live payments stay disabled.
- After the PR CI fixes, `pnpm build` (9/9), `pnpm typecheck` (15/15),
  `pnpm lint` (15/15), `pnpm format:check`, `pnpm test` (55 root tests and
  18/18 workspace tasks), CI-pinned Gitleaks (102 commits scanned, no leaks),
  and `git diff --check` passed. The two targeted integration files passed
  23/23 on a disposable local PostgreSQL container. The full integration suite
  was not run locally; no shared or staging database was reset.
- The database-dependent Bachs recovery API test now belongs to
  `tests/integration/`; the provider-reference test asserts mismatches are
  rejected without changing the saved reference. The synthetic historical
  key finding is ignored by its single Gitleaks fingerprint. All four
  Darwin/Linux profile baselines now say “Test payments”; focused visual
  Playwright passed 4/4. The Darwin run used a temporary config with read-only
  requests to the existing local API; Linux snapshots are the reviewed CI
  actuals.
- CI run `40452019057` passed static, security, integration and E2E on
  implementation commit `141f100`; the Vercel preview passed as well. PR #24
  remains open and draft.

## Local sandbox validation (27 October 2026)

- User-provided ignored `.env` and `apps/web/.env.local` were copied into this
  worktree with mode `0600`; local web uses port 3001 because 3000 was occupied.
  Secrets were not printed or tracked.
- `pnpm build`, `pnpm db:migrate`, and `pnpm db:seed` passed. The test used the
  existing shared local `tipme_local` database and Redis containers; no database
  reset occurred. Web is left running at `http://localhost:3001`, API at
  `http://localhost:4000`, and the worker is running.
- `/health` and `/@ada` returned HTTP 200. Recipient sign-in and mock email
  confirmation succeeded. Bachs sandbox recipient-account creation returned
  `ACTIVE` with charges enabled.
- Guest quote creation returned HTTP 201. A single Bachs checkout-start attempt
  returned HTTP 503 `PROVIDER_OUTCOME_UNKNOWN` (`BachsApiError`). Attempt
  `01a17c0b-8042-7715-9858-156eb54b83fb` is persisted as `UNKNOWN` with no
  provider reference; its tip is `AWAITING_PAYMENT`, and the worker created an
  open `payment_unresolved` issue. No card details or payment submission; no
  live payment, deployment, staging or production change.
- The provider HTTP status/code was not logged; root cause remains unresolved.
  Do not retry the attempt or create a new checkout until the Bachs sandbox
  dashboard and open issue are reviewed and the authoritative recovery flow is
  used. Bachs has no operation-reference lookup.
- No application source changes remain. Next exact step: inspect the open
  issue and corresponding Bachs sandbox dashboard record for this attempt;
  investigate the rejected checkout, resolve only with authoritative provider
  evidence, then resume checkout testing. Keep live payments disabled and PR
  #24 unmerged until then.

# Current handoff — PR #19 Linux visual baselines (26 October 2026)

- Linux screenshot baselines were generated directly on GitHub's Ubuntu runner in run `40261761860`; the four-image artifact was downloaded and visually inspected. The temporary workflow update step has been removed, restoring `pnpm test:e2e`.
- The locally generated container snapshots were replaced with the runner-generated versions. Existing Darwin screenshots and application/test logic remain unchanged.
- Standard CI passed on commit `41c787d`: E2E 5m19s, integration 6m57s, security, static, and Vercel checks all green. PR #19 is mergeable.
- No application source or test logic changed. Only the four Linux baselines and continuity records remain in the final PR diff.
- Next exact step: product-owner review and merge when authorized; no further code changes are pending.
- The initial local capture used isolated disposable PostgreSQL and Redis containers; the shared local test database was not touched.

# Branch publication — profile composition (26 October 2026)

- User selected `feat/profile-composition` and authorized publishing all current worktree changes. The separate `feat/physical-interface` worktree was not changed.
- Validation passed: `pnpm build` (9/9 tasks), `pnpm test` (all root script and package tests, 0 failures), `pnpm typecheck` (15/15 tasks), `pnpm lint`, `pnpm format:check`, and `git diff --check`.
- Two lint findings in the new staff-account pages and four Prettier findings were fixed before final build/lint/format verification. E2E and database integration suites were not run in this turn.
- The branch changes include theme/profile work, welcome flow, wordmark and short links, staff account/fee operations, and Drizzle migration 0029.

# Current handoff — Remaining screens (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): `QuietScreen` for 404/unavailable/profile error plus new `app/error.tsx` and `app/global-error.tsx`; themed staging password page; recessed loading placeholders; staff charts fixed (text out of stretched SVGs); favicon from the wordmark heart. Staff pages all reviewed: axe clean, no overflow at 1440.
- Verified: web 36/36, UI 4/4, domain 25/25, governance 2/2, typecheck, lint (clean), Prettier, diff-check; e2e 57/58 with no baseline changes.
- The one e2e failure and earlier "flakes" are explained by the never-reset local `tipme_design`: Ada crossed the milestone reward, so her quote shows reduced fees (NGN 1,970.00 instead of 1,870.00), and the demo number hit the 3-codes-per-hour limit. The real suite resets its database; run full `pnpm test:e2e` on :3100/:4100 before merging.
- Next exact step: product-owner review, then commit in pieces.

# Current handoff — Master wordmark and /handle short links (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): wordmark from the product owner's SVG (header, footer, share image; Nunito removed), `/handle` → 308 `/@handle` in `proxy.ts` via `shortLinkTarget`, 68 reserved handles, and a test that every single-word route/public folder is reserved.
- Verified: real HTTP checks (/ada, /Ada, ?src=qr → 308; pages and non-handles untouched); web unit 36/36, domain 25/25, UI 4/4, governance 2/2; typecheck, lint (now fully clean), Prettier, diff-check; e2e regression 53/54 with visual baselines re-accepted after inspection.
- The one failing e2e test (sign-out) is environmental: the API sends at most 3 sign-in codes per number per hour (silently), and repeated local runs on the never-reset `tipme_design` exhausted it for the demo number, so the helper read a stale code. A receipt test once stayed on "Loading your tip" right after a server restart and passed on rerun; not root-caused.
- Next exact step: before release, query the live database for existing handles that are now reserved; then commit in pieces.

# Current handoff — Theme rollout: remaining pages (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): recover, verify-email, profile loading state, QR page and print view, weekly report, notification bell and toasts, staff area headings, empty state, dev inbox. Emails are plain text with no template: nothing to theme until a messaging provider is chosen (D-11).
- Verified on a clean production build: dashboard, notifications, shell, quality (axe and 320px reflow), welcome, checkout, accounts and hardening all pass (excluding the 4 tests wired to :4100/`tipme_test`). One checkout test timed out once right after a server restart, then passed 3 times. Design-system baseline re-accepted after inspection (empty-state title). Web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- A staff owner was granted on the local `tipme_design` database only, to review the staff pages.
- Next exact step: product-owner review; full `pnpm test:e2e` on :3100/:4100 once free; reconcile with the other agent's dashboard refactor; commit in pieces.

# Current handoff — Theme rollout slice 3: dashboard (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): dashboard home recomposed (page card with "Finish setting up"), segmented navigation and filters, serif titles, black in-card actions, withdraw instrument, quieter tip proof, shared neutral notice restyled. Decisions in `docs/design/DECISION-LOG.md`.
- Verified on a clean production build (signed-in recipient with pretend tips): 58/62 of the regression set including dashboard, notifications and the first-day → tip → proof → withdrawal journey. The 4 failures are environmental: design-system baseline (re-accepted after inspection), `qr.spec` hardcodes `127.0.0.1:3100` in expected text, `reports.spec` posts to a hardcoded `:4100` (Codex's API; it failed there without effect). `moments.spec` was not run at all because it would create tips on :4100. Web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Not visually reviewed: the weekly report page and QR print view (no report existed for the session).
- Next exact step: product-owner review; then run the full `pnpm test:e2e` on :3100/:4100 once free, and plan commits (font fix, profile, onboarding, public pages, dashboard). Another agent has an uncommitted dashboard refactor (`*-view.tsx` split) in the main checkout that will need reconciling.

# Current handoff — Theme rollout slice 2, part 2 (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): header and footer redesigned, restrained purple button shadow (token and hover), receipt on theme, share-image text corrected ("No real payments"). Pretend checkout intentionally left neutral.
- Verified on a clean production build: 56/56 of the regression set (excluding the 4 tests wired to :4100/`tipme_test`); profile and design-system baselines re-accepted after inspection; web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Next exact step: slice 3 — dashboard (home, tips, tip detail, withdraw, QR and print, reports, settings) with a gentle "finish setting up" card while the page is not live.

# Current handoff — Theme rollout slice 2, part 1 (25 October 2026)

- Delivered on `feat/profile-composition` (uncommitted): pages fill the screen; canvas background; public pages (home, how it works, for creators, about, legal, not found) on theme; `.tip-instrument` shared; stale copy corrected (about page needs product-owner review). Decisions in `docs/design/DECISION-LOG.md`.
- Verified on a clean production build: 56/56 of the regression set (excluding the 4 tests wired to :4100/`tipme_test`), design-system baselines re-accepted after inspection (canvas, label case), profile baselines unchanged; web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Next exact step: slice 2 part 2 — tip status/receipt and the pretend checkout page; then slice 3 (dashboard).

# Current handoff — Theme rollout slice 1: shell and onboarding (25 October 2026)

- Same branch/worktree (`feat/profile-composition`), uncommitted, on top of the approved profile work. Design: `docs/superpowers/specs/2026-10-25-theme-rollout-design.md`; decisions in `docs/design/DECISION-LOG.md`.
- Delivered: themed header/footer (single "Create your page" action; guest actions hidden on dashboard routes via CSS), sign-up/sign-in as an editorial stage plus floating card with sign-up progress, handle step with live link preview and corrected copy (renames are possible; real host instead of `tipme.app`, also in Settings), and `/dashboard/welcome` (greeting, three skippable steps with live preview, server-confirmed go-live, share). Claiming a handle now lands on the welcome. Elevation roles promoted to UI tokens.
- Verified on a clean production build (:3300/:4300, `tipme_design`): welcome 3/3; accounts + hardening + welcome 8/10 (2 failures read Codex's :4100 API or `tipme_test` directly — environment; the cache-backstop test's UPDATE matched no rows there); shell + quality (axe, 320px reflow, nav) all pass; checkout 17/17 excluding the 2 DB-coupled tests; profile and design-system baselines re-accepted after inspection (header/footer change). Web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Next exact step: product-owner review of slice 1; then slice 2 (public pages, tip status, pretend checkout). Run full `pnpm test:e2e` once :3100/:4100 are free. Never point DB-coupled e2e tests at another agent's database.

# Current handoff — Design Correction Directive 001 (25 October 2026)

- Branch/worktree: `feat/profile-composition` at `.worktrees/profile-composition`, from `bead3e5`. All work uncommitted. Do not mix with `.worktrees/physical-interface`, which holds another agent's uncommitted WIP.
- Isolated stack used for verification: DB `tipme_design` (local), API :4300, worker (queue prefix `design`), web production build :3300. Ports 3100/4100 belong to other agents, so `pnpm test:e2e` was NOT run; specs ran via a temporary config against :3300 (since deleted).
- Verified: web unit 33/33; UI 4/4; governance 2/2; web `tsc --noEmit` and `tsconfig.tools.json` pass; web lint 0 errors (pre-existing unused `Heart` warning); Prettier and `git diff --check` pass; production build passes. E2E (shell, checkout, quality incl. axe + 320px reflow, profile and design-system visual): 50 passed, 2 failed — `double tap` and `expired tip` read `tipme_test` directly so cannot see this stack's tips (environment, not product). Double-tap invariant checked on `tipme_design`: 36 intents, 36 distinct keys, 0 duplicates. Expired-tip path not verified here.
- Visual baselines re-accepted after inspection: profile (intentional recomposition) and design-system (font fix; old baseline was Times).
- Round 2: measured Concept A proportions, recessed keys, collapsed optional extras on the profile. Clean build: 48 passed, 2 expected DB-coupled failures; web unit 33/33; lint 0 errors; typecheck, Prettier, governance pass. Caution: Turbopack served stale CSS from `.next/cache` after edits; `rm -rf apps/web/.next` before a verification build.
- Untested: real `pnpm test:e2e` on :3100/:4100, forced-colors and 200% zoom by hand, screen-reader smoke, Linux CI baselines.
- Next exact step: product-owner review; then run full `pnpm test:e2e` once :3100/:4100 are free, and choose commit boundaries (font fix separately from profile recomposition).

# Current handoff — Physical Interface planning (25 October 2026)

- Isolated branch/worktree: `feat/physical-interface` at `/private/tmp/tipme-physical-interface`, based on `0ee4c3c`. The original `feat/slack-deployment-notifications` worktree remains untouched with its unrelated uncommitted audit remediations.
- Approved creative authority: the supplied board, synthesized as 60% physical material/control behavior, 30% editorial composition/typography, and 10% selective playful acknowledgement.
- Added a repository-owned design specification and ten-task implementation plan covering governance, semantic materials, primitives, typography/assets, specimen route, public profile, tipping panel, verified success, visual baselines, and verification.
- No production UI changed at this checkpoint.
- A fresh builder-readiness review was completed with no edits from the reviewer. Its six plan gaps were incorporated. Remaining external input: the original board image file must be added under `docs/design/reference/` before final fidelity approval.
- Baseline evidence: `pnpm build` succeeded with 9 tasks; `pnpm test` succeeded with 42/42 script tests and 17/17 Turbo tasks. Turbo replayed some shared-worktree cache logs; output artifacts were confirmed present in this worktree.
- Next exact step: obtain plan review and execution-method choice, then start Task 1 test-first. Preserve all payment-state and privacy behavior.

# Previous handoff — CI rename redirect assertion (22 October 2026)

# PR #18 — Staging Compose validation failure (25 October 2026)

- Branch `feat/staging-db-roles`, PR #18. CI now supplies test-only values for required staging secret interpolation while validating against the intentionally blank example env.
- Verified the same Compose `config --quiet` command locally, plus Prettier and `git diff --check`.
- Strict Compose requirements and real staging configuration remain unchanged; no deployment or real credentials used.
- Next exact step: verify PR #18 checks after the fix is pushed.

# CI rename redirect assertion — 22 October 2026

- Active branch: `feat/hardening`, based on `5e18764`. The primary `dev` worktree is untouched.
- Reproduced CI run `39768906443` locally: the rename succeeds, but the test reads the URL synchronously after `goto`, before the streamed redirect finishes. The trace shows successful requests to the renamed URL between repeated visits to the old URL.
- Changed only `tests/e2e/hardening.spec.ts`: use Playwright's retrying `toHaveURL` before retrying navigation, and assert `?src=qr` is preserved. Existing page-content and old-handle reservation assertions remain.
- Verification: original assertion failed locally; corrected rename test passed 5/5 repetitions. Targeted Prettier, ESLint and `tsc -p tsconfig.tools.json` passed. Full `pnpm test:e2e` passed: fresh build and 64/64 tests (56.5s), exit 0. `git diff --check` passed.
- No application, payment, migration, environment or deployment settings changed.
- Next exact step: push this narrow fix to `feat/hardening` and verify the new GitHub Actions run. Do not merge or change staging routing as part of this fix.

# Agent handoff — PR-003 takeover audit

**Audit date:** 18 October 2026. **Auditor:** takeover agent (previous agent hit its usage limit mid-PR-003).
**Labels:** VERIFIED = proven by a command or file read in this session. INFERRED = deduced from evidence (timestamps, plan, cache). UNKNOWN = not recoverable.

## 1. Project and branch

- Project: TipMe monorepo at `/Users/dev/Workspace/SynqHQ/Tipme` (pnpm 10.33.0 + Turbo; `apps/web` Next 16.4.2, `apps/api` NestJS, `apps/worker`, `packages/{ui,contracts,config}`). VERIFIED.
- **No Git repository** (`git status` → `fatal: not a git repository`). No branch, HEAD or commit history exists, so state was reconstructed from file modification times and docs. VERIFIED. Branch/PR creation is impossible without inventing history; not attempted.
- Runtime: shell default is Node 20.20.2; pinned Node 24.22.0 (`engine-strict=true`) is available at `~/.npm/_npx/fee7060b69ab3f2d/node_modules/node/bin`. All commands below ran with that directory first on `PATH`. VERIFIED.

## 2. Last verified completed milestone

PR-001/002 (governance + toolchain), evidence in `docs/BOOTSTRAP-VERIFICATION.md` (written 18:05). VERIFIED by file; its own commands were not re-run individually except as part of the full suite below.

## 3. Active PR and objective

**PR-003** — responsive marketing site, `packages/ui` design-system foundation, fictional public recipient profiles, review-only (non-transactional) appreciation form, safe metadata, responsive/a11y/performance evidence. Spec: `docs/superpowers/specs/2026-10-18-pr003-experience.md`. Plan: `docs/superpowers/plans/2026-10-18-pr003.md`. VERIFIED.

## 4. Already implemented (written 18:16–18:23)

| Area                                                                                                                                                                             | Status                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| UI tokens (`packages/ui/src/tokens.css`) — brand #7A32F9/white/black, derived lavender, spacing, radius, motion                                                                  | VERIFIED                                 |
| UI primitives (`components.tsx/.css`): Button, ActionLink, Container, Card, Badge, InputField, TextareaField, Choice, Notice, EmptyState, Skeleton, Motion; reduced-motion rules | VERIFIED                                 |
| Marketing `/` (hero + live composer, manifesto, use cases, steps, promise/closing)                                                                                               | VERIFIED renders; **overflow bug** (§9)  |
| Profiles `/people/ada`, `/people/tobi` (SSG), unknown handle → `notFound()`; `loading.tsx`, `error.tsx`                                                                          | VERIFIED                                 |
| `AppreciationForm` — radios, custom amount (integer minor units, `parseDemoAmount`), message, review/edit/clear, focus management                                                | VERIFIED by e2e                          |
| Navigation (mobile disclosure, Escape closes), footer, share-link copy, SVG avatars                                                                                              | VERIFIED renders                         |
| Metadata helper: validated `SITE_URL`, canonical, noindex, OG/Twitter                                                                                                            | VERIFIED; references a **missing** image |
| `/about-preview`                                                                                                                                                                 | VERIFIED (200)                           |
| Tests: `apps/web/test/demo-amount.test.mjs`, `tests/e2e/shell.spec.ts` (3 tests × 2 projects); Playwright on port 3100                                                           | VERIFIED                                 |
| `@axe-core/playwright@4.14.0` added to root devDependencies and installed                                                                                                        | VERIFIED; **not yet used** in tests      |

Plan step 2 ("tests fail against bootstrap") INFERRED complete: `test-results/.last-run.json` (18:18) records all 3 tests failing, written before implementation files (18:20+).

## 5. Incomplete / missing

1. `pnpm lint` fails — 10 × `@next/next/no-html-link-for-pages` (internal `<a href>` should be `next/link`). VERIFIED.
2. `pnpm format:check` fails — 24 PR-003 files not Prettier-formatted. VERIFIED.
3. Marketing horizontal overflow in production build (`span.demo-orbit`). VERIFIED.
4. `/social/preview.png` referenced by metadata returns 404. VERIFIED.
5. `/design-system` specimen route missing (footer links to it → 404). VERIFIED.
6. `/preview-states` route missing. VERIFIED.
7. No axe scans, no 320px / zoom / reduced-motion e2e, no nav-disclosure keyboard test. VERIFIED by reading spec.
8. `docs/third-party-component-register.md` lacks axe-core entry. VERIFIED.
9. No `docs/PR-003-VERIFICATION.md`, no screenshots inspection record, no synthetic performance sample. VERIFIED.
10. Independent final review not done. INFERRED (plan unchecked, no artifact).

## 6. Files involved

`packages/ui/{package.json,tsconfig.json,src/*}`, `apps/web/{package.json,src/app/**,src/components/*,src/lib/*,public/illustrations/*,test/*}`, `tests/e2e/shell.spec.ts`, `playwright.config.ts`, root `package.json`, `pnpm-lock.yaml`. `apps/worker/package.json` modified at 18:08 (before PR-003 spec) — UNKNOWN change; not touched.

## 7. Relevant decisions

- Brand LOCKED #7A32F9/#FFFFFF/#000000; derived lavender tokens only (PRD 4.1 "PROPOSED derived purple shades").
- System fonts only, no remote fonts; no animation dependency. (spec)
- NGN is illustrative only; no fees, price truth, network, storage or URL persistence of drafts. (spec, AGENTS financial invariants)
- All preview routes `noindex, nofollow`; no sitemap of fictional accounts. (spec)
- Production e2e server on 3100; an existing dev server on :3000 (web) and API on :4000 are preserved. (plan)
- No API/DB/auth/payment work in PR-003; D-01…D-10 all OPEN.

## 8. Commands run (this session, Node 24.22.0)

| Command                                    | Result                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile --offline` | PASS — lockfile up to date, 7 projects                                                           |
| `pnpm format:check`                        | FAIL — 24 PR-003 files                                                                           |
| `pnpm lint`                                | FAIL — `@tipme/web#lint` 10 errors; 6/7 tasks pass                                               |
| `pnpm typecheck`                           | PASS — 7/7                                                                                       |
| `pnpm test`                                | PASS — 8/8 tasks, 0 failures                                                                     |
| `pnpm build`                               | PASS — 5/5 (Turbo cache hit); routes `/`, `/about-preview`, `/people/ada`, `/people/tobi` static |
| `pnpm exec playwright test`                | FAIL — 4 passed, 2 failed (marketing overflow, desktop + 360px)                                  |
| Overflow probe (scratch script) on :3100   | `demo-orbit` extends to 1336px @1280, 454px @360, 421px @320                                     |
| `curl` :3100                               | `/social/preview.png`, `/design-system`, `/preview-states` → 404                                 |

## 9. Known issues and risks

- Overflow occurs in production build but not in the long-running dev server on :3000 — UNKNOWN why (possibly stale dev compilation); production is authoritative.
- Format fix requires running Prettier on PR-003 files only (not a broad reformat of pre-existing files).
- No Git means no reviewable diff; review relies on this document.
- axe/automated checks do not replace manual assistive-technology testing.

## 10. Next smallest steps

See `docs/agent/ACTIVE_TASK.md`.

## 11. Scope boundaries

In: PR-003 web/UI/metadata/tests/docs. Out: PR-004+ (API health/correlation, DB/ORM, mock provider, checkout, dashboard), any payment SDK, real fees/currency decisions, analytics SDKs, dependency upgrades.

## 12. Not recoverable

- Previous agent's in-flight thinking after 18:23 (which step it was on). INFERRED: styling/asset polish within plan step 3.
- Why `apps/worker/package.json` changed at 18:08.
- Whether the user reviewed any PR-003 screenshots.

## Update — after takeover work (same day)

Every §5 item except the independent review is resolved. Details and command evidence: `docs/PR-003-VERIFICATION.md`. Final gate: format, lint 7/7, typecheck 7/7, unit 8/8, e2e 31 passed / 1 skipped. Independent review done; one keyboard-focus defect found and fixed. VERIFIED.

The `pnpm dev` processes (web :3000, API :4000, worker) present at audit start were no longer running mid-session. It is UNKNOWN whether a `pkill -n next-server` aimed at the takeover agent's :3100 server caused this or the processes ended with the previous session. Restart with `pnpm dev`; Docker Postgres/Redis were unaffected.

## Update — PR-004 (same day)

PR-004 is complete and VERIFIED: traceable API and worker foundation (OpenTelemetry → local Jaeger, pino JSON logs, trace ID as support reference, health/readiness, zod contracts, BullMQ worker with retries, idempotency and bounded shutdown, metrics, `pnpm trace:demo`). Final gate: lint, typecheck, unit (root 4, contracts 3, observability 10, api 17, worker 13, web 1), integration 12/12, e2e 33 passed / 1 skipped. Evidence: `docs/PR-004-VERIFICATION.md`; ledger: `.superpowers/sdd/2026-10-18-pr004/progress.md`.

Environment: Docker Desktop running with Postgres, Redis and Jaeger 2.21.0 healthy (`pnpm infra:down` stops them, keeping data). A local `.env` was created from `.env.example`. To run everything: `pnpm dev`, then `pnpm trace:demo`.

Open item not caused by this work: `docs/architecture/IMPLEMENTATION_BASELINE.md` appeared at 19:33 from another author and fails `prettier --check`, so `pnpm format:check` (and CI's format step) fails until its owner formats it.

## Reconciliation with `docs/architecture/IMPLEMENTATION_BASELINE.md` (v0.1)

The baseline (added by the user at 19:33) describes itself as a "PROPOSED engineering plan … NOT an audit of existing source code". Authority order (AGENTS.md): user instructions → PRD + accepted ADRs → AGENTS → docs → code. Where the baseline proposes something an accepted ADR or approved PR has since decided, the decision stands; the baseline is not used to reverse it.

### Scope conflict (needs the user's eye)

The reconciliation request says "PR-003 is the currently authorized scope". The repository shows **PR-004 complete**, built after the user explicitly authorised it in this session ("Sure, let's go with the PR-004"); evidence in `docs/PR-004-VERIFICATION.md`. Per "do not reverse accepted decisions" and "preserve existing work", PR-004 is kept, not rolled back. INFERRED: the request text predates PR-004. No PR-005+ work has started.

### LOCKED product decisions — all consistent

| Baseline LOCKED item                            | Repository state                                                         | Label                  |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ---------------------- |
| Appreciation-first identity, links and QR       | Marketing and profile copy appreciation-first; QR not built (PR-008)     | VERIFIED / QR deferred |
| Guest payer flow; recipient accounts; dashboard | Guest review-only form (no money); accounts/dashboard not built (PR-008) | VERIFIED / deferred    |
| Brand #7A32F9 / #FFFFFF / #000000               | `packages/ui/src/tokens.css`                                             | VERIFIED               |
| Accessible, observable, financially correct     | axe + keyboard e2e (PR-003); tracing/logs/health (PR-004); no money code | VERIFIED               |
| Ethical funnel tracking                         | No analytics yet (PR-009)                                                | Deferred               |

### PROPOSED engineering items vs repository

| Baseline proposal                                     | Repository                                                     | Status                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| apps/web, api, worker; packages ui, contracts, config | Present (+ `packages/observability`, ADR-0005)                 | VERIFIED                                                   |
| `packages/analytics`                                  | Absent; event contract is PR-009                               | Not built — do not create early                            |
| Postgres + Redis                                      | Running locally; no schema (ADR-0002 pending, PR-005)          | VERIFIED                                                   |
| OpenTelemetry + error monitoring                      | OTel + local Jaeger (ADR-0005); Sentry deferred on budget D-08 | Partly done, by decision                                   |
| REST + OpenAPI                                        | REST yes; **no OpenAPI document** (PRD P0 "Publish OpenAPI")   | Gap → PR-005/006                                           |
| Response envelope (PRD: `{data, meta?, error?}`)      | Errors use `{error:{…}}`; successes return bare objects        | **Discrepancy** — decide before PR-005 adds real endpoints |
| `X-Request-ID` / trace IDs                            | `X-Request-Id` = trace ID (headers are case-insensitive)       | VERIFIED                                                   |
| Transaction/outbox, payment state contract, ERD       | None (PR-005/006)                                              | Not started, correctly                                     |
| CDN/WAF, staging, backups                             | None; no hosting account or Git remote                         | UNKNOWN / blocked                                          |

### Route inventory vs repository

| Baseline route                                                  | Repository                                                      | Notes                                                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                             | `/` (sections `#how-it-works`, `#made-for-you`, `#our-promise`) | VERIFIED                                                                                                                                                                |
| `/how-it-works`, `/for-creators`, `/for-professionals`, `/help` | Not separate pages                                              | PRD lists `/for-teams-later` instead of `/for-professionals`; the two sources disagree. Not in PR-003's approved spec.                                                  |
| `/legal/*`                                                      | **Missing**                                                     | Delivery plan PR-003 requires "legal placeholders clearly labeled" → **unfinished PR-003 item**                                                                         |
| `/@handle`, `/@handle/tip`                                      | Fictional profiles at `/people/[handle]`                        | **Open decision**: PRD says "/@handle or /handle (route decision pending)"; `/people/` was a PR-003 choice for noindex demos. Choose before real profiles (PR-007/008). |
| `/tip/receipt/:id`, auth, dashboard, `/ops`                     | Not built                                                       | PR-007–PR-009                                                                                                                                                           |
| (not in baseline)                                               | `/about-preview`, `/design-system`, `/preview-states`           | Development-only, noindex (PR-003)                                                                                                                                      |

### Sprint 0 items

A0-01 repo audit: DONE (this handoff; no longer "blocked on source"). A0-02 tokens/primitives: DONE (PR-003). A0-03 journey screenshots: partly (PR-003 evidence; checkout states await PR-007). A0-04 inspiration register: register exists, no third-party UI adopted. A0-05 user research, B0-01 provider/legal spike: UNKNOWN, outside code. B0-02/03/04: PR-005/006. B0-05: CI file and local observability done; staging and backups blocked (no accounts or remote).

### Could not be recovered (UNKNOWN)

Existing TipMe prototype or brand assets (baseline blocking input 1); launch country and currency (D-01; NGN remains illustrative); processor, fee policy, settlement owner; team, timeline, budget, deployment accounts.

### Verification run during reconciliation

Node 24.22.0 / pnpm 10.33.0 pinned and matching; `pnpm install --frozen-lockfile --offline` up to date; governance scan PASS; root script tests 4/4; `docker compose config` PASS; Postgres, Redis and Jaeger healthy. Full gate (lint, typecheck, unit, build, integration 12/12, e2e 33 + 1 skipped) passed earlier this session after the last code change. The baseline file itself fails `prettier --check` and was left unmodified.

### Decisions applied after reconciliation (user: "stick with the PRD"; `/@handle` chosen by the user)

- Profiles: `/@handle` served by a rewrite to the internal `people/[handle]` route (an App Router folder starting with `@` is a parallel-route slot); `/people/:handle` → 308 → `/@:handle`; canonicals, share links and every internal link updated. VERIFIED by e2e and curl.
- API: `/v1` successes wrapped in `{ data }` (`ApiDataResponse<T>`); `trace:demo` updated. VERIFIED by integration 12/12.
- Marketing: `/how-it-works` and `/for-creators` added, reusing extracted home components (`components/marketing.tsx`); main navigation links to them. VERIFIED by e2e, axe and screenshots.

## Update — PR-005 (same day)

PR-005 is complete and VERIFIED: custody-neutral double-entry ledger and money records (`packages/domain`, `packages/database` with Drizzle and four migrations, outbox relay in the worker). Final gate after the review fix pass: lint 13/13, typecheck 13/13, unit (root 4, domain 11, contracts 3, observability 10, database 2, api 17, worker 13, web 1), build, `db:migrate`, integration 61/61, e2e 49 + 1 skipped. User decisions: both proofs required; custody-neutral ledger; Drizzle (after comparing with Knex); custodial wallet model recorded as PROPOSED under D-04.

Local database `tipme_local` is migrated (through 0003) and seeded with Ada and Tobi. The worker now requires `DATABASE_URL`.

PR-005 follow-up: all review minors fixed (migrations 0004, 0005); integration 73/73. See `docs/PR-005-VERIFICATION.md`.

## Update — PR-006 (same day)

PR-006 complete and VERIFIED: provider interface and mock provider (`packages/payments`), signed webhook endpoint, unmatched-event storage, background reconciliation, `pnpm mock:pay`. All nine agreed scenarios pass automatically; succeed, duplicate, forged, payout-paid and no-reply (~170 s) also passed live. Gate after review fixes: integration 106/106, e2e 49 + 1 skipped. The API and worker now need `NODE_ENV` set and `MOCK_PROVIDER_WEBHOOK_SECRET` (in `.env`). Migrations through 0008 applied locally.

PR-006 follow-up: all review minors fixed, including payout reconciliation (migration 0009); integration 118/118. The worker no longer needs `MOCK_PROVIDER_WEBHOOK_SECRET` (the API still does).

## Update — PR-007 (19 October)

PR-007 complete and VERIFIED: guest checkout with pretend payments only. User decisions: fast prebuilt profile; confirmation screen that only reports verified outcomes; recognition option B (after confirmation, celebrate, never compare); memory on the phone only, opt-in. Gate after the review fix pass: lint 15/15, typecheck 15/15, unit 17/17 tasks, build 9/9, integration 145/145, e2e 77 + 1 skipped (twice). Lab LCP: `/@tobi` ≤ 712 ms, `/tip/<id>` ≤ 628 ms (throttled, lab only). See `docs/PR-007-VERIFICATION.md`, ADR-0008, ledger `.superpowers/sdd/2026-10-18-pr007/progress.md` (all rulings and 10 deferred minors).

- New required setting: `STATUS_TOKEN_SECRET` (generated into the local `.env`, value never printed). Also `WEB_ORIGIN`, `NEXT_PUBLIC_API_ORIGIN`, `RATE_LIMIT_*_PER_MIN`.
- e2e now starts web (3100), API (4100) and worker against `tipme_test` with test-only secrets; `pnpm perf:lab` repeats the LCP sample.
- `docs/architecture/IMPLEMENTATION_BASELINE.md` was reformatted (prettier whitespace only) by this PR's first `pnpm format`; it now passes `prettier --check`. Earlier PRs had left it untouched on purpose; flagged to the user.

PR-007 follow-up: all ten review minors fixed (see `docs/PR-007-VERIFICATION.md`). Integration 149/149, e2e 87 + 1 skipped. New optional setting `TRUST_PROXY_HOPS` (default 0). The return URL from the provider no longer carries the receipt token; the tipping tab keeps it in `sessionStorage`.

The user accepted the whitespace-only reformat of `docs/architecture/IMPLEMENTATION_BASELINE.md` (19 October) and authorised PR-008.

## Update — PR-008 (19 October)

PR-008 is complete and VERIFIED: recipient accounts and dashboard.

- **Accounts:** phone + code sign-in (pretend WhatsApp/SMS), open sign-up with handles, live / not live / deleted pages, and public/private profile details.
- **Dashboard:** dashboard with proof, pretend withdrawals, and styled QR codes.
- **Notifications and recovery:** in-app and pretend email notifications, email verification, phone change, and recovery with a 24-hour hold.
- **Reports and moments:** weekly reports, plus moments with fee-free and capped cash rewards (pretend).

User decisions:

- sign-in by phone number with WhatsApp/SMS codes, email as backup;
- sign-up included in this PR;
- page states and public/private switches;
- phone and email private by default and free;
- QR styles with premium marked "free in preview";
- notifications in-app and by email, no SMS;
- rewards: fee-free by default, cash bonus = a share of fees, under a monthly budget.

Gate after the review fix pass: lint 15/15, typecheck 15/15, unit 17/17 tasks, build 9/9, migrations through 0016, integration 225/225, e2e 105 + 1 skipped. Lab LCP: profile ≤ 936 ms, dashboard ≤ 724 ms. See `docs/PR-008-VERIFICATION.md`.

## Update — Git import and hosting assessment (19 October 2026)

User authorized Git initialization, logical commits and push. Initialized main with no prior history. Existing PR-009 source exceeds the prior continuity status; preserved without certifying completion. See `docs/HOSTING-ASSESSMENT.md` for current architecture, hosting blockers, commit grouping and fresh verification limitations.

Files changed by this task: `docs/HOSTING-ASSESSMENT.md`, `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`; Git metadata initialized. Application source and migrations unchanged. Formatting, lint, typecheck, build and unit command passed (Turbo cache used); integration and browser checks not rerun. Common credential-pattern scan found no candidates; local secrets and generated outputs excluded.

Push destination is pending user input. Six logical import commits completed; status/history verified and worktree clean. Next exact step: obtain the destination, configure origin and push main. Hosting remains an assessment; production startup deliberately rejects the only available mock providers, and remote maintenance scripts are not yet provided.

## Update — GitHub push (19 October 2026)

User authorized pushing to their authenticated account. Created private `TheSaviourEking/Tipme` at https://github.com/TheSaviourEking/Tipme and successfully pushed all six import commits. `main` tracks `origin/main`. This documentation follow-up records completion; application source unchanged. Next step: agree hosting budget, domain and preview scope before deployment work.

## Update — free private demo scope (19 October 2026)

User chose a private pretend-payment demo and free hosting only. Assessed Render free compute/Key Value and Neon free Postgres from official documentation. Proposed a single guarded web/API/worker service; not implemented or provisioned. Free-tier sleep, queue loss and database compute limits mean this is an intermittent demo. Need a memory-fit test, explicit hosted-preview mode, protected ingress and controlled migration path. Docker available, existing local services healthy. Asked user about Render/Neon accounts and acceptance of shared-password/sleeping demo behavior. Next: resolve those inputs and implement the deployment slice; no real-money enablement.

## Update — PR-009 (19 October 2026)

PR-009 implemented by the PR-009 session (inline plan execution):

- **Admin area:** staff-only `/ops` with Owner role, authenticator second step, session-bound grants and an append-only audit log.
- **Issues inbox:** evidence, private reveal with a reason, and money-free actions.
- **Analytics:** anonymous, collection off in production until D-07.
- **Dashboards:** health and visibility, plus the manual Market page.

Migrations 0017–0021. Integration 276/276 after the review fixes; e2e 121 + 1 skipped before the concurrent hosting changes. See `docs/PR-009-VERIFICATION.md` and ADR-0010. Review fixes are committed on `feat/pr-009-010-admin-release` (see ACTIVE_TASK). Failures now seen in format/unit/hero e2e come from the concurrent hosting session's files.

## Update — PR-010 (20 October 2026)

PR-010 (release rehearsal and staging) implemented by the PR-009/010 session:

- **Release check:** `pnpm release:check`, read-only or full. The full mode runs as a tagged rehearsal, hidden from views and never deleting money or audit rows.
- **Staging setup:** `deploy/` holds the Docker Compose for the VPS (Caddy, API, worker, Postgres, Redis, backups) and `apps/web/vercel.json`. One preview password covers both hosts.
- **Operations:** deploy and rollback scripts, encrypted snapshot backups with a restore drill and a real-restore tool, runbooks, ADR-0011.

All of it is proven on a local copy of staging (`pnpm staging:local:up`). Integration 294/294; e2e green except the hosting session's hero test. Committed on branch `feat/pr-009-010-admin-release` (not pushed). Next: the user provides the VPS; wire in with `docs/runbooks/staging-setup.md`.

## Staging web deployment — 21 October 2026

User confirmed dev is the staging branch. Vercel domain mapping already points to dev. Empty trigger commit 0b074fc was skipped as not affected. Added apps/web/DEPLOYMENT.md to document the branch contract and trigger a real web preview; no runtime behavior changed. Next: push dev and verify deployment plus domain.

## Update — Slack deployment notifications & fix summaries (23 October 2026)

Added automated Slack deployment notifications and fix summaries:

- `scripts/notify-slack.mjs`: parses Conventional Commits from git history into categorized Bug Fixes (`fix:`), Product Features (`feat:`), and maintenance changes, formatting a rich Slack Block Kit message. Supports `--dry-run`, custom ranges, and gracefully skips if `SLACK_WEBHOOK_URL` is omitted.
- `scripts/notify-slack.test.mjs`: unit tests (6/6 passing) verifying commit parsing, Block Kit payload structures, failure handling, and dry-run execution.
- `.github/workflows/deploy-staging.yml`: added `fetch-depth: 20` and a `Notify Slack` step running on `if: always()` after release checks.
- `docs/runbooks/staging-setup.md`: documented the optional `SLACK_WEBHOOK_URL` secret.
  Verification: all 31 script unit tests pass; `pnpm format:check` and governance pass; ESLint passes with 0 errors.

## Update — buildable-now slices, part 2 (26 October 2026)

Profile reports, CSV export, email preferences and profile photos (migrations 0030–0032) are uncommitted on `feat/profile-composition` after `4752f43`. Real-browser testing found two bugs that unit and integration tests could not: Chrome embeds an sRGB colour profile in every WebP (the server now strips it instead of refusing), and the report endpoint was missing from the API's cross-origin allow-list. Both are fixed and covered by `tests/e2e/photos-and-reports.spec.ts` and a CORS integration test. Design-stack e2e 63/63; integration 133/133. Full `pnpm test:e2e` on :3100/:4100 has still not been run on this branch.

## Update — dev merged into feat/profile-composition (26 October 2026)

dev's PR-012/PR-013 features won where both branches built the same thing; this branch adds the redesign, CSV export, staff-set fees and fee-free grants (ADR-0014, migration 0038, admin Pages screen) and turns off automatic milestone rewards. Verified on throwaway containers and the isolated design stack (web 3300, API 4300, `tipme_design`): integration 339/339 (62 files, all database files included), e2e 75/75 with `tests/e2e/stack.ts` temporarily pointed at that stack (reports/qr specs and the four tests that open `tipme_test` excluded), typecheck, lint, format, unit and docs tests. Not run: the full `pnpm test:e2e` on 3100/4100 (held by another worktree's servers). Note: an e2e run applied migration 0038 to the local `tipme_test`; reverting it was blocked, so it is still there.

# Update — Production countdown for usetipme.xyz (26 October 2026)

Work is isolated on `feat/production-countdown`, based on the verified
`feat/profile-composition` state. The launch target is 27 October 2026 at 00:00
Lagos time, represented unambiguously as `2026-10-26T23:00:00Z`.

Implementation state: user-facing routes rewrite to `/coming-soon` before the
target while preserving the requested URL; framework assets and required
operational routes remain reachable. Rewrites are no-store/noindex. At and after
the target the normal app and legacy/short redirects resume automatically, and a
direct stale `/coming-soon` request goes home. Invalid or timezone-less launch
settings fail at build/start; an unset setting leaves every non-countdown
environment unchanged.

The page uses the project wordmark, warm canvas, editorial headline, tactile
four-key timer and concentrated purple seconds key. It hides global chrome,
suppresses misclassified web-vitals telemetry, publishes a dedicated OG image,
announces time accessibly at most once per minute, disables motion when requested
and reloads the preserved route at launch. The 320px and 1440px renders were
inspected and accepted in-session.

The branch was rebased onto current `origin/dev` and is now 6 commits ahead, 0
behind. Validation on the rebased branch: `pnpm test` (54 root tests plus 18
successful package tasks, including 55 web tests), `pnpm lint`, `pnpm typecheck`,
`pnpm build` (9/9 tasks, cached), `pnpm format:check`, and focused countdown
Playwright (3/3) all pass. The earlier uncached Webpack production build also
passed. Browser coverage includes axe, 320px reflow, reduced motion, response
headers, metadata, route preservation and operational exemptions.

The launch branch remains a source change only; no live Vercel configuration or
deployment was changed. The production API origin is still a separate unresolved
launch dependency.

Whole-branch review caught the root `/opengraph-image` being rewritten to the
countdown HTML. The root image route is now exempted and unit/browser regression
tests verify it stays an image response during the gate. After the fix,
`pnpm --filter @tipme/web test`, web lint/typecheck, `pnpm build`, and focused
countdown Playwright (3/3) pass.

Release steps and the `www`/apex authority boundary are in
`apps/web/DEPLOYMENT.md`. PR #21 was merged into `dev` on 26 October 2026. Do
not treat that PR as a production deployment or production API fix.

## Navbar / copy / purpose state

Verified in the current branch: repository unit tests (web 55/API 31/contracts 9/database unit 3), typecheck, lint, build and formatting. Contract and database integration tests for purpose were added, plus checkout E2E request coverage. Database integration and browser E2E execution remain unrun because an isolated local stack was unavailable; migration 0039 was not applied.

## Recipient onboarding path

- In `feat/production-countdown`, homepage recipient journey, visible demo caption, first-day dashboard checklist (including a clearly unavailable payment/payout step), business coming-soon wording and mailto interest handoff, and E2E assertions were added. Existing unrelated changes in this worktree were preserved.
- Verified: `pnpm --filter @tipme/web test` (55/55), `pnpm --filter @tipme/web exec tsc --noEmit`, targeted ESLint, `pnpm --filter @tipme/web build`, Prettier, `git diff --check`, and Playwright test discovery (30 tests found across the two focused specs). Local browser review confirmed the full Ada caption is visible, the business-interest email draft is correctly formed, and a 400px viewport has no horizontal overflow.
- Not run: Playwright E2E execution (local stack/database not started) and any payment account onboarding.
- Business contact uses a mailto draft to `usetipme@gmail.com` (provided by the product owner); it does not submit or store data on TipMe servers. Browser-based form verification is covered by a new E2E assertion, but E2E was not executed.
- Still blocked: sandbox payment account onboarding remains on the separate Bachs branch; real payout onboarding remains blocked on D-01–D-07.
- Next exact step: integrate sandbox account setup after the Bachs branch is merged; do not describe it as a live payout path.

## /for-businesses layout fix (2026-10-27)

Recomposed into `.business-page` (max-width 44rem, centred, spaced intro with `lead-copy`) and the interest form as a raised card. Checked visually at desktop and 400px (no overflow; the browser tool constrained the requested 320px viewport to 400px). Copy and labels unchanged; E2E not run (no stack).

## Update — Bachs gap remediation (27 October 2026)

Tasks 1–14 are implemented on `feat/provider-integrations-bachs` through `9132bcc`: payment confirmation and expiry safety, clean checkout refusals, authoritative account readiness with webhook refresh, withdrawal blocking for Bachs money, a secretless worker, refund/dispute money issues (migration 0041), opaque IDs, sandbox error-shape handling, production-origin enforcement, immediate webhook reconciliation, 15-minute receipt polling and safe unknown-outcome diagnostics. The plan ledger has the per-task commands and rulings. The original nine-task checkpoint passed integration 364/364, unit 18/18 + 55/55, typecheck and lint 15/15; later tasks have targeted evidence in the ledger.

The payer-total-only public tip summary is now prepared for its own UI commit with matching design and E2E expectations. Fresh checks passed: web unit 56/56, web lint, web typecheck, targeted Prettier, `git diff --check`, and a Next production Webpack build. The default Turbopack build failed for an environment restriction (its CSS worker could not bind a local port), not a source error. Full browser E2E was not run because its setup resets the test database.
