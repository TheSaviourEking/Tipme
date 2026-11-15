# Business Pro and business sign-up: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each PR is built by one builder in its own worktree on its own e2e lane (`.superpowers/program/builder-rules.md`, binding).

**Goal:** a business gets its own plan (Business Free, or Business Pro at ₦7,000 a month, admin-settable) with staff and location limits and the release-1 Pro features; a person can sign up straight into a business with no personal page, run it with up to 3 co-owners, hand it over or remove a co-owner only through a checked procedure, and move between their hats from the account menu. Later phases (F to I) add closing a business, turning off your own page, custom limits for big businesses, and the rest of the proposed Business Pro features.

**Architecture:** Business Pro reuses personal Pro billing end to end. The `pro_*` tables gain a second subject, a business, exactly as `payouts` and `payment_accounts` did in R2-B (`(profile_id IS NULL) <> (business_id IS NULL)`, the `MoneyOwner` type in `packages/database/src/operations/owner.ts`). `businesses.plan` is a cached column derived only from paid periods, like `profiles.plan`; every limit and Pro-feature check reads it. The sign-up work adds an account-only mode to the dashboard shell (a login with businesses but no page) and builds the business path on today's `EmailCodeForm` and `applyForBusiness`. Each phase ships behind its own flag and is its own PR.

**Tech Stack:** Drizzle/Postgres (migrations via drizzle-kit only), NestJS API, BullMQ worker, Next.js 16 App Router, Zod contracts, `node --test` integration tests against `dist`, Playwright e2e. No new dependency of its own: statements reuse the worker's `pdfkit` 0.20.2 renderer with its embedded Noto Sans subset (Manrope has no ₦) and the hand-written xlsx writer from the Pro features plan (`docs/pro-features-plan` branch, `docs/superpowers/plans/2026-11-14-pro-campaign-pages-goals-thankyous-statements.md`, Tasks 21 and 22).

**Spec:** two approved boards plus the owner's decisions of 14 Nov 2026 (binding; the boards' bracketed defaults are approved):

- `BusinessPro.dc.html` (scratchpad `canvas-bizpro/project/`): plans, the Plan section, limit moments, lapse, admin Prices, analytics, the monthly statement.
- `BusinessSignup.dc.html` (scratchpad `canvas-bizflow/project/`): the sign-up fork, the four business steps, the waiting and verified screens, the account-only dashboard, the switcher, Owners, the handover approval, edge cases.
- Owner decisions, 14 Nov 2026 (copied into "Global Constraints" below). Nothing here is legal advice or regulatory approval (`docs/00-DECISIONS.md`).

## Global Constraints

- Prices: personal Pro stays ₦5,000 (`pro_prices`, plan `personal`). **Business Pro is ₦7,000 a month** (700000 kobo), plan `business`, set by staff exactly like personal Pro: serious action, a second person approves (a lone admin acts alone with an alert, as `pro_price.change` does today), history kept, a new price applies at the next renewal, a shown price is honoured (`expectedAmountMinor`; a mismatch is `PRO_PRICE_CHANGED`).
- Limits: **Business Free 3 staff, 1 location. Business Pro 25 staff, 25 locations.** Above 25 staff: "Talk to us" (no self-serve). Owners never count toward the staff limit. A business already above a limit keeps everything and can't add more. A limit never removes or blocks anyone already there, and never stops a tip.
- Fees: each staff member's tip fee stays their own plan rate (Free 7%, Pro 5%). Business Pro does **not** give the owner personal Pro.
- Staff amounts (owner, 14 Nov 2026): **owners do not see each staff member's naira from the business.** Per-staff amounts (analytics, statements, exports, payroll) sit behind `BUSINESS_STAFF_AMOUNTS`, which **stays off**; built only if there's a need, and then only for staff who opted in (`share_amounts`). Business and location totals follow ruling R7.
- Paying: from the business balance, or by card or bank transfer, reusing personal Pro billing (`apps/api/src/pro`, `packages/database/src/operations/pro-*.ts`, the `pro_*` tables).
- Partner facts: the partner's own subscriptions bill USD cards only, so **every renewal is scheduled by TipMe** (saved naira card or balance collection), exactly like personal Pro. **Never name the payment partner** in any user-facing copy, email or statement: "our payment partner". Never call the partner's API from automated tests (pretend provider, recorded fixtures).
- Release 1 Business Pro features: business analytics (all locations, any range), monthly statements across all staff (PDF + CSV/Excel), branded business page, managers who run their own location fully, premium location QR designs, **3 business name changes a year**, an **accountant's email** that receives statement links.
- Sign-up: the fork reads **"Get tipped" / "For businesses"**, on the home page and on the sign-up card, as the board shows. The business path makes the login and the application with **no personal page**; the owner may turn one on later. A business-only login lands on the business dashboard, never `/sign-up`. **Co-owners up to 3.** A handover needs the new owner's confirmation **and** TipMe staff approval, never one admin alone. **The last owner can't leave.** An account-menu switcher. Staff still join by invitation with their own page. Existing businesses don't change.
- Removing a co-owner is **never instant** (owner, 14 Nov 2026: "it shouldn't be easy to take over a business"): the procedure in Task E4. While a removal or handover is pending: no handover, no payout-destination change, and the person asked to leave can't remove the requester; withdrawals carry on. The **founding owner** (whose application TipMe verified) is removed only with TipMe approval. Every step is audited and emailed to all owners. Until Phase E ships, the interim safety PR `fix/owner-removal-lock` blocks owner-removes-owner in today's code; Phase E replaces that block when `BUSINESS_OWNERS_ENABLED` is on.
- Not decided, do not build: business release 2's open questions in PR #193 (auto-recording final refunds; the processing fee in the returned fee). Nothing in this plan touches reversal code or `tip.reverse`.
- Flags, all off by default, each on top of `BUSINESS_ENABLED`: `BUSINESS_PRO_ENABLED` (Phases A to C), `BUSINESS_SIGNUP_ENABLED` (Phase D), `BUSINESS_OWNERS_ENABLED` (Phase E). Off means today's behaviour exactly: no limits, no plan, no new routes (404 like an unknown path, as `BusinessEnabledGuard` does).
- Migrations: **the next free number is 0097 or later**: 0093 to 0096 are taken by open PRs #196, #197 and #193. Generate with `pnpm --filter @tipme/database exec drizzle-kit generate` (custom SQL: `--custom --name <name>`), never hand-number or rename. If another migration lands on `dev` first, rebase, delete your generated files and regenerate.
- Copy: pronouns "they"; calm limit copy (a fact, then the way forward, "Not now"); no red, no countdowns, no pop-ups; no private data in email subjects or preheaders; UI follows `docs/design/DESIGN-CONSTITUTION.md`.
- Money: integer kobo (`bigint`) end to end; ledger postings balanced and idempotent by operation key; nothing shown as paid until the server confirms it.
- Never edit `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`.

## Review Focus

1. **Two owners (or an owner and an accept) adding the 4th staff member at the same moment.** Expect exactly one to win and the other to get `BUSINESS_STAFF_LIMIT`. Pinned by `limits hold under two invitations at once` in Task A4 (business row `FOR UPDATE` before counting).
2. **A business whose Pro month ends (grace over) while it is above the Free limits.** Expect every staff member and location to keep working and taking tips, inviting and adding refused, and a staff member who leaves freeing a seat only once below the limit. Pinned by `a lapsed business keeps 24 staff and can't add a 25th or a 4th` in Task A4.
3. **A business-only login opening a page-only address** (`/dashboard/tips`, `/dashboard/qr`, a bookmarked `/dashboard`). Expect the business dashboard, never `/sign-up`, never a redirect loop. Pinned by `a business-only login opening /dashboard/tips lands on its business` in Task D4.
4. **Per-person naira from the business.** Expect no staff member's amount shown or derivable by subtraction in analytics, statements or exports while `BUSINESS_STAFF_AMOUNTS` is off (always, in this plan). Pinned by `a staff member's amount can't be worked out from the total` in Task C1 and `statement rows carry tips, never naira, with the flag off` in Task C3.
5. **The price changing between the Plan screen loading and "Pay ₦7,000".** Expect `PRO_PRICE_CHANGED` and the new price shown, nothing charged. Pinned by `a stale Business Pro price is refused` in Task B1.

---

## What the code does today (origin/dev `0a490475`, migrations to `0092`)

- **Businesses** (`packages/database/src/schema.ts:2294`): `businesses` (status `pending|verified|suspended`, `contact_*`, `created_by`, logo), `business_locations` (`closed_at`), `business_managers` (role `owner|location_manager`, `removed_at`; open-row unique index), `business_members` (one page at one location, `left_at`), `business_invitations` (`kind staff|manager`, `manager_role owner|location_manager`, 7 days, `INVITATION_DAYS` in `packages/domain/src/business.ts:8`). **No plan, no limits.**
- **Co-owners already half-exist:** an owner may invite another owner (`invitationRequestSchema`, `packages/contracts/src/business.ts:183-207`, `inviteToBusiness` in `operations/business-invitations.ts:69`); `removeManager` refuses the last owner `BUSINESS_LAST_OWNER` (`operations/business-manage.ts:321`); `endBusinessRolesForDeletion` refuses deleting the last owner of a verified business (`operations/business-members.ts:260`). Accepting any invitation goes through `/dashboard/work#join=`, which today needs a page to reach. There is no owner cap, no handover, no Owners section, no "close business".
- **Apply:** `applyForBusiness` (`operations/business-manage.ts:36`) needs `users.email_verified_at`; makes the business, first location, owner row and a `business_waiting` issue. Web: `apps/web/src/app/dashboard/business/apply/apply-form.tsx` reads `useRecipient().profile` for the contact name and email. Verification: serious action `business.verify` (`operations/serious-actions-registered.ts:600`).
- **Insights:** `locationInsights` (`operations/business-insights.ts:147`) is one location, one ISO week, **counts only** (`Shown`, `MIN_GROUP = 3`, `withheldCounts`), naira per person only for members with `share_amounts`.
- **Business money (R2-B, on dev):** `businessBalanceIn` (`operations/balance.ts:70`) from `business_payable`; the business has its own connected account (`payment_accounts.business_id`); withdrawals through `requestBusinessWithdrawal` (`operations/payouts.ts:1570`). The balance is only filled by shares (`BUSINESS_SHARES_ENABLED`).
- **Personal Pro:** `pro_prices` (`schema.ts:2971`, append-only, `currentProPrice`/`setProPrice` in `operations/pro-price.ts`, serious action `pro_price.change`), `pro_periods` (`:3011`, keyed by `profile_id`; 3 days' grace; `startPaidPeriod`, `recomputePlan`, `expireDuePeriods`, `sendProReminders` in `operations/pro-periods.ts`), `pro_purchases` (`:3058`; `requestProPurchase`, `buyProByCheckout`, `confirmProCheckout`, `reconcileProPurchases` in `operations/pro-purchases.ts`), balance payment `buyProFromBalance` (`operations/pro-balance.ts:278`, partner `destination: self` transfer, posting `buildProBalancePosting` in `packages/domain/src/ledger.ts:274`), `pro_auto_renew` (`:3286`, PK `profile_id`, saved card only), refunds `pro_refunds`. API `apps/api/src/pro/pro.controller.ts` (`/v1/me/pro`); flags `PRO_BILLING_ENABLED`, `PRO_PAY_FROM_BALANCE`, `PRO_AUTO_RENEW`, `PRO_REFUNDS` (`apps/api/src/config.ts:142-163`). Worker `apps/worker/src/handlers/pro.ts`. Web `apps/web/src/app/dashboard/settings/sections/plan.tsx`, `apps/web/src/lib/pro-buy.ts`, ops `apps/web/src/app/ops/pro-price/page.tsx`. Mail `packages/mail/src/templates/types/pro-notices.ts`.
- **Sign-up:** `apps/web/src/app/sign-up/sign-up-flow.tsx` (three steps: Your email, The code, Your handle); `EmailCodeForm` returns `SignInVerified { userId, isNew, hasProfile }` (`packages/contracts/src/auth.ts:32`); `sign-in-view.tsx:17` sends anyone without a page (and not going to `/ops`) to `/sign-up`.
- **Dashboard shell** (`apps/web/src/app/dashboard/dashboard-shell.tsx:105-115`): reads `/v1/me/profile`; **a 404 replaces the route with `/sign-up`**; children render only inside `RecipientContext` once a profile has loaded. Business and Work links come from `GET /v1/me/business-roles` (`operations/business-roles.ts`).
- **Web flag reads:** `/health/release` carries `business` (`apps/web/src/lib/business/available.ts`).
- **Serious actions:** `SeriousActionDefinition` (`operations/serious-actions.ts:116`); with no qualified second person, someone holding the permission **acts alone** (`:518-523`). There is no "never alone" option yet.
- **Issue kinds** have a database check generated from `ISSUE_KINDS` (`schema.ts:1920`, `packages/contracts/src/ops.ts:249`): a new kind needs a migration.

## Rulings on spec gaps (the builder follows these; each is listed again in the PR body)

| #   | Gap                                                                                                    | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The Pro board says "[100] staff" in places; the owner set 25.                                          | **25 staff, 25 locations** everywhere; every "100" in board copy becomes 25, and the staff line adds "Above that, talk to us".                                                                                                                                                                                                                                                                                                                                                                                                    |
| R2  | "Talk to us" has no mechanism behind it.                                                               | Release 1: the link opens Get help with topic `business` prefilled "Business Pro: more than 25 staff". Phase H makes it real: staff set custom limits in ops (Tasks H1, H2).                                                                                                                                                                                                                                                                                                                                                      |
| R3  | The sign-up board says a business "has exactly one owner"; the code already allows owner invitations.  | Build on the code: add the **cap of 3** (open owners + open owner invitations), the Owners section, owner-change emails, and handover.                                                                                                                                                                                                                                                                                                                                                                                            |
| R4  | Who counts as staff.                                                                                   | Distinct people (profiles) with an open membership at any open or closed location of the business, **excluding anyone who is an open owner** of it. Inviting counts open staff invitations too; accepting re-checks members only. Location managers who aren't members don't count.                                                                                                                                                                                                                                               |
| R5  | Name changes vs "a verified name is one TipMe checked" (coordinator ruling, `business-manage.ts:139`). | Business Pro owners may ask; the new **display name** shows only after one TipMe staff member approves it (issue kind `business_rename`); the slug never changes, so every printed code and link keeps working. **3 approved changes per rolling 365 days**; a declined ask doesn't count.                                                                                                                                                                                                                                        |
| R6  | Who the accountant is.                                                                                 | **One** accountant email per business, owner-set, Business Pro only. Statement emails carry a link to `/statements`, which needs sign-in with that email (a login with no page, as Phase D allows). They see that business's statements only, never the dashboard. Removing the email ends access at once.                                                                                                                                                                                                                        |
| R7  | Staff amounts vs the board's naira per staff.                                                          | **Owner, 14 Nov 2026: owners do not see each staff member's naira from the business.** The staff opt-in (`share_amounts`) stays. Per-staff naira is built dark behind `BUSINESS_STAFF_AMOUNTS` (stays off; later, only if there's a need, and then only for opted-in staff). Business and location naira totals show only when the staff in that scope who don't share amounts are **none or at least 3** (with the flag off, that is every tipped staff member). Today's "This week" opt-in display is not touched by this plan. |
| R8  | What lapse pauses vs "every past statement ... kept, and back the moment you renew".                   | Paused on lapse: analytics, new monthly statements, CSV/Excel exports, branded extras, premium QR on screen, name changes, accountant emails. **Past statement PDFs stay downloadable** (they are financial records). "This week" stays. Data is kept.                                                                                                                                                                                                                                                                            |
| R9  | Paying from the business balance.                                                                      | Offered only when `PRO_PAY_FROM_BALANCE` and `BUSINESS_SHARES_ENABLED` are both on (the balance is filled only by shares). Otherwise card or bank transfer only.                                                                                                                                                                                                                                                                                                                                                                  |
| R10 | Auto-renew "from the business balance". Personal Pro auto-renews by saved card only.                   | New: a TipMe-scheduled balance collection one day before the month ends, idempotent per period, under `PRO_PAY_FROM_BALANCE`; saved-card renewals under `PRO_AUTO_RENEW`, as personal.                                                                                                                                                                                                                                                                                                                                            |
| R11 | Buying Pro for a pending or suspended business.                                                        | Refused `BUSINESS_NOT_VERIFIED`: a business's codes aren't live before verification.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R12 | Home and sign-up wording.                                                                              | **Owner, 14 Nov 2026:** the fork reads "Get tipped" / "For businesses". "Get tipped" replaces "Claim your username" on the home page and on the sign-up card, as the board draws; "For businesses" sits in the header and under the claim field.                                                                                                                                                                                                                                                                                  |
| R13 | A business-only owner's name (no page).                                                                | New `business_managers.shown_name` (1 to 60 chars), set from the sign-up contact name or asked when a person with no page accepts an owner invitation. Owners list: page name, else `shown_name`.                                                                                                                                                                                                                                                                                                                                 |
| R14 | Removing a co-owner.                                                                                   | **Owner, 14 Nov 2026: never instant.** The seven-step procedure in Task E4 replaces today's `removeManager` rule for owners (location managers are unchanged). The board's "last other owner" line is not used.                                                                                                                                                                                                                                                                                                                   |
| R15 | "Close the business" is offered but doesn't exist.                                                     | Phase F builds it (all owners agree or TipMe approves; balance withdrawn first; codes stop; history kept). Until F ships, the last-owner copy offers "Hand over ownership", "Add a co-owner", and "Ask TipMe to close it" (Get help).                                                                                                                                                                                                                                                                                             |
| R16 | "While you wait ... more locations" on Business Free (1 location).                                     | The waiting card says "You can add your logo and invite staff now." on Free.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R17 | Logo at step 3 before the business exists.                                                             | The file is held in the page and uploaded with `PUT /v1/me/businesses/:id/logo` right after the application succeeds; a failed upload leaves the business made and the waiting screen offers "Add your logo".                                                                                                                                                                                                                                                                                                                     |
| R18 | "Not now" for the page card (90 days), the last hat used.                                              | Per-device conveniences in `localStorage` (try/catch), never server state.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R19 | The celebration "once".                                                                                | Per owner, server-marked: `business_managers.verified_seen_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R20 | Turning off your own page while owning a business (board section 8).                                   | Phase G (Tasks G1, G2): the handle is held for that login for 12 months, as the board says.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R21 | Board admin "₦500 steps".                                                                              | The stepper moves in ₦500; the server accepts any whole naira in ₦100 to ₦1,000,000 (`isAllowedProPrice`), as for personal Pro.                                                                                                                                                                                                                                                                                                                                                                                                   |
| R22 | Refunding a card-paid Business Pro month.                                                              | Reuses `pro.refund`; its subjects become the business's open owners.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R23 | Staff grants of Business Pro (personal Pro has `staffPro`).                                            | Phase I, Task I9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Later work:** per-staff naira for owners (`BUSINESS_STAFF_AMOUNTS`, only if there's a need). Everything else the boards propose is now planned in Phases F to I.

---

## Phases, PRs and parallelism

| Phase                              | PR (branch)                    | Flag                      | Tasks      | Depends on                              | E2E lane            |
| ---------------------------------- | ------------------------------ | ------------------------- | ---------- | --------------------------------------- | ------------------- |
| A. Plans, prices, limits           | `feat/business-pro-a`          | `BUSINESS_PRO_ENABLED`    | A1 to A5   | dev                                     | 3                   |
| B. Buying and keeping Business Pro | `feat/business-pro-b`          | `BUSINESS_PRO_ENABLED`    | B1 to B5   | A merged                                | 3                   |
| C1. Analytics                      | `feat/business-pro-analytics`  | `BUSINESS_PRO_ENABLED`    | C1, C2     | A merged                                | 5                   |
| C2. Statements and accountant      | `feat/business-pro-statements` | `BUSINESS_PRO_ENABLED`    | C3, C4, C5 | A merged; C5's sign-in needs D1         | 6                   |
| C3. Branded page                   | `feat/business-pro-brand`      | `BUSINESS_PRO_ENABLED`    | C6, C7     | A merged                                | 7                   |
| C4. Premium QR                     | `feat/business-pro-qr`         | `BUSINESS_PRO_ENABLED`    | C8         | A merged                                | 8                   |
| C5. Name changes                   | `feat/business-pro-names`      | `BUSINESS_PRO_ENABLED`    | C9         | A merged                                | 8 (after C4)        |
| D. Business sign-up                | `feat/business-signup`         | `BUSINESS_SIGNUP_ENABLED` | D1 to D6   | dev                                     | 4                   |
| E. Owners, removal and handover    | `feat/business-owners`         | `BUSINESS_OWNERS_ENABLED` | E1 to E5   | D1 merged                               | 5 (after C1)        |
| F. Closing a business              | `feat/business-close`          | `BUSINESS_CLOSE_ENABLED`  | F1 to F3   | E merged                                | 6                   |
| G. Turning off your own page       | `feat/page-turn-off`           | `PAGE_TURN_OFF_ENABLED`   | G1, G2     | D merged                                | 7                   |
| H. Custom limits                   | `feat/business-custom-limits`  | `BUSINESS_CUSTOM_LIMITS`  | H1, H2     | A merged (E3's `neverAlone` not needed) | 8                   |
| I. The rest of Business Pro        | one PR per task (see Phase I)  | one flag per task         | I1 to I9   | per task, see Phase I                   | 3 to 8, see Phase I |

**Runs in parallel:**

- Wave 1: **Phase A and Phase D** (no shared files except `schema.ts` and `config.ts`; whoever merges second regenerates their migration). Inside A: A1 and A2 in parallel, then A3 and A4 in parallel, then A5. Inside D: D1 first, then D2 and D3 in parallel, then D4, then D5 and D6 in parallel.
- Wave 2 (after A merges): **B, C1, C2, C3, C4** in parallel; **E** once D1 is on dev. Inside B: B1 and B4 in parallel, then B2 and B3 in parallel, then B5.
- Wave 3: **C5** (shares `business-manage.ts` and lane 8 with C4); **H** and **I3, I7, I9** once A and B are on dev (lanes 3, 4, 8).
- Wave 4 (after E merges): **F**; (after D merges) **G**; (after C merges) **I1, I2, I6**; (after the Pro features plan's Phases B and C are on dev) **I4, I5**; (after personal early access lands) **I8**. Lanes in Phase I's table; never two running PRs on one lane.
- **Dependency on the Pro features plan** (`docs/pro-features-plan`, not duplicated here): C3/C4 statements use its Tasks 21 (xlsx writer) and 22 (worker pdfkit renderer, Noto Sans subset); I4 business thank-you uses its Phase C (Tasks 14 to 17); I5 team tip goals uses its Phase B (Tasks 9 to 12). If a business PR is ready first, it waits for those tasks rather than adding a second renderer, writer or goals model.
- Never in parallel: two PRs adding migrations at the same moment without the rebase-and-regenerate step; two PRs editing `BUSINESS_SECTIONS` without rebasing (`apps/web/src/app/dashboard/business/sections.ts`, one line each).

**E2E rules for every PR** (`builder-rules.md`): only your lane (3 to 8, **never 9**); `rm -rf apps/web/.next && TURBO_FORCE=true node scripts/build-e2e.mjs`, `node scripts/prepare-e2e-database.mjs`, then `pnpm exec playwright test <your files> --workers=2`. Burn-in safety: every test makes its own business with a `randomUUID()` slug suffix and its own people; **no assertion assumes fresh data** (never a global count, never "the only business", never a hard-coded ₦7,000 except where the test set that price itself and restores it); find text inside a region or role; wait for end states; route `/v1/me/events` to 204 when routing `/v1/me/**`. **Clean up staff:** each test that adds members ends them in `afterEach` (`sql\`UPDATE business_members SET left_at = now(), left_by = 'manager' WHERE location_id = …\``) and closes its extra locations, so a rerun on the same lane never inherits a business at its limit. Tests that change a price restore it in `afterEach` through the same serious action.

**Every PR ends with** (one step in its last task): `pnpm exec turbo build`, `pnpm lint`, `pnpm typecheck`, its integration files with a private template (`tipme_it_<name>`), its e2e files on its lane, then `pnpm api:openapi && pnpm api:openapi --check` and `pnpm docs:generate && pnpm docs:generate --check` (regenerated once, never hand-merged), then push with `caffeinate -i git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/TheSaviourEking/Tipme.git HEAD:<branch>` (never `--no-verify`) and a PR into `dev` with red→green evidence.

---

## Phase A: business plans, prices and limits (`BUSINESS_PRO_ENABLED`)

### Task A1: Schema for Business Pro

**Files:**

- Modify: `packages/database/src/schema.ts` (`businesses` :2294, `proPrices` :2971, `proPeriods` :3011, `proPurchases` :3058; new `businessProAutoRenew` after `proAutoRenew` :3286)
- Create: `packages/database/drizzle/00NN_business_pro.sql` (generated), `packages/database/drizzle/00NN_business_pro_price_seed.sql` (generated `--custom`), NN ≥ 97
- Test: `packages/database/test/integration/business-pro-schema.test.mjs`

**Interfaces:**

- Produces: columns `businesses.plan` (`'free'|'pro'`, default `'free'`), `businesses.pro_lapsed_at`; `pro_prices.plan` (`'personal'|'business'`, default `'personal'`); `pro_periods.business_id`, `pro_purchases.business_id`, `pro_purchases.bought_by`; table `business_pro_auto_renew`; exported `BUSINESS_PLANS = ['free','pro'] as const`, `PRO_PRICE_PLANS = ['personal','business'] as const`.

- [ ] **Step 1: Write the failing schema tests**

```js
test('pro_periods take exactly one of a page or a business', async () => {
  await assert.rejects(
    insertPeriod({ profileId: null, businessId: null }),
    /pro_periods_owner/,
  );
  await assert.rejects(
    insertPeriod({ profileId: page.id, businessId: biz.id }),
    /pro_periods_owner/,
  );
  await insertPeriod({ profileId: null, businessId: biz.id }); // ok
});
test('a business has at most one queued month and one open purchase', async () => {
  await insertPeriod({ businessId: biz.id, status: 'SCHEDULED' });
  await assert.rejects(
    insertPeriod({ businessId: biz.id, status: 'SCHEDULED', startsAt: later }),
    /pro_periods_business_one_scheduled/,
  );
  await insertPurchase({ businessId: biz.id, status: 'PENDING' });
  await assert.rejects(
    insertPurchase({ businessId: biz.id, status: 'UNKNOWN' }),
    /pro_purchases_business_one_open/,
  );
});
test('a business purchase names the owner who paid', async () => {
  await assert.rejects(
    insertPurchase({ businessId: biz.id, boughtBy: null }),
    /pro_purchases_bought_by/,
  );
});
test('the seed sets Business Pro at 700000 kobo and leaves the personal price alone', async () => {
  const business = await currentPrice('business');
  assert.equal(business.amount_minor, '700000');
  assert.match(business.reason, /owner’s decision, 14 Nov 2026/);
  assert.notEqual((await currentPrice('personal')).id, business.id);
});
test('every business starts on free', async () => {
  assert.equal((await readBusiness(biz.id)).plan, 'free');
  await assert.rejects(setPlan(biz.id, 'gold'), /businesses_plan/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test packages/database/test/integration/business-pro-schema.test.mjs`
Expected: FAIL (`column "business_id" of relation "pro_periods" does not exist`)

- [ ] **Step 3: Change `schema.ts`**

- `pro_prices`: `plan text NOT NULL DEFAULT 'personal'`, check `pro_prices_plan` (`plan IN ('personal','business')`), index `pro_prices_plan_effective_from (plan, effective_from)`.
- `pro_periods`: `profile_id` nullable; `business_id uuid REFERENCES businesses`; check `pro_periods_owner` `(profile_id IS NULL) <> (business_id IS NULL)`; unique `pro_periods_business_start (business_id, starts_at)`; partial unique `pro_periods_business_one_scheduled (business_id) WHERE status = 'SCHEDULED'`.
- `pro_purchases`: `profile_id` nullable; `business_id`; `bought_by uuid REFERENCES users`; checks `pro_purchases_owner` (XOR as above) and `pro_purchases_bought_by` `(business_id IS NULL) = (bought_by IS NULL)`; unique `pro_purchases_business_idempotency (business_id, idempotency_key)`; partial unique `pro_purchases_business_one_open (business_id) WHERE status IN ('PENDING','COLLECTING','UNKNOWN')`.
- `business_pro_auto_renew`: `business_id` PK → businesses; `source text NOT NULL` check `IN ('balance','saved_card')`; `enabled boolean NOT NULL`; `provider`, `customer_reference`, `payment_method_reference` (text, null); `failed_period_id uuid`; `set_by uuid NOT NULL → users`; `updated_at`.
- `businesses`: `plan text NOT NULL DEFAULT 'free'` check `businesses_plan`; `pro_lapsed_at timestamptz` (set when Pro ends, cleared when it starts; drives the lapse banner).

- [ ] **Step 4: Generate both migrations**

Run: `pnpm --filter @tipme/database exec drizzle-kit generate --name business_pro` then `pnpm --filter @tipme/database exec drizzle-kit generate --custom --name business_pro_price_seed` and write the seed:

```sql
INSERT INTO pro_prices (id, amount_minor, currency, effective_from, plan, reason, created_at)
VALUES (gen_random_uuid(), 700000, 'NGN', now(), 'business', 'Launch price (owner’s decision, 14 Nov 2026)', now());
```

Expected: two new files numbered 0097 or later; `git diff --stat packages/database/drizzle/meta` shows only the journal and the new snapshots.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @tipme/database build && node --test packages/database/test/integration/business-pro-schema.test.mjs packages/database/test/integration/pro-periods.test.mjs packages/database/test/integration/pro-checkout.test.mjs`
Expected: PASS (the personal Pro suites unchanged)

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/schema.ts packages/database/drizzle packages/database/test/integration/business-pro-schema.test.mjs
git commit -m "feat(database): Business Pro columns on the pro tables and a ₦7,000 business price"
```

### Task A2: Domain rules: limits and the business balance posting (parallel with A1)

**Files:**

- Create: `packages/domain/src/business-plan.ts`; export from `packages/domain/src/index.ts`
- Modify: `packages/domain/src/ledger.ts` (after `buildProBalancePosting` :274)
- Test: `packages/domain/test/business-plan.test.mjs`, `packages/domain/test/ledger.test.mjs`

**Interfaces:**

- Produces:
  - `type BusinessPlan = 'free' | 'pro'`
  - `BUSINESS_LIMITS: { free: { staff: 3; locations: 1 }; pro: { staff: 25; locations: 25 } }`
  - `businessLimits(plan: BusinessPlan): { staff: number; locations: number }`
  - `BUSINESS_OWNER_LIMIT = 3`, `BUSINESS_NAME_CHANGES_PER_YEAR = 3`, `BUSINESS_PRO_REMINDER_DAYS = 7`
  - `buildBusinessProBalancePosting(input: { amountMinor: bigint; businessId: string }): LedgerLine[]`

- [ ] **Step 1: Write the failing tests**

```js
test('business limits', () => {
  assert.deepEqual(businessLimits('free'), { staff: 3, locations: 1 });
  assert.deepEqual(businessLimits('pro'), { staff: 25, locations: 25 });
});
test('a Business Pro balance payment takes the business payable', () => {
  const lines = buildBusinessProBalancePosting({
    amountMinor: 700000n,
    businessId: 'b1',
  });
  assert.deepEqual(lines, [
    {
      account: 'business_payable',
      side: 'debit',
      amountMinor: 700000n,
      businessId: 'b1',
    },
    { account: 'subscription_revenue', side: 'credit', amountMinor: 700000n },
    { account: 'platform_clearing', side: 'debit', amountMinor: 700000n },
    { account: 'provider_clearing', side: 'credit', amountMinor: 700000n },
  ]);
  assert.ok(isBalanced(lines));
  assert.throws(
    () => buildBusinessProBalancePosting({ amountMinor: 0n, businessId: 'b1' }),
    RangeError,
  );
});
```

- [ ] **Step 2: Run to fail**

Run: `pnpm --filter @tipme/domain build && node --test packages/domain/test/business-plan.test.mjs`
Expected: FAIL (`businessLimits is not a function`)

- [ ] **Step 3: Implement** in the files above; the posting mirrors `buildProBalancePosting` with `line('business_payable', 'debit', amountMinor, undefined, businessId)` (the R2-B withdrawal's form, `ledger.ts:207`). Comment it as needing finance sign-off, like its sibling.

- [ ] **Step 4: Run to pass**

Run: `pnpm --filter @tipme/domain build && node --test packages/domain/test/business-plan.test.mjs packages/domain/test/ledger.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** `feat(domain): business plan limits and the Business Pro balance posting`

### Task A3: Business periods, plan and prices in the database layer

**Files:**

- Modify: `packages/database/src/operations/pro-price.ts`, `pro-periods.ts`, `pro-purchases.ts` (`requestProPurchase` :164, `confirmProCheckout` :560, `reconcileProPurchases` :746, `myProState` :913), `pro-refunds.ts` (`proRefundFacts` :68), `packages/database/src/index.ts`
- Create: `packages/database/src/operations/business-pro.ts`
- Test: `packages/database/test/integration/business-pro-periods.test.mjs`, `tests/integration/pro-price.test.mjs` (extend)

**Interfaces:**

- Consumes: A1 columns, A2 `BusinessPlan`, `MoneyOwner`/`ownerColumns`/`ownerOf` (`operations/owner.ts`).
- Produces:
  - `currentProPrice(db, now?: Date, plan: 'personal' | 'business' = 'personal'): Promise<ProPriceRow | null>`; `proPriceHistory(db, limit?, plan?)`; `setProPrice(tx, input & { plan?: 'personal' | 'business' })` (audit action `pro.price_changed` for personal, `business_pro.price_changed` for business); `waitingProPriceRequest(db, action: 'pro_price.change' | 'business_pro_price.change' = 'pro_price.change')`. `ProPriceRow` gains `plan`.
  - `requestProPurchase(db, input)` where `input.profileId` becomes `input.subject: MoneyOwner` plus `boughtBy?: string` (required for a business). Internal callers (`buyProByCheckout`, `buyProFromBalance`, `renewProAutomatically`) pass `{ profileId }`. A business subject locks the business row, refuses `BUSINESS_NOT_VERIFIED` unless `status = 'verified'`, and prices from plan `business`.
  - `startBusinessPaidPeriod(tx, input: { businessId; purchaseId; paidBy: ProPaidBy; amountMinor: bigint; currency: 'NGN'; now: Date }): Promise<{ periodId; startsAt; endsAt; status: 'ACTIVE' | 'SCHEDULED'; planChanged: boolean; slug: string }>` sharing one internal `startPeriodFor(tx, subject, …)` with `startPaidPeriod`.
  - `recomputeBusinessPlan(tx, businessId, now): Promise<{ plan: BusinessPlan; changed: boolean; slug: string }>`: locks the business row; `pro` while a paid business period covers now (grace included); sets `pro_lapsed_at = now` on pro→free and null on free→pro.
  - `expireDuePeriods` also sweeps business periods (one business per transaction, under its lock) and returns `businessChanges: { businessId: string; slug: string; plan: BusinessPlan }[]` beside today's page changes.
  - `businessProState(db, businessId, now?): Promise<{ plan: BusinessPlan; current: PeriodView | null; next: PeriodView | null; openPurchase: ProPurchaseView | null; price: ProPriceRow | null; lapsedAt: Date | null }>` in `business-pro.ts`.
  - `confirmProCheckout` / `reconcileProPurchases`: a purchase row with `business_id` starts a business period (`startBusinessPaidPeriod`) and a `business_pro_receipt` mail to `bought_by` (type from Task B4; until B4 lands, gate the mail behind the type's presence in the same PR order: B4 merges with B1).
  - `proRefundFacts`: subjects for a business purchase are its open owners.

- [ ] **Step 1: Write the failing tests**

```js
test('a paid business month makes the business pro, and grace keeps it', async () => {
  await startBusinessPaidPeriod(tx, {
    businessId: biz.id,
    purchaseId: p1,
    paidBy: 'card',
    amountMinor: 700000n,
    currency: 'NGN',
    now: t0,
  });
  assert.equal((await readBusiness(biz.id)).plan, 'pro');
  await expireDuePeriods(db, { now: addDays(endsAt, 1) }); // in grace
  assert.equal((await readBusiness(biz.id)).plan, 'pro');
});
test('after grace the business is free and remembers when Pro ended', async () => {
  const result = await expireDuePeriods(db, { now: addDays(endsAt, 4) });
  assert.deepEqual(result.businessChanges, [
    { businessId: biz.id, slug: biz.slug, plan: 'free' },
  ]);
  assert.ok((await readBusiness(biz.id)).pro_lapsed_at);
});
test('the same purchase starts one business month once', async () => {
  const a = await startBusinessPaidPeriod(tx, input);
  const b = await startBusinessPaidPeriod(tx, input);
  assert.equal(a.periodId, b.periodId);
});
test('a business month never makes its owner personal Pro', async () => {
  await startBusinessPaidPeriod(tx, input);
  assert.equal((await readProfile(ownerPage.id)).plan, 'free');
});
test('a pending business cannot open a purchase', async () => {
  await assert.rejects(
    requestProPurchase(db, {
      subject: { businessId: pending.id },
      boughtBy: owner.id,
      method: 'card',
      expectedAmountMinor: 700000n,
      idempotencyKey: key(),
      now,
    }),
    { code: 'BUSINESS_NOT_VERIFIED' },
  );
});
test('business and personal prices move separately', async () => {
  await setProPrice(tx, {
    amountMinor: 750000n,
    plan: 'business',
    staffUserId,
    approvedBy,
    reason: REASON,
    now,
  });
  assert.equal(
    (await currentProPrice(db, now, 'business')).amountMinor,
    750000n,
  );
  assert.equal((await currentProPrice(db, now)).amountMinor, personalBefore);
});
```

- [ ] **Step 2: Run to fail**

Run: `pnpm --filter @tipme/database build && node --test packages/database/test/integration/business-pro-periods.test.mjs`
Expected: FAIL (`startBusinessPaidPeriod is not a function`)

- [ ] **Step 3: Implement** the interfaces above. Keep every existing export's behaviour for pages; the profile lock and the business lock are never held together in one transaction.

- [ ] **Step 4: Run to pass, personal Pro suites included**

Run: `pnpm --filter @tipme/database build && node --test packages/database/test/integration/business-pro-periods.test.mjs packages/database/test/integration/pro-periods.test.mjs packages/database/test/integration/pro-checkout.test.mjs packages/database/test/integration/pro-balance.test.mjs packages/database/test/integration/pro-auto-renew.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** `feat(database): business Pro months, plan and price, reusing personal Pro billing`

### Task A4: Limits enforced on staff and locations (parallel with A3)

**Files:**

- Create: `packages/database/src/operations/business-limits.ts`
- Modify: `operations/business-invitations.ts` (`inviteToBusiness` :69, `acceptBusinessInvitation` :463), `operations/business-manage.ts` (`addLocation` :157, `readDetail`), `packages/contracts/src/business.ts` (`BusinessDetail` :403), `apps/api/src/config.ts` (flag), `apps/api/src/business/business-members.controller.ts`, `business-manage.controller.ts`, `work.controller.ts`, `apps/api/src/http/api-exception.filter.ts`, `apps/api/src/health/*` (`businessPro` in `/health/release`)
- Test: `packages/database/test/integration/business-limits.test.mjs`, `tests/integration/business-limits-api.test.mjs`

**Interfaces:**

- Consumes: A1 `businesses.plan`, A2 `businessLimits`.
- Produces:
  - `businessUsage(db: Database | Tx, businessId: string): Promise<BusinessUsage>`
  - `assertCanAddStaff(tx: Tx, businessId: string, opts: { countInvitations: boolean }): Promise<void>` → `BUSINESS_STAFF_LIMIT`
  - `assertCanAddLocation(tx: Tx, businessId: string): Promise<void>` → `BUSINESS_LOCATION_LIMIT`
  - Contract `BusinessUsage { plan: 'free' | 'pro'; staff: { used: number; limit: number }; locations: { used: number; limit: number } }`; `BusinessDetail` gains optional `plan?: 'free' | 'pro'`, `usage?: BusinessUsage`, `proLapsedAt?: string` (present only with the flag on).
  - `inviteToBusiness(…, now, opts?: { enforceLimits?: boolean })`, `acceptBusinessInvitation(…, now, opts?: { enforceLimits?: boolean })`, `addLocation(…, now, opts?: { enforceLimits?: boolean })`. The API passes `enforceLimits: config.BUSINESS_PRO_ENABLED`.
  - Config `BUSINESS_PRO_ENABLED: flag`; error copy: `BUSINESS_STAFF_LIMIT` (409) "Your business is at its staff limit.", `BUSINESS_LOCATION_LIMIT` (409) "Your business is at its location limit."

- [ ] **Step 1: Write the failing tests** (`business-limits.test.mjs`)

```js
test('a free business invites a 3rd person but not a 4th', async () => {
  /* 2 members + invite #3 ok; invite #4 → BUSINESS_STAFF_LIMIT */
});
test('owners never count toward the staff limit', async () => {
  /* owner's page is a member + 3 others → used 3, invite #4 refused only by the 3 others */
});
test('one person at two locations counts once', async () => {});
test('accepting re-checks: the 4th accept is refused and the invitation stays open', async () => {});
test('a free business adds no second location; a pro one adds up to 25', async () => {});
test("a lapsed business keeps 24 staff and can't add a 25th or a 4th", async () => {
  // 24 members while pro, then plan → free: all 24 still open, invite refused BUSINESS_STAFF_LIMIT;
  // members leave down to 2 → invite allowed again up to 3.
});
test('limits hold under two invitations at once', async () => {
  const results = await Promise.allSettled([
    invite(ownerA, 'x@example.com'),
    invite(ownerB, 'y@example.com'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); // business at 2 of 3
});
test('without enforceLimits nothing changes (flag off)', async () => {});
```

API test (`business-limits-api.test.mjs`): with `BUSINESS_PRO_ENABLED=false`, a 5th invite succeeds and `GET /v1/me/businesses/:id` has no `plan`/`usage`; with `true`, the 4th gets `409 BUSINESS_STAFF_LIMIT` and the detail has `usage.staff = { used: 3, limit: 3 }`.

- [ ] **Step 2: Run to fail**

Run: `pnpm --filter @tipme/database build && node --test packages/database/test/integration/business-limits.test.mjs`
Expected: FAIL (`businessUsage is not a function`)

- [ ] **Step 3: Implement.** Count under the business row lock (`SELECT … FROM businesses WHERE id = $1 FOR UPDATE`) that `inviteToBusiness` already takes; `addLocation` and `acceptBusinessInvitation` take it too before counting. Staff used (ruling R4):

```sql
SELECT count(DISTINCT bm.profile_id)::int FROM business_members bm
  JOIN business_locations l ON l.id = bm.location_id
  JOIN profiles p ON p.id = bm.profile_id
 WHERE l.business_id = $1 AND bm.left_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM business_managers m WHERE m.business_id = $1
                    AND m.user_id = p.user_id AND m.role = 'owner' AND m.removed_at IS NULL)
```

plus, when `countInvitations`, open unexpired staff invitations. Locations used: `closed_at IS NULL`. Never touch existing rows.

- [ ] **Step 4: Run to pass**

Run: `pnpm --filter @tipme/database build && node --test packages/database/test/integration/business-limits.test.mjs packages/database/test/integration/business-invitations.test.mjs packages/database/test/integration/business-manage.test.mjs && pnpm exec turbo build --filter=@tipme/api && node scripts/test-integration.mjs tests/integration/business-limits-api.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** `feat(business): staff and location limits by plan, behind BUSINESS_PRO_ENABLED`

### Task A5: Admin "Prices" with Business Pro

**Files:**

- Modify: `packages/contracts/src/ops-catalogue.ts` (:333 list, :355 words, :376 permission map), `packages/database/src/operations/serious-actions-registered.ts` (beside `proPriceChange` :536), `apps/web/src/app/ops/pro-price/page.tsx`, ops nav label ("Pro price" → "Prices")
- Create: `apps/api/src/ops/business-pro-price.controller.ts` (register in the ops module)
- Test: `tests/integration/pro-price.test.mjs` (extend), `tests/e2e/ops-prices.spec.ts`

**Interfaces:**

- Consumes: A3 price functions.
- Produces: serious action `business_pro_price.change` (permission `pro.price`, payload `{ amountMinor: string }`, pinned on the current business price, describe "Change the Business Pro price from ₦7,000 to ₦7,500 a month, for new months only"); `GET/POST /v1/ops/business-pro-price` returning `OpsProPrice` (same contract as `/v1/ops/pro-price`); route 404 with the flag off.

- [ ] **Step 1: Failing tests**

```js
test('a Business Pro price change waits for a second person', async () => {
  /* ask → pending; personal price unchanged; approve → current business 750000 */
});
test('a lone admin changes the Business Pro price alone, with the alert', async () => {});
test('a business price change never touches a waiting personal request', async () => {});
```

E2E (`ops-prices.spec.ts`, lane 3): the Prices screen shows two cards, "Personal Pro" and "Business Pro", each with its own history rows labelled by plan; asking for a business change shows "Waiting for a second person. The price hasn’t changed yet." inside the Business Pro card. `afterEach` cancels the request.

- [ ] **Step 2: Run to fail**: `node scripts/test-integration.mjs tests/integration/pro-price.test.mjs` → FAIL (`unknown serious action business_pro_price.change`)
- [ ] **Step 3: Implement**; the page fetches both endpoints, keeps the existing card, adds the Business Pro card only when `/v1/ops/business-pro-price` answers 200, and merges history with a Plan column. Board copy under the cards: "New price applies to the next renewal; the shown price is honoured."
- [ ] **Step 4: Run to pass**: the integration file, then `E2E_LANE=3 pnpm exec playwright test tests/e2e/ops-prices.spec.ts tests/e2e/ops-pro-price.spec.ts --workers=2` → PASS
- [ ] **Step 5: Record the decision.** Add to `docs/00-DECISIONS.md` a dated block "Business Pro (owner, 14 Nov 2026)" with the Global Constraints' prices, limits, fees and the note "the owner's product decision, not legal or regulatory approval".
- [ ] **Step 6: Commit, then the PR wrap-up** (see "Every PR ends with"). PR title: `feat(business): Business Pro plans, limits and price (behind BUSINESS_PRO_ENABLED)`.

---

## Phase B: buying and keeping Business Pro (`BUSINESS_PRO_ENABLED`)

### Task B1: API: a business's Pro, buying a month

**Files:**

- Create: `apps/api/src/business/business-pro.controller.ts`, `packages/contracts/src/business-pro.ts` (export from the contracts index)
- Modify: `apps/api/src/business/business.module.ts` (import `ProModule` for `PRO_CHECKOUT_TOKEN`), `packages/database/src/operations/pro-balance.ts` (`buyProFromBalance` :278 takes a subject), `packages/database/src/operations/pro-purchases.ts` (`buyProByCheckout` :349 takes a subject)
- Test: `tests/integration/business-pro-api.test.mjs`

**Interfaces:**

- Consumes: A3 `businessProState`, `requestProPurchase({ subject, boughtBy })`; A2 posting; `managerOf(…, { owner: true })`.
- Produces:
  - `GET /v1/me/businesses/:id/pro` → `BusinessPro` (owners and location managers; managers get `price: null`, `methods: []`, `canBuy: false`).
  - `POST /v1/me/businesses/:id/pro/purchases` (owners; `Idempotency-Key` UUID; body `proPurchaseRequestSchema`) → `ProPurchase`. Success and cancel URL `/dashboard/business?business=<id>#plan`.
  - `GET /v1/me/businesses/:id/pro/purchases/:purchaseId` → `ProPurchase`.
  - `POST /v1/me/businesses/:id/pro/auto-renew/off` → `{ on: boolean }` (always allowed).
  - Contract:

```ts
export interface BusinessPro {
  plan: 'free' | 'pro';
  usage: BusinessUsage;
  current: {
    startsAt: string;
    endsAt: string;
    graceEndsAt: string;
    paidBy: ProPaidBy;
  } | null;
  next: { startsAt: string; endsAt: string } | null;
  openPurchase: ProPurchase | null;
  price: ProPrice | null; // null for a location manager
  methods: ('card' | 'balance')[]; // 'balance' per ruling R9
  balanceMinor: string | null; // shown beside "Business balance" when 'balance' is offered
  billingOn: boolean; // PRO_BILLING_ENABLED and the live gates
  canBuy: boolean; // owner of a verified business
  autoRenew: {
    available: { card: boolean; balance: boolean };
    on: boolean;
    source: 'balance' | 'saved_card' | null;
  };
  lapsedAt: string | null;
  ownerName: string | null; // for a manager's "Ask the owner, …"
}
```

- `buyProFromBalance(db, input: { subject: MoneyOwner; boughtBy?: string; … })`: a business collects from the business's connected account (`payment_accounts.business_id`), reserves against `businessBalanceIn`, posts `buildBusinessProBalancePosting` with operation key `pro.<purchaseId>`, under the business row lock that withdrawals take.

- [ ] **Step 1: Failing tests** (pretend provider only)

```js
test('an owner buys a month by card and the business is pro only after the confirmed payment', async () => {
  const purchase = await post(
    `/v1/me/businesses/${biz.id}/pro/purchases`,
    { expectedAmountMinor: price },
    owner,
  );
  assert.equal(
    (await get(`/v1/me/businesses/${biz.id}/pro`, owner)).plan,
    'free',
  );
  await pretendPay(purchase.purchaseId);
  assert.equal(
    (await get(`/v1/me/businesses/${biz.id}/pro`, owner)).plan,
    'pro',
  );
});
test('a stale Business Pro price is refused', async () => {
  await changeBusinessPrice(750000n);
  const answer = await post(
    `…/pro/purchases`,
    { expectedAmountMinor: '700000' },
    owner,
  );
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error.code, 'PRO_PRICE_CHANGED');
});
test('paying from the business balance posts against business_payable once', async () => {
  /* flags on; replay same key → same purchase; ledger balanced; balance down by price */
});
test('the balance way is not offered while shares are off', async () => {
  /* methods == ['card']; POST method balance → 400 */
});
test('a location manager sees the plan and cannot buy', async () => {
  /* GET: price null, canBuy false; POST → 403 OWNER_REQUIRED (today's mapping) */
});
test("another business's owner gets 404", async () => {});
test('the flag off answers 404 on every route', async () => {});
test("buying Business Pro never changes the owner's own plan", async () => {});
```

- [ ] **Step 2: Run to fail**: `pnpm exec turbo build --filter=@tipme/api && node scripts/test-integration.mjs tests/integration/business-pro-api.test.mjs` → FAIL (404 on `/pro`)
- [ ] **Step 3: Implement**, mirroring `ProController` (`billingOpenFor`, `absolute`, `wire`). The live gate uses the business slug in place of a handle (`liveCheckoutOpenFor` takes a string list); state it in a comment.
- [ ] **Step 4: Run to pass**, plus `tests/integration/pro-api.test.mjs tests/integration/pro-money-api.test.mjs tests/integration/pro-webhooks.test.mjs` unchanged → PASS
- [ ] **Step 5: Commit** `feat(api): buy Business Pro by card, bank transfer or the business balance`

### Task B2: Renewals, reminders and lapse

**Files:**

- Modify: `packages/database/src/operations/pro-auto-renew.ts` (subject-aware `renewProAutomatically` :327), `pro-periods.ts` (`sendProReminders` :339), `apps/worker/src/handlers/pro.ts`, `apps/worker/src/job-worker.ts`, `apps/worker/src/config.ts` (`BUSINESS_PRO_ENABLED`)
- Create: `packages/database/src/operations/business-pro-renew.ts`
- Test: `packages/database/test/integration/business-pro-renew.test.mjs`, `apps/worker/test/pro-handler.test.mjs` (extend)

**Interfaces:**

- Produces:
  - `setBusinessAutoRenew(db, input: { businessId; userId; source: 'balance' | 'saved_card'; on: boolean; now }): Promise<{ on: boolean; source: … | null }>` (owners; `saved_card` only via a checkout with `autoRenew: true`, as personal).
  - `renewBusinessesFromBalance(db, input: { provider: ProCollectProvider; providerName; sealing; now }): Promise<{ renewed: number; failed: number }>`: for each business with `source = 'balance'`, enabled, and an ACTIVE month ending within 24 hours and no queued month, calls `buyProFromBalance` with idempotency key `business-renew-<periodId>`; one attempt per period; a refusal records `failed_period_id` and mails owners `business_pro_renewal_failed`.
  - `sendProReminders` also sends `business_pro_reminder` to every open owner 7 days before the end when auto-renew is off (one per period, dedupe `business_pro_reminder.<periodId>`), and an in-app notification.
  - The `pro.expire` handler revalidates `/b/<slug>` for every `businessChanges` entry and publishes `business.changed` to its managers (`businessLiveAudience`).

- [ ] **Step 1: Failing tests**

```js
test('a balance renewal is tried once per month, a day before it ends', async () => {});
test('a refused balance renewal mails the owners and leaves grace to run', async () => {});
test('a saved-card business renewal charges once, scheduled by TipMe', async () => {});
test('owners get one reminder 7 days before, only with auto-renew off', async () => {});
test('a price change before renewal: the renewal pays the new price and owners were emailed it', async () => {});
```

- [ ] **Step 2: Run to fail**: `node --test packages/database/test/integration/business-pro-renew.test.mjs` → FAIL
- [ ] **Step 3: Implement.** The price-change email: when `business_pro_price.change` runs, enqueue `business_pro_price_notice` to the owners of every business with auto-renew on (dedupe per price id and business). Never call the partner's subscription API.
- [ ] **Step 4: Run to pass** (with `pro-auto-renew.test.mjs` and the worker tests)
- [ ] **Step 5: Commit** `feat(worker): TipMe-scheduled Business Pro renewals, reminders and lapse`

### Task B3: Web: Business → Plan, limit moments, lapse banner

**Files:**

- Create: `apps/web/src/app/dashboard/business/sections/plan.tsx`, `apps/web/src/lib/business/pro-api.ts`, `apps/web/src/components/business/limit-moment.tsx`, `apps/web/src/components/business/lapse-banner.tsx`
- Modify: `apps/web/src/app/dashboard/business/sections.ts` (add `{ id: 'plan', title: 'Plan', Card: PlanSection }` last; shown to owners and managers, the card itself decides), `sections/people.tsx`, `sections/locations.tsx`, `business-view.tsx`, `apps/web/src/lib/pro-buy.ts` (take a purchase URL)
- Test: `apps/web/test/business-plan-copy.test.mjs`, `tests/e2e/business-pro-buy.spec.ts`

**Interfaces:**

- Consumes: B1 routes and `BusinessPro`; A4 `BusinessDetail.usage`.
- Produces: `loadBusinessPro(businessId): Promise<BusinessPro | null>`; `buyBusinessPro(businessId, body, idempotencyKey)`; `planLimitCopy(usage, plan, price): { title: string; body: string }`; `keepPendingInvite(businessId, email)` / `takePendingInvite(businessId)` (sessionStorage, try/catch).

Copy (exact, from the board, with ruling R1):

- At the limit: "You have 3 staff, the Free limit. Business Pro allows up to 25. Everyone you have now keeps working. To invite a 4th person, or open a second location, move to Business Pro."
- Invite moment: "You have 3 staff, the Free limit. Business Pro allows up to 25, for ₦7,000 a month. Your 3 staff keep working as they are." Buttons "See Business Pro", "Not now". The typed email is kept and offered after upgrading.
- Location moment: "Business Free includes one location. With Business Pro you can open up to 25, each with its own QR code and page. {first location} keeps taking tips as it does now."
- Pro at 25: "You have 25 staff, the Business Pro limit. Talk to us about more." (link per R2).
- Confirm from balance: "Pay ₦7,000 from {business}’s balance for one month of Business Pro? Your balance will be ₦{after}."
- Done (server-confirmed only): "Thank you. {business} is on Business Pro until {date}."
- Manager: "{business} is at its Free limit of 3 staff. Ask the owner, {ownerName}, about Business Pro." No price, no button.
- Lapse banner (owners): "Business Pro ended on {date}. Your {n} staff and {m} locations keep working and taking tips. Until you renew, you can’t add staff or locations above the Free limits, and your branded extras are paused. Your data is kept." Buttons "Renew · ₦{price}", "What’s paused". Managers see the line without the button.
- Every price in the copy comes from `BusinessPro.price`; "Your staff’s tip fee doesn’t change: each person keeps their own plan’s rate."

- [ ] **Step 1: Failing unit test** for `planLimitCopy` (free at 3/3, free at 1/1 locations, pro at 25/25, lapsed pro above free) asserting the strings above with a 750000-kobo price to prove nothing is hard-coded.
- [ ] **Step 2: Run to fail**: `pnpm --filter @tipme/web test -- business-plan-copy` → FAIL
- [ ] **Step 3: Implement** the section (states A to D of the board), the moments (inline cards, never a modal over work), the banner at the top of `business-view.tsx`, and the pending card payment slip reused from `plan.tsx` ("We haven’t heard back about your payment yet").
- [ ] **Step 4: E2E** (`business-pro-buy.spec.ts`, lane 3): a free business at 3 staff → inviting a 4th shows the moment inside the People card and keeps the email; Plan → card → pretend checkout → "Thank you." only after the confirmed state; then the kept invitation sends. A manager sees "Ask the owner". `afterEach` ends the test's members. Run `E2E_LANE=3 pnpm exec playwright test tests/e2e/business-pro-buy.spec.ts --workers=2` → PASS
- [ ] **Step 5: Commit** `feat(web): Business → Plan, calm limit moments and the lapse banner`

### Task B4: Mail for Business Pro (parallel with B1)

**Files:**

- Create: `packages/mail/src/templates/types/business-pro-notices.ts` (register like `pro-notices.ts`)
- Test: `packages/mail/test/business-pro-notices.test.mjs`

**Interfaces:**

- Produces mail types: `business_pro_receipt` (data `{ businessName, amountMinor, paidBy, endsOn }`), `business_pro_reminder` (`{ businessName, endsOn, priceMinor }`), `business_pro_renewal_failed`, `business_pro_ended` (`{ businessName, staff, locations }`), `business_pro_price_notice` (`{ businessName, fromMinor, toMinor, renewsOn }`). Subjects carry no business name or amount (no private data in subjects): e.g. "Your Business Pro receipt", "Business Pro renews soon".

- [ ] **Step 1: Failing test**: each template renders; subjects and preheaders contain neither the business name nor a naira amount; no body contains the partner's name (assert `!/bachs/i`); the receipt says "Paid through our payment partner."
- [ ] **Step 2–4:** run `pnpm --filter @tipme/mail build && node --test packages/mail/test/business-pro-notices.test.mjs` red, implement, green.
- [ ] **Step 5: Commit** `feat(mail): Business Pro receipt, reminder, renewal and price notices`

### Task B5: Business Pro in ops and the PR wrap-up

**Files:**

- Modify: `packages/database/src/operations/business-ops.ts` (`opsBusinessDetail` :118 gains `plan`, `paidUntil`, `usage`), `apps/web/src/app/ops/businesses/…` detail view, `packages/database/src/operations/pro-refunds.ts` (`opsProPayments` lists business purchases with the business name)
- Test: `tests/integration/ops-businesses-api.test.mjs` (extend)

- [ ] **Step 1: Failing test**: ops business detail shows `plan: 'pro'` and `paidUntil` for a business with a paid month, and a `pro.refund` asked for a business purchase lists its owners as subjects (an owner who is staff can't decide it).
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): buy and keep Business Pro (behind BUSINESS_PRO_ENABLED)`.

---

## Phase C: release-1 Business Pro features (`BUSINESS_PRO_ENABLED`, Pro businesses only)

Every route here refuses a business whose `plan` is `free` (never bought, or lapsed) with `404 BUSINESS_PRO_REQUIRED`, except the past-statement PDF read (ruling R8). A location manager is scoped to their location by `managerOf(…, { locationId })` exactly as `locationInsights` is; that is what "managers run their own location fully" means in release 1 (their location's analytics, statement and staff, which they already invite and remove).

### Task C1: Analytics API

**Files:**

- Create: `packages/database/src/operations/business-analytics.ts`, `apps/api/src/business/business-analytics.controller.ts`
- Modify: `packages/contracts/src/business.ts` (new query and view), `packages/database/src/operations/business-insights.ts` (export `withheldCounts` reuse; no behaviour change)
- Test: `packages/database/test/integration/business-analytics.test.mjs`, `tests/integration/business-analytics-api.test.mjs`

**Interfaces:**

- Produces:
  - `businessAnalyticsQuerySchema = z.object({ from: isoDate, to: isoDate, locationId: z.uuid().optional() }).strict()` (Lagos dates, `to - from` ≤ 366 days, `from ≤ to`).
  - `businessAnalytics(db, userId, businessId, q): Promise<BusinessAnalytics>`; route `GET /v1/me/businesses/:id/analytics`.

```ts
export interface BusinessAnalytics {
  from: string;
  to: string;
  locationId?: string;
  tips: Shown;
  totalMinor?: string;
  averageMinor?: string; // absent when amountsHidden
  previous?: { tips: Shown; totalMinor?: string; averageMinor?: string }; // the same-length range before
  teamTip?: { tips: Shown; totalMinor?: string; percent?: number }; // only with team tips in range
  weeks: { start: string; personMinor?: string; teamMinor?: string }[]; // the 12 weeks ending at `to`
  months: { month: string; totalMinor?: string }[]; // the 12 months ending at `to`
  locations: {
    locationId: string;
    name: string;
    tips: Shown;
    totalMinor?: string;
  }[]; // owners only
  grid: {
    day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    hour: number;
    level: 0 | 1 | 2 | 3 | 4;
  }[]; // intensity, never counts
  best?: {
    day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    fromHour: number;
    toHour: number;
    share: { n: number; of: number };
  }; // ≥ 3 tips
  staff: {
    memberId: string;
    shownName: string;
    locationName: string;
    tips: Shown;
    receivedMinor?: string;
  }[];
  peopleHidden?: true;
  amountsHidden?: true;
}
```

- Rules (R7 and today's): `receivedMinor` only while `BUSINESS_STAFF_AMOUNTS` is on **and** the member shares amounts (the flag stays off, so in practice never); `withheldCounts` decides which counts show; `totalMinor` (business, location, week, month, team) only when the members in that scope who keep amounts private are 0 or ≥ `MIN_GROUP`; owners and managers only, never public; a location manager passing another `locationId` or none gets their own location only (none → their location).

- [ ] **Step 1: Failing tests**

```js
test('any range across all locations, with the previous range beside it', async () => {});
test('a location manager only ever sees their own location', async () => {});
test("a staff member's amount can't be worked out from the total", async () => {
  // flag off: no row has receivedMinor, even for staff who share amounts
  // flag off, 2 staff tipped → totalMinor absent, amountsHidden true; 3 or more → totalMinor present
  // flag on (test only): 2 share, 1 private → totalMinor absent; 2 share, 3 private → present
});
test('counts under 3 read "fewer than 3" and the grid has levels, not counts', async () => {});
test('a free business gets 404 BUSINESS_PRO_REQUIRED; a lapsed one too', async () => {});
test('a range over 366 days is refused', async () => {});
```

- [ ] **Step 2: Run to fail**: `node --test packages/database/test/integration/business-analytics.test.mjs` → FAIL
- [ ] **Step 3: Implement** with one query per figure over `tips` (paid, `business_location_id` in scope, `completed_at` in the Lagos range) and team tips (`team_location_id`, only when `TEAM_TIPS_ENABLED` has made any); amounts are what each tip paid (`recipient` net and gross from the tip row), never recomputed from a plan.
- [ ] **Step 4: Run to pass** (with `business-insights.test.mjs` unchanged) → PASS
- [ ] **Step 5: Commit** `feat(business): Business Pro analytics across locations and any range`

### Task C2: Analytics screen

**Files:**

- Create: `apps/web/src/app/dashboard/business/sections/analytics.tsx`, `apps/web/src/lib/business/analytics-api.ts`
- Modify: `sections.ts` (add `analytics` after `this-week`)
- Test: `apps/web/test/business-analytics-view.test.mjs`, `tests/e2e/business-analytics.spec.ts`

Board section 5: range chips (This week, {last month}, Last 3 months, This year, Choose dates), "All locations ({n})" picker (owners), four stat tiles (Tips in {range}, Average tip, Team tip, Best time), Week by week (person vs team stacked), By location bars, team-vs-person split line, day-and-hour grid ("Darker means more tips."), By staff (top 6, "See all {n}", "Owners and managers only."), "Download statement (PDF)" and "Export CSV or Excel" (links to C4's routes; hidden until C4 is on dev). On a phone the grid and staff table stack; tables scroll inside their card, never the page (measure with `documentElement.clientWidth`). A Free business sees the Plan upsell card in place of the section.

- [ ] **Step 1: Failing unit test** for the view model `analyticsTiles(analytics)` (amountsHidden → tiles show counts and "Totals show once at least 3 of your staff have been tipped."; the By staff table shows tips only, never naira).
- [ ] **Step 2–4:** red, implement, green; e2e on lane 5: owner sees two locations' bars inside the "By location" region; a manager sees no location picker; phone width has no page scroll. `afterEach` ends members.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): Business Pro analytics (behind BUSINESS_PRO_ENABLED)`.

### Task C3: Monthly statement snapshots

**Files:**

- Modify: `packages/database/src/schema.ts` (new `business_statements`), `apps/worker/src/job-worker.ts` (after `runMonthlyRecaps` :570)
- Create: migration via drizzle-kit (`business_statements`), `packages/database/src/operations/business-statements.ts`
- Test: `packages/database/test/integration/business-statements.test.mjs`

**Interfaces:**

- Produces:
  - Table `business_statements`: `id uuid PK`, `business_id → businesses`, `month text` (`^\d{4}-(0[1-9]|1[0-2])$`), `number text UNIQUE` (`TM-B-YYYY-MM-NNNN`, NNNN a per-month sequence), `data jsonb NOT NULL`, `created_at`; unique `(business_id, month)`.
  - `runBusinessStatements(db, input: { month: string; now: Date; sealing: MailSealing }): Promise<{ created: number }>`: for every business on Pro at any moment of that Lagos month; idempotent (the unique key); mails `business_statement_ready` to open owners and to the accountant (Task C5) with a link, never the file. Location managers get the same mail for their location.
  - `statementData` shape: `{ business, month, locations: [{ id, name }], staff: [{ memberId, name, locationId, plan: 'free'|'pro', feeBps, tips, grossMinor?, feeMinor?, receivedMinor? }], teamTip: { tips, grossMinor }, totals }`; `plan`/`feeBps` from each tip's own recorded fee, never today's plan.
  - `listBusinessStatements(db, userId, businessId)`; `readBusinessStatement(db, userId, businessId, month): Promise<StatementView>` filters rows to a manager's location and applies R7 (with `BUSINESS_STAFF_AMOUNTS` off every staff row carries tips, plan and fee rate only, never naira; totals follow the same rule as C1). The snapshot still stores per-row amounts so turning the flag on later needs no backfill; nothing reads them while it is off.

- [ ] **Step 1: Failing tests**: one statement per business and month however often the job runs; a free-all-month business gets none; fee columns follow each tip's recorded fee (a staff member who moved from Free to Pro mid-month shows both rates as two rows); **statement rows carry tips, never naira, with the flag off**; a manager reads only their location's rows.
- [ ] **Step 2–4:** red (`node --test packages/database/test/integration/business-statements.test.mjs`), implement, green.
- [ ] **Step 5: Commit** `feat(business): monthly Business Pro statement snapshots`

### Task C4: Statement PDF and CSV/Excel exports

**Files:**

- Create: `apps/api/src/business/business-statements.controller.ts`, `apps/worker/src/statements/business-pdf.ts` (beside the Pro features plan's `apps/worker/src/statements/pdf.ts`, same fonts and helpers)
- Modify: `business_statements` gains `location_id uuid null` (null = the whole business; one row per location too, so a manager's PDF is pre-rendered), `pdf bytea NOT NULL`, `pdf_sha256`, unique `(business_id, month, location_id)` NULLS NOT DISTINCT; the C3 job renders and stores the PDFs in the worker; `packages/database/src/operations/export.ts` (reuse `csvCell` and the Pro features plan's xlsx writer)
- Test: `tests/integration/business-statements-api.test.mjs`, `apps/worker/test/business-statement-pdf.test.mjs`
- **Needs on dev first:** the Pro features plan's Tasks 21 and 22. `pdfkit` stays worker-only (its source test greps `apps/api/src` for it).

**Interfaces:**

- Produces routes: `GET /v1/me/businesses/:id/statements` → `{ month, number }[]`; `GET /v1/me/businesses/:id/statements/:month.pdf` (owners, managers; **readable on a lapsed business**, R8); `GET /v1/me/businesses/:id/exports?from&to&format=csv|xlsx&locationId` (Pro only; ≤ 366 days; ≤ `EXPORT_LIMIT` rows else `EXPORT_TOO_LARGE`): one row per tip with date and time (Lagos), location, `team|person`, amount, fee, received, and the supporter's name only when the tip wasn't anonymous. With `BUSINESS_STAFF_AMOUNTS` off (always, here) there is **no staff member column**, and a location with fewer than 3 tipped staff in the range has its amount, fee and received cells left blank (R7), so no one's naira can be read off. Cells pass through `csvCell` (CSV injection). All `Cache-Control: private, no-store`.
- `renderBusinessStatementPdf(data: BusinessStatementData, options?: { compress?: boolean }): Promise<Buffer>` (worker) draws the board's page 1 (header, four totals, by-staff table, team tip block, the footer paragraph with "Payments are processed by our payment partner.") and continuation pages.

- [ ] **Step 1: Failing tests**: the PDF starts `%PDF-`, rendered with `compress: false` its text contains the statement number, "₦" (drawn by the shared Noto Sans subset), "our payment partner" and never the partner's name; the same data renders the same bytes; with the flag off no staff row has a naira cell; a CSV cell `=SUM(A1)` comes out `'=SUM(A1)`; a manager's export holds only their location; a free business's export is 404.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(business): Business Pro statement PDFs (worker) and CSV or Excel exports`

### Task C5: The accountant's email

**Files:**

- Modify: `packages/database/src/schema.ts` (new `business_accountants`), statement operations, `apps/api/src/business/business-statements.controller.ts`
- Create: migration via drizzle-kit, `apps/web/src/app/statements/page.tsx` (+ client view), `apps/web/src/app/dashboard/business/sections/statements.tsx` (list + accountant field, owners)
- Test: `tests/integration/business-accountant-api.test.mjs`, `tests/e2e/business-statements.spec.ts`

**Interfaces:**

- Produces: table `business_accountants (business_id PK → businesses, email_lower text NOT NULL, set_by → users, created_at)`; `PUT /v1/me/businesses/:id/accountant { email }` and `DELETE …/accountant` (owners, Pro); `GET /v1/me/statements` → `{ businessId, businessName, month, number }[]` for the signed-in login whose **proven** email equals an accountant row; `GET /v1/me/statements/:businessId/:month.pdf`. Web `/statements` (standalone, outside the dashboard shell; signed out → `/sign-in?next=/statements`; with Phase D on, a login with no page may sign in and is sent back here).
- Copy: "Your accountant gets a link to each month’s statement. They see statements only, not your dashboard."

- [ ] **Step 1: Failing tests**: the accountant reads that business's PDFs and nothing else (dashboard business routes 404); an unproven email gets nothing; removing the email ends access at once; a lapsed business sends no accountant mail; the e2e (lane 6) adds an accountant, runs the statement job for a fixed month with seeded tips, signs in as the accountant and finds the statement inside the "Statements" region, then removes the accountant in `afterEach`.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): monthly statements, exports and the accountant's email (behind BUSINESS_PRO_ENABLED)`.

### Task C6: Branded business page: data and API

**Files:**

- Modify: `packages/database/src/schema.ts` (new `business_brands`, `business_location_details`), `operations/business-public.ts` (`publicBusiness` :237, `publicLocation` :198), `packages/contracts/src/business.ts` (`PublicBusiness`, `PublicLocation`)
- Create: migration via drizzle-kit, `packages/database/src/operations/business-brand.ts`, `apps/api/src/business/business-brand.controller.ts` (images reuse the cover and logo pipeline in `operations/covers.ts` / `business-logos.ts`)
- Test: `packages/database/test/integration/business-brand.test.mjs`, `tests/integration/business-brand-api.test.mjs`

**Interfaces:**

- Produces:
  - `business_brands (business_id PK, cover_path, cover_version int default 0, brand_color text null CHECK ~ '^#[0-9a-f]{6}$', welcome_line text null CHECK char_length ≤ 120, updated_at)`; cover bytes in `business_brand_covers` like `business_logos` (Postgres or R2, one of the two).
  - `business_location_details (location_id PK, photo_path, photo_version, hours jsonb null, updated_at)`; hours schema `{ mon..sun: { open: 'HH:MM', close: 'HH:MM' } | 'closed' }[]`.
  - Routes (owners for the business; owners and that location's manager for a location): `PATCH /v1/me/businesses/:id/brand { brandColor?, welcomeLine? }`, `PUT/DELETE …/brand/cover`, `PATCH …/locations/:locationId/details { hours? }`, `PUT/DELETE …/locations/:locationId/photo`.
  - `brandColor` refused `BRAND_COLOR_LOW_CONTRAST` unless white text on it reaches 4.5:1 (`contrastRatio` in `packages/domain`).
  - Public reads add `brand?: { coverPath?; brandColor?; welcomeLine? }` and per location `photoPath?`, `hours?` **only while the business is Pro**; saved values stay when it lapses (R8).
- [ ] **Step 1: Failing tests**: a lapsed business's public page has no `brand` but its saved row is untouched and returns on renewal; a low-contrast colour is refused; a manager edits only their location's details; a free business's brand routes are 404.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(business): branded business page data, paused on lapse`

### Task C7: Branded business page: screens

**Files:**

- Modify: `apps/web/src/app/b/[business]/…` (public page and location page), `apps/web/src/app/dashboard/business/sections/details.tsx` (a "Your page" card for owners), `sections/locations.tsx` (photo and hours)
- Test: `tests/e2e/business-brand.spec.ts` (lane 7)

- [ ] **Step 1: Failing e2e**: an owner on Pro sets a cover, a colour and "Welcome to the grill"; `/b/<slug>` shows them inside its header region; after the test ends the business's Pro period (`sql` sets `grace_ends_at` past and runs the sweep), the page falls back to the logo and heart cover, and the dashboard says the branded settings are saved for later.
- [ ] **Step 2–4:** red, implement (the brand colour sets one CSS custom property on the business page only; text colours stay the constitution's), green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): branded business page (behind BUSINESS_PRO_ENABLED)`.

### Task C8: Premium location QR designs and print formats

**Files:**

- Modify: `apps/web/src/lib/business-sign.ts` (`SIGN_STYLES`, `SIGN_FORMATS`), `apps/web/src/app/dashboard/business/codes/print/print-view.tsx`, `apps/web/src/app/dashboard/business/sections/codes.tsx`, `apps/api/src/business/business-codes.controller.ts` (answer gains `plan` and `brandColor?`)
- Test: `apps/web/test/business-sign.test.mjs`, `tests/e2e/business-codes-pro.spec.ts` (lane 8)

**Interfaces:**

- Produces: `SIGN_STYLES` entries gain `pro: boolean`; new formats `table_tent` (A4 folded, two faces) and `sticker` (60 mm square, 6 per A4) with `pro: true`; `drawLocationSign(ctx, { …, style, brandColor? })` uses the brand colour for Pro styles only when it passes `isScannableStyle` contrast.
- Rules: a Free or lapsed business sees Pro designs as previews ("{name} is a Business Pro design. This is a preview, and printing needs Business Pro."), and the standard card on screen; printed codes keep scanning because the URL never changes.

- [ ] **Step 1: Failing unit test**: every Pro style with any allowed brand colour still decodes (`qrMatrix` round trip) and `isScannableStyle` holds; a free plan's printable list excludes Pro styles and formats.
- [ ] **Step 2–4:** red, implement, green; e2e: a Pro owner prints a table tent for their location; a free owner sees the preview line.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): premium location QR designs, table tents and stickers (behind BUSINESS_PRO_ENABLED)`.

### Task C9: Business name changes, 3 a year (ruling R5)

**Files:**

- Modify: `packages/database/src/schema.ts` (new `business_name_changes`), `packages/contracts/src/ops.ts` (`ISSUE_KINDS` + `business_rename`), `operations/business-manage.ts` (`updateBusiness` :111 keeps `BUSINESS_NAME_LOCKED` for direct edits), `operations/business-ops.ts`, `apps/api/src/business/business-manage.controller.ts`, `apps/api/src/ops/…businesses controller`, web `sections/details.tsx`, ops business detail
- Create: migration via drizzle-kit (table + issue kind check)
- Test: `packages/database/test/integration/business-rename.test.mjs`, `tests/e2e/business-rename.spec.ts` (lane 8, after C8)

**Interfaces:**

- Produces: `business_name_changes (id PK, business_id, from_name, to_name CHECK 1..80, asked_by → users, status 'waiting'|'approved'|'declined'|'cancelled', decided_by, decided_at, decline_reason, created_at)`, one waiting per business (partial unique); `askBusinessRename(db, userId, businessId, { name }, now)` (owners, Pro, verified) refuses `BUSINESS_RENAME_LIMIT` when 3 approved in the last 365 days, `BUSINESS_RENAME_WAITING` when one waits; opens issue `business_rename`; ops `decideBusinessRename(tx, { changeId, staffUserId, approve, reason, now })` (permission `businesses.manage`; the business's own managers can't decide) sets `businesses.name` on approval and emails the owners either way. Routes `POST /v1/me/businesses/:id/name-changes`, `POST …/name-changes/:changeId/cancel`, `POST /v1/ops/businesses/:id/name-changes/:changeId/decide`.
- Copy: "You can change your business’s name 3 times a year. TipMe checks each new name before it shows. Your address on TipMe and your printed codes stay the same." and "{n} of 3 name changes used this year."

- [ ] **Step 1: Failing tests**: the 4th approved change in 365 days is refused; a declined ask doesn't count; the slug never changes; the public page shows the old name until approval; a lapsed business can't ask.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): three checked name changes a year on Business Pro (behind BUSINESS_PRO_ENABLED)`.

---

## Phase D: business sign-up (`BUSINESS_SIGNUP_ENABLED`)

### Task D1: Flag, the login's own account read, and landing after sign-in

**Files:**

- Modify: `apps/api/src/config.ts` (`BUSINESS_SIGNUP_ENABLED`, `BUSINESS_OWNERS_ENABLED`), `/health/release` (`businessSignup`, `businessOwners`), `packages/contracts/src/auth.ts` (`SignInVerified` :32), `apps/api/src/auth/auth.controller.ts` (:174), `apps/web/src/app/sign-in/sign-in-view.tsx`, `apps/web/src/lib/business/available.ts`
- Create: `GET /v1/me/account` in `apps/api/src/auth/account.controller.ts`; `packages/contracts/src/account.ts`
- Test: `tests/integration/account-api.test.mjs`, `apps/web/test/sign-in-landing.test.mjs`

**Interfaces:**

- Produces:
  - `SignInVerified` gains `managesBusiness: boolean` (false unless `BUSINESS_SIGNUP_ENABLED`).
  - `MyAccount { userId: string; email: string | null; emailVerified: boolean; hasProfile: boolean; handle: string | null }` from `GET /v1/me/account` (session only; never needs a profile).
  - `signedInLanding(result: SignInVerified, next: string): string` in `apps/web/src/lib/signed-in-landing.ts`: page → `next`; admin `next` → `next`; no page but `managesBusiness` → `next` if it starts with `/dashboard/business` or `/statements`, else `/dashboard/business`; otherwise `/sign-up`.
  - `releaseFlags(release): { business; businessPro; businessSignup; businessOwners }` beside `businessAvailable`.

- [ ] **Step 1: Failing tests**: `signedInLanding` table test (4 cases above); API: a login with a business and no page gets `managesBusiness: true` and `GET /v1/me/account` 200 with `hasProfile: false`; with the flag off `managesBusiness` is false.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(auth): a login's own account read and business landing after sign-in`

### Task D2: Applying with no page (parallel with D3)

**Files:**

- Modify: `packages/database/src/schema.ts` (`business_managers`: `shown_name text CHECK 1..60`, `verified_seen_at timestamptz`), `operations/business-manage.ts` (`applyForBusiness` :36, `listManagers` :277), `packages/contracts/src/business.ts` (`businessApplicationSchema` :149 gains optional `ownerName`), `apps/api/src/business/business-manage.controller.ts`
- Create: migration via drizzle-kit
- Test: `packages/database/test/integration/business-manage.test.mjs` (extend), `tests/integration/business-manage-api.test.mjs` (extend)

**Interfaces:**

- Produces: `applyForBusiness` works for a login with no profile (it never needed one; the test pins it) and writes `shown_name = input.ownerName ?? input.contactName` on the owner row; `listManagers` names a manager by page name, else `shown_name`, else "A TipMe user"; `POST /v1/me/businesses/:id/verified-seen` sets `verified_seen_at` (idempotent); `BusinessDetail.you` gains `celebrate?: true` when verified and unseen.

- [ ] **Step 1: Failing tests**: a code-confirmed login with no page applies and is the owner; its owner row has `shown_name`; `celebrate` is true once, false after `verified-seen`; the business-only owner never appears among staff or on a location's people list.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(business): apply with no personal page; owner names and the once-only celebration mark`

### Task D3: The sign-up fork and the four business steps

**Files:**

- Modify: `apps/web/src/app/sign-up/page.tsx`, `apps/web/src/app/sign-up/sign-up-flow.tsx`, `apps/web/src/app/page.tsx` (the quiet home line), `apps/web/src/app/for-businesses/create-business.tsx` (signed out → `/sign-up?for=business`)
- Create: `apps/web/src/app/sign-up/business-steps.tsx`, `apps/web/src/app/sign-up/fork.tsx`, `apps/web/src/lib/sign-up-path.ts`
- Test: `apps/web/test/sign-up-path.test.mjs`, `tests/e2e/business-signup.spec.ts` (lane 4)

**Interfaces:**

- Consumes: D1 `releaseFlags`, `MyAccount`; D2 apply; `EmailCodeForm`, `AuthProgress`, `suggestSlug`, `setupFieldErrors` (`apps/web/src/lib/business/setup-form.ts`), `applyForBusiness` in `apps/web/src/lib/business/setup-api.ts`.
- Produces: `signUpPath(search: string, hash: string): 'ask' | 'tipped' | 'business' | 'join'` (`?for=business` → business; `#join=` → join; the home claim's handle hint → tipped; none → ask).
- Steps: Get tipped = today's three (unchanged). For businesses = "Your email", "The code", "Your business" (Business name, Address on TipMe with `usetipme.xyz/b/<slug>`, Logo (optional) held per R17), "First location" (Contact for TipMe showing name field "Your name" + the confirmed email, "Only you and TipMe staff see this."; Location name, Location address on TipMe, Street address, Contact phone (optional)); "Send to TipMe" → `/dashboard/business?business=<id>`.
- Fork copy (board B): "What brings you to TipMe?" "Get tipped — Your own page and QR code. For anyone who gets thanked." "For businesses — A page and codes for your places. Tips reach your staff." "Invited to work somewhere? Open the link in your invitation instead." Lede: "Your page, in a minute. Or your business. Pick one now; you can add the other later on the same login." Home (R12): the claim field's button, the header's primary action and the band's link read **"Get tipped"** in place of "Claim your username" (`apps/web/src/components/marketing.tsx` `HomeClaim`, `components/nav-account.tsx` `GuestActions`, `app/page.tsx` band); the header also shows "For businesses" (`components/navigation.tsx` already links `/for-businesses`). Home line: "Signing up a business? Get one QR code for each place, and tips reach your staff. Start with your business →" linking `/sign-up?for=business`. All of it only with `businessSignup` on; off, today's page and today's "Claim your username" exactly. Update any e2e that clicks "Claim your username" to read the label for the flag state it runs with.
- A signed-in person choosing "For businesses" goes straight to "Your business". A `#join=` link skips the fork; a staff invitation still asks for a handle.

- [ ] **Step 1: Failing unit test** for `signUpPath` (5 cases).
- [ ] **Step 2: Failing e2e** (lane 4): signed out, home line → fork preselected "For businesses" → email, code (test mail sink), business, first location → lands on `/dashboard/business` showing "Waiting for TipMe to check your business." inside `main`; the person has no page (`/v1/me/profile` 404) and was never on `/sign-up` after the code (`page.on('framenavigated')` record). Also: the home page's "Get tipped" button (inside `main`) and the fork's "Get tipped" still run three steps to `/dashboard/welcome`. Unique slugs per run.
- [ ] **Step 3–4:** implement, green on `E2E_LANE=4`.
- [ ] **Step 5: Commit** `feat(web): sign-up fork and the four-step business path`

### Task D4: The dashboard for a login with no page

**Files:**

- Modify: `apps/web/src/app/dashboard/dashboard-shell.tsx` (:105-115 and the nav `links` :37), `apps/web/src/components/account/recipient-context.tsx`, `apps/web/src/app/dashboard/business/business-view.tsx`, `apps/web/src/app/dashboard/business/apply/apply-form.tsx` (read `useAccount()` not `useRecipient()`), `apps/web/src/app/dashboard/settings/settings-view.tsx` (account-only sections), `apps/web/src/app/dashboard/work/…` (manager invitations answerable with no page)
- Create: `apps/web/src/components/account/account-context.tsx`, `apps/web/src/components/business/own-page-card.tsx`, `apps/web/src/lib/account-only.ts`
- Test: `apps/web/test/account-only.test.mjs`, `tests/e2e/business-only-login.spec.ts` (lane 4)

**Interfaces:**

- Consumes: D1 `MyAccount`, roles.
- Produces:
  - `AccountContext` (`{ account: MyAccount; roles: MyBusinessRoles | null }`) provided for every dashboard page; `useAccount()`.
  - `accountOnlyRoute(pathname): string | null`: with no page, allowed paths are `/dashboard/business*`, `/dashboard/settings`, `/dashboard/help`, `/dashboard/whats-new`, `/dashboard/work` (manager invitations); anything else returns `/dashboard/business` (the replace target).
  - Shell: profile 404 → read `/v1/me/account` and roles; with `businessSignup` on and `manages.length > 0` (or an open manager invitation) render account-only mode (nav: Business, What’s new, Settings, Get help; personal links hidden, not greyed); otherwise `/sign-up` as today.
  - `OwnPageCard`: "Want tips yourself? Turn on your own page: a link and QR code in your name, on this same login. Customers who love your cooking can thank you directly." "Turn on your page" opens `HandleClaim` then `/dashboard/welcome` without signing in again; "Not now" hides it 90 days on this device (R18). Settings shows "Your own page" with the same button.
- [ ] **Step 1: Failing unit test** for `accountOnlyRoute`.
- [ ] **Step 2: Failing e2e**: **a business-only login opening /dashboard/tips lands on its business** (no `/sign-up` navigation, URL ends `/dashboard/business`), the nav has no "Tips" link inside `navigation "Dashboard"`; Settings shows email and sign-in sections; "Turn on your page" → handle → welcome, after which "Tips" appears; a manager invitation link opened by a login with no page is accepted from Work.
- [ ] **Step 3–4:** implement, green.
- [ ] **Step 5: Commit** `feat(web): a business-only login lands on its business, and can turn on a page`

### Task D5: Waiting, what happens next, and the verified moment (parallel with D6)

**Files:**

- Modify: `apps/web/src/app/dashboard/business/business-view.tsx`
- Create: `apps/web/src/components/business/waiting-steps.tsx`, `apps/web/src/components/business/verified-moment.tsx`
- Test: `tests/e2e/business-verified.spec.ts` (lane 4)

Copy (board section 3): "Waiting for TipMe to check your business." "Thanks, {first name}. TipMe staff check {business}’s name, address and contact. We’ll email you at {email} as soon as it’s done." Steps: "Sent to TipMe / {date}", "TipMe checks your details / We may email you a question.", "Your codes go live / Print one for {location}.", "Invite your staff / Each gets their own page. Up to {free staff limit} on Business Free." (limit from `businessLimits('free')`; the clause is shown only with `businessPro` on). "While you wait" per R16. Verified (only when `you.celebrate`): "Verified by TipMe", "{business} is live.", "Your {location} code is ready. Put it where customers pay, then invite your staff." Buttons "Print your {location} code", "Invite staff"; then `POST …/verified-seen`. Hearts settle; with reduced motion no motion, same text. Declined: today's calm note.

- [ ] **Step 1: Failing e2e**: after `business.verify` runs (ops helper), the owner's first visit shows the moment inside `main`, a reload doesn't; reduced motion has no animation (`page.emulateMedia({ reducedMotion: 'reduce' })`, computed `animation-name: none`).
- [ ] **Step 2–4:** implement, green.
- [ ] **Step 5: Commit** `feat(web): what happens next while waiting, and the once-only verified moment`

### Task D6: The account-menu switcher

**Files:**

- Create: `apps/web/src/components/dashboard/hat-switcher.tsx`, `apps/web/src/lib/hats.ts`
- Modify: `dashboard-shell.tsx` (the top-right button replaces Sign out's spot; Sign out moves into the menu), `apps/web/src/components/nav-account.tsx` ("Business" stays for the marketing header)
- Test: `apps/web/test/hats.test.mjs`, `tests/e2e/hat-switcher.spec.ts` (lane 4)

**Interfaces:**

- Produces: `type Hat = { kind: 'page'; handle: string } | { kind: 'owner' | 'manager'; businessId: string; name: string; status: BusinessStatus; plan?: 'free' | 'pro' } | { kind: 'work'; memberId: string; businessName: string; locationName: string }`; `hatsOf(account: MyAccount, roles: MyBusinessRoles | null): Hat[]` ordered YOU, BUSINESSES YOU OWN, (managed), WHERE I WORK; `hatHref(hat): string` (`/dashboard`, `/dashboard/business?business=<id>`, `/dashboard/work`); last hat kept per device (R18). `MyBusinessRoles.manages[]` gains `plan?` (with `businessPro` on).
- Menu: groups "YOU", "BUSINESSES YOU OWN", "BUSINESSES YOU MANAGE", "WHERE I WORK"; "Add a business +", "Settings", "Sign out"; "Turn on your page" for a login with no page; one hat → the button reads their name and the menu is as short as today. A pending business shows "Pending". Phone: a sheet from the top button. Keyboard: menu button pattern (arrow keys, Escape returns focus).

- [ ] **Step 1: Failing unit test** for `hatsOf` (the board's Tunde, Ngozi and Ada cases).
- [ ] **Step 2: Failing e2e**: a login with a page and an owned business switches to the business from the menu and back; keyboard-only works; axe passes (`expectAccessible`).
- [ ] **Step 3–4:** implement, green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): sign up a business with no page, and switch hats (behind BUSINESS_SIGNUP_ENABLED)`.

---

## Phase E: owners, co-owners and handover (`BUSINESS_OWNERS_ENABLED`)

### Task E1: The owner cap, owner emails, and leaving

**Files:**

- Modify: `operations/business-invitations.ts` (owner invitations), `operations/business-manage.ts` (`removeManager` :321), `operations/business-members.ts` (`endBusinessRolesForDeletion` :260, unchanged rule, new copy), `apps/api/src/http/api-exception.filter.ts`, `packages/mail/src/templates/types/` (new `business-owners.ts`)
- Test: `packages/database/test/integration/business-owners.test.mjs`

**Interfaces:**

- Produces: with `opts.ownersCap` (API passes `config.BUSINESS_OWNERS_ENABLED`): inviting an owner refused `BUSINESS_OWNER_LIMIT` when open owners + open owner invitations ≥ `BUSINESS_OWNER_LIMIT`; accepting refused when open owners ≥ 3 (invitation stays open); a person with no page may accept an owner or manager invitation (they give `shownName`, ruling R13); `POST /v1/me/businesses/:id/owners/leave` removes yourself at once, unless you're the last owner or the **founding owner** (`businesses.created_by`, the applicant TipMe verified), who leaves only through a handover. With the flag on, `removeManager` on another **owner** answers `OWNER_REMOVAL_NEEDS_REQUEST` (409) and points to Task E4; removing a location manager is unchanged. This replaces the interim block from `fix/owner-removal-lock` (with the flag off that block stays). New append-only `business_owner_events (id, business_id, kind, actor_user_id, subject_user_id null, request_id null, detail text null, created_at)` records every owner change, invitation, removal step and handover step; the Owners section lists it. Every owner added or removed enqueues `business_owner_changed` to every open owner and the removed person (`{ businessName, who, change: 'added' | 'removed', by }`). Copy for `BUSINESS_LAST_OWNER` (all three places): "You’re the last owner of {business}. A business always needs an owner, so you can’t leave yet. Hand it over to someone first, or add a co-owner." with actions per R15.
- [ ] **Step 1: Failing tests**: a 4th owner invitation refused; the third owner accepting is fine, a 4th refused; a pageless person accepts an owner invitation; the last owner can't leave, delete their login, or be removed; the founding owner can't leave by themselves; **an owner removing another owner directly is refused `OWNER_REMOVAL_NEEDS_REQUEST`**; every owner gets the change email and an event row; flag off → no cap and the interim block still refuses owner-removes-owner.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(business): up to 3 owners, owner-change emails, and the last owner stays`

### Task E2: Handover requests and the new owner's confirmation

**Files:**

- Modify: `packages/database/src/schema.ts` (new `business_handovers`), `packages/contracts/src/ops.ts` (`ISSUE_KINDS` + `business_handover`)
- Create: migration via drizzle-kit, `packages/database/src/operations/business-handovers.ts`, `apps/api/src/business/business-owners.controller.ts`
- Test: `packages/database/test/integration/business-handovers.test.mjs`, `tests/integration/business-owners-api.test.mjs`

**Interfaces:**

- Produces:
  - `business_handovers (id PK, business_id, from_user_id, to_user_id null, to_email_lower null, remove_requester boolean, reason text 10..500, status 'waiting_new_owner'|'waiting_tipme'|'approved'|'declined'|'cancelled'|'expired', code_sha256 null, confirmed_at, decided_by, decided_at, decline_reason, created_at, expires_at)`; one open per business (partial unique on status in the two waiting states); check exactly one of `to_user_id` / `to_email_lower` until confirmed.
  - `askHandover(db, sealing, userId, businessId, { to: { managerId } | { email }, removeMe: boolean, reason }, now)`; `confirmHandover(db, userId, { code } | { handoverId }, now)` (the new owner, signed in with the invited email or as the co-owner) → `waiting_tipme` and opens issue `business_handover`; `cancelHandover(db, userId, businessId, handoverId, now)` (any owner, before approval); `handoverFacts(db, handoverId)` for ops: business, from, to, reason, business balance, open withdrawals, both emails confirmed, open issues on the business, new login age in days (`flagNewLogin: days < 7`).
  - Routes under `/v1/me/businesses/:id/handovers` (owners) and `/v1/me/handovers/confirm`; 404 with the flag off.
  - `ownershipLock(tx, businessId): Promise<{ kind: 'handover' | 'removal'; requestId: string; requestedBy: string; subject: string | null } | null>` in `business-handovers.ts`: the one open handover or owner removal (Task E4). While it is set: `askHandover` refuses `OWNERSHIP_CHANGE_PENDING`; `setPayoutDestination` for the business (and its code step) refuses `OWNERSHIP_CHANGE_PENDING`; withdrawals are untouched.
- [ ] **Step 1: Failing tests**: nothing changes on ask or confirm (owners, payout account, tips); the invited email must match a proven login; a second open handover is refused; a handover while a removal is pending is refused; **a payout-destination change while a handover is pending is refused, and a withdrawal still goes through**; cancel works only before approval; expiry after 7 days.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(business): ask to hand a business over, and the new owner confirms`

### Task E3: TipMe approval, never one admin alone

**Files:**

- Modify: `packages/database/src/operations/serious-actions.ts` (new `neverAlone?: true` on `SeriousActionDefinition` :116; the alone path :518), `serious-actions-registered.ts`, `packages/contracts/src/ops-catalogue.ts`, `apps/web/src/app/ops/approvals/page.tsx` (handover card)
- Test: `tests/integration/ops-serious-actions.test.mjs` (extend), `tests/integration/business-handover-approval.test.mjs`, `tests/e2e/ops-handover.spec.ts` (lane 5)

**Interfaces:**

- Produces: `neverAlone?: true`: with no qualified second person the request **waits** (never `serious_action.ran_alone`), even for an admin. Serious action `business.handover` (permission `businesses.manage`, `neverAlone: true`, subjects = the business's open managers + the new owner, target = business id, pinned on `{ status, ownersHash }`, describe "Hand over {business} from {from} to {to}. {from} stays an owner." / "…is removed as an owner."). Run: re-checks facts; adds the new owner if not one (cap 3 applies, `BUSINESS_OWNER_LIMIT` makes it stale); removes the requester if asked and another owner remains; sets `approved`; mails every owner before and after; payout destination untouched. Declining (staff reason) sets `declined` and mails the owners with the reason.
- Also produces serious action `business.owner_remove` (used by Task E4): permission `businesses.manage`, `neverAlone: true`, subjects = the business's open managers, target = business id, pinned on the removal's status and the owners; run removes the co-owner if they're still an owner and another owner remains.
- [ ] **Step 1: Failing tests**: **a lone admin can't run a handover alone** (request stays pending); the requester staff member can't approve their own request; an owner of the business who is staff can't decide; approval adds and removes owners exactly as asked; the payout destination is unchanged; a decline mails the reason.
- [ ] **Step 2–4:** red, implement, green; e2e: two staff, one asks with a code, the other approves with their own code inside the Approvals card ("Approve and run").
- [ ] **Step 5: Commit** `feat(ops): business handovers need a second TipMe staff member, never one alone`

### Task E4: Removing a co-owner, never instant (owner, 14 Nov 2026)

**Files:**

- Modify: `packages/database/src/schema.ts` (new `business_owner_removals`; `email_codes_purpose` adds `owner_removal`), `packages/contracts/src/ops.ts` (`ISSUE_KINDS` + `business_owner_removal`), `operations/business-handovers.ts` (`ownershipLock` sees removals), `apps/worker/src/job-worker.ts` (a daily sweep), `packages/mail/src/templates/types/business-owners.ts`
- Create: migration via drizzle-kit, `packages/database/src/operations/business-owner-removals.ts`, routes in `apps/api/src/business/business-owners.controller.ts`
- Test: `packages/database/test/integration/business-owner-removals.test.mjs`, `tests/integration/business-owner-removal-api.test.mjs`

**Interfaces:**

- Consumes: E1 `business_owner_events`, E2 `ownershipLock`, E3 `neverAlone` and `business.owner_remove`.
- Produces:
  - `business_owner_removals (id PK, business_id, requested_by → users, subject_user_id → users, reason text 10..500, status 'waiting_owner'|'waiting_tipme'|'removed'|'kept'|'cancelled', answer 'agreed'|'objected'|'no_answer' null, answered_at, sent_to_tipme_at, decided_by, decided_at, decision_reason, created_at, answer_by timestamptz NOT NULL)`; one open per business across removals and handovers (`ownershipLock`).
  - The seven steps, one function each:
    1. `askOwnerRemoval(db, sealing, userId, businessId, { managerId, reason }, now)`: needs a **fresh emailed code**, exactly as a payout-destination change does (`requestPayoutDestinationCode` / `spendPayoutDestinationCode` in `operations/payout-destinations.ts`, with a new purpose `owner_removal`): `POST /v1/me/businesses/:id/owner-removals/code` sends it, the ask carries `emailCode`, and a wrong or spent code is refused `CODE_INVALID` with nothing written; refuses `OWNERSHIP_CHANGE_PENDING`, `BUSINESS_LAST_OWNER`, and `NOT_A_MANAGER` for a non-owner target. `answer_by = now + 7 days`.
    2. The same transaction mails the co-owner (`business_owner_removal_asked`) and adds an in-app notification; every owner gets `business_owner_changed` with `change: 'removal_asked'`. Nothing else changes.
    3. `answerOwnerRemoval(db, userId, removalId, { answer: 'agree' | 'object' }, now)` by the subject only: `agree` removes them at once (`removed`) **unless they are the founding owner**, whose agreement still goes to TipMe (step 6); `object` moves to `waiting_tipme`.
    4. `sweepOwnerRemovals(db, now)` (worker, daily): unanswered past `answer_by` → `answer = 'no_answer'`, `waiting_tipme`. Entering `waiting_tipme` opens issue `business_owner_removal`; staff decide with `business.owner_remove` (two staff, never one alone); the issue shows both owners' masked emails behind the usual reveal so staff can contact them. Declining sets `kept` with the staff reason.
    5. While open: `askHandover` and the business's payout-destination change refuse `OWNERSHIP_CHANGE_PENDING`; the subject asking to remove the requester is refused by the same lock; withdrawals carry on.
    6. Founding owner: a removal whose subject is `businesses.created_by` always ends in `waiting_tipme`, whatever the subject answers.
    7. Every step writes a `business_owner_events` row and mails every open owner (and the subject).
  - `cancelOwnerRemoval(db, userId, businessId, removalId, now)`: the requester, before a decision.
  - Routes: `POST /v1/me/businesses/:id/owner-removals`, `POST /v1/me/owner-removals/:removalId/answer`, `POST /v1/me/businesses/:id/owner-removals/:removalId/cancel`; 404 with the flag off.

- [ ] **Step 1: Failing tests**

```js
test('asking changes nothing and tells the co-owner at once', async () => {
  /* still an owner; mail + notification to subject; event row */
});
test('the co-owner agrees and is removed; every owner is emailed', async () => {});
test('an objection goes to TipMe and two staff decide', async () => {
  /* waiting_tipme; one admin alone: still pending; second staff approves → removed */
});
test('no answer in 7 days goes to TipMe', async () => {
  /* sweep at answer_by + 1 min */
});
test('the founding owner is removed only with TipMe approval, even if they agree', async () => {});
test("while a removal is open: no handover, no payout-destination change, the subject can't remove the requester; a withdrawal still goes through", async () => {});
test('asking needs a fresh emailed code', async () => {
  /* no or spent code → CODE_INVALID, no row */
});
```

- [ ] **Step 2: Run to fail**: `node --test packages/database/test/integration/business-owner-removals.test.mjs` → FAIL (`askOwnerRemoval is not a function`)
- [ ] **Step 3: Implement** the interfaces; the business row lock is taken first in every step, so an answer and the sweep can't both act.
- [ ] **Step 4: Run to pass** (with E1 to E3's files and `business-payouts.test.mjs`) → PASS
- [ ] **Step 5: Commit** `feat(business): removing a co-owner needs their answer or TipMe's decision`

### Task E5: The Owners section

**Files:**

- Create: `apps/web/src/app/dashboard/business/sections/owners.tsx`, `apps/web/src/lib/business/owners-api.ts`
- Modify: `sections.ts` (add `{ id: 'owners', title: 'Owners', Card: OwnersSection, needs: 'owner' }` before `plan`), `sections/managers.tsx` (owner rows move to Owners when the flag is on)
- Test: `tests/e2e/business-owners.spec.ts` (lane 5)

Board section 6: Add a co-owner (email; "A co-owner can do everything you can: see the money, withdraw, change the share of tips, add and remove people, and hand the business over."; pending list "Invited today · link works for 7 days", "Send again · Cancel invitation"); owners list ("Owner since {date}"); Hand over ownership (to an existing co-owner or someone new by email, "Remove me as an owner once it’s done", "Why (for TipMe)"; the three states "You asked", "{name} confirmed", "Waiting for TipMe to approve. Nothing changes until then. Tips, codes and withdrawals carry on as normal.", "Cancel the handover"; done line); the last-owner copy from E1; Remove a co-owner (Task E4's states, below); and the owner log from `business_owner_events`.

Removal copy: ask — "Ask to remove {name} as an owner", "Why (shown to {name} and TipMe)", "Nothing changes yet. {name} is told now and can agree or object. If they object, or don't answer in 7 days, TipMe decides."; the co-owner's card — "{requester} asked to remove you as an owner of {business}. Their reason: “{reason}”. Nothing has changed yet." buttons "Agree and leave", "Object"; waiting — "Waiting for TipMe to decide. Nothing changes until then. Tips, codes and withdrawals carry on as normal."

- [ ] **Step 1: Failing e2e**: owner invites a co-owner with no page, who signs in through the link and lands on the business; the owner then asks to hand over with "Remove me", the co-owner confirms, two staff approve (helpers), and the old owner's switcher no longer lists the business while their own page is unchanged. A second test: an owner asks to remove a co-owner, the co-owner sees the request card inside `main` and objects, and the business shows "Waiting for TipMe to decide" to both. `afterEach` removes extra owners and cancels open requests.
- [ ] **Step 2–4:** implement, green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): co-owners, checked owner removal and handovers with TipMe approval (behind BUSINESS_OWNERS_ENABLED)`.

---

## Phase F: closing a business (`BUSINESS_CLOSE_ENABLED`, after E)

Same spirit as owner removal (owner, 14 Nov 2026): all owners agree, or TipMe staff approve. Grounding: `businesses.status` allows only `pending|verified|suspended` (`schema.ts:2294`); public reads require `status = 'verified'` (`operations/business-public.ts:94,173`), so a closed business's codes stop by the same rule a suspended one's do; `endShareAgreements` (`share-agreements.ts:636`) and `endMembership` (`business-members.ts`) already end shares and memberships; `businessBalanceIn` (`balance.ts:70`) gives the balance.

### Task F1: Asking to close, and the owners' answers

**Files:**

- Modify: `packages/database/src/schema.ts` (`businesses`: status adds `closed`, `closed_at`, `closed_reason`; checks `businesses_status`, `businesses_verified` becomes `status IN ('pending','closed') OR verified_at IS NOT NULL`; `business_members_left` adds `business_closed`; `email_codes_purpose` adds `business_close`; new `business_closures`, `business_closure_answers`), `packages/contracts/src/ops.ts` (`ISSUE_KINDS` + `business_closure`), `operations/business-handovers.ts` (`ownershipLock` sees an open closure)
- Create: migration via drizzle-kit, `packages/database/src/operations/business-closures.ts`, routes in `apps/api/src/business/business-owners.controller.ts`
- Test: `packages/database/test/integration/business-closures.test.mjs`

**Interfaces:**

- Produces: `business_closures (id PK, business_id, requested_by, reason 10..500, status 'waiting_owners'|'waiting_tipme'|'closed'|'cancelled'|'declined', answer_by, sent_to_tipme_at, decided_by, decided_at, decision_reason, created_at)`, `business_closure_answers (closure_id, user_id, answer 'agree'|'object', answered_at, PK (closure_id, user_id))`; `askBusinessClosure(db, sealing, userId, businessId, { reason, emailCode }, now)` (owners; fresh emailed code, purpose `business_close`; refuses `OWNERSHIP_CHANGE_PENDING` and `BUSINESS_BALANCE_NOT_EMPTY` when `businessBalanceIn` ≠ 0 or a withdrawal is `REQUESTED|PROCESSING`; the asker counts as agreeing); `answerBusinessClosure(db, userId, closureId, { answer }, now)` (each other open owner); when every open owner has agreed → `closeBusinessNow` (Task F2) in the same transaction; any objection, or `answer_by` (7 days) passing (`sweepBusinessClosures`), → `waiting_tipme` and issue `business_closure`; `cancelBusinessClosure` by the asker. Every step writes `business_owner_events` and mails every owner. While open, `ownershipLock` blocks handovers, removals and payout-destination changes; withdrawals carry on (the balance must reach zero).
- [ ] **Step 1: Failing tests**: a sole owner's ask (with the code) closes at once; with two owners nothing changes until the second agrees; an objection or 7 days sends it to TipMe; a non-zero or negative balance refuses (`BUSINESS_BALANCE_NOT_EMPTY`), and a withdrawal during an open closure still works; a pending removal or handover refuses the ask.
- [ ] **Step 2–4:** red (`node --test packages/database/test/integration/business-closures.test.mjs`), implement, green.
- [ ] **Step 5: Commit** `feat(business): ask to close a business; all owners agree or TipMe decides`

### Task F2: What closing does, and TipMe's decision

**Files:**

- Modify: `operations/business-closures.ts`, `serious-actions-registered.ts` (`business.close`), `packages/contracts/src/ops-catalogue.ts`, `operations/business-roles.ts` (closed businesses listed read-only), `operations/pro-auto-renew.ts` / `business_pro_auto_renew`
- Test: `packages/database/test/integration/business-close-effects.test.mjs`, `tests/integration/business-close-approval.test.mjs`

**Interfaces:**

- Produces: `closeBusinessNow(tx, { businessId, closureId, actorUserId | staffUserId, now })`: re-checks the balance under the business lock; sets `status = 'closed'`, `closed_at`, `closed_reason`; ends every open membership (`left_by = 'business_closed'`) and shift, every share agreement (`endShareAgreements`), revokes open invitations, keeps manager rows open as read-only (owners still read past statements and history); turns Business Pro auto-renew off (the paid month runs out; no refund unless staff use `pro.refund`); revalidates `/b/<slug>`. Nothing is deleted; the slug is never reused. Staff codes fall back to each person's own page (today's `StaffPageRedirect`). Serious action `business.close` (permission `businesses.manage`, `neverAlone: true`, subjects = open managers) runs it; declining sets `declined`.
- [ ] **Step 1: Failing tests**: after closing, `/v1/b/<slug>` and its location and staff pages are not found, a staff code redirects to the person's page, a tip intent naming the old membership is accepted without the label; members and shares are ended; owners can still download past statements; `business.close` is never run alone.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(business): closing stops the codes and keeps the history`

### Task F3: Closing on screen

**Files:**

- Modify: `apps/web/src/app/dashboard/business/sections/details.tsx` ("Close the business", owners), `sections/owners.tsx` (the closure's state), E1's last-owner copy (offers "Close the business" in place of "Ask TipMe to close it"), the switcher (`hatsOf` shows "Closed")
- Test: `tests/e2e/business-close.spec.ts` (lane 6)

Copy: "Close {business}? Its codes stop working and your staff are taken off its team. Your history and statements are kept. Withdraw the business balance first." With other owners: "{n} other owners must agree. If anyone objects, or doesn't answer in 7 days, TipMe decides." Closed: "{business} is closed. Its history and statements are kept."

- [ ] **Step 1: Failing e2e**: a sole owner with a zero balance closes their own test business with the emailed code; `/b/<slug>` shows not found inside `main`; the switcher shows "Closed". Each test uses its own business.
- [ ] **Step 2–4:** implement, green on `E2E_LANE=6`.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): closing a business, agreed by all owners or TipMe (behind BUSINESS_CLOSE_ENABLED)`.

---

## Phase G: turning off your own page (`PAGE_TURN_OFF_ENABLED`, after D)

Grounding: `profiles.page_state` is `live|not_live|deleted` (`schema.ts:525,598`); `setPageState` (`operations/profiles.ts:693`) switches live and not live; deleting an account erases the page and puts the handle in a 90-day `handle_holds` row (`profiles.ts:1035-1190`, `HANDLE_HOLD_MS`). The board (section 8) holds a turned-off handle for **12 months** for the same login.

### Task G1: Turning a page off and back on

**Files:**

- Modify: `packages/database/src/schema.ts` (`profiles_page_state` adds `off`; `profiles.off_until timestamptz`; `business_members_left` adds `page_off`), `operations/profiles.ts` (extract the page half of `deleteAccount` into `erasePage(tx, profileId, now)`, no behaviour change), `apps/api/src/profiles/me-profile.controller.ts`, `apps/worker/src/job-worker.ts`
- Create: migration via drizzle-kit, `packages/database/src/operations/page-turn-off.ts`
- Test: `packages/database/test/integration/page-turn-off.test.mjs`, `tests/integration/page-turn-off-api.test.mjs`

**Interfaces:**

- Produces: `turnOffMyPage(db, userId, now): Promise<{ offUntil: Date }>`: only for a login that owns or manages a business (others delete their account, as today), else `PAGE_TURN_OFF_NOT_ALLOWED`; refuses `BALANCE_NOT_EMPTY` while the person's balance (available or confirming) isn't zero or a withdrawal is in flight; ends their memberships (`left_by = 'page_off'`) and shifts; turns personal Pro auto-renew off; sets `page_state = 'off'`, `off_until = now + 365 days`. `turnOnMyPage(db, userId, now)` before `off_until` → `not_live` with the same handle. `releaseTurnedOffPages(db, now)` (worker, daily): past `off_until` → `erasePage` (handle into the usual 90-day hold), login and businesses kept. Routes `POST /v1/me/page/off`, `POST /v1/me/page/on`. `GET /v1/me/profile` keeps answering for an `off` page (with `pageState: 'off'`, `offUntil`), so the shell can offer "Turn your page back on".
- [ ] **Step 1: Failing tests**: refused without a business; refused with money left; memberships end with `page_off`; the public page and tips refuse; turning on within 12 months keeps the handle; after 12 months the page is erased and the handle is held 90 days; nobody else can claim the handle while it's off.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(pages): turn off your own page while running a business; the handle is kept 12 months`

### Task G2: Turning off on screen

**Files:**

- Modify: `apps/web/src/app/dashboard/settings/sections/my-page.tsx` ("Your own page" → "Turn off your page"), D4's `accountOnlyRoute` (an `off` page is account-only), D6's `hatsOf` ("Turn your page back on")
- Test: `tests/e2e/page-turn-off.spec.ts` (lane 7)

Copy (board section 8): "Turn off @{handle}? Your page goes offline and people can’t tip you. {business} keeps running; you stay its owner. Your past tips and statements are kept, and you can turn it back on with the same handle within 12 months." Buttons "Turn off my page", "Keep it". With money: "Withdraw your own balance first. You have ₦{amount} on your page. Your business’s money is separate and stays." When also staff: "You work at {business}. Without a page you can’t receive tips there, so you’ll be taken off its staff."

- [ ] **Step 1: Failing e2e**: an owner with a zero balance turns their page off, lands on their business, `/@handle` shows the unavailable page inside `main`, then turns it back on from the switcher.
- [ ] **Step 2–4:** implement, green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(pages): turn off your own page while running a business (behind PAGE_TURN_OFF_ENABLED)`.

---

## Phase H: custom limits for big businesses (`BUSINESS_CUSTOM_LIMITS`, after A)

"Talk to us" made real. Grounding: limits come only from `businessLimits(plan)` (Task A2) through `businessUsage` (Task A4); support requests have topics checked in the database (`support_requests_topic`, `schema.ts`; `SUPPORT_TOPICS` in `packages/contracts/src/support.ts:6`).

### Task H1: Staff set a business's limits

**Files:**

- Modify: `packages/database/src/schema.ts` (new `business_limit_overrides`; `support_requests_topic` adds `business`), `packages/contracts/src/support.ts`, `packages/domain/src/business-plan.ts`, `operations/business-limits.ts`, `serious-actions-registered.ts`, `packages/contracts/src/ops-catalogue.ts`
- Create: migration via drizzle-kit
- Test: `packages/database/test/integration/business-limit-overrides.test.mjs`, `packages/domain/test/business-plan.test.mjs` (extend)

**Interfaces:**

- Produces: `business_limit_overrides (business_id PK, staff_limit int null CHECK 26..1000, locations_limit int null CHECK 26..1000, reason, set_by, approved_by null, updated_at)` with at least one limit set; `businessLimits(plan, override?: { staff?: number; locations?: number })` applies the override **only on `pro`** (a lapsed business falls back to Free; the override is kept for renewal); serious action `business.limits` (permission `businesses.manage`, a second person approves, a lone admin acts alone with the alert, as `pro_price.change`; subjects = the business's managers; describe "Let {business} have up to {n} staff and {m} locations on Business Pro"); audit `business.limits_changed`.
- [ ] **Step 1: Failing tests**: a Pro business with an override of 60 staff invites the 26th; on lapse it's back to 3; removing the override returns it to 25 without removing anyone; a business manager who is staff can't decide.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(ops): custom staff and location limits for big businesses`

### Task H2: "Talk to us" and the ops screen

**Files:**

- Modify: B3's limit moment ("Talk to us" opens Get help with topic `business`), `apps/web/src/app/dashboard/help/…` (the `business` topic), ops business detail (limits card with the request form), `operations/support.ts` (topic words)
- Test: `tests/e2e/business-custom-limits.spec.ts` (lane 8)

- [ ] **Step 1: Failing e2e**: a Pro test business at 25 staff sends "Talk to us"; ops sees the request as topic Business, sets 40 staff (two staff, helpers), and the owner's People card then reads "25 of 40". `afterEach` ends members and removes the override.
- [ ] **Step 2–4:** implement, green.
- [ ] **Step 5: Commit, then the PR wrap-up.** PR title: `feat(business): custom limits above 25, set by TipMe staff (behind BUSINESS_CUSTOM_LIMITS)`.

---

## Phase I: the rest of the proposed Business Pro features

Each task is its own PR behind its own flag (on top of `BUSINESS_PRO_ENABLED`), Pro businesses only, paused on lapse with data kept (R8). Each ends with the PR wrap-up.

| Task | Feature                           | Flag                                 | Depends on                                                                                                                                                  | Reuses                                                                                   | Lane         |
| ---- | --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| I1   | Staff shout-out board             | `BUSINESS_SHOUT_OUTS`                | C (notes)                                                                                                                                                   | `business_notes` tags                                                                    | 5            |
| I2   | Payroll-friendly export           | `BUSINESS_STAFF_AMOUNTS` (stays off) | C3/C4                                                                                                                                                       | C4 exports, payout destinations                                                          | 6            |
| I3   | Business Pro badge                | `BUSINESS_PRO_BADGE`                 | A                                                                                                                                                           | personal Pro badge style                                                                 | 3            |
| I4   | Custom thank-you for the business | `BUSINESS_THANKS`                    | Pro features plan Phase C                                                                                                                                   | its thank-you model and receipt                                                          | 7            |
| I5   | Team tip goals                    | `BUSINESS_TEAM_GOALS`                | Pro features plan Phase B; `TEAM_TIPS_ENABLED`                                                                                                              | its goals model and "tips toward" copy rules                                             | 8            |
| I6   | Per-location tip amounts          | `BUSINESS_LOCATION_AMOUNTS`          | C6 (`business_location_details`)                                                                                                                            | `tipAmountsSchema` (`contracts/src/profiles.ts:214`)                                     | 5 (after I1) |
| I7   | Priority support                  | `BUSINESS_PRIORITY_SUPPORT`          | A; H1's `business` topic (or add it here, whichever lands first)                                                                                            | personal priority support already on dev (`operations/support.ts:37`)                    | 3 (after I3) |
| I8   | Early access                      | `BUSINESS_EARLY_ACCESS`              | personal early access (`feat/early-access`, not built and **not in the Pro features plan**: `earlyAccessOf` in `operations/whats-new.ts:40` is a hook only) | changelog audience `early_access`                                                        | 4            |
| I9   | Staff grants of Business Pro      | `BUSINESS_PRO_GRANTS`                | A3                                                                                                                                                          | the `pages.plan` grant route (`apps/api/src/ops/pages.controller.ts:113`), `setStaffPro` | 8 (after H)  |

### Task I1: Staff shout-out board

- **Files:** schema (`business_members.shout_out` boolean default false; new `business_shout_outs (business_id, month, member_id, PK all three)`), `operations/business-shout-outs.ts`, worker monthly job (after C3's), Work page toggle, dashboard card, `/b/[business]` block; tests `business-shout-outs.test.mjs`, `tests/e2e/business-shout-outs.spec.ts`.
- **Interfaces:** `runBusinessShoutOuts(db, { month, now })`: per location, opted-in members with at least 3 notes that month; `BusinessShoutOuts { month; people: { shownName; locationName; topTag?: BusinessNoteTag }[] }`, **alphabetical, no counts, no amounts, never a ranking**. Copy: "This month’s shout-outs: staff customers mentioned. Staff choose whether to be included."
- [ ] Tests first: a member who hasn't opted in never appears; the list is alphabetical whatever the counts; nothing appears for fewer than 3 notes; a free or lapsed business shows none. Then implement, green, commit `feat(business): opt-in monthly staff shout-outs`.

### Task I2: Payroll-friendly export (built dark)

- **Files:** `operations/business-payroll.ts`, a route beside C4's exports, schema `business_members.share_payroll` boolean default false (staff consent on the Work page); tests `business-payroll.test.mjs`.
- **Interfaces:** `GET /v1/me/businesses/:id/exports/payroll?month&format=csv|xlsx`: one row per staff member per month (name, location, tips, received, bank name, account name, account number masked to the last 4 from their payout destination), in the board's column order; only members with `share_payroll`; **404 unless `BUSINESS_STAFF_AMOUNTS` is on, which stays off** (owner's R7).
- [ ] Tests first: flag off → 404; flag on → only consenting staff, account numbers never more than 4 digits (`/\d{5,}/` absent). Then implement, green, commit `feat(business): payroll export, off until staff amounts are wanted`.

### Task I3: The Business Pro badge

- **Files:** `operations/business-public.ts` (`PublicBusiness.business.pro?: true` while Pro), `/b/[business]` header, `packages/ui` badge variant; test `tests/e2e/business-pro-badge.spec.ts`.
- Copy: a "Business Pro" pill in the Pro badge's style, never worded or styled like "Verified business".
- [ ] Tests first: the pill shows inside the business header for a Pro business and not after lapse; its accessible name is "Business Pro". Implement, green, commit `feat(business): the Business Pro badge`.

### Task I4: The business's own thank-you

- **Needs:** the Pro features plan's Phase C (Tasks 14 to 17) on dev; reuse its thank-you validation and receipt slot, don't add another.
- **Files:** `business_brands.thanks_line` (≤ 140 chars, cleaned like `cleanThanksLine` in `packages/contracts/src/thanks.ts`), the brand route (C6), the receipt (`apps/web/src/app/tip/[tipId]/status-view.tsx`) and the `/b/` page.
- **Rule:** on a tip through the business, the receipt shows the staff member's own thank-you first (it is their tip) and the business's line under it.
- [ ] Tests first: the line shows on the business page and on a business-path receipt, below the person's own; a lapsed business's line is hidden and kept. Implement, green, commit `feat(business): the business's own thank-you line`.

### Task I5: Team tip goals

- **Needs:** the Pro features plan's Phase B (Tasks 9 to 12) on dev, and `TEAM_TIPS_ENABLED` on. Reuse its goals table with a business-location owner, rather than a second goals model; if its table can't take a location owner, this task adds the owner column there.
- **Interfaces:** a goal on a location's team tip: "Tips toward {purpose}", a target in naira, progress from that location's team tips only.
- **Copy rule (board):** "tips toward" something for the team; never "fundraising", "donation" or "donate" (a test greps the rendered copy).
- [ ] Tests first: progress counts team tips only, never individual tips; the copy check passes; a lapsed business hides the goal and keeps it. Implement, green, commit `feat(business): team tip goals`.

### Task I6: Tip amounts per location

- **Files:** `business_location_details.tip_amounts` (C6's table), `tipAmountsSchema` reuse, `operations/business-public.ts` (`publicStaffTipPage` offers the location's amounts), the location details form.
- **Rule:** on a tip through that location, the location's presets replace the person's; any preset below that staff member's own minimum is left out for them; the quote still checks the amount as today.
- [ ] Tests first: a location with ₦500 and ₦2,000 shows both for a Free staff member, and only ₦2,000 for a Pro staff member whose minimum is ₦2,000; a lapsed business falls back to each person's own amounts. Implement, green, commit `feat(business): suggested tip amounts per location`.

### Task I7: Priority support

- **Files:** `operations/support.ts:37` (priority when the page is Pro **or** the requester is an open owner or manager of a Pro business), the `business` topic (H1, or here if first).
- [ ] Tests first: an owner of a Pro business with a Free page is priority; after lapse they aren't. Implement, green, commit `feat(support): Business Pro requests are answered first`.

### Task I8: Early access

- **Needs:** personal early access (`profiles.early_access`, the `feat/early-access` hook in `operations/whats-new.ts:38-42`). Neither dev nor the Pro features plan builds it yet; build this task after it, or build both halves here if the owner asks.
- **Files:** `businesses.early_access` boolean default true (opt-out on the Plan section), `operations/whats-new.ts` (a reader is early access if their page has it **or** they own or manage a Pro business with it on), `packages/contracts/src/changelog.ts:168` (`who`).
- [ ] Tests first: an owner of a Pro business sees `early_access` entries; opting out hides them; lapse hides them. Implement, green, commit `feat(business): early access for Business Pro, with an opt-out`.

### Task I9: Staff grants of Business Pro

- **Files:** schema `businesses.staff_pro` boolean default false; `recomputeBusinessPlan` (A3) = `staff_pro` OR a paid month; `POST /v1/ops/businesses/:id/plan` mirroring `pages.plan` (`FreshCode`, permission `businesses.manage`, a written reason, audit `business.plan_changed`); the ops business detail.
- [ ] Tests first: granting makes the business Pro with no purchase and no owner's personal Pro; removing the grant keeps a paid month's Pro; ops detail says "Given by TipMe staff" vs "Paid". Implement, green, commit `feat(ops): staff can give a business Business Pro`.

---

## Self-review (done against both boards)

- **Business Pro board:** §1 plans and limits → A1 to A4 (R1 replaces 100 with 25); §2 Plan states A to D → B1, B3; §3 limit moments and lapse list → A4, B2, B3, C6, C8 (R8); §4 admin Prices → A5; §5 analytics and statement → C1 to C5 (R7, per-staff naira dark); "Talk to us" → H1, H2; the other proposed rows → I1 to I9 (payroll built dark behind `BUSINESS_STAFF_AMOUNTS`).
- **Sign-up board:** §1 paths → D3; §2 fork and home → D3 (R12); §3 four steps, waiting, verified → D2, D3, D5 (R16, R17, R19); §4 no-page dashboard → D4 (R18); §5 switcher → D6; §6 owners, removal, handover, last owner → E1, E2, E4, E5 (R3, R13, R14, R15); §7 admin approval → E3; §8 edge cases → creator adds a business (today's apply path, kept), staff who own a business (D6 hats), turning off a page → G1, G2; closing → F1 to F3.
- **Names used across tasks:** `BusinessPlan`, `businessLimits`, `BusinessUsage`, `businessProState`, `startBusinessPaidPeriod`, `recomputeBusinessPlan`, `requestProPurchase({ subject, boughtBy })`, `BusinessPro`, `MyAccount`, `signedInLanding`, `accountOnlyRoute`, `hatsOf`, `neverAlone`, `ownershipLock`, `business_owner_events` are each defined once (A2, A4, A3, B1, D1, D4, D6, E3, E2, E1) and used with those names after.
- **Proportion:** signatures, test names and assertions only; no function bodies beyond the staff-count SQL (the counting rule is a ruling) and the seed.
