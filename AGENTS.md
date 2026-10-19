# AGENTS.md — TipMe root operating instructions

## Mission
Build TipMe: the most effortless, trustworthy and emotionally thoughtful way to appreciate someone financially. Protect user autonomy. A premium interface is necessary, but correctness, accessibility, latency, privacy, SEO and transparent payment outcomes are equally important.

## Authority order
1. Explicit user instructions for the current task.
2. The approved Master PRD and accepted architectural decision records (ADRs).
3. This AGENTS.md and nearest nested AGENTS.md for touched paths.
4. Tooling and framework official documentation, verified for installed versions.
5. Existing code conventions.

If conflict arises, **stop and document the conflict**. Never silently supersede a LOCKED product choice. A PRD is not permission to implement sensitive or regulated features without VALIDATE blockers cleared.

## Decision taxonomy
- **LOCKED**: appreciation-first product; guest tipping; recipient profile/QR/link; brand `#7A32F9/#FFFFFF/#000000`; mobile-first accessible premium experience; correctness and observability.
- **PROPOSED**: Next.js web, NestJS API, separate worker, TypeScript monorepo, PostgreSQL, Redis, pnpm, Turborepo, managed payment processor, OpenTelemetry, Sentry/PostHog.
- **VALIDATE**: launch market/currency, entities/identity rules, payment partner approval, legal custody and settlement, payout timing/fees, KYC, tax, retention, infrastructure budget.
- **DEFERRED**: wallets, custody, multi-currency, native apps, crypto rails, marketplace, subscriptions.

## First-turn behavior
Before making changes: inspect current repo, current branch, `docs/00-DECISIONS.md`, lockfile, package scripts, and the relevant scoped AGENTS. Report: current state, files affected, plan, risks, how to validate. If repo empty: treat as greenfield. Do not pretend tests or services ran.

## Scope, style and modification rules
- Prefer smallest coherent implementation; deliver narrow, reviewable PRs.
- Never modify unrelated files, secrets, migrations already deployed, or production settings without explicit reason.
- TypeScript `strict` throughout. No `any` without documented rationale. Zod or framework DTO validation on ingress; explicit output DTOs. No duplicated request/response shapes across apps: use `packages/contracts`.
- Explain non-obvious decisions with concise code comments or ADR; do not narrate obvious lines.
- Follow feature boundaries, not cross-layer imports. No API business logic in route components. No database access from web clients.
- Changes require unit/integration tests appropriate to risk; financial code demands idempotency and concurrency tests.
- Avoid gratuitous package additions. For third-party UI, check license, accessibility, bundle size, maintenance and reduced motion. Add to `docs/third-party-component-register.md`.
- Never claim feature complete without evidence. Reports include commands and pass/fail/skipped status.

## Financial invariants (HARD STOP if violated)
- No real payments until processor and funds flow are approved in ADR and environment gating.
- No client-supplied success, price truth, fee truth, ledger postings or payout truth.
- Monetary amounts: integer minor units plus ISO 4217 currency; decimal display only at edge. Never floating-point finance.
- Distinguish tips, intents, attempts, provider events, settlements, payouts, refunds, disputes and ledger postings.
- Webhooks: authenticate before processing, durable event storage, provider event dedupe, idempotent state machine, safely handle out-of-order deliveries.
- Do not treat redirects as payment proof. Unknown external outcome stays pending and is reconciled.
- Double-entry financial postings must balance by currency, be append-only, uniquely tied to business operation, and created transactionally.
- Never retry non-idempotent external money movements blindly.
- No card numbers/CVV, processor secrets, private tokens, raw sensitive messages or credentials in logs/analytics.

## Required quality expectations
- WCAG 2.2 AA intent, keyboard and screen reader usability, zoom and reduced-motion alternatives.
- Proposed field CWV p75: LCP <=2.0s; INP <=150ms; CLS <=0.05 (aspirational, validate via RUM).
- Public profile SSR or pre-rendered metadata; unique canonical, safe OG, appropriate indexing; no private pages indexed.
- API target p95s per docs; separate first-party latency from payment-provider delays.
- Every customer-critical operation emits correlation identifiers, structured logs, metrics, traces and safe finance status.

## Agent workflow per task
1. Re-state acceptance criteria + affected packages.
2. Identify blockers and assumptions; use ADR for significant changes.
3. Implement one vertical slice only.
4. Run formatting, lint, typechecks, relevant tests and build; record exactly what ran.
5. Audit privacy, security, a11y, performance, failure states and instrumentation.
6. Summarize file changes, migration implications, test evidence, trade-offs, unresolved items and next PR.

## Local terminal safety
Never run destructive filesystem commands, DB reset, migrations against remote databases, force push, `git clean -fdx`, or delete untracked files without explicit authorization. Never echo `.env` secret values. Never run actual payments for automated tests.

## Task completion template
- Scope delivered
- Acceptance criteria mapping
- Files changed
- Commands run + results
- Security/finance/accessibility/performance checks
- Blockers / assumptions
- Suggested next PR

## Agent Continuity Protocol

This project may be developed by multiple AI coding agents.

The repository, not agent conversation history, is the
authoritative source of engineering state.

Before modifying code:
1. Read project instructions and relevant architecture docs.
2. Read docs/agent/ACTIVE_TASK.md.
3. Read docs/agent/HANDOFF.md.
4. Inspect Git state and relevant source files.
5. Reconstruct unfinished work before proceeding.

During implementation:
1. Work within the approved task scope.
2. Record significant decisions.
3. Update ACTIVE_TASK.md at meaningful checkpoints.
4. Preserve unfinished work and existing conventions.
5. Run targeted validation after changes.

Before stopping:
1. Update ACTIVE_TASK.md.
2. Update HANDOFF.md with the actual verified state.
3. List modified files and outstanding issues.
4. Record the next exact implementation step.
5. Distinguish passed checks from untested areas.

Never reset, discard, or overwrite another agent's work
without explicit authorization.


## Architecture Reference and Continuity

The project maintains an implementation reference at:

docs/architecture/IMPLEMENTATION_BASELINE.md

All coding agents must read this document when:
- Starting work in the repository for the first time.
- Taking over from another coding agent.
- Introducing new modules or significant dependencies.
- Changing shared contracts or architectural boundaries.
- Planning a new implementation milestone.

The baseline contains both confirmed product decisions and
proposed technical decisions.

IMPORTANT:
- LOCKED requirements are product constraints.
- PROPOSED decisions are not automatically approved.
- Historical task statuses may be outdated.
- The current repository is authoritative for implementation state.
- The active PR defines the permitted scope.
- Accepted ADRs supersede older architecture proposals.
- Do not implement future milestones prematurely.

Before starting implementation:
1. Read AGENTS.md.
2. Read the Master PRD.
3. Read the Implementation Baseline.
4. Read relevant Architecture Decision Records.
5. Read docs/agent/ACTIVE_TASK.md.
6. Read docs/agent/HANDOFF.md.
7. Inspect Git state and existing code.
8. Reconcile documentation against actual implementation.

If documentation conflicts with the current code,
report the discrepancy rather than silently assuming
either is correct.

Never restart completed work or expand the active PR
without authorization.
