# Live UI Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task is test-first: write the failing test, watch it fail, implement, watch it pass, commit.

**Goal:** A signed-in recipient's open dashboard shows a new paid tip, the new balance, a changed withdrawal, a change of plan and the other changes in spec section 5 within about 2 seconds of the commit, with no reload. Staff see new approvals and issues the same way. When the live channel is down, pages catch up within about 20 seconds and say when their figures were last read.

**Architecture:** Change signals only, never data. A committed change publishes `{ to, type }` on one Redis channel per environment, `${QUEUE_PREFIX}:live:v1`. It is published by the worker's outbox relay (after `relayOutboxOnce` resolves), by worker job handlers (after they return) and by API routes (after their write resolves). Each API process holds one ioredis subscriber feeding an in-process hub, which routes by user, profile, all or staff permission. The hub writes only `{"type": ...}` to `text/event-stream` responses on `GET /v1/me/events` and `GET /v1/ops/events`. The browser opens `EventSource(apiUrl(...), { withCredentials: true })` directly to the API origin (never through Vercel). On a signal, the panels registered for that type call their existing authorised `GET`s again through `usePanel`'s `reload()`. Every (re)connect resyncs: there is no replay. When the stream is unavailable, a 20 s poll of the same reloads takes over.

**Tech stack:** NestJS 11 (`apps/api`), ioredis, BullMQ worker (`apps/worker`), zod in `packages/contracts`, Drizzle migrations in `packages/database`, Next.js App Router client components (`apps/web`), OpenTelemetry metrics via `@tipme/observability`, Caddy 2.10 edge (`deploy/edge/Caddyfile`), `node:test` unit and integration tests, Playwright e2e on the full stack (web 3100, API 4100, worker, pretend payments).

**Spec:** `docs/superpowers/specs/2026-11-03-live-updates-design.md`. Section 14, "The owner's answers", wins wherever the sections before it say otherwise: the pop-up names the supporter and the amount, with a switch to hide them; a soft sound plays for a new paid tip in a background tab; public pages are not live.

**Where this plan departs from the spec's text, because of the code (each is decided here, not left open):**

1. **Two additive columns.** Spec §1 says "no change to the database schema", but §14 stores two switches per account. Migration `0071_live_popup_prefs.sql` adds `profiles.popup_hide_tip_details boolean DEFAULT false NOT NULL` and `profiles.tip_sound boolean DEFAULT true NOT NULL`. This is additive only. Renumber at merge if dev has taken 0071 by then.
2. **Sound.** `docs/design/EXPERIENCE-AND-MOTION.md` §4 says "Sound: None", and §7.2 says "no sound" under reduced motion (for the appreciation moment). Task 11 records the owner's ruling of 3 Nov in `docs/design/DECISION-LOG.md`. It changes the §4 row to: "One soft sound for a new paid tip in a background tab, if the recipient's 'Sound for new tips' switch is on. Nothing else." §7.2 stays as it is.
3. **A hidden tab and the sound.** Spec §6.2 closes a hidden tab's stream after 5 minutes, and that would silence the §14 background sound. This plan keeps a hidden tab's stream open while the sound is armed: the switch is on and the tab has had an interaction. Otherwise the stream closes after 5 minutes, as the spec says. The per-user cap of 8 still bounds this.
4. **There is no `GET /v1/me/withdrawals`.** The withdraw screen reads `/v1/me/dashboard`, `/v1/me/withdrawal-quote` and `/v1/me/activity`, so `withdrawals.changed` refetches those three.
5. **Session expiry.** `resolveSession` returns `{ sessionId, userId }` and no `expiresAt`. Task 4 adds `expiresAt` to its `.returning(...)`, which is additive and adds no extra query. `AuthContext` gains an optional `expiresAt?: Date`.
6. **`ops.freeze_released` names no profile.** Its payload has only `targetId` (the issue). Task 14 adds `profileId` from `current.subject.profileId` to the payload. This is additive.
7. **The hook is called `useLiveEvents`** (the spec's `useLiveRefresh`). `usePanel(path, { live })` calls it, so panels subscribe without new code. `usePanel` also gains `updatedAt`, and the home's "Couldn't refresh" note becomes "Updated 14:02".
8. **The redesign's update notice** (`apps/web/src/components/update-notice.tsx`) is now on dev. It stays a separate poll (spec §5.3).

## Global Constraints

Verbatim from the spec and repo rules:

- **Signals never carry data.** "The channel carries change signals only. Every figure on screen still comes from the existing authorised `GET` endpoints." The browser receives only a type from a fixed list: "no ids, amounts, names, notes, counts or timestamps. The routing key stays on the server."
- **Publish only after commit.** "There are three kinds of publish point, all **after** the commit." A publish is "never awaited inside a database transaction" and "never fails or retries the work that raised it".
- **Additive migrations only.** "Never modify … migrations already deployed" (AGENTS.md); "contract changes are optional fields only, and the existing endpoints are untouched" (spec §12).
- **No provider name.** Users never see the payment provider's name ("our payment partner"). `apps/web/test/no-provider-names.test.mjs` must stay green, so new copy must not trip it.
- **Reduced motion.** "People who ask for reduced motion get the same final screen at once." Rows appear in place, the balance highlight is a static background for 1 s, and "A test asserts that the new row has no running animations." Forced colours turn the highlight into a 2px `Highlight` outline.
- **Never announce or celebrate before confirmation.** "A signal is not a confirmation. Only a tip the API returns as `paid` gets the arrival treatment." "Withdrawals never celebrate." **Money never performs:** "A balance changes in one frame from the old value to the new one. It never counts, rolls or fills."
- No regulatory approval is implied (`docs/00-DECISIONS.md`: D-03, D-08 and D-11 stay open). Notifications for phones and browsers (D-11) are not built.
- Logs carry no user or profile ids. `to` never leaves the server.
- Report command evidence for each task: what ran, and whether it passed, failed or was skipped.

## Review Focus

Each of these failure modes has a named test in the task that owns it.

1. **Redis down.** Publishes fail fast (no offline queue) and never block or fail the money path. The subscriber's drop sends `poll`, and its return sends `resync`. Tests:
   - Task 3: `a publish while Redis is down resolves, logs live.publish_failed and counts outcome=failed`, and `subscriber down sends poll to every stream; restored sends resync`.
   - Task 5: `a publish that rejects is swallowed and the relay still marks its rows relayed`.
2. **A session revoked mid-stream.** `sessions.changed` re-checks each stream's own cookie and closes it with `session.ended`. No stream outlives `expiresAt`. Tests:
   - Task 4: `revoking the session closes the stream with session.ended`, and `a stream closes at its session's expiresAt when that is sooner than 30 minutes`.
3. **A reconnect storm (deploy or Redis blip).** The draining copy sends each stream a jittered `retry:` between 1,000 and 10,000 ms, the client uses full-jitter backoff, and a `resync` waits 0–5 s at random. Tests:
   - Task 2: `drain writes a retry between 1000 and 10000 to every stream and closes it`.
   - Task 7: `backoff is full jitter within 1,2,4…60 s`, and `resync waits a random 0–5 s before refetching`.
4. **A dropped signal.** A lost publish is caught by the 5-minute safety refresh, the refresh when the tab becomes visible, or the 20 s poll. Nothing signals for an uncommitted row. Tests:
   - Task 7: `safety refresh runs every registered refetch every 5 minutes while connected and visible`.
   - Task 5: `relay publishes nothing when queue.add fails (the claim rolls back)`.
5. **A stale balance.** A signal that arrives during a refetch runs one more after it, an older answer never replaces a newer one, a failed refresh keeps the last figures with "Updated HH:MM", and the balance changes in one frame. Tests:
   - Task 8: `a signal during an in-flight refetch runs exactly one more after it`, and `a failed reload keeps data and updatedAt`.
   - Task 12 e2e: the MutationObserver sees only the old and the new balance.

## PR split

- **PR 1 (Tasks 1–12):** the stream, dashboard tips and balance, the bell folded in, the two Settings switches, the sound, the Caddyfile change, the headline e2e test, the threat-model row and the runbook.
- **PR 2 (Tasks 13–15):** plan and profile, suspension, withdrawals (including the switch and freeze), payments, reports and account, with the dirty-form rule.
- **PR 3 (Task 16):** admin: `/v1/ops/events`, approvals and issues.

Branch `feat/live-updates` (worktree `.worktrees/live-updates`). Open each PR to `dev` only after the owner says so. Do not push without being asked.

### Commands used throughout

- `pnpm infra:up` starts local Postgres and Redis. Integration and e2e tests need it.
- Contracts:
  - Build: `pnpm --filter @tipme/contracts build`
  - Test: `pnpm --filter @tipme/contracts test`
- API unit, one file: `pnpm --filter @tipme/contracts --filter @tipme/database --filter @tipme/api build && pnpm --filter @tipme/api exec node --import @tipme/observability/register --test test/<file>.test.mjs`
- Worker unit, one file: `pnpm --filter @tipme/worker... build && pnpm --filter @tipme/worker exec node --test test/<file>.test.mjs`
- Web unit (TypeScript is imported directly): `pnpm --filter @tipme/web exec node --test test/<file>.test.mjs`
- Integration, one file:
  - Build: `pnpm exec turbo run build --filter=!@tipme/web`
  - Run: `node --import ./packages/observability/dist/register.js --test tests/integration/<file>.test.mjs`
- Integration, the whole suite: `pnpm test:integration`
- E2E, one spec: `pnpm test:e2e -- tests/e2e/<spec>.ts`
- Before each PR: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e`

---

## PR 1: the stream, tips and balance

### Task 1: The live message contract

**Files:**

- Create:
  - `packages/contracts/src/live.ts`
  - `packages/contracts/test/live.test.mjs`
- Modify: `packages/contracts/src/index.ts` (export)

**Interfaces:**

```ts
export const LIVE_RECIPIENT_TYPES = ['tips.changed', 'notifications.changed', 'moments.changed',
  'withdrawals.changed', 'payments.changed', 'profile.changed', 'reports.changed',
  'account.changed'] as const;
export const LIVE_STAFF_TYPES = ['ops.approvals.changed', 'ops.issues.changed'] as const;
/** Handled by the hub, never forwarded. */
export const LIVE_SERVER_TYPES = ['sessions.changed', 'staff.changed'] as const;
export const LIVE_CONTROL_TYPES = ['ready', 'resync', 'poll', 'session.ended'] as const;
export type LiveRecipientType = (typeof LIVE_RECIPIENT_TYPES)[number];
export type LiveStaffType = (typeof LIVE_STAFF_TYPES)[number];
export type LiveEventType = LiveRecipientType | LiveStaffType;
export type LiveControlType = (typeof LIVE_CONTROL_TYPES)[number];
export type LiveTarget =
  | { user: string } | { profile: string } | { all: true }
  | { staff: 'any' | 'issues.view' };
export const liveMessageSchema: z.ZodType<LiveMessage>; // .strict(), uuid ids, type enum of all three lists
export interface LiveMessage { to: LiveTarget; type: LiveEventType | (typeof LIVE_SERVER_TYPES)[number] }
/** The only shape a browser ever receives. */
export interface LiveBrowserMessage { type: LiveEventType | LiveControlType }
export const liveChannel = (queuePrefix: string): string => `${queuePrefix}:live:v1`;
export function parseLiveMessage(raw: string): LiveMessage | null; // never throws
```

- [ ] **Step 1: Write the failing tests** in `packages/contracts/test/live.test.mjs`:
  - `liveChannel uses the queue prefix`: `liveChannel('tipme') === 'tipme:live:v1'`.
  - `parseLiveMessage accepts each documented target`: the four JSON lines in spec §2.6 parse to equal objects.
  - `parseLiveMessage rejects junk without throwing`: `'nope'`, `'{}'`, an unknown type, an extra key (`{to:{user},type,amount:1}`), a non-uuid id and `{to:{staff:'payouts.resolve'}}` all return `null`.
  - `control types are disjoint from event types`: no member of `LIVE_CONTROL_TYPES` is in `LIVE_RECIPIENT_TYPES ∪ LIVE_STAFF_TYPES ∪ LIVE_SERVER_TYPES`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`. Expected: FAIL, because `live.js` is missing.
- [ ] **Step 3: Implement** with zod `z.discriminatedUnion`-free unions (`z.union` of four strict objects) and `z.string().uuid()`. `parseLiveMessage` wraps `JSON.parse` and `safeParse`. No runtime imports beyond zod (contracts AGENTS.md).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): the live signal message, its types and channel`.

---

### Task 2: The hub's routing core (pure)

**Files:**

- Create:
  - `apps/api/src/live/live-router.ts`
  - `apps/api/test/live-hub.test.mjs`

**Interfaces:**

```ts
export type LiveCloseReason = 'client' | 'lifetime' | 'session_ended' | 'draining' | 'error';
export interface LiveSink {
  id: string; kind: 'me' | 'ops'; userId: string; profileId: string | null;
  permissions: ReadonlySet<string> | null;      // ops streams only
  write(frame: string): void;                    // already-framed SSE text
  close(reason: LiveCloseReason): void;
  recheck(): Promise<boolean>;                   // false: session or grant gone
}
export type RegisterResult = { ok: true } | { ok: false; reason: 'limit_user' | 'limit_process' | 'draining' };
export interface LiveRouterOptions {
  maxPerUser: number; maxStreams: number; coalesceMs: number;
  random: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void;
  onDelivered?: (type: string) => void;
}
export function createLiveRouter(o: LiveRouterOptions): {
  register(sink: LiveSink): RegisterResult;
  unregister(id: string): void;
  dispatch(message: LiveMessage): void;
  broadcastControl(type: 'resync' | 'poll'): void;
  drain(): void;                                  // jittered retry then close every stream
  readonly draining: boolean;
  counts(): { me: number; ops: number };
};
export const sseFrame = (m: LiveBrowserMessage): string => `data: ${JSON.stringify({ type: m.type })}\n\n`;
export const sseRetry = (ms: number): string => `retry: ${ms}\n\n`;
```

- [ ] **Step 1: Write the failing tests** (fake sinks recording `write` and `close`, and fake timers):
  - `a profile signal reaches only that profile's streams`: two users, `{to:{profile:A},type:'tips.changed'}`. A's sink gets `data: {"type":"tips.changed"}\n\n` and B's gets nothing.
  - `a user signal reaches every stream of that user and no other`.
  - `all reaches every me stream and no ops stream`.
  - `staff issues.view reaches only ops streams holding issues.view; staff any reaches every ops stream`.
  - `the browser receives only {type}`: the frame written for every dispatch parses to an object whose only key is `type`.
  - `sessions.changed is never forwarded`: it calls `recheck()` on that user's sinks. A `false` writes `{"type":"session.ended"}` and closes with `session_ended`. A `true` writes nothing.
  - `staff.changed rechecks every ops stream and closes those whose grant is gone`.
  - `the 9th stream for one user is refused limit_user`, and `stream 2001 is refused limit_process` (with `maxStreams: 2000`).
  - `repeats of one type to one stream within 250 ms coalesce into one frame`: three dispatches give one write. A fourth after 250 ms gives a second write.
  - `drain writes a retry between 1000 and 10000 to every stream and closes it`: the `retry:` value is in range and differs across sinks (with a seeded `random`). Every close reason is `draining`. A `register` after it returns `draining`.
  - `poll and resync control frames go to every stream`.
- [ ] **Step 2: Run** the API unit command with `live-hub`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** with `Map<userId, Set<LiveSink>>`, `Map<profileId, Set<LiveSink>>` and `Set<LiveSink>` for ops. Coalescing keeps a per-sink `Set<type>` with one timer per sink: the first signal writes at once, and later ones in the window flush once at its end. `recheck` errors count as `false`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): the live hub's routing core: by user, profile, all and staff, coalesced and capped`.

---

### Task 3: Flag, subscriber, publisher and metrics

**Files:**

- Create:
  - `apps/api/src/live/live-subscriber.ts`
  - `apps/api/src/live/live-publisher.ts`
  - `apps/api/src/live/live-hub.service.ts`
  - `apps/api/src/live/live-metrics.ts`
  - `apps/api/test/live-publisher.test.mjs`
- Modify:
  - `apps/api/src/config.ts`: `LIVE_UPDATES_ENABLED: flag` (default false) and `LIVE_MAX_STREAMS: z.coerce.number().int().min(1).default(2000)`
  - `apps/api/test/config.test.mjs`
  - `deploy/production.env.example`, `deploy/staging.env.example`
  - `deploy/compose.production.yml`, `deploy/compose.staging.yml`: pass `LIVE_UPDATES_ENABLED`
  - `playwright.config.ts`: API env `LIVE_UPDATES_ENABLED: 'true'`

**Interfaces:**

```ts
// live-publisher.ts (API)
export const LIVE_PUBLISHER = Symbol('LIVE_PUBLISHER');
export type PublishLive = (message: LiveMessage) => Promise<void>; // resolves always
export function createLivePublisher(deps: { redis: Pick<Redis, 'publish'>; channel: string;
  logger: Logger; counter: (type: string, outcome: 'ok' | 'failed') => void }): PublishLive;
// live-subscriber.ts
export function startLiveSubscriber(o: { url: string; channel: string; logger: Logger;
  onMessage(m: LiveMessage): void; onDown(): void; onUp(): void; onInvalid(): void;
}): { readonly up: boolean; stop(): Promise<void> };
// live-hub.service.ts: Nest wrapper over createLiveRouter + subscriber; OnModuleInit / OnApplicationShutdown
@Injectable() export class LiveHubService { register; unregister; drain; get subscriberUp(): boolean }
```

The metrics are `tipme.live.streams` (gauge, `stream`), `tipme.live.connects` (`outcome`), `tipme.live.closes` (`reason`), `tipme.live.signals_published` (`type`, `outcome`), `tipme.live.signals_delivered` (`type`) and `tipme.live.subscriber` (gauge). They are registered with `getMeter(SERVICE_NAME)` as in `apps/worker/src/job-worker.ts`. This is the API's first meter.

- [ ] **Step 1: Write the failing tests** (`live-publisher.test.mjs`, plus a `config.test.mjs` case):
  - `a publish sends {to,type} JSON on the channel`: a fake redis records `('p:live:v1', '{"to":{"profile":"…"},"type":"tips.changed"}')`.
  - `a publish while Redis is down resolves, logs live.publish_failed and counts outcome=failed`: `publish` rejects, the promise resolves, and the log line has `error` (an error name) and no ids.
  - `subscriber down sends poll to every stream; restored sends resync`: a fake ioredis emits `end`, then `ready`. The router's `broadcastControl` is called with `poll`, then `resync`. It logs `live.subscriber_down` once and `live.subscriber_restored` once.
  - `an invalid channel message is dropped, logged live.message_invalid and counted`.
  - `the subscriber subscribes on every ready, not before` (no offline queue).
  - Config: `LIVE_UPDATES_ENABLED defaults to false; 'true' turns it on; LIVE_MAX_STREAMS defaults to 2000`.
- [ ] **Step 2: Run** the API unit command with `live-publisher` and `config`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The subscriber is its own `new Redis(url, { lazyConnect: true, enableOfflineQueue: false, retryStrategy })`. It calls `subscribe(channel)` on `ready` and `on('message')` → `parseLiveMessage`.
  - The publisher uses the existing `REDIS` client from `createRedis`, which has no offline queue. It is provided in `InfraModule` or `LiveModule` as `LIVE_PUBLISHER`.
  - `LiveHubService` exposes `subscriberUp`. A stream that connects while it is down gets `ready` then `poll`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): live updates flag, the Redis subscriber and a publisher that never throws`.

---

### Task 4: The stream routes (write the integration test first)

**Files:**

- Create:
  - `apps/api/src/live/live.controller.ts`
  - `apps/api/src/live/live.module.ts`
  - `tests/integration/live-events.test.mjs`
- Modify:
  - `apps/api/src/app.module.ts`: import `LiveModule`.
  - `apps/api/src/health/readiness.service.ts`: `onDrain(listener: () => void): void`. `startDraining()` calls the listeners once.
  - `apps/api/test/readiness.test.mjs`
  - `apps/api/src/checkout/rate-limit.guard.ts`: routes `'live_connect'` (per IP, 60 a minute) and `consumeForPerson('live_connect_user', userId)` (30 a minute), both failing open.
  - `packages/database/src/operations/sessions.ts`: `resolveSession` also returns `expiresAt: Date` (additive).
  - `apps/api/src/auth/session.guard.ts`: `AuthContext.expiresAt?: Date`.
  - `apps/api/src/auth/auth.controller.ts`: publish `sessions.changed` to the user after `revokeSession`, `revokeAllSessions` (sign out others) and sign-out resolve.
  - `apps/api/src/ops/account-recovery.controller.ts`: publish `sessions.changed` after `endAccountSessions`.
  - `apps/api/src/profiles/me-profile.controller.ts` (`DELETE account`): publish `sessions.changed`.
  - `packages/observability/src/telemetry.ts`: `new HttpInstrumentation({ ignoreIncomingRequestHook: (r) => LIVE_PATHS.has(r.url?.split('?')[0] ?? '') })`.
  - `packages/observability/test/telemetry-spans.test.mjs`
  - `apps/api/src/openapi/document.ts` or `image.ts`: a `text/event-stream` response doc, like `OPENAPI_IMAGE`.
  - `docs/api/openapi.json`, `docs/security/access-control.md`: regenerated, not hand-written.
  - `tests/integration/connection-budget.test.mjs`, `tests/integration/auth-api.test.mjs`

**Interfaces:**

```ts
@Controller('v1/me')
export class LiveController {
  @Get('events')
  @SetMetadata(RATE_LIMIT_ROUTE, 'live_connect')
  @UseGuards(RateLimitGuard, SessionGuard)   // IP limit first, so unauthenticated connects count
  me(@Req() req: Request, @Res() res: Response, @CurrentUser() auth: AuthContext): Promise<void>;
}
/** Shared by /v1/me/events and (Task 16) /v1/ops/events. */
export function openStream(o: { req: Request; res: Response; hub: LiveHubService;
  sink: Omit<LiveSink, 'write' | 'close' | 'id'>; expiresAt: Date | null;
  lifetimeMs?: number /* 30 min ± 3 min */; heartbeatMs?: number /* 20 s */ }): void;
```

The response:

- headers: `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`, flushed at once;
- socket: `setTimeout(0)`, `setNoDelay(true)` and `setKeepAlive(true)`;
- body: `retry: 5000`, then, once registered, `data: {"type":"ready"}`, then a `: hb` comment every 20 s;
- end: close at `min(now + lifetime, expiresAt)`.

The refusals:

- flag off: `204`;
- the per-user cap: 429 `LIVE_LIMIT`;
- the per-process cap, or a draining copy: 503 with `Retry-After: 30`.

The connect makes `resolveSession` and `myProfileId` and holds no pool connection.

- [ ] **Step 1: Write the failing integration tests** (`startStack({ apiEnv: { LIVE_UPDATES_ENABLED: 'true' } })`, plus a raw `http.get` SSE reader helper in the file):
  - `a stream outlives requestTimeout`: it stays open more than 12 s and receives `ready`, then at least one `: hb`, using `heartbeatMs` overridden through `LIVE_HEARTBEAT_MS`, a test-only config (min 1000, default 20000).
  - `401 without a session`.
  - `CORS: credentials for WEB_ORIGIN only`: `Access-Control-Allow-Origin` equals `WEB_ORIGIN`, `Access-Control-Allow-Credentials: true`, and another origin gets no allow header.
  - `204 when LIVE_UPDATES_ENABLED is false, even with a session`.
  - `the response headers are event-stream, no-store and no-transform, with X-Accel-Buffering: no`.
  - `revoking the session closes the stream with session.ended`: sign out others from a second session. The first stream receives `data: {"type":"session.ended"}` and ends.
  - `a stream closes at its session's expiresAt when that is sooner than 30 minutes`: set the session's `expires_at` to now + 2 s in the test DB, and the stream ends within 4 s.
  - `the ninth stream for one user gets 429 LIVE_LIMIT`.
  - `the 61st connect from one IP in a minute gets 429`.
  - `draining refuses new streams with 503 and closes open ones with a retry line`.
  - `connection-budget.test.mjs`: `a open stream holds no pool connection`. The pool's `idleCount` returns to its value before the connect while the stream stays open.
  - `auth-api.test.mjs`: `sign out others publishes sessions.changed for that user`, checked by a test subscriber on the channel.
  - `readiness.test.mjs`: `startDraining calls onDrain listeners once`.
  - `telemetry-spans.test.mjs`: `requests to /v1/me/events and /v1/ops/events make no HTTP server span`.
- [ ] **Step 2: Run** the integration single-file command for `live-events`, then the API unit command for `readiness`. Expected: FAIL (404 on the route).
- [ ] **Step 3: Implement.**
  - `openStream` builds a `LiveSink` whose `write` is `res.write`. `close` writes nothing extra, unless the hub already wrote `retry:`/`session.ended`, and ends the response. `req.on('close')` unregisters with reason `client`.
  - The sink's `recheck()` keeps the cookie token in its closure (never logged) and calls `resolveSession` again.
  - The `LiveHubService` constructor calls `readiness.onDrain(() => hub.drain())`.
  - After the route works, run `pnpm --filter @tipme/api build && pnpm api:openapi && pnpm docs:generate`.
- [ ] **Step 4: Run** `node --import ./packages/observability/dist/register.js --test tests/integration/live-events.test.mjs tests/integration/connection-budget.test.mjs tests/integration/auth-api.test.mjs`, then `node --test scripts/generate-docs.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): GET /v1/me/events: an authenticated signal stream with heartbeats, limits, drain and session close`.

---

### Task 5: Worker signals: the relay and the tip handler

**Files:**

- Create:
  - `apps/worker/src/live-signals.ts`
  - `apps/worker/src/live-publisher.ts`
  - `apps/worker/test/live-signals.test.mjs`
- Modify:
  - `apps/worker/src/outbox-relay-loop.ts`: an optional `publishLive` option; collect signals in the `publish` callback and publish after `relayOutboxOnce` resolves.
  - `apps/worker/src/job-worker.ts`: build the publisher over the fail-fast `markers` client. Pass it to the relay. After `handleDomainEvent` returns, publish `jobSignalsFor(...)`.
  - `apps/worker/test/domain-events.test.mjs`
  - `apps/api/src/webhooks/webhook.service.ts`: after `apply` and `applyBachs` move a tip to `PENDING_VERIFICATION`, publish `tips.changed` to its profile. The operation returns `profileId` (additive).
  - `tests/integration/outbox-delivery.test.mjs`, `tests/integration/worker-domain-events.test.mjs`

**Interfaces:**

```ts
/** Outbox event → signals. Pure; unknown or malformed payloads give []. */
export function liveSignalFor(eventType: string, payload: unknown): LiveMessage[];
/** After a job handler returned. */
export function jobSignalsFor(jobName: string, outcome: string, data: unknown,
  result?: { profileIds?: string[]; issuesOpened?: number; issuesResolved?: number }): LiveMessage[];
export function createWorkerLivePublisher(deps: { redis: Pick<Redis, 'publish'>; channel: string;
  logger: Logger; counter: Counter }): (messages: LiveMessage[]) => Promise<void>; // never throws
```

PR 1 mapping:

- `liveSignalFor`: `tip.succeeded` and `tip.failed` → `tips.changed` to `profileId`. Every other row returns `[]` until Tasks 14 and 16 extend it.
- `jobSignalsFor`: `tip.succeeded` with outcome `notified` or `duplicate` → `notifications.changed` and `moments.changed` to the profile.

- [ ] **Step 1: Write the failing tests:**
  - `live-signals.test.mjs`:
    - `tip.succeeded and tip.failed map to tips.changed for their profile`;
    - `every outbox event type the database writes has an explicit mapping, even if []`: iterate a list exported from `@tipme/database` (or the `DOMAIN_EVENT_NAMES` plus handler names), so a new event type fails until it is mapped;
    - `a payload without a uuid profileId maps to []`;
    - `jobSignalsFor tip.succeeded notified gives notifications.changed and moments.changed; skipped gives []`;
    - `a publish that rejects is swallowed and counted outcome=failed`.
  - `outbox-delivery.test.mjs`:
    - `the relay publishes tips.changed only after the claim commits`: the subscriber's message arrives after the row's `published_at` is set;
    - `relay publishes nothing when queue.add fails (the claim rolls back)`;
    - `a publish that rejects is swallowed and the relay still marks its rows relayed`.
  - `worker-domain-events.test.mjs`: `after notifyTipSucceeded commits, notifications.changed is published for the profile`.
  - Webhook (in `live-events.test.mjs`): `a pretend tip produces tips.changed and then notifications.changed on the recipient's stream and nothing on a second user's`. Drive it through the mock webhook as in `tests/integration/webhooks.test.mjs`.
- [ ] **Step 2: Run** the worker unit command for `live-signals` and `domain-events`, then the integration command for `outbox-delivery`, `worker-domain-events` and `live-events`. Expected: FAIL.
- [ ] **Step 3: Implement.** `startOutboxRelay` keeps a `const signals: LiveMessage[] = []` inside each `tick`. It pushes `liveSignalFor(row.eventType, row.payload)` in the callback, and only after `await relayOutboxOnce(...)` resolves calls `void publishLive(signals)`. The webhook publish happens after the service's DB call resolves, outside any transaction.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): publish live signals after the relay commits and after the tip handler`.

---

### Task 6: The edge: stream paths out of `encode` (owner's deploy step)

**Files:**

- Modify:
  - `deploy/edge/Caddyfile`
  - `scripts/edge-caddy.test.mjs`
  - `docs/runbooks/production.md`, `docs/runbooks/staging-setup.md`

**The exact Caddyfile change, in both site blocks (`{$STAGING_API_HOST}` and `{$PRODUCTION_API_HOST}`):** replace the line

```
	encode zstd gzip
```

with

```
	# A compressed event stream is held back until a buffer fills; the stream paths stay plain.
	@compressible not path /v1/me/events /v1/ops/events
	encode @compressible zstd gzip
```

Nothing else changes: no `flush_interval` (Caddy flushes `text/event-stream` at once), no response timeouts, and the health checks stay as they are.

- [ ] **Step 1: Write the failing test** in `scripts/edge-caddy.test.mjs`. The stand-in `UPSTREAM` gains `/v1/me/events`, which writes `text/event-stream` headers, then `: hb\n\n` every 500 ms, and never ends.
  - `the stream paths are not compressed and flush at once`: a request with `Accept-Encoding: gzip, zstd` through the edge gets no `Content-Encoding` header, and the first `: hb` arrives within 2 s.
  - `other paths are still compressed`: `/who` padded to more than 1 KB gets `Content-Encoding: zstd` or `gzip`.
- [ ] **Step 2: Run** `node --test scripts/edge-caddy.test.mjs`. Expected: FAIL (`Content-Encoding: gzip` on the stream). It is skipped without Docker; record that as skipped, not passed.
- [ ] **Step 3: Implement** the Caddyfile change above. Add a runbook section, "Live updates: the edge and the flag", for the owner:
  1. copy the new Caddyfile to `/srv/tipme-edge/` and run `docker compose -f deploy/edge/compose.edge.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`;
  2. on staging, set `LIVE_UPDATES_ENABLED=true` and recreate the API;
  3. run `curl -N -H 'Cookie: tipme_session=…' https://$STAGING_API_HOST/v1/me/events`, which must print `retry: 5000`, then `data: {"type":"ready"}`, then `: hb` within 21 s;
  4. watch `tipme.live.*` for a week, then turn on production.
  
  To turn it off: set `LIVE_UPDATES_ENABLED=false` in `production.env` and recreate the API colour. No web deploy is needed.
- [ ] **Step 4: Run** `node --test scripts/edge-caddy.test.mjs`. Expected: PASS (with Docker).
- [ ] **Step 5: Commit** `chore(edge): keep the live stream paths out of encode, and the runbook step to turn live updates on`.

---

### Task 7: The browser's live client (framework-free)

**Files:**

- Create:
  - `apps/web/src/lib/live-client.ts`
  - `apps/web/test/live-client.test.mjs`

**Interfaces:**

```ts
export type LiveStatus = 'idle' | 'connecting' | 'connected' | 'polling' | 'disabled';
export interface LiveClientDeps {
  url: string;
  EventSource: new (url: string, init: { withCredentials: boolean }) => EventSourceLike;
  now(): number;                          // performance.now()
  setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void;
  random(): number;
  visible(): boolean;
  probe(): Promise<'ok' | 'unauthenticated' | 'refused' | 'error'>; // apiFetch('/v1/me/profile') or ops equivalent
  keepOpenWhenHidden(): boolean;          // the armed tip sound (plan note 3)
}
export interface LiveClient {
  start(): void; stop(): void;
  on(type: LiveEventType, fn: () => void): () => void;
  onResync(fn: () => void): () => void;   // ready, resync (after 0–5 s), poll ticks, safety, visible, online
  onStatus(fn: (s: LiveStatus) => void): () => void;
  onSignedOut(fn: () => void): () => void;
  visibilityChanged(): void; online(): void;
  readonly status: LiveStatus;
}
export function createLiveClient(deps: LiveClientDeps): LiveClient;
export const LIVE_TIMING = { watchdogMs: 50_000, readyTimeoutMs: 10_000, bufferedRetryMs: 300_000,
  pollMs: 20_000, pollJitterMs: 2_000, streamRetryWhilePollingMs: 60_000, hiddenCloseMs: 300_000,
  safetyMs: 300_000, backoffCapMs: 60_000, resyncJitterMs: 5_000 } as const;
```

A 204 is detected as an `error` before any `open` with `readyState === CLOSED`, and the probe answers `ok`. That gives `disabled`. EventSource exposes no status, so the probe decides.

- [ ] **Step 1: Write the failing tests** (a fake EventSource with `emitOpen`, `emitMessage(json)`, `emitError(closed)`, and fake timers):
  - `ready triggers one resync`.
  - `a signal calls only its own listeners`, and `an unknown type is ignored`.
  - `backoff is full jitter within 1,2,4…60 s`: with `random()` at 0.999, the delays are just under 1000, 2000, 4000 … 60000, and with 0 they are 0.
  - `after 2 failed connects the client probes; unauthenticated fires onSignedOut and stops`.
  - `3 failures in a row switch to polling every 20 s ± 2 s while visible, and retry the stream every 60 s`.
  - `a poll message switches to polling; resync returns to connected after a random 0–5 s`.
  - `resync waits a random 0–5 s before refetching`.
  - `a 204 (closed before open, probe ok) sets disabled and never reconnects or polls`.
  - `the watchdog reconnects after 50 s with no message, heartbeat or ready`: a `: hb` comment, delivered as the fake's `heartbeat()`, resets it.
  - `open without ready for 10 s is treated as buffered: poll, and try the stream again after 5 minutes`.
  - `hidden pauses polling at once and closes the stream after 5 minutes; visible reconnects and resyncs`.
  - `hidden keeps the stream open while keepOpenWhenHidden() is true`.
  - `online reconnects`.
  - `safety refresh runs every registered refetch every 5 minutes while connected and visible`.
  - `stop closes the EventSource and clears every timer` (the fake timer count returns to 0).
- [ ] **Step 2: Run** `pnpm --filter @tipme/web exec node --test test/live-client.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** as an explicit state machine. The client always closes the EventSource itself on `error` (so the browser's own retry never runs) and schedules its own reconnect.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): a testable live client: resync on ready, jittered backoff, watchdog and fallback poll`.

---

### Task 8: LiveProvider, `useLiveEvents` and `usePanel`'s subscription

**Files:**

- Create:
  - `apps/web/src/components/live/live-provider.tsx`
  - `apps/web/src/lib/live-refetch.ts`
  - `apps/web/test/live-refetch.test.mjs`
- Modify:
  - `apps/web/src/components/dashboard/use-panel.ts`
  - `apps/web/src/app/dashboard/dashboard-shell.tsx`: mount `<LiveProvider stream="me">` inside `RecipientContext.Provider`, once the profile has loaded. `onSignedOut` → the existing sign-in redirect.

**Interfaces:**

```ts
// live-refetch.ts: the debounce and single-flight scheduler, pure
export function createRefetchScheduler(o: { debounceMs: number /* 300 */;
  setTimeout; clearTimeout }): {
  register(types: readonly LiveEventType[], refetch: () => Promise<void>): () => void;
  signal(type: LiveEventType): void;   // debounced per registration
  resyncAll(): void;                   // every registration, debounced
};
// live-provider.tsx
export function LiveProvider(props: { stream: 'me' | 'ops'; children: ReactNode;
  keepOpenWhenHidden?: () => boolean }): JSX.Element;
export function useLiveEvents(types: readonly LiveEventType[], refetch: () => Promise<void>): void; // no-op outside a provider
export function useLiveStatus(): LiveStatus;                                                     // 'idle' outside a provider
// use-panel.ts
export interface Panel<T> { data: T | null; error: PanelError; reload: () => Promise<void>;
  /** Browser clock at the last successful read; null before the first. */ updatedAt: Date | null }
export function usePanel<T>(path: string, options?: { live?: readonly LiveEventType[] }): Panel<T>;
```

`usePanel` calls `useLiveEvents(options?.live ?? NONE, reload)` with a stable `NONE` array. The existing `latest` counter still drops older answers.

- [ ] **Step 1: Write the failing tests** (`live-refetch.test.mjs`):
  - `signals within 300 ms run a registration's refetch once`.
  - `a signal during an in-flight refetch runs exactly one more after it`.
  - `two signals during an in-flight refetch still run only one more`.
  - `resyncAll runs every registration once, including those with no matching type`.
  - `an unregistered refetch never runs`.
  - `a refetch that rejects does not block the next`.
  - `a failed reload keeps data and updatedAt`: test the exported pure helper `nextPanelState(prev, result, now)` from `use-panel.ts`. On failure it keeps `data` and `updatedAt` and sets `error: 'refresh'`. On a first-load failure it gives `'load'`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/web exec node --test test/live-refetch.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** The provider creates one `createLiveClient` per tab, with `url: apiUrl('/v1/me/events')`, `window.EventSource` and `performance.now`. It wires `visibilitychange` and `online`, `client.on(type)` → `scheduler.signal(type)`, and `onResync` → `scheduler.resyncAll()`. `usePanel` refactors its state update into `nextPanelState`.
- [ ] **Step 4: Run** the same command, then `pnpm --filter @tipme/web typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): LiveProvider and useLiveEvents; usePanel subscribes by type and remembers when it last read`.

---

### Task 9: Dashboard tips and balance merge

**Files:**

- Create:
  - `apps/web/src/lib/live-merge.ts`
  - `apps/web/test/live-merge.test.mjs`
- Modify:
  - `apps/web/src/app/dashboard/home-view.tsx`
    - `usePanel('/v1/me/dashboard', { live: ['tips.changed', 'withdrawals.changed'] })`
    - `usePanel('/v1/me/activity', { live: ['tips.changed', 'withdrawals.changed'] })`
    - `usePanel('/v1/me/reports', { live: ['reports.changed'] })`
    - the balance highlight class and the "Updated HH:MM" note
  - `apps/web/src/components/dashboard/activity-list.tsx`: `arriving: ReadonlySet<string>` and `highlighted: ReadonlySet<string>` props
  - `apps/web/src/components/dashboard/moments.tsx`: `live: ['moments.changed']`
  - `apps/web/src/app/dashboard/tips/tips-view.tsx`: first page only, with the "New tips: show" button when deep or searching
  - `apps/web/src/app/dashboard/tips/[tipId]/tip-view.tsx`: `live: ['tips.changed']`
  - `apps/web/src/app/globals.css`: `.balance-card__figure--rose` (1 s soft background), `.activity-list__row--arriving` (`transform` from `translateY(-8px)` in 240ms), the reduced-motion and forced-colours rules

**Interfaces:**

```ts
/** Ids of paid tip rows not in `before`; empty on the first load (before === null). */
export function arrivals(before: ReadonlySet<string> | null, rows: readonly ActivityRow[]): Set<string>;
/** Rows that were confirming and are now paid: same id, highlight, no motion. */
export function newlyConfirmed(before: ReadonlyMap<string, string> | null, rows: readonly ActivityRow[]): Set<string>;
/** True only when availableMinor rose (BigInt compare); a fall or first load is false. */
export function balanceRose(before: DashboardSummary | null, after: DashboardSummary): boolean;
export function updatedLabel(at: Date): string; // "Updated 14:02", Africa/Lagos, 24 h
/** Tips page: may the first page be replaced in place? */
export function canInsertInPlace(o: { searched: string; extraPages: number }): boolean;
```

- [ ] **Step 1: Write the failing tests** (`live-merge.test.mjs`):
  - `the first load marks nothing as arriving`.
  - `only a new paid tip arrives; a new confirming tip and a new withdrawal do not`.
  - `tips that arrive together are all marked in one change`.
  - `confirming to paid is newly confirmed, not arriving`.
  - `balanceRose is true for a rise and false for a fall, equal values or the first load`: covers `'9007199254740993'` against `'9007199254740992'` (no Number rounding).
  - `updatedLabel reads Updated HH:MM in Lagos time`.
  - `canInsertInPlace is false with a search or a later page loaded`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/web exec node --test test/live-merge.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Keep the previous ids and summary in refs, and compute the sets from them when new data lands. Clear the classes after 1 s with a timer.
  - The balance stays one `<strong data-testid="balance">` whose text is set in one render. The highlight sits on its wrapper and never on the number's transform.
  - The refresh note becomes `updatedLabel(updatedAt)` when `error === 'refresh'`.
  - Panels add no `role="status"` or `aria-live`.
  - Rows keep their keys (`${row.kind}-${row.id}`), so focus stays where it was.
  - With reduced motion, `.activity-list__row--arriving` has `animation: none`, and the highlight is a static background with no transition.
  - With forced colours, `outline: 2px solid Highlight` and no background.
- [ ] **Step 4: Run** the same command and `pnpm --filter @tipme/web typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): dashboard home, tips and moments refresh on signals; new paid tips arrive, the balance never moves`.

---

### Task 10: The two Settings switches (migration, contract, API, UI)

**Files:**

- Create:
  - `packages/database/drizzle/0071_live_popup_prefs.sql` and its snapshot, from `pnpm --filter @tipme/database generate`
- Modify:
  - `packages/database/src/schema.ts`: `popupHideTipDetails: boolean('popup_hide_tip_details').notNull().default(false)` and `tipSound: boolean('tip_sound').notNull().default(true)`
  - `packages/database/src/operations/profiles.ts`: `prefsOf` and `setNotificationPrefs` set them only when present
  - `packages/contracts/src/profiles.ts`
  - `apps/web/src/app/dashboard/settings/sections/notifications.tsx`: a new card, "Pop-ups and sound"
  - `tests/integration/notification-prefs.test.mjs`
  - `tests/e2e/notifications.spec.ts`

**Interfaces:**

```ts
// contracts: input stays strict, and the new keys are optional so an older client's PUT still validates
export const notificationPrefsSchema = z.object({
  tipEmails: z.boolean(), weeklyReports: z.boolean(), milestones: z.boolean(), guideEmails: z.boolean(),
  /** "Hide who tipped and how much in pop-ups". Off by default. */
  hideTipDetailsInPopups: z.boolean().optional(),
  /** "Sound for new tips". On by default. */
  tipSound: z.boolean().optional(),
}).strict();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
/** What GET and PUT return: always complete. */
export type NotificationPrefsView = Required<NotificationPrefs>;
export const NOTIFICATION_PREFS_CHANGED = 'tipme:notification-prefs-changed'; // web window event (same tab)
```

- [ ] **Step 1: Write the failing tests:**
  - `notification-prefs.test.mjs`:
    - `new accounts read hideTipDetailsInPopups false and tipSound true`;
    - `a PUT with both switches stores them`;
    - `a PUT without the new keys (an older client) leaves them unchanged`;
    - `an unknown key is still refused 400`.
  - `notifications.spec.ts`: `Settings shows "Hide who tipped and how much in pop-ups" off and "Sound for new tips" on, and saving keeps them after a reload`, with `expectAccessible(page)`.
- [ ] **Step 2: Run:**
  - `pnpm --filter @tipme/database generate` (the migration must contain only the two `ADD COLUMN` lines);
  - the integration command for `notification-prefs`;
  - `pnpm test:e2e -- tests/e2e/notifications.spec.ts`.
  
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The card is its own `<form>` with two checkbox switches. Labels match §14 exactly.
  - The hint reads: "For shared screens and shop counters. Your tips list still shows the details." The sound hint reads: "Plays once for a new paid tip while TipMe is in a background tab."
  - It saves through the same PUT with the full current prefs, and on success dispatches `NOTIFICATION_PREFS_CHANGED`.
  - The `NotificationsSection` comment about later live settings goes.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): switches to hide who tipped in pop-ups and to mute the new-tip sound (additive migration 0071)`.

---

### Task 11: The bell: live, the one announcer, the hide-details switch and the sound

**Files:**

- Create:
  - `scripts/make-tip-sound.mjs`
  - `scripts/make-tip-sound.test.mjs`
  - `apps/web/public/sounds/new-tip.wav` (generated by the script and committed)
  - `apps/web/src/lib/tip-sound.ts`
  - `apps/web/src/lib/tip-announcement.ts`
  - `apps/web/test/tip-announcement.test.mjs`
  - `apps/web/test/tip-sound.test.mjs`
- Modify:
  - `apps/web/src/components/dashboard/notification-bell.tsx`
  - `apps/web/src/components/live/live-provider.tsx`: `keepOpenWhenHidden` reads the armed sound
  - `docs/design/DECISION-LOG.md`: the 3 Nov owner rulings (pop-up details and switch; background-tab sound and mute; public pages not live)
  - `docs/design/EXPERIENCE-AND-MOTION.md` §4: the Sound row, worded as in plan note 2
  - `tests/e2e/notifications.spec.ts`

**Interfaces:**

```ts
// tip-announcement.ts: the once-a-minute polite announcer
export interface AnnouncerState { lastAt: number | null; heldCount: number }
export function announce(state: AnnouncerState, fresh: readonly NotificationView[], now: number,
  o: { hideDetails: boolean }): { text: string | null; state: AnnouncerState };
// a tip, details shown:  `${title} · ${body}`  e.g. "You got a tip · NGN 1,800.00 from Chidi"
// a tip, details hidden: "You got a new tip"
// more within the minute: held; the next announcement is "3 new tips"
// never includes a note or message; non-tip news keeps today's title · body
// tip-sound.ts
export function createTipSound(o: { src: '/sounds/new-tip.wav'; volume: 0.35;
  Audio: typeof Audio; document: Pick<Document, 'visibilityState' | 'addEventListener'> }): {
  readonly armed: boolean;                 // the page has had a pointerdown or keydown
  play(o: { enabled: boolean; isPaidTip: boolean }): void; // hidden tab only; failures are silent
};
// make-tip-sound.mjs
export function tipSoundSamples(): Int16Array; // 22.05 kHz mono, 0.5 s: two soft sine notes (E5 then A5) with 20 ms fades
export function wav(samples: Int16Array, rate: number): Buffer;
```

- [ ] **Step 1: Write the failing tests:**
  - `make-tip-sound.test.mjs`:
    - `the committed sound matches the generator byte for byte`;
    - `it is mono, under one second, and peaks at or below -18 dBFS`;
    - `it starts and ends at silence (no click)`.
  - `tip-announcement.test.mjs`:
    - `a new tip announces title and body`;
    - `with hideDetails the text is exactly "You got a new tip"`;
    - `a second tip within 60 s is held, and the next announcement after the minute is "2 new tips"`;
    - `a notification body is used, never a tip note`;
    - `nothing is announced on the first load`.
  - `tip-sound.test.mjs` (fake Audio and document):
    - `it plays only when hidden, enabled, armed and the notification is a paid tip`;
    - `a rejected play() is swallowed and nothing is shown`;
    - `it never plays for a non-tip notification`;
    - `reduced motion has no bearing on it` (no matchMedia read).
  - `notifications.spec.ts`:
    - `while the stream is connected the bell does not poll`: count `**/v1/me/notifications?unreadOnly=1` requests over 25 s with no tip, at most the initial read and one 5-minute safety refresh, which won't happen inside 25 s;
    - `with "Hide who tipped and how much in pop-ups" on, the toast reads "You got a new tip"`.
- [ ] **Step 2: Run:**
  - `node --test scripts/make-tip-sound.test.mjs`;
  - `pnpm --filter @tipme/web exec node --test test/tip-announcement.test.mjs test/tip-sound.test.mjs`;
  - `pnpm test:e2e -- tests/e2e/notifications.spec.ts`.
  
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `node scripts/make-tip-sound.mjs` writes the WAV (about 22 KB). It is self-hosted, licence-free and authored by us, so no third-party register entry is needed. `media-src 'self'` in `apps/web/next.config.ts` already allows it.
  - In `useNotifications`, register `useLiveEvents(['notifications.changed'], reload)`. Run the 10 s `setInterval` only when `useLiveStatus()` is `'idle'` (no provider) or `'disabled'`. While polling, the provider's 20 s poll calls `reload`.
  - The bell reads `/v1/me/notification-preferences` on mount and on `NOTIFICATION_PREFS_CHANGED` (and `account.changed` after Task 15).
  - The toast text comes from `announce(...)`. The `role="status"` region stays the only live region.
  - On a fresh `kind === 'tip'` notification, call `sound.play({ enabled: prefs.tipSound, isPaidTip: true })`. Tip notifications are written only for `SUCCEEDED` tips (`notifyTipSucceeded`).
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the bell goes live: one polite announcer, hide-details switch and a soft background-tab sound`.

---

### Task 12: The headline e2e test, the threat model and the runbook note

**Files:**

- Create: `tests/e2e/live-updates.spec.ts`
- Modify:
  - `docs/security/threat-model.md`: a new row, "Live stream leaks data or is abused", with the spec §9 mitigations and links to `apps/api/test/live-hub.test.mjs` and `tests/integration/live-events.test.mjs`
  - `docs/runbooks/production.md` (from Task 6)
  - `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`

**The test (`tests/e2e/live-updates.spec.ts`), using `signUpRecipient` and `tipAsVisitor` from `tests/e2e/helpers.ts` on the pretend-payments stack:**

- `a visitor tips and the signed-in dashboard's balance and tip list update with no reload`:
  1. `signUpRecipient(page, testInfo)`, then `tipAsVisitor(browser, handle, { name: 'Ada M.' })` and `page.goto('/dashboard')`. Expect `getByTestId('balance')` to have the text `NGN 1,800.00`. The first tip leaves the first-day screen before the test proper.
  2. `await page.evaluate(() => { window.__noReload = 1; })`. Install a `MutationObserver` on the balance that pushes every distinct `textContent` into `window.__balances`. Wait for the provider to report `connected`, exposed as `data-live="connected"` on the shell.
  3. `tipAsVisitor(browser, handle, { amount: '2,000 NGN', name: 'Chidi' })`.
  4. Within **5 s** (below the 20 s fallback, so the stream did it):
     - `balance` reads `NGN 3,600.00`;
     - the activity list's first link is `/Tip from Chidi/` and contains `Paid`.
  5. Expect `getByRole('status').filter({ hasText: 'You got a tip · NGN 1,800.00 from Chidi' })` to be visible.
  6. Expect `window.__noReload === 1`, and `window.__balances` to deep-equal `['NGN 1,800.00', 'NGN 3,600.00']`: only the old and the new value.
- `with reduced motion the new row appears with no running animations`: `browser.newContext({ reducedMotion: 'reduce' })`, the same flow, then `await row.evaluate(el => el.getAnimations().length) === 0`.
- `with the stream blocked the balance still updates within 25 s`: `page.route('**/v1/me/events', r => r.abort())` before `goto`. After the second tip, the balance reads `NGN 3,600.00` within 25 s, with still no reload.
- `a signed-in user signed out elsewhere goes to sign-in without a reload`: a second context for the same user presses "Sign out other devices". The first page reaches `/sign-in` within 5 s.

- [ ] **Step 1: Write the failing spec** above.
- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/live-updates.spec.ts`. Expected: FAIL on `data-live` missing. To prove the 5 s bound means the stream did it, run once with `LIVE_UPDATES_ENABLED: 'false'` in `playwright.config.ts`: the first test must FAIL with the balance still `NGN 1,800.00` at 5 s. Then restore it.
- [ ] **Step 3: Implement** whatever the spec exposes (expected: only the `data-live` attribute), plus the threat-model row and the handoff notes.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/live-updates.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/notifications.spec.ts`, then the full pre-PR command list. Expected: PASS. Record the exact results.
- [ ] **Step 5: Commit** `test(e2e): a tip lands and the dashboard's balance and list update with no reload; threat model row`.

---

## PR 2: plan, withdrawals and banners

### Task 13: `profile.changed`: plan, suspension, handle and the dirty-form rule

**Files:**

- Modify (API publish points, after each write resolves, beside the existing `this.revalidator.revalidate(...)`):
  - `apps/api/src/ops/pages.controller.ts`: `plan` (when `changed`) and `handle-changes`
  - `apps/api/src/ops/actions.controller.ts`: `pages/:profileId/suspend` and `unsuspend`
  - `apps/api/src/profiles/me-profile.controller.ts`: `PATCH profile`, `PUT handle`, `PUT tip-amounts`, `PUT page/state`
  - the cover and photo routes in `apps/api/src/profiles/`
  
  Each resolves the user from the profile with a cheap lookup only where the route lacks it (`userIdOfProfile(db, profileId)`, additive).
- Modify (web):
  - `apps/web/src/app/dashboard/dashboard-shell.tsx`: `useLiveEvents(['profile.changed'], reloadProfile)`, which calls `setProfile`
  - `apps/web/src/app/dashboard/settings/sections/my-page.tsx`, `plan.tsx`
  - `apps/web/src/app/dashboard/qr/*` (refetch `/v1/me/qr-art`)
- Create:
  - `apps/web/src/lib/live-form.ts`
  - `apps/web/test/live-form.test.mjs`
- Tests:
  - `tests/integration/live-events.test.mjs` (extend)
  - `tests/e2e/pro.spec.ts` (extend)

**Interfaces:**

```ts
/** Keeps what the person is editing; reports that the saved value changed elsewhere. */
export function mergeServerIntoForm<T extends Record<string, unknown>>(o: {
  server: T; previousServer: T; local: T; dirty: ReadonlySet<keyof T> }): { next: T; changedElsewhere: boolean };
```

- [ ] **Step 1: Write the failing tests:**
  - `live-form.test.mjs`:
    - `undirty fields take the server value`;
    - `a dirty field keeps the person's input and sets changedElsewhere when its server value changed`;
    - `no change on the server gives changedElsewhere false`.
  - Integration: `staff setting Pro publishes profile.changed to that user only`, and `suspending a page publishes profile.changed`.
  - `pro.spec.ts`: `staff turn on Pro in another context and the recipient's QR studio and amounts unlock without a reload`, with `__noReload` as in Task 12 and a 5 s bound. Also `an edited, unsaved display name is kept and "This changed on another device." shows with "Show the latest"`.
- [ ] **Step 2: Run** `pnpm --filter @tipme/web exec node --test test/live-form.test.mjs`, the integration command for `live-events`, and `pnpm test:e2e -- tests/e2e/pro.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the publish points with `await this.live({ to: { user }, type: 'profile.changed' })` after the operation (the publisher never throws), and the notice with its button in Settings and the QR studio. The shell's paused-page notice already follows `MyProfile.suspended`.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat: plan, suspension and page edits update open dashboards; unsaved edits are kept`.

---

### Task 14: `withdrawals.changed` and `payments.changed`

**Files:**

- Modify:
  - `apps/worker/src/live-signals.ts`:
    - `payout.paid`, `payout.failed` and `WITHDRAWAL_FREEZE_OPENED_EVENT` → to the profile;
    - `ops.freeze_released` → to `payload.profileId`;
    - `WITHDRAWALS_SWITCH_EVENT` → `{ all: true }`.
  - `packages/database/src/operations/issues.ts`: add `profileId` to the `ops.freeze_released` payload (additive).
  - `apps/worker/src/job-worker.ts`: `PAYOUT_START_EVENT` after `handlePayoutStart` returns → to its profile. `PAYOUT_SETUP_JOB` → `payments.changed` for `swept.value.changedProfileIds`.
  - `packages/database/src/operations/payment-accounts.ts` (or wherever `sweepPayoutSetup` lives): return `changedProfileIds: string[]` (additive).
  - `apps/api/src/dashboard/dashboard.controller.ts`: `POST withdrawals` → `withdrawals.changed` to the profile, for other tabs.
  - `apps/api/src/ops/pages.controller.ts`: `withdrawal-freeze` → to the profile.
  - `apps/api/src/webhooks/webhook.service.ts` `refreshBachsAccount` and `apps/api/src/profiles/payment-accounts.controller.ts` after `updatePaymentAccountStatus` → `payments.changed`.
  - Web:
    - `apps/web/src/app/dashboard/withdraw/withdraw-view.tsx`: its three `usePanel` calls get `live: ['withdrawals.changed', 'tips.changed']`;
    - `apps/web/src/app/dashboard/settings/payment-account-card.tsx` and the shell's `refreshAttention`: `useLiveEvents(['payments.changed'], …)`;
    - `apps/web/src/lib/live-refetch.ts`: a `withdrawals.changed` that comes from a broadcast is not distinguishable on the client, so the provider waits a random 0–10 s before every `withdrawals.changed` refetch only when the user has no withdrawal in flight. This is decided here, because the browser never learns the target. Assert it.
- Tests:
  - `apps/worker/test/live-signals.test.mjs` (extend)
  - `tests/integration/withdrawals-switch-api.test.mjs`, `tests/integration/withdrawal-freeze.test.mjs`
  - `tests/e2e/withdraw.spec.ts`, `tests/e2e/withdrawal-controls.spec.ts`

- [ ] **Step 1: Write the failing tests:**
  - `live-signals`:
    - `payout.paid and payout.failed map to withdrawals.changed for the profile`;
    - `the withdrawals switch broadcasts to all`;
    - `freeze_released uses the new profileId and maps to [] without it`.
  - Integration:
    - `the switch reaches every recipient stream`;
    - `a freeze reaches only that page's owner`.
  - `withdraw.spec.ts`: `a pretend payout paid changes the status in an open tab without a reload, with no celebration` (the status reads `Paid` and the row has no running animations).
  - `withdrawal-controls.spec.ts`: `turning withdrawals off shows in an open Withdraw tab within 15 s`.
  - `live-refetch.test.mjs`: `withdrawals.changed waits 0–10 s when nothing is in flight, and refetches at once when a withdrawal is in flight`.
- [ ] **Step 2: Run** the worker, web and integration commands and `pnpm test:e2e -- tests/e2e/withdraw.spec.ts tests/e2e/withdrawal-controls.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the mappings and publish points. Paid is a colour and label change. Failed says the money is back in the balance and doesn't animate (EXPERIENCE §7.5).
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat: withdrawals, the TipMe-wide switch, freezes and payout account status update open dashboards`.

---

### Task 15: `reports.changed` and `account.changed`

**Files:**

- Modify:
  - `packages/database/src/operations/reports.ts`: `runWeeklyReports` returns `{ created, profileIds }` (additive)
  - `apps/worker/src/job-worker.ts`: after `WEEKLY_REPORTS_JOB`, send `reports.changed` and `notifications.changed` to each profile
  - The `/v1/me/*` recovery email, email and notification-preference routes (`apps/api/src/profiles/me-profile.controller.ts`, the recovery and email controllers): `account.changed` to the user
  - Web:
    - `apps/web/src/app/dashboard/reports/*` (`live: ['reports.changed']`);
    - the Settings sections (`notifications.tsx`, `security.tsx`): `account.changed` refetches recovery email, prefs and sessions, under the Task 13 dirty-form rule;
    - `notification-bell.tsx`: `account.changed` refetches the recovery email and the prefs
- Tests:
  - `apps/worker/test/live-signals.test.mjs`
  - `tests/integration/notification-prefs.test.mjs`
  - `tests/e2e/reports.spec.ts` (extend)

- [ ] **Step 1: Write the failing tests:**
  - `jobSignalsFor reports.weekly gives reports.changed and notifications.changed per profile id`;
  - `saving preferences publishes account.changed to the user`;
  - `turning on hide-details in one tab changes the toast wording in another open tab` (e2e, `notifications.spec.ts`).
- [ ] **Step 2: Run** the commands. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the commands, then the full pre-PR list. Expected: PASS.
- [ ] **Step 5: Commit** `feat: weekly reports and account settings update open tabs and devices`.

---

## PR 3: admin

### Task 16: The staff stream, approvals and issues

**Files:**

- Modify:
  - `apps/api/src/live/live.controller.ts`: `OpsLiveController` for `@Controller('v1/ops')`, `@Get('events')`, `@OpsAnyStaff()`, `@UseGuards(RateLimitGuard, OpsGuard)`, which calls `openStream` with `kind: 'ops'`, `permissions: ops.permissions`, the grant's expiry and a `recheck` that re-runs `resolveOpsGrant`.
  - `apps/worker/src/live-signals.ts`: `ops.approval_pending`, `ops.approval_ran` and `ops.approval_closed` → `{ staff: 'any' }` `ops.approvals.changed`. `ops.staff_changed` and `ops.last_approver_removed` → `{ staff: 'any' }` `staff.changed`.
  - `apps/worker/src/job-worker.ts`:
    - after `handleDomainEvent` returns `issue_opened`: `ops.issues.changed` to `{ staff: 'issues.view' }`;
    - after `RECONCILE_JOB`, when `detected.opened + cleared.resolved > 0`: the same.
  - `apps/api/src/ops/approvals.controller.ts` (after a decision) → `ops.approvals.changed`.
  - `apps/api/src/ops/actions.controller.ts` (`issues/:id/resolve`) → `ops.issues.changed`.
  - `revokeOpsGrants` callers → `staff.changed`.
  - Web:
    - `apps/web/src/app/ops/ops-shell.tsx`: `<LiveProvider stream="ops">` with `url: apiUrl('/v1/ops/events')` and an ops probe;
    - `apps/web/src/app/ops/approvals/page.tsx` and the Overview's approvals count: `useLiveEvents(['ops.approvals.changed'], reload)`;
    - `apps/web/src/app/ops/issues/page.tsx`: `useLiveEvents(['ops.issues.changed'], reload)`. Its 30 s `setInterval` runs only when `useLiveStatus()` is not `connected`.
  - `docs/api/openapi.json`, `docs/security/access-control.md` (regenerated)
- Tests:
  - `apps/api/test/live-hub.test.mjs` (already covers staff routing)
  - `tests/integration/ops-approvals.test.mjs`, `tests/integration/live-events.test.mjs`
  - `tests/e2e/ops-alone.spec.ts` (or the approvals spec)

- [ ] **Step 1: Write the failing tests:**
  - Integration:
    - `/v1/ops/events without a grant gets the guard's 404`;
    - `a pending approval reaches another staff member's stream`;
    - `a new issue reaches a stream with issues.view and not one without`;
    - `revoking a grant closes that staff stream`.
  - e2e: `a second approver sees a new request without a reload within 5 s`.
- [ ] **Step 2: Run:**
  - the integration command for `ops-approvals` and `live-events`;
  - `node --test scripts/generate-docs.test.mjs`;
  - `E2E_ALONE=1 pnpm test:e2e -- tests/e2e/ops-alone.spec.ts` (`@alone` tests run on their own).
  
  Expected: FAIL.
- [ ] **Step 3: Implement.** Admin stays nearly still (EXPERIENCE §7.10): no arrival motion on ops lists, rows keyed by id, no announcement.
- [ ] **Step 4: Run** the same commands, then `pnpm api:openapi && pnpm docs:generate`, then the full pre-PR list. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): a staff signal stream; approvals and issues update without a reload`.

---

## Self-review against the spec

- §2.1 endpoints and response, §2.4 lifetime, §2.5 resync: Tasks 4, 7 and 8. §2.6 the channel and `to` staying on the server: Tasks 1 and 2. §2.7 the three publish points after the commit: Tasks 5, 13, 14, 15 and 16.
- §3.1 Caddyfile and draining: Tasks 6 and 4. §3.2 limits: Task 4. §3.3 budgets: the Task 4 connection-budget assertion.
- §4 catalogue: PR 1 covers tips, notifications, moments and sessions. PR 2 covers profile, withdrawals (including all), payments, reports and account. PR 3 covers staff. Tips cancelled by expiry and the monthly moments job are deliberately not signalled (the fallback catches them).
- §5.3 and §14.3: the public pages and the tip receipt are untouched. They have no stream and no task.
- §6 client behaviours, each in the Task 7 tests. §6.3 merge rules: Task 9 and the Task 13 forms.
- §7 and §14.1–14.2: the one announcer, once a minute with a count, hide-details, and the sound only for paid tips in a hidden tab after an interaction, muted by its switch: Tasks 10 and 11.
- §8 failure table: Review Focus 1–5, plus the Task 7 buffered and sleep cases and the Task 4 cap case.
- §9: the threat-model row is in Task 12. §10 metrics and the HTTP ignore hook: Tasks 3 and 4. §11 tests: every named file appears above. §12 flag and PR order: Tasks 3, 6, 12 and this file's PR split.
