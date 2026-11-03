# Runbook: switching live payments on

**Who:** the owner. An agent may prepare a step but never ticks a blocking line.

**When real money moves:** funding the reserve in section 3 moves the owner's own money to the payment partner. The first tip moves in section 5, and no stranger can pay until section 6 (the server enforces this with `LIVE_CHECKOUT_HANDLES`).

**Nothing here approves live payments.** D-01 to D-08, D-10 and D-11 in `docs/00-DECISIONS.md` stay open. The owner decided on 1 Nov 2026 that D-02, D-03, D-04, D-06 and D-07 don't block launch: that is the owner's choice to go without them, not an approval of them. The code allows `PAYMENTS_LIVE_ENABLED=true` only on a production copy with `bachs-live` and every setting it needs. The setting stays `false` in every example, compose default and doc, and production keeps it `false` until the owner works through this page.

Rules for this page:

- **BLOCKING** lines stop the switch. They stay unticked here. Each one is done only when the owner has written the result in the place it names.
- Record dates, counts and ids in the [record](#record) at the end, not in chat.
- No script or test calls the live provider. The live money calls here are the owner's own, in section 5.

**Know this before merging, even with payments off.** Once deployed with `bachs-live`, two paths talk to the live provider whatever the switch says. The worker, every 15 minutes, reads the platform balance and accounts and **writes** to live connected accounts: manual payouts and payout capabilities. The API, on every `account.*` or `capability.*` webhook the provider delivers, also **writes** (`ensurePayoutSetup`: account configuration and `balance_settings`). No transfer and no payout on either path. That is live-provider activity while D-03 is open.

- [ ] **BLOCKING:** the owner accepts both paths, in the acceptance, or keeps production from deploying with `bachs-live`.

## 1. Owner decisions and written acceptances

- [ ] **BLOCKING, the ADR:** `AGENTS.md` stops real payments until the processor and funds flow are approved in an ADR. No ADR says that yet: ADR-0004 and ADR-0007 say the opposite. The owner approves one, and its number goes in the acceptance. No agent writes the approval.
- [ ] **BLOCKING, D-01:** launch jurisdiction and currency. The owner says what it is, and whether it blocks.
- [ ] **BLOCKING, D-05:** the remaining fee policy: refunds, chargebacks, and who bears the ₦50 payout fee (TipMe's reserve, as built). Reward cash stays `REWARD_CASH_BUDGET_MINOR_PER_MONTH=0`, and the worker refuses any other value, unless the owner decides otherwise and the config rule is lifted first.
- [ ] **BLOCKING, D-08:** hosting, monitoring budget and who responds when an alert fires. The owner says whether it blocks.
- [ ] **BLOCKING, D-10:** the first launch segment. The owner says whether it blocks.
- [ ] **BLOCKING, D-11:** messaging providers and sender registration. The owner says whether it blocks.
- [ ] **BLOCKING, launching without the follow-ups:** the owner's written acceptance of launching without the items under [Follow up after launch](#follow-up-after-launch-owner-decided-1-nov-2026-signed-acceptance-below), dated and in `docs/00-DECISIONS.md`. The owner decided this in chat on 1 Nov 2026 (recorded there); the dated, signed line is still the owner's to write.
- [ ] **BLOCKING, written acceptance:** the owner fills in the template under "Live pilot acceptance" in `docs/00-DECISIONS.md`. No agent writes or completes it.

### Risks the owner must accept or change

Each of these is open. Each has a line in the acceptance.

- [ ] **BLOCKING, the stolen inbox:** someone who controls a recipient's email inbox can sign in by email, receive the bank-change code at the same inbox, and add their own bank at once. Nothing blocks this until staff are told and freeze the account. **Accept it for the pilot, or ask for a cooldown or second factor first.**
- [ ] **BLOCKING, a stolen session:** a stolen session can move the sign-in email, then add a bank with a code sent to the new address. Moving the email starts the 72-hour bank-change wait for an existing bank, and the recipient's notice doesn't mention that window. A thief can add a bank at hour 72. **Accept it, or ask for a cooldown.**
- [ ] **BLOCKING, slow recovery:** an owner recovering by email waits 24 hours and then the 72-hour bank wait. **Accept it.**
- [ ] **BLOCKING, the limits of the takeover freeze:** it stops withdrawals not yet started and bank changes. It can't recall a withdrawal already with the provider, it depends on someone reporting the takeover, and checking the bank is by hand. Practise it once: Pages → the page → **Freeze withdrawals…**, **End all sessions…**, then resolve the issue. **Accept the limits.**
- [ ] **BLOCKING, a public hint:** `/health/payments` tells anyone whether the reserve is low, and whether the live record matches. It shows no amount. **Accept it.**
- [ ] **BLOCKING, small withdrawals:** the reserve pays ₦50 on each withdrawal, however small. **Accept it** (the default), or ask for a change.
- [ ] **BLOCKING, more than one admin:** check `/ops/approvals` is in the production release before adding a second admin. Second-person approval starts by itself once a second qualified person is set up ([admin-roles.md](admin-roles.md)); with one admin, serious actions run alone and alert. It covers the serious actions listed there, not `payout-resume`, `bachs/account-recovery` or releasing a freeze, which stay one person with audit: **accept that list**, or ask for a change.
- [ ] **BLOCKING, the pilot notice wording:** the owner has read "TipMe is in a pilot. Payments are real. Need help? support@usetipme.xyz" and approves it, or sends new wording.
- [ ] **BLOCKING, Q7:** public launch or closed pilot.
- [ ] **BLOCKING, the withdrawals switch:** read [Stopping withdrawals](#stopping-withdrawals), including what it doesn't stop. **Accept it.**

## Follow up after launch (owner decided, 1 Nov 2026; signed acceptance below)

These don't block launch, by the owner's decision: "Bachs sort most of the compliance, they hold money. Let's skip them. Give a checklist and we'd circle to it later. They shouldn't block launch." They stay open and unticked, for the owner to come back to.

- [ ] **D-02:** company registration, legal agreements and regulator interpretation. Evidence: a legal opinion. Accepted in writing for a closed pilot, or resolved.
- [ ] **D-03:** the payment partner permits tipping, split and settlement. Evidence: its written confirmation, as Q4 decides. A selection or a live key is not that confirmation.
- [ ] **D-04:** custody or non-custody, and who owns the settlement account. Evidence: a signed funds-flow diagram.
- [ ] **D-06:** recipient verification, payout holds and the support model. Includes Q5: may the owner alone settle money issues?
- [ ] **D-07:** fraud, sanctions/AML and regional privacy obligations. Evidence: a compliance assessment.
- [ ] **holds need approval:** `docs/05-SECURITY.md` says payout holds need legal or provider approval. The owner kept the freeze and asked for the withdrawals switch (1 Nov), which decides that they exist. It isn't that approval. Record the approval, or the accepted risk.

## 2. Sandbox checks (staging, recorded in the ledger)

**Status when this page was written: not run.** They need this branch deployed to staging with `PAYMENT_PROVIDER=bachs-sandbox`, which only the owner's deploy does. Local tests fake the provider, so they prove none of these.

Set up: the owner merges this branch to `dev`, and staging deploys. On the server, set `PAYMENT_PROVIDER=bachs-sandbox` with `BACHS_SANDBOX_API_KEY` and `BACHS_WEBHOOK_SECRET` in `staging.env`, then deploy. Create a recipient through the site with the standing test page (`staging-setup.md`), and add a bank on it. Then, on the server, with no key on a command line and nothing printed:

```bash
export KEY=$(grep '^BACHS_SANDBOX_API_KEY=' /srv/tipme/staging.env | cut -d= -f2-)
[ -n "$KEY" ] && echo "key loaded" || echo "NO KEY: a 401 below would mean this, not a finding"
printf 'header = "Authorization: Bearer %s"\n' "$KEY" > ~/.bachs-h && chmod 600 ~/.bachs-h
# On the staging database, for this handle:
#   SELECT a.provider_account_reference, d.destination_reference
#     FROM profiles p JOIN payment_accounts a ON a.profile_id = p.id
#     JOIN payout_destinations d ON d.profile_id = p.id AND d.replaced_at IS NULL
#    WHERE p.handle_lower = '<handle>';
ACCT=<provider_account_reference>
DEST=<destination_reference>
A="X-Account-Id: $ACCT"
B=https://sandbox-api.bachs.io
```

Use `curl -K ~/.bachs-h …` below, and delete `~/.bachs-h` when done. Each check ends with a line in the ledger: the date, the payout or account id, and what was seen. Paste the same into the PR.

- [ ] **BLOCKING, payouts work in the sandbox at all:** withdraw through the site. Record the payout id and each status. If the sandbox doesn't support payouts, record that, and treat the later checks as unproved until the smoke test in section 5, which must then cover them.
- [ ] **BLOCKING, ₦2,000 balance delivers ₦2,000:** a recipient with exactly ₦2,000 withdraws ₦2,000, and ₦2,000 arrives, with the ₦50 cover transfer from the platform balance. If not, the withdraw screen has to show a net amount and the design changes.
- [ ] **BLOCKING, the fee on a failed payout:** fail a payout. Is the ₦50 refunded to the connected account? Does the next withdrawal use that credit rather than sending another ₦50?
- [ ] **BLOCKING, `X-Account-Id` on list:** `curl -K ~/.bachs-h -H "$A" "$B/v1/payouts?reference=<our reference>"` finds the account's payout, and the same call without the header doesn't. If the header is ignored, a missing payout could be misread.
- [ ] **BLOCKING, `X-Account-Id` on the destination read:** `curl -K ~/.bachs-h -H "$A" "$B/v1/payouts/destinations/$DEST"` answers for the account. A persistent 404 leaves replacement banks pending for good.
- [ ] **BLOCKING, the default schedule:** on a **fresh** account before TipMe sets anything, `curl -K ~/.bachs-h -H "$A" "$B/v1/balance_settings"`. Record the default. The adapter only ever writes here, so a 404 or 405 means this read doesn't exist: ask the payment partner instead. If the default is automatic, the gap before the sweep matters: tell the owner.
- [ ] **BLOCKING, `balance_settings` on recipient accounts:** after setup, the same read (or the partner's dashboard) shows manual payouts. If a recipient account refuses it, onboarding stops: the "Manual payouts not set" issue opens.
- [ ] **BLOCKING, reference lookup lag:** immediately after a payout, how long until `?reference=` finds it? It must be well under the 30 minutes after which TipMe treats "not found" as unresolved. Record the longest seen.
- [ ] **BLOCKING, a real `payout.paid`:** from a real delivery in Ops evidence: is `data.amount` the amount sent, or that plus the fee? It decides whether a real payout reads as a mismatch.
- [ ] **BLOCKING, gross amounts on the status read:** confirm before any live payout what `GET /v1/payouts/{id}` reports as `amount` on a real payout: the amount sent, or that plus the fee. If the read reports gross, every payout becomes an unresolvable `payout_conflict`: nothing is booked, the money stays reserved, no staff action applies, and the code has no override. Record the value seen against the amount requested. A gross read stops the switch until the adapter is changed.
- [ ] **BLOCKING, `is_active`:** read `/v1/accounts/$ACCT` on a merchant and on a recipient account, and record `is_active` for both. A recipient reading false would refuse its payouts.
- [ ] **BLOCKING, the worker's jobs on a real provider:** in the staging worker log, `payout_setup.swept` and `reserve.checked` appear every 15 minutes, and Overview shows a reading. A reserve below ₦1,000 reaches the alert address, if staging has one.
- [ ] **BLOCKING, the withdrawals switch on staging:** switch off with a withdrawal queued. It stays queued and reserved, the alert arrives, and it starts when switched back on.
- [ ] **Ask the payment partner:** which error codes and statuses it returns for a transfer from an empty platform balance, and for a bad key. TipMe holds the withdrawal only on `INSUFFICIENT_BALANCE`, `ORGANIZATION_IN_DEBT`, 401 and 403. Any other answer for an empty reserve would fail or strand the withdrawal instead.
- [ ] **Ask the payment partner:** how long it keeps idempotency keys. A key that lapses could let a retry pay twice. TipMe retries nothing unknown without asking, but record the answer.

## 3. Production preparation

With `PAYMENTS_LIVE_ENABLED=false` and `bachs-live` deployed. Run every query as a read on production's database (`remote-database.md`): no writes, and never against a copy.

- [ ] **BLOCKING, the sweep has run with a zero count.** At least one `payout_setup.swept` in the worker log, then:
  ```sql
  SELECT count(*) AS missing_manual_payouts
    FROM payment_accounts
   WHERE environment = 'live' AND provider_account_reference IS NOT NULL
     AND manual_payouts_at IS NULL;
  ```
  Must be **0**. Record it. A non-zero count usually has an open "Manual payouts not set" issue. Each sweep sets up at most 100 accounts, so a backlog takes several runs.
- [ ] **BLOCKING, no sandbox bank on this copy:** a bank reference from a sandbox account is refused by live, so anyone with one can't withdraw until they add it again. Must be **0** on a copy that has only been live, which production should be:
  ```sql
  SELECT count(*) AS sandbox_banks
    FROM payout_destinations d
    JOIN payment_accounts a ON a.profile_id = d.profile_id AND a.provider = d.provider
   WHERE a.environment = 'sandbox' AND d.replaced_at IS NULL;
  ```
- [ ] **BLOCKING, count phone-only accounts.** These people wait 72 hours for their first bank, because adding a first email starts the bank-change wait. A brand-new email sign-up doesn't wait. Record the count; if it is not small, tell them first.
  ```sql
  SELECT count(*) AS phone_only
    FROM users u JOIN profiles p ON p.user_id = u.id
   WHERE u.email IS NULL AND u.phone_e164 IS NOT NULL AND p.page_state <> 'deleted';
  ```
- [ ] **BLOCKING, the active mail provider is not mock.** Check in **Ops → Providers**: ZeptoMail or SES shown active, with a test sent and its link opened. Phone sign-in and bank codes depend on it. Don't rely on `provider_settings`: no row there only means the default setting, which proves nothing.
- [ ] **BLOCKING, `ALERT_WEBHOOK_URL` on the server.** An https address in `/srv/tipme-production/production.env`, on one line, checked by name only (`grep -c '^ALERT_WEBHOOK_URL=https://' production.env` prints 1). The same name as a **repository secret** is separate and serves the watcher: set both. The deploy stops before it starts anything if the server's is missing or not https, and the worker refuses to start without it.
- [ ] **BLOCKING, send one test alert** to that address from the server. The address is a credential, so it stays off the command line and out of shell history:
  ```bash
  url=$(grep '^ALERT_WEBHOOK_URL=' /srv/tipme-production/production.env | cut -d= -f2-)
  printf 'url = "%s"\n' "$url" | curl -fsS -K - -H 'content-type: application/json' -d '{"text":"TipMe test alert: please ignore."}' -o /dev/null && echo sent
  ```
  See it arrive.
- [ ] **BLOCKING, `PILOT_NOTICE=on` before the switch.** In Vercel production, then redeploy the web app (`production.md`, "The pilot notice"). It shows nothing until payments are on.
- [ ] **BLOCKING, the reserve funded.** Real money: the owner pays into the live platform balance through the payment partner's dashboard, as it directs (bank transfer or its top-up page; ask it if the dashboard doesn't say). Above ₦1,000, target ₦20,000. ₦1,000 pays about 20 withdrawals, and the alert fires below it. Overview → Payment reserve shows a fresh reading of that amount.
- [ ] **BLOCKING, the restore drill is recorded** in `production.md` section 5, against Aiven's latest backup.
- [ ] **BLOCKING, the webhook is set up.** The live endpoint and secret are set at the provider, and `pnpm release:check --web … --api … --expect-provider bachs-live --expect-live false` passes (an unsigned call gets 401). **This doesn't prove a real delivery:** with checkout closed nothing happens to deliver. Ask the payment partner whether its dashboard can send a signed test event. If it can, send one and see it in Ops as a provider event (an unmatched one is fine). If not, the owner's ₦1,000 tip in section 5 is the first real delivery, and the check is there.
- [ ] **BLOCKING, the live key's permissions:** `connected_accounts:write`, `transfers:write`, `payouts:write`.
- [ ] **BLOCKING, backups tested on the final migrations.** The 12 backup test entries can't run on a machine without the `tipme-postgres-1` container. CI, or a real 5432 container, must have passed them on this code.
- [ ] **R2:** page photos go to a private R2 bucket only if all four `R2_*` settings are set; otherwise they stay in Postgres, so Aiven's disk and backups grow with them. It moves no money and doesn't block the switch. Decide before section 6 (`photos.md`), since moving later means migrating existing photos.
- [ ] **No admin but the owner:** Ops → Staff lists one person.

## 4. The switch, for the owner's page only

Only with every BLOCKING line above done.

This deploys **the version already running**, so the switch changes one thing and needs no build and no staging pass. **This direct deploy skips the workflow's `production` environment approval:** nobody else is asked, so whoever runs it is the only check. Run these on the server, with `<sha>` from `cat /srv/tipme-production/releases/current`:

1. In `/srv/tipme-production/production.env` set exactly these two lines, once each, with no quotes, spaces or comments. The deploy refuses anything else:
   ```
   PAYMENTS_LIVE_ENABLED=true
   LIVE_CHECKOUT_HANDLES=<the owner's handle>
   ```
   Blank means nobody can pay. Use the page's **current** handle: an old one opens nothing.
2. In GitHub set the repository variable `PRODUCTION_PAYMENTS_LIVE=true`. The watcher complains until the deploy finishes; that is expected for those minutes.
3. Deploy, saying what you expect: `/srv/tipme-production/releases/<sha>/scripts/deploy-production.sh <sha> true`.
   The workflow does the same if you need a new version: `deploy-production` passes the repository variable, but it also builds main's head and needs a staging pass, so don't use it for this unless main is what you mean to ship.
4. Check:
   - `curl -s https://api.usetipme.xyz/health/release` says `paymentsLive: true`, `paymentProvider: bachs-live`.
   - `pnpm release:check --web … --api … --expect-version <sha> --expect-provider bachs-live --expect-live true` passes.
   - Ops → Overview's first line says **Live payments: on. Checkout open to @\<owner\> only.** Its history line says on, and no "disagrees" notice shows.
   - The next watcher run passes, and `/health/payments` says `stale: false`.
   - Another page shows "Tipping opens soon". A page's cached copy can lag by a little, but checkout refuses on the server whatever a page shows.

**If the deploy stops at the preflight,** nothing started, but your edits stay: the env file and the variable still say `true`, so the next deploy or rollback would start live. Fix the problem and go on, or put both back to `false`.

**If a worker refuses to start,** the API is already live: go to [switching off](#switching-off) unless the fix is immediate.

## 5. The smoke test, on the owner's own account, first

One real tip and one real withdrawal, and no more until both end well. Only the owner's page can take tips now.

1. Tip **₦2,000** to the owner's own page with a real card. The pilot notice shows under the Tip button.
2. **This is the real webhook check:** in Ops, see the provider event for the payment arrive, signature verified. If the receipt confirms but no event came, confirmation came from reconciliation: the webhook isn't working, so stop here.
3. See the receipt confirm, and the tip in the dashboard and Ops.
4. Withdraw **₦1,800** (or what the balance allows) to the owner's bank.
5. See it reach the bank, in the expected amount, with its `payout.paid` event in Ops.
6. See in Ops the **₦50 cover transfer** and the **fee line**, and that the reserve dropped by ₦50.
7. Reconcile by hand: TipMe's ledger, the provider's dashboard and the bank must agree. Record the tip, payout and transfer references.

Any disagreement: [switch off](#switching-off) and [stop withdrawals](#stopping-withdrawals) until it is understood. Anything from section 2 that the sandbox couldn't prove must be checked here.

## 6. Widening checkout

Each step is the owner's decision, made after the one before has gone well. Each is an env file change and a deploy of the current version (section 4, step 3).

1. **Named, trusted recipients:** `LIVE_CHECKOUT_HANDLES=<owner>,<handle>,<handle>`. Each has finished payment setup. Watch their first tip and withdrawal.
2. **Everyone:** `LIVE_CHECKOUT_HANDLES=*`, as a separate decision, written in the acceptance (Q7), with the `production.md` section 9 steps. It is not a default and nothing sets it for you.

## Switching off

Stops new tips. **It doesn't stop withdrawals;** for that see the next section. People keep their balances either way.

1. In `production.env` set `PAYMENTS_LIVE_ENABLED=false`.
2. Set the repository variable `PRODUCTION_PAYMENTS_LIVE=false`.
3. On the server: `/srv/tipme-production/releases/<sha>/scripts/deploy-production.sh <sha> false`, with the version already running. It needs no build, approval or staging pass, and ships no new code, so use this in an incident rather than the workflow.
4. Checkout closes. `/health/release` says `paymentsLive: false`, and the Overview says **off**.
5. Tips already started finish through reconciliation, and payouts in flight finish. **Don't** cut the provider key: the worker needs it to finish them. Watch the issues inbox until they have ended.

**To stop one account at once:** freeze it (Pages), rather than switching everyone off.

## Stopping withdrawals

Switching off, freezing a page and ending sessions need no fresh authenticator code, so they work first time in an incident; the permission, the reason and the alert still apply. Switching back on needs a fresh code.

Ops → Overview → **Switch off all withdrawals…**, with a written reason. Needs `payouts.resolve`. It takes effect at the next request and job on every copy, with no deploy, is audited, and posts to the alert route (the reason stays in the audit log). It doesn't depend on `PAYMENTS_LIVE_ENABLED`: tips can stay open with withdrawals off, or the reverse.

**Use it when:** a payout goes wrong in amount or destination, the provider or reserve is in doubt, or a takeover or fraud looks like more than one account. For one account, use the freeze.

**While off:**

- New withdrawals are refused (`WITHDRAWALS_SWITCHED_OFF`). Recipients see "Withdrawals are paused for now. Your balance is safe." before they type an amount.
- Queued withdrawals don't start. They stay reserved, with no failure and no money released, and start when it's back on, except those with an open issue.
- A queued withdrawal on an account that has had **any** hold since it was requested is never sent automatically, even once the hold has ended. It has a `payout_held` issue from the moment the hold lands, so a person resumes it or marks it failed from there, on or off (Resume itself waits until it's back on).
- If the switch can't be read, nothing new starts.

**It doesn't stop:**

- Withdrawals already with the provider. They can't be recalled, and webhooks and reconciliation still settle them.
- One past the check at the moment you switch: a start already under way finishes, or becomes unknown and is read as usual.
- Withdrawals the recipient makes directly at the provider, if that's possible (Q3).
- Tips. Switch those off separately.
- **A version from before this switch ignores it:** don't roll back past it while relying on it.

**Incident steps:**

1. Switch off, with what you know so far as the reason.
2. See the Overview say **Withdrawals are OFF**, and the alert arrive.
3. **Wait about a minute** after switching off before treating what's with the provider as final: a start already past the check can still arrive. Then look at what's there: issues inbox, and the provider's dashboard. Those will still settle.
4. Decide about tips: [switch off](#switching-off) if they are affected too.
5. Tell the affected recipients.
6. When it's understood, switch back on with why it's safe. **Queued withdrawals with no open issue start at once,** so check them first in the provider's and TipMe's records.

### A queued withdrawal keeps its bank

A withdrawal keeps the bank recorded when it was requested, even if the recipient changes bank while it is still queued, for example while withdrawals are switched off or the reserve is empty. This is by design, and the security email's "under way" includes a queued one. Staff see a warning on Resume when the bank changed or a hold touched the withdrawal.

## Rolling back the code

`deploy/scripts/rollback-production.sh` goes to an earlier version. Then run the release check with `--expect-live` set to what `production.env` says.

- **A version from before the fence came out refuses `PAYMENTS_LIVE_ENABLED=true` at startup,** so switch off first, or the older version won't start.
- **A version from before the limited stage has no `LIVE_CHECKOUT_HANDLES`:** with payments on it would open checkout to everyone. Switch off first.
- **A version from before the takeover freeze** would tell a frozen recipient `reason: account_takeover` through its quote, and doesn't refuse bank changes, and one from before the withdrawals switch ignores the switch. Switch off, and clear freezes first, or don't go back that far.
- Migrations stay; only ever add to them. Rollback doesn't run the deploy's preflight, and the Overview's first line follows whatever the rolled-back copy was started with.

## Record

| What                                                | Value | Date | By  |
| --------------------------------------------------- | ----- | ---- | --- |
| Approving ADR number                                |       |      |     |
| Sandbox payout id and statuses                      |       |      |     |
| ₦2,000 delivered ₦2,000                             |       |      |     |
| Fee after a failed payout                           |       |      |     |
| `X-Account-Id` on list and destination read         |       |      |     |
| Default schedule on a fresh account                 |       |      |     |
| `balance_settings` on a recipient account           |       |      |     |
| Longest reference lookup lag                        |       |      |     |
| `payout.paid` `data.amount` means                   |       |      |     |
| `is_active`, merchant and recipient                 |       |      |     |
| Idempotency key retention                           |       |      |     |
| `missing_manual_payouts` (must be 0)                |       |      |     |
| `sandbox_banks` (must be 0)                         |       |      |     |
| `phone_only`                                        |       |      |     |
| Active mail provider                                |       |      |     |
| Reserve funded to                                   |       |      |     |
| Restore drill date                                  |       |      |     |
| Real webhook delivery seen                          |       |      |     |
| Smoke tip, payout and transfer references           |       |      |     |
| `LIVE_CHECKOUT_HANDLES` changes, each with its date |       |      |     |
