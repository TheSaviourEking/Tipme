# Security, compliance and privacy baseline

## P0 controls
- Separate public, recipient-authenticated and internal ops authorization. Server-side authorization for every resource access; no reliance on hidden buttons.
- Sessions in Secure, HttpOnly, SameSite cookies where applicable, rotate on sign-in, revoke sessions; CSRF protection or strict origin/auth strategy for state-changing endpoints.
- Validate input lengths, currencies/amount ranges, text encodings and IDs; reject mass assignment and SQL injection with parameterized queries.
- Strong rate limiting for auth, quotes, tip initiation, webhook endpoints and recipient lookup; distributed controls for bots.
- Signed webhook verification on raw body with replay tolerance rules documented; secrets only server-side.
- Least-privilege DB and infrastructure IAM; separate credentials for local/staging/prod; rotate secrets; never commit real `.env`.
- Malware-safe image uploads: MIME sniff, size limits, transformations, storage policy, signed uploads and public delivery boundaries.
- Encryption in transit, at-rest provider protections, PII minimization and retention deletion procedures.
- Strong staff authentication, audit logs, controlled support access, two-person approval for sensitive finance adjustments.
- No card PAN/CVV handling. Outsource sensitive card data to compliant payment processor.

## Abuse prevention
- Impersonation reporting and verified profile restrictions.
- Message moderation and privacy defaults for payer messages.
- Fraud risk controls on volume/velocity, suspicious payer-recipient patterns and payout holds (legal/provider approval required).
- No fake tips, fake endorsements, guilt prompts or dark-pattern defaults.

## Security testing
SAST + dependency analysis + secret scanning in CI; authz tests across roles/tenants; webhook forgery/replay; payment concurrency; cache-leak tests; CSP/headers; sensitive log/trace redaction. Independent review before real funds.

## Gate
Engineering does not invent legal or regulatory approval. External counsel/partner and product owner approve actual flow.
