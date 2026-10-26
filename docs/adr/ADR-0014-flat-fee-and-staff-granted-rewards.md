# ADR-0014 — A flat 10% TipMe fee, per-account fees and staff-granted rewards

Date: 2026-10-25
Status: ACCEPTED (product owner). Still pretend money: D-02 to D-04 and D-06 stay open, and no real money moves until they close.
Owners: Product, Engineering

## Context

The mock policy (`mock-v0`) deducted a 5% TipMe fee and a 1.5% provider fee from the recipient. PR-008 also granted rewards automatically: 5 fee-free tips at a recipient's 10th tip, a cash bonus at the 50th, both at the 100th, and a cash bonus for a best month. The product owner has since decided the commercial rule: **TipMe takes a flat 10% of each tip and pays the payment provider out of that 10%.** They also ruled that **nobody gets a reduced fee automatically**: only staff grant fee-free tips, and staff may set a custom fee for an account.

## Decisions

1. **Fee policy.** TipMe keeps 10% of the tip and pays processing out of it, so the recipient always receives 90%. This is dev's `proposed-v1.1` policy (PR-012), which already implements the rule: a processing estimate sits inside the 10% and the provider's actual fee is TipMe's. A ₦2,000 tip pays the recipient ₦1,800.
2. **Per-account fee.** `profiles.custom_fee_bps` (nullable, 0–10000, migration 0038). When set, it replaces the 10% share for that page's new quotes, processing still inside it; the quote records `proposed-v1.1-custom-<bps>`. Staff set or clear it on the admin Pages screen with a written reason (`fees.manage`), audited in the same transaction.
3. **Staff-granted fee-free tips.** Staff add fee-free tips to a page with a reason (`fees.manage`, audited). A granted credit is always honoured (no lifetime cap: the grant is the decision). Open quotes still reserve credits so concurrent quotes cannot use more than were granted.
4. **No automatic rewards.** Milestones and best weeks or months are celebrations only (moments and notifications). The cash-bonus code stays but nothing triggers it.
5. **Minimum tip.** ₦1,000, with Free and Pro pages as decided in PR-012 (`docs/00-DECISIONS.md`).

## Consequences

- Merged onto dev's PR-012 pricing on 26 October 2026; the earlier `v1` policy on `feat/profile-composition` (minimum ₦1) was replaced by it.
- The existing `owner` role is granted `fees.manage` by migration, so current owners can use it without re-running the grant.
- Money-affecting staff actions still lack the two-person rule (AGENTS.md); with one Owner it cannot be enforced yet. Recorded as an open item.
