# ADR-0014 — A flat 10% TipMe fee, per-account fees and staff-granted rewards

Date: 2026-10-25
Status: ACCEPTED (product owner). Still pretend money: D-02 to D-04 and D-06 stay open, and no real money moves until they close.
Owners: Product, Engineering

## Context

The mock policy (`mock-v0`) deducted a 5% TipMe fee and a 1.5% provider fee from the recipient. PR-008 also granted rewards automatically: 5 fee-free tips at a recipient's 10th tip, a cash bonus at the 50th, both at the 100th, and a cash bonus for a best month. The product owner has since decided the commercial rule: **TipMe takes a flat 10% of each tip and pays the payment provider out of that 10%.** They also ruled that **nobody gets a reduced fee automatically**: only staff grant fee-free tips, and staff may set a custom fee for an account.

## Decisions

1. **Fee policy `v1`.** TipMe's fee is 10% of the tip (half-up to the kobo). The provider fee recovered from the recipient is 0, so a ₦2,000 tip always pays the recipient ₦1,800. The provider's actual fee is TipMe's expense, posted as today to `provider_fee_expense`; `provider_fee_recovered` simply stays 0. No ledger or constraint change. `mock-v0` stays defined so older quotes still explain themselves.
2. **Per-account fee.** `profiles.platform_fee_bps` (nullable, 0–10000). When set, it replaces the 10% for that recipient's new quotes; the quote records `v1-custom-<bps>`. Staff set or clear it with a written reason (`fees.manage`), audited in the same transaction.
3. **Staff-granted fee-free tips.** Staff add fee-free tips to an account with a reason (`fees.manage`, audited). A granted credit is always honoured (no automatic lifetime cap: the grant is the decision). Open quotes still reserve credits so concurrent quotes cannot overspend them.
4. **No automatic rewards.** Milestones and best weeks or months are celebrations only (moments and notifications). The cash-bonus code stays but no milestone triggers it.
5. **Minimum tip unchanged** (₦1). The PRD's proposed ₦1,000 floor is not part of the decision.

## Consequences

- Every new quote changes: e2e and integration expectations move from net 93.5% to 90% of the tip.
- The existing `owner` role is granted `fees.manage` by migration, so current owners can use it without re-running the grant.
- Money-affecting staff actions still lack the two-person rule (AGENTS.md); with one Owner it cannot be enforced yet. Recorded as an open item.
