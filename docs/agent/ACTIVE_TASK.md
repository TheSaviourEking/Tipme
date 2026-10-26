# Current task — Production countdown for usetipme.xyz (26 October 2026)

- Branch: `feat/production-countdown`, isolated in `.worktrees/profile-composition`.
- Delivered: strict server-only launch parsing, pre-launch rewrites with no-store
  headers, automatic release at `2026-10-26T23:00:00Z`, accessible countdown,
  physical/editorial responsive styling, social image, telemetry suppression and
  focused browser coverage.
- No Vercel setting, production domain or live deployment has been changed.
- Verified: `pnpm --filter @tipme/web test` (55/55), web lint, web typecheck,
  Prettier check on the changed files, and `git diff --check`. Earlier focused
  countdown Playwright (3/3) and production Webpack build also passed. Turbopack
  cannot bind its CSS worker port in this execution sandbox; the supported
  Webpack builder completed successfully after fetching configured fonts.
- Visual inspection: 320px and 1440px captures both match the approved direction
  and have no horizontal overflow.
- The worktree is 8 commits behind and 5 commits ahead of `origin/main`; these
  local changes do not make the branch integration-ready.
- Next exact step: reconcile with the current `dev` target, then run full
  repository gates and a fresh whole-branch review before opening a PR.

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
