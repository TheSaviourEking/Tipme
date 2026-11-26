# Profit guards: users pay withdrawal fees, payment options by amount

Date: 25 Nov 2026. Status: approved by the owner in conversation ("Sure, let's go", 25 Nov 2026), written up for review.
This is a product and pricing decision, not a regulatory approval (D-04, D-06 and D-07 stay open).

## Intent

The owner wants TipMe's earnings intact: TipMe must not lose money on an ordinary transaction. Two places lose money today:

1. **Withdrawals.** TipMe tops up the partner's ₦50 payout fee for each person's first 2 withdrawals per Lagos day. A ₦2,000 withdrawal of a ₦2,000 Pro tip costs TipMe more than the tip earned.
2. **Small Pro card tips.** The partner charges 2% for a Nigerian card plus $0.03 (about ₦45) for 3D Secure. On Pro (3%), a card tip under about ₦4,500 earns less than it costs.

Partner fees used here are from docs.bachs.io/for-you/fees, read 25 Nov 2026 (and pasted by the owner from the dashboard the same day):

- Nigerian card: 2%, no cap. 3D Secure: $0.03 per payment that uses it.
- Checkout bank transfer: 1.5%, capped at ₦2,000. No 3D Secure.
- NGN withdrawal to a bank: ₦50 flat, added on top of the amount sent.

## Decisions (owner, 25 Nov 2026)

1. **People pay the withdrawal fee on every withdrawal.** "They pay their withdrawal fees, we need to stop sending the 50ngn for fees too." The 2 free withdrawals per Lagos day are removed. TipMe stops topping up the ₦50 from the platform reserve. Confirmed for every withdrawal, including a whole balance under ₦2,000.
2. **Payment options depend on the amount.** The owner asked whether checkout options can change with the amount. Chosen over a ₦100 minimum fee per tip, which is not needed if this works.
3. **A floor on the rate staff can set**, so a staff change can't make every tip lose money.

Not decided (listed in the profitability package, waiting for the owner): Pro from 3% to 4%, foreign-card extra paid by the supporter, lost-dispute fees from the recipient's balance, a monthly profit line in ops, refunding only what TipMe kept. None of these is in scope.

## Goals

- No ordinary Nigerian tip (card or transfer) loses TipMe money, at any rate staff can set.
- TipMe never pays a person's withdrawal fee unless staff chose to (fee waivers).
- "5% / 3%, processing included" stays exactly true. Supporters and recipients pay nothing new on tips.

## Non-goals

- Foreign cards (the partner's +1.5%, or 5% + $0.40): still a possible loss; separate item.
- Disputes and refunds: unchanged.
- Business withdrawals: unchanged (they already pay, unless `business_payout_fee_absorbed` or a waiver).
- Pro subscription checkout: unchanged (always card and transfer).

## Anti-goals

- A tip page that offers no way to pay. Bank transfer is always offered.
- Charging anyone a fee they did not see before confirming.
- Changing the rule for withdrawals or tips already requested or quoted.

## Part 1: withdrawal fee always paid by the person

**Today** (`packages/database/src/operations/payouts.ts:2014-2034`): a person's withdrawal is `fee_payer = 'tipme'` while it is one of their first `FREE_WITHDRAWALS_PER_DAY` (2, `packages/domain/src/fees.ts:308`) of the Lagos day, else `'user'`. A `'tipme'` payout has the fee moved from the platform reserve to their account before it is sent (`coverFee`, `payout-start.ts`).

**New rule:** every personal withdrawal requested from the release is `fee_payer = 'user'`: the ₦50 (`NGN_PAYOUT_FEE_MINOR`) comes off the amount, as between 12 and 18 Nov 2026 (withdraw ₦10,000, receive ₦9,950). This covers You collect recipients.

What stays:

- The fee is shown before confirming ("Transfer fee: ₦50, charged by our payment partner").
- **The request carries who the quote showed paying** (`feePaidBy`, Ruling R6 at the final review). If the payer decided under the lock differs (an unused top-up spent meanwhile, a business switch changed), the request is refused `WITHDRAWAL_FEE_CHANGED` (409), nothing is recorded, and the screen reloads the quote, shows the new fee and says "The transfer fee changed. Check the new amount and confirm again." A request without `feePaidBy` (a screen loaded before the release) is decided as before, for one release.
- A higher or lower actual fee is settled as today (`payout-fee-extra` / `payout-fee-credit`).
- A balance of ₦50 or less can't be withdrawn; the screen says why.
- **Split withdrawals** (per-provider balances): the person pays one fee for the request. TipMe pays for each extra part (owner, 23 Nov 2026).
- **Fee waivers** (design 2026-11-23, being built): a waiver still makes TipMe pay. The waiver design's default for people changes from "2 free a day" to "the person pays"; that spec gets an addendum.
- Payouts already requested keep their recorded `fee_payer`. `coverFee` stays for them, for waivers and for split extra parts.

- **An unused fee top-up is spent first.** A person whose earlier TipMe-paid withdrawal failed after its ₦50 top-up arrived has that top-up on their account. Their next withdrawal uses it (`fee_payer = 'tipme'`, as a business's already does through `freeFeeCredit`, `payouts.ts:2044` onward) before they are charged. **Design call:** TipMe already paid that ₦50, so charging the person again would take it twice.

Removed: the daily free count and its copy ("the first 2 withdrawals each day are free", "This is your 3rd withdrawal today…"), in the Terms, the Pro page, ops pages, the withdraw screen and the quote (`freePerDay`, `ordinalToday`). The quote contract keeps the fields' removal backward-safe for the web build shipped in the same release (builder's call: remove or send 0).

## Part 2: payment options by amount

**Today:** every tip checkout sends `payment_method_types: ['NGN_CARD', 'NGN_BANK_TRANSFER']` (`packages/payments/src/bachs/provider.ts:813` for a person's page, `:630` for checkouts on TipMe's own account, which includes You collect tips). The method list is chosen per checkout, so it can be chosen per amount.

**New rule:** card is offered only when TipMe's share of that tip covers the card cost with a margin:

```
offer card  ⇔  tipmeShare ≥ cardRate × amount + threeDsCost + margin
```

- `tipmeShare` is the quoted share (plan rate, custom rate, waiver), already fixed at quote time.
- `cardRate` = 2%, `threeDsCost` = ₦45, `margin` = ₦15. Settings with these defaults, so staff can follow the partner's price or the exchange rate without a release (builder's call: config or admin setting; admin preferred, audited like plan fees).
- Bank transfer is always offered.
- A tip TipMe takes nothing from (fee-free credit, waiver) offers bank transfer only, since a card would cost TipMe 2% + ₦45 on money it didn't keep. **Design call; flag to the owner.**

What this gives today:

- **Free (5%):** card is offered on every tip from the ₦2,000 minimum (₦100 share ≥ ₦40 + ₦45 + ₦15).
- **Pro (3%):** card from ₦6,000 (₦180 ≥ ₦120 + ₦45 + ₦15). Below that, bank transfer only.
- **Design call:** margin ₦15 keeps card on every Free tip, as told to the owner. A larger margin (₦50) would move Pro's line to ₦9,500 and Free's to ₦3,167; the owner can raise it later in the setting.

The supporter sees only what the partner's checkout shows. TipMe's tip page says nothing about methods (no new copy), unless the builder finds the partner's page confusing with one method; then one line on the TipMe page before redirect: "Pay by bank transfer".

**Pro subscription checkouts stay on both methods.** `initializePlatformCheckout` (Pro) and `initializeCollectCheckout` (You collect) share `ownCheckout` (`provider.ts:876`, `:913`), which sends both methods today; the collect path gains the method list (its input has no `tipmeShareMinor` today), and the Pro path passes both explicitly.

**The same rule** applies to Business team tips (they're charged on the staff member's page) and You collect tips. Giving is out of scope until it ships.

### Pre-build check (blocking)

**Result (25 Nov 2026, owner approved the run): PASSED for what a person sees.** Two sandbox checkouts of ₦2,000 on TipMe's own sandbox account, created with a throwaway script (not in the repo):

- `chk_oNPmHnT0MVd8uyb3`, `payment_method_types: ['NGN_BANK_TRANSFER']`: HTTP 201. After the email step the page goes straight to "Get account details" (bank transfer); no card option.
- `chk_qccJ1tKTgONaNDMS`, both methods: the page shows "Bank transfer" (open by default) and "Card" to choose from.

Not checked: paying the transfer-only checkout to the end (needs the partner's sandbox transfer flow), and a checkout on a connected account (`X-Account-Id`, a person's page). The build's first sandbox step covers both before release. The read-back of a checkout doesn't echo the method list, so TipMe can't confirm it from the API; the rule relies on what TipMe sends.

Original check, kept for the record: One sandbox test through the Task 16 manual script, approved by the owner before it runs: a checkout created with `payment_method_types: ['NGN_BANK_TRANSFER']` shows only bank transfer, and completes. If the partner ignores or rejects a single-method list, Part 2 stops and the owner picks between the ₦100 minimum fee and Pro at 4%.

## Part 3: rate floor

Today staff can set a plan rate from 1.5% (`PLAN_FEE_MIN_BPS = 150`). At 1.5% every card tip loses money and transfer tips break even. With Part 2, a low rate only removes card, but a rate below the transfer cost (1.5%) would still lose on every tip.

**New rule:** the lowest plan rate is 2% (200 bps). Saving a rate shows staff, before confirming, from what tip amount cards are offered at that rate.

- **Per-page custom rates** (ADR-0014; `opsPageFeeSchema`, `packages/contracts/src/ops.ts:884`, today 0–10000 bps) get the same floor: a custom rate is either 0 (fee-free, a deliberate staff grant, treated like a waiver: transfer only) or at least 200 bps. **Design call.**
- **There is no business tip rate** (a business's `business_bps` is its cut of a staff member's tip), so nothing else changes.
- The floor is enforced in the app (`PLAN_FEE_MIN_BPS` in `packages/domain/src/fees.ts:79` and `packages/contracts/src/plan-fees.ts:11`, and the page-fee schema). The database checks (`plan_fee_rates_*_bps BETWEEN 150 AND 1000`, `schema.ts:3474-3477`; the page rate check, `schema.ts:732`) stay as they are, so existing rows stay valid. Existing plan or page rates between 1 and 199 bps, if any, are left and flagged on the ops screens (builder checks staging and prod have none). **Design call.**

## Wording and notice

- Site, Pro page, Terms: "5% (Free) / 3% (Pro) of each tip, payment processing included. Each withdrawal costs ₦50, charged by our payment partner." Replaces "payment and withdrawal fees included" and the free-withdrawals line.
- The fee change notice (#287, "Lower fees on TipMe") is redrafted to include the withdrawal change and goes out before the release. Sending stays a staff action.
- Code comments that say "processing and withdrawal fees included" (`packages/domain/src/fees.ts:61`, `DEFAULT_PLAN_FEE_RATES`) are updated with the code.
- `docs/00-DECISIONS.md` is not edited by agents; the owner adds the D-05 entry.

## Order and dependencies

- **Fee waivers** (design 2026-11-23) are being built at the same time. **Design call:** this ships independently; whichever PR merges second adapts (the waiver default for people becomes "the person pays"). Tests that need waivers are written by the waiver PR if it lands second.
- **Parts 1 and 3 don't depend on the sandbox check** and ship even if Part 2 stops. **Design call.**

## Approaches considered

1. **Payment options by amount (chosen).** Keeps the headline rate exactly true; costs some card-only supporters on small Pro tips.
2. **₦100 minimum TipMe fee per tip.** Simple, but changes the headline to "3%, minimum ₦100" and still loses on Pro tips between ₦3,333 and ₦4,500 at 3%. Fallback if the pre-build check fails.
3. **Pro to 4%.** An admin setting, no build; doesn't by itself stop small card tips losing. Still open as a separate item.

## Tests the builder must cover

- A person's withdrawal on the 1st of the day is `fee_payer = 'user'` and the quote shows the ₦50 off the amount; a business's is unchanged; a waived one is `'tipme'`.
- A split withdrawal charges the person one fee.
- A payout requested before the release with `fee_payer = 'tipme'` still gets its top-up.
- Checkout method list: Free ₦2,000 → both; Pro ₦5,000 → transfer only; Pro ₦6,000 → both; Pro ₦10,000 → both; fee-free tip → transfer only; the boundary amount exactly.
- The rule reads the quoted share, not today's rate (a rate changed after the quote doesn't change the methods of that checkout).
- Plan rate below 200 bps refused.
- E2E on the pretend provider: method list passed through to the checkout request.

## Left to the builder

Where the card rule lives (domain function next to the fee policy), config vs admin setting for the three card numbers, the contract change for the free-count fields, and the copy placement.
