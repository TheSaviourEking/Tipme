# Page Studio: Creator and Professional Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new Pro styles, **Creator** (dark, photo cover with an overlapping avatar, icon row, two-line "Support my work" Tip, link rows) and **Professional** (light, a card rising over a photo cover holding identity, icon row, link rows, chips, a "Send a tip" pill and "Powered by tipme"), plus a one-time "Start with this layout" for empty pages, with every existing style guarantee extended to them.

**Architecture:** Both styles join the existing registry (`STUDIO_STYLE_IDS`, appended after `'horizon'`), so the document, the design check, Free/Pro gating, lapse and every registry-driven test cover them with no new machinery. Contracts gain the neutrals, Creator's `deep`/`deepLabel` tokens, a fixed `place` per link site, contrast pairs, slot widths and an envelope test. The web renders each through `StudioStylePage` with its own branch and its own dynamic sheet (`sheets/creator.tsx`, `sheets/professional.tsx`); the tip form gains two skins with fixed labels. The editor adds two miniatures and a starter layout that only ever fills an empty draft, as one undo step.

**Tech Stack:** TypeScript strict, Next.js 16 App Router (server components), Zod, `node --test`, fast-check (existing), Playwright with `@axe-core/playwright`. No new dependency, font, route, migration, analytics event or API shape.

**Spec:** `docs/superpowers/specs/2026-11-27-studio-creator-professional-design.md` (owner-approved 27 Nov 2026), an addendum to `docs/superpowers/specs/2026-11-17-page-studio-styles-design.md` ("the styles spec"). Read both. "§n" below is the addendum's section; "styles §n" is the styles spec's. Visual authority: the existing canvas "Studio Page Styles", https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q (read with the Artifact tool, `action: "read"`); until the two boards exist, the owner's mockup minus §2 item 8. Earlier plan, whose conventions this one follows: `docs/superpowers/plans/2026-11-17-page-studio-styles.md`.

---

## What the code does today (origin/dev `3bc41af9`)

- **Registry:** `packages/contracts/src/studio-styles.ts`: nine ids, `STUDIO_STYLES`, `STUDIO_ACCENTS`, `CLASSIC_PURPLE`, `accentValues`, `studioContrastPairs(style, values, mode)` (one mode's values only), `studioTokens`. The exhaustive test (`packages/contracts/test/studio-styles.test.mjs`) asserts 162 combinations. `studio-photo-accent.ts` proves a candidate with `studioContrastPairs` over every id in `STUDIO_STYLE_IDS`.
- **Check:** `studio-check.ts` holds `studioSlotWidth` (per-style `DESKTOP` table, `Record<Exclude<StudioStyleId,'classic'>, …>`), `STUDIO_HEADING_PX` (`Record<StudioStyleId, number>`), `isEmpty` (text, quote, gallery, services, events), `cover-photo` (keys on `needsPhoto`, message `${style.name} looks best with a cover photo. Add one in Settings.`), and the `use-default-accent` fix label (already "Use TipMe purple" for a null default).
- **Links:** `packages/contracts/src/social-links.ts`: `PlatformSpec` (no placement), `SOCIAL_PLATFORMS` with fixed `featured` words, `visibleLinks`, `linkHandle` (returns `@kemisings`).
- **Web renderer:** `apps/web/src/components/studio-styles/`: `style-page.tsx` (`StudioStylePage`, `HEADER_OVER`, `studioHeader`, `renderStyled`; **`overPhoto = STUDIO_STYLES[style].needsPhoto`** picks Stage/Horizon's over-photo hero), `parts.tsx` (`STYLE_COVER`, `coverSizes`, `StyleCover`, `StyleIdentity`, `StyleLinks` with the visible "Find me elsewhere" title, `StyleBlocks`), `style-sheets.tsx` (`SHEETS: Record<StudioStyleId, …>` via `next/dynamic`), `sheets/<style>.tsx` importing `frame.css` + `<style>.css`, `style-tokens.ts` (`modeTokens`, `autoDarkCss`, `chromeCss`). Tip form: `apps/web/src/components/appreciation-form.tsx` (`TipSkin = Exclude<StudioStyleId,'classic'>`, in-page `composer-submit` reads "Tip ₦…", `.tip-bar`). Brand: `Wordmark` in `apps/web/src/components/brand.tsx`. Badge: `LinkBadge` in `components/profile/link-badge.tsx`.
- **Editor:** `apps/web/src/app/dashboard/studio/`: `style-cards.tsx` (`Miniature`, a ternary chain per style), `style-tab-model.ts` (`accentChoices`: TipMe purple only when `style === 'classic'`; `styleHeading`, `proBanner` generated), `blocks-model.ts` (`newBlock('text')` makes a paragraph), `use-studio-draft.ts` (`change`, `update`, undo stack via `describeChange`, which would label a starter "block added"), `undo-stack.ts` (`undoButtonName`), `blocks-tab.tsx` ("No blocks yet. Add one below."), `block-forms.tsx`.
- **Lab and tests:** `apps/web/src/app/dev/studio-lab/examples.ts` (`LAB_STYLE_EXAMPLES`; `scripts/studio-lab.test.mjs` requires one per registry id). Hand-written style lists: `tests/e2e/profile-fixtures.ts` `STYLE_IDS` (drives `/@style<id>`, `short<id>`, `style<id>nolinks`, the header, footer, celebration and preload specs, and `lab LCP sample: Studio pages`), `tests/e2e/studio-styles.spec.ts` `STYLES` and two inner lists, `tests/e2e/studio-styles.visual.spec.ts` `SHOTS` (light only; 18 Linux baselines). Budgets: `apps/web/test/route-css.test.mjs` (`every style the registry has has its own sheet`, 8 KB / 12 KB), `scripts/studio-fonts.test.mjs`, `scripts/web-bundle.test.mjs`, `tests/e2e/studio-page.spec.ts` (`a Studio page ships at most 3 KB more script than the standard page`, `a profile without studio renders exactly today’s page`).
- **Hooks:** `scripts/hooks/pre-push` runs format, lint, typecheck and every unit suite, so every pushed branch must be wholly green.

## Rulings on gaps in the spec (made by this plan; flag to the coordinator if any is wrong)

- **P1. PR slicing.** Listing an id breaks every exhaustive `Record<StudioStyleId,…>` (web `SHEETS`, contracts `DESKTOP`, `STUDIO_HEADING_PX`) and every registry loop (lab examples, sheet test), and once merged to dev a Pro person on staging could publish a style with no renderer. So §10 steps 1–2 are **one PR (A, Tasks 1–5)**, committed task by task and pushed only after Task 5; Task 1 adds stub sheets and lab examples so every commit stays green. §10 step 3 is **PR B (Tasks 6–7)**. §10 step 4 is Task 8 (design, in parallel). Between the PR A and PR B merges, the Style tab on staging draws the two new cards with the chain's fallback miniature; PR B follows directly.
- **P2. Creator's second Tip line.** §6.5 draws "Give, tip or appreciate" in `deepLabel` at 85%. Measured on 27 Nov with the contracts' `contrastRatio` and `blend`: Green 4.36 and Coral 4.29 on the unsheened fill, under the 4.5 the 13 px line needs (styles §4.2). Ruling: the line is `deepLabel` at **full opacity**, set apart by size and weight only, and its pair is in the contrast test at the opacity drawn, so any later opacity is proven. Changing it needs the coordinator.
- **P3. Slot widths and heading sizes** (§5.1 says "from section 8"; the layouts are in §7). Creator: desktop main column 1040 − 420 − 80 = **540** for text, media and lists; a gallery photo is a **156** strip tile at every width. Professional: blocks in one **640** column on desktop; gallery 3-up, gap 8: **208** desktop, `round((column − 16) / 3)` below 1024. `STUDIO_HEADING_PX`: Creator **20**, Professional **18** (phone section titles, §7.1, §7.2).
- **P4. The over-photo hero.** `overPhoto` keys on `needsPhoto`, which Creator sets `true`; that would set Creator's name on the photo, which §7.1 forbids. `style-page.tsx` gets `const OVER_PHOTO: readonly StudioStyleId[] = ['stage', 'horizon']` instead; `needsPhoto` keeps meaning only "a non-photo cover draws the gradient and the `cover-photo` notice".
- **P5. Starter details.** `newBlock('text', id)` makes a paragraph; starter headings set `variant: 'heading'`. Placeholder hints are held in memory, keyed by the new blocks' ids, for this editor session only (nothing stored, §7.6); after a reload the blocks are simply empty. "No thanks" is React state, gone on reload. The button reads **"Start with this layout"** (the card's own words) and the dismiss reads **"No thanks"**; no other new copy.
- **P6. Link row names.** §7.4 fixes the icon links' accessible name; rows keep the built pattern: label, sub, then " (opens in a new tab)".

## Global Constraints

Every task includes these.

- **Spec precedence:** every styles-spec rule applies unless the addendum's §11 names the change. A board in the canvas wins on any look once it exists; the PR names each difference. A neutral outside the envelope (§5.2) is never the builder's call: stop and ask the coordinator.
- **Registry:** ids appended after `'horizon'` in the order `'creator'`, `'professional'`; both `plan: 'pro'`; `displayFont: null` (Inter only; no new face, no font bytes); Creator `defaultAccent: null`, `naturalMode: 'dark'`, `needsPhoto: true`; Professional `defaultAccent: 'ink'`, `naturalMode: 'light'`, `needsPhoto: false`; both `modes` light/dark/auto, `covers` yours/gradient/plain, `linksAt: 'after-identity'`. Names "Creator" / "Professional"; moods "Bold, personal, made to be shared" / "Clean, composed, easy to trust".
- **No stored presentation:** no new document field, column, migration, SQL, API route or check version (`DESIGN_CHECK_VERSION` stays 3). Button labels and starter hints are fixed per style, never stored.
- **Accent placement (styles §7.2):** Tip button, selected amount, focus ring, link underlines. No glow behind Creator's Tip. Professional's heart is drawn in `accLabel`. The accent never fills a block.
- **Contrast (styles §4.2):** text 4.5:1, large text 3:1, non-text UI 3:1, light and dark, proven in `studioContrastPairs` for every accent. No text on a cover photo in either style.
- **Classic and the nine unchanged:** Classic byte-identical; the 18 existing style snapshots and `profile.visual` must not change; the other nine render links exactly as today (`place` is read only by the two new styles).
- **Budgets (styles §4.3):** styled page ≤ 12 KB gzip Studio CSS, standard/Classic ≤ 8 KB (unchanged); one family (Inter), ≤ 4 files, ≤ 200 KB; no new public-page client script (the 3 KB script-delta test and `scripts/web-bundle.test.mjs` must not move); `/@stylecreator` and `/@styleprofessional` < 2000 ms in `tests/e2e-perf/lcp.spec.ts`, `/@tobi` unchanged.
- **Accessibility:** WCAG 2.2 AA; targets ≥ 44×44; focus 2 px `accText`, offset 2; axe clean per style per mode; reduced motion: fades only (Creator), no scale (Professional).
- **Tip form (§6.5, styles §13):** `AppreciationForm` keeps its props, amounts, minimum, "Custom", drawer, fee line, errors and closed states; amount chips always show; the sticky bar reads "Tip ₦…".
- **Header:** TipMe logo only, no menu button, no Sign in (owner, 19 Nov). **No verified mark** anywhere. "Powered by tipme" on these two styles only: one link to `/`, accessible name "Powered by TipMe", no query string.
- **Copy:** users never see the payment provider's name ("our payment partner"); no copy implies regulatory approval, verification or licensing; pronoun "they".
- **Switch:** the `page_studio` switch stays **off in production**. Nothing here turns it on or edits its runbook row (`docs/runbooks/settings-and-switches.md`, `PAGE_STUDIO_ENABLED`); its preconditions (#283 tall crops through `<picture>`, a `perf:lab` re-run on every `/@style*` fixture on merged dev) stay open. Every PR is safe with it off and green with it on.
- **Money:** nothing changes a fee, minimum, checkout amount, ledger posting or payout. No real payments; tests never call `api.bachs.io`.
- **Analytics and ops:** none (D-07 stays open; §8).
- **Process:** test first, each behaviour watched red then green. Never `--no-verify`. Never edit `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PRs go into `dev`.
- **E2E:** lanes 3–8 only (`E2E_LANE=3`…`8`, never 9, never unset in a worktree). Before choosing a lane, check `pg_stat_activity` (command below) and take a lane with no connections. New or changed specs pass `--repeat-each=5 --retries=0` before push. Linux visual baselines come **only** from CI artifacts; never generate Linux baselines locally (Darwin copies may be).
- **Screenshots:** every UI PR body shows the expected UI at phone 390 and desktop 1440 (test data only: e2e users, lab documents, generated images), committed to the orphan `pr-assets` branch under `pr-<number>/` and linked as `https://raw.githubusercontent.com/TheSaviourEking/Tipme/pr-assets/pr-<number>/<file>.png`, including the undrawn tip-form states (Custom open, below-minimum error, starting, closed) in both styles.

## Commands used by every task

| What                 | Command                                                                                                                                                                  | Passing output              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Contracts tests      | `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`                                                                                            | `# fail 0`                  |
| Web unit tests       | `pnpm --filter @tipme/web test`                                                                                                                                          | `# fail 0`                  |
| Scripts tests        | `node --test scripts/studio-*.test.mjs scripts/web-bundle.test.mjs`                                                                                                      | `# fail 0`                  |
| Budgets on a build   | `pnpm --filter @tipme/web build && node --test apps/web/test/route-css.test.mjs`                                                                                         | `# fail 0`, no `# skip`     |
| Integration          | `pnpm test:integration`                                                                                                                                                  | `# fail 0`                  |
| Free lane            | `psql -d postgres -Atc "select datname, count(*) from pg_stat_activity where datname like 'tipme_test_lane%' group by 1"`                                                | chosen lane (3–8) not shown |
| E2E (one spec)       | `E2E_LANE=<n> pnpm exec playwright test tests/e2e/<spec>.ts --repeat-each=5 --retries=0 --workers=2`                                                                     | `passed`, 0 failed          |
| Lab LCP              | `E2E_LANE=<n> pnpm perf:lab -g "Studio pages"`                                                                                                                           | every sample `< 2000`       |
| Whole gate (as push) | `pnpm format:check && pnpm lint && pnpm typecheck && node --test scripts/*.test.mjs && pnpm exec turbo run test --filter='!@tipme/web' && pnpm --filter @tipme/web test` | exit 0                      |

Before the first e2e run in a lane: `rm -rf apps/web/.next && E2E_LANE=<n> TURBO_FORCE=true node scripts/build-e2e.mjs && E2E_LANE=<n> node scripts/prepare-e2e-database.mjs`.

## Review Focus

Inputs the spec implies but no drawn board shows, most likely to bite first. Each has its pinning test in the owning task.

1. **A featured link from an "icon" site** (Instagram featured), or a featured OnlyFans hidden by the adult-links switch. Expected: Instagram renders once, as the first row, and not in the icon row; with OnlyFans hidden the rows simply start with the next row link. _Tests:_ `the featured link is always the first row, whatever its site` and `with adult links hidden, a featured adult site leaves no row behind` (Task 2); the `mixed` link case in Tasks 3 and 4.
2. **The largest amount the form accepts, at 320 px.** Expected: Creator's amount wraps under line 2, Professional's pill wraps its words; nothing is clipped and the accessible name carries the whole amount. _Tests:_ `Creator's Tip fits the largest amount at 320 without clipping` (Task 3), `Professional's pill fits the largest amount at 320 without clipping` (Task 4).
3. **"Start with this layout" pressed twice, or pressed while a save is in flight.** Expected: the blocks are added once, as one undo step. _Test:_ `pressing "Start with this layout" twice adds the blocks once` (Task 7).
4. **Creator in Auto under a dark colour scheme with Ink** (curated, or a photo accent stored as failed with fallback Ink). Expected: the Tip uses Ink's dark values exactly as in Dark; it never draws a near-black button on the dark page. _Tests:_ `deep tokens exist in both modes and follow the Ink exception by value` (Task 1), `Creator with Ink draws a visible Tip in Dark and in Auto under a dark colour scheme` (Task 3).
5. **No profile photo (initials) and no bio.** Expected: the initials disc keeps the overlap (Creator on the faded foot, Professional on the card's top edge), and no empty gap is left where the bio would be. _Tests:_ `with no photo and no bio, Creator keeps its overlap and leaves no gap` (Task 3), `… Professional …` (Task 4).

---

## Delivery order

| PR  | Task                                                      | Touches API? | Visible UI?             |
| --- | --------------------------------------------------------- | ------------ | ----------------------- |
| A   | 1 Registry, tokens, contrast and envelope                 | No           | No (stubs)              |
| A   | 2 Link placement                                          | No           | No                      |
| A   | 3 Creator on the public page                              | No           | Lab, public (switch on) |
| A   | 4 Professional on the public page                         | No           | Lab, public (switch on) |
| A   | 5 Registry-driven tests, gating, budgets, perf, baselines | No           | (evidence)              |
| B   | 6 Style cards for the two styles                          | No           | Editor                  |
| B   | 7 "Start with this layout"                                | No           | Editor                  |
| —   | 8 Boards in the existing canvas (parallel)                | No           | Canvas                  |

PR A pushes once, after Task 5 (ruling P1). PR B starts after PR A merges. No PR regenerates OpenAPI (no API shape changes; confirm `pnpm api:openapi --check` stays clean in Task 5).

---

### Task 1: Registry, tokens, contrast proof and envelope (PR A)

**Files:**

- Modify: `packages/contracts/src/studio-styles.ts` (ids, entries, neutrals, `studioDeep`, `STUDIO_DEEP_SHEEN`, pairs, tokens), `packages/contracts/src/studio-check.ts` (`DESKTOP`, phone gallery branch, `STUDIO_HEADING_PX`), `apps/web/src/app/dashboard/studio/style-tab-model.ts` (`accentChoices` eligibility and its comment)
- Create (stubs, ruling P1): `apps/web/src/components/studio-styles/sheets/creator.tsx`, `sheets/professional.tsx` (import `../frame.css` and the style's file), `creator.css`, `professional.css` (a header comment naming §7.1 / §7.2, no rules yet); entries in `style-sheets.tsx`; `LAB_STYLE_EXAMPLES.creator = styleExample('creator', 'dark')`, `.professional = styleExample('professional', 'light')` in `apps/web/src/app/dev/studio-lab/examples.ts`
- Create: `packages/contracts/test/fixtures/photo-accent-before-creator.json`
- Test: `packages/contracts/test/studio-styles.test.mjs`, `studio-check.test.mjs`, `studio-photo-accent.test.mjs`; `apps/web/test/studio-editor.test.mjs`; text-only update in `tests/e2e/studio-editor.spec.ts` (run in Task 5)

**Interfaces:**

- Consumes: `contrastRatio`, `blend`, `hexToOklch`, `oklchToHex` (`studio-colour.ts`); `pickPhotoAccent` (`studio-photo-accent.ts`).
- Produces:

  ```ts
  export const STUDIO_STYLE_IDS: readonly [...nine, 'creator', 'professional'];
  /** Creator's Tip: the accent's light pair in both modes, except where the light pair is Ink's. */
  export function studioDeep(
    light: StudioAccentValues,
    dark: StudioAccentValues,
    mode: 'light' | 'dark',
  ): { fill: Hex; label: Hex };
  export const STUDIO_DEEP_SHEEN: number; // OKLCH L drop at the sheen's lower end, 0 to 0.06 (builder's call)
  // studioTokens('creator', …)[mode] gains deep, deepEnd (the sheen end), deepLabel.
  // Professional's neutrals carry `row` and `control`; Creator's carry `control`.
  // STUDIO_HEADING_PX gains creator: 20, professional: 18. DESKTOP gains creator, professional (ruling P3).
  // accentChoices(style, plan, hasAvatar): TipMe purple first for every style whose defaultAccent is null.
  ```

- [ ] **Step 1: Pin today's photo accents.** Before any change, write a one-off script in the scratchpad that runs `pickPhotoAccent` over 200 candidate lists from the existing seeded generator (`test/support/pbt.mjs`) and saves `[input, output]` pairs to `fixtures/photo-accent-before-creator.json`. Commit it with the test that reads it: `adding Creator and Professional changes no photo accent` (each input gives the pinned output). Run it: PASS (it pins today).
- [ ] **Step 2: Write the failing contracts tests** in `studio-styles.test.mjs`:
  - rename `nine styles in the canvas order…` to `eleven styles: the canvas nine, then Creator and Professional; Classic, Clear, Journal and Linen are free` (ids deep-equal, `STUDIO_FREE_STYLES` unchanged).
  - extend `each style opens differently (pass 2 defaults)` with the Global Constraints registry values; add `Creator and Professional have the addendum's names and moods`.
  - extend `every style's neutrals are the spec's` with the §5.2 table in lower-case hex (Professional `row` `#ffffff` light, `#202024` dark; Creator has no `row`).
  - exhaustive test: `combinations` is **198**.
  - `deep tokens exist in both modes and follow the Ink exception by value` (Review Focus 4): `studioTokens('creator', 'blue').dark.deep === '#0a5bd3'` and `.deepLabel === '#ffffff'`; `studioTokens('creator', null).dark.deep === '#7a32f9'`; `studioTokens('creator', 'ink').dark` has `deep '#f2f2f4'`, `deepLabel '#111113'`; `studioTokens('creator', 'photo', { failed: true, fallback: 'ink' }).dark.deep === '#f2f2f4'`; a successful photo accent's dark `deep` is its light fill; `.light.deep` always equals `.light.acc`; no other style has `deep`.
  - `Creator proves its Tip at both sheen ends and its second line, in light, and in dark only for Ink's values`: pair names `deepLabel on deep`, `deepLabel on deep (sheen end)`, `second line on deep`, `second line on deep (sheen end)` are in `studioContrastPairs('creator', STUDIO_ACCENTS.blue.light, 'light')`, absent for `STUDIO_ACCENTS.blue.dark` in `'dark'`, present for `STUDIO_ACCENTS.ink.dark` in `'dark'`.
  - `Creator proves chip label and selected ring on card, the badge on el2, chip borders on bg and card` and `Professional proves fg, fg2 and accText on row, chip borders on row and card, the selected border on row, and the badge on el2` (pair names present for every accent and mode).
  - `new surfaces sit inside the photo-accent envelope`: thresholds computed from the **nine original** styles (light: the darkest `bg`/`card` luminance; dark: the lightest), asserted ≈ 0.857 (Tiles `#eeeef1`) and ≈ 0.0149 (Linen `#24201b`) to 3 significant figures; every Creator and Professional `bg`, `card` and `row` is ≥ the light threshold in light and ≤ the dark threshold in dark. Luminance via `(contrastRatio(hex, '#000000') - 1) * 0.05`.
- [ ] **Step 3: Write the failing check and editor tests.** `studio-check.test.mjs`: `Creator and Professional slot widths follow their layouts` — `studioSlotWidth('creator','text',1440) === 540`, `('creator','gallery',390) === 156`, `('creator','gallery',1440) === 156`, `('professional','text',1440) === 640`, `('professional','gallery',1440) === 208`, `('professional','gallery',390) === 111`, `('professional','photo',390) === 350`; `heading sizes: Creator 20, Professional 18`; `cover-photo fires for Creator on Your cover without a photo, never for Professional` (message `Creator looks best with a cover photo. Add one in Settings.`); `name-fallback never fires for Creator or Professional` (name `Ɗanlami Ƙwairanga Ɓello`). `studio-editor.test.mjs`: retitle to `the heading reads "4 of 11 free" on Free and "11 styles" on Pro`, banner `Stage, Signboard, Sprint, Tiles, Horizon, Creator and Professional come with Pro.`; add `TipMe purple leads the swatches on every style whose default is no accent` (`accentChoices('creator','pro')[0]` is `{ value: null, name: 'TipMe purple' }`; Professional's first is `ink`; Classic unchanged).
- [ ] **Step 4: Run to see them fail.** Contracts tests and web tests. Expected: FAIL on the new assertions.
- [ ] **Step 5: Implement.** Registry entries and neutrals verbatim from §5.1–5.2. `studioDeep`: if `light.fill` and `light.label` equal `STUDIO_ACCENTS.ink.light`'s, return `dark` in dark mode; else the light pair. `studioContrastPairs('creator', a, mode)` adds the four Tip pairs (second line at full opacity, ruling P2) when `mode === 'light'`, or when `a` equals Ink's dark values; plus the chip, ring, badge and border pairs. Professional adds its `row` pairs. Keep the `defaultAccent` comments in sync ("null: TipMe purple"). `DESKTOP` and the phone gallery branch per ruling P3. `accentChoices`: `STUDIO_STYLES[style].defaultAccent === null` replaces `style === 'classic'`. Add the stubs and lab examples; update the e2e card-count test's title and words to seven cards and the new banner (it runs in Task 5).
- [ ] **Step 6: Run the tests and the type check.** Contracts, web, scripts tests, `pnpm typecheck`. Expected: `# fail 0`, exit 0; the Step 1 pin still passes.
- [ ] **Step 7: Commit (do not push, ruling P1).** `feat(contracts): Creator and Professional in the style registry` with the trailer.

---

### Task 2: Link placement (PR A)

**Files:**

- Modify: `packages/contracts/src/social-links.ts`
- Test: `packages/contracts/test/social-links.test.mjs`

**Interfaces:**

- Produces:

  ```ts
  export type LinkPlace = 'icon' | 'row';
  // PlatformSpec gains place: LinkPlace (required on every site).
  /** Creator and Professional only: follow sites in the icon row, the rest as rows; the featured link is always the first row. Saved order kept in each group. */
  export function splitLinksByPlace(links: readonly SocialLink[]): {
    icons: SocialLink[];
    rows: SocialLink[];
  };
  ```

- [ ] **Step 1: Write the failing tests:**
  - `every site has a fixed place: follow sites are icons, the rest are rows` — icons are exactly TikTok, Facebook, Instagram, X, Snapchat, Threads, LinkedIn; rows exactly YouTube, WhatsApp channel, Twitch, Kick, Audiomack, Boomplay, Spotify, Apple Music, SoundCloud, Website, Telegram, Patreon, Selar, Substack, OnlyFans, Fansly (by `SOCIAL_PLATFORM_KEYS`, so a new site without a place fails).
  - `the featured link is always the first row, whatever its site` (Review Focus 1) — a featured Instagram is `rows[0]` and not in `icons`; a featured YouTube placed fourth is `rows[0]`.
  - `each link lands once and each group keeps the saved order` — fast-check over link lists of up to 8 sites (at most one featured): `icons` + `rows` is a permutation of the input, with no duplicate URL.
  - `with adult links hidden, a featured adult site leaves no row behind` (Review Focus 1) — `splitLinksByPlace(visibleLinks(links, 'pro', { adult: false }))` with a featured OnlyFans has no OnlyFans and `rows[0]` is the next row link.
- [ ] **Step 2: Run to see them fail.** Contracts tests. Expected: FAIL (`place` missing, function not exported).
- [ ] **Step 3: Implement** `place` on every `SOCIAL_PLATFORMS` entry and `splitLinksByPlace`; export from `index.ts`.
- [ ] **Step 4: Run the tests.** Contracts tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit.** `feat(contracts): a fixed icon or row place for each link site`.

---

### Task 3: Creator on the public page (PR A)

**Files:**

- Create: `apps/web/src/components/tip-skin-label.ts`
- Modify: `apps/web/src/components/studio-styles/creator.css` (§6.5, §6.6, §7.1, §7.3, §7.5 verbatim), `parts.tsx` (`StyleIconRow`, `StyleLinkRows`, `PoweredBy`; `STYLE_COVER.creator`; `coverSizes`; the badge's monochrome variant, builder's call), `style-page.tsx` (`OVER_PHOTO`, ruling P4; `HEADER_OVER.creator = ['photo']`; the Creator branch), `appreciation-form.tsx` (skinned in-page Tip uses `skinTipLabel`), `apps/web/src/components/profile/link-badge.tsx` (only if the mono variant lives there), `tests/e2e/profile-fixtures.ts` (append `'creator'` to `STYLE_IDS`; add `LINK_CASES` pages and the no-photo page)
- Test: `apps/web/test/tip-skin-label.test.mjs`, `apps/web/test/studio-style-page.test.mjs`, `tests/e2e/studio-styles.spec.ts` (append `'creator'` to `STYLES`, the slot list and the chip-fit list), `tests/e2e/studio-styles.visual.spec.ts`

**Interfaces:**

- Consumes: `splitLinksByPlace` (Task 2); `deep`, `deepEnd`, `deepLabel` tokens (Task 1); `formatNaira` (`apps/web/src/lib/demo-amount.ts`); `Wordmark` (`components/brand.tsx`).
- Produces:

  ```ts
  /** The in-page Tip's fixed words for a skin; null keeps "Tip ₦…". */
  export function skinTipLabel(
    skin: TipSkin,
    amountMinor: string | number | bigint | null,
  ): { name: string; lines?: readonly [string, string] } | null;
  export function StyleIconRow(props: {
    links: readonly SocialLink[];
  }): JSX.Element | null; // <ul> of 44 px icon links
  export function StyleLinkRows(props: {
    links: readonly SocialLink[];
  }): JSX.Element | null; // <nav aria-label="Find me elsewhere">, no visible title
  export function PoweredBy(): JSX.Element; // <a href="/" aria-label="Powered by TipMe">Powered by <Wordmark/></a>
  // STYLE_COVER.creator = { tall: 488 + 76, desktopTall: 640 + 76 }
  // tests/e2e/profile-fixtures.ts:
  export const LINK_CASES: readonly [
    'none',
    'oneicon',
    'onerow',
    'allicon',
    'allrow',
    'mixed',
  ]; // pages /@<style>links<case>; 'mixed' = 8 links, Instagram featured
  // and /@<style>nophoto: no avatar, no bio
  ```

- [ ] **Step 1: Write the failing unit tests.** `tip-skin-label.test.mjs`: `Creator's Tip reads "Support my work" over "Give, tip or appreciate", named with the amount` (`skinTipLabel('creator', '200000')` → `{ name: 'Support my work, tip ₦2,000', lines: ['Support my work', 'Give, tip or appreciate'] }`; null amount → name `Support my work`); `every other skin keeps "Tip ₦…"` (`null` for each of the eight older skins). `studio-style-page.test.mjs` (`react-dom/server`, as today):
  - `Creator's DOM order is identity, icon row, chips and Tip, rows, blocks, Powered by, footer`.
  - `Creator splits links: follow sites in the icon row, the rest as rows, the featured link first, each once`.
  - `icon links are named "{Site}: {handle}, opens in a new tab"` (`Instagram: @kemisings, opens in a new tab`; `Website, opens in a new tab` with no handle).
  - `Creator's rows are a nav named "Find me elsewhere" with no visible title`.
  - `Powered by is one link home named "Powered by TipMe" with no query string`.
  - `Creator's cover box is Stage's` (`STYLE_COVER.creator` deep-equals `{ tall: 564, desktopTall: 716 }`, and creator.css `--tall` agrees, as the Stage test reads it).
  - `Creator lays the header over a photo cover only` (`studioHeader('creator', k)` is `'over'` for `photo`, `undefined` for `art`, `gradient`, `plain`).
  - `Creator never sets text on the photo` (no name, meta or bio element inside `.studio-cover`).
  - `Creator draws no verified mark` (nothing follows the name element; the HTML has no `/verified/i`).
  - `a non-photo Your cover draws Creator's gradient treatment` (design, automatic, animated).
  - `no other style's markup changes` (render each of the nine lab examples before and after; strings equal).
- [ ] **Step 2: Write the failing browser tests** in `studio-styles.spec.ts` (Creator joins the parameterised `renders cleanly…`, `sets long names in one face…`, `keeps the tip form's behaviour`, the slot and chip-fit tests by being appended):
  - `Creator's DOM order holds at 390 and 1440, and the sticky bar watches the in-page Tip`.
  - `Creator renders each visible link exactly once in every link case` (`/@creatorlinks<case>` for every `LINK_CASES` entry; `mixed`: Instagram is the first row, not an icon).
  - `Creator with Ink draws a visible Tip in Dark and in Auto under a dark colour scheme` (Review Focus 4: computed background of the in-page Tip is `rgb(242, 242, 244)` in `mode=dark&accent=ink` and in `mode=auto&accent=ink` with `page.emulateMedia({ colorScheme: 'dark' })`).
  - `Creator's Tip fits the largest amount at 320 without clipping` (Review Focus 2: type the form's maximum into Custom; `geometryProblems` empty; accessible name ends with that amount).
  - `while a tip starts, Creator's Tip reads "Starting your tip…"` (route the tip-start request to hang).
  - `with no photo and no bio, Creator keeps its overlap and leaves no gap` (Review Focus 5: `/@creatornophoto`; the initials disc's box overlaps the cover's foot by half its height ± 1 px; the gap from meta to the icon row equals the fixture with a bio minus the bio's box).
  - `studio-styles.visual.spec.ts`: `Creator at 390 dark`, `Creator at 1440 dark`, `Creator at 390 light` (`/dev/studio-lab?style=creator&mode=<mode>`, same waits as `SHOTS`; files `studio-creator-<width>-<mode>.png`).
- [ ] **Step 3: Run to see them fail.** Web tests; `E2E_LANE=<n>` for `studio-styles.spec.ts` (visual specs expect missing baselines).
- [ ] **Step 4: Implement** the parts, the Creator branch (desktop: 1040 content, the cover full width, a 420 px column of identity, icon row and Tip beside the main column of rows and blocks, gap 80, unless a board says otherwise), `skinTipLabel` in the skinned `composer-submit` (heart and chevron `aria-hidden`; the button's accessible name is `name`), the sticky bar per §6.5, creator.css (no glow; sheen to `deepEnd`; motion and reduced motion per §7.1). Inter only; `styleFontFaces('creator')` needs no change.
- [ ] **Step 5: Run unit and browser tests.** Web tests; each changed spec with `--repeat-each=5 --retries=0` in your lane, Darwin visual copies generated locally only; `a profile without studio renders exactly today’s page` and `profile.visual.spec.ts` unchanged.
- [ ] **Step 6: Commit.** `feat(web): the Creator style`.

---

### Task 4: Professional on the public page (PR A)

**Files:**

- Modify: `apps/web/src/components/studio-styles/professional.css` (§6.5, §6.6, §7.2, §7.3, §7.5 verbatim), `style-page.tsx` (`HEADER_OVER.professional = ['photo']`; the Professional branch with the card), `parts.tsx` (`STYLE_COVER.professional`; the 240 px art band), `apps/web/src/components/tip-skin-label.ts` (Professional's label), `tests/e2e/profile-fixtures.ts` (append `'professional'` to `STYLE_IDS`; its link-case and no-photo pages)
- Test: `apps/web/test/tip-skin-label.test.mjs`, `apps/web/test/studio-style-page.test.mjs`, `tests/e2e/studio-styles.spec.ts` (append `'professional'`), `tests/e2e/studio-styles.visual.spec.ts`

**Interfaces:**

- Consumes: `StyleIconRow`, `StyleLinkRows`, `PoweredBy`, `skinTipLabel`, `LINK_CASES` (Task 3); `row` neutrals (Task 1).
- Produces: `skinTipLabel('professional', amount)`; `STYLE_COVER.professional = { tall: 488 + 76, desktopTall: 440 + 76 }`; the card element `.studio-card` (the sticky bar's watch target stays the in-page Tip inside it).

- [ ] **Step 1: Write the failing unit tests:** `Professional's Tip reads "Send a ₦2,000 tip", or "Send a tip"` (`skinTipLabel('professional', '200000')` → `{ name: 'Send a ₦2,000 tip' }`; null → `Send a tip`); `Professional's card holds identity, icon row, rows, chips, Tip and Powered by, in that order, and the blocks follow the card`; `Professional's card has no shadow` (no `box-shadow` other than `none` under `.studio[data-style='professional'] .studio-card` in professional.css); `Professional's cover box: 564 on a phone, 516 from 1024 px`; `Professional lays the header over a photo cover only`; `a non-photo Your cover renders as cover art in a 240 px band` (`data-cover="art"`, no `cover-photo` notice: `needsPhoto` false); `Professional draws no verified mark`; `with no blocks the page ends at the card, then the footer`.
- [ ] **Step 2: Write the failing browser tests:** parameterised specs pick it up; `Professional's DOM order holds at 390 and 1440, and the sticky bar watches the in-page Tip`; `Professional renders each visible link exactly once in every link case`; `Professional's Ink pill is near-black on light and Ink's light pill in dark`; `Professional's pill fits the largest amount at 320 without clipping` (Review Focus 2); `with no photo and no bio, Professional keeps the avatar on the card's top edge and leaves no gap` (Review Focus 5); visual `Professional at 390 light`, `Professional at 1440 light`, `Professional at 390 dark` (the fixture has link rows and at least one block, so the images show rows inside the card above chips and Tip, "Powered by tipme" at the card's foot, and a block after the card).
- [ ] **Step 3: Run to see them fail.**
- [ ] **Step 4: Implement** per §7.2 (card inset 12 on a phone, rising 112 over a photo, 96 over gradient and art, 24 under the header when plain; desktop 960 card rising 160 over a 440 cover, two columns gap 56 with the right column 400, blocks in one 640 column below, unless a board says otherwise; motion 180 ms ease-out, colour and border only).
- [ ] **Step 5: Run unit and browser tests** as Task 3 Step 5.
- [ ] **Step 6: Commit.** `feat(web): the Professional style`.

---

### Task 5: Registry-driven tests, gating, budgets, perf and baselines; open PR A

**Files:**

- Modify: `tests/e2e/profile-fixtures.ts` (`STYLE_IDS` becomes `STUDIO_STYLE_IDS` from `@tipme/contracts`; `StyleId` follows), `tests/e2e/studio-styles.spec.ts` (`STYLES` and the two inner lists derive from the registry, minus exclusions each list names), `tests/integration/studio-api.test.mjs`
- Create: `apps/web/test/studio-style-copy.test.mjs`
- Test: the above, plus every budget, perf and visual spec

**Interfaces:**

- Consumes: everything from Tasks 1–4. Produces `NEW_STYLE_COPY: readonly string[]` inside the copy test (Task 7 extends it).

- [ ] **Step 1: Write the failing tests.**
  - `studio-style-copy.test.mjs`: `the Creator and Professional copy names no payment provider and claims no approval` — the moods, `Support my work`, `Give, tip or appreciate`, `Send a tip`, `Send a ₦2,000 tip`, `Powered by`, `Powered by TipMe`, read from their source modules (not retyped where a module exports them); none matches `/bachs/i` or `/\b(verified|licensed|regulated|approved|certified)\b/i`; and the provider-name guard's scanned roots include `apps/web/src/components/studio-styles/` and `packages/contracts/src/`.
  - Integration (`studio-api.test.mjs`): `Free can't switch to Creator or Professional (403) or publish either (422 pro-only)`; `a lapsed Creator page shows Classic with TipMe purple, the person's mode, and their text and quote blocks`; `renewed Pro shows Creator again`.
- [ ] **Step 2: Run to see them fail** (integration needs local Postgres and Redis); the copy test fails until the modules export their strings.
- [ ] **Step 3: Implement.** Swap the hand lists for the registry; export the fixed strings where the copy test needs them. No server code changes (gating keys on `plan === 'pro'`).
- [ ] **Step 4: Run every gate.** Whole gate; integration; budgets on a build (`a styled profile page downloads at most 12 KB gzip` for creator and professional with the bytes recorded; standard page ≤ 8 KB unchanged); `node --test scripts/studio-fonts.test.mjs scripts/web-bundle.test.mjs` unchanged; `pnpm --filter @tipme/api build && pnpm api:openapi --check` clean; in a free lane, `studio-styles.spec.ts`, `studio-page.spec.ts` (script delta and `renders exactly today’s page` unmoved), `profile-header.spec.ts` (logo alone on both styles), `footer-grounded.spec.ts`, `celebration-style.spec.ts`, `preload-warnings.spec.ts`, `studio-header-over-cover.spec.ts`, `studio-sticky-bar.spec.ts`, `studio-editor.spec.ts` (the seven-card test), each `--repeat-each=5 --retries=0`; `E2E_LANE=<n> pnpm perf:lab -g "Studio pages"`: every `/@stylecreator` and `/@styleprofessional` sample `< 2000`, `/@tobi` within the last dev run's range.
- [ ] **Step 5: Commit, push and open PR A.** `test(studio): registry-driven style lists, gating and copy for Creator and Professional`. Push `feat/studio-creator-professional`, open PR A into `dev`.
- [ ] **Step 6: Baselines from CI.** Download the CI job's Linux actuals for the six new images; commit them as baselines. CI must show **no diff** on the existing 18 and on `profile.visual`. Re-run CI green.
- [ ] **Step 7: Screenshots.** Lab pages for both styles at 390 (natural and other mode) and 1440 (natural), plus the undrawn tip-form states at 390, on `pr-assets/pr-<n>/`, linked in the PR body with the CSS bytes, the LCP samples and each difference from a board (if Task 8 has landed). Body states the switch stays off in production and the runbook preconditions are unchanged.

---

### Task 6: Style cards for Creator and Professional (PR B)

**Files:**

- Modify: `apps/web/src/app/dashboard/studio/style-cards.tsx` (two `Miniature` branches), `studio-editor.css` (their miniature rules)
- Test: `apps/web/test/studio-editor.test.mjs`, `tests/e2e/studio-editor.spec.ts`, `tests/e2e/studio-free-preview.spec.ts`

**Interfaces:**

- Consumes: `STUDIO_STYLES`, `accentValues` (natural mode, as today).
- Produces: `Miniature` draws `data-mini={styleId}` for every style (unit-testable), Creator's (dark, photo band, overlapping avatar, icon dots, a deep two-line bar) and Professional's (photo band, a rising card with rows and a dark pill).

- [ ] **Step 1: Write the failing tests:** unit `every style card draws its own miniature` (render `StyleCards` for each id; one `[data-mini="<id>"]` each, no fallback); e2e `a Pro person in Light picks Creator: the preview shows Creator in Light with TipMe purple selected, one tap from Dark` (owner: switching keeps the mode); `a Pro person picks Professional and the preview shows the card with Ink`; free-preview spec `a Free person previews Creator: the preview shows it with a PRO tag, the status reads "Previewing a Pro style: not saved", and no save is sent`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** the two miniatures (r14, the person's name in Inter, the current accent; schematic only).
- [ ] **Step 4: Run** web tests and both specs with `--repeat-each=5 --retries=0`; the existing `axe is clean on the Style and Blocks tabs at 390/1440` passes.
- [ ] **Step 5: Commit.** `feat(web): style cards for Creator and Professional`.

---

### Task 7: "Start with this layout" (PR B)

**Files:**

- Create: `apps/web/src/app/dashboard/studio/starter-layout.ts`, `starter-card.tsx`
- Modify: `use-studio-draft.ts` (`startLayout`, `starterHints`), `style-tab.tsx` (the card under the style cards), `blocks-tab.tsx` (the button in the empty state), `block-forms.tsx` (placeholder from `starterHints[block.id]`), `studio-editor.tsx` (the session's "No thanks" state), `studio-editor.css`, `apps/web/test/studio-style-copy.test.mjs` (adds the starter strings)
- Test: `apps/web/test/studio-starter.test.mjs`, `tests/e2e/studio-starter.spec.ts`, `tests/integration/studio-api.test.mjs`

**Interfaces:**

- Consumes: `newBlock`, `freshId(doc, also)` and `blockCounts` (`blocks-model.ts`); `studioDocumentSchema`, `checkDesign` (contracts); the undo stack's `push(prev, label)`.
- Produces:

  ```ts
  export type StarterStyle = 'creator' | 'professional';
  export function starterOffered(
    doc: StudioDocument,
    plan: 'free' | 'pro',
  ): doc is StudioDocument & { style: StarterStyle };
  export function withStarter(
    doc: StudioDocument,
    plan: 'free' | 'pro',
    newId: (taken: ReadonlySet<string>) => string,
  ): { doc: StudioDocument; hints: Record<string, string> } | null; // null unless offered
  export const STARTER_TITLE = 'Start with this layout';
  export const starterLine = (n: number) =>
    `Adds ${n} empty blocks you can fill in or remove. Nothing on your page moves.`;
  export const STARTER_DISMISS = 'No thanks';
  export const STARTER_UNDO_LABEL = 'starter layout added'; // button: "Undo: starter layout added"
  // StudioDraft gains startLayout(): void (no-op unless offered on the latest draft) and starterHints: Record<string, string>.
  ```

  Blocks, in order (§7.6): Creator `heading, gallery, heading, paragraph, quote`, hints `e.g. My work`, `e.g. About me` on the two headings; Professional `heading, paragraph, heading, gallery, heading, services`, hints `e.g. About me`, `e.g. My portfolio`, `e.g. Work with me` on the three headings. Headings are `newBlock('text')` with `variant: 'heading'` (ruling P5).

- [ ] **Step 1: Write the failing unit tests** (`studio-starter.test.mjs`):
  - `the offer shows only for Creator or Professional, zero blocks and Pro` (every style × 0 and 1 blocks × Free and Pro: true only for the two styles, 0 blocks, Pro).
  - `Creator adds heading, gallery, heading, paragraph, quote, all empty` and `Professional adds heading, paragraph, heading, gallery, heading, services, all empty` (kinds, variants, empty text/images/items, unique ids, appended to an empty list).
  - `a starter draft passes the strict write schema and holds no photo, image or video` (`studioDocumentSchema.safeParse(doc).success`; `blockCounts(doc)` images 0, videos 0; no `kind: 'video'`).
  - `every starter block is listed by empty-block until filled` (`checkDesign(doc, ctx).issues` with rule `empty-block` count equals the block count).
  - `hints are placeholders keyed by the headings and never in the document` (`JSON.stringify(doc)` has no `e.g.`).
  - `withStarter refuses a page with blocks and a Free account` (null).
  - `the line counts the blocks` (`starterLine(5)` and `starterLine(6)` verbatim).
- [ ] **Step 2: Write the failing browser and integration tests** (`studio-starter.spec.ts`, Pro e2e users made per test):
  - `a Pro person on an empty Creator page starts with the layout: five empty blocks and one undo step "Undo: starter layout added"`.
  - `undo empties the page and the offer returns`.
  - `discard restores the published blocks` (published with one paragraph; start, discard → that paragraph only).
  - `publish is blocked by empty-block until each starter block is filled or removed`.
  - `a page with blocks never sees the offer, and switching style never adds or moves blocks` (Creator → Professional → Clear with the starter blocks: same ids, same order).
  - `"No thanks" hides the offer until the editor is opened again`.
  - `pressing "Start with this layout" twice adds the blocks once` (Review Focus 3: `dblclick`, and a click while the first save is held by `page.route`; 5 blocks; one undo empties the page).
  - `the Blocks tab's empty state offers the same layout`.
  - `Free never sees the offer` (a Free person previewing Creator; a lapsed fixture).
  - `the placeholders show in the starter headings and are not saved` (input `placeholder` equals the hint; the PUT body's headings have `text: ''`).
  - axe clean on the card at 390 and 1440.
  - Integration: `a Free PUT with starter blocks is refused (403 STUDIO_PRO_REQUIRED)`.
- [ ] **Step 3: Run to see them fail.**
- [ ] **Step 4: Implement.** `startLayout` builds from the latest draft (so a second press sees blocks and does nothing), pushes one step with `STARTER_UNDO_LABEL`, sets the hints, and schedules the save like any change; no new route. The card shows when `starterOffered(draft, plan)` and not dismissed; the button carries `aria-describedby` the line.
- [ ] **Step 5: Run** web tests, integration, `studio-starter.spec.ts`, `studio-undo.spec.ts`, `studio-publish.spec.ts`, `studio-blocks.spec.ts` with `--repeat-each=5 --retries=0`; whole gate.
- [ ] **Step 6: Commit, push, open PR B.** `feat(web): "Start with this layout" for Creator and Professional`. Screenshots on `pr-assets/pr-<n>/`: the Style tab with both new cards (Free and Pro, 390), the starter card at 390 and 1440, the Blocks tab empty state, the starter blocks with their placeholders, the Check tab listing them.

---

### Task 8: Boards in the existing canvas (parallel with Task 1)

**Files:** none in the repository. Canvas: https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q only; **never publish a new artifact**.

- [ ] **Step 1: Read the canvas** with the Artifact tool (`action: "read"`), and note its version.
- [ ] **Step 2: Add the Creator and Professional boards** (phone 390 dark/light, desktop 1440, the tip-form states, the starter card) inside the existing canvas, drawn from §6–§7 and the mockup minus §2 item 8 (no tick, "Powered by tipme" kept, no ☰), with neutrals inside the envelope and the second Tip line at full opacity (ruling P2).
- [ ] **Step 3: Republish to the same URL** and record the new version in PR A's or PR B's body. If a board differs from the addendum, list each difference there; the board wins on looks except where §11 names the disagreement, and a neutral outside the envelope goes to the coordinator first.

---

## Spec coverage map

| Addendum                                    | Task          |
| ------------------------------------------- | ------------- |
| §2 owner decisions                          | 1, 3, 4, 7, 8 |
| §5.1 registry, swatch, pairs, tokens, slots | 1             |
| §5.2 neutrals, envelope                     | 1             |
| §5.3 document, API, check unchanged         | 1, 5          |
| §5.4 link placement                         | 2, 3, 4       |
| §6.1 accent, `deep`, Ink exception          | 1, 3          |
| §6.2 modes; §6.3 identity; §6.4 type        | 1, 3, 4, 6    |
| §6.5 tip moment and skins                   | 3, 4          |
| §6.6 Powered by; §6.7 header                | 3, 4, 5       |
| §7.1 Creator; §7.2 Professional             | 3; 4          |
| §7.3 blocks; §7.4 icons; §7.5 long names    | 3, 4          |
| §7.6 starter layout                         | 7             |
| §7.7 Free, Pro, lapse                       | 5, 6, 7       |
| §8 ops and analytics (none)                 | Global        |
| §9.1–9.8 evidence                           | 1, 3, 4, 5, 7 |
| §10 order of work                           | P1, 1–8       |
| §11 departures                              | 1, 3, 4       |

## Risks

- **Creator's photo cover LCP.** It is Stage's box (564 px on a phone). Lab fixtures pass today for Stage; a real photo would not until #283's `<picture>` read lands (runbook). This plan only adds `STYLE_COVER.creator` so that work serves it; it does not build #283 and does not turn the switch on.
- **12 KB budget.** Creator's two-line Tip and Professional's card add rules to `frame.css`-plus-sheet pages; if a sheet would pass 12 KB, stop and report the measured bytes before trimming anything visible.
- **Interim staging cards** between PR A and PR B (ruling P1).
- **Board drift.** If Task 8 lands after Task 3 or 4, reconcile in a follow-up commit on the same PR before merge.
