# Fee waivers: staff choose when TipMe pays the fees

**Status:** design, awaiting the owner's approval (23 Nov 2026)
**Builds on:**

- final pricing: Free 5% / Pro 3% per tip, processing and payout included, admin-settable (18 Nov);
- withdrawal fees: 2 free per Lagos day for people, then the partner's fee; businesses pay it unless `business_payout_fee_absorbed` is on (12 Nov, 18 Nov);
- plan-fee settings (`plan_fee_rates`, `plan_fees.change`);
- per-page deals (`profiles.custom_fee_bps`, `fee.change`);
- fee-free credits (`fee_free_credits`).

**(owner)** marks the owner's decisions. **(design call)** marks choices this document made, which the owner can overturn while reviewing.

## 1. Why

The owner wants staff to decide, without a code change, when TipMe pays the fees:

- "the admin sets if tipme pays individual fees, business fees, giving fees. It should also be setable per user, business or giving account" **(owner, 23 Nov)**;
- "It should be all kinds of fees" **(owner)**;
- with an **optional end date**, so a promotion turns itself off **(owner)**.

Today's rules stay the default, and nothing changes until staff set a waiver **(owner, choice B)**.

## 2. The fees in scope

| Fee                                                                                            | Who pays today                                                                                                   | Waiving it means                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tip fee**: TipMe's 5% / 3% (or a page's custom rate), processing included, taken off the tip | the recipient (their net = tip − fee)                                                                            | the recipient receives the whole tip, and TipMe pays the partner's processing (~1.5–2% on cards) itself. This already exists for one tip at a time as `priceTip({ feeFree })` (`packages/domain/src/fees.ts`) |
| **Withdrawal fee**: the partner's payout fee (~₦50)                                            | people: free for the first 2 per Lagos day, then they pay; businesses: pay unless `business_payout_fee_absorbed` | TipMe pays it on every withdrawal (`fee_payer = 'tipme'`, topped up from the platform reserve as today)                                                                                                       |
| **Giving fees** (when Giving ships)                                                            | set by the Giving pricing, still open (O2)                                                                       | TipMe pays the Giving per-gift fee and the organisation's withdrawal fee                                                                                                                                      |

Out of scope, because they're already TipMe's cost or aren't fees:

- refund and dispute fees;
- the partner fee on a Pro purchase;
- the Pro and Business Pro subscription prices.

**Businesses: withdrawal fees only (owner, choice a).** Businesses have no tip fee of their own. A team tip is charged on the staff member's page, and the business's share is a cut of what's left. To waive tip fees for a business's staff, staff set a per-account waiver on each staff member.

## 3. Approaches (owner picked 1, 23 Nov)

1. **One "who pays" rule set. Chosen.**
   - A new append-only table holds waiver rules, by kind or for one account, for the tip fee or the withdrawal fee, with an optional end date, a reason and approval.
   - The tip quote and the withdrawal fee decision both read it.
   - It replaces the `business_payout_fee_absorbed` switch.
   - `custom_fee_bps` stays for partial discounts.
2. **Extend what exists.** More switches per kind, plus end dates and flags on each account table. It's quicker, but the rules are spread over four places, and switches can't end on a date.

## 4. Rules

**Table `fee_waivers`** (append-only, like `plan_fee_rates`):

- `id`;
- `scope`: `kind` or `account`;
- `kind`: `individual`, `business` or `giving`;
- `account`: profile_id, business_id or a future giving_org_id, set when the scope is `account`;
- `fee`: `tip` or `withdrawal`;
- `payer`: `tipme`, `account` or `inherit`;
- `starts_at` (default now);
- `ends_at` (nullable);
- `reason` (required);
- `set_by`, `approved_by`, `created_at`.

A new row for the same scope, kind, account and fee replaces the earlier one from its `starts_at`. Rows are never edited **(design call)**.

How each setting is written:

- **Ending a waiver now** writes a row with `payer = inherit` (account scope) or `payer = account` (kind scope).
- **Ending a waiver on a date** writes the waiver with that `ends_at`.
- **"Follow the global setting"** on the per-account screen is `inherit`.
- **"Normal rules"** is `account`, which opts that account out of a kind-wide waiver.

**Which rule applies** to an owner, a fee and a moment:

1. **An account rule** in force (`starts_at <= now`, and no `ends_at` or `ends_at > now`) whose payer isn't `inherit`. Its payer wins.
2. **Otherwise a kind rule** in force for the owner's kind.
3. **Otherwise today's default.** For the tip fee, that's the plan rate, any custom rate and any fee-free credits. For withdrawals, it's 2 free a day for people, and the business pays.

`payer = account` on an account rule means "**this account follows the normal rules**", even while its kind is waived. That's how staff exclude one account from a kind-wide waiver **(design call)**.

**Recording it.** The rule's id is stored with what it decided, and the decision is never re-read later:

- **Tip quote:**
  - a waiver prices the tip with `feeFree: true`;
  - a new column, `tip_quotes.fee_waiver_id`, records the rule;
  - `fee_policy_version` gets the suffix `-waived-<ruleId>`;
  - `waived_platform_fee_minor` holds the fee that would have applied;
  - **a waived tip never uses up a fee-free credit (design call).**
- **Withdrawal:** `fee_payer = 'tipme'`, with the new column `payouts.fee_waiver_id`.
- **Quotes already shown keep the terms they were shown with**, even if a waiver starts or ends before payment. That's today's rule for fee changes.

**Free-withdrawal count:** a waived withdrawal still counts toward the person's 2 free a day. That doesn't matter while the waiver lasts, and when it ends the normal rule continues unchanged **(design call)**.

## 5. Money and safety

- **The ledger already handles a waived tip.** Platform fee 0 means the estimated processing is capped at 0. The real processing fee is booked to `provider_fee_expense`, as for fee-free tips today (`buildPaymentPosting`, `packages/domain/src/ledger.ts`).
- **You collect tips:** the whole tip is owed to the recipient, and TipMe's own money pays the processing. The reserve check (Task 11 of You collect) covers it; staff see its cost in §6.
- **Processing on waived tips comes from TipMe's own balance at the partner.**
  - Direct tips send no `platform_fee`, so the partner charges TipMe's platform balance. If that balance can't cover it, the partner may charge the recipient instead (ADR-0004).
  - **Auto-pause (design call):** while the latest reserve reading for the active provider is at or below its critical level, new quotes ignore tip-fee waivers and price normally.
  - Staff get one alert, "Fee waivers paused: TipMe's balance is low", and the Who-pays screen shows "Paused (low balance)" until the reading recovers.
  - Quotes already shown keep their terms.
  - The runbook says to fund the balance before approving a kind-wide tip waiver.
- **Withdrawal fees TipMe pays** come from the platform reserve top-up, as for the first 2 free withdrawals today. The reserve alerts already apply.
- **Serious actions** (same handling as `plan_fees.change`):
  - setting or ending a waiver is the new action `fee_waiver.set`, with a fresh code and a mandatory reason;
  - it needs a second approver, or a lone admin acts alone and the owners are alerted;
  - it is pinned to the rule in force, so a stale request is refused, and it is audited with the before and after.
  - Kind-wide waivers ask the approver to confirm the estimated monthly cost **(design call)**.
- **Bounds:** an end date, if given, must be in the future and within 24 months. Nothing waives retroactively **(design call)**.
- **The `business_payout_fee_absorbed` switch** is replaced. The migration writes one kind rule (`business`, `withdrawal`) matching the switch's current value, with the reason "carried over from the switch", then the switch is retired from the code and `/ops/switches`.

## 6. Staff screens

**Ops → Plan & fees → "Who pays the fees".**

```
Who pays the fees                      Cost so far this month
                Tip fee          Withdrawal fee
Individuals     Account pays     2 free a day, then account     —
Businesses      —                TipMe pays · until 31 Jan        ₦12,350
Giving          Account pays     Account pays                    (not live)
[ Change… ]   each change: who pays · optional start · optional end · reason
```

**Addendum (final review I4):** each grid cell also lists the kind-wide changes set to start later ("From 1 Dec: TipMe pays · until 12 Dec"). Choosing "Normal rules" (or "Follow the global setting" on an account) also cancels every TipMe-pays change of that key set to start later, in the same approved action: one ending row at each scheduled start, each audited, and the approver's words name the waivers it cancels.

**Per account** (the user's, business's or Giving organisation's ops page): "Fees: follow the global setting / TipMe pays / normal rules", for the tip fee and the withdrawal fee separately, each with an optional end date and the cost so far.

**Ops → Plan & fees → Waivers** lists every rule in force or upcoming, with its scope, end date, who set it, who approved it and its cost so far.

**Cost so far (design call)** is shown as two figures, never added together:

- **Fee income given up:** the sum of `waived_platform_fee_minor` on waived tips;
- **Cash paid by TipMe:** the actual processing booked to `provider_fee_expense` on waived tips, plus the withdrawal fees TipMe paid under a waiver. For a split withdrawal (per-provider design), only the one fee the account would otherwise have paid counts.

**Notices (design call):**

- When a waiver ends, staff are told the day before.
- An **account** waiver starting or ending sends that account the existing account or service notice.
- A **kind-wide** waiver sends no mass email. Affected accounts see the line on their dashboard (§7), and staff can send an announcement through the existing announcement flow if they want to.

**Addendum (owner, 27 Nov 2026; ruling R22): people are told when a waiver ends.**

- An account is told its cover ended when TipMe really stops paying that fee for it, never while TipMe still pays it. A renewal ends quietly, and so does an account waiver ending while a kind-wide waiver still covers the account: that account is told when the kind-wide one ends.
- When a **kind-wide** waiver ends (and isn't renewed), the in-app ended notice goes to each account that used its cover: at least one tip or withdrawal waived under it. An account still covered by its own waiver is told when that one ends. An account opted out of the kind-wide waiver isn't told. Still no email.
- A kind-wide waiver's **start** still tells nobody.
- The ended notice names the fee ("TipMe has stopped covering the fee on your tips. The normal tip fee applies from now."), so it is never false while the other fee is still covered. One notice per account and fee, however many rules end together.
- A tip waiver's started notice waits while tip waivers are paused (§5) and is sent once the pause lifts.

## 7. What the person sees

- **Tip page (supporters):** no change. Supporters always pay exactly the tip.
- **Recipient:**
  - the tip's fee shows as ₦0, with "TipMe is covering the fee on your tips" plus "until 31 Jan" when an end date is set, on the dashboard and on each tip's detail;
  - withdrawals show "Free".
  - Copy never names the payment partner.
- **Business:** withdrawals show "Free" while its waiver is in force.

## 7a. Other interactions

- **Moments rewards (design call):** waived tips count as neither fee income nor reward cost.
  - The rewards and ops-metrics queries exclude quotes with a `fee_waiver_id` from "reward cost" and from the lifetime cash-bonus cap.
  - "Fees since last cash" stays as it is: a waived tip simply adds 0.
  - Fee-free credits keep their own path (`waived_platform_fee_minor` without a `fee_waiver_id`).
- **Per-provider balances (approved design, #331):** build it first; this design builds on it.
  - The withdrawal fee rule is decided once per request, and a waiver makes every part `tipme`.
  - `fee_waiver_id` is stored on each part.
  - The per-provider plan's tests that use `business_payout_fee_absorbed` move to the business kind rule when this replaces the switch.

## 8. Giving

Rules for `giving` (kind or account) can be set and listed now. The Giving per-gift fee and Giving withdrawals read them once Giving is built. Until then, the screen marks them "not live". Giving's own pricing (O2) is still open and isn't decided here.

## 9. Testing

- **Unit:** rule resolution (account over kind over default, start and end boundaries, `payer = account` excluding an account) and pricing with a waiver.
- **Integration:**
  - a quote under a kind waiver and under an account waiver;
  - a waiver ending between quote and payment, so the quote is honoured;
  - fee-free credits not used up;
  - withdrawals for a person and a business under a waiver;
  - the switch migration;
  - the serious-action flow (approve, lone admin, stale);
  - cost totals.
- **E2E:** staff set a waiver with an end date; the recipient's next tip shows a ₦0 fee and the withdrawal shows "Free"; after the end date the normal fee is back.
- **UI PRs:** phone and desktop screenshots.

## 10. Left to the builder

- index choices for rule lookup;
- the cost-estimate method for the confirm step;
- the exact copy, in `packages/contracts/src/copy.ts` tone;
- how the expiry notice job is scheduled (BullMQ retention: `removeOnComplete: true`, `removeOnFail: { age: 7d }`);
- the migration number (after the latest on dev).

## 11. Open for the owner

None blocking. The design calls are listed for review:

- rows are never edited;
- `inherit` and `account` as the two ways to leave a waiver;
- auto-pausing tip waivers when TipMe's balance is low;
- showing cost as two figures;
- waived tips kept out of rewards;
- no mass email for kind-wide waivers;
- building this after per-provider balances;
- a waived tip doesn't use up a fee-free credit;
- waived withdrawals still count toward the daily 2;
- confirming the cost of kind-wide waivers;
- a 24-month limit on end dates;
- expiry notices.
