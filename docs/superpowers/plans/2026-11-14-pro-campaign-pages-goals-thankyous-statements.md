# Campaign Pages, Tip Goals, Thank-yous and Statements (Pro) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four Pro features the owner approved on 13–14 Nov 2026: (1) each Campaign Studio campaign can have its own public page (headline, description, cover, goal, thank-you) at its existing link; (2) simple tip goals worded "tips toward…" on the main page and on campaign pages; (3) a custom thank-you on the receipt and, once per tip, by email to supporters who ask; (4) a monthly PDF statement, plus CSV/Excel for any range, that reconciles with the ledger. Free keeps its one-line thank-you and today's CSV.

**Owner's direction:** board `ProCampaignPages` (approved 14 Nov 2026 with every default on it). It is the same person on every page: one handle, one balance, one set of withdrawals, the same locked tip area. This is a product decision only. It is not a legal, regulatory or payment-partner approval: D-02, D-03, D-07 stay OPEN, D-05 stays PARTLY DECIDED. Nothing here changes a fee, a minimum, a checkout amount, a ledger posting or a payout. Statements only read the ledger.

**Architecture:** Campaign pages are new nullable columns on `campaigns`, read by a new public endpoint the existing `/@handle/<ending>` route already reaches; the tip area stays the main page's `AppreciationForm`, untouched. Goals are a `tip_goals` table whose progress is computed from confirmed tips at read time (never stored as money). "Goal reached" is a one-way `reached_at` stamp written by the worker's `tip.succeeded` handler under a row lock. Thank-you emails reuse the mail queue: the checkout stores the supporter's address sealed beside the tip, and the worker queues one `tip_thanks` email (dedupe key per tip) once the tip is confirmed, then wipes the address. Statements are built from `ledger_entries` on the person's `recipient_payable` account. One pure summariser in `packages/domain` turns the ledger movements into figures, and the summariser, the PDF, the range export and the screen all read it. The worker freezes each month's figures (JSON) and renders a PDF on the 1st with **pdfkit** (no headless browser). A small history table, `plan_changes`, written in the single place `profiles.plan` changes (`recomputePlan`), tells statements which days were Pro and lets a goal pause while Pro has lapsed.

**Tech Stack:** Drizzle/Postgres, NestJS, BullMQ worker, Next.js 16 App Router, Zod, `node --test`, Playwright. **New runtime dependency, worker only:** `pdfkit@0.20.2` (MIT, pure JavaScript, published 30 Aug 2026; dependencies fontkit, linebreak, png-js, fflate, @noble/*). **New dev dependency, worker only:** `@types/pdfkit@0.17.7`. **New assets:** Noto Sans Regular and Bold, subset TTF (SIL OFL 1.1) in `apps/worker/assets/fonts/`. **No Excel library.** `.xlsx` is written by about 120 lines over `node:zlib` (`deflateRawSync`, `crc32`, Node ≥ 22.2; the repo runs Node 24).

**Spec:** `docs/design/redesign/boards/ProCampaignPages.dc.html` (this PR copies the approved board there unchanged, 739 lines). Sections: 1 What changes, 2 Campaign editor, 3 Campaign page, 4 Main-page goal, 5 Thank-you on receipt and by email, 6 Reports and statements, 7 When Pro ends, 8 Rules and questions. Read all of it before any task.

---

## What the code does today (origin/dev `0a490475`, migrations up to 0092)

- **Campaign Studio:** `campaigns(id, profile_id, name ≤40, slug, created_at, stopped_at)` and `tip_campaigns(tip_id PK, campaign_id)` in `packages/database/src/schema.ts:3134-3171`. Operations are in `packages/database/src/operations/campaigns.ts`: `runningCampaignId`, `attributeTip` (called from `intents.ts:272`), `createCampaign` (profile lock, `campaignLimitFor(plan)`: Free 1, Pro 20), `renameCampaign`, `stopCampaign`, `listCampaigns`, `campaignDetail`. Contracts are in `packages/contracts/src/campaigns.ts`. The API is in `apps/api/src/insights/insights.controller.ts` (`GET/POST /v1/me/campaigns`, `PATCH /v1/me/campaigns/:id`, `POST …/:id/stop`), which reads `myPagePlan()` on every request. The web has `apps/web/src/app/dashboard/campaigns/{campaigns-view,new/new-campaign-view,[id]/campaign-view}.tsx`. The copy "No goal, no target amount, no end date, no stated cause." and "Supporters see your page exactly as always" is at `new-campaign-view.tsx:148-160`.
- **Public page:** `apps/web/src/app/people/[handle]/page.tsx`. `[campaign]/page.tsx` re-exports it, so a campaign link opens the normal page. `AppreciationForm` reads the ending with `campaignFromPath(location.pathname)` (`apps/web/src/lib/campaign-link.ts`) and sends `campaign` with the intent. Data comes from `loadPublicProfile` → `GET /v1/profiles/:handle` (`apps/api/src/profiles/public-profile.controller.ts:45`) → `publicProfile()` (`operations/profiles.ts:959`), cached with tag `profileTag(handle)` (`apps/web/src/lib/profiles-api.ts`) and revalidated by `ProfileRevalidator` (API) and `apps/worker/src/revalidate.ts`.
- **Thank-you line:** `profiles.thanks_line/thanks_style/thanks_signed` (`schema.ts:591`). Rules are in `packages/contracts/src/thanks.ts`: `cleanThanksLine`, `hasLink`, `THANKS_LINE_LIMIT` 140, `shownThanks` (Free: paper and unsigned; no line: null), `thanksNeedsPro`. Settings saves through `PUT /v1/me/thanks` (`me-profile.controller.ts:237`, `setThanks` in `operations/profiles.ts:350`). The receipt is `tipStatusView` (`operations/tip-status.ts`), which uses the line **as it is now**, and `apps/web/src/app/tip/[tipId]/status-view.tsx:325-349` with `components/thanks-slip.tsx`. Today a page with no line shows no slip.
- **Mail:** `packages/mail` registry (`templates/registry.ts`), `defineMailType` (`templates/define.ts`, `MAIL_SENDERS`, `senderAddress`), and `enqueueMail(tx, sealing, {type, to, userId?, data, dedupeKey})` (`operations/mail-queue.ts:39`), which seals `to` and refuses a second message with the same dedupe key. The deliverer is `operations/mail-delivery.ts:485` (`from: senderAddress(type.sender, deps.sender)`, `replyTo: deps.replyTo`). The worker handles `tip.succeeded` in `apps/worker/src/handlers/domain-events.ts:201`.
- **Ledger:** `ledger_transactions(operation_type, operation_key unique, tip_id, payout_id, pro_purchase_id, reverses_transaction_id, posted_at)` and `ledger_entries(account_id, side, amount_minor)`. A person's balance is `recipient_payable` credits minus debits (`operations/balance.ts:5`), less what is reserved in flight. The postings that touch `recipient_payable` are: `payment` (`payment.<attemptId>`, credit), `reversal` (debit), `payout` (`payout.<id>`, debit at PAID), `pro_sale` from the balance (`pro.<purchaseId>`, debit), and `reward` (credit). **#197 (open)** adds `payout-user-fee.<id>` (debit, `buildUserPayoutFeePosting`) and `payouts.fee_payer`/`user_fee_minor`: `payouts.amount_minor` is what reaches the bank, and the withdrawal is `amount_minor + user_fee_minor`.
- **Fees:** **#196 (open)** adds `FEE_POLICY_V2_FREE` (`v2-free-7pct`) and `FEE_POLICY_V2_PRO` (`v2-pro-5pct`), chosen by the plan at quote time. `tip_quotes.fee_policy_version` records it, with the suffixes `-custom-<bps>` and `-fee-free`. The CSV export is `exportMyTipsCsv` (`operations/export.ts:42`, `csvCell` neutralises formulas) served at `GET /v1/me/exports/tips.csv` (`dashboard.controller.ts:187`). The Earnings page button is at `earnings-view.tsx:398-415`.
- **Pro:** `profiles.plan` is written **only** by `recomputePlan` (`operations/pro-periods.ts:70`). `setStaffPro` and `setPagePlan` go through it, and so do purchases (`pro-purchases.ts:904`). A lapse hides Pro extras and keeps them. Pro-only writes check the plan, then add `eq(profiles.plan, 'pro')` to the UPDATE (`setThanks`).
- **Worker schedules:** `apps/worker/src/job-worker.ts:337-370`, `ensureSchedule({ queue, id, repeat: { pattern, tz: 'Africa/Lagos' } })`. Monthly moments and recaps run at `0 7 1 * *`. `runMonthlyRecaps` (`operations/recaps.ts:96`) is the pattern for a once-per-page-per-month job (insert `onConflictDoNothing`, then mail with a dedupe key).
- **Flags:** API `flag` (`apps/api/src/config.ts:14`, default false). The worker has its own `z.enum` style (`apps/worker/src/config.ts:84`). e2e turns flags on in `playwright.config.ts:110`. Deploy examples are `deploy/{production,staging}.env.example`.
- **Not built:** goals, supporter email, statements, Excel.

---

## Owner rulings (approved defaults, 14 Nov 2026)

Every value is one constant in contracts, so a change is a one-line edit plus its test.

| #   | Question                        | Ruling                                                                                                            |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Active goals                    | 1 on the main page + 1 per campaign (`GOAL_ACTIVE_LIMIT` per scope = 1)                                           |
| 2   | Amounts or percentage           | The creator chooses; default `percent`                                                                            |
| 3   | Email                           | Once per tip, from TipMe's address, From name "‹Display name› via TipMe"                                          |
| 4   | Statement                       | Made on the 1st (06:00 Lagos) for the month before, emailed as a link; the PDF is never attached                  |
| 5   | Campaign covers and Page Studio | Count toward Page Studio later (stored as cover choices now; see Task 4 note)                                     |
| 6   | Free                            | Keeps its one-line thank-you on the receipt; per-campaign thank-yous, card styles and the email are Pro           |
| 7   | "Goal reached" shows            | 14 days, or until a new goal is set (`GOAL_REACHED_SHOW_DAYS = 14`)                                               |
| 8   | Goal target                     | ₦5,000 to ₦10,000,000, whole naira (`GOAL_TARGET_MIN_MINOR = 500_000n`, `GOAL_TARGET_MAX_MINOR = 1_000_000_000n`) |
| 9   | Supporter's email               | Never shown to the creator (not in any `/v1/me/*` answer, export or statement)                                    |
| 10  | Campaign pages and search       | `robots: noindex, follow`; canonical stays `/@handle`                                                             |
| 11  | What the main goal counts       | Tips to the main page plus tips through campaigns with no goal of their own at the time of the tip                |

### Rulings on gaps the board leaves open (Claude's defaults, changeable)

| #   | Gap                                                      | Ruling                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | A campaign page with no headline                         | A page shows only with a headline. At create on Pro, `headline` defaults to the campaign's name and `page_on` to true. Campaigns that exist before the release keep `page_on = false` (their links behave exactly as today).                                                                                                                                                    |
| G2  | Cover choices for a campaign                             | The page's design, colour and animation choices (`coverDesignChoiceSchema`), or `null` = "Same as page". No photo upload in this plan; Page Studio counts campaign covers when it lands (note in Task 4 for that plan).                                                                                                                                                         |
| G3  | "Before fees"                                            | Goal progress = Σ `tips.gross_minor` of `SUCCEEDED` tips, minus any reversed amount (`reversal` transactions on that tip). It never goes below 0.                                                                                                                                                                                                                               |
| G4  | Refund after "reached"                                   | `reached_at` is one-way. A later refund lowers the bar's number but the page keeps "Goal reached, thank you" for its 14 days.                                                                                                                                                                                                                                                   |
| G5  | "Counts from today"                                      | From the moment the goal is saved (`started_at`), not Lagos midnight.                                                                                                                                                                                                                                                                                                           |
| G6  | Goal paused during a lapse                               | Only tips completed while the page was Pro count (from `plan_changes`, Task 2). Pages that are Pro at migration time get a backfilled `pro` row at their earliest `pro_periods.starts_at`, else at the first instant of the migration's Lagos month.                                                                                                                            |
| G7  | Goal wording                                             | The label is cleaned like the thank-you line (no links, ≤ 60). It is refused (`GOAL_WORDING`) when it contains `fundrais`, `donat`, `charity`, `crowdfund` or `refund` (any case). The copy says "Say what the tips go toward, like ‘a new lens’."                                                                                                                              |
| G8  | Telling the creator a goal was reached                   | One in-app notification and one email (`goal_reached`, `engagement`, preference `notify_milestones`) per goal, after the crossing tip is confirmed. "Keep it up for now" only dismisses the dashboard card.                                                                                                                                                                     |
| G9  | Headline "no one else's name or handle"                  | Refused (`CAMPAIGN_HEADLINE_NAME`) if it contains `@x` where `x` is another page's handle or alias, or if it equals another live page's display name (case-insensitive, after cleaning).                                                                                                                                                                                        |
| G10 | Supporter's address storage                              | Sealed with the mail key in `tip_thanks_requests`, accepted only for a Pro page with the flag on (otherwise ignored, never refused). Wiped (`to_sealed = NULL`) when the email is queued. Rows of tips not confirmed after 48 h are deleted by the daily analytics job. The receipt shows the **masked** address (`maskEmail`), because receipt links can be copied and shared. |
| G11 | Reply-To on the thank-you email                          | `no-reply@<mail domain>` (new `MailType.replyTo: 'none'`).                                                                                                                                                                                                                                                                                                                      |
| G12 | TipMe's default slip                                     | "Thank you for your tip. It really does make a difference." captioned "from TipMe, for ‹first name›", on every plan when the page has no line. Behind `PRO_THANKS_ENABLED`; off = today's behaviour exactly.                                                                                                                                                                    |
| G13 | Campaign name on the receipt ("To DJ Kemi · Lagos Live") | Only when the tip came through a campaign whose page was on while the page was Pro. Otherwise the row reads "To ‹name›" as today.                                                                                                                                                                                                                                               |
| G14 | Which thank-you an email carries                         | Resolved at send time (like the receipt today), so a lapse between tip and confirmation sends the Free version.                                                                                                                                                                                                                                                                 |
| G15 | Statement window                                         | The Pro days of the month: from the first instant the page was Pro in the month to the last (a gap inside stays in, with the plan-rate note). One statement for every page Pro at any time in the month, **even with no activity**.                                                                                                                                             |
| G16 | Closing balance vs. the balance on screen                | The closing balance is the ledger's `recipient_payable` at the window's end. A withdrawal still on its way then is not in it. The PDF adds "₦X was on its way to your bank at the end of the month and shows in the month it's paid."                                                                                                                                           |
| G17 | Statement number                                         | `TM-S-YYYY-MM-NNNN`, a running number per month in the order the job makes them (unique).                                                                                                                                                                                                                                                                                       |
| G18 | Statement email                                          | `statement_ready`, `transactional`, sender `reports`, no preference switch (it is a money record). Subject "Your statement is ready"; no amounts in subject or preheader.                                                                                                                                                                                                       |
| G19 | Range export limits                                      | `from ≤ to`, at most 366 days, at most 20,000 rows (`EXPORT_RANGE_ROW_LIMIT`). Above that it answers 422 `EXPORT_TOO_LARGE`, "Choose a shorter range." "Balance after" is the true running balance, worked out before any filter.                                                                                                                                               |
| G20 | Business tips with a share                               | Tip rows carry `shareMinor`. The statement adds a "Shared with businesses" total only when it is non-zero. given − fee − share = received.                                                                                                                                                                                                                                      |
| G21 | Rate label                                               | The fee line's label comes from `plan_changes` in the window: "TipMe fee on tips, 5%", or "7% to 11 Aug, 5% from 12 Aug". If any tip in the window has a `-custom-` or `-fee-free` version, add "Some tips had a lower agreed fee or no fee."                                                                                                                                   |
| G22 | Statements after account deletion                        | Deleted with the page's other data (as `monthly_recaps`); the ledger is untouched. Retention stays under VALIDATE in `docs/00-DECISIONS.md`.                                                                                                                                                                                                                                    |
| G23 | "Tips toward" and the law                                | Goals are the owner's product framing, not a legal opinion. `TIP_GOALS_ENABLED` stays off in production until the owner says so. Task 1 records this beside D-02.                                                                                                                                                                                                               |

---

## Global Constraints

- **Same person, same tip area.** A campaign page never changes the amounts, the minimum, the name, the photo, the handle, the fee line or the pay button. `aside.tip-instrument` and `AppreciationForm` props are the main page's, byte for byte.
- **Words:** "tips toward…", never fundraising, donation, cause, promise, deadline, refund or all-or-nothing. Users see "tips", not "thanks", where the word means money (#202). Pronoun "they". The payment provider is "our payment partner" and is never named on a page, receipt, email, PDF, CSV or Excel file (`apps/web/test/no-provider-names.test.mjs` roots gain `apps/worker/src/statements`). Never imply regulatory approval.
- **Limits (verbatim from the board):** headline 60, description 200, thank-you 140 (code points), no links, invisible characters stripped (`cleanThanksLine`, `hasLink`). Goal ₦5,000–₦10,000,000.
- **Fees on statements:** Free 7%, Pro 5% (#196). Each withdrawal shows the ₦50 partner fee the user pays, taken from the amount (#197). The figures come from recorded rows, never from today's rates.
- **Money:** integer kobo (`bigint`) end to end. Strings of digits in contracts. Decimal only at the edge (`formatMinor`, PDF, CSV `naira()`). No float anywhere, including percentages (`goalPercent` uses bigint division).
- **Pro is checked on the server for every Pro part,** read from `profiles.plan` per request. Writes add `eq(profiles.plan, 'pro')` to the UPDATE. A lapse hides and keeps, never deletes.
- **Supporter privacy:** a supporter's email is never in any creator-facing answer, export, statement, log or analytics event. Subjects and preheaders carry no private data.
- **Statements reconcile:** opening + tips received + rewards − reversals − Pro − withdrawals − withdrawal fees ± other = closing, and closing = the ledger balance at the window's end. A mismatch throws `StatementMismatchError`; nothing is stored and an issue is opened. It is never "fixed up".
- **Flags (all default off; on in development and e2e, off in production until the owner turns each on):** `CAMPAIGN_PAGES_ENABLED` (API), `TIP_GOALS_ENABLED` (API + worker), `PRO_THANKS_ENABLED` (API + worker), `STATEMENTS_ENABLED` (API + worker). Off means byte-for-byte today's answers (new optional fields absent, new routes 404, jobs not scheduled).
- **Web deploys first:** every new response field is optional, and the web shows nothing new while it is absent.
- **Migrations:** only through `pnpm --filter @tipme/database exec drizzle-kit generate --name <name>`. **The next free number is 0097 or later at build time.** 0093–0096 belong to #196/#197/#193, and the Business Pro plan may take more. Never hand-number or rename.
- **Generated files:** after each API-changing task group, run `pnpm api:openapi && pnpm docs:generate` once. Their `--check` must pass. Never hand-merge them.
- **Process:** test-first (red, then green, with the commands shown). Never edit `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push with pre-push checks on, never `--no-verify`.

## Review Focus

1. **Two tips cross a goal at the same moment.** Expected: one `reached_at`, one notification, one email. _Test:_ `two crossing tips in parallel stamp reached once` (Task 10).
2. **Lagos month edges.** A tip confirmed at 23:59:59 on 31 Oct Lagos (22:59:59Z) is October's, and one at 00:00:00 on 1 Nov Lagos (23:00:00Z on 31 Oct) is November's. Expected: each lands in exactly one statement, and the two statements chain (Oct closing = Nov opening). _Test:_ `month edges in Lagos time and statements chain` (Task 20).
3. **A refund or reversal in a later month, after the money was withdrawn.** Expected: the original month is unchanged, the later month shows its own "Tip refunded" line, the balance may go below zero and the statement still reconciles. _Test:_ `a reversal in a later month is its own line and still reconciles` (Task 20).
4. **The supporter's address leaks to the creator.** Expected: no creator-facing route, export, statement or log contains it. It is wiped once queued. _Test:_ `the supporter's address is in no creator answer or export and is wiped after queueing` (Task 15).
5. **Pro lapses between the tip intent and its confirmation.** Expected: the tip still counts toward the creator's balance. It counts toward a goal only if confirmed while Pro. The email (if asked for) goes with the Free version of the thank-you. _Test:_ `lapse between intent and confirmation` (Task 26).

---

## Delivery order, phases and parallel work

Each phase is one or more PRs behind its own flag and can ship alone. API-changing PRs land in sequence or in one merge train (`docs/runbooks/merge-trains.md`), each with its own drizzle-kit migration.

| Phase                    | Tasks | Flag                     | Migration            | Depends on                         |
| ------------------------ | ----- | ------------------------ | -------------------- | ---------------------------------- |
| 0 Foundations            | 1, 2  | none                     | `plan_changes`       | #196, #197, #202 merged            |
| A Campaign pages         | 3–8   | `CAMPAIGN_PAGES_ENABLED` | `campaign_pages`     | 0                                  |
| B Tip goals              | 9–13  | `TIP_GOALS_ENABLED`      | `tip_goals`          | 0; Task 12's campaign part after A |
| C Thank-yous             | 14–18 | `PRO_THANKS_ENABLED`     | `pro_thanks`         | 0; campaign thank-yous after A     |
| D Reports and statements | 19–25 | `STATEMENTS_ENABLED`     | `monthly_statements` | 0                                  |
| E Lapse and wrap-up      | 26–27 | all four                 | none                 | A–D                                |

**Parallel groups** (independent files, no shared migration within a group):

- **P1:** Task 1 ∥ Task 2.
- **P2 (after Phase 0):** Phase A (Tasks 3→4→5→6∥7→8) ∥ Phase B contracts and DB (Tasks 9→10) ∥ Phase D pure work (Task 19 ∥ Task 21's writer ∥ Task 22).
- **P3:** Task 11 after Task 5 (both edit `public-profile.controller.ts`; land in sequence). Task 14 ∥ Task 20.
- **P4:** web tasks 12, 17, 24 run in parallel once their APIs are merged (separate files; all three touch `pro/page.tsx` copy only in Task 27).
- **Sequence points:** only one migration-generating task at a time per branch train (Tasks 2, 4, 10, 15, 23). Re-run `drizzle-kit generate` after rebasing if another lands first.
- **Page Studio (#195)** also edits `apps/web/src/app/people/[handle]/page.tsx` (it extracts `TipBlock`). Whoever lands second rebases. The campaign top and goal slot (Tasks 6, 12) render in the identity column, never inside the tip block.

### E2E lanes and burn-in

| Phase                          | Lane         | New/changed specs                                                      |
| ------------------------------ | ------------ | ---------------------------------------------------------------------- |
| A                              | `E2E_LANE=3` | `tests/e2e/campaign-pages.spec.ts`                                     |
| B                              | `E2E_LANE=4` | `tests/e2e/tip-goals.spec.ts`                                          |
| C                              | `E2E_LANE=5` | `tests/e2e/thanks-email.spec.ts`, `tests/e2e/thanks.spec.ts` (changed) |
| D                              | `E2E_LANE=6` | `tests/e2e/earnings-reports.spec.ts`                                   |
| E                              | `E2E_LANE=7` | `tests/e2e/pro-lapse-pages.spec.ts`                                    |
| any rerun / two phases at once | `E2E_LANE=8` |                                                                        |

Never lane 9. For each lane: `rm -rf apps/web/.next && E2E_LANE=<n> TURBO_FORCE=true node scripts/build-e2e.mjs`, then `E2E_LANE=<n> node scripts/prepare-e2e-database.mjs`, then the specs with `--workers=2`. **Burn-in before every push:** `E2E_LANE=<n> pnpm exec playwright test <changed specs> --repeat-each=5 --retries=0 --workers=2`, which must be 5/5 green (CI's `e2e-burn-in` does the same). Burn-in safety for these specs: each test makes its own page with `signUpRecipient` and its own campaign slug (`c${testInfo.workerIndex}${Date.now().toString(36)}`). Never read "the first row". Wait for end states (URL, heading in `main`). Any test routing `**/v1/me/**` answers `/v1/me/events` with 204. Hold the goal and statement fetches with `page.route` when a test needs a loading state. No clock races: goals and statements are seeded with `sql()` timestamps, never by waiting. If prepare fails on a migration, confirm 0 connections to `tipme_test_lane<n>` in `pg_stat_activity`, drop that one database, and re-run prepare.

### Commands used below

- **Env:** `source /private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/dbb-env.sh` (if missing: `docker start tipme-dbb-pg tipme-dbb-redis`).
- **Build:** `pnpm install --frozen-lockfile && pnpm exec turbo build --filter=!@tipme/web`.
- **IT `<file>`** (integration, private template; read `scripts/test-integration.mjs` first):
  `node --input-type=module -e "const s=await import('./packages/database/dist/test-support.js'); await s.dropTestDatabases('tipme_it_profeat'); await s.prepareTestTemplate('tipme_it_profeat')" && TIPME_TEST_TEMPLATE=tipme_it_profeat node --import ./packages/observability/dist/register.js --test <file>`
  (drop and re-prepare after every new migration; never use the shared `tipme_it`).
- **Unit:** `pnpm --filter <pkg> build && pnpm --filter <pkg> exec node --test test/<file>`.

---

## Phase 0: Foundations

### Task 1: Decision record, board, flags

**Files:**

- Modify: `docs/00-DECISIONS.md` (add a block after the 12 Nov pricing block: "Campaign pages, tip goals, thank-yous and statements (owner, 13–14 Nov 2026)". It lists rulings 1–11 and G23 verbatim from this plan, says it is a product decision and not a legal or provider approval, and that D-02/D-03/D-07 stay OPEN.)
- Modify: `apps/api/src/config.ts` (after `TEAM_TIPS_ENABLED`): `CAMPAIGN_PAGES_ENABLED: flag`, `TIP_GOALS_ENABLED: flag`, `PRO_THANKS_ENABLED: flag`, `STATEMENTS_ENABLED: flag`, each with a one-line comment.
- Modify: `apps/worker/src/config.ts`: `TIP_GOALS_ENABLED`, `PRO_THANKS_ENABLED`, `STATEMENTS_ENABLED` as `z.enum(['true','false']).default('false').transform(v => v === 'true')`.
- Modify: `playwright.config.ts:110` (API and worker env: all four `'true'`), `deploy/production.env.example`, `deploy/staging.env.example` (empty values with one comment line each).
- Test: `apps/api/test/config.test.mjs`, `apps/worker/test/config.test.mjs`.

**Interfaces:** Produces `ApiConfig.CAMPAIGN_PAGES_ENABLED | TIP_GOALS_ENABLED | PRO_THANKS_ENABLED | STATEMENTS_ENABLED: boolean` and `WorkerConfig.TIP_GOALS_ENABLED | PRO_THANKS_ENABLED | STATEMENTS_ENABLED: boolean`.

- [ ] **Step 1: Failing tests.** `the four Pro page flags default to false`: parse a minimal config and assert each is `false`. `'true' turns each on`.
- [ ] **Step 2: Run, watch them fail.** `pnpm --filter @tipme/api build && pnpm --filter @tipme/api exec node --import @tipme/observability/register --test test/config.test.mjs`. Expected: FAIL, `undefined !== false`.
- [ ] **Step 3: Add the flags and the decision block.**
- [ ] **Step 4: Green.** The same command, plus the worker's. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "chore: flags and decision record for Pro campaign pages, goals, thank-yous and statements"`

### Task 2: Plan history (`plan_changes`) and Pro spans

**Files:**

- Modify: `packages/database/src/schema.ts`: `planChanges = pgTable('plan_changes', { id uuid PK, profileId uuid notNull → profiles, plan text notNull CHECK IN ('free','pro'), changedAt timestamptz notNull })`, index `(profile_id, changed_at)`. Migration: `drizzle-kit generate --name plan_changes`. Add a custom SQL part that backfills, for every `profiles.plan = 'pro'`, one row `('pro', COALESCE((SELECT MIN(starts_at) FROM pro_periods WHERE profile_id = p.id), date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'))` (ruling G6).
- Create: `packages/database/src/operations/plan-history.ts`.
- Modify: `packages/database/src/operations/pro-periods.ts:79-88` (`recomputePlan` calls `notePlanChange` when `changed`), `packages/database/src/index.ts` (exports).
- Test: `packages/database/test/integration/plan-history.test.mjs`.

**Interfaces:**

- Produces `notePlanChange(tx: Tx, profileId: string, plan: PagePlan, at: Date): Promise<void>`.
- Produces `proSpans(db: Database | Tx, profileId: string, from: Date, to: Date): Promise<Array<{ from: Date; to: Date }>>`: the half-open intervals inside `[from, to)` during which the page was Pro. With no rows at all for the page, it uses the current `profiles.plan` for the whole range.
- Produces `wasProAt(spans, at: Date): boolean` (pure helper, exported).

- [ ] **Step 1: Failing tests:**
  - `recomputePlan writes one row per change and none when unchanged`: staff Pro on → 1 row `pro`; again → still 1; off → 2nd row `free`.
  - `proSpans clips to the window`: rows pro@10 Aug 09:00Z, free@14 Dec 00:00Z; window Aug → `[{10 Aug 09:00Z, 1 Sep Lagos}]`; window Dec → `[{1 Dec Lagos, 14 Dec}]`; window Oct → whole month.
  - `no history uses the current plan`.
  - `the migration backfills Pro pages`: a page made Pro by SQL before migrating has one `pro` row (prepare the template, then assert on a seeded Pro demo page).
- [ ] **Step 2: Red.** Build, then `IT packages/database/test/integration/plan-history.test.mjs`. Expected: FAIL, `notePlanChange is not a function`.
- [ ] **Step 3: Implement** the table, the migration, and the two functions (one SQL with `LAG` over the rows ≤ `to`, clipped in TypeScript).
- [ ] **Step 4: Green.** The same command. Expected: 4 pass. Also run `IT tests/integration/pro-*.test.mjs`: unchanged, PASS.
- [ ] **Step 5: Commit.** `feat(pro): record plan changes so statements and goals know the Pro days`

---

## Phase A: Campaign pages (`CAMPAIGN_PAGES_ENABLED`)

### Task 3: Contracts for campaign pages

**Files:**

- Create: `packages/contracts/src/campaign-pages.ts`; export from `packages/contracts/src/index.ts`.
- Modify: `packages/contracts/src/campaigns.ts` (`CampaignDetail.page?: CampaignPageSettings`, `CampaignDetail.pagesAvailable?: boolean`; replace the header comment "no goal, target, end date…" with the new rule: "Pro: its own page if wanted; never a different person or tip area").
- Test: `packages/contracts/test/campaign-pages.test.mjs`.

**Interfaces (Produces):**

```ts
export const CAMPAIGN_HEADLINE_MAX = 60;
export const CAMPAIGN_DESCRIPTION_MAX = 200;
export const campaignPageSchema: z.ZodType<CampaignPageRequest>; // { on: boolean; headline: string|null; description: string|null; cover: CoverDesignChoice|null }, strict
export interface CampaignPageSettings {
  on: boolean;
  headline: string | null;
  description: string | null;
  cover: CoverDesignChoice | null;
}
export interface PublicCampaignPage {
  slug: string;
  headline: string;
  description?: string;
  cover?: ResolvedCover; // absent = same as page
  goal?: PublicGoal; // Phase B
}
```

Headline and description: `cleanThanksLine`, then `''` → `null`, `.refine(!hasLink)` "No links.", code-point max. `on: true` with `headline: null` is refused ("Add a headline to give it its own page.").

- [ ] **Step 1: Failing tests:** `headline is cleaned and limited to 60 code points` (61 × "é" refused, 60 accepted, `"Hi​ there"` → `"Hi there"`); `links are refused in headline and description` (`"see tipme.xyz/@ada"`); `description over 200 refused`; `on without a headline is refused`; `cover null means same as page`; `cover uses the cover rules` (unknown design refused).
- [ ] **Step 2: Red.** `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts exec node --test test/campaign-pages.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green.** Expected: 6 pass.
- [ ] **Step 5: Commit.** `feat(contracts): campaign page settings and the public campaign page`

### Task 4: Database: campaign page columns and operations

**Files:**

- Modify: `packages/database/src/schema.ts` (`campaigns` gains `pageOn boolean notNull default false`, `headline text` CHECK `char_length BETWEEN 1 AND 60`, `description text` CHECK `≤200`, `coverDesign text`, `coverColour text`, `coverAnimation text`, `coverMotion text` CHECK `IN ('once','loop')`). Update the table comment. Migration: `drizzle-kit generate --name campaign_pages`.
- Modify: `packages/database/src/operations/campaigns.ts` (`createCampaign`: on Pro, `pageOn: true, headline: input.name`, ruling G1; `campaignDetail` returns `page`).
- Create: `packages/database/src/operations/campaign-pages.ts`.
- Test: `packages/database/test/integration/campaign-pages.test.mjs`.
- **Note for Page Studio (#195):** add one line under that plan's "Later" in this PR's description, not in its file: "campaign covers (`campaigns.cover_*`) count toward Studio covers when Studio lands" (ruling 5).

**Interfaces:**

- Produces `saveCampaignPage(db: Database, profileId: string, id: string, input: CampaignPageRequest): Promise<CampaignPageSettings>`. Errors: `CAMPAIGN_NOT_FOUND`, `CAMPAIGN_PRO_REQUIRED` (plan free, checked again in the UPDATE `WHERE` via `EXISTS (… plan = 'pro')`), `CAMPAIGN_STOPPED`, `CAMPAIGN_HEADLINE_NAME` (ruling G9).
- Produces `publicCampaignPage(db: Database, handleLower: string, slug: string): Promise<PublicCampaignPage | null>`: non-null only when the page is live, `plan = 'pro'`, the campaign is running, `page_on` is true and `headline` is not null. The cover goes through `resolveCover` with the page's plan.
- Add `CAMPAIGN_PRO_REQUIRED`, `CAMPAIGN_STOPPED`, `CAMPAIGN_HEADLINE_NAME` to `operations/errors.ts`, `packages/contracts/src/errors.ts` and `apps/api/src/http/api-exception.filter.ts` (403, 409, 422).

- [ ] **Step 1: Failing tests:**
  - `a Pro campaign starts with its own page and its name as headline`; `a Free campaign starts with no page`.
  - `campaigns made before the release keep page_on false` (insert with SQL defaults).
  - `saving on Free is refused and nothing changes`; `a lapse during save leaves the row as it was` (flip plan inside a parallel transaction before the UPDATE).
  - `another page's handle or display name as headline is refused` (`"Thanks from @tobi"`, `"Tobi Adeyemi"`); `own handle is fine`.
  - `publicCampaignPage is null for: stopped, page off, free page, unknown slug, not-live page`; `returns headline, description and the resolved cover`.
- [ ] **Step 2: Red.** Build, then `IT packages/database/test/integration/campaign-pages.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** (schema, migration, operations, errors).
- [ ] **Step 4: Green.** The new file and `IT packages/database/test/integration/campaigns.test.mjs`. Expected: all PASS.
- [ ] **Step 5: Commit.** `feat(campaigns): a page for each campaign (headline, description, cover)`

### Task 5: API for campaign pages

**Files:**

- Modify: `apps/api/src/insights/insights.controller.ts`: `PUT /v1/me/campaigns/:id/page` (body `campaignPageSchema`, 404 when the flag is off, revalidates `profileTag(handle)` through `ProfileRevalidator`). `GET /v1/me/campaigns/:id` adds `page` and `pagesAvailable: pro` only when the flag is on.
- Modify: `apps/api/src/profiles/public-profile.controller.ts`: `GET /v1/profiles/:handle/campaigns/:slug` → `{ data: PublicCampaignPage }`, or 404 (flag off, or `null`). Same preview-key gate and cache headers as `profiles/:handle`.
- Test: `tests/integration/campaign-pages-api.test.mjs`.

- [ ] **Step 1: Failing tests:** `flag off: the page route is 404 and detail has no page field` (exact body equality with today's); `Pro saves a page and the public route returns it`; `Free gets 403 CAMPAIGN_PRO_REQUIRED`; `a stopped campaign's public route is 404`; `the public answer has no campaign id, name or results`.
- [ ] **Step 2: Red.** Build, then `IT tests/integration/campaign-pages-api.test.mjs`. Expected: FAIL (404 on PUT with flag on).
- [ ] **Step 3: Implement.** Then `pnpm api:openapi && pnpm docs:generate`.
- [ ] **Step 4: Green.** The same command, plus `node apps/api/dist/openapi/generate.js --check` and `node scripts/generate-docs.mjs --check`. Expected: PASS, "up to date".
- [ ] **Step 5: Commit.** `feat(api): save and serve campaign pages behind CAMPAIGN_PAGES_ENABLED`

### Task 6: Web: the public campaign page (parallel with Task 7)

**Files:**

- Modify: `apps/web/src/lib/profiles-api.ts`: `getPublicCampaignPage(handle: string, slug: string): Promise<PublicCampaignPage | null>` (`'use cache'`, same `cacheLife`, `cacheTag(profileTag(handle))`, 404 → null, any failure → null, so the main page still renders).
- Modify: `apps/web/src/app/people/[handle]/[campaign]/page.tsx`: its own `generateMetadata` (the profile's metadata plus `robots: { index: false, follow: true }` and `alternates.canonical: /@handle` when a campaign page exists). The default export renders `ProfilePage` with a `campaignPage` prop.
- Modify: `apps/web/src/app/people/[handle]/page.tsx`: optional `campaignPage?: PublicCampaignPage | null`. When present, the cover is `campaignPage.cover ?? cover`, and `RecipientIdentity` gets `after={<CampaignTop … />}`. The footer gains `<Link href={`/@${handle}`}>See {firstName}’s main page</Link>` and the line "Tips go to {firstName}." **The `aside.tip-instrument` subtree is unchanged.**
- Create: `apps/web/src/components/profile/campaign-top.tsx` (`<section aria-labelledby>` with `<h2>` headline and `<p>` description; Phase B adds the goal slot).
- Modify: `apps/web/src/components/profile/recipient-card.tsx`: optional `after?: React.ReactNode` rendered after the bio.
- Test: `apps/web/test/campaign-top.test.mjs` (render to string), plus the e2e in Task 8.

- [ ] **Step 1: Failing test:** `campaign top renders the headline as text, never HTML` (`"<b>x</b>"` comes out escaped); `no description, no paragraph`.
- [ ] **Step 2: Red.** `pnpm --filter @tipme/web exec node --test test/campaign-top.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green.** The same command; `pnpm --filter @tipme/web typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(web): a campaign link opens its own page, with the same tip area`

### Task 7: Web: the editor's Page tab, live preview, Free lock, copy (parallel with Task 6)

**Files:**

- Modify: `apps/web/src/app/dashboard/campaigns/[id]/campaign-view.tsx`: tabs "Page", "Results", "QR code" (`role="tablist"`, arrow keys; "Page" only when `detail.page` is present). The Page tab has an "Its own page" switch, Headline (counter "43 of 60"), Short description (optional, "108 of 200. No links."), Cover (picker reusing the settings cover chooser; "Same as page"), "Save page", "Open the link". On a phone the sections fold into rows with "›" summaries, with "Preview" (full screen, "Back to editing" bar) and "Save page" fixed at the bottom.
- Create: `apps/web/src/app/dashboard/campaigns/[id]/page-editor.tsx`, `apps/web/src/app/dashboard/campaigns/[id]/page-preview.tsx` (the preview renders `CampaignTop` plus a static, non-interactive copy of the tip area's amounts; no form).
- Free (`pagesAvailable === false`): the preview with the editor locked and the line, verbatim, "Give each campaign its own page, goal and thank-you with TipMe Pro, ₦5,000 a month." The price comes from `GET /v1/pro/price`, not hard-coded. With no price, say "with TipMe Pro".
- Modify: `apps/web/src/app/dashboard/campaigns/new/new-campaign-view.tsx:148-160`: on Pro with the flag on (detail's `pagesAvailable` from `GET /v1/me/campaigns` → add `pagesAvailable?: boolean` to `CampaignList`), replace the first two bullets with "Its own page, if you want one. A goal is tips toward something, never a promise; there’s no end date and nothing is refunded." Free and flag-off keep today's bullets.
- Test: `apps/web/test/campaign-page-editor.test.mjs` (pure helpers: `counterText(value, max)` gives `"43 of 60"`; `pageSummary(settings)` gives `"Scattered hearts, dark"` / `"Same as page"`).

- [ ] **Step 1: Failing tests** for `counterText` and `pageSummary` (exported from `page-editor.tsx`'s sibling `page-editor-text.ts`).
- [ ] **Step 2: Red.** `pnpm --filter @tipme/web exec node --test test/campaign-page-editor.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green.** The same command and `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(web): Page tab in Campaign Studio with a live preview`

### Task 8: E2E for campaign pages (lane 3)

**Files:** Create `tests/e2e/campaign-pages.spec.ts`.

- [ ] **Step 1: Write the specs** (each with its own `signUpRecipient` page, `makePagePro`, its own slug):
  - `Pro edits a campaign page and a visitor sees it with the same tip area`: fill the headline, see it in the preview region, "Save page", then a new context opens `/@h/<slug>`. `main` has the heading with the headline, the `aside[aria-label^="Tip"]` radio "2,000 NGN", and the link "See … main page" → `/@h`.
  - `the campaign page asks search engines not to index it`: `meta[name=robots]` content contains `noindex`; `link[rel=canonical]` ends `/@h`.
  - `a stopped campaign's link opens the main page`: stop it, open the link, no campaign heading in `main`.
  - `Free sees the Page tab locked`: the text "Give each campaign its own page" in the tab panel, and no "Save page" button.
  - `the new-campaign copy no longer says no goal on Pro`.
  - `expectAccessible` on the campaign page and the editor.
- [ ] **Step 2: Run on lane 3.** `rm -rf apps/web/.next && E2E_LANE=3 TURBO_FORCE=true node scripts/build-e2e.mjs && E2E_LANE=3 node scripts/prepare-e2e-database.mjs && E2E_LANE=3 pnpm exec playwright test tests/e2e/campaign-pages.spec.ts --workers=2`. Expected: 6 passed.
- [ ] **Step 3: Burn in.** `E2E_LANE=3 pnpm exec playwright test tests/e2e/campaign-pages.spec.ts --repeat-each=5 --retries=0 --workers=2`. Expected: 30 passed.
- [ ] **Step 4: Commit.** `test(e2e): campaign pages`

---

## Phase B: Tip goals (`TIP_GOALS_ENABLED`)

### Task 9: Contracts for goals

**Files:** Create `packages/contracts/src/goals.ts` (exported). Modify `PublicProfile` (`goal?: PublicGoal`) and `PublicCampaignPage.goal` (already declared). Test: `packages/contracts/test/goals.test.mjs`.

**Interfaces (Produces):**

```ts
export const GOAL_LABEL_MAX = 60;
export const GOAL_TARGET_MIN_MINOR = 500_000n;      // ₦5,000
export const GOAL_TARGET_MAX_MINOR = 1_000_000_000n; // ₦10,000,000
export const GOAL_REACHED_SHOW_DAYS = 14;
export const GOAL_DISPLAYS = ['percent', 'amount'] as const; export type GoalDisplay = …;
export const goalSetSchema; // { label: string; targetMinor: string /^[1-9]\d{0,11}$/, whole naira, in range; display?: GoalDisplay (default 'percent') }, strict
export function goalWordingProblem(label: string): 'link' | 'words' | null; // ruling G7
export function goalPercent(tippedMinor: bigint, targetMinor: bigint, reached: boolean): number; // floor, 0..99 unless reached → 100
export interface PublicGoal { label: string; display: GoalDisplay; percent: number; reached: boolean; tippedMinor?: string; targetMinor?: string } // amounts only when display = 'amount'
export interface MyGoal { id: string; campaignId: string | null; label: string; targetMinor: string; display: GoalDisplay; tippedMinor: string; tips: number; percent: number; startedAt: string; reachedAt: string | null }
export function goalLine(goal: PublicGoal, money: (minor: string) => string): string;
// "71% of the way toward a new 85mm lens" | "₦180,000 of ₦500,000 toward a new DJ controller" | "Goal reached, thank you"
```

- [ ] **Step 1: Failing tests:** `target bounds` (`'499900'` refused, `'500000'` ok, `'1000000000'` ok, `'1000000100'` refused, `'500050'` refused because it isn't whole naira); `wording` (`"my fundraiser"`, `"Donations for rent"`, `"no REFUNDS"` → `'words'`; `"a new lens"` → null; `"lens.ng"` → `'link'`); `goalPercent(319_500_00n, 450_000_00n, false) === 71`; `goalPercent(449_999_99n, 450_000_00n, false) === 99`; `goalPercent(0n, …) === 0`; reached → 100 even below target; `goalLine` gives the three board strings exactly.
- [ ] **Step 2: Red.** `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts exec node --test test/goals.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(contracts): tip goals ("tips toward…")`

### Task 10: Database: goals, progress, reached

**Files:**

- Modify: `packages/database/src/schema.ts`: `tipGoals = pgTable('tip_goals', { id uuid PK, profileId → profiles notNull, campaignId → campaigns null, label text notNull CHECK 1..60, targetMinor bigint notNull CHECK BETWEEN 500000 AND 1000000000, display text notNull CHECK IN ('percent','amount'), startedAt timestamptz notNull, endedAt timestamptz null, reachedAt timestamptz null, reachedNoticedAt timestamptz null, currency NGN })`. Two partial unique indexes: `(profile_id) WHERE campaign_id IS NULL AND ended_at IS NULL`, and `(campaign_id) WHERE ended_at IS NULL`. Migration: `drizzle-kit generate --name tip_goals`.
- Create: `packages/database/src/operations/goals.ts`. Modify `operations/profiles.ts` `publicProfile` (adds `goal` when the option `goals: true` is passed) and `operations/campaign-pages.ts` (`publicCampaignPage` adds `goal`).
- Test: `packages/database/test/integration/goals.test.mjs`.

**Interfaces:**

- Produces `setGoal(db, profileId, input: { campaignId: string | null; label: string; targetMinor: bigint; display: GoalDisplay; now: Date }): Promise<MyGoal>`. It locks the profile, requires `plan = 'pro'` (`GOAL_PRO_REQUIRED`), a running campaign of this page (`CAMPAIGN_NOT_FOUND` / `CAMPAIGN_STOPPED`), and wording (`GOAL_WORDING`). It ends the active goal in the same scope (`ended_at = now`) and inserts the new one.
- Produces `removeGoal(db, profileId, campaignId: string | null, now: Date): Promise<void>`.
- Produces `myGoal(db, profileId, campaignId: string | null, now: Date): Promise<MyGoal | null>` (the active goal, or one reached within 14 days).
- Produces `publicGoalFor(db, profile: { id: string; plan: PagePlan }, campaignId: string | null, now: Date): Promise<PublicGoal | undefined>`. Undefined when the page is not Pro, there is no active goal, or it was reached more than 14 days ago.
- Produces `goalProgress(db | tx, goal: TipGoalRow, now: Date): Promise<{ tippedMinor: bigint; tips: number }>`. The counting rule, in one SQL plus `proSpans`:
  - tips `SUCCEEDED`, `completed_at ∈ [started_at, COALESCE(ended_at, now))`, and `wasProAt(spans, completed_at)`;
  - a campaign goal counts tips whose `tip_campaigns.campaign_id = goal.campaign_id`;
  - the main goal counts tips with no campaign, plus tips through a campaign that had **no goal active at `completed_at`** (`NOT EXISTS (SELECT 1 FROM tip_goals g2 WHERE g2.campaign_id = tc.campaign_id AND g2.started_at <= t.completed_at AND (g2.ended_at IS NULL OR g2.ended_at > t.completed_at))`);
  - amount = Σ `gross_minor` − Σ reversed, floored at 0 (ruling G3). "Reversed" for a tip is the sum of the **debit** entries of its `reversal` transactions (`ledger_transactions.tip_id = t.id`) on the accounts `recipient_payable`, `business_payable`, `platform_fee_revenue` and `provider_fee_recovered`. `buildReversalPosting` debits exactly those credit lines, totalling the refunded amount; the refund-fee line is excluded.
- Produces `noteGoalsReached(tx: Tx, input: { tipId: string; now: Date }): Promise<Array<{ goalId: string; profileId: string; label: string }>>`. For the tip's goals (its campaign's and/or the main one, by the rule above), it locks each goal row `FOR UPDATE`, recomputes the progress, and if ≥ target and `reached_at IS NULL`, sets `reached_at = now` and returns it.

- [ ] **Step 1: Failing tests** (pretend-provider tips as in `campaigns.test.mjs`'s `paidTip`):
  - `only one active goal per scope; a new one ends the old`.
  - `Free cannot set a goal; a lapse during save leaves nothing`.
  - `campaign goal counts only its link's tips since it was set`.
  - `main goal counts page tips and campaigns without their own goal` (campaign X has a goal and Y has none: a tip via X is not counted on main, a tip via Y is, and a tip via X made before X's goal started is counted on main).
  - `goal counts before fees` (₦2,000 tip → 200000 tipped, not the net).
  - `a reversal lowers progress, never below zero, and reached stays`.
  - `tips while Pro had lapsed don't count` (plan_changes: free gap; a tip inside the gap is excluded).
  - `two crossing tips in parallel stamp reached once` (two transactions run `noteGoalsReached` concurrently; one returns the goal and the other returns `[]`).
  - `reached shows 14 days, then the public goal is gone` (now = reached + 14 d − 1 ms: present with `reached: true`; + 14 d: undefined).
  - `percent display sends no amounts`.
- [ ] **Step 2: Red.** Build, then `IT packages/database/test/integration/goals.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green.** Expected: 10 pass.
- [ ] **Step 5: Commit.** `feat(goals): tip goals with progress from confirmed tips`

### Task 11: API and worker for goals

**Files:**

- Modify: `apps/api/src/insights/insights.controller.ts`: `GET/PUT/DELETE /v1/me/goal` and `GET/PUT/DELETE /v1/me/campaigns/:id/goal` (body `goalSetSchema`; 404 when the flag is off; 403 `GOAL_PRO_REQUIRED`; revalidate the profile tag on change).
- Modify: `apps/api/src/profiles/public-profile.controller.ts`: pass `goals: config.TIP_GOALS_ENABLED` to `publicProfile` and `publicCampaignPage`.
- Modify: `apps/worker/src/handlers/domain-events.ts`: after `notifyTipSucceeded`, when `deps.goalsEnabled`, run `noteGoalsReached` in a transaction. For each goal returned: an in-app notification (`kind: 'goal_reached'`, in `operations/notifications.ts`), `enqueueMail('goal_reached', dedupeKey: goal_reached.<goalId>)` to a verified owner email with `notify_milestones` on, and `revalidate(handle)`. Also, for any tip on a page with an active goal, `revalidate(handle)` so the bar moves.
- Create: `packages/mail/src/templates/types/goal-reached.ts` (subject "Your goal is reached"; preheader "Your page now says thank you."; body: "₦452,500 in tips toward a new 85mm lens, from 96 tips since 1 Nov. Your page now says “Goal reached, thank you”. Tips keep coming in as normal."; button "See your goal" → `/dashboard`). Register it in `registry.ts`.
- Test: `tests/integration/goals-api.test.mjs`, `apps/worker/test/domain-events.test.mjs` (extend), `packages/mail/test/templates.test.mjs` (the sample renders; subject has no amount).

- [ ] **Step 1: Failing tests:** `flag off: goal routes 404 and public profile has no goal key`; `set, read, replace, remove`; `public profile carries the goal in percent mode without amounts`; worker: `a crossing tip notifies once and revalidates`, `a repeat of the event sends nothing more`; mail: `goal_reached subject and preheader carry no amount`.
- [ ] **Step 2: Red.** Build; `IT tests/integration/goals-api.test.mjs`; `pnpm --filter @tipme/worker exec node --test test/domain-events.test.mjs`; `pnpm --filter @tipme/mail exec node --test test/templates.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**, then `pnpm api:openapi && pnpm docs:generate`.
- [ ] **Step 4: Green.** The same commands plus both `--check`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(goals): goal API, reached notice and live bar`

### Task 12: Web for goals

**Files:**

- Create: `apps/web/src/components/profile/tip-goal.tsx`: `<section aria-label="Tip goal">` with the line from `goalLine`, a `<progress max=100 value=percent>` styled as the bar (fill `--tm-violet`, reached = black fill, never past 100%, no celebration effect, `prefers-reduced-motion` respected), and the caption "Tips toward a goal ‹first name› set · No deadline" (main) or "Tips from this page · no deadline" (campaign).
- Modify: `apps/web/src/app/people/[handle]/page.tsx`: `after` holds `<TipGoal>` under the bio when `profile.goal` (main), or inside `CampaignTop` when `campaignPage.goal`.
- Create: `apps/web/src/app/dashboard/settings/sections/tip-goal.tsx` (My page → Tip goal, Pro badge): "Tips toward" + label, "Target" (₦, whole naira), "Supporters see" radios "A percentage · 71% of the way" / "Amounts · ₦319,500 of ₦450,000", "So far, since 1 Nov ₦319,500 · 71%", the fixed hint "Only words like “toward”: a lens, a studio day, a trip. TipMe never calls it fundraising or a donation, and you never promise anything in return.", "Save", "Remove the goal". Free: a one-line teaser, no locked form.
- Modify: `apps/web/src/app/dashboard/campaigns/[id]/page-editor.tsx`: the "Tip goal" section (the same fields) and the hint "Counts tips given through this link from today. No deadline and nothing is ever refunded: each tip reaches your balance as it comes in. When it’s reached, the page says “Goal reached, thank you” and you can set a new one."
- Modify: `apps/web/src/app/dashboard/home-view.tsx`: a "Your goal is reached" card (from `GET /v1/me/goal` with `reachedAt`) with "Set a new goal" / "Keep it up for now" (dismiss, stored per goal id in `localStorage` with try/catch) / "Remove it".
- Test: `apps/web/test/tip-goal.test.mjs` (`goal bar never exceeds 100 and reads the board's words`).

- [ ] **Steps 1–4:** failing unit test → red (`pnpm --filter @tipme/web exec node --test test/tip-goal.test.mjs`) → implement → green, plus `typecheck` and `lint`.
- [ ] **Step 5: Commit.** `feat(web): tip goal bar, settings and campaign goal`

### Task 13: E2E for goals (lane 4)

**Files:** Create `tests/e2e/tip-goals.spec.ts`.

- [ ] **Step 1: Specs:** `Pro sets a main goal and supporters see a percentage` (save in Settings; a visitor sees "0% of the way toward …" in `section[aria-label="Tip goal"]`); `amounts mode shows naira`; `a tip moves the bar after confirmation` (pretend tip via `tipFromProfile`, then reload until the line changes, `toPass` 10 s); `crossing the target shows Goal reached and the dashboard card` (seed a target of ₦5,000 and tip ₦5,000); `goal wording is refused` ("my fundraiser" → the field error "Say what the tips go toward"); `campaign goal on its page`; `expectAccessible`.
- [ ] **Step 2: Lane 4 run.** The build/prepare commands with `E2E_LANE=4`, then `pnpm exec playwright test tests/e2e/tip-goals.spec.ts --workers=2`. Expected: 7 passed.
- [ ] **Step 3: Burn in** `--repeat-each=5 --retries=0`. Expected: 35 passed.
- [ ] **Step 4: Commit.** `test(e2e): tip goals`

---

## Phase C: Thank-yous (`PRO_THANKS_ENABLED`)

### Task 14: Contracts: which thank-you shows, the email opt-in

**Files:**

- Modify: `packages/contracts/src/thanks.ts`: `TIPME_DEFAULT_THANKS = 'Thank you for your tip. It really does make a difference.'`; `ThanksSlip` gains `byTipMeFor?: string`; new `resolveThanks()`.
- Modify: `packages/contracts/src/checkout.ts`: `tipIntentRequestSchema.thanksEmail: z.email().max(254).optional()` (a malformed address is a 400 the form shows: "Check the email address."); `TipStatusView` gains `campaignName?: string` and `thanksEmail?: { state: 'waiting' | 'sent'; toHint: string }`.
- Modify: `packages/contracts/src/campaigns.ts`: `CampaignPageSettings.thanks?: ThanksChoice`.
- Test: `packages/contracts/test/thanks.test.mjs` (extend).

**Interfaces (Produces):**

```ts
export function resolveThanks(p: {
  campaign: {
    line: string | null;
    style: string | null;
    signed: boolean;
    pageOn: boolean;
  } | null;
  page: { line: string | null; style: string | null; signed: boolean };
  plan: PagePlan | undefined;
  displayName: string;
  withDefault: boolean;
}): ThanksSlip | null;
// Pro + campaign.pageOn + campaign.line → campaign slip (style, signature);
// else shownThanks(page…) ; else withDefault ? { line: TIPME_DEFAULT_THANKS, style: 'paper', byTipMeFor: firstNameOf(displayName) } : null
```

- [ ] **Step 1: Failing tests:** the four board cases ("PRO, CAMPAIGN THANK-YOU", "PRO, PAGE THANK-YOU", "FREE, THEIR OWN LINE" → paper and unsigned even with a campaign line, "TIPME'S DEFAULT"); `withDefault false keeps today's null`; `a campaign line with page off falls back to the page's`; `thanksEmail rejects "ada@" and accepts "ada.okafor@gmail.com"`.
- [ ] **Steps 2–4:** red/green with `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts exec node --test test/thanks.test.mjs`.
- [ ] **Step 5: Commit.** `feat(contracts): campaign thank-yous, TipMe's default slip and the email opt-in`

### Task 15: Database: campaign thank-yous, the sealed request, the receipt

**Files:**

- Modify: `packages/database/src/schema.ts`: `campaigns` gains `thanksLine text` CHECK 1..140, `thanksStyle text` CHECK paper/violet/night, `thanksSigned boolean notNull default false`; new `tipThanksRequests = pgTable('tip_thanks_requests', { tipId uuid PK → tips, toSealed text null, toHint text notNull, createdAt, queuedAt timestamptz null })`. Migration: `drizzle-kit generate --name pro_thanks`.
- Modify: `packages/database/src/operations/campaign-pages.ts`: `saveCampaignThanks(db, profileId, id, patch: ThanksPatch): Promise<ThanksChoice>` (Pro only; the same UPDATE guard as `setThanks`).
- Modify: `packages/database/src/operations/intents.ts` (`createPaymentIntent` input `thanksEmail?: { sealed: string; hint: string }`; inserted beside `attributeTip` **only if** the page is `pro` at that moment; ignored otherwise; not part of the request fingerprint).
- Modify: `packages/database/src/operations/tip-status.ts`: read the tip's campaign (`tip_campaigns` → `campaigns`) and use `resolveThanks({ …, withDefault: input.thanksDefault })`. Add `campaignName` per ruling G13, and `thanksEmail` from `tip_thanks_requests` (`state: queued_at ? 'sent' : 'waiting'`, `toHint`).
- Create: `packages/database/src/operations/tip-thanks.ts`:
  - `queueTipThanks(db, input: { sealing: MailSealing; tipId: string; webOrigin?: string; now: Date }): Promise<'queued' | 'not_requested' | 'skipped'>`. It skips (and wipes) when the tip isn't `SUCCEEDED`, has any reversal, or its page isn't `active`. Otherwise, in one transaction: unseal `to_sealed`, `enqueueMail({ type: 'tip_thanks', to, userId: null, dedupeKey: 'tip_thanks.' + tipId, data })`, then `to_sealed = NULL, queued_at = now`.
  - `purgeThanksRequests(db, now: Date): Promise<number>` deletes rows whose tip is not `SUCCEEDED` and `created_at < now − 48 h`, and wipes `to_sealed` on any queued row.
- Test: `packages/database/test/integration/tip-thanks.test.mjs`.

- [ ] **Step 1: Failing tests:**
  - `a Free page's intent stores no request`; `a Pro page's intent stores a sealed address and a masked hint`.
  - `queued once per tip, even when the event repeats` (two calls → one `mail_messages` row with `type = 'tip_thanks'`).
  - `a failed, cancelled or reversed tip never sends one`.
  - **`the supporter's address is in no creator answer or export and is wiped after queueing`:** after queueing, `to_sealed IS NULL`; `exportMyTipsCsv`, `listCampaigns`, `campaignDetail`, `tipStatusView` JSON and every row of `balanceMovements` (Task 20, once it exists) contain neither the address nor its local part.
  - `purge removes unconfirmed requests after 48 hours`.
  - `receipt shows the campaign's thank-you and its name only when its page was on and the page is Pro`.
  - `with the default on, a page with no line shows TipMe's default`; `with it off, null as today`.
- [ ] **Step 2: Red.** Build; `IT packages/database/test/integration/tip-thanks.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green**, plus `IT packages/database/test/integration/thanks.test.mjs` and `IT tests/integration/thanks-api.test.mjs` (unchanged, PASS).
- [ ] **Step 5: Commit.** `feat(thanks): per-campaign thank-yous and the supporter's one-time email request`

### Task 16: Mail and worker: the thank-you email

**Files:**

- Modify: `packages/mail/src/templates/define.ts`: `MailType` gains `fromName?: (data: T, brandName: string) => string` and `replyTo?: 'support' | 'none'`. Export `cleanFromName(name: string): string` (strips `"<>\r\n`, control and format characters; collapses spaces; ≤ 60 code points; empty → brand).
- Modify: `packages/database/src/operations/mail-delivery.ts:485`: `from.name = type.fromName ? type.fromName(data, deps.sender.name) : …`; `replyTo = type.replyTo === 'none' ? \`no-reply@${deps.sender.domain}\` : deps.replyTo`.
- Create: `packages/mail/src/templates/types/tip-thanks.ts`: `id 'tip_thanks'`, `category 'transactional'`, `sender 'hello'`, `preference null`, `tracking false`, `replyTo 'none'`, `fromName: (d, brand) => \`${cleanFromName(d.displayName)} via ${brand}\``. Schema: `{ displayName, firstName, amountMinor, completedAt, reference, campaignName: string|null, line, signature: string|null, byTipMe: boolean, receiptPath }`. Subject **"A thank-you from ‹display name›"**. Body (verbatim): "Hi ‹supporter name or "there"›," / "‹Name› got your ₦2,000 tip[ from ‹campaign›], and wrote you this:" / the line / signature / "Your tip", "When", "Reference" / button "View your receipt" / footer "You’re getting this because you asked for ‹Name›’s thank-you when you tipped. We send it once and won’t email you again about this tip. ‹Name› doesn’t see your email address. TipMe, Lagos." Register it. The preheader carries no amount: "A note from the person you tipped."
- Note: the supporter's name for "Hi Ada," comes from `tips.payer_display_label` (first word), else "Hi there,".
- Modify: `apps/worker/src/handlers/domain-events.ts`: on `tip.succeeded`, when `deps.thanksEnabled`, `queueTipThanks(...)`. Modify `apps/worker/src/job-worker.ts` `ANALYTICS_DAILY_JOB` branch: `purgeThanksRequests`.
- Test: `packages/mail/test/tip-thanks.test.mjs`, `packages/database/test/integration/mail-delivery.test.mjs` (extend), `apps/worker/test/domain-events.test.mjs` (extend).

- [ ] **Step 1: Failing tests:** `From is "DJ Kemi via TipMe" and Reply-To is no-reply`; `a display name with quotes, angle brackets or a newline is cleaned in the From name`; `subject has no amount, preheader neither`; `body has no link but the receipt button` (`hasLink` on the text part minus the button URL); `body never names the payment partner`; worker: `thanks flag off: nothing queued`.
- [ ] **Steps 2–4:** red/green (`pnpm --filter @tipme/mail build && pnpm --filter @tipme/mail exec node --test test/tip-thanks.test.mjs`, `IT …/mail-delivery.test.mjs`, the worker test). Also `pnpm --filter @tipme/web exec node --test test/no-provider-names.test.mjs`.
- [ ] **Step 5: Commit.** `feat(mail): the thank-you email, once per tip, from the person via TipMe`

### Task 17: API and web for thank-yous

**Files:**

- Modify: `apps/api/src/checkout/checkout.service.ts` (seal `thanksEmail` with the mail sealing key and `maskEmail` it; drop it when the flag is off), `apps/api/src/insights/insights.controller.ts` (`PUT /v1/me/campaigns/:id/thanks`, body `thanksPatchSchema`), and the tip-status route (pass `thanksDefault: config.PRO_THANKS_ENABLED`). Make `PublicProfile.thanksEmail?: true` present only for Pro with the flag on (the form shows the tick box only then).
- Modify: `apps/web/src/components/appreciation-form.tsx`: when `thanksEmail` is offered, add a checkbox "Email me ‹first name›’s thank-you". Ticking it reveals an email input (`type=email`, `autocomplete=email`) and the line "Your email is only used to send this thank-you and your receipt. ‹First name› doesn’t see it." Send `thanksEmail` only when ticked and non-empty. **No other change to the tip area.**
- Modify: `apps/web/src/app/tip/[tipId]/status-view.tsx`: the receipt row "To ‹name›[ · ‹campaignName›]"; under it, `thanksEmail.state === 'sent'` → "We’ve emailed ‹first name›’s thank-you to ‹toHint›.", `'waiting'` → "We’ll email ‹first name›’s thank-you to ‹toHint›." Modify `components/thanks-slip.tsx`: `byTipMeFor` → figcaption "from TipMe, for ‹name›".
- Modify: `apps/web/src/app/dashboard/campaigns/[id]/page-editor.tsx`: a "Thank-you" section (140 counter, "No links. On their receipt, and emailed once to supporters who left their email. Off: your page’s thank-you.", card Paper/Violet/Night, "Sign it “‹first name›”").
- Test: `tests/integration/thanks-email-api.test.mjs`, `apps/web/test/thanks-slip.test.mjs`.

- [ ] **Step 1: Failing tests:** API: `flag off ignores thanksEmail and tip status has no thanksEmail key`; `a malformed address is 400`; `Free page: thanksEmail ignored, no row`; `PUT campaign thanks on Free is 403`. Web: `TipMe's default slip reads "from TipMe, for Kemi"`.
- [ ] **Steps 2–4:** red/green; then `pnpm api:openapi && pnpm docs:generate` and both `--check`.
- [ ] **Step 5: Commit.** `feat: thank-you email opt-in on the tip form and the receipt`

### Task 18: E2E for thank-yous (lane 5)

**Files:** Create `tests/e2e/thanks-email.spec.ts`; modify `tests/e2e/thanks.spec.ts` (headings follow #202: "got your tip.").

- [ ] **Step 1: Specs:** `a supporter asks for the thank-you and the receipt says it was emailed` (Pro page, campaign page with a thank-you, tick the box, enter `ada+<run>@example.test`, pay; the receipt region shows the campaign's line and "We’ve emailed" with a masked address; `sql` shows one `mail_messages` row of type `tip_thanks` for this tip and `tip_thanks_requests.to_sealed IS NULL`); `Free page has no tick box`; `no line: TipMe's default slip`; `expectAccessible` on the form with the box ticked.
- [ ] **Step 2: Lane 5 run.** Expected: all passed. **Step 3: Burn in** both changed specs with `--repeat-each=5 --retries=0`. **Step 4: Commit** `test(e2e): thank-you email and default slip`.

---

## Phase D: Reports and statements (`STATEMENTS_ENABLED`)

### Task 19: The statement summariser (pure, domain)

**Files:** Create `packages/domain/src/statements.ts` (exported). Test: `packages/domain/test/statements.test.mjs`.

**Interfaces (Produces):**

```ts
export type MovementKind =
  | 'tip'
  | 'tip_reversal'
  | 'withdrawal'
  | 'withdrawal_fee'
  | 'pro'
  | 'reward'
  | 'other';
export interface BalanceMovement {
  at: Date;
  kind: MovementKind;
  amountMinor: bigint; // signed, as it moved the balance
  tipId?: string;
  payoutId?: string;
  campaignId?: string | null;
  givenMinor?: bigint;
  feeMinor?: bigint;
  shareMinor?: bigint; // tips only: given − fee − share = amount
  feeVersion?: string;
  bank?: { name: string; last4: string };
  reference?: string;
  supporter?: string | null;
}
export interface StatementSummary {
  openingMinor: bigint;
  closingMinor: bigint;
  tips: {
    count: number;
    givenMinor: bigint;
    feeMinor: bigint;
    shareMinor: bigint;
    receivedMinor: bigint;
  };
  reversalsMinor: bigint;
  rewardsMinor: bigint;
  proMinor: bigint;
  otherMinor: bigint;
  withdrawals: {
    count: number;
    withdrawnMinor: bigint;
    feeMinor: bigint;
    toBankMinor: bigint;
    rows: Array<{
      at: Date;
      bank: { name: string; last4: string };
      withdrawnMinor: bigint;
      feeMinor: bigint;
      toBankMinor: bigint;
    }>;
  };
  paidOutMinor: bigint; // withdrawn (fees included) + Pro, as the board's "Paid out"
  byCampaign: Array<{
    campaignId: string | null;
    count: number;
    givenMinor: bigint;
    feeMinor: bigint;
    receivedMinor: bigint;
  }>;
}
export class StatementMismatchError extends Error {}
export function summariseStatement(
  openingMinor: bigint,
  movements: readonly BalanceMovement[],
): StatementSummary;
export function assertReconciles(
  summary: StatementSummary,
  ledgerClosingMinor: bigint,
): void; // throws StatementMismatchError
export function planRateLabel(
  spans: { plan: 'free' | 'pro'; from: Date }[],
  feeVersions: string[],
): string; // ruling G21
```

A withdrawal row pairs `withdrawal` (to bank) and `withdrawal_fee` by `payoutId`: withdrawn = toBank + fee. A tip row asserts `givenMinor − feeMinor − shareMinor === -(-amountMinor)`, else it throws `StatementMismatchError`.

- [ ] **Step 1: Failing tests:**
  - **`the board's October statement`** (fixture built from the board, in kobo): opening 6_230_000; one `pro` −500_000 on 1 Oct; 148 tips summing given 61_200_000, fee 3_060_000, received 58_140_000, split over campaigns eko (64 / 28_800_000 / 1_440_000), owambe (41 / 15_650_000 / 782_500), mix (18 / 5_200_000 / 260_000), page (25 / 11_550_000 / 577_500); withdrawals 6 Oct (19_995_000 + 5_000), 17 Oct (24_995_000 + 5_000), 28 Oct (9_995_000 + 5_000). Assert closing 8_870_000; `paidOutMinor` 55_500_000; withdrawals total 55_000_000 / fee 15_000 / to bank 54_985_000; campaign rows add to 148 and 61_200_000; each row's fee is exactly 5% of its given.
  - `a tip whose parts don't add up throws`; `assertReconciles throws on a 1 kobo difference`.
  - `planRateLabel`: Pro all month → "5%"; free → pro on 12 Aug → "7% to 11 Aug, 5% from 12 Aug"; a `-custom-400` version adds "Some tips had a lower agreed fee or no fee."
- [ ] **Steps 2–4:** red/green (`pnpm --filter @tipme/domain build && pnpm --filter @tipme/domain exec node --test test/statements.test.mjs`).
- [ ] **Step 5: Commit.** `feat(domain): statement summary that must reconcile`

### Task 20: Ledger movements and the reconciliation test (parallel with Task 14)

**Files:** Create `packages/database/src/operations/statements.ts` (first part). Test: `packages/database/test/integration/statement-ledger.test.mjs`.

**Interfaces (Produces):**

- `balanceMovements(db: Database | Tx, profileId: string, from: Date, to: Date): Promise<{ openingMinor: bigint; closingMinor: bigint; movements: BalanceMovement[]; inFlightMinor: bigint }>`.
  - opening/closing: Σ signed `recipient_payable` entries for the profile with `posted_at < from` / `< to`.
  - movements: one per `recipient_payable` entry with `from ≤ posted_at < to`, ordered `(posted_at, transaction id)`, classified by `operation_type` + key prefix: `payment` → `tip`, joined to `tips`, `tip_quotes` (`fee = platform_fee_minor + provider_fee_minor`, `feeVersion`), `tip_business_shares`, `tip_campaigns`, `payer_display_label`, and the attempt reference's last 6; `reversal` → `tip_reversal`; `payout.` → `withdrawal` (+ `payout_destinations.bank_name/account_last4`); `payout-user-fee.` → `withdrawal_fee`; `pro_sale` → `pro`; `reward` → `reward`; anything else → `other`.
  - `inFlightMinor`: payouts `REQUESTED|PROCESSING` created before `to` and not PAID by `to` (ruling G16).
  - Never selects a message, a note or `tip_thanks_requests`.

- [ ] **Step 1: Failing tests** (pretend provider; postings through the real operations, never hand-inserted ledger rows):
  - **`statement figures reconcile with the ledger`**: a random mix seeded with a fixed seed (`node:crypto` seeded PRNG from the test name), 40 operations over three Lagos months: tips (Free 7% then Pro 5% after a `plan_changes` switch), tips via two campaigns, a business tip with a share, a reward, a Pro month from the balance, two withdrawals with the user fee (#197) and one with `fee_payer = tipme`, a partial reversal. For each month: `summariseStatement` + `assertReconciles` pass; `closing === balanceIn(db, id).availableMinor + reserved` at the month end; Σ of the movement amounts = closing − opening.
  - **`month edges in Lagos time and statements chain`** (Review Focus 2).
  - **`a reversal in a later month is its own line and still reconciles`** (Review Focus 3): tip in Oct, withdraw all in Oct, reversal in Nov → Nov closing < 0 and reconciles; the Oct summary is unchanged when rebuilt.
  - `a withdrawal on its way at month end is reported as in flight, not in closing`.
  - `fees shown are the recorded ones`: a Free tip before the switch shows a 7% fee even when the page is Pro now.
- [ ] **Steps 2–4:** red/green with `IT packages/database/test/integration/statement-ledger.test.mjs`.
- [ ] **Step 5: Commit.** `feat(statements): balance movements from the ledger, tested to reconcile`

### Task 21: Range export, CSV and Excel

**Files:**

- Create: `packages/database/src/xlsx.ts`: `toXlsx(sheet: { name: string; header: string[]; rows: Array<Array<string | { n: string }>> }): Buffer`, a minimal OOXML workbook (parts `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` with one `0.00` number format, `xl/worksheets/sheet1.xml` with inline strings) zipped with `deflateRawSync` and `zlib.crc32`. Strings are always `t="inlineStr"`, so a cell can never be a formula. XML text is escaped, and characters outside XML 1.0 are dropped.
- Modify: `packages/database/src/operations/statements.ts`: `exportStatementRange(db, profileId, q: StatementExportQuery, now: Date): Promise<{ header: string[]; rows: ExportRow[] }>` with the board's columns in order: `date · type · campaign · link · supporter name · given · fee · received · balance after · reference (last 6) · status`. Types are `tip | fee | withdrawal | withdrawal fee | Pro | reward | refund | other`. Each tip writes two rows (`tip` with given and received, and `fee`) as the board lists "fee" as a type. `include` filters `tips`, `withdrawals`, `pro`; `campaign` is `all | page | <campaignId>`. Lagos dates. The running balance is computed before filtering.
- Modify: `packages/contracts/src/statements.ts` (create): `statementExportQuerySchema` (`from`, `to` `YYYY-MM-DD`, `format: 'csv' | 'xlsx'`, `include` comma list default all, `campaign` default `all`), `EXPORT_RANGE_DAYS = 366`, `EXPORT_RANGE_ROW_LIMIT = 20_000`.
- Modify: `apps/api/src/dashboard/dashboard.controller.ts`: `GET /v1/me/exports/range` (Pro → file `tipme-<from>-to-<to>.csv|xlsx`, `Content-Type` `text/csv; charset=utf-8` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Cache-Control: private, no-store`; Free → 403 `EXPORT_PRO_REQUIRED`; flag off → 404; too large → 422 `EXPORT_TOO_LARGE`). `GET /v1/me/exports/tips.csv` stays as it is for everyone.
- Test: `packages/database/test/xlsx.test.mjs` (unit), `packages/database/test/integration/statement-export.test.mjs`, `tests/integration/statement-export-api.test.mjs`.

- [ ] **Step 1: Failing tests:** xlsx: `the zip's central directory lists the six parts with correct CRCs` (a 40-line reader in the test: parse the end-of-central-directory, inflate each entry, compare `zlib.crc32`); `"=HYPERLINK(...)" is an inline string, never <f>`; `naira cells are numbers with format 0.00`. Export: `columns in the board's order`; `balance after matches the running ledger balance even when filtered to one campaign`; `no message, note or supporter email appears` (grep the CSV for the seeded message text and address); `CSV cells are formula-safe` (supporter label `=cmd` → `'=cmd`). API: `Free gets 403`, `367 days is 422`, `flag off 404`.
- [ ] **Steps 2–4:** red/green; `pnpm api:openapi && pnpm docs:generate` and both `--check`.
- [ ] **Step 5: Commit.** `feat(reports): CSV or Excel for any range (Pro)`

### Task 22: The PDF renderer (worker, pdfkit)

**PDF approach (decided):** render in the worker with **pdfkit 0.20.2**. Why:

- **No headless browser:** no Chromium (≈300 MB, 2–4 s per render) in the worker image. The Page Studio plan rejected a browser in the worker for the same reason.
- **A layout engine fit for tables:** pdfkit gives text measurement, line breaking (`linebreak`) and page breaks, so "long months add pages, with totals on page 1" is straightforward.
- **Embedded fonts:** it embeds TrueType through `fontkit`, which the naira sign needs. The standard 14 PDF fonts have no ₦, and the repo's Manrope copies don't draw U+20A6 either (checked with `lib/font-cmap.ts`: `characterMap(Manrope-SemiBold.ttf).has(0x20A6) === false`).
- **MIT and maintained** (0.20.2, Aug 2026). **pdf-lib** was rejected: no release since 2021, no text layout, and it needs a separate fontkit wrapper. **react-pdf** was rejected: a React renderer plus yoga in the worker, a much larger footprint.
- **Small footprint:** a worker-only dependency, never imported by web or API (a source test greps for it).

**Files:**

- Modify: `apps/worker/package.json` (`"pdfkit": "0.20.2"`, dev `"@types/pdfkit": "0.17.7"`), `pnpm-lock.yaml` (via `pnpm --filter @tipme/worker add pdfkit@0.20.2 && pnpm --filter @tipme/worker add -D @types/pdfkit@0.17.7`).
- Create: `apps/worker/assets/fonts/NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `OFL-NotoSans.txt`. Take them from google/fonts `ofl/notosans` at a pinned commit and subset with `pyftsubset --no-hinting --layout-features='kern,liga' --unicodes=U+0000-024F,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+20A6,U+2212,U+2192`. Record the source URL, commit, upstream sha256 and subset sizes in `docs/third-party-component-register.md` (a new "Statement PDF" entry with pdfkit's licence, size and decision).
- Create: `apps/worker/src/statements/pdf.ts`: `renderStatementPdf(data: StatementData, options?: { compress?: boolean }): Promise<Buffer>`. A4, 40 pt margins, TipMe heart and wordmark (vector paths from `HEART_MARK`), "Statement TM-S-…", "Tips statement, October 2026", "1 to 31 October 2026, Lagos time · made 1 Nov 2026, 6:00 am · amounts in naira". Four boxes (OPENING BALANCE, TIPS RECEIVED, AFTER 5%, PAID OUT, CLOSING BALANCE), "HOW YOUR BALANCE MOVED", "TIPS BY CAMPAIGN", "WITHDRAWALS". The footer is verbatim from the board, with the rate from `planRateLabel` and the in-flight line when `inFlightMinor > 0`, then "Page N of M". Metadata: `Title`, `Author: 'TipMe'`, `CreationDate = data.madeAt` (deterministic output).
- Modify: `packages/contracts/src/statements.ts`: `StatementData` (the frozen snapshot, all money as digit strings: `number`, `month`, `window {from,to}`, `madeAt`, `page {displayName, handle, plan}`, `summary` as strings, `rateLabel`, `campaigns [{name, slug|null}]`, `inFlightMinor`) and `statementDataOf(summary, …)`.
- Modify: `apps/web/test/no-provider-names.test.mjs` (add `apps/worker/src/statements` to `roots`).
- Test: `apps/worker/test/statement-pdf.test.mjs`.

- [ ] **Step 1: Failing tests** (render with `compress: false` and read the text operators):
  - `the board's October renders on one page with its figures`: contains "Tips statement, October 2026", "₦62,300", "₦88,700", "₦549,850", "Page 1 of 1".
  - `the naira sign is drawn by the embedded font`: the font subset's cmap (read with the worker's copy of `characterMap`) has U+20A6 and U+2212.
  - `a month with 400 movements adds pages and keeps the totals on page 1`.
  - `the same data renders the same bytes` (sha256 equal twice).
  - `no payment partner name and only last 4 bank digits` (`/\d{5,}/` absent from bank cells).
  - `pdfkit is imported only by the worker` (grep `apps/web/src`, `apps/api/src`, `packages/*/src` for `pdfkit`: none).
- [ ] **Steps 2–4:** red/green (`pnpm --filter @tipme/worker build && pnpm --filter @tipme/worker exec node --test test/statement-pdf.test.mjs`), plus `pnpm --filter @tipme/web exec node --test test/no-provider-names.test.mjs`.
- [ ] **Step 5: Commit.** `feat(worker): statement PDF with pdfkit and an embedded naira-capable font`

### Task 23: Monthly statements job, email, list and download

**Files:**

- Modify: `packages/database/src/schema.ts`: `monthlyStatements = pgTable('monthly_statements', { id uuid PK, profileId → profiles notNull, month text notNull CHECK '^\d{4}-(0[1-9]|1[0-2])$', number text notNull unique, windowFrom timestamptz, windowTo timestamptz, data jsonb notNull, pdf bytea notNull, pdfSha256 text notNull, createdAt })`, `unique(profile_id, month)`. Migration: `drizzle-kit generate --name monthly_statements`. Account deletion removes the rows (wherever `monthly_recaps` are removed; ruling G22).
- Modify: `packages/database/src/operations/statements.ts`: `runMonthlyStatements(db, input: { sealing: MailSealing; month: string; now: Date; render: (data: StatementData) => Promise<Buffer> }): Promise<{ created: number; mismatched: number }>`. Pages: every profile with a Pro span in the month (`proSpans`) and `page_state <> 'deleted'`. Window = first span start → last span end (ruling G15). For each page: `balanceMovements` → `summariseStatement` → `assertReconciles` (a mismatch opens an issue via `operations/issues.ts` and skips the page) → `render` → insert `onConflictDoNothing`, with the number assigned under `pg_advisory_xact_lock(hashtext('statements.' || month))` as `TM-S-YYYY-MM-` + 4-digit sequence (ruling G17) → `enqueueMail('statement_ready', dedupeKey statement_ready.<profileId>.<month>)` to a verified owner email.
  - `listStatements(db, profileId, now): Promise<StatementList>`, `statementPdf(db, profileId, id): Promise<{ number: string; month: string; pdf: Buffer } | null>`, `reportsSummary(db, profileId, now): Promise<ReportsSummary>` (last finished Lagos month live: tips, given, fee and rate, received; Pro adds withdrawn, count, fees, the balance at month end and at its start).
- Create: `packages/mail/src/templates/types/statement-ready.ts` (ruling G18): heading "Your statement is ready"; text "Your TipMe statement for ‹Month YYYY› is ready to download."; button "See your statements" → `/dashboard/earnings/reports`; reason "We send this on the 1st of each month while you’re on TipMe Pro. The file stays in Reports."
- Modify: `apps/worker/src/job-worker.ts`: `STATEMENTS_MONTHLY_JOB` scheduled `{ pattern: '0 6 1 * *', tz: 'Africa/Lagos' }` only when `config.STATEMENTS_ENABLED`, inside the run lock, `render: renderStatementPdf`.
- Modify: `apps/api/src/insights/insights.controller.ts`: `GET /v1/me/statements` (Pro and lapsed-with-statements: the list; Free with none: an empty list), `GET /v1/me/statements/:id/pdf` (`application/pdf`, `Content-Disposition: attachment; filename="tipme-statement-<month>.pdf"`, `private, no-store`; **statements made while Pro stay downloadable after a lapse**), `GET /v1/me/reports/summary`. All 404 with the flag off.
- Contracts (`statements.ts`): `StatementListItem { id; month; number; tips: number; openingMinor; closingMinor; madeAt; joinedOn?: string; endedOn?: string }`, `StatementList { statements; current: { month; tips; givenMinor; readyOn } | null }`, `ReportsSummary`.
- Test: `packages/database/test/integration/statements-job.test.mjs`, `tests/integration/statements-api.test.mjs`, `packages/mail/test/templates.test.mjs`.

- [ ] **Step 1: Failing tests:** `one statement per Pro page and month however often the job runs`; `a Pro page with no activity still gets one`; `the month Pro started runs from that day` (`joinedOn` "12 Aug"); `the month Pro ended runs to that day`; `a mismatch stores nothing and opens an issue` (stub `balanceMovements` result via a test seam: a `render` that is never called); `numbers are unique and sequential per month`; `statement_ready subject and preheader carry no amount`; API: `lapsed page still downloads October's PDF`, `another page's statement id is 404`, `flag off 404`.
- [ ] **Steps 2–4:** red/green; `pnpm api:openapi && pnpm docs:generate` and both `--check`.
- [ ] **Step 5: Commit.** `feat(statements): monthly PDF on the 1st, emailed as a link`

### Task 24: Web: the Reports tab

**Files:**

- Create: `apps/web/src/app/dashboard/earnings/reports/page.tsx`, `reports-view.tsx`. Modify `earnings-view.tsx` (tabs "Overview" | "Reports" as links, `aria-current="page"`; the header's "Download as CSV" moves to Reports for everyone; the hint "after TipMe’s 10%" is #196's to change, so don't touch it here).
- **Pro:** tiles "Tips in ‹Month›", "TipMe fee, 5%", "Withdrawn" ("3 withdrawals, ₦150 in fees"), "Balance, 31 Oct" ("From ₦62,300 on 1 Oct"). "Monthly statements": "A PDF for each month, made on the 1st. We email you a link when it’s ready.", one row per statement ("October 2026 · 148 tips · balance ₦62,300 → ₦88,700 · Made 1 Nov · Download PDF"; the joined month says "The month you joined Pro, from 12 Aug"), plus the current month "So far: 61 tips, ₦254,000 · Ready 1 Dec · Not ready yet" (disabled). "Export any range": From/To dates, Include (three checkboxes), Campaign (select "All campaigns and your page link" / each campaign / "Your page link"), CSV/Excel radio, "Download". The fixed line: "Supporter messages and emails are never in the file. References show their last 6 characters, as today."
- **Free:** the tiles (tips, "TipMe fee, 7%", received), "Your tips as a file" with today's text and "Download as CSV", then one line: "Monthly statements and Excel are part of TipMe Pro. A PDF each month with your balance, fees and withdrawals, ready for your records or your accountant. ₦5,000 a month. See Pro". The price comes from `/v1/pro/price`. No locked rows, no blur.
- **Phone:** tiles two by two; statement rows stack with full-width buttons (layout measured with `documentElement.clientWidth`).
- **Flag off** (`/v1/me/statements` 404): the Reports tab shows only "Your tips as a file", which is today's CSV.
- Test: `apps/web/test/reports-text.test.mjs` (`statementRowText(item)` gives the board strings exactly).

- [ ] **Steps 1–4:** failing unit test → red → implement → green, plus `typecheck` and `lint`.
- [ ] **Step 5: Commit.** `feat(web): Earnings → Reports with statements and range exports`

### Task 25: E2E for reports (lane 6)

**Files:** Create `tests/e2e/earnings-reports.spec.ts`.

- [ ] **Step 1: Specs:** `Pro downloads a monthly statement` (seed a `monthly_statements` row for the page with a small real PDF made by running the worker's renderer in `global-setup`, or by inserting the bytes from `tests/e2e/fixtures/statement.pdf`; click "Download PDF" and assert `download.suggestedFilename()` is `tipme-statement-2026-10.pdf` with `%PDF-` as the first bytes); `Pro exports a range as Excel` (the suggested name ends `.xlsx` and the bytes start `PK`); `Free sees today's CSV and one line about Pro` (no "Download PDF" in `main`); `phone layout has no horizontal scroll at 390px`; `expectAccessible`.
- [ ] **Step 2: Lane 6 run**, **Step 3: burn in** (`--repeat-each=5 --retries=0`), **Step 4: commit** `test(e2e): earnings reports`.

---

## Phase E: Lapse and wrap-up

### Task 26: When Pro ends: one test across all four, and the banner

**Files:**

- Modify: `apps/web/src/app/dashboard/home-view.tsx` (or the existing Pro-ended banner if #182's work placed one; search for `pro-ended` first). Banner, verbatim with live values: "TipMe Pro ended on ‹14 Dec›. Your ‹6› campaign links and QR codes keep working and now open your main page. Your campaign pages, goals and thank-yous are saved and come back when you renew. Statements up to ‹14 Dec› stay in Reports." plus "Renew for ‹₦5,000›". The counts come from `GET /v1/me/campaigns` (running) and the price from `/v1/pro/price`.
- Test: `tests/integration/pro-lapse-pages.test.mjs`.

- [ ] **Step 1: Failing tests:**
  - **`lapse hides and keeps every part`**: a Pro page with a campaign page, a main and a campaign goal, a campaign thank-you with violet/signed, and October's statement. After `expireDuePeriods` past grace: `GET /v1/profiles/:h/campaigns/:slug` is 404 (the link opens the main page); `publicProfile` has no `goal`; a new tip's receipt shows the page line on paper, unsigned; every `campaigns.*`, `tip_goals` and `monthly_statements` row is unchanged; `GET /v1/me/statements/:id/pdf` is 200; the range export is 403; `tips.csv` is 200.
  - **`lapse between intent and confirmation`** (Review Focus 5): intent with `thanksEmail` while Pro, the plan goes free, then the tip is confirmed. The balance is credited; the goal does not count it; one `tip_thanks` email is queued whose `data.byTipMe`/`style` is the Free version.
  - **`renewal brings everything back with the goal paused for the gap`**: tips during the gap are not counted after renewal.
  - **`the month Pro ended has a statement for the Pro days only`** (window ends at the lapse).
- [ ] **Steps 2–4:** red/green with `IT tests/integration/pro-lapse-pages.test.mjs`. Fix any gate that leaks, in its owning operation.
- [ ] **Step 5: Commit.** `feat(pro): lapse hides and keeps campaign pages, goals, thank-yous; statements stay`

### Task 27: Copy, Pro page, help, and the lapse e2e (lane 7)

**Files:**

- Modify: `apps/web/src/app/pro/page.tsx` (`Campaign links` entry → "Campaign pages: up to 20 links, each with its own page, tip goal and thank-you"; add "Tip goals", "Thank-you by email", "Monthly statements and Excel"; each shows only when the server says the feature is on: add `features?: { campaignPages; goals; thanksEmail; statements }` to `PublicProPrice`), `apps/web/src/app/dashboard/settings/sections/plan.tsx:471-482` (the same list), `apps/web/src/app/dashboard/help/help-view.tsx` (a "Campaign pages and goals" answer using the board's rules text).
- Create: `tests/e2e/pro-lapse-pages.spec.ts` (lane 7): `after Pro ends the campaign link opens the main page and the banner explains` (set the plan with `sql` through the ops helper that runs `recomputePlan`, never a bare `UPDATE plan`); `goal bar hidden on the main page`; `statements still download`.

- [ ] **Step 1: Failing spec and unit test** (`apps/web/test/pro-features-list.test.mjs`: features absent → today's list exactly).
- [ ] **Step 2: Lane 7 run**, **Step 3: burn in** (`--repeat-each=5 --retries=0`), **Step 4:** `pnpm exec turbo build && pnpm test` (all unit suites) and `pnpm --filter @tipme/web lint`.
- [ ] **Step 5: Commit.** `feat: Pro copy for campaign pages, goals, thank-yous and statements`

---

## Self-review against the board

- **§1 table:** campaign pages (Tasks 3–8); "still you" (Global Constraints, Task 6 leaves the tip area untouched); goals (9–13); "when it's reached" (10–13); receipt thank-yous (14–17); email (15–16); exports (21); monthly statement (19–23).
- **§2 editor:** the Page tab, switch, headline 60, description 200, cover "Same as page", goal fields, thank-you card and signature, Save/Open/Stop, phone folding with Preview and bottom Save (Tasks 7, 12, 17). The copy change (Task 7). Checks before saving (Tasks 3, 4, 9). Free locked preview line (Task 7).
- **§3 campaign page:** same identity and tip area, "See … main page", canonical `/@h` + noindex (Task 6). The email tick box and privacy line (Task 17). Stopped/unknown → main page (Tasks 4, 8).
- **§4 main goal:** placement under the bio (Task 12), percent default, counting rule 11 (Task 10), reached state with black fill, 14 days (Tasks 10, 12), setting form (Task 12), dashboard card and email (Tasks 11, 12).
- **§5 thank-you:** precedence campaign → page → TipMe default (Task 14). The receipt's campaign name and "We've emailed" (Task 17). Email from "‹Name› via TipMe", once, no-reply, never for refunded/failed tips (Tasks 15–16). "got your tip" is #202's.
- **§6 reports:** the Reports tab for Pro and Free (Task 24); statements list with the joined month and "Not ready yet" (Tasks 23–24); range export columns (Task 21); PDF layout, sums, rate note, last 4 digits, no partner name, multi-page with totals on page 1 (Tasks 19, 22); "rows come from the ledger" (Task 20).
- **§7 lapse:** campaign links → main page with results still counting, goals hidden and paused, thank-yous back to Free (email too), statements kept and the lapse month clipped, exports back to CSV, banner (Tasks 26–27).
- **§8 rules:** each one is a Global Constraint or a test. Open questions: all answered by the owner rulings table.
- **Type consistency:** `PublicGoal` (Task 9) is used by Tasks 10–12; `CampaignPageSettings.thanks` (Task 14) by Task 17; `BalanceMovement`/`StatementSummary` (Task 19) by Tasks 20–23; `StatementData` (Task 22) by Task 23; `proSpans`/`wasProAt` (Task 2) by Tasks 10, 19, 23.
