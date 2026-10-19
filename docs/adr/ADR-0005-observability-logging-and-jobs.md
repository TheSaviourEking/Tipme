# ADR-0005 — Observability, logging, validation and background jobs

Date: 2026-10-18
Status: ACCEPTED for development (PR-004). No production telemetry backend, budget or retention is implied (D-08 open).
Owners: Engineering

## Context

The user wants to follow a tip's whole journey in one place when something goes wrong. Payment flows arrive in PR-005 to PR-007, so PR-004 builds the plumbing first: request correlation, traces that continue into background jobs, structured logs, health, metrics and a job queue. AGENTS.md forbids logging sensitive data and requires correlation IDs, bounded retries and idempotent, at-least-once-safe workers. Design: `docs/superpowers/specs/2026-10-18-pr004-observability-design.md`.

## Options considered

- **Tracing:** OpenTelemetry (vendor-neutral) vs a vendor SDK. **Viewer:** local Jaeger vs a hosted service (Sentry, Grafana Cloud, Honeycomb; blocked on budget D-08).
- **Logging:** pino vs Nest's logger vs winston.
- **Validation:** keep class-validator (in the starter) vs zod (already used for startup config; framework-free, so it can live in `packages/contracts`).
- **Queue:** BullMQ on Redis vs a Postgres-backed queue. The Postgres option is reconsidered with the outbox in PR-005.

## Decision

- **OpenTelemetry**, configured in a new private package `packages/observability`, with explicit instrumentations only (http, express, nestjs-core, pg, ioredis). Spans export over OTLP/HTTP to **Jaeger 2.21.0 in Docker Compose** (loopback ports 16686 and 4318, in-memory). A hosted backend later is a configuration change.
- **Trace ID = support reference**, returned as `X-Request-Id` and `error.reference`. An incoming W3C `traceparent` is continued; malformed ones are ignored.
- **pino** JSON logs with `trace_id`/`span_id`, allowlisted HTTP log fields and redaction as defence in depth.
- **Prometheus-format metrics** on loopback ports (API 9464, worker 9465), so no extra container is needed.
- **Response convention (PRD §8):** versioned `/v1` routes answer `{ data, meta? }` on success and `{ error }` on failure (`ApiDataResponse<T>` / `ApiErrorResponse` in contracts). Health probes (`/health`, `/health/live`, `/health/ready`) stay unwrapped: they are machine checks with fixed contracts. Adopted 18 Oct 2026 on the user's instruction to follow the PRD.
- **zod only** for validation; `class-validator` and `class-transformer` removed. Shared schemas live in `packages/contracts`.
- **BullMQ 6** on Redis (ioredis 5). The trace context travels inside the job payload (`_trace`). 3 attempts with exponential backoff (1 s base); failed jobs are retained (up to 1000) as the visible quarantine; a delivery whose key already completed (Redis marker) is skipped without doing the work, and the marker is set (`SET NX`) only after success so retries are not mistaken for duplicates. Two _concurrent_ deliveries can both run before either marks; transactional database idempotency comes in PR-005. Each job is bounded by a 5 s timeout that also covers hung Redis calls, and shutdown abandons a graceful close that takes longer than 10 s.

| Package                                                                                                       | Version                                             |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| @opentelemetry/api                                                                                            | 1.9.1                                               |
| @opentelemetry/sdk-node, exporter-trace-otlp-http, exporter-prometheus, instrumentation, instrumentation-http | 0.222.0                                             |
| @opentelemetry/instrumentation-express / -nestjs-core / -pg / -ioredis                                        | 0.70.0 / 0.68.0 / 0.74.0 / 0.70.0                   |
| @opentelemetry/sdk-trace-base, sdk-metrics, resources                                                         | 2.11.0                                              |
| @opentelemetry/semantic-conventions                                                                           | 1.43.0                                              |
| @opentelemetry/context-async-hooks (test only)                                                                | 2.11.0                                              |
| pino                                                                                                          | 10.4.0                                              |
| bullmq                                                                                                        | 6.3.11                                              |
| ioredis                                                                                                       | 5.11.1 (BullMQ 6 is tested against 5.x; 6.0 is new) |
| pg / @types/pg                                                                                                | 8.23.1 / 8.23.1                                     |
| @types/express (types only)                                                                                   | 5.0.6                                               |
| zod                                                                                                           | 4.6.7 (unchanged)                                   |
| jaegertracing/jaeger image                                                                                    | 2.21.0                                              |

Every pin was published at least two weeks before adoption. pnpm 10 skipped `protobufjs`'s install script (its default for dependency build scripts); the OTLP/HTTP JSON exporter does not need it.

## Rationale

Open standards keep the trace backend swappable while budget is undecided. Putting the trace ID in responses gives support one string to ask for. Allowlisting log fields is safer than trying to scrub everything. One validation library avoids two sources of truth. BullMQ is mature and already sits on the Redis we run.

## Financial, security, privacy and accessibility impacts

- No money paths. Redis is **not** durable financial storage: payment work will use a Postgres outbox (PR-005) with DB-backed idempotency.
- Never logged or traced: bodies, headers, query strings (stripped from span URLs), exception messages, stack traces and status text (parsers quote input), free-text messages, job payloads, config values. Redis spans record the command name only; Postgres spans record parameterized statements only. Host and process resource detectors are off (they record usernames and command lines). Tests assert that sentinel secrets never reach logs or spans.
- Error responses use fixed messages (parser messages can quote input) and list field paths, never values.
- The diagnostics endpoint exists only when `DIAGNOSTICS_ENABLED=true`, and the API refuses to start with that setting in production. An unset `NODE_ENV` counts as production.
- JSON body limit 16 KB; request and header timeouts of 10 s.

## Rollout and rollback

Development only. Leaving `OTEL_EXPORTER_OTLP_ENDPOINT` empty disables trace export; the app runs unchanged. To roll back, remove the observability package wiring; no data migrations are involved.

## Consequences

- Nest instrumentation 0.68 produced no Nest-level spans with Nest 12's ESM build in local runs; Express and HTTP spans cover the request. Revisit when the instrumentation adds support.
- Telemetry starts through a `node --import` preload (`dist/instrument.js`) that also registers the ESM loader hook.
- A per-environment `QUEUE_PREFIX` namespaces queues and idempotency keys.
- Browser tracing joins in PR-007; hosted telemetry, alerting, retention and access control wait for D-08.

## Validation evidence

`docs/PR-004-VERIFICATION.md`.

## Linked PRD requirements

Observability and operations: correlation IDs across request, job and provider events; structured logs without sensitive data; health and metrics for queue depth and failures.
