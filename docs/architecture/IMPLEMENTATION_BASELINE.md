# TipMe — Implementation Baseline v0.1

Date: 2026-10-18
Status: PROPOSED engineering plan based on Master PRD v1.0; NOT an audit of existing source code.

## Established product decisions (LOCKED)

- Appreciation-first personal tipping identity across web links and QR codes.
- Guest payer flow; recipient accounts; mobile-first responsive website and recipient dashboard.
- Brand: #7A32F9, #FFFFFF, #000000. Selective gradients; premium, intentional motion.
- Fast, accessible, discoverable, observable, scalable, financially correct implementation.
- Track ethical funnel conversion without guilt, deception or hidden fees.

## Implementation decisions (PROPOSED)

- Monorepo: apps/web (Next.js), apps/api (NestJS), apps/worker, packages/ui, packages/contracts, packages/config, packages/analytics.
- PostgreSQL source of truth; Redis queue/cache; managed payment processor adapter; OpenTelemetry + error monitoring; CDN/WAF.
- API REST with OpenAPI. Strong database constraints and transaction/outbox for financial transitions.
- No money movement until business use case, provider approval, settlement/legal model and supported geography confirmed.

## Experience surface inventory

1. Marketing: /, /how-it-works, /for-creators, /for-professionals, /help, /legal/*
2. Public: /@handle (or agreed canonical handle scheme), /@handle/tip, /tip/receipt/:id (secret access token, privacy aware)
3. Recipient auth: /sign-up, /sign-in, /verify, /onboarding/*
4. Dashboard: /dashboard, /dashboard/tips, /dashboard/earnings, /dashboard/share, /dashboard/settings, /dashboard/payouts
5. Internal operations: /ops (separate authorization perimeter)
   Paths are proposed, pending existing prototype inventory.

## Proposed first clickable vertical slice (no real payments)

A. A recipient profile publicly loads with SSR metadata, fast first render and share preview.
B. Guest selects amount and optional message; sees currency, recipient and honest fee quote.
C. Backend creates validated payment intent with idempotency key and expiry.
D. Mock provider routes intent to success/failure/pending; API resolves authoritative status.
E. Receipt UI displays VERIFIED success only after confirmed provider outcome.
F. Recipient dashboard displays resulting record and status; operations can trace all events.
G. Replay webhook and retry payment-initiation tests demonstrate no duplicate financial postings.

## Critical domain entities and relationships

- users (1:1/1:n) recipient_profiles, sessions, verification_cases, payment_accounts
- recipient_profiles (1:n) tip_links / qr_campaigns / tips
- tips (1:n) payment_attempts; tips (0:1) tip_messages; payment_attempts (0:1 or 1:n) provider_events
- payment_intents (1:n) payment_attempts; store provider IDs uniquely
- ledger_accounts (1:n) ledger_entries grouped into balanced ledger_transactions
- payouts (1:n) payout_attempts; settlement_records; refund_records; dispute_records
- audit_events, risk_cases, outbox_events, analytics_events
  No stored card PAN/CVV, provider secrets in client, or client-authored success statuses.

## Payment state contract (draft)

Tip: CREATED -> PAYMENT_PENDING -> PAID | EXPIRED | CANCELED | FAILED; PAID -> PARTIALLY_REFUNDED | REFUNDED | DISPUTED (additional claims handled as separate records)
Attempt: CREATED -> PROVIDER_PENDING -> SUCCEEDED | FAILED | ABANDONED | UNKNOWN
Payout: NOT_APPLICABLE | PENDING_PROVIDER | PROCESSING | PAID | FAILED | REVERSED (actual provider model TBD)
Rules: webhook signatures verified, idempotency per business operation, lock/uniqueness for finalization, append-only journal, reconciliation against authoritative provider, safe treatment of unknown statuses.

## Measurable V1 quality gates (PROPOSED)

- Core Web Vitals mobile p75: LCP <=2.0 s, INP <=150 ms, CLS <=0.05 measured from real user monitoring once sample size sufficient.
- Public profile API p95 <=200 ms and internal checkout initiation p95 <=400 ms, separately reporting external provider latency.
- WCAG 2.2 AA target; keyboard and screen reader acceptance, 200% zoom and reduced-motion support.
- SEO: SSR crawlable public profiles, canonical tags, metadata/OG, sitemap filtering, private/noindex guardrails.
- Release: test webhook replay, provider outage, error/retry, abandoned checkout, payout failures, DB restore, staged rollback, monitoring alerts.
- Financial correctness: zero duplicate ledger postings; all movements reconcilable; unknown provider statuses never presented as success.

## Instrumentation event contract (draft)

profile_viewed, tip_cta_clicked, amount_selected, custom_amount_entered, message_started, payment_started, payment_pending, payment_failed, tip_completed, qr_scanned, recipient_shared_link, recipient_first_tip, recipient_returned.
Event properties: anonymous flow ID, version, page surface, channel, campaign, device class, timing; avoid raw message content, sensitive identity and payment credentials. Separate product events from authoritative finance events.

## Sprint 0 work packages (parallel)

### Track A — Experience

A0-01 Repo audit: inventory existing routes, dependencies, components, assets, responsiveness and broken interactions. BLOCKED on source.
A0-02 Build design tokens (#7A32F9/white/black), typography candidates and accessible primitives.
A0-03 Define screenshot-by-screenshot public profile + tipping journey; include loading/empty/pending/fail/success.
A0-04 Curate component inspiration with licensing, dependency, reduced motion and performance review.
A0-05 User research: interview 5-8 recipients and 5-8 payers across selected launch segments; explicitly exploratory sample.

### Track B — Platform

B0-01 Provider/legal spike: business model, entity/region, subaccounts, split, settlement recipient, reversals, fees and prohibited use cases.
B0-02 ERD and migration draft: profile, tip, attempt, provider events, ledger, reconciliation and payouts.
B0-03 Define payment adapter interface, state diagrams and idempotency keys.
B0-04 Mock provider + integration tests for unknown outcome and repeated webhook events.
B0-05 Deploy dev/staging foundation with CI, preview, logs/traces, health checks, test backups.

## Blocking inputs / validation needed

1. Link to or archive of existing TipMe prototype/repository and current brand assets.
2. Launch country, currency, recipient geographies, company legal entity and allowed recipient types.
3. Preferred payment processor (if already in talks), fee policy, and recipient settlement ownership.
4. Team, timeline, budget constraints and deployment accounts.

## Definition of Sprint 0 complete

- Repo audit and route-to-feature map; product/engineering backlog tied to PRD IDs.
- Approved critical user flow prototype and accessibility/performance review.
- Provider viability decision; documented funds-flow and operations model.
- ERD v0.1, OpenAPI draft, webhook and reconciliation invariants.
- Development and staging baseline with observability and CI.
