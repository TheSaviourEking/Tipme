# Public boards: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build what is missing or different on seven owner-approved boards for the public and first-day surfaces:

1. **App icons:** home-screen icons and a web app manifest named "TipMe" (the tab icon stays as it is).
2. **Share cards:** the general link preview in the new materials, and a new card per person for `/@handle` links.
3. **Coming soon:** `/coming-soon` restyled, and its date line written from the real launch time.
4. **QR studio:** the code on a raised paper panel, the Pro message beside the Upgrade panel, designs in three groups, the card lettered in Manrope.
5. **QR printing:** the restyle, the link printed once, format choices as paper pictures, cut lines, and no dashboard notices on paper.
6. **Sign-up celebration:** "@ada is yours." once, at the claim, for everyone (including people who skip setup).
7. **The keepsake:** the done step's tick becomes a keepsake card, also on Home for 7 days.
8. **Tip form:** `/@handle`'s form restyled in the Tipper's journey materials, then the board's two small proposals.
9. **The stamp sound** for the claim moment, held for the owner (see Q5).

**Owner's approval:** the caller states all seven boards are owner-approved (5 Nov 2026). This is a product and visual decision. It is not a legal, regulatory or payment-partner approval, and no D-item in `docs/00-DECISIONS.md` changes. Nothing here changes fees, the minimum, the quote, checkout, the ledger or payouts.

**Boards (static HTML, read as specs),** in the session scratchpad `canvas-email/project/`: `AppIcons.dc.html`, `ShareCards.dc.html`, `ComingSoon.dc.html`, `QrStudio.dc.html`, `QrPrint.dc.html`, `SignUpCelebration.dc.html`, `TipForm.dc.html`. Context: `DesignMap.dc.html` (checked against `d0325dd`), `ScreenAudit.dc.html`, `FeedbackMoments.dc.html`. Each PR's first task copies its boards unchanged into `docs/design/redesign/boards/` and adds them to `docs/design/redesign/README.md`, as the states and make-it-yours plans did.

**Rule when a board and dev differ:** dev wins for behaviour, the board wins for the approved look. Every place this plan chose is marked **Ruling**.

**Architecture:**

- Front end almost everywhere. The only server change is PR 7: one nullable column, `profiles.welcomed_at`, a route that sets it once, and two optional fields on `MyProfile`.
- Link previews and icons are drawn with Next's built-in `next/og` (`ImageResponse`), as the two share cards are today. No new runtime dependency. Satori cannot read WOFF2, so PR 2 adds static TTF copies of the two fonts already in the repo (SIL OFL 1.1).
- The tip form restyle (PR 8) is CSS only, scoped to `.profile-composer`. `appreciation-form.tsx` does not change in PR 8, so the pay path cannot change.
- Shapes live in `packages/contracts`. New fields are optional, because the web deploys before the API.

**Tech stack:** Next.js 16.4.2 App Router (`cacheComponents: true`), React 19.3, `@tipme/ui`, Drizzle/Postgres and NestJS (PR 7 only), Playwright 1.64, `node --test`.

---

## What the code does today (origin/dev `931a545`, migrations 0070 to 0077)

**Tip form (`/@handle`):**

- `apps/web/src/app/people/[handle]/page.tsx:95-131` draws the `aside.profile-composer.tip-instrument` with `TippingOpensSoon`, `TipsNotReady` or `AppreciationForm`. Both "closed" states already match the board ("kept as it is").
- `apps/web/src/components/appreciation-form.tsx`:
  - the **only pay path** is `location.assign(result.data.checkoutUrl)` at `:274`, inside `if (result.ok)` at `:259`;
  - `:237-246` refuses to start (charges nothing) when the quote's `tipMinor` or `payerTotalMinor` differs from the amount on the key;
  - `:247` keeps one `draftKey` per draft, so a retry or double tap replays the same tip;
  - `:229` disables the form while it starts; the key reads "Starting your tip…" (`:694-698`);
  - below the minimum, the key reads "Tip" and pressing it shows the message at `:202-209`. Nothing starts.
  - "Not sent yet" is a `Notice` at `:673-677`. **States PR B** (being built on `feat/states-b`) turns it into a `Slip` rendered _after_ `TipAction`, adds the "below 2,000" flag and the suggested key, and changes the selector at `:306`.
- The two lines under the key are `formPartner` (`payment-mode-copy.ts:47`, "Our payment partner handles this. You’ll confirm on its page.") and `formTrust` (`:46`, "No account needed. You pay exactly this amount."). Test mode uses its own partner line (`:73`).
- Look: `globals.css:1701-1980` (`.tip-instrument`) and `:2508-2615`, `:2780-2895` (`.profile-composer`, phone Tip bar). The panel is already 25.5rem (408px) wide (`:2021`) and rides 12.25rem up the cover (`:2515`), as the board draws. What differs from the board is the materials: keys are a recessed gradient (`:1831-1851`), not raised paper; fields are plain `.tm-input` (`:1853`), not recessed wells; the heading is Manrope 700 (`:2553`), not DM Serif; the drawer uses a "+" circle (`:1883`), not a ruled row with a chevron; the Tip key is 3.25rem (`:2591`), not 56px.
- `KEY_ROOM_PX` in `apps/web/src/lib/tip-amounts.ts` is tied to the panel's inner width. PR 8 keeps the padding (1.375rem), so it holds.
- **Make-it-yours PR B** (`feat/miy-start-amount`, migration 0078) changes `tip-amounts.ts` and the starting key. **Make-it-yours PR D** (not started) will tint the selected key with `--page-accent`.

**Share cards:**

- `apps/web/src/app/opengraph-image.tsx`: white, Arial-like type, the wordmark, a purple bar. Prerendered.
- `apps/web/src/lib/metadata.ts:24-50`: `previewMetadata` always points `og:image` and `twitter:image` at `/opengraph-image`, on every page including `/@handle` (`people/[handle]/page.tsx:37-49`).
- `tests/e2e/quality.spec.ts:169-187` asserts `/@ada` advertises `/opengraph-image` with the alt "TipMe. A little thanks goes a long way."
- Fonts: `apps/web/src/fonts/DMSerifDisplay-Latin.woff2` and `Manrope-Latin.woff2` (variable). Satori reads TTF, OTF and WOFF, not WOFF2.

**Icons:** only `apps/web/src/app/icon.svg` (purple `#7A32F9` tile, corner 28 of 120, the white heart). No `apple-icon`, no manifest. `production-launch.ts:84-94` and `preview-gate.ts:11` list the files open before launch and behind the preview password: `icon.svg` is there, nothing else.

**Coming soon:**

- `apps/web/src/app/coming-soon/page.tsx`: copy at `:28-35`; the clock counts to `PRODUCTION_LAUNCH_AT` (`:19-21`); the date line is `LAGOS_LAUNCH_LABEL`, fixed text "27 October 2026 · 00:00 WAT" (`lib/countdown.ts:2`), with `dateTime={LAGOS_LAUNCH_TARGET}`.
- `coming-soon/opengraph-image.tsx:46` has its own fixed "27 October · 00:00 WAT".
- `tests/e2e/countdown.spec.ts:23-26` asserts the fixed label even though the run sets another launch time: the test encodes the bug.
- Look: `globals.css:7062-7140` and the `.launch-countdown` rules.

**QR studio (`/dashboard/qr`, `qr-studio.tsx`):** the code sits straight on the page (`:225-284`); the status line (`:381-383`) sits under both lists, so on a phone the "Pro design" message is out of sight; the 30 designs are one fieldset "Designs" (`:340-373`); the API sends `kind` per design (17 `style`, 12 `card`, 1 `photo`, `apps/api/src/qr/catalogue.ts`); the card is drawn in Arial (`lib/qr-card.ts`).

**QR print (`/dashboard/qr/print`, `print-view.tsx`):** the Free card prints the link twice (inside the canvas, and `:131`); formats are a text list (`:79-96`); print CSS hides `.site-header`, `.site-footer`, `.dashboard-bar` and `.print-hide` (`globals.css:6290-6297`) but not the pilot notice, the paused-page notice or "Needs your attention" (`dashboard-shell.tsx:147-189`).

**Sign-up:** `sign-up-flow.tsx:45-48`: `HandleClaim` calls `onClaimed` after `POST /v1/me/page` succeeds (`handle-claim.tsx:63-70`), then `router.replace('/dashboard/welcome')`. `welcome-view.tsx:179-217` is the hello step ("I’ll do this later" goes to `/dashboard` at `:212`); `:219-269` is the done step with the ✓ (`.welcome-moment`, `globals.css:4556-4580`). At claim time `displayName` equals the handle (`welcome-view.tsx:84`), so the person's name is not known yet. `MyProfile` (`packages/contracts/src/profiles.ts:62-126`) has no created date. There is no sound or vibration in the web app except `public/sounds/new-tip.wav`, generated by `scripts/make-tip-sound.mjs` (live updates PR 1), behind the `tipSound` preference.

**Tests that every PR keeps green:** `apps/web/test/no-provider-names.test.mjs`, `tests/e2e/quality.spec.ts` (axe, headers), `tests/e2e/profile.visual.spec.ts` (baselines change only where a PR says so).

---

## Design

### PR 1: App icons

- A single heart: `apps/web/src/components/brand.tsx` exports `HEART_MARK` (the path `d` and transform from `icon.svg`). A unit test fails if `icon.svg` and `HEART_MARK` drift.
- `app/apple-icon.tsx`: 180 × 180, full-bleed purple (iOS rounds it), the heart, a soft top light and a darker lower edge drawn as gradients.
- `app/icons/[file]/route.tsx`, two files from `generateStaticParams`: `192.png` (rounded tile, transparent corners, purpose `any`) and `512-maskable.png` (full bleed, the heart inside the centre 80% circle, purpose `maskable`). Static: no request APIs, so it prerenders.
- `app/manifest.ts` → `/manifest.webmanifest`: `name` and `short_name` "TipMe", `start_url` "/", `display` "browser", `theme_color` "#7A32F9", `background_color` "#FFFFFF", the two icons. **Ruling:** `display: 'browser'` because the board says the manifest "adds no offline or app features", and it keeps the address bar on the payment partner's page (Q9).
- The tab icon stays the flat `icon.svg`.
- Both gates open the new files: `production-launch.ts` and `preview-gate.ts` gain exact paths (`/apple-icon` as Next serves it, `/manifest.webmanifest`, `/icons/192.png`, `/icons/512-maskable.png`). Read the real `apple-icon` URL from the built HTML before writing the rule.

### PR 2: Share cards

- **Fonts:** `apps/web/src/fonts/og/DMSerifDisplay-Regular.ttf` (google/fonts `ofl/dmserifdisplay`) and `Manrope-SemiBold.ttf`, `Manrope-Bold.ttf` (static instances from the Manrope upstream, `sharanda/manrope`), each with its OFL file, pinned by commit in `docs/third-party-component-register.md`. Subset to Latin, Latin Extended and U+1EA0–1EF9 (Ọ, Ẹ and other Yoruba letters) if `pyftsubset` is at hand (`uvx --from fonttools pyftsubset`); otherwise commit them whole and record the sizes. Loaded with `readFile(new URL('../fonts/og/…', import.meta.url))` so the build traces them. Verify with `next start`, not only `next dev`.
- **`apps/web/src/lib/share-card.tsx`:**

  ```ts
  export interface PersonCardInput {
    name: string;
    role: string | null;
    handle: string;
    band: string;
    face: string;
  }
  /** Only what the public page shows: never phone, email, photo, tips, totals or balance. */
  export function personCardInput(p: PublicProfile): PersonCardInput;
  /** The cover's colour (COVER_COLOURS base and tone); a photo or colourless cover uses TipMe purple. */
  export function shareCardColours(cover: ResolvedCover | undefined): {
    band: string;
    face: string;
  };
  export function GeneralCard(): JSX.Element; // headline, line, purple key with the heart
  export function PersonCard(
    p: PersonCardInput & { host: string },
  ): JSX.Element;
  export function ogFonts(): Promise<ImageResponseOptions['fonts']>;
  ```

- **General card** (`app/opengraph-image.tsx`): the same words ("A little thanks / goes a long way." and "For the people who make a difference."), the paper ground `#f3f2ee`, the headline in DM Serif, and the purple key with the heart (board `.og-new`). Still prerendered and request-independent.
- **Person card:** a route handler, `app/people/[handle]/share-card/route.tsx` → `/people/ada/share-card` (PNG, 1200 × 630). **Ruling:** a route handler, not a nested `opengraph-image.tsx`, so the URL is fixed and nothing injects itself into the page's metadata. It reads `getPublicProfile(handle)` (already cached and tagged, so a profile change shows on the next fetch). On `null`, `{ movedTo }`, an invalid handle or a thrown lookup it answers the **general card** with 200, so the route reveals nothing a page does not. The general card's bytes are rendered once per process and reused.
  - Layout (board `.og-person`): the cover band in the cover colour, a face circle with initials, the name in DM Serif, the role in Manrope 600, and a foot with `host/@handle` and the black key with the heart. Names over two lines are cut with an ellipsis. **Ruling:** no photo is drawn (board; Q7).
- **Metadata:** `previewMetadata(title, description, path, image?: { url: string; alt: string })`. `/@handle` passes `{ url: '/people/<handle>/share-card', alt: '<displayName> on TipMe' }` for a live, unmoved page. Unavailable and moved pages keep today's metadata, so they keep the general card. The title and description are unchanged (`page.tsx:42-47`, " Test mode." suffix included).
- Before launch the gate rewrites the person card like the page itself (no exemption): profiles are not public yet.

### PR 3: Coming soon

- `lib/countdown.ts` gains `launchLabel(target: number): string` ("27 October 2026 · 00:00 WAT") and `launchShortLabel(target: number): string` ("27 October · 00:00 WAT"), both in `Africa/Lagos`, plus `launchIso(target): string`. `LAGOS_LAUNCH_LABEL` goes; a test pins `launchLabel(Date.parse(LAGOS_LAUNCH_TARGET))` to today's text.
- `coming-soon/page.tsx` uses them for the `<time>` line. `coming-soon/opengraph-image.tsx` reads `PRODUCTION_LAUNCH_AT` the same way, which makes it request-time (`await connection()`); check the build output marks it dynamic.
- Restyle (CSS): the four tiles become pressed keys in a recessed well, Seconds stays the purple one, two by two on a phone; the headline moves to DM Serif; the eyebrow loses `text-transform: uppercase`; header and footer stay hidden; "––" before the clock starts, the once-a-minute announcement and the reload at zero are unchanged.
- The ring and dot (`.coming-soon::before/::after`) become a small paper card, `aria-hidden="true"`, with "Your page", `<host>/@yourname` (host from `siteOrigin`) and "Tip" (board's proposed addition; Q11).
- **Every line of copy stays.** "TipMe opens at midnight in Lagos." is not derived (Q10).

### PR 4: QR studio

- The free card canvas and the design plate sit in one `Surface material="paper"` panel (`.qr-studio__panel`).
- The status line `<p role="status" className="settings-saved">` moves to directly after the locked panel's slot (before the style lists), at every width, and stays mounted always. **Ruling:** one DOM order for all widths, not CSS `order`, so focus order and reading order match.
- Designs: three fieldsets in the API's order, "Patterns" (`kind: 'style'`), "Cards" (`'card'`), "Photo" (`'photo'`). An unknown `kind` from a newer API goes to Patterns. All radios keep one `name`, so arrow keys still move through every design.
- `drawQrCard` letters the card in Manrope: it takes `fontFamily`, resolved from the `--font-manrope` custom property, waits for `document.fonts.load('700 1em <family>')`, and falls back to Arial when that fails. Free share images and the Free print card change look; Pro designs (server pictures) do not.
- Labels, links, the preview rules ("doesn’t lead to your page yet") and the actions are unchanged.

### PR 5: QR print

- The Free card's second link line (`print-view.tsx:131`) goes, on screen and on paper.
- The format radios become small paper pictures: each label gains an `aria-hidden` `.qr-pick__art[data-format]` mini drawing in CSS; the visible name and size text stay, so the label is unchanged for screen readers.
- Cut lines: in print, the receipt slip (max 17rem) and the phone lock screen (max 15rem) get a dashed `0.3mm` outline a few millimetres outside the format. On screen, the same outline shows faintly in the preview.
- In print, the pilot notice, the paused-page notice and "Needs your attention" are hidden: `@media print { body:has(.print-card) .dashboard-page :is(.owner-attention, .pilot-notice, .tm-notice, .tm-slip, .tm-warning):not(.print-card *) { display: none !important } }`. It names the states classes too, so it holds before and after states PR D.
- Restyle: the page in the paper and key materials of the board; the Print key black, Back secondary.

### PR 6: The claim moment

- **Trigger, once:** `HandleClaim`'s success calls `markClaimed(handle)` (sessionStorage, one key, the handle only) before `router.replace('/dashboard/welcome')`. `WelcomeView` calls `takeClaimed(handle)` on mount, which reads and deletes it. A reload, another tab or another device finds nothing, so the moment never replays and needs no "seen" record (board). Without storage there is simply no moment.
- **`apps/web/src/lib/claim-moment.ts`:**

  ```ts
  export const CLAIM_MOMENT_MS = 1600;
  export function markClaimed(
    handle: string,
    storage?: Pick<Storage, 'setItem'>,
  ): void; // never throws
  export function takeClaimed(
    handle: string,
    storage?: Pick<Storage, 'getItem' | 'removeItem'>,
  ): boolean; // never throws
  /** Vibrate about 30 ms where the device allows it; never on reduced motion. */
  export function claimBuzz(
    nav: Pick<Navigator, 'vibrate'> | undefined,
    reducedMotion: boolean,
  ): void;
  ```

- **`apps/web/src/components/account/claim-moment.tsx`:** an overlay above the hello step (which is already rendered underneath). The page card (initial, the handle as the name, `host/@handle`, the three standard keys and "Tip ₦2,000", all `aria-hidden`) falls in, lands, the stamp "@ada · YOURS" presses down, six to eight hearts rise once in TipMe purple (the board's "purple until they pick one"; a new page has picked nothing), and "@ada is yours." fades in. At 1.6 s, or on any tap, any key, "Continue" or Escape, it hands over; focus then goes to the hello heading.
- **Copy:** heading "@{handle} is yours."; under it "Welcome to TipMe. People can start thanking you the moment your page is online." **Ruling:** no name, because none is known at claim time (Q4); the board's "Welcome to TipMe, Ada." assumed one. Screen readers: focus on the heading and a polite "Your handle @{handle} is claimed. Welcome to TipMe."; the card, stamp and hearts are hidden from them.
- **Reduced motion:** the still scene (card on the table, stamp in place, three hearts beside it), no vibration, the same hand-over.
- **No sound in this PR** (PR 9, Q5). **No confetti** (FeedbackMoments).
- The success styling follows a server-confirmed outcome (the claim's 2xx), as the constitution requires.

### PR 7: The keepsake

- **Storage:** `profiles.welcomed_at timestamptz NULL`. Migration: the next free number at write time (dev is at 0077; `feat/miy-start-amount` claims 0078).
- **Operation:** `markWelcomed(db, userId): Promise<MyProfile>` runs `UPDATE profiles SET welcomed_at = now() WHERE user_id = $1 AND welcomed_at IS NULL`, then returns `toMine`. Idempotent: the first date wins.
- **API:** `POST /v1/me/welcomed` (session and CSRF, as other `/v1/me` writes) → `MyProfile`.
- **Contracts:** `MyProfile.memberSince?: string` (ISO `profiles.created_at`) and `MyProfile.welcomedAt?: string | null`. Undefined means an older API.
- **`apps/web/src/lib/keepsake.ts`:**

  ```ts
  export const KEEPSAKE_DAYS = 7;
  /** "5 November 2026", in Lagos time. */
  export function memberSinceLabel(iso: string): string;
  /** Older API (undefined) never; never shown (null) yes; otherwise within 7 days of the first showing. */
  export function keepsakeOnHome(
    p: Pick<MyProfile, 'welcomedAt' | 'memberSince'>,
    now: number,
  ): boolean;
  ```

- **Done step:** the ✓ circle becomes `KeepsakeCard` (TipMe wordmark, `@handle`, "Member since {date}", "Save card"). It settles in with today's `welcome-settle`; nothing bursts. Showing it calls `POST /v1/me/welcomed` once.
- **Home:** `dashboard-home__side` shows the same card while `keepsakeOnHome` is true, and posts `welcomed` the first time it shows. So someone who skipped setup still gets it, for 7 days from the first time they see it. **Ruling:** the board's recommended server date, not browser storage (Q6).
- **"Save card"** draws the card on a canvas (DM Serif and Manrope via `document.fonts`, Arial fallback) and downloads `tipme-<handle>-keepsake.png`. Nothing is uploaded.
- The hello step, its checklist, the done step's link card and its three buttons are unchanged.

### PR 8: Tip form restyle (CSS only)

All rules are scoped to `.profile-composer` (the public page). **Ruling:** the home page's demo form (test copies only) keeps today's look; it can follow later.

- **Panel:** the paper material (`linear-gradient(var(--edge-light), transparent 2px), var(--surface-raised)`), `--shadow-instrument`, radius 1.625rem, padding 1.375rem (unchanged, so `KEY_ROOM_PX` holds).
- **Heading** "Tip {name}": DM Serif 400, 2rem (1.625rem on phones), line height 1.05.
- **Amount keys:** raised paper (border `rgb(20 18 16 / 14%)`, the paper gradient, a small drop shadow), 3.25rem tall, radius 0.75rem, bold tabular figures. Selected: keep the fill from `@tipme/ui`'s `AmountChoice` (brand purple), add only the highlight `background-image` and the inner edge, and keep the white corner dot. **Do not set the selected key's `background-color` or `border-color` here:** make-it-yours PR D owns that through `--page-accent`.
- **Fields** (Other amount, reason, message, name): recessed wells (`--surface-recessed`, `--shadow-recessed`, radius 0.875rem, min height 3.125rem). The states field error (`.tm-input.tm-input[aria-invalid='true']`, specificity 0,3,0) must still win over these rules (0,2,0).
- **Checkboxes** (Add to the celebration, the note consent, Remember my tips): a 22px recessed box; checked is a purple key with a white tick. The native input stays, visually restyled with `appearance: none`, so keyboard and screen-reader behaviour is unchanged.
- **Drawer** "Add a message, reason or your name": a ruled row (top hairline, 44px target) with a chevron after the words, turned when open; the "+" circle goes.
- **Tip key:** 3.5rem, radius 0.875rem, black with the soft top light (board `.go`), on the panel and in the phone Tip bar.
- **The lines under the key:** centred, `--text-secondary`, unchanged words.
- Nothing about behaviour, order, limits, wording or the phone bar changes. The board's pink "Not sent" box is not built: states PR B's `Slip` is what dev shows (dev wins for behaviour).

### PR 9 (two tasks): The tip form's two proposals

- **Say the minimum while typing.** The board: "show the same message under the field as soon as the amount is below ₦2,000." Typing 2,000 passes through 2, 20 and 200, so a message on every keystroke would scold correct typing. **Ruling:** the same words show as the Other field's **hint** (`tm-hint`, tied by `aria-describedby`, not an alert, no red edge) after 700 ms without typing, or when the field loses focus. After pressing Tip, states PR B's red edge, flag and message apply as built. The Tip key still reads "Tip" below the minimum. Nothing starts. (Q1.)
- **One line under the Tip key (live mode only).** `formPartner` (live) becomes "You pay exactly this. You’ll confirm on our partner’s page." and `formTrust` becomes `null` in live. Test mode keeps its two lines; closed mode has none. Proof the line is true: the form starts nothing unless the quote's `tipMinor` and `payerTotalMinor` equal the key's amount (`appreciation-form.tsx:237-246`), and the provider event must match `payerTotalMinor` exactly or nothing is booked (`packages/database/src/operations/provider-events.ts:323-334`). It makes no claim about the partner's own page beyond "confirm". (Q2.)

### PR 10: The stamp sound (held for the owner)

- `scripts/make-stamp-sound.mjs` writes `apps/web/public/sounds/stamp.wav` (short, soft, authored by us, like `make-tip-sound.mjs`, so no licence and no register row).
- `claim-moment.ts` gains `playStamp({ enabled, audioSession })`: plays at 0.25 volume at 0.55 s, only in a visible tab, only where `navigator.audioSession` exists (set to `'ambient'` first, which keeps iOS silent on the silent switch); elsewhere on iOS it stays silent. `enabled` is the account's `tipSound` preference when loaded, otherwise its default.
- Ships only with the owner's yes to a sound we synthesise (Q5). Without it, PR 6 stands alone.

---

## Global Constraints

- **Workspace:** each PR is its own branch off `origin/dev` in its own worktree, per `.superpowers/program/builder-rules.md` (lanes, test databases, migrations, no push, no PR, no subagents). Never touch another worktree.
- **Read first:** `AGENTS.md`, `apps/web/AGENTS.md` (and `apps/api/AGENTS.md`, `packages/contracts/AGENTS.md` for PR 7), `docs/design/DESIGN-CONSTITUTION.md` with `REFERENCE-ANATOMY.md`, `RESPONSIVE-COMPOSITION.md`, `VISUAL-QUALITY-GATE.md`, `TOKENS-AND-MATERIALS.md`, `EXPERIENCE-AND-MOTION.md`, `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md` and `HANDOFF.md` (each PR updates both).
- **Money safety (PR 8 and PR 9):**
  - The only way to pay stays `location.assign(result.data.checkoutUrl)` after a successful intent. No new link, form action, `window.open` or href to a checkout appears anywhere. `apps/web/test/pay-path.test.mjs` (PR 8) fences this.
  - The mismatch guard (`:237-246`), the one `draftKey` per draft, the disabled form while starting, and the key naming the exact amount stay byte-identical. PR 8 does not edit `appreciation-form.tsx`.
  - No reassuring line is added unless the code proves it. The only money line this plan writes is PR 9's "You pay exactly this.", with its proof above. "You haven’t paid anything." belongs to states PR B and its `money-safety-lines.test.mjs`.
  - Pretend payments only. Never call `api.bachs.io`.
- **Privacy:**
  - Share cards draw only `displayName`, the public `role`, the handle and the cover colour. Never the photo, phone, email, bio, links, tips, totals, balance, supporter notes or names. Paused, offline, missing and moved pages get the general card. Nothing personal is logged.
  - The keepsake shows the person's own data on their own signed-in pages only. "Save card" is drawn in the browser and nothing is uploaded.
  - The claim marker holds the handle only, in this tab's session storage, and is deleted on first read.
  - No new analytics event anywhere (D-07).
- **Copy:** users never see the payment provider's name ("our payment partner"); nothing implies regulatory approval; people are "they"; sentence case; no em dashes; curly apostrophes, as in the code. New strings are only the ones each Design section lists.
- **Accessibility:** every control at least 44px with a visible label; colour never the only signal; focus moves to each new heading (claim moment, hand-over); `prefers-reduced-motion: reduce` gives the still versions; forced colours keep a `CanvasText` edge on every new panel, key and box; `expectAccessible(page)` in every new e2e test; 320px reflow with `LONG_NAME` and `UNBROKEN_NAME` from `tests/e2e/profile-fixtures.ts` where a name is drawn.
- **Materials:** tokens from `packages/ui/src/tokens.css`; no new hex colour in `packages/ui/src/components.css`; purple is a signature material (a key, a stamp, a tile), never a wash. Record each new visual ruling in `docs/design/DECISION-LOG.md`.
- **Baselines:** run a visual spec without update mode first, inspect the diff, say why in the commit, then `--update-snapshots`. Only PR 8 changes `profile.visual.spec.ts-snapshots/*` (Darwin locally; Linux from that PR's CI run, as states PR A did). Delete `apps/web/.next/cache` before every web build.
- **Contracts and API (PR 7):** optional fields only; an older API must draw today's done step and Home. After the route change: `pnpm api:openapi`, then `pnpm docs:generate`, and commit both. The new `profiles` column is added and dropped in `packages/database/test/integration/live-payouts-schema.test.mjs` around `seedDemoProfiles`.
- **Reporting:** run commands as written; record pass, fail or skipped with counts; report every failure by name.

## Review Focus

1. **The pay path did not move** (PR 8, 9). `pay-path.test.mjs`; `git diff origin/dev -- apps/web/src/components/appreciation-form.tsx` is empty in PR 8; in PR 9 it touches only the Other field's hint. `tip-card.spec.ts`, `checkout.spec.ts`, `profile-page.spec.ts` pass unchanged except the strings PR 9 changes.
2. **The selected key stays open to the accent** (PR 8). No `background-color` or `border-color` on `:checked + span` in the restyle; a grep test in `pay-path.test.mjs`'s sibling `tip-form-style.test.mjs` asserts it.
3. **Share card privacy** (PR 2). `personCardInput` returns exactly five keys; the route answers the general card for missing, paused, moved and unreachable handles with 200 and the same bytes; the page's description stays per page.
4. **Fonts in production** (PR 2). The TTFs load under `next start` (the e2e server), and a name with Ọ and Ẹ renders those letters, checked by eye on a saved PNG in the report.
5. **Gates** (PR 1, 3). New icon and manifest paths are exempt in both gates and nothing else is: `production-launch.test.mjs` and `preview-gate.test.mjs` list them, and a lookalike (`/icons/../dashboard`, `/icons/x.png`) is still gated.
6. **The claim moment cannot replay** (PR 6): reload after claim shows the plain hello step; Escape and "Continue" skip at once; reduced motion is still and silent.
7. **`welcomed_at` is set once** (PR 7): two posts keep the first date; an older API never shows the Home card.
8. **Print hides only what it should** (PR 5): under `emulateMedia({ media: 'print' })` the attention notices are hidden and the card and its link are visible.

## PR boundaries and order

| PR                            | Branch                     | Tasks     | Migration          | Depends on                                                                         |
| ----------------------------- | -------------------------- | --------- | ------------------ | ---------------------------------------------------------------------------------- |
| **1. App icons and manifest** | `feat/app-icons`           | 1.0–1.4   | none               | none                                                                               |
| **2. Share cards**            | `feat/share-cards`         | 2.0–2.4   | none               | none (PR 1's `HEART_MARK` if merged first; otherwise add it here and PR 1 rebases) |
| **3. Coming soon**            | `feat/coming-soon-restyle` | 3.0–3.3   | none               | none                                                                               |
| **4. QR studio**              | `feat/qr-studio-restyle`   | 4.0–4.4   | none               | none                                                                               |
| **5. QR printing**            | `feat/qr-print-restyle`    | 5.0–5.3   | none               | 4 (shares `qr-card.ts` and the QR CSS block)                                       |
| **6. The claim moment**       | `feat/claim-moment`        | 6.0–6.3   | none               | none                                                                               |
| **7. The keepsake**           | `feat/keepsake`            | 7.0–7.5   | `NNNN_welcomed_at` | 6 (same welcome files)                                                             |
| **8. Tip form restyle**       | `feat/tip-form-restyle`    | 8.0–8.3   | none               | **states PR B merged**, **make-it-yours PR B merged**                              |
| **9. Tip form proposals**     | `feat/tip-form-proposals`  | 9.1–9.2   | none               | 8                                                                                  |
| **10. Stamp sound**           | `feat/claim-sound`         | 10.1–10.2 | none               | 6 + owner yes (Q5)                                                                 |

PRs 1, 2, 3, 4 and 6 can be built in parallel. 8 waits on two other builders, so it is last in line but not blocked by this plan's own PRs.

## Overlaps with other branches (do not plan their work)

- **States PR B** (`feat/states-b`, in progress: `tip-amounts.ts`, `tip-card.spec.ts`, `gaps.spec.ts`, `checkout.spec.ts`, `profile-page.spec.ts`; Task 9 also `appreciation-form.tsx`): owns "Not sent yet", the below-minimum flag and suggested key. PRs 8–9 start after it merges. PR 9 builds on its `minLabel`.
- **States PR D** (dashboard): `welcome-view.tsx` (`:108-125`, `:307`, `:354`, `:394`, `:399`), `dashboard-shell.tsx` (`:132`, `:154`), `home-view.tsx`. PR 6 and 7 add a component and a few lines in `welcome-view.tsx` and `home-view.tsx`; whoever merges second rebases. PR 5's print rule names both `.tm-notice` and `.tm-slip`, so it does not care which lands first.
- **States PR H1/H2** (connection): `appreciation-form.tsx` and `welcome-view.tsx:120`. No logic overlap with PR 9's hint.
- **Make-it-yours PR B** (`feat/miy-start-amount`, 0078): `tip-amounts.ts`, the starting key. PR 8 waits for it so the visual baselines are taken once.
- **Make-it-yours PR D** (accent, pinned note): the selected key's fill and `recipient-card.tsx`. PR 8 leaves the fill alone (Review Focus 2).
- **Live updates PR 2** (`feat/live-updates-2`): refetches `/v1/me/qr-art` in `app/dashboard/qr/*` and adds `profile.changed` after profile writes. PR 4 rebases if it lands first; PR 7's `POST /v1/me/welcomed` does not need a live signal (it changes nothing another tab shows).
- **Username reservation PR 2/3:** `home-view.tsx` (take-back banner). PR 7's Home card is a separate block in the side column.
- **Animated covers (#127, merged into dev at `931a545`):** `resolveCover` has `kind: 'animated'`; `shareCardColours` handles it (its `colour`, else purple).

---

## PR 1: App icons and manifest

### Task 1.0: Boards and decision

**Files:** create `docs/design/redesign/boards/AppIcons.dc.html` (copied unchanged); modify `docs/design/redesign/README.md`, `docs/design/DECISION-LOG.md` (home-screen icons: the tab icon stays flat; depth only at 180 px and up; manifest `display: browser`).

- [ ] **Step 1:** `test -f docs/design/redesign/boards/AppIcons.dc.html` → expect FAIL.
- [ ] **Step 2:** Copy, add the README row, write the log entry.
- [ ] **Step 3:** Step 1 again → PASS; `pnpm exec prettier --check docs/design`.
- [ ] **Step 4: Commit** `docs: the App icons board and its rulings`.

### Task 1.1: One heart

**Files:** modify `apps/web/src/components/brand.tsx` (export `HEART_MARK: { d: string; transform: string; viewBox: string }`); test `apps/web/test/brand-heart.test.mjs` (new).

- [ ] **Step 1: Failing test.**

  ```js
  test('icon.svg draws the HEART_MARK path and transform', ...);
  //   read src/app/icon.svg; import HEART_MARK from src/components/brand.tsx (as other web tests import .ts/.tsx)
  //   assert the <path d> and transform attributes equal HEART_MARK.d and HEART_MARK.transform
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/brand-heart.test.mjs` → FAIL (no export).
- [ ] **Step 3:** Implement; Step 2 again → PASS; `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`.
- [ ] **Step 4: Commit** `feat(web): one heart mark for every icon`.

### Task 1.2: The icon files and the manifest

**Files:** create `apps/web/src/app/apple-icon.tsx`, `apps/web/src/app/icons/[file]/route.tsx`, `apps/web/src/app/manifest.ts`, `apps/web/src/lib/app-icons.tsx` (the shared tile JSX: `IconTile({ size, maskable, rounded })`); test `tests/e2e/app-icons.spec.ts` (new).

- [ ] **Step 1: Failing e2e.**

  ```ts
  test('the home page links a manifest named TipMe and an Apple touch icon', ...);
  //   page.goto('/'); link[rel="manifest"] href '/manifest.webmanifest'; link[rel="apple-touch-icon"] present
  //   GET manifest → JSON { name:'TipMe', short_name:'TipMe', start_url:'/', display:'browser', theme_color:'#7A32F9',
  //   background_color:'#FFFFFF' }, icons deepEqual [{src:'/icons/192.png',sizes:'192x192',type:'image/png',purpose:'any'},
  //   {src:'/icons/512-maskable.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]
  test('each icon is a PNG of its stated size', ...);
  //   for apple-touch-icon href (180), /icons/192.png, /icons/512-maskable.png: status 200, content-type image/png,
  //   width and height from the IHDR bytes (offsets 16–23) match
  test('the tab icon is still the flat icon.svg', ...);
  //   link[rel="icon"][type="image/svg+xml"] href starts with '/icon.svg'
  test('an unknown icon file is 404', ...);
  //   GET /icons/64.png → 404
  ```

- [ ] **Step 2:** `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/app-icons.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - `IconTile`: purple `#7A32F9`, the heart in white, `backgroundImage: 'linear-gradient(rgb(255 255 255 / 22%), transparent 38%), linear-gradient(transparent 70%, rgb(40 8 96 / 35%))'`. Rounded (192) uses corner 28/120 of the size; apple and maskable are full bleed. Maskable scales the heart so its bounding box fits inside a circle of 40% radius.
  - The route's `generateStaticParams` returns `['192.png', '512-maskable.png']` and `dynamicParams = false`.
  - Save the three PNGs to the report folder and look at each one (light, depth, heart centred, no clipping in the maskable safe circle).
- [ ] **Step 4:** Step 2 again → PASS; `tests/e2e/quality.spec.ts` (headers test also covers `/manifest.webmanifest` and `/icons/192.png`: add them to its route list) → PASS.
- [ ] **Step 5: Commit** `feat(web): home-screen icons and a manifest named TipMe`.

### Task 1.3: Open the new files in both gates

**Files:** modify `apps/web/src/lib/production-launch.ts:84-94`, `apps/web/src/lib/preview-gate.ts:11`; tests `apps/web/test/production-launch.test.mjs`, `apps/web/test/preview-gate.test.mjs`.

- [ ] **Step 1: Failing tests.**

  ```js
  test('before launch the manifest and the home-screen icons are exempt', ...);
  //   '/manifest.webmanifest', '/icons/192.png', '/icons/512-maskable.png', the apple-icon path → 'exempt'
  //   '/icons/64.png', '/icons/../dashboard', '/icons/%2e%2e/x', '/manifest.webmanifest/x' → 'rewrite'
  test('the preview password does not hold the manifest or the icons', ...); // same lists → 'exempt' / 'login'
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/production-launch.test.mjs test/preview-gate.test.mjs` → FAIL.
- [ ] **Step 3:** Implement with exact paths (no prefix match). Step 2 → PASS.
- [ ] **Step 4: Commit** `fix(web): the icons and manifest load before launch and behind the preview password`.

### Task 1.4: Checks, handoff

- [ ] **Step 1:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (with `E2E_LANE` unset), then `pnpm test:e2e` on your lane. Record each result.
- [ ] **Step 2:** Add the icons to `docs/third-party-component-register.md`'s typography section as "drawn by TipMe with `next/og`, no third-party asset". Update ACTIVE_TASK and HANDOFF.
- [ ] **Step 3: Commit** `docs(agent): app icons verified`.

---

## PR 2: Share cards

### Task 2.0: Boards and decision

As Task 1.0 for `ShareCards.dc.html`. DECISION-LOG: "Share cards: per-person card draws name, role, handle and cover colour only; no photo; paused or moved pages keep the general card." **Commit** `docs: the Share cards board and its rulings`.

### Task 2.1: The fonts

**Files:** create `apps/web/src/fonts/og/DMSerifDisplay-Regular.ttf`, `Manrope-SemiBold.ttf`, `Manrope-Bold.ttf`, `OFL-DMSerifDisplay.txt`, `OFL-Manrope.txt`; modify `docs/third-party-component-register.md` (source URLs with commit, licence, sizes, ranges, why TTF); test `apps/web/test/og-fonts.test.mjs` (new).

- [ ] **Step 1: Failing test.**

  ```js
  test('each share-card font is a TrueType file with its licence beside it', ...);
  //   the first 4 bytes are 00 01 00 00; OFL files exist; each file is under 400 KB
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/og-fonts.test.mjs` → FAIL.
- [ ] **Step 3:** Fetch the files from the pinned commits; subset if `uvx --from fonttools pyftsubset` works (`--unicodes=U+0000-024F,U+1E00-1EFF,U+2000-206F,U+20A6`), else commit whole and say so. Step 2 → PASS.
- [ ] **Step 4: Commit** `chore(web): TrueType copies of the two fonts for share cards`.

### Task 2.2: The card components

**Files:** create `apps/web/src/lib/share-card.tsx` (Interfaces in Design PR 2); test `apps/web/test/share-card.test.mjs` (new).

- [ ] **Step 1: Failing tests.**

  ```js
  test('personCardInput keeps only name, role, handle and the two colours', ...);
  //   a PublicProfile with phone, email, avatarPath, bio, links, pinnedNote, celebration set
  //   → Object.keys(result).sort() deepEqual ['band','face','handle','name','role']
  test('shareCardColours: a design with a colour uses that colour', ...); // COVER_COLOURS[id].base / .tone
  test('shareCardColours: a photo, a colourless design, an animation without colour, or no cover is TipMe purple', ...);
  test('a role that is not public stays out', ...); // role undefined → null
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/share-card.test.mjs` → FAIL.
- [ ] **Step 3:** Implement. `ogFonts()` reads each TTF once per process (module-level promise).
- [ ] **Step 4:** Step 2 → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(web): share card drawings that take only public details`.

### Task 2.3: The general card and the person card

**Files:** modify `apps/web/src/app/opengraph-image.tsx`, `apps/web/src/lib/metadata.ts`, `apps/web/src/app/people/[handle]/page.tsx` (`generateMetadata` only); create `apps/web/src/app/people/[handle]/share-card/route.tsx`; tests `tests/e2e/quality.spec.ts` (update `:169-187`), `tests/e2e/share-cards.spec.ts` (new).

- [ ] **Step 1: Failing e2e.**

  ```ts
  test('a person’s link advertises their own card', ...);
  //   goto '/@ada'; og:image content pathname '/people/ada/share-card'; og:image:alt 'Ada Okafor on TipMe'
  //   twitter:image the same; GET it → 200 image/png, 1200×630 from IHDR
  test('home and marketing pages keep the general card', ...); // '/', '/pro' → '/opengraph-image'
  test('an unknown, offline or moved handle gets the general card, not an error', ...);
  //   GET /people/nobody_here/share-card, /people/<offline e2e page>/share-card, an old handle → 200, bytes equal
  //   to each other (the general card); the page metadata for the unknown handle has no person card
  test('the card changes after the person changes their role', ...);
  //   sign up a page, make it live, fetch card A; PATCH role; fetch card B; Buffer.compare(A,B) !== 0
  ```

  `quality.spec.ts:169`: the profile test now expects `/people/ada/share-card` and the person alt; a new line checks `/` still advertises `/opengraph-image` with `SHARE_CARD_ALT`.

- [ ] **Step 2:** `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/share-cards.spec.ts tests/e2e/quality.spec.ts` → FAIL.
- [ ] **Step 3: Implement** as Design PR 2. Save the general card, Ada's card, a `LONG_NAME` card, an `UNBROKEN_NAME` card and an "Ọlápéjú Ẹ̀kọ́" card as PNGs in the report folder and look at each (no overflow, letters present).
- [ ] **Step 4:** Step 2 → PASS; also `tests/e2e/countdown.spec.ts` is untouched by this PR (the coming-soon card is separate).
- [ ] **Step 5: Commit** `feat(web): a share card for each person’s link, and the general card in the new materials`.

### Task 2.4: Checks, handoff

As Task 1.4. Also add to `docs/security/threat-model.md` one line: per-person share cards draw only public fields; unknown handles answer the general card. **Commit** `docs(agent): share cards verified`.

---

## PR 3: Coming soon

### Task 3.0: Boards and decision

As Task 1.0 for `ComingSoon.dc.html`. DECISION-LOG: the date line follows the launch time; the paper card is decorative. **Commit** `docs: the Coming soon board and its rulings`.

### Task 3.1: The date from the launch time

**Files:** modify `apps/web/src/lib/countdown.ts`, `apps/web/src/app/coming-soon/page.tsx`, `apps/web/src/app/coming-soon/opengraph-image.tsx`; tests `apps/web/test/countdown.test.mjs`, `tests/e2e/countdown.spec.ts:23-26`.

- [ ] **Step 1: Failing tests.**

  ```js
  test('launchLabel writes the Lagos date and time', ...);
  //   Date.parse('2026-10-26T23:00:00Z') → '27 October 2026 · 00:00 WAT'
  //   Date.parse('2027-01-15T08:30:00Z') → '15 January 2027 · 09:30 WAT'
  //   Date.parse('2026-12-31T23:30:00Z') → '1 January 2027 · 00:30 WAT' (crosses the year in Lagos)
  test('launchShortLabel drops the year', ...); // → '27 October · 00:00 WAT'
  test('no fixed launch label is left in the page or its card', ...);
  //   coming-soon/page.tsx and opengraph-image.tsx do not contain '27 October'
  ```

  `countdown.spec.ts`: the `<time>` text equals `launchLabel(Date.parse(process.env.E2E_PRODUCTION_LAUNCH_AT))` and its `datetime` equals the ISO of that instant.

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/countdown.test.mjs` → FAIL; then `node scripts/build-e2e.mjs` with `PRODUCTION_LAUNCH_AT` unset and `E2E_PRODUCTION_LAUNCH_AT=2027-01-15T09:30:00+01:00 pnpm exec playwright test -c tests/e2e/countdown.config.ts` → FAIL on the label.
- [ ] **Step 3:** Implement with `Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', … })`. The OG image calls `await connection()` and reads `parseProductionLaunchAt(process.env.PRODUCTION_LAUNCH_AT) ?? Date.parse(LAGOS_LAUNCH_TARGET)`.
- [ ] **Step 4:** Both commands → PASS (the spec's `/coming-soon/opengraph-image` request at `:92` still returns a PNG).
- [ ] **Step 5: Commit** `fix(web): the coming-soon date follows the launch time`.

### Task 3.2: The restyle and the paper card

**Files:** modify `apps/web/src/app/coming-soon/page.tsx` (the card markup, `aria-hidden`), `apps/web/src/app/globals.css` (`.coming-soon*`, `.launch-countdown*`); test `tests/e2e/countdown.spec.ts`.

- [ ] **Step 1: Failing e2e** (in the countdown spec):

  ```ts
  test('the tiles are keys in a well, the headline is DM Serif, the eyebrow is sentence case', ...);
  //   h1 computed font-family includes the DM Serif variable family; .coming-soon__eyebrow text-transform 'none'
  //   .launch-countdown__grid has the recessed background (--surface-recessed); the seconds tile background is the brand purple
  test('the paper card is hidden from screen readers and shows the site host', ...);
  //   .coming-soon__card aria-hidden 'true'; contains 'Your page', '/@yourname', 'Tip'
  test('320px: the tiles are two by two and nothing scrolls sideways', ...); // extend the existing reflow test
  ```

- [ ] **Step 2:** Run the countdown command from Task 3.1 → FAIL.
- [ ] **Step 3:** Implement. Reduced motion keeps transitions at none (existing test).
- [ ] **Step 4:** → PASS; take desktop and phone screenshots into the report.
- [ ] **Step 5: Commit** `feat(web): coming soon in the redesign’s materials`.

### Task 3.3: Checks, handoff

As Task 1.4, plus the countdown command. **Commit** `docs(agent): coming soon verified`.

---

## PR 4: QR studio

### Task 4.0: Boards and decision

As Task 1.0 for `QrStudio.dc.html`. DECISION-LOG: the status line's single position; three design groups by `kind`; Manrope on the card. **Commit** `docs: the QR studio board and its rulings`.

### Task 4.1: The paper panel and the status line

**Files:** modify `apps/web/src/app/dashboard/qr/qr-studio.tsx`, `apps/web/src/app/globals.css` (`.qr-studio*`, `:6050-6230`); test `tests/e2e/qr.spec.ts`.

- [ ] **Step 1: Failing e2e.**

  ```ts
  test('the code sits on a raised paper panel', ...); // .qr-studio__panel has class tm-surface--paper; contains the canvas
  test('on a phone, the Pro design message sits under the Upgrade panel @mobile', ...);
  //   Free page; choose 'Raised keys'; status text 'Raised keys is a Pro design…' is visible without scrolling
  //   from the Upgrade link (status.boundingBox().y < first fieldset .y); it is the only [role=status] in .qr-studio
  test('saving a free style still says "Style saved" in the same live region', ...);
  ```

- [ ] **Step 2:** `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/qr.spec.ts` → FAIL.
- [ ] **Step 3:** Implement; the region keeps the same element across renders (no conditional mount).
- [ ] **Step 4:** → PASS. **Commit** `feat(web): the QR code on paper, and the Pro message where it is seen`.

### Task 4.2: Three groups of designs

**Files:** modify `qr-studio.tsx`; create `apps/web/src/lib/qr-groups.ts` (`groupDesigns(items: QrArtItem[]): { id: 'patterns' | 'cards' | 'photo'; legend: string; items: QrArtItem[] }[]`, empty groups dropped); tests `apps/web/test/qr-groups.test.mjs` (new), `tests/e2e/qr.spec.ts`.

- [ ] **Step 1: Failing tests.**

  ```js
  test('designs keep the API order inside Patterns, Cards and Photo', ...);
  test('an unknown kind joins Patterns; an empty group is dropped', ...);
  ```

  ```ts
  test('the designs list as Patterns (17), Cards (12) and Photo (1); arrows move across groups', ...);
  //   fieldset legends; radio counts; focus the last Pattern, ArrowDown → first Card is checked (preview)
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/qr-groups.test.mjs` and the qr spec → FAIL.
- [ ] **Step 3:** Implement. Step 2 → PASS. **Commit** `feat(web): QR designs in three groups`.

### Task 4.3: Manrope on the card

**Files:** modify `apps/web/src/lib/qr-card.ts` (`fontFamily` input), `qr-studio.tsx`, `print/print-view.tsx` (pass it); create `apps/web/src/lib/brand-font.ts` (`interfaceFont(): Promise<string>`: the resolved `--font-manrope` family after `document.fonts.load`, or `'Arial, sans-serif'`); test `apps/web/test/qr-card.test.mjs` (new, a fake 2D context recording `font`).

- [ ] **Step 1: Failing test.**

  ```js
  test('drawQrCard letters the card in the family it is given', ...);
  //   every recorded ctx.font ends with '"Manrope test", Arial, sans-serif'
  test('without a family it is Arial, as before', ...);
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/qr-card.test.mjs` → FAIL.
- [ ] **Step 3:** Implement. Step 2 → PASS; `tests/e2e/qr.spec.ts` → PASS.
- [ ] **Step 4: Commit** `feat(web): the QR card is lettered in Manrope`.

### Task 4.4: Checks, handoff

As Task 1.4; screenshots (desktop Free Purple, phone previewing Raised keys) in the report. **Commit** `docs(agent): QR studio verified`.

---

## PR 5: QR printing

### Task 5.0: Boards and decision

As Task 1.0 for `QrPrint.dc.html`. **Commit** `docs: the QR print board and its rulings`.

### Task 5.1: The link once, the paper pictures

**Files:** modify `apps/web/src/app/dashboard/qr/print/print-view.tsx`, `apps/web/src/app/globals.css` (`.print-card*`, `.qr-formats`, new `.qr-pick__art`); test `tests/e2e/qr.spec.ts`.

- [ ] **Step 1: Failing e2e.**

  ```ts
  test('the Free card prints its link once', ...); // .print-card__label count 0; canvas aria-label still names the link
  test('each format choice shows a small paper picture beside its name and size', ...);
  //   Pro page with a design; 8 radios; each label has .qr-pick__art[aria-hidden=true][data-format=<id>] and its text
  //   'Counter card', 'Prints on A6' …; getByLabel('Receipt slip') checks the radio
  ```

- [ ] **Step 2:** the qr spec → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(web): print the link once, and choose a format by its picture`.

### Task 5.2: Cut lines and a clean page

**Files:** modify `globals.css` (`@media print`); test `tests/e2e/qr.spec.ts`.

- [ ] **Step 1: Failing e2e.**

  ```ts
  test('printing hides the pilot notice and the attention notices, not the card', ...);
  //   a new page (it has "Needs your attention" items); goto print; emulateMedia({ media: 'print' })
  //   .owner-attention hidden; .print-card__canvas visible; restore 'screen' → .owner-attention visible
  test('the receipt slip and the lock screen print with a cut line', ...);
  //   Pro; choose 'Receipt slip'; emulateMedia print; .qr-format--receipt computed outline-style 'dashed'
  //   'Counter card' → outline-style 'none'
  ```

- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(web): cut lines on small formats, and nothing but the card on paper`.

### Task 5.3: Checks, handoff

As Task 1.4; print-preview PDFs (`page.pdf()`) of the Free card and the receipt slip in the report. **Commit** `docs(agent): QR printing verified`.

---

## PR 6: The claim moment

### Task 6.0: Boards and decision

As Task 1.0 for `SignUpCelebration.dc.html` and `FeedbackMoments.dc.html` (if not already in the folder; states PR A copied it). DECISION-LOG: the moment is triggered by the claim; no name at claim time; purple hearts; no confetti; sound separate. **Commit** `docs: the Sign-up celebration board and its rulings`.

### Task 6.1: The once-only marker

**Files:** create `apps/web/src/lib/claim-moment.ts`; test `apps/web/test/claim-moment.test.mjs` (new).

- [ ] **Step 1: Failing tests.**

  ```js
  test('takeClaimed is true once after markClaimed for the same handle, then false', ...);
  test('another handle, or no mark, is false', ...);
  test('a storage that throws never throws out of mark or take', ...); // take → false
  test('claimBuzz vibrates 30 ms, and not with reduced motion or without vibrate', ...);
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/claim-moment.test.mjs` → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(web): mark a claim once, for the welcome to celebrate`.

### Task 6.2: The scene

**Files:** create `apps/web/src/components/account/claim-moment.tsx`; modify `apps/web/src/components/account/handle-claim.tsx` (call `markClaimed` before `onClaimed`), `apps/web/src/app/dashboard/welcome/welcome-view.tsx` (`takeClaimed` on mount; render `<ClaimMoment>` over the hello step; focus the hello heading on done), `apps/web/src/app/globals.css` (`.claim-moment*`, keyframes, reduced motion, forced colours); tests `tests/e2e/welcome.spec.ts`, `tests/e2e/helpers.ts` (`:100-104`: after the claim click, press "Continue" if the moment shows, so other specs don't wait 1.6 s).

- [ ] **Step 1: Failing e2e.**

  ```ts
  test('claiming a handle celebrates once: "@handle is yours.", then the hello step', ...);
  //   claim; heading '@<handle> is yours.' is focused; [role=status] or live text 'Your handle @<handle> is claimed. Welcome to TipMe.'
  //   the stamp text '@<handle> · YOURS' is inside aria-hidden; within 3 s the heading 'Welcome to TipMe.' is focused
  //   reload → no '@<handle> is yours.' heading; expectAccessible(page)
  test('Continue and Escape skip the moment at once', ...);
  test('reduced motion shows the still scene with no animation', ...);
  //   (config already reduces motion) .claim-moment animation-name 'none' on card, stamp and hearts; three hearts shown
  test('someone who presses "I’ll do this later" was still celebrated first', ...);
  test('the moment fits a 320px phone @mobile', ...); // fitsViewport; long handle (30 chars) wraps, stamp clear of it
  ```

- [ ] **Step 2:** `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/welcome.spec.ts` → FAIL.
- [ ] **Step 3: Implement** as Design PR 6. The timeline is CSS keyframes on `--duration-*`-based delays (0–0.35 fall, 0.35–0.55 land, 0.55–0.8 stamp, 0.8–1.2 hearts and heading, 1.2–1.6 rise away); `claimBuzz` at 0.35 s; a `setTimeout(CLAIM_MOMENT_MS)` hands over; a `keydown`/`pointerdown` listener hands over earlier. Hearts use `var(--brand-primary)`.
- [ ] **Step 4:** Step 2 → PASS; the full e2e suite on your lane (the helper change touches every spec that signs up).
- [ ] **Step 5: Commit** `feat(web): "@handle is yours." once, for everyone who claims a page`.

### Task 6.3: Checks, handoff

As Task 1.4; a short screen recording or three screenshots (0.4 s, 1.0 s, still) in the report. **Commit** `docs(agent): claim moment verified`.

---

## PR 7: The keepsake

### Task 7.0: Boards and decision

DECISION-LOG and `docs/00-DECISIONS.md` (one line under product decisions: "Sign-up celebration and keepsake, 5 Nov 2026; product decision, not an approval"). **Commit** `docs: the keepsake decision`.

### Task 7.1: Contracts

**Files:** modify `packages/contracts/src/profiles.ts` (`MyProfile.memberSince?`, `MyProfile.welcomedAt?`); test `packages/contracts/test/contracts.test.mjs`.

- [ ] **Step 1:** add `test('MyProfile may carry memberSince and welcomedAt, both optional', …)` (a type-level fixture compiled by `typecheck`, plus the OpenAPI shape in Task 7.3). `pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test` → FAIL.
- [ ] **Step 2:** implement → PASS; typecheck, lint. **Commit** `feat(contracts): when a page was made, and when it was welcomed`.

### Task 7.2: Storage

**Files:** modify `packages/database/src/schema.ts` (`welcomedAt: timestamp('welcomed_at', { withTimezone: true })`), the new migration with snapshot and journal, `packages/database/src/operations/profiles.ts` (`toMine` sends `memberSince` and `welcomedAt`; new `markWelcomed`), `packages/database/test/integration/live-payouts-schema.test.mjs`; test `packages/database/test/integration/welcomed.test.mjs` (new).

- [ ] **Step 1: Failing tests.**

  ```js
  test('toMine sends memberSince (created_at) and welcomedAt null for a new page', ...);
  test('markWelcomed sets the date once; a second call keeps the first', ...);
  test('markWelcomed for a user without a page is PROFILE_NOT_FOUND', ...);
  ```

- [ ] **Step 2:** build contracts, then generate the migration (`pnpm --filter @tipme/database generate`, next free number); run the three files and `migration-journal.test.mjs` through your lane's integration wrapper (builder-rules) → FAIL first, then PASS after Step 3.
- [ ] **Step 3:** implement. **Step 4:** `pnpm --filter @tipme/database typecheck && pnpm --filter @tipme/database lint`.
- [ ] **Step 5: Commit** `feat(database): remember when a page was first welcomed`.

### Task 7.3: API

**Files:** modify `apps/api/src/profiles/me-profile.controller.ts` (`POST /v1/me/welcomed`), `apps/api/src/openapi/document.ts`, `docs/api/openapi.json`, generated docs; test `tests/integration/welcomed-api.test.mjs` (new).

- [ ] **Step 1: Failing tests.**

  ```js
  test('POST /v1/me/welcomed sets welcomedAt and returns MyProfile; again keeps the date', ...);
  test('without a session or CSRF it is refused', ...);
  test('GET /v1/me/profile carries memberSince', ...);
  ```

- [ ] **Step 2:** `pnpm turbo run build --filter=!@tipme/web` then the files with `tests/integration/openapi.test.mjs` via the lane wrapper → FAIL. **Step 3:** implement; `pnpm api:openapi && pnpm docs:generate`. **Step 4:** → PASS; api typecheck, lint.
- [ ] **Step 5: Commit** `feat(api): POST /v1/me/welcomed`.

### Task 7.4: The card on the done step and on Home

**Files:** create `apps/web/src/lib/keepsake.ts`, `apps/web/src/components/account/keepsake-card.tsx` (card + "Save card"); modify `welcome-view.tsx` (done step: the card in place of `.welcome-moment`; post once), `apps/web/src/app/dashboard/home-view.tsx` (side column; post once), `globals.css` (`.keepsake*`); tests `apps/web/test/keepsake.test.mjs` (new), `tests/e2e/welcome.spec.ts`, `tests/e2e/dashboard.spec.ts`.

- [ ] **Step 1: Failing tests.**

  ```js
  test('memberSinceLabel uses Lagos time', ...); // '2026-11-04T23:30:00Z' → '5 November 2026'
  test('keepsakeOnHome: undefined never; null yes; 6 days 23 h yes; 7 days no', ...);
  ```

  ```ts
  test('the done step shows the keepsake card with the member-since date, and Save card downloads a PNG', ...);
  //   finish setup; getByText('Member since <today in Lagos>'); 'Save card' → download named tipme-<handle>-keepsake.png
  //   no '✓' circle; expectAccessible
  test('someone who skipped setup finds the keepsake on Home', ...);
  //   claim, Continue, "I’ll do this later" → Home side column shows '@<handle>' and 'Member since'
  test('Home stops showing the keepsake 7 days after it was first shown', ...);
  //   set welcomed_at to now() - 8 days via the test SQL helper; reload Home → no keepsake
  test('an older API without welcomedAt shows no keepsake on Home', ...); // route GET /v1/me/profile to strip both fields
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/keepsake.test.mjs`; `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/welcome.spec.ts tests/e2e/dashboard.spec.ts` → FAIL.
- [ ] **Step 3:** implement. Tests that route `**/v1/me/**` answer `/v1/me/events` with 204.
- [ ] **Step 4:** → PASS. **Commit** `feat(web): a keepsake card at the end of setup, and on Home for a week`.

### Task 7.5: Checks, handoff

As Task 1.4 plus the integration files. **Commit** `docs(agent): keepsake verified`.

---

## PR 8: Tip form restyle

**Start only after states PR B and make-it-yours PR B are on `origin/dev`.** Rebase the visual baselines once.

### Task 8.0: Boards and decision

As Task 1.0 for `TipForm.dc.html`. DECISION-LOG: the public tip form wears the Tipper's journey materials; the home demo form keeps its look; the selected key's fill stays with `AmountChoice` (and make-it-yours' accent). **Commit** `docs: the Tip form board and its rulings`.

### Task 8.1: Fences first

**Files:** create `apps/web/test/pay-path.test.mjs`, `apps/web/test/tip-form-style.test.mjs`.

- [ ] **Step 1: Write the fences** (they pass on dev; they exist to fail if a later change moves the pay path or the fill).

  ```js
  test('the tip form has exactly one way to pay: location.assign(result.data.checkoutUrl) after result.ok', ...);
  //   appreciation-form.tsx: one match of /location\.assign\(/, and it is /location\.assign\(result\.data\.checkoutUrl\)/;
  //   the text between 'if (result.ok)' and that call has no 'return'; no 'window.open', no '<form action', no 'checkoutUrl' elsewhere in apps/web/src
  test('the form refuses an amount the quote does not match', ...);
  //   /Number\(current\.tipMinor\) !== amount \|\|\s*Number\(current\.payerTotalMinor\) !== amount/ is present
  test('the restyle never sets the selected key’s fill or edge', ...);
  //   in globals.css, no rule whose selector contains ':checked + span' under '.profile-composer' declares background-color, background: <colour> or border-color
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/pay-path.test.mjs test/tip-form-style.test.mjs` → PASS on dev (record it). Break the guard locally to see each test fail, then restore.
- [ ] **Step 3: Commit** `test(web): fence the tip form’s pay path and the key fill`.

### Task 8.2: The materials

**Files:** modify `apps/web/src/app/globals.css` (`.profile-composer` rules only); tests `tests/e2e/profile-page.spec.ts`, `tests/e2e/profile.visual.spec.ts` (baselines).

- [ ] **Step 1: Failing e2e** (in `profile-page.spec.ts`):

  ```ts
  test('the tip panel is paper, the heading DM Serif, the keys raised, the fields recessed, the Tip key black', ...);
  //   .profile-composer h2 font-family includes the DM Serif family
  //   an unselected .tm-amount-choice span has a non-'none' box-shadow and background-image containing 'linear-gradient'
  //   #…-custom computed background-color equals --surface-recessed
  //   .composer-submit min-height >= 56px, background-color rgb(0, 0, 0)
  //   .composer-extras summary has a top border, and its chevron turns when open
  test('the red edge still wins on a refused amount', ...);
  //   Other 1,500 → Tip → the field's computed border-color is the danger edge, not the well's
  test('checkboxes keep their keyboard behaviour', ...); // Space toggles 'Remember my tips on this phone'; focus ring visible
  test('320px with a long name: the panel and keys fit @mobile', ...); // LONG_NAME, UNBROKEN_NAME; fitsViewport
  test('forced colours: keys, wells and the panel keep an edge', ...);
  ```

- [ ] **Step 2:** `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/profile-page.spec.ts` → FAIL.
- [ ] **Step 3:** Implement as Design PR 8.
- [ ] **Step 4:** → PASS; then `tests/e2e/tip-card.spec.ts tests/e2e/checkout.spec.ts tests/e2e/pilot-notice.spec.ts tests/e2e/profile-cover.spec.ts` → PASS unchanged; `node --test apps/web/test/no-provider-names.test.mjs` → PASS.
- [ ] **Step 5: Baselines:** `pnpm test:e2e -- tests/e2e/profile.visual.spec.ts` without update → FAIL with the intended diff; inspect; then with `--update-snapshots` (Darwin). Linux baselines come from this PR's CI run. **Commit** `feat(web): the public tip form in the Tipper’s journey materials` (body: why the baselines change).

### Task 8.3: Checks, handoff

As Task 1.4. `git diff origin/dev -- apps/web/src/components/appreciation-form.tsx` is empty: put that output in the report. **Commit** `docs(agent): tip form restyle verified`.

---

## PR 9: Tip form proposals

### Task 9.1: Say the minimum while typing

**Files:** modify `apps/web/src/lib/tip-amounts.ts` (`belowMinimum(options, text): boolean`: parses as a number and is under the floor; uses states PR B's `minLabel`), `apps/web/src/components/appreciation-form.tsx` (the Other field's `hint`, a 700 ms idle timer and `onBlur`; nothing else); tests `apps/web/test/tip-amounts.test.mjs`, `tests/e2e/tip-card.spec.ts`.

- [ ] **Step 1: Failing tests.**

  ```js
  test('belowMinimum: 1,500 and 1500.5 yes; 2,000, empty and "abc" no', ...);
  ```

  ```ts
  test('typing an amount under the minimum shows the rule as a hint after a pause, not as an error', ...);
  //   type '1500', wait 900 ms → the field's description contains 'Enter an amount of NGN 2,000 or more'; aria-invalid absent; no role=alert
  test('typing 2,000 key by key never shows the hint', ...); // type '2000' with 100 ms per key → no hint at any point
  test('pressing Tip under the minimum still starts nothing and shows states PR B’s error', ...); // sent.intents empty
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web exec node --test test/tip-amounts.test.mjs test/pay-path.test.mjs`; `pnpm test:e2e -- tests/e2e/tip-card.spec.ts` → FAIL on the new tests, PASS on the fence.
- [ ] **Step 3:** implement. **Step 4:** → PASS. **Commit** `feat(web): the tip form says the minimum while you type`.

### Task 9.2: One line under the Tip key (live)

**Files:** modify `apps/web/src/lib/payment-mode-copy.ts` (live `formPartner`, live `formTrust: null`); tests `apps/web/test/payment-mode-copy.test.mjs`, the e2e strings that read "No account needed" or the old partner line in live-mode specs.

- [ ] **Step 1: Failing tests.**

  ```js
  test('live mode has one line beside the Tip key', ...);
  //   paymentModeCopy('live').formPartner === 'You pay exactly this. You’ll confirm on our partner’s page.'; formTrust === null
  test('test mode keeps its two lines; closed mode has none', ...);
  ```

- [ ] **Step 2:** `pnpm --filter @tipme/web test` → FAIL. **Step 3:** implement; update the strings; `git grep -n "No account needed" -- tests apps/web/src` shows only test-mode uses. **Step 4:** → PASS; `pnpm test:e2e -- tests/e2e/tip-card.spec.ts tests/e2e/pilot-notice.spec.ts tests/e2e/profile-page.spec.ts` → PASS; `no-provider-names.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(web): one line under the Tip key` (body: the proof of "You pay exactly this").
- [ ] **Step 6:** full checks, handoff, **commit** `docs(agent): tip form proposals verified`.

---

## PR 10: The stamp sound (only with the owner's yes, Q5)

### Task 10.1: The sound file

**Files:** create `scripts/make-stamp-sound.mjs`, `scripts/make-stamp-sound.test.mjs`, `apps/web/public/sounds/stamp.wav`.

- [ ] **Step 1:** test: the script writes a mono 16-bit WAV under 30 KB and under 400 ms, deterministic bytes. `node --test scripts/make-stamp-sound.test.mjs` → FAIL. **Step 2:** implement; run it; → PASS. **Commit** `feat(web): a soft stamp sound, made by our own script`.

### Task 10.2: Play it at the stamp

**Files:** modify `apps/web/src/lib/claim-moment.ts` (`playStamp`), `claim-moment.tsx`; test `apps/web/test/claim-moment.test.mjs`.

- [ ] **Step 1:** tests: plays at 0.25 volume when enabled, the tab is visible and `audioSession` exists (sets `'ambient'` first); silent when disabled, hidden, reduced-motion has no effect, no `audioSession`, or `play()` rejects (no throw). → FAIL. **Step 2:** implement → PASS; welcome spec → PASS. **Commit** `feat(web): the claim moment’s stamp can be heard`.

---

## Open for the owner

Each has a default the builder ships with.

- **Q1. Minimum while typing.** The board says "as soon as the amount is below ₦2,000". Typing 2,000 passes through 2, 20 and 200, so that would scold correct typing. Default: the same words as a quiet hint after 700 ms without typing or when leaving the field; the red edge only after pressing Tip.
- **Q2. One line under the Tip key.** Default: build it in live mode ("You pay exactly this. You’ll confirm on our partner’s page."), which drops "No account needed." Test mode keeps its two lines. Say no to keep both lines; PR 9's Task 9.2 is one commit.
- **Q3. "Not sent yet" position.** The board draws it above the Tip key in a pink box; states PR B (approved states boards) puts a slip under the key. Default: states PR B's version.
- **Q4. Claim moment without a name.** The name isn't known when the handle is claimed. Default: "Welcome to TipMe. People can start thanking you the moment your page is online." with no name; the card shows the handle.
- **Q5. The stamp sound.** No licensed file exists. Default: PR 6 ships silent; PR 10 synthesises our own sound (as `new-tip.wav` was) and waits for your yes.
- **Q6. The keepsake record.** Default: the board's server date `welcomed_at`; the Home card shows for 7 days from the first time it is seen (so someone who returns after a fortnight still sees it once).
- **Q7. Photo on the share card.** Default: no photo (initials), as the board drew.
- **Q8. Share card colour for photo covers and colourless designs.** Default: TipMe purple.
- **Q9. Manifest display.** Default: `browser` (keeps the address bar, including on the payment partner's page). `standalone` would look more like an app.
- **Q10. "TipMe opens at midnight in Lagos."** The date line now follows the launch time, but this sentence (page, description and share card) still says midnight. Default: unchanged words; a launch at another hour would need new copy from you.
- **Q11. The paper card on Coming soon** ("Drop it if you want the page to stay words-only"). Default: build it, hidden from screen readers.
- **Q12. QR proposals not drawn on the board** (three groups; Manrope lettering). Default: build both.
- **Q13. QR print proposals** (link once, paper pictures, cut lines, notices hidden on paper). Default: build all four.

## Reported, not fixed

- `ScreenAudit`: "Email verified" (`/verify-email`) is a tiny card and "ties to SignUpCelebration". Not on these boards; not planned.
- The home page's demo tip form keeps the old look after PR 8 (test copies only).
- The person card route renders on demand. It reuses the cached profile lookup, but each request still draws a PNG. Measure the render time in PR 2's report; if it matters, cache the PNG per handle and version next.
- `appreciation-form.tsx:61` says "The payment provider is unavailable right now." It names no provider, but the house wording is "our payment partner"; states PR B or H2 owns that string.
