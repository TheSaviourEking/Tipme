# Runbook: admin roles and approvals

**When:** adding or removing staff, changing what someone can do, deciding a request in Approvals, a lost phone, or an owner locked out.

Nothing in this runbook, and nothing these screens do, approves a regulatory, payment-partner or funds-flow decision. Those stay open in `docs/00-DECISIONS.md` until the owner records them. These controls say who at TipMe may press which button; they don't make any activity permitted.

## The screens

| Screen              | Who sees it    | For                                                                                                                           |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/ops` Overview     | All staff      | Pending approvals. The withdrawals switch (`payouts.resolve`). Staff activity (`audit.view`). The numbers (`analytics.view`). |
| `/ops/approvals`    | All staff      | Requests you may see, with exactly what would change, and a history.                                                          |
| `/ops/staff/people` | `staff.manage` | Add, change role, adjust access, reset authenticator, remove.                                                                 |
| `/ops/staff/roles`  | `staff.manage` | Create, edit, delete roles.                                                                                                   |
| `/ops/staff`        | All staff      | Your own access.                                                                                                              |

The menu only offers what someone can use. The server checks every call whatever the menu shows. `/ops/pages` is offered to anyone holding `pages.plan`, `pages.suspend`, `fees.manage`, `payouts.resolve` or `recoveries.manage`; each card there still needs its own permission. `/ops/providers` is offered to `issues.view` or `providers.manage`, and `/ops/email` to `issues.view`, `email.read` or `email.export`: the list there holds no email contents and no full address, and opening an email or downloading the log still needs its own permission.

## Every permission, in plain words

| Permission          | Group    | Sensitive | What it allows                                                                                                              |
| ------------------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `fees.manage`       | money    | yes       | Set a page’s fee and grant fee-free tips, with a reason                                                                     |
| `pages.plan`        | money    | yes       | Move a page between Free and Pro, with a reason                                                                             |
| `payments.recheck`  | money    | no        | Ask the provider about a payment or withdrawal                                                                              |
| `payments.repair`   | money    | yes       | Repair a payment record from the provider dashboard: link a checkout, confirm who bears the fee, recover an account         |
| `payouts.resolve`   | money    | yes       | Act on a stuck withdrawal after asking the provider: record its answer, resume a held start, or release one it doesn’t have |
| `pages.suspend`     | people   | no        | Pause and restore recipient pages, and review or remove their images                                                        |
| `private.view`      | people   | yes       | Reveal private details, with a reason                                                                                       |
| `recoveries.cancel` | people   | no        | Cancel a pending phone recovery                                                                                             |
| `recoveries.manage` | people   | yes       | Start and manage account recoveries for a person                                                                            |
| `usernames.manage`  | people   | yes       | Reserve and release usernames, and ask to take one back from a page                                                         |
| `businesses.manage` | people   | yes       | Verify, suspend and restore businesses, with a reason (TipMe for businesses, behind `BUSINESS_ENABLED`)                     |
| `changelog.edit`    | content  | no        | Edit changelog entries and ask for one to be shown to users                                                                 |
| `changelog.publish` | content  | yes       | Approve what users read in What’s new                                                                                       |
| `email.export`      | content  | yes       | Download the email log as a spreadsheet                                                                                     |
| `email.read`        | content  | yes       | Open a sent email: its delivery timeline and its content                                                                    |
| `issues.resolve`    | content  | no        | Resolve issues                                                                                                              |
| `issues.view`       | content  | no        | See issues and their evidence, add notes                                                                                    |
| `search.view`       | content  | no        | Search pages, tips, withdrawals and ledger entries                                                                          |
| `analytics.view`    | numbers  | no        | See health, visibility and market numbers                                                                                   |
| `audit.view`        | numbers  | yes       | Read the audit log                                                                                                          |
| `market.edit`       | numbers  | no        | Add and change market observations                                                                                          |
| `providers.manage`  | settings | yes       | Change payment and email provider settings                                                                                  |
| `staff.manage`      | settings | yes       | Add staff, change their access and roles                                                                                    |

**Sensitive** means moving or settling money, reading logs or private details, or changing accounts and settings. The screens warn when one is ticked.

Every role except `release_check` holds `changelog.edit` (the owner's default, 6 Nov 2026). Only the owner holds `changelog.publish` until someone adds it to a role. It is sensitive because its approval goes through the serious-action flow, so its routes need a fresh code.

## Serious actions

These wait for a second person when one is available:

| Action                      | In plain words                         | Needs                                                          |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `email_recovery.start`      | Move an account to a new email address | `recoveries.manage`                                            |
| `payout.settle`             | Settle a stuck withdrawal              | `payouts.resolve`                                              |
| `money_issue.close`         | Close a money issue                    | `payouts.resolve`, and `issues.resolve` to decide or run it    |
| `fee.change`                | Change a page’s fee                    | `fees.manage`                                                  |
| `fee.free`                  | Give a page fee-free tips              | `fees.manage`                                                  |
| `staff.grant_owner`         | Make someone an owner                  | `staff.manage`; only an owner decides                          |
| `staff.grant_sensitive`     | Give someone sensitive access          | `staff.manage`                                                 |
| `role.add_sensitive`        | Add sensitive access to a role         | `staff.manage`                                                 |
| `staff.reset_authenticator` | Reset someone’s authenticator          | An owner, asking and deciding                                  |
| `mail_provider.switch`      | Switch the active email provider       | `providers.manage`                                             |
| `username.take_back`        | Take a username back from a page       | `usernames.manage`; the page’s owner can’t decide it           |
| `business.verify`           | Verify a business                      | `businesses.manage` (not one of the business’s own managers)   |
| `tip.reverse`               | Reverse a refunded or charged-back tip | `payments.repair` (business release 2, behind the shares flag) |
| `changelog.publish`         | Show users a What’s new entry          | Asked with `changelog.edit`, decided with `changelog.publish`  |

Reversing a refunded or charged-back tip (`tip.reverse`, business release 2) starts from the partner's `payment_reversed` issue, after checking the refund or dispute in the partner's dashboard. A refund follows the partner's refund guide: `refund.created` only notes it as pending; it can be reversed once `refund.paid` arrives, for exactly the `refunded_amount` the partner reports (enter that amount; a different one is refused); `refund.failed` means nothing moved, so close the issue. A dispute (the partner documents no dispute events) is reversed for the amount you enter. The partner keeps the fees it already charged ("Fees already charged are not returned"): the reversal takes back the person's part, any business's part and TipMe's fee in proportion, the provider fee stays TipMe's cost, and a fee on the refund itself is TipMe's cost too. Each partner refund or dispute is reversed once: several webhook events about one refund join one issue, a second request for it is refused, and the approval text shows what earlier reversals already took back. A won dispute opens no issue. An issue whose events named no refund or dispute id can't be reversed here; settle it at the partner and close it by hand. Reversing does not close the issue: a `payment_reversed` issue stays open, and keeps that person's withdrawals on hold, until staff resolve it. A reversal can take a balance below zero; withdrawals then stop until it is back, and a `balance_below_zero` money issue opens. It only runs while business shares are on, including when it is approved later.

`changelog.publish` is the one action asked for with a different permission from the one that decides it. An editor without `changelog.publish` can never run it alone: with no publisher able to enter a code, asking is refused ("Nobody who can approve this is set up yet."). A publisher doesn't ask: their own Approve on the entry page, with a fresh code, is the one approval (owner's default, 6 Nov 2026).

Giving someone a role or permission counts as serious only if it contains something sensitive. A harmless edit applies at once. Hand closes of money issues are serious, except releasing a freeze (below).

**One person, with audit, not a second person.** These act on money or a provider account and don't wait for anyone, by the current ruling. Each takes a fresh code and a written reason, and is audited. Owner: this list is here so you can see it and change it.

| Route                                   | In plain words                                                                             | Needs             | What it rests on                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/ops/issues/:id/payout-resume` | Queue a held withdrawal to start again, after asking the provider                          | `payouts.resolve` | The provider read, and the withdrawal job's own checks                                               |
| `POST /v1/ops/bachs/account-recovery`   | Link a provider account, typed by staff, to a page whose account creation was left unknown | `payments.repair` | The read proves the account exists, not whose it is. Identity rests on that person's dashboard check |

Releasing a freeze is also one person: see below.

## How an approval works

1. Someone asks and writes a reason, entering a fresh code if asked. Nothing has happened. The screen says **Waiting for a second person**.
2. Everyone else qualified is told, and sees it in Approvals: the action, the exact change (what the person gains and loses, worked out from what they hold now, not from what was typed), who asked and why. Addresses stay masked, and a recovery says whether the new address matches a staff mailbox and shows the written identity checks. Nobody sees the raw request. Once the request closes, however it closes, the stored request keeps only the masked address too.
3. A different qualified person approves with an authenticator code entered for that approval, or rejects with a reason.
4. On approval the server re-checks the facts and both people, then runs it. If something changed it stops, and Approvals says why.
5. Requests expire after 24 hours. The person who asked can cancel their own.

**Who qualifies:** active staff, set up with an authenticator, holding the same permission, and not the person who asked by id or mailbox. Someone the action concerns can't decide it, and can't ask for it either, even when nobody else qualifies: asking is refused and nothing is recorded. So someone who manages a business never verifies it (owner's ruling, 6 Nov 2026). The one exception is releasing a freeze on your own page, below.

Some actions ask more of the approver:

- Giving access, or adding it to a role: they must hold everything being given.
- Making an owner, or resetting an authenticator: they must be an owner.
- Closing a money issue: they must hold `issues.resolve` too.

So an action can run alone even though someone holding the named permission exists, when that person doesn't meet these rules. It is recorded and alerted as acting alone, like any other.

**If it says "still waiting":** the provider or system couldn't answer, so nothing ran. Try again in a minute.

**If it says "we can't say":** a server error or lost answer. It may have worked. Read the screen again before repeating anything.

## One admin alone

When nobody else qualifies, a serious action runs straight away, with one person. The reason and fresh code are still required. The screen says **Done, without a second person**, the audit log records it as `serious_action.ran_alone`, and every owner is emailed and alerted. Approval switches on by itself once a second qualified person exists; there is no setting. Someone invited but not yet set up doesn't count.

If the other qualified people leave while your request waits, Approvals tells you nobody else can decide it. Cancel it and do it again; it then runs alone, with the alert. Removing the last other qualified person is itself alerted.

## Taking a username back

Use this only when TipMe needs a name a page holds: a brand, a public figure, one of TipMe's own names, impersonation, a trademark, or the law. Reserving a free name is under Usernames and is instant; taking one from a page is the serious action `username.take_back` and waits for a second person when one is available.

1. In **Usernames**, check the name (or open the page in **Pages** and use its Username card). It shows whether it is the page's current or an old username, and yes or no facts: plan, live, has a balance, withdrawal in flight, verified address on file. No amounts and no address.
2. Choose the category. **Ordinary** gives 7 to 30 days' notice; **Impersonation**, **Trademark** and **Required by law** give 1 to 7. Taking a name without notice is not available yet.
3. Write the internal reason. It goes to the audit log and to the approver. The user never sees it, nor who asked or approved: they read only the category's fixed sentence.
4. Once approved (or alone, with the alert), the notice email is queued and the page's dashboard shows a banner. **The clock starts when the email is sent or the banner is seen**, whichever comes first, and ends at the end of that Lagos day plus the notice. A reminder goes 2 days before the end when the notice is 4 days or more.
5. **Never reached:** if after 14 days neither the email was sent nor the banner seen, it goes ahead anyway, and the inbox has an issue from 24 hours on (`username_take_back_unnoticed`). Check the account's address, and cancel if it is wrong to continue.
6. **At the end:** if the person chose a new username it is already done. Otherwise TipMe gives the page `page_` and six letters or digits, emails them, and they get one free change within 30 days. An old username's links simply stop working. The name is then reserved as a take-back. An end more than an hour late opens `username_take_back_overdue`; the worker retries every minute.
7. **Cancel** any open take-back from Usernames with a reason. It is instant. If they may have read the notice, they are emailed that they can keep the name.
8. **Live checkout:** if the page is listed in `LIVE_CHECKOUT_HANDLES`, the form warns you. Update that setting to the new username when it completes, or the page loses live checkout.
9. **A harmful page:** don't wait for the approval. Pause it with `pages.suspend` straight away; the take-back still runs, and the page stays paused under its new name.

Links and printed QR codes with the taken name stop working. Nothing about the page's money changes.

## Stopping, and starting again

**Stopping takes no code, so it works first time in an incident:** switching off all withdrawals, freezing a page's withdrawals after a reported takeover, and ending an account's sessions. Each still needs its permission and a written reason, and is audited. That is within a live admin session: after an hour idle or 12 hours, opening the session takes one code first.

**Starting again takes a fresh code:** switching withdrawals back on, and releasing a freeze. If yours has lapsed (5 minutes) the screen asks and carries on.

**Releasing a freeze is one person with a fresh code, not a second person** (spec 6.5). Closing a reported takeover as "The real owner has the account back" needs the written check of the bank and sign-in. It is audited, posted to the alert route, emailed to every owner and shown in staff activity.

- You can't release a freeze on your own page while someone else could. Ask them. If nobody else qualifies you can, and it is recorded and alerted as acting alone.
- Release doesn't always mean withdrawals resume. If another open issue holds them, the screen says **withdrawals stay on hold** and names what is still open.
- **Reported again after the takeover issue closed** (a report while it is still open stays on that issue): the Pages card says **Withdrawals are still frozen** when another issue kept the hold, and offers **Record a new report**. A new report always opens a new issue and alerts staff, whether or not withdrawals were still held. The freeze moves to the new issue (`withdrawals.freeze_reopened`, in the audit log and staff activity), the card links to it, and it notes the earlier one. From then on, closing the unrelated issue doesn't lift the freeze: only the new issue closing as "The real owner has the account back" does, with no other hold issue open. That release is one person with a fresh code, under the rules above.
- A report while the takeover issue is open adds its reason to the audit log and changes nothing else.

## Adding and removing people

- **Add:** People, **Add a person**, with their email, a role and a reason. They get a link, sign in with an emailed code and set up an authenticator. The link lasts 30 minutes; **Resend invitation** sends another. If the screen says the link won't arrive, the address is known not to accept mail: fix that first.
- **Role and access:** effective access is the role's permissions, plus additions, minus removals. People shows what differs from the role. Additions and removals stay when a role changes, except moving to owner, which clears them. Nobody can give what they don't hold, or change their own access. Only an owner can create an owner.
- **Editing a role** takes effect on the next request for everyone holding it. **Review who is affected** comes before saving. Built-in roles can't be edited. A role can't be deleted while anyone has it.
- **Remove:** takes effect at once, needs no second person, and ends their admin sessions. The audit trail stays. The last active owner can't be removed or demoted.

## A lost phone

An owner uses **Reset authenticator** on the person; only owners are offered it. It is serious, so it waits for a second owner when there is one. The person gets a new link by email. Changing a staff member's email is not done here: see `ops:set-email` below.

## An owner locked out

If every owner is locked out, someone with server access runs `pnpm ops:grant-owner --email <address>`. It prints a one-time enrolment code valid for 30 minutes, and is logged and alerted. Losing `OPS_TOTP_KEY` needs the same, as every authenticator has to be set up again.

## What roles cannot protect

Roles only govern the dashboard. These go around them, so keep them with very few people:

- **Server access and GitHub deploy rights:** can read every secret and reach the database.
- **`pnpm ops:set-email` and `pnpm ops:grant-owner`:** bypass the dashboard and any second person. `ops:set-email` refuses staff without `MAIL_SEAL_KEY` and refuses a mailbox clash, but it keeps the authenticator and doesn't tell the old address.
- **Each supplier's own login:** Bachs, Aiven, ZeptoMail, Cloudflare and Vercel.

## Deploying and rolling back

**During a deploy, no staff actions.** The API switches before the workers are replaced, so a staff event relayed by an old worker in that window loses its alert; the audit line stays. An admin tab left open from before this release, or a web deploy that lands after the API, can read a request that is waiting as done. The current screens don't: they read a waiting answer as waiting. This only matters with two or more staff acting during a deploy. Reload open admin tabs afterwards.

**Rolling back to a release from before admin roles weakens the rules without any warning.** See `production.md`, section 7.

## Before live payments

Serious money actions must be behind approval before payments are switched on, if there is more than one admin. See the Task 12 preconditions in `docs/superpowers/plans/2026-10-31-live-payments.md`.
