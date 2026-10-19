# Free private demo implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved deployment slice task by task.

**Goal:** A private, free hosted TipMe demo with pretend payments only.

**Architecture:** One Render web service runs a password gateway, loopback Next.js and API, and a worker. Neon stores demo data; Render Key Value stores disposable queues. An explicit preview mode permits mock adapters in an optimized runtime while ordinary production remains fail-closed.

**Tech Stack:** Existing pinned Node/pnpm/TypeScript stack; Node HTTP gateway; Docker; Render/Neon free tiers.

**Spec:** User-approved chat scope: shared password, invited testers, pretend payments, sleeping host and delayed background jobs, free resources only. Both provider accounts exist.

## Global constraints

- No real payments, paid resources, production data or changes to deployed migrations.
- Preview authentication covers pages, assets and API; only a minimal health response is public.
- No secrets in source, logs or browser bundles. Demo testers share access to pretend inboxes; use synthetic identities only.
- Existing local-only maintenance commands remain guarded; hosted preview bootstrap requires explicit target confirmation.
- Preserve current work and use a feature branch in the existing checkout.

## Review focus

- Direct unauthenticated API access and path-normalization bypasses: gateway tests.
- Bearer receipt tokens coexist with preview authentication: cookie-based gateway tests.
- Failed child process and shutdown leave no apparent healthy demo: supervisor tests/smoke check.
- Wrong database target or live-payment settings: bootstrap/config negative tests.
- Cold starts and memory exhaustion: container smoke test at the free host memory limit.

## Tasks

- [ ] 1. Write failing tests for explicit preview configuration; implement API/worker guards without changing ordinary production rejection. Verify config tests.
- [ ] 2. Write failing gateway tests for authentication, expiry, routing, malicious paths, body limit and bearer forwarding. Implement the cookie gateway and bounded process supervisor. Verify targeted tests.
- [ ] 3. Add guarded preview bootstrap, container and Render manifest, same-origin browser configuration and Turbo cache inputs. Test guards, build and constrained runtime.
- [ ] 4. Run format, lint, typecheck, unit, integration, build and relevant browser tests; review the branch and record evidence. Connect provider accounts only through secure account access, deploy free services and verify hosted behavior when available.

## Progress

Plan recorded before implementation. Existing continuity changes retained. Executing inline within already authorized scope; no further product design approval needed.
