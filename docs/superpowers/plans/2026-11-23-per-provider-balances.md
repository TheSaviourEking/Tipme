# Per-Provider Balances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person or business whose money sits at more than one payment provider sees one balance and one Withdraw button. Each naira is paid out through the provider that holds it, possibly as more than one bank payment. An old provider can stay connected in withdraw-only mode until it is empty, and staff can see split accounts and a daily check.

**Architecture:** This is approach 1 of the spec. Each provider's real balance is the per-provider truth, and the ledger total is the cap. There is no ledger change. A pure allocator in `@tipme/domain` decides how much each provider carries. `quoteFor` and `requestFor` in `payouts.ts` read every provider in the owner's set, in drain order. `requestFor` writes one `payouts` row per part, linked by `withdrawal_group_id`. The API and the worker build an adapter for every provider in either role (`PAYMENT_PROVIDER` + `PAYMENT_WITHDRAW_ONLY_PROVIDERS`). A worker job compares the ledger against the provider totals each day, and the ops screens show split accounts and the retire check.

**Tech Stack:** TypeScript strict, NestJS (API), BullMQ worker, Drizzle/Postgres (drizzle-kit migrations), Zod contracts, Next.js App Router (web), `node --test`, Playwright. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-per-provider-balances-design.md` (owner-approved 23 Nov 2026, PR #331). It is binding, and its "(design call)" items are approved. Here, §n means a section of the spec.

---

## What the code does today (origin/dev `6be87260`, migrations up to `0126_collect_schedule_read`)

- **Quote:** `packages/database/src/operations/payouts.ts`. `quoteGate` (:1587) checks, in order, the switch, holds, `ownerAvailable < 0`, `collectedElsewhere` (:1166, which blocks the whole quote with `provider_unavailable`) and `routeBlock(payoutRoute(...))`. `quoteFor` (:1663) reads one `PayoutReader` through `cachedReader` and `partnerStamp`, and sets `withdrawable = min(ledger, partner − queuedNotStarted)`. `queuedNotStarted` (:1515) sums REQUESTED payouts that have no provider reference, per owner, across all providers.
- **Request:** `requestFor` (:1845) runs a replay by `idempotency_key` (which is UNIQUE on `payouts`), then a `collectedElsewhere` check (twice), a provider read, the owner row lock, `belowWithdrawalMinimum`, `feePayerFor` (:1773) and `userPaidWithdrawal`, a destination `FOR SHARE`, and a single insert. It returns `{ payoutId, status, replayed }`. `personsWithdrawalsToday` (:1736) counts payout rows.
- **Wiring:** `apps/api/src/checkout/payment-provider.provider.ts`. `WITHDRAWAL_PROVIDER_TOKEN` is exactly the configured adapter. `BACHS_PROVIDER_TOKEN` builds the configured Bachs, or the sandbox when mock is configured and sandbox keys exist. In the worker, `apps/worker/src/job-worker.ts:346-359` always builds mock, `workerBachsProvider(config)` builds Bachs, and `providerFor(name)` resolves `'mock' | 'bachs'`. The reserve, collect reserve and payout setup jobs use `payoutSetupProvider` (the configured Bachs only).
- **Settings:** `packages/payments/src/settings.ts` holds `PAYMENT_PROVIDER_NAMES = ['mock','bachs-sandbox','bachs-live']`, `paymentSettingsShape` and `checkPaymentSettings`, which are shared by the API and worker configs. `recordedProviderName` (`packages/contracts/src/provider-names.ts`) maps both Bachs names to `'bachs'`.
- **Mock:** `createMockProvider({ redis, secret?, prefix? })` gives `name: 'mock'` and `connectedAccounts: false`. `payoutBalance` always returns `PRETEND_BALANCE_MINOR`.
- **Pro from balance:** `buyProFromBalance` (`pro-balance.ts:284`) takes one adapter, and `accountOf` treats only `'mock'` as accountless.
- **Reconcile:** `reconcile.ts` `sweepParkedPayoutEvents` hard-codes `'bachs'` at :587, :673 and :718.
- **Destinations:** `payout_destinations` has one active row per owner and provider. It holds `bank_code`, `bank_name`, `account_last4`, an optional `account_hash` (collect only) and `status`. The change-bank flows are `apps/api/src/profiles/payout-destination.controller.ts` (`PUT me/payout-destination`), `apps/api/src/profiles/collect-bank.controller.ts` and `apps/api/src/business/business-payouts.controller.ts`.
- **Web:** `apps/web/src/lib/withdraw-state.ts` shows `collected_elsewhere` when `withdrawalsAvailable` is false. The pages are `apps/web/src/app/dashboard/withdraw/withdraw-view.tsx`, `apps/web/src/app/dashboard/home-view.tsx` and `apps/web/src/app/dashboard/business/sections/money.tsx`.
- **Tests:** database integration tests are in `packages/database/test/integration/*.test.mjs` and pass plain-object readers (see `withdrawals.test.mjs` `bachsLike`). HTTP integration tests are in `tests/integration/*.test.mjs` (`startStack({ apiEnv, workerEnv })`). E2E is in `tests/e2e/*.spec.ts` (`withDatabase`, `E2E_REDIS_URL`).

## Rulings on spec ambiguities (made by this plan)

- **P1. Test adapter.** The second mock is `createMockProvider({ ..., name: 'mock_alt' })`. It is accountless like mock, its Redis keys are namespaced by name, and `markPayoutBalance(accountRef, minor | null)` sets its balance. The underscore is needed because `payout_destinations_provider` requires `^[a-z][a-z0-9_]*$`. `mock_alt` is accepted only in `PAYMENT_WITHDRAW_ONLY_PROVIDERS` and only when `NODE_ENV=test`. Production refuses `mock` and `mock_alt` in either list.
- **P2. Drain order.** Withdraw-only providers come first, in the order `PAYMENT_WITHDRAW_ONLY_PROVIDERS` lists them ("oldest first" = list order). The active provider is last and is **always** in the owner's set, so a new owner still gets today's setup and bank states.
- **P3. The active route decides the blocking states.** If the active provider's route is blocked (`setup_needed`, `no_destination`, `destination_pending`), the quote returns that state as it does today. The screen's one bank is the active one (§6), so without it no part can be checked as "the same bank".
- **P4. "Needs action" vs "partial".** At a withdraw-only provider, a missing, rejected, pending or **different** destination means `bankDetailsNeeded` (the person can fix it through change-bank). Anything there the person cannot fix (no account reference, manual payouts off, a capability that isn't `active`, a failed read) means `partial` ("can't be withdrawn right now"), and staff see it on Split accounts. Neither is dropped silently.
- **P5. Same bank.** Two destinations are the same account when `bank_code` and `account_last4` are equal and, if both rows have an `account_hash`, the hashes are equal too. These are the bank and digits the screen shows. An accountless provider (mock, mock_alt) with no destination row counts as the same bank, as today's "Pretend bank" does.
- **P6. Groups.** A single-provider withdrawal leaves `withdrawal_group_id` and `group_part` NULL, so the common path does not change. Part 1 of a split carries the client's Idempotency-Key. Part n>1 carries `<key>:<n>`. Client keys are UUIDs (`z.uuid()` pipe), so these never collide. A replay finds part 1 and returns the whole group.
- **P7. Daily count.** "Withdrawals today" counts requests, as `COUNT(DISTINCT COALESCE(withdrawal_group_id, id))` over rows not FAILED. A request is free when none of its parts has `fee_payer='user'`. A group counts as failed only when every part failed.
- **P8. Fee shown on the quote.** `feeMinor` is the fee quoted by the provider that would carry the largest part of a full withdrawal. That is the one fee the person (or a business) may pay (§5).
- **P9. Request when a read fails.** The request reads every provider in the set. Unreadable providers count as 0. If the amount then can't be covered and at least one provider was unreadable, it refuses `PAYOUT_PROVIDER_UNAVAILABLE`, otherwise `INSUFFICIENT_BALANCE`. It never sends to a provider it couldn't read.
- **P10. Pro "isn't offered".** `GET /v1/me/pro` makes no partner reads (unchanged). When no single provider covers the price, `buyProFromBalance` refuses with the existing `INSUFFICIENT_BALANCE`. The card option stays.
- **P11. Worker legacy readers.** The worker keeps today's extra readers for reconciliation and refunds (mock on non-production copies, and the sandbox reader on a mock copy with sandbox keys). Withdrawals are quoted and requested only through configured roles.
- **P12. Daily-check results** are stored in a new table, `provider_split_checks` (90-day retention). Split accounts and the retire check read the latest row per owner. The job runs every 15 minutes, checks at most 20 owners whose last check is more than 24 h old, and reads one owner at a time. That spreads the reads across the day.
- **P13. Indexes.** `queued_P` adds a `provider` filter to the existing per-owner query (owner indexes already bound it), so it needs no new index. `withdrawal_group_id` gets a partial index (`WHERE withdrawal_group_id IS NOT NULL`).

## Global Constraints

Every task includes these.

- **TDD.** Write the failing test, watch it fail, implement, then watch it pass. Financial code needs idempotency and concurrency tests (AGENTS.md).
- **No real provider in tests.** Database tests use plain-object readers. HTTP integration and e2e tests use `mock` plus the test-only second adapter `mock_alt` (P1). Nothing calls `api.bachs.io` or `sandbox-api.bachs.io`.
- **No regulatory approval implied.** D-04, D-06 and D-07 stay open. Never edit `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md` or `docs/design/redesign/README.md`.
- **Users never see provider names.** No user-facing response, copy, log shown to users or web page names a provider. Quotes and withdrawal rows carry amounts and states only. Staff screens may name providers.
- **Money.** Use integer minor units (`bigint`) and NGN. Never pay out more than the ledger total. The ledger is unchanged: no posting builder, no `balanceQuery` change and no backfill.
- **BullMQ job retention** for any new or changed job: `removeOnComplete: true`, `removeOnFail: { age: 7 * 24 * 3600 }` (`SCHEDULED_RUN_RETENTION` in `apps/worker/src/ensure-schedule.ts`).
- **E2E** runs in lanes 3–8 only (`E2E_LANE=3`…`8`). New or changed specs pass `--repeat-each=5 --retries=0 --workers=2` (`tests/e2e/AGENTS.md`). Any test that routes `**/v1/me/**` answers `/v1/me/events` with 204.
- **Screenshots.** Every PR with visible UI shows phone (390) and desktop (1440) screenshots of test data, on the `pr-assets` branch under `pr-<number>/`.
- **Migrations** go through `pnpm --filter @tipme/database generate` only. Number them after the latest on origin/dev at merge time (0127, 0128 today; rename on rebase). Never run a migration, backfill or script against staging or production.
- **API changes** regenerate OpenAPI (`pnpm --filter @tipme/api build && pnpm api:openapi`) and docs (`pnpm docs:generate`). Their `--check` must pass.
- **Process.** Each task is one PR into `dev`, in task order. Never `--no-verify`. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Commands used by every task

| What                 | Command                                                                                                                                                                                             | Passing output |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Domain tests         | `pnpm --filter @tipme/domain build && pnpm --filter @tipme/domain test`                                                                                                                             | `# fail 0`     |
| Payments tests       | `pnpm --filter @tipme/payments build && pnpm --filter @tipme/payments test`                                                                                                                         | `# fail 0`     |
| API unit tests       | `pnpm --filter @tipme/api build && pnpm --filter @tipme/api test`                                                                                                                                   | `# fail 0`     |
| Worker tests         | `pnpm --filter @tipme/worker build && pnpm --filter @tipme/worker test`                                                                                                                             | `# fail 0`     |
| Web unit tests       | `pnpm --filter @tipme/web test`                                                                                                                                                                     | `# fail 0`     |
| One integration file | `pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test <file>` (local Postgres and Redis)                                                     | `# fail 0`     |
| Migration check      | `pnpm --filter @tipme/database generate` after your migration                                                                                                                                       | no new file    |
| E2E (one spec)       | `E2E_LANE=5 TURBO_FORCE=true node scripts/build-e2e.mjs && E2E_LANE=5 node scripts/prepare-e2e-database.mjs && E2E_LANE=5 pnpm exec playwright test <spec> --repeat-each=5 --retries=0 --workers=2` | 0 failed       |
| Whole gate           | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`                                                                                                                                     | exit 0         |

## Review Focus

These are the inputs the spec implies but its test list doesn't name, most likely to hurt first. Each has its pinning test in the owning task.

1. **The person changes bank at the active provider while a withdraw-only provider still has the old bank.** Expected: that provider's money shows "add your bank details again" and is never sent to the old bank. _Test:_ `a part whose provider holds a different bank is never quoted or sent` (Task 5 quote, Task 6 request).
2. **Two withdrawals at once whose parts both draw the same withdraw-only provider.** Expected: the second sees the first's REQUESTED part in `queued_P` and can't spend that money twice. Its allocation moves to other providers or it is refused. _Test:_ `two requests at once never spend the same provider's money` (Task 6).
3. **A provider stops answering between the quote and the request.** Expected: the request never sends to the unread provider. It still succeeds if the readable ones cover the amount, and otherwise refuses `PAYOUT_PROVIDER_UNAVAILABLE` (P9). _Test:_ `a request with one provider unreadable uses only the others, or refuses unavailable` (Task 6).
4. **A retry of the same Idempotency-Key after one part failed.** Expected: the same group comes back with the failed part shown failed. No new part is created and nothing is re-sent. _Test:_ `a replay after one part failed returns the same group and writes nothing` (Task 6).
5. **A withdraw-only provider is removed from the list while one of its parts is still REQUESTED.** Expected: the worker never starts that payout through another provider. It stays REQUESTED, and the daily check opens `provider_unconnected_money`. _Test:_ `a payout at a provider no longer configured is never started through another` (Task 4) and `money at an unconnected provider opens one issue per provider` (Task 10).

---

### Task 1: The withdrawal allocator (domain)

**Files:**

- Create: `packages/domain/src/withdrawal-allocation.ts`
- Modify: `packages/domain/src/index.ts` (export it)
- Test: `packages/domain/test/withdrawal-allocation.test.mjs`

**Interfaces:**

- Consumes: `withdrawalMinimumMinor()` (`packages/domain/src/fees.ts`).
- Produces:
  - `allocateWithdrawal(amountMinor: bigint, capsMinor: readonly bigint[], minimumMinor?: bigint): bigint[] | null` returns an array as long as `capsMinor` (0 where a provider carries nothing), or null when the amount can't be split within the rules.
  - `withdrawalPartCount(amountMinor: bigint, capsMinor: readonly bigint[], minimumMinor?: bigint): number | null` gives the number of non-zero parts.
  - `capsMinor` is in drain order. `minimumMinor` defaults to `withdrawalMinimumMinor()`.

- [ ] **Step 1: Write the failing tests.** Let `M = withdrawalMinimumMinor()` and `[a, b]` be caps:
  - `one provider that covers the amount is used alone, first in drain order`: `([3M,10M], 2M) → [2M,0]` and `([3M,10M], 5M) → [0,5M]`.
  - `split in drain order when none covers it`: `([3M,10M], 12M) → [3M,9M]`.
  - `a part that empties a provider may be below the minimum`: `([M/2,10M], 10M+M/4) → [M/2, 10M−M/4]`.
  - `a small last part is raised by taking less from the one before`: `([5M,5M], 5M+M/2) → [4M+M/2, M]`. Also `([6M/5, M/2], 8M/5) → [11M/10, M/2]`, where the last part is raised only to its cap.
  - `null when no fold keeps every part valid`: `([M, 3M/2], 8M/5) → null`.
  - `null above the total or at zero`: `([M,M], 3M) → null`, `([M], 0n) → null`.
  - `part count`: `withdrawalPartCount(12M, [3M,10M]) === 2` and `withdrawalPartCount(2M, [3M,10M]) === 1`.
  - Property (seeded LCG, as `ledger.test.mjs` does, 500 cases): every non-null result sums to the amount, has `0 ≤ part ≤ cap`, and has every non-zero part either `≥ M` or equal to its cap.
- [ ] **Step 2: Run** the domain tests. Expected: FAIL, `allocateWithdrawal is not a function`.
- [ ] **Step 3: Implement.** The algorithm (§5, spec "use as few payouts as possible"):

```
if amount <= 0 or amount > Σcaps: return null
i = first index with caps[i] >= amount → parts[i] = amount; return parts
greedy: for each i in order, parts[i] = min(caps[i], remaining)
k = last index with parts[k] > 0
if parts[k] < min and parts[k] < caps[k]:
    target = min(min, caps[k]); need = target − parts[k]
    for j = k−1 down to 0 while need > 0:
        give = min(need, max(0, parts[j] − min)); parts[j] −= give; need −= give
    if need > 0: return null
    parts[k] = target
return parts
```

- [ ] **Step 4: Run** the domain tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(domain): allocate a withdrawal across providers`.

---

### Task 2: Provider roles in settings, and the second test adapter

**Files:**

- Modify: `packages/payments/src/settings.ts`, `packages/payments/src/mock/mock-provider.ts`, `packages/payments/src/index.ts`
- Modify: `apps/api/src/config.ts`, `apps/worker/src/config.ts` (both spread `paymentSettingsShape`; confirm the new key reaches both)
- Modify: `.env.example`, `docs/runbooks/settings-and-switches.md` (a section for `PAYMENT_WITHDRAW_ONLY_PROVIDERS`: what it does, the retire procedure from §4, and that it is never set on production while only `bachs-live` exists)
- Test: `packages/payments/test/settings.test.mjs`, new `packages/payments/test/mock-alt.test.mjs`, `apps/api/test/config.test.mjs`, `apps/worker/test/config.test.mjs`

**Interfaces:**

- Produces:
  - `WITHDRAW_ONLY_PROVIDER_NAMES = ['mock','mock_alt','bachs-sandbox','bachs-live'] as const` and `type WithdrawOnlyProviderName`.
  - `paymentSettingsShape.PAYMENT_WITHDRAW_ONLY_PROVIDERS`: a comma list, default `''`, parsed to `WithdrawOnlyProviderName[]` (trimmed, order kept).
  - `checkPaymentSettings` refuses (path `PAYMENT_WITHDRAW_ONLY_PROVIDERS`):
    - `mock` or `mock_alt` on a production copy, and `mock_alt` unless `NODE_ENV === 'test'`;
    - a duplicate, or the active provider itself;
    - a name whose `recordedProviderName` equals the active one's in a different environment (`bachs-live` active with `bachs-sandbox` listed, or the reverse);
    - `bachs-sandbox` on production or `bachs-live` off it;
    - a Bachs name without its API key, and in the API (`webhooks: true`) without its webhook secret.
  - `createMockProvider({ redis, secret?, prefix?, name?: 'mock' | 'mock_alt' })`. The adapter's `name` is that name, and every Redis key uses the prefix `${prefix}` for `mock` (unchanged) or `${prefix}:mock_alt`.
  - `MockProvider.markPayoutBalance(accountRef: string, availableMinor: bigint | null): Promise<void>`. `payoutBalance(accountRef)` returns the marked figure, or `PRETEND_BALANCE_MINOR` when none is set (null clears it).
  - `export function configuredPaymentProviders(config: { PAYMENT_PROVIDER: PaymentProviderName; PAYMENT_WITHDRAW_ONLY_PROVIDERS: readonly WithdrawOnlyProviderName[] }): { active: PaymentProviderName; withdrawOnly: WithdrawOnlyProviderName[] }` is the one place both apps read the roles.

- [ ] **Step 1: Write the failing tests.** Each refusal above gets one case in `settings.test.mjs`, asserting the issue path and message. Add `'mock_alt,mock' parses in list order` and `empty is []`. `mock-alt.test.mjs` (real local Redis as the integration tests use, or the fake Redis the payments tests already use) covers:
  - `mock_alt keys never collide with mock`: a payout initiated on each with the same payout id stays separate;
  - `markPayoutBalance sets and clears the figure for one account only`;
  - `name is mock_alt`.
- [ ] **Step 2: Run** the payments tests. Expected: FAIL.
- [ ] **Step 3: Implement** the shapes, checks, `configuredPaymentProviders` and the mock option. Update the API and worker config tests with one case each: `PAYMENT_WITHDRAW_ONLY_PROVIDERS=mock_alt` loads under `NODE_ENV=test`, and is refused in a production config.
- [ ] **Step 4: Run** the payments, API and worker tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(payments): withdraw-only providers setting and a second test adapter`.

---

### Task 3: API wiring for every provider in either role

**Files:**

- Modify: `apps/api/src/checkout/payment-provider.provider.ts`, `apps/api/src/checkout/checkout.module.ts`
- Modify: the webhook module that consumes `BACHS_PROVIDER_TOKEN`, so a withdraw-only Bachs still has its webhooks accepted. Find it with `grep -rn BACHS_PROVIDER_TOKEN apps/api/src`.
- Test: `apps/api/test/payment-provider-wiring.test.mjs`

**Interfaces:**

- Consumes: `configuredPaymentProviders`, `createMockProvider({ name })` (Task 2).
- Produces:
  - `PAYOUT_PROVIDERS_TOKEN = Symbol('PAYOUT_PROVIDERS')`, providing `PayoutProviderSet` = `{ active: MockProvider | BachsProvider; withdrawOnly: (MockProvider | BachsProvider)[] }`, with withdraw-only in list order.
  - `BACHS_PROVIDER_TOKEN` is also built when a Bachs name is withdraw-only (same `bachsFor`, with that environment's settings).
  - `MOCK_ALT_PROVIDER_TOKEN` is built only when `mock_alt` is listed. It shares the API's Redis and `QUEUE_PREFIX`.
  - `WITHDRAWAL_PROVIDER_TOKEN` is unchanged. It is still the active adapter, for the destination flows until Task 8.

- [ ] **Step 1: Write the failing tests** in `payment-provider-wiring.test.mjs`:
  - `withdraw-only mock_alt beside active mock gives both, active last in drain order`;
  - `withdraw-only bachs-sandbox beside active mock builds the sandbox adapter and its webhooks`;
  - `no withdraw-only list gives withdrawOnly []`;
  - `checkout still uses only the active provider`.
- [ ] **Step 2: Run** the API unit tests. Expected: FAIL.
- [ ] **Step 3: Implement** the factories. There is no behaviour change for any caller yet.
- [ ] **Step 4: Run** the API unit tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(api): build an adapter for every provider in either role`.

---

### Task 4: Worker wiring, reconciliation and reserve for every role

**Files:**

- Modify: `apps/worker/src/job-worker.ts` (:200-240 `workerBachsProvider`, :346-375 `providerFor` / `reconcileProEverywhere`, :505-535 reserve schedule, :639 share loop, :783 and :967 provider lists)
- Modify: `packages/database/src/operations/reconcile.ts` (`sweepParkedPayoutEvents` :564-740)
- Test: `apps/worker/test/payout-start-handler.test.mjs`, `apps/worker/test/payment-reserve-handler.test.mjs`, `packages/database/test/integration/reconcile.test.mjs`

**Interfaces:**

- Consumes: `configuredPaymentProviders`, `createMockProvider({ name })` (Task 2).
- Produces:
  - `export function workerPaymentProviders(config: WorkerConfig, redis: Redis): { byRecordedName: Map<string, MockProvider | BachsProvider>; withdrawalRoles: { active: string; withdrawOnly: string[] } }` in `job-worker.ts`. It holds the configured roles plus the legacy readers (P11).
  - `providerFor(name)` resolves through `byRecordedName` and throws `Unsupported persisted payment provider` otherwise, as today.
  - `reconcilePayouts` input gains `parkedProviders: readonly string[]` (recorded names). `sweepParkedPayoutEvents` filters `unmatched_provider_events.provider IN parkedProviders` and resolves each row's reader with `providerFor(input.provider, row.provider)` instead of `'bachs'`.
  - The reserve check (`payments.reserve`) runs for every connected-account adapter in either role, one schedule each, with id `payments.reserve` for the active one and `payments.reserve.<recordedName>.<environment>` otherwise. Each uses `SCHEDULED_RUN_RETENTION`. Payout setup, collect reserve and collect recon stay active-only.

- [ ] **Step 1: Write the failing tests:**
  - worker `a payout at a provider no longer configured is never started through another` (Review Focus 5). A REQUESTED payout with `provider='mock_alt'`, on a worker without `mock_alt` configured: the start handler throws `Unsupported persisted payment provider`, no `initiatePayout` is called on mock, and the row stays REQUESTED.
  - worker `payouts at mock_alt start through mock_alt`.
  - worker `a withdraw-only Bachs gets its own reserve schedule with run retention` (assert the template opts equal `SCHEDULED_RUN_RETENTION`).
  - integration (`reconcile.test.mjs`) `parked payout events are rechecked through their own provider`: one parked row for `mock_alt` and one for `bachs`, each read through its own fake reader, and a row for an unlisted provider is left alone.
- [ ] **Step 2: Run** the worker tests and that integration file. Expected: FAIL.
- [ ] **Step 3: Implement.** The worker loops (`reconcileProEverywhere`, share transfers, :783, :967) iterate `byRecordedName` rather than the literal `[mock, bachs]` pairs.
- [ ] **Step 4: Run** them. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(worker): reconcile and reserve-check every configured provider`.

---

### Task 5: The per-provider quote

**Files:**

- Create: `packages/database/src/operations/payout-providers.ts`
- Modify: `packages/database/src/operations/payouts.ts` (`collectedElsewhere`, `withdrawalsAvailable`, `quoteGate`, `localWithdrawalQuote`, `quoteFor`, `queuedNotStarted`, `WithdrawalQuoteResult`), `packages/database/src/index.ts`
- Modify: `packages/contracts/src/dashboard.ts` (`WithdrawalQuote` ready)
- Modify: `apps/api/src/dashboard/dashboard.controller.ts` (`summary`, `quoteWithdrawal`, `logReadFailure` naming the provider for staff logs only), `apps/api/src/business/business-payouts.controller.ts` (`withdrawal-quote`). Both inject `PAYOUT_PROVIDERS_TOKEN`.
- Test: new `packages/database/test/integration/withdrawals-split.test.mjs`. Update `withdrawals.test.mjs` :298 (`money collected by a provider without payouts…`) to the new rule. Add new `tests/integration/withdrawals-split-api.test.mjs`.

**Interfaces:**

- Consumes: `allocateWithdrawal` (Task 1), `PAYOUT_PROVIDERS_TOKEN` (Task 3).
- Produces (database):
  - `export interface PayoutProviderSet { active: PayoutReader; withdrawOnly: readonly PayoutReader[] }`.
  - `export function drainOrder(set: PayoutProviderSet): PayoutReader[]` returns the withdraw-only providers in order, then the active one.
  - `export async function ownerProviderSet(db: Database | Tx, owner: MoneyOwner, set: PayoutProviderSet): Promise<{ providers: PayoutReader[]; heldElsewhere: boolean }>`. `providers` are the configured providers in drain order at which the owner has an account reference or a successful tip (a business counts tips carrying its share, as `collectedElsewhere` does today), and always include the active one. `heldElsewhere` means a successful tip went through a provider that is not configured.
  - `export function sameBank(a: DestinationRow, b: DestinationRow): boolean` (P5).
  - `queuedNotStarted(db, owner, provider?: string)` gives `queued_P` when a recorded provider name is given.
  - `QuoteInput.provider` is replaced by `providers: PayoutProviderSet`. `withdrawalsAvailable(db, { profileId, providers })` is false only when the owner has money at unconnected providers and no account or successful tip at any configured one (§8). `localWithdrawalQuote` takes `providers` as well.
  - The `WithdrawalQuoteResult` ready state adds `capsMinor: bigint[]` (each provider's take in drain order, zeros dropped), `partial: boolean`, `bankDetailsNeeded: boolean` and `heldElsewhere: boolean`. `providerMinor` becomes `Σ avail_P`, and `feeMinor` follows P8.
  - Cache: `cachedReader` and `partnerStamp` run per `{ provider: P.name, ...owner }`, with that provider's route.
- Produces (contracts): `WithdrawalQuote` ready adds `capsMinor: string[]`, `partial: boolean`, `bankDetailsNeeded: boolean` and `heldElsewhere: boolean`.

- [ ] **Step 1: Write the failing integration tests** (`withdrawals-split.test.mjs`). Readers are plain objects: `active` is `{ name: 'mock', capabilities: { connectedAccounts: false } }`, and `old` is `{ name: 'mock_alt', capabilities: { connectedAccounts: false } }`, each with a settable balance. Tips are seeded through `markAttemptInitiated` and `recordProviderEvent` with `provider: 'mock_alt'` or `'mock'`, as `withdrawals.test.mjs:43-75` does.
  - `money at both providers is one balance: capped by the ledger, drawn withdraw-only first`: ledger 372,000 × 2. With `old` at 372,000 and `active` huge, the result is `withdrawableMinor = 744000n` and `capsMinor = [372000n, 372000n]`.
  - `the ledger caps the total even when providers hold more`.
  - `a failed read at one provider leaves the rest withdrawable and marks partial`: `old.payoutBalance` throws, so `partial === true` and `capsMinor = [372000n]`.
  - `a part whose provider holds a different bank is never quoted or sent` (Review Focus 1, quote half). `old` is made connected-account (`{ name: 'bachs-sandbox', connectedAccounts: true }`, with an account and a destination whose last4 differs from active's). Expected: `bankDetailsNeeded === true` and that provider's money is not in `withdrawableMinor`.
  - `the active route still decides setup states`: with no active destination on a connected-account active, the result is `{ state: 'no_destination' }` (P3).
  - `money at an unconnected provider no longer blocks the rest`: a tip at `'bachs'`, with neither role bachs, gives `heldElsewhere === true` and the mock money withdrawable. `withdrawalsAvailable` is true while a configured provider took a tip, and false when only the unconnected one did.
  - `queued payouts count against their own provider only`.
  - `a business owner gets the same allocation` (seed through `business-fixtures.mjs` as `business-payouts.test.mjs` does).
  - API (`tests/integration/withdrawals-split-api.test.mjs`, `startStack({ apiEnv: { PAYMENT_WITHDRAW_ONLY_PROVIDERS: 'mock_alt' }, workerEnv: { PAYMENT_WITHDRAW_ONLY_PROVIDERS: 'mock_alt' } })`): `GET /v1/me/withdrawal-quote` returns `capsMinor` as strings, and **the body contains neither `mock_alt` nor `mock`** (users never see provider names).
- [ ] **Step 2: Run** both integration files. Expected: FAIL.
- [ ] **Step 3: Implement** `quoteFor` exactly as §5's pseudocode, through `ownerProviderSet` and `drainOrder`. `quoteGate` keeps the switch, holds and below-zero checks and the active route block, and drops the `collectedElsewhere` block (§8). Delete `collectedElsewhere` once nothing calls it. Map the new fields in both controllers (bigint → string). Regenerate OpenAPI and docs.
- [ ] **Step 4: Run** both files and `withdrawals.test.mjs`, `business-payouts.test.mjs`, `withdrawal-free-per-day.test.mjs`, `payout-fee-user.test.mjs`. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(payouts): quote across every provider that holds the owner's money`.

---

### Task 6: Split requests, groups and fees

**Files:**

- Modify: `packages/database/src/schema.ts` (`payouts`: `withdrawalGroupId: uuid('withdrawal_group_id')`, `groupPart: smallint('group_part')`, a check `(withdrawal_group_id IS NULL) = (group_part IS NULL)`, and the partial index `payouts_withdrawal_group`)
- Create: `packages/database/drizzle/0127_withdrawal_groups.sql` (generated) and its meta
- Modify: `packages/database/src/operations/payouts.ts` (`requestFor`, `personsWithdrawalsToday`, `feePayerFor`, `RequestResult`), `packages/database/src/operations/dashboard.ts` (`listMyWithdrawals`; also the business list if it is separate: `grep -n "business_id" dashboard.ts business-*.ts` for the business withdrawals reader)
- Modify: `packages/contracts/src/dashboard.ts` (`WithdrawalRow.parts`, request response), `apps/api/src/dashboard/dashboard.controller.ts` (`withdraw` invalidates the cache for every provider in the set before and after, and returns the group), `apps/api/src/business/business-payouts.controller.ts` (`withdraw`, same)
- Test: `packages/database/test/integration/withdrawals-split.test.mjs` (extend), `packages/database/test/integration/withdrawal-free-per-day.test.mjs`, `tests/integration/withdrawals-split-api.test.mjs` (extend)

**Interfaces:**

- Consumes: `allocateWithdrawal` (Task 1), `ownerProviderSet`, `drainOrder`, `sameBank`, `queuedNotStarted(…, provider)` (Task 5).
- Produces:
  - `RequestInput.provider` is replaced by `providers: PayoutProviderSet`.
  - `RequestResult = { payoutId: string; status: string; replayed: boolean; groupId: string | null; parts: { payoutId: string; amountMinor: bigint; status: string }[] }`. `payoutId` is part 1, or the only payout.
  - Contracts: `POST /v1/me/withdrawals` responds `{ payoutId, status, groupId: string | null, parts: { payoutId: string; amountMinor: string; status: string }[] }`. `WithdrawalRow` adds `parts: { amountMinor: string; state: WithdrawalState }[] | null`. It is null when the request was a single payout, and the row's `amountMinor` is the group total.

- [ ] **Step 1: Write the failing tests:**
  - `a request larger than any one provider is paid as two parts in drain order`: two `payouts` rows, each with its own `provider`, `account_reference` and `destination_id`, sharing `withdrawal_group_id`, with `group_part` 1 and 2. Part 2's key is `<key>:2`. There are two `payouts.start` outbox rows.
  - `a request one provider covers is a single payout with no group` (P6).
  - `the replay of a split returns the same group`, and `a replay after one part failed returns the same group and writes nothing` (Review Focus 4): fail part 2 through `failPayoutByStaff`, replay, and assert the same ids, part 2 `FAILED` and no new rows or outbox.
  - `two requests at once never spend the same provider's money` (Review Focus 2). Two `requestWithdrawal` calls run in parallel with their combined amount equal to the withdrawable total. The `old` reader returns its full balance to both reads. Both succeed with distinct allocations and `Σ` per provider ≤ that provider's balance, or the second refuses `INSUFFICIENT_BALANCE`. Never more than the ledger in total.
  - `a request with one provider unreadable uses only the others, or refuses unavailable` (Review Focus 3, P9).
  - `a part whose provider holds a different bank is never quoted or sent` (Review Focus 1, request half): the request can't take that provider's money and refuses `INSUFFICIENT_BALANCE` when the amount needs it.
  - `a split counts as one withdrawal of the day` (`withdrawal-free-per-day.test.mjs`): with two free per day, split + split → both free; the third request is `fee_payer='user'` on its largest part only, so `user_fee_minor` > 0 on exactly one row.
  - `a user-paid fee comes off the largest part once`. The largest part's `amount_minor = chosen − fee`, other parts have `fee_payer='tipme'` and `user_fee_minor=0`, and `WITHDRAWAL_BELOW_FEE` applies when the largest part is not more than the fee.
  - `a business split pays at most one fee` (business, `business_payout_fee_absorbed` off): exactly one part has `fee_payer='user'`. With the switch on, none does.
  - `You collect limits apply to the request total` (a collect recipient, with `refuseOverCollectLimits` on the total).
  - `a failed part releases only its own reservation`: after part 2 fails, the quote's `withdrawableMinor` grows by part 2's amount.
  - `the withdrawals list shows one row per request with its parts`, and API: `POST /v1/me/withdrawals` returns `parts` amounts as strings with no provider names.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Read every provider in `ownerProviderSet` outside the transaction (`readProvider`, no cache) to get `avail_P`.
  - Under the owner lock, recompute `caps_P = max(0, avail_P − queued_P)` for usable parts (route not blocked, `sameBank` with the active destination), and check `amount ≤ min(ledger, Σcaps)` (P9 for the refusal code). Then `belowWithdrawalMinimum(amount, min(ledger, Σcaps))`, then `allocateWithdrawal` (null → `WITHDRAWAL_TOO_SMALL`).
  - Decide `feePayerFor` once for the request, using the largest part's provider and fee.
  - Lock each used destination `FOR SHARE`, and insert the parts with `onConflictDoNothing` on the idempotency key (a conflict on part 1 → replay).
  - Rewrite `personsWithdrawalsToday` as P7. `listMyWithdrawals` groups by `COALESCE(withdrawal_group_id, id)`, keeps the cursor on part 1's `(created_at, id)`, and derives the row state from the parts: `sent` only when all are sent, `failed` only when all failed, otherwise the least advanced part that has not failed (the web shows "Partly sent" from `parts`, Task 9). Regenerate OpenAPI and docs.
- [ ] **Step 4: Run** the migration check, these files and the Task 5 list. Expected: no new migration, `# fail 0`.
- [ ] **Step 5: Commit** `feat(payouts): one request paid as parts across providers`.

---

### Task 7: Pro from balance through one provider

**Files:**

- Modify: `packages/database/src/operations/pro-balance.ts` (`buyProFromBalance`, `accountOf`, `queuedNotSent`)
- Modify: `apps/api/src/pro/pro-provider.ts`, `apps/api/src/pro/pro.controller.ts` (`buy` passes the provider set)
- Test: `packages/database/test/integration/pro-balance.test.mjs`

**Interfaces:**

- Consumes: `ownerProviderSet`, `drainOrder` (Task 5), `PAYOUT_PROVIDERS_TOKEN` (Task 3).
- Produces: `buyProFromBalance` input replaces `provider` and `providerName` with `providers: { reader: ProCollectProvider & { name: string; capabilities?: { connectedAccounts: boolean } } }[]`, in drain order. The purchase records the chosen provider's recorded name and account reference (as `extra` does today). `accountOf` treats any accountless adapter (`connectedAccounts === false`) as `profileId`. `queuedNotSent(tx, profileId, provider)` is per provider.

- [ ] **Step 1: Write the failing tests:**
  - `Pro is paid from the first provider in drain order that covers the price alone`;
  - `Pro is refused INSUFFICIENT_BALANCE when only a split would cover it` (P10), with nothing reserved;
  - `a replay returns the same purchase whichever provider paid`;
  - `the read-back finds a balance purchase at a withdraw-only provider` (`reconcileProCollections` with `providerName: 'mock_alt'`).
- [ ] **Step 2: Run** `pro-balance.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Read each provider (capability + balance), pick the first with `min(ledger, avail_P − queued_P) ≥ price`, and keep the existing guard under the lock for that provider.
- [ ] **Step 4: Run** `pro-balance.test.mjs` and `tests/integration/pro-*.test.mjs`. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(pro): pay from the balance through one provider in drain order`.

---

### Task 8: Bank details at every provider

**Files:**

- Create: `apps/api/src/profiles/register-bank-everywhere.ts`
- Modify: `apps/api/src/profiles/payout-destination.controller.ts` (`update`), `apps/api/src/profiles/collect-bank.controller.ts` (its save route), `apps/api/src/business/business-payouts.controller.ts` (bank `PUT`)
- Test: `tests/integration/withdrawals-split-api.test.mjs` (extend), `tests/integration/collect-bank-api.test.mjs`, `tests/integration/business-payouts-api.test.mjs`

**Interfaces:**

- Consumes: `ownerProviderSet` (Task 5), `PAYOUT_PROVIDERS_TOKEN` (Task 3), `setPayoutDestination` (unchanged).
- Produces: `registerBankEverywhere(input: { db: Database; owner: MoneyOwner; providers: DestinationProvider[] (the controller's existing type: `addPayoutDestination`, `payoutDestinationStatus`, `name`, `capabilities`), active first; accountRefFor(provider): Promise<string | null>; bank: { accountNumber; accountName; bankCode; bankName }; save(provider, added, status): Promise<void>; log }): Promise<{ registered: string[]; needsAction: string[] }>`. It names providers for staff logs only.
  - The active provider goes first, and its failure is the request's failure, exactly as today.
  - Each other connected-account provider is registered after the active one succeeds. A refusal or error there is logged (`withdrawal.bank_register_failed`, recorded provider name, `safeError`) and leaves that part as "needs action".
  - Accountless providers are skipped (P5).
  - The email code is spent once. Each `setPayoutDestination` runs its own checks, so the cooling-off, name lock and You collect same-bank review block only their own provider.

- [ ] **Step 1: Write the failing tests:**
  - `changing bank registers it at every connected provider in the owner's set`. Use the mock-as-connected test hook already used by `business-payouts-api.test.mjs`, or seed `payment_accounts` for `bachs` with the local stand-in (`no-real-provider.mjs`). Assert one active `payout_destinations` row per provider with the same `bank_code` and `account_last4`.
  - `a provider that refuses the new bank leaves only its part needing action`: the quote shows `bankDetailsNeeded: true` and the rest stays withdrawable.
  - `re-entering the current bank fixes a part that needed action`.
  - collect, and business: the same first case through their routes.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement** the helper and use it in the three routes. Invalidate the partner cache for every provider in the set. Regenerate OpenAPI and docs if any response changes.
- [ ] **Step 4: Run** those files. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(payouts): register bank details at every provider holding money`.

---

### Task 9: What the person sees

**Files:**

- Modify: `apps/web/src/lib/withdraw-state.ts` (drop `collected_elsewhere`, add the §6 states), `apps/web/src/app/dashboard/withdraw/withdraw-view.tsx` (the "may arrive as N payments" line, the receipt parts, list rows with parts), `apps/web/src/app/dashboard/home-view.tsx`, `apps/web/src/app/dashboard/business/sections/money.tsx`
- Modify: `packages/contracts/src/copy.ts` (new strings, in its tone)
- Modify: `playwright.config.ts` (API and worker env: `PAYMENT_WITHDRAW_ONLY_PROVIDERS: 'mock_alt'`)
- Test: `apps/web/test/withdraw-state.test.mjs`, new `tests/e2e/withdraw-split.spec.ts`, and existing `tests/e2e/withdraw.spec.ts` and `tests/e2e/business-money.spec.ts` (must stay green)

**Interfaces:**

- Consumes: the quote fields (Task 5), the request response and `WithdrawalRow.parts` (Task 6), `withdrawalPartCount` (Task 1).
- Produces: `WithdrawState.kind` loses `collected_elsewhere`, and `WithdrawState` gains `extraNotices: { title: string; body: string }[]` and `partsFor(amountMinor: bigint): number`. Exact copy (§6):
  - partial: "Some of your balance can't be withdrawn right now. Try again later."
  - bank: "Add your bank details again to withdraw all of your balance." It links to `/dashboard/settings#get-paid`.
  - held elsewhere: today's body ("Some of your tips were paid in a way TipMe can't pay out from yet. Your tips are safe, and your balance stays here until withdrawals open."), now as an extra notice beside a usable form.
  - split hint: "This may arrive as {n} payments." It shows only when `n > 1`.
  - a group with some parts sent and others not (§5 Failures): "Partly sent". Each part shows ✓ sent, ⏳ on its way, or failed.

- [ ] **Step 1: Write the failing tests.**
  - `withdraw-state.test.mjs`: one case per notice; `withdrawalsAvailable` false now gives the held-elsewhere notice only when the quote isn't ready; `partsFor` matches `withdrawalPartCount` on `capsMinor`.
  - `withdraw-split.spec.ts`: sign up, save a bank, and get one tip via mock (`tipAsVisitor`). Seed one ₦2,000 tip via `mock_alt` through `withDatabase` (`markAttemptInitiated` + `recordProviderEvent`, `provider: 'mock_alt'`). Set `mock_alt`'s balance for the profile with `markPayoutBalance` over Redis (`E2E_REDIS_URL`, prefix `${stackEnv.QUEUE_PREFIX}:mock_alt`) to less than the total. Then:
    - `a split owner sees one balance, withdraws, and sees two parts`: the meter shows one total, the form shows "This may arrive as 2 payments." after typing the full amount, and the receipt and list row show two amounts. Scope text to `main`, and never show a provider name (`expect(page.locator('main')).not.toContainText(/mock/i)`).
    - `a provider that can't be read leaves the rest withdrawable`: `page.route` the quote to `partial: true`.
    - axe check with `expectAccessible`.
- [ ] **Step 2: Run** the web tests and the spec. Expected: FAIL.
- [ ] **Step 3: Implement** to `docs/design/DESIGN-CONSTITUTION.md` (read it and `RESPONSIVE-COMPOSITION.md` first). Parts render as a list of amounts with each state (sent / on its way / failed), and there is no new visual pattern.
- [ ] **Step 4: Run** the web tests, `withdraw-split.spec.ts`, `withdraw.spec.ts` and `business-money.spec.ts` with `--repeat-each=5 --retries=0`. Expected: `# fail 0`, 0 failed. Take the phone and desktop screenshots.
- [ ] **Step 5: Commit** `feat(web): one balance across providers, split receipts`.

---

### Task 10: The daily split check

**Files:**

- Modify: `packages/database/src/schema.ts` (`providerSplitChecks`: `id`, `profile_id`, `business_id` (one of), `checked_at`, `ledger_minor`, `providers jsonb` `[{ provider, availableMinor: string | null, queuedMinor: string }]`, `outcome text` checked `IN ('ok','short','over','partial')`, plus indexes `(profile_id, checked_at DESC)` and `(business_id, checked_at DESC)`)
- Create: `packages/database/drizzle/0128_provider_split_checks.sql` (generated), and `packages/database/src/operations/provider-split.ts`
- Modify: `packages/contracts/src/ops.ts` (`ISSUE_KINDS` += `provider_split_short`, `provider_unconnected_money`), `packages/database/src/operations/issues.ts` (summaries), `apps/worker/src/job-worker.ts` (job `payments.split_check`), new `apps/worker/src/handlers/provider-split.ts`
- Test: new `packages/database/test/integration/provider-split.test.mjs`, new `apps/worker/test/provider-split-handler.test.mjs`

**Interfaces:**

- Consumes: `ownerProviderSet`, `queuedNotStarted(…, provider)` (Task 5), `openIssue`.
- Produces:
  - `SPLIT_SHORT_THRESHOLD_MINOR = 10_000n` (₦100) and `SPLIT_CHECK_BATCH = 20`.
  - `splitOwnersDue(db, set: PayoutProviderSet, input: { now: Date; limit: number }): Promise<MoneyOwner[]>` returns owners whose set has ≥2 configured providers or includes a withdraw-only one, and whose latest check is missing or older than 24 h, oldest first.
  - `checkProviderSplit(db, owner, set, input: { now: Date; onReadFailure? }): Promise<{ outcome: 'ok' | 'short' | 'over' | 'partial' }>`. It inserts one row. `short` means `ledger − Σ(avail_P − queued_P) > SPLIT_SHORT_THRESHOLD_MINOR`, and opens `provider_split_short` (dedupe key `provider_split_short.<owner id>`, `money` severity, note: the per-provider figures with recorded names). `over` is informational, with no issue. A failed read is `partial`, with no issue.
  - `flagUnconnectedMoney(db, set, now): Promise<number>` opens one `provider_unconnected_money` per unconnected recorded provider (dedupe `provider_unconnected_money.<provider>`) whose owners hold ledger money and successful tips there. The note lists the owner ids, and any REQUESTED payouts still recorded there.
  - `purgeSplitChecks(db, now)` deletes rows older than 90 days.
  - Worker job `payments.split_check`: `ensureSchedule({ every: 15 * 60_000 })` with `SCHEDULED_RUN_RETENTION`, behind `runUnlessRunning`. It checks owners one at a time and stops early at 40 provider reads.
- [ ] **Step 1: Write the failing tests:**
  - `a split owner whose providers hold less than the ledger by more than ₦100 opens provider_split_short`;
  - `a gap of ₦100 or less opens nothing`;
  - `providers holding more is recorded as over with no issue`;
  - `a failed read records partial with no issue`;
  - `a single-provider owner is never checked`;
  - `an owner checked within 24 h is not due`;
  - `money at an unconnected provider opens one issue per provider` (Review Focus 5);
  - `old checks are purged after 90 days`;
  - worker: `the split check runs one owner at a time, stops at the read budget, and keeps run retention`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the migration check and both files. Expected: no new migration, `# fail 0`.
- [ ] **Step 5: Commit** `feat(ops): daily check of split accounts against their providers`.

---

### Task 11: Split accounts and the retire check (ops)

**Files:**

- Modify: `packages/database/src/operations/provider-split.ts` (readers)
- Create: `apps/api/src/ops/split-accounts.controller.ts` (register in `apps/api/src/ops/ops.module.ts`), and modify `apps/api/src/ops/providers.controller.ts` (`GET payments/retire`)
- Modify: `packages/contracts/src/ops.ts` (view types)
- Create: `apps/web/src/app/ops/split-accounts/page.tsx`. Modify `apps/web/src/app/ops/providers/page.tsx` (a "Payment providers" section), `apps/web/src/lib/ops-menu.ts` (link "Split accounts", group `Work`, needs `['issues.view']`) and `apps/web/src/lib/ops-client.ts`
- Test: `packages/database/test/integration/provider-split.test.mjs` (extend), new `tests/integration/ops-split-accounts-api.test.mjs`, new `tests/e2e/ops-split-accounts.spec.ts`

**Interfaces:**

- Consumes: Task 10's table and `checkProviderSplit`, `PAYOUT_PROVIDERS_TOKEN`.
- Produces:
  - `listSplitAccounts(db, set, { cursor?, limit }): Promise<{ items: { owner: { profileId?: string; businessId?: string; handle: string | null }; ledgerMinor: bigint; providers: { provider: string; role: 'active' | 'withdraw_only'; queuedMinor: bigint }[]; lastCheck: { checkedAt: Date; outcome: string } | null }[]; nextCursor: string | null }>`.
  - `GET /v1/ops/split-accounts` (permission `issues.view`) lists them. `POST /v1/ops/split-accounts/read` (permission `issues.view`, rate-limited as the other ops reads, body `{ profileId } | { businessId }`) reads each provider's balance now through the partner quote cache and returns `{ provider, availableMinor | null }[]`. It is audited (`recordAudit`, `split_account.read`).
  - `RETIRE_AFTER_MS = 30 * 24 * 3_600_000`.
  - `retireCheck(db, set, now): Promise<{ provider: string; ownersWithMoney: number; openPayouts: number; openRefunds: number; openDisputes: number; lastActivityAt: Date | null; canRetire: boolean }[]>`, for each withdraw-only provider. `ownersWithMoney` comes from each owner's latest check with `availableMinor > 0` there. Open means payouts REQUESTED/PROCESSING, `tip_refunds` and `disputes` not final, recorded at that provider. `canRetire` requires all four to be zero and `now − lastActivityAt ≥ RETIRE_AFTER_MS`.
  - `GET /v1/ops/providers/payments/retire` (permission `providers.manage`) returns it.
- [ ] **Step 1: Write the failing tests:**
  - `split accounts lists only owners with two or more configured providers or a withdraw-only one`;
  - `can retire only at zero after 30 days`: an open refund, an owner with money, and day 29 each block it, and day 30 with all zero allows it;
  - API: `a staff member without issues.view gets 403`, `the on-demand read is audited`;
  - e2e: `staff see a split account and a withdraw-only provider's retire state` (phone + desktop, `expectAccessible`).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** to the design constitution, following `apps/web/src/app/ops/collect/` table patterns. Staff screens may name providers. Regenerate OpenAPI and docs.
- [ ] **Step 4: Run** them, and the e2e spec with `--repeat-each=5 --retries=0`. Expected: `# fail 0`, 0 failed. Take the screenshots.
- [ ] **Step 5: Commit** `feat(ops): split accounts screen and the provider retire check`.

---

## After the last task

Run the whole gate, `pnpm test:integration` and every e2e spec this plan touched. Then do a whole-branch review against the spec, §-by-§:

- §4: Tasks 2–4
- §5: Tasks 1, 5, 6
- §5a: Task 10
- §6: Tasks 8, 9
- §7: Tasks 10, 11
- §8: Tasks 4, 5, 7, 9
- §9: every task
