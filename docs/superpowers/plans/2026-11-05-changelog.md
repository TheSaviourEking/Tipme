# Changelog and "What's new": implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One list of changelog entries, with two views.

1. **Draft.** When a pull request merges into `dev`, a CI step sends its number, title, body and merge commit to TipMe, signed with a secret. TipMe reads nothing else from GitHub. The staff text is the PR title plus the body's first paragraph. The user text is a new "For users" section of the PR description. If that section is empty, the entry is "Staff only".
2. **Admin.** `/ops/changelog` lists every merged PR, with the filters All / Drafts / For users / Staff only. An entry moves Draft → Approved (on staging) → Live (when that change reaches production). Its other end states are Recorded (staff only) and Withdrawn. The entry page edits both texts and "Who sees it", then offers "Ask for approval". One approval, by someone with `changelog.publish`, is needed before users see anything. Approvals use the existing Approvals screen.
3. **Users.** "What's new" goes in the dashboard menu, with a dot after an update, plus one slip on dashboard Home until it is opened or closed. The page lists approved user-facing entries that are live in production, newest first, each dated by the day it went live. "Last seen" is stored on the server, so the dot and slip show once per update on any device. Pro-only changes say "On Pro…". Early-access entries go only to Pro pages with early access on (a hook until `feat/early-access` merges). None of this appears on public pages or the tip form. A withdrawn entry disappears for users and stays in admin, marked Withdrawn.

**Owner's request:** the backlog of 5 Nov 2026 ("the full changelog in admin; when an update ships, users see what it brings"). The `Changelog.dc.html` board was approved on 5–6 Nov 2026. On 6 Nov the owner said "use the defaults for the changelogs": **one approval** by a `changelog.publish` holder, and **in-app only, no email**. This is a product decision, not a legal, regulatory or provider approval. No D-item in `docs/00-DECISIONS.md` changes. Nothing about money, fees, checkout, the ledger or payouts changes.

**Board:** `Changelog.dc.html`, "The changelog in admin, and What's new for users". It is on the design canvas, but **not in the scratchpad folder** (`canvas-email/project/` holds only `Business.dc.html` and `canvas.json`). This plan follows the board as the caller summarised it. Task 1.0 copies the board into the repo once someone exports it. Do not redraw it.

**Architecture:**

- **Storage.** Entries live in the **production** TipMe database (`changelog_entries`), because production is where staff work and users read. The admin and user views are two read functions over that one table.
- **Published copy.** Each entry holds a _working_ copy (what staff are editing) and a _published_ copy (what was approved). Users only ever read the published copy, so live text never changes without an approval.
- **State.** An entry's state is derived from its timestamps by one contracts function, `changelogState`, never stored. The admin list, the entry page and the API all show the same answer.
- **Signed endpoints.** CI talks to three signed endpoints under `/v1/webhooks/changelog/`. That prefix already passes the staging preview gate (`apps/api/src/http/preview-gate.middleware.ts:10-14`).
- **Approval.** An editor without `changelog.publish` asks through the serious-action flow. That needs one small, reviewed extension: an action may name a different permission for _asking_ than for _deciding_. A `changelog.publish` holder approves directly, with a fresh code, and that is the one approval.
- **"Reached production".** See Design §2.

**Tech stack:** Drizzle/Postgres, NestJS, Next App Router, Zod, Playwright, `node --test`, GitHub Actions. No new dependency.

---

## What the code does today (origin/dev `44fcd42c`, migrations 0000–0078)

- **Admin menu** (`apps/web/src/lib/ops-menu.ts`):
  - the groups are `[null, 'Work', 'Numbers', 'Email and records', 'Staff']`;
  - each `LINKS` entry has `href`, `label`, `group` and `needs`;
  - the comment at the `LINKS` docblock says "a Changelog would join 'Email and records'";
  - the tests are in `apps/web/test/ops-menu.test.mjs`.
- **Permissions** (`packages/contracts/src/ops-catalogue.ts`):
  - `OPS_PERMISSIONS` (20 names) and `OPS_CATALOGUE` (description, group, sensitive);
  - `SERIOUS_ACTIONS`, `SERIOUS_ACTION_WORDS` and `SERIOUS_ACTION_PERMISSIONS` (11 actions, the latest `username.take_back`, #133);
  - pinned route lists `OPS_FRESH_CODE_EXEMPT` and `OPS_ANY_STAFF_ROUTES`.
  - The DB check constraints `role_permissions_known` and `staff_permission_overrides_known` are generated from `OPS_PERMISSIONS` (`schema.ts:1488-1503`). Adding a permission needs a migration that drops and re-adds them, like `drizzle/0073_usernames_permission.sql`. That migration also grants the new permission to `owner` by hand, because `ensureOwnerRole` (`operations/staff.ts:55-66`) runs only when an owner is granted.
- **Serious actions** (`packages/database/src/operations/serious-actions.ts`):
  - `registerSeriousAction` refuses a permission that is not `sensitive` (:197-209);
  - `requestSeriousAction` (:398-575) requires the **requester to hold `action.permission`** and be able to enter a code (:426-432), then asserts a fresh code;
  - if anyone else qualifies, it waits, with a 24 h TTL (`REQUEST_TTL_MS`), an `approval_requests` row, an audit entry and the `ops.approval_pending` outbox mail;
  - if nobody else qualifies, it runs alone, with the `serious_action.ran_alone` audit entry and the `ops.acted_alone` alert;
  - `current()` pins a value checked again at approval, so a moved target closes the request as stale;
  - `SeriousActionContext.requestId` is new in #133.
  - Registered actions are in `serious-actions-registered.ts`. The approvals screen is `apps/web/src/app/ops/approvals/page.tsx`, and it shows each request's server-written `summary`.
- **Deploys and versions:**
  - the API reports `GIT_SHA` as `/health/release` → `data.version` (`apps/api/src/release/release.controller.ts:36-50`, `config.ts:35-38`);
  - production sets `GIT_SHA` per blue/green colour (`deploy/compose.production.yml:212-259`).
  - `deploy-production.yml` (hand-run, from `main` only):
    - `gate` refuses a commit whose file tree has no full staging pass (`scripts/staging-pass.mjs`, a commit status `release/staging-full` keyed by **tree**);
    - `deploy` sets `VERSION=$(git rev-parse --short=12 HEAD)`, reads `PREVIOUS_VERSION` from production's `/health/release`, ships, then runs `pnpm release:check --expect-version "$VERSION"`. The checkout has `fetch-depth: 0`.
  - `deploy-staging.yml` follows `dev` (after green checks, when `STAGING_AUTO_DEPLOY` is true, or by hand). It runs the release check with `--expect-version`, records the staging pass on `HEAD`, and has full history.
- **How dev reaches main:** PRs merge into `dev` with merge commits ("Merge pull request #N from …"). `main` takes `dev` through a "from dev" PR, also a merge commit (#129, #110, #105). A hotfix can also merge straight into `main` (#135) with a twin into `dev` (#136).
- **Signed requests:**
  - `rawBody: true` in `app.factory.ts:58`;
  - the HMAC patterns are `packages/mail/src/zeptomail/webhook.ts:145` and `apps/api/src/checkout/status-token.ts`;
  - the constant-time compare is `apps/api/src/http/bearer.ts`.
- **Dashboard** (`apps/web/src/app/dashboard/dashboard-shell.tsx`):
  - `links()` builds the nav (`phone: false` hides an item in the phone tab bar, `globals.css:5984`);
  - `dashboard-nav__dot` is the attention dot, with "(needs your attention)" for screen readers;
  - `NotificationBell` and Sign out sit in `dashboard-bar`.
  - `home-view.tsx` opens `dashboard-home__main` with `<UsernameTakeBackBanner />` (#133).
- **Primitives on dev** (states PR A): `Slip`, `EmptySlip`, `EmptyWell`, `StateLine`, `ResultKey`/`useKeyResult` and `Lamp` in `packages/ui`. New screens use these, not `Notice`/`EmptyState` (states PR I removes those).
- **Early access:** not on dev. It is planned in `.superpowers/program/plans/2026-11-05-pro-additions.md`, PR 1 (`feat/early-access`: `profiles.early_access`, `MyProfile.earlyAccess?`).
- **PR template:** `.github/PULL_REQUEST_TEMPLATE.md` has no "For users" section.

---

## Design

### 1. Entries and their state

**Table `changelog_entries`** (migration A):

| column                                             | type                                    | notes                                                                                                        |
| -------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pr_number`                                        | `integer PRIMARY KEY`                   | `> 0`. One entry per merged PR.                                                                              |
| `merge_sha`                                        | `text NOT NULL`                         | `^[0-9a-f]{40}$`. What "reached production" is checked against.                                              |
| `merged_at`                                        | `timestamptz NOT NULL`                  | From the event.                                                                                              |
| `pr_title`                                         | `text NOT NULL`                         | As received, at most 256 code points. Kept for admin only.                                                   |
| `staff_text`                                       | `text NOT NULL`                         | 1–1000 code points. Starts as title + first paragraph. Editable without approval (staff only).               |
| `user_text`                                        | `text NULL`                             | Working copy, 1–280 code points, or NULL.                                                                    |
| `audience`                                         | `text NOT NULL`                         | Working copy: `'staff' \| 'everyone' \| 'pro' \| 'early_access'`. `'staff'` iff `user_text IS NULL` (check). |
| `revision`                                         | `integer NOT NULL DEFAULT 1`            | Goes up by one on every change to `user_text` or `audience`.                                                 |
| `published_text`                                   | `text NULL`                             | The approved user text.                                                                                      |
| `published_audience`                               | `text NULL`                             | The approved audience.                                                                                       |
| `published_revision`                               | `integer NULL`                          | The revision that was approved. All three published columns are NULL together (check).                       |
| `approved_at`, `approved_by`                       | `timestamptz NULL`, `uuid NULL → users` | The last approval.                                                                                           |
| `staging_at`                                       | `timestamptz NULL`                      | First time staging ran a commit containing `merge_sha`.                                                      |
| `live_at`                                          | `timestamptz NULL`                      | First time production ran a commit containing `merge_sha`. Never cleared.                                    |
| `live_version`                                     | `text NULL`                             | The 12-character production version that carried it in.                                                      |
| `withdrawn_at`, `withdrawn_by`, `withdrawn_reason` | NULL                                    | All three set together (check).                                                                              |
| `created_at`, `updated_at`                         | `timestamptz`                           |                                                                                                              |

Indexes:

- `(live_at DESC, pr_number DESC) WHERE withdrawn_at IS NULL AND published_audience <> 'staff'`, for the user list;
- `(merged_at DESC)`, for admin;
- `(pr_number) WHERE live_at IS NULL AND withdrawn_at IS NULL`, for the pending list.

**Table `changelog_reads`** (migration A): `user_id uuid PRIMARY KEY → users`, `seen_through timestamptz NOT NULL`. It is a separate table, not a `profiles` column, so it does not collide with the other branches editing `profiles` (early access, social links). `deleteAccount` deletes the row.

**Contracts** (new `packages/contracts/src/changelog.ts`):

```ts
export const CHANGELOG_AUDIENCES = [
  'staff',
  'everyone',
  'pro',
  'early_access',
] as const;
export type ChangelogAudience = (typeof CHANGELOG_AUDIENCES)[number];
export const CHANGELOG_USER_TEXT_LIMIT = 280; // code points, as Postgres char_length
export const CHANGELOG_STAFF_TEXT_LIMIT = 1000;
export type ChangelogState =
  'draft' | 'approved' | 'live' | 'recorded' | 'withdrawn';

/** The PR body's first paragraph: text up to the first blank line or heading, markdown comments removed. */
export function firstParagraph(body: string): string;
/** The "For users" section: a heading line matching /^#{1,6}\s*for users\s*$/i, up to the next heading. '' when absent. HTML comments (the template's hint) removed, whitespace collapsed. */
export function forUsersSection(body: string): string;
/** The draft an incoming PR makes. staff_text = title + ' — ' + firstParagraph, cut to the limit at a word. userText null → audience 'staff'. */
export function draftFromPullRequest(pr: {
  title: string;
  body: string | null;
}): {
  staffText: string;
  userText: string | null;
  audience: ChangelogAudience;
};
/** Why a user text may not be published: names the payment provider, or implies approval by a regulator. */
export function userTextProblems(
  text: string,
): ('provider_name' | 'regulatory_claim' | 'too_long')[];
// provider_name: /\bbachs\b/i (the same word as apps/web/test/no-provider-names.test.mjs).
// regulatory_claim: /\b(licen[cs]ed|regulated|approved by|authori[sz]ed by|CBN|central bank|insured|guaranteed)\b/i.

export function changelogState(e: {
  audience: ChangelogAudience;
  publishedRevision: number | null;
  liveAt: string | null;
  withdrawnAt: string | null;
}): ChangelogState;
// withdrawnAt → 'withdrawn'; publishedRevision null && audience 'staff' → 'recorded';
// publishedRevision null → 'draft'; liveAt null → 'approved'; else 'live'.
// (An entry approved as 'staff' — a user text removed after approval — is 'recorded'.)
export function hasUnapprovedEdit(e: {
  revision: number;
  publishedRevision: number | null;
}): boolean;

/** Who may read a published entry in What's new. */
export function shownToUser(
  e: { publishedAudience: ChangelogAudience | null },
  who: { plan: PagePlan | undefined; earlyAccess: boolean },
): boolean;
// 'everyone' and 'pro' → true (Pro entries read "On Pro…", see Open Q1); 'early_access' → plan === 'pro' && earlyAccess;
// 'staff' or null → false.
/** The line users read: "On Pro, " is added in front of a Pro entry unless it already starts with "On Pro". */
export function userLine(e: {
  text: string;
  audience: 'everyone' | 'pro' | 'early_access';
}): string;

// Wire shapes (CI → TipMe), all .strict():
export const changelogDraftSchema; // { number: int>0, title: string≤256, body: string≤65536 | null, mergeCommitSha: /^[0-9a-f]{40}$/, mergedAt: iso }
export const changelogPendingSchema; // { environment: 'staging' | 'production' }
export const changelogReleaseSchema; // { environment, version: /^[0-9a-f]{12}$/, contained: int[] (≤ 2000, unique) }
// Admin:
export interface OpsChangelogRow {
  number;
  title;
  staffText;
  state: ChangelogState;
  unapprovedEdit: boolean;
  audience;
  publishedAudience;
  mergedAt;
  stagingAt;
  liveAt;
  waitingRequestId: string | null;
}
export interface OpsChangelogEntry extends OpsChangelogRow {
  userText;
  publishedText;
  revision;
  publishedRevision;
  approvedAt;
  approvedBy: string | null /* masked email */;
  withdrawnAt;
  withdrawnReason;
  problems: ReturnType<typeof userTextProblems>;
}
export const opsChangelogQuerySchema; // { view: 'all' | 'drafts' | 'users' | 'staff', before?: int }
export const opsChangelogEditSchema; // { staffText?: string; userText?: string | null; audience?: ChangelogAudience; revision: int } .strict()
// Users:
export interface WhatsNewEntry {
  number: number;
  line: string;
  pro: boolean;
  liveOn: string; /* YYYY-MM-DD, Africa/Lagos */
}
export interface WhatsNewList {
  entries: WhatsNewEntry[];
  unseen: number;
}
export interface WhatsNewStatus {
  unseen: number;
  newest: WhatsNewEntry | null;
}
export const whatsNewSeenSchema; // { through: iso } .strict()
```

**State rules** (all enforced in `packages/database/src/operations/changelog.ts`):

- **A draft never overwrites.** The ingest is `INSERT … ON CONFLICT (pr_number) DO NOTHING`, so a re-sent PR (a re-run or a resend) never undoes staff edits. It answers `{ created: boolean }`.
- **An edit is optimistic.** `editEntry` takes the `revision` the editor saw and refuses `CHANGELOG_EDITED_ELSEWHERE` (409) if it moved. Changing `userText` or `audience` bumps `revision`. Changing `staffText` does not. Setting `userText` to null forces `audience = 'staff'`. A non-null `userText` with `audience: 'staff'` is refused.
- **Approval copies the working copy to the published copy**, but only if the revision is still the one asked about. `userTextProblems` must be empty, or the approval is refused with `CHANGELOG_TEXT_NOT_ALLOWED` and the problems are listed.
- **A withdrawal hides the entry from users.** It needs a reason and is audited. It never deletes and is never undone in place. To show the entry again, staff edit it, which bumps the revision, and approve it again. The entry then clears `withdrawn_*` in the same transaction as the approval, and the audit entry says so.
- **Staff-only entries need no approval.** They are "Recorded" at once. `live_at` still fills in, so admin can say when they shipped.
- **Every write is audited** (`recordAudit`): `changelog.drafted` (system), `changelog.edited`, `changelog.approved`, `changelog.withdrawn` and `changelog.released` (system, one per release call, listing the numbers). The audit reason holds the entry number and the revision, never the PR body.

### 2. How TipMe knows a change "reached production" (chosen mechanism)

**Chosen: git ancestry, checked by the deploy workflows against TipMe's own pending list.**

After a production deploy passes its release check, `deploy-production.yml` runs `scripts/changelog-sync.mjs --environment production --version "$VERSION"`. The script:

1. POSTs `{ environment: 'production' }` to `/v1/webhooks/changelog/pending`, signed. TipMe answers with every entry not yet live and not withdrawn, as `{ number, mergeSha }[]`. It reveals nothing else.
2. For each entry, runs `git merge-base --is-ancestor <mergeSha> <VERSION>` in the deploy's full-history checkout. Exit 0 means contained, 1 means not, and anything else (an unknown sha) is reported in the summary and skipped.
3. POSTs `{ environment: 'production', version, contained: [numbers] }` to `/v1/webhooks/changelog/releases`, signed. TipMe sets `live_at = now()` and `live_version` where `live_at IS NULL`. The call is idempotent.
4. Writes "Changelog: N entries now live (#…)" to the job summary.

`deploy-staging.yml` runs the same script with `--environment staging` after its release check passes, which sets `staging_at`. The admin shows "Approved · on staging" or "Approved · not on staging yet". **The step is `continue-on-error: true` in both workflows.** A changelog failure must never make a deploy look failed, or change what "Deploy failed" says about production. A separate `changelog-sync.yml` (`workflow_dispatch`, input `environment`) reads the running version from that environment's `/health/release` and runs the same script. It is the catch-up after a failed or skipped step.

**Why this one:**

- It answers the exact question ("does the code production runs contain this PR's merge?") from git itself, in the job that already holds the full history and the verified version (`--expect-version` has just confirmed production serves `VERSION`).
- It needs no record of what was deployed before. A missed sync is caught up by the next deploy or the hand-run workflow, because every pending entry is checked against the running version each time.
- It works for merge, squash and rebase merges into dev, because `merge_commit_sha` is always on dev. It also works for the dev→main merge commit.
- TipMe still reads nothing from GitHub. CI pushes signed facts, and TipMe's answer to `pending` is only numbers and SHAs.

**Rejected:**

- _The commit range `PREVIOUS_VERSION..HEAD`_ (as the Slack summary uses). It is empty or wrong when the previous version could not be read, and a failed step loses that range for good.
- _The staging-pass status._ It is keyed by file tree for the deploy gate, and says nothing about which PRs a version holds.
- _The API reporting its own `GIT_SHA` at boot._ The API has no git graph, so it cannot tell which merges a version contains.
- _Parsing "Merge pull request #N" subjects._ It breaks on squash merges, and #135/#136 show that one change can arrive through two PRs.

**Known limits** (stated in the runbook):

- `main` must keep taking `dev` through a **merge commit**. A squash of dev into main would break ancestry. The sync then lists, in the summary, pending entries older than 14 days that are still not contained, so the break shows.
- A hotfix merged straight into `main` (like #135) is not drafted. Its twin into `dev` is, and goes live when dev next reaches main, so its date may be later than the real one.
- A production rollback (`deploy/scripts/rollback-production.sh`) does not un-live entries (Open Q6).

### 3. The signed endpoints

- **Routes:**
  - `POST /v1/webhooks/changelog/drafts`;
  - `POST /v1/webhooks/changelog/pending`;
  - `POST /v1/webhooks/changelog/releases`.
- **Secret:** `CHANGELOG_SIGNING_SECRET` (API config: `z.string().min(32).optional()`, never logged). When it is unset, all three answer `404` (the feature is off). Production and staging composes pass it through like `ZEPTOMAIL_API_KEY`.
- **Signature:** the headers `X-TipMe-Timestamp: <unix seconds>` and `X-TipMe-Signature: sha256=<hex of HMAC-SHA256(secret, timestamp + "." + rawBody)>`. The request is refused (401 `CHANGELOG_SIGNATURE_INVALID`) when:
  - a header is missing;
  - the timestamp is more than 300 s from now;
  - the signature does not match. The compare is constant time, using `timingSafeEqual` over equal-length digests.
- **Body:** capped at 128 KiB before parsing.
- **Rate limit:** a new `changelog_ingest` bucket, 60 per minute.
- **What is kept from a draft:** TipMe parses the body and stores only `staff_text` and `user_text`. **The PR body itself is never stored or logged.** Request logs keep the route and status only.
- **Replays** inside the 300 s window are harmless: drafts do nothing on conflict, `pending` is a read, and `releases` only fills NULLs.

### 4. Approval

- **Permissions:**
  - `changelog.edit`: group `content`, `sensitive: false`, "Edit changelog entries and ask for one to be shown to users". The migration grants it to **every role except `release_check`**.
  - `changelog.publish`: group `content`, `sensitive: true`, "Approve what users read in What's new". It is granted to `owner` only. It has to be sensitive, because `registerSeriousAction` requires that. As a result, its routes need a fresh code, and adding it to a role goes through `role.add_sensitive` (Open Q4).
- **Serious action `changelog.publish`**, with the payload `{ number, revision }`:
  - `describe`: "Show users this What's new entry (#N, everyone|Pro|early access): "<published-to-be text>"". The full text is at most 280 characters and is not private;
  - `current`: `{ revision, publishedRevision, withdrawnAt }`, so any edit, a direct approval or a withdrawal makes the request stale;
  - `target`: `changelog:<number>`;
  - `validate`: the entry exists, it has a user text, its revision equals the payload's, and `userTextProblems` is empty;
  - `run`: `approveEntry(tx, { number, revision, approverId: ctx.approverId ?? ctx.actorId })`.
- **New, in `serious-actions.ts`:** an optional `askPermission` on `SeriousActionDefinition`.
  - When it is set, `requestSeriousAction` checks that the requester holds `askPermission` instead of `permission`. They must still be able to enter a code, and the fresh code is still asserted.
  - Who qualifies to decide is still `permission`.
  - With **no** qualified approver: a requester who holds `permission` runs alone, as today. A requester who does not is refused with the new `APPROVAL_NO_APPROVER` ("Nobody who can approve this is set up yet."). The run-alone path therefore stays limited to people who could have acted directly.
  - `registerSeriousAction` checks that `askPermission`, when given, is in the catalogue.
  - Nothing else changes for the 11 existing actions. A test proves this.
- **Two paths in the entry page, one approval each:**
  - **Approve** (holder of `changelog.publish`): `POST /v1/ops/changelog/:number/approve { revision, reason }`, with a fresh code. It runs `approveEntry` directly and is audited as `changelog.approved`. This is the one approval, so it is not a serious action, and the owner, today the only publisher, sets off no "acted alone" alert every time.
  - **Ask for approval** (holder of `changelog.edit` without publish): `POST /v1/ops/changelog/:number/ask { revision, reason }` → `requestSeriousAction('changelog.publish', …)`. It appears on `/ops/approvals` for publishers. The 24 h TTL applies, and an expired request is asked again.
- **What approval does not need:** a second person beyond the approver. The owner's default is one approval (Open Q2 records it).

### 5. Admin screens

- **The menu:** `{ href: '/ops/changelog', label: 'Changelog', group: 'Email and records', needs: ['changelog.edit', 'changelog.publish'] }`, after Audit log.
- **`/ops/changelog`:**
  - the filters are All / Drafts / For users / Staff only, as an `aria-pressed` key row with `?view=` in the URL:
    - Drafts means state `draft`, or `hasUnapprovedEdit`;
    - For users means `published_audience` in everyone/pro/early_access;
    - Staff only means state `recorded`;
  - each row shows `#N`, the staff text's first line, a state stamp (Draft / Approved · on staging / Approved · not on staging yet / Live 6 Nov / Recorded / Withdrawn), "Edited, waiting for approval" when it applies, "Waiting in Approvals" when a request is pending, and the merged date;
  - the list is newest merged first, 50 per page (`before=<number>`). The empty state is `EmptySlip`, "No merged pull requests yet.";
  - permissions: `changelog.edit` or `changelog.publish` (read).
- **`/ops/changelog/[number]`:**
  - "Staff text" (textarea, 1000);
  - "For users" (textarea, 280, with a live count in code points, plus the hint "Leave empty to keep this staff only. Never name our payment partner or say TipMe is approved or licensed.");
  - "Who sees it", a fieldset of radios: Everyone / Pro pages ("starts 'On Pro…'") / Pro pages with early access. With early access not built yet, the third reads "Pro pages with early access (nobody sees these until early access exists)". The radios are disabled while For users is empty;
  - a preview of the exact user line (`userLine`);
  - the problems from `userTextProblems`, shown inline with `aria-describedby`;
  - the keys are Save (edit), then **Approve** (publish holders) or **Ask for approval** (others), and Withdraw (with a reason, `ReasonAction`);
  - fresh-code prompts use the existing `FreshCode` flow;
  - the published copy, when it exists, is shown read-only as "What users read now", with its approval date and the approver's masked email;
  - all feedback uses `Slip` and `ResultKey`.

### 6. Users: What's new

- **API** (`apps/api/src/dashboard/whats-new.controller.ts`, signed-in recipient, the same guards as `dashboard.controller.ts`):
  - `GET /v1/me/whats-new` → `WhatsNewList`, at most 50, newest first;
  - `GET /v1/me/whats-new/status` → `WhatsNewStatus`, for the dot and the slip. It is one indexed query;
  - `POST /v1/me/whats-new/seen { through }` → 204. It sets `seen_through = GREATEST(existing, LEAST(through, now()))` with an upsert, so a stale tab can never move it backwards.
- **Who reads what** (`listWhatsNew(db, userId)`):
  - entries with `withdrawn_at IS NULL`, `published_revision IS NOT NULL`, `published_audience <> 'staff'` and `live_at IS NOT NULL`, filtered by `shownToUser` with the page's `plan` and `earlyAccess`;
  - `earlyAccess` comes from `earlyAccessOf(profileRow)`. It returns `false` on dev today. Once `feat/early-access` merges, it reads `profiles.early_access` (one line, flagged in the code with `// hook: feat/early-access`);
  - `unseen` counts entries with `live_at > seen_through`. A person with no `changelog_reads` row uses their profile's `created_at` as `seen_through`, so a new person never gets a dot for updates from before they joined.
- **Web:**
  - **Menu:** in `dashboard-shell.tsx`, the `links()` item `{ href: '/dashboard/whats-new', label: 'What's new', phone: false }` goes before Settings. On phones, where the tab bar stays four items, a quiet `What's new` link sits in `dashboard-bar` beside the bell (Open Q5). Both show `dashboard-nav__dot` with the screen-reader text " (new updates)" while `unseen > 0`. Status is read once per profile load and again after the seen call. If the endpoint 404s (an older API), there is no dot.
  - **Slip** (`components/dashboard/whats-new-slip.tsx`): on Home, right after `<UsernameTakeBackBanner />`, one neutral `Slip` titled "New in TipMe" with the newest unseen line, and the keys "See what's new" (a link) and "Close". Close posts `seen` with the newest `liveOn` instant, and so does opening the page. The slip disappears and does not come back on any device until a newer entry goes live. It shows only one, even if several are unseen ("and 2 more" when `unseen > 1`).
  - **Page** `/dashboard/whats-new`:
    - the heading is "What's new";
    - the list is grouped by `liveOn` ("6 November 2026", Lagos time). Each line is `userLine`, and Pro entries also carry a small "Pro" text label;
    - the empty state is `EmptyWell` "Nothing new yet. Updates to TipMe will show here.";
    - on load, it posts `seen` through the newest entry;
    - `robots: noindex` comes from the dashboard layout.
  - **Never public:** nothing under `app/people`, `app/tip`, `app/[handle]` or the appreciation form imports the What's new code. This is a unit test (Task 6.4).
- **Copy:**
  - user lines are approved text. TipMe's own words never name the payment provider or imply regulatory approval (`no-provider-names.test.mjs` covers the source, and `userTextProblems` covers stored text);
  - there is no Pro price;
  - pronouns are "they".

---

## Global Constraints

- **Workspace:**
  - each PR is its own branch off `origin/dev` in its own worktree under `.worktrees/`, and goes into `dev`;
  - never push or merge without the owner (`pnpm pr:merge <n>` only when asked), never use bare `git stash`, never force push.
- **Read first:**
  - `AGENTS.md` and the nearest scoped `AGENTS.md` (`packages/contracts/AGENTS.md`, `packages/database/AGENTS.md` if present, `apps/api/AGENTS.md`, `apps/web/AGENTS.md`);
  - for UI, `docs/design/DESIGN-CONSTITUTION.md` and the documents it requires;
  - `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md` and `docs/agent/HANDOFF.md`, which each PR updates.
- **Not money, but treat the signed endpoints as a security boundary:**
  - authenticate before parsing;
  - no secret in logs, in the repo or in job summaries;
  - GitHub Actions passes the PR title and body only through `env:`, **never** `${{ }}`-interpolated into `run:` (script injection);
  - the draft workflow uses the `pull_request` event (not `pull_request_target`), with `if: github.event.pull_request.merged == true && github.event.pull_request.base.ref == 'dev'` and `permissions: contents: read`.
- **Privacy:**
  - the PR body is parsed and dropped;
  - approver and editor emails are masked in admin views (`maskEmail`);
  - `changelog_reads` holds only a timestamp per person and is deleted with the account;
  - What's new does not go into analytics, except one `track('whats_new_opened')` event with no text (only if the existing analytics consent rules allow it; otherwise none).
- **Copy:** users never see the payment provider's name (`apps/web/test/no-provider-names.test.mjs` must pass), there are no regulatory, legal or compliance claims, and there is no Pro price. Staff screens may name providers, but the user text field refuses it.
- **Accessibility:**
  - every control is at least 44px with a visible label;
  - the dot always has text for screen readers;
  - radios are in a `fieldset` with a `legend`;
  - errors are tied by `aria-describedby`;
  - a save says so in `role="status"`;
  - the slip's Close returns focus to the dashboard's first heading;
  - `expectAccessible(page)` runs in every new e2e test.
- **Migrations:**
  - dev is at `0078`. Take the next free number at write time (other branches claim numbers: check `git log origin/dev -- packages/database/drizzle` and the open plans);
  - generate with `pnpm --filter @tipme/database generate`, with the journal `when` later than every other entry;
  - append the role grants by hand after generating, as `0073` does;
  - never relax `migration-journal.test.mjs`;
  - additive only.
- **Contracts:** shapes only in `packages/contracts`, with no `any`. Every new field the web reads is optional, because the web deploys before the API. An older API (404) draws today's dashboard exactly.
- **OpenAPI:** `pnpm api:openapi` after any route change, and `tests/integration/openapi.test.mjs` must pass.
- **Reporting:** run commands exactly as written, record pass, fail or skipped, and report every failing test by name with its error.

## Review Focus

1. **Signature check before anything.** Missing, stale, wrong or other-secret signatures get 401, with nothing stored and no body logged. The unset secret gets 404 (Tasks 2.2, 2.3).
2. **Live text needs approval.** No path changes `published_*` except `approveEntry`. An edit after approval leaves the published copy untouched. A request approved after an edit is stale (Tasks 1.2, 4.1, 4.2).
3. **The serious-action extension is narrow.** Existing actions behave the same (the existing `ops-serious-actions`, `ops-approvals` and `ops-serious-gating` suites pass unchanged). An asker without `permission` can never run alone (Task 4.2).
4. **"Live" is exact.** An entry goes live only for a version whose history contains its merge commit. A failed sync never fails the deploy and is caught up later (Tasks 3.2, 3.3).
5. **Users see only what is shown to them.** Withdrawn, unapproved, not-yet-live, staff-only and (today) early-access entries never reach `/v1/me/whats-new`. Nothing reaches public pages (Tasks 6.1, 6.4).
6. **The seen marker never moves back,** and is per person, not per browser (Task 6.1).
7. **No regression:** the dashboard with an older API, the ops menu for people without the new permissions, and the approvals screen for existing actions.

---

## PR boundaries and order

| PR                                                | Branch                   | Tasks   | Migration                                                  | Depends on                     | Parallel group                            |
| ------------------------------------------------- | ------------------------ | ------- | ---------------------------------------------------------- | ------------------------------ | ----------------------------------------- |
| **1. Schema and contracts**                       | `feat/changelog-schema`  | 1.0–1.3 | A: `NNNN_changelog` (two tables, both permissions, grants) | —                              | 0 (first)                                 |
| **2. Signed ingest and release marking (API)**    | `feat/changelog-ingest`  | 2.1–2.4 | none                                                       | 1                              | A                                         |
| **3. CI: drafts and the production/staging sync** | `feat/changelog-ci`      | 3.1–3.4 | none                                                       | 1 (wire shapes); merge after 2 | A (build beside 2, against a fake server) |
| **4. Admin API and approval**                     | `feat/changelog-ops-api` | 4.1–4.4 | none                                                       | 1                              | A                                         |
| **5. Admin screens**                              | `feat/changelog-ops-web` | 5.1–5.3 | none                                                       | 1; merge after 4               | A (build beside 4, against the contracts) |
| **6. What's new for users**                       | `feat/whats-new`         | 6.1–6.5 | none                                                       | 1                              | A                                         |

After PR 1 merges, PRs 2, 3, 4, 5 and 6 can be built at the same time. **Merge order:** 1 → {2, 4, 6 in any order} → 3 (after 2: its end-to-end test signs against the real API) → 5 (after 4: its e2e uses the real routes). Users see nothing until PRs 2–4 and 6 are all in **and** the code has reached production. Before that, What's new is simply empty. PR 6's tests seed entries with SQL.

**Turning it on (after all six are in production; recorded in `docs/runbooks/changelog.md`, Task 3.4):**

1. generate a 48-byte secret;
2. set it as the repository Actions secret `CHANGELOG_SIGNING_SECRET` and in the production server's env file (and staging's, Open Q3);
3. set the repository variable `CHANGELOG_API_URL` to the production API URL;
4. deploy production;
5. merge a PR and see the draft appear.

## Overlaps with other branches (do not plan their work)

- **States batches B–I:**
  - PR D (Dashboard) retones `dashboard-shell.tsx` (`:132`, `:154`) and `home-view.tsx` (`:69–85`). PR 6 adds one nav item, one bar link, one import and one `<WhatsNewSlip />` line. Expect textual conflicts, not logic ones. Whichever merges second rebases;
  - PR G (Ops) retones existing ops pages. The new ops pages are built on `Slip`/`ResultKey` from the start, so they need nothing from G;
  - PR I deletes `Notice`/`EmptyState`. Never use them here.
- **Username reservation PR 3 / take-backs (#133, now on dev):** `UsernameTakeBackBanner` sits first on Home, and the What's new slip goes after it. #133 also changed `serious-actions.ts` (`requestId`). Task 4.2 builds on that.
- **Live updates PR 2/3:** nothing here publishes live signals. Once they land, `POST /v1/me/whats-new/seen` could publish a `whats_new.changed` signal so other open tabs drop the dot. That is a one-line follow-up for the live-updates builder, and is not planned here.
- **`feat/early-access`** (pro-additions plan PR 1): it adds `profiles.early_access` and `MyProfile.earlyAccess?`. `earlyAccessOf` is the only hook. Its test is written so it passes before and after that branch merges: it asserts `false` when the column is missing, and the column's value when present.
- **Make-it-yours B/D, animated covers (#127):** no shared files.
- **Roles masking and rewards boards:** still awaiting the owner. `changelog.edit` on every role is the only role change here.

---

## PR 1: Schema and contracts

### Task 1.0: Bring the board into the repo, and record the decision

**Files:**

- Create: `docs/design/redesign/boards/Changelog.dc.html`, copied unchanged once exported from the canvas. If it cannot be exported, record "board on the canvas only, not in the repo" in the decision entry and go on.
- Modify: `docs/00-DECISIONS.md` and `docs/design/DECISION-LOG.md`.

- [ ] **Step 1: Check, expecting FAIL.**

  ```bash
  grep -q "Changelog and What's new (owner, 5–6 Nov 2026)" docs/00-DECISIONS.md
  ```

- [ ] **Step 2: Write the entries.**
  - `00-DECISIONS.md`: "Changelog and What's new (owner, 5–6 Nov 2026)". It records that drafts come from merged PRs, one approval by `changelog.publish`, in-app only with no email, the "reached production" mechanism (Design §2), and the copy rules. Say it is a product decision, not a legal, regulatory or provider approval. List Open Q1–Q8.
  - `DECISION-LOG.md`: the dashboard gains a fifth desktop menu item and a phone bar link.
- [ ] **Step 3:** Run Step 1 again, expecting PASS, then `pnpm exec prettier --check docs/00-DECISIONS.md docs/design`.
- [ ] **Step 4: Commit** `docs: changelog and What's new board and decision`.

### Task 1.1: Contracts

**Files:**

- Create: `packages/contracts/src/changelog.ts`.
- Modify:
  - `packages/contracts/src/index.ts`;
  - `ops-catalogue.ts` (two permissions; `SERIOUS_ACTIONS` += `'changelog.publish'`, with the words "Show users a What's new entry" and the permission `changelog.publish`);
  - `errors.ts` (`CHANGELOG_SIGNATURE_INVALID`, `CHANGELOG_EDITED_ELSEWHERE`, `CHANGELOG_TEXT_NOT_ALLOWED`, `CHANGELOG_NOT_FOUND`, `APPROVAL_NO_APPROVER`).
- Test: `packages/contracts/test/changelog.test.mjs` (new) and `ops-catalogue.test.mjs` (extend).

**Interfaces:** Design §1.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('firstParagraph stops at the first blank line or heading and drops HTML comments', ...);
  //   'Fixes the bell.\nIt was slow.\n\n## Scope' -> 'Fixes the bell. It was slow.'; '<!-- hint -->\nText' -> 'Text'; '' and null-ish -> ''
  test('forUsersSection reads "## For users" up to the next heading, any level and case', ...);
  //   '## Scope\nx\n## For users\n<!-- what users notice -->\nYou can now…\n\n## Evidence' -> 'You can now…'
  //   no section, or only the template comment -> ''
  test('draftFromPullRequest: empty For users makes a staff-only entry', ...);
  //   { title: 'fix(ci): x', body: 'Why.\n\n## For users\n' } -> { staffText: 'fix(ci): x — Why.', userText: null, audience: 'staff' }
  test('draftFromPullRequest: a For users section becomes the working user text, audience everyone', ...);
  test('staff text and user text are cut at a word within their limits, counted in code points', ...);
  //   '😀'.repeat(300) user text -> 280 code points
  test('userTextProblems flags the provider name and regulatory claims, and passes plain updates', ...);
  //   'Payouts via Bachs are faster' -> ['provider_name']; 'TipMe is now licensed' -> ['regulatory_claim'];
  //   'You can pin a supporter note.' -> []; 'Approved by the CBN' -> ['regulatory_claim']
  test('changelogState covers draft, approved, live, recorded and withdrawn', ...);
  test('hasUnapprovedEdit is true only after an edit to an approved entry', ...);
  test('shownToUser: everyone and pro to all pages; early_access only to Pro with it on; staff never', ...);
  test('userLine adds "On Pro, " to Pro entries once', ...);
  //   'you can pick a starting amount.' -> 'On Pro, you can pick a starting amount.'; 'On Pro you…' unchanged
  test('wire schemas are strict and bounded', ...);
  //   a 41-char sha, a body over 65536, an unknown key, version not 12 hex, 2001 contained numbers all fail
  // ops-catalogue.test.mjs:
  test('changelog.edit is not sensitive; changelog.publish is, and names its serious action', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm --filter @tipme/contracts build && node --test packages/contracts/test/changelog.test.mjs packages/contracts/test/ops-catalogue.test.mjs
  ```

- [ ] **Step 3: Implement.** Count with `Array.from(s).length`. Use one shared `PROVIDER_WORD = /\bbachs\b/i` and export it, so the web test and this check name the same word.
- [ ] **Step 4: Run, expecting PASS**, then `pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck && pnpm --filter @tipme/contracts lint`.
- [ ] **Step 5: Commit** `feat(contracts): changelog entries, What's new shapes and the two permissions`.

### Task 1.2: Schema and migration

**Files:**

- Modify: `packages/database/src/schema.ts` (`changelogEntries`, `changelogReads`, with their checks and indexes).
- Create: `packages/database/drizzle/NNNN_changelog.sql`, its snapshot and journal entry.
- Test: `packages/database/test/integration/changelog-schema.test.mjs` (new) and `migration-journal.test.mjs` (must pass).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('the checks refuse a bad sha, a 281-character user text, a user text with audience staff, and half-published rows', ...);
  test('withdrawn columns are all set or all null', ...);
  test('owner holds changelog.edit and changelog.publish; every other role except release_check holds changelog.edit', ...);
  //   seed a custom role before migrating (or insert then re-run the grant SQL) and assert role_permissions
  test('role_permissions_known accepts both new permissions and still refuses an unknown one', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/changelog-schema.test.mjs packages/database/test/integration/migration-journal.test.mjs
  ```

- [ ] **Step 3: Implement.** Write the schema, then run `pnpm --filter @tipme/database generate`. Append by hand:

  ```sql
  -- ensureOwnerRole runs only when an owner is granted, so the existing owner gets both here.
  INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT "id", p FROM "roles", unnest(ARRAY['changelog.edit', 'changelog.publish']) AS p WHERE "id" = 'owner'
  ON CONFLICT DO NOTHING;
  -- The owner's default (6 Nov 2026): every staff role can edit and ask; release_check stays fixed.
  INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT "id", 'changelog.edit' FROM "roles" WHERE "id" NOT IN ('owner', 'release_check')
  ON CONFLICT DO NOTHING;
  ```

- [ ] **Step 4:** Run Step 2's command, expecting PASS, then `pnpm --filter @tipme/database typecheck && pnpm --filter @tipme/database lint`.
- [ ] **Step 5: Commit** `feat(database): changelog entries and What's new reads`.

### Task 1.3: Full checks, handoff and PR

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`, recording each result. The e2e suite is not needed, because nothing is drawn yet.
- [ ] Update ACTIVE_TASK and HANDOFF with the verified state and the next step (PRs 2–6 can start).
- [ ] **Commit** `docs: changelog PR 1 handoff`.

---

## PR 2: Signed ingest and release marking (API)

### Task 2.1: Database operations for drafts and releases

**Files:**

- Create: `packages/database/src/operations/changelog.ts` (the part for this PR).
- Modify: `packages/database/src/index.ts` and `operations/errors.ts`.
- Test: `packages/database/test/integration/changelog-ingest.test.mjs` (new).

**Interfaces (produces):**

```ts
export function recordChangelogDraft(
  db: Database,
  pr: ChangelogDraft,
  now?: Date,
): Promise<{ created: boolean }>;
export function pendingForRelease(
  db: Database,
  environment: 'staging' | 'production',
): Promise<{ number: number; mergeSha: string }[]>;
// staging: staging_at IS NULL AND withdrawn_at IS NULL; production: live_at IS NULL AND withdrawn_at IS NULL. Oldest first, at most 2000.
export function markReleased(
  db: Database,
  input: {
    environment: 'staging' | 'production';
    version: string;
    contained: number[];
    now?: Date;
  },
): Promise<{ marked: number[] }>;
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a draft is created once; sending it again changes nothing, even after staff edits', ...);
  test('a draft without a For users section is staff only and recorded', ...);
  test('the PR body is not stored anywhere', ...);
  //   send a body with a unique marker; SELECT across changelog_entries and audit_log text columns finds no marker
  test('pending lists entries not yet live and not withdrawn, oldest first', ...);
  test('markReleased sets live_at and live_version once; a second call keeps the first date', ...);
  test('staging marking sets staging_at only, never live_at', ...);
  test('markReleased ignores unknown numbers and withdrawn entries, and writes one changelog.released audit entry', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/changelog-ingest.test.mjs
  ```

- [ ] **Step 3: Implement** with `guarded`, one transaction each, using `draftFromPullRequest` from contracts.
- [ ] **Step 4:** Run, expecting PASS, then typecheck and lint the database package.
- [ ] **Step 5: Commit** `feat(database): record changelog drafts and what each environment now runs`.

### Task 2.2: The signature check

**Files:**

- Create: `apps/api/src/changelog/changelog-signature.ts`.
- Modify: `apps/api/src/config.ts` (`CHANGELOG_SIGNING_SECRET`).
- Test: `apps/api/test/changelog-signature.test.mjs` (new; if the API has no unit test folder, put it in `tests/integration/changelog-ingest-api.test.mjs`).

```ts
/** True only for `sha256=<hex>` over `${timestamp}.${raw}` with this secret, within 300 s of now. */
export function changelogSignatureValid(input: {
  secret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  raw: Buffer;
  now: number;
}): boolean;
```

- [ ] **Step 1: Write the failing tests:** valid; wrong secret; timestamp 301 s old and 301 s ahead; a missing header; a non-hex signature; an empty secret (always false); a body changed by one byte.
- [ ] **Step 2: Run, expecting FAIL.** **Step 3: Implement** (the HMAC with `timingSafeEqual` over the decoded digest, after a length check). **Step 4: Run, expecting PASS.**
- [ ] **Step 5: Commit** `feat(api): the changelog signature check`.

### Task 2.3: The three routes

**Files:**

- Create: `apps/api/src/changelog/changelog-webhook.controller.ts` and `changelog.module.ts`.
- Modify:
  - `apps/api/src/app.module.ts`;
  - the rate-limit buckets (`changelog_ingest`);
  - `apps/api/src/http/api-exception.filter.ts` (401 `CHANGELOG_SIGNATURE_INVALID`);
  - `apps/api/src/openapi/document.ts` and `docs/api/openapi.json`;
  - `deploy/compose.production.yml` and `deploy/compose.staging.yml` (`CHANGELOG_SIGNING_SECRET: ${CHANGELOG_SIGNING_SECRET:-}` on the API service only);
  - `scripts/production-compose.test.mjs` if it pins the env list;
  - `tests/integration/helpers.mjs` (`CHANGELOG_SECRET`, passed to `startStack`).
- Test: `tests/integration/changelog-ingest-api.test.mjs` (new), `preview-gate.test.mjs` (extend) and `openapi.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a signed draft is stored and answered { created: true }; the same again { created: false }', ...);
  test('an unsigned, stale or wrongly signed request is 401 and stores nothing', ...);
  test('with no secret configured every changelog route is 404', ...);
  test('pending then releases marks only the numbers sent, and pending no longer lists them', ...);
  test('a body over 128 KiB is refused before parsing', ...);
  test('the routes pass the staging preview gate without a cookie, and nothing else new does', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/changelog-ingest-api.test.mjs tests/integration/preview-gate.test.mjs tests/integration/openapi.test.mjs
  ```

- [ ] **Step 3: Implement.** Read `request.rawBody` and verify it _before_ `ZodValidationPipe` (parse by hand after the check). Log only route and status. Then run `pnpm api:openapi`.
- [ ] **Step 4:** Run, expecting PASS, then `pnpm --filter @tipme/api typecheck && pnpm --filter @tipme/api lint`.
- [ ] **Step 5: Commit** `feat(api): signed changelog drafts, pending list and release marking`.

### Task 2.4: Full checks, threat model line, handoff

- [ ] Add the signed changelog endpoints to `docs/security/` threat model (the file the repo uses; find it with `ls docs/security`), with their secret, freshness window and what is stored.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`, then update ACTIVE_TASK/HANDOFF and commit `docs: changelog ingest handoff`.

---

## PR 3: CI: drafts and the sync

### Task 3.1: The signing client and the draft sender

**Files:**

- Create: `scripts/changelog-client.mjs` (`sign(secret, raw, now)`, `post(url, path, body, secret)`, with a 10 s timeout and one retry on network error or 5xx only);
- Create: `scripts/changelog-send.mjs`. It reads `PR_NUMBER`, `PR_TITLE`, `PR_BODY`, `PR_MERGE_SHA`, `PR_MERGED_AT`, `CHANGELOG_API_URL` and `CHANGELOG_SIGNING_SECRET` from env and posts the draft;
- Create: `scripts/changelog-client.test.mjs` and `scripts/changelog-send.test.mjs`.

- [ ] **Step 1: Write the failing tests** against a local `http.createServer` fake:
  - the signature matches the API's format. This is a fixture shared with Task 2.2: the same secret, timestamp and body give the same hex, pinned in both tests;
  - a title containing `$(rm -rf /)` and backticks is sent verbatim as JSON;
  - a 401 exits 1 with "signature refused";
  - a missing secret exits 0 with a `::notice::` "Changelog not set up" (so the PRs merged before setup don't fail CI);
  - a 5xx is retried once.
- [ ] **Step 2: Run, expecting FAIL:** `node --test scripts/changelog-client.test.mjs scripts/changelog-send.test.mjs`. **Step 3: Implement.** **Step 4: Run, expecting PASS.**
- [ ] **Step 5: Commit** `feat(ci): sign and send a changelog draft`.

### Task 3.2: The sync script

**Files:** create `scripts/changelog-sync.mjs` and `scripts/changelog-sync.test.mjs`.

```
node scripts/changelog-sync.mjs --environment production|staging --version <12-hex> [--api <url>]
```

The steps are those of Design §2. It uses `execFileSync('git', ['merge-base', '--is-ancestor', sha, version])`, never a shell. It writes to `$GITHUB_STEP_SUMMARY` when that is set. It exits 0 when the secret is missing (with a notice), and 1 on any other failure. The workflow step is `continue-on-error`.

- [ ] **Step 1: Write the failing tests**, in a temporary git repo built in the test:
  - a `dev` with merges A and B, and a `main` that merged dev after A only;
  - a sync at main's head marks A and not B;
  - after main merges dev again, a sync marks B;
  - a squash-merged PR's sha (on dev, merged into main by a merge commit) is contained;
  - an unknown sha is listed in the summary and skipped;
  - a pending entry older than 14 days and not contained is listed as "not in this version after 14 days: check that main still merges dev with a merge commit";
  - nothing contained → no `releases` call.
- [ ] **Step 2: Run, expecting FAIL:** `node --test scripts/changelog-sync.test.mjs`. **Step 3: Implement.** **Step 4: Run, expecting PASS.**
- [ ] **Step 5: Commit** `feat(ci): mark changelog entries live by git ancestry`.

### Task 3.3: Workflows and the PR template

**Files:**

- Create: `.github/workflows/changelog-draft.yml`:
  - `on: pull_request: types: [closed], branches: [dev]` plus `workflow_dispatch` with the input `number`. The dispatch reads the PR with `gh pr view` to resend one PR, for catching up;
  - the job `if: github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true`;
  - `permissions: contents: read` (plus `pull-requests: read` for dispatch);
  - checkout of `github.event.pull_request.merge_commit_sha` with `persist-credentials: false`;
  - `env:` takes `PR_TITLE: ${{ github.event.pull_request.title }}` and the others; the `run:` is only `node scripts/changelog-send.mjs`.
- Create: `.github/workflows/changelog-sync.yml`:
  - `workflow_dispatch` with the input `environment` (staging|production);
  - full-history checkout of `main` (production) or `dev` (staging);
  - reads the version from `vars.PRODUCTION_API_URL` / `vars.STAGING_API_URL` `/health/release`, then runs the sync.
- Modify:
  - `deploy-production.yml`: after "Release check (read-only)", the step "Changelog: what is now live", with `if: success()`, `continue-on-error: true`, `env: CHANGELOG_API_URL: ${{ vars.CHANGELOG_API_URL }}` and `CHANGELOG_SIGNING_SECRET: ${{ secrets.CHANGELOG_SIGNING_SECRET }}`. Update the header comment listing secrets and variables;
  - `deploy-staging.yml`: the same after the release check, with `--environment staging`. It goes before "Record the full staging pass", so it is never between the check and the record that production's gate reads. Being `continue-on-error`, it cannot stop that record;
  - `.github/PULL_REQUEST_TEMPLATE.md`: add `## For users` with the comment `<!-- One or two sentences a recipient would notice, in plain words. Leave empty if they won't notice anything. Never name our payment partner; never say TipMe is licensed or approved. -->`.
- Test:
  - `scripts/deploy-production.test.mjs` / `ship-production.test.mjs`, if they pin the workflow's steps (check them);
  - add `scripts/changelog-workflows.test.mjs`. It parses the YAML as text and asserts that no `run:` block contains `github.event.pull_request.title` or `.body`, that both sync steps are `continue-on-error: true`, and that the staging sync comes before the staging-pass record.

- [ ] **Step 1:** Write `changelog-workflows.test.mjs`, and run it expecting FAIL.
- [ ] **Step 2:** Implement the workflows, then run `node --test scripts/*.test.mjs`, expecting PASS.
- [ ] **Step 3:** Run `bash scripts/check-governance.sh`, which lints the workflows and governance.
- [ ] **Step 4: Commit** `ci: draft changelog entries on merge and mark them live on deploy`.

### Task 3.4: The end-to-end check against the API, the runbook, handoff

**Files:** `tests/integration/changelog-ci.test.mjs` (new; this needs PR 2 on dev, so rebase first) and `docs/runbooks/changelog.md` (new).

- [ ] **Step 1: The test:**
  - start the stack with a secret;
  - run `scripts/changelog-send.mjs` as a child process with env, and see the draft;
  - run `scripts/changelog-sync.mjs` against a temporary repo whose sha the draft names, and see `live_at`.
- [ ] **Step 2: The runbook:**
  - turning it on (PR boundaries above);
  - resending a draft;
  - running a sync by hand;
  - rotating the secret (set the new one in both places, then deploy);
  - the known limits from Design §2.
- [ ] **Step 3:** Run the full checks, update ACTIVE_TASK/HANDOFF, and commit `docs: changelog runbook`.

---

## PR 4: Admin API and approval

### Task 4.1: Database operations for admin

**Files:**

- Modify: `packages/database/src/operations/changelog.ts` and `operations/errors.ts`.
- Test: `packages/database/test/integration/changelog-admin.test.mjs` (new).

**Interfaces (produces):**

```ts
export function listChangelog(
  db: Database,
  q: { view: 'all' | 'drafts' | 'users' | 'staff'; before?: number },
): Promise<{ rows: OpsChangelogRow[]; nextBefore: number | null }>;
export function readChangelogEntry(
  db: Database,
  number: number,
): Promise<OpsChangelogEntry>; // CHANGELOG_NOT_FOUND
export function editChangelogEntry(
  db: Database,
  input: {
    staffUserId: string;
    number: number;
    patch: OpsChangelogEdit;
    now?: Date;
  },
): Promise<OpsChangelogEntry>;
export function approveChangelogEntry(
  tx: Database | Tx,
  input: {
    number: number;
    revision: number;
    approverId: string;
    reason: string;
    now?: Date;
  },
): Promise<OpsChangelogEntry>;
// CHANGELOG_EDITED_ELSEWHERE if revision moved; CHANGELOG_TEXT_NOT_ALLOWED (detail: problems) if userTextProblems non-empty;
// clears withdrawn_* when re-approving a withdrawn entry, audited as such.
export function withdrawChangelogEntry(
  db: Database,
  input: { staffUserId: string; number: number; reason: string; now?: Date },
): Promise<OpsChangelogEntry>;
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('the views: drafts holds unapproved and edited-after-approval entries; users holds published ones; staff holds recorded', ...);
  test('editing the user text bumps the revision and leaves the published copy as it was', ...);
  test('editing with an old revision is refused and nothing changes', ...);
  test('clearing the user text makes the entry staff only', ...);
  test('approval copies text and audience at that revision, records who and when, and is audited', ...);
  test('approval refuses a text naming the payment provider or claiming a licence', ...);
  test('withdrawal needs a reason, hides it from the user view, and keeps it in admin as withdrawn', ...);
  test('a withdrawn entry edited and approved again is shown again, and the audit says it was restored', ...);
  test('staff text edits never touch the revision', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/changelog-admin.test.mjs
  ```

- [ ] **Step 3: Implement.** Edits and approvals take `SELECT … FOR UPDATE` on the entry row.
- [ ] **Step 4:** Run, expecting PASS, then typecheck and lint.
- [ ] **Step 5: Commit** `feat(database): edit, approve and withdraw changelog entries`.

### Task 4.2: Asking with one permission, deciding with another

**Files:**

- Modify: `packages/database/src/operations/serious-actions.ts` (`askPermission?` on `SeriousActionDefinition`; `registerSeriousAction` checks it; `requestSeriousAction` uses it for the requester check; the new `APPROVAL_NO_APPROVER` branch) and `serious-actions-registered.ts` (register `changelog.publish`: payload `{ number, revision }`, `askPermission: 'changelog.edit'`, plus `describe`, `current`, `target`, `validate` and `run` as in Design §4).
- Test: `tests/integration/ops-serious-actions.test.mjs` (extend) and `tests/integration/changelog-approval.test.mjs` (new).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('an editor without changelog.publish asks; the request waits for a publisher and shows its full text', ...);
  test('a publisher approving it publishes exactly the asked revision', ...);
  test('an edit after asking makes the request stale at approval, and nothing is published', ...);
  test('with no publisher able to enter a code, an editor is refused APPROVAL_NO_APPROVER and nothing runs alone', ...);
  test('the requester cannot approve their own request, by id or by shared mailbox', ...);
  test('someone with neither permission cannot ask', ...);
  // ops-serious-actions.test.mjs:
  test('actions without askPermission still require the requester to hold the permission, and still run alone without a second person', ...);
  test('registering an action with an unknown askPermission throws', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/changelog-approval.test.mjs tests/integration/ops-serious-actions.test.mjs tests/integration/ops-approvals.test.mjs tests/integration/ops-serious-gating.test.mjs tests/integration/ops-serious-routes.test.mjs
  ```

- [ ] **Step 3: Implement.** The change at `requestSeriousAction`'s permission check is:

  ```ts
  const askWith = action.askPermission ?? action.permission;
  if (
    !actorId ||
    !access?.permissions.has(askWith) ||
    !(await canEnterCode(tx, actorId))
  )
    throw new OperationError('PERMISSION_NOT_HELD');
  // … after `approvers` is known, before the run-alone branch:
  if (approvers.length === 0 && !access.permissions.has(action.permission))
    throw new OperationError('APPROVAL_NO_APPROVER');
  ```

  Add a docblock on `askPermission` saying why: the person asking may not be able to act directly, so they can never run it alone.

- [ ] **Step 4:** Run, expecting PASS, then typecheck and lint.
- [ ] **Step 5: Commit** `feat(ops): an action may be asked for with one permission and decided with another`.

### Task 4.3: The admin routes

**Files:**

- Create: `apps/api/src/ops/changelog.controller.ts`.
- Modify:
  - `apps/api/src/ops/ops.module.ts`;
  - `api-exception.filter.ts` (409 `CHANGELOG_EDITED_ELSEWHERE`, 422 `CHANGELOG_TEXT_NOT_ALLOWED` with `fields: ['userText']` and the problems in `detail`, 404 `CHANGELOG_NOT_FOUND`, 409 `APPROVAL_NO_APPROVER`);
  - the OpenAPI document and `docs/api/openapi.json`.
- Test: `tests/integration/changelog-ops-api.test.mjs` (new) and `ops-serious-routes.test.mjs` / the route-pinning tests (extend with the new routes).

| Route                                     | Permission                            | Fresh code                                            | Limit         |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------------- | ------------- |
| `GET /v1/ops/changelog?view&before`       | `changelog.edit`, `changelog.publish` | no (not sensitive for edit holders)                   | `ops_read`    |
| `GET /v1/ops/changelog/:number`           | same                                  | no                                                    | `ops_read`    |
| `PUT /v1/ops/changelog/:number`           | `changelog.edit`, `changelog.publish` | no                                                    | `ops_request` |
| `POST /v1/ops/changelog/:number/ask`      | `changelog.edit`                      | yes (`requestSeriousAction` asserts it)               | `ops_request` |
| `POST /v1/ops/changelog/:number/approve`  | `changelog.publish`                   | yes                                                   | `ops_request` |
| `POST /v1/ops/changelog/:number/withdraw` | `changelog.edit`, `changelog.publish` | no (hiding must work at once; reason and audit apply) | `ops_request` |

The reads and the withdraw on a route that also names the sensitive `changelog.publish` need `OPS_FRESH_CODE_EXEMPT` entries if the guard demands a fresh code for any sensitive permission named. Check how `@FreshCode()` and the route tests treat a mixed list, and add each exemption with its reason.

- [ ] **Step 1: Write the failing tests:**
  - each route's permission and fresh-code rule;
  - an editor's ask returns `{ state: 'pending', requestId }` and the request appears in `GET /v1/ops/approvals` for a publisher;
  - a publisher's approve publishes;
  - a withdraw with no reason gets 400;
  - a mixed-case or negative `:number` gets 404;
  - approver emails are masked in the entry.
- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/changelog-ops-api.test.mjs tests/integration/ops-serious-routes.test.mjs tests/integration/openapi.test.mjs
  ```

- [ ] **Step 3: Implement**, then `pnpm api:openapi`. **Step 4: Run, expecting PASS**, then typecheck and lint.
- [ ] **Step 5: Commit** `feat(api): the changelog in admin`.

### Task 4.4: Full checks, handoff

- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`, then update ACTIVE_TASK/HANDOFF and commit.

---

## PR 5: Admin screens

### Task 5.1: The menu link

**Files:** `apps/web/src/lib/ops-menu.ts` (one `LINKS` line, and update the docblock comment) and `apps/web/test/ops-menu.test.mjs`.

- [ ] **Step 1: Write the failing test:**
  - `changelog.edit` alone shows "Changelog" under "Email and records", after "Audit log";
  - `changelog.publish` alone shows it too;
  - neither hides it;
  - a person holding only `changelog.edit` still sees the "Email and records" group (with just Changelog).
- [ ] **Step 2:** Run `node --test apps/web/test/ops-menu.test.mjs`, expecting FAIL. **Step 3: Implement.** **Step 4: Run, expecting PASS.**
- [ ] **Step 5: Commit** `feat(web): Changelog in the admin menu`.

### Task 5.2: The list and the entry page

**Files:**

- Create: `apps/web/src/app/ops/changelog/page.tsx` and `apps/web/src/app/ops/changelog/[number]/page.tsx`.
- Modify: `apps/web/src/app/globals.css` (`.ops-changelog*`, only if the ops frame's tokens don't cover it).
- Test: `tests/e2e/ops-changelog.spec.ts` (new). Seed entries with `sql` from `tests/e2e/ops-helpers.ts`. Use `enrolOwner`, plus a second staff member on a custom role holding only `changelog.edit` (see `ops-staff.spec.ts` for making one).

- [ ] **Step 1: Write the failing e2e tests.**

  ```ts
  test('the owner sees every merged PR and filters Drafts, For users and Staff only', ...);
  test('the owner edits the user text, sees the exact user line ("On Pro, …" for Pro), approves with a code, and the state reads Approved', ...);
  test('a text naming the payment partner is refused next to the field with the reason', ...);
  test('an editor asks for approval; it appears on Approvals for the owner; approving there publishes it', ...);
  test('editing after asking: Approvals says the request went stale', ...);
  test('withdrawing asks for a reason and marks the entry Withdrawn; it stays in All', ...);
  test('early access audience says nobody sees it until early access exists', ...);
  // expectAccessible(page) in each
  ```

- [ ] **Step 2:** Run `pnpm test:e2e -- tests/e2e/ops-changelog.spec.ts`, expecting FAIL.
- [ ] **Step 3: Implement** as Design §5. Use `opsFetch`/`opsAct` (`lib/ops-staff-api`), `ReasonAction`, the `FreshCode` flow, `Slip`, `ResultKey`, `EmptySlip` and `StateLine` for the state stamp. Text is in sentence case.
- [ ] **Step 4:** Run, expecting PASS, then `pnpm test:e2e -- tests/e2e/ops-screens.spec.ts tests/e2e/ops.spec.ts` (no regressions), `node --test apps/web/test/no-provider-names.test.mjs`, and `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`.
- [ ] **Step 5: Commit** `feat(web): the changelog list and entry page in admin`.

### Task 5.3: Screens for review, handoff

- [ ] Add both pages to the review gallery, if `scripts/review-screens.mjs` lists ops pages. Run the full checks, update ACTIVE_TASK/HANDOFF, and commit.

---

## PR 6: What's new for users

### Task 6.1: Reads and the seen marker

**Files:**

- Modify:
  - `packages/database/src/operations/changelog.ts` (`listWhatsNew`, `whatsNewStatus`, `markWhatsNewSeen`, `earlyAccessOf`);
  - `operations/profiles.ts` (`deleteAccount` deletes the `changelog_reads` row).
- Test: `packages/database/test/integration/whats-new.test.mjs` (new).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('only approved, live, not withdrawn, user-facing entries are listed, newest first, with their Lagos live date', ...);
  test('a Free page sees Pro entries as "On Pro, …"; nobody sees early-access entries until early access exists', ...);
  //   guarded: if profiles has an early_access column, a Pro page with it on sees them and a Free page does not
  test('an edit after approval shows the approved text, not the edit', ...);
  test('unseen counts entries live after the marker; a new person starts at their profile creation', ...);
  test('the marker never moves back and never past now', ...);
  test('deleting the account removes the marker', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/whats-new.test.mjs
  ```

- [ ] **Step 3: Implement.** **Step 4: Run, expecting PASS**, then typecheck and lint.
- [ ] **Step 5: Commit** `feat(database): What's new for each person, and when they last looked`.

### Task 6.2: The routes

**Files:** `apps/api/src/dashboard/whats-new.controller.ts` (new), `dashboard.module.ts`, the OpenAPI document and `docs/api/openapi.json`. Test: `tests/integration/whats-new-api.test.mjs` (new).

- [ ] **Step 1: Write the failing tests:**
  - signed out gets 401;
  - a CSRF-less `seen` is refused;
  - the list and the status agree;
  - `seen` clears `unseen` for a second session of the same person (another device);
  - a staff-only or withdrawn entry never appears;
  - the response has no `prNumber`-derived staff text.
- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/whats-new-api.test.mjs tests/integration/openapi.test.mjs
  ```

- [ ] **Step 3: Implement**, then `pnpm api:openapi`. **Step 4: Run, expecting PASS.**
- [ ] **Step 5: Commit** `feat(api): What's new routes`.

### Task 6.3: The menu, the slip and the page

**Files:**

- Create:
  - `apps/web/src/app/dashboard/whats-new/page.tsx`;
  - `apps/web/src/components/dashboard/whats-new-slip.tsx`;
  - `apps/web/src/lib/whats-new.ts`. It holds `useWhatsNewStatus()`, one loader shared by the shell and Home through a small context in `recipient-context` or its own provider. It also holds the `WHATS_NEW_SEEN` window event, dispatched after the seen call, so the dot and the slip clear together.
- Modify:
  - `dashboard-shell.tsx` (the nav item, the phone bar link and the dot);
  - `home-view.tsx` (`<WhatsNewSlip />` after `<UsernameTakeBackBanner />`);
  - `globals.css` (the phone-only link `.dashboard-bar__whats-new`, which follows the existing `data-desktop-only` pattern in reverse).
- Test:
  - `tests/e2e/whats-new.spec.ts` (new);
  - `tests/e2e/dashboard.spec.ts` (it must pass, and its nav assertions gain "What's new" on desktop);
  - `apps/web/test/whats-new.test.mjs` (new, for the `lib` functions).

- [ ] **Step 1: Write the failing tests.**

  ```ts
  test('after an update goes live, the menu shows a dot and Home shows one slip with the newest line', ...);
  test('closing the slip clears it and the dot, and a second browser context for the same person sees neither', ...);
  test('opening What's new lists entries newest first under their dates, Pro ones say "On Pro"', ...);
  test('a withdrawn entry disappears from What's new', ...);
  test('nothing new: no dot, no slip, and the page says so', ...);
  test('on a phone the tab bar keeps four items and What's new is beside the bell', ...);
  test('an API without What's new: the dashboard looks exactly as before', ...);
  //   route '/v1/me/whats-new/status' to 404 with page.route; no dot, no slip, no error
  // expectAccessible(page) in each
  ```

- [ ] **Step 2:** Run `pnpm test:e2e -- tests/e2e/whats-new.spec.ts tests/e2e/dashboard.spec.ts`, expecting FAIL.
- [ ] **Step 3: Implement** as Design §6.
- [ ] **Step 4:** Run, expecting PASS, then `node --test apps/web/test/whats-new.test.mjs apps/web/test/no-provider-names.test.mjs` and `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`.
- [ ] **Step 5: Commit** `feat(web): What's new in the dashboard`.

### Task 6.4: Never on public pages

**Files:** `apps/web/test/whats-new-private.test.mjs` (new).

- [ ] **Step 1:** Write a test that walks the files under `apps/web/src/app/people`, `apps/web/src/app/tip`, `apps/web/src/app/[handle]` (whichever exist), `components/appreciation-form.tsx` and `components/profile/`. It asserts that none imports `whats-new` or calls `/v1/me/whats-new`. Then write an e2e assertion in `whats-new.spec.ts` that the recipient's public page and the tip form have no "What's new" text, even with an unseen update.
- [ ] **Step 2:** Run both, expecting PASS. A failure means a leak, so fix the import, not the test.
- [ ] **Step 3: Commit** `test(web): What's new stays inside the dashboard`.

### Task 6.5: Privacy page line, full checks, handoff

- [ ] If the privacy page lists what TipMe stores per person, add "when you last opened What's new". Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e`, update ACTIVE_TASK/HANDOFF, and commit.

---

## Open for the owner

Each item has a default the builder ships with. Changing one is a small edit.

1. **Pro entries for Free pages.** Default: everyone sees them, worded "On Pro, …". The alternative is to show them to Pro pages only.
2. **One approval, even when the approver also wrote the text.** Default: yes. A publisher's own Approve is the one approval, and an editor without publish asks a publisher. The alternative is to always require a second person (it would then run through the serious-action flow, with "acted alone" alerts while the owner is the only publisher).
3. **Where drafts go.** Default: production only (`CHANGELOG_API_URL` = the production API), plus the staging _sync_ that sets "on staging". Staging's own database gets no drafts, unless the owner wants them there for testing.
4. **`changelog.publish` is "sensitive".** The approvals flow requires that. It means its routes need a fresh code, and adding it to a role needs a second person. Default: accept.
5. **The phone placement.** Default: the four-item tab bar stays, and "What's new" is a small link beside the bell on phones (and a menu item on desktop). The board says "dashboard menu"; this is how it reads on a phone.
6. **Rollbacks.** Default: an entry stays Live if production is rolled back. Staff withdraw it if the change is really gone.
7. **Withdrawing.** Default: anyone with `changelog.edit` can withdraw, with a reason, at once. Showing it again needs a new approval. The alternative is publishers only.
8. **Older PRs.** Default: no backfill. The changelog starts at the first PR merged after it is switched on. A one-off resend of chosen PR numbers is possible through `changelog-draft.yml`'s dispatch input.

## Reported, not fixed

- A hotfix merged straight into `main` (#135 style) gets no entry of its own. Its `dev` twin's entry goes live only when `dev` next reaches `main`.
- `main` must keep merging `dev` with a merge commit, or ancestry breaks. The sync makes this visible but cannot fix it.
