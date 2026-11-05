# Partner Quote Cache Plan

**Goal:** Stop every dashboard and Withdraw load of `GET /v1/me/withdrawal-quote` from calling the payment partner. The partner's rate limit is shared with payouts (review findings: redesign-polish M-7, live-updates I5).

**Branch:** `fix/partner-quote-cache` (worktree `.worktrees/quote-cache`, from `origin/dev` d9de485). One PR to `dev`, not opened by this task.

**Regulatory note:** nothing here moves money, changes a payout or implies approval of D-02 to D-07 (`docs/00-DECISIONS.md`). No user-facing text changes. Tests use the pretend provider or stubs only.

## What the code does today

- `DashboardController.quoteWithdrawal` calls `withdrawalQuote` (`packages/database/src/operations/payouts.ts`). After TipMe's own checks it calls `readProvider`, which makes three partner calls: `payoutCapability`, `payoutBalance` and `quotePayoutFee(amount)`. Every load repeats all three.
- `requestWithdrawal` calls the same `readProvider` before it locks the profile. That fresh read is what protects the money.
- The partner side for one account changes when a payout starts, is paid, fails or is reversed, when the bank or payment account changes, and when a tip lands. Those changes are recorded in many places: API webhooks, worker start and reconcile, staff actions and the bank routes.

## Design

1. **Only the partner read is cached.** `withdrawalQuote` takes an optional `PartnerQuoteCache`. Two kinds of entry are stored: `base` (capability, plus the balance when payouts are active) and `fee` (keyed by amount). TipMe's ledger, queued payouts, holds, the switch and the route are all still read from Postgres on every call. `requestWithdrawal` takes no cache, so it always asks the partner.
2. **The key carries a stamp taken from TipMe's own records.** The stamp is a hash of the account reference, manual-payouts flag, account `updated_at`, current destination id and status, every payout's id, status and reference, and the ledger's available balance. It is read before the partner call. Any recorded change to the partner side therefore changes the key, whichever process records it (API, worker or staff). A failed Redis invalidation can never serve stale data for those changes, and a read in flight can't store an old answer under the new key.
3. **Explicit invalidation as well.** `invalidate()` raises a per-account version in Redis (`INCR`), and every key includes that version. It runs before and after `POST /v1/me/withdrawals` and after `PUT /v1/me/payout-destination`. Payout outcomes are covered by the stamp, because their status change is in the hash.
4. **Expiry:** `PARTNER_QUOTE_CACHE_SECONDS`, default 30, `0` turns it off. It is passed through both compose files and the env examples.
5. **Redis down or slow:** every store call has a 200 ms limit, and any failure counts as a miss. The quote then asks the partner directly, and nothing throws. Failed partner reads are never cached.
6. **Keyed per payment account:** provider name plus profile, which identifies one payment account. The account reference is also in the stamp.

## Steps (test-first, a commit each)

1. Database: tests in `packages/database/test/integration/partner-quote-cache.test.mjs` (stub provider that counts calls, in-memory cache), then `PartnerQuoteCache` and the stamp in `payouts.ts`.
2. API: unit tests for `RedisPartnerQuoteCache` (fake Redis: hit, version bump, expiry passed, down, stalled), then the class and the config setting.
3. Wiring: the controller uses the cache for the quote and invalidates around a withdrawal and after a bank change. Compose files and env examples. Integration assertions in `tests/integration/dashboard-api.test.mjs`.

## Validation

format:check, lint, typecheck, unit tests, `node --test scripts/*.test.mjs` (web built, `E2E_LANE` unset), the touched integration files one at a time on `tipme_test_lane3`, and the withdraw and dashboard e2e on lane 3 with `--workers=2`.
