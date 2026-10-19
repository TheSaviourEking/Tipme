# PR-001/002 verification — 18 October 2026

## Scope delivered

Pinned pnpm/Turbo workspace; shared strict TypeScript, ESLint and Prettier; official-generator Next/Nest shells; independent idle worker; contracts/UI/config exports; local Compose health checks; CI; environment examples; ADR-0001 and setup guide. No schema, ORM, authentication, financial domain or payment SDK was introduced. No migration implications.

## Actual command results

Executed with Node **24.22.0** and pnpm **10.33.0**. The machine's default shell still selects Node **20.20.2**: use `nvm install && nvm use` before running the workspace. For this session the pinned runtime was downloaded through `npm exec --package=node@24.22.0` and placed first on the command PATH; no global default was changed.

| Command                                 | Result | Evidence                                                                                                                        |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                          | PASS   | Lockfile generated; exact direct versions; final graph has no unmet peer warnings                                               |
| `pnpm install --frozen-lockfile`        | PASS   | Lockfile up to date; all 7 workspace projects                                                                                   |
| `pnpm format:check`                     | PASS   | All matched files use Prettier style                                                                                            |
| `pnpm lint`                             | PASS   | Governance and root tooling lint; 7 Turbo tasks successful                                                                      |
| `pnpm typecheck`                        | PASS   | Root tooling and strict package checks; 7 Turbo tasks successful                                                                |
| `pnpm test`                             | PASS   | 1 governance regression, 1 API HTTP integration, 2 worker signal tests; 7 Turbo tasks successful                                |
| `pnpm build`                            | PASS   | 5 build tasks successful; Next `/` and not-found statically prerendered                                                         |
| `pnpm exec playwright install chromium` | PASS   | Chromium installed for local validation                                                                                         |
| `pnpm test:e2e`                         | PASS   | 2 tests passed: desktop and 360px mobile Chromium                                                                               |
| `docker compose config --quiet`         | PASS   | Compose syntax/interpolation validates                                                                                          |
| `pnpm dev`                              | PASS   | Web/API/worker started; web HTTP 200, API returned `{"status":"ok","service":"api"}`; Ctrl-C exited cleanly with worker.stopped |
| `docker info`                           | PASS   | Docker Desktop started; Docker Engine 29.5.2                                                                                    |

The final repeated Turbo runs reused valid task caches; the first implementation runs and the separate clean-copy runs executed uncached builds/tests. A source copy at `/tmp/tipme-clean-f4ezzhbr/repo` excluded `node_modules`, `.next`, `dist`, `.turbo`, test outputs and TypeScript incremental files. Frozen install, format, lint, typecheck, tests and build passed there. This is a fresh-source-copy test, not a literal Git clone: this directory had no Git repository or remote. The subsequent governance scanner fix was regression-tested and validated in the primary workspace.

## Follow-up infrastructure verification

Docker Desktop was started with approval, then the following checks passed:

- `docker compose up -d --wait`: both Postgres and Redis became healthy.
- `docker compose exec -T postgres pg_isready -U tipme_local -d tipme_local`: accepting connections.
- `docker compose exec -T redis redis-cli ping`: `PONG`.
- `docker compose restart` followed by `docker compose up -d --wait`: both services returned healthy.
- PostgreSQL `SELECT system_identifier FROM pg_control_system()` returned the same cluster identifier before and after restart: `7698054636324081698`.
- A temporary Redis marker with a 600-second expiry survived restart with its expected value. Only that marker was then deleted; deletion returned `1`.
- PostgreSQL's public schema contains `0` tables. No application schema or migration was created.
- `docker compose ps` confirmed loopback bindings at `127.0.0.1:5432` and `127.0.0.1:6379`.

The local containers are left running and healthy. This verifies persistence across container restart; volume deletion/recovery and production backup restoration were not tested. Stop local services without deleting data using `pnpm infra:down`.

## Failures encountered and resolved

- Corepack initially lacked permission to populate its cache; the approved download succeeded.
- Sandboxed API test could not bind loopback (`EPERM`); approved execution allowed real HTTP testing. Before implementation, `/health` correctly failed its new test with 404 versus expected 200. After implementation it passed.
- Worker lifecycle tests initially failed before the worker existed; both SIGTERM and SIGINT pass with the implementation.
- ESLint 10 passed basic lint but produced unsupported transitive peers in Next's plugin graph. Reverted to the generator-compatible 9.39.5 pin. Its upstream deprecation remains a documented tooling follow-up, not a hidden peer override.
- Independent review found the supplied governance script printed matching credential lines. A synthetic regression failed before quiet matching and passed after; `.env`, `.env.local` and `development.env` are covered without printing values.
- Playwright emitted only terminal-color environment warnings; both browser checks passed.

## Security, finance, accessibility and performance

- API startup accepts loopback hosts and a validated port. Web, Postgres and Redis bind loopback. No real credentials or provider calls; unknown/payment routes return 404. Health is explicitly liveness only.
- Governance scan is a narrow credential-pattern guard, not a comprehensive secret scanner. It now avoids echoing matched values and skips dependency/build caches.
- Web uses semantic HTML, a tested keyboard skip link, visible focus, no horizontal overflow at 360px, system fonts and no animation or third-party client scripts. Reduced-motion readability and noindex metadata were tested. No full assistive-technology/WCAG audit is claimed.
- Next production output is static. No CWV, load-test or RUM performance target is claimed. Full tracing/correlation/operational metrics remain deferred to a later API/platform slice.
- Screenshots were visually inspected: [desktop](evidence/bootstrap-desktop.png), [mobile](evidence/bootstrap-mobile.png). The desktop screenshot includes the main-region keyboard focus outline.

## Files and governance

Added root package/lock/workspace/task/compiler/lint/format/editor configuration; app source, manifests, configs and tests under `apps`; shared exports under `packages`; Playwright configuration and `tests/e2e`; active `.github/workflows/ci.yml`; setup, ADR, plan, report and screenshots.

Preserved root/scoped AGENTS, decisions, PRD and original setup/architecture/quality docs. Small existing-file changes: README adds navigation; component register records Tailwind; Compose adds Redis health; `.gitignore` ignores compiler state; old CI template becomes manual-only; governance script fixes credential-output leakage.

## Unverified / deferred

- Hosted GitHub Actions, branch protection, commit/PR creation: not run; no Git repository or remote exists here. The CI command sequence was exercised locally, not on Linux GitHub runners.
- No dependency vulnerability audit, full secret scan, financial flows, load test or production readiness claim.

## Next PR

PR-003: the approved responsive web/profile shell, tokens and public metadata decisions. PR-004 can then extend platform validation/correlation/observability and dependency readiness. ORM and schemas still require ADR-0002; live-money blockers remain unchanged.
