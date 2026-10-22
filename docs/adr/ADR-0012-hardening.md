# ADR-0012 — Hardening: point-in-time recovery, alerts, error reports, moderation, search, renames, speed and the API document

Date: 2026-10-21
Status: ACCEPTED for staging (PR-011). Nothing here approves real money, real messaging or a paid monitoring service: D-03 to D-08, D-10 and D-11 stay open.
Owners: Engineering

## Context

The audit after PR-010 listed the gaps between the PRD and the code. The user asked for items 1 to 5: disaster recovery to RPO ≤ 15 minutes with alerts and error tracking (PRD §13–14); message reporting, sitemap/robots and handle-rename redirects (FR-010, FR-015); security scanning, load tests and real-user web vitals (PRD §10.1, §12); and an OpenAPI document (PRD §8). The VPS is not provisioned yet, so everything is proven on the local staging stack.

## Decisions

1. **Point-in-time recovery.** Postgres archives WAL to its own volume (`archive_timeout=300`, so RPO ≈ 5 minutes) and a daily encrypted `pg_basebackup` sits next to the logical dumps. `pitr-drill.sh` proves recovery in a throwaway container: a marker row written after the base backup must come back and the ledger must balance. Every backup run is recorded in `backup_runs`; `GET /health/backups` exposes ages and counts only.
2. **Alerts without a paid service.** A scheduled GitHub workflow (`staging-watch`, every 15 minutes) runs pure, tested thresholds. A failure emails the repository owner; an optional webhook posts to chat. Chosen over a hosted uptime service because the budget (D-08) is open.
3. **Error tracking by TipMe's own sender.** Server errors go out in Sentry's envelope format (Sentry or self-hosted GlitchTip) with only the error type, a safe code (SQLSTATE or TipMe's own code), stack frames, the route pattern or job name and the trace id. Messages, bodies, cookies, headers and user data never leave. No SDK, so nothing else can be captured by default. Off without `SENTRY_DSN`; at most 30 reports a minute.
4. **Message moderation by the recipient.** A recipient can hide a paid tip's message or report it (abusive, spam, other). A report hides it and opens a `message_reported` issue (severity account); staff read the text only through the audited, reason-gated reveal.
5. **Search engines.** `robots.txt` and `sitemap.xml` come from pure functions. Private areas are always disallowed; indexing stays off everywhere until `SITE_INDEXING=on` on a copy without the preview password. Public profiles remain noindex until D-06.
6. **Handle renames.** Old handles become `handle_aliases` rows of the page (at most 5), count as taken for everyone else, and answer `308` with the new handle from the API; the web app redirects `308` to `/@new`, keeping only `?src=qr`. Old handles of pages that are not live reveal nothing (404). On deletion they become ordinary 90-day holds. Handles stay stored lower-case, so a case-only change is no change.
7. **Security scanning in CI.** `pnpm audit --prod --audit-level=high` and gitleaks over the whole history, image pinned by digest, findings redacted, false positives allowed by exact match only.
8. **Load tests.** k6 (pinned) against a throwaway in-process API on a scratch database, with the PRD's p95 budgets and 5xx < 0.1% as thresholds. Never against a shared copy, because checkout initialisation writes rows.
9. **Real-user web vitals.** `POST /v1/vitals` accepts only a metric (LCP, INP, CLS, FCP, TTFB), a bounded number and a page kind; stored with the device class in `web_vitals`, under the analytics rules (off in production until D-07, GPC/DNT honoured, 90 days). The Overview shows mobile p75 over 28 days against LCP ≤ 2.0 s, INP ≤ 150 ms, CLS ≤ 0.05.
10. **OpenAPI 3.1 generated, not written.** `pnpm api:openapi` builds `docs/api/openapi.json` from the routes Nest registers and the zod schemas their validation pipes hold. A test compares it with Express's route table (every route documented, nothing extra); CI fails when the file is stale. Response bodies are described generically until response types become zod schemas.

## Consequences

- RPO is about 5 minutes on staging; RTO depends on the manual point-in-time steps in the runbook.
- Alerts depend on GitHub's scheduler (it can be minutes late). A hosted monitor can replace it once D-08 is decided.
- Errors are reported without their messages, so diagnosis relies on the trace id and logs.
- The load-test numbers are an upper bound measured on loopback, not production capacity.

## Related

ADR-0005 (observability), ADR-0010 (admin, audit, analytics), ADR-0011 (staging and release). Runbooks: backup-and-restore, staging-setup, issues-inbox.
