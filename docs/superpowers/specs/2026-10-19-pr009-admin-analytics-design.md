# PR-009 design — admin dashboard, issues, analytics and market notes

Status: DRAFT for user approval. Date: 2026-10-19. A builder check was done; its six questions are answered below as the agent's calls.

## Intent

The delivery plan's PR-009 is "Analytics/ops: safe events, traces/logs, ops view for exception handling with privileged access". In the user's words:

- When something goes wrong, it "should be visible on the admin dashboard with all the data points needed to resolve it or make a decision".
- The numbers should "show overall health and our visibility in the market".

There is one admin today (the user), but "we should make provision for roles to be added in the future". All money is still pretend (D-03, D-04, D-05 open).

## Goals (agreed with the user)

1. **Admin dashboard (`/ops`)**, a separate area from the recipient dashboard.
   - **Access:** only staff can enter. Today that is the user, with the **Owner** role.
   - **Roles:** a role is a set of permissions, so new roles (for example Support or Finance) can be added later without a rebuild.
   - **Sign-in:** staff sign in with their phone and code like everyone else, then confirm with an **authenticator app** (TOTP). Admin sessions are shorter.
2. **Issues inbox.** Every problem needing a human appears as an issue. Each shows what happened in plain words and **all the data points** to resolve it or decide:
   - status history;
   - provider events;
   - ledger entries;
   - the trace/support reference;
   - the people and page involved;
   - earlier notes.
3. **Decisions without touching money.** Available actions:
   - resolve with a note;
   - add a note;
   - suspend or unsuspend a recipient page;
   - cancel a pending phone recovery;
   - re-check a payment with the provider.

   No refunds or manual money adjustments: the security baseline requires two-person approval for those, and there is one admin.

4. **Audit log.** Every staff view of private data and every action is recorded: who, what, when and why. The log is append-only. Actions that change something require a written reason.
5. **Analytics: overall health.**
   - money flow: tips, amount tipped, TipMe fees — this week vs last;
   - the tipping funnel: page visit → amount chosen → payment started → paid;
   - reliability: declined, stuck and needs-a-human rates, time to confirm, open issues;
   - recipients: sign-ups, pages gone live, recipients tipped this week, and recipients coming back.
6. **Analytics: visibility.**
   - how visitors arrive: QR scan, shared link, social network, search or direct;
   - unique and returning visitors to recipient pages;
   - sharing: QR printed or shared, weekly reports and moments shared, celebrations that led to tips;
   - top recipients by visits, private to admin.
7. **Market page.** The admin records outside observations by hand: competitor fees and features, social mentions, app-store ratings and similar. Each entry has a date, a source link and a note, and is charted over time.

## Non-goals

- Automatic social listening, competitor scraping, and Google Search Console. These come later and need a provider, a budget and a public domain; they are recorded as a decision item.
- Refunds, manual ledger adjustments or any money movement from admin.
- More than one staff member in practice: the role structure exists, but only Owner is seeded.
- Third-party analytics tools.
- Supporter accounts.

## Anti-goals

- Analytics that identify anyone: no phone numbers, emails, messages, supporter names, amounts per person, IP addresses or persistent cross-site identifiers.
- Admin pages that change money records directly, or any action without a recorded reason.
- Admin authorization by hiding buttons: every route checks the permission on the server.
- A dashboard that shames recipients: top-recipient lists are admin-only and never published.

## Constraints

- **AGENTS.md and `docs/05-SECURITY.md`:**
  - separate public, recipient and internal-ops authorization;
  - strong staff authentication;
  - audit logs;
  - controlled support access;
  - two-person approval for sensitive finance adjustments;
  - no sensitive data in logs or analytics.
- **Web:** WCAG 2.2 AA; the existing brand.
- **No new third-party trackers.** Any new library is pinned and registered.
- **Existing suites stay green.**

## Decided with the user

- The admin dashboard holds every problem with all the data needed.
- One admin now, with roles possible later.
- The authenticator app is the second step.
- Health and visibility metrics as listed.
- Outside visibility starts as manual Market entries; automatic feeds come later.

## Builder's design (agent's calls, open to review)

### Staff access

- **Staff records:** a `staff` table keyed by user id, plus `roles` and `role_permissions`.
  - Permissions: `issues.view`, `issues.resolve`, `pages.suspend`, `recoveries.cancel`, `analytics.view`, `market.edit`, `audit.view`, `payments.recheck`, and `private.view` _(builder check, agent's call)_.
  - `private.view` covers supporter messages, supporter names, phone numbers and emails. They are hidden by default even inside an issue, and shown only by a **reveal with a written reason**, which is audited.
  - Owner has them all.
  - The Owner is created by a one-off command (`pnpm ops:grant-owner --phone …`), never through the web.
- **Enrolment is protected** _(builder check, agent's call)_:
  - `pnpm ops:grant-owner` prints a **one-time enrolment code**, valid 30 minutes. Registering the authenticator in `/ops` needs that code, so someone holding the Owner's phone session alone cannot set one up.
  - Re-enrolling uses the same command.
  - **Staff accounts are excluded from email recovery**: the request is refused. Moving a staff account to a new number removes ops access until the grant command is run again.
- **Second step:** a TOTP authenticator, RFC 6238 (SHA-1, 6 digits, 30 seconds, ±1 step).
  - The secret is encrypted at rest with `OPS_TOTP_KEY` (AES-256-GCM).
  - Enrolment happens once, in `/ops`, by QR code (reusing the QR library) plus a manual code.
  - A code already used in a step cannot be reused.
- **Admin session:** a separate `ops_sessions` grant on top of the recipient session.
  - It is created only after the TOTP check and stored hashed, like sessions.
  - It expires after 12 hours, or 1 hour idle.
  - Every `/v1/ops/*` route requires a recipient session, an ops grant and the specific permission. All of them sit behind the CSRF guard.
  - Five wrong TOTP codes lock ops access for 15 minutes.

### Issues

- **What creates them:** the worker turns outbox events into issues, each once (keyed by the event's dedupe key). The events are:
  - `payment.mismatch`, `payment.conflict`, `payment.unresolved`;
  - `payout.failed`, `payout.conflict`;
  - `provider_event.conflict`;
  - newly stored unmatched provider events.
- **Scheduled detectors** (run by the reconciliation job) also open issues for:
  - tips still confirming after 30 minutes;
  - pending phone recoveries (informational).
- **Self-resolving** _(builder check, agent's call)_:
  - When the cause clears, the system resolves the issue itself (resolver `system`, audited). Examples: a stuck tip confirms, a re-check settles a payment, a recovery completes or is cancelled.
  - If the condition comes back, it becomes a **new** issue; resolved issues are never reopened.
  - Each detector's dedupe key includes the subject id and the occurrence, for example `stuck_tip.<tipId>`.
  - Unmatched provider events are found by a scheduled detector; no new outbox event is needed.
- **Fields:** id, kind, severity (`money`, `account`, `info`), status (`open` or `resolved`), subject (tip, attempt, payout, profile or user ids), opened_at, resolved_at, resolved_by.
- **Evidence:** the evidence view assembles, on request:
  - the PR-005 tip proof (provider events, ledger, history);
  - payouts;
  - the attempt and provider reference;
  - the trace reference, with a link to the trace viewer when configured;
  - the recipient page;
  - related issues and notes.

  It shows private data (messages, phone numbers) only to the `issues.view` permission, and each viewing is audited.

- **Actions:**
  - **resolve:** a reason is required, and the issue becomes resolved;
  - **note**;
  - **re-check with provider:** runs the PR-006 reconciliation for that one attempt or payout; it only ever asks, never charges;
  - **suspend or unsuspend the page:** sets `profiles.status`. The page shows "isn't available", tips are refused, and the page is revalidated.
    - **What suspension means for the recipient** _(builder check, agent's call)_:
      - They can still sign in and see their dashboard, with a banner showing the reason the admin gave.
      - They cannot switch the page live.
      - Tips already in flight settle normally.
      - **Withdrawals stay allowed.** Holding a recipient's money is a payout hold, which needs D-06 and legal approval; admin never moves or freezes money.
      - No new moments or rewards are created while suspended.
  - **cancel phone recovery.**
- **Audit:** every action and every evidence view writes `audit_events` (append-only): staff user, permission, action, subject, reason, trace id and time.

### Analytics

- **Collection switch** _(builder check, agent's call)_: `ANALYTICS_ENABLED` defaults to on in development and test and **off in production until D-07** is decided. When it is off, the dashboards say "collection is off".
- **Collection:**
  - The web sends events to `POST /v1/events`. It is rate-limited and unauthenticated, uses an allow-list of names and properties, and has no cookies.
  - **Anonymous flow id:** a random id per browser tab session (in `sessionStorage`). It is never stored across sessions and never joined to accounts.
  - **Consent:** the client sends nothing when the browser signals Global Privacy Control or Do Not Track.
  - **Server-side:** the API drops the IP and user agent, keeps only a device class (mobile/desktop), and buckets the timestamp to the minute.
- **Events** (from the baseline contract):

  | Group               | Events                                                                                                                                |
  | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | Profile and tipping | `profile_viewed`, `tip_cta_clicked`, `amount_selected`, `custom_amount_entered`, `message_started`, `payment_started`                 |
  | Payment outcome     | `payment_pending`, `payment_failed`, `tip_completed`, from verified server state — never from the client                              |
  | Arrival             | `qr_scanned`, when the page URL carries the QR's `?src=qr` tag                                                                        |
  | Recipient activity  | `recipient_shared_link`, `qr_downloaded`, `qr_printed`, `report_shared`, `moment_shared`, `recipient_first_tip`, `recipient_returned` |

- **Returning visitors** _(builder check, agent's call)_:
  - The browser keeps only a yes/no flag "has visited TipMe before" (local storage, no id), sent as `returning: true/false` on `profile_viewed`.
  - "Unique visitors" is labelled **visits** (tab sessions); "returning" is the share of visits from browsers that came before.
  - No identifier ever links visits together.
- **Properties:** surface, channel, referrer category (`qr`, `link`, `instagram`, `x`, `facebook`, `whatsapp`, `search`, `direct`, `other`) and handle.
  - The handle is public; it is used for admin "top recipients" only.
- **Storage:**
  - `analytics_events` holds raw events for 90 days.
  - A daily job rolls them up into `analytics_daily` (date, metric, dimension, value) before deleting the old raw rows.
  - Health metrics come straight from the money tables (tips, quotes, ledger), not from client events.
- **QR tag:** recipient QR codes encode `/@handle?src=qr`. The profile page reads it client-side only, and the canonical URL stays `/@handle`.

### Market

- `market_entries` holds: date, category (`competitor`, `social`, `app_store`, `press`, `other`), name, metric, value (numeric, optional), text, source URL and note.
- The admin can add, edit and archive entries, with every change audited.
- Charts show a metric over time per name.

### Admin web (`/ops`)

- **Pages:**
  - Overview: health tiles, the funnel, reliability, open issues;
  - Issues (list and detail);
  - Visibility;
  - Market;
  - Audit log;
  - Staff & roles (read-only).
- `noindex` and responsive, with all UI states.
- Distinct but on-brand: an "Admin" banner, so it is never confused with a recipient's dashboard.

### Documentation

- ADR-0010 (staff access, audit, analytics privacy).
- Decisions log: automatic market feeds deferred; analytics consent approach pending D-07.
- A runbook, "Working the issues inbox".
- `docs/PR-009-VERIFICATION.md`.

## Left to the builder

- Exact page layouts and chart rendering (SVG, no chart library unless one is justified and registered).
- Exact detector thresholds beyond those stated.
- Copy wording.
- Polling of the issues inbox.

## Risks

- **Size:** split into stages, each tested on its own:
  1. staff access and audit;
  2. issues and evidence;
  3. actions;
  4. analytics collection;
  5. health and visibility dashboards;
  6. market.
- **Analytics consent and retention** are proposals until D-07. The design is cookieless and anonymous to minimise that risk.
- **TOTP secret handling:** losing `OPS_TOTP_KEY` locks admin out. The grant-owner command can re-enrol.
