# PR-006 verification — 18 October 2026

## Scope delivered

A provider interface and a signed-webhook mock provider (`packages/payments`), a raw-body webhook endpoint in the API, durable storage of unmatched provider messages, a background reconciliation job in the worker, and `pnpm mock:pay`. No real provider, credentials or money. Design: `docs/superpowers/specs/2026-10-18-pr006-mock-provider-design.md`; plan: `docs/superpowers/plans/2026-10-18-pr006.md`; ADR-0007.

## Agreed scenarios

| #   | Scenario               | Automated (`tests/integration/scenarios.test.mjs` unless noted)                   | Live (`pnpm mock:pay`, user's `pnpm dev`)                     |
| --- | ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Succeeds               | PASS                                                                              | PASS — SUCCEEDED, provider event shown                        |
| 2   | Declined               | PASS                                                                              | —                                                             |
| 3   | Pending, then succeeds | PASS (history AWAITING → PENDING_VERIFICATION → SUCCEEDED)                        | —                                                             |
| 4   | Duplicate message      | PASS (one ledger transaction, one receipt event)                                  | PASS                                                          |
| 5   | Out of order           | PASS (no transition after SUCCEEDED)                                              | —                                                             |
| 6   | Wrong amount           | PASS (attempt UNKNOWN, `payment.mismatch`, nothing booked)                        | —                                                             |
| 7   | No reply               | PASS (nothing until asked) + `reconcile-flow` and `reconcile` tests               | PASS — reconciled to SUCCEEDED after ~170 s, no second charge |
| 8   | Forged                 | PASS (401, nothing stored); mutation check: accepting any signature makes it FAIL | PASS — 401, tip unchanged                                     |
| 9   | Payout paid / failed   | PASS (both)                                                                       | PASS — payout PAID with provider reference                    |

Also: unknown-payment messages stored once (`webhooks`, `attempts-unmatched`); a valid signature over a malformed body → 400; a message claiming another attempt's ID is matched by reference only; database down → 503; two reconcilers at once book once; `not_found` after 30 minutes → one `payment.unresolved`; production and live-payment settings refused by API and worker.

## Commands (Node 24.22.0, pnpm 10.33.0)

| Command                        | Result                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `prettier --check .`           | PASS except `docs/architecture/IMPLEMENTATION_BASELINE.md` (user's file, untouched)                       |
| `pnpm lint` / `pnpm typecheck` | PASS — 15/15 tasks each                                                                                   |
| `pnpm test`                    | PASS — root 6, domain 11, payments 4, contracts 4, observability 10, database 2, worker 15, api 20, web 1 |
| `pnpm build`                   | PASS — 9/9                                                                                                |
| `pnpm db:migrate`              | PASS — migrations 0006, 0007 applied locally                                                              |
| `pnpm test:integration`        | PASS — 103/103                                                                                            |
| `pnpm test:e2e`                | PASS — 49 passed, 1 skipped                                                                               |

## Final review

One fresh reviewer (read-only, probes against `tipme_test`) checked the whole change: **ready with fixes**. Fixed, each with a test that failed first:

1. Reconciliation could starve: 50 permanently unresolvable attempts would block newer ones forever. Attempts are now checked least-recently-checked first (`last_reconciled_at`, migration 0008).
2. One attempt whose check always throws aborted every batch. Each check is now isolated and counted.
3. The worker treated an unset `NODE_ENV` as development, so mock reconciliation could run against production data. It now defaults to production, like the API.
4. Every database error answered 503, so a message that can never be stored was retried forever. Now 503 only for availability failures, otherwise 500, and identifiers with control characters are rejected as malformed.

Deferred minors (all fixed in the follow-up below): reconcile `unresolved` count overstated; schedule not retried after a startup failure; the worker requires a secret it does not use; initiation helpers' return values and payout reference overwrite; unmatched dedupe ignores changed content, and early payout webhooks are parked without payout reconciliation; unvalidated Redis status in the mock; `mock:pay --api` accepts any URL; three test gaps (schema-invalid JSON over HTTP, partial-row 503, HTTP replay of pending).

## Notes

- Requirement change: with the mock enabled, the API and worker need `MOCK_PROVIDER_WEBHOOK_SECRET` (≥ 32 characters), and the API needs `NODE_ENV` set, because unset means production and the mock is refused there. `.env.example` and the local `.env` were updated.
- The user's running worker uses Node 20.20.2 from their shell (pinned: 24.22.0). It worked, but `nvm use` is recommended.

## Not done

Checkout endpoints and pages (PR-007); real provider (ADR-0004, blocked on D-03/D-04); expiry of stale attempts (PR-007); refunds, disputes, settlement reports.

## Follow-up — deferred minors fixed (user request)

All nine fixed, each covered by tests: the unresolved count only counts new alerts; the reconciliation schedule is retried until registered; the worker no longer holds the webhook secret (a mock without one rejects every webhook); initiation helpers report `not_found` / `already` / `conflict` and never overwrite a payout reference; an unmatched message reusing an ID with different content is flagged; **payout reconciliation** (`fetchPayoutStatus`, `reconcilePayouts`, migration 0009) recovers payout messages that arrived early or never; unrecognised mock statuses are treated as pending; `pnpm mock:pay` only targets a local API and local Redis; and three HTTP tests were added (schema-invalid JSON, mid-transaction availability failure with no partial rows, late pending after success). Gate: integration 118/118, e2e 49 + 1 skipped; live `succeed` and `payout-paid` re-run against the user's dev servers.
