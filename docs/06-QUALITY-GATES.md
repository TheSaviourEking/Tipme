# Quality, test matrix and definition of done

## Required repository scripts (once scaffolded)
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`, `pnpm format:check`. CI must run install with frozen lockfile.

## Test pyramid
- Unit: schemas, domain transitions, fee quote calculation (mock policy), authorization and visual component logic.
- Integration: PostgreSQL transactional state, idempotency, unique constraints, outbox processing, duplicate webhook handling.
- End to end: guest profile -> quote -> initiate -> mock success/failure/pending -> verified receipt; recipient sign-in and earnings; keyboard-only mobile scenario.
- Contract: OpenAPI request/response fixtures, client-server type compatibility and error code stability.
- Security: tenant isolation, CSRF/session, webhook authenticity, SSRF and file upload controls.
- Performance: synthetic mobile in CI, RUM once deployed, API load scenarios; separately record external provider latency.
- Disaster recovery: backup+restore verified and documented, worker replays safely.

## Acceptance gate by PR
1. User story and acceptance checklist included.
2. Unit/integration tests for meaningful logic; visual/regression evidence for UI.
3. Lint, typecheck, tests and build pass, or clearly documented environmental failure.
4. Accessibility review; responsive states; error/empty/loading/pending states covered.
5. Public metadata and caching reviewed if route touched.
6. Security/PII logging review and financial invariants reviewed.
7. Migration plan and rollback included if persistence changed.
8. Telemetry names and correlation tested for critical flows.
9. No unreviewed packages, licenses, or secrets committed.

## Launch gates
Sandbox provider sign-off; legal and compliance sign-off; idempotency/race tests; full money lifecycle reconcile tests; operations/runbook; backups; alerts; on-call owner; successful staged rollback; load/recovery testing; real-device usability sample. The working mock flow is NOT a live payments release.

## The test plan (PR-014)
How to run each layer, what runs when, the mandatory money tests mapped to real tests, requirement-to-test traceability, and what is not covered yet: `docs/quality/test-plan.md`.
