# Bachs Gap Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Bachs sandbox integration fail closed at every unsupported or unverified money boundary and align its NGN account, checkout, fee, webhook, and reconciliation behavior with authoritative provider evidence.

**Architecture:** Keep Bachs-specific payloads inside `packages/payments`, expose normalized provider/account evidence to the API and worker, and preserve PostgreSQL as the financial source of truth. Unsupported payouts, refunds, disputes, and live activation remain disabled until separately approved; this plan removes false success paths rather than inventing those products.

**Tech Stack:** TypeScript 5.9, Node 24, NestJS, Drizzle/PostgreSQL, Node test runner, Zod.

**Spec:** `docs/adr/ADR-0004-bachs-connect-and-provider-boundaries.md`

## Global Constraints

- Sandbox only: reject live Bachs keys and production activation; `PAYMENTS_LIVE_ENABLED` remains `false`.
- Monetary truth comes only from authenticated provider evidence or authoritative server-side reads.
- Never retry ambiguous provider writes, treat redirects as payment proof, or log credentials, raw bodies, PII, or card data.
- Preserve integer minor units and explicit ISO currency throughout TipMe-owned interfaces.
- Existing unrelated worktree changes must not be overwritten or included in payment commits.

## Review Focus

- Definite Bachs 4xx checkout rejection must not become `UNKNOWN`, while timeouts/5xx/409 remain non-retryable `UNKNOWN`.
- A connected account lacking active NGN collection or platform fee responsibility must never become checkout-ready.
- A succeeded provider payment with missing or mismatched platform fee must remain pending/review and must not post ledger revenue.
- A Bachs-funded recipient must not be able to settle a withdrawal through the mock provider.
- Account/capability webhooks, duplicate delivery, and later capability restriction must update or trigger authoritative readiness reconciliation safely.

---

### Task 1: Provider evidence and NGN account readiness

**Files:**

- Modify: `packages/payments/src/provider.ts`
- Modify: `packages/payments/src/bachs/provider.ts`
- Modify: `packages/payments/src/bachs/webhooks.ts`
- Test: `packages/payments/test/bachs.test.mjs`

**Interfaces:**

- Produces normalized platform-fee evidence, fee responsibility, NGN capability state, opaque provider account identifiers, and account lifecycle webhook events.
- Consumed by Tasks 2, 3, and 4.

- [ ] Write failing tests for `ngn_card_collection` plus `bank_transfer` requests, exact returned fee responsibility, opaque account identifiers, `paid`/`succeeded` success variants, platform-fee verification, and account/capability webhook normalization.
- [ ] Run `pnpm --filter @tipme/payments build && node --test packages/payments/test/bachs.test.mjs`; confirm the new assertions fail for the missing behavior.
- [ ] Extend the provider-owned schemas and normalized types minimally; success requires exact expected platform fee and platform-paid processing fee.
- [ ] Re-run the focused command and confirm it passes.
- [ ] Commit only Task 1 files.

### Task 2: Correct checkout failure classification and diagnostics

**Files:**

- Modify: `apps/api/src/checkout/checkout.service.ts`
- Modify: `packages/database/src/operations/attempts.ts`
- Modify: `packages/database/src/schema.ts` only if durable diagnostic fields are necessary
- Add/modify migration only if schema changes are necessary
- Test: `tests/integration/checkout-api.test.mjs`

**Interfaces:**

- Consumes `BachsApiError` and ambiguous-outcome errors from the adapter.
- Produces a safe definite-failure transition and allowlisted structured diagnostic evidence.

- [ ] Write a failing integration/unit-level test proving Bachs 4xx is retryable/failed rather than `UNKNOWN`, while timeout/5xx remains `UNKNOWN`.
- [ ] Run the narrow test and confirm the expected failure.
- [ ] Add the smallest state transition and sanitized logging needed; never persist response bodies or PII.
- [ ] Re-run the narrow test and related checkout tests.
- [ ] Commit only Task 2 files.

### Task 3: Enforce authoritative recipient-account readiness

**Files:**

- Modify: `apps/api/src/profiles/payment-accounts.controller.ts`
- Modify: `apps/api/src/ops/actions.controller.ts`
- Modify: `packages/database/src/operations/payment-accounts.ts`
- Test: `tests/integration/bachs-recovery-api.test.mjs`
- Test: provider/account API tests as appropriate

**Interfaces:**

- Consumes normalized NGN capability and fee responsibility from Task 1.
- Produces local `ACTIVE` only when a usable NGN collection capability and platform fee responsibility are authoritative.

- [ ] Write failing tests for missing NGN capability, restricted capability, and non-platform fee responsibility.
- [ ] Run the narrow tests and confirm failure.
- [ ] Make account creation, refresh, and staff recovery fail closed on the same readiness predicate.
- [ ] Re-run the narrow tests and payment-account tests.
- [ ] Commit only Task 3 files.

### Task 4: Remove mock payout and unnecessary worker-secret paths

**Files:**

- Modify: `apps/api/src/dashboard/dashboard.controller.ts`
- Modify: API provider composition only as required
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/job-worker.ts`
- Modify: deployment environment wiring and examples
- Test: `tests/integration/dashboard-api.test.mjs`
- Test: `apps/worker/test/config.test.mjs`

**Interfaces:**

- Consumes persisted payment provenance/provider capabilities.
- Produces a hard withdrawal rejection for unsupported Bachs money and a read-only worker adapter that needs no webhook secret.

- [ ] Write failing tests proving unsupported-provider withdrawals create no payout and the worker can reconcile Bachs with API key only.
- [ ] Run focused tests and confirm failure.
- [ ] Add fail-closed withdrawal gating and split webhook verification requirements from read-only provider construction.
- [ ] Remove the Bachs webhook secret from worker-only runtime requirements/wiring.
- [ ] Re-run focused API/worker tests.
- [ ] Commit only Task 4 files.

### Task 5: Account lifecycle reconciliation and webhook operations

**Files:**

- Modify: `apps/api/src/webhooks/webhook.service.ts`
- Modify: provider webhook/controller types as needed
- Modify: `packages/database/src/operations/payment-accounts.ts`
- Modify: worker reconciliation scheduling/handler if needed
- Test: `tests/integration/webhooks.test.mjs`
- Test: database payment-account integration tests

**Interfaces:**

- Consumes normalized account/capability events from Task 1.
- Produces idempotent authoritative account refresh triggers plus immediate payment reconciliation triggers.

- [ ] Write failing tests for duplicate account/capability events, restriction after activation, and immediate payment reconcile scheduling.
- [ ] Run narrow tests and confirm failure.
- [ ] Store only allowlisted event evidence and perform authoritative account reads before readiness changes.
- [ ] Re-run webhook and account integration tests.
- [ ] Commit only Task 5 files.

### Task 6: Operational truth and final verification

**Files:**

- Modify: `docs/adr/ADR-0004-bachs-connect-and-provider-boundaries.md`
- Modify: Bachs staging/runbook/configuration documentation
- Modify: `docs/agent/ACTIVE_TASK.md`
- Modify: `docs/agent/HANDOFF.md`

**Interfaces:**

- Consumes all preceding verified behavior.
- Produces exact webhook provisioning, reserve monitoring, settlement UX, unsupported money-movement boundaries, and takeover instructions.

- [ ] Document `event_source=connect/all`, required event subscriptions, replay/health checks, platform reserve alerting, and the deliberately unsupported refund/dispute/payout boundaries.
- [ ] Record every command and pass/fail/skipped result in continuity docs without overwriting unrelated entries.
- [ ] Run focused package tests, integration tests that are safe locally, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm format:check`, and `git diff --check`.
- [ ] Review the full branch diff for secrets, live enablement, mock-money leakage, and unrelated files.
- [ ] Commit documentation separately, excluding pre-existing unrelated changes.

### Task 7: Confirm Bachs payments, and never expire a paid one

Added 27 October after review: `verifyTransaction` only reports `succeeded` when it is given the expected platform fee, but reconciliation, expiry and staff recovery never pass one, so no Bachs payment can ever be confirmed. Expiry also cancels a still-INITIATED attempt whenever the provider answers anything but succeeded/failed, which cancels a paid checkout that is waiting for settlement.

**Files:**

- Modify: `packages/payments/src/provider.ts` (a normalized "paid, settlement unverified" signal)
- Modify: `packages/payments/src/bachs/provider.ts`
- Modify: `packages/database/src/operations/reconcile.ts`, `packages/database/src/operations/expire.ts`
- Modify: `apps/api/src/ops/actions.controller.ts`
- Test: `packages/payments/test/bachs.test.mjs`, a database integration test for reconcile/expiry with a Bachs-shaped verifier

- [ ] Write failing tests: reconciliation of a settled, platform-paid Bachs payment with the quoted fee records `SUCCEEDED`; expiry never cancels an attempt whose checkout is completed and paid but unsettled (it opens or keeps a money issue instead); staff recovery passes the expected fee.
- [ ] Run them and confirm the failures.
- [ ] Pass the quote's TipMe share as the expectation from every caller; add the paid-but-unsettled signal and make expiry skip it.
- [ ] Re-run focused and related tests.
- [ ] Commit only Task 7 files.

### Task 8: Refunds, disputes and reversals become staff issues

Bachs refund/dispute events are currently dropped as `ignored`. Until refunds and disputes are designed (ADR-0004 live blocker), each must be stored as verified evidence and open a money issue, never change balances.

- [ ] Write failing tests for refund and dispute webhook events producing a stored event and an open money issue, with no ledger change.
- [ ] Implement the smallest normalization and issue path; re-run; commit only Task 8 files.

### Task 9: Treat Bachs identifiers as opaque

`acct_`/`chk_` prefixes are still assumed in `packages/contracts/src/ops.ts`, `packages/database/src/operations/attempts.ts` and the staff issue page. Bachs documents identifiers as opaque.

- [ ] Write failing tests with identifiers lacking those prefixes; replace the prefix patterns with the adapter's bounded opaque-identifier rule; re-run; commit only Task 9 files.

### Task 10: Keep Bachs' error code

A real sandbox refusal came back as HTTP 400 `{"detail": …, "error_code": "VALIDATION_ERROR"}`; the client read only `error.code`, so logs showed the status alone.

- [ ] Failing test: a 400 with a top-level `error_code` yields `BachsApiError.providerCode`. Implement; commit.

### Task 11: Refuse a localhost web origin with the Bachs sandbox

Bachs rejects localhost success URLs, so every checkout would fail. The API should refuse to start instead.

- [ ] Failing config test; implement; commit.

### Task 12: Confirm a Bachs payment as soon as its webhook arrives

Only the worker confirmed Bachs payments (every 60 s, attempts at least 2 minutes old), so confirmation came 2–3 minutes after paying and the receipt page had already stopped checking. Supersedes the Task 7 ruling on immediate reconciliation.

- [ ] Failing test: a payment webhook for a known attempt triggers an authoritative read (with the expected share) and records the tip as paid at once; a failed read leaves it pending for the worker. Implement; commit.

### Task 13: The receipt page keeps checking

The receipt page gave up after 2 minutes and only "Try again" showed the paid tip.

- [ ] Failing unit test for the check schedule: fast at first, then every 15 s, giving up only after 15 minutes. Implement; commit.
