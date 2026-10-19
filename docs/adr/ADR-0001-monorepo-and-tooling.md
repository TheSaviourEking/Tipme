# ADR-0001: Monorepo and bootstrap tooling

- Date: 2026-10-18
- Status: Selected for development bootstrap under the user's PR-001/002 instruction; no production/payment approval implied.

## Context and scope

The initial directory contained governance, PRD v1.0, Compose and prompts, with no Git metadata, application code, manifest or lockfile. The current task explicitly includes minimal app shells within PR-001/002 even though the delivery plan schedules full web/API slices for PR-003/004. Those later slices remain deferred. Existing governance content is preserved; the old executable CI template is made manual-only to avoid a second, incorrectly ordered workflow.

## Decision

Use pnpm workspaces and Turbo, Next App Router for the web shell, Nest for a health-only API, and a separate lightweight Node worker. No database package, ORM, auth, payment adapter, financial schema or money code is introduced.

| Tool                                        | Exact selected version | Rationale                                                                                                 |
| ------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Node.js                                     | 24.22.0                | Node 24 LTS; satisfies all generator engines                                                              |
| pnpm                                        | 10.33.0                | Existing Corepack-selected version; pinned in packageManager                                              |
| Turbo                                       | 2.11.9                 | Workspace task ordering/cache                                                                             |
| create-next-app / Next / eslint-config-next | 16.4.2                 | Matching official generator/runtime/config                                                                |
| React / React DOM                           | 19.3.0                 | Official Next generator selection                                                                         |
| Nest CLI                                    | 12.0.8                 | Official generator                                                                                        |
| Nest common/core/platform-express           | 12.1.3                 | Aligned framework packages                                                                                |
| TypeScript                                  | 5.9.3                  | Shared compiler supported by Next and typescript-eslint; Nest CLI carries its own 6.0 compiler dependency |
| ESLint                                      | 9.39.5                 | Compatible intersection of Next's React/import/a11y plugins                                               |
| typescript-eslint                           | 8.71.2                 | Supports TypeScript >=4.8.4 <6.1 and ESLint 9                                                             |
| Prettier                                    | 3.9.10                 | Formatting                                                                                                |
| Tailwind / Turbopack loader                 | 4.3.3                  | Official Next template tooling; no component libraries                                                    |
| Playwright                                  | 1.64.1                 | Chromium desktop/mobile smoke checks                                                                      |
| Zod                                         | 4.6.7                  | Validate API startup environment without logging values                                                   |
| PostgreSQL / Redis                          | 16-alpine / 7-alpine   | Preserve kit's local-only major image lines                                                               |

Every direct package version is exact; transitive resolutions are in `pnpm-lock.yaml`. Compose image tags intentionally remain mutable development patch lines, not immutable production deployment artifacts. Node engines are exact so fresh-clone checks use the tested runtime.

## Compatibility evidence and sources

Official references checked before scaffolding:

- [Node release matrix](https://nodejs.org/en/about/previous-releases): Node 24 LTS line.
- [Next installation](https://nextjs.org/docs/app/getting-started/installation): Node >=20.9; lint is a separate check.
- [Nest CLI](https://docs.nestjs.com/cli/overview): current schematics require Node ^22.22.3, ^24.15.0 or >=26.
- [Nest first steps](https://docs.nestjs.com/first-steps): current ESM runtime requirements.

Registry metadata was checked with `npm view` for exact versions, engines and peer dependencies. The generated Next template uses React 19.3, Tailwind's Turbopack loader and TypeScript 5. The generated Nest template is ESM. The API keeps ESM imports and decorator metadata.

ESLint 10.13.0 was evaluated: the top-level Next config accepts it, but transitive eslint-plugin-react 7.37.5, eslint-plugin-import 2.32.0 and eslint-plugin-jsx-a11y 6.10.2 do not declare support. ESLint 9.39.5 is deprecated upstream but is the compatible generator baseline; retain it for this development slice, then update as a tested tooling PR when the plugin graph supports 10. No peer overrides hide incompatibility.

## Generator provenance

Executed in `/tmp/tipme-bootstrap-generators` with Node 24.22.0:

```sh
pnpm dlx create-next-app@16.4.2 /tmp/tipme-bootstrap-generators/web --ts --eslint --tailwind --app --src-dir --import-alias '@/*' --use-pnpm --skip-install --disable-git --yes
pnpm dlx @nestjs/cli@12.0.8 new api --strict --skip-git --skip-install --package-manager pnpm
```

Only source/config/manifests were copied; generated AGENTS, README, Git metadata and demo assets were not copied over the kit. Generated greetings and external font requests were replaced with a static development shell and explicit process liveness.

## Boundaries and consequences

- `packages/contracts` owns the health output DTO. UI exports tokens; config exports strict TS and ESLint presets. All packages are private.
- Native Node test runner exercises compiled API/worker behavior without another unit test framework or decorator transpiler.
- API ingress validation pipe is configured for future DTO routes; the only present route is read-only `/health`. Startup variables are validated and bind only to loopback. _Superseded by [ADR-0005](ADR-0005-observability-logging-and-jobs.md): validation is zod-only; `class-validator`/`class-transformer` were removed._
- The web page is noindex and has no payment controls, remote assets or client application components. Public profile SEO/canonicals await PR-003 and an approved domain.
- Worker is idle with structured liveness events and graceful signals; it does not claim queue readiness.
- Docker services use named volumes and loopback ports. No migration or seed exists; scripts fail explicitly until ADR-0002.
- Full tracing, request correlation, readiness probes, runtime metrics, visual design, privacy instrumentation and load targets belong to subsequent slices. No customer-critical transaction exists here.
- CI tests clean dependency installation, format/lint/typecheck/tests/build and browser smoke. Git hosting, branch protection and actual hosted CI execution require a repository/remote.

See [bootstrap setup](../BOOTSTRAP-SETUP.md) and the verification report for actual local results and environmental limitations.
