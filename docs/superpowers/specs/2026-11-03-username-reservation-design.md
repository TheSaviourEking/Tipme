# Staff reserve usernames from the admin area

Status: design only, 3 November 2026. Not built. The owner's decisions of 3 November 2026 are quoted in section 1; everything else marked "builder's call" is for the owner to check. Nothing here approves anything in `docs/00-DECISIONS.md`.

Related: `docs/superpowers/specs/2026-11-01-admin-roles-design.md` (permissions, serious actions, second-person approval), `docs/superpowers/specs/2026-11-01-profile-covers-qr-design.md` (the handle rule), `docs/superpowers/specs/2026-10-30-mail-platform-design.md` (mail queue), the terms' "Your username" section (PR #108, commit `c928b24`, **not yet on `dev`**; see section 13).

"Username" in this document is what the code calls a handle (`/@handle`).

## 1. Intent

The owner, 3 November 2026: "In the admin screen, the admin should be able to reserve some usernames in the system. Remember not all roles can do this."

The owner's answers:

1. Staff may reserve an unclaimed username. They may also take a username from an existing user, who is then moved to another username.
2. Staff with the permission can release a reservation, with an audit entry. The built-in reserved names (`RESERVED_HANDLES`) can never be released from the admin area.
3. Reserving an unclaimed name and releasing a reservation are instant for anyone holding the permission, with a reason and an audit entry. Taking a name from an existing user is a serious action: it needs a second staff member's approval, and the notice period starts only after approval.
4. The terms promise: at least 7 days' notice by email, saying why and asking the person to choose a new username; their page, tips and balance stay theirs; links and QR codes with the old username stop working; if they have not chosen, TipMe gives the page a new username and emails it; TipMe may act sooner, or without notice, for impersonation, a trademark infringement, or where the law requires it.
5. Not every role can do this.

**Goals**

1. Staff holding the permission can reserve and release usernames from `/ops`, instantly, with a reason, audited.
2. A reserved username cannot be claimed at sign-up or taken by a handle change, enforced in the database as well as the application.
3. Staff can take a username from a page through the serious-action flow, and the system then keeps the terms' promise on its own: notice, reminder, deadline, automatic new username, emails. Nothing depends on a person remembering.
4. The without-notice path for impersonation, trademark and legal cases.

**Non-goals**

- Billing, or selling a username.
- Handing a reserved name to a specific person. A reservation only blocks the name. Giving it to someone later is a release followed by their claim, or a future feature.
- Changing the built-in list from the admin area. It stays in code.
- Bulk import of reservations.

**Anti-goals** (failures even if the feature "works")

- A user's tips, balance, withdrawals, payment account or Pro plan are affected in any way. Money is keyed by page id, never by username, and this feature only changes the username.
- A page is broken silently: a user loses a username without the notice the terms promise (except the stated sooner path), or ends up with no working username at all.
- One staff member takes a name from a user alone while a second qualified person exists.
- The user learns which staff member asked, or reads the staff's internal reason.
- A rolled-back release hands out a reserved name.

## 2. What exists today (verified in the code)

**Handle rules.** `packages/domain/src/handles.ts`: the format is `^[a-z0-9_]{3,30}$` (line 7); `RESERVED_HANDLES` (lines 9-81) is the built-in list; `normaliseHandle` (85-88) trims and lower-cases and returns null for anything invalid, so a `-` is never part of a handle; `isReservedHandle` (90-92) lower-cases and maps `-` to `_` before looking in the list. The list is also the router's guard: `apps/web/src/lib/handle-redirect.ts:29-30` refuses a reserved word as a short link, and `apps/web/test/short-links.test.mjs` fails if a top-level route or public folder is not on the list.

**Where the rules are checked.** All in `packages/database/src/operations/profiles.ts`:

- `checkHandle` (89-100) answers the sign-up availability check (`HandleStatus` is `available | taken | reserved | invalid`, `packages/contracts/src/profiles.ts:70`), called from `apps/api/src/profiles/public-profile.controller.ts:100`.
- `isTaken` (102-125) looks at current handles, old handles (`handle_aliases`) and 90-day deletion holds (`handle_holds`).
- `claimHandle` (127-176) refuses reserved and taken names (143).
- `renameHandle` (499-560) refuses a Free page (528, `HANDLE_CHANGE_PRO_REQUIRED`), the limit, reserved names (531) and taken names; it turns the old handle into an alias (544) and counts the change (`PRO_HANDLE_CHANGES = 3`, line 67, plus `handle_changes_extra`). The route is `PUT /v1/me/handle` (`apps/api/src/profiles/me-profile.controller.ts:116-131`), which refreshes both cached pages.
- Database trigger `0028_handle_alias_guard.sql`: under a per-handle advisory lock (`hashtext('tipme.handle:' || handle_lower)`), a profile can't take another page's old handle and an alias can't take another page's current handle. It exists so a release that predates a rule can't hand a name out after a rollback.

**Old handles.** `handleAliasTarget` (617-638) makes an old handle answer `{ movedTo }` with a 308 (`public-profile.controller.ts:69-72`), and the web follows it with `movedProfilePath` (`apps/web/src/lib/handle-redirect.ts:5-10`, `apps/web/src/app/people/[handle]/page.tsx:59-60`). Admin lookup and search find a page by an old handle: `opsPageByHandle` (257-288) and `packages/database/src/operations/ops-search.ts:103-107`. Deleting a page (`deleteAccount`, 709 onwards) refuses while there is a balance (780, `HAS_BALANCE`), and holds the current and old handles for 90 days (819-845, `HANDLE_HOLD_MS`, line 65).

**Money is keyed by page id.** `tip_quotes.profile_id` (`packages/database/src/schema.ts:818-820`); a tip intent is created from a `quoteId`, not a handle (`packages/contracts/src/checkout.ts:42`); the provider returns the supporter to `/tip/{tipId}` (`apps/api/src/checkout/mock-checkout.controller.ts:119`). One exception reads the current handle: `LIVE_CHECKOUT_HANDLES` gates live checkout by handle (`apps/api/src/checkout/checkout.service.ts:121-131`).

**Permissions.** `packages/contracts/src/ops-catalogue.ts`: `OPS_PERMISSIONS` (6-26), groups (29-35), `OPS_CATALOGUE` with description, group and `sensitive` (45-144), `SERIOUS_ACTIONS`, their words and the permission each needs (262-303). The database holds the same list in two check constraints, `role_permissions_known` (`0064_ops_catalogue_permissions.sql`) and `staff_permission_overrides_known` (`0065_custom_roles_personal_access.sql:8`). The built-in Owner role gets every catalogue permission through `ensureOwnerRole` (`packages/database/src/operations/staff.ts:55-66`), and a migration gives an existing owner a new one (precedent: the end of `0064`). The menu shows a link only to staff holding what the page reads (`apps/web/src/lib/ops-menu.ts`); the server checks every route through `@OpsPermission` and `OpsGuard`, and sensitive routes ask for a fresh code (`@FreshCode`, with the pinned exemptions in `OPS_FRESH_CODE_EXEMPT`).

**Serious actions and approval.** `packages/database/src/operations/serious-actions.ts`: an action registers `validate`, `describe`, `run` and optionally `subjects`, `target`, `current` (109-175), and its permission must be sensitive (199-205). `requestSeriousAction` (398-600) stores a pending `approval_requests` row (`0067_serious_actions.sql`) and alerts qualified approvers when one exists (499-534); with **nobody else qualified it runs at once, alone, with an audit entry and an alert** (539-590; the owner's rule in the admin-roles spec, section 6.5). Requests expire after 24 hours (53), swept every minute by the worker (`apps/worker/src/job-worker.ts:274-279`, 449-455). `current` pins the facts at request time and a change makes approval stale. `subjects` keeps the person concerned from deciding (example `fee.change`, `serious-actions-registered.ts:452-475`). A route asks through `requestSeriousAction` and answers "pending" or the result (`apps/api/src/ops/pages.controller.ts:242-275`). The approvals screen is `apps/web/src/app/ops/approvals/page.tsx`.

**Audit.** `recordAudit` (`packages/database/src/operations/audit.ts:23-41`) writes one append-only `audit_events` row: staff id (null when the system acted), action, permission, subject type and id, reason, trace id, time. Structured detail goes inside the reason through `withAuditChange` (`staff.ts:405-406`).

**Worker.** Repeatable BullMQ jobs are registered with `ensureSchedule` (`apps/worker/src/ensure-schedule.ts`) and dispatched by name in `job-worker.ts`. Outbox rows become jobs through `outbox-relay-loop.ts`. Mail is queued in Postgres in the caller's transaction (`enqueueMail`, `packages/database/src/operations/mail-queue.ts:39-80`, deduplicated by `dedupeKey`) and sent by `apps/worker/src/mail-delivery-loop.ts`, which also runs timed housekeeping such as `completeDueRecoveries` (`email-recovery.ts:503`), the nearest precedent for "do this when a deadline passes". `mail_messages.sent_at` records when the provider accepted a message (`schema.ts:311`).

**Emails.** A type is defined with `defineMailType` in `packages/mail/src/templates/types/*.ts` (example `pagePaused`, `account-events.ts:125-147`) and listed in `packages/mail/src/templates/registry.ts`. `mailOwner` (`packages/database/src/operations/account-mail.ts:24-65`) queues to the account's verified address and **sends nothing when there is none**.

**Caching.** A public page is cached for up to 5 minutes and refreshed on demand by the API's `ProfileRevalidator` (`apps/web/src/lib/profiles-api.ts:26`, `apps/api/src/profiles/revalidate.ts`). The worker has no revalidator today.

## 3. Data model

All migrations are additive (section 11).

### 3.1 The name's canonical key

A new domain function, `reservationKey(raw)`, in `packages/domain/src/handles.ts`: trim, lower-case, replace `-` with `_`, then `normaliseHandle`. It returns null when the result can't be a handle. Every reservation and take-back is stored and compared by this key, so `MTN`, `mtn` and `Mtn` are one name, and `how-it-works` is `how_it_works`, exactly as `isReservedHandle` already treats the built-in list. Two names that differ only by case or `-`/`_` therefore cannot both be reserved; the second attempt is told the name is already reserved and shown the existing row.

### 3.2 `handle_reservations` (staff reservations)

Separate from the built-in list, which stays in code because the router and the route test depend on it.

| Column | Meaning |
|---|---|
| `id` uuid PK | |
| `handle_lower` text not null | the canonical key |
| `source` text not null | `staff` (reserved directly) or `take_back` (the end of a take-back) |
| `take_back_id` uuid null | the take-back it came from, when `source = take_back` |
| `reason` text not null | staff's written reason, checked like other reasons (`checkedReason`) |
| `reserved_by` uuid null, FK users | null only when the system completed a take-back; then `take_back_id` names who asked and who approved |
| `reserved_at` timestamptz not null | |
| `released_at`, `released_by`, `release_reason` | null while active |

A partial unique index on `handle_lower WHERE released_at IS NULL` means one active reservation per name; released rows stay as history, so "who reserved it, when and why" is answerable for past reservations too (the audit log has the same, and is the record of truth).

### 3.3 `handle_take_backs`

| Column | Meaning |
|---|---|
| `id` uuid PK | |
| `approval_request_id` uuid null, FK approval_requests | null when it ran alone |
| `profile_id` uuid not null, FK profiles | the page losing the name |
| `handle_lower` text not null | the name being taken |
| `kind` text | `current` (the page's username) or `old` (one of its old usernames that still redirects) |
| `category` text | `ordinary`, `impersonation`, `trademark`, `legal` |
| `notice_days` int | 7 to 30 for `ordinary`; 0 to 7 for the others; 0 means at once |
| `reason` text | staff's internal reason, never shown to the user |
| `message_to_user` text null, at most 300 characters | what the email says about why, written by the requester and shown verbatim to the approver (open question 3) |
| `state` text | see below |
| `requested_by`, `approved_by` uuid | `approved_by` null when it ran alone |
| `approved_at`, `noticed_at`, `due_at`, `reminded_at`, `done_at`, `cancelled_at` | |
| `notice_mail_id` uuid null, FK mail_messages | the notice email, to read its `sent_at` |
| `outcome` text null | `user_chose`, `assigned`, `page_deleted`, `old_removed` |
| `new_handle` text null | the username the page ended with |
| `cancelled_by` uuid null, `cancel_reason` text null | |
| `free_change_until` timestamptz null, `free_change_used_at` null | see 5.7 |

A partial unique index on `handle_lower WHERE state IN ('approved','noticed','due')`: one open take-back per name.

**States.**

- **requested**: lives in `approval_requests` (pending), not in this table. Rejected, expired, stale and cancelled requests end there and never create a row, so there is nothing to keep in step.
- **approved**: the row is created by the serious action's `run`, in the approving transaction, with the notice email queued in the same transaction. The deadline is not set yet.
- **noticed**: the worker saw the notice email accepted by the provider (`sent_at`). `noticed_at = sent_at`; `due_at` is the end of the Lagos day `notice_days` days later (23:59:59 Africa/Lagos), so there are always at least 7 full days and the email can say "by the end of 10 November". The terms say "emails you at least 7 days before", so the clock starts from sending, not from approval.
- **due**: the worker found `due_at <= now` and has claimed it; it is about to complete it. A row stays here only if completing failed, which raises an issue (5.8).
- **done**: the name has left the page and is now an active reservation (`source = take_back`).
- **cancelled**: by staff before done, or by the system when the facts disappear (the page lost the name some other way before approval took effect).

`notice_days = 0` goes from approved to done in the approving transaction (5.10).

### 3.4 How a reserved name blocks sign-up and handle changes

The domain package stays free of the database: `isReservedHandle` keeps meaning "on the built-in list" and keeps guarding routes. The database package adds the staff list on top:

- `isTaken` (profiles.ts:102) gains a fourth lookup: an active `handle_reservations` row for the key. `claimHandle` and `renameHandle` therefore refuse a reserved name with the existing `HANDLE_TAKEN`.
- `checkHandle` (profiles.ts:89) returns `reserved` for a staff reservation as it does for a built-in word. The public never learns which list a name is on, or that it was taken back from someone.
- The short-link router is unchanged. `/mtn` still redirects to `/@mtn`, which is not found, exactly like an unknown name. Only built-in words need to be kept out of the router, because only they are real pages.
- **Database guard** (new trigger, the same pattern as 0028 and taking the same per-handle advisory lock): a profile insert or a change of `handle_lower`, and an alias insert, are refused with `unique_violation` when an active reservation holds the name. Inserting a reservation is refused while a profile or an alias holds the name, except for the row the take-back completion writes, which happens in the same transaction that moves the page off the name (the trigger checks after the page has moved, so no exception flag is needed if the completion updates the profile first). This closes the race between a staff reservation and a claim at the same moment, and keeps an older release from handing a reserved name out after a rollback.
- A name in a 90-day deletion hold can be reserved; the reservation simply outlasts the hold.

## 4. Permission

- **One new permission, `usernames.manage`**, group `people`, **sensitive**. Description: "Reserve and release usernames, and ask to take one back from a page".
  - Sensitive because taking a name from a person changes their account, and because the catalogue requires a serious action's permission to be sensitive (`serious-actions.ts:199-202`). It also means every route asks for a fresh code (5 minutes per session; signing in counts), and granting it to someone is itself the serious `staff.grant_sensitive`.
- **Take-back is a serious action of the same permission**, `username.take_back`, words "Take a username back from a page", added to `SERIOUS_ACTIONS`, `SERIOUS_ACTION_WORDS` and `SERIOUS_ACTION_PERMISSIONS`. A separate permission is not needed: the owner's rule is that the same holders reserve, release and request, and the second approver is any other holder.
- **Who has it.** The built-in `owner` role gets it automatically (`ensureOwnerRole` reads the catalogue) and the migration inserts it for the existing owner. `release_check` does not get it. Custom roles and per-person additions get it only when someone with `staff.manage` ticks it.
- **The UI hides it**: the menu gains "Usernames" (`/ops/usernames`) with `needs: ['usernames.manage']`; the Pages card for a page shows its take-back state and the "Take back this username" button only when `can(access, 'usernames.manage')`.
- **The API enforces it regardless**: every route below carries `@OpsPermission('usernames.manage')` and `@FreshCode()`; no route is added to `OPS_FRESH_CODE_EXEMPT` or `OPS_ANY_STAFF_ROUTES`. The existing route tests fail if a route names a permission missing from the catalogue. `requestSeriousAction` re-checks the permission under the staff-admin lock, and approval re-checks both people.

**Routes** (new `OpsUsernamesController`, rate limit `ops_request`):

| Route | Does |
|---|---|
| `GET /v1/ops/usernames?q=&state=` | The list (section 7) |
| `GET /v1/ops/usernames/check/:name` | What the name is now: free, built-in, reserved (by whom, when, why), a page's username or old username (page id, handle, display name, plan, live state: the public-level fields `OpsPage` already returns), in a deletion hold until a date, or with an open take-back |
| `POST /v1/ops/usernames` `{ name, reason }` | Reserve, instant |
| `POST /v1/ops/usernames/:name/release` `{ reason }` | Release, instant |
| `POST /v1/ops/usernames/:name/take-back` `{ profileId, category, noticeDays, reason, messageToUser }` | Asks through `requestSeriousAction('username.take_back')`; answers pending or, alone, the started take-back |
| `POST /v1/ops/usernames/take-backs/:id/cancel` `{ reason }` | Cancel, instant |

Approve and reject use the existing approvals routes.

## 5. Flows

Every staff action needs `usernames.manage`, a fresh code and a written reason; every one is audited (section 9).

### 5.1 Reserve an unclaimed name

1. Staff open Usernames, type a name and press Check. The server computes the key and says what it is.
2. If it is free (or only in a deletion hold), the form offers Reserve with a reason. The server, under the per-handle lock, refuses if it is built-in ("TipMe's own list already reserves this"), already reserved (shows that row), or held by a page as its username or old username ("This is @kemi's username. To take it, ask to take it back."). Otherwise it inserts the row and audits `username.reserved`.
3. The staff member sees "Reserved". Nobody else is told. From now on sign-up says the name is not available, and a handle change refuses it.

### 5.2 Release a reservation

1. On a reserved row, Release asks for a reason. Built-in names have no Release button, and the API refuses them (they are never rows anyway).
2. The server sets `released_*` and audits `username.released`. The name is free at once, subject to any deletion hold still running.
3. A reservation that came from a take-back can be released the same way; the audit entry names the take-back. The old owner is not told and does not get the name back automatically. A person has one page, so they can only have it back by changing to it (see 5.9, step 3); otherwise it goes to whoever claims it first.

### 5.3 Request a take-back

1. From the Usernames check result for a name a page holds, or from that page's card on Pages, staff press "Take back this username".
2. The form asks for: the category (Ordinary, Impersonation, Trademark, Required by law); the notice (Ordinary: 7 days, may be raised up to 30; the others: 7 days by default, or fewer, down to "No notice"); the internal reason; and the message to the user (what the email says about why; the form shows the email as it will read). It also shows, from the server: the page's plan, live state, whether its balance is non-zero, whether a withdrawal is in flight, whether it has a verified email address, and whether its handle is listed in `LIVE_CHECKOUT_HANDLES` (it would lose live checkout under a new name until the variable is updated; staff are told to update it).
3. Submitting calls `requestSeriousAction`. The action:
   - `validate`: the key is valid and not built-in; the page exists and is not deleted; it holds the name as its username (`kind = current`) or an old username (`kind = old`); no open take-back for the name; the category and notice days fit; the message is present for ordinary take-backs and within 300 characters.
   - `subjects`: the page's owner (the existing `pageOwner`), so staff can't decide a take-back of their own page.
   - `target`: `{profileId}:{name}`.
   - `current`: `{ profileId, kind }`, so if the page renamed or lost the name while the request waited, approval is stale and the requester asks again.
   - `describe`: for example "Take @kemi back from its page: ordinary, 7 days' notice". The summary names the page by handle only.
4. With another qualified person, the request waits (24 hours, then it expires). The requester sees "Waiting for approval" on the Usernames row and on the page's card; qualified approvers are alerted as for any serious action.
5. With nobody else qualified, the existing rule runs it at once, alone, with the "ran alone" audit entry and alert (open question 1).

The user sees nothing at this stage.

### 5.4 Approve or reject

1. A different staff member holding `usernames.manage` opens Approvals, reads the summary, the category, notice days and the message the user will receive, and approves with a fresh code, or rejects with a reason.
2. **Reject**: nothing changes; the requester sees "Rejected" with the reason, as for every serious action.
3. **Approve**: `run`, in the approving transaction under the staff-admin lock, inserts the take-back row in `approved`, queues the notice email with dedupe key `username_take_back_notice.{id}` through `mailOwner`, and audits `username.take_back_started` (requester, approver, category, notice days, kind). For `notice_days = 0` it completes at once instead (5.10).
4. The approver sees "Approved. The notice email is on its way." The requester's row moves to "Notice being sent".

### 5.5 The notice period

1. The worker's take-back sweep (section 5.8) sees the notice email's `sent_at`, moves the row to `noticed`, sets `noticed_at` and `due_at`, and audits `username.take_back_noticed` (system).
2. **The user sees** the email (section 6.1), and on their dashboard a banner that stays until the end: "TipMe needs your username @kemi back. Choose a new one by the end of 10 November." with a "Choose a new username" button. `MyProfile` gains an optional `usernameTakeBack: { handle, kind, dueAt, why }`, where `why` is the category sentence plus the message.
3. For `kind = old`, the banner reads "Links that use your old username @kemi will stop working after 10 November. Your username @kemi_ng stays." and there is nothing to choose.
4. **Reminder**: 2 days before `due_at` (when `notice_days >= 4`), if not done, the sweep queues the reminder email (dedupe `username_take_back_reminder.{id}`) and sets `reminded_at`.
5. **Staff see** the row as "Notice sent, due 10 November", with a countdown, and Cancel.

### 5.6 The user chooses a new name during the notice

1. The banner opens the existing username form in Settings, in a take-back mode:
   - it works on **Free and Pro** alike (the Free rule at profiles.ts:528 is waived for this);
   - it **does not count** against the Pro allowance and needs none left (the owner asked for a move, not a change the user chose to spend);
   - the confirmation says plainly that links and QR codes with @kemi will stop working now, not that they keep working (the usual confirmation's promise does not hold here).
2. The server, in one transaction (profile row locked first, then the take-back row, the same order as the sweep): checks the take-back is still `noticed` (or `approved`), applies the usual availability rules to the new name, sets the new handle **without** making the old one an alias, writes the active reservation for the old name (`source = take_back`), marks the take-back `done` with outcome `user_chose`, queues the done email, and audits `username.take_back_done`.
3. The take-back therefore **completes early**, on the user's choice. Both cached pages are refreshed by the route, as a rename does today.
4. A user changing their username through the ordinary form during the notice (a Pro page with changes left) is routed through the same path: the same transaction, no alias for the taken name, and it does not count. There is one way for the name to leave the page.

### 5.7 The automatic change at the deadline

1. The sweep finds `noticed` rows with `due_at <= now`, sets `due` and completes each in its own transaction (profile locked first):
   - `kind = current`: gives the page a new username (`page_` plus 6 random lower-case letters and digits, retried on collision, never built-in or reserved; builder's call, open question 5), without an alias for the old one;
   - `kind = old`: deletes the alias, so the old username stops redirecting;
   - writes the active reservation for the taken name; marks `done` with `assigned` or `old_removed`; queues the done email; audits `username.take_back_done` (system).
2. After commit the worker refreshes both cached pages (it gains the revalidation call the API has; until then the old page can show for up to 5 minutes, which is acceptable but not the intent).
3. **Free choice afterwards** (builder's call, open question 4): after an assigned username, the user may change it once within 30 days, on Free or Pro, not counted (`free_change_until`, `free_change_used_at`). Without this, a Free page would be stuck with `page_x7k2q9` for good.

### 5.8 The worker

- A new repeatable job, `usernames.take-backs`, every 60 seconds, registered with `ensureSchedule` and dispatched in `job-worker.ts` beside `approvals.expire`. Each run, in this order, with `FOR UPDATE SKIP LOCKED` and batches of 100: `approved` rows whose notice email has `sent_at` become `noticed`; reminders that are due are queued; `noticed` rows past `due_at` are completed. It is idempotent: every step re-reads the state under the row lock, and every email has a dedupe key, so a duplicate or late job changes nothing.
- **The sweep is driven by the database, not by a delayed job**, so a worker that was down at the deadline completes the take-back on its next run; the user keeps the name until then, and the done email and audit record the actual time.
- Issue detectors (the existing `runIssueDetectors` in the reconcile job) open two new issue kinds for staff: `username_take_back_unnoticed` when a row has been `approved` for 24 hours without its email being sent (bounced, failed, or no verified address), and `username_take_back_overdue` when a row is still not done an hour after `due_at`. Both resolve themselves when the cause clears.
- An outbox event `username.take_back_done` posts to the staff alert route, as `ops.approval_ran` does.

### 5.9 Cancel before the deadline

1. Any holder of `usernames.manage` can cancel an `approved`, `noticed` or `due` take-back with a reason, instantly. Cancelling only protects the user, so it needs no second person (builder's call).
2. The row becomes `cancelled`; the audit entry is `username.take_back_cancelled`. If the notice had been sent, the user gets the cancelled email and the banner goes. Nothing else changes.
3. A take-back already `done` cannot be cancelled. To give the name back, staff release the reservation (5.2) and the user changes to it, with a free change granted through the existing `pages.plan` route if needed.

### 5.10 Sooner, or without notice

- For Impersonation, Trademark and Required by law, the requester may choose fewer than 7 days, down to none.
- **It still needs a second approver.** This is the most destructive version: there is no notice in which a mistake could surface and be cancelled, the user's printed codes break at once, and an impersonation claim is often itself contested. The approval flow is quick (the request reaches every qualified person at once), the lone-admin rule still lets a single admin act, and a page that is causing harm right now can be paused immediately with the existing `pages.suspend` while the approval waits, which stops tips without touching the name.
- With notice of 1 to 6 days the flow is 5.5 to 5.7 with a shorter clock (and no reminder below 4 days).
- With no notice, `run` completes it in the approving transaction exactly as 5.7, and the done email (6.4) says why and that it happened without notice.

## 6. Emails

All new types are `category: 'account'`, `sender: 'notifications'`, `preference: null` (they can't be turned off, like `page_paused`), each with a schema and a sample in `packages/mail/src/templates/types/username-take-back.ts`, listed in the registry. Sentence case, plain words, no em dashes, dates in Lagos time written out ("10 November 2026"). Money is not mentioned beyond saying the balance is unchanged; if a provider ever has to be mentioned, it is "our payment partner". Sent through `mailOwner` to the verified address.

The category sentence used below (`{why}`):

- ordinary: the requester's message;
- impersonation: "The username impersonates someone.";
- trademark: "The username infringes a trademark.";
- legal: "The law requires us to change it.";

followed, for the last three, by the requester's message if one was given.

**6.1 Notice** (`username_take_back_notice`), queued at approval.
Subject: "We need your TipMe username back"
"TipMe needs the username @{old} back. {why}
Please choose a new username by the end of {due date}. You can do it in Settings, and it won't use up any of your username changes.
Your page, your tips and your balance stay yours under the new username. Links and QR codes that use @{old} will stop working, so update them once you have chosen.
If you haven't chosen by then, we will give your page a new username and email it to you.
Reply to this email if you have a question."
For an old username: subject "A link to your TipMe page will stop working"; body "Your page keeps its username @{current}. Links and QR codes that still use your old username @{old} will stop working after {due date}. {why} Share your current link and print a new QR code if you need one."

**6.2 Reminder** (`username_take_back_reminder`), 2 days before the deadline, only if not done and `notice_days >= 4`.
Subject: "2 days left to choose a new TipMe username"
"This is a reminder that TipMe needs the username @{old} back. Please choose a new username in Settings by the end of {due date}. If you don't, we will give your page one and email it to you. Your page, tips and balance stay yours."

**6.3 Done after notice** (`username_take_back_done`).
Assigned: subject "Your TipMe page has a new username"; "As we said on {notice date}, TipMe has taken back @{old}. Your page is now at {origin}/@{new}. Your tips and balance haven't changed. Links and QR codes with @{old} no longer work, so share your new link and print a new QR code. You can change your new username once, for free, in Settings until {free change date}."
User chose: subject "Your new TipMe username is ready"; "Your page is now at {origin}/@{new}. The username @{old} is no longer yours, and links with it no longer work."
Old username: subject "An old link to your TipMe page has stopped working"; "Links and QR codes with @{old} no longer lead to your page. Your page is still at {origin}/@{current}."

**6.4 Done without notice** (same type, a `withoutNotice` flag).
Subject: "We changed your TipMe username"
"We have changed your page's username from @{old} to @{new}, without notice, as our terms allow in this case. {why} Your page, your tips and your balance are unchanged. Links and QR codes with @{old} no longer work. You can change your new username once, for free, in Settings until {free change date}. Reply to this email if you think this is a mistake."

**6.5 Cancelled** (`username_take_back_cancelled`), only if the notice was sent.
Subject: "You can keep your TipMe username"
"We no longer need the username @{old}. It stays yours, and your links and QR codes keep working. You don't need to do anything."

## 7. Admin screens

A new page, **`/ops/usernames`**, labelled "Usernames" in the menu after Pages. It is its own page rather than a card on Pages because most reservations concern no page at all. It uses the existing ops patterns: `Card className="settings-section"` sections, `ReasonAction` for every action that takes a reason, `opsAct` (which asks for a fresh code when needed and shows "Waiting for approval" or "Done alone" answers), `refusalWords` for refusals, `when`/`age` for times, and the same table layout as Approvals.

- **Check a name**: one field and a Check button; the answer as in the `check` route, with the one action that fits: Reserve, Release, Take back, or none (built-in).
- **Reserved** list: name, reserved by (masked staff email, as on the Overview), when, reason, source (staff or take-back), and Release. Search by name prefix; filter staff/take-back. The built-in list is shown under it, read-only, folded by default.
- **Take-backs** list: name, page (handle, plan), category, state in words (Waiting for approval, Notice being sent, Notice sent, due {date}, Being completed, Done, Cancelled), requested and approved by, due date, and Cancel while open. Pending ones link to Approvals.
- **Pages** (`/ops/pages`): the page's card shows, to holders of `usernames.manage` only, an open take-back on any of its names and the "Take back this username" button, which opens the same form.
- **Approvals**: unchanged; the request shows its summary, and the take-back's category, notice days and the message to the user, through `describe` and the request's stored payload words.
- **Search** (`/ops/search`, `search.view`): searching a name that was taken back finds the page it was taken from, labelled "username taken back on {date}", so support can explain why an old link no longer works. Only page-level fields, as today.

## 8. Edge cases

- **Pending tips or a withdrawal in flight.** Nothing waits or changes: quotes, intents, tips, payouts and the payment account are keyed by page id, the supporter returns to `/tip/{tipId}`, and a quote made under the old name still pays the same page. The request form shows the balance and any withdrawal in flight for information only. The one handle-keyed rule is `LIVE_CHECKOUT_HANDLES`; the form warns and the runbook says to update it.
- **A Pro page.** The take-back does not use up or need a change; the allowance and the plan are unchanged; its Pro QR codes printed with the old name stop working, as the terms say. Leaving or joining Pro during the notice changes nothing.
- **The name is someone's old username that still redirects.** It is a take-back (`kind = old`), serious, with notice: the page keeps its current username, and at the deadline the alias is removed, so the old link stops redirecting. Without that, an old username could never be reserved, because aliases are "unclaimable while the page exists" today.
- **Differs only by case or `-`/`_`.** One key (3.1): the second reservation is refused and shown the first; a take-back of `Kemi_NG` targets `kemi_ng`.
- **Two staff at once.** Two reservations of one name: the partial unique index and the per-handle lock let one win; the other is told it is already reserved. Two take-back requests: the approval flow returns the waiting one as a repeat; at `run` the open-take-back index refuses a second. Reserve against a user's claim at the same moment: the advisory lock and trigger serialise them; whichever commits first wins. Cancel against the deadline sweep, or against the user choosing: all lock the profile row, then the take-back row; the second one sees the new state and stops.
- **The target user deletes their page during the notice.** Deletion already needs a zero balance. In the deletion transaction, an open take-back on the page completes as `page_deleted`: its name goes to the reservation instead of the 90-day hold (the hold row may also be written; the reservation outlasts it), no done email is sent, and it is audited.
- **The user changes their own name during the notice.** The take-back completes early (5.6). If they had changed it before approval, the request goes stale and the requester asks again, now for the old username if it is still an alias.
- **The worker is down at the deadline.** The user keeps the name until the next sweep; the sweep catches up; after an hour the overdue issue opens (5.8). An email that can't be sent leaves the row in `approved`, so the 7 days never start without a sent notice, and the unnoticed issue opens after 24 hours.
- **No verified email address.** `mailOwner` sends nothing, so the notice can't be emailed. The request form shows this before anyone approves. Until the owner decides (open question 2), the row stays `approved` and the unnoticed issue opens; staff cancel or decide by hand.
- **The page is suspended or not live.** The take-back still works; a suspended page's owner still signs in and sees the banner. The page stays suspended under its new name.
- **The page is a release-check page.** Refused in `validate`; release checks never use real names.
- **A reserved name is reserved again after release.** A new row; the history keeps both.

## 9. Audit and visibility

**Audited** (`recordAudit`, permission `usernames.manage`, `subjectType: 'username'`, `subjectId` the key, detail through `withAuditChange`):

- `username.reserved`, `username.released` (staff, reason);
- the take-back request, approval, rejection, expiry and running alone, through the existing `serious_action.*` entries;
- `username.take_back_started` (in `run`: requester, approver, category, notice days, kind, profile id);
- `username.take_back_noticed`, `username.take_back_done` (system: outcome, new username), `username.take_back_cancelled` (staff, or system with the cause);
- `username.free_change_used` (the user, subject the profile).

Add `username.take_back_started`, `username.take_back_done` and `username.released` to the Overview's staff activity list (`audit.ts:44-61`).

**Never shown:**

- To the user: who asked or approved, the internal reason, the approval request, other staff.
- To the public: whether a name is reserved by staff or built-in, and that a name was taken from someone. A reserved name answers like an unknown one on `/@name` and `reserved` in the availability check.
- To staff without `usernames.manage`: the Usernames page, take-back states and reasons (the audit log shows them to `audit.view`, as for every action).
- To anyone on these screens: the user's email, phone, balance amounts or messages. The form shows "has a balance" and "has a withdrawal in flight", not amounts; the email address is "verified address on file: yes or no".
- In mail logs: the email content is sealed like all mail.

## 10. Testing

Run at the levels the repo uses. Do not run the integration or e2e suites while another job holds the test ports and database.

- **Unit**
  - `packages/domain/test/handles.test.mjs`: `reservationKey` for case, `-`/`_`, invalid input; `isReservedHandle` unchanged.
  - `packages/contracts/test/ops-catalogue.test.mjs`: the new permission is described, grouped and sensitive; `SERIOUS_ACTIONS` has 11 (the count assertion at line 50); the action names its permission.
  - `packages/mail/test/templates.test.mjs`: each new type renders its sample, every variant; no em dash in any subject or body; subjects in sentence case.
  - `apps/web/test/ops-menu.test.mjs`: Usernames appears only with `usernames.manage`.
  - `apps/web/test/short-links.test.mjs` unchanged; it keeps proving the built-in list covers routes.
  - A new `apps/worker/test/username-take-backs-handler.test.mjs`, like the other handler tests: the job dispatches, is idempotent when run twice, and respects its timeout.
- **Integration**
  - `tests/integration/handle-rule.test.mjs` and `tests/integration/handle-renames.test.mjs`: a reserved name is refused at claim and rename; a Free page can choose during notice without a count; no alias for the taken name; the ordinary change during notice goes through the take-back path; the free change after an assignment, once.
  - `packages/database/test/integration/profiles.test.mjs`: `checkHandle` says `reserved`; deletion during notice reserves the name.
  - A new `tests/integration/username-reservations.test.mjs`: reserve, release, built-in refusal, case and `-` collisions, the database trigger refusing a claim and an alias insert on a reserved name (as the 0028 test does), two reservations at once, reserve against claim at once.
  - A new `tests/integration/username-take-backs.test.mjs`: the full state machine with an injected clock (approved, noticed only after `sent_at`, reminder, due, done), worker catch-up after a missed deadline, cancel against sweep, user choice against sweep, stale approval after a rename, old-username take-back, no-notice path, unnoticed and overdue issues.
  - `tests/integration/ops-serious-actions.test.mjs` and `ops-serious-gating.test.mjs`: `username.take_back` waits when a second qualified person exists, runs alone with the alert when none does, and the page's owner can't approve.
  - `tests/integration/ops-serious-routes.test.mjs` and `tests/integration/ops-catalogue.test.mjs`: every new route has its permission and fresh code, and the take-back route goes through `requestSeriousAction`.
  - `tests/integration/ops-access.test.mjs`: a custom role without the permission gets 403 on every route; with it, success.
  - `tests/integration/ops-search.test.mjs`: a taken-back name finds its page.
  - `packages/database/test/integration/mail-triggers.test.mjs`: each email is queued once, at the right step, with its dedupe key; nothing for an unverified address.
  - `packages/database/test/integration/migration-journal.test.mjs` covers the new migrations.
- **e2e** (Playwright, `tests/e2e/`, using `ops-helpers.ts`)
  - A new `tests/e2e/ops-usernames.spec.ts`: reserve and release; sign-up refuses the reserved name; two staff accounts request and approve a take-back; the user sees the banner, chooses a new name and the old link stops working.
  - `tests/e2e/ops-alone.spec.ts`: a single admin's take-back runs alone and says so.
  - `tests/e2e/ops-staff.spec.ts`: someone without the permission sees no Usernames link.

## 11. Rollout

**Migration safety** (production is on Aiven Postgres; additive only; drizzle migrations `0071` onwards):

- New tables `handle_reservations` and `handle_take_backs`, with their indexes.
- The new trigger on `profiles` and `handle_aliases` (a brief lock on creation; both tables are small).
- Widen `role_permissions_known` and `staff_permission_overrides_known` to include `usernames.manage` (drop and re-add the check, as 0064 did; it only widens) and grant it to `owner`.
- Widen `issues_kind` for the two new kinds. `issues` can be large, so add the new constraint `NOT VALID` and `VALIDATE` it in the same migration file after the swap, so the table isn't locked while it is checked.
- No column is dropped or rewritten. An older release ignores the new tables, but the trigger still stops it from handing out a reserved name. A rollback leaves open take-backs waiting; the next release's sweep picks them up.

**Order of PRs**

1. **Reservations.** Domain `reservationKey`; the reservations table and trigger; the permission and its migration; checks in `isTaken`/`checkHandle`; the reserve, release and check routes; the Usernames page without take-backs; tests. Safe to ship alone: the only user-facing change is that reserved names are refused.
2. **Take-backs.** The take-back table; the serious action; the take-back mode of the username form and the dashboard banner; the worker sweep, revalidation and issue kinds; the emails; the Pages card; search; tests; the runbook (`docs/runbooks/admin-roles.md` gains the permission and the take-back procedure) and a dated note in `docs/00-DECISIONS.md` amending the handle rule (old usernames are unclaimable "while the page exists, unless TipMe takes one back"). **This PR must not reach production before PR #108 (the terms' "Your username" section) is on `main`**, because the emails point to those terms.
3. Optional, if PR 2 is too large: the without-notice path and the free change after an assignment.

## 12. The owner's answers (3 Nov 2026)

These settle the open questions. Where a section above says otherwise, this section wins, and the plan must follow it.

1. **One admin.** As today: with a single qualified admin, a take-back runs on that person's approval and an alert is recorded (the lone-admin rule in `serious-actions.ts`). Once a second person holds the permission, a second approver is required.
2. **No verified email: the notice must be seen, and seeing it cannot be dodged.**
   - The 7 days start at the earliest of:
     (a) the notice email being sent to a verified address; or
     (b) the user signing in and the dashboard showing them the take-back banner. The server records the first time the banner is rendered for that signed-in user (`banner_seen_at` on `handle_take_backs`), and that moment starts the clock.
   - Once the banner has been seen, adding or not adding an email changes nothing; the clock is already running. A user who sees the banner and deliberately adds no email cannot hold the name.
   - The banner says which username goes, why (the category's fixed wording), the date it goes, and offers "Choose a new username" now.
   - **Never told at all:** if neither (a) nor (b) happens within 14 days of approval (the owner shortened this from 30, 3 Nov 2026), the take-back proceeds as at the deadline. The page gets its new username, and the done email goes out if an address exists by then. This is recorded on the take-back.
   - Impersonation, trademark and legal cases keep the sooner-or-without-notice path (5.10).
3. **Why, in the email.** Fixed wording per category only. No staff free text reaches the user. The requester's reason stays internal, in the audit log and the approval.
4. **After an assigned username.** Yes: one free change within 30 days of TipMe assigning a username, on any plan. It does not use a Pro change.
5. **The generated username (controller's call, the owner did not choose).** `page_` plus 6 random characters, as proposed, so it never repeats the name being taken. Combined with 4, the person can swap it for a name they like.
6. **`pro`.** Already in `RESERVED_HANDLES`, in code, on the screen-redesign branch (commit 29cedcc, owner-approved 3 Nov 2026). It reaches `dev` with the redesign PR, so it is not a staff reservation.

**The terms follow these answers.** PR #108's "Your username" section is updated before merge. It says TipMe tells the person by email or on their dashboard, and that if TipMe cannot reach them within 14 days, it goes ahead.

## 13. Where the code and the owner's decisions disagree

- `RESERVED_HANDLES` (`packages/domain/src/handles.ts:9-81`) on `dev` has `admin` and `api` but not `pro`; the redesign branch adds it (answer 6).
- The terms' "Your username" section (commit `c928b24`, PR #108) is not on `dev`; this branch is based on `origin/dev` and doesn't have it.
- `docs/00-DECISIONS.md` (1 Nov 2026 handle rule) says old handles "keep leading to the page and stay unclaimable while it exists", and the rename confirmation says old links and printed QR codes keep working. A take-back breaks both for the name taken, as the terms intend; the decision needs a dated amendment (PR 2).
- "Needs a second staff member's approval" against the lone-admin rule in `serious-actions.ts:539-590` (answer 1).
- A Free page can't change its username (`profiles.ts:528`), but the terms ask the person to choose a new one. This design waives the rule for a take-back only.
- The terms promise an email, but `mailOwner` sends nothing without a verified address (`account-mail.ts:24-56`) (answer 2: email or a seen dashboard banner).
