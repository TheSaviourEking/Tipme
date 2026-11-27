# Account Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support can start a reset of a person's page from the ops Pages screen; once the person confirms through a one-time emailed link while signed in, the page's content is cleared (and the payment setup too, only if it never received money) while the login, username, Pro and all money history stay.

**Architecture:** Deletion's guard and content erase move into `page-erase.ts` and are shared, unchanged, by `deleteAccount` and a new `account-reset.ts`. A reset is an `account_resets` row with a sha256'd link (24 h, single use); the confirm runs in one transaction under deletion's lock order (recovery rows → profile → reset row → everything else). A never-used partner account moves to `payment_account_archive`, so `payment_accounts` keeps only current accounts and no existing lookup changes; the webhook and the two reference-binding paths consult the archive. The API adds three ops routes and three `/v1/me/account-reset/*` routes; the web adds an ops Reset card, `/account/reset`, the public "isn't set up yet" notice and the dashboard's setup-again steps.

**Tech Stack:** TypeScript strict, NestJS (API), Drizzle/Postgres (drizzle-kit migrations), Zod contracts, `@tipme/mail` templates, Next.js App Router (web), `node --test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-account-reset-design.md` (owner-approved 27 Nov 2026, "go with your picks"). Its (owner decided), (my call) and the rulings below are binding; §n means a section of the spec.

---

## What the code does today (branch `docs/account-reset` at `f98cf3e5`, migrations up to `0128_provider_split_checks`)

- **Deletion:** `deleteAccount` (`packages/database/src/operations/profiles.ts:1061`) locks `lockStaffAdmin` → recovery rows → profile `FOR UPDATE`, then runs the guard inline (`balanceIn` + `collectMoneyHeld`, skipped for `rehearsalCleanup`), the profile update, supporters, `tip_campaigns`/`campaigns`/`monthly_recaps`, `support_requests`, `profile_avatars`, `deleteCoverRenditions`, `profile_covers`, `deleteStudioData`, holds, aliases, take-backs, then the user erase, sessions and `changelog_reads`; it calls `removeObjects(input.photos, photoKeys)` after commit. Its tests are in 11 database files and 6 `tests/integration` files (Task 1 lists them).
- **Payment accounts:** one `payment_accounts` row per (profile, provider, environment); no table has a foreign key to `payment_accounts.id`. `beginPaymentAccountCreation` (`payment-accounts.ts:118`) reuses an existing row (restarting `FAILED` under the same id, so the partner key `tipme-acct-<id>` / `tipme-collect-acct-<id>` repeats). `updatePaymentAccountStatus` (`:194`) binds by (profile, provider, environment); `recoverUnknownPaymentAccount` (`:303`) binds an `UNKNOWN` row; `findPaymentAccountByReference` (`:662`) is what `WebhookService.refreshBachsAccount` (`apps/api/src/webhooks/webhook.service.ts:621`) calls before `unknownBachsAccount`.
- **Charged references:** every Bachs direct attempt stores `<account>:<checkout>` (`scopedCheckoutReference`, `packages/payments/src/bachs/provider.ts:341`); collect and Pro checkouts store `platform:…`; Bachs `findPayment` never returns a reference (it throws). So §4.1 signal 1 needs no bare-id fallback; Task 3 re-checks this.
- **Checkout start:** `createPaymentIntent` commits the intent and first attempt (the intent's `profile_id` foreign key takes `FOR KEY SHARE` on the profile), then `getReadyPaymentAccount` reads the reference with no lock, then `claimAttemptStart` (`attempts.ts:84`) moves `CREATED` → `STARTING`. A later attempt on an existing intent takes no profile lock.
- **Banks:** destinations hang from (owner, provider), not from an account id (`payout_destinations_active`). `setPayoutDestination` (`payout-destinations.ts:178`) takes the profile lock; the routes are `PUT /v1/me/payout-destination` (`payout-destination.controller.ts:191`) and `POST /v1/me/collect/bank` (`collect-bank.controller.ts:233`), both through `registerBankEverywhere`. The pretend provider has no accounts ("the profile stands in").
- **Mode:** `nextCollectionMode` (private, `collection-mode.ts:106`) decides an undecided person from their one account row; `previewCollectionMode` exposes it read-only.
- **Ops:** `OPS_PERMISSIONS` / `OPS_CATALOGUE` / `OPS_PAGE_LOOKUP_PERMISSIONS` / `OPS_FRESH_CODE_EXEMPT` in `packages/contracts/src/ops-catalogue.ts`; the Owner role holds every permission (`ensureOwnerRole`, `staff.ts:65`); `role_permissions_known` and `staff_permission_overrides_known` checks list them (last rebuilt in `0124_collect_ops.sql`). `endLinksOfStaffWithoutAccess` (`username-handovers.ts:196`) is called from four places in `staff-admin.ts`.
- **Mail:** `mailOwner` (`account-mail.ts:32`) takes no `expiresAt`; `enqueueMail` does. Link templates use `mailLink(ctx, '/x#t=<token>', key, true)` (`recovery-link.ts`).
- **Public page:** `GET /v1/profiles/:handle` (`public-profile.controller.ts:51`) answers 404 for a `not_live` page; `handleAliasTarget` resolves aliases of live pages only. The dashboard's setup block shows only on a first day (`home-view.tsx:128`: no tips, zero balance).

## Rulings on spec gaps (made by this plan)

- **R1. One migration.** The spec's migrations 1–3 plus R4's column are one generated file, `<n>_account_reset.sql`. It also rebuilds `staff_permission_overrides_known` (it lists permissions too) and adds `accounts.reset` to the existing `owner` role row, as `0124` did.
- **R2. Owner holds it.** "No system role gets it by default" cannot hold for Owner: that role holds every permission by construction (`ensureOwnerRole`). Owner holds `accounts.reset` (and so can grant it); `release_check` and every other role don't.
- **R3. Accountless providers.** A reset judges only `payment_accounts` rows. The pretend provider (`mock`, non-production only) has none: its destinations are left as they are. The summary `paymentSetup` is `'keep'` when any current account is used, otherwise `'clear'` (including no accounts at all).
- **R4. "Not live since the reset".** `account_resets.live_again_at timestamptz NULL` (check: only when `confirmed_at` is set). `setPageState('live')` sets it on the page's latest confirmed reset, in the same transaction. "After a reset" = latest confirmed reset with `live_again_at IS NULL`; the free rename is offered while also `free_rename_used_at IS NULL`.
- **R5. Confirm answers, never throws, on a refusal**, so `last_refusal` commits. Every me-route answers 200 with a `state`.
- **R6. Requester lost `accounts.reset`** (only possible if the automatic cancel skipped a locked row): a refusal with code `FORBIDDEN`.
- **R7. Name recheck.** When anything is archived: `collect_partner_name_digest` → null always; `collect_name_recheck_at` → now only when `collect_verified_at` is set (an unverified person has nothing to recheck). Mode → null only when no current account is kept and the mode isn't `collect`.
- **R8. Quotes.** Confirm sets `expires_at = now` on the profile's quotes with `expires_at > now` (no trigger forbids it).
- **R9. Setup issues.** Open `payment_account_setup.<old id>` issues resolve with `resolved_by = 'system'`, `resolution_outcome = NULL`, and an issue note "Account reset: this account was never used and is archived." (no new outcome, so no new check value).
- **R10. Bank-change window.** `BANK_CHANGE_WINDOW_MS = 30 * 60 * 1000`: a bank change makes a handful of partner calls, each capped at 10 s (`bachs/client.ts:76`).
- **R11. Tip-start race.** Not closed today: a second attempt on an existing intent takes no profile lock, so it can read the reference before the confirm commits. `claimAttemptStart` gains `recipientAccountReference` and re-checks it under `SELECT … FROM profiles … FOR SHARE` (as `refuseExpiredCollectStart` does for collect).
- **R12. Automatic cancels** lock `account_resets` with `skipLocked` from staff changes and email changes (they don't hold the profile lock), and plainly after the profile lock from deletion and suspension. The confirm reads `users.email` without a lock: an email change racing a confirm is ordered after it.
- **R13. Aliases.** An old handle of a reset page answers 308 to the current handle, which answers "isn't set up yet" (otherwise a printed QR on an old name would say "We can't find").
- **R14. Photos.** `confirmAccountReset` removes its objects after commit itself, as `deleteAccount` does, and also returns `photoKeys` for tests.

## Global Constraints

Every task includes these.

- **TDD.** Write the failing test, watch it fail, implement, watch it pass. Financial code needs idempotency and concurrency tests (AGENTS.md).
- **Deletion unchanged.** `deleteAccount`'s behaviour and its existing tests do not change; no edit to any test file that already calls `deleteAccount` (`git diff --stat origin/dev -- <those files>` is empty in every PR).
- **Copy.** Users never see the payment provider's name: "our payment partner". Nothing implies TipMe is licensed or approved by anyone (D-04, D-06, D-07 stay open). Never edit `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`. Email and page copy is word for word from §8 and this plan.
- **No real payments.** No test calls `api.bachs.io` or `sandbox-api.bachs.io`; Bachs paths use the existing fake fetch or fake provider objects. A reset makes no partner call.
- **Link.** 32 random bytes, base64url; only `token_sha256` stored; carried as `/account/reset#r=<token>`; `mailLink(..., personal = true)`; 24 h; single use; never in a query string, log, audit row or unsealed mail column.
- **Lock order (§5.6).** Recovery rows → profile `FOR UPDATE` → `account_resets` → everything else. No staff-admin lock. Paths not holding the profile lock touch `account_resets` only with `skipLocked`.
- **Migrations** through `pnpm --filter @tipme/database generate` only, taking the next free number (0129 today; other open branches also use 0129+; whichever merges later renumbers its file and journal entry). Additive only. Never run a migration, backfill or script against staging or production.
- **E2E** in lanes 3–8 only (never 9, never unset in a worktree). Before any e2e run or `pnpm test:integration`, check nobody is using the database: `psql "$DATABASE_URL" -Atc "SELECT datname, count(*) FROM pg_stat_activity WHERE datname LIKE 'tipme_test%' OR datname LIKE 'tipme_it%' GROUP BY 1"`; pick a lane with no row, or wait. New or changed specs pass `--repeat-each=5 --retries=0 --workers=2`. Tests routing `**/v1/me/**` answer `/v1/me/events` with 204.
- **Screenshots.** Every PR with visible UI shows phone 390 and desktop 1440 screenshots of test data, committed to the orphan `pr-assets` branch under `pr-<n>/` and linked as `https://raw.githubusercontent.com/TheSaviourEking/Tipme/pr-assets/pr-<n>/<file>.png`.
- **API changes** regenerate OpenAPI (`pnpm --filter @tipme/api build && pnpm api:openapi`) and docs (`pnpm docs:generate`); their `--check` passes.
- **Process.** PRs into `dev`, in the order of the delivery table. Never `--no-verify`; no bare `git stash`. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PATH:** `$HOME/.nvm/versions/node/v24.22.0/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH`.

## Commands used by every task

`$LANE` is your lane (3–8), checked free as above.

| What                 | Command                                                                                                                                                                                                         | Passing output |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Build (not web)      | `pnpm turbo run build --filter=!@tipme/web`                                                                                                                                                                     | exit 0         |
| Integration files    | `TIPME_TEST_DATABASE=tipme_test_lane$LANE node --import ./packages/observability/dist/register.js --test --test-concurrency=1 <files>`                                                                          | `# fail 0`     |
| Whole integration    | `pnpm test:integration` (template `tipme_it`, one copy per process)                                                                                                                                             | `# fail 0`     |
| Contracts / mail     | `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`; same for `@tipme/mail`                                                                                                           | `# fail 0`     |
| API / web unit       | `pnpm --filter @tipme/api build && pnpm --filter @tipme/api test`; `pnpm --filter @tipme/web test`                                                                                                              | `# fail 0`     |
| Migration check      | `pnpm --filter @tipme/database generate` after yours                                                                                                                                                            | no new file    |
| E2E (one spec)       | `E2E_LANE=$LANE TURBO_FORCE=true node scripts/build-e2e.mjs && E2E_LANE=$LANE node scripts/prepare-e2e-database.mjs && E2E_LANE=$LANE pnpm exec playwright test <spec> --repeat-each=5 --retries=0 --workers=2` | 0 failed       |
| Whole gate (each PR) | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (`E2E_LANE` unset)                                                                                                                              | exit 0         |

## Review Focus

Inputs the spec implies but its test list doesn't name, most likely to bite first. Each has its pinning test in the owning task.

1. **The person presses Reset in two tabs at once.** Expected: one reset runs, the other answers `invalid`; one erase, one done email, one `completed` audit row. _Test:_ `two confirms at once: one runs, the other is invalid` (Task 9).
2. **A supporter scans a printed QR for an old username of a reset page.** Expected: it reaches "@handle isn't set up yet", not "We can't find". _Test:_ `an old handle of a reset page moves to the current one, which is not set up yet` (Task 14).
3. **The verified address is stored with different case or spacing than the reset row.** Expected: the confirm compares normalised addresses and runs. _Test:_ `a confirm matches the address after normalising it` (Task 9).
4. **The link is used at exactly 24 h.** Expected: `expired` (open means `now < expires_at`), on preview, confirm and decline alike. _Test:_ `at exactly expires_at the link is expired` (Task 9).
5. **The person opens the link signed out.** Expected: sign-in returns them to `/account/reset#r=<token>` with the fragment intact, and the page loads the preview. _Test:_ `signed out, the link survives sign-in` (Task 16 unit, Task 17 e2e).

---

## Delivery order

| PR  | Tasks | Touches API?           | Visible UI?               |
| --- | ----- | ---------------------- | ------------------------- |
| A   | 1     | No                     | No                        |
| B   | 2–6   | Webhook only           | No                        |
| C   | 7–13  | Checkout + bank routes | No                        |
| D   | 14    | Yes (OpenAPI)          | No                        |
| E   | 15–18 | No                     | Ops card, confirm, public |

Strictly sequential. PR A merges before anything else touches `deleteAccount`.

---

### Task 1: Shared erase, with deletion's tests unedited (PR A)

**Files:**

- Create: `packages/database/src/operations/page-erase.ts`
- Modify: `packages/database/src/operations/profiles.ts` (`deleteAccount` ~1061–1240)
- Test: create `packages/database/test/integration/page-erase.test.mjs`; run unedited: `packages/database/test/integration/{supporters,mail-triggers,photo-storage,profiles,sign-in-email,whats-new,cover-animation,thanks,recovery-email,notifications,business-members}.test.mjs` and `tests/integration/{username-take-backs,studio-api,ops-people,cover-api,collect-disputes,collect-refunds}.test.mjs`

**Interfaces:**

- Produces:

  ```ts
  /** Deletion's money guard, unchanged: HAS_BALANCE while available, confirming, kept, on its way or refund held is above zero, or collectMoneyHeld. */
  export async function refuseWhileMoneyIsTheirs(
    tx: Tx,
    profileId: string,
  ): Promise<void>;
  /**
   * Clears role, bio, craft, note, avatar_path, every cover_* column, links ([]), socials ({}),
   * thanks_line/style (null), thanks_signed (false); deletes supporters, tip_campaigns of the page's
   * campaigns, campaigns, monthly_recaps, profile_avatars, cover renditions, profile_covers and
   * Studio data. Returns the object keys to remove after commit. Never touches handle,
   * display_name, page_state or anything outside page content.
   */
  export async function erasePageContent(
    tx: Tx,
    input: { profileId: string; now: Date },
  ): Promise<string[]>;
  ```

- [ ] **Step 1: Record the baseline.** Build, then run every file listed under Test (except the new one) on your lane. Expected: `# fail 0`. Keep the pass counts for the PR.
- [ ] **Step 2: Write the failing test** `page-erase.test.mjs`:
  - `erasePageContent clears page content and nothing else`: seed Ada with bio, role, craft, note, links, a cover design, an uploaded avatar and cover (with renditions), thanks line/style/signed, a campaign tied to a tip, a monthly recap, an opted-in supporter and a Studio draft → after it, those columns are null/default, the eight content tables have no rows for Ada, the returned keys equal the avatar, cover, rendition and Studio object keys; `handle`, `display_name`, `page_state`, `phone_public`, `tips`, `tip_supporters`'s tips and `support_requests` are unchanged.
  - `refuseWhileMoneyIsTheirs refuses each kind of money`: one case each for available, confirming, kept, on its way, refund held and a held dispute → `HAS_BALANCE`; a zero balance and a negative balance (debt) → resolves.
- [ ] **Step 3: Run it, expect FAIL** (module missing).
- [ ] **Step 4: Implement** `page-erase.ts` by moving the code out of `deleteAccount` (same statements, same order inside the helper). `deleteAccount` keeps its rehearsal exception at the call site (`if (!input.rehearsalCleanup) await refuseWhileMoneyIsTheirs(tx, row.id)`), calls `erasePageContent`, and keeps its own extras (`page_state 'deleted'`, `handle`, `handle_lower`, `display_name 'Deleted page'`, `phone_public`/`email_public` false, `support_requests`, holds, aliases, take-backs, user erase, sessions, `changelog_reads`).
- [ ] **Step 5: Run the new file and every baseline file, expect PASS** with the same counts as Step 1, and `git diff --stat` shows no change to any baseline test file.
- [ ] **Step 6: Commit** `refactor(database): share deletion's guard and page erase`.

### Task 2: Tables, permission and codes (PR B)

**Files:**

- Modify: `packages/database/src/schema.ts` (tables `accountResets`, `paymentAccountArchive`); generate `packages/database/drizzle/<n>_account_reset.sql`, then hand-append the owner grant (R1)
- Modify: `packages/contracts/src/ops-catalogue.ts` (`OPS_PERMISSIONS`, `OPS_CATALOGUE`, `OPS_PAGE_LOOKUP_PERMISSIONS`)
- Modify: `packages/database/src/operations/errors.ts`, `packages/contracts/src/errors.ts`, `apps/api/src/http/api-exception.filter.ts` (messages and statuses)
- Test: create `packages/database/test/integration/account-reset-schema.test.mjs`; modify `packages/contracts/test/ops-catalogue.test.mjs`

**Interfaces:**

- Produces: tables exactly as §5.2 and §4.3, plus `account_resets.live_again_at timestamptz` with `check live_again_at is null or confirmed_at is not null` (R4). `payment_account_archive.reset_id` → `account_resets.id`; `profile_id` → `profiles.id`; `unique (provider, environment, provider_account_reference)`.
- Produces: `'accounts.reset'` with `{ description: "Reset a person's page so they can start again, once they confirm by email", group: 'people', sensitive: true }`, and in `OPS_PAGE_LOOKUP_PERMISSIONS`.
- Produces codes (database, contracts and filter; all HTTP 409 except `CANNOT_RESET_SELF` 403): `PAYMENT_IN_PROGRESS`, `PAYOUT_IN_PROGRESS`, `SHARE_IN_PROGRESS`, `PRO_PAYMENT_IN_PROGRESS`, `WITHDRAWAL_HOLD`, `PAYMENT_SETUP_IN_PROGRESS`, `BANK_CHANGE_IN_PROGRESS`, `RECOVERY_OPEN`, `CANNOT_RESET_SELF`, `ACCOUNT_CHANGED`, `PAGE_NOT_SET_UP` (404). Reuse any that already exist. `ACCOUNT_CHANGED` message: "Your payment setup changed while you were saving. Please add your bank details again."

- [ ] **Step 1: Write the failing tests:**
  - schema: a second open reset for the same profile → unique violation; `expires_at <= created_at` → check violation; confirmed and cancelled together → violation; `cancelled_at` without `cancel_reason` → violation; `free_rename_used_at` or `live_again_at` on an unconfirmed row → violation; two archive rows with the same (provider, environment, reference) → violation; two with null references → allowed.
  - schema: `INSERT INTO role_permissions VALUES ('owner','accounts.reset')` already exists after migrating (owner grant); a `release_check` role row has no `accounts.reset`; a staff override with `accounts.reset` is accepted.
  - catalogue: `OPS_CATALOGUE['accounts.reset']` deep-equals the entry above; `OPS_PAGE_LOOKUP_PERMISSIONS` includes it.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; `pnpm --filter @tipme/database generate`; append the owner `INSERT … ON CONFLICT DO NOTHING` as in `0124_collect_ops.sql`.
- [ ] **Step 4: Run, expect PASS**; the migration check makes no new file; contracts tests pass.
- [ ] **Step 5: Commit** `feat(database): account reset tables and permission`.

### Task 3: "Has received money" (PR B)

**Files:**

- Create: `packages/database/src/operations/account-reset.ts` (this task adds the first exports)
- Test: create `packages/database/test/integration/account-reset-used.test.mjs`

**Interfaces:**

- Produces:

  ```ts
  export type ResetPaymentSetup = 'clear' | 'keep';
  /** Each current person account of the page (payment_accounts.profile_id), by id: true when it has received money (§4.1). */
  export async function paymentSetupUsed(
    db: Database | Tx,
    profileId: string,
  ): Promise<Map<string, boolean>>;
  /** 'keep' when any account is used, otherwise 'clear' (R3). */
  export function paymentSetupSummary(
    used: Map<string, boolean>,
  ): ResetPaymentSetup;
  ```

- [ ] **Step 1: Check the reference form.** `grep -n "providerReference" packages/payments/src/bachs/provider.ts packages/database/src/operations/{attempts,expire,reconcile}.ts` and confirm every direct Bachs attempt stores `<account>:<checkout>` (today: yes). If any path stores a bare id, add the §4.1 fallback signal and its test; say which in the PR.
- [ ] **Step 2: Write the failing tests** (one Bachs sandbox account for Ada, reference `acct_ada`, unless stated):
  - `an account nothing touched is not used` → `false`; summary `'clear'`; no accounts → empty map, summary `'clear'`.
  - one test per signal, each alone making it `true`: attempt `acct_ada:chk_1` in `VERIFIED_SUCCEEDED`, and again in `PENDING`; a `payouts` row with `account_reference = 'acct_ada'` in `FAILED`; a `collect_transfers` row with that reference and `sent_at` set, and another `paid`; a `provider_fee_credits` row; a `pro_purchases` row; a `share_transfers` row for Ada with `provider = 'bachs'` in `done`.
  - `failed and expired attempts don't count`: `acct_ada:chk_2` in `VERIFIED_FAILED` and `EXPIRED` → `false`.
  - `a collect transfer that never left doesn't count`: `ready` with the reference and `sent_at` null → `false`.
  - `another account's charge doesn't count`: `acct_adam:chk_1` (prefix without the colon) → `false`.
  - `a FAILED account with no reference has received nothing` → `false`.
  - `with two providers, each is judged alone`: a used `bachs` row and an unused `mock_alt` row → the map has the `bachs` row's id → `true` and the `mock_alt` row's id → `false`; summary `'keep'`.
  - `a business's account is not the person's`: a used business account with the same owner → not in the map.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement** as one query per account with an `EXISTS` per signal; the attempt match is `starts_with(provider_reference, reference || ':')` (no `LIKE`, so `_` and `%` in references are literal).
- [ ] **Step 5: Run, expect PASS.**
- [ ] **Step 6: Commit** `feat(database): tell whether a payment setup has received money`.

### Task 4: The reset guard (PR B)

**Files:**

- Modify: `packages/database/src/operations/account-reset.ts`
- Test: create `packages/database/test/integration/account-reset-guard.test.mjs`

**Interfaces:**

- Consumes: Task 1 `refuseWhileMoneyIsTheirs`.
- Produces:

  ```ts
  export const BANK_CHANGE_WINDOW_MS = 30 * 60 * 1000; // R10
  /** refuseWhileMoneyIsTheirs, then §5.3's table in its order; throws the first code that applies. `email` is the person's normalised address. */
  export async function refuseWhileResetBlocked(
    tx: Tx,
    input: { profileId: string; email: string; now: Date },
  ): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**, one per row of §5.3 with its exact code: attempt in each of `CREATED`, `STARTING`, `INITIATED`, `PENDING`, `UNKNOWN` → `PAYMENT_IN_PROGRESS`; payout `REQUESTED`, `PROCESSING` → `PAYOUT_IN_PROGRESS`; share transfer `waiting`, `out_sent`, `out_paid`, `in_sent`, `review` → `SHARE_IN_PROGRESS`; Pro purchase `PENDING`, `COLLECTING`, `UNKNOWN`, `REVIEW` → `PRO_PAYMENT_IN_PROGRESS`; collect transfer `sent`, `unknown`, `review` → `HAS_BALANCE`; tip refund `REQUESTED`, `PROCESSING`, `UNKNOWN` → `HAS_BALANCE`; active `withdrawal_holds` row → `WITHDRAWAL_HOLD`; current account `CREATING`, `UNKNOWN` → `PAYMENT_SETUP_IN_PROGRESS`; a `payout_destination` email code consumed 29 min ago with no destination row created since → `BANK_CHANGE_IN_PROGRESS`.
  - not blocking: share transfer `gap`, `done`, `cancelled`; attempt `VERIFIED_SUCCEEDED`; payout `PAID`; a released hold; a code consumed 31 min ago; a code consumed 5 min ago followed by a new destination row; a negative balance.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Attempts reach the page through `payment_intents.profile_id`; tip refunds through `tips.profile_id`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(database): what stops a reset`.

### Task 5: Archive a never-used payment setup (PR B)

**Files:**

- Modify: `packages/database/src/operations/account-reset.ts`
- Test: create `packages/database/test/integration/account-reset-archive.test.mjs`

**Interfaces:**

- Consumes: Task 3 `paymentSetupUsed`.
- Produces:

  ```ts
  /** §4.3 steps 1–3 for every account `used` marks false, in the caller's transaction (after the profile lock). */
  export async function archiveUnusedPaymentSetup(
    tx: Tx,
    input: {
      profileId: string;
      resetId: string;
      now: Date;
      used: Map<string, boolean>;
    },
  ): Promise<{
    archivedAccountIds: string[];
    replacedDestinationIds: string[];
  }>;
  export function isArchivedAccountReference(
    db: Database | Tx,
    input: {
      provider: string;
      environment: 'sandbox' | 'live';
      reference: string;
    },
  ): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing tests** (seed an open `account_resets` row for the reset id):
  - `an unused account moves to the archive`: the archive row carries the old id, provider, environment, reference, status, `manual_payouts_at`, `created_at`, `archived_at = now`, `reset_id`; `payment_accounts` has no row for Ada; her active destination for that provider has `replaced_at = now` and is still there.
  - `a used account is left exactly as it was`: `payment_accounts` and `payout_destinations` rows are byte-identical (`row_to_json`) and nothing is archived.
  - `with several providers only the unused account goes`.
  - `the next setup gets a new id`: after archiving, `beginPaymentAccountCreation` → `created: true` and an id different from the archived one.
  - `nothing decides the mode from the archived account`: an undecided page whose archived account was `ACTIVE` → `previewCollectionMode` (switch on, sign-ups not paused) is `'collect'`.
  - `the setup issue is closed by the system`: an open `payment_account_setup.<old id>` issue → `resolved`, `resolved_by 'system'`, outcome null, note "Account reset: this account was never used and is archived." (R9).
  - `isArchivedAccountReference` → true for the archived reference in its environment, false in the other environment and for an unknown reference.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (insert-then-delete per account; lock each `payment_accounts` row `FOR UPDATE` first).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(database): archive a payment setup that was never used`.

### Task 6: The three places that consult the archive (PR B)

**Files:**

- Modify: `apps/api/src/webhooks/webhook.service.ts` (`refreshBachsAccount` ~621)
- Modify: `packages/database/src/operations/payment-accounts.ts` (`updatePaymentAccountStatus`, `recoverUnknownPaymentAccount`)
- Test: `tests/integration/bachs-account-webhooks.test.mjs` (add), `packages/database/test/integration/account-reset-archive.test.mjs` (add)

**Interfaces:**

- Consumes: Task 5 `isArchivedAccountReference`.
- Produces: the webhook answers `'ignored'` and logs `{ event: 'payment_account.archived_event' }` (no reference in the log); both binding paths throw `OperationError('INVALID_INPUT')` for an archived reference, checked inside their transaction before any write.

- [ ] **Step 1: Write the failing tests:**
  - `an account event for an archived account is ignored and writes nothing`: archive `acct_old`, deliver a signed account event naming it → outcome `ignored`, no `unmatched_provider_events` row, no `payment_accounts` row, no issue, the log line present.
  - `an archived reference can't be bound again`: after archiving, Ada starts a new account (`CREATING`); `updatePaymentAccountStatus` with `acct_old` → `INVALID_INPUT` and her new row is unchanged; another page binding `acct_old` → `INVALID_INPUT`.
  - `recovery can't link an archived reference`: an `UNKNOWN` row with an open `payment_account_unresolved` issue; `recoverUnknownPaymentAccount` with `acct_old` → `INVALID_INPUT`, issue still open.
- [ ] **Step 2: Run, expect FAIL** (webhook parks it as `unknown_account`; binding succeeds).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `tests/integration/bachs-account-webhooks.test.mjs` and `bachs-recovery-api.test.mjs` whole.
- [ ] **Step 5: Commit** `feat(payments): archived accounts are never matched or bound again`.

### Task 7: The two emails (PR C)

**Files:**

- Create: `packages/mail/src/templates/types/account-reset.ts`; modify `packages/mail/src/templates/registry.ts`
- Modify: `packages/database/src/operations/account-mail.ts` (`mailOwner` gains optional `expiresAt?: Date`, passed to `enqueueMail`)
- Test: create `packages/mail/test/account-reset.test.mjs`

**Interfaces:**

- Produces mail types `account_reset_confirm` (`waiting: true`, data `{ token: string; handle: string; paymentSetup: 'clear' | 'keep' }`) and `account_reset_done` (data `{ handle: string }`), both `category: 'security'`, `sender: 'security'`, `preference: null`, `.strict()` schemas. Copy is §8.1 and §8.2 word for word: the clear/keep lists as `bullets`, the warning as an `alarm` block (`title: "This can't be undone."`), the button `mailLink(ctx, \`/account/reset#r=${token}\`, 'account_reset', true)`; the done button `mailLink(ctx, '/dashboard', 'account_reset_setup')`.

- [ ] **Step 1: Write the failing tests:** confirm with `clear` contains "your bank details and your link to our payment partner" under "This will clear"; with `keep` contains "because money has already been paid through them" under "This keeps", and not the clear line; both contain "@sample_handle", "Review and confirm", "The link works for 24 hours"; the redacted render shows `[personal link]` and no token; no render contains "Bachs", "licensed", "regulated" or "approved"; done has subject "Your TipMe page was reset", "Set up your page" and the alarm "Didn't do this?"; a data object with an extra key is refused; `mailOwner` with `expiresAt` stores it on the queued row.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `pnpm --filter @tipme/mail test` (the registry's sample render test covers the new types).
- [ ] **Step 5: Commit** `feat(mail): account reset emails`.

### Task 8: Start, cancel and the ops card read (PR C)

**Files:**

- Modify: `packages/database/src/operations/account-reset.ts`; export from `packages/database/src/index.ts`
- Create: `packages/contracts/src/account-reset.ts` (export from the index)
- Test: create `packages/database/test/integration/account-reset.test.mjs` (start and cancel sections)

**Interfaces:**

- Consumes: Tasks 3, 4, 7.
- Produces (contracts):

  ```ts
  export const ACCOUNT_RESET_REFUSALS = [
    'HAS_BALANCE',
    'PAYMENT_IN_PROGRESS',
    'PAYOUT_IN_PROGRESS',
    'SHARE_IN_PROGRESS',
    'PRO_PAYMENT_IN_PROGRESS',
    'WITHDRAWAL_HOLD',
    'PAYMENT_SETUP_IN_PROGRESS',
    'BANK_CHANGE_IN_PROGRESS',
    'RECOVERY_OPEN',
    'PAGE_SUSPENDED',
    'EMAIL_VERIFICATION_REQUIRED',
    'CANNOT_RESET_SELF',
    'PROFILE_NOT_FOUND',
    'INVALID_INPUT',
    'FORBIDDEN',
  ] as const;
  export type AccountResetRefusal = (typeof ACCOUNT_RESET_REFUSALS)[number];
  export interface OpsAccountResetStarted {
    resetId: string;
    expiresAt: string;
    maskedEmail: string;
    paymentSetup: 'clear' | 'keep';
  }
  export interface OpsAccountResetCard {
    paymentSetup: 'clear' | 'keep'; // what a reset would do now
    open: {
      resetId: string;
      maskedEmail: string;
      requestedBy: string;
      createdAt: string;
      expiresAt: string;
      lastRefusal: AccountResetRefusal | null;
    } | null;
  }
  export const accountResetTokenSchema = z
    .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
    .strict();
  ```

- Produces (database):

  ```ts
  export const ACCOUNT_RESET_TTL_MS = 24 * 60 * 60 * 1000;
  export function startAccountReset(
    db: Database,
    input: {
      profileId: string;
      staffUserId: string;
      reason: string;
      sealing: MailSealing;
      now?: Date;
    },
  ): Promise<{
    resetId: string;
    expiresAt: Date;
    maskedEmail: string;
    paymentSetup: ResetPaymentSetup;
  }>;
  export function cancelAccountReset(
    db: Database,
    input: { resetId: string; staffUserId: string; reason: string; now?: Date },
  ): Promise<void>; // INVALID_INPUT unless open
  export function openAccountResetFor(
    db: Database,
    profileId: string,
    now?: Date,
  ): Promise<OpsAccountResetCard>; // requestedBy: the staff member's email, as the approvals list shows staff
  /** Internal, shared by start and confirm: §5.1 step 2 in order, then refuseWhileResetBlocked. Throws the code. */
  async function refuseReset(
    tx: Tx,
    input: {
      profileId: string;
      userId: string;
      staffUserId: string;
      now: Date;
    },
  ): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `start sends one link and records it`: Ada (verified email) → a row with `email` normalised, `expires_at = now + 24 h`, `token_sha256` 64 hex; one `account_reset_confirm` mail to her address with `expires_at` equal to the link's and dedupe key `account_reset_confirm.<resetId>`; the unsealed mail data's token hashes to `token_sha256`; audit `account_reset.requested`, permission `accounts.reset`, subject `profile`/Ada, reason containing the staff reason and `{"resetId":…,"expiresAt":…,"paymentSetup":"clear"}`; the response's `maskedEmail` is `maskEmail(email)`.
  - `start reports keep for a used account` → `paymentSetup: 'keep'` in the response, the audit and the mail data.
  - refusals, each with nothing written: no page or deleted → `PROFILE_NOT_FOUND`; rehearsal page → `INVALID_INPUT`; suspended → `PAGE_SUSPENDED`; unverified email → `EMAIL_VERIFICATION_REQUIRED`; staff member's own page → `CANNOT_RESET_SELF`; open phone recovery, open email recovery → `RECOVERY_OPEN`; one guard condition (a `REQUESTED` payout) → `PAYOUT_IN_PROGRESS`.
  - `a new link replaces the old one`: start twice → the first row `cancelled_at` set, `cancel_reason` "Replaced by a new reset link", `cancelled_by` the staff member, audited `account_reset.cancelled`; exactly one open row.
  - `staff cancel`: `cancelAccountReset` → cancelled with the reason and staff member, audited `account_reset.cancelled`; cancelling again → `INVALID_INPUT`.
  - `the card`: open → the masked email, requester, times, `lastRefusal` null; after a refused confirm (Task 9) it shows that code; none open → `open: null`; `paymentSetup` reflects the accounts now.
  - `the token is never stored or logged in the clear`: no column of `account_resets`, `audit_events`, `mail_messages` (except `data_sealed`) contains the token.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Read the profile's `user_id` unlocked, then lock in §5.6 order and re-read; a changed owner → `PROFILE_NOT_FOUND`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(database): staff start and cancel an account reset`.

### Task 9: Preview, confirm and decline (PR C)

**Files:**

- Modify: `packages/database/src/operations/account-reset.ts`, `packages/contracts/src/account-reset.ts`
- Test: `packages/database/test/integration/account-reset.test.mjs` (confirm, link, kept/cleared sections)

**Interfaces:**

- Consumes: Tasks 1, 3, 4, 5, 7, 8.
- Produces:

  ```ts
  // contracts
  export interface AccountResetPreview {
    state: 'open' | 'expired' | 'cancelled' | 'invalid';
    handle?: string;
    expiresAt?: string;
    paymentSetup?: 'clear' | 'keep';
    refusal?: AccountResetRefusal;
  }
  export interface AccountResetConfirmResult {
    state: 'done' | 'refused' | 'expired' | 'cancelled' | 'invalid';
    handle?: string;
    refusal?: AccountResetRefusal;
  }
  export interface AccountResetDeclineResult {
    state: 'declined' | 'expired' | 'cancelled' | 'invalid';
  }
  // database
  export function previewAccountReset(
    db: Database,
    input: { token: string; userId: string; now?: Date },
  ): Promise<AccountResetPreview>;
  export function confirmAccountReset(
    db: Database,
    input: {
      token: string;
      userId: string;
      sealing: MailSealing;
      photos?: PhotoStore;
      now?: Date;
    },
  ): Promise<
    AccountResetConfirmResult & {
      photoKeys: string[];
      archived: boolean;
      paymentSetup?: ResetPaymentSetup;
    }
  >;
  export function declineAccountReset(
    db: Database,
    input: { token: string; userId: string; now?: Date },
  ): Promise<AccountResetDeclineResult>;
  ```

  The preview's `refusal` is the current `refuseReset` answer (read-only, no `last_refusal` write). `invalid` covers: unknown token, a different caller, a confirmed (used) link, and an address that no longer matches. Open means `now < expires_at`.

- [ ] **Step 1: Write the failing tests:**
  - `cleared`: Ada set up as in Task 1's test plus Pro tip amounts, `bio_public` false, `socials_public` false, `phone_public` true, `email_public` true, `qr_style 'black'`, live → after confirm: every §3.2 column at its reset value (`display_name` = handle, the three tip-amount columns null, switches at defaults, `page_state 'not_live'`), the content tables empty for her, the photo store's objects removed, `cover_version`/`avatar_version` unchanged.
  - `kept`: a `row_to_json` snapshot of `users`, `sessions`, `staff`, business rows, `pro_periods`, `pro_purchases`, `pro_auto_renew`, `tips`, `tip_messages`, `payouts`, ledger entries, `tip_refunds`, `disputes`, `collect_transfers`, `share_transfers`, `notifications`, `support_requests`, `handle_aliases`, `handle_holds`, `analytics_events`, `analytics_daily` and the kept `profiles` columns is identical before and after.
  - `used vs never used`: for each §4.1 signal (reuse Task 3's seeds) the reset keeps `payment_accounts`, `payout_destinations`, `collection_mode`, `collect_verified_at`, `collect_legal_name`, `collect_partner_name_digest`, `collect_name_recheck_at` identical, and the result is `paymentSetup 'keep'`, `archived false`.
  - `mode`: `collect` stays `collect` used or not; `direct` and null with an unused account → null; `direct` with a used account → `direct`.
  - `legal name`: verified collect person, unused account → `collect_verified_at` and `collect_legal_name` kept, partner digest null, `collect_name_recheck_at = now`, and a waiting share is not released (`collect-transfers` release finds the recheck); unverified person → recheck stays null (R7).
  - `quotes`: an open quote for Ada → `expires_at = now` after confirm (R8).
  - `after commit`: one `account_reset_done` mail (dedupe `account_reset_done.<id>`), audit `account_reset.completed` with `staffUserId` = requester, reason "Confirmed by the account owner", details `{ resetId, paymentSetup, archivedAccountIds, replacedDestinationIds }`.
  - `a refused confirm changes nothing but last_refusal`: a `PROCESSING` payout → `{ state: 'refused', refusal: 'PAYOUT_IN_PROGRESS' }`; the snapshot above plus `payment_accounts` identical; the row still open with `last_refusal = 'PAYOUT_IN_PROGRESS'`; the same link confirms once the payout is `PAID`.
  - `money arrives between start and confirm`: start, then a `VERIFIED_SUCCEEDED` tip credits her balance → confirm refused `HAS_BALANCE`.
  - link: reuse after confirm → `invalid`; past expiry → `expired`; **`at exactly expires_at the link is expired`** (preview, confirm, decline; Review Focus 4); after a new link, the old token → `cancelled`; another signed-in user → `invalid`; her email changed since → `invalid`; **`a confirm matches the address after normalising it`** (stored `Ada@Example.com ` vs row `ada@example.com`; Review Focus 3); the requester lost `accounts.reset` → `refused`/`FORBIDDEN` (R6); every refusal of §5.1 step 2 refuses confirm with the same code.
  - `decline`: → `declined`; row cancelled with `cancelled_by` null and reason "Declined by the account owner"; audit `account_reset.declined` with no staff member; confirm afterwards → `cancelled`.
  - **`two confirms at once: one runs, the other is invalid`** (Review Focus 1): `Promise.all` of two confirms → one `done`, one `invalid`; one done mail, one `completed` audit row.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** §5.5 in one transaction: unlocked lookup by `token_sha256`; locks in §5.6 order; state checks; `refuseReset` (on `OperationError` from it: write `last_refusal`, return `refused`); `paymentSetupUsed`; `erasePageContent` plus the reset-only fields; `archiveUnusedPaymentSetup` when any is unused, then the R7 mode and name updates; `confirmed_at`; R8; done mail; audit. After commit: `removeObjects(input.photos, photoKeys)`.
- [ ] **Step 4: Run, expect PASS**, plus Task 1's baseline files.
- [ ] **Step 5: Commit** `feat(database): the person confirms or declines a reset`.

### Task 10: Automatic cancels and lock order (PR C)

**Files:**

- Modify: `packages/database/src/operations/account-reset.ts`
- Modify: `packages/database/src/operations/staff-admin.ts` (the four `endLinksOfStaffWithoutAccess` call sites), `email.ts` (`confirmEmail`, `confirmEmailForUser`), `email-sign-in.ts` (`changeEmail`, `setAccountEmail`), `email-recovery.ts` (`completeDueRecoveries`), `profiles.ts` (`deleteAccount`, right after its profile lock; `setPageSuspension` when suspending)
- Test: `packages/database/test/integration/account-reset.test.mjs` (cancels and locks sections)

**Interfaces:**

- Produces:

  ```ts
  /** Cancels the open reset(s) of a profile or user, by the system: cancelled_by null, audited account_reset.cancelled with no staff member and { trigger }. skipLocked for callers not holding the profile lock (R12). */
  export async function cancelOpenResets(
    tx: Tx,
    input: {
      profileId?: string;
      userId?: string;
      reason: string;
      trigger:
        'staff_access' | 'email_changed' | 'account_deleted' | 'page_suspended';
      skipLocked: boolean;
      now: Date;
    },
  ): Promise<number>;
  /** As endLinksOfStaffWithoutAccess: open resets whose requester no longer holds accounts.reset; skipLocked, the update repeats the open condition. */
  export async function endResetsOfStaffWithoutAccess(
    tx: Tx,
    input: { actorId: string; trigger: StaffAccessTrigger; now: Date },
  ): Promise<number>;
  ```

  Reasons: "Staff access changed", "The account's email changed", "The account was deleted", "The page was paused".

- [ ] **Step 1: Write the failing tests:**
  - each trigger cancels the open reset with its reason and an audit row with no staff member: the requester's role loses `accounts.reset` (and each of the other three staff changes); Ada's email changes by each of the five paths (only when the address really changes); `deleteAccount` for Ada; Ada's page suspended (unsuspending cancels nothing).
  - `a staff change doesn't wait on a confirm`: hold Ada's reset row `FOR UPDATE` in a second client; the role change completes, the row is skipped, and the confirm later refuses `FORBIDDEN`.
  - `a confirm and a deletion at once never deadlock`: 20 rounds of `Promise.allSettled([confirmAccountReset, deleteAccount])` → no rejection with SQLSTATE `40P01`; each round ends either confirmed then deleted, or deleted with the confirm answering `cancelled`/`invalid`.
  - `a confirm and a recovery completing at once never deadlock`: same with `completeRecovery` (phone) and `completeDueRecoveries` (email, due) → no `40P01`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus Task 1's baseline files (unedited) and `staff-admin`, `email-recovery`, `recovery-email`, `sign-in-email` integration files.
- [ ] **Step 5: Commit** `feat(database): resets end when the requester, address or page changes`.

### Task 11: The free username change and "after a reset" (PR C)

**Files:**

- Modify: `packages/database/src/operations/profiles.ts` (`renameHandle`, `setPageState` into a transaction, `toMine`/`getMyProfile`), `account-reset.ts`
- Modify: `packages/contracts/src/profiles.ts` (`MyProfile.afterReset?: { freeRename: boolean } | null`)
- Test: `packages/database/test/integration/account-reset.test.mjs` (free rename section)

**Interfaces:**

- Consumes: Task 2's `free_rename_used_at`, `live_again_at` (R4).
- Produces: `myAfterReset(db: Database | Tx, profileId: string): Promise<{ freeRename: boolean } | null>`; `getMyProfile` fills `afterReset`. In `renameHandle`, after the take-back checks and only when neither applies, the latest confirmed reset with both columns null is locked `FOR UPDATE`; it makes the change allowed on any plan and not counted, sets `free_rename_used_at`, and audits `username.free_change_used` with `{ resetId, from, to }`. `setPageState('live')` sets `live_again_at = now` on that row.

- [ ] **Step 1: Write the failing tests:** on Free after a reset, one rename is allowed, `handle_changes_used` unchanged, the old name is an alias of the page; a second rename on Free → `HANDLE_CHANGE_PRO_REQUIRED`; going live then offline ends the offer (`afterReset` null, rename refused on Free); a take-back under way still wins (the rename completes the take-back and the reset's offer stays unused); with a done take-back's free change also open, that one is used first and the reset's offer remains; `getMyProfile` → `afterReset: { freeRename: true }`, then `{ freeRename: false }` after the rename, then null after going live.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `profiles.test.mjs`, `username-take-backs` (database and `tests/integration`) and `tests/integration/handle-rule.test.mjs`, unedited.
- [ ] **Step 5: Commit** `feat(database): one free username change after a reset`.

### Task 12: A tip starting while the confirm runs (PR C)

**Files:**

- Modify: `packages/database/src/operations/attempts.ts` (`claimAttemptStart`), `apps/api/src/checkout/checkout.service.ts` (~305–330)
- Test: `packages/database/test/integration/account-reset-races.test.mjs` (create), `tests/integration/bachs-checkout-start.test.mjs` (add)

**Interfaces:**

- Produces: `claimAttemptStart` input gains `recipientAccountReference?: string`. When given, inside its transaction it takes `SELECT 1 FROM profiles WHERE id = <quote's profile> FOR SHARE`, then requires a current `payment_accounts` row for that profile with that reference, `ACTIVE` and `charges_enabled`; otherwise it returns `{ outcome: 'account_changed' }` and leaves the attempt `CREATED`. The direct path passes it; checkout answers `409 PAYMENT_ACCOUNT_REQUIRED` for `account_changed`. Collect is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `an attempt starting during the confirm never charges the archived account` (barrier): Ada's unused `ACTIVE` account `acct_old`; an earlier attempt on intent I is `EXPIRED`; start a reset. Client H inserts (uncommitted) an archive row with Ada's account id, so the confirm blocks after its guard on the archive insert (wait until `pg_stat_activity` shows it waiting). Insert attempt 2 on I (`CREATED`, committed); call `claimAttemptStart({ recipientAccountReference: 'acct_old' })` and wait until it waits on the profile lock. Roll back H. Then: the confirm is `done`, the claim answers `account_changed`, attempt 2 is `CREATED`. Without the new check (red run) the claim answers `claimed`.
  - `the same race with a kept account starts normally`: a used account → confirm `done`, claim `claimed`.
  - `a collect tip after the confirm is credited as usual`: collect-quoted tip paid after the confirm → `VERIFIED_SUCCEEDED`, ledger credit to Ada, as `collected-tips.test.mjs` asserts.
  - API: `a direct start whose account was archived between read and claim answers PAYMENT_ACCOUNT_REQUIRED`, with the fake provider never called.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `bachs-checkout-start`, `checkout-collect` and `collect-payment` integration files.
- [ ] **Step 5: Commit** `fix(checkout): a direct start re-checks the account under the profile lock`.

### Task 13: A bank save straddling the confirm (PR C)

**Files:**

- Modify: `packages/database/src/operations/payout-destinations.ts` (`DestinationInput.accountReference?: string`; checked in `setPayoutDestination` after the profile lock)
- Modify: `apps/api/src/profiles/payout-destination.controller.ts`, `apps/api/src/profiles/collect-bank.controller.ts` (pass the reference the bank was added on; not for the pretend provider)
- Test: `packages/database/test/integration/account-reset-races.test.mjs`, `tests/integration/collect-bank-api.test.mjs` (add)

**Interfaces:**

- Produces: with `accountReference` set on a person's save, `setPayoutDestination` throws `OperationError('ACCOUNT_CHANGED')` unless a `payment_accounts` row exists for (profile, `provider`, that reference). Business saves and saves without it are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - database: archive Ada's account, then `setPayoutDestination({ accountReference: 'acct_old', … })` → `ACCOUNT_CHANGED`, no destination row written; with the current reference → saved.
  - API (`CollectBankController` and `PayoutDestinationController` with a fake provider, as `collect-bank-api.test.mjs` builds them): the reset is started first; the add-bank call then waits on a gate; while it waits, the confirm runs with `now` 31 minutes after the code was spent (the case the window can't cover: a save slower than it) and archives the unused account; release the gate → `409 ACCOUNT_CHANGED`, no new destination, no security email.
  - `a confirm inside the window is refused instead`: the same with the confirm at `now` + 1 minute → `refused`/`BANK_CHANGE_IN_PROGRESS`, and the save then succeeds.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `payout-destination-api`, `collect-bank-api` and the database `payout-destinations` files whole.
- [ ] **Step 5: Commit** `fix(banks): refuse a bank saved on an account a reset retired`.

### Task 14: API routes and the "not set up" answer (PR D)

**Files:**

- Create: `apps/api/src/ops/account-reset.controller.ts`, `apps/api/src/profiles/account-reset.controller.ts`; register both modules
- Modify: `apps/api/src/profiles/public-profile.controller.ts`; `packages/database/src/operations/profiles.ts` (`pageAwaitingSetup`); `packages/contracts/src/ops-catalogue.ts` (`OPS_FRESH_CODE_EXEMPT` entry for the card read)
- Test: create `tests/integration/account-reset-api.test.mjs`; `packages/contracts/test/ops-catalogue.test.mjs` (route scan passes)

**Interfaces:**

- Consumes: Tasks 8–11.
- Produces routes:
  - `POST /v1/ops/pages/:profileId/reset` — `opsReasonSchema`, `@OpsPermission('accounts.reset')`, `@FreshCode()`, `@RateLimit('ops_request')` → `OpsAccountResetStarted`.
  - `GET /v1/ops/pages/:profileId/reset` — same permission, `@RateLimit('ops_read')`, fresh-code exempt (reason: "Says whether a reset is pending so none is started blindly; shows a masked address only.") → `OpsAccountResetCard`.
  - `POST /v1/ops/pages/:profileId/reset/cancel` — `opsReasonSchema`, permission, `@FreshCode()` → 204.
  - `POST /v1/me/account-reset/{preview,confirm,decline}` — `accountResetTokenSchema`, `SessionGuard` + `CsrfGuard`, `@RateLimit('auth_verify')` → 200 with the Task 9 result. After a `done` confirm: `revalidator.revalidate(handle)`; live `profile.changed`, `payments.changed`, `account.changed` to `{ user }`; when archived, `partnerCache.invalidate({ provider, profileId })` for every configured provider.
  - `GET /v1/profiles/:handle`: R13 — a live page as today; an alias of a live page 308 as today; `pageAwaitingSetup(db, raw): Promise<{ handle: string } | null>` (active, `not_live`, latest confirmed reset with `live_again_at` null, matched by handle or alias) → 308 to the current handle when `raw` is an alias, else `404 PAGE_NOT_SET_UP`; anything else 404 `NOT_FOUND`.

- [ ] **Step 1: Write the failing tests:** without `accounts.reset` → 403 on all three ops routes; POST without a fresh code → refused with the fresh-code error; start → body as `OpsAccountResetStarted`, the mail queued; card → the open reset; cancel → 204 and the card shows none; the person's preview → `open` with handle and payment line, no write; confirm → `done`, the profile cleared, a live `profile.changed` published; a second confirm → `invalid`; decline → `declined`; me routes without a session → 401, without CSRF → 403; a token in a query string is ignored (body only); `GET /v1/profiles/<handle>` after confirm → 404 `PAGE_NOT_SET_UP`; **`an old handle of a reset page moves to the current one, which is not set up yet`** (Review Focus 2); once live again → 200; a never-reset `not_live` page → 404 `NOT_FOUND`; the API log lines captured during start, preview and confirm never contain the token.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus API unit tests, contracts tests, `tests/integration/public-profile*.test.mjs`; regenerate OpenAPI and docs.
- [ ] **Step 5: Commit** `feat(api): account reset routes`.

### Task 15: Ops Reset card (PR E)

**Files:**

- Create: `apps/web/src/components/ops/account-reset-card.tsx`, `apps/web/src/lib/account-reset-words.ts`
- Modify: `apps/web/src/app/ops/pages/page.tsx` (render the card for `can(access, 'accounts.reset')`)
- Test: create `apps/web/test/account-reset-words.test.mjs`

**Interfaces:**

- Consumes: Task 14 routes; contracts `OpsAccountResetCard`, `AccountResetRefusal`.
- Produces `OPS_RESET_REFUSAL_WORDS: Record<AccountResetRefusal, string>` (staff words) and `PERSON_RESET_REFUSAL_WORDS: Record<AccountResetRefusal, string>` (Task 16), exact copy:

  | Code                          | Staff (ops card)                                                                                    | Person (confirm page)                                                                  |
  | ----------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | `HAS_BALANCE`                 | They still have money with us                                                                       | Withdraw what's in your balance, then open this link again.                            |
  | `PAYOUT_IN_PROGRESS`          | A withdrawal is on its way                                                                          | Wait for your withdrawal to arrive, then open this link again.                         |
  | `PAYMENT_IN_PROGRESS`         | A tip to them is still being paid                                                                   | A tip to you is still being paid. Open this link again in a few minutes.               |
  | `SHARE_IN_PROGRESS`           | A business share is still moving                                                                    | Some money is still moving on your account. Open this link again in a little while.    |
  | `PRO_PAYMENT_IN_PROGRESS`     | A Pro payment isn't settled yet                                                                     | Your Pro payment isn't settled yet. Open this link again once it is.                   |
  | `BANK_CHANGE_IN_PROGRESS`     | They're changing their bank details right now                                                       | You're changing your bank details. Finish that, then open this link again.             |
  | `WITHDRAWAL_HOLD`             | Their withdrawals are on hold                                                                       | We can't reset your page right now. Reply to our email and our support team will help. |
  | `PAYMENT_SETUP_IN_PROGRESS`   | Their payment setup is stuck mid-way. Resolve it first (payment repair), then start the reset again | (same as `WITHDRAWAL_HOLD`)                                                            |
  | `RECOVERY_OPEN`               | An account recovery is open                                                                         | (same as `WITHDRAWAL_HOLD`)                                                            |
  | `PAGE_SUSPENDED`              | The page is paused. Unpause it first                                                                | (same as `WITHDRAWAL_HOLD`)                                                            |
  | `EMAIL_VERIFICATION_REQUIRED` | They have no verified email                                                                         | (same as `WITHDRAWAL_HOLD`)                                                            |
  | `CANNOT_RESET_SELF`           | You can't reset your own page                                                                       | (same as `WITHDRAWAL_HOLD`)                                                            |
  | `PROFILE_NOT_FOUND`           | There's no page to reset                                                                            | (same as `WITHDRAWAL_HOLD`)                                                            |
  | `INVALID_INPUT`               | This is a release-check page                                                                        | (same as `WITHDRAWAL_HOLD`)                                                            |
  | `FORBIDDEN`                   | The person who sent the link no longer can. Send a new link                                         | (same as `WITHDRAWAL_HOLD`)                                                            |

- [ ] **Step 1: Write the failing tests:** both maps cover every code in `ACCOUNT_RESET_REFUSALS`; no value contains a code-like `[A-Z_]{4,}` token, "Bachs", "licensed" or "approved"; `resetPaymentLine('keep')` = "Their payment setup has received money, so it stays; they change bank details the normal way"; `resetPaymentLine('clear')` = "Their payment setup was never used, so it's cleared too"; `pendingLine(card)` = "Reset link sent to j•••@g•••.com by {requestedBy} at {time}, expires {time}" with the ops `when()` format.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the card: heading "Reset page"; the short cleared and kept lists (§3, as in the email); the payment line; `ReasonAction` (field "Why is this page being reset?", submit "Send reset link") with the fresh-code flow other cards use; once open, the pending line, the last refusal in words, **Cancel** (`ReasonAction`, field "Why cancel this reset?") and **Send a new link**. Errors in words only.
- [ ] **Step 4: Run, expect PASS**, plus web typecheck and `pnpm --filter @tipme/web build`.
- [ ] **Step 5: Screenshots** of the card empty, pending (keep) and pending with a refusal, at 390 and 1440, from the e2e data of Task 17; commit `feat(ops): reset a page from the Pages screen`.

### Task 16: Confirm page, "isn't set up yet" and setup again (PR E)

**Files:**

- Create: `apps/web/src/app/account/reset/page.tsx`, `apps/web/src/app/account/reset/reset-flow.tsx` (client), `apps/web/src/lib/account-reset-flow.ts`, `apps/web/src/components/page-not-set-up.tsx`
- Modify: `apps/web/src/lib/profiles-api.ts` (`getPublicProfile` returns `{ notSetUp: true }` on 404 `PAGE_NOT_SET_UP`), `apps/web/src/app/people/[handle]/page.tsx` (render it, `robots: { index: false }`), `apps/web/src/app/dashboard/home-view.tsx` and `apps/web/src/app/dashboard/settings/sections/my-page.tsx` (`afterReset`)
- Test: create `apps/web/test/account-reset-flow.test.mjs`; extend the profiles-api and home-view unit tests where they exist

**Interfaces:**

- Consumes: Task 14 routes; `MyProfile.afterReset`; Task 15 `PERSON_RESET_REFUSAL_WORDS`.
- Produces `resetViewOf(preview: AccountResetPreview | AccountResetConfirmResult | null, signedIn: boolean): ResetView` (pure), and `tokenFromHash(hash: string): string | null` (reads `#r=`, rejects anything not 43 base64url characters).

Page copy, exact:

- open: heading "Reset your page?", the two lists from §8.1 (headed "This will clear" / "This keeps", with the payment line for `paymentSetup`), the alarm "This can't be undone. Once you confirm, what's listed above is gone for good.", buttons **Reset my page** and **Don't reset**.
- refused: heading "We can't reset your page yet", the person's words.
- done: heading "Your page is ready to set up again", button "Set up your page" → `/dashboard`.
- expired: "This link has expired. Ask our support team for a new one."
- cancelled: "This reset was cancelled. Nothing on your page changed."
- declined: "Nothing on your page changed."
- invalid: "This link doesn't work. Check that you're signed in to the account the email was sent to, or ask our support team for a new link."
- public page: "@{handle} isn't set up yet" and "Check back soon." (no name, photo, tip form or links).
- dashboard (when `afterReset` is set): the setup block shows whatever the tips and balance, headed "Your page isn't set up yet", steps in order: "Add your name" (done when `displayName !== handle`), "Change your username (free, once)" (only while `freeRename`; link `/dashboard/settings#username`), "Add a photo" (done with an avatar), "Choose your tip amounts" (Pro only), the existing payment step as it is, then "Put your page online". Settings offers the free change as it offers the take-back one.

- [ ] **Step 1: Write the failing tests:** `tokenFromHash('#r=<43 chars>')` → the token; a 42-character or `#v=` hash → null; `resetViewOf` maps each state to its heading above; signed out → `sign_in` with return path `/account/reset` and the hash kept (**`signed out, the link survives sign-in`**, Review Focus 5); refused uses the person's words; no rendered string names the provider; `getPublicProfile` turns a `PAGE_NOT_SET_UP` 404 into `{ notSetUp: true }` and a plain 404 into null; the dashboard shows the reset steps when `afterReset` is set even with tips.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The page reads the token from `location.hash` only, never puts it in a URL it requests, and posts it in the body; it reads the preview on load and after sign-in. Follow `docs/design/DESIGN-CONSTITUTION.md` (mobile-first, 44 px targets, focus ring, reduced motion).
- [ ] **Step 4: Run, expect PASS**, plus web typecheck, build and `node --test apps/web/test/route-css.test.mjs`.
- [ ] **Step 5: Screenshots** of open (clear and keep), refused, done, invalid, the public notice and the dashboard steps, at 390 and 1440; commit `feat(web): confirm a reset and set the page up again`.

### Task 17: End to end (PR E)

**Files:**

- Create: `tests/e2e/account-reset.spec.ts` (helpers from `ops-helpers.ts`: `enrolOwner`, `codeFor`, `sql`; read the token as `emailedEnrolmentCode` reads codes, from the `account_reset_confirm` mail)

**Interfaces:**

- Consumes: Tasks 14–16. A never-used account is seeded by SQL as a `bachs` sandbox `ONBOARDING` row with reference `acct_e2e_<identity>` (R3), so the card shows the clear line and the archive row can be checked.

- [ ] **Step 1: Write the tests** (phone and desktop projects):
  - `staff start a reset and see the pending card`: owner finds the page, sends the link with a reason and code → the card shows "Reset link sent to …" and "never used, so it's cleared too".
  - `the person confirms and starts again`: opens the emailed link signed in → sees both lists → **Reset my page** → done → Set up your page → dashboard "Your page isn't set up yet" with "Change your username (free, once)"; the public page shows "@handle isn't set up yet"; the archive has the seeded account.
  - `signed out, the link survives sign-in`: open signed out → sign in → the open state.
  - `decline`, `expired` (seed `expires_at` in the past by SQL), and `a refused confirm` (seed a `REQUESTED` payout) → its words, and the ops card shows "A withdrawal is on its way".
  - `expectAccessible(page)` on each state.
- [ ] **Step 2: Run on your lane (after the `pg_stat_activity` check), expect PASS** with `--repeat-each=5 --retries=0 --workers=2`.
- [ ] **Step 3: Commit** `test(e2e): account reset`.

### Task 18: Threat model and release checks (PR E)

**Files:**

- Modify: `docs/security/threat-model.md` (P6 row; new row A13)

- [ ] **Step 1: Update** P6 with §9's sentence and add to its evidence column `packages/database/test/integration/page-erase.test.mjs`, `account-reset.test.mjs`, `tests/integration/account-reset-api.test.mjs`. Add **A13 "A staff member wipes or redirects someone's page"** with §9's mitigations and residual risk, evidence the account-reset, -guard, -used, -archive and -races files and `tests/e2e/account-reset.spec.ts`.
- [ ] **Step 2: Run** `pnpm format:check` and the whole gate, then `pnpm test:integration` (after the `pg_stat_activity` check). Expected: exit 0, `# fail 0`.
- [ ] **Step 3: Commit** `docs(security): account reset in the threat model`.
- [ ] **Step 4: Release notes for the owner** (in the PR body, not code): no switch and no env value; nobody but Owner holds `accounts.reset` until granted (`staff.grant_sensitive`); the migration is additive; nothing is backfilled.
