# PR-006 design — provider interface and mock provider

Status: DRAFT for user approval. Date: 2026-10-18.

## Intent

Before any real payment provider exists (D-03 OPEN), TipMe needs a pretend provider that behaves like a real one, including the awkward ways real providers behave, so the PR-005 money records are exercised end to end. The user agreed to the scenario list below ("It does cover what I want").

## Goals (agreed scenarios)

Each can be triggered on demand and is covered by an automated test:

1. **Succeeds:** tip `SUCCEEDED`, ledger posted, receipt event queued.
2. **Fails (declined):** tip `FAILED`, nothing booked.
3. **Pending, then succeeds later.**
4. **Duplicate message:** the same "paid" webhook delivered twice is applied once.
5. **Out of order:** "paid" before "pending" never goes backwards.
6. **Wrong amount:** flagged (`payment.mismatch`), never booked.
7. **No reply:** after possibly taking the money the provider sends nothing. The attempt waits, and a background reconciliation asks the provider for the status and records the verified answer. It **never** starts a second charge.
8. **Forged message:** an unsigned, wrongly signed or stale webhook is rejected (401) before anything is stored.
9. **Payout paid / payout failed:** exercises the second proof (PR-005 `recordPayoutOutcome`).

Also required by AGENTS.md and the PR-005 ruling: a verified webhook for an attempt TipMe does not know is **stored durably** for review, not dropped.

## Non-goals

Real providers, credentials or money. Checkout pages and public quote/intent endpoints (PR-007). Refunds, disputes, settlement reports. Recipient onboarding to a provider.

## Anti-goals

- Any path where a redirect, a client call or an unsigned message marks a payment succeeded.
- A reconciliation that re-charges, or that guesses a status instead of asking the provider.
- The mock usable in production: startup refuses `PAYMENT_PROVIDER=mock` with `NODE_ENV=production`, and `PAYMENTS_LIVE_ENABLED` must stay `false`.
- Webhook bodies, signatures or secrets in logs or traces.

## Constraints

AGENTS.md financial invariants (webhooks authenticated before processing, durable event storage, dedupe, idempotent state machine, out-of-order safety, unknown outcomes reconciled, never retry money movements blindly). PRD 6.5 provider abstraction. PR-005 operations are the only path to state changes. Strict TS, exact pins, no new runtime dependencies unless ruled. Existing suites stay green.

## Decided with the user

The nine scenarios; a developer command to trigger them; everything local and fake.

## Builder's design (agent's calls, open to review)

### `packages/payments` (new, framework-free)

The `PaymentProvider` interface (subset of PRD 6.5; later providers implement the same shape):

- `name: string`
- `initializePayment({ attemptId, amountMinor, currency, scenario? }) → { providerReference, status: 'pending' }`
- `verifyTransaction(providerReference) → { status: 'succeeded' | 'failed' | 'pending' | 'not_found', amountMinor, currency, feeMinor }`
- `verifyWebhook(rawBody: Buffer, headers, now) → { ok: true, event } | { ok: false, reason: 'missing_signature' | 'bad_signature' | 'stale' | 'malformed' }`
- `initiatePayout({ payoutId, amountMinor, currency, scenario? }) → { providerReference }`

The mock implementation:

- **State lives in Redis** under `mockprovider:*` (simulated payments and payouts with their scenario), so the API (which initialises), the worker (which reconciles) and the developer command share one "provider". Redis suits a mock; nothing financial depends on it, and Postgres stays the source of truth.
- **Signatures:** header `x-mock-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` using `MOCK_PROVIDER_WEBHOOK_SECRET`; constant-time comparison; 300 s tolerance. This is the same pattern as common real providers, so the verification path is realistic.
- **Simulator:** for a scenario, emits the signed webhook sequence to the API's webhook URL: `succeed` → pending + succeeded; `decline` → failed; `pending-then-succeed` → pending, delay, succeeded; `duplicate` → succeeded twice (same event ID); `out-of-order` → succeeded then pending; `wrong-amount` → succeeded with amount − 1; `no-reply` → records a captured payment but sends nothing; `forged` → succeeded with a bad signature; `payout-paid` / `payout-failed` → payout webhooks.
- Fees: the mock reports a provider fee equal to the quote's fee (150 bps of the amount), so books match unless a scenario says otherwise.

### Contracts

Zod schema for the mock webhook body (`{ id, type: 'payment.pending'|'payment.succeeded'|'payment.failed'|'payout.processing'|'payout.paid'|'payout.failed', data: { reference, attemptId?, payoutId?, amountMinor (string), currency, feeMinor (string) } }`). Amounts are strings on the wire.

### API

- `POST /v1/webhooks/mock` (registered only when `PAYMENT_PROVIDER=mock`): verifies the signature against the **raw** body (Nest `rawBody`) before parsing. Rejected → 401, nothing stored, log reason only. Verified payment events are matched to an attempt by `(provider, providerReference)`, which `markAttemptInitiated` recorded, never by an ID the message merely claims. They then go to `recordProviderEvent`. payout events → `recordPayoutOutcome`; an unknown attempt or payout → stored in a new `unmatched_provider_events` table (durable, flagged) → 200. Duplicates, conflicts and mismatches → 200 (the provider must not keep retrying). Database failure → 503 (the provider retries).
- `markAttemptInitiated(attemptId, provider, providerReference)` (new PR-005-style operation) moves `CREATED → INITIATED` when a payment is initialised.
- Config: `PAYMENT_PROVIDER` (`mock` only for now), `MOCK_PROVIDER_WEBHOOK_SECRET` (≥ 32 chars, required when mock), `PAYMENTS_LIVE_ENABLED` (must be `false`); production plus mock is refused.

### Worker: reconciliation

A repeatable BullMQ job (`reconcile.payments`, every 60 s locally; interval configurable) selects attempts in `INITIATED`, `PENDING` or `UNKNOWN` older than a threshold (2 minutes locally), in batches of 50. It calls `verifyTransaction` and turns a definite answer into `recordProviderEvent` with a deterministic event ID (`reconcile.<attemptId>.<status>`), so repeats are duplicates. `pending` / `not_found` → no change; `not_found` for an attempt older than 30 minutes raises a `payment.unresolved` alert (once per attempt). It never calls `initializePayment`. Each run is traced and logged with counts only.

### Unmatched events (builder check, agent's call)

New table `unmatched_provider_events`: id, provider, provider_event_id (UNIQUE per provider, so repeats are absorbed), event_type, payload_hash, payload (restricted), reason (`unknown_attempt` / `unknown_payout`), received_at. Append-only like other history. A later PR's operations view reviews it.

### Developer command

`pnpm mock:pay --scenario <name> [--handle ada] [--amount 1000.00]` (local only; refuses non-local `DATABASE_URL`). It creates a quote, an intent and the payment through the PR-005 operations and the mock provider, runs the scenario against the local API, then prints the tip's proof (`tipProof`) and the Jaeger trace link. `pnpm mock:pay --scenario payout-paid` pays out Ada's succeeded tips.

### Tests

- **Unit:** signature verification (valid; wrong secret; tampered body; stale and future timestamp; missing or garbled header); webhook schema; scenario sequences.
- **Integration (Postgres + Redis + in-process API and worker):** one test per scenario 1–9, asserting the tip status, ledger, outbox and proof; the unknown-attempt webhook is stored in `unmatched_provider_events`; no-reply → reconciliation records the outcome, and a second run changes nothing; a forged webhook leaves zero new rows; the database-down webhook returns 503.

### Documentation

ADR-0007 (provider interface, mock provider, webhook signing, reconciliation; ADR-0004 for the real provider stays BLOCKED on D-03/D-04); runbook "a payment is stuck as unknown"; `docs/PR-006-VERIFICATION.md`.

## Left to the builder

Exact file layout, Redis key layout, scenario delays, how the in-process tests send webhooks (HTTP to the in-process API), and the job scheduling API details.

## Risks

Real providers differ in signature formats and status vocabularies; the interface keeps those inside each adapter. Redis-held mock state disappears on restart, which is acceptable for a mock and documented.
