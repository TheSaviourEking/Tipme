# Dashboard Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three data gaps the screen redesign found on the recipient dashboard: a withdrawals-only list, tip totals and a "with a note" filter, and the bank each withdrawal actually went to.

**Architecture:** Branch `feat/dashboard-data` (worktree `.worktrees/dashboard-data`, from `origin/dev`). Contracts in `packages/contracts`. SQL in `packages/database/src/operations/dashboard.ts`. Routes in `apps/api/src/dashboard/dashboard.controller.ts`. Screens in `apps/web/src/app/dashboard`. One additive migration (an index). One PR to `dev`.

**Tech Stack:** Drizzle and raw SQL on Postgres, NestJS, Next.js App Router, Node test runner (`node --test`), Playwright (`tests/e2e`).

**Regulatory note:** read-only views of data TipMe already stores. Nothing here moves money or changes a payout, and nothing implies approval of D-02 to D-07 (`docs/00-DECISIONS.md`). Copy keeps saying "our payment partner".

---

## Design

### What the code does today (verified on `origin/dev` at 607db5b)

- **Gap 1.** The Withdraw screen reads `/v1/me/activity` (`apps/web/src/app/dashboard/withdraw/withdraw-view.tsx:151`) and keeps only withdrawals on the client (`:244-245`). The route asks for 10 rows (`apps/api/src/dashboard/dashboard.controller.ts:195-207`). `recentActivity` unions tips and payouts and returns the newest 10 (`packages/database/src/operations/dashboard.ts:283-317`). Ten recent tips push every withdrawal off the screen, in flight or failed ones included. Also: `payouts` has no index on `profile_id` (`packages/database/src/schema.ts:960-1019`).
- **Gap 2.** `GET /v1/me/tips` takes `status`, `cursor`, `limit` and `q` (`dashboard.controller.ts:105-126`) and returns rows with `hasMessage` (`dashboard.ts:149-207`). It has no totals and no note filter. The tips screen's filters are All, Paid and Being confirmed (`apps/web/src/app/dashboard/tips/tips-view.tsx:13-17`). The board has "₦312,400 from 148 people so far" and All, With a note, Being confirmed (`docs/design/redesign/boards/ScreenTips.dc.html`). The weekly report is a stored snapshot (`packages/database/src/operations/reports.ts:56-127`) that already holds `totalNetMinor` and `tipCount` (`packages/contracts/src/dashboard.ts:111-120`). Its board line is "14 people said thanks", next to "Tips 14" (`ScreenTipReport.dc.html`). The week's notes are found by paging up to 4 pages of paid tips and filtering `hasMessage` in the browser (`apps/web/src/components/dashboard/week-notes.ts:22-45`).
- **Gap 3.** `payouts.destinationId` references `payoutDestinations` (`schema.ts:978-980`). A destination row keeps `bankName` and `accountLast4` (`schema.ts:1046-1073`). A row is never edited in place: a new bank inserts a new row and sets `replaced_at` on the old one, and only `status` is ever updated (`packages/database/src/operations/payout-destinations.ts:195-215`). A payout records the destination that was current, held `FOR SHARE` until commit (`packages/database/src/operations/payouts.ts:1177-1204`). So the joined destination is the bank the payout went to. `ActivityRow` has no bank (`contracts/src/dashboard.ts:57-64`), so history rows show none.

### API shapes (`packages/contracts/src/dashboard.ts`)

```ts
/** The bank a withdrawal was sent to, as recorded when it was requested. Never the current bank. */
export interface WithdrawalBank {
  bankName: string;
  last4: string;
}

export type WithdrawalState =
  'requested' | 'processing' | 'in_review' | 'sent' | 'failed' | 'reversed';

export interface WithdrawalRow {
  payoutId: string;
  /** When it was requested (the list's order and cursor). */
  requestedAt: string;
  /** When it was paid, if it was. */
  paidAt: string | null;
  currency: string;
  amountMinor: string;
  state: WithdrawalState;
  /** Null for a payout recorded without a destination (before banks were kept, or pretend). */
  bank: WithdrawalBank | null;
}

export interface WithdrawalsPage {
  items: WithdrawalRow[];
  nextCursor: string | null;
}

export const myWithdrawalsQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

/** Every tip ever paid to the recipient. Tips still being confirmed are not counted. */
export interface TipTotals {
  currency: string;
  /** Sum of what the recipient received (net of TipMe's 10%) from paid tips. */
  receivedNetMinor: string;
  /** Number of paid tips. TipMe keeps no supporter identity, so this is not a count of people. */
  paidTipCount: number;
}

// ActivityRow gains one field (additive): null for tips.
export interface ActivityRow {
  /* existing fields */ bank: WithdrawalBank | null;
}
```

Routes (all `SessionGuard` + `CsrfGuard` through the controller, `Cache-Control: private, no-store`):

| Route                                 | Answer                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/me/withdrawals?cursor&limit` | `ApiDataResponse<WithdrawalsPage>`, newest request first, default 20, max 50 |
| `GET /v1/me/tip-totals`               | `ApiDataResponse<TipTotals>`                                                 |
| `GET /v1/me/tips?…&note=with`         | Today's page, only tips with a note the recipient can read                   |
| `GET /v1/me/activity`                 | Unchanged, plus `bank` on withdrawal rows                                    |

- **`tip-totals` is its own route, not `tips/totals`.** It stays clear of `tips/:tipId`, and it gives the tips header its own panel.
- **"Supporters" means paid tips.** A guest has no identity: `tips` keeps only a free-text `payer_display_label` (`schema.ts:889`). Distinct labels would merge two people called "Ada" and count every anonymous guest once. The tips header therefore says "₦312,400 from 148 tips so far". The report keeps "You were thanked 14 times" (already built from `tipCount`) instead of the board's "14 people said thanks". The weekly report needs no new field.
- **"With a note" is `hasMessage`'s rule:** a `tip_messages` row with no `message_flags` row (`dashboard.ts:176-177`). The screen's chip sends `status=paid&note=with`, because a note's words reach the recipient only with a paid tip (`dashboard.ts:256-259`). Any other `note` value is a 400.
- **Pending money:** totals count `SUCCEEDED` tips only, with `recipient_net_minor` from the tip's quote (as `dashboardSummary` does at `dashboard.ts:44-55`). This is "received", never "available": the available balance stays the ledger figure in `DashboardSummary`.

### Privacy

- Every query is keyed by the session's own profile (`myProfileId`, `dashboard.controller.ts:84-86`). The bank join also requires `d.profile_id = p.profile_id`, so a stray `destination_id` can never show someone else's bank.
- Only `bank_name` and `account_last4` leave the database. `destination_reference`, `bank_code`, `provider_reference`, `account_reference` and fees stay internal.
- The cursor encodes only the row's own request time and id (base64url, as tips do).
- Totals and the note filter return no message text. The text is still read only through `GET /v1/me/tips/:tipId`.

### Performance

- **New index `payouts_profile_created` on `payouts (profile_id, created_at DESC, id DESC)`.** It is additive, generated by drizzle-kit as migration `0071`. Today every per-recipient payout read scans the table. `payouts` is small, so a plain `CREATE INDEX` holds its lock only briefly.
- **Withdrawals page in the order the index serves:** keyset `(created_at, id) < (cursor)`, `LIMIT n+1`, and one primary-key join to `payout_destinations`. The cursor keeps microseconds (`to_char(... 'US')`). A millisecond cursor would skip rows created in the same millisecond. The existing tips cursor has that flaw; it is noted under Review Focus and not fixed here.
- **Totals:** one aggregate over the profile's tips, through `tips_profile_created` (`schema.ts:907`). If p95 goes above the API target once a profile has very many tips, a stored running total is a follow-up. It is not built now.
- **Note filter:** `EXISTS` on `tip_messages` (primary key `tip_id`) and `message_flags` (primary key `tip_id`). The week's notes loader adds `note=with`, so it needs fewer pages.

### How the screens use it

- **Withdraw** (`withdraw-view.tsx`): `usePanel<WithdrawalsPage>('/v1/me/withdrawals')` replaces the activity panel. "Show more" fetches the next cursor and keeps those rows tied to the path they belong to, as `tips-view.tsx:68-101` does. Each row says "to {bankName} ••{last4}" when `bank` is set, and nothing about a bank when it is null (never the current bank). `describe()` takes a `WithdrawalRow` and uses `requestedAt` and `paidAt` (a paid row is dated by `paidAt`, as today).
- **Home** (`home-view.tsx`, `components/dashboard/activity-list.tsx`): a withdrawal row adds "to {bankName} ••{last4}" when `bank` is set.
- **Tips** (`tips-view.tsx`): a second panel `usePanel<TipTotals>('/v1/me/tip-totals')` gives the subtitle "{naira(receivedNetMinor)} from {paidTipCount} tips so far". It is hidden while loading, on a load error, and when `paidTipCount` is 0. The filters become All, With a note (`status=paid&note=with`) and Being confirmed, as on the board. "Paid" goes.
- **Weekly report** (`reports/[week]/report-view.tsx`): no API change. `loadWeekNotes` asks `status=paid&note=with`.

---

## Global Constraints

- **Money comes from the API, never derived client-side.** The screens format `receivedNetMinor`, `amountMinor` and `netMinor` as given. They never add rows to make a total or subtract a fee. Amounts are strings of integer minor units in contracts; there is no floating point in SQL or contracts.
- **Pending money is never counted as available.** Totals count `SUCCEEDED` tips only. Withdrawals in `requested`, `processing` or `in_review` are never shown as paid. Nothing on these screens is labelled "available" except `DashboardSummary.availableMinor`.
- **Additive migrations only.** One new index. No column is dropped, renamed or retyped, and no deployed migration is edited. `ActivityRow.bank` is a new field; existing fields keep their meaning.
- **`usePanel` rules** (`apps/web/src/components/dashboard/use-panel.ts`):
  - one hook per panel;
  - it returns `{ data, error, reload }`;
  - a failed refresh keeps the data on screen (`error === 'refresh'`);
  - rows are keyed by id (`payoutId`, `tipId`);
  - no polling.
- **Only the person's own data:** every query takes the session's profile id. The bank join also checks the profile.
- **Never show the current bank for a past withdrawal.** No fallback to `getPayoutDestination` or to the quote's `destination`.
- **Copy:** sentence case, plain words, no em dashes, no provider names ("our payment partner").
- Contracts follow `packages/contracts/AGENTS.md`: no framework imports, no float money fields.
- No regulatory approval is implied (`docs/00-DECISIONS.md`).

## Review Focus

1. **Bank snapshot:** a row shows the bank recorded on the payout after the recipient changes bank (Task 2 and Task 5 tests), and `null` gives no bank line, never the current bank.
2. **Cursor:** microsecond precision, `(created_at, id)` keyset, no duplicates or gaps across pages when two payouts share a millisecond (Task 2 test). The tips cursor has the same millisecond issue (`dashboard.ts:174, 186`): it is a follow-up and not in this PR.
3. **Isolation:** another recipient's withdrawals, totals and banks are unreachable (Task 4 test). Another profile's destination id on a payout never joins (Task 2 test).
4. **Totals honesty:** confirming, failed and cancelled tips are excluded. The count is tips, and the copy says "tips", not "people".
5. **Migration:** only `CREATE INDEX`, plus the journal entry in order (`migration-journal.test.mjs`).
6. **Existing e2e that faked `/v1/me/activity` for withdrawals** (`tests/e2e/withdraw.spec.ts:218-268`) now fakes `/v1/me/withdrawals` with the new shape. It must not be deleted.

---

### Task 1: Contracts

**Files:**

- Modify: `packages/contracts/src/dashboard.ts`
- Test: `packages/contracts/test/dashboard.test.mjs` (create)

**Interfaces:** `WithdrawalBank`, `WithdrawalState`, `WithdrawalRow`, `WithdrawalsPage`, `TipTotals` and `myWithdrawalsQuerySchema` exactly as in Design, plus `myTipsNoteSchema = z.enum(['with'])` and `ActivityRow.bank: WithdrawalBank | null`.

- [ ] **Step 1: Write failing tests** in `packages/contracts/test/dashboard.test.mjs`:
  - `'withdrawals query takes a cursor and a limit of 1 to 50, nothing else'`: `{}`, `{ limit: '20' }` and `{ cursor: 'abc' }` parse; `{ limit: '0' }`, `{ limit: '51' }`, `{ cursor: 'x'.repeat(201) }` and `{ status: 'paid' }` fail.
  - `'the note filter accepts only "with"'`: `myTipsNoteSchema.safeParse('with').success === true`; `'without'` and `''` fail.
- [ ] **Step 2: Run** `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`. Expected: FAIL (exports missing).
- [ ] **Step 3: Implement** the types and schemas in `dashboard.ts`, with the comments from Design.
- [ ] **Step 4: Run** `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): withdrawal rows with their bank, tip totals and the note filter`.

### Task 2: Withdrawals list, the payout index and banks on activity

**Files:**

- Modify: `packages/database/src/schema.ts` (index on `payouts`), `packages/database/src/operations/dashboard.ts`, `packages/database/src/index.ts` (export)
- Create: `packages/database/drizzle/0071_payouts_profile_created.sql` and its `meta` snapshot and journal entry (generated)
- Test: `packages/database/test/integration/dashboard.test.mjs`

**Interfaces:**

- `export function listMyWithdrawals(db: Database, profileId: string, input: { cursor?: string; limit?: number }): Promise<WithdrawalsPage>`. Limit defaults to 20 and is clamped to 1 to 50.
- Shared fragments in `dashboard.ts`, used by both `recentActivity` and `listMyWithdrawals`:
  - `payoutStateSql`: the `CASE` moved from `:310-313`;
  - `payoutBankJoin`: `LEFT JOIN payout_destinations d ON d.id = p.destination_id AND d.profile_id = p.profile_id`.
- `recentActivity(db, profileId, limit?)` keeps its signature. Rows gain `bank`.
- Index: `index('payouts_profile_created').on(table.profileId, table.createdAt.desc(), table.id.desc())`.

- [ ] **Step 1: Write failing tests** in `dashboard.test.mjs`. Seed payouts with `createPayout`, or insert directly for exact `created_at` values, and seed banks with `setPayoutDestination`.
  - `'withdrawals are listed apart from tips, newest request first, each with its state'`: one payout, then 12 paid tips. `listMyWithdrawals` returns that payout, while `recentActivity(…, 10)` no longer contains it. `state` follows status: `REQUESTED`→`requested`, `PROCESSING`→`processing`, `PROCESSING` with `provider_review_at`→`in_review`, `PAID`→`sent`, `FAILED`→`failed`, `REVERSED`→`reversed`.
  - `'withdrawals page by cursor without gaps or repeats, even within one millisecond'`: 5 payouts, two of them with `created_at` 300 µs apart in the same millisecond. With `limit: 2`, three pages return all 5 ids exactly once, in order, and the last `nextCursor` is `null`. A tampered cursor (`'!!'`) is treated as the first page.
  - `'a withdrawal keeps the bank it went to after the bank changes'`: bank A (`GTBank`, `1234`), a payout, then bank B (`Kuda`, `9876`) through `setPayoutDestination`. Both `listMyWithdrawals` and `recentActivity` give `bank` `{ bankName: 'GTBank', last4: '1234' }` for that payout. A payout made after the change shows `Kuda`.
  - `'a payout without a destination shows no bank, never the current one'`: `destination_id` null while a usable destination exists, so `bank === null`.
  - `'another recipient's withdrawals and banks never appear'`: Ada's payout is absent from Tobi's list. A Tobi payout whose `destination_id` points to Ada's destination (forced by SQL) gives `bank === null`.
  - `'tip rows in activity have no bank'`: every `kind: 'tip'` row has `bank === null`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/database build && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/dashboard.test.mjs`. Expected: FAIL (`listMyWithdrawals` is not exported).
- [ ] **Step 3: Implement.**
  - Add the index to `schema.ts`, then run `pnpm --filter @tipme/database generate` and name the migration `0071_payouts_profile_created`. The SQL must contain only the `CREATE INDEX`.
  - Write `listMyWithdrawals`: `WHERE p.profile_id = $1 [AND (p.created_at, p.id) < ($at::timestamptz, $id::uuid)] ORDER BY p.created_at DESC, p.id DESC LIMIT n+1`. The cursor time comes from `to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, and `requestedAt` uses the same format.
  - Add `bank` to `recentActivity` through `payoutBankJoin`, with `NULL` for tips. Map the two columns to `{ bankName, last4 }` only when both are set.
- [ ] **Step 4: Run** the Step 2 command, then `node --test packages/database/test/integration/migration-journal.test.mjs` and `pnpm --filter @tipme/database typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(database): list a recipient's withdrawals with the bank each went to`.

### Task 3: Tip totals and the note filter

**Files:**

- Modify: `packages/database/src/operations/dashboard.ts`, `packages/database/src/index.ts`
- Test: `packages/database/test/integration/dashboard.test.mjs`

**Interfaces:**

- `export function myTipTotals(db: Database, profileId: string): Promise<TipTotals>`
- `listMyTips(db, profileId, input: { cursor?: string; status?: 'paid' | 'confirming' | 'all'; limit?: number; q?: string; note?: 'with' })`: one new optional field.

- [ ] **Step 1: Write failing tests:**
  - `'tip totals count only paid tips, at what the recipient received'`: two paid tips (₦4,000 and ₦2,000 gross, so ₦3,600 and ₦1,800 net), one confirming (`pendingOnly`), one failed. The answer is `{ currency: 'NGN', receivedNetMinor: '540000', paidTipCount: 2 }`. A recipient with no tips gets `'0'` and `0`. Tobi's totals ignore Ada's tips.
  - `'two tips under one name are two tips'`: two paid tips labelled `'Ada M.'` give `paidTipCount: 2`.
  - `'the note filter lists only tips whose note the recipient can read'`: one paid with a message, one paid without, one paid with a message then `hideMessage`, one confirming with a message. `listMyTips({ status: 'paid', note: 'with' })` returns only the first. It still combines with `q` and pages with `limit: 1` and the cursor.
- [ ] **Step 2: Run** the Task 2 Step 2 command. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `myTipTotals`: `SELECT COALESCE(SUM(q.recipient_net_minor),0)::text, COUNT(*)::int FROM tips t JOIN payment_intents i … JOIN tip_quotes q … WHERE t.profile_id = $1 AND t.status = 'SUCCEEDED'`.
  - Note filter: extract the existing `has_message` expression into `hasNoteSql` and use it both as the column and as `AND ${hasNoteSql}` when `note === 'with'`.
- [ ] **Step 4: Run** the Task 2 Step 2 command and `pnpm --filter @tipme/database typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(database): tip totals and a with-a-note filter for the recipient's tips`.

### Task 4: API routes

**Files:**

- Modify: `apps/api/src/dashboard/dashboard.controller.ts`
- Test: `tests/integration/dashboard-api.test.mjs`, `tests/integration/openapi.test.mjs`

**Interfaces:**

- `@Get('withdrawals') withdrawals(@CurrentUser() auth: AuthContext, @Query(new ZodValidationPipe(myWithdrawalsQuerySchema)) query: z.infer<typeof myWithdrawalsQuerySchema>): Promise<ApiDataResponse<WithdrawalsPage>>`. It sits beside the existing `@Post('withdrawals')`.
- `@Get('tip-totals') tipTotals(@CurrentUser() auth: AuthContext): Promise<ApiDataResponse<TipTotals>>`
- `tips(…, @Query('note') note?: string)`: an absent `note` means no filter. `'with'` filters, and any other value throws `CodedHttpException(400, 'VALIDATION_FAILED')`.
- All three carry `@Header('Cache-Control', 'private, no-store')`.

- [ ] **Step 1: Write failing tests:**
  - `'withdrawals are listed on their own, with their bank, and only to their owner'`: after the existing withdrawal test's payout, `GET /v1/me/withdrawals` gives `data.items[0]` with `payoutId`, `state` and `bank.last4` matching `/^\d{4}$/`. Without a cookie the answer is 401. Ada's cookie does not see Tobi's payout. `?limit=0` and `?status=x` are 400. The `cache-control` header is `private, no-store`.
  - `'tip totals and the note filter'`: after `tipTobi('Thanks')` and `tipTobi()`, `GET /v1/me/tip-totals` gives `paidTipCount` equal to the paid tips so far and `receivedNetMinor` equal to the sum of their `netMinor` from `/v1/me/tips?status=paid`, compared as BigInt in the test only. `/v1/me/tips?status=paid&note=with` returns only rows with `hasMessage: true`, and `?note=yes` is 400.
  - `openapi.test.mjs`: `access('get', '/v1/me/withdrawals')` and `access('get', '/v1/me/tip-totals')` each equal `['recipient', false, null]`.
- [ ] **Step 2: Run** `pnpm test:integration`. Expected: FAIL (404 on the new routes).
- [ ] **Step 3: Implement** the three handlers, which call `listMyWithdrawals`, `myTipTotals` and `listMyTips` with `note`.
- [ ] **Step 4: Run** `pnpm --filter @tipme/api typecheck && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): withdrawals list, tip totals and the with-a-note filter`.

### Task 5: Withdraw and home screens

**Files:**

- Modify: `apps/web/src/app/dashboard/withdraw/withdraw-view.tsx`, `apps/web/src/components/dashboard/activity-list.tsx`
- Test: `tests/e2e/withdraw.spec.ts`, `tests/e2e/dashboard.spec.ts`

**Interfaces:**

- `function describe(row: WithdrawalRow): { label: string; tone: 'ok' | 'bad' | 'wait'; steps: 0 | 1 | 2 | 3; note: string }`
- `function History({ rows, failed, refreshFailed, next, onMore }: { rows: WithdrawalRow[] | null; failed: boolean; refreshFailed: boolean; next: string | null; onMore: () => void })`
- `const bankLine = (bank: WithdrawalBank | null): string | null`, which gives `` `to ${bank.bankName} ••${bank.last4}` `` or `null`.

- [ ] **Step 1: Write failing e2e tests:**
  - Change `'progress follows the real state only'` to fake `**/v1/me/withdrawals*` with `{ data: { items: [...WithdrawalRow], nextCursor: null } }`, and keep its assertions. Add `bank: { bankName: 'GTBank', last4: '6789' }` on the paid row. Assert that the paid row contains `to GTBank ••6789`, and that the row with `bank: null` contains no `••`.
  - `'an older withdrawal stays listed after many tips'`: sign up, tip, and withdraw ₦2,000 (the existing helpers do this). Then 11 more `tipAsVisitor` calls, in parallel browsers, then reload. The "Your withdrawals" region still lists ₦2,000 with its state.
  - `'a past withdrawal keeps its bank after the bank changes'`: withdraw, then `withDatabase((db, ops) => ops.setPayoutDestination(db, { …, bankName: 'Kuda', last4: '9876', status: 'usable' }))`. On reload the history row still shows the original `••` digits from the quote, not `••9876`.
  - `'more withdrawals load on request'`: fake page 1 with `nextCursor: 'c1'` and page 2 for `cursor=c1`. Clicking "Show more" adds page 2's rows without repeating any; `data-testid` keys are not needed.
  - In `dashboard.spec.ts`, the first-day test's withdrawal row in Recent activity contains `••` followed by four digits.
- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/withdraw.spec.ts tests/e2e/dashboard.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Replace the activity panel with `usePanel<WithdrawalsPage>('/v1/me/withdrawals')`.
  - Keep the extra pages in state tied to the path, as `tips-view.tsx:68-101` does. Reload resets them.
  - Key rows by `payoutId`, and add `bankLine` under the state.
  - `reloadAll` reloads balance, quote and withdrawals.
  - `ActivityList` shows `bankLine(row.bank)` for withdrawal rows.
  - No amounts are computed on the client.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): withdrawals list with paging and the bank each went to`.

### Task 6: Tips totals, the "With a note" filter and the week's notes

**Files:**

- Modify: `apps/web/src/app/dashboard/tips/tips-view.tsx`, `apps/web/src/components/dashboard/week-notes.ts`
- Test: `tests/e2e/reports.spec.ts`, plus a new `tests/e2e/tips-list.spec.ts`

**Interfaces:**

- `type Filter = 'all' | 'notes' | 'confirming'`
- `const filterQuery: Record<Filter, string> = { all: 'status=all', notes: 'status=paid&note=with', confirming: 'status=confirming' }`
- `const totals = usePanel<TipTotals>('/v1/me/tip-totals')`
- `loadWeekNotes(week: string): Promise<WeekNote[]>` keeps its signature and asks `/v1/me/tips?status=paid&note=with`.

- [ ] **Step 1: Write failing e2e tests** in `tips-list.spec.ts`:
  - `'the tips header says what was received and from how many tips'`: two `tipAsVisitor` tips of ₦2,000. The header says `₦3,600 from 2 tips so far`.
  - `'a tip still being confirmed is not in the totals'`: fake `/v1/me/tip-totals` with `paidTipCount: 0`. No subtitle is shown. Then a real confirming tip (the existing pending helper in `dashboard.spec.ts:107-158`) leaves the subtitle unchanged.
  - `'With a note lists only tips with a note'`: one tip with a message and one without. Click "With a note"; one row is shown and it contains "with a note". The filter buttons are exactly All, With a note and Being confirmed (no "Paid"). Run `expectAccessible(page)`.
  - `'the totals keep showing when a refresh fails'`: after the first load, route `/v1/me/tip-totals` to 503 and call reload. The subtitle stays.
  - In `reports.spec.ts`, `'the week’s notes are a stack you press through'` also asserts that the page requested `note=with`, with `page.waitForRequest(/\/v1\/me\/tips\?.*note=with/)`.
- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/tips-list.spec.ts tests/e2e/reports.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The subtitle under "Your tips" is `{naira(totals.data.receivedNetMinor)} from {count} {count === 1 ? 'tip' : 'tips'} so far`. It is rendered only when the data is there and the count is above 0. On `error === 'refresh'` it keeps the last data.
  - Make the filter change.
  - In `loadWeekNotes`, add `&note=with`. Keep the client-side `hasMessage` check as a guard for an older API.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): tip totals and a With a note filter on the tips list`.

### Task 7: Full check and the PR

**Files:** `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`

- [ ] **Step 1: Run** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, then `pnpm test:integration`, then `rm -rf apps/web/.next/cache && pnpm test:e2e`. Record each command and its pass, fail or skip in `HANDOFF.md`.
- [ ] **Step 2: Update** `ACTIVE_TASK.md` and `HANDOFF.md` with the verified state and the follow-ups:
  - the tips cursor's millisecond precision;
  - a stored running total if the totals p95 grows;
  - the board's "people" copy.
- [ ] **Step 3: Commit** `docs: hand-off for the dashboard data PR`.
- [ ] **Step 4: Open one PR** to `dev` only after the owner says to push. Title: `Dashboard data: withdrawals list, tip totals and payout banks`. The body maps each gap to its tasks and lists the migration (`0071`, index only), the test commands and their results, and the "tips, not people" decision. End it with the attribution line.

---

## Decisions for the owner

1. **"People" are tips.** TipMe holds no supporter identity, so the tips header says "from 148 tips" and the report keeps "thanked 14 times". Counting distinct names would be wrong both ways.
2. **Totals are lifetime and paid-only.** They are unaffected by the filter or search.
3. **"With a note" means paid tips whose note the recipient can still read.** Hidden or reported notes are excluded.
4. **Withdrawals are ordered by request time,** so a row doesn't jump when it is paid, and it carries `paidAt` for the date shown.
5. **A payout with no recorded destination shows no bank.** It never shows the current bank.
