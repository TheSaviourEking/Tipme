# Runbook: working the issues inbox

**When:** anything appears in `/ops/issues`, or a supporter or recipient reports a problem with a tip, a withdrawal or their account.

## Getting in

1. **Become staff (once):** run `pnpm ops:grant-owner --email <your address>` against the local database. It prints a one-time **enrolment code**, valid 30 minutes.
2. **Sign in:** open `/ops` and sign in with that number (6-digit code, as usual).
3. **Set up the authenticator:** enter the enrolment code, scan the QR code with an authenticator app, and enter its first code.
4. **Later visits:** enter the current code from the app. Access lasts 12 hours at most, or 1 hour idle, and ends when you sign out.
5. **If something goes wrong:**
   - Lost the app, or `OPS_TOTP_KEY` changed: run the grant command again; it re-enrols.
   - Five wrong codes lock admin access for 15 minutes.

## What each issue means and what to do

Severity is **Money**, **Account** or **Info**. Work Money issues first.

| Issue                               | What happened                                                                                                                                                                                         | Usually                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Amount mismatch**                 | The provider reported a different amount or currency. Nothing was booked; the payment is held as unknown.                                                                                             | Compare the provider events in the evidence with the provider's dashboard. **Re-check with the provider.** If it stays wrong, resolve with what you found. **Never adjust money from here.**                                                                                                                                                                                                                                |
| **Payment after the tip ended**     | The provider says a payment succeeded for a tip that was already declined or cancelled. Money may have been taken.                                                                                    | Treat as a possible refund case. Refunds need the two-person rule and a real provider (not available yet); write a note and escalate.                                                                                                                                                                                                                                                                                       |
| **Payment unknown to the provider** | 30 minutes on, the provider has no record of the payment.                                                                                                                                             | Usually the supporter abandoned checkout. Re-check; the issue closes itself once the provider gives a final answer or the tip expires.                                                                                                                                                                                                                                                                                      |
| **Withdrawal failed**               | A payout failed; the money is back in the recipient's balance.                                                                                                                                        | Check the reference. The recipient can withdraw again.                                                                                                                                                                                                                                                                                                                                                                      |
| **Withdrawal paid after failing**   | The provider says a payout was paid after TipMe recorded it as failed.                                                                                                                                | Possible double payment. Note and escalate; no money action from admin.                                                                                                                                                                                                                                                                                                                                                     |
| **Conflicting provider event**      | The same provider event arrived twice with different contents.                                                                                                                                        | Possible tampering or a provider bug. Check the trace; escalate.                                                                                                                                                                                                                                                                                                                                                            |
| **Tip stuck confirming**            | A tip has been waiting for the provider for over 30 minutes.                                                                                                                                          | Re-check with the provider. Closes itself when the tip ends. A Bachs tip whose money was taken but whose fee bearer Bachs never reported: check the payment in Bachs Dashboard, then use **Bachs took the money but not the fee details** (ADR-0004 addendum).                                                                                                                                                              |
| **Settled in another currency**     | Bachs took a naira tip but settled it in another currency (USD), because the recipient's Bachs account does not hold NGN. It never confirms on its own.                                               | In Bachs Dashboard, turn on NGN under **Currencies held** for the recipient's account so later tips settle in naira. Then check this payment and use **Bachs took the money but not the fee details**. Closes itself when the tip ends.                                                                                                                                                                                     |
| **Unmatched provider event**        | The provider sent an event TipMe could not match.                                                                                                                                                     | Look up the reference with the provider; resolve with what it was.                                                                                                                                                                                                                                                                                                                                                          |
| **Reported page**                   | Visitors reported a page as impersonation, a scam, abuse or other. The evidence shows how many reports gave each reason (never who sent them).                                                        | Open the page. If it pretends to be someone else, or is a scam, **pause the page** with a reason the recipient will see. Otherwise resolve it with what you found. A new report after you resolve it opens a new issue.                                                                                                                                                                                                     |
| **Reported message**                | A recipient reported a supporter's message as abusive, spam or other. It is already hidden from their dashboard.                                                                                      | Read it only through the evidence view (it asks for a reason and is audited). If abusive, note the tip and escalate; there is no supporter account to suspend. Resolve with what you did.                                                                                                                                                                                                                                   |
| **Reported account takeover**       | Staff froze this person's withdrawals after a report that someone else has the account (Pages → Reported account takeover). While frozen the bank can't change and held withdrawals can't resume.     | In order: **End all sessions** on the Pages card. Prove who the real owner is and get them back in (`sign-in-problems.md`). Check the current bank is theirs. Mark any withdrawal the thief asked for as failed; don't Resume it. Then resolve with **The real owner has the account back** and tick the check. That releases the freeze unless another issue that places a hold is open; the issue page names any that is. |
| **Payment reserve empty**           | The provider refused a payout fee top-up because the platform balance is empty or in debt. Withdrawals wait, reserved; nothing failed and recipients weren't told. One issue and one alert per spell. | Top up the reserve. Waiting withdrawals are queued again at each reserve reading at or above the alert level (every 15 minutes), and this closes itself once none is waiting.                                                                                                                                                                                                                                               |
| **Provider refused our key**        | The provider answered 401 or 403 to a withdrawal or bank call. Withdrawals wait, reserved; adding a bank says to try later. One issue and one alert per spell.                                        | Check the key and its permissions. Waiting withdrawals start again at the next reserve reading at or above the alert level. Then resolve this by hand: it doesn't close itself.                                                                                                                                                                                                                                             |
| **Pending phone recovery**          | Someone used email recovery to move an account to a new number. It takes effect 24 hours later.                                                                                                       | If the owner says it wasn't them, **cancel the phone recovery**. It closes itself when completed or cancelled.                                                                                                                                                                                                                                                                                                              |

## The evidence view

- **Shown by default:** what happened in plain words, the status history, provider events (reference tails only), the ledger booking, the payout, the page and person (masked), the trace link, related open issues and notes.
- **Private details** (the supporter's message and name, the full phone number and email) stay hidden. **Reveal private details** needs the `private.view` permission and a written reason; every reveal is recorded in the audit log.

## Actions

Every action asks for a written reason (10–500 characters) and is recorded with your name and the time.

- **Resolve:** closes the issue. Resolved issues never reopen; if the cause comes back, a new issue opens.
- **Note:** adds to the record (notes cannot be edited).
- **Re-check with the provider:** asks once about that payment or withdrawal. It never charges, pays or refunds.
- **Pause / restore this page:**
  - A paused page shows "isn't available" and takes no new tips.
  - Tips already in flight still settle, and the recipient can still withdraw.
  - The recipient sees your reason on their dashboard, so write it for them.
- **Cancel the phone recovery.**

- **Freeze withdrawals (Pages, needs `payouts.resolve`):** for a reported account takeover only. It stops withdrawals not yet started and bank changes, moves no money, and recalls nothing already with the provider. The recipient sees only "paused while support checks your account". A second report records its reason in the audit log.
- **End all sessions (Pages, needs `recoveries.manage`):** signs an account out everywhere, audited. Not for staff accounts.
- **Switch off all withdrawals (Overview, needs `payouts.resolve`):** see `live-activation.md`, "Stopping withdrawals".

There is **no** refund or adjustment here, and no other payout hold: those need two people and a real provider (`docs/05-SECURITY.md`, D-03 to D-06).

## Allowing more handle changes

A Pro page has 3 handle changes. When someone has used them and asks for another (the page then tells them to contact the team), staff with `pages.plan` can allow more. Free pages cannot change their handle at all; make the page Pro first if that is the right answer.

1. Open **Pages**, look the page up by handle (an old handle works), and find the **Handle changes** card, which shows "N of M used".
2. Check the request is the owner's, and that a change is reasonable. Each change leaves an old name held for as long as the page exists, so a name nobody else can then claim.
3. Enter how many to allow (1 to 10 at a time; a page can hold at most 20 extra in total) and a written reason (10 to 500 characters). It is recorded in the audit log as `page.handle_changes_granted` with the number allowed.
4. Tell the owner. They see the new allowance the next time Settings loads.

Until admin roles exist, this uses the `pages.plan` permission, as making a page Pro does.

## Related

- [Find a trace](find-a-trace.md)
- [Payment stuck or unknown](payment-stuck-unknown.md)
- [Sign-in problems](sign-in-problems.md)
- ADR-0010
