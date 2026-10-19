# ADR-0003 — Recipient authentication and sessions

Date: 2026-10-19
Status: ACCEPTED for development (PR-008). Delivery is pretend until a messaging provider is approved (D-08).
Owners: Engineering

## Context

Recipients need accounts to see their tips, earnings and settings. The user chose sign-in with a **phone number plus a one-time code**: WhatsApp first, SMS as the fallback, email only as a backup. There are no passwords. `docs/05-SECURITY.md` requires:

- Secure, HttpOnly, SameSite session cookies, rotated on sign-in and revocable;
- CSRF protection or a strict origin check;
- strong rate limiting for authentication;
- minimal personal data.

## Decision

- **Self-hosted sessions, no third-party auth service.** An outside identity provider would add cost and hold recipients' phone numbers. Postgres and Redis already exist.
- **Identity:** the E.164 phone number, normalised with `libphonenumber-js` (default region NG while D-01 is open). "0803 123 4567" and "+234 803 123 4567" are one account.
- **Codes:**
  - 6 random digits, valid 10 minutes.
  - Only the latest unused code for a number counts.
  - Stored as `HMAC-SHA256(AUTH_CODE_SECRET, phone:purpose:code)` and compared in constant time.
- **Limits:**
  - At most 3 codes per number per hour.
  - Per client per hour: `RATE_LIMIT_AUTH_PER_HOUR` code requests (default 10) and three times that many verifications.
  - 5 wrong codes lock the number for 15 minutes.
  - The code request always answers 202, so it never reveals whether a number has an account.
- **Delivery:** through a pretend messenger. A development-only `GET /v1/dev/inbox` and `/dev/inbox` page show what would have been sent. It is registered only with `MESSAGING_PROVIDER=mock`, which is refused in production.
- **Sessions:**
  - A 256-bit random token in cookie `tipme_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` except on plain-HTTP localhost.
  - Postgres stores only its SHA-256.
  - Sliding 30-day expiry.
  - Every sign-in creates a new token and ends the browser's previous session.
  - Recipients can list their devices, sign one out, or sign out all others. Deleting the account ends every session.
- **CSRF:**
  - Every non-GET request on recipient routes must carry `Origin` equal to `WEB_ORIGIN` and the header `x-tipme-csrf: 1`. A cross-site form or image cannot send either.
  - CORS allows credentials only on `/v1/auth/*`, `/v1/me/*`, `/v1/handles/*` and `/v1/dev/*`, only for `WEB_ORIGIN`. Checkout routes stay credential-free.
- **Email** is recovery only, never a second way in.
  - A link to a verified email, plus a code sent to the **new** number, schedules the move of the account to that number **24 hours later**. Nothing changes immediately.
  - The old number and the email are warned at once, and any live session can cancel the move (Settings shows it).
  - When the 24 hours are up, signing in with the new number completes the move and ends every other session. Until then that number cannot be used to sign in.
  - A hijacked mailbox alone therefore never takes an account over at once: the owner has a day to stop it. If the owner has also lost both their number and every session, they cannot stop it; that is the accepted residual risk until recipient verification exists (D-06).

## Rationale

Phone numbers are what recipients reliably carry. One-time codes avoid password reuse. Storing only HMACs and hashes means a database leak reveals neither codes nor sessions. The Origin-plus-header check needs no token storage and fits the cookie-based API.

## Financial, security, privacy and accessibility impacts

- Phone numbers, codes, tokens and emails are never logged or put in URLs.
- The phone number is private by default on the public page.
- Sign-in screens meet WCAG 2.2 AA: one-time-code autocomplete, no time pressure beyond the code's life, and clear errors.

## Rollout and rollback

Development only until a messaging provider is approved. Swapping in a real provider replaces the pretend messenger behind the same operation.

## Consequences

- Mobile operators recycle numbers; email recovery and the devices list mitigate this.
- In production the API and web must share a registrable domain (for example `tipme.app` and `api.tipme.app`) so the `SameSite=Lax` cookie is sent.

## Validation evidence

`docs/PR-008-VERIFICATION.md`; `tests/integration/auth-api.test.mjs`; `packages/database/test/integration/{sign-in,sessions}.test.mjs`.
