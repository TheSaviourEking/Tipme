# Username Reservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff holding `usernames.manage` reserve and release usernames from `/ops` instantly, and take a username back from a page through the serious-action flow. After that the system keeps the terms' promise without anyone having to remember: notice by email or a seen dashboard banner, a reminder, the deadline, a new username assigned automatically, the emails, and the 14-day never-reached path.

**Architecture:** A canonical key (`reservationKey`, domain) indexes two new tables, `handle_reservations` and `handle_take_backs`. A database trigger stops any profile or alias from taking a reserved name, using the same per-handle advisory lock as `0028`. The application check sits on top, in `isTaken` and `checkHandle`. A take-back is one serious action (`username.take_back`) whose `run` creates the take-back row and queues the notice. One worker job, `usernames.take-backs`, moves rows from approved to noticed to done, driven by the database. One completion function is shared by the user's choice, the deadline, page deletion and the no-notice path.

**Tech Stack:** Drizzle and Postgres migrations, `@tipme/domain`, `@tipme/contracts`, `@tipme/database` operations, NestJS controllers (`apps/api/src/ops`, `apps/api/src/profiles`), BullMQ worker (`apps/worker`), `@tipme/mail` templates, Next.js client pages (`apps/web/src/app/ops`, `apps/web/src/app/dashboard`), `node:test` unit and integration tests, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-03-username-reservation-design.md`. Section 12 ("The owner's answers, 3 Nov 2026") wins over anything above it, and this plan follows it wherever the two differ:

- the clock starts at the earlier of the notice email being sent and the banner being seen (`banner_seen_at`);
- after 14 days with neither, the take-back goes ahead (the never-reached path);
- the email and the banner carry the category's fixed wording only, with no staff free text;
- the user gets one free change within 30 days of an assigned username.

## Commands used below

- **Unit, package `<pkg>`:** `pnpm --filter <pkg> build && pnpm --filter <pkg> test`
- **One integration file, run serially on the shared `tipme_test` database:** `pnpm turbo run build --filter='!@tipme/web' && node --import ./packages/observability/dist/register.js --test <file>`. This is called **IT `<file>`** below.
- **The whole integration suite:** `node scripts/test-integration.mjs`, after the build above. Don't run it while another job holds the test ports and database.
- **e2e:** `pnpm test:e2e -- tests/e2e/<file>.spec.ts`
- **After a route change:** `pnpm api:openapi`, then commit the regenerated document.
- **Before each PR:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`

## Global Constraints

- **Additive migrations only. Production runs on Aiven Postgres.**
  - No column is dropped or rewritten.
  - Check constraints are widened by drop and re-add, as `0064` did.
  - `issues_kind` is re-added `NOT VALID`, then `VALIDATE`d in the same migration file after the swap.
  - Take the next free migration number when each one is written. `0071` is free on `dev` today, but other branches, such as live-updates, may land first.
- **No provider name in anything a user sees.** If a provider ever has to be mentioned, it is "our payment partner". `apps/web/test/no-provider-names.test.mjs` must stay green.
- **Copy:**
  - sentence case;
  - no em dashes in any subject, body, label or banner;
  - dates in Lagos time, written out ("10 November 2026").
  - Copy text verbatim from the spec where it fixes the words. The house apostrophe (’) may replace `'`.
- **Reduced motion:** the banner and the Usernames screen add no motion that isn't removed under `prefers-reduced-motion: reduce`.
- **Forced colours:** every state (banner, state words, buttons) stays legible under `forced-colors: active`. Meaning is carried by text, never by colour alone.
- **UI** follows `docs/design/DESIGN-CONSTITUTION.md`. Use the existing ops patterns: `Card className="settings-section"`, `ReasonAction`, `opsAct`, `refusalWords`, `when`/`age`.
- **The server always decides:**
  - every new ops route carries `@OpsPermission('usernames.manage')` and `@FreshCode()`;
  - every new ops route that changes something (an ask) carries `@RateLimit('ops_request')`; the read routes (`GET /v1/ops/usernames` and `GET /v1/ops/usernames/check/:name`) carry `@RateLimit('ops_read')` instead, a per-person bucket set by `RATE_LIMIT_OPS_READ_PER_HOUR` (default 600). Ruling of 5 Nov 2026 (PR 1 review, I2): reads must never use up the `ops_request` asks, such as fee and staff changes, that the same person needs;
  - none is added to `OPS_FRESH_CODE_EXEMPT` or `OPS_ANY_STAFF_ROUTES`.
- **Money is never touched.** Nothing here reads or writes tips, quotes, balances, payouts, payment accounts or the plan, except read-only "has a balance" and "withdrawal in flight" flags.
- **The user never learns** who asked or approved, or reads the internal reason. The public can't tell a staff reservation from a built-in one.
- **Lock order everywhere:**
  - staff-admin lock (only where the caller already takes it);
  - then the profile row;
  - then the take-back row.
- **Nothing here approves anything in `docs/00-DECISIONS.md`.**

## Review Focus

1. **A name that differs only by case or `-`/`_`.** `MTN`/`mtn`, `how-it-works`/`how_it_works`, `Kemi_NG`/`kemi_ng`:
   - are one reservation;
   - built-in words are refused as staff reservations;
   - `isReservedHandle` is unchanged.

   _Test:_ Task 1 (`reservationKey` unit tests) and Task 3 (`a second reservation differing by case or hyphen is refused and shown the first`).

2. **Racing writers at the same moment.** Reserve against claim, reserve against rename, two reservations of one name, and an older release inserting a profile or alias on a reserved name: one wins, and the database refuses the rest with `unique_violation`.

   _Test:_ Task 1 (`the trigger refuses a claim and an alias on a reserved name`) and Task 3 (`reserve against claim at once: exactly one wins`).

3. **The notice clock.** It must start only from a sent email or a banner seen in a visible tab. It must never start from a queued-but-unsent email, a hidden tab's refetch, or approval itself. With neither, the 14-day path still runs.

   _Test:_
   - Task 7 (`a queued email that never sends leaves the row approved`);
   - Task 8 (`seen is recorded once, and only the first time starts the clock`);
   - Task 10 (`never reached for 14 days: completed as unreached and recorded`).

4. **Sweep against user choice against cancel against deletion.** Each locks the profile, then the take-back row. The second sees the new state and stops: there is one outcome, one done email and no deadlock.

   _Test:_ Task 10 (`cancel racing the deadline sweep: one outcome`, `user choice racing the sweep: one outcome`).

5. **A page left without a working username, or keeping a taken one.** Completion never writes an alias for the taken name.

   Switching back to an old username that is under an open `old` take-back is refused.

   A Free page in take-back mode can choose a name, and the choice is not counted. The generated `page_xxxxxx` is never built-in, reserved or taken.

   _Test:_ Task 9 (`switching back to an old username under take-back is refused`, `no alias is written for the taken name`) and Task 10 (`the generated username retries on collision`).

## PR boundaries

The spec (section 11) asks for these PRs.

| PR                       | Tasks   | Ships                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR 1: Reservations**   | 1 to 4  | Reserved names are refused at sign-up and rename; staff reserve and release from `/ops/usernames`. Safe to ship alone.                                                                                                                                                                                                     |
| **PR 2: Take-backs**     | 5 to 13 | Take-backs with notice of 1 to 30 days, emails, banner, seen-time, user choice, worker, never-reached path, free change, Pages card, search, docs. **Do not deploy PR 2 to production before the terms' "Your username" section is on `main`.** On `dev` it is already present in `apps/web/src/app/legal/terms/page.tsx`. |
| **PR 3: Without notice** | 14      | `notice_days = 0` for impersonation, trademark and legal. Optional split, per section 11.3. Until it lands, `validate` refuses 0.                                                                                                                                                                                          |

The free change after an assignment stays in PR 2, not PR 3. Without it, PR 2 would leave a Free page stuck with `page_xxxxxx`, against owner answer 4.

---

## PR 1: Reservations

### Task 1: The canonical key, the reservations table and the database guard

**Files:**

- Modify:
  - `packages/domain/src/handles.ts`: add `reservationKey`;
  - `packages/database/src/schema.ts`: add the `handleReservations` table.
- Create: migration `packages/database/drizzle/00NN_handle_reservations.sql`, plus its snapshot and journal entry from `pnpm --filter @tipme/database generate`. Append the trigger SQL by hand, as `0028` did.
- Test:
  - `packages/domain/test/handles.test.mjs`;
  - new `tests/integration/username-reservations.test.mjs` (trigger part);
  - `packages/database/test/integration/migration-journal.test.mjs` (unchanged; it must pass).

**Interfaces:**

- Produces `reservationKey(raw: string): string | null`. It trims, lower-cases, replaces `-` with `_`, then applies `normaliseHandle`.
- Produces the table `handle_reservations`:
  - `id uuid PK`;
  - `handle_lower text NOT NULL`;
  - `source text NOT NULL CHECK (source IN ('staff','take_back'))`;
  - `take_back_id uuid NULL`. There is no FK yet: the table it points to arrives in Task 5, which adds the FK `NOT VALID` and then validates it;
  - `reason text NOT NULL`;
  - `reserved_by uuid NULL REFERENCES users`;
  - `reserved_at timestamptz NOT NULL`;
  - `released_at`, `released_by`, `release_reason`, all nullable;
  - partial unique index `handle_reservations_active` on `(handle_lower) WHERE released_at IS NULL`;
  - check `released_at IS NULL OR (released_by IS NOT NULL AND release_reason IS NOT NULL)`.
- Produces the Drizzle export `handleReservations` from `schema.ts`.
- Produces the triggers. Each takes `pg_advisory_xact_lock(hashtext('tipme.handle:' || NEW.handle_lower))` first:
  - `tipme_profile_handle_not_reserved` on `profiles BEFORE INSERT OR UPDATE OF handle_lower`;
  - `tipme_alias_handle_not_reserved` on `handle_aliases BEFORE INSERT OR UPDATE`.

  Both raise `unique_violation` when an active reservation holds `NEW.handle_lower`.

- Also produces `tipme_reservation_not_held` on `handle_reservations BEFORE INSERT`. It raises `unique_violation` when a profile or alias holds the name.

  A take-back completion moves the page first and writes the reservation after, so it needs no exception flag.

- [ ] **Step 1: Write the failing tests**

  ```js
  // packages/domain/test/handles.test.mjs
  test('reservationKey folds case and hyphens into one key', ...);
  // 'MTN', 'mtn', ' Mtn ' -> 'mtn'; 'how-it-works' -> 'how_it_works'; 'Kemi_NG' -> 'kemi_ng'
  test('reservationKey refuses what can never be a handle', ...);   // 'ab', 'a'.repeat(31), 'kemi!', '' -> null
  test('isReservedHandle is unchanged', ...);                       // 'admin', 'pro', 'how-it-works' true; 'kemi' false

  // tests/integration/username-reservations.test.mjs
  test('the trigger refuses a claim on a reserved name', ...);      // raw INSERT INTO profiles ... -> 23505
  test('the trigger refuses a rename onto a reserved name', ...);   // raw UPDATE profiles SET handle_lower -> 23505
  test('the trigger refuses an alias insert on a reserved name', ...);
  test('a reservation is refused while a page or an old username holds the name', ...); // 23505 both
  test('a released reservation no longer blocks a claim', ...);
  test('two active reservations of one key cannot exist', ...);     // partial unique index
  ```

- [ ] **Step 2: Run.** `pnpm --filter @tipme/domain build && pnpm --filter @tipme/domain test` and IT `tests/integration/username-reservations.test.mjs`. Expected: FAIL (`reservationKey` is not exported; the relation does not exist).
- [ ] **Step 3: Implement.**
  - Add `reservationKey` next to `normaliseHandle`, with a comment that it matches `isReservedHandle`'s folding.
  - Add the table to `schema.ts` and run `pnpm --filter @tipme/database generate`.
  - Append the three functions and triggers in the `0028` style, separated by `--> statement-breakpoint`. Write a header comment saying why the guard exists: an older release after a rollback must not hand out a reserved name.
- [ ] **Step 4: Run** the same commands, plus IT `packages/database/test/integration/migration-journal.test.mjs` and IT `tests/integration/handle-renames.test.mjs`. The renames file proves `0028` still behaves. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(handles): canonical reservation key, reservations table and database guard`

### Task 2: Reserved names block sign-up and handle changes

**Files:**

- Modify:
  - `packages/database/src/operations/profiles.ts`: `checkHandle`, `isTaken`, `claimHandle`, `renameHandle`;
  - new helper `activeReservation`.
- Test:
  - `tests/integration/handle-rule.test.mjs`;
  - `packages/database/test/integration/profiles.test.mjs`.

**Interfaces:**

- Produces `activeReservation(db: Database | Tx, key: string): Promise<{ id: string } | null>`, exported for Task 3.
- `isTaken` gains a fourth lookup: an active reservation for the name. `claimHandle` and `renameHandle` therefore refuse it with the existing `HANDLE_TAKEN`.
- `checkHandle` returns `'reserved'` for a staff reservation, before the `isTaken` lookup, just as it does for a built-in word.
- The `HandleStatus` contract is unchanged.

- [ ] **Step 1: Write the failing tests**

  ```js
  // packages/database/test/integration/profiles.test.mjs
  test('checkHandle says reserved for a staff reservation, as for a built-in word', ...);
  // insert an active row for 'mtn'; checkHandle('MTN') === 'reserved'; after release === 'available'

  // tests/integration/handle-rule.test.mjs
  test('a reserved name is refused at claim', ...);   // POST claim 'mtn' -> 409 HANDLE_TAKEN
  test('a reserved name is refused at rename', ...);  // Pro page PUT /v1/me/handle 'mtn' -> 409; count unchanged
  test('the availability route answers reserved, never which list', ...); // body is { status: 'reserved' } only
  ```

- [ ] **Step 2: Run** IT on both files. Expected: FAIL (`available` returned).
- [ ] **Step 3: Implement.**
  - Add `activeReservation` (`released_at IS NULL`).
  - In `checkHandle`, after `isReservedHandle`, return `'reserved'` when `activeReservation` finds the name.
  - In `isTaken`, add the reservation lookup.
  - Leave the short-link router (`apps/web/src/lib/handle-redirect.ts`) unchanged.
- [ ] **Step 4: Run** IT on both files, IT `tests/integration/handle-renames.test.mjs`, and `pnpm --filter @tipme/web test` (`short-links.test.mjs` unchanged). Expected: PASS.
- [ ] **Step 5: Commit.** `feat(handles): staff reservations block sign-up and handle changes`

### Task 3: The permission, and the reserve, release and check API

**Files:**

- Modify:
  - `packages/contracts/src/ops-catalogue.ts`: `OPS_PERMISSIONS` and `OPS_CATALOGUE`;
  - `packages/contracts/src/index.ts`;
  - `packages/database/src/operations/errors.ts`: new codes;
  - `apps/api/src/http/api-exception.filter.ts`: map the new codes;
  - `apps/api/src/ops/ops.module.ts`;
  - `docs/runbooks/admin-roles.md`: "Every permission, in plain words" gains `usernames.manage`. `packages/contracts/test/ops-catalogue.test.mjs` fails otherwise, so this cannot wait for PR 2.
- Create:
  - `packages/contracts/src/usernames.ts`;
  - `packages/database/src/operations/username-reservations.ts`, exported from `packages/database/src/index.ts`;
  - `apps/api/src/ops/usernames.controller.ts`;
  - migration `00NN_usernames_permission.sql`: widen `role_permissions_known` and `staff_permission_overrides_known`, then grant to `owner` exactly as the end of `0064` does.
- Test:
  - `packages/contracts/test/ops-catalogue.test.mjs`;
  - `tests/integration/ops-catalogue.test.mjs`;
  - `tests/integration/ops-access.test.mjs`;
  - `tests/integration/ops-serious-routes.test.mjs` (route list);
  - `tests/integration/username-reservations.test.mjs`.

**Interfaces:**

- The catalogue entry: `'usernames.manage': { description: 'Reserve and release usernames, and ask to take one back from a page', group: 'people', sensitive: true }`.
- `packages/contracts/src/usernames.ts` produces:

  ```ts
  export const opsUsernameReserveSchema = z
    .object({ name: z.string().min(1).max(40), reason: z.string() })
    .strict();
  export type OpsUsernameReserveRequest = z.infer<
    typeof opsUsernameReserveSchema
  >;
  // release body: the existing opsReasonSchema / OpsReasonRequest
  export const opsUsernamesQuerySchema = z
    .object({
      q: z.string().max(30).optional(),
      state: z.enum(['staff', 'take_back']).optional(),
    })
    .strict();
  export interface OpsReservation {
    id: string;
    name: string;
    source: 'staff' | 'take_back';
    reason: string;
    reservedBy: string | null; // masked staff email, null when the system completed a take-back
    reservedAt: string;
    takeBackId: string | null;
  }
  export type OpsUsernameCheck =
    | { name: string; state: 'invalid' }
    | { name: string; state: 'built_in' }
    | { name: string; state: 'free'; heldUntil: string | null } // heldUntil: a 90-day deletion hold
    | { name: string; state: 'reserved'; reservation: OpsReservation }
    | { name: string; state: 'page'; kind: 'current' | 'old'; page: OpsPage }; // Task 7 adds facts and the open take-back
  export interface OpsUsernamesList {
    reservations: OpsReservation[];
    builtIn: readonly string[];
  } // Task 7 adds takeBacks, pending
  ```

- `username-reservations.ts` produces:
  - `reserveUsername(db: Database, input: { staffId: string; name: string; reason: string; now?: Date }): Promise<OpsReservation>`;
  - `releaseUsername(db: Database, input: { staffId: string; name: string; reason: string; now?: Date }): Promise<{ name: string }>`;
  - `checkUsername(db: Database, raw: string, now?: Date): Promise<OpsUsernameCheck>`;
  - `listUsernames(db: Database, input: { q?: string; state?: 'staff' | 'take_back' }): Promise<OpsUsernamesList>`.
- New `OperationErrorCode`s:
  - `USERNAME_BUILT_IN` → 409;
  - `USERNAME_RESERVED` → 409, `detail` the existing row id;
  - `USERNAME_HELD_BY_PAGE` → 409;
  - `USERNAME_NOT_RESERVED` → 404.
- Audit entries:
  - `username.reserved` and `username.released`;
  - permission `usernames.manage`, `subjectType: 'username'`, `subjectId` the key;
  - the reason goes through `checkedReason`;
  - a release of a take-back reservation adds `withAuditChange(reason, { takeBackId })`.
- Routes on `OpsUsernamesController`, `@Controller('v1/ops/usernames')`:

  | Route                              | Answers               |
  | ---------------------------------- | --------------------- |
  | `GET /`                            | `OpsUsernamesList`    |
  | `GET /check/:name`                 | `OpsUsernameCheck`    |
  | `POST /` `{ name, reason }`        | `OpsReservation`, 201 |
  | `POST /:name/release` `{ reason }` | `{ name }`            |

- [ ] **Step 1: Write the failing tests**

  ```js
  // packages/contracts/test/ops-catalogue.test.mjs
  // add 'usernames.manage' to the sensitive list; assert OPS_CATALOGUE['usernames.manage'].group === 'people'
  // the runbook test already requires `usernames.manage` in docs/runbooks/admin-roles.md

  // tests/integration/username-reservations.test.mjs
  test('reserve, then sign-up refuses it, then release frees it', ...);
  test('a built-in name is refused with USERNAME_BUILT_IN, and can never be released', ...); // 'admin', 'pro'
  test('a second reservation differing by case or hyphen is refused and shown the first', ...);
  // reserve 'how_it_works2'... then 'HOW-IT-WORKS2' -> 409 USERNAME_RESERVED, detail is the first id
  test('a name a page holds, as its username or an old one, is refused with USERNAME_HELD_BY_PAGE', ...);
  test('a name in a 90-day deletion hold can be reserved, and check shows heldUntil', ...);
  test('two reservations of one name at once: one wins, the other is told it is reserved', ...);
  test('reserve against claim at once: exactly one wins', ...);   // Promise.all; exactly one fulfilled
  test('reserve and release are audited with the reason and the key', ...);
  test('check names a page by public-level fields only', ...);    // no email, phone or balance in the body

  // tests/integration/ops-access.test.mjs
  test('a custom role without usernames.manage gets 403 on every usernames route; with it, success', ...);
  test('every usernames route asks for a fresh code', ...);       // stale code -> FRESH_CODE_REQUIRED

  // tests/integration/ops-catalogue.test.mjs
  test('owner holds usernames.manage after migrating; release_check does not', ...);
  ```

- [ ] **Step 2: Run.** `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`, then IT on each integration file. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Write the catalogue entry, then the migration. Generate it, then add `INSERT INTO "role_permissions" ... unnest(ARRAY['usernames.manage']) ... WHERE "id" = 'owner' ON CONFLICT DO NOTHING`.
  - `reserveUsername` works in one transaction:
    1. `pg_advisory_xact_lock(hashtext('tipme.handle:' || key))`;
    2. refuse a built-in name, then an active reservation, then a profile or alias that holds the name;
    3. insert the row and audit it.

    If the insert hits `23505`, re-read the winner and throw `USERNAME_RESERVED` (or `USERNAME_HELD_BY_PAGE`).

  - `releaseUsername` updates the active row's `released_*` columns. With no active row it throws `USERNAME_NOT_RESERVED`. A built-in name throws `USERNAME_BUILT_IN` before any lookup.
  - `checkUsername` reuses `opsPageByHandle` for the page case. `kind` is `current` when `profiles.handle_lower` matches, otherwise `old`.
  - Mask staff emails with `maskEmail`, as on the Overview.
- [ ] **Step 4: Run** the same commands, then `pnpm api:openapi`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(ops): usernames.manage, and the reserve, release and check routes`

### Task 4: The admin "Usernames" screen

**Files:**

- Create: `apps/web/src/app/ops/usernames/page.tsx`.
- Modify:
  - `apps/web/src/lib/ops-menu.ts`: add `{ href: '/ops/usernames', label: 'Usernames', needs: ['usernames.manage'] }` right after Pages;
  - `apps/web/src/lib/ops-answers.ts`: `refusalWords` for the four new codes.
- Test:
  - `apps/web/test/ops-menu.test.mjs`;
  - `apps/web/test/ops-answers.test.mjs`;
  - new `tests/e2e/ops-usernames.spec.ts` (reserve and release part);
  - `tests/e2e/ops-staff.spec.ts`.

**Interfaces:**

- The page consumes `OpsUsernameCheck`, `OpsUsernamesList` and `OpsReservation` from Task 3.
- `refusalWords` gains:
  - `USERNAME_BUILT_IN`: "TipMe's own list already reserves this";
  - `USERNAME_RESERVED`: "This username is already reserved";
  - `USERNAME_HELD_BY_PAGE`: "This is @{handle}'s username. To take it, ask to take it back.";
  - `USERNAME_NOT_RESERVED`: "This username isn't reserved".

- [ ] **Step 1: Write the failing tests**

  ```js
  // apps/web/test/ops-menu.test.mjs
  test('Usernames appears only with usernames.manage, right after Pages', ...);
  // apps/web/test/ops-answers.test.mjs
  test('each username refusal has plain words, with no em dash', ...);
  ```

  ```ts
  // tests/e2e/ops-usernames.spec.ts
  test('staff reserve a name, sign-up refuses it, and staff release it', ...);
  // Check 'mtnx' -> "Reserve" with a reason -> "Reserved"; sign-up availability says not available; Release -> free
  test('a built-in name shows no Reserve or Release, and the built-in list is folded by default', ...);
  // tests/e2e/ops-staff.spec.ts
  test('someone without usernames.manage sees no Usernames link', ...);
  ```

- [ ] **Step 2: Run.** `pnpm --filter @tipme/web test`, then `pnpm test:e2e -- tests/e2e/ops-usernames.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The page has three `Card className="settings-section"` sections.
  1. **Check a name:** one field and a Check button. The answer shows the one action that fits: Reserve through `ReasonAction`, Release, or nothing for a built-in name. Take back arrives in Task 12.
  2. **Reserved:** name, reserved by, when (`when`/`age`), reason, source in words ("Staff" or "Take-back"), and Release. It has a name-prefix search and a staff/take-back filter, with the table layout from Approvals.
  3. **TipMe's own list:** read-only, inside `<details>`, closed by default.

  Every action goes through `opsAct`. Nothing animates beyond the existing ops styles. State words are text, so they hold up in forced colours.

- [ ] **Step 4: Run** the same commands and `pnpm test:e2e -- tests/e2e/ops-staff.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(ops): the Usernames screen for reserving and releasing`

**PR 1 ends here.**

- Run the pre-PR checks, `node scripts/test-integration.mjs`, and the three e2e files.
- Open PR 1: "Staff reserve usernames".
- The only user-facing change is that reserved names are refused.

---

## PR 2: Take-backs

### Task 5: The take-back data model, issue kinds and shared words

**Files:**

- Modify:
  - `packages/database/src/schema.ts`: add `handleTakeBacks`;
  - `packages/contracts/src/ops.ts`: `ISSUE_KINDS` gains `username_take_back_unnoticed` and `username_take_back_overdue`;
  - `packages/contracts/src/usernames.ts`;
  - `packages/domain/src/handles.ts`, or a new `packages/domain/src/take-back.ts` exported from the domain index;
  - `packages/database/src/operations/issues.ts`: `SEVERITY`, both `'account'`, and `summaryOf`;
  - `apps/web/src/lib/ops-client.ts`: the issue kind words.
- Create: migration `00NN_handle_take_backs.sql`. It holds:
  - the table;
  - the FK `handle_reservations.take_back_id → handle_take_backs(id)` added `NOT VALID` and then `VALIDATE`d;
  - the `issues_kind` swap: drop, add `NOT VALID`, then `VALIDATE CONSTRAINT`.
- Test:
  - `packages/domain/test/handles.test.mjs` (or `take-back.test.mjs`);
  - `packages/database/test/integration/migration-journal.test.mjs`;
  - `packages/database/test/integration/issues.test.mjs`.

**Interfaces:**

- The table `handle_take_backs`:
  - `id uuid PK`;
  - `approval_request_id uuid NULL REFERENCES approval_requests`;
  - `profile_id uuid NOT NULL REFERENCES profiles`;
  - `handle_lower text NOT NULL`;
  - `kind text CHECK IN ('current','old')`;
  - `category text CHECK IN ('ordinary','impersonation','trademark','legal')`;
  - `notice_days int`, with `CHECK ((category = 'ordinary' AND notice_days BETWEEN 7 AND 30) OR (category <> 'ordinary' AND notice_days BETWEEN 0 AND 7))`;
  - `reason text NOT NULL`;
  - `state text CHECK IN ('approved','noticed','due','done','cancelled')`;
  - `requested_by uuid NOT NULL`, `approved_by uuid NULL`;
  - `approved_at timestamptz NOT NULL`;
  - `noticed_at`, `noticed_via text NULL CHECK IN ('email','banner','unreached')`, `banner_seen_at`, `due_at`, `reminded_at`, `done_at`, `cancelled_at`;
  - `notice_mail_id uuid NULL REFERENCES mail_messages`;
  - `outcome text NULL CHECK IN ('user_chose','assigned','page_deleted','old_removed')`;
  - `new_handle text NULL`;
  - `cancelled_by uuid NULL`, `cancel_reason text NULL`;
  - `free_change_until timestamptz NULL`, `free_change_used_at timestamptz NULL`;
  - partial unique index `handle_take_backs_open` on `(handle_lower) WHERE state IN ('approved','noticed','due')`;
  - index `(profile_id) WHERE state IN ('approved','noticed','due')`;
  - index `(state, due_at)`.

  There is **no `message_to_user` column**: owner answer 3 says no staff free text reaches the user.

- Contracts produce:

  ```ts
  export const TAKE_BACK_CATEGORIES = [
    'ordinary',
    'impersonation',
    'trademark',
    'legal',
  ] as const;
  export type TakeBackCategory = (typeof TAKE_BACK_CATEGORIES)[number];
  export type TakeBackKind = 'current' | 'old';
  export type TakeBackState =
    'approved' | 'noticed' | 'due' | 'done' | 'cancelled';
  export type TakeBackOutcome =
    'user_chose' | 'assigned' | 'page_deleted' | 'old_removed';
  export type TakeBackNoticedVia = 'email' | 'banner' | 'unreached';
  /** The fixed "why" per category (owner answer 3). Shown to the user verbatim; never staff text. */
  export const TAKE_BACK_WHY: Record<TakeBackCategory, string> = {
    ordinary:
      'We need it to protect a brand, a public figure or one of our own names.',
    impersonation: 'The username impersonates someone.',
    trademark: 'The username infringes a trademark.',
    legal: 'The law requires us to change it.',
  };
  export const TAKE_BACK_CATEGORY_WORDS: Record<TakeBackCategory, string> = {
    ordinary: 'Ordinary',
    impersonation: 'Impersonation',
    trademark: 'Trademark',
    legal: 'Required by law',
  };
  export const TAKE_BACK_NEVER_REACHED_MS = 14 * 86_400_000;
  export const TAKE_BACK_FREE_CHANGE_MS = 30 * 86_400_000;
  export const TAKE_BACK_REMINDER_MS = 2 * 86_400_000; // only when notice_days >= 4
  ```

- Domain produces:
  - `takeBackDueAt(noticedAt: Date, noticeDays: number): Date`: the end of the Lagos calendar day `noticeDays` days after `noticedAt`'s Lagos date. That is 23:59:59.999 Africa/Lagos, which is 22:59:59.999 UTC;
  - `lagosDateWords(at: Date): string`, for example "10 November 2026".
- Issue summaries:
  - `username_take_back_unnoticed`: "A username take-back for @{handle} was approved 24 hours ago, but the notice hasn't reached them by email or on their dashboard. It goes ahead after 14 days if it never does. Cancel it under Usernames if needed.";
  - `username_take_back_overdue`: "A username take-back for @{handle} is more than an hour past its deadline and hasn't completed. The worker retries every minute."

- [ ] **Step 1: Write the failing tests**

  ```js
  test('takeBackDueAt is the end of the Lagos day, notice_days later', ...);
  // noticedAt 2026-11-03T10:00Z, 7 -> 2026-11-10T22:59:59.999Z; noticedAt 2026-11-03T23:30Z (00:30 Lagos 4 Nov), 7 -> 2026-11-11T22:59:59.999Z
  test('there are always at least notice_days full days', ...);    // property over 48 hourly noticedAt values
  test('lagosDateWords writes the date out', ...);                 // '10 November 2026'
  test('TAKE_BACK_WHY has a sentence for every category, with no em dash', ...);
  // issues.test.mjs
  test('the two take-back issue kinds open with account severity and a handle-only summary', ...);
  ```

- [ ] **Step 2: Run** the domain and contracts unit tests, and IT on `issues.test.mjs` and `migration-journal.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Generate the migration, then hand-edit the `issues_kind` statement into the `NOT VALID` / `VALIDATE` form, with a comment that `issues` can be large.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(usernames): take-back table, issue kinds and fixed words`

### Task 6: The take-back emails

**Files:**

- Create: `packages/mail/src/templates/types/username-take-back.ts`.
- Modify:
  - `packages/mail/src/templates/registry.ts`;
  - `packages/database/src/operations/account-mail.ts`: `mailOwner` returns `Promise<{ id: string } | null>` (from `enqueueMail`) instead of `void`. Existing callers ignore the value.
- Test:
  - `packages/mail/test/templates.test.mjs`;
  - `packages/database/test/integration/mail-triggers.test.mjs` (the `mailOwner` return).

**Interfaces:**

- Every type is `category: 'account'`, `sender: 'notifications'`, `preference: null`, with a strict zod schema and a sample.
- The types:
  - `usernameTakeBackNotice`, id `username_take_back_notice`. Data: `{ kind: 'current' | 'old'; old: string; current: string; why: string; dueDate: string }`;
  - `usernameTakeBackReminder`, id `username_take_back_reminder`. Data: `{ old: string; dueDate: string }`;
  - `usernameTakeBackDone`, id `username_take_back_done`. Data: `{ variant: 'assigned' | 'user_chose' | 'old' | 'without_notice' | 'unreached'; old: string; new: string | null; current: string; why: string; noticeDate: string | null; freeChangeDate: string | null }`. `origin` comes from the mail context;
  - `usernameTakeBackCancelled`, id `username_take_back_cancelled`. Data: `{ old: string }`.
- The copy is verbatim from spec section 6, with `{why}` = `TAKE_BACK_WHY[category]` only:
  - **6.1 Notice, current.** Subject "We need your TipMe username back". Body: "TipMe needs the username @{old} back. {why} / Please choose a new username by the end of {due date}. You can do it in Settings, and it won't use up any of your username changes. / Your page, your tips and your balance stay yours under the new username. Links and QR codes that use @{old} will stop working, so update them once you have chosen. / If you haven't chosen by then, we will give your page a new username and email it to you. / Reply to this email if you have a question." The button is "Choose a new username", linking to `/dashboard/settings#handle`.
  - **6.1 Notice, old.** Subject "A link to your TipMe page will stop working". Body: "Your page keeps its username @{current}. Links and QR codes that still use your old username @{old} will stop working after {due date}. {why} Share your current link and print a new QR code if you need one."
  - **6.2 Reminder.** Subject "2 days left to choose a new TipMe username". Body: "This is a reminder that TipMe needs the username @{old} back. Please choose a new username in Settings by the end of {due date}. If you don't, we will give your page one and email it to you. Your page, tips and balance stay yours."
  - **6.3 Done, assigned.** Subject "Your TipMe page has a new username". Body: "As we said on {notice date}, TipMe has taken back @{old}. Your page is now at {origin}/@{new}. Your tips and balance haven't changed. Links and QR codes with @{old} no longer work, so share your new link and print a new QR code. You can change your new username once, for free, in Settings until {free change date}."
  - **6.3 Done, user chose.** Subject "Your new TipMe username is ready". Body: "Your page is now at {origin}/@{new}. The username @{old} is no longer yours, and links with it no longer work."
  - **6.3 Done, old.** Subject "An old link to your TipMe page has stopped working". Body: "Links and QR codes with @{old} no longer lead to your page. Your page is still at {origin}/@{current}."
  - **6.4 Done, without notice.** Subject "We changed your TipMe username". Body: "We have changed your page's username from @{old} to @{new}, without notice, as our terms allow in this case. {why} Your page, your tips and your balance are unchanged. Links and QR codes with @{old} no longer work. You can change your new username once, for free, in Settings until {free change date}. Reply to this email if you think this is a mistake."
  - **Done, unreached.** This variant is new: owner answer 2 needs it and the spec has no wording. The plan's wording, for the owner to check, is subject "Your TipMe page has a new username"; body "We couldn't reach you about the username @{old}, so, as our terms say, TipMe has taken it back. {why} Your page is now at {origin}/@{new}. Your tips and balance haven't changed. Links and QR codes with @{old} no longer work, so share your new link and print a new QR code. You can change your new username once, for free, in Settings until {free change date}."

    When `kind = old`, the unreached completion uses the "old" variant.

  - **6.5 Cancelled.** Subject "You can keep your TipMe username". Body: "We no longer need the username @{old}. It stays yours, and your links and QR codes keep working. You don't need to do anything."
- Each email's `reason` footer says: "You get this email when TipMe needs a username back. It can't be turned off."

- [ ] **Step 1: Write the failing tests**

  ```js
  test('each take-back type renders its sample and every variant', ...);
  test('no take-back subject or body has an em dash, and subjects are sentence case', ...);
  test('the notice carries the fixed why only', ...); // render with why = TAKE_BACK_WHY.trademark; no other free text field exists in the schema
  test('take-back emails cannot be turned off', ...);  // preference === null
  // mail-triggers.test.mjs
  test('mailOwner returns the queued id, and null for an account without a verified address', ...);
  ```

- [ ] **Step 2: Run.** `pnpm --filter @tipme/mail build && pnpm --filter @tipme/mail test`, then IT `packages/database/test/integration/mail-triggers.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** with `defineMailType` and `letter`, following `pagePaused`.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(mail): username take-back notice, reminder, done and cancelled emails`

### Task 7: The serious action, and the request, cancel and list routes

**Files:**

- Create: `packages/database/src/operations/username-take-backs.ts`.
- Modify:
  - `packages/contracts/src/ops-catalogue.ts`: `SERIOUS_ACTIONS`, `SERIOUS_ACTION_WORDS` and `SERIOUS_ACTION_PERMISSIONS`;
  - `packages/contracts/src/usernames.ts`;
  - `packages/database/src/operations/serious-actions-registered.ts`;
  - `packages/database/src/operations/username-reservations.ts`: `checkUsername` and `listUsernames` gain take-back fields;
  - `packages/database/src/operations/errors.ts`;
  - `apps/api/src/http/api-exception.filter.ts`;
  - `apps/api/src/ops/usernames.controller.ts`;
  - `apps/api/src/ops/approvals.controller.ts`: also revalidate `revalidateHandles: string[]`;
  - `packages/database/src/operations/audit.ts`.
- Test:
  - `packages/contracts/test/ops-catalogue.test.mjs` ("the agreed eleven");
  - `tests/integration/ops-serious-actions.test.mjs`;
  - `tests/integration/ops-serious-gating.test.mjs`;
  - `tests/integration/ops-serious-routes.test.mjs`;
  - new `tests/integration/username-take-backs.test.mjs`.

**Interfaces:**

- The catalogue: `'username.take_back'`, with words "Take a username back from a page" and permission `'usernames.manage'`.
- Contracts add:

  ```ts
  export const opsTakeBackRequestSchema = z
    .object({
      profileId: z.uuid(),
      category: z.enum(TAKE_BACK_CATEGORIES),
      noticeDays: z.number().int().min(0).max(30),
      reason: z.string(),
    })
    .strict();
  export type OpsTakeBackRequest = z.infer<typeof opsTakeBackRequestSchema>;
  export interface OpsTakeBackFacts {
    plan: PagePlan;
    pageState: PageState;
    suspended: boolean;
    hasBalance: boolean;
    withdrawalInFlight: boolean;
    verifiedEmail: boolean;
    liveCheckoutListed: boolean; // the API fills liveCheckoutListed
  }
  export interface OpsTakeBack {
    id: string;
    name: string;
    profileId: string;
    pageHandle: string;
    plan: PagePlan;
    kind: TakeBackKind;
    category: TakeBackCategory;
    noticeDays: number;
    state: TakeBackState;
    requestedBy: string;
    approvedBy: string | null; // masked
    approvedAt: string;
    noticedAt: string | null;
    noticedVia: TakeBackNoticedVia | null;
    dueAt: string | null;
    doneAt: string | null;
    cancelledAt: string | null;
    outcome: TakeBackOutcome | null;
    newHandle: string | null;
  }
  export interface OpsTakeBackPending {
    requestId: string;
    name: string;
    profileId: string;
    requestedAt: string;
  }
  // OpsUsernameCheck 'page' gains: facts: OpsTakeBackFacts; openTakeBack: OpsTakeBack | null; pendingRequestId: string | null
  // OpsUsernamesList gains: takeBacks: OpsTakeBack[]; pending: OpsTakeBackPending[]
  ```

- The payload: `interface TakeBackPayload { profileId: string; name: string; kind: TakeBackKind; category: TakeBackCategory; noticeDays: number }`.
- `username-take-backs.ts` produces:
  - `startTakeBack(tx: Tx, payload: TakeBackPayload, ctx: { actorId: string; approverId: string | null; approvalRequestId: string | null; reason: string; now: Date; sealing: MailSealing }): Promise<{ takeBackId: string; revalidateHandles: string[] }>`;
  - `cancelTakeBack(db: Database, input: { staffId: string; takeBackId: string; reason: string; sealing: MailSealing; now?: Date }): Promise<OpsTakeBack>`;
  - `completeTakeBack(tx: Tx, input: { takeBackId: string; outcome: TakeBackOutcome; noticedVia?: TakeBackNoticedVia; chosenHandle?: string; withoutNotice?: boolean; sealing: MailSealing; now: Date; actorUserId: string | null }): Promise<{ old: string; current: string; newHandle: string | null }>`. This is the one completion; Tasks 9, 10 and 14 use it. The caller holds the profile lock.
  - `takeBackFacts(db: Database | Tx, profileId: string): Promise<Omit<OpsTakeBackFacts, 'liveCheckoutListed'>>`.
- The serious action `username.take_back`, registered directly. It doesn't use `acting`, because `validate` must not dry-run the mail.
  - `validate` refuses with these codes:
    - `INVALID_INPUT` when the key is invalid;
    - `USERNAME_BUILT_IN` when the name is built-in;
    - `NO_PAGE` when the page is missing or deleted;
    - `INVALID_INPUT` when the page is a release-check page (`rehearsal_run_id` not null);
    - `USERNAME_HELD_BY_PAGE` when the page doesn't hold the name as `payload.kind`;
    - `TAKE_BACK_OPEN` when the name already has an open take-back;
    - `INVALID_INPUT` when `noticeDays` doesn't fit the category, or is 0 before Task 14.
  - `subjects`: `pageOwner(db, profileId)`.
  - `target`: `` `${profileId}:${name}` ``.
  - `current`: `{ profileId, kind }`, as it is now.
  - `describe`: `` `Take @${name} back from its page: ${category words lower-cased}, ${noticeDays} days' notice` ``. With 0 it says "no notice".
  - `run` locks the profile row (`FOR UPDATE`), calls `startTakeBack`, and returns `{ takeBackId, revalidateHandles }`.
- `startTakeBack` does the work:
  1. inserts the row with `state = 'approved'` and `approved_at = now`;
  2. queues the notice through `mailOwner` with dedupe key `username_take_back_notice.{id}`. `dueDate` is `lagosDateWords(takeBackDueAt(now, noticeDays))`: the earliest the deadline can be, because noticing can only happen at or after approval. It stores `notice_mail_id` from the returned id, or null when there is no verified address;
  3. audits `username.take_back_started` with `withAuditChange(reason, { requestedBy, approvedBy, category, noticeDays, kind, profileId })`.

  A `23505` on the open index becomes `TAKE_BACK_OPEN`.

- New codes:
  - `TAKE_BACK_OPEN` → 409;
  - `TAKE_BACK_NOT_FOUND` → 404;
  - `TAKE_BACK_CLOSED` → 409, for cancelling a done or cancelled take-back.
- Routes:

  | Route                                                                                  | Does                                                                                                                                                                |
  | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `POST /v1/ops/usernames/:name/take-back` `{ profileId, category, noticeDays, reason }` | `requestSeriousAction('username.take_back')`. Answers `OpsSeriousPending`, or `{ takeBack: OpsTakeBack, actedAlone: true }` after revalidating `revalidateHandles`. |
  | `POST /v1/ops/usernames/take-backs/:id/cancel` `{ reason }`                            | Instant.                                                                                                                                                            |

  `GET /check/:name` sets `facts.liveCheckoutListed` from `API_CONFIG.LIVE_CHECKOUT_HANDLES`.

- `STAFF_ACTIVITY_ACTIONS` gains `username.take_back_started`, `username.take_back_done` and `username.released`.

- [ ] **Step 1: Write the failing tests**

  ```js
  // ops-catalogue.test.mjs
  test('the serious actions are the agreed eleven', ...);  // size 11; includes 'username.take_back'; its permission is usernames.manage
  // ops-serious-gating.test.mjs
  test('username.take_back waits when a second qualified person exists', ...);
  test('username.take_back runs alone, with the alert, when nobody else qualifies', ...);
  test("the page's owner can't approve a take-back of their own page", ...);   // APPROVAL_SUBJECT
  // ops-serious-routes.test.mjs
  test('the take-back route goes through requestSeriousAction', ...);
  // username-take-backs.test.mjs
  test('approval creates the row in approved, queues the notice once, and audits started', ...);
  test('a queued email that never sends leaves the row approved', ...);  // no noticed_at, no due_at
  test('no verified address: no email, notice_mail_id null, row approved', ...);
  test('a rename while waiting makes approval stale; the requester asks again', ...);
  test('a second take-back of the same name is refused', ...);           // TAKE_BACK_OPEN
  test('ordinary notice must be 7 to 30 days; others 1 to 7; 0 is refused until the no-notice path', ...);
  test('a release-check page and a built-in name are refused', ...);
  test('cancel before notice sends nothing; cancel after notice sends the cancelled email; done cannot be cancelled', ...);
  test('check shows facts as flags only: no amounts, no address', ...);  // hasBalance, withdrawalInFlight, verifiedEmail booleans
  test('the take-back money stays put', ...);  // balances, tips, payouts, plan and handle_changes_used unchanged after start and after done
  ```

- [ ] **Step 2: Run.** The contracts unit tests, then IT on each file. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces.
  - The approvals controller reads `revalidateHandles` as well as `revalidateHandle`, so both cached pages refresh after an approval that completes at once (Task 14).
  - The pending list comes from `approval_requests` where `action = 'username.take_back' AND status = 'pending'`, read through the stored payload.
- [ ] **Step 4: Run** the same commands and `pnpm api:openapi`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(usernames): take a username back through the serious-action flow`

### Task 8: The dashboard banner and the seen-time

**Files:**

- Modify:
  - `packages/contracts/src/profiles.ts`: `MyProfile`;
  - `packages/database/src/operations/profiles.ts`: `toMine`;
  - `packages/database/src/operations/username-take-backs.ts`;
  - `apps/api/src/profiles/me-profile.controller.ts`;
  - `apps/web/src/app/dashboard/home-view.tsx`.
- Create: `apps/web/src/components/dashboard/username-take-back-banner.tsx`.
- Test:
  - `tests/integration/username-take-backs.test.mjs`;
  - `tests/integration/profiles-api.test.mjs`;
  - new `apps/web/test/take-back-banner.test.mjs`, which tests the pure wording helper.

**Interfaces:**

- `MyProfile` gains `usernameTakeBack?: { id: string; handle: string; kind: TakeBackKind; dueAt: string; why: string; current: string } | null`.
  - It is optional, because the web deploys first.
  - The name matches what the live-updates spec expects, so it arrives with `profile.changed` later.
  - `dueAt` is the row's `due_at` once noticed. Before that it is `takeBackDueAt(now, notice_days)`: what seeing it now would set.
  - `why` is `TAKE_BACK_WHY[category]`.
  - It is present while the state is `approved`, `noticed` or `due`.
- Produces `markTakeBackSeen(db: Database, input: { userId: string; takeBackId: string; now?: Date }): Promise<MyProfile['usernameTakeBack']>`. It works under a profile lock, then a take-back lock:
  - it sets `banner_seen_at` only if it is null;
  - if `noticed_at` is null, it also sets `state = 'noticed'`, `noticed_at = now`, `noticed_via = 'banner'` and `due_at = takeBackDueAt(now, notice_days)`, then audits `username.take_back_noticed` (the user, `withAuditChange` `{ via: 'banner' }`).

  A second call changes nothing. An id that isn't the caller's page answers `TAKE_BACK_NOT_FOUND`.

- Route: `POST /v1/me/handle/take-back/:id/seen` returns `{ data: MyProfile }`.
- Produces the web helper `takeBackBannerWords(t: NonNullable<MyProfile['usernameTakeBack']>): { title: string; action: string | null }`:
  - `current`: "TipMe needs your username @{handle} back. Choose a new one by the end of {date}." with action "Choose a new username";
  - `old`: "Links that use your old username @{handle} will stop working after {date}. Your username @{current} stays." with no action.
  - In both, `why` is shown under the title.
- The banner component:
  - renders the `Notice` from `@tipme/ui` at the top of the dashboard home, linking to `/dashboard/settings#handle`;
  - calls `seen` only when `document.visibilityState === 'visible'` **and** an `IntersectionObserver` reports the banner on screen;
  - retries on `visibilitychange`;
  - calls once per mount, then updates `setProfile` with the answer.

  It has no animation. Under forced colours it keeps the system border from `Notice`.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('MyProfile carries the take-back while it is open, with the fixed why only', ...); // no reason, no staff, no requester
  test('seen is recorded once, and only the first time starts the clock', ...);
  // POST seen at t0 -> noticed_via 'banner', due_at = takeBackDueAt(t0, 7); POST again at t0+1h -> unchanged
  test('a sent email first, then the banner: the clock stays at the email', ...); // noticed_via 'email' kept; banner_seen_at set
  test('adding an email after the banner was seen changes nothing', ...);
  test("someone else's take-back id answers not found", ...);
  test('the banner words for current and old', ...);  // web unit, verbatim strings above; no em dash
  ```

- [ ] **Step 2: Run** IT on both integration files, then `pnpm --filter @tipme/web test`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(dashboard): the take-back banner, and its seen-time starts the notice`

### Task 9: The user chooses a new name during the notice

**Files:**

- Modify:
  - `packages/database/src/operations/profiles.ts`: `renameHandle` and `deleteAccount`;
  - `packages/database/src/operations/username-take-backs.ts`;
  - `apps/api/src/profiles/me-profile.controller.ts`: pass `sealing`;
  - `apps/web/src/app/dashboard/settings/sections/my-page.tsx`: the take-back mode of `HandleChange`.
- Test:
  - `tests/integration/handle-rule.test.mjs`;
  - `tests/integration/handle-renames.test.mjs`;
  - `tests/integration/username-take-backs.test.mjs`;
  - `packages/database/test/integration/profiles.test.mjs`.

**Interfaces:**

- `renameHandle(db, input: { userId: string; handle: string; now?: Date; sealing?: MailSealing })`:
  - it returns the same shape plus `takeBack?: true`;
  - the `PUT /v1/me/handle` route is unchanged;
  - after the profile row lock, it reads the page's open `current` take-back (`state IN ('approved','noticed')`, locked `FOR UPDATE`);
  - when one exists, it skips the Pro and limit checks, checks availability as usual, sets the handle **without** inserting an alias for the old one, leaves `handle_changes_used` alone, and calls `completeTakeBack(tx, { outcome: 'user_chose', chosenHandle, ... })`.

  This is the single path for both the take-back form and an ordinary change during the notice.

- In `renameHandle`, the `reclaimed` branch refuses a name under an open `old` take-back of this page with `HANDLE_TAKEN`. Its alias must not come back as a current handle.
- `completeTakeBack` with outcome `user_chose`, `assigned`, `old_removed` or `page_deleted` does the following, in this order:
  1. moves the page (update the profile, or delete the alias);
  2. inserts the reservation (`source = 'take_back'`, `take_back_id`, `reserved_by = null`, reason `'Taken back'`);
  3. sets `state = 'done'`, `outcome`, `done_at` and `new_handle`;
  4. for `assigned` and `without_notice`, sets `free_change_until = now + TAKE_BACK_FREE_CHANGE_MS`;
  5. queues the done email (dedupe `username_take_back_done.{id}`), except for `page_deleted`;
  6. audits `username.take_back_done` with `{ outcome, newHandle, noticedVia }`;
  7. enqueues the outbox event `username.take_back_done` `{ takeBackId, action: 'username.take_back', requestedBy }`.
- `deleteAccount`: after the aliases are deleted and held, an open take-back on the page completes as `page_deleted`. The reservation is written after the page has moved, so the trigger allows it, and the hold row stays.
- The web take-back mode of `HandleChange` is on when `profile.usernameTakeBack?.kind === 'current'`. It works on Free and Pro and shows no count. The heading is "Choose a new username".

  The confirmation reads: "Your page will be at {host}/@{new}. Links and QR codes with @{old} will stop working now. This won't use up any of your username changes." It does not make the usual "old links keep working" promise.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('a Free page can choose during notice, and it is not counted', ...);   // plan free; 200; handle_changes_used 0
  test('no alias is written for the taken name; the old link stops working', ...); // GET /v1/profiles/kemi -> 404, not 308
  test('the taken name is now an active take_back reservation', ...);
  test('an ordinary change during the notice goes through the take-back path', ...); // Pro page; count unchanged; outcome user_chose
  test('switching back to an old username under take-back is refused', ...); // HANDLE_TAKEN
  test('choosing completes early: done email once, banner gone, both pages revalidated', ...);
  test('deleting the page during the notice reserves the name as page_deleted, with no done email', ...);
  ```

- [ ] **Step 2: Run** IT on the four files. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces. Keep the existing `23505` → `HANDLE_TAKEN` mapping.
- [ ] **Step 4: Run** the same files, then `pnpm --filter @tipme/web test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(usernames): the user chooses a new username during the notice`

### Task 10: The worker sweep, the deadline and the 14-day never-reached path

**Files:**

- Modify:
  - `packages/database/src/operations/username-take-backs.ts`;
  - `packages/database/src/operations/issues.ts`: `runIssueDetectors` and `autoResolveIssues`;
  - `packages/database/src/operations/account-mail.ts`: `mailForDomainEvent` ignores `username.take_back_done`;
  - `apps/worker/src/job-worker.ts`;
  - `apps/worker/src/config.ts`: optional `WEB_REVALIDATE_URL` and `WEB_REVALIDATE_SECRET`;
  - `apps/worker/src/handlers/domain-events.ts`: `DOMAIN_EVENT_NAMES` and `POSTED_ONLY_EVENTS`;
  - `deploy/compose.staging.yml` and `deploy/compose.production.yml`: pass the two variables to the worker.
- Create:
  - `apps/worker/src/handlers/username-take-backs.ts`;
  - `apps/worker/src/revalidate.ts`.
- Test:
  - new `apps/worker/test/username-take-backs-handler.test.mjs`;
  - `apps/worker/test/config.test.mjs`;
  - `tests/integration/username-take-backs.test.mjs`;
  - `scripts/production-compose.test.mjs`, if it pins worker variables.

**Interfaces:**

- Produces `sweepTakeBacks(db: Database, input: { sealing: MailSealing; now: Date; batch?: number }): Promise<{ noticed: number; reminded: number; completed: number; unreached: number; revalidate: string[] }>`. The batch defaults to 100. Each step reads candidate ids without locking, then handles each id in its own transaction. Per id, it locks the profile with `FOR UPDATE SKIP LOCKED` (skipped if busy; the next run gets it), then the take-back row, then re-reads the state.
  1. **Email noticed.** For `approved` rows whose `notice_mail_id` message has `sent_at`, it sets `noticed`, `noticed_at = sent_at`, `noticed_via = 'email'` and `due_at = takeBackDueAt(sent_at, notice_days)`, then audits `username.take_back_noticed` (system).
  2. **Reminder.** For `noticed` rows with `notice_days >= 4`, `reminded_at` null and `due_at - 2 days <= now`, it queues the reminder (dedupe `username_take_back_reminder.{id}`) and sets `reminded_at`.
  3. **Deadline.** For `noticed` rows with `due_at <= now`, it sets `due`, then calls `completeTakeBack` with outcome `assigned` (`current`) or `old_removed` (`old`).
  4. **Never reached.** For `approved` rows with `noticed_at` null and `approved_at + TAKE_BACK_NEVER_REACHED_MS <= now`, it calls `completeTakeBack` with `noticedVia: 'unreached'`. The done email uses variant `unreached` (or `old`) and goes out only if an address exists by then.
- Produces `generatedHandle(tx: Tx, random?: () => string): Promise<string>`: `page_` plus 6 characters from `[a-z0-9]`. It retries up to 10 times while the name is built-in, reserved or `isTaken`, then throws, which keeps the row in `due` and raises the overdue issue.
- Produces `handleUsernameTakeBacks(deps: { db: Database; sealing: MailSealing; now: () => Date; revalidate: (handle: string) => Promise<void>; log?: (e: object) => void }): Promise<'swept'>`. It runs the sweep and then revalidates every handle in `revalidate`, as best effort.
- Produces `workerRevalidator(config): (handle: string) => Promise<void>`, the same POST as the API's `ProfileRevalidator`. It does nothing when the secret is unset, which is the spec's accepted 5-minute fallback.
- The job: `usernames.take-backs`, `ensureSchedule({ queue, id: 'usernames.take-backs', every: 60_000, logger })`, dispatched beside `approvals.expire`.
- The issues:
  - `username_take_back_unnoticed`: dedupe `username_take_back_unnoticed.{id}`, for rows `approved` for at least 24 hours with `noticed_at` null;
  - `username_take_back_overdue`: dedupe `username_take_back_overdue.{id}`, for rows not `done`/`cancelled` an hour after `due_at`.

  `autoResolveIssues` closes both once the row is noticed, done or cancelled.

- The outbox event `username.take_back_done` posts the staff alert: "TipMe staff alert: username.take_back_done: Take a username back from a page (by {requestedBy})".

- [ ] **Step 1: Write the failing tests**

  ```js
  // apps/worker/test/username-take-backs-handler.test.mjs
  test('the job dispatches by name and revalidates what the sweep returns', ...);
  test('running it twice changes nothing the second time', ...);
  test('it respects its timeout', ...);
  test('with no revalidation secret it skips revalidating, and still sweeps', ...);
  // tests/integration/username-take-backs.test.mjs (injected clock)
  test('the full path: approved, noticed only after sent_at, reminder at due minus 2 days, due, done', ...);
  test('no reminder when notice_days is below 4', ...);
  test('worker catch-up after a missed deadline completes at the next run, recording the actual time', ...);
  test('cancel racing the deadline sweep: one outcome', ...);
  test('user choice racing the sweep: one outcome', ...);
  test('never reached for 14 days: completed as unreached and recorded', ...); // noticed_via 'unreached'; done email only with an address
  test('approved for 13 days 23 hours without notice: nothing happens yet', ...);
  test('the generated username retries on collision and is never built-in or reserved', ...); // stub random
  test('an old-username take-back removes the alias at the deadline, and the page keeps its username', ...);
  test('the unnoticed issue opens at 24 hours and closes once noticed', ...);
  test('the overdue issue opens an hour after due and closes once done', ...);
  test('a suspended page still gets the banner, and stays suspended under its new name', ...);
  ```

- [ ] **Step 2: Run.** `pnpm --filter @tipme/worker build && pnpm --filter @tipme/worker test`, then IT `tests/integration/username-take-backs.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces. The sweep only re-reads and writes under locks, and every email has a dedupe key, so a duplicate job is harmless.
- [ ] **Step 4: Run** the same commands, `node --test scripts/production-compose.test.mjs`, and IT `packages/database/test/integration/issues.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(worker): take-back sweep, deadline, never-reached path and issues`

### Task 11: One free change within 30 days of an assigned username

**Files:**

- Modify:
  - `packages/database/src/operations/profiles.ts`: `renameHandle` and `toMine`;
  - `packages/contracts/src/profiles.ts`;
  - `apps/web/src/app/dashboard/settings/sections/my-page.tsx`;
  - `apps/web/src/components/dashboard/username-take-back-banner.tsx`.
- Test:
  - `tests/integration/handle-rule.test.mjs`;
  - `apps/web/test/take-back-banner.test.mjs`.

**Interfaces:**

- `MyProfile` gains `usernameFreeChange?: { until: string; assignedHandle: string; old: string } | null`. It is present while some done take-back of the page has `free_change_until > now` and `free_change_used_at IS NULL`.
- In `renameHandle`, when there is no open take-back but a free change is available, the change is allowed on Free or Pro and is not counted. It keeps the usual alias for the assigned name (`page_xxxxxx`), sets `free_change_used_at`, and audits `username.free_change_used` (the user's id, `subjectType: 'profile'`).
- The dashboard notice, which keeps the terms' "tell you ... on your dashboard" for people without email: "Your page has a new username, @{assignedHandle}. Links and QR codes with @{old} no longer work. You can change it once, for free, until {date}." It carries the action "Choose a new username".
- The Settings form shows "This change is free and won't use up any of your username changes." in place of the count.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('after an assigned username, a Free page changes once for free within 30 days', ...);
  test('the second change is refused as usual', ...);          // Free: HANDLE_CHANGE_PRO_REQUIRED
  test('after 30 days the free change has gone', ...);         // injected now
  test('a Pro page’s free change does not use a Pro change', ...);
  test('the free change is audited as username.free_change_used', ...);
  test('the dashboard notice words after an assignment', ...); // web unit
  ```

- [ ] **Step 2: Run** IT `tests/integration/handle-rule.test.mjs` and `pnpm --filter @tipme/web test`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(usernames): one free change after TipMe assigns a username`

### Task 12: Take-backs on the admin screens

**Files:**

- Modify:
  - `apps/web/src/app/ops/usernames/page.tsx`;
  - `apps/web/src/app/ops/pages/page.tsx`;
  - `apps/web/src/lib/ops-menu.ts`: `PAGE_CARDS` gains `usernames.manage`;
  - `packages/contracts/src/ops-catalogue.ts`: `OPS_PAGE_LOOKUP_PERMISSIONS` gains `usernames.manage`;
  - `packages/database/src/operations/ops-search.ts`;
  - `packages/contracts/src/ops.ts`: `OpsPage.takenBackOn?: string`;
  - `apps/web/src/app/ops/search/page.tsx`;
  - `apps/web/src/lib/ops-answers.ts`.
- Create: `apps/web/src/components/ops/take-back-form.tsx`.
- Test:
  - `tests/integration/ops-search.test.mjs`;
  - `apps/web/test/ops-menu.test.mjs`;
  - `tests/e2e/ops-usernames.spec.ts`;
  - `tests/e2e/ops-alone.spec.ts`.

**Interfaces:**

- `TakeBackForm({ name, kind, page, facts, onDone })` gathers:
  - the category, as radios with `TAKE_BACK_CATEGORY_WORDS`;
  - the notice: Ordinary starts at 7 and can go up to 30; the others default to 7 and can go down to 1 (and "No notice" after Task 14);
  - the internal reason (hint: "Staff only. The user never sees this.");
  - a read-only preview of the email from `TAKE_BACK_WHY`.

  The server facts appear as yes/no lines: "Plan", "Live", "Has a balance", "Withdrawal in flight", "Verified address on file". When `liveCheckoutListed` is true it warns: "This page is listed in LIVE_CHECKOUT_HANDLES. Update it to the new username, or it loses live checkout." It submits through `opsAct`, which shows "Waiting for approval" or "Done alone".

- The take-back state words are "Waiting for approval", "Notice being sent", "Notice sent, due {date}", "Being completed", "Done" and "Cancelled". Pending ones link to `/ops/approvals`.
- The Pages card, for `can(access, 'usernames.manage')` only, shows any open take-back on the page's names and a "Take back this username" button.
- Search: for a name that has a `done` take-back, `byText` returns the page with `takenBackOn` set, labelled "username taken back on {date}". The page appears with page-level fields only.
- `refusalWords` gains:
  - `TAKE_BACK_OPEN`: "This username already has a take-back under way";
  - `TAKE_BACK_CLOSED`: "This take-back has already finished";
  - `TAKE_BACK_NOT_FOUND`: "We couldn't find that take-back".

- [ ] **Step 1: Write the failing tests**

  ```js
  test('a taken-back name finds the page it was taken from, labelled with the date', ...); // ops-search
  test('Pages shows to a usernames.manage-only holder', ...);                             // ops-menu
  ```

  ```ts
  test('two staff request and approve a take-back; the user sees the banner, chooses a new name, and the old link stops working', ...);
  test('a single admin’s take-back runs alone and says so', ...);   // ops-alone.spec.ts
  ```

- [ ] **Step 2: Run** IT `tests/integration/ops-search.test.mjs`, `pnpm --filter @tipme/web test`, then `pnpm test:e2e -- tests/e2e/ops-usernames.spec.ts` and `pnpm test:e2e -- tests/e2e/ops-alone.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces. The e2e tests use `secondOwner` and `withDatabase` from `tests/e2e/ops-helpers.ts`, and move the clock through `sql` on `handle_take_backs.due_at` rather than waiting.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(ops): take-backs on Usernames, the Pages card and search`

### Task 13: Audit, runbook and decisions

**Files:**

- Modify:
  - `docs/runbooks/admin-roles.md`: `username.take_back` under "Serious actions", plus a "Taking a username back" procedure covering the categories, the 14-day never-reached rule, cancel, `LIVE_CHECKOUT_HANDLES`, and pausing a harmful page with `pages.suspend` while approval waits;
  - `docs/00-DECISIONS.md`: a dated note amending the handle rule;
  - `docs/agent/ACTIVE_TASK.md` and `docs/agent/HANDOFF.md`.
- Test:
  - `packages/contracts/test/ops-catalogue.test.mjs` (the runbook test);
  - `tests/integration/username-take-backs.test.mjs` (audit list);
  - `packages/database/test/integration/dashboard.test.mjs` or the Overview staff-activity test.

**Interfaces:**

- The decisions note, dated 4 Nov 2026 and quoting the owner's answers of 3 Nov 2026: "Old handles keep leading to the page and stay unclaimable while it exists, unless TipMe takes one back (`docs/superpowers/specs/2026-11-03-username-reservation-design.md`)." It also says that a take-back breaks the old links and printed QR codes for that name only, and that this approves nothing in D-02 to D-07.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('every take-back step leaves its audit entry, and the Overview lists started, done and released', ...);
  // reserved, released, take_back_started, take_back_noticed, take_back_done, take_back_cancelled, free_change_used;
  // subjectType 'username', subjectId the key (free_change_used: 'profile')
  ```

  The runbook test fails until `username.take_back` is in the runbook.

- [ ] **Step 2: Run** the contracts unit tests and IT on the file. Expected: FAIL.
- [ ] **Step 3: Implement** the docs.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit.** `docs: take-back runbook, handle rule amendment and audit list`

**PR 2 ends here.**

- Run the pre-PR checks, then `node scripts/test-integration.mjs`, then `pnpm test:e2e`.
- Open PR 2: "Staff take a username back from a page".
- Keep it out of production until the terms' "Your username" section is on `main`.

---

## PR 3 (optional): Without notice

### Task 14: The immediate path for impersonation, trademark and legal reasons

**Files:**

- Modify:
  - `packages/database/src/operations/serious-actions-registered.ts`: `validate` allows 0 for the non-ordinary categories;
  - `packages/database/src/operations/username-take-backs.ts`: `startTakeBack`;
  - `apps/web/src/components/ops/take-back-form.tsx`: a "No notice" option, shown only for the non-ordinary categories.
- Test:
  - `tests/integration/username-take-backs.test.mjs`;
  - `tests/e2e/ops-usernames.spec.ts`.

**Interfaces:**

- When `noticeDays === 0`, `startTakeBack` inserts the row and immediately calls `completeTakeBack` with outcome `assigned` (`current`) or `old_removed` (`old`) and `withoutNotice: true`, all in the approving transaction.
  - The done email uses variant `without_notice` for `current` and `old` for `old`.
  - It sends no notice email, and the row never shows a banner.
  - `run` returns `revalidateHandles: [old, new]`.
- It still needs a second approver. Only the lone-admin rule lets one person act.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('no notice: approval completes it at once, with the without-notice email', ...);
  test('no notice still waits for a second approver when one exists', ...);
  test('ordinary can never be no notice', ...);              // INVALID_INPUT
  test('both cached pages are revalidated after approval', ...);
  ```

- [ ] **Step 2: Run** IT `tests/integration/username-take-backs.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces.
- [ ] **Step 4: Run** the same file and `pnpm test:e2e -- tests/e2e/ops-usernames.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(usernames): take a username back without notice for impersonation, trademark or law`

---

## Self-review against the spec

| Spec section         | Where                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Intent, goals      | Tasks 1 to 4 (goals 1 and 2); Tasks 7 to 11 (goal 3); Task 14 (goal 4).                                                                                                    |
| 1 Anti-goals         | Money unchanged: Task 7 test. No silent loss: Tasks 9 and 10 tests. Second person: Task 7. User never sees staff: Tasks 6 to 8 (fixed why only). Rollback: Task 1 trigger. |
| 2 Code facts         | Lines named in Files and Interfaces; checked on `dev` at `c013899`.                                                                                                        |
| 3.1 Key              | Task 1.                                                                                                                                                                    |
| 3.2 Reservations     | Task 1.                                                                                                                                                                    |
| 3.3 Take-backs       | Task 5. `message_to_user` is dropped and `banner_seen_at`/`noticed_via` added (section 12).                                                                                |
| 3.4 Blocking         | Tasks 1 and 2. Router unchanged. A hold can be reserved (Task 3 test).                                                                                                     |
| 4 Permission, routes | Tasks 3 and 7. Menu: Task 4. Pages card: Task 12.                                                                                                                          |
| 5.1, 5.2             | Task 3 (API), Task 4 (screen).                                                                                                                                             |
| 5.3, 5.4             | Task 7.                                                                                                                                                                    |
| 5.5                  | Tasks 8 and 10. `why` is fixed wording only (12.3).                                                                                                                        |
| 5.6                  | Task 9.                                                                                                                                                                    |
| 5.7                  | Task 10 (deadline); Task 11 (free change, 12.4); `page_` plus 6 (12.5).                                                                                                    |
| 5.8                  | Task 10.                                                                                                                                                                   |
| 5.9                  | Task 7 (cancel); Task 10 (races).                                                                                                                                          |
| 5.10                 | Tasks 7 and 10 (1 to 6 days); Task 14 (0).                                                                                                                                 |
| 6 Emails             | Task 6; the unreached variant is added for 12.2.                                                                                                                           |
| 7 Screens            | Tasks 4 and 12.                                                                                                                                                            |
| 8 Edge cases         | Tasks 7, 9 and 10 tests (deletion, suspension, release-check, rename while waiting, worker down, no address).                                                              |
| 9 Audit              | Tasks 3, 7, 8, 9, 11 and 13.                                                                                                                                               |
| 10 Testing           | Each file named there is in a task.                                                                                                                                        |
| 11 Rollout           | The PR boundaries above. Migrations are additive, and `issues_kind` uses `NOT VALID`/`VALIDATE`.                                                                           |
| 12 Owner's answers   | 1: Task 7. 2: Tasks 8 and 10 (14 days). 3: Tasks 5 and 6. 4: Task 11. 5: Task 10. 6: `pro` is already built-in on `dev` (Task 1 test).                                     |
| 13 Disagreements     | The terms are on `dev` now, and PR 2's gate is `main`. Decision amendment: Task 13. Free rule waiver: Task 9. No email: Task 8.                                            |

Type names are consistent across tasks: `TakeBackKind`, `TakeBackCategory`, `TakeBackState`, `TakeBackOutcome`, `TakeBackNoticedVia`, `OpsTakeBack`, `OpsReservation`, `OpsUsernameCheck`, `completeTakeBack`, `startTakeBack`, `sweepTakeBacks`, `markTakeBackSeen`, and `MyProfile.usernameTakeBack` / `usernameFreeChange`.
