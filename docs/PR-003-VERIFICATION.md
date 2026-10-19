# PR-003 verification — 18 October 2026

## Scope delivered

Non-transactional web experience: `packages/ui` tokens and accessible primitives; marketing home; fictional profiles `/people/ada` and `/people/tobi` with a review-only appreciation form; `/about-preview`; development specimens `/design-system` and `/preview-states`; real route `loading`, `error` and `not-found` states; canonical, noindex and Open Graph/Twitter metadata with a build-time share card. No API, database, auth, analytics or payment code. NGN is illustrative only.

Work was started by a previous agent and completed by a takeover agent. See `docs/agent/HANDOFF.md` for the audit.

## Acceptance mapping

| Criterion (spec/plan)                                               | Evidence                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Keyboard radio/custom transitions, focus after validate/review/edit | `shell.spec.ts` profile test                                                            |
| Decimal input: empty, malformed, precision, zero, excess; no floats | `apps/web/test/demo-amount.test.mjs`; integer minor-unit parsing                        |
| Drafts never in URL, network, storage                               | `shell.spec.ts`: no POSTs, URL check, `localStorage`/`sessionStorage` empty             |
| No fake payment success                                             | Review states "Nothing has been sent or charged."; screenshot `profile-review-*`        |
| Unknown profiles unavailable; mocks noindex                         | `shell.spec.ts`; `quality.spec.ts` robots check on all 7 routes                         |
| Canonical + OG on profiles; OG asset served                         | `shell.spec.ts`; `quality.spec.ts` share-card test (200, `image/png`)                   |
| Reflow at 320px / 400% zoom; 360px; desktop                         | `quality.spec.ts`                                                                       |
| Reduced motion                                                      | `quality.spec.ts` (skeleton animation `none`)                                           |
| Mobile nav disclosure, Escape, focus return                         | `quality.spec.ts` (mobile project)                                                      |
| Automated a11y                                                      | axe WCAG 2.0/2.1/2.2 A+AA tags: 0 violations on 7 routes + review state, both viewports |

## Commands (Node 24.22.0, pnpm 10.33.0)

| Command                              | Result                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| `pnpm format:check`                  | PASS                                                                  |
| `pnpm lint`                          | PASS — 7/7 tasks                                                      |
| `pnpm typecheck`                     | PASS — 7/7 tasks                                                      |
| `pnpm test`                          | PASS — 8/8 tasks, 0 failures                                          |
| `pnpm test:e2e` (build + Playwright) | PASS — 33 passed, 1 skipped (mobile-only nav test on desktop project) |

Build output: `/`, `/about-preview`, `/design-system`, `/preview-states`, `/opengraph-image`, `/people/ada`, `/people/tobi` static; `/people/[handle]` partial prerender for unknown handles.

## Defects found and fixed during takeover

- Production-only horizontal overflow from decorative `.demo-orbit` → `main { overflow-x: clip }`.
- 10 lint errors (`no-html-link-for-pages`) → internal links use `next/link` (`ActionLink` in `packages/ui` stays a plain anchor; UI must not depend on Next).
- 24 PR-003 files unformatted → Prettier on PR-003 paths only.
- Metadata referenced a non-existent `/social/preview.png` → `app/opengraph-image.tsx` (`next/og`, prerendered); explicit image in `previewMetadata` because page-level `openGraph` replaces inherited file-based images.
- `packages/ui` reduced-motion rule lost on specificity; skeleton kept pulsing → selector fixed.
- Missing `/design-system` (footer linked to a 404) and `/preview-states` → added from existing primitives.

## Screenshots (inspected)

`docs/evidence/pr003/`: home, profile-ada, profile-review, design-system, preview-states at 1280 and 360px; `opengraph-image.png`. Checked for brand palette, clipping, overflow, spacing and honest preview copy.

## Lab performance sample (not field data)

Cold load, production server on localhost, 360×800, 4× CPU throttle, 1.6 Mbps / 150 ms RTT, cache disabled, one run each:

| Route         | LCP    | CLS | Script transfer | Total transfer |
| ------------- | ------ | --- | --------------- | -------------- |
| `/`           | 740 ms | 0   | 146 KB          | 162 KB         |
| `/people/ada` | 660 ms | 0   | 154 KB          | 173 KB         |

Single synthetic samples on loopback. They are not p75 field values and say nothing about INP. RUM is still required.

## Final review (takeover agent, fresh pass over all PR-003 files)

Checked privacy (drafts only in React state; no `console`, storage, `fetch`, `dangerouslySetInnerHTML` or query-param reads in `apps/web` or `packages/ui`), escaping of the message, honest copy (no success or fee claims), minor-unit arithmetic, focus management and metadata.

- **Fixed:** selecting "Other" moved focus into the amount field, so arrow-key navigation through the radio group (which wraps onto "Other") pulled keyboard users out of the group mid-navigation (WCAG 3.2.2 risk). Confirmed with a new failing e2e test, then removed the auto-focus. Tab still reaches the field next, and invalid submit still focuses it.
- **Minor follow-ups, all fixed (each covered by a test):**
  - Custom amounts accept correctly grouped thousands separators (`1,500`, `1,500.50`); bad grouping (`1,50`, `1000,000`) is still rejected. The error now gives an example. Still integer minor units.
  - The menu button keeps the constant name "Menu"; only `aria-expanded` conveys state.
  - `TextareaField` merges a caller's `aria-describedby`, matching `InputField`.
  - Baseline security headers on every route (`next.config.ts`): `nosniff`, `strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, restrictive `Permissions-Policy`, no `X-Powered-By`.
  - **Deferred deliberately:** a `script-src`/`style-src` CSP needs per-request nonces, which forces dynamic rendering of the currently static pages (verified in the installed Next 16.4.2 CSP guide), so it needs an ADR. HSTS belongs at the HTTPS edge once a domain is approved.

## Not verified / open

- Manual screen-reader and real-device testing; Safari/Firefox (Chromium only).
- Hosted CI, branch and PR: no Git repository exists.
- `SITE_URL` defaults to `http://localhost:3000`; production origin depends on D-01/domain decisions.
- All VALIDATE items D-01…D-10 remain OPEN.

## Next PR

PR-004 (API/worker health, validation, correlation) needs explicit authorisation.

## Addendum — legal placeholders (18 October 2026, after baseline reconciliation)

The delivery plan's PR-003 line requires "legal placeholders clearly labeled"; the approved PR-003 spec had omitted them. Added `/legal/privacy` and `/legal/terms`. Each is labelled "Placeholder — not a legal document" in its eyebrow, notice and page title, is noindex, and contains **no legal terms**: it lists only what the final document must cover, because entity, jurisdiction and policies are unapproved (D-02, D-07). Footer links read "Privacy (placeholder)" and "Terms (placeholder)".

- Test-first: a new e2e test failed on both viewports before the pages existed, then passed. Both routes were added to the axe/reflow/noindex route checks.
- Screenshot review found missing list markers (Tailwind reset) and an inline link distinguishable only by colour (WCAG 1.4.1); both were fixed in `.prose-page` styles. Evidence: `docs/evidence/pr003/legal-privacy-{desktop,mobile}.png`.
- Gate: lint 9/9, typecheck 9/9, unit 11/11 tasks, build, e2e 39 passed / 1 skipped.

## Addendum — PRD routes (18 October 2026)

Following the user's decision to follow the PRD: profiles moved to `/@handle` (rewrite to the internal `people/[handle]` route; `/people/*` → 308), and `/how-it-works` and `/for-creators` were added from shared home components, with the main navigation updated. Test-first: 14 e2e failures before, 49 passed / 1 skipped after. Screenshot review fixed a heading overlapping the step dividers and missing paragraph spacing on `/for-creators`. Evidence: `docs/evidence/pr003/{how-it-works,for-creators}-{desktop,mobile}.png`.
