# Third-party component and animation register
| Source URL | Pattern copied/adapted | License verified | Dependencies/size | Keyboard/screen reader | Reduced motion | Mobile/perf test | Decision |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Do not integrate third-party components until an actual row is completed with factual results.

## Physical interface typography and demo imagery

- **Manrope, DM Serif Display** (SIL Open Font License 1.1, Google Fonts): loaded and self-hosted by `next/font` during the build, with no runtime third-party request. Manrope supplies interface weights 400–700, DM Serif Display supplies editorial 400; the wordmark is an SVG (Nunito was removed on 25 October 2026). The rendered candidates remain provisional under D-09. Font-disabled and narrow-layout checks are part of the visual gate.
- **Ada and Tobi demo portraits:** original fictional images generated for TipMe with OpenAI's built-in image generation tool on 2026-10-25, then encoded as repository-owned WebP assets at 960 px width. They do not depict known people and contain no embedded text, logos, or user data. Decision: adopted for preview/demo profiles only; replaceable without changing product data contracts.

## PR-001/002 bootstrap

Tailwind CSS 4.3.3 and its matching Turbopack loader come from the official Next template (MIT; https://github.com/tailwindlabs/tailwindcss). They provide build-time styling, not interactive components. This shell uses semantic HTML, system fonts and no animations or third-party component library. Next/React are framework dependencies; all selected versions are recorded in ADR-0001. Browser smoke checks cover keyboard focus, narrow viewport overflow and reduced-motion readability; this is not a full WCAG audit.

## PR-003 experience

`@axe-core/playwright` 4.14.0 (MPL-2.0, https://github.com/dequelabs/axe-core-npm) is a root **devDependency** used only in `tests/e2e/quality.spec.ts` for automated WCAG 2.x A/AA rule checks. It ships no code to browsers or users. Automated rules catch a subset of issues and do not replace manual screen-reader testing. No third-party UI component, animation library or remote font was added in PR-003; all components are original in `packages/ui` and the share card uses Next's built-in `next/og`.

## PR-008 recipient accounts

`libphonenumber-js` 1.13.14 (MIT, https://gitlab.com/catamphetamine/libphonenumber-js), a dependency of `@tipme/database` only. It is server-side and never shipped to browsers. It validates phone numbers and normalises them to E.164: "0803 123 4567" and "+234 803 123 4567" become one identity. The package is about 12 MB on disk, mostly metadata, and none of it reaches the web bundle. Chosen over hand-written rules because number plans change and it tracks Google's libphonenumber metadata. Decision: ADOPTED (pinned exact).

`qrcode` 1.5.4 (MIT, https://github.com/soldair/node-qrcode), a dependency of `@tipme/web`.
- **Use:** builds the QR module matrix in the browser for a recipient's code, card, print and share image. Only `QRCode.create` is used; TipMe draws the pixels itself (`apps/web/src/lib/qr-render.ts`) so it controls colours, shape and the quiet zone.
- **Size:** the browser build is small. The package's command-line dependencies (`yargs`, `pngjs`) are never bundled into pages.
- **Accessibility and motion:** no keyboard or motion surface of its own. The canvas carries `role="img"` with a text label, and the link is also shown as text.
- **Tests:** `apps/web/test/qr-styles.test.mjs` decodes every style; `tests/e2e/qr.spec.ts` checks the page at 360 px and 320 px.
- **Decision:** ADOPTED (pinned exact).

`jsqr` 1.4.0 (Apache-2.0, https://github.com/cozmo/jsQR), a **devDependency** of `@tipme/web`, used only by `apps/web/test/qr-styles.test.mjs`. It decodes every QR style, so a style that does not scan cannot ship. It ships no code to users. Decision: ADOPTED (pinned exact, tests only).

`@types/qrcode` 1.5.6 (MIT, DefinitelyTyped): type definitions only, development dependency.

## Staging and release (PR-010)

Server images and tools for the staging server. None of them ships code to browsers.

- **Container images** (pinned tags in `deploy/Dockerfile` and `deploy/compose.staging.yml`):
  - `node:24.22.0-alpine` (MIT/Docker Official Image): base for the API, worker and tools image.
  - `caddy:2.10.2-alpine` (Apache-2.0, https://caddyserver.com): the only public entry; automatic HTTPS via Let's Encrypt.
  - `postgres:16.13-alpine` (PostgreSQL licence): the staging database, matching the local server's 16.13.
  - `redis:7.4.5-alpine` (BSD-3-Clause for 7.4): the job queue, append-only file on, `noeviction`.
  - `rclone/rclone:1.71.1` (MIT, https://rclone.org): optional hourly copy of the encrypted backups to an S3-compatible bucket (`--profile offsite`).
- **Alpine packages in the image:**
  - `postgresql16-client` (PostgreSQL licence): `pg_dump`/`pg_restore` for backups and the restore drill;
  - `tini` (MIT): an init process, so signals reach Node and stopped containers exit cleanly.
- **Build-time only:** `turbo@2.11.9` via `pnpm dlx` to prune the workspace for the image (already the pinned dev tool).

Decision: ADOPTED (pinned exact). Upgrades are deliberate and go through the release check and the restore drill.

## PR-011 hardening

- **CI and test tools (Docker images, pinned by digest, never shipped in the app image):**
  - `zricethezav/gitleaks:v8.24.3@sha256:e1b35e12a8c6fa8901f060459cfb6b2fc4c484d3afbe3b029733a3bbfab07055` (MIT, https://github.com/gitleaks/gitleaks): secret scanning of the whole Git history in CI, findings redacted. Exact-match allowlist in `.gitleaks.toml`.
  - `grafana/k6:1.0.0@sha256:f21270290d702cbf0a7d6ba5d7ed100b63bcb233b558b885ed787547b3488279` (AGPL-3.0, https://github.com/grafana/k6): load tests against a throwaway local API (`pnpm test:load`). Run as a separate tool; no TipMe code links to it.
- **No new runtime dependencies.** Error reports use TipMe's own Sentry-envelope sender (no Sentry SDK); web vitals use `next/web-vitals`, already part of Next; the OpenAPI document uses zod's built-in `z.toJSONSchema`.
- **Postgres features, not packages:** WAL archiving (`archive_command` copying to a volume) and `pg_basebackup` from the existing `postgres:16.13-alpine` and `postgresql16-client`.

Decision: ADOPTED (pinned exact). Upgrades are deliberate: re-pin the digest and rerun the scan and load test.

## PR-013 product gaps

- **`sharp` 0.35.5** (Apache-2.0, https://sharp.pixelplumbing.com): decodes and re-encodes profile photos in the API (to a 512×512 WebP, no metadata), with a 40-megapixel limit against "pixel bombs". It was already in the lockfile through Next.js; it is now a direct, exactly pinned dependency of the API. The Docker image installs its musl (Alpine) build.

Decision: ADOPTED (pinned exact).
