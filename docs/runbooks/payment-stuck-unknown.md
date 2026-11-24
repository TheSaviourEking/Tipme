# Runbook: a payment is stuck (pending, unknown or unresolved)

**When:** a supporter says they paid but the tip is not marked paid; an operations alert `payment.mismatch`, `payment.conflict` or `payment.unresolved` fires; or `pnpm mock:pay --scenario no-reply` locally.

## What the system already does

- Every minute the worker's `reconcile.payments` job asks the provider about attempts that have been `INITIATED`, `PENDING` or `UNKNOWN` for more than 2 minutes. A definite answer is recorded as verified evidence. It **never** charges again. Attempts that cannot resolve (for example `UNKNOWN` after a mismatch) keep being re-checked, least-recently-checked first, so they cannot block newer payments; they need a person (steps below).
- The same job asks about payouts still `REQUESTED` or `PROCESSING`, so a payout message that arrived too early (kept in `unmatched_provider_events`) or never arrived is recovered from the provider's own answer.
- The same job expires tips that were never paid (PR-007): attempts still `CREATED`/`INITIATED` whose quote expired more than 15 minutes ago. The provider is **always asked first**; a paid or failed answer is recorded as evidence, and only an unpaid attempt becomes `EXPIRED` with its tip `CANCELLED` (transitions with cause `expiry`). The supporter's status screen then shows "This tip expired", without promising that nothing was charged (a late provider success is a `payment.conflict`, step 3), and the pretend checkout refuses to take payment for it (409 `TIP_NOT_PAYABLE`).
- Log line per run: `{"event":"reconcile.completed","checked":N,"applied":N,"unresolved":N,"errors":N,"payouts_checked":N,"payouts_applied":N,"payouts_errors":N,"expired":N,"expired_paid":N,"expire_errors":N}`. `unresolved` counts new alerts only; `errors` counts checks that failed this run (they are retried next run).

## Steps

1. Find the tip: `tipProof` (or its trace via [find a trace](find-a-trace.md)). Note the attempt status and provider reference.
2. `UNKNOWN` with `payment.mismatch`: the provider reported a different amount or currency, or a fee larger than the payment. **Do not mark it paid by hand.** Compare with the provider's dashboard or report; the books stay untouched until a verified, matching event arrives.
3. `payment.conflict`: the provider reported success after a recorded failure, or for a tip that can no longer succeed (for example cancelled). Money may have been taken. Check the provider and arrange a refund or a manual review. Never rewrite the tip's history.
4. `payment.unresolved`: the provider cannot find the payment 30 minutes later. Check the provider by reference. If it truly does not exist, the supporter was not charged; the attempt expires on its own once its quote is 15 minutes past expiry.
5. A supporter's status screen says "Still checking": the attempt is `UNKNOWN` or the tip is more than 2 minutes old without a verdict. It never shows success until verified; follow steps 2–4.
6. Messages for payments TipMe does not know are in `unmatched_provider_events`. Match them by reference with the provider before acting. Account events (`account.updated`, `capability.updated`) are different: they only trigger a read-back of the account. One that arrives while a payment account in that environment is still being set up (claimed in the last 10 minutes, no partner reference yet) is answered 503 (log `webhook.deferred`) so the partner delivers it again once the reference is saved. One for an account TipMe does not have is kept with `reason = 'unknown_account'` and does not open `unmatched_event`.
7. Payout events with a reference TipMe has not recorded are parked in `unmatched_provider_events` (`reason = 'unknown_payout'`) and retried on every reconciliation run, least recently tried first; `parked_payout_checks` holds the last try. They do not open `unmatched_event`. What happens next:
   - The reference is recorded, or the event's signed reference names a live payout on that account: a read confirms it and it is applied. An event or read that differs from the request is never booked; a read that differs opens `payout_conflict`.
   - The event names a payout that already ended or has another reference: `payout_conflict` at once, before any read. Money may have left; check the provider. Only a person closes it. Exception: `payout.failed` naming a failed payout with no reference is stored without an issue, because no money moved.
   - It names no payout of ours and 10 minutes have passed: `payout_unexpected` and a withdrawal hold.
   - It names a payout but has had no usable answer for 24 hours: `payout_unresolved` (dedupe key `payout_parked.<id>`). The event keeps being retried, and this issue closes itself when the payout ends or gets a reference.
8. A withdrawal has an open `payout_unresolved`, `payout_conflict` or `payout_held` issue (`payout_stuck` and `payout_parked` are `payout_unresolved` issues, told apart by their dedupe key). On the issue page, with the permission `payouts.resolve` (owner only), choose **Ask the provider**. TipMe reads the provider, by its reference and by TipMe's own id, shows the answer, and offers only what that answer allows. Each action reads again first, and refuses if the answer has changed; every read, action and refusal is in the audit log.

   | Option                      | Offered only when                                                                                                                                                                                                                                                                        | What it does                                                                                                                                                                              |
   | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Record it as paid or failed | The issue is open, the payout unfinished, the provider definitely says paid or failed, nothing differs from the request, and both lookups name the same payout                                                                                                                           | Records it through `recordPayoutOutcome`, as a webhook would. Closes an unresolved or held issue; a conflict stays open for a person                                                      |
   | Resume this withdrawal      | Unresolved or held issue, the provider has none, no hold is active, no start was ever attempted (`start_step` empty and no start mark)                                                                                                                                                   | Queues `payouts.start` again; nothing is sent from the page, and the job's own checks still apply. The issue closes when the payout has a reference                                       |
   | Mark failed and release     | Unresolved or held issue, a definite "none" from the provider more than 30 minutes after the start or request (24 hours if `start_step` is `payout`), no reference, no parked event naming it, and no other open conflict; plus your reason and the box saying you checked the dashboard | Fails the payout and releases the money. The ledger isn't touched. A fee top-up that went through stays in the recipient's account at the provider, so check for it if the step was `fee` |

   If the answer is uncertain or ambiguous, nothing is offered and the money stays reserved, however long it has been: take the payout id to the provider's support, and once its read gives an answer, record that. If `start_step` is `payout`, the call may have reached the provider, so Mark failed waits 24 hours and needs the definite "none", no reference, and your check of the dashboard, which the audit line records as `dashboardVerified`. If money did leave after all, a later paid event opens `payout_conflict` and books nothing.

9. A refund or dispute on a paid tip opens `payment_reversed` and pauses that recipient's withdrawals (recipients see "Withdrawals are paused…"). No balance changes.
10. A money issue is resolved by someone with `payouts.resolve` (`issues.resolve` alone gets 403), and not while its withdrawal is unfinished: use the tools in step 8, because a closed issue is never raised again. A conflict whose provider record keeps differing stays open until the provider corrects it; escalate to the owner. Each is resolved with an outcome and a reason: **Settled by the provider**, **The recipient owes the money** or **Written off by TipMe**. The outcome is a record only; ledger reversals come later. Mark failed records its own outcome, **Staff confirmed the provider has no such payout**, a `staff` transition and no provider event; if the provider later says it paid, `payout.conflict` fires. Holds whose own issue has closed are released when no other issue that places a hold is open for that recipient (`payment_reversed`, `provider_in_debt`, `payout_unexpected`, `account_takeover_reported`), whoever closes the last one. A takeover freeze goes only when its own issue closes as **The real owner has the account back**. A hold that stays is named on the issue page ("Withdrawals stay on hold") and in the audit line `withdrawals.still_held`. Other money issues, such as `payout_failed` or `payout_unresolved`, don't keep a hold, and neither does `payout_held`, since it is waiting for the hold to go: resolve the cause first, then resume the withdrawal from its issue. A hold opens `payout_held` at once for each of that recipient's withdrawals not yet started, and one that a hold touched after it was requested never starts by itself, even once the hold has ended: only **Resume** or **Mark failed** settles it.
11. Withdrawal balance reads that fail log `withdrawal.provider_read_failed` with the error name and allowlisted diagnostic. Many at once with an auth error mean wrong keys, not an outage.

## Never

- Edit tip, attempt or ledger rows directly. The database refuses most such edits; the ones it allows bypass the audit trail.
- Retry a charge to "fix" an unknown outcome.
- Re-send a create for a payout whose start was attempted. Only a read may move it.

## Manual payouts not set (`payment_account_setup_failed`)

Manual payouts could not be set on a recipient's payment account. Until they are, the recipient can't withdraw and an account still in setup gets no onboarding link. Accounts are retried on every account event, every setup visit and every 15-minute sweep; a sweep stops trying accounts after 5 manual-payouts failures in a row and logs `payout_setup.sweep_stopped`, which usually means the provider is down. It still reads banks under review. The issue closes itself once manual payouts are set. If it stays open, look for `payment_account.manual_payouts_failed` in the logs and check the account at the provider. There is one issue per account: closing it by hand while the failure continues won't raise another, so leave it open.

## Collect transfer stuck (You collect)

Under You collect (ADR-0016, proposed) TipMe takes the tip on its own Bachs account and holds the recipient's share (`held_for_recipients`). One `collect_transfers` row per tip (`kind = 'share'`) moves it to the recipient's own Bachs account. The `collect.transfers` worker job runs every 2 minutes, with the switch on or off. Each share is sent with the idempotency key `tipme-collect-<tipId>`, and the transfer's `transfer_group` is the same value, so Bachs can always find it by group.

What each status means:

- **`waiting`**: the share is not ready to send. Either the recipient isn't verified, or their bank isn't `usable`, or the new-recipient delay (`release_after`) hasn't passed. It also waits while a shared bank account is in review or a dispute is open on the tip. It can also be back from a lost `transfers` capability. In that case it waits out a backoff unless `capability.updated` arrives and the account reads active. A share that has bounced on a lost capability for over a day opens one `collect_transfer_stuck` issue for that recipient (dedupe key `collect_transfer_stuck.capability.<profileId>.<id>`): check the account's capabilities in the Bachs dashboard. The account (`account_reference`) is read when the row becomes `ready`, never earlier.
- **`ready`**: the share is due at `next_try_at`. After `INSUFFICIENT_BALANCE` (TipMe's available balance doesn't cover it yet) it backs off: 5 minutes, doubling, at most 6 hours. A row that has been ready and tried for over an hour opens **one** `collect_transfer_stuck` issue (dedupe key `collect_transfer_stuck.ready.<id>`), however many rows are stuck. Check TipMe's own available balance in the Bachs dashboard. Before each send the release checks run again: if the recipient's bank was replaced, their verification or account changed, their bank is shared or the tip is disputed, nothing is sent. A share never sent goes back to `waiting` with no account. A share that **may have been sent** (it has a `sent_at`) is never returned to waiting or held: it keeps its `account_reference`, the account its key went to, and waits until the key is no longer trusted. Then it is read back on that account. Found means `paid`. Nothing in the group means it starts over: `waiting`, no account, `sent_at` cleared, released later to the account the recipient has then.
- **`sent`**: a worker claimed the share and committed the claim before calling Bachs. If no answer was recorded within 2 minutes, the job lists the recipient's transfers (`GET /v1/transfers?connected_account_id=`, every page) and matches on `transfer_group`:
  - found with the right amount: `paid`;
  - found with another amount, or two in one group: `review`;
  - not found: sent again with the **same key**;
  - the list can't be read: the row becomes `unknown` (below), nothing is sent.
- **`unknown`**: an answer was lost, or a read-back failed. Within 23 hours of the key's first send (`KEY_TRUSTED_FOR_MS`, an hour inside Bachs's 24-hour window), the job asks again with the same key, and Bachs replays the transfer it made or makes the one. After 23 hours it never sends without reading back by group first:
  - found and paid: `paid`;
  - not found: sent again with the same key, which starts a new window;
  - another amount: `review`;
  - the list can't be read: it stays `unknown` with its old window, and the next try (backing off from 2 minutes to 6 hours) reads back again. Nothing is sent until a read-back succeeds. Many in a row usually mean the transfers list at Bachs is down.
- **`paid`**: the transfer posting (`collect_transfer.<rowId>`: `provider_clearing` ← `held_for_recipients`) was written in the same transaction.
- **`review`** (`review_reason` says why): `provider` is `NOT_FOUND`, another refusal, or another amount at Bachs, with a `collect_transfer_review` issue per transfer and no posting. `staff` is a manual hold. `dispute`, `refund` and `same_bank` belong to their own flows, and only those flows release them. A staff retry releases only `provider` and `staff` reviews: to `ready` when the row has an account, to `waiting` when it has none.

Platform-wide stops:

- **`collect_in_debt`**: Bachs answered `ORGANIZATION_IN_DEBT`. A negative balance on TipMe's own account blocks every transfer. The first such answer stops the run and pages the alert route once per spell, and **every** collect transfer stays stopped while the issue is open. Rows stay `ready`, and nothing is marked failed. Top up TipMe's balance in every currency (a USD dispute fee can cause it), check `/v1/balances`, then resolve the issue. The next run (within 2 minutes) moves the backlog. Each spell opens its own issue (`collect_in_debt.<id>`), so a resolved one never hides the next.
- **`provider_key_refused`** (with its alert, the same issue a refused key opens for withdrawals): Bachs refused a transfer as `FORBIDDEN`, yet the recipient's account reads `transfers: active`. That means TipMe's own key has probably lost `transfers:write`. The run stops at the first one, and nobody is sent back to waiting. Check the key's permissions in the Bachs dashboard, then resolve the issue.
- **Staff pause** (`collect_settings.paused`, set through the serious actions `collect_transfers.pause` and `collect_transfers.resume` once the settings admin is built): the run stops before anything is asked, and resuming continues from where it stopped.

What to read: the row (`status`, `review_reason`, `attempts`, `sent_at` = when the key's current window began, `next_try_at`, `transfer_reference`), the issue's note (it names the transfer and its group), and the recipient's transfers in the Bachs dashboard, where you look for the group `tipme-collect-<tipId>`.

Never:

- Send a new transfer by hand, or with a new key, for a share TipMe has a row for. The row is the link from tip to transfer. A second transfer pays the recipient twice, and a transfer can't be reversed.
- Retry a `provider` review before checking Bachs for a transfer in its group. If one exists with the right amount, the share was paid. There is no staff tool yet to record a review as paid: it comes with the staff screens (plan Task 15). Until then, leave the row in review and take it to the owner. A retry is still safe, because the job reads the group back first once the key is no longer trusted, but don't rely on it as the check.
- Move `sent` or `unknown` rows by hand, or clear the account of any row with a `sent_at`. Money may be on its way, and only a read-back on the account it was sent to decides. Staff holds refuse such rows for the same reason.
- Withdraw TipMe's own money from the Bachs dashboard below what it holds for recipients.

## The reserve rule and TipMe's own money (You collect)

Under You collect, TipMe's own partner balance also holds every collect recipient's money until it is transferred (`held_for_recipients`). In every currency the rule is:

```
TipMe's available balance at Bachs  >=  Σ held_for_recipients
```

TipMe's own money is the difference. It pays refunds TipMe absorbs, dispute fees, lost disputes, payout fees and fee returns.

**What the system does.** Every reserve check (every 15 minutes, after the NGN payout-fee check, which is unchanged) reads TipMe's balances and payout schedule at Bachs and records one row per currency in `collect_reserve_readings`:

| Level             | When (NGN levels are You collect settings, ₦500,000 and ₦250,000 by default)       | What happens                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warning`         | own money below the warning level                                                  | a staff alert, then every 6 hours while it lasts                                                                                                                                                      |
| `critical`        | own money below the critical level, or **any** balance below zero, in any currency | a paged alert (`CRITICAL:`), owners emailed, a `collect_reserve_low` issue naming the currency; voluntary moves of TipMe's own money (a refund gap TipMe absorbs) are refused                         |
| `breach` (broken) | less in a currency than TipMe holds for recipients in it                           | as critical, plus a `collect_invariant_broken` issue. **New You collect sign-ups pause** (pages are written undecided, so direct) until staff resolve it. Recipients already on collect are untouched |

Automatic payouts on TipMe's own balance (any interval but `manual`) open `collect_auto_payout_on` with one critical alert: turn them off in the Bachs dashboard at once.

Moves of TipMe's own money ask the latest reading first (`ownMoneyAllows`). With nothing held, it never refuses, so a direct-only TipMe behaves as before. Otherwise it needs a reading under 45 minutes old:

- A payout fee TipMe covers, and a fee TipMe returns after a chargeback, are owed (non-voluntary). They are refused only when they would spend recipients' money. Refused, the withdrawal waits exactly as on an empty reserve (`reserve_empty`, nothing asked of Bachs), and a fee return is tried again later.
- A refund gap TipMe absorbs (`tip_refund.absorb_gap`) is voluntary. It is also refused when it would leave TipMe's own money below the critical level: when asked, and again before the refund is sent (then the refund fails as "TipMe's balance can't cover this refund right now").

**What to do.**

1. Read the alert or issue: it names the currency, what is available, what is held and TipMe's own figure.
2. Top up TipMe's balance at Bachs in that currency (for a negative USD balance, usually a dispute fee: top up USD).
3. Wait for the next reading (within 15 minutes): waiting withdrawals start again once the NGN reserve is funded.
4. Resolve `collect_invariant_broken` only once a reading shows the rule holds again. That resumes You collect sign-ups.

**Withdrawing TipMe's earnings from the Bachs dashboard.** Before any platform withdrawal, check the latest `collect_reserve_readings` row for the currency: withdraw at most its `own_minor` less the critical level. Never withdraw below what TipMe holds for recipients, and never while a level is `critical` or `breach`.

## Daily reconciliation (You collect)

At 02:00 Lagos the worker's `collect.recon` job compares Bachs's records with TipMe's and logs its totals (`collect_recon.completed`: checked, mismatches, unreadable). Each finding opens one `collect_recon_mismatch` issue that names the transfer group, dispute or tip and the amounts:

- **Transfers**: for every recipient with You collect activity in the last 3 days, their transfers at Bachs (every page) against `collect_transfers` by `transfer_group`. _Missing_ (paid for TipMe, not at Bachs), _different amount_, and _extra_ (a `tipme-collect-` group TipMe has no row for, or holds as never moved). Rows `sent`, `unknown` or in review are left to the read-back and staff. An account whose list can't be read counts as `unreadable` and is read again the next day.
- **Disputes**: the partner's disputes of the last 3 days against `disputes`. One on a You collect payment TipMe doesn't know means its events never arrived: nothing is held or booked for it. A different amount, or a final ruling TipMe doesn't have, is raised too.
- **TipMe's own balance against the ledger**: a refund Bachs paid that the ledger never booked (an unexpected `refund.paid`, which leaves TipMe's own figure higher than Bachs holds), a dispute fee or lost dispute with no posting, and a paid transfer with no posting.

Nothing is changed by the check. Compare with the Bachs dashboard, settle the money, then resolve the issue with how it was settled.
