# You collect: TipMe collects tips, recipients verify at first withdrawal (design)

**Date:** 19 Nov 2026 · **Status:** design for the owner's approval · **Base:** `origin/dev` at `ae196293`

**Who reads this.** The owner approves it. A builder writes the plan from it. Sections marked **(engineering)** are for the builder; the rest is written for everyone. Users never see the provider's name: in the product it is always "our payment partner". This staff document calls the partner Bachs.

**Not an approval.** This is a product and design decision. It is not legal, tax, regulatory or payment-partner approval. **D-04 (custody) and D-06 (recipient verification) stay OPEN** in `docs/00-DECISIONS.md`, and this document does not edit that file. AGENTS.md's hard stop still applies: no real payments on this flow until an accepted ADR records it and the switch in section 12 is turned on by the owner.

**How decisions are marked.**

- **(owner decided)**: the owner's words or ruling. Binding.
- **(recommended, owner may change)**: Claude's recommendation. The owner delegated these on 19 Nov; they ship unless the owner changes them.
- **(builder's call)**: the builder decides within the rules given and says what they chose in the PR.

**Sources.** The owner's message of 19 Nov 2026. Partner docs, re-read on 19 Nov 2026: `docs.bachs.io/connect/choose-your-integration`, `/connect/requirements`, `/connect/capabilities`, `/connect/transfers`, `/connect/refunds`, `/connect/disputes`, `/connect/balances`, `/build/use-cases/escrow`, `/for-you/fees`, and the docs search at `mcp.bachs.io/docs`. Code on `origin/dev`. Earlier decisions: final pricing (12 and 18 Nov), business option B (11 Nov), refunds (14 Nov), ADR-0004, ADR-0006, ADR-0014.

---

## 1. Intent and why

Today every recipient must finish full verification before anyone can tip them: a selfie video, their NIN and their BVN. Until then their page cannot take a tip; the server refuses with `PAYMENT_ACCOUNT_REQUIRED`. This is the biggest drop-off at sign-up.

**The change.** For new recipients, the supporter pays **TipMe**, not the recipient. TipMe keeps the recipient's share for them and sends it to them. The recipient proves who they are only when they first withdraw, and then only lightly: **their name, plus a bank account in their own name**. No selfie, no NIN, no BVN.

**Owner's decision (19 Nov 2026, owner decided).** Recipients must no longer finish full verification before they can receive tips. Our payment partner advised its "You collect" model. In the owner's words: _"it is covered by the provider's licence they advised we use this method. You sorted to answer the rest based on what's recommended for our setup."_ This records **the owner's statement** about the partner's licence. Nobody has checked it against an agreement or a legal opinion. Section 15 asks the partner to put its advice in writing.

**What the partner's docs say about the two models** (from `/connect/choose-your-integration`, 19 Nov):

|                                   | **You collect** (new)                        | **The account collects** (today)    |
| --------------------------------- | -------------------------------------------- | ----------------------------------- |
| Who the supporter pays            | TipMe (merchant of record)                   | The recipient                       |
| Where the money lands             | TipMe's partner balance                      | The recipient's partner balance     |
| How the recipient is paid         | TipMe transfers their share after it settles | The payment is already theirs       |
| What the recipient must provide   | Name + bank account in their name            | Selfie video, NIN, BVN, occupation… |
| Who pays a refund or lost dispute | **TipMe**                                    | The recipient                       |

**The trade-off in one line.** Sign-up becomes easy, and TipMe takes on every refund and lost dispute, and holds other people's money in its own balance. Most of this document is about doing that safely.

## 2. What people see, step by step

### 2.1 The recipient (new sign-up on You collect)

1. **Sign up and share.** They choose a username and their page is live at once. No verification step. The dashboard shows a short line: "You can take tips now. Add your bank details when you want to withdraw."
2. **First tip.** They get today's notification. Their balance shows the amount, with the note "Kept for you until you add your bank details."
3. **Reminders** (recommended, owner may change). If they have money waiting and no bank details: an in-app notice and an email at **7, 21 and 28 days** after their first waiting tip. Day 28 says the page will pause in 2 days.
4. **"Add bank details to withdraw."** Tapping Withdraw with no bank details opens one short form:
   - their full name, as their bank has it;
   - bank (list) and account number.

   TipMe looks up the name on the account (today's bank lookup) and shows it: "Is this you? ADA OKAFOR". They confirm. TipMe sends it to our payment partner, who compares the bank's name with theirs.

5. **Checking.** "We're checking your details. This usually takes a few minutes." Three outcomes:
   - **Names match:** "You're all set." Their waiting tips start moving to them (section 5). Withdraw works as today.
   - **Some words match:** the partner's team checks it. "We're checking this by hand. We'll tell you when it's done."
   - **No match:** "This account isn't in your name. Use a bank account in your own name." Nothing is saved.
6. **Withdraw.** Today's withdrawal screen and rules (two free withdrawals per Lagos day, then the partner's ₦50). Money still on its way to them shows as "On its way" and is not withdrawable yet. For a new recipient the first withdrawal is capped (section 8).
7. **The holding cap is reached** (recommended, owner may change): once **₦50,000** is waiting, or **30 days** have passed since the first waiting tip, whichever comes first, their page stops taking new tips. Dashboard banner: "Your page has paused tips. Add your bank details to start taking tips again." Adding bank details unpauses it at once.

**Name lock** (recommended, owner may change). The name on the verified bank account becomes the name TipMe pays. Changing it later goes through support.

### 2.2 The supporter

Nothing changes in the tip form, amounts, fees shown or receipt layout. Two differences:

- **The card statement shows TipMe**, because TipMe is the merchant of record. The receipt says "Paid to TipMe for Ada" (copy in section 10).
- **A paused page** (holding cap reached) shows: "Ada can't take tips right now. Please try again later." No reason is given, to protect the recipient's privacy.

### 2.3 Existing recipients

Recipients whose accounts are already ready keep today's flow and see no change (section 11).

## 3. Money flow

### 3.1 You collect (new)

```
Supporter ──pays ₦10,000──▶ TipMe's partner balance
                              │  partner keeps its processing fee (e.g. card 2% = ₦200)
                              │  TipMe's fee (Free 5% = ₦500, processing included) stays here
                              │
                              │  recipient has bank details and `transfers` is active?
                              ├── yes ─▶ transfer ₦9,500 as soon as it settles ─▶ recipient's
                              │                                                    partner balance
                              │                                                       │ withdraw
                              │                                                       ▼
                              │                                                  recipient's bank
                              └── no ──▶ held in TipMe's balance (counted as "held for recipients")
                                         until bank details are verified, then transferred
```

### 3.2 The account collects (today, unchanged)

```
Supporter ──pays ₦10,000──▶ recipient's partner balance (direct charge, `X-Account-Id`)
                              │  platform fee ₦500 ──▶ TipMe's partner balance
                              │  processing fee: charged to the platform where set up (ADR-0004)
                              ▼
                       recipient withdraws ──▶ recipient's bank
```

**Fees** (owner decided, 18 Nov). Unchanged: Free 5% and Pro 3% per tip, processing and payout fees included; the first two personal withdrawals per Lagos day are free. **Margin note:** on a Pro tip paid by a Nigerian card (2% processing) TipMe keeps about **1%** (₦20 on a ₦2,000 tip) before any refund, dispute or the ₦50 payout fee it pays on free withdrawals. Under You collect, refunds and lost disputes also come out of that margin.

## 4. Ledger: money held for recipients versus TipMe's own **(engineering)**

The ledger (`packages/domain/src/ledger.ts`, ADR-0006) is already custody-neutral: `recipient_payable` is what TipMe owes each person, and `platform_clearing` is TipMe's own partner balance (added for Pro). You collect adds one asset account. Codes stay illustrative pending finance sign-off, as ADR-0006 says.

- **New `held_for_recipients`** (asset, per profile): money sitting in TipMe's partner balance that belongs to a recipient and has not been transferred yet.

**Payment posting on You collect** (a variant of `buildPaymentPosting`; same credits as today):

| Line                     | Side   | Amount                                                                          |
| ------------------------ | ------ | ------------------------------------------------------------------------------- |
| `held_for_recipients`    | debit  | recipient net                                                                   |
| `platform_clearing`      | debit  | platform fee + quoted provider fee − actual provider fee (a credit if negative) |
| `provider_fee_expense`   | debit  | actual provider fee                                                             |
| `platform_fee_revenue`   | credit | platform fee                                                                    |
| `provider_fee_recovered` | credit | quoted provider fee                                                             |
| `recipient_payable`      | credit | recipient net                                                                   |

The recipient's net is exactly what the quote promised, as today. Note that an international card (2% + 1.5%) can cost more than a Pro 3% fee, which makes TipMe's line a credit.

**Transfer posting** (when the partner reports the transfer `paid`): debit `provider_clearing` (now in the recipient's own partner balance), credit `held_for_recipients`, both for that profile. `recipient_payable` does not move: TipMe still owes nothing new, the money has only changed place. Withdrawal postings are today's.

**The rule (hard invariant).** For NGN, at every check:

```
partner platform available_balance  ≥  Σ held_for_recipients
```

TipMe's own money in the balance is the difference. It is what pays refunds, dispute fees, lost disputes, payout fees and Pro refunds. Consequences:

- TipMe never withdraws its own earnings below the held total. Any platform withdrawal is refused if it would break the rule.
- **Automatic payouts on TipMe's platform balance must be off**, or held money could leave with TipMe's earnings (the partner's escrow guide says the same). The builder checks it and the reserve check alerts if it changes.
- The partner sets a disputed amount aside from available balance while a dispute is open. That set-aside lowers TipMe's own figure, not the held total.

## 5. Transfer at settlement **(engineering)**

**When a share moves** (recommended, owner may change). As soon as the tip has settled and the recipient's `transfers` capability is `active`. Naira payments are available at once (`/for-you/fees`, escrow guide); transfers draw only on `available_balance`, so an early send fails with `INSUFFICIENT_BALANCE` and is simply retried. TipMe holds money only for people with no verified bank details yet, or inside the new-recipient delay (section 8).

**One row per tip** in a new `collect_transfers` table, modelled on `share-transfers.ts`:

```
waiting ──(settled, capability active, delay passed)──▶ ready ──claim──▶ sent ──▶ paid
   ▲                                                       │               │
   └──────────── capability lost / FORBIDDEN ◀─────────────┘               ├──▶ refused (retry or review)
                                                                           └──▶ unknown ──read back──▶ paid | ready
cancelled (refund or dispute took the share before it moved)
```

- **Idempotent.** The idempotency key is `tipme-collect-<tipId>`; `transfer_group` is set to the same value (as `transferToAccount` in `packages/payments/src/bachs/payouts.ts` already does), so a read-back finds exactly this transfer. The tip id is stored on our row: the partner's list cannot filter by group, so our record is the link from tip to transfer (`/connect/transfers`).
- **Claimed before sending.** `ready → sent` is a conditional update that one worker wins, committed before the partner is called. A crash or lost answer leaves `sent`, which is resolved by retrying with the same idempotency key inside the partner's 24-hour window, or after it by listing the account's transfers and matching `transfer_group`. Never a blind new send.
- **Triggers:** the tip's verified payment event; `capability.updated` making `transfers` active; the new-recipient delay ending; and a sweep every few minutes (builder's call) that picks up anything `waiting` or `ready` it missed.
- **Order.** Oldest tip first per recipient. When a recipient with a backlog verifies, their held tips move one transfer each, rate-limited (builder's call).
- **Errors:** `INSUFFICIENT_BALANCE` → back to `ready` with backoff; alert staff if a ready share has waited more than an hour. `FORBIDDEN` (capability not active) → `waiting`. `ORGANIZATION_IN_DEBT` → stop all collect transfers and raise a critical alert (section 6.3). `NOT_FOUND` or a mismatched answer → `review`, money issue opened.
- **Ledger:** the transfer posting (section 4) is written in the same transaction that records `paid`.
- **Reuse:** `transferToAccount`, the `moneyWrite` refusal handling, the read-back in `payouts.ts`, the outbox, `openIssue`.

## 6. Refunds and disputes

### 6.1 Refunds

**Rule today** (owner decided, 14 Nov): the supporter gets back the tip minus TipMe's fee; the recipient gives back what they received; TipMe keeps its fee. Refunds go only through the staff "Refund tip" tool. Bank-transfer payments cannot be refunded by the partner.

Under You collect the refund comes out of **TipMe's** balance (`/connect/refunds`), through `refundPlatformCharge` (`packages/payments/src/bachs/provider.ts`). The recipient's part is recovered first:

1. **Share still held:** the collect transfer is cancelled; nothing moves to the recipient.
2. **Share transferred, still in their partner balance:** TipMe sends a transfer back (`X-Account-Id`, `destination: "self"`, `collectToPlatform`), key `tipme-collect-back-<refundId>`, then refunds.
3. **Share already withdrawn** (recommended, owner may change): the tool stops and asks staff to decide. Going ahead is a serious action, and TipMe absorbs the gap. A refund is voluntary, so the partner refuses it rather than create a debt; there is no reason for TipMe to take that risk without a person deciding.

A refund the platform balance cannot fund is refused by the partner (`Insufficient balance to refund`); the tool shows that and nothing moves.

### 6.2 Disputes (new; today they are not modelled at all: `webhooks.ts` handles no dispute event)

**What the partner does** (`/connect/disputes`, `/for-you/fees`): on a You collect tip the dispute is TipMe's. When it opens, the partner charges a flat **$15 dispute fee** at once, **kept even if TipMe wins**, and sets the disputed amount aside from TipMe's available balance. An early dispute warning costs $29 per payment. A lost dispute takes the amount from available, then pending, then drives the balance negative.

**What TipMe builds:**

- Handle `dispute.created` and `dispute.updated` (authenticated, stored, deduplicated, out-of-order safe, as every webhook).
- A `disputes` table: partner dispute id, tip, amount, currency, reason, status, response deadline, evidence state, the fee, and the amount set aside.
- **On open:** post the fee (`dispute_fee_expense` against `platform_clearing`). Stop the tip's collect transfer if it has not moved. If it has moved and is still in the recipient's balance, place a withdrawal hold of that amount (existing `withdrawal_holds`), and tell the recipient: "A payment to you is being questioned. We've held ₦9,500 until it's settled." (recommended, owner may change)
- **Staff respond** from a new dispute screen (evidence upload and submit through the partner's dispute API) before the deadline.
- **Won:** release the hold or the held share; the fee stays an expense.
- **Lost** (owner's delegated default): recover from **that recipient's unpaid TipMe balance first**: the held share, then a transfer back of what is still in their partner balance. **TipMe absorbs the rest** (`dispute_loss_expense`). Their future tips are not touched (recommended, owner may change). The 14 Nov chargeback rule carries over: the recipient never loses more than they received for that tip.

### 6.3 The dispute reserve and the freeze

**Why it matters.** A negative balance in any currency blocks **every** transfer and withdrawal for that party with `ORGANIZATION_IN_DEBT` (`/connect/balances`). On You collect that party is TipMe: one unfunded lost dispute or dispute fee stops every recipient's share from moving until it clears.

**Reserve alerts** (recommended, owner may change; admin-settable). "TipMe's own money" = available NGN − held for recipients. Warning below **₦500,000**, critical below **₦250,000**. This extends today's payment-reserve check (`packages/database/src/operations/payment-reserve.ts`, every 15 minutes). At critical: staff are paged, TipMe's own platform withdrawals are refused, and the owner is emailed. Below zero (the invariant in section 4 is broken): a critical money issue, and new You collect sign-ups pause until staff clear it.

The dispute fee is priced in dollars. Whether it is taken from TipMe's NGN or USD balance is not documented; if it is the USD balance and that balance is empty, the fee alone could cause the freeze. This is question P5 for the partner, and the reserve check watches every currency TipMe's balance holds.

## 7. Reconciliation **(engineering)**

- **Every reserve check (15 min):** the invariant in section 4, per currency; any negative balance in any currency (critical).
- **Daily:** for each You collect recipient, the partner's transfers (`GET /v1/transfers?connected_account_id=`) against our `collect_transfers` rows by `transfer_group`: missing, extra, or a different amount opens a money issue. Partner disputes list against ours. Platform balance activity (fees, dispute fees, refunds) against ledger lines.
- **Per tip:** a tip is fully reconciled when its payment is verified, its share is `paid` or `cancelled` with a matching posting, and no dispute is open.
- Reuse the payment stuck-unknown runbook pattern (`docs/runbooks/payment-stuck-unknown.md`); the builder adds a "collect transfer stuck" section.

## 8. Fraud guards

The main new risk: someone signs up, takes tips with stolen cards, adds a bank account and withdraws before the disputes arrive. Under You collect TipMe pays for it. Guards (recommended, owner may change; all admin-settable):

| Guard                               | Default                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| New-recipient delay                 | For the first **7 days** after sign-up, each tip waits **24 hours** before its transfer |
| First withdrawal cap                | The first withdrawal is at most **₦50,000**                                             |
| Daily limit for new accounts        | For the first **30 days**, at most **₦200,000** withdrawn per Lagos day                 |
| Holding cap                         | **₦50,000** held or **30 days**, then the page pauses (section 2.1)                     |
| Bank account in own name            | Checked by the partner; no-match is refused                                             |
| Name lock                           | The verified name changes only through support                                          |
| Same bank account on two recipients | Flagged to staff; transfers to the second wait for review (builder's call on detection) |

Today's withdrawal holds, staff serious actions and the issues inbox are reused. Recipients see neutral copy: "New accounts have a limit on their first withdrawal."

## 9. Admin settings and staff screens

**Settings** (admin, audited, alert to owners on change, as the plan-fee settings of 18 Nov):

| Setting                    | Default              | Bounds (builder may propose) |
| -------------------------- | -------------------- | ---------------------------- |
| Holding cap, amount        | ₦50,000              | ₦10,000 – ₦500,000           |
| Holding cap, days          | 30                   | 7 – 90                       |
| Reminder days              | 7, 21, 28            | each below the cap days      |
| New-recipient delay        | 24 h for 7 days      | 0 – 72 h, 0 – 30 days        |
| First withdrawal cap       | ₦50,000              | ≥ the minimum withdrawal     |
| New-account daily limit    | ₦200,000 for 30 days | —                            |
| Reserve warning / critical | ₦500,000 / ₦250,000  | critical < warning           |

**Switch:** `you_collect` (a money switch in `/ops/switches`, two staff, off by default; section 12).

**Staff screens** (in `/ops`, with today's masking rules):

- **Held money:** total held, per recipient (amount, oldest tip, days left, reminders sent, paused or not).
- **Collect transfers:** queue by state, with retry and "send to review" actions.
- **Disputes:** open disputes with deadline, evidence and submit; history.
- **Reserve:** TipMe's own money against the alert levels, per currency.
- **Unclaimed:** recipients past the holding cap, for staff follow-up (no automatic action, section 15).
- **Collection mode** on the user page: "You collect" or "Account collects", read-only.

## 10. Copy (user-facing)

Never name the partner. Never say "wallet", "account with TipMe", "protected", "insured" or anything implying a licence or a bank.

| Where                  | Text                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| Dashboard, no bank yet | "You can take tips now. Add your bank details when you want to withdraw."       |
| Balance note           | "Kept for you until you add your bank details."                                 |
| Withdraw, no bank      | "Add bank details to withdraw" · "Use a bank account in your own name."         |
| Name confirm           | "Is this you? {BANK NAME}"                                                      |
| Checking               | "We're checking your details. This usually takes a few minutes."                |
| Manual check           | "We're checking this by hand. We'll tell you when it's done."                   |
| Name mismatch          | "This account isn't in your name. Use a bank account in your own name."         |
| Verified               | "You're all set. Your tips are on their way to you."                            |
| On its way             | "On its way to you"                                                             |
| Reminder, day 7 / 21   | "You have {amount} in tips waiting. Add your bank details to withdraw it."      |
| Reminder, day 28       | "Add your bank details by {date}, or your page will pause new tips."            |
| Paused (recipient)     | "Your page has paused tips. Add your bank details to start taking tips again."  |
| Paused (supporter)     | "{Name} can't take tips right now. Please try again later."                     |
| Receipt                | "Paid to TipMe for {Name}"                                                      |
| First withdrawal cap   | "New accounts can withdraw up to {amount} the first time."                      |
| Dispute hold           | "A payment to you is being questioned. We've held {amount} until it's settled." |

The Terms and the supporter-facing fee and refund wording need updating for TipMe as the merchant of record. That wording needs legal review; this document does not write it.

## 11. Migration and coexistence **(engineering)**

- **Collection mode per recipient**: `direct` (today) or `collect`, stored on the person, and copied onto each tip quote so a tip always follows the mode it was quoted under. Checkout branches on it: `direct` keeps `initializePayment` with `X-Account-Id` (`provider.ts`); `collect` uses a tip variant of `initializePlatformCheckout` with the same quote, fee and naira-only methods.
- **Who gets which** (recommended, owner may change): with the switch on, **new sign-ups get `collect`**. **Existing recipients with a ready account keep `direct`**. Existing recipients who never finished verification cannot take tips today; they move to `collect` (they gain the most).
- **Receive-only account for a person.** `createReceiveOnlyAccount` (`provider.ts`) is company-only today; the builder adds an individual version requesting only `payouts` and `transfers`. Whether it is created at sign-up (empty) or at the first "add bank details" depends on partner question P4.
- **No moving direct recipients to collect** in this work. Today's direct accounts also request `transfers`, so a later move is possible.
- **Businesses stay on option B** (recommended, owner may change). A tip with a business share to a `direct` staff member works exactly as today. For a `collect` staff member the tip is already in TipMe's balance, so option B's first leg (staff → TipMe) is skipped and only its second leg (TipMe → business) runs; the business sees no difference. Moving businesses themselves is a later step. Team tips are unchanged and stay behind their own switch.
- **Withdrawals, payout-start and holds** work on the recipient's own partner balance in both modes and are reused unchanged, plus the new caps.
- **ADR.** A new **ADR-0016 "You collect for new recipients"** records this funds flow and the two modes, amends ADR-0004 decision 8 and its option 3 ("TipMe-controlled collection… not approved"), and states that D-04 and D-06 stay open. It is PROPOSED until the owner accepts it.

## 12. Rollout

1. ADR-0016 accepted by the owner.
2. Build behind the `you_collect` money switch, **off in every environment** at merge.
3. **Sandbox and staging.** All tests in section 13, plus scripted sandbox runs (test money only). The sandbox grants capabilities at once and does not run the bank-name check (`/connect/capabilities`, `/connect/requirements`), so it **cannot prove live behaviour**: verification timing, manual review, live settlement and dispute fees are only known from the partner's written answers and a careful live start.
4. **Production stays off** until the owner turns it on in `/ops/switches`. Recommended start: on for new sign-ups, with staff watching the held-money and reserve screens daily for the first two weeks, and TipMe's own balance topped up above the warning level first.
5. **Turning it off** stops new sign-ups getting `collect`. Recipients already on `collect` keep it, and their transfers keep running: their money is owed. Staff can pause collect transfers in an emergency (a serious action).

## 13. Tests the plan must include

- **Ledger:** the You collect payment posting balances for Free, Pro, local card, bank transfer, and an international card where TipMe's line flips; the transfer posting; refund and dispute postings; property test that every posting balances.
- **Invariant:** a platform withdrawal that would take available below held is refused; the reserve check flags a breach and each currency going negative.
- **Transfer machine:** exactly-once under concurrent workers; crash after claim then read-back by `transfer_group` (found and not found); same-key retry inside 24 hours; `INSUFFICIENT_BALANCE`, `FORBIDDEN`, `ORGANIZATION_IN_DEBT`, `NOT_FOUND` and a mismatched amount; out-of-order `capability.updated`; backlog release on verification, oldest first.
- **Guards:** 24-hour delay inside and after 7 days; first-withdrawal cap; daily limit across the Lagos day boundary; holding cap by amount and by days; unpause on verification; reminders sent once each at 7, 21 and 28 days.
- **Refunds:** share held; share transferred and still there; share withdrawn (stops for staff); refund refused for low balance; bank-transfer tip not refundable.
- **Disputes:** created → won (fee kept, hold released); created → lost with full, partial and no recovery; duplicate and out-of-order events; dispute fee taking a balance negative.
- **Coexistence:** a `direct` recipient's tip is unchanged byte for byte at the provider request; mode copied onto the quote is honoured after the person's mode changes; option B with a `collect` staff member runs only the second leg.
- **Switch:** off means today's behaviour everywhere; turning off keeps existing `collect` recipients working.
- **Webhooks:** dispute events authenticated, stored and deduplicated.
- **UI:** the add-bank-details flow, paused page and receipt at phone and desktop, keyboard and screen reader; screenshots in the PR.

## 14. Non-goals

- Moving existing direct-charge recipients to You collect.
- Moving businesses off option B, or changing team tips.
- Automatic refunds of unclaimed money (waits for partner question P3).
- Recovering losses from a recipient's future tips.
- Any change to fees, the minimum tip, the minimum withdrawal or VAT treatment (VAT unchanged pending the owner's accountant).
- Writing the Terms or any legal wording.
- Any regulatory, licensing or custody approval.

## 15. Open questions

**For the partner** (recommended: ask for the answers by email, so they are on record):

- **P1.** Please confirm in writing that You collect, with TipMe as merchant of record holding recipients' shares before transfer, is covered by your licence for TipMe's tipping use case.
- **P2.** Is there any fee on a transfer from the platform to an account? None is documented.
- **P3.** What is the longest TipMe may hold a recipient's share? What should happen to money a recipient never claims (refund to the supporter, or something else)? The escrow guide says money can be held "as long as the deal needs".
- **P4.** Can a receive-only account for a person be created empty at sign-up and verified (name + bank account) at the first payout? Or should it be created only then?
- **P5.** Which balance and currency is the $15 dispute fee (and the $29 early warning) taken from on an NGN payment? Can it drive a USD balance negative and freeze NGN transfers?
- **P6.** How long does a "some words match" manual review usually take?
- **P7.** Confirm naira card payments are available for transfer at once in live mode, as the docs say.
- **P8.** Are there rate limits on transfers when many held tips are released together?

**For the accountant:**

- **A1.** With TipMe as merchant of record, is VAT due on the whole tip or only on TipMe's fee? (Treatment stays unchanged until answered.)
- **A2.** How should money held for recipients, and unclaimed money, be shown in TipMe's books?
- **A3.** How are dispute fees and losses TipMe absorbs treated?

**For the owner** (defaults ship unless changed): every "(recommended, owner may change)" item above, in particular the holding cap, the reminders, the fraud guards, what a supporter sees on a paused page, moving never-verified existing recipients to You collect, and option B's single leg for `collect` staff.

## 16. Risks

1. **One negative balance freezes everyone.** A lost dispute or a dispute fee that TipMe's own money cannot cover makes the balance negative, and `ORGANIZATION_IN_DEBT` then blocks every transfer to every recipient until it clears. Mitigation: the reserve alerts, keeping TipMe's own money well above the warning level, the currency question P5.
2. **TipMe carries every refund and lost dispute, on a thin margin.** About 1% is left on a Pro card tip before disputes; each dispute costs $15 even when won. Stolen-card tips to fresh accounts are the main way to lose money. Mitigation: the new-recipient delay and caps (section 8), recovery from unpaid balance first, staff decision on refunds after withdrawal.
3. **The legal basis rests on the owner's statement.** TipMe becomes merchant of record and holds other people's money in its own balance. That this is covered by the partner's licence is the owner's statement, not a checked agreement or legal opinion. D-04 and D-06 stay open. Mitigation: P1 in writing before production; Terms reviewed.
4. **Held money mixed with TipMe's money.** One partner balance holds both. A mistaken withdrawal or an automatic payout could spend recipients' money. Mitigation: the invariant, refusing platform withdrawals below it, automatic payouts off and watched.
5. **Unclaimed money has no end state** until the partner answers P3; the pause after 30 days limits how much builds up.
6. **Two flows to keep right.** Every money path (checkout, refunds, disputes, reconciliation, business shares) now has two branches. Mitigation: the mode is fixed on each tip, and tests cover both branches.
7. **Sandbox cannot prove live behaviour** (capabilities granted at once, no bank-name check). Mitigation: written partner answers, a watched live start.
