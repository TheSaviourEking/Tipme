# ADR-0008 — Guest checkout, receipt tokens, device-only recognition, rate limits and expiry

Date: 2026-10-19
Status: ACCEPTED for development (PR-007). Mock provider only; real money stays blocked on D-03, D-04 and ADR-0004.
Owners: Engineering

## Context

A supporter scans a recipient's QR code, tips, and must see whether the tip actually went through. They should also "feel accomplished and know that we see them". The constraints are: only the mock provider exists (D-03 OPEN), supporters have no accounts (ADR-0003 and the privacy notice are pending), and AGENTS.md requires server-derived status, idempotency, rate limiting and complete fee disclosure.

## Decision

- **Routes** (`/v1`, envelope `{data}`/`{error}`):
  - `POST /v1/tip-quotes`: the server prices the tip; amounts travel as decimal strings.
  - `POST /v1/tip-intents` with a required UUID `Idempotency-Key`. It creates the tip once and starts the provider payment once, then returns `{ tipId, statusToken, checkoutUrl }`. A replay returns the same three values.
    - If a replay finds no provider reference yet (it raced the first request, or the first request failed before reaching the provider), the replay starts the payment itself. `markAttemptInitiated` lets exactly one reference win, and every response re-reads that winner.
  - `GET /v1/tips/:id/status`: needs `Authorization: Bearer <statusToken>`. It returns `waiting | paid | declined | checking | cancelled`, and never the message. The response carries `Cache-Control: private, no-store`. A wrong or missing token returns 404, the same as an unknown tip.
  - Business errors map to responses:
    - `IDEMPOTENCY_CONFLICT`, `QUOTE_EXPIRED`, `QUOTE_ALREADY_USED` → 409.
    - `PROFILE_NOT_FOUND` → 404.
    - Amount and message problems → 400 `VALIDATION_FAILED` with field names.
- **Receipt token:** `base64url(HMAC-SHA256(STATUS_TOKEN_SECRET, tipId))`, compared in constant time. The secret must be at least 32 characters.
  - Nothing is stored, and replays reproduce the token.
  - The token is carried only in the URL fragment `#t=` (never sent to a server or logged) and in the `Authorization` header.
  - When the tip is created, the web stores the token in the tab's `sessionStorage` before going to the provider, so it never passes through the provider's pages. Opening a copied receipt link (`#t=`) stores it the same way and removes the fragment from the address bar.
- **Return URL** is built by the API from `WEB_ORIGIN` as `/tip/<id>`, without the token. Holding a provider reference is therefore never enough to read a receipt; a real adapter must keep it that way. The client never supplies a redirect target.
- **Status mapping:**
  - `SUCCEEDED` → paid; `FAILED` → declined; `CANCELLED` → cancelled.
  - Otherwise the tip shows `waiting`, or `checking` once the attempt is `UNKNOWN` or the tip is more than 2 minutes old.
  - Only verified server state counts. Returning from the payment page proves nothing.
- **Pretend provider checkout:**
  - `GET`/`POST /v1/mock-provider/checkout/:reference`, registered only when `PAYMENT_PROVIDER=mock`, which is itself refused in production.
  - The outcome is chosen once (`chooseScenario`). Later choices only return the receipt URL. An expired tip is refused (409 `TIP_NOT_PAYABLE`), as is replaying the key of a tip that expired before its payment started.
  - The PR-006 scenario is played as signed webhooks to the API's own listening socket, never to the request's `Host`.
- **CORS:** only `WEB_ORIGIN`, and only on the checkout routes. Methods GET/POST/OPTIONS; headers `content-type, authorization, idempotency-key`; no credentials.
- **Rate limits:** a fixed one-minute window per client in Redis (`rl:<prefix>:<route>:<subject>:<minute>`). The subject is the IPv4 address or the IPv6 /64. The client IP comes from `X-Forwarded-For` only when `TRUST_PROXY_HOPS` (default 0) names the proxies in front of the API.
  - Defaults: 30 quotes/min and 10 intents/min, configurable through `RATE_LIMIT_*_PER_MIN`.
  - Over the limit → 429 `RATE_LIMITED` with `Retry-After`.
  - If Redis errors, the limiter fails open and logs `rate_limit.unavailable`.
- **Expiry:** the reconciliation job also runs `expireStaleTips`.
  - Candidates are attempts still `CREATED`/`INITIATED` whose quote expired more than 15 minutes ago.
  - The provider is always asked first. A definite answer is recorded as verified evidence, using the same deterministic event ID as reconciliation.
  - Only an attempt that was not paid becomes `EXPIRED`, with its tip `CANCELLED`. Both transitions are recorded with cause `expiry`.
  - A verified success that arrives later is flagged by the PR-005 `payment.conflict` path, never hidden.
- **Recognition (option B, chosen by the product owner):**
  - Shown only on the Paid screen, and only if the supporter ticked "Remember my tips on this phone" (unticked by default).
  - The record lives in `localStorage` `tipme.myTips.v1` = `{ v: 1, tips: [{ id, handle, at }], count, peopleCount, people }`: the last 500 tips, running totals that keep counting past that, and up to 1,000 distinct handles. Never amounts or messages; corrupt data is ignored, and records without totals fall back to the list.
  - Copy: "That's your {nth} tip. You've made {n} people's day. We see you." It never compares.
  - "Forget my tips on this phone" clears the record.

## Rationale

The HMAC token keeps receipts private without storing secrets or adding a supporter account. The fragment keeps the token out of server logs and referrers. Device-only memory delivers recognition without tracking supporters on TipMe's servers before the privacy notice exists. Asking the provider before expiring means a tip that was paid is never shown as cancelled.

## Financial, security, privacy and accessibility impacts

- **Financial:** no real money. Server-side prices only. One tip per idempotency key and per quote.
- **Security:** CORS is restricted, rate limits apply, and the token is never logged.
- **Privacy:** the supporter's message is never returned by the status route. Recognition data stays on the device.
- **Accessibility:** status changes are announced through `role="status"`. Pages reflow at 320 px and pass axe on every state.

## Rollout and rollback

Development only. Rolling back removes the checkout module and the web islands; profiles stay prerendered.

## Consequences

- A real provider adapter must supply a hosted checkout URL in place of `/mock-checkout`.
- Status polling should move to push at scale.
- Device-only memory is lost when storage is cleared (accepted).
- The status page needs JavaScript; a `<noscript>` message explains this.

## Validation evidence

`docs/PR-007-VERIFICATION.md`.

## Linked PRD requirements

PRD routes `/@handle`, `/tip/:intentId/status`; AGENTS.md checkout, idempotency, rate-limit and status invariants; spec `docs/superpowers/specs/2026-10-18-pr007-checkout-design.md`.
