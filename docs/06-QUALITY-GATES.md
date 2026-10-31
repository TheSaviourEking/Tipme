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

### Before pushing and before merging

- **Pre-push hook.** `pnpm install` points git at `scripts/hooks`, whose `pre-push` runs formatting, lint, typecheck and the unit tests (about 30 seconds once builds are cached; it never rebuilds the web app). The full e2e suite needs the local stack and takes several minutes, so it runs only on request: `TIPME_PREPUSH_E2E=1 git push`. Skip once with `git push --no-verify`.
- **Merge with `pnpm pr:merge <number>`.** This repository's GitHub plan has no branch protection, so nothing else stops a red PR from merging into `dev` and deploying to staging. The command refuses a draft, closed or conflicting PR, and any CI check that failed, is pending or was cancelled.
- **Shared test steps.** The e2e suite and the staging release check tip through the same `tests/shared/tip-flow.ts`, so a change to the tip form's copy fails the PR's e2e check rather than only the release check after deployment.

## Launch gates
Sandbox provider sign-off; legal and compliance sign-off; idempotency/race tests; full money lifecycle reconcile tests; operations/runbook; backups; alerts; on-call owner; successful staged rollback; load/recovery testing; real-device usability sample. The working mock flow is NOT a live payments release.

## The test plan (PR-014)
How to run each layer, what runs when, the mandatory money tests mapped to real tests, requirement-to-test traceability, and what is not covered yet: `docs/quality/test-plan.md`.
