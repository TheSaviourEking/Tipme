# Access-control matrix

PRD §15 (7). Who may do what in TipMe, and the proof that the server enforces it. The route and permission tables below are **generated from the API's committed description**, `docs/api/openapi.json`, which is itself generated from the running API and checked by `pnpm api:openapi --check` and its test (`pnpm docs:generate` rewrites the tables), and `scripts/generate-docs.test.mjs` fails when they are stale or when a route is added that nobody has reviewed. Everything is enforced on the server; hiding a button is never the control.

Status: money is pretend. Nothing here approves real payments (`docs/00-DECISIONS.md`).

## Who the actors are

| Actor                | How TipMe knows them                                                                                                                                                                                                                                             | What they can reach                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Visitor**          | Not at all (no account, no cookie)                                                                                                                                                                                                                               | Public pages, quotes and tip initiation, the profile report form, health checks                    |
| **Supporter**        | The **status token** of their own tip (an HMAC over the tip id; sent as a bearer token)                                                                                                                                                                          | The receipt of that one tip, nothing else                                                          |
| **Recipient**        | Phone number plus a 6-digit code (valid 10 minutes; five wrong codes lock the number for 15 minutes). Session cookie `tipme_session` (HttpOnly, SameSite=Lax, Secure; ends 30 days after sign-in, however often it is used; revocable per device)                | Only their own page, tips, balance, withdrawals, settings and notifications                        |
| **Staff**            | A recipient account that is also in the staff table, **plus** an admin grant after an authenticator (TOTP) code. The grant lasts at most 12 hours and ends after 1 hour idle; five wrong codes lock admin access for 15 minutes                                  | What their role's permissions allow, below                                                         |
| **Payment provider** | A signature over the raw request body, with a 5-minute replay window                                                                                                                                                                                             | Delivering payment events (`POST /v1/webhooks/mock` while payments are pretend)                    |
| **Release check**    | A bearer token, and only on copies that say `RELEASE_KIND=test` (anything else answers 404). To check the admin journey it also signs in as a staff member with the `release_check` role, using an authenticator secret held in the GitHub `staging` environment | Opening and finishing rehearsal runs; with its staff account, what the `release_check` role allows |
| **System**           | Runs inside the private network (API, worker, Postgres, Redis)                                                                                                                                                                                                   | Not reachable from the internet; on the server only Caddy publishes ports (80 and 443)             |

## Rules that hold everywhere

1. **The server decides.** Every route checks who is calling before it reads or writes anything.
2. **A recipient acts only on their own data.** Each `/v1/me/*` route finds the page from the signed-in user's id, never from an id in the request. A tip, message or withdrawal that belongs to another page is answered as "not found".
3. **The admin area hides itself.** Anyone who is not signed-in staff gets `404` on every admin route. Signed-in staff without a live grant can reach only `GET /v1/ops/me`, authenticator enrolment and the grant itself; everything else answers `404` until they have one. A permission the role lacks gets `403`.
4. **State-changing requests with a session need the CSRF check:** the web app's exact `Origin` and the `x-tipme-csrf: 1` header, which a cross-site form cannot send. Reads never change anything.
5. **Public routes that change state are rate-limited** per client address (a /64 for IPv6), in Redis. The exceptions are the pretend-only routes (mock checkout, diagnostics, the weekly-report trigger), which are refused in production; the test lists them so a new one is reviewed too. If Redis is down the limiter lets requests through and logs the failure (availability over throttling; see the threat model).
6. **No route returns phone numbers, emails or supporter messages to staff by default.** A message is revealed only through the `private.view` permission with a written reason, and every reveal is audited. The same reveal also shows the recipient's full phone number and email.
7. **CORS** allows only the web app's origin. Credentials are allowed only on `/v1/auth/`, `/v1/me/`, `/v1/ops/`, `/v1/handles/` and `/v1/dev/` (and on every route in a private preview, where the preview cookie must travel). Checkout never sends them.
8. **Private previews** (staging) put a password gate in front of the web app and the API; only health, release info, backup health and signed webhooks pass without it.
9. **Every privileged change is audited** (who, what, when, why) in an append-only table. Admin actions never move money: there are no refunds, adjustments or payout holds in the admin yet.

## Staff roles and permissions

Two roles exist today. **Owner** holds every permission; staff are created only on the server with `pnpm ops:grant-owner`. **release_check** is the release check's own staff account and holds only `issues.view`, `issues.resolve`, `analytics.view` and `audit.view`. A new role is a row in the database (a name and a set of permissions) and needs no code change. A role with fewer permissions gets `403` on the rest (tested).

| Permission          | What it allows                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `issues.view`       | Read the issues inbox and an issue's evidence; add notes                                                          |
| `issues.resolve`    | Resolve an issue, with a reason                                                                                   |
| `pages.suspend`     | Pause or restore a page, with a reason the recipient sees                                                         |
| `recoveries.cancel` | Cancel a pending phone-number move (email recovery), with a reason                                                |
| `analytics.view`    | Read the Overview, visibility and market numbers                                                                  |
| `market.edit`       | Add, edit or archive hand-entered market observations                                                             |
| `audit.view`        | Read the audit log                                                                                                |
| `payments.recheck`  | Ask the payment provider for the current status of a payment or withdrawal                                        |
| `private.view`      | Reveal a supporter's message and similar private detail, with a reason (audited)                                  |
| `pages.plan`        | Look a page up and move it between Free and Pro, with a reason                                                    |
| `search.view`       | Search pages, tips, withdrawals and ledger entries (ids and labels only; audited by length)                       |
| `fees.manage`       | Set one page's TipMe fee or return it to the standard 10%, and grant fee-free tips, each with a reason (ADR-0014) |

### Which routes each permission unlocks

<!-- prettier-ignore-start -->
<!-- generated:permissions -->

| Permission | Routes it unlocks |
| --- | --- |
| `analytics.view` | GET `/v1/ops/market`<br>GET `/v1/ops/market/series`<br>GET `/v1/ops/metrics/health`<br>GET `/v1/ops/metrics/visibility` |
| `audit.view` | GET `/v1/ops/audit` |
| `fees.manage` | POST `/v1/ops/pages/{profileId}/fee`<br>POST `/v1/ops/pages/{profileId}/fee-free`<br>GET `/v1/ops/pages/{profileId}/pricing` |
| `issues.resolve` | POST `/v1/ops/issues/{id}/resolve` |
| `issues.view` | GET `/v1/ops/issues`<br>GET `/v1/ops/issues/{id}`<br>POST `/v1/ops/issues/{id}/notes` |
| `market.edit` | POST `/v1/ops/market`<br>PATCH `/v1/ops/market/{id}`<br>POST `/v1/ops/market/{id}/archive` |
| `pages.plan` | GET `/v1/ops/pages/{handle}`<br>POST `/v1/ops/pages/{profileId}/plan` |
| `pages.suspend` | POST `/v1/ops/pages/{profileId}/suspend`<br>POST `/v1/ops/pages/{profileId}/unsuspend` |
| `payments.recheck` | POST `/v1/ops/bachs/account-recovery`<br>POST `/v1/ops/bachs/checkout-recovery`<br>POST `/v1/ops/recheck` |
| `private.view` | POST `/v1/ops/issues/{id}/reveal` |
| `recoveries.cancel` | POST `/v1/ops/users/{userId}/cancel-recovery` |
| `search.view` | GET `/v1/ops/search` |

<!-- /generated:permissions -->
<!-- prettier-ignore-end -->

## Every route

<!-- prettier-ignore-start -->
<!-- generated:routes -->

#### Anyone (no sign-in)

| Method | Path | Needs CSRF check | Rate limit | Pretend only |
| --- | --- | --- | --- | --- |
| GET | `/health` | n/a (read) | – | – |
| GET | `/health/backups` | n/a (read) | – | – |
| GET | `/health/live` | n/a (read) | – | – |
| GET | `/health/ready` | n/a (read) | – | – |
| GET | `/health/release` | n/a (read) | – | – |
| POST | `/v1/auth/code` | yes | `auth_code` | – |
| POST | `/v1/auth/email/confirm` | yes | `auth_verify` | – |
| POST | `/v1/auth/recover` | yes | `auth_code` | – |
| POST | `/v1/auth/recover/code` | yes | `auth_code` | – |
| POST | `/v1/auth/recover/complete` | yes | `auth_verify` | – |
| POST | `/v1/auth/verify` | yes | `auth_verify` | – |
| GET | `/v1/avatars/{profileId}/{file}` | n/a (read) | – | – |
| GET | `/v1/dev/inbox` | n/a (read) | – | yes |
| POST | `/v1/dev/jobs/weekly-report` | – | – | yes |
| POST | `/v1/diagnostics/trace-probe` | – | – | yes |
| GET | `/v1/diagnostics/trace-probe/{jobId}` | n/a (read) | – | yes |
| POST | `/v1/events` | – | `analytics` | – |
| GET | `/v1/handles/{handle}/availability` | n/a (read) | `handles` | – |
| GET | `/v1/mock-provider/checkout/{reference}` | n/a (read) | – | yes |
| POST | `/v1/mock-provider/checkout/{reference}` | – | – | yes |
| GET | `/v1/profiles/{handle}` | n/a (read) | – | – |
| POST | `/v1/profiles/{handle}/report` | – | `reports` | – |
| POST | `/v1/tip-intents` | – | `intents` | – |
| POST | `/v1/tip-quotes` | – | `quotes` | – |
| POST | `/v1/vitals` | – | `analytics` | – |

#### Holder of the tip’s status token

| Method | Path | Needs CSRF check | Rate limit | Pretend only |
| --- | --- | --- | --- | --- |
| GET | `/v1/tips/{tipId}/status` | n/a (read) | – | – |

#### The payment provider (signed request body)

| Method | Path | Needs CSRF check | Rate limit | Pretend only |
| --- | --- | --- | --- | --- |
| POST | `/v1/webhooks/bachs` | – | – | yes |
| POST | `/v1/webhooks/mock` | – | – | yes |

#### The release check (bearer token; test copies only)

| Method | Path | Needs CSRF check | Rate limit | Pretend only |
| --- | --- | --- | --- | --- |
| POST | `/v1/release/runs` | – | – | – |
| POST | `/v1/release/runs/{id}/finish` | – | – | – |

#### Signed-in recipient (their own page and data only)

| Method | Path | Needs CSRF check | Rate limit | Pretend only |
| --- | --- | --- | --- | --- |
| POST | `/v1/auth/sign-out` | yes | – | – |
| DELETE | `/v1/me/account` | yes | – | – |
| GET | `/v1/me/activity` | n/a (read) | – | – |
| DELETE | `/v1/me/avatar` | yes | – | – |
| PUT | `/v1/me/avatar` | yes | `avatars` | – |
| GET | `/v1/me/dashboard` | n/a (read) | – | – |
| POST | `/v1/me/email` | yes | `auth_code` | – |
| GET | `/v1/me/exports/tips.csv` | n/a (read) | – | – |
| PUT | `/v1/me/handle` | yes | – | – |
| GET | `/v1/me/moments` | n/a (read) | – | – |
| POST | `/v1/me/moments/{id}/share` | yes | – | – |
| GET | `/v1/me/notification-preferences` | n/a (read) | – | – |
| PUT | `/v1/me/notification-preferences` | yes | – | – |
| GET | `/v1/me/notifications` | n/a (read) | – | – |
| POST | `/v1/me/notifications/read` | yes | – | – |
| POST | `/v1/me/page` | yes | – | – |
| PUT | `/v1/me/page/state` | yes | – | – |
| GET | `/v1/me/payment-account` | n/a (read) | – | – |
| POST | `/v1/me/payment-account/onboarding` | yes | `intents` | – |
| PUT | `/v1/me/phone` | yes | `auth_verify` | – |
| POST | `/v1/me/phone/code` | yes | `auth_code` | – |
| GET | `/v1/me/profile` | n/a (read) | – | – |
| PATCH | `/v1/me/profile` | yes | – | – |
| GET | `/v1/me/recovery` | n/a (read) | – | – |
| POST | `/v1/me/recovery/cancel` | yes | – | – |
| GET | `/v1/me/reports` | n/a (read) | – | – |
| GET | `/v1/me/reports/{week}` | n/a (read) | – | – |
| GET | `/v1/me/sessions` | n/a (read) | – | – |
| DELETE | `/v1/me/sessions/{id}` | yes | – | – |
| POST | `/v1/me/sessions/sign-out-others` | yes | – | – |
| PUT | `/v1/me/tip-amounts` | yes | – | – |
| GET | `/v1/me/tips` | n/a (read) | – | – |
| GET | `/v1/me/tips/{tipId}` | n/a (read) | – | – |
| POST | `/v1/me/tips/{tipId}/message/hide` | yes | – | – |
| POST | `/v1/me/tips/{tipId}/message/report` | yes | – | – |
| POST | `/v1/me/withdrawals` | yes | – | – |

#### Signed-in staff, before an admin grant

| Method | Path | Needs CSRF check | Rate limit | Pretend only |
| --- | --- | --- | --- | --- |
| POST | `/v1/ops/enrol` | yes | `auth_verify` | – |
| POST | `/v1/ops/enrol/confirm` | yes | `auth_verify` | – |
| POST | `/v1/ops/grant` | yes | `auth_verify` | – |
| GET | `/v1/ops/me` | n/a (read) | – | – |
| POST | `/v1/ops/sign-out` | yes | – | – |

#### Staff with a live admin grant and the permission

| Method | Path | Permission | Needs CSRF check | Rate limit | Pretend only |
| --- | --- | --- | --- | --- | --- |
| GET | `/v1/ops/audit` | `audit.view` | n/a (read) | – | – |
| POST | `/v1/ops/bachs/account-recovery` | `payments.recheck` | yes | – | – |
| POST | `/v1/ops/bachs/checkout-recovery` | `payments.recheck` | yes | – | – |
| GET | `/v1/ops/issues` | `issues.view` | n/a (read) | – | – |
| GET | `/v1/ops/issues/{id}` | `issues.view` | n/a (read) | – | – |
| POST | `/v1/ops/issues/{id}/notes` | `issues.view` | yes | – | – |
| POST | `/v1/ops/issues/{id}/resolve` | `issues.resolve` | yes | – | – |
| POST | `/v1/ops/issues/{id}/reveal` | `private.view` | yes | – | – |
| GET | `/v1/ops/market` | `analytics.view` | n/a (read) | – | – |
| POST | `/v1/ops/market` | `market.edit` | yes | – | – |
| PATCH | `/v1/ops/market/{id}` | `market.edit` | yes | – | – |
| POST | `/v1/ops/market/{id}/archive` | `market.edit` | yes | – | – |
| GET | `/v1/ops/market/series` | `analytics.view` | n/a (read) | – | – |
| GET | `/v1/ops/metrics/health` | `analytics.view` | n/a (read) | – | – |
| GET | `/v1/ops/metrics/visibility` | `analytics.view` | n/a (read) | – | – |
| GET | `/v1/ops/pages/{handle}` | `pages.plan` | n/a (read) | – | – |
| POST | `/v1/ops/pages/{profileId}/fee` | `fees.manage` | yes | – | – |
| POST | `/v1/ops/pages/{profileId}/fee-free` | `fees.manage` | yes | – | – |
| POST | `/v1/ops/pages/{profileId}/plan` | `pages.plan` | yes | – | – |
| GET | `/v1/ops/pages/{profileId}/pricing` | `fees.manage` | n/a (read) | – | – |
| POST | `/v1/ops/pages/{profileId}/suspend` | `pages.suspend` | yes | – | – |
| POST | `/v1/ops/pages/{profileId}/unsuspend` | `pages.suspend` | yes | – | – |
| POST | `/v1/ops/recheck` | `payments.recheck` | yes | – | – |
| GET | `/v1/ops/search` | `search.view` | n/a (read) | – | – |
| POST | `/v1/ops/users/{userId}/cancel-recovery` | `recoveries.cancel` | yes | – | – |

<!-- /generated:routes -->
<!-- prettier-ignore-end -->

"Pretend only" routes exist only while payments or messages are pretend (the mock checkout, the development inbox, diagnostics and the mock webhook). They are refused in production. On staging they are live behind the preview password, and the development inbox there also needs the release token (threat model, P8).

## Public routes, and why each is public

Reviewed one by one; the test lists them and fails when one is added.

| Route                                                                                  | Why it is public                                                      | What limits it                                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /health`, `/health/live`, `/health/ready`                                         | Load balancers and uptime checks                                      | Reveal only "up/down"                                                                                              |
| `GET /health/release`                                                                  | The release check and the watcher read the deployed version and mode  | No secrets; says nothing about people                                                                              |
| `GET /health/backups`                                                                  | The 15-minute watcher reads backup ages                               | Ages and counts only, no file names; cached 30 s                                                                   |
| `GET /v1/profiles/{handle}`                                                            | The public tipping page                                               | Only live, active pages; nothing else answers differently from "not found"                                         |
| `POST /v1/profiles/{handle}/report`                                                    | Anyone can report a page                                              | A reason from a fixed list; always answers the same; rate-limited                                                  |
| `GET /v1/handles/{handle}/availability`                                                | Choosing a handle before signing up                                   | Rate-limited                                                                                                       |
| `GET /v1/avatars/{profileId}/{file}`                                                   | Profile photos on public pages                                        | Only the current photo of a live, active page                                                                      |
| `POST /v1/tip-quotes`, `POST /v1/tip-intents`                                          | A supporter tips without an account                                   | Rate-limited; amounts and fees computed on the server; idempotency key                                             |
| `POST /v1/events`, `POST /v1/vitals`                                                   | Anonymous analytics and page speed                                    | A fixed list of names; honours Global Privacy Control and Do Not Track; rate-limited; off in production until D-07 |
| `POST /v1/auth/code`, `/v1/auth/verify`, `/v1/auth/recover*`, `/v1/auth/email/confirm` | Signing in and recovering an account happen before there is a session | Per-address and per-number limits; lockouts; codes expire                                                          |

## Where it is tested

| Rule                                                          | Test                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A recipient cannot read or change another recipient's data    | `tests/integration/profiles-api.test.mjs`, `tests/integration/dashboard-api.test.mjs`, `tests/integration/message-reports.test.mjs` |
| The admin area is invisible to everyone else                  | `tests/integration/ops-access.test.mjs`                                                                                             |
| A role without a permission gets 403                          | `tests/integration/ops-access.test.mjs`, `tests/integration/pro-tipping.test.mjs`                                                   |
| State-changing routes need the CSRF check                     | `tests/integration/ops-access.test.mjs`, `scripts/generate-docs.test.mjs` (every route)                                             |
| The public routes are the reviewed ones                       | `scripts/generate-docs.test.mjs`                                                                                                    |
| Rate limits                                                   | `tests/integration/auth-api.test.mjs`, `tests/integration/profile-reports.test.mjs`, `tests/integration/avatars-limit.test.mjs`     |
| Webhooks: forged, replayed, duplicate and out-of-order events | `tests/integration/webhooks.test.mjs`, `packages/payments/test/`                                                                    |
| The private-preview gate                                      | `tests/integration/preview-gate.test.mjs`, `apps/web/test/preview-gate.test.mjs`                                                    |
| Searches and reveals are audited                              | `tests/integration/ops-search.test.mjs`, `tests/integration/ops-issues.test.mjs`                                                    |
| Staff authentication and lockout                              | `tests/integration/ops-access.test.mjs`, `packages/database/test/integration/staff.test.mjs`                                        |

## Not done yet (needs a provider or a decision)

- Two-person approval for refunds and manual adjustments: needs two staff and a real provider (D-03 to D-06).
- Per-recipient payout holds and limits: needs the provider's verification model (D-06).
- Bot protection beyond rate limits: needs a captcha service.
- A separate read-only support role: a database row away, but its permissions are not decided.
