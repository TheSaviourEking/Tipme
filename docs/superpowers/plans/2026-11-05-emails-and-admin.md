# Emails and admin, in the new style: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every email TipMe sends wears the new paper-and-slab style from the four email boards, with the board's compositions for the emails they draw. The admin area (`/ops`) gets the board's frame: a grouped sidebar on desktop, a "Menu" sheet on a phone, the black staff strip, and the shared patterns (paper sections, wells, tiles, tables that stack on a phone, facts, badges, code cells), applied to every admin page. The board's few proposals that need data (the Approvals count, plain words in the Audit log, links and badges in Search) ship last, each in a small PR.

**Owner's request:** the boards below were approved for building on 5 Nov 2026 ("every email in the new style", "the admin restyle"). This is a visual and copy decision. It is not legal, regulatory or provider approval: no D-item in `docs/00-DECISIONS.md` changes, and nothing about fees, the minimum, checkout, payouts, the ledger or any staff action's rules changes.

**Boards (static HTML, read as specs),** in `/private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/canvas-email/project/`:

- `EmailTip.dc.html`: "you got a tip" (desktop inbox and phone).
- `EmailAccount.dc.html`: sign-in code, confirm an email address, getting back in, welcome.
- `EmailSecurity.dc.html`: bank account changed, new sign-in, number about to change, account deleted.
- `EmailReports.dc.html`: weekly report, ready for tips, staff invitation, and "coming soon: a username taken back" (owned by username reservation PR 2, see below).
- `OpsShell.dc.html`: the frame, the Overview (desktop and phone), the phone menu, and patterns 1 to 4 (list with filters, table, detail view, serious action and second person, the same states on every page).
- `OpsPages.dc.html`: Approvals, Audit log, Email, Visibility, Market, Pages, Search, Providers, Provider test, Your access, People, Roles.
- Context only: `DesignMap.dc.html` (all four email boards and both ops boards are "Not built": `/ops` and `packages/mail` use the old style), `ScreenAudit.dc.html` (no review screenshot exists for any `/ops` route).

**Not in this plan (others own them, or they are not approved):**

- **States batch G** (states plan `2026-11-05-states.md`, Tasks 14 and 15) owns every `Notice`, `EmptyState` and field error in `components/ops` and `app/ops`: they become dense slips, standing warnings and empty wells. The ops boards draw these as tinted `notice` boxes (pattern 4, the Provider test, the Approvals outcomes). Those drawings are superseded by the approved states patterns. **This plan never edits a `Notice`, `EmptyState`, `Slip`, `StandingWarning` or `EmptyWell` call,** and never restyles their CSS. It restyles everything around them.
- **Username reservation PR 2** (take-backs) owns `packages/mail/src/templates/types/username-take-back.ts` and the take-back changes to `ops/usernames`, `ops/pages`, `ops/search`, `ops-menu.ts` (`PAGE_CARDS`), `ops-search.ts` and `ops-answers.ts`. Its emails get the new frame for free because PR 1 keeps `letter()`'s signature; PR 1 also adds a `deadline` block matching the board's "@brandname goes on 12 November" bar, which that builder may adopt. This plan does not edit their template.
- **Live updates PR 3** (admin) owns the staff stream: `<LiveProvider stream="ops">` in `ops-shell.tsx`, and `useLiveEvents` in `ops/approvals`, `ops/issues` and the Overview's approvals list. This plan's Approvals count is built so PR 3 adds one line to it (Task 9).
- **Not approved, excluded:** `StaffRoles`, `Rewards`, `Changelog` boards. The frame leaves room for them (Task 8): the menu's groups take a Changelog entry in one line, and the Overview's sections are an ordered list a rewards panel can join. Nothing is drawn for them now, not even an empty slot.
- States batches B to I, make-it-yours PR B/D, live updates PR 2, animated covers (#127, merged): no overlap found except `globals.css`, which everyone touches.

**Architecture:** Two independent streams.

1. **Mail (`packages/mail` only, plus three one-line data additions in `packages/database`).** `layout.ts` keeps `letter(input: Letter, ctx): RenderedMail` and today's three block kinds, so every registered type, and the take-back types another builder is adding, renders in the new frame without edits. New optional `Letter` fields and new block kinds carry the board's compositions. Each block kind has one HTML rendering (table-based, inline CSS, 600px) and one plain-text rendering. New data fields are optional, because the worker renders queued mail with the schema current at send time, and rows queued before a deploy carry the old data.
2. **Admin (`apps/web` only, plus one optional search field in Task 13).** The frame lives in `ops-shell.tsx` and a new `components/ops/ops-frame.tsx`. The menu's data moves from a flat list to groups in `lib/ops-menu.ts`, keeping `opsMenu()` as the flat view. The patterns are CSS under `.ops-page` in `apps/web/src/app/globals.css`, plus small markup changes (a `data-label` on table cells, a page header class). Pages keep their logic, wording and API calls.

**Tech stack:** TypeScript strict, zod 4.6.7, `node --test`, Next 16 App Router, `@tipme/ui`, Playwright. No new dependency, no migration, no new permission.

**Read on `origin/dev` `931a545`** (5 Nov 2026, after #126 and #127). Where a board and dev differ, the choice made is stated where it applies, and collected in "Board versus dev" below.

---

## What the code does today (origin/dev `931a545`)

**Mail.**

- `packages/mail/src/templates/layout.ts`: `letter()` renders a white 600px card on `#F5F5F7`, a purple "TipMe" word, an `<h1>`, blocks `text | code | button` (purple button), and a footer with the reason, an "Email settings" link when `ctx.unsubscribeUrl` is set, and `support@usetipme.xyz`. The plain text is heading, blocks, "—", reason, settings URL, support.
- `define.ts`: `MailType` (`id`, `category`, `sender`, `schema`, `preference`, `tracking`, `render`, `sample`); security mail is never tracked; `mailLink(ctx, path, key, personal)` adds `ml=` and redacts personal links as `[personal link]` in the stored snapshot.
- `registry.ts`: 38 types; `renderMail` validates with the type's schema, renders, and makes a redacted snapshot (none for security mail). `apps/web/src/app/ops/email/page.tsx:147-152` shows a snapshot in a `sandbox=""` iframe.
- Board types on dev: `tip_received` (`types/tip-received.ts`; data `firstName, netMinor, supporterLabel, pretendPayment`), `sign_in_code` and six other code mails (`types/sign-in-code.ts`), `email_verification_link`, `recovery_link`, `phone_change_warning` (the last three are marked "Retired" but still registered, and `operations/email.ts:54, 163, 329` still enqueue them), `welcome`, `new_sign_in_notice` (data `deviceLabel` only) and the recovery notices (`types/account-notices.ts`), `payout_destination_changed`, `account_deleted_notice`, `payment_account_ready` (data `{}`), `weekly_report` (data `isoWeek, totalNetMinor, tipCount`), `staff_invitation` (the 10-character code is only inside the one-time link `/ops#enrol=<code>`; no screen takes it typed).
- Triggers: `operations/notifications.ts:74` (tip), `reports.ts:174` (weekly), `email-sign-in.ts:314` (new sign-in), `payment-accounts.ts:265-275` (ready, through `mailOwner` with `data: {}`), `staff-admin.ts:680` (invitation).
- Privacy rules already in code: `schema.ts:979` "Payer free text, kept apart so it can get stricter access and retention. Never copied elsewhere." `TipStatusView` "Never includes the supporter's message" (make-it-yours plan). `docs/00-DECISIONS.md:83`: admin search never returns supporter names or messages. Mail data is sealed and wiped after 7 days; `rendered_sealed` (the snapshot) is kept 2 years.

**Admin.**

- `apps/web/src/app/layout.tsx:50-52` renders the site `Navigation` (`.site-header`) and `Footer` (`.site-footer`) on every page, `/ops` included.
- `apps/web/src/app/ops/ops-shell.tsx`: states `loading | retry | unavailable | needs_code | needs_enrolment | granted`. `unavailable` returns `PageUnavailable`, the same screen as a missing page. Otherwise `main.dashboard-page.ops-page` > `Container` > `.ops-banner` ("Admin", "Staff area · every view and action is recorded"), then for `granted` a `.dashboard-bar` holding `nav[aria-label="Admin"].dashboard-nav` (pills from `opsMenu(permissions)`) and a quiet "Leave admin" button, then `FreshCodePrompt`, then the page.
- **#126 (`34a6e9f`)** made that nav one row that scrolls sideways: CSS `.dashboard-nav[aria-label='Admin']` (`globals.css`, after `:5169`) and a `useEffect` that scrolls the `aria-current` link into view. Its e2e is `tests/e2e/ops-screens.spec.ts:206-237` ("the admin menu is one row on a desktop/phone, and every link can be reached").
- `apps/web/src/lib/ops-menu.ts`: 15 links (the board draws 14; dev also has **Usernames**, from username reservation PR 1), each with `needs` permissions; `apps/web/test/ops-menu.test.mjs` pins who sees what.
- Ops CSS: `.ops-*` rules at `globals.css:6708-7310` (banner, step, filters, list, row, severity, issue, facts, timeline, actions, reason, recovery, table-wrap, table, permissions, dashboard, tiles, tile, chart, funnel, code-dialog, picker).
- Pages use `@tipme/ui` `Card`, `Badge`, `Button`, `InputField`, `Skeleton`, `Notice`, `EmptyState`; headings are plain `<h1>`/`<h2>` in `.dashboard-section`.
- `WaitingRequests` (`components/ops/waiting-requests.tsx`) reads `/v1/ops/approvals?status=pending`; each `OpsApproval` has `mine` and `canDecide` (`packages/contracts/src/ops.ts:94-114`).
- Audit log shows `row.action` as a code (`ops/audit/page.tsx`); `STAFF_ACTIVITY_WORDS` (`lib/ops-answers.ts:97`) and `SERIOUS_ACTION_WORDS` give words for some actions.
- Search shows `t.status` and `o.status` as codes (`ops/search/page.tsx:127, 141`); `OpsSearchResult` (`contracts/src/ops.ts:792-815`) has no issue link. Issues carry `subject.tipId` / `subject.payoutId` (`OpsIssueSubject`, `ops.ts:275-285`).

---

## Board versus dev: what this plan chose

| Where                            | Board                                  | Dev                                                                           | Chosen                                                                                                                                                     |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tip email                        | The supporter's message on a slip      | No message in the data; tip messages are "never copied elsewhere"             | **Dev.** No message text. When the tip has a note, one line says "{supporter} left you a note." and the button reads "Read it on TipMe". Owner question 1. |
| Weekly report                    | A quoted note from the week            | No message                                                                    | **Dev.** No quote. Owner question 1.                                                                                                                       |
| Staff invitation                 | Shows a code "You will need this code" | The code is only in the one-time link; nothing takes it typed                 | **Dev.** No code box. Board's subject and layout. Owner question 3.                                                                                        |
| Ready for tips                   | "Your bank account is ready"           | "Your payment account is ready" (fires when the payment account turns ACTIVE) | **Dev's noun**, board's layout and the signature block with the page link. Owner question 4.                                                               |
| Amounts in body                  | "₦4,500"                               | "NGN 4,500.00"                                                                | **Board**, exact: kobo shown only when not zero ("₦4,050.50"), never truncated.                                                                            |
| Withdraw minimum                 | "You can withdraw from ₦2,000"         | `FEE_POLICY_V1.minWithdrawalMinor`                                            | **Board's line**, with the amount passed from the policy, never typed into the template.                                                                   |
| New sign-in "When"               | "Today, 14:32"                         | Not in the data                                                               | **Board's row**, as an absolute Lagos time ("5 Nov 2026, 14:32"); an email can't know when "today" is read.                                                |
| Fonts                            | DM Serif Display, Manrope              | System sans                                                                   | **Georgia** for the serif, the system sans stack for text. No web font is loaded in any email (Global Constraints).                                        |
| Wordmark                         | "tipme" + heart SVG                    | "TipMe" text                                                                  | Board's "tipme" in 800 weight with a purple "♥" text glyph (SVG doesn't render in Gmail or Outlook).                                                       |
| Admin menu                       | Grouped sidebar; phone "Menu" sheet    | #126: one row that scrolls                                                    | **Board.** Replaces #126 (Task 8).                                                                                                                         |
| Usernames link                   | Not drawn                              | On dev                                                                        | In "Work", after Pages.                                                                                                                                    |
| Notices in ops boards            | Tinted boxes                           | States batch G turns them into slips                                          | **States plan** (approved). Not touched here.                                                                                                              |
| Site header and footer on `/ops` | Not drawn                              | Shown                                                                         | **Board:** hidden, but only once access is granted (Task 8; Review Focus 5).                                                                               |
| Search links                     | "open its issue or receipt"            | Pages only                                                                    | Link to the **open issue** when there is one. There is no staff receipt view. Owner question 7.                                                            |

---

## Global Constraints

- **Private data never in a subject or preheader.** No code, token, link, email address, phone digits, bank name or digits, supporter label, note, handle or device in any subject line or in the hidden preheader (both show on lock screens and in notification previews). The one existing exception is the tip amount in "You got a ₦4,500 tip on TipMe" (board and dev agree; owner question 2). Pinned by test `no sample value reaches a subject or preheader` (Task 2).
- **Tip notes are never copied into mail.** No template takes a field holding a `tip_messages.body`. The tip email learns only that a note exists (`hasNote: boolean`). Pinned by test `no mail schema accepts a note` (Task 5).
- **Plain text stays whole.** Every block kind has a text rendering; every link in the HTML appears in the text with its label; the plain text never says "see below" or depends on colour. Pinned by `every link in the html is in the text` (Task 2).
- **Codes stay copyable.** A code in cells is one run of digits in the HTML text (spans with no whitespace between them), so copy, paste and iOS code autofill still get `482913`. Pinned by `a code in cells copies as one string` (Task 2).
- **Security mail keeps its guarantees:** no snapshot, no tracking (`defineMailType` already enforces both; do not touch them); personal links in any block kind are redacted in snapshots. Pinned by `personal links are redacted in every block kind` (Task 2).
- **No third-party loads in email:** no remote fonts, images, stylesheets or `url(...)`. A font fetch from Google would tell a third party when security mail is opened. Pinned by `an email loads nothing from anywhere` (Task 2).
- **Backward-compatible data:** every new schema field is `.optional()`; the type's previous sample must still parse and render. Pinned by `last release's samples still render` (Task 5).
- **Email weight:** each rendered HTML stays under 90 KB (Gmail clips at 102 KB). Pinned in Task 2.
- **Money statements only where code proves them** (the states plan's rule, applied to mail):
  - "Confirmed by our payment partner." `notifyTipSucceeded` runs only for the `tip.succeeded` outbox event (`notifications.ts:20-23`), which `provider-events.ts:345-385` enqueues after `moveTip('SUCCEEDED')`.
  - "It is in your balance now." The same transaction posts the payment to `recipient_payable` (`postLedgerTransaction`, `provider-events.ts:360-372`) before the outbox row, and `balanceQuery` (`balance.ts:5-22`) counts `recipient_payable`.
  - "You can withdraw from {min}." `FEE_POLICY_V1.minWithdrawalMinor` (`packages/domain/src/fees.ts:14`), passed in data by the trigger.
  - "We can stop withdrawals while we look." The takeover freeze exists (`docs/00-DECISIONS.md:127`).
  - Nothing else about money is added. Withdrawal, reversal and payment-account emails keep their words.
- **Words change only where a board shows them.** Every other email keeps its exact words and only moves into the new frame. Copy rules: "our payment partner", never the provider's name; nothing implies regulatory approval; "they" for people; no exclamation marks in security mail; no em dash in new copy.
- **Admin:**
  - no change to any API call, permission check, reason box, second-person flow, fresh-code prompt, masking (`k•••@example.com`) or audit;
  - the menu still lists only links the person's permissions allow (`opsMenu`), and the server still checks every call;
  - a non-staff visitor sees exactly the missing-page screen with the normal site header and footer;
  - admin motion stays nearly still (EXPERIENCE §7.10): the sheet opens with a short slide that reduced motion turns off; no arrival motion on lists.
- **Accessibility:** WCAG 2.2 AA intent; one `nav[aria-label="Admin"]` in the accessibility tree at a time; the phone menu is a native `<dialog>` (focus in, Escape closes, focus returns to "Menu"); 44px targets on a phone; tables stay tables for screen readers when stacked (CSS only, `data-label` for the visible labels); 320px with no page-wide horizontal scroll.
- **Materials:** locked colours `#7A32F9`, `#FFFFFF`, `#000000`; purple is a material (the slab, the Admin pill, the count, the step dots), never a page wash. Web colours are tokens in `packages/ui/src/tokens.css` if new; `components.css` holds no hex. Email HTML is inline-styled, so its colours live as constants in `layout.ts`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each PR goes into `dev`; its body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Builders follow `.superpowers/program/builder-rules.md` (worktree, lane, no push).

**Commands used throughout**

- Mail build and unit: `pnpm -s turbo run build --filter=@tipme/mail... && node --test packages/mail/test/templates.test.mjs`
- Web unit: `pnpm --filter @tipme/web test` (one file: `node --test apps/web/test/<file>.test.mjs`)
- Integration (Task 5 only): `source <scratchpad>/dbb-env.sh`, then one file through your lane's scratch wrapper (builder rules), e.g. `node --test packages/database/test/integration/mail-triggers.test.mjs`
- e2e: `export E2E_LANE=<lane> && node scripts/build-e2e.mjs && pnpm test:e2e -- tests/e2e/<spec>.ts` (add `--alone` for `@alone` specs)
- Review screenshots: `pnpm -s test:review` (see `tests/review/playwright.config.ts`)
- Whole-repo gates before each PR: `pnpm -s turbo run typecheck lint`, `pnpm -s format:check`, `pnpm -s test` (with `E2E_LANE` unset), the full e2e suite on your lane, and `pnpm -s api:openapi && pnpm -s docs:generate` only in Task 13.

## Review Focus

1. **A queued email from before the deploy** (old data, no `hasNote`, no `at`, no `handle`, no `minWithdrawalMinor`) renders with the new templates, and never shows "undefined", an empty well or a broken link. Test: `last release's samples still render` (Task 5).
2. **Something private on a lock screen.** Subjects and preheaders carry no code, link, address, name, bank or device. Test: `no sample value reaches a subject or preheader` (Task 2).
3. **A supporter's note leaking into mail** through a new field, the preheader or a snapshot. Test: `no mail schema accepts a note` and the `hasNote` render test (Task 5).
4. **A code that can't be pasted** from the cells, or a security email that gains a tracking pixel, a remote font or a snapshot. Tests in Task 2.
5. **The admin area revealing itself.** Before access is granted, and for non-staff, the site header and footer are there and nothing names the admin area beyond what dev already shows. The frame's `data-ops-frame` marker is set only in the `granted` state. Test: `a visitor who isn't staff sees the missing page with the normal header` (Task 8).
6. **The menu after #126.** Every permitted link is reachable on a 1280px desktop (sidebar, sticky, scrolls on its own when taller than the window) and at 360px (sheet), the open page is marked, and no page scrolls sideways. Tests: Task 8, replacing `ops-screens.spec.ts:206-237`.
7. **The Approvals count lying.** It counts only waiting requests this person can decide (`canDecide`), shows nothing when the read fails, and never blocks the menu. Test: Task 9.
8. **Stacked tables on a phone** still read as tables to a screen reader and keep every field. Test: Task 10.

## PR boundaries and merge order

| PR                                | Tasks | Scope                                                                                                                                                           | Depends on                                       |
| --------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **M1. Mail frame and blocks**     | 1–3   | Boards into the repo; the new `letter()` frame, preheader and block kinds; every email in the new frame with today's words; a preview script                    | none                                             |
| **M2. Board emails**              | 4–7   | The board's compositions for tip, account, security and report emails; three optional data fields at their triggers; the same family style for every other type | M1                                               |
| **A1. Admin frame**               | 8–9   | Sidebar, phone Menu sheet, staff strip, hidden site chrome once granted; replaces #126; the Approvals count                                                     | none (coordinate with live updates PR 3, Task 9) |
| **A2. Admin patterns**            | 10–11 | Shared patterns in CSS; Overview (desktop and phone), Issues, Issue detail, serious-action cards, code cells                                                    | A1 and **states PR G on dev**                    |
| **A3. Admin pages**               | 12    | Every other admin page in the patterns, including Usernames                                                                                                     | A2 and **username reservation PR 2 on dev**      |
| **A4. Admin proposals with data** | 13    | Audit log plain words; Search plain-word badges and links to the open issue (one optional contract field)                                                       | A3                                               |

M1 and A1 can be built at the same time in two lanes. M2 follows M1. A2 waits for states G because G rewrites the same page files' messages; A3 waits for username PR 2 because its Task 12 rewrites Pages, Search and Usernames. If either has not landed when the earlier PR merges, hold the next PR rather than editing their files.

**Shared-file conflicts to expect:** `globals.css` (everyone; keep ops rules inside the existing `.ops-*` block at `:6708-7310` and add new ones right after it), `ops-shell.tsx` (live updates PR 3 wraps the granted branch in `LiveProvider`; whichever lands second keeps both), `ops-menu.ts` (username PR 2 adds `usernames.manage` to `PAGE_CARDS`; A1 does not touch `PAGE_CARDS`).

---

## PR M1: Mail frame and blocks

### Task 1: Boards into the repo, and the visual ruling

**Files:**

- Create: `docs/design/redesign/boards/{EmailTip,EmailAccount,EmailSecurity,EmailReports}.dc.html` (copied byte for byte from the scratchpad).
- Modify: `docs/design/redesign/boards/README.md` (one row each, like the existing rows: board, what it shows, "Approved 5 Nov 2026"), `docs/design/DECISION-LOG.md` (entry below).

**DECISION-LOG entry (verbatim intent):** "Emails, 5 Nov 2026: the four email boards are approved. Emails load nothing remote: the serif is Georgia, not DM Serif Display, and the heart is a text glyph. Tip notes never appear in email (schema.ts: tip messages are never copied elsewhere). Codes in cells stay one copyable string."

- [ ] **Step 1:** Copy the files and add the rows.
- [ ] **Step 2:** Run `pnpm -s format:check`. Expected: PASS (boards are HTML; if prettier checks them, follow how the other boards are excluded).
- [ ] **Step 3:** Commit `docs(design): the four email boards, and the email visual ruling`.

### Task 2: The new frame, the preheader and the block kinds

**Files:**

- Modify: `packages/mail/src/templates/layout.ts`, `packages/mail/src/templates/money.ts`, `packages/mail/src/index.ts` (export `Block` and `Letter` types for the take-back builder).
- Test: `packages/mail/test/templates.test.mjs`, new `packages/mail/test/layout.test.mjs`.

**Interfaces — Produces:**

```ts
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'code'; code: string } // 6 digits: cells; anything else: one well
  | { kind: 'button'; label: string; href: string } // black key, the board's "go"
  | { kind: 'quiet'; text: string } // small grey line
  | { kind: 'warn'; text: string } // lilac panel (code warnings)
  | { kind: 'alarm'; title: string; text: string } // black panel: "Wasn't you?"
  | {
      kind: 'facts';
      rows: { label: string; value: string; before?: boolean }[];
    } // well; before = struck through
  | { kind: 'steps'; items: string[] } // numbered purple dots
  | { kind: 'stats'; items: { value: string; label: string }[] } // 2 wells side by side
  | { kind: 'signature'; title: string; text: string; href?: string } // purple panel (a link)
  | { kind: 'deadline'; label: string; date: string } // black bar, for the take-back builder
  | { kind: 'note'; text: string; by: string | null }; // paper slip; unused by TipMe's own mail (no note text ever reaches mail), kept for the board

export interface Letter {
  subject: string;
  heading: string;
  blocks: Block[];
  reason: string;
  /** Hidden preview text. Defaults to the first text block; never a code or link. */
  preheader?: string;
  /** "Your account's safety" line with the shield, above the heading. */
  tag?: 'safety';
  /** The purple slab with a large amount, in place of the white card's heading (the tip email). */
  slab?: { amount: string; line: string };
}

export function letter(input: Letter, ctx: MailContext): RenderedMail; // unchanged signature
```

Drop the `note` kind if no type uses it by the end of M2 (no dead code). It is listed so the builder sees the board's slip and knows why TipMe doesn't use it.

`money.ts` gains `naira(minor: string): string`: "₦4,500" when the kobo are zero, "₦4,050.50" otherwise, from a `BigInt` (never a float). `nairaWhole` becomes an alias of `naira` so subjects stop truncating kobo; `ngn` stays for any type that keeps "NGN".

**The frame** (from the boards' CSS, made email-safe):

- body and outer table `#F3F2EE`; a 600px centred table; wordmark row "tipme" (`font: 800 22px`, system sans) + "♥" in `#7A32F9`;
- the card: `#FFFEFA`, 1px `rgba(20,18,16,.1)` border, 24px radius, padding 28px; heading `font-family: 'DM Serif Display', Georgia, 'Times New Roman', serif` at 31px/1.1 (the first family is never loaded; it only matches if installed);
- with `slab`: a `#7A32F9` table cell, 24px radius, white text, heading at 34px, the amount at 64px (54px under 480px via a `<style>` media query; clients without it keep 64px, which fits 600px), the line in `#EFE6FF`;
- the button: a table cell `bgcolor="#000000"`, 14px radius, 54px tall, white 16px bold label, full width (Outlook squares the corners; acceptable);
- footer outside the card: 12.5px `#5D5A54`, a top rule, reason, settings link (when set), "Questions? support@usetipme.xyz";
- `@media (prefers-color-scheme: dark)` in a `<style>` block: page `#141210`, card `#1E1C19`, text `#F3F2EE`; the slab, black panels and button keep their colours. Clients that ignore it get the light version;
- the preheader: a hidden `<div>` (`display:none; max-height:0; overflow:hidden; mso-hide:all`) as the first body element.

**Plain text per block:** `quiet`, `warn`, `text` as the line; `alarm` as `title` + space + `text`; `facts` as `label: value` lines (a `before` row as `Before: value`); `steps` as `1. …`; `stats` as `value label` lines; `signature` as `title` then `text`, then the URL when `href` is set; `deadline` as `label date`; `code` as the code alone on its line; `button` as `label: href` (today's format). With `slab`, the text starts `heading`, blank, `amount`, `line`.

- [ ] **Step 1: Write the failing tests** in `layout.test.mjs`, each rendering a synthetic letter through `letter()`:
  - `every block kind renders in html and in text`: one letter with every kind; each kind's words appear in both;
  - `user text is escaped in every block kind`: `<script>"Ada"</script> 🎉 مرحبا` in every string field; no `<script` in the HTML, `&quot;Ada&quot;` present, the emoji and Arabic intact in both;
  - `a code in cells copies as one string`: for `482913`, stripping tags from the code block's HTML gives exactly `482913`; for `SAMPLEC2DE` it is one well;
  - `an email loads nothing from anywhere`: no `<img`, `<link`, `@import`, `url(` or `src=` in any registered type's sample HTML;
  - `every link in the html is in the text`: every `href` of every registered type's sample appears in its text (mailto excepted);
  - `the preheader is never a code or a link`: for every code type, the preheader contains no digit run of 6 and no `http`;
  - `each email stays under 90 KB`;
  - `the slab shows the amount and the line, and the text starts with them`;
  - `kobo show only when they are not zero`: `naira('450000') === '₦4,500'`, `naira('405050') === '₦4,050.50'`, `naira('5') === '₦0.05'`.
  - In `templates.test.mjs`, add `no sample value reaches a subject or preheader`: for every type, every string in its `sample` (recursively, longer than 2 characters) is absent from `subject` and from the preheader text, except `{ tip_received: ['netMinor'] , provider_test: ['providerLabel'] }` (the amount and the staff-only provider name, both already in today's subjects). Read the preheader by exporting a small `preheaderOf(html)` helper from the test, matching the hidden div.
  - Add `personal links are redacted in every block kind`: a letter with a personal `mailLink` in a `button` and in a `signature.href`, rendered with `redact: true`, contains `[personal link]` and not the token in HTML or text.
- [ ] **Step 2:** Run `pnpm -s turbo run build --filter=@tipme/mail... && node --test packages/mail/test/layout.test.mjs packages/mail/test/templates.test.mjs`. Expected: FAIL (the new kinds don't exist; the frame has no preheader).
- [ ] **Step 3:** Implement the frame and kinds. Keep each kind's HTML in one small function in `layout.ts`; keep colours as named constants at the top (`PAPER`, `CARD`, `INK`, `MUTED`, `BRAND`, `LILAC`, `WELL`). The existing kinds keep their text format exactly, so today's tests (`user text is escaped in HTML and intact in text`, the takeover release test) pass unchanged.
- [ ] **Step 4:** Run the same command. Expected: PASS, and the old tests in `templates.test.mjs` still pass.
- [ ] **Step 5:** Commit `feat(mail): the new email frame, a preheader and the board's blocks`.

### Task 3: A preview of every email, for review

**Files:**

- Create: `packages/mail/scripts/preview.mjs`; add `"preview": "node scripts/preview.mjs"` to `packages/mail/package.json`; add `packages/mail/.preview/` to `.gitignore`.
- Modify: `tests/review/screens.ts` only if it can take local files; otherwise none.

**What it does:** imports `dist/index.js`, renders every `MAIL_TYPES` entry from its `sample` with `webOrigin: 'https://usetipme.xyz'` and a sample `unsubscribeUrl` for types with a `preference`, and writes `<id>.html`, `<id>.txt` and an `index.html` linking them, each framed at 720px and 390px side by side (the boards' two widths).

- [ ] **Step 1:** Write `packages/mail/test/preview.test.mjs`: `the preview writes one html and one text file per type` (run the script into a temp dir via an env var `MAIL_PREVIEW_DIR`; count files). Run it: FAIL.
- [ ] **Step 2:** Implement. Run: PASS.
- [ ] **Step 3:** Open `.preview/index.html` in Chromium at both widths, compare each board email by eye, and put the screenshots in the PR body (not the repo).
- [ ] **Step 4:** Commit `chore(mail): a preview of every email for review`.

**PR M1 ends here.** Every email now wears the frame with today's words. Open "Emails: the new frame". Before opening: the whole-repo gates; the e2e specs that read mail (`grep -l readEmailCode tests/e2e`) on your lane, because the code's surrounding HTML changed (`readEmailCode` should read the text part; if it parses HTML, fix the helper to read text, not the template).

---

## PR M2: Board emails

### Task 4: Account emails (sign-in code family, confirm, getting back in, welcome)

**Files:**

- Modify: `packages/mail/src/templates/types/{sign-in-code,email-verification-link,recovery-link,account-notices}.ts` (`welcome` only in the last).
- Test: `packages/mail/test/templates.test.mjs`.

**Compositions (board words; dev wins where the table above says):**

- **`codeMail` (all seven code types):** heading as today; `text` intro (board's sign-in intro: "Type it on TipMe to sign in."; the other six keep their intros); `code` (cells); `warn` "It works for 10 minutes. Never share it. TipMe staff will never ask for it."; preheader "Your code is inside. It works for 10 minutes."; reason as today. Subjects unchanged.
- **`email_verification_link`:** heading "Confirm your email"; `text` "Confirm this address for your TipMe account, so we can reach you about your tips and your money."; `button` "Confirm my email" (personal link, unchanged); `quiet` "The link works for 24 hours. If you didn’t ask for this, ignore this email."; reason "You get this email because this address was added to a TipMe account."
- **`recovery_link`:** heading "Get back into TipMe"; `text` "Lost your phone number? Attach a new one with this link. You will need a code sent to the new number."; `button` "Attach a new number"; `quiet` "The link works for 30 minutes. If you didn’t ask for this, ignore this email: nothing changes."; reason "You get this email because someone asked to recover the TipMe account at this address."
- **`welcome`:** `text` "One link people can use to thank you with a tip. Three steps and you are ready:"; `steps` ["Claim your username and add your face.", "Add the bank account your money goes to.", "Share your link or your QR code."]; `button` "Create your page" (`/sign-up`, unchanged).

- [ ] **Step 1: Write the failing tests:** `the sign-in code email reads as the board` (heading, intro, cells, warn line, no code in subject or preheader); `the welcome email lists the three steps in order, in html and text`; `confirm and recovery links say how long they work, in a quiet line`.
- [ ] **Step 2:** Run the mail command. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mail): account emails as the board draws them`.

### Task 5: The tip email, and the three new optional fields

**Files:**

- Modify:
  - `packages/mail/src/templates/types/tip-received.ts`;
  - `packages/mail/src/templates/types/account-notices.ts` (`new_sign_in_notice`);
  - `packages/mail/src/templates/types/account-events.ts` (`payment_account_ready`);
  - `packages/database/src/operations/notifications.ts` (`notifyTipSucceeded`: select whether a `tip_messages` row exists, and pass the policy minimum);
  - `packages/database/src/operations/email-sign-in.ts:314` (pass `at: now.toISOString()`);
  - `packages/database/src/operations/payment-accounts.ts:265-275` (for `payment_account_ready` only, pass `handle` from the profile; `payment_account_action_needed` keeps `{}`).
- Test: `packages/mail/test/templates.test.mjs`, `packages/database/test/integration/mail-triggers.test.mjs`.

**Interfaces:**

```ts
// tip_received: schema gains
hasNote: z.boolean().optional(),                  // a note exists; its text never comes here
minWithdrawalMinor: z.string().regex(/^\d+$/).optional(),
// new_sign_in_notice: schema gains
at: z.string().datetime().optional(),
// payment_account_ready: schema becomes
z.object({ handle: z.string().min(1).max(40).optional() }).strict()
```

Every previous sample is kept in the test file as `PREVIOUS_SAMPLES` (copy today's `sample` objects verbatim before changing them).

**Compositions:**

- **`tip_received`:** subject unchanged in shape: `You got a ${naira(net)} tip on TipMe`. `slab`: heading "{firstName}, you got a tip.", amount `naira(netMinor)`, line "From {supporter or 'a guest'}. Confirmed by our payment partner." When `hasNote`: `text` "{supporter or 'Your supporter'} left you a note." and the button reads "Read it on TipMe" (to `/dashboard/tips`, link key `see_tips`); otherwise the button reads "See your tips". Then `quiet` "It is in your balance now." plus, when `minWithdrawalMinor` is set, " You can withdraw from {naira(min)}.". When `pretendPayment`: `quiet` "Pretend payment: no real money moved." (dev's words, kept). Preheader: "From {supporter or 'a guest'}." Reason unchanged; settings link as today (the type has a preference).
- **`new_sign_in_notice`:** `tag: 'safety'`; heading "A new device signed in"; `text` "Your TipMe account was just signed in to from a device we haven’t seen before."; `facts` Device = `deviceLabel` (row omitted when empty), When = `at` in Lagos time "5 Nov 2026, 14:32" (row omitted when absent); `quiet` "If this was you, there’s nothing to do."; `button` "Check your sign-ins" → `/dashboard/settings#security` (link key `sessions`). Keep dev's second sentence for the other case as an `alarm`: title "Wasn’t you?", text "Sign in and end that session in Settings." (the board drops it; dev wins, because it is the only instruction for the case that matters).
- **`payment_account_ready`:** heading "You can receive tips now"; `text` "Your payment account is ready, so people can tip you. Share your link to get your first one."; when `handle`: `signature` title `${host}/@${handle}` (host from `ctx.webOrigin`), text "Put it in your bio, or print your QR code.", href the page URL (not personal); `button` "Go to your dashboard". Reason: "You get this email when your TipMe page is ready to take tips."

- [ ] **Step 1: Write the failing tests:**
  - `last release's samples still render`: every entry in `PREVIOUS_SAMPLES` renders through `renderMail` with no "undefined", no empty `<dd>`, and every `href` a full URL;
  - `the tip email puts the amount on the slab, exact to the kobo`;
  - `a tip with a note says so, and never carries its words`: `hasNote: true` gives "left you a note." and "Read it on TipMe";
  - `no mail schema accepts a note`: for every type, `schema.safeParse({ ...sample, message: 'x' })` and `note`, `body`, `noteText` all fail (every schema is `.strict()`), and no schema's shape has a key matching `/message|note|body/i` other than `hasNote` (zod 4: read keys from `schema.shape`);
  - `the withdraw line uses the amount it is given`: `minWithdrawalMinor: '300000'` gives "₦3,000";
  - `the new sign-in email shows the device and the Lagos time`;
  - `the ready email shows the page link when it has the handle, and still reads without it`;
  - integration (`mail-triggers.test.mjs`): `a tip with a note queues hasNote true and no note text` (open the sealed data in the test, assert keys), `a tip email carries the policy minimum`, `the ready email carries the handle`, `a new sign-in notice carries when it happened`.
- [ ] **Step 2:** Run the mail command, then the integration file. Expected: FAIL.
- [ ] **Step 3:** Implement. In `notifyTipSucceeded`, add `hasNote: sql<boolean>\`exists (select 1 from tip_messages m where m.tip_id = ${tips.id})\``to the select (no join that would bring`body`into memory), and`minWithdrawalMinor: FEE_POLICY_V1.minWithdrawalMinor.toString()`(import from`@tipme/domain`, already a dependency of `@tipme/database`; check before adding).
- [ ] **Step 4:** Run the same. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mail): the tip email on a purple slab; a new sign-in shows when; the ready email shows the link`.

### Task 6: Security notices and the weekly report, ready, invitation

**Files:**

- Modify: `packages/mail/src/templates/types/{payout-destination-changed,phone-change-warning,account-events,weekly-report,staff-invitation}.ts`.
- Test: `packages/mail/test/templates.test.mjs`.

**Compositions:**

- **`payout_destination_changed`:** `tag: 'safety'`; heading "Your bank account changed"; `text` "Your next withdrawal goes to the new account. One already under way still goes to the account it started with."; `facts` Now = "{bankName} ••{last4}", Before = "{previousBankName} ••{previousLast4}" (`before: true`); `alarm` "Wasn’t you?" / "Contact support@usetipme.xyz straight away. We can stop withdrawals while we look."; reason "You get this email whenever the bank account on your TipMe page changes." Subject unchanged (no bank in it).
- **`phone_change_warning`:** `tag: 'safety'`; heading "Your number changes in 24 hours"; `text` "Someone asked to move your TipMe account to a new number ending {newPhoneHint}."; `alarm` "Wasn’t you?" / "Sign in and cancel it in Settings before it happens."; `button` "Sign in to cancel" → `/dashboard/settings`; reason "You get this email because a number change was requested on your TipMe account."
- **`account_deleted_notice`:** heading "Your account was deleted"; `text` "Your TipMe account and page are gone. This is the last email we’ll send you."; `alarm` "Didn’t do this?" / "Reply to this email straight away."
- **`weekly_report`:** heading "Your week on TipMe"; `text` the week as "27 October to 2 November." from `mondayOf`-style arithmetic on `isoWeek` inside the template (pure; Monday to Sunday, Lagos dates; across a year end "29 December to 4 January."); `stats` [`naira(totalNetMinor)` "you received", `tipCount` "tip"/"tips"]; `button` "See the whole week"; reason "You get this email every Monday when you were tipped last week." plus the settings link as today. No quoted note (owner question 1).
- **`staff_invitation`:** `invited` subject and heading "You’re invited to TipMe’s admin area"; `text` "Sign in with this email address, then set up an authenticator app to finish. The link works once, for 30 minutes."; `button` "Set up your authenticator" (personal link, unchanged); `quiet` dev's decline sentence. The `reset` variant keeps its words in the new frame. No code box (owner question 3).

- [ ] **Step 1: Write the failing tests:** `the bank change email strikes through the old account`; `the weekly report names the week's days, across a year end too` (`2026-W53` → "28 December to 3 January." — check the real ISO dates with `isoWeekOf` from `reports.ts` in the test's fixture comment); `the weekly report counts one tip in the singular`; `the invitation never prints its code` (the code appears only inside the link); `every security email from the boards carries the safety line` (bank change, new sign-in, number change).
- [ ] **Step 2:** Run the mail command. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mail): security notices, the weekly report and the invitation as the boards draw them`.

### Task 7: The rest of the family

**Files:**

- Modify: `packages/mail/src/templates/types/{account-notices,account-events,staff-invitation}.ts` (the types no board draws).
- Test: `packages/mail/test/templates.test.mjs`.

**Rule:** words unchanged. Only blocks change, by one mapping:

- every `security` type whose text has a "If this wasn’t you…" / "If you didn’t expect this…" sentence: that sentence moves into an `alarm` titled "Wasn’t you?" (or "Didn’t expect this?" for the staff mails), the rest stays `text`; and `tag: 'safety'` for the recipient's own account notices (`email_changed_notice`, `recovery_*_notice`), not for staff mails;
- a trailing "Reply to this email…" sentence in an account notice becomes `quiet`;
- `withdrawal_paid`, `withdrawal_failed`, `tip_reversed`, `milestone`, `page_*`, `payment_account_action_needed`, `provider_test`: no block changes beyond the frame.

- [ ] **Step 1: Write the failing test** `every type's words survive the move into blocks`: before changing anything, write each type's sample text part to `packages/mail/test/fixtures/text-before-m2.json`; the test asserts every sentence of the old text is still present in the new text (whitespace-normalised), for the Task 7 types.
- [ ] **Step 2:** Run. Expected: PASS before the change (it pins the words), then make the block changes and run again: PASS. (This task's red step is the alarm assertion: add `the security notices put "if this wasn't you" in the black panel` first and watch it fail.)
- [ ] **Step 3:** Commit `feat(mail): every other email in the same family`.

**PR M2 ends here.** Run the whole-repo gates, the e2e specs that read mail, and the preview (Task 3) for the PR screenshots. Open "Emails: the board's designs". Tell the username reservation PR 2 builder that `deadline` and `alarm` exist (through the coordinator, not by editing their file).

---

## PR A1: Admin frame

### Task 8: Sidebar, phone menu, staff strip, and what replaces #126

**Files:**

- Create: `docs/design/redesign/boards/{OpsShell,OpsPages}.dc.html` and their README rows; `apps/web/src/components/ops/ops-frame.tsx`.
- Modify:
  - `apps/web/src/lib/ops-menu.ts` (groups);
  - `apps/web/src/app/ops/ops-shell.tsx` (render the frame in `granted`; set and clear `data-ops-frame`; move the scroll-into-view effect to the sidebar);
  - `apps/web/src/app/globals.css` (remove #126's `.dashboard-nav[aria-label='Admin']` rules; add `.ops-frame*` rules; hide `.site-header` and `.site-footer` under `html[data-ops-frame]`);
  - `docs/design/DECISION-LOG.md` (entry below).
- Test: `apps/web/test/ops-menu.test.mjs`; `tests/e2e/ops-screens.spec.ts` (replace `:206-237`).

**Interfaces:**

```ts
// lib/ops-menu.ts
export type OpsMenuGroup = {
  label: string | null;
  links: { href: string; label: string }[];
};
/** Groups for these permissions; a group with no links left is dropped. */
export function opsMenuGroups(permissions: readonly string[]): OpsMenuGroup[];
/** Unchanged behaviour: the flat list, now opsMenuGroups(...).flatMap(g => g.links). */
export function opsMenu(
  permissions: readonly string[],
): { href: string; label: string }[];
```

Groups, in order (board, plus Usernames):

1. no label: Overview, Approvals;
2. "Work": Issues, Search, Pages, Usernames;
3. "Numbers": Visibility, Market;
4. "Email and records": Providers, Email, Audit log (a Changelog entry goes here when its board is approved: one line in `LINKS`, nothing else);
5. "Staff": People, Roles, Your access.

Each `LINKS` entry gains `group`; `needs` is unchanged. `PAGE_CARDS` is not touched.

```tsx
// components/ops/ops-frame.tsx
export function OpsFrame(props: {
  permissions: readonly string[];
  pathname: string;
  approvals: React.ReactNode; // the count, Task 9 (null until then)
  onLeave: () => void; // the existing signOut
  children: React.ReactNode; // FreshCodePrompt + the page
}): JSX.Element;
```

**Layout:**

- **≥ 1024px:** a two-column grid (`236px` + `minmax(0,1fr)`), full width (outside `Container`). The left column is `nav[aria-label="Admin"].ops-frame__side`: wordmark "tipme" + a black "Admin" pill, then the groups (group label 12px `#8A867E`, `<ul>` of 38px links, the open one on paper with the board's shadow and `aria-current="page"`), "Leave admin" (a `Button variant="quiet"`, as today) pinned to the bottom. The column is `position: sticky; top: 0; height: 100dvh; overflow-y: auto`. The right column starts with the black strip (`.ops-banner` restyled: `#141210`, purple "Admin" pill, "Staff area · every view and action is recorded"), then the content (`padding: 26px 32px 32px`, `max-width: 1100px`).
- **< 1024px:** the sidebar is `display: none`. The strip sits at the top, then a bar with the wordmark and a `Button variant="secondary"` "Menu · {current page label}" (`aria-haspopup="dialog"`, `aria-expanded`). It opens a native `<dialog class="ops-frame__sheet">` with `aria-label="Admin menu"`, a grab handle, and the same `nav[aria-label="Admin"]` content (Overview and Approvals full width, the rest in two columns as the board draws, group labels kept as visually hidden headings so the order still reads), and "Leave admin". The sheet scrolls inside itself (`max-height: 85dvh`). Choosing a link closes it. Escape and a tap on the backdrop close it; focus returns to "Menu". It slides up 180ms; `prefers-reduced-motion: reduce` shows it at once.
- **Site chrome:** while `state.step === 'granted'`, an effect sets `document.documentElement.dataset.opsFrame = 'on'` and removes it on cleanup (unmount, or leaving `granted`). CSS hides `.site-header` and `.site-footer` under `html[data-ops-frame]`. The skip link still targets `#main`. Every other state (loading, retry, needs_code, needs_enrolment, unavailable) keeps today's layout: the code and enrolment cards stay centred under the banner (#123).
- **What replaces #126:** the one-row scrolling pill row is gone on every width. Its promise ("every link can be reached, the open page's link is in view, no page-wide sideways scroll") is kept by the sidebar (sticky, scrolls on its own, and the existing effect now scrolls the `aria-current` link into view inside the sidebar with `block: 'nearest'`) and by the sheet. The `.dashboard-nav[aria-label='Admin']` CSS is deleted; `.dashboard-nav` for the dashboard is untouched.

**DECISION-LOG entry:** "Admin menu, 5 Nov 2026: the OpsShell board's grouped sidebar (desktop, from 1024px) and Menu sheet (below) replace #126's one-row scrolling menu. The site header and footer are hidden in the admin area only once access is granted, so a non-staff visitor still sees the ordinary missing page."

- [ ] **Step 1: Write the failing tests.**
  - `ops-menu.test.mjs`: `the menu comes in the board's groups, in order` (owner permissions → five groups, labels `[null, 'Work', 'Numbers', 'Email and records', 'Staff']`, Usernames after Pages); `a group with nothing left is dropped` (`['search.view']` → groups `[null, 'Work', 'Staff']`); the existing tests keep passing through `opsMenu`.
  - `ops-screens.spec.ts`, replacing the #126 loop:
    - `the admin sidebar on a desktop lists every link in its group, and the last one opens and stays in view` (1280×800: `nav[aria-label="Admin"]` visible; link x positions all equal; group labels visible in order; click "Your access"; its link has `aria-current="page"` and is in the viewport; `document.documentElement.scrollWidth <= innerWidth`; `.site-header` not visible);
    - `on a short desktop window the sidebar scrolls on its own` (1280×560: "Leave admin" reachable by scrolling the sidebar, page not scrolled);
    - `on a phone the Menu opens a sheet, every link can be reached, and choosing one closes it` (360×800: sidebar hidden; "Menu · Overview" `aria-expanded="false"`; open; focus inside the dialog; scroll to "Your access"; click; dialog closed; button reads "Menu · Your access"; no sideways scroll);
    - `Escape closes the phone menu and focus goes back to Menu`;
    - `a visitor who isn't staff sees the missing page with the normal header` (signed-in non-staff: the page-unavailable heading, `.site-header` visible, `html` has no `data-ops-frame`);
    - `the authenticator step keeps the site header and stays centred` (a fresh owner before the code: `.site-header` visible).
- [ ] **Step 2:** Run `node --test apps/web/test/ops-menu.test.mjs`, then `node scripts/build-e2e.mjs && pnpm test:e2e -- tests/e2e/ops-screens.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Use the dashboard's existing dialog pattern (`.confirm-dialog`, `html:has(.confirm-dialog[open])` scroll lock) for the sheet rather than a new one; check `apps/web/src/components` for it before writing. Hidden duplicate navs must be `display: none` (not `visibility` or off-screen) so only one `nav[aria-label="Admin"]` is in the accessibility tree.
- [ ] **Step 4:** Run the same, then the other ops specs that find links in the menu (`grep -l "navigation', { name: 'Admin'" tests/e2e`), on desktop and with `@mobile`. Expected: PASS. Fix any spec that clicked a menu link on a phone without opening the sheet by adding a helper `openOpsLink(page, name)` in `tests/e2e/ops-helpers.ts` (opens the sheet when "Menu" is visible).
- [ ] **Step 5:** Commit `feat(ops): the admin sidebar and phone menu replace the one-row menu`.

### Task 9: The Approvals count

**Files:**

- Create: `apps/web/src/components/ops/approvals-count.tsx`.
- Modify: `apps/web/src/components/ops/ops-frame.tsx` (place it on the Approvals link in both navs), `apps/web/src/app/ops/ops-shell.tsx` (render it).
- Test: `apps/web/test/approvals-count.test.mjs` (the pure part), `tests/e2e/ops-alone.spec.ts` or `ops-staff.spec.ts` (whichever already has `secondOwner`).

**Interfaces:**

```ts
/** Waiting requests this person could decide now; null when unknown (no badge then). */
export function decidableCount(
  rows: readonly OpsApproval[] | null,
): number | null;
export function useApprovalsCount(pathname: string): {
  count: number | null;
  reload: () => void;
};
```

- Reads `/v1/ops/approvals?status=pending` through `opsFetch` on mount and when `pathname` changes, at most once per 30 s (a `useRef` timestamp); a failed read gives `null` and no badge; it never shows an error (the Approvals page itself says so).
- Badge: `<span class="ops-frame__count" aria-hidden="true">{n}</span><span class="sr-only">, {n} waiting for you</span>`, only when `n > 0`. Purple pill, as the board.
- **Live updates PR 3:** `reload` is exported for one line: `useLiveEvents(['ops.approvals.changed'], reload)`. If PR 3 is already on dev when this task starts, add that line here and test it; otherwise leave nothing and the coordinator tells the PR 3 builder.

- [ ] **Step 1: Write the failing tests:** `only requests this person can decide are counted` (rows with `canDecide` true/false and `mine` true → counts only `canDecide`); `an unknown list counts as unknown, not zero`; e2e `a request a second owner can decide shows a count of one on their menu, and none on the asker's`.
- [ ] **Step 2:** Run `node --test apps/web/test/approvals-count.test.mjs` and the e2e spec (`--alone` if it is an `@alone` spec). Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ops): the menu counts what is waiting for you`.

**PR A1 ends here.** Add the `/ops` routes to `tests/review/screens.ts` (desktop and phone, owner signed in, the same fixtures as `ops-screens.spec.ts`) so ScreenAudit's missing shots exist, and attach them. Open "Admin: the sidebar and phone menu".

---

## PR A2: Admin patterns

**Start only when states PR G is on dev.** Rebase, then confirm with `git grep -n "<Notice\|<EmptyState" origin/dev -- apps/web/src/app/ops apps/web/src/components/ops` that G's migration is in (it should list none). If G is not in, stop and report.

### Task 10: The shared patterns

**Files:**

- Modify: `apps/web/src/app/globals.css` (the `.ops-*` block at `:6708-7310` and new rules right after it), `apps/web/src/app/ops/audit/page.tsx` and every other `app/ops` table (add `data-label` to each `<td>`; nothing else), `packages/ui/src/tokens.css` only if a colour below has no token yet.
- Test: new `apps/web/test/ops-patterns.test.mjs` (a CSS and markup guard), `tests/e2e/ops-screens.spec.ts`.

**Patterns (OpsShell board, its CSS read as spec):**

- **Page heading:** `.ops-page h1` 40px DM Serif Display (the site font is already loaded on the web); section `h2` 25px; phone 32px/22px.
- **Paper:** `.ops-page .tm-card` and `.dashboard-section > .ops-list` on `#FFFEFA` (token `--tm-paper` or the nearest existing one), 20px radius, the board's two-layer shadow.
- **Wells:** inputs, selects, textareas and tiles on the inset well (`#EEEDE8`, inset shadow), 12px radius, 42px tall.
- **Tiles:** label 12.5px muted, value 22px bold tabular, comparison 12px; `.up` green `#23623B` with "▲". Grids: 4 and 5 across on desktop, 2 on a phone.
- **Funnel:** 14px purple bars, right-aligned tabular numbers.
- **Lists with filters (Issues):** two filter wells side by side (stacked below 480px); rows separated by hairlines; the kind badge first, the title bold, the age right-aligned.
- **Badges:** money (`#FDECEA`/`#9B2820`), account (`#FFF4D8`/`#75500B`), info (`#EEEDE8`), ok (`#E8F4EC`/`#23623B`), warn, brand, "Sensitive" (bad). Each badge always has words; colour is never the only signal.
- **Tables:** 12.5px, muted header, hairlines; **below 640px each row stacks** into a card: `display: block` on `tr`, each `td` shows `attr(data-label)` before its value via `::before`. `thead` is visually hidden, not removed; the `<table>` keeps its role (add `role="table"` and child roles only if a screen-reader check shows `display: block` drops them in Chromium, as it can).
- **Facts:** 130px label column, 600 weight values; one column below 480px.
- **Buttons:** `.btn.go` is the existing primary (black); a "danger" quiet text in `#9B2820` for "Switch off all withdrawals…" and "Remove…"; reason-opening buttons keep their "…".
- **Code cells:** the fresh-code prompt and approval code field show the six-cell well from the board (CSS on the existing `code-field`; the input stays one `<input>`).
- **Timeline:** 7px dots; an "acted alone" row's dot in `#9B2820` plus its words (unchanged).
- **Not touched:** anything with `.tm-slip`, `.tm-standing-warning`, `.tm-empty-well`, `.tm-notice` (states G).

- [ ] **Step 1: Write the failing tests:**
  - `ops-patterns.test.mjs`: `every admin table cell has a data-label` (parse each `app/ops/**/page.tsx` and `components/ops/*.tsx` for `<td` and assert `data-label=`); `the admin restyle never targets the states patterns` (no rule in the ops block selects `.tm-slip`, `.tm-standing-warning`, `.tm-empty-well` or `.tm-notice`);
  - e2e: `on a phone the audit log stacks each entry with its five labels` (360px: one row's box shows "When", "Who", "Action", "Subject", "Reason"; no sideways scroll; `getByRole('table', { name: 'Audit entries' })` still found and `getByRole('row')` count unchanged);
  - e2e: `admin headings use the serif`.
- [ ] **Step 2:** Run `node --test apps/web/test/ops-patterns.test.mjs` and the e2e spec. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then all `tests/e2e/ops*.spec.ts` on desktop and `@mobile`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ops): the admin patterns: paper, wells, tiles, tables that stack on a phone`.

### Task 11: Overview, Issues, an issue, and the serious-action card

**Files:**

- Modify: `apps/web/src/app/ops/page.tsx`, `apps/web/src/app/ops/issues/page.tsx`, `apps/web/src/app/ops/issues/[issueId]/page.tsx`, `apps/web/src/components/ops/{withdrawals-switch,waiting-requests,staff-activity,charts,reason-action,resolve-money-issue,action-outcome}.tsx` (class names and wrappers only), `apps/web/src/app/globals.css`.
- Test: `tests/e2e/ops-dashboards.spec.ts`, `tests/e2e/ops-screens.spec.ts`.

**Layout (OpsShell board):**

- **Overview, desktop:** the withdrawals switch as one paper row (state left with its dot and words, the action right); "Pending approvals" and "Staff activity" side by side; the live-payments lines; then the sections **in an ordered array** `OVERVIEW_SECTIONS = ['money', 'reserveAndFunnel', 'reliability', 'recipients', 'pageSpeed']` rendered in order, so a rewards panel later is one entry after `'money'`, with nothing drawn now. Reserve (300px) beside the funnel.
- **Overview, phone:** one column; the switch's button full width; approvals list without the detail line; tiles two across; the amount values at 17px so "NGN 186,000.00" fits 2 across at 360px.
- **Issues:** pattern 1 (filters, rows, "Show more").
- **An issue:** pattern 2: "← All issues", the serif title, badges and the opened time, the summary, then "Decide" first, then Page, Person, Withdrawal, Notes and the conditional sections, each a `h2` 20px serif with a facts well.
- **Serious-action card (Approvals and anywhere `reason-action` asks for a code):** pattern 3: the title in serif, the facts, the code-and-note well on the page colour, "Approve and run" black, "Back" quiet, "Reject…" below. Outcome messages are states G's slips; only their spacing is set here.
- Words unchanged everywhere.

- [ ] **Step 1: Write the failing tests:** `the Overview shows money first, then reserve and funnel, then reliability and recipients` (section heading order); `on a phone the Overview tiles sit two across and the withdrawals button is full width` (360px boxes); `an issue's Decide section comes before its facts`.
- [ ] **Step 2:** Run the e2e specs. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then all ops specs desktop and `@mobile`, and `pnpm -s test:review` for the PR shots. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ops): the Overview, Issues and an issue in the board's layout`.

**PR A2 ends here.** Open "Admin: the shared patterns".

---

## PR A3: Admin pages

**Start only when username reservation PR 2 is on dev** (it rewrites Pages, Search and Usernames). If it is not, build the other pages first in this PR and leave those three for a follow-up commit once it lands; do not edit them before.

### Task 12: Every other admin page

**Files:**

- Modify: `apps/web/src/app/ops/{approvals,audit,email,visibility,market,pages,search,providers,providers/confirm,staff,staff/people,staff/roles,usernames}/page.tsx`, `apps/web/src/components/ops/{page-images,page-pricing,payout-issue-tools,permission-picker,fresh-code}.tsx`, `apps/web/src/app/globals.css`.
- Test: `tests/e2e/ops-screens.spec.ts`, `ops-email.spec.ts`, `ops-providers.spec.ts`, `ops-staff.spec.ts`, `ops-page-images.spec.ts`, `ops-usernames.spec.ts`.

**Per page (OpsPages board; layout only, words unchanged):**

- **Approvals:** hint, "Waiting" cards (pattern 3, "Cancel my request" on your own), "History" rows with an outcome badge.
- **Audit log:** pattern 1b; "Show older entries" below. Plain words come in Task 13.
- **Email:** period well (200px); tiles three across (two on a phone); the two charts and By type / category / provider as paper sections; the filter wells four across (two on a phone); the two export buttons; the email rows as links with the hint line; the content view in its paper section (the iframe keeps `sandbox=""`).
- **Visibility:** hint; tiles three across; each chart in paper. The "collection is off" message is states G's.
- **Market:** "Add an observation" form in paper with paired wells; chart select; the table (stacks on a phone; "Archive" quiet).
- **Pages:** handle well + "Find page"; one paper card per section (identity with plan badge, Images, Handle changes, Sign-in email, Reported account takeover, Pricing, and the take-back card from username PR 2), each with its own serif `h2` and actions. Cards still show only by permission.
- **Search:** search well + button; result count; one paper group per kind (Pages, Tips, Withdrawals, Ledger entries). Badges and links come in Task 13.
- **Providers / Provider test:** one paper card per provider with its status badge, the 24-hour line, "Send the test email"; Accounts on their own provider; Blocked addresses with its look-up well.
- **Your access:** the role in serif, then each permission as `code` + hint rows; the People · Roles · Approvals links.
- **People:** "Add a person…" black; one row per person with role and state badges, the hint line, the actions; the opened form in paper.
- **Roles:** "New role…"; role rows; the permission picker grouped (Money, Issues and email, People, Numbers and records, Settings) with "Sensitive" and "Second person" badges.
- **Usernames** (not on the board): the same patterns: the check well, the reservation table (stacks on a phone), and the take-back form from username PR 2 in a paper card.

- [ ] **Step 1: Write the failing tests:** one e2e assertion per page that its `h1` uses the serif and its main content sits in `.ops-paper`/tiles as above (one test, looping the routes, desktop and phone, no sideways scroll at 360px); `the permission picker shows its groups in order`.
- [ ] **Step 2:** Run the specs listed. Expected: FAIL.
- [ ] **Step 3:** Implement, page by page, one commit per two or three pages.
- [ ] **Step 4:** Run every `tests/e2e/ops*.spec.ts` desktop and `@mobile`, and `pnpm -s test:review`. Expected: PASS.
- [ ] **Step 5:** Commits `feat(ops): <pages> in the new style`.

**PR A3 ends here.** Open "Admin: every page in the new style".

---

## PR A4: Admin proposals with data

### Task 13: Audit in plain words; Search badges and issue links

**Files:**

- Modify:
  - `apps/web/src/lib/ops-answers.ts` (`AUDIT_ACTION_WORDS`, `PAYMENT_STATUS_WORDS`);
  - `apps/web/src/app/ops/audit/page.tsx`, `apps/web/src/app/ops/search/page.tsx`;
  - `packages/contracts/src/ops.ts` (`OpsSearchResult.tips[].issueId` and `.payouts[].issueId`, both `string | null`, optional for an older API);
  - `packages/database/src/operations/ops-search.ts` (the open issue per tip and payout);
  - `docs/api/openapi.json` and generated docs (`pnpm api:openapi && pnpm docs:generate`).
- Test: `apps/web/test/ops-answers.test.mjs`, `tests/integration/ops-search.test.mjs`, `tests/e2e/ops-screens.spec.ts`.

**Interfaces:**

- `AUDIT_ACTION_WORDS: Record<string, string>`: words for every audit action recorded today. Reuse `STAFF_ACTIVITY_WORDS` and `SERIOUS_ACTION_WORDS` where they already name one (import, never duplicate). An unknown action shows its code only.
- Audit "Action" cell: the words in 600 weight, the code beneath in mono 12px (board).
- `PAYMENT_STATUS_WORDS`: `SUCCEEDED` "Paid", `FAILED` "Failed", `PENDING_VERIFICATION` "Confirming", `AWAITING_PAYMENT` "Waiting for payment", `REQUESTED` "Requested", `PROCESSING` "With our payment partner", `PAID` "Paid out", plus every other value in the tip and payout status enums (the builder lists them from `schema.ts`; the test fails on a missing one). Shown as a badge with the code in the badge's `title`.
- `issueId`: the newest **open** issue whose `subject->>'tipId'` (or `payoutId`) matches, else `null`. Added to the existing query as a lateral subquery on open issues only; no new index (open issues are few; note the query plan in the PR). Search still never returns names, contact details or messages (`docs/00-DECISIONS.md:83`); an issue id is an id.
- Search row: when `issueId`, the row's reference becomes a link to `/ops/issues/{issueId}` reading "Open its issue"; the person needs `issues.view` for the link to show (`can(access, 'issues.view')`), since the issue page would refuse them.

- [ ] **Step 1: Write the failing tests:**
  - unit: `every audit action recorded in the code has words` (scan `packages/database/src` and `apps/api/src` for `action: '<dotted.code>'` in `recordAudit(` calls; each found code is a key of `AUDIT_ACTION_WORDS`); `every tip and payout status has words` (from the enums exported by `@tipme/database` or contracts);
  - integration: `search gives a tip its open issue, and no issue once it is resolved`; `search still returns no supporter name or note`;
  - e2e: `the audit log shows what happened in words, with the code beneath`; `a failed withdrawal in Search opens its issue for someone with issues.view, and is plain text for someone without`.
- [ ] **Step 2:** Run `node --test apps/web/test/ops-answers.test.mjs`, the integration file through your lane's wrapper, and the e2e spec. Expected: FAIL.
- [ ] **Step 3:** Implement. Then `pnpm -s api:openapi && pnpm -s docs:generate` and commit what they change.
- [ ] **Step 4:** Run the same, plus `node --test scripts/generate-docs.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ops): the audit log in plain words; search links a payment to its open issue`.

**PR A4 ends here.** Open "Admin: plain words in the audit log and search".

---

## Self-review against the boards

| Board                                       | Covered by                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| EmailTip                                    | Task 5 (note text excluded: owner question 1)                                                                                                 |
| EmailAccount                                | Task 4 (sign-in code, confirm, getting back in, welcome)                                                                                      |
| EmailSecurity                               | Task 5 (new sign-in), Task 6 (bank, number, deleted)                                                                                          |
| EmailReports                                | Task 5 (ready), Task 6 (weekly, invitation); the take-back email is username PR 2's, with `deadline` offered (Task 2)                         |
| OpsShell: frame, phone Overview, phone menu | Tasks 8, 9, 11                                                                                                                                |
| OpsShell: patterns 1–3                      | Tasks 10, 11                                                                                                                                  |
| OpsShell: pattern 4 (states)                | States PR G (loading skeleton label, "Not part of your role", "Not staff" already on dev)                                                     |
| OpsPages: every page                        | Task 12; Audit and Search proposals Task 13                                                                                                   |
| Proposed tags                               | Approvals count (9), Work group (8), phone Overview (11), phone menu (8), stacked tables (10), audit words (13), search links and badges (13) |

## Open for the owner

Each has a default, and the builder ships the default unless the owner answers otherwise.

1. **Notes in email.** The boards put the supporter's note in the tip email and a quote in the weekly report. The code keeps tip notes apart and "never copied elsewhere"; a note in an email would be sealed in the mail queue for 7 days, sent through the mail provider, and kept in the saved copy for 2 years (staff with `email.read` can open it). **Default: no note text in any email;** the tip email says "{supporter} left you a note." and its button reads "Read it on TipMe". Should notes appear, perhaps only notes the supporter allowed to be shown?
2. **The tip amount in the subject** ("You got a ₦4,500 tip on TipMe") shows on lock screens. Both the board and today's email do it. **Default: keep it.** Everything else private stays out of subjects and previews.
3. **The staff invitation's code box.** The board prints the code ("You will need this code"), but the code is the one-time link's secret and no screen takes it typed. **Default: no code box;** the link does the work, as today.
4. **"Your bank account is ready" (board) or "Your payment account is ready" (today).** The email goes when the payment account becomes active, which may not be the moment the bank account was added. **Default: "payment account"** with the board's layout and page link.
5. **Retired emails** (phone recovery link, number change warning, email confirmation link) are still registered and still queued by older code paths. **Default: restyle them as the board draws;** retiring them is a separate clean-up.
6. **No web fonts in email.** Headings use Georgia instead of DM Serif Display, because loading a font would tell a third party when an email is opened. **Default: Georgia.**
7. **Search "opens its issue or receipt".** Staff have no receipt view of a tip. **Default: link to the open issue only.**
8. **Site header and footer in the admin area.** The board shows the admin frame alone. **Default: hidden once access is granted;** still shown on the sign-in and authenticator steps and to anyone who isn't staff.
9. **Sidebar breakpoint.** **Default: the sidebar from 1024px wide; the Menu sheet below** (tablets get the sheet).
10. **The Approvals count** counts only requests this person can decide now, not their own. **Default: as stated.**
11. **The admin sidebar is separate from the dashboard question** (ScreenDashboard: sidebar or top tabs). **Default: the admin gets its sidebar whatever the dashboard decides.**
