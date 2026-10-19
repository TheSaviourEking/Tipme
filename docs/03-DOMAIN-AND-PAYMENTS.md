# Domain model, payment states and API-first vertical slice

## Model and IDs
Use UUID/ULID public IDs (exact selection in ADR), unique stable business keys and immutable external provider references. Suggested entities:

| Entity | Critical fields/constraint |
|---|---|
| User | id, email_verified_at, status, created_at |
| RecipientProfile | user_id, unique canonical handle, status, public display name, indexed flag |
| PaymentAccount | recipient_id, provider, provider_account_ref, verified status; encrypted restricted data |
| Tip | id, recipient_id, intent_id, currency, gross_minor, status, payer_ref optional |
| Quote | id, recipient_id, amount_minor, fee_minor, total_minor, currency, expires_at, terms_version |
| PaymentIntent | id, tip_id, idempotency scope/key, status, expires_at |
| PaymentAttempt | id, intent_id, provider, provider_ref unique, status, last_checked_at |
| ProviderEvent | id, provider, provider_event_id unique, received_at, verified_at, payload_hash, event type |
| LedgerTransaction | id, operation_key unique, currency, posted_at, reversal_of optional |
| LedgerEntry | txn_id, ledger_account_id, debit_minor, credit_minor, currency, check nonnegative |
| Settlement | provider_ref, expected_minor, observed_minor, status, reconciled_at |
| Payout | id, recipient_id, provider_ref, amount_minor, status, failure_reason |
| Refund/Dispute | source payment reference, provider reference, status, associated ledger reversal |
| OutboxEvent | unique event ID, payload version, delivered_at, attempts |
| AuditEvent/RiskCase | action, actor, timestamp, safe metadata, immutable trail |

Enforce DB check constraints and transactional balanced posting. For multiple currencies, postings must balance per currency. No financial amounts as IEEE float. PII minimization and retention policies are blockers before live data.

## State-machine rules
- Tip: CREATED -> PAYMENT_PENDING -> PAID | FAILED | CANCELED | EXPIRED. PAID may acquire refund/dispute flags backed by separate financial records, not rewritten history.
- Attempt: CREATED -> PENDING -> SUCCEEDED | FAILED | UNKNOWN; UNKNOWN only resolves via verified query/event.
- Payout: NOT_APPLICABLE | PENDING_PROVIDER | PROCESSING | PAID | FAILED | REVERSED (names will change to match approved provider).
- Redirect and client poll NEVER authorize PAID. Provider retries can be duplicate, missing or out of order.
- Payment finalization: lock row/unique operation key; validate allowed transition; insert balanced ledger postings; enqueue outbox event; commit atomically.

## Mock API contract (proposed, to refine in OpenAPI)
```
GET  /api/v1/public/profiles/:handle
POST /api/v1/public/tip-quotes
POST /api/v1/public/tip-intents           [Idempotency-Key]
GET  /api/v1/public/tip-intents/:id/status [opaque access token]
POST /api/v1/webhooks/mock               [signed mock payload]
GET  /api/v1/me/tips                     [authenticated recipient]
GET  /api/v1/me/earnings                 [authenticated recipient]
GET  /health
```

Quote response example:
```json
{
  "id":"quote_mock_123", "recipientId":"rec_mock_123", "currency":"NGN",
  "amountMinor":"100000", "feeMinor":"0", "totalMinor":"100000",
  "expiresAt":"2026-10-18T18:00:00Z", "feePolicyVersion":"mock-v1"
}
```
The example is illustrative: NGN and zero fee are NOT approved commercial defaults. Store integer amounts via bigint safely; stringify on JSON boundaries.

## Mandatory tests
- Concurrent identical Idempotency-Key -> one logical intent and one posting.
- Same provider event twice -> one transition/posting.
- Out-of-order event arrives after success -> no downgrade.
- Provider timeout after possible capture -> UNKNOWN, reconcile, no second charge.
- Forged/invalid webhook -> reject before persistence of trusted event.
- Client-crafted success redirect -> status remains pending.
- Fee quote expires/changes -> reject/requote explicitly.
- DB failure after provider notification -> event recoverable/replayable; no false receipt.
- Sum debit=credit for each currency and business operation; reversal links remain traceable.

## Legal dependency
Do not implement collection to a platform-owned account or promise withdrawal speed until D-01..D-07 in decisions are approved.
