# PR-004 design — traceable API and worker foundation

Status: DRAFT for user approval. Date: 2026-10-18.

## Intent

When a supporter later says "my tip didn't go through", someone should open **one place** and follow the whole journey end to end. The user's words: "all the e2e observability trace". Money flows do not exist yet (PR-005 to PR-007). PR-004 builds the plumbing so every later step joins the trace automatically instead of having tracing bolted on afterwards.

## Goals (agreed acceptance checks)

1. **One trace, end to end.** With `pnpm infra:up` and `pnpm dev` running, `pnpm trace:demo` sends a harmless diagnostic request. The API hands a job to the worker and the command prints a Jaeger link. Jaeger shows one connected trace: API request → enqueue → worker processing, plus the Postgres/Redis calls.
2. **Logs line up.** Searching API and worker logs for that trace ID returns exactly that request's lines, from both services.
3. **Health tells the truth.** Liveness stays up while readiness reports `postgres`/`redis` down when either is stopped, and recovers when it restarts.
4. **Clean errors.** Invalid input → 400 with a consistent error body containing a `reference` (the trace ID). Unexpected failures → 500 with a generic message. Never stack traces or internal details.
5. **No private data leaks.** An automated test sends message-like text, a card-number-like string and an `Authorization` header and asserts none appear in any log line or span.
6. **Worker resilience.** A job that keeps failing is retried with exponential backoff, then kept in a visible failed set. A duplicate delivery runs once. SIGTERM lets the in-flight job finish.
7. **Monitoring can't break the app.** With Jaeger stopped, requests still succeed; telemetry is dropped silently (rate-limited warning at most).

Agreed additions:

8. **Startup safety check.** API and worker refuse to start on missing or invalid configuration and name the variable, never its value.
9. **Request limits.** JSON body size cap and server timeouts.
10. **Basic counts.** Request count/error/duration, jobs waiting, jobs failed, jobs processed. Recorded with OpenTelemetry and readable locally.
11. **Support runbook.** "Given a reference ID, find the trace and logs."

## Non-goals

Browser/web tracing (joins in PR-007 when the site first calls the API). Hosted telemetry or error tracking (Sentry etc., blocked on D-08 budget). Rate limiting (PR-007). Load testing (PR-010). Database schema, migrations, ORM (ADR-0002/PR-005). Transactional outbox (PR-005). Auth. Any money, quote, fee or provider code.

## Anti-goals (a failure even if it "works")

- Payer messages, card-like numbers, auth headers, cookies, query strings or request bodies in logs or traces.
- Telemetry or the diagnostic endpoint able to take the API down, or reachable in production.
- Treating the Redis queue as durable financial storage. Financial work will require the DB outbox (architecture doc, "Source of truth").
- A second validation system living alongside the first.

## Constraints

Root and scoped AGENTS (API: validate all inputs, no internals in public DTOs; worker: idempotent, at-least-once safe, bounded retries, dead-letter quarantine, correlation IDs, isolated handler tests with timeout/cancellation). Strict TypeScript, no `any`. Shared shapes live in `packages/contracts` (framework-free). Exact dependency pins (`save-exact`), recorded in an ADR. Loopback-only bindings. Node 24.22.0, Nest 12.1.3, ESM. Native `node --test` runner (existing convention). Existing `/health` contract and its test keep passing.

## Decided with the user

- OpenTelemetry for instrumentation; **Jaeger in local Docker Compose** as the viewer (UI `127.0.0.1:16686`, OTLP/HTTP `127.0.0.1:4318`). Hosted backend later via configuration only. _(User handed this choice to the agent; recorded as agent's call, accepted.)_
- Structured JSON logs stamped with trace ID; sensitive data scrubbed.
- The 11 checks above, and the deferrals above.

## Builder's design (agent's calls, open to review)

### Shared package `packages/observability` (new, private)

Used by API and worker; no framework imports.

- `startTelemetry({ serviceName, otlpEndpoint?, metricsPort?, sampleRatio })` using `@opentelemetry/sdk-node` with explicit instrumentations only: `http`, `express`, `nestjs-core`, `pg`, `ioredis`. No auto-instrumentation bundle. Must load before other imports: ESM needs a preload entry (`node --import ./dist/telemetry.js`) that also registers OpenTelemetry's ESM loader hook, so `pg`, `ioredis` and `express` are patched. _(Builder check, agent's call.)_
- Span hygiene: http instrumentation strips query strings from URL attributes and captures no headers. `ioredis` serializer records only the command name. `pg` keeps default parameterized statements (no values; `enhancedDatabaseReporting` off).
- Export: OTLP/HTTP batch exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise tracing is in-process only. Exporter errors never propagate to request handling.
- Metrics: Prometheus exporter on a **separate loopback port** per service (`API_METRICS_PORT` 9464, `WORKER_METRICS_PORT` 9465; separate names because the root `.env` is shared). Readable locally with `curl` and no extra container.
- `createLogger(service)` with `pino`: a mixin adds `trace_id`/`span_id` from the active span. An **allowlist** of fields for HTTP logs (method, route template, status, duration, reference) plus `redact` for defence in depth (`*.authorization`, `*.cookie`, `*.password`, `*.message`, `*.card*`). Request and response bodies, headers and query strings are never logged.

### Contracts (`packages/contracts`)

Adds `zod` (framework-free). Exports schemas and types: `HealthResponse` (unchanged), `ReadinessResponse` (`{ status: 'ready'|'unavailable', checks: { postgres: 'up'|'down', redis: 'up'|'down' } }`), `ApiErrorResponse` (`{ error: { code, message, reference } }`), `TraceProbeRequest`/`Response`, and job names plus payload schemas (`diagnostics.trace-probe`). The worker validates every job payload, because Redis data is untrusted input.

### API (`apps/api`)

- **Validation:** zod schemas from contracts through a small Nest pipe. Remove the unused global class-validator `ValidationPipe` and the `class-validator`/`class-transformer` dependencies, so there is one validation system. _(Changes an ADR-0001 note; recorded in ADR-0005.)_
- **Errors:** a global exception filter maps validation errors to 400 `VALIDATION_FAILED` with field paths only (no echoed values), 404/405 to their codes, and anything else to 500 `INTERNAL_ERROR`. Every response carries `reference` = trace ID and an `X-Request-Id` header with the same value.
- **Correlation:** incoming W3C `traceparent` is honoured (so the website can join later); otherwise a new trace starts. `traceresponse` is not emitted.
- **Health:** `GET /health` stays liveness (existing test unchanged); `GET /health/live` is an alias. `GET /health/ready` runs Postgres `SELECT 1` (via `pg` Pool) and Redis `PING`, each with a 1 s timeout, returning 200 or 503 with per-dependency up/down and no error text. `Cache-Control: no-store`.
- **Limits:** JSON body 16 KB; `requestTimeout` 10 s, `headersTimeout` 15 s, `keepAliveTimeout` 5 s; payloads over the limit get 413 in the standard error body.
- **Diagnostics:** `POST /v1/diagnostics/trace-probe`, body `{ mode: 'succeed'|'fail-once'|'fail-always', note?: string(≤120) }`. It enqueues one `diagnostics.trace-probe` job with the trace context and returns `202 { reference, jobId }`. `GET /v1/diagnostics/trace-probe/:jobId` returns `{ state: 'waiting'|'active'|'completed'|'failed', attemptsMade }` so the demo script can wait without its own Redis client. _(Builder check, agent's call.)_ Registered **only** when `DIAGNOSTICS_ENABLED=true`; startup refuses `DIAGNOSTICS_ENABLED=true` with `NODE_ENV=production`. `note` exists so the leak test has a realistic free-text field; it is never logged or put on spans.
- **Config (zod, fail fast):** `HOST` (loopback enum, existing), `PORT`, `DATABASE_URL`, `REDIS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT?`, `OTEL_TRACES_SAMPLER_RATIO` (default 1 locally), `API_METRICS_PORT`, `LOG_LEVEL`, `DIAGNOSTICS_ENABLED`, `NODE_ENV`. Errors list variable names only.

### Worker (`apps/worker`)

- **Queue: BullMQ on Redis** (queue `tipme-jobs`). The API enqueues with `jobId` = idempotency key and puts the propagated trace context in a `_trace` carrier. The worker extracts it, so the job span is a child of the API trace.
- **Retries:** `attempts: 3`, exponential backoff (base 1 s). After exhaustion the job stays in BullMQ's failed set (`removeOnFail: { count: 1000 }`), which is the visible quarantine; `tipme.jobs.failed` counts it. A full DLQ with replay tooling comes with real job types.
- **Idempotency:** BullMQ `jobId` dedupes while the job exists. The handler also takes a Redis `SET NX` processed-marker (24 h TTL) so a redelivered or duplicate job is a logged no-op. Financial idempotency will be DB-backed (PR-005).
- **Lifecycle:** existing `worker.started`/`worker.stopped` events kept (existing test passes). SIGTERM/SIGINT call `worker.close()` so the in-flight job finishes (bounded at 10 s), then telemetry flushes. Each handler has a 5 s timeout via `AbortSignal`.
- **Metrics:** `tipme.jobs.processed` (counter, by outcome); `tipme.jobs.waiting` and `tipme.jobs.failed` (observable gauges from `getJobCounts`).
- **Config:** zod check like the API (`REDIS_URL`, OTEL vars, `WORKER_METRICS_PORT`, `LOG_LEVEL`). Service names are fixed in code (`tipme-api`, `tipme-worker`) because the root `.env` is shared.

### Local infrastructure

`docker-compose.yml` adds `jaeger` (`jaegertracing/jaeger` v2 all-in-one image, exact tag chosen at implementation, in-memory storage, loopback ports 16686 and 4318, healthcheck). `.env.example` gains the new variables with local-safe values. API and worker `dev`/`start` scripts use Node's `--env-file-if-exists=../../.env`, so a copied root `.env` is loaded without a dotenv dependency; real secrets never go in `.env.example`. Tests bind ports `0` and pass config explicitly, so parallel Turbo runs don't collide. _(Builder check, agent's call.)_

### Demo and runbook

- `scripts/trace-demo.mjs` (`pnpm trace:demo [--mode fail-once]`): POSTs the probe, waits for the job to complete or fail, and prints the Jaeger URL `http://127.0.0.1:16686/trace/<reference>` plus a `grep` hint for logs.
- `docs/runbooks/find-a-trace.md`: from a reference ID to the trace, logs, and the failed-job entry.

### Tests

- **Unit** (`node --test`, no infra): config validation messages (no values), redaction/allowlist, error filter mapping, contracts schemas, job handler idempotency/timeout with fakes.
- **Integration** (`pnpm test:integration`, requires `pnpm infra:up`): in-process API and worker with an in-memory span exporter and captured log stream against real Postgres/Redis. Covers checks 1, 2, 4, 5, 6, 9, 10, plus readiness with an unreachable port (check 3) and a dead OTLP endpoint (check 7).
- **CI:** add `docker compose up -d --wait postgres redis` and `pnpm test:integration` steps.
- **Manual evidence** in `docs/PR-004-VERIFICATION.md`: Jaeger screenshot of the demo trace, stop/start of Postgres and Redis against readiness, log grep.

### ADR

`docs/adr/ADR-0005-observability-logging-and-jobs.md` records OpenTelemetry + Jaeger (local), pino, Prometheus-format metrics, BullMQ, zod-only validation, exact versions, and what stays deferred. ADR numbers 0002 to 0004 stay reserved for ORM, auth and provider.

## Left to the builder

Exact dependency versions (verify Nest 12 and Node 24 compatibility with `npm view` and installed docs), file layout inside each app, metric bucket boundaries, log field naming beyond the allowlist, and the exact Jaeger image tag.

## Risks

Auto-instrumentation compatibility with Nest 12/ESM (mitigation: `--import` loader, verify spans in tests). BullMQ adds a sizeable dependency (mitigation: recorded in ADR; worker-only plus a thin API producer). Trace IDs as support references are long (32 hex characters), acceptable internally; a short human code can come with receipts in PR-007.
