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

- **`waiting`**: the share is not ready to send. Either the recipient isn't verified, or their bank isn't `usable`, or the new-recipient delay (`release_after`) hasn't passed. It also waits while a shared bank account is in review or a dispute is open on the tip. It can also be back from a lost `transfers` capability. In that case it waits out a backoff unless `capability.updated` arrives and the account reads active. The account (`account_reference`) is read when the row becomes `ready`, never earlier.
- **`ready`**: the share is due at `next_try_at`. After `INSUFFICIENT_BALANCE` (TipMe's available balance doesn't cover it yet) it backs off: 5 minutes, doubling, at most 6 hours. A row that has been ready and tried for over an hour opens **one** `collect_transfer_stuck` issue (dedupe key `collect_transfer_stuck.ready.<id>`), however many rows are stuck. Check TipMe's own available balance in the Bachs dashboard.
- **`sent`**: a worker claimed the share and committed the claim before calling Bachs. If no answer was recorded within 2 minutes, the job lists the recipient's transfers (`GET /v1/transfers?connected_account_id=`, every page) and matches on `transfer_group`:
  - found with the right amount: `paid`;
  - found with another amount, or two in one group: `review`;
  - not found: sent again with the **same key**.
- **`unknown`**: an answer was lost. Within 24 hours of the key's first send, the job asks again with the same key, and Bachs replays the transfer it made or makes the one. After 24 hours it never sends blindly. It reads back by group instead:
  - found and paid: `paid`;
  - not found: `ready`, sent again with the same key;
  - another amount: `review`;
  - the list can't be read: it stays `unknown`.
- **`paid`**: the transfer posting (`collect_transfer.<rowId>`: `provider_clearing` ← `held_for_recipients`) was written in the same transaction.
- **`review`** (`review_reason` says why): `provider` is `NOT_FOUND`, another refusal, or another amount at Bachs, with a `collect_transfer_review` issue per transfer and no posting. `staff` is a manual hold. `dispute`, `refund` and `same_bank` belong to their own flows, and only those flows release them. A staff retry releases only `provider` and `staff` reviews: to `ready` when the row has an account, to `waiting` when it has none.

Platform-wide stops:

- **`collect_in_debt`**: Bachs answered `ORGANIZATION_IN_DEBT`. A negative balance on TipMe's own account blocks every transfer. The first such answer stops the run, and **every** collect transfer stays stopped while the issue is open. Rows stay `ready`, and nothing is marked failed. Top up TipMe's balance in every currency (a USD dispute fee can cause it), check `/v1/balances`, then resolve the issue. The next run (within 2 minutes) moves the backlog. Each spell opens its own issue (`collect_in_debt.<id>`), so a resolved one never hides the next.
- **`collect_transfer_stuck` with dedupe key `collect_transfer_stuck.platform.<id>`**: Bachs refused a transfer as `FORBIDDEN`, yet the recipient's account reads `transfers: active`. That means TipMe's own key has probably lost `transfers:write`. The run stops at the first one, and nobody is sent back to waiting. Check the key's permissions in the Bachs dashboard.
- **Staff pause** (`collect_settings.paused`, set through the serious actions `collect_transfers.pause` and `collect_transfers.resume` once the settings admin is built): the run stops before anything is asked, and resuming continues from where it stopped.

What to read: the row (`status`, `review_reason`, `attempts`, `sent_at` = when the key's current 24-hour window began, `next_try_at`, `transfer_reference`), the issue's note (it names the transfer and its group), and the recipient's transfers in the Bachs dashboard, where you look for the group `tipme-collect-<tipId>`.

Never:

- Send a new transfer by hand, or with a new key, for a share TipMe has a row for. The row is the link from tip to transfer. A second transfer pays the recipient twice, and a transfer can't be reversed.
- Retry a `provider` review before checking Bachs for a transfer in its group. If one exists, the share was paid: record that rather than retry.
- Move `sent` or `unknown` rows by hand. Money may be on its way; only a read-back decides.
- Withdraw TipMe's own money from the Bachs dashboard below what it holds for recipients.
