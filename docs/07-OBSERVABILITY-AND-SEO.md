# Observability, performance, SEO and operations

## Trace topology
Every incoming request has request/trace IDs. Link profile view -> tip quote -> intent -> payment attempt -> webhook -> reconciliation -> notification via safe correlation keys, without leaking payer private data. Trace sampling may be aggressive for failures but avoid sensitive payloads.

## Metrics and proposed SLOs
| Metric | Initial objective | Notes |
|---|---|---|
| Public profile field LCP p75 | <= 2.0 s | RUM mobile by geography/device |
| Field INP p75 | <= 150 ms | Interactive devices |
| Field CLS p75 | <= 0.05 | Public/checkout |
| Public profile API p95 | <= 200 ms | Server work, excludes client network |
| Intent initiation API p95 | <= 400 ms | Isolate payment provider waiting time |
| Dashboard API p95 | <= 300 ms | Internal first-party latency |
| Checkout availability | 99.95% monthly target | Define critical synthetic journey and exclusions |
| Duplicate ledger posting | zero | Hard correctness invariant |
| Orphan financial transactions | zero unaccounted | Reconciliation exception queue |

Use error budgets, not vanity uptime. Instrument queue depth, DLQ, provider timeouts, webhook delay, DB saturation, cache hit ratio, security anomalies, payout exceptions and backup freshness.

## Product telemetry
Events: `profile_viewed`, `tip_cta_clicked`, `amount_selected`, `custom_amount_entered`, `message_started`, `payment_started`, `payment_pending`, `payment_failed`, `tip_completed`, `qr_scanned`, `recipient_shared_link`, `recipient_first_tip`, `recipient_returned`.

Store minimal properties: event schema version, pseudonymous flow id, device class, traffic source, attribution campaign, recipient segment and timestamps. Do not log raw donor messages, full payment identifiers, bank details or sensitive PII. Define consent and retention before real analytics rollout. Financial truth lives in ledger, NOT analytics.

## SEO and distribution
Sitemap excludes private/unapproved/empty profiles; canonical/resolved handles; locale strategy only if content is genuinely localized. Unique OG images with authenticated generation boundaries; measure social previews on WhatsApp/Telegram/X; support `robots.txt`, HTTP redirects, structured data only when applicable. Setup Google Search Console post-domain confirmation.

## Runbooks to create before beta
- Payment pending > threshold / out-of-order webhook.
- Webhook queue backlog / corrupted payload / DLQ.
- Reconciliation mismatch / dispute / refund.
- Postgres storage, failover and restore.
- Provider outage / circuit break.
- Deployment rollback / unexpected conversion drop.
- Profile impersonation complaint.
