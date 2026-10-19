# Worker agent rules
- Worker jobs are idempotent and at-least-once safe. Assume queue delivery can duplicate or reorder.
- Use bounded retries, exponential backoff and dead-letter quarantine; failures observable with correlation IDs.
- Never deliver receipts or recipient earnings as paid unless confirmed payment status is authoritative.
- Reconciliation job checks unsettled/unknown provider transactions. It does not blindly initiate second charges or payouts.
- Job handlers must have isolated tests and meaningful timeout/cancellation behavior.
