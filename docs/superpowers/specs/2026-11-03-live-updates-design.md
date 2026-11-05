# Live updates without a refresh: design

Date: 3 November 2026. Status: PROPOSED (design only; nothing here is built or approved).

The owner asked (3 Nov 2026): "Can we work on the ui auto updating without a refresh on actions e.g you get tipped, you balance increases without you having to refresh the ui, you see the latest tip, you get pro and it instantly shows on you ui without you having to refresh etc? Do you have other places we would need this?"

This spec answers both questions. It changes no money rules and decides nothing listed under VALIDATE in `docs/00-DECISIONS.md`. It works the same with pretend money and with live money, because it only tells the browser to re-read what the API already serves.

## 1. Intent

### Goals

- A signed-in recipient's open dashboard shows a new paid tip, the new balance, a changed withdrawal, a change of plan and the other changes in section 5, within about 2 seconds of the change being committed, with no reload.
- A second member of staff sees a new approval request, and staff see new issues, without reloading.
- When the live channel is unavailable, the page still catches up within about 20 seconds, and says when its figures were last updated if it can't.

### Non-goals

- Pushing data. The channel carries change signals only. Every figure on screen still comes from the existing authorised `GET` endpoints.
- Live public profile pages, or a live tip receipt (section 5.3 explains why).
- Phone push, browser notifications, sound or email. Messaging providers are D-11.
- Multi-tab connection sharing. Each tab has its own connection in this version.
- Any change to the database schema. Every change here is additive code.

### Anti-goals (never do these)

- **Never show stale figures as fresh.** If the page can't confirm its figures, it keeps the last ones and says when they were read ("Updated 14:02").
- **Never let money perform.** A balance changes in one frame from the old value to the new one. It never counts, rolls or fills (`docs/design/EXPERIENCE-AND-MOTION.md` "Money never performs").
- **Never celebrate before the API confirms.** A signal is not a confirmation. Only a tip the API returns as `paid` gets the arrival treatment. A tip that is still being confirmed appears quietly in the "still being confirmed" figure.
- **Never animate under reduced motion.** People who ask for reduced motion get the same final screen at once.
- **Never leak anything across users.** A signal reaches only the streams of the user it is about, and it says nothing beyond its type.

## 2. Architecture

```
 tx commits ─► outbox row ─► worker relay ─► queue.add ─┐
                                                         ├─► PUBLISH {QUEUE_PREFIX}:live:v1  (Redis)
 worker job handler finishes (after its commit) ─────────┤            │
 API route's write resolves (after its commit) ──────────┘            ▼
                                     every API copy: one subscriber ─► in-process hub
                                                                       │ (by user, profile, session, staff)
 browser tab ◄── text/event-stream ── GET /v1/me/events ◄──────────────┘
      └─► on a signal: apiFetch the affected endpoints (unchanged, authorised as today)
```

### 2.1 The endpoints

- `GET /v1/me/events`: the recipient's stream. Guarded by the existing `SessionGuard` (`apps/api/src/auth/session.guard.ts`).
- `GET /v1/ops/events`: the staff stream. Guarded by `OpsGuard` with `@OpsAnyStaff()` (`apps/api/src/ops/ops.guard.ts`). It sends each staff stream only the signals its grant's permissions allow (section 4).

Both live in a new `apps/api/src/live/` module:

- `live.controller.ts`: the two routes.
- `live-hub.service.ts`: the in-process registry of open streams, and the one Redis subscriber.
- `live-publisher.ts`: the publish helper used by API routes.

Both paths already sit under the credentialed CORS prefixes in `apps/api/src/app.factory.ts` (`/v1/me/`, `/v1/ops/`). They must appear in the OpenAPI document like every other route, because `scripts/generate-docs.test.mjs` checks every route.

**The response:**

- Status 200 with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`. The last is harmless under Caddy and protects against an nginx placed in front later.
- Headers are flushed at once. The socket gets `setTimeout(0)`, `setNoDelay(true)` and `setKeepAlive(true)`.
- First comes `retry: 5000`. Then, once the stream is registered with the hub, comes `data: {"type":"ready"}`.
- After that come signals as `data: {"type":"tips.changed"}`, unnamed and with no `id:` field.
- A heartbeat comment `: hb` follows every 20 seconds.

Node's `server.requestTimeout` and `headersTimeout` (10 s, `app.factory.ts`) bound receiving the request, not sending the response. So a long response is allowed. The integration test in section 9 must still prove that a stream outlives 10 s before anything else is built on it.

**Turned off.** While `LIVE_UPDATES_ENABLED` is false, both routes answer **204 No Content**. By the EventSource standard, a browser does not reconnect after a 204, so the page behaves exactly as it does today (section 10).

### 2.2 Authentication and CORS

This was verified in the code:

- The dashboard calls the API origin directly from the browser with `fetch(..., { credentials: 'include' })` (`apps/web/src/lib/session-client.ts`).
- The session is the `tipme_session` cookie: HttpOnly, SameSite=Lax, Secure except on local HTTP (`apps/api/src/auth/cookies.ts`).
- Staff also carry `tipme_ops`.
- CORS allows only `WEB_ORIGIN`, with credentials, for those prefixes.

The browser opens `new EventSource(apiUrl('/v1/me/events'), { withCredentials: true })`.

- **No preflight.** EventSource sends a simple `GET` with credentials and no custom headers. The CSRF guard passes `GET` (`csrf.guard.ts`: "GET requests never change anything").
- **Staging.** The preview cookie travels the same way, and preview mode already makes every path credentialed.
- **Each connect authenticates again,** the same way as any request. A reconnect is a new request.

On connect the route makes two queries: `resolveSession` (in the guard) and `myProfileId` (to index the stream by profile as well as user). It then releases the pool connection. A stream never holds a database connection.

### 2.3 Content-Security-Policy

`apps/web/next.config.ts:41` sends `connect-src 'self' ${apiUrl.origin}`, and `connect-src` governs EventSource. This was verified, and no change is needed. The web app on Vercel never proxies the stream: the browser connects to `NEXT_PUBLIC_API_ORIGIN` directly. That matters because a Vercel function can't hold a stream open for long.

### 2.4 Heartbeats and lifetime

- **Heartbeats.** The server sends `: hb` every 20 s. The client runs a watchdog on `performance.now()`. If nothing arrives (a signal, `ready` or a heartbeat) for 50 s, it closes the stream and reconnects.
- **Most streams close after 30 minutes.** The server closes each stream after 30 minutes plus or minus up to 3 minutes of jitter. A stream also closes at its session's `expiresAt` (or, for staff, the ops grant's), if that comes sooner.
  - The reconnect authenticates again, so a stream can never outlive its session by more than the time to the next close.
  - The cap also bounds how long a Caddy config reload keeps old connections.

### 2.5 Reconnecting: resync, not replay (decision)

On every (re)connect, the client waits for `ready` and then refetches every part of the page that has registered (a **resync**). There is no `Last-Event-ID` and no replay buffer. The reasons:

- **A replay holds nothing worth replaying.** Signals carry no data, so a replay could only say "something changed". A refetch says what is true now, which is better.
- **A replay needs storage and ordering.** That would mean a per-user log in Redis, and ordering across six API copies, all to save a handful of cheap reads.
- **The order is safe.** The resync starts after `ready`, and `ready` is sent only once the stream is subscribed. So nothing committed after the resync's reads began can be missed.

The cost is a burst of reads on every deploy, because every tab reconnects. This is spread out:

- the draining API sends each stream `retry: <random 1,000–10,000>` before closing it;
- the client adds its own jitter.

A per-user sequence counter, which would let a reconnect skip the resync when nothing changed, is a later optimisation. It is not built now.

### 2.6 Fan-out and the pub/sub channel

All signals use one Redis channel per environment: **`${QUEUE_PREFIX}:live:v1`**. `QUEUE_PREFIX` is already in both the API and worker config (`apps/api/src/config.ts:64`, `apps/worker/src/config.ts:35`; production `tipme`). Each Compose project also has its own Redis.

A message on the channel is JSON, validated with a zod schema in `packages/contracts/src/live.ts`:

```json
{"to":{"user":"<uuid>"},"type":"profile.changed"}
{"to":{"profile":"<uuid>"},"type":"tips.changed"}
{"to":{"all":true},"type":"withdrawals.changed"}
{"to":{"staff":"issues.view"},"type":"ops.issues.changed"}
```

**`to` is the routing key, and it never leaves the server.** The hub writes only `{"type": ...}` to a browser. It drops a message it can't parse, and counts it.

**One subscriber per API process.** Each process holds one dedicated ioredis subscriber connection. ioredis needs a separate connection in subscribe mode, and it resubscribes on its own after a reconnect. The subscriber dispatches to in-memory maps:

- user id to streams;
- profile id to streams;
- staff streams.

**Why one channel rather than a channel per user:**

- At TipMe's rate (a few signals a second at most), sending every signal to every API copy costs nothing.
- It avoids one `SUBSCRIBE` per connection.
- Revisit it above about 200 signals a second.

Postgres `LISTEN/NOTIFY` is rejected, because it would hold a pooled connection per process.

**The hub coalesces.** It merges repeats of the same type to the same stream within 250 ms, so a burst of tips is one signal per stream.

### 2.7 Publishing only after the commit

There is one publish helper per app (about 20 lines each, over the app's existing ioredis client). It takes `{ to, type }`, sends `PUBLISH`, and never throws:

- a failure is logged as `live.publish_failed` and counted;
- it is never awaited inside a database transaction;
- it never fails or retries the work that raised it;
- the API's client has no offline queue (`createRedis`), so while Redis is down a publish fails at once rather than piling up.

There are three kinds of publish point, all **after** the commit:

1. **The outbox relay** (`apps/worker/src/outbox-relay-loop.ts`).
   - An outbox row is visible only once the transaction that wrote it has committed, so the tip, ledger and payout state it describes is already readable.
   - The relay collects the relayed rows in its `publish` callback and publishes their signals **after `relayOutboxOnce` resolves**. That is after the claim transaction commits, so a failed queue add never signals.
   - A row republished after a crash gives a duplicate signal, which is harmless.
   - The mapping from event type to signal is a pure function, `liveSignalFor(eventType, payload)`, in `apps/worker/src/live-signals.ts`.
2. **Job handlers** (`apps/worker/src/job-worker.ts`). A handler that commits its own writes (notifications, moments, reports, payout start, issues) publishes after its handler returns successfully.
3. **API routes.** A route that commits directly publishes after its database call resolves, at the same place most of them already call `ProfileRevalidator.revalidate` (`apps/api/src/profiles/revalidate.ts`).

## 3. Infrastructure

### 3.1 Where the API runs

Production and staging share one VPS (`docs/runbooks/production.md`):

- Production has two API colours, blue and green, with three copies each and one colour serving at a time. There are also two workers and Redis. Postgres is on Aiven.
- The one edge Caddy (`caddy:2.10.2-alpine`, `deploy/edge/Caddyfile`) owns ports 80 and 443. It round-robins to ready copies.

**Changes to `deploy/edge/Caddyfile`** (both API hosts):

- **Take the stream paths out of `encode`.** Compression would hold bytes back and mark the stream as compressed:

  ```
  @compressible not path /v1/me/events /v1/ops/events
  encode @compressible zstd gzip
  ```

- **Flushing.** Caddy's `reverse_proxy` flushes `text/event-stream` responses at once without being configured to. Don't set `flush_interval` for the whole host. Prove it on staging instead: `curl -N` through the edge must print the first `: hb` within 21 s.
- **Read timeouts.** Caddy sets no response timeout by default, so none is added. The 20 s heartbeat keeps intermediaries from closing an idle connection.
- **HTTP/2.** Caddy serves HTTP/2 and HTTP/3 to browsers by default, so many tabs share one connection. Under HTTP/1.1, a browser allows only 6 connections per origin, shared with the dashboard's API reads. That is why the per-user cap and the hidden-tab close (section 6.2) matter.
- **Active health checks don't change.** The stream routes are ordinary requests to them.

**Draining (`apps/api/src/shutdown.ts`).** When `readiness.startDraining()` runs, the hub must:

1. refuse new streams with 503;
2. send every open stream a jittered `retry:` and close it.

Without this, `closeIdleConnections` never closes a stream, and every stop waits out the 10 s close deadline and then cuts connections abruptly. The closed tabs reconnect through the edge to a ready copy, or to the new colour.

### 3.2 Connection limits

| Limit                                      | Value                                                                                                | When exceeded                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Streams per user per API process           | 8                                                                                                    | 429 `LIVE_LIMIT`; that tab falls back to polling |
| Streams per API process                    | 2,000 (`LIVE_MAX_STREAMS`)                                                                           | 503 with `Retry-After: 30`; the client polls     |
| Connects per user per minute               | 30, fixed window in Redis, via the existing `RateLimitGuard` per-user subject (like the bank routes) | 429; the client backs off                        |
| Unauthenticated connects per IP per minute | 60                                                                                                   | 429                                              |

The rate limiter fails open when Redis errors, as it already does (threat model X5). A process holding 2,000 idle streams uses tens of megabytes. Each stream is a socket, a timer slot and a map entry.

### 3.3 Redis and Postgres budgets

- **Redis.** Each API process opens one more connection, its subscriber: 7 in all, 6 for production and 1 for staging. Redis gains no new keys beyond the rate-limit windows, so its memory is unaffected.
- **Postgres: no change.** A connect costs two short queries on the existing pool, released at once. A stream holds no connection. Mid-stream, the only queries are the session re-checks after `sessions.changed`, which is rare. `packages/database/src/connection-budget.ts` (weights and bounds) and `DATABASE_BUDGET_API_PROCESSES` stay as they are. `tests/integration/connection-budget.test.mjs` should gain one assertion: the pool's idle count returns to its value before the connect while a stream stays open.

### 3.4 Vercel

The web app never holds a stream. Nothing changes in its configuration or environment variables.

## 4. The event catalogue

Events name what changed, not what to show. Plan changes travel as `profile.changed`, because the plan is part of `MyProfile`. Balance changes travel as `tips.changed` or `withdrawals.changed`, which both refetch the summary. The client maps each type to the endpoints it refetches.

### 4.1 Recipient stream

**`tips.changed`** (to profile)

- Raised by:
  - the relay for `tip.succeeded` and `tip.failed` (written by `provider-events.ts` in the same transaction as the tip, the attempt and the ledger);
  - `webhooks/webhook.service.ts` `apply` and `applyBachs`, after a provider event moves a tip to `PENDING_VERIFICATION` (shown as "still being confirmed"). The operation must return the tip's profile id; this is an additive change.
  - Tips cancelled by expiry are not signalled. The fallback catches them.
- Refetches:
  - `/v1/me/dashboard` (balance, confirming, tiles, trend);
  - `/v1/me/activity`;
  - on Tips, the first page of `/v1/me/tips` with the current filter;
  - an open `/v1/me/tips/:id`.

**`notifications.changed`** (to profile)

- Raised by:
  - `job-worker.ts` after `handleDomainEvent` returns for `tip.succeeded`, which is when `notifyTipSucceeded` has committed;
  - after `WEEKLY_REPORTS_JOB`.
- Refetches `/v1/me/notifications?unreadOnly=1` (the bell).

**`moments.changed`** (to profile)

- Raised by the same `tip.succeeded` handler, after `evaluateTipMoments`. The monthly moments job is not signalled; its moments show on the next load or resync.
- Refetches `/v1/me/moments`.

**`withdrawals.changed`** (to profile)

- Raised by:
  - the relay for `payout.paid` and `payout.failed` (`payouts.ts`), and for `WITHDRAWAL_FREEZE_OPENED_EVENT` and `ops.freeze_released`;
  - `PAYOUT_START_EVENT` after `handlePayoutStart` returns (requested to processing);
  - the withdrawal request route in `apps/api/src/dashboard/dashboard.controller.ts` (for the user's other tabs);
  - `ops/pages.controller.ts` after `freezeWithdrawals`.
- Refetches `/v1/me/dashboard`, `/v1/me/withdrawals` and `/v1/me/withdrawal-quote`.

**`withdrawals.changed`** (to all)

- Raised by the relay for `WITHDRAWALS_SWITCH_EVENT` (`withdrawals-switch.ts`). This is the TipMe-wide switch.
- Refetches the same endpoints. Each client waits a random 0–10 s first.

**`payments.changed`** (to profile)

- Raised by:
  - `webhooks/webhook.service.ts` `refreshBachsAccount`;
  - `profiles/payment-accounts.controller.ts` after `updatePaymentAccountStatus`;
  - `PAYOUT_SETUP_JOB`, for the accounts whose status changed. The job's result must list their profile ids; this is an additive change.
- Refetches `/v1/me/payment-account`, which feeds the shell's `refreshAttention` and `payment-account-card.tsx`.

**`profile.changed`** (to user)

- Raised by:
  - `ops/pages.controller.ts` after `setPagePlan` (Pro on or off) and `grantHandleChanges`;
  - `ops/actions.controller.ts` after `setPageSuspension` (paused or restored);
  - `profiles/me-profile.controller.ts` after `updateMyProfile`, `renameHandle`, `setTipAmounts` and `setPageState`;
  - the cover and photo routes;
  - later, the username take-back's state changes.
- Refetches `/v1/me/profile` (the shell's `setProfile`). Pages built on the profile then refetch their own data: the QR studio refetches `/v1/me/qr-art`, and Settings refetches tip amounts.

**`reports.changed`** (to profile)

- Raised after `WEEKLY_REPORTS_JOB`, for each profile that `runWeeklyReports` created a report for. It must return those ids beside `created`; this is an additive change.
- Refetches `/v1/me/reports`.

**`account.changed`** (to user)

- Raised by the recovery email, notification preferences and email routes in the `/v1/me/*` controllers.
- On Settings, refetches `/v1/me/recovery-email`, `/v1/me/notification-preferences` and `/v1/me/sessions`. The bell and shell refetch `/v1/me/recovery-email`.

**`sessions.changed`** (to user)

- Raised by:
  - `auth/auth.controller.ts` after `revokeSession` and `revokeAllSessions`, and on sign-out;
  - `ops/account-recovery.controller.ts` after `endAccountSessions`;
  - account deletion.
- This one is handled on the server and is never forwarded. Each of that user's streams runs `resolveSession` again on its own cookie. A stream whose session is gone receives `{"type":"session.ended"}` and is closed. The client then calls `apiFetch('/v1/me/profile')`, gets a 401, and the shell's existing redirect to sign-in runs.

### 4.2 Staff stream

**`ops.approvals.changed`** (to staff, any)

- Raised by:
  - the relay for `ops.approval_pending`, `ops.approval_ran` and `ops.approval_closed` (`serious-actions.ts`);
  - `ops/approvals.controller.ts` after a decision.
- Refetches `/v1/ops/approvals`, and the Overview's approvals count.

**`ops.issues.changed`** (to staff with `issues.view`)

- Raised by:
  - the worker, after `openIssueFromEvent` returns `opened`;
  - `RECONCILE_JOB`, when `runIssueDetectors` opened issues or `autoResolveIssues` resolved some;
  - `ops/issues.controller.ts` after a resolve.
- Refetches `/v1/ops/issues` with the current filters.

When staff change (`ops.staff_changed`, `ops.last_approver_removed`) or `revokeOpsGrants` runs, every staff stream checks its grant again and closes if the grant is gone.

### 4.3 Control messages (server to browser)

| Message         | Meaning                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| `ready`         | The stream is subscribed: resync now.                                               |
| `resync`        | This API copy's subscriber was down and is back: resync, after a random 0–5 s wait. |
| `poll`          | This copy can't hear signals (Redis down): use the fallback poll until `resync`.    |
| `session.ended` | The session is gone: the stream closes.                                             |

## 5. Places, verified against the code

### 5.1 Dashboard

1. **A new paid tip.**
   - What updates: the balance and "still being confirmed" figure, the tiles and trend, the latest tips, the Tips page, an open tip detail and moments.
   - Source: `home-view.tsx`, which today loads once with `Promise.all`; `tips-view.tsx`; `moments.tsx`.
   - Events: `tips.changed` and `moments.changed`.
2. **The notification bell.**
   - Source: `notification-bell.tsx`, which polls every 10 s while visible.
   - Change: while the stream is connected, the 10 s poll stops and the bell refetches on `notifications.changed`. Its toast stays the one announcement of a new tip (section 7).
3. **Plan to Pro or back to Free.** This covers QR designs, handle changes and the allowance, the page's own amounts, and the Pro badge and footer-link state shown in the dashboard. Event: `profile.changed` from `setPagePlan` and `grantHandleChanges`.
4. **A withdrawal changing status:** requested, then processing, then paid or failed, with the balance. Paid is a quiet colour and label change. Failed is calm and says the money is back (EXPERIENCE §7.5). Event: `withdrawals.changed`.
5. **The payout account's verification status.** Event: `payments.changed`. This also clears or adds the shell's "needs your attention" notice and the nav dot.
6. **Withdrawals paused or resumed by TipMe.** This covers the TipMe-wide switch (to all) and a takeover freeze on one page. Event: `withdrawals.changed`.
7. **The page paused or restored by staff.** The shell's "TipMe has paused your page" notice comes from `MyProfile.suspended`. Event: `profile.changed`.
8. **A weekly report being ready.** Events: `reports.changed`, plus `notifications.changed` for its notice.
9. **The username take-back banner.** This is a future feature (`.worktrees/username-reservation/docs/superpowers/specs/2026-11-03-username-reservation-design.md` §5).
   - The banner comes from the planned `MyProfile.usernameTakeBack`, so it arrives with `profile.changed`.
   - The clock that starts when the banner is first seen must be started by a render **while the tab is visible** (a `visibilitychange` or IntersectionObserver check before the "seen" call). It must never start because a hidden tab refetched. Otherwise a background tab would start someone's 7-day clock without them seeing it.
10. **The same user's other tabs and devices.** This covers settings, cover, photo, handle, tip amounts, page state, recovery email and preferences. Events: `profile.changed` and `account.changed`.
11. **Added: a session ended elsewhere.** "Sign out other devices", a single revoke, or staff ending sessions in account recovery. The stream closes and the tab goes to sign-in (`sessions.changed`).

### 5.2 Admin

12. **The approvals queue** (`apps/web/src/app/ops/approvals/page.tsx`, which doesn't poll today). Event: `ops.approvals.changed`. A second approver sees a request within about 2 s.
13. **Issues** (`apps/web/src/app/ops/issues/page.tsx`, which polls every 30 s). Event: `ops.issues.changed`. The 30 s poll becomes the fallback.
    - **Providers** (`ops/providers/page.tsx`) is **left as it is**. It polls every 5 s only while a mail test is pending, which is short and local to one staff action.

### 5.3 Visitors

14. **The tip receipt** (`apps/web/src/app/tip/[tipId]/status-view.tsx`, `apps/web/src/lib/status-polling.ts`). **Keep polling.**
    - The supporter is a guest with no session. A stream would need a new unauthenticated surface keyed by a per-tip token.
    - The poll is already bounded: every 1 s at first, easing to 15 s, and stopping after 15 minutes.
    - The wait is dominated by the provider's confirmation, not by the poll.
15. **An open public page when the plan or accepting-tips changes. Not live.**
    - **Cost:** visitors are anonymous and many, so a stream per visitor would cost far more than every dashboard together.
    - **New loads are already fresh:** tag revalidation (`apps/api/src/profiles/revalidate.ts`, `apps/web/src/app/api/revalidate/route.ts`) refreshes them within seconds.
    - **A stale open page is safe:** the server decides at checkout. `packages/database/src/operations/quotes.ts` refuses pages that are hidden, suspended or not live, and enforces the page's current minimum and amounts "whatever the page showed". At worst the visitor sees a refusal and reloads; they are never charged wrongly.

**Not on dev:** the update notice that checks `/api/version` every 5 minutes (`apps/web/src/components/update-notice.tsx`) exists only on the screen-redesign branch. It is about web deployments on Vercel, which the API doesn't know about, so it stays a separate poll.

## 6. The client

### 6.1 Where it lives

- **`apps/web/src/lib/live-client.ts`.** A framework-free state machine:
  - it connects, waits for `ready`, runs the watchdog, backs off, falls back to polling, and handles visibility;
  - it is given an EventSource constructor, timers, the clock and visibility, so it can be unit-tested.
- **`apps/web/src/components/live/live-provider.tsx`.** A React context that owns one live client per tab. It is mounted:
  - in `DashboardShell` (`apps/web/src/app/dashboard/dashboard-shell.tsx`), once the profile has loaded;
  - in the ops shell (`apps/web/src/app/ops/ops-shell.tsx`), for `/v1/ops/events`.
- **`useLiveRefresh(types, refetch)`.** A hook. A component registers a refetch function for the event types it cares about, for example `useLiveRefresh(['tips.changed', 'withdrawals.changed'], reloadSummary)`.
  - The provider debounces each refetch by 300 ms and runs it single-flight: a signal during a refetch runs one more after it.
  - The same registered refetches are what a resync and the fallback poll call.

### 6.2 Connection behaviour

- **Reconnecting.** After an error the client closes the EventSource itself and reconnects with full-jitter backoff (1, 2, 4, 8 … up to 60 s), rather than leaving it to the browser. This lets it pause and decide when to fall back.
- **Detecting a signed-out user.** EventSource can't read a status code. So after 2 failed connects in a row, the client probes `apiFetch('/v1/me/profile')`, and a 401 hands over to the shell's existing sign-in redirect.
- **Fallback poll.** The client switches to it after 3 failed connects in a row, on a `poll` message, or on a 429 or 503 refusal (seen through the probe). It runs every registered refetch every 20 s, plus or minus 2 s, while the tab is visible. It keeps trying the stream every 60 s.
- **A buffering proxy.** If the stream opens but `ready` doesn't arrive within 10 s, the client treats the stream as buffered. It polls, and tries the stream again after 5 minutes.
- **A hidden tab.** Polling pauses at once. The stream stays open for up to 5 minutes and then closes. When the tab becomes visible again, the client reconnects, which resyncs, or refreshes once if it is polling. The `online` event does the same.
- **Safety refresh.** While connected and visible, the client runs one full refetch every 5 minutes. This bounds how long a silently lost signal can leave the page wrong.
- **Turned off.** A 204 (live updates off) ends live behaviour for that page load. The bell keeps its own 10 s poll and nothing else polls, exactly as today.

### 6.3 Merging a refetch

- **The signal is never data.** Nothing on screen is changed by a signal itself. Every change comes from what the API returned.
- **Summary.** The new summary replaces the old in one render.
  - When `availableMinor` rises after `tips.changed`, the balance gets the soft 1 s highlight behind it (EXPERIENCE §7.4). The number itself never moves or counts.
  - A fall (a withdrawal) gets no highlight.
- **Lists** (activity, tips, withdrawals, approvals, issues). Rows are keyed by their id.
  - **New rows.** A row whose id wasn't in the list before is new. If it is a `paid` tip, it slides down from above once in 240 ms, and the rows below follow with `transform` only. Rows tipped together arrive as one change.
  - **Changed rows** (for example confirming to paid) update in place with no motion. A newly confirmed note gets the same soft highlight.
  - **A reader further down isn't moved.** Browser scroll anchoring (`overflow-anchor`, the default) keeps them in place. Nothing scrolls the page. Focus stays on the row it was on, because keys are stable.
  - **The Tips page.** Only the first page is refetched, and only with no cursor beyond it. A recipient deep in the list or in a search gets a "New tips: show" button instead of rows inserted under them.
- **Forms are never overwritten.** If Settings or the QR studio receives `profile.changed` while a field is edited and not saved, the form keeps the person's input. It shows a notice: "This changed on another device." with a "Show the latest" button. Fields that aren't edited update.
- **A failed refresh** keeps the last figures and shows a plain note, "Updated 14:02", taken from the browser's clock at the last successful read. A first-load failure keeps today's error notice.

## 7. Accessibility and motion

- **No celebration before confirmation.**
  - A signal triggers only a read.
  - The arrival treatment (slide-in and highlight) applies only to rows the API returns as `paid`.
  - Pending and confirming tips appear without motion.
  - Withdrawals never celebrate.
- **Reduced motion** (`prefers-reduced-motion: reduce`). Rows appear in place at once, and the balance highlight is a static background for 1 s with no transition. The constitution allows opacity changes of 150 ms or less. A test asserts that the new row has no running animations.
- **Forced colours** (`@media (forced-colors: active)`). The highlight's background disappears, so it becomes a 2 px `Highlight`-coloured outline. Words, not colour, carry meaning: the toast and the row's own text.
- **One polite announcement, at most once a minute** (the rule in `docs/design/DECISION-LOG.md` and EXPERIENCE §7.4).
  - The bell's existing `role="status"` toast is the only announcer: "You got a tip · ₦4,500 from Chidi", built from the notification's `title` and `body` in `notifications.ts`. Its amount is the recipient's net, the figure the list shows.
  - When more arrive within the minute, the next announcement is a count: "3 new tips".
  - **What is safe to say:** the amount the recipient receives and the supporter's own chosen label, or "a guest", which already show on screen. The tip's note or message is never announced, and neither is anything about withdrawals beyond the on-screen status words.
  - Panels add no live regions of their own, so nothing is announced twice.
  - Errors that block an action stay assertive.
- **Focus** is never moved by an update.

## 8. Failure modes

| Failure                                                                           | What happens                                                                                                                                                                                                                                                     | What the person sees                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Redis down**                                                                    | Publishes fail, logged and counted, and the money path carries on. Each API copy's subscriber drops, and it sends `poll` to its streams. When the subscriber comes back, it sends `resync`. New connects get `ready` then `poll`.                                | Updates within about 20 s through polling. Nothing wrong is shown.   |
| **API restart or deploy**                                                         | The draining copy refuses new streams and closes open ones with a jittered `retry`. Clients reconnect to a ready copy and resync.                                                                                                                                | Nothing, beyond a resync.                                            |
| **A user with many tabs**                                                         | One stream per tab, up to 8 per user per copy. Beyond that the tab polls at 20 s. Hidden tabs close their streams after 5 minutes.                                                                                                                               | Every tab stays correct. Extra tabs are up to 20 s slower.           |
| **A sleeping laptop**                                                             | Timers stall, and the socket is often dead without an error. On wake, the watchdog (50 s without a message), `visibilitychange` or `online` reconnects, and the client resyncs.                                                                                  | Fresh figures within seconds of waking.                              |
| **A proxy that buffers**                                                          | `ready` never arrives within 10 s, so the client polls and tries the stream again in 5 minutes.                                                                                                                                                                  | Updates within about 20 s.                                           |
| **A dropped signal** (a publish failed, or a subscriber blinked between messages) | It is caught by the next resync, the 5-minute safety refresh while connected, the refresh when the tab becomes visible, or the 20 s poll while degraded.                                                                                                         | At worst a few minutes late. Never wrong: the figures are the API's. |
| **Clock skew**                                                                    | Signals carry no timestamps, and the client never compares its clock with the server's. Stream lifetime and session expiry are judged on the server's clock. The watchdog uses `performance.now()`. "Updated 14:02" is the browser's own clock at its last read. | Nothing.                                                             |
| **The API copy is at its stream cap**                                             | 503 with `Retry-After`, then polling.                                                                                                                                                                                                                            | Updates within about 20 s.                                           |

## 9. Security

- **Authentication on connect and on every reconnect.** This uses the same `SessionGuard` and `OpsGuard` as every other request. A missing session gets 401 on `/v1/me/events`. On `/v1/ops/events`, no grant gets the guard's 404.
- **A session revoked mid-stream is closed.** `sessions.changed` makes the user's streams check again and close (section 4.1). A stream also never outlives 30 minutes, or its session's or grant's expiry.
- **Nothing in an event reveals anything.** The browser receives only a type from a fixed list: no ids, amounts, names, notes, counts or timestamps. The routing key stays on the server.
- **Isolation.** The hub routes only by ids the server resolved from the cookie, never by anything the client sends. The route takes no parameters.
- **Cross-site use.** CORS exposes the stream only to `WEB_ORIGIN`. The SameSite=Lax cookie is not sent on another site's subresource requests. Even a stream that was read would hold only types.
- **Rate and connection limits:** section 3.2.
- **Redis.** Redis has no password and relies on the private network (threat model X6). A message on the channel holds only internal ids and a type, so anything that can reach Redis could already do more than read them.
- **Staff streams** get only the signals their grant's permissions allow, checked at connect: issues need `issues.view`, and approvals need any staff role. A grant change re-checks the stream.
- **Threat model.** PR 1 adds a row to `docs/security/threat-model.md`: "Live stream leaks data or is abused". It lists these mitigations and points to their tests.

## 10. Observability

The metrics use the existing pattern, `getMeter(SERVICE_NAME)` from `@tipme/observability` as in `job-worker.ts`, exported through the Prometheus exporter when `API_METRICS_PORT` is set:

- `tipme.live.streams`: an observable gauge, attribute `stream` = `me` | `ops`.
- `tipme.live.connects`: a counter, attribute `outcome` = `opened` | `disabled` | `unauthenticated` | `limit_user` | `limit_process` | `rate_limited` | `draining`.
- `tipme.live.closes`: a counter, attribute `reason` = `client` | `lifetime` | `session_ended` | `draining` | `error`.
- `tipme.live.signals_published`: a counter in the API and the worker, attributes `type` and `outcome` = `ok` | `failed`.
- `tipme.live.signals_delivered`: a counter, attribute `type`.
- `tipme.live.subscriber`: an observable gauge, 1 when connected.

**Logs** are structured, carry no user or profile ids, and are written only on change:

- `live.publish_failed` (with the error name);
- `live.subscriber_down` and `live.subscriber_restored`;
- `live.limit_reached` (with the kind);
- `live.message_invalid`.

Routine opens and closes are counted, not logged.

The request-context access log (`request-context.middleware.ts`) logs a stream once, when it closes. That is acceptable. The HTTP latency histogram from `HttpInstrumentation` (`packages/observability/src/telemetry.ts`) must ignore the two stream paths, through `ignoreIncomingRequestHook`, so 30-minute requests don't swamp the API's p95.

There are no alerts until production monitoring is chosen (D-08). The staging watcher may later report `tipme.live.subscriber = 0`.

## 11. Testing

The levels are the ones this repo uses: `node:test` `.mjs` unit tests per app, `tests/integration` against `tipme_test` with Redis, and Playwright e2e on the full stack (web 3100, API 4100, worker).

### 11.1 Unit

- `apps/web/test/live-client.test.mjs` (new). Uses a fake EventSource and timers. It covers:
  - `ready` triggers a resync;
  - backoff and jitter bounds;
  - 3 failures switch to polling;
  - a `poll` message;
  - a 204 stops everything;
  - the watchdog reconnects after 50 s;
  - hidden pauses and visible refreshes;
  - `ready` missing for 10 s means a buffered stream;
  - debounce and single-flight.
- `apps/web/test/live-merge.test.mjs` (new). New-row detection by id, only `paid` rows marked to arrive, the once-a-minute announcement with the count, and dirty forms kept.
- `apps/api/test/live-hub.test.mjs` (new). Covers:
  - routing by user, profile, all and staff permission;
  - another user's stream gets nothing;
  - the 8 and 2,000 caps;
  - coalescing within 250 ms;
  - drain closes streams with `retry`;
  - the browser receives only `{type}`.
- `apps/worker/test/live-signals.test.mjs` (new). Covers `liveSignalFor` for every outbox event type, and that a publish that throws is swallowed and counted.
- Extend `apps/worker/test/domain-events.test.mjs` (signals after the `tip.succeeded` handler) and `apps/api/test/readiness.test.mjs` (draining refuses streams).

### 11.2 Integration

- `tests/integration/live-events.test.mjs` (new). **Write it first**: its "stream outlives `requestTimeout`" case decides whether the endpoint works at all. It covers:
  - 401 without a session;
  - CORS with credentials for `WEB_ORIGIN` only;
  - 204 when off;
  - a stream that stays open more than 12 s with heartbeats;
  - a pretend tip (the mock webhook) produces `tips.changed`, and after the worker job `notifications.changed`, on the recipient's stream and nothing on a second user's;
  - revoking the session closes the stream with `session.ended`;
  - draining closes streams;
  - the per-user cap gives 429.
- Extend:
  - `tests/integration/outbox-delivery.test.mjs`: the relay publishes only after the rows commit, and not when the queue add fails;
  - `tests/integration/worker-domain-events.test.mjs`;
  - `tests/integration/auth-api.test.mjs`: sign out others;
  - `tests/integration/ops-approvals.test.mjs`: a pending approval reaches another staff stream;
  - `tests/integration/withdrawals-switch-api.test.mjs`: broadcast;
  - `tests/integration/connection-budget.test.mjs`: no held connection.
- `scripts/generate-docs.test.mjs` already requires every route to be documented, and it fails until the two routes are.

### 11.3 End to end

- **`tests/e2e/live-updates.spec.ts` (new).** It proves "tip lands, balance updates without reload":
  1. Sign in a recipient and open `/dashboard`. Set `window.__noReload = 1` and record the balance text.
  2. Call `tipAsVisitor(browser, handle, { amount: '5,000 NGN', name: 'Chidi' })` (`tests/e2e/helpers.ts`), in its own context.
  3. Expect, **within 5 s**, the balance to read the new net and the activity list's first row to be the new tip. 5 s is below the 20 s fallback, so the stream did it, not a poll.
  4. Expect the `role="status"` toast to read "You got a tip · ₦4,500 from Chidi".
  5. Expect `window.__noReload` to still be 1.
  6. A `MutationObserver` on the balance records every text value. It must see only the old value and the new one (the EXPERIENCE §10 money test).
  7. The same test in a `reducedMotion: 'reduce'` context: the new row has `getAnimations().length === 0`.
  8. A fallback case: `page.route('**/v1/me/events', route => route.abort())`, and the balance still updates within 25 s.
- Extend:
  - `tests/e2e/pro.spec.ts`: staff turn on Pro in another context, and the recipient's QR studio and amounts unlock without a reload;
  - `tests/e2e/withdraw.spec.ts`: a pretend payout paid changes status in an open tab;
  - `tests/e2e/withdrawal-controls.spec.ts`: the switch shows in an open Withdraw tab;
  - `tests/e2e/notifications.spec.ts`: the bell needs no poll while connected;
  - `tests/e2e/ops-alone.spec.ts`, or the approvals spec: a second approver sees the request without a reload.
- The e2e stack's API environment sets `LIVE_UPDATES_ENABLED=true`.

## 12. Rollout

- **The flag.** `LIVE_UPDATES_ENABLED` is an API environment variable, default `false`, added to `apps/api/src/config.ts`, `deploy/*.env.example` and `compose.*.yml`.
  - While it is off, the routes answer 204 and the web behaves as today.
  - Publishers always publish. A `PUBLISH` with no subscriber costs nothing.
  - Turning it off is a change to `production.env` and a recreate of the API colour. No web deploy is needed.
- **Additive only.** There are no migrations, contract changes are optional fields only, and the existing endpoints are untouched.
- **Turning it on.** Staging first, with the Caddyfile change and the `curl -N` check. Then a week of watching `tipme.live.*`. Then production.

**PR order:**

1. **The stream, tips and balance.**
   - The contracts schema.
   - The API live module: the routes, hub, subscriber, limits, drain, flag, session close and 30-minute lifetime.
   - The worker publisher in the relay and the `tip.succeeded` handler.
   - The Caddyfile change.
   - The live provider and hook.
   - The dashboard home (summary, activity, moments), the Tips page and tip detail, and the bell folded in.
   - The threat model row, the tests above, and a runbook note in `docs/runbooks/production.md`.
2. **Plan, withdrawals and banners.** `profile.changed`, `withdrawals.changed` (including the switch and freeze), `payments.changed`, `reports.changed`, `account.changed` and suspension, with the dirty-form rule in Settings and the QR studio.
3. **Admin.** `/v1/ops/events`, approvals and issues.

The username take-back's hook ships with that feature.

## 13. With the screen-redesign branch (Task 10)

The redesign rebuilds the dashboard with "data and API calls unchanged; no live updates (a later plan)". So that this plugs in later without another rebuild, Task 10's dashboard should:

- **Load each panel's data in one named loader.** For example `useDashboardSummary()`, `useActivity()` and `useMoments()`, each returning `{ data, reload, updatedAt, error }`. Avoid one `Promise.all` whose single failure replaces the whole screen.
- **Separate a first-load failure from a refresh failure.**
- **Key rows by `tipId` or `payoutId`.**
- **Render the balance as one element that can take a highlight class,** and never animate it.
- **Leave room for an "Updated 14:02" line** under the balance.
- **Make the bell's toast the one `role="status"` announcer** for tips.

## 14. The owner's answers (3 Nov 2026)

These settle the open questions. Where a section above says otherwise, this section wins.

1. **Who tipped, and how much, in the live pop-up.**
   - By default the toast and the polite announcement name the supporter and the amount ("New tip from Chidi, ₦5,000"), shown once.
   - A new Settings switch, "Hide who tipped and how much in pop-ups", is for shared screens and shop counters. Turned on, the pop-up says only "You got a new tip"; the tips list still shows the details. It is stored per account and is off by default.
2. **A new tip in a background tab plays a soft sound.**
   - It sounds once per new tip and never for anything else. There is no browser notification and no permission prompt.
   - A "Sound for new tips" switch in Settings mutes it. It is on by default, per account.
   - Browsers block page audio until the person has clicked or typed on the page once, so the sound begins after their first interaction in that tab. Before that it fails silently, with no error shown.
   - It plays only when the tab is hidden; a visible tab already shows the toast.
   - It plays only for a tip the API reports as paid.
   - Reduced motion has no bearing on sound; the mute switch does.
   - The sound file is short (under a second), quiet and self-hosted under apps/web/public.
3. **Public pages are not live.** An open public page refreshes on its next load, as today. Checkout re-checks on the server and refuses safely if something changed.
