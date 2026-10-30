# Mail platform: pluggable providers, real delivery, email sign-in

**Status:** design, revised with the product owner's answers (30 October 2026), awaiting approval
**Companion:** `2026-10-30-payment-provider-switching-design.md` (shares the admin provider pattern in §7)
**Decision records to write:** ADR-0017 (mail platform and email identity). ADR-0015/0016 stay reserved for Phase 3 (payouts, reversals).

Who decided what is marked throughout: **(owner)** means the product owner said so in the 26–30 October conversations; **(design call)** means this document chose it and the owner can overturn it while reviewing.

## 1. Intent

TipMe writes emails today but sends none: every message lands in the development-only `pretend_outbox`. The product owner wants real email, built so the provider underneath can be swapped like payment providers are, managed from the admin screen, and broad enough to carry every email the product will need.

- **Plug-and-play providers (owner).** "Plug in Resend, it works. Plug in SES, it works. Plug in ZeptoMail, it works."
- **ZeptoMail first to market, SES next (owner).** The AWS project's SES is in sandbox with production access requested. ZeptoMail goes live first. SES is built at the same time and switched on when AWS approves.
- **Staging can use the SES sandbox meanwhile (owner),** which delivers only to addresses verified in SES.
- **Comprehensive (owner).** Welcome, onboarding guide, security notices, tip notifications, important-action notices, privacy notices and more, with preferences.
- **Email sign-in codes now (owner).** Recipient sign-in moves from phone codes to email codes until phone codes are built. Phone codes go on the TODO list.
- **Admin chooses the active provider (owner),** and a provider must pass a test send before it can become active (owner).
- **Per-account overrides (owner).** Admins can set particular accounts to a different provider from the system one. The owner said this applies to payments and to email; this document reads that as mail-provider overrides per account, e.g. for a recipient whose mailbox rejects one provider.
- **Lost email: recovery email plus staff (owner).** Recipients can add a recovery email in settings. Those without one are told in the notifications and attention area, the same way they're told payments aren't set up. Staff can also recover an account.
- **Tracking (owner).** "We need to track for audits, and to know how our users are doing." Every email's lifecycle is recorded (queued, sent, delivered, opened, clicked, bounced, complained) and visible in an ops email console.

## 2. Goals, non-goals, anti-goals

**Goals**

1. One mail provider interface, with ZeptoMail, Amazon SES and a pretend adapter, and a shared conformance test suite every adapter must pass.
2. Durable, encrypted, retried delivery that never sends from inside a database transaction and never logs codes, links, bodies or addresses.
3. A typed catalogue of email types (subject, text, HTML, data schema, category), with the four existing emails moved onto it and the new ones added.
4. Recipient preferences and one-click unsubscribe for optional email. Security and account email always goes out.
5. Bounce and complaint handling for every configured provider, feeding one suppression list.
6. An ops "Providers" page: see configured providers, send a test, confirm it arrived, switch the active provider, and watch failures and bounces.
7. Email-code sign-in for recipients, with the current protections (expiry, single use, lockouts, rate limits, no account enumeration).
8. A recovery email per account, self-service recovery through it, staff-assisted recovery, and an attention notice for accounts without one.
9. Tracking: a per-message event history, per-user email history and per-type delivery, open and click rates in an ops email console, kept for audit.
10. Per-account mail provider overrides, set by admins and audited.

**Non-goals (this project)**

- Phone codes (SMS/WhatsApp): **TODO (owner)**, added to the project TODO list.
- Marketing or newsletter email. ZeptoMail's terms forbid promotional mail (verified in its docs on 30 October 2026). The catalogue has a `marketing` category and consent field so it can come later through a provider that allows it, but no marketing email ships now **(design call)**.
- Email to supporters (guests). Checkout collects no supporter email today, so supporter receipts are a separate product decision.
- A Resend adapter. The interface is shaped so it fits, but it isn't built until wanted **(design call)**.
- Open and click tracking on `security` email. Codes, sign-in notices and recovery mail are never tracked, so no tracking pixel or rewritten link ever sits next to a credential **(design call)**. All other categories are tracked (owner).

**Anti-goals (would make this a failure even if it "works")**

- A sign-in code that arrives after it has expired, or that is visible in logs, Sentry, analytics or the admin screen.
- Switching to a provider that silently drops mail.
- A security notice skipped because someone unsubscribed from "emails".
- Someone typing a victim's address onto their own account and later being signed into it (see §8.4).
- Provider-specific code leaking outside its adapter.

## 3. Constraints

- **ADR-0004 messaging rules.** Codes and links are credentials: an encrypted durable queue, no logs or analytics, prompt expiry, non-enumerating responses, and no provider call inside a database transaction.
- **D-11 stays open.** Recording "ZeptoMail for launch, SES next" in `docs/00-DECISIONS.md` and the new ADR replaces the earlier "Resend for launch" note. Cost, deliverability to Nigerian inboxes, privacy and retention, and provider terms still need evidence, which this project doesn't claim to provide.
- **ZeptoMail facts (docs read 30 October 2026, now branded "Zoho CPaaS"):**
  - `POST {base}/v1.1/email` with `Authorization: Zoho-enczapikey <key>`. The base URL depends on the account's data centre, so it's a setting.
  - Fields: `from`, `to`, `reply_to`, `subject`, `textbody`, `htmlbody`, `client_reference`, `mime_headers`, `track_opens`, `track_clicks` and `bounce_address`. There is no idempotency key.
  - Errors are `TM_xxxx` codes with sub-codes. Examples: `SM_111` (unverified sender domain), `SERR_157` (invalid key), `LE_102` (credits exhausted), `SMI_115` (daily limit) and `SM_128` (account not yet reviewed).
  - Webhooks cover hard and soft bounces, opens, clicks and `fbl_complaint`. They're signed with HMAC-SHA256 in a `producer-signature: ts=…;s=…;s-algorithm=HmacSHA256` header, over the URL-decoded value of the single form-encoded body parameter. The timestamp is checked.
  - Transactional only.
- **SES facts:** SESv2 `SendEmail` in the project region `eu-north-1` (the AWS project rules forbid other regions). Sandbox: only verified recipients, low daily quota. Bounce, complaint and delivery events come through a configuration set and an SNS topic to an HTTPS endpoint, with SNS message signatures verified. `GetAccount` reports whether production access is enabled.
- **Repository rules.** AGENTS.md: contracts in `packages/contracts`, zod at ingress, strict TS, tests appropriate to risk, no gratuitous packages. A new dependency (the AWS SDK SESv2 client) is recorded in `docs/third-party-component-register.md`.
- **Production safety.** The pretend adapter is refused in production, the same rule as the mock payment provider.

## 4. Architecture overview

```
business operation (tx) ──► mail_messages row (encrypted to + data) ─┐
                                                                     │  worker: mail delivery loop
ops "send test" ─────────► mail_messages row (pinned provider) ──────┤  claim due rows (SKIP LOCKED)
                                                                     │  check suppression + preferences
                                                                     │  render template
                                                                     ▼  send OUTSIDE any tx
                                 provider_settings (active mail) ─► MailProvider adapter
                                                                     │   zeptomail | ses | mock
provider webhooks ─► /v1/webhooks/mail/:provider ─► verify ─► mail_provider_events ─► suppressions / message status
```

### 4.1 `packages/mail` (new)

- **`provider.ts`**: the interface. In outline:
  - `name: 'zeptomail' | 'ses' | 'mock'`.
  - `capabilities: { marketing: boolean }`.
  - `send(message: OutgoingMail): Promise<{ providerMessageId: string }>`, which throws `MailRejectedError` (permanent: bad address, unverified sender, suspended account) or `MailTemporaryError` (network, 5xx, rate or quota limits).
  - `verifyWebhook(rawBody, headers, now): MailWebhookVerification`, returning normalised events: `{ kind: 'hard_bounce' | 'soft_bounce' | 'complaint' | 'delivered' | 'opened' | 'clicked', address, providerMessageId?, reference?, providerEventId, occurredAt }`. Our `reference` travels with the message (ZeptoMail `client_reference`, SES message tag), so events match messages without relying on provider ids alone.
  - `OutgoingMail.tracking: boolean` turns opens and clicks on or off per message: ZeptoMail `track_opens`/`track_clicks`; SES uses two configuration sets, one with open and click tracking and one without.
  - `status(): Promise<{ sandbox: boolean | null; detail: string | null }>`.
- **`OutgoingMail`**: `{ to, from, replyTo, subject, text, html, headers (List-Unsubscribe and others), reference (our message id) }`. Adapters never see the template data, only rendered content.
- **Adapters:**
  - **`zeptomail/`**: `fetch` with a timeout. The base URL is configurable. Error codes map to rejected or temporary (credits exhausted and daily limit count as temporary, but get surfaced on the admin page as provider problems). The webhook parser verifies `producer-signature`.
  - **`ses/`**: `@aws-sdk/client-sesv2` `SendEmail` with the configuration set and our reference as a message tag. The SNS envelope is verified: signature v1/v2, a signing-cert URL on `sns.<region>.amazonaws.com` over HTTPS, and a TopicArn equal to the configured one. `SubscriptionConfirmation` is confirmed only for the configured TopicArn. SES bounce, complaint and delivery notifications are parsed.
  - **`mock/`**: accepts everything and hands the rendered message to a sink the worker gives it, which writes `pretend_outbox`. That keeps the existing pretend inbox, e2e tests and local development working.
- **`templates/`**: the catalogue (§6). One shared layout produces table-based HTML (≤600px, inline CSS, brand `#7A32F9`, works in dark-mode clients, real text not images), and every email also has a plain-text body. Rendering is plain TypeScript, so no React Email dependency **(design call)**.
- **`conformance.ts`**: a test kit every adapter runs against a fake transport (send success, a permanent rejection, a temporary failure, a timeout counted as temporary, webhook accept, tampered webhook, stale webhook, unknown event ignored).

### 4.2 Data model (migrations, additive)

- **`mail_messages`**
  - Identity: `id`, `type`, `category`, `user_id` (nullable), `dedupe_key` (unique).
  - Recipient and content: `to_sealed` (the address, sealed), `to_hint` (masked, e.g. `t•••@example.com`), `data_sealed` (template data, sealed), `pinned_provider` (set only for tests).
  - Delivery state: `status` (`queued | sending | sent | failed | suppressed | skipped | expired | bounced | complained`), `provider` (recorded at send), `provider_message_id`, `attempts`, `next_attempt_at`, `last_error` (a code, never provider text with addresses in it), `expires_at` (sign-in codes: the code's expiry).
  - Timestamps: `created_at`, `sent_at`.
  - Sealing uses the existing `secret-box` with a new `MAIL_SEAL_KEY`. Sealed fields are wiped 7 days after a final status, keeping metadata for ops **(design call)**.
- **`mail_suppressions`**: `address_hmac` (the primary key: an HMAC of the normalised address, so the list holds no plain addresses), `reason` (`hard_bounce | complaint | repeated_soft_bounce | manual`), `provider`, `created_at`, `note` (manual only). Three soft bounces in 7 days for the same address count as a suppression **(design call)**.
- **`mail_message_events`** (the tracking and audit trail): an append-only `id`, `message_id` (nullable for an event that matches no message), `kind` (`queued | sent | send_failed | delivered | opened | clicked | soft_bounce | hard_bounce | complaint | suppressed | skipped_preference | expired`), `provider`, `provider_event_id` (`(provider, provider_event_id)` unique when present, for dedupe), `link_key` (for clicks: which named link in the template, never the URL with its token), `occurred_at` and `received_at`. Only normalised fields are kept. Retained for 2 years **(design call)**. Opens are reported as "opened at least once"; Apple Mail Privacy Protection and image proxies make open counts approximate, and the console says so.
- **`provider_overrides`** (shared with payments): `kind` (`mail | payment`), `user_id`, `provider`, `set_by`, `reason` and `created_at`, unique on `(kind, user_id)`.
- **Recovery email:** `users.recovery_email` and `users.recovery_email_verified_at` (unique among verified recovery addresses of live accounts, and never the same as the account's sign-in email).
- **`mail_preferences`**: per user, `engagement` and `marketing` booleans (engagement on by default; marketing off by default and opt-in only). The existing per-type toggles on `profiles` (`notify_tip_emails`, `notify_weekly_reports`, `notify_milestones`) stay and keep their meaning.
- **`provider_settings`** (shared with the payment project): `kind` (`mail | payment`, primary key), `active_provider`, `changed_by`, `changed_at`, `reason`. No row means the server default.
- **`provider_tests`** (shared): `id`, `kind`, `provider`, `started_by`, `started_at`, `target_hint`, `token_sha256`, `status` (`pending | confirmed | failed | expired`), `confirmed_at`, `failure_code`, plus `message_id` for mail (or `tip_id` for payments).

### 4.3 Delivery

- **`enqueueMail(tx, { type, to, userId?, data, dedupeKey, expiresAt? })`** replaces every `writePretendMessage(…channel: 'email'…)`. It validates `data` against the type's schema, seals it, and inserts the row in the caller's transaction, so the mail exists exactly when the change that caused it commits.
- **The worker's mail loop:**
  1. Poll about every 500 ms. Claim due rows with `FOR UPDATE SKIP LOCKED` and mark them `sending` in a short transaction.
  2. Before sending, re-check suppression and preferences, so a change after enqueue still counts. Expired rows become `expired` and are never sent. A sign-in code isn't sent after its code has expired.
  3. Pick the provider: `pinned_provider` (tests), otherwise the user's mail override (`provider_overrides`), otherwise the active mail provider (read from `provider_settings`, cached for a few seconds). An override to a provider that's no longer configured falls back to the active provider and is flagged on the console.
  4. Render the email and send it outside any transaction.
  5. Record `sent` (with the provider message id), or a temporary failure with backoff (30 s, 2 min, 10 min, 1 h, 6 h; give up after 6 attempts as `failed`), or `failed` straight away on a permanent rejection.
- **Duplicates.** Neither provider offers idempotency keys, so a crash between "provider accepted" and "row marked sent" can send twice. A duplicate notice or code email is acceptable; a lost one isn't. Rows stuck in `sending` for more than 2 minutes return to `queued` **(design call)**.
- **Why a dedicated table, not the BullMQ outbox:** each email needs its own state, schedule, expiry, provider and audit trail, and staff need to see failures. ADR-0004 asks for exactly this encrypted durable queue.

### 4.4 Webhooks

- `POST /v1/webhooks/mail/zeptomail` and `POST /v1/webhooks/mail/ses` (raw body). Both are verified before anything else and stored once.
  - A hard bounce or complaint adds a suppression and marks the message `bounced` or `complained`.
  - A soft bounce is counted.
  - `delivered`, `opened` and `clicked` are appended to `mail_message_events` (ZeptoMail sends opens and clicks; SES sends deliveries, opens and clicks through the configuration set).
  - Every event, including bounces and complaints, is appended to `mail_message_events`.
- Webhooks are accepted for **every configured provider, active or not**, so bounces for mail sent before a switch still count.
- Unknown or unverifiable requests get a 4xx and are logged by name only.

### 4.5 Configuration

- **Shared:** `MAIL_DEFAULT_PROVIDER` (`mock | zeptomail | ses`, used until staff pick one), `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` and `MAIL_SEAL_KEY`.
- **ZeptoMail:** `ZEPTOMAIL_API_KEY`, `ZEPTOMAIL_API_BASE`, `ZEPTOMAIL_WEBHOOK_KEY` and `ZEPTOMAIL_BOUNCE_ADDRESS` (optional).
- **SES:** `SES_REGION` (default `eu-north-1`), `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY` (or the machine's role), `SES_CONFIGURATION_SET` and `SES_SNS_TOPIC_ARN`.
- **Where credentials live:** the API needs webhook secrets and the provider list; the worker needs the send credentials. A provider is "configured" only when all of its keys are present. Partial configuration fails startup with a clear message, as Bachs does.
- **Production:** `mock` is refused, and `MESSAGING_PROVIDER` is retired.
- **Addresses (owner approved, 30 October):** `TipMe <hello@mail.usetipme.xyz>` with Reply-To `support@usetipme.xyz`, and `TipMe Staging <hello@staging-mail.usetipme.xyz>` for staging.
- **SES:** two configuration sets, `SES_CONFIGURATION_SET` (opens and clicks tracked) and `SES_CONFIGURATION_SET_UNTRACKED` (security mail), both publishing to the SNS topic.

## 5. Ops "Providers" page — mail section

Route `/ops/providers`, added to the ops navigation. A new permission, `providers.manage`, is required to test, switch or set overrides; `issues.view` is enough to view. New permissions (`providers.manage`, `recoveries.manage`) go to the Owner role automatically.

- **Configured providers.** Each shows its name, whether it's active, its status (for example "SES: sandbox, only verified recipients", "ZeptoMail: account status unknown until a test"), its last test result and time, and its counts for the last 24 hours (sent, failed, bounced, complained).
- **Send a test.**
  - Staff choose a provider and a recipient address: their own verified email by default, or another address they type in.
  - TipMe enqueues a `provider_test` email pinned to that provider. It goes through the real worker path, so the test proves the worker's credentials too.
  - The email contains a confirmation link `/ops/providers/confirm#t=<token>` that works only for a signed-in staff member with ops access. Opening it marks the test `confirmed`.
  - The page shows the test moving through queued, sent and confirmed, or failed with the provider's error code.
- **Switch.**
  - Allowed only to a provider with a test confirmed in the last 24 hours. Staff must give a reason. The switch is audited (`mail_provider.switched`, recording from, to and the reason).
  - Switching to `mock` is refused in production.
  - Switching to an SES account still in sandbox is refused in production and allowed with a warning elsewhere **(design call)**.
  - Switching back is a normal switch; a previously confirmed test still counts if it's within 24 hours.
- **Recent failures.** Type, masked recipient, provider, error code and time. Never the content.
- **Suppressions.** Look up an address (it's hashed for the lookup), see why it's suppressed, and remove it with a reason (audited). A complaint suppression asks for extra confirmation before removal.
- **Overrides.** Pin an account to a mail provider with a reason, or remove the pin. Audited (`mail_provider.override_set` and `mail_provider.override_removed`). Pinned accounts are listed with their provider.

### 5.1 Email console (tracking and audit)

Route `/ops/email`. It needs `issues.view` to view and `private.view` to see a full address (revealing is audited, like other private-data reveals).

The owner wants to audit every email TipMe has sent without going to the provider: "all the mails that went out that day, that week, that month", with the trend, e.g. "about 85,000 this month, 82% more than last month" **(owner)**.

- **Periods.** Today, yesterday, this week, last week, this month, last month and a custom range, as calendar periods in Lagos time (like the weekly report).
- **Headline numbers** for the period, each compared with the period before as a count and a percentage change ("85,214 sent this month · +82% vs October"):
  - sent, delivered, bounced, complained, opened at least once, clicked and failed;
  - delivery, open and click rates;
  - queue age.
    Open rates carry a note that privacy proxies make them approximate.
- **Charts:** emails per day (or per hour for "today") over the period, broken down by status, with the previous period shown faintly for comparison.
- **Breakdowns** by type, category and provider, each with its own count and change.
- **Every email in the period:** a paginated list of all messages that went out in the chosen period, with time, type, masked recipient, account, provider, status and last event. It can be filtered by type, status, provider or account, and opens the message timeline.
- **Kept long enough to audit:** message metadata (type, category, account, masked recipient, provider, status, times) and its events are kept **2 years**. Only the sealed address and template data are wiped after 7 days (§4.2) **(design call)**.
- **Fast at volume:** at tens of thousands of emails a month, monthly views read from a `mail_daily_stats` rollup (date in Lagos, type, category, provider, event kind, count). It's updated in the same transaction as each event and can be rebuilt from `mail_message_events`. The message list uses indexes on `(created_at)`, `(type, created_at)` and `(user_id, created_at)` **(design call)**.
- **Message search** by type, status, provider, date or account (handle or user id). Each message shows its timeline from `mail_message_events`: queued, sent through X, delivered, opened, which link was clicked, bounced. It also shows the masked recipient and the provider message id. **Never the body, a code or a link with its token.**
- **Account view:** every email sent to an account, newest first, linked from the ops search and the issue pages. "Did they get the email?" is answered here.
- **Export** (CSV) of the aggregate numbers and of the period's message list (masked recipients only) for reporting and audit. Exports are audited.
- **Audit:** console views of private data are audited, and switches, overrides and suppression removals already are.

## 6. The email catalogue

Each email type has: an id, a category, a trigger, a data schema, a subject, a text body and an HTML body. **Categories decide whether preferences apply:**

| Category                                                   | Can be turned off?                         | Unsubscribe header        |
| ---------------------------------------------------------- | ------------------------------------------ | ------------------------- |
| `security`                                                 | Never                                      | No                        |
| `account` (important actions and legal notices)            | Never                                      | No                        |
| `transactional` (about the person's own money or activity) | Per-type toggle where one exists           | Yes, for toggleable types |
| `engagement` (guides, reports, milestones)                 | Yes: category toggle plus per-type toggles | Yes, one-click (RFC 8058) |
| `marketing`                                                | Opt-in only. Nothing ships now.            | Yes                       |

**Launch catalogue** (★ marks one that exists today as a pretend email):

| Type                                                       | Category      | Sent when                                                                                                             | Notes                                                                         |
| ---------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `sign_in_code`                                             | security      | A recipient asks for a sign-in code                                                                                   | 6 digits, 10 min, sent ahead of other queued mail **(design call)**           |
| `email_change_code`                                        | security      | A signed-in recipient adds or changes their email                                                                     | Sent to the new address                                                       |
| `email_changed_notice`                                     | security      | The sign-in email changed                                                                                             | Sent to the **old** address, with what to do if it wasn't them                |
| `new_sign_in_notice`                                       | security      | A sign-in from a device not seen before                                                                               | Device label and approximate time, no IP shown                                |
| `staff_access_notice`                                      | security      | Ops access granted, changed or removed                                                                                | ADR-0010                                                                      |
| `account_deleted_notice`                                   | security      | The account is deleted                                                                                                | Last email ever sent to the account                                           |
| `recovery_email_code`                                      | security      | A recipient adds or changes their recovery email                                                                      | Sent to the recovery address                                                  |
| `recovery_code`                                            | security      | "Can't get into your email?" recovery started                                                                         | Sent to the recovery address                                                  |
| `recovery_started_notice`                                  | security      | A recovery was started for the account                                                                                | Sent to the sign-in address, with how to cancel                               |
| `recovery_completed_notice`                                | security      | The sign-in email was changed by recovery (self-service or staff)                                                     | Sent to both old and new addresses                                            |
| `welcome`                                                  | account       | First sign-in that creates an account                                                                                 | What TipMe is, the next step (create a page)                                  |
| `payment_setup_needed`                                     | account       | A page exists but can't take tips (no ready payment account), 24 h after creation                                     | The "very visible notice" from 26 October, in email form                      |
| `payment_account_ready`                                    | account       | Payment account becomes ready                                                                                         | "You can receive tips now"                                                    |
| `payment_account_action_needed`                            | account       | Payment account becomes restricted or needs information                                                               | Links to settings                                                             |
| `page_paused` / `page_restored`                            | account       | Staff pause or restore a page                                                                                         | Reason category only                                                          |
| `privacy_notice` / `terms_update`                          | account       | Staff publish a policy change                                                                                         | Sent to all active users by an ops action (audited), at most once per version |
| `tip_received` ★                                           | transactional | `tip.succeeded`                                                                                                       | Existing `notify_tip_emails` toggle                                           |
| `withdrawal_paid` / `withdrawal_failed`                    | transactional | Payout outcomes                                                                                                       | Money: not toggleable                                                         |
| `tip_reversed`                                             | transactional | A refund or dispute on a paid tip (`payment_reversed`)                                                                | Not toggleable                                                                |
| `weekly_report` ★                                          | engagement    | Monday report                                                                                                         | Existing `notify_weekly_reports` toggle                                       |
| `milestone`                                                | engagement    | Milestone moments                                                                                                     | Existing `notify_milestones` toggle                                           |
| `onboarding_day_1`, `onboarding_day_3`, `onboarding_day_7` | engagement    | A daily job: account exists but the next step isn't done (no page; page but no payment account; ready but no tip yet) | Each step sent at most once per user, skipped once the step is done           |
| `provider_test`                                            | (internal)    | Ops test send                                                                                                         | Never subject to preferences or suppression checks other than hard bounce     |

The existing ★ "confirm your email" and "get back into TipMe" emails are retired by email sign-in (§8). "Your number is about to change" goes with them, because the phone-recovery flow it belongs to is paused until phone codes return.

**Copy.** Plain, warm and specific, following the design constitution's voice. Subjects say what happened ("You got a ₦4,500 tip"). No exclamation-mark marketing tone in security mail. Every email footer has: why you got it, a link to email settings (for toggleable categories), and support@. Final copy is reviewed with the owner as part of the build.

**Unsubscribe.**

- Optional email carries `List-Unsubscribe: <https://…/v1/mail/unsubscribe?t=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- The token is an HMAC of user, type and category, and doesn't expire.
- One click turns off that type's toggle, or the category when the type has none, and shows a confirmation page with a link to all email settings.
- **Settings page:** a new "Emails" section lists every toggleable type and the engagement category. Security and account email is shown as "always sent" so nobody wonders why it can't be turned off.

## 7. Provider administration pattern (shared with payments)

The payment project reuses `provider_settings`, `provider_tests`, the `/ops/providers` page shell, the audit actions and the permission. Mail is built first. The payment section is added by the companion design.

## 8. Email sign-in (replacing phone codes until they return)

### 8.1 Flow

- The `/sign-in` page asks for an email address. Phone shows "Coming soon". `POST /v1/auth/code { email }` always answers 202 (a malformed address is answered the same way and nothing is stored). `POST /v1/auth/verify { email, code, deviceLabel? }` signs in, creating the account on first use, with `email_verified_at` set: using the code proves ownership.
- **Kept rules:** a 10-minute code; only the latest unused code counts; 3 codes per address per hour; a 15-minute lockout after 5 wrong codes; per-IP rate limits; HMAC-stored codes; timing-safe comparison; a new session token at every sign-in.
- **Generalised:** `sign_in_codes` and `sign_in_lockouts` move to an `identifier` column (`email:<address>` or `phone:<e164>`), so phone codes slot back in later. Existing phone rows are migrated in place.

### 8.2 Account identity

- `users.email` becomes the sign-in identity, unique across **verified** addresses of live accounts (a partial unique index on `lower(email) WHERE email_verified_at IS NOT NULL AND deleted_at IS NULL`). `phone_e164` stays, nullable and unique, for later.
- Payment setup's "confirm your email first" step disappears for anyone who signed in by email.

### 8.3 Changing the email

A signed-in recipient enters a new address and gets an `email_change_code` there. When it's confirmed: the email changes, the old address gets `email_changed_notice`, and every other session ends. This mirrors today's phone change **(design call)**.

### 8.4 The unverified-address takeover case (a must-have)

An unverified address on account A must never let anyone sign in to A. When someone proves an address with a code, any **unverified** claim of the same address on other accounts is cleared in the same transaction, and they sign in to (or create) the account where it's verified.

### 8.5 Recovery email and lost access (owner)

**Adding a recovery email.** Settings has a "Recovery email" section. The recipient enters a second address and confirms it with a `recovery_email_code` sent there. It must differ from the sign-in email. Changing or removing it needs a fresh code to the sign-in email, so someone with a stolen session can't quietly swap it **(design call)**.

**Nudging people to add one (owner).** An account with no confirmed recovery email gets:

- an item in the notifications tab ("Add a recovery email so you can get back in if you lose access to your email");
- an attention item in the dashboard checklist and badge, the same pattern as "payments aren't set up" (PR #29).
  Both disappear once a recovery email is confirmed. The nudge is in-app only, with no email **(design call)**: an email asking someone to protect their email adds little.

**Self-service recovery.**

1. "Can't get into your email?" on the sign-in page asks for the sign-in address. The answer is the same whether or not an account or recovery email exists.
2. If the account has a confirmed recovery email, a `recovery_code` goes there.
3. With that code, the recipient enters a **new sign-in address** and confirms it with a code sent to the new address.
4. The change waits **24 hours** (the existing `RECOVERY_HOLD_MS` rule), during which the old address gets `recovery_started_notice` and any signed-in session can cancel it. Both addresses get `recovery_completed_notice` when it happens, and every session ends.
   Staff accounts are never recovered this way (ADR-0010, unchanged).

**Staff-assisted recovery (owner).** For accounts without a recovery email, or when it's also lost:

- From the account's ops view, staff with `recoveries.manage` (a new permission) start "Move sign-in email". They record the identity checks done and a reason, and enter the new address.
- The new address must confirm with a code, and the same 24-hour hold, notices and cancellation apply.
- Every step is audited. Staff can't sign in as the user or see codes.

The old phone-number recovery screens (`/recover`) are replaced by this flow. Phone recovery returns with phone codes (TODO).

### 8.6 Existing accounts

Production has no users. Staging test accounts that only have a phone get an email via a one-off ops script (`pnpm ops:set-email`, audited) **(design call)**. Staff accounts sign in by email too, then pass the ops authenticator step as today (ADR-0010).

## 9. Observability and privacy

- **Logs** carry message id, type, category, provider, status, error code and timings. Never an address (only the masked hint, and only where needed), a code, a link, the subject of a security mail, or a body.
- **Sentry:** unexpected adapter errors, with the same scrubbing as today.
- **Metrics (counters):** queued, sent, failed, bounced and complained, by provider and category. Queue age is shown on the ops page.
- **Privacy documentation:** Zoho (ZeptoMail) and AWS (SES) are added as processors, and retention (§4.2) is recorded. This doesn't close D-11's privacy review.
- **Tracking disclosure:** the privacy notice says TipMe records whether emails are delivered, opened and clicked, and that security emails aren't tracked. Event history is kept 2 years; sealed message contents 7 days **(design call)**.

## 10. Testing

- **Adapters:** the conformance kit for every adapter. ZeptoMail and SES signature tests use signatures worked out from the documented algorithm, plus tampered, stale and wrong-topic cases. Error-code mapping tables are covered.
- **Delivery (integration, with Postgres):**
  - the email exists only when its cause commits;
  - retries with backoff;
  - an expired sign-in code isn't sent;
  - suppression and preferences are checked at send time;
  - stuck `sending` rows are recovered;
  - a pinned test goes to the pinned provider;
  - data is sealed in storage and wiped after retention.
- **Webhooks:** a hard bounce suppresses, three soft bounces suppress, a complaint suppresses, and a duplicate event changes nothing. A bounce for a previously active provider still counts. Opens, clicks and deliveries are recorded against the right message through our reference.
- **Tracking:**
  - security email is sent with tracking off (ZeptoMail flags off; SES untracked configuration set);
  - other email is sent with tracking on;
  - the console never shows a body, code or tokenised link;
  - address reveals are audited.
- **Overrides:** an overridden account's mail goes through its pinned provider; an override to an unconfigured provider falls back and is flagged; setting and removing overrides is audited.
- **Recovery:**
  - a recovery email can't equal the sign-in email;
  - changing it needs a sign-in-email code;
  - self-service recovery answers identically for unknown addresses;
  - the 24-hour hold applies, and a cancel from any session works;
  - the notices go to both addresses;
  - staff-assisted recovery needs the permission and is audited;
  - staff accounts are refused;
  - the notification and attention item appears without a recovery email and clears once one is confirmed.
- **Ops:**
  - a switch without a confirmed test is refused;
  - an expired test is refused;
  - mock is refused in production;
  - permission checks hold;
  - switches and suppression removals are audited;
  - confirmation needs an ops session.
- **Sign-in:**
  - enumeration-safe responses;
  - lockouts and rate limits;
  - the §8.4 takeover case;
  - an email change notifies the old address and ends other sessions.
- **Catalogue:** every type renders text and HTML for its sample data (snapshot), escapes user-supplied names, and has a subject.
- **End to end:** sign in by email through the pretend inbox (replacing the phone e2e), and toggle a preference.
- **Staging smoke test** (manual, recorded): an SES sandbox send to a verified address, and a ZeptoMail send once its account exists. Each goes through the ops test flow, and a real bounce test uses the provider's bounce simulator address.

## 11. Delivery order (separate PRs)

1. `packages/mail` (interface, pretend adapter, conformance kit, layout), the `mail_messages` queue and worker loop, and the existing ★ emails moved onto it. Behaviour is unchanged with `mock`.
2. ZeptoMail and SES adapters, webhooks, suppressions and configuration.
3. `provider_settings`, `provider_tests` and `provider_overrides`, the ops Providers page (mail), test sends, switching and overrides.
4. Tracking: `mail_message_events`, open and click handling, and the ops email console (§5.1).
5. Email sign-in (§8.1–8.4, 8.6), with the sign-in page, settings email change, and the takeover protection.
6. Recovery email, self-service and staff recovery, and the notification and attention item (§8.5).
7. The rest of the catalogue, preferences, unsubscribe, onboarding series and policy-notice action.
8. Docs: ADR-0017, decision-log update, `docs/runbooks/mail.md` (DNS: SPF, DKIM and DMARC per provider; ZeptoMail agent and webhook setup; SES identity, configuration set, SNS topic and subscription; switching and rollback), the privacy and processor list, and the third-party register. Plus the staging enablement checklist.

Phone codes are added to the TODO list in `docs/superpowers/plans/2026-10-28-audit-fixes.md` (phase table) and `docs/agent/ACTIVE_TASK.md`.

## 12. Answers and what's still open

**Answered by the owner (30 October):**

- Lost email: recovery email plus staff recovery (§8.5).
- Addresses approved (§4.5).
- Tracking wanted (§5.1).
- Per-account overrides (§5).
- Credentials and DNS: the builder sets up with the access available.

**Still needed to finish setup (not to build):**

- **AWS:** the `tipme` profile's session expired. Signing in again (`aws login`) lets the builder create the SES identities, DKIM, configuration sets and SNS topic in `eu-north-1`, and the send-only access for the staging server.
- **Cloudflare DNS for `usetipme.xyz`:** the builder has no access. It needs an API token with DNS edit for that zone (or the owner adds the records the runbook lists). Found 30 October: `_dmarc.usetipme.xyz` has **two** DMARC records, which makes receivers ignore both. They need merging into one.
- **ZeptoMail:** no account access. Someone has to create the account and agent, verify `mail.usetipme.xyz`, and generate the Send Mail API key and webhook authentication key. Then note the account's region for `ZEPTOMAIL_API_BASE`.
- **Marketing (unanswered):** no marketing email at launch stays the design call, since ZeptoMail forbids it.

## 13. Left to the builder

Exact table and column names beyond those above; backoff jitter; the poll interval within 250 ms–1 s; HTML layout details within the design constitution; the error-code mapping tables (from the providers' docs); the ops page layout following existing ops pages; and test file organisation.
