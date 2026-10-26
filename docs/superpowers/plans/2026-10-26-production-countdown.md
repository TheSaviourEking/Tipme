# Production countdown — implementation plan

> Execute inline with `superpowers:executing-plans` and strict TDD. Do not deploy or change Vercel settings from this branch.

**Goal:** hold the production web experience behind a branded countdown until 27 October 2026 at 00:00 WAT, then release automatically.

**Spec:** `docs/superpowers/specs/2026-10-26-production-countdown-design.md`

## Task 1: Strict launch configuration and routing decision

**Files:** add `apps/web/src/lib/production-launch.ts`, add `apps/web/test/production-launch.test.mjs`, modify `apps/web/next.config.ts`, `apps/web/src/proxy.ts`, `apps/web/test/short-links.test.mjs`, and `turbo.json`.

1. Write failing pure tests for strict zoned timestamp parsing, unset/future/exact/past decisions, exemptions, inactive direct-route redirect, hostile paths, and legacy `/people` redirect ordering.
2. Run `pnpm --filter @tipme/web test` and observe the expected missing-module/behavior failure.
3. Implement the parser and decision. Validate it from Next config. Put countdown routing first in Proxy, move the legacy redirect from Next config after it, and add no-store headers to rewrites.
4. Add `PRODUCTION_LAUNCH_AT` to Turbo build env.
5. Run web tests green; run web lint/typecheck.
6. Commit: `feat: gate production until launch`.

## Task 2: Accessible countdown model and client instrument

**Files:** add `apps/web/src/lib/countdown.ts`, `apps/web/test/countdown.test.mjs`, `apps/web/src/app/coming-soon/countdown.tsx`, and `apps/web/src/app/coming-soon/page.tsx`.

1. Write failing unit tests for fixed-instant decomposition, zero clamp, combined announcement, minute bucket, and the WAT target label/UTC mapping.
2. Run the focused test and observe RED.
3. Implement pure countdown math and the client island: stable placeholders until mount, visual digits aria-hidden, combined polite announcement at most once/minute, semantic time, reduced-motion-safe markup, and launch navigation.
4. Implement the server page using the strict shared config, `connection()`/no-store behavior, exact metadata, and the TipMe wordmark.
5. Run focused and full web tests green.
6. Commit: `feat: add TipMe launch countdown`.

## Task 3: Visual composition, telemetry suppression and social image

**Files:** modify `apps/web/src/app/globals.css`, `apps/web/src/components/web-vitals-reporter.tsx`, add `apps/web/src/app/coming-soon/opengraph-image.tsx`, modify/add web unit tests and `tests/e2e/quality.spec.ts` or a focused countdown Playwright spec.

1. Write failing behavior tests for web-vitals suppression when `.coming-soon-page` exists and Playwright assertions for hidden chrome, exact copy/time, timer semantics, no overflow at 320px, axe, reduced motion, metadata/image, no-store headers, original URL preservation, route/API exemptions, and inactive behavior.
2. Observe RED.
3. Add the physical/editorial countdown CSS, global-chrome suppression via `display:none`, telemetry guard, and code-native OG image.
4. Run unit and focused Playwright tests green. Inspect screenshots before accepting any baseline; avoid baseline changes unless necessary.
5. Commit: `feat: style the production countdown`.

## Task 4: Deployment documentation and verification

**Files:** modify `apps/web/DEPLOYMENT.md`, `docs/design/DECISION-LOG.md`, `docs/agent/ACTIVE_TASK.md`, and `docs/agent/HANDOFF.md`.

1. Document production authority (`www`, apex verification), exact `PRODUCTION_LAUNCH_AT=2026-10-26T23:00:00Z`, preflight, midnight verification, and cleanup.
2. Record the design ruling and actual validation evidence.
3. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, focused Playwright, and `git diff --check`.
4. Use `superpowers:requesting-code-review` for a fresh whole-branch review. Fix Critical/Important findings test-first, then use `superpowers:verification-before-completion`.
5. Commit: `docs: add production countdown release steps`.
