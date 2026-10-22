# ADR-0010 — Staff admin access, audit log, issues inbox, anonymous analytics and market notes

Date: 2026-10-19
Status: ACCEPTED for development (PR-009). Analytics collection stays **off in production** until D-07 (privacy, consent and retention) is decided. Admin actions never move money.
Owners: Engineering

## Context

The user asked that every problem "should be visible on the admin dashboard with all the data points needed to resolve it or make a decision". They also want numbers that "show overall health and our visibility in the market".

There is one admin today, but "we should make provision for roles to be added in the future". `docs/05-SECURITY.md` asks for:

- separate public, recipient and internal-ops authorization;
- strong staff authentication;
- audit logs;
- controlled support access;
- two-person approval for sensitive finance adjustments;
- no sensitive data in logs or analytics.

## Decision

### Staff and roles

- **Staff records:** staff are ordinary recipient accounts with a row in `staff`.
- **Roles and permissions:** a role is a named set of permissions (`roles`, `role_permissions`), so a new role (Support, Finance) needs no code change. The permissions are:
  - `issues.view`, `issues.resolve`;
  - `pages.suspend`;
  - `recoveries.cancel`;
  - `analytics.view`;
  - `market.edit`;
  - `audit.view`;
  - `payments.recheck`;
  - `private.view`.
- **Owner:** only `owner` is seeded, and it holds them all.
- **Granting:** staff are made only by `pnpm ops:grant-owner --phone <number>`, run against a local database. The command prints a one-time **enrolment code** (stored hashed, valid 30 minutes).

### Second step: authenticator app

- **Algorithm:** TOTP per RFC 6238 (HMAC-SHA1, 6 digits, 30-second steps, ±1 step), implemented with `node:crypto`. No new dependency.
- **Enrolment needs the enrolment code**, so someone holding only the Owner's phone session cannot register their own authenticator.
- **Secret storage:** the secret is sealed with AES-256-GCM under `OPS_TOTP_KEY` (32 bytes, base64; required by the API, never logged).
- **No reuse:** the last used step is stored under a row lock, so a code can never be used twice, even by two requests at once.
- **Lockout:** five wrong codes lock admin access for 15 minutes.

### Admin grant

- **Cookie:** a second cookie, `tipme_ops` (HttpOnly, SameSite=Lax, Secure except local HTTP). Only the token's SHA-256 is stored, in `ops_sessions`.
- **Lifetime:** at most 12 hours, or 1 hour idle.
- **Bound to the recipient session:** the grant belongs to the session it was opened on. Signing out, revoking that session, or presenting the cookie with another session ends it.
- **Checks on every `/v1/ops/*` route:** the session, the grant, and the route's permission, plus the CSRF guard on state-changing requests.
  - Anyone without a session or grant gets **404**, so the admin area reveals nothing.
  - Staff whose role lacks the permission get **403 `FORBIDDEN`**.
  - Buttons are never the control; the server is.
- **Sign-in step:** `GET /v1/ops/me` tells a signed-in staff member which step comes next (`needs_enrolment` / `needs_code`, or `granted`). Everyone else gets 404.
- **Account moves:** a staff account is never recovered by email (the request answers as usual and sends nothing). A phone change or a completed recovery removes the authenticator and ends every grant, so the grant command must be run again.

### Audit log

- `audit_events` is append-only: triggers refuse UPDATE, DELETE and TRUNCATE.
- **What each row records:**
  - the staff user, or null for the system;
  - the action and the permission used;
  - the subject;
  - the written reason;
  - the trace id;
  - the time.
- **What is logged:** every grant, enrolment, evidence view, private-data reveal and admin action. Every change and every reveal requires a reason.

### Issues inbox

- **Where issues come from:**
  - Each outbox alert becomes one issue, keyed by the alert's dedupe key, so a redelivered alert changes nothing. The alerts are:
    - `payment.mismatch`, `payment.conflict`, `payment.unresolved`;
    - `payout.failed`, `payout.conflict`;
    - `provider_event.conflict`.
  - The reconciliation job's detectors also open issues for:
    - tips confirming for more than 30 minutes;
    - unmatched provider events;
    - pending phone recoveries.
- **What an issue holds:**
  - a severity (`money`, `account` or `info`);
  - ids only;
  - a plain-words summary naming at most the public handle.
- **Closing:** the system resolves an issue when its cause clears (resolver `system`, audited). Resolved issues never reopen; a recurrence is a new issue.
- **Evidence** is assembled on request:
  - the PR-005 tip proof;
  - attempts and provider events (reference tails only);
  - the payout;
  - the page;
  - the masked person;
  - the trace link;
  - related issues and notes.

  Viewing it is audited.

- **Actions**, each with a written reason and audited in the same transaction:
  - **resolve**;
  - **note**;
  - **re-check with the provider** (reconciliation for one attempt or payout: it asks, never charges);
  - **pause or restore a page;**
  - **cancel a phone recovery.**
- **A paused page:**
  - shows "isn't available" and takes no new tips;
  - cannot be put live by the recipient, who sees the reason on their dashboard;
  - still settles tips that are in flight;
  - still allows withdrawals (holding money would be a payout hold, which needs D-06 and legal approval);
  - earns no new moments or rewards.

### Anonymous analytics

- **Collection switch:** `ANALYTICS_ENABLED`, read by the API and worker. Unset, it is on in development and test and **off in production until D-07**. The dashboards say when collection is off.
- **`POST /v1/events`:**
  - It takes a strict allow-list of event names and properties: surface, channel, public handle and a "returning" flag. There is no free text.
  - It is rate-limited, cross-origin from the web app only, and never credentialed. No cookies are set.
  - A handle is kept only if such a page exists.
  - Requests carrying `Sec-GPC: 1` or `DNT: 1` are accepted and dropped.
  - IP addresses and user agents are never stored. Each event keeps only a device class and a minute bucket.
- **The browser:**
  - Nothing is sent under Global Privacy Control or Do Not Track.
  - **Nothing is written to a supporter's device:** the flow id lives in memory for one page visit.
  - "Returning" is known only for supporters who already chose "Remember my tips". This keeps the PR-007 promise that a supporter who did not opt in is never remembered.
- **Server-side outcomes** come from verified state in the worker, once each by dedupe key: `tip_completed`, `recipient_first_tip`, `payment_failed`.
- **Storage:** raw events are kept 90 days. A daily job (01:00 Lagos) writes daily totals and purges older raw events.
- **QR attribution:** QR codes encode `/@handle?src=qr`. The page strips the tag after counting, and the canonical URL stays `/@handle`.
- **Health numbers** come from the money tables, not from events. Only the funnel and visibility use events.

### Market notes

- Staff record outside observations by hand: date, category, name, metric, optional value or text, an **https** source and a note.
- Entries are edited or archived, never deleted, and every change is audited.
- Automatic feeds are deferred (00-DECISIONS, PR-009 notes).

## Rationale

- **Authenticator over SMS codes:** a second factor that does not depend on the same phone number as sign-in, and no provider is needed (D-11 is open).
- **Grant bound to the session:** a stolen admin cookie is useless alone, and signing out is a complete exit.
- **404 rather than 401/403 for outsiders:** probing reveals neither the area nor who is staff.

## Financial, security, privacy and accessibility impacts

- **Financial:** none. Admin cannot refund, adjust the ledger or hold payouts, because the two-person rule cannot be met with one admin.
- **Security:**
  - secrets are sealed;
  - codes are single-use;
  - lockouts apply;
  - grants are short and bound to the session;
  - permissions are checked on the server;
  - the audit log is append-only.
- **Privacy:** private details stay hidden in admin views until revealed with a reason (audited).

## Consequences

- Losing `OPS_TOTP_KEY` locks out admin; `pnpm ops:grant-owner` re-enrols.
- More staff need a decision on roles and on who may run the grant command in a hosted environment.

## Validation evidence

`docs/PR-009-VERIFICATION.md`.
