# Third-party component and animation register
| Source URL | Pattern copied/adapted | License verified | Dependencies/size | Keyboard/screen reader | Reduced motion | Mobile/perf test | Decision |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Do not integrate third-party components until an actual row is completed with factual results.

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
