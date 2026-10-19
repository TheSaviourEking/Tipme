# TipMe — coding-agent launch kit

**Status:** planning and scaffolding instructions, not an implemented fintech system. **Date:** 18 October 2026.

TipMe is an appreciation-first product: people receive voluntary tips through personal profiles, links and QR codes; payers can tip without registering. The design uses `#7A32F9`, `#FFFFFF`, `#000000`. Real-money payments are **blocked** until legal/entity, processor, region, and settlement decisions are approved. The first working vertical slice uses a **mock provider**.

## Bootstrap implementation

PR-001/002 tooling and minimal development shells are now present. Start with [the executable bootstrap setup](docs/BOOTSTRAP-SETUP.md), [selected versions](docs/adr/ADR-0001-monorepo-and-tooling.md), and [verification evidence](docs/BOOTSTRAP-VERIFICATION.md). The original kit instructions below remain for context. No payment or database domain is implemented.

## Reading order (coding model)

1. `AGENTS.md` — root obligations, decision taxonomy, safety and workflow.
2. `docs/00-DECISIONS.md` — confirmed, proposed, unknown.
3. `docs/01-LOCAL-SETUP.md` — computer prerequisites, commands and setup order.
4. `docs/02-ARCHITECTURE.md` and `docs/03-DOMAIN-AND-PAYMENTS.md` — hard boundaries.
5. `docs/04-DESIGN-AND-FRONTEND.md`, `docs/05-SECURITY.md`, `docs/06-QUALITY-GATES.md`.
6. `docs/07-OBSERVABILITY-AND-SEO.md`, `docs/08-DELIVERY-PLAN.md`.
7. `prompts/00-BOOTSTRAP-AGENT.md` — paste into coding model to start.

## Deliverables

This kit includes governance (`AGENTS.md`, scoped AGENTS.md, editor rules), architecture and implementation guides, ADR template, issue templates, CI examples, Docker Compose for local dependencies, `.env.example`, a minimal bootstrap script, and task-by-task prompts.

## Starting now

1. Create a new private repository `tipme` locally.
2. Put these kit files at its root (do not put kit folder inside repo); copy PRD into `docs/reference/` if available.
3. Have the coding agent read `prompts/00-BOOTSTRAP-AGENT.md` and make the first scaffold-only PR.
4. Complete financial blockers in `docs/00-DECISIONS.md` before connecting any live provider.

**Do not interpret this kit as proof that repositories, apps, accounts, credentials or payment integrations already exist.**
