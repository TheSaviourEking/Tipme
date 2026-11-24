# Runbook: admin roles and approvals

**When:** adding or removing staff, changing what someone can do, deciding a request in Approvals, a lost phone, or an owner locked out.

Nothing in this runbook, and nothing these screens do, approves a regulatory, payment-partner or funds-flow decision. Those stay open in `docs/00-DECISIONS.md` until the owner records them. These controls say who at TipMe may press which button; they don't make any activity permitted.

## The screens

| Screen              | Who sees it    | For                                                                                                                                                                                    |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ops` Overview     | All staff      | Pending approvals. The withdrawals switch (`payouts.resolve`). Staff activity (`audit.view`). The numbers (`analytics.view`).                                                          |
| `/ops/approvals`    | All staff      | Requests you may see, with exactly what would change, and a history.                                                                                                                   |
| `/ops/staff/people` | `staff.manage` | Add, change role, adjust access, reset authenticator, remove.                                                                                                                          |
| `/ops/staff/roles`  | `staff.manage` | Create, edit, delete roles.                                                                                                                                                            |
| `/ops/staff`        | All staff      | Your own access.                                                                                                                                                                       |
| `/ops/collect`      | `collect.view` | You collect: held money, transfers, disputes, recipients past the holding cap. Acting needs `collect.manage`; the settings tab needs `fees.manage`; a name change `recoveries.manage`. |

The menu only offers what someone can use. The server checks every call whatever the menu shows. `/ops/pages` is offered to anyone holding `pages.plan`, `pages.suspend`, `fees.manage`, `payouts.resolve` or `recoveries.manage`; each card there still needs its own permission. `/ops/providers` is offered to `issues.view` or `providers.manage`, and `/ops/email` to `issues.view`, `email.read` or `email.export`: the list there holds no email contents and no full address, and opening an email or downloading the log still needs its own permission.

## Every permission, in plain words

| Permission           | Group    | Sensitive | What it allows                                                                                                                            |
| -------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `fees.manage`        | money    | yes       | Set a page’s fee and grant fee-free tips, with a reason                                                                                   |
| `pages.plan`         | money    | yes       | Move a page between Free and Pro, with a reason                                                                                           |
| `payments.recheck`   | money    | no        | Ask the provider about a payment or withdrawal                                                                                            |
| `payments.repair`    | money    | yes       | Repair a payment record from the provider dashboard: link a checkout, confirm who bears the fee, recover an account                       |
| `payouts.resolve`    | money    | yes       | Act on a stuck withdrawal after asking the provider: record its answer, resume a held start, or release one it doesn’t have               |
| `pages.suspend`      | people   | no        | Pause and restore recipient pages, and review or remove their images                                                                      |
| `private.view`       | people   | yes       | Reveal private details, with a reason                                                                                                     |
| `recoveries.cancel`  | people   | no        | Cancel a pending phone recovery                                                                                                           |
| `recoveries.manage`  | people   | yes       | Start and manage account recoveries for a person                                                                                          |
| `usernames.manage`   | people   | yes       | Reserve and release usernames, and ask to take one back from a page                                                                       |
| `businesses.manage`  | people   | yes       | Verify, suspend and restore businesses, with a reason (TipMe for businesses, behind `BUSINESS_ENABLED`)                                   |
| `changelog.edit`     | content  | no        | Edit changelog entries and ask for one to be shown to users                                                                               |
| `changelog.publish`  | content  | yes       | Approve what users read in What’s new                                                                                                     |
| `pro.price`          | money    | yes       | Change the Pro price for new months, with a reason                                                                                        |
| `announcements.send` | content  | yes       | Write announcements by email, and send one to users with a second person                                                                  |
| `email.export`       | content  | yes       | Download the email log as a spreadsheet                                                                                                   |
| `email.read`         | content  | yes       | Open a sent email: its delivery timeline and its content                                                                                  |
| `issues.resolve`     | content  | no        | Resolve issues                                                                                                                            |
| `issues.view`        | content  | no        | See issues and their evidence, add notes                                                                                                  |
| `search.view`        | content  | no        | Search pages, tips, withdrawals and ledger entries                                                                                        |
| `analytics.view`     | numbers  | no        | See health, visibility and market numbers                                                                                                 |
| `audit.view`         | numbers  | yes       | Read the audit log                                                                                                                        |
| `market.edit`        | numbers  | no        | Add and change market observations                                                                                                        |
| `providers.manage`   | settings | yes       | Change payment and email provider settings                                                                                                |
| `staff.manage`       | settings | yes       | Add staff, change their access and roles                                                                                                  |
| `switches.manage`    | settings | yes       | Turn feature switches on and off, with a reason (`settings-and-switches.md`)                                                              |
| `collect.view`       | money    | no        | See You collect: money TipMe holds for recipients, its transfers, disputes and recipients past the holding cap (`/ops/collect`)           |
| `collect.manage`     | money    | yes       | Act on You collect money with a second person: retry, hold or record a transfer, release a hold, record a refund, submit dispute evidence |

**Sensitive** means moving or settling money, reading logs or private details, or changing accounts and settings. The screens warn when one is ticked.

Every role except `release_check` holds `changelog.edit` (the owner's default, 6 Nov 2026). Only the owner holds `changelog.publish` until someone adds it to a role. It is sensitive because its approval goes through the serious-action flow, so its routes need a fresh code.

## Serious actions

These wait for a second person when one is available:

| Action                         | In plain words                                                  | Needs                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `email_recovery.start`         | Move an account to a new email address                          | `recoveries.manage`                                                                                                                                                                                                |
| `payout.settle`                | Settle a stuck withdrawal                                       | `payouts.resolve`                                                                                                                                                                                                  |
| `money_issue.close`            | Close a money issue                                             | `payouts.resolve`, and `issues.resolve` to decide or run it                                                                                                                                                        |
| `fee.change`                   | Change a page’s fee                                             | `fees.manage`                                                                                                                                                                                                      |
| `fee.free`                     | Give a page fee-free tips                                       | `fees.manage`                                                                                                                                                                                                      |
| `staff.grant_owner`            | Make someone an owner                                           | `staff.manage`; only an owner decides                                                                                                                                                                              |
| `staff.grant_sensitive`        | Give someone sensitive access                                   | `staff.manage`                                                                                                                                                                                                     |
| `role.add_sensitive`           | Add sensitive access to a role                                  | `staff.manage`                                                                                                                                                                                                     |
| `staff.reset_authenticator`    | Reset someone’s authenticator                                   | An owner, asking and deciding                                                                                                                                                                                      |
| `mail_provider.switch`         | Switch the active email provider                                | `providers.manage`                                                                                                                                                                                                 |
| `username.take_back`           | Take a username back from a page                                | `usernames.manage`; the page’s owner can’t decide it                                                                                                                                                               |
| `business.verify`              | Verify a business                                               | `businesses.manage` (not one of the business’s own managers)                                                                                                                                                       |
| `business.owner_remove`        | Remove a business owner                                         | `businesses.manage` (not one of the business’s own managers)                                                                                                                                                       |
| `tip.reverse`                  | Reverse a refunded or charged-back tip                          | `payments.repair` (any tip, whatever the business switches)                                                                                                                                                        |
| `changelog.publish`            | Show users a What’s new entry                                   | Asked with `changelog.edit`, decided with `changelog.publish`                                                                                                                                                      |
| `pro_price.change`             | Change the Pro price                                            | `pro.price`                                                                                                                                                                                                        |
| `business_pro_price.change`    | Change the Business Pro price                                   | `pro.price`                                                                                                                                                                                                        |
| `pro.refund`                   | Refund a Pro card payment                                       | `payments.repair`                                                                                                                                                                                                  |
| `feature_switch.set`           | Turn a money switch on or off                                   | `switches.manage` (other switches need a reason and a code)                                                                                                                                                        |
| `announcement.send`            | Send an announcement by email                                   | `announcements.send`                                                                                                                                                                                               |
| `tip.refund`                   | Refund a tip (TipMe keeps its fee)                              | `payments.repair` (behind the `tip_refunds` switch)                                                                                                                                                                |
| `plan_fees.change`             | Change TipMe’s fee per plan                                     | `fees.manage` (Free and Pro rates, for new quotes only, `/ops/plan-fees`)                                                                                                                                          |
| `tip_refund.absorb_gap`        | Refund a tip when TipMe has to absorb what can’t be taken back  | `payments.repair` (a You collect tip whose recipient already withdrew part of it; behind the `tip_refunds` switch)                                                                                                 |
| `tip_refund.return`            | Return money a failed refund took back to the recipient         | `payments.repair` (a You collect tip whose refund failed after the recipient's part came back, or after a business's share was pulled back, which goes back to the business; no refund open, no unsettled dispute) |
| `collect_settings.change`      | Change the You collect limits                                   | `fees.manage` (holding cap, reminders, delay, withdrawal limits, reserve levels; `/v1/ops/collect-settings`)                                                                                                       |
| `collect_transfers.pause`      | Pause every You collect transfer                                | `payments.repair` (emergency stop, R11; held tips stay with TipMe)                                                                                                                                                 |
| `collect_transfers.resume`     | Resume You collect transfers                                    | `payments.repair`                                                                                                                                                                                                  |
| `collect_name.change`          | Change a recipient’s verified name                              | `recoveries.manage` (`/ops/collect`; the partner checks the new name with their next bank details before anything more is sent)                                                                                    |
| `collect_transfer.retry`       | Retry a You collect transfer in review                          | `collect.manage` (only from review held by staff or by the partner's answer; same key)                                                                                                                             |
| `collect_transfer.record_paid` | Record a You collect transfer in review as paid                 | `collect.manage` (only when the partner's read-back by its group shows it paid for its amount)                                                                                                                     |
| `collect_dispute.release_hold` | Release a closed dispute’s hold early                           | `collect.manage` (refused while a refund of the tip is in flight or has used the hold)                                                                                                                             |
| `collect_dispute.evidence`     | Submit evidence for a dispute                                   | `collect.manage` (before the deadline, once; the worker submits it to the partner)                                                                                                                                 |
| `collect_same_bank.clear`      | Clear a shared bank account hold                                | `collect.manage` (resolves the `collect_same_bank` issues and puts the held transfers back in the queue)                                                                                                           |
| `tip_refund.record_paid`       | Record a refund the payment partner paid that TipMe didn’t book | `collect.manage` (books it from what TipMe holds for the tip; TipMe absorbs the rest)                                                                                                                              |

Removing a business owner (`business.owner_remove`, interim lock of 14 Nov 2026) is the only way an owner leaves except by stepping down themselves: owners can't remove each other. Use it from the business's page under Businesses, on a support request, after checking it with both owners. Write what you checked as the reason. It never removes the last owner (the founding owner can be removed only this way, while another owner stays), waits for a second person, and emails every owner, the removed one included. The full procedure with notice and objection is plan #204 Phase E.

Reversing a refunded or charged-back tip (`tip.reverse`, business release 2) starts from the partner's `payment_reversed` issue, after checking the refund or dispute in the partner's dashboard. A refund follows the partner's refund guide: `refund.created` only notes it as pending; it can be reversed once `refund.paid` arrives, for exactly the `refunded_amount` the partner reports (enter that amount; a different one is refused); `refund.failed` means nothing moved, so close the issue. A dispute (the partner documents no dispute events) is reversed for the amount you enter. TipMe keeps its fee on a refund (owner, 14 Nov 2026): a refund takes back only what the person and any business received, in proportion, and if the partner refunded more than that, a second `payment_reversed` issue says how much more (TipMe's fee stays in its books). On a chargeback the person gives back only what they received, and TipMe sends its fee back to them once per dispute, for every tip, whatever the switches (owner, 14 Nov 2026: TipMe always bears its fee on a chargeback). A fee on the refund itself is TipMe's cost. Each partner refund or dispute is reversed once: several webhook events about one refund join one issue, a second request for it is refused, and the approval text shows what earlier reversals already took back. A won dispute opens no issue. An issue whose events named no refund or dispute id can't be reversed here; settle it at the partner and close it by hand. Reversing does not close the issue: a `payment_reversed` issue stays open, and keeps that person's withdrawals on hold, until staff resolve it. A reversal can take a balance below zero; withdrawals then stop until it is back, and a `balance_below_zero` money issue opens. It runs for every tip, whatever the business switches, also when approved after they changed (owner, 12 Nov 2026: money the partner moved is never left without its posting). While `refund_fee_return` is on, a final refund (`refund.paid`) is already reversed when it arrives, and asking again is refused as done; while it is off, a final refund waits for staff (the owner's open question, 14 Nov 2026).

`changelog.publish` is the one action asked for with a different permission from the one that decides it. An editor without `changelog.publish` can never run it alone: with no publisher able to enter a code, asking is refused ("Nobody who can approve this is set up yet."). A publisher doesn't ask: their own Approve on the entry page, with a fresh code, is the one approval (owner's default, 6 Nov 2026).

Giving someone a role or permission counts as serious only if it contains something sensitive. A harmless edit applies at once. Hand closes of money issues are serious, except releasing a freeze (below).

**One person, with audit, not a second person.** These act on money or a provider account and don't wait for anyone, by the current ruling. Each takes a fresh code and a written reason, and is audited. Owner: this list is here so you can see it and change it.

| Route                                                            | In plain words                                                                                               | Needs             | What it rests on                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/ops/issues/:id/payout-resume`                          | Queue a held withdrawal to start again, after asking the provider                                            | `payouts.resolve` | The provider read, and the withdrawal job's own checks                                               |
| `POST /v1/ops/bachs/account-recovery`                            | Link a provider account, typed by staff, to a page whose account creation was left unknown                   | `payments.repair` | The read proves the account exists, not whose it is. Identity rests on that person's dashboard check |
| `POST /v1/ops/collect/transfers/:id/review`                      | Hold a You collect transfer never sent, for a manual check ("Send to review")                                | `collect.manage`  | It only stops money; letting it go again is the serious `collect_transfer.retry`                     |
| `POST /v1/ops/collect/disputes/:id/evidence/files`               | Upload one evidence file for a dispute to the partner (PDF, PNG or JPEG, 5 MB; one at Bachs, five elsewhere) | `collect.manage`  | A document, not money; nothing is submitted until `collect_dispute.evidence` is approved             |
| `POST /v1/ops/collect/disputes/:id/evidence/files/:index/remove` | Remove a file added by mistake, before the evidence is sent                                                  | `collect.manage`  | Nothing is submitted; it lets a wrong file be replaced                                               |

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

## Sending an announcement by email

For news that concerns many people at once. It needs `announcements.send`; sending is the serious action `announcement.send` and waits for a second person who holds it too (or runs alone, with the alert, when nobody else does).

**Two kinds (the owner's ruling, 14 Nov 2026):**

- **Service notice:** a change to fees, terms or how TipMe works. It goes to everyone with a confirmed email on a live account, whatever their email settings, and has no unsubscribe link (account mail). Bounces, complaints and deleted accounts still stop it. Only for those changes: anything promotional is News. The screen shows this checklist, and the approver reads "Service notice: goes to everyone."
- **News:** everything else. Only people who turned on **News and announcements** in Settings (off until they do) get it, within the chosen audience: everyone, Free pages, Pro pages or business owners. Each email has the email settings link and the one-click unsubscribe header; unsubscribing turns that switch off. Turning off "guides and suggestions" holds it back too.

1. In **Announcements**, choose **New announcement** and the kind. Write the subject, the preview line (shown after the subject in most inboxes) and the text: plain paragraphs with a blank line between them, `**two stars**` around words for bold, and lines starting `- ` for bullets. One button is optional: a TipMe path such as `/pro`, or an `https` link. Never name the payment partner ("our payment partner"), never imply a regulator approved TipMe, and say "tips" for money. The screen refuses those words.
2. **Save draft**, then **Preview**: the real email, light and dark side by side. **Send a test to me** emails it to your own staff address now.
3. **Ask to send…** with a reason. The screen shows how many people it reaches now; the approver sees the kind, the subject and that number in Approvals. Editing the draft afterwards makes the request stale, so ask again.
4. Once approved, the audience is counted again (the N), and the worker queues the emails at a steady rate: 60 a minute, 10 every 10 seconds, up to the daily limit (below). The screen shows "Sending: x of N" and then "Sent: x of N queued". Announcements wait behind every other email.
5. **Stop sending…** with a reason stops it at once: nothing more is queued. Emails already queued still go.

The same person is never mailed twice for one announcement, even if the worker restarts. Every step is in the audit log (`announcement.created`, `edited`, `test_sent`, `send_started`, `cancelled`, `sent`, and the approval's own rows).

**Which provider.** Announcements go through Brevo only, never ZeptoMail (which sends sign-in codes and forbids bulk mail), and never fall back to it: with no Brevo set up, the screen says "Announcement email isn't set up" and nothing can be tested or sent. Deploy settings (API and worker): `BREVO_API_KEY` and `ANNOUNCEMENT_FROM_ADDRESS` together, and `BREVO_WEBHOOK_TOKEN` for bounce reports. Off production, with no key, announcements go to the pretend inbox.

**The daily limit (15 Nov 2026).** Brevo's free plan sends 300 emails a day; once they are used Brevo refuses the rest until its day turns over. So TipMe never queues more announcement emails than the daily limit in any 24 hours:

- **What counts:** every email that goes through Brevo, from every announcement, staff tests and service notices included: those still waiting in the mail queue (their credit isn't used yet, however old) and those sent in the last 24 hours. Codes, receipts and alerts sent through Brevo (once staff switch them to it, below) count too, once sent, so one announcement can't use up the credits codes need; the limit never holds those back, it only leaves less room for announcements. An email that was never sent (skipped, suppressed, failed) doesn't count. It is counted from the mail queue itself, so there is no separate counter to drift. The window rolls (we don't know the hour Brevo's day starts).
- **At the limit** the send pauses: nothing more is queued, it stays "sending", and it carries on by itself, from where it stopped, as the 24 hours free up. The screen says "Paused: today's limit of 300 is used. Sending continues automatically." with how many are queued, how many are still to go, and when room frees up. Otherwise it shows how much of the limit the last 24 hours used. Staff tests are counted but never held back.
- **Setting it:** **Switches → Limits → Announcement emails a day**: 300 until set, 1 to 100,000. It needs `switches.manage`, a reason and a fresh code, and is audited (`display_setting.set`) with its history. The next batch uses the new value. Raise it only after the Brevo plan is raised.
- **If Brevo still runs out** (credits used outside TipMe, or a limit set above the plan): Brevo answers `400` with the code `not_enough_credits` (its reference also lists `Insufficient credits`). TipMe treats that as a pause, not a refusal: the email goes back to the queue for an hour, as many times as it takes, without using up its attempts, so nothing is marked failed for running out of credits. The rest of that delivery pass waits with it instead of asking Brevo again. The waiting emails still count against the limit, so no more are queued meanwhile. The worker logs `mail.quota_wait`, and its job metric counts `announcements_paused` while the limit holds a send back. Sign-in codes and other mail are unaffected while they go through ZeptoMail or SES. If staff switch them to Brevo (below), they share its credits: a security email (sign-in code, recovery or verification link) that Brevo refuses for credits goes through the backup at once when automatic failover is on (below), and otherwise fails at once instead of waiting (a code held an hour has expired anyway), shows as failed on the Email console and on the Brevo card, and the worker logs a warning, `mail.provider_out_of_credits`; switch back to ZeptoMail or SES in Providers. Other mail through Brevo waits an hour at a time, as announcements do, without pausing announcements (or being paused by them).

**Code defaults, not deploy settings** (owner, 14 Nov 2026: deploy settings are secrets and addresses only). They are absent from the env examples and compose files, and stay overridable in the config schemas for tests and emergencies, by adding them to that copy's env file and its compose `environment` by hand:

- `ANNOUNCEMENT_SENDS_PER_MINUTE` (worker): 60; 1 to 600. Lower it if Brevo or a mailbox provider pushes back.
- `BREVO_SANDBOX` (API and worker): off. `on` makes Brevo check each request and send nothing.
- `BREVO_API_BASE` (API and worker): `https://api.brevo.com`.

**Setting up Brevo (once):**

1. Create a Brevo account (the free plan sends 300 emails a day; a paid plan lifts that).
2. In Brevo, **Senders, domains and dedicated IPs → Domains**: add `usetipme.xyz` and add exactly the DNS records Brevo shows for it at the DNS host: a `brevo-code:` TXT record on the root, the DKIM records (usually two CNAMEs, `brevo1._domainkey` and `brevo2._domainkey`), and a DMARC record if the domain has none (it already has one: keep it). Add an SPF include only if Brevo's screen asks for one, and then in the domain's one SPF record next to the existing includes. Records can take up to 48 hours; then **Verify records** and **Authenticate domain**.
3. Add the sender `news@usetipme.xyz` (name "TipMe News") under **Senders**.
4. **SMTP & API → API keys**: create a key for the server.
5. **Transactional → Settings → Webhook**: add `https://<api host>/v1/webhooks/mail/brevo` for hard bounces, soft bounces, spam, delivered, opened and clicked, with bearer-token authentication set to a long random token.
6. On the server, set `BREVO_API_KEY`, `ANNOUNCEMENT_FROM_ADDRESS=news@usetipme.xyz` and `BREVO_WEBHOOK_TOKEN` (the same token) for the API and the worker, and restart them. Send a test from Announcements to check.

**Switching sign-in codes to Brevo (owner, 23 Nov 2026).** Brevo can also send codes, receipts and alerts, as a provider staff switch to by hand in **Ops → Providers**, like ZeptoMail and SES. Nothing moves to Brevo by itself unless automatic failover is on (below). It is the same Brevo account and API key as announcements, through the same transactional send API, but a separate instance: each email comes from its own type's sender (`security@`, `payments@` and so on, on `MAIL_FROM_DOMAIN`, or `MAIL_FROM_ADDRESS` when that is set), exactly as with ZeptoMail, never from the announcement address.

1. **The domain.** `usetipme.xyz` is authenticated in Brevo (23 Nov 2026). Brevo sends only from an authenticated domain, so check the copy's sender domain is listed under **Senders, domains and dedicated IPs → Domains**: the domain of `MAIL_FROM_ADDRESS` if set (staging sends from `staging@usetipme.xyz`), else `MAIL_FROM_DOMAIN` (production `usetipme.xyz`). Changing those changes ZeptoMail's senders too.
2. **Tracking, before switching production.** Brevo has no per-email switch for click tracking: with it on, the links in recovery, verification and staff-invitation emails are rewritten through Brevo's tracking domain (a one-time link inside a third-party redirect, and a non-TipMe address in front of the person). TipMe asks Brevo for no open pixel and no per-contact tracking on security mail, which Brevo honours only on plans that support it; the Brevo card in Providers carries the same warning. So turn click (and open) tracking off for the account in Brevo's settings, or ask Brevo support to if the plan doesn't offer it. Then, on staging, send yourself a recovery or email-verification email through Brevo and check its link points straight at TipMe, not at a Brevo address. Don't switch production until that check passes.
3. **The webhook.** Nothing new: the one webhook from step 5 (`https://<api host>/v1/webhooks/mail/brevo`, bearer token) serves announcements and codes alike, because every event carries TipMe's reference and lands on its own email. Check it has **delivered, hard bounces, soft bounces, spam, opened and clicked** ticked. Without `BREVO_WEBHOOK_TOKEN` the switch can't be turned on.
4. **The env keys** (API and worker, `/srv/tipme/staging.env` or `/srv/tipme-production/production.env`): `BREVO_API_KEY` and `BREVO_WEBHOOK_TOKEN` (already set for announcements), and `BREVO_TRANSACTIONAL=on`. `ANNOUNCEMENT_FROM_ADDRESS` is not needed for codes. Leave `BREVO_TRANSACTIONAL_SANDBOX` unset (off): on, Brevo checks each code and delivers nothing, and production refuses to start with it on. It is separate from `BREVO_SANDBOX`, so staging can keep announcements dropped while codes really arrive.
5. **Restart the API and the worker** (the next deploy, or recreate both services) so they read the keys. With the switch on but a key missing, both refuse to start and name the key.
6. **Pick Brevo in Ops → Providers.** Its card ("Brevo") appears. Send a test to yourself, open the link in the test email to confirm it, then switch with a reason. A single account can be pinned to Brevo instead under **Pin an account**, to try it on one person first.
7. **Send a test sign-in.** Sign in on that copy with a real address and check the code arrives; the Email console shows it sent through `brevo`, and Brevo's delivered report follows on it.

To switch back, pick ZeptoMail (or SES) in Providers the same way; email already sent through Brevo keeps receiving its delivery and bounce reports. That holds while `BREVO_TRANSACTIONAL` stays on or announcements are set up on that copy: turning `BREVO_TRANSACTIONAL` off on a copy without announcements set up makes Brevo's webhook answer 404, and late bounces for codes already sent through Brevo are lost (nothing suppresses those addresses). So switch providers in ops first, and turn the env switch off only on a copy with announcements set up, or after a few days.

Codes and announcements share the Brevo account's credits: on the free plan, 300 emails a day in all. Codes sent through Brevo count toward the announcement daily limit (above), so announcements leave room for them, but the limit can't stop credits used outside TipMe. A paid Brevo plan is needed before codes go through Brevo for everyone.

The Brevo card's last-24-hours counts (sent, failed, bounced, complaints) mix announcements and codes: both go through Brevo. During an announcement they are mostly the announcement's; to judge codes alone, filter the Email console by type.

## Automatic email failover

Owner, 23 Nov 2026. That day ZeptoMail accepted 8 emails, sign-in codes among them, and never delivered them; nothing in TipMe failed, so nothing noticed. With failover on, email moves to the backup provider by itself while the active one is failing, and moves back once it recovers. Users never see a provider's name.

**Which is the backup.** Whichever of the two providers isn't active: normally ZeptoMail is active and Brevo is the backup; if staff make Brevo active in Providers, ZeptoMail becomes the backup. Announcements are unaffected (they only ever go through Brevo). Provider tests and accounts pinned to a provider never move. The pretend provider is never a backup in production.

**What moves mail.**

- **Send failures.** A timeout, a 5xx answer, a network error, a refused key, account or sender domain, or out of credits: the same email goes through the backup straight away. Three of them within 5 minutes rest the provider for 15 minutes, and all new email goes through the backup meanwhile. A refusal of one address (bad or blocked) never counts: no other provider would do better. Neither does an answer that may hide an accepted email (a success without an id): sending it again elsewhere could deliver it twice, so it waits for its retry as before.
- **When every provider fails.** A provider that is resting is still tried last, once the others have failed for sure, so a wrong trip plus a failing backup (Brevo out of credits, say) never stops a code. If the email still doesn't go, it waits for its normal retry. It fails for good only when every provider refused that email itself, and a security email out of credits fails at once only when no provider failed in any other way.
- **Duplicates are possible.** A timeout or a dropped connection may hide an email the first provider did accept; neither ZeptoMail nor Brevo can be asked to drop a repeat, so the backup may then deliver it a second time. For a code both copies carry the same code and either works; for a receipt or alert the duplicate is only untidy. The same was already true of a retry on the same provider, and three such failures rest the provider.
- **Unused codes.** ZeptoMail reports no deliveries, so TipMe watches the codes people must type: sign-in, email change, recovery and payout destination codes. A code nobody uses within 3 minutes, or one the same address asks for again while it is still valid, counts as unused. TipMe counts people (addresses), not emails: an address counts as served if any of its codes was used in time. When at least 5 addresses got codes through one provider within 10 minutes and at least 60% of them used none, that provider rests for 15 minutes too. One person walking away, asking again and again, or using a few addresses never trips it: that is what counting addresses, the minimum of 5 and the 60% are for.
- **Asking again.** When someone asks for a new code within 10 minutes of the last and didn't use that one, the new one goes through the other provider (when it is healthy), so that person is rescued even before the provider trips.

**Coming back.** After its 15 minutes the provider is on trial: one email after send failures, or the next 3 codes after unused codes (the trial starts with the first code, so a quiet night doesn't count against it). If the email goes, or someone uses one of the trial codes, it is back; if not, it rests another 15 minutes ("trial send failed (…)" or "3 of 3 trial codes unused"). All of this is kept in Redis, so the API and every worker see the same; if Redis loses it, every provider is simply healthy again, which is how mail ran before. Each email's row in the Email console says which provider actually sent it, and a failed try on the first provider shows in its timeline.

**Turning it on.** Set `MAIL_FALLBACK_PROVIDERS=brevo` on the API and the worker (`/srv/tipme/staging.env`, then `/srv/tipme-production/production.env`) and restart both. Brevo must already be a provider there: `BREVO_TRANSACTIONAL=on` with its keys, the domain and tracking checks above done, and a confirmed test in Providers; the API and worker refuse to start if a listed fallback isn't set up, or is the default provider itself. Both copies run it the same way. Empty (the default) turns it off: one provider, nothing switches, exactly as before. The numbers above are code defaults (`docs/runbooks/settings-and-switches.md`), not deploy settings.

**What staff see.**

- **Alerts** (the staff alert route, `ALERT_WEBHOOK_URL`, like the reserve alerts): when a provider trips ("email provider ZeptoMail is resting until 14:30 (Lagos) after 3 send failures in 5 min … New mail goes through Brevo"), when it is still down (at most every 6 hours), and when it recovers.
- **Ops → Providers:** an **Automatic failover** card says which provider is live now and which is the backup. Each provider's card says whether it is healthy, resting until a time (Lagos), or on trial, and why: "3 send failures in 5 min (last: http_503)" or "4 of 6 addresses' codes unused in 10 min". The page refreshes itself while one is resting.

**Fixing the provider (no automatic switching).** During an investigation, **Fix the active provider** on the failover card (`providers.manage`, a reason, a fresh code; audited as `mail_provider.failover_fixed`): everything goes through the active provider and nothing switches or trips while it is fixed. **Let it switch automatically** undoes it (`mail_provider.failover_automatic`). Switching the active provider by hand still works as before either way.

**Clearing a trip by hand.** On a resting or trial provider's card, **Clear** (`providers.manage`, a reason, a fresh code; audited as `mail_provider.health_cleared`, written before the clear takes effect, and not posted to the alert route) makes it healthy at once, for example once ZeptoMail confirms the incident is over. If it is still failing it trips again on its own. While Redis is unreachable Clear answers that the failover state can't be reached; mail keeps flowing through the active provider meanwhile.

**Credits.** Failing over sends codes and receipts through Brevo, which shares its credits with announcements (above). Raise the Brevo plan before relying on it as the backup for everyone.

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
