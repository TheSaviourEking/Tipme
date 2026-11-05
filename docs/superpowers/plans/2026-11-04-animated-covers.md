# Animated covers: design and implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page's cover can be animated. Free pages get three animated covers that play once. Pro pages get more, in every colour, and choose "Slow loop" or "Plays once". Automatic covers stay still.

**Owner's decision:** decided 2 Nov 2026 and confirmed 4 Nov 2026. It is a product and visual decision, not a regulatory approval. No D-item in `docs/00-DECISIONS.md` is affected, and nothing about payments changes.

**Board:** `docs/design/redesign/boards/ScreenAnimatedCovers.dc.html`. The `/pro` page already shows a "Slow loop" picture that is `aria-disabled` on Free (`apps/web/src/components/marketing/plan-preview.tsx`).

**Architecture:** The animation is a second, optional choice on `profiles`, beside the still design. `resolveCover` in `@tipme/contracts` decides what a page shows, with the page's plan as an input. It works out a `play` of `once`, `loop` or `still`, and the browser obeys it. The server refuses Pro-only choices from Free pages, using the same check-then-conditional-update pattern as the QR lock in `updateMyProfile`. The cover is drawn as server-rendered HTML layers animated by CSS (transform and opacity only). A small client component freezes it. No new dependency.

**Tech stack:** Drizzle/Postgres, NestJS, Next App Router, CSS keyframes, Playwright, `node --test`.

---

## Design

### Data model (additive)

- `profiles.cover_animation text NULL`: an id from `COVER_ANIMATIONS`. It is held as text, like `cover_design`, so removing a catalogue entry needs no migration. An unknown id resolves as if nothing were chosen.
- `profiles.cover_motion text NULL`, with the check `cover_motion IN ('once','loop')`. NULL means "no setting", which plays once.
- `cover_colour` is reused for an animated cover's colour. NULL means the animation's own palette.
- **Precedence:** uploaded photo, then animation, then still design, then automatic. Choosing an animation clears `cover_design`, and choosing a still design clears `cover_animation` and `cover_motion`, in the same single `UPDATE`. One chooser, one "Save cover".
- **Contracts:**
  - `ResolvedCover` gains `{ kind: 'animated'; animation: string; colour?: string; play: 'once' | 'loop' | 'still' }`.
  - `MyProfile.coverChoice` gains `animation: string | null` and `motion: 'once' | 'loop' | null`.
  - `coverDesignChoiceSchema` gains optional `animation` and `motion`.
  - All of this is additive. The web deploys first and must draw `animated` before the API sends it. An unknown `kind` draws the automatic cover.

### Free and Pro designs

| id       | Name      | Plan | Own palette (base / hearts) |
| -------- | --------- | ---- | --------------------------- |
| `drift`  | Drifting  | Free | `#204f3b` / `#3a7a5e`       |
| `rise`   | Rising    | Free | `#4d16a8` / `#7a32f9`       |
| `ripple` | Ripple    | Free | `#7c2d12` / `#b45a2b`       |
| `pulse`  | Pulse     | Pro  | `#14110f` / `#7a32f9`       |
| `night`  | Night sky | Pro  | `#101a3a` / `#3e5aa8`       |
| `sun`    | Sunrise   | Pro  | `#8a3b12` / `#e39a3b`       |

- The ids, names and palettes are the board's. Animation ids live in their own column and catalogue, so `ripple` (animated) never collides with the still design `ripple`.
- **Free:** the three Free animations, in their own palette, played once. There is no motion setting and no colour.
- **Pro:** all six animations. Any `COVER_COLOURS` colour can be used (base becomes the background, tone becomes the hearts), and so can "Plays once" or "Slow loop".
- **Automatic covers never animate.** `automaticCover` and `automaticColour` are unchanged and never return an animation.
- The palettes fall under the 2026-11-01 "Cover colour exception": they are the person's own decorative picture, and nothing that carries meaning sits on them.

### The server lock

- `coverChoiceNeedsPro(choice)` is a shared contracts function, used by both web and API. It is true when:
  - the animation is a Pro animation;
  - `motion === 'loop'`; or
  - a colour is sent with an animation.
- `setCoverDesign` checks the plan before writing, and adds `eq(profiles.plan, 'pro')` to the `UPDATE`'s `WHERE` when the choice needs Pro, because staff may move the page to Free between the read and the write. This mirrors `updateMyProfile` and `QR_DESIGN_PRO_REQUIRED`.
- A zero-row update is ambiguous, since it can mean "unchanged" or "lost Pro". The function then re-reads the plan: Free throws, and Pro returns `changed: false`.
- The new error is `COVER_DESIGN_PRO_REQUIRED`. It returns 403 with the message "This cover choice is part of TipMe Pro."

### The fallback

`coverPlay(animation, colour, motion, plan)` is in contracts:

- **Pro page:** `motion ?? 'once'`.
- **Not a Pro page** (Free, or `plan` absent): `'still'` if the animation is Pro-only or a colour is saved, otherwise `'once'`. A saved `loop` on a Free animation therefore plays once.
- **Nothing is deleted.** A page that returns to Pro gets its loop back, as `shownQrStyle` does for QR.
- **The still version is the animation's settled final frame,** in the saved colour.
- **The public page changes on its next view.** The ops plan change already revalidates it (`apps/api/src/ops/pages.controller.ts`).

### Drawing

- Five absolutely positioned HTML `<span class="cover-fx">` layers, each holding a small inline SVG brand heart, over the base colour. Positions, sizes and delays follow the board.
- The layers are HTML, not SVG `<g>`, because CSS transform and opacity animations on HTML elements run on the compositor, while SVG child elements animate on the main thread.
- Every layer's own styles are the settled frame. Keyframes run only `from` an offset, to the layer's own style. So `animation: none` is always the correct still frame.
- **Only `transform` and `opacity` animate.** No `will-change` is left on.
- **Timings (new, recorded in the decision log):**

  | Mode       | Duration | Repeats                      | Easing            | Stagger       |
  | ---------- | -------- | ---------------------------- | ----------------- | ------------- |
  | Plays once | 2800ms   | 1                            | `--ease-physical` | 0–600ms delay |
  | Slow loop  | 8000ms   | infinite, `alternate` (slow) | `--ease-physical` | 0–600ms delay |

  These are part of the exception to §3's "at most 4 items, 420ms total".

- **Only `/@handle` and the Settings live preview animate.** `ProfileCover` takes `animate` (default `false`). Choice thumbnails, the Home postcard stamp, dashboard cards and staff screens show the still frame.

### Freeze rules

The cover's animations get `animation-play-state: paused`:

- **When the tip form is used.** The first `focusin`, `pointerdown` or `input` inside `[data-tip-panel]`, or `data-submitting` on its form, sets `data-cover-frozen` on the cover. It stays frozen for the rest of that page view and is not resumed when focus leaves. The payment moment must stay still, and the board says covers "stop moving as soon as someone starts tipping".
- **Off screen.** An `IntersectionObserver` (threshold 0) sets `data-cover-offscreen`. A loop resumes when the cover returns, unless it is frozen. A "plays once" paused mid-play resumes from where it stopped.
- **Without scripts,** a CSS fallback still pauses while focus is in the panel: `.profile-page:has([data-tip-panel] :focus-within) .cover-fx`.
- A paused animation holds the frame it reached. Freezing never jumps to another frame.

### Reduced motion and forced colours

- **`prefers-reduced-motion: reduce`:** `animation: none` on `.cover-fx`, which shows the settled still frame. Nothing is lost.
- **`forced-colors: active`:** `animation: none`, and the cover keeps a plain 1px `CanvasText` bottom edge, as other surfaces do. The hearts are decorative and `aria-hidden`.
- **`@media print`:** still.

### Performance budget

- **No new request.** The layers are inline in the server HTML, under 2 KB gzipped for the six animations. The cover and name are in the first paint, and no animation delays the LCP element.
- **`pnpm perf:lab`:** on the throttled phone (4x CPU, about 1.6 Mbit/s, 150ms latency), every `/@tobi` sample stays **under 2000ms LCP**, measured with Tobi on Pro, `night`, `loop`, and `reducedMotion: 'no-preference'`.
- **The existing limits hold:** CLS below 0.1, INP below 200ms (EXPERIENCE-AND-MOTION §9).
- **If frames drop on a throttled phone,** the effect is cut, not tuned (§9).

---

## Global Constraints

- **Workspace:**
  - Branch `feat/animated-covers`, in `.worktrees/animated-covers`, off `origin/dev`.
  - One PR, into `dev`.
  - Never push or merge without the owner.
  - Never use bare `git stash`.
- **Read first:** `AGENTS.md` and the nearest scoped `AGENTS.md` (`packages/contracts`, `apps/api`, `apps/web`). For UI, also read `docs/design/DESIGN-CONSTITUTION.md` and its required documents.
- **Contracts:** shapes live in `packages/contracts` only. No `any`. Exports have no Next, Nest or ORM imports.
- **Migration:** the next free number after `0070` (expected `0071_cover_animation.sql`), generated with `pnpm --filter @tipme/database generate`. The journal `when` must be later than all others. Expect renumbering if another branch merges a migration first.
- **Accessibility:**
  - Controls are at least 44px.
  - Every choice has a visible name, never colour alone.
  - Locked choices say "Pro" in text.
  - `aria-disabled`, not `disabled`, on "Slow loop" for Free, so it stays focusable and can explain itself.
- **Pro wording:** no price anywhere, because how Pro is bought is still open.
- **Tests:** the Playwright suite runs with `reducedMotion: 'reduce'` by default (`playwright.config.ts`). Motion tests must call `page.emulateMedia({ reducedMotion: 'no-preference' })`.
- **Reporting:** report every failing test by name with its error. Run commands exactly as written, and record pass, fail or skipped.

## Review Focus

1. **The Pro lock at the API.** A Free page sending a Pro animation, `motion: 'loop'`, or a colour with an animation gets 403 `COVER_DESIGN_PRO_REQUIRED`, and nothing is written, including when the plan drops between the read and the write (Task 3).
2. **The fallback.** A page leaving Pro shows the still frame, never a loop, and gets its loop back on return. Pure resolution in Task 2, end to end in Task 4.
3. **Freezing.** The first touch of the tip form pauses every cover animation, and it never resumes during that view. Nothing moves during "Pay" (Task 6).
4. **Reduced motion and forced colours.** Zero running animations, and the still frame matches the settled frame (Tasks 5 and 6).
5. **LCP.** It stays under 2000ms with a looping cover on the throttled phone (Task 8). The cover must never become a late LCP candidate.
6. **No regression.** Still designs, automatic covers, uploads and older API responses with no `animated` kind draw exactly as before (Tasks 2 and 5).

---

### Task 1: Record the owner's exception

**Files:**

- Modify:
  - `docs/design/EXPERIENCE-AND-MOTION.md`: add §7.11 "Animated covers (owner's decision, 2 Nov 2026, confirmed 4 Nov 2026)", and amend the §6 "Cover" bullet to point to it;
  - `docs/design/DECISION-LOG.md`: a new entry "2026-11-04 — Animated covers", with the timings, the Free/Pro split and the freeze rules;
  - `docs/00-DECISIONS.md`: add "animated covers that loop, and every colour" to "What Pro includes now", marked as the owner's product decision, not a regulatory approval.
- Test: none (docs). The check is a grep.

**Interfaces:** none.

- [ ] **Step 1: Write the failing check.**

  ```bash
  grep -q "Animated covers (owner's decision" docs/design/EXPERIENCE-AND-MOTION.md && grep -q "Animated covers" docs/design/DECISION-LOG.md
  ```

- [ ] **Step 2: Run it.** Expected: FAIL (exit 1).
- [ ] **Step 3: Implement.** §7.11 states:
  - this is an exception to "motion is allowed for four reasons only", to the stagger limit, and to "no looping" outside the acknowledgement;
  - Free gets three that play once, and automatic covers stay still;
  - Pro chooses "Slow loop" or "Plays once";
  - transform and opacity only;
  - the cover freezes on first use of the tip form and when off screen;
  - reduced motion and forced colours give the still frame;
  - the server lock and the still fallback;
  - the timings 2800ms and 8000ms;
  - LCP under 2000ms in `pnpm perf:lab`.

  Quote the owner's ruling and say it is not a regulatory approval.

- [ ] **Step 4: Run the check again, and the formatter.**

  ```bash
  grep -q "Animated covers (owner's decision" docs/design/EXPERIENCE-AND-MOTION.md && grep -q "Animated covers" docs/design/DECISION-LOG.md && pnpm exec prettier --check docs/design docs/00-DECISIONS.md
  ```

  Expected: PASS.

- [ ] **Step 5: Commit.** `docs: record animated covers as the owner's motion exception`

### Task 2: Contracts — catalogue, choice and resolution

**Files:**

- Modify:
  - `packages/contracts/src/covers.ts`;
  - `packages/contracts/src/profiles.ts` (`coverChoice`);
  - `packages/contracts/src/errors.ts` (`COVER_DESIGN_PRO_REQUIRED`).
- Test: `packages/contracts/test/covers.test.mjs`.

**Interfaces (produces):**

```ts
export interface CoverAnimation {
  id: string;
  name: string;
  pro: boolean;
  base: string;
  tone: string;
}
export const COVER_ANIMATIONS: readonly CoverAnimation[]; // drift, rise, ripple (Free); pulse, night, sun (Pro)
export type CoverMotion = 'once' | 'loop';
export type CoverPlay = CoverMotion | 'still';
export const isProAnimation: (id: string) => boolean;
export function coverChoiceNeedsPro(c: CoverDesignChoice): boolean;
export function coverPlay(p: {
  animation: string;
  colour: string | null;
  motion: CoverMotion | null;
  plan: PagePlan | undefined;
}): CoverPlay;
export type ResolvedCover =
  | { kind: 'photo'; path: string }
  | { kind: 'design'; design: string; colour?: string }
  | { kind: 'animated'; animation: string; colour?: string; play: CoverPlay };
export function resolveCover(p: {
  handle: string;
  coverPath: string | null;
  coverDesign: string | null;
  coverColour: string | null;
  coverAnimation?: string | null;
  coverMotion?: string | null;
  plan?: string;
}): ResolvedCover;
// coverDesignChoiceSchema: + animation?: string | null (max 40), motion?: 'once' | 'loop'
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('six animations: drift, rise and ripple are Free; pulse, night and sun are Pro', ...);
  //   ids in order; pro flags; every name is unique
  test('automatic covers never animate', ...);
  //   2,400 handles through resolveCover with no choice: no result has kind 'animated'
  test('photo beats animation beats design', ...);
  //   coverPath -> photo; coverAnimation 'drift' plus coverDesign 'dark' -> animated 'drift'
  test('a Free animation on a Free page plays once, even with a saved loop', ...);
  //   play === 'once'
  test('a Pro page plays its saved motion, and once with no setting', ...);
  //   loop -> 'loop'; null -> 'once'
  test('leaving Pro shows the still frame and keeps the choice', ...);
  //   night + loop + plan 'free' -> { kind: 'animated', animation: 'night', play: 'still' }
  //   drift + colour 'ocean' + plan 'free' -> play 'still', colour 'ocean'
  //   plan undefined behaves as Free
  test('an animation the catalogue no longer holds falls back to the design, then automatic', ...);
  test('coverChoiceNeedsPro: Pro animation, loop, or a colour on an animation', ...);
  //   drift alone false; drift + once false; pulse true; drift + loop true; drift + violet true;
  //   a still design with a colour false
  test('the choice schema refuses a design and an animation together, a motion without an animation, and unknown ids', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm --filter @tipme/contracts build && node --test packages/contracts/test/covers.test.mjs
  ```

  Expected: FAIL (`COVER_ANIMATIONS` is not exported).

- [ ] **Step 3: Implement** in `covers.ts`. Keep existing results for every input without `coverAnimation`; the existing pinned tests must still pass. Add the error code.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck && pnpm --filter @tipme/contracts lint
  ```

- [ ] **Step 5: Commit.** `feat(contracts): animated cover catalogue, Pro check and still fallback`

### Task 3: Database — columns and the server lock

**Files:**

- Modify:
  - `packages/database/src/schema.ts` (`coverAnimation`, `coverMotion`, and the check);
  - the new migration `packages/database/drizzle/0071_cover_animation.sql`, with its snapshot and journal;
  - `packages/database/src/operations/covers.ts` (`setCoverDesign`);
  - `packages/database/src/operations/profiles.ts`: `toMine`, the public profile, and account deletion (clear both new columns beside `coverDesign: null`, near line 793);
  - `packages/database/src/operations/errors.ts`.
- Test:
  - `packages/database/test/integration/cover-animation.test.mjs` (new);
  - `packages/database/test/integration/migration-journal.test.mjs` (existing, must pass).

**Interfaces:**

- Consumes: Task 2.
- Produces: `setCoverDesign(db, userId, choice)`. It is unchanged in signature. It writes `cover_design`, `cover_colour`, `cover_animation` and `cover_motion` together. It throws `OperationError('COVER_DESIGN_PRO_REQUIRED')` when `coverChoiceNeedsPro(choice)` and the page is not Pro, checked before the write and again in the `WHERE`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a Free page saving a Pro animation, a loop or a colour is refused and nothing changes', ...);
  //   each throws COVER_DESIGN_PRO_REQUIRED; the row's four cover columns and xmin are unchanged
  test('a Free page saves drift with no motion; coverChoice shows it and cover plays once', ...);
  test('a Pro page saves night, ocean and loop; choosing a still design clears the animation', ...);
  test('the plan dropping between read and write refuses the save', ...);
  //   SET plan='free' from a second connection inside a beforeUpdate hook or a held row lock;
  //   expect the throw and no write
  test('saving the same Pro choice again is unchanged, not refused', ...);
  //   changed === false
  test('deleting the account clears the animation and motion', ...);
  test('cover_motion accepts only once and loop', ...);
  //   a raw UPDATE ... 'bounce' violates the check constraint
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/cover-animation.test.mjs
  ```

  Expected: FAIL (the column does not exist).

- [ ] **Step 3: Implement.** Add the schema and run `pnpm --filter @tipme/database generate`. Then write `setCoverDesign`:
  - pre-check the plan;
  - `UPDATE ... WHERE id AND (plan = 'pro' if needed) AND (any of the four IS DISTINCT FROM)`;
  - on zero rows when Pro is needed, re-read the plan and throw if it is not Pro.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/cover-animation.test.mjs packages/database/test/integration/migration-journal.test.mjs && pnpm --filter @tipme/database typecheck && pnpm --filter @tipme/database lint
  ```

- [ ] **Step 5: Commit.** `feat(database): store a cover animation and motion, Pro-locked on the server`

### Task 4: API — the error, and the lock and fallback at API level

**Files:**

- Modify:
  - `apps/api/src/http/api-exception.filter.ts` (message and `{ status: 403, code: 'COVER_DESIGN_PRO_REQUIRED' }`);
  - the OpenAPI output, via `pnpm api:openapi`.
  - The controller is unchanged: `coverDesignChoiceSchema` already carries the new fields.
- Test: `tests/integration/cover-api.test.mjs`. Add a `setPlan(profileId, plan)` helper that updates the plan with `database.pool`, then calls the revalidator the way `qr-art-api.test.mjs` uses ops.

**Interfaces:**

- Consumes: Tasks 2 and 3.
- Produces: `PUT /v1/me/cover-design` accepts `{ design: null, animation, colour?, motion? }`. `GET /v1/profiles/:handle` and `GET /v1/me/profile` return `cover.kind === 'animated'` with `play`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a Free page cannot save a Pro animation, a slow loop or an animated colour (403 COVER_DESIGN_PRO_REQUIRED)', ...);
  //   status 403; error.code; public cover unchanged
  test('a Free page saves Drifting and its public cover plays once', ...);
  //   200; publicPage().cover deep-equals { kind: 'animated', animation: 'drift', play: 'once' }
  test('a Pro page saves Night sky on a slow loop in Ocean', ...);
  //   play 'loop', colour 'ocean'; coverChoice.motion 'loop'
  test('leaving Pro shows the still frame; returning restores the loop', ...);
  //   free -> play 'still'; pro -> play 'loop'; DB columns untouched throughout
  test('an animated choice refreshes the public page; a refused one does not', ...);
  //   revalidations contain the handle once
  test('an automatic cover is never animated', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/cover-api.test.mjs
  ```

  Expected: FAIL (the new tests get a 500 for the unmapped error, or the wrong `cover`).

- [ ] **Step 3: Implement** the filter entries, then regenerate the OpenAPI.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/cover-api.test.mjs tests/integration/qr-art-api.test.mjs tests/integration/openapi.test.mjs && pnpm api:openapi && pnpm --filter @tipme/api typecheck && pnpm --filter @tipme/api lint
  ```

- [ ] **Step 5: Commit.** `feat(api): Pro lock and still fallback for animated covers`

### Task 5: Web — draw an animated cover

**Files:**

- Modify:
  - `apps/web/src/lib/cover-view.ts`: `AnimatedView`, and `ANIMATED_LAYERS`, the five layers' x, bottom, size and delay from the board;
  - `apps/web/src/components/profile/cover.tsx`: the `animate` prop, and the `animated` kind;
  - `apps/web/src/app/globals.css`: the `.cover-fx` keyframes, `[data-cover-play]`, the paused states, reduced motion, forced colours and print;
  - `apps/web/src/app/people/[handle]/page.tsx`: pass `animate`;
  - `packages/ui/src/tokens.css`: `--duration-cover-once: 2800ms` and `--duration-cover-loop: 8000ms`.
- Test:
  - `apps/web/test/cover-component.test.mjs`;
  - `apps/web/test/cover-view.test.mjs` (new, or the existing view test if one is present).

**Interfaces:**

- Consumes: Task 2.
- Produces:
  - `ProfileCover({ cover, priority?, sizes?, animate?: boolean })`;
  - the markup `<div class="profile-cover" data-profile-cover="animated:<id>" data-cover-play="once|loop|still">` holding five `span.cover-fx.cover-fx--<id>`;
  - `animate={false}` or `play: 'still'` renders `data-cover-play="still"`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('an animated cover renders five decorative layers in the server HTML', ...);
  //   5 x .cover-fx; aria-hidden; no <script>; base colour in the style
  test('play once, loop and still are carried to the markup', ...);
  test('without animate, an animated cover renders still (thumbnails, stamps, staff screens)', ...);
  test('a Pro colour replaces the palette; no colour uses the palette', ...);
  //   ocean base #1d4e89, hearts #3a79c2
  test('an unknown cover kind draws the automatic cover', ...);
  test('the stylesheet animates only transform and opacity, and stills cover-fx under reduced motion, forced colours and print', ...);
  //   parse the .cover-fx keyframes in globals.css: properties are a subset of {transform, opacity};
  //   the reduce, forced-colors and print blocks set animation: none
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  node --test apps/web/test/cover-component.test.mjs apps/web/test/cover-view.test.mjs
  ```

- [ ] **Step 3: Implement.**
  - Layers keep the settled frame as their own style.
  - Keyframes run `from` an offset only.
  - `[data-cover-play="once"] .cover-fx` uses the once duration with 1 iteration.
  - `[data-cover-play="loop"] .cover-fx` uses the loop duration, `infinite alternate`.
  - `[data-cover-play="still"] .cover-fx { animation: none }`.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  node --test apps/web/test/cover-component.test.mjs apps/web/test/cover-view.test.mjs apps/web/test/cover-choice.test.mjs && pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint
  ```

- [ ] **Step 5: Commit.** `feat(web): draw animated covers with CSS transform and opacity`

### Task 6: Web — freeze rules and reduced motion, end to end

**Files:**

- Create:
  - `apps/web/src/components/profile/cover-freeze.tsx`: a client component, rendered after `ProfileCover` on `/@handle`, only when `play !== 'still'`;
  - `tests/e2e/animated-cover.spec.ts`.
- Modify:
  - `apps/web/src/app/people/[handle]/page.tsx`;
  - `globals.css`: `[data-cover-frozen] .cover-fx`, `[data-cover-offscreen] .cover-fx`, and the `:has()` fallback.
  - The e2e fixtures (`tests/e2e/profile-fixtures.ts`, or seeding through the API in the spec) give one Free page `drift` and one Pro page `night` on a loop.

**Interfaces:**

- Produces: `CoverFreeze({ coverSelector?: string })`. It sets `data-cover-frozen` (latched) and toggles `data-cover-offscreen`. It removes its listeners and observer on unmount.

- [ ] **Step 1: Write the failing tests.** Every test calls `emulateMedia({ reducedMotion: 'no-preference' })` unless it says otherwise.

  ```ts
  test('a Free animated cover plays once and settles', ...);
  //   cover.getAnimations() has 5 running; after 3.6s all are 'finished'
  test('a Pro slow loop keeps running', ...);
  //   after 4s, some animation playState is 'running' and iterations is Infinity
  test('focusing the tip form freezes the cover, and it stays frozen', ...);
  //   focus the ₦2,000 key -> data-cover-frozen; every animation 'paused';
  //   blur and wait 1s -> still paused, and currentTime unchanged
  test('typing an amount, or tapping Tip, freezes it too', ...);
  test('scrolling the cover off screen pauses it; scrolling back resumes a loop', ...);
  test('reduced motion shows the still frame with no animations', ...);
  //   reducedMotion 'reduce'; getAnimations().length === 0;
  //   each .cover-fx computed transform equals its value under 'no-preference' after finish
  test('forced colours show the still frame', ...);
  //   emulateMedia({ forcedColors: 'active' }); zero animations
  test('a page that left Pro shows the still frame', ...);
  //   data-cover-play="still"; zero animations
  test('nothing is written on the cover', ...);
  //   no text or focusable element inside .profile-cover
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm test:e2e -- tests/e2e/animated-cover.spec.ts
  ```

- [ ] **Step 3: Implement.**
  - Listen on the panel with `{ once: true }` per event type.
  - Observe `[data-tip-panel] form[data-submitting]` with a `MutationObserver`, attribute-filtered.
  - Use one `IntersectionObserver`.
  - Never set `will-change`.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm test:e2e -- tests/e2e/animated-cover.spec.ts tests/e2e/profile-page.spec.ts tests/e2e/automatic-cover.spec.ts tests/e2e/tip-card.spec.ts
  ```

  Run on desktop and mobile projects.

- [ ] **Step 5: Commit.** `feat(web): freeze animated covers on tipping and off screen`

### Task 7: Web — the cover chooser in Settings

**Files:**

- Modify:
  - `apps/web/src/lib/cover-choice.ts`: `CoverDraft` gains `animation: string | null` and `motion: CoverMotion`, and `choiceBody`, `draftFromChoice`, `draftPreview` and `sameDraft` cover them;
  - `apps/web/src/components/account/cover-settings.tsx`:
    - an "Animated covers" radiogroup;
    - a "Pro" text tag on locked choices;
    - the colour group shown for animations on Pro only;
    - the "How it plays" control ("Plays once" and "Slow loop", the latter `aria-disabled` on Free);
    - the board's hint lines in a polite live region;
    - the preview animates with `animate` and replays on selection;
  - the Settings page's data, which needs `plan` (already on `MyProfile`).
- Test:
  - `apps/web/test/cover-choice.test.mjs`;
  - `tests/e2e/cover-settings.spec.ts`.

**Interfaces:**

- Consumes: Tasks 2, 4 and 5.
- Produces: `choiceBody(draft)`:
  - an animation gives `{ design: null, animation, motion? , colour? }`, sending `motion` and `colour` only when the page is Pro;
  - a still design gives `{ design, colour? }`, as before.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('choiceBody for a Free animation sends no motion and no colour', ...);
  test('choiceBody for a Pro animation sends its motion and colour', ...);
  test('draftFromChoice opens an unknown animation as nothing chosen', ...);
  test('sameDraft treats a motion change as a change', ...);
  ```

  ```ts
  test('Free sees Drifting, Rising and Ripple, and Pro designs marked "Pro"', ...);
  //   choosing Pulse shows "Pulse comes with Pro. Free includes Drifting, Rising and Ripple." and selects nothing
  test('Free: Slow loop is aria-disabled and explains itself', ...);
  //   "Slow loop comes with Pro. On Free, animated covers play once when your page opens."
  test('Free saves Drifting; the public page plays it once', ...);
  test('Pro chooses Night sky, Ocean and Slow loop; the public page loops', ...);
  test('a refused save (the plan dropped) says so and keeps the saved cover', ...);
  //   message "This cover choice is part of TipMe Pro."
  test('the chooser fits 320px and 360px with no overflow, and every control is at least 44px', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  node --test apps/web/test/cover-choice.test.mjs && pnpm test:e2e -- tests/e2e/cover-settings.spec.ts
  ```

- [ ] **Step 3: Implement,** following the board's layout and wording. Hover and focus change nothing, and selecting crossfades the preview in 240ms (§7.6).
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  node --test apps/web/test/cover-choice.test.mjs && pnpm test:e2e -- tests/e2e/cover-settings.spec.ts tests/e2e/pro-page.spec.ts && pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint
  ```

- [ ] **Step 5: Commit.** `feat(web): choose an animated cover and how it plays in Settings`

### Task 8: Performance gate, full checks and handoff

**Files:**

- Modify:
  - `tests/e2e-perf/lcp.spec.ts`:
    - add `test.use({ reducedMotion: 'no-preference' })`;
    - before sampling, set Tobi's plan to Pro in the test database (through `packages/database/dist`, as the spec already does for `grantOwner`), then `PUT /v1/me/cover-design` `{ design: null, animation: 'night', motion: 'loop' }` as Tobi;
    - assert the result.
  - `docs/agent/ACTIVE_TASK.md` and `docs/agent/HANDOFF.md`.
- Test: `tests/e2e-perf/lcp.spec.ts`.

**Interfaces:** none new.

- [ ] **Step 1: Write the failing assertion.**

  ```ts
  expect(
    await page.locator('.profile-cover').getAttribute('data-cover-play'),
  ).toBe('loop');
  for (const ms of profile) expect(ms, `/@tobi LCP ${ms}ms`).toBeLessThan(2000);
  ```

- [ ] **Step 2: Run, expecting FAIL** before Tasks 3–6 are merged into the branch, because `data-cover-play` is missing. Once they are in, record the samples.

  ```bash
  pnpm test:e2e && pnpm perf:lab
  ```

- [ ] **Step 3: Implement.** If any sample is 2000ms or more:
  - remove the stagger first, then the loop's opacity;
  - never move the name or cover later;
  - record the figures before and after.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm perf:lab
  ```

  Copy the `LCP_RESULTS` line into `HANDOFF.md`.

- [ ] **Step 5: Commit.** `test(perf): hold profile LCP under 2000ms with a looping cover`

### Pull request

- **One PR,** `feat/animated-covers` into `dev`, titled "Animated covers: three Free, more on Pro with a slow loop".
- **Body:**
  - the owner's decision and dates;
  - the Free/Pro table;
  - the Pro lock and the fallback;
  - the freeze rules;
  - reduced motion and forced colours;
  - the `LCP_RESULTS` line;
  - every command run, with pass, fail or skipped;
  - migration `0071` (additive, nullable, with no backfill).
- End the body with:

  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
