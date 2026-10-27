# Current task — faster CI (27 October 2026)

- Branch/worktree: `ci/faster` / `.worktrees/ci-faster`, from `origin/dev` at `c3e5952`.
- Before: about 7 minutes per push, set by `integration` (70 files one at a time, 303 s) and `e2e` (88 tests on one worker, 3.9 min) on 2-core runners (private repository).
- Integration files now run in parallel: `prepareTestTemplate` migrates `tipme_it` once, and with `TIPME_TEST_TEMPLATE` set each test process works in its own copy (`openTestDatabase`); `scripts/test-integration.mjs` runs them (`TEST_CONCURRENCY`, `TEST_SHARD`) and drops the copies. CI splits integration and e2e into three shards each, moves the load test and the OpenAPI check into their own jobs, reuses Turborepo results between runs, and skips integration, load and e2e on documentation-only pull requests.
- Verified locally: the new database and runner tests (seen failing first), script tests 67/67, lint and typecheck; the whole integration suite at 4 files in parallel in 142 s and 126 s (368 pass both times; the 12 backup tests fail only on macOS, where Docker cannot reach 127.0.0.1, as before); no copies left behind.

# Current task — steadier CI (27 October 2026)

- Branch/worktree: `ci/steady-builds` / `.worktrees/steady-builds`, from `origin/dev` at `c7e6612`.
- Fonts: Manrope and DM Serif Display now ship in `apps/web/src/fonts/` (OFL, Latin and Latin Extended, WOFF2) via `next/font/local`; CI run `40548134712` had failed when the Google Fonts download failed during the build.
- Load test: missed budgets (k6 exit 99) get one more run before failing (`withOneRetry` in `scripts/load-test.mjs`); the same run later missed the dashboard and profile budgets on a slow runner while the identical code measured 13 ms elsewhere.
- Verified: typography test and retry tests seen failing first; Turbopack production build passes with both fonts bundled and no Google URL in the output; the real load test passes, and with budgets scaled to 0.001 it retries once and fails with exit 99.

# Current task — public page tip readiness (27 October 2026)

- Branch/worktree: `feat/public-tip-readiness` / `.worktrees/public-readiness`, from `origin/dev` at `c7e6612`. Slice 2 of 3 of the owner-experience work (slice 1 is PR #29).
- `PublicProfile.acceptingTips` (optional; absent means true): false while new tips need the owner's own Bachs account and it isn't ready, by the same rule checkout applies (`getReadyPaymentAccount`). The profile shows "<Name> can't receive tips just yet." in place of the form.
- Cache: the owner's own setup refresh revalidates the public page at once; webhook and staff updates rely on the page cache's 30-second backstop.
- No migration. Verified: database and API readiness tests (seen failing first), web unit 56/56, API unit 36/36, typecheck 15/15, lint 15/15, OpenAPI up to date, full integration on a throwaway PostgreSQL (127.0.0.1:5434), and a browser check at 1440 and 390 px against a stand-in API (panel shown, no form, no overflow).

# Current task — owner attention (27 October 2026)

- Branch/worktree: `feat/owner-attention` / `.worktrees/owner-attention`, from `origin/dev` at `c7e6612`.
- Scope (slice 1 of 3): a "needs your attention" notice on every dashboard page plus a dot on the tab that leads to the fix (`apps/web/src/lib/owner-attention.ts`); the first-day checklist shows the real Bachs payment step; withdraw says up front when the balance can't be paid out (`DashboardSummary.withdrawalsAvailable`, the same rule `requestWithdrawal` enforces).
- No migration. Verified: web unit 64/64, API unit 36/36, typecheck 15/15, lint 15/15, OpenAPI up to date, integration 366/366 on a throwaway PostgreSQL (127.0.0.1:5434, database `tipme_oa`), and a browser check at 1440 and 390 px (notice, tab dot, fix link, notice clears, no overflow). The new accounts.spec E2E steps were not run locally; CI runs them.
- Next slices: the public page tells supporters before they fill the form; "people tried to tip you" count.

# Current task — Bachs gap remediation (27 October 2026)

- PR #24 is open and ready for review against `dev`. CI run `40500650198`
  passed static, security and integration but exposed 17 E2E assertions that
  still waited for the intentionally removed “receives … after fees” copy.
  The shared visitor helper and direct checkout, shell, quality, moments and
  pricing specs now wait for the concise authoritative “You pay …” total.
  Pricing coverage still checks the exact 8% and fee-free recipient outcomes
  from the quote response; those details are not restored to the supporter UI.
- Fresh checks after the E2E correction: `pnpm typecheck` (15/15), `pnpm lint`
  (15/15), `pnpm test` (55/55 root tests; 18/18 workspace tasks), Playwright
  discovery (88 tests), targeted Prettier and `git diff --check` passed. A full
  local E2E run could not start because port 4100 belongs to the active
  `.worktrees/physical-interface` API and was left untouched. The first local
  attempt also found a pre-existing partial migration in shared `tipme_test`;
  no shared database was reset or altered. Final full E2E verification is the
  clean PR runner after this correction is pushed.
- Branch `feat/provider-integrations-bachs`, continued from `ddd3f56` at the user's request. Plan: `docs/superpowers/plans/2026-10-27-bachs-gap-remediation.md`; Tasks 1–14 and rulings are recorded in `.superpowers/sdd/2026-10-27-bachs-gap-remediation/progress.md`. Current implementation head before the UI commit: `9132bcc`.
- Fixed: Bachs payments can be confirmed (callers pass the quoted TipMe share); expiry never cancels a collected-but-unsettled payment; definite 4xx checkout refusals fail cleanly (`PAYMENT_START_REJECTED`); one readiness rule with Bachs' real fee responsibility; account/capability webhooks re-read the account; withdrawals of Bachs-collected money refused (`WITHDRAWAL_UNAVAILABLE`); worker holds no webhook secret; refunds/disputes raise `payment_reversed` money issues (migration 0041); opaque Bachs IDs; `ddd3f56` compile breaks fixed.
- Verified: integration 364/364 (69 files, throwaway PostgreSQL 16 on 127.0.0.1:5434 and Redis on 6380, no shared database touched); `pnpm test` 18/18 tasks and 55/55 root tests; `pnpm typecheck` 15/15; `pnpm lint` 15/15; `pnpm format:check`; `pnpm api:openapi --check`; generated docs unchanged; `git diff --check`.
- Later sandbox checks exercised connected-account setup and checkout behavior; see the local validation record below and the plan ledger for the follow-up fixes. Full E2E remains unrun in this worktree.
- Payer-total-only tip-form UI is ready to commit with its design record and E2E expectations. Fresh validation: web unit tests 56/56, web lint and typecheck passed, and the Next production Webpack build passed. The default Turbopack build could not be used in this environment because its CSS worker was denied permission to bind a local port. No checkout or payment was submitted by these UI checks.
- Still open (live blockers): refund/dispute ledger handling, Bachs payouts, automated reserve monitoring, confirming Bachs event names/statuses with captured sandbox fixtures, a provider-neutral account interface. The stuck sandbox attempt `01a17c0b…` still needs a Dashboard check before any retry.

# Current task — recipient onboarding, business page and tip purpose (27 October 2026)

- Branch: `feat/recipient-onboarding-and-tip-purpose`, based on current `origin/dev`. PR #21 already merged and is not being reused.
- Scope: recipient onboarding guidance on the homepage/dashboard; business coming-soon and voluntary mailto interest path; navbar/copy cleanup; optional structured tip purpose through contract, API, database migration, checkout form and recipient detail; `/for-businesses` layout alignment.
- Migration `0039_tip_purpose` is additive and was not applied by this work. The Bachs branch has since been rebased onto its merge and now follows it with `0040_bachs_sandbox_recovery`; the migration-number collision is resolved.
- Earlier local checks passed: `pnpm test` (54 root tests and all 18 package tasks), `pnpm typecheck` (15/15), `pnpm lint` (15/15), `pnpm build` (9/9), `pnpm format:check`, and `git diff --check`.
- PR CI run `40424132431` exposed a stale OpenAPI file, two outdated onboarding assertions, and four desktop/mobile screenshot mismatches. Follow-up commit `94ac1ab` regenerated the OpenAPI document, corrected the assertions, and added failure-only PNG diagnostics with three-day retention.
- CI run `40426539167`: integration, security, static, Vercel, dashboard and welcome checks passed; E2E had only four visual failures. The expected/actual/diff images were reviewed at desktop and mobile. Differences were the intended purpose selector and approved navigation/footer/test-mode copy; the profile composition remained readable with no overlap. All eight Darwin/Linux visual baselines have now been refreshed.
- Verified in this worktree: `pnpm build` (9/9), `pnpm api:openapi --check`, targeted Prettier, `git diff --check`, Playwright discovery (4 onboarding tests), and the focused visual specs (4/4) after updating Darwin snapshots. Linux baselines were taken from the reviewed CI actual images. Full local E2E was not run because the normal port 4100 API belongs to `.worktrees/physical-interface`; it was left running and untouched. The focused visual run used the built PR web app and read-only local API; no database reset occurred.
- CI run `40431576309` passed after the code/baseline updates; final-head run `40432964292` also passed E2E, integration, static, security, and Vercel. PR #23 was subsequently merged into `dev` at `da0c62a`.
- No migration was applied and no payment operation occurred. The only deployment was the PR preview. The full E2E suite passed in CI; local full E2E remains unrun because port 4100 is occupied by the active API in `.worktrees/physical-interface`.

# Current task — Bachs sandbox integration safety and routing (26 October 2026)

- Branch/worktree: `feat/provider-integrations-bachs` /
  `.worktrees/provider-integrations-bachs`, rebased onto `origin/dev` at
  `da0c62a`. The rebase completed without remaining conflicts; commits
  `0084177` and `788bd28` contain the accepted sandbox-funds-flow ADR and
  implementation. Draft PR #24 is open against `dev`; the branch is published.
- The typed Bachs REST adapter, recipient-account persistence, one-shot
  checkout-start claim, durable `UNKNOWN` outcome, signed webhook correlation,
  API account/onboarding/webhook routes, and audited staff recovery workflows
  are implemented in this worktree. Recovery covers ambiguous checkout IDs and
  recipient-account creation; it never retries provider writes or manually
  marks payments paid.
- Reconciliation, expiry and staff re-check now resolve provider adapters by
  the persisted attempt/payout provider. A focused database integration test
  covers historical mock/Bachs attempt routing.
- Checkout recovery requires a matching open issue, a dashboard-found checkout
  ID, an authoritative Bachs read, and exact expected amount/currency. Not-found
  or mismatch remains `UNKNOWN` and unlinked. Account recovery requires verified
  recipient email, staff attestation to dashboard identity/fee settings, and a
  successful server-side account fetch; payouts stay disabled.
- **Bachs sandbox is selectable in test/preview only** (user-approved).
  Production still rejects it, credentials need `sk_sandbox_`, and
  `PAYMENTS_LIVE_ENABLED` remains literal `false`. Checkout UI and recipient
  onboarding card were updated; see HANDOFF.md.
- Product-owner UI follow-up (27 October): the public tip quote now displays
  only the exact payer total. Fee breakdown, recipient net, and policy-version
  copy are removed; the API quote and payment calculations are unchanged. This
  conflicts with PRD v1.1's fee-treatment disclosure requirement; revisit before
  enabling real payments.
- Verified the UI change with `pnpm --filter @tipme/web test` (55/55),
  `pnpm --filter @tipme/web lint`, `pnpm --filter @tipme/web build`,
  `pnpm typecheck` (15/15), targeted ESLint/Prettier, and `git diff --check`.
  A local browser smoke on Ada's profile selected NGN 5,000 and showed only
  “You pay NGN 5,000.00”; no checkout was submitted. E2E was not run because
  its global setup resets `tipme_test`.
- Migration `0040_bachs_sandbox_recovery` now follows merged
  `0039_tip_purpose`, combining the Bachs schema and issue-kind changes while
  preserving the custom transition trigger. Superseded Bachs migration files
  were removed; Drizzle generation reports no schema drift.
- Staging Compose now forwards Bachs sandbox credentials to both API and
  worker, and forwards `RELEASE_KIND` to the worker. The staging env example,
  runbook, ADR, OpenAPI/access-control docs, and webhook-signature regression
  test were reconciled.
- Bachs has no checkout lookup by TipMe reference/idempotency key and its
  successful idempotency cache is limited to 24 hours. Unknown writes are never
  retried. Bachs payouts remain unsupported; recipient onboarding UI now exists
  on dashboard settings.
- Live payments remain blocked by D-01 through D-07, written provider approval,
  legal/risk review, and reconciliation of Bachs direct-charge
  merchant-of-record behavior with the proposed custodial model in ADR-0006.
- At implementation/CI time, no Bachs credentials or provider API requests were
  used; adapter tests used fake transport. See the local sandbox validation
  below for the later operator-approved test. Resend/auth work is outside this
  task; D-11 remains open.
- Verified after the CI fixes: `pnpm build` (9/9), `pnpm typecheck` (15/15),
  `pnpm lint` (15/15), `pnpm format:check`, `pnpm test` (55 root tests and
  18/18 workspace tasks), CI-pinned Gitleaks (102 commits scanned, no leaks),
  and `git diff --check` passed. Targeted integration tests passed 23/23 on a
  disposable local PostgreSQL container; no shared or staging database was
  reset. The full integration suite was not run locally.
- Moved the PostgreSQL-dependent recovery test into `tests/integration/`,
  corrected the mismatched provider-reference assertion, narrowed the
  historical Gitleaks exception to one fingerprint, and refreshed all four
  Darwin/Linux profile snapshots. Focused visual Playwright passed 4/4;
  Darwin snapshots used a temporary config and read-only requests to the
  existing local API. Linux snapshots use the reviewed CI actuals.
- CI run `40452019057` passed static, security, integration and E2E on
  implementation commit `141f100`; the Vercel preview also passed. PR #24
  remains open and draft.

## Local sandbox validation (27 October 2026)

- Copied the user's ignored root `.env` and `apps/web/.env.local` into this
  worktree; both are mode `0600`. The root `WEB_ORIGIN` is `http://localhost:3001`
  because another local Node process already owned port 3000. No secrets were
  printed or tracked.
- `pnpm build`, `pnpm db:migrate`, and `pnpm db:seed` passed. The local
  `tipme_local` database is on the existing shared local Postgres container
  (Compose project `tipme`); it was migrated and seeded, not reset. Existing
  local Redis was reused.
- Local web is left running at `http://localhost:3001`, API at
  `http://localhost:4000`, and the Bachs-configured worker is running.
  `/health` and `/@ada` returned HTTP 200. Browser smoke completed recipient
  sign-in using the pretend inbox, confirmed a synthetic local email, and
  created a sandbox recipient account; the API returned `ACTIVE` with charges
  enabled.
- Guest quote creation returned HTTP 201. One Bachs checkout-start attempt
  returned HTTP 503 `PROVIDER_OUTCOME_UNKNOWN`; the API logged `BachsApiError`.
  Attempt `01a17c0b-8042-7715-9858-156eb54b83fb` is durably `UNKNOWN`, has no
  provider reference, and its tip remains `AWAITING_PAYMENT`. The worker opened
  a `payment_unresolved` issue. No card details were entered and no payment was
  submitted; the Bachs sandbox API was contacted for account setup and checkout
  initialization. No live payment, staging change, or production change.
- The exact Bachs HTTP status/provider code was not logged, so the checkout
  failure's cause is unresolved. Do not retry this attempt or create another
  checkout until the open issue is checked against the Bachs sandbox dashboard
  and resolved through the authoritative recovery flow. The provider adapter
  has no lookup by TipMe operation reference.
- Tracked Next.js dev-generated changes were reverted; no application source
  change remains. `git status` was clean before this continuity update.

- Next exact step: inspect the open `payment_unresolved` issue and the matching
  Bachs sandbox dashboard record for the attempt above. Do not retry its
  checkout. Keep live payments disabled and PR #24 unmerged until the outcome
  and error cause are understood.

# Current task — Production countdown for usetipme.xyz (26 October 2026)

- Branch: `feat/production-countdown`, isolated in `.worktrees/profile-composition`.
- Delivered: strict server-only launch parsing, pre-launch rewrites with no-store
  headers, automatic release at `2026-10-26T23:00:00Z`, accessible countdown,
  physical/editorial responsive styling, social image, telemetry suppression and
  focused browser coverage.
- No Vercel setting, production domain or live deployment has been changed.
- Rebased onto current `origin/dev`; the branch is now 6 commits ahead and 0
  behind.
- Verified on the rebased branch: `pnpm test` (54 root tests plus 18 package
  tasks, including 55 web tests), `pnpm lint`, `pnpm typecheck`, `pnpm build`,
  `pnpm format:check`, and focused countdown Playwright (3/3).
- Whole-branch review found the root `/opengraph-image` was rewritten during the
  countdown. It is now exempted and covered by both unit and browser regression
  assertions; web tests, lint, typecheck, production build and focused
  Playwright (3/3) pass with the fix.
- `pnpm build` passed (9/9 tasks; cache hits). The earlier uncached Webpack
  production build also passed. The focused browser run covers axe, 320px
  reflow, reduced motion, headers, metadata, route preservation and exemptions.
- Visual inspection: 320px and 1440px captures both match the approved direction
  and have no horizontal overflow.
- No production settings or deployment have changed. Production API origin is
  still a separate unresolved launch dependency.
- PR #21 was merged into `dev` on 26 October 2026. Production deployment and
  API configuration remain separate.

# Previous task — PR #19 Linux visual baselines (26 October 2026)

- CI confirmed the branch needed Linux-only screenshots in addition to its Darwin baselines. The first container-generated PNGs were visually sound but did not match GitHub's Ubuntu runner.
- The temporary snapshot-capture run `40261761860` passed its four targeted visual tests in update mode and uploaded the runner-generated baselines. Those four images have been reviewed; their composition matches the app and no source or test behavior changed.
- The temporary workflow instrumentation has been removed; the normal `pnpm test:e2e` command is restored. The four Linux images now come from the exact GitHub runner.
- Standard verification passed on commit `41c787d`: E2E 5m19s, integration 6m57s, security, static, and both Vercel previews all passed. PR #19 is open and mergeable.
- No further code changes are pending. Next step is product-owner review and merge when authorized.

# Current task — Merge dev into feat/profile-composition (26 October 2026)

- The user chose: dev wins where both branches built the same feature; keep this branch's design, CSV export, staff-set fees and fee-free grants, and no automatic rewards.
- Backend (database, domain, contracts, API) taken from dev, then: migration 0038 (`custom_fee_bps`, `fees.manage`), staff pricing endpoints under `/v1/ops/pages/:profileId/{pricing,fee,fee-free}`, a Pricing card on the admin Pages screen, CSV export, milestone rewards off, reserved handles for short links. Web: redesign merged into dev's split views (`*-view.tsx`), dev's report, photo, search and notification UI kept.
- Verification and open items: see HANDOFF.

# Current task — Buildable-now slices, part 2 (26 October 2026)

- Uncommitted on `feat/profile-composition` (after `4752f43`): profile reports (migration 0030), CSV export, email preferences (0031), profile photos (0032) with staff removal, the staff account page's photo, and fixes found in a real browser: the server now strips the sRGB colour profile Chrome always embeds (every upload was refused), and `POST /v1/profiles/:handle/report` is allowed cross-origin for the web app only (every browser report failed its preflight). Photo alt text no longer calls real people "fictional". New e2e spec `tests/e2e/photos-and-reports.spec.ts`.
- Verified: integration 133/133 on throwaway containers (OpenAPI regenerated); checkout API 18/18 with a new CORS test; avatar tests 3/3 in domain (incl. a Chrome-shaped file) and 3/3 integration; domain 31/31; web 38/38; typecheck 15/15; lint 15/15; diff-check. Design-stack e2e: see HANDOFF.
- Environmental: the never-reset `tipme_design` still holds one fee-free credit for Ada from the old automatic rewards, so one checkout test shows a fee-free quote there.
- Next exact step: product-owner review, then commit (not yet authorised for this part).

# Branch publication — profile composition (26 October 2026)

- User selected `feat/profile-composition` and authorized publishing all changes in its isolated worktree. The separate `feat/physical-interface` worktree was left untouched.
- The complete worktree includes the profile composition, theme rollout, short links/wordmark, welcome flow, staff account/fee operations, and migration 0029.
- Validation: `pnpm build` passed (9/9 tasks, including Next production build and type generation); `pnpm test` passed (43 root script tests and package tests, 0 failures); `pnpm typecheck` passed (15/15 tasks); `pnpm lint` passed after fixing the two new account-page effect warnings; `pnpm format:check` and `git diff --check` passed.
- The first lint/format pass exposed two hook lint errors and four formatting issues; these were corrected, then build, lint, and format checks passed again. E2E and database integration suites were not run in this turn.

# Current task — Remaining screens (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): `QuietScreen` for 404/unavailable/profile error plus new `app/error.tsx` and `app/global-error.tsx`; themed staging password page; recessed loading placeholders; staff charts fixed (text out of stretched SVGs); favicon from the wordmark heart. Staff pages all reviewed: axe clean, no overflow at 1440.
- Verified: web 36/36, UI 4/4, domain 25/25, governance 2/2, typecheck, lint (clean), Prettier, diff-check; e2e 57/58 with no baseline changes.
- The one e2e failure and earlier "flakes" are explained by the never-reset local `tipme_design`: Ada crossed the milestone reward, so her quote shows reduced fees (NGN 1,970.00 instead of 1,870.00), and the demo number hit the 3-codes-per-hour limit. The real suite resets its database; run full `pnpm test:e2e` on :3100/:4100 before merging.
- Next exact step: product-owner review, then commit in pieces.

# Current task — Master wordmark and /handle short links (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): wordmark from the product owner's SVG (header, footer, share image; Nunito removed), `/handle` → 308 `/@handle` in `proxy.ts` via `shortLinkTarget`, 68 reserved handles, and a test that every single-word route/public folder is reserved.
- Verified: real HTTP checks (/ada, /Ada, ?src=qr → 308; pages and non-handles untouched); web unit 36/36, domain 25/25, UI 4/4, governance 2/2; typecheck, lint (now fully clean), Prettier, diff-check; e2e regression 53/54 with visual baselines re-accepted after inspection.
- The one failing e2e test (sign-out) is environmental: the API sends at most 3 sign-in codes per number per hour (silently), and repeated local runs on the never-reset `tipme_design` exhausted it for the demo number, so the helper read a stale code. A receipt test once stayed on "Loading your tip" right after a server restart and passed on rerun; not root-caused.
- Next exact step: before release, query the live database for existing handles that are now reserved; then commit in pieces.

# Current task — Theme rollout: remaining pages (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): recover, verify-email, profile loading state, QR page and print view, weekly report, notification bell and toasts, staff area headings, empty state, dev inbox. Emails are plain text with no template: nothing to theme until a messaging provider is chosen (D-11).
- Verified on a clean production build: dashboard, notifications, shell, quality (axe and 320px reflow), welcome, checkout, accounts and hardening all pass (excluding the 4 tests wired to :4100/`tipme_test`). One checkout test timed out once right after a server restart, then passed 3 times. Design-system baseline re-accepted after inspection (empty-state title). Web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- A staff owner was granted on the local `tipme_design` database only, to review the staff pages.
- Next exact step: product-owner review; full `pnpm test:e2e` on :3100/:4100 once free; reconcile with the other agent's dashboard refactor; commit in pieces.

# Current task — Theme rollout slice 3: dashboard (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): dashboard home recomposed (page card with "Finish setting up"), segmented navigation and filters, serif titles, black in-card actions, withdraw instrument, quieter tip proof, shared neutral notice restyled. Decisions in `docs/design/DECISION-LOG.md`.
- Verified on a clean production build (signed-in recipient with pretend tips): 58/62 of the regression set including dashboard, notifications and the first-day → tip → proof → withdrawal journey. The 4 failures are environmental: design-system baseline (re-accepted after inspection), `qr.spec` hardcodes `127.0.0.1:3100` in expected text, `reports.spec` posts to a hardcoded `:4100` (Codex's API; it failed there without effect). `moments.spec` was not run at all because it would create tips on :4100. Web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Not visually reviewed: the weekly report page and QR print view (no report existed for the session).
- Next exact step: product-owner review; then run the full `pnpm test:e2e` on :3100/:4100 once free, and plan commits (font fix, profile, onboarding, public pages, dashboard). Another agent has an uncommitted dashboard refactor (`*-view.tsx` split) in the main checkout that will need reconciling.

# Current task — Theme rollout slice 2, part 2 (25 October 2026)

- Delivered (uncommitted, `feat/profile-composition`): header and footer redesigned, restrained purple button shadow (token and hover), receipt on theme, share-image text corrected ("No real payments"). Pretend checkout intentionally left neutral.
- Verified on a clean production build: 56/56 of the regression set (excluding the 4 tests wired to :4100/`tipme_test`); profile and design-system baselines re-accepted after inspection; web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Next exact step: slice 3 — dashboard (home, tips, tip detail, withdraw, QR and print, reports, settings) with a gentle "finish setting up" card while the page is not live.

# Current task — Theme rollout slice 2, part 1 (25 October 2026)

- Delivered on `feat/profile-composition` (uncommitted): pages fill the screen; canvas background; public pages (home, how it works, for creators, about, legal, not found) on theme; `.tip-instrument` shared; stale copy corrected (about page needs product-owner review). Decisions in `docs/design/DECISION-LOG.md`.
- Verified on a clean production build: 56/56 of the regression set (excluding the 4 tests wired to :4100/`tipme_test`), design-system baselines re-accepted after inspection (canvas, label case), profile baselines unchanged; web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Next exact step: slice 2 part 2 — tip status/receipt and the pretend checkout page; then slice 3 (dashboard).

# Current task — Theme rollout slice 1: shell and onboarding (25 October 2026)

- Same branch/worktree (`feat/profile-composition`), uncommitted, on top of the approved profile work. Design: `docs/superpowers/specs/2026-10-25-theme-rollout-design.md`; decisions in `docs/design/DECISION-LOG.md`.
- Delivered: themed header/footer (single "Create your page" action; guest actions hidden on dashboard routes via CSS), sign-up/sign-in as an editorial stage plus floating card with sign-up progress, handle step with live link preview and corrected copy (renames are possible; real host instead of `tipme.app`, also in Settings), and `/dashboard/welcome` (greeting, three skippable steps with live preview, server-confirmed go-live, share). Claiming a handle now lands on the welcome. Elevation roles promoted to UI tokens.
- Verified on a clean production build (:3300/:4300, `tipme_design`): welcome 3/3; accounts + hardening + welcome 8/10 (2 failures read Codex's :4100 API or `tipme_test` directly — environment; the cache-backstop test's UPDATE matched no rows there); shell + quality (axe, 320px reflow, nav) all pass; checkout 17/17 excluding the 2 DB-coupled tests; profile and design-system baselines re-accepted after inspection (header/footer change). Web unit 33/33, UI 4/4, governance 2/2, typecheck, lint (0 errors), Prettier, diff-check pass.
- Next exact step: product-owner review of slice 1; then slice 2 (public pages, tip status, pretend checkout). Run full `pnpm test:e2e` once :3100/:4100 are free. Never point DB-coupled e2e tests at another agent's database.

# Current task — Design Correction Directive 001: profile recomposition (25 October 2026)

- Branch `feat/profile-composition` in worktree `.worktrees/profile-composition`, from `bead3e5` (`feat/physical-interface`). Isolated because `.worktrees/physical-interface` had live uncommitted edits by another agent (Antigravity, 11:09–11:18; dev server :3100) and Codex owns API :4100 / `tipme_test`. Their WIP (incl. hardcoded fake tags and a status-page restyle) is untouched; a copy of that diff was saved outside the repo.
- Rejected screenshot root cause: :3100 `next dev` had no API origin, so it read the main checkout's stale dev DB (no portrait). Separately, font tokens never resolved (next/font variables on `<body>`, tokens on `:root`) — every page rendered in default fonts.
- Delivered: portrait-led overlapping composition (desktop) and sequenced mobile; RecipientPortrait/RecipientIdentity split; matted monogram fallback; compact profile-scoped tipping instrument (₦ keys, black action, recessed quote); font variables moved to `<html>`; AvatarImage uses eager/high-priority loading (Next 16 deprecates `priority`) and no setState-in-effect; Concept A stored under `docs/design/reference/` with provenance; decisions logged.
- Round 2 (same day): composition constrained to measured Concept A proportions; recessed keys; small panel title; optional name/remember behind a disclosure on the profile only (e2e helpers open it). Verified on a clean production build: 48 passed, 2 DB-coupled failures as before; profile baselines re-accepted after inspection; design-system baseline unchanged and passing. Turbopack reused stale CSS from `.next/cache` after Python-written edits, in both dev and build; delete `apps/web/.next` before trusting a rebuild.
- Uncommitted. Next exact step: product-owner visual review against Concept A, then decide commit/merge relative to `feat/physical-interface` and the other agent's WIP.

# Current task — Physical Interface planning (25 October 2026)

- Branch: `feat/physical-interface` in isolated worktree `/private/tmp/tipme-physical-interface`, based on committed revision `0ee4c3c`.
- User approved the supplied three-column board as the high-fidelity UI target: 60% Physical Interface, 30% Editorial Interface, 10% Playful Interface.
- Completed a read-only audit and wrote the approved design specification plus implementation plan. No production UI, payment behavior, contract, migration, or runtime configuration changed.
- Baseline setup: `pnpm install --frozen-lockfile`; clean artifacts restored with `pnpm build`.
- Baseline verification: `pnpm test` passed after build with 42/42 script tests and all 17 Turbo tasks successful. The first pre-build sandboxed run failed because `dist` artifacts were absent and loopback binding was denied; those were setup limitations, not product failures.
- Awaiting plan review and execution-method choice before implementation.
- Fresh builder-readiness review found and the plan now resolves test-script, screenshot-ordering, seeded-portrait, edge-fixture, success-state, and D-09 approval gaps. The original board image still needs to be copied into repository custody before final parity can be approved.
- Next exact step: review `docs/superpowers/specs/2026-10-25-physical-interface.md` and `docs/superpowers/plans/2026-10-25-physical-interface.md`, then execute Task 1 test-first.

# Previous task — Slack deployment notifications & fix summaries (23 October 2026)

# PR #18 — Staging Compose validation failure (25 October 2026)

- CI's placeholder-only Compose validation failed because the staging example intentionally leaves secrets blank, while `${VAR:?}` treats unset and blank values as errors.
- Added test-only values to the workflow for every required secret, including the separated Postgres roles. Kept the example file blank and Compose's deployment-time required-variable guards unchanged.
- Local equivalent of the workflow's `docker compose ... config --quiet` passed; Prettier and `git diff --check` passed.
- No deploy, staging/production change, or real credential was used. Next step: let PR #18 checks rerun after push.

# Slack deployment notifications & fix summaries — 23 October 2026

Added Slack deployment notification integration via incoming webhook. Formats release outcomes and automatically parses Conventional Commits to extract categorised bug fixes (`fix:`), product updates/features (`feat:`), and version details with direct links to the web app, API, and commit/run URLs. Integrated into `.github/workflows/deploy-staging.yml` and documented in `docs/runbooks/staging-setup.md`. Requires repository/environment secret `SLACK_WEBHOOK_URL` (gracefully skips if not configured).

# CI rename redirect assertion — 22 October 2026

- Active branch: `feat/hardening`, based on `5e18764`. The primary `dev` worktree is untouched.
- Reproduced CI run `39768906443` locally: the rename succeeds, but the test reads the URL synchronously after `goto`, before the streamed redirect finishes. The trace shows successful requests to the renamed URL between repeated visits to the old URL.
- Changed only `tests/e2e/hardening.spec.ts`: use Playwright's retrying `toHaveURL` before retrying navigation, and assert `?src=qr` is preserved. Existing page-content and old-handle reservation assertions remain.
- Verification: original assertion failed locally; corrected rename test passed 5/5 repetitions. Targeted Prettier, ESLint and `tsc -p tsconfig.tools.json` passed. Full `pnpm test:e2e` passed: fresh build and 64/64 tests (56.5s), exit 0. `git diff --check` passed.
- No application, payment, migration, environment or deployment settings changed.
- Next exact step: push this narrow fix to `feat/hardening` and verify the new GitHub Actions run. Do not merge or change staging routing as part of this fix.

# Staging web deployment — 21 October 2026

User confirmed dev → staging.usetipme.xyz; main → www.usetipme.xyz. Latest dev trigger commit 0b074fc is empty and Vercel marks it Skipped — Not affected. Adding an app-scoped deployment note to create an affected preview build; verify Vercel and the custom domain after push. No application behavior or domain mapping changed.

# PR-010 status (release rehearsal and staging) — 20 October 2026

PR-010 is built, proven on a local copy of the staging stack, reviewed and fixed. Evidence: `docs/PR-010-VERIFICATION.md`, ADR-0011; ledger `.superpowers/sdd/2026-10-19-pr010/progress.md`.

- **Committed, not pushed:** branch `feat/pr-009-010-admin-release` (from the hosting session's `feat/free-private-demo`): one commit with the PR-009 review fixes, one with PR-010.
- **Waiting on the user:** the VPS (then `docs/runbooks/staging-setup.md`), DNS and the Vercel project. The free Render/Neon demo was "just a test", not staging.
- **Failures owned by the concurrent hosting session:** hero-copy e2e, preview-gateway unit test, unformatted files.
- **Next exact step:** the user decides whether to push; then provides the VPS for wiring in. Stop before any new PR.

# PR-009 status (admin, issues, analytics) — 19 October 2026

PR-009 implementation, final review and review fixes are done; evidence in `docs/PR-009-VERIFICATION.md`, ledger `.superpowers/sdd/2026-10-19-pr009/progress.md`.

- The two review fixes (ops lockout under parallel codes; pause-reason warning) are committed on `feat/pr-009-010-admin-release`. The whitespace-only reformat of the hosting session's `globals.css` and `brand.tsx` was reverted.
- The PR-009 gate is green except failures from the concurrent hosting session's files (format, preview-gateway unit test, hero heading e2e).
- PR-009 deferred minors await the user's decision.

# Current task — free private demo deployment

19 October 2026: user chose a private demo with pretend payments and free hosting only. Wants the app online. No hosted resources provisioned yet.

- Proposed: one Render free web service containing web/API/worker behind a shared-password gateway, Neon free Postgres, Render free Key Value. Pending feasibility test and user response on accounts and demo limitations.
- Free Render sleeps after 15 minutes idle; background jobs pause. Free Key Value loses state on restart. Neon compute allowance must be monitored; worker polling can keep the database awake.
- Must validate combined service memory against the free instance, protect every public entry point, keep real payments disabled, and add an explicit hosted-preview mode rather than exposing development mode.
- Docker is available locally; Postgres, Redis and Jaeger healthy. No deployment configuration or application code changed yet.
- Next exact step: confirm Render/Neon account availability, settle proposed preview design, then implement and test the deployment slice. Account secrets must not be pasted into chat.

## Previous task record

# Current task — Git import and hosting assessment

19 October 2026: user authorized repository inspection, Git setup, logical commits and push. No hosting deployment is authorized or performed in this task.

- Initialized main; no prior Git history existed. Six logical import commits are complete; final worktree verification was clean.
- Existing PR-009 source is present; the prior active-task status below is stale. Preserve it; do not restart or claim PR-009 complete.
- See docs/HOSTING-ASSESSMENT.md for hosting blockers and current verification.
- User authorized pushing to their account. Created private https://github.com/TheSaviourEking/Tipme and pushed the six import commits; main tracks origin/main.
- Next exact step: agree hosting budget, domain and preview scope, then scope deployment readiness. No hosting deployment performed.

## Prior task record (historical)

# Active task

PR-003 to PR-008 are complete.

- PR-008 evidence: `docs/PR-008-VERIFICATION.md`. The ledger, with every ruling and deferred minor, is `.superpowers/sdd/2026-10-19-pr008/progress.md`. See also ADR-0003, ADR-0009 and the ADR-0006 addendum.
- Earlier evidence: `docs/PR-003-VERIFICATION.md` to `docs/PR-007-VERIFICATION.md`. Ledgers are under `.superpowers/sdd/`.

## Still open

- PR-008 deferred minors (ledger, `Final: minor (deferred)`), awaiting the user's decision.
- Whether expiring a tip the provider still reports as `pending` is right for a real provider (revisit with ADR-0004).
- D-03 (provider), D-04 (custody), D-05 (fees and promotions), D-06 (recipient verification) and D-08 (messaging providers) remain OPEN. All money, rewards and deliveries are pretend.

## Next exact step

Stop. PR-009 (analytics and ops view) needs explicit authorisation.

## Navbar, "test mode" copy and tip purpose (uncommitted)

- Navbar: "For individuals" (still `/for-creators`) and "For Businesses" (new `/for-businesses` coming-soon page, replacing "See a demo page").
- "Pretend" wording replaced with neutral "Test mode" across web copy; real payments remain unapproved, so a test-mode notice stays.
- Structured optional tip purpose: contracts `tipPurposes`, `tips.purpose` column + migration `0039_tip_purpose` (not applied to any database), form select, recipient tip detail.

## Recipient onboarding path (uncommitted)

- Homepage clarifies that Ada is a fictional demo, surfaces the create-page action, and explains the three recipient setup steps. The portrait caption is constrained so the overlapping tip panel does not cover it.
- The first-day dashboard now guides recipients through profile details, publishing, and sharing tools, with a payment/payout step clearly marked unavailable pending provider and funds-flow approvals.
- Business page copy states that business accounts are not open and no launch date has been announced; it links to individual signup and provides a mailto draft to `usetipme@gmail.com`. Submissions are not stored by TipMe; the visitor must send the draft.
- The separate Bachs branch has sandbox account onboarding, but it is not integrated into this UI branch; no live payout flow is represented here.
