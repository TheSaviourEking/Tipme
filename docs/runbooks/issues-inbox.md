# Runbook: working the issues inbox

**When:** anything appears in `/ops/issues`, or a supporter or recipient reports a problem with a tip, a withdrawal or their account.

## Getting in

1. **Become staff (once):** run `pnpm ops:grant-owner --phone <your number>` against the local database. It prints a one-time **enrolment code**, valid 30 minutes.
2. **Sign in:** open `/ops` and sign in with that number (6-digit code, as usual).
3. **Set up the authenticator:** enter the enrolment code, scan the QR code with an authenticator app, and enter its first code.
4. **Later visits:** enter the current code from the app. Access lasts 12 hours at most, or 1 hour idle, and ends when you sign out.
5. **If something goes wrong:**
   - Lost the app, or `OPS_TOTP_KEY` changed: run the grant command again; it re-enrols.
   - Five wrong codes lock admin access for 15 minutes.

## What each issue means and what to do

Severity is **Money**, **Account** or **Info**. Work Money issues first.

| Issue                               | What happened                                                                                                      | Usually                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Amount mismatch**                 | The provider reported a different amount or currency. Nothing was booked; the payment is held as unknown.          | Compare the provider events in the evidence with the provider's dashboard. **Re-check with the provider.** If it stays wrong, resolve with what you found. **Never adjust money from here.** |
| **Payment after the tip ended**     | The provider says a payment succeeded for a tip that was already declined or cancelled. Money may have been taken. | Treat as a possible refund case. Refunds need the two-person rule and a real provider (not available yet); write a note and escalate.                                                        |
| **Payment unknown to the provider** | 30 minutes on, the provider has no record of the payment.                                                          | Usually the supporter abandoned checkout. Re-check; the issue closes itself once the provider gives a final answer or the tip expires.                                                       |
| **Withdrawal failed**               | A payout failed; the money is back in the recipient's balance.                                                     | Check the reference. The recipient can withdraw again.                                                                                                                                       |
| **Withdrawal paid after failing**   | The provider says a payout was paid after TipMe recorded it as failed.                                             | Possible double payment. Note and escalate; no money action from admin.                                                                                                                      |
| **Conflicting provider event**      | The same provider event arrived twice with different contents.                                                     | Possible tampering or a provider bug. Check the trace; escalate.                                                                                                                             |
| **Tip stuck confirming**            | A tip has been waiting for the provider for over 30 minutes.                                                       | Re-check with the provider. Closes itself when the tip ends.                                                                                                                                 |
| **Unmatched provider event**        | The provider sent an event TipMe could not match.                                                                  | Look up the reference with the provider; resolve with what it was.                                                                                                                           |
| **Pending phone recovery**          | Someone used email recovery to move an account to a new number. It takes effect 24 hours later.                    | If the owner says it wasn't them, **cancel the phone recovery**. It closes itself when completed or cancelled.                                                                               |

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

There is **no** refund, adjustment or payout hold here: those need two people and a real provider (`docs/05-SECURITY.md`, D-03 to D-06).

## Related

- [Find a trace](find-a-trace.md)
- [Payment stuck or unknown](payment-stuck-unknown.md)
- [Sign-in problems](sign-in-problems.md)
- ADR-0010
