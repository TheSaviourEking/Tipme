# PR-007 design — guest checkout, status and recognition

Status: DRAFT for user approval. Date: 2026-10-18.

## Intent

A supporter scans a recipient's QR code (e.g. Tobi at the café, phone in one hand), and the user's words describe the journey: the page "should be performant"; they tip; they "get a confirmation screen if it goes through or not"; and they "feel accomplished and know that we see them". Only the mock provider exists (D-03 OPEN); no real money moves.

## Goals (agreed with the user)

1. **Fast profile page:** the existing `/@handle` page stays prerendered; budget LCP ≤ 2.0 s (AGENTS.md), measured in a throttled lab run.
2. **Honest amount step:** the existing form gets a **server quote** and shows, before paying, what the recipient receives after fees ("Tobi receives ₦1,870"). The fee policy is still the labelled mock (D-05).
3. **Tip:** one tap creates the tip with an idempotency key (double taps never create two) and goes to the payment step.
4. **Pretend provider page:** a page that looks like a provider's hosted checkout. In development it lets you choose an outcome (paid, declined, slow, no reply, …) and drives the PR-006 simulator.
5. **Status screen** `/tip/<id>`: "Waiting for confirmation…" until the server has **verified** evidence, then **Paid ✓**, **Declined** (calm retry), or **Still checking** (never a fake success). Returning from the payment page proves nothing; only server status counts.
6. **Recognition (option B, chosen):** on the Paid screen only: "That's your 12th tip. You've made 5 people's day. We see you." It celebrates and never compares. It appears only if the supporter ticked **"Remember my tips on this phone"** (chosen: device-only for now).
7. **Receipt link** the supporter can revisit, readable only with a private token.

## Non-goals

Real providers or money. Supporter accounts or contact-based history (waits for ADR-0003 and the privacy notice). Recipient dashboard and sign-in (PR-008). Analytics events (PR-009). Refunds.

## Anti-goals

- Any comparison or guilt ("less than usual"), or recognition shown **before** the amount is chosen.
- Tracking supporters on TipMe's servers for recognition; the device record holds **no amounts and no messages**.
- Trusting the redirect back from the payment page, or any client-supplied status, price or fee.
- Tip messages or receipt tokens in URLs sent to the server, in logs, traces, analytics or the device record.
- A pending or unknown payment shown as success.

## Constraints

AGENTS.md (web: server-rendered public pages, all UI states, a11y, budgets; API: validation, idempotency, rate limiting; financial invariants). PRD routes (`/@handle`, `/@handle/tip`, `/tip/:intentId/status`) and response envelope `{data}`/`{error}`. PR-005/006 operations are the only path to state changes. Existing suites stay green; brand #7A32F9/white/black.

## Decided with the user

Flow above; recognition placement B (after confirmation); device-only memory with opt-in; mock provider only.

## Builder's design (agent's calls, open to review)

### API (`/v1`, envelope `{ data }`)

- `POST /v1/tip-quotes` `{ handle, amountMinor: string, currency: 'NGN' }` → quote (tip, fees, recipient net, payer total, expiry, fee policy version). Uses `createQuote`.
- `POST /v1/tip-intents` with header `Idempotency-Key` (UUID, required) and body `{ quoteId, message?, payerDisplayLabel? }` → `{ tipId, statusToken, checkoutUrl }`. Uses `createPaymentIntent`, then the provider's `initializePayment` and `markAttemptInitiated`. A replay with the same key returns the same tip and **the same token**. _(Builder check, agent's call:)_ the token is `HMAC-SHA256(STATUS_TOKEN_SECRET, tipId)` (base64url), recomputed and compared in constant time, so nothing secret is stored and replays return it naturally. `STATUS_TOKEN_SECRET` must be at least 32 characters. The return URL is built by the API as `WEB_ORIGIN + /tip/<tipId>#t=<token>`; the client never supplies a redirect target, so there is no open redirect.
- `GET /v1/tips/:tipId/status` with `Authorization: Bearer <statusToken>` → `{ state: 'waiting' | 'paid' | 'declined' | 'checking' | 'cancelled', recipient: { handle, displayName }, amountMinor, currency, completedAt }`. Mapping: `SUCCEEDED → paid`; `FAILED → declined`; `CANCELLED → cancelled`; `AWAITING_PAYMENT`/`PENDING_VERIFICATION` → `waiting`, or `checking` once the attempt is `UNKNOWN` or older than 2 minutes. A wrong or missing token → 404 (never 403: reveals nothing). Never returns the message. `Cache-Control: private, no-store`.
- **Mock provider checkout** (only when `PAYMENT_PROVIDER=mock` and not production): `GET /v1/mock-provider/checkout/:reference` (summary for the pretend page) and `POST /v1/mock-provider/checkout/:reference` `{ outcome: scenario }` runs the PR-006 simulator against the webhook endpoint, settles the mock and returns `{ returnUrl }`.
- **CORS:** only `WEB_ORIGIN` for these routes; credentials off.
- **Rate limits** (the PR-004 deferral lands here): per IP via Redis, 30 quotes/min and 10 intents/min; 429 with `RATE_LIMITED` and `Retry-After`. Fails open if Redis is down (availability over throttling; logged).
- **Expiry:** the worker's reconciliation run also expires stale tips. An attempt `CREATED`/`INITIATED` whose quote expired more than 15 minutes ago is first **checked with the provider** (never expire something paid). If it is not paid, the attempt goes to `EXPIRED` and the tip to `CANCELLED`, with transitions.
- **Error mapping** _(builder check, agent's call):_ `IDEMPOTENCY_CONFLICT`, `QUOTE_EXPIRED` and `QUOTE_ALREADY_USED` → 409; `PROFILE_NOT_FOUND` → 404; `AMOUNT_OUT_OF_RANGE` / `INVALID_INPUT` → 400; all added to contracts `apiErrorCodes`.

### Web

- `/@handle` (existing, prerendered): the form gains "Remember my tips on this phone" (unticked by default) and a "Tip ₦X" button, replacing "Preview appreciation". The demo profile copy stays honest: pretend payments only.
- **Quote step** in the same card: after choosing an amount the client asks the API for a quote and shows the breakdown; the button is disabled until the quote arrives; network errors are recoverable.
- **Status page** `/tip/[tipId]` (client island; `noindex`): reads the token from the **URL fragment** `#t=<token>` (never sent to a server or logged) and moves it to `sessionStorage` for the tab, then polls the status (1 s, then backing off to 5 s, stopping after 2 minutes with a "we'll keep checking" message and a receipt link). Every state from web AGENTS.md: loading, waiting, paid (+ recognition), declined (retry link back to the profile), checking/unknown, cancelled/expired, network error.
- **Pretend provider page** `/mock-checkout/[reference]` (noindex, clearly labelled "Pretend payment provider · no real money"): shows the amount and recipient plus outcome buttons; it is visibly not TipMe-branded checkout.
- **Recognition store** (`localStorage` key `tipme.myTips.v1`): `{ v: 1, tips: [{ id, handle, at }] }`, written **only** when the status page sees `paid` and the supporter opted in (the opt-in travels in `sessionStorage` from the form to the status page). It shows the count and the distinct handles. A "Forget my tips on this phone" link clears it. Corrupt storage is ignored safely.
- The receipt link is `/tip/<id>#t=<token>`; the paid screen offers "Copy receipt link".

### Contracts

Zod schemas and types for the quote, intent and status requests and responses, and `RATE_LIMITED` in `apiErrorCodes`.

### Tests

- **API integration:** quote validation; intent idempotency (same key → same tip and token; different body → 409 `IDEMPOTENCY_CONFLICT`, added to the error mapping); missing `Idempotency-Key` → 400; status with wrong or missing token → 404 and never the message; rate limit → 429; CORS allows only `WEB_ORIGIN`; mock checkout disabled when not mock; expiry checks the provider first (paid is never expired).
- **E2E (Playwright, full stack:** web + API + worker against `tipme_test`): scan → quote shows the net → tip → pretend page → paid → recognition (opted in) / no recognition (opted out); declined → retry; slow → waiting then paid; no-reply → checking; double-tap → one tip; reload of the status page keeps working (session token); axe on every state; 320 px.
- **Performance:** a throttled lab LCP sample for `/@tobi` and `/tip/…`; reported as lab only.

### Documentation

ADR-0008 (checkout flow, status tokens, recognition storage, rate limits, expiry); runbook update; `docs/PR-007-VERIFICATION.md`; third-party register (none expected).

## Left to the builder

Exact component split; polling intervals within the stated bounds; rate-limit implementation details; copy wording within the agreed tone; how Playwright starts the API and worker.

## Risks

- Polling cost at scale (move to push later).
- Device-only memory is lost when storage is cleared (accepted; contact-based memory later).
- The fragment-token pattern requires JavaScript; the no-JS fallback explains that the status needs JavaScript.
