# Screen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the redesigned public, tipper and recipient screens from the design canvas on the existing app, so the owner can review and approve every screen locally before anything goes to `dev`.

**Architecture:** Front end only, on branch `feat/screen-redesign` (worktree `.worktrees/screen-redesign`, from `origin/dev`). Shared physical materials go into `packages/ui` first; each later task rebuilds one group of screens against its board and adds those screens to a local review gallery. No API, contract, database or payment change. Work is committed locally and **not pushed** until the owner approves the gallery (Task 15).

**Tech Stack:** Next.js App Router (`apps/web`), `@tipme/ui` (`packages/ui`), plain CSS in `apps/web/src/app/globals.css` and `packages/ui/src/components.css`, Playwright e2e (`tests/e2e`), Node test runner for scripts.

**Spec:** `docs/design/redesign/README.md` and `docs/design/redesign/boards/*.dc.html` (the canvas, committed), governed by `docs/design/DESIGN-CONSTITUTION.md`, `COMPONENT-STANDARDS.md`, `TOKENS-AND-MATERIALS.md`, `EXPERIENCE-AND-MOTION.md` and `VISUAL-QUALITY-GATE.md`. Read the README's "decision wins" table before any board.

**Not in this plan (separate plans, each needs API and database work):**

- Staff set the Pro price (`OpsProPrice` board) and the Pro page shows it.
- Animated covers: Free picks from 3 that play once; Pro picks more and chooses slow loop or play once (`ScreenAnimatedCovers`).
- Live balance updates on the dashboard without a reload.

## Open decisions (owner)

1. **Home hero currencies: decided.** The owner chose the board's wording on 3 Nov 2026 ("use global payment. We'd work on that soon"): "receive global payments (USD, EUR, GBP, NGN, Stablecoins)". Recorded in `docs/design/DECISION-LOG.md`. Today TipMe takes naira only, so this line is a public claim ahead of the product.
2. **"Infrastructure (coming soon)" in the menu.** Built as a non-link item with that label and "Consume the Tipme APIs." (the owner's wording, with the doubled full stop fixed), unless the owner removes it.

## Global Constraints

- Materials, from `DESIGN-CONSTITUTION.md`: "60% Physical Interface, 30% Editorial Interface, 10% Playful Interface". No generic SaaS cards, indiscriminate pills, glass or blobs. Purple is a signature material, not background decoration (the individuals hero slab is the owner's endorsed exception).
- Raised actions "lose elevation and move 1–2px toward the canvas when pressed"; selected amount keys use the signature material plus a non-colour indicator (the white dot). Touch targets at least 44px.
- One black continuation action per floating card; purple on selected amounts and the header's primary action only.
- Fonts: DM Serif Display for display and headings, Manrope for everything else (already loaded in `apps/web/src/app/layout.tsx`).
- Money: minimum tip ₦2,000; standard amounts ₦2,000, ₦5,000, ₦10,000; minimum withdrawal ₦2,000 unless taking the whole balance; TipMe keeps 10% of each tip, processing included; the supporter pays exactly the amount shown, with no total step. Take amounts from the API or `@tipme/domain` (`FEE_POLICY_V1`, `STANDARD_TIP_PRESETS_MINOR`); never hard-code ₦1,000.
- Users never see the payment provider's name: say "our payment partner".
- Paid, confirmed and balance states come only from the API, never from a redirect or query string. Nothing celebrates until payment is confirmed.
- Reduced motion turns every animation off; forced colours keep every control's edge and the selected state visible.
- Copy: sentence case, plain words, active voice, no em dashes. Example people and notes on marketing pages are labelled as examples and never look like real data.
- No regulatory approval is implied by any screen (`docs/00-DECISIONS.md`).
- Only an intentional design change updates a screenshot baseline, explained in the commit (`VISUAL-QUALITY-GATE.md`).
- Every web build in this plan deletes `apps/web/.next/cache` first: a cached build served stale CSS on 3 Nov 2026.

## Review Focus

1. **Long and unbroken names and handles** (`LONG_NAME`, `UNBROKEN_NAME` in `tests/e2e/profile-fixtures.ts`) on every recipient-facing screen at 320px: no horizontal scroll, nothing clipped. Tests: Task 10 and Task 13.
2. **Forced colours:** raised keys, levers and wells lose their shadows, so each needs a border and the selected key its dot. Test: Task 2.
3. **Reduced motion:** the lever's slide, the demos on the marketing pages and the thank-you moment must not move. Tests: Task 2 and Task 8.
4. **Loading and failure on dashboard screens** keep today's behaviour after the restyle: skeleton first, a quiet retry on a brief 503, a clear error on a lasting one. Test: Task 10.
5. **Keyboard on the lever:** Tab enters once, arrow keys move and select, focus is visible. Test: Task 2.

---

### Task 1: Review gallery and committed boards

**Files:**

- Create: `scripts/review-gallery.mjs`, `scripts/review-gallery.test.mjs`, `scripts/review-screens.mjs`, `tests/review/playwright.config.ts`, `tests/review/screens.ts`, `tests/review/review.spec.ts`
- Modify: `package.json` (scripts `review:screens`, `review:serve`), `.gitignore` (`review-screens/`)
- Commit: `docs/design/redesign/README.md`, `docs/design/redesign/boards/` (already in the worktree)

**Interfaces:**

- Produces: `buildGallery(entries: GalleryEntry[]): string` where `GalleryEntry = { group: string; name: string; board: string; desktop: string; phone: string }` (relative PNG paths); `ReviewScreen = { group: string; name: string; board: string; open(page: Page, ctx: ReviewContext): Promise<void> }`; `SCREENS: ReviewScreen[]` in `tests/review/screens.ts`; `ReviewContext = { recipient(): Promise<{ handle: string }>; recipientWithTips(count: number): Promise<{ handle: string }> }`, built on `signUpRecipient` and `tipAsVisitor` from `tests/e2e/helpers.ts`.
- Every later task appends its screens to `SCREENS`.

- [ ] **Step 1: Write the failing test** in `scripts/review-gallery.test.mjs`:

```js
test('the gallery groups screens and shows desktop and phone side by side', () => {
  const html = buildGallery([
    {
      group: 'Public',
      name: 'Home',
      board: 'ScreenHome',
      desktop: 'public/home-desktop.png',
      phone: 'public/home-phone.png',
    },
    {
      group: 'Public',
      name: 'Pro',
      board: 'PagePro',
      desktop: 'public/pro-desktop.png',
      phone: 'public/pro-phone.png',
    },
  ]);
  assert.equal(html.match(/<h2>Public<\/h2>/g).length, 1);
  assert.match(html, /<img[^>]+src="public\/home-desktop\.png"/);
  assert.match(html, /<img[^>]+src="public\/home-phone\.png"/);
  assert.match(html, /ScreenHome/);
});

test('names are escaped', () => {
  assert.doesNotMatch(
    buildGallery([
      { group: '<b>', name: 'x', board: 'y', desktop: 'a', phone: 'b' },
    ]),
    /<b>/,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/review-gallery.test.mjs`
Expected: FAIL, cannot find `buildGallery`.

- [ ] **Step 3: Implement**
  - `scripts/review-gallery.mjs`: `buildGallery`, and when run directly, read `review-screens/manifest.json` and write `review-screens/index.html`.
  - `tests/review/playwright.config.ts`: the root config's `webServer`, `testDir: './tests/review'`, one worker, projects `desktop` (1440×900) and `phone` (390×844, `isMobile`).
  - `tests/review/review.spec.ts`: for each `SCREENS` entry, run `open`, wait for `document.fonts.ready`, take a full-page screenshot to `review-screens/<group>/<name>-<project>.png` with animations disabled, and append to `review-screens/manifest.json`.
  - `scripts/review-screens.mjs`: `build` deletes `apps/web/.next/cache`, builds with `NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:4100 NEXT_PUBLIC_PRETEND_DELIVERY=on`, runs `scripts/prepare-e2e-database.mjs`, the review config, then the gallery. `serve` starts the same web, API and worker as the e2e `webServer` and prints the screen URLs, plus "Sign-in codes are at http://127.0.0.1:3100/dev/inbox".
  - `package.json`: `"review:screens": "node scripts/review-screens.mjs build"`, `"review:serve": "node scripts/review-screens.mjs serve"`.
  - Seed `SCREENS` with the current home page (`/`) and `/@ada` so the gallery has content before any redesign.

- [ ] **Step 4: Verify**

Run: `node --test scripts/review-gallery.test.mjs && pnpm review:screens`
Expected: tests pass; `review-screens/index.html` exists and shows Home and Ada at both sizes.

- [ ] **Step 5: Commit**

```bash
git add scripts/review-*.mjs tests/review package.json .gitignore docs/design/redesign
git commit -m "chore(review): a local gallery of every redesigned screen, and the boards it is checked against"
```

---

### Task 2: Physical materials and the lever

**Files:**

- Modify: `packages/ui/src/components.tsx`, `packages/ui/src/components.css`, `packages/ui/src/index.ts`, `apps/web/src/app/design-system/page.tsx`
- Test: `tests/e2e/design-system.spec.ts` (create), update `tests/e2e/design-system.visual.spec.ts` baselines

**Interfaces:**

- Produces:
  - `Button`/`ActionLink` variant `'continue'`: the black continuation action (`TipJourney` `.go`).
  - `Surface` material `'instrument'` (the floating card, `.instrument`) and `'paper'` (receipt and note slips, `ScreenTipReport` `.receipt`/`.card`).
  - `Lever<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange(value: T): void })`: a radiogroup that looks like `PagePro` `.lever` (recessed track, purple sliding thumb).
  - Class `tm-well` for recessed read-outs and fields (`.well`).

- [ ] **Step 1: Write the failing tests** in `tests/e2e/design-system.spec.ts`:

```ts
test('the lever is one tab stop, and arrow keys move and select', async ({
  page,
}) => {
  await page.goto('/design-system');
  const lever = page.getByRole('radiogroup', { name: 'Plan' });
  // One tab stop: only the checked option is in the tab order.
  await expect(lever.getByRole('radio', { name: 'Pro' })).toHaveAttribute(
    'tabindex',
    '-1',
  );
  await lever.getByRole('radio', { name: 'Free' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(lever.getByRole('radio', { name: 'Pro' })).toBeChecked();
  await expect(lever.getByRole('radio', { name: 'Pro' })).toBeFocused();
});

test('pressing a raised action moves it down without its shadow', async ({
  page,
}) => {
  await page.goto('/design-system');
  const button = page.getByRole('button', { name: 'Continue' });
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const pressed = await button.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.up();
  expect(pressed).toMatch(/matrix\(1, 0, 0, 1, 0, (1|2)\)/);
});

test('in forced colours every key, well and lever keeps an edge, and the selected key its dot', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/design-system');
  for (const selector of ['.tm-choice span', '.tm-well', '.tm-lever'])
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopStyle),
    ).not.toBe('none');
  const dot = await page
    .locator('.tm-choice input:checked + span')
    .first()
    .evaluate((el) => getComputedStyle(el, '::after').content);
  expect(dot).not.toBe('none');
});

test('with reduced motion the lever does not slide', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/design-system');
  const thumb = page.locator('.tm-lever__thumb');
  expect(
    await thumb.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:e2e -- tests/e2e/design-system.spec.ts --project=desktop`
Expected: FAIL, no `Plan` radiogroup and no `Continue` button.

- [ ] **Step 3: Implement** the variants, materials and `Lever`, with values taken from the `TipJourney` and `PagePro` board CSS (`.key`, `.key.on`, `.well`, `.go`, `.soft`, `.instrument`, `.lever`). Show each on `/design-system`: a `Lever` labelled "Plan" with Free and Pro, a "Continue" button, a paper slip and a well.

- [ ] **Step 4: Verify**

Run: `pnpm test:e2e -- tests/e2e/design-system.spec.ts tests/e2e/design-system.visual.spec.ts`
Expected: new tests pass. The visual spec fails only where the page gained the new samples. Inspect the diffs, then rerun with `--update-snapshots` for darwin.

- [ ] **Step 5: Add** "Design system" to `SCREENS` (group `Foundations`), then run `pnpm review:screens`.

- [ ] **Step 6: Commit** with the baseline reason in the message.

---

### Task 3: "Who it's for" menu, desktop and phone

**Files:** `apps/web/src/components/navigation.tsx`, `apps/web/src/app/globals.css`; test `tests/e2e/navigation.spec.ts` (create).
**Board:** `ScreenHome` (desktop menu), `PhonePages` (phone menu).
**Interfaces:** none new.

- [ ] **Step 1: Failing tests**
  - `'Who it's for opens a menu of individuals, businesses and infrastructure'`: click "Who it's for"; expect `aria-expanded="true"` and links "Individuals" → `/for-creators` and "Businesses (coming soon)" → `/for-businesses`. "Infrastructure (coming soon)" is visible text, not a link (open decision 2). Escape closes the menu and returns focus to the button.
  - `'on a phone the menu button opens the same choices as raised cards'` (`--project=mobile`): open the menu, expect the same three items, each at least 44px tall.
- [ ] **Step 2: Run, expect FAIL** (no Individuals item, wrong labels).
- [ ] **Step 3: Implement** to the boards, keeping the current `aria-expanded` pattern.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/navigation.spec.ts tests/e2e/quality.spec.ts`. Expected: PASS.
- [ ] **Step 5: Add** "Menu open" (phone) to `SCREENS` (group `Public`), run `pnpm review:screens`, then commit.

---

### Task 4: Home

**Files:** `apps/web/src/app/page.tsx`, `apps/web/src/components/marketing.tsx`, `apps/web/src/app/globals.css`; test `tests/e2e/home.spec.ts` (create).
**Board:** `ScreenHome`. Hero headline "Let People Celebrate You for the things you do." (the owner's wording and capitals), the claim field with `usetipme.xyz/@`, three example people, and the tipped/tipping `Lever`.
**Interfaces:** consumes `Lever` and `Surface material="instrument"` (Task 2).

- [ ] **Step 1: Failing tests**
  - `'home switches between getting tipped and tipping with one lever'`: `getByRole('radiogroup', { name: 'Show the steps for' })`; "If you get tipped" is checked first, and the steps "Make it yours", "Share it anywhere" and "Get your thanks" show. Checking "If you're tipping" shows "Scan or tap", "Choose an amount" and "Say your thanks".
  - `'home states the fee and the minimum plainly'`: the page contains "TipMe keeps 10% of each tip" and no "₦1,000" anywhere (`expect(await page.content()).not.toContain('₦1,000')`).
  - `'home names global payments, as the owner decided'`: the hero paragraph contains "global payments (USD, EUR, GBP, NGN, Stablecoins)".
  - `'the hero tip demo uses the standard amounts'`: the example card shows the keys ₦2,000, ₦5,000 and ₦10,000.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** to the board. Opening copy follows payment mode (`paymentModeCopy`), not the board's "Tipping opens soon".
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/home.spec.ts tests/e2e/quality.spec.ts tests/e2e/shell.spec.ts`. Expected: PASS. Measure LCP with `pnpm perf:lab`: the home page must stay within the release check's 2000 ms on a throttled phone.
- [ ] **Step 5: Add** "Home" to `SCREENS`, run `pnpm review:screens`, then commit.

---

### Task 5: Individuals and businesses

**Files:** `apps/web/src/app/for-creators/page.tsx`, `apps/web/src/app/for-businesses/page.tsx`, `apps/web/src/app/for-businesses/business-interest-form.tsx` (style only), `apps/web/src/app/globals.css`; create `apps/web/src/components/marketing/where-you-meet-people.tsx` (client island).
**Board:** `PageCreators`, `PageBusinesses`.
**Interfaces:** consumes `Lever` (Task 2); produces `WhereYouMeetPeople()`, a client component with no props.

- [ ] **Step 1: Failing tests** in `tests/e2e/marketing.spec.ts` (create):
  - `'the individuals page shows a counter, a stream and a post'`: the radiogroup "Where you meet people" has "On a counter", "On stream" and "In a post", and choosing each shows its scene (`getByTestId('scene-counter' | 'scene-stream' | 'scene-post')`).
  - `'pressing Tip on the example drops a labelled example note'`: click "Tip ₦2,000" inside the demo; a slip appears in the tray, and the tray is labelled "Example".
  - `'the individuals page names creators and streamers and keeps one call to claim'`: the h1 is "People already want to thank you."; "Claim your username" links to `/sign-up`.
  - `'the businesses page only registers interest'`: the h1 is "TipMe for businesses is on its way."; submitting a valid work email shows "You're on the list."; no pricing or launch date anywhere.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The interest form keeps its existing API call; only the confirmed state and look change.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/marketing.spec.ts tests/e2e/quality.spec.ts`. Expected: PASS.
- [ ] **Step 5: Add** both screens to `SCREENS`, run `pnpm review:screens`, then commit.

---

### Task 6: Pro and pricing

**Files:** create `apps/web/src/app/pro/page.tsx` and `apps/web/src/components/marketing/plan-preview.tsx` (client island); modify `navigation.tsx` ("Pro" links to `/pro`) and `apps/web/src/lib/metadata.ts` if routes are listed there.
**Board:** `PagePro`.
**Interfaces:** produces `PlanPreview()`, no props.

- [ ] **Step 1: Failing tests** in `tests/e2e/pro-page.spec.ts` (create):
  - `'the Pro page flips a sample page between Free and Pro'`: radiogroup "Plan"; on Free, "Slow loop" is `aria-disabled="true"` and the handle line reads "Stays as you claimed it."; on Pro, "Change it" advances `usetipme.xyz/@ada` → `@adacuts` and stops after 3 changes.
  - `'Pro shows no price until staff set one'`: no `₦` amount next to "Pro"; the call to action is "Ask for Pro" and links to `mailto:support@usetipme.xyz?subject=TipMe%20Pro`.
  - `'both plans keep 10%'`: the page contains "TipMe keeps 10% of each tip on both plans."
- [ ] **Step 2: Run, expect FAIL** (404).
- [ ] **Step 3: Implement.** The two QR samples are static files, `apps/web/public/pro/qr-standard.svg` and `apps/web/public/pro/qr-hearts.svg`, made once with the existing renderer (`apps/api/src/qr/render.ts`) for `https://usetipme.xyz/@ada`, and scanned on a phone before committing. Never use `/_blob` URLs.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/pro-page.spec.ts tests/e2e/quality.spec.ts` (add `/pro` to its `routes`). Expected: PASS.
- [ ] **Step 5: Add** to `SCREENS`, review, commit.

---

### Task 7: How it works

**Files:** `apps/web/src/app/how-it-works/page.tsx`, `apps/web/src/components/marketing.tsx` (`HowItWorksSteps`), `globals.css`.
**Board:** `ScreenHowItWorks`.

- [ ] **Step 1: Failing tests** in `tests/e2e/marketing.spec.ts`:
  - `'how it works shows four steps for each side, and choosing a step changes the picture'`: radiogroup "Show the steps for"; 4 step buttons per side; clicking "Withdraw to your bank" shows "You can withdraw from ₦2,000." in the picture.
  - `'good to know answers cost, withdrawal and accounts'`: contains "TipMe keeps 10% of each tip", "Once your balance reaches ₦2,000" and "No. They only need your link or QR code".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The steps are real buttons with `aria-pressed`, not numbered decoration.
- [ ] **Step 4: Run** the marketing and quality specs. Expected: PASS.
- [ ] **Step 5: Add** to `SCREENS`, review, commit.

---

### Task 8: After Tip: waiting, thank-you, didn't go through, receipt

**Files:** `apps/web/src/app/tip/[tipId]/status-view.tsx`, `apps/web/src/app/tip/[tipId]/page.tsx`, `globals.css`.
**Board:** `TipJourney` (waiting, paid, failed), `ScreenThanks` (thank-you that becomes the receipt).
**Interfaces:** none new; status comes from the existing tip status API only.

- [ ] **Step 1: Failing tests** in `tests/e2e/checkout.spec.ts` (extend):
  - `'while checking, one quiet pulse and no celebration'`: hold the status at pending (route stub); expect "Checking your payment", one `[data-pulse]` element and no `.tm-celebration`.
  - `'once confirmed, one moment and then the receipt'`: the h1 is "Ada got your thanks." (role status); the receipt lists "Your tip", "Ada receives" (the tip less 10%) and the reference.
  - `'with reduced motion the confirmed screen does not animate'`: `document.getAnimations().filter(a => a.playState === 'running')` is empty after load.
  - `'didn't go through says nothing was sent and offers one next step'`: "Your tip to Ada wasn't sent." and one "Try again" link back to `/@ada`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep every existing receipt test green: the private link, expired and cancelled states, "pretend payment" wording in test mode.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/checkout.spec.ts tests/e2e/moments.spec.ts tests/e2e/pilot-notice.spec.ts`. Expected: PASS.
- [ ] **Step 5: Add** waiting, thank-you and failed to `SCREENS` (route stubs, as in the tests), review, commit.

---

### Task 9: Sign up, welcome, sign in, recovery, confirmations

**Files:** `apps/web/src/app/sign-up/`, `sign-in/`, `recover/`, `verify-email/`, `email/unsubscribed/`, `dashboard/welcome/`, `apps/web/src/components/account/auth-stage.tsx`, `email-code-form.tsx`, `handle-claim.tsx`, `globals.css`.
**Board:** `ScreenWelcome`, `ScreenAccess`. The code field stays one native input with `autocomplete="one-time-code"` and `inputmode="numeric"`, drawn as 6 cells. The board's on-screen keypad was a demo and is not built, because it would break autofill and screen readers.

- [ ] **Step 1: Failing tests** in `tests/e2e/accounts.spec.ts` (extend):
  - `'the code is one field shown as six cells'`: one `input[autocomplete="one-time-code"]`; typing `123456` fills 6 `.tm-code-cell` elements.
  - `'the welcome preview follows what you type'`: on `/dashboard/welcome`, typing "Maths tutor" into "What you do" shows it in the preview aside "Preview of your page".
  - `'recovery says what happens next whatever the address'`: after submitting any email: "If that email matches an account, the next step is on its way."
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** to the boards; the existing flows, rate limits and redirects are unchanged.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/accounts.spec.ts tests/e2e/welcome.spec.ts tests/e2e/recovery.spec.ts`. Expected: PASS.
- [ ] **Step 5: Add** sign in, code, recovery, welcome step 2, verified and unsubscribed to `SCREENS`; review; commit.

---

### Task 10: Dashboard, before the first tip, phone tab bar

**Files:** `apps/web/src/app/dashboard/home-view.tsx`, `dashboard-shell.tsx`, `apps/web/src/components/dashboard/*.tsx` (style and order only), `globals.css`.
**Board:** `ScreenDashboard`, `ScreenDashboardPhone`, `ScreenFirstDay`.

- [ ] **Step 1: Failing tests** in `tests/e2e/dashboard.spec.ts` (extend):
  - `'the balance comes first, with what is still being confirmed under it'`: the first heading inside `main` is "Ready to withdraw", followed by the balance and "still being confirmed" when a tip is pending.
  - `'on a phone the dashboard has a tab bar of four'` (mobile): `nav[aria-label="Dashboard"]` has Home, Tips, My page and Settings; it stays in view while scrolling; the current tab has `aria-current="page"`.
  - `'before the first tip, a checklist instead of empty numbers'`: a new recipient sees "Get your page ready to share" with 4 items, and no "Today" or "This week" figures.
  - Review Focus 4: `'a brief 503 retries quietly and a lasting one says so'` (move the existing test here if it lives elsewhere; assert both paths).
  - Review Focus 1: `'a long unbroken name fits at 320px'`: set the profile name to `UNBROKEN_NAME`, viewport 320 wide, `fitsViewport(page)` is true.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Data and API calls are unchanged; no live updates (a later plan).
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/dashboard.spec.ts tests/e2e/gaps.spec.ts tests/e2e/hardening.spec.ts`. Expected: PASS.
- [ ] **Step 5: Add** dashboard (with tips, via `recipientWithTips(3)`) and first day to `SCREENS`; review; commit.

---

### Task 11: Tips, tip detail, weekly report

**Files:** `apps/web/src/app/dashboard/tips/`, `dashboard/tips/[tipId]/`, `dashboard/reports/[week]/`, `apps/web/src/components/dashboard/activity-list.tsx`, `message-controls.tsx`, `globals.css`.
**Board:** `ScreenTips`, `ScreenTipReport` (receipt slip, press-through note stack).

- [ ] **Step 1: Failing tests** in `tests/e2e/reports.spec.ts` and `tests/e2e/gaps.spec.ts` (extend):
  - `'each tip reads like a message, with what you received and what was given'`: a row shows the net (₦1,800) and "from ₦2,000".
  - `'the tip detail is a receipt: tipped, TipMe's 10%, received'`: rows "TipMe fee (10%, includes processing)" (the existing fee label) and the received amount; "Hide this note" and "Report this note" still work.
  - `'the week's notes are a stack you press through'`: a button "Next note" shows the next note, and wraps after the last.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Search, filters and CSV export stay, out of the way.
- [ ] **Step 4: Run** the reports, gaps and hardening specs. Expected: PASS.
- [ ] **Step 5: Add** tips, a tip detail and a week to `SCREENS`; review; commit.

---

### Task 12: Withdraw

**Files:** `apps/web/src/app/dashboard/withdraw/withdraw-view.tsx`, `apps/web/src/lib/withdraw-state.ts` (read only), `globals.css`.
**Board:** `ScreenWithdraw` (with ₦2,000, not the board's ₦1,000).

- [ ] **Step 1: Failing tests** in `tests/e2e/withdraw.spec.ts` (extend):
  - `'Everything fills the whole balance, and under ₦2,000 it is the only way'`: with a ₦1,800 balance, "Everything" is offered and pressed, the amount reads ₦1,800, and the button "Withdraw NGN 1,800.00" is enabled.
  - `'the summary says where it goes, what arrives and what is left'`: "Going to", "You receive" and "Balance afterwards".
  - `'progress follows the real state only'`: with a stubbed payout in `processing`, two of three steps are filled and the label is "On its way".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Idempotency, the conflict message and every refusal state stay as they are.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/withdraw.spec.ts tests/e2e/withdrawal-controls.spec.ts tests/e2e/get-paid.spec.ts`. Expected: PASS.
- [ ] **Step 5: Add** to `SCREENS`, review, commit.

---

### Task 13: Settings and page editor

**Files:** `apps/web/src/app/dashboard/settings/settings-view.tsx` (split into `settings/sections/*.tsx` along the board's sections, since it is over 1,300 lines), `apps/web/src/components/account/cover-settings.tsx`, `globals.css`.
**Board:** `ScreenSettings`: sections My page, Getting paid, Notifications, Sign-in and security, Plan, Your data and page; live preview "What supporters see".
**Interfaces:** produces `SettingsSection` ids `'page' | 'paid' | 'notifications' | 'security' | 'plan' | 'data'` as URL hashes (`/dashboard/settings#paid`).

- [ ] **Step 1: Failing tests** in `tests/e2e/cover-settings.spec.ts` and `tests/e2e/gaps.spec.ts` (extend):
  - `'settings has six sections, each reachable by its link'`: `nav[aria-label="Settings"]` has the six names; `#paid` shows the bank card.
  - `'the preview shows unsaved edits as you type'`: typing a new "What you do" updates the preview before Save.
  - `'the preview offers the page's real amounts'`: the preview keys are ₦2,000, ₦5,000 and ₦10,000 for a Free page.
  - Review Focus 1: `'settings fits a long unbroken name at 320px'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Move code into sections without changing behaviour first and commit that refactor separately with all existing settings tests green, then restyle.
- [ ] **Step 4: Run** `pnpm test:e2e -- tests/e2e/cover-settings.spec.ts tests/e2e/gaps.spec.ts tests/e2e/pro.spec.ts tests/e2e/qr.spec.ts tests/e2e/automatic-cover.spec.ts`. Expected: PASS.
- [ ] **Step 5: Add** each section to `SCREENS`; review; commit.

---

### Task 14: Errors, not found, coming soon, legal layout

**Files:** `apps/web/src/components/page-unavailable.tsx`, `quiet-screen.tsx`, `tipping-opens-soon.tsx`, `legal-placeholder.tsx` (layout only), `apps/web/src/app/not-found.tsx`, `error.tsx`, `coming-soon/page.tsx`, `globals.css`.
**Board:** `ScreenSmall`.

- [ ] **Step 1: Failing tests** in `tests/e2e/quality.spec.ts` (extend):
  - `'a missing page names the handle and offers a way on'`: `/@tobi_s` shows "We can't find @tobi_s." with "Go to TipMe" and "Get your own page".
  - `'an error says it is on our side and gives a reference'`: force the error boundary; "It's a problem on our side and your account is fine." and a reference.
  - `'legal pages keep a readable width'`: the main column is at most 48rem wide.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Legal wording is not changed here (the Fees section on the Terms is the owner's, from 3 Nov 2026).
- [ ] **Step 4: Run** the quality and accounts specs. Expected: PASS.
- [ ] **Step 5: Add** to `SCREENS`, review, commit.

---

### Task 15: Whole-branch check and the owner's approval

- [ ] **Step 1: Run everything**, with no other test run on the machine:
      `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, then `node scripts/test-integration.mjs`, then `pnpm test:e2e`, then `pnpm perf:lab`.
      Expected: all pass, except the darwin-only design screenshot comparisons, which are explained.
- [ ] **Step 2: Build the gallery** with `pnpm review:screens`. Hand the owner `review-screens/index.html` and `pnpm review:serve` to click through. List every board difference you chose, one line each.
- [ ] **Step 3: Owner review.** Fix what the owner rejects, then repeat Steps 1 and 2. Record the approval, with its date, in `docs/design/DECISION-LOG.md`.
- [ ] **Step 4: Only then push and open the PR to `dev`.** Linux baselines come from CI's own render (download the `e2e-png-diagnostics-*` artifacts, inspect them, commit them), as for PR #102.
