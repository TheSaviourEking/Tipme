# Local setup: Mac / Apple Silicon and Linux

This is an **ordered instruction set for a coding agent**, not proof that setup has already been executed. Prefer official generators pinned to verified compatible versions.

## A. Prerequisites
- Git and GitHub CLI (`git --version`, `gh --version`). Configure SSH (or HTTPS auth) with private repo access.
- Node.js active LTS (confirm with current official Node release matrix; do not blindly install the latest major). Use `fnm`, `nvm` or `mise`; record selected version in `.nvmrc` and `package.json.engines`.
- `corepack enable`; activate a verified pnpm release, pin as `packageManager` in root manifest.
- Docker Desktop or compatible Docker Engine + Compose plugin (`docker compose version`).
- Optional on Mac: Homebrew for system prerequisites; make sure Docker daemon is started.
- Editor (VS Code, Cursor, Cline, Codex or Claude Code) configured for workspace, local shell permissions reviewed.
- Never rely on a developer's globally installed framework CLI for reproducibility.

## B. Repository initialization
```bash
mkdir tipme && cd tipme
git init -b main
# Copy all files from tipme-agent-kit into THIS repo root
# Read AGENTS.md, docs/00-DECISIONS.md, then choose tool versions
node --version
corepack enable
corepack pnpm --version
```
Add a root `package.json` with `private:true`, `packageManager:<pinned pnpm>`, workspaces via `pnpm-workspace.yaml`, and scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `format:check`, `db:migrate`, `db:seed`, `infra:up`, `infra:down`. Use Turbo for pipeline coordination only after packages exist.

## C. Scaffold order (one PR per meaningful stage)
1. Initialize Next.js App Router in `apps/web` using **official create-next-app**, TypeScript, ESLint, src dir, Tailwind; install and verify compatibility. Use `pnpm dlx create-next-app@<verified-version>` or equivalent. Don't specify an unverified version in repo docs.
2. Initialize NestJS API in `apps/api` using verified Nest CLI; strict TypeScript, REST, health endpoint; package name `@tipme/api`.
3. Initialize NestJS worker in `apps/worker` OR lightweight Node worker using the same shared domain packages; distinct process and health metrics. No payment logic yet.
4. Create `packages/contracts`, `packages/ui`, `packages/config`, each with explicit public exports.
5. Introduce `packages/database` only after ORM ADR; migrations are version controlled. Do not execute production migrations from local machine.
6. Install lint, format, typecheck, unit test, web E2E and API integration test commands. Ensure root commands pass on clean checkout.
7. Add `.env.example` for every app and `docker-compose.yml` for local Postgres/Redis; use safe dummy credentials locally.
8. Add CI workflow: install from lockfile, lint, typecheck, test, build. Later add e2e and migration drift checks.
9. Commit in small stages: `chore: bootstrap monorepo`, `feat: web shell`, `feat: api health`, `test: ci baseline`.

## D. First local boot (once agent has scaffolded apps)
```bash
cp .env.example .env  # example local-only env, never commit .env
docker compose up -d
docker compose ps
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm dev
```
**Caution:** `--frozen-lockfile` is for an existing committed lockfile; on the first setup the agent runs `pnpm install`, reviews changes, and commits the lockfile. Only run migrations after ORM is selected and local DB verified.

## E. Ports and names (proposed, update when created)
- web: http://localhost:3000
- API: http://localhost:4000/api/v1
- API health: http://localhost:4000/health
- Postgres: localhost:5432
- Redis: localhost:6379
- No unauthenticated admin or telemetry endpoint should bind to public internet.

## F. Definition of setup complete
- Fresh clone passes install/CI locally with lockfile; app shells boot; health endpoint responds; Docker volumes persist; no secrets committed.
- Web has brand token, mobile-responsive route, SEO metadata; API has request validation and health; worker starts and shuts down cleanly.
- Agent records actual framework/package versions, `node --version`, tested commands and screenshots in PR.
- No fake transaction-success logic or any live payment provider API calls.
