# ADR-0002 — Database access, migrations and IDs

Date: 2026-10-18
Status: ACCEPTED for development (PR-005). No production database exists.
Owners: Engineering

## Context

PR-005 introduces the first persistent money records. The design (`docs/superpowers/specs/2026-10-18-pr005-money-records-design.md`) depends on database-enforced rules: CHECK constraints, partial unique indexes, `NULLS NOT DISTINCT`, append-only triggers, commit-time (deferred) balance checks and row locks. AGENTS.md requires strict TypeScript without `any` and forbids migrations against remote databases.

## Options considered

- **Prisma:** mature, but its schema cannot express several of these constraints, so they would live in hand-written SQL outside its model; heavier runtime.
- **Knex** (offered by the user): sound query builder and migrations, but query results are loosely typed unless every table has a hand-maintained interface.
- **Drizzle:** schema in TypeScript with inferred types; plain SQL migration files; supports checks, partial and `NULLS NOT DISTINCT` unique constraints, row locks (`FOR UPDATE`, `SKIP LOCKED`) and custom SQL migrations.

## Decision

- **Drizzle ORM 0.45.3** on the existing `pg` 8.23.1 driver; **drizzle-kit 0.31.11** generates migrations (`pnpm --filter @tipme/database generate`). The user agreed to Drizzle after comparing it with Knex.
- Migrations are reviewed SQL in `packages/database/drizzle/` and are never edited once applied: `0000_initial.sql` (generated), `0001_invariants.sql` (hand-written triggers: append-only history, entry currency matching, balanced transactions checked at commit), `0002_payout_fingerprint.sql` (generated), `0003_closed_ledger_transactions.sql` (entries may only be written in the database transaction that created their ledger transaction), `0004_single_use_quotes.sql` (generated), `0005_history_and_status_guards.sql` (no TRUNCATE on history tables, immutable ledger accounts, entry profile must match its account, status transitions enforced in SQL and parity-tested against the domain tables).
- Operations wrap unexpected database errors in `PersistenceError` (SQLSTATE only), because driver and ORM errors embed query parameters.
- The local-only guard checks the host `pg` will actually use (via `pg-connection-string` 2.14.1), so `?host=`, `?hostaddr=` and socket paths cannot slip past it.
- **IDs:** UUIDv7 from `uuid` 14.0.2, generated in the application (time-ordered; no Postgres extension).
- **Money:** `bigint` minor units (`mode: 'bigint'` in Drizzle) plus `char(3)` ISO currency with a CHECK.
- **Local-only scripts:** `pnpm db:migrate` and `pnpm db:seed` refuse any `DATABASE_URL` host other than localhost, 127.0.0.1 or ::1, before connecting, naming the host only. Tests use a separate `tipme_test` database created by `@tipme/database/test-support`.
- `@tipme/domain` exports also carry a `default` condition, because drizzle-kit loads the schema with CommonJS `require` (Node 24 can require ES modules).

## Rationale

Inferred types keep a column typo or a string-for-bigint mistake from compiling. SQL-first migrations keep the safety rules reviewable, in one place, next to the tables they protect.

## Financial, security, privacy and accessibility impacts

The database refuses edits and deletions on ledger and history rows, rejects unbalanced or single-entry transactions at commit, rejects mismatched currencies, unverified provider events and duplicate business keys. Tip messages live in their own table for later access and retention controls (encryption at rest deferred to privacy work).

## Rollout and rollback

Development only. The migrations create everything from an empty schema; rollback before any shared environment exists is a fresh database. Production migration policy (expand/contract, backups, approvals) is required before staging.

## Consequences

pnpm skips esbuild's install script by default; drizzle-kit works with the platform binary package. Production deployment of migrations needs its own runbook.

## Validation evidence

`docs/PR-005-VERIFICATION.md`.

## Linked PRD requirements

PRD 6.3 state machines, 7 data model and critical indexes, financial invariants in AGENTS.md.
