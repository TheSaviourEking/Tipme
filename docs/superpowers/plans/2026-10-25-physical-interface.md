# Physical Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a repository-owned high-fidelity TipMe design system and apply it to the public recipient profile, tipping flow, and verified receipt without changing payment behavior.

**Architecture:** Extend `packages/ui` with semantic material, geometry, typography, motion, and symbol layers, then compose those primitives in `apps/web`. Preserve the current server/client boundary and checkout state machine. Add deterministic Playwright visual baselines to existing accessibility and functional coverage.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, CSS custom properties, `next/font`, `@tipme/ui`, Playwright 1.64, Axe.

**Spec:** `docs/superpowers/specs/2026-10-25-physical-interface.md`

## Global Constraints

- Preserve `#7A32F9`, `#FFFFFF`, and `#000000`.
- Preserve server-authoritative quote, idempotency, redirect, receipt-token, and payment-state behavior.
- Add no UI, icon, motion, WebGL, or physics library.
- Keep WCAG 2.2 AA intent, 44px targets, 320px reflow, focus, and reduced-motion parity.
- Keep the profile server rendered and protect supporter data.
- Implement one flagship vertical slice; dashboard and operations adoption require later plans.
- Do not claim board parity until the source board is stored at `docs/design/reference/tipme-interface-directions.png` with provenance.

## Review Focus

- Long names and biographies must not overlap portrait, tags, or tip controls; Task 6 tests this.
- Large NGN values must retain stable tabular alignment; Task 7 tests this.
- Missing portraits, failed images, and font fallback must remain intentional; Tasks 4 and 6 test this.
- Non-success outcomes must never receive success material or animation; Task 8 tests this.
- Reduced motion, forced colors, keyboard use, and 320px layouts must preserve every action; Tasks 3, 5, 7, and 9 test this.

---

### Task 1: Establish design governance authority

**Files:**

- Create: `docs/design/{DESIGN-CONSTITUTION,REFERENCE-ANATOMY,TOKENS-AND-MATERIALS,TYPOGRAPHY,COMPONENT-STANDARDS,MOTION-AND-APPRECIATION,RESPONSIVE-COMPOSITION,ICONOGRAPHY,VISUAL-QUALITY-GATE,DECISION-LOG}.md`
- Create: `docs/design/reference/README.md`
- Add from the user-supplied original: `docs/design/reference/tipme-interface-directions.png`
- Modify: `AGENTS.md`, `apps/web/AGENTS.md`, `packages/ui/AGENTS.md`, `CLAUDE.md`, `scripts/check-governance.sh`
- Test: `scripts/governance.test.mjs`

**Interfaces:**

- Consumes: approved design spec.
- Produces: `docs/design/DESIGN-CONSTITUTION.md` as the mandatory visual authority.

- [ ] Write failing governance assertions for every design document, 60/30/10 hierarchy, locked colors, and agent references.
- [ ] Run `node --test scripts/governance.test.mjs`; verify failure because `docs/design` is absent.
- [ ] Add focused documents and cross-references without duplicating product or architecture decisions; record the board's provenance, dimensions, and art-direction role.
- [ ] If the original board file is unavailable to the worktree, pause only the asset-copy step, request the original attachment, and mark final parity review blocked while continuing written governance.
- [ ] Require the constitution and quality gate in `check-governance.sh`.
- [ ] Rerun the governance test and verify it passes.
- [ ] Commit `docs: establish TipMe physical interface governance`.

### Task 2: Define semantic tokens and materials

**Files:**

- Modify: `packages/ui/package.json`, `packages/ui/src/tokens.css`, `apps/web/src/app/design-system/page.tsx`
- Create: `packages/ui/test/design-tokens.test.mjs`

**Interfaces:**

- Consumes: Task 1 material definitions.
- Produces: semantic canvas, raised, recessed, signature, edge, shadow, geometry, typography, numeric, duration, and easing properties.

- [ ] Add `"test": "node --test test/*.test.mjs"` to `packages/ui/package.json`, then write failing tests for locked colors, required token names, unique declarations, and removal of obsolete generic shadow use.
- [ ] Run `pnpm --filter @tipme/ui test`; verify missing-token failure.
- [ ] Add backward-compatible semantic tokens and material specimens.
- [ ] Run UI tests and `pnpm --filter @tipme/ui typecheck`.
- [ ] Commit `feat(ui): define physical material tokens`.

### Task 3: Engineer tactile shared primitives

**Files:**

- Modify: `packages/ui/src/components.tsx`, `packages/ui/src/components.css`, `packages/ui/src/index.ts`, `apps/web/src/app/design-system/page.tsx`
- Create: `packages/ui/test/primitives.test.mjs`

**Interfaces:**

- Consumes: Task 2 tokens.
- Produces: `Surface`, material-aware `Card`, tactile actions, `AmountChoice`, fields, and feedback while preserving current exports.

- [ ] Write failing source-contract tests for exports, native defaults, material classes, and forbidden inline colors; add browser assertions on `/design-system` for actual button and radio semantics rather than treating source text as behavioral proof.
- [ ] Run the UI test and verify missing-interface failure.
- [ ] Add typed APIs and CSS for rest, hover-capable hover, active, focus, busy, disabled, selected, invalid, and forced colors.
- [ ] Add every state to the specimen.
- [ ] Run UI tests, typecheck, and targeted `/design-system` Axe coverage.
- [ ] Commit `feat(ui): add tactile accessible primitives`.

### Task 4: Resolve typography and portrait direction

**Files:**

- Modify: `apps/web/src/app/layout.tsx`, `packages/ui/src/tokens.css`, `docs/design/TYPOGRAPHY.md`, `docs/third-party-component-register.md`, `packages/database/src/seed.ts`, and affected seed/profile integration tests
- Create: `apps/web/public/portraits/ada.webp`, `apps/web/public/portraits/tobi.webp`
- Create: `apps/web/test/typography.test.mjs`

**Interfaces:**

- Produces: provisional interface, editorial, brand, and numeric font variables plus seeded optimized fictional-demo portraits and fallback behavior. D-09 remains open until the rendered candidate is approved.

- [ ] Write failing tests for variables, bounded weights, `font-display`, fallbacks, and NGN/tabular styles.
- [ ] Verify failure against Arial/Georgia-only typography.
- [ ] Compare candidates for rendering, license, glyphs, weight, and fallback metrics; record a recommendation without closing D-09.
- [ ] Integrate the recommended face as provisional, self-hosted at build or local, without runtime third-party requests; add a rendered approval checkpoint before declaring it final.
- [ ] Add fictional-demo WebP portraits with recorded provenance, intrinsic dimensions, responsive `sizes`, and per-asset byte budgets; update seed paths and integration expectations, preserve initials, and remove `unoptimized` image behavior only if the build/test evidence supports it.
- [ ] Run web tests, typecheck, build, and images/fonts-disabled inspection.
- [ ] Commit `feat(web): establish TipMe typography and portraits`.

### Task 5: Establish deterministic visual infrastructure and make the design-system route authoritative

**Files:**

- Modify: `playwright.config.ts`, `apps/web/src/app/design-system/page.tsx`, `apps/web/src/app/globals.css`, `tests/e2e/quality.spec.ts`, `docs/design/VISUAL-QUALITY-GATE.md`
- Create: `apps/web/src/app/design-system/specimens.tsx`, `tests/e2e/design-system.visual.spec.ts`

**Interfaces:**

- Produces: deterministic material, type, control, symbol, responsive, and motion specimens.

- [ ] Configure fixed browser, viewport, color scheme, locale, timezone, animation, caret, screenshot path, and font-readiness behavior before creating any baseline.
- [ ] Document baseline update permissions and diff inspection before creating any baseline.
- [ ] Add failing Playwright assertions for named regions, real button/radio semantics, and reduced-motion/forced-colors behavior.
- [ ] Verify the missing regions fail.
- [ ] Implement specimens without product data or API calls.
- [ ] Add deterministic desktop/mobile `toHaveScreenshot` checkpoints under the fixed environment.
- [ ] Run targeted Axe, reflow, reduced-motion, and screenshot tests; inspect diffs before accepting baselines.
- [ ] Commit `test(web): establish design-system visual authority`.

### Task 6: Recompose the public recipient profile

**Files:**

- Modify: `apps/web/src/app/people/[handle]/page.tsx`, `apps/web/src/components/avatar.tsx`, `apps/web/src/app/globals.css`, `tests/e2e/shell.spec.ts`
- Create: `apps/web/src/components/profile/recipient-card.tsx`, `apps/web/src/components/profile/profile-symbols.tsx`, `tests/e2e/profile.visual.spec.ts`

**Interfaces:**

- Produces: server-rendered `RecipientCard`; a minimal client `AvatarImage` fallback for actual image-load failure; deterministic edge-case specimens on `/design-system`; leaves `AppreciationForm` behavior intact.

- [ ] Add failing tests for real seeded profiles plus design-system fixtures containing a long name, long biography, absent portrait, and broken portrait URL; assert the broken URL resolves to initials through the browser-level fallback.
- [ ] Verify failure against the current banner-and-column profile.
- [ ] Implement the card with semantic content and authored SVG symbols; add the smallest client image island needed to handle `onError` without moving profile data fetching client-side.
- [ ] Compose paired desktop objects and one deliberate mobile sequence.
- [ ] Run functional, Axe, keyboard, reflow, and visual tests; inspect portrait crops.
- [ ] Commit `feat(web): recompose the recipient profile`.

### Task 7: Rebuild the tipping panel without behavior changes

**Files:**

- Modify: `apps/web/src/components/appreciation-form.tsx`, `apps/web/src/app/globals.css`, `tests/e2e/checkout.spec.ts`, `tests/e2e/quality.spec.ts`, `tests/e2e/profile.visual.spec.ts`
- Create: `apps/web/src/components/tip/amount-selector.tsx`, `apps/web/src/components/tip/quote-panel.tsx`

**Interfaces:**

- Produces: presentational tactile selectors and quote well; `AppreciationForm` retains API, draft, idempotency, analytics, storage, and redirect state.

- [ ] Add failing tests for selected state, presets/custom amount, large totals, stable quote/errors, keyboard wrapping, focus recovery, double submit, and message privacy.
- [ ] Verify only new presentation contracts fail.
- [ ] Extract typed presentational components with no API access.
- [ ] Apply raised/recessed/signature materials while preserving financial copy.
- [ ] Run checkout, Axe, keyboard, 320px, reduced-motion, and visual tests.
- [ ] Commit `feat(web): make tipping controls tactile`.

### Task 8: Create the verified Appreciation Moment

**Files:**

- Modify: `apps/web/src/app/tip/[tipId]/status-view.tsx`, `apps/web/src/app/globals.css`, `tests/e2e/checkout.spec.ts`
- Create: `apps/web/src/components/tip/appreciation-moment.tsx`, `tests/e2e/receipt.visual.spec.ts`

**Interfaces:**

- Consumes: trusted `tip.state` and recognition data.
- Produces: `AppreciationMoment({ recipient, amount, recognition? })` for every trusted `paid` result, with optional recognition rendered separately and static reduced-motion parity.

- [ ] Add failing tests proving the core appreciation moment appears for paid with or without optional recognition, and never for loading, incomplete link, not found, offline/stopped, waiting, checking, declined, or cancelled.
- [ ] Verify the paid composition is absent.
- [ ] Implement semantic confirmed composition and authored symbol.
- [ ] Add restrained acknowledgement motion and an immediate reduced-motion equivalent.
- [ ] Run state, polling, privacy, Axe, motion, and visual tests.
- [ ] Commit `feat(web): add verified appreciation moment`.

### Task 9: Prove visual regression stability

**Files:**

- Modify: `docs/design/VISUAL-QUALITY-GATE.md` and visual specs from Tasks 5–8
- Create: Playwright snapshot baselines

**Interfaces:**

- Produces: stable desktop/mobile checks and baseline-review procedure.

- [ ] Make an intentional specimen change; verify screenshot failure; restore it.
- [ ] Audit that every visual spec uses the deterministic harness established in Task 5.
- [ ] Generate and manually compare baselines with the repository-owned board; if the board asset is still absent, record parity review as blocked rather than approving it.
- [ ] Run the visual suite twice to detect nondeterminism.
- [ ] Commit `test(web): govern visual regression baselines`.

### Task 10: Verify and hand off

**Files:**

- Modify: `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`, `docs/third-party-component-register.md` as needed
- Create: `docs/evidence/physical-interface/*`

**Interfaces:**

- Produces: verified evidence, exact results, remaining fidelity gaps, and next slice.

- [ ] Run format, governance, lint, typecheck, UI/web tests, build, relevant integration, complete Playwright, and lab performance checks.
- [ ] Manually review keyboard, touch, 200% zoom, screen-reader smoke, reduced motion, forced colors, images disabled, and slow network.
- [ ] Compare desktop/mobile evidence with reference anatomy and record gaps.
- [ ] Verify no contract, API behavior, migration, payment truth, or finance logic changed.
- [ ] Update continuity documents with results and the exact next slice.
- [ ] Commit `docs: record physical interface verification`.
