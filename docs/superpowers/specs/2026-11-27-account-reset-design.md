# Account reset: staff start, the person confirms, the page starts over

**Status:** design draft, awaiting the owner's review (27 Nov 2026)
**Builds on:**

- account deletion, `deleteAccount` (`packages/database/src/operations/profiles.ts`) and `DELETE /v1/me/account` (`apps/api/src/profiles/me-profile.controller.ts`);
- payment setup: `payment_accounts`, `payout_destinations` (`packages/database/src/schema.ts`), `payment-accounts.ts`, `payout-destinations.ts`, `collection-mode.ts`, `collect-verification.ts`, `apps/api/src/profiles/payment-accounts.controller.ts`, `apps/api/src/profiles/collect-bank.controller.ts`;
- per-provider balances (`payout-providers.ts`, spec `2026-11-23-per-provider-balances-design.md`);
- Pro (`pro_periods`, `pro_purchases`, `pro_auto_renew`, `pro-auto-renew.ts`, `pro-balance.ts`);
- ops: `packages/contracts/src/ops-catalogue.ts`, `recordAudit` (`audit.ts`), serious actions (`serious-actions-registered.ts`), `POST /v1/ops/pages/:profileId/suspend` (`apps/api/src/ops/actions.controller.ts`);
- emailed one-time links: `email_tokens` (`email.ts`: sha256 stored, 32-byte base64url token, link in the URL fragment, mail expiring with the link) and handover claim links (`username-handovers.ts`: sha256, open/used/cancelled/expired states, ending links of staff who lose the permission).

**(owner decided)** marks the owner's decisions of 27 Nov 2026. **(my call)** marks a choice this document made, with its reason; the owner can overturn it while reviewing. **(builder's call)** is left to whoever builds it. **⚑ owner** flags a call I think the owner should confirm before building.

Nothing here assumes any regulatory approval (`docs/00-DECISIONS.md`). No user-facing copy names the payment provider ("our payment partner") or implies TipMe is licensed or approved by anyone.

## 1. Why

Some people set their page up wrongly (wrong name, wrong bank, wrong country at the partner, wrong mode) and want to start again without losing their username, their Pro or their history. Today the only way out is deleting the account, which loses all three. **(owner decided)**

It is a **staff tool**: support starts it, from the ops Pages screen. There is no self-serve button. **(owner decided)**

## 2. Approaches

- **A. A reset operation that reuses deletion's erase steps** (shared code, not a copy). The account, username, Pro and history stay; the page's content and payment setup are cleared. **Chosen. (owner decided)**
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
- Staff-set terms: `custom_fee_bps`, `fee_free_credits`, `reward_grants`.
- Account settings, not page setup **(my call: they describe how the person wants to be told, not what the page shows)**: `notify_*`, `popup_hide_tip_details`, `tip_sound`, `mail_preferences`, `changelog_reads`.
- `support_requests` **(my call: they are likely mid-conversation with support; deletion removes them only because the person is leaving)**.
- `notifications`, `moments`, `weekly_reports`, `profile_reports`, `message_flags`, `first_published_at`, `status`, `visibility` (a hidden page stays hidden: it is a privacy choice, not setup).
- Analytics and page views **(my call)**: `analytics_events` / `analytics_daily` are keyed by handle and hold no personal data; the handle is kept, so the counts are part of the page's history like tips. Deletion doesn't clear them either.
- Handle holds and take-backs **(my call)**: nothing is held, because the handle doesn't move. A take-back under way carries on unchanged (it is about the name, which the page still has).
- Sessions **(my call)**: kept. The login is unchanged, so ending sessions protects nothing, and the person is often mid-conversation with support. The confirm step (§5) already needs them signed in.
- Pro auto-renew saved card **(my call)**: kept. It lives on TipMe's own account (`pro_auto_renew.customer_reference` / `payment_method_reference`), not on the person's partner account, and pays for the Pro that carries over; clearing it would lapse their Pro without asking. They can turn it off as today.

### 3.2 Cleared (owner decided unless marked)

Page content, by the code deletion already uses (moved into a shared helper, §6.1):

- `profiles`: `display_name` (set to the handle as a placeholder **(my call: the column is NOT NULL; setup asks for a real name before going live)**), `role`, `bio`, `craft`, `note`, `avatar_path`, every `cover_*` column (`cover_version` / `avatar_version` only ever go up, so they are left), `links` (and the dead `socials`), `thanks_line`, `thanks_style`, `thanks_signed`, `tip_presets_minor`, `min_tip_minor`, `tip_start_minor` (reset-only: deletion keeps these).
- Shown-or-not switches back to their defaults **(my call: they are part of how the page was set up)**: `bio_public` true, `socials_public` true, `phone_public` false, `email_public` false, `qr_style` `'purple'`.
- `page_state` → `'not_live'`.
- `profile_avatars`, `profile_covers`, `profile_cover_renditions` and their bucket objects.
- Page Studio: `deleteStudioData` (styles, drafts, blocks, `studio_images` / files and their objects).
- Pro insights: `campaigns`, `tip_campaigns`, `monthly_recaps`.
- Opted-in supporters: `supporters` (their `tip_supporters` links cascade; the tips stay).

Payment setup (§4):

- the person's `payment_accounts` rows are **retired**, not deleted (§4.2);
- their active `payout_destinations` rows get `replaced_at = now`;
- `collection_mode` → null (undecided), so today's rules place them again at their next quote or setup;
- You collect facts: `collect_partner_name_digest` → null. The verified legal name stays locked (§4.4 ⚑ owner).

The page then shows "not set up yet" until they finish setup again **(owner decided)**; §7.3 says where.

If they later pick a new username, today's rename rules apply. **Discrepancy, ⚑ owner:** the owner's note says "the old one is held 90 days like today", but today a rename (`renameHandle`) keeps the old name as an alias pointing at the page for as long as the page exists, which is stronger than a hold; only deletion holds names for 90 days. This design changes nothing there: the reset doesn't rename, and a later rename is today's Pro-only, counted rename. If the owner wants the reset to include a free rename, that is a follow-up (the take-back "free change" flag is the model).

## 4. Payment setup: what exactly happens

This is the riskiest part. The facts it rests on, from the code:

- `payment_accounts` has `UNIQUE (profile_id, provider, environment)` (`payment_accounts_profile_provider_environment`) and `UNIQUE (provider, environment, provider_account_reference)`. No table has a foreign key to `payment_accounts.id`.
- `beginPaymentAccountCreation` returns the existing row for that key, and only restarts it when `FAILED`, **keeping its id**. The partner create calls use `tipme-acct-<row id>` (direct onboarding) and `tipme-collect-acct-<row id>` (You collect bank). So reusing the row would replay the old idempotency key, and the partner would hand back the **old** account.
- `nextCollectionMode` decides an undecided recipient from that one row: `ACTIVE` → `direct`. With the old row visible, resetting `collection_mode` to null would put them straight back on the old account.
- Webhooks find a person by account reference (`findPaymentAccountByReference`, `findBachsAttemptByOperationReference`) and then refresh the account by profile (`updatePaymentAccountStatus`), which refuses a reference that differs from the row's.
- `payouts.destination_id` references `payout_destinations.id`, so destinations can't be deleted; `payout_destinations_active` is unique on `(profile_id, provider) WHERE replaced_at IS NULL`.

### 4.1 At the partner (my call)

The partner account stays at the partner. TipMe makes **no** partner call during a reset: there is no close or deactivate call in the adapter, and a reset must not depend on a remote call succeeding. The old account already has manual payouts set (`manual_payouts_at`, ensured before any bank goes on), so the partner never pays its bank on its own schedule, and the guard (§5.3) ensures nothing is left on it. TipMe simply stops using it. A later cleanup at the partner, if the owner wants one, is a separate staff task.

### 4.2 The old row: retired (my call)

**Retired, not deleted and not reset in place.** Reason: deleting loses the mapping that late webhooks and reconciliation need for old tips and payouts; resetting in place replays the old idempotency key and returns the old account.

Migration:

- `payment_accounts.retired_at timestamptz NULL`, plus `retired_reason text NULL` with `CHECK (retired_reason IS NULL OR retired_reason = 'account_reset')` and `CHECK ((retired_at IS NULL) = (retired_reason IS NULL))`.
- Drop the constraint `payment_accounts_profile_provider_environment`. Replace it with a unique index on `(profile_id, provider, environment) WHERE retired_at IS NULL AND profile_id IS NOT NULL`. The business constraint stays as it is (businesses are never reset).
- `payment_accounts_provider_environment_reference` stays global, so a retired reference can never be bound to anyone else, nor bound again to this person.

A later decision then creates a **new row with a new id**, so the partner gets fresh keys (`tipme-acct-<new id>`, `tipme-collect-acct-<new id>`) and creates a fresh account.

Every read of `payment_accounts` falls into one of two kinds, and the builder must classify each one (there are about 18 typed lookups by `profile_id` plus raw SQL in `collect-transfers.ts`, `collect-recon.ts`, `payout-providers.ts`, `provider-split.ts` and `issues.ts`):

- **"The person's account now"**: add `retired_at IS NULL`. Includes `beginPaymentAccountCreation`, `updatePaymentAccountStatus`, `getReadyPaymentAccount`, `getPaymentAccountForProfile`, `getBachsAccountRecoveryTarget`, `paymentAccountSetupInFlight`, `markPaymentAccountCreation*`, `expireStalePaymentAccountCreations`, `nextCollectionMode`, `collectAccountReference`, `ensurePayoutSetup` / `sweepPayoutSetup`, the pro-balance account read, the share-transfer source account, `currentAccount` in `collect-transfers.ts`, `ownerFootprint`'s accounts part and `bankAccountAt` in `payout-providers.ts`, and the `payment_account_setup` issue joins.
- **"Whose account is this reference"**: match retired rows too, but never write to them. `findPaymentAccountByReference` returns a new `retired: boolean`; `findBachsAttemptByOperationReference` keeps matching by reference, so a late signed event for an old tip still finds its attempt.

Webhook behaviour for a retired account:

- An **account** event (`refreshBachsAccount`, `webhook.service.ts` ~line 621): `retired` → `'ignored'`, logged as `payment_account.retired_event`. No status write, no "ready" email.
- A **payout** event (`applyBachsPayout`): still matched and applied by payout reference, as today. The guard means none is open at reset, so this only covers a late duplicate.
- A **charge**, refund or dispute event for an old tip: matched by attempt, as today. A dispute after the reset debits the person's ledger as any dispute does, whichever account the money went through. That debt follows the person (the ledger is per profile), not the account. Residual risk, noted in §9.

### 4.3 Bank details and per-provider balances

- Active `payout_destinations` (`profile_id`, any provider, `replaced_at IS NULL`) get `replaced_at = now`. The rows stay, so statements still show "to bank ••1234", `payouts.destination_id` stays valid, and `flagSharedBankIn` / `bankCheckedForAnotherName` still see the old hash and digest. If the person adds the same bank again, that is their own profile, so it is not "shared".
- Open bank-change codes for this account (`requestPayoutDestinationCode`) are spent or removed (builder's call which), so a code sent before the reset can't add a bank afterwards.
- Per-provider balances: `ownerFootprint`'s **tips** part still lists every provider that took their tips (history), so those providers stay in their provider set; the **accounts** part excludes retired rows. The guard means their balance at every provider is zero at reset. `bankAccountAt` excludes retired rows, so no withdrawal part is ever sent to an old account.
- The partner-quote cache is invalidated for this profile on every configured provider (`partnerCache.invalidate`), as the collect-bank flow does.
- Open `payment_account_setup.<old row id>` issues are resolved by the system with a note "account reset" (builder's call on the outcome word).

### 4.4 You collect facts (my call, ⚑ owner)

The **verified legal name stays locked**: `collect_verified_at` and `collect_legal_name` are kept, `collect_partner_name_digest` → null (the new partner account has no name yet), and `collect_name_recheck_at` → now. Reason: changing a verified name is the serious action `collect_name.change`, which needs a second staff member. If a reset cleared the name, one staff member plus the person's inbox could replace the identity behind an account that keeps its username and Pro, skipping that approval. Setting the recheck marker puts the person in exactly the state that action leaves today: nothing more is transferred to them until our payment partner has checked their next bank details against the locked name.

If the name itself was the mistake, support uses `collect_name.change` once they are on `collect` again. ⚑ The owner may prefer the reset to clear the name too. If so, clear all four columns, and the reset should then become a serious action (§5.6).

Trust limits: the first-withdrawal cap counts past withdrawals, which are kept, so it isn't granted again. The young-account daily limit runs from `collect_verified_at`, which is kept. A reset gives no fresh "new account" allowance and takes none away.

### 4.5 Collection mode

`collection_mode` → null. With the old row retired, today's rules (`nextCollectionMode`, `signUpCollectionMode`'s helper `mayAssignCollect`) see no account and place them on `collect` if You collect is on and sign-ups aren't paused, or leave them undecided (`direct`), as for a new sign-up. Open quotes of the page are expired in the same transaction (builder's call how: `expires_at = now` if quotes may be updated, otherwise a reset marker the attempt start checks), so no supporter starts a payment on a quote fixed before the reset.

## 5. The flow

### 5.1 Staff start it

`POST /v1/ops/pages/:profileId/reset` with `{ reason }` (`opsReasonSchema`), `@OpsPermission('accounts.reset')`, `@FreshCode()` **(my call: it clears a person's page and payment setup, so it costs a fresh code like the other destructive actions)**. In one transaction:

1. Lock the profile row (`FOR UPDATE`).
2. Refuse with a coded error if: there is no page or it is deleted (`PROFILE_NOT_FOUND`); it is a rehearsal page (`INVALID_INPUT`); it is suspended (`PAGE_SUSPENDED`) **(my call: a pause is often about the page's content, and a reset would wipe what staff are reviewing; unpause first)**; there is no verified email (`EMAIL_VERIFICATION_REQUIRED`) **(the address must be verified, as asked)**; it is the staff member's own account (`CANNOT_RESET_SELF`) **(my call)**; an email or phone recovery is open (`RECOVERY_OPEN`) **(my call: the address the link goes to may be about to change, and an open recovery is a takeover signal)**; the money guard (§5.3) fails (`HAS_BALANCE` or the specific code). The money check also runs at the start, so staff don't send a link that can't work. It runs again at confirm.
3. Cancel any open reset for this profile (reason "Replaced by a new reset link").
4. Insert an `account_resets` row and queue the confirm email (§8.1) to `users.email`, with the mail's `expiresAt` equal to the link's.
5. `recordAudit`: `account_reset.requested`, permission `accounts.reset`, subject `profile` / id, the staff reason, and `withAuditChange` details `{ resetId, expiresAt }`. Never the token.

Response: `{ resetId, expiresAt, maskedEmail }`.

### 5.2 The table

```
account_resets
  id                uuid pk
  profile_id        uuid not null → profiles
  user_id           uuid not null → users
  requested_by      uuid not null → users        -- the staff member
  reason            text not null                -- staff-only, never emailed
  email             text not null                -- normalised address the link went to
  token_sha256      text not null unique
  created_at        timestamptz not null
  expires_at        timestamptz not null         -- created_at + 24 h
  confirmed_at      timestamptz                  -- the reset ran
  cancelled_at      timestamptz
  cancelled_by      uuid → users                 -- null when the person or the system cancelled
  cancel_reason     text
  last_refusal      text                         -- the last confirm refusal code, for staff
  unique index account_resets_open on (profile_id) where confirmed_at is null and cancelled_at is null
  check expires_at > created_at
  check not (confirmed_at is not null and cancelled_at is not null)
  check (cancelled_at is null) = (cancel_reason is null)
```

States, derived as in `username-handovers.ts`: `open`, `expired` (open past `expires_at`), `confirmed`, `cancelled`.

- **Link (my call):** 32 random bytes, base64url (as `email_tokens`), only the sha256 stored, carried in the URL fragment `/account/reset#r=<token>` so no server or log sees it, `mailLink(..., personal = true)` so redacted copies hide it.
- **Expiry: 24 hours (my call):** the same as the email-verification link. Staff can send a new one, which cancels the old.
- **Single use:** `confirmed_at` is set in the transaction that runs the reset. A refused confirm (money arrived) does **not** use the link up **(my call: the person can withdraw, then try again before expiry)**. It records `last_refusal` for staff.

### 5.3 The money guard (owner decided, plus my additions)

Deletion's guard, unchanged and shared (extract `refuseWhileMoneyIsTheirs(tx, profileId)` from `deleteAccount`): refused while `available`, `confirming`, You collect `kept`, `on its way` or `refund held` is above zero, or `collectMoneyHeld` (held for recipients, or held for a dispute). **(owner decided)**

The reset also retires the partner account, so it refuses while anything is still moving through that account **(my call: deletion doesn't need these because it never lets the account be used again; a reset does)**:

- a payment attempt for the page in `CREATED`, `STARTING`, `INITIATED`, `PENDING` or `UNKNOWN` (a supporter mid-payment would be paid into the retired account) → `PAYMENT_IN_PROGRESS`;
- a `share_transfers` row for the profile not `done` or `cancelled` (a business's share is not in the person's balance but sits on their account until swept) → `SHARE_IN_PROGRESS`;
- a `pro_purchases` row with `method = 'balance'` in `PENDING`, `COLLECTING` or `UNKNOWN` → `PRO_PAYMENT_IN_PROGRESS`;
- a `collect_transfers` row for the profile in `sent`, `unknown` or `review` → `HAS_BALANCE`;
- an open `tip_refunds` row on the page's tips → `HAS_BALANCE`;
- an active `withdrawal_holds` row (reversal, debt, unexpected payout, account takeover) → `WITHDRAWAL_HOLD` (staff look at the linked issue first);
- a current payment account in `CREATING` or `UNKNOWN` (it may exist at the partner with no reference here yet) → `PAYMENT_SETUP_IN_PROGRESS`.

A negative balance (debt after a reversal) does not block. The debt is on the ledger by profile and is recovered as today.

### 5.4 The person confirms

The email's button opens `/account/reset#r=<token>` on the web app.

- `POST /v1/me/account-reset/preview` `{ token }` (a POST only to carry the token, never in a query string) answers `{ state, handle, expiresAt, refusal? }`. It changes nothing.
- The page **requires sign-in to the same account** **(my call: the link proves the inbox, the session proves the account. A forwarded link, or one opened while signed in as someone else, fails as `invalid`)**. Signed out, it sends them to sign in and back, keeping the fragment.
- It lists plainly what will be cleared and what stays (the same lists as the email), with two buttons: **Reset my page** and **Don't reset**.
- `POST /v1/me/account-reset/confirm` `{ token }` (SessionGuard, CsrfGuard, rate limited like other code/link routes) runs §5.5.
- `POST /v1/me/account-reset/decline` `{ token }` cancels it (`cancelled_by` null, reason "Declined by the account owner"), audited as `account_reset.declined` with no staff member **(my call)**.

### 5.5 Confirm: one transaction

Lock order follows `deleteAccount`'s: recovery rows, then the page, then anything naming the account. There is no staff-admin lock, because staff rows aren't touched.

1. Find the reset by `token_sha256`, `FOR UPDATE`. It must be open and unexpired, its `user_id` must be the caller's, and `email` must still equal the caller's current verified `users.email`. Otherwise answer `invalid`, `expired` or `cancelled`. A changed address kills the link.
2. Lock the profile row `FOR UPDATE`. Re-check everything from §5.1 step 2, and the whole money guard (§5.3), **inside this transaction, after the lock**. On refusal: set `last_refusal`, commit only that, and answer the code. Nothing is cleared.
3. Run the shared erase (§6.1) and the payment-setup retire (§6.2).
4. Set `confirmed_at`. Expire the page's open quotes (§4.5). Queue the done email (§8.2).
5. `recordAudit`: `account_reset.completed`, permission `accounts.reset`, `staffUserId` = the requester (the person who started it), subject `profile`, reason "Confirmed by the account owner", details `{ resetId, retiredAccountIds, replacedDestinationIds }`.

After commit (as the delete route does):

- `removeObjects(photos, photoKeys)`;
- `revalidator.revalidate(handle)` (aliases redirect to the handle, so they need nothing);
- live signals to `{ user }`: `profile.changed`, `payments.changed`, `account.changed`, so the person's other tabs re-read. No `sessions.changed`, because sessions are kept;
- the partner-quote cache invalidation (§4.3).

**Race with an incoming tip.** An attempt that exists before the confirm's lock is non-final, so the confirm refuses it. An attempt that starts after the commit finds no current account (retired) and is refused or quoted `collect` by today's rules. The gap in between is closed only if the attempt-start path reads "the person's account now" in a transaction that conflicts with the reset's `FOR UPDATE` on the profile row. Inserting an intent or attempt takes `FOR KEY SHARE` on `profiles` through its foreign key, which does conflict. **The builder must check** that the account reference a new attempt charges is read after its row exists (or under such a lock), and must not cache it across transactions. If it isn't, add a `FOR SHARE` read of the profile in `claimAttemptStart`. A barrier test proves it (§10).

### 5.6 Second staff approval: no (my call)

The owner set a permission plus the person's email confirmation. A second staff approval would add delay but no protection against the real risks. Staff error or ill will is already stopped by the person's own confirmation. A person resetting their own page is what the tool is for. The permission is **sensitive**, so granting it already needs a second person (`staff.grant_sensitive`). This changes if the owner decides the reset should also clear the verified legal name (§4.4): then make it a serious action like `collect_name.change`.

### 5.7 While it is pending

- **Staff** see a "Reset" card on the page (ops Pages screen, `OPS_PAGE_LOOKUP_PERMISSIONS` gains `accounts.reset`): "Reset link sent to j•••@g•••.com by {staff} at {time}, expires {time}", plus the last refusal in words if any ("They still have money with us"), with **Cancel** (reason, audited `account_reset.cancelled`) and **Send a new link** (= start again).
- **The person** sees nothing new in the app; the email is the notice **(builder's call whether to add a dashboard banner)**.
- **Cancelled automatically** (system, audited with no staff member, as `endLinksOfStaffWithoutAccess` does): when the requester no longer holds `accounts.reset` (hook into the same staff-change triggers); when the account's email changes; when the account is deleted (`deleteAccount` cancels open resets with its other pending links); when the page is suspended.

## 6. Code shape

### 6.1 Shared erase (owner decided: shared code, not a copy)

Extract from `deleteAccount` into `packages/database/src/operations/page-erase.ts`:

- `refuseWhileMoneyIsTheirs(tx, profileId)`: the guard block. Deletion calls it with its rehearsal exception kept at the call site.
- `erasePageContent(tx, { profileId, now }): Promise<string[]>`: the content fields, supporters, campaigns / tip_campaigns / recaps, avatars, covers and renditions, and Studio. Returns the object keys. Deletion then still applies its own extras (the handle → `deleted:<id>`, holds, aliases, take-backs, `support_requests`, the user erase, sessions). Reset adds its own (tip amounts and thanks, the defaults in §3.2, `page_state`).

`deleteAccount`'s behaviour must not change: its existing integration tests pass unchanged.

### 6.2 New operations (`packages/database/src/operations/account-reset.ts`)

- `startAccountReset(db, { profileId, staffUserId, reason, sealing, now })`
- `previewAccountReset(db, { token, userId, now })`
- `confirmAccountReset(db, { token, userId, sealing, photos, now }) → { handle, photoKeys }`
- `declineAccountReset(db, { token, userId, now })`
- `cancelAccountReset(db, { resetId, staffUserId, reason, now })`
- `openAccountResetFor(db, profileId)` (for the ops card)
- `retirePaymentSetup(tx, { profileId, now }) → { retiredAccountIds, replacedDestinationIds }`: §4.2 to §4.5.

### 6.3 Permission (owner decided)

`'accounts.reset'` in `OPS_PERMISSIONS`: description "Reset a person's page and payment setup so they can start again, once they confirm by email", group `people`, `sensitive: true`. The `role_permissions_known` check is built from `OPS_PERMISSIONS`, so it needs a migration. No system role gets it by default **(my call)**; the owner grants it.

### 6.4 Migrations

1. `payment_accounts.retired_at` / `retired_reason`, and the unique constraint swapped for the partial index (§4.2).
2. `account_resets` (§5.2).
3. `role_permissions_known` with `accounts.reset`.
4. Optional: `profiles.reset_at` if the web needs it to show the "not set up yet" notice (§7.3) **(builder's call)**.

All additive, apart from the constraint swap, which is safe: the partial index admits every existing row because none is retired.

## 7. Screens

### 7.1 Ops

The page's ops view gets a **Reset page** card for holders of `accounts.reset`: what is cleared and kept (the short lists), a reason box, a fresh code, then the pending state (§5.7). Refusals show in words, never codes.

### 7.2 Confirm page

`apps/web/src/app/account/reset/page.tsx` (or under `/dashboard`; builder's call), mobile-first, following the design constitution. Its states: open (the lists plus two buttons), refused (why, and what to do: "Withdraw what's in your balance, then open this link again"), done ("Your page is ready to set up again" → setup), expired, cancelled, invalid (one neutral message for wrong account, used or unknown).

### 7.3 "Not set up yet" (owner decided)

- **Dashboard:** after a reset, the person's dashboard shows the setup steps from the start (name, photo, amounts, payment setup), as for a new account, headed "Your page isn't set up yet". The builder reads the dashboard's existing setup logic and makes a reset page read as new.
- **Public page:** today a `not_live` page answers like an unknown one ("We can't find @handle"). For a page that was reset and isn't live again yet, show a plain "@handle isn't set up yet" notice instead, with no name, photo or tip form, and `noindex` **(my call: the handle was public and printed QR codes lead here, so "can't find" would look as if the person had gone; it reveals nothing that wasn't public)**.

## 8. Emails (`packages/mail/src/templates/types/account-reset.ts`, registered in `registry.ts`)

Both are `category: 'security'`, `sender: 'security'`, `preference: null`. They go to the verified `users.email` only, through `mailOwner` with dedupe keys `account_reset_confirm.<resetId>` and `account_reset_done.<resetId>`. Plain words; the partner is "our payment partner"; nothing implies TipMe is licensed or approved.

### 8.1 `account_reset_confirm` (`waiting: true`)

Data: `{ token, handle }`. Subject "Confirm resetting your TipMe page". Body:

- "Our support team started a reset of your page @{handle}, as you asked. Nothing changes until you confirm."
- **This will clear:** your name, bio, photo and cover; your links; your page style and designs; your tip amounts and thank-you message; your campaigns, monthly recaps and the supporters who chose to be recognised; your bank details and your link to our payment partner. You'll set these up again from the start.
- **This keeps:** your sign-in, your email, your username @{handle}, your Pro, your business roles, and all your tips, withdrawals and statements.
- Alarm block: "**This can't be undone.** Once you confirm, what's listed above is gone for good."
- Button "Review and confirm". Quiet line: "The link works for 24 hours. If you didn't ask for this, ignore this email and reply to tell us."

### 8.2 `account_reset_done`

Data: `{ handle }`. Subject "Your TipMe page was reset". Body: "Your page @{handle} is ready to set up again. Until you do, it shows as not set up yet, and it can't receive tips." Button "Set up your page". Alarm: "Didn't do this? Reply to this email straight away."

## 9. Threat model

Update `docs/security/threat-model.md`:

- **P6 row:** add "A staff-started reset (permission `accounts.reset`, confirmed by the person through a one-time emailed link while signed in) erases the same page content as deletion, through the same code, and keeps money records, the account and the handle." Add the new test files to its evidence column.
- **New row (people / account integrity), "A staff member wipes or redirects someone's page":** mitigations: a sensitive permission, a fresh code, the person's confirm (inbox plus signed-in session, single use, 24 h, sha256 only, link in the fragment), money guard re-checked under lock, the verified legal name kept locked, the partner account retired rather than reused, every step audited. Residual: someone holding both the person's inbox and their session can confirm; a dispute on an old tip after a reset is recovered from future tips as today; the old partner account stays open at the partner (unused, manual payouts).

## 10. Tests the builder must write

Integration (`packages/database/test/integration/account-reset.test.mjs`, `tests/integration/account-reset-api.test.mjs`):

- **Cleared:** after confirm, every cleared column is at its reset value, and `profile_avatars`, `profile_covers`, `profile_cover_renditions`, Studio tables, `campaigns`, `tip_campaigns`, `monthly_recaps`, `supporters`, `tip_supporters` have no rows for the page; their bucket objects are removed.
- **Kept:** a snapshot of `users`, `sessions`, `staff`, business rows, `pro_periods`, `pro_purchases`, `pro_auto_renew`, `tips`, `tip_messages`, `payouts`, ledger, `tip_refunds`, `disputes`, `collect_transfers`, `share_transfers`, `notifications`, `support_requests`, `handle_aliases`, `handle_holds`, analytics, and the kept profile columns is byte-identical before and after.
- **Payment setup:** old `payment_accounts` rows retired (not deleted, reference unchanged); destinations `replaced_at` set; `collection_mode` null; a following `beginPaymentAccountCreation` inserts a **new** row with a new id, so the idempotency key differs; `nextCollectionMode` sees no account; a retired reference can't be bound to another profile; an account webhook for the retired reference is ignored and writes nothing; a charge or dispute event for an old tip is still matched; `ownerProviderSet` and `bankAccountAt` exclude the retired account; legal name and `collect_verified_at` kept, `collect_name_recheck_at` set, transfers held until the recheck clears.
- **Money guard:** each condition in §5.3 refuses both start and confirm with its code, and a refused confirm changes nothing but `last_refusal`.
- **Race:** money arrives between start and confirm → confirm refuses. A barrier test runs an attempt start and a confirm concurrently: either the confirm refuses, or the attempt finds no account. A tip never lands on a retired account.
- **Link:** reuse after confirm → `invalid`; expired → `expired`; after a new link → old `cancelled`; a different signed-in account → `invalid`; email changed since → `invalid`; decline cancels; the token never appears in audit rows, logs or mail rows unsealed.
- **Permission:** no `accounts.reset` → 403; without a fresh code → refused; resetting yourself refused; the requester losing the permission cancels the open reset; suspended, rehearsal, deleted and unverified-email pages refused; open recovery refused.
- **Audit:** requested, cancelled, declined, completed rows with the right permission, subject and staff member.
- **Deletion unchanged:** the existing `deleteAccount` tests pass without edits.

E2E (`tests/e2e/account-reset.spec.ts`): staff start a reset from the ops Pages screen and see the pending card; the person opens the emailed link (pretend mailbox), sees the lists, confirms, lands on setup, and the public page shows "isn't set up yet"; decline and expired paths; phone and desktop.

## 11. Out of scope

- Self-serve reset (owner: staff tool).
- Any partner call to close the old account.
- Resetting a business, or a business's payment setup.
- A free rename as part of the reset (⚑ §3.2).
