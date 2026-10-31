# Live pilot: real tips and real payouts through Bachs, for a closed circle

Status: DRAFT for owner approval, 31 October 2026.
Related: ADR-0004 (Bachs sandbox and the live gate), ADR-0006 (custody-neutral ledger), ADR-0014 (fee), `docs/00-DECISIONS.md` (D-01 to D-08), `2026-10-30-payment-provider-switching-design.md`, `2026-10-30-mail-platform-design.md`.

## 1. Intent

TipMe runs a real-money test in production with a small circle of people before the public launch. Supporters tip real naira through Bachs. Recipients receive the tips in their Bachs connected accounts and withdraw to their Nigerian bank accounts from inside TipMe. Everything the pilot touches must work the way it will at launch: sign-in, email, payments, payouts, ledger, admin inbox, backups, monitoring and rollback. The owner will keep updating the product during the pilot.

The owner's words: "We need the new code for Bachs live mode, we need the tipping to work … a real prod test with a small circle of people, so we need all the core prod stuff to work proper … It should also pay." Withdrawals "should use the provider's flow": one standard TipMe withdrawal flow that each provider plugs into.

Facts this rests on:

- TipMe's Bachs live account is active, with Connect enabled for live (the owner, 31 October 2026).
- Bachs documents a payouts API: `POST /v1/payouts` from a connected account's balance (`X-Account-Id`), to a registered bank destination. Statuses run `pending → processing → completed | failed`, with webhooks `payout.paid` and `payout.failed`. The fee is charged on top of the amount. A first payout may be held for review. There is no cancellation. A negative balance blocks all payouts (`ORGANIZATION_IN_DEBT`).
- Going live means: base URL `https://api.bachs.io`, `sk_live_` keys scoped to `connected_accounts:write`, `transfers:write` and `payouts:write`, a new webhook endpoint with its own secret, and connected accounts created afresh in live. In live, capabilities start `restricted` and become `active` only after a Bachs reviewer approves them.
- In live, a Nigerian individual needs an identity set (name, date of birth, ID number such as NIN, an ID document) for collection, and a `bank_account` destination (`account_number`, `account_name`, `bank_code`) for payouts. NGN bank destinations that resolve at the bank are approved on submission.

## 2. Goals

1. **Bachs live adapter.** Bachs runs in `live` as well as `sandbox` from the same adapter. Production accepts only live; staging only sandbox.
2. **Payouts through the provider.** A recipient withdraws from TipMe, and TipMe pays out through the provider that holds their money. Bachs is the first real implementation.
3. **Recipient payout setup.** In Settings, a recipient adds and checks the bank account Bachs pays to. Collection-side identity checks stay in Bachs's hosted onboarding, which we already link to.
4. **A pilot with a notice.** Anyone can sign up and create a page as they do today: there are no invitation codes (owner, 31 Oct). Every page and the dashboard show a short pilot notice in place of full terms (owner, 31 Oct). The circle stays small by sharing, not by a gate.
5. **A production environment** separate from staging. It has its own server or services, data, secrets, backups, off-site copies, monitoring, alerts and email domain, plus a deploy and rollback path and a release check that is safe with real money.
6. **An explicit, recorded live activation.** Real money is possible only when production is configured for it on purpose, and the owner's acceptance of the open decisions is written down.

## 3. Non-goals

- A public launch: no search indexing, no open sign-up, no marketing.
- A second live provider, or switching providers during the pilot. The provider-switching design ships later.
- Moving money between TipMe and recipients (transfers, a custodial model, a TipMe platform balance used for tips). The pilot uses Bachs direct charges, as built.
- Automatic refunds or chargeback handling in the ledger (Phase 3). The pilot handles reversals by hand; see §6.5.
- Cash rewards and fee-free tips with real money. They stay pretend, or off, in production.
- Phone sign-in, and supporter accounts.

## 4. Anti-goals: a failure even if it "works"

- A recipient is paid twice, or paid money that isn't theirs: two withdrawals, a retry after a timeout, or a payout from money not yet settled.
- A tip shows as paid when Bachs hasn't confirmed it, or the recipient is shown more than they will actually get.
- Staging and production share a database, Redis, keys, webhook secrets or email domain, or a staging deploy touches production.
- A rehearsal or release check moves real money.
- Live payments switch on by accident, through a default, a missing variable or a copied staging file.
- A recipient is sent to Bachs to withdraw. Withdrawals happen in TipMe's own screens, whichever provider holds the money (owner, 31 Oct).

## 5. Constraints

- AGENTS.md financial invariants: integer minor units, explicit currency, an append-only ledger, and state advanced only by authenticated provider evidence or an authoritative read.
- ADR-0004's adapter boundary: Bachs types stay inside the adapter, and existing attempts and payouts use their recorded provider.
- Nothing ambiguous is retried blindly: a timeout or 5xx stays unknown until an authoritative read.
- Every Bachs write carries a stable `Idempotency-Key`.
- Secrets are never logged and never sent to analytics.

## 6. Design

### 6.1 Provider and environment

- `PAYMENT_PROVIDER` gains `bachs-live`. The Bachs adapter takes its environment from the provider name. The live base URL is `https://api.bachs.io`, and the key must start with `sk_live_`. The two names can't be mixed: a sandbox key is refused for live and the reverse. The sandbox base URL stays hard-coded for sandbox.
- **Production config rules:**
  - `PAYMENT_PROVIDER=bachs-live` is allowed only when `DEPLOYMENT_MODE=production`, `NODE_ENV=production` and `PAYMENTS_LIVE_ENABLED=true`. `PAYMENTS_LIVE_ENABLED` today only accepts `false`; it becomes `true | false`, defaulting to `false`.
  - `bachs-live` is refused in staging and preview. Mock and sandbox are still refused in production.
  - `PAYMENTS_LIVE_ENABLED=true` with any provider other than a live one is refused.
- **Webhooks:** a separate `BACHS_LIVE_WEBHOOK_SECRET` (and a `_PREVIOUS` one for rotation).
- **Accounts:** `payment_accounts.environment` is `live` for these accounts. The enum already has it. Live accounts are new rows, created by the existing setup flow; nothing is copied from sandbox.
- **Health:** `/health/release` reports `paymentsLive: true` and `paymentProvider: "bachs-live"`. The release check uses these to refuse anything but read-only checks (§6.7).

### 6.2 Payouts: the standard flow with a provider plugged in

The provider port grows from today's `initiatePayout` / `fetchPayoutStatus` into the following. Names may change in the plan.

| Function                                                                                | Purpose                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `payoutCapability(accountRef)`                                                          | `{ status: 'active' \| 'restricted' \| 'missing', requirementsDue[] }`  |
| `listBanks(country)`                                                                    | The bank names and codes to pick from                                   |
| `resolveBankAccount({ accountNumber, bankCode })`                                       | The account name, if the provider offers name lookup; otherwise `null`  |
| `addPayoutDestination(accountRef, { accountNumber, accountName, bankCode })`            | `{ destinationRef, usable, status }`                                    |
| `payoutBalance(accountRef, currency)`                                                   | `{ availableMinor }`                                                    |
| `quotePayoutFee(accountRef, amountMinor, currency)`                                     | `{ feeMinor }` (exact if the provider quotes; else documented estimate) |
| `initiatePayout({ accountRef, destinationRef, amountMinor, currency, idempotencyKey })` | `{ providerReference }`                                                 |
| `fetchPayoutStatus(providerReference)`                                                  | `{ status, failureReason? }`                                            |

**The flow:**

1. **Opening Withdraw.** TipMe shows:
   - the amount the recipient can withdraw: the lower of TipMe's available balance (ledger) and the provider's available balance;
   - the bank account the money will go to;
   - the provider's payout fee.

   If the capability isn't active, the page shows what's missing and links to Bachs onboarding.

2. **Confirming.** The recipient confirms an amount, and `requestWithdrawal` runs as it does today: the balance is locked, there is one payout per idempotency key, and the amount is reserved. The payout row records `provider = bachs-live`, the destination, and `feeMinor`. The provider call happens after the commit, through the worker, with idempotency key `payout.<payoutId>`.
3. **The outcome.**
   - `payout.paid` / `payout.failed` webhooks, or reconciliation's `fetchPayoutStatus` reads, drive the existing `recordPayoutOutcome`.
   - A timeout or 5xx while starting leaves the payout `UNKNOWN`. Reconciliation reads it by reference, or by the idempotency key where the provider supports that; otherwise it opens an issue for staff. It is never re-sent blindly.
   - Paid: the ledger posts the payout, and the fee is posted as its own line.
   - Failed: the reservation is released and `withdrawal_failed` is emailed.
   - A payout held for review shows as "being checked by the payment provider".
4. **Which provider pays.** The provider recorded on the tips being withdrawn. Money collected by a provider that can't pay out stays blocked, as today.
5. **Money that leaves outside TipMe** (builder's call; Bachs's docs don't say whether recipients can pay out or refund on their own, or whether accounts pay out on a schedule):
   - Account setup turns off any automatic payout schedule if Bachs allows it.
   - A `payout.*` webhook for a payout TipMe didn't start opens a money issue, and blocks that recipient's withdrawals until staff resolve it.
   - The withdrawable amount is always capped by Bachs's `available_balance` (`GET /v1/balances` with `X-Account-Id`), so TipMe never asks for more than is really there.
   - The owner confirms the facts with Bachs (§9).

**The payout fee:** TipMe pays all of a recipient's fees (owner, 31 Oct). The recipient withdraws an amount and that amount reaches their bank. Bachs documents that the fee is charged on top and drawn from the account named in `X-Account-Id`; it documents no way to bill it to the platform. How TipMe covers it waits on Bachs's answer (§9 Q2):

- **If Bachs can bill payout fees to the platform balance,** that is used.
- **Otherwise,** the fee drawn from the recipient's Bachs balance is booked as a TipMe cost, and the recipient is made whole by the mechanism Bachs confirms.

Until then, the withdrawable amount must leave room for the fee in the recipient's Bachs balance.

**Timing:** recipients can withdraw whenever they like (owner, 31 Oct). The existing ₦1,000 minimum and its "withdraw everything" exception stay, and the reversal pause in §6.5 is the only hold.

### 6.3 Recipient payout setup

- A **"Get paid"** card in Settings:
  - bank (from `listBanks`), account number, then the account name, resolved and shown read-only where the provider can resolve it;
  - the account's status (`usable`, `pending_review`, `rejected`), and a way to replace it.
- **Storage:** TipMe stores only the destination reference, the bank name and the last 4 digits. The full account number is sent to Bachs and not kept. Changing the account emails a security notice from `security@`.
- **Verification:** adding or changing a bank account needs a fresh email code, the same step as other sensitive changes, so a stolen session can't redirect payouts.

### 6.4 The pilot notice

- **Sign-up:** sign-up and page creation are unchanged; there are no invitations.
- **The notice** appears on public pages, the checkout, the receipt and the dashboard. It says:
  - TipMe is in a pilot;
  - payments are real and go through Bachs;
  - where to get help (`support@usetipme.xyz`).

  The copy is reviewed by the owner.

- **Visibility:** search indexing stays off (`SITE_INDEXING=false`), and public profiles stay `noindex`.

### 6.5 Refunds, disputes and negative balances (pilot handling)

- A `payment.reversed` event opens a money issue, as today, and now also blocks new withdrawals for that recipient until staff resolve it. Bachs would block them anyway once the account went negative.
- The issue tells staff what Bachs debited, and asks them to record the outcome with a reason: resolved by provider, recipient owes, or written off. The pilot doesn't change balances automatically. Phase 3 designs ledger reversals.
- If a payout fails with `ORGANIZATION_IN_DEBT`, a money issue opens, and the recipient is told withdrawals are paused while support checks their account.

### 6.5a Platform processing-fee reserve

- **What happens without one:** Bachs takes processing fees from TipMe's platform balance, and silently charges the recipient when that balance is short (ADR-0004). TipMe then holds the tip pending for staff.
- **Watching it:** a worker job reads the platform balance (`GET /v1/balances`) every 15 minutes. It alerts Slack and the admin Overview when the balance falls below ₦1,000 (`BACHS_RESERVE_ALERT_MINOR=100000`, owner, 31 Oct).
- **Funding it:** the owner funds the reserve before live activation (§6.8).

### 6.6 Production environment

- **Database (owner, 31 Oct):** production's Postgres is on **Aiven**, a managed service. Aiven provides production's backups and point-in-time recovery. TipMe's own WAL archive and base backups stay staging-only.
- **Server (owner, 31 Oct):** production's API, worker, Redis and Caddy run on the **same server** as staging, as a separate Docker Compose project. It has its own network, volumes, env file and hostnames.
- **Isolation (ADR-0004):** production shares nothing with staging (database, Redis, secrets, webhook endpoints, mail domain). On a shared disk, staging's backup growth must be bounded and watched (`2026-10-31` WAL retention work), so it can never fill the disk under production.
- **Hosting:**
  - Web: `usetipme.xyz` on Vercel production, with its own environment variables pointing at `https://api.usetipme.xyz`.
  - API and worker: `api.usetipme.xyz` via Caddy.
- **Compose:** `deploy/compose.production.yml`, derived from staging's with production defaults (`DEPLOYMENT_MODE=production`, no preview password, no dev inbox), plus `deploy/production.env.example`. The production env file lives only on the server.
- **Deploy:**
  - `deploy-production` is triggered by hand only (never automatically), from `main`. It builds the same image as staging, runs migrations with a backup first, and supports rollback with `rollback.sh`.
  - A deploy needs the version to have passed staging's full check.
- **Data:**
  - Backups and point-in-time recovery, as on staging.
  - An off-site copy is **required** before live activation.
  - A restore drill must pass on production backups.
- **Email:** ZeptoMail production agent, `usetipme.xyz` verified (owner, 31 Oct; see the production launch design), DMARC fixed to one record. Senders as in the mail design.
- **Monitoring:** Sentry (separate environment), `ALERT_WEBHOOK_URL` to Slack for money issues and failed jobs, uptime checks on `/health/live` and the web.
- **Staff:** the owner is enrolled with an authenticator in production. Admin access is the owner only during the pilot.
- **Secrets:**
  - All secrets are generated fresh for production.
  - Nothing is copied from staging. The staging preview password and release token pasted into chat on 31 October are rotated on staging too.
- **Analytics:** off (`ANALYTICS_ENABLED=false`) until D-07, as the code defaults in production.

### 6.7 Release check in production

- Production runs **only the read-only check**. It verifies:
  - the version and that the copy is production;
  - payments live, with the expected provider;
  - pages load and are accessible;
  - private areas refuse outsiders;
  - the webhook endpoint answers 401 to unsigned calls.
- The full rehearsal never runs in production: it creates tips. The check script refuses `--full` when `paymentsLive` is true.
- **A pilot smoke test by a person** after the first deploy:
  1. tip a pilot page ₦1,000 with a real card;
  2. see the tip confirmed;
  3. withdraw ₦1,000;
  4. see it reach the bank.

  This is written as a runbook step with expected outcomes.

### 6.8 Live activation (the switch)

Production starts with `PAYMENTS_LIVE_ENABLED=false`: the site works, and checkout says tipping isn't open yet. Switching it on needs all of these:

1. The owner's written acceptance of the open decisions for a closed pilot, recorded in `docs/00-DECISIONS.md` (§8), together with Bachs's written confirmation as §9 decides.
   1a. The live platform balance funded above the reserve threshold (§6.5a).
2. The off-site backup verified, and the restore drill passed.
3. The Bachs live webhook verified with a live delivery.
4. The owner sets `PAYMENTS_LIVE_ENABLED=true` and redeploys. The admin Overview shows "Live payments: on since <time>, by <version>".

Switching off again is setting `false` and redeploying. Tips already started finish through reconciliation, and payouts in flight finish.

## 7. Testing

- **Adapter (fake transport):** live and sandbox endpoints and key checks; the payout calls with exact decimal conversion; idempotency headers; statuses and failure reasons; destination statuses; `ORGANIZATION_IN_DEBT`.
- **Config:** every allowed and refused combination of mode, provider and `PAYMENTS_LIVE_ENABLED`.
- **Integration:**
  - withdrawal to Bachs with a fake provider: paid, failed, held for review, timeout leading to unknown and then reconciled, a webhook before the start response, a duplicate webhook;
  - the withdrawable amount is the lower of the two balances;
  - a reversal blocks withdrawals;
  - the pilot notice shows on every money screen;
  - bank-account changes need a code and send a notice.
- **e2e:** the pilot notice; the "Get paid" card; withdrawal states, all against the pretend provider.
- **Sandbox acceptance on staging** against Bachs sandbox payouts, if the sandbox supports them; recorded as evidence.
- **Production:** the manual smoke test in §6.7, with real money, done by the owner.

## 8. Decisions this records

The pilot proceeds with D-01 to D-07 still formally open. The owner accepts that risk for a closed circle, and records it in the decisions log. The deploy pipeline makes no legal assumption beyond that record. Specifically:

- **D-03:** Bachs live Connect is active (the owner).
- **D-04:** direct charges; the recipient is merchant of record per Bachs's model.
- **D-05:** flat 10%; the payout fee as §9 Q2 decides; reversals handled by hand.
- **D-06:** Bachs's own identity checks and payout review.

The remaining open decisions are restated as limits of the pilot.

## 9. Questions only the owner can answer

Answered on 31 October:

- Open sign-up, with a pilot notice instead of terms.
- Withdrawals only in TipMe, whenever the recipient likes.
- TipMe pays all fees.
- Reserve alert below ₦1,000.

Still open:

- ~~Q1. Production server~~: answered. Same server as staging; database on Aiven.
- **Q2. For Bachs:** can a connected account's payout fee be billed to TipMe's platform balance? If not, how does TipMe make a recipient whole for it?
- **Q3. For Bachs:** can recipients move money out of their Bachs accounts themselves (dashboard, automatic schedule, refunds)? Can automatic payouts be turned off for accounts TipMe creates?
- **Q4. Bachs's approval:** is written confirmation of TipMe's use case required before activation, or is the owner's statement that live Connect is active enough to record?
- **Q5. Staff:** during the pilot, may the owner alone settle money issues (reversal outcomes, withdrawal pauses, unknown payouts), audited, instead of the two-person rule?
- **Q6. Reserve:** will the owner fund TipMe's live Bachs balance before activation?

## 10. Left to the builder

Exact names and file layout; the reconciliation interval for payouts; copy, following the design constitution; how payout fee estimates are shown if Bachs doesn't quote them; the order of work, provided live activation comes last.
