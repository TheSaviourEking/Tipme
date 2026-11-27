# Account reset: staff start, the person confirms, the page starts over

**Status:** design, owner's answers in (27 Nov 2026, "go with your picks"); ready to plan
**Builds on:**

- account deletion, `deleteAccount` (`packages/database/src/operations/profiles.ts`) and `DELETE /v1/me/account` (`apps/api/src/profiles/me-profile.controller.ts`);
- payment setup: `payment_accounts`, `payout_destinations` (`packages/database/src/schema.ts`), `payment-accounts.ts`, `payout-destinations.ts`, `collection-mode.ts`, `collect-verification.ts`, `apps/api/src/profiles/payment-accounts.controller.ts`, `apps/api/src/profiles/collect-bank.controller.ts`;
- per-provider balances (`payout-providers.ts`, spec `2026-11-23-per-provider-balances-design.md`);
- Pro (`pro_periods`, `pro_purchases`, `pro_auto_renew`, `pro-auto-renew.ts`, `pro-balance.ts`);
- renames and take-backs (`renameHandle` in `profiles.ts`, `handle_take_backs.free_change_used_at`);
- ops: `packages/contracts/src/ops-catalogue.ts`, `recordAudit` (`audit.ts`), serious actions (`serious-actions-registered.ts`), `POST /v1/ops/pages/:profileId/suspend` (`apps/api/src/ops/actions.controller.ts`);
- emailed one-time links: `email_tokens` (`email.ts`: sha256 stored, 32-byte base64url token, link in the URL fragment, mail expiring with the link) and handover claim links (`username-handovers.ts`: sha256, open/used/cancelled/expired states, ending links of staff who lose the permission).

**(owner decided)** marks the owner's decisions of 27 Nov 2026. **(my call)** marks a choice this document made, with its reason. The owner accepted these picks on 27 Nov ("go with your picks"), and they can still be overturned. **(builder's call)** is left to whoever builds it.

Nothing here assumes any regulatory approval (`docs/00-DECISIONS.md`). No user-facing copy names the payment provider ("our payment partner") or implies TipMe is licensed or approved by anyone.

## 1. Why

Some people set their page up wrongly (wrong name, wrong bank, wrong country at the partner, wrong mode) and want to start again without losing their username, their Pro or their history. Today the only way out is deleting the account, which loses all three. **(owner decided)**

It is a **staff tool**: support starts it, from the ops Pages screen. There is no self-serve button. **(owner decided)**

## 2. Approaches

- **A. A reset operation that reuses deletion's erase steps** (shared code, not a copy). The account, username, Pro and history stay; the page's content is cleared, and the payment setup too when it was never used (§4). **Chosen. (owner decided)**
- **B. Delete, then sign up again.** Rejected: loses the username (held 90 days, then anyone's), all tip history and Pro. **(owner decided)**
- **C. Archive the old page and make a new one under the same login.** Rejected: hides earnings history from the dashboard and statements, and Pro, analytics and handles would all need moving to the new page. **(owner decided)**

## 3. What a reset keeps and clears

### 3.1 Kept (owner decided unless marked)

- The login: the `users` row as it is (phone, email, recovery email, `email_verified_at`).
- The `@username`: `profiles.handle`, `handle_lower`, and every `handle_aliases` row (they keep redirecting to this page, so printed QR codes still land here). `handle_changes_used` / `_extra` are kept, as they never reset today.
- Pro: `plan`, `staff_pro`, `pro_periods`, `pro_purchases`, Business Pro. Pro carries over.
- Business roles: memberships, manager seats, ownership, shifts, table cards. The business's own `payment_accounts` / `payout_destinations` rows (with `business_id`) are not touched.
- Staff access: `staff`, overrides, enrolment, TOTP.
- All money history: `tips`, `tip_messages`, `payment_intents` / `payment_attempts`, `payouts` and `payout_items`, ledger, `tip_refunds`, `disputes`, `collect_transfers`, `share_transfers`, `share_holdbacks`, `provider_fee_credits`, `provider_events`. Still shown in the dashboard history and statements.
- A payment setup that has ever received money: the partner account, its bank details and the collection mode, as they are (§4.1).
- The verified You collect legal name, still locked (§4.4). **(owner decided)**
- Staff-set terms: `custom_fee_bps`, `fee_free_credits`, `reward_grants`.
- Account settings, not page setup **(my call: they describe how the person wants to be told, not what the page shows)**: `notify_*`, `popup_hide_tip_details`, `tip_sound`, `mail_preferences`, `changelog_reads`.
- `support_requests` **(my call: they are likely mid-conversation with support; deletion removes them only because the person is leaving)**.
- `notifications`, `moments`, `weekly_reports`, `profile_reports`, `message_flags`, `first_published_at`, `status`, `visibility` (a hidden page stays hidden: it is a privacy choice, not setup).
- Analytics and page views **(my call: `analytics_events` / `analytics_daily` are keyed by handle and hold no personal data; the handle is kept, so the counts are part of the page's history like tips. Deletion doesn't clear them either)**.
- Handle holds and take-backs **(my call: nothing is held, because the handle doesn't move; a take-back under way carries on unchanged, since it is about the name, which the page still has)**.
- Sessions **(my call: the login is unchanged, so ending sessions protects nothing, and the person is often mid-conversation with support. The confirm step, §5.4, already needs them signed in)**.
- Pro auto-renew saved card **(my call: it lives on TipMe's own account, `pro_auto_renew.customer_reference` / `payment_method_reference`, not on the person's partner account, and pays for the Pro that carries over. Clearing it would lapse their Pro without asking; they can turn it off as today)**.

### 3.2 Cleared (owner decided unless marked)

Page content, by the code deletion already uses (moved into a shared helper, §6.1):

- `profiles`: `display_name` (set to the handle as a placeholder **(my call: the column is NOT NULL; setup asks for a real name before going live)**), `role`, `bio`, `craft`, `note`, `avatar_path`, every `cover_*` column, `links` (and the dead `socials`), `thanks_line`, `thanks_style`, `thanks_signed`, `tip_presets_minor`, `min_tip_minor`, `tip_start_minor`. The last three are reset-only; deletion keeps them. `cover_version` and `avatar_version` only ever go up, so they are left as they are.
- Show-or-hide switches back to their defaults **(my call: they are part of how the page was set up)**: `bio_public` true, `socials_public` true, `phone_public` false, `email_public` false, `qr_style` `'purple'`.
- `page_state` → `'not_live'`.
- `profile_avatars`, `profile_covers`, `profile_cover_renditions` and their bucket objects.
- Page Studio: `deleteStudioData` (styles, drafts, blocks, `studio_images` / files and their objects).
- Pro insights: `campaigns`, `tip_campaigns`, `monthly_recaps`.
- Opted-in supporters: `supporters` (their `tip_supporters` links cascade; the tips stay).
- The payment setup, **only if it never received money** (§4).

While not set up, the public page shows "@handle isn't set up yet" (§7.3). **(owner decided)**

### 3.3 One free username change (owner decided)

A reset includes **one free username change during setup**, on any plan, Free included. It doesn't count against the rename limit (`handle_changes_used` is not increased). The old name keeps redirecting to the page as an alias, exactly as renames do today. Only deletion holds names for 90 days; the earlier draft's "held 90 days" wording was wrong.

Mechanism (modelled on the take-back's `free_change_used_at`):

- `account_resets.free_rename_used_at timestamptz NULL` (§5.2).
- `renameHandle`: when the page's latest confirmed reset has `free_rename_used_at IS NULL` and the page hasn't gone live since that reset, the change is allowed on any plan and isn't counted. It sets `free_rename_used_at` in the same transaction, under the profile lock it already takes. Every other rule is unchanged: reserved names, holds, a take-back under way (which wins, as today), and switching back to one of its own aliases.
- The offer ends when the free change is used or when the page first goes live again after the reset **(my call: the owner said "during setup")**. The setup screen offers "Change your username (free, once)".

## 4. Payment setup: kept if it was ever used, cleared if not (owner decided)

**The rule.** The reset clears the payment setup only if the person's current payment-partner account has **never received money**. If it has, the reset clears the page but **keeps the payment account and its bank details as they are**. A bank change after that goes through today's bank-change flow (emailed code, partner check, security email). **(owner decided)**

This avoids every problem of retiring an account that has money history: late refunds, disputes and reversals on old tips, share and fee transfers, unexpected-payout matching, and per-provider balances.

### 4.1 "Has received money": the exact check

The person's current partner accounts are their `payment_accounts` rows with `profile_id` = the page, one per (provider, environment). For a row with reference `R`, provider `P` and environment `E`, the account **has received money** if any of the following is true. Each is a fact recorded against that account, never inferred:

1. **A tip charged on it.** A `payment_attempts` row whose `provider_reference` starts with `R || ':'` (the scoped `<account>:<charge>` form that `isScopedProviderReference` checks and `attachUnknownBachsCheckoutForOperations` requires), in any status other than `VERIFIED_FAILED` or `EXPIRED`. Status `CREATED` has no reference yet; the guard (§5.3) refuses those anyway. The builder must confirm that every direct attempt on a person's own account stores this scoped form. If any path stores a bare charge id, also count `VERIFIED_SUCCEEDED` attempts whose quote has `collection_mode = 'direct'`, the same provider, and an intent on this profile.
2. **A withdrawal from it.** Any `payouts` row with `account_reference = R`, in any status (a failed payout still had money there to send).
3. **A You collect transfer to it.** Any `collect_transfers` row with `account_reference = R` and `sent_at IS NOT NULL` or `status = 'paid'`.
4. **A fee top-up to it.** Any `provider_fee_credits` row with `account_reference = R`.
5. **A Pro month paid from it.** Any `pro_purchases` row with `account_reference = R`.
6. **A business-share transfer from it.** Any `share_transfers` row with `profile_id` = the page and `provider = P` (these rows carry no account reference, so this is matched by provider; any row means money was there).

If the row has no reference (`FAILED` with a null reference), it has received nothing.

When in doubt, the answer is "used", so the account is kept, which is the safe direction. With several providers, each row is judged on its own: a never-used account at one provider is cleared even if the account at another is kept.

The check runs at start (to tell staff what will happen) and again inside the confirm transaction, after the locks (§5.5). The confirm's answer is the one acted on.

### 4.2 Used account: kept as it is

Nothing in `payment_accounts` or `payout_destinations` changes. Collection mode:

- `collect`: stays `collect` (R7: nobody is moved off collect). **(my call)**
- `direct` or undecided (null): unchanged. They keep their account and mode, and the next quote decides as today. **(my call)**

The verified legal name stays locked (§4.4). `collect_partner_name_digest` and `collect_name_recheck_at` are untouched, because the partner account and bank didn't change.

### 4.3 Never-used account: archived, not retired in place

**Is retiring still needed? Not in the earlier form.** The draft's retire-in-place design (a `retired_at` column, the unique key swapped for a partial index, and every lookup of `payment_accounts` classified) existed so that old tips, payouts and webhooks could still find a used account. A never-used account has no money relationships, so none of that is needed.

The row must still leave `payment_accounts`, though, for three reasons found in the code:

- **Idempotency keys.** The partner create calls use `tipme-acct-<row id>` and `tipme-collect-acct-<row id>`, and `beginPaymentAccountCreation` returns the existing row (restarting a `FAILED` one under the **same id**). Keeping the row would replay the old key, and the partner would hand back the old, wrongly set-up account: the reset wouldn't happen.
- **Collection-mode re-decision.** `nextCollectionMode` decides an undecided person from that one row (`ACTIVE` → `direct`, `ONBOARDING` → `collect`, `UNKNOWN` → wait). Left in place, the old account would decide their mode again.
- **The unique key** `payment_accounts_profile_provider_environment` allows one row per profile, provider and environment, so a fresh account needs the old row gone.

**Design (my call): move the row to a small archive table.** `payment_accounts` then holds only current accounts, so no lookup changes. Reason: that is the simplest shape that frees the key and gives fresh idempotency keys while keeping the old reference on record.

```
payment_account_archive
  id                          uuid pk              -- the old payment_accounts.id
  profile_id                  uuid not null → profiles
  provider                    text not null
  environment                 provider_environment not null
  provider_account_reference  text                 -- null if it never got one
  status                      payment_account_status not null   -- as it was
  manual_payouts_at           timestamptz
  created_at                  timestamptz not null -- the account's
  archived_at                 timestamptz not null
  reset_id                    uuid not null → account_resets
  unique (provider, environment, provider_account_reference)
```

In the confirm transaction:

1. Insert the archive row from the `payment_accounts` row, then delete the row. No table has a foreign key to `payment_accounts.id`.
2. Its active `payout_destinations` get `replaced_at = now`. The rows stay, so `flagSharedBankIn` and `bankCheckedForAnotherName` still see the old hash and name digest. No payout references them, because the account was never used.
3. Open `payment_account_setup.<old id>` issues are resolved by the system with a note "account reset" (builder's call on the outcome word).
4. The partner-quote cache is invalidated for the profile on every configured provider, after commit, as the collect-bank flow does.

What still has to know about the archive (the only code changes outside the reset itself):

- **Account webhooks** (`refreshBachsAccount`, `webhook.service.ts` ~line 621): when `findPaymentAccountByReference` finds nothing, check the archive before `unknownBachsAccount`. If the reference is archived, answer `'ignored'` and log `payment_account.archived_event`. Otherwise every later partner update for the old account would park as `unknown_account`.
- **Binding a reference** (`updatePaymentAccountStatus`, `recoverUnknownPaymentAccount`): refuse a reference that is in the archive (`INVALID_INPUT`), so an archived account can't be bound to anyone again, this person included.
- **Anything else** (a payout, charge or transfer event naming an archived account) finds no account and is parked or raised as today. That is right: a never-used account shouldn't produce such events, and staff should see one if it does.

**At the partner (my call):** the old account stays open at the partner, and TipMe makes no partner call during a reset. The adapter has no close call, and a reset must not depend on a remote call succeeding. Its balance is zero by construction. If a bank was added to it, manual payouts were set first (`ensurePayoutSetup`), so the partner never pays that bank on its own schedule. TipMe simply stops using it.

**Afterwards:** the next setup inserts a **new** row with a new id, so the partner gets fresh keys and creates a fresh account.

**Collection mode for a never-used account:**

- `collect`: stays `collect` (R7). **(my call)**
- `direct` or undecided: → null (undecided). With the old row gone, today's rules (`nextCollectionMode`, `mayAssignCollect`) place them as they would a new sign-up: on `collect` if You collect is on and sign-ups aren't paused, otherwise undecided (`direct`). **(my call)**

Per-provider balances need no change: `ownerFootprint` reads `payment_accounts` (current rows only) and the tips table. A never-used account took no tips, so it leaves the provider set cleanly.

### 4.4 You collect legal name (owner decided)

The verified legal name **stays locked**: `collect_verified_at` and `collect_legal_name` are kept in every case. Changing a verified name remains the two-person serious action `collect_name.change`.

When the account is archived (§4.3), `collect_partner_name_digest` → null (the new partner account doesn't hold the name yet) and `collect_name_recheck_at` → now. That is exactly the state `collect_name.change` leaves today: nothing more is transferred to them until our payment partner has checked their next bank details against the locked name. The collect-bank flow then sends the locked name with the new account's create call.

Trust limits are unchanged. The first-withdrawal cap counts past withdrawals (kept), and the young-account daily limit runs from `collect_verified_at` (kept). A reset gives no fresh "new account" allowance.

### 4.5 Tips that arrive after the reset (my call)

A tip quoted `collect` that lands after the confirm is accepted. The money goes to TipMe's own account and is credited to the person's ledger, as every collect tip is today. A direct quote whose account was archived finds no ready account when its attempt starts, and is refused as today (`PAYMENT_ACCOUNT_REQUIRED`). `createPaymentIntent` is not changed. The done email says nothing about tips being blocked (§8.2).

### 4.6 A bank change straddling the confirm (my call)

- The guard (§5.3) refuses while a bank-change code was spent but its change isn't finished.
- The destination save (`setPayoutDestination` and the collect-bank route) re-reads the person's current `payment_accounts` row under the profile lock it already takes. It refuses with `ACCOUNT_CHANGED` if the account it registered the bank on is not the current one (the row was archived in between). The person then adds their bank again on the new account.

## 5. The flow

### 5.1 Staff start it

`POST /v1/ops/pages/:profileId/reset` with `{ reason }` (`opsReasonSchema`), `@OpsPermission('accounts.reset')`, `@FreshCode()` **(my call: it clears a person's page, so it costs a fresh code like the other destructive actions)**. One transaction, taking locks in the order in §5.6:

1. Lock the person's open recovery rows, then the profile row.
2. Refuse with a coded error if:
   - there is no page, or it is deleted (`PROFILE_NOT_FOUND`);
   - it is a rehearsal page (`INVALID_INPUT`);
   - it is suspended (`PAGE_SUSPENDED`) **(my call: a pause is often about the page's content, and a reset would wipe what staff are reviewing; unpause first)**;
   - there is no verified email (`EMAIL_VERIFICATION_REQUIRED`) **(the address must be verified)**;
   - it is the staff member's own account (`CANNOT_RESET_SELF`) **(my call)**;
   - an email or phone recovery is open (`RECOVERY_OPEN`) **(my call: the address the link goes to may be about to change, and an open recovery is a takeover signal)**;
   - the guard (§5.3) fails.
3. Lock the profile's open `account_resets` row, if any, and cancel it (reason "Replaced by a new reset link").
4. Insert the new `account_resets` row, and queue the confirm email (§8.1) to `users.email`, with the mail's `expiresAt` equal to the link's.
5. `recordAudit`: `account_reset.requested`, permission `accounts.reset`, subject `profile` / id, the staff reason, and `withAuditChange` details `{ resetId, expiresAt, paymentSetup: 'clear' | 'keep' }`. Never the token.

Response: `{ resetId, expiresAt, maskedEmail, paymentSetup: 'clear' | 'keep' }`. The ops card tells staff which case applies: "Their payment setup has received money, so it stays; they change bank details the normal way" or "Their payment setup was never used, so it's cleared too".

### 5.2 The table

```
account_resets
  id                   uuid pk
  profile_id           uuid not null → profiles
  user_id              uuid not null → users
  requested_by         uuid not null → users     -- the staff member
  reason               text not null             -- staff-only, never emailed
  email                text not null             -- normalised address the link went to
  token_sha256         text not null unique
  created_at           timestamptz not null
  expires_at           timestamptz not null      -- created_at + 24 h
  confirmed_at         timestamptz               -- the reset ran
  cancelled_at         timestamptz
  cancelled_by         uuid → users              -- null when the person or the system cancelled
  cancel_reason        text
  last_refusal         text                      -- the last confirm refusal code, for staff
  free_rename_used_at  timestamptz               -- §3.3
  unique index account_resets_open on (profile_id) where confirmed_at is null and cancelled_at is null
  check expires_at > created_at
  check not (confirmed_at is not null and cancelled_at is not null)
  check (cancelled_at is null) = (cancel_reason is null)
  check free_rename_used_at is null or confirmed_at is not null
```

States, derived as in `username-handovers.ts`: `open`, `expired` (open past `expires_at`), `confirmed`, `cancelled`.

- **Link (my call):** 32 random bytes, base64url (as `email_tokens`), only the sha256 stored. It is carried in the URL fragment `/account/reset#r=<token>`, so no server or log sees it, and built with `mailLink(..., personal = true)`, so redacted copies hide it.
- **Expiry (my call):** 24 hours, the same as the email-verification link. Staff can send a new one, which cancels the old.
- **Single use:** `confirmed_at` is set in the transaction that runs the reset. A confirm refused by the guard does **not** use the link up **(my call: the person can withdraw, then try again before expiry)**. It records `last_refusal` for staff.

### 5.3 The guard

Deletion's money guard, unchanged and shared: extract `refuseWhileMoneyIsTheirs(tx, profileId)` from `deleteAccount`. It refuses with `HAS_BALANCE` while `available`, `confirming`, You collect `kept`, `on its way` or `refund held` is above zero, or while `collectMoneyHeld` holds (money held for recipients, or held for a dispute). **(owner decided)**

The reset also refuses while anything is still moving through the person's payment setup **(my call: so the "has received money" answer, §4.1, can't change under the reset, and a never-used account is archived only when nothing is about to land on it)**:

| Condition                                                                                                                                                                                                                            | Code                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| a payment attempt for the page in `CREATED`, `STARTING`, `INITIATED`, `PENDING` or `UNKNOWN`                                                                                                                                         | `PAYMENT_IN_PROGRESS`       |
| a `payouts` row for the profile in `REQUESTED` or `PROCESSING` (my call)                                                                                                                                                             | `PAYOUT_IN_PROGRESS`        |
| a `share_transfers` row for the profile in `waiting`, `out_sent`, `out_paid`, `in_sent` or `review`                                                                                                                                  | `SHARE_IN_PROGRESS`         |
| a `pro_purchases` row for the profile in `PENDING`, `COLLECTING`, `UNKNOWN` or `REVIEW` (my call: `REVIEW` is a payment staff haven't settled)                                                                                       | `PRO_PAYMENT_IN_PROGRESS`   |
| a `collect_transfers` row for the profile in `sent`, `unknown` or `review`                                                                                                                                                           | `HAS_BALANCE`               |
| an open `tip_refunds` row on the page's tips                                                                                                                                                                                         | `HAS_BALANCE`               |
| an active `withdrawal_holds` row (reversal, debt, unexpected payout, account takeover)                                                                                                                                               | `WITHDRAWAL_HOLD`           |
| a current payment account in `CREATING` or `UNKNOWN` (my call: it may exist at the partner with no reference here yet)                                                                                                               | `PAYMENT_SETUP_IN_PROGRESS` |
| a `payout_destination` email code for the person's address consumed in the last 30 minutes with no `payout_destinations` row for the profile created since (my call; builder sets the window from the bank route's provider timeout) | `BANK_CHANGE_IN_PROGRESS`   |

**Share-transfer states, from the code (my call):**

- **`gap` is final.** `recordGap` moves an `out_sent` row to `gap` and records a `share_holdbacks` row in the same transaction. Nothing moves the row again, and the hold-back is settled from the business's later shares, by profile.
- **`done` and `cancelled` are final.**
- **`review` is not final.** `toReview` parks a stuck transfer with an open `share_transfer_stuck` issue for staff to settle, and its money may still be on the account. So `review` blocks, and `gap` doesn't.

For a `PAYMENT_SETUP_IN_PROGRESS` refusal, the ops card says "Their payment setup is stuck mid-way. Resolve it first (payment repair), then start the reset again". The `payments.repair` recovery is the existing tool.

A negative balance (debt after a reversal) does not block. The debt is on the ledger by profile and is recovered as today.

### 5.4 The person confirms

The email's button opens `/account/reset#r=<token>` on the web app.

- `POST /v1/me/account-reset/preview` `{ token }` (a POST only to carry the token, never in a query string) answers `{ state, handle, expiresAt, paymentSetup: 'clear' | 'keep', refusal? }`. It changes nothing.
- The page **requires sign-in to the same account** **(my call: the link proves the inbox, the session proves the account; a forwarded link, or one opened while signed in as someone else, fails as `invalid`)**. Signed out, it sends them to sign in and back, keeping the fragment.
- It lists plainly what will be cleared and what stays (the same lists as the email, with the payment line for their case), and offers two buttons: **Reset my page** and **Don't reset**.
- `POST /v1/me/account-reset/confirm` `{ token }` (SessionGuard, CsrfGuard, rate limited like the other code and link routes) runs §5.5.
- `POST /v1/me/account-reset/decline` `{ token }` cancels it (`cancelled_by` null, reason "Declined by the account owner"), audited as `account_reset.declined` with no staff member **(my call)**.

### 5.5 Confirm: one transaction

1. Find the reset by `token_sha256` **without a lock**, to learn `profile_id` and `user_id`. If none is found, or `user_id` isn't the caller's, answer `invalid`.
2. Take the locks in §5.6's order: the person's open recovery rows, then the profile row (`FOR UPDATE`), then the `account_resets` row (`FOR UPDATE`).
3. Re-check under the locks:
   - the reset is open and unexpired (else `expired` / `cancelled` / `invalid`);
   - `email` still equals the caller's current verified `users.email` (a changed address kills the link);
   - the requester still holds `accounts.reset`;
   - everything in §5.1 step 2, including the whole guard (§5.3).

   On a refusal, set `last_refusal`, commit only that, and answer the code. Nothing is cleared.

4. Decide `paymentSetup` per account by §4.1, now, under the locks.
5. Run the shared erase (§6.1). Then either archive the never-used accounts (§4.3), with the collection mode and You collect columns as §4.3–§4.4 say, or keep the setup (§4.2).
6. Set `confirmed_at`. Expire the page's open quotes **(builder's call how: `expires_at = now` if quotes may be updated, otherwise a check at attempt start)**. Queue the done email (§8.2).
7. `recordAudit`: `account_reset.completed`, permission `accounts.reset`, `staffUserId` = the requester, subject `profile`, reason "Confirmed by the account owner", details `{ resetId, paymentSetup, archivedAccountIds, replacedDestinationIds }`.

After commit (as the delete route does):

- `removeObjects(photos, photoKeys)`;
- `revalidator.revalidate(handle)` (aliases redirect to the handle, so they need nothing);
- live signals to `{ user }`: `profile.changed`, `payments.changed` and `account.changed`, so the person's other tabs re-read. No `sessions.changed`, because sessions are kept;
- the partner-quote cache invalidation when an account was archived.

**Race with an incoming tip.**

- An attempt that exists before the confirm's lock is non-final, so the guard refuses.
- When the account is **kept**, a tip after the commit is an ordinary tip on a kept account. Nothing changes for it.
- When the account is **archived**, an attempt starting after the commit finds no current account and is refused (direct), or goes to TipMe's account (collect, §4.5).
- The window in between is closed by the profile lock. Inserting an intent or attempt takes `FOR KEY SHARE` on `profiles` through its foreign key, which conflicts with the confirm's `FOR UPDATE`. The builder must check that the account reference an attempt charges is read after its row exists, or under such a lock, and is never cached across transactions. If it isn't, add a `FOR SHARE` read of the profile in `claimAttemptStart`. A barrier test proves it (§10).

### 5.6 Lock order (my call: deleteAccount's order, so the reset can't deadlock with deletion or recoveries)

Start, confirm, decline and staff cancel all take locks in the same order:

1. The person's recovery rows (`phone_recoveries` and `email_recoveries` for the user, `FOR UPDATE`), as `deleteAccount`, `addStaff` and completing a recovery do.
2. The profile row (`FOR UPDATE`), as anything that mails its owner does.
3. The `account_resets` row.
4. Then everything else: payment accounts, destinations, content tables, the archive, mail and audit rows.

No staff-admin lock is taken, because staff rows aren't touched. The automatic cancel when a requester loses `accounts.reset` runs inside staff-change transactions, which already hold the staff-admin lock. It must not wait on profile locks, so it locks open `account_resets` rows with `skipLocked` and repeats the open condition in its update, as `endLinksOfStaffWithoutAccess` does. The confirm re-checks the requester's permission under its own lock (§5.5 step 3), so a skipped row can't slip through.

### 5.7 Second staff approval: no (my call)

The owner set a permission plus the person's email confirmation. A second staff approval would add delay but no protection against the real risks. Staff error or ill will is already stopped by the person's own confirmation, and a person resetting their own page is what the tool is for. The permission is **sensitive**, so granting it already needs a second person (`staff.grant_sensitive`). The verified legal name stays locked, so a reset can't replace the identity behind the account.

### 5.8 While it is pending

- **Staff** see a "Reset" card on the page (the ops Pages screen; `OPS_PAGE_LOOKUP_PERMISSIONS` gains `accounts.reset`). It shows "Reset link sent to j•••@g•••.com by {staff} at {time}, expires {time}", whether the payment setup will be kept or cleared, and the last refusal in words if any ("They still have money with us", "A withdrawal is on its way"). It has **Cancel** (with a reason, audited as `account_reset.cancelled`) and **Send a new link** (which is the same as starting again).
- **The person** sees nothing new in the app; the email is the notice **(builder's call whether to add a dashboard banner)**.
- **Cancelled automatically** (by the system, audited with no staff member, as `endLinksOfStaffWithoutAccess` does): when the requester no longer holds `accounts.reset`; when the account's email changes; when the account is deleted (`deleteAccount` cancels open resets along with its other pending links); when the page is suspended.

## 6. Code shape

### 6.1 Shared erase (owner decided: shared code, not a copy)

Extract from `deleteAccount` into `packages/database/src/operations/page-erase.ts`:

- `refuseWhileMoneyIsTheirs(tx, profileId)`: the guard block. Deletion calls it with its rehearsal exception kept at the call site.
- `erasePageContent(tx, { profileId, now }): Promise<string[]>`: the content fields, supporters, campaigns / `tip_campaigns` / recaps, avatars, covers and renditions, and Studio. It returns the object keys.

Deletion then still applies its own extras: the handle → `deleted:<id>`, holds, aliases, take-backs, `support_requests`, the user erase and sessions. The reset adds its own: tip amounts and thanks, the defaults in §3.2, and `page_state`.

`deleteAccount`'s behaviour must not change: its existing integration tests pass unchanged.

### 6.2 New operations (`packages/database/src/operations/account-reset.ts`)

- `startAccountReset(db, { profileId, staffUserId, reason, sealing, now })`
- `previewAccountReset(db, { token, userId, now })`
- `confirmAccountReset(db, { token, userId, sealing, photos, now }) → { handle, photoKeys, archived: boolean }`
- `declineAccountReset(db, { token, userId, now })`
- `cancelAccountReset(db, { resetId, staffUserId, reason, now })`
- `openAccountResetFor(db, profileId)` (for the ops card)
- `paymentSetupUsed(tx, profileId) → Map<accountId, boolean>` (§4.1)
- `archiveUnusedPaymentSetup(tx, { profileId, resetId, now }) → { archivedAccountIds, replacedDestinationIds }` (§4.3)
- `isArchivedAccountReference(db, { provider, environment, reference })` (for the webhook and the two binding paths)

### 6.3 Permission (owner decided)

`'accounts.reset'` in `OPS_PERMISSIONS`: description "Reset a person's page so they can start again, once they confirm by email", group `people`, `sensitive: true`. The `role_permissions_known` check is built from `OPS_PERMISSIONS`, so it needs a migration. No system role gets it by default **(my call: the owner grants it)**.

### 6.4 Migrations

1. `account_resets` (§5.2).
2. `payment_account_archive` (§4.3).
3. `role_permissions_known` with `accounts.reset`.
4. Optional: a `profiles` marker if the web needs one for the "isn't set up yet" notice; the latest confirmed `account_resets` row may be enough **(builder's call)**.

All are additive. The `payment_accounts` constraints and columns don't change.

## 7. Screens

### 7.1 Ops

For holders of `accounts.reset`, the page's ops view gets a **Reset page** card. It shows what is cleared and kept (the short lists, with the payment line for this person's case), a reason box and a fresh code, then the pending state (§5.8). Refusals show in words, never as codes.

### 7.2 Confirm page

`apps/web/src/app/account/reset/page.tsx` (or under `/dashboard`; builder's call), mobile-first, following the design constitution. Its states:

- **open:** the lists and the two buttons;
- **refused:** why, and what to do ("Withdraw what's in your balance, then open this link again", "Wait for your withdrawal to arrive, then open this link again");
- **done:** "Your page is ready to set up again", leading to setup;
- **expired**, **cancelled**;
- **invalid:** one neutral message for the wrong account, a used link or an unknown one.

### 7.3 "Isn't set up yet" (owner decided)

- **Public page:** today a `not_live` page answers like an unknown one ("We can't find @handle"). A page that was reset and isn't live again shows "@handle isn't set up yet" instead, with no name, photo or tip form, and `noindex`. The handle was public and printed QR codes lead here, so this reveals nothing new. Once the page goes live, it shows as normal.
- **Dashboard:** after a reset, the dashboard shows the setup steps from the start, as for a new account, headed "Your page isn't set up yet". The steps are name, the free username change (§3.3), photo, amounts, and payment setup: shown as done when it was kept, from the start when it was cleared. The builder reads the dashboard's existing setup logic and makes a reset page read as new.

## 8. Emails (`packages/mail/src/templates/types/account-reset.ts`, registered in `registry.ts`)

Both are `category: 'security'`, `sender: 'security'`, `preference: null`. They go to the verified `users.email` only, through `mailOwner`, with dedupe keys `account_reset_confirm.<resetId>` and `account_reset_done.<resetId>`. The wording is plain; the partner is "our payment partner"; nothing implies TipMe is licensed or approved.

### 8.1 `account_reset_confirm` (`waiting: true`)

Data: `{ token, handle, paymentSetup: 'clear' | 'keep' }`. Subject "Confirm resetting your TipMe page".

- "Our support team started a reset of your page @{handle}, as you asked. Nothing changes until you confirm."
- **This will clear:** your name, bio, photo and cover; your links; your page style and designs; your tip amounts and thank-you message; your campaigns, monthly recaps and the supporters who chose to be recognised. With `clear`, also: "your bank details and your link to our payment partner".
- **This keeps:** your sign-in, your email, your username @{handle} (you can change it once for free while you set up), your Pro, your business roles, and all your tips, withdrawals and statements. With `keep`, also: "your bank details and payment setup, because money has already been paid through them. You can change your bank details as usual from your settings."
- Alarm block: "**This can't be undone.** Once you confirm, what's listed above is gone for good."
- Button "Review and confirm". Quiet line: "The link works for 24 hours. If you didn't ask for this, ignore this email and reply to tell us."

### 8.2 `account_reset_done`

Data: `{ handle }`. Subject "Your TipMe page was reset". Body: "Your page @{handle} is ready to set up again. Until you finish, it shows as not set up yet. Your tips, withdrawals and statements are all still there." Button "Set up your page". Alarm: "Didn't do this? Reply to this email straight away."

It makes no claim that the page can't receive tips (a collect tip may still arrive, §4.5).

## 9. Threat model

Update `docs/security/threat-model.md`:

- **P6 row:** add "A staff-started reset (permission `accounts.reset`, confirmed by the person through a one-time emailed link while signed in) erases the same page content as deletion, through the same code, and keeps money records, the account and the handle." Add the new test files to its evidence column.
- **New row (people / account integrity), "A staff member wipes or redirects someone's page":**
  - Mitigations: a sensitive permission; a fresh code; the person's confirm (inbox plus signed-in session, single use, 24 h, sha256 only, link in the fragment); the guard re-checked under lock; the verified legal name kept locked; a payment setup that has received money is never touched; an unused one is archived (never re-bound) rather than reused; every step audited.
  - Residual: someone holding both the person's inbox and their session can confirm; an unused partner account stays open at the partner (zero balance, manual payouts if a bank was added).

## 10. Tests the builder must write

Integration (`packages/database/test/integration/account-reset.test.mjs`, `tests/integration/account-reset-api.test.mjs`):

- **Cleared:** after confirm, every cleared column is at its reset value. `profile_avatars`, `profile_covers`, `profile_cover_renditions`, the Studio tables, `campaigns`, `tip_campaigns`, `monthly_recaps`, `supporters` and `tip_supporters` have no rows for the page, and their bucket objects are removed.
- **Kept:** a snapshot of `users`, `sessions`, `staff`, business rows, `pro_periods`, `pro_purchases`, `pro_auto_renew`, `tips`, `tip_messages`, `payouts`, ledger, `tip_refunds`, `disputes`, `collect_transfers`, `share_transfers`, `notifications`, `support_requests`, `handle_aliases`, `handle_holds`, analytics, and the kept profile columns is byte-identical before and after.
- **Used vs never used:** one test per signal in §4.1 makes the account "used". Then `payment_accounts`, `payout_destinations`, `collection_mode` and the You collect columns are byte-identical after the reset.
- **Never-used account:**
  - the row moves to `payment_account_archive` and is gone from `payment_accounts`, and its destinations get `replaced_at`;
  - `beginPaymentAccountCreation` then inserts a **new** row with a new id, so the idempotency key differs;
  - `nextCollectionMode` sees no account;
  - an account webhook for the archived reference is ignored and writes nothing;
  - `updatePaymentAccountStatus` and `recoverUnknownPaymentAccount` refuse the archived reference;
  - with several providers, only the unused account is archived.
- **Mode:** `collect` stays `collect` in both cases; `direct` / null with an unused account → null; `direct` with a used account → unchanged.
- **Legal name:** `collect_verified_at` and `collect_legal_name` are kept in both cases. When archived, `collect_name_recheck_at` is set, and transfers are held until the recheck clears.
- **Guard:** each condition in §5.3 refuses both start and confirm with its code, and a refused confirm changes nothing but `last_refusal`. A `gap` share transfer doesn't block; a `review` one does.
- **Races:**
  - money arrives between start and confirm → confirm refuses;
  - a barrier test runs an attempt start and a confirm concurrently: either the confirm refuses, or the attempt finds no archived account;
  - a bank save across a confirm that archives → `ACCOUNT_CHANGED`;
  - a collect-quote tip after confirm is credited as usual.
- **Free rename:** one change on Free after a reset is allowed and not counted, and the old name is an alias; a second is refused on Free; the offer ends once the page goes live; a take-back under way still wins.
- **Link:** reuse after confirm → `invalid`; expired → `expired`; after a new link, the old one → `cancelled`; a different signed-in account → `invalid`; email changed since → `invalid`; the requester lost the permission → refused; decline cancels; the token never appears unsealed in audit rows, logs or mail rows.
- **Permission:** without `accounts.reset` → 403; without a fresh code → refused; resetting yourself, suspended, rehearsal, deleted and unverified-email pages, and open recoveries → refused; the requester losing the permission cancels the open reset.
- **Locks:** a confirm concurrent with `deleteAccount` and with a recovery completing doesn't deadlock.
- **Audit:** requested, cancelled, declined and completed rows carry the right permission, subject and staff member.
- **Deletion unchanged:** the existing `deleteAccount` tests pass without edits.

E2E (`tests/e2e/account-reset.spec.ts`): staff start a reset from the ops Pages screen and see the pending card with the payment line. The person opens the emailed link (pretend mailbox), sees the lists, confirms, and lands on setup with the free username change offered; the public page shows "@handle isn't set up yet". Also the decline and expired paths, and a refused confirm. Run on phone and desktop.

## 11. Out of scope

- Self-serve reset (owner: a staff tool).
- Any partner call to close an unused account.
- Clearing a payment setup that has received money (owner: kept; bank changes go through the normal flow).
- Resetting a business, or a business's payment setup.

## Appendix: if a used account ever has to be retired

Not needed by this design. It is kept here so nobody has to rediscover it. Retiring an account **with** history in place would need:

- a `retired_at` column;
- `payment_accounts_profile_provider_environment` swapped for a partial unique index. In Drizzle, that is ``uniqueIndex(...).on(profileId, provider, environment).where(sql`retired_at IS NULL AND profile_id IS NOT NULL`)``;
- every lookup classified as "the person's account now" (filter retired) or "whose reference is this" (match retired, never write).

The "now" lookups include:

- `beginPaymentAccountCreation`, `updatePaymentAccountStatus`, `getReadyPaymentAccount` and `readyForNewTips`, `getPaymentAccountForProfile`, `getBachsAccountRecoveryTarget`, `recoverUnknownPaymentAccount`, `markPaymentAccountCreation*`, `expireStalePaymentAccountCreations`;
- `nextCollectionMode`;
- `collectAccountReference` (`collect-verification.ts` ~line 219);
- `ensurePayoutSetup` / `sweepPayoutSetup` and the `payout-destinations.ts` ~line 821 join;
- `payoutRoute`, the pro-balance account read, the share-transfer source account;
- `currentAccount()` in `collect-transfers.ts`, whose scalar subquery needs the filter or it returns two rows;
- `ownerFootprint` and `bankAccountAt`;
- the `payment_account_setup` issue joins.

The "whose" lookups are:

- `findPaymentAccountByReference`;
- `findBachsAttemptByOperationReference`;
- `getUnknownBachsAttemptForOperations`;
- `attachUnknownBachsCheckoutForOperations`;
- the unexpected-payout match in `payout-start.ts`.

`paymentAccountSetupInFlight` is global (any CREATING row in the provider and environment), not per person, so it needs no filter.
