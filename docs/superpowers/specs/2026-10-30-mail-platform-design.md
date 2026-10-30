# Mail platform: pluggable providers, real delivery, email sign-in

**Status:** design, awaiting the product owner's approval (30 October 2026)
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

## 2. Goals, non-goals, anti-goals

**Goals**

1. One mail provider interface, with ZeptoMail, Amazon SES and a pretend adapter, and a shared conformance test suite every adapter must pass.
2. Durable, encrypted, retried delivery that never sends from inside a database transaction and never logs codes, links, bodies or addresses.
3. A typed catalogue of email types (subject, text, HTML, data schema, category), with the four existing emails moved onto it and the new ones added.
4. Recipient preferences and one-click unsubscribe for optional email. Security and account email always goes out.
5. Bounce and complaint handling for every configured provider, feeding one suppression list.
6. An ops "Providers" page: see configured providers, send a test, confirm it arrived, switch the active provider, and watch failures and bounces.
7. Email-code sign-in for recipients, with the current protections (expiry, single use, lockouts, rate limits, no account enumeration).

**Non-goals (this project)**

- Phone codes (SMS/WhatsApp): **TODO (owner)**, added to the project TODO list.
- Marketing or newsletter email. ZeptoMail's terms forbid promotional mail (verified in its docs on 30 October 2026). The catalogue has a `marketing` category and consent field so it can come later through a provider that allows it, but no marketing email ships now **(design call)**.
- Email to supporters (guests). Checkout collects no supporter email today, so supporter receipts are a separate product decision.
- A Resend adapter. The interface is shaped so it fits, but it isn't built until wanted **(design call)**.
- Open and click tracking. It is off in every adapter: it adds tracking pixels and rewritten links, which privacy review hasn't covered **(design call)**.

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
  - `verifyWebhook(rawBody, headers, now): MailWebhookVerification`, returning normalised events: `{ kind: 'hard_bounce' | 'soft_bounce' | 'complaint' | 'delivered', address, providerMessageId?, providerEventId, occurredAt }`.
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
- **`mail_provider_events`**: `(provider, provider_event_id)` unique, `kind`, `message_id` (nullable), `received_at`. Stored for dedupe and the admin counts. No payload is stored beyond the normalised fields.
- **`mail_preferences`**: per user, `engagement` and `marketing` booleans (engagement on by default; marketing off by default and opt-in only). The existing per-type toggles on `profiles` (`notify_tip_emails`, `notify_weekly_reports`, `notify_milestones`) stay and keep their meaning.
- **`provider_settings`** (shared with the payment project): `kind` (`mail | payment`, primary key), `active_provider`, `changed_by`, `changed_at`, `reason`. No row means the server default.
- **`provider_tests`** (shared): `id`, `kind`, `provider`, `started_by`, `started_at`, `target_hint`, `token_sha256`, `status` (`pending | confirmed | failed | expired`), `confirmed_at`, `failure_code`, plus `message_id` for mail (or `tip_id` for payments).

### 4.3 Delivery

- **`enqueueMail(tx, { type, to, userId?, data, dedupeKey, expiresAt? })`** replaces every `writePretendMessage(…channel: 'email'…)`. It validates `data` against the type's schema, seals it, and inserts the row in the caller's transaction, so the mail exists exactly when the change that caused it commits.
- **The worker's mail loop:**
  1. Poll about every 500 ms. Claim due rows with `FOR UPDATE SKIP LOCKED` and mark them `sending` in a short transaction.
  2. Before sending, re-check suppression and preferences, so a change after enqueue still counts. Expired rows become `expired` and are never sent. A sign-in code isn't sent after its code has expired.
  3. Pick the provider: `pinned_provider`, otherwise the active mail provider (read from `provider_settings`, cached for a few seconds).
  4. Render the email and send it outside any transaction.
  5. Record `sent` (with the provider message id), or a temporary failure with backoff (30 s, 2 min, 10 min, 1 h, 6 h; give up after 6 attempts as `failed`), or `failed` straight away on a permanent rejection.
- **Duplicates.** Neither provider offers idempotency keys, so a crash between "provider accepted" and "row marked sent" can send twice. A duplicate notice or code email is acceptable; a lost one isn't. Rows stuck in `sending` for more than 2 minutes return to `queued` **(design call)**.
- **Why a dedicated table, not the BullMQ outbox:** each email needs its own state, schedule, expiry, provider and audit trail, and staff need to see failures. ADR-0004 asks for exactly this encrypted durable queue.

### 4.4 Webhooks

- `POST /v1/webhooks/mail/zeptomail` and `POST /v1/webhooks/mail/ses` (raw body). Both are verified before anything else and stored once.
  - A hard bounce or complaint adds a suppression and marks the message `bounced` or `complained`.
  - A soft bounce is counted.
  - `delivered` (SES only) updates the counts.
- Webhooks are accepted for **every configured provider, active or not**, so bounces for mail sent before a switch still count.
- Unknown or unverifiable requests get a 4xx and are logged by name only.

### 4.5 Configuration

- **Shared:** `MAIL_DEFAULT_PROVIDER` (`mock | zeptomail | ses`, used until staff pick one), `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` and `MAIL_SEAL_KEY`.
- **ZeptoMail:** `ZEPTOMAIL_API_KEY`, `ZEPTOMAIL_API_BASE`, `ZEPTOMAIL_WEBHOOK_KEY` and `ZEPTOMAIL_BOUNCE_ADDRESS` (optional).
- **SES:** `SES_REGION` (default `eu-north-1`), `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY` (or the machine's role), `SES_CONFIGURATION_SET` and `SES_SNS_TOPIC_ARN`.
- **Where credentials live:** the API needs webhook secrets and the provider list; the worker needs the send credentials. A provider is "configured" only when all of its keys are present. Partial configuration fails startup with a clear message, as Bachs does.
- **Production:** `mock` is refused, and `MESSAGING_PROVIDER` is retired.
- **Suggested addresses** (from the 29 October recommendation): `TipMe <hello@mail.usetipme.xyz>` with Reply-To `support@usetipme.xyz`, and `TipMe Staging <hello@staging-mail.usetipme.xyz>` for staging.

## 5. Ops "Providers" page — mail section

Route `/ops/providers`, added to the ops navigation. A new permission, `providers.manage`, is required to test or switch; `issues.view` is enough to view. The Owner role gets it automatically.

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

### 8.5 Lost access to the email

There's no self-service recovery while phone codes are TODO. "Can't get in?" explains how to contact support, and staff use the existing recovery-issue flow to move an account to a new address after checking identity, audited. **This is question Q1 for the owner.** The phone-number recovery screens (`/recover`) are hidden while phone codes are TODO.

### 8.6 Existing accounts

Production has no users. Staging test accounts that only have a phone get an email via a one-off ops script (`pnpm ops:set-email`, audited) **(design call)**. Staff accounts sign in by email too, then pass the ops authenticator step as today (ADR-0010).

## 9. Observability and privacy

- **Logs** carry message id, type, category, provider, status, error code and timings. Never an address (only the masked hint, and only where needed), a code, a link, the subject of a security mail, or a body.
- **Sentry:** unexpected adapter errors, with the same scrubbing as today.
- **Metrics (counters):** queued, sent, failed, bounced and complained, by provider and category. Queue age is shown on the ops page.
- **Privacy documentation:** Zoho (ZeptoMail) and AWS (SES) are added as processors, and retention (§4.2) is recorded. This doesn't close D-11's privacy review.

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
- **Webhooks:** a hard bounce suppresses, three soft bounces suppress, a complaint suppresses, and a duplicate event changes nothing. A bounce for a previously active provider still counts.
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
3. `provider_settings` and `provider_tests`, the ops Providers page (mail), test sends and switching.
4. Email sign-in (§8), with the sign-in page, settings email change, and the takeover protection.
5. The rest of the catalogue, preferences, unsubscribe, onboarding series and policy-notice action.
6. Docs: ADR-0017, decision-log update, `docs/runbooks/mail.md` (DNS: SPF, DKIM and DMARC per provider; ZeptoMail agent and webhook setup; SES identity, configuration set, SNS topic and subscription; switching and rollback), the privacy and processor list, and the third-party register. Plus the staging enablement checklist.

Phone codes are added to the TODO list in `docs/superpowers/plans/2026-10-28-audit-fixes.md` (phase table) and `docs/agent/ACTIVE_TASK.md`.

## 12. Open questions for the owner

1. **Q1 — lost email access:** staff-assisted recovery (§8.5) until phone codes return, or no recovery at all until then?
2. **Q2 — credentials and DNS:**
   - a ZeptoMail account, agent and API key, with its data-centre region, the sending domain verified, and a webhook authentication key;
   - for SES on the staging server, an IAM user (or role) with `ses:SendEmail` and `ses:GetAccount` only. The new AWS project experience may restrict IAM users.
3. **Q3 — addresses:** confirm `hello@mail.usetipme.xyz` (Reply-To `support@usetipme.xyz`) and `hello@staging-mail.usetipme.xyz`.
4. **Q4 — marketing:** confirm no marketing or newsletter email at launch (ZeptoMail forbids it).

## 13. Left to the builder

Exact table and column names beyond those above; backoff jitter; the poll interval within 250 ms–1 s; HTML layout details within the design constitution; the error-code mapping tables (from the providers' docs); the ops page layout following existing ops pages; and test file organisation.
