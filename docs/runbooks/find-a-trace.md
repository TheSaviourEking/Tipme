# Runbook: find a request from its reference ID

**When:** someone reports a problem and quotes a reference, or you have one from an error response. Every API response carries it in the `X-Request-Id` header, and every error body has it as `error.reference`. It is a 32-character hex string, for example `3f14523d1149aad7e4357f94b0ce4e8b`.

The reference **is** the trace ID, so the same value finds the trace, the logs and any worker jobs.

## 1. Open the trace

Local: `http://127.0.0.1:16686/trace/<reference>`, or paste the reference into Jaeger's **Lookup by Trace ID** box.

Read it top-down:

- `tipme-api POST /…`: the request, with its status code.
- `middleware - jsonParser`, `request handler - …`: API work.
- `evalsha` / `set` (redis): enqueueing and idempotency markers.
- `tipme-worker job …`: each worker attempt. A red **!** means that attempt failed; its status message is the reason (`probe_failure`, `timeout`, `invalid_payload`, `unknown_job`).

No trace? Check that the collector was running (`docker compose ps jaeger`) and that `OTEL_EXPORTER_OTLP_ENDPOINT` was set. The local Jaeger keeps traces in memory, so they vanish when it restarts. Sampling below 1 (`OTEL_TRACES_SAMPLER_RATIO`) also drops some traces; the logs still have the reference.

## 2. Find the logs

API and worker log one JSON object per line. Lines written while handling the request carry `trace_id` equal to the reference; API request lines also carry `reference`.

```sh
grep <reference> api.log worker.log
```

Expect one `http.request` line from `tipme-api` (method, route template, status, duration) and `job.completed`, `job.duplicate` or `job.failed` lines from `tipme-worker` (attempt number, reason).

Logs never contain request bodies, headers, query strings, messages or job payloads. If you need more than the logs show, use the trace; do not add payload logging.

## 3. Check a job directly (development)

For a diagnostic probe: `curl http://127.0.0.1:4000/v1/diagnostics/trace-probe/<jobId>` returns `{ "data": { state, attemptsMade } }`. Failed jobs are kept (up to 1000) in BullMQ's failed set; `tipme_jobs_failed` on the worker metrics port (`curl http://127.0.0.1:9465/metrics`) counts them.

## 4. Check health

`curl http://127.0.0.1:4000/health/ready` reports `postgres` and `redis` as `up` or `down`. `/health` only says the process is alive.

## Limits

This is development tooling. Production trace storage, retention, access control and alerting are not decided yet (D-08). Diagnostic endpoints cannot be enabled in production.
