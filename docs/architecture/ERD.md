# Entity relationships (PR-005)

Source of truth: `packages/database/src/schema.ts` and `packages/database/drizzle/*.sql`. Money columns are `bigint` minor units with a `char(3)` ISO currency.

```mermaid
erDiagram
  users ||--o{ profiles : owns
  profiles ||--o{ tip_quotes : priced_for
  tip_quotes ||--o{ payment_intents : accepted_as
  profiles ||--o{ payment_intents : receives
  payment_intents ||--|| tips : creates
  tips ||--o| tip_messages : has
  payment_intents ||--o{ payment_attempts : tried_by
  payment_attempts ||--o{ provider_events : evidenced_by
  payouts ||--o{ provider_events : evidenced_by
  profiles ||--o{ payouts : paid_by
  payouts ||--o{ payout_items : covers
  tips ||--o{ payout_items : included_in
  provider_events ||--o{ status_transitions : causes
  ledger_transactions ||--|{ ledger_entries : contains
  ledger_accounts ||--o{ ledger_entries : posts_to
  profiles ||--o{ ledger_accounts : payable_for
  tips ||--o| ledger_transactions : payment_posting
  payouts ||--o| ledger_transactions : payout_posting
  unmatched_provider_events {
    uuid id PK
    text provider_event_id "UNIQUE per provider"
    text reason
  }

  payment_intents {
    uuid id PK
    uuid profile_id FK
    text idempotency_key "UNIQUE with profile_id"
    text request_fingerprint
  }
  tips {
    uuid id PK
    uuid intent_id FK "UNIQUE"
    tip_status status
    bigint gross_minor
    char currency
  }
  payment_attempts {
    uuid id PK
    int attempt_number "UNIQUE per intent"
    text provider_reference "UNIQUE per provider"
    attempt_status status
  }
  provider_events {
    uuid id PK
    text provider_event_id "UNIQUE per provider"
    boolean signature_verified "CHECK true"
  }
  status_transitions {
    uuid id PK
    entity_type entity_type
    text from_status
    text to_status
    text trace_id
  }
  ledger_transactions {
    uuid id PK
    text operation_key "UNIQUE"
    char currency
  }
  ledger_entries {
    uuid id PK
    ledger_side side
    bigint amount_minor "CHECK > 0"
  }
  payout_items {
    uuid payout_id PK
    uuid tip_id PK "UNIQUE WHERE active"
    boolean active
  }
  outbox_events {
    uuid id PK
    text dedupe_key "UNIQUE, no ':'"
    timestamptz published_at
  }
```

Rules the database enforces beyond keys: a quote funds one intent (`payment_intents.quote_id` UNIQUE); tip, attempt and payout status changes must follow the PRD state machines; ledger accounts are immutable; history tables refuse TRUNCATE; `status_transitions`, `ledger_transactions` and `ledger_entries` are append-only (triggers); every ledger transaction balances with at least two entries at commit (deferred constraint triggers); entry currency must match its transaction and account; quotes must satisfy `recipient_net = tip − platform fee − provider fee`.

`unmatched_provider_events` (PR-006) keeps verified provider messages that match no known attempt or payout; it is append-only and refuses TRUNCATE.
