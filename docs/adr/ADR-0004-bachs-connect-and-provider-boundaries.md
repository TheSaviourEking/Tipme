# ADR-0004 — Bachs Connect sandbox and provider boundaries

Date: 2026-10-26
Status: ACCEPTED FOR SANDBOX ONLY. Live payments remain blocked on D-01 through
D-07, written provider approval, legal/risk review and an explicit production
activation decision.
Owners: Product, Engineering, Payments, Risk/Legal

## Context

The product owner selected Bachs as the first payment-provider integration to
evaluate and Resend for launch email OTP. Phone-number OTP is deferred until
after launch. The current application has only a mock payment adapter, and its
production guards correctly reject mock payments and mock message delivery.

This decision authorizes a sandbox adapter and deterministic tests only. It does
not approve a real-money product, a merchant-of-record arrangement, custody,
settlement, recipient eligibility, pricing beyond ADR-0014, or production
provider credentials.

Bachs' public Connect documentation describes direct charges as charges made by
a connected account, which is the merchant of record. The platform fee is
deducted from that account's proceeds. The same documentation says processing
fees can be charged to the platform balance for direct charges, but if that
balance cannot cover the fee, Bachs silently falls back to charging the
connected account. It exposes `fee_paid_by` only after settlement. Refunds and
lost disputes debit the connected account and can leave it with a negative
balance.

That direct-charge model is not the same as the custodial flow previously
recorded as a proposal in ADR-0006. This ADR does not supersede that proposal or
resolve the legal distinction. Choosing which party is the merchant of record,
who holds funds, and who bears reversals requires explicit legal and provider
approval before live operations.

## Options considered

1. **Bachs direct charge to a connected recipient account.** Selected only as the
   sandbox integration shape. Bachs documents the connected account as merchant
   of record and documents processing-fee fallback risk.
2. **Bachs destination charge with TipMe as merchant of record.** Not selected
   for this sandbox slice; it changes who contracts with the supporter, who
   bears processor costs and where funds settle. It remains a possible live
   design only after provider/legal review.
3. **TipMe-controlled collection followed by onward settlement.** This matches
   an earlier product proposal but is not approved and must not be inferred from
   this sandbox ADR.

## Decision

1. **Provider boundary.** TipMe-owned ports and normalized evidence are the
   application boundary. Bachs SDK types, API payloads, decimal-string money
   conversions, webhook verification details and provider-specific identifiers
   stay inside the Bachs adapter. API and worker composition roots select
   adapters; existing payment attempts and payouts continue to use the provider
   recorded when they were created.
2. **Sandbox flow.** The first Bachs adapter may use one Bachs sandbox connected
   account per TipMe recipient and hosted direct-charge checkout, subject to
   confirming the exact sandbox API behavior. This is a test topology only; it
   is not a decision that recipients are legally merchants of record in a live
   product.
3. **Fee invariant.** Inside TipMe, amounts remain integer minor units and
   currency remains explicit. For the Bachs request, the adapter converts the
   complete TipMe share to Bachs' required decimal-string amount:
   `platformFeeMinor + providerFeeMinor`. This preserves ADR-0014's existing
   recipient quote and ledger history; it does not create a second pricing
   policy. The provider must never receive a client-supplied fee.
4. **Processing-fee protection.** Sandbox account setup should request
   platform-paid processing-fee collection for direct charges. Because Bachs
   documents a silent fallback to the connected account when the platform
   balance is insufficient, tests and reconciliation must inspect authoritative
   settlement evidence (`fee_paid_by`) and alert/block affected recipient
   operations if the recipient bore the fee. A checkout redirect, payment
   success webhook or configured preference alone is not evidence that the
   platform actually paid the processing fee.
5. **Evidence and state.** Only authenticated, deduplicated provider evidence
   or authoritative server-side lookup may advance payment or payout state.
   Stable operation-derived idempotency keys are required. Bachs' documented
   idempotency cache covers successful writes for 24 hours, but the API has no
   checkout lookup by TipMe reference or idempotency key. A timed-out or
   otherwise ambiguous checkout create must remain unknown and must not be
   automatically retried. The application now has a durable unknown-attempt
   state and a guarded operations recovery path, so the sandbox adapter is
   selectable in tests and password-protected preview only. A valid event with
   a mismatched connected account, amount or currency is retained as a verified
   mismatch and never credits the recipient.
6. **Historical routing.** New operations use the configured default provider.
   Reconciliation and support for existing attempts and payouts always use
   their persisted provider, even after the default changes.
7. **Messaging selection.** Launch recipient sign-in is email OTP via Resend;
   phone OTP is deferred and must be presented as coming soon. This records the
   product owner's channel choice, not provider readiness. D-11 remains open
   until the Resend account, verified sending domain, cost, privacy/retention,
   deliverability and operational requirements are evidenced. Messaging delivery
   remains a separate provider boundary and durable outbox; no Resend call is
   made inside a database transaction.
8. **Live gate.** No live Bachs key, production endpoint, real recipient
   onboarding, live checkout, payout or production payment configuration may be
   enabled until D-01 through D-07 are evidenced and approved, written Bachs
   approval is recorded, ADR-0006's proposed custodial flow is reconciled with
   the selected legal funds flow, refund/dispute handling is designed, and an
   explicit production activation decision is made. `PAYMENTS_LIVE_ENABLED`
   remains `false`.

## Required evidence before live activation

- D-01: approved launch jurisdiction, currency and eligible recipients.
- D-02: legal entity, customer terms and applicable legal/regulatory opinion.
- D-03: written Bachs approval for TipMe's exact voluntary-tip, connected-account,
  payment-method, fee, payout and settlement use case; Connect capability active
  in the live account.
- D-04: signed funds-flow diagram resolving merchant of record, custody,
  settlement-account ownership, recipient obligations and reversals.
- D-05: approved fee, processing-cost, refund, dispute and chargeback treatment,
  including an affordable platform processing-fee reserve and a fail-closed
  response to Bachs' documented fallback.
- D-06: recipient KYC, capability, payout-hold, support and account-remediation
  policy.
- D-07: fraud, sanctions/AML, privacy, retention and incident-response review.
- Sandbox acceptance demonstrating attribution, idempotent checkout, verified
  webhooks, safe preservation of ambiguous writes without blind retry, fee
  fallback detection, historical-provider routing and payout status handling
  without real transactions.

## Rationale

The direct-charge sandbox path exercises connected-account attribution and hosted
checkout without committing the product to a live funds-flow or changing the
TipMe ledger. A provider-neutral port preserves the option to choose a different
live funds flow or provider after legal, risk and provider review.

## Financial, security, privacy and accessibility impacts

- No real money is authorized. `PAYMENTS_LIVE_ENABLED` stays `false`, and
  production continues to reject the mock adapter.
- Provider-reported state, not a redirect, is authoritative. Provider writes
  require stable idempotency and uncertain outcomes require reconciliation.
- Provider credentials and external account/destination identifiers remain
  server-side; only allowlisted normalized evidence is persisted.
- Direct-charge refund/dispute debits and negative balances are unsupported live
  risks until the ledger and operational model explicitly handle them.
- Email OTP codes and delivery payloads are authentication credentials; future
  Resend delivery must use the encrypted durable outbox, avoid logs/analytics,
  expire promptly and preserve non-enumerating auth responses.

## Consequences

- Bachs is the first sandbox adapter, not a provider baked into TipMe's domain.
  A future provider must meet the same contracts and conformance tests.
- ADR-0014 remains the existing pricing behavior. This ADR does not change
  historical quotes, ledger postings or the 90/10 default.
- Bachs sandbox access and capabilities do not establish live approval.
- Direct-charge refunds, disputes and negative connected-account balances are
  live blockers until the TipMe ledger, operations and legal model cover them.
- Resend selection does not itself change the current phone-based implementation;
  the email-OTP migration requires its own scoped implementation and tests.
- There is no approval here to use the staging database, Redis, credentials or
  API for production. Any shared machine must use fully separate production
  services, data stores, secrets, backups and hostname routing.

## Validation evidence

- Bachs Connect overview, direct-charge, platform-fee and processing-fee
  documentation were reviewed on 26 October 2026 (links below). They describe
  sandbox/live separation, direct-charge merchant-of-record behavior and the
  processing-fee fallback.
- The official webhook guide and OpenAPI schema were reviewed for signatures,
  account headers, request fields and response shapes.
- Resend's Node.js setup requires an API key and verified sender domain; neither
  has been provisioned or tested here.
- No provider account, credentials, external transaction, deployment or live
  environment was accessed or changed.

## Implementation note — 26 October 2026

- This sandbox adapter uses typed REST with Node `fetch`; the official
  `@bachs/sdk` checkout surface does not expose the required Connect account
  header and direct-charge fields. Marketplace discovery found no Bachs
  integration.
- The adapter hard-codes the sandbox API origin and accepts only `sk_sandbox_`
  credentials. The API and worker allow selection only in tests or
  password-protected preview; production selection and live payments remain
  blocked.
- Provider checkout references include the connected-account reference so
  status reads remain scoped to the same account. The adapter never treats
  checkout redirects as payment proof.
- When Bachs reports that the connected account bore a processing fee, the
  adapter returns the collection as pending for financial reconciliation rather
  than allowing the current flow to credit the full quoted recipient amount.
- Payout operations are explicitly unsupported in this adapter slice. Account
  onboarding, checkout, webhook verification and transaction lookup do not
  constitute a complete payment launch integration.
- Deterministic fake-transport tests cover request construction, exact currency
  conversion, webhook verification and uncertain outcomes. No Bachs credential
  was available and no provider API call or transaction was made.

## Operator recovery implementation status — 26 October 2026

- Unknown Bachs checkout attempts older than 30 minutes now open a dedicated
  money issue. Staff may submit a checkout ID found in Bachs Dashboard only
  against that open issue. TipMe performs an account-scoped authoritative read
  and compares the provider amount and currency with the stored quote before
  persisting the checkout reference. Not-found or mismatched results remain
  `UNKNOWN` and unlinked; matched pending results remain eligible for ordinary
  provider reconciliation. Only a verified provider result can reach the
  existing provider-event/ledger path.
- Ambiguous account creation opens a staff issue. Recovery is available only
  for a recipient with a verified TipMe email. Staff attest that the Dashboard
  account belongs to that recipient and that the platform-fee configuration
  was checked; the API fetches current account status before an atomic mapping,
  audit and issue-resolution transaction. Payouts remain disabled.
- These workflows are tested with fake provider responses and the guarded local
  `tipme_test` database. They have not been exercised against Bachs. The API
  and worker still reject runtime selection of `bachs-sandbox`; this
  implementation does not itself authorize enabling even sandbox runtime
  selection, and does not change the live-payment gate.

## Gap remediation status — 27 October 2026

- **Confirmation.** Reconciliation, expiry and staff recovery pass TipMe's quoted
  share (processing included) as the expected platform fee. A Bachs payment is
  confirmed only when Bachs reports that exact platform fee and that the platform
  paid the processing fee; anything else stays pending and surfaces as an issue.
- **Expiry.** A payment Bachs has collected but not yet settled is reported as
  `collected`; expiry moves it to `PENDING` (unbooked) and never cancels the tip.
- **Checkout start.** A definite Bachs 4xx (except 408/409) fails the attempt and
  the tip with `PAYMENT_START_REJECTED`; timeouts, 5xx and conflicts stay
  `UNKNOWN`. Logs carry the error name, HTTP status and provider code only.
- **Readiness.** One adapter rule (`bachsAccountReadiness`) decides `ACTIVE`:
  active account, active `ngn_card_collection`, platform fee responsibility as
  read back from Bachs. Recipient-paid fees or a restricted capability make the
  account `RESTRICTED`. `account.updated` and `capability.updated` webhooks
  trigger an authoritative re-read.
- **Withdrawals.** Money collected by a provider other than the payout provider
  cannot be withdrawn (`WITHDRAWAL_UNAVAILABLE`); Bachs payouts stay unsupported.
  The worker builds a read-only adapter from the API key and holds no webhook
  secret.
- **Refunds and disputes.** Each Bachs refund, dispute or chargeback event raises
  one `payment_reversed` money issue (migration 0041) and changes no balance.
- **Identifiers.** Account and checkout IDs are opaque (no prefix assumed).
- **Still open (live blockers):** refund, dispute and negative-balance handling in
  the ledger; Bachs payouts; automated platform-balance (reserve) monitoring;
  confirming Bachs' exact refund/dispute event names and success statuses
  against captured sandbox fixtures; a provider-neutral account/onboarding
  interface. None of these is simulated.

## Linked PRD requirements

PRD payment-provider abstraction, guest checkout, truthful payment status and
financial ledger requirements; AGENTS.md financial invariants; ADR-0006
custody-neutral ledger; ADR-0014 fee policy.

## References

- Bachs Connect overview: <https://docs.bachs.io/connect/overview>
- Bachs direct charges: <https://docs.bachs.io/connect/split-payments/direct.md>
- Bachs platform fees: <https://docs.bachs.io/connect/platform-fees.md>
- Bachs processing fees and fallback: <https://docs.bachs.io/connect/processing-fees.md>
- Bachs webhook signing: <https://docs.bachs.io/guides/webhooks/overview>
- Bachs OpenAPI schema: <https://docs.bachs.io/docs/openapi/openapi.json>
- Resend Node.js setup and verified-domain prerequisite:
  <https://resend.com/docs/send-with-nodejs>
- Existing fee policy: `ADR-0014-flat-fee-and-staff-granted-rewards.md`
- Existing custody-neutral ledger: `ADR-0006-custody-neutral-ledger.md`
- Product validation decisions: `../00-DECISIONS.md`

## Rollout and rollback

Sandbox-only. Disable the Bachs adapter selection and return to the mock adapter
for development/test/preview if sandbox integration fails. Production continues
to reject mock providers and has no enabled Bachs configuration. No schema or
funds-flow migration is authorized by this ADR alone.
