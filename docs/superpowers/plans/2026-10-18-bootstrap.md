# PR-001/002 bootstrap implementation plan

**Goal:** Reproducible local tooling and minimal app shells, without payments or persistence code.
**Spec:** prompts/00-BOOTSTRAP-AGENT.md, docs/01-LOCAL-SETUP.md, and the user's explicit PR-001/002 request.
**Architecture:** pnpm/Turbo monorepo, Next App Router web, Nest API, independent Node worker. Contracts and UI tokens remain framework-independent; config is shared.
**Constraints:** Preserve governance. No live payments, schema, secrets, remote services or unrelated UI libraries. Strict TypeScript. Explicit package exports.

## Tasks

- [x] Verify toolchain and generate Next/Nest shells in temporary directories, copying without overwriting governance.
- [x] Pin workspace manifests, Node/pnpm, shared config, lint, formatting and Turbo tasks; install and lock dependencies.
- [x] Add health HTTP integration tests and worker lifecycle tests before implementing those behaviors. Add browser shell smoke coverage. Implement only liveness, graceful shutdown and static branded web placeholder.
- [x] Add local environment examples, Compose health checks, CI and setup documentation; record exact versions in ADR-0001.
- [x] Run frozen install, format, lint, typecheck, test, build, browser smoke, Compose config and fresh-copy verification; record evidence and skipped checks.

## Review focus

- Wrong Node on PATH: engines and version files must fail clearly.
- Fresh workspace without generated dist files: task dependencies must build contracts before consumers.
- Unknown HTTP routes: 404, never simulated payment success.
- Worker SIGTERM/SIGINT: clean exit without retained handles.
- Docker unavailable: report runtime checks skipped, never claim database readiness.

## Rulings and progress

- User explicitly requested minimal shells alongside PR-001/002; this narrows shells from later delivery-plan PRs without implementing product flows.
- Directory is not a Git repository; work remains in the specified directory, no worktree/commits/remote actions.
- Existing detailed bootstrap specification and direct implementation request authorize these changes; no additional design approval is needed.

- Final independent review found an inherited credential-output issue in the governance scan; a synthetic regression reproduced it, quiet matching fixed it, and the test passed.
- Fresh-copy verification passed without node_modules, dist, .next or Turbo cache. Full local validation and browser smoke passed; Docker runtime was subsequently verified after starting Docker Desktop; hosted CI remains unavailable, not passed.

- Follow-up: Postgres/Redis health and persistence across restart passed; Postgres has zero application tables. Containers remain running on loopback.
