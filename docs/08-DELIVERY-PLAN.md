# Work plan and PR sequence

## Sprint 0: foundation (no live money)
**PR-001 Governance:** kit files, PRD copy, decisions, readme, editor/agent rule wiring, branch protection checklist.
**PR-002 Toolchain:** pinned Node + pnpm, Turbo, workspaces, lint/format/strict-ts, CI install + test/build on clean clone.
**PR-003 Web shell:** Next.js, tokens, layout, legal placeholders clearly labeled, accessible nav, responsive profile route and metadata.
**PR-004 API/worker:** NestJS API health, validation, logging/correlation, worker process, Postgres/Redis local Compose, test harness.
**PR-005 Contracts/DB:** ORM ADR, initial schema and migrations for users/profiles/quotes/tips/intents/attempts, transaction and outbox invariants.
**PR-006 Mock provider:** provider interface and signed mock webhook, unknown/duplicate/reordered test fixtures.
**PR-007 Checkout slice:** responsive profile, quotes, amount selection, accessible guest checkout, status and receipt.
**PR-008 Dashboard slice:** recipient authentication (approved strategy), tip history/earnings, QR sharing, notifications mock.
**PR-009 Analytics/ops:** safe events, traces/logs, ops view for exception handling with privileged access.
**PR-010 Release rehearsal:** e2e, performance, a11y, backup/restore, deploy staging, rollback and runbooks.

Parallel tracks after PR-002: Experience (PR-003,007, UX research) and Platform (PR-004,005,006). Do not wire real money until compliance and provider blockers resolved.

## User acceptance paths
1. Visitor on 360px phone opens share link from messaging app in usable time, recognizes recipient.
2. Visitor freely enters/customizes amount and optional message with full fee total.
3. Guest can submit once, revisit receipt, see pending, recover error and view verified completion.
4. Duplicate clicks/webhooks lead to exactly one tip/finance posting.
5. Recipient signs in, sees accurate records, private messages and QR sharing.
6. Disallowed/private/disabled profiles do not appear in search or sitemap; handles redirect correctly.
7. Ops staff can investigate trace+provider reference without needing raw sensitive data.

## Milestone documents
- `ADR-0001-monorepo-and-tooling.md`
- `ADR-0002-database-orm.md`
- `ADR-0003-auth-and-sessions.md`
- `ADR-0004-financial-provider-and-settlement.md` (BLOCKED until approvals)
- OpenAPI, ERD, UX screen state matrix and infrastructure runbooks.

## Weekly ritual
Agent opens tasks with acceptance criteria and closeout evidence; founder reviews design screenshots, finance policy changes and UX experiments; changes recorded in ADRs. Never substitute component quantity for coherent user journeys.
