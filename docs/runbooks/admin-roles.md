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

The menu only offers what someone can use. The server checks every call whatever the menu shows. `/ops/pages` is offered to anyone holding `pages.plan`, `pages.suspend`, `fees.manage`, `payouts.resolve` or `recoveries.manage`; each card there still needs its own permission.

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

## Serious actions

These wait for a second person when one is available:

| Action                      | In plain words                         | Needs               |
| --------------------------- | -------------------------------------- | ------------------- |
| `email_recovery.start`      | Move an account to a new email address | `recoveries.manage` |
| `payout.settle`             | Settle a stuck withdrawal              | `payouts.resolve`   |
| `money_issue.close`         | Close a money issue                    | `payouts.resolve`   |
| `fee.change`                | Change a page’s fee                    | `fees.manage`       |
| `fee.free`                  | Give a page fee-free tips              | `fees.manage`       |
| `staff.grant_owner`         | Make someone an owner                  | `staff.manage`      |
| `staff.grant_sensitive`     | Give someone sensitive access          | `staff.manage`      |
| `role.add_sensitive`        | Add sensitive access to a role         | `staff.manage`      |
| `staff.reset_authenticator` | Reset someone’s authenticator          | `staff.manage`      |
| `mail_provider.switch`      | Switch the active email provider       | `providers.manage`  |

Giving someone a role or permission counts as serious only if it contains something sensitive. A harmless edit applies at once. Hand closes of money issues are serious, except releasing a freeze (below).

## How an approval works

1. Someone asks and writes a reason, entering a fresh code if asked. Nothing has happened. The screen says **Waiting for a second person**.
2. Everyone else qualified is told, and sees it in Approvals: the action, the exact change, who asked and why. Addresses stay masked, and a recovery says whether the new address matches a staff mailbox and shows the written identity checks. Nobody sees the raw request.
3. A different qualified person approves with an authenticator code entered for that approval, or rejects with a reason.
4. On approval the server re-checks the facts and both people, then runs it. If something changed it stops, and Approvals says why.
5. Requests expire after 24 hours. The person who asked can cancel their own.

**Who qualifies:** active staff, set up with an authenticator, holding the same permission, and not the person who asked by id or mailbox. Someone the action concerns can't decide it.

**If it says "still waiting":** the provider or system couldn't answer, so nothing ran. Try again in a minute.

**If it says "we can't say":** a server error or lost answer. It may have worked. Read the screen again before repeating anything.

## One admin alone

When nobody else qualifies, a serious action runs straight away, with one person. The reason and fresh code are still required. The screen says **Done, without a second person**, the audit log records it as `serious_action.ran_alone`, and every owner is emailed and alerted. Approval switches on by itself once a second qualified person exists; there is no setting. Someone invited but not yet set up doesn't count.

If the other qualified people leave while your request waits, Approvals tells you nobody else can decide it. Cancel it and do it again; it then runs alone, with the alert. Removing the last other qualified person is itself alerted.

## Stopping, and starting again

**Stopping takes no code, so it works first time in an incident:** switching off all withdrawals, freezing a page's withdrawals after a reported takeover, and ending an account's sessions. Each still needs its permission and a written reason, and is audited.

**Starting again takes a fresh code:** switching withdrawals back on, and releasing a freeze. If yours has lapsed (5 minutes) the screen asks and carries on.

**Releasing a freeze is one person with a fresh code, not a second person** (spec 6.5). Closing a reported takeover as "The real owner has the account back" needs the written check of the bank and sign-in. It is audited, posted to the alert route, emailed to every owner and shown in staff activity.

- You can't release a freeze on your own page while someone else could. Ask them. If nobody else qualifies you can, and it is recorded and alerted as acting alone.
- Release doesn't always mean withdrawals resume. If another open issue holds them, the screen says **withdrawals stay on hold** and names what is still open.

## Adding and removing people

- **Add:** People, **Add a person**, with their email, a role and a reason. They get a link, sign in with an emailed code and set up an authenticator. The link lasts 30 minutes; **Resend invitation** sends another. If the screen says the link won't arrive, the address is known not to accept mail: fix that first.
- **Role and access:** effective access is the role's permissions, plus additions, minus removals. People shows what differs from the role. Additions and removals stay when a role changes, except moving to owner, which clears them. Nobody can give what they don't hold, or change their own access. Only an owner can create an owner.
- **Editing a role** takes effect on the next request for everyone holding it. **Review who is affected** comes before saving. Built-in roles can't be edited. A role can't be deleted while anyone has it.
- **Remove:** takes effect at once, needs no second person, and ends their admin sessions. The audit trail stays. The last active owner can't be removed or demoted.

## A lost phone

An owner or anyone with `staff.manage` uses **Reset authenticator** on the person. It is serious, so it waits for a second person when there is one. The person gets a new link by email. Changing a staff member's email is not done here: see `ops:set-email` below.

## An owner locked out

If every owner is locked out, someone with server access runs `pnpm ops:grant-owner --email <address>`. It prints a one-time enrolment code valid for 30 minutes, and is logged and alerted. Losing `OPS_TOTP_KEY` needs the same, as every authenticator has to be set up again.

## What roles cannot protect

Roles only govern the dashboard. These go around them, so keep them with very few people:

- **Server access and GitHub deploy rights:** can read every secret and reach the database.
- **`pnpm ops:set-email` and `pnpm ops:grant-owner`:** bypass the dashboard and any second person. `ops:set-email` refuses staff without `MAIL_SEAL_KEY` and refuses a mailbox clash, but it keeps the authenticator and doesn't tell the old address.
- **Each supplier's own login:** Bachs, Aiven, ZeptoMail, Cloudflare and Vercel.

## Before live payments

Serious money actions must be behind approval before payments are switched on, if there is more than one admin. See the Task 12 preconditions in `docs/superpowers/plans/2026-10-31-live-payments.md`.
