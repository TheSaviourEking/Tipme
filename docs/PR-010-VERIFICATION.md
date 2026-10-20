# PR-010 verification — 20 October 2026

## Scope delivered

The release rehearsal and a staging setup that is ready to wire in. Pretend money only. The VPS, DNS and Vercel project are not provisioned yet (the user's choice: "I'd get the VPS and you wire it in later").

- **One release check for any copy** (`pnpm release:check --web … --api … [--full]`).
  - **Read-only** (safe anywhere):
    - health and version;
    - no live payments;
    - the password gate refuses the API and the pretend inbox;
    - LCP ≤ 2.0 s on a throttled phone, plus axe;
    - private pages are noindex;
    - admin refuses outsiders.
  - **Full** (only where the copy says `RELEASE_KIND=test`):
    - QR visit → tip → paid → dashboard and notification;
    - a provider problem in the admin inbox, resolved by staff;
    - withdraw everything;
    - admin numbers unchanged;
    - then cleanup.
- **Rehearsal data is tagged and hidden, never deleted.** Pages, events and issues from a run are excluded from metrics, the funnel, visibility and the default inbox. Ledger, history and audit stay as written. Finishing a run closes its issues.
- **Staging layout:**
  - Vercel (web) + one VPS with Docker Compose: Caddy HTTPS, API, worker, Postgres 16, Redis 7, daily backups, and an optional rclone off-site copy.
  - Private behind one password across both hosts (`/preview-login`, a gate on each side).
  - Each copy declares `RELEASE_KIND`; `/health/release` reports it.
- **Deploy and rollback:**
  - `deploy.sh <sha>`: build → backup → guarded migrate → switch → health; reverts itself if the new version is unhealthy.
  - `rollback.sh`: goes back one version at a time, never forward.
  - Migrations are forward-only and compatible with the previous release.
- **Backups:**
  - Encrypted, daily, from a database snapshot with a manifest.
  - A restore drill into a scratch database, and a real-restore tool that drops, recreates and proves the database.
- **Runbooks:** staging setup (VPS hardening, Vercel), deploy and rollback, backup and restore, release day. ADR-0011.

Design: `docs/superpowers/specs/2026-10-19-pr010-release-rehearsal-design.md`. Plan: `docs/superpowers/plans/2026-10-19-pr010.md`. Ledger (every ruling and deferred minor): `.superpowers/sdd/2026-10-19-pr010/progress.md`.

## Proven on a local copy of staging

`pnpm staging:local:up` runs the server's own Compose file on this machine. Caddy serves both hosts over HTTPS with its own certificate, and `next start` stands in for Vercel.

| Proof                                                                     | Result                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| First deploy: backup of an empty database, guarded migration, services up | PASS (idle memory about 310 MB in total: API 166 MB, worker 82, Postgres 35, Caddy 19, Redis 11)           |
| Read-only check through the password gate                                 | 4/4 PASS                                                                                                   |
| Full check (rehearsal tips, admin issue resolved, withdrawal, cleanup)    | 5/5 PASS; the database confirmed the run's tips, the resolved issue, the deleted page and the finished run |
| Rollback drill: A → B (with a migration) → back to A → full check         | PASS (B's column still present while A runs)                                                               |
| Restore drill inside the stack                                            | PASS                                                                                                       |
| Real restore (`restore.js`) then the full check again                     | PASS, then 5/5 PASS                                                                                        |

## Commands (Node 24.22.0, pnpm 10.33.0), after the review fix pass

| Command                          | Result                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck`   | PASS, 15/15 tasks each                                                                                     |
| `pnpm build`                     | PASS, 9/9                                                                                                  |
| `turbo run test`                 | PASS, 17/17 tasks                                                                                          |
| `node --test scripts/*.test.mjs` | 18/19. The failure is `scripts/preview-gateway.test.mjs`, owned by the concurrent hosting session          |
| `pnpm db:migrate`                | PASS, migration 0022                                                                                       |
| `pnpm test:integration`          | PASS, 294/294                                                                                              |
| `pnpm test:e2e`                  | 119 passed, 1 skipped, 2 failed: both are `shell.spec.ts`, the hero heading changed by the hosting session |
| `pnpm format:check`              | Fails only on files owned by the hosting session (its commits, untouched here)                             |

Two e2e runs during the work were invalidated by the machine sleeping (single tests lasting 15–41 minutes) and were rerun. The existing expired-tip test showed its known timing race once.

## Final review

One fresh, read-only reviewer found no Critical issues, five Important ones and twelve Minor ones. These were fixed, each with a test that failed first:

1. **Seeds and plain migrations on a server:** naming the database also unlocked them. Now only the grant command accepts it.
2. **Open redirect after the staging login** (`/\t/evil.com`). Re-graded from Minor.
3. **No tool for a real restore,** and a runbook that would have left a half-migrated database. `restore.js` now drops, recreates, restores and proves.
4. **A second rollback went forward** to the version just backed out.
5. **A database password containing `/`** broke the first deploy.
6. **The real deploy and rollback scripts had never run,** and the backups folder needed the right owner. They are now tested with stand-in tools, and `deploy.sh` checks the folder's owner first.

Eleven minors are deferred (ledger lines starting `Final: minor (deferred)`).

## Wiring in later (the user's step)

1. Buy the VPS (suggested: 2 vCPU, 4 GB, London or Frankfurt).
2. Follow `docs/runbooks/staging-setup.md` (DNS, hardening, env file, Vercel, first deploy, release-check staff).
3. Run `pnpm release:check --full` against the real hosts.

Not proven until then: real TLS and DNS, Vercel's build of the monorepo, the VPS's memory under load, and the off-site bucket.
