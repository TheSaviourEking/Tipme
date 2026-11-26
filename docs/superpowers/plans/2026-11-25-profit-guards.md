# Profit Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TipMe stops losing money on ordinary transactions: people pay the ₦50 withdrawal fee on every withdrawal, card is offered at checkout only when TipMe's share covers the card cost, and staff can't set a rate below 2%.

**Architecture:** Part 1 changes one decision (`feePayerFor`) and the copy that described the free count. Part 2 adds one pure domain function (`checkoutMethodsFor`) that the API calls with the quote's share, passing the result through an optional `paymentMethods` field on the payment port to the Bachs request. Part 3 raises an app-level constant and tightens one ops schema; database checks stay.

**Tech Stack:** TypeScript, pnpm/Turbo, NestJS API, Drizzle/Postgres, Next.js web, node:test.

**Spec:** `docs/superpowers/specs/2026-11-25-profit-guards-design.md`

## Global Constraints

- Partner withdrawal fee: `NGN_PAYOUT_FEE_MINOR` = ₦50 (`5000n`), from `packages/payments/src/payout-fee.ts`. Never hard-code another copy.
- Card cost defaults: rate **200 bps**, fixed **₦45 (`4500n`)**, margin **₦15 (`1500n`)**, changeable by staff on the ops screen (Task 5). Bank transfer is always offered.
- Lowest plan or page rate staff can set: **200 bps**; a page rate of **0** (fee-free) stays allowed. Database checks (`schema.ts:732`, `schema.ts:3474-3477`) are not changed. The only migration is Task 5's new table.
- Payouts and quotes keep the rule they were made under (`payouts.fee_payer`, the quote's share). Nothing is retroactive.
- Pro subscription checkouts (`initializePlatformCheckout`) keep both methods.
- Users never see the provider's name ("our payment partner"). Copy: "Each withdrawal costs ₦50, charged by our payment partner."
- No regulatory approval is implied (D-04, D-06, D-07 stay open). Never edit `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`.
- No test calls `api.bachs.io` or `sandbox-api.bachs.io`; Bachs tests use the existing fake fetch.
- Integration tests run with `--test-concurrency=1`. E2E lanes 3–8 only. Linux visual baselines only from CI artifacts.
- No `--no-verify`, no bare `git stash`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- PATH: `$HOME/.nvm/versions/node/v24.22.0/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH`.

## Review Focus

1. **A rate changed between quote and checkout:** the methods follow the quoted share, never today's rate. Test in Task 6.
2. **A fee-free tip (credit or 0% page) of any size:** bank transfer only. Tests in Tasks 3 and 6.
3. **A retried checkout start** (same attempt, same idempotency key) sends the identical method list, so the partner never sees a different body under one key, even if staff change the card costs in between. Tests in Tasks 5 and 6.
4. **A person's 3rd withdrawal of a day whose first two were TipMe-paid before the release:** pays ₦50 like any other; nothing still counts free slots. Test in Task 1.
5. **A whole balance under ₦2,000** (₦1,500) withdraws with ₦50 off (₦1,450 arrives); ₦50 or less stays refused. Test in Task 1.

---

### Task 1: People pay the withdrawal fee on every withdrawal

**Files:**

- Modify: `packages/database/src/operations/payouts.ts` (`feePayerFor` ~2013-2038, quote field `freePerDay` ~1971; drop `personsWithdrawalsToday` if nothing else uses it, else leave it)
- Test: rename `packages/database/test/integration/withdrawal-free-per-day.test.mjs` → `withdrawal-fee-user-pays.test.mjs` and rewrite it; update expectations in `withdrawals.test.mjs`, `withdrawals-split.test.mjs`, `payout-fee-user.test.mjs` that assumed the free count

**Interfaces:**

- Produces: quote field `freePerDay` is `0` for every owner (contract unchanged; the web hides the "Nth withdrawal" line when it is 0). `feePaidBy` stays `'user' | 'tipme'`.

- [ ] **Step 1: Write the failing tests** in `withdrawal-fee-user-pays.test.mjs`:
  - `a person's first withdrawal of the day pays the fee from the amount`: request ₦10,000 → payout `fee_payer = 'user'`, `user_fee_minor = 5000n`, recipient receives `995000n`; quote `feePaidBy === 'user'`, `freePerDay === 0`.
  - `an unused top-up on the person's account pays the fee first`: seed an unused `provider_fee_credits` row of `5000n` for their account → `fee_payer = 'tipme'`, `user_fee_minor = 0n`, the credit marked used.
  - `two TipMe-paid withdrawals earlier today don't make the third free or paid differently`: seed two `fee_payer = 'tipme'` payouts today → third is `'user'` with `5000n` (Review Focus 4).
  - `a whole balance of ₦1,500 withdraws with ₦50 off`: `amount` = whole balance `150000n` → `user_fee_minor = 5000n`, receives `145000n`; a balance of `5000n` is refused with today's error code (Review Focus 5).
  - `a payout requested before the release with fee_payer tipme still gets its top-up`: seed a `REQUESTED` payout with `fee_payer = 'tipme'`, run `startPayout` on the pretend provider with connected accounts → `coverPayoutFee` called once.
  - `a business is unchanged`: business withdrawal → `'user'`; with `business_payout_fee_absorbed` on → `'tipme'`.
- [ ] **Step 2: Run them, expect FAIL** (first-of-day is `'tipme'` today):
      `pnpm --filter @tipme/database build && node --test --test-concurrency=1 packages/database/test/integration/withdrawal-fee-user-pays.test.mjs`
- [ ] **Step 3: Implement.** In `feePayerFor`, a person follows the business path without the switch: `'tipme'` only when `freeFeeCredit` finds an unused top-up for their account, else `'user'`. Set `freePerDay: 0`. Update the doc comment (owner, 25 Nov 2026: people pay the fee on every withdrawal).
- [ ] **Step 4: Run the new file and the touched files, expect PASS:**
      `node --test --test-concurrency=1 packages/database/test/integration/{withdrawal-fee-user-pays,withdrawals,withdrawals-split,payout-fee-user,business-payouts}.test.mjs`
      A split request still charges the person one fee and TipMe the extra parts (existing split tests).
- [ ] **Step 5: Commit** `feat(withdrawals): people pay the partner fee on every withdrawal`.

### Task 2: Withdrawal and fee wording

**Files:**

- Modify: `packages/domain/src/fees.ts` (remove `FREE_WITHDRAWALS_PER_DAY` at :308; comment at :61 and `DEFAULT_PLAN_FEE_RATES` docs: "processing included")
- Modify: `apps/web/src/lib/fee-share.ts` (replace `FREE_WITHDRAWALS_COPY` with `WITHDRAWAL_FEE_COPY`)
- Modify: `apps/web/src/app/legal/terms/page.tsx:54`, `apps/web/src/app/pro/page.tsx:113,132`, `apps/web/src/app/ops/pages/page.tsx:493`, `apps/web/src/lib/withdraw-state.ts:422-424`
- Test: the web unit tests that assert this copy (find with `grep -rn "free\b.*withdrawal\|FREE_WITHDRAWALS" apps/web/test apps/web/src`)

**Interfaces:**

- Consumes: Task 1 (`freePerDay` is 0).
- Produces: `WITHDRAWAL_FEE_COPY = 'Each withdrawal costs ₦50, charged by our payment partner.'` built from `NGN_PAYOUT_FEE_MINOR` and `formatNaira`.

- [ ] **Step 1: Update the copy tests first** to expect: Terms "Withdrawals: each withdrawal costs ₦50, charged by our payment partner, and comes off the amount."; Pro page bullet removed; Pro FAQ "…keeps 3% of each tip instead of 5%, with payment processing included. Each withdrawal costs ₦50, charged by our payment partner. This is the same on both plans."; ops pages line uses `WITHDRAWAL_FEE_COPY`. Rates come from the existing `PlanFeePercents`, never literals.
- [ ] **Step 2: Run them, expect FAIL:** `pnpm --filter @tipme/web test`
- [ ] **Step 3: Implement** the copy; delete `FREE_WITHDRAWALS_PER_DAY` and every import (`grep -rn FREE_WITHDRAWALS` returns nothing). The withdraw-state "Nth withdrawal today" function returns null when `freePerDay` is 0 (already); delete it if nothing else calls it.
- [ ] **Step 4: Run** `pnpm --filter @tipme/web test && pnpm --filter @tipme/web typecheck && pnpm build`, expect PASS. Visual baselines that change (Pro, Terms) are taken from CI's Linux artifacts, not locally.
- [ ] **Step 5: Commit** `feat(copy): withdrawals cost ₦50; fees include processing`. The PR body shows Pro and Terms (phone + desktop) on `pr-assets`.

### Task 3: `checkoutMethodsFor` in the domain

**Files:**

- Create: `packages/domain/src/checkout-methods.ts` (export from `packages/domain/src/index.ts`)
- Test: `packages/domain/test/checkout-methods.test.mjs`

**Interfaces:**

- Produces:

  ```ts
  export type CheckoutMethod = 'card' | 'bank_transfer';
  export interface CardCost {
    rateBps: bigint;
    fixedMinor: bigint;
    marginMinor: bigint;
  }
  export const DEFAULT_CARD_COST: CardCost; // { rateBps: 200n, fixedMinor: 4500n, marginMinor: 1500n }
  /** Bank transfer always; card too when share × 10000 ≥ amount × rateBps + (fixed + margin) × 10000 and share > 0. Order: bank_transfer first. */
  export function checkoutMethodsFor(input: {
    amountMinor: bigint;
    tipmeShareMinor: bigint;
    card: CardCost;
  }): CheckoutMethod[];
  /** For staff screens: the smallest tip at which a plan rate offers card, ceil((fixed + margin) × 10000 / (rateBps − card.rateBps)); null when rateBps ≤ card.rateBps. */
  export function cardFromMinor(rateBps: bigint, card: CardCost): bigint | null;
  ```

- [ ] **Step 1: Write the failing tests** (exact values from the spec, all with `DEFAULT_CARD_COST`):
  - Free 5%, ₦2,000: `checkoutMethodsFor({ amountMinor: 200000n, tipmeShareMinor: 10000n })` → `['bank_transfer', 'card']` (boundary: equal counts).
  - Pro 3%, ₦5,000: `(500000n, 15000n)` → `['bank_transfer']`.
  - Pro 3%, ₦6,000: `(600000n, 18000n)` → `['bank_transfer', 'card']` (boundary).
  - Pro 3%, ₦5,999: `(599900n, 17997n)` → `['bank_transfer']`.
  - Pro 3%, ₦10,000: `(1000000n, 30000n)` → both.
  - Fee-free, ₦100,000: `(10000000n, 0n)` → `['bank_transfer']` (Review Focus 2).
  - `cardFromMinor(300n)` → `600000n`; `cardFromMinor(500n)` → `200000n`; `cardFromMinor(200n)` → `null`; `cardFromMinor(150n)` → `null`.
- [ ] **Step 2: Run, expect FAIL** (module missing): `pnpm --filter @tipme/domain build; node --test packages/domain/test/checkout-methods.test.mjs`
- [ ] **Step 3: Implement** with bigint arithmetic only (no floats).
- [ ] **Step 4: Run, expect PASS**, plus `pnpm --filter @tipme/domain test`.
- [ ] **Step 5: Commit** `feat(domain): payment options by amount`.

### Task 4: `paymentMethods` on the payment port and the Bachs request

**Files:**

- Modify: `packages/payments/src/provider.ts` (`initializePayment` ~182, `initializeCollectCheckout` ~221)
- Modify: `packages/payments/src/bachs/provider.ts` (`ownCheckout` ~601-630, `initializePayment` ~759-813, `initializeCollectCheckout` ~900)
- Modify: `packages/payments/src/mock/mock-provider.ts` (accept and ignore the field)
- Test: `packages/payments/test/bachs.test.mjs`, `packages/payments/test/bachs-collect.test.mjs`, `packages/payments/test/bachs-platform-checkout.test.mjs`

**Interfaces:**

- Consumes: none from the domain (payments keeps its own union so the package boundary of ADR-0004 doesn't change): `export type CheckoutMethod = 'card' | 'bank_transfer'` in `provider.ts`, identical strings to Task 3.
- Produces: optional `paymentMethods?: readonly CheckoutMethod[]` on `initializePayment` and `initializeCollectCheckout`. Omitted → both methods (today's request, byte for byte). Bachs maps `card` → `NGN_CARD`, `bank_transfer` → `NGN_BANK_TRANSFER`, in the order given. An empty list or an unknown value → `BachsRequestNotSentError` (nothing sent).

- [ ] **Step 1: Write the failing tests:**
  - `checkout sends only bank transfer when asked`: `initializePayment({ …, paymentMethods: ['bank_transfer'] })` → request body `payment_method_types` deep-equals `['NGN_BANK_TRANSFER']`.
  - `checkout without paymentMethods sends both, as before`: the existing assertion at `bachs.test.mjs:97` stays and passes.
  - `collect checkout passes the methods through`: `initializeCollectCheckout({ …, paymentMethods: ['bank_transfer'] })` → `['NGN_BANK_TRANSFER']`.
  - `Pro checkout always sends both`: `initializePlatformCheckout` body has `['NGN_CARD', 'NGN_BANK_TRANSFER']`.
  - `an empty method list never reaches Bachs`: `paymentMethods: []` → rejects with `BachsRequestNotSentError`; fake fetch not called.
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @tipme/payments build && node --test packages/payments/test/bachs.test.mjs packages/payments/test/bachs-collect.test.mjs packages/payments/test/bachs-platform-checkout.test.mjs`
- [ ] **Step 3: Implement.** `ownCheckout` takes `paymentMethods?` and maps it; Pro passes nothing.
- [ ] **Step 4: Run, expect PASS**, plus `pnpm --filter @tipme/payments test`.
- [ ] **Step 5: Commit** `feat(payments): choose checkout payment methods`.

### Task 5: Card cost setting and its ops screen

The owner asked for an ops screen (26 Nov 2026) instead of env settings. Same pattern as plan fees: an append-only history table, a serious action, `fees.manage`, a lone admin may change it, owners alerted.

**Files:**

- Create: migration `packages/database/drizzle/<next free number>_card_cost_settings.sql` (the next number when the task starts; the fee waivers build may take 0129 first), table `cardCostSettings` in `packages/database/src/schema.ts`
- Create: `packages/database/src/operations/card-cost-settings.ts`
- Modify: the serious-action registry (where `plan_fees.change` is registered) for `card_costs.change`; owner alert as `plan_fees.change` does
- Create: `apps/api/src/ops/card-costs.controller.ts` (`GET`/`POST /v1/ops/card-costs`), contracts in `packages/contracts/src/card-costs.ts`
- Modify: `apps/web/src/app/ops/plan-fees/page.tsx` (a "Card costs" section under the plan rates), `docs/runbooks/settings-and-switches.md`
- Test: `packages/database/test/integration/card-cost-settings.test.mjs`, the API controller test beside the plan fees one, a web unit test for the section

**Interfaces:**

- Consumes: Task 3 `CardCost`, `DEFAULT_CARD_COST`, `cardFromMinor`.
- Produces:

  ```ts
  // table card_cost_settings: id uuid, rate_bps int (0–10000), fixed_minor bigint (≥ 0), margin_minor bigint (≥ 0),
  // effective_from timestamptz, set_by, approved_by, reason text, created_at. Append-only.
  export async function cardCostAt(db: Database, at: Date): Promise<CardCost>; // latest row with effective_from ≤ at; none → DEFAULT_CARD_COST; a database error throws
  export async function setCardCosts(
    tx: Tx,
    input: {
      cost: CardCost;
      actorId: string;
      approvedBy: string | null;
      reason: string;
      now: Date;
    },
  ): Promise<void>;
  export function cardCostHistory(
    db: Database,
    limit: number,
  ): Promise<CardCostRow[]>;
  ```

  Contract: `opsCardCostsChangeSchema` = reason + `rateBps` int 0–10000, `fixedMinor` and `marginMinor` integer strings ≥ 0 (naira entered on screen, sent in kobo).

- [ ] **Step 1: Write the failing tests:**
  - `cardCostAt` with no rows → `{ rateBps: 200n, fixedMinor: 4500n, marginMinor: 1500n }`.
  - after a change effective at T: `cardCostAt(T − 1 ms)` → the old values, `cardCostAt(T)` → the new ones (Review Focus 3 relies on this).
  - `card_costs.change` by a lone admin applies at once, writes an audit row and alerts owners; with a second staff member it waits for approval, as `plan_fees.change`.
  - API: `GET /v1/ops/card-costs` needs `fees.manage` (403 without); `POST` with `rateBps: 10001` → 400; a valid change returns the new values and the history.
  - Screen: shows "Card fee 2% + ₦45, margin ₦15" and, under it, "Card is offered on Free tips from ₦2,000 and Pro tips from ₦6,000" (from the plan rates in force and `cardFromMinor`); saving asks for a reason.
- [ ] **Step 2: Run, expect FAIL:** `pnpm build && node --test --test-concurrency=1 packages/database/test/integration/card-cost-settings.test.mjs` and the API/web tests.
- [ ] **Step 3: Implement** following `plan-fee-rates.ts` and `plan-fees.controller.ts` (`@FreshCode()` on the POST, `@RateLimit('ops_read')` / `('ops_request')`).
- [ ] **Step 4: Run, expect PASS**, plus `pnpm --filter @tipme/api test` and `pnpm --filter @tipme/web test`.
- [ ] **Step 5: Commit** `feat(ops): card cost setting`. Screenshots of the section (phone + desktop) on `pr-assets`.

### Task 6: API chooses the methods from the quote

**Files:**

- Modify: `apps/api/src/checkout/checkout.service.ts` (~288-322 Bachs, ~413-432 pretend)
- Test: `apps/api/test/checkout-collect.test.mjs` and a new `apps/api/test/checkout-methods.test.mjs` using the same fake-provider pattern

**Interfaces:**

- Consumes: Task 3 `checkoutMethodsFor`; Task 4 `paymentMethods`; Task 5 `cardCostAt`.
- Card costs are read **as they were when the quote was made** (`cardCostAt(db, quote.createdAt)`), so a retried start always sends the same list, and a change applies to tips quoted after it.

- [ ] **Step 1: Write the failing tests:**
  - `a Pro tip of ₦5,000 starts a checkout with bank transfer only`: the fake Bachs records `paymentMethods` `['bank_transfer']`; ₦10,000 records both.
  - `a You collect tip uses the same rule`: collect start, Pro ₦5,000 → `['bank_transfer']`.
  - `the methods follow the quoted share, not today's rate` (Review Focus 1): quote a Pro ₦10,000 tip at 3%, then change the Pro rate to 2% before starting → both methods.
  - `a fee-free tip offers bank transfer only` (Review Focus 2): page with a fee-free credit, ₦50,000 → `['bank_transfer']`.
  - `a retried start sends the same list` (Review Focus 3): start once, change the card margin to ₦500 in ops, start the same attempt again → both calls carry the same `paymentMethods` and idempotency key.
  - `a card cost change applies to tips quoted after it`: margin ₦500, then quote Pro ₦10,000 → `['bank_transfer']`.
  - The share passed is `quote.platformFeeMinor + quote.providerFeeMinor` and the amount `quote.payerTotalMinor`, as today's `tipmeShareMinor`.
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @tipme/api build && node --test apps/api/test/checkout-methods.test.mjs apps/api/test/checkout-collect.test.mjs`
- [ ] **Step 3: Implement.** Compute `paymentMethods` once per start and pass it to the direct and the collect call; the pretend path passes it too (the mock ignores it). A database error reading the card costs fails the start as other database errors do today (no silent default).
- [ ] **Step 4: Run, expect PASS**, plus `pnpm --filter @tipme/api test`.
- [ ] **Step 5: Commit** `feat(checkout): offer card only when TipMe's share covers it`.

### Task 7: 2% floor for staff-set rates

**Files:**

- Modify: `packages/domain/src/fees.ts:79` and `packages/contracts/src/plan-fees.ts:11` (`PLAN_FEE_MIN_BPS` 150 → 200)
- Modify: `packages/contracts/src/ops.ts:884` (`opsPageFeeSchema.feeBps`: `null`, `0`, or 200–10000)
- Modify: `apps/web/src/app/ops/plan-fees/*` and `apps/web/src/components/ops/page-pricing.tsx` (the card line and the below-floor flag)
- Test: `packages/contracts/test/*plan-fees*` / ops schema test (find with `grep -rln opsPageFeeSchema packages/contracts/test`), `packages/database/test/integration/plan-fee-setting.test.mjs`, web unit test for the two screens

**Interfaces:**

- Consumes: Task 3 `cardFromMinor`; Task 5 `cardCostAt(db, now)` (screens use the card costs in force).

- [ ] **Step 1: Write the failing tests:**
  - plan rate 199 bps refused (400 / schema error); 200 accepted.
  - page rate: `null` ok, `0` ok, `1` refused, `199` refused, `200` ok.
  - plan fees screen at 300 bps shows "Card is offered on tips from ₦6,000."; at 200 bps "Card is not offered at this rate."
  - a stored plan rate of 150 bps (seeded directly) shows "Below the 2% floor" and still saves only values ≥ 200.
  - page pricing with a stored 100 bps page rate shows the same flag.
- [ ] **Step 2: Run, expect FAIL:** `pnpm build && node --test --test-concurrency=1 packages/database/test/integration/plan-fee-setting.test.mjs && pnpm --filter @tipme/contracts test && pnpm --filter @tipme/web test`
- [ ] **Step 3: Implement.** No migration; database checks unchanged.
- [ ] **Step 4: Run, expect PASS.** Check staging/prod have no rates below 200: give the owner `SELECT … FROM plan_fee_rates WHERE free_bps < 200 OR pro_bps < 200` and `SELECT count(*) FROM profiles WHERE custom_fee_bps BETWEEN 1 AND 199` (column name from `schema.ts:732`) to run; result goes in the PR.
- [ ] **Step 5: Commit** `feat(ops): 2% floor for staff-set rates`. Screenshots of both screens (phone + desktop) on `pr-assets`.

### Task 8: Release checks (controller, with the owner)

Not code. Before the release PR:

- [ ] Whole `pnpm test:integration` and `pnpm test` green; staging deploy and `release/staging-full` green.
- [ ] Sandbox, owner-approved, with a throwaway script (never committed): a transfer-only checkout on a **connected account** (`X-Account-Id`, a person's page) shows bank transfer only, and a transfer-only checkout paid with the partner's sandbox transfer flow completes and confirms on staging. Evidence in the PR.
- [ ] The fee notice (redrafted #287 copy: lower tip fees, withdrawals now ₦50 each) is approved by the owner and sent before the production release; Terms change ships in the same release.
- [ ] Production env: no new values needed. The card costs start at the defaults until staff change them in ops; the migration runs with the deploy.
