# Runbook: switching live payments on

**Who:** the owner. An agent may prepare a step but never ticks a blocking line. **Real money moves after step 4.**

**Nothing here approves live payments.** D-02 to D-07 in `docs/00-DECISIONS.md` are open. The code allows `PAYMENTS_LIVE_ENABLED=true` only on a production copy with `bachs-live` and every setting it needs. The setting stays `false` in every example, compose default and doc, and production keeps it `false` until the owner works through this page.

Rules for this page:

- **BLOCKING** lines stop the switch. They stay unticked here. Each one is done only when the owner has written the result in the place it names.
- Record dates, counts and ids in the [record](#record) at the end, not in chat.
- Never call the live provider from a script or test. The only live money calls are the owner's own ₦1,000 smoke test in step 5.

## 1. Owner decisions and written acceptances

- [ ] **BLOCKING, D-02:** company registration, legal agreements and regulator interpretation. Evidence: a legal opinion. Accepted in writing for a closed pilot, or resolved.
- [ ] **BLOCKING, D-03:** the payment partner permits tipping, split and settlement. Evidence: its written confirmation, as Q4 decides. A selection or a live key is not that confirmation.
- [ ] **BLOCKING, D-04:** custody or non-custody, and who owns the settlement account. Evidence: a signed funds-flow diagram.
- [ ] **BLOCKING, D-05:** the remaining fee policy: refunds, chargebacks, and who bears the ₦50 payout fee (TipMe's reserve, as built). Reward cash stays `REWARD_CASH_BUDGET_MINOR_PER_MONTH=0`, and the worker refuses any other value, unless the owner decides otherwise and the config rule is lifted first.
- [ ] **BLOCKING, D-06:** recipient verification, payout holds and the support model. Includes Q5: may the owner alone settle money issues?
- [ ] **BLOCKING, D-07:** fraud, sanctions/AML and regional privacy obligations. Evidence: a compliance assessment.
- [ ] **BLOCKING, written acceptance:** the owner fills in the template under "Live pilot acceptance" in `docs/00-DECISIONS.md`. No agent writes or completes it.

### Risks the owner must accept or change

Each of these is open. Write the choice in the acceptance.

- [ ] **BLOCKING, the stolen inbox:** someone who controls a recipient's email inbox can sign in by email, receive the bank-change code at the same inbox, and add their own bank at once. Nothing blocks this. **Accept it for the pilot, or ask for a cooldown or second factor first.**
- [ ] **BLOCKING, a stolen session:** a stolen session can move the sign-in email, then add a bank with a code sent to the new address. Moving the email starts the 72-hour bank-change wait for an existing bank, and the recipient's notice doesn't mention that window. A thief can add a bank at hour 72. The staff tool that moves a sign-in email (`ops:set-email`) doesn't end the account's sessions either, so a thief already signed in stays signed in; end them by hand when using it for a takeover. **Accept it, or ask for a cooldown.**
- [ ] **BLOCKING, slow recovery:** an owner recovering by email waits 24 hours and then the 72-hour bank wait. **Accept it.**
- [ ] **BLOCKING, the takeover freeze:** `docs/00-DECISIONS.md` said payout holds stay out of admin until there are two staff. The freeze on the Pages screen, built for this pilot, is a narrow exception: one admin can stop withdrawals for a reported takeover, moving no money. **Confirm the exception, or ask for it to be removed.** Practise it once: Pages → the page → **Freeze withdrawals…**, then resolve the issue.
- [ ] **BLOCKING, a public hint:** `/health/payments` tells anyone whether the reserve is low. It shows no amount. **Accept it.**
- [ ] **BLOCKING, small withdrawals:** the reserve pays ₦50 on each withdrawal, however small. **Accept it** (the default), or ask for a change.
- [ ] **BLOCKING, one admin only:** second-person approval has not shipped here. Until it has, production has **one** admin, the owner. A second admin before then is the owner's risk to decide in writing.
- [ ] **BLOCKING, the pilot notice wording:** the owner has read "TipMe is in a pilot. Payments are real. Need help? support@usetipme.xyz" and approves it, or sends new wording.
- [ ] **BLOCKING, Q7:** public launch or closed pilot.

## 2. Sandbox checks (staging, recorded in the ledger)

**Status when this page was written: not run.** They need this branch deployed to staging with `PAYMENT_PROVIDER=bachs-sandbox`, which only the owner's deploy does. Local tests fake the provider, so they prove none of these.

Set up: the owner merges this branch to `dev`, and staging deploys. On the server, set `PAYMENT_PROVIDER=bachs-sandbox` with `BACHS_SANDBOX_API_KEY` and `BACHS_WEBHOOK_SECRET` in `staging.env`, then deploy. Create a recipient through the site with the standing test page (`staging-setup.md`) and note its account id as `$ACCT`, and its destination as `$DEST`. For the reads below, on the server:

```bash
H="Authorization: Bearer $BACHS_SANDBOX_API_KEY"   # read from staging.env; do not paste it anywhere
A="X-Account-Id: $ACCT"
B=https://sandbox-api.bachs.io
```

Each check ends with a line in the ledger: the date, the payout or account id, and what was seen. Paste the same into the PR.

- [ ] **BLOCKING, payouts work in the sandbox at all:** withdraw through the site. Record the payout id and each status. If the sandbox doesn't support payouts, record that, and treat the later checks as unproved until the ₦1,000 smoke test in step 5, which must then cover them.
- [ ] **BLOCKING, ₦1,000 balance delivers ₦1,000:** a recipient with exactly ₦1,000 withdraws ₦1,000, and ₦1,000 arrives, with the ₦50 cover transfer from the platform balance. If not, the withdraw screen has to show a net amount and the design changes.
- [ ] **BLOCKING, the fee on a failed payout:** fail a payout. Is the ₦50 refunded to the connected account? Does the next withdrawal use that credit rather than sending another ₦50?
- [ ] **BLOCKING, `X-Account-Id` on list:** `curl -H "$H" -H "$A" "$B/v1/payouts?reference=<our reference>"` finds the account's payout, and the same call without the header doesn't. If the header is ignored, a missing payout could be misread.
- [ ] **BLOCKING, `X-Account-Id` on the destination read:** `curl -H "$H" -H "$A" "$B/v1/payouts/destinations/$DEST"` answers for the account. A persistent 404 leaves replacement banks pending for good.
- [ ] **BLOCKING, the default schedule:** on a **fresh** account before TipMe sets anything, `curl -H "$H" -H "$A" "$B/v1/balance_settings"`. Record the default. If it is automatic, the gap before the sweep matters: tell the owner.
- [ ] **BLOCKING, `balance_settings` on recipient accounts:** after setup the same read shows manual payouts. If a recipient account refuses it, onboarding stops: the "Manual payouts not set" issue opens.
- [ ] **BLOCKING, reference lookup lag:** immediately after a payout, how long until `?reference=` finds it? It must be well under the 30 minutes after which TipMe treats "not found" as unresolved. Record the longest seen.
- [ ] **BLOCKING, a real `payout.paid`:** from a real delivery in Ops evidence: is `data.amount` the amount sent, or that plus the fee? It decides whether a real payout reads as a mismatch.
- [ ] **BLOCKING, `is_active`:** read `/v1/accounts/$ACCT` on a merchant and on a recipient account, and record `is_active` for both. A recipient reading false would refuse its payouts.
- [ ] **BLOCKING, the worker's jobs on a real provider:** in the staging worker log, `payout_setup.swept` and `reserve.checked` appear every 15 minutes, and Overview shows a reading. A reserve below ₦1,000 reaches the alert address, if staging has one.
- [ ] **Ask the payment partner:** how long it keeps idempotency keys. A key that lapses could let a retry pay twice. TipMe retries nothing unknown without asking, but record the answer.

## 3. Production preparation

Run every query as a read on production's database (`remote-database.md`). Never against a copy, and with no writes.

- [ ] **BLOCKING, the sweep has run with a zero count.** With `PAYMENTS_LIVE_ENABLED=false` and `bachs-live` deployed, at least one `payout_setup.swept` in the worker log, then:
  ```sql
  SELECT count(*) AS missing_manual_payouts
    FROM payment_accounts
   WHERE environment = 'live' AND provider_account_reference IS NOT NULL
     AND manual_payouts_at IS NULL;
  ```
  Must be **0**. Record it. A non-zero count usually has an open "Manual payouts not set" issue.
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
- [ ] **BLOCKING, the active mail provider is not mock.** Ops → Providers shows ZeptoMail or SES active, with a test sent and opened. Phone sign-in and bank codes depend on it. Or:
  ```sql
  SELECT active_provider FROM provider_settings WHERE kind = 'mail';
  ```
- [ ] **BLOCKING, `ALERT_WEBHOOK_URL` on the server.** An https address in `/srv/tipme-production/production.env`, checked by name only (`grep -c '^ALERT_WEBHOOK_URL=https://' production.env` prints 1). The same name as a **repository secret** is separate and serves the watcher: set both. The deploy stops before it changes anything if the server's is missing or not https, and the worker refuses to start without it.
- [ ] **BLOCKING, send one test alert** to that address from the server, with a harmless text, and see it arrive.
- [ ] **BLOCKING, `PILOT_NOTICE=on` before the switch.** In Vercel production, then redeploy the web app (`production.md`, "The pilot notice"). It shows nothing until payments are on.
- [ ] **BLOCKING, the reserve funded.** The live platform balance is above ₦1,000 (target ₦20,000). ₦1,000 pays about 20 withdrawals, and the alert fires below it. Overview → Payment reserve shows a fresh reading.
- [ ] **BLOCKING, the restore drill is recorded** in `production.md` section 5, against Aiven's latest backup.
- [ ] **BLOCKING, the live webhook is verified.** The endpoint and secret are set at the provider, and a real delivery shows in Ops as provider events. `pnpm release:check --web … --api … --expect-provider bachs-live --expect-live false` passes.
- [ ] **BLOCKING, the live key's permissions:** `connected_accounts:write`, `transfers:write`, `payouts:write`.
- [ ] **BLOCKING, backups tested on the final migrations.** The 12 backup test entries can't run on a machine without the `tipme-postgres-1` container. CI, or a real 5432 container, must have passed them on this code.
- [ ] **R2:** page photos go to a private R2 bucket only if all four `R2_*` settings are set; otherwise they stay in Postgres, so Aiven's disk and backups grow with them. It moves no money and doesn't block the switch. Decide before opening the site (`photos.md`), since moving later means a migration of existing photos.
- [ ] **No admin but the owner:** Ops → Staff lists one person.

## 4. The switch

Only with every BLOCKING line above done:

1. In `/srv/tipme-production/production.env` set `PAYMENTS_LIVE_ENABLED=true`.
2. In GitHub set the repository variable `PRODUCTION_PAYMENTS_LIVE=true`. The watcher starts complaining until the deploy finishes; that is expected for those minutes.
3. Run the `deploy-production` workflow. Its release check passes `--expect-live` from that variable.
4. Check:
   - `curl -s https://api.usetipme.xyz/health/release` says `paymentsLive: true`, `paymentProvider: bachs-live`.
   - Ops → Overview says **Live payments: on since \<time\>, by \<version\>**.
   - The next watcher run passes, and `/health/payments` says `stale: false`.

If the deploy stops at the alert address, nothing changed. If a worker refuses to start, the API is already live: go to [switching off](#switching-off) unless the fix is immediate.

## 5. The smoke test, on the owner's own account, first

Before anyone else can pay. One real tip and one real withdrawal, and no more until both end well.

1. Tip **₦1,000** to the owner's own page with a real card. The pilot notice shows under the Tip button.
2. See the receipt confirm, and the tip in the dashboard and Ops.
3. Withdraw **₦1,000** (or what the balance allows) to the owner's bank.
4. See it reach the bank, in the expected amount.
5. See in Ops the **₦50 cover transfer** and the **fee line**, and that the reserve dropped by ₦50.
6. Reconcile by hand: TipMe's ledger, the provider's dashboard and the bank must agree. Record the tip, payout and transfer references.

Any disagreement: **switch off**, and don't open the site. Anything from section 2 that the sandbox couldn't prove must be checked here.

Only then open the site as Q7 decides (`production.md`, section 9).

## Switching off

1. In `production.env` set `PAYMENTS_LIVE_ENABLED=false`.
2. Set the repository variable `PRODUCTION_PAYMENTS_LIVE=false`.
3. Run `deploy-production`. Checkout closes; `/health/release` says `paymentsLive: false`, and Overview says **off since**.
4. Tips already started finish through reconciliation, and payouts in flight finish. **Don't** cut the provider key: the worker needs it to finish them. Watch the issues inbox until they have ended.

**To stop one account at once:** freeze it (Pages), rather than switching everyone off.

## Rolling back the code

`deploy/scripts/rollback-production.sh` goes to an earlier version. **A version from before this page's commit refuses `PAYMENTS_LIVE_ENABLED=true` at startup**, so switch off first (above), or the older version won't start. Rolling back between versions that both have this page needs nothing extra. Migrations stay; only ever add to them.

Rollback doesn't run the alert-address check, and the record in Overview follows whatever the rolled-back copy was started with.

## Record

| What                                        | Value | Date | By  |
| ------------------------------------------- | ----- | ---- | --- |
| Sandbox payout id and statuses              |       |      |     |
| ₦1,000 delivered ₦1,000                     |       |      |     |
| Fee after a failed payout                   |       |      |     |
| `X-Account-Id` on list and destination read |       |      |     |
| Default schedule on a fresh account         |       |      |     |
| `balance_settings` on a recipient account   |       |      |     |
| Longest reference lookup lag                |       |      |     |
| `payout.paid` `data.amount` means           |       |      |     |
| `is_active`, merchant and recipient         |       |      |     |
| Idempotency key retention                   |       |      |     |
| `missing_manual_payouts` (must be 0)        |       |      |     |
| `sandbox_banks` (must be 0)                 |       |      |     |
| `phone_only`                                |       |      |     |
| Active mail provider                        |       |      |     |
| Reserve funded to                           |       |      |     |
| Restore drill date                          |       |      |     |
| Live webhook delivery seen                  |       |      |     |
| Smoke tip, payout and transfer references   |       |      |     |
