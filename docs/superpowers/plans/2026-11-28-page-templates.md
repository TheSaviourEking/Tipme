# Page Studio: page templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six personal page templates (Personal and lifestyle, Musician, Content creator, Consultant, Seller, Artist or designer): one-tap presets on the Pro styles Creator and Professional that set style, accent and mode, offer empty starter blocks, and let a person choose the Tip wording and each link row's words from fixed lists, never free text.

**Architecture:** A template is data in contracts (`studio-templates.ts`), and every word is in one import-free file (`template-copy.ts`). The Studio document v2 gains three optional fields (`template`, `tipLabel`, `linkLabels`) with no version bump; `resolveStudio` drops unknown values, and a render-time `templateView` applies labels only while the page shows the template's own style and the link still fits. The public page renders the chosen words server-side (tip skins, labelled rows, eleven inline glyphs); the editor gains a Templates section at the top of the Style tab, and setup's done screen links into it.

**Tech Stack:** TypeScript strict, Next.js 16 App Router (server components), Zod, `node --test`, fast-check (existing), Playwright with `@axe-core/playwright`. No new dependency, font, route, migration, analytics event or API route.

**Spec:** `docs/superpowers/specs/2026-11-28-page-templates-design.md` (owner-approved, merged as #357, 28 Nov 2026), "the spec"; "§n" below is its section. It builds on `docs/superpowers/specs/2026-11-27-studio-creator-professional-design.md` ("C/P §n") and its plan `docs/superpowers/plans/2026-11-27-studio-creator-professional.md` ("the C/P plan"), and on the styles spec `docs/superpowers/specs/2026-11-17-page-studio-styles-design.md`. Read all three specs.

**Starts after:** the C/P branch `feat/studio-creator-professional` (C/P plan PR A, Tasks 1–5, and PR B, Tasks 6–7) is **merged to `dev`**. Branch every PR of this plan from that merged `dev`. Nothing here starts earlier (spec header). The interfaces below come from that branch as built at `f55c0c63` (C/P Tasks 1–3: registry, `deepEdge`/`deepBarEdge` tokens, `splitLinksByPlace`, `linkRowWords`, `StyleIconRow`, `StyleLinkRows`, `PoweredBy`, `skinTipLabel`, `LINK_CASES` fixtures) and from the C/P plan's Produces blocks for Tasks 4–7 (Professional, `studio-style-copy.test.mjs`, `starter-layout.ts`), which were not built when this plan was written. Pre-flight (Task 0 Step 1) checks them on merged `dev`; a mismatch goes to the coordinator, not round the plan.

---

## What the code does (C/P branch at `f55c0c63`, plus the C/P plan for the parts still to build)

- **Contracts.** `studio-styles.ts`: eleven ids (`creator`, `professional` after `horizon`), `StudioCuratedAccentId` (`ink blue lagoon green violet rose coral amber`), `studioContrastPairs(style, accentValues, mode, tip?)`, `studioTokens` with Creator's `deep`, `deepEnd`, `deepLabel`, `deepEdge` (1 px Tip edge, ruling S-R2/S-R4, target 3.25 on curved ends) and `deepBarEdge` (sticky pill). `social-links.ts`: `place: 'icon' | 'row'` per site; optional `row` short form on Facebook, Instagram, WhatsApp channel, Twitch (ruling S-R3, the spec's §7.2 forms); `splitLinksByPlace(links)` (featured first row); `linkRowWords(platform)`; `linkKey(url)`; `detectPlatform(url)`; `visibleLinks`; `STORED_LINK_LIMIT` (11); `ADULT_PLATFORMS`. `studio-document.ts`: v2 `StudioDocument` (`v style accent mode cover blocks`), `documentSchema` is a `z.strictObject`, `resolveV2` rebuilds the object field by field, `isClassicDefault`. `studio-gate.ts`: `studioShown`, `studioKeepHeld(next, held, plan)`, `studioDraftRefusal` (used by `packages/database/src/operations/studio.ts` for `PUT …/draft`). `copy.ts` is import-free, exported as `@tipme/contracts/copy`, re-exported through the barrel, guarded by `apps/web/test/contracts-client-imports.test.mjs`.
- **Web, public.** `components/tip-skin-label.ts`: `skinTipLabel(skin, amountMinor)` → `{ name, lines? } | null`; Creator `lines = ['Support my work', 'Give, tip or appreciate']`, `name` = the visible words plus the amount (**ruling S-R5**: label-in-name, superseding the "…, tip ₦2,000" pattern); `PROFESSIONAL_WORDS = ['Send a', 'tip']`. `appreciation-form.tsx` (client) draws Creator's heart, `.tip-skin__line`, `.tip-skin__line--second` (13 px 500), the amount and a chevron. `studio-styles/parts.tsx`: `StyleIconRow`, `StyleLinkRows` (title `linkRowWords`, handle sub, sr-only " (opens in a new tab)", nav "Find me elsewhere"), `PoweredBy`. `style-page.tsx`: `StudioStylePage({ studio, profile, tipBlock, footer, coverArt, coverSize })`, `placed = splitLinksByPlace(profile.links ?? [])`. The tip block is built by `app/people/[handle]/page.tsx` and `app/studio-preview/preview-frame.tsx` (the editor's preview iframe) and `app/dev/studio-lab/page.tsx`, each passing `skin: style`.
- **Web, editor.** `dashboard/studio/`: `style-tab.tsx` (`StyleTab`), `style-cards.tsx` (`Miniature`, `data-mini` per style after C/P Task 6), `style-tab-model.ts` (`withStyle`, `withAccent`, `withMode`, `withCover`), `use-studio-draft.ts` (`change`, `update`, `previewing`, `undoLabel`, `notice`; after C/P Task 7 `startLayout()`, `starterHints`), `undo-stack.ts` (`describeChange(prev, next)` names style, accent, mode, cover, then blocks; `undoButtonName`), `studio-editor-model.ts` (`PREVIEWING = 'Previewing a Pro style: not saved'`), C/P Task 7's `starter-layout.ts` (`starterOffered`, `withStarter(doc, plan, newId)`, `STARTER_UNDO_LABEL = 'starter layout added'`). Links are edited in `dashboard/settings/sections/your-links.tsx`. Setup: `dashboard/welcome/welcome-view.tsx` (`Step = 'hello' | 'about' | 'bio' | 'live' | 'done'`).
- **Tests and probes.** `tests/e2e/profile-fixtures.ts` (stand-in API: `page()`, `studioPage()`, `STYLE_IDS`, `LINK_CASES`, `/@<style>links<case>`, `/@<style>nophoto`); `tests/e2e/studio-probes.ts` (`geometryProblems`, `contrastProblems`, `settled`, `layoutSnapshot`, `NEVER_TRUNCATED`); CLS observers in `studio-page.spec.ts` and `studio-styles.spec.ts`; **no INP or CPU-throttle helper exists yet**. `tests/e2e-perf/lcp.spec.ts` `lab LCP sample: Studio pages`. `apps/web/test/route-css.test.mjs` (8 KB / 12 KB), `scripts/web-bundle.test.mjs`, the 3 KB script-delta test in `studio-page.spec.ts`.

## Rulings on gaps in the spec (made by this plan; flag to the coordinator if any is wrong)

- **T1. Where the ids live.** `template-copy.ts` must have no imports yet the client tip form needs `TipLabelId`. So the id unions (`StudioTemplateId`, `TipLabelId`, `LinkLabelId`, `TemplateHintId`, `RowGlyphId`) are declared in `template-copy.ts`; `studio-templates.ts` imports them as types. The pill arithmetic (§8.1) is in `template-copy.ts` too, because the client recomputes it as the amount changes.
- **T2. "Imported by the editor and the API only" (§13)** means client bundles. Server components on the public page may import `studio-templates.ts` through the barrel (it ships no client script); client components (`appreciation-form.tsx`) import only `@tipme/contracts/template-copy`. The existing client-imports test enforces it.
- **T3. Links at render.** `resolveStudio(raw, today)` never sees links, so it drops only unknown ids and out-of-list labels. Fit to the live links (missing, hidden, wrong site) is a separate pure function, `templateView(doc, links)`, called on the document the page shows (after `studioShown`), so a lapsed page (shown as Classic) gets null.
- **T4. Free changes (§7.5, §14.4) read literally:** on Free, `template` and `tipLabel` must equal the stored draft's or the published version's, and `linkLabels` must be a subset of one of theirs; anything else is 403 `STUDIO_PRO_REQUIRED`. The subset rule lets a lapsed save drop entries; the editor drops stale entries (§8.2) only on Pro. Ending a Free preview (choosing a free style) also takes the template fields back to the held draft's, so that save is accepted (Review Focus 1).
- **T5. Hints.** The spec names three hints and leaves `creative` to the builder. This plan fixes all hints, on starter headings only (as C/P ruling P5): `moments` "e.g. Moments I love"; `my-music` "e.g. My music"; `upcoming-shows` "e.g. Upcoming shows"; `my-work` "e.g. My work"; `about-me` "e.g. About me"; `what-i-offer` "e.g. What I offer"; `new-in` "e.g. New in"; `about-brand` "e.g. About our brand"; `my-portfolio` "e.g. My portfolio" (creative: builder may change within §7.3's rules and the copy grep, naming it in the PR).
- **T6. Picker descriptions (§10.1, ≤ 48 characters),** which the spec does not word: personal "Your moments, links and a warm thank-you"; musician "Your music, shows and where to stream"; creator "Your videos, socials and a big Tip button"; consultant "Your services, a call link and kind words"; seller "Your brand, products and store links"; creative "Your portfolio, services and prints".
- **T7. Tip label ids:** `appreciate-me`, `support-my-work`, `send-some-love`, `say-thank-you`, `tip-the-artist`, `support-my-music`, `show-some-love`, `support-my-content`, `fuel-my-next-video`, `send-a-tip`, `appreciate-my-work`, `support-our-brand`, `support-my-art` (texts = the §7.2 table words).
- **T8. Accessible names.** Creator's Tip keeps S-R5: name = visible text ("{line} Give, tip or appreciate ₦2,000"), not §8.1's "{line}, tip ₦2,000". Professional label-only: "{line}, ₦2,000" (§8.1; visible text first, so label-in-name holds). A **labelled** row is named "{label}, {Site}{: handle}, opens in a new tab" (§8.2); an unlabelled row keeps the built C/P name, so no C/P test or snapshot moves.
- **T9. "Changed" vs "removed" (§8.2).** A stored entry whose `link` key matches no link is stale. If the page still has a link on the same site (`detectPlatform(link)`) with no label, the editor shows "Your link to {Site} changed. Choose its label again."; otherwise the entry is dropped silently. Either way the next Pro save drops it.
- **T10. "New empty page" (§10.2)** = the draft `isClassicDefault` and nothing published. Anything else gets the confirm. After applying or declining, the editor removes `?template=` with `history.replaceState`, so a reload never re-applies or re-asks.
- **T11. Undo labels:** `template applied`, `template removed`, `tip wording changed`, `link words changed` (button "Undo: …"). `describeChange` checks `template` before `style`.
- **T12. Pill constants.** §7.3/§8.1's 190/186 px come from the boards; C/P Task 4 builds the real pill. Task 4 Step 1 reads the built `professional.css` and sets `PILL_TEXT_MAX` (pill text width less 4); the measurement test is the arbiter (§7.3 builder's call). Creator line 1's font is read from the built page's computed style, not assumed.
- **T13. PR slicing.** PR 1 = Tasks 1–2 (contracts, schema, gate; no visible change). PR 2 = Tasks 3–6 (public render). PR 3 = Tasks 7–9 (editor and setup). Task 0 (boards) runs alongside Task 1 and must be approved before PR 2 is pushed.
- **T14. Each template's rows.** The spec fixes the label list but not which labels each template offers or suggests. Task 1 fixes them from the boards and the §7.2 groupings; an approved board that shows a different row wins, and the owner may edit the lists (§17), within the caps and banned words.

## Global Constraints

Every task includes these. Values are the spec's, verbatim.

- **Spec precedence:** the styles spec and the C/P spec apply unless §15 names the change. A board wins on any look once the owner approves it; the PR names each difference.
- **Visual reference (owner rule, 28 Nov):** the canvas "Studio Page Styles", https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q (rows "New Pro styles" and "Templates · draft"), read with the Artifact tool (`action: "read"`). Anything new (the Artist or designer board, the eleven row glyphs) is drawn **there** and passes the same four design tests on the board **before** the PR that builds it. Never publish a new artifact.
- **The owner's four design tests (28 Nov), concrete; every UI task's tests run them on what it changes:**
  1. **Contrast:** every text and non-text pair drawn is in the contrast proof (`studioContrastPairs`): text 4.5:1, large text 3:1, UI 3:1, light and dark. Templates add no pair; the glyph disc reuses the badge pair `fg` on `el2`; a unit test proves each template's style × accent × mode.
  2. **Visibility:** targets ≥ 44×44 (template cards ≥ 104 wide); `geometryProblems` empty (nothing clipped or overlapping) at 320, 390 and 430; English link labels on one line; under `forced-colors: active` the Tip, rows, chips, glyph discs and the selected template card stay visible by border or outline; at 200% zoom (1280 px viewport at 640 CSS px) no horizontal scroll and no lost content.
  3. **Smoothness** (`docs/design/EXPERIENCE-AND-MOTION.md` §9–10), Playwright with CPU throttling 4×: CLS < 0.1 and 0 on the Tip action; INP < 200 ms for a chip, the Tip and **"apply template"**; only `transform` and `opacity` animate (computed `transition-property` of every animated element); reduced motion honoured (final screens match).
  4. **Fluidity:** no horizontal overflow (`scrollWidth ≤ clientWidth`) at 320, 360, 390, 430, 768, 1024, 1280 and 1440, with the C/P DOM order at each.
- **Wording from lists only:** the Tip wording and every row label are ids from per-template lists; no free text anywhere (owner, 28 Nov). Every word lives in `packages/contracts/src/template-copy.ts`. Caps: link label ≤ 152 px (Studio Inter 15 px 600) and ≤ 22 characters; tip `line` ≤ 168 px (17 px, Creator line 1's computed weight) and ≤ 20 characters; card name ≤ 22, description ≤ 48. Banned in tip labels: "donate", "donation", "buy", "pay", "order", "checkout", "price", and any word implying verification, licensing or approval; link labels never say "Pay" or "Checkout". No adult site in any label's `sites`.
- **Header and chrome:** TipMe logo only, no menu button, no Sign in (19 Nov); **no verified tick** anywhere; **"Powered by tipme"** stays on Creator and Professional.
- **Copy:** users never see the payment provider's name ("our payment partner"); no copy implies regulatory approval, verification or licensing; D-07 stays open; nothing here is legal or partner approval.
- **Content is never moved:** applying, changing or removing a template never moves, deletes or rewrites photo, cover, name, bio, links or blocks (owner decision 4). Rows link out with a chevron, never accent-filled, never Tip-like.
- **No visible change elsewhere:** Classic byte-identical; the C/P images, the 18 existing style images and `profile.visual` unchanged; a document with none of the three fields is byte-identical through resolve; `DESIGN_CHECK_VERSION` stays 3; no version bump.
- **Budgets (§13):** no new public-page client script (the 3 KB script-delta test and `scripts/web-bundle.test.mjs` unmoved); styled page ≤ 12 KB gzip Studio CSS, Classic/standard ≤ 8 KB unmoved; glyphs ≤ 2 KB markup total, server-rendered; every `/@tpl<id>` < 2000 ms in `tests/e2e-perf/lcp.spec.ts`.
- **Switch:** `page_studio` stays **off in production**; nothing edits its runbook row. Every PR is safe with it off and green with it on.
- **Money:** nothing changes a fee, minimum, checkout amount, ledger posting or payout. Tests never call the real payment API.
- **Process:** test first, each behaviour watched red then green. **Never `--no-verify`.** Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PRs go into `dev`. Never edit `docs/agent/ACTIVE_TASK.md`, `HANDOFF.md`, `docs/design/DECISION-LOG.md`.
- **E2E:** lanes **3–8 only** (never 9, never unset in a worktree; lane 6 or 7 suggested, as 3, 4, 5 and 8 are in use). Check `pg_stat_activity` first and take a lane with no connections. **Never run root `pnpm test` between an e2e build and its run** (turbo rebuilds and overwrites the lane build). New or changed specs pass `--repeat-each=5 --retries=0 --workers=2` before push. **Linux snapshot baselines only from CI artifacts**; Darwin copies may be made locally.
- **Screenshots:** every UI PR body shows the expected UI at phone 390 and desktop 1440 (test data only), committed to the orphan `pr-assets` branch under `pr-<n>/`, linked as `https://raw.githubusercontent.com/TheSaviourEking/Tipme/pr-assets/pr-<n>/<file>.png`.

## Commands used by every task

`$LANE` is your lane (3–8), checked free first.

| What                 | Command                                                                                                                                                                                     | Passing output             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Free lane            | `psql -d postgres -Atc "select datname, count(*) from pg_stat_activity where datname like 'tipme_test%' or datname like 'tipme_it%' group by 1"`                                            | chosen lane not shown      |
| Contracts tests      | `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test`                                                                                                               | `# fail 0`                 |
| Web unit tests       | `pnpm --filter @tipme/web test`                                                                                                                                                             | `# fail 0`                 |
| Scripts tests        | `node --test scripts/studio-*.test.mjs scripts/web-bundle.test.mjs`                                                                                                                         | `# fail 0`                 |
| Budgets on a build   | `pnpm --filter @tipme/web build && node --test apps/web/test/route-css.test.mjs`                                                                                                            | `# fail 0`, no `# skip`    |
| Integration (files)  | `TIPME_TEST_DATABASE=tipme_test_lane$LANE node --import ./packages/observability/dist/register.js --test --test-concurrency=1 tests/integration/studio-api.test.mjs`                        | `# fail 0`                 |
| Integration (all)    | `pnpm test:integration` (template DB `tipme_it`, one copy per process)                                                                                                                      | `# fail 0`                 |
| E2E build (per lane) | `rm -rf apps/web/.next && E2E_LANE=$LANE TURBO_FORCE=true node scripts/build-e2e.mjs && E2E_LANE=$LANE node scripts/prepare-e2e-database.mjs`                                               | exit 0                     |
| E2E (one spec)       | `E2E_LANE=$LANE pnpm exec playwright test tests/e2e/<spec>.ts --repeat-each=5 --retries=0 --workers=2`                                                                                      | `passed`, 0 failed         |
| Lab LCP              | `E2E_LANE=$LANE pnpm perf:lab -g "Studio pages"`                                                                                                                                            | every sample `< 2000`      |
| OpenAPI              | `pnpm --filter @tipme/api build && pnpm api:openapi --check`                                                                                                                                | clean (or regenerate once) |
| Whole gate (as push) | `pnpm format:check && pnpm lint && pnpm typecheck && node --test scripts/*.test.mjs && pnpm exec turbo run test --filter='!@tipme/web' && pnpm --filter @tipme/web test` (`E2E_LANE` unset) | exit 0                     |

## Review Focus

Inputs the spec implies but its evidence list does not exercise, most likely to bite first. Each has its pinning test in the owning task.

1. **A Free person previews a template, then picks a free style.** Expected: the preview ends, the save is accepted (no 403, no "taken out" notice) and the stored draft holds no template field. _Tests:_ `a Free save that leaves a template preview carries no template field` (Task 2, gate unit); `a Free person previews Musician, then picks Clear: one save, accepted, no template fields` (Task 8).
2. **A labelled link that changed, vanished, or is hidden** (its URL edited in Settings; removed; a Pro site on a lapsed page; OnlyFans with adult links off). Expected: the row shows standard words (or is gone), each link renders once, nothing throws; the editor notice shows only for "changed". _Tests:_ `templateView ignores labels whose link is missing, hidden or on another site` (Task 2); `a changed URL shows the site's standard words, and a hidden link leaves no row` (Task 5); `the stale notice shows only when the same site still has an unlabelled link` (Task 7).
3. **Typing a growing Custom amount on a Professional template.** Expected: the pill flips from "label · amount" to label-only at exactly the arithmetic boundary, stays one line at one height, and the Tip's CLS is 0. _Test:_ `typing 1 to 12 digits into Custom never changes the pill's height or wraps it` (Task 4).
4. **`?template=` with an unknown, business or giving id (`church`, `restaurant`), or a reload after applying.** Expected: the editor opens as usual with nothing applied and no error; after applying, a reload neither re-applies nor asks again. _Test:_ `an unknown template id opens the editor unchanged, and a reload after applying asks nothing` (Task 9).
5. **Double-tapping a template card, or choosing one while a save is in flight.** Expected: one template applied, one undo step "Undo: template applied", one save of the final draft. _Test:_ `a double tap and a tap during a held save apply the template once, as one undo step` (Task 8).

---

## Delivery order

| PR  | Task                                                   | Visible UI?        |
| --- | ------------------------------------------------------ | ------------------ |
| —   | 0 Pre-flight and boards (parallel with Task 1)         | Canvas             |
| 1   | 1 Catalogue, label lists and the copy file             | No                 |
| 1   | 2 Document fields, resolve, `templateView`, Free gate  | No                 |
| 2   | 3 Template fixtures and the four-design-test probe     | Lab, fixtures      |
| 2   | 4 Tip wording in both skins                            | Public (switch on) |
| 2   | 5 Labelled rows and row glyphs                         | Public (switch on) |
| 2   | 6 Render matrix, measurement, perf, budgets, baselines | (evidence)         |
| 3   | 7 Template editing model                               | No                 |
| 3   | 8 The Templates section in the Style tab               | Editor             |
| 3   | 9 "What best describes you?" on setup's done screen    | Setup, editor      |

---

### Task 0: Pre-flight and boards (controller, parallel with Task 1)

**Files:** none in the repository. Canvas https://claude.ai/artifact/CFaqbtC1zkoyvVqNVhFz4q only (Artifact tool, same URL; never a new artifact).

- [ ] **Step 1: Pre-flight on merged `dev`.** Confirm the C/P branch is merged (`git log origin/dev --oneline | grep -E "Creator|Professional|Start with this layout"`), and that these exist with the shapes above: `skinTipLabel`, `PROFESSIONAL_WORDS`, `splitLinksByPlace`, `linkRowWords`, `StyleLinkRows`, `LINK_CASES`, `withStarter`, `STARTER_UNDO_LABEL`, `apps/web/test/studio-style-copy.test.mjs` with `NEW_STYLE_COPY`. Record any mismatch for the coordinator before Task 1.
- [ ] **Step 2: Read the canvas** (`action: "read"`); note its version and the six drafts in "Templates · draft".
- [ ] **Step 3: Draw** the Artist or designer board (`creative`: Professional, Violet, light; heading · gallery · heading · services · quote; rows "My portfolio", "View services", "Shop my prints"; Tip "Support my art") at phone 390 and desktop 1440, and the **eleven glyphs** (`calendar bag chat pen grid image plane people truck headset menu`) on the 24-unit grid per `docs/design/ICONOGRAPHY.md`, drawn at 16 px in 32 px `fg`-on-`el2` discs, in light and dark, with the forced-colours variant (1 px `CanvasText` disc border). Each board states its four design-test results (contrast pairs, 44 px targets, nothing clipped at 320/390/430, no overflow).
- [ ] **Step 4: Republish to the same URL**, record the version, and ask the owner to move the six drafts plus `creative` and the glyph sheet to final. PR 2 is not pushed until they are approved; record the approved version in PR 2's body.

---

### Task 1: Catalogue, label lists and the copy file (PR 1)

**Files:**

- Create: `packages/contracts/src/template-copy.ts`, `packages/contracts/src/studio-templates.ts`
- Modify: `packages/contracts/src/index.ts` (`export * from './template-copy.js'`, `'./studio-templates.js'`), `packages/contracts/package.json` (`"./template-copy"` export, as `"./copy"`), `apps/web/test/contracts-client-imports.test.mjs`
- Test: `packages/contracts/test/studio-templates.test.mjs`, `apps/web/test/contracts-client-imports.test.mjs`

**Interfaces:**

- Consumes: `SocialPlatform`, `SOCIAL_PLATFORM_KEYS`, `ADULT_PLATFORMS` (`social-links.ts`); `StudioCuratedAccentId`, `StudioMode`, `STUDIO_STYLES`, `STUDIO_ACCENTS`, `CLASSIC_PURPLE`, `accentValues`, `studioContrastPairs` (`studio-styles.ts`); `contrastRatio` (`studio-colour.ts`).
- Produces (`template-copy.ts`, no imports, ruling T1):

  ```ts
  export type StudioTemplateId = 'personal' | 'musician' | 'creator' | 'consultant' | 'seller' | 'creative';
  export type TipLabelId = /* the 13 ids of ruling T7 */;
  export type LinkLabelId = /* the 33 ids of §7.2's table */;
  export type TemplateHintId = /* the 9 ids of ruling T5 */;
  export type RowGlyphId = 'calendar' | 'bag' | 'chat' | 'pen' | 'grid' | 'image' | 'plane' | 'people' | 'truck' | 'headset' | 'menu';
  export const TEMPLATE_COPY: {
    name: Record<StudioTemplateId, string>;      // §6.1 Name column
    describe: Record<StudioTemplateId, string>;  // ruling T6
    link: Record<LinkLabelId, string>;           // §7.2 Text column
    tip: Record<TipLabelId, { line: string; withAmount(amount: string): string }>;
    hint: Record<TemplateHintId, string>;        // ruling T5
  };
  /** Each tip label's measured width at Studio Inter 17 px 600, in px (generated, §8.1). */
  export const TIP_LABEL_WIDTH: Record<TipLabelId, number>;
  export const PILL_TEXT_MAX: number;            // 186 until Task 4 Step 1 (ruling T12)
  export function amountWidth(formatted: string): number; // 12.28 per ₦ + 8.5 per digit + 4.25 per , or .
  /** §8.1: whether "label · amount" (or "Send a ₦… tip") fits Professional's pill on one line. */
  export function tipPillFits(label: TipLabelId, formatted: string): boolean;
  ```

  `withAmount` is `${line} · ${amount}`, except `send-a-tip`: `Send a ${amount} tip`. `tipPillFits` is `TIP_LABEL_WIDTH[label] + 12.75 + amountWidth(a) ≤ PILL_TEXT_MAX`, or `77.0 + amountWidth(a) ≤ PILL_TEXT_MAX` for `send-a-tip`.

- Produces (`studio-templates.ts`):

  ```ts
  export interface StudioTemplate {
    /* exactly §7.1, with hint?: TemplateHintId */
  }
  export const STUDIO_TEMPLATE_IDS: readonly StudioTemplateId[]; // §6.1 order
  export const STUDIO_TEMPLATES: Record<StudioTemplateId, StudioTemplate>;
  export const LINK_LABELS: Record<
    LinkLabelId,
    { sites: readonly SocialPlatform[]; glyph?: RowGlyphId }
  >;
  /** The template's labels that may sit on this site (§10.1's select options, after "The site's own words"). */
  export function labelOptions(
    template: StudioTemplateId,
    platform: SocialPlatform,
  ): LinkLabelId[];
  ```

  Templates (style · accent · mode · starter with hints · tipLabels from §7.2): `personal` creator · green · light · heading(`moments`) gallery paragraph; `musician` creator · rose · dark · heading(`my-music`) gallery heading(`upcoming-shows`) events quote; `creator` creator · null · dark · heading(`my-work`) gallery heading(`about-me`) paragraph quote; `consultant` professional · ink · light · heading(`about-me`) paragraph heading(`what-i-offer`) services; `seller` professional · blue · light · heading(`new-in`) gallery heading(`about-brand`) paragraph; `creative` professional · violet · light · heading(`my-portfolio`) gallery heading(`what-i-offer`) services quote. Headings are `{ kind: 'text', variant: 'heading' }`, paragraphs `{ kind: 'text', variant: 'paragraph' }`. Rows (ruling T14; `suggestedRows` first, then the rest of `linkLabels`, all in this order):
  - `personal`: suggested `my-photos`, `travel-diaries`, `watch-videos`; also `follow-instagram`, `follow-tiktok`, `watch-youtube`, `behind-the-scenes`, `my-blog`, `read-newsletter`, `join-community`, `say-hello`.
  - `musician`: suggested `stream-new-song`, `listen-spotify`, `listen-audiomack`, `follow-instagram`; also `listen-applemusic`, `listen-boomplay`, `listen-soundcloud`, `watch-youtube`, `watch-videos`, `watch-live`, `behind-the-scenes`, `follow-tiktok`, `book-me`, `join-community`, `support-patreon`.
  - `creator`: suggested `watch-youtube`, `watch-live`, `support-patreon`; also `watch-videos`, `behind-the-scenes`, `follow-instagram`, `follow-tiktok`, `join-community`, `join-channel`, `read-newsletter`, `shop-all`.
  - `consultant`: suggested `book-a-call`, `view-services`, `connect-linkedin`; also `book-a-session`, `get-in-touch`, `say-hello`, `read-articles`, `my-blog`, `read-newsletter`.
  - `seller`: suggested `shop-all`, `visit-store`, `track-order`, `contact-support`; also `get-in-touch`, `follow-instagram`, `follow-tiktok`, `join-channel`.
  - `creative`: suggested `my-portfolio`, `view-services`, `shop-prints`; also `my-photos`, `book-a-session`, `book-me`, `get-in-touch`, `follow-instagram`, `behind-the-scenes`, `read-articles`.

- [ ] **Step 1: Write the failing contracts tests** (`studio-templates.test.mjs`):
  - `six templates in the catalogue order, each on Creator or Professional with a curated accent or none` (ids deep-equal; `style ∈ {creator, professional}`; `accent === null || accent !== 'photo'`; the six rows above deep-equal).
  - `every template's starter is at most 6 empty-able blocks with known hints` (kinds ⊂ text/quote/gallery/services/events; every `hint` in `TEMPLATE_COPY.hint`).
  - `suggested rows sit inside each template's link labels, and tip labels are §7.2's lists, default first` (`tipLabels` deep-equal per template, e.g. `musician` → `['tip-the-artist','support-my-music','support-my-work','show-some-love']`).
  - `every link label names real sites and no adult site` (`sites ⊂ SOCIAL_PLATFORM_KEYS`; no `ADULT_PLATFORMS` member; `LINK_LABELS['read-articles'].sites` deep-equals `['substack','linkedin','website']`; glyphs as §7.2).
  - `labelOptions keeps a label off a site it can't promise` (`labelOptions('musician','youtube')` deep-equals `['stream-new-song','watch-youtube','watch-videos','watch-live','behind-the-scenes']`; `labelOptions('consultant','spotify')` is `[]`).
  - `character guards hold` (every link text ≤ 22, tip `line` ≤ 20, name ≤ 22, describe ≤ 48).
  - `no template word is banned, names the payment provider or claims approval` (every string in `TEMPLATE_COPY` against `/\b(donate|donation|buy|pay|order|checkout|price)\b/i` for tip labels, `/\b(pay|checkout)\b/i` for link labels, `/bachs/i` and `/\b(verified|licensed|regulated|approved|certified)\b/i` for all).
  - `the pill rule matches §8.1's measured examples` (`tipPillFits('tip-the-artist','₦100,000') === true`; `tipPillFits('support-my-work','₦2,000') === false`; `tipPillFits('send-a-tip','₦1,000,000') === true`; every label with `'₦9,999,999,999.99'` is false; `amountWidth('₦2,000') === 12.28 + 4*8.5 + 4.25`).
  - `every template's style, accent and mode is proven` (for each template, `studioContrastPairs(style, values, mode, tip)` built as the C/P exhaustive test builds it: every pair meets its threshold).
- [ ] **Step 2: Extend the client-imports test:** `@tipme/contracts/template-copy imports nothing, and the barrel re-exports the same words` (built `dist/template-copy.js` has no import/re-export line; `barrel.TEMPLATE_COPY === tc.TEMPLATE_COPY`; `barrel.tipPillFits === tc.tipPillFits`).
- [ ] **Step 3: Run to see them fail.** Contracts tests; web tests. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** the two files and exports. `TIP_LABEL_WIDTH` at 17 px 600: seed `tip-the-artist` 95.12 and `support-my-work` 128.52 (§8.1's 175.4 and 191.8 less 12.75 and the amount's width); measure the other eleven with a one-off Chromium script in the scratchpad (canvas `measureText`, Studio Inter from `apps/web/public/fonts/studio/inter-400-800.woff2`, the method Task 3's spec uses) and paste them. Task 3 re-checks every value to 0.5 px.
- [ ] **Step 5: Run the tests.** Contracts tests, web tests, `pnpm typecheck`. Expected: `# fail 0`, exit 0.
- [ ] **Step 6: Commit.** `feat(contracts): page template catalogue and its words`.

---

### Task 2: Document fields, resolve, `templateView` and the Free gate (PR 1)

**Files:**

- Modify: `packages/contracts/src/studio-document.ts` (interface, `documentSchema`, `resolveV2`), `packages/contracts/src/studio-gate.ts` (`studioKeepHeld`), `packages/contracts/src/studio-templates.ts` (`templateView`, `starterHints`)
- Test: `packages/contracts/test/studio-document.test.mjs`, `studio-gate.test.mjs`, `studio-templates.test.mjs`, `tests/integration/studio-api.test.mjs`

**Interfaces:**

- Consumes: Task 1's ids, `STUDIO_TEMPLATES`, `LINK_LABELS`; `linkKey`, `detectPlatform`, `STORED_LINK_LIMIT`.
- Produces:

  ```ts
  // StudioDocument gains (§7.4), all optional; absent = today's page:
  template?: StudioTemplateId | null;
  tipLabel?: TipLabelId | null;
  linkLabels?: { link: string; label: LinkLabelId }[];
  export interface TemplateView {
    template: StudioTemplateId;
    tipLabel: TipLabelId;                         // the stored one, or the template's first
    rows: ReadonlyMap<string, LinkLabelId>;       // linkKey(url) → label, only links that fit
  }
  /** Ruling T3: on the document the page shows and the links it renders (`profile.links`); null unless doc.template is set and doc.style is its style. */
  export function templateView(doc: StudioDocument, links: readonly SocialLink[]): TemplateView | null;
  /** §9.2: block id → hint when the blocks still start with the template's starter sequence. */
  export function starterHints(doc: StudioDocument): Record<string, TemplateHintId>;
  ```

- [ ] **Step 1: Write the failing schema and resolve tests** (`studio-document.test.mjs`):
  - `the strict schema takes a template with its own labels` (musician + `tipLabel 'support-my-music'` + one `listen-spotify` entry passes).
  - `the strict schema refuses unknown templates, out-of-list labels, labels without a template, duplicate links and too many entries` (`template: 'church'`; `tipLabel: 'support-my-art'` on musician; `label: 'book-a-call'` on musician; `tipLabel` with no `template`; same `link` twice; `STORED_LINK_LIMIT + 1` entries).
  - `resolve drops an unknown template with both other fields, and out-of-list labels` (`template 'church'` → no `template`, `tipLabel`, `linkLabels`; a foreign label dropped, a valid one kept).
  - `a document with none of the three fields is byte-identical through resolve` (`JSON.stringify` equal for every lab example document).
  - `resolve is idempotent and its output passes the strict schema` (fast-check over random documents with random template fields: `resolve(resolve(x))` deep-equals `resolve(x)`; `studioDocumentSchema.safeParse(resolve(x)).success`).
- [ ] **Step 2: Write the failing `templateView` and hint tests** (`studio-templates.test.mjs`):
  - `templateView is null off the template's style` (musician fields on `style: 'clear'` → null; on `creator` → view).
  - `templateView defaults the tip label to the template's first` (`tipLabel` absent → `'tip-the-artist'`).
  - `templateView ignores labels whose link is missing, hidden or on another site` (Review Focus 2: entry for a removed URL, entry `listen-spotify` keyed to a YouTube link, entry for a link not in `links` because `visibleLinks` hid it → none in `rows`; a trailing-slash variant of a URL still matches by `linkKey`).
  - `the starter-hint matcher gives template hints only to an exact starter sequence` (musician starter blocks → hints on blocks 1 and 3; reordered, a block inserted before, or a heading turned paragraph → `{}`; extra blocks after the sequence keep the hints).
- [ ] **Step 3: Write the failing gate tests** (`studio-gate.test.mjs`, ruling T4):
  - `Free may keep a held template and its labels unchanged` (draft holds musician fields; next edits a block only → `studioDraftRefusal` null).
  - `Free may not set, swap or change a template or tip label` (each → `'STUDIO_PRO_REQUIRED'`).
  - `Free may drop link-label entries but not add one` (subset → null; new entry → refused).
  - `a Free save that leaves a template preview carries no template field` (Review Focus 1: next = Clear with musician fields, held draft has none → `studioKeepHeld` returns the doc without the three fields, and the editor's repaired save is accepted).
  - `Pro saves anything the schema takes` (null).
- [ ] **Step 4: Write the failing integration tests** (`tests/integration/studio-api.test.mjs`): `a Free PUT that sets, swaps or changes any template field is 403 STUDIO_PRO_REQUIRED`; `a lapsed Pro draft with template fields still saves a text edit`; `a lapsed template page is served as Classic and keeps the fields`; `renewed Pro serves the template document again` (public studio document carries `template`, `tipLabel`, `linkLabels`).
- [ ] **Step 5: Run to see them fail.** Contracts tests; integration files (after the free-lane check).
- [ ] **Step 6: Implement.** Schema: three optional keys and the §7.4 refinements. `resolveV2`: add each field only when present and valid (so absent stays absent). `templateView`: `rows` from `doc.linkLabels` where some `links` entry has the same `linkKey` and its platform is in `LINK_LABELS[label].sites`. `studioKeepHeld`: on Free, a `template`/`tipLabel` not equal to a held version's, or a `linkLabels` not a subset of one's, goes back to `held.draft`'s values (or absent). No server code changes (the gate is shared).
- [ ] **Step 7: Run every gate.** Contracts, web, integration (all), OpenAPI (if `--check` reports the document shape, run `pnpm api:openapi` once and commit `docs/api/openapi.json`), whole gate.
- [ ] **Step 8: Commit, push, open PR 1.** `feat(contracts): template fields on the Studio document, read and gated`. PR body: no visible change; switch stays off; Classic and stored documents unchanged; command evidence.

---

### Task 3: Template fixtures and the four-design-test probe (PR 2)

**Files:**

- Modify: `tests/e2e/profile-fixtures.ts` (`TEMPLATE_IDS = STUDIO_TEMPLATE_IDS`; `/@tpl<id>` pages), `tests/e2e/studio-probes.ts` (`designTests`, `interactionLatency`, `animatedProperties`), `apps/web/src/app/dev/studio-lab/examples.ts` and `page.tsx` (`?template=<id>`)
- Create: `tests/e2e/studio-templates.spec.ts`, `tests/e2e/template-measure.spec.ts`
- Test: those two specs; `scripts/studio-lab.test.mjs` (one lab example per template)

**Interfaces:**

- Consumes: Task 1–2 contracts; `geometryProblems`, `contrastProblems`, `settled` (probes).
- Produces:

  ```ts
  // profile-fixtures.ts: /@tpl<id> for each template, published, Pro: the template's style, accent, mode,
  // its starter blocks filled with test words and generated images, its suggested rows as real links
  // with their labels stored, a featured link, and one unlabelled icon-site link.
  export const TEMPLATE_HANDLES: readonly `tpl${StudioTemplateId}`[];
  // studio-probes.ts:
  export async function designTests(
    page: Page,
    url: string,
    opts?: { widths?: number[]; actions?: (page: Page) => Promise<void>[] },
  ): Promise<{
    contrast: string[];
    visibility: string[];
    smoothness: string[];
    fluidity: string[];
  }>; // each list empty = pass
  export async function interactionLatency(
    page: Page,
    act: () => Promise<void>,
  ): Promise<number>; // ms, via PerformanceObserver 'event' with CDP Emulation.setCPUThrottlingRate 4
  export async function animatedProperties(page: Page): Promise<string[]>; // every non-transform/opacity transitioned or animated property found
  ```

  `designTests` runs: `contrastProblems` in light and dark; `geometryProblems` and 44 px targets at 320/390/430; `forcedColors: 'active'` visibility of Tip, rows, chips, glyph discs (border or outline width ≥ 1 px and colour ≠ background); 200% zoom (viewport 640 × 400 at deviceScaleFactor 2) with `scrollWidth ≤ clientWidth`; CLS (< 0.1, and 0 inside the Tip) and `interactionLatency` (< 200) for a chip and the Tip; `animatedProperties` empty; reduced-motion final-screen equality; overflow at 320, 360, 390, 430, 768, 1024, 1280, 1440.

- [ ] **Step 1: Write the failing tests.** `studio-templates.spec.ts`: `every template fixture renders its template's style, accent and mode` (`data-style`, accent token, mode per §6.1); `designTests flags a deliberately broken page` (a lab page with an injected `width: 2000px` element and a `transition: width` element: `fluidity` and `smoothness` non-empty), so the probe can fail. `template-measure.spec.ts` (Chromium, Studio Inter loaded from `apps/web/public/fonts/studio/inter-400-800.woff2` on `/dev/studio-lab?style=professional`, `document.fonts.load` awaited): `every link label and short row word is at most 152 px` (canvas `measureText` at 15 px 600 over `TEMPLATE_COPY.link` and every `linkRowWords`); `every tip line is at most 168 px in Creator line 1's computed font`; `every TIP_LABEL_WIDTH is within 0.5 px of measured at 17 px 600`; `amountWidth matches measured tabular figures within 0.5 px`.
- [ ] **Step 2: Run to see them fail** (E2E build in your lane first).
- [ ] **Step 3: Implement** the fixtures, lab `?template=`, and the probe helpers. Paste measured `TIP_LABEL_WIDTH` values into `template-copy.ts` if they differ.
- [ ] **Step 4: Run** both specs `--repeat-each=5 --retries=0 --workers=2`, contracts tests.
- [ ] **Step 5: Commit.** `test(studio): template fixtures, the four design tests and label measurement`.

---

### Task 4: Tip wording in both skins (PR 2)

**Files:**

- Modify: `apps/web/src/components/tip-skin-label.ts`, `apps/web/src/components/appreciation-form.tsx` (`tipLabel?: TipLabelId`), `apps/web/src/app/people/[handle]/page.tsx`, `apps/web/src/app/studio-preview/preview-frame.tsx`, `apps/web/src/app/dev/studio-lab/page.tsx` (pass `templateView(shown, visible)?.tipLabel`), `packages/contracts/src/template-copy.ts` (`PILL_TEXT_MAX`, ruling T12)
- Test: `apps/web/test/tip-skin-label.test.mjs`, `apps/web/test/contracts-client-imports.test.mjs` (unchanged rule, now covering the new import), `tests/e2e/studio-templates.spec.ts`

**Interfaces:**

- Consumes: `TEMPLATE_COPY.tip`, `tipPillFits` (from `@tipme/contracts/template-copy` only, ruling T2); `templateView` (server files only).
- Produces:

  ```ts
  export function skinTipLabel(
    skin: TipSkin,
    amountMinor: string | number | bigint | null,
    tipLabel?: TipLabelId,
  ): { name: string; lines?: readonly [string, string]; text?: string } | null;
  // creator + tipLabel: lines = [line, 'Give, tip or appreciate'], name = visible words + amount (S-R5).
  // professional + tipLabel: text = withAmount(amount) when tipPillFits, else line;
  //   name = text when the amount shows, else `${line}, ${amount}` (ruling T8); null amount → line.
  // No tipLabel: exactly today's result (C/P tests unchanged).
  ```

- [ ] **Step 1: Read the built pill.** From `professional.css`, take the pill's width at 320 and its padding, heart and gap; set `PILL_TEXT_MAX` = text width − 4 and record the sum in a comment. If it differs from 186, re-run Task 1's pill examples and note any flip in the PR.
- [ ] **Step 2: Write the failing unit tests** (`tip-skin-label.test.mjs`): `Creator with a template reads its line over "Give, tip or appreciate"` (`skinTipLabel('creator','200000','tip-the-artist')` → lines `['Tip the artist','Give, tip or appreciate']`, name `Tip the artist Give, tip or appreciate ₦2,000`); `Professional shows the amount only when it fits` (`'tip-the-artist','10000000'` → text `Tip the artist · ₦100,000`; `'support-my-work','200000'` → text `Support my work`, name `Support my work, ₦2,000`; `'send-a-tip','100000000'` → `Send a ₦1,000,000 tip`; `'999999999999'` → label-only for every label); `no tip label keeps the C/P words exactly` (every skin's output deep-equal to the call without the third argument).
- [ ] **Step 3: Write the failing browser tests** (`studio-templates.spec.ts`): `Professional at 320 with the longest tip label and ₦9,999,999,999.99 in Custom shows the label only, unclipped, named with the amount` (§14.2); `with "Tip the artist" and ₦100,000 it shows both`; `typing 1 to 12 digits into Custom never changes the pill's height or wraps it` (Review Focus 3: pill `getBoundingClientRect().height` constant; CLS inside the Tip 0); `the sticky bar keeps "Tip ₦…" on every template`; `"Starting your tip…" replaces the template words while a tip starts`; `labels show only on the template's style` (the musician fixture switched to `style=clear` in the lab shows Clear's words); `designTests` empty on every `/@tpl<id>`.
- [ ] **Step 4: Run to see them fail.**
- [ ] **Step 5: Implement.** The form recomputes from the current amount (pure arithmetic, no layout read). Server files compute `templateView` on the shown document and visible links and pass `tipLabel` only when non-null.
- [ ] **Step 6: Run** web tests, the spec `--repeat-each=5 --retries=0`, and `studio-styles.spec.ts` (C/P tip tests unchanged).
- [ ] **Step 7: Commit.** `feat(web): template tip wording on Creator and Professional`.

---

### Task 5: Labelled rows and row glyphs (PR 2)

**Files:**

- Create: `apps/web/src/components/studio-styles/row-glyphs.tsx`
- Modify: `packages/contracts/src/social-links.ts` (`splitLinksByPlace` option), `apps/web/src/components/studio-styles/parts.tsx` (`StyleLinkRows` labels), `style-page.tsx` (pass the view's rows), `creator.css`, `professional.css` (glyph disc, forced colours)
- Test: `packages/contracts/test/social-links.test.mjs`, `apps/web/test/studio-style-page.test.mjs`, `tests/e2e/studio-templates.spec.ts`

**Interfaces:**

- Consumes: `templateView(...).rows`, `LINK_LABELS[label].glyph`, `TEMPLATE_COPY.link`.
- Produces:

  ```ts
  export function splitLinksByPlace(
    links: readonly SocialLink[],
    asRow?: (link: SocialLink) => boolean, // §8.2: a labelled icon-site link is a row
  ): { icons: SocialLink[]; rows: SocialLink[] };
  export function RowGlyph(props: { glyph: RowGlyphId }): JSX.Element; // inline SVG, 16 px, stroke currentColor, aria-hidden
  export function StyleLinkRows(props: {
    links: readonly SocialLink[];
    labels?: ReadonlyMap<string, LinkLabelId>; // keyed by linkKey(url)
  }): JSX.Element | null;
  ```

  A labelled row's visible title is `TEMPLATE_COPY.link[label]`; its badge slot shows `RowGlyph` in the 32 px disc when the label has a glyph, else the site badge; its name is ruling T8's. Glyph paths are the approved Task 0 board's, exactly.

- [ ] **Step 1: Write the failing tests.** Contracts: `asRow lifts a labelled icon-site link into the rows in saved order; the featured link stays first; each link once` (fast-check permutation as the C/P test). Web unit: `a labelled row shows its label and glyph, and is named "{label}, {Site}{: handle}, opens in a new tab"` (`Book a call, Website, opens in a new tab`; `Follow on Instagram, Instagram: @kemisings, opens in a new tab`); `an unlabelled row's markup is unchanged` (C/P markup string equal); `rows never carry the accent fill or the Tip's classes`; `the eleven glyphs total at most 2 KB of markup` (`renderToStaticMarkup` of all eleven ≤ 2048 bytes); `no glyph is named or focusable`. Browser: `a labelled Instagram renders once, as a row` (§14.2); `a changed URL shows the site's standard words, and a hidden link leaves no row` (Review Focus 2: fixture with a stored label for an edited URL and an OnlyFans hidden by the adult switch); `at 320 in both styles the longest label of each template is one line` (label box height = one line-height); `glyph discs keep a CanvasText border in forced colours`; `designTests` empty on every `/@tpl<id>`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** `asRow` = `(l) => view?.rows.has(linkKey(l.url)) ?? false`. CSS adds only the disc and `@media (forced-colors: active)` rules, inside the 12 KB budget.
- [ ] **Step 4: Run** contracts, web tests, the spec and `studio-styles.spec.ts` (`--repeat-each=5 --retries=0`); C/P link-case tests unchanged.
- [ ] **Step 5: Commit.** `feat(web): template link rows and row glyphs`.

---

### Task 6: Render matrix, perf, budgets and baselines; open PR 2

**Files:**

- Modify: `tests/e2e/studio-templates.spec.ts` (matrix), `tests/e2e/studio-styles.visual.spec.ts` (12 shots), `tests/e2e-perf/lcp.spec.ts` (template fixtures join `Studio pages`), `apps/web/test/studio-style-copy.test.mjs` (`NEW_STYLE_COPY` gains every `TEMPLATE_COPY` string)
- Test: the above plus every budget spec

- [ ] **Step 1: Write the failing tests.** Matrix: `each template × light and dark × 320, 390, 768, 1024, 1440: axe clean, no overflow, no clipped text`; `no menu button, no Sign in, no verified mark, "Powered by tipme" present on every template`. Visual: `template <id> at 390` and `at 1440` in its own mode (files `studio-tpl-<id>-<width>-<mode>.png`; 12 images). Perf: `/@tpl<id>` for each id in `lab LCP sample: Studio pages`. Copy test: the template words pass the provider and approval guards.
- [ ] **Step 2: Run to see them fail** (visual expects missing baselines).
- [ ] **Step 3: Implement** the lists; nothing else.
- [ ] **Step 4: Run every gate.** Whole gate; budgets on a build (record creator/professional gzip bytes, standard ≤ 8 KB unmoved); `node --test scripts/studio-fonts.test.mjs scripts/web-bundle.test.mjs` unmoved; `studio-page.spec.ts` (script delta and `renders exactly today's page`), `studio-styles.spec.ts`, `studio-templates.spec.ts`, `template-measure.spec.ts`, `profile-header.spec.ts`, `footer-grounded.spec.ts` each `--repeat-each=5 --retries=0`; Lab LCP: every `/@tpl<id>` sample `< 2000`.
- [ ] **Step 5: Commit, push, open PR 2.** `test(studio): template render matrix, perf and snapshots`.
- [ ] **Step 6: Baselines from CI.** Download CI's Linux actuals for the 12 images, commit them; CI must show no diff on the C/P images, the 18 style images and `profile.visual`.
- [ ] **Step 7: Screenshots** on `pr-assets/pr-<n>/`: each template at 390 and 1440 in its mode, Professional label-only vs "label · amount" at 320, a labelled icon-site row, forced-colours rows; body records the approved canvas version, CSS bytes, LCP samples, each difference from a board, and that the switch stays off.

---

### Task 7: Template editing model (PR 3)

**Files:**

- Create: `apps/web/src/app/dashboard/studio/template-model.ts`
- Modify: `undo-stack.ts` (`describeChange`), `starter-layout.ts` (template starter and title)
- Test: `apps/web/test/studio-templates-model.test.mjs`, `apps/web/test/studio-undo.test.mjs`, `apps/web/test/studio-starter.test.mjs`

**Interfaces:**

- Consumes: `STUDIO_TEMPLATES`, `labelOptions`, `starterHints`, `templateView`, `detectPlatform`, `linkKey`, `TEMPLATE_COPY`; `withStarter` (C/P Task 7).
- Produces:

  ```ts
  /** §9.1/§9.3: one step; drops labels outside the new list; never touches blocks, links or cover photo. */
  export function applyTemplate(
    doc: StudioDocument,
    id: StudioTemplateId,
  ): { doc: StudioDocument; dropped: number };
  export function clearTemplate(doc: StudioDocument): StudioDocument; // removes the three fields; style, accent, mode kept
  export function withTipLabel(
    doc: StudioDocument,
    label: TipLabelId,
  ): StudioDocument; // the default stores null
  export function withLinkLabel(
    doc: StudioDocument,
    url: string,
    label: LinkLabelId | null,
  ): StudioDocument;
  export interface LinkRowChoice {
    url: string;
    platform: SocialPlatform;
    selectName: string;
    options: { value: LinkLabelId | null; text: string }[];
    chosen: LinkLabelId | null;
    suggestion: LinkLabelId | null;
  }
  export function linkRowChoices(
    doc: StudioDocument,
    links: readonly SocialLink[],
  ): LinkRowChoice[]; // page order
  export function suggestedEmptyRows(
    doc: StudioDocument,
    links: readonly SocialLink[],
  ): LinkLabelId[];
  export function staleLabelNotices(
    doc: StudioDocument,
    links: readonly SocialLink[],
  ): string[]; // ruling T9
  export function withoutStaleLabels(
    doc: StudioDocument,
    links: readonly SocialLink[],
  ): StudioDocument;
  export const TEMPLATE_UI: {
    heading: 'Start from a template';
    none: 'No template';
    keeps: 'Your photo, bio, links and blocks stay as they are.';
    tipHeading: 'Tip button wording';
    rowsHeading: 'Link rows';
    ownWords: "The site's own words";
    addLink: 'Add link';
    applied(name: string): string; // "Musician applied. Undo"
    dropped(n: number): string; // "2 link labels go back to the site's own words."
    hidden(name: string, style: string): string; // "Your Musician wording shows when you use Creator."
    selectName(site: string): string; // "Words for your Spotify link"
    use(label: string): string; // "Use 'Listen on Spotify'"
    addYourLink(label: string): string; // "Listen on Spotify: add your link"
    changed(site: string): string; // "Your link to Spotify changed. Choose its label again."
    starter(name: string): string; // "Add the Musician blocks"
    confirmTitle(name: string): string; // "Use the Musician template?"
    confirmYes: 'Use template';
    confirmNo: 'Not now';
  };
  // describeChange: template set or changed → 'template applied'; removed → 'template removed';
  // tipLabel → 'tip wording changed'; linkLabels → 'link words changed' (ruling T11), checked before style.
  // withStarter: with a template on its style, the template's starter and hints; title TEMPLATE_UI.starter(name).
  ```

  `applyTemplate` sets `style`, `accent`, `mode`, `cover: 'yours'`, `template`, `tipLabel: null`, keeps `linkLabels` entries in the new list, and stores no new label (§9.2).

- [ ] **Step 1: Write the failing unit tests:** `applying a template sets style, accent, mode and cover and nothing else` (blocks, ids and order deep-equal; links untouched; `linkLabels` absent on a page with links); `changing template drops out-of-list labels and counts them` (`dropped === 2` case; message `2 link labels go back to the site's own words.`); `No template clears the three fields and keeps style, accent and mode`; `the default tip label is stored as null`; `link row options are "The site's own words" plus the labels that fit that site` (Spotify on musician → own words, `listen-spotify`, `stream-new-song`); `suggested rows without a link are listed, and vanish once the link exists`; `the stale notice shows only when the same site still has an unlabelled link` (Review Focus 2); `stale entries go on the next Pro save`; `describeChange names template steps first` (apply → `Undo: template applied`); `the starter offer uses the template's blocks and hints, and hints come back after a reload` (`starterHints` on the saved doc); `every TEMPLATE_UI string passes the provider and approval guards` (added to `NEW_STYLE_COPY`).
- [ ] **Step 2: Run to see them fail.** Web tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** web tests and the whole gate.
- [ ] **Step 5: Commit.** `feat(web): template editing model`.

---

### Task 8: The Templates section in the Style tab (PR 3)

**Files:**

- Create: `apps/web/src/app/dashboard/studio/template-section.tsx`, `template-cards.tsx`
- Modify: `style-tab.tsx` (section at the top), `studio-editor.tsx` (status line focus, notices, links for the rows), `use-studio-draft.ts` (`applyTemplate`, `clearTemplate` as single steps, stale drop on Pro saves), `studio-preview.tsx` or `app/studio-preview/preview-frame.tsx` (preload Creator and Professional sheets when the section mounts), `studio-editor.css`, `dashboard/settings/sections/your-links.tsx` (only as needed for "Add link", builder's call per §10.1)
- Test: `apps/web/test/studio-editor.test.mjs`, `tests/e2e/studio-templates-editor.spec.ts`, `tests/e2e/studio-free-preview.spec.ts`

**Interfaces:**

- Consumes: Task 7; `Miniature` (`style-cards.tsx`); `designTests`, `interactionLatency` (Task 3).
- Produces: `StudioDraft` gains `applyTemplate(id: StudioTemplateId | null): void` (null = No template; no-op when the latest draft already has that template, so a double tap is one step) and `templateNotice: string | null`. `TemplateSection` renders the `role="radiogroup"` of cards ("No template" first; miniature in the template's accent and mode; name; description), then, on Pro with a template active, the tip radio group (each previewed with ₦2,000) and one native `<select>` per visible link, then the suggested empty rows with "Add link".

- [ ] **Step 1: Write the failing tests.** Unit: `every template card has a name, a description and a miniature in its accent and mode`. Browser (Pro e2e users per test unless stated):
  - `applying Musician changes style, accent and mode as one undo step, and leaves blocks, links, photo and bio untouched` (§14.3).
  - `focus moves to the status line "Musician applied. Undo"`.
  - `the starter offer shows only on an empty Pro draft, as "Add the Musician blocks"`; `starter hints come back after a reload`.
  - `a label swap saves, undoes and discards correctly`; `changing template drops out-of-list labels with the notice`; `No template clears the fields`.
  - `the changed-URL notice shows once on the next Studio open` (edit a labelled URL via the links API, open Studio: notice; make an edit, reopen: none).
  - `switching style hides the template and says "Your Musician wording shows when you use Creator."`; switching back restores the labels.
  - `a double tap and a tap during a held save apply the template once, as one undo step` (Review Focus 5: `dblclick`; `page.route` holds the first PUT).
  - `"apply template" meets 200 ms INP on the throttled profile with both sheets preloaded` (`interactionLatency` < 200; the preview's `link[rel=preload]` or loaded sheet for creator and professional exists before the tap).
  - `cards at 320: names and descriptions at their caps fit and all cards share one height`; `the selected card keeps a 2 px Highlight outline in forced colours`; `cards scroll with snap on a phone and sit three to a row at 1440`.
  - `designTests` on `/dashboard/studio` Style tab (contrast, visibility, smoothness with "apply template" as the action, fluidity 320–1440); axe clean at 390 and 1440; reduced motion: card selection does not animate.
  - Free (`studio-free-preview.spec.ts`): `a Free person previews Musician: "Previewing a Pro style: not saved", no save, no tip or row pickers, no starter offer`; `a Free person previews Musician, then picks Clear: one save, accepted, no template fields` (Review Focus 1).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** Selects are native; the tip group and the cards are native radios. "Add link" per §10.1 (builder's call, named in the PR); saving a link stays live.
- [ ] **Step 4: Run** web tests and the specs above plus `studio-editor.spec.ts`, `studio-undo.spec.ts`, `studio-publish.spec.ts`, `studio-starter.spec.ts`, each `--repeat-each=5 --retries=0`.
- [ ] **Step 5: Commit.** `feat(web): the Templates section in Page Studio`.

---

### Task 9: "What best describes you?" on setup's done screen; open PR 3

**Files:**

- Modify: `apps/web/src/app/dashboard/welcome/welcome-view.tsx` (done screen), `apps/web/src/app/dashboard/studio/studio-editor.tsx` (`?template=` handling and the confirm), `studio-editor.css`
- Test: `apps/web/test/welcome.test.mjs` (or the existing welcome unit test), `tests/e2e/welcome.spec.ts`, `tests/e2e/studio-templates-editor.spec.ts`

**Interfaces:**

- Consumes: `STUDIO_TEMPLATE_IDS`, `TEMPLATE_COPY`, `TemplateCards` (Task 8), `TEMPLATE_UI.confirm*`, `isClassicDefault`.
- Produces: `templateFromQuery(value: string | null): StudioTemplateId | null` (unknown → null) and `templateEntry(draft, published): 'apply' | 'confirm'` (ruling T10) in `template-model.ts`.

- [ ] **Step 1: Write the failing tests.** Unit: `templateFromQuery accepts only catalogue ids` (`'church'`, `'restaurant'`, `''`, `'Musician'` → null); `templateEntry is apply only for a Classic-default draft with nothing published`. Browser: `the done screen offers six templates and Skip, and "Step n of 3" is unchanged`; `choosing one goes to /dashboard/studio?template=<id> and stores nothing`; `on a new empty page the template applies straight away (Pro) or previews (Free)`; `on a page with content the confirm shows, and "Not now" leaves the draft byte-identical` (PUT count 0; draft JSON equal); `"Use template" applies as one undo step`; `an unknown template id opens the editor unchanged, and a reload after applying asks nothing` (Review Focus 4); `designTests` on the done screen; axe clean at 390 and 1440.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** The confirm is a native `<dialog>` with the two buttons; `history.replaceState` drops `?template=` after either choice.
- [ ] **Step 4: Run every gate.** Whole gate; integration (all); the changed specs `--repeat-each=5 --retries=0`.
- [ ] **Step 5: Commit, push, open PR 3.** `feat(web): templates from setup`. Screenshots on `pr-assets/pr-<n>/`: Style tab with Templates (Free and Pro) at 390 and 1440, the tip wording and link-row pickers, the dropped-labels notice, the changed-URL notice, the starter offer, the done screen, and the confirm. Body: switch stays off; no fee, amount or provider wording changed.

---

## Spec coverage map

| Spec                                         | Task              |
| -------------------------------------------- | ----------------- |
| §2 owner decisions                           | Global, 1–9       |
| §6.1 catalogue                               | 1, 0              |
| §7.1 template data; §7.2 label lists         | 1                 |
| §7.3 one source, caps                        | 1, 3              |
| §7.4 document fields, schema, resolve        | 2                 |
| §7.5 API, Free gate, check unchanged         | 2                 |
| §8.1 tip button                              | 1, 4              |
| §8.2 link rows; §8.3 glyphs                  | 5, 0              |
| §9 applying, never changing, switching, Free | 7, 8              |
| §10.1 picker; §10.2 setup                    | 8; 9              |
| §11, §12 later phases                        | not here          |
| §13 accessibility, four design tests, perf   | Global, 3–6, 8, 9 |
| §14.1 contracts; §14.2 render; §14.3 editor  | 1–2; 3–6; 7–9     |
| §14.4 integration; §14.5 snapshots           | 2; 6              |
| §15 departures                               | 2, 4, 5, 7        |
| §16 order of work                            | T13, 0–9          |

## Risks

- **C/P not yet merged.** Professional, the starter layout and the copy test are planned but unbuilt here; Task 0 Step 1 catches drift before any code.
- **Pill constants.** If the built pill is narrower than the board, more labels go label-only; Task 4 Step 1 re-runs the examples and the PR lists flips.
- **12 KB budget.** Glyph discs and forced-colours rules are small; if a sheet would pass 12 KB, stop and report bytes before trimming anything visible.
- **Board approval timing.** PR 2 waits on Task 0's owner approval of `creative` and the glyphs; PR 1 does not.
