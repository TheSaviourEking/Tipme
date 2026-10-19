# ADR-0007 — Payment provider interface, mock provider and reconciliation

Date: 2026-10-18
Status: ACCEPTED for development (PR-006). ADR-0004 (the real provider and settlement) stays BLOCKED on D-03 and D-04.
Owners: Engineering

## Context

No payment provider is approved (D-03), but the PR-005 money records need to be exercised the way real providers behave: delayed, duplicated, out-of-order, misreported, silent and forged messages. AGENTS.md requires webhooks authenticated before processing, durable event storage, deduplication, out-of-order safety and reconciliation of unknown outcomes without blind retries.

## Decision

- **`PaymentProvider` interface** in `packages/payments` (PRD 6.5 subset): `initializePayment`, `verifyTransaction` (server-to-server, the authority for reconciliation), `verifyWebhook`, `initiatePayout`, `fetchPayoutStatus` (the authority for payout reconciliation). Provider-specific formats stay inside each adapter.
- **Mock provider** with pretend state in Redis (`mockprovider:<prefix>:*`), shared by the API, the worker and `pnpm mock:pay`. Disposable by design; Postgres remains the source of truth.
- **Webhook signing:** `x-mock-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, constant-time comparison, ±300 s tolerance, verified on the raw bytes (Nest `rawBody`) before parsing. Unsigned, wrongly signed or stale → 401; signed but malformed → 400; nothing is stored in either case.
- **Matching** is by `(provider, providerReference)`, recorded when the payment or payout starts, never by an ID the message claims. Verified messages that match nothing are kept in the append-only `unmatched_provider_events`.
- **Responses:** processed, duplicate, conflict and mismatch → 200 (the provider must stop retrying); database unavailable → 503 (the provider retries); a deterministic database error → 500. Identifiers with control characters are rejected as malformed (400).
- **Reconciliation:** a repeatable BullMQ job (`reconcile.payments`, every `RECONCILE_INTERVAL_MS`, default 60 s) asks the provider about `INITIATED`, `PENDING` and `UNKNOWN` attempts older than `RECONCILE_MIN_AGE_MS` (default 2 min). A definite answer is recorded with event ID `reconcile.<attemptId>.<status>`, so repeats and concurrent runs are duplicates. `not_found` after 30 minutes raises `payment.unresolved` once. Attempts are checked least-recently-checked first (`last_reconciled_at`), and one failing check is counted rather than aborting the batch, so stuck attempts cannot starve newer ones. The same job reconciles payouts (`REQUESTED`/`PROCESSING` with a reference) via `fetchPayoutStatus`, with event IDs `reconcile.<payoutId>.<status>`. It never starts or retries a charge or a payout. The schedule registration is retried until it succeeds. The worker holds no webhook secret; a mock without one rejects every webhook.
- **Safety gates:** API and worker refuse `PAYMENT_PROVIDER=mock` in production, refuse any `PAYMENTS_LIVE_ENABLED` other than `false`, and require a webhook secret of at least 32 characters. With an unset `NODE_ENV` (treated as production by both the API and the worker) they refuse to start: they fail closed.

## Rationale

The signature scheme mirrors common real providers, so the verification path is realistic. Matching by reference prevents a valid message from being redirected to another tip. Deterministic reconciliation IDs reuse PR-005's dedupe instead of adding locks.

## Financial, security, privacy and accessibility impacts

No real money; mock only. Bodies, signatures and secrets are never logged (reason and outcome only). Unmatched messages are kept rather than dropped. Reconciliation is ask-only.

## Rollout and rollback

Development only. Removing the mock means setting a real provider in a future ADR-0004; the interface stays.

## Consequences

A real adapter must implement the same interface, its own signature check and status mapping, and confirm its reconciliation API. The mock's Redis state disappears when Redis is flushed; pretend payments then reconcile as `not_found`.

## Validation evidence

`docs/PR-006-VERIFICATION.md`.

## Linked PRD requirements

PRD 6.5 provider abstraction; AGENTS.md webhook and reconciliation invariants; docs/03-DOMAIN-AND-PAYMENTS.md mandatory tests (unknown, duplicate, reordered, forged).
