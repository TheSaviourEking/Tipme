# PR-005 verification — 18 October 2026

## Scope delivered

Money records that prove what happened, with no real money: `packages/domain` (integer money, mock fee policy, PRD state machines, balanced posting builders), `packages/database` (Drizzle schema, SQL migrations with database-enforced invariants, transactional operations, local-only migrate/seed), and an outbox relay in the worker. Design: `docs/superpowers/specs/2026-10-18-pr005-money-records-design.md`. Plan: `docs/superpowers/plans/2026-10-18-pr005.md`. ADR-0002 (Drizzle), ADR-0006 (custody-neutral ledger), ERD `docs/architecture/ERD.md`, D-04 note in `docs/00-DECISIONS.md`.

## Acceptance checks

| #   | Check                           | Evidence                                                                                                                                                   | Result |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Paid only on evidence           | `recordProviderEvent` is the only path to `SUCCEEDED`; stores the provider event (unique, verified-only CHECK); proof links the event                      | PASS   |
| 2   | History never rewritten         | Triggers reject UPDATE/DELETE on transitions and ledger (invariants tests); every change appends a transition                                              | PASS   |
| 3   | One action, one record          | 20 concurrent identical intents → 1 row; same key, different request → conflict; same event ×10 concurrently → applied once                                | PASS   |
| 4   | Books always balance            | Commit-time triggers reject unbalanced, single-entry and zero-entry transactions; 500 random tips balance; unique operation keys                           | PASS   |
| 5   | Atomic status + ledger + outbox | One transaction per operation; forced mid-operation failure leaves zero rows                                                                               | PASS   |
| 6   | Both proofs queryable           | `tipProof` returns payment evidence, breakdown, both ledger transactions, payout reference and full history as JSON-safe strings                           | PASS   |
| 7   | No downgrades                   | Late failure after success ignored; success after failure flagged `payment.conflict`; wrong amount/currency → `UNKNOWN` + `payment.mismatch`, never booked | PASS   |
| 8   | Outbox delivery                 | Relay: publish failure marks nothing; two relays never double-publish; end to end a paid tip reaches the worker; re-publishing the same row yields one job | PASS   |
| 9   | Traceable                       | Transitions, ledger transactions and outbox carry trace IDs; worker log for the delivered event carries the outbox trace ID                                | PASS   |

## Commands (Node 24.22.0, pnpm 10.33.0, Postgres 16, Redis 7)

| Command                                   | Result                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `prettier --check .`                      | PASS except `docs/architecture/IMPLEMENTATION_BASELINE.md` (user's file, untouched)                                        |
| `pnpm lint` / `pnpm typecheck`            | PASS — 13/13 tasks each                                                                                                    |
| `pnpm test`                               | PASS — root 4, domain 11, contracts 3, observability 10, database 2, api 17, worker 13, web 1                              |
| `pnpm build`                              | PASS — 8/8                                                                                                                 |
| `pnpm db:migrate`, `pnpm db:seed` (twice) | PASS — migrations applied; seed idempotent (2 profiles)                                                                    |
| `pnpm test:integration`                   | PASS — 55/55 (database invariants, quotes, intents, provider events, payouts/proof, relay; PR-004 suites; outbox delivery) |
| `pnpm test:e2e`                           | PASS — 49 passed, 1 skipped                                                                                                |

## Final review

One fresh reviewer (separate context, read-only, ran probes against `tipme_test`) checked the whole change. Verdict: **ready with fixes**. Fixed, each with a test that failed first:

1. Different provider events for one attempt arriving together deadlocked (30/30 in the reviewer's probe): the attempt is now locked before the event is stored.
2. Balanced entries could be appended to an already-committed ledger transaction: the database now only accepts entries in the transaction that created it.
3. A payer message could leak through database error text: messages are validated in code, and unexpected database errors carry only a SQLSTATE.
4. A payout reported paid after it failed was ignored: it is now flagged (`payout.conflict`).
5. Reusing a payout key with different tips returned the old payout: requests are fingerprinted and mismatches rejected.
6. The local-only guard could be bypassed with `?host=`: it now checks the host the driver will really use.
7. The proof history hid an earlier failed payout: every payout that covered the tip is now included.
8. The D-04 note broke the decisions table: moved below it.

Deferred minors (fixed in the follow-up below): expiry checked before idempotent replay; fee > gross not stored as a mismatch; bigint/undefined provider payloads; same event ID with different content not flagged; SUCCEEDED transition not table-checked; provider reference overwritten by mismatched events; TRUNCATE and some direct updates not database-enforced; outbox dedupe one-per-type, `attempts` column, retention-window dedupe; missing concurrent-payout and expiry-replay tests.

## Not done / limits

No HTTP endpoints (PR-007), no mock provider or webhook signatures (PR-006), no refunds, disputes, reconciliation or real payout execution. Chart of accounts awaits finance sign-off; fee policy is a mock (D-05); custody awaits legal (D-04). Hosted CI not run (no Git remote); CI now migrates before integration tests.

## Follow-up — deferred minors fixed (user request)

All nine deferred minors are fixed, each with a test that failed first: same-key retries replay even after quote expiry, and a quote funds exactly one tip; a fee larger than the payment is stored as a mismatch; payloads with bigint or nothing are stored safely; a reused provider event ID with different content is flagged; a success for a tip that can no longer succeed is a conflict; the provider reference is set once from an applied event; the database refuses TRUNCATE on history, account changes, mismatched entry recipients and any status change outside the PRD state machines (a parity test checks every status pair against the domain tables, and fails if a trigger is removed); every alert occurrence is kept, failed outbox deliveries are counted, and relay jobs are retained 7 days for dedupe; concurrent payout and expiry-replay tests were added. Migrations 0004 and 0005. Gate: lint, typecheck, unit, build, `db:migrate`, integration 73/73, e2e 49 + 1 skipped.
