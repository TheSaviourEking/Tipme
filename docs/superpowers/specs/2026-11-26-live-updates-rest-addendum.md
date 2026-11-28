# Live updates for the rest of TipMe: addendum

Date: 26 November 2026. Status: APPROVED scope (owner, 26 Nov 2026). This is an **addendum to `docs/superpowers/specs/2026-11-03-live-updates-design.md`** (the "base design"). Everything the base design decides still holds: signals only, never data; resync on every (re)connect, no replay; one Redis channel; publish only after the commit; the hub's limits, drain and lifetime; `LIVE_UPDATES_ENABLED` off means 204 and today's behaviour. This addendum only adds what the base design left out or left "as it is".

The owner (26 Nov 2026): "we're using SSE in this project, except where it isn't best. We need to avoid wasting bandwidth." / "Let's move the rest of the stuff to SSE".

It changes no money rule and decides nothing under VALIDATE in `docs/00-DECISIONS.md`.

## 1. Intent

- Every screen that polls today because something may change on the server listens on a stream instead, and reads only when told something changed.
- A timer survives only as the fallback while a stream is down. On staff screens that fallback is 30 s (± 3 s), never 5 s. While a stream is connected, staff screens make no timed requests.
- With `LIVE_UPDATES_ENABLED` off (staging and production today), every screen behaves exactly as today: the same requests, the same timers, no extra request to find out that live updates are off.
- **Not moving:** the coming-soon countdown. It runs on the local clock and makes no requests.

## 2. What already exists on `dev` (verified 26 Nov 2026)

- `apps/api/src/live/live-router.ts` already routes `{ staff: 'any' | 'issues.view' }`, keeps `ops` sinks with a permission set, and re-checks every ops stream on `staff.changed`. `openStream` in `live.controller.ts` is written to be shared.
- `packages/contracts/src/live.ts` declares `ops.approvals.changed` and `ops.issues.changed`, but nothing publishes or consumes them, and nothing publishes `staff.changed`.
- `LIVE_PATHS` (`packages/observability/src/telemetry.ts`) and the edge Caddyfile already name `/v1/ops/events`.
- `apps/worker/src/live-signals.ts` maps every staff outbox event to `none` "until PR 3".
- The ops shell (`apps/web/src/app/ops/ops-shell.tsx`) mounts no `LiveProvider`.

## 3. The seven items

### 3.1 Staff stream, approvals and issues (base design §4.2, §5.2 items 12–13)

Built exactly as the base design says, with these details it did not settle:

- **Route.** `GET /v1/ops/events`, address rate limit first (`live_connect`), then `OpsGuard` with `@OpsAnyStaff()`, then the per-person limit (`live_connect_user`). No grant gives the guard's 404, as on every admin route.
- **A stream is not activity.** Connecting must not move the grant's `lastSeenAt`, or an open tab would keep an idle grant alive. The guard reads the grant without touching it for this route, and for any GET that carries `x-tipme-background: 1` (`LIVE_BACKGROUND_HEADER`). The stream closes at the earliest of 30 min (± 3), the grant's `expiresAt`, and the grant's idle deadline (`lastSeenAt` + 60 min); the reconnect authenticates again. The reads the stream starts (its ready, a resync, a signal, the fallback poll, the Providers page's rest deadline) send that header and do not count as activity either, so an open, visible but unused tab still loses its grant after the idle hour (final review I1, ruling L-R22; this replaces the earlier "resync reads count as activity"). The person's own reads, navigation and every write still touch; a staff screen's own timer with live updates off is unchanged.
- **Permissions.** Read once at connect, from the grant. On `staff.changed`, each staff stream checks its grant again and closes if the grant is gone **or its permission set changed**. A closed stream reconnects with the new set.
- **`staff.changed` is published** by the relay for `ops.staff_changed` and `ops.last_approver_removed`, and by the API after `revokeOpsGrants` (admin sign-out).
- **Turned on per page.** `GET /v1/ops/me` gains `liveUpdates` (optional, like `MyProfile.liveUpdates`). The ops shell opens the stream only when it is true. Off, the shell makes no new request.
- **Signed out mid-stream.** A refused ops stream is probed as the dashboard's is. For the ops stream a 404 counts as signed out, and the shell runs its own `opsState()` again (which shows the code step or the sign-in redirect).
- **Issues.** On `ops.issues.changed` (to staff with `issues.view`) the page re-reads its first page with the current filters. If the person has loaded more pages, it shows a "New changes: show" button instead of replacing rows under them (the base design's Tips-page rule).
- **Approvals.** The queue and the menu's count re-read on `ops.approvals.changed` (to any staff).

### 3.2 Announcements

- **Signal:** `ops.announcements.changed`, to staff holding `announcements.send` (the permission every announcements route names).
- **Raised by:** the worker after `handleAnnouncements` returns `announcements_queued` (a batch committed, so the "x of N" moved, or the announcement finished), and the API after a cancel. A paused batch (daily limit) does not signal every 10 s; it signals when it next queues.
- **Screen:** connected, the 5 s timer is gone and the list re-reads on the signal. Stream down: the 30 s fallback. Live off: today's 5 s while sending.

### 3.3 Providers (replaces the base design's "left as it is")

- **Signal:** `ops.providers.changed`, to staff holding `issues.view` **or** `providers.manage` (the providers read route accepts either). This needs a target the base design lacks: a list of permissions, any of which is enough (§4).
- **Raised by:** a provider-test email reaching a final delivery state in the worker's mail delivery (sent or failed); the API after a test is confirmed; the worker's mail-health `onChange` (tripped, still down, recovered); the API after staff clear a provider's health.
- **Clock-driven changes are not signals.** A resting provider becomes "trial" when its `until` passes, with no write. While connected, the page sets **one** timeout for the earliest future `until` (plus up to 5 s of jitter) and re-reads then. That is a deadline, not a poll. A test turning "expired" after 24 h is caught by the next reconnect's resync.
- **Screen:** connected, no timer apart from that one deadline. Stream down: the 30 s fallback. Live off: today's 5 s while a test is pending or a provider is unhealthy.

### 3.4 Staff fallbacks

- The staff stream's client polls every **30 s ± 3 s** while degraded (the dashboard's stays 20 s).
- The base design's 5-minute safety refresh is **off for the staff stream**: the owner asked for no timed requests while connected. A lost signal is caught by the next reconnect (at most about 33 minutes, the stream lifetime), a tab becoming visible again, or the staff member's own next action.
- A staff screen runs its own (today's) timer only while the provider's status is `idle` or `disabled`, the same rule the notification bell already uses.

### 3.5 Update notice

`apps/web/src/components/update-notice.tsx`, in the root layout:

| The page has                                                                | Behaviour                                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A dashboard or staff stream that is connected                               | No timer. One `/api/version` check on each stream `ready` (at most once a minute), and on visible. |
| A dashboard or staff provider, stream not connected (off, down, connecting) | Today's: every 5 min while visible, and on visible.                                                |
| No live provider (public and signed-out pages, the receipt)                 | Every **30 min** while visible, and on visible.                                                    |

An API deploy drains every stream, so the reconnect's `ready` triggers the check. A web-only deploy on Vercel ends no stream; it is noticed at the next reconnect, at most about 33 minutes later (the stream lifetime), the same order as a public page's 30 minutes. The notice learns about streams through a small in-page registry the providers report to; it adds no request.

### 3.6 Tip receipt (replaces the base design's §5.3 item 14 "keep polling")

A one-tip public stream, `GET /v1/tips/:tipId/events`.

- **Opened only when the API says live updates are on.** `TipStatusView` gains `live` (optional). The receipt's first status read tells it; with live off it makes no new request and polls as today.
- **Carries one signal only:** `tip.changed`, routed to that tip's streams and nothing else. It is raised by the relay for `tip.succeeded` and `tip.failed` (their payload has `tipId`), by the webhook path that moves a tip to "still being confirmed", and by the worker for tips it cancels as stale.
- **Closes** when the tip is final (the client stops on reading `paid`, `declined` or `cancelled`; the server refuses a connect for a final tip with 204), after **15 minutes** per stream, and the client never reconnects later than 15 minutes after the page started following the tip ("Try again" starts a new round, as today).
- **Fallback:** while the stream is not connected, today's `nextCheckDelay` polling runs unchanged.
- **The partner check keeps its rate.** Today each status read may ask Bachs about the payment (`claimReceiptCheck`, at most every 4 s per tip). So that a connected receipt confirms as quickly as a polling one, the API copy holding the stream runs that same check on the server, every 4 s for the first 2 minutes and every 15 s after, until the tip is final or the stream closes. `claimReceiptCheck` still bounds it per tip across every copy and tab. Only when Bachs is configured, as today.

**Security of the public tip stream:**

- **The status token is required and never put in a URL.** EventSource can't send headers, so the receipt reads the stream with `fetch` and `Authorization: Bearer <token>`, exactly as the status route does (no cookie, no credentialed CORS; `/v1/tips/` already allows the `authorization` header). A URL would put the token in access logs.
- **A wrong token, a malformed id and an unknown tip are the same 404** as the status route's, checked before any database read (the token is an HMAC of the tip id).
- **Nothing but "changed".** The stream writes `ready`, `tip.changed`, the control messages and heartbeats. No status, amount, name, id or time. Knowing the token already lets the holder read the full receipt, so the stream reveals strictly less.
- **Isolation.** The hub routes a tip stream only by the tip id the token was verified for. A tip stream never receives recipient, staff or broadcast (`to: all`) signals, and recipient streams never receive `tip.changed`.
- **Limits.** Per address: the existing `live_connect` limit (60 a minute). Per tip: 10 connects per 15 minutes (a new Redis window key, which expires with its window). Per tip per API copy: 3 open streams (429 `LIVE_LIMIT`). Tip streams count towards `LIVE_MAX_STREAMS`. The limiter fails open, as everywhere (threat model X5).
- **Threat model.** A new row, "Public tip stream leaks or is abused", lists these and their tests.

### 3.7 Pro purchase "confirming" in Settings

- **The existing signal is not enough.** A Pro payment that changes the plan already sends `profile.changed` (webhook `signalPlan`, the worker's `announce`, `handleProExpire`). A purchase that fails, expires, goes to review, or pays without changing the plan (a month added to a running Pro) sends nothing.
- **New signal:** `pro.changed`, to the buyer's profile, whenever a Pro purchase leaves the open states (`PENDING`, `COLLECTING`, `UNKNOWN`), whatever the outcome. It is raised where those purchases settle: the webhook's `confirmProCheckout` path, the worker's `reconcileProPurchases` and `reconcileProCollections` read-backs. `profile.changed` still goes when the plan changed.
- **Screen:** connected, the "confirming" slip re-reads the purchase on `pro.changed`, `profile.changed` and every resync, with no timer. Not connected: today's `nextCheckDelay` polling.

## 4. Signals and who receives them

| Signal                      | Routing key                                      | Receives it                                             |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `ops.approvals.changed`     | `{ staff: 'any' }`                               | Every staff stream                                      |
| `ops.issues.changed`        | `{ staff: 'issues.view' }`                       | Staff streams whose grant holds `issues.view`           |
| `ops.announcements.changed` | `{ staff: 'announcements.send' }`                | Staff streams holding `announcements.send`              |
| `ops.providers.changed`     | `{ staff: ['issues.view', 'providers.manage'] }` | Staff streams holding either                            |
| `staff.changed` (server)    | `{ staff: 'any' }`                               | Never forwarded: every staff stream re-checks its grant |
| `pro.changed`               | `{ profile }`                                    | That profile's dashboard streams                        |
| `tip.changed`               | `{ tip }`                                        | That tip's receipt streams only                         |

The `staff` key accepts `'any'`, one permission, or a non-empty list of permissions (any one is enough), from a fixed list: `issues.view`, `announcements.send`, `providers.manage`. As in the base design, `to` never leaves the server and a browser only ever receives `{ "type": ... }`.

## 5. Left to the builder

- Where exactly each "after the commit" publish goes, following the base design §2.7 (never inside a transaction, never awaited by the money path, never failing the work).
- Additive return fields the publishers need (the tip id from the webhook's event result, the stale tips' ids, the settled Pro purchases' profile ids), named in the plan.
- The fetch-based stream reader for the receipt, kept to the `EventSourceLike` shape so `createLiveClient` drives it unchanged.
- The Caddyfile matcher for `/v1/tips/*/events`, proved on staging with the base design's `curl -N` check (with the receipt's `Authorization` header).
- PR boundaries; the plan proposes them.
