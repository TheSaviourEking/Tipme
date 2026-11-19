# You Collect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New recipients take tips at once: the supporter pays TipMe (merchant of record), TipMe holds each recipient's share in its own partner balance and transfers it to the recipient's receive-only partner account as soon as the tip settles. The recipient proves only their name and a bank account in their own name at their first withdrawal. Refunds, disputes, the held-money invariant, fraud guards and staff screens make that safe. Everything sits behind the `you_collect` money switch, which is off everywhere.

**Architecture:** Each recipient gets a collection mode (`direct` is today's flow, `collect` is new). The mode is copied onto every tip quote, so a tip always follows the mode it was quoted under. A `collect` tip is a checkout on TipMe's own account (`platform:<checkout_id>`). Its payment posting debits a new per-owner asset, `held_for_recipients`, instead of `provider_clearing`. A `collect_transfers` row per tip then moves the share to the recipient's partner account with the transfer machine (claim → send → read back by `transfer_group`), and posts `provider_clearing` ← `held_for_recipients`. Disputes become a modelled object with their own table, ledger postings and staff screen. The reserve check enforces `platform available ≥ Σ held_for_recipients` in every currency.

**Tech Stack:** TypeScript strict, NestJS (API), BullMQ worker, Drizzle/Postgres (drizzle-kit migrations), Zod contracts, Next.js App Router (web), `node --test`, Playwright with `@axe-core/playwright`. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-19-you-collect-design.md` (binding, owner-approved 19 Nov 2026, PR #296). Owner context: the 19 Nov "You collect" decision, final pricing (18 Nov), business option B (11 Nov). In this plan, §n means a section of the spec.

---

## What the code does today (origin/dev `89070533`, migrations up to `0118_plan_fee_rates`)

- **Ledger:** `packages/domain/src/ledger.ts` holds `AccountCode` (no `held_for_recipients`), `buildPaymentPosting` (debits `provider_clearing`), `buildRefundReversalPosting` and `buildReversalPosting` (both credit `provider_clearing`), and the Pro postings on `platform_clearing`. `packages/database/src/operations/ledger.ts` holds `KIND` and `postLedgerTransaction`; `operation_type` is a pg enum. The `ledger_accounts_business_payable` check allows `business_id` only on `business_payable`. Tests are in `packages/domain/test/ledger.test.mjs` and use a seeded LCG, not fast-check.
- **Checkout:** `apps/api/src/checkout/checkout.service.ts` `createIntent` calls `getReadyPaymentAccount` and throws `409 PAYMENT_ACCOUNT_REQUIRED` with no ready account, then `bachsProvider.initializePayment` (`X-Account-Id`, `platform_fee`). `initializePlatformCheckout` (`provider.ts:667`) is Pro-only (`reference: purchaseId`).
- **Webhooks:** `packages/payments/src/bachs/webhooks.ts` normalizes every `refund.*|dispute.*|chargeback.*` event to `kind: 'reversal'` (ids only, no amounts or deadlines). `webhook.service.ts` `applyBachs` sends **every** platform-scoped (`scope: 'platform'`) payment or reversal to `applyProEvent`. Connected-account reversals go to `flagBachsReversal`, which surfaces them to staff.
- **Transfers:** `payouts.ts` has `transferToAccount` and `collectToPlatform` (both set `transfer_group` = key), `findPlatformCollection` (lists 100 at most, matches `transfer_group`), and `moneyWrite`. `TRANSFER_REFUSALS` maps both `INSUFFICIENT_BALANCE` and `ORGANIZATION_IN_DEBT` to `reserve_empty`, with no `FORBIDDEN`. `readBalance` clamps a negative balance to 0 and reads NGN only.
- **Option B:** `packages/database/src/operations/share-transfers.ts`. `scheduleShareSweep` is called from `provider-events.ts` in the payment's transaction. Kinds are `sweep | recover | fee_return | holdback_repay`; `SOURCE[fee_return] = null` (a leg-in-only move already exists).
- **Accounts:** `createReceiveOnlyAccount` is company-only. `payment_accounts` is unique per `(profile, provider, environment)`. `addPayoutDestination` answers `usable | pending_review | rejected`.
- **Refunds:** `tip-refunds.ts` uses `refundAccountCharge` (as the recipient's account) and refunds `recipientNetMinor` (`tipRefundParts`).
- **Reserve:** `payment-reserve.ts` `checkReserve` reads NGN `platformBalance` against `BACHS_RESERVE_ALERT_MINOR` every 15 min (`job-worker.ts` `payments.reserve`).
- **Holds:** `withdrawal_holds` holds a profile's whole balance (reasons `reversal | in_debt | unexpected_payout | account_takeover`). There is no amount.
- **Switches:** `packages/contracts/src/switches.ts` (`FEATURE_SWITCHES`, catalogue, `money`, `notBuilt`). Admin settings follow `plan-fee-rates.ts`: an append-only table, the serious action, an audit row and an alert to owners.
- **Tests:** domain and payments use `node --test`, and payments fakes `fetchImpl` with recorded sandbox bodies (`bachs-business-shares.test.mjs`). Integration tests are in `tests/integration/*.test.mjs` (helpers in `helpers.mjs`, real local Postgres and Redis). Production-mode processes load `no-real-provider.mjs`, which routes `*.bachs.io` to a local stand-in. E2E is in `tests/e2e/*.spec.ts`. The mock provider is in `packages/payments/src/mock/` (`SCENARIOS`, `mockWebhookTypes` in `packages/contracts/src/webhooks.ts`).

## Rulings on gaps (made by this plan; flag to the coordinator if any is wrong)

- **R1. Dispute events.** Today they are not ignored; they are normalized as `reversal` and flagged (the spec's "not modelled at all" means no amounts, no table and no money). New: a **platform-scoped** dispute event that matches a collect tip becomes `kind: 'dispute'`, with amount, currency, status, reason, deadline and fee. Connected-account (direct) disputes keep today's `reversal` path, byte for byte.
- **R2. Routing TipMe's own events.** A platform-scoped payment, reversal or dispute event is first matched against collect payment attempts (`operationReference` = attempt id, or `platform:<checkout_id>` = the attempt's `provider_reference`, or the stored charge reference). Only an event that matches nothing goes to `applyProEvent`, as today.
- **R3. A business share on a collect tip** (§11 option B, single leg). The spec's posting table has no share. The share's money sits in TipMe's balance too, so `held_for_recipients` may be owned by a business: the `ledger_accounts_business_payable` check becomes "`business_payable` needs a business; only `business_payable` and `held_for_recipients` may have one". The collect transfer to the staff member moves `net − share`. A new share-transfer kind `collect_sweep` (`SOURCE = null`, `DESTINATION = 'business'`) runs only the leg into the business and posts `provider_clearing` ← `held_for_recipients(business)`.
- **R4. Dispute hold by amount.** `withdrawal_holds` freezes the whole balance, but §6.2 wants that amount held. An open dispute row's `held_minor` is therefore added to `reserved` in `balanceQuery`, as Pro-from-balance is. `withdrawal_holds` is not used for disputes, and its reasons are unchanged.
- **R5. Platform withdrawals.** TipMe has no code that withdraws its own earnings (that happens in the partner dashboard). §4 "refused below the held total" becomes three things. A guard `ownMoneyAllows` refuses every TipMe-funded move (payout-fee cover, fee returns, refund absorption) that would take own money below zero, or below critical for a voluntary move. The reserve check pages on a breach. The runbook forbids dashboard withdrawals below the line.
- **R6. Accounts not named in §4.** A refund TipMe absorbs after a withdrawal (§6.1 case 3) posts `refund_loss_expense`. Dispute fees post in the currency the partner reports. If no currency is reported, nothing is posted and an issue opens (P5). TipMe's fee revenue on a lost-dispute tip is not reversed; the loss is `dispute_loss_expense` (accountant question A3).
- **R7. Existing never-verified recipients (§11).** `profiles.collection_mode` is nullable. Null means "not decided" and behaves as `direct`. A quote while the switch is on decides once: an ACTIVE payment account gives `direct`, anything else gives `collect`. Their existing payment-account row is reused for collect (it already requests `payouts` and `transfers`; the table is unique per profile, provider and environment). A new sign-up while the switch is on is written `collect` at once.
- **R8. Name check.** The spec doesn't give the partner's field names for an individual's name. Task 4 takes them from `/connect/requirements` (re-read at build), records the request and response in a sandbox fixture, and names the URL in the PR. The sandbox doesn't run the bank-name check (§12.3), so `pending_review` and `rejected` are proven on the mock and on recorded fixtures only.
- **R9. Transfer refusals.** Option B's `TRANSFER_REFUSALS` stays byte-identical. Collect gets its own call, `sendCollectTransfer`, with its own refusal map: `INSUFFICIENT_BALANCE → insufficient`, `FORBIDDEN → capability`, `ORGANIZATION_IN_DEBT → in_debt`, `NOT_FOUND → not_found`.
- **R10. Transfer states.** The states are `waiting | ready | sent | unknown | paid | cancelled | review`. The diagram's `refused` is not stored: a refusal returns the row to `ready` (insufficient) or `waiting` (capability), or sends it to `review` (anything else).
- **R11. Emergency pause and debt freeze (§12.5, §5).** Staff pause collect transfers with the serious action `collect_transfers.pause` and resume them with `collect_transfers.resume`, as a `paused` column on the settings row. An open `collect_in_debt` issue also stops every collect transfer until staff resolve it.
- **R12. Switch stays inert.** Task 3 registers `you_collect` as `notBuilt: true` (staff can't turn it on). Only Task 16 removes `notBuilt`. Tests turn it on with the test helper that writes the switch row directly, as `tip_refunds` tests do.

## Global Constraints

Every task includes these.

- **No real money.** No test calls `api.bachs.io` or `sandbox-api.bachs.io`. Payments tests fake `fetchImpl`; integration and e2e tests use the mock provider or the local stand-in (`no-real-provider.mjs`). The only sandbox contact is the manual script in Task 16 (`--sandbox`, an `sk_sandbox_` key, origin `https://sandbox-api.bachs.io`, test money).
- **Switch:** `you_collect` is a money switch, off by default, `env: onOff('YOU_COLLECT')`. With it off, every path does exactly what it does today. With it off, existing `collect` recipients keep `collect`, and their transfers, refunds, disputes and reserve checks keep running (§12.5). Every PR must be safe with it off (production) and green with it on (tests).
- **Mode is fixed per tip:** read `tip_quotes.collection_mode`, never the profile's current mode, after the quote.
- **Money:** integer minor units plus ISO 4217. Every posting balances per currency, is append-only, is keyed by an operation key and is written in the same transaction as the state it records. Never retry a money move blindly: a lost answer is retried with the same key within 24 h, and read back by `transfer_group` after that.
- **Fees unchanged:** Free 5% and Pro 3% per tip (admin-settable), processing and payout included. The first two personal withdrawals per Lagos day are free, then the partner's ₦50. No change to the minimum tip, the minimum withdrawal, VAT or business rates.
- **Keys** (exact): checkout `tipme-checkout-<attemptId>`; share `tipme-collect-<tipId>`; back `tipme-collect-back-<refundId>` or `tipme-collect-back-<disputeId>`; business leg `tipme-share-in-<shareTransferId>` (existing).
- **Copy (§10):** use the spec's table word for word. Never name the partner (always "our payment partner"). Never say "wallet", "account with TipMe", "protected", "insured" or anything implying a licence or a bank.
- **Not an approval:** never edit `docs/00-DECISIONS.md` (D-04 and D-06 stay OPEN), `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md` or `docs/design/redesign/README.md`. ADR-0016 stays PROPOSED until the owner accepts it.
- **Process:** each task is one PR into `dev`, in task order. Test first: watch every test fail, then pass. Migrations only via `pnpm --filter @tipme/database generate`, named **next number at merge time** (rename on rebase, as `0118` was). API-changing PRs regenerate OpenAPI (`pnpm --filter @tipme/api build && pnpm api:openapi`) and docs (`pnpm docs:generate`); `--check` must pass. Never `--no-verify`. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Every PR states the switch state it was tested with.
- **E2E:** lanes 3–8 only (`E2E_LANE=3`…`8`). New or changed specs pass `--repeat-each=5 --retries=0` locally (`tests/e2e/AGENTS.md`). Linux baselines come only from CI artifacts.
- **Screenshots:** every PR with visible UI shows phone (390) and desktop (1440) screenshots, using test data only, on the `pr-assets` branch under `pr-<number>/`.

## Commands used by every task

| What                 | Command                                                                                   | Passing output      |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------------- |
| Domain tests         | `pnpm --filter @tipme/domain build && pnpm --filter @tipme/domain test`                   | `# fail 0`          |
| Payments tests       | `pnpm --filter @tipme/payments build && pnpm --filter @tipme/payments test`               | `# fail 0`          |
| Contracts tests      | `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`             | `# fail 0`          |
| Worker tests         | `pnpm --filter @tipme/worker test`                                                        | `# fail 0`          |
| Integration (subset) | `pnpm test:integration -- tests/integration/<file>.test.mjs`                              | `# fail 0`          |
| Migration check      | `pnpm --filter @tipme/database generate` (no new file after your migration)               | "No schema changes" |
| E2E (one spec)       | `E2E_LANE=5 pnpm test:e2e -- tests/e2e/<spec>.ts --repeat-each=5 --retries=0 --workers=2` | 0 failed            |
| Whole gate           | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`                           | exit 0              |

## Review Focus

These are the inputs the spec implies but no other task's tests cover, most likely to cause harm first. Each has its pinning test in the owning task.

1. **A collect tip's webhook arrives at Pro billing, or a Pro event at the tip path.** Both are platform-scoped. Expected: the event goes to whichever one matches its reference; anything else stays unmatched. Neither path ever books the other's money. _Test:_ `a platform-scoped event for a collect tip never reaches Pro billing, and a Pro event never reaches a tip` (Task 7).
2. **The recipient changes their bank account (or a second recipient adds the same one) while held tips are releasing.** Expected: the transfer goes to the account that is verified when it is sent, and never to a pending or rejected destination. A duplicate account sends the second recipient's transfers to `review`. _Test:_ `a transfer waits while the destination is pending review, and a shared bank account sends the second recipient to review` (Task 13).
3. **A refund or dispute lands while that tip's transfer is `sent` or `unknown`.** Expected: nothing is cancelled under a transfer in flight. The refund or dispute waits for the read-back, then takes the held path (not moved) or the transfer-back path (moved). _Test:_ `a refund during an in-flight transfer waits for the read-back and recovers exactly once` (Task 10) and `a dispute opened on a sent transfer resolves after read-back` (Task 9).
4. **The switch is turned off with held money and open disputes.** Expected: no new sign-up gets `collect`. Existing collect pages still take tips and their held tips keep moving. The reserve and recon keep checking. _Test:_ `switching off keeps existing collect recipients tipping and transferring` (Task 16).
5. **The partner reports TipMe's NGN balance fine but another currency negative (the $15 fee from USD, P5).** Expected: a critical alert names the currency; collect transfers aren't marked failed because of it. An `ORGANIZATION_IN_DEBT` answer stops all collect transfers (one issue, not one per tip). _Test:_ `a negative USD balance pages staff even when NGN is above the line` and `in-debt stops every collect transfer with one issue` (Tasks 11 and 8).

---

## Delivery order

| PR  | Task                                                       | Migration | API change | Visible UI |
| --- | ---------------------------------------------------------- | --------- | ---------- | ---------- |
| 1   | 1 Ledger postings for You collect                          | No        | No         | No         |
| 2   | 2 Refund and dispute recovery model                        | No        | No         | No         |
| 3   | 3 Schema, inert switch, settings reader, ADR-0016          | **Yes**   | No         | No         |
| 4   | 4 Adapter: collect money calls, fixtures, mock             | No        | No         | No         |
| 5   | 5 Adapter: dispute events and API, mock disputes           | No        | No         | No         |
| 6   | 6 Collection mode, quote and checkout branch               | No        | **Yes**    | No         |
| 7   | 7 Confirming a collect payment                             | No        | No         | No         |
| 8   | 8 Collect transfer machine and worker                      | No        | No         | No         |
| 9   | 9 Disputes in TipMe                                        | No        | No         | No         |
| 10  | 10 Refunds on collect tips                                 | No        | **Yes**    | Ops        |
| 11  | 11 Reserve invariant and reconciliation                    | No        | No         | No         |
| 12  | 12 Guards, holding cap, reminders, settings admin          | Maybe     | **Yes**    | No         |
| 13  | 13 Add bank details (API)                                  | No        | **Yes**    | No         |
| 14  | 14 Recipient and supporter UI                              | No        | No         | **Yes**    |
| 15  | 15 Staff screens                                           | No        | **Yes**    | **Yes**    |
| 16  | 16 Switch usable, end-to-end journey, sandbox script, docs | No        | No         | No         |

The order is strict. Only Task 3 has a planned migration; any later schema need goes into Task 3's PR if it hasn't merged, otherwise into a migration in the PR that needs it (Task 12 is the only "maybe"). Tasks 4 and 5 may be built in parallel, and Tasks 9 and 10 may be built in parallel after Task 8, but they merge in order.

---

### Task 1: Ledger postings for You collect (PR 1)

**Files:**

- Modify: `packages/domain/src/ledger.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/ledger-collect.test.mjs` (new)

**Interfaces:**

- Produces:
  ```ts
  type AccountCode = … | 'held_for_recipients' | 'dispute_fee_expense' | 'dispute_loss_expense' | 'refund_loss_expense';
  type Owner = { profileId: string } | { businessId: string };
  function buildCollectPaymentPosting(input: PaymentPostingInput): LedgerLine[];           // team splits refused
  function buildCollectTransferPosting(i: { amountMinor: bigint } & Owner): LedgerLine[];  // Dr provider_clearing, Cr held (owner)
  function buildCollectReturnPosting(i: { amountMinor: bigint } & Owner): LedgerLine[];    // Dr held (owner), Cr provider_clearing
  function buildCollectRefundPosting(i: { parts: readonly ({ amountMinor: bigint } & Owner)[]; refundFeeMinor?: bigint }): LedgerLine[];
  function buildAbsorbedRefundPosting(i: { amountMinor: bigint; refundFeeMinor?: bigint }): LedgerLine[]; // Dr refund_loss_expense, Cr platform_clearing
  function buildDisputeFeePosting(i: { feeMinor: bigint }): LedgerLine[];                   // Dr dispute_fee_expense, Cr platform_clearing
  function buildDisputeLossPosting(i: { disputedMinor: bigint; recovered: readonly ({ amountMinor: bigint } & Owner)[] }): LedgerLine[];
  ```
- `buildCollectPaymentPosting` lines (§4): Dr `held_for_recipients` (the person: `net − share`; the business: `share`, R3); Dr `platform_clearing` = `platformFee + quotedFee − actualFee` (a **credit** line of the absolute value when negative); Dr `provider_fee_expense` = actual; Cr `platform_fee_revenue`, Cr `provider_fee_recovered`, and the same payable credits as `payableLines`. Zero lines are dropped.
- `buildCollectRefundPosting`: for each part, Dr its payable (`recipient_payable` or `business_payable`) and Cr `held_for_recipients` for the same owner; then the refund fee as Dr `provider_fee_expense`, Cr `platform_clearing`.
- `buildDisputeLossPosting`: each recovered part as Dr payable, Cr held (same owner); then Dr `dispute_loss_expense`, Cr `platform_clearing` = `disputedMinor − Σ recovered`. Refuse a recovered total above `disputedMinor`.

- [ ] **Step 1: Write the failing tests** in `ledger-collect.test.mjs`:
  - `a collect payment balances for Free, Pro, local card and bank transfer`. Use `priceTip` at 500 and 300 bps over ₦2,000, ₦10,000 and ₦100,000, with actual fee = quoted ± 50 kobo and actual = 0 (bank transfer). Assert `isBalanced`, that the person's `held_for_recipients` debit equals `recipientNetMinor`, and that no line is ≤ 0.
  - `an international card makes TipMe's line a credit`. Use Pro 3% on ₦2,000 (fee 6000) with quoted 4000 and actual 7000 (2% + 1.5%). Assert one `platform_clearing` **credit** of `1000`, and balanced.
  - `golden: the person's net is exactly the quote`. For ₦10,000 Free (fee 50000), assert the lines exactly: held Dr 950000, platform_clearing Dr per formula, revenue Cr 50000, payable Cr 950000.
  - `a share on a collect tip is held for the business`. Use share 100000 of net 950000. Assert held Dr 850000 for the profile, held Dr 100000 for the business, and `business_payable` Cr 100000.
  - `transfer and return postings mirror each other and leave the payable alone`. Assert neither has a `recipient_payable` line.
  - `a refund of a held share takes the payable and the held money, never TipMe's fee`.
  - `an absorbed refund and a dispute fee are TipMe's own money`. Assert only `refund_loss_expense` or `dispute_fee_expense` plus `platform_clearing`.
  - `a lost dispute recovers what was held and TipMe absorbs the rest`, in three cases: full (recovered = net, loss = gross − net), partial (recovered 300000, loss = gross − 300000) and none (loss = gross).
  - `every collect posting balances` (property, seeded LCG as in `ledger.test.mjs`, 1000 runs over all seven builders with random valid input).
  - `refused: a team on a collect payment, a zero or negative amount, recovery above the disputed amount`.
- [ ] **Step 2: Run** the domain tests. Expected: FAIL (`buildCollectPaymentPosting is not a function`).
- [ ] **Step 3: Implement** the builders in `ledger.ts`, reusing `line` and `payableLines`. Add a doc comment: "ADR-0016; codes illustrative pending finance sign-off (ADR-0006)".
- [ ] **Step 4: Run** the domain tests, then `ledger.test.mjs` unchanged. Expected: `# fail 0`; the existing goldens are untouched.
- [ ] **Step 5: Commit and open PR 1.** `feat(domain): You collect ledger postings (held_for_recipients)`.

---

### Task 2: Refund and dispute recovery model (PR 2)

**Files:**

- Create: `packages/domain/src/collect.ts`; Modify: `packages/domain/src/index.ts`, `packages/domain/src/state-machines.ts`
- Test: `packages/domain/test/collect.test.mjs`

**Interfaces:**

- Produces:
  ```ts
  export const COLLECT_TRANSFER_STATUSES = [
    'waiting',
    'ready',
    'sent',
    'unknown',
    'paid',
    'cancelled',
    'review',
  ] as const;
  export const COLLECT_TRANSFER_TRANSITIONS: Record<
    CollectTransferStatus,
    readonly CollectTransferStatus[]
  >;
  //  waiting→ready|cancelled|review; ready→sent|waiting|cancelled|review; sent→paid|unknown|ready|waiting|review;
  //  unknown→paid|ready|review; review→ready|cancelled|paid; paid, cancelled final.
  export const DISPUTE_STATUSES = [
    'open',
    'responded',
    'won',
    'lost',
    'closed',
  ] as const; // "closed" = withdrawn by supporter, treated as won
  export function disputeStatusAfter(
    current: DisputeStatus,
    reported: DisputeStatus,
  ): DisputeStatus; // final states never move; never backwards
  export type ShareWhere =
    | { state: 'held'; heldMinor: bigint }
    | { state: 'moved'; inBalanceMinor: bigint }
    | { state: 'in_flight' };
  export function collectRefundPlan(i: {
    refundMinor: bigint;
    share: ShareWhere;
  }):
    | { kind: 'cancel_held' }
    | { kind: 'take_back'; backMinor: bigint }
    | { kind: 'staff_decides'; gapMinor: bigint }
    | { kind: 'wait' };
  export function disputeRecovery(i: {
    disputedMinor: bigint;
    netMinor: bigint;
    share: ShareWhere;
  }):
    | { fromHeldMinor: bigint; backMinor: bigint; absorbedMinor: bigint }
    | { wait: true };
  ```
- Rules: the recipient never gives back more than `netMinor` for the tip (14 Nov). `take_back` needs `inBalanceMinor ≥ refundMinor`, otherwise `staff_decides` with `gapMinor = refundMinor − inBalanceMinor` (§6.1 case 3). `in_flight` always gives `wait` (Review Focus 3).

- [ ] **Step 1: Write the failing tests:**
  - `a collect transfer never leaves paid or cancelled, and sent never goes straight to cancelled`.
  - `dispute status is out-of-order safe`: `open` after `lost` stays `lost`; `responded` after `open` gives `responded`; `won` after `lost` stays `lost`.
  - `a refund cancels a held share, takes back a moved one, and stops for staff when it was withdrawn`. Use net 950000 in three ways: held → `cancel_held`; moved with 950000 in balance → `take_back 950000`; moved with 200000 → `staff_decides gap 750000`.
  - `a lost dispute recovers from what is held first, then what is still in their balance, then TipMe`. Use gross 1000000 and net 950000: held → {950000, 0, 50000}; moved with 400000 → {0, 400000, 600000}; moved with 0 → {0, 0, 1000000}.
  - `a refund or dispute on an in-flight transfer waits`.
- [ ] **Step 2: Run** the domain tests. Expected: FAIL.
- [ ] **Step 3: Implement** in `collect.ts`. The transitions go in `state-machines.ts` beside the others, used with `canTransition`.
- [ ] **Step 4: Run** the domain tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 2.** `feat(domain): You collect transfer and dispute state, refund and dispute recovery`.

---

### Task 3: Schema, inert switch, settings reader, ADR-0016 (PR 3)

**Files:**

- Modify: `packages/database/src/schema.ts`, `packages/database/src/operations/ledger.ts` (`KIND`, `operationType` union), `packages/contracts/src/switches.ts`, `packages/contracts/src/ops.ts` (`ISSUE_KINDS`), `packages/contracts/src/index.ts`
- Create: `packages/database/drizzle/<next>_you_collect.sql` (generated, then hand-appended triggers and checks as `0118` does), `packages/database/src/operations/collect-settings.ts`, `docs/adr/ADR-0016-you-collect-for-new-recipients.md`
- Test: `tests/integration/collect-schema.test.mjs`, `packages/contracts/test/switches.test.mjs` (extend)

**Interfaces:**

- Schema:
  - `profiles.collection_mode text NULL CHECK IN ('direct','collect')`.
  - `tip_quotes.collection_mode text NOT NULL DEFAULT 'direct' CHECK IN ('direct','collect')`.
  - `collect_transfers` (`id`, `kind` `'share'|'back'`, `tip_id`, `profile_id`, `business_id NULL`, `refund_id NULL`, `dispute_id NULL`, `account_reference`, `provider`, `environment`, `amount_minor`, `currency`, `status`, `idempotency_key UNIQUE`, `transfer_reference NULL`, `charge_reference NULL`, `release_after timestamptz NULL`, `attempts int`, `next_try_at`, `sent_at`, `paid_at`, timestamps). Partial unique index on `(tip_id) WHERE kind='share'`. Checks: `kind='back'` needs exactly one of refund or dispute; status is in `COLLECT_TRANSFER_STATUSES`.
  - `disputes` (`id`, `provider`, `partner_dispute_id UNIQUE`, `tip_id`, `amount_minor`, `currency`, `reason text NULL` (a partner code only), `status`, `respond_by`, `evidence_state` `'none'|'draft'|'submitted'`, `fee_minor NULL`, `fee_currency NULL`, `set_aside_minor NULL`, `held_minor bigint NOT NULL DEFAULT 0` (R4), `last_event_at`, timestamps).
  - `collect_settings`: append-only like `plan_fee_rates`, one row per change. Columns `cap_minor`, `cap_days`, `reminder_days int[]`, `delay_hours`, `delay_for_days`, `first_withdrawal_cap_minor`, `new_daily_limit_minor`, `new_daily_limit_days`, `reserve_warning_minor`, `reserve_critical_minor`, `paused bool`, `effective_from`, `set_by`, `approved_by`, `reason`. Bounds checks from §9. The triggers `tipme_forbid_mutation` and `tipme_forbid_truncate`.
  - `operation_type` adds `'collect_transfer'` and `'dispute_fee'`.
  - `ledger_accounts_business_payable` becomes `(code <> 'business_payable' OR business_id IS NOT NULL) AND (business_id IS NULL OR code IN ('business_payable','held_for_recipients'))` (R3).
  - `issues_kind` adds `collect_transfer_stuck`, `collect_transfer_review`, `collect_in_debt`, `collect_invariant_broken`, `collect_reserve_low`, `collect_auto_payout_on`, `collect_recon_mismatch`, `collect_same_bank`, `dispute_opened`, `dispute_deadline`, `dispute_fee_unposted`, `collect_refund_gap`.
  - `notifications_kind` adds `collect_reminder`, `collect_verified`, `dispute_hold`.
- `KIND`: `held_for_recipients: 'asset'`; the three new `*_expense` codes are `'expense'`.
- Switch: `you_collect: { label: 'You collect for new recipients', description: 'New sign-ups take tips through TipMe and add bank details when they first withdraw. Off, nobody new is put on it; recipients already on it keep it.', money: true, default: false, env: onOff('YOU_COLLECT'), notBuilt: true }`.
- `collectSettingsInForce(db): Promise<CollectSettings>` returns the latest row in force, or the coded defaults `COLLECT_DEFAULTS`: cap ₦50,000 (5_000_000n), 30 days, reminders [7,21,28], 24 h for 7 days, first withdrawal ₦50,000, ₦200,000 per day for 30 days, warning ₦500,000, critical ₦250,000, `paused: false`. Exported from `@tipme/database`.

- [ ] **Step 1: Write the failing tests:**
  - `you_collect is a money switch, off, and cannot be turned on yet` (contracts: `money === true`, `default === false`, `notBuilt === true`; integration: `setFeatureSwitch` answers `SWITCH_NOT_BUILT`).
  - `collect schema refuses what the model forbids`: a second `share` row for one tip; a `back` row with both or neither of refund and dispute; a `business_id` on `recipient_payable`; an update or delete on `collect_settings`; `cap_days = 5`.
  - `held_for_recipients may belong to a person or a business and posts through postLedgerTransaction`.
  - `collect settings fall back to the spec's defaults with no row`.
  - `an existing quote reads collection_mode direct`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Edit `schema.ts`, run `pnpm --filter @tipme/database generate`, append the triggers and the check rewrites by hand under `--> statement-breakpoint`, and add `collect-settings.ts`. The ADR is **PROPOSED**. It records the two modes, §3 money flow, §4 invariant and R1–R12, amends ADR-0004 decision 8 and option 3, and states that D-04 and D-06 stay OPEN and that the switch is off until the owner accepts.
- [ ] **Step 4: Run** the migration check, the contracts tests and `collect-schema.test.mjs`. Expected: `# fail 0`, no schema diff.
- [ ] **Step 5: Commit and open PR 3.** `feat(db): You collect schema, inert you_collect switch, ADR-0016 (proposed)`. The PR body says D-04 and D-06 are untouched.

---

### Task 4: Adapter: collect money calls, fixtures, mock (PR 4)

**Files:**

- Modify: `packages/payments/src/provider.ts`, `packages/payments/src/bachs/provider.ts`, `packages/payments/src/bachs/payouts.ts`, `packages/payments/src/mock/mock-provider.ts`, `packages/payments/src/mock/scenario.ts`, `packages/payments/src/index.ts`
- Create: `packages/payments/test/fixtures/collect/*.json` (recorded sandbox bodies: checkout created, payment read, individual account created, destination usable, transfer 201 paid, transfer list, balances with USD and NGN, balance settings), `packages/payments/test/bachs-collect.test.mjs`
- Test: `packages/payments/test/integration/mock-provider.test.mjs` (extend)

**Interfaces:**

- Produces (on `PaymentProvider` / `PayoutPort`, optional like their siblings):
  ```ts
  initializeCollectCheckout?(i: { attemptId: string; amountMinor: bigint; currency: 'NGN'; successUrl: string; cancelUrl: string; idempotencyKey: string }):
    Promise<{ providerReference: `platform:${string}`; checkoutUrl: string; expiresAt: Date }>;
  createReceiveOnlyPersonAccount?(i: { contactEmail: string; country: 'NG'; legalName: { first: string; last: string }; idempotencyKey: string }): Promise<BachsRecipientAccount>;
  sendCollectTransfer?(i: { accountRef: string; amountMinor: bigint; currency: 'NGN'; idempotencyKey: string }): Promise<{ transferRef: string; status: 'paid'|'pending' }>;
  listAccountTransfers?(accountRef: string): Promise<{ transferRef: string; status: 'paid'|'pending'; amountMinor: bigint; currency: string; group: string | null }[]>;
  platformBalances?(): Promise<{ currency: string; availableMinor: bigint; pendingMinor: bigint }[]>; // signed: never clamps
  platformPayoutSchedule?(): Promise<Record<string, string>>; // currency → interval
  export class CollectTransferRefusedError extends Error { reason: 'insufficient'|'capability'|'in_debt'|'not_found'|'other'; providerCode?: string }
  ```
- `initializeCollectCheckout` sends the same body as `initializePlatformCheckout`, with `reference: attemptId`, `payment_method_types: ['NGN_CARD','NGN_BANK_TRANSFER']`, `customer_bears_fee: false`, no `X-Account-Id`, no `platform_fee` and no `save_payment_method`.
- `sendCollectTransfer` uses `POST /v1/transfers` as the platform with `transfer_group` = key and `description: 'TipMe tip'`, through `moneyWrite` with `COLLECT_TRANSFER_REFUSALS` (R9). A destination or amount mismatch raises `UncertainProviderOutcomeError` (`unexpected`).
- `listAccountTransfers` uses the `findPlatformCollection` request. A full page (≥ 100) throws `UncertainProviderOutcomeError`.
- `verifyTransaction('platform:…')` for a collect checkout returns `chargeReference` and `method`, and needs **no** platform-fee expectation.
- Mock scenarios added to `SCENARIOS`: `collect-insufficient`, `collect-forbidden`, `collect-in-debt`, `collect-not-found`, `collect-mismatch`, `collect-no-reply`, `destination-pending-review`, `destination-rejected`, `balance-usd-negative`, `auto-payout-on`. Mock methods: `markCollectAnswer(key, scenario)` (used once) and `markPlatformBalances(rows)`.

- [ ] **Step 1: Write the failing tests** in `bachs-collect.test.mjs`. All of them fake `fetchImpl`; assert no URL host other than `sandbox-api.bachs.io` is formed and that nothing is fetched for real.
  - `a collect checkout is on TipMe's own account with the attempt as reference and naira methods only`. Assert no `X-Account-Id`, no `platform_fee`, `reference === attemptId`, and that `providerReference` starts with `platform:`.
  - `a direct checkout request is byte-for-byte unchanged`. Snapshot `initializePayment`'s method, path, headers (minus the signature) and JSON body against a fixture recorded from today's code.
  - `a person's receive-only account requests only payouts and transfers` (entity `individual`, legal name in the fields R8 names, `dashboard_features.refunds: false`).
  - `a collect transfer names the account, the key as group, and the exact amount`.
  - `collect transfer refusals are told apart`. For each of `INSUFFICIENT_BALANCE`, `FORBIDDEN`, `ORGANIZATION_IN_DEBT` and `NOT_FOUND` (status 400, 403 or 404 as recorded), assert `CollectTransferRefusedError.reason`. A 5xx or timeout gives `UncertainProviderOutcomeError`.
  - `option B's transfer refusals are unchanged` (existing `INSUFFICIENT_BALANCE → PlatformRefusalError('reserve_empty')`).
  - `the same key within 24 hours replays the same transfer` (the 201 then the replay fixture, same id).
  - `platform balances are signed and list every currency` (USD `-15.00` → `-1500n`).
  - `the platform payout schedule is read without an account header`.
  - Mock (integration): `the pretend partner answers each collect scenario once, then pays`.
- [ ] **Step 2: Run** the payments tests. Expected: FAIL.
- [ ] **Step 3: Implement** the adapter methods and the mock counterparts. The mock keeps per-key answers in Redis like `markAmount`, and its transfer list honours `transfer_group`.
- [ ] **Step 4: Run** the payments tests and `pnpm test:integration -- tests/integration/no-real-provider…` (existing). Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 4.** `feat(payments): You collect checkout, person receive-only account, collect transfers, signed balances`. The PR lists each fixture's source (sandbox date, or a doc URL for live-only shapes: `pending_review` and `rejected` names, 403 `FORBIDDEN`).

---

### Task 5: Adapter: dispute events and API, mock disputes (PR 5)

**Files:**

- Modify: `packages/payments/src/provider.ts` (`NormalizedProviderEvent`), `packages/payments/src/bachs/webhooks.ts`, `packages/payments/src/bachs/provider.ts`, `packages/payments/src/mock/mock-provider.ts`, `packages/contracts/src/webhooks.ts` (`mockWebhookTypes` + data fields)
- Test: `packages/payments/test/bachs-disputes.test.mjs`, `packages/payments/test/fixtures/collect/dispute-*.json`

**Interfaces:**

- Produces:
  ```ts
  | { kind: 'dispute'; eventId: string; eventType: 'dispute.created' | 'dispute.updated'; scope: 'platform';
      partnerDisputeId: string; chargeReference: string | null; providerReference: string | null; operationReference: string | null;
      status: 'open'|'responded'|'won'|'lost'|'closed'; amountMinor: bigint; currency: string; reason: string | null;
      respondBy: Date | null; feeMinor: bigint | null; feeCurrency: string | null; occurredAt: Date }
  export type DisputeEvent = Extract<NormalizedProviderEvent, { kind: 'dispute' }>;
  submitDisputeEvidence?(i: { partnerDisputeId: string; text: string; fileRefs: string[]; idempotencyKey: string }): Promise<{ state: 'submitted' }>;
  uploadDisputeFile?(i: { partnerDisputeId: string; bytes: Buffer; contentType: 'application/pdf'|'image/png'|'image/jpeg' }): Promise<{ fileRef: string }>;
  listDisputes?(since: Date): Promise<{ partnerDisputeId: string; status: DisputeStatus; amountMinor: bigint; currency: string; chargeReference: string | null }[]>;
  ```
- Only `dispute.created` or `dispute.updated` with **no** `account` (platform-scoped, R1) normalizes to `kind: 'dispute'`. A connected account's dispute keeps `kind: 'reversal'`, unchanged. `reason` is an allowlisted code (`/^[a-z_]{1,40}$/`), otherwise null; free text never leaves the adapter.
- Mock webhook types add `dispute.created`, `dispute.updated` and `capability.updated`, with optional `disputeId`, `status`, `respondBy`, `feeMinor`, `feeCurrency` and `accountReference`.

- [ ] **Step 1: Write the failing tests:**
  - `a platform dispute event carries amount, status, deadline and fee`.
  - `a connected account's dispute is still a reversal, unchanged` (deep-equal to today's output for the same body).
  - `a dispute event with a bad signature, a stale time, or an unreadable amount is refused`.
  - `free-text reasons never leave the adapter`.
  - `evidence is submitted once per key; a 5xx is uncertain`.
- [ ] **Step 2: Run** the payments tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Event and field names come from `/connect/disputes` (re-read at build, URL in the PR). Each fixture says whether it was recorded or built from the doc, because the sandbox may not raise disputes.
- [ ] **Step 4: Run** the payments and contracts tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 5.** `feat(payments): dispute events and dispute API for TipMe's own account`.

---

### Task 6: Collection mode, quote and checkout branch (PR 6)

**Files:**

- Create: `packages/database/src/operations/collection-mode.ts`
- Modify: `packages/database/src/operations/quotes.ts` (`createQuote`, `findQuoteCharge`), sign-up profile creation (`profiles.ts` `createProfile` or its caller: `grep -rn "insert(profiles)" packages/database/src`), `apps/api/src/checkout/checkout.service.ts`, `packages/contracts/src/checkout.ts` (`TipQuote.collectedByTipMe?: true`), `packages/contracts/src/errors.ts` (`PAGE_PAUSED`)
- Test: `tests/integration/collect-checkout.test.mjs`, `apps/api/test/checkout-collect.test.mjs` (unit, with the provider stubbed)

**Interfaces:**

- Consumes: `initializeCollectCheckout` (Task 4), `collectSettingsInForce` (Task 3).
- Produces:
  ```ts
  export type CollectionMode = 'direct' | 'collect';
  export async function decideCollectionMode(
    tx: Tx,
    i: {
      profileId: string;
      switchOn: boolean;
      provider: string;
      environment: string;
    },
  ): Promise<CollectionMode>; // R7; writes once
  export async function collectionModeOf(
    db: Database | Tx,
    profileId: string,
  ): Promise<CollectionMode>; // null → 'direct', no write
  ```
- `createQuote` gains `youCollectOn: boolean`. With it on, it calls `decideCollectionMode`; with it off, it uses `collectionModeOf`. The quote stores `collection_mode`. `findQuoteCharge` returns `collectionMode`.
- `createIntent` with `quote.collectionMode === 'collect'` skips `getReadyPaymentAccount` (no `PAYMENT_ACCOUNT_REQUIRED`), claims the attempt and calls `initializeCollectCheckout` with key `tipme-checkout-<attemptId>`. It uses the same error classification and `markAttemptInitiated` flow as direct. The mock provider gets a collect branch that marks the reference `platform:mock_<attemptId>`.
- The paused-page refusal (`409 PAGE_PAUSED`) is wired in Task 12. Here, only the error code exists.

- [ ] **Step 1: Write the failing tests:**
  - `switch off: every quote and checkout is today's, byte for byte` (records the mock and Bachs-stub calls, and compares them to a run on `dev`'s behaviour captured as a fixture).
  - `switch on: a new sign-up is collect and can be tipped with no payment account`.
  - `switch on: an existing recipient with an active account stays direct; one without becomes collect once` (a second quote doesn't rewrite it; turning the switch off afterwards keeps `collect`).
  - `the mode on the quote is honoured after the person's mode changes` (quote as `collect`, set the profile to `direct`, create the intent: it still uses the collect checkout).
  - `a collect checkout start that times out stays unknown and is never retried blindly`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. `featureOn(db, 'you_collect')` is read once per quote. The sign-up path writes `collect` when the switch is on.
- [ ] **Step 4: Run** the integration subset, `checkout-api.test.mjs` and `bachs-checkout-start.test.mjs` (unchanged). Then regenerate OpenAPI and docs. Expected: `# fail 0`, `--check` clean.
- [ ] **Step 5: Commit and open PR 6.** `feat(checkout): collection mode per recipient, fixed on the quote; collect checkout on TipMe's account`.

---

### Task 7: Confirming a collect payment (PR 7)

**Files:**

- Modify: `apps/api/src/webhooks/webhook.service.ts` (`applyBachs` routing, R2), `apps/api/src/webhooks/mock-webhook.controller.ts`, `packages/database/src/operations/provider-events.ts` (posting branch), `packages/database/src/operations/reconcile.ts` (`findAttemptsToReconcile` expectation), `packages/database/src/operations/share-transfers.ts` (kind `collect_sweep`), `apps/worker/src/share-transfer-kinds.ts`
- Create: `packages/database/src/operations/collect-transfers.ts` (only `scheduleCollectTransfer` here)
- Test: `tests/integration/collect-payment.test.mjs`

**Interfaces:**

- Produces:
  ```ts
  export async function scheduleCollectTransfer(
    tx: Tx,
    i: {
      tipId: string;
      profileId: string;
      amountMinor: bigint;
      currency: string;
      provider: string;
      chargeReference: string | null;
      settledAt: Date;
    },
  ): Promise<void>; // one 'share' row, status 'waiting', key tipme-collect-<tipId>, release_after per settings
  export async function matchCollectAttempt(
    db: Database,
    i: {
      providerReference: string | null;
      operationReference: string | null;
      chargeReference: string | null;
    },
  ): Promise<string | null>;
  export const collectKey = (tipId: string) => `tipme-collect-${tipId}`;
  ```
- `release_after` = `settledAt + delay_hours` when the profile was created less than `delay_for_days` ago, otherwise `settledAt` (§8).
- In `recordProviderEvent` `payment.succeeded`: when `quote.collectionMode === 'collect'`, post `buildCollectPaymentPosting` (same operation key `payment.<attemptId>`), call `scheduleCollectTransfer`, and with a share, schedule a `collect_sweep` share transfer (R3) **instead of** `scheduleShareSweep`. Everything is in the same transaction.
- `findAttemptsToReconcile`: a collect attempt's `expectation` is `undefined`. `verifyTransaction` for a platform reference never needs a fee expectation (Task 4).

- [ ] **Step 1: Write the failing tests:**
  - `a collect tip's verified payment books the held posting and one waiting transfer, once` (a duplicate webhook, a reconcile replay and two concurrent deliveries give one ledger transaction and one row).
  - **Review Focus 1:** `a platform-scoped event for a collect tip never reaches Pro billing, and a Pro event never reaches a tip`.
  - `a direct tip's payment is booked exactly as before` (ledger lines deep-equal to today's golden).
  - `a misreported amount on a collect tip is never booked` (mismatch path, `UNKNOWN`).
  - `a collect tip with a business share holds the share for the business and schedules only the leg into the business`.
  - `a new recipient's transfer waits 24 hours; after 7 days it is released at settlement` (with `now` set).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** In `applyBachs`, for `scope === 'platform'`, call `matchCollectAttempt` first. A match goes into the tip path (`recordProviderEvent`, then `reconcileAttempts` for that attempt). Otherwise the event goes to `applyProEvent`, as today. Store `chargeReference` from the read-back on the `share` row.
- [ ] **Step 4: Run** the subset, `pro-webhooks.test.mjs`, `bachs-payment-webhooks.test.mjs` and `business-payouts-api.test.mjs` (unchanged). Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 7.** `feat(payments): book collect tips as held money and schedule their transfer`.

---

### Task 8: Collect transfer machine and worker (PR 8)

**Files:**

- Modify: `packages/database/src/operations/collect-transfers.ts`, `apps/worker/src/job-worker.ts`, `apps/api/src/webhooks/webhook.service.ts` (`refreshBachsAccount` → `releaseWaitingTransfers`)
- Create: `apps/worker/src/handlers/collect-transfers.ts`, `docs/runbooks/payment-stuck-unknown.md` (new section "Collect transfer stuck")
- Test: `tests/integration/collect-transfers.test.mjs`, `apps/worker/test/collect-transfers-handler.test.mjs`

**Interfaces:**

- Consumes: `sendCollectTransfer`, `listAccountTransfers`, `CollectTransferRefusedError` (Task 4); `COLLECT_TRANSFER_TRANSITIONS` (Task 2); `buildCollectTransferPosting` (Task 1).
- Produces:
  ```ts
  export interface CollectTransferProvider { name: string; sendCollectTransfer: …; listAccountTransfers: …; payoutCapability(accountRef: string): Promise<{ status: 'active'|'restricted'|'missing' }> }
  export async function releaseWaitingTransfers(db: Database, i: { profileId?: string; now: Date }): Promise<number>; // waiting→ready when transfers active, destination usable, release_after passed, not under review
  export async function runCollectTransfers(db: Database, i: { provider: CollectTransferProvider; now: Date; limit?: number; perRecipientPerRun?: number }):
    Promise<{ sent: number; paid: number; retried: number; review: number; stopped?: 'paused' | 'in_debt' }>;
  ```
- Timings: `READ_BACK_AFTER_MS = 2 min` and `SAME_KEY_WITHIN_MS = 24 h`. Backoff on `insufficient` is 5 min, doubling, at most 6 h. `collect_transfer_stuck` opens when a `ready` row is more than 1 h old. `perRecipientPerRun` defaults to 5, oldest tip first (`created_at` of the tip). The sweep runs every 2 min (`COLLECT_TRANSFERS_JOB`, a run lock like the reserve check's).
- Outcomes: `paid` posts `buildCollectTransferPosting` (`collect_transfer.<rowId>`) in the same transaction as the status change. `insufficient → ready` with backoff. `capability → waiting`. `in_debt` stops the whole run and opens **one** `collect_in_debt` issue (dedupe key `collect_in_debt`), which stops later runs until it is resolved (R11). `not_found`, a mismatched amount or another refusal → `review` with a `collect_transfer_review` issue. Uncertain → `unknown`, then the same key within 24 h. After that, `listAccountTransfers` matched on `transfer_group`: found with the right amount gives `paid`, not found gives `ready`, anything else gives `review`.

- [ ] **Step 1: Write the failing tests** (mock provider and a fake `CollectTransferProvider`):
  - `exactly one transfer per tip under eight concurrent workers` (`Promise.all` of 8 runs; one send, one posting).
  - `a crash after the claim is read back by transfer group: found means paid, not found means sent again with the same key`.
  - `a lost answer is retried with the same key inside 24 hours, and never after`.
  - `insufficient balance waits and retries; an hour waiting raises one stuck issue`.
  - `a lost capability sends the share back to waiting, and capability.updated releases it` (including an older `capability.updated` delivered after a newer one: the account read decides, not the event order).
  - **Review Focus 5:** `in-debt stops every collect transfer with one issue`.
  - `not found or a different amount goes to review with a money issue and no posting`.
  - `a recipient's backlog moves oldest first, five per run`.
  - `paused settings stop the run; resuming continues from where it stopped`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** on the pattern of `share-transfers.ts` (a conditional update per state change, the claim committed before the call, `definitelyNotMoved`). Register the job in `job-worker.ts` (always scheduled; it does nothing with no rows). Write the runbook section: what `unknown`, `review` and `collect_in_debt` mean, what to read, what never to do (send a new transfer by hand).
- [ ] **Step 4: Run** the integration subset and the worker tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 8.** `feat(worker): You collect transfers: exactly once, read back by group, freeze on debt`.

---

### Task 9: Disputes in TipMe (PR 9)

**Files:**

- Create: `packages/database/src/operations/disputes.ts`
- Modify: `apps/api/src/webhooks/webhook.service.ts` (route `kind: 'dispute'`), `packages/database/src/operations/balance.ts` (`reserved += open disputes' held_minor`, R4), `packages/database/src/operations/collect-transfers.ts` (`kind: 'back'` rows use the same machine with `collectToPlatform`), `packages/database/src/operations/notifications.ts` and mail templates (`dispute_hold`)
- Test: `tests/integration/collect-disputes.test.mjs`, `tests/integration/webhooks.test.mjs` (extend)

**Interfaces:**

- Consumes: Task 5's event; `disputeStatusAfter` and `disputeRecovery` (Task 2); `buildDisputeFeePosting` and `buildDisputeLossPosting` (Task 1).
- Produces:
  ```ts
  export async function applyDisputeEvent(
    db: Database,
    i: { event: DisputeEvent; provider: string; now: Date },
  ): Promise<{
    outcome:
      | 'opened'
      | 'updated'
      | 'won'
      | 'lost'
      | 'duplicate'
      | 'unmatched'
      | 'stale';
  }>;
  export async function settleLostDispute(
    db: Database,
    i: { disputeId: string; now: Date },
  ): Promise<'posted' | 'waiting_back' | 'done'>;
  ```
- On open: upsert by `partner_dispute_id`, post the fee (`dispute_fee.<disputeId>`, in `feeCurrency`; none reported gives a `dispute_fee_unposted` issue, R6), and open a `dispute_opened` issue with `respond_by`. If the share is `waiting` or `ready`, move it to `review` (not `cancelled`), so a win can release it. If the share is `paid`, set `held_minor` = min(net, the recipient's available) and notify "A payment to you is being questioned. We've held {amount} until it's settled." If the share is `sent` or `unknown`, take no money step until it resolves (Review Focus 3).
- Won or closed: `held_minor = 0`, the share goes `review → ready`, the fee stays.
- Lost: `disputeRecovery`. `fromHeld` cancels the share. `back` creates a `back` row (`tipme-collect-back-<disputeId>`) and waits for it to be `paid`. Then `buildDisputeLossPosting` (`reversal` reversing `payment.<attemptId>`), and `held_minor = 0`.
- A deadline reminder issue (`dispute_deadline`) opens 48 h before `respond_by` from the transfer sweep.

- [ ] **Step 1: Write the failing tests:**
  - `created then won: the fee stays an expense and the hold is released`.
  - `created then lost: full recovery from the held share` (posting: Dr payable 950000, Cr held 950000, Dr loss 50000, Cr platform 50000).
  - `created then lost: partial recovery by transfer back, TipMe absorbs the rest`.
  - `created then lost: nothing to recover, TipMe absorbs all of it`.
  - `duplicate and out-of-order dispute events change nothing twice` (lost delivered before created; created replayed).
  - `a dispute fee taking a balance negative is booked and raises the critical alert` (with Task 11's check when it lands; here, assert the posting and the `dispute_fee` row).
  - `dispute webhooks are authenticated, stored and deduplicated`.
  - **Review Focus 3:** `a dispute opened on a sent transfer resolves after read-back`.
  - `the held amount comes off what they can withdraw, and nothing else` (`balanceIn` minus `held_minor`; other tips still withdrawable).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. Notifications use the existing outbox and mail queue.
- [ ] **Step 4: Run** the subset, `bachs-reversals.test.mjs` and `pro-webhooks.test.mjs` (unchanged). Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 9.** `feat(payments): disputes on collect tips: fee, hold, recovery from unpaid balance first`.

---

### Task 10: Refunds on collect tips (PR 10)

**Files:**

- Modify: `packages/database/src/operations/tip-refunds.ts` (`tipRefundFacts`, `askTipRefund`, `sendTipRefunds`, `applyTipRefundEvent`), `apps/api/src/ops/tip-refunds.controller.ts`, `apps/web/src/app/ops/…` (the existing Refund tip dialog: a staff-decides state), serious actions registry (`tip_refund.absorb_gap`)
- Test: `tests/integration/collect-refunds.test.mjs`, `tests/e2e/tip-refund.spec.ts` (extend)

**Interfaces:**

- Consumes: `refundPlatformCharge` (exists), `collectRefundPlan` (Task 2), `buildCollectRefundPosting` and `buildAbsorbedRefundPosting` (Task 1), `back` rows (Task 9's machine).
- Produces: `TipRefundFacts` gains `collect: { plan: 'cancel_held'|'take_back'|'staff_decides'|'wait'; gapMinor: bigint } | null`, and `TipRefundRefusal` gains `'in_flight'` (words: "This tip's share is moving to the recipient right now. Try again in a few minutes."). The refund amount is unchanged (`tipRefundParts`: the tip minus TipMe's fee).
- Flow by plan: `cancel_held` cancels the share, then `refundPlatformCharge` (key `tipme-tip-refund-<refundId>`, existing). `take_back` creates a `back` row, refunds only after it is `paid`, and posts `buildCollectRefundPosting` on `refund.paid`. `staff_decides` shows the gap. Going ahead is the serious action `tip_refund.absorb_gap` (a second person): the refund is sent, and on `refund.paid` the posting takes back the held or back part and the gap posts `buildAbsorbedRefundPosting`. `ProRefundRefusedError` ("Insufficient balance to refund") gives a failed refund, nothing moved, and staff see "TipMe's balance can't cover this refund right now." A bank-transfer tip is refused as today (`bank_transfer`).

- [ ] **Step 1: Write the failing tests:**
  - `a held share is cancelled and the refund comes from TipMe's balance`.
  - `a moved share still in their balance is taken back first, then refunded`.
  - `a withdrawn share stops for staff; going ahead needs a second person and books the gap as TipMe's`.
  - `a refund refused for low balance moves nothing and says why`.
  - `a bank-transfer collect tip is not refundable`.
  - **Review Focus 3:** `a refund during an in-flight transfer waits for the read-back and recovers exactly once`.
  - `a direct tip's refund is unchanged` (existing `tip-refund.test.mjs` passes untouched).
  - E2E (lane 5): `staff see the gap and the second-person step on a withdrawn collect tip`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the branch on `quote.collectionMode`. The direct path is untouched.
- [ ] **Step 4: Run** the subset and the e2e spec (`--repeat-each=5`). Regenerate OpenAPI. Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 10.** `feat(ops): refund collect tips from TipMe's balance, recovering the recipient's part first`. Screenshots of the dialog.

---

### Task 11: Reserve invariant and reconciliation (PR 11)

**Files:**

- Create: `packages/database/src/operations/collect-reserve.ts`, `packages/database/src/operations/collect-recon.ts`
- Modify: `apps/worker/src/job-worker.ts` (the reserve job also runs `checkCollectReserve`; a new daily job `collect.recon` at 02:00 Lagos), `packages/database/src/operations/payout-start.ts` and `share-transfers.ts` (`ownMoneyAllows` before `coverPayoutFee` and `fee_return`, R5), `packages/database/src/operations/collection-mode.ts` (sign-ups pause below zero), `docs/runbooks/payment-stuck-unknown.md` (the invariant and dashboard withdrawals)
- Test: `tests/integration/collect-reserve.test.mjs`, `tests/integration/collect-recon.test.mjs`

**Interfaces:**

- Produces:
  ```ts
  export async function heldTotal(db: Database, currency: string): Promise<bigint>; // Σ held_for_recipients debits − credits
  export async function checkCollectReserve(db: Database, i: { provider: { name: string; platformBalances(): …; platformPayoutSchedule(): … }; alert(text: string, level: 'warning'|'critical'): Promise<void>; emailOwners(text: string): Promise<void>; now: Date }):
    Promise<{ perCurrency: { currency: string; availableMinor: bigint; heldMinor: bigint; ownMinor: bigint; level: 'ok'|'warning'|'critical'|'broken' }[]; autoPayoutOn: boolean }>;
  export async function ownMoneyAllows(db: Database, i: { amountMinor: bigint; currency: string; voluntary: boolean }): Promise<boolean>; // last reading; false when own − amount < 0, or < critical for a voluntary move
  export async function collectSignupsPaused(db: Database): Promise<boolean>; // an open collect_invariant_broken issue
  export async function reconcileCollect(db: Database, i: { provider: …; day: Date }): Promise<{ checked: number; mismatches: number }>;
  ```
- Levels (§6.3), with thresholds from `collectSettingsInForce`: own < warning gives warning; < critical gives critical (page staff, email owners, voluntary moves refused); own < 0 (available < held) gives `broken`, a `collect_invariant_broken` issue, and You collect sign-ups pause: while that issue is open, `decideCollectionMode` never writes `collect` (an undecided profile stays null, so it behaves as `direct`). Recipients already on `collect` are untouched. Any currency with available < 0 is critical, naming the currency. A platform payout interval other than `manual` opens `collect_auto_payout_on` (critical). Readings are stored in `payment_reserve_readings` (one row per currency), with today's 6 h re-alert rule.
- Daily recon: for each collect recipient with activity in the last 3 days, `listAccountTransfers` against `collect_transfers` by `transfer_group`. Missing, extra (a `tipme-collect-` group with no row) or a different amount opens `collect_recon_mismatch`. `listDisputes(since)` against `disputes`. Each run's totals are logged. A per-tip "fully reconciled" view: verified payment, share `paid` or `cancelled` with its posting, and no open dispute.

- [ ] **Step 1: Write the failing tests:**
  - `TipMe's own money is the balance minus what is held, per currency`.
  - `below ₦500,000 warns, below ₦250,000 pages and emails owners, below held is broken and pauses collect sign-ups`.
  - **Review Focus 5:** `a negative USD balance pages staff even when NGN is above the line`.
  - `automatic payouts on TipMe's balance raise a critical alert`.
  - `a payout-fee cover or fee return that would break the rule is refused and waits` (the payout stays waiting, as `reserve_empty` does today).
  - `recon finds a missing, an extra and a different-amount transfer, and matches the rest`.
  - `recon matches partner disputes to ours and flags one we don't know`.
  - `two reserve checks at once send one alert`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `checkReserve`'s lock, claim and re-alert logic by extracting its claim section into a shared helper (no behaviour change to the existing NGN reserve test).
- [ ] **Step 4: Run** the subset, `payment-reserve.test.mjs` and `payment-reserve-handler.test.mjs` (unchanged). Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 11.** `feat(worker): You collect reserve invariant per currency, own-money alerts, daily reconciliation`.

---

### Task 12: Guards, holding cap, reminders, settings admin (PR 12)

**Files:**

- Create: `packages/database/src/operations/collect-guards.ts`, `apps/api/src/ops/collect-settings.controller.ts`, `packages/contracts/src/collect.ts` (settings DTOs, `CollectStatus`)
- Modify: `packages/database/src/operations/quotes.ts` (paused page), `packages/database/src/operations/balance.ts` (`onItsWayMinor`), `packages/database/src/operations/payouts.ts` (`createPayout` and `withdrawalsAvailable`: caps), the worker (reminders in the transfer sweep), the serious-actions registry (`collect_settings.change`, `collect_transfers.pause`, `collect_transfers.resume`), mail templates (`collect_reminder`)
- Test: `tests/integration/collect-guards.test.mjs`, `tests/integration/collect-settings-api.test.mjs`

**Interfaces:**

- Produces:
  ```ts
  export async function collectStatus(
    db: Database | Tx,
    profileId: string,
    now: Date,
  ): Promise<{
    mode: CollectionMode;
    verified: boolean;
    heldMinor: bigint;
    onItsWayMinor: bigint;
    firstWaitingAt: Date | null;
    paused: boolean;
    pausedReason: 'amount' | 'days' | null;
    pauseOn: Date | null;
    firstWithdrawalCapMinor: bigint | null;
    dailyLimitMinor: bigint | null;
  }>;
  export async function sendCollectReminders(
    db: Database,
    i: { now: Date },
  ): Promise<number>; // once per (profile, day) in reminder_days
  ```
- The paused page: `createQuote` on a `collect`, unverified profile with `heldMinor ≥ cap_minor`, or `now − firstWaitingAt ≥ cap_days`, throws `409 PAGE_PAUSED`. It is lifted at once on verification (Task 13 sets `verified`).
- Withdrawal guards apply to `collect` profiles only. The first withdrawal is ≤ `first_withdrawal_cap_minor` (`WITHDRAWAL_FIRST_CAP`, words: "New accounts can withdraw up to {amount} the first time."). While the profile is younger than `new_daily_limit_days`, the Σ counted withdrawals on the Lagos day are ≤ `new_daily_limit_minor` (`WITHDRAWAL_DAILY_LIMIT`; reuse `lagosDayStart`). The withdrawable amount excludes `held_for_recipients` (shown as "On its way to you").
- Reminders at the days in `reminder_days` after `firstWaitingAt`, while unverified and money is waiting: an in-app notification plus an email, deduped by `collect_reminder.<profileId>.<day>`. Day 28 uses the "by {date}" copy, with `{date} = firstWaitingAt + cap_days` in Lagos.
- Settings admin: `GET /v1/ops/collect-settings`, `POST /v1/ops/collect-settings` (serious action `collect_settings.change`; bounds from §9, critical < warning, each reminder day < cap days, first cap ≥ the minimum withdrawal; audit and an alert to owners as for `plan_fees`), and `POST /v1/ops/collect-transfers/pause|resume`.

- [ ] **Step 1: Write the failing tests:**
  - `the holding cap pauses the page at ₦50,000 held or after 30 days, whichever comes first`.
  - `adding verified bank details unpauses the page at once` (sets `verified` directly here).
  - `a supporter of a paused page is told only that the person can't take tips right now` (the error body has no reason field).
  - `reminders go once each at 7, 21 and 28 days, and stop once verified`.
  - `the first withdrawal is capped at ₦50,000`.
  - `the daily limit for new accounts counts the Lagos day` (₦150,000 at 23:30 Lagos plus ₦100,000 at 23:50 is refused; at 00:10 the next day, allowed).
  - `the daily limit ends after 30 days`.
  - `money on its way is shown and never withdrawable`.
  - `settings out of bounds, critical not below warning, or a reminder after the cap are refused; a change needs the serious action and alerts owners`.
  - `a direct recipient's withdrawals and page are unchanged`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** If a column is missing (for example `collect_reminders_sent`), add it in this PR's own migration (next number at merge time), or use notification dedupe keys instead.
- [ ] **Step 4: Run** the subset, `withdrawal-freeze.test.mjs` and `payout-destination-api.test.mjs` (unchanged). Regenerate OpenAPI. Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 12.** `feat(api): You collect guards: holding cap, reminders, first withdrawal and new-account limits, settings`.

---

### Task 13: Add bank details (API) (PR 13)

**Files:**

- Create: `apps/api/src/profiles/collect-bank.controller.ts`, `packages/database/src/operations/collect-verification.ts`
- Modify: `packages/database/src/operations/payout-destinations.ts` (name lock for `collect`), `packages/database/src/operations/payment-accounts.ts` (create or reuse the receive-only person account, R7), `apps/api/src/webhooks/webhook.service.ts` (`refreshBachsAccount` → `releaseWaitingTransfers`), `packages/contracts/src/collect.ts`
- Test: `tests/integration/collect-bank-api.test.mjs`

**Interfaces:**

- Consumes: `resolveBankAccount`, `addPayoutDestination` and `payoutDestinationStatus` (exist); `createReceiveOnlyPersonAccount` (Task 4); `releaseWaitingTransfers` (Task 8).
- Produces (the API, authenticated, own profile only, rate-limited like the payout-destination routes):
  - `POST /v1/me/collect/bank/lookup` `{ legalName: { first, last }, bankCode, accountNumber }` returns `{ bankName: string }` (the bank's name for the account), or `422 BANK_NAME_UNKNOWN`. Nothing is stored.
  - `POST /v1/me/collect/bank` `{ legalName, bankCode, accountNumber, confirmed: true }` returns `{ state: 'verified' | 'checking' | 'manual_review' }`, or `422 NAME_MISMATCH` (nothing saved). It creates or reuses the account, adds the destination, and maps `usable → verified`, `pending_review → manual_review`, `rejected → NAME_MISMATCH`.
  - `GET /v1/me/collect` returns `CollectStatus` (Task 12) plus `bank: { state, last4, bankName } | null`.
- Verified means a `usable` destination **and** the `transfers` capability is active. It sets `verified`, locks `legal_name` (after that, changes go only through the support serious action `collect_name.change`), lifts the pause and calls `releaseWaitingTransfers`.
- Same bank account: a `(bankCode, accountNumber)` hash already used by another profile opens `collect_same_bank`, and that profile's transfers go to `review` until staff clear it.

- [ ] **Step 1: Write the failing tests** (mock scenarios `destination-pending-review` and `destination-rejected`):
  - `names match: verified, held tips start moving oldest first, the page unpauses`.
  - `some words match: manual review, and a later usable status verifies` (via `capability.updated` and `payoutDestinationStatus`).
  - `no match: refused and nothing is saved`.
  - `the verified name is locked; changing it needs support`.
  - **Review Focus 2:** `a transfer waits while the destination is pending review, and a shared bank account sends the second recipient to review`.
  - `an existing never-verified recipient reuses their account row`.
  - `another person's profile, a direct recipient, or the switch off with mode null: 404`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** The account number is never logged; only `last4` and a keyed hash are stored (reuse the `secret-box` pattern for the hash key).
- [ ] **Step 4: Run** the subset. Regenerate OpenAPI and docs. Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 13.** `feat(api): add bank details for You collect: name check by our payment partner, name lock`.

---

### Task 14: Recipient and supporter UI (PR 14)

**Files:**

- Modify: `apps/web/src/app/dashboard/home-view.tsx` (the no-bank line, paused banner, dispute-hold notice), `apps/web/src/app/dashboard/earnings/…` (the balance note, "On its way to you"), `apps/web/src/app/dashboard/withdraw/withdraw-view.tsx` (the add-bank-details form and states, the first-withdrawal cap line), `apps/web/src/components/appreciation-form.tsx` (`PAGE_PAUSED`), `apps/web/src/app/tip/[tipId]/…` (the receipt line)
- Create: `apps/web/src/app/dashboard/withdraw/collect-bank-form.tsx`
- Test: `tests/e2e/you-collect.spec.ts`, `apps/web/test/collect-copy.test.mjs`

**Interfaces:**

- Consumes: `GET /v1/me/collect`, `POST /v1/me/collect/bank/lookup`, `POST /v1/me/collect/bank` (Task 13); `PAGE_PAUSED` (Task 12).
- The copy is §10 word for word (the unit test asserts each string from one `COLLECT_COPY` constant in `packages/contracts/src/collect.ts`).
- Form states: idle, lookup busy, name confirm ("Is this you? {BANK NAME}" with Confirm or Change), checking, manual check, mismatch (the inline error tied to the field by `aria-describedby`), verified, and a recoverable error. The receipt shows "Paid to TipMe for {Name}" only when the tip's quote is `collect` (the status API returns `collectedByTipMe`).

- [ ] **Step 1: Write the failing tests:**
  - Unit: `collect copy is the spec's, and never names the partner or says wallet, protected or insured` (a regex over every string).
  - E2E (lane 6, phone and desktop):
    - `a new collect recipient sees "You can take tips now…" and the kept-for-you note after a tip`.
    - `adding bank details: confirm the name, see checking, then all set` (mock usable).
    - `a name mismatch says so and keeps nothing`.
    - `manual review shows the by-hand message`.
    - `a paused page tells the supporter only that they can't take tips right now`.
    - `the receipt says Paid to TipMe for the person on a collect tip, and is unchanged on a direct tip`.
    - `the add-bank-details form works by keyboard alone and passes axe`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** with existing design tokens and form components (`docs/design/DESIGN-CONSTITUTION.md`). No new client dependency. Live updates: routes under `/v1/me/**` answer `/v1/me/events` with 204 in tests.
- [ ] **Step 4: Run** the e2e spec with `--repeat-each=5 --retries=0` and the web unit tests. Expected: 0 failed.
- [ ] **Step 5: Commit and open PR 14.** `feat(web): You collect for recipients and supporters`. Phone and desktop screenshots of each state.

---

### Task 15: Staff screens (PR 15)

**Files:**

- Create: `apps/web/src/app/ops/collect/{page.tsx,held/page.tsx,transfers/page.tsx,disputes/page.tsx,disputes/[id]/page.tsx,reserve/page.tsx,unclaimed/page.tsx,settings/page.tsx}`, `apps/api/src/ops/collect.controller.ts`, `packages/database/src/operations/collect-ops.ts`
- Modify: `apps/web/src/app/ops/users/…` (the read-only "Collection mode: You collect | Account collects"), the ops nav, `packages/contracts/src/collect.ts` (ops DTOs)
- Test: `tests/integration/collect-ops-api.test.mjs`, `tests/e2e/ops-collect.spec.ts`

**Interfaces:**

- Consumes: Tasks 8–12 (rows, `runCollectTransfers`, `submitDisputeEvidence`, `uploadDisputeFile`, `checkCollectReserve` readings, `collectSettingsInForce`).
- Produces: `GET /v1/ops/collect/held` (total and per recipient: amount, oldest tip, days left, reminders sent, paused), `GET /v1/ops/collect/transfers?status=`, `POST /v1/ops/collect/transfers/:id/retry` (only from `review` → `ready`, a serious action) and `POST …/:id/review`, `GET /v1/ops/collect/disputes`, `GET /v1/ops/collect/disputes/:id`, `POST …/:id/evidence` (text plus up to 5 files, PDF, PNG or JPEG ≤ 5 MB each, a serious action, refused after `respond_by`), `GET /v1/ops/collect/reserve`, `GET /v1/ops/collect/unclaimed` (past the cap, no automatic action). The permissions are new `collect.view` and `collect.manage` (from `roles.ts`). Masking follows today's ops rules: handle and last4 only, never the full account number or the supporter's details.

- [ ] **Step 1: Write the failing tests:**
  - `staff without collect.view get 403; masking hides account numbers and supporter details`.
  - `retry is allowed only from review and needs a second person`.
  - `evidence is refused after the deadline and submitted once`.
  - `held money totals match the ledger`.
  - E2E (lane 7): `staff see held money, a transfer in review, a dispute with its deadline, and the reserve per currency`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** on the patterns of the existing ops list pages (`ops/issues`, `ops/plan-fees`).
- [ ] **Step 4: Run** the subset and the e2e spec (`--repeat-each=5`). Regenerate OpenAPI and docs. Expected: 0 failed.
- [ ] **Step 5: Commit and open PR 15.** `feat(ops): You collect staff screens: held money, transfers, disputes, reserve, unclaimed, settings`. Screenshots.

---

### Task 16: Switch usable, end-to-end journey, sandbox script, docs (PR 16)

**Files:**

- Modify: `packages/contracts/src/switches.ts` (remove `notBuilt` from `you_collect`; it stays `default: false`), `docs/runbooks/settings-and-switches.md` (what turning it on and off does, §12.4 and §12.5), `docs/runbooks/live-activation.md` (preconditions: ADR-0016 accepted, P1 in writing, own money above the warning level, auto payouts off)
- Create: `scripts/you-collect-sandbox.mjs` (manual, `--sandbox`, refuses any origin other than `https://sandbox-api.bachs.io` and any key other than `sk_sandbox_`, as `scripts/pro-sandbox-check.mjs` does), `tests/integration/you-collect-journey.test.mjs`, `tests/e2e/you-collect-journey.spec.ts`

**Interfaces:**

- Consumes: everything above.
- The sandbox script runs, with test money: create a person receive-only account → open a collect checkout (printed for a person to pay with the partner's test card) → read the payment → `sendCollectTransfer` → replay with the same key → `listAccountTransfers` → `platformBalances` → `platformPayoutSchedule`. It prints ids and statuses only, never the key. It is never run by CI. The PR body records one run's output and states what the sandbox **cannot** prove (§12.3: capability timing, name check, manual review, live settlement, dispute fees).

- [ ] **Step 1: Write the failing tests:**
  - `staff can turn you_collect on with a second person, and it starts off`.
  - `switch off means today's behaviour everywhere` (every direct-path test suite from Tasks 6–13 rerun with the switch off: one test file importing those cases).
  - **Review Focus 4:** `switching off keeps existing collect recipients tipping and transferring`.
  - Journey (integration, mock): `sign up → tip → held → reminder day 7 → add bank details → transfer paid → withdraw within the first cap → refund of a later tip taken back → dispute lost with partial recovery`. After each step, assert ledger balanced per currency and `Σ held = what the mock's platform balance holds for recipients`.
  - E2E (lane 8): `a new recipient takes a tip before verifying and withdraws after adding bank details`.
- [ ] **Step 2: Run** them. Expected: FAIL (`SWITCH_NOT_BUILT`).
- [ ] **Step 3: Implement.** Remove `notBuilt` and write the runbooks and the script.
- [ ] **Step 4: Run** the whole gate, `pnpm test:integration` and both new specs (`--repeat-each=5 --retries=0`). Expected: exit 0, 0 failed.
- [ ] **Step 5: Commit and open PR 16.** `feat: You collect can be switched on by the owner (off everywhere at merge)`. The body says production stays off until the owner turns it on, after ADR-0016 is accepted and P1 is answered in writing.

---

## Spec coverage check

| Spec                                                                   | Task                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1 recipient steps, reminders, cap, name lock                        | 12, 13, 14                                                                                                                              |
| §2.2 supporter (receipt, paused page)                                  | 12, 14                                                                                                                                  |
| §3 money flow, fees unchanged                                          | 1, 6, 7                                                                                                                                 |
| §4 ledger, invariant, auto payouts off                                 | 1, 3, 11                                                                                                                                |
| §5 transfer at settlement                                              | 7, 8                                                                                                                                    |
| §6.1 refunds                                                           | 2, 10                                                                                                                                   |
| §6.2 disputes                                                          | 2, 5, 9, 15                                                                                                                             |
| §6.3 reserve and freeze                                                | 8 (in debt), 11                                                                                                                         |
| §7 reconciliation, runbook                                             | 8, 11                                                                                                                                   |
| §8 fraud guards                                                        | 7 (delay), 12, 13                                                                                                                       |
| §9 settings and staff screens                                          | 3, 12, 15                                                                                                                               |
| §10 copy                                                               | 14                                                                                                                                      |
| §11 coexistence, receive-only person account, option B single leg, ADR | 3, 4, 6, 7, 13                                                                                                                          |
| §12 rollout, switch                                                    | 3, 16                                                                                                                                   |
| §13 tests                                                              | each task's Step 1                                                                                                                      |
| §14 non-goals                                                          | not built: no migration of direct recipients, no automatic unclaimed refunds, no recovery from future tips, no fee, VAT or Terms change |
