# PR-004 verification — 18 October 2026

## Scope delivered

Traceable API and worker foundation, with no money paths: OpenTelemetry tracing from API requests into BullMQ worker jobs; structured JSON logs stamped with the trace ID; the trace ID returned as the support reference; liveness and readiness health checks; a consistent error envelope; zod validation from shared contracts; request limits; Prometheus-format metrics; idempotent, retried worker jobs with graceful shutdown; local Jaeger; `pnpm trace:demo`; a support runbook; ADR-0005.

Design: `docs/superpowers/specs/2026-10-18-pr004-observability-design.md`. Plan: `docs/superpowers/plans/2026-10-18-pr004.md`.

## Acceptance checks

| #   | Check                          | Evidence                                                                                                                                                                                                                                                                                      | Result |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | One trace, end to end          | `trace-flow` integration test (job span descends from the API request span); live `pnpm trace:demo` → Jaeger shows 8 spans across `tipme-api` and `tipme-worker` ([screenshot](evidence/pr004/trace-succeed.png))                                                                             | PASS   |
| 2   | Logs line up                   | Integration test; live grep of the reference returned the API `http.request` line (202) and the worker `job.completed` line                                                                                                                                                                   | PASS   |
| 3   | Health tells the truth         | Unit test (unreachable ports → 503 in < 3 s); live: stopping Postgres → `postgres: down` 503 with liveness 200, restart → 200; same for Redis                                                                                                                                                 | PASS   |
| 4   | Clean errors                   | API unit tests: envelope plus reference header, 400 with field paths only, malformed JSON not echoed, 413, 503                                                                                                                                                                                | PASS   |
| 5   | No private data leaks          | Integration test: message text, a card-like number and an `Authorization` header absent from all spans and logs; logger and query-scrub unit tests                                                                                                                                            | PASS   |
| 6   | Worker resilience              | fail-once → completed after 2 attempts; fail-always → failed after 3, with backoff visible ([screenshot](evidence/pr004/trace-fail-always.png)); duplicate delivery → one `job.completed` + one `job.duplicate`; corrupt payload → failed after 1 attempt; SIGTERM finishes the in-flight job | PASS   |
| 7   | Monitoring can't break the app | Dead collector: integration test (request + job succeed) and unit test (shutdown < 5 s)                                                                                                                                                                                                       | PASS   |
| 8   | Startup safety check           | Empty env → `Invalid configuration: DATABASE_URL, REDIS_URL` (API) and `REDIS_URL` (worker), exit 1, no values printed                                                                                                                                                                        | PASS   |
| 9   | Request limits                 | 16 KB body → 413; `requestTimeout` 10 s                                                                                                                                                                                                                                                       | PASS   |
| 10  | Basic counts                   | Live `/metrics`: `tipme_jobs_processed_total{outcome}`, `tipme_jobs_waiting`, `tipme_jobs_failed`, 68 `http_server_*` series on the API                                                                                                                                                       | PASS   |
| 11  | Support runbook                | `docs/runbooks/find-a-trace.md`                                                                                                                                                                                                                                                               | DONE   |

## Commands (Node 24.22.0, pnpm 10.33.0, Docker Engine 29.5.2)

| Command                                           | Result                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prettier --check .`                              | PASS for all PR-004 files; **one warning** on `docs/architecture/IMPLEMENTATION_BASELINE.md`, created by someone else during this work and deliberately left untouched |
| `pnpm lint`                                       | PASS — 9/9 tasks                                                                                                                                                       |
| `pnpm typecheck`                                  | PASS — 9/9 tasks                                                                                                                                                       |
| `pnpm test` (no infrastructure)                   | PASS — root 4, contracts 3, observability 10, api 17, worker 13, web 1 (after review fixes)                                                                            |
| `pnpm build`                                      | PASS — 6/6 tasks                                                                                                                                                       |
| `pnpm test:integration` (Postgres + Redis)        | PASS — 12/12 after review fixes; three consecutive green runs (11/11) after the race fix below                                                                         |
| `pnpm test:e2e` (PR-003 web)                      | PASS — 33 passed, 1 skipped (mobile-only nav test on desktop)                                                                                                          |
| `docker compose config --quiet`                   | PASS                                                                                                                                                                   |
| `docker compose up -d --wait` incl. Jaeger 2.21.0 | All three services healthy; Jaeger UI 200                                                                                                                              |

## Defects found and fixed during implementation

- Idle worker took ~10 s to exit after SIGTERM (a pending drain timer kept the process alive). Test "an idle worker must stop promptly" failed at 10.4 s and passes at 0.33 s.
- Job status read the job before its state, so a terminal state could be paired with a stale attempt count (seen as a flaky integration failure). The API and the test helper now read the state first.
- Body-parser errors (413) are not Nest `HttpException`s and fell through to 500. They are now mapped by their `http-errors` status.
- An OTLP export to a dead collector held shutdown for 9 s. The timeout is now 2 s, guarded by a test.
- An invalid route parameter reported `(body)` instead of `jobId`.
- Mutation check: removing trace propagation in the worker makes the end-to-end trace test fail, so the test guards the core promise.

## Final review

One fresh reviewer (separate context, read-only) checked the whole change set. Verdict: **ready with fixes**. Fixed, each with a test that failed first:

1. Exception messages, stack traces and span status text could carry request-body fragments (JSON parse errors quote input) into Jaeger. These are now removed before export; an end-to-end test sends a malformed body.
2. The 10 s shutdown bound did not force anything (BullMQ returns the in-flight close). A hung close is now abandoned.
3. The 5 s job timeout was advisory. The handler is now raced against it, and the marker Redis client fails fast instead of queueing.
4. A duplicate delivery re-ran the work. An already-completed key is now skipped before any work. Concurrent duplicates can still both run until database idempotency arrives (PR-005).
5. Diagnostics could switch on if `NODE_ENV` was forgotten. An unset `NODE_ENV` now counts as production.

Deferred minors (reviewer findings, not fixed): trust of incoming `traceparent` sampling flags; the SDK's default log exporter; client IP/user agent on spans (D-08); no catch/time bound on shutdown errors; failed-attempt metric naming; suffix redaction patterns; the demo link can briefly precede span export; an enqueue timeout can double-enqueue on retry; backoff timing and restart recovery not asserted automatically.

## Known limitations

- No Nest-level spans with Nest 12's ESM build (instrumentation-nestjs-core 0.68). Express and HTTP spans cover the request.
- Local Jaeger keeps traces in memory only. Production backend, retention, access and alerting wait for D-08.
- Redis-backed jobs are not durable financial storage; the Postgres outbox comes in PR-005.
- Hosted CI not run (no Git repository or remote). The CI file now starts Postgres and Redis and runs `pnpm test:integration`.
- The diagnostics endpoint is development-only and refused in production.

## Environment changes made

- Docker Desktop was started (it had stopped) and `docker compose up` started Postgres, Redis and the new Jaeger. They are left running; stop them with `pnpm infra:down` (data is kept).
- Created a local `.env` from `.env.example` (no secrets; it did not exist before).
- The API and worker started for the live demo were stopped afterwards. The web dev server on :3000 was left as found.

## Next PR

PR-005 (contracts/DB: ORM ADR-0002, initial schema, transaction and outbox invariants) needs explicit authorisation.
