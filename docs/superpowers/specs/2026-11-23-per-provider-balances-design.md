# Withdrawing money held at more than one payment provider

**Status:** design, awaiting the owner's approval (23 Nov 2026)
**Builds on:**

- ADR-0004 §6 (existing payments keep their provider);
- ADR-0006 (custody-neutral ledger);
- ADR-0016 (You collect);
- `2026-10-30-payment-provider-switching-design.md` (switching, awaiting approval).
  **Must ship before:** any second real payment provider, any partner switch, or any per-account payment provider override.

**(owner)** marks what the owner decided. **(design call)** marks a choice this document made, which the owner can overturn on review.

## 1. Why

A person's or business's tips can come in through more than one payment provider. That happens after a partner switch, with a second partner, or with a per-account override. Each provider holds that money in the person's own account **at that provider**.

TipMe's ledger keeps one total per owner and records no provider. So today, if any successful tip came through a provider other than the configured one, the withdrawal quote refuses with `provider_unavailable` and every withdrawal is blocked (`collectedElsewhere`, `packages/database/src/operations/payouts.ts:1166-1186`, checked in `quoteGate` :1611 and twice in `requestFor` :1905 and :1996). That includes the money at the provider we can still reach. The screen says the balance "stays here until withdrawals open", but nothing ever opens them. Support can't fix it either.

On staging this is test data: thesavioureking has 13 sandbox-partner tips (₦16.6M) and 3 pretend-provider tips (₦36k). With real money, it would strand recipients.

## 2. Goals, non-goals, anti-goals

**Goals**

1. **One balance, one Withdraw button (owner).** The person never chooses a provider. One request may be paid out as more than one bank payment; the screens say so ("This may arrive as 2 payments").
2. **Every naira owed is withdrawable** through the provider that holds it, as long as that provider is still connected.
3. **An old provider can be kept in withdraw-only mode:** no new tips, but payouts, refunds, disputes and reconciliation still work, until the money there runs out. Then staff retire it.
4. **Staff can see split accounts:** each split owner's per-provider position, plus a daily check that flags when the ledger and the providers disagree.
5. **The same rules for individuals and businesses,** and for Pro paid from the balance.

**Non-goals**

- Putting a provider on ledger entries (option 2 below). It stays possible later.
- Moving money between providers (a provider-to-provider transfer).
- Adding a second real provider, or the switching UI. That work is separate and depends on this.
- Choosing which provider takes new tips. That stays as today: the configured provider, later the switching design.

**Anti-goals**

- Paying out more than the ledger says an owner is owed in total. (Approach 1 has no per-provider "owed", so there is no per-provider promise; §5a covers a provider going negative.)
- Paying the same money twice, through two providers or through two requests at once.
- A withdrawal that half-succeeds with the person not told which part arrived.
- Naming a provider to users. Staff screens may name them.

## 3. Approaches (owner picked 1, 23 Nov)

1. **Each provider's real balance is the per-provider truth, and the ledger total is the cap. Chosen.** This extends today's single-provider rule, withdrawable = min(ledger, partner − queued), to each provider in turn. It needs no ledger change and no history rewrite. The worker already starts and reconciles payouts through each payout row's own provider (`providerFor(payout.provider)`, `apps/worker/src/job-worker.ts:605-645`).
   - Cost: one balance read per provider per quote; the books stay per owner, not per provider.
   - A daily check (§7) covers the gap.
2. **A provider dimension on the ledger.** Each owner's payable is split per provider. This gives the most exact books, but every posting builder and about 15 balance readers change, and history must be back-filled. That's high risk to the money core.
3. **Derive per-provider positions from the money rows** (attempts, payouts, refunds and so on). No ledger change, but it duplicates the ledger in a second place that can drift from it.

## 4. Provider roles

Each payment provider the API and worker know has one role **(design call)**:

| Role             | New tips | Withdrawals, Pro from balance | Refunds, disputes, reconciliation, webhooks |
| ---------------- | -------- | ----------------------------- | ------------------------------------------- |
| `active`         | yes      | yes                           | yes                                         |
| `withdraw_only`  | no       | yes                           | yes                                         |
| (not configured) | no       | no                            | no (as today)                               |

- **Configuration:**
  - `PAYMENT_PROVIDER` stays the active one;
  - a new setting, `PAYMENT_WITHDRAW_ONLY_PROVIDERS` (comma list, default empty), names the withdraw-only ones, using the same names as `PAYMENT_PROVIDER` (e.g. `bachs-sandbox`);
  - when the switching design is built, both move to `provider_settings`.
- **Production** refuses `mock` in either list, as today.
- **One environment per partner per deployment (design call):** `bachs-sandbox` and `bachs-live` both record as `'bachs'`, and the money tables have no environment column, so the two can't be told apart. Config refuses a withdraw-only provider with the same recorded name as the active one in a different environment. A deployment never holds sandbox and live money of the same partner at once. Moving one deployment from sandbox to live with money still at sandbox is out of scope; it would need an environment column on the money tables.
- **Wiring:** the API builds an adapter for every provider in either role. Today it builds only the configured one for withdrawals: `WITHDRAWAL_PROVIDER_TOKEN`, `apps/api/src/checkout/payment-provider.provider.ts:133-153`. The worker already builds mock and Bachs; it must follow the same list.
- **Retiring:** a withdraw-only provider can be removed from the list once the ops screen (§7) shows no owner with money there and nothing open (payouts, refunds, disputes) through it for 30 days **(design call)**. Removing it early brings back today's block for anyone with money there; §6 covers what they see.

## 5. Quote and request

**The owner's provider set** is the configured providers (active and withdraw-only) at which the owner has an account reference, or which took any of their successful tips. For a business, that's tips carrying its share, as `collectedElsewhere` does today.

**Quote** (`quoteFor`, payouts.ts:1665): the same gate as today (switch, holds, below-zero balance, You collect limits), then:

```
remaining = ledger available (balanceQuery, unchanged)
for each provider P in the owner's set, withdraw-only first (oldest first), active last:
    route_P = payoutRoute(owner, P)            # account reference + destination at P
    if route_P blocked: part_P = blocked(reason); continue
    avail_P = max(0, partnerBalance_P − queued_P)   # queued: REQUESTED with no provider ref, at P
    take_P = min(remaining, avail_P)
    remaining -= take_P
withdrawable = Σ take_P
```

- **Drain order (design call):** withdraw-only providers go first, so old providers empty and can be retired.
- **A failed read at one provider** doesn't block the others: that provider's part counts as 0, the quote is marked `partial`, and the screen says "Some of your balance can't be withdrawn right now" (§6).
- **The cache** (`partnerStamp`, payouts.ts:1290-1460) stays per `{provider, owner}`, as today.
- **Blocked route:** if the owner's route at a provider is blocked (no account reference, manual payouts off, or no destination there), that provider's money is shown as needing action, never silently dropped.

**Request** (`requestFor`, payouts.ts:1850):

- Under the owner lock, recompute the same allocation for the requested amount.
- **Use as few payouts as possible (design call):**
  - if one provider can cover the whole amount, use a single payout at that provider, preferring the drain order;
  - otherwise split in drain order;
  - **Minimum (answered by the owner's 14 Nov rule):** the minimum is TipMe's withdrawal minimum, equal to the minimum tip (`belowWithdrawalMinimum`, payouts.ts:1973). Its exception, "taking all that can be taken is always allowed so nobody is left with money they can't withdraw", applies **per provider part**: a part that empties a provider may be below the minimum. Otherwise a part below the minimum is avoided by taking more from that provider or less from the next one. Small leftovers at old providers can always leave, so the retire check can reach zero.
- **Recording:** insert one `payouts` row per part, each with its own `provider`, `account_reference` and `destination_id`, linked by a new `withdrawal_group_id` (uuid, nullable; single-provider withdrawals may leave it null or set it, the builder's call). Each part is enqueued as today.
- **Same money twice:** the existing reservation (payouts in REQUESTED or PROCESSING count against available) applies to every part, and `queued_P` is computed per provider, so two requests at once can't spend the same money.
- **Idempotency:** the request's Idempotency-Key covers the whole group. A repeat returns the same group.
- **Fees:**
  - one request counts as one of the person's free withdrawals per Lagos day (`FREE_WITHDRAWALS_PER_DAY`, payouts.ts:1733-1752), however many parts it has **(design call)**;
  - when the person pays a fee (from their 3rd withdrawal of the day), they pay it once, taken off the **largest** part, so the small parts never fall below the fee **(design call)**;
  - every other part's provider fee is TipMe's cost (`provider_fee_expense`), topped up from TipMe's platform reserve at that provider exactly as a TipMe-paid fee is today (`feePayerFor`, payouts.ts:1764-1789);
  - **therefore** TipMe keeps a funded platform reserve at every withdraw-only provider while it drains, and the reserve alerts cover withdraw-only providers too **(design call)**;
  - **businesses (owner, 23 Nov):** a split never costs a business more than one fee. The business pays one fee under its existing rule (12 Nov, or none while `business_payout_fee_absorbed` is on), off the largest part, and TipMe pays every other part's fee.
  - **Who pays at all** stays as today (owner chose B, 23 Nov). A separate design adds admin and per-account controls for who pays; this design reads that rule through `feePayerFor` and doesn't fix it.
- **The first-withdrawal cap and daily limit** of You collect (`refuseOverCollectLimits`) apply to the request total.

**5a. A provider going negative.**

- **The scenario:** a refund or dispute lands at provider P after P's money was already withdrawn, for example in drain order, while the person still has money at Q.
- **What happens:** the ledger total drops, as today, and caps every later quote. If it goes below zero, the existing below-zero rule (Q8, payouts.ts:1606) blocks withdrawals until it's back above zero.
- **What the daily check does:** it flags P as short (`provider_split_short`).
- **Recovery (design call):** none automatic across providers. Staff see the issue, and P's shortfall is covered the way a single-provider reversal after a payout is covered today (TipMe's own balance at P, then recovery from the person's future tips through the ledger).
- **Risk:** this is no worse than today's single-provider case; a split only changes which provider's account shows it.

**Failures:**

- Each part succeeds or fails on its own, through the existing payout states.
- A failed part releases its reservation, as today, so that money is withdrawable again.
- The group shows as "partly sent" until every part settles.
- Nothing is retried automatically across providers.

## 6. What the person sees

One balance (owner). Sketch:

```
Withdraw
  Available to withdraw     ₦100,000
  [ Withdraw ]
  Withdrawals go to Opay ••5629 · Change

Receipt
  Withdrawal requested · ₦100,000
  This may arrive as 2 payments.            ← only when split
  ✓ ₦80,000 sent   · ⏳ ₦20,000 on its way
```

- **The withdrawals list** shows one row per request, with its parts when split. Amounts only; no provider names.
- **`partial` quote** (one provider can't be read right now): "Some of your balance can't be withdrawn right now. Try again later." The rest stays withdrawable.
- **Bank details needed at a provider:** "Add your bank details again to withdraw all of your balance." It goes through the existing change-bank flow (below).
- **Money at a provider that's no longer connected:** today's copy, plus an ops issue (§7). The rest of the balance stays withdrawable. The quote no longer blocks everything because one tip is "foreign" **(design call)**.

**Bank details across providers (design call):**

- Destinations are per provider (`payout_destinations`: one active row per owner and provider, schema.ts:1544-1549).
- **The screen shows one bank:** the owner's current bank, the one at the active provider.
- **Money is only ever sent to that bank.** A provider part is paid only if that provider's active destination is the **same bank account** as the current one. If it differs or is missing, that part is "needs action", never sent to a bank the screen didn't show.
- **Fixing it:** "Add your bank details again to withdraw all of your balance" registers the current bank at that provider. It runs through the existing flow with the same checks (name match, cooling-off, codes, You collect same-bank review), so any check that blocks blocks only that part.
- **Changing bank from now on** registers the new bank at every provider in the owner's set; any provider that refuses shows as needing action.

## 7. Staff

**Ops → Money → Split accounts.** Owners with an account reference or successful tips at more than one configured provider. For each: the ledger available, each provider's balance (read on demand, cached), queued payouts per provider, and the last daily check result.

**Daily check (worker job, design call):**

- **Who:** split owners only, plus any owner with money at a withdraw-only provider.
- **The comparison:** ledger available against Σ (partner balance − queued) across their providers.
- **The rule:**
  - provider total **below** the ledger by more than ₦100 opens an ops issue `provider_split_short`: money owed that no provider holds. Withdrawals are still capped by the ledger, so nothing is overpaid; the issue is for investigation;
  - **above** is informational: the provider holds more than TipMe says is owed, common while a reversal is in flight.
- **Bounds:** partner reads are rate-limited and spread across the day.
- **The job's own Redis job retention** follows the 21 Nov rule: `removeOnComplete: true`, `removeOnFail: { age: 7d }`.

**A provider that's no longer connected but still holds owners' money** opens one ops issue per provider (`provider_unconnected_money`), listing the owners affected.

**Retire check:** the Providers page shows, for each withdraw-only provider, the owners with money there and the open payouts, refunds and disputes. "Can retire" appears only at zero, after 30 days (§4).

## 8. Other paths

- **Pro from balance** (`pro-balance.ts`): today it reads only the configured adapter and never checks other providers. It changes to the same allocation: pay from the first provider in drain order that covers the price on its own, with one move per purchase and no split **(design call)**. If none covers it alone, the balance option isn't offered.
- **Business withdrawals** (`businessWithdrawalQuote`, `requestBusinessWithdrawal`): same allocation, same groups.
- **You collect:** collect transfers already record their provider and environment, and pay into the recipient's account at that provider (collect-transfers.ts:386-413). No change; the money they deliver is withdrawn through this design.
- **Refunds, disputes and reversals:** unchanged. They use the persisted provider and reduce the ledger total, which caps every quote.
- **Reconciliation:** unchanged per row. The unmatched-event rechecks hard-coded to `bachs` (reconcile.ts:587, 673, 718) must use each provider in either role **(design call)**.
- **Dashboard and home:** `withdrawalsAvailable` (dashboard.controller.ts:120) becomes true unless no configured provider can pay anything. The web notice `collected_elsewhere` (withdraw-state.ts:75) is replaced by the §6 states.

## 9. Testing

- **Unit:** the allocation across providers (drain order, caps, minimum folding, a partial read, a blocked route), and fee counting.
- **Integration** (two adapters: mock plus a second mock instance registered under another name, for tests only):
  - quote and request with money at both;
  - one part failing;
  - two requests at once;
  - the idempotent repeat;
  - a business owner;
  - Pro from balance;
  - the daily check opening and not opening issues;
  - the retire check.
- **E2E:** a split owner sees one balance, withdraws, and sees "may arrive as 2 payments" with two parts.
- **No real provider is ever called in tests.**

## 10. Left to the builder

- whether single-provider withdrawals get a `withdrawal_group_id`;
- the exact copy strings, matching `packages/contracts/src/copy.ts` tone;
- how the daily check spreads its reads;
- the shape of the second test adapter;
- the migration number;
- index needs for `queued_P` by provider.

## 11. Open for the owner

None. (Business split fees: answered 23 Nov, see §5.) The design calls above are listed for review: drain order, one free withdrawal per request with TipMe absorbing the extra provider fee, registering bank details at every provider, the 30-day retire wait, the ₦100 mismatch threshold, and Pro from balance using a single provider.
