# Page Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pro recipients style their public page "like a website" in a constrained studio (curated themes, font pairs, three tested layouts, snap-in sections), where a bad page, an unreadable page or a broken page cannot be built.

**Owner's direction:** 11–12 Nov 2026: "A Pro user customises their page like a website… we give them a studio." Then, twice: "They should not be able to make bad designs" / "We need to make it impossible for the user to build a bad page/UI/profile." This plan reads that as approval of the constrained studio drawn on the canvas. The 11 open questions on the board were **not** answered: see "Owner rulings (defaults)". This is a product decision only. It is not legal, data-protection or payment-partner approval. D-07 stays OPEN. No fee, minimum, checkout amount, ledger posting or payout changes anywhere in this plan.

**Architecture:** Every choice is an id from a registry in `packages/contracts`. The registry holds only pre-tested values: palettes (colour tokens only), font pairs, layouts, section kinds and limits. A Studio page is a small JSON document that names registry ids, plus user text and image ids. It is validated by one Zod schema on every write and resolved again on every read. The API sends `PublicProfile.studio` only while the page is Pro, the feature switch is on and a version is published. The web renders it with server components: no user CSS, no user HTML, and colours applied as inline custom properties read from the registry, never from the document. TipMe's tip block, fee line, Pro badge, report link and footer are rendered by today's components, outside the Studio scope.

**Tech Stack:** Drizzle/Postgres, NestJS, sharp (already used), Next.js 16 App Router (server components), Zod, `node --test`, Playwright with `@axe-core/playwright` (already used). One new asset: a self-hosted DM Serif Display Italic Latin subset (SIL OFL, same family as the shipped font). No new npm dependency.

**Spec:** Canvas https://claude.ai/artifact/8D6hJZsqMkLSGh8KUUBmmh (version 1794470502-db6e, read 12 Nov 2026), boards `StudioEditor.dc.html`, `StudioExamples.dc.html`, `StudioRules.dc.html`, `StudioLapse.dc.html`, and the notes `studioquestions` and `studiolater`. Task 1 copies the four boards unchanged into `docs/design/redesign/boards/`, so the repo holds the spec.

---

## What the code does today (origin/dev `c4966605`, migrations up to 0092)

- **Public page:** `apps/web/src/app/people/[handle]/page.tsx` (rewritten from `/@:handle` in `apps/web/next.config.ts`). It renders `ProfileCover`, `RecipientIdentity`, the `aside.profile-composer.tip-instrument` holding `AppreciationForm` / `TippingOpensSoon` / `TipsNotReady`, and `footer.profile-foot` (ReportPage, Privacy, Terms, "Learn about this preview", and "Get your own TipMe page" when `plan !== 'pro'`). The data comes from `loadPublicProfile` → `GET /v1/profiles/:handle` → `publicProfile()` in `packages/database/src/operations/profiles.ts:959`.
- **Contracts:** `PublicProfile` / `MyProfile` / `PagePlan` / `PROFILE_REPORT_REASONS` are in `packages/contracts/src/profiles.ts`. Covers (`COVER_COLOURS`: neutral, violet, lilac, forest, ocean, sun, rose; `COVER_DARK`; `resolveCover` falls back for removed ids) are in `covers.ts`. Social links (`visibleLinks`, `FREE_LINK_LIMIT` 3, `PRO_LINK_LIMIT` 8, a host allow-list) are in `social-links.ts`. Every new field is optional, because the web deploys before the API.
- **Photo pipeline:** `apps/api/src/profiles/image-upload.ts`: `readUpload` (JPEG/PNG/WebP only, 5 MB, signature check), `reencodeTo(w,h)` (sharp, `rotate()`, `fit: 'cover'`, WebP q80, which drops all metadata, plus a 25 MP limit and a 5 s timeout), `withSlot` (2 concurrent), `sendImage` / `sendPrivateImage`. Storage: `PhotoStore` (R2 or Postgres bytes, "one place" check), as in `operations/covers.ts` and `page-images.ts` (`myPageId`, `lockLivePage`, `removeObjects`). Staff can view and remove page images (`operations/page-moderation.ts`, permission `pages.suspend`).
- **Pro gating:** `profiles.plan` is what every Pro check reads. `recomputePlan` (`operations/pro-periods.ts:70`) derives it from `staff_pro` and the `pro_periods` that cover now. The worker's `expireDuePeriods` returns the changed pages, and the worker revalidates them (`apps/worker/src/job-worker.ts:497`). Pro-only writes check the plan, then add `eq(profiles.plan, 'pro')` to the UPDATE (`setThanks`, `setTipAmounts`). Lapsed Pro data is kept, not deleted (links, animated cover still, thanks).
- **Fonts:** `apps/web/src/app/layout.tsx` self-hosts `Manrope-Latin.woff2` (200–800) and `DMSerifDisplay-Latin.woff2` (400 normal) through `next/font/local`. No third-party font request.
- **CSP** (`apps/web/next.config.ts:47`): `default-src 'self'`, with no `frame-src`, so no iframe can load today. `style-src 'unsafe-inline'` is allowed, so inline custom properties work.
- **Quality tooling:** `tests/e2e/helpers.ts` has `expectAccessible` (axe, WCAG 2.2 AA tags) and `fitsViewport`. `tests/e2e/profile.visual.spec.ts` has Linux and Darwin snapshots, and Linux is the authority. `tests/e2e-perf/lcp.spec.ts` checks `/@tobi` LCP < 2000 ms with 4× CPU slowdown on Fast 3G (`pnpm perf:lab`, lab only). `scripts/web-bundle.test.mjs` scans the built `.next` output.
- **Not built:** early access registry (Pro additions §5), profile sections (ProAdditions §6, "owner to confirm").

---

## Owner rulings (defaults): CHANGEABLE

The owner has not answered these. Each default below is what the build uses until the owner says otherwise. Every value lives in one registry constant (Task 1/2), so a change is a one-line edit plus its test.

| #   | Question (board)    | Default used by this plan                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Limits              | As drawn: 8 sections, each kind once (Minimal: 3); gallery **6** photos; videos **3**; events **4** upcoming; services **8**, name **40** chars; pinned note **140**; About = the bio (280, as today). Minimum source size: **square 512×512**, **strip 1120×300** (half of the 2240×600 output), measured after EXIF rotation.                                                                 |
| 2   | Video sites         | **YouTube** (embedded from `www.youtube-nocookie.com`), **TikTok** and **Audiomack**, as iframes only. **Instagram is not embedded** (its embed needs Instagram's script on our page). An Instagram video link is refused with the standard message and can go in social links instead. Before the tap, nothing from the other site loads, not even the thumbnail: the still is drawn by TipMe. |
| 3   | Services and prices | Whole naira only, price required, optional "from"; no booking, no pay-for-service. A fixed line under the list that can't be removed: "Prices are for information. Tips here are thanks."                                                                                                                                                                                                       |
| 4   | Free and Studio     | **Teaser + unpublished preview only.** Free gets no theme.                                                                                                                                                                                                                                                                                                                                      |
| 5   | Gallery moderation  | "Report this page" plus staff can view and remove any single gallery image with the existing `pages.suspend` tool (extended to `gallery`). No pre-publication queue. 6 photos.                                                                                                                                                                                                                  |
| 6   | Supporter wall      | **Agree:** showing a name publicly needs a second, separate yes, asked on the tip form. It is built last (Task 11) behind its own switch, and the section is hidden until then.                                                                                                                                                                                                                 |
| 7   | Event links         | **No links in release 1.** Events show date, time, title, place and a short note as text only. Revisit with a ticket-site allow-list.                                                                                                                                                                                                                                                           |
| 8   | Fonts               | The three pairs drawn: **Editorial** (DM Serif Display + Manrope), **Modern** (Manrope 800 + Manrope), **Soft** (DM Serif Display Italic + Manrope). Italic is self-hosted and loaded only by pages that use Soft.                                                                                                                                                                              |
| 9   | ProAdditions §6     | **Page Studio replaces §6.**                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | Name                | **"Page Studio"**.                                                                                                                                                                                                                                                                                                                                                                              |
| 11  | Accents             | **3 tested accents per palette variant**, as drawn.                                                                                                                                                                                                                                                                                                                                             |

Also carried from the board as defaults: palettes Violet, Ocean, Forest, Sun, Rose, Lilac, Neutral, Night, each with a light and a dark version. Layouts Classic, Portfolio first, Minimal. Later (not in this plan): custom domain; section view analytics (waits on D-07).

---

## Global Constraints

Every task's requirements include all of these.

- **Bad pages are impossible by construction, not warned about.** No step, API or stored field accepts a free colour, font, size, spacing, position or dimension. The document holds only registry ids, user text, kobo strings, dates and TipMe image ids.
- **Colour:** no colour picker. Palettes are curated, each with a light and a dark version and 3 accents. Every text/background pair passes WCAG AA: **4.5:1 body text, 3:1 large text (≥24px, or ≥18.66px bold) and UI/focus**. `packages/contracts/test/studio-palettes.test.mjs` checks every pair of every palette variant and fails the build otherwise.
- **Fonts:** heading+body pairs only (`STUDIO_FONT_PAIRS`), self-hosted woff2 in `apps/web/src/fonts/` (SIL OFL, licence file beside it), no third-party font request. Sizes, spacing and line length (max 68ch for body text) come from the layout's CSS, never from the document.
- **Layouts:** only `STUDIO_LAYOUTS`. Sections snap to the layout's grid. No free positioning or resizing. Max sections per layout, each kind once, per-section limits from `STUDIO_LIMITS`. An empty section renders nothing on the public page.
- **Images:** only through `readUpload` + re-encode (metadata stripped), auto-cropped server-side to the section shape around a focal point. Sources below the minimum resolution (after rotation) are refused with `IMAGE_TOO_SMALL`. Text sits over an image only inside the `STUDIO_SCRIM` preset, whose worst case (white image) is tested to ≥4.5:1.
- **Video:** click-to-load embeds from `STUDIO_VIDEO_SITES` only. No third-party request before the visitor taps: no iframe, no thumbnail, no preconnect. `frame-src` in the CSP lists exactly the allow-listed embed origins.
- **Fixed and untouchable:** the tip block (`aside.tip-instrument` and everything in it), the fee line, the Pro badge position, "Report this page", Privacy, Terms, "Learn about this preview", closed/not-ready/pilot states, and name + photo + handle at the top. Studio custom properties are namespaced `--studio-*`. Nothing inside the tip block reads them.
- **No custom HTML/CSS/JS anywhere.** All user text is rendered as React text. No `dangerouslySetInnerHTML` under `components/studio/` (a test greps for it). Text is cleaned of control and bidi-override characters on write.
- **Combinatorial render test:** all 8 palettes × 2 versions × 3 font pairs × 3 layouts = **144 combinations** render at **320px and 1440px** with no horizontal overflow, no clipped text, no contrast failure and axe clean, with geometry also at 390/768/1024. It runs in CI. **Linux CI is the authority.**
- **Performance:** a Studio page stays within the public page's current budget: lab LCP < 2000 ms on the `lcp.spec.ts` throttle (4× CPU, 150 ms, 1.6 Mbps), and script bytes no more than the standard page's **+ 3 KB** (the video island).
- **Pro lapse:** the standard page shows from the moment `plan` turns free. The Studio draft, published version and images are kept and come back unchanged when Pro resumes. Links and QR codes never change.
- **Switch:** `PAGE_STUDIO_ENABLED` (API config `flag`, default off in production, on in development, e2e and staging). Off means `studio` is never sent and the Studio API answers 404.
- **Copy:** pronoun "they"; the payment provider is "our payment partner"; never imply regulatory approval (`docs/00-DECISIONS.md`); the board's copy is used verbatim where it gives copy.
- **Process:** migrations only via drizzle-kit. Regenerate OpenAPI (`pnpm api:openapi`) and docs (`pnpm docs:generate`) once per API-changing PR; their `--check` must pass. API-changing PRs land in sequence or in one train (`docs/runbooks/merge-trains.md`). Test-first: every behaviour change gets a test watched red, then green. Never edit `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`.

## Review Focus

These are the failure modes the boards imply but don't draw. Each line names its pinning test, which is added to the owning task.

1. **A stored document that no longer matches the registry** (a palette, accent, font pair or layout removed later; too many sections after a limit is lowered). Expected: the page still renders, with the stored id replaced by the default and extra sections dropped from the end, as `resolveCover` does. Never a 500 or a blank page. _Test:_ `resolveStudio keeps a page readable after a registry change` (Task 2).
2. **Two tabs, or phone and laptop, editing the same draft.** Expected: the second save is refused with `STUDIO_DRAFT_STALE` (409), and the editor shows today's "changed elsewhere" notice. Nothing is silently overwritten. _Test:_ `a save with an old rev is refused and keeps the newer draft` (Task 5), plus the editor e2e step in Task 8.
3. **Pro ends between saving and publishing, or while the editor is open.** Expected: publish is refused with `PRO_REQUIRED` and the draft is kept. The public page is already standard, and the editor switches to read-only on its next load. _Test:_ `publish after Pro ended is refused and the draft is kept` (Task 5).
4. **Hostile or extreme text:** a 60-character unbroken word, emoji, RTL names, a bidi-override character, and every field at its exact limit at 320px. Expected: it wraps inside its section, overflows nothing, and the override character is stripped on write. _Test:_ the `max` fixture in the matrix (Task 4) and `studio text is cleaned of control and bidi characters` (Task 2).
5. **Images that stop being referenced** (removed from the draft, the draft discarded, a section deleted). Expected: deleted on publish/discard, after the database change (the `removeObjects` order), and never while the published version still uses them. _Test:_ `discard and publish remove unreferenced images only` (Task 5).

---

## Delivery order (PRs)

| PR  | Tasks                                                   | Touches API?   | Order                                                                            |
| --- | ------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| A   | 1, 2: registry, AA test, document schema                | No (contracts) | First                                                                            |
| B   | 3, 4: renderer, harness, combinatorial test             | No (web)       | After A; **parallel with C**                                                     |
| C   | 5, 6: storage, operations, API, images                  | **Yes**        | After A; **parallel with B**                                                     |
| D   | 7: public page wiring, perf budget                      | No             | After B and C                                                                    |
| E   | 8: editor                                               | No             | After D                                                                          |
| F   | 9: media sections (gallery UI, focal point, video, CSP) | No             | After E                                                                          |
| G   | 10: lapse journey, runbook                              | No             | After F (it can run beside F if F's files aren't touched)                        |
| H   | 11: supporter wall (second yes)                         | **Yes**        | Last. Lands after C in sequence, or in one train with any other API PR open then |

C and H regenerate OpenAPI and docs, so they never merge in parallel.

---

### Task 1: Studio registry and the palette AA test

**Files:**

- Create: `packages/contracts/src/studio.ts`
- Modify: `packages/contracts/src/index.ts` (export it)
- Test: `packages/contracts/test/studio-palettes.test.mjs`
- Copy (unchanged): `docs/design/redesign/boards/StudioEditor.dc.html`, `StudioExamples.dc.html`, `StudioRules.dc.html`, `StudioLapse.dc.html`

**Interfaces:**

- Produces:
  ```ts
  export type Hex = `#${string}`; // 6-digit lower-case only
  export type StudioPaletteId =
    | 'violet'
    | 'ocean'
    | 'forest'
    | 'sun'
    | 'rose'
    | 'lilac'
    | 'neutral'
    | 'night';
  export type StudioVariant = 'light' | 'dark';
  export interface StudioColours {
    background: Hex;
    surface: Hex;
    text: Hex;
    muted: Hex;
    heading: Hex;
    line: Hex;
    focus: Hex;
  }
  export interface StudioAccent {
    id: string;
    name: string;
    colour: Hex;
  }
  export interface StudioPaletteVariant extends StudioColours {
    accents: readonly [StudioAccent, StudioAccent, StudioAccent];
  }
  export interface StudioPalette {
    id: StudioPaletteId;
    name: string;
    light: StudioPaletteVariant;
    dark: StudioPaletteVariant;
  }
  export const STUDIO_PALETTES: readonly StudioPalette[]; // 8, board order
  export type StudioFontPairId = 'editorial' | 'modern' | 'soft';
  export interface StudioFontPair {
    id: StudioFontPairId;
    name: string;
    heading: {
      face: 'dm-serif' | 'dm-serif-italic' | 'manrope';
      weight: 400 | 800;
    };
    body: { face: 'manrope'; weight: 400 };
  }
  export const STUDIO_FONT_PAIRS: readonly StudioFontPair[];
  export type StudioLayoutId = 'classic' | 'portfolio' | 'minimal';
  export const STUDIO_LAYOUTS: readonly {
    id: StudioLayoutId;
    name: string;
    maxSections: 8 | 3;
  }[];
  export const STUDIO_SECTION_KINDS: readonly [
    'about',
    'gallery',
    'videos',
    'services',
    'events',
    'links',
    'supporters',
    'pinned',
  ];
  export type StudioSectionKind = (typeof STUDIO_SECTION_KINDS)[number];
  export const STUDIO_LIMITS: {
    sections: 8;
    gallery: 6;
    videos: 3;
    events: 4;
    services: 8;
    serviceName: 40;
    pinned: 140;
    eventTitle: 60;
    eventPlace: 60;
    eventNote: 80;
    videoCaption: 80;
    priceMaxMinor: 1_000_000_000n;
  };
  export const STUDIO_IMAGE_SHAPES: {
    square: { width: 768; height: 768; minWidth: 512; minHeight: 512 };
    strip: { width: 2240; height: 600; minWidth: 1120; minHeight: 300 };
  };
  export const STUDIO_SCRIM: {
    colour: '#000000';
    opacity: 0.62;
    text: '#ffffff';
  };
  export const AA: { body: 4.5; large: 3; ui: 3 };
  export function contrastRatio(a: Hex, b: Hex): number; // WCAG 2.x relative luminance
  export function blend(over: Hex, opacity: number, under: Hex): Hex;
  export function paletteFailures(
    palettes?: readonly StudioPalette[],
  ): string[]; // "ocean/dark text on surface 4.31 < 4.5"
  export const STUDIO_DEFAULTS: {
    palette: 'violet';
    variant: 'light';
    fonts: 'editorial';
    layout: 'classic';
  };
  ```

The pairs `paletteFailures` checks, per variant:

| foreground                                 | on                                               | minimum                              |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------ |
| text, muted, every accent                  | background and surface                           | 4.5                                  |
| heading                                    | background and surface                           | 3 (headings are ≥24px by layout CSS) |
| focus, line where used as a control border | background                                       | 3                                    |
| `STUDIO_SCRIM.text`                        | `blend(scrim, 0.62, '#ffffff')` (the worst case) | 4.5                                  |

Palette values are the implementer's choice, starting from the `COVER_COLOURS` bases and the board's samples (Ocean dark: background `#10243f`, text `#ffffff`, muted `#c9daf0`; Sun light: text black). They only have to pass the test. Palettes are colour-only by type: no field other than `Hex` values.

- [ ] **Step 1: Write the failing tests**

```js
test('every palette variant passes WCAG AA for every pair it offers', () => {
  assert.deepEqual(paletteFailures(), []);
});
test('the checker catches a failing pair (so the test cannot pass vacuously)', () => {
  const bad = structuredClone(STUDIO_PALETTES[0]);
  bad.light.muted = '#9a9a9a'; // on near-white: about 2.8:1
  assert.match(paletteFailures([bad]).join('\n'), /violet\/light muted on background/);
});
test('contrastRatio matches WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#7a32f9', '#ffffff').toFixed(2), '5.75');
});
test('the scrim keeps white text readable over a white photo', () => {
  assert.ok(contrastRatio('#ffffff', blend('#000000', 0.62, '#ffffff')) >= 4.5); // #616161: 6.19
});
test('the registry has 8 palettes, 3 font pairs, 3 layouts: 144 combinations', () => {
  assert.equal(STUDIO_PALETTES.length * 2 * STUDIO_FONT_PAIRS.length * STUDIO_LAYOUTS.length, 144);
});
test('every palette has 3 accents per variant with unique ids, and every colour is #rrggbb', ...);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @tipme/contracts build && node --test packages/contracts/test/studio-palettes.test.mjs`
Expected: FAIL (`studio.js` not found)

- [ ] **Step 3: Implement `studio.ts`** with the interfaces above. `contrastRatio` uses the sRGB linearisation (0.03928 threshold) and `(L1+0.05)/(L2+0.05)`.

- [ ] **Step 4: Run them and watch them pass** (same command). Expected: PASS. Then run `pnpm --filter @tipme/contracts test` to confirm nothing else broke.

- [ ] **Step 5: Copy the four boards**, unchanged, into `docs/design/redesign/boards/`.

- [ ] **Step 6: Commit**: `feat(contracts): Page Studio registry with AA-checked palettes`

---

### Task 2: The Studio document schema, resolver and video links

**Files:**

- Create: `packages/contracts/src/studio-document.ts`
- Modify: `packages/contracts/src/errors.ts` (add `STUDIO_DRAFT_STALE`, `IMAGE_TOO_SMALL`, `STUDIO_IMAGE_LIMIT`), `packages/contracts/src/profiles.ts` (`PublicProfile.studio?: PublicStudio`), `index.ts`
- Test: `packages/contracts/test/studio-document.test.mjs`

**Interfaces:**

- Consumes: Task 1 registry.
- Produces:
  ```ts
  export type StudioSection =
    | { kind: 'about' }
    | { kind: 'links' }
    | { kind: 'supporters' }
    | { kind: 'pinned'; text: string }
    | { kind: 'gallery'; images: { imageId: string }[] }
    | { kind: 'videos'; videos: { url: string; caption?: string }[] }
    | {
        kind: 'services';
        items: { name: string; priceMinor: string; from?: true }[];
      }
    | {
        kind: 'events';
        items: {
          date: string /* YYYY-MM-DD */;
          time?: string /* HH:MM */;
          title: string;
          place?: string;
          note?: string;
        }[];
      };
  export interface StudioDocument {
    v: 1;
    palette: StudioPaletteId;
    variant: StudioVariant;
    accent: string;
    fonts: StudioFontPairId;
    layout: StudioLayoutId;
    sections: StudioSection[];
  }
  export const studioDocumentSchema: z.ZodType<StudioDocument>; // strict; for writes
  export function resolveStudio(
    raw: unknown,
    today: string /* Lagos YYYY-MM-DD */,
  ): StudioDocument; // for reads; never throws
  export const STUDIO_VIDEO_SITES: readonly ['youtube', 'tiktok', 'audiomack'];
  export type StudioVideoSite = (typeof STUDIO_VIDEO_SITES)[number];
  export function parseVideoLink(
    url: string,
  ): { site: StudioVideoSite; id: string } | null;
  export function embedUrl(v: { site: StudioVideoSite; id: string }): string; // youtube → https://www.youtube-nocookie.com/embed/<id>
  export const STUDIO_EMBED_ORIGINS: readonly string[]; // exactly the embed origins, for the CSP
  export interface PublicStudio {
    document: Omit<StudioDocument, 'sections'> & {
      sections: PublicStudioSection[];
    };
  }
  // PublicStudioSection = StudioSection with gallery images resolved to { path: string; shape: 'square' | 'strip'; alt: string },
  // videos resolved to { site, id, caption? }; only non-empty sections are present.
  export function cleanStudioText(s: string): string; // NFC, trim, strips C0/C1 controls and U+202A–202E / U+2066–2069
  ```

Rules the schema enforces: each kind at most once; `sections.length ≤ layout.maxSections`; text limits counted in code points (like the bio); names, titles and captions single-line; `priceMinor` is a kobo string, a multiple of 100, between 100 and `priceMaxMinor`; `accent` is one of that palette variant's accents; event `date` is a real calendar date; video `url` is `parseVideoLink`-able; gallery `imageId` is a UUID (whether it belongs to the page is checked by the operation, Task 5). `supporters` is refused until Task 11 flips `STUDIO_SUPPORTER_WALL` in contracts.

`resolveStudio` replaces unknown ids with `STUDIO_DEFAULTS` (and the variant's first accent), drops unknown section kinds, duplicate kinds and sections beyond the layout's maximum, truncates over-limit lists, and filters events before `today`.

- [ ] **Step 1: Write the failing tests**

```js
test('a document naming anything outside the registry is refused', () => {
  for (const bad of [{ palette: 'teal' }, { fonts: 'comic' }, { layout: 'grid' }, { accent: '#ff0000' }])
    assert.equal(studioDocumentSchema.safeParse({ ...VALID, ...bad }).success, false);
});
test('no colour, size or position can be stored', () => {
  assert.equal(studioDocumentSchema.safeParse({ ...VALID, colour: '#123456' }).success, false);
  assert.equal(studioDocumentSchema.safeParse({ ...VALID, sections: [{ kind: 'pinned', text: 'x', x: 10 }] }).success, false);
});
test('each kind once, at most 8 sections, at most 3 on Minimal', ...);
test('limits: 6 photos, 3 videos, 4 events, 8 services, 40-char names, 140-char note', ...);
test('prices are whole naira kobo strings', () => {
  assert.equal(ok(services('800000')), true);
  assert.equal(ok(services('800050')), false);
  assert.equal(ok(services('8000.00')), false);
});
test('studio text is cleaned of control and bidi characters', () => {
  assert.equal(cleanStudioText(' Hi‮evil\u0007 '), 'Hievil');
});
test('resolveStudio keeps a page readable after a registry change', () => {
  const r = resolveStudio({ ...VALID, palette: 'removed', layout: 'minimal', sections: FIVE_SECTIONS }, '2026-11-12');
  assert.equal(r.palette, 'violet');
  assert.equal(r.sections.length, 3);
});
test('resolveStudio hides events that have passed (Lagos date)', ...);
test('resolveStudio never throws on garbage', () => { for (const g of [null, 1, 'x', {}, []]) resolveStudio(g, '2026-11-12'); });
test('video links: only allow-listed sites; Instagram refused', () => {
  assert.deepEqual(parseVideoLink('https://youtu.be/dQw4w9WgXcQ'), { site: 'youtube', id: 'dQw4w9WgXcQ' });
  assert.equal(parseVideoLink('https://www.instagram.com/reel/abc/'), null);
  assert.equal(parseVideoLink('https://youtube.com.evil.example/watch?v=x'), null);
  assert.equal(embedUrl({ site: 'youtube', id: 'dQw4w9WgXcQ' }), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
});
test('every embed origin is https and listed in STUDIO_EMBED_ORIGINS', ...);
```

- [ ] **Step 2: Run them and watch them fail**: `pnpm --filter @tipme/contracts build && node --test packages/contracts/test/studio-document.test.mjs` (FAIL, module missing)
- [ ] **Step 3: Implement** `studio-document.ts` and the contract additions. IDs for TikTok are numeric video ids from `/@user/video/<id>`. Audiomack takes `/<artist>/song/<slug>` and embeds at `https://audiomack.com/embed/<artist>/song/<slug>`.
- [ ] **Step 4: Run and watch them pass**, then `pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck`.
- [ ] **Step 5: Commit**: `feat(contracts): Page Studio document schema, resolver and video allow-list`

---

### Task 3: The Studio renderer (web, no API)

**Files:**

- Create: `apps/web/src/components/studio/studio-page.tsx` (server component), `studio-sections.tsx` (one component per kind), `studio-theme.ts`, `studio.css`, `video-embed.tsx` (the only `'use client'` file: click-to-load)
- Create: `apps/web/src/fonts/DMSerifDisplay-Italic-Latin.woff2` (subset to the same unicode range as `DMSerifDisplay-Latin.woff2`; the OFL file already covers the family)
- Modify: `apps/web/src/app/layout.tsx` (add `dmSerifItalic` with `preload: false`, variable `--font-dm-serif-italic`), `docs/third-party-component-register.md` (font entry)
- Test: `apps/web/src/components/studio/studio-theme.test.ts` (the web app's unit runner), `scripts/studio-source.test.mjs`

**Interfaces:**

- Consumes: Tasks 1–2.
- Produces:
  ```ts
  // studio-theme.ts
  export function studioStyle(
    doc: Pick<StudioDocument, 'palette' | 'variant' | 'accent' | 'fonts'>,
  ): Record<`--studio-${string}`, string>;
  // studio-page.tsx
  export function StudioPage(props: {
    studio: PublicStudio;
    profile: PublicProfile;
    identity: React.ReactNode; // today's <RecipientIdentity/>: name, photo, handle, Pro badge
    cover: React.ReactNode; // today's <ProfileCover/>
    tipBlock: React.ReactNode; // today's <aside className="profile-composer tip-instrument">…</aside>, unchanged
    footer: React.ReactNode; // today's <footer className="profile-foot">…</footer>, unchanged
  }): JSX.Element;
  ```

Rendering rules:

- The root is `<div className="studio" data-layout={id} data-fonts={id} style={studioStyle(doc)}>`. The tip block and the footer are rendered inside a `<div className="studio-fixed">` that resets every `--studio-*` property to `initial` and uses only `@tipme/ui` tokens.
- Layout grids live in `studio.css` per `data-layout`. On a phone (<768px) every layout is one column: identity, tip block, then sections in order. Desktop Classic/Portfolio put the tip block in the right column, sticky. Minimal is one centred column.
- Sizes, spacing and measure are fixed in `studio.css` with `clamp()`. Body text is `max-inline-size: 68ch`. Every user-text element gets `overflow-wrap: anywhere; min-width: 0`.
- No section renders when its content is empty: About without a bio, gallery without images, and so on. A section heading is the kind's fixed name from the board ("Gallery", "Services and prices"…), not user text.
- Services: price via `formatNaira`, "from" as the word "from", and the fixed line under the list.
- Video: `VideoEmbed` renders a TipMe-drawn still (site name, caption, play button with `aria-label="Play video from YouTube"`). On activation it inserts `<iframe src={embedUrl(v)} title={caption ?? 'Video'} sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; picture-in-picture" referrerPolicy="strict-origin" loading="lazy">`. Before that, nothing from the other site is on the page.

- [ ] **Step 1: Write the failing tests**

```ts
test('studioStyle sets only --studio-* colour and font properties from the registry', () => {
  const s = studioStyle({ palette: 'ocean', variant: 'dark', accent: OCEAN_DARK_ACCENT_1, fonts: 'soft' });
  assert.ok(Object.keys(s).every((k) => k.startsWith('--studio-')));
  assert.equal(s['--studio-background'], STUDIO_PALETTES.find((p) => p.id === 'ocean')!.dark.background);
});
test('an unknown accent falls back to the variant’s first accent', ...);
```

```js
// scripts/studio-source.test.mjs
test('no studio component renders raw HTML or user-chosen styles', () => {
  for (const file of studioFiles()) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes('dangerouslySetInnerHTML'), file);
    assert.ok(
      !/style=\{\{[^}]*section\./.test(src),
      `${file}: a style built from section content`,
    );
  }
});
test('studio.css never styles inside the tip block', () => {
  assert.ok(
    !/tip-instrument|profile-composer|profile-foot/.test(
      readFileSync(CSS, 'utf8'),
    ),
  );
});
```

- [ ] **Step 2: Run and watch them fail**: `pnpm --filter @tipme/web test -- studio-theme` and `node --test scripts/studio-source.test.mjs`
- [ ] **Step 3: Implement** the files above. Add the italic font to `layout.tsx` with `preload: false`, so pages not using Soft never download it.
- [ ] **Step 4: Run and watch them pass**, then `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`
- [ ] **Step 5: Commit**: `feat(web): Page Studio renderer around the fixed tip block`

---

### Task 4: The combinatorial render test (144 combinations)

**Files:**

- Create: `apps/web/src/app/dev/studio-matrix/page.tsx` (harness; `notFound()` in production unless `NEXT_PUBLIC_STUDIO_MATRIX === 'on'`, which `scripts/build-e2e.mjs` sets; `robots` noindex)
- Create: `apps/web/src/app/dev/studio-matrix/fixtures.ts` (`max`, `min` and `empty` documents + a sample `PublicProfile`)
- Create: `tests/e2e/studio-matrix.spec.ts`, `tests/e2e/studio-matrix.visual.spec.ts` (+ `-snapshots/`, Linux authoritative)
- Modify: `scripts/build-e2e.mjs` (set the harness env)

**Interfaces:**

- Consumes: `StudioPage` (Task 3), registry (Task 1).
- Produces: the harness URL `/dev/studio-matrix?layout=<id>&fixture=max|min|empty`. It renders one `StudioPage` with every combination reachable by setting `data-palette`, `data-variant`, `data-accent` and `data-fonts` on `#studio-matrix-root`. The page embeds the registry's `studioStyle` for each colour set as a JSON map, and a tiny inline script applies it. The harness preloads all three font pairs.

How it stays fast (the design decision):

1. **One page load per layout × fixture × width** (3 × 2 × 5 = 30 loads). Combinations switch in-page by swapping the root's inline custom properties and `data-fonts`, with no reload. `document.fonts.ready` is awaited once per load, after which only `requestAnimationFrame` ×2 is needed per switch.
2. **Factorised geometry.** Palettes are colour-only by type (Task 1) and `studio.css` sets no size from a colour property (a source test asserts the palette selectors set only `color`, `background-color`, `border-color`, `outline-color`, `text-decoration-color`). So overflow and clipping depend on layout × font pair × fixture × width only: **3 × 3 × 2 × 5 = 90 geometry checks**, each a single `page.evaluate`.
3. **Every one of the 144 combinations is still rendered and checked** at 320 and 1440 for contrast (an in-page computed-style walk: every text node's colour against its effective background, ~20 ms) and axe (`AxeBuilder.include('#studio-matrix-root').withTags(wcag)`, ~250 ms). Accents ride along: accent index = font-pair index, so each palette × variant × layout meets all three accents. In-page contrast walks also run for all 3 accents × 144 (cheap), so no accent goes untested.
4. **Sharded by layout:** three `test()` blocks (one per layout) run on parallel workers and on the existing e2e shards. Budget: under 90 s per layout on CI. A test fails if a layout block exceeds 150 s, so the suite cannot quietly grow slow.
5. **Pixels only where they add something:** 6 Linux screenshots (each layout at 320 and 1440 on its board-example theme), not 144.

- [ ] **Step 1: Write the failing spec**

```ts
for (const layout of STUDIO_LAYOUTS)
  test(`studio matrix: ${layout.id}`, async ({ page }) => {
    test.setTimeout(150_000);
    for (const fixture of ['max', 'min'] as const)
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/dev/studio-matrix?layout=${layout.id}&fixture=${fixture}`);
        await page.evaluate(() => document.fonts.ready);
        for (const fonts of STUDIO_FONT_PAIRS) {
          await setCombo(page, { fonts: fonts.id });
          expect(await geometryProblems(page), `${layout.id}/${fonts.id}/${fixture}@${width}`).toEqual([]);
        }
        if (width !== 320 && width !== 1440) continue;
        for (const combo of colourCombos(layout.id)) {   // 8 palettes × 2 variants × 3 font pairs = 48
          await setCombo(page, combo);
          expect(await contrastProblems(page), label(combo, width)).toEqual([]);
          if (fixture === 'max') await expectAccessibleIn(page, '#studio-matrix-root', label(combo, width));
        }
      }
  });
test('the tip block looks identical on every combination', async ({ page }) => {
  // computed color, background, font-family, font-size of the tip block's heading, preset buttons, submit and fee line
  // are equal across all 48 colour/font sets for each layout
});
test('an empty fixture shows no section headings', ...);
test('palette selectors set colours only', () => { /* reads studio.css */ });
```

`geometryProblems(page)` returns labels for `documentElement.scrollWidth > documentElement.clientWidth`; any element under the root whose `scrollWidth > clientWidth + 1` with `overflow` not visible; any text element whose `scrollHeight > clientHeight + 1` with `overflow: hidden` or `text-overflow: ellipsis`; and any two section boxes that overlap. `contrastProblems` walks text nodes, takes the computed `color` and the first opaque ancestor background (images count only inside `.studio-scrim`, using the scrim's worst case), and applies 4.5 or 3 by computed size and weight.

- [ ] **Step 2: Run and watch it fail** on lane `n`: `rm -rf apps/web/.next && TURBO_FORCE=true node scripts/build-e2e.mjs && node scripts/prepare-e2e-database.mjs && E2E_LANE=<n> pnpm exec playwright test tests/e2e/studio-matrix.spec.ts --workers=2` (FAIL, 404 on the harness)
- [ ] **Step 3: Implement** the harness and fixtures. The `max` fixture puts every list at its limit and every string at its limit, with `'W'` runs, one 60-char unbroken word, emoji and an Arabic name. `min` has one item per section. `empty` has every kind with no content.
- [ ] **Step 4: Fix what it finds.** A failing combination is fixed in the registry or CSS, or the option is removed. It is never skipped. Run until PASS, and record the wall time per layout in the PR.
- [ ] **Step 5: Linux snapshots** via `scripts/e2e-linux.sh` for `studio-matrix.visual.spec.ts`. Commit only the `-linux.png` files plus Darwin if the repo convention keeps both (it does for `profile.visual`).
- [ ] **Step 6: Commit**: `test(web): render every Page Studio combination at 320–1440px`

---

### Task 5: Storage and operations

**Files:**

- Modify: `packages/database/src/schema.ts` (two tables), generate migration with `pnpm --filter @tipme/database exec drizzle-kit generate --name page_studio`
- Create: `packages/database/src/operations/studio.ts`
- Modify: `packages/database/src/operations/profiles.ts` (`publicProfile` gains `options.studio?: boolean` and returns `studio`), `operations/page-moderation.ts` (`OpsPageImage` gains `'gallery'` with an `imageId`), `packages/database/src/index.ts`
- Test: `tests/integration/studio.test.mjs` (private template via `scripts/test-support`)

**Interfaces:**

- Consumes: Task 2 schema, `resolveStudio`, `cleanStudioText`; `myPageId`, `lockLivePage`, `removeObjects`, `PhotoStore`.
- Produces:
  ```ts
  // schema
  page_studios(profile_id uuid PK → profiles, draft jsonb NOT NULL, published jsonb NULL, rev integer NOT NULL DEFAULT 0,
               published_at timestamptz NULL, updated_at timestamptz NOT NULL DEFAULT now())
  studio_images(id uuid PK, profile_id uuid → profiles, version integer NOT NULL, focal_x smallint NOT NULL DEFAULT 50 CHECK 0–100,
                focal_y smallint NOT NULL DEFAULT 50 CHECK 0–100, master_bytes bytea, master_key text,
                square_bytes bytea, square_key text, strip_bytes bytea, strip_key text, created_at)
                -- each of master/square/strip: exactly one place, as profile_covers_one_place
                -- index (profile_id)
  // operations
  export interface MyStudio { draft: StudioDocument; published: StudioDocument | null; rev: number; publishedAt: string | null;
    images: { imageId: string; path: string; focalX: number; focalY: number }[]; access: 'edit' | 'preview' | 'lapsed' }
  export function getMyStudio(db, userId, today: string): Promise<MyStudio>;
  export function saveStudioDraft(db, userId, input: { rev: number; draft: StudioDocument }): Promise<MyStudio>;   // STUDIO_DRAFT_STALE, PRO_REQUIRED
  export function publishStudio(db, userId, input: { rev: number }, store?): Promise<{ studio: MyStudio; handle: string }>;
  export function discardStudioDraft(db, userId, store?): Promise<MyStudio>;
  export function addStudioImage(db, userId, crops: { master: Buffer; square: Buffer; strip: Buffer }, store?): Promise<MyStudio>; // STUDIO_IMAGE_LIMIT at 12 stored
  export function setStudioFocus(db, userId, input: { imageId: string; focalX: number; focalY: number; crops: { square: Buffer; strip: Buffer } }, store?): Promise<MyStudio>;
  export function studioImageFor(db, input: { profileId: string; imageId: string; version: number; shape: 'square' | 'strip' }, store?): Promise<Buffer | null>;
  export const studioImagePathOf: (profileId: string, imageId: string, version: number, shape: 'square' | 'strip') => string;
                                 // `/v1/studio-images/${profileId}/${imageId}/${version}-${shape}.webp`
  ```

Rules:

- Every write locks the page, checks `plan = 'pro'`, and repeats `eq(profiles.plan,'pro')` in the UPDATE's subquery guard. Free accounts get `access: 'preview'`: `getMyStudio` returns a default draft built from their profile and nothing is stored. A page with stored studio rows that is now Free gets `access: 'lapsed'` and every write is refused `PRO_REQUIRED`. The draft is never touched.
- `saveStudioDraft` re-parses with `studioDocumentSchema`, cleans text, checks every `imageId` belongs to this page, and updates `WHERE rev = input.rev`, setting `rev = rev + 1`. Zero rows means `STUDIO_DRAFT_STALE`.
- `publishStudio` copies `draft` → `published` at the same rev. `publishStudio` and `discardStudioDraft` then delete images referenced by neither `draft` nor `published` (rows first, objects after commit). Stored images are capped at 12 per page: 6 in the draft plus 6 in the published version.
- `publicProfile` returns `studio` only when `options.studio && plan === 'pro' && published !== null`. It is built from `resolveStudio(published, lagosToday)`, with gallery ids resolved to paths and dangling ids dropped.

- [ ] **Step 1: Write the failing integration tests**

```js
test('a Pro page saves, publishes and serves its Studio document', ...);
test('a save with an old rev is refused and keeps the newer draft', async () => {
  const a = await saveStudioDraft(db, user, { rev: 0, draft: D1 });
  await assert.rejects(saveStudioDraft(db, user, { rev: 0, draft: D2 }), { code: 'STUDIO_DRAFT_STALE' });
  assert.deepEqual((await getMyStudio(db, user, TODAY)).draft, a.draft);
});
test('a Free page cannot save; its preview is never stored', ...);
test('publish after Pro ended is refused and the draft is kept', async () => {
  await setStaffPro(tx, page, false, now);
  await assert.rejects(publishStudio(db, user, { rev }), { code: 'PRO_REQUIRED' });
  assert.equal((await getMyStudio(db, user, TODAY)).access, 'lapsed');
});
test('the public page gets no studio while Free, and the same one back when Pro resumes', ...);
test('another page’s image id is refused in a draft', ...);
test('discard and publish remove unreferenced images only', ...);
test('a stored document with a removed palette still resolves', ...); // writes raw jsonb
test('staff can view and remove one gallery image; it drops out of both versions; audited', ...);
```

- [ ] **Step 2: Run and watch them fail**: `pnpm exec turbo run build --filter=!@tipme/web && TIPME_IT_TEMPLATE=tipme_it_studio node scripts/test-integration.mjs tests/integration/studio.test.mjs` (read `scripts/test-integration.mjs` for the exact private-template flag)
- [ ] **Step 3: Implement** the schema, generate the migration with drizzle-kit, and implement the operations.
- [ ] **Step 4: Run and watch them pass**, plus the existing `profiles`/`pro-periods` integration tests.
- [ ] **Step 5: Commit**: `feat(database): Page Studio drafts, published versions and gallery images`

---

### Task 6: The Studio API, image crops and the switch

**Files:**

- Create: `apps/api/src/studio/studio.controller.ts`, `studio.module.ts`, `studio-crops.ts`
- Modify: `apps/api/src/config.ts` (`PAGE_STUDIO_ENABLED: flag`), `apps/api/src/profiles/public-profile.controller.ts` (pass `studio: config.PAGE_STUDIO_ENABLED`), `apps/api/src/checkout/rate-limit.guard.ts` (bucket `studio_drafts`: 60/min; images reuse `avatars`), `apps/api/src/app.module.ts`, `deploy/*.env.example`
- Regenerate: `pnpm api:openapi`, `pnpm docs:generate` (both `--check` clean)
- Test: `apps/api/test/studio.controller.test.ts` (the API's e2e-style supertest suite), `apps/api/test/studio-crops.test.ts`

**Interfaces:**

- Consumes: Task 5 operations; `readUpload`, `withSlot`, `sendImage`, `sendPrivateImage`.
- Produces (all `SessionGuard`; writes add `CsrfGuard`; 404 `NOT_FOUND` when the switch is off):
  - `GET /v1/me/studio` → `MyStudio`
  - `PUT /v1/me/studio/draft` body `{ rev, draft }` → `MyStudio` (409 `STUDIO_DRAFT_STALE`, 403 `PRO_REQUIRED`, 400 validation)
  - `POST /v1/me/studio/publish` body `{ rev }` → `MyStudio`; revalidates the handle and publishes `profile.changed`
  - `DELETE /v1/me/studio/draft` → `MyStudio`
  - `POST /v1/me/studio/images` (raw image body) → `MyStudio` (422 `IMAGE_TOO_SMALL`, 409 `STUDIO_IMAGE_LIMIT`)
  - `PUT /v1/me/studio/images/:imageId/focus` body `{ focalX, focalY }` (integers 0–100) → `MyStudio`
  - `GET /v1/me/studio-images/:imageId/:file` (owner preview, private, no-store)
  - `GET /v1/studio-images/:profileId/:imageId/:file` (public; only for a live, Pro page whose **published** version uses it)
  - `studio-crops.ts`: `export async function masterOf(input: Buffer): Promise<{ master: Buffer; width: number; height: number }>` (rotate, then fit inside 2240×2240, WebP; the size is checked after rotation against the larger of the two shapes' minimums) and `export async function cropsOf(master: Buffer, focalX: number, focalY: number): Promise<{ square: Buffer; strip: Buffer }>`.

The crop algorithm (`cropsOf`): for each shape, the largest rectangle with the shape's aspect ratio that fits the master, centred on (focalX%, focalY%) of the master and clamped inside its edges. `sharp.extract` that rectangle, then `resize(shape.width, shape.height)` → WebP q80.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses a photo below 512×512 after rotation with IMAGE_TOO_SMALL', ...);   // 700×500 JPEG with EXIF orientation 6 is 500×700: refused
it('accepts 512×512 with stripOk false, and 1120×300 or larger with stripOk true', ...);
it('crops around the focal point and keeps it in view', async () => {
  const { square } = await cropsOf(master(3000, 1000, redDotAt(2700, 500)), 90, 50);
  expect(pixelAt(square, 0.5 + offsetOf(...))).toBeRed();
});
it('strips metadata: no EXIF/XMP/ICC chunks in any stored crop', ...);
it('every Studio route is 404 while PAGE_STUDIO_ENABLED is off, and the public profile has no studio', ...);
it('a Free account gets 403 PRO_REQUIRED on every write', ...);
it('publish revalidates the page', ...);
it('the public image route refuses a draft-only image and a lapsed page', ...);
```

Minimum-size rule (the note on the first test): an upload is accepted when it meets the **square** minimum. `MyStudio.images[]` gains `stripOk: boolean` (master ≥ 1120×300), and the schema refuses a strip-shaped use of an image whose `stripOk` is false. The board's gallery leads with one strip tile in Portfolio first. So the editor offers "Use as the wide photo" only for `stripOk` images (Task 9).

- [ ] **Step 2: Run and watch them fail**: `pnpm --filter @tipme/api test -- studio`
- [ ] **Step 3: Implement** the controller, crops and switch; add the env line to every `*.env.example`.
- [ ] **Step 4: Run and watch them pass**; then `pnpm api:openapi && pnpm docs:generate && pnpm api:openapi --check && pnpm docs:generate --check`
- [ ] **Step 5: Commit**: `feat(api): Page Studio drafts, publish and gallery images behind PAGE_STUDIO_ENABLED`

---

### Task 7: The public page shows the Studio page, within budget

**Files:**

- Modify: `apps/web/src/app/people/[handle]/page.tsx` (when `profile.studio` is present, render `StudioPage` with today's `cover`, `identity`, `tipBlock` and `footer` nodes, unchanged; otherwise today's markup, byte for byte)
- Modify: `tests/e2e/profile-fixtures.ts` (`PAGES` gains `studio-kemi`, `studio-sule`, `studio-ify`: the three board examples)
- Create: `tests/e2e/studio-page.spec.ts`
- Modify: `tests/e2e-perf/lcp.spec.ts` (a Studio sample, same < 2000 ms assertion)

**Interfaces:**

- Consumes: `StudioPage` (Task 3), `PublicProfile.studio` (Task 2).
- Produces: nothing new for later tasks. The JSX the public page builds for the tip block is extracted to `function TipBlock(props): JSX.Element` in the same file, used by both branches.

- [ ] **Step 1: Write the failing spec** (stand-in stack, `startStack('test')`)

```ts
test('a Studio page keeps TipMe’s tip block, fee line, badge, report link and footer @mobile', async ({ page }) => {
  await page.goto(`${stack.origin}/@studio-kemi`);
  const tip = page.getByRole('complementary', { name: 'Tip Kemi' });
  await expect(tip.getByRole('button', { name: /Tip ₦/ })).toBeVisible();
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Report this page' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Gallery' })).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
});
test('a profile without studio renders exactly today’s page', ...);   // same DOM snapshot of main as before the change
test('nothing loads from a video site before the tap', async ({ page }) => {
  const thirdParty: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith(stack.origin) && !r.url().startsWith(API_ORIGIN)) thirdParty.push(r.url()); });
  await page.goto(`${stack.origin}/@studio-kemi`);
  await page.getByRole('region', { name: 'Videos' }).scrollIntoViewIfNeeded();
  expect(thirdParty).toEqual([]);
});
test('a Studio page ships at most 3 KB more script than the standard page', async ({ page }) => {
  const studio = await scriptBytes(page, '/@studio-kemi');
  const standard = await scriptBytes(page, '/@kemi');
  expect(studio - standard).toBeLessThanOrEqual(3 * 1024);
});
test('a page using Soft loads the italic font; others never request it', ...);
```

`scriptBytes` sums the `encodedBodySize` of `performance.getEntriesByType('resource')` entries whose `initiatorType === 'script'`, after `load`.

- [ ] **Step 2: Run and watch it fail** on your lane (only these specs).
- [ ] **Step 3: Implement** the branch and the fixtures.
- [ ] **Step 4: Run and watch it pass**; run `profile-page.spec.ts` and `profile.visual.spec.ts` to prove the standard page did not move. Run `pnpm perf:lab` locally once and record the Studio sample in the PR (lab only; CI does not run it).
- [ ] **Step 5: Commit**: `feat(web): the public page renders a published Studio page`

---

### Task 8: The editor

**Files:**

- Create: `apps/web/src/app/dashboard/studio/page.tsx`, `studio-editor.tsx` (client), `theme-tab.tsx`, `sections-tab.tsx`, `layout-tab.tsx`, `section-forms.tsx` (about/links/pinned/services/events), `publish-dialog.tsx`, `why-limits-dialog.tsx`, `use-studio-draft.ts`
- Modify: `apps/web/src/app/dashboard/settings/sections/my-page.tsx` ("Open Page Studio" for Pro; the teaser card for Free; the "kept" note while lapsed, with the board's copy)
- Create: `tests/e2e/studio-editor.spec.ts`

**Interfaces:**

- Consumes: the Task 6 endpoints, `StudioPage` (the preview is the real renderer), `useLiveForm` / `ChangedElsewhere` (as `my-page.tsx` uses them), `ConfirmDialog`.
- Produces:
  ```ts
  export function useStudioDraft(initial: MyStudio): {
    draft: StudioDocument;
    rev: number;
    saving: boolean;
    stale: boolean;
    change(next: StudioDocument, label: string): void; // pushes undo, debounced save (800 ms)
    undo(): void;
    canUndo: boolean; // this session only
    discard(): Promise<void>;
    publish(): Promise<void>;
    summary: string[]; // "Added Events", "Moved Gallery to the top" for the dialog
  };
  ```

Behaviour, from the StudioEditor board:

- Three tabs: Theme, Sections, Layout. The preview switches between Phone and Desktop. "3 changes not published yet · draft saved".
- Every choice is a radio group or list of registry entries. There is no input that takes a colour, size or position.
- Reorder: drag (pointer) and Up/Down buttons, plus Arrow keys on the focused row. `aria-live` says "Events, moved to position 3 of 5". The tip block row is shown, locked ("Always TipMe. Can't be moved, styled or removed.") and not focusable as a drag target.
- "Add a section" lists only kinds not yet used. It is disabled at the layout's maximum, with the reason in words.
- Counters show as you type ("212 of 280"). Inputs carry `maxLength` equal to the limit.
- Publish never blocks for design reasons. It waits only for required fields (an event's date and title, a service's name and price).
- "Discard changes" confirms once.
- "Why can't I…?" opens the board's six reasons verbatim.
- Free: `access: 'preview'`. The whole editor works on an in-memory draft, with the banner "Preview only: not published" and the sheet "Like it? Page Studio comes with Pro." + "See Pro". There are no API writes, and the Pro badge is hidden in the preview.
- Lapsed: read-only, the board's note.

- [ ] **Step 1: Write the failing e2e** (real e2e API, a staff-granted Pro page)

```ts
test('a Pro person picks a theme, adds Services, reorders by keyboard and publishes @mobile', async ({ page }) => {
  // …choose Ocean, dark, Editorial, Portfolio first; add Services; Arrow-move Events to position 1;
  await expect(page.getByRole('status')).toContainText('moved to position 1 of');
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('dialog', { name: 'Publish your page?' }).getByRole('button', { name: 'Publish' }).click();
  await page.goto(`/@${handle}`);
  await expect(page.getByRole('region', { name: 'Services and prices' })).toBeVisible();
});
test('no control in the editor accepts a colour, font size or position', async ({ page }) => {
  expect(await page.locator('input[type=color], input[type=range], [contenteditable]').count()).toBe(0);
});
test('a second tab’s save shows “changed elsewhere” and loses nothing', ...);
test('Undo brings a removed section back whole; Discard returns to the published page', ...);
test('Free sees the teaser and a preview that is never published', ...);
test('the editor is accessible on each tab', async ({ page }) => { for (const tab of TABS) { await openTab(tab); await expectAccessible(page); } });
```

- [ ] **Step 2: Run and watch it fail**; **Step 3: implement**; **Step 4: run and watch it pass** (only these specs, on your lane).
- [ ] **Step 5: Commit**: `feat(web): Page Studio editor with live preview, undo and publish`

---

### Task 9: Media sections: gallery, focal point, video, CSP

**Files:**

- Create: `apps/web/src/app/dashboard/studio/gallery-form.tsx`, `focal-point.tsx`, `videos-form.tsx`
- Modify: `apps/web/src/lib/shrink-photo.ts` (an option `minSide`, so shrinking never drops below the minimum), `apps/web/src/lib/photo-errors.ts` (`IMAGE_TOO_SMALL` → the board's copy, "This photo is too small for the gallery. Choose one at least 512 by 512 pixels, so it looks sharp on every screen."), `apps/web/next.config.ts` (`frame-src` = `STUDIO_EMBED_ORIGINS.join(' ')`; `img-src` unchanged)
- Test: `tests/e2e/studio-media.spec.ts`, `scripts/csp.test.mjs` (new, or extend the existing headers test if one exists)

**Interfaces:**

- Consumes: the image endpoints (Task 6), `parseVideoLink` (Task 2), `VideoEmbed` (Task 3).
- Produces: `FocalPoint` (props `{ src: string; x: number; y: number; onChange(x: number, y: number): void }`): pointer drag plus Arrow keys (5% per press, Shift 20%), `role="slider"`-free. It uses two labelled number-free controls: a draggable marker button with `aria-label="Focal point, 50% across, 50% down"` that moves with arrow keys.

The client checks the decoded size before upload (`createImageBitmap` with `imageOrientation: 'from-image'`) and shows the refusal without uploading. The server check (Task 6) is still the authority. The video form refuses links that aren't allow-listed with "We can't show videos from that site yet."

- [ ] **Step 1: Write the failing tests**

```ts
test('a too-small photo is refused before upload, in plain words', ...);         // 400×400 PNG, no request to /v1/me/studio/images
test('a gallery photo is cropped for each shape and the focal point keeps the subject in view', ...);
test('an Instagram or unknown video link is refused; a YouTube one shows a TipMe still', ...);
test('tapping play loads youtube-nocookie only then', async ({ page }) => {
  // request listener empty before; after click, exactly one request host www.youtube-nocookie.com (route-fulfilled in test, never the real site)
});
```

```js
test('the CSP frames only the allow-listed embed origins', () => {
  assert.match(
    cspOf(nextConfig),
    /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/www\.tiktok\.com https:\/\/audiomack\.com;/,
  );
  assert.match(cspOf(nextConfig), /frame-ancestors 'none'/);
});
```

E2E never reaches the real video sites: route `**/embed/**` to a local 200 page.

- [ ] **Steps 2–4:** fail, implement, pass (only these specs).
- [ ] **Step 5: Commit**: `feat(web): Studio gallery with focal points and click-to-load videos`

---

### Task 10: When Pro lapses, and the runbook

**Files:**

- Create: `tests/e2e/studio-lapse.spec.ts`, `docs/runbooks/page-studio.md` (the switch, what staff can remove, what lapse does, how to retire a palette safely: remove the entry; `resolveStudio` falls back)
- Modify: `apps/web/src/app/dashboard/settings/sections/plan.tsx` (Pro benefits list: "Page Studio"), `apps/web/src/app/pro/…` copy only if the /pro page lists features (check first), `docs/runbooks/admin-roles.md` (line for `pages.suspend` now covering gallery images; `ops-catalogue.test.mjs` reads it)

**Interfaces:** consumes everything above; produces nothing.

- [ ] **Step 1: Write the failing e2e** (staff grant on/off through the ops API, like `pro.spec.ts`)

```ts
test('Pro ends: the standard page shows; Pro resumes: the same Studio page is back @mobile', async ({ page }) => {
  await publishSampleStudio(handle);
  await setStaffPro(handle, false);
  await page.goto(`/@${handle}`);
  await expect(page.getByRole('region', { name: 'Gallery' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Get your own TipMe page' })).toBeVisible();
  await page.goto('/dashboard/studio');
  await expect(page.getByText('Your Studio design is kept')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await setStaffPro(handle, true);
  await page.goto(`/@${handle}`);
  await expect(page.getByRole('region', { name: 'Gallery' })).toBeVisible();
});
test('an unpublished draft stays a draft through a lapse', ...);
test('a gallery image is not served while the page is lapsed', ...);
```

- [ ] **Steps 2–4:** fail, implement copy and docs, pass.
- [ ] **Step 5: Commit**: `test(e2e): Page Studio survives a Pro lapse; runbook`

---

### Task 11: Supporter wall, with a second, separate yes (last; its own switch)

**Files:**

- Modify: `packages/database/src/schema.ts` (table `supporter_wall_consents(tip_id uuid PK → tips, profile_id, name text NOT NULL CHECK length ≤ 40, created_at, withdrawn_at NULL)`; the money tables gain no column), drizzle-kit migration
- Modify: `packages/contracts/src/checkout.ts` (optional `showOnWall?: true` on the intent request, only with a typed name), `studio.ts` (`STUDIO_SUPPORTER_WALL = true`), `apps/api/src/config.ts` (`SUPPORTER_WALL_ENABLED: flag`), `apps/web/src/components/appreciation-form.tsx` (a separate, unticked box, "Show my name on {first name}'s page", shown only when the page is Pro, the wall section is published and a name is typed), `apps/web/src/app/tip/[tipId]/status-view.tsx` ("Take my name off {first name}'s page")
- Regenerate OpenAPI and docs. Lands alone or in a train with any other open API PR.
- Test: `tests/integration/supporter-wall.test.mjs`, `tests/e2e/supporter-wall.spec.ts`

**Interfaces:**

- Produces: `PublicStudioSection` `{ kind: 'supporters'; names: string[] }` (newest first, max 24, paid tips only, no amounts, no counts, no dates).
- The consent is recorded in the intent fingerprint only when given (the `intents.ts:92-103` trick, so fingerprints without it stay byte-identical). The repeat-supporters recognition opt-in never implies it, and the reverse holds too.

- [ ] **Step 1: Write the failing tests**: `recognition consent alone never shows a name on the wall`; `a wall consent shows the typed name only after the tip is paid`; `withdrawing from the receipt removes it on the next render`; `no amount or date reaches the public page`; `the box is absent when the wall switch is off or the page is Free`.
- [ ] **Steps 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit**: `feat: Studio supporter wall with its own opt-in`

---

## Self-review notes

- **Spec coverage:** themes, fonts, layouts and sections (Tasks 1–3, 8); AA and the 144-combination test (1, 4); images and focal points (6, 9); videos (2, 3, 9); fixed elements (3, 4, 7); no custom code (2, 3); performance (7); lapse (5, 10); Free teaser (8); moderation (5); supporter wall (11). Custom domain and section analytics are out of scope (board "Later").
- **Names used across tasks:** `StudioDocument`, `PublicStudio`, `MyStudio`, `resolveStudio`, `studioStyle`, `StudioPage`, `studioImagePathOf`, `cropsOf`, `STUDIO_EMBED_ORIGINS`, `PAGE_STUDIO_ENABLED`, matching wherever they appear.
