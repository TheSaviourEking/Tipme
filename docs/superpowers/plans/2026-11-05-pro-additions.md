# Pro additions: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five additions that make Pro feel premium and personal. The owner approved them on 5 Nov 2026:

1. **Repeat supporters:** a supporter can choose, on the tip form, to let a Pro recipient recognise them next time. It uses option (a), a random key kept in the supporter's browser. It is off by default, offered only once a name is typed, and can be stopped from any receipt. The recipient's "Your supporters" list (Pro) shows only those who opted in.
2. **Priority support:** "Get help" in Settings for every plan. Requests go to a new staff Support queue where Pro requests sort first, with a clock against a target the owner sets.
3. **Where your tips come from:** each tip records the channel of the visit that started it (one short value, no personal data). A Pro card counts paid tips per channel and hides any row under 3. Collection is built **and stays off in production** behind the existing `ANALYTICS_ENABLED` switch until decision D-07.
4. **Monthly recap:** on the 1st of each month, Pro pages get a recap of the month and a shareable card. The card is built field by field, never names a supporter, and leaves out the naira total unless the person switches it on.
5. **Early access:** a Pro switch, "Try new features early", and a small registry of named features. Each feature is off, early (Pro with the switch on) or everyone. Staff move a feature along in the admin area. It is never used for money or account-safety flows.

**Owner's decision:** 5 Nov 2026 (memory `pro-additions-decision`; `progress.md` "Owner 5 Nov: build Pro additions"). It answers the board `ProAdditions.dc.html` (canvas v101). This is a product decision. It is not legal advice, and it is not a regulatory, data-protection or payment-partner approval. D-07 stays OPEN. No fee, minimum, checkout amount, ledger posting or payout changes anywhere in this plan.

**Excluded:**

- Board section 6, "Profile sections: services, portfolio, events", is tagged **Owner to confirm**, so nothing here builds it. See "Open for the owner".
- Tip goals and campaigns: TODO, review later, pending our payment partner's view (board footer; memory note).

**Board (static HTML, read as a spec):** `ProAdditions.dc.html`, in the session scratchpad `canvas-email/project/`. Task 1.0 copies it unchanged into `docs/design/redesign/boards/` so the repo holds the spec. `DesignMap.dc.html` and `ScreenAudit.dc.html` were read for context. Neither lists any of these screens as built.

**Architecture:**

- Every Pro-only display is resolved by the API, and the web shows what it is sent. A page that leaves Pro keeps everything stored and shows the Free version (the `tipAmountsOf` / `shownThanks` pattern).
- Pro-only writes use the existing check-then-conditional-update pattern: read the plan, refuse on Free, then add `eq(profiles.plan, 'pro')` to the `UPDATE`'s `WHERE` (`setThanks`, `setTipAmounts` in `packages/database/src/operations/profiles.ts`).
- Supporter recognition and tip channels live in their **own tables**, keyed by `tip_id`. The money tables (`tips`, `payment_intents`, `tip_quotes`, ledger) gain no column, so stopping recognition or purging channels never touches a money row.
- Shapes live in `packages/contracts`. Every new field is optional, because the web deploys before the API.

**Tech stack:** Drizzle/Postgres, NestJS, BullMQ worker, Next App Router, Zod, Playwright, `node --test`. No new dependency.

---

## What the code does today (origin/dev `931a545`, migrations 0070 to 0077)

**Supporters (board §1, "Exists"):**

- A tip stores only an optional name: `tips.payer_display_label` (`packages/database/src/schema.ts:956`, check `tips_label_length` at :968), cleaned by `cleanLabel` (`operations/intents.ts:62-71`).
- There is no email, phone, IP or device column on `tips` or `tip_messages` (`schema.ts:943-994`).
- `tip_messages.may_show` (0076) is the note-consent flag from make-it-yours.
- The request fingerprint is at `intents.ts:92-103`. Consent is appended only when given, so fingerprints without it stay byte-identical. This plan reuses that trick.
- "Remember my tips on this phone" (`apps/web/src/components/appreciation-form.tsx:478-491`) writes `tipme.myTips.v1` (`apps/web/src/lib/recognition.ts`) only after a paid receipt, via `pendingTipKey` in session storage (`appreciation-form.tsx:262-269`).
- "Forget my tips on this phone" is on the receipt (`apps/web/src/app/tip/[tipId]/status-view.tsx:149, 348`).
- `returningVisitor()` in analytics reads `MY_TIPS_KEY` (`apps/web/src/lib/analytics.ts:35-37`). It must **never** read the new supporter key.
- `PublicProfile.plan` exists (`packages/contracts/src/profiles.ts:158`). `PublicProfile` has no profile id.
- The receipt API is `GET /v1/tips/:tipId/status` with `Authorization: Bearer <status token>`. A bad token is 404 (`apps/api/src/checkout/status.controller.ts:41-60`).
- `createPaymentIntent` is called from `apps/api/src/checkout/checkout.service.ts:168-176`.

**Support (board §2):**

- Support is email only today: `support@usetipme.xyz` (`apps/web/src/lib/pilot.ts:7`, `app/recover/recover-flow.tsx:118`).
- The issues inbox (`ISSUE_KINDS`, `packages/contracts/src/ops.ts:218-246`; `operations/issues.ts`) holds system problems. Its subject is **ids only** (`OpsIssueSubject`, "no names, messages or numbers"), and its summaries are fixed words (`summaryOf`). Severity is `money | account | info` (`schema.ts:1690`).
- Permissions come from one catalogue (`packages/contracts/src/ops-catalogue.ts:6-27`). A new one needs a migration that regenerates `role_permissions_known` and `staff_permission_overrides_known` and grants it to `owner`. The pattern is `drizzle/0073_usernames_permission.sql`. It also needs a line in `docs/runbooks/admin-roles.md`, which `ops-catalogue.test.mjs` checks.
- The ops menu is filtered by permission in `apps/web/src/lib/ops-menu.ts:38`.

**Attribution (board §3):**

- The browser works out the channel in `referrerChannel(document.referrer, location.search)` (`apps/web/src/lib/analytics-core.ts`), called in `profileViewed` (`analytics.ts:89-107`). That call then **removes `?src=` from the address**. `ANALYTICS_CHANNELS` is at `packages/contracts/src/analytics.ts:48-58`.
- Events carry a per-tab flow id only (`schema.ts:1730-1757`). `tip_completed` is emitted by the worker (`apps/worker/src/handlers/domain-events.ts:203-206`) with a dedupe key, no flow and no channel.
- Collection is `config.ANALYTICS_ENABLED ?? config.NODE_ENV !== 'production'` (API `config.ts:122`, `events.controller.ts:37`, `server-events.ts:22`; worker `config.ts:80`, `job-worker.ts:242`). So it is **off in production** unless set.
- Raw events are purged at 90 days (`purgeAnalytics`, `operations/analytics.ts:200-216`), by the 01:00 Lagos job (`job-worker.ts:280-286`).
- The browser sends nothing under GPC or DNT (`shouldTrack`, `analytics.ts:40-42`).

**Recap (board §4):**

- `shareableWeek` (`apps/web/src/lib/week-share.ts`) and `drawWeekCard` (`lib/week-card.ts`) draw the weekly card from shareable fields only. They are used by `app/dashboard/reports/[week]/report-view.tsx:68-90`.
- `buildWeeklyReport` and `runWeeklyReports` (`operations/reports.ts:56-249`) store `weekly_reports(profile_id, iso_week, data)` with the unique key `weekly_reports_once`. They notify (`notifications.kind = 'weekly_report'`) and queue mail type `weekly_report` (`packages/mail/src/templates/types/weekly-report.ts`, preference `notify_weekly_reports`).
- `MONTHLY_MOMENTS_JOB` runs at 07:00 Lagos on the 1st (`job-worker.ts:273-279, 449-460`) with `previousMonth(now)`.
- `notifications_kind` allows `tip | weekly_report | moment` only (`schema.ts:700-703`).

**Early access (board §5):**

- No feature-switch system exists: there are no flags in API config or the web.
- The Plan section lists Pro's benefits (`apps/web/src/app/dashboard/settings/sections/plan.tsx:13-45`).
- Settings has seven sections (`sections/section.tsx:4-12`, after make-it-yours).

---

## Design

### 1. Early access (PR 1)

**Contracts** (new `packages/contracts/src/early-access.ts`):

```ts
export const FEATURE_STAGES = ['off', 'early', 'everyone'] as const;
export type FeatureStage = (typeof FEATURE_STAGES)[number];

/**
 * Features that may be held back. Never a money, sign-in, recovery, withdrawal or payment flow:
 * only things that are safe to change or switch off. A key is never reused.
 */
export const EARLY_FEATURES = {
  tip_sources: { title: 'Where your tips come from', proOnly: true },
  monthly_recap: { title: 'Your month on TipMe', proOnly: true },
} as const satisfies Record<string, { title: string; proOnly: boolean }>;
export type EarlyFeature = keyof typeof EARLY_FEATURES;
export const EARLY_FEATURE_KEYS = Object.keys(EARLY_FEATURES) as EarlyFeature[];

/** Whether one person sees a feature. A proOnly feature also needs Pro at 'everyone'. */
export function featureVisible(
  key: EarlyFeature,
  stage: FeatureStage,
  who: { plan: PagePlan | undefined; earlyAccess: boolean },
): boolean;
// off -> false; early -> plan === 'pro' && earlyAccess; everyone -> !proOnly || plan === 'pro'

export const earlyAccessPatchSchema = z.object({ on: z.boolean() }).strict();
export const featureStagePatchSchema = z
  .object({
    stage: z.enum(FEATURE_STAGES),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
```

- `MyProfile.earlyAccess?: boolean` is stored. It is kept on Free and does nothing there.
- `MyProfile.features?: EarlyFeature[]` holds the features this person sees now, resolved by the API.

**Storage:** migration `NNNN_early_access`, additive.

- `profiles.early_access boolean NOT NULL DEFAULT false`. Add it to `live-payouts-schema.test.mjs` around `seedDemoProfiles` (builder rules).
- `feature_stages(key text PRIMARY KEY, stage text NOT NULL, updated_at timestamptz NOT NULL, updated_by uuid NULL)`, with the checks `key IN (EARLY_FEATURE_KEYS)` (generated from the contract, like `issues_kind`) and `stage IN ('off','early','everyone')`. A missing row reads as `off`.
- Permission `features.manage` (group `settings`, `sensitive: false`, "Move a new feature between off, early access and everyone, with a reason"), granted to `owner` in the same migration.

**Rules:**

- `PUT /v1/me/early-access { on }`:
  - `on: true` needs Pro. Free gets `403 EARLY_ACCESS_PRO_REQUIRED` ("Early access is part of TipMe Pro."). The plan is checked before the write and again in the `WHERE`.
  - `on: false` is always allowed, so a lapsed page can always switch it off.
- `GET/PUT /v1/ops/features` (permission `features.manage`):
  - each stage change is audited with its reason, as `feature.stage_changed` with the key, the old stage and the new one;
  - no fresh code is needed (not sensitive).
- `featureStages(db)` reads the whole table, at most a handful of rows. `toMine` resolves `features` with it. There is no cache: one indexed read per `/v1/me`, so a stage change shows on the next load.
- `deleteAccount` resets `early_access` with the other personal columns.

**UI:**

- Settings → Plan:
  - a `role="switch"` checkbox, "Try new features early", with the board's copy: "You'll see new things before everyone else. They may change, and you can switch this off any time.";
  - on Free: the line "Early access to new features" in the Pro list, and no switch;
  - lapsed with the switch on: "Early access is kept and starts again when your page is Pro." with the switch able to turn off.
- Ops: `/ops/features`, one row per registry key with its title, the current stage as a 3-option radio group, a reason field, Save, and the last change ("by staff id, date"). The menu entry needs `features.manage`.

### 2. Priority support (PR 2)

**Ruling, board versus dev:** the board draws requests "in the staff queue" as "a new support request kind". Dev's issues inbox is ids-only by design (`OpsIssueSubject`). Its summaries are fixed words, and it is open to `issues.view`, which is not sensitive. A support request carries the person's own free text. So this plan gives requests **their own table, permission and admin page**, "Support", drawn like the board's queue: Pro first, then oldest, and a clock against the target. It does not add an issue kind. If this is wrong, the cost is an extra admin menu entry.

**Contracts** (new `packages/contracts/src/support.ts`):

```ts
export const SUPPORT_TOPICS = ['withdrawal', 'tip', 'page', 'account', 'pro', 'other'] as const;
export const SUPPORT_TOPIC_WORDS: Record<SupportTopic, string> = {
  withdrawal: 'A withdrawal', tip: 'A tip', page: 'My page',
  account: 'My account', pro: 'TipMe Pro', other: 'Something else',
};
export const SUPPORT_BODY_LIMIT = 2000; // code points, like char_length
export const supportRequestSchema = z.object({ topic: z.enum(SUPPORT_TOPICS), body: z.string() }).strict();
// body: cleaned (control characters out except \n, trimmed), 1..2000 code points
export interface MySupportRequest {
  id: string; topic: SupportTopic; body: string; createdAt: string;
  status: 'open' | 'answered' | 'closed';
  replies: { body: string; at: string }[]; // staff replies, never a staff name or id
}
export interface SupportPromise { proFirst: true; targetHours: number | null } // null: no time promised
export interface OpsSupportRow {
  id: string; topic: SupportTopic; handle: string | null; pro: boolean;
  createdAt: string; waitingMinutes: number; targetHours: number | null; status: ...;
} // the list shows no body
export interface OpsSupportRequest extends OpsSupportRow { body: string; replies: ... }
export const supportReplySchema = z.object({ body: z.string(), close: z.boolean().optional() }).strict();
```

**Storage:** migration `NNNN_support_requests`.

- `support_requests`:
  - `id uuid PK`, `user_id uuid NOT NULL FK users`, `profile_id uuid NULL FK profiles`;
  - `topic text` (check against the list), `body text` (check `char_length BETWEEN 1 AND 2000`);
  - `pro boolean NOT NULL`, which is the plan **when sent**;
  - `status text DEFAULT 'open'` (check `open|answered|closed`), `created_at`, `answered_at`, `closed_at`;
  - index `(status, pro DESC, created_at)`.
- `support_replies`: `id`, `request_id FK`, `staff_user_id uuid NOT NULL`, `body` (1..4000), `created_at`.
- `notifications_kind` gains `'support_reply'`, with a new nullable column `support_request_id uuid`.
- Permission `support.answer`: group `people`, `sensitive: true` (it reads a person's own words), "Read and answer people's support requests". Granted to `owner`. As a sensitive permission it needs a fresh code, per the existing guard.

**Rules:**

- **Sending:** `POST /v1/me/support` (session and CSRF).
  - Per user, at most 3 open requests (`409 SUPPORT_TOO_MANY_OPEN`, "You have 3 requests waiting. We'll answer those first.") and 10 a day (`429`, the existing `RateLimitGuard`, a new `RATE_LIMIT_SUPPORT_PER_DAY` default 10).
  - `pro` is read from `profiles.plan` inside the insert transaction. A Free page that moves to Pro later is not re-sorted (ruling: the plan when sent).
- **Showing:** `GET /v1/me/support` returns the person's requests, newest first, at most 20, with replies. `GET /v1/me/support/promise` returns `SupportPromise`.
- **The target:** a new API config `SUPPORT_PRO_TARGET_HOURS` (int 1..168, **optional, no default**). While unset, Pro sees "Pro requests are answered first." with no time, and the queue shows "waiting" without a target. That way TipMe never promises a time nobody has agreed to staff. The owner sets it (open question 1).
- **Staff:**
  - `GET /v1/ops/support?status=open` lists requests sorted `pro DESC, created_at ASC`, without bodies;
  - `GET /v1/ops/support/:id` returns the body and replies, and writes the audit entry `support.read` (the id only, never text);
  - `POST /v1/ops/support/:id/reply { body, close? }` writes a reply, sets `answered`, or `closed` with `close: true`, and audits `support.replied` (the id and length only);
  - `POST /v1/ops/support/:id/close` closes the request without a reply, with a reason, audited.
- **Telling the person:** a reply inserts one `notifications` row (`kind: 'support_reply'`, title "TipMe support answered you", no reply text in the title or body). With a verified email it also queues mail type `support_reply`, which says only that there is an answer and links to `/dashboard/settings#help`. The reply text never goes in an email or a notification. Category transactional, no preference.
- **Never:**
  - in logs, Sentry, analytics or audit text;
  - in admin search (`ops-search` is unchanged);
  - shown with an email or phone. Staff see the handle and plan only. To reach someone in another way, they use the existing `private.view` reveal, which is audited.
- **Retention:** a daily sweep (in the 01:00 analytics job) deletes requests and their replies 180 days after `closed_at`. `answered` requests close themselves after 30 days without a new message. `deleteAccount` deletes all of the person's requests. 180 days is the default, matching page reports (`00-DECISIONS.md` PR-013 note). It is open question 2.
- **Money:** the Support page shows no money action. Staff use the existing tools (Issues, Pages, Search) under their own permissions.

**UI:**

- Settings: a new section `{ id: 'help', title: 'Get help' }` after `data` (eight sections). Update the "seven" comments in `section.tsx:3` and the nav test in `tests/e2e/cover-settings.spec.ts`.
  - "What do you need help with?" is a `select` of the topic words. "Tell us what happened…" is a textarea with a counter. The button is "Send to TipMe support".
  - Pro gets the line "Pro requests are answered first, usually within {N} hours." when a target exists, or "Pro requests are answered first." when it does not. Free gets no line, and no upsell.
  - Under the form, "Your requests": each request's topic, date, state ("Waiting" / "Answered" / "Closed") and replies as plain text. React renders it as text, never as HTML.
  - Below that, "You can also email support@usetipme.xyz", using the `pilot.ts` constant.
- Ops: `/ops/support`:
  - a table with Request (topic words), From (`@handle` and a Pro badge in text), and Waiting ("40 min · target 4 h", or "40 min");
  - a row turns "Over target" in text, not colour only, once waiting goes past the target;
  - the detail page shows the body, the replies, a reply textarea, "Send reply", "Send and close", and "Close without reply" (with a reason);
  - the menu entry needs `support.answer`.

### 3. Repeat supporters (PRs 3 and 4)

**Mechanism: option (a), the owner's choice.**

- The browser makes a random 32-byte key, base64url (43 characters), **one per recipient**. It is saved in `localStorage` under `tipme.supporters.v1` as `{ v: 1, keys: { [handleLower]: key } }`, capped at 500 entries with the same size guards as `recognition.ts`.
- Per recipient, so even TipMe's stored data cannot link one supporter's tips across different recipients.
- The server stores only `sha256(key)`. It never stores, logs or returns the key.
- It is never a card, IP, device or browser fingerprint. Nothing is derived from the browser.
- Known limit, in the copy and the privacy lines: a new phone, a new browser, cleared storage or the recipient's handle rename makes a new supporter. Old ones stay as they were.

**Contracts** (`checkout.ts`, new `packages/contracts/src/supporters.ts`):

```ts
// tipIntentRequestSchema gains:
supporterKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
// TipStatusView gains:
/** Present (true) only when this tip is recognised: the supporter opted in and the page was Pro. */
recognised?: true;

// supporters.ts
export interface MySupporter {
  id: string;            // the supporters row id: opaque, never the key or its hash
  name: string;          // the name they typed most recently with this key
  tips: number;          // paid tips only
  totalNetMinor: string; // the sum of what the Tips list shows for each tip (recipient net)
  lastAt: string;
  returning: boolean;    // tips >= 2
}
export interface MySupporterNote { tipId: string; body: string; at: string }
```

**Storage:** migration `NNNN_supporters`.

- `supporters`:
  - `id uuid PK`, `profile_id uuid NOT NULL FK profiles`, `key_hash bytea NOT NULL` (check `octet_length = 32`), `label text NOT NULL` (1..60);
  - `first_at`, `last_at`;
  - `UNIQUE (profile_id, key_hash)`.
- `tip_supporters`: `tip_id uuid PK FK tips`, `supporter_id uuid NOT NULL FK supporters ON DELETE CASCADE`, index `(supporter_id)`.
- Nothing changes on `tips`.

**Rules:**

- **Recording**, in `createPaymentIntent`'s transaction, after the tip row:
  - only when `supporterKey` is given, **and** a cleaned label exists, **and** the page is `plan = 'pro'` (read in the same transaction as `pageState`), **and** the config `SUPPORTER_RECOGNITION` is `on`;
  - otherwise the key is ignored and nothing is stored. It is not an error, so the form never fails because of it;
  - an upsert into `supporters` on `(profile_id, key_hash)` sets `label` and `last_at`, then inserts into `tip_supporters`.
- **The fingerprint:** append `['s', sha256hex]` only when a key is recorded-eligible (key and label both present). The fingerprints of every request without a key stay byte-identical, which a test asserts. Changing the tick resets the draft key on the web, as the consent tick does.
- **What counts:** only `tips.status = 'SUCCEEDED'` count towards `tips`, `total` and `lastAt`. An unpaid row in `tip_supporters` is harmless and is never shown.
- **The kill switch:** `SUPPORTER_RECOGNITION` (`on|off`, default `on`), an API setting like `ADULT_PLATFORM_LINKS`. `off` stops recording, hides the tick (`PublicProfile.recognition?: true` is sent only when the page is Pro and the switch is on) and hides the recipient's list. It deletes nothing. It is the lever if D-07's review says to wait (open question 3).
- **Stopping, by the supporter:** `POST /v1/tips/:tipId/recognition/stop` with the receipt's status token. A bad token is 404, as on the status route.
  - It finds the tip's `supporter_id` and deletes that `supporters` row. The cascade removes every `tip_supporters` row of it, so all their past tips with this recipient are no longer grouped. The tips themselves stay.
  - It answers 204 and is idempotent: an already-stopped tip also answers 204.
  - The web then removes that handle's key from `tipme.supporters.v1`.
- **Forgetting, on this phone:** the receipt's "Forget my tips on this phone" also clears `tipme.supporters.v1`. Copy: "Forget my tips and keys on this phone". This removes only the browser's copy. Recipients keep seeing past tips grouped until the supporter uses "Stop {name} recognising me".
- **The recipient's view (Pro):**
  - `GET /v1/me/supporters` returns at most 100, ordered by `lastAt` desc, paid tips only, with no hidden rows;
  - `GET /v1/me/supporters/:id/notes` returns the notes of that supporter's paid tips, newest first, at most 50, excluding any tip with a `message_flags` row (hidden or reported);
  - Free gets `403 SUPPORTERS_PRO_REQUIRED`;
  - another page's supporter id is 404.
- **Lapse:** recording stops (the server needs Pro) and the list is refused on Free. Everything is kept and shows again on return to Pro.
- **Account deletion:** delete the page's `supporters` (the cascade takes `tip_supporters`).
- **Data export:** the recipient's export gains nothing. The key hash is the supporter's data, not the recipient's.
- **Never:**
  - in analytics (`returningVisitor` keeps reading `MY_TIPS_KEY` only, with a test);
  - in logs or Sentry: add `supporterKey` to the request-body scrub list next to `message`;
  - on the public page, in OG or JSON-LD, in the weekly or monthly recap, or in admin search.

**Tip form copy** (board, proposed copy; "they", because TipMe doesn't know pronouns):

- It is shown under the name field only when `profile.recognition` is true **and** the name field has text. Emptying the name unticks it.
- The label is "Let {recipient} recognise me next time".
- The hint is "They'll see that you've tipped before, and how often. You can stop this from any receipt."
- It is off by default. When ticked, the form gets the key for this handle, creating and storing it only at that moment, and sends `supporterKey`.

**Receipt:** when `TipStatusView.recognised`, a quiet line: "{name} can recognise you next time." with the link button "Stop {name} recognising me". After the stop it reads "Done. {name} won't see your tips grouped any more." with focus on that line.

**Privacy lines** (board's list; Task 3.5 adds them to the privacy placeholder's `covers` list and the threat model, and the full wording goes into the `docs/00-DECISIONS.md` entry for the privacy notice author):

- **What is stored:** a random key, in the supporter's browser and, as a one-way hash, with their tips to that recipient. Never contact details.
- **Why:** so that recipient can recognise them, only with their consent.
- **How long:** until they stop it from a receipt, or the recipient deletes their account.
- **How to stop:** "Stop {name} recognising me" on any receipt. "Forget my tips and keys on this phone" clears the browser's copy.
- **Not legal advice.** Check before building: the Nigeria Data Protection Act 2023, especially its lawful-basis and consent provisions (the board reports section 25; official text at ndpc.gov.ng).

### 4. Where your tips come from (PR 5)

**Capture (web):**

- `profileViewed` already computes the channel. It now also stores it in a module variable (`arrivalChannel()`, in memory only, never in storage), **before** `?src=` is removed.
- `createTip` sends `arrivalChannel: channel` only when `shouldTrack(navigator)` is true, so GPC and DNT are honoured.
- A tip started outside a profile view (a `/tip` deep link, say) sends none.

**Contracts:** `tipIntentRequestSchema` gains `arrivalChannel: z.enum(ANALYTICS_CHANNELS).optional()`.

```ts
// packages/contracts/src/analytics.ts
export const TIP_SOURCES_MIN = 3;
export interface TipSourcesView {
  month: string; // YYYY-MM, Lagos
  rows: { channel: AnalyticsChannel; tips: number }[]; // each >= TIP_SOURCES_MIN, most first
  /** Paid tips this month in rows under the minimum, or with no channel known; never split. */
  otherTips: number;
}
export const CHANNEL_WORDS: Record<AnalyticsChannel, string>;
// qr: 'Your QR code', link: 'Your link, shared directly', instagram: 'Instagram', x: 'X',
// facebook: 'Facebook', whatsapp: 'WhatsApp', search: 'Search', direct: 'Typed or saved address', other: 'Other ways'
```

**Storage:** migration `NNNN_tip_arrivals`. `tip_arrivals(tip_id uuid PK FK tips, channel text NOT NULL, created_at)`, with a check against `ANALYTICS_CHANNELS`.

**Rules:**

- **Written** in `createPaymentIntent`'s transaction only when `arrivalChannel` is given **and** the API's analytics switch is on. The checkout service passes `analyticsEnabled` from `config.ANALYTICS_ENABLED ?? NODE_ENV !== 'production'`, the same expression as `events.controller.ts:37`. **In production today, nothing is written.**
- **Not in the fingerprint** (ruling). It is not something the supporter chose, a retry from the same tab carries the same value, and a replay keeps the original row.
- **Read:** `GET /v1/me/tip-sources?month=YYYY-MM` (default: this Lagos month).
  - It is Pro and `featureVisible('tip_sources')`. Free gets `403 TIP_SOURCES_PRO_REQUIRED`.
  - With the analytics switch off it answers `404 TIP_SOURCES_OFF`, and the web hides the card.
  - It counts `SUCCEEDED` tips whose `completed_at` falls in the month, grouped by channel.
  - A row with fewer than 3 tips moves into `otherTips`. If `otherTips` is 1 or 2 **and** it is the only number shown, the card shows "Fewer than 3 tips this month" instead. That way no single tip can be picked out.
- **Purge:** `purgeAnalytics` also deletes `tip_arrivals` older than its `before` date (90 days). That is enough for "this month" and for last month's recap.
- **Account deletion:** delete the page's `tip_arrivals`.
- **D-07:** the decisions entry and the runbook line say that turning `ANALYTICS_ENABLED` on in production turns this on too. It is the owner's call under D-07, not this PR's.

**UI:** a Pro card on dashboard home, "This month's tips came from".

- A list of rows: the channel words, "· {n} tips", and a bar whose width is `n / max` (decorative, `aria-hidden`, because the number is in the text).
- Then "Other ways · {n} tips" when `otherTips > 0`.
- It is hidden on Free, when the switch is off, and when the feature is not visible. There is no upsell card (ruling: smallest change).

**Overlap note:** social links shipped "without press counts per link (needs D-07)" (`ACTIVE_TASK.md`). This card is per channel, not per social link. It does not build press counts.

### 5. Monthly recap (PR 6)

**Contracts** (`packages/contracts/src/dashboard.ts`):

```ts
export interface MonthlyRecapData {
  month: string; // YYYY-MM
  tipCount: number; // paid
  totalNetMinor: string; // shown privately; on the card only when switched on
  bestWeek: { from: string; to: string; tips: number } | null; // clipped to the month
  milestones: number; // moments created in the month
  notes: number; // notes on paid tips, excluding hidden or reported ones
} // no supporter name, label, message or tip id, by type
```

**Storage:** migration `NNNN_monthly_recaps`.

- `monthly_recaps(id uuid PK, profile_id FK, month text CHECK '^\d{4}-\d{2}$', data jsonb, created_at, UNIQUE(profile_id, month))`.
- `notifications_kind` gains `'monthly_recap'`, with a nullable `recap_id uuid`. The migration that lands second regenerates the check with both kinds.

**Rules:**

- **Built** by `runMonthlyRecaps(db, { sealing, month })` in `MONTHLY_MOMENTS_JOB`, **after** `evaluatePeriodMoments`, so the month's milestones count.
  - It covers pages with `plan = 'pro'` at run time, not deleted, and at least one paid tip in the month.
  - It makes one row per page and month, however often it runs (the `onConflictDoNothing` pattern of `runWeeklyReports`).
- **Best week:** the ISO week (Lagos) with the most paid tips in the month. Ties go to the higher net, then the later week. `from` and `to` are clipped to the month's days. "Best" is by tips, because the card shows no money by default (open question 5).
- **Telling them:**
  - when `featureVisible('monthly_recap')` holds at run time and `notify_weekly_reports` is on, one notification (`kind: 'monthly_recap'`, title "Your month on TipMe", body "{n} tips in {Month}");
  - with a verified email, also mail type `monthly_recap` (category engagement, preference `notify_weekly_reports`, data month and tip count only);
  - the weekly report and its email are unchanged. Reading "in the weekly email's place" as "through the same channels as the weekly email" is a ruling (open question 4).
- **Read:** `GET /v1/me/recaps` (at most 12) and `GET /v1/me/recaps/:month`. They need Pro and `featureVisible('monthly_recap')`, otherwise 403 `RECAP_PRO_REQUIRED`. Lapse hides them and keeps them.
- **The card:** `shareableMonth(recap, owner, { showTotal })` (new `apps/web/src/lib/month-share.ts`) picks fields one by one: display name, handle, month name, tip count, best week, milestones, notes, and the total **only** when `showTotal`. `drawMonthCard` (new `lib/month-card.ts`) draws it on the purple card style. A test feeds it a recap object carrying extra keys (`topSupporterLabel`, `message`), as a hostile older API might, and asserts none reaches the output.
- The "Show my total on the card" switch defaults off and is kept per viewer in `localStorage` (`tipme.recapTotal.v1`, try/catch). It is a per-viewer convenience, and nothing is sent.

**UI:**

- `/dashboard/reports/month/[month]`: heading "{Name}'s {Month} on TipMe", the private numbers (total included, with "Only you can see this. It's on your card only if you switch it on."), a preview of the card, the switch, and "Share my month". That last uses the same `navigator.share` / download path as `report-view.tsx:68-90`.
- Dashboard home gets a small "Your {Month} recap is ready" link while the latest recap is under 14 days old.
- Add `/dashboard/reports/month/[month]` to the web's private-route noindex list, as the weekly page has.

---

## Global Constraints

- **Workspace and branches:**
  - one branch per PR, off `origin/dev`, in `.worktrees/<dir>`, following `.superpowers/program/builder-rules.md`;
  - never push or merge without the owner;
  - never use bare `git stash`.
- **Read first:**
  - `AGENTS.md`, plus the scoped `packages/contracts/AGENTS.md`, `packages/database/AGENTS.md` (if present), `apps/api/AGENTS.md`, `apps/web/AGENTS.md` and `apps/worker/AGENTS.md`;
  - for UI, `docs/design/DESIGN-CONSTITUTION.md` and the documents it requires;
  - `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md` and `HANDOFF.md`, which each PR updates.
- **Money safety (AGENTS.md financial invariants):**
  - nothing here moves, prices or posts money;
  - amounts shown (supporter totals, recap total) are sums of `tip_quotes.recipient_net_minor` in SQL `bigint`, sent as strings, and formatted at the edge with the existing money helpers. Never floats;
  - only `tips.status = 'SUCCEEDED'` counts as paid;
  - `createPaymentIntent` changes are additive inside its transaction. A failure in the new inserts rolls back the whole tip (test it), so a tip can never exist without its intent;
  - the fingerprint stays byte-identical for every request without a supporter key.
- **Privacy:**
  - **No supporter identity** beyond the opt-in key hash. Never fingerprint cards, IPs, devices or browsers. Never link tips without the supporter's tick. Keys are per recipient.
  - The supporter key, support bodies and replies are never logged, sent to Sentry or analytics, or put in audit text. Extend the request-body scrub (`apps/api` logger redaction and `apps/web/src/lib/sentry-scrub.ts`) with `supporterKey` and `body` on `/v1/me/support`, with a test each.
  - The channel is written only while analytics is on and the browser allows tracking. Counts only, below 3 hidden.
  - The recap and its card never carry a supporter's name, even an opted-in one.
  - Lapsing hides and never deletes. Deleting the account deletes supporters, tip arrivals, support requests and recaps.
- **Copy:**
  - users never see the payment provider's name (`apps/web/test/no-provider-names.test.mjs` must pass; say "our payment partner");
  - nothing implies regulatory, legal or data-protection approval;
  - pronouns are "they";
  - no Pro price anywhere (pro billing owns it);
  - locked things say "Pro" in text.
- **Accessibility:**
  - controls at least 44px, with visible labels;
  - the early-access switch is `role="switch"` with `aria-checked`;
  - nothing relies on colour alone ("Returning", "Over target", "Pro" are text);
  - errors are tied to their fields with `aria-describedby`, and a save is announced with `role="status"`;
  - `expectAccessible(page)` runs in every new e2e test.
- **States:** new messages use the states primitives already on dev from PR A (`Slip`, `ResultKey`/`StateLine`, `EmptySlip`), never a new `Notice`. States PR I's guard test will refuse new `Notice`s.
- **Migrations:**
  - take the next free number at write time (dev is at 0077; make-it-yours PR B and username reservation PR 2 are building and may claim 0078 and up);
  - rebuild `@tipme/contracts` first, then `pnpm --filter @tipme/database generate`;
  - never rename a migration by hand, and never relax `migration-journal.test.mjs`;
  - additive only;
  - every new `profiles` column is added and dropped in `live-payouts-schema.test.mjs`;
  - PRs 1 and 2 both regenerate the permission checks, and PRs 2 and 6 both change `notifications_kind`. Whichever merges second regenerates against dev.
- **Contracts and OpenAPI:**
  - every new field is optional, and an older API sending none must draw exactly today's screens;
  - after any route or shape change, run `pnpm api:openapi` and then `pnpm docs:generate`, and commit both;
  - `tests/integration/openapi.test.mjs` must pass.
- **Tests:**
  - TDD, failing first;
  - integration through the lane wrapper with its own template (builder rules), never `scripts/test-integration.mjs` as is;
  - tests that route `**/v1/me/**` answer `/v1/me/events` with 204.
- **Reporting:** commands exactly as run, exit codes, counts, every failure by name.

## Review Focus

1. **No silent identity.** A tip without the tick stores nothing new. The key is honoured only with a name, on a Pro page, with the switch on. The key never reaches logs, analytics, Sentry or any response. A different recipient gets a different key (Tasks 3.1–3.4).
2. **Stop really stops.** After "Stop {name} recognising me", the recipient's list and notes no longer group that supporter's past tips. The tips themselves and their notes stay in Tips. A wrong token reveals nothing (Task 3.3).
3. **Fingerprint stability.** Requests without a supporter key hash exactly as on dev, and adding a key to a replayed idempotency key is a conflict (Task 3.2).
4. **Rollback.** A failure after the tip insert (including in `supporters`, `tip_supporters` and `tip_arrivals`) leaves no tip, intent or attempt (Tasks 3.2, 5.2).
5. **Attribution is off in production.** With `ANALYTICS_ENABLED` unset and `NODE_ENV=production`, no `tip_arrivals` row is written and the card's route answers `TIP_SOURCES_OFF`. GPC and DNT browsers send no channel. No row under 3 shows (Tasks 5.1–5.3).
6. **The recap card cannot name a supporter**, even when fed one, and leaves out the total unless switched on (Task 6.4).
7. **Support text is contained.** Bodies are read only with `support.answer` and a fresh code, every read is audited by id, nothing goes to logs or email, and nothing reaches admin search. The time promise shows only when `SUPPORT_PRO_TARGET_HOURS` is set (Tasks 2.2–2.5).
8. **Pro locks under a race.** Early access on, the supporters list, tip sources and recaps are refused on Free, including when the plan drops between read and write (Tasks 1.2, 3.4, 5.3, 6.3).
9. **Early access never gates money or safety.** The registry holds only `tip_sources` and `monthly_recap`. A contract test pins the allowed keys, so a new one needs a reviewed edit (Task 1.1).

---

## PR boundaries and order

| PR                                               | Branch                        | Tasks   | Migration                                                             | Depends on                                                    |
| ------------------------------------------------ | ----------------------------- | ------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| **1. Early access**                              | `feat/early-access`           | 1.0–1.5 | `NNNN_early_access` (column, table, `features.manage`)                | —                                                             |
| **2. Priority support**                          | `feat/priority-support`       | 2.1–2.6 | `NNNN_support_requests` (tables, `support.answer`, notification kind) | — (can run beside 1)                                          |
| **3. Repeat supporters: the supporter's choice** | `feat/repeat-supporters`      | 3.1–3.5 | `NNNN_supporters`                                                     | — **Ship early:** only tips made after it can ever be grouped |
| **4. Repeat supporters: the recipient's list**   | `feat/repeat-supporters-list` | 4.1–4.3 | none                                                                  | 3                                                             |
| **5. Where your tips come from**                 | `feat/tip-sources`            | 5.1–5.4 | `NNNN_tip_arrivals`                                                   | 1 (feature gate)                                              |
| **6. Monthly recap**                             | `feat/monthly-recap`          | 6.1–6.5 | `NNNN_monthly_recaps` (table, notification kind)                      | 1 (feature gate)                                              |

Suggested merge order: 3 (so grouping starts collecting), then 1, then 2, 4, 5 and 6 in any order. Each PR is shippable alone. PR 4 without PR 3 has nothing to show, which is why it waits.

## Overlaps with other branches (do not plan their work)

- **States B–I** (running): B restyles `appreciation-form.tsx` and `status-view.tsx`, F restyles the Settings sections, G the ops pages, and H1 changes the tip form's submit path.
  - This plan adds a tick box under the name field (PR 3), a receipt line (PR 3), a Settings section (PR 2), a Plan switch (PR 1) and two ops pages (PRs 1 and 2), all using the states primitives already on dev.
  - Expect text conflicts in those files, but none in logic. Whichever lands second rebases. Do not migrate any existing `Notice`: that is states' work.
- **Make-it-yours PR B** (start amount, building) touches `tip-amounts.ts` and `TipAmountsSettings`. There is no overlap beyond migration numbering.
- **Make-it-yours PR D** (pinned note, accent, the supporter's note-consent withdrawal) adds `POST /v1/tips/:tipId/note-consent/withdraw` and a receipt line, "Stop {name} showing my note".
  - PR 3 here adds a sibling route and line. Keep them as two separate components in one "Your choices" group under the receipt, so either can land first.
  - Both read the status token the same way. Share a small `receiptToken` helper only if D has already added one.
- **Live updates PR 2/3:**
  - PR 2's `profile.changed` should also fire after `PUT /v1/me/early-access`. Add one line if PR 2 has landed, otherwise note it in the report;
  - PR 3's `/v1/ops/events` may later signal the Support queue. Not here.
- **Username reservation PR 2/3:** they add permission-catalogue lines and migrations. This only collides with PRs 1 and 2 on the regenerated permission check (regenerate at merge).
- **Animated covers (#127):** merged. No overlap.
- **Pro billing** (`.worktrees/pro-billing`, plan only): `profiles.plan` becomes recomputed. Everything here reads `profiles.plan` at read time and in the `WHERE`, so nothing changes.
- **Staff roles board** (StaffRoles, awaiting owner): new permissions are granted to `owner` only. Which roles get them is for that board.

---

## PR 1: Early access

### Task 1.0: Bring the board into the repo, and record the decision

**Files:**

- Create: `docs/design/redesign/boards/ProAdditions.dc.html`, copied unchanged, plus its `README.md` table row.
- Modify: `docs/00-DECISIONS.md`, adding "Pro additions: the owner's decision, 5 Nov 2026". It covers the five items, the exclusions (§6 to confirm; tip goals TODO), option (a), attribution off until D-07, and "not legal, regulatory or partner approval". It lists the open questions below.

- [ ] **Step 1: Check, expecting FAIL.**

  ```bash
  test -f docs/design/redesign/boards/ProAdditions.dc.html && grep -q "Pro additions: the owner's decision" docs/00-DECISIONS.md
  ```

- [ ] **Step 2: Copy the board and write the entry.** Later PRs append their own builder's calls to the same entry.
- [ ] **Step 3: Run Step 1 again, expecting PASS, then `pnpm exec prettier --check docs/00-DECISIONS.md docs/design`.**
- [ ] **Step 4: Commit** `docs: Pro additions board and the owner's decision`.

### Task 1.1: Contracts

**Files:**

- Create: `packages/contracts/src/early-access.ts`.
- Modify: `index.ts`, `profiles.ts` (`MyProfile.earlyAccess?`, `features?`), `errors.ts` (`EARLY_ACCESS_PRO_REQUIRED`), `ops-catalogue.ts` (`features.manage`).
- Test: `packages/contracts/test/early-access.test.mjs` (new), `ops-catalogue.test.mjs` (extend).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('featureVisible: off is nobody; early is Pro with the switch; everyone is the audience', ...);
  //   proOnly key: off -> false for all; early -> only {plan:'pro', earlyAccess:true};
  //   everyone -> pro true, free false, undefined plan false
  test('the registry holds exactly tip_sources and monthly_recap', ...);
  //   deepEqual(EARLY_FEATURE_KEYS.sort(), ['monthly_recap','tip_sources']): a new key needs review (Review Focus 9)
  test('featureStagePatchSchema needs a known stage and a reason of 3 to 500 characters', ...);
  test('earlyAccessPatchSchema is strict', ...);
  // ops-catalogue.test.mjs: features.manage is in OPS_PERMISSIONS, group settings, not sensitive
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm --filter @tipme/contracts build && node --test packages/contracts/test/early-access.test.mjs packages/contracts/test/ops-catalogue.test.mjs
  ```

- [ ] **Step 3: Implement** (Design §1).
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck && pnpm --filter @tipme/contracts lint
  ```

- [ ] **Step 5: Commit** `feat(contracts): early access stages and the feature registry`.

### Task 1.2: Storage and operations

**Files:**

- Modify:
  - `packages/database/src/schema.ts`: `profiles.earlyAccess`, `featureStages` and its checks;
  - the new migration `drizzle/NNNN_early_access.sql`, with its snapshot and journal. After generating, append the owner grant by hand, as in 0073;
  - `operations/profiles.ts`: `toMine` resolves `earlyAccess` and `features`; new `setEarlyAccess`; `deleteAccount` resets the flag;
  - new `operations/feature-stages.ts`: `featureStages(db)` and `setFeatureStage(db, { key, stage, reason, staffUserId })`, audited.
- Test:
  - `packages/database/test/integration/early-access.test.mjs` (new);
  - `live-payouts-schema.test.mjs` (add or drop `early_access`);
  - `migration-journal.test.mjs` (must pass).

**Interfaces:**

```ts
export function setEarlyAccess(
  db: Database,
  userId: string,
  on: boolean,
): Promise<MyProfile>;
// throws OperationError('EARLY_ACCESS_PRO_REQUIRED')
export function featureStages(
  db: Database | Tx,
): Promise<Record<EarlyFeature, FeatureStage>>;
export function setFeatureStage(
  db: Database,
  input: {
    key: EarlyFeature;
    stage: FeatureStage;
    reason: string;
    staffUserId: string;
  },
): Promise<void>;
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a Pro page switches early access on and off; a Free page can only switch it off', ...);
  test('the plan dropping to Free between read and write refuses on, and writes nothing', ...);
  //   hold the profile row lock in a second connection, set plan='free', release; expect EARLY_ACCESS_PRO_REQUIRED
  test('features: early shows only to Pro with the switch; everyone shows to every Pro page', ...);
  test('a missing stage row reads as off; an unknown key or stage is refused by the database', ...);
  test('setFeatureStage writes one audit entry with key, old and new stage, and the reason', ...);
  test('deleting the account resets early_access', ...);
  test('owner role has features.manage after the migration', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/early-access.test.mjs packages/database/test/integration/migration-journal.test.mjs packages/database/test/integration/live-payouts-schema.test.mjs
  ```

  Run it through the lane wrapper (builder rules).

- [ ] **Step 3: Implement.** Schema, then `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/database generate`, then the owner grant.
- [ ] **Step 4: Run, expecting PASS, then `pnpm --filter @tipme/database typecheck && pnpm --filter @tipme/database lint`.**
- [ ] **Step 5: Commit** `feat(database): early access switch and feature stages`.

### Task 1.3: API

**Files:**

- Modify:
  - `apps/api/src/profiles/me-profile.controller.ts` (`PUT /v1/me/early-access`);
  - a new `apps/api/src/ops/features.controller.ts` (`GET /v1/ops/features`, `PUT /v1/ops/features/:key`, guarded by `features.manage`), registered in the ops module;
  - `http/api-exception.filter.ts` (`EARLY_ACCESS_PRO_REQUIRED` 403);
  - `openapi/document.ts`, `docs/api/openapi.json`, and `docs/runbooks/admin-roles.md` ("Every permission" gains `features.manage`).
- Test: `tests/integration/early-access-api.test.mjs` (new), `ops-access.test.mjs` (the route-permission table), `openapi.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('PUT /v1/me/early-access on Free is 403 EARLY_ACCESS_PRO_REQUIRED; off is 200', ...);
  test('Pro on, stage early -> GET /v1/me has features ["tip_sources"]; stage off -> []', ...);
  test('ops: without features.manage the routes are 403; with it a change needs a reason and is audited', ...);
  test('without a session or CSRF the me route is refused', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/early-access-api.test.mjs tests/integration/ops-access.test.mjs tests/integration/openapi.test.mjs
  ```

- [ ] **Step 3: Implement**, then `pnpm api:openapi && pnpm docs:generate`.
- [ ] **Step 4: Run, expecting PASS, then `pnpm --filter @tipme/api typecheck && pnpm --filter @tipme/api lint`.**
- [ ] **Step 5: Commit** `feat(api): early access switch and staff feature stages`.

### Task 1.4: Settings → Plan switch

**Files:**

- Modify: `apps/web/src/app/dashboard/settings/sections/plan.tsx`, `apps/web/src/lib/profiles-api.ts`, `globals.css` (a switch style, if `packages/ui` has none; check first).
- Test: `tests/e2e/early-access.spec.ts` (new).

- [ ] **Step 1: Write the failing e2e.**

  ```ts
  test('Pro: the switch turns on, says so, and survives a reload', ...);      // role=switch, aria-checked
  test('Free: the Pro list says "Early access to new features" and there is no switch', ...);
  test('lapsed with the switch on: the kept message, and it can be turned off', ...);
  test('an older API without earlyAccess draws today\'s Plan section', ...);
  // each: await expectAccessible(page)
  ```

- [ ] **Step 2: Run, expecting FAIL:** `node scripts/build-e2e.mjs && pnpm test:e2e -- tests/e2e/early-access.spec.ts`.
- [ ] **Step 3: Implement** (Design §1 UI).
- [ ] **Step 4: Run, expecting PASS, then `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`.**
- [ ] **Step 5: Commit** `feat(web): Try new features early, on Pro`.

### Task 1.5: Ops → Features page, and the record

**Files:**

- Create: `apps/web/src/app/ops/features/page.tsx`.
- Modify: `apps/web/src/lib/ops-menu.ts` (entry, `needs: ['features.manage']`), `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`.
- Test: `tests/e2e/ops-features.spec.ts` (new), `apps/web/test/ops-menu.test.mjs` (extend if present).

- [ ] **Step 1: Write the failing e2e.** Staff with the permission move `monthly_recap` to Early, with a reason, and see it saved. Staff without it see no menu entry, and a direct URL shows the existing no-access state.
- [ ] **Step 2: Run, expecting FAIL. Step 3: implement. Step 4: run, expecting PASS.**
- [ ] **Step 5: Full checks:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, the touched integration files, and the e2e suite on your lane.
- [ ] **Step 6: Commit** `feat(ops): staff move a feature between off, early and everyone`.

---

## PR 2: Priority support

### Task 2.1: Contracts

**Files:**

- Create: `packages/contracts/src/support.ts`.
- Modify: `index.ts`, `errors.ts` (`SUPPORT_TOO_MANY_OPEN`, `SUPPORT_NOT_FOUND`), `ops-catalogue.ts` (`support.answer`, sensitive).
- Test: `packages/contracts/test/support.test.mjs` (new), `ops-catalogue.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a body is cleaned (controls out, newlines kept, trimmed) and 1..2000 code points', ...);
  //   '😀'.repeat(2000) passes; 2001 fails path ['body']; '   ' fails
  test('topic must be one of the six; extra keys refused', ...);
  test('every topic has words', ...);
  test('support.answer is sensitive, group people', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL. Step 3: implement. Step 4: run** the contracts commands of Task 1.1, expecting PASS.
- [ ] **Step 5: Commit** `feat(contracts): support requests and replies`.

### Task 2.2: Storage and operations

**Files:**

- Modify:
  - `schema.ts`: `supportRequests`, `supportReplies`, and `notifications` (`support_request_id`, with the kind check gaining `support_reply`);
  - the new migration `NNNN_support_requests.sql`, plus the owner grant of `support.answer`;
  - new `operations/support.ts`;
  - `operations/profiles.ts` (`deleteAccount` deletes the person's requests and replies);
  - `operations/analytics.ts`, or a new sweep called from the 01:00 job (the 180-day purge and the 30-day auto-close).
- Test: `packages/database/test/integration/support.test.mjs` (new), `migration-journal.test.mjs`.

**Interfaces:**

```ts
export function sendSupportRequest(
  db,
  input: { userId: string; topic: SupportTopic; body: string; now?: Date },
): Promise<MySupportRequest>;
export function mySupportRequests(
  db,
  userId: string,
): Promise<MySupportRequest[]>;
export function listSupportQueue(
  db,
  input: {
    status: 'open' | 'answered' | 'closed';
    limit: number;
    cursor?: string;
    targetHours: number | null;
    now: Date;
  },
): Promise<OpsSupportRow[]>;
export function supportRequestForStaff(
  db,
  input: { id: string; staffUserId: string },
): Promise<OpsSupportRequest | null>; // audits support.read
export function replyToSupport(
  db,
  input: {
    id: string;
    staffUserId: string;
    body: string;
    close: boolean;
    sealing: MailSealing;
  },
): Promise<OpsSupportRequest>;
export function closeSupport(
  db,
  input: { id: string; staffUserId: string; reason: string },
): Promise<void>;
export function sweepSupport(
  db,
  input: { now: Date },
): Promise<{ closed: number; deleted: number }>;
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a Pro page\'s request is stored with pro=true; a Free page\'s with pro=false', ...);
  test('a fourth open request is refused SUPPORT_TOO_MANY_OPEN', ...);
  test('the queue sorts Pro first, then oldest, and shows no body', ...);
  test('reading one writes an audit entry with the id only (no body text anywhere in audit)', ...);
  test('a reply marks it answered, adds one support_reply notification without the text, and one mail when the email is verified', ...);
  //   mail queue row's data has no body; notification title/body do not contain the reply
  test('the sweep closes answered requests after 30 days and deletes closed ones after 180', ...);
  test('deleting the account deletes the person\'s requests and replies', ...);
  test('the database refuses an empty or 2001-character body and an unknown topic', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL** (the Task 1.2 command with `support.test.mjs`). **Step 3: implement.** **Step 4: run, expecting PASS**, then typecheck and lint.
- [ ] **Step 5: Commit** `feat(database): support requests, replies and their retention`.

### Task 2.3: Mail type

**Files:** create `packages/mail/src/templates/types/support-reply.ts` and register it in `registry.ts`. Test: the mail package's template tests (`pnpm --filter @tipme/mail test`), plus a new case that renders the sample and asserts no `body` field exists in its schema.

- [ ] Steps: failing test, then implement (subject "TipMe support answered you", one text block, and the button "Read the answer" → `/dashboard/settings#help`, transactional), then pass, then commit `feat(mail): tell a person their support request was answered`.

### Task 2.4: API

**Files:**

- Modify:
  - a new `apps/api/src/profiles/support.controller.ts` (`POST/GET /v1/me/support`, `GET /v1/me/support/promise`) with `RateLimitGuard` (`RATE_LIMIT_SUPPORT_PER_DAY`);
  - a new `apps/api/src/ops/support.controller.ts` (list, read, reply, close, under `support.answer`);
  - `config.ts` (`SUPPORT_PRO_TARGET_HOURS` optional 1..168, `RATE_LIMIT_SUPPORT_PER_DAY` default 10);
  - the logger redaction, so `body` on these routes is never logged;
  - `api-exception.filter.ts`, OpenAPI, `docs/runbooks/admin-roles.md`, and `docs/runbooks/production.md` (a new env line: unset means no time promised).
- Test: `tests/integration/support-api.test.mjs` (new), `ops-access.test.mjs`, `ops-serious-gating.test.mjs` (fresh code on the read and reply), `openapi.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('send, then list: the person sees their request and later the reply text', ...);
  test('promise: targetHours null while SUPPORT_PRO_TARGET_HOURS is unset, 4 when set to 4', ...);
  test('ops list needs support.answer; read and reply need a fresh code', ...);
  test('the API log for a send contains no part of the body', ...);  // capture logger output
  test('the 11th request in a day is 429', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL** (the Task 1.3 command with these files). **Steps 3–4: implement and pass**, including `pnpm api:openapi && pnpm docs:generate`.
- [ ] **Step 5: Commit** `feat(api): support requests and the staff Support queue`.

### Task 2.5: Settings → Get help

**Files:**

- Create: `apps/web/src/app/dashboard/settings/sections/help.tsx`.
- Modify: `section.tsx` (eight sections, `help` after `data`), `settings-view.tsx`, `apps/web/src/lib/sentry-scrub.ts` (scrub the support body), and the notifications list item for `support_reply` (link to `#help`).
- Test: `tests/e2e/get-help.spec.ts` (new), `tests/e2e/cover-settings.spec.ts` (the nav list now has 8), `apps/web/test/sentry-scrub.test.mjs` (extend).

- [ ] **Step 1: Write the failing e2e.**

  ```ts
  test('Free: send a request; it shows as Waiting; no Pro line', ...);
  test('Pro with a target: "usually within 4 hours"; without: "answered first." and no time', ...);
  test('an answered request shows the reply as text; a notification links here', ...);
  test('three open requests: the fourth shows the refusal next to the button', ...);
  // expectAccessible each
  ```

- [ ] **Steps 2–4: fail, implement, pass**, then web typecheck and lint.
- [ ] **Step 5: Commit** `feat(web): Get help in Settings`.

### Task 2.6: Ops → Support

**Files:**

- Create: `apps/web/src/app/ops/support/page.tsx` and `apps/web/src/app/ops/support/[id]/page.tsx`.
- Modify: `ops-menu.ts`, `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`.
- Test: `tests/e2e/ops-support.spec.ts` (new).

- [ ] **Step 1: Write the failing e2e.** Pro first. "40 min · target 4 h" is shown when set. "Over target" appears in text. Reply and close work. Without the permission there is no menu entry.
- [ ] **Steps 2–4: fail, implement, pass.** Then run the full checks (Task 1.5 Step 5).
- [ ] **Step 5: Commit** `feat(ops): the Support queue, Pro first`.

---

## PR 3: Repeat supporters, the supporter's choice

### Task 3.1: Contracts, and the browser key store

**Files:**

- Modify: `packages/contracts/src/checkout.ts` (`supporterKey`, `TipStatusView.recognised?`), `profiles.ts` (`PublicProfile.recognition?: true`).
- Create: `packages/contracts/src/supporters.ts`, and `apps/web/src/lib/supporter-keys.ts`.
- Test: `packages/contracts/test/supporters.test.mjs`, `apps/web/test/supporter-keys.test.mjs` (both new), and `apps/web/test/analytics.test.mjs` (extend).

**Interfaces (web):**

```ts
export const SUPPORTER_KEYS = 'tipme.supporters.v1';
/** The key for this recipient, made (crypto.getRandomValues, 32 bytes, base64url) and saved only when asked. */
export function supporterKeyFor(
  storage: StorageLike | undefined,
  handle: string,
  create: boolean,
): string | null;
export function dropSupporterKey(
  storage: StorageLike | undefined,
  handle: string,
): void;
export function forgetSupporterKeys(storage: StorageLike | undefined): void;
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('supporterKey must be 43 base64url characters', ...);
  test('a key is made only with create=true, is stable per handle (case-insensitive) and differs between handles', ...);
  test('corrupt, foreign or oversized storage reads as empty; a full quota returns null and never throws', ...);
  test('more than 500 handles keeps the newest 500', ...);
  test('returningVisitor ignores tipme.supporters.v1', ...);  // only MY_TIPS_KEY makes it true
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm --filter @tipme/contracts build && node --test packages/contracts/test/supporters.test.mjs && node --test apps/web/test/supporter-keys.test.mjs apps/web/test/analytics.test.mjs
  ```

- [ ] **Steps 3–4: implement and pass**, then the contracts and web typecheck and lint.
- [ ] **Step 5: Commit** `feat(contracts,web): an opt-in supporter key, one per recipient`.

### Task 3.2: Storage, and recording at intent creation

**Files:**

- Modify:
  - `schema.ts` (`supporters`, `tipSupporters`) and the new migration `NNNN_supporters.sql`;
  - `operations/intents.ts` (`CreatePaymentIntentInput.supporterKey?`, `recognitionOn?: boolean`; the fingerprint; the upsert and insert inside the transaction; the plan read beside `pageState`);
  - `operations/tip-status.ts` (`recognised`);
  - `operations/profiles.ts` (`publicProfile` sends `recognition` when Pro and the switch is on; `deleteAccount`).
- Test:
  - `packages/database/test/integration/supporters.test.mjs` (new);
  - `intents.test.mjs` or the existing fingerprint test file (extend; find it with `grep -rln requestFingerprint packages/database/test`);
  - `tip-status.test.mjs` (extend);
  - `migration-journal.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('no key: no supporters row, and the fingerprint equals dev\'s for the same input', ...);
  //   compute the dev expression inline in the test (quoteId,label,message,moment[,true]) and compare
  test('a key with a name on a Pro page: one supporter, one tip_supporters row, key stored only as its sha256', ...);
  //   SELECT key_hash = digest(key,'sha256'); no column anywhere equals the raw key
  test('a key without a name, on a Free page, or with recognitionOn false: nothing stored, the tip is made', ...);
  test('the same key twice: one supporter, label and last_at updated, two tip rows', ...);
  test('the same key on two recipients: two supporters rows (no link between them)', ...);
  test('adding a key to a replayed idempotency key is IDEMPOTENCY_CONFLICT', ...);
  test('__testFailAfter tip: no tip, intent, attempt, supporter or tip_supporters row remains', ...);
  test('tip status: recognised only when the tip has a supporter row', ...);
  test('deleting the account deletes its supporters and tip_supporters', ...);
  ```

- [ ] **Steps 2–4: fail, implement, pass**, using the Task 1.2 command pattern. Then typecheck and lint.
- [ ] **Step 5: Commit** `feat(database): record an opted-in supporter key, hashed, per recipient`.

### Task 3.3: API, and the supporter's stop

**Files:**

- Modify:
  - `apps/api/src/checkout/checkout.service.ts` (pass `supporterKey` and `recognitionOn: config.SUPPORTER_RECOGNITION === 'on'`);
  - `status.controller.ts` (`POST :tipId/recognition/stop`), with a new `stopRecognition(db, tipId)` in `operations/supporters.ts`;
  - `config.ts` (`SUPPORTER_RECOGNITION` `on|off`, default `on`) and the logger redaction (`supporterKey`);
  - OpenAPI, and `docs/runbooks/supporter-recognition.md` (new: what the switch does, and that it deletes nothing).
- Test: `tests/integration/supporters-api.test.mjs` (new), `checkout-api.test.mjs` (extend: the log has no key).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a tip with the key on a Pro page: the receipt says recognised', ...);
  test('stop with the token: 204; the supporter row is gone; the tips and notes remain in Tips', ...);
  test('stop twice: 204; stop with a wrong token or unknown tip: 404', ...);
  test('SUPPORTER_RECOGNITION=off: the public page has no recognition flag and the key is ignored', ...);
  test('no log line from the tip request contains the key', ...);
  ```

- [ ] **Steps 2–4: fail, implement, pass**, using the Task 1.3 command pattern.
- [ ] **Step 5: Commit** `feat(api): supporters can stop being recognised from any receipt`.

### Task 3.4: The tick box and the receipt

**Files:**

- Modify: `apps/web/src/components/appreciation-form.tsx` (state `recognise`, shown when `profile.recognition && payerName.trim()`, reset on an empty name, resetting the draft key on change, and sending `supporterKey`), `apps/web/src/app/tip/[tipId]/status-view.tsx` (the line and the stop; "Forget my tips and keys on this phone" also calls `forgetSupporterKeys`), `apps/web/src/lib/api-client.ts` (`stopRecognition`), and `sentry-scrub.ts` (`supporterKey`).
- Test: `tests/e2e/repeat-supporters.spec.ts` (new), `tests/e2e/tip-card.spec.ts` (no tick on Free pages or without a name), `apps/web/test/sentry-scrub.test.mjs`.

- [ ] **Step 1: Write the failing e2e.**

  ```ts
  test('Pro page: typing a name shows the tick, off; ticking sends supporterKey; emptying the name hides and unticks it', ...);
  //   route the createTip request and assert the body; no tick -> body has no supporterKey and localStorage has no tipme.supporters.v1
  test('the second tip from the same browser sends the same key; another recipient gets another', ...);
  test('receipt: "Stop Ada recognising me" works, removes this handle\'s key, and moves focus to the result', ...);
  test('Free page, or an older API without recognition: no tick, today\'s form', ...);
  // expectAccessible each
  ```

- [ ] **Steps 2–4: fail, implement, pass.**
- [ ] **Step 5: Commit** `feat(web): "Let them recognise me next time", off by default`.

### Task 3.5: Privacy lines and records

**Files:** `apps/web/src/app/legal/privacy/page.tsx` (the `covers` list gains "Recognising a returning supporter, only if they choose it, and how to stop"), `docs/security/threat-model.md` (a new row: an opt-in pseudonymous key, per recipient, hashed; threats are linking across recipients, which per-recipient keys prevent, and a leaked hash, which can't be reversed and only groups tips), `docs/00-DECISIONS.md` (builder's calls and the privacy-line wording from Design §3), `ACTIVE_TASK.md`, `HANDOFF.md`.

- [ ] Steps: a `grep` check that fails first, then write, then `prettier --check`, then the full checks (Task 1.5 Step 5), then commit `docs: supporter recognition in the privacy notice outline and the threat model`.

---

## PR 4: Repeat supporters, the recipient's list (Pro)

### Task 4.1: Operations

**Files:** `packages/database/src/operations/supporters.ts` (`mySupporters`, `supporterNotes`). Test: extend `supporters.test.mjs`.

**Interfaces:**

```ts
export function mySupporters(db, userId: string): Promise<MySupporter[]>; // SUPPORTERS_PRO_REQUIRED on Free
export function supporterNotes(
  db,
  userId: string,
  supporterId: string,
): Promise<MySupporterNote[]>; // 404 for another page's id
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('only paid tips count; totals are the sum of recipient net, as strings', ...);
  test('returning is tips >= 2; ordered by last paid tip', ...);
  test('notes exclude hidden or reported notes', ...);
  test('Free page: SUPPORTERS_PRO_REQUIRED; lapse keeps rows and Pro shows them again', ...);
  test('another page\'s supporter id: not found', ...);
  test('a stopped supporter no longer appears', ...);
  ```

- [ ] **Steps 2–5: fail, implement, pass, commit** `feat(database): a Pro recipient's opted-in supporters and their notes`.

### Task 4.2: API

**Files:** `apps/api/src/dashboard/dashboard.controller.ts` (`GET /v1/me/supporters`, `GET /v1/me/supporters/:id/notes`), the filter, and OpenAPI. Test: extend `supporters-api.test.mjs`.

- [ ] Steps: failing tests (Pro 200, Free 403, a foreign id 404, no key or hash in any response body, which you check by `JSON.stringify` and a search for the hash hex), then implement, then pass, then commit `feat(api): Pro supporters list and notes`.

### Task 4.3: The supporters page

**Files:**

- Create: `apps/web/src/app/dashboard/tips/supporters/page.tsx` and `supporters/[id]/page.tsx`.
- Modify: `tips-view.tsx` (a "Your supporters" link, Pro only).
- Test: `tests/e2e/supporters-list.spec.ts` (new).

**UI (board):**

- The table has the columns Supporter (name, with a "Returning" badge in text when returning), Tips, Total and Last.
- Under it: "Only supporters who chose to be recognised are listed. Everyone else stays in your tips as today."
- The empty state is an `EmptySlip`: "No one has chosen to be recognised yet. Supporters can tick a box when they tip you."
- The notes page shows the notes as text with their dates, and the same hide and report controls as the tip detail page, reusing that component.
- Free: the route shows the locked description with a link to `/dashboard/settings#plan`.

- [ ] **Steps 1–4: write a failing e2e (Pro list, notes, Free locked, older API), implement, pass.** Then run the full checks (Task 1.5 Step 5).
- [ ] **Step 5: Commit** `feat(web): your supporters, for Pro`.

---

## PR 5: Where your tips come from

### Task 5.1: Contracts and web capture

**Files:**

- Modify: `packages/contracts/src/analytics.ts` (`TIP_SOURCES_MIN`, `TipSourcesView`, `CHANNEL_WORDS`), `checkout.ts` (`arrivalChannel`), `errors.ts`, `apps/web/src/lib/analytics.ts` (`arrivalChannel()`, set in `profileViewed` before `src` is removed), and `appreciation-form.tsx` (send it when `shouldTrack`).
- Test: `packages/contracts/test/analytics.test.mjs`, `apps/web/test/analytics.test.mjs`, `tests/e2e/tip-card.spec.ts`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('arrivalChannel is one of ANALYTICS_CHANNELS or absent', ...);
  test('profileViewed with ?src=qr: arrivalChannel() is "qr" after the address is cleaned', ...);
  test('nothing about the channel is written to localStorage or sessionStorage', ...);
  // e2e: with navigator.globalPrivacyControl = true (addInitScript), the createTip body has no arrivalChannel
  ```

- [ ] **Steps 2–5: fail, implement, pass, commit** `feat(web): remember how this visit arrived, in memory, for the tip`.

### Task 5.2: Storage and the write

**Files:** `schema.ts` (`tipArrivals`), the new migration `NNNN_tip_arrivals.sql`, `operations/intents.ts` (`arrivalChannel?`, `analyticsEnabled?`), `operations/analytics.ts` (`purgeAnalytics` also purges `tip_arrivals`; a new `tipSources(db, userId, month)`), and `operations/profiles.ts` (`deleteAccount`). Test: `packages/database/test/integration/tip-sources.test.mjs` (new), `analytics.test.mjs` (the purge).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('analyticsEnabled false: no tip_arrivals row, even with a channel', ...);
  test('analyticsEnabled true: one row; the fingerprint is unchanged by the channel', ...);
  test('counts paid tips in the Lagos month; rows under 3 go to otherTips', ...);
  test('purge removes arrivals older than before, keeps newer', ...);
  test('rollback after the tip insert leaves no arrival row', ...);
  ```

- [ ] **Steps 2–5: fail, implement, pass, commit** `feat(database): a tip's arrival channel, only while analytics is on`.

### Task 5.3: API

**Files:** `checkout.service.ts` (pass `analyticsEnabled` with the same expression as `events.controller.ts:37`), `dashboard.controller.ts` (`GET /v1/me/tip-sources`: Pro, `featureVisible('tip_sources')`, `TIP_SOURCES_OFF` when collection is off), the filter, and OpenAPI. Test: `tests/integration/tip-sources-api.test.mjs` (new).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('NODE_ENV=production and ANALYTICS_ENABLED unset: no row is written and the route is 404 TIP_SOURCES_OFF', ...);
  test('enabled, Pro, stage everyone: counts; stage early without the switch: 403', ...);
  test('Free: 403 TIP_SOURCES_PRO_REQUIRED', ...);
  ```

- [ ] **Steps 2–5: fail, implement, pass, commit** `feat(api): Pro tip sources, off while analytics is off`.

### Task 5.4: The dashboard card, and records

**Files:** a new `apps/web/src/components/dashboard/tip-sources-card.tsx`, `home-view.tsx`, `docs/00-DECISIONS.md` (builder's calls, and "on in production only with D-07"), `docs/runbooks/production.md` (the `ANALYTICS_ENABLED` line now also covers tip sources), `ACTIVE_TASK.md`, `HANDOFF.md`. Test: `tests/e2e/tip-sources.spec.ts` (new).

- [ ] **Steps:**
  1. Write a failing e2e: Pro sees the rows; "Other ways" appears; "Fewer than 3 tips this month"; the card is hidden on `TIP_SOURCES_OFF`, on Free, and with an older API.
  2. Implement, then pass.
  3. Run the full checks.
  4. Commit `feat(web): this month's tips came from, for Pro`.

---

## PR 6: Monthly recap

### Task 6.1: Contracts

**Files:** `packages/contracts/src/dashboard.ts` (`MonthlyRecapData`), `errors.ts` (`RECAP_PRO_REQUIRED`). Test: `packages/contracts/test/recap.test.mjs` (new). It is a type-level and runtime check that a sample has exactly the six keys.

- [ ] Steps: fail, implement, pass, then commit `feat(contracts): the monthly recap`.

### Task 6.2: Storage and the build

**Files:** `schema.ts` (`monthlyRecaps`; `notifications.recap_id`; the kind gains `monthly_recap`), the new migration `NNNN_monthly_recaps.sql`, a new `operations/recaps.ts` (`buildMonthlyRecap`, `runMonthlyRecaps`, `listMyRecaps`, `getMyRecap`), `operations/profiles.ts` (`deleteAccount`), and the mail type `packages/mail/src/templates/types/monthly-recap.ts` plus the registry. Test: `packages/database/test/integration/recaps.test.mjs` (new), the mail template tests.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('only Pro pages with a paid tip in the month get a recap; one per page and month on rerun', ...);
  test('tip count, best week (by tips, clipped to the month), milestones and notes (flagged excluded)', ...);
  test('the stored data has exactly the six keys: no label, message or tip id', ...);
  test('notification and mail only when the feature is visible and notify_weekly_reports is on', ...);
  test('Free or invisible feature: getMyRecap refuses; lapse keeps rows', ...);
  ```

- [ ] **Steps 2–5: fail, implement, pass, commit** `feat(database): monthly recaps for Pro pages`.

### Task 6.3: Worker and API

**Files:** `apps/worker/src/job-worker.ts` (call `runMonthlyRecaps` after `evaluatePeriodMoments` in `MONTHLY_MOMENTS_JOB`, logging `reports.monthly.completed` with the count only), `apps/api/src/dashboard/dashboard.controller.ts` (`GET /v1/me/recaps`, `GET /v1/me/recaps/:month`), `apps/api/src/dev/pretend-inbox.controller.ts` (a dev trigger next to the weekly one, if that file's pattern allows), and OpenAPI. Test: `tests/integration/recaps-api.test.mjs` (new), the worker job test (extend whichever file covers `MONTHLY_MOMENTS_JOB`; find it with `grep -rln moments.monthly apps/worker/test`).

- [ ] Steps: fail, implement, pass, then commit `feat(worker,api): build and serve the monthly recap`.

### Task 6.4: The card

**Files:** create `apps/web/src/lib/month-share.ts` and `apps/web/src/lib/month-card.ts`. Test: `apps/web/test/month-share.test.mjs` (new).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('shareableMonth leaves out the total unless showTotal', ...);
  test('extra keys on the input (topSupporterLabel, message, name) never reach the output', ...);
  test('best week reads "Best week: 20–26 Oct"; null best week is left out', ...);
  ```

- [ ] Steps: fail, implement, pass, then commit `feat(web): a shareable month card, built field by field`.

### Task 6.5: The recap page, and records

**Files:** create `apps/web/src/app/dashboard/reports/month/[month]/page.tsx`; modify `home-view.tsx` (the ready link), the noindex route list, the notifications item for `monthly_recap`, `docs/00-DECISIONS.md` (builder's calls), `ACTIVE_TASK.md` and `HANDOFF.md`. Test: `tests/e2e/monthly-recap.spec.ts` (new).

- [ ] **Steps:**
  1. Write a failing e2e: Pro sees the page; the switch is off by default and the card has no total; switching it on shows the total; Share downloads or shares the image; Free sees the locked description; an older API means no home link.
  2. Implement, then pass.
  3. Run the full checks.
  4. Commit `feat(web): your month on TipMe, for Pro`.

---

## Open for the owner

Each has a default the builder ships with.

1. **Priority support: the target and who staffs it** (board: Owner to decide).
   - Default: `SUPPORT_PRO_TARGET_HOURS` unset, so Pro sees "answered first" with no time promised.
   - The board's sample is 4 hours. Name the target, and who answers.
2. **Support request retention.** Default: an answered request closes after 30 days, and closed requests are deleted 180 days later (the same 180 days as page reports).
3. **Repeat supporters and D-07.**
   - Default: it ships on (`SUPPORTER_RECOGNITION=on`), because you approved option (a), opt-in and off by default.
   - Should it wait for the D-07 privacy review instead, as attribution does? The switch makes either choice a config change.
   - Also: is "until they stop, or the recipient deletes their account" the right retention?
4. **The recap "in the weekly email's place".**
   - Default: on the 1st, a notification and an email through the same channels and preference as the weekly report. The weekly email is unchanged.
   - Or should the recap email replace that week's weekly email?
5. **The recap's "best week".** Default: by number of tips, since the card hides money by default. Or by amount?
6. **Early access, which features and at what stage.** Default: "Where your tips come from" and the monthly recap are the first two, shipped at **Early**. Staff move them to Everyone. Or ship them straight to everyone, or pick other features?
7. **Tip sources' small numbers.** Default: rows under 3 fold into "Other ways", and a month with only 1–2 tips says "Fewer than 3 tips this month". Keep the threshold at 3?
8. **D-07: turning attribution on in production.** It is built and stays off (`ANALYTICS_ENABLED` unset in production). Turning it on is your decision under D-07, and it also turns on today's visit analytics.
9. **Board section 6, profile sections (services, portfolio, events): Owner to confirm.** Not planned. Say yes, a light version, or no.
10. **Tip goals and campaigns:** they stay TODO until our payment partner's view is in. Not planned.

Builder's calls this plan makes (cost if wrong):

- **A separate Support queue, not an issue kind.** Cost: one admin menu entry.
- **Per-recipient keys.** Cost: none in features. The privacy gain is that stored data can't link tips across recipients.
- **Pro priority is the plan when the request was sent.** Cost: a later upgrade isn't re-sorted.
- **The channel is left out of the idempotency fingerprint.** Cost: none, because a replay keeps the first channel.
- **No upsell card for Free on tip sources or recaps.** Cost: a later card.
