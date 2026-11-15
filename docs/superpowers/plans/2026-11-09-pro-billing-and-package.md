# TipMe Pro: billing first, then the Pro package. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recipients can buy TipMe Pro by the month at a price staff set (launch ₦2,500), paying by card or bank transfer through our payment partner's checkout, or from their TipMe balance. After that ships, the Pro package (the /pro page, the badge, earnings analytics, Campaign Studio, the monthly recap, priority support) is built on top, one approved board at a time.

**Architecture:** A price table with history (`pro_prices`), a purchase per payment (`pro_purchases`, price fixed when made) and a period per paid month (`pro_periods`, with a 3-day grace end). `profiles.plan` stays the one field every Pro check reads; `recomputePlan` rewrites it under the profile lock from a staff grant or a period that covers now (including grace). Checkout payments are made on **TipMe's own partner account** (no connected account), confirmed only by a signature-verified webhook plus a read-back, and booked once with the ledger key `pro.<purchaseId>`. Own-account webhook events are told apart from connected-account events and routed to Pro billing. Balance payments move money from the recipient's connected account to TipMe with a `destination: "self"` transfer before anything is booked, behind a flag.

**Tech Stack:** NestJS API, BullMQ worker, Drizzle/Postgres (drizzle-kit migrations), Next.js 16 web, `@tipme/payments` (Bachs adapter + mock), `@tipme/mail`, `@tipme/contracts`, node:test integration suites, Playwright with pretend payments.

**Spec:** the owner's decisions of 4, 5 and 9 Nov 2026 (memory `pro-billing-decision`, restated in "Owner decisions" below); the readiness note `.superpowers/program/pro-billing-readiness.md` (9 Nov; its §1 is the code delta on dev, its §2/§3 are **superseded** by "What the partner's docs settle" below); the outdated 4 Nov plan `.worktrees/pro-billing/docs/superpowers/plans/2026-11-04-pro-billing.md` (superseded by this file); the design canvas https://claude.ai/artifact/8D6hJZsqMkLSGh8KUUBmmh (boards ProPage, ProBadge, ProEarnings, ProCampaigns, OpsProPrice, PagePro; **not yet approved** except OpsProPrice/PagePro, which are already in `docs/design/redesign/boards/`). Partner docs: https://docs.bachs.io, read 9 Nov 2026; no partner API was called.

**Date:** 9 Nov 2026. **Base:** `origin/dev` at `19658a5a` (PR #181), migrations up to `0085_business_logo`.

---

## Owner decisions this plan implements (not regulatory approval)

- **Billing first**, before any new Pro feature.
- **Price:** ₦2,500 a month (250,000 kobo) at launch. Staff set it in ops; it lives on the server and is never hard-coded in web or mail. Range ₦100 to ₦1,000,000 (10,000 to 100,000,000 kobo), whole naira. A change needs a second approver; a lone admin acts alone, with an alert. A change applies to **new months only**.
- **One month can be queued ahead** (at most one SCHEDULED period).
- **Grace and lapse:** 3 days' grace after an unpaid month, then Free. Reminders 7 days and 1 day before the month ends. When Pro lapses, extras hide and nothing is deleted.
- **Ways to pay:** TipMe balance; card checkout; bank transfer through the partner's checkout. There is **no staff-confirmed transfer flow**. Auto-renew only once the partner supports it for naira cards.
- **Visitor analytics ON by default in production** (owner, 9 Nov 2026), within the existing rules: anonymous, cookieless, no IP/user agent/account stored, GPC/DNT honoured, 90-day raw retention, daily totals kept (`docs/00-DECISIONS.md:49`). This is the owner's product decision; **D-07 stays OPEN** as a compliance item.
- **Out of scope:** the annual plan (₦25,000 a year) is **not decided**. Nothing here builds it.
- Users never see the payment provider's name ("our payment partner"). Pronouns are "they". Nothing here implies regulatory, legal or provider approval: D-03, D-04, D-06, D-07 stay OPEN, D-05 stays PARTLY DECIDED, and `AGENTS.md`'s hard stop on real payments still stands.

## What the partner's docs settle (read 9 Nov 2026)

| Topic                          | What the docs say                                                                                                                                                                                                                                                                                                                                                                    | What this plan does                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TipMe sells on its own account | `POST /v1/checkout-sessions` with `pricing {currency, amount}` and no connected account; "going live is a key swap" (https://docs.bachs.io/guides/checkout/checkout-sessions). Live needs TipMe's own account verified, else `ACCOUNT_NOT_ACTIVATED` (https://docs.bachs.io/guides/payments/payment-method-support). `NGN_CARD` and `NGN_BANK_TRANSFER` work for one-time payments.  | Checkout without `X-Account-Id` and without `platform_fee`. `ACCOUNT_NOT_ACTIVATED` maps to a definite refusal (`PRO_CHECKOUT_UNAVAILABLE`), never uncertain.                                                                                                     |
| Confirmation                   | `collection.succeeded` (status SUCCEEDED, amount, currency, checkout_id) and `checkout.completed`, either first; fulfil once, verify the signature, the webhook is the source of truth.                                                                                                                                                                                              | Either event triggers a read-back; the ledger key books once.                                                                                                                                                                                                     |
| Webhook scope                  | Endpoint `event_source` is `account` (own only, default), `connect` (connected only) or `all`. There is **no** `connect/all`. Connected events carry a top-level `account` and `organization_id` = that account; TipMe's own events have **no** top-level `account` (https://docs.bachs.io/guides/webhooks/overview).                                                                | `docs/runbooks/staging-setup.md:82` fixed to `event_source=all` in this PR. Normaliser gains a `scope` (Task 5).                                                                                                                                                  |
| Pay from balance               | `POST /v1/transfers` as the connected account (`X-Account-Id`) with `destination: "self"` moves AVAILABLE balance to the platform; needs the account's `transfers` capability `active`; same currency; cannot be reversed; blocked with `ORGANIZATION_IN_DEBT` (https://docs.bachs.io/connect/transfers). The docs frame it as recovering funds.                                     | Built behind `PRO_PAY_FROM_BALANCE` (default off in production) until the partner answers Q1.                                                                                                                                                                     |
| Refunds                        | Cards: one refund per payment, partial allowed, processing fee not returned. **NGN bank transfer is not refundable** by API or dashboard. Events `refund.created`, `refund.paid` (final), `refund.failed` (https://docs.bachs.io/guides/refunds).                                                                                                                                    | Card refunds only, staff serious action, after the owner's refund rule (Task 9).                                                                                                                                                                                  |
| Saved cards / subscriptions    | Save via checkout `save_payment_method: true` (NGN card only while paying), then `POST /v1/charges` off-session; an issuer that wants authentication refuses (`collection.failed`) (https://docs.bachs.io/guides/payments/charge-a-saved-card). Partner subscriptions bill **USD cards only**; other currencies "rolling out" (https://docs.bachs.io/guides/subscriptions/overview). | Launch = pay each month with reminders. Auto-renew is a later phase behind `PRO_AUTO_RENEW`, after a sandbox proof (Task 10).                                                                                                                                     |
| Fees                           | NGN local cards 2%; checkout bank transfers 1.5% capped ₦2,000; payouts ₦50 flat (https://docs.bachs.io/for-you/fees).                                                                                                                                                                                                                                                               | On ₦2,500: card fee ₦50 (5,000 kobo), bank ₦37.50 (3,750 kobo). The fee booked is always the read-back `fees.amount`, never computed.                                                                                                                             |
| Receipts                       | Not documented.                                                                                                                                                                                                                                                                                                                                                                      | TipMe sends its own `pro-receipt` email; no amount or private data in subject or preheader (existing mail rule).                                                                                                                                                  |
| Bank transfer expiry           | Transfer numbers valid 30 minutes; late, short and over payment are **not documented**.                                                                                                                                                                                                                                                                                              | Safe default: a `collection.succeeded` for a Pro checkout is credited even after the purchase expired (a Pro month from confirmation, alert `pro.late_payment`). Any amount or currency that differs from the purchase → `REVIEW`, a money issue, nothing booked. |

## Questions for the partner (only what the docs don't answer)

1. May `POST /v1/transfers` with `destination: "self"` be used to collect TipMe's own Pro subscription from a recipient's AVAILABLE balance, when the recipient asks for it in our app? Any limits or terms?
2. For an NGN bank transfer at checkout: what happens to money paid **after** the 30-minute expiry, **short**, or **over**? Credited to us, returned, or held, and which webhook says so?
3. Can an NGN card saved with `save_payment_method: true` on our own account be charged off-session with `POST /v1/charges`, and how often do Nigerian issuers refuse for authentication?
4. When will subscriptions bill NGN cards?

## Questions for the owner (open; the plan uses the default shown)

1. **Annual plan** at ₦25,000 a year: yes or not yet? (Default: out of scope.)
2. **Paying during grace:** does the new month start at the old end date (default, so grace isn't free time) or at payment?
3. **Pro refund rule:** default = no refund or proration on cancellation; staff may refund a **card** month in full as a serious action with a second approver, and Pro ends at once; bank-transfer months can't be refunded through the partner; balance months aren't refunded in v1.
4. **Priority support:** who answers, and the response target. (Pro additions plan PR 2 waits on this.)
5. **Campaign Studio:** how many links Pro gets ([N]); does Free get one; link shape (`usetipme.xyz/@ada/new-single` or shorter); the word "Campaigns" or "Links".
6. **Badge:** confirm option A and the tap note "TipMe Pro is a paid plan, not a check on who runs the page."
7. **VAT** on Pro and whether ₦2,500 is VAT-inclusive (after an accountant's view); finance sign-off on `subscription_revenue` and `platform_clearing` (ADR-0006).
8. Does the 1 Nov "launch without" acceptance extend to TipMe collecting money on its own account (D-04)?
9. Does a staff grant still override paid Pro? (Default: yes, `staff_pro` keeps Pro on.)

---

## Global Constraints

- Read `AGENTS.md`, the scoped `AGENTS.md` of every touched path (`apps/api`, `apps/web`, `apps/worker`, `packages/contracts`, `packages/ui`), `docs/00-DECISIONS.md`, ADR-0006, ADR-0010, ADR-0014. For UI: `docs/design/DESIGN-CONSTITUTION.md` and the documents `apps/web/AGENTS.md` names.
- **Pretend money only.** Tests use the mock provider, `/mock-checkout`, fake transports and recorded fixtures for the Bachs adapter. No test, script or agent calls `api.bachs.io` or `sandbox-api.bachs.io`; `tests/integration/no-real-provider.mjs` stays in force. Sandbox evidence is gathered by the owner or staff only and recorded in `docs/evidence/`.
- Money is `bigint` kobo plus `'NGN'`; decimals only at the edge (`minorToDecimal`, mail, web). Launch price 250,000 kobo; limits 10,000 to 100,000,000 kobo, whole naira (multiple of 100).
- The server is the only source of price, amount, status and plan. A redirect never unlocks Pro. The client's `expectedAmountMinor` is only used to refuse a mismatch (`409 PRO_PRICE_CHANGED`).
- Every money write is idempotent: request `Idempotency-Key` + fingerprint; partner idempotency key `tipme-pro-<purchaseId>`; ledger operation key `pro.<purchaseId>`. Never retry an uncertain transfer blindly.
- User-facing text never names the provider ("our payment partner"); staff screens may. Pronouns "they". No word implies approval by a regulator. Mail subjects and preheaders carry no amount or private data.
- **Migrations:** generated by `pnpm --filter @tipme/database generate --name <name>` (or `generate --custom --name <name>` for triggers, seeds and grants) **at merge-train time**, on top of whatever dev holds then (latest today: `0085`). Never rename or renumber by hand; never hard-code a migration number outside the generated file. `migration-journal.test.mjs` must pass.
- **Merge trains:** a PR that changes API routes or DTOs (so regenerates `docs/api/openapi.json` with `pnpm api:openapi` and `docs/security/access-control.md` with `pnpm docs:generate`) goes in sequence or in one merge train, never in parallel straight to dev. Docs-only, web-only and `packages/payments`-only PRs may run beside them.
- **Tests:** test first. E2E only for the specs a task touches, run locally on a test lane with 2 workers: `E2E_LANE=<n> pnpm exec playwright test <spec> --workers=2`.
- **Never edit** `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`, `docs/design/DECISION-LOG.md` or `docs/design/redesign/README.md` in a feature PR.
- Pro features from the package (Tasks 12–17) start only **after billing is live in pretend mode** and **after the owner approves their board**; each of those tasks says so.
- Controls ≥ 44px, keyboard, reduced motion, 320px reflow, `expectAccessible` on every new screen.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Commands used below**

- Build (no web): `pnpm exec turbo run build --filter=!@tipme/web`
- One integration file: `node --import ./packages/observability/dist/register.js --test <file>` (after the build)
- Unit: `pnpm --filter @tipme/<pkg> test`
- E2E: `NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:4100 NEXT_PUBLIC_PRETEND_DELIVERY=on pnpm build && node scripts/prepare-e2e-database.mjs && E2E_LANE=<n> pnpm exec playwright test <spec> --workers=2`
- PR gates: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`, plus the touched e2e specs.

## Review Focus

1. **An own-account event read as a connected account.** Today `webhooks.ts:167,321` uses `event.account ?? event.organization_id`, so a Pro payment would look like a tip on an account called TipMe's org id and land unmatched. Expected: no top-level `account` + `organization_id` = `BACHS_PLATFORM_ORGANIZATION_ID` → `scope: 'platform'`, routed only to Pro; a legacy tip event with only `organization_id = acct_…` still matches its tip (Task 5, tests `own-account event is platform scope` and `legacy event without account stays connected`).
2. **A bank transfer that arrives late, short or over.** Expected: a late `collection.succeeded` credits a month from confirmation with `pro.late_payment`; any amount or currency other than the purchase's goes to `REVIEW` with a money issue and books nothing (Task 6, tests `late bank transfer after EXPIRED is credited` and `short or over amount goes to REVIEW`).
3. **Paying during grace, or racing expiry.** Expected: under the profile lock a confirmed month starts at the old `ends_at` while in grace (owner default), never overlaps, never leaves a gap; expiry and confirmation in parallel leave one ACTIVE period and plan `pro` (Task 4, test `confirmation and expiry in parallel`).
4. **Balance payment against a business share or a negative balance.** Expected: `spendable = min(ledger available, partner available − queued − reserved)` excludes the person's business share and refuses when ledger available < price, including below zero; a withdrawal and a Pro payment in parallel never overdraw (Task 8).
5. **Lapse leaves Pro extras visible.** Expected: on the day grace ends every Pro gate falls back (covers to `still`/`once`, links beyond 3 hidden and the legacy `socials` column rewritten, thanks style `paper`, preset amounts standard, QR art locked, early-access entries hidden, no new supporter rows, the badge gone) and nothing is deleted; the public page revalidates and a `profile.changed` live signal fires (Task 4, test `lapse falls back every Pro gate`).

---

## PR split and order

| PR                                               | Tasks | Changes API?             | Needs a partner answer?                             | Needs board approval?                  | Can start now?                      |
| ------------------------------------------------ | ----- | ------------------------ | --------------------------------------------------- | -------------------------------------- | ----------------------------------- |
| D1 docs: decisions, ADR-0015                     | 2     | no                       | no                                                  | no                                     | **yes**                             |
| A1 analytics on in production                    | 1     | config only (no route)   | no                                                  | no                                     | **yes**, parallel                   |
| B1 price in ops                                  | 3     | yes (train)              | no                                                  | OpsProPrice is already in repo         | **yes**                             |
| B2 periods, grace, expiry, reminders             | 4     | yes (train)              | no                                                  | no                                     | **yes**, after B1                   |
| P1 adapter: own-account checkout + webhook scope | 5     | no (`packages/payments`) | no                                                  | no                                     | **yes**, parallel                   |
| B3 purchases by checkout (card + bank)           | 6     | yes (train)              | no for pretend; live needs TipMe's account verified | no                                     | after B2 + P1                       |
| B4 buy flow on web                               | 7     | no (web)                 | no                                                  | **yes**: ProPage board's Settings line | after B3 + approval                 |
| B5 pay from balance                              | 8     | yes (train)              | **Q1** before the flag is turned on live            | no                                     | build now on mock; live waits       |
| B6 Pro refunds                                   | 9     | yes (train)              | no                                                  | no                                     | waits owner Q3                      |
| B7 auto-renew                                    | 10    | yes (train)              | **Q3, Q4** + sandbox proof                          | no                                     | **no**                              |
| K1 /pro page                                     | 12    | no (web)                 | no                                                  | **yes** ProPage                        | after B1 + approval                 |
| K2 Pro badge                                     | 13    | no (ui/web)              | no                                                  | **yes** ProBadge                       | after approval                      |
| K3 earnings analytics                            | 14    | yes (train)              | no                                                  | **yes** ProEarnings                    | after B4 + approval                 |
| K4 where tips come from + Campaign Studio        | 15    | yes (train)              | no                                                  | **yes** ProCampaigns                   | after A1 + B4 + approval + owner Q5 |
| K5 monthly recap, priority support               | 16    | yes (train)              | no                                                  | ProAdditions (approved 5 Nov)          | after B4; support waits owner Q4    |
| Go-live checklist                                | 11    | no                       | sandbox evidence E1–E6                              | no                                     | docs part now                       |

Task 17 (board fixes) is folded into B1 and K1.

---

### Task 1: Visitor analytics on by default in production (PR A1)

**Files:**

- Modify: `apps/api/src/config.ts:143-150` and `apps/worker/src/config.ts:83-89`: `ANALYTICS_ENABLED` becomes `z.enum(['true','false']).default('true').transform(v => v === 'true')` (a boolean, never undefined). Comment: "Anonymous analytics. On unless set to false (owner's decision, 9 Nov 2026; D-07 stays open)."
- Modify the five readers to drop the `?? config.NODE_ENV !== 'production'` fallback: `apps/api/src/analytics/events.controller.ts:37`, `apps/api/src/analytics/server-events.ts:22`, `apps/api/src/ops/metrics.controller.ts:25`, `apps/api/src/release/release.controller.ts:47`, `apps/worker/src/job-worker.ts:254`.
- Modify: `deploy/compose.production.yml:107,223` → `${ANALYTICS_ENABLED:-true}`; `deploy/production.env.example:128` → `ANALYTICS_ENABLED=true` with a one-line comment ("anonymous, cookieless; set false to stop collection"); `.env.example:70` comment.
- Modify: `docs/00-DECISIONS.md:49` and `:59` (web vitals line) and add a dated block (below); `docs/BOOTSTRAP-SETUP.md:93`; `docs/adr/ADR-0010-admin-access-audit-analytics.md:111` (a dated addendum line, not a rewrite).
- Modify: `apps/web/src/app/legal/privacy/page.tsx:20`, the covers bullet "Consent for analytics, and your rights" → "Anonymous visit counts: what is counted, what is never stored, and how Global Privacy Control or Do Not Track stops it". (The page is a placeholder and never says analytics is off; grep `apps/web/src` for "off in production" finds nothing.)
- Test: `tests/integration/analytics.test.mjs`, `apps/worker/test/*` (the job-worker config test if present).

**Interfaces:** Produces `config.ANALYTICS_ENABLED: boolean` in API and worker (no longer `boolean | undefined`). Later tasks (15) read it as is.

- [ ] **Step 1: Write failing tests** in `tests/integration/analytics.test.mjs`:
  - `NODE_ENV=production with ANALYTICS_ENABLED unset collects a visit` (POST an event → 202 and one `analytics_events` row);
  - keep `ANALYTICS_ENABLED=false collects nothing` (line ~149) green;
  - `a request with Sec-GPC: 1 stores nothing in production` and the same for `DNT: 1`;
  - `no IP, user agent or account is stored` (row has no such column values; assert the column list).
- [ ] **Step 2: Run** the build, then `node --import ./packages/observability/dist/register.js --test tests/integration/analytics.test.mjs`. Expected: FAIL on the first test.
- [ ] **Step 3: Implement** the config change and the five readers. Add to `docs/00-DECISIONS.md`, after the PR-009 notes:

  > **Visitor analytics in production: the owner's decision, 9 Nov 2026.** Anonymous visitor analytics is on by default in production, within the PR-009 rules above (anonymous, cookieless, nothing written to the device, GPC and DNT honoured, no IP, user agent or account stored, raw events kept 90 days, daily totals kept). `ANALYTICS_ENABLED=false` turns it off. This is the owner's product decision; it is not a legal or data-protection approval. **D-07 stays OPEN** as a compliance item. It also turns on web-vitals samples and, once built, tip-source attribution (Pro additions plan PR 5).

  Edit line 49's last sentence to "Collection is on in production by default (owner, 9 Nov 2026; see below)."

- [ ] **Step 4: Run** the same file plus `tests/integration/analytics-v11.test.mjs`, `pnpm --filter @tipme/api test`, `pnpm --filter @tipme/worker test`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(analytics): count anonymous visits in production by default`

### Task 2: Record the decisions and ADR-0015 (PR D1)

**Files:**

- Modify: `docs/00-DECISIONS.md`: lines 69–70 (Pro "granted by staff… no billing until payments are approved"; "Pro pricing… open") → point at the new block; line 194 remove "the Pro price, billing and how someone buys Pro" from "Still open"; line 248 "There is no Pro price" → "The Pro price is shown only as the server sends it". Add the block below after the 1 Nov "Covers, Pro and the handle rule" block. Add to the D-05 row's note area: "Pro refunds: see the Pro billing block (9 Nov 2026)".
- Create: `docs/adr/ADR-0015-paid-pro.md` from `ADR-TEMPLATE.md`: periods and grace, own-account checkout, webhook scope, balance collection by `destination: self` transfer behind a flag, ledger postings, refunds rule (pending owner), partner doc citations from this plan.
- Modify: `docs/adr/ADR-0006-custody-neutral-ledger.md`: addendum with `pro_sale`, `subscription_revenue` (revenue), `platform_clearing` (asset: TipMe's own partner balance, kept apart from `provider_clearing` so it reconciles against TipMe's own `/v1/balances`), and the postings table from Task 6/8/9. "Needs finance sign-off."
- Modify: `scripts/check-governance.sh` (ADR index check includes ADR-0015).

**Interfaces:** none.

- [ ] **Step 1:** Add the ADR-0015 assertion to `scripts/check-governance.sh`.
- [ ] **Step 2: Run** `bash scripts/check-governance.sh`. Expected: FAIL (ADR-0015 missing).
- [ ] **Step 3: Write** the documents. The decisions block:
  > **Paying for Pro: the owner's decisions, 4, 5 and 9 Nov 2026.** Billing is built before any new Pro feature. Pro is monthly; the launch price is ₦2,500 a month, set by staff with `pro.price` in the admin area (₦100 to ₦1,000,000, whole naira, with a reason; a second person approves, a lone admin acts alone with an alert), and a change applies to new months only. One month can be paid ahead. After an unpaid month there are 3 days' grace, then the page is Free; reminders go 7 days and 1 day before. When Pro lapses its extras hide and nothing is deleted. Recipients pay by card or bank transfer through our payment partner's checkout, or from their TipMe balance; there is no staff-confirmed transfer. Automatic renewal waits until the partner supports it for naira cards. An annual plan is not decided. Staff can still grant Pro with a reason. This is the owner's product decision. It is not a legal, regulatory or provider approval: D-03, D-04, D-06 and D-07 stay OPEN, D-05 stays PARTLY DECIDED, real payments still need the live pilot acceptance, and `subscription_revenue` and `platform_clearing` need finance sign-off (ADR-0006, ADR-0015).
- [ ] **Step 4: Run** `bash scripts/check-governance.sh && pnpm format:check`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: record the owner's Pro billing decisions and ADR-0015`

### Task 3: The price: public read, staff change with a second approver (PR B1)

**Files:**

- Modify: `packages/database/src/schema.ts`: `proPrices` (`id uuid`, `amount_minor bigint` check `> 0`, `currency text` check `= 'NGN'`, `effective_from timestamptz`, `set_by uuid null`, `approved_by uuid null`, `reason text not null`, `created_at`).
- Migration at train time: `generate --name pro_prices`, then `generate --custom --name pro_prices_seed` holding the append-only trigger (same pattern as the ledger's), the seed row (250,000 kobo, `set_by NULL`, reason `Owner's decision, 9 Nov 2026: launch Pro price ₦2,500 a month`), and the grant of `pro.price` to `owner` (as `fees.manage` was granted).
- Create: `packages/database/src/operations/pro-price.ts`.
- Modify: `packages/database/src/operations/serious-actions-registered.ts` (register `pro_price.change`, modelled on `fee.change` at :484, with `current: currentProPrice` so a price changed while waiting makes the request stale); `packages/contracts/src/ops-catalogue.ts` (permission `pro.price`, sensitive, group money; `SERIOUS_ACTIONS` += `'pro_price.change'`; routes).
- Create: `packages/contracts/src/pro.ts` (`proPriceSchema`, `opsProPriceChangeSchema`), exported from the index.
- Create: `apps/api/src/ops/pro-price.controller.ts` (GET current + history, POST change); `apps/api/src/profiles/pro-price.controller.ts` (`GET /v1/pro/price`, `Cache-Control: public, max-age=60`). Register in modules.
- Create: `apps/web/src/app/ops/pro-price/page.tsx` from `docs/design/redesign/boards/OpsProPrice.dc.html`, nav entry gated on `pro.price`.
- Modify: `docs/design/redesign/boards/OpsProPrice.dc.html:67,73`: sample price `5000` → `2500`, lower clamp `500` → `100` (the canvas copy gets the same fix by whoever edits the canvas).
- Modify: `apps/web/src/app/pro/page.tsx` and `apps/web/src/app/dashboard/settings/sections/plan.tsx`: show "₦2,500 a month" read from `GET /v1/pro/price` (server-fetched, revalidate 60 s) beside today's "Ask for Pro". No buy button. With no price, the line reads "Price coming soon" and no number.
- Test: `tests/integration/pro-price.test.mjs` (new), `packages/contracts/test/ops-catalogue.test.mjs`, `tests/integration/ops-access.test.mjs`, `tests/e2e/ops-pro-price.spec.ts` (new), `tests/e2e/pro.spec.ts`.

**Interfaces:**

- Produces `currentProPrice(db: Database | Tx, now?: Date): Promise<{ id: string; amountMinor: bigint; currency: 'NGN'; effectiveFrom: Date } | null>`.
- Produces `GET /v1/pro/price` → `{ amountMinor: string; currency: 'NGN'; interval: 'month' } | 404 PRO_PRICE_NOT_SET`.
- Produces serious action `pro_price.change` with payload `{ amountMinor: string; reason: string }`.

- [ ] **Step 1: Write failing tests** in `pro-price.test.mjs`:
  - `GET /v1/pro/price returns 250000 NGN month with public max-age=60`;
  - `staff without pro.price get 403`;
  - `a change with a second staff member waits and the price stays 250000 until approved`;
  - `on approval the price is 300000, history has two rows, audit pro.price_changed has from, to, reason, approver`;
  - `a lone admin runs it alone with aloneReason no_second_person and a pro.price_changed alert`;
  - `a request goes stale when the price changed while it waited`;
  - `9999 kobo, 100000100 kobo, 250050 kobo (not whole naira) and the same price are refused INVALID_INPUT`;
  - `pro_prices rows cannot be updated or deleted`.
  - `ops-catalogue.test.mjs`: `pro.price is sensitive and in money`; `pro_price.change maps to pro.price`.
  - `ops-pro-price.spec.ts`: `owner asks to change to ₦3,000 with a reason, sees "Waiting for a second person", the approver approves, history lists ₦3,000`; `expectAccessible` and 320px.
  - `pro.spec.ts`: `/pro shows ₦2,500 a month from the server and no buy button`.
- [ ] **Step 2: Run** the build, the integration file, `pnpm --filter @tipme/contracts test`, the two e2e specs. Expected: FAIL.
- [ ] **Step 3: Implement.** `validate` reads the current price inside the transaction; `act` inserts with `effective_from = now()`, `set_by`, `approved_by`, and records the audit. Regenerate `pnpm api:openapi` and `pnpm docs:generate`.
- [ ] **Step 4: Run** the same commands plus `tests/integration/ops-approvals.test.mjs` and `tests/integration/openapi.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): staff set the Pro price with history and a second approver`

### Task 4: Periods, effective plan, grace, expiry and reminders (PR B2)

**Files:**

- Modify: `packages/database/src/schema.ts`: `proPeriods` (`id`, `profile_id`, `purchase_id` unique null for test/staff, `starts_at`, `ends_at`, `grace_ends_at` = `ends_at + 3 days`, `status 'SCHEDULED'|'ACTIVE'|'GRACE'|'ENDED'`, `paid_by 'card'|'bank_transfer'|'balance'|'saved_card'`, `amount_minor`, `currency`), `unique(profile_id, starts_at)`, partial unique "one SCHEDULED per profile"; `profiles.staff_pro boolean not null default false`. Migration at train time (`generate --name pro_periods`; custom part backfills `staff_pro = (plan = 'pro')`).
- Create: `packages/domain/src/pro.ts` (`proPeriodEnd`, `proGraceEnd`, `nextPeriodStart`), exported.
- Create: `packages/database/src/operations/pro-periods.ts`.
- Modify: `packages/database/src/operations/profiles.ts:448` `setPagePlan`: sets `staff_pro`, then calls `recomputePlan`.
- Create: `apps/worker/src/handlers/pro-expire.ts` (every 60 s) and `apps/worker/src/handlers/pro-reminders.ts` (every 15 min), registered with `apps/worker/src/ensure-schedule.ts`; both call `apps/worker/src/revalidate.ts` and `apps/worker/src/live-publisher.ts` (`profile.changed`) for each profile whose plan changed. API-side plan changes keep using the controller's revalidate + `publishLive` as `apps/api/src/ops/pages.controller.ts:130` does.
- Modify: `packages/mail/src/templates/types/account-notices.ts`: `pro-renewal-reminder` (7d, 1d), `pro-grace-started`, `pro-ended`; registered in the registry.
- Modify: `packages/contracts/src/ops.ts` (ops page DTO: `proSource: 'staff'|'paid'|null`, `paidUntil`, `graceUntil`); `apps/web/src/app/ops/pages/page.tsx` shows "Paid Pro until 9 Dec 2026" or "Staff grant".
- Test: `packages/domain/test/pro.test.mjs`, `packages/database/test/integration/pro-periods.test.mjs`, `packages/mail/test/pro-notices.test.mjs`, `apps/worker/test/pro-handlers.test.mjs`, `tests/e2e/pro.spec.ts`.

**Interfaces:**

- Produces `proPeriodEnd(startsAt: Date): Date` (one calendar month in Africa/Lagos, clamped to month end); `proGraceEnd(endsAt: Date): Date` (+3 days); `nextPeriodStart(now: Date, latest: { endsAt: Date; graceEndsAt: Date } | null): Date` (= `latest.endsAt` if `now < latest.graceEndsAt`, else `now`).
- Produces `recomputePlan(tx: Tx, profileId: string, now: Date): Promise<{ plan: PagePlan; changed: boolean }>` — `pro` when `staff_pro` or a period with `starts_at <= now < grace_ends_at` exists; rewrites `socials` from `visibleLinks(links, plan)` exactly as `setPagePlan` does.
- Produces `startPaidPeriod(tx: Tx, i: { profileId: string; purchaseId: string; paidBy: ProPaidBy; amountMinor: bigint; currency: 'NGN'; now: Date }): Promise<{ periodId: string; startsAt: Date; endsAt: Date; status: 'ACTIVE' | 'SCHEDULED' }>` — throws `PRO_ALREADY_RENEWED` when a SCHEDULED period exists.
- Produces `expireDuePeriods(db: Database, now: Date, limit?: number): Promise<{ changedProfiles: string[] }>`.

- [ ] **Step 1: Write failing tests.**
  - `pro.test.mjs`: `31 Jan 2027 10:00 Lagos ends 28 Feb 2027 10:00 Lagos`; `29 Feb in a leap year`; `grace ends 3 days after the end`; `next start is the old end while in grace, now after grace`.
  - `pro-periods.test.mjs`:
    - `a paid period makes plan pro and ends one Lagos month later`;
    - `a second purchase while active is SCHEDULED from the current end`;
    - `a third while one is scheduled is refused PRO_ALREADY_RENEWED`;
    - `at ends_at the period is GRACE and plan stays pro`;
    - `a payment during grace starts at the old ends_at`;
    - `at grace_ends_at plan is free` and **`lapse falls back every Pro gate`**: covers `still`/`once`, links beyond 3 hidden and `socials` rewritten, thanks `paper`, presets back to ₦2,000/₦5,000/₦10,000, `shownQrStyle` standard, early-access changelog entries hidden, a new tip records no supporter row; and every stored choice is still in its table;
    - `expiry activates a due SCHEDULED period with no gap`;
    - `staff_pro keeps plan pro after a paid period ends`; `removing staff Pro during a paid period keeps pro until grace ends`;
    - `confirmation and expiry in parallel give one ACTIVE period and plan pro` (two connections, `Promise.all`);
    - `reminders: one 7d and one 1d per period even when the job runs three times` (dedupe keys `pro_reminder.<periodId>.7d|1d`);
    - `no reminder when a month is queued`; `grace-started once`; `pro-ended once`.
  - `pro-notices.test.mjs`: `reminder shows the period's end date and the current price from input, never /bachs/i, and the subject has no amount`.
  - `pro-handlers.test.mjs`: `expire handler revalidates the handle and publishes profile.changed once per changed profile`.
- [ ] **Step 2: Run** domain build + test, the build, the integration file, `pnpm --filter @tipme/mail test`, `pnpm --filter @tipme/worker test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every function locks `profiles … FOR UPDATE` first; `expireDuePeriods` handles one profile per transaction. Regenerate OpenAPI and access-control docs.
- [ ] **Step 4: Run** the same plus `tests/integration/handle-rule.test.mjs`, `packages/database/test/integration/profiles.test.mjs`, and `E2E_LANE=1 pnpm exec playwright test tests/e2e/pro.spec.ts --workers=2`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): monthly periods with 3 days' grace, expiry and reminders`

### Task 5: Adapter: checkout on TipMe's own account and own-account webhooks (PR P1)

**Files:**

- Modify: `packages/payments/src/provider.ts`: `PaymentProvider.initializePlatformCheckout`; capability `platformCheckout`; add `scope: 'platform' | 'connected'` to the `payment` and `reversal` variants of `NormalizedProviderEvent` (`provider.ts:17-50`); `accountReference` stays `string | null` and is `null` for platform scope.
- Modify: `packages/payments/src/bachs/provider.ts` (new method next to the tip checkout at ~:446: same `pricing`, `reference: purchaseId`, `payment_method_types: ['NGN_CARD','NGN_BANK_TRANSFER']`, `customer_bears_fee: false`, `expires_in_minutes: 30`, **no** `accountReference`, **no** `platform_fee`; provider reference `platform:<checkout_id>`; `verifyTransaction` accepts the platform scope and sends no account header; `ACCOUNT_NOT_ACTIVATED` → `BachsRequestNotSentError`-style definite refusal).
- Modify: `packages/payments/src/bachs/webhooks.ts:167` and `:321`: the scope rule below.
- Modify: `packages/payments/src/settings.ts`: `BACHS_PLATFORM_ORGANIZATION_ID` (optional string; without it every event stays `connected`, so nothing changes until it is set).
- Modify: `packages/payments/src/mock/mock-provider.ts` (`mock_pro_<uuid>` references, platform scope on its webhooks).
- Modify: `docs/runbooks/staging-setup.md` (set `BACHS_PLATFORM_ORGANIZATION_ID`; the `event_source=all` fix already lands with this plan).
- Test: `packages/payments/test/bachs.test.mjs` (extend), `packages/payments/test/bachs-platform-checkout.test.mjs` (new). Fixtures are recorded JSON from the docs' examples, no network.

**Interfaces:**

- Produces `initializePlatformCheckout(input: { purchaseId: string; amountMinor: bigint; currency: 'NGN'; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ providerReference: string; checkoutUrl: string; expiresAt: Date }>`.
- Produces `NormalizedProviderEvent['scope']`. Scope rule:

  ```
  account = nullableString(event.account)
  if account            → scope 'connected', accountReference = account
  else if org && org === settings.BACHS_PLATFORM_ORGANIZATION_ID → scope 'platform', accountReference = null
  else                  → scope 'connected', accountReference = org   // legacy behaviour, kept
  ```

- [ ] **Step 1: Write failing tests.**
  - `bachs-platform-checkout.test.mjs`: `request has no X-Account-Id and no platform_fee, pricing {amount "2500.00", currency NGN}, methods NGN_CARD and NGN_BANK_TRANSFER, customer_bears_fee false, Idempotency-Key tipme-pro-<id>`; `a non-open checkout raises UncertainProviderOutcomeError`; `ACCOUNT_NOT_ACTIVATED is a definite refusal`; `status read for platform:<id> sends no account header`.
  - `bachs.test.mjs`: **`own-account event is platform scope`** (`collection.succeeded`, no `account`, `organization_id: 'org_platform'` with the setting `org_platform` → `scope 'platform'`, `accountReference null`); **`legacy event without account stays connected`** (existing `evt_legacy` fixture, `acct_123abc`); `event with account is connected even when organization_id is the platform's`; `without the setting every event is connected`; `own-account refund.created is a platform reversal`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/payments build && pnpm --filter @tipme/payments test`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** the same command. Expected: PASS, with every existing tip-webhook test unchanged.
- [ ] **Step 5: Commit** `feat(payments): checkout on TipMe's own account and own-account webhook scope`

### Task 6: Pro purchases by checkout, card and bank transfer (PR B3)

**Files:**

- Modify: `packages/database/src/schema.ts`: `proPurchases` (`id`, `profile_id`, `method 'card'|'bank_transfer'|'balance'|'saved_card'` (`card` here covers the checkout, where the payer picks card or transfer; `paid_by` on the period records which), `price_id`, `amount_minor`, `currency`, `status 'PENDING'|'COLLECTING'|'UNKNOWN'|'PAID'|'FAILED'|'EXPIRED'|'REVIEW'`, `provider`, `provider_reference`, `idempotency_key`, `fingerprint`, `start_claimed_at`, `expires_at`, `last_checked_at`), `unique(profile_id, idempotency_key)`, partial unique `pro_purchases_one_open (profile_id) WHERE status IN ('PENDING','COLLECTING','UNKNOWN')`; `providerEvents.proPurchaseId`; `ledgerTransactions.proPurchaseId`; `operation_type` += `pro_sale`; entity `pro_purchase` for `status_transitions`; money issue kinds `pro_amount_mismatch`, `pro_collect_unknown`. Migration at train time.
- Modify: `packages/domain/src/ledger.ts` (accounts `subscription_revenue`, `platform_clearing`; `buildProCheckoutPosting`, `buildProBalancePosting`), `packages/domain/src/state-machines.ts` (`PRO_PURCHASE_TRANSITIONS`, with `EXPIRED → PAID` for late payment and `PENDING|UNKNOWN → REVIEW`), `packages/database/src/operations/ledger.ts` (`KIND`, `pro_sale`).
- Create: `packages/database/src/operations/pro-purchases.ts`.
- Modify: `packages/database/src/operations/reconcile.ts` (`reconcileProPurchases`, next to `reconcileAttempts` at :150); `apps/worker/src/main.ts` (reconcile includes Pro).
- Modify: `apps/api/src/webhooks/webhook.service.ts:117-135`: `scope === 'platform'` → `applyProEvent` (payment) or `flagProReversal` (reversal: marks the purchase, opens a money issue, ends Pro after `refund.paid` or a chargeback); never `matchBachsAttempt`. A platform event with no purchase → `unmatchedBachs`. Mock `apply` routes `mock_pro_`.
- Create: `apps/api/src/profiles/pro.controller.ts`: `GET /v1/me/pro`, `POST /v1/me/pro/purchases`, `GET /v1/me/pro/purchases/:id`. `PRO_BILLING_ENABLED` (API setting, default off) gates POST (`404 PRO_BILLING_OFF`); with the mock provider in tests it is on.
- Modify: `packages/contracts/src/pro.ts` (`proPurchaseRequestSchema`, `MyPro`, `ProPurchaseStatus`), `packages/contracts/src/errors.ts` + `apps/api/src/http/api-exception.filter.ts` (`PRO_PRICE_CHANGED` 409, `PRO_PURCHASE_OPEN` 409, `PRO_ALREADY_RENEWED` 409, `PRO_CHECKOUT_UNAVAILABLE` 503, `PRO_BILLING_OFF` 404).
- Modify: `packages/mail/src/templates/types/account-notices.ts`: `pro-receipt` (TipMe's own receipt: period, amount, "paid by card / bank transfer through our payment partner"; subject "Your TipMe Pro receipt", no amount in subject or preheader).
- Test: `packages/domain/test/ledger.test.mjs`, `packages/database/test/integration/pro-checkout.test.mjs` (new), `tests/integration/pro-webhooks.test.mjs` (new), `tests/integration/pro-api.test.mjs` (new).

**Interfaces:**

- Consumes `initializePlatformCheckout`, `scope` (Task 5); `startPaidPeriod`, `recomputePlan` (Task 4); `currentProPrice` (Task 3).
- Produces `requestProPurchase(db: Database, i: { profileId: string; method: 'card' | 'balance'; expectedAmountMinor: bigint; idempotencyKey: string; now?: Date }): Promise<{ purchaseId: string; status: ProPurchaseStatus; replayed: boolean }>`.
- Produces `confirmProCheckout(db: Database, i: { purchaseId: string; verified: { status: TransactionStatus; amountMinor: bigint; currency: string; feeMinor: bigint; method: 'NGN_CARD' | 'NGN_BANK_TRANSFER' }; now: Date }): Promise<'paid' | 'pending' | 'failed' | 'review' | 'already'>`.
- Produces `buildProCheckoutPosting(i: { grossMinor: bigint; feeMinor: bigint }): LedgerLine[]` = Dr `platform_clearing` gross − fee, Dr `provider_fee_expense` fee, Cr `subscription_revenue` gross.
- Produces `GET /v1/me/pro` → `{ plan; source: 'staff'|'paid'|null; current?: { endsAt; graceEndsAt; paidBy }; next?: { startsAt }; openPurchase?; price; methods: ('card'|'balance')[]; billingOn: boolean }`.

- [ ] **Step 1: Write failing tests.**
  - `ledger.test.mjs`: `pro checkout posting balances; fee 5000 to provider_fee_expense; revenue 250000`; `fee above gross throws`.
  - `pro-checkout.test.mjs`:
    - `card purchase is PENDING with a checkout URL and plan stays free`; `a redirect alone changes nothing`;
    - `collection.succeeded + read-back: PAID, one pro.<id> transaction, period ACTIVE, plan pro, one pro-receipt mail`;
    - `checkout.completed first then collection.succeeded books once`; `duplicate webhook books once`;
    - `bank transfer paid: period paid_by bank_transfer, fee 3750`;
    - **`late bank transfer after EXPIRED is credited`** (purchase EXPIRED after 30 min; then succeeded → PAID, period from confirmation, alert `pro.late_payment`);
    - **`short or over amount goes to REVIEW`** (read-back 200000 or 300000 → REVIEW, money issue `pro_amount_mismatch`, no ledger rows, plan unchanged); `currency other than NGN goes to REVIEW`;
    - `price change after checkout opened confirms at the old price`;
    - `two concurrent purchases leave one open` (`Promise.allSettled`; one `PRO_PURCHASE_OPEN`);
    - `replay with the same key returns the same purchase and calls the partner once`; `same key, different amount → IDEMPOTENCY_CONFLICT`;
    - `expectedAmountMinor 200000 against 250000 → PRO_PRICE_CHANGED`;
    - `uncertain create → UNKNOWN, reconciled to PAID`; `stale PENDING the partner reports failed → EXPIRED`;
    - `a purchase while a month is queued is refused PRO_ALREADY_RENEWED`.
  - `pro-webhooks.test.mjs`: `unsigned webhook refused 400, nothing stored`; `platform event matches the purchase, never a tip attempt`; `platform event with no purchase is unmatched`; `a tip webhook still matches its attempt`; `failed after succeeded keeps PAID and raises pro.conflict`; `platform refund.paid on a Pro charge ends Pro and opens a money issue` (no longer "unmatched").
  - `pro-api.test.mjs`: `POST needs session, CSRF and Idempotency-Key`; `PRO_BILLING_ENABLED=false → 404 PRO_BILLING_OFF`; `GET /v1/me/pro shows price 250000 and methods ["card"] when balance flag off`; `no response contains /bachs/i`.
- [ ] **Step 2: Run** the build and the three integration files plus domain tests. Expected: FAIL.
- [ ] **Step 3: Implement**, mirroring `recordProviderEvent` (lock order: purchase, event insert, profile) and `reconcileAttempts`. The read-back is the authority; the webhook only triggers it. Regenerate OpenAPI and access-control docs.
- [ ] **Step 4: Run** the same plus `tests/integration/bachs-payment-webhooks.test.mjs`, `provider-events.test.mjs`, `reconcile.test.mjs`, `invariants.test.mjs`, `openapi.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): buy a Pro month by card or bank transfer through our payment partner`

### Task 7: Buy flow on the web (PR B4, after board approval)

**Gate:** after the owner approves the ProPage board (its Settings line: "You're on Pro · paid until 9 Dec" with "Manage"). There is no separate Settings Plan board on the canvas; if the owner wants one, it is drawn first.

**Files:**

- Modify: `apps/web/src/app/dashboard/settings/sections/plan.tsx` (reads `GET /v1/me/pro`: price, "Get Pro" only when `billingOn` and a price exists, confirm step naming the amount and dates, "Pro until …", "In grace until …" with Renew, Renew hidden while a month is queued).
- Create: `apps/web/src/app/dashboard/pro/[purchaseId]/page.tsx` (polls status: "Checking with our payment partner…", Paid, Failed, Expired, "We're checking this payment" for REVIEW).
- Modify: `apps/web/src/components/marketing/plan-preview.tsx` (drop "Granted by TipMe staff" when billing is on).
- Test: `tests/e2e/pro-billing.spec.ts` (new).

**Interfaces:** Consumes `GET /v1/me/pro`, `POST /v1/me/pro/purchases`, `GET /v1/me/pro/purchases/:id` (Task 6).

- [ ] **Step 1: Write failing e2e** (pretend payments): `card: Get Pro → /mock-checkout/mock_pro_… → Pay → Paid → Settings shows Pro until <date> and Pro QR designs unlock`; `cancel on the mock checkout leaves Free and the purchase resumable`; `bank transfer on the mock checkout → Paid`; `no page text matches /bachs/i`; `the pretend notice shows on the status page`; `expectAccessible and 320px on each step`.
- [ ] **Step 2: Run** `E2E_LANE=2 pnpm exec playwright test tests/e2e/pro-billing.spec.ts --workers=2`. Expected: FAIL.
- [ ] **Step 3: Implement** per the design constitution and the approved board.
- [ ] **Step 4: Run** the same plus `tests/e2e/pro.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): buy Pro by card or bank transfer from Settings`

### Task 8: Pay from the TipMe balance (PR B5; live waits partner Q1)

**Files:**

- Modify: `packages/payments/src/provider.ts` (`PayoutPort.collectToPlatform`, capability `platformCollect`); `packages/payments/src/bachs/payouts.ts` (sibling of `coverPayoutFee` at :533: `POST /v1/transfers`, `X-Account-Id: accountRef`, `destination: 'self'`, `transfer_group` = key, reuses `moneyWrite`, `TRANSFER_REFUSALS`, `checkedAmount`; `ORGANIZATION_IN_DEBT` and insufficient balance → `PayoutRejectedError`); mock provider scenarios `collect_ok`, `collect_refused`, `collect_uncertain`.
- Modify: `packages/database/src/operations/balance.ts:5` `balanceQuery` (reserve `pro_purchases` with `method='balance' AND status IN ('COLLECTING','UNKNOWN')`); `packages/database/src/operations/pro-purchases.ts` (`method: 'balance'` path using `holdsOf({ profileId })` (`payouts.ts:73`) and `withdrawalsFrozen` (`payouts.ts:471`), as `requestWithdrawal` (`payouts.ts:1556`) does).
- Create: `apps/worker/src/handlers/pro-collect.ts`.
- Modify: API setting `PRO_PAY_FROM_BALANCE` (`on`/`off`, default `off`; `production.env.example` says "off until our payment partner confirms this use, plan Q1"). `methods` includes `'balance'` only when on.
- Test: `packages/payments/test/bachs-collect.test.mjs` (new, fake transport), `packages/database/test/integration/pro-balance.test.mjs` (new), `packages/database/test/integration/withdrawals.test.mjs`.

**Interfaces:**

- Produces `collectToPlatform(input: { accountRef: string; amountMinor: bigint; currency: 'NGN'; idempotencyKey: string }): Promise<{ transferRef: string }>`.
- Produces `buildProBalancePosting(i: { amountMinor: bigint; profileId: string }): LedgerLine[]` = Dr `recipient_payable` (profile), Cr `subscription_revenue`. Posted only after the transfer succeeds.

- [ ] **Step 1: Write failing tests.**
  - `bachs-collect.test.mjs`: `sends X-Account-Id, destination self, amount "2500.00", Idempotency-Key tipme-pro-<id>`; `ORGANIZATION_IN_DEBT → PayoutRejectedError`; `network failure → UncertainProviderOutcomeError`.
  - `pro-balance.test.mjs` (Ada credited ₦9,000 by pretend tips):
    - `reserves 250000 and available drops to 650000 before collection`;
    - `after collection: pro.<id> balances, recipient_payable −250000, subscription_revenue +250000, plan pro`;
    - `₦2,000 available plus ₦4,000 confirming → INSUFFICIENT_BALANCE`;
    - `a person with a business share cannot spend the business's money`;
    - `a balance below zero after a reversal refuses`;
    - `refused collection → FAILED, reservation released, no ledger rows`;
    - `uncertain → UNKNOWN, stays reserved, one pro_collect_unknown issue, never retried`;
    - `withdrawal ₦5,000 and Pro ₦2,500 with ₦6,000 available → exactly one succeeds`;
    - `withdrawals frozen refuses a balance payment`;
    - `PRO_PAY_FROM_BALANCE=off → INVALID_INPUT and methods has no balance`.
- [ ] **Step 2: Run** payments build + test, the build, `pro-balance.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Partner balance read outside the transaction; then the profile lock, holds, `spendable`, insert `COLLECTING`, job committed with the row. Regenerate OpenAPI.
- [ ] **Step 4: Run** the same plus `withdrawals.test.mjs`, `payouts.test.mjs`, `invariants.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): pay for Pro from the TipMe balance, behind a flag`

### Task 9: Pro refunds, card only (PR B6; waits owner Q3)

**Files:** `packages/payments/src/bachs/provider.ts` (`refundPlatformCharge`: `POST /v1/refunds` with `charge_id`, `reference`, `idempotency_key`; after a network error look up by charge before retrying, since a blind retry returns 409); `packages/database/src/operations/serious-actions-registered.ts` (`pro.refund`, permission `pro.payments`, second approver, refused for `bank_transfer` and `balance` periods with "This payment can't be refunded through our payment partner"); posting via `buildReversalPosting` (`packages/domain/src/ledger.ts:145`): Dr `subscription_revenue`, Cr `platform_clearing`; `refund.paid` ends the period and runs `recomputePlan`.

- [ ] **Step 1: Failing tests** in `tests/integration/pro-refund.test.mjs`: `card month refund waits for a second person`; `refund.paid books the reversal once and plan goes free`; `refund.failed keeps Pro and opens a money issue`; `bank-transfer and balance months are refused`; `a second refund on the same payment is refused`.
- [ ] **Step 2: Run** the build and the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate OpenAPI and access-control docs.
- [ ] **Step 4: Run** the same plus `ops-approvals.test.mjs`, `invariants.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): staff refund a card-paid Pro month`

### Task 10: Auto-renew on a saved naira card (PR B7; later phase, gated)

**Gate:** do not start until (a) the partner answers Q3 (and Q4 if partner subscriptions are wanted instead), and (b) `docs/evidence/` holds the owner's sandbox record: an NGN card saved with `save_payment_method: true` on TipMe's own account, a `POST /v1/charges` on it succeeding off-session, and a declined one arriving as `collection.failed`.

**Shape (decided now, built then):** `PRO_AUTO_RENEW` flag (default off); opt-in tick at checkout sets `save_payment_method: true`; `payment_method.saved` stores provider ids only (`pro_saved_cards`); a `pro.renew` job at `ends_at − 24h` creates one `saved_card` purchase and calls `POST /v1/charges` once with `Idempotency-Key: tipme-pro-<purchaseId>`; `processing` is not success; failure sends `pro-renewal-failed` and grace applies as usual; reminders are skipped while auto-renew is on. Tests (fake transport): `charged once even if the job runs twice`; `collection.failed sends pro-renewal-failed and Pro ends after grace`; `no charge when auto-renew is off or a month is queued`.

- [ ] **Step 1–5:** write the tests above, see them fail, implement, see them pass, commit `feat(pro): renew Pro automatically on a saved card`.

### Task 11: Go-live checklist for billing (docs part can start now)

**Files:** `docs/runbooks/live-activation.md` (Pro section); `docs/evidence/` (the owner adds records).

- [ ] **Step 1:** Add to `live-activation.md` the sandbox evidence list, each with the result that proves it: **E1** own-account checkout (₦2,500, card `4242…`): events with no `account` and `organization_id` = TipMe's org, `fees.amount` present; **E2** the same paid by NGN bank transfer; **E3** a bank transfer paid after `expires_in_minutes` and one paid short (records partner Q2's answer); **E4** an `event_source=all` endpoint receives both a connected-account tip and E1; **E5** a test recipient account shows `transfers` capability `active`; **E6** a `destination: self` transfer of ₦2,500 moves available balance (only after partner Q1). Plus: TipMe's own account verified (no `ACCOUNT_NOT_ACTIVATED`), `BACHS_PLATFORM_ORGANIZATION_ID` set, `PRO_BILLING_ENABLED` on, `PRO_PAY_FROM_BALANCE` still off until Q1.
- [ ] **Step 2: Run** `pnpm format:check`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: Pro billing go-live checklist`

---

## Part 2: the Pro package (after billing, after board approval)

Each task below starts only when billing is live in pretend mode (B3 merged) and the owner has approved its board. Copy the approved board unchanged into `docs/design/redesign/boards/` in the same PR. "Coming" labels on /pro come off only when that feature ships to everyone on Pro.

What is already on dev from the 5 Nov Pro additions plan (`docs/superpowers/plans/2026-11-05-pro-additions.md`): PR 3, the supporter's opt-in (`drizzle/0080_supporters.sql`, `checkout.service.ts:176`), and the `early_access` changelog audience (`packages/contracts/src/changelog.ts:174`). Not on dev: the supporters list (PR 4), priority support (PR 2), where your tips come from (PR 5), the monthly recap (PR 6), the early-access switch (PR 1). This plan orders them; their steps stay in that plan.

### Task 12: The /pro page (PR K1, after ProPage board approval)

**Files:** `apps/web/src/app/pro/page.tsx` (rewritten from ProPage: "TipMe Pro — Grow your appreciation.", Personalise / Understand / Grow / Support, the Free list, the FAQ, price from `GET /v1/pro/price`); `apps/web/src/components/marketing/plan-preview.tsx`; `docs/design/redesign/boards/PagePro.dc.html:96` (sample amounts fixed to the ₦2,000 floor: Free `['₦2,000','₦5,000','₦10,000']`, own `['₦2,500','₦4,000','₦7,500']`; `[PRICE SET BY STAFF]` stays a placeholder); `docs/design/redesign/boards/ProPage.dc.html` (copied).

**States:** "Get Pro · ₦2,500 a month" only when `billingOn` and a price exists; otherwise the board's coming-soon block ("Pro is coming soon to buy. We'll show how to pay here when it's ready.") with today's "Ask for Pro"; no price → "Price coming soon", no number. A Pro visitor sees "You're on Pro · paid until <date>" and "Manage". Every unbuilt feature carries "Coming".

- [ ] **Step 1: Failing e2e** in `tests/e2e/pro-page.spec.ts`: `billing off: coming-soon block with ₦2,500 from the server and Ask for Pro`; `billing on: Get Pro`; `no price: "Price coming soon" and no ₦`; `Earnings analytics, Campaign links, Monthly recap, Priority support show "Coming" until built`; `no /bachs/i`; `the price is not in the page bundle` (grep the built chunk for `2,500` → none); `expectAccessible`, 320px; the phone foot key appears after the price block scrolls away.
- [ ] **Step 2: Run** `E2E_LANE=3 pnpm exec playwright test tests/e2e/pro-page.spec.ts --workers=2`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `tests/e2e/pricing.spec.ts`, `tests/e2e/marketing.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the /pro page, with honest Coming labels`

### Task 13: The Pro badge, option A (PR K2, after ProBadge board approval)

**Files:** `packages/ui/src/components.tsx:100` `ProBadge` (unchanged look; new optional `explain` prop renders it inside a `<button>` with `aria-label="TipMe Pro, a paid plan. What this means"` and `aria-expanded`, toggling a note); `apps/web/src/components/profile/recipient-card.tsx:193` (public page uses `explain`); note copy: "TipMe Pro is a paid plan, not a check on who runs the page. About Pro" (link `/pro`). The business page (`/b/…`) never renders `ProBadge`.

- [ ] **Step 1: Failing tests:** `packages/ui` unit `explain toggles the note and is a real button ≥44px target`; e2e `tests/e2e/profile.spec.ts`: `a Pro page shows the badge, tapping shows the note`; `a business page never shows the Pro badge`; `the badge is gone the day grace ends` (uses Task 4's expiry helper); `expectAccessible`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/ui test` and the e2e spec. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): explain the Pro badge as a paid plan`

### Task 14: Earnings analytics (PR K3, after ProEarnings board approval)

**Files:** `packages/database/src/operations/earnings.ts` (new): totals per week/month/year in Africa/Lagos, weeks from Monday, confirmed tips only, amounts after TipMe's 10%; `packages/contracts/src/earnings.ts`; `apps/api/src/profiles/earnings.controller.ts` (`GET /v1/me/earnings?period=week|month|year&at=…`; Free gets only this week, this month, all time); `packages/domain/src/earnings-notes.ts` (rules-based notes); `apps/web/src/app/dashboard/earnings/page.tsx`; CSV download reuses the tips export.

**Note rules (from the board):** facts and counts only, never "because", "AI", "smart" or "predict"; a note shows only with ≥ 10 tips in the period; best day needs ≥ 5 tips and ≥ a quarter of them; a period not over is compared with the same days of the one before; repeat supporters count only opted-in supporters (`tip_supporters`) and never name them, with the line "Counts only supporters who chose to be recognised."

- [ ] **Step 1: Failing tests:** domain `notes: 9 tips → no notes`; `best day 4 of 41 → no best-day note`; `Saturday 13 of 41 → "Most of your tips came on Saturdays: 13 of 41."`; `1–8 Nov compared with 1–8 Oct`; integration `pending tips are excluded`; `Free gets 403 PRO_ONLY for month=2026-10`; `repeat supporters count only opted-in rows`; e2e `tests/e2e/earnings.spec.ts`: Pro view, Free view with the example preview (never the person's own numbers), table alternative for the chart, `expectAccessible`.
- [ ] **Step 2: Run** the domain test, the build + integration file, the e2e spec. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate OpenAPI and access-control docs.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): earnings analytics with plain notes`

### Task 15: Where tips come from, then Campaign Studio (PR K4, after ProCampaigns board approval and owner Q5)

**Order:** first the Pro additions plan PR 5 ("where your tips come from", `tip_arrivals` keyed by `tip_id`), now unblocked by Task 1; then Campaign Studio in its own PR.

**Files (Campaign Studio):** schema `campaigns` (`id`, `profile_id`, `name` ≤ 40, `slug` checked like a handle and against TipMe's reserved words and other handles, `created_at`, `stopped_at`), `unique(profile_id, slug)`; `tip_arrivals.campaign_id` (nullable; no money table changes); `analytics_events.campaign_id` (nullable uuid; raw kept 90 days like the rest) and daily totals in `analytics_daily` with `metric='campaign_visits'`, `dimension=<campaignId>`; the public route: a rewrite `/@:handle/:campaign` → `/people/:handle/:campaign` beside today's `/@:handle` → `/people/:handle` (`apps/web/next.config.ts:82`), page `apps/web/src/app/people/[handle]/[campaign]/page.tsx` (or the shape the owner picks in Q5), that renders the normal tip page with no campaign name and passes the campaign to the visit event and checkout; `apps/api/src/profiles/campaigns.controller.ts` (list, create, rename, stop; Pro only; limit [N] from owner Q5); QR reuses My QR's looks and print formats with the campaign link; `apps/web/src/app/dashboard/campaigns/…`.

**Rules:** counts only, never who; a week or row with fewer than 3 tips shows "Fewer than 3" and hides Received; visits come from analytics (on in production since Task 1; still none for GPC/DNT visitors); a stopped or lapsed campaign link keeps opening the page so printed codes never break; when Pro lapses the Campaigns screen hides and results are kept.

- [ ] **Step 1: Failing tests:** `slug that is a reserved word or another handle is refused`; `a campaign link opens the page with no campaign name in the HTML`; `a tip started from the link records campaign_id on tip_arrivals only`; `visits counted per campaign, none with Sec-GPC: 1`; `a row with 2 tips shows "Fewer than 3"`; `a stopped campaign's link still opens the page`; `on Free, POST /v1/me/campaigns → 403 PRO_ONLY and the link still works`; e2e `tests/e2e/campaigns.spec.ts` list, create, detail, `expectAccessible`.
- [ ] **Step 2: Run** the build + `tests/integration/campaigns.test.mjs`, the e2e spec. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate OpenAPI and access-control docs.
- [ ] **Step 4: Run** the same plus `tests/integration/analytics.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): Campaign Studio, a tracked link and QR for each place`

### Task 16: Monthly recap and priority support (PR K5)

- **Monthly recap:** build the Pro additions plan PR 6 as written (its tasks 6.1–6.5), after Task 7. The /pro "Coming" label on Monthly recap comes off in the same PR.
- **Priority support:** build the Pro additions plan PR 2 (tasks 2.1–2.6) only after the owner names who answers and the response target (owner Q4); the target is a setting, not a hard-coded number.
- **Supporters list:** the Pro additions plan PR 4, after Task 7.

Each follows that plan's test-first steps and commits; this plan adds only: `the /pro Coming label is removed by the PR that ships the feature` (assert in `tests/e2e/pro-page.spec.ts`).

---

## Self-review notes

- Spec coverage: price (T3), second approver and lone admin (T3), new months only (T3/T6), queued month (T4), grace and reminders (T4), lapse hides (T4), card/bank checkout (T5/T6), no staff transfer flow (none planned), balance (T8), auto-renew later (T10), analytics default (T1), refunds (T9), runbook `event_source=all` (this PR), package items (T12–T16), stale boards (T3, T12).
- Annual plan: deliberately absent (owner Q1).
