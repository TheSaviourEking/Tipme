# Web agent rules
- Next.js App Router, server components by default, interactive client islands as needed. Verify installed API and framework version before coding.
- Render public profile metadata server-side and sanitize user content. Never render payer-sensitive info in public HTML, cache, metadata or OG assets.
- Use design tokens from `packages/ui`, purple #7A32F9, white, black. Prioritize responsive layouts, compositional originality, and semantic content.
- Checkout: focus, clarity, static layout, complete fee disclosure; always derive confirmed status from trusted API, not redirect query string.
- Respect reduced motion and input modality; no hover-only or scroll-jacking UX.
- Track anonymous funnel events with opt-out/consent decisions; never log PII or freeform messages.
- Performance budgets: minimize client bundles and third-party scripts; measure on simulated mid-range mobile and throttled network.
- UI states required: loading, empty, recoverable error, payment pending, canceled, expired, success-verified, failure, unknown.
- Add Playwright coverage for checkout and accessibility.
