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
