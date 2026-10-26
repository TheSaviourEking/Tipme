# TipMe production countdown — design

**Date:** 26 October 2026  
**Target:** 27 October 2026, 00:00 Africa/Lagos (`2026-10-26T23:00:00Z`)  
**Status:** Approved by the product owner for `usetipme.xyz`

## Intent

Give the production domain a deliberate TipMe holding experience until midnight in Lagos, then hand visitors automatically to the existing home experience. The countdown should feel like the same product—warm, editorial, tactile and restrained—not like a template or an operations screen.

## Experience

- Hide the standard navigation and footer while the holding page is active.
- Keep the TipMe wordmark and warm canvas.
- Lead with the editorial line: **“A little thanks is almost here.”**
- Supporting copy: **“TipMe opens at midnight in Lagos.”**
- Show four tactile numeric instruments: days, hours, minutes and seconds. They use raised/recessed material roles, tabular numerals and clear text labels; purple is concentrated on the seconds/launch accent.
- Show the unambiguous date below the timer: **“27 October 2026 · 00:00 WAT”**.
- Use a quiet line from the brand promise: **“For the people who make a difference.”**
- At zero, replace the countdown announcement with **“TipMe is open.”** and navigate to `/`; the edge gate has expired, so the existing home page renders.
- The page carries a `.coming-soon-page` marker. CSS uses it to set the global header/footer to `display: none` (removing their links from the accessibility tree), and `WebVitalsReporter` explicitly skips all delivery while that marker is present. An overlay is not sufficient.

## Runtime and routing

- Add server-only `PRODUCTION_LAUNCH_AT`, an ISO-8601 timestamp with an explicit offset or `Z`. Production is gated only when it is valid and in the future.
- The setting is scoped to the production Vercel environment. When unset, local, CI and staging behavior is unchanged.
- The Next request proxy rewrites all user-facing routes to `/coming-soon` before the target. It exempts framework assets, `/api/revalidate`, the holding route and every `/coming-soon/opengraph-image*` generated variant, favicon/icon, `robots.txt`, and `sitemap.xml`.
- Move the existing `/people/:handle` legacy redirect from `next.config.ts` into the request proxy after the countdown decision. Next config redirects run before Proxy in Next 16 and would otherwise change the address before the holding page. Short-link redirects and preview-password gating also run only after the production countdown decision.
- At or after the target, the proxy passes through with no countdown redirect/rewrite. No redeploy or manual switch is required.
- Use a rewrite rather than a redirect so `usetipme.xyz` remains in the address bar.
- The rewrite response carries `Cache-Control`, `CDN-Cache-Control`, and `Vercel-CDN-Cache-Control` no-store directives. The holding route opts out of static caching, and a fresh request immediately after the target must reach the normal route rather than a cached holding response.
- When `PRODUCTION_LAUNCH_AT` is unset or expired, a direct `/coming-soon` request redirects to `/`; the stale page is not permanently browsable. A no-JavaScript browser therefore reaches the home page on its next request after launch.
- Invalid launch configuration fails closed at build/start rather than silently scheduling the wrong time. One shared strict parser requires an explicit `Z` or numeric offset and a finite instant; `apps/web/next.config.ts` invokes it during build/start and the proxy/route reuse the parsed rule.
- Add `PRODUCTION_LAUNCH_AT` to root `turbo.json` `build.env` so Turbo cannot reuse a web build created for another target.

## Countdown behavior

- Calculate from the fixed UTC instant, never the visitor’s timezone.
- Clamp at zero; never show negative values.
- Update once per second using one client island. The rest of the page is server-rendered.
- The visible timer is not an assertive live region every second. Provide a polite, visually hidden announcement no more than once per minute and at launch to avoid screen-reader noise.
- The initial server/client value must avoid a hydration mismatch. Render a stable placeholder until mounted, then announce the actual remaining time.
- If JavaScript is unavailable, the page still communicates the exact launch date/time; the next request after launch bypasses the edge gate.
- Respect reduced motion. The launch transition is opacity-only and becomes immediate under `prefers-reduced-motion`.
- Mark the four visual numeric values `aria-hidden="true"`. Expose one combined remaining-time sentence to assistive technology, updated at most once per minute and at launch. Render the exact launch moment with semantic `<time dateTime="2026-10-26T23:00:00Z">`.
- Placeholder digits reserve the final width and height to avoid cumulative layout shift. Reduced-motion disables digit and launch transitions entirely.

## Visual composition

- One centred full-screen composition, not a dashboard grid.
- Wordmark above a large serif headline with generous whitespace.
- Countdown values sit as four shallow physical objects with crisp edges, a light-facing border and restrained contact shadow.
- On narrow screens, values remain a two-by-two grid with 44px minimum readable/touch spacing; no horizontal scroll at 320px or 200% zoom.
- No decorative blobs, glass, glow, confetti, email capture, fake scarcity or guilt messaging.

## Metadata and indexing

- Title: `TipMe — A little thanks is almost here`.
- Description names the exact Lagos launch time without making payment or availability promises beyond the scheduled opening.
- Canonical remains the production root.
- Keep current noindex behavior unless the separate production indexing gate is explicitly enabled.
- Add a dedicated code-native Open Graph image for the countdown using the master wordmark paths, headline, exact WAT date and restrained purple accent.

## Production hostname

Repository deployment authority currently names `https://www.usetipme.xyz` as the production deployment. Treat the product owner’s `usetipme.xyz` wording as the public brand/apex domain: the apex is expected to be a Vercel alias or platform redirect to `www`. `SITE_URL` and the canonical remain `https://www.usetipme.xyz` unless the Vercel domain assignment is intentionally changed. The app rewrite preserves the hostname that reaches Next, but it cannot prevent a platform-level apex-to-`www` redirect. Release verification must check both assigned hostnames and record which is canonical before claiming address-bar behavior.

## Tests

- Pure launch-decision tests: unset config passes; valid future target rewrites; exact target and later pass; invalid/ambiguous timestamps reject; direct `/coming-soon` redirects when inactive; exempt assets/routes pass; hostile path forms do not bypass the gate; legacy `/people` redirect runs only after the gate.
- Timer unit tests: exact day/hour/minute/second decomposition and zero clamping.
- Playwright uses injected far-future/far-past targets, never the real launch instant for durable before/after cases. A separate pure test proves `27 October 2026, 00:00 Africa/Lagos` maps to `2026-10-26T23:00:00Z` and renders `27 October 2026 · 00:00 WAT`.
- Playwright: future-target root shows the holding page and preserves `/`; direct profile/internal routes show the holding page; `/api/revalidate` remains the authenticated API response rather than HTML; chrome links are absent from the accessibility tree; web vitals send nothing; axe clean; keyboard/focus safe; no 320px overflow; reduced motion; semantic `<time>`; stable placeholders/no CLS; metadata/social image; no-store response headers; a fresh request under past-target configuration shows the normal home.
- Existing preview-gate and short-link tests remain green.

## Non-goals

- Deploying or changing Vercel production variables from this code task.
- Changing staging, the API, payments, profiles, account behavior or the public-preview branch.
- Collecting emails or analytics on the holding page.
- Building a recurring launch/event system. This is a small, removable production gate.

## Release procedure

1. Confirm in Vercel whether the apex redirects to the repository-authoritative `www` production domain; keep `SITE_URL`/canonical aligned with the result.
2. Deploy the code to production with `PRODUCTION_LAUNCH_AT=2026-10-26T23:00:00Z`.
3. Verify production root and a direct profile/internal URL all render the holding page while keeping the hostname/path that actually reaches Next.
4. Verify `/api/revalidate`, `/robots.txt`, `/sitemap.xml`, icons, framework assets and the dedicated social image.
5. Verify no-store headers, the rendered date `27 October 2026 · 00:00 WAT`, and compare the live remaining time with a trusted Lagos clock.
6. At midnight, verify a fresh request reaches the existing home page automatically on both assigned hostnames.
7. Remove `PRODUCTION_LAUNCH_AT` in the next cleanup deployment; the expired value is harmless but should not become permanent configuration.
