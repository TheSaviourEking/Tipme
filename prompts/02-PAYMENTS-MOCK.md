# Agent prompt: mock money flow

Read root/API/worker/contracts AGENTS and payment/domain/security docs. Implement ONLY mock payment provider: quote -> payment intent -> provider attempt -> signature verified mock webhook -> authoritative status -> balanced mock ledger -> durable outbox. Design concurrency-safe idempotent transitions. Include tests for replay, race, out-of-order, unknown outcome, invalid signature, expired quote, external outage. No live processor credentials, no claims of legally verified balances or payout settlement. Publish OpenAPI, transaction diagram and tests proof.
