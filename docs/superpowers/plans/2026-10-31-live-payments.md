# Live Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real tips and real payouts through Bachs live: a `bachs-live` provider mode, withdrawals paid out by Bachs from TipMe's own screens with TipMe covering the ₦50 fee, a "Get paid" bank card, a reserve alert, a reversal pause, a closed checkout before activation, the pilot notice, and a recorded activation.

**Architecture:** One Bachs adapter, two environments chosen by provider name. The payout port grows in `packages/payments`; Bachs types stay inside the adapter (ADR-0004). `requestWithdrawal` keeps its locking and idempotency; it now records the destination and fee, and the worker starts the payout after commit (fee top-up transfer first, then the payout), each with its own stable `Idempotency-Key`. Outcomes arrive by `payout.paid` / `payout.failed` webhooks or reconciliation reads, through the existing `recordPayoutOutcome`.

**Tech Stack:** TypeScript, zod config, NestJS API, BullMQ worker, Drizzle/Postgres migrations, Next.js web, `node:test` with fake transports, Playwright e2e against the pretend provider.

**Spec:** `docs/superpowers/specs/2026-10-31-live-pilot-design.md`, amended by `docs/superpowers/specs/2026-10-31-production-launch-design.md` §6.7 ("bachs-live with payments off") and §6.11.

## Global Constraints

- Live base URL `https://api.bachs.io`, keys `sk_live_`; sandbox stays `https://sandbox-api.bachs.io` with `sk_sandbox_`. A key of the wrong kind is refused.
- Settings: `PAYMENT_PROVIDER` ∈ `mock | bachs-sandbox | bachs-live`; `PAYMENTS_LIVE_ENABLED` `true|false`, default `false`; `BACHS_LIVE_API_KEY`; `BACHS_LIVE_WEBHOOK_SECRET`, `BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET`; `BACHS_RESERVE_ALERT_MINOR=100000` (₦1,000).
- `bachs-live` only on a production copy (`DEPLOYMENT_MODE=production`, `NODE_ENV=production`), with `PAYMENTS_LIVE_ENABLED` true **or** false. `PAYMENTS_LIVE_ENABLED=true` with any other provider is refused. Mock and sandbox stay refused in production.
- `bachs-live` with `PAYMENTS_LIVE_ENABLED=false`: new tips refused with "Tipping opens soon"; Bachs webhooks verified and recorded; `/health/release` reports `paymentProvider: "bachs-live"`, `paymentsLive: false`.
- Idempotency keys: payout `payout.<payoutId>`; fee top-up transfer `payout-fee.<payoutId>`. Every Bachs write carries one.
- Payout fee: ₦50 flat for NGN (`5000` minor), charged by Bachs on top of the amount and drawn from the connected account; TipMe tops the account up with a transfer of the fee from the platform balance before the payout (`POST /v1/transfers`). The recipient's bank receives exactly the amount they chose. The fee is booked as TipMe's cost.
- Withdrawable = min(ledger available, Bachs `available_balance` for the account). ₦1,000 minimum with the "withdraw everything" exception stays.
- Account setup turns automatic payouts off: `POST /v1/balance_settings` with `X-Account-Id` and `interval: "manual"`.
- Bank details: TipMe stores destination reference, bank name, last 4 digits only. Adding or changing needs a fresh email code; a change emails a security notice from `security@`.
- A timeout or 5xx on a Bachs write stays unknown until an authoritative read; never re-sent blindly.
- Reserve job every 15 minutes; alert below `BACHS_RESERVE_ALERT_MINOR`.
- Pilot notice on public pages, checkout, receipt and dashboard; copy says: TipMe is in a pilot, payments are real and go through Bachs, help at `support@usetipme.xyz`. Shown when web `PILOT_NOTICE=on`. Copy reviewed by the owner.
- Integer minor units, explicit currency, append-only ledger (AGENTS.md). Secrets and full account numbers never logged.
- Activation is last, and it is the owner's.
- Integration tests need a throwaway Postgres 16 and Redis 7: build with `pnpm turbo run build --filter=!@tipme/web`, then `DATABASE_URL=… REDIS_URL=… node --test <file>`; the whole suite is `pnpm test:integration`. Rebuild after switching branches (stale `dist/` gives false failures). Twelve backup tests fail on macOS only; name them when they do.
- The live-payments work reuses `isProductionCopy(config)` from `@tipme/observability` (production infrastructure plan, Task 1); if that plan has not landed, add it here in Task 1.

## Review Focus

- **A `payout.paid` webhook arriving before the worker recorded the provider reference.** Expected: parked as unmatched and applied by reconciliation, never a duplicate payout or a `payout_unexpected` issue. Test in Task 6 (`a webhook before the start response is applied once the reference is recorded`).
- **Fee top-up succeeded, payout start then failed definitively.** Expected: the reservation is released, the topped-up ₦50 stays in the recipient's Bachs account and is recorded as a TipMe cost to recover on the next payout (the next payout's top-up is skipped while the account holds an unspent top-up). Test in Task 6 (`a failed payout after a top-up reuses the top-up next time`).
- **The Bachs balance read fails or times out on the Withdraw page.** Expected: the page shows the ledger balance but disables Withdraw with "We can't check your balance with Bachs right now"; it never shows the ledger amount as withdrawable alone. Test in Task 7.
- **A recipient changes bank account while a payout is in flight.** Expected: the in-flight payout keeps the destination it recorded; the new account is used from the next withdrawal. Test in Task 8.
- **Two copies of the worker pick the same `payouts.start` job** (production runs two). Expected: one provider call per key; the second sees the reference or the row lock and does nothing. Test in Task 6.

---

### Task 1: Payment settings, shared by API and worker

**Files:**

- Create: `packages/payments/src/settings.ts`, `packages/payments/test/settings.test.mjs`
- Modify: `apps/api/src/config.ts`, `apps/worker/src/config.ts` (replace the duplicated Bachs/mock rules and fields with the shared ones), `apps/api/src/release/release.controller.ts` (`paymentsLive` now a boolean), `.env.example`, `deploy/staging.env.example`, `deploy/production.env.example` (if the infrastructure plan has landed)
- Test: `apps/api/test/config.test.mjs`, `apps/api/test/webhook-config.test.mjs`, `apps/worker/test/config.test.mjs`

**Interfaces:**

- Produces: `paymentSettingsShape` (zod fields above plus the existing sandbox ones), `checkPaymentSettings(config, context)` (as `checkMailSettings`), `isLiveProvider(name): name is 'bachs-live'`, `bachsEnvironment(name): 'sandbox' | 'live' | null`.

- [ ] **Step 1: Write the failing tests** — the whole matrix, one assertion each:

```js
const cases = [
  // [mode, nodeEnv, provider, live, ok]
  ['production', 'production', 'bachs-live', 'true', true],
  ['production', 'production', 'bachs-live', 'false', true],
  ['production', 'production', 'bachs-sandbox', 'false', false],
  ['production', 'production', 'mock', 'false', false],
  ['production', 'production', 'mock', 'true', false],
  ['preview', 'production', 'bachs-live', 'false', false],
  ['preview', 'production', 'bachs-sandbox', 'false', true],
  ['preview', 'production', 'bachs-sandbox', 'true', false],
  ['production', 'test', 'bachs-live', 'false', false],
];
test('bachs-live needs its live key and webhook secret', ...); // missing BACHS_LIVE_API_KEY / secret → issue names the setting
test('a sandbox key in BACHS_LIVE_API_KEY, or a live key in BACHS_SANDBOX_API_KEY, is refused', ...);
test('sandbox credentials are refused on a production copy even beside bachs-live', ...);
```

- [ ] **Step 2: Run to verify they fail.** Run: `pnpm --filter @tipme/payments build && node --test packages/payments/test/settings.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `settings.ts` and switch both configs to it; keep existing messages where tests pin them.
- [ ] **Step 4: Run** the payments, API and worker config tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payments): bachs-live and PAYMENTS_LIVE_ENABLED settings`

---

### Task 2: The Bachs adapter in two environments

**Files:**

- Modify: `packages/payments/src/bachs/client.ts` (`LIVE_API_ORIGIN = 'https://api.bachs.io'`; option `environment`), `packages/payments/src/bachs/provider.ts` (`BachsProviderConfig.environment`; `name` is `bachs-live` or `bachs-sandbox`; `provider.environment`), `apps/api/src/checkout/payment-provider.provider.ts`, `apps/worker/src/job-worker.ts` (pick key and secrets by provider), `apps/api/src/profiles/payment-accounts.controller.ts` (the five `environment: 'sandbox'` become `this.provider.environment`)
- Test: `packages/payments/test/bachs.test.mjs`, `tests/integration/bachs-account-webhooks.test.mjs`

**Interfaces:**

- Produces: `new BachsApiClient({ apiKey, environment: 'sandbox' | 'live', fetchImpl?, timeoutMs? })`; `BachsProvider.environment: 'sandbox' | 'live'`.

- [ ] **Step 1: Write the failing tests**

```js
test('live requests go to api.bachs.io with the live key', ...);       // fake fetch records URL origin
test('a sandbox key is refused for live and a live key for sandbox', ...); // replaces 'Bachs adapter rejects live keys...'
test('a path that would leave the environment origin is refused', ...);
test('a live provider names itself bachs-live', ...);
```

Integration: `test('a live provider creates accounts recorded as environment live', ...)`.

- [ ] **Step 2: Run to verify they fail.** Run: `pnpm --filter @tipme/payments build && node --test packages/payments/test/bachs.test.mjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests and the account integration test (`node --test tests/integration/bachs-account-webhooks.test.mjs` (integration setup in Global Constraints)). Expected: PASS.
- [ ] **Step 5: Commit** `feat(payments): Bachs adapter runs in sandbox or live`

---

### Task 3: The payout port and its Bachs implementation

**Files:**

- Modify: `packages/payments/src/provider.ts` (port below; `NormalizedProviderEvent` gains `kind: 'payout'`), `packages/payments/src/bachs/provider.ts`, `packages/payments/src/bachs/webhooks.ts`, `packages/payments/src/mock/*` (the pretend provider implements the same port, with scenarios `payout-paid`, `payout-failed`, `payout-review`, `payout-timeout`)
- Test: `packages/payments/test/bachs-payouts.test.mjs`, `packages/payments/test/bachs.test.mjs` (webhooks)

**Interfaces:**

- Produces (on `PaymentProvider`, optional for providers with `capabilities.payouts === false`):

```ts
payoutCapability(accountRef: string): Promise<{ status: 'active' | 'restricted' | 'missing'; requirementsDue: string[] }>;
listBanks(country: 'NG'): Promise<{ code: string; name: string }[]>;
resolveBankAccount(input: { accountNumber: string; bankCode: string }): Promise<{ accountName: string } | null>;
addPayoutDestination(accountRef: string, input: { accountNumber: string; accountName: string; bankCode: string }): Promise<{ destinationRef: string; usable: boolean; status: 'usable' | 'pending_review' | 'rejected' }>;
payoutBalance(accountRef: string, currency: 'NGN'): Promise<{ availableMinor: bigint }>;
platformBalance(currency: 'NGN'): Promise<{ availableMinor: bigint }>;
quotePayoutFee(accountRef: string, amountMinor: bigint, currency: 'NGN'): Promise<{ feeMinor: bigint; exact: boolean }>;
coverPayoutFee(input: { accountRef: string; feeMinor: bigint; currency: 'NGN'; idempotencyKey: string }): Promise<{ transferRef: string }>;
setManualPayouts(accountRef: string): Promise<void>;
initiatePayout(input: { payoutId: string; accountRef: string; destinationRef: string; amountMinor: bigint; currency: string; idempotencyKey: string }): Promise<{ providerReference: string; status: 'pending' | 'processing' | 'review' }>;
fetchPayoutStatus(providerReference: string): Promise<{ status: 'paid' | 'failed' | 'pending' | 'review' | 'not_found'; failureReason?: 'in_debt' | 'destination' | 'other' }>;
```

Payout event: `{ kind: 'payout'; eventId; eventType: 'payout.paid' | 'payout.failed'; providerReference; accountReference; status: 'paid' | 'failed'; failureReason? }`.

Bachs endpoints: `POST /v1/payouts` (`X-Account-Id`), `GET /v1/payouts/{id}`, `POST /v1/transfers` (platform → account), `POST /v1/balance_settings` (`interval: "manual"`), `GET /v1/balances` (with and without `X-Account-Id`). `quotePayoutFee` returns `{ feeMinor: 5000n, exact: false }` for NGN (Bachs's documented flat fee; no quote endpoint). For the bank list, name lookup and destination endpoints, the implementer reads the Bachs Connect docs (payout destinations / bank accounts pages), pins each path and body in the fake transport, and records the doc URL in a comment; if Bachs offers no name lookup, `resolveBankAccount` returns `null` (the card then asks for the account name). `ORGANIZATION_IN_DEBT` maps to `failureReason: 'in_debt'`. Amounts convert with the existing exact `money.ts`.

- [ ] **Step 1: Write the failing tests** (fake transport recording method, path, headers, body)

```js
test('a payout posts the exact decimal amount with the account and payout.<id> key', ...); // amount 150000n → "1500.00"; X-Account-Id; Idempotency-Key 'payout.p1'
test('the fee transfer moves 50.00 NGN to the account with payout-fee.<id>', ...);
test('payout statuses map pending, processing, completed, failed and review', ...);
test('ORGANIZATION_IN_DEBT is a definite failure with reason in_debt', ...);
test('a timeout on a payout or transfer is uncertain, never a failure', ...); // UncertainProviderOutcomeError
test('balances read available_balance for the account and for the platform', ...);
test('manual payouts post interval manual for the account', ...);
test('destination statuses map to usable, pending_review and rejected', ...);
test('payout.paid and payout.failed webhooks normalize to payout events', ...);
test('the full account number never appears in an error message', ...);
```

- [ ] **Step 2: Run to verify they fail.** Run: `pnpm --filter @tipme/payments build && node --test packages/payments/test/bachs-payouts.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the port, the Bachs methods, the webhook mapping and the pretend provider's version; `capabilities.payouts: true` for Bachs.
- [ ] **Step 4: Run** all payments tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payments): Bachs payouts, fee cover, balances and destinations`

---

### Task 4: Schema for destinations, payout fees and withdrawal holds

**Files:**

- Create: `packages/database/drizzle/0052_live_payouts.sql` (with its meta snapshot), `packages/database/test/integration/live-payouts-schema.test.mjs`
- Modify: `packages/database/src/schema.ts`, `packages/contracts/src/ops.ts` (`ISSUE_KINDS` += `payout_unexpected`, `payout_unresolved`, `provider_in_debt`), `packages/database/src/operations/issues.ts` (resolution outcomes)

**Interfaces:**

- Produces:
  - `payout_destinations(id uuid pk, profile_id fk, provider text, destination_reference text, bank_code text, bank_name text, account_last4 char(4), status text check in ('usable','pending_review','rejected'), created_at, replaced_at null)`; unique active one per profile and provider (`WHERE replaced_at IS NULL`).
  - `payouts` += `destination_id uuid null fk`, `fee_minor bigint null check ≥ 0`, `fee_transfer_reference text null`, `start_uncertain_at timestamptz null`.
  - `payment_accounts` += `manual_payouts_at timestamptz null`.
  - `withdrawal_holds(id uuid pk, profile_id fk, reason text check in ('reversal','in_debt','unexpected_payout'), issue_id fk, created_at, released_at null, released_by uuid null)`; index on `(profile_id) WHERE released_at IS NULL`.
  - `provider_fee_credits(account_reference text, provider text, amount_minor bigint, transfer_reference text unique, payout_id uuid, used_by_payout_id uuid null, created_at)` — unspent top-ups (Review Focus 2).
  - Issue resolution outcome values for money issues: `resolved_by_provider`, `recipient_owes`, `written_off` (stored with the reason; no balance change).
  - All additive; the previous release runs unchanged against it.

- [ ] **Step 1: Write the failing test**: the migration applies on a fresh database and on one with existing payouts; the constraints above reject a bad status, a negative fee, and two active destinations.
- [ ] **Step 2: Run to verify it fails.** Run: `node --test packages/database/test/integration/live-payouts-schema.test.mjs` (integration setup in Global Constraints). Expected: FAIL (tables missing).
- [ ] **Step 3: Write** the migration and schema.
- [ ] **Step 4: Run** it plus `packages/database/test/integration/payouts.test.mjs` (old behaviour). Expected: PASS.
- [ ] **Step 5: Commit** `feat(database): payout destinations, fees and withdrawal holds`

---

### Task 5: Withdrawals through the provider (request side)

**Files:**

- Modify: `packages/database/src/operations/payouts.ts` (`PayoutInitiator` → reads the port; `requestWithdrawal`; new `withdrawalQuote`), `apps/api/src/dashboard/dashboard.controller.ts` (`GET /v1/me/withdrawal-quote`, `POST /v1/me/withdrawals` uses it), `packages/contracts` (response shapes)
- Test: `packages/database/test/integration/withdrawals.test.mjs`

**Interfaces:**

- Consumes: Task 3's port, Task 4's tables.
- Produces:

```ts
withdrawalQuote(db, input: { profileId: string; provider: PaymentProvider }): Promise<
  | { state: 'ready'; withdrawableMinor: bigint; ledgerMinor: bigint; providerMinor: bigint; feeMinor: bigint; destination: { bankName: string; last4: string } }
  | { state: 'setup_needed'; requirementsDue: string[]; onboardingUrl?: string }
  | { state: 'no_destination' } | { state: 'destination_pending' }
  | { state: 'paused'; reason: 'reversal' | 'in_debt' | 'unexpected_payout' }
  | { state: 'provider_unavailable' }>;
```

`requestWithdrawal` additionally: refuses `WITHDRAWALS_PAUSED` when an active hold exists; reads `payoutBalance` (outside the transaction, before locking) and refuses `INSUFFICIENT_BALANCE` above min(ledger, provider); records `provider`, `destination_id`, `fee_minor` on insert; inserts an outbox job `payouts.start` in the same transaction; **no longer calls the provider itself**. Fingerprint includes the destination id.

- [ ] **Step 1: Write the failing tests**

```js
test('the withdrawable amount is the lower of the ledger and Bachs balances', ...);
test('a Bachs balance read that fails disables withdrawing, it never falls back to the ledger', ...); // provider_unavailable
test('an active hold pauses withdrawals with its reason', ...);
test('a withdrawal records destination and fee and queues payouts.start, calling no provider', ...);
test('without a usable destination the quote asks for one', ...);
test('a restricted payout capability shows what Bachs still needs', ...);
test('the ₦1,000 minimum and the withdraw-everything exception still hold', ...); // existing tests unchanged
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test packages/database/test/integration/withdrawals.test.mjs` (integration setup in Global Constraints). Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** withdrawals, payouts and dashboard integration tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payouts): withdraw the lower of TipMe's and Bachs's balance, queued for the worker`

---

### Task 6: Starting payouts and recording outcomes (worker, webhooks, reconciliation)

**Files:**

- Create: `apps/worker/src/handlers/payout-start.ts`, `packages/database/src/operations/payout-start.ts`
- Modify: `apps/api/src/webhooks/webhook.service.ts` (route `kind: 'payout'`), `packages/database/src/operations/payouts.ts` (`recordPayoutOutcome`: fee ledger line on paid, `withdrawal_failed` email on failed, hold + `provider_in_debt` issue on `in_debt`), `packages/database/src/operations/reconcile.ts` (payouts with `start_uncertain_at` and no reference: re-read by Bachs lookup if supported, else open `payout_unresolved` once)
- Test: `packages/database/test/integration/payouts.test.mjs`, `packages/database/test/integration/reconcile.test.mjs`, `tests/integration/bachs-payout-webhooks.test.mjs` (new)

**Interfaces:**

- Consumes: Task 3's `coverPayoutFee`, `initiatePayout`, `fetchPayoutStatus`; Task 4's columns.
- Produces: `startPayout(db, { payoutId, provider }): Promise<'started' | 'already' | 'uncertain' | 'failed'>`. Order: lock the payout row (`FOR UPDATE SKIP LOCKED`; locked → `'already'`); if `fee_transfer_reference` is null and no unspent `provider_fee_credits` row for the account, `coverPayoutFee` with `payout-fee.<payoutId>` and record it; then `initiatePayout` with `payout.<payoutId>`; record reference and move to `PROCESSING`. Uncertain at either call: set `start_uncertain_at`, leave `REQUESTED`, return `'uncertain'` (no retry by the queue). A `review` status shows as "being checked by the payment provider".

Webhook routing: `payout.*` for a known reference → `recordPayoutOutcome`; for an unknown reference whose account is a TipMe account → park as unmatched for 10 minutes (reconciliation retries), then open `payout_unexpected` and a hold.

- [ ] **Step 1: Write the failing tests**

```js
test('a payout starts with the fee transfer, then the payout, each with its own key', ...);
test('paid posts the payout and the fee as its own TipMe cost line', ...);
test('failed releases the reservation and emails withdrawal_failed', ...);
test('in debt opens provider_in_debt and pauses withdrawals', ...);
test('held for review stays processing and says so', ...);
test('a timeout leaves the payout unknown, and reconciliation resolves it without a second payout', ...);
test('a webhook before the start response is applied once the reference is recorded', ...);
test('a duplicate payout.paid webhook changes nothing', ...);
test('a failed payout after a top-up reuses the top-up next time', ...);
test('two workers starting the same payout make one provider call', ...); // run startPayout twice concurrently
test('a payout TipMe never started opens payout_unexpected and pauses withdrawals', ...);
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test tests/integration/bachs-payout-webhooks.test.mjs packages/database/test/integration/payouts.test.mjs` (integration setup in Global Constraints). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the payout, reconcile, webhook and reversal integration tests, then the full integration suite (note the 12 macOS-only backup failures by name). Expected: PASS apart from those.
- [ ] **Step 5: Commit** `feat(payouts): start Bachs payouts from the worker and record their outcomes`

---

### Task 7: Reversal pause, staff outcomes, and the Withdraw page

**Files:**

- Modify: `apps/api/src/webhooks/webhook.service.ts` (`flagBachsReversal` also creates a `reversal` hold), the ops issue resolve endpoint (requires an outcome for money issues; releasing the last open hold), `apps/web/src/app/dashboard/withdraw/page.tsx`, `apps/web/src/components/dashboard/*` (states), ops issue view (outcome picker)
- Test: `tests/integration/bachs-reversals.test.mjs`, `tests/integration/ops-issues.test.mjs`, `tests/e2e/withdraw.spec.ts` (new, pretend provider)

**Interfaces:**

- Consumes: Task 5's `withdrawalQuote`.

Copy (sentence case; final wording reviewed by the owner):

- ready: "You can withdraw ₦X to {bank} ••{last4}. TipMe pays the ₦50 transfer fee."
- paused: "Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz"
- review: "Your withdrawal is being checked by the payment provider."
- provider_unavailable: "We can't check your balance with Bachs right now. Try again in a few minutes."
- no_destination: "Add the bank account you want to be paid to." (links to the Get paid card)

- [ ] **Step 1: Write the failing tests**

```js
test('a reversal opens its issue and pauses that recipient’s withdrawals', ...);
test('staff must pick an outcome to resolve a money issue, and resolving releases the hold', ...);
test('the hold stays while another money issue for the recipient is open', ...);
```

e2e: the withdraw page shows each state above from the pretend provider's scenarios.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the integration tests and `pnpm test:e2e -- tests/e2e/withdraw.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payouts): pause withdrawals on reversals and show every withdraw state`

---

### Task 8: Account setup with manual payouts, and the "Get paid" card

**Files:**

- Modify: `apps/api/src/profiles/payment-accounts.controller.ts` (after creating or refreshing a Bachs account with `manual_payouts_at` null: `setManualPayouts`, then set it; a failure is retried at the next refresh and blocks withdrawals until done)
- Create: `apps/api/src/profiles/payout-destination.controller.ts` (`GET /v1/payout-banks`, `POST /v1/me/payout-destination/resolve`, `GET /v1/me/payout-destination`, `PUT /v1/me/payout-destination`), `packages/database/src/operations/payout-destinations.ts`, `packages/mail/src/templates/types/payout-destination-changed.ts`, `apps/web/src/components/account/get-paid-card.tsx`
- Modify: the Settings page to include the card
- Test: `tests/integration/payout-destination-api.test.mjs`, `tests/e2e/get-paid.spec.ts`

**Interfaces:**

- Consumes: Task 3's `listBanks`, `resolveBankAccount`, `addPayoutDestination`; the fresh email code check `changeEmail` uses (`apps/api/src/notifications/notifications.controller.ts:155`) — reuse it, don't copy it.
- Produces: `setPayoutDestination(db, { profileId, provider, destinationRef, bankCode, bankName, last4, status }): Promise<{ replaced: boolean }>` (marks the old row `replaced_at`, inserts the new one, queues `payout_destination_changed` from `security@` when replacing); `PUT` requires `{ bankCode, accountNumber, accountName, emailCode }`; the account number goes only to Bachs.

- [ ] **Step 1: Write the failing tests**

```js
test('a new live account is set to manual payouts once', ...);
test('withdrawals wait until manual payouts are set', ...);
test('adding a bank account without a fresh email code is refused', ...);
test('only the destination reference, bank name and last four digits are stored', ...); // select every column of payout_destinations; no 10-digit number anywhere; request log has none either
test('changing the account sends a security notice; the first one does not', ...);
test('a payout in flight keeps the destination it recorded', ...);
test('a rejected destination shows as rejected and can be replaced', ...);
```

e2e: pick a bank, enter a number, see the resolved name read-only, enter the code, see "Usable".

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the integration and e2e tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payouts): Get paid bank card and manual Bachs payouts`

---

### Task 9: Platform reserve alert

**Files:**

- Create: `apps/worker/src/handlers/payment-reserve.ts`, `packages/database/src/operations/payment-reserve.ts`, migration `0053_payment_reserve.sql` (`payment_reserve_readings(id, provider, currency, available_minor, threshold_minor, low boolean, read_at)`)
- Modify: `apps/worker/src/ensure-schedule.ts` (`payments.reserve` every 15 minutes, only when the provider is a Bachs one), `apps/worker/src/config.ts` (`BACHS_RESERVE_ALERT_MINOR`, default `100000`; `ALERT_WEBHOOK_URL` optional), `apps/api/src/health/*` (`GET /health/payments` → `{ reserveLow: boolean, readAt }`, no amounts), the admin Overview (latest reading and amount, staff only)
- Test: `tests/integration/payment-reserve.test.mjs`, `apps/worker/test/config.test.mjs`

**Interfaces:**

- Consumes: Task 3's `platformBalance`.
- Produces: `checkReserve(db, { provider, thresholdMinor, alert: (text) => Promise<void>, now? }): Promise<{ low: boolean; alerted: boolean }>` — alerts on the first low reading after a normal one (and again every 6 hours while low), not every 15 minutes.

- [ ] **Step 1: Write the failing tests**

```js
test('a balance below ₦1,000 alerts once and shows on the Overview', ...);
test('it alerts again after recovering and dropping, and every 6 hours while low', ...);
test('a failed balance read is recorded as unknown and alerts as unreadable', ...);
test('/health/payments says low without revealing the amount', ...);
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(payments): alert when the Bachs reserve drops below ₦1,000`

---

### Task 10: Checkout closed until activation

**Files:**

- Modify: `apps/api/src/checkout/checkout.service.ts` (`bachs-live` and not `PAYMENTS_LIVE_ENABLED` → `TIPPING_NOT_OPEN`, 409, before any database write or provider call), `apps/api/src/release/release.controller.ts`, the web checkout (`apps/web/src/components/appreciation-form.tsx` and the profile page: when `/health/release` or the quote answer says not open, show "Tipping opens soon" and no pay button)
- Test: `tests/integration/checkout-api.test.mjs`, `apps/api/test/health.test.mjs`, `tests/e2e/checkout-closed.spec.ts`

- [ ] **Step 1: Write the failing tests**

```js
test('with bachs-live and payments off, a new tip is refused as not open and nothing is written', ...);
test('webhooks are still verified and recorded with payments off', ...);
test('/health/release reports bachs-live and paymentsLive false', ...);
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The integration test builds the app with a fake live provider object; it does not need a production config.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(checkout): tipping opens only when live payments are switched on`

---

### Task 11: The pilot notice

**Files:**

- Create: `apps/web/src/components/pilot-notice.tsx`, `apps/web/src/lib/pilot.ts` (`pilotNoticeOn(env): boolean` = `env.PILOT_NOTICE === 'on'`)
- Modify: public profile page, checkout, receipt, dashboard layout; `apps/web/.env.example`
- Test: `apps/web/test/pilot.test.mjs`, `tests/e2e/pilot-notice.spec.ts`

Copy (owner reviews before activation): "TipMe is in a pilot. Payments are real and go through Bachs. Need help? support@usetipme.xyz". Follows `docs/design/DESIGN-CONSTITUTION.md`; quiet, not a banner that hides content.

- [ ] **Step 1: Write the failing tests**: `pilotNoticeOn` unit test; e2e visits profile, checkout, receipt and dashboard with `PILOT_NOTICE=on` and finds the notice with a `mailto:support@usetipme.xyz` link on each, and none with it off; public profiles stay `noindex` while `SITE_INDEXING` is off (existing seo test).
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test apps/web/test/pilot.test.mjs` and the e2e spec. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): pilot notice on every money screen`

---

### Task 12: Recorded activation, runbook and sandbox acceptance

**Files:**

- Create: migration `0054_live_payment_switches.sql` (`live_payment_switches(id, live boolean, provider, version, switched_at)`), `packages/database/src/operations/live-switch.ts`, `docs/runbooks/live-activation.md`
- Modify: API boot (record a row when `paymentsLive` differs from the latest row; concurrent copies insert at most one row per change, via an advisory lock), admin Overview ("Live payments: on since <time>, by <version>"), `docs/00-DECISIONS.md` (a template entry the owner fills in; no acceptance written by us), `docs/agent/HANDOFF.md`
- Test: `tests/integration/live-switch.test.mjs`

**Interfaces:**

- Produces: `recordLiveSwitch(db, { live, provider, version, now? }): Promise<'recorded' | 'unchanged'>`; `currentLiveSwitch(db)`.

Runbook: the activation checklist from live-pilot §6.8 as amended by the launch design §6.9 (Aiven restore drill in place of the off-site copy): owner's written acceptance in `docs/00-DECISIONS.md` with Bachs's confirmation as Q4 decides; reserve funded above ₦1,000 (target ₦20,000); restore drill recorded; live webhook verified with a real delivery (Ops → provider events); set `PAYMENTS_LIVE_ENABLED=true`, set repository variable `PRODUCTION_PAYMENTS_LIVE=true`, deploy; smoke test: tip ₦1,000 to the owner's page with a real card, see it confirmed, withdraw ₦1,000, see it reach the bank, see the ₦50 cover transfer and the fee line in Ops. Switching off: `false`, redeploy; in-flight tips and payouts finish through reconciliation.

- [ ] **Step 1: Write the failing tests**: switching on records one row with the version; three copies booting at once record one; restarting without a change records nothing; switching off records a row.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement**, and write the runbook.
- [ ] **Step 4: Run.** Expected: PASS. Then on staging (sandbox): deploy and run a sandbox payout end to end if Bachs sandbox supports payouts; paste the payout id and statuses into the PR as evidence, or record that the sandbox does not support them.
- [ ] **Step 5: Commit** `feat(payments): record when live payments switch, and the activation runbook`

---

## Owner actions this plan needs (not code)

Q2–Q6 answers from Bachs and the owner (fee cover by transfer is built; if Bachs answers Q2 that it can bill payout fees to the platform balance, a follow-up change drops the `coverPayoutFee` step); the Bachs live key with `connected_accounts:write`, `transfers:write`, `payouts:write`; the live webhook endpoint and secret; the reserve funded; the pilot notice copy approved.
