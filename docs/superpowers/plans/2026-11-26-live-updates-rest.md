# Live Updates for the Rest of TipMe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The remaining polling screens (staff approvals, issues, announcements, providers; the update notice; the tip receipt; Pro "confirming") listen on SSE and read only when told something changed, with today's timers kept as the fallback, all behind `LIVE_UPDATES_ENABLED`.

**Architecture:** The base design's live module is reused as built. Task 1 opens `/v1/ops/events` on the shared `openStream` and makes staff routing permission-aware. Tasks 2–5 add the staff publishers and move four ops screens onto an ops `LiveProvider`. Task 6 makes the update notice listen to the page's streams through an in-page registry. Task 7 adds a one-tip public stream read with `fetch` and the status token, plus server-side partner checks while it is open. Task 8 adds `pro.changed` for the Settings "confirming" slip.

**Tech Stack:** TypeScript, pnpm/Turbo, NestJS API, BullMQ worker, ioredis pub/sub, Next.js web, zod contracts, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-live-updates-rest-addendum.md` (this work), which is an addendum to `docs/superpowers/specs/2026-11-03-live-updates-design.md` (the base design). Read both.

## Global Constraints

- Signals carry no data. A browser only ever receives `{"type": ...}` from the fixed lists in `packages/contracts/src/live.ts`; the routing key `to` never leaves the server.
- Staff streams get only the signals their grant's permissions allow: `ops.approvals.changed` any staff; `ops.issues.changed` `issues.view`; `ops.announcements.changed` `announcements.send`; `ops.providers.changed` `issues.view` or `providers.manage`.
- The public tip stream never reveals anything beyond "changed" (`ready`, `tip.changed`, control types, heartbeats), requires the receipt's status token in an `Authorization: Bearer` header (never in a URL), and answers a wrong token exactly as `GET /v1/tips/:tipId/status` does (404).
- Everything stays behind `LIVE_UPDATES_ENABLED` (off in staging and production). Off: every screen makes exactly today's requests and runs today's timers, and nothing makes a request to learn that live updates are off.
- Staff fallback: 30 s ± 3 s while the stream is down; never 5 s; no timed requests while connected (the safety refresh is off for the ops stream).
- Every publish is after the commit, never inside a transaction, never awaited by or failing the work that raised it (base design §2.7).
- Every new Redis key has a TTL.
- Contracts changes are additive (optional fields, new list entries). No migrations.
- E2E lanes 3–8 only (`E2E_LANE=<3..8>`). Linux visual baselines only from CI artifacts. Any spec that routes `**/v1/me/**` answers `/v1/me/events` with 204; after Task 3 any spec that routes `**/v1/ops/**` answers `/v1/ops/events` with 204.
- UI changes need phone and desktop screenshots in the PR body (images on the `pr-assets` branch).
- Integration tests run with `--test-concurrency=1`: `pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test --test-concurrency=1 tests/integration/<file>.test.mjs`.
- API and worker unit tests import `dist/`: build first (`pnpm --filter @tipme/api build && pnpm --filter @tipme/api test`).
- No `--no-verify`, no bare `git stash`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never edit `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`.
- PATH: `$HOME/.nvm/versions/node/v24.22.0/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH`.

**Shared files with branches building now** (rebase on `dev` before each PR, and expect conflicts here):

- `apps/worker/src/job-worker.ts`, `packages/contracts/src/ops.ts`, `packages/contracts/src/index.ts`, `packages/database/src/operations/provider-events.ts`: fee waivers.
- `packages/contracts/src/ops.ts`, `apps/web/src/app/dashboard/settings/sections/plan.tsx` (4 lines on `feat/profit-guards`): profit guards.
- Giving has no plan committed yet; check its branch for `live.ts`, `job-worker.ts` and the receipt before Task 7.

**Proposed PRs:** A = Tasks 1–3 (staff stream, approvals, issues). B = Tasks 4–5. C = Task 6. D = Task 7. E = Task 8.

## Review Focus

1. **A staff member loses `issues.view` while their issues tab is open:** after `staff.changed` their stream closes, reconnects with the new set, and never receives `ops.issues.changed` again. Test in Task 1.
2. **An open admin tab with nothing happening:** the stream connect never moves the grant's `lastSeenAt`, and the stream closes by the grant's idle deadline. Test in Task 1.
3. **Live on but the staff stream is refused or buffered while an announcement sends:** the page reads every 30 s ± 3 s, never 5 s, and never stops reading. Test in Task 4.
4. **A receipt stream opened with tip A's token for tip B, or with no token:** 404 with the status route's body, and a correct stream for tip A never receives tip B's `tip.changed` or any recipient or broadcast signal. Test in Task 7.
5. **A receipt left open past 15 minutes, or on a tip that becomes final:** the stream closes, the client never reconnects, and the page shows today's "Try again"; a stream asked for a final tip is 204. Test in Task 7.

---

### Task 1: The staff stream `/v1/ops/events`

**Files:**

- Modify: `packages/contracts/src/live.ts` (staff types, permission targets, schema)
- Modify: `packages/contracts/src/ops.ts` (`OpsMe` granted state: `liveUpdates?: boolean`)
- Modify: `apps/api/src/live/live-router.ts` (`targets` for permission lists)
- Modify: `apps/api/src/live/live.controller.ts` (new `OpsLiveController`, or a second route on `LiveController`), `apps/api/src/live/live.module.ts`
- Modify: `packages/database/src/operations/ops-sessions.ts` (`resolveOpsGrant` options and return)
- Modify: `apps/api/src/ops/ops.guard.ts` (no-touch read for the stream route), `apps/api/src/ops/permission.decorator.ts` (`OpsStream`)
- Modify: `apps/api/src/ops/ops-access.controller.ts` (`liveUpdates` in `me`; publish `staff.changed` after `revokeOpsGrants`)
- Modify: `apps/worker/src/live-signals.ts` (`ops.staff_changed`, `ops.last_approver_removed` → `staff.changed`)
- Modify: `docs/security/threat-model.md` (P10: staff streams mitigated)
- Test: `packages/contracts/test/live.test.mjs`, `apps/api/test/live-hub.test.mjs`, `apps/worker/test/live-signals.test.mjs`, new `tests/integration/live-ops-events.test.mjs`, `packages/database/test/integration/staff.test.mjs` (extend: `resolveOpsGrant` with `touch: false` leaves `last_seen_at` alone and returns `expiresAt` and `idleDeadline`)

**Interfaces:**

- Produces (contracts):
  - `LIVE_STAFF_TYPES = ['ops.approvals.changed', 'ops.issues.changed', 'ops.announcements.changed', 'ops.providers.changed'] as const`
  - `LIVE_STAFF_PERMISSIONS = ['issues.view', 'announcements.send', 'providers.manage'] as const`; `type LiveStaffPermission`
  - `LiveTarget` staff arm: `{ staff: 'any' | LiveStaffPermission | readonly LiveStaffPermission[] }`; the schema accepts a non-empty array of at most 3 distinct permissions.
  - `OpsMe` granted: `{ state: 'granted'; role: string; permissions: string[]; liveUpdates?: boolean }`
- Produces (database): `resolveOpsGrant(db, { token, sessionId, now?, touch? })`, `touch` default `true`; the result gains `expiresAt: Date` and `idleDeadline: Date` (`lastSeenAt + OPS_GRANT_IDLE_MS`).
- Produces (API): `OpsStream()` decorator = `OpsAnyStaff()` plus metadata `OPS_NO_TOUCH`; `OpsGuard` passes `touch: false` when it is set. `GET /v1/ops/events` with `@SetMetadata(RATE_LIMIT_ROUTE, 'live_connect')`, `RateLimitGuard`, `OpsStream()`, then `consumeForPerson('live_connect_user', userId)`; sink `{ kind: 'ops', userId, profileId: null, permissions: grant.permissions }`; `expiresAt = min(grant.expiresAt, grant.idleDeadline)`.
- Produces (worker): `liveSignalFor('ops.staff_changed', p)` and `liveSignalFor('ops.last_approver_removed', p)` return `[{ to: { staff: 'any' }, type: 'staff.changed' }]`.

- [ ] **Step 1: Write the failing unit tests.**
  - contracts `live.test.mjs`: `a staff target may name a list of permissions` → `parseLiveMessage('{"to":{"staff":["issues.view","providers.manage"]},"type":"ops.providers.changed"}')` is not null; `[]`, `["switches.manage"]` and `["issues.view","issues.view"]` parse to `null`.
  - `live-hub.test.mjs`: `a permission list reaches a stream holding any one of them` → ops sinks with `{issues.view}`, `{providers.manage}`, `{announcements.send}`; dispatch `{ staff: ['issues.view','providers.manage'] }, 'ops.providers.changed'` → first two get exactly one `data: {"type":"ops.providers.changed"}` frame, the third none; a `me` sink none.
  - `live-hub.test.mjs`: `staff.changed closes a stream whose permissions changed` → `recheck` resolves `false` → the sink gets `session.ended` and is closed (the route's `recheck` returns false for a changed set; this pins the router side).
  - `live-signals.test.mjs`: `staff changes re-check every staff stream` → both event names map to `[{ to: { staff: 'any' }, type: 'staff.changed' }]`; the existing "every outbox event is mapped" test still passes.
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @tipme/contracts test && pnpm --filter @tipme/api build && pnpm --filter @tipme/api test && pnpm --filter @tipme/worker build && pnpm --filter @tipme/worker test`
- [ ] **Step 3: Implement** the contracts, the router's any-of match, the worker mappings and `resolveOpsGrant`'s `touch` option and new fields.
- [ ] **Step 4: Write the failing integration tests** in `tests/integration/live-ops-events.test.mjs` (stack with `LIVE_UPDATES_ENABLED: 'true'`, `LIVE_HEARTBEAT_MS: '1000'`, as `live-events.test.mjs`; staff seeded and granted with the helpers `ops-approvals.test.mjs` uses):
  - `no grant is 404 and a recipient session alone is 404` (body equal to `GET /v1/ops/issues`'s 404 body).
  - `with live updates off the route answers 204` (a second stack, or the gate test pattern in `live-events.test.mjs`).
  - `a granted staff member gets retry, ready, then heartbeats past 12 s`.
  - `connecting does not move the grant's lastSeenAt` → read `ops_sessions.last_seen_at` before and 2 s after connect: equal (Review Focus 2).
  - `the stream closes at the grant's idle deadline` → set `last_seen_at` to `now - 60 min + 3 s` in the database, connect, expect the stream to end within 6 s.
  - `an issues signal reaches only staff holding issues.view` → two staff (one role without `issues.view`), publish `{ to: { staff: 'issues.view' }, type: 'ops.issues.changed' }` on the channel; only the first stream gets it; a recipient stream of a third person gets nothing.
  - `losing issues.view mid-stream closes the stream with session.ended` → change the role through `PUT /v1/ops/staff/:userId/role`, wait for the relay; the stream receives `{"type":"session.ended"}` and ends; a reconnect then gets no `ops.issues.changed` (Review Focus 1).
  - `admin sign-out closes the staff stream` → `POST /v1/ops/sign-out`; stream ends with `session.ended`.
  - `GET /v1/ops/me says liveUpdates` → `true` on this stack.
- [ ] **Step 5: Run, expect FAIL:** `pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test --test-concurrency=1 tests/integration/live-ops-events.test.mjs`
- [ ] **Step 6: Implement** the route on `openStream` (same lifetime and heartbeat as `me`), the `recheck` (`resolveOpsGrant(..., { touch: false })` is non-null, same user, and the same permission set), the `OpsStream` decorator, `liveUpdates` in `me`, and `publishLive({ to: { staff: 'any' }, type: 'staff.changed' })` after `revokeOpsGrants`. Document the route with `@EventStreamResponse` (204 off, 404 no grant, 429 `LIVE_LIMIT`, 503 `LIVE_UNAVAILABLE`). Update threat model P10's status column: staff streams mitigated, with this test file.
- [ ] **Step 7: Run Steps 2 and 5 again, plus** `node --test scripts/generate-docs.test.mjs` and `tests/integration/live-events.test.mjs`; expect PASS.
- [ ] **Step 8: Commit** `feat(live): staff stream /v1/ops/events with permission routing`.

### Task 2: Approvals and issues signals

**Files:**

- Modify: `apps/worker/src/live-signals.ts` (approval events; `jobSignalsFor` for `issue_opened`; new `reconcileIssueSignals`)
- Modify: `apps/worker/src/job-worker.ts` (publish after the reconcile issue sweep, ~909)
- Modify: `apps/api/src/ops/approvals.controller.ts` (after approve, reject, cancel), `apps/api/src/ops/actions.controller.ts` (after `resolveIssue`, ~178)
- Test: `apps/worker/test/live-signals.test.mjs`, `tests/integration/ops-approvals.test.mjs`, `tests/integration/ops-issues.test.mjs`

**Interfaces:**

- Consumes: Task 1 (`LIVE_STAFF_TYPES`, staff targets).
- Produces: `liveSignalFor` for `ops.approval_pending`, `ops.approval_ran`, `ops.approval_closed` → `[{ to: { staff: 'any' }, type: 'ops.approvals.changed' }]`. `jobSignalsFor(name, 'issue_opened', data)` → `[{ to: { staff: 'issues.view' }, type: 'ops.issues.changed' }]` for any domain event name. `reconcileIssueSignals({ opened: number; resolved: number }): LiveMessage[]` → the issues signal when either is above 0, else `[]`.

- [ ] **Step 1: Write the failing tests.**
  - `live-signals.test.mjs`: `approval events reach every staff stream`, `an opened issue reaches issues staff`, `a reconcile that opened or resolved nothing signals nothing` (`{0,0}` → `[]`; `{1,0}` and `{0,2}` → one message).
  - `ops-approvals.test.mjs`: `a pending approval reaches a second staff member's stream` → open a staff stream for the second approver, request a serious action as the first; within 5 s the stream has `ops.approvals.changed`. `a decision reaches the requester's stream` → approve as the second; the first's stream gets it.
  - `ops-issues.test.mjs`: `resolving an issue reaches issues staff` → stream for a staff member with `issues.view`, resolve through the actions route; the stream gets `ops.issues.changed`.
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @tipme/worker build && pnpm --filter @tipme/worker test`, then the two integration files with `--test-concurrency=1`.
- [ ] **Step 3: Implement** the mappings and publish points (after each route's operation resolves; in `job-worker.ts` `void publishLive(reconcileIssueSignals({ opened: detected.opened, resolved: cleared.resolved }))` after `autoResolveIssues`).
- [ ] **Step 4: Run Step 2 again, expect PASS;** also `tests/integration/live-relay.test.mjs`.
- [ ] **Step 5: Commit** `feat(live): approvals and issues signals for staff`.

### Task 3: Ops screens on the staff stream (shell, approvals, issues)

**Files:**

- Modify: `apps/web/src/lib/live-client.ts` (`timing` overrides, `onReady`)
- Modify: `apps/web/src/components/live/live-provider.tsx` (`timing` prop; ops probe maps 404 to `unauthenticated`)
- Create: `apps/web/src/lib/own-timer.ts`
- Modify: `apps/web/src/app/ops/ops-shell.tsx` (provider around `OpsFrame` in `OpsGranted`; `liveUpdates` into state)
- Modify: `apps/web/src/components/ops/approvals-count.tsx`, `apps/web/src/app/ops/approvals/page.tsx`, `apps/web/src/app/ops/issues/page.tsx`
- Modify: `tests/e2e/AGENTS.md` (the `/v1/ops/events` 204 rule), and every spec that routes `**/v1/ops/**` (find with `grep -ln "v1/ops/\*\*" tests/e2e`)
- Test: `apps/web/test/live-client.test.mjs`, new `apps/web/test/own-timer.test.mjs`, `apps/web/test/live-flag-off.test.mjs`, new `tests/e2e/live-ops.spec.ts`

**Interfaces:**

- Produces:
  - `LiveClientDeps.timing?: { pollMs?: number; pollJitterMs?: number; safetyMs?: number | null }` (`null` = no safety refresh); `LiveClient.onReady(fn: () => void): () => void`, fired on every `ready` message.
  - `OPS_LIVE_TIMING = { pollMs: 30_000, pollJitterMs: 3_000, safetyMs: null } as const` exported from `live-provider.tsx`; `<LiveProvider stream="ops" timing={OPS_LIVE_TIMING} enabled={liveUpdates} onSignedOut={reload}>`.
  - `ownTimerRuns(status: LiveStatus): boolean` in `own-timer.ts` → true only for `'idle'` and `'disabled'` (the bell's rule, now shared; the bell imports it).
  - `OpsAccess` gains `liveUpdates: boolean` (from `OpsMe.liveUpdates === true`).

- [ ] **Step 1: Write the failing unit tests.**
  - `live-client.test.mjs`: `ops timing polls every 30 s ± 3 s while degraded` → with `timing: { pollMs: 30_000, pollJitterMs: 3_000 }`, after 3 failures, resyncs land in [27 s, 33 s] apart, never under 27 s. `safetyMs null makes no timed resync while connected` → connected and visible for 20 min of fake time: exactly one resync (the `ready`). `onReady fires on every ready, including after a server close`.
  - `own-timer.test.mjs`: `only idle and disabled run their own timer` over all five statuses.
  - `live-flag-off.test.mjs`: `the ops shell opens a stream only when ops/me says liveUpdates` (the pure check the shell uses; add `opsLiveEnabled(access: OpsAccess | null): boolean` to `live-enabled.ts`).
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @tipme/web test`
- [ ] **Step 3: Implement** the client options, `onReady`, `ownTimerRuns`, `opsLiveEnabled`, and the shell provider. The ops probe treats 404 as `unauthenticated`; `onSignedOut` runs `opsState().then(apply)`.
- [ ] **Step 4: Implement the screens.** Approvals: `useLiveEvents(['ops.approvals.changed'], load)`; the count: `useLiveEvents(['ops.approvals.changed'], reload)`. Issues: register the first-page read with the current filters (latest ref); keep the 30 s `setInterval` only while `ownTimerRuns(useLiveStatus())`; when more than one page is loaded, a signal sets `newChanges` and shows a quiet button "New changes: show" above the list (it re-reads the first page and drops the extra pages). The button follows `packages/ui` and the design constitution; no new live region.
- [ ] **Step 5: Run Step 2 again, expect PASS;** `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`.
- [ ] **Step 6: Write the e2e tests** in `tests/e2e/live-ops.spec.ts`, using `ops-helpers.ts`:
  - `a second approver sees a new request without reloading` → two staff contexts; B on `/ops/approvals` with `window.__noReload = 1`; A asks for a serious action; B's pending list shows it within 5 s; `__noReload` still 1; B's menu count shows it.
  - `issues make no timed requests while connected` → count requests to `/v1/ops/issues` on `/ops/issues` for 65 s after the first read: 0 beyond the first read and the ready resync; `[data-live="connected"]` present.
  - `issues fall back to 30 s when the stream is refused` → `page.route('**/v1/ops/events', r => r.abort())`; over 70 s, 2 or 3 reads of `/v1/ops/issues` after the first, none closer than 27 s.
  - `a new issue appears without reloading` → trigger an issue the way `ops-screens.spec.ts` seeds one; the row appears within 5 s.
- [ ] **Step 7: Run, expect PASS:** `rm -rf apps/web/.next && E2E_LANE=4 TURBO_FORCE=true node scripts/build-e2e.mjs && E2E_LANE=4 node scripts/prepare-e2e-database.mjs && E2E_LANE=4 pnpm exec playwright test tests/e2e/live-ops.spec.ts tests/e2e/ops-alone.spec.ts tests/e2e/ops-screens.spec.ts --repeat-each=5 --retries=0 --workers=2`, plus every spec you added the 204 rule to (once each).
- [ ] **Step 8: Commit** `feat(ops): approvals and issues update live; 30 s fallback`. The PR body shows the issues "New changes: show" button, phone and desktop.

### Task 4: Announcements

**Files:**

- Modify: `apps/worker/src/live-signals.ts` (`announcementSignals`), `apps/worker/src/job-worker.ts` (~1005)
- Modify: `apps/api/src/ops/announcements.controller.ts` (after cancel, ~219)
- Modify: `apps/web/src/app/ops/announcements/page.tsx` (~193–205)
- Test: `apps/worker/test/live-signals.test.mjs`, `tests/integration/ops-announcements-api.test.mjs`, `tests/e2e/ops-announcements.spec.ts`

**Interfaces:**

- Consumes: Tasks 1 and 3 (`ops.announcements.changed`, `OPS_LIVE_TIMING`, `ownTimerRuns`).
- Produces: `announcementSignals(outcome: 'announcements_queued' | 'announcements_idle' | 'announcements_paused'): LiveMessage[]` → `[{ to: { staff: 'announcements.send' }, type: 'ops.announcements.changed' }]` only for `announcements_queued`.

- [ ] **Step 1: Write the failing tests.**
  - `live-signals.test.mjs`: `a queued batch signals announcement staff; idle and paused do not`.
  - `ops-announcements-api.test.mjs`: `cancelling a sending announcement reaches announcement staff only` → streams for a staff member with `announcements.send` and one without; cancel; only the first gets the signal.
  - `ops-announcements.spec.ts`: `a sending count moves without the 5 s poll while connected` → while one sends, count `/v1/ops/announcements` reads over 30 s: none on a timer; after a worker batch the "x of N" text changes within 5 s. `with the stream refused the sending list reads every 30 s, not 5 s` → abort `/v1/ops/events`; over 70 s no two reads closer than 27 s, and at least 2 reads (Review Focus 3). `with live off the page polls every 5 s while sending` → answer `/v1/ops/me` with `liveUpdates: false` (route fulfil from the real body); reads about 5 s apart.
- [ ] **Step 2: Run, expect FAIL:** worker unit tests, the integration file with `--test-concurrency=1`, and the spec on lane 4.
- [ ] **Step 3: Implement.** Worker: `void publishLive(announcementSignals(outcome))` after `handleAnnouncements`. API: publish after the cancel resolves. Page: `useLiveEvents(['ops.announcements.changed'], load)`; the 5 s interval runs only while `sending && ownTimerRuns(status)`.
- [ ] **Step 4: Run Step 2 again, expect PASS** (spec with `--repeat-each=5 --retries=0 --workers=2`).
- [ ] **Step 5: Commit** `feat(ops): announcements progress live; no 5 s poll while connected`.

### Task 5: Providers

**Files:**

- Modify: `packages/database/src/operations/mail-delivery.ts` (`MailDeliveryDeps.onProviderTestSettled?`)
- Modify: `apps/worker/src/mail-delivery-loop.ts`, `apps/worker/src/job-worker.ts` (~1456–1470: wrap the health `onChange`)
- Modify: `apps/api/src/ops/providers.controller.ts` (after `tests/confirm` ~264 and `mail/:provider/health/clear` ~332)
- Modify: `apps/web/src/app/ops/providers/page.tsx` (~611–632)
- Create: `apps/web/src/lib/provider-deadline.ts`
- Test: `packages/database/test/integration/mail-failover.test.mjs` (it drives `deliverDueMail`; or a new `provider-test-settled.test.mjs` beside it), new `apps/web/test/provider-deadline.test.mjs`, `tests/integration/ops-providers-api.test.mjs`, `tests/e2e/ops-providers.spec.ts`

**Interfaces:**

- Consumes: Tasks 1 and 3.
- Produces:
  - `MailDeliveryDeps.onProviderTestSettled?: () => void`, called after a `provider_test` mail is recorded sent or failed (after its write resolves; a throw is swallowed).
  - `PROVIDERS_CHANGED: LiveMessage = { to: { staff: ['issues.view', 'providers.manage'] }, type: 'ops.providers.changed' }` exported from `apps/worker/src/live-signals.ts` (the API builds the same literal; both are checked by tests).
  - `nextProviderDeadline(providers: OpsMailProviders['providers'], nowMs: number, random: () => number): number | null` → ms until the earliest future `health.until` plus `random() * 5000`, or null when none is in the future.

- [ ] **Step 1: Write the failing tests.**
  - mail delivery integration: `a provider test mail that fails calls onProviderTestSettled once`; `an ordinary mail never calls it`.
  - `provider-deadline.test.mjs`: `the earliest future until wins`; `a past until or no health gives null`; `jitter stays under 5 s`.
  - `ops-providers-api.test.mjs`: `confirming a test reaches providers staff` → streams for `providers.manage`, `issues.view` only, and `announcements.send` only; confirm; the first two get one `ops.providers.changed`, the third none. `clearing a provider's health reaches them too`.
  - `ops-providers.spec.ts`: `a pending test does not poll every 5 s while connected` → start a test; over 30 s, no timed reads of `/v1/ops/providers/mail`; when the pretend mail settles or the test is confirmed in another tab, the card changes within 5 s. `a resting provider re-reads once at its until` → fulfil the first read with `health: { state: 'resting', until: now + 8 s }`; exactly one more read between 8 s and 14 s, none before.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Worker: pass `onProviderTestSettled: () => void publishLive([PROVIDERS_CHANGED])`; wrap the health `onChange` so it publishes `PROVIDERS_CHANGED` after the alert (the alert's failure must not stop the publish). API: publish after both routes. Page: `useLiveEvents(['ops.providers.changed'], refresh)`; the 5 s interval only while `waiting && ownTimerRuns(status)`; otherwise one `setTimeout(refresh, nextProviderDeadline(...))`, re-armed after each read.
- [ ] **Step 4: Run Step 2 again, expect PASS** (spec burn-in as Task 4).
- [ ] **Step 5: Commit** `feat(ops): providers update live; one re-read at a rest's end`.

### Task 6: Update notice listens to the page's streams

**Files:**

- Create: `apps/web/src/lib/live-presence.ts`, `apps/web/src/lib/update-check.ts`
- Modify: `apps/web/src/components/live/live-provider.tsx` (join the registry for `me` and `ops`)
- Modify: `apps/web/src/components/update-notice.tsx`
- Test: new `apps/web/test/live-presence.test.mjs`, new `apps/web/test/update-check.test.mjs`, `tests/e2e/update-notice.spec.ts`

**Interfaces:**

- Consumes: Task 3 (`LiveClient.onReady`).
- Produces:
  - `createLivePresence(): LivePresence` and the page singleton `livePresence`; `LivePresence.join(): { status(s: LiveStatus): void; ready(): void; leave(): void }`, `subscribe(fn: (event: 'status' | 'ready') => void): () => void`, `snapshot(): { streams: number; connected: number }`.
  - `updateCheckEveryMs(s: { streams: number; connected: number }): number | null` → `30 * 60_000` when `streams === 0`, `null` when `connected > 0`, else `5 * 60_000`.
  - `READY_CHECK_GAP_MS = 60_000`: a `ready` checks only if the last check was at least this long ago.

- [ ] **Step 1: Write the failing unit tests.**
  - `update-check.test.mjs`: `public pages check every 30 minutes`, `a connected stream drops the timer`, `a provider without a connected stream keeps 5 minutes`.
  - `live-presence.test.mjs`: `join, status and leave keep the counts`; `ready reaches subscribers`; `a provider that left no longer counts as connected`.
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @tipme/web test`
- [ ] **Step 3: Implement.** The provider joins on mount (whether or not `enabled`, so a dashboard with live off counts as "provider, not connected"), reports every status, calls `ready()` from `client.onReady`, and leaves on unmount. The receipt's stream (Task 7) does not join. The notice keeps its `visibilitychange` check in every mode, re-arms its interval from `updateCheckEveryMs` on each `status` event, and checks on `ready` subject to `READY_CHECK_GAP_MS`.
- [ ] **Step 4: Write the e2e tests** in `update-notice.spec.ts`: `a connected dashboard checks the version on each stream ready, not on a timer` → sign in, count `/api/version` requests; abort the open stream from the server side by routing `/v1/me/events` to close once (then pass through); exactly one more check after the reconnect's ready, and none over the next 6 minutes of `page.clock` time. `a public page checks every 30 minutes` → `page.clock.install()`; on `/`, no check at 5 minutes, one at 30 minutes.
- [ ] **Step 5: Run, expect PASS:** web unit tests; the spec on lane 4 with `--repeat-each=5 --retries=0 --workers=2`.
- [ ] **Step 6: Commit** `feat(web): update notice checks on stream reconnect; public pages every 30 min`.

### Task 7: The tip receipt stream

**Files:**

- Modify: `packages/contracts/src/live.ts` (`LIVE_TIP_TYPES`, `{ tip }` target), `packages/contracts/src/checkout.ts` (`TipStatusView.live?: boolean`)
- Modify: `packages/observability/src/telemetry.ts` (`isLivePath`), `apps/api/src/live/live-gate.middleware.ts`, `deploy/edge/Caddyfile` (both hosts: `/v1/tips/*/events` out of `encode`)
- Modify: `apps/api/src/live/live-router.ts` (`kind: 'tip'`, `tipId`, `byTip`, `maxPerTip`), `apps/api/src/live/live-hub.service.ts`, `apps/api/src/live/live-metrics.ts` (`stream: 'tip'`, close reason `final`)
- Create: `apps/api/src/checkout/receipt-check.service.ts` (the `askBachs` body moved out of `status.controller.ts`), `apps/api/src/checkout/tip-live.controller.ts`
- Modify: `apps/api/src/checkout/status.controller.ts` (use the service; `live` in the view), `apps/api/src/checkout/rate-limit.guard.ts` (`tip_live_connect`, `consumeForTip`), `apps/api/src/checkout/checkout.module.ts`
- Modify: `apps/worker/src/live-signals.ts` (`tip.succeeded`, `tip.failed` also to the tip), `apps/api/src/webhooks/webhook.service.ts` (`signalPending` also to the tip), `packages/database/src/operations/expire.ts` and `apps/worker/src/job-worker.ts` (stale tips' ids → `tip.changed`)
- Create: `apps/web/src/lib/fetch-event-source.ts`, `apps/web/src/lib/tip-live.ts`
- Modify: `apps/web/src/app/tip/[tipId]/status-view.tsx`
- Modify: `docs/security/threat-model.md` (new row)
- Test: `packages/contracts/test/live.test.mjs`, `apps/api/test/live-hub.test.mjs`, `apps/api/test/live-gate.test.mjs`, new `apps/api/test/receipt-check.test.mjs`, `apps/worker/test/live-signals.test.mjs`, new `tests/integration/live-tip-events.test.mjs`, new `apps/web/test/fetch-event-source.test.mjs`, new `apps/web/test/tip-live.test.mjs`, new `tests/e2e/live-receipt.spec.ts`

**Interfaces:**

- Produces (contracts): `LIVE_TIP_TYPES = ['tip.changed'] as const`; `LiveEventType` includes it; `LiveTarget` gains `{ tip: string }` (uuid); `TipStatusView.live?: boolean`.
- Produces (API):
  - `isLivePath(path: string): boolean` → `LIVE_PATHS.has(path) || /^\/v1\/tips\/[^/]+\/events$/.test(path)`; telemetry and the gate use it.
  - `LiveSink.kind: 'me' | 'ops' | 'tip'`, `LiveSink.tipId: string | null`; `LiveRouterOptions.maxPerTip` (3); a `{ tip }` message reaches only `kind: 'tip'` sinks with that id; `{ all: true }`, `{ user }`, `{ profile }` never reach tip sinks.
  - `GET /v1/tips/:tipId/events`: `live_connect` (address) → token check (same 404 as the status route) → `consumeForTip(tipId)` (10 per 900 000 ms, key `rl:{prefix}:tip_live_connect:tip:{tipId}:{window}`, TTL = window) → 204 if the tip is final (`paid`, `declined`, `cancelled`) → `openStream` with `lifetimeMs: 15 * 60_000`, `expiresAt: null`, sink `{ kind: 'tip', tipId, userId: 'tip:' + tipId, profileId: null, permissions: null, recheck: () => Promise.resolve(true) }`.
  - `receiptStreamCheckDelay(elapsedMs: number): number | null` → `4_000` below 2 min, `15_000` below 15 min, else `null`. While a tip stream is open and Bachs is configured, the controller runs `ReceiptCheckService.check(tipId)` on that schedule and closes the stream with reason `final` once the tip reads final.
- Produces (worker): `tip.succeeded` / `tip.failed` map to the existing profile message plus `{ to: { tip: payload.tipId }, type: 'tip.changed' }`; `expireStaleTips` returns `expiredTipIds: string[]` (additive) and the worker publishes one `tip.changed` per id.
- Produces (web):
  - `createFetchEventSource(o: { headers: Record<string, string>; fetch: typeof fetch }): { EventSource: LiveClientDeps['EventSource']; probe(): Promise<LiveProbe> }` → reads `text/event-stream` with `fetch` (`credentials: 'omit'`), emits `onopen`, `onmessage` for `data:` frames, named `hb` events, `onerror` + `readyState` 2 on any non-200 or end; `probe()` answers from the last status seen (204 or 404 → `disabled`, 429/503 → `refused`, else `error`), with no second request.
  - `followTip(o: { tipId: string; token: string; onChange: () => void; onStatus: (s: LiveStatus) => void }): { stop(): void }` in `tip-live.ts` → a `createLiveClient` on `apiUrl('/v1/tips/' + tipId + '/events')` with `timing: { safetyMs: null }`; `onChange` runs on `tip.changed`, `ready` and `resync` only while connected.

- [ ] **Step 1: Write the failing unit tests.**
  - contracts: `a tip target needs a uuid and only tip.changed is a tip type`.
  - `live-hub.test.mjs`: `a tip signal reaches only that tip's streams` (tip A, tip B, a `me` sink of the recipient, an ops sink: only A gets it); `a broadcast never reaches a tip stream`; `a fourth stream for one tip is refused with limit_user`.
  - `live-gate.test.mjs`: `the tip events path is a live path and answers 204 when off`.
  - `receipt-check.test.mjs`: `receiptStreamCheckDelay: 4 s to 2 min, 15 s to 15 min, then null`.
  - `live-signals.test.mjs`: `a paid or failed tip also reaches its receipt`.
  - `fetch-event-source.test.mjs` (fake `fetch` returning a `ReadableStream`): `sends the bearer header and no credentials`; `splits frames across chunks`; `a 404 closes with readyState 2 and probe says disabled`; `a 429 probe says refused`; `hb events reach addEventListener('hb')`.
  - `tip-live.test.mjs`: `while polling, resyncs do not call onChange` (the receipt's own loop runs then).
- [ ] **Step 2: Run, expect FAIL:** contracts, API (after build), worker (after build) and web unit tests.
- [ ] **Step 3: Implement** the contracts, router, gate, metrics, worker mappings and the fetch reader.
- [ ] **Step 4: Write the failing integration tests** in `tests/integration/live-tip-events.test.mjs` (stack with live on; a pretend tip made as `live-events.test.mjs` does; the token from `createStatusToken` with the stack's `STATUS_TOKEN_SECRET`):
  - `no token, a wrong token, tip B's token and a malformed id are all the status route's 404` → status and body equal to `GET /v1/tips/:id/status` with the same header (Review Focus 4).
  - `a pending tip's stream gets ready, then tip.changed when it is paid` → mock webhook pays it; within 5 s one `{"type":"tip.changed"}`; the recipient's `/v1/me/events` gets `tips.changed`, and the tip stream gets nothing else (no `tips.changed`, no `withdrawals.changed` from a broadcast published during the test).
  - `a final tip's stream is 204`.
  - `a stream ends at its lifetime` → with a test-only `LIVE_TIP_LIFETIME_MS: '3000'` API env (add it to `apps/api/src/config.ts`, default 900 000), the stream ends within 5 s (Review Focus 5).
  - `the eleventh connect for one tip within the window is 429, and its Redis key has a TTL` → `redis.ttl(key) > 0`.
  - `tip.changed is the only signal type a tip stream can ever receive` → every frame's `type` is in `['ready','resync','poll','session.ended','tip.changed']`.
  - `with live off, the status view says live false and the events route answers 204`.
- [ ] **Step 5: Run, expect FAIL:** `pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test --test-concurrency=1 tests/integration/live-tip-events.test.mjs`
- [ ] **Step 6: Implement** the service, the controller (document it with `@EventStreamResponse`), the rate limit, `live` in the status view, the webhook and stale-tip publishes, and the Caddyfile matcher (check with `docker run --rm -v "$PWD/deploy/edge:/etc/caddy" caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile`). Add the threat-model row "Public tip stream leaks or is abused" with the addendum §3.6 mitigations and these test files.
- [ ] **Step 7: Run Steps 2 and 5 again, plus** `tests/integration/live-events.test.mjs` and `node --test scripts/generate-docs.test.mjs`; expect PASS.
- [ ] **Step 8: Wire the receipt.** In `status-view.tsx`: after the first read, if `result.data.live === true` and the tip is not final, `followTip(...)`; while its status is `connected`, no `setTimeout` poll runs and each `onChange` does one `tipStatus` read; in every other status the existing `nextCheckDelay` loop runs unchanged. Stop the follower on a final state, on 404, on unmount, and 15 minutes after the round started (then `setStopped(true)`, as today). "Check again" starts a new round of both.
- [ ] **Step 9: Write the e2e tests** in `tests/e2e/live-receipt.spec.ts`: `a receipt turns paid without polling while connected` → tip as a visitor with a delayed-confirm scenario; count `/v1/tips/*/status` reads: after the stream's ready, none until the tip is paid, then one; the paid receipt shows within 5 s of the webhook. `the receipt polls as today when the stream is refused` → abort `**/v1/tips/*/events`; reads follow `nextCheckDelay` (≥ 10 reads in the first 12 s). `the token never appears in a request URL` → no request URL contains the token.
- [ ] **Step 10: Run, expect PASS** (lane 4, `--repeat-each=5 --retries=0 --workers=2`), and `tests/e2e/receipt-blend.spec.ts` once.
- [ ] **Step 11: Commit** `feat(live): one-tip receipt stream with the status token`. Note in the PR body the staging check: `curl -N -H "Authorization: Bearer <token>" https://<staging-api>/v1/tips/<id>/events` prints `: hb` within 21 s.

### Task 8: Pro purchase "confirming" in Settings

**Files:**

- Modify: `packages/contracts/src/live.ts` (`'pro.changed'` in `LIVE_RECIPIENT_TYPES`)
- Modify: `apps/api/src/webhooks/webhook.service.ts` (`signalPurchase` beside `signalPlan`, ~97–180)
- Modify: the operations `confirmProCheckout`, `reconcileProPurchases`, `reconcileProCollections` return `settled: Array<{ profileId: string | null }>` (additive; find their files with `grep -rln "export async function reconcileProPurchases" packages/database/src`)
- Modify: `apps/worker/src/job-worker.ts` (`announce`, ~602, and the collections read-back)
- Modify: `apps/web/src/app/dashboard/settings/sections/plan.tsx` (`useReturnedPurchase`, ~48–105)
- Test: `packages/contracts/test/live.test.mjs`, the Pro integration tests that cover each operation (`grep -rln "reconcileProPurchases\|confirmProCheckout" packages/database/test tests/integration`), `tests/e2e/pro-buy.spec.ts`

**Interfaces:**

- Consumes: base design dashboard provider; Task 3 (`ownTimerRuns` not needed: the slip uses `useLiveStatus() === 'connected'`).
- Produces: `{ to: { profile }, type: 'pro.changed' }` published once per purchase that left `PENDING`, `COLLECTING` or `UNKNOWN` (any outcome), for a purchase with a page (`profileId !== null`); `profile.changed` unchanged.

- [ ] **Step 1: Write the failing tests.**
  - contracts: `pro.changed is a recipient type`.
  - integration (webhook path, via the mock `mock_pro_` reference): `a failed Pro payment reaches the buyer's stream as pro.changed` → buyer's `/v1/me/events` gets `pro.changed` and no `profile.changed`; `a paid Pro payment sends pro.changed and profile.changed`; `another person's stream gets neither`.
  - integration (worker reconcile): `a purchase the read-back expires sends pro.changed`.
  - `pro-buy.spec.ts`: `confirming turns paid without polling while connected` → hold the mock confirm; count `/v1/me/pro/purchases/*` reads after the stream's ready: none until the webhook, then one; the paid slip shows within 5 s. `with the stream refused, confirming polls as today` → abort `/v1/me/events`; reads follow `nextCheckDelay`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the additive `settled` returns, the publishes after each commit, and the slip: `useLiveEvents(['pro.changed', 'profile.changed'], checkOnce)` while following; the `nextCheckDelay` timer runs only while `useLiveStatus() !== 'connected'`. Keep the same 15-minute give-up.
- [ ] **Step 4: Run Step 2 again, expect PASS** (spec burn-in on lane 4), and `pnpm --filter @tipme/web test && pnpm --filter @tipme/web typecheck`.
- [ ] **Step 5: Commit** `feat(pro): Settings confirming follows pro.changed; polling as fallback`.

---

## Self-review

1. **Spec coverage.** Addendum §3.1 → Tasks 1–3; §3.2 → Task 4; §3.3 → Task 5; §3.4 → Task 3 (`OPS_LIVE_TIMING`, `ownTimerRuns`) and Tasks 4–5 tests; §3.5 → Task 6; §3.6 (stream, limits, token, isolation, partner checks, threat model) → Task 7; §3.7 → Task 8; §4 table → Tasks 1, 2, 4, 5, 7, 8. Live-off parity: Task 3 (`opsLiveEnabled`), Task 4 (5 s with live off), Task 7 (`live: false`, 204), Task 6 (provider with live off keeps 5 min). The countdown is untouched.
2. **Step scan.** Each test step names its tests and assertions; code steps give signatures and the values the addendum pins (30 s ± 3 s, 15 min, 10 per 15 min, 3 per tip, 4 s / 15 s, 60 s gap, 30 min).
3. **Type consistency.** `LiveStaffPermission`, `OPS_LIVE_TIMING`, `ownTimerRuns`, `onReady`, `PROVIDERS_CHANGED`, `followTip`, `createFetchEventSource`, `receiptStreamCheckDelay`, `isLivePath` are each defined once and used with the same names later.
4. **Review Focus.** Each of the five has its test: 1 and 2 in Task 1 Step 4; 3 in Task 4 Step 1; 4 and 5 in Task 7 Step 4.
5. **Proportion.** About 330 lines against a 150-line addendum and a 580-line base design it builds on; no function bodies beyond signatures.
