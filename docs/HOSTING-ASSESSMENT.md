# Hosting assessment and initial Git import

Date: 19 October 2026. Assessment only; no deployment or production configuration changes.

## Current state

The workspace had no Git repository. Initial import uses main and the configured Git identity. Existing code includes PR-009 analytics and operations, while ACTIVE_TASK and HANDOFF previously stopped at PR-008. Preserve that implementation; this assessment does not certify PR-009 complete. Earlier PR labels describe work milestones, not actual Git pull requests.

Node 24.22.0, pnpm 10.33.0, Turborepo, Next.js 16.4.2, NestJS API, a persistent BullMQ worker, PostgreSQL 16 and Redis 7 are configured. Docker Compose currently supplies local infrastructure only. CI already runs on push and pull request.

## Recommended topology (proposed, budget and provider unapproved)

For the eventual hosted app, use Vercel for the Next.js web app and Render for the API, persistent worker, managed Postgres and Redis-compatible Key Value. Keep API, worker and data in one region; measure latency from the launch market before choosing it. An all-Render deployment is an alternative with one provider to operate and a self-hosted Next.js process.

Vercel supports monorepos: https://vercel.com/docs/monorepos
Render service types: https://render.com/docs/service-types
Render persistent workers: https://render.com/docs/background-workers
Render Postgres: https://render.com/docs/postgresql

These capabilities fit the service shapes; deployment compatibility with the exact pinned versions still needs verification. No price or availability commitment is made. Budget must include always-on API and worker, database backups, queue persistence, telemetry and egress, as well as frontend hosting.

Use HTTPS web and API subdomains of the same owned domain. Current cookies are Secure and SameSite=Lax; unrelated provider default domains are unsuitable for authenticated browser requests. Keep database, Redis and telemetry endpoints private. Set explicit WEB_ORIGIN, NEXT_PUBLIC_API_ORIGIN, server-side API origin and SITE_URL; browser public variables are build-time inputs.

## Concrete deployment blockers

- API HOST validation only accepts loopback; web start also binds to 127.0.0.1. Managed container ingress needs an explicit supported bind configuration and tests.
- API and worker reject mock payments under NODE_ENV=production; API also rejects mock messaging. Only mock adapters exist. Do not remove these gates or expose development mode as a production workaround.
- A hosted mock preview needs a separately designed, access-controlled preview mode, including protection for pretend delivery and checkout endpoints. A public marketing-only deployment is a smaller alternative but must explicitly disable unavailable journeys.
- Database migration and owner-grant scripts are local-only. A reviewed release migration path, target verification, backups, restore test and staff bootstrap are needed before hosted data is used. No remote migrations were run.
- Root .env.example is for local use; do not copy its placeholder secrets to hosting. Generate service-scoped secrets in the host secret store.
- Turbo build inputs currently omit SITE_URL and the server-side profile API origin. Review cache inputs before deploying multiple environments.
- No deployment manifest, app Dockerfiles, hosted monitoring, restore evidence or rollback drill exists in this assessment.
- Payment, custody, messaging, privacy and hosting decisions remain subject to the decision register and accepted ADRs. Real money remains disabled.

## Initial import groups

1. Workspace tooling, CI and local development configuration.
2. Shared contracts, domain, database, payments, observability and UI packages.
3. API and worker services.
4. Web application and assets.
5. Cross-service integration and browser tests.
6. Governance, architectural decisions, existing evidence and hosting assessment.

These are logical groups of the current snapshot, not invented historical implementation commits. Intermediate commits are not independently runnable; validate the combined tip. Preserve existing files and migrations unchanged.

## Verification in this task

- pnpm format:check: PASS.
- pnpm lint: PASS (15 Turbo tasks, cached).
- pnpm typecheck: PASS (15 Turbo tasks, cached).
- pnpm build: PASS (9 Turbo tasks, cached).
- pnpm test: initial sandbox run blocked by localhost bind EPERM; rerun outside sandbox PASS (17 Turbo tasks, cached, plus root script tests).
- Initial import candidate scan: 545 files; no common private-key, GitHub token, AWS access-key ID or live payment-key pattern found. This is a limited pattern scan, not a security certification.
- .env, node_modules, dist, .next, .superpowers and test results excluded from import.
- Integration, browser, live accessibility and performance checks: NOT RERUN for this Git/documentation task. Historical evidence is preserved but is not fresh validation of PR-009.
- No business logic, financial flows, UI or migrations changed.

## Next step

Push once the user supplies the remote destination. Then agree preview versus production scope, domain, hosting budget and provider; implement a narrow deployment-readiness change with targeted tests and an ADR where required.
