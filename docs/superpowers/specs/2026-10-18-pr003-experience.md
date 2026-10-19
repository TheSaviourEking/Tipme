# PR-003 experience design

## Approved brief

Implement the user's approved PR-003 only: reusable accessible design primitives, premium marketing, local mock public profiles, non-transactional checkout preparation, metadata, responsive/a11y/performance evidence. No API, database, auth or payment implementation. Preserve existing foundations except documented UI package/test configuration extensions.

## Direction and implementation decisions

Editorial white space and large black typography, purple emphasis and restrained lavender surfaces derived from #7A32F9. System sans with contrasting serif italic display accents; no remote fonts. Original vector/CSS artwork, no stock endorsements or fabricated activity. Marketing alternates a split hero with working appreciation composer, a quiet typographic manifesto, two use-case compositions, numbered how-it-works steps, and a black trust/closing section. No decorative animation dependency.

Profiles at `/people/[handle]` use fictional Ada (creator) and Tobi (in-person professional). Mock avatars are original SVG illustrations. Profile pages carry explicit demo labels and noindex. A form uses native radio choices, a custom decimal string field, optional message and a focused review state. NGN is illustrative only; no price/fee truth, accounts, payment requests or simulated success. All draft content lives only in React state, never storage, URLs, logs or network. Review has edit/reset controls and says nothing has been sent.

`/design-system` is a noindex development specimen route exercising tokens and states, including generic nonfinancial success. `/preview-states` exposes deterministic loading, unavailable and error demonstrations separately from actual route error boundaries. `/about-preview` explains limits and privacy. Known mock routes receive unique titles, canonical paths, SVG Open Graph cards. Base URL is configured through validated SITE_URL, defaults localhost; all preview routes remain noindex until real publication approval. No sitemap advertises fictional accounts.

## Components and boundaries

`packages/ui`: typed buttons/links, fields, radio choice, badge/card/container, skeleton, empty/error/success/status, motion class and token/CSS exports. UI components own no finance data. Native HTML controls preserve keyboard semantics. React peer/types are the same versions already used by web.

`apps/web`: navigation with mobile disclosure, footer, mock content, profile composition and appreciation form. Most marketing content remains server-rendered; only navigation disclosure, form and share controls need client state. Form parsing handles minor units with integer/string arithmetic and bounded sample range; this is demonstration validation, not a payment policy.

## Validation and risks

Baseline lint/typecheck/test/build passed; existing web/API respond and Docker services are healthy. Existing development server is preserved; Playwright production server uses port 3100. Native API/worker tests remain untouched. Extend Playwright for real keyboard interactions, errors, retained drafts, no payment network calls, metadata/noindex, 320/360px layouts, reduced motion, zoom-like reflow and axe checks. Measure cold local mobile synthetic navigation with Chromium throttling; report LCP/CLS as lab samples, never p75 field compliance or INP. Inspect desktop/mobile screenshots before completion.

Risks: launch currency and domain are unresolved (explicit sample currency and local canonical fallback); system fonts vary across OS; browser accessibility checks do not replace manual assistive-technology testing; no Git metadata means branch cannot be created without inventing history.
