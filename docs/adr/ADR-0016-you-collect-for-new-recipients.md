# ADR-0016 — You collect for new recipients

Date: 2026-11-19
Status: **PROPOSED.** Not accepted until the owner accepts it in writing. The `you_collect` switch is off in every environment and marked not built, so it cannot be turned on until then.
Owners: Product (owner), Engineering, Payments; finance sign-off needed for the new ledger accounts; legal and partner confirmation needed before production

## Not an approval

This ADR records a product and design decision and the engineering that follows from it. **It is not legal, tax, regulatory or payment-partner approval. D-04 (custody and settlement account ownership) and D-06 (recipient verification, payout holds and support model) stay OPEN** in `docs/00-DECISIONS.md`, which this ADR does not edit. The hard stop on real payments in `AGENTS.md` still applies: no real money moves on this flow until this ADR is accepted by the owner, the partner has answered question P1 of the spec in writing, and the owner turns the switch on in `/ops/switches`.

## Context

Today every recipient must finish the partner's full verification (selfie video, NIN, BVN) before anyone can tip them; until then checkout refuses with `409 PAYMENT_ACCOUNT_REQUIRED`. This is the biggest drop-off at sign-up.

On 19 Nov 2026 the owner decided that recipients must no longer finish full verification before they can receive tips. The payment partner (Bachs) advised its "You collect" model, which the owner said is covered by the partner's licence. That is **the owner's statement**: nobody has checked it against an agreement or a legal opinion. The design is in `docs/superpowers/specs/2026-11-19-you-collect-design.md` (owner-approved, PR #296) and the build plan in `docs/superpowers/plans/2026-11-19-you-collect.md` (PR #297), including its rulings R1–R12 and the pre-flight rulings P1–P19.

## Options considered

1. **Keep today's flow only** (the account collects, ADR-0004 option 1). Leaves the sign-up drop-off in place, against the owner's decision.
2. **Lighter verification on the recipient's own account.** The partner's direct charge needs the account fully verified before it can take a payment, so this is not available.
3. **You collect for new recipients** (ADR-0004 option 3, "TipMe-controlled collection followed by onward settlement"), with today's flow kept unchanged for recipients who already have a ready account. **Chosen, as proposed.**

## Decision

### Two modes

Each recipient has a collection mode, `profiles.collection_mode`:

- **`direct`** (the account collects, today): the supporter pays the recipient's own partner account (direct charge, `X-Account-Id`); TipMe's fee goes to TipMe as the platform fee. Unchanged in every respect.
- **`collect`** (You collect, new): the supporter pays **TipMe** (merchant of record) on TipMe's own partner account; TipMe holds the recipient's share and transfers it to the recipient's receive-only partner account as soon as the tip settles and the recipient has verified a bank account in their own name. They prove only their name and that bank account, at their first withdrawal.

Null means "not decided" and behaves as `direct` (ruling R7). The mode is copied onto every quote (`tip_quotes.collection_mode`, default `direct`), and every later step reads the quote's mode, never the profile's current one, so a tip always follows the mode it was quoted under. With the switch on, new sign-ups get `collect`; existing recipients with an active account keep `direct`; existing recipients who never finished verification move to `collect` at their next quote. No `direct` recipient is moved to `collect` in this work.

### Money flow (spec §3)

A `collect` tip of ₦10,000 on Free: the supporter pays ₦10,000 into TipMe's partner balance; the partner keeps its processing fee (for example ₦200 on a Nigerian card); TipMe's fee (5%, processing included) stays in TipMe's balance; the recipient's ₦9,500 is held in TipMe's balance and transferred to their own partner balance once it settles and their `transfers` capability is active, from where they withdraw as today. **Fees are unchanged:** Free 5% and Pro 3% per tip, processing and payout included, and the first two personal withdrawals per Lagos day are free.

A business share on a collect tip (business option B, ruling R3) is already in TipMe's balance, so only option B's second leg runs (a `collect_sweep` share transfer, TipMe → business). The collect transfer to the staff member moves the net less the share.

### Ledger and the invariant (spec §4)

The ledger stays custody-neutral (ADR-0006). One new asset account and three expense accounts (codes illustrative, pending finance sign-off):

- **`held_for_recipients`** (asset, owned by a person or, for a business share, by a business): money in TipMe's partner balance that belongs to a recipient and has not been transferred. A collect payment debits it instead of `provider_clearing`, with the same credits as today; the transfer posting (operation `collect_transfer`) debits `provider_clearing` and credits it. `provider_clearing` stays global, as today.
- **`dispute_fee_expense`**, **`dispute_loss_expense`**, **`refund_loss_expense`**: what TipMe pays from its own money on a collect tip. A dispute fee is operation `dispute_fee`, posted only in the currency the partner reports (R6). TipMe's fee revenue on a lost-dispute tip is not reversed (R6, accountant question A3).

**Hard invariant**, per currency, at every check: `TipMe's partner available balance ≥ Σ held_for_recipients`. TipMe's own money is the difference; it pays refunds, dispute fees, lost disputes, payout fees and Pro refunds. TipMe never withdraws its own earnings below the held total, and automatic payouts on TipMe's platform balance must be off. TipMe has no code that withdraws its own earnings, so (ruling R5) a guard refuses every TipMe-funded move that would take own money below zero (below critical for a voluntary move), the reserve check pages on a breach, and the runbook forbids dashboard withdrawals below the line. The collect reserve is read into its own table, `collect_reserve_readings` (P9), so today's NGN payout-fee alert is untouched.

The database enforces the ledger's shape: only `business_payable` and `held_for_recipients` may belong to a business (R3), and the reversal mirror trigger of migration 0083 now lets a reversal of a payment that held money take it back from `held_for_recipients` (capped per owner at what the payment held), pay out of `platform_clearing` and book the three costs (P2). Direct and Pro reversals run exactly as before.

### Rulings R1–R12 (from the plan, recorded here)

- **R1. Dispute events.** A platform-scoped dispute event that matches a collect tip becomes a modelled dispute (amount, currency, status, reason code, deadline, fee). Connected-account (direct) disputes keep today's `reversal` path, byte for byte.
- **R2. Routing TipMe's own events.** A platform-scoped payment, reversal or dispute event is first matched against collect payment attempts; only an event that matches nothing goes to Pro billing, as today.
- **R3. A business share on a collect tip.** `held_for_recipients` may be owned by a business; the share-transfer kind `collect_sweep` runs only the leg into the business.
- **R4. Dispute hold by amount.** An open dispute's `held_minor` is added to the recipient's reserved amount; `withdrawal_holds` (whole-balance holds) is not used for disputes. Accepted as a change to spec §6.2 (P19), because `withdrawal_holds` has no amount.
- **R5. Platform withdrawals.** As above: a guard on TipMe-funded moves, a paging reserve check and a runbook rule.
- **R6. Accounts not named in §4.** An absorbed refund after a withdrawal posts `refund_loss_expense`; dispute fees post in the partner's reported currency or not at all (an issue opens); fee revenue on a lost dispute is not reversed.
- **R7. Existing never-verified recipients.** Null mode is undecided and behaves as `direct`; the first quote with the switch on decides once; the existing payment-account row is reused.
- **R8. Name check.** The partner's field names for an individual's name come from its requirements endpoint at build time, recorded in a sandbox fixture. The sandbox does not run the bank-name check, so review and rejection are proven on the mock and recorded fixtures only.
- **R9. Transfer refusals.** Option B's refusal map is unchanged; collect transfers have their own (`insufficient`, `capability`, `in_debt`, `not_found`).
- **R10. Transfer states.** `waiting | ready | sent | unknown | paid | cancelled | review`. A refusal is not stored as a state: it returns the row to `ready` or `waiting`, or sends it to `review` with a reason (P13).
- **R11. Emergency pause and debt freeze.** Staff pause and resume collect transfers as serious actions (a `paused` setting); an open `collect_in_debt` issue also stops every collect transfer until resolved.
- **R12. Switch stays inert.** `you_collect` is registered as a money switch, off, with `notBuilt`; only the last task of the plan removes `notBuilt`. Tests turn it on by writing the switch row directly.

### Settings and the switch

The spec §9 settings (holding cap ₦50,000 for 30 days, reminders on days 7, 21 and 28, a 24-hour new-recipient delay for 7 days, a ₦50,000 first-withdrawal cap, ₦200,000 a day for 30 days, reserve warning ₦500,000 and critical ₦250,000, and the emergency pause) are an append-only `collect_settings` table, read like the plan fee rates; with no row the coded defaults apply. `you_collect` is a money switch (a change is the serious action `feature_switch.set`), default off, seeded from `YOU_COLLECT` (`on`/`off`). Turning it off stops new sign-ups getting `collect`; recipients already on `collect` keep it, and their transfers, refunds, disputes and reserve checks keep running, because that money is owed.

### Amendments to ADR-0004

- **Option 3** ("TipMe-controlled collection followed by onward settlement … not approved and must not be inferred from this sandbox ADR") becomes, once this ADR is accepted, the chosen funds flow **for `collect` recipients only**. Until then it remains not approved.
- **Decision 8 (live gate)** gains, for `collect` tips: this ADR accepted by the owner; the partner's written answer to spec question P1 (that You collect, with TipMe as merchant of record holding recipients' shares before transfer, is covered by its licence for this use); automatic payouts confirmed off on TipMe's platform balance; and the owner turning `you_collect` on. The rest of decision 8 is unchanged, and D-04 and D-06 remain open whatever this ADR's status.

## Consequences

- Sign-up becomes easy, and TipMe takes on every refund and lost dispute on a collect tip and holds other people's money in its own balance (spec §16). One negative balance (`ORGANIZATION_IN_DEBT`) would freeze every collect transfer, which is why the reserve, its alerts and the debt freeze exist.
- Every money path now has two branches. The mode fixed on each quote, and tests on both branches, keep them apart.
- The sandbox grants capabilities at once and does not run the bank-name check, so it cannot prove live verification timing, manual review, live settlement or dispute fees.
- Unclaimed money has no end state until the partner answers spec question P3.

## Validation evidence

- Task 3 (this ADR's PR): the schema, the inert switch and the settings reader, with `tests/integration/collect-schema.test.mjs` (the database refuses what the model forbids; a collect reversal posts and a direct over-reversal is still refused) and `packages/contracts/test/switches.test.mjs`.
- Later tasks of the plan add the adapter, checkout, transfers, disputes, refunds, the reserve, guards, the bank-details flow, the screens and the end-to-end journey, each tested with the switch on in tests and off in production.

## Rollout and rollback

Off in every environment at merge. Production stays off until the owner accepts this ADR, the partner answers P1 in writing and the owner turns the switch on. Rollback is turning the switch off: no new recipient is put on `collect`, and held money keeps moving to the recipients it belongs to. The schema is additive; dropping it would need every held amount transferred first.

## References

- `docs/superpowers/specs/2026-11-19-you-collect-design.md` (§3, §4, §5, §6, §9, §11, §12, §15, §16)
- `docs/superpowers/plans/2026-11-19-you-collect.md` (rulings R1–R12, pre-flight rulings P1–P19)
- ADR-0004 (amended as above), ADR-0006 (custody-neutral ledger), ADR-0015 (checkout on TipMe's own account)
- `docs/00-DECISIONS.md` D-04 and D-06 (OPEN, not edited)
