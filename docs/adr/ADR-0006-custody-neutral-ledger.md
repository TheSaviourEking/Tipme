# ADR-0006 — Custody-neutral double-entry ledger

Date: 2026-10-18
Status: ACCEPTED for development (PR-005). Chart of accounts is illustrative pending finance sign-off; D-04 remains OPEN.
Owners: Engineering (finance sign-off required before real money)

## Context

The user needs two proofs for every tip: that the provider confirmed the supporter's payment, and that the recipient actually received their share. The user's intended funds flow is custodial (full tip to a TipMe-controlled account, TipMe takes its cut, forwards the rest). The PRD prefers provider collection and settlement, and D-04 (custody) is OPEN pending legal advice. PRD 6.4 warns against representing third-party money as customer wallet balances.

## Options considered

1. Model custodial wallets now: commits to an unapproved, regulated funds flow.
2. Record only provider statuses: cannot prove what each party is owed or was paid.
3. **A custody-neutral double-entry ledger** whose entries are true in either world. Chosen with the user.

## Decision

Accounts per currency (codes illustrative):

| Code                              | Kind                     | Meaning                                               |
| --------------------------------- | ------------------------ | ----------------------------------------------------- |
| `provider_clearing`               | asset                    | Money the provider collected for, or holds for, TipMe |
| `recipient_payable` (per profile) | liability                | What TipMe owes each recipient; never called a wallet |
| `platform_fee_revenue`            | revenue                  | TipMe's cut                                           |
| `provider_fee_recovered`          | revenue (contra-expense) | The provider fee taken from the tip, as quoted        |
| `provider_fee_expense`            | expense                  | The provider's actual fee                             |

Payment succeeded (operation key `payment.<attemptId>`): debit `provider_clearing` (gross − actual fee), debit `provider_fee_expense` (actual fee); credit `platform_fee_revenue` (cut), `provider_fee_recovered` (quoted fee), `recipient_payable` (net). If the actual fee differs from the quoted one, the difference sits between `provider_fee_expense` and `provider_fee_recovered`: TipMe absorbs it and the recipient's net is exactly what the quote disclosed.

Payout paid (operation key `payout.<payoutId>`): debit `recipient_payable`, credit `provider_clearing`, with the payout's provider reference on the payout record.

Under custody, these entries describe money that physically passes through TipMe's provider balance. Under provider split, they are the shadow ledger the PRD describes, matched against provider settlement reports.

The mock fee policy (`MOCK_FEE_POLICY_V0`: 5% cut, 1.5% provider fee, both deducted from the tip) is NOT an approved commercial policy (D-05).

> **Update, PR-012 (22 Oct 2026):** new quotes use `FEE_POLICY_V1` (`proposed-v1.1`), PRD v1.1's proposed rules: TipMe keeps 10% of the tip and pays processing out of it, so the recipient receives 90%. The ledger is unchanged: `platform_fee_revenue` is the 10% minus the estimated processing, and `provider_fee_recovered` is the estimate. A fee-free reward gives the recipient the whole tip, and the processing then sits in `provider_fee_expense`, unrecovered, as TipMe's cost. Quotes and tips priced under `mock-v0` keep their recorded amounts. Still PROPOSED (D-05).

## Rationale

The ledger answers "who is owed what, and who was paid what" regardless of who physically moves the money. Choosing custody becomes a legal sign-off, not a rebuild.

## Financial, security, privacy and accessibility impacts

Database-enforced balance, single currency per transaction, append-only entries, unique operation keys. A provider-reported amount or currency that differs from the intent is never booked: the attempt goes to UNKNOWN and operations are alerted (`payment.mismatch`). A success reported after a recorded failure is never silently dropped (`payment.conflict`), and neither is a payout reported paid after it was recorded as failed (`payout.conflict`). A ledger transaction's entries can only be written when it is created, so an operation's postings cannot be extended later. Alerts (`payment.mismatch`, `payment.conflict`, `payout.conflict`, `provider_event.conflict`) are kept once per triggering provider event, and a provider fee larger than the payment is treated as a mismatch.

## Rollout and rollback

Development and mock provider only. Finance must sign off the chart of accounts and postings before real money; D-04 must be approved.

## Consequences

Reconciliation against provider reports, refunds, disputes and real payout execution build on these accounts in later PRs.

## Validation evidence

`docs/PR-005-VERIFICATION.md` (balance property test over 500 random tips; integration tests for every posting).

## Linked PRD requirements

PRD 6.3 to 6.5, 7; AGENTS.md financial invariants; docs/03-DOMAIN-AND-PAYMENTS.md mandatory tests.

## Addendum (PR-008, 2026-10-19): amount-based withdrawals and cash rewards

- **Withdrawals.** Recipients withdraw **any amount up to their available balance**. Payouts are no longer tied to specific tips; the PR-005 tip-based `createPayout` is kept only for its existing tests.
  - Available balance = `recipient_payable` (credits − debits) − payouts still `REQUESTED` or `PROCESSING`. In-flight payouts are reserved.
  - The profile row is locked while the request is made, so two withdrawals at once can never overdraw.
  - Each withdrawal has an `Idempotency-Key`. The request fingerprint is the profile plus the amount.
  - The ledger is still posted only when the provider confirms the payout as `PAID`. A `FAILED` payout releases its reservation, with no posting and no reversal.
- **Cash rewards.** A cash reward is a new `reward` operation: debit `promotions_expense` (TipMe's own cost, kind `expense`) and credit `recipient_payable`.
  - It is balanced and append-only. Its unique operation key (`reward.<momentId>`) means a reward can never pay twice.
  - Supporters' tips are never touched.
- **Status:** development only. Real money still needs D-03, D-04, D-05 and finance sign-off.
