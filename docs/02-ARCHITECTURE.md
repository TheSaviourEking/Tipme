# Proposed architecture and repository boundaries

```text
tipme/
  apps/
    web/         # Next.js marketing, profiles, checkout, dashboard
    api/         # NestJS HTTP/API, domain orchestration
    worker/      # queue handlers, reconciliation, notifications
  packages/
    contracts/   # shared versioned DTOs, schemas, event IDs
    ui/          # tokens, accessible components, signature motion
    config/      # shared lint/tsconfig/env helpers
    database/    # ORM schema + migrations, only after ADR
  docs/          # versioned decisions and implementation docs
  prompts/       # execution instructions for coding agent
  .github/       # checks and templates
```

## Source of truth
- Postgres is authoritative for profiles, payment records, settlement data and the ledger.
- Redis is ephemeral for locks/cache and durable-ish work queue *only in combination with DB outbox*; financial work must survive Redis loss via durable DB records.
- The API authoritatively calculates fee quotes and permitted amount ranges. UI displays response but never calculates payment truth.
- Provider is authoritative for capture/settlement outcomes; stored raw event references and normalized observations are audited.

## Logical bounded contexts
- Identity: users, sessions, auth, verification, consent.
- Profiles: public handles, images, visibility, review status.
- Appreciation: tip intent, donor message, campaign attribution.
- Payment orchestration: quotes, payment attempts, processor adapters, events.
- Finance: balanced ledger, clearing, settlement, payouts, refunds, disputes, reconciliation.
- Engagement: notifications, emails, QR sharing, recipient gratitude inbox.
- Operations: role-based support tooling, risk, immutable audit trail.

## Dependency rules
`web -> contracts, ui`; `api -> contracts, domain, db`; `worker -> domain, db`; `ui -> no API or DB`; `contracts -> no framework`; API/worker may share domain libraries but never import each other's app bootstraps.

## Runtime request flow
1. Browser obtains cached server-rendered recipient profile (public-safe data only).
2. Guest chooses tip amount; API validates server-side and returns fresh quote (amount, currency, fees, payable total, expiry).
3. Guest initiates intent with idempotency key; API persists intent + attempt.
4. Mock provider returns safe checkout URL or simulated reference. External redirects do not mark payment successful.
5. Signed provider event or authoritative status check drives payment state transition + ledger in one DB transaction, writes outbox.
6. Worker dispatches receipt/notification, reconciles pending transaction asynchronously.
7. Public receipt polls/refreshes status using an opaque authorization token without exposing private details.

## Cache discipline
- Public approved profile data: CDN/cache with versioned invalidation and bounded TTL.
- Sensitive, checkout, per-user dashboard and receipts: `private, no-store`; no public CDN caching.
- Profile updates trigger invalidation and OG-image refresh.

## Scaling discipline
Launch: one API service, one worker, managed PG, Redis, CDN. Add replicas after load tests and SLO evidence. No microservices, Kafka, Kubernetes or multi-region writes by default. Maintain a scale decision log with real metrics.
