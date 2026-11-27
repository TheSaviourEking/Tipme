# Fee Waivers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Sequencing:** execution starts only **after per-provider balances merges** (`docs/superpowers/plans/2026-11-23-per-provider-balances.md`, branch `feat/per-provider-balances`). This plan is written against the code shape that plan leaves: `feePayerFor` decided once per request on the largest part, `personsWithdrawalsToday` counting requests (its P7), `payouts.withdrawal_group_id` / `group_part` (its migrations 0127, 0128). Rebase on `dev` after it merges and re-read its Task 5–6 code before Task 5 here.

**Goal:** Staff decide, without a code change, when TipMe pays the tip fee or the withdrawal fee, for a whole kind of account (individuals, businesses, Giving) or one account, with an optional end date.

**Architecture:** One append-only rule table, `fee_waivers`, read by the tip quote (`createQuote`) and the withdrawal fee decision (`feePayerFor`). A pure resolver in `@tipme/domain` picks the rule: an account rule over a kind rule over today's default. A waived tip is priced with `priceTip({ feeFree: true })` and records the rule on `tip_quotes.fee_waiver_id`; a waived withdrawal is `fee_payer = 'tipme'` with `payouts.fee_waiver_id`. Setting a rule is the serious action `fee_waiver.set`. The rule replaces the `business_payout_fee_absorbed` switch through a SQL carry-over in the migration. A worker job sends notices and the low-balance pause alert. Staff see a "Who pays the fees" grid, a Waivers list and per-account controls; recipients see ₦0 fees and "Free" withdrawals.

**Tech Stack:** TypeScript strict, NestJS (API), BullMQ worker, Drizzle/Postgres (drizzle-kit migrations), Zod contracts, Next.js App Router (web), `node --test`, Playwright. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-fee-waivers-design.md` (owner-approved, PR #333; its "(design call)" items are approved). §n means a section of the spec.

---

## What the code does today (origin/dev `60837170`, plus per-provider balances once merged)

- **Pricing:** `packages/domain/src/fees.ts`. `priceTip(tipMinor, policy, { feeFree?, minTipMinor?, shareBps? })` returns `FeeBreakdown`; `feeFree` gives platform 0, provider 0, net = tip. `FEE_FREE_VERSION_SUFFIX = '-fee-free'`. `planShareBps(plan, customBps, rates)` caps a custom rate at the plan rate.
- **Quote:** `packages/database/src/operations/quotes.ts` `quote()` reads the profile, `planFeeRatesInForce`, prices, then in one transaction locks `fee_free_credits`, counts `openFeeFreeQuotes` (quotes with `waived_platform_fee_minor > 0`) and, when a credit is free, re-prices `feeFree` with `waived = platform + provider` and version `${base}-fee-free`. It inserts `tip_quotes`. `createQuote` input has `youCollectOn` and, when on, `provider`/`environment`. Its only caller is `apps/api/src/checkout/checkout.service.ts:154`.
- **Credit use:** `packages/database/src/operations/provider-events.ts:366-377` decrements `fee_free_credits` when the paid quote has `waivedPlatformFeeMinor > 0`.
- **Rewards:** `moments.ts` `rewardStats` sums `q.waived_platform_fee_minor` into `lifetimeRewardCostMinor` (the cash-bonus cap). `typicalFee` already excludes waived quotes. `ops-metrics.ts:59-70` sums `waived_platform_fee_minor` into the weekly `waived_this/last`.
- **Withdrawal fee:** `payouts.ts` `feePayerFor(db, owner, route, providerName, feeMinor, now): 'user' | 'tipme'`: a person is free while `personsWithdrawalsToday(...).free < FREE_WITHDRAWALS_PER_DAY`; a business is `tipme` when `readFeatureSwitch(db, 'business_payout_fee_absorbed')`, else an unused top-up (`freeFeeCredit`), else `user`. Both `quoteFor` and `requestFor` call it.
- **Plan fees:** `plan-fee-rates.ts` (append-only `plan_fee_rates`, `PLAN_FEES_CHANGE_ACTION`, `requirePlanFeeConfirm`, `percentOf`), migration `0118_plan_fee_rates.sql` (append-only and no-truncate triggers, seed row and audit row), re-seeded on test reset in `packages/database/src/test-support.ts:220-240`. Serious action `planFeesChange` in `serious-actions-registered.ts:634-672` (`acting`, `current` pin, `describe`, `act`). Catalogue in `packages/contracts/src/ops-catalogue.ts` (`SERIOUS_ACTIONS`, `SERIOUS_ACTION_WORDS`, `SERIOUS_ACTION_PERMISSIONS`). `PLAN_FEES_CONFIRM_REQUIRED` in `packages/contracts/src/errors.ts:112`.
- **Ops:** `apps/api/src/ops/plan-fees.controller.ts` (`GET/POST v1/ops/plan-fees`, `fees.manage`, `@FreshCode()`, `pendingOr`, `SERIOUS_SERVICES`; `read()` returns `business.payoutFeeAbsorbed` from the switch). `apps/web/src/app/ops/plan-fees/page.tsx:240-256` shows that switch. Per-page pricing is `apps/api/src/ops/pages.controller.ts` (`:profileId/fee`, `:profileId/fee-free`) and `apps/web/src/components/ops/page-pricing.tsx` (`PagePricing`, rendered on `/ops/pages`). Business ops page: `apps/web/src/app/ops/businesses/[businessId]/page.tsx`, API `apps/api/src/ops/businesses.controller.ts`.
- **Switch:** `packages/contracts/src/switches.ts` (`FEATURE_SWITCHES`, `FEATURE_SWITCH_CATALOGUE.business_payout_fee_absorbed`). `feature-switches.ts` `readAll` and the ops list ignore stored keys that `isFeatureSwitch` rejects, so a retired key's row is harmless.
- **Reserve readings:** both read TipMe's own platform balance at the partner (`GET /v1/balances` as the platform), the balance a direct tip's processing is charged to when it carries no platform fee (ADR-0004).
  - `payment_reserve_readings` (`payments.reserve` job, `checkReserve` in `payment-reserve.ts`) holds `provider` = adapter name, the NGN `available_minor`, `threshold_minor` and `low` (null = unknown), every 15 min. It is the raw balance, and its one level is the alert threshold.
  - `collect_reserve_readings` (`checkCollectReserve` in `collect-reserve.ts`) holds `own_minor` = available − what TipMe holds for You collect recipients, and `level` in `ok|warning|critical|breach` against the You collect levels (both 0 while You collect isn't in use).
  - Both are written for the configured Bachs adapter only. No readings exist on a mock copy.
- **Recipient UI:** `apps/web/src/lib/fee-line.ts` already labels a 0/0 tip "TipMe fee (waived)". The withdraw screen shows "Free" when `feePaidBy === 'tipme'` (`withdraw-view.tsx:725`). The business money section (`business/sections/money.tsx:300-314`) says "No transfer fee comes off it".
- **Notices:** in-app `notifications` (kind check in `schema.ts:879-883`), staff `issues` (`ISSUE_KINDS` in `packages/contracts/src/ops.ts`, `openIssue` with a forever-unique `dedupe_key`, `markResolved` with `resolvedBy: 'system'`), webhook alerts via `webhookAlert` (`apps/worker/src/handlers/payment-reserve.ts`).

## Rulings on spec gaps (made by this plan)

- **W1. Accounts.** `fee_waivers` has `profile_id` and `business_id` (FKs, nullable) rather than one untyped `account` column. `giving` rules are kind-scope only until Giving has an organisation table; an account-scope Giving rule is refused `INVALID_INPUT`. The Giving row shows "not live" (§8).
- **W2. Which row is in force for a key.** A key is (scope, kind, account, fee). Its current row is the one with the greatest `starts_at <= now` (ties: latest `created_at`). If that row has ended (`ends_at <= now`), the key has no rule: an older row is never revived. Upcoming rows (`starts_at > now`) are listed but not applied.
- **W3. Never retroactive.** At act time (approval or lone-admin), `starts_at = max(requested start ?? now, now)`. A waiver approved after its requested start begins at approval.
- **W4. Bounds.** `ends_at > starts_at`, and both `starts_at` and `ends_at` are at most 24 calendar months after act time (UTC month arithmetic). The ops UI picks an end **date**. It is sent as the start of the next Lagos day (`until 31 Jan` ends at 1 Feb 00:00 WAT). The API takes an ISO instant.
- **W5. Allowed shapes.** `payer = 'inherit'` only with account scope. `fee = 'tip'` is refused for `kind = 'business'` (businesses have no tip fee, §2). A business staff member's tips are on their own page, so `individual` rules apply to them.
- **W6. The low-balance pause.** Both readings measure the same partner balance that waived processing is charged to (ADR-0004), so either one pauses. Tip waivers are paused while, for the **active** adapter (`PAYMENT_PROVIDER`) in NGN:
  - the latest `payment_reserve_readings` row has `low = true`. This is the direct-mode signal: the raw platform balance is below its only level, and the partner would fall back to charging the recipient;
  - **or** the latest `collect_reserve_readings` row has `level IN ('critical','breach')`. This is the You collect signal: TipMe's own money above what it holds for recipients is at or below the critical level, so processing would eat held money.
  - Either signal pauses all tip waivers, direct and collect quotes alike, because they share one balance.
  - No reading, or an unknown one (`low IS NULL`, `level IS NULL`), does not pause, so mock copies and tests are never paused.
  - Withdrawal waivers are not paused (they come from the payout reserve top-up, §5).
- **W7. Precedence on a quote.** A tip waiver beats a custom rate and fee-free credits. `waived_platform_fee_minor` = platform + provider fee at the plan or custom rate (the same figure the credit path stores). A waived quote neither reserves nor uses a credit: `openFeeFreeQuotes` and the credit decrement both require `fee_waiver_id IS NULL`. Version: `${base}-waived-${ruleId}`.
- **W8. Withdrawal cost.** A new column, `payouts.waived_fee_minor` (default 0), is set only on the part that would have carried the fee, and only when the default rule would have charged the account. Under per-provider's rule (P8), that's the largest part. "Cash paid" counts it on PAID rows. `fee_waiver_id` is still stored on every part (§7a). A person's first two withdrawals of the day, which are free anyway, cost the waiver nothing.
- **W9. Withdrawal quotes aren't binding.** As today, the request decides the fee under the owner lock. If a waiver ends between the screen's quote and the request, the normal rule applies. Tip quotes keep their terms (§4).
- **W10. Pin.** `fee_waiver.set` pins the latest row of its key, upcoming included (`current` = that row's id or null), so any change to the key makes a waiting request stale. `act` takes `pg_advisory_xact_lock(hashtext('fee_waiver:' || key))`.
- **W11. Cost estimate for the confirm step.** It applies to a kind-scope rule with `payer = 'tipme'`, which needs `confirmCost: true` (else `FEE_WAIVER_CONFIRM_REQUIRED`). The estimate is the last 30 days' actuals for that kind: the tip fee is Σ(platform + provider fee) of SUCCEEDED tips, and the withdrawal fee is Σ `user_fee_minor` of non-FAILED payouts. A tip or withdrawal TipMe already covered counts what it would have charged instead (`waived_platform_fee_minor` on the quote, ruling R23; `waived_fee_minor` on the payout), so renewing a waiver doesn't read as free. Giving is 0. `describe` shows it, so the approver confirms it.
- **W12. Cost periods.** The grid and the per-account view show this Lagos calendar month. The Waivers list shows each rule's total since its start. Tips are counted by `completed_at` (SUCCEEDED). Payouts are counted by `paid_at` (PAID).
- **W13. Notices.**
  - Account notices are in-app `notifications` of new kinds `fee_waiver_started` and `fee_waiver_ended`. A business's go to its owners (`businessManagerUsers(..., { owners: true })`). There is no new email.
  - The worker job writes them within 15 minutes. The new table `fee_waiver_notices (rule_id, kind)` (unique) makes each one once.
  - "Ended" means a `tipme` account rule that was noticed as started and is no longer the in-force row of its key (it ended, or was replaced).
  - _Final fix wave (owner 27 Nov, R20 reversed; ruling R22):_ an ended notice is sent only when TipMe no longer pays that fee for the account, and is held (not claimed) until then. A kind-wide `tipme` rule that is over and not renewed tells each account that used it (a SUCCEEDED tip or a non-FAILED payout with its `fee_waiver_id`) and now follows the kind-wide rule, recorded per account in `fee_waiver_account_notices`; `fee_waiver_notices (rule_id, 'ended')` on the kind rule marks it done. One notice per account and fee under an advisory lock, whichever rules end. The notice names the fee. A tip waiver's started notice waits out a pause.
  - The staff "day before" notice is an issue `fee_waiver_ending` (dedupe `fee_waiver_ending.<ruleId>`) once `ends_at - now <= 24 h`.
- **W14. Pause alert.** The issue `fee_waivers_paused` is opened while paused **and** some tip rule with `payer = 'tipme'` is in force. Its dedupe key is `fee_waivers_paused.<spellStartReadingId>`: the earliest low (payments) or critical/breach (collect) reading after the last moment neither signal was set. It posts one `webhookAlert` only when `openIssue` returns `opened: true`. It auto-resolves (`markResolved`, `resolvedBy: 'system'`) once neither signal is set.
- **W15. Switch retirement.**
  - `business_payout_fee_absorbed` leaves `FEATURE_SWITCHES` and its catalogue. Its stored row stays and is ignored.
  - The migration writes one kind rule (`business`, `withdrawal`), with `payer = 'tipme'` if the stored row is enabled and `'account'` otherwise (including when no row exists), reason `Carried over from the switch`, `set_by` NULL, plus a system audit row, as 0118 did.
  - The test reset re-seeds the same row with a fixed id and payer `account`.
- **W16. Append-only.** `fee_waivers` gets the same update/delete and truncate triggers as `plan_fee_rates`, and the test reset handles it as it handles `plan_fee_rates`. E2E simulates "after the end date" by **inserting** a later, already-ended row for the same key (W2). It never updates.
- **W17. What recipients read.** `DashboardSummary.tipFeeWaiver: { endsAt: string | null } | null` is set only while a tip rule with payer `tipme` is in force for the profile **and** waivers aren't paused. `MyTipDetail.feeCoveredByTipMe: boolean` comes from the tip's own quote, and its copy is past tense: "TipMe covered the fee on this tip."

## Global Constraints

Every task includes these.

- **TDD.** Write the failing test, watch it fail, implement, then watch it pass. Financial code needs idempotency and concurrency tests (AGENTS.md).
- **No real provider in tests.** Database tests use plain objects and seeded rows. HTTP integration and e2e tests use `mock`. Nothing calls `api.bachs.io` or `sandbox-api.bachs.io`.
- **No regulatory approval implied.** D-04, D-06 and D-07 stay open. Never edit `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md` or `docs/design/redesign/README.md`.
- **Users never see provider names.** Recipient copy says "TipMe" and "Free", never the partner's name. Staff screens may name providers.
- **Money.** Use integer minor units (`bigint`), NGN. Supporters always pay exactly the tip. Quotes already shown keep their terms. Nothing reprices a stored quote, tip, payout or ledger row. The ledger posting builders are unchanged.
- **BullMQ retention** for any new job: `removeOnComplete: true`, `removeOnFail: { age: 7 * 24 * 3600 }` (`SCHEDULED_RUN_RETENTION` in `apps/worker/src/ensure-schedule.ts`).
- **E2E** runs in lanes 3–8 only (`E2E_LANE=3`…`8`). New or changed specs pass `--repeat-each=5 --retries=0 --workers=2`. Any test that routes `**/v1/me/**` answers `/v1/me/events` with 204. E2E uses **account-scope** rules only: a kind-wide rule would change every parallel test's fees.
- **Screenshots.** Every PR with visible UI shows phone (390) and desktop (1440) screenshots of test data, on the `pr-assets` branch under `pr-<number>/`.
- **Migrations** go through `pnpm --filter @tipme/database generate` only. Hand-written SQL (triggers, the switch→rule carry-over) is appended to the generated file, as `0118_plan_fee_rates.sql` did. Number them after the latest on `dev` at merge time (expected 0129+). No backfills or scripts against staging or production. The carry-over is a deterministic SQL statement inside the migration.
- **API changes** regenerate OpenAPI (`pnpm --filter @tipme/api build && pnpm api:openapi`) and docs (`pnpm docs:generate`). Their `--check` must pass.
- **Copy** lives in `packages/contracts/src/copy.ts`, in its tone.
- **Process.** Each task is one PR into `dev`, in task order. Never `--no-verify`. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Commands used by every task

| What                 | Command                                                                                                                                                                                             | Passing output |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Domain tests         | `pnpm --filter @tipme/domain build && pnpm --filter @tipme/domain test`                                                                                                                             | `# fail 0`     |
| Contracts tests      | `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`                                                                                                                       | `# fail 0`     |
| API unit tests       | `pnpm --filter @tipme/api build && pnpm --filter @tipme/api test`                                                                                                                                   | `# fail 0`     |
| Worker tests         | `pnpm --filter @tipme/worker build && pnpm --filter @tipme/worker test`                                                                                                                             | `# fail 0`     |
| Web unit tests       | `pnpm --filter @tipme/web test`                                                                                                                                                                     | `# fail 0`     |
| One integration file | `pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test <file>` (local Postgres and Redis)                                                     | `# fail 0`     |
| Migration check      | `pnpm --filter @tipme/database generate` after your migration                                                                                                                                       | no new file    |
| E2E (one spec)       | `E2E_LANE=6 TURBO_FORCE=true node scripts/build-e2e.mjs && E2E_LANE=6 node scripts/prepare-e2e-database.mjs && E2E_LANE=6 pnpm exec playwright test <spec> --repeat-each=5 --retries=0 --workers=2` | 0 failed       |
| Whole gate           | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`                                                                                                                                     | exit 0         |

## Review Focus

These are the inputs the spec implies but its test list doesn't name, most likely to hurt first. Each has its pinning test in the owning task.

1. **Staff "end on a date" a waiver that had no end, then the date passes.** Expected: the account (or kind) returns to the normal rules. It never falls back to the older open-ended row. _Test:_ `a newer row that has ended leaves the key with no rule, never the older one` (Task 1 unit, Task 2 database).
2. **A waiver approved hours after the start time it asked for.** Expected: it starts at approval. Tips paid in between keep their normal fees, and nothing is waived retroactively. _Test:_ `a waiver approved after its requested start begins at approval` (Task 3).
3. **A person's first, already-free withdrawal under a waiver.** Expected: `fee_payer = 'tipme'` and `fee_waiver_id` set, with `waived_fee_minor = 0`, so the cost isn't inflated. The third withdrawal of the day records the fee. _Test:_ `a waived withdrawal that would have been free anyway costs the waiver nothing` (Task 5).
4. **TipMe's balance goes critical while a waived quote is open.** Expected: that quote is paid as shown (₦0 fee) and the real processing is booked to `provider_fee_expense`. New quotes are priced normally, and the recipient's dashboard line disappears. _Test:_ `a waived quote stays waived through payment after the pause starts` (Task 4) and `the dashboard line hides while waivers are paused` (Task 10).
5. **Staff pick "until 31 Jan" late on 31 Jan, Lagos time.** Expected: the waiver runs to the end of 31 Jan in Lagos, never ending at UTC midnight an hour early, and "until 31 Jan" shows the same date back. _Test:_ `an end date is sent as the start of the next Lagos day and shown as the date picked` (Task 9).

---

### Task 1: Rule resolution and bounds (domain)

**Files:**

- Create: `packages/domain/src/fee-waivers.ts`
- Modify: `packages/domain/src/index.ts` (export it), `packages/domain/src/fees.ts` (add `FEE_WAIVED_VERSION_INFIX`)
- Test: `packages/domain/test/fee-waivers.test.mjs`

**Interfaces:**

- Produces:
  - `FEE_WAIVER_KINDS = ['individual','business','giving'] as const`, `FEE_WAIVER_FEES = ['tip','withdrawal'] as const`, `FEE_WAIVER_PAYERS = ['tipme','account','inherit'] as const`, and their types `FeeWaiverKind`, `FeeWaiverFee`, `FeeWaiverPayer`.
  - `interface FeeWaiverRule { id: string; scope: 'kind' | 'account'; kind: FeeWaiverKind; accountId: string | null; fee: FeeWaiverFee; payer: FeeWaiverPayer; startsAt: Date; endsAt: Date | null; createdAt: Date }`
  - `currentRuleOfKey(rows: readonly FeeWaiverRule[], now: Date): FeeWaiverRule | null` takes rows of one key and applies W2.
  - `resolveFeeWaiver(input: { accountRows: readonly FeeWaiverRule[]; kindRows: readonly FeeWaiverRule[]; now: Date }): { payer: 'tipme' | 'default'; ruleId: string | null; endsAt: Date | null }` applies §4. An account rule other than `inherit` wins: `tipme` gives `tipme`, and `account` gives `default` with `ruleId: null`. Otherwise the kind rule applies (`tipme` → `tipme`, `account` → `default`). Otherwise the result is `default`.
  - `feeWaiverShapeProblem(r: { scope; kind; fee; payer; hasAccount: boolean }): string | null` applies W1 and W5. It also requires an account exactly when `scope = 'account'`.
  - `feeWaiverWindow(input: { requestedStart: Date | null; endsAt: Date | null; now: Date }): { startsAt: Date; endsAt: Date | null } | 'endsAt' | 'startsAt'` applies W3 and W4. `FEE_WAIVER_MAX_AHEAD_MONTHS = 24`.
  - `FEE_WAIVED_VERSION_INFIX = '-waived-'` and `waivedFeeVersion(base: string, ruleId: string): string`.

- [ ] **Step 1: Write the failing tests:**
  - `an account rule beats a kind rule`;
  - `payer account on the account opts it out of a kind-wide waiver` → `{ payer: 'default', ruleId: null }`;
  - `inherit follows the kind rule`;
  - `starts_at equal to now is in force; ends_at equal to now is not`;
  - `an upcoming row does not replace the current one until it starts`;
  - `a newer row that has ended leaves the key with no rule, never the older one` (Review Focus 1);
  - `same starts_at: the later created_at wins`;
  - shape: `inherit on a kind rule`, `tip for business`, `giving account scope` and `account scope without an account` are each refused;
  - window: `a start in the past becomes now` (W3); `an end at or before the start is refused`; `an end 24 months ahead is allowed, a millisecond more is refused`.
- [ ] **Step 2: Run** the domain tests. Expected: FAIL, `resolveFeeWaiver is not a function`.
- [ ] **Step 3: Implement** the module. It has no I/O.
- [ ] **Step 4: Run** the domain tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(domain): resolve who pays a fee from waiver rules`.

---

### Task 2: The rule table, the switch carry-over, and reading rules

**Files:**

- Modify: `packages/database/src/schema.ts`:
  - `feeWaivers` (below `planFeeRates`);
  - `feeWaiverNotices`;
  - `tipQuotes.feeWaiverId`;
  - `payouts.feeWaiverId` and `payouts.waivedFeeMinor`;
  - the `notifications_kind` check gains `fee_waiver_started` and `fee_waiver_ended`.
- Create: the generated migration (`00NN_fee_waivers.sql`, after the latest at merge time), with the triggers and the carry-over appended.
- Create: `packages/database/src/operations/fee-waivers.ts`. Modify `packages/database/src/index.ts`, `packages/database/src/test-support.ts` (re-seed the carried-over row as W15 says).
- Test: new `packages/database/test/integration/fee-waivers.test.mjs`

**Interfaces:**

- Consumes: `currentRuleOfKey`, `resolveFeeWaiver`, the types (Task 1).
- Produces:
  - Table `fee_waivers`:
    - columns: `id uuid pk`, `scope text`, `kind text`, `profile_id uuid → profiles`, `business_id uuid → businesses`, `fee text`, `payer text`, `starts_at timestamptz not null`, `ends_at timestamptz null`, `reason text not null`, `set_by uuid → users`, `approved_by uuid → users`, `created_at`.
    - checks: the enum values; `scope='kind'` ⇔ both ids NULL; `scope='account'` ⇔ exactly the id matching `kind` (profile for individual, business for business); `payer <> 'inherit' OR scope = 'account'`; `NOT (kind='business' AND fee='tip')`; `ends_at IS NULL OR ends_at > starts_at`; `char_length(reason) > 0`.
    - indexes: `fee_waivers_kind_key (kind, fee, starts_at DESC) WHERE scope='kind'`, `fee_waivers_profile_key (profile_id, fee, starts_at DESC) WHERE profile_id IS NOT NULL`, `fee_waivers_business_key (business_id, fee, starts_at DESC) WHERE business_id IS NOT NULL`.
    - triggers: append-only and no-truncate, copied from 0118.
  - Table `fee_waiver_notices`: `rule_id uuid → fee_waivers`, `kind text` in `('started','ended','ending_soon')`, `created_at`, with primary key `(rule_id, kind)`.
  - `tip_quotes.fee_waiver_id uuid → fee_waivers` (nullable). `payouts.fee_waiver_id uuid → fee_waivers` (nullable), and `payouts.waived_fee_minor bigint not null default 0` with a check `>= 0 AND (waived_fee_minor = 0 OR fee_waiver_id IS NOT NULL)`.
  - Carry-over (appended SQL, W15): one `INSERT INTO fee_waivers ... SELECT ... CASE WHEN COALESCE((SELECT enabled FROM feature_switches WHERE key = 'business_payout_fee_absorbed'), false) THEN 'tipme' ELSE 'account' END`, then the `audit_events` row (`action 'fee_waiver.set'`, `permission 'fees.manage'`, `staff_user_id NULL`).
  - `type MoneyOwnerRef = { profileId: string } | { businessId: string }` (the same shape as `MoneyOwner` in `payouts.ts`: reuse that type if it is exported).
  - `feeWaiverFor(db: Database | Tx, input: { owner: MoneyOwnerRef; fee: FeeWaiverFee; now: Date }): Promise<{ payer: 'tipme' | 'default'; ruleId: string | null; endsAt: Date | null }>` reads only the rows that can be current for the account key and the kind key (the latest started row per key, plus nothing older), then calls `resolveFeeWaiver`.
  - `feeWaiverRules(db, input: { now: Date; filter?: { kind?: FeeWaiverKind; owner?: MoneyOwnerRef } }): Promise<{ inForce: FeeWaiverRow[]; upcoming: FeeWaiverRow[] }>`, where `FeeWaiverRow` = `FeeWaiverRule` + `reason`, `setBy`, `approvedBy`.
  - `latestRowOfKey(db, key: { scope; kind; owner?: MoneyOwnerRef; fee }): Promise<FeeWaiverRow | null>` gives the newest row by `starts_at`, upcoming included (W10 pin).

- [ ] **Step 1: Write the failing tests** (`fee-waivers.test.mjs`):
  - `a freshly migrated database holds one business withdrawal rule carried over from the switch, payer account` (open the template, as `fee-migrations.test.mjs` does). Then `re-running the carry-over with the switch row on writes payer tipme`: run the migration's split statements on a database whose `feature_switches` row is enabled, and assert the new row's payer and reason `Carried over from the switch`.
  - `the rules table is history: rows cannot be updated or deleted`.
  - `the table refuses inherit on a kind rule, a business tip rule, and an end before the start`.
  - `an account rule beats a kind rule, read from the database`, `payer account opts one account out`.
  - `a newer row that has ended leaves the key with no rule, never the older one` (Review Focus 1, database half).
  - `upcoming rules are listed apart and not applied`.
- [ ] **Step 2: Run** that file. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, generate the migration, append the triggers and the carry-over, and add the reads and the test-reset seed.
- [ ] **Step 4: Run** the migration check, this file, `plan-fee-setting.test.mjs` and `feature-switches.test.mjs`. Expected: no new migration, `# fail 0`.
- [ ] **Step 5: Commit** `feat(fees): fee waiver rules table, carried over from the business fee switch`.

---

### Task 3: Setting a waiver: the serious action `fee_waiver.set`

**Files:**

- Modify: `packages/database/src/operations/fee-waivers.ts` (`setFeeWaiver`, `estimateFeeWaiverMonthlyCost`, `checkedFeeWaiverPayload`), `packages/database/src/operations/serious-actions-registered.ts` (register `feeWaiverSet`)
- Modify: `packages/contracts/src/ops-catalogue.ts` (`'fee_waiver.set'`, words "Set who pays a fee", permission `fees.manage`), `packages/contracts/src/errors.ts` (`FEE_WAIVER_CONFIRM_REQUIRED` beside `PLAN_FEES_CONFIRM_REQUIRED`)
- Test: `packages/database/test/integration/fee-waivers.test.mjs` (extend), `packages/contracts/test/ops-catalogue.test.mjs` (or wherever the catalogue's completeness is tested: `grep -rln SERIOUS_ACTION_WORDS packages/contracts/test`)

**Interfaces:**

- Consumes: `feeWaiverShapeProblem`, `feeWaiverWindow` (Task 1), `latestRowOfKey` (Task 2), `withAuditChange` and `recordAudit`.
- Produces:
  - The payload: `type FeeWaiverSetPayload = { scope: 'kind' | 'account'; kind: FeeWaiverKind; profileId?: string; businessId?: string; fee: FeeWaiverFee; payer: FeeWaiverPayer; startsAt?: string; endsAt?: string; confirmCost?: true }`. The instants are ISO strings.
  - `checkedFeeWaiverPayload(p: unknown): FeeWaiverSetPayload` throws `INVALID_INPUT`.
  - `estimateFeeWaiverMonthlyCost(db, { kind, fee, now }): Promise<bigint>` (W11).
  - `setFeeWaiver(tx: Tx, input: FeeWaiverSetPayload & { staffUserId: string; approvedBy: string | null; reason: string; now: Date }): Promise<{ id: string; startsAt: Date; endsAt: Date | null }>`.
    - It takes the key's advisory lock and applies `feeWaiverWindow`, refusing a window problem with `INVALID_INPUT`.
    - It checks the account exists (`NOT_FOUND`).
    - It refuses a kind-wide `tipme` without `confirmCost` (`FEE_WAIVER_CONFIRM_REQUIRED`).
    - It refuses a row identical in payer and window to the key's current row (`INVALID_INPUT`, so an overtaken request goes stale, as `setPlanFeeRates` does).
    - It inserts the row and audits `fee_waiver.set` with `{ from: <current row's payer/ends or null>, to, approvedBy }`.
  - Serious action `fee_waiver.set`:
    - permission `fees.manage`;
    - `subjects`: `pageOwner` for a profile, the business owners for a business, none for kind;
    - `target`: `fee_waiver:<scope>:<kind>:<id|*>:<fee>`;
    - `current`: `latestRowOfKey(...)?.id ?? null` (W10);
    - `describe`: e.g. "TipMe pays the withdrawal fee for all businesses until 31 Jan 2027 (about ₦12,350 a month, last 30 days)". For a kind-wide `tipme` it asks for the confirm at request time, as `planFeesChange` does;
    - `act` → `setFeeWaiver`.

- [ ] **Step 1: Write the failing tests:**
  - `a second person approves; the row records set_by, approved_by and an audit with before and after`;
  - `a lone admin acts alone and the owners are alerted` (as `plan-fee-setting.test.mjs` exercises `staff_acted_alone`);
  - `a request overtaken by another change to the same key is refused as stale`;
  - `a waiver approved after its requested start begins at approval` (Review Focus 2): request with `startsAt = T`, approve at `T + 3h`, and `starts_at` is `T + 3h`;
  - `an end date more than 24 months ahead, or before the start, is refused and stores nothing`;
  - `a kind-wide TipMe-pays waiver needs confirmCost, and its description names the estimate` (seed two paid tips and one user-paid payout; assert the figure);
  - `ending a waiver now writes inherit (account) or account (kind)`;
  - `a Giving account waiver is refused` (W1).
- [ ] **Step 2: Run** them and the contracts tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(fees): staff set fee waivers with a second approver`.

---

### Task 4: The tip quote under a waiver, credits, and the low-balance pause

**Files:**

- Modify: `packages/database/src/operations/quotes.ts` (`quote`, `QuoteInput`, `QuoteResult`, `openFeeFreeQuotes`), `packages/database/src/operations/provider-events.ts` (credit decrement, and the quote select gains `feeWaiverId`)
- Create: `packages/database/src/operations/fee-waiver-pause.ts`
- Modify: `apps/api/src/checkout/checkout.service.ts` (pass `activeProvider: this.config.PAYMENT_PROVIDER`)
- Test: new `packages/database/test/integration/quotes-waived.test.mjs`, existing `quotes.test.mjs` (must stay green)

**Interfaces:**

- Consumes: `feeWaiverFor` (Task 2), `waivedFeeVersion` (Task 1), `priceTip({ feeFree: true })`.
- Produces:
  - `feeWaiversPaused(db: Database | Tx, input: { activeProvider: string }): Promise<{ paused: boolean; signals: ('payment_reserve_low' | 'collect_reserve_critical')[]; spellStartReadingId: string | null }>` (W6). It reads the latest row of each table for that adapter and currency (both have a `(provider, currency, read_at DESC)` index).
  - `QuoteInput.activeProvider: string` (required). `QuoteResult.feeWaiverId: string | null`. `feeFree` stays true for any waived quote.
  - In `quote`, inside the transaction and before the credit lock:
    - if `feeWaiverFor({ profileId }, 'tip')` is `tipme` and not paused, price `feeFree` with `waived = platform + provider` of the normal price, version `waivedFeeVersion(baseVersion, ruleId)`, and `fee_waiver_id = ruleId`. The credit branch is skipped (W7);
    - otherwise it runs today's path unchanged.
  - `openFeeFreeQuotes` adds `AND q.fee_waiver_id IS NULL`. The decrement in `provider-events.ts` runs only when `waivedPlatformFeeMinor > 0n && feeWaiverId === null`.

- [ ] **Step 1: Write the failing tests** (`quotes-waived.test.mjs`):
  - `a kind waiver prices a ₦0 fee and records the rule`: a Free page, ₦5,000. Expected: `platformFeeMinor 0n`, `providerFeeMinor 0n`, `recipientNetMinor 500000n`, `waived_platform_fee_minor = 25000n` (5%), `fee_policy_version` `v3-free-500bps-waived-<id>`, `fee_waiver_id` set;
  - `an account waiver beats a custom rate, and waived records the custom share`;
  - `an account opted out of a kind waiver is priced normally`;
  - `a waived tip never uses up a fee-free credit`: one credit, a waived quote paid through `recordProviderEvent`, and `remaining` is still 1. A second, unwaived quote made while the waived one is open still gets the credit;
  - `a waiver ending between quote and payment: the quote is honoured`: quote at `now`, the waiver ends, pay. The tip's net is the whole tip, and `provider_fee_expense` holds the actual processing (`buildPaymentPosting`);
  - `a waived quote stays waived through payment after the pause starts` (Review Focus 4): insert a `payment_reserve_readings` row for the active adapter with `low = true` after quoting, then pay;
  - `while the payments reserve reads low, new quotes ignore tip waivers` and `while the You collect reserve reads critical or breach, new quotes ignore tip waivers`. Both apply to a direct and a collect recipient;
  - `a later reading that is not low or critical lifts the pause`;
  - `no reading or an unknown reading does not pause` and `a reading for another adapter does not pause`;
  - `a business staff member's tip follows individual rules, never business ones`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `activeProvider` from the checkout service, and fix the other callers' compile errors (tests and fixtures: `grep -rn "createQuote(" packages apps tests`).
- [ ] **Step 4: Run** this file, `quotes.test.mjs`, `plan-fee-setting.test.mjs`, `moments.test.mjs` and `tests/integration/checkout*.test.mjs`. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(fees): price tips under a fee waiver`.

---

### Task 5: The withdrawal fee under a waiver; retire the switch

**Files:**

- Modify: `packages/database/src/operations/payouts.ts`:
  - `feePayerFor` returns a decision;
  - `quoteFor` and `requestFor` use it;
  - each inserted part gets `feeWaiverId`, and the carrying part gets `waivedFeeMinor`.
- Modify: `packages/contracts/src/switches.ts` (remove `business_payout_fee_absorbed` from `FEATURE_SWITCHES` and the catalogue), `packages/contracts/src/dashboard.ts` (the `feePaidBy` doc comment), `packages/contracts/src/plan-fees.ts` (drop `OpsPlanFees.business`), `apps/api/src/ops/plan-fees.controller.ts` (drop the `featureOn` read), `apps/web/src/app/ops/plan-fees/page.tsx` (drop the `business-payout-fee` paragraph. Task 9 puts the grid there)
- Modify: `docs/runbooks/settings-and-switches.md`: remove the switch's row, and add a "Fee waivers" section covering what a rule does, that the switch is retired, and "fund TipMe's balance at the partner before approving a kind-wide tip waiver" (§5)
- Test: `packages/database/test/integration/payout-fee-user.test.mjs`, `withdrawal-free-per-day.test.mjs`, `business-payouts.test.mjs` (the `:902` case moves to a rule), `withdrawals-split.test.mjs` (per-provider's `a business split pays at most one fee` moves to the business kind rule, §7a), `packages/contracts/test/switches.test.mjs`, `tests/integration/plan-fees-api.test.mjs` (`:338-351` move to a rule), `tests/integration/feature-switches-api.test.mjs`, `packages/database/test/integration/feature-switches.test.mjs` (switch counts)

**Interfaces:**

- Consumes: `feeWaiverFor` (Task 2). Per-provider's `feePayerFor` call site (once per request, on the largest part) and P7 `personsWithdrawalsToday`.
- Produces:
  - `type FeeDecision = { payer: 'user' | 'tipme'; waiverId: string | null; waivedFeeMinor: bigint }`.
  - `feePayerFor(db, owner, route, providerName, feeMinor, now): Promise<FeeDecision>`.
    - First it works out the default payer: a person by the daily count, a business by the free top-up credit, else `user`. The switch branch is gone.
    - Then it reads `feeWaiverFor(owner, 'withdrawal')`. When that's `tipme`, it returns `{ payer: 'tipme', waiverId, waivedFeeMinor: default === 'user' ? feeMinor : 0n }`.
    - Otherwise it returns `{ payer: default, waiverId: null, waivedFeeMinor: 0n }`.
  - `requestFor` writes `fee_waiver_id = waiverId` on every part, and `waived_fee_minor` only on the part P8 names (W8). The quote's `feePaidBy` is `decision.payer`. A waived withdrawal still counts toward the daily two (P7 counts it as free).

- [ ] **Step 1: Write the failing tests:**
  - `a person under a withdrawal waiver pays no fee on the third withdrawal of the day`: `fee_payer 'tipme'`, `user_fee_minor 0`, `fee_waiver_id` set, `waived_fee_minor = fee_minor`;
  - `a waived withdrawal that would have been free anyway costs the waiver nothing` (Review Focus 3);
  - `a waived withdrawal still counts toward the daily two`: two waived, then the waiver ends, and the third is user-paid;
  - `a business under the kind rule (carried over as TipMe pays) receives the whole amount; under payer account it pays from the amount`;
  - `a waived split: every part is tipme with the rule id, and only the largest carries waived_fee_minor`;
  - `the withdrawal quote says tipme while the waiver is in force`;
  - contracts: `business_payout_fee_absorbed is no longer a switch, and a stored row for it is ignored` (feature-switches: insert the row, `readAll`/`listFeatureSwitches` omit it);
  - API: `GET /v1/ops/plan-fees` has no `business` field.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate OpenAPI and docs.
- [ ] **Step 4: Run** them, plus `withdrawals.test.mjs`, `withdrawals-split.test.mjs` and `business-payouts.test.mjs`. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(fees): withdrawal fee waivers replace the business fee switch`.

---

### Task 6: Cost so far, and waived tips kept out of rewards

**Files:**

- Create: `packages/database/src/operations/fee-waiver-cost.ts`
- Modify: `packages/database/src/operations/moments.ts` (`rewardStats`), `packages/database/src/operations/ops-metrics.ts` (`waived_this/last`)
- Test: new `packages/database/test/integration/fee-waiver-cost.test.mjs`, `moments.test.mjs`, `ops-metrics.test.mjs`

**Interfaces:**

- Produces:
  - `type WaiverCost = { incomeGivenUpMinor: bigint; cashPaidMinor: bigint }` holds two figures and is never summed (§6).
  - `feeWaiverCost(db, input: { from: Date; to: Date; ruleId?: string; kind?: FeeWaiverKind; owner?: MoneyOwnerRef }): Promise<WaiverCost>` (W12):
    - **income given up** is Σ `q.waived_platform_fee_minor` of SUCCEEDED tips whose quote has `fee_waiver_id`, by `completed_at`;
    - **cash paid** is the Σ of the `provider_fee_expense` debit entries on those tips' `payment` ledger transactions, plus Σ `waived_fee_minor` of PAID payouts by `paid_at`;
    - the kind filter joins `fee_waivers.kind`, and the owner filter uses `profile_id`/`business_id` on the tip or payout.
  - `lagosMonthStart(now: Date): Date` (reuse an existing Lagos helper if one exists: `grep -rn "lagosDayStart\|Africa/Lagos" packages/database/src/operations`).
  - `rewardStats`: `waived` sums only rows with `q.fee_waiver_id IS NULL`, and `fees` is unchanged (a waived tip adds 0). `ops-metrics`: `waived_this/last` likewise.

- [ ] **Step 1: Write the failing tests:**
  - `cost shows fee income given up and cash paid apart`: two waived tips (with seeded processing booked) and one waived paid payout, so `incomeGivenUpMinor` = Σ waived and `cashPaidMinor` = Σ processing + `waived_fee_minor`;
  - `fee-free credit tips and failed tips never count`;
  - `a rule's cost, a kind's cost and an account's cost each filter correctly`;
  - `this month starts at Lagos midnight on the 1st`;
  - moments: `waived tips count as neither fee income nor reward cost toward the cash-bonus cap`. ops-metrics: `waived tips are left out of the week's waived figure`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(fees): what fee waivers cost, kept out of rewards`.

---

### Task 7: Ops API for waivers

**Files:**

- Create: `packages/contracts/src/fee-waivers.ts` (export from `packages/contracts/src/index.ts`), `apps/api/src/ops/fee-waivers.controller.ts` (register in `apps/api/src/ops/ops.module.ts`)
- Test: new `tests/integration/fee-waivers-api.test.mjs`

**Interfaces:**

- Consumes: Tasks 2, 3, 4 (`feeWaiversPaused`) and 6.
- Produces (contracts):
  - `opsFeeWaiverSetSchema` = `opsReasonSchema.extend({ scope, kind, profileId: z.uuid().optional(), businessId: z.uuid().optional(), fee, payer, startsAt: z.iso.datetime().optional(), endsAt: z.iso.datetime().optional(), confirmCost: z.literal(true).optional() }).strict()`, refined by the shape rules.
  - `OpsFeeWaiverRule = { id; scope; kind; profileId: string | null; businessId: string | null; handle: string | null; businessName: string | null; fee; payer; startsAt: string; endsAt: string | null; setBy: string | null; approvedBy: string | null; reason: string; cost: { incomeGivenUpMinor: string; cashPaidMinor: string } }`.
  - `OpsFeeWaivers = { grid: Record<FeeWaiverKind, Record<FeeWaiverFee, { payer: 'tipme' | 'account'; ruleId: string | null; endsAt: string | null; live: boolean }>>; monthCost: Record<FeeWaiverKind, { incomeGivenUpMinor: string; cashPaidMinor: string }>; tipWaiversPaused: boolean; inForce: OpsFeeWaiverRule[]; upcoming: OpsFeeWaiverRule[]; waitingRequestIds: string[] }`.
    - `grid.business.tip` is reported with `payer: 'account'` and is not settable.
    - `live` is false for `giving`.
  - `OpsAccountFeeWaivers = { tip: AccountFeeSetting | null; withdrawal: AccountFeeSetting }` (tip is null for a business), where `AccountFeeSetting = { setting: 'inherit' | 'tipme' | 'account'; endsAt: string | null; effective: 'tipme' | 'normal'; ruleId: string | null }`. It also carries `monthCost`.
- Produces (API, all `fees.manage`):
  - `GET v1/ops/fee-waivers` (`ops_read`) → `OpsFeeWaivers`;
  - `POST v1/ops/fee-waivers` (`ops_request`, `@FreshCode()`, `pendingOr`) → `(OpsFeeWaivers & OpsActedAlone) | OpsSeriousPending`;
  - `GET v1/ops/fee-waivers/profiles/:profileId` and `GET v1/ops/fee-waivers/businesses/:businessId` (`ops_read`, UUID-checked, 404 when unknown) → `OpsAccountFeeWaivers`.
  - `tipWaiversPaused` reads `feeWaiversPaused({ activeProvider: config.PAYMENT_PROVIDER })`.

- [ ] **Step 1: Write the failing tests** (`startStack()`):
  - `a staff member without fees.manage gets 403 on every route`;
  - `POST without a fresh code is refused`;
  - `an account waiver waits for a second person, then shows in force on the grid and the account view`;
  - `a kind-wide TipMe-pays request without confirmCost is refused FEE_WAIVER_CONFIRM_REQUIRED`;
  - `a low payments reserve reading shows tipWaiversPaused` (insert a `payment_reserve_readings` row for `mock`);
  - `a business account view has no tip setting`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate OpenAPI and docs.
- [ ] **Step 4: Run** it and `plan-fees-api.test.mjs`. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(ops): fee waiver API`.

---

### Task 8: Notices and the pause alert (worker)

**Files:**

- Create: `packages/database/src/operations/fee-waiver-notices.ts`, `apps/worker/src/handlers/fee-waivers.ts`
- Modify: `apps/worker/src/job-worker.ts` (job `fees.waivers`, `ensureSchedule({ every: 15 * 60_000 })` behind `runUnlessRunning`), `packages/contracts/src/ops.ts` (`ISSUE_KINDS` += `fee_waiver_ending`, `fee_waivers_paused`), `packages/database/src/operations/issues.ts` (severity and summary: "A fee waiver ends within a day", "Fee waivers paused: TipMe's balance is low"), `packages/contracts/src/copy.ts` (notice copy)
- Test: new `packages/database/test/integration/fee-waiver-notices.test.mjs`, new `apps/worker/test/fee-waivers-handler.test.mjs`

**Interfaces:**

- Consumes: Tasks 2 and 4 (`feeWaiversPaused`), `openIssue`, `markResolved`, `businessManagerUsers`, `webhookAlert`.
- Produces:
  - `runFeeWaiverNotices(db, input: { activeProvider: string; now: Date }): Promise<{ endingSoon: number; started: number; ended: number; paused: 'opened' | 'open' | 'resolved' | 'none' }>`. It is idempotent through `fee_waiver_notices` and issue dedupe keys (W13, W14).
  - In-app copy: started "TipMe is covering the fee on your tips" or "TipMe is covering your withdrawal fees", plus " until {d MMM}" when it ends. Ended (final fix wave, I2): names the fee, "TipMe has stopped covering the fee on your tips. The normal tip fee applies from now." or "TipMe has stopped covering your withdrawal fees. The normal withdrawal fees apply from now."
  - The handler `handleFeeWaivers({ db, activeProvider, alert, now })` posts "Fee waivers paused: TipMe's balance is low" through `alert` only when `paused === 'opened'`.
  - Kind-wide rules send no started notifications (§6); their end tells the accounts that used them (R22, final fix wave).

- [ ] **Step 1: Write the failing tests:**
  - `an account waiver starting sends its owner one notification, however often the job runs`;
  - `a business waiver notifies the business's owners`;
  - `an account waiver ending or replaced sends one ended notice`;
  - `a kind waiver sends no notifications`;
  - `staff get one fee_waiver_ending issue the day before a waiver ends`;
  - `paused with a tip waiver in force opens one issue per spell, resolves when the balance recovers, and a new spell opens a new one`. Drive the spell with `payment_reserve_readings`;
  - `a spell where the payments reading goes low and then the collect reading goes critical stays one issue`;
  - `paused with no tip waiver in force opens nothing`;
  - worker: `the alert is posted once per spell and the job keeps run retention` (assert the template opts equal `SCHEDULED_RUN_RETENTION`).
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: `# fail 0`.
- [ ] **Step 5: Commit** `feat(fees): fee waiver notices and the low-balance pause alert`.

---

### Task 9: Staff screens

**Files:**

- Modify: `apps/web/src/app/ops/plan-fees/page.tsx` (the "Who pays the fees" grid and a "Change…" dialog)
- Create: `apps/web/src/app/ops/plan-fees/waivers/page.tsx` (the Waivers list), `apps/web/src/components/ops/account-fee-waivers.tsx` (per-account control)
- Modify: `apps/web/src/components/ops/page-pricing.tsx` (render `AccountFeeWaivers` for a profile), `apps/web/src/app/ops/businesses/[businessId]/page.tsx` (render it for a business, withdrawal only), `apps/web/src/lib/ops-client.ts` (the four calls), `apps/web/src/lib/ops-menu.ts` (link "Fee waivers" under Plan & fees, `['fees.manage']`)
- Create: `apps/web/src/lib/fee-waiver-dates.ts`
- Test: new `apps/web/test/fee-waiver-dates.test.mjs`, new `tests/e2e/ops-fee-waivers.spec.ts`, existing `tests/e2e/ops-plan-fees.spec.ts` (must stay green)

**Interfaces:**

- Consumes: Task 7's contracts and routes.
- Produces:
  - `endOfLagosDay(date: string /* YYYY-MM-DD */): string /* ISO */` returns the start of the next Lagos day. `untilLabel(iso: string): string` gives "until 31 Jan" (Lagos), adding the year when it isn't this year.
  - Grid copy (§6):
    - rows are Individuals, Businesses and Giving;
    - cells read "Account pays", "TipMe pays · until 31 Jan", "2 free a day, then account" (individual withdrawal default) or "—" (business tip);
    - Giving shows "(not live)";
    - the cost cell shows both figures with their labels "Fee income given up" and "Cash paid by TipMe";
    - the tip column shows "Paused (low balance)" while `tipWaiversPaused`.
  - The change dialog has who pays, an optional start, an optional end date, a reason and a cost-confirm checkbox for kind-wide "TipMe pays". The per-account control offers "Follow the global setting / TipMe pays / Normal rules" for each fee, with an optional end date.

- [ ] **Step 1: Write the failing tests:**
  - `fee-waiver-dates.test.mjs`: `an end date is sent as the start of the next Lagos day and shown as the date picked` (Review Focus 5): `endOfLagosDay('2027-01-31') === '2027-01-31T23:00:00.000Z'` and `untilLabel` of that is "until 31 Jan".
  - `ops-fee-waivers.spec.ts` (two staff, as `ops-plan-fees.spec.ts` does):
    - `@alone staff set an account waiver with an end date; a second person approves; the user's ops page shows TipMe pays until that date`;
    - `the grid shows the carried-over business rule and the paused label` (route `GET /v1/ops/fee-waivers` to `tipWaiversPaused: true`);
    - `the waivers list shows who set and approved it, with both cost figures`;
    - axe with `expectAccessible`. Scope text to `main`.
- [ ] **Step 2: Run** the web tests and the spec. Expected: FAIL.
- [ ] **Step 3: Implement** to `docs/design/DESIGN-CONSTITUTION.md` (read it, `RESPONSIVE-COMPOSITION.md` and `VISUAL-QUALITY-GATE.md` first), reusing the plan-fees and `PagePricing` patterns. No new visual pattern.
- [ ] **Step 4: Run** the web tests, `ops-fee-waivers.spec.ts` and `ops-plan-fees.spec.ts` with `--repeat-each=5 --retries=0`. Expected: `# fail 0`, 0 failed. Take the phone and desktop screenshots.
- [ ] **Step 5: Commit** `feat(ops): who pays the fees screens`.

---

### Task 10: What the recipient sees, end to end

**Files:**

- Modify: `packages/contracts/src/dashboard.ts` (`DashboardSummary.tipFeeWaiver`, `MyTipDetail.feeCoveredByTipMe`), `packages/database/src/operations/dashboard.ts` (`myTipDetail` selects `q.fee_waiver_id IS NOT NULL`), `apps/api/src/dashboard/dashboard.controller.ts` (`summary` adds `tipFeeWaiver` from `feeWaiverFor` + `feeWaiversPaused`, W17)
- Modify: `apps/web/src/app/dashboard/home-view.tsx` (the line), `apps/web/src/app/dashboard/tips/[tipId]/tip-view.tsx` (the line under the fee), `apps/web/src/app/dashboard/business/sections/money.tsx` ("Transfer fee: Free." when `feePaidBy === 'tipme'`), `packages/contracts/src/copy.ts`
- Test: `apps/web/test/*` for the copy helpers, `tests/integration/dashboard-api.test.mjs` (or the file that covers `GET /v1/me/dashboard`: `grep -rln "v1/me/dashboard" tests/integration`), new `tests/e2e/fee-waiver.spec.ts`

**Interfaces:**

- Consumes: Tasks 2, 4, 5 and 9.
- Produces: the copy (§7):
  - dashboard: "TipMe is covering the fee on your tips", plus " until 31 Jan" (`untilLabel`);
  - tip detail: "TipMe covered the fee on this tip.";
  - business: "Transfer fee: Free. The business receives {amount}.";
  - no copy names the partner.

- [ ] **Step 1: Write the failing tests:**
  - API: `the dashboard carries tipFeeWaiver while an account tip waiver is in force`, and `the dashboard line hides while waivers are paused` (Review Focus 4). `a waived tip's detail says feeCoveredByTipMe`;
  - `fee-waiver.spec.ts`, using a fresh recipient and account scope only:
    - staff set a tip and a withdrawal waiver with an end date through the ops screen and a second person approves;
    - the recipient's dashboard shows the line with "until {date}";
    - a visitor tips ₦2,000, and the tip detail shows the fee as ₦0 with "TipMe covered the fee on this tip.";
    - the withdraw screen's transfer fee says "Free" on a third withdrawal of the day (seed two earlier ones with `withDatabase`).
    - Then, to stand in for the end date passing, insert (never update, W16) a later already-ended row for each key with `withDatabase`. The next tip's detail shows the normal fee ("TipMe fee (5%, includes processing)"), the dashboard line is gone, and the third withdrawal shows its fee;
    - `expect(page.locator('main')).not.toContainText(/bachs|mock/i)`, and axe with `expectAccessible`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate OpenAPI and docs.
- [ ] **Step 4: Run** them and the web tests, then `withdraw.spec.ts` and `business-money.spec.ts` with `--repeat-each=5 --retries=0`. Expected: `# fail 0`, 0 failed. Take the phone and desktop screenshots.
- [ ] **Step 5: Commit** `feat(web): show when TipMe covers the fees`.

---

## After the last task

Run the whole gate, `pnpm test:integration` and every e2e spec this plan touched. Then do a whole-branch review against the spec, §-by-§:

- §2, §4: Tasks 1, 2, 4, 5
- §5 (ledger, pause, serious action, bounds, switch): Tasks 3, 4, 5, 8
- §6: Tasks 6, 7, 8, 9
- §7: Task 10
- §7a: Tasks 4, 5, 6
- §8: Tasks 1, 7, 9 (Giving kind rules, "not live")
- §9: every task
