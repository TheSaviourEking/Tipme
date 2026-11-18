# Page Studio, phase 2: finished page styles (design)

**Date:** 17 Nov 2026 · **Status:** design for review · **Base:** `origin/dev` at `d47bebfe`

**Sources.** Canvas "Studio Page Styles", https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q (version `1794876761-e949`, pass 2, 17 Nov). The canvas is the visual authority: when this document and a canvas board disagree on a look, the board wins, except where this document names the disagreement (section 15). Background: the style research brief of 16 Nov (`studio-style-research.md`). Earlier work: plan `docs/superpowers/plans/2026-11-12-page-studio.md`, here called "the plan". Its tasks 1 to 8 and G1 and G2 are built; G3 is not.

**Not an approval.** This is a product and design decision only. It is not legal, data-protection, regulatory or payment-partner approval. D-07 stays OPEN (`docs/00-DECISIONS.md`). Nothing here changes a fee, a minimum, a checkout amount, a ledger posting or a payout.

**How decisions are marked.**

- **(owner decided)**: the owner's words or ruling. Binding.
- **(my call)**: decided by the coordinator who wrote this document. The owner has not ruled; change it only through the coordinator.
- **(builder's call)**: the builder decides, within the rules given, and says what they chose in the PR.

---

## 1. Intent

Recipients stop designing pages. They choose one of nine finished styles, and inside a style they choose only a few things that cannot break it.

Why: free colour, font and layout controls let a page drift into something cheap, and a design check can only catch so much. The owner, 16 Nov: "No bad UI, no bad design… everything should just fit in… Tesla, Nike, Apple… cohesive." Nine styles, each finished and tested in every combination, make a bad page impossible by construction.

## 2. Owner decisions this design carries

1. **16 Nov (owner decided):** recipients get **no free colour, font or layout controls**. They choose one finished style. Inside it they choose only:
   - the **accent**, from a tested set, plus **"From your photo"** on Pro;
   - **light, dark or auto**;
   - the **cover type**: photo, gradient or plain;
   - the **block order**.
2. **Nine styles (owner decided):** Classic (today's public page look, unchanged), Clear, Journal, Stage, Signboard, Sprint, Tiles, Linen, Horizon. The owner liked the canvas.
3. **17 Nov (owner decided):** Classic is free and is the **default for every page that never picks a style**, "so nothing changes for anyone who never opens Studio". **Free styles:** Classic, Clear, Journal, Linen. **Pro styles:** Stage, Signboard, Sprint, Tiles, Horizon.
4. **Classic (owner decided)** stays today's look and is exempt from the newer family laws, with three exceptions:
   - money is set in **Inter**;
   - **Inter is the fallback for names**. A separate PR is fixing this site-wide now. This work depends on it and does not redo it;
   - the **darker hint colour**: `--text-tertiary` goes from `#77736B` to `#6E6A63` in `packages/ui/src/tokens.css`. That is 4.59:1 on the Other-amount well and 5.38:1 on white. Leave `--border-control` alone, even though it has the same value today. If the site-wide PR doesn't change this token, this work does.
5. **Classic gets the same choices (owner decided (17 Nov)).** The coordinator proposed it and the owner approved ("Your defaults work"). Inside Classic, people get the same choices as in the other styles:
   - accent: the tested set, plus "From your photo" on Pro;
   - light, dark or auto;
   - cover type;
   - block order.

   Classic's look stays today's look:
   - the accent replaces today's purple only where today's page uses its accent: the selected amount key, link and focus colour, and the purple in the wordmark;
   - dark mode uses the derived dark palette from the canvas;
   - blocks render in Classic's existing visual treatment.

   The exemptions in item 4 stay.

6. **Copy (owner decided):** users never see the payment provider's name; it is always "our payment partner". **Tests (owner decided):** no real payments.
7. **Still to build from the plan ("G3") (owner decided):** a publish gate (the design check must pass to publish), undo, discard draft, Free users preview Pro styles but can't publish them, and what happens when Pro lapses. Section 12 adapts each of these to styles.

## 3. Goals, non-goals, anti-goals

**Goals**

- Every published page looks finished in every accent, mode, cover type and block order. The proof is a finite, exhaustive test, not a hope (section 14).
- No visible change for pages that never open Studio. Classic stays byte-for-byte today's markup.
- Free recipients get real choice: four styles and eight accents. Pro adds five styles, the photo accent and media blocks.
- Every style renders Nigerian names and ₦ in a single face, with no glyph mixing.
- Every style stays inside today's performance budgets.

**Non-goals**

- New block kinds, custom domains, block analytics (they wait on D-07), the supporter wall (plan Task 13, unchanged), campaign pages in a style (campaign links keep the standard page, as today).
- A tenth style, user-made styles, or per-block styling.

**Anti-goals** (things this design must never allow)

- Any stored colour, font, size, radius, spacing, column split or CSS chosen by the recipient.
- A second accent on a page, accent-coloured body text, or text on a photo without its scrim.
- A name drawn in two faces, or ₦ from a fallback face.
- A Free page publishing anything Pro, or a lapsed page losing data.
- Loading any style's CSS or fonts on a page that doesn't use that style.

## 4. Constraints

### 4.1 Glyph coverage

- **Required in every face that sets a name or heading:** ₦ (U+20A6); Yoruba ẹ Ẹ ọ Ọ ṣ Ṣ ǹ and the combining grave, acute and dot below (U+0300, U+0301, U+0323); Igbo ị ụ ṅ; Hausa ɓ ɗ ƙ ƴ Ɓ Ɗ Ƙ Ƴ.
- **Faces, checked against the Google Fonts TTFs.** The brief checked them on 16 Nov; I re-checked Gentium Book Plus, Unbounded, Anton and Source Serif 4 on 17 Nov with a cmap reader.

  | Face                                        | Used by                                                                | ₦ + Yoruba + Igbo            | Hausa hooked letters                       |
  | ------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
  | Inter                                       | every style (UI, body, money); display in Clear, Stage, Tiles, Horizon | yes                          | yes                                        |
  | Source Serif 4                              | Journal                                                                | yes                          | **no**, so it uses the whole-name fallback |
  | Unbounded                                   | Signboard                                                              | yes                          | yes                                        |
  | Anton                                       | Sprint                                                                 | yes                          | yes                                        |
  | Gentium Book Plus (400, 700, 400 italic)    | Linen                                                                  | yes                          | yes                                        |
  | Manrope, DM Serif Display (today's subsets) | Classic                                                                | **no ₦, no ẹ ọ ṣ, no hooks** | **no**                                     |

- **Whole-name fallback (owner decided for Classic; family law for the rest):** if the display face lacks any character in a name or heading, the whole string is set in Inter 700 (the heading's own weight for headings). It is never mixed letter by letter.
- **Money (owner decided):** always Inter with tabular, lining figures, and ₦ tight against the digits in the same face.
- Self-host every file as WOFF2, subset to `STUDIO_REQUIRED_CODEPOINTS`. The bundled subset must pass the existing coverage test in `studio-type.test.mjs`, extended to the Hausa letters. Source Serif 4 is marked `wordFallback: true`. **(my call)**

### 4.2 Contrast

Section 7.3 has every accent value with its ratios.

- WCAG 2.x minimums, in light and in dark:
  - text 4.5:1;
  - large text (24 px and up, or 18.66 px bold) 3:1;
  - non-text UI 3:1: focus ring, selected outline, control borders.
- Text over a photo is white only, over at least a **55% black scrim** wherever normal-size text sits. Display names need at least 42%. The scrims drawn for Stage and Horizon meet this (section 9).
- Dark mode never uses `#000` surfaces. Higher surfaces are lighter, not shadowed.

### 4.3 Performance

- **Classic:** no change at all for a page that never picks a style, or that publishes Classic with its defaults (no accent, light, today's cover, no blocks). Its HTML, CSS and fonts are byte-identical to today's standard page, and the existing test `a profile without studio renders exactly today's page` also covers that case. **(my call)** A Classic page with other choices (an accent, dark or auto, a cover type, blocks) renders today's markup plus Classic's token overrides and block styles. It loads no new font: blocks use Manrope and DM Serif, money stays Inter. **(my call)**
- **LCP:** each style's example page at 390 px stays under 2000 ms in the lab LCP test (`tests/e2e-perf/lcp.spec.ts`: 4× CPU, Fast-3G-like). `/@tobi` must not move. Field target from `AGENTS.md`: LCP ≤ 2.0 s, CLS ≤ 0.05, INP ≤ 150 ms.
- **CSS budget:** Next.js links the Studio stylesheet on every `/@username` page, not only on styled ones (`apps/web/test/route-css.test.mjs`). So:
  - All Studio CSS that a **standard or Classic** profile page downloads stays **≤ 8 KB gzip**. Today it is 4.6 KB. This includes Classic's dark tokens, accent overrides and block styles, because they are linked on every profile page. **(my call)**
  - A **styled** page downloads at most **12 KB gzip** of Studio CSS. **(my call)**
  - Add both as tests beside the existing home-page budget test. How to meet them is the builder's call: per-style rules scoped `.studio[data-style=…]`, or per-style CSS modules imported by the style's component.
  - The existing rules stay: no Studio CSS in `globals.css` or the root layout, and every selector is scoped to `.studio` or `.profile-page--studio`.
- **Fonts per style only:**
  - A page emits `@font-face` only for Inter plus its own display face: at most 2 families, 4 files and 200 KB in total, and at most 100 KB per file (plan limits, kept).
  - Preload only the face that sets the name.
  - Studio's Inter file must cover weights **400 to 800**. The canvas uses 500, 550, 600, 650, 700, 750 and 800. Today's `inter-400-700.woff2` stops at 700. **(my call)**
  - Whether the `opsz` axis fits the byte budget is the builder's call. Without it, tighten tracking as in section 8.
- **Script:** no style adds client script, except the sticky bar's `IntersectionObserver` inside the existing tip form (section 8). **(my call (coordinator, 17 Nov))** The script-size budget test (`a Studio page ships at most 3 KB more script than the standard page` and `scripts/web-bundle.test.mjs`) is raised by the **measured** increase only, and the PR states the before and after bytes.

### 4.4 Accessibility

- WCAG 2.2 AA. Every target is at least 44×44 px, and the Tip button is 48 to 56 px tall.
- Focus is a visible 2 px ring in the accent, offset 2 px (Signboard and Tiles: 3 px). Horizon's glass button uses a white ring.
- Chips keep the tip form's existing semantics (radio or pressed state, as `AppreciationForm` has today). The selected amount is never shown by colour alone: it also has a border, fill or thumb change, as drawn.
- Name and bio wrap with `text-wrap: balance`, and paragraphs with `pretty`.
- axe is clean on every style in both modes.
- Auto mode is plain CSS (`prefers-color-scheme`), with no script and no flash.

### 4.5 Reduced motion

- Motion lasts 150 to 400 ms and animates opacity and transform only, with one curve per style (section 9).
- Under `prefers-reduced-motion: reduce`: fades only. No scale, slide, press-travel, thumb slide, count-up or hover lift. The CSS for each style is on its board.

### 4.6 Copy and privacy

- Pronoun "they".
- "Our payment partner", never the provider's name.
- Never imply regulatory approval.
- Use canvas copy word for word where the canvas gives it.

---

## 5. The style system as data

### 5.1 Contracts (`packages/contracts`)

Names are suggestions. The builder may rename them, and each rename is the builder's call. The shapes are **(my call)**.

```ts
export const STUDIO_STYLE_IDS = [
  'classic',
  'clear',
  'journal',
  'stage',
  'signboard',
  'sprint',
  'tiles',
  'linen',
  'horizon',
] as const;
export type StudioStyleId = (typeof STUDIO_STYLE_IDS)[number];

export const STUDIO_ACCENT_IDS = [
  'ink',
  'blue',
  'lagoon',
  'green',
  'violet',
  'rose',
  'coral',
  'amber',
  'photo',
] as const;
export type StudioAccentId = (typeof STUDIO_ACCENT_IDS)[number];
export interface StudioAccentValues {
  fill: Hex;
  label: Hex;
  text: Hex;
} // section 7.3
export const STUDIO_ACCENTS: Record<
  Exclude<StudioAccentId, 'photo'>,
  { name: string; light: StudioAccentValues; dark: StudioAccentValues }
>;

export type StudioCoverType = 'yours' | 'gradient' | 'plain'; // 'yours' = the cover set in Settings

export interface StudioStyle {
  id: StudioStyleId;
  name: string; // "Clear"
  mood: string; // section 9, shown in the Style tab
  plan: 'free' | 'pro';
  displayFont: StudioFontId | null; // null: Inter only
  defaultAccent: Exclude<StudioAccentId, 'photo'> | null; // null: Classic (today's purple)
  naturalMode: 'light' | 'dark';
  modes: readonly StudioMode[]; // every style: light, dark, auto
  covers: readonly StudioCoverType[]; // UI order; 'yours' first in every style; Signboard and Sprint: no 'gradient'
  needsPhoto: boolean; // Stage, Horizon: a non-photo cover renders the gradient treatment
  linksAt: 'after-identity' | 'after-tip' | 'rail'; // fixed links position, section 8
  neutrals: { light: StudioNeutrals; dark: StudioNeutrals }; // section 9
}
export const STUDIO_STYLES: Record<StudioStyleId, StudioStyle>;
export const STUDIO_FREE_STYLES: readonly StudioStyleId[]; // derived: plan === 'free'
```

`StudioNeutrals` holds `bg`, `card`, `el2`, `fg`, `fg2` and `line`, plus any extras a style names in section 9.

Radii, type sizes, spacing and motion are **not** data. They live in each style's CSS, keyed by `data-style`. The registry holds only what the API, the check or the editor must know. **(my call)**

### 5.2 The saved document (v2)

```ts
export interface StudioDocument {
  v: 2;
  style: StudioStyleId;
  accent: StudioAccentId | null; // null = this style's default accent
  mode: StudioMode; // 'light' | 'dark' | 'auto'
  cover: StudioCoverType;
  blocks: StudioBlock[]; // the order is the page order
}
```

- **`accent: null`** means "use the style's own default". Switching style then shows that style's default, while an accent the person picked stays picked across styles, so "each style opens differently" holds. **(my call)**
- **For Classic,** `accent: null` means today's purple (`#7A32F9`, dark `#C8AEFF`). Classic keeps all choices, like any other style. **(owner decided (17 Nov))**
- **Block kinds and content stay as today,** minus presentation:
  - `text`: `variant` is `'heading' | 'paragraph'`. `lead` becomes `paragraph`, and a heading has no `level`; the style renders headings as its section title, as an `h2`.
  - `photo`, `gallery`, `video`, `services`, `events`, `quote`, `supporters` (still refused until plan Task 13): **no `variant`**. The style decides shape, grid and treatment. **(my call)**
  - `about` is **removed**. The bio always sits in the identity, at the top (the shared skeleton, section 8). **(my call)**
  - `links` is **removed**. Profile links are a fixed part of every style's skeleton, not a block (section 8). **(my call (coordinator, 17 Nov))**
- **`cover`** defaults to `'yours'` in every style. **(my call (coordinator, 17 Nov))**
- **Limits are unchanged** (`studio-limits.ts`): 40 blocks, 24 photos per page, 9 per gallery, 3 videos, 6 events, 12 services and the text limits. `rows` and `blocksPerCell` are gone.

**No longer stored:** `brand`, `fonts`, `scale`, `corners`, `rows`, column splits, row `spacing`, row `background` (including photo backgrounds), block `variant`, text `level`, `about`, `links`. The colour engine (`deriveStudioPalette`) stays, used only for the photo accent (section 6). The 14-family font registry shrinks to the faces in 4.1. Whether unused font files are deleted in the same PR is the builder's call. If they go, their register entries go too.

### 5.3 What else is stored (my call)

- **The photo accent:** a column on `page_studios`, `photo_accent jsonb NULL`, holding `{ source: 'avatar', avatarVersion, light: StudioAccentValues, dark: StudioAccentValues } | { failed: true, fallback: AccentId, avatarVersion, nothingSampled?: true }`. Both kinds name the photo they came from, and a value for any other photo reads as none, so a fallback never outlives its photo **(controller ruling AH, Task 11 review)**. It is written only by the server (section 6). It needs a drizzle-kit migration. Putting it on `page_studios` rather than `profiles` is the builder's call.
- **Nothing else changes in the database.** `draft` and `published` stay jsonb, and `rev`, `published_check_version` and images stay as they are.

### 5.4 API (my call)

- **Routes are unchanged:** `GET /v1/me/studio`, `PUT …/draft`, `POST …/publish`, `DELETE …/draft`, images and focus. All still answer 404 while the `page_studio` admin switch is off (owner, 14 Nov: an admin switch, no variable), which is the case in production.
- **`MyStudio` gains** `plan: 'free' | 'pro'` and `photoAccent: { light; dark } | { failed: true; fallback } | null`.
- **`access` becomes `'edit'` for every page,** Free included, because Free can now publish free styles. `'preview'` and `'lapsed'` are retired. This supersedes the plan's ruling 8 ("Free: teaser + unpublished preview only") as a direct consequence of the 17 Nov decision.
- **`PublicStudio`** keeps `document`, `images` and `checkVersion`. `palette` becomes the resolved token map (neutrals plus accent values, light and dark) that the renderer writes as `--studio-*` custom properties.

### 5.5 The design check (version 3) (my call)

`checkDesign` stays the one engine for the editor, the API and publish. Bump `DESIGN_CHECK_VERSION` to 3. The context gains `plan`, `coverKind` (photo, design, automatic, animated, none) and `hasAvatar`.

| Rule                                                                              | Status                                                       | Error when                                                                                             | Fixes                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pro-only`                                                                        | **new**                                                      | `plan !== 'pro'` and the document uses a Pro style, `accent: 'photo'`, or a Pro block (section 11)     | "Choose a free style" (opens the style cards; needs input), "Use {default accent name}" (pure), "Remove the block" (pure), "See Pro" (link) |
| `photo-resolution`, `photo-alt`, `empty-block`, `broken-video`, `page-weight`     | kept                                                         | as today, with slot widths taken from the style's layout instead of `cellWidths`                       | as today, minus fixes that named columns ("Use 2 columns", "Make the photo smaller" by column)                                              |
| `long-word`                                                                       | kept                                                         | a heading word, measured in the style's display face at 320 px, exceeds the column                     | "Use a shorter heading" (needs input)                                                                                                       |
| `cover-photo`                                                                     | **new, notice only** **(my call (coordinator, 17 Nov))**     | the style `needsPhoto` (Stage, Horizon), `cover: 'yours'`, and the cover set in Settings isn't a photo | none; the page renders the style's gradient treatment, with the notice "{Style} looks best with a cover photo. Add one in Settings."        |
| `name-fallback`                                                                   | **new, notice only**                                         | the display face lacks a letter of the name                                                            | "Your name has a letter {Face} can't draw, so it's set in Inter."                                                                           |
| `missing-links`                                                                   | **changed, notice only** **(my call (coordinator, 17 Nov))** | the person has no saved profile links                                                                  | none; the notice reads "Add links in Settings to show them on your page." The links area and Horizon's "See links" button are hidden.       |
| `contrast`, `contrast-on-photo`, `fonts`, `phone-fit`, `crowded`, `heading-order` | **removed**                                                  | the finite style set is proven in CI instead (section 14); headings have one level                     |                                                                                                                                             |

## 6. "From your photo" (Pro)

- **Source (canvas copy):** "Picked from your profile photo and checked for contrast in light and dark." The source is the profile photo (avatar). **(my call: avatar, not cover)**
- **When it is computed:** on the server, when the person picks it and again every time the avatar changes. The published page uses the stored value, and an avatar change revalidates the page through the existing `profile.changed`. **(my call)**
- **Algorithm** (the brief's §3.0.1, adopted) **(my call)**:
  1. Take up to 5 dominant colours from the 128 px rendition of the avatar.
  2. Drop near-greys (OKLCH chroma < 0.04) and low-chroma skin oranges (hue 20° to 90° under chroma 0.13, measured to drop every Monk scale tone and warm-lit skin alike) **(controller ruling AI)**.
  3. Clamp each candidate to the curated band: light fill L 0.45 to 0.55, dark fill L 0.75 to 0.82, keeping hue and capping chroma at 0.16.
  4. For each mode, pick the label (`#FFFFFF`, or the dark labels in 7.3) that reaches 4.5:1 on the fill. The text value is the fill, darkened in OKLCH lightness until it reaches **4.5:1 against every style's page and card surfaces in that mode, Classic's included**. Focus ring and selected outline: 3:1 against the same surfaces.
  5. Take the first candidate that passes everything. If none does, store `{ failed: true, fallback }` with the curated accent nearest in OKLab to the most dominant colour that survived step 2, or Ink when none did, so the fallback never depends on skin tone **(controller ruling AI)**. The editor then says: "Your photo's colours didn't pass our contrast check, so your page uses {Name}." **(my call, copy)** When the photo gave no clear colour at all (a smooth gradient), the value carries `nothingSampled` and the editor says: "We couldn't find a clear colour in your photo, so your page uses {Name}." **(builder's call, Task 11 review)**
  6. The same avatar always gives the same result: deterministic, with no randomness.
- **No profile photo:** the swatch is disabled, with the note "Add a profile photo to use this." **(my call)**
- **Reuse:** `studio-colour.ts` (OKLCH and contrast) and the existing image pipeline. Which pixel-sampling method is used is the builder's call. sharp is already a dependency.

## 7. Migration and the accent set

### 7.1 Existing drafts and published documents (v1 → v2) (my call)

Nothing is published in production, because the switch is off there. Staging, e2e fixtures and the lab examples hold v1 documents. `resolveStudio` converts v1 on read. Writes accept v2 only. There is no SQL backfill.

| v1                                                                  | v2                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fonts.heading` is `source-serif-4` or `fraunces`                   | `journal`                                                                                                                                                                                                   |
| otherwise, `mode: 'dark'`                                           | `stage`                                                                                                                                                                                                     |
| otherwise, `fonts` is DM Serif Display + Manrope                    | `classic`                                                                                                                                                                                                   |
| anything else                                                       | `clear`                                                                                                                                                                                                     |
| `brand[0]`                                                          | `accent` = the nearest of the 8 by OKLab distance at its light values; OKLCH chroma < 0.04 → `ink`; `#7a32f9` (the old default) → `null`                                                                    |
| `mode`                                                              | kept, for every style, Classic included                                                                                                                                                                     |
| (no cover)                                                          | `'yours'`                                                                                                                                                                                                   |
| `rows`                                                              | `blocks` in reading order: row by row, left column first, top to bottom                                                                                                                                     |
| `about` blocks, `links` blocks, row photo backgrounds, `supporters` | dropped. A dropped `links` block loses nothing: the profile links show in the skeleton. Photos from dropped blocks are unreferenced and are removed by the existing clean-up on the next publish or discard |
| block `variant`, text `lead`, `level`                               | dropped; `lead` → `paragraph`                                                                                                                                                                               |

- **The `published` jsonb** is converted the same way at read. The resolver is idempotent: v2 in gives the same v2 out.
- **Must rewrite to v2:**
  - the lab examples (`apps/web/src/app/dev/studio-lab/examples.ts`);
  - `studio-regressions.json`;
  - the e2e profile fixtures;
  - the property-test generator (`studio-arbitrary.mjs`).
- **Converted documents are pinned** as fixtures in a test.

### 7.2 Where the accent may go (family law, canvas)

- **Allowed:** the Tip button, the selected amount, the focus ring, and link underlines (1.5 px, in the accent's text value).
- **One exception per style at most:** Signboard's cover band, Tiles' Tip tile and link glyphs, and Stage's cover glow (dark only).
- **Never:** body text, card fills, or a second large surface.

### 7.3 The accent set (canvas "Family laws" and "Same page, every accent")

"Text min" is the lowest ratio of the text value against **every new style's page and card colour** in that mode (8 styles × 2 surfaces). Amber's light fill takes a dark label and a darker text value.

The canvas computed these before Classic took accents. The exhaustive contrast test (section 14) adds Classic's surfaces:

- light: `#F3F2EE`, `#FFFEFA`, `#EEEDE8`, `#FFFFFF`;
- dark: `#141210`, `#1E1B18`, `#2A2622`.

**(my call)** Any pair that fails there gets a Classic-only text value, darker in light mode and lighter in dark mode. Its lightness is searched with `studio-colour.ts`, in the same way as Amber's `#8A5800`.

| Accent               | Light fill | Light label | Fill/label | Light text  | Text min | Dark fill | Dark label | Fill/label | Dark text | Text min |
| -------------------- | ---------- | ----------- | ---------- | ----------- | -------- | --------- | ---------- | ---------- | --------- | -------- |
| Ink                  | #1D1D1F    | #FFFFFF     | 16.8       | #1D1D1F     | 14.5     | #F2F2F4   | #111113    | 16.9       | #F2F2F4   | 14.5     |
| Blue                 | #0A5BD3    | #FFFFFF     | 6.1        | #0A5BD3     | 5.3      | #7AB0FF   | #0E1116    | 8.5        | #7AB0FF   | 7.3      |
| Lagoon               | #00707A    | #FFFFFF     | 5.8        | #00707A     | 5.0      | #4FD1D9   | #0E1116    | 10.3       | #4FD1D9   | 8.8      |
| Green                | #0B7A4B    | #FFFFFF     | 5.4        | #0B7A4B     | 4.7      | #5FD49A   | #0E1116    | 10.2       | #5FD49A   | 8.8      |
| Violet               | #6B3FD0    | #FFFFFF     | 6.5        | #6B3FD0     | 5.6      | #B49BFF   | #0E1116    | 8.2        | #B49BFF   | 7.0      |
| Rose                 | #B8235F    | #FFFFFF     | 6.1        | #B8235F     | 5.3      | #FF8DB8   | #0E1116    | 8.8        | #FF8DB8   | 7.5      |
| Coral                | #C4362B    | #FFFFFF     | 5.4        | #C4362B     | 4.6      | #FF8A7A   | #0E1116    | 8.3        | #FF8A7A   | 7.1      |
| Amber                | #F2B12E    | #1A1300     | 9.8        | **#8A5800** | 5.2      | #F5C25A   | #1A1300    | 11.2       | #F5C25A   | 9.8      |
| From photo (example) | #A2461E    | #FFFFFF     | 6.1        | #A2461E     | 5.3      | #F29A6B   | #140C08    | 8.9        | #F29A6B   | 7.4      |

On Clear (the "every accent" board), the lowest ratio anywhere is **4.9:1**, for Violet on the dark segmented thumb. The board's per-accent numbers for label, text, chip and ring are the reference for the Clear snapshot tests.

**Default accent per style (canvas phone boards, pass 2):**

- Clear: **Blue**
- Journal: **Green**
- Stage: **Violet**
- Signboard: **Amber**
- Sprint: **Ink**
- Tiles: **Rose**
- Linen: **Coral**
- Horizon: **Lagoon**
- Classic: today's TipMe purple, `#7A32F9` light and `#C8AEFF` dark (`accent: null`). Any tested accent, or "From your photo" on Pro, can replace it. **(owner decided (17 Nov))**

---

## 8. Family laws (every style but Classic; canvas "Family laws")

- **Skeleton, in order:** cover, avatar, name, meta (@handle · role · place), bio, **the Tip moment**, **profile links**, the blocks in the person's order, footer.
  - Cover, identity, Tip and links are fixed in place and can't be moved or removed. **(my call, from the plan's locked parts)**; links **(my call (coordinator, 17 Nov))**
  - **Profile links** are the person's saved links (Settings), filtered as today (`visibleLinks`: Free 3, Pro 8). They render once, in the style's single link treatment below, at the style's fixed position, as drawn on the canvas:
    - right after the Tip moment on phone in every style (Tiles: the link tiles that follow the Tip tile);
    - on desktop, where each board draws them: the left column in Journal and Clear's first grid cell; the main column in Stage, Signboard, Sprint and Horizon; the tile grid in Tiles; the full-width row in Linen.
    - With no links, the area and its section title are hidden, and so is Horizon's "See links" button. **(my call (coordinator, 17 Nov))**
    - The canvas's titles over the links ("Listen and follow", "Elsewhere", "Find me") are sample copy. Every style uses one fixed title, **"Find me elsewhere"**, set in the style's section-title type. **(my call (coordinator, 17 Nov))**
    - On the phone boards, Journal's quote and Stage's events sit between the Tip and the links. They are blocks, so on a real page they follow the links.
  - Desktop places them in the style's grid (section 9).
- **Type:**
  - Inter is the glue: all UI, body, labels and money.
  - A style adds at most one display face, for the name and section titles only.
  - The Tip label is Inter 600 (Signboard 700; Tiles 650; Horizon 500, as drawn).
- **Tracking by size:**
  - −0.02 to −0.045 em at 32 px and up;
  - 0 at body size;
  - +0.06 to +0.08 em on short uppercase labels.
- **Uppercase:** only short labels and Sprint's name. Never sentences or bios.
- **Radii:** at most three per style, plus the circle avatar:
  - Clear 16 / 12 / pill
  - Journal 6 / 4
  - Stage 12 / 8 / pill
  - Signboard 10, avatar 16
  - Sprint 0 / pill
  - Tiles 24 / pill
  - Linen 20 / 14
  - Horizon 12 / 4
- **Spacing:**
  - 4 pt base;
  - phone gutter 20 (Linen's framed cover 16);
  - desktop content 920 to 1200 px.
- **Shadows:** none, with three exceptions:
  - Clear's segmented thumb;
  - Tiles' soft light-mode tile shadow;
  - Signboard's single hard 3 px offset on the Tip button.
- **Links:** one treatment per page, the style's own:
  - Clear: grouped list
  - Journal: hairline index
  - Stage: elevated rows
  - Signboard: ink buttons
  - Sprint: numbered index
  - Tiles: tiles
  - Linen: bordered two-up
  - Horizon: flat rows
- **The Tip moment:**
  - One primary action per view.
  - The chosen amount shows its selected state and flows into the label ("Tip ₦1,000").
  - States: default, hover, pressed (scale .94 to .98, or a 1 to 3 px press), selected, and focus.
- **Sticky Tip bar (phone):**
  - It appears once the in-page Tip scrolls away. One small `IntersectionObserver` inside the existing tip form component (`AppreciationForm`) watches the in-page Tip and toggles the bar. No other script is added per style. With JavaScript off, the bar is always shown (Classic's behaviour). **(my call (coordinator, 17 Nov))**
  - It sits above the home indicator: bottom padding is `max(12px, env(safe-area-inset-bottom))` plus the bar's own 34 px as drawn.
  - The page gets matching bottom padding, so the bar never covers the last block.
  - No sticky bar at desktop widths. **(builder's call** whether the desktop rail is `position: sticky`)
- **Footer:** today's locked footer (`ProfileFoot`: Report this page, Privacy, Terms, the preview link, and "Get your own TipMe page" on Free pages), set at 12/16 Inter 500 in `fg2`. The canvas's "Made with TipMe" is a sketch label and is **not** added. **(my call)**

---

## 9. The styles

**How each style is specified.**

- Values come from the canvas boards (the phone light board, the phone dark board via Tweaks, and the desktop at 1440).
- Phone width is 390 px. Sizes are px, written size/line-height and weight.
- Colours are the style's `neutrals`. `acc`, `accLabel` and `accText` are the accent's fill, label and text values (7.3), and `bar` is `bg` at 85% alpha (`bg` + `D9`).
- The **canvas board is authoritative for anything not restated here**: exact paddings and gaps, the mock photos' sizes, and hover colours.

**Applies to every new style:**

- **Amounts:** every chip shows the page's own preset amounts and its minimum, exactly as `AppreciationForm` does today. The canvas's ₦500 / ₦1,000 / ₦2,000 are illustrations below today's minimum. The fourth chip is **"Custom"** in the eight new styles and reveals today's Other-amount field. Classic keeps "Other amount". **(my call)**
- **Parts of the tip form the canvas doesn't draw** (message drawer, name, recognition, fee line, errors, the closed, not-ready and opens-soon states, the pilot notice): same component, same behaviour, styled with the style's tokens and radii. Each PR shows screenshots of these states, phone and desktop. **(builder's call** on the styling, within the family laws)
- **The identity** (name, avatar, meta, bio, Pro badge, verified mark, celebration label) keeps today's content and semantics. The Pro badge and verified mark follow the name at meta size in every style; the canvas doesn't draw them. **(builder's call** on exact placement)

### 9.1 Classic: "Today's TipMe page, unchanged" · Free · default

- **The look:** today's `/@username` page, byte for byte: DM Serif Display 400 name, Manrope UI, warm paper `#F3F2EE`, ink `#000`, and the fixed purple `#7A32F9` only on the selected amount and the wordmark.
- **Radii:** cover 32, panel 26, Tip 14, keys 12, chips 10.
- **The paper tip panel:** raised keys with a corner dot, a recessed Other-amount well, a ruled drawer, and the black Tip key with an arrow.
- **The phone Tip bar is always on,** because it is the form's only Tip button.
- **Exemptions:** only the three exceptions in 2.4 change. Classic is exempt from the other family laws: Manrope UI, light-mode shadows, five radii, the 3 px focus ring at 4 to 5 px offset, and the always-on bar all stay. **(owner decided)**

**Classic's choices (owner decided (17 Nov)):** the same choices as every other style.

- **Accent:**
  - The default is today's purple (`accent: null`).
  - A chosen accent replaces the purple **only where today's page uses it**: the selected amount key (fill, its `accEdge` border, and the corner dot), link colour, the focus ring, and the purple in the TipMe wordmark.
  - The Tip key stays black ink in light mode and `#F3F2EE` in dark mode. Classic's look keeps it.
  - The key's edge colour is the accent fill darkened about 10% in OKLCH. Its gloss and shadow keep today's recipe, tinted to the accent at the same alphas. **(my call)**
  - The selected key's label uses the accent's `label` value.
- **Appearance:**
  - Light is today's look.
  - Dark uses the canvas's derived palette ("Classic · phone · dark"):
    - surfaces: canvas `#141210`, raised `#1E1B18`, recessed and base `#2A2622`;
    - text: fg `#F3F2EE`, fg2 `#C9C4BA`, fg3 `#A39E94`;
    - lines: border `rgba(255,255,255,.14)`, hair `rgba(255,255,255,.10)`, rule `rgba(255,255,255,.12)`;
    - purple and accent: ink2 `#C8AEFF`, default accent `#C8AEFF` with label `#141210`;
    - Tip key, badge and wordmark ink: `#F3F2EE` on `#141210`;
    - effects: **all shadows and gloss off**.
  - Auto switches between the two with `prefers-color-scheme`.
  - Each of these must pass the contrast test. The canvas measured a lowest ratio of 5.63 in dark.
- **Cover type:** **(my call (coordinator, 17 Nov))**
  - **Your cover** (the default) is whatever the person set in Settings today: photo, design and colour, automatic, or animated. It renders exactly as today, so Classic with all defaults stays byte-identical.
  - **Gradient** is a two-stop gradient in the accent's family, drawn in today's cover shape (radius 32, same placement).
  - **Plain** shows no cover band: the page starts on the canvas colour.
- **Block order:**
  - Blocks render after today's links and bio, in Classic's existing visual treatment:
    - DM Serif Display 32/1.05 section titles;
    - Manrope 16/1.6 text in `fg2`, max 34em;
    - raised panels (`raised`, radius 26, `shInst` in light mode) for text, events and services;
    - chip-style links (as today's link chips);
    - photos at radius 14 (the Tip radius), drawn from Classic's own five radii.
  - Money is Inter. **(my call** on the per-block mapping, within today's tokens**)**
  - The tip panel keeps its place in today's layout: right rail on desktop, after the identity on phone.

**Rendering:**

- A Classic page with all defaults (no accent, light, today's cover, no blocks) renders the standard markup. Any other Classic choice renders today's markup with Classic's token overrides, `data-mode`, and the blocks section. It does not render `StudioPage`'s new-style frame. **(my call)**
- Today's Free tip amounts and "Other amount" are unchanged.

### 9.2 Clear: "Quiet, bright, precise" · Free

|                |                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faces          | Inter only. Name 700.                                                                                                                                                                                                                                                                                                          |
| Neutrals light | bg #F5F5F7 · card #FFFFFF · el2 #ECECF0 · fg #1D1D1F · fg2 #6E6E73 · line #E3E3E8 · track #E8E8ED · thumb #FFFFFF                                                                                                                                                                                                              |
| Neutrals dark  | bg #111113 · card #1C1C1E · el2 #2A2A2E · fg #F5F5F7 · fg2 #A1A1A6 · line #2E2E33 · track #1C1C1E · thumb #3A3A3F                                                                                                                                                                                                              |
| Default        | Blue · light · photo cover                                                                                                                                                                                                                                                                                                     |
| Radii          | cards 16 · photos 12 · controls pill · avatar circle                                                                                                                                                                                                                                                                           |
| Phone type     | name 32/36 700 −0.025em · meta 13/18 500 fg2 · bio 17/25 −0.012em, max 330 px · section title 20/26 650 −0.015em · link title 16/22 550, sub 15/20 fg2 · text card 17/26 · chip 15/20 550 (selected 650) · Tip 17/22 600                                                                                                       |
| Desktop type   | name 48/56 700 −0.03em · meta 14/20 · bio 19/28, max 460 · section title 22/28 650 · Tip 56 tall                                                                                                                                                                                                                               |
| Cover          | **Photo:** 220 px phone, 380 px desktop, full-bleed, fading into `bg` over its lower 60% (stops 0 / 35% / 80% / 100% of `bg`). **Gradient:** two tints of the accent at low chroma (OKLCH L .96 → .90 light; L .28 → .22 dark). **Plain:** `bg`.                                                                               |
| Avatar         | 104 phone, 128 desktop, circle, 4 px (desktop 5 px) ring in `bg`, overlapping the cover                                                                                                                                                                                                                                        |
| Tip moment     | **Signature: the segmented amount control.** A 44 px pill track (`track`, 4 px padding, 2 px gaps) holds 36 px segments. The selected segment is a raised `thumb` with `accText` text and the only shadow in the style. Tip: full-width 52 px pill (desktop 56), `acc`/`accLabel`. Desktop: track 48, segments 40, column 440. |
| Links          | grouped inset list: one `card` r16; rows 56 tall with 16 px side padding; 0.5 px `line` between rows; title + handle; trailing chevron                                                                                                                                                                                         |
| Photos / text  | photos: a horizontal strip of 150×200 r12 tiles, gap 8 · text: `card` r16, 20 px padding                                                                                                                                                                                                                                       |
| Layout         | Phone: one column, 20 px gutters. Desktop: content 920 wide; identity, then the Tip column (440), then the blocks in a 2-column grid with a 40 px gap. **(builder's call** which blocks span both columns; the board puts photos under text)                                                                                   |
| Sticky bar     | `bar` + `saturate(1.8) blur(20px)`, 0.5 px `line` top, padding 10/16/34, Tip pill inside                                                                                                                                                                                                                                       |
| States         | segment hover: `fg` 5% overlay; press: scale .96 · Tip hover: brightness 1.06; press: .98 and brightness .94 · focus: 2 px `accText`, offset 2                                                                                                                                                                                 |
| Motion         | load: name and bio fade up 8 px, 240 ms ease-out, 40 ms stagger · the thumb slides 220 ms `cubic-bezier(.2,.8,.2,1)` and the Tip label counts up to the new amount · reduced: the thumb jumps, fades only                                                                                                                      |

### 9.3 Journal: "A well-set magazine column" · Free

|                 |                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faces           | Source Serif 4: name 600, bio 400, section titles 600, pull quote italic 400 (needs the italic file). Inter for the rest. **Whole-name fallback for Hausa names.**                                                                                                                                                                   |
| Neutrals light  | bg #FFFFFF · card #FFFFFF · el2 #F4F2EF · fg #1C1B1A · fg2 #686460 · line #E4E1DC · chipOn (see note)                                                                                                                                                                                                                                |
| Neutrals dark   | bg #141413 · card #1D1C1A · el2 #262522 · fg #EDEBE8 · fg2 #A8A39D · line #2F2D2A                                                                                                                                                                                                                                                    |
| Default         | Green · light · plain cover                                                                                                                                                                                                                                                                                                          |
| Radii           | controls and Tip 6 · photos 4 · avatar circle. No cards.                                                                                                                                                                                                                                                                             |
| Phone type      | category label 12/16 600 +0.08em caps fg2 · name 44/46 600 −0.022em · handle 13/18 500 fg2 · bio (serif) 20/30 · section title (serif) 22/29 600 −0.01em · pull quote (serif italic) 24/32 · link title 16/22 600, sub 14/20 fg2 · body 17/27, max 62ch · chip 15/20 500 (selected 650) · Tip 16/20 600                              |
| Desktop type    | name 64/64 600 −0.028em · bio 21/32 · section title 24/31 · pull quote 32/43 · body 18/29                                                                                                                                                                                                                                            |
| Cover           | **Plain (default):** none. The page opens on a top row: category label left, 40 px avatar right, with a 1 px `fg` rule under it (top padding 48). **Photo:** inset in the column, 3:2, r4, not full-bleed. **Gradient:** a flat neutral tint (`el2`) band; no hue. **(my call** for photo and gradient; the canvas draws plain only) |
| Avatar          | 40 in the top row on phone; 72 above the name on desktop                                                                                                                                                                                                                                                                             |
| Tip moment      | 4 chips, 44 tall, r6, 1 px `line`, `bg` fill. Selected: 1.5 px `accText` border on `chipOn`, weight 650. Tip: full width, 48 tall, r6.                                                                                                                                                                                               |
| Links           | hairline index: 1 px `fg` rule on top; rows at least 56 tall with a 1 px `line` under each; hover underlines the title (1 px, offset 4)                                                                                                                                                                                              |
| Photos / text   | photos: 3-up grid, gap 6, 150 tall, r4, 13/18 caption · text: no card · quote: hanging opening mark                                                                                                                                                                                                                                  |
| Layout          | Desktop: 1120 wide; the top row spans it; then a grid of 420 px and the rest, gap 96. The left column holds identity, Tip and the **first** block; the other blocks flow in the right column (max 520 for text). **(my call** "first block left", from the board)                                                                    |
| Sticky bar      | solid `bg`, 1 px `line` top, padding 12/20/34. Left: name (serif 16/20 600) and handle 13/18; right: a 168×48 Tip button.                                                                                                                                                                                                            |
| States / motion | colour, border and filter transitions only, 150 ms · Tip hover: brightness 1.08; press: .92 · chip hover: `fg` border; press: `el2` · reduced: no transitions                                                                                                                                                                        |

**Note on `chipOn`.** The board's chipOn (`#F1F7F3` light, `#1A2620` dark) is a tint of the default green. Derive it from the current accent as `color-mix(in oklab, acc 6%, bg)`, and prove it in the contrast test. **(builder's call** on the exact mix; it must look like the board for Green)

### 9.4 Stage: "House lights down, spotlight up" · Pro

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faces           | Inter only. Name 800. Section titles 750.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Neutrals light  | bg #F2F2F4 · card #FFFFFF · el2 #E8E8EC · fg #16161A · fg2 #64646C · line #DEDEE3 · chip #FFFFFF · scrimEnd rgba(8,8,10,.86) · glow none                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Neutrals dark   | bg #0F0F12 · card #1A1A1F · el2 #25252B · fg #F4F4F6 · fg2 #A3A3AD · line #2C2C33 · chip #1A1A1F · scrimEnd #0F0F12 · glow = acc                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Default         | Violet · **dark** · photo cover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Radii           | cards 12 · photos 8 · Tip and chips pill · no avatar over a photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phone type      | label over photo 13/18 600 +0.06em caps white · name 48/46 800 −0.04em white · handle 14/20 500 white · bio 16/24 fg2 · section title 22/28 750 −0.02em · link title 16/21 600, sub 13/18 · chip 16/20 600 · Tip 17/22 600                                                                                                                                                                                                                                                                                                                                                                                   |
| Desktop type    | label 14/20 · name 104/96 800 −0.045em · section title 24/30 750                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cover           | **Photo (signature):** full-bleed, 488 tall on phone and 640 on desktop. The name sits over it at the bottom, on the scrim: lower 75%, `linear-gradient(to top, scrimEnd 0%, rgba(8,8,10,.8) 12%, rgba(8,8,10,.66) 38%, rgba(8,8,10,.3) 68%, transparent)`. No avatar. **Dark only:** a 260 px accent glow behind the cover, `radial-gradient(50% 50% at 50% 30%, acc 28%, transparent)` blurred 10 px; decorative. **Gradient:** deep accent (OKLCH L .30) fading to `bg`, name over it in `fg`. **Plain:** `bg`, with a 112 px avatar above the name. **(my call** for gradient and plain, from the brief) |
| Tip moment      | 4 pill chips, 48 tall, on `chip`. Selected: a 1.5 px inset `accText` ring. Tip: full-width 56 px pill. Desktop: bio, chips, Tip and handle sit in a `card` r12 with 24 px padding.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Links           | elevated rows: 60 tall, r12, `card`, a 36 px circle glyph on `el2`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Events          | the board's "Upcoming": `card` r12 rows with a 56 px date tile (`el2`, r8; day 22/24 800, month 11/14 650 caps fg2), title 16/22 600, place and time 13/18 fg2                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Photos / text   | strip of 156×208 r8 · text `card` r12, padding 20, 16/25                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Layout          | Desktop: 1200 wide; a 400 px rail (the Tip card) and the rest, gap 80; blocks in the main column; consecutive list blocks pair 2-up with a 32 px gap. **(builder's call** on pairing)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Sticky bar      | `bar` + `saturate(1.6) blur(24px)`, 1 px `line` top; 36 px avatar, name 15/20 650, handle 12/16, Tip pill 48 tall with 22 px side padding                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| States / motion | 180 ms `cubic-bezier(.3,.7,.4,1)` · chip press: scale .95 · Tip press: .97; hover: brightness 1.08 · row hover: `el2` · reduced: no scale                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### 9.5 Signboard: "Sign-painter confidence" · Pro

|                 |                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faces           | Unbounded: name 700, small caps label 600, section titles 650 caps. Inter for the rest; the Tip label is **Inter 700**.                                                                                                                                                                                                                     |
| Neutrals light  | bg #FAF8F3 · card #FFFFFF · el2 #F1EDE3 · fg #17150F · fg2 #5E584C · line/ink/shadow #17150F                                                                                                                                                                                                                                                |
| Neutrals dark   | bg #14130F · card #1F1D18 · el2 #2A2721 · fg #F3F0E8 · fg2 #ADA697 · line/ink #CFC8B8 · shadow #000000                                                                                                                                                                                                                                      |
| Default         | Amber · light · plain (band) cover                                                                                                                                                                                                                                                                                                          |
| Radii           | 10 everywhere · avatar 16 (its image 14)                                                                                                                                                                                                                                                                                                    |
| Phone type      | band label 12/16 600 +0.08em caps · name 30/34 700 −0.015em · handle 14/20 600 + place 500 fg2 · bio 17/26 · section title 15/22 650 +0.03em caps · link title 16/22 700, sub 14/20 · chip 15/20 700 · Tip 17/22 700                                                                                                                        |
| Desktop type    | band label 14/20 · name 76/80 700 −0.025em, max 900 · section title 16/23 · bio 18/28                                                                                                                                                                                                                                                       |
| Cover           | **Plain = the accent band (signature):** `acc` fill and `accLabel` text, padding 72/20/76 on phone and 96/104 on desktop, 2 px `ink` bottom rule. The name is in the band. **Photo:** full-bleed 16:9, with the name in a short band **below** the photo, never over it. **Gradient: not offered.** **(my call** for photo, from the brief) |
| Avatar          | 84 px image, r14, inside a 2 px `ink` box r16 on `bg`, straddling the band's edge                                                                                                                                                                                                                                                           |
| Tip moment      | chips 48 tall, r10, 2 px `ink`, `card` fill. Selected: `ink` fill with `bg` text. Tip: 56 tall, r10, 2 px `ink`, `acc` fill, with the style's one hard shadow `3px 3px 0 shadow`. Hover: −1,−1 with a 4 px shadow. Press: +3,+3 with no shadow.                                                                                             |
| Links           | ink buttons: 56 tall, r10, 2 px `ink`, `card`                                                                                                                                                                                                                                                                                               |
| Photos / text   | 3-up, gap 8, 132 tall, each in a 2 px `ink` r10 frame · text: 2 px `ink` r10 `card`, padding 18, 16/25                                                                                                                                                                                                                                      |
| Layout          | Desktop: the band spans the full width (content 1120); then 440 px and the rest, gap 80. The left column holds avatar, handle, bio, Tip and the **first** block; the rest go right. **(my call)**                                                                                                                                           |
| Sticky bar      | solid `bg`, 2 px `ink` top, padding 12/20/34                                                                                                                                                                                                                                                                                                |
| States / motion | 120 ms; chips use `steps(2)` and press 1 px · focus offset 3 · reduced: no transitions                                                                                                                                                                                                                                                      |

### 9.6 Sprint: "Fast, bold, all-caps energy" · Pro

|                 |                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faces           | Anton 400, **the name only**, uppercase, 0 tracking. Inter for everything else, including section titles.                                                                                                                                                    |
| Neutrals light  | bg #FFFFFF · card #F5F5F5 · el2 #EDEDED · fg #111111 · fg2 #6B6B6D · line #E2E2E2                                                                                                                                                                            |
| Neutrals dark   | bg #121212 · card #1E1E1E · el2 #2A2A2A · fg #F5F5F5 · fg2 #A8A8AA · line #2E2E2E                                                                                                                                                                            |
| Default         | **Ink** (a fully monochrome page) · light · photo cover                                                                                                                                                                                                      |
| Radii           | 0 on photos, rows and cover · pill on chips and Tip · avatar circle                                                                                                                                                                                          |
| Phone type      | name 64/76 · handle 14/20 500, role and place fg2 · bio 16/24 · section title 20/26 600 −0.015em · link number 13/18 500 fg2, title 18/24 500 −0.015em, sub 14/20 · chip 15/20 500 (selected 600) · Tip 17/22 600                                            |
| Desktop type    | name 112/132 · bio 18/28, max 480 · section title 24/30                                                                                                                                                                                                      |
| Cover           | **Photo:** edge to edge, unrounded, 440 tall on phone. The name sits **below** it. On desktop it is a 720/720 split, 800 tall: photo left, name, meta, bio and Tip right (padding 80/96/64/80). **Plain:** the name huge on `bg`. **Gradient: not offered.** |
| Avatar          | 40 (desktop 44) circle beside the handle                                                                                                                                                                                                                     |
| Tip moment      | pill chips, 48 tall, 1.5 px `line`. Selected: filled `acc` with `accLabel` text. Tip: full-width 56 px pill.                                                                                                                                                 |
| Links           | numbered index: 1 px `line` above and below; rows 60 tall with a "01" number column 24 wide; on hover the title slides 4 px                                                                                                                                  |
| Photos / text   | photos run edge to edge, 2-up, 2 px gaps (desktop 3-up, 360 tall) · text: plain 16/25                                                                                                                                                                        |
| Layout          | Desktop: after the split, photos run full-bleed; then the other blocks in a grid of the rest and 480, gap 120, padding 72/80. **(builder's call** on mapping blocks to its two columns)                                                                      |
| Sticky bar      | solid `bg`, 1 px `line` top, padding 12/20/34                                                                                                                                                                                                                |
| States / motion | 200 ms `cubic-bezier(.4,0,.2,1)` · chip press: .96 · Tip press: .98; hover: opacity .88 · reduced: no scale or slide                                                                                                                                         |

### 9.7 Tiles: "A tidy desk of things you made" · Pro

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faces           | Inter only. Name 700.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Neutrals light  | bg #EEEEF1 · card #FFFFFF · el2 #F4F4F6 · fg #1D1D1F · fg2 #6A6A70 · line #E3E3E8 · tile shadow `0 1px 2px rgba(20,20,30,.05), 0 6px 16px rgba(20,20,30,.05)`                                                                                                                                                                                                                                                                                                          |
| Neutrals dark   | bg #0F0F11 · card #1C1C1F · el2 #26262A · fg #F5F5F7 · fg2 #A1A1A8 · line #2C2C31 · shadow none                                                                                                                                                                                                                                                                                                                                                                        |
| Default         | Rose · light · plain cover                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Radii           | tiles 24 · chips and Tip pill · avatar circle (photos inside tiles take the tile's 24)                                                                                                                                                                                                                                                                                                                                                                                 |
| Phone type      | name 28/32 700 −0.025em · meta 13/18 500 fg2 · bio 16/24 · Tip tile title 20/26 700 −0.02em, sub 13/18 500 · link tile title 15/20 600, sub 13/18 500 fg2 · text tile title 15/20 600 fg2, body 16/24 · chip 15/20 600 · Tip 17/22 650                                                                                                                                                                                                                                 |
| Desktop type    | name 44/48 700 −0.03em · meta 14/20 · bio 18/28 · Tip tile title 22/26                                                                                                                                                                                                                                                                                                                                                                                                 |
| Cover           | **Plain (default):** none; padding 56 at the top, an 80 px avatar beside the name. **Photo:** a 2-column, 2:1 tile at the top of the grid, not a banner. **Gradient:** a soft two-tint accent tile at low chroma. **(my call** for photo and gradient, from the brief)                                                                                                                                                                                                 |
| Tip moment      | **Signature: the Tip tile.** It spans 2 columns and is the first tile after the profile. `acc` fill, `accLabel` text, r24, padding 20 (desktop 24). It holds "Send a tip", "Goes to {first name}" (canvas copy), chips and the Tip. Chips: 44 tall, transparent, with a 1.5 px inset ring of `accLabel` at 45%; selected: `accLabel` fill with `acc` text. Tip is **inverted**: `accLabel` fill with `acc` text, 52 px pill. The sticky bar's Tip is the normal `acc`. |
| Links           | tiles: `card` r24, light shadow, 128 tall (a short one is 78), padding 16; link glyphs may take the accent at ≥ 24 px and ≥ 3:1 (the style's accent exception)                                                                                                                                                                                                                                                                                                         |
| Layout          | Phone: a 2-column grid, gap 12. Text blocks span 2. Links and photos take 1 or 2 by kind. Desktop: 1200 wide; a 340 px identity rail and a 4-column tile grid, gap 16, tile height 172. **(builder's call** on spans; text always full width; the Tip tile always 2 wide and first)                                                                                                                                                                                    |
| Sticky bar      | as Clear: `bar` + `saturate(1.8) blur(20px)`, 1 px `line`, padding 10/16/34                                                                                                                                                                                                                                                                                                                                                                                            |
| States / motion | 250 ms `cubic-bezier(.2,.9,.3,1.2)` (a slight overshoot) · tile hover: −2 px; press: .98 · chip press: .94 · Tip press: .97 · focus offset 3 · reduced: none of these                                                                                                                                                                                                                                                                                                  |

### 9.8 Linen: "Morning light on paper" · Free

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faces           | Gentium Book Plus: name 400, the "Send a tip" title 700, section titles italic 400. Inter for the rest.                                                                                                                                                                                                                                                                                                                                 |
| Neutrals light  | bg #F6F1E8 · card #FFFDF8 · el2 #EFE8DB · fg #2B2520 · fg2 #6A5F55 · line #E3D9C8 · mat #FFFDF8 · chipOn (see Journal's note)                                                                                                                                                                                                                                                                                                           |
| Neutrals dark   | bg #1A1613 · card #24201B · el2 #2E2923 · fg #F1EADF · fg2 #AEA293 · line #3A332B · mat #2E2923                                                                                                                                                                                                                                                                                                                                         |
| Default         | Coral · light · photo (framed) cover                                                                                                                                                                                                                                                                                                                                                                                                    |
| Radii           | cards, framed cover and Tip card 20 · chips, Tip button, link cards and photos 14 · avatar circle                                                                                                                                                                                                                                                                                                                                       |
| Phone type      | name 40/44 400 −0.01em · meta 13/18 500 fg2 (two lines: handle; role · place) · bio 17/26 · Tip card title 22/28 700 · section title italic 24/30 −0.005em · link title 15/20 600, sub 13/18 · body 16/26 · chip 15/20 500 (selected 650) · Tip 17/22 600                                                                                                                                                                               |
| Desktop type    | name 56/60 400 −0.015em · section title italic 28/34 · bio 18/28                                                                                                                                                                                                                                                                                                                                                                        |
| Cover           | **Photo (signature, framed):** inset 16 px from the screen edge, inside a `mat` frame (1 px `line`, r20, padding 6, shadow `0 1px 0 rgba(80,50,20,.04)`), photo r14, 204 tall on phone. On desktop the frame is 600 wide by 420 tall, left of the identity. The canvas's italic caption has no data source and is **left out**. **(my call)** **Gradient:** a warm accent tint (OKLCH L .94 → `bg`) in the same frame. **Plain:** `bg`. |
| Avatar          | 56 (desktop 64) circle beside the meta                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tip moment      | a "Send a tip" card: `card`, 1 px `line`, r20, padding 20. Chips 48 tall, r14, 1 px `line`; selected: 1.5 px `accText` on `chipOn`. Tip: 52 tall, r14.                                                                                                                                                                                                                                                                                  |
| Links           | bordered two-up: 64 tall, r14, `card`, 1 px `line` (desktop: one row of up to 5)                                                                                                                                                                                                                                                                                                                                                        |
| Photos / text   | photos in a 3fr/2fr grid, gap 8, r14 · text: `card` r20, 1 px `line`, padding 20                                                                                                                                                                                                                                                                                                                                                        |
| Layout          | Desktop: 1120 wide; framed cover (600) next to the identity and Tip card, gap 72; links full width; then the remaining blocks in 600 px and the rest. **(builder's call** on mapping)                                                                                                                                                                                                                                                   |
| Sticky bar      | `bar` + `blur(16px)`, 1 px `line`, padding 12/16/34                                                                                                                                                                                                                                                                                                                                                                                     |
| States / motion | 300 ms ease-out · Tip hover: brightness 1.06; press: 1 px down, brightness .95 · chip hover: `fg2` border · reduced: no press travel                                                                                                                                                                                                                                                                                                    |

### 9.9 Horizon: "One image, a quiet name" · Pro

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faces           | Inter, **400 and 500 only**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Neutrals light  | bg #FFFFFF · card #F4F4F4 · el2 #EAEAEA · fg #171A20 · fg2 #5C5E62 · line #E2E2E2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Neutrals dark   | bg #111214 · card #1C1D20 · el2 #27282C · fg #F2F3F5 · fg2 #A4A7AD · line #2D2E32                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Default         | Lagoon · light · photo cover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Radii           | buttons and chips 4 · blocks and photos 12 · no avatar over a photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Phone type      | name 34/40 500 −0.02em white · meta 15/22 400 white · bio 15/24 fg2 · section title 18/24 500 −0.01em · link title 15/20 500, sub 14/20 · body 15/24 · buttons 16/20 500 · chip 15/20 500                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Desktop type    | name 56/64 500 −0.025em · meta 17/24 · section title 20/26 · bio 16/24                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cover           | **Photo (signature):** full-bleed, 640 tall on phone and 836 on desktop. Name, meta and **two buttons** sit at the bottom over the scrim: lower 70%, `linear-gradient(to top, rgba(0,0,0,.7) 0%, rgba(0,0,0,.62) 45%, rgba(0,0,0,.3) 72%, transparent)`. The buttons are "Send a tip" (`acc`, 48 tall, r4), which scrolls to and focuses the Tip area, and "See links" (dark glass: `linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.03)), rgba(10,10,12,.32)`, `blur(20px) saturate(1.5)`, white text, white focus ring), which scrolls to the links. On phone they stack full width; on desktop they sit side by side, 264 wide each. **Gradient and plain:** the name centred on `card`, a 96 px avatar, and the same two buttons with "See links" as an outlined `fg` button. **(my call)** |
| Tip moment      | in the page below the cover: chips 48 tall, r4, 1 px `line`, `bg` fill; selected: a 2 px inset `accText` ring. Then "Tip ₦…", 48 tall, r4, `acc`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Links           | flat rows: 56 tall, r12, `card`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Photos / text   | 3-up at 3:4, r12, gap 8 (desktop gap 16) · text `card` r12, padding 20 (desktop 24)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Layout          | Desktop: 1040 wide; 440 px and the rest, gap 80. The left column holds bio and Tip; the right holds the **first** block; the rest follow full width or in the same split. **(builder's call)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Sticky bar      | `bar` + `blur(20px)`, 1 px `line`, padding 12/20/34                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| States / motion | one transition: 330 ms `cubic-bezier(.5,0,0,.75)` on colour, filter and border only · Tip hover: brightness 1.08; press: .9 · glass hover and press: .5 / .62 dark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 9.10 Long and hard names (canvas "Long names")

- **Sprint:** for names that reach three lines, Anton steps down from 64 to 52 px and the line height opens to 1.2, so dots below never touch the acute accents on the next line. Test name: "Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀" (33 letters).
- **Signboard:** names over 18 letters step from 30 to 24 px and balance across two lines. The band grows, and the avatar keeps its overlap. Test name: "Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí" (30 letters).
- **Journal:** "Ɗanlami Ƙwairanga Ɓello" is set wholly in Inter 700, because Source Serif 4 has no ɓ ɗ ƙ ƴ. Everything else on the page keeps the style.
- **Not drawn:**
  - the desktop step-downs;
  - Stage and Horizon names over a photo;
  - the other styles.

  Each style uses the same rule: one step down (about 80%) when a name would take a third line, with balanced wrapping and no mid-word breaks. **(builder's call** on exact sizes, proven by the long-names render test at 320 and 390 px)

- **The sticky bar's name** (Journal, Stage) truncates with an ellipsis on one line. **(my call)**

---

## 10. The Style tab (canvas "Choosing a style": phone Free, phone Pro, desktop Pro)

**Chrome.** The editor keeps the dashboard's own face, Manrope.

- **Phone header:** 60 tall. "Page Studio" in 800 18/24, a status line ("Saved · not published", 12/16, `role="status"`), and a Publish button (44 tall, r12, dark).
- **Tabs:** 48 tall: **Style**, **Blocks**, **Check** (with a "Pass" or "N to fix" badge). The selected tab has a 2 px `#7A32F9` underline.
- **Desktop header:** 72 tall, adding a Phone / Desktop preview switch. The body is a grid: the preview area, then a 560 px white side panel holding the tabs.

**Sections, top to bottom** (28 px apart on phone, padding 20/16; desktop panel padding 24/28):

1. **Live preview.**
   - **Phone:** a phone frame (r22, padding 6, `#1B1A18`) at the top of the tab, showing the person's real page at 174×290.
   - **Desktop:** the preview area shows a 312×520 phone (frame r40, padding 10). Beside it: "Live preview" (12/16 750 caps), the style's name (32/36 800), its mood line plus the accent sentence, and an accent chip ("From your photo · #A2461E").
   - **The preview is the real renderer,** as today (`studio-preview.tsx`), and loads only the chosen style's fonts. **(my call)**
2. **Style.**
   - **Heading line:** "Style", plus "4 of 9 free" (Free) or "9 styles" (Pro). The canvas's "· split proposed" is dropped, because the split is decided.
   - **Cards:** one per style, in the order Classic, Clear, Journal, Stage, Signboard, Sprint, Tiles, Linen, Horizon. On phone they sit in a single horizontally scrolling row that bleeds off the right edge, 104 wide, gap 12. On desktop they form a 4-column grid, gap 18/14.
   - **Each card** is a schematic miniature of the style (r14), set in the person's own name and display face and drawn in the current accent (or each style's default when `accent` is null), with the name below at 13/18.
   - **Badges and labels:**
     - Classic carries a "DEFAULT" badge and the label "Classic · Free";
     - Pro styles carry a "PRO" badge **for Free users only**;
     - the selected card has a 2 px `bg` + 4 px `#7A32F9` ring, a 22 px purple check badge, and a 750 label.
   - **Free users see a banner under the cards** (`#F1E9FF`, `#4D16A8` text, r14), linking to the Pro page: "PRO · Stage, Signboard, Sprint, Tiles and Horizon come with Pro."
   - **Accessible name of each card:** "{Name}, {mood}. {Free|Pro}." Classic's adds "The default." `aria-pressed` marks the selected one.
3. **Accent.**
   - **Heading:** "Accent", then the current accent's name.
   - **Swatches:** nine 33 px circles, gap 7, wrapping, each `aria-label`led with its name. The selected one has a 3 px white + 5 px `#141210` ring. "From your photo" is a conic swatch.
   - **Free:** that swatch is `aria-disabled`, with the note "“From your photo” comes with Pro." **(canvas)**
   - **Pro, photo accent chosen:** "Picked from your profile photo and checked for contrast in light and dark."
4. **Appearance.** A segmented control: Light / Dark / Auto, each 44 tall (r9 inside an r12 `#EEEDE8` track). Note: "Auto follows each visitor’s phone setting."
5. **Cover.** **(my call (coordinator, 17 Nov))**
   - **The control:** a segmented control: **Your cover** / **Gradient** / **Plain**. Signboard and Sprint have no gradient, so they show Your cover and Plain. Switching to a style that lacks the current type selects Your cover.
   - **Note under it:** "Change your cover in Settings." It links to the cover setting, which stays the only place the cover itself is chosen.
   - **Stage or Horizon with a non-photo cover:** the `cover-photo` notice shows (5.5).
6. **Block order.** A row: "Block order · Drag blocks in the Blocks tab". It opens the Blocks tab.

**Classic selected:** the same sections as every style. Classic's accent row shows "TipMe purple" first, as its default. **(owner decided (17 Nov))**

**Switching style keeps everything the new style can use:**

- an explicit accent;
- the mode;
- the cover type, when the new style offers it;
- the blocks.

**(my call)**

**Motion (canvas):**

- card hover −2 px, press .97, 250 ms `cubic-bezier(.2,.8,.2,1)`;
- swatch hover 1.08;
- focus 2 px `#7A32F9`, offset 3;
- reduced motion: none of these.

**The Blocks tab (changes to G2) (my call):**

- It becomes **one ordered list**. Drag, Up/Down and arrow keys work as built, with the same `aria-live` wording.
- **Removed:** the column picker, spacing, background and variant choices.
- **Locked rows**, not draggable: "Cover, name and bio" at the top, then "Tip", then "Your links" (only when the person has links), each with "Always TipMe. Can't be moved or removed." "Your links" adds "Change them in Settings." **(my call (coordinator, 17 Nov))**
- **"Add a block"** no longer offers Links. **(my call (coordinator, 17 Nov))**
- **"Add a block"** marks Pro kinds with a PRO badge for Free users. Choosing one opens the Pro sheet, and Free users can't add Pro blocks to a draft.

## 11. Free and Pro, enforced on the server

**What is Pro** **(owner decided (17 Nov))\****:**

- the styles Stage, Signboard, Sprint, Tiles and Horizon **(owner decided)**;
- the accent "From your photo" **(owner decided)**;
- every block except text and quote: photo, gallery, video, services and events, plus Studio photo uploads.

**Free blocks:** text and quote only **(owner decided (17 Nov))**. Profile links are not a block; every page shows them (section 8). **(my call (coordinator, 17 Nov))**

**Rules:**

- **Drafts on Free** **(my call (coordinator, 17 Nov))**: the server compares each save with the stored draft and refuses, with 403 `STUDIO_PRO_REQUIRED`, only:
  - **adding** a Pro block that wasn't there;
  - **switching** `style` to a Pro style, or `accent` to `'photo'`, from something else.

  Everything else saves, including a draft that **already holds** Pro blocks, a Pro style or the photo accent, as a lapsed Pro draft does. That covers:
  - reordering;
  - editing text in any block, Pro ones included;
  - removing blocks;
  - undo, which saves the earlier state: it may restore a Pro item the stored draft held at the start of the session, so restoring a value is allowed when it equals the published version or the draft as loaded;
  - discard.

- **Image uploads and focus changes** are Pro only, also 403.
- **Publish:** the API runs `checkDesign` with the page's real `plan`, under the page lock.
  - Any `pro-only` issue → 422 `STUDIO_DESIGN_CHECK_FAILED` with the issues. Nothing is published.
  - When the published version uses anything Pro, the UPDATE also carries `eq(profiles.plan, 'pro')`, as `setThanks` does, so a plan change mid-publish can't slip through.
  - A client claim never decides this.
- **Public read:** one shared contracts function, `studioShown(doc, plan)`, decides what shows. It returns the document, a trimmed document, or null for the standard page. Both `publicStudioFor` (API) and `studioFor` (web) call it, replacing today's blanket `plan !== 'pro'` checks. The lapse rules are in 12.5.
- **The switch:** the `page_studio` admin switch stays the gate for everything, Free included. While it is off, every route is 404 and no page gets `studio`.

## 12. G3, adapted to styles

### 12.1 Publish gate (owner decided: the check must pass)

- **While issues remain,** Publish reads "Publish · N to fix". It is `aria-disabled` but stays focusable, and it opens the dialog "Your page can’t be published yet", which lists the issues with their fixes. A Free user with a Pro style sees the `pro-only` issue and its fixes there.
- **After a 422,** the dialog shows the server's issues, which replace the client's. The server's issues win.
- **When the check passes,** Publish opens "Publish your page?". It shows a summary ("Clear · Blue · Auto · Your cover · 5 blocks") and "Design check: N of N pass". On success, the page revalidates and the status line reads "Published". **(my call** on the summary format)
- **There is no "publish anyway",** for staff either (plan ruling 12).

### 12.2 Undo (owner decided; carried from the plan)

- **What a step is:** each change to style, accent, mode, cover, block order, adding or removing a block, or editing a block's fields (one step per field per pause, matching the 800 ms save debounce).
- **How:** "Undo" in the header, plus Ctrl/Cmd+Z when focus isn't in a text field.
- **The button's accessible name** says what it undoes, e.g. "Undo: style changed to Clear". **(my call)**
- **Scope:** the stack is per session, in memory, holds up to 50 steps **(builder's call** on the cap), and is cleared on reload. Undo saves like any change.

### 12.3 Discard draft (owner decided; carried from the plan)

- **The action:** "Discard changes", confirmed once. The dialog says "Discard your changes? Your page stays as it is now.", with buttons "Discard changes" and "Keep editing". **(my call, copy)**
- **What it does:** the draft becomes the published version, or Classic with no blocks if the page was never published. Photos that are unreferenced are removed by the existing `DELETE /v1/me/studio/draft`. Undo is cleared.

### 12.4 Free users preview Pro styles (owner decided)

- **Pro cards are selectable for everyone.** This **overrides** the canvas, which draws them `aria-disabled` for Free users.
- **The preview** shows the real style with a small "PRO" tag above it. On Free, a Pro style the draft didn't already hold is a **preview only**: it is kept in memory and not saved, because the server refuses the switch (11). Autosave pauses, and the status line reads "Previewing a Pro style: not saved". Choosing a free style resumes saving. **(my call (coordinator, 17 Nov))**
- **Publishing a Pro style** is refused by the `pro-only` rule (11), whose fixes are "Choose a free style" and "See Pro".
- **The photo accent stays disabled for Free**, as drawn. **(my call:** the canvas shows it disabled, and computing a photo accent for a preview isn't worth it)
- **Pro blocks** can't be added on Free (11).

### 12.5 When Pro lapses (owner decided: extras hide, nothing is deleted; adapted here)

- **A published Pro style** **(owner decided (17 Nov))**: from the moment `plan` turns free, visitors see **Classic**, with the person's own choices wherever Classic supports them:
  - their accent, except that the photo accent becomes Classic's purple;
  - their mode;
  - their cover choice;
  - their text and quote blocks, in order.

  Pro blocks are hidden. The design is kept and returns when Pro renews, or when the person publishes a free style. `studioShown` returns that Classic document.

- **A published free style with Pro extras:** the style stays.
  - `accent: 'photo'` shows the style's default accent;
  - Pro blocks are hidden;
  - nothing is deleted;
  - Studio photos aren't served while hidden. **(my call)**
- **The draft is untouched,** and stays editable within the draft rules in section 11. The editor opens normally, with a banner:

  > Your Pro has ended. Your page shows {Classic | {Style} without Pro extras} until Pro is back. Your design is kept.

  "See Pro" is linked. **(my call, copy)** This replaces the plan's read-only "lapsed" mode.

- **Grace:** the 3 days of grace count as Pro, because `plan` stays `pro` during grace (billing decision, 9 Nov).
- **When Pro resumes,** the published version is re-checked and shown again, as today.

## 13. The public render

- **`page.tsx`:** `studioFor` returns null for no published version, for Classic with all defaults, for campaign links, and for whatever `studioShown` hides. On null, today's markup renders unchanged.
  - Classic with other choices renders today's markup with Classic's overrides and blocks (9.1).
  - Every other style renders through `StudioPage`.
- **`StudioPage`:**
  - The root is `<div class="studio" data-style data-mode>`, with `--studio-*` tokens for light, and for dark under `[data-mode=dark]` and, for `auto`, under `@media (prefers-color-scheme: dark)`.
  - The style's cover, identity and Tip moment render in the style's markup.
  - Blocks render in document order, through one component per kind per style family. **(builder's call** on component structure)
  - The footer is today's `ProfileFoot`.
- **The tip form:**
  - `AppreciationForm` is the same component, with the same props, behaviour, states and tests. It takes a style `skin` (class names and tokens). Classic's skin is today's.
  - Nothing the person chose reaches its logic. Amounts, fees, minimums and checkout are unchanged.
  - **(owner decided (17 Nov))**: every style's Tip looks as drawn on the canvas. Tip behaviour, amounts, validation and safety rules stay identical underneath every style. This supersedes the 16 Nov note in `studio-page.tsx` ("the same tip block styling").
- **Your cover** **(my call (coordinator, 17 Nov))** is the person's cover from Settings.
  - A photo cover renders in the style's photo treatment (9.x "Photo"), cropped by the style with object-fit cover.
  - A design-and-colour, automatic or animated cover renders as today's cover art in the style's cover slot. Stage and Horizon instead render their gradient treatment, because they need a photo (`needsPhoto`), and the check shows the `cover-photo` notice.
  - In the per-style tables, "photo cover" as a default means "Your cover". Each style's **Photo** row describes how it draws a photo cover.
  - Tall crops (Stage 488, Horizon 640 and 836) use the cover's focal point if one is stored, or the upper third otherwise. The full-bleed photo is the likely LCP, so it gets `fetchpriority="high"` and a correct `srcset`/`sizes`. **(builder's call** on renditions; no upscaling)
  - An animated cover renders as today (loop or once) in a style's cover slot. Where the style puts text over the cover (Stage, Horizon), it isn't a photo, so the gradient treatment applies. **(my call (coordinator, 17 Nov))**
- **Text on a photo** always sits inside the style's scrim (Stage, Horizon), with white text only.
- **Fonts:** `@font-face` only for the style's faces, plus metric-matched fallbacks (the existing pattern) to keep CLS ≤ 0.05. One `<link rel="preload">` for the name face.

## 14. How we know it's right (evidence each PR records)

1. **Contrast, exhaustively:** a unit test over every style (9, Classic included) × curated accent (8, plus Classic's purple) × mode (2). Every text, label, chip, ring and border pair the style uses must meet its minimum. This replaces the old runtime `contrast` rule. A property test (fast-check, existing seeds) covers the photo-accent algorithm: for any input colour, it returns a passing pair or the fallback.
2. **Glyphs:** the coverage test runs over every bundled display file, and Source Serif 4 is `wordFallback`. Render tests use the three long names from 9.10 and check that **one face is computed for the whole name**.
3. **Render:** for every style × light/dark at 320, 390, 768, 1024 and 1440: axe, no horizontal overflow, no clipped text. Documents: `min`, `max` (every limit), long names, hostile text. The existing probes (`studio-probes.ts`) are reused.
4. **Snapshots:** Linux is the authority. Each new style at 390 light and 1440 light, plus Stage dark, plus Classic at 390 in dark with an accent and blocks: 18 images. Classic's existing `profile.visual` snapshots must not change. Classic with all defaults is byte-identical to the standard page.
5. **Performance:** lab LCP per style example (< 2000 ms), the CSS budgets in 4.3, at most 2 families and 4 font files per page from our own origin, and the existing script delta.
6. **Gating:** integration tests that:
   - Free publishes Clear;
   - Free can't publish Stage (422 `pro-only`);
   - Free can't **add** a gallery block or **switch** to a Pro style (403);
   - a lapsed Free draft that holds a Pro style and Pro blocks can still be reordered, have its text edited, be undone and be discarded;
   - Free can't upload a photo;
   - a lapsed Pro style shows Classic;
   - a lapsed free style keeps its style and drops the photo accent and Pro blocks;
   - resumed Pro shows the design again;
   - the switch off gives 404 everywhere.
7. **Migration:** v1 fixtures convert to the documented v2. A v1 `links` block is dropped and the links still show once, in the skeleton. Classic shows links exactly where today's page does, never twice.
8. **Links and cover:** each style shows links once, in its treatment and position. With no links, the area and Horizon's "See links" button are absent. "Your cover" renders each Settings cover kind, and Stage and Horizon fall back to gradient for a non-photo cover.
9. **Sticky bar:** it is hidden while the in-page Tip is on screen and shown after it scrolls away. With JavaScript disabled, it is always shown. The script budget is updated by the measured bytes only. `resolveStudio` is idempotent and never throws (the existing property test, kept).
10. **Copy:** a test greps the new copy for the payment provider's name.

## 15. Where the canvas disagrees with itself or with decisions (resolved)

1. **The style cards for 03 to 09 are pass 1 and disagree with the phone boards and Family laws (pass 2):**
   - Tiles' default accent: Coral on the card, Rose on the phones;
   - Linen's: Amber on the card, Coral on the phones;
   - Horizon's: Blue on the card, Lagoon on the phones;
   - Linen's face: Literata on the card, Gentium Book Plus on the phones.

   **Pass 2 wins** (Family laws: "each style ships a different default, so no two styles open alike"). **(my call)**

2. **Free picker draws Pro cards disabled** → owner decision: preview allowed (12.4).
3. **"4 of 9 free · split proposed"** → the split is decided on 17 Nov; the copy is "4 of 9 free".
4. **Canvas amounts are below today's minimum** → each page's real amounts (section 9 intro).
5. **"Made with TipMe" footer** → today's locked footer (section 8).
6. **The Classic dark board was labelled "derived, not live"** → it is now Classic's dark mode **(owner decided (17 Nov))**, and its gaps note ("No dark mode", "No block order") is superseded.
7. **The `chipOn` tints in Journal and Linen are fixed to the default accent** → derived from the accent (9.3).
8. **Linen's cover caption** → no data source, left out (9.8).
9. **The brief named Clear "the default" and proposed Literata** → superseded: Classic is the default (owner decided), and Linen uses Gentium Book Plus (canvas, coverage verified).
10. **The brief's Horizon "See links" was white frosted glass** → the canvas's dark glass wins.

## 16. Left to the builder

Each item below is the builder's call:

- component structure;
- the CSS split method that meets the budgets;
- the `opsz` axis;
- the exact `chipOn` mix;
- desktop block-to-column mapping where marked;
- long-name step sizes not drawn;
- the undo cap;
- the pixel sampling method for the photo accent;
- where `photo_accent` is stored;
- cover renditions and crops;
- the styling of the undrawn tip-form states;
- the placement of the Pro badge and verified mark;
- whether unused font files are deleted now;
- PR slicing.

Suggested PR order **(my call)**:

1. contracts (registry, accents, document v2, resolver and migration, check v3) and fonts;
2. the renderer for the eight styles, behind the lab, with the render, contrast and performance tests;
3. API gating, the photo accent and the migration column;
4. the Style tab and the Blocks tab changes;
5. G3 (gate, undo, discard, Free preview, lapse).

Each UI PR shows phone and desktop screenshots of the expected UI.

## 17. Open questions for the owner

None. The owner answered the three questions on 17 Nov (sections 11, 12.5 and 13).
