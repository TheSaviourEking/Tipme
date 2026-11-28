# TipMe Giving, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Churches, religious organisations and charities can register, get verified by TipMe staff, set up categories (and, on Pro, branches), print QR codes, and receive guest gifts at `/give/<org>[/<branch>][/<category>]` on the pretend payment provider, with a dashboard, email receipts and ops screens, all behind the `giving` switch on staging only.

**Architecture:** Giving gets its own tables (`giving_*`), its own NestJS module (`apps/api/src/giving/`), database operations (`packages/database/src/operations/giving-*.ts`), contracts (`packages/contracts/src/giving.ts`), pure rules (`packages/domain/src/giving.ts`) and web routes (`/give`, `/gift`, `/dashboard/giving`, `/ops/giving`). It copies Business's patterns (manager check that answers 404, invitations by hashed code, slug lock on verify, `business.verify` serious action, cached public reads with a revalidation tag) without sharing Business's tables. Gifts reach money through one **collection boundary** (`GiftCollection`), implemented in phase 1 only by the pretend provider. The real adapter (O1), pricing (O2), Pro price (O3), virtual accounts (O4) and VAT (O5) are named seams with `TODO(O1)`…`TODO(O5)`. Giving Pro reuses `pro_prices`, `pro_purchases` and `pro_periods` with a third owner column.

**Tech Stack:** TypeScript strict, NestJS (API), BullMQ worker, Drizzle/Postgres (drizzle-kit migrations), Zod contracts, Next.js App Router (web), `node --test`, Playwright with `@axe-core/playwright`. One new server dependency: `pdfkit` (Task 15).

**Spec:** `docs/superpowers/specs/2026-11-23-tipme-giving-design.md` (approved, PR #326). §n means a section of the spec. Read all of it before any task.

## Global Constraints

- **Switch:** `giving` in `FEATURE_SWITCHES`. It is a money switch, off by default, `env: onOff('GIVING')`, and stays `notBuilt: true` until Task 20. With it off, every Giving route answers 404 exactly like an unknown path (`GivingEnabledGuard` first on every Giving controller, ops ones included) and Individual and Business behave byte for byte as today. Staging only. Never turned on in production in this plan (owner, 23 Nov 2026).
- **Pretend money only:** the only `GiftCollection` is the pretend provider's. With `PAYMENT_PROVIDER` `bachs-sandbox` or `bachs-live`, starting a gift throws `GIVING_COLLECTION_NOT_CHOSEN` (`TODO(O1)`). No test calls `api.bachs.io` or `sandbox-api.bachs.io`. No real-partner (Bachs) money code, no live activation.
- **Open decisions are seams, never guesses:** anything that needs O1–O5 is a named stub with a `TODO(On)` comment naming the decision: settlement details, the Paid out card and timeline step, the Settlement view, refunds, disputes, ledger postings for gifts (`bookGift` is a no-op), fee bookings, the giver fee, VAT, virtual accounts, and the Giving Pro price value (it is a staff setting with no default; Pro can't be bought until it is set).
- **Copy:** every word a giver or organisation reads comes from `GIVING_COPY` in `packages/contracts/src/copy.ts`. Users never see the provider's name: always "our payment partner". Never "wallet", "donation account", "licensed", "regulated", "approved", "insured" or "protected". The exact strings the spec fixes: "What would you like to give towards?", "Not sure? Give to {Organisation}", "Paying to {Organisation} · {Category}", "Give {amount}", "Paid via TipMe for {Organisation}", "Share my contact with {Organisation}", "Verified".
- **Sensitive data (§8):** the giver's name is optional and its field is shown only when the organisation turned on "ask for name" (off by default). The receipt email is used only for the receipt, sealed at rest (`sealSecret` with the mail sealing key), and shown to the organisation only if the giver ticked "Share my contact with {Organisation}". No giving profile across gifts: nothing links two gifts by email, device or name. Exports contain the name only when the giver gave it, and the email only when shared. No phone field anywhere (receipts are email only until D-11).
- **Not an approval:** D-04, D-06, D-07 and D-11 stay open. Never edit `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md` or `docs/design/redesign/README.md`. No copy implies TipMe or Giving is licensed, regulated or approved.
- **Money format:** integer minor units (`bigint`, kobo) plus `'NGN'`. Amount fields in contracts are integer strings, never floats. The platform minimum is `FEE_POLICY_*.minTipMinor` (₦2,000, `200_000n`); read it, never copy it.
- **Backend verification:** a gift is `successful` only after the server reads the payment back from the provider (`GiftCollection.verify`). A return URL, query string or webhook body alone never makes it successful.
- **Migrations:** one generated file per task that changes the schema, via `pnpm --filter @tipme/database generate`, named with the **next free number at build time** (feat/profit-guards and feat/fee-waivers also add migrations; rename on rebase). Never edit a migration that has merged.
- **Reuse:** Business roles/invitation model, QR generation (`apps/web/src/lib/qr-render.ts`, `business-sign.ts`), the tip amount input (`AmountChoice` from `@tipme/ui`, `amountOptions` from `apps/web/src/lib/tip-amounts.ts`), status tokens (`createStatusToken`), ops list pages, `enqueueMail`, the switch system, `ensureSchedule`, chart components in `apps/web/src/components/dashboard/`. No new client dependency.
- **Process:** each task is one PR into `dev`, in task order. Test first: watch every new test fail, then pass. API-changing PRs regenerate OpenAPI (`pnpm --filter @tipme/api build && pnpm api:openapi`) and docs (`pnpm docs:generate`). Integration tests run with `--test-concurrency=1`. E2E lanes 3–8 only (this plan uses `E2E_LANE=6`), never 9; new or changed specs pass `--repeat-each=5 --retries=0`. Linux visual baselines only from CI artifacts. UI PRs put phone (390) and desktop (1440) screenshots, test data only, on the `pr-assets` branch under `pr-<number>/`, and link them in the PR body. No `--no-verify`, no bare `git stash`. The repo is public: no personal data in tests, fixtures or screenshots. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Every PR states the switch state it was tested with.
- **Worker:** new schedules only through `ensureSchedule` (it keeps `SCHEDULED_RUN_RETENTION`; the 21 Nov Redis incident). Prefer adding Giving work to an existing tick over a new schedule.

## Review Focus

1. **A whole congregation behind one church Wi-Fi address** starts 500 gifts in a minute. Expected: none is refused for sharing the address; one device starting too many is. _Test:_ `500 gift starts from one address with distinct device keys all succeed; the 31st from one device in a minute is 429` (Task 18).
2. **A printed branch QR code or archived category link after Pro lapses** (or the branch is closed, or the category archived). Expected: it opens the organisation's main page (with the category picker, no branch picker), never a 404 or dead end. _Test:_ `a branch link on a lapsed organisation answers the main page with no branch`, `an archived category link answers the main page with the picker` (Task 8).
3. **The giver comes back from checkout before the server has verified the payment.** Expected: the receipt says pending and turns successful only after read-back; a forged return URL or an unsigned webhook never makes it successful. _Test:_ `the receipt is pending until read-back says succeeded` (Task 12) and `a webhook for a gift only triggers a read-back` (Task 18).
4. **A giver who left an email without ticking "share my contact".** Expected: the email appears in no dashboard answer, CSV, Excel, PDF or ops screen, and is deleted after 180 days. _Test:_ `an unshared email is in no organisation answer or export` (Task 11), `reports carry no unshared email` (Task 15), `receipt emails older than 180 days are deleted unless shared` (Task 17).
5. **A crafted gift request to an unverified or suspended organisation**, or to a hidden or archived category. Expected: refused `409 GIVING_NOT_TAKING_GIFTS` / `404 GIVING_CATEGORY_NOT_FOUND`, nothing started at the provider. _Test:_ `an unverified organisation never starts a checkout` (Task 18), with the page state in Task 8.

## Rulings on spec gaps (this plan's calls; owner questions are in the hand-off)

- **G1 Tables.** Giving does not reuse `businesses`/`business_locations`; its own tables keep Business's checks and code untouched (§10 leaves it to the builder).
- **G2 Slugs.** Organisation slug: Business's charset (lower-case letters, digits, inner hyphens), 3–40 long, refused if `isReservedHandle` or an active staff reservation (`activeReservation`). Branch and category slugs: 1–30, same charset, one namespace per organisation enforced by the `giving_slugs` table. `give` and `gift` join `RESERVED_HANDLES`.
- **G3 Receipts** live at `/gift/<giftId>` (like `/tip/<tipId>`), so no branch or category slug is ever reserved.
- **G4 Quick picks.** The spec's ₦1,000 default is below the ₦2,000 platform minimum; defaults are ₦2,000, ₦5,000, ₦10,000 and an organisation can't save a pick below the minimum (owner question 1).
- **G5 Maximum gift.** A staff Giving setting; unset means no maximum beyond the input bound, as for tips.
- **G6 Admin limits.** Free: owner + 1 HQ admin. Pro: 25 admins (as Business Pro's staff limit), Finance and Viewer roles, branch admins.
- **G7 Analytics range.** Free: periods up to 92 days, and "how people gave" split QR vs link only. Pro: up to 3 years, plus card vs bank transfer.
- **G8 Gift statuses.** `pending | successful | failed | refunded` (`refunded` unused until O1). A checkout not paid within its 30-minute life becomes `failed` with `failure = 'not_paid'`.
- **G9 Document download.** Staff view a verification document inline with `private.view`, a fresh code and a reason; every open is audited (`giving_document.open`). No second person (owner question 4).
- **G10 Lapse is reversible.** §7.1's archiving sets `lapse_archived_at` / `lapse_suspended_at`; renewal clears exactly those, so everything returns as it was.
- **G11 Gift events** are stored in `giving_gift_events`, not in `provider_events`, so tip event code is untouched.
- **G12 Checkout methods before O2.** The pricing seam reports TipMe's share as unknown; the gift start passes `tipmeShareMinor: 0n` to `checkoutMethodsFor`, which offers bank transfer only (the safe side; the pretend checkout ignores it). `TODO(O2)`.
- **G13 Privacy register.** None exists in the repo; Task 17 creates `docs/security/privacy-register.md` with the Giving entries.

## Shared files (other branches are changing these; keep Giving's edits to what it needs)

- `packages/contracts/src/switches.ts`, `docs/runbooks/settings-and-switches.md`: one new key and row (fee waivers retires `business_payout_fee_absorbed` here).
- `packages/contracts/src/ops-catalogue.ts`, `serious-actions-registered.ts`: one permission, two actions (fee waivers adds `fee_waiver.set`; profit guards adds `card_costs.change`).
- `packages/database/src/schema.ts` and `drizzle/`: new tables only, plus Task 13's owner column on `pro_*` (profit guards adds `card_cost_settings`; fee waivers adds `fee_waivers`).
- `apps/api/src/checkout/mock-checkout.controller.ts`, `apps/api/src/webhooks/webhook.service.ts`, `packages/payments/src/mock/mock-provider.ts`: Task 18 adds a `mock_gift_` branch only (profit guards touches the checkout service and the Bachs adapter, not these branches).
- `packages/database/src/operations/pro-purchases.ts`, `pro-periods.ts`, `apps/worker/src/job-worker.ts`: Tasks 13–14 add an organisation case.
- `packages/database/src/operations/fee-waivers.ts` (on feat/fee-waivers): Task 19 adds one export.

## Commands

| What                    | Command                                                                                                                                   | Passing output      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Domain tests            | `pnpm --filter @tipme/domain build && pnpm --filter @tipme/domain test`                                                                   | `# fail 0`          |
| Contracts tests         | `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`                                                             | `# fail 0`          |
| Mail tests              | `pnpm --filter @tipme/mail build && pnpm --filter @tipme/mail test`                                                                       | `# fail 0`          |
| Payments tests          | `pnpm --filter @tipme/payments build && pnpm --filter @tipme/payments test`                                                               | `# fail 0`          |
| Web unit tests          | `pnpm --filter @tipme/web test`                                                                                                           | `# fail 0`          |
| Worker tests            | `pnpm --filter @tipme/worker test`                                                                                                        | `# fail 0`          |
| One integration file    | `pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test --test-concurrency=1 <file>` | `# fail 0`          |
| Migration check         | `pnpm --filter @tipme/database generate` after your migration                                                                             | "No schema changes" |
| E2E (one spec)          | `E2E_LANE=6 pnpm test:e2e -- tests/e2e/<spec>.ts --repeat-each=5 --retries=0 --workers=2`                                                 | 0 failed            |
| Whole gate (every task) | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`                                                                           | exit 0              |

---

# Part 1: everything that touches neither tip checkout nor fees

### Task 1: The `giving` switch, reserved words, rules and copy

**Files:**

- Modify: `packages/contracts/src/switches.ts` (key and catalogue entry), `packages/domain/src/handles.ts` (`give`, `gift` in `RESERVED_HANDLES`), `packages/contracts/src/copy.ts` (`GIVING_COPY`), `packages/domain/src/index.ts`, `playwright.config.ts` (seed `GIVING: 'on'` beside `BUSINESS_ENABLED`), `docs/runbooks/settings-and-switches.md` (row in the "Registered for open pull requests" table, "Not built yet")
- Create: `packages/domain/src/giving.ts`, `apps/api/src/giving/giving-enabled.guard.ts`, `apps/api/src/giving/giving.module.ts` (registered in `apps/api/src/app.module.ts`)
- Test: `packages/domain/test/giving.test.mjs`, `packages/contracts/test/giving-copy.test.mjs`, `tests/integration/giving-flag.test.mjs`; `apps/web/test/short-links.test.mjs` already enforces `give` once a `/give` folder exists (Task 9)

**Interfaces:**

- Produces (`@tipme/domain`):
  ```ts
  export const GIVING_ORG_TYPES = [
    'church',
    'mosque',
    'other_religious',
    'ngo_charity',
    'other',
  ] as const;
  export type GivingOrgType = (typeof GIVING_ORG_TYPES)[number];
  export const GIVING_DEFAULT_CATEGORIES: readonly {
    slug: string;
    name: string;
    icon: GivingIcon;
  }[];
  // tithe/Tithe, offering/Offering, thanksgiving/Thanksgiving, building-project/Building Project, welfare/Welfare, other/Other
  export const GIVING_ICONS: readonly string[];
  export type GivingIcon = (typeof GIVING_ICONS)[number];
  export const GIVING_FREE_CATEGORY_LIMIT = 6;
  export const GIVING_FREE_ADMIN_LIMIT = 1; // besides the owner
  export const GIVING_PRO_ADMIN_LIMIT = 25;
  export const GIVING_DEFAULT_QUICK_PICKS_MINOR = [
    200_000n,
    500_000n,
    1_000_000n,
  ] as const; // G4
  export const GIVING_DEFAULT_GRACE_DAYS = 14;
  export const GIVING_RECEIPT_EMAIL_DAYS = 180;
  export const GIVING_FREE_RANGE_DAYS = 92;
  export const GIVING_PRO_RANGE_DAYS = 1096; // G7
  export function organisationSlugProblem(
    raw: string,
  ): SlugProblem | 'too_short' | 'reserved' | null; // G2
  export function givingPathSlugProblem(raw: string): SlugProblem | null; // 1–30
  export const GIVING_ROLES = [
    'owner',
    'hq_admin',
    'branch_admin',
    'finance',
    'viewer',
  ] as const;
  export type GivingRole = (typeof GIVING_ROLES)[number];
  export const GIVING_PRO_ROLES: readonly GivingRole[]; // branch_admin, finance, viewer
  export const GIVING_ACTIONS = [
    'view_all',
    'view_branch',
    'manage_org_categories',
    'manage_branch_categories',
    'manage_branches_admins',
    'export',
    'reports',
    'edit_profile',
    'manage_verification_plan',
  ] as const;
  export type GivingAction = (typeof GIVING_ACTIONS)[number];
  export function givingMay(
    role: GivingRole,
    action: GivingAction,
    where?: { ownBranch: boolean },
  ): boolean;
  export function newGiftReference(random?: Uint8Array): string; // `TMG-XXXX-XXXX`, Crockford base32
  ```
- Produces (contracts): `'giving'` in `FEATURE_SWITCHES`, `GIVING_COPY` (object of strings and `(name: string) => string` functions for every phrase in Global Constraints, plus `notTakingGifts: (org) => \`${org} isn’t taking gifts yet.\``, `partner: 'our payment partner'`).
- Produces (API): `GivingEnabledGuard` (exported from `GivingModule`): 404 `NOT_FOUND` while `giving` is off.

- [ ] **Step 1: Write the failing tests.**
  - domain: `givingMay` reproduces §3's table row by row, e.g. `givingMay('branch_admin','view_all')` → false; `givingMay('branch_admin','export',{ownBranch:true})` → true, `{ownBranch:false}` → false; `givingMay('viewer','export')` → false, `givingMay('viewer','reports')` → true; `givingMay('finance','manage_org_categories')` → false; `givingMay('hq_admin','edit_profile')` → true, `givingMay('hq_admin','manage_verification_plan')` → false; `owner` → true for every action.
  - domain: `organisationSlugProblem('give')` → `'reserved'`; `('ab')` → `'too_short'`; `('grace-assembly')` → null; `('Grace')` → `'characters'`; 41 chars → `'too_long'`. `givingPathSlugProblem('building-project')` → null. `GIVING_DEFAULT_CATEGORIES.map(c => c.name)` deep-equals the six names in §6.3 order. `newGiftReference()` matches `/^TMG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/`. `isReservedHandle('gift')` → true.
  - contracts: every `GIVING_COPY` string (functions called with `'Grace Assembly'`) contains none of `/bachs|wallet|licen[cs]ed|regulated|approved|insured|protected/i`; `GIVING_COPY.payingTo('Grace Assembly','Offering')` === `'Paying to Grace Assembly · Offering'`; `GIVING_COPY.paidVia('Grace Assembly')` === `'Paid via TipMe for Grace Assembly'`.
  - integration `giving-flag`: with `giving` off, `GET /v1/give/anything` and `GET /v1/me/giving-roles` answer 404 `NOT_FOUND` with the same body as an unknown path; `/ops/switches` lists `giving` with `notBuilt: true` and turning it on is `409 SWITCH_NOT_BUILT`.
- [ ] **Step 2: Run** domain, contracts and the integration file. Expected: FAIL (`givingMay is not a function`, unknown switch key).
- [ ] **Step 3: Implement.** Catalogue entry: label "TipMe Giving", description "Organisations can register and receive gifts through a QR code or link, on pretend money until the money flow is decided. Off, every Giving page answers as if it did not exist.", `money: true`, `default: false`, `notBuilt: true` with a comment pointing at Task 20.
- [ ] **Step 4: Run** the same tests. Expected: PASS. Then the whole gate.
- [ ] **Step 5: Commit** `feat(giving): switch, reserved words, rules and copy`.

### Task 2: Giving tables

**Files:**

- Modify: `packages/database/src/schema.ts` (new "TipMe Giving" section after the business tables), `packages/database/src/test-support.ts` (truncate list), `packages/contracts/src/ops.ts` (`ISSUE_KINDS` gains `giving_waiting`)
- Create: migration `packages/database/drizzle/<next free>_giving.sql` (generated)
- Test: `packages/database/test/integration/giving-schema.test.mjs`

**Interfaces:**

- Produces (Drizzle tables, every id `uuid`, every time `timestamptz`):
  - `givingOrganisations` (`giving_organisations`): `id, slug unique, name (1–80), type (GIVING_ORG_TYPES), description (≤500, null), contactName (1–80), contactEmail (3–254), contactPhone (≤32, null), country ('NG' only), status ('pending'|'verified'|'suspended'), verifiedAt, verifiedBy, suspendedAt, suspendedReason, logoPath, logoVersion int, coverPath, coverVersion int, plan ('free'|'pro', default 'free'), proLapsedAt, branchesOn bool false, askName bool false, otherAsksPurpose bool false, quickPicksMinor bigint[] (3 values), studioStyle text default 'classic', studioAccent text null, weeklySummary bool false, lapseKeepCategoryIds uuid[] null, lapseKeepAdminId uuid null, createdBy, createdAt`. Checks mirror `businesses_suspended` and `businesses_verified`.
  - `givingImages` (`giving_images`): PK `(organisationId, kind 'logo'|'cover')`, `version, bytes bytea null, objectKey null` (exactly one, as `business_logos`).
  - `givingBranches`: `id, organisationId, slug, name (1–60), city (1–60), closedAt, createdAt`.
  - `givingCategories`: `id, organisationId, branchId null (branch-only), slug, name (1–40), icon, position int, hidden bool, archivedAt, lapseArchivedAt, createdAt`.
  - `givingSlugs`: PK `(organisationId, slug)`, `branchId null, categoryId null`, exactly one set (G2).
  - `givingAdmins`: `id, organisationId, userId, role (GIVING_ROLES), branchId (set iff branch_admin), addedBy, createdAt, removedAt, lapseSuspendedAt`; unique open `(organisationId, userId)`; at most one open `owner` per organisation.
  - `givingInvitations`: `id, organisationId, role (not owner), branchId, target ('email'|'link'), emailLower, codeSha256 unique, invitedBy, createdAt, expiresAt, acceptedAt, acceptedBy, declinedAt, revokedAt` (outcome check as `business_invitations_outcome`).
  - `givingVerifications`: `id, organisationId, state ('draft'|'submitted'|'more_needed'|'approved'), registeredName, registrationNumber, contactPerson, authorityNote (≤500), submittedBy, submittedAt, decidedBy, decidedAt, staffNote (≤500)`; at most one row per organisation not `approved`.
  - `givingDocuments`: `id, verificationId, kind ('registration_certificate'|'proof_of_authority'|'other'), contentType ('application/pdf'|'image/png'|'image/jpeg'), sizeBytes (1–5_242_880), bytes null, objectKey null (exactly one), uploadedBy, createdAt`.
  - `givingGifts`: `id, organisationId, branchId null, categoryId, reference unique, amountMinor (>0), currency 'NGN', status ('pending'|'successful'|'failed'|'refunded'), failure ('not_paid'|'declined'|'amount_mismatch', null), method ('card'|'bank_transfer', null), source ('qr'|'link'), giverName (≤60, null), note (≤140, null), purposeNote (≤80, null), receiptEmailSealed null, receiptEmailHint null, shareContact bool, provider, providerReference unique null, idempotencyKey unique, createdAt, verifiedAt`; indexes `(organisationId, createdAt desc)`, `(organisationId, branchId, createdAt desc)`, `(status, createdAt)`.
  - `givingAuditEvents`: `id, organisationId, actorUserId null (null = TipMe staff or the system), action (GIVING_AUDIT_ACTIONS), subjectId text null, createdAt`; index `(organisationId, createdAt desc)`. `GIVING_AUDIT_ACTIONS` = `category.add|category.change|category.archive|branch.add|branch.change|branch.close|branches.on|branches.off|admin.invite|admin.join|admin.remove|profile.change|verification.submit|verification.decided|plan.change|export.csv|export.report|look.change|settings.change` (exported from contracts).
  - `givingSettings`: append-only `id, graceDays (1–60), maxGiftMinor null, requiredDocuments text[], effectiveFrom, setBy, reason, createdAt`, with the append-only trigger pattern of `0118_plan_fee_rates.sql`.

- [ ] **Step 1: Write the failing test** `giving-schema.test.mjs`: inserting a category and a branch with the same slug in one organisation through `giving_slugs` fails with a unique violation; a `giving_slugs` row with both `branch_id` and `category_id` fails its check; a second open `owner` admin fails; a branch_admin without `branch_id` fails; a `giving_documents` row of 5_242_881 bytes fails; `UPDATE giving_settings` raises; `country = 'GH'` fails.
- [ ] **Step 2: Run** the file. Expected: FAIL (relation `giving_slugs` does not exist).
- [ ] **Step 3: Add the tables, then generate** the migration with `pnpm --filter @tipme/database generate`, rename to the next free number, add the append-only trigger by hand below the generated SQL.
- [ ] **Step 4: Run** the file and the migration check. Expected: PASS, "No schema changes".
- [ ] **Step 5: Commit** `feat(giving): tables`.

### Task 3: Register an organisation, its profile, logo and cover

**Files:**

- Create: `packages/database/src/operations/giving-access.ts`, `giving-organisations.ts`, `giving-images.ts`, `giving-audit.ts`; `packages/contracts/src/giving.ts` (exported from the barrel); `apps/api/src/giving/giving-manage.controller.ts`, `giving-images.controller.ts`, `giving-roles.controller.ts`
- Modify: `packages/contracts/src/errors.ts` and `apps/api/src/http/api-exception.filter.ts` (codes below), `apps/api/src/checkout/rate-limit.guard.ts` (`giving_apply`: 10 per signed-in person per hour, like `business_apply`), `packages/database/src/operations/errors.ts`
- Test: `packages/database/test/integration/giving-organisations.test.mjs`, `tests/integration/giving-manage-api.test.mjs`

**Interfaces:**

- Consumes: Task 1 rules, Task 2 tables, `activeReservation` (`profiles.ts`), `reencodeTo` (as `business-logo.controller.ts`), `PhotoStore`.
- Produces:

  ```ts
  // giving-access.ts — every refusal is NOT_A_GIVING_ADMIN, answered 404 GIVING_ORGANISATION_NOT_FOUND
  export async function givingAdminOf(
    db: Database | Tx,
    userId: string,
    organisationId: string,
    need: { action: GivingAction; branchId?: string },
  ): Promise<{
    adminId: string;
    role: GivingRole;
    branchId: string | null;
    plan: 'free' | 'pro';
  }>;
  // giving-audit.ts
  export async function recordGivingAudit(
    tx: Tx | Database,
    input: {
      organisationId: string;
      actorUserId: string | null;
      action: GivingAuditAction;
      subjectId?: string;
      now: Date;
    },
  ): Promise<void>;
  // giving-organisations.ts
  export function registerOrganisation(
    db: Database,
    userId: string,
    input: GivingRegistration,
    now?: Date,
  ): Promise<GivingOrganisationDetail>;
  export function organisationDetail(
    db: Database,
    userId: string,
    organisationId: string,
  ): Promise<GivingOrganisationDetail>;
  export function updateOrganisation(
    db: Database,
    userId: string,
    organisationId: string,
    patch: GivingOrganisationUpdate,
  ): Promise<GivingOrganisationDetail>;
  export function myGivingRoles(
    db: Database,
    userId: string,
  ): Promise<MyGivingRoles>;
  // giving-images.ts
  export function setGivingImage(
    db: Database,
    userId: string,
    organisationId: string,
    kind: 'logo' | 'cover',
    webp: Buffer,
    store?: PhotoStore,
  ): Promise<{ path: string }>;
  export function givingImageFor(
    db: Database,
    organisationId: string,
    kind: 'logo' | 'cover',
    version: number,
    store?: PhotoStore,
  ): Promise<Buffer | null>;
  ```

  Contracts: `givingRegistrationSchema` (`name, slug, type, contactName, contactEmail, contactPhone?, description?`), `givingOrganisationUpdateSchema` (all optional plus `askName, otherAsksPurpose, quickPicksMinor: [string,string,string], weeklySummary`), `GivingOrganisationDetail` (`id, slug, name, type, status, verification: GivingVerificationState, plan, branchesOn, askName, otherAsksPurpose, quickPicksMinor: string[], logoPath, coverPath, studioStyle, role: GivingRole, links: { page: string }`), `MyGivingRoles` (`organisations: { id, slug, name, role, logoPath }[]`).
  Routes: `POST /v1/me/giving/organisations` (201, `giving_apply`), `GET|PATCH /v1/me/giving/organisations/:id`, `PUT /v1/me/giving/organisations/:id/logo|cover` (raw image body, as the business logo), `GET /v1/giving-images/:orgId/:kind/:version.webp` (public, long cache, only for a verified organisation), `GET /v1/me/giving-roles`. Guards: `GivingEnabledGuard, SessionGuard, CsrfGuard` on writes.
  Error codes: `GIVING_ORGANISATION_NOT_FOUND` (404), `GIVING_SLUG_TAKEN` (409), `GIVING_SLUG_RESERVED` (409), `GIVING_SLUG_LOCKED` (409), `GIVING_NAME_LOCKED` (409), `GIVING_QUICK_PICK_TOO_SMALL` (400).

- [ ] **Step 1: Write the failing tests.**
  - `registerOrganisation` with a proven email makes a `pending` organisation, the registrant as `owner`, the six default categories in order (positions 0–5) with their `giving_slugs`, `quickPicksMinor` `[200000n,500000n,1000000n]`, and one `giving_waiting` issue carrying ids only. Without a proven email: `EMAIL_VERIFICATION_REQUIRED`.
  - slug `give` → `GIVING_SLUG_RESERVED`; a slug with an active staff reservation → `GIVING_SLUG_RESERVED`; a taken slug → `GIVING_SLUG_TAKEN` and nothing written.
  - after `status = 'verified'`: changing `slug` → `GIVING_SLUG_LOCKED`, `name` → `GIVING_NAME_LOCKED`; description and contacts still change and write `profile.change` to `giving_audit_events`.
  - a quick pick of `'199999'` → `GIVING_QUICK_PICK_TOO_SMALL`.
  - an HQ admin may change the description, not the slug (`manage_verification_plan` refused → 404 shape); a stranger's `GET` → 404 `GIVING_ORGANISATION_NOT_FOUND` with the same body as an unknown id.
  - API: `myGivingRoles` lists the organisation with role `owner`; `GET /v1/giving-images/...` for a pending organisation → 404.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** following `business-manage.ts` (`guarded`, one transaction, `onConflictDoNothing` on the slug, `openIssue` with `dedupeKey: giving_waiting:<id>`), and `business-logos.ts` for images (cover re-encoded like a profile cover).
- [ ] **Step 4: Run.** Expected: PASS. Regenerate OpenAPI.
- [ ] **Step 5: Commit** `feat(giving): register an organisation`.

### Task 4: Admins, roles and invitations

**Files:**

- Create: `packages/database/src/operations/giving-admins.ts`, `apps/api/src/giving/giving-admins.controller.ts`, `packages/mail/src/templates/types/giving.ts` (first type: `givingAdminInvitation`)
- Modify: `packages/mail/src/templates/registry.ts`, `packages/contracts/src/giving.ts`
- Test: `packages/database/test/integration/giving-admins.test.mjs`, `tests/integration/giving-admins-api.test.mjs`, `packages/mail/test/giving-mail.test.mjs`

**Interfaces:**

- Consumes: `givingAdminOf`, `recordGivingAudit` (Task 3); `INVITATION_DAYS` (`@tipme/domain`); `enqueueMail`.
- Produces:

  ```ts
  export function inviteGivingAdmin(
    db: Database,
    sealing: MailSealing,
    userId: string,
    organisationId: string,
    input: GivingInvitationRequest,
    now?: Date,
  ): Promise<{ invitationId: string; link: string | null }>;
  export function acceptGivingInvitation(
    db: Database,
    userId: string,
    code: string,
    now?: Date,
  ): Promise<{ organisationId: string; role: GivingRole }>;
  export function declineGivingInvitation(
    db: Database,
    userId: string,
    code: string,
    now?: Date,
  ): Promise<void>;
  export function listGivingAdmins(
    db: Database,
    userId: string,
    organisationId: string,
  ): Promise<GivingAdminRow[]>;
  export function removeGivingAdmin(
    db: Database,
    userId: string,
    organisationId: string,
    adminId: string,
    now?: Date,
  ): Promise<void>;
  export async function assertCanAddGivingAdmin(
    tx: Tx,
    organisationId: string,
    role: GivingRole,
    plan: 'free' | 'pro',
  ): Promise<void>;
  export const givingJoinLink = (code: string) =>
    `/dashboard/giving#join=${code}`;
  ```

  `GivingInvitationRequest` = `{ role: Exclude<GivingRole,'owner'>; branchId?: string; target: { kind: 'email'; email: string } | { kind: 'link' } }`. Mail `giving_admin_invitation` (`account`, sender `notifications`, no preference): data `{ organisationName, roleWords, link }`. Errors `GIVING_ADMIN_LIMIT` (409), `GIVING_PRO_REQUIRED` (409), `INVITATION_INVALID` (reused).

- [ ] **Step 1: Write the failing tests.**
  - Free: owner invites one `hq_admin` (ok); a second open invitation or admin → `GIVING_ADMIN_LIMIT`; inviting `finance`, `viewer` or `branch_admin` → `GIVING_PRO_REQUIRED`. Pro: 25 non-owner admins, the 26th → `GIVING_ADMIN_LIMIT`.
  - only roles that may `manage_branches_admins` may invite; a branch admin inviting → 404 shape.
  - accept by code twice in parallel → one admin row, the second `ALREADY_A_MEMBER`; an expired, revoked or declined code → `INVITATION_INVALID`; only the code's sha256 is stored.
  - removing the owner → `GIVING_OWNER_REQUIRED`; removal keeps the row with `removed_at` and writes `admin.remove`.
  - mail: rendered text contains the organisation name and no `/bachs|wallet/i`; the link is personal (redacted in the snapshot).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** after `business-invitations.ts` (`newCode`, `sha256`, fragment-only link, row lock on accept).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): admins and invitations`.

### Task 5: Verification submission and staff review (API)

**Files:**

- Create: `packages/database/src/operations/giving-verification.ts`, `giving-ops.ts`; `apps/api/src/giving/giving-verification.controller.ts`; `apps/api/src/ops/giving.controller.ts` (registered in `OpsModule`, `GivingEnabledGuard` first)
- Modify: `packages/contracts/src/ops-catalogue.ts` (permission `giving.manage`, sensitive, group `people`, "Verify, suspend and restore Giving organisations, with a reason"; `SERIOUS_ACTIONS` + words + permission for `giving.verify`: "Verify a Giving organisation"), `packages/database/src/operations/serious-actions-registered.ts` (`givingVerify`), `packages/mail/src/templates/types/giving.ts` (`givingVerificationOutcome`), registry, the role seed that gives owners every permission (follow how `collect.manage` was added)
- Test: `packages/database/test/integration/giving-verification.test.mjs`, `tests/integration/giving-ops-api.test.mjs`

**Interfaces:**

- Consumes: Tasks 2–4; `acting`, `requestSeriousAction`, `pendingOr`, `@FreshCode()`, `@OpsPermission`.
- Produces:

  ```ts
  export function saveVerification(
    db: Database,
    userId: string,
    organisationId: string,
    input: GivingVerificationInput,
  ): Promise<GivingVerificationView>;
  export function addVerificationDocument(
    db: Database,
    userId: string,
    organisationId: string,
    doc: {
      kind: GivingDocumentKind;
      contentType: GivingDocumentType;
      bytes: Buffer;
    },
    store?: PhotoStore,
  ): Promise<{ documentId: string }>;
  export function submitVerification(
    db: Database,
    userId: string,
    organisationId: string,
    now?: Date,
  ): Promise<GivingVerificationView>;
  // giving-ops.ts
  export function opsGivingVerificationQueue(
    db: Database,
    q: { state?: 'submitted' | 'more_needed'; cursor?: string },
  ): Promise<OpsGivingQueueRow[]>;
  export function opsGivingOrganisation(
    db: Database,
    organisationId: string,
  ): Promise<OpsGivingOrganisationDetail>;
  export async function verifyGivingOrganisation(
    tx: Tx,
    input: {
      organisationId: string;
      staffUserId: string;
      reason: string;
      now: Date;
    },
  ): Promise<{ slug: string }>;
  export function requestMoreVerification(
    db: Database,
    input: {
      organisationId: string;
      staffUserId: string;
      note: string;
      reason: string;
      sealing: MailSealing;
      now?: Date;
    },
  ): Promise<void>;
  export function suspendGivingOrganisation(
    db: Database,
    input: { organisationId: string; staffUserId: string; reason: string },
  ): Promise<{ slug: string; changed: boolean }>;
  export function restoreGivingOrganisation(
    /* same */
  ): Promise<{ slug: string; changed: boolean }>;
  export function openGivingDocument(
    db: Database,
    input: { documentId: string; staffUserId: string; reason: string },
    store?: PhotoStore,
  ): Promise<{ contentType: GivingDocumentType; bytes: Buffer }>;
  ```

  `requiredDocuments` comes from the giving settings in force (default `['registration_certificate','proof_of_authority']`, `TODO(O1)`: option A adds the partner's business checks). Routes: `GET|PUT /v1/me/giving/organisations/:id/verification`, `POST .../verification/documents` (raw body, `Content-Type` one of the three, ≤ 5 MB else `PAYLOAD_TOO_LARGE`), `POST .../verification/submit`; ops `GET /v1/ops/giving/verifications` and `GET /v1/ops/giving/organisations/:id` (`search.view`), `POST .../:id/verify` (`giving.manage`, fresh code, `ops_request`, serious), `POST .../:id/request-more|suspend|restore` (`giving.manage`, fresh code, reason), `POST .../:id/documents/:docId/open` (`private.view`, fresh code, reason; G9). Mail `giving_verification_outcome` (`account`, `notifications`): `{ organisationName, outcome: 'verified' | 'more_needed', note: string | null }`.

- [ ] **Step 1: Write the failing tests.**
  - submit with a document missing → `GIVING_DOCUMENTS_MISSING`; complete → `submitted`, the `giving_waiting` issue stays open.
  - `giving.verify` with a second staff member waits (202); a lone admin acts alone; an organisation's own admin who is staff can neither ask nor decide (`subjects`); verifying makes `status = 'verified'`, `verified_by`, writes `verification.decided`, resolves the issue and queues `giving_verification_outcome` once.
  - a slug change after asking makes the approval stale (pinned on slug and status).
  - `request-more` sets `more_needed`, stores the note and mails it; the organisation can submit again.
  - `open` without `private.view` → 403; with it, returns the bytes, and an `audit_events` row `giving_document.open` with the reason; opening never changes the verification.
  - the queue and the detail answer no contact email in full (masked as `listOpsBusinesses` does).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** after `business.verify` (`businessVerifyFacts`, `businessManagerUsers`) and `revealBusinessContact`.
- [ ] **Step 4: Run.** Expected: PASS. Regenerate OpenAPI.
- [ ] **Step 5: Commit** `feat(giving): verification and staff review`.

### Task 6: Categories

**Files:**

- Create: `packages/database/src/operations/giving-categories.ts`, `apps/api/src/giving/giving-categories.controller.ts`
- Test: `packages/database/test/integration/giving-categories.test.mjs`, `tests/integration/giving-categories-api.test.mjs`

**Interfaces:**

- Consumes: `givingAdminOf`, `recordGivingAudit`, `givingPathSlugProblem`, `GIVING_FREE_CATEGORY_LIMIT`.
- Produces:

  ```ts
  export function listGivingCategories(
    db: Database,
    userId: string,
    organisationId: string,
    q: { branchId?: string },
  ): Promise<GivingCategoryRow[]>;
  export function addGivingCategory(
    db: Database,
    userId: string,
    organisationId: string,
    input: GivingCategoryInput,
    now?: Date,
  ): Promise<GivingCategoryRow>;
  export function updateGivingCategory(
    db: Database,
    userId: string,
    organisationId: string,
    categoryId: string,
    patch: GivingCategoryUpdate,
  ): Promise<GivingCategoryRow>;
  export function reorderGivingCategories(
    db: Database,
    userId: string,
    organisationId: string,
    ids: string[],
  ): Promise<void>;
  export function archiveGivingCategory(
    db: Database,
    userId: string,
    organisationId: string,
    categoryId: string,
    now?: Date,
  ): Promise<void>;
  export function deleteGivingCategory(
    db: Database,
    userId: string,
    organisationId: string,
    categoryId: string,
  ): Promise<void>;
  export async function activeCategoryCount(
    tx: Tx,
    organisationId: string,
  ): Promise<number>; // not hidden, not archived, not lapse-archived
  ```

  `GivingCategoryInput` = `{ name, slug, icon, branchId? }`; a `branchId` makes it branch-only and needs `manage_branch_categories` for that branch, otherwise `manage_org_categories`. Errors `GIVING_CATEGORY_LIMIT` (409), `GIVING_SLUG_TAKEN` (shared with branches), `GIVING_CATEGORY_HAS_GIFTS` (409), `GIVING_CATEGORY_NOT_FOUND` (404). Routes under `/v1/me/giving/organisations/:id/categories`.

- [ ] **Step 1: Write the failing tests.**
  - Free: with 6 active categories, adding a 7th → `GIVING_CATEGORY_LIMIT`; hiding one frees a place; un-hiding past the limit → `GIVING_CATEGORY_LIMIT`. Pro: a 7th and an 8th succeed.
  - a category slug equal to an existing branch slug → `GIVING_SLUG_TAKEN` (one namespace); after archiving a category its slug stays taken (printed links never point elsewhere).
  - deleting a category with one gift → `GIVING_CATEGORY_HAS_GIFTS`; without gifts it goes, and its slug is freed.
  - a branch admin adds a branch-only category at their branch (ok) and at another branch (404 shape); a branch admin can't edit an organisation category.
  - reorder with an id from another organisation → `GIVING_CATEGORY_NOT_FOUND`, nothing moved; each change writes its audit action.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**; the limit check and insert share a transaction holding `FOR UPDATE` on the organisation row.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): categories`.

### Task 7: Branches and branch scope (Pro)

**Files:**

- Create: `packages/database/src/operations/giving-branches.ts`, `apps/api/src/giving/giving-branches.controller.ts`
- Test: `packages/database/test/integration/giving-branches.test.mjs`, `tests/integration/giving-branches-api.test.mjs`

**Interfaces:**

- Consumes: Tasks 3, 4, 6.
- Produces:

  ```ts
  export function setBranchesOn(
    db: Database,
    userId: string,
    organisationId: string,
    on: boolean,
    now?: Date,
  ): Promise<GivingOrganisationDetail>;
  export function addGivingBranch(
    db: Database,
    userId: string,
    organisationId: string,
    input: GivingBranchInput,
    now?: Date,
  ): Promise<GivingBranchRow>;
  export function updateGivingBranch(
    db: Database,
    userId: string,
    organisationId: string,
    branchId: string,
    patch: GivingBranchUpdate,
  ): Promise<GivingBranchRow>;
  export function closeGivingBranch(
    db: Database,
    userId: string,
    organisationId: string,
    branchId: string,
    now?: Date,
  ): Promise<void>;
  export function listGivingBranches(
    db: Database,
    userId: string,
    organisationId: string,
  ): Promise<GivingBranchRow[]>;
  /** Read-time Pro gate used by every later read: branches count only while plan = 'pro' and branchesOn. */
  export function branchesInForce(org: {
    plan: 'free' | 'pro';
    branchesOn: boolean;
  }): boolean;
  ```

  Branch slugs are locked once the organisation is verified (as categories' printed links). Errors `GIVING_PRO_REQUIRED`, `GIVING_SLUG_TAKEN`, `GIVING_SLUG_LOCKED`.

- [ ] **Step 1: Write the failing tests.**
  - Free: `setBranchesOn(true)` → `GIVING_PRO_REQUIRED`; Pro: on, then add branch `ikeja` (city Lagos) ok; a branch slug equal to a category slug → `GIVING_SLUG_TAKEN`.
  - `givingAdminOf(..., { action: 'view_branch', branchId: other })` for a branch admin → `NOT_A_GIVING_ADMIN`; for HQ → ok.
  - turning branches off keeps every branch and branch admin row; `branchesInForce({ plan: 'pro', branchesOn: false })` → false; `({ plan: 'free', branchesOn: true })` → false.
  - after verification, renaming a branch's slug → `GIVING_SLUG_LOCKED`; its name and city still change.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): branches`.

### Task 8: Public giving reads and address resolution

**Files:**

- Create: `packages/database/src/operations/giving-public.ts`, `apps/api/src/giving/giving-public.controller.ts`
- Modify: `apps/api/src/profiles/revalidate.ts` (`revalidateGiving(slug)`, beside `revalidateBusiness`); every Giving write in Tasks 3–7 and the ops actions in Task 5 call it after commit
- Test: `packages/database/test/integration/giving-public.test.mjs`, `tests/integration/giving-public-api.test.mjs`

**Interfaces:**

- Consumes: Tasks 2–7, `branchesInForce`.
- Produces:

  ```ts
  export function publicGivingPage(
    db: Database,
    orgSlug: string,
    path: string[],
    now?: Date,
  ): Promise<PublicGivingPage | null>;
  ```

  `PublicGivingPage` = `{ organisation: { slug, name, logoPath, coverPath, verified: boolean, takingGifts: boolean, look: { style: StudioStyleId; accent: StudioAccentId | null } }, branch: { slug, name, city } | null, branches: { slug, name, city }[] | null /* null = no picker */, category: PublicGivingCategory | null, categories: PublicGivingCategory[], askName: boolean, asksPurpose: boolean, quickPicksMinor: string[], minMinor: string, maxMinor: string | null, canonicalPath: string }`. `takingGifts` = verified and not suspended (`TODO(O1)`: and settlement details set). Routes `GET /v1/give/:org`, `/v1/give/:org/:a`, `/v1/give/:org/:a/:b`, `Cache-Control: no-store` (the web caches), no rate limit (pages are cached at the edge). Resolution: `:a` is looked up in `giving_slugs`; `:a/:b` must be branch then category. Anything that no longer resolves (closed branch, branches not in force, archived/hidden/lapse-archived category, category of another branch) falls back to the organisation page with `canonicalPath` set to what was kept, never null. Unknown organisation, or one never verified with the switch off → null (404).

- [ ] **Step 1: Write the failing tests.**
  - `/give/grace` with branches in force → `branches` listed (picker), `branch` null; with branches off or Free → `branches` null.
  - `/give/grace/ikeja` → `branch.slug 'ikeja'`, `branches` null; `/give/grace/offering` → `category.slug 'offering'`; `/give/grace/ikeja/youth` (branch-only category at Ikeja) → both set; `/give/grace/offering/ikeja` → falls back to `category: offering`, `canonicalPath '/give/grace/offering'`.
  - Review Focus 2: `a branch link on a lapsed organisation answers the main page with no branch` (`plan 'free'`, `branchesOn true`: `/give/grace/ikeja` → `branch null`, `branches null`, `canonicalPath '/give/grace'`); `an archived category link answers the main page with the picker` (`category null`, `categories` length 5).
  - Review Focus 5 (page half): a pending organisation → `takingGifts false`, `verified false`; a suspended one → `takingGifts false`.
  - `categories` lists the organisation's active categories plus, at a branch, that branch's own, in `position` order; never a hidden one; `minMinor` equals the platform minimum.
  - the answer contains no contact, admin or gift data (assert keys).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with one query per table (Sunday rush: no per-gift reads).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): public giving reads`.

### Task 9: Giving pages (web), up to the summary

Read `docs/design/DESIGN-CONSTITUTION.md`, `REFERENCE-ANATOMY.md`, `RESPONSIVE-COMPOSITION.md` and `VISUAL-QUALITY-GATE.md` first.

**Files:**

- Create: `apps/web/src/app/give/[org]/[[...path]]/page.tsx`, `apps/web/src/components/giving/{giving-header.tsx,branch-picker.tsx,category-grid.tsx,give-form.tsx,give-summary.tsx,giving-look.tsx,giving-unavailable.tsx}`, `apps/web/src/components/giving/giving.css`, `apps/web/src/lib/giving/public-api.ts`, `apps/web/src/lib/giving/giving-tag.ts`, `apps/web/src/lib/giving/give-flow.ts`
- Modify: `apps/web/src/app/globals.css` (`body:has(.giving-public…)` hides `.site-nav`, `.menu-toggle` and `.site-footer`, as the `.business-public` rule: logo-only header), the web revalidation route to accept `giving:<slug>`
- Test: `apps/web/test/give-flow.test.mjs`, `apps/web/test/short-links.test.mjs` (now sees `give`), `tests/e2e/giving-page.spec.ts`

**Interfaces:**

- Consumes: Task 8 `PublicGivingPage`, `GIVING_COPY`, `AmountChoice`, `amountOptions`, `studioTokens` (`packages/contracts/src/studio-styles.ts`).
- Produces:

  ```ts
  // lib/giving/public-api.ts — 'use cache', cacheLife({ stale: 30, revalidate: 30, expire: 300 }), cacheTag(givingTag(org))
  export async function getPublicGivingPage(
    org: string,
    path: string[],
  ): Promise<PublicGivingPage | null>;
  // lib/giving/give-flow.ts — pure, tested
  export type GiveStep =
    'branch' | 'category' | 'amount' | 'details' | 'summary';
  export function firstStep(page: PublicGivingPage): GiveStep;
  export interface GiveDraft {
    branchSlug: string | null;
    categorySlug: string | null;
    amountMinor: bigint | null;
    name: string;
    email: string;
    shareContact: boolean;
    note: string;
    purposeNote: string;
    source: 'qr' | 'link';
  }
  export function amountProblem(
    amountMinor: bigint,
    page: PublicGivingPage,
  ): 'below_min' | 'above_max' | null;
  export function summaryLines(
    draft: GiveDraft,
    page: PublicGivingPage,
  ): { payingTo: string; amount: string; fee: string | null; total: string };
  ```

  `GiveSummary` takes `onGive: (draft: GiveDraft) => Promise<void>` and `giveEnabled: boolean`; in this task the page passes `giveEnabled={false}` and shows `GIVING_COPY.notTakingGifts` instead of the button when `takingGifts` is false. Task 18 wires `onGive`. `source` is `qr` when the URL has `?src=qr` (the codes in Task 10 print it), else `link`; the query is dropped from the canonical URL. Look: Free or no Pro → Classic tokens; Pro → `studioTokens(style, accent)` on `.giving-public`. Metadata: title = organisation name, `robots: noindex` until Task 20's owner call (staging only).

- [ ] **Step 1: Write the failing tests.**
  - `firstStep`: picker present → `'branch'`; branch link → `'category'`; category link → `'amount'`.
  - `summaryLines` with branch Ikeja, category Offering, ₦10,000 → `payingTo 'Paying to Grace Assembly · Ikeja · Offering'`, `fee null`, `total '₦10,000'` (fee is null until Task 18's pricing seam; `TODO(O2)`).
  - `amountProblem(199_999n)` → `'below_min'`; with `maxMinor '5000000'`, 5_000_001n → `'above_max'`.
  - e2e (`giving-page.spec.ts`, seeded verified Pro organisation with a branch): phone 390 and desktop 1440; picker → "Not sure? Give to Grace Assembly" → category grid → quick pick ₦5,000 → details (no name field while `askName` off; email field labelled for the receipt; "Share my contact with Grace Assembly" unticked) → summary shows "Paying to Grace Assembly · Offering" and the disabled "Give ₦5,000"; the header shows only the TipMe logo; axe finds no violations; keyboard-only completes the flow; a pending organisation's link shows "Grace Assembly isn’t taking gifts yet.".
- [ ] **Step 2: Run** web tests and the spec. Expected: FAIL.
- [ ] **Step 3: Implement.** Server component page, client island for the form only.
- [ ] **Step 4: Run.** Expected: PASS, burn-in 5/5.
- [ ] **Step 5: Commit** `feat(giving): giving pages`. Screenshots (phone + desktop, each step) on `pr-assets`.

### Task 10: Organisation setup screens

**Files:**

- Create: `apps/web/src/app/dashboard/giving/{page.tsx,giving-shell.tsx,register/page.tsx}`, `apps/web/src/app/dashboard/giving/sections/{profile.tsx,verification.tsx,categories.tsx,branches.tsx,admins.tsx,codes.tsx,look.tsx,settings.tsx}`, `apps/web/src/app/dashboard/giving/codes/print/page.tsx`, `apps/web/src/lib/giving/{setup-api.ts,codes.ts}`
- Modify: `apps/web/src/lib/hats.ts` and `apps/web/src/components/dashboard/hat-switcher.tsx` (a `giving` hat from `GET /v1/me/giving-roles`), `apps/api/src/giving/giving-manage.controller.ts` (`PATCH .../look`: `studioStyle` must be in `STUDIO_FREE_STYLES` on Free → else `GIVING_PRO_REQUIRED`; Free stores Classic only per §9a)
- Test: `apps/web/test/giving-codes.test.mjs`, `apps/web/test/giving-hats.test.mjs`, `tests/integration/giving-look-api.test.mjs`, `tests/e2e/giving-setup.spec.ts`

**Interfaces:**

- Consumes: Tasks 3–8 routes; `qrMatrix`, `renderQrPixels`, `drawLocationSign`-style drawing from `business-sign.ts`.
- Produces:

  ```ts
  // lib/giving/codes.ts
  export interface GivingCode {
    label: string;
    path: string /* '/give/grace/ikeja/offering' */;
    url: string; /* with ?src=qr */
  }
  export function givingCodes(
    origin: string,
    org: { slug: string },
    branches: { slug: string; name: string }[] | null,
    categories: { slug: string; name: string; branchSlug: string | null }[],
  ): GivingCode[];
  ```

  One code per organisation, per branch, per category and per branch × category, only for what is in force. Codes are listed only once verified (as Business, M12). Sections hidden by role: a branch admin sees only their branch's categories and code; Finance and Viewer see no setup sections.

- [ ] **Step 1: Write the failing tests.**
  - `givingCodes` for an organisation with branch Ikeja and categories Tithe and Offering (no branch-only) → 1 + 1 + 2 + 2 = 6 codes; with `branches null` → 3; every `url` ends with `?src=qr`.
  - hats: an account with a page and a Giving organisation shows both; `hatHref` for the giving hat → `/dashboard/giving?org=<id>`.
  - API look: Free picking `journal` → `GIVING_PRO_REQUIRED`; Pro picking `journal` ok and writes `look.change`.
  - e2e: register (name, slug, type Church), see six default categories, rename one, try a 7th on Free and read the limit message, upload a document and submit for verification, see "Waiting for TipMe to check"; on a verified organisation download the organisation QR (PNG) and print page; axe clean; phone and desktop.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** following `apps/web/src/app/dashboard/business` (sections, `use-business-live` not needed in phase 1).
- [ ] **Step 4: Run.** Expected: PASS, burn-in 5/5.
- [ ] **Step 5: Commit** `feat(giving): organisation setup screens`. Screenshots on `pr-assets`.

### Task 11: Dashboard Giving view, transactions, export, gift detail, audit log

**Files:**

- Create: `packages/database/src/operations/giving-dashboard.ts`, `apps/api/src/giving/giving-dashboard.controller.ts`, `apps/web/src/app/dashboard/giving/{overview.tsx,transactions/page.tsx,gifts/[giftId]/page.tsx,audit/page.tsx}`, `apps/web/src/components/giving/giving-ring.tsx`
- Test: `packages/database/test/integration/giving-dashboard.test.mjs`, `tests/integration/giving-dashboard-api.test.mjs`, `tests/e2e/giving-dashboard.spec.ts`; fixture `packages/database/test/integration/giving-fixtures.mjs` (`seedOrganisation`, `seedGift` inserting `giving_gifts` rows directly)

**Interfaces:**

- Consumes: `givingAdminOf`, `branchesInForce`, `csvCell`, `EXPORT_LIMIT` (`export.ts`), `trend-chart.tsx`, `bar-chart.tsx`.
- Produces:

  ```ts
  export function givingOverview(
    db: Database,
    userId: string,
    organisationId: string,
    q: GivingPeriodQuery,
  ): Promise<GivingOverview>;
  export function listGifts(
    db: Database,
    userId: string,
    organisationId: string,
    q: GiftListQuery,
  ): Promise<{ rows: GiftRow[]; next: string | null }>;
  export function giftDetail(
    db: Database,
    userId: string,
    organisationId: string,
    giftId: string,
  ): Promise<GiftDetail>;
  export function exportGiftsCsv(
    db: Database,
    userId: string,
    organisationId: string,
    q: GiftListQuery,
    now?: Date,
  ): Promise<string>;
  export function listGivingAudit(
    db: Database,
    userId: string,
    organisationId: string,
    cursor?: string,
  ): Promise<{ rows: GivingAuditRow[]; next: string | null }>;
  ```

  `GivingPeriodQuery` = `{ from: string; to: string; branchId?: string }` (ISO dates, Lagos days; range over `GIVING_FREE_RANGE_DAYS` on Free → `GIVING_PRO_REQUIRED`). `GivingOverview` = `{ totalMinor, count, averageMinor, trend: { day, totalMinor }[], byCategory: { categoryId, name, totalMinor, count }[], byBranch: {…}[] | null, bySource: { qr, link }, byMethod: { card, bank_transfer } | null /* Pro */, recent: GiftRow[] }` — successful gifts only; there is no Paid out card (`TODO(O1)`). `GiftListQuery` = `{ q?: reference; categoryId?; branchId?; status?; from?; to?; cursor? }`. `GiftRow` = `{ id, reference, createdAt, category, branch, amountMinor, status, giver: 'Guest' | string }`. `GiftDetail` adds `method, source, note, purposeNote, contact: string | null /* only when shareContact */, timeline: { received: string; verified: string | null }` (Paid out step `TODO(O1)`; refund action `TODO(O1)`). A branch admin's every answer is filtered to their branch; `export` needs `export`. CSV columns: `time,reference,category,branch,amount,status,name,contact`. Routes: `GET .../overview|gifts|gifts/:giftId|gifts.csv|audit`; the CSV writes `export.csv` to the audit log.

- [ ] **Step 1: Write the failing tests.**
  - overview over 3 successful (₦5,000, ₦10,000, ₦15,000) and 1 failed gift → `totalMinor 3000000n`, `count 3`, `averageMinor 1000000n`; the failed one appears in `listGifts` with `status 'failed'`, not in totals.
  - a branch admin at Ikeja sees only Ikeja gifts in overview, list, detail (another branch's gift id → 404 shape) and CSV; HQ sees `byBranch`; on Free `byBranch` and `byMethod` are null.
  - Review Focus 4: `an unshared email is in no organisation answer or export` — a gift with `receiptEmailSealed` set and `shareContact false`: `giftDetail.contact` null, the CSV `contact` cell empty, and the email string absent from every JSON answer; with `shareContact true` it appears in detail and CSV.
  - `giver` is `'Guest'` when no name was given; the CSV `name` cell is empty then.
  - Free range of 93 days → `GIVING_PRO_REQUIRED`; Viewer `gifts.csv` → 404 shape.
  - e2e: overview cards and ring render with seeded gifts, filters by category and status, open a gift, timeline shows "Payment received" and "Verified", download CSV; axe clean.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (keyset paging on `(created_at, id)`; Lagos days via `LAGOS_TIME_ZONE`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): dashboard`. Screenshots on `pr-assets`.

### Task 12: Receipt page and email templates

**Files:**

- Create: `packages/database/src/operations/giving-receipts.ts`, `apps/api/src/giving/gift-receipt.controller.ts`, `apps/api/src/giving/gift-token.ts`, `apps/web/src/app/gift/[giftId]/{page.tsx,gift-status-view.tsx}`, `apps/web/src/lib/giving/pending-gift.ts`
- Modify: `packages/mail/src/templates/types/giving.ts` (`giftReceipt`, `givingFirstGift`), registry, `packages/domain/src/handles.ts` already has `gift` (Task 1)
- Test: `packages/database/test/integration/giving-receipts.test.mjs`, `tests/integration/gift-receipt-api.test.mjs`, `packages/mail/test/giving-mail.test.mjs`, `apps/web/test/gift-status.test.mjs`

**Interfaces:**

- Consumes: `createStatusToken`/`verifyStatusToken` (`status-token.ts`), `STATUS_TOKEN_SECRET`.
- Produces:

  ```ts
  export const giftTokenOf = (secret: string, giftId: string) =>
    createStatusToken(secret, `gift:${giftId}`);
  export function giftReceiptView(
    db: Database,
    giftId: string,
  ): Promise<GiftReceipt | null>;
  ```

  `GiftReceipt` = `{ reference, organisation: { name, slug, logoPath }, branch: string | null, category: string, amountMinor, createdAt, status, paidVia: string /* GIVING_COPY.paidVia(name) */ }`. `GET /v1/gifts/:giftId/receipt` with `Authorization: Bearer <token>`; a wrong or missing token is the same 404 as an unknown gift. Mail `gift_receipt` (`transactional`, sender `receipts`, no preference, tracking off): `{ organisationName, branch, category, amount, reference, time, receiptPath }`, subject "Your gift receipt", no amount in the subject. Mail `giving_first_gift` (`account`, `notifications`): `{ organisationName }`. Both are queued by Task 18.

- [ ] **Step 1: Write the failing tests.**
  - Review Focus 3 (receipt half): `the receipt is pending until read-back says succeeded` — a `pending` gift's receipt reads `status 'pending'` and the web view shows the pending line ("We’re confirming your gift with our payment partner."), never the success heading; flipping the row to `successful` shows it.
  - a token made for `tipId` equal to the gift id (no `gift:` prefix) is refused.
  - receipt answer has no email, name or note (assert keys).
  - mail renders "Paid via TipMe for Grace Assembly", the reference, and no `/bachs|wallet/i`; the receipt link is personal (redacted in the snapshot).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**; the web page keeps the token in the session under `pending-gift.ts` keys, as `pending-tip.ts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): receipts`. Screenshots (pending, successful, failed) on `pr-assets`.

### Task 13: Giving Pro price and billing

**Files:**

- Modify: `packages/database/src/schema.ts` (`pro_prices_plan` check adds `'giving'`; `pro_purchases` and `pro_periods` gain `organisation_id` FK, the owner checks become "exactly one of profile, business, organisation", plus `pro_purchases_organisation_one_open`, `pro_periods_organisation_start`, `pro_periods_organisation_one_scheduled`), `packages/database/src/operations/pro-price.ts` (`PRO_PRICE_PLANS` adds `giving`), `pro-purchases.ts` (organisation purchases, receipts to `bought_by`), `pro-periods.ts` (`startOrganisationPaidPeriod`, `recomputeOrganisationPlan`, grace from the giving settings), `serious-actions-registered.ts` (`giving_pro_price.change`), `ops-catalogue.ts`, `apps/api/src/webhooks/webhook.service.ts` (`signalPlan` ignores organisation purchases), `apps/api/src/ops/business-pro-price.controller.ts` pattern copied to `giving-pro-price.controller.ts`
- Create: migration `<next free>_giving_pro.sql`, `packages/database/src/operations/giving-plan.ts`, `apps/api/src/giving/giving-pro.controller.ts`, `apps/web/src/app/dashboard/giving/sections/plan.tsx`, `apps/web/src/app/ops/giving/pro-price/page.tsx`
- Test: `packages/database/test/integration/giving-pro.test.mjs`, `tests/integration/giving-pro-api.test.mjs`

**Interfaces:**

- Consumes: `currentProPrice`, `setProPrice`, `requestProPurchase`/`buyProByCheckout`, `confirmProCheckout`, `expireDuePeriods`, `sendProReminders`, `initializePlatformCheckout` (unchanged; profit guards keeps both methods for Pro).
- Produces:

  ```ts
  export async function recomputeOrganisationPlan(
    tx: Tx,
    organisationId: string,
    now: Date,
  ): Promise<{ changed: boolean; plan: 'free' | 'pro' }>;
  export async function startOrganisationPaidPeriod(
    tx: Tx,
    input: {
      organisationId: string;
      purchaseId: string;
      paidBy: ProPaidBy;
      amountMinor: bigint;
      now: Date;
    },
  ): Promise<void>; // grace_ends_at = ends_at + graceDays (GIVING_DEFAULT_GRACE_DAYS when no setting)
  export function givingProState(
    db: Database,
    userId: string,
    organisationId: string,
    now?: Date,
  ): Promise<GivingProState>;
  export function buyGivingPro(
    db: Database,
    userId: string,
    organisationId: string,
    input: { method: 'card' },
    provider: ProCheckoutProvider,
    urls: { successUrl: string; cancelUrl: string },
    now?: Date,
  ): Promise<ProPurchaseView>;
  ```

  `GivingProState` = `{ plan, priceMinor: string | null /* null: not for sale (O3) */, period: { endsAt, graceEndsAt, status } | null, lapsedAt }`. Only the owner may buy (`manage_verification_plan`). Never paid from gifts or the TipMe balance (§9a): `method` is `card` only (the partner's checkout offers card and bank transfer). Mails `giving_pro_reminder` (7 days and 1 day before the end), `giving_pro_grace_started`, `giving_pro_ended` in `types/giving.ts`, sent by `sendProReminders`' organisation case.

- [ ] **Step 1: Write the failing tests.**
  - with no `giving` price row: `GET .../pro` → `priceMinor null`; `buyGivingPro` → `GIVING_PRO_NOT_FOR_SALE` and no partner call (`TODO(O3)`: the price is a staff setting, no default).
  - staff set ₦7,000 (`giving_pro_price.change`, lone admin acts alone; with a second person waits); the owner buys on pretend money; confirmation starts a period with `grace_ends_at = ends_at + 14 days` and `organisations.plan = 'pro'`; an HQ admin buying → 404 shape.
  - a personal Pro price change does not change the Giving price (plans are separate).
  - reminders: 7 days and 1 day before the end and at grace start, each once (dedupe keys), to the owner only.
  - existing Pro and Business Pro tests still pass unchanged (`pnpm turbo run build --filter=!@tipme/web` then the `pro-*` and `business-pro-*` integration files).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, migration check clean.
- [ ] **Step 5: Commit** `feat(giving): Giving Pro price and billing`. Screenshots of the plan section and ops price page on `pr-assets`.

### Task 14: When Pro ends (§7.1)

**Files:**

- Modify: `packages/database/src/operations/giving-plan.ts`, `pro-periods.ts` (`expireDuePeriods` calls `applyGivingLapse` / `restoreGivingLapse` on an organisation's plan change), `apps/api/src/giving/giving-pro.controller.ts` (`POST .../pro/keep`), `apps/web/src/app/dashboard/giving/sections/plan.tsx` (keep chooser)
- Modify: `packages/domain/src/giving.ts`
- Test: `packages/domain/test/giving.test.mjs`, `packages/database/test/integration/giving-lapse.test.mjs`

**Interfaces:**

- Produces:

  ```ts
  // domain (§10 defaults)
  export function defaultKeptCategories(
    rows: readonly { id: string; giftsLast90Days: number; position: number }[],
    limit?: number,
  ): string[]; // most gifts, then position
  export function defaultKeptAdmin(
    rows: readonly { id: string; createdAt: Date }[],
  ): string | null; // longest-serving
  // database
  export function setLapseKeep(
    db: Database,
    userId: string,
    organisationId: string,
    input: { categoryIds: string[]; adminId: string | null },
  ): Promise<void>; // owner only; ≤ 6 categories, all organisation-level
  export async function applyGivingLapse(
    tx: Tx,
    organisationId: string,
    now: Date,
  ): Promise<void>;
  export async function restoreGivingLapse(
    tx: Tx,
    organisationId: string,
    now: Date,
  ): Promise<void>;
  ```

  `applyGivingLapse` runs when grace ends: sets `lapse_archived_at` on branch-only categories and on active organisation categories outside the keep list (or the default), `lapse_suspended_at` on every non-owner admin except the kept one and on every branch admin, Finance and Viewer; nothing else changes (branches, gifts and past attribution stay; the look falls back to Classic at read time). `restoreGivingLapse` clears exactly those marks on renewal.

- [ ] **Step 1: Write the failing tests.**
  - domain: 8 categories with gift counts `[9,0,5,5,1,7,3,2]` → the ids of counts 9,7,5,5,3,2 (ties by position).
  - integration: a Pro organisation with 8 categories, 2 branch-only categories, 3 admins and a branch admin, no keep choice: after grace → 6 active categories (by the default), branch-only archived, 1 admin kept (longest-serving), the branch admin loses access (`givingAdminOf` → not found), `publicGivingPage(org, ['ikeja'])` answers the main page; during the 14-day grace nothing changed.
  - with a keep choice, exactly those 6 and that admin stay.
  - renewing after lapse restores every category, admin and branch exactly (compare rows before and after); categories archived by hand before the lapse stay archived.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): when Pro ends`. Screenshots of the keep chooser on `pr-assets`.

### Task 15: Pro reports and the weekly summary

**Files:**

- Create: `apps/api/src/giving/reports/{xlsx.ts,pdf.ts,report-data.ts}`, `apps/api/src/giving/giving-reports.controller.ts`, `apps/web/src/app/dashboard/giving/reports/page.tsx`, `apps/worker/src/handlers/giving-weekly.ts`
- Modify: `apps/api/package.json` (`pdfkit`, `@types/pdfkit`, exact versions), `docs/third-party-component-register.md`, `packages/mail/src/templates/types/giving.ts` (`givingWeeklySummary`), `apps/worker/src/job-worker.ts` (the existing `WEEKLY_REPORTS_JOB` handler also calls `sendGivingWeeklySummaries`; no new schedule)
- Test: `apps/api/test/giving-xlsx.test.mjs`, `apps/api/test/giving-pdf.test.mjs`, `tests/integration/giving-reports-api.test.mjs`, `apps/worker/test/giving-weekly.test.mjs`

**Interfaces:**

- Produces:

  ```ts
  export function writeXlsx(
    sheets: { name: string; rows: (string | number)[][] }[],
  ): Buffer; // stored ZIP + zlib.crc32, no dependency
  export function renderGivingReportPdf(report: GivingReport): Promise<Buffer>;
  export type GivingReportKind = 'summary' | 'category' | 'branch';
  export function givingReport(
    db: Database,
    userId: string,
    organisationId: string,
    kind: GivingReportKind,
    q: GivingPeriodQuery,
  ): Promise<GivingReport>;
  export function sendGivingWeeklySummaries(
    db: Database,
    sealing: MailSealing,
    now: Date,
  ): Promise<{ queued: number }>;
  ```

  Routes `GET .../reports/:kind.pdf|.xlsx` (Pro only, `reports` permission; a branch admin gets their branch only; `branch` needs branches in force). The settlement report is `TODO(O1)`. Weekly summary: Pro organisations with `weeklySummary` on, Monday 07:00 Lagos, to the owner, last Lagos week's total, count and top category; never names a giver.

- [ ] **Step 1: Write the failing tests.**
  - `writeXlsx` output starts with `PK\x03\x04`, its central directory lists `[Content_Types].xml`, `xl/workbook.xml`, `xl/worksheets/sheet1.xml`, and the sheet XML contains the escaped cell `Tithe &amp; Offering`.
  - PDF starts with `%PDF-` and contains "Paid via TipMe for Grace Assembly" nowhere and "our payment partner" nowhere unless needed; it contains no `/bachs/i`.
  - Review Focus 4: `reports carry no unshared email` (PDF text and XLSX XML lack the sealed gift's email; a shared one appears in the summary's transactions sheet).
  - Free → `GIVING_PRO_REQUIRED`; Viewer gets reports (`reports` true), not CSV.
  - weekly: two Pro organisations, one with the summary on → `queued 1`; a re-run the same week queues nothing (dedupe `giving_weekly:<org>:<week>`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**; `report-data.ts` is the one source both formats read.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): Pro reports and weekly summary`. Screenshots of the reports page on `pr-assets`.

### Task 16: Ops screens

**Files:**

- Create: `apps/web/src/app/ops/giving/{page.tsx,verifications/page.tsx,organisations/[organisationId]/page.tsx,gifts/page.tsx,settings/page.tsx}`, `packages/database/src/operations/giving-settings.ts`
- Modify: `apps/api/src/ops/giving.controller.ts` (gift lookup, settings), `apps/web/src/lib/ops-menu.ts` (a "Giving" entry for `search.view`), `packages/contracts/src/ops-catalogue.ts` (`OPS_FRESH_CODE_EXEMPT` entry for the settings read, as `OpsCollectSettingsController.state`)
- Test: `packages/database/test/integration/giving-settings.test.mjs`, `tests/integration/giving-ops-api.test.mjs` (extend), `tests/e2e/giving-ops.spec.ts`

**Interfaces:**

- Produces:

  ```ts
  export function givingSettingsInForce(
    db: Database | Tx,
    now?: Date,
  ): Promise<{
    graceDays: number;
    maxGiftMinor: bigint | null;
    requiredDocuments: GivingDocumentKind[];
  }>;
  export function setGivingSettings(
    db: Database,
    input: {
      graceDays: number;
      maxGiftMinor: bigint | null;
      requiredDocuments: GivingDocumentKind[];
      staffUserId: string;
      reason: string;
      now?: Date;
    },
  ): Promise<void>;
  export function opsGiftByReference(
    db: Database,
    reference: string,
  ): Promise<OpsGiftRow | null>;
  ```

  Settings: `fees.manage`, fresh code, reason, audit (not money: grace and limits). `OpsGiftRow` = reference, organisation, branch, category, amount, status, method, times, `emailHint` (masked) only. The switch is turned on and off on the existing `/ops/switches` page.

- [ ] **Step 1: Write the failing tests.**
  - `givingSettingsInForce` with no rows → `{ graceDays: 14, maxGiftMinor: null, requiredDocuments: ['registration_certificate','proof_of_authority'] }`; a change effective at T applies from T.
  - gift lookup `TMG-ABCD-EFGH` finds the row and never answers the full email, name or note.
  - e2e: a staff member with `giving.manage` opens the queue, opens a document with a reason, verifies with a lone admin, sees "Verified"; staff without `giving.manage` see no Verify button; axe clean.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** following `apps/web/src/app/ops/businesses`.
- [ ] **Step 4: Run.** Expected: PASS, burn-in 5/5.
- [ ] **Step 5: Commit** `feat(ops): Giving screens`. Screenshots on `pr-assets`.

### Task 17: Privacy register, retention, runbook

**Files:**

- Create: `docs/security/privacy-register.md` (G13), `packages/database/src/operations/giving-retention.ts`, `apps/worker/src/handlers/giving-retention.ts`
- Modify: `apps/worker/src/job-worker.ts` (call it from the existing 01:00 Lagos `ANALYTICS_DAILY_JOB` handler; no new schedule), `docs/runbooks/settings-and-switches.md` (what `giving` on and off do)
- Test: `packages/database/test/integration/giving-retention.test.mjs`, `apps/worker/test/giving-retention.test.mjs`

**Interfaces:**

- Produces: `deleteExpiredReceiptEmails(db: Database, now: Date): Promise<{ deleted: number }>` (sets `receipt_email_sealed` and `receipt_email_hint` to null on gifts older than `GIVING_RECEIPT_EMAIL_DAYS` with `share_contact = false`). Documents are kept while active plus 6 years after closing (no job needed in phase 1; noted in the register as provisional until D-07).
- The register's Giving entries: giver name (optional, with the gift), receipt email (180 days unless shared), share-contact choice, note and purpose note, verification documents (private, staff view audited), organisation contacts; each marked "provisional until D-07 and a legal check".

- [ ] **Step 1: Write the failing test** (Review Focus 4): `receipt emails older than 180 days are deleted unless shared` — gifts at 181 days unshared → cleared; 181 days shared → kept; 179 days unshared → kept; a second run deletes 0.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** in batches of 1,000 by id.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): retention and privacy register`.

---

# Part 2: gift checkout and fees

> **Task boundary.** Part 2 starts only after the profit guards branch (`feat/profit-guards`: payment options by amount, `checkoutMethodsFor` in `packages/domain`, `paymentMethods` on the payment port) has merged to `dev`; use them. Rebase on `dev` and re-read `packages/domain/src/checkout-methods.ts`, `card-cost-settings.ts` (`cardCostAt`) and `packages/payments/src/provider.ts` before Task 18. Task 19 also waits for `feat/fee-waivers` (the `fee_waivers` table and the `giving` waiver kind) to merge.

### Task 18: The collection boundary and the gift checkout (pretend provider)

**Files:**

- Create: `packages/database/src/operations/giving-collection.ts`, `giving-gifts.ts`; `apps/api/src/giving/gift.controller.ts`, `apps/api/src/giving/gift-collection.provider.ts`, `apps/api/src/giving/gift-rate-limit.ts`; migration `<next free>_giving_gift_events.sql` (`giving_gift_events`: `id, provider, provider_event_id, gift_id, event_type, payload jsonb, received_at`, unique `(provider, provider_event_id)`)
- Modify: `packages/domain/src/giving.ts` (pricing seam), `packages/payments/src/mock/mock-provider.ts` (`initializeGiftCheckout`, reference `mock_gift_<uuid>`, one per gift), `apps/api/src/checkout/mock-checkout.controller.ts` (`GIFT_REFERENCE` branch: summary and pay, return to `/gift/<giftId>`), `apps/api/src/webhooks/webhook.service.ts` (`mock_gift_` → `applyGiftEvent`), `apps/worker/src/job-worker.ts` (gift reconciliation inside the existing `RECONCILE_JOB` tick), `apps/web/src/app/give/[org]/[[...path]]/page.tsx` and `give-summary.tsx` (wire `onGive`, `giveEnabled`), `apps/web/src/lib/giving/give-api.ts`
- Test: `packages/domain/test/giving.test.mjs`, `packages/payments/test/mock-gift.test.mjs`, `packages/database/test/integration/giving-gifts.test.mjs`, `tests/integration/gift-checkout-api.test.mjs`, `tests/e2e/giving-gift.spec.ts`

**Interfaces:**

- Consumes: `checkoutMethodsFor`, `CheckoutMethod`, `cardCostAt` (profit guards); `publicGivingPage` resolution rules (Task 8); `giftTokenOf` (Task 12); `givingSettingsInForce` (Task 16).
- Produces:

  ```ts
  // domain: the pricing seam (TODO(O2), TODO(O5))
  export interface GiftPrice {
    giverFeeMinor: bigint;
    giverTotalMinor: bigint;
    tipmeShareMinor: bigint | null;
    decided: false;
    openDecision: 'O2';
  }
  export function priceGift(input: {
    amountMinor: bigint;
    plan: 'free' | 'pro';
  }): GiftPrice; // giverFee 0, total = amount, share null
  // database: the collection boundary
  export interface GiftVerified {
    status: 'succeeded' | 'failed' | 'pending' | 'not_found';
    amountMinor: bigint;
    currency: string;
    method?: 'NGN_CARD' | 'NGN_BANK_TRANSFER';
  }
  export interface GiftCollection {
    readonly name: string;
    start(input: {
      giftId: string;
      amountMinor: bigint;
      currency: 'NGN';
      paymentMethods: readonly CheckoutMethod[];
      successUrl: string;
      cancelUrl: string;
      idempotencyKey: string;
    }): Promise<{
      providerReference: string;
      checkoutUrl: string;
      expiresAt: Date;
    }>;
    verify(providerReference: string): Promise<GiftVerified>;
  }
  /** TODO(O1): no-op until the money flow is chosen; then A or B books the gift here. */
  export async function bookGift(tx: Tx, giftId: string): Promise<void>;
  export function startGift(
    db: Database,
    collection: GiftCollection,
    input: GiftStart & { now?: Date; urls: { webOrigin: string } },
  ): Promise<GiftStarted>;
  export function recordGiftEvent(
    db: Database,
    input: {
      provider: string;
      providerEventId: string;
      eventType: string;
      providerReference: string;
      payload: unknown;
    },
  ): Promise<{ giftId: string | null }>;
  export function confirmGift(
    db: Database,
    input: {
      giftId: string;
      verified: GiftVerified;
      sealing: MailSealing;
      now: Date;
    },
  ): Promise<{
    outcome: 'successful' | 'failed' | 'still_pending' | 'already';
    organisationSlug: string;
  }>;
  export function reconcileGifts(
    db: Database,
    input: {
      collection: GiftCollection;
      sealing: MailSealing;
      now: Date;
      minAgeMs: number;
    },
  ): Promise<{ checked: number; successful: number; failed: number }>;
  // API
  export const GIFT_COLLECTION = Symbol('GIFT_COLLECTION'); // mock → pretendGiftCollection(mock); bachs-* → throws GIVING_COLLECTION_NOT_CHOSEN (TODO(O1))
  ```

  `GiftStart` (contracts `giftStartSchema`, strict): `{ organisation: slug, branch?: slug, category: slug, amountMinor: string, name?: string ≤60 (refused unless askName), email?: string, shareContact: boolean, note?: string ≤140, purposeNote?: string ≤80 (refused unless the category is Other and otherAsksPurpose), source: 'qr'|'link', idempotencyKey: uuid }`. `GiftStarted` = `{ giftId, receiptToken, checkoutUrl }`. `POST /v1/gifts`: no session, no CSRF (guest), `Cache-Control: no-store`. Idempotency key `tipme-gift-<giftId>`; the same `idempotencyKey` returns the same gift and checkout. `paymentMethods = checkoutMethodsFor({ amountMinor, tipmeShareMinor: price.tipmeShareMinor ?? 0n, card: await cardCostAt(db, now) })` (G12). Rate limits (§9a) in `gift-rate-limit.ts`: per device key (header `x-tipme-device`, a random id the page keeps in `sessionStorage`; missing → counted per address /64) 30 per minute, per organisation 3,000 per minute, and a per-address ceiling of 2,000 per minute; the tip `intents` per-address limit does not apply. Confirmation (once, under a row lock): `successful` only when `verified.status === 'succeeded'` and amount and currency match (else `failed`, `amount_mismatch`, and a `payment_mismatch` issue); then `bookGift`, the receipt email if an address was left (`gift_receipt`, dedupe `gift_receipt:<id>`), `giving_first_gift` on the organisation's first successful gift (dedupe `giving_first_gift:<org>`), `revalidateGiving` is not needed (pages show no totals). A `pending` gift older than 30 minutes that verifies `not_found` or `failed` becomes `failed` (`not_paid`).

- [ ] **Step 1: Write the failing tests.**
  - domain: `priceGift({ amountMinor: 1_000_000n, plan: 'free' })` deep-equals `{ giverFeeMinor: 0n, giverTotalMinor: 1_000_000n, tipmeShareMinor: null, decided: false, openDecision: 'O2' }`.
  - mock: two `initializeGiftCheckout` calls for one gift return one `mock_gift_` reference; `verifyTransaction` reads it back.
  - Review Focus 5: `an unverified organisation never starts a checkout` — `POST /v1/gifts` to a pending or suspended organisation → `409 GIVING_NOT_TAKING_GIFTS`, no `giving_gifts` row, the fake collection's `start` not called; a hidden or archived category → `404 GIVING_CATEGORY_NOT_FOUND`; a branch when branches are not in force → the gift is unbranched (as the page); ₦1,999.99 → `400 GIVING_AMOUNT_TOO_SMALL`; above `maxGiftMinor` → `400 GIVING_AMOUNT_TOO_LARGE`; `name` with `askName` off → 400 `VALIDATION_FAILED`.
  - the same `idempotencyKey` twice in parallel → one gift, one `start` call, the same `checkoutUrl`.
  - Review Focus 3: `a webhook for a gift only triggers a read-back` — a signed `payment.succeeded` while the pretend provider still says `pending` leaves the gift `pending`; after `settle`, the next delivery (or `reconcileGifts`) makes it `successful`; an unsigned webhook is refused before any read; a repeated event id is stored once.
  - amount mismatch → `failed`, `amount_mismatch`, one issue; the receipt email is queued exactly once across two confirmations; the first-gift mail once per organisation.
  - Review Focus 1: `500 gift starts from one address with distinct device keys all succeed; the 31st from one device in a minute is 429`.
  - `PAYMENT_PROVIDER=bachs-sandbox` (no-real-provider stand-in) → `POST /v1/gifts` answers `503 GIVING_COLLECTION_NOT_CHOSEN`, nothing sent.
  - the paid gift's `paymentMethods` recorded by the fake is `['bank_transfer']` (G12).
  - e2e `giving-gift.spec.ts`: scan link `?src=qr` → category → ₦5,000 → email → Give ₦5,000 → pretend checkout "succeed" → `/gift/<id>` shows pending then "Paid via TipMe for Grace Assembly" with the reference; the dashboard lists the gift as successful with source QR; "decline" shows the failed receipt; axe clean; phone and desktop.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** after `pro-purchases.ts` (`recordProEvent`, `confirmProCheckout`, `reconcileProPurchases`) and the `payPro` branch of the mock checkout.
- [ ] **Step 4: Run.** Expected: PASS, burn-in 5/5, migration check clean.
- [ ] **Step 5: Commit** `feat(giving): gift checkout on pretend money`. Screenshots (summary, pretend checkout, receipts) on `pr-assets`.

### Task 19: Fee waivers for Giving and the fee line

Starts after `feat/fee-waivers` has merged to `dev`. Do not reimplement its resolver.

**Files:**

- Modify: `packages/database/src/operations/fee-waivers.ts` (one export below), `packages/database/src/schema.ts` (`giving_gifts.fee_waiver_id` FK to `fee_waivers`), migration `<next free>_giving_fee_waiver.sql`, `packages/database/src/operations/giving-gifts.ts` (`startGift` records it), `packages/domain/src/giving.ts` (`priceGift` takes `waiver`), `apps/web/src/components/giving/give-summary.tsx` (fee line only when `giverFeeMinor > 0n`)
- Test: `packages/database/test/integration/giving-fee-waiver.test.mjs`, `packages/domain/test/giving.test.mjs`

**Interfaces:**

- Consumes: `FeeWaiverResolution`, `resolveFeeWaiver`, `FeeWaiverFee` (fee waivers, merged); Task 18 `priceGift`, `startGift`.
- Produces:

  ```ts
  /** Giving has kind-scope rules only (fee waivers W1): who pays `fee` on gifts at `now`. */
  export async function givingFeeWaiver(
    db: Database | Tx,
    input: { fee: FeeWaiverFee; now: Date },
  ): Promise<FeeWaiverResolution>;
  export function priceGift(input: {
    amountMinor: bigint;
    plan: 'free' | 'pro';
    waiver: { payer: 'tipme' | 'default'; ruleId: string | null };
  }): GiftPrice;
  ```

  A `tipme` waiver keeps the giver's total equal to the amount and is recorded on the gift (`fee_waiver_id`); what it costs TipMe is decided by O2 (`TODO(O2)`) and booked under O1 (`TODO(O1)`). Organisation-scope Giving waivers stay refused until a follow-up.

- [ ] **Step 1: Write the failing tests.** A kind rule `giving`/`tip`/`tipme` in force → the gift records its id; ended → null; `priceGift` with a `tipme` waiver → `giverFeeMinor 0n`, `giverTotalMinor` = amount; the summary renders no fee line in both cases.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): fee waivers for gifts`.

### Task 20: The switch is built (staging only)

**Files:**

- Modify: `packages/contracts/src/switches.ts` (remove `notBuilt` from `giving`, comment: built, off everywhere, production stays off until O1 is answered in writing), `docs/runbooks/settings-and-switches.md` (move the row to the product switches table; on/off behaviour; "Do not turn on in production: owner, 23 Nov 2026, staging only until O1"), `tests/integration/giving-flag.test.mjs`
- Test: the whole Giving e2e set on lane 6

- [ ] **Step 1: Change the flag test** to expect `notBuilt: false` and that turning `giving` on is the serious action `feature_switch.set` (a second person when one exists).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Remove the mark.**
- [ ] **Step 4: Run** the flag test, then `E2E_LANE=6 pnpm test:e2e -- tests/e2e/giving-*.spec.ts --repeat-each=5 --retries=0 --workers=2` and the whole gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(giving): switch built, off everywhere`. The PR body says the switch is off in every environment and names the launch gates still open (§9: O1 in writing, O2, the load test, two-person switch-on).

---

## Spec coverage

- §1–2 goals: Tasks 3, 5–12, 13–16. §3 roles: Tasks 1, 4, 7. §4.2 boundary: Task 18. §5 O1–O5: seams in Global Constraints and Tasks 11, 13, 15, 18, 19. §6.1 giver flow and addresses: Tasks 8, 9, 12, 18. §6.2 setup and verification: Tasks 3, 5, 10. §6.3: Task 6. §6.4: Task 7. §6.5: Tasks 11, 15. §6.6: Tasks 4, 5, 12, 13, 15, 18 (payout mails `TODO(O1)`). §6.7: Tasks 5, 16. §7 and §7.1: Tasks 4, 6, 7, 13, 14, 15. §8: Global Constraints, Tasks 8, 9, 17, 18. §9a: Tasks 9, 10, 12, 13, 17, 18. §10 builder calls: Rulings G1–G13.
- Not in phase 1, by the spec: settlement, payouts, Settlement view, refunds, disputes, reconciliation of settlement, fee bookings, virtual accounts, the real adapter, and the Sunday load test (a launch gate tied to the parked load-test work).
