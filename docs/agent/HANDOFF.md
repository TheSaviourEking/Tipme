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
`apps/web/DEPLOYMENT.md`. PR #21 is open against `dev`; the latest GitHub checks
were still running. Next exact step: monitor CI and Vercel preview, address any
failures, then verify staging after merge. Do not treat the PR as a production
deployment or production API fix.
