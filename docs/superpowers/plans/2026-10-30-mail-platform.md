# Mail Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real, pluggable, tracked email for TipMe (ZeptoMail, SES, pretend), administered from ops, with email-code sign-in and recovery.

**Architecture:** A new `@tipme/mail` package holds the provider interface, three adapters, the template catalogue and a conformance kit. It knows nothing of the database. `@tipme/database` holds the sealed mail queue, events, suppressions, preferences, provider administration and analytics. The worker's mail loop claims queued mail, renders it with `@tipme/mail` and sends it outside any transaction. The API receives provider webhooks and serves ops and recipient endpoints. The web app adds `/ops/providers` and `/ops/email` plus the recipient sign-in, settings and recovery screens.

**Tech Stack:** TypeScript (strict), Node 24, NestJS, Drizzle and Postgres, BullMQ schedules, Next 16 App Router, zod 4.6.7, `node --test`, Playwright, `@aws-sdk/client-sesv2@3.1152.0` (the one new dependency).

**Spec:** `docs/superpowers/specs/2026-10-30-mail-platform-design.md` (approved 30 Oct 2026). Section references (§) point there.

## Global Constraints

- **Credentials never leave their home:**
  - codes, links, addresses, email bodies and provider responses never go to logs, Sentry, analytics or ops screens;
  - logs carry message id, type, category, provider, status and error code only;
  - the masked hint `t•••@domain` is the only address form outside sealed storage, except an audited reveal.
- **No provider call inside a database transaction** (ADR-0004).
- **Sealing:** `sealSecret` and `openSecret` from `packages/database/src/operations/secret-box.ts`, with `MAIL_SEAL_KEY` (32 bytes, base64, like `OPS_TOTP_KEY`).
- **Retention:**
  - `to_sealed` and `data_sealed` are wiped 7 days after a final status;
  - message metadata, `mail_message_events` and `rendered_sealed` are kept 2 years;
  - security emails never get `rendered_sealed`.
- **Tracking:** opens and clicks are on for every category except `security`. SES uses `SES_CONFIGURATION_SET` (tracked) and `SES_CONFIGURATION_SET_UNTRACKED`; ZeptoMail uses `track_opens` and `track_clicks`.
- **Categories:** `security | account | transactional | engagement | marketing`. Only `transactional` (per-type toggles) and `engagement` can be turned off. No marketing email ships.
- **Production:** the `mock` mail provider is refused (config validation and the ops switch). `MESSAGING_PROVIDER` is removed.
- **Addresses:** production `TipMe <hello@mail.usetipme.xyz>`, Reply-To `support@usetipme.xyz`; staging `TipMe Staging <hello@staging-mail.usetipme.xyz>`.
- **Time:** analytics periods are Lagos calendar periods (reuse `lagosDaysBefore` and the week logic in `reports.ts`).
- **Contracts** in `packages/contracts`, zod at ingress, `.strict()` request schemas, explicit output types. Amounts as minor-unit strings.
- **Every ops route** names exactly one permission with `@OpsPermission(...)`. New permissions: `providers.manage` and `recoveries.manage`, added to `OPS_PERMISSIONS`, with a migration for the `role_permissions_known` check. The Owner role gets them through `ensureOwnerRole`.
- **Every ops change** is audited through `recordAudit` with a reason.
- **New dependency** recorded in `docs/third-party-component-register.md`.
- **Copy** follows the design constitution voice: plain, specific, no exclamation marks in security email.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each Part is its own PR into `dev`, whose body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

**Commands used throughout**

- Build: `pnpm -s turbo run build --filter=<pkg>...`
- Unit tests: `node --test <file>`
- Integration tests need the throwaway Postgres and Redis: `export DATABASE_URL=<test db url> REDIS_URL=<test redis url>`. Run one file with `node --test <file>`, or everything with `TEST_CONCURRENCY=4 node scripts/test-integration.mjs`.
- Whole-repo gates before each PR: `pnpm -s turbo run typecheck lint`, `pnpm -s format:check`, `pnpm -s test`, `pnpm -s api:openapi && pnpm -s docs:generate` (then commit any changes).
- Migrations: `pnpm -s --filter @tipme/database exec drizzle-kit generate --name <name>`, then prettier on `drizzle/meta`.

## Review Focus

1. **A burst of optional mail** (a weekly-report run or policy broadcast to every user) queued ahead of a sign-in code: the code must still go out first, within seconds. Pinned by test `security mail is claimed before older engagement mail` (Task 5).
2. **A provider outage longer than a code's life:** retried codes past `expires_at` become `expired` and are never delivered late; other mail keeps retrying. Pinned by test `a code that outlives a provider outage expires instead of arriving late` (Task 5).
3. **A webhook that arrives before TipMe recorded the send** (provider fast, our "sent" write slow), or one that has only our reference: events match by our `reference` first, then by provider message id. Pinned by test `an event that arrives before the send is recorded still lands on its message` (Task 8).
4. **User-supplied text in templates** (display names and supporter labels with `<script>`, quotes, emoji, right-to-left text): escaped in HTML and readable in text. Pinned by test `user text is escaped in HTML and intact in text` (Task 2).
5. **One address playing two roles** (someone's recovery email is another account's sign-in email, or the same as their own): the uniqueness rules hold and recovery never crosses accounts. Pinned by test `a recovery email that is another account's sign-in email is refused` (Task 20).

---

# Part 1 — Mail foundation (PR 1)

### Task 1: `@tipme/mail` package — interface, errors, pretend adapter, conformance kit

**Files:**

- Create: `packages/mail/{package.json,tsconfig.json,eslint.config.mjs}` (copied from `packages/payments`, name `@tipme/mail`, deps `zod`, `@tipme/contracts`)
- Create: `packages/mail/src/{index.ts,provider.ts,errors.ts,mock/provider.ts,conformance.ts}`
- Test: `packages/mail/test/mock.test.mjs`

**Interfaces — Produces:**

```ts
export type MailProviderName = 'mock' | 'zeptomail' | 'ses';
export interface OutgoingMail {
  reference: string;            // mail_messages.id
  to: string;
  from: { address: string; name: string };
  replyTo?: string;
  subject: string; text: string; html: string;
  headers: Record<string, string>;  // List-Unsubscribe etc.
  tracking: boolean;
}
export type MailEventKind = 'delivered' | 'opened' | 'clicked' | 'soft_bounce' | 'hard_bounce' | 'complaint';
export interface MailProviderEvent {
  kind: MailEventKind; providerEventId: string; occurredAt: Date;
  address: string | null; providerMessageId: string | null; reference: string | null;
  linkKey: string | null;      // from the `ml` query parameter of a clicked link
}
export type MailWebhookResult =
  | { ok: true; events: MailProviderEvent[]; confirmSubscriptionUrl?: string }
  | { ok: false; reason: 'signature' | 'stale' | 'malformed' | 'topic' };
export interface MailProviderStatus { sandbox: boolean | null; detail: string | null }
export interface MailProvider {
  name: MailProviderName;
  capabilities: { marketing: boolean };
  send(mail: OutgoingMail): Promise<{ providerMessageId: string }>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): MailWebhookResult;
  status(): Promise<MailProviderStatus>;
}
export class MailRejectedError extends Error { constructor(readonly code: string) }   // permanent
export class MailTemporaryError extends Error { constructor(readonly code: string) }  // retry
export function createMockMailProvider(sink: (mail: OutgoingMail) => Promise<void>): MailProvider;
export function runMailProviderConformance(t: TestContext, make: ConformanceFactory): Promise<void>;
```

`ConformanceFactory` is `(transport: FakeTransport) => { provider: MailProvider; signWebhook(events: unknown, now: Date): { body: Buffer; headers: Record<string, string> } }`. `FakeTransport` lets a test script responses: ok with an id, a permanent error, a temporary error, or a timeout.

- [ ] **Step 1:** Write `packages/mail/test/mock.test.mjs`:
  - `the pretend provider hands the rendered mail to its sink` asserts the sink got `reference`, `to`, `subject` and `tracking`, and that `send` resolves `{ providerMessageId: 'mock-<reference>' }`;
  - `the pretend provider accepts no webhooks` asserts `verifyWebhook(...)` returns `{ ok: false, reason: 'signature' }`;
  - `the pretend provider reports no sandbox`: `status()` gives `{ sandbox: null, detail: 'pretend' }`.
- [ ] **Step 2:** Run `pnpm -s turbo run build --filter=@tipme/mail... ; node --test packages/mail/test/mock.test.mjs`. Expected: FAIL (the package doesn't exist yet).
- [ ] **Step 3:** Implement the package files above. `conformance.ts` defines these cases, each a `t.test`:
  - send ok, which returns the id;
  - permanent, which throws `MailRejectedError` with the code;
  - temporary, which throws `MailTemporaryError`;
  - timeout, which throws `MailTemporaryError('timeout')`;
  - webhook ok, with events;
  - tampered body, giving `signature`;
  - stale timestamp (older than 5 minutes), giving `stale`;
  - unknown event type, ignored (`ok` with no events).
    Register `@tipme/mail` in `pnpm-workspace` and turbo through the package's own `build`, `typecheck`, `lint` and `test` scripts, like payments.
- [ ] **Step 4:** Run the test. Expected: PASS 3/3.
- [ ] **Step 5:** Commit `feat(mail): mail provider interface, pretend adapter and conformance kit`.

### Task 2: Template catalogue — layout, escaping, link keys, snapshot redaction

**Files:**

- Create: `packages/mail/src/templates/{define.ts,layout.ts,escape.ts,registry.ts,types/*.ts}`
- Test: `packages/mail/test/templates.test.mjs`

**Interfaces — Produces:**

```ts
export type MailCategory =
  'security' | 'account' | 'transactional' | 'engagement' | 'marketing';
export interface MailContext {
  webOrigin: string;
  unsubscribeUrl: string | null;
}
export interface MailType<T> {
  id: string;
  category: MailCategory;
  schema: z.ZodType<T>;
  /** Per-type preference key on profiles/mail_preferences, or null if not toggleable. */
  preference:
    'notify_tip_emails' | 'notify_weekly_reports' | 'notify_milestones' | null;
  render(
    data: T,
    ctx: MailContext,
  ): { subject: string; text: string; html: string };
}
export function defineMailType<T>(t: MailType<T>): MailType<T>;
export const MAIL_TYPES: Record<string, MailType<any>>; // documented `any`: registry of heterogeneous types
export function renderMail(
  typeId: string,
  data: unknown,
  ctx: MailContext,
): {
  subject: string;
  text: string;
  html: string;
  snapshot: { subject: string; text: string; html: string } | null;
};
export function mailLink(
  ctx: MailContext,
  path: string,
  linkKey: string,
  personal?: boolean,
): string; // adds ml=<linkKey>; personal links are redacted in the snapshot
```

Part 1 registers the types that exist today:

- `tip_received` (transactional, `notify_tip_emails`);
- `weekly_report` (engagement, `notify_weekly_reports`);
- `email_verification_link` (security, retired in Part 5);
- `recovery_link` (security, retired in Part 6);
- `phone_change_warning` (security, retired in Part 6);
- `provider_test` (account; tracked off; `preference: null`).
  Each type's copy keeps today's `pretend_outbox` wording, minus "(Pretend payment…)" when the provider isn't the mock (passed in the data as `pretendPayment: boolean`).

- [ ] **Step 1:** Write the tests:
  - `every registered type renders subject, text and html from sample data`, which loops `MAIL_TYPES` using each module's exported `sample`;
  - `user text is escaped in HTML and intact in text`: `tip_received` with `supporterLabel: '<script>x</script> "Ada" 🎉 مرحبا'` keeps no `<script` in the HTML, keeps the raw label in the text, and has `&quot;` in the HTML;
  - `links carry their link key`: `mailLink(ctx,'/dashboard','open_dashboard')` contains `ml=open_dashboard`;
  - `security mail has no snapshot`: `renderMail('email_verification_link', …).snapshot === null`;
  - `personal links are redacted in the snapshot`: a snapshot of a type with a personal link contains `[personal link]` and not the token;
  - `a type rejects data that fails its schema`: `renderMail('tip_received', {}, ctx)` throws `ZodError`.
- [ ] **Step 2:** Run `node --test packages/mail/test/templates.test.mjs`. Expected: FAIL (`MAIL_TYPES` is undefined).
- [ ] **Step 3:** Implement the files.
  - `layout.ts`: table-based HTML, max 600px, inline CSS, brand `#7A32F9`, a `color-scheme` meta for light and dark, and a footer showing why the person got the email, the settings link (only when `unsubscribeUrl` is set) and `support@usetipme.xyz`.
  - `escape.ts`: escapes `& < > " '`.
- [ ] **Step 4:** Run the test. Expected: PASS 6/6.
- [ ] **Step 5:** Commit `feat(mail): template catalogue with escaping, link keys and redacted snapshots`.

### Task 3: Mail tables and `enqueueMail`

**Files:**

- Modify: `packages/database/src/schema.ts` (new tables), `packages/database/package.json` (dep `@tipme/mail`)
- Create: `packages/database/src/operations/mail-queue.ts`, migration `00NN_mail_queue.sql`
- Test: `packages/database/test/integration/mail-queue.test.mjs`

**Schema** (names fixed by this plan):

- **`mail_messages`:**
  - `id uuid pk`, `type text`, `category text` (checked against the five categories), `user_id uuid null references users`, `dedupe_key text unique`;
  - `to_sealed text null`, `to_hint text`, `data_sealed text null`, `rendered_sealed text null`;
  - `status text` (checked: `queued sending sent failed suppressed skipped expired bounced complained`), `priority smallint` (0 for security, 1 for account, 2 for others);
  - `pinned_provider text null`, `provider text null`, `provider_message_id text null`;
  - `attempts int default 0`, `next_attempt_at timestamptz`, `claimed_at timestamptz null`, `last_error text null`, `expires_at timestamptz null`;
  - `created_at`, `sent_at null`, `final_at null`;
  - indexes on `(status, priority, next_attempt_at)`, `(created_at)`, `(type, created_at)`, `(user_id, created_at)` and `(provider, provider_message_id)`.
- **`mail_message_events`:** `id`, `message_id null`, `kind` (checked: `queued sent send_failed delivered opened clicked soft_bounce hard_bounce complaint suppressed skipped_preference expired`), `provider null`, `provider_event_id null`, `link_key null`, `occurred_at`, `received_at`. Unique on `(provider, provider_event_id)` where not null; index on `(message_id, occurred_at)`.
- **`mail_daily_stats`:** `lagos_date date`, `type text`, `category text`, `provider text` (`''` before a send), `kind text`, `count int`. Primary key on all but `count`.
- **`mail_suppressions`:** `address_hmac text pk`, `reason` (checked: `hard_bounce complaint repeated_soft_bounce manual`), `provider null`, `note null`, `created_at`.
- **`mail_preferences`:** `user_id pk references users`, `engagement bool default true`, `marketing bool default false`, `updated_at`.

**Interfaces — Produces:**

```ts
export interface MailSealing {
  key: Buffer;
  hmacKey: Buffer;
} // hmacKey = HKDF(key, 'mail-address') for suppressions
export function enqueueMail(
  tx: Database | Tx,
  sealing: MailSealing,
  input: {
    type: string;
    to: string;
    userId?: string | null;
    data: unknown;
    dedupeKey: string;
    expiresAt?: Date;
    pinnedProvider?: MailProviderName;
    now?: Date;
  },
): Promise<{ id: string; created: boolean }>;
export function addressHmac(sealing: MailSealing, address: string): string;
export function recordMailEvent(
  tx: Database | Tx,
  ev: {
    messageId: string | null;
    kind: string;
    provider?: string | null;
    providerEventId?: string | null;
    linkKey?: string | null;
    occurredAt: Date;
    type?: string;
    category?: string;
  },
): Promise<boolean>; // false when deduped; also bumps mail_daily_stats
```

`enqueueMail` checks `data` against `MAIL_TYPES[type].schema`, normalises the address with `normaliseEmail`, seals the address and data, sets the priority from the category, inserts `queued` (`ON CONFLICT (dedupe_key) DO NOTHING`), and records a `queued` event when it creates a row.

- [ ] **Step 1:** Write the tests:
  - `mail exists only when the change that caused it commits`: enqueue inside a transaction that throws, and count stays 0;
  - `the same dedupe key queues once`: two enqueues give `created: true` then `false`;
  - `addresses and data are sealed at rest`: a raw `SELECT to_sealed, data_sealed` has no `@` and no data value;
  - `the hint is masked`: `to_hint = 'a•••@example.com'`;
  - `bad data is refused before anything is stored`: throws, count 0;
  - `security mail gets the highest priority`: `email_verification_link` gives `priority 0`;
  - `an event is recorded once and counted in the day's stats`: the same `(provider, providerEventId)` twice gives one row and `mail_daily_stats.count = 1`.
- [ ] **Step 2:** Generate the migration and build. Run `node --test packages/database/test/integration/mail-queue.test.mjs`. Expected: FAIL (`enqueueMail` isn't exported).
- [ ] **Step 3:** Implement and export it from `operations/index`.
- [ ] **Step 4:** Run it. Expected: PASS 7/7.
- [ ] **Step 5:** Commit `feat(database): sealed mail queue, events, daily stats and suppressions`.

### Task 4: Existing emails go through the queue

**Files:**

- Modify: `packages/database/src/operations/{email.ts,notifications.ts,reports.ts}`: replace every `writePretendMessage({ channel: 'email', … })` with `enqueueMail`. The WhatsApp and SMS pretend writes are unchanged.
- Modify: every caller of these operations in `apps/api` and `apps/worker`, so they pass `MailSealing` (built from `MAIL_SEAL_KEY`).
- Test: update `packages/database/test/integration/{notifications,reports,email}*.test.mjs` assertions from `pretend_outbox` to `mail_messages`.

Dedupe keys:

- `tip_received.<tipId>`;
- `weekly_report.<profileId>.<isoWeek>`;
- `email_verification_link.<sha256(token)>`;
- `recovery_link.<sha256(token)>`;
- `phone_change_warning.<recoveryId>`.

- [ ] **Step 1:** Change the existing tests to expect one `mail_messages` row of the right `type` and `to_hint` (and no `pretend_outbox` email row) for: tip notification, weekly report, email verification, recovery link and phone-change warning. Add `tip email is not queued when tip emails are off`.
- [ ] **Step 2:** Run those files. Expected: FAIL (rows are still in `pretend_outbox`).
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the files. Expected: PASS.
- [ ] **Step 5:** Commit `refactor(database): emails are queued for delivery instead of written to the pretend inbox`.

### Task 5: Worker mail delivery loop, configuration and the pretend sink

**Files:**

- Create: `packages/database/src/operations/mail-delivery.ts`, `apps/worker/src/mail-delivery-loop.ts`, `packages/mail/src/registry.ts`
- Modify: `apps/worker/src/{config.ts,job-worker.ts,main.ts}` and `apps/api/src/config.ts` (shared mail config: drop `MESSAGING_PROVIDER`; add `MAIL_DEFAULT_PROVIDER`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` and `MAIL_SEAL_KEY`, refusing `mock` in production)
- Test: `packages/database/test/integration/mail-delivery.test.mjs`, `apps/worker/test/config.test.mjs` (extend)

**Interfaces — Produces:**

```ts
// database
export function claimDueMail(
  db: Database,
  input: { now: Date; limit: number },
): Promise<ClaimedMail[]>; // FOR UPDATE SKIP LOCKED, order by priority, next_attempt_at; marks sending, claimed_at=now
export interface ClaimedMail {
  id: string;
  type: string;
  category: MailCategory;
  userId: string | null;
  to: string;
  data: unknown;
  pinnedProvider: MailProviderName | null;
  expiresAt: Date | null;
  attempts: number;
}
export function mailGate(
  db: Database,
  sealing: MailSealing,
  m: ClaimedMail,
  now: Date,
): Promise<'send' | 'expired' | 'suppressed' | 'skipped_preference'>;
export function recordMailSent(
  db: Database,
  input: {
    id: string;
    provider: MailProviderName;
    providerMessageId: string;
    snapshot: object | null;
    sealing: MailSealing;
    now: Date;
  },
): Promise<void>;
export function recordMailFailure(
  db: Database,
  input: {
    id: string;
    provider: MailProviderName;
    code: string;
    permanent: boolean;
    now: Date;
  },
): Promise<void>;
export function requeueStuckMail(db: Database, now: Date): Promise<number>; // sending + claimed_at older than 2 min → queued
export function wipeExpiredMailContent(
  db: Database,
  now: Date,
): Promise<number>; // final + 7 days → to_sealed/data_sealed null
export const MAIL_BACKOFF_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000,
]; // 6th failure → failed
// mail
export function resolveMailProvider(input: {
  pinned: MailProviderName | null;
  override: MailProviderName | null;
  active: MailProviderName;
  configured: ReadonlySet<MailProviderName>;
}): MailProviderName;
// worker
export function startMailDelivery(o: {
  db;
  sealing;
  providers: Map<MailProviderName, MailProvider>;
  activeProvider: () => Promise<MailProviderName>;
  overrideFor: (userId: string) => Promise<MailProviderName | null>;
  from;
  replyTo;
  webOrigin;
  logger;
  intervalMs?: number;
}): { stop(): Promise<void> };
```

In Part 1, `activeProvider` returns `MAIL_DEFAULT_PROVIDER` and `overrideFor` returns `null`; Part 3 wires real ones. The mock provider's sink calls `writePretendMessage(db, { channel: 'email', recipientHint, userId, subject, body: text })`, so the pretend inbox and the e2e tests keep working.

- [ ] **Step 1:** Write the tests:
  - `queued mail is sent and recorded`: status `sent`, `provider='mock'`, a `sent` event, and the pretend inbox has the subject;
  - `security mail is claimed before older engagement mail` (Review Focus 1): 50 `weekly_report` rows created earlier, then one `email_verification_link`; the first `claimDueMail(limit: 1)` returns the security mail;
  - `a temporary failure is retried on the backoff schedule`: `attempts=1`, `next_attempt_at = now + 30s`, `last_error` = the code;
  - `the sixth temporary failure fails the mail`;
  - `a permanent rejection fails at once`;
  - `a code that outlives a provider outage expires instead of arriving late` (Review Focus 2): `expires_at` is in the past at claim time, so `mailGate` gives `expired`, the status is `expired` and nothing is sent;
  - `suppressed addresses are not sent to` (an `addressHmac` row exists, so the status is `suppressed`);
  - `a preference turned off after queueing is respected` (`tip_received` with `notify_tip_emails` off at send time, so the status is `skipped`);
  - `mail stuck in sending is requeued after two minutes`;
  - `sealed content is wiped seven days after the final status, metadata kept`;
  - `security mail is sent without tracking and with no snapshot`.
    In the worker config tests: `MAIL_DEFAULT_PROVIDER=mock is refused in production`, and `MAIL_SEAL_KEY must be 32 bytes`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. The loop runs every 500 ms and processes 20 mails per tick, sequentially. Rendering uses `renderMail`. The unsubscribe URL is `null` until Part 7.
- [ ] **Step 4:** Run the tests, then the full integration suite. Expected: PASS. Existing e2e suites that read the pretend inbox still pass locally (`pnpm -s test:e2e` on a local stack).
- [ ] **Step 5:** Commit `feat(worker): mail delivery loop with priority, retries, expiry and suppression checks`, then open PR 1.

# Part 2 — Real providers and webhooks (PR 2)

### Task 6: ZeptoMail adapter

**Files:** Create `packages/mail/src/zeptomail/{provider.ts,errors.ts,webhook.ts}`. Test: `packages/mail/test/zeptomail.test.mjs`

**Interfaces — Produces:** `createZeptoMailProvider(config: { apiKey: string; apiBase: string; webhookKey: string; bounceAddress?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): MailProvider`.

- **Send:** `POST ${apiBase}/v1.1/email` with `Authorization: Zoho-enczapikey ${apiKey}`. The body maps `from`, `to:[{email_address:{address}}]`, `reply_to:[{address}]`, `subject`, `textbody`, `htmlbody`, `client_reference: reference`, `mime_headers: headers`, `track_opens` and `track_clicks` (both `= tracking`) and `bounce_address`. A success response's `request_id` becomes `providerMessageId`.
- **Error mapping:**
  - temporary: `LE_101`, `LE_102`, `SMI_115`, `SM_133`, HTTP 429 and 5xx;
  - permanent: everything else (`SM_111`, `SM_113`, `SERR_157`, `SM_128`, `AE_101`, `GE_102`, `SM_101`, `SERR_156`).
- **Webhook:**
  - Parse `producer-signature` (`ts=…;s=…;s-algorithm=HmacSHA256`) and reject any other algorithm.
  - Reject `|now − ts| > 5 min` as `stale`.
  - The signed payload is the URL-decoded value after the first `=` of the raw form body. HMAC-SHA256 it with `webhookKey`, compare with `timingSafeEqual` against the base64 of the URL-decoded `s`.
  - Event names map: `hardbounce` to `hard_bounce`, `softbounce` to `soft_bounce`, `fbl_complaint` to `complaint`, `email_open` to `opened`, `email_link_click` to `clicked` (take `linkKey` from the clicked URL's `ml`).
  - `client_reference` becomes `reference`, `request_id` becomes `providerMessageId`, `webhook_request_id` plus the index becomes `providerEventId`.

- [ ] **Step 1:** Write tests:
  - `runMailProviderConformance(t, zeptoFactory)`;
  - `sends the documented request shape`;
  - `maps every documented error code`, as a table test;
  - `click events carry the link key`;
  - `a signature with + in the payload verifies` (the documented decode pitfall);
  - `a non-HmacSHA256 algorithm is refused`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mail): ZeptoMail adapter with signed webhooks`.

### Task 7: SES adapter

**Files:** Create `packages/mail/src/ses/{provider.ts,sns.ts,events.ts}`. Add the dependency `@aws-sdk/client-sesv2@3.1152.0`. Test: `packages/mail/test/ses.test.mjs`

**Interfaces — Produces:** `createSesProvider(config: { region: string; credentials?: { accessKeyId: string; secretAccessKey: string }; configurationSet: string; configurationSetUntracked: string; topicArn: string; client?: Pick<SESv2Client,'send'>; fetchCert?: (url: string) => Promise<string>; now?: () => Date }): MailProvider`.

- **Send:** `SendEmailCommand` with `Content.Simple` (subject, text and HTML bodies), `Headers` from `headers`, `ConfigurationSetName` (tracked or untracked by `tracking`) and `EmailTags: [{Name:'ref', Value: reference}]`. The result's `MessageId` becomes `providerMessageId`.
- **Error mapping:**
  - permanent: `MessageRejected`, `MailFromDomainNotVerifiedException`, `AccountSuspendedException`, `BadRequestException`;
  - temporary: `TooManyRequestsException`, `LimitExceededException`, `SendingPausedException`, network errors and 5xx.
- **`status()`:** `GetAccountCommand` gives `{ sandbox: !ProductionAccessEnabled, detail: 'quota <Max24HourSend>/day' }`.
- **SNS verification** in `sns.ts`:
  - `SigningCertURL` must be `https://sns.<region>.amazonaws.com/…pem`;
  - `TopicArn` must equal the configured topic, else `topic`;
  - for `SignatureVersion` 1 (SHA1) and 2 (SHA256), build the canonical string per AWS's field order for `Notification` and `SubscriptionConfirmation`, then verify with `crypto.verify`;
  - certificates are cached by URL;
  - `Timestamp` older than 1 hour is `stale`.
    Because `verifyWebhook` is synchronous, certificate fetching happens through a primed cache: the API calls `await provider.prepareWebhook?.(rawBody)` before verifying. Add an optional `prepareWebhook(rawBody: Buffer): Promise<void>` to `MailProvider` in this task, and update Task 1's interface and the mock.
- **Event mapping:** `Bounce` with `bounceType: Permanent` is `hard_bounce`, otherwise `soft_bounce`; `Complaint` is `complaint`; `Delivery` is `delivered`; `Open` is `opened`; `Click` is `clicked` (link key from the `ml` parameter of `click.link`). `reference` comes from `mail.tags.ref[0]`. `providerEventId` is the SNS `MessageId`.
- **`SubscriptionConfirmation`:** returns `ok` with `confirmSubscriptionUrl` (only when the topic matches).

- [ ] **Step 1:** Write tests:
  - the conformance kit (with a test certificate and key generated in the test, served by `fetchCert`);
  - `tracked and untracked mail use their configuration sets`;
  - `a certificate URL off sns.<region>.amazonaws.com is refused`;
  - `a message for another topic is refused`;
  - `a permanent bounce suppresses, a transient one does not` (mapping only);
  - `status reports sandbox from GetAccount`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mail): SES adapter with verified SNS events`.

### Task 8: Webhook endpoints and event handling

**Files:**

- Create: `apps/api/src/mail/{mail.module.ts,mail-webhook.controller.ts,mail-providers.provider.ts}`, `packages/database/src/operations/mail-events.ts`
- Test: `packages/database/test/integration/mail-events.test.mjs`, `tests/integration/mail-webhook-api.test.mjs`

**Interfaces — Produces:**

```ts
export function applyMailProviderEvent(
  db: Database,
  sealing: MailSealing,
  provider: MailProviderName,
  ev: MailProviderEvent,
  now: Date,
): Promise<'recorded' | 'duplicate' | 'unmatched'>;
// API: POST /v1/webhooks/mail/:provider   (raw body; 200 on ok/duplicate, 401 on signature/topic, 400 malformed/stale, 404 unconfigured provider)
```

**Rules:**

- Match the message by `reference` (a UUID equal to `mail_messages.id`), else by `(provider, provider_message_id)`.
- Record the event (deduplicated).
- `hard_bounce` or `complaint`: upsert a suppression (`hard_bounce` or `complaint`), and set the message status to `bounced` or `complained`.
- `soft_bounce`: if three or more `soft_bounce` events for that address hash in the last 7 days, upsert a `repeated_soft_bounce` suppression. Store `address_hmac` on soft-bounce events in a nullable column `address_hmac` of `mail_message_events`, added by this task's migration.
- Unmatched events with an address still suppress.
- SES `SubscriptionConfirmation`: the API `GET`s `confirmSubscriptionUrl` (only that URL), outside any transaction, and logs `mail_webhook.sns_subscribed`.

- [ ] **Step 1:** Write tests:
  - `a hard bounce suppresses the address and marks the message`;
  - `three soft bounces in seven days suppress`;
  - `a complaint suppresses`;
  - `a duplicate event changes nothing`;
  - `an event that arrives before the send is recorded still lands on its message` (Review Focus 3): enqueue, then claim (status `sending`, no provider id yet), then an event with only `reference`, which is recorded on that message;
  - `a bounce from a provider that is no longer active still counts`;
  - API: `an unsigned ZeptoMail webhook is refused with 401 and stores nothing`, `an unconfigured provider is 404`, `a SubscriptionConfirmation is confirmed only for the configured topic`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): mail provider webhooks with suppression handling`.

### Task 9: Provider configuration in API and worker

**Files:** Modify `apps/{api,worker}/src/config.ts`, `apps/api/src/mail/mail-providers.provider.ts` and `apps/worker/src/job-worker.ts`. Test: config tests in both apps.

**Keys:**

- ZeptoMail: `ZEPTOMAIL_API_KEY`, `ZEPTOMAIL_API_BASE` (URL, no default), `ZEPTOMAIL_WEBHOOK_KEY`, `ZEPTOMAIL_BOUNCE_ADDRESS?`.
- SES: `SES_REGION` (default `eu-north-1`), `SES_ACCESS_KEY_ID?`, `SES_SECRET_ACCESS_KEY?`, `SES_CONFIGURATION_SET`, `SES_CONFIGURATION_SET_UNTRACKED`, `SES_SNS_TOPIC_ARN`.

A provider is configured only when all its required keys are set. Any partial set fails startup naming the missing key (value never shown). `MAIL_DEFAULT_PROVIDER` must be configured. Produces `configuredMailProviders(config): Map<MailProviderName, MailProvider>`, used by the API (webhooks, status, tests) and the worker (send).

- [ ] **Step 1:** Tests:
  - `a partial ZeptoMail configuration fails startup naming the missing key`;
  - `SES is configured only with all its keys`;
  - `the default provider must be configured`;
  - `secrets never appear in config errors`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: configure ZeptoMail and SES for the API and worker`, then open PR 2.

# Part 3 — Provider administration (PR 3)

### Task 10: Provider settings, tests and overrides (shared with payments)

**Files:**

- Modify: `schema.ts` (tables below; `OPS_PERMISSIONS` gains `providers.manage` and `recoveries.manage`)
- Create: `packages/database/src/operations/provider-admin.ts`, a migration
- Test: `packages/database/test/integration/provider-admin.test.mjs`

**Schema:**

- `provider_settings`: `kind text pk` (`mail | payment`), `active_provider`, `state text default 'stable'`, `changed_by uuid null`, `changed_at`, `reason`, `detail jsonb default '{}'`.
- `provider_tests`: `id`, `kind`, `provider`, `started_by`, `started_at`, `target_hint`, `token_sha256 unique`, `status` (`pending | confirmed | failed | expired`), `confirmed_at`, `failure_code`, `message_id null`, `tip_id null`.
- `provider_overrides`: `kind`, `user_id`, `provider`, `set_by`, `reason`, `created_at`; primary key `(kind, user_id)`.

**Interfaces — Produces:**

```ts
export function activeMailProvider(
  db: Database,
  fallback: MailProviderName,
): Promise<MailProviderName>;
export function mailOverrideFor(
  db: Database,
  userId: string,
): Promise<MailProviderName | null>;
export function startMailProviderTest(
  db,
  sealing,
  input: {
    staffUserId: string;
    provider: MailProviderName;
    to: string;
    webOrigin: string;
    now?: Date;
  },
): Promise<{ testId: string }>; // enqueues provider_test pinned; link /ops/providers/confirm#t=<token>
export function confirmProviderTest(
  db,
  input: { token: string; staffUserId: string; now?: Date },
): Promise<'confirmed' | 'invalid'>;
export function switchMailProvider(
  db,
  input: {
    staffUserId: string;
    provider: MailProviderName;
    reason: string;
    production: boolean;
    sandbox: boolean | null;
    configured: ReadonlySet<MailProviderName>;
    now?: Date;
  },
): Promise<
  'switched' | 'no_confirmed_test' | 'not_configured' | 'refused_in_production'
>;
export function setProviderOverride(
  db,
  input: {
    kind: 'mail' | 'payment';
    userId: string;
    provider: string;
    staffUserId: string;
    reason: string;
  },
): Promise<void>;
export function removeProviderOverride(
  db,
  input: {
    kind: 'mail' | 'payment';
    userId: string;
    staffUserId: string;
    reason: string;
  },
): Promise<boolean>;
export function removeSuppression(
  db,
  sealing,
  input: {
    address: string;
    staffUserId: string;
    reason: string;
    confirmComplaint: boolean;
  },
): Promise<'removed' | 'not_found' | 'complaint_needs_confirmation'>;
```

**Rules:**

- A switch needs a `confirmed` test for that provider within 24 hours.
- `mock` is refused when `production`; SES with `sandbox === true` is refused when `production`.
- Audit actions: `mail_provider.test_started`, `.test_confirmed`, `.switched`, `.override_set`, `.override_removed` and `mail.suppression_removed`.
- `worker.activeProvider` now reads `activeMailProvider`, cached 5 seconds; `overrideFor` reads `mailOverrideFor`. An override to an unconfigured provider falls back (via `resolveMailProvider`) and logs `mail.override_unavailable`.

- [ ] **Step 1:** Tests:
  - `a provider can be made active only with a test confirmed in the last 24 hours`;
  - `a confirmed test older than 24 hours does not count`;
  - `mock cannot be made active in production`;
  - `SES in sandbox cannot be made active in production`;
  - `an overridden account's mail goes through its pinned provider`;
  - `an override to an unconfigured provider falls back`;
  - `switches, overrides and suppression removals are audited with the reason`;
  - `a complaint suppression needs explicit confirmation to remove`;
  - `the test email is pinned to its provider and carries the confirmation link`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(database): provider settings, tests and overrides`.

### Task 11: Ops providers API

**Files:** Create `apps/api/src/ops/providers.controller.ts` and contracts in `packages/contracts/src/ops.ts`. Test: `tests/integration/ops-providers-api.test.mjs`

**Routes** (all under `v1/ops/providers`):

| Method and path                                               | Permission         | Purpose                                                                                                 |
| ------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `GET mail`                                                    | `issues.view`      | Configured providers with active flag, `status()`, last test and 24-hour counts from `mail_daily_stats` |
| `POST mail/:provider/test` `{ to?, reason }`                  | `providers.manage` | Start a test; default `to` is the staff member's verified email                                         |
| `POST tests/confirm` `{ token }`                              | `issues.view`      | Confirm a test; needs an ops session                                                                    |
| `POST mail/active` `{ provider, reason }`                     | `providers.manage` | Switch                                                                                                  |
| `PUT overrides/:userId` `{ kind, provider, reason }`          | `providers.manage` | Set an override                                                                                         |
| `DELETE overrides/:userId?kind=` (body `{ reason }`)          | `providers.manage` | Remove an override                                                                                      |
| `GET suppressions?address=`                                   | `private.view`     | Look up a suppression                                                                                   |
| `DELETE suppressions` `{ address, reason, confirmComplaint }` | `providers.manage` | Remove a suppression                                                                                    |

- [ ] **Step 1:** Tests:
  - `each route refuses staff without its permission`;
  - `switching without a confirmed test is 409 NO_CONFIRMED_TEST`;
  - `the provider list never contains a key or token`;
  - `confirming needs an ops session`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `pnpm -s api:openapi`. Expected: PASS, and OpenAPI updated.
- [ ] **Step 5:** Commit `feat(api): ops mail provider tests, switching, overrides and suppressions`.

### Task 12: `/ops/providers` page

**Files:** Create `apps/web/src/app/ops/providers/{page.tsx,providers-view.tsx,confirm/page.tsx}`; modify `apps/web/src/app/ops/ops-shell.tsx` (add the "Providers" link) and `apps/web/src/lib/ops-client.ts`. Test: `tests/e2e/ops-providers.spec.ts`

The page shows a provider card per configured provider:

- active badge and status (e.g. "Sandbox — only verified recipients");
- last test (who, when, result) and 24-hour counts;
- **Send test** (address field defaulting to "your email", plus a reason);
- **Make active** (disabled with a tooltip-free explanation line until a test is confirmed within 24 hours; asks for a reason).

Below the cards: overrides (list, add by handle or user id, remove) and a suppression lookup. The confirm page reads `#t=`, posts it, and shows "Test confirmed — you can now make <provider> active."

- [ ] **Step 1:** E2E, with the mock provider in a local stack:
  - `staff send a test, confirm it from the pretend inbox, and make the provider active`;
  - `make active is unavailable before a confirmed test`;
  - `an override can be set and removed with a reason`.
- [ ] **Step 2:** Run `pnpm -s exec playwright test tests/e2e/ops-providers.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, following existing ops page structure (`ops/market`, `ops/staff`) and the design constitution.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): ops providers page for mail`, then open PR 3.

# Part 4 — Tracking and the email console (PR 4)

### Task 13: Mail analytics queries

**Files:** Create `packages/database/src/operations/mail-analytics.ts`. Test: `packages/database/test/integration/mail-analytics.test.mjs`

**Interfaces — Produces:**

```ts
export type MailKind =
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'failed';
export type MailPeriod =
  | {
      kind:
        | 'today'
        | 'yesterday'
        | 'this_week'
        | 'last_week'
        | 'this_month'
        | 'last_month';
    }
  | { kind: 'range'; from: string; to: string }; // Lagos dates
export function mailPeriodSummary(
  db,
  period: MailPeriod,
  now: Date,
): Promise<{
  range: { from: string; to: string };
  previous: { from: string; to: string };
  totals: Record<
    MailKind,
    { count: number; previous: number; changePct: number | null }
  >;
  rates: { delivery: number | null; open: number | null; click: number | null };
  byType: Array<{ type: string; sent: number; previous: number }>;
  byProvider: Array<{ provider: string; sent: number; previous: number }>;
}>;
export function mailDailySeries(
  db,
  period: MailPeriod,
  now: Date,
): Promise<
  Array<{
    date: string;
    sent: number;
    delivered: number;
    bounced: number;
    opened: number;
    clicked: number;
    failed: number;
    previousSent: number;
  }>
>; // hourly for 'today'
export function listMail(
  db,
  filter: {
    period: MailPeriod;
    type?: string;
    status?: string;
    provider?: string;
    userId?: string;
    cursor?: string;
    limit: number;
  },
  now: Date,
): Promise<{
  rows: Array<{
    id: string;
    createdAt: string;
    type: string;
    category: string;
    toHint: string;
    userId: string | null;
    provider: string | null;
    status: string;
    lastEvent: string | null;
  }>;
  nextCursor: string | null;
}>;
export function mailTimeline(
  db,
  messageId: string,
): Promise<
  Array<{
    kind: string;
    provider: string | null;
    linkKey: string | null;
    occurredAt: string;
  }>
>;
export function openMailSnapshot(
  db,
  sealing,
  input: { messageId: string; staffUserId: string },
): Promise<
  | { status: 'ok'; subject: string; html: string; text: string }
  | { status: 'withheld' }
  | { status: 'not_found' }
>; // audits email.viewed
export function rebuildMailDailyStats(
  db,
  from: string,
  to: string,
): Promise<number>;
```

`changePct` is `null` when the previous count is 0. The open rate counts messages with at least one `opened` event.

- [ ] **Step 1:** Tests:
  - `this month is compared with last month in Lagos time`: a message at 23:30 Lagos on the last day of last month counts in last month;
  - `a zero previous period gives no percentage`;
  - `totals equal a recount from events` (`rebuildMailDailyStats` gives the same numbers);
  - `the list pages through every message in the period`: 120 messages, `limit 50`, gives 3 pages and no duplicates;
  - `a security email's content is withheld`;
  - `opening a snapshot is audited`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(database): mail analytics by period with comparisons`.

### Task 14: Email console API

**Files:** Create `apps/api/src/ops/email-console.controller.ts`; contracts. Test: `tests/integration/ops-email-console-api.test.mjs`

**Routes** under `v1/ops/email`:

| Method and path                                   | Permission                                      |
| ------------------------------------------------- | ----------------------------------------------- |
| `GET summary?period=&from=&to=`                   | `issues.view`                                   |
| `GET series?…`                                    | `issues.view`                                   |
| `GET messages?…&cursor=`                          | `issues.view`                                   |
| `GET messages/:id/timeline`                       | `issues.view`                                   |
| `GET messages/:id/content`                        | `issues.view` (audited)                         |
| `POST messages/:id/reveal-recipient` `{ reason }` | `private.view` (audited)                        |
| `GET export.csv?kind=summary` or `kind=messages`  | `issues.view` (audited; masked recipients only) |

- [ ] **Step 1:** Tests:
  - `content is withheld for security mail`;
  - `the export contains no full address`;
  - `revealing a recipient needs private.view and a reason, and is audited`;
  - `period parameters are validated`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `api:openapi`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): ops email console`.

### Task 15: `/ops/email` console page

**Files:** Create `apps/web/src/app/ops/email/{page.tsx,email-console.tsx,message-drawer.tsx}`; add "Email" to the ops navigation. Test: `tests/e2e/ops-email.spec.ts`

The page has:

- a period selector;
- headline numbers with their change (`85,214 sent · +82% vs last month` format);
- the daily chart, with the previous period shown faintly (follow the `dataviz` guidance and existing ops charts);
- breakdowns;
- the paginated message list with filters;
- a drawer per message showing the timeline, the "View email" iframe (`sandbox=""`, `srcdoc` from the content route) or "Content withheld", and the masked recipient with "Reveal";
- a note under open rates: "Opens are approximate: some mail apps load images automatically."

- [ ] **Step 1:** E2E:
  - `the console shows today's emails and opens a message's timeline`;
  - `a sign-in code's content is withheld`;
  - `this month's total is compared with last month`, with seeded rows.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): ops email console`, then open PR 4.

# Part 5 — Email sign-in (PR 5)

### Task 16: Email codes in the database

**Files:**

- Modify: `schema.ts`, `packages/database/src/operations/sign-in.ts`
- Create: a migration
- Test: `packages/database/test/integration/sign-in-email.test.mjs`, plus existing sign-in tests (phone paths keep passing through `identifier`)

**Schema:**

- `sign_in_codes`: add `identifier text` (backfilled `'phone:' || phone_e164`), make `phone_e164` nullable, index `(identifier, created_at)`, purpose check adds `email_change` and `recovery_email`.
- `sign_in_lockouts`: add `identifier` (backfilled), and move the primary key to `identifier`.
- `users`: partial unique index `users_verified_email` on `lower(email) WHERE email_verified_at IS NOT NULL AND deleted_at IS NULL`.
- `sessions`: add `device_hash text null`.

**Interfaces — Produces:**

```ts
export type CodePurpose =
  'sign_in' | 'change_phone' | 'email_change' | 'recovery_email' | 'recovery';
export function requestEmailSignInCode(
  db,
  sealing,
  input: { email: string; secret: string; now?: Date; codesPerHour?: number },
): Promise<{ status: 'sent' | 'rate_limited' | 'locked' }>; // enqueues sign_in_code (expiresAt = code expiry)
export function verifyEmailSignInCode(
  db,
  sealing,
  input: {
    email: string;
    code: string;
    secret: string;
    deviceHash: string | null;
    webOrigin: string;
    now?: Date;
  },
): Promise<
  | { status: 'ok'; userId: string; created: boolean }
  | { status: 'invalid' | 'expired' | 'locked' }
>; // creates user with verified email; clears unverified claims; queues welcome (created) or new_sign_in_notice (unknown device, not first sign-in)
```

The phone functions keep their names and use `identifier = 'phone:<e164>'`. New types `sign_in_code`, `welcome` and `new_sign_in_notice` are registered in `@tipme/mail` (copy per §6).

- [ ] **Step 1:** Tests:
  - `a code signs in, creating the account with a verified email`;
  - `the answer is the same for unknown, known and malformed addresses`;
  - `three codes an hour, then rate limited`;
  - `five wrong codes lock for fifteen minutes`;
  - `only the latest code works`;
  - `an expired code is refused`;
  - `an unverified claim of the address on another account is cleared and never signed into` (§8.4);
  - `a known device gets no new-sign-in notice`;
  - `the first sign-in gets a welcome, not a notice`;
  - `the code mail expires with the code`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then the full integration suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(database): email sign-in codes`.

### Task 17: Email sign-in API and email change

**Files:**

- Modify: `packages/contracts/src/auth.ts`, `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/email-change.controller.ts`, and `changeEmail` and `requestEmailChangeCode` in `packages/database/src/operations/email.ts`
- Test: `tests/integration/auth-email-api.test.mjs`

**Contracts:**

- `signInCodeRequestSchema = { email: z.string().min(3).max(254) }`.
- `signInVerifySchema = { email, code: /^\d{6}$/, deviceLabel? }`.
- **Device cookie:** `tipme_device` holds a random 32-byte id, HttpOnly, 400 days. Its SHA-256 becomes `deviceHash`.
- **Email change:** `POST v1/me/email/code { email }` sends `email_change_code` to the new address. `POST v1/me/email { email, code }` changes it, sends `email_changed_notice` to the old address, and ends every other session.
- **Retired:** `/v1/me/email/verify` and the recovery routes return 410 `GONE`.

- [ ] **Step 1:** Tests:
  - `auth/code answers 202 for any input`;
  - `auth/verify sets the session and the device cookie`;
  - `an email change notifies the old address and ends other sessions`;
  - `an email already verified on another account cannot be taken` (409 `EMAIL_TAKEN`, answered only after the code is proven);
  - `the retired verification route is gone`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `api:openapi`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): email sign-in and email change`.

### Task 18: Sign-in screens, settings and e2e helpers

**Files:**

- Create: `apps/web/src/components/account/email-code-form.tsx`
- Modify: `apps/web/src/app/{sign-in,sign-up}/*`, `apps/web/src/app/dashboard/settings/settings-view.tsx` (the email section: change email), `apps/web/src/app/verify-email/*` (now explains that links are no longer used, with a "Sign in" button), `tests/e2e/helpers.ts` (`signInWithEmail`, `readEmailCode`), and every e2e spec that calls `signInWithPhone`
- Test: `tests/e2e/accounts.spec.ts` (updated) and `tests/e2e/email-sign-in.spec.ts`

The form has an "Email address" field, then a "6-digit code" field, and "Use phone instead — coming soon" (disabled, `aria-disabled`, with its explanation as visible text). The e2e helper reads the newest `sign_in_code` from the pretend inbox by masked hint.

- [ ] **Step 1:** E2E:
  - `a new person signs up by email and claims a handle`;
  - `a returning person signs in by email`;
  - `a wrong code shows the error and keeps the address`;
  - `email can be changed in settings`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full e2e suite locally. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): sign in with an email code`.

### Task 19: `ops:set-email` script for existing phone-only accounts

**Files:** Create `packages/database/src/scripts/set-email.ts`; add `"ops:set-email"` in the root `package.json` (same shape as `ops:grant-owner`). Test: `packages/database/test/integration/set-email-script.test.mjs`

It runs as `pnpm ops:set-email -- --handle <h> --email <e> --reason "<r>"`. It sets a verified email, refuses one already verified elsewhere, and writes the audit entry `account.email_set_by_script`.

- [ ] **Step 1:** Tests:
  - `sets a verified email on a phone-only account`;
  - `refuses an email verified on another account`;
  - `is audited`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ops): set an email on an existing account`, then open PR 5.

# Part 6 — Recovery email and recovery (PR 6)

### Task 20: Recovery in the database

**Files:**

- Modify: `schema.ts` (`users.recovery_email`, `users.recovery_email_verified_at`, partial unique index on `lower(recovery_email)` for verified recovery addresses of live accounts; new table `email_recoveries`: `id`, `user_id`, `new_email`, `started_by` (`self | staff`), `staff_user_id null`, `checks text null`, `effective_at`, `cancelled_at`, `completed_at`, `created_at`)
- Modify: `packages/database/src/operations/email.ts`; new types in `@tipme/mail`: `recovery_email_code`, `recovery_code`, `recovery_started_notice` and `recovery_completed_notice`
- Test: `packages/database/test/integration/recovery-email.test.mjs`

**Interfaces — Produces:**

```ts
export function requestRecoveryEmailCode(
  db,
  sealing,
  input: { userId: string; recoveryEmail: string; secret: string },
): Promise<'sent' | 'same_as_sign_in' | 'taken'>;
export function confirmRecoveryEmail(
  db,
  input: {
    userId: string;
    recoveryEmail: string;
    code: string;
    secret: string;
    signInCode?: string;
  },
): Promise<'confirmed' | 'invalid' | 'needs_sign_in_code'>; // changing/removing an existing one needs signInCode
export function startEmailRecovery(
  db,
  sealing,
  input: { signInEmail: string; secret: string },
): Promise<'sent'>; // identical answer always
export function proposeRecoveredEmail(
  db,
  sealing,
  input: {
    signInEmail: string;
    recoveryCode: string;
    newEmail: string;
    secret: string;
  },
): Promise<'code_sent' | 'invalid'>;
export function confirmRecoveredEmail(
  db,
  sealing,
  input: {
    signInEmail: string;
    newEmail: string;
    code: string;
    secret: string;
    now?: Date;
  },
): Promise<{ status: 'pending'; effectiveAt: Date } | { status: 'invalid' }>; // 24h hold, notices
export function startStaffRecovery(
  db,
  sealing,
  input: {
    staffUserId: string;
    userId: string;
    newEmail: string;
    checks: string;
    reason: string;
  },
): Promise<'code_sent' | 'staff_account'>;
export function completeDueRecoveries(db, sealing, now: Date): Promise<number>; // scheduled; ends sessions, notices both
export function cancelEmailRecoveries(db, userId: string): Promise<number>;
export function needsRecoveryEmail(db, userId: string): Promise<boolean>;
```

- [ ] **Step 1:** Tests:
  - `a recovery email must differ from the sign-in email`;
  - `a recovery email that is another account's sign-in email is refused` (Review Focus 5);
  - `changing a confirmed recovery email needs a sign-in code`;
  - `recovery answers identically for unknown addresses`;
  - `a recovery waits 24 hours and can be cancelled from any session`;
  - `completion moves the sign-in email, notifies both and ends sessions`;
  - `staff recovery needs a staff member, records the checks, and refuses staff accounts`;
  - `needsRecoveryEmail clears once one is confirmed`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, and schedule `completeDueRecoveries` every minute in the worker (`ensureSchedule`, job `mail.recoveries`).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(database): recovery email and email recovery`.

### Task 21: Recovery API and staff recovery

**Files:** Create `apps/api/src/auth/recovery.controller.ts`; add the staff route in `apps/api/src/ops/actions.controller.ts` (`POST v1/ops/accounts/:userId/email-recovery`, `recoveries.manage`). Contracts. Test: `tests/integration/recovery-api.test.mjs`

**Routes:**

- `POST v1/me/recovery-email/code`
- `POST v1/me/recovery-email`
- `DELETE v1/me/recovery-email` (needs a sign-in code)
- `POST v1/auth/recovery/start`
- `POST v1/auth/recovery/propose`
- `POST v1/auth/recovery/confirm`
- `POST v1/me/recoveries/cancel` (extends the existing cancel to email recoveries)

Rate limits: `auth_code`-class per IP for the unauthenticated routes.

- [ ] **Step 1:** Tests:
  - `every unauthenticated recovery route answers identically for unknown addresses`;
  - `staff recovery needs recoveries.manage and is audited with the checks`;
  - `recovery routes are rate limited`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `api:openapi`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): recovery email, self-service and staff recovery`.

### Task 22: Recovery screens and the "add a recovery email" nudge

**Files:**

- Modify: `apps/web/src/app/dashboard/settings/settings-view.tsx` (a "Recovery email" section), `apps/web/src/app/recover/*` (rewritten for email recovery), and the sign-in view (a "Can't get into your email?" link)
- Modify: the attention-notice source used by PR #29 (the dashboard checklist, badge and notifications tab) to add the `recovery_email_missing` item via `needsRecoveryEmail`
- Modify: the existing ops account and search screen, to add a "Move sign-in email" action dialog (checks, reason, new address)
- Test: `tests/e2e/recovery.spec.ts`

The notice copy: "Add a recovery email so you can get back in if you lose access to your email."

- [ ] **Step 1:** E2E:
  - `a recipient adds a recovery email and the reminder disappears`;
  - `a recipient without access to their email recovers through the recovery email and the change waits 24 hours`;
  - `a pending recovery can be cancelled from settings`;
  - `staff move a sign-in email with recorded checks`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): recovery email, email recovery and the reminder`, then open PR 6.

# Part 7 — Catalogue, preferences and unsubscribe (PR 7)

### Task 23: The rest of the catalogue and its triggers

**Files:** `packages/mail/src/templates/types/*.ts` (one file per type), and the triggering operations (each enqueue inside the operation's existing transaction). Test: `packages/database/test/integration/mail-triggers.test.mjs`

| Type                                                     | Trigger (operation)                                                                                   | Dedupe key                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `email_change_code`, `email_changed_notice`              | Task 17                                                                                               | (already done)                             |
| `staff_access_notice`                                    | `grantOwner`, `confirmEnrolmentAndOpenGrant`, `dropOpsAccess`                                         | `staff_access_notice.<userId>.<auditId>`   |
| `account_deleted_notice`                                 | `deleteAccount`                                                                                       | `account_deleted_notice.<userId>`          |
| `payment_account_ready`, `payment_account_action_needed` | `updatePaymentAccountStatus` when the status changes to `ACTIVE`, or to `RESTRICTED`/requirements due | `<type>.<accountId>.<status>.<yyyy-mm-dd>` |
| `page_paused`, `page_restored`                           | the ops pause and restore actions                                                                     | `<type>.<profileId>.<auditId>`             |
| `withdrawal_paid`, `withdrawal_failed`                   | `recordPayoutOutcome`                                                                                 | `<type>.<payoutId>`                        |
| `tip_reversed`                                           | the `payment.reversed` issue path                                                                     | `tip_reversed.<tipId>.<providerEventId>`   |
| `milestone`                                              | `evaluateTipMoments` and `evaluatePeriodMoments` when a moment is created                             | `milestone.<momentId>`                     |

- [ ] **Step 1:** One test per row: `<type> is queued once when <trigger>`, and `<type> is not queued when the operation rolls back`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: the full email catalogue and its triggers`.

### Task 24: Preferences, settings "Emails" section and one-click unsubscribe

**Files:**

- Create: `apps/api/src/mail/unsubscribe.controller.ts` (`GET` and `POST /v1/mail/unsubscribe?t=`), `apps/web/src/app/email/unsubscribed/page.tsx`
- Modify: the worker loop (sets `unsubscribeUrl` and the `List-Unsubscribe` and `List-Unsubscribe-Post` headers for toggleable mail), the settings view ("Emails" section), and `mailGate` (engagement category check)
- Create: `packages/database/src/operations/mail-preferences.ts`
- Test: `packages/database/test/integration/mail-preferences.test.mjs`, `tests/integration/unsubscribe-api.test.mjs`

**Interfaces — Produces:**

- `unsubscribeToken(sealing, { userId, type })` is an HMAC; `readUnsubscribeToken(...)`.
- `applyUnsubscribe(db, { userId, type })` turns off the type's preference, or the engagement category for a type without its own preference.

- [ ] **Step 1:** Tests:
  - `security and account mail carry no unsubscribe header`;
  - `one-click POST turns off that email type`;
  - `turning off engagement stops onboarding emails but not tip emails`;
  - `a forged token is refused`;
  - `the settings Emails section lists security and account mail as always sent` (e2e in `tests/e2e/notifications.spec.ts`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: email preferences and one-click unsubscribe`.

### Task 25: Onboarding series, payment-setup reminder and policy notices

**Files:**

- Create: `packages/database/src/operations/mail-campaigns.ts` and a worker schedule (`mail.daily`, 09:00 Lagos)
- Create: `apps/api/src/ops/policy-notice.controller.ts` (`POST v1/ops/policy-notices { kind: 'privacy'|'terms', version, summary, url, reason }`, permission `providers.manage`)
- Test: `packages/database/test/integration/mail-campaigns.test.mjs`

**Interfaces — Produces:**

- `runDailyMail(db, sealing, now)` queues:
  - `onboarding_day_1`, `_3` and `_7` (keyed `onboarding_day_N.<userId>`) by account age, skipped once the step is done (no page, no payment account, no tip yet);
  - `payment_setup_needed` once, 24 hours after a page exists without a ready payment account.
- `broadcastPolicyNotice(db, sealing, input)` queues `privacy_notice` or `terms_update` to every active user with a verified email (keyed `<type>.<version>.<userId>`), in batches of 1,000 per transaction.

- [ ] **Step 1:** Tests:
  - `each onboarding step is sent once and skipped when done`;
  - `payment setup reminder goes once, after 24 hours`;
  - `a policy notice reaches every active user exactly once per version`;
  - `a broadcast does not delay a sign-in code` (with the Task 5 priority).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: onboarding emails, setup reminder and policy notices`, then open PR 7.

# Part 8 — Documentation and staging enablement (PR 8)

### Task 26: ADR, runbook, privacy, register, TODO

**Files:**

- Create: `docs/adr/ADR-0017-mail-platform-and-email-identity.md`, `docs/runbooks/mail.md`
- Modify: `docs/00-DECISIONS.md` (D-11 note: ZeptoMail for launch, SES next, phone OTP TODO; open items unchanged), `docs/adr/ADR-0003-auth-and-sessions.md` (addendum: email identity), the privacy and processor document in `docs/` (Zoho, AWS, tracking, retention), `docs/third-party-component-register.md` (`@aws-sdk/client-sesv2`), `docs/superpowers/plans/2026-10-28-audit-fixes.md` (phase table row: "Phone codes (SMS/WhatsApp) — TODO, product owner 30 Oct 2026"), and `docs/agent/ACTIVE_TASK.md`

`mail.md` covers:

- **DNS:** the DMARC merge, ZeptoMail DKIM and bounce CNAME for each agent domain, and that SES uses the verified `usetipme.xyz` identity, its MAIL FROM `mail.usetipme.xyz`, and the configuration sets and SNS topics created on 30 October (names from memory `aws-ses-setup`).
- **SES:** the HTTPS subscription of `tipme-<env>-mail-events` to `https://<api>/v1/webhooks/mail/ses`, and the send-only IAM policy (`ses:SendEmail`, `ses:GetAccount`).
- **ZeptoMail:** the webhook URL and authentication key.
- **Operations:** the test-and-switch procedure, rollback, suppression removal, and the staging smoke checklist (an SES sandbox send to a verified address, a ZeptoMail send, a bounce-simulator send).

- [ ] **Step 1:** Run `pnpm -s docs:generate && pnpm -s format:check`. Expected: clean.
- [ ] **Step 2:** Commit `docs: mail platform ADR, runbook and decision log`, then open PR 8.
