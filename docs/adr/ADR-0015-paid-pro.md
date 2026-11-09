# ADR-0015 — Paid Pro: monthly periods, checkout on TipMe's own account

Date: 2026-11-09
Status: PROPOSED (the owner's product decisions of 4, 5 and 9 Nov 2026; pretend money and the partner's sandbox only)
Owners: Product (owner), Engineering; finance sign-off needed for the new ledger accounts

## Context

Until now Pro was switched on by staff with a reason, and nothing was billed (`docs/00-DECISIONS.md`, 1 Nov 2026). On 9 Nov 2026 the owner asked for billing first, before any new Pro feature, at a launch price of ₦2,500 a month. Every money path TipMe had was tied to a recipient's connected account: TipMe had never collected money on its own partner account. The partner's sandbox showed on 9 Nov 2026 (`.superpowers/program/pro-billing-readiness.md`, "Sandbox evidence") that:

- `POST /v1/checkout-sessions` with `pricing {currency: "NGN", amount: "2500.00"}` and no `X-Account-Id` opens a checkout on TipMe's own account (201, `open`, about 30 minutes to pay);
- events from TipMe's own account carry **no top-level `account`** field, while connected-account events do;
- a webhook endpoint hears its own account's events only with `event_source` `account` or `all`; TipMe's staging endpoint is `connect`.

**This ADR is not a regulatory, legal or provider approval. D-03, D-04, D-06 and D-07 stay OPEN, and D-05 stays PARTLY DECIDED.** The hard stop on real payments in `AGENTS.md` still stands.

## Options considered

1. Keep staff grants only: no revenue path, and the owner asked for billing.
2. Charge Pro on the recipient's connected account (a tip-like charge with a 100% platform fee): mixes Pro with tips, would look like a tip in every report, and the fee rules (10%, rewards) would need exceptions everywhere.
3. **Checkout on TipMe's own partner account**, with Pro purchases, periods and ledger accounts of their own. Chosen.
4. Partner subscriptions: they bill USD cards only today (partner docs, 9 Nov 2026), so not for naira.

## Decision

- **Price.** `pro_prices` keeps every price ever set (append-only). The current price is the latest row whose `effective_from` has passed. Launch price 250,000 kobo (₦2,500) a month, seeded with the reason "Owner's decision, 9 Nov 2026". Staff change it with the `pro.price` permission as the serious action `pro_price.change` (a second approver; a lone admin acts alone with an alert), within ₦100 to ₦1,000,000, whole naira. A change applies to new purchases only: a purchase keeps the price it was opened at.
- **Periods.** A paid month is a `pro_periods` row: `starts_at`, `ends_at` (one calendar month later in Africa/Lagos, clamped to the month's last day), `grace_ends_at` (`ends_at` + 3 days). At most one month can be queued ahead (one `SCHEDULED` period). A payment made during grace starts at the old `ends_at` (the owner's default, so grace is not free time); after grace it starts when confirmed.
- **The plan.** `profiles.plan` stays the one field every Pro check reads. `recomputePlan` rewrites it under the profile lock: `pro` when staff granted Pro (`profiles.staff_pro`) or a period covers now, grace included; otherwise `free`. On every change it rewrites the legacy `socials` column from the visible links, as a staff change does. Lapsing hides Pro extras; nothing is deleted.
- **Reminders.** 7 days and 1 day before a month ends (none when a month is queued), "grace started" at the end, and "Pro ended" when grace ends; each once per period (deduplicated keys).
- **Purchases.** A `pro_purchases` row per payment, with the price fixed when it was opened, an `Idempotency-Key` and request fingerprint, and at most one open purchase per page. The checkout offers `NGN_CARD` and `NGN_BANK_TRANSFER`, with the partner's idempotency key `tipme-pro-<purchaseId>`, no connected account and no platform fee.
- **Confirmation.** Pro is granted **only** from the partner's signature-verified webhook (`collection.succeeded` or `checkout.completed`, either first), which triggers a read-back of the checkout; the read-back is the authority. A redirect changes nothing. The purchase moves to `PAID` and its month starts exactly once (unique `pro_periods.purchase_id`, ledger operation key `pro.<purchaseId>`). An amount or currency other than the purchase's goes to `REVIEW` with a money issue and books nothing. A payment confirmed after the purchase expired is still credited, from the confirmation, with the alert `pro.late_payment`.
- **Webhook scope.** The normaliser tells the two kinds apart: an event **with** a top-level `account` is a connected account's (a tip); one **without** it whose `organization_id` is `BACHS_PLATFORM_ORGANIZATION_ID` is TipMe's own (`scope: platform`) and is routed only to Pro billing, never to tip matching. Without that setting every event stays `connected`, as before. The staging endpoint moves to `event_source=all` only after this is deployed.
- **Ledger** (ADR-0006 addendum, 9 Nov 2026). Operation type `pro_sale`. Debit `platform_clearing` (gross − partner fee), debit `provider_fee_expense` (partner fee, always the read-back's figure), credit `subscription_revenue` (gross). Pro is not a tip: no 10% TipMe fee, no tip rewards, no milestones, no recipient payable.
- **Not decided here:** paying from the TipMe balance (a `destination: self` transfer, behind `PRO_PAY_FROM_BALANCE`, waits for the partner's answer on whether this use is allowed), refunds (wait the owner's refund rule), automatic renewal (waits naira card support), and the annual plan.

## Rationale

Own-account checkout keeps Pro money apart from tips in the partner's reports, the ledger and every recipient balance, and the sandbox showed it works. Periods with a grace end make lapsing a matter of time, so the worker can expire them without asking the partner. One field (`profiles.plan`) keeps every existing Pro gate unchanged.

## Financial, security, privacy and accessibility impacts

- Price, amount and status come from the server only; the client's expected amount only refuses a mismatch (`PRO_PRICE_CHANGED`).
- Purchases are idempotent at three levels: the request's `Idempotency-Key`, the partner's idempotency key, and the ledger's operation key. A month never starts twice for one payment.
- `platform_clearing` is TipMe's own partner balance, kept apart from `provider_clearing` so each reconciles against its own balance at the partner.
- Users only ever see "our payment partner". No receipt or mail subject carries an amount.

## Rollout and rollback

- `PRO_BILLING_ENABLED` (API, default off) gates opening a purchase. With it off nothing changes for anyone. Live payments stay behind the existing live switches; a live checkout also needs TipMe's own partner account verified (otherwise the partner answers `ACCOUNT_NOT_ACTIVATED`, which TipMe reports as `PRO_CHECKOUT_UNAVAILABLE`).
- Rollback: turn `PRO_BILLING_ENABLED` off. Paid periods keep running to their end; staff grants are unaffected.

## Consequences

- The webhook endpoint must move to `event_source=all` after deploy, and `BACHS_PLATFORM_ORGANIZATION_ID` must be set, or own-account events are never heard or are treated as connected.
- Finance must sign off `subscription_revenue` and `platform_clearing`, and VAT on Pro is open.

## Validation evidence

Tests named in the PR (domain periods, price, purchase, webhook-scope and ledger tests, all on pretend money and recorded fixtures), and the opt-in `scripts/pro-sandbox-check.mjs`, which opens one ₦2,500 checkout on the partner's sandbox through TipMe's adapter.

## Linked PRD requirements

AGENTS.md financial invariants; ADR-0006 (ledger); ADR-0007 (provider interface); ADR-0010 (serious actions and audit); ADR-0014 (the tip fee, which Pro does not change); partner docs at docs.bachs.io read 9 Nov 2026 (checkout sessions, webhooks overview, fees).
