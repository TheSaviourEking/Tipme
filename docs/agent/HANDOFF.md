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
