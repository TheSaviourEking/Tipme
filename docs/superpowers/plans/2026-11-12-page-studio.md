# Page Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pro recipients design their own public page: any brand colour, fonts from a self-hosted library, and their own rows and blocks on a fixed grid. Guardrails correct whatever would break (contrast, phone layout, text on photos), and a design check refuses to publish anything they can't correct. TipMe's tip block, fee line, Pro badge, report link and footer stay locked.

**Owner's direction:** 11 Nov 2026: "A Pro user customises their page like a website… we give them a studio." Then: "We need to make it impossible for the user to build a bad page/UI/profile." Refined 12 Nov 2026: **"They should be able to make custom UI but no bad ones."** This plan replaces the presets-only studio of the first draft (8 palettes, 3 font pairs, 3 layouts, 144 tested combinations) with **guardrails, not presets**. The 12 open questions on the canvas note `studioquestions` are **not** answered yet. See "Owner rulings (defaults)". This is a product decision only. It is not legal, data-protection or payment-partner approval. D-07 stays OPEN. Nothing in this plan changes a fee, a minimum, a checkout amount, a ledger posting or a payout.

**Architecture:** A Studio page is a JSON document (`StudioDocument` v1): 1–2 brand colours, a light/dark/auto mode, two font ids, a type-scale step, a corner style, and an ordered list of rows. Each row picks a column split from a fixed set, a spacing step and a background. Each column holds blocks: kind, variant, user text, and TipMe image ids. Nothing in the document is a CSS value, except the brand colours, which are `#rrggbb` and never reach CSS directly. Four pure modules in `packages/contracts` turn the document into a page that can't be bad:

1. **Colour engine** (`deriveStudioPalette`): brand colours → every page, card, border, text, link, button and focus colour, for light and dark, by searching OKLCH lightness at the brand hue until each WCAG pair passes.
2. **Type and font registry** (`STUDIO_FONTS`, `studioTypeScale`): 14 self-hosted families, each with roles and metrics, and a modular scale with `clamp()` limits.
3. **Document schema and resolver** (`studioDocumentSchema`, `resolveStudio`): every limit, and a fallback for anything a registry change has retired.
4. **Design check** (`checkDesign`, `applyStudioFix`): one rule set, run by the editor on every edit, by the API on every save, and by `publishStudio` as the gate. Every rule returns issues with one-click fixes, which are pure document transforms.

The web renders the resolved document with server components. It uses `--studio-*` custom properties computed by the engine, grid CSS keyed by data attributes, and `@font-face` rules for only the two families used. There is no user CSS or HTML. The tip block and footer are today's components, rendered outside the Studio scope.

**Tech Stack:** Drizzle/Postgres, NestJS, sharp (already used), Next.js 16 App Router (server components), Zod, `node --test`, Playwright with `@axe-core/playwright` (already used). **One new devDependency:** `fast-check` (MIT, test-only, ships nothing to browsers), for property-based tests. It is registered in `docs/third-party-component-register.md`. **New assets:** up to 12 more self-hosted OFL font families (Task 2). No new runtime npm dependency. OKLCH maths is about 80 lines in `studio-colour.ts`, no library.

**Spec:** Canvas https://claude.ai/artifact/8D6hJZsqMkLSGh8KUUBmmh (version 1794474280-c388, 12 Nov 2026). Boards: `StudioEditor.dc.html` (editor, colour picker and derived palette, font library, blocks on the grid, design check, "can't publish yet"), `StudioExamples.dc.html` (three different custom designs, each passing), `StudioRules.dc.html` (locked, theirs-with-guardrails, never, design check, the testing promise, Free), `StudioLapse.dc.html`. Notes: `studioquestions` and `studiolater`. Task 1 copies the four boards unchanged into `docs/design/redesign/boards/`, so the repo holds the spec.

---

## What the code does today (origin/dev `c4966605`, migrations up to 0092)

- **Public page:** `apps/web/src/app/people/[handle]/page.tsx` (rewritten from `/@:handle` in `apps/web/next.config.ts`). It renders `ProfileCover`, `RecipientIdentity`, the `aside.profile-composer.tip-instrument` holding `AppreciationForm` / `TippingOpensSoon` / `TipsNotReady`, and `footer.profile-foot` (ReportPage, Privacy, Terms, "Learn about this preview", and "Get your own TipMe page" when `plan !== 'pro'`). The data comes from `loadPublicProfile` → `GET /v1/profiles/:handle` → `publicProfile()` in `packages/database/src/operations/profiles.ts:959`.
- **Contracts:** `PublicProfile` / `MyProfile` / `PagePlan` / `PROFILE_REPORT_REASONS` are in `packages/contracts/src/profiles.ts`. Covers (`COVER_COLOURS`, `COVER_DARK`, `resolveCover`) are in `covers.ts`. Social links (`visibleLinks`, `FREE_LINK_LIMIT` 3, `PRO_LINK_LIMIT` 8, a host allow-list) are in `social-links.ts`. Every new field is optional, because the web deploys before the API.
- **Photo pipeline:** `apps/api/src/profiles/image-upload.ts`: `readUpload` (JPEG/PNG/WebP only, 5 MB, signature check), `reencodeTo(w,h)` (sharp, `rotate()`, `fit: 'cover'`, WebP q80, which drops all metadata, plus a 25 MP limit and a 5 s timeout), `withSlot` (2 concurrent), `sendImage` / `sendPrivateImage`. Storage: `PhotoStore` (R2 or Postgres bytes, "one place" check), as in `operations/covers.ts` and `page-images.ts` (`myPageId`, `lockLivePage`, `removeObjects`). Staff can view and remove page images (`operations/page-moderation.ts`, permission `pages.suspend`).
- **Pro gating:** `profiles.plan` is what every Pro check reads. `recomputePlan` (`operations/pro-periods.ts:70`) derives it from `staff_pro` and the `pro_periods` that cover now. The worker's `expireDuePeriods` returns the changed pages, and the worker revalidates them (`apps/worker/src/job-worker.ts:497`). Pro-only writes check the plan, then add `eq(profiles.plan, 'pro')` to the UPDATE (`setThanks`, `setTipAmounts`). Lapsed Pro data is kept, not deleted.
- **Fonts:** `apps/web/src/app/layout.tsx` self-hosts `Manrope-Latin.woff2` (200–800) and `DMSerifDisplay-Latin.woff2` (400) through `next/font/local`. `apps/web/src/lib/font-cmap.ts` reads a font's `cmap` (formats 4 and 12). The share cards use it to set a name in one font that draws all of it. **DM Serif Display has no Ọ or Ẹ** (`docs/third-party-component-register.md`). The CSP has `font-src 'self' data:`.
- **CSP** (`apps/web/next.config.ts:47`): `default-src 'self'`, with no `frame-src`, so no iframe loads today. `style-src 'unsafe-inline'` is allowed, so inline custom properties work.
- **Quality tooling:** `tests/e2e/helpers.ts` has `expectAccessible` (axe, WCAG 2.2 AA tags) and `fitsViewport`. `tests/e2e/profile.visual.spec.ts` has Linux and Darwin snapshots, and Linux is the authority. `tests/e2e-perf/lcp.spec.ts` checks `/@tobi` LCP < 2000 ms with 4× CPU slowdown on Fast 3G (`pnpm perf:lab`, lab only). `scripts/web-bundle.test.mjs` scans the built `.next` output. Unit tests: `node --test test/*.test.mjs` in `packages/contracts` and `apps/web`.
- **Not built:** profile sections (ProAdditions §6), early access registry (Pro additions §5).

---

## Owner rulings (defaults): CHANGEABLE

The owner has not answered the 12 questions on the canvas note `studioquestions` (12 Nov). Each default below is what the build uses until the owner says otherwise. Every value is one constant in `packages/contracts/src/studio-limits.ts` or the font registry, so a change is a one-line edit plus its test.

| #   | Question            | Default used by this plan                                                                                                                                                                                                                                                  | vs. first draft                                              |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Colours             | 1 main + 1 optional second colour, any `#rrggbb`. Mode: Light page, Dark page, or Follow the visitor (`auto`: both palettes, chosen by `prefers-color-scheme`).                                                                                                            | **Changed** (was 8 palettes × 3 accents, no picker)          |
| 2   | Fonts               | The 14-family library below. At most 2 families per page, one heading and one text. Display faces are headings-only.                                                                                                                                                       | **Changed** (was 3 pairs)                                    |
| 3   | Limits              | Rows **12**; columns per row **≤ 3**; blocks per column **≤ 3**; blocks per page **≤ 40**; photos per Gallery **9**; photos per page **24** (cap on stored images **48**, draft + published); videos per page **3**; events **6**; services **12**. Text limits in Task 3. | **Changed** (was 8 sections, 6 photos, 4 events, 8 services) |
| 4   | Video sites         | **YouTube** (`www.youtube-nocookie.com`), **TikTok**, **Audiomack**. Instagram is not embedded (its embed needs Instagram's script on our page).                                                                                                                           | Kept                                                         |
| 5   | Broken-video check  | **Yes, server-side only.** The API asks the site's public oEmbed endpoint whether a video exists, at save and at publish. The visitor's browser never does. Behind `STUDIO_VIDEO_VERIFY` (default on).                                                                     | **New**                                                      |
| 6   | Page-weight budget  | **1.5 MB** first load on a 390 px phone (HTML + CSS + script + fonts + photos in the first 1.5 screens). Photos lower down load lazily, by rule.                                                                                                                           | **New**                                                      |
| 7   | Services and prices | Whole naira, price required, optional "from". No booking, no paying for a service. A fixed line that can't be removed: "Prices are for information. Tips here are thanks."                                                                                                 | Kept                                                         |
| 8   | Free                | Teaser + unpublished preview only (the whole editor on an in-memory draft).                                                                                                                                                                                                | Kept                                                         |
| 9   | Gallery moderation  | "Report this page" plus staff can view and remove any one photo with `pages.suspend`. No pre-publication queue.                                                                                                                                                            | Kept                                                         |
| 10  | Supporter wall      | Needs a second, separate yes, asked on the tip form. Built last (Task 13), behind its own switch.                                                                                                                                                                          | Kept                                                         |
| 11  | Events              | Text only, no ticket links in release 1.                                                                                                                                                                                                                                   | Kept                                                         |
| 12  | Override            | A failing design check blocks publishing. There is no "publish anyway", for staff too.                                                                                                                                                                                     | **New**                                                      |

Also kept from the first draft: the name **"Page Studio"**; Page Studio **replaces ProAdditions §6**. Later (not in this plan): custom domain; block view analytics (waits on D-07); a real-browser render check at publish (see "Publish-time validation" below).

**Font library default (14 families, all SIL OFL 1.1, self-hosted woff2):**

| id                    | Family              | Category | Roles         | Notes                                                           |
| --------------------- | ------------------- | -------- | ------------- | --------------------------------------------------------------- |
| `manrope`             | Manrope             | sans     | heading, body | shipped today                                                   |
| `dm-serif-display`    | DM Serif Display    | display  | heading       | shipped today; lacks Ọ/Ẹ, so it uses the word fallback (Task 2) |
| `inter`               | Inter               | sans     | heading, body |                                                                 |
| `ibm-plex-sans`       | IBM Plex Sans       | sans     | heading, body |                                                                 |
| `work-sans`           | Work Sans           | sans     | heading, body |                                                                 |
| `space-grotesk`       | Space Grotesk       | sans     | heading       |                                                                 |
| `bricolage-grotesque` | Bricolage Grotesque | display  | heading       |                                                                 |
| `outfit`              | Outfit              | sans     | heading, body |                                                                 |
| `nunito`              | Nunito              | rounded  | heading, body |                                                                 |
| `fraunces`            | Fraunces            | serif    | heading       |                                                                 |
| `playfair-display`    | Playfair Display    | display  | heading       |                                                                 |
| `lora`                | Lora                | serif    | heading, body |                                                                 |
| `source-serif-4`      | Source Serif 4      | serif    | heading, body |                                                                 |
| `libre-baskerville`   | Libre Baskerville   | serif    | heading, body |                                                                 |

A family joins only if its subset passes the coverage test (Task 2). **A body font must draw every required character.** A heading font may miss the Latin Extended Additional letters only if it is marked `wordFallback: true`. If a family fails, it is dropped and the table shrinks. The PR records which families made it.

---

## Global Constraints

Every task's requirements include all of these.

- **Guardrails, not presets.** People choose freely, but only through typed choices: brand hex colours, registry ids, enum steps, user text, kobo strings, dates and TipMe image ids. No stored field is a CSS length, position, size, font name, URL to an image, or raw style. Brand colours never reach CSS. Only engine-derived tokens do.
- **Colour:** every rendered text/background pair meets WCAG 2.x AA: **4.5:1 for body text, 3:1 for large text (≥24px, or ≥18.66px bold) and for UI components, borders that identify controls, and focus indicators**. This holds in light and dark. The engine guarantees it, the design check re-verifies it, and property tests prove it over random colours. A brand colour that can't carry text is used only as an accent, and the editor says so in one sentence (copy in Task 9).
- **Fonts:** at most 2 families per page. Self-hosted woff2 in `apps/web/public/fonts/studio/` with each licence beside it. No third-party font request. A page emits `@font-face` only for its own families (≤ 2 families, ≤ 4 files, ≤ 200 KB fonts total). Each family has a metric-matched fallback (`size-adjust`, `ascent-override`, `descent-override`), so the font swap stays within the CLS ≤ 0.05 target.
- **Sizes and spacing:** from `studioTypeScale(step)` and fixed spacing steps only. Every size is a `clamp(min, fluid, max)`. Body text is never below 16px, small text never below 13px, and body measure is at most 68ch.
- **Layout:** rows on a 12-column grid. Columns are `1`, `1-1`, `2-1`, `1-2` or `1-1-1`. Every row is one column below 768px (reading order: left column first). `1-1-1` is two columns from 768 to 1023px. No absolute positioning, no free sizes, no overlap. The tip block sits in the right rail at ≥1024px and straight after the identity below that.
- **Images:** only through `readUpload` + re-encode (metadata stripped). Smart crop around a focal point, per shape. Sources below the minimum (after rotation) are refused with `IMAGE_TOO_SMALL`. Whenever text sits on a photo, the renderer always adds `STUDIO_SCRIM`, and the scrim's worst case (a white photo) is tested.
- **Design check:** one implementation (`checkDesign` in contracts), used by the editor, the API and publish. **Publish is refused (`STUDIO_DESIGN_CHECK_FAILED`, 422) while any error remains.** The server's result is the authority. `DESIGN_CHECK_VERSION` is stamped on every published version.
- **Locked and untouchable:** the tip block (`aside.tip-instrument` and everything in it), the fee line, the Pro badge position, "Report this page", Privacy, Terms, "Learn about this preview", the closed/not-ready/pilot states, and name + photo + handle at the top. The heading font may style the name. Studio custom properties are namespaced `--studio-*`. `.studio-fixed` resets them, and nothing inside the tip block reads them.
- **No custom HTML/CSS/JS anywhere.** All user text is rendered as React text. No `dangerouslySetInnerHTML` under `components/studio/` (a source test greps for it). Text is cleaned of control and bidi-override characters on write.
- **Video:** click-to-load embeds from `STUDIO_VIDEO_SITES` only. No third-party request before the visitor taps: no iframe, no thumbnail, no preconnect. `frame-src` lists exactly the embed origins.
- **Performance:** lab LCP < 2000 ms on the `lcp.spec.ts` throttle for each curated example. Script bytes no more than the standard page's **+ 3 KB** (the video island). Page weight within the Rule 6 budget, enforced by the design check and measured in CI.
- **Testing:** property-based tests over random designs replace exhaustive combination testing (see "Testing approach"). Linux CI is the authority for render tests and screenshots.
- **Pro lapse:** the standard page shows from the moment `plan` turns free. Draft, published version and images are kept. When Pro resumes, the published version is re-checked (Task 12). Links and QR codes never change.
- **Switch:** `PAGE_STUDIO_ENABLED` (API config `flag`): default off in production, on in development, e2e and staging. Off means `studio` is never sent, and the Studio API answers 404.
- **Copy:** pronoun "they"; the payment provider is "our payment partner"; never imply regulatory approval (`docs/00-DECISIONS.md`); board copy is used verbatim where the board gives copy.
- **Process:** migrations only via drizzle-kit. Regenerate OpenAPI (`pnpm api:openapi`) and docs (`pnpm docs:generate`) once per API-changing PR; their `--check` must pass. API-changing PRs land in sequence or in one train (`docs/runbooks/merge-trains.md`). Test-first: every behaviour change gets a test watched red, then green. Never edit `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`.

## Testing approach (replaces the 144-combination matrix)

Free choice makes the design space effectively infinite, so the build tests the **rules**, not the designs.

1. **Property-based unit tests** (`fast-check`, `node --test`, contracts). For thousands of random inputs: any brand hex × mode gives a palette where every required pair passes (Task 1); any generated document either fails the schema or resolves to a valid one (Task 3); `resolveStudio` never throws and is idempotent (Task 3); every fix the check offers removes its issue and adds no new error (Task 4); for documents whose check passes, the predicted layout fits every breakpoint (Task 4). CI runs 2,000 cases per property, and locally `STUDIO_PBT_RUNS=200`. The seed comes from `GITHUB_SHA` (reproducible per commit) and is printed on failure with the shrunk counterexample. Every counterexample found is added to `packages/contracts/test/fixtures/studio-regressions.json`, which replays on every run.
2. **Property-based render tests** (Playwright, Linux CI, Task 6). Random documents from the same generator are rendered by the real renderer through a dev-only harness at 320, 390, 768, 1024 and 1440px. Each run checks no horizontal overflow, no clipped text, no overlapping blocks, and a computed contrast walk (light and dark). 150 documents per CI run on one shard (budget ≤ 4 min, and the test fails at 6 min so it can't quietly grow). axe runs on 20 of them.
3. **Publish-time validation** (Task 7). `publishStudio` re-parses, resolves and runs `checkDesign` on the saved document with server facts: real image sizes, video status, font file sizes. This is deterministic. A real-browser render at publish is **not** in release 1: the worker has no browser, and a headless browser per publish costs about 300 MB RAM and 2–4 s. It is listed under "Later", with the property render tests as the evidence it isn't needed.
4. **Curated examples in CI** (Task 6): the three board examples (Kemi, Sule, Ify), `max` (every limit), `min`, `empty`, `hostile` (60-char unbroken words, emoji, RTL and Yoruba names, bidi override), and a font specimen page (each of the 14 families as heading and, where allowed, as body). These get axe and overflow checks at all five widths, plus **6 Linux screenshots** (the three examples at 390 and 1440).
5. **Performance budget** (Task 8): LCP per example, a script-byte delta, font files requested per page, and page weight measured against the check's estimate (the estimate must sit within ±15% of measured transfer, so the check stays honest).

## Review Focus

Failure modes the boards imply but don't draw. Each names its pinning test, added to the owning task.

1. **A stored document that a registry change has made invalid** (a font retired, a limit lowered, a new check rule). Expected: the page still renders. `resolveStudio` swaps retired ids for defaults and trims extras. If the resolved page fails the check, the public page shows the **standard** page and the editor lists the fixes. Never a 500, never a failing design served. _Test:_ `a published page that fails a newer check falls back to the standard page` (Task 7).
2. **Editor and server disagree on the check** (a client bundle older than the API's `DESIGN_CHECK_VERSION`). Expected: publish answers 422 with the server's issues, and the editor shows those. _Test:_ `the server's issues win over the client's` (Task 7) and the editor e2e (Task 9).
3. **Two tabs editing one draft.** Expected: `STUDIO_DRAFT_STALE` (409) and the "changed elsewhere" notice. Nothing is silently overwritten. _Test:_ `a save with an old rev is refused and keeps the newer draft` (Task 7).
4. **Pro ends mid-edit or between save and publish.** Expected: `PRO_REQUIRED`, the draft is kept, and the editor becomes read-only. _Test:_ `publish after Pro ended is refused and the draft is kept` (Task 7).
5. **Brand colours at the extremes** (`#000000`, `#ffffff`, pure `#ffff00`, mid grey `#777777`, out-of-gamut-adjacent saturated hues). Expected: a passing palette every time, with the accent-only note where needed. _Test:_ the named edge cases in Task 1 plus the property.
6. **Hostile text** at 320px in every block variant. Expected: it wraps, nothing overflows, and override characters are stripped. _Test:_ the `hostile` example (Task 6) and `studio text is cleaned of control and bidi characters` (Task 3).
7. **Unreferenced images** (removed from the draft, draft discarded). Expected: deleted after the DB change, never while the published version uses them. _Test:_ `discard and publish remove unreferenced images only` (Task 7).

---

## Delivery order (PRs) and parallel work

| PR  | Tasks                                                       | Touches API?   | Order                                                               |
| --- | ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| A   | 1: colour engine                                            | No (contracts) | First. **Parallel with B**                                          |
| B   | 2: type scale + font library (registry + assets)            | No             | First. **Parallel with A**                                          |
| C   | 3, 4: document model + design check                         | No (contracts) | After A and B                                                       |
| D   | 5, 6: renderer, render property tests, examples             | No (web)       | After C. **Parallel with E**                                        |
| E   | 7: storage, operations, API, crops, video verify            | **Yes**        | After C. **Parallel with D**                                        |
| F   | 8: public page wiring + performance budget                  | No             | After D and E                                                       |
| G1  | 9a: editor shell, Style tab, check panel                    | No             | After F                                                             |
| G2  | 9b: Blocks tab (rows, columns, blocks, reorder)             | No             | After G1                                                            |
| G3  | 9c: publish gate, undo, Free preview, lapsed                | No             | After G2                                                            |
| H   | 10: media (gallery, focal point, video form, CSP)           | No             | After G2. **Parallel with G3** if it stays out of G3's files        |
| I   | 11: Studio fonts in the editor preview + font picker polish | No             | After G1. **Parallel with G2/G3/H** (picker files only)             |
| J   | 12: lapse journey + runbook                                 | No             | After G3                                                            |
| K   | 13: supporter wall                                          | **Yes**        | Last. After E in sequence, or in a train with any other open API PR |

E and K regenerate OpenAPI and docs, so they never merge in parallel. A and B touch different files (`studio-colour.ts` vs `studio-type.ts` + fonts), so they can be built by two agents at once. D and E meet only at the contracts from C.

---

### Task 1: The colour engine (OKLCH, AA by construction)

**Files:**

- Create: `packages/contracts/src/studio-colour.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/package.json` (devDependency `fast-check`), `docs/third-party-component-register.md` (fast-check entry: MIT, test-only)
- Test: `packages/contracts/test/studio-colour.test.mjs`, `packages/contracts/test/support/pbt.mjs` (seed from `GITHUB_SHA`, `STUDIO_PBT_RUNS`, regression replay)
- Copy (unchanged): `docs/design/redesign/boards/StudioEditor.dc.html`, `StudioExamples.dc.html`, `StudioRules.dc.html`, `StudioLapse.dc.html`

**Interfaces:**

- Produces:
  ```ts
  export type Hex = `#${string}`; // 6-digit lower-case, validated by isHex
  export function isHex(s: string): s is Hex;
  export type StudioMode = 'light' | 'dark' | 'auto';
  export interface Oklch {
    l: number;
    c: number;
    h: number;
  }
  export function hexToOklch(h: Hex): Oklch;
  export function oklchToHex(c: Oklch): Hex; // gamut-maps by reducing chroma at fixed L and h
  export function contrastRatio(a: Hex, b: Hex): number; // WCAG 2.x relative luminance
  export function blend(over: Hex, opacity: number, under: Hex): Hex;
  export const AA: { body: 4.5; large: 3; ui: 3 };
  export interface StudioTokens {
    page: Hex;
    card: Hex;
    tint: Hex;
    line: Hex;
    control: Hex; // surfaces; line is decorative, control ≥3:1
    text: Hex;
    muted: Hex;
    heading: Hex;
    link: Hex; // ≥4.5 on page, card and tint
    accent: Hex;
    accentLarge: boolean; // brand colour as used; accentLarge: only ≥24px text
    button: Hex;
    buttonText: Hex;
    focus: Hex; // buttonText ≥4.5 on button; focus ≥3 on page, card, button
    band: Hex;
    bandText: Hex; // "Colour" row background and its text (≥4.5)
    second?: { fill: Hex; onFill: Hex; text: Hex }; // the optional second colour, same rules
  }
  export type StudioColourNote =
    | { code: 'ACCENT_ONLY'; colour: 0 | 1; textShade: Hex } // can't carry text: used for fills, links use textShade
    | { code: 'LARGE_ONLY'; colour: 0 | 1; textShade: Hex } // 3–4.5:1: large headings only
    | { code: 'NEUTRAL_FALLBACK'; colour: 0 | 1 }; // hue can't be kept at a passing L (near-grey input)
  export interface StudioPalette {
    light: StudioTokens;
    dark: StudioTokens;
    notes: { light: StudioColourNote[]; dark: StudioColourNote[] };
  }
  export function deriveStudioPalette(
    brand: readonly [Hex] | readonly [Hex, Hex],
  ): StudioPalette;
  export function paletteFailures(p: StudioPalette): string[]; // "dark muted on tint 4.31 < 4.5"
  export const STUDIO_SCRIM: {
    colour: '#000000';
    opacity: 0.62;
    text: '#ffffff';
  };
  ```

**Algorithm (what the implementer builds):**

1. Convert the brand colour to OKLCH (sRGB → linear → LMS → OKLab → LCh; Björn Ottosson's matrices). Keep hue `h` and chroma `c`.
2. **Surfaces** are fixed lightness steps at the brand hue with low chroma: light `page L=0.985 c=min(c,0.012)`, `card L=1.0 c=0`, `tint L=0.955 c=min(c,0.035)`; dark `page L=0.20`, `card L=0.25`, `tint L=0.29`, chroma `min(c,0.04)`. `line` is decorative (`L=0.88` light, `0.36` dark).
3. **Every text-like token is found by search, not by fixed value.** `findShade(h, c, against: Hex[], min, direction)` binary-searches L (towards 0 in light mode, towards 1 in dark), with chroma clamped to the gamut at each L, until `contrastRatio` passes `min` against **every** listed surface. It always terminates: black or white passes at least 4.58:1 against any colour. `text` targets 7 against page/card/tint, with a floor of 4.5. `muted` takes the lightest (light mode) shade that passes 4.5. `heading` uses the brand hue at the first L passing 4.5 (so headings carry the brand where they can). `control` and `focus` use the first L passing 3 against page, card and tint.
4. **The brand colour itself:** if it passes 4.5 on page, card and tint, then `accent = link = brand`. If it passes only 3, then `accentLarge = true`, `link = findShade(…, 4.5)`, and the note is `LARGE_ONLY`. Otherwise `link = findShade(…, 4.5)`, the brand is used only as `button`/`band` fill, and the note is `ACCENT_ONLY`. `buttonText`/`bandText` is black or white, whichever passes 4.5 on the fill (one always does). If the fill takes neither to 4.5 (impossible in sRGB, but asserted), the fill is darkened with `findShade`.
5. If `c < 0.02` (a near-grey input) and no shade keeps the hue, use neutral shades and add `NEUTRAL_FALLBACK`.
6. Hex out, never `oklch()` in CSS (browser support and exact contrast arithmetic).

The pairs `paletteFailures` checks, per mode:

| foreground                            | on                                                            | minimum |
| ------------------------------------- | ------------------------------------------------------------- | ------- |
| text, muted, link, heading            | page, card, tint                                              | 4.5     |
| accent where `accentLarge`            | page, card, tint                                              | 3       |
| accent where not `accentLarge`        | page, card, tint                                              | 4.5     |
| buttonText / bandText / second.onFill | button / band / second.fill                                   | 4.5     |
| control, focus                        | page, card, tint                                              | 3       |
| focus                                 | button                                                        | 3       |
| `STUDIO_SCRIM.text`                   | `blend('#000000', 0.62, '#ffffff')` (white photo, worst case) | 4.5     |

- [ ] **Step 1: Write the failing tests**

```js
import fc from 'fast-check';
import { runs, seed } from './support/pbt.mjs';
const hex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, '0')}`);

test('any brand colour gives a palette where every pair passes AA, light and dark', () => {
  fc.assert(
    fc.property(hex, fc.option(hex, { nil: undefined }), (a, b) => {
      const p = deriveStudioPalette(b ? [a, b] : [a]);
      assert.deepEqual(paletteFailures(p), []);
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});
test('the engine is deterministic and keeps the brand hue where it can', () => {
  fc.assert(
    fc.property(hex, (a) => {
      const p1 = deriveStudioPalette([a]);
      const p2 = deriveStudioPalette([a]);
      assert.deepEqual(p1, p2);
      const { c, h } = hexToOklch(a);
      if (c >= 0.05)
        assert.ok(hueDistance(hexToOklch(p1.light.heading).h, h) <= 6);
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});
test('edge colours', () => {
  for (const a of [
    '#000000',
    '#ffffff',
    '#ffff00',
    '#777777',
    '#00ff00',
    '#0000ff',
    '#f5c400',
    '#e0457b',
  ])
    assert.deepEqual(paletteFailures(deriveStudioPalette([a])), [], a);
});
test('a yellow that cannot carry text becomes an accent with a deeper link shade', () => {
  const p = deriveStudioPalette(['#f5c400']);
  assert.equal(p.notes.light[0].code, 'ACCENT_ONLY');
  assert.ok(contrastRatio(p.light.link, p.light.page) >= 4.5);
  assert.equal(p.light.button, '#f5c400');
});
test('a pink that passes only for large text is LARGE_ONLY', () => {
  assert.equal(
    deriveStudioPalette(['#e0457b']).notes.light[0].code,
    'LARGE_ONLY',
  );
});
test('the checker catches a failing pair (not vacuous)', () => {
  const p = deriveStudioPalette(['#1d4e89']);
  p.light.muted = '#9a9a9a';
  assert.match(paletteFailures(p).join('\n'), /light muted on page/);
});
test('contrastRatio matches WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#7a32f9', '#ffffff').toFixed(2), '5.75');
});
test('OKLCH round-trips sRGB within 1 unit per channel', () => {
  /* property over hex */
});
test('the scrim keeps white text readable over a white photo', () => {
  assert.ok(contrastRatio('#ffffff', blend('#000000', 0.62, '#ffffff')) >= 4.5); // #616161: 6.19
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm install && pnpm --filter @tipme/contracts build && node --test packages/contracts/test/studio-colour.test.mjs`
Expected: FAIL (`studio-colour.js` not found)

- [ ] **Step 3: Implement `studio-colour.ts`** as above.
- [ ] **Step 4: Run them and watch them pass** (same command; then `STUDIO_PBT_RUNS=20000` once locally, and record the wall time in the PR). Then `pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck`.
- [ ] **Step 5: Copy the four boards**, unchanged, into `docs/design/redesign/boards/`.
- [ ] **Step 6: Commit**: `feat(contracts): Page Studio colour engine with AA by construction`

---

### Task 2: Type scale and the self-hosted font library

**Files:**

- Create: `packages/contracts/src/studio-type.ts`
- Create: `apps/web/public/fonts/studio/<id>-<axis|weight>.woff2` for each family + `OFL-<Family>.txt` (the two shipped families are copied from `apps/web/src/fonts/`, not re-downloaded)
- Create: `scripts/studio-fonts.mjs` (documents the exact `pyftsubset` command and source commit per family; prints sizes and sha256), `scripts/studio-fonts.test.mjs`
- Modify: `apps/web/src/lib/font-cmap.ts` (export `cmapOf(sfntTable: Uint8Array)` and add `woff2CharacterMap(bytes)`, which reads the WOFF2 table directory (UIntBase128 lengths), brotli-decompresses with `zlib.brotliDecompressSync` and slices the untransformed `cmap` table), `docs/third-party-component-register.md` (one entry per family: source repo, commit, upstream sha256, subset command, output bytes)
- Test: `packages/contracts/test/studio-type.test.mjs`

**Interfaces:**

- Produces:
  ```ts
  export type StudioFontId =
    | 'manrope'
    | 'dm-serif-display'
    | 'inter'
    | 'ibm-plex-sans'
    | 'work-sans'
    | 'space-grotesk'
    | 'bricolage-grotesque'
    | 'outfit'
    | 'nunito'
    | 'fraunces'
    | 'playfair-display'
    | 'lora'
    | 'source-serif-4'
    | 'libre-baskerville';
  export interface StudioFont {
    id: StudioFontId;
    name: string;
    category: 'sans' | 'serif' | 'rounded' | 'display';
    roles: readonly ('heading' | 'body')[];
    files: readonly {
      path: `/fonts/studio/${string}.woff2`;
      weight: `${number}` | `${number} ${number}`;
      style: 'normal';
      bytes: number;
    }[];
    headingWeight: number;
    bodyWeight?: number;
    metrics: {
      unitsPerEm: number;
      ascent: number;
      descent: number;
      lineGap: number;
      xHeight: number;
      avgAdvance: number;
      maxWordAdvance: number;
    };
    fallback: {
      family: 'Arial' | 'Georgia';
      sizeAdjust: string;
      ascentOverride: string;
      descentOverride: string;
    };
    wordFallback: boolean; // heading-only fonts missing ẹ/ọ/ṣ etc.: a heading containing one is set wholly in the body font
  }
  export const STUDIO_FONTS: readonly StudioFont[];
  export const STUDIO_REQUIRED_CODEPOINTS: readonly number[]; // Basic Latin, Latin-1, Latin Ext-A, combining 0300–036F, Ẹẹ Ọọ Ṣṣ (1EB8/9, 1ECC/D, 1E62/3), ₦ (20A6), punctuation 2000–206F
  export type StudioScaleStep = 'compact' | 'standard' | 'roomy'; // ratio 1.2 / 1.25 / 1.333
  export type StudioTextRole = 'display' | 'h2' | 'h3' | 'body' | 'small';
  export interface StudioTypeSize {
    min: number;
    max: number;
    css: string;
    lineHeight: number;
    measure: string;
  } // css = clamp(...)
  export function studioTypeScale(
    step: StudioScaleStep,
  ): Record<StudioTextRole, StudioTypeSize>;
  export const STUDIO_SPACING: {
    s: { min: 16; max: 24 };
    m: { min: 24; max: 48 };
    l: { min: 40; max: 80 };
  };
  export function fontsOk(heading: StudioFontId, body: StudioFontId): boolean; // roles allow it; ≤ 2 families (equal ids = 1 family)
  ```

Type scale rule: body is `clamp(16px, 0.95rem + 0.25vw, 18px)`. Each step up multiplies by the ratio at both ends, and the min end is capped so `display` at 320px is ≤ 40px. `small` = body ÷ ratio, never below 13px. Line height runs from 1.6 (body) down to 1.1 (display). Measure: body 68ch, headings 24ch.

- [ ] **Step 1: Write the failing tests**

```js
test('every library font draws every required character (body) or is marked wordFallback (heading-only)', () => {
  for (const f of STUDIO_FONTS) for (const file of f.files) {
    const map = woff2CharacterMap(readFileSync(`apps/web/public${file.path}`));
    const missing = STUDIO_REQUIRED_CODEPOINTS.filter((c) => !map.has(c));
    if (f.roles.includes('body')) assert.deepEqual(missing, [], `${f.id} misses ${missing.map(hexOf)}`);
    else if (missing.length) assert.ok(f.wordFallback, `${f.id} needs wordFallback`);
    assert.ok(map.has(0x20a6), `${f.id} has no ₦`);
  }
});
test('the registry bytes match the files, and no family exceeds 100 KB per file', ...);
test('every font has a licence file beside it', ...);
test('display fonts are heading-only', () => { for (const f of STUDIO_FONTS) if (f.category === 'display') assert.deepEqual(f.roles, ['heading']); });
test('type scale: body ≥ 16, small ≥ 13, display at 320px ≤ 40, steps strictly increase', () => {
  for (const step of ['compact', 'standard', 'roomy']) { const s = studioTypeScale(step); /* asserts */ }
});
test('fontsOk refuses a display font as body and allows one family for both', ...);
```

- [ ] **Step 2: Run and watch them fail**: `pnpm --filter @tipme/contracts build && node --test packages/contracts/test/studio-type.test.mjs && node --test scripts/studio-fonts.test.mjs`
- [ ] **Step 3: Implement.** Download each family from the google/fonts repo at a pinned commit, subset with `pyftsubset --flavor=woff2 --layout-features='kern,liga,calt' --unicodes=<STUDIO_REQUIRED_CODEPOINTS ranges>` (a variable font keeps its `wght` axis and is limited to the two weights used, with `fonttools varLib.instancer` where it helps), and record everything in the register. Measure metrics with fontTools and copy them into the registry. Drop any family that fails coverage as a body font.
- [ ] **Step 4: Run and watch them pass**; `pnpm --filter @tipme/web test` (font-cmap still green).
- [ ] **Step 5: Commit**: `feat: Page Studio type scale and self-hosted font library`

---

### Task 3: The Studio document: rows, columns, blocks; schema and resolver

**Files:**

- Create: `packages/contracts/src/studio-document.ts`, `packages/contracts/src/studio-limits.ts`, `packages/contracts/test/support/studio-arbitrary.mjs` (the shared fast-check generator, also imported by the Playwright render test)
- Modify: `packages/contracts/src/errors.ts` (`STUDIO_DRAFT_STALE`, `STUDIO_DESIGN_CHECK_FAILED`, `IMAGE_TOO_SMALL`, `STUDIO_IMAGE_LIMIT`), `packages/contracts/src/profiles.ts` (`PublicProfile.studio?: PublicStudio`), `index.ts`
- Test: `packages/contracts/test/studio-document.test.mjs`

**Interfaces:**

- Consumes: Tasks 1–2.
- Produces:
  ```ts
  export type StudioColumns = '1' | '1-1' | '2-1' | '1-2' | '1-1-1';
  export type StudioSpacing = 's' | 'm' | 'l';
  export type StudioRowBackground =
    'page' | 'card' | 'colour' | 'second' | { photo: string /* imageId */ };
  export type StudioBlock =
    | {
        id: string;
        kind: 'text';
        variant: 'heading' | 'paragraph' | 'lead';
        level?: 2 | 3;
        text: string;
      }
    | {
        id: string;
        kind: 'photo';
        variant: 'square' | 'wide' | 'tall' | 'circle';
        imageId: string;
        alt: string;
        decorative?: true;
        caption?: string;
      }
    | {
        id: string;
        kind: 'gallery';
        variant: 'grid' | 'strip' | 'mosaic';
        images: { imageId: string; alt: string; decorative?: true }[];
      }
    | {
        id: string;
        kind: 'video';
        variant: 'still';
        url: string;
        caption?: string;
      }
    | {
        id: string;
        kind: 'services';
        variant: 'list' | 'cards';
        items: {
          name: string;
          detail?: string;
          priceMinor: string;
          from?: true;
        }[];
      }
    | {
        id: string;
        kind: 'events';
        variant: 'list' | 'cards';
        items: {
          date: string;
          time?: string;
          title: string;
          place?: string;
          note?: string;
        }[];
      }
    | { id: string; kind: 'links'; variant: 'buttons' | 'icons' } // shows the person's existing social links; no new URLs
    | { id: string; kind: 'quote'; variant: 'plain' | 'band'; text: string }
    | { id: string; kind: 'about'; variant: 'plain' } // the bio, as today
    | { id: string; kind: 'supporters'; variant: 'names' }; // refused until Task 13
  export interface StudioRow {
    id: string;
    columns: StudioColumns;
    spacing: StudioSpacing;
    background: StudioRowBackground;
    cells: StudioBlock[][];
  } // cells.length = column count
  export interface StudioDocument {
    v: 1;
    brand: [Hex] | [Hex, Hex];
    mode: StudioMode;
    fonts: { heading: StudioFontId; body: StudioFontId };
    scale: StudioScaleStep;
    corners: 'square' | 'soft' | 'round';
    rows: StudioRow[];
  }
  export const studioDocumentSchema: z.ZodType<StudioDocument>; // strict; for writes
  export function resolveStudio(
    raw: unknown,
    today: string /* Lagos YYYY-MM-DD */,
  ): StudioDocument; // for reads; never throws
  export function defaultStudioDocument(profile: {
    bio?: string | null;
    links: number;
  }): StudioDocument; // a passing starter page
  export function cleanStudioText(s: string): string; // NFC, trim, strips C0/C1 controls, U+202A–202E, U+2066–2069
  export const STUDIO_VIDEO_SITES: readonly ['youtube', 'tiktok', 'audiomack'];
  export function parseVideoLink(
    url: string,
  ): { site: StudioVideoSite; id: string } | null;
  export function embedUrl(v: { site: StudioVideoSite; id: string }): string;
  export const STUDIO_EMBED_ORIGINS: readonly string[];
  export interface PublicStudio {
    document: StudioDocument;
    palette: StudioPalette;
    images: Record<string, { path: string; width: number; height: number }>;
    checkVersion: number;
  }
  ```
- `studio-limits.ts` (the Rule 3 defaults): `rows 12`, `blocksPerCell 3`, `blocks 40`, `galleryImages 9`, `pageImages 24`, `storedImages 48`, `videos 3`, `events 6`, `services 12`, `headingText 80`, `paragraphText 600`, `leadText 200`, `quoteText 140`, `caption 80`, `alt 140`, `serviceName 40`, `serviceDetail 60`, `eventTitle 60`, `eventPlace 60`, `eventNote 80`, `priceMaxMinor 1_000_000_000n`.

Schema rules: `cells.length` equals the column count; ids are unique `[a-z0-9]{8}`; each text field is single-line except `paragraph` (up to 3 paragraph breaks) and is counted in code points; `fontsOk(heading, body)`; brand colours `isHex`; `priceMinor` is a kobo string, a multiple of 100, between 100 and `priceMaxMinor`; event `date` is a real date; video `url` passes `parseVideoLink`; `about` and `links` at most once per page; `supporters` refused until `STUDIO_SUPPORTER_WALL`; image ids are UUIDs (ownership is checked by the operation, Task 7). The schema has no field that can carry a size, position or CSS. A strict object refuses unknown keys.

`resolveStudio` replaces retired font ids with `manrope`, an invalid brand colour with `#7a32f9`, unknown enums with the first value. It drops unknown block kinds, trims over-limit lists and rows from the end, and filters events before `today`.

- [ ] **Step 1: Write the failing tests**

```js
test('no size, position or CSS can be stored', () => {
  for (const bad of [{ ...VALID, css: 'x' }, withBlock({ kind: 'text', variant: 'heading', text: 'x', fontSize: 40 }), withRow({ x: 10 })])
    assert.equal(studioDocumentSchema.safeParse(bad).success, false);
});
test('three font families, or a display font as body, are refused', ...);
test('limits: 12 rows, 3 blocks per cell, 40 blocks, 9 photos per gallery, 24 per page, 3 videos, 6 events, 12 services', ...);
test('prices are whole naira kobo strings', ...);
test('studio text is cleaned of control and bidi characters', () => {
  assert.equal(cleanStudioText(' Hi‮evil\u0007 '), 'Hievil');
});
test('resolveStudio never throws, is idempotent and always yields a schema-valid document', () => {
  fc.assert(fc.property(fc.anything(), (g) => {
    const r = resolveStudio(g, TODAY);
    assert.equal(studioDocumentSchema.safeParse(r).success, true);
    assert.deepEqual(resolveStudio(r, TODAY), r);
  }), { numRuns: runs(2000), seed: seed() });
});
test('every generated valid document survives a JSON round trip unchanged', () => { /* studioDocument arbitrary */ });
test('resolveStudio keeps a page readable after a font is retired', ...);
test('resolveStudio hides events that have passed (Lagos date)', ...);
test('video links: only allow-listed sites; Instagram and look-alike hosts refused', () => {
  assert.deepEqual(parseVideoLink('https://youtu.be/dQw4w9WgXcQ'), { site: 'youtube', id: 'dQw4w9WgXcQ' });
  assert.equal(parseVideoLink('https://www.instagram.com/reel/abc/'), null);
  assert.equal(parseVideoLink('https://youtube.com.evil.example/watch?v=x'), null);
});
```

`studio-arbitrary.mjs` exports `studioDocument({ valid: boolean })`. It generates random brand colours, any font pair `fontsOk` allows, random rows/columns/blocks up to the limits, text lengths from empty to the limit (biased to the limit, with long unbroken words, emoji, RTL and Yoruba strings), and image facts (random source sizes) for the check's context.

- [ ] **Step 2: Run them and watch them fail**: `pnpm --filter @tipme/contracts build && node --test packages/contracts/test/studio-document.test.mjs`
- [ ] **Step 3: Implement** `studio-document.ts`, `studio-limits.ts` and the contract additions. TikTok ids are numeric from `/@user/video/<id>`. Audiomack takes `/<artist>/song/<slug>` and embeds at `https://audiomack.com/embed/<artist>/song/<slug>`.
- [ ] **Step 4: Run and watch them pass**, then `pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck`.
- [ ] **Step 5: Commit**: `feat(contracts): Page Studio grid and block document, schema and resolver`

---

### Task 4: The design check (one engine for editor, API and publish)

**Files:**

- Create: `packages/contracts/src/studio-check.ts`, `packages/contracts/src/studio-layout.ts` (the deterministic layout model)
- Modify: `index.ts`
- Test: `packages/contracts/test/studio-check.test.mjs`

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export const DESIGN_CHECK_VERSION: number; // bump when a rule changes; stamped on publish
  export type StudioRuleId =
    | 'contrast'
    | 'contrast-on-photo'
    | 'phone-fit'
    | 'long-word'
    | 'fonts'
    | 'heading-order'
    | 'crowded'
    | 'photo-resolution'
    | 'photo-alt'
    | 'page-weight'
    | 'empty-block'
    | 'broken-video'
    | 'missing-links';
  export interface StudioCheckContext {
    images: Record<
      string,
      { width: number; height: number; bytes: { [rendition: string]: number } }
    >; // server facts
    videos: Record<string, 'ok' | 'gone' | 'unknown'>; // by url; 'unknown' never fails (verify is best effort)
    profile: { bio: boolean; links: number };
  }
  export interface StudioFix {
    id: string;
    label: string;
  } // label is the board's button copy, e.g. "Make the photo smaller"
  export interface StudioIssue {
    rule: StudioRuleId;
    severity: 'error';
    at: { row: string; block?: string };
    message: string;
    fixes: StudioFix[];
  }
  export interface StudioNotice {
    rule: StudioRuleId;
    message: string;
  } // "Fixed for you": corrections the renderer applies
  export interface StudioCheckResult {
    version: number;
    issues: StudioIssue[];
    notices: StudioNotice[];
    passing: StudioRuleId[];
    weightBytes: number;
  }
  export function checkDesign(
    doc: StudioDocument,
    ctx: StudioCheckContext,
  ): StudioCheckResult;
  export function applyStudioFix(
    doc: StudioDocument,
    issue: StudioIssue,
    fixId: string,
  ): StudioDocument; // pure
  // studio-layout.ts
  export const STUDIO_BREAKPOINTS: readonly [320, 390, 768, 1024, 1440];
  export function cellWidths(
    doc: StudioDocument,
    viewport: number,
  ): Record<string, number>; // css px per cell, after reflow rules
  export const BLOCK_MIN_WIDTH: Record<
    `${StudioBlock['kind']}:${string}`,
    number
  >; // e.g. 'services:cards' 220
  ```

The rules (copy is plain and comes from the board; each fix is a pure transform):

| Rule                | Error when                                                                                                                                                            | Fixes                                                                            | Notice instead when                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `contrast`          | `paletteFailures` non-empty (unreachable by construction; fail-safe)                                                                                                  | "Use the suggested colours" (re-derive)                                          | `ACCENT_ONLY` / `LARGE_ONLY` notes                                |
| `contrast-on-photo` | accent-coloured text on a photo row fails against the scrim's worst case for its size                                                                                 | "Use white text"                                                                 | always: "Added a shade behind the words on the photo"             |
| `phone-fit`         | any block's `BLOCK_MIN_WIDTH` > its cell width at any breakpoint after reflow                                                                                         | "Use the list style", "Use 2 columns"                                            |                                                                   |
| `long-word`         | a word's estimated advance (`metrics.maxWordAdvance` × size at 320px) exceeds its cell, so it would break mid-word                                                    | "Use a smaller heading" (h2 → h3, lead → paragraph)                              |                                                                   |
| `fonts`             | not `fontsOk` (unreachable via schema)                                                                                                                                | "Use one font for both"                                                          | a heading with a `wordFallback` letter: "Set in your text font"   |
| `heading-order`     | an h3 before any h2 on the page                                                                                                                                       | "Make it a main heading"                                                         |                                                                   |
| `crowded`           | a cell's weight (photo 1, gallery 1 + 0.25/photo, list block 1 + 0.2/item, text 0.5) ÷ its column fraction > 6, or two adjacent `colour` rows at spacing `s`          | "Split into two rows", "Use more space"                                          |                                                                   |
| `photo-resolution`  | source width < 1.0 × the slot's largest CSS width (at 1440, after the shape's crop)                                                                                   | "Make the photo smaller" (narrower column or a smaller variant), "Replace photo" |                                                                   |
| `photo-alt`         | a non-decorative photo has empty `alt`                                                                                                                                | "Mark as decorative", "Add a description" (focuses the field)                    |                                                                   |
| `page-weight`       | estimated first-load bytes on a 390px phone (HTML + CSS + script constants, the font files used, photos in the first 1.5 screens at their chosen renditions) > 1.5 MB | "Use one font family", "Move the gallery lower"                                  |                                                                   |
| `empty-block`       | a block with no content (gallery without photos, services without items, links with 0 links, about with no bio)                                                       | "Remove the block"                                                               |                                                                   |
| `broken-video`      | `ctx.videos[url] === 'gone'`                                                                                                                                          | "Remove the video", "Change the link"                                            |                                                                   |
| `missing-links`     | never an error                                                                                                                                                        |                                                                                  | a Links block reads the live social links, so removed ones vanish |

- [ ] **Step 1: Write the failing tests**

```js
test('each rule fires on its minimal bad example and is silent on the curated good examples', ...); // KEMI, SULE, IFY fixtures pass
test('every offered fix removes its issue and adds no new error', () => {
  fc.assert(fc.property(studioDocument({ valid: true }), checkContext(), (doc, ctx) => {
    for (const issue of checkDesign(doc, ctx).issues) for (const f of issue.fixes) {
      if (f.id === 'replace-photo' || f.id === 'change-link' || f.id === 'add-description') continue; // need input
      const next = applyStudioFix(doc, issue, f.id);
      assert.equal(studioDocumentSchema.safeParse(next).success, true);
      const after = checkDesign(next, ctx);
      assert.ok(!after.issues.some((i) => sameIssue(i, issue)));
      assert.ok(after.issues.length <= checkDesign(doc, ctx).issues.length);
    }
  }), { numRuns: runs(2000), seed: seed() });
});
test('repeatedly applying the first automatic fix reaches a passing page or only input-needing issues', ...);
test('a passing document fits every breakpoint in the layout model', () => {
  fc.assert(fc.property(studioDocument({ valid: true }), checkContext(), (doc, ctx) => {
    if (checkDesign(doc, ctx).issues.length) return;
    for (const w of STUDIO_BREAKPOINTS) for (const [cell, width] of Object.entries(cellWidths(doc, w)))
      for (const b of blocksIn(doc, cell)) assert.ok(BLOCK_MIN_WIDTH[`${b.kind}:${b.variant}`] <= width);
  }), { numRuns: runs(2000), seed: seed() });
});
test('checkDesign is pure and deterministic', ...);
test('a photo 640 wide in a 2-1 wide cell fails; the same photo in a 1-1 cell passes', ...);
test('the weight estimate counts only photos in the first 1.5 screens and only the fonts used', ...);
```

- [ ] **Step 2: Run and watch them fail**: `pnpm --filter @tipme/contracts build && node --test packages/contracts/test/studio-check.test.mjs`
- [ ] **Step 3: Implement** the layout model (12-column math with the CSS's own gaps and paddings, which Task 5 imports from the same constants) and the rules.
- [ ] **Step 4: Run and watch them pass**; contracts test + typecheck.
- [ ] **Step 5: Commit**: `feat(contracts): Page Studio design check with one-click fixes`

---

### Task 5: The renderer (web, no API)

**Files:**

- Create: `apps/web/src/components/studio/studio-page.tsx` (server component), `studio-row.tsx`, `studio-blocks.tsx` (one component per kind × variant), `studio-theme.ts`, `studio-fonts.tsx` (emits `@font-face` for the page's families + metric fallbacks, and one `<link rel="preload">` for the heading file), `studio.css`, `video-embed.tsx` (the only `'use client'` file)
- Test: `apps/web/test/studio-theme.test.mjs`, `scripts/studio-source.test.mjs`

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces:
  ```ts
  export function studioStyle(
    doc: StudioDocument,
    palette: StudioPalette,
  ): Record<`--studio-${string}`, string>; // colours (light; dark under [data-mode]), type sizes, spacing, radii
  export function StudioPage(props: {
    studio: PublicStudio;
    profile: PublicProfile;
    identity: React.ReactNode;
    cover: React.ReactNode;
    tipBlock: React.ReactNode;
    footer: React.ReactNode; // today's, unchanged
  }): JSX.Element;
  ```

Rendering rules:

- Root: `<div className="studio" data-mode={mode} data-corners={…} style={studioStyle(doc, palette)}>`. For `auto`, both token sets are emitted, and `@media (prefers-color-scheme: dark)` swaps them. The tip block and footer render inside `<div className="studio-fixed">`, which resets every `--studio-*` to `initial` and uses only `@tipme/ui` tokens.
- `studio.css` holds the grid. Rows are `display:grid; grid-template-columns: repeat(12, minmax(0,1fr))`, with span classes per `data-columns`. Reflow uses the same breakpoints and gaps as `studio-layout.ts`; both import `STUDIO_GRID` constants, so the model and the CSS cannot drift (a source test asserts the numbers match).
- Every user-text element gets `overflow-wrap: anywhere; min-width: 0`. Body is `max-inline-size: 68ch`.
- Text on photos is always inside `.studio-scrim`.
- Images: `<img>` with `srcset` from TipMe renditions, `sizes` from the cell width model, `loading="lazy"` for everything after the first 1.5 screens, explicit `width`/`height` (CLS).
- Headings: `text` blocks render `h2`/`h3`. A heading containing a character its `wordFallback` font lacks gets the body font (decided on the server with the font's cmap list from the registry).
- An empty block renders nothing (the check already refuses to publish one; this is the read-side safety net).
- Video: TipMe-drawn still; on activation, the iframe with `sandbox="allow-scripts allow-same-origin allow-presentation"`, `referrerPolicy="strict-origin"`.

- [ ] **Step 1: Write the failing tests**

```js
test('studioStyle sets only --studio-* properties, all derived from the palette and scale', ...);
test('auto mode emits both token sets', ...);
test('the grid CSS and the layout model use the same constants', () => { /* parse studio.css custom media + gaps; compare STUDIO_GRID */ });
test('no studio component renders raw HTML or builds a style from user content', ...);
test('studio.css never styles inside the tip block', ...);
test('studio-fonts emits @font-face only for the page\'s families', ...);
```

- [ ] **Step 2–4:** fail (`pnpm --filter @tipme/web test`, `node --test scripts/studio-source.test.mjs`), implement, pass; `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`.
- [ ] **Step 5: Commit**: `feat(web): Page Studio renderer on the 12-column grid around the fixed tip block`

---

### Task 6: Render property tests and the curated examples

**Files:**

- Create: `apps/web/src/app/dev/studio-lab/page.tsx` (harness; `notFound()` in production unless `NEXT_PUBLIC_STUDIO_LAB === 'on'`, which `scripts/build-e2e.mjs` sets; `robots` noindex). It takes `?doc=<base64url deflate-raw JSON>` (decoded with `node:zlib` on the server, ≤ 12 KB) or `?example=<name>`, plus `&mode=light|dark`.
- Create: `apps/web/src/app/dev/studio-lab/examples.ts` (`kemi`, `sule`, `ify` from the board, plus `max`, `min`, `empty`, `hostile`, `fonts`)
- Create: `tests/e2e/studio-lab.spec.ts` (properties), `tests/e2e/studio-examples.spec.ts`, `tests/e2e/studio-examples.visual.spec.ts` (+ `-snapshots/`, Linux authoritative), `tests/e2e/studio-probes.ts` (`geometryProblems`, `contrastProblems`)
- Modify: `scripts/build-e2e.mjs`, the CI e2e shard config (the lab spec gets its own shard)

**Interfaces:** consumes `StudioPage` and the arbitrary from Task 3; produces nothing for later tasks.

- [ ] **Step 1: Write the failing specs**

```ts
test('random Studio pages that pass the check render cleanly at 320–1440px, light and dark', async ({ page }) => {
  test.setTimeout(360_000);
  await fc.assert(fc.asyncProperty(studioDocument({ valid: true }), checkContext(), async (doc, ctx) => {
    fc.pre(checkDesign(doc, ctx).issues.length === 0);
    for (const mode of ['light', 'dark'] as const) {
      await page.goto(`/dev/studio-lab?doc=${encodeDoc(doc)}&mode=${mode}`);
      await page.evaluate(() => document.fonts.ready);
      for (const width of STUDIO_BREAKPOINTS) {
        await page.setViewportSize({ width, height: 900 });
        expect(await geometryProblems(page)).toEqual([]);
        if (width === 320 || width === 1440) expect(await contrastProblems(page)).toEqual([]);
      }
    }
  }), { numRuns: Number(process.env.STUDIO_RENDER_RUNS ?? 150), seed: seed(), interruptAfterTimeLimit: 330_000 });
});
test('axe is clean on 20 random passing pages', ...);
for (const name of EXAMPLES) test(`example ${name}: axe and overflow at every width`, ...);
test('the tip block is identical on every example', ...); // computed styles of heading, presets, submit, fee line
```

`geometryProblems` returns labels for `documentElement.scrollWidth > documentElement.clientWidth`, any element under `.studio` whose `scrollWidth > clientWidth + 1` where overflow isn't visible, clipped text (`scrollHeight > clientHeight + 1` with `overflow: hidden`), and any two block boxes that intersect. `contrastProblems` walks text nodes, takes the computed colour and the first opaque ancestor background (inside `.studio-scrim`, the scrim's worst case), and applies 4.5 or 3 by computed size and weight. A failure prints the seed and the shrunk document, and the test saves the document to `test-results/studio-counterexample.json` for the regression file.

- [ ] **Step 2: Run and watch them fail** on your lane: `rm -rf apps/web/.next && TURBO_FORCE=true node scripts/build-e2e.mjs && node scripts/prepare-e2e-database.mjs && E2E_LANE=<n> STUDIO_RENDER_RUNS=30 pnpm exec playwright test tests/e2e/studio-lab.spec.ts tests/e2e/studio-examples.spec.ts --workers=2` (FAIL: 404 on the harness)
- [ ] **Step 3: Implement** the harness and examples.
- [ ] **Step 4: Fix what it finds.** A render failure on a passing document is a bug in the **check, the layout model or the CSS**, never in the test. Fix the rule (so the check catches it) or the CSS (so it can't happen), and add the counterexample to `studio-regressions.json`. Run until PASS, and record wall time per spec in the PR.
- [ ] **Step 5: Linux snapshots** via `scripts/e2e-linux.sh` for `studio-examples.visual.spec.ts` (6 images: Kemi, Sule and Ify at 390 and 1440). Keep Darwin too if the repo keeps both (it does for `profile.visual`).
- [ ] **Step 6: Commit**: `test(web): property-based render checks and curated Page Studio examples`

---

### Task 7: Storage, operations, API, crops and video verification

**Files:**

- Modify: `packages/database/src/schema.ts` (two tables), migration via `pnpm --filter @tipme/database exec drizzle-kit generate --name page_studio`
- Create: `packages/database/src/operations/studio.ts`
- Modify: `packages/database/src/operations/profiles.ts` (`publicProfile` gains `options.studio?: boolean`), `operations/page-moderation.ts` (`OpsPageImage` gains `'studio'` with an `imageId`), `packages/database/src/index.ts`
- Create: `apps/api/src/studio/studio.controller.ts`, `studio.module.ts`, `studio-crops.ts`, `video-verify.ts`
- Modify: `apps/api/src/config.ts` (`PAGE_STUDIO_ENABLED`, `STUDIO_VIDEO_VERIFY`: flags), `apps/api/src/profiles/public-profile.controller.ts`, `apps/api/src/checkout/rate-limit.guard.ts` (bucket `studio_drafts` 60/min; images reuse `avatars`), `apps/api/src/app.module.ts`, `deploy/*.env.example`
- Regenerate: `pnpm api:openapi`, `pnpm docs:generate` (both `--check` clean)
- Test: `tests/integration/studio.test.mjs` (private template), `apps/api/test/studio.controller.test.ts`, `apps/api/test/studio-crops.test.ts`, `apps/api/test/video-verify.test.ts`

**Interfaces:**

- Consumes: Tasks 1–4; `myPageId`, `lockLivePage`, `removeObjects`, `PhotoStore`, `readUpload`, `withSlot`, `sendImage`, `sendPrivateImage`.
- Produces:
  ```ts
  // schema
  page_studios(profile_id uuid PK → profiles, draft jsonb NOT NULL, published jsonb NULL, published_check_version integer NULL,
               rev integer NOT NULL DEFAULT 0, published_at timestamptz NULL, updated_at timestamptz NOT NULL DEFAULT now())
  studio_images(id uuid PK, profile_id uuid → profiles, version integer NOT NULL, width integer NOT NULL, height integer NOT NULL,
                focal_x smallint NOT NULL DEFAULT 50 CHECK 0–100, focal_y smallint NOT NULL DEFAULT 50 CHECK 0–100,
                renditions jsonb NOT NULL,  -- { "<shape>-<w>": { key?: text, bytes: int } }, server-written only
                master_bytes bytea, master_key text, created_at)  -- master: exactly one place, as profile_covers_one_place
  studio_video_checks(url text PK, status text NOT NULL CHECK in ('ok','gone','unknown'), checked_at timestamptz NOT NULL)
  // operations
  export interface MyStudio { draft: StudioDocument; published: StudioDocument | null; rev: number; publishedAt: string | null;
    check: StudioCheckResult; context: StudioCheckContext; images: { imageId: string; path: string; width: number; height: number; focalX: number; focalY: number }[];
    access: 'edit' | 'preview' | 'lapsed' }
  export function getMyStudio(db, userId, today): Promise<MyStudio>;
  export function saveStudioDraft(db, userId, input: { rev: number; draft: StudioDocument }): Promise<MyStudio>;  // STUDIO_DRAFT_STALE, PRO_REQUIRED
  export function publishStudio(db, userId, input: { rev: number }, store?): Promise<{ studio: MyStudio; handle: string }>; // STUDIO_DESIGN_CHECK_FAILED with issues
  export function discardStudioDraft(db, userId, store?): Promise<MyStudio>;
  export function addStudioImage(db, userId, image: { master: Buffer; width: number; height: number; renditions: Record<string, Buffer> }, store?): Promise<MyStudio>; // STUDIO_IMAGE_LIMIT
  export function setStudioFocus(db, userId, input: { imageId; focalX; focalY; renditions }, store?): Promise<MyStudio>;
  ```
- API (all `SessionGuard`; writes add `CsrfGuard`; 404 when the switch is off): `GET /v1/me/studio`; `PUT /v1/me/studio/draft` `{ rev, draft }`; `POST /v1/me/studio/publish` `{ rev }` (422 `STUDIO_DESIGN_CHECK_FAILED` with `{ issues }`; on success, revalidate + `profile.changed`); `DELETE /v1/me/studio/draft`; `POST /v1/me/studio/images`; `PUT /v1/me/studio/images/:imageId/focus`; `GET /v1/me/studio-images/:imageId/:file` (owner, no-store); `GET /v1/studio-images/:profileId/:imageId/:file` (public; only for a live Pro page whose **published** version uses it).
- `studio-crops.ts`: `masterOf(input)` (rotate, fit inside 2400×2400, WebP; refuses `IMAGE_TOO_SMALL` below 600 px on the short side after rotation) and `renditionsOf(master, focalX, focalY)`. That makes each shape (`square`, `wide` 16:9, `tall` 4:5, `strip` 3.73:1) at widths 480/960/1440, never upscaled, each the largest rectangle of that aspect around the focal point, clamped inside the master.
- `video-verify.ts`: `verifyVideo(url): Promise<'ok' | 'gone' | 'unknown'>` calls the site's public oEmbed endpoint from the server (YouTube `https://www.youtube.com/oembed?url=…`, TikTok `https://www.tiktok.com/oembed?url=…`, Audiomack's oEmbed). 404/401 → `gone`; a timeout (3 s) or 5xx → `unknown` (never fails the check). It sends no cookie and no user data. Results are cached 24 h in `studio_video_checks`. It runs at save (async, best effort) and at publish (awaited, 3 s cap).

Rules:

- Every write locks the page, checks `plan = 'pro'`, and repeats `eq(profiles.plan,'pro')` in the guard. Free → `access: 'preview'`: `defaultStudioDocument(...)`, nothing stored. Stored rows + Free → `access: 'lapsed'`, writes refused `PRO_REQUIRED`, the draft untouched.
- `saveStudioDraft` parses, cleans text, checks image ownership and the `pageImages` cap, updates `WHERE rev = input.rev` (setting `rev + 1`), and returns `check` computed with server context. **Saving never requires a passing check.** Only publishing does.
- `publishStudio`: resolve + `checkDesign(draft, serverContext)`. Any issue → throw `STUDIO_DESIGN_CHECK_FAILED` with the issues, and the draft is kept. Otherwise copy draft → published, set `published_check_version = DESIGN_CHECK_VERSION`, and delete images referenced by neither version (rows first, objects after commit).
- `publicProfile` returns `studio` only when `options.studio && plan === 'pro' && published !== null` **and** `checkDesign(resolveStudio(published), ctx)` has no issues. Otherwise the standard page shows (Review Focus 1). The check result for a version is memoised by `(profile_id, rev, DESIGN_CHECK_VERSION)` in process, so a read costs one check per version per process.

- [ ] **Step 1: Write the failing tests**

```js
test('a Pro page saves a failing draft, cannot publish it, fixes it and publishes', async () => {
  const s = await saveStudioDraft(db, user, { rev: 0, draft: WITH_LOW_RES_PHOTO });
  assert.equal(s.check.issues[0].rule, 'photo-resolution');
  await assert.rejects(publishStudio(db, user, { rev: s.rev }), { code: 'STUDIO_DESIGN_CHECK_FAILED' });
  const fixed = applyStudioFix(s.draft, s.check.issues[0], 'smaller-slot');
  const s2 = await saveStudioDraft(db, user, { rev: s.rev, draft: fixed });
  await publishStudio(db, user, { rev: s2.rev });
});
test('the server\'s issues win over the client\'s', ...);      // client says pass; server context has a gone video → 422
test('a published page that fails a newer check falls back to the standard page', ...); // raw jsonb + bumped rule
test('a save with an old rev is refused and keeps the newer draft', ...);
test('a Free page cannot save; its preview is never stored', ...);
test('publish after Pro ended is refused and the draft is kept', ...);
test('another page\'s image id is refused in a draft', ...);
test('discard and publish remove unreferenced images only', ...);
test('staff can remove one Studio photo; it drops out of both versions; audited', ...);
```

```ts
it('refuses a photo under 600px on its short side after EXIF rotation with IMAGE_TOO_SMALL', ...);
it('never upscales a rendition and keeps the focal point in every shape', ...);
it('strips metadata from every stored rendition', ...);
it('every Studio route is 404 while PAGE_STUDIO_ENABLED is off', ...);
it('a Free account gets 403 PRO_REQUIRED on every write', ...);
it('video verify: 404 → gone, timeout → unknown, no cookies sent; never called in tests against the real sites', ...); // nock-style local server
```

- [ ] **Step 2: Run and watch them fail**: `pnpm exec turbo run build --filter=!@tipme/web && <private template> node scripts/test-integration.mjs tests/integration/studio.test.mjs` (read `scripts/test-integration.mjs` for the private-template flag) and `pnpm --filter @tipme/api test -- studio video-verify`
- [ ] **Step 3: Implement** the schema (drizzle-kit migration), operations, controller, crops and verify.
- [ ] **Step 4: Run and watch them pass**, plus the existing `profiles`/`pro-periods` integration tests; then `pnpm api:openapi && pnpm docs:generate && pnpm api:openapi --check && pnpm docs:generate --check`.
- [ ] **Step 5: Commit**: `feat: Page Studio storage, API and publish gate behind PAGE_STUDIO_ENABLED`

---

### Task 8: The public page shows the Studio page, within budget

**Files:**

- Modify: `apps/web/src/app/people/[handle]/page.tsx` (when `profile.studio` is present, render `StudioPage` with today's `cover`, `identity`, `tipBlock`, `footer`; otherwise today's markup, byte for byte. Extract `TipBlock` in the same file for both branches)
- Modify: `apps/web/next.config.ts` (`frame-src` = `STUDIO_EMBED_ORIGINS`), `tests/e2e/profile-fixtures.ts` (`studio-kemi`, `studio-sule`, `studio-ify`)
- Create: `tests/e2e/studio-page.spec.ts`; Modify: `tests/e2e-perf/lcp.spec.ts` (the three examples), `scripts/csp.test.mjs` (or the existing headers test)

- [ ] **Step 1: Write the failing spec**

```ts
test('a Studio page keeps TipMe\'s tip block, fee line, badge, report link and footer @mobile', ...);
test('a profile without studio renders exactly today\'s page', ...);
test('nothing loads from a video site before the tap', ...);
test('a Studio page ships at most 3 KB more script than the standard page', ...);
test('a page requests only its own font files (≤ 2 families), all from our origin', async ({ page }) => {
  const fonts: string[] = []; page.on('request', (r) => r.resourceType() === 'font' && fonts.push(r.url()));
  await page.goto('/@studio-sule');
  expect(new Set(fonts.map(familyOf)).size).toBeLessThanOrEqual(2);
  expect(fonts.every((u) => u.startsWith(stack.origin))).toBe(true);
});
test('measured first-load weight is within 15% of the design check\'s estimate and under 1.5 MB', ...);
test('CLS during font swap stays ≤ 0.05', ...); // PerformanceObserver layout-shift on the three examples
```

```js
test('the CSP frames only the allow-listed embed origins', ...);
```

- [ ] **Steps 2–4:** fail, implement, pass (only these specs, your lane). Run `profile-page.spec.ts` and `profile.visual.spec.ts` to prove the standard page did not move. Run `pnpm perf:lab` locally once and record LCP for the three examples (lab only).
- [ ] **Step 5: Commit**: `feat(web): the public page renders a published Studio page within budget`

---

### Task 9: The editor (three PRs: G1, G2, G3)

**Files:**

- Create under `apps/web/src/app/dashboard/studio/`: `page.tsx`, `studio-editor.tsx` (client shell: top bar, tabs, preview, check panel), `style-tab.tsx` (brand colours, derived palette chips with ratios, mode, fonts, scale, corners), `blocks-tab.tsx` (rows list, row toolbar, column picker, spacing, background, add block, block forms), `block-forms.tsx`, `check-panel.tsx` (issues with fix buttons, "Fixed for you", passing list; on phones a bottom sheet), `publish-dialog.tsx` ("can't publish yet" and "Publish your page?"), `use-studio-draft.ts`, `colour-field.tsx`
- Modify: `apps/web/src/app/dashboard/settings/sections/my-page.tsx` ("Open Page Studio" for Pro; the teaser for Free; the "kept" note while lapsed)
- Create: `tests/e2e/studio-editor.spec.ts`

**Interfaces:**

- Consumes: Task 7 endpoints, `StudioPage` (the preview is the real renderer, rendered client-side from the same components: `studio-page.tsx` must stay free of server-only imports; a source test asserts it), `checkDesign`/`applyStudioFix` (client-side, instant), `deriveStudioPalette`, `useLiveForm`/`ChangedElsewhere`, `ConfirmDialog`.
- Produces:
  ```ts
  export function useStudioDraft(initial: MyStudio): {
    draft: StudioDocument;
    rev: number;
    saving: boolean;
    stale: boolean;
    check: StudioCheckResult; // client-side on every change; replaced by the server's after each save
    change(next: StudioDocument, label: string): void; // undo stack, debounced save (800 ms)
    fix(issue: StudioIssue, fixId: string): void;
    undo(): void;
    canUndo: boolean;
    discard(): Promise<void>;
    publish(): Promise<'published' | { issues: StudioIssue[] }>;
    summary: string[];
  };
  ```

Behaviour, from the StudioEditor board:

- **G1 (shell, Style, Check):** top bar ("4 changes not published yet · draft saved", Undo, Discard changes, Phone/Desktop, Publish). Publish shows "Publish · N to fix" and is `aria-disabled` while issues remain, but stays focusable and opens the "can't publish yet" dialog. Style tab: `colour-field` (a swatch button opening the native `<input type="color">` plus a hex text field with validation; a second colour is optional), the derived chips with live ratios, mode, font pickers from `STUDIO_FONTS` by role (the third family is never added: picking replaces the slot), scale, corners. The colour note copy, verbatim from the board: "Your yellow is too light for text on a light page. We'll use it for highlights and for buttons with dark text, and a deeper shade of it for links and headings. Your page will still look yellow." (the colour word comes from a small hue-name table: red, orange, yellow, green, teal, blue, purple, pink, brown, grey). Check tab and side panel: issues, notices, passing list.
- **G2 (Blocks):** rows list with Up/Down, drag, and Arrow keys on the focused row (`aria-live`: "Row 3, moved to position 1 of 5"). Row toolbar (columns, spacing, background). "Add a block" lists kinds and variants, disabled with the reason at a limit. Block forms with counters ("212 of 600") and `maxLength`. The tip block and identity show as locked rows ("Always TipMe. Can't be moved, styled or removed."), not focusable as drag targets. Preview "Show grid" overlay.
- **G3 (gate and states):** the "can't publish yet" dialog lists issues with their fix buttons. After a 422, it shows the server's issues. "Publish your page?" shows the summary and "Design check: N of N pass". Undo, and Discard (confirmed once). Free: `access: 'preview'`, the full editor on an in-memory draft, the banner "Preview only: not published", and the sheet "Like it? Page Studio comes with Pro." with "See Pro"; no writes, and the Pro badge hidden. Lapsed: read-only with the board's note.

- [ ] **Step 1: Write the failing e2e** (per PR, the steps for that PR)

```ts
test('G1: a picked yellow shows the accent-only note and passing chips @mobile', ...);
test('G1: the check panel shows a low-res photo issue and its fix clears it', ...);
test('G2: a Pro person adds a 2-1 row, adds Services, moves it first by keyboard', async ({ page }) => {
  await expect(page.getByRole('status')).toContainText('moved to position 1 of');
});
test('G2: no control accepts a font size, a position or CSS', async ({ page }) => {
  expect(await page.locator('input[type=range], [contenteditable], textarea[name*=css]').count()).toBe(0);
});
test('G3: Publish with an issue opens "Your page can\'t be published yet"; fixing it lets it publish', async ({ page }) => {
  await page.getByRole('button', { name: /Publish/ }).click();
  const d = page.getByRole('dialog', { name: 'Your page can’t be published yet' });
  await d.getByRole('button', { name: 'Make the photo smaller' }).click();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('dialog', { name: 'Publish your page?' }).getByRole('button', { name: 'Publish' }).click();
  await page.goto(`/@${handle}`);
});
test('G3: the server\'s 422 issues replace the client\'s list', ...); // route the publish call to answer 422 once
test('G3: a second tab\'s save shows "changed elsewhere" and loses nothing', ...);
test('G3: Free sees the teaser and a preview that is never published', ...);
test('the editor is accessible on each tab and in each dialog', ...);
```

- [ ] **Steps 2–4 (per PR):** fail, implement, pass (only these specs, your lane).
- [ ] **Step 5: Commits**: `feat(web): Page Studio editor shell, style tab and design check panel`; `feat(web): Page Studio blocks tab`; `feat(web): Page Studio publish gate, undo and preview states`

---

### Task 10: Media: photos, gallery, focal point, video form

**Files:**

- Create: `apps/web/src/app/dashboard/studio/photo-picker.tsx`, `focal-point.tsx`, `video-form.tsx`
- Modify: `apps/web/src/lib/shrink-photo.ts` (option `minSide: 600`), `apps/web/src/lib/photo-errors.ts` (`IMAGE_TOO_SMALL` → "This photo is too small. Choose one at least 600 pixels on its shortest side, so it looks sharp on every screen.")
- Test: `tests/e2e/studio-media.spec.ts`

`FocalPoint` (`{ src; x; y; onChange(x, y) }`): pointer drag plus Arrow keys (5% per press, Shift 20%) on a marker button with `aria-label="Focal point, 50% across, 50% down"`. The client checks the decoded size before upload (`createImageBitmap` with `imageOrientation: 'from-image'`), and the server stays the authority. The video form refuses non-listed sites with "We can't show videos from that site yet."

- [ ] **Step 1: Write the failing tests**: `a too-small photo is refused before upload, in plain words`; `moving the focal point re-crops every shape and the preview follows`; `an Instagram or unknown video link is refused; a YouTube one shows a TipMe still`; `tapping play loads youtube-nocookie only then` (route `**/embed/**` to a local page; never the real site).
- [ ] **Steps 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit**: `feat(web): Studio photos with focal points and click-to-load videos`

---

### Task 11: Font picker polish and preview loading

**Files:**

- Create: `apps/web/src/app/dashboard/studio/font-library.tsx` (filter Serif/Sans/Rounded/Display, each family set in itself, role chips, "Use for headings"/"Use for text", the reason when a family can't take a role)
- Modify: `style-tab.tsx` (open the library), `studio-fonts.tsx` (editor-only: load a family's file on hover/focus in the library, so 14 families never load at once)
- Test: `tests/e2e/studio-fonts.spec.ts`

- [ ] **Step 1: Write the failing tests**: `the library loads a family's file only when it's previewed`; `picking a third family replaces the chosen slot; the page never has 3`; `a display font offers only "Use for headings"`; `a heading with ọ in DM Serif Display is set in the text font, and the check lists it under "Fixed for you"`.
- [ ] **Steps 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit**: `feat(web): Page Studio font library`

---

### Task 12: When Pro lapses, and the runbook

**Files:**

- Create: `tests/e2e/studio-lapse.spec.ts`, `docs/runbooks/page-studio.md` (the switch; what staff can remove; what lapse does; how to retire a font or change a rule safely: bump `DESIGN_CHECK_VERSION`, and pages that now fail fall back to standard with fixes in the editor; how to replay a property-test counterexample)
- Modify: `apps/web/src/app/dashboard/settings/sections/plan.tsx` (Pro benefits: "Page Studio"), `/pro` copy only if it lists features (check first), `docs/runbooks/admin-roles.md` (`pages.suspend` covers Studio photos; `ops-catalogue.test.mjs` reads it)

- [ ] **Step 1: Write the failing e2e** (staff grant on/off, like `pro.spec.ts`)

```ts
test('Pro ends: the standard page shows; Pro resumes: the same Studio page is back @mobile', ...);
test('Pro resumes after a rule change: a now-failing page stays standard and the editor lists the fixes', ...);
test('an unpublished draft stays a draft through a lapse', ...);
test('a Studio photo is not served while the page is lapsed', ...);
```

- [ ] **Steps 2–4:** fail, implement copy and docs, pass.
- [ ] **Step 5: Commit**: `test(e2e): Page Studio survives a Pro lapse; runbook`

---

### Task 13: Supporter wall, with a second, separate yes (last; its own switch)

Unchanged from the first draft, except that it is a **block** (`kind: 'supporters'`), not a section.

**Files:**

- Modify: `packages/database/src/schema.ts` (`supporter_wall_consents(tip_id uuid PK → tips, profile_id, name text NOT NULL CHECK length ≤ 40, created_at, withdrawn_at NULL)`; the money tables gain no column), drizzle-kit migration
- Modify: `packages/contracts/src/checkout.ts` (optional `showOnWall?: true`, only with a typed name), `studio-document.ts` (`STUDIO_SUPPORTER_WALL = true`), `apps/api/src/config.ts` (`SUPPORTER_WALL_ENABLED`), `apps/web/src/components/appreciation-form.tsx` (a separate, unticked box, "Show my name on {first name}'s page", shown only when the page is Pro, a wall block is published and a name is typed), `apps/web/src/app/tip/[tipId]/status-view.tsx` ("Take my name off {first name}'s page")
- Regenerate OpenAPI and docs. Lands alone or in a train with any other open API PR.
- Test: `tests/integration/supporter-wall.test.mjs`, `tests/e2e/supporter-wall.spec.ts`

**Interfaces:** `PublicStudio` gains `supporters: string[]` (newest first, max 24, paid tips only, no amounts, counts or dates). The consent goes into the intent fingerprint only when given (the `intents.ts:92-103` trick). The repeat-supporters opt-in never implies it, and the reverse holds too.

- [ ] **Step 1: Write the failing tests**: `recognition consent alone never shows a name on the wall`; `a wall consent shows the typed name only after the tip is paid`; `withdrawing from the receipt removes it on the next render`; `no amount or date reaches the public page`; `the box is absent when the switch is off or the page is Free`.
- [ ] **Steps 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit**: `feat: Studio supporter wall with its own opt-in`

---

## Risks

1. **Editor complexity.** A block builder with live preview, undo, drag, a check panel and three access modes is the largest client surface in the app. Mitigations: three editor PRs (G1–G3); the preview is the real renderer; the check is pure and shared, so the editor only displays it; no free-form canvas, only ordered lists.
2. **Check and render drift.** The deterministic layout model can disagree with the browser (font metrics, subpixel wrapping). Mitigations: shared `STUDIO_GRID` constants with a source test; the render property test treats every disagreement as a bug in the model or CSS; counterexamples become permanent regressions.
3. **Performance.** Two families, photo-heavy rows and a client-side preview renderer. Mitigations: the page-weight rule blocks publishing; lazy photos by rule; `@font-face` only for used families plus metric fallbacks for CLS; the +3 KB script cap on the public page; the estimate is checked within ±15% of measured transfer.
4. **CI time.** Property render tests can grow. Mitigations: a fixed run count, a time cap that fails the test, their own shard, and `STUDIO_RENDER_RUNS` for local runs.
5. **Font licensing and coverage.** 12 new families. Mitigations: OFL only, a pinned commit and sha256 per file in the register, and the coverage test drops any family that can't draw Nigerian names or ₦.
6. **Server-side video checks** call YouTube/TikTok/Audiomack from our servers (owner question 5). They send no visitor data, are best effort (`unknown` never blocks), and sit behind `STUDIO_VIDEO_VERIFY`.

## Self-review notes

- **Spec coverage:** colour picker and derived palette (Tasks 1, 9 G1); font library and pairing (2, 11); type scale (2, 5); grid, rows, blocks, reflow (3, 4, 5, 9 G2); images, focal point, scrim, resolution (5, 7, 10); design check with one-click fixes and "can't publish yet" (4, 7, 9 G3); locked parts (5, 6, 8); no custom code (3, 5); videos (3, 7, 8, 10); performance budget (4, 8); property-based and curated testing (1, 3, 4, 6); lapse (7, 12); Free preview (9 G3); moderation (7); supporter wall (13). Out of scope: custom domain, analytics (D-07), a real-browser render at publish.
- **Earlier rulings kept:** video sites, services wording, Free teaser only, gallery moderation, supporter wall second yes, events text only, name, replaces §6. **Changed:** palettes → engine; font pairs → library of 14; three layouts → grid rows; section limits → row/block limits; 144-combination matrix → property tests. **New:** server video check, page-weight budget, no override.
- **Names used across tasks:** `deriveStudioPalette`, `StudioTokens`, `STUDIO_FONTS`, `studioTypeScale`, `StudioDocument`, `StudioRow`, `StudioBlock`, `studioDocumentSchema`, `resolveStudio`, `checkDesign`, `applyStudioFix`, `DESIGN_CHECK_VERSION`, `STUDIO_GRID`, `cellWidths`, `PublicStudio`, `MyStudio`, `StudioPage`, `studioStyle`, `PAGE_STUDIO_ENABLED`, `STUDIO_VIDEO_VERIFY`, `STUDIO_EMBED_ORIGINS`, matching wherever they appear.
