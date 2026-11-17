# Page Studio Styles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recipients stop designing pages and choose one of nine finished styles (Classic, Clear, Journal, Stage, Signboard, Sprint, Tiles, Linen, Horizon), with only accent, light/dark/auto, cover type and block order inside a style; Free gets four styles and publishes them; Pro adds five styles, the photo accent and media blocks; the G3 publish gate, undo, discard, Free preview and lapse rules finish the editor.

**Architecture:** A v2 `StudioDocument` stores only ids and enums (`style`, `accent`, `mode`, `cover`, ordered `blocks`). A static registry in `packages/contracts` (`STUDIO_STYLES`, `STUDIO_ACCENTS`) holds every colour the API, check and editor need, and an exhaustive unit test proves every style × accent × mode pair. The web renders each style through one frame (`StudioStylePage`) and per-style CSS keyed by `data-style`; Classic keeps today's markup and adds only token overrides and a blocks section. The cutover from v1 runs in three steps so every PR stays green: contracts add v2 beside a renamed v1 (PR 1c), the API accepts both and publishes only v2 (PR 3a), and the editor flips to v2 and the API stops accepting v1 (PR 4a).

**Tech Stack:** Next.js 16 App Router (server components), NestJS, Drizzle/Postgres (drizzle-kit migration for one column), Zod, sharp (already used), `node --test`, fast-check (already a devDependency), Playwright with `@axe-core/playwright`. New assets: Unbounded, Anton, Gentium Book Plus (renamed subset, see ruling R2), a Source Serif 4 italic and an Inter 400–800 file. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-17-page-studio-styles-design.md` (binding; approved in #263). Visual authority: canvas https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q, version `1794876761-e949` (read with the Artifact tool, `action: "read"`, for any value the spec says the board holds: paddings, gaps, hover colours, mock photo sizes). Earlier plan: `docs/superpowers/plans/2026-11-12-page-studio.md` (Tasks 1–9b built). Section numbers below (§n) are the spec's.

---

## What the code does today (origin/dev `3abdb3b9`, migrations up to 0113)

- **Contracts:** v1 document (`rows`, `brand`, `fonts`, `scale`, `corners`) in `packages/contracts/src/studio-document.ts` (`studioDocumentSchema`, `resolveStudio`, `defaultStudioDocument`); check v2 in `studio-check.ts` (`checkDesign`, `applyStudioFix`, `DESIGN_CHECK_VERSION = 2`); layout model in `studio-layout.ts`; 10 shipped families in `studio-type.ts` (`STUDIO_FONTS`, `STUDIO_REQUIRED_CODEPOINTS`); colour engine in `studio-colour.ts` (`hexToOklch`, `oklchToHex`, `contrastRatio`, `blend`, `deriveStudioPalette`); API shapes in `studio-api.ts` (`MyStudio`, `StudioAccess = 'edit' | 'preview' | 'lapsed'`). Tests in `packages/contracts/test/studio-*.test.mjs`, generators in `test/support/studio-arbitrary.mjs`, seeds in `test/support/pbt.mjs`, regressions in `test/fixtures/studio-regressions.json`.
- **Storage/ops:** `packages/database/src/operations/studio.ts` (`getMyStudio`, `saveStudioDraft`, `publishStudio`, `discardStudioDraft`, `publicStudioFor`, `studioPageFacts`, image ops). `lockProPage` refuses every write on Free (`STUDIO_PRO_REQUIRED`). Table `page_studios` (`draft`, `published`, `published_check_version`, `rev`). Integration tests: `tests/integration/studio-api.test.mjs`.
- **API:** `apps/api/src/studio/studio.controller.ts`; `StudioEnabledGuard` (`studio-switch.ts`) answers 404 while the `page_studio` admin switch is off (production). Avatar uploads: `apps/api/src/profiles/avatar.controller.ts` → `setAvatar` (512 px WebP), then `profile.changed`.
- **Public page:** `apps/web/src/app/people/[handle]/page.tsx` calls `studioFor` (`apps/web/src/lib/public-studio.ts`, Pro-only, campaign → null) and renders `StudioPage` (`apps/web/src/components/studio/`, rows renderer, `studio.css` 884 lines, linked on every `/@username`, 4.6 KB gzip). The tip panel is `AppreciationForm` (`apps/web/src/components/appreciation-form.tsx`); the phone Tip bar is always on (CSS `position: fixed`, `--tip-bar`).
- **Editor:** `apps/web/src/app/dashboard/studio/` (G1 shell, old Style tab with colour/font/scale/corner controls, G2 Blocks tab with rows and columns, `use-studio-draft.ts` with an 800 ms debounced save). No publish, undo or discard yet.
- **Lab:** `apps/web/src/app/dev/studio-lab/` (`?example=`, `?doc=` base64url deflate-raw, test builds only). E2E: `tests/e2e/studio-{page,editor,blocks,lab,examples}.spec.ts`, probes in `studio-probes.ts`, fixtures in `tests/e2e/profile-fixtures.ts`, LCP in `tests/e2e-perf/lcp.spec.ts` (`lab LCP sample: Studio pages`). Budgets: `apps/web/test/route-css.test.mjs`, `scripts/web-bundle.test.mjs`, `scripts/studio-fonts.test.mjs`, `tests/e2e/studio-page.spec.ts` (`a Studio page ships at most 3 KB more script than the standard page`, `a profile without studio renders exactly today’s page`).
- **Site-wide Inter fix (§2.4):** commit `2d04ab4b` ("money in Inter, Inter as the backup letters, darker hint") exists only on the local branch `fix/inter-fallback-money`; it is **not on dev and has no PR** as of this plan. `packages/ui/src/tokens.css` still has `--text-tertiary: #77736b`.

## Rulings on conflicts (made by this plan; flag to the coordinator if any is wrong)

- **R1 — v1→v2 cutover across PRs.** The spec wants writes v2-only and a PR order of contracts → renderer → API → editor → G3, each PR green. The old editor (G1/G2) can only edit v1 and cannot publish. So: PR 1c renames v1 identifiers to `…V1` and gives v2 the canonical names; PR 3a's `PUT /draft` accepts v1 (Pro only, today's rule) **or** v2 (new Free/Pro rules), and publish always stores v2; PR 4a flips the editor and makes the API refuse v1 writes. `MyStudio.access` keeps today's values until PR 4a, because the old editor would let Free save v1.
- **R2 — Gentium Book Plus licence.** Its OFL has Reserved Font Names "Gentium" and "SIL" (checked against `google/fonts` `ofl/gentiumbookplus/OFL.txt`, 17 Nov). `scripts/studio-fonts.test.mjs` refuses a subset under a reserved name (OFL 1.1 §3). Ruling: ship the subset as a Modified Version renamed to **"Linen Serif"** (name table and CSS family), as OFL allows. If the coordinator prefers another face, Task 1 stops before merge; nothing else changes.
- **R3 — Font registry shrink waits for PR 4c.** The old editor and the v1 resolver use the 10 shipped families until the editor flips; deleting them earlier breaks PR 1–3 tests.
- **R4 — Undo across a lapse (§11).** The server cannot see "the draft as loaded". It allows a Pro item (style, `photo` accent, Pro block by id with equal content) that equals the **stored draft or the published version**. A Free undo that would re-add a Pro item removed and already saved in this session is refused (403); the editor keeps that step undone and says "Adding this back needs Pro. Everything else is kept." (Review Focus 1.)
- **R5 — Free preview of Pro styles.** PR 4a draws Pro cards `aria-disabled` for Free (the canvas); PR 5c turns on the owner's preview (§12.4). Safe because the switch is off in production.
- **R6 — LCP evidence moves.** PR 2 measures each style on the lab (`/dev/studio-lab?style=<id>`); PR 3a re-points the test at published fixture profiles (`/@style<id>`).
- **R7 — `--text-tertiary`.** If `2d04ab4b` is not on dev when Task 1 starts, Task 1 makes the token change and its test (§2.4); if it is, Task 1 only checks it.

## Global Constraints

Every task includes these.

- **No stored presentation (§3 anti-goals):** no recipient-chosen colour, font, size, radius, spacing, column split or CSS is stored. v2 stores `v`, `style`, `accent`, `mode`, `cover`, `blocks` only (§5.2).
- **Accent placement (§7.2):** Tip button, selected amount, focus ring, link underlines (1.5 px, accent text value). One exception per style at most: Signboard cover band, Tiles' Tip tile and link glyphs, Stage's dark cover glow. Never body text, card fills or a second large surface.
- **Contrast (§4.2):** text 4.5:1, large text (≥ 24 px, or ≥ 18.66 px bold) 3:1, non-text UI 3:1, light and dark. Text on a photo is white over ≥ 55% black scrim (display names ≥ 42%). Dark mode never uses `#000` surfaces.
- **Glyphs (§4.1):** every face setting a name or heading draws ₦ (U+20A6), ẹ Ẹ ọ Ọ ṣ Ṣ ǹ, U+0300/U+0301/U+0323, ị ụ ṅ, ɓ ɗ ƙ ƴ Ɓ Ɗ Ƙ Ƴ, or is `wordFallback: true` and the **whole string** is set in Inter 700 (heading weight for headings). Money is always Inter, tabular lining figures, ₦ in the same face.
- **Fonts (§4.3):** a page emits `@font-face` only for Inter plus its own display face: ≤ 2 families, ≤ 4 files, ≤ 200 KB total, ≤ 100 KB per file, all from our origin. Preload only the name face. Studio Inter covers weights 400–800.
- **CSS budgets (§4.3):** a standard or Classic `/@username` page downloads ≤ **8 KB gzip** of Studio CSS (today 4.6 KB); a styled page ≤ **12 KB gzip**. No Studio CSS in `globals.css` or the root layout; every selector scoped to `.studio` or `.profile-page--studio`. Any `import './x.css'` reachable from `people/[handle]/page.tsx` is linked on **every** profile page (`route-css.test.mjs` explains why), so per-style rules must not be imported that way unless they fit the 8 KB standard budget.
- **Classic byte-identical (§4.3, §9.1):** a page that never picks a style, or publishes Classic with all defaults (`accent: null`, `mode: 'light'`, `cover: 'yours'`, no blocks), renders today's HTML, CSS and fonts exactly; `a profile without studio renders exactly today’s page` covers it; `profile.visual` snapshots must not change.
- **Script (§4.3):** no style adds client script except the sticky-bar `IntersectionObserver` inside `AppreciationForm`. The 3 KB script-delta test and `scripts/web-bundle.test.mjs` are raised by the measured increase only; the PR states before and after bytes.
- **LCP (§4.3):** each style's example at 390 px < 2000 ms in `tests/e2e-perf/lcp.spec.ts` (4× CPU, Fast-3G-like); `/@tobi` must not move. Field target LCP ≤ 2.0 s, CLS ≤ 0.05, INP ≤ 150 ms.
- **Accessibility (§4.4–4.5):** WCAG 2.2 AA; targets ≥ 44×44, Tip 48–56 tall; focus 2 px accent ring offset 2 (Signboard, Tiles: 3; Horizon glass: white); selected amount never by colour alone; `text-wrap: balance` on name and bio, `pretty` on paragraphs; axe clean per style per mode; auto mode is pure CSS `prefers-color-scheme`. Motion 150–400 ms, opacity/transform only; under `prefers-reduced-motion: reduce` fades only.
- **Tip form (§13):** `AppreciationForm` keeps its props, behaviour, states and tests; a `skin` changes class names and tokens only. Amounts, fees, minimums, validation and checkout are untouched. The fourth chip reads **"Custom"** in the eight new styles; Classic keeps **"Other amount"**. Each chip set shows the page's own preset amounts and minimum.
- **Footer (§8):** today's `ProfileFoot` at 12/16 Inter 500 in `fg2`; no "Made with TipMe".
- **Copy (§4.6):** pronoun "they"; the payment provider is always "our payment partner" (no provider name anywhere a user can see); never imply regulatory approval; canvas copy word for word. Fixed links title in every new style: **"Find me elsewhere"**.
- **Switch:** the `page_studio` admin switch gates everything, Free included; off → every Studio route 404 and no page gets `studio`. Every PR must be safe with it off (production) and green with it on (CI, e2e, staging).
- **Money and payments:** nothing changes a fee, minimum, checkout amount, ledger posting or payout. No real payments; tests never call `api.bachs.io`.
- **Process:** each task is one PR into `dev`, in task order. Test first: every behaviour change has a test watched red, then green. Migrations only via drizzle-kit. API-changing PRs regenerate OpenAPI (`pnpm --filter @tipme/api build && pnpm api:openapi`) and docs (`pnpm docs:generate`); their `--check` must pass. Never `--no-verify`. Never edit `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md`, `docs/design/redesign/README.md`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **E2E:** run only in lanes 3–8 (`E2E_LANE=3`…`8`, never 9 or unset in a worktree); new or changed specs pass `--repeat-each=5 --retries=0` locally before push (`tests/e2e/AGENTS.md`). Linux visual baselines come **only** from CI artifacts (download the job's `*-linux.png` actuals, commit them); never generate Linux baselines locally.
- **Screenshots:** every PR that changes visible UI puts phone 390 and desktop 1440 screenshots of the expected UI in its body (test data only: e2e users, lab documents, generated images), committed to the orphan `pr-assets` branch under `pr-<number>/` and linked as `https://raw.githubusercontent.com/TheSaviourEking/Tipme/pr-assets/pr-<number>/<file>.png`.

## Commands used by every task

| What               | Command                                                                                   | Passing output          |
| ------------------ | ----------------------------------------------------------------------------------------- | ----------------------- |
| Contracts tests    | `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`             | `# fail 0`              |
| Web unit tests     | `pnpm --filter @tipme/web test`                                                           | `# fail 0`              |
| Scripts tests      | `node --test scripts/studio-*.test.mjs scripts/web-bundle.test.mjs`                       | `# fail 0`              |
| Budgets on a build | `pnpm --filter @tipme/web build && node --test apps/web/test/route-css.test.mjs`          | `# fail 0`, no `# skip` |
| Integration        | `pnpm test:integration` (local Postgres + Redis)                                          | `# fail 0`              |
| E2E (one spec)     | `E2E_LANE=4 pnpm test:e2e -- tests/e2e/<spec>.ts --repeat-each=5 --retries=0 --workers=2` | `passed`, 0 failed      |
| Lab LCP            | `E2E_LANE=4 pnpm perf:lab -g "<test name>"`                                               | every sample `< 2000`   |
| Whole gate         | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`                           | exit 0                  |

## Review Focus

Inputs the spec implies but no drawn board shows, most likely to bite first. Each has its pinning test in the owning task.

1. **A lapsed (Free) person undoes the removal of a Pro block they had saved away this session.** Expected (R4): the step is refused with a clear sentence, the draft keeps everything else, nothing is lost from published. _Test:_ `a Free save may keep or restore Pro items held by the stored draft or published version, and nothing else` (Task 10) and `undo of a saved-away Pro block on Free stays undone and says why` (Task 15).
2. **Pro ends between the editor's check and publish.** Expected: no Pro design goes live; 422 with `pro-only`, draft kept. _Test:_ `a plan change during publish cannot put a Pro style live` (Task 10).
3. **The avatar changes or is removed while the page uses "From your photo".** Expected: the stored accent is recomputed for the new avatar; with no avatar the page renders the style's default accent, never a stale one, never an error. _Test:_ `a new or removed avatar recomputes or clears the photo accent and revalidates the page` (Task 11).
4. **Classic set back to its defaults** (accent swatch "TipMe purple", mode light, Your cover, every block removed). Expected: `accent: null` is stored and the public page is byte-identical to the standard page. _Test:_ `Classic with every choice back at its default is the standard page` (Task 10) and `choosing TipMe purple stores no accent` (Task 12).
5. **A document whose cover type the style doesn't offer** (`style: 'sprint', cover: 'gradient'`, from a crafted request or a style switch). Expected: it resolves to `cover: 'yours'`; it never renders a gradient Sprint. _Test:_ `a cover type the style does not offer resolves to Your cover` (Task 3) and `switching to a style without the current cover type selects Your cover` (Task 12).

---

## Delivery order

| PR  | Task                                                   | Touches API?                | Visible UI?             |
| --- | ------------------------------------------------------ | --------------------------- | ----------------------- |
| 1a  | 1 Fonts                                                | No                          | No                      |
| 1b  | 2 Style registry, accents, tokens, exhaustive contrast | No                          | No                      |
| 1c  | 3 Document v2, legacy rename, v1→v2 migration          | No                          | No                      |
| 1d  | 4 Design check v3                                      | No                          | No                      |
| 2a  | 5 Style frame, tip skin, sticky bar, lab v2, Clear     | No                          | Lab                     |
| 2b  | 6 Classic choices                                      | No                          | Lab                     |
| 2c  | 7 Journal and Linen                                    | No                          | Lab                     |
| 2d  | 8 Stage and Horizon                                    | No                          | Lab                     |
| 2e  | 9 Signboard, Sprint and Tiles                          | No                          | Lab                     |
| 3a  | 10 Server cutover: gating, v2 publish and public read  | **Yes**                     | Public page (switch on) |
| 3b  | 11 "From your photo"                                   | **Yes** (+ migration)       | Public page             |
| 4a  | 12 Editor on v2: Style tab and Blocks tab              | **Yes** (v1 writes refused) | Editor                  |
| 4b  | 13 Retire v1                                           | No                          | No                      |
| 5a  | 14 Publish gate                                        | No                          | Editor                  |
| 5b  | 15 Undo and discard                                    | No                          | Editor                  |
| 5c  | 16 Free preview of Pro styles; lapse banner            | No                          | Editor                  |

Strictly sequential; 3a, 3b and 4a regenerate OpenAPI and never merge in parallel. 2c–2e may be built in parallel after 2a and 2b (different style files) but merge in order.

---

### Task 1: Fonts for the styles (PR 1a)

**Files:**

- Modify: `scripts/studio-fonts.mjs` (sources and cuts for Inter 400–800, Source Serif 4 italic 400, Unbounded 600–700, Anton 400, Gentium Book Plus 400/700/400 italic renamed "Linen Serif"), `packages/contracts/src/studio-type.ts` (registry entries, metrics, Hausa in `STUDIO_REQUIRED_CODEPOINTS`), `docs/third-party-component-register.md`, every reference to `inter-400-700.woff2` (`grep -rn inter-400-700 apps packages scripts`)
- Create: `apps/web/public/fonts/studio/{inter-400-800,source-serif-4-400-italic,unbounded-600-700,anton-400,linen-serif-400,linen-serif-700,linen-serif-400-italic}.woff2`, `OFL-Unbounded.txt`, `OFL-Anton.txt`, `OFL-GentiumBookPlus.txt`
- Delete: `apps/web/public/fonts/studio/inter-400-700.woff2`
- Modify (only if R7 applies): `packages/ui/src/tokens.css` (`--text-tertiary: #6e6a63`; `--border-control` unchanged)
- Test: `packages/contracts/test/studio-type.test.mjs`, `scripts/studio-fonts.test.mjs`, `packages/ui/test/tokens.test.mjs` (only if R7 applies)

**Interfaces:**

- Produces: `StudioFontId` gains `'unbounded' | 'anton' | 'linen-serif'`; `source-serif-4` gains an italic 400 file and stays `wordFallback: true`; `inter` file is `inter-400-800.woff2` with weights `[400, 800]`. Existing ids stay (R3). `STUDIO_REQUIRED_CODEPOINTS` adds U+0253 U+0257 U+0199 U+01B4 U+0181 U+018A U+0198 U+01B3.

- [ ] **Step 1: Write the failing tests.** In `studio-type.test.mjs`: `the required characters cover Yoruba, Igbo, Hausa hooked letters, tone marks and the naira sign` (asserts the eight Hausa code points above are in `STUDIO_REQUIRED_CODEPOINTS`); `the style faces are registered with their files` (asserts `unbounded`, `anton`, `linen-serif` exist; `linen-serif` has three files including `style: 'italic'`; `source-serif-4` has an italic file and `wordFallback === true`; `inter` weights span 400–800). In `scripts/studio-fonts.test.mjs`: `every style page stays within 2 families, 4 files and 200 KB` (for Inter + each of `null`, `source-serif-4`, `unbounded`, `anton`, `linen-serif`: files ≤ 4, bytes ≤ 204800, each file ≤ 102400). Extend `no shipped family carries a Reserved Font Name…` to read each woff2 `name` table and assert no name record contains `Gentium` or `SIL`.
- [ ] **Step 2: Run them to see them fail.** Run the contracts and scripts tests. Expected: FAIL on the new assertions (missing ids, missing code points, missing files).
- [ ] **Step 3: Cut the files.** Add the families to `scripts/studio-fonts.mjs` at the pinned `SOURCE_COMMIT` with recorded sha256; Linen Serif is cut from Gentium Book Plus with `fonttools` renaming name IDs 1, 4, 6, 16 to "Linen Serif" (R2); Inter keeps `tnum` and `lnum`. Run `node scripts/studio-fonts.mjs build --python <python>`; copy printed metrics into `studio-type.ts`. Add the three register entries (licence, source commit, RFN note for Gentium).
- [ ] **Step 4: Darker hint (R7).** `git branch -r --contains 2d04ab4b` and `grep -n text-tertiary packages/ui/src/tokens.css`. If dev lacks it: test `--text-tertiary is 4.5:1 or better on the recessed field` (`#6e6a63` on the Other-amount well colour ≥ 4.5; on `#ffffff` ≥ 5.3), then set the token. `--border-control` stays `#77736b`.
- [ ] **Step 5: Run every test.** Contracts, scripts and (if touched) `pnpm --filter @tipme/ui test`. Expected: `# fail 0`.
- [ ] **Step 6: Commit and open PR 1a.** `git commit -m "feat(studio): style fonts — Unbounded, Anton, Linen Serif, Source Serif italic, Inter 400–800"` with the trailer; PR body lists each file's bytes (from `node scripts/studio-fonts.mjs`) and states R2.

---

### Task 2: Style registry, accent set, tokens and the exhaustive contrast proof (PR 1b)

**Files:**

- Create: `packages/contracts/src/studio-styles.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/studio-styles.test.mjs`

**Interfaces:**

- Consumes: `Hex`, `StudioMode`, `contrastRatio`, `hexToOklch`, `oklchToHex` (`studio-colour.ts`); `StudioFontId` (Task 1).
- Produces (shapes exactly as §5.1):

  ```ts
  export const STUDIO_STYLE_IDS: readonly ['classic','clear','journal','stage','signboard','sprint','tiles','linen','horizon'];
  export type StudioStyleId; export const STUDIO_ACCENT_IDS: readonly ['ink','blue','lagoon','green','violet','rose','coral','amber','photo'];
  export type StudioAccentId; export type StudioCuratedAccentId = Exclude<StudioAccentId,'photo'>;
  export interface StudioAccentValues { fill: Hex; label: Hex; text: Hex }
  export const STUDIO_ACCENTS: Record<StudioCuratedAccentId, { name: string; light: StudioAccentValues; dark: StudioAccentValues }>;
  export const CLASSIC_PURPLE: { name: 'TipMe purple'; light: StudioAccentValues; dark: StudioAccentValues };
  export type StudioCoverType = 'yours' | 'gradient' | 'plain';
  export interface StudioNeutrals { bg: Hex; card: Hex; el2: Hex; fg: Hex; fg2: Hex; line: Hex; [extra: string]: string }
  export interface StudioStyle { id; name; mood; plan: 'free'|'pro'; displayFont: StudioFontId|null; defaultAccent: StudioCuratedAccentId|null; naturalMode: 'light'|'dark'; modes: readonly StudioMode[]; covers: readonly StudioCoverType[]; needsPhoto: boolean; linksAt: 'after-identity'|'after-tip'|'rail'; neutrals: { light: StudioNeutrals; dark: StudioNeutrals } }
  export const STUDIO_STYLES: Record<StudioStyleId, StudioStyle>;
  export const STUDIO_FREE_STYLES: readonly StudioStyleId[]; // derived from plan
  export function accentValues(style: StudioStyleId, accent: StudioAccentId | null, mode: 'light'|'dark', photo?: { light: StudioAccentValues; dark: StudioAccentValues } | null): StudioAccentValues;
  export interface StudioContrastPair { name: string; fg: Hex; bg: Hex; min: 3 | 4.5 }
  export function studioContrastPairs(style: StudioStyleId, accent: StudioAccentValues, mode: 'light'|'dark'): StudioContrastPair[];
  export type StudioTokenMap = Record<string, string>; // keys without the --studio- prefix
  export function studioTokens(style: StudioStyleId, accent: StudioAccentId | null, photo?: … | null): { light: StudioTokenMap; dark: StudioTokenMap };
  ```

- [ ] **Step 1: Write the failing tests** in `studio-styles.test.mjs`:
  - `nine styles in the canvas order; Classic, Clear, Journal and Linen are free` — `STUDIO_STYLE_IDS` deep-equals the order above; `STUDIO_FREE_STYLES` deep-equals `['classic','clear','journal','linen']`.
  - `each style opens differently (pass 2 defaults)` — default accents: clear blue, journal green, stage violet, signboard amber, sprint ink, tiles rose, linen coral, horizon lagoon, classic `null`; `naturalMode` is `dark` only for stage; covers: `signboard` and `sprint` are `['yours','plain']`, all others `['yours','gradient','plain']`; `needsPhoto` only stage and horizon; display faces: journal `source-serif-4`, signboard `unbounded`, sprint `anton`, linen `linen-serif`, classic `dm-serif-display`, the rest `null`.
  - `the accent set is the canvas table` — every fill/label/text in §7.3 verbatim (e.g. amber light `{fill:'#f2b12e',label:'#1a1300',text:'#8a5800'}`, violet dark `{fill:'#b49bff',label:'#0e1116',text:'#b49bff'}`); `CLASSIC_PURPLE.light.fill === '#7a32f9'`, `.dark.fill === '#c8aeff'`, `.dark.label === '#141210'`.
  - `every style's neutrals are the spec's` — one assertion per style per mode with the §9.x values (Classic dark from §9.1: `#141210`, `#1e1b18`, `#2a2622`, fg `#f3f2ee`, fg2 `#c9c4ba`).
  - `every style × accent × mode meets its contrast minimums (exhaustive)` — loops 9 styles × (8 curated + Classic purple for Classic) × 2 modes; asserts `contrastRatio(fg,bg) >= min` for every pair from `studioContrastPairs`; asserts the loop ran 162 combinations and at least 12 pairs each (not vacuous).
  - `on Clear the lowest ratio is violet on the dark segmented thumb, 4.9:1` — the minimum across Clear's pairs, rounded to 1 dp, is 4.9 and its pair name is the thumb pair.
  - `the checker catches a failing pair` — a fake accent `{fill:'#ffff00',label:'#ffffff',text:'#ffff00'}` produces failures.
  - `tokens carry neutrals and accent for both modes; Classic with no accent is TipMe purple` — `studioTokens('clear', null).light.acc === '#0a5bd3'`; `studioTokens('classic', null).dark.acc === '#c8aeff'`; keys are `[a-zA-Z0-9]+` only.
- [ ] **Step 2: Run to see them fail.** Contracts tests. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `studio-styles.ts`.** Values copied from §7.3 and §9.1–9.9 (lower-case hex). `studioContrastPairs` returns, for every style: `fg/bg`, `fg/card`, `fg2/bg`, `fg2/card` (4.5); `accText/bg`, `accText/card` (4.5); `accLabel/acc` (4.5); focus ring `accText` vs `bg` and `card` (3); plus each style's signature selected-state pairs from its §9.x "Tip moment" row (Clear: accText on `thumb`; Journal/Linen: accText on `chipOn`, where `chipOn` = `color-mix(in oklab, acc 6%, bg)` computed in OKLab here and in CSS; Signboard: `bg` on `ink`, `accLabel` on `acc` for the band; Sprint: `accLabel` on `acc`; Tiles: `acc` on `accLabel` and `accLabel` on `acc`, chip ring `accLabel` 45% over `acc` ≥ 3; Stage: ring `accText` vs `chip` ≥ 3; Horizon: ring `accText` vs `bg` ≥ 3; Classic: selected key label `label` on `fill`, link `text` on `#f3f2ee`/`#fffefa`/`#eeede8`/`#ffffff` light and `#141210`/`#1e1b18`/`#2a2622` dark). Where an accent fails on Classic surfaces only, add a Classic-only `text` value found by stepping OKLCH L (darker in light, lighter in dark) with `oklchToHex` until it passes, and hard-code the result in `STUDIO_ACCENTS[id].classic` (§7.3 "my call"); the test proves it.
- [ ] **Step 4: Run the tests.** Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 1b.** `feat(contracts): Studio style registry, accent set and exhaustive contrast proof`; body lists any Classic-only text values and the lowest ratio per style.

---

### Task 3: The v2 document, legacy rename and v1→v2 migration (PR 1c)

**Files:**

- Create: `packages/contracts/src/studio-document-v1.ts` (today's `studio-document.ts` moved, identifiers renamed), `packages/contracts/test/fixtures/studio-v1-to-v2.json`
- Modify: `packages/contracts/src/studio-document.ts` (v2), `studio-check.ts`, `studio-layout.ts`, `studio-api.ts`, `index.ts`; mechanical renames in `packages/database/src/operations/studio.ts`, `packages/database/src/schema.ts`, `apps/web/src/components/studio/*`, `apps/web/src/app/dashboard/studio/*`, `apps/web/src/app/dev/studio-lab/*`, `apps/web/src/lib/public-studio.ts`, `tests/e2e/profile-fixtures.ts`, `apps/web/test/studio-*.test.mjs`, `packages/contracts/test/**`
- Modify: `packages/contracts/test/support/studio-arbitrary.mjs` (+ `.d.mts`) — add v2 generators beside the renamed v1 ones
- Test: `packages/contracts/test/studio-document.test.mjs` (v2), `packages/contracts/test/studio-document-v1.test.mjs` (today's tests, renamed imports), `packages/contracts/test/studio-migrate.test.mjs`

**Interfaces:**

- Consumes: Task 2's ids and `STUDIO_STYLES`, `STUDIO_ACCENTS`, `hexToOklch`.
- Renames (behaviour unchanged; every consumer updated in this PR): `StudioDocument`→`StudioDocumentV1`, `StudioBlock`→`StudioBlockV1`, `StudioRow`→`StudioRowV1`, `studioDocumentSchema`→`studioDocumentV1Schema`, `resolveStudio`→`resolveStudioV1`, `defaultStudioDocument`→`defaultStudioDocumentV1`, `PublicStudio`→`PublicStudioV1`, `checkDesign`→`checkDesignV1`, `applyStudioFix`→`applyStudioFixV1`, `DESIGN_CHECK_VERSION`→`DESIGN_CHECK_VERSION_V1` (= 2), `MyStudio`→`MyStudioV1`, `studioDraftSchema`→`studioDraftV1Schema`, `StudioCheckContext`→`StudioCheckContextV1`. `StudioIssue`, `StudioNotice`, `StudioFix` and `StudioCheckResult` keep their names; v3 reuses them.
- Produces:
  ```ts
  export type StudioBlockKind = 'text'|'photo'|'gallery'|'video'|'services'|'events'|'quote'|'supporters';
  export type StudioBlock = /* today's block content minus `variant`, `level`; text has variant 'heading'|'paragraph'; no 'about', no 'links' */;
  export interface StudioDocument { v: 2; style: StudioStyleId; accent: StudioAccentId | null; mode: StudioMode; cover: StudioCoverType; blocks: StudioBlock[] }
  export const studioDocumentSchema: z.ZodType<StudioDocument>; // limits from STUDIO_LIMITS: blocks 40, pageImages 24, galleryImages 9, videos 3, events 6, services 12, text limits
  export function migrateStudioV1(doc: StudioDocumentV1): StudioDocument;
  export function resolveStudio(raw: unknown, today: string): StudioDocument; // v1 or v2 in, valid v2 out; never throws; idempotent
  export function defaultStudioDocument(): StudioDocument; // { v:2, style:'classic', accent:null, mode:'light', cover:'yours', blocks:[] }
  export function isClassicDefault(doc: StudioDocument): boolean;
  export const STUDIO_PRO_BLOCKS: readonly StudioBlockKind[]; // photo, gallery, video, services, events
  export function studioImageIdsOf(doc: StudioDocument): Set<string>;
  ```
- `STUDIO_LIMITS` drops `rows` and `blocksPerCell` only once v1 is retired (Task 13); v2 does not read them.

- [ ] **Step 1: Rename v1, no behaviour change.** Move the module, rename identifiers, update every importer (`grep -rlw` list above). Run `pnpm typecheck && pnpm test`. Expected: green, identical test counts. Commit `refactor(studio): name the v1 document as legacy` (trailer).
- [ ] **Step 2: Write the failing v2 tests** in `studio-document.test.mjs`:
  - `a v2 document stores only ids and enums` — schema refuses extra keys `brand`, `fonts`, `scale`, `corners`, `rows`; refuses `variant` on photo/gallery/video/services/events/quote; refuses kinds `about` and `links`; refuses text `level`.
  - `limits: 40 blocks, 24 photos, 9 per gallery, 3 videos, 6 events, 12 services` — one over each fails, at each passes.
  - `a cover type the style does not offer resolves to Your cover` — `resolveStudio({...v2, style:'sprint', cover:'gradient'}).cover === 'yours'`; same for signboard. (Review Focus 5.)
  - `resolveStudio never throws, is idempotent and always yields a schema-valid v2 document` — property over the v2 and v1 generators and arbitrary JSON.
  - `the default document is Classic with nothing chosen` and `isClassicDefault is true only for it` (any one field changed → false).
- [ ] **Step 3: Write the failing migration tests** in `studio-migrate.test.mjs` (§7.1 table verbatim):
  - `a heading in source-serif-4 or fraunces becomes Journal`; `otherwise dark mode becomes Stage`; `otherwise DM Serif Display with Manrope becomes Classic`; `anything else becomes Clear`.
  - `brand[0] becomes the nearest accent by OKLab; greys become Ink; the old default purple becomes no accent` — `#7a32f9`→`null`; `#777777`→`'ink'`; `#1d4e89`→ the nearest by `hexToOklch` distance (pin the value).
  - `mode is kept, cover is Your cover, rows flatten in reading order` — row by row, left column first, top to bottom.
  - `About, Links, supporters and row photo backgrounds are dropped; lead becomes paragraph; variants and levels go`.
  - `converted fixtures are pinned` — every document in `studio-examples.mjs` (Kemi, Sule, Ify) and `studio-regressions.json` converts to exactly the matching entry in `fixtures/studio-v1-to-v2.json`.
- [ ] **Step 4: Run to see them fail.** Contracts tests. Expected: FAIL (no v2 exports).
- [ ] **Step 5: Implement** the v2 schema, `migrateStudioV1`, `resolveStudio` (detects `v`, v1 → `resolveStudioV1` → `migrateStudioV1`; then trims to limits, drops unknown kinds and passed events as v1 does, fixes covers the style lacks), `defaultStudioDocument`, `isClassicDefault`, `studioImageIdsOf`, and the v2 generator `studioDocumentArb` (v1 one renamed `studioDocumentV1Arb`). Generate `studio-v1-to-v2.json` once from the implementation, then review each entry against the §7.1 table by hand before committing it.
- [ ] **Step 6: Run everything.** `pnpm typecheck && pnpm test`. Expected: green.
- [ ] **Step 7: Commit and open PR 1c.** `feat(contracts): Studio document v2 with the v1 migration`.

---

### Task 4: Design check v3 (PR 1d)

**Files:**

- Create: `packages/contracts/src/studio-check-v3.ts` (becomes `studio-check.ts` in Task 13)
- Modify: `packages/contracts/src/index.ts`, `apps/web/test/no-provider-names.test.mjs` (add `packages/contracts/src` to `roots`)
- Test: `packages/contracts/test/studio-check-v3.test.mjs`

**Interfaces:**

- Consumes: v2 document (Task 3), registry (Task 2), `STUDIO_FONTS` coverage (Task 1), v1 helpers for photo/video/weight rules (`studioWeight`, `RENDITION_WIDTHS`, image facts).
- Produces:
  ```ts
  export const DESIGN_CHECK_VERSION = 3;
  export interface StudioCheckContext {
    images: Record<string, { width: number; height: number; bytes: number }>;
    videos: Record<string, 'ok' | 'gone' | 'unknown'>;
    profile: { name: string; bio: boolean; links: number };
    plan: 'free' | 'pro';
    coverKind: 'photo' | 'design' | 'automatic' | 'animated' | 'none';
    hasAvatar: boolean;
  }
  export function checkDesign(
    doc: StudioDocument,
    ctx: StudioCheckContext,
  ): StudioCheckResult; // StudioIssue/StudioNotice/StudioFix shapes as v1
  export function applyStudioFix(
    doc: StudioDocument,
    issue: StudioIssue,
    fixId: string,
  ): StudioDocument;
  export function studioSlotWidth(
    style: StudioStyleId,
    kind: StudioBlockKind,
    viewport: number,
  ): number; // replaces cellWidths
  export function proItemsOf(doc: StudioDocument): {
    style: boolean;
    photoAccent: boolean;
    blockIds: string[];
  };
  ```
- `StudioRuleId` is widened with the new ids below; v1 keeps its own.
- Rule ids: `pro-only`, `photo-resolution`, `photo-alt`, `empty-block`, `broken-video`, `page-weight`, `long-word` (errors); `cover-photo`, `name-fallback`, `missing-links` (notices). Fix ids for `pro-only`: `choose-free-style` (needs input), `use-default-accent` (pure), `remove-block` (pure), `see-pro` (link).

- [ ] **Step 1: Write the failing tests** in `studio-check-v3.test.mjs`:
  - `pro-only fires on Free for a Pro style, the photo accent or a Pro block, and never on Pro` — one minimal document each; `plan: 'pro'` gives no issue.
  - `pro-only fixes: "Use Blue" sets the style default, "Remove the block" removes it, "Choose a free style" needs input, "See Pro" is a link` — label of the accent fix is `Use ${STUDIO_ACCENTS[default].name}`.
  - `cover-photo is a notice for Stage and Horizon on Your cover without a photo` — message exactly `Stage looks best with a cover photo. Add one in Settings.`; no notice on Clear, or with `coverKind: 'photo'`.
  - `name-fallback names the face` — Journal + name `Ɗanlami Ƙwairanga Ɓello` → `Your name has a letter Source Serif 4 can't draw, so it's set in Inter.`; Clear never.
  - `missing-links is a notice with no fix` — `Add links in Settings to show them on your page.`
  - `long-word measures headings in the style's display face at 320 px` — a 40-letter heading word in Signboard fails, the same in Clear at a width that fits passes; fix `Use a shorter heading` needs input.
  - `photo rules use the style's slot widths` — a 640 px wide photo fails where `studioSlotWidth` × 2 > 640 and passes where it fits.
  - `the removed rules never fire` — no issue or notice id in `contrast`, `contrast-on-photo`, `fonts`, `phone-fit`, `crowded`, `heading-order`.
  - `every offered pure fix removes its issue and adds no new error` and `checkDesign is pure and deterministic` — properties over `studioDocumentArb` × plan.
  - `the default document passes on Free and Pro`.
- [ ] **Step 2: Run to see them fail.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `studio-check-v3.ts`, reusing the v1 photo/video/weight helpers with `studioSlotWidth` (per-style widths from §9 layouts: e.g. Clear desktop grid column `(920-40)/2`, phone `390-40`). Copy every message verbatim from §5.5.
- [ ] **Step 4: Run the tests and the provider-name test.** Contracts and web tests. Expected: `# fail 0`.
- [ ] **Step 5: Commit and open PR 1d.** `feat(contracts): Studio design check v3 for styles`.

---

### Task 5: Style frame, tip skin, sticky bar, lab v2 and Clear (PR 2a)

**Files:**

- Move: `apps/web/src/components/studio/video-embed.tsx` → `apps/web/src/components/studio-styles/video-embed.tsx` (the old renderer imports the new path; the click-to-load island is shared)
- Create: `apps/web/src/components/studio-styles/style-page.tsx` (`StudioStylePage`), `parts.tsx` (`StyleCover`, `StyleIdentity`, `StyleLinks`, `StyleBlocks`), `style-fonts.ts` (`styleFontFaces`, `styleFontPreload`), `frame.css`, `clear.css`, `README` comment at the top of `style-page.tsx` explaining the CSS-delivery method chosen
- Modify: `apps/web/src/components/appreciation-form.tsx` (`skin` prop, `IntersectionObserver` for the bar), the CSS that owns the phone Tip bar (`apps/web/src/app/globals.css` rules near `--tip-bar`; Classic unchanged), `apps/web/src/app/dev/studio-lab/page.tsx` and `examples.ts` (v2 branch: `?style=<id>&mode=&accent=&cover=&doc=` and `?example=styles-min|styles-max|long-names|hostile`)
- Modify: `scripts/studio-source.test.mjs` (also scan `components/studio-styles/`: no raw HTML, no style built from user content)
- Test: `apps/web/test/studio-style-page.test.mjs`, `apps/web/test/route-css.test.mjs`, `tests/e2e/studio-styles.spec.ts`, `tests/e2e/studio-styles.visual.spec.ts`, `tests/e2e/studio-sticky-bar.spec.ts`, `tests/e2e-perf/lcp.spec.ts`

**Interfaces:**

- Consumes: `StudioDocument`, `studioTokens`, `STUDIO_STYLES`, `checkDesign` (for the lab's notices), `visibleLinks` (`social-links.ts`).
- Produces:
  ```tsx
  export function StudioStylePage(props: {
    studio: PublicStudio;
    profile: PublicProfile;
    tipBlock: ReactNode;
    footer: ReactNode;
    coverArt: ReactNode;
  }): JSX.Element;
  // root: <div class="studio" data-style={id} data-mode={mode}> with --studio-* tokens (light; dark under [data-mode=dark]; auto under @media (prefers-color-scheme: dark))
  export type TipSkin = Exclude<StudioStyleId, 'classic'>;
  // AppreciationForm gains `skin?: TipSkin`: sets data-skin, the fourth chip reads "Custom", and turns on the bar observer; no skin = today's behaviour exactly
  export interface PublicStudio {
    document: StudioDocument;
    images: Record<string, { path: string; width: number; height: number }>;
    palette: { light: StudioTokenMap; dark: StudioTokenMap };
    checkVersion: 3;
  }
  ```
  `PublicStudio` (v2) is added to `packages/contracts/src/studio-document.ts` here; the API sends it from Task 10.
- Lab handles one document per style: `LAB_STYLE_EXAMPLES: Record<StudioStyleId, StudioDocument>` (default accent, natural mode, Your cover = a generated photo, one text, one quote, three photos, links on).

- [ ] **Step 1: Write the failing unit tests** in `studio-style-page.test.mjs` (render with `react-dom/server`): `the root carries data-style, data-mode and only --studio-* tokens`; `auto emits the dark tokens only inside prefers-color-scheme`; `the skeleton is cover, identity, Tip, links, blocks, footer, in that order`; `links render once with the title "Find me elsewhere", and not at all without links`; `a page emits @font-face only for Inter and its own face, and preloads only the name face`; `a name the face can't draw is set wholly in Inter` (one font-family on the whole name element, class `studio-name--fallback`). In `route-css.test.mjs`: `a standard or Classic profile page downloads at most 8 KB gzip of Studio CSS` and `a styled profile page downloads at most 12 KB gzip of Studio CSS` (per style: what a page of that style downloads, by the method chosen in Step 3; the test fails if a style is missing).
- [ ] **Step 2: Write the failing browser tests.** `studio-styles.spec.ts`, parameterised over the styles present in `LAB_STYLE_EXAMPLES` (only `clear` in this PR): `<style> renders cleanly at 320, 390, 768, 1024 and 1440, light and dark` (reuse `geometryProblems`, `contrastProblems`, `expectAccessible`, `fitsViewport`); `<style> sets long names in one face without overflow at 320 and 390` (the three names from §9.10); `<style> keeps the tip form's behaviour` (same preset amounts and minimum as the standard page, "Custom" reveals the Other-amount field, a below-minimum amount shows today's error, the fee line text equals the standard page's). `studio-sticky-bar.spec.ts`: `the bar is hidden while the in-page Tip is on screen and shown after it scrolls away @mobile`; `with JavaScript disabled the bar is always shown @mobile`; `the bar never covers the last block @mobile`; `no sticky bar at 1024 and wider`. `studio-styles.visual.spec.ts`: `Clear at 390 light`, `Clear at 1440 light`. LCP: `lab LCP sample: Studio styles` over `/dev/studio-lab?style=<id>` for each lab style, 3 samples each, `< 2000`.
- [ ] **Step 3: Pick and implement the CSS delivery.** Builder's call (§16) within the budget rule in Global Constraints; record it in `style-page.tsx`'s header comment. Frame CSS holds the shared skeleton, `.studio[data-style] …` tokens and reduced-motion rules; `clear.css` holds §9.2 exactly (segmented control: 44 px track, 4 px padding, 2 px gaps, 36 px segments, thumb shadow; Tip 52/56 pill; photo cover 220/380 fading over its lower 60%; avatar 104/128 with 4/5 px `bg` ring; grouped links list rows 56; strip of 150×200 r12; desktop 920 with a 440 Tip column and a 2-column block grid gap 40; sticky bar `bar` + `saturate(1.8) blur(20px)`, padding 10/16/34; motion 240 ms fade-up 8 px, 40 ms stagger; thumb 220 ms `cubic-bezier(.2,.8,.2,1)`; reduced: jumps, fades only).
- [ ] **Step 4: Implement `StudioStylePage`, parts, fonts, the `skin` prop and the bar observer.** The observer watches the in-page Tip button and toggles `data-bar="hidden"|"shown"` on the form; the server renders the bar shown (no-JS); bottom padding `max(12px, env(safe-area-inset-bottom))` + 34 px; the page gets matching bottom padding.
- [ ] **Step 5: Run unit, budget and browser tests.** Web tests; budgets on a build; each new spec with `E2E_LANE=4 … --repeat-each=5 --retries=0`; `a profile without studio renders exactly today’s page` and `profile.visual.spec.ts` must still pass unchanged; `E2E_LANE=4 pnpm perf:lab -g "Studio styles"`; `a Studio page ships at most 3 KB more script than the standard page` and `node --test scripts/web-bundle.test.mjs` (raise budgets by the measured bytes only, write before/after in the PR).
- [ ] **Step 6: Visual baselines from CI.** Push; download the CI job's Linux actuals for the two Clear images; commit them as baselines. Darwin copies may be generated locally.
- [ ] **Step 7: Screenshots, commit and open PR 2a.** Capture the lab Clear page at 390 and 1440 (light; plus dark at 390), push to `pr-assets/pr-<n>/`, link them. `feat(web): Studio style frame, tip skin, sticky Tip bar and Clear`.

---

### Task 6: Classic choices (PR 2b)

**Files:**

- Create: `apps/web/src/components/studio-styles/classic.tsx` (`ClassicStudio`), `classic.css`
- Modify: `apps/web/src/components/studio-styles/style-page.tsx` (export a `renderStyled` dispatcher: Classic → `ClassicStudio`, else frame), the lab (`?style=classic`), `apps/web/src/app/people/[handle]/page.tsx` only to extract today's markup into a reusable `StandardProfile` component with **no output change**
- Test: `apps/web/test/studio-classic.test.mjs`, `tests/e2e/studio-styles.spec.ts` (+ `classic`), `tests/e2e/studio-styles.visual.spec.ts` (+ `Classic at 390 dark with an accent and blocks`)

**Interfaces:**

- Consumes: `StandardProfile` (extracted), `studioTokens('classic', …)`, `CLASSIC_PURPLE`.
- Produces: `ClassicStudio(props: { studio: PublicStudio; profile: PublicProfile; …same as StudioStylePage })` rendering `StandardProfile` with `data-mode`, Classic token overrides on `.profile-page--studio[data-style=classic]`, and a blocks section after links and bio.

- [ ] **Step 1: Write the failing tests.** Unit: `StandardProfile renders today's markup byte for byte` (render the extracted component and the old inline markup for the same fixture; strings equal); `an accent replaces the purple only on the selected key, links, focus and the wordmark` (the four token names; the Tip key stays `#000` light, `#f3f2ee` dark); `the key edge is the accent fill about 10% darker in OKLCH`; `dark Classic has no shadows or gloss`; `gradient is a two-stop accent gradient in today's cover shape; plain has no cover band`. E2E: classic joins the parameterised specs (all widths, both modes, long names, tip form behaviour with "Other amount"); visual `Classic at 390 dark with an accent and blocks`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Extract `StandardProfile`** from `page.tsx` without changing output; run `a profile without studio renders exactly today’s page` and `profile.visual.spec.ts` (`E2E_LANE=4`). Expected: pass, no snapshot change. Commit `refactor(web): the standard profile as one component`.
- [ ] **Step 4: Implement `ClassicStudio`** per §9.1: dark palette verbatim (border `rgba(255,255,255,.14)`, hair `.10`, rule `.12`, ink2 `#c8aeff`), block treatment (DM Serif Display 32/1.05 titles, Manrope 16/1.6 `fg2` max 34em, raised panels radius 26 with `shInst` in light, chip links, photos radius 14), money in Inter, no new font. Keep `classic.css` inside the 8 KB standard budget (it is linked on every profile page).
- [ ] **Step 5: Run unit, budgets and e2e** (as Task 5 Step 5). The 8 KB test must pass with Classic's CSS included.
- [ ] **Step 6: CI baselines, screenshots (Classic light default vs. Classic dark + accent + blocks at 390 and 1440), commit, open PR 2b.** `feat(web): Classic takes accent, dark/auto, cover type and blocks`.

---

### Task 7: Journal and Linen (PR 2c)

**Files:**

- Create: `apps/web/src/components/studio-styles/journal.css`, `linen.css` (and per-style part overrides in `parts.tsx` only where markup differs: Journal's top row, Linen's framed cover and "Send a tip" card)
- Modify: lab `LAB_STYLE_EXAMPLES` (+ journal, linen), `route-css.test.mjs` style list
- Test: the parameterised specs pick them up; `studio-styles.visual.spec.ts` (+4 images); LCP list

**Interfaces:** Consumes Task 5's frame and parts; produces nothing new.

- [ ] **Step 1: Write the failing tests.** Add `journal`, `linen` to the lab map (the parameterised specs then fail on missing CSS) and these specific tests in `studio-styles.spec.ts`: `Journal sets a Hausa name wholly in Inter 700 and the rest of the page in Source Serif 4` (computed `font-family` of the name element is Inter; of the bio is Source Serif 4; one face for the whole name); `Journal on desktop puts the first block in the left column`; `Linen frames a photo cover with a mat and no caption`; `chipOn follows the accent` (Journal with Rose: selected chip background equals the Task 2 OKLab mix within 1 unit per channel).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** §9.3 and §9.8 verbatim (type sizes, radii Journal 6/4 and Linen 20/14, covers including the "my call" photo and gradient treatments, hairline index and bordered two-up links, sticky bars, motion and reduced motion). Linen's family name in CSS is "Linen Serif" (R2).
- [ ] **Step 4: Run unit, budgets, e2e, LCP** (Task 5 Step 5 list).
- [ ] **Step 5: CI baselines** (`Journal`/`Linen` at 390 light and 1440 light), **screenshots, commit, PR 2c.** `feat(web): Journal and Linen styles`.

---

### Task 8: Stage and Horizon (PR 2d)

**Files:**

- Create: `apps/web/src/components/studio-styles/stage.css`, `horizon.css`; part overrides for the over-photo identity and Horizon's two cover buttons
- Modify: lab map, budget list, `parts.tsx` (`StyleCover` photo crop: `object-fit: cover`, `object-position` from the stored focal point or `50% 33%`; `fetchpriority="high"`; `srcset`/`sizes` never above the source width)
- Test: parameterised specs; visual (+ `Stage at 390 dark`, 5 images total); LCP list

**Interfaces:** Consumes the frame; `StyleCover` gains `{ tall: number; desktopTall: number }` from the style.

- [ ] **Step 1: Write the failing tests:** `text over a photo sits on its scrim, white only` (Stage and Horizon: the name's background stack includes the scrim gradient; computed colour `rgb(255, 255, 255)`; a white generated photo still gives ≥ 4.5:1 for 15 px meta text using the scrim's alpha at that height); `Stage and Horizon fall back to their gradient treatment when the cover is not a photo` (design, automatic and animated covers); `Horizon's "Send a tip" scrolls to and focuses the Tip area; "See links" scrolls to the links and is absent without links`; `a small cover photo is never upscaled` (a 640×360 generated cover: the chosen `currentSrc` width ≤ 640 at 1440); `the Stage glow appears only in dark mode`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** §9.4 and §9.9 verbatim (Stage scrim `linear-gradient(to top, scrimEnd 0%, rgba(8,8,10,.8) 12%, rgba(8,8,10,.66) 38%, rgba(8,8,10,.3) 68%, transparent)` over the lower 75%; glow 260 px `radial-gradient(50% 50% at 50% 30%, acc 28%, transparent)` blur 10 px; Horizon scrim `rgba(0,0,0,.7) 0%, rgba(0,0,0,.62) 45%, rgba(0,0,0,.3) 72%, transparent` over the lower 70%; glass `linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.03)), rgba(10,10,12,.32)` with `blur(20px) saturate(1.5)` and a white focus ring; Horizon Inter 400/500 only; transition 330 ms `cubic-bezier(.5,0,0,.75)`).
- [ ] **Step 4: Run unit, budgets, e2e, LCP.** The full-bleed photo is the LCP element; each sample `< 2000`.
- [ ] **Step 5: CI baselines, screenshots, commit, PR 2d.** `feat(web): Stage and Horizon styles`.

---

### Task 9: Signboard, Sprint and Tiles (PR 2e)

**Files:**

- Create: `apps/web/src/components/studio-styles/signboard.css`, `sprint.css`, `tiles.css`; part overrides (Signboard band, Sprint split, Tiles' Tip tile)
- Modify: lab map, budget list
- Test: parameterised specs; visual (+6 images; 18 in all after this PR); LCP list

**Interfaces:** Consumes the frame and `skin`; Tiles' Tip tile passes `skin="tiles"` so the in-tile Tip is inverted while the sticky bar's Tip is normal `acc`.

- [ ] **Step 1: Write the failing tests:** `Sprint steps a three-line name from 64 to 52 px with line height 1.2` (name `Olúwadámilọ́lá Ọ̀ṣúnfúnmiláyọ̀-Adébáyọ̀` at 390); `Signboard steps names over 18 letters from 30 to 24 px and balances two lines; the avatar keeps its overlap` (`Chukwuemeka Ọ̀kọ̀nkwọ́-Adéyẹmí`); `every other style steps a name down about 80% before a third line, with no mid-word break` (320 and 390); `Signboard and Sprint offer no gradient`; `the Tip tile is first and two wide in Tiles, with "Send a tip" and "Goes to {first name}"`; `Signboard's Tip has the one hard shadow 3px 3px 0`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** §9.5, §9.6, §9.7 verbatim (Signboard band padding 72/20/76 phone, 96/104 desktop, 2 px ink rule, `steps(2)` chips, 120 ms; Sprint radius 0 except pills, numbered index, 720/720 split 800 tall on desktop, 200 ms `cubic-bezier(.4,0,.2,1)`; Tiles 2-column phone grid gap 12, desktop 340 rail + 4 columns gap 16 tile height 172, light tile shadow `0 1px 2px rgba(20,20,30,.05), 0 6px 16px rgba(20,20,30,.05)`, 250 ms `cubic-bezier(.2,.9,.3,1.2)`).
- [ ] **Step 4: Run unit, budgets, e2e, LCP.**
- [ ] **Step 5: CI baselines, screenshots, commit, PR 2e.** `feat(web): Signboard, Sprint and Tiles styles`.

---

### Task 10: Server cutover — gating, v2 publish and the public page (PR 3a)

**Files:**

- Create: `packages/contracts/src/studio-gate.ts`
- Modify: `packages/contracts/src/studio-api.ts` (`studioDraftSchema` accepts `draft: StudioDocumentV1 | StudioDocument`; `MyStudio` gains `plan`), `packages/database/src/operations/studio.ts` (`saveStudioDraft`, `publishStudio`, `publicStudioFor`, `discardStudioDraft`, `myStudioOf`, `contextFor`), `apps/api/src/studio/studio.controller.ts`, `apps/web/src/lib/public-studio.ts` (`studioFor` v2 only; `identityFor` removed), `apps/web/src/app/people/[handle]/page.tsx` (render `ClassicStudio`/`StudioStylePage` via the Task 6 dispatcher; old `StudioPage` no longer imported here), `tests/e2e/profile-fixtures.ts` (v2 published fixtures: `/@style<id>` for the nine styles plus Kemi/Sule/Ify converted), `tests/e2e-perf/lcp.spec.ts` (R6), OpenAPI and docs outputs
- Test: `packages/contracts/test/studio-gate.test.mjs`, `tests/integration/studio-api.test.mjs`, `apps/web/test/public-studio.test.mjs`, `tests/e2e/studio-page.spec.ts`

**Interfaces:**

- Consumes: v2 document, `checkDesign` v3, `proItemsOf`, `migrateStudioV1`, `studioTokens`.
- Produces:

  ```ts
  export function studioShown(
    doc: StudioDocument,
    plan: 'free' | 'pro',
  ): StudioDocument | null;
  // pro → doc (null if isClassicDefault); free + Pro style → Classic with their accent (photo → null), mode, cover (if Classic offers it), text and quote blocks in order; free + free style → photo accent → null, Pro blocks removed; null when the result isClassicDefault
  export function studioDraftRefusal(
    next: StudioDocument,
    held: { draft: StudioDocument | null; published: StudioDocument | null },
    plan: 'free' | 'pro',
  ): 'STUDIO_PRO_REQUIRED' | null;
  // free: refuses only a Pro style, the photo accent, or a Pro block (by id + equal content) that neither held version has
  // MyStudioV1 (still what the old editor reads) gains plan: 'free'|'pro'; published becomes StudioDocument | null.
  // draft stays StudioDocumentV1 for a v1 draft; a v2 draft (only saved by direct API calls before Task 12) comes back as v2
  // with a v3 check, so draft is typed StudioDocumentV1 | StudioDocument and the old editor offers "Reload" when it sees v: 2.
  ```

- [ ] **Step 1: Write the failing contracts tests** in `studio-gate.test.mjs`: `a Pro page shows its design; Classic defaults show the standard page`; `a lapsed Pro style shows Classic with their accent, mode, cover and text and quote blocks` (photo accent → `null`; Signboard's `plain` stays `plain`; gallery dropped); `a lapsed free style keeps its style and drops the photo accent and Pro blocks`; `Classic with every choice back at its default is the standard page` (Review Focus 4); `a Free save may keep or restore Pro items held by the stored draft or published version, and nothing else` (Review Focus 1: reorder, edit text in a held gallery, remove → allowed; add a new gallery id, switch to Stage, switch to `photo` → refused; re-add a gallery present only in published → allowed; re-add one present in neither → refused).
- [ ] **Step 2: Write the failing integration tests** (`tests/integration/studio-api.test.mjs`, §14.6): `Free publishes Clear`; `Free can't publish Stage (422 pro-only)`; `Free can't add a gallery block or switch to a Pro style (403)`; `a lapsed Free draft that holds a Pro style and Pro blocks can still be reordered, have its text edited, and be discarded`; `Free can't upload a photo or change a focus (403)`; `a lapsed Pro style shows Classic`; `a lapsed free style keeps its style and drops the photo accent and Pro blocks`; `resumed Pro shows the design again`; `a plan change during publish cannot put a Pro style live` (Review Focus 2: set `plan='free'` from a second connection between the check and the UPDATE using the existing lock-order helper; expect 422 and `published` unchanged); `a v1 draft still saves for Pro and publishes as v2` (`published.v === 2`, `published_check_version = 3`); `a v1 draft save on Free is refused as today`; keep `every Studio route is 404 while the page_studio switch is off…` passing.
- [ ] **Step 3: Write the failing web tests.** `public-studio.test.mjs`: `a v1 studio from an older API shows the standard page`; `studioFor returns null for a campaign link, for no studio, and for whatever studioShown hides`. `studio-page.spec.ts`: rewrite the Studio-page tests for v2 fixtures; add `each style shows links once, in its place, and none without links` and `Your cover renders each Settings cover kind` (§14.8); keep `a profile without studio renders exactly today’s page`, the script-delta, font-count and CLS tests; retarget the weight test to the v3 estimate.
- [ ] **Step 4: Run to see them fail.** Contracts tests, `pnpm test:integration`, web tests, `E2E_LANE=4 … studio-page.spec.ts`.
- [ ] **Step 5: Implement.** `studio-gate.ts`; in ops: `saveStudioDraft` takes v1 (Pro only, `lockProPage`) or v2 (lock the page, read `plan`, `studioDraftRefusal` against the stored draft and published, then save); `publishStudio` locks, resolves to v2, runs `checkDesign` with the real `plan`, `coverKind`, `hasAvatar`, stores v2 with `DESIGN_CHECK_VERSION`, and when `proItemsOf(draft)` is non-empty adds `eq(profiles.plan, 'pro')` to the UPDATE (zero rows → 422 `STUDIO_DESIGN_CHECK_FAILED` with the `pro-only` issue); image upload and focus ops require Pro (403 `STUDIO_PRO_REQUIRED`); `publicStudioFor` resolves, applies `studioShown(doc, plan)`, checks with today's facts, serves `PublicStudio` v2 with `palette = studioTokens(...)` and only shown images. `MyStudio.plan` added; `access` unchanged (R1). Web: `studioFor` → `PublicStudio | null` (requires `document.v === 2`), page renders the dispatcher with `StandardProfile`'s tip block and footer.
- [ ] **Step 6: Regenerate OpenAPI and docs.** `pnpm --filter @tipme/api build && pnpm api:openapi && pnpm docs:generate`; both `--check` pass.
- [ ] **Step 7: Run everything.** Contracts, integration, web, budgets on a build (now measuring the real `/@username` route), `E2E_LANE=4` for `studio-page.spec.ts`, `studio-editor.spec.ts`, `studio-blocks.spec.ts` (old editor still works on v1), `profile.visual.spec.ts`, and `E2E_LANE=4 pnpm perf:lab -g "Studio"` (the new fixture handles, every sample `< 2000`; `/@tobi` unchanged against the last dev run).
- [ ] **Step 8: Screenshots** of three fixture profiles (`/@styleclear`, `/@stylestage` dark, `/@styleclassic` with accent) at 390 and 1440; **commit and open PR 3a.** `feat(studio): Free and Pro styles on the server; the public page renders styles`.

---

### Task 11: "From your photo" (PR 3b)

**Files:**

- Create: `packages/contracts/src/studio-photo-accent.ts`, `apps/api/src/studio/photo-accent.ts` (sampling), migration via `pnpm --filter @tipme/database generate` (adds `page_studios.photo_accent jsonb NULL`)
- Modify: `packages/database/src/schema.ts`, `packages/database/src/operations/studio.ts` (`setPhotoAccent`, read it into `MyStudio.photoAccent` and `studioTokens`), `apps/api/src/profiles/avatar.controller.ts` (after `setAvatar`/`removeAvatar`), `apps/api/src/studio/studio.controller.ts` (compute when a v2 save first picks `accent: 'photo'`), OpenAPI and docs outputs
- Test: `packages/contracts/test/studio-photo-accent.test.mjs`, `tests/integration/studio-api.test.mjs`, `apps/api/test/photo-accent.test.mjs`

**Interfaces:**

- Produces:

  ```ts
  export type PhotoAccent =
    | {
        source: 'avatar';
        avatarVersion: number;
        light: StudioAccentValues;
        dark: StudioAccentValues;
      }
    | { failed: true; fallback: StudioCuratedAccentId };
  export function pickPhotoAccent(
    candidates: readonly Hex[],
  ):
    | { light: StudioAccentValues; dark: StudioAccentValues }
    | { failed: true; fallback: StudioCuratedAccentId };
  export function sampleAvatarColours(webp: Buffer): Promise<Hex[]>; // apps/api, sharp: 128 px rendition, up to 5 dominant colours, deterministic
  // MyStudio gains photoAccent: { light; dark } | { failed: true; fallback } | null
  ```

- [ ] **Step 1: Write the failing contracts tests:** `near-greys and low-chroma skin oranges are dropped` (OKLCH chroma < 0.04 never chosen); `fills are clamped to L .45–.55 light and .75–.82 dark with chroma at most .16, keeping hue`; `the text value reaches 4.5:1 on every style's page and card in that mode, Classic's included; the ring reaches 3:1`; `with no passing candidate it falls back to the nearest curated accent by OKLab`; `the same colours always give the same result`; property `for any input colours it returns a passing pair or the fallback` (fast-check, existing seed helper; checks with `studioContrastPairs` for all nine styles).
- [ ] **Step 2: Write the failing API and integration tests:** `sampling is deterministic for the same image` (generated test image twice → equal arrays); `choosing "From your photo" on Pro stores a photo accent for the current avatar`; `a new or removed avatar recomputes or clears the photo accent and revalidates the page` (Review Focus 3: new avatar → `avatarVersion` changes and tokens change; removed → public tokens equal the style's default accent; `profile.changed` emitted); `Free can't choose the photo accent (403)`; `a failed photo accent publishes with its fallback and the editor gets the sentence` (`Your photo's colours didn't pass our contrast check, so your page uses {Name}.`).
- [ ] **Step 3: Run to see them fail.**
- [ ] **Step 4: Implement** the algorithm (§6 steps 1–6), sampling with sharp (resize 128, quantise; method is the builder's call, deterministic), the column via drizzle-kit, the writes (server only), recompute hooks, and public tokens (`accentValues(..., photo)`).
- [ ] **Step 5: Regenerate OpenAPI and docs; run contracts, API, integration, web tests, `E2E_LANE=4 … studio-page.spec.ts`.**
- [ ] **Step 6: Screenshots** (a fixture page with a generated avatar's photo accent, light and dark, 390 and 1440); **commit and open PR 3b.** `feat(studio): "From your photo" accent`.

---

### Task 12: Editor on v2 — Style tab and Blocks tab (PR 4a)

**Files:**

- Create: `apps/web/src/app/dashboard/studio/style-cards.tsx`, `accent-swatches.tsx`, `segmented.tsx` (Appearance and Cover), `style-tab-model.ts`
- Modify: `use-studio-draft.ts`, `studio-editor.tsx` (header, tabs Style/Blocks/Check with badge, desktop Phone/Desktop switch), `style-tab.tsx` (rebuilt, §10), `studio-preview.tsx` (renders the Task 6 dispatcher; loads only the chosen style's faces), `blocks-tab.tsx`, `blocks-model.ts`, `block-forms.tsx` (one ordered list; locked rows; no columns, spacing, background, variant; no Links in "Add a block"; PRO badges for Free), `studio-editor-model.ts`, `studio-editor.css`; contracts `studio-api.ts` (canonical `MyStudio` replaces `MyStudioV1`: `draft`/`published` v2, v3 `check` and `StudioCheckContext`, `access: 'edit'` always, `plan`, `photoAccent`; `studioDraftSchema` v2 only), `packages/database/src/operations/studio.ts` (refuse v1 writes as `STUDIO_DRAFT_INVALID`; `getMyStudio` returns `resolveStudio(...)`), OpenAPI and docs outputs
- Test: `apps/web/test/studio-editor.test.mjs`, `apps/web/test/studio-blocks.test.mjs`, `tests/e2e/studio-editor.spec.ts`, `tests/e2e/studio-blocks.spec.ts`, `tests/integration/studio-api.test.mjs`

**Interfaces:**

- Consumes: `STUDIO_STYLES`, `STUDIO_ACCENTS`, `CLASSIC_PURPLE`, `checkDesign` v3, `MyStudio` v2.
- Produces (pure, `style-tab-model.ts`): `withStyle(doc, id): StudioDocument` (keeps explicit accent, mode, blocks; cover kept when offered, else `'yours'`); `withAccent(doc, id | null)`; `styleCardLabel(style, plan): string` (`"{Name}, {mood}. {Free|Pro}."` + `" The default."` for Classic); `styleSummary(doc, blockCount): string` (`"Clear · Blue · Auto · Your cover · 5 blocks"`, used by Task 14). `blocks-model.ts`: `addBlock`, `removeBlock`, `moveBlock(doc, id, 'up'|'down')`, `updateBlock` over `doc.blocks`.

- [ ] **Step 1: Write the failing unit tests:** `switching style keeps an explicit accent, the mode and the blocks`; `switching to a style without the current cover type selects Your cover` (Review Focus 5); `choosing TipMe purple stores no accent` (Review Focus 4); `card labels: "Clear, Quiet, bright, precise. Free." and Classic adds "The default."`; `the heading reads "4 of 9 free" on Free and "9 styles" on Pro`; `Free sees the photo swatch disabled with "“From your photo” comes with Pro."`; `the Blocks list has locked rows "Cover, name and bio", "Tip" and "Your links" (only with links), each "Always TipMe. Can't be moved or removed."`; `"Add a block" never offers Links and marks Pro kinds PRO on Free`; `moving a block announces the same aria-live words as G2`.
- [ ] **Step 2: Write the failing browser tests** (rewrite the two editor specs for v2): `a Pro person picks Stage, Rose and Dark, and the preview shows it`; `a Free person picks Journal and Green and it saves`; `Free sees PRO on five cards, the banner "PRO · Stage, Signboard, Sprint, Tiles and Horizon come with Pro.", and can't choose them yet` (R5); `the Cover control shows Your cover and Plain only for Signboard and Sprint, with "Change your cover in Settings." linking to the setting`; `Stage on a non-photo cover shows "Stage looks best with a cover photo. Add one in Settings."`; `blocks reorder by drag, buttons and arrow keys`; `axe is clean on the Style and Blocks tabs at 390 and 1440`; integration `a v1 draft is refused now that the editor speaks v2`.
- [ ] **Step 3: Run to see them fail.**
- [ ] **Step 4: Implement** §10 verbatim (sizes, copy, order Classic…Horizon, phone scroll row 104 wide gap 12, desktop 4-column grid gap 18/14, selected ring 2 px `bg` + 4 px `#7A32F9` with a 22 px check badge, swatches 33 px gap 7 with 3 px white + 5 px `#141210` ring, Appearance 44 tall in an r12 `#EEEDE8` track with "Auto follows each visitor’s phone setting.", motion and reduced motion). Cards render the person's name in each display face (editor-only `@font-face`, `font-display: swap`). Status line `role="status"`.
- [ ] **Step 5: Regenerate OpenAPI and docs. Run web, integration, `E2E_LANE=5` for both editor specs (burn-in), budgets on a build.**
- [ ] **Step 6: Screenshots** (Style tab Free and Pro at 390, desktop Pro at 1440; Blocks tab at 390 and 1440); **commit and open PR 4a.** `feat(web): Style tab and one-list Blocks tab for page styles`.

---

### Task 13: Retire v1 (PR 4b)

**Files:**

- Delete: `apps/web/src/components/studio/` (old renderer, `studio.css`, `studio-theme.ts`), `apps/web/src/app/dashboard/studio/colour-field.tsx`, `packages/contracts/src/studio-layout.ts`, the v1 check (`studio-check.ts` → replaced by renaming `studio-check-v3.ts` to `studio-check.ts`), v1 lab examples and specs (`tests/e2e/studio-lab.spec.ts`, `studio-examples.spec.ts`, `studio-examples.visual.spec.ts` and its snapshots), font files no style uses (`bricolage-grotesque-700`, `fraunces-600`, `manrope-700`, `nunito-400-700`, `outfit-600`, `space-grotesk-600`, `work-sans-400-600` and their OFL files and register entries) (R3)
- Keep: `studio-document-v1.ts` (schema and resolver only, for `resolveStudio`), `deriveStudioPalette` only if still imported (else delete with its tests)
- Modify: `STUDIO_LIMITS` (drop `rows`, `blocksPerCell`), `scripts/studio-fonts.mjs`, `scripts/studio-source.test.mjs` (point at `studio-styles/`), `scripts/studio-lab.test.mjs`, `apps/web/test/route-css.test.mjs`, `studio-probes.ts`, the v2 random render spec (move the property render test from `studio-lab.spec.ts` to `tests/e2e/studio-styles-random.spec.ts` over `studioDocumentArb`, 150 documents, axe on 20)
- Test: everything above

- [ ] **Step 1: Write the failing guard test** in `scripts/studio-source.test.mjs`: `nothing imports the v1 renderer, layout model or v1 check` (grep `components/studio/`, `studio-layout`, `checkDesignV1`, `applyStudioFixV1` across `apps` and `packages/*/src` → none). Run; expected FAIL.
- [ ] **Step 2: Delete and rename** as listed; move the random render property test to v2.
- [ ] **Step 3: Run the whole gate** (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`), budgets on a build (the standard page's Studio CSS must drop now that `studio.css` is gone; record the number), `E2E_LANE=6` for `studio-styles-random.spec.ts`, `studio-styles.spec.ts`, `studio-page.spec.ts`, and `node scripts/studio-fonts.mjs` (bytes of what remains).
- [ ] **Step 4: Commit and open PR 4b.** `chore(studio): retire the v1 renderer, layout model, check and unused fonts`; body lists deleted bytes and files.

---

### Task 14: Publish gate (PR 5a)

**Files:**

- Create: `apps/web/src/app/dashboard/studio/publish-dialog.tsx`
- Modify: `studio-editor.tsx`, `use-studio-draft.ts` (`publish(): Promise<'published' | { issues: StudioIssue[] }>`), `studio-editor-model.ts` (`publishLabel(issueCount)`), `studio-editor.css`
- Test: `apps/web/test/studio-editor.test.mjs`, `tests/e2e/studio-publish.spec.ts`

**Interfaces:** Consumes `POST /v1/me/studio/publish` (422 `STUDIO_DESIGN_CHECK_FAILED` with `issues`), `styleSummary` (Task 12), `fixesNow`/`fixesInput`.

- [ ] **Step 1: Write the failing tests:** unit `the button reads "Publish · 2 to fix" while issues remain and "Publish" when the check passes`; e2e `with issues, Publish is aria-disabled, stays focusable and opens "Your page can’t be published yet" with the fixes`; `a Free person with Stage sees the pro-only issue with "Choose a free style" and "See Pro"`; `after a 422 the dialog shows the server's issues, not the client's` (route the publish call to answer 422 with a different issue); `when the check passes, "Publish your page?" shows "Clear · Blue · Auto · Your cover · 5 blocks" and "Design check: N of N pass"; on success the status reads "Published" and the public page shows the style`; `there is no publish-anyway control` (no button whose name matches /anyway/i); axe on both dialogs.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** §12.1 (dialog titles and copy verbatim; focus returns to Publish on close; server issues replace client issues until the next edit).
- [ ] **Step 4: Run web tests and `E2E_LANE=7 … studio-publish.spec.ts` (burn-in).**
- [ ] **Step 5: Screenshots** (both dialogs at 390 and 1440); **commit and open PR 5a.** `feat(web): Studio publish gate`.

---

### Task 15: Undo and discard (PR 5b)

**Files:**

- Create: `apps/web/src/app/dashboard/studio/undo-stack.ts`
- Modify: `use-studio-draft.ts` (`undo()`, `canUndo`, `undoLabel`, `discard()`), `studio-editor.tsx` (Undo button, Ctrl/Cmd+Z outside text fields, "Discard changes" with its dialog), `studio-editor.css`
- Test: `apps/web/test/studio-undo.test.mjs`, `tests/e2e/studio-undo.spec.ts`

**Interfaces:**

- Produces: `createUndoStack(cap = 50)` with `push(prev: StudioDocument, label: string)`, `pop(): { doc: StudioDocument; label: string } | null`, `clear()`; labels like `"style changed to Clear"`, `"accent changed to Rose"`, `"block moved"`, `"block removed"`, `"heading edited"`. Field edits coalesce: one step per field per 800 ms pause (the save debounce).

- [ ] **Step 1: Write the failing tests:** unit `each change is one step and field edits coalesce per pause`; `the stack holds at most 50 steps`; `the undo label says what it undoes`. E2E `Undo restores the previous style and saves it` (button name `Undo: style changed to Clear`); `Ctrl+Z undoes outside a text field and types normally inside one`; `Discard asks once, "Discard your changes? Your page stays as it is now.", with "Discard changes" and "Keep editing"; afterwards the draft equals the published page and undo is empty`; `discarding a never-published page leaves Classic with no blocks`; `undo of a saved-away Pro block on Free stays undone and says why` (R4 / Review Focus 1: a lapsed fixture whose draft held a gallery not in published; remove, wait for save, undo → 403 handled, the gallery stays removed, text `Adding this back needs Pro. Everything else is kept.`); `a lapsed draft can still be reordered, edited and undone` (§14.6 editor half).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** §12.2–12.3 (stack in memory, cleared on reload and on discard; undo saves like any change; discard calls `DELETE /v1/me/studio/draft`).
- [ ] **Step 4: Run web tests and `E2E_LANE=7 … studio-undo.spec.ts` (burn-in).**
- [ ] **Step 5: Screenshots** (Undo in the header; the discard dialog; 390 and 1440); **commit and open PR 5b.** `feat(web): Studio undo and discard`.

---

### Task 16: Free preview of Pro styles; the lapse banner (PR 5c)

**Files:**

- Modify: `style-cards.tsx` (Pro cards selectable for everyone), `use-studio-draft.ts` (`previewing: boolean`; autosave paused while the draft holds a Pro style the stored draft didn't), `studio-editor.tsx` (status line, "PRO" tag above the preview, lapse banner), `studio-editor-model.ts` (`lapseBanner(plan, published)`)
- Test: `apps/web/test/studio-editor.test.mjs`, `tests/e2e/studio-free-preview.spec.ts`

**Interfaces:** Consumes `studioShown` (to name what the public sees), `MyStudio.plan`.

- [ ] **Step 1: Write the failing tests:** unit `the lapse banner names what visitors see` — Pro style published → `Your Pro has ended. Your page shows Classic until Pro is back. Your design is kept.`; free style with extras → `Your Pro has ended. Your page shows Journal without Pro extras until Pro is back. Your design is kept.`; e2e `a Free person previews Stage: the preview shows it with a PRO tag, the status reads "Previewing a Pro style: not saved", and no save request is sent` (count `PUT /v1/me/studio/draft` requests); `choosing a free style resumes saving`; `publishing while previewing shows the pro-only issue`; `the photo swatch stays disabled on Free`; `a lapsed person sees the banner with "See Pro" and can edit within the Free rules`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** §12.4–12.5 (copy verbatim; "See Pro" links to the existing Pro page).
- [ ] **Step 4: Run web tests and `E2E_LANE=8 … studio-free-preview.spec.ts` (burn-in); then the whole Studio e2e set once in `E2E_LANE=8`.**
- [ ] **Step 5: Screenshots** (Free previewing Stage at 390 and 1440; the lapse banner); **commit and open PR 5c.** `feat(web): Free previews Pro styles; lapse banner`.

---

## Spec coverage map

| Spec                                                              | Task                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| §2.4 Classic exceptions (Inter money/fallback, `--text-tertiary`) | 1 (R7), 6                                                                                  |
| §4.1 glyphs, whole-name fallback                                  | 1, 4 (`name-fallback`), 5, 7, 9                                                            |
| §4.2 contrast, scrims                                             | 2, 8                                                                                       |
| §4.3 Classic byte-identical, LCP, CSS budgets, fonts, script      | 5, 6, 10, 13                                                                               |
| §4.4–4.5 a11y, reduced motion                                     | 5–9, 12, 14                                                                                |
| §5.1 registry; §7.3 accents and defaults                          | 2                                                                                          |
| §5.2 document v2; §7.1 migration                                  | 3                                                                                          |
| §5.3 `photo_accent`; §6 algorithm                                 | 11                                                                                         |
| §5.4 API (`plan`, `photoAccent`, `access`, `PublicStudio`)        | 10, 11, 12                                                                                 |
| §5.5 check v3                                                     | 4                                                                                          |
| §8 family laws, links, sticky bar, footer                         | 5, 7–9                                                                                     |
| §9.1–9.10 styles, long names                                      | 6, 5, 7, 8, 9                                                                              |
| §10 Style tab, Blocks tab                                         | 12                                                                                         |
| §11 Free/Pro on the server, `studioShown`                         | 10                                                                                         |
| §12.1 gate; 12.2 undo; 12.3 discard; 12.4 preview; 12.5 lapse     | 14; 15; 15; 16; 10 + 16                                                                    |
| §13 public render, Your cover, crops                              | 6, 8, 10                                                                                   |
| §14.1–14.10 evidence                                              | 2, 1, 5–9, 5–9, 5/10, 10, 3, 10, 5, 4                                                      |
| §15 canvas disagreements                                          | 2 (pass-2 defaults), 12 (copy), 5 (amounts, footer), 6 (Classic dark), 7 (chipOn, caption) |

## Risks

- **CSS delivery (Task 5).** The one hard engineering question: per-style CSS must not land on every profile page. If no method meets both budgets, stop and report measured numbers before writing more styles.
- **Font bytes.** Linen (3 Linen Serif files + Inter) is closest to 4 files / 200 KB; if it fails, drop the 700 file and set the "Send a tip" title in Inter 700 only after asking the coordinator.
- **Gentium renaming (R2)** needs coordinator agreement before PR 1a merges.
- **The 2d04ab4b branch** is unpublished; if it lands mid-plan, rebase Task 1's token step away.
