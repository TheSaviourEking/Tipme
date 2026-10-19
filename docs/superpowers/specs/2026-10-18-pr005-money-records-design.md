# PR-005 design — money records that prove what happened

Status: DRAFT for user approval. Date: 2026-10-18.

## Intent

The user's words: the records must "prove without doubt that the funds went through, that the tip happened". The user wants two proofs:

1. **Payment confirmed:** the provider confirmed the supporter's payment.
2. **Recipient received the money:** the recipient's share actually reached them.

The user's intended funds flow is custodial: the full tip arrives in a TipMe account, TipMe takes its cut, and TipMe forwards the rest to the recipient. The PRD prefers provider collection and settlement (non-custody); D-04 is OPEN pending legal advice; wallets and custody are DEFERRED in AGENTS.md. **Agreed approach (user approved):** design the money records so they work in either world. A balanced double-entry ledger records, for every tip, the gross amount received, TipMe's cut, provider fees and the amount owed to the recipient, then when that amount was paid out and the provider's reference for it. Choosing custody becomes a legal sign-off, not a rebuild. No real money moves until D-04 is approved.

## Goals (acceptance checks)

1. **Paid only on evidence.** A tip can reach `SUCCEEDED` only through a stored provider event (unique provider event ID, signature-verified flag set) linked to a payment attempt. No other code path can set it.
2. **History is never rewritten.** Every status change of a tip, attempt or payout is an appended transition row (from, to, cause, provider event, trace ID, time). Ledger entries and transitions cannot be updated or deleted; the database refuses it.
3. **One action, one record.** The same idempotency key cannot create a second payment intent. The same key with a different request is rejected. The same provider event processed twice changes nothing the second time. Enforced by database uniqueness, proven by concurrent tests.
4. **Books always balance.** Every ledger transaction balances (debits = credits) in a single currency. Each transaction belongs to exactly one business operation (unique operation key). The database rejects an unbalanced transaction at commit.
5. **Status, ledger and side effects commit together.** When a payment succeeds, the tip transition, the ledger postings and the outbox event (for example "send receipt") are written in one transaction, or none of them is.
6. **Both proofs are queryable.** For any tip, one query shows: gross received, TipMe cut, provider fee, recipient payable, and, once paid out, the payout with its provider reference and the ledger transaction that settled it.
7. **No downgrades.** A late or out-of-order event cannot move `SUCCEEDED` back to pending or failed. An `UNKNOWN` attempt resolves only through a verified event, never optimistically.
8. **Outbox delivery.** Committed outbox events are delivered to the worker queue at least once, never lost when Redis is down, with no duplicate effect (the dedupe key travels with the job).
9. **Traceable.** Transitions, ledger transactions and outbox events carry the PR-004 trace ID.

## Non-goals

Real provider calls and webhook signature verification (PR-006 mock provider). HTTP endpoints for quotes and intents, and checkout UI (PR-007). Auth and recipient accounts (ADR-0003, PR-008). Refunds, disputes, settlement reconciliation jobs, real payout execution. Multi-currency routing. Analytics events (PR-009). Switching the website's demo profiles to the database (PR-007).

## Anti-goals

- Any column or code path that lets a client, redirect or poll mark a payment as succeeded.
- Floating-point money anywhere, including the database (`numeric` with decimals counts as wrong too: minor units are `bigint`).
- Calling recipient balances a "wallet" (PRD 6.4: no premature stored-value representation).
- Presenting the mock fee policy as an approved commercial policy (D-05 is OPEN).
- Payer free text (tip messages) in logs, traces, outbox payloads or job data.
- Migrations run against any remote database (AGENTS.md).

## Constraints

AGENTS.md financial invariants (HARD STOP). API and worker AGENTS (transactions, idempotency, concurrency tests, bounded retries). `docs/03-DOMAIN-AND-PAYMENTS.md` mandatory tests. PRD sections 6.3 to 7. Integer minor units plus ISO 4217 currency. Strict TS, no `any`. Exact pins, recorded in an ADR, each published at least two weeks ago. Node 24.22.0, Postgres 16 (local Compose). Existing behaviour and suites stay green.

## Decided with the user

- Both proofs (payment confirmed, recipient received) are required.
- A custody-neutral double-entry ledger in PR-005; custody itself stays PROPOSED pending D-04. The user's wallet model is recorded in `docs/00-DECISIONS.md` as the intended direction, not approved.
- Follow the PRD where documents disagree (state names, response convention, routes).

## Builder's design (agent's calls, open to review)

### Tooling (ADR-0002)

**Drizzle ORM** with drizzle-kit migrations on the existing `pg` driver. Reasons: SQL-first, schema in TypeScript, plain reviewable SQL migration files, and full control over the constraints this design needs (CHECK constraints, partial unique indexes, triggers, deferred constraint triggers, `SELECT … FOR UPDATE`, isolation levels). Prisma was considered: heavier runtime, and these constraints would live in hand-written SQL outside its schema anyway. IDs are UUIDv7 generated in the application (time-ordered, no extra Postgres extension). Exact versions are fixed in the plan.

### New packages

- **`packages/domain`** (pure, no IO): money (`bigint` minor units with currency, add/subtract/compare, no floats), the mock fee policy, state machines (allowed transitions per entity), and ledger transaction builders that return balanced entry lists.
- **`packages/database`**: Drizzle schema, SQL migrations, client factory, test helpers (isolated test database, truncation), and **transactional operations** that combine domain rules with the database in one transaction (API AGENTS: "domain services own invariants; persistence adapters own DB IO"). The API and worker both depend on it; neither imports the other.

### Tables (PRD section 7 names where they exist)

| Table                 | Key columns and constraints                                                                                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`               | id, status, created_at. Contact and auth subject wait for ADR-0003.                                                                                                                                                                                                                                            |
| `profiles`            | id, user_id (nullable until auth), handle, `handle_lower` UNIQUE, display_name, bio, visibility, status. Fictional Ada and Tobi seeded.                                                                                                                                                                        |
| `tip_quotes`          | id, profile_id, currency, tip_minor, platform_fee_minor, provider_fee_minor, payer_total_minor, recipient_net_minor, fee_policy_version, expires_at. CHECK: amounts ≥ 0, tip > 0, `payer_total = tip + payer-side fees`, `recipient_net = tip − recipient-side deductions`.                                    |
| `payment_intents`     | id, quote_id, profile_id, idempotency_key, request_fingerprint (hash of the canonical request), status, expires_at. UNIQUE (profile_id, idempotency_key). Same key with a different fingerprint → rejected.                                                                                                    |
| `tips`                | id, intent_id UNIQUE, profile_id, currency, gross_minor, status (PRD: `DRAFT`, `AWAITING_PAYMENT`, `PENDING_VERIFICATION`, `SUCCEEDED`, `FAILED`, `CANCELLED`), payer_display_label (optional, ≤ 60, sanitised), completed_at.                                                                                 |
| `tip_messages`        | tip_id UNIQUE, body (≤ 280). Separate table so it can get stricter access and retention later; never copied anywhere else.                                                                                                                                                                                     |
| `payment_attempts`    | id, intent_id, attempt_number (UNIQUE per intent), provider, provider_reference (UNIQUE per provider when set), status (PRD: `CREATED`, `INITIATED`, `PENDING`, `VERIFIED_SUCCEEDED`, `VERIFIED_FAILED`, `EXPIRED`, `UNKNOWN`).                                                                                |
| `provider_events`     | id, provider, provider_event_id (UNIQUE per provider), event_type, signature_verified (CHECK true: unverified events are never stored as trusted), payload_hash, payload (jsonb, restricted), received_at, processed_at, attempt_id.                                                                           |
| `status_transitions`  | entity_type, entity_id, from_status, to_status, cause (`provider_event`, `system`, `expiry`), provider_event_id, trace_id, created_at. Append-only.                                                                                                                                                            |
| `ledger_accounts`     | id, code, kind (`asset`, `liability`, `revenue`, `expense`), currency, profile_id (for per-recipient payable accounts). UNIQUE (code, currency, profile_id).                                                                                                                                                   |
| `ledger_transactions` | id, operation_type, operation_key UNIQUE, currency, tip_id / payout_id, trace_id, posted_at. Append-only.                                                                                                                                                                                                      |
| `ledger_entries`      | id, transaction_id, account_id, side (`debit` / `credit`), amount_minor (> 0), currency. Append-only. A deferred constraint trigger checks at commit that each transaction balances and that every entry's currency matches its account and transaction.                                                       |
| `payouts`             | id, profile_id, currency, amount_minor, status (PRD: `REQUESTED`, `PROCESSING`, `PAID`, `FAILED`, `REVERSED`), provider, provider_reference (UNIQUE per provider when set), idempotency_key UNIQUE. `payout_items` link payouts to the tips they cover (a tip's net can be paid out only once: UNIQUE tip_id). |
| `outbox_events`       | id, event_type, aggregate_id, dedupe_key UNIQUE, payload (jsonb; IDs and amounts only, no free text), trace carrier, created_at, published_at, attempts.                                                                                                                                                       |

Append-only enforcement: `BEFORE UPDATE OR DELETE` triggers raise on `ledger_entries`, `ledger_transactions` and `status_transitions`. Status columns on `tips`, `payment_attempts` and `payouts` are a cached "current state"; the transition table is the history, and both change in the same transaction.

### Chart of accounts (custody-neutral; codes illustrative pending finance sign-off)

- `provider_clearing` (asset): money the provider holds or has collected for TipMe.
- `recipient_payable:<profile>` (liability): what TipMe owes each recipient (never called a wallet).
- `platform_fee_revenue` (revenue): TipMe's cut.
- `provider_fee_expense` (expense): processor fees.

Postings:

- **Payment succeeded:** debit `provider_clearing` (gross collected), debit `provider_fee_expense` (fee); credit `provider_clearing` (fee withheld by provider), credit `platform_fee_revenue` (cut), credit `recipient_payable:<profile>` (net). The builder nets this into the simplest balanced form; the tests assert the balances, not the line layout. **Fee variance (builder check, agent's call):** the recipient's net is fixed by the quote the supporter saw; if the provider's actual fee differs from the quoted fee, the difference is booked to a `provider_fee_variance` account (TipMe absorbs it), so the books still balance and the recipient never receives less than disclosed.
- **Payout paid:** debit `recipient_payable:<profile>`, credit `provider_clearing`, with the payout's provider reference.

The same entries hold in either world: under custody the money physically passes through TipMe's provider balance; under provider split the provider moves it, and the postings are the shadow ledger the PRD describes, matched against the provider's reports.

### Mock fee policy

`MOCK_FEE_POLICY_v0` in `packages/domain`, labelled "not an approved commercial policy (D-05)". Integer basis points, round half up to the minor unit, with values defined in one place. Per the user's description ("we take our cut then forward the rest"), the cut and the provider fee are deducted from the tip, so the payer pays the tip amount and the recipient gets the net. Whether payers can cover fees is D-05, and the quote columns already support it.

### Operations (in `packages/database`, each one transaction)

1. `createQuote(profileHandle, tipMinor, currency)` → validated against the profile and range, priced by the mock policy, with an expiry.
2. `createPaymentIntent(quoteId, idempotencyKey, request)` → creates the intent, the tip (`AWAITING_PAYMENT`), the optional message and the first attempt (`CREATED`); replays return the original; a fingerprint mismatch is rejected; an expired quote is rejected.
3. `recordProviderEvent(event)` → stores the event (unique by provider event ID; a duplicate is a no-op that returns the first result). It then locks the attempt and tip rows (`FOR UPDATE`), applies the allowed transition (no downgrade, UNKNOWN only to verified states), and on success posts the payment ledger transaction (operation key `payment:<attempt_id>`), sets `completed_at` and writes outbox `tip.succeeded`. All in one transaction. **Amount check (builder check, agent's call):** if the verified event's amount or currency differs from the intent, the tip is not marked succeeded. The attempt moves to `UNKNOWN` and an outbox `payment.mismatch` event is written for operations; this blocks tampered or misreported amounts from ever reaching the books.
4. `createPayout(profileId, tipIds, idempotencyKey)` → `REQUESTED`, linking only `SUCCEEDED`, not-yet-paid tips; the amount is the sum of their net.
5. `recordPayoutOutcome(payoutId, providerReference, outcome, providerEventId)` → transition; on `PAID` posts the payout ledger transaction (operation key `payout:<payout_id>`) and writes outbox `payout.paid`.
6. `tipProof(tipId)` → the read model for goal 6.

These are internal functions with tests. The HTTP endpoints that call them come in PR-007, and PR-006's mock provider produces their events.

### Outbox relay (worker)

A relay loop in the worker claims unpublished outbox rows (`FOR UPDATE SKIP LOCKED`, batch), enqueues a BullMQ job per row using `dedupe_key` as the job ID, then marks the rows published. If Redis is down, rows stay unpublished and are retried with backoff; nothing is lost. Handlers for `tip.succeeded` and `payout.paid` only log (with trace ID) until notifications exist (PR-008). Delivery is at least once, and duplicates are absorbed by the job ID and handler idempotency.

### Concurrency and isolation

Default READ COMMITTED with explicit row locks (`FOR UPDATE`) on the rows a transition changes. Uniqueness constraints are the last line of defence; a unique-violation on an idempotency or operation key is translated into "return the existing result". The tests run the operations concurrently (parallel connections), not just sequentially.

### Lifecycle details (builder check, agent's calls)

- Per-recipient `recipient_payable` accounts are created on first posting, inside the same transaction (upsert on the unique key).
- A payout's currency must match every tip it covers.
- Expiring stale intents and quotes (a scheduled job using the `expiry` cause) arrives with checkout in PR-007; PR-005 only rejects expired quotes when an intent is created.
- Postgres-backed tests for `packages/database` run as part of `pnpm test:integration`, sequentially, against the `tipme_test` database.
- Tip message encryption at rest is deferred to the retention and privacy work (PRD 476); the separate table keeps that change local.

### Scripts and environment

`pnpm db:migrate` (local only: refuses any `DATABASE_URL` whose host is not localhost or 127.0.0.1), `pnpm db:seed` (fictional Ada and Tobi), and a separate `tipme_test` database created by the test helper. The existing `database-deferred.mjs` placeholder is replaced.

### Tests

- **Unit (`packages/domain`, no infrastructure):** money arithmetic and overflow guards, fee policy rounding, the state-machine transition table (every forbidden transition), and balanced builders (property-style: random amounts always balance).
- **Integration (Postgres):** every acceptance check above. Includes concurrent identical idempotency keys → one intent; the same provider event in parallel → one transition and one ledger transaction; an out-of-order failed event after success → no change; a direct `UPDATE`/`DELETE` on the ledger → rejected; a hand-built unbalanced transaction → rejected at commit; a rollback mid-operation → no partial rows; the outbox relay with Redis down then up → delivered once; and the proof query returning both proofs.

### Documentation

ADR-0002 (Drizzle, migrations, IDs); ADR-0006 (custody-neutral ledger and chart of accounts, sign-off still needed from finance); `docs/00-DECISIONS.md` note recording the user's intended wallet model under D-04 as PROPOSED; an ERD in Mermaid; `docs/PR-005-VERIFICATION.md`.

## Left to the builder

Exact versions; file layout inside the packages; index choices beyond the uniques named; the exact netting of the payment posting; relay batch size and poll interval; and whether `request_fingerprint` uses SHA-256 of canonical JSON (the expected choice).

## Risks

- The chart of accounts and postings are illustrative until finance signs them off (PRD 6.4). They are kept in one module so they can change without touching callers.
- Custody versus split may change which reports reconciliation uses, not the tables.
- Drizzle's handling of deferred constraint triggers and custom SQL migrations needs checking against the installed version.
