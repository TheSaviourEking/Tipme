# PR-011 verification — 22 October 2026

## Scope delivered

Hardening after the PR-010 audit, items 1 to 5. Pretend money and messages only. The VPS is still not provisioned, so staging items are proven on the local copy of staging (`pnpm staging:local:up`).

- **Point-in-time recovery (RPO ≈ 5 min; PRD ≤ 15).**
  - Postgres archives WAL every 5 minutes at most, flushed to disk before it counts as archived. A retried segment that is already archived with the same bytes counts as done.
  - A daily encrypted `pg_basebackup` runs alongside the logical dumps, and every run is recorded in `backup_runs`.
  - `pitr-drill.sh` restores base backup + WAL into a throwaway server. It passes only if a row written after the backup comes back and the ledger balances.
- **Alerts.** The `staging-watch` workflow runs every 15 minutes and checks:
  - the API and web app are up;
  - no live payments;
  - each backup is under 26 hours old;
  - WAL was archived in the last 15 minutes, with no archiving failure in the last hour.

  A failure emails the owner, and an optional webhook posts to chat. `GET /health/backups` reports ages and counts only.

- **Error tracking.** TipMe's own Sentry-envelope sender (Sentry or GlitchTip) sends only the error type, a safe code, stack frames, the route pattern or job name and the trace id. It is off without `SENTRY_DSN` and capped at 30 a minute.
- **Message moderation.** A recipient can hide or report a paid tip's message. A report hides the message and opens a `message_reported` issue. Staff read the text only through the audited reveal, which asks for a reason.
- **Search engines.** `robots.txt` and `sitemap.xml` exist. Private areas are always disallowed, and indexing stays off until `SITE_INDEXING=on` on a copy without the preview password.
- **Handle renames.**
  - The handle is changed in Settings. Old handles stay with the page, at most 5, and nobody else can claim them.
  - This is enforced in the database too, so a rolled-back release cannot hand an old handle out.
  - The API answers 308 with the new handle, and the web app redirects 308 to `/@new`, keeping `?src=qr`.
- **Security scanning in CI.**
  - `pnpm audit --prod --audit-level=high`.
  - gitleaks over the whole history: image pinned by digest, findings redacted.
- **Load tests.** k6 (pinned) runs against a throwaway API with the PRD §10.1 budgets as thresholds, in the CI integration job (`pnpm test:load`).
- **Real-user web vitals.** `POST /v1/vitals` accepts only a metric, a value and a page kind, under the same rules as analytics: off in production until D-07, and GPC/DNT honoured. The admin Overview shows mobile p75 over 28 days against LCP ≤ 2.0 s, INP ≤ 150 ms and CLS ≤ 0.05.
- **OpenAPI 3.1.**
  - `pnpm api:openapi` generates `docs/api/openapi.json` from the routes Nest registers and the zod schemas the routes validate with.
  - A test proves it matches Express's route table exactly.
  - CI fails when the file is stale.
- **Docs.**
  - Decision register: messaging providers are now D-11. D-08 is the hosting and monitoring budget, and the references that mixed them up are fixed.
  - ADR-0012, runbooks (PITR drill and point-in-time restore, alerts, reported messages), `staging.env.example` (`SENTRY_*`) and register entries.

Plan: `docs/superpowers/plans/2026-10-21-pr011-hardening.md`. Ledger (every ruling and deferred minor): `.superpowers/sdd/2026-10-21-pr011/progress.md`.

## Evidence

| Check                                                              | Result                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Format, lint, typecheck                                            | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: all exit 0                                                                                                                                                                                                                                                                                         |
| Unit tests (all packages + scripts)                                | 174/174 (scripts 36, api 31, web 31, domain 25, worker 20, observability 16, contracts 9, payments 4, database 2)                                                                                                                                                                                                                                      |
| Integration (`pnpm test:integration`)                              | 316/316 (after every fix, including the reviewer's minor findings)                                                                                                                                                                                                                                                                                     |
| End-to-end (`pnpm test:e2e`)                                       | 64/64 after every fix (and twice in a row before the minor fixes) (it includes the new `hardening.spec.ts`: report a message, rename with QR redirect, robots)                                                                                                                                                                                         |
| PITR drill, local staging                                          | PASSED: the marker written after the base backup came back and the books balance. FAILED, as it should, with an empty WAL archive (marker found = 0). Run before the review's archive-script fix; that fix is covered by `scripts/archive-wal.test.mjs` (3/3) and by `cmp`/`sync` checked in `postgres:16.13-alpine`. Rerun the drill once on the VPS. |
| WAL archiver, local staging                                        | `archive_mode` on, segments archived, 0 failed                                                                                                                                                                                                                                                                                                         |
| Watcher, local staging                                             | healthy                                                                                                                                                                                                                                                                                                                                                |
| Load test (`pnpm test:load`, 80 req/s for 30 s)                    | p95: profile 9.12 ms (≤ 200), checkout 22.19 ms (≤ 400), dashboard 19.22 ms (≤ 300); 5xx 0% (< 0.1%). With budgets scaled to 0.1% the run fails (k6 exit 99), so the thresholds bite.                                                                                                                                                                  |
| `pnpm audit --prod --audit-level=high`                             | No known vulnerabilities                                                                                                                                                                                                                                                                                                                               |
| gitleaks v8.24.3 (history of a fresh clone, and the working files) | No leaks (3 false positives allowed by exact match: the public RFC 6238 test key and a moment key)                                                                                                                                                                                                                                                     |
| OpenAPI                                                            | 77 operations = Express's route table; `--check` fails before regenerating and passes after                                                                                                                                                                                                                                                            |
| `next build`                                                       | OK; `/robots.txt` and `/sitemap.xml` built                                                                                                                                                                                                                                                                                                             |

## Final review

A fresh reviewer read the whole branch. Its five Important findings were each fixed, with a test that failed first:

1. A crash between archiving and recording a WAL segment wedged archiving for good. Fixed: a retry with the same bytes succeeds, and different bytes are still refused.
2. Archived WAL was not flushed to disk before it counted as archived. Fixed: it is synced before the rename, and the directory after.
3. The point-in-time runbook left the new timeline out of the archive. Fixed: archiving is on in the recovery server, a fresh base backup is taken straight away, and the `.history` file is checked.
4. A rolled-back release could give an old handle to someone else. Fixed: migration 0028 adds database triggers with a per-handle lock.
5. The new web app crashed Settings and the Overview while still talking to the older API. Fixed: the new fields are optional and guarded.

One more fix came out of the full e2e run under load. A render of the old page already in flight could cache it again after the rename, and its tip button would then fail for up to 30 seconds. The API now sends the old handle's refresh signal a second time, 2 seconds later (test first).

The reviewer's minor findings were fixed as well before committing, each with a test that failed first where one is possible:

- WAL is kept back to the base backups a restore needs, rather than by age, and timeline `.history` files are kept.
- Base backups are written as `.partial` and renamed only once complete.
- The off-site copy sends backups and WAL separately, skips files still being written, and the runbook names both remote folders.
- `rollback.sh` warns when the target version has no WAL archiving.
- The watcher uses repository-level settings, so an approval rule on the `staging` environment cannot stall it.
- Error-report frames are read only from the stack, and paths outside TipMe's code are cut down.
- `/health/backups` shares one database answer for 30 seconds.

## Not done here

- **Wiring the real VPS:** this waits for the server's details.
- **Rotate the staging preview password:** it was exposed in an editor selection earlier, so it should be rotated.
- **Still open:** real payments, payouts and messaging (D-03 to D-08, D-11); indexing public profiles (D-06); turning analytics and web vitals on in production (D-07).
