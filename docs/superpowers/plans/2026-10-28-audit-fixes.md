# Flow audit fixes — roadmap and Phase 1 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every gap found in the 28 October 2026 flow audit, except real SMS/email (excluded by the product owner).

**Architecture:** Five phases. Phase 1 is code that needs no decision and is planned task by task below. Phase 2 is settings on GitHub and the staging server. Phases 3–5 each need decisions first; each gets its own ADR or spec, then its own plan.

**Tech Stack:** pnpm/Turborepo monorepo; NestJS API and worker; Drizzle/PostgreSQL; Next.js 16 web; node:test and Playwright.

**Spec:** the flow audit (28 October 2026, in the conversation; summarised under "Roadmap"), `docs/00-DECISIONS.md`, ADR-0004, ADR-0006, PRD v1.1 FR-08.

## Global Constraints

- No real payments: Bachs sandbox only; `PAYMENTS_LIVE_ENABLED` stays false (D-03–D-06 OPEN).
- Integer minor units and explicit currency; ledger postings balance, are append-only and are written transactionally (AGENTS.md financial invariants).
- A payment outcome comes only from a signed provider event or an authoritative provider read; TipMe never invents one.
- Test-first: every task starts with a failing test.
- Integration tests run through `pnpm test:integration` (`scripts/test-integration.mjs`), never against the shared `tipme_test` database by hand.

## Review Focus

1. A rehearsal issue for a run that is still open must stay open (only finished runs are cleaned) — Task 1 test.
2. An account Bachs created but not yet activated must offer "Continue setup", never "restricted" — Task 2 test.
3. A request that fails after it was sent (timeout, 5xx) must still be "uncertain", not "refused" — Task 3 test.
4. A page whose photo exists must still show the photo, not the monogram — Task 4 test.
5. A release run that never finished (crashed) keeps its attempts checked, so a real misreport is still found — Task 1 test.

---

## Roadmap

| Phase | Item                                                                                                  | Who                                                                                                           | Status                                                    |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1     | Release-check leftovers (issues and attempts that never close)                                        | Claude                                                                                                        | Planned below (Task 1)                                    |
| 1     | A Bachs account not yet activated shows "restricted"                                                  | Claude                                                                                                        | Task 2                                                    |
| 1     | Checkout requests rejected before sending show "uncertain"                                            | Claude                                                                                                        | Task 3                                                    |
| 1     | Initials squeezed into the portrait corner                                                            | Claude                                                                                                        | Task 4                                                    |
| 2     | Staging watch never runs                                                                              | Owner approves, Claude sets two repository variables (`STAGING_API_URL`, `STAGING_WEB_URL`)                   | Needs OK                                                  |
| 2     | Staging has no error reporting                                                                        | Owner creates a Sentry project for TipMe and puts its DSN in `/srv/tipme/staging.env`                         | Owner                                                     |
| 2     | No off-site backup copy                                                                               | Owner chooses storage (recommended: Cloudflare R2) and fills `offsite.env`; Claude verifies a restore from it | Owner + Claude                                            |
| 2     | `main` far behind `dev` (deploy workflow runs from `main`)                                            | Owner merges `dev` → `main` now and after each staging-verified batch                                         | Owner                                                     |
| 3     | Withdraw Bachs money, and withdraw pretend money even when Bachs money exists (per-provider balances) | ADR-0015 (Bachs payouts, sandbox), then a plan                                                                | Needs decisions D3-a–D3-c                                 |
| 3     | Refunds and disputes booked in the ledger                                                             | ADR-0016 (reversal accounting, sandbox), then a plan                                                          | Needs decisions D3-d–D3-f                                 |
| 4     | Visit count in production                                                                             | Legal decision D-07, then enable `ANALYTICS_ENABLED`                                                          | Blocked on D-07                                           |
| 4     | Live payments                                                                                         | D-03–D-06 written approvals, then an ADR for live keys                                                        | Blocked on D-03–D-06                                      |
| 5     | Business (PRD FR-08)                                                                                  | Brainstorm → spec → plans                                                                                     | **TODO** (deferred by the product owner, 28 October 2026) |

### Decisions needed for Phase 3 (recommended defaults in bold)

- **D3-a** Who triggers a Bachs payout: **the owner presses Withdraw; TipMe asks Bachs to pay out from their connected account to the bank account Bachs collected during onboarding**.
- **D3-b** Minimum and fees: **same ₦1,000 minimum; Bachs' payout fee (if any) is shown and borne by the owner**.
- **D3-c** Mixed balances: **one Withdraw creates one payout per collecting provider; each provider's money only leaves through that provider**.
- **D3-d** A refund: **reverses the whole tip, including TipMe's share; the owner's balance may go negative and is netted against future tips**.
- **D3-e** A dispute: **holds the tip's amount when opened, reverses it when lost, releases it when won**.
- **D3-f** Who can refund: **staff only, from the admin issue, with a reason (two-person rule once there are two staff)**.

---

### Task 1: Release runs stop leaving open issues and endlessly checked attempts

Each full release check deliberately misreports one pretend tip. Its attempt stays `UNKNOWN` by design (TipMe must not invent an outcome), so after the run finishes the worker re-checks it every 20 seconds forever, and the issue detector opens a rehearsal `payment_mismatch` issue about 2½ minutes later — after `finishReleaseRun` closed the run's open issues. Staging holds 8 of each.

**Files:**

- Modify: `packages/database/src/operations/reconcile.ts` (`findAttemptsToReconcile`)
- Modify: `packages/database/src/operations/issues.ts` (`autoResolveIssues`)
- Test: `packages/database/test/integration/rehearsal.test.mjs`

**Interfaces:**

- Consumes: `openReleaseRun`, `finishReleaseRun` (`release-runs.ts`), `profiles.rehearsalRunId`, `releaseRuns.finishedAt`.
- Produces: `findAttemptsToReconcile` skips attempts whose tip belongs to a profile with a **finished** release run; `autoResolveIssues(db, now)` also resolves open `rehearsal` issues whose profile's release run is finished, with `resolvedBy: 'system'` and reason `'release check finished'`, counted in its existing `resolved` total.

- [ ] **Step 1: Write the failing tests** in `rehearsal.test.mjs`, reusing its setup for a rehearsal profile:
  - `test('after a release run finishes, its attempts are no longer re-checked')`: an `UNKNOWN` mock attempt on a rehearsal profile is returned by `findAttemptsToReconcile` while the run is open and not after `finishReleaseRun`; an `UNKNOWN` attempt on a normal profile is still returned.
  - `test('a rehearsal issue opened after its run finished is closed automatically')`: open a rehearsal issue for the profile after `finishReleaseRun`; `autoResolveIssues` returns `resolved >= 1` and the issue's status is `'resolved'`.
  - `test('a run that never finished keeps its issues and checks')`: with the run still open, the issue stays `'open'` and the attempt is still returned.
- [ ] **Step 2: Run them; expect FAIL** (`node scripts/test-integration.mjs` with `TEST_SHARD` unset, or the single file under `TIPME_TEST_TEMPLATE`).
- [ ] **Step 3: Implement** both filters with a `NOT EXISTS (… profiles p JOIN release_runs r ON r.id = p.rehearsal_run_id WHERE r.finished_at IS NOT NULL …)` condition.
- [ ] **Step 4: Run the file and the full integration suite; expect PASS.**
- [ ] **Step 5: Commit** `fix(release): stop re-checking and re-raising finished rehearsals`.

### Task 2: An account Bachs has not activated yet asks the owner to continue setup

`bachsAccountReadiness` returns `RESTRICTED` whenever `active === false`. A fresh account is inactive until onboarding finishes, so the owner sees "restricted" instead of "Continue setup".

**Files:**

- Modify: `packages/payments/src/bachs/provider.ts:267` (`bachsAccountReadiness`)
- Test: `packages/payments/test/bachs.test.mjs` (existing `bachsAccountReadiness` tests near line 893)

**Interfaces:**

- Produces: unchanged signature `bachsAccountReadiness(account: BachsRecipientAccount): { status: 'ACTIVE' | 'ONBOARDING' | 'RESTRICTED'; chargesEnabled: boolean }`.

- [ ] **Step 1: Write the failing test** `test('an inactive account still onboarding is onboarding, not restricted')`:
  - `{ active: false, ngnCardCollectionStatus: 'pending', feeCollector: 'platform', requirementsDue: ['persons.dob'] }` → `{ status: 'ONBOARDING', chargesEnabled: false }`.
  - `{ active: false, ngnCardCollectionStatus: null, feeCollector: 'unknown', requirementsDue: [] }` → `ONBOARDING`.
  - Still `RESTRICTED`: `ngnCardCollectionStatus` in `restricted | inactive | disabled | rejected` (whatever `active` is), or `feeCollector: 'connected_account'`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/payments test`; expect the new case to FAIL.
- [ ] **Step 3: Implement**: drop `account.active === false` from the `RESTRICTED` condition; `ACTIVE` still requires `active === true`.
- [ ] **Step 4: Run payments tests and `tests/integration/bachs-account-webhooks.test.mjs`; expect PASS.**
- [ ] **Step 5: Commit** `fix(payments): an inactive Bachs account still onboarding is not restricted`.

### Task 3: A checkout Bachs never received is refused, not uncertain

The adapter rejects some inputs before any request is sent (`TypeError` at `provider.ts:182, 193, 297, 337, 356`). `classifyBachsStartError` treats anything that is not a 4xx `BachsApiError` as `unknown`, so the supporter is told "we couldn't confirm whether your payment started" and staff recovery is opened, although nothing reached Bachs.

**Files:**

- Modify: `packages/payments/src/bachs/errors.ts` (new class; already re-exported by `packages/payments/src/index.ts`), `packages/payments/src/bachs/provider.ts` (throw it from the pre-request checks `initializePayment` runs)
- Modify: `apps/api/src/checkout/checkout.service.ts:45` (`classifyBachsStartError`)
- Test: `packages/payments/test/bachs.test.mjs`, `apps/api/test/checkout-start-error.test.mjs`

**Interfaces:**

- Produces: `export class BachsRequestNotSentError extends Error` (`name = 'BachsRequestNotSentError'`), thrown only before `client.request` is called. `classifyBachsStartError(new BachsRequestNotSentError(...))` → `{ outcome: 'failed', diagnostic: { error: 'BachsRequestNotSentError' } }`.

- [ ] **Step 1: Write the failing tests:**
  - payments: `initializePayment` with an invalid return URL (`http://example.com`) rejects with `BachsRequestNotSentError`, and the fake transport received **0** requests.
  - api: `classifyBachsStartError(new BachsRequestNotSentError('x')).outcome === 'failed'`; `BachsTransportError` and `UncertainProviderOutcomeError` stay `'unknown'` (Review Focus 3).
- [ ] **Step 2: Run** `pnpm --filter @tipme/payments test` and `pnpm --filter @tipme/api test`; expect FAIL.
- [ ] **Step 3: Implement** the class and use it for the checkout-creation pre-request checks only; configuration errors at construction (webhook secrets, API key) stay `TypeError`.
- [ ] **Step 4: Run both suites and `tests/integration/bachs-checkout-start.test.mjs`; expect PASS.**
- [ ] **Step 5: Commit** `fix(checkout): a Bachs checkout that was never sent is refused, not uncertain`.

### Task 4: The monogram fills the portrait when a page has no photo

`.avatar--initials` (`apps/web/src/app/globals.css:2765`) sets `width: 120px; height: 120px` and comes after `.profile-portrait__media`'s `100%`, at equal specificity, so the portrait monogram is a 120px box in the frame's corner.

**Files:**

- Modify: `apps/web/src/app/globals.css:932` (`.profile-portrait__media.avatar--initials`)
- Test: `tests/e2e/profile-portrait.spec.ts` (new)

**Interfaces:** none.

- [ ] **Step 1: Write the failing e2e test** `test('a page without a photo fills its portrait with the monogram')`: open a seeded page with no photo (tobi), read the bounding boxes of `[data-profile-portrait]` and its `[role="img"]` child; expect the child's width and height within 2px of the figure's (desktop and `@mobile`).
- [ ] **Step 2: Run** `pnpm exec playwright test -g "fills its portrait"`; expect FAIL (120 vs ~400).
- [ ] **Step 3: Implement**: add `width: 100%; height: 100%;` to `.profile-portrait__media.avatar--initials`.
- [ ] **Step 4: Run the test and the visual specs; expect PASS.** If a visual baseline shows a page without a photo, review CI's actual image before refreshing it (Review Focus 4: Ada's photo page must be unchanged).
- [ ] **Step 5: Commit** `fix(web): the portrait monogram fills the frame`.

---

## After Phase 1

1. One PR for Tasks 1–4; staging verification: after deploy, the worker's `checked` count drops from 9 to the real unfinished tips, and `issues` has no open rehearsal rows.
2. Phase 2 items with the owner.
3. Phase 3: write ADR-0015 and ADR-0016 from the decisions above, then their plans.
