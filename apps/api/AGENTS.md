# API agent rules
- Modular NestJS services. Controllers orchestrate; domain services own invariants; persistence adapters own DB IO; provider adapters isolate external APIs.
- Validate all inputs, authz each action, never expose provider secrets or internal ledger internals in public DTOs.
- Ingress deduplication is **not** enough: transactional uniqueness and state-machine guards required for concurrent requests.
- Money amounts = bigint/integer minor units; currency code explicit, server-defined allowed ranges and quote expiry.
- Payment attempt outcomes only determined from signed provider events or authoritative server-side verification.
- Use database transactions for state + ledger + outbox where possible; audit every privileged mutation.
- Write tests for duplicates, races, outages, timeouts, malicious webhooks, out-of-order statuses and reconciliation.
- No operational success claims without integration tests.
