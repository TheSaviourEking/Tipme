# Experience and motion

How TipMe should feel as people move through it: what moves, when, for how long, and what must stay still. It applies to every screen, including the redesigns in `docs/superpowers/specs/2026-11-01-profile-covers-qr-design.md`. `MOTION-AND-APPRECIATION.md` and the motion roles in `TOKENS-AND-MATERIALS.md` remain in force; this document applies them.

## 1. The feel

TipMe is a carefully engineered personal object. Controls respond like something you can press, screens arrive calmly, and warmth is saved for the moment appreciation is confirmed.

Motion is allowed for four reasons only:

1. **Pressure:** this control heard you.
2. **Continuity:** this is the same thing, in a new place.
3. **Hierarchy:** look here first.
4. **Confirmed acknowledgement:** the thanks arrived.

If an animation serves none of these, remove it.

## 2. Rules that never bend

- **Money never performs.** A balance never counts up, rolls, flies or fills. Amounts are readable and correct in every frame.
- **Nothing suggests money moved before the server says so.** No progress bar or animation may imply a payment or withdrawal is further along than its recorded state. "Waiting" and "checking" never borrow success choreography.
- **Success plays once, only for a trusted `paid` result.** Reloading or reopening a receipt shows the settled screen with no replay.
- **Motion never holds anything up.** A control works as soon as it's visible, and input during a transition is accepted. No animation gates the Tip, Pay or Withdraw action.
- **The payment moment stays still.** From choosing Pay until the provider page or result appears, only the button's busy state moves.
- **Scrolling belongs to the person.** No scroll hijacking, snapping that fights a thumb, or animation tied to scroll on a money screen.
- **Reduced motion is a full experience.** People who ask for it get the same final screen at once, with nothing lost.

## 3. Timing

Use the existing tokens. Don't add a duration without a decision-log entry.

| Role | Token | Value | Used for |
|---|---|---|---|
| Tactile | `--duration-tactile` | 150ms | Press, release, toggle, hover, focus |
| Component | `--duration-component` | 240ms | Disclosure, dialog, toast, field error, tab change |
| Spatial | `--duration-spatial` | 420ms | Page arrival, panel entry, shared-element move |
| Acknowledgement | `--duration-appreciation` | 760ms | The confirmed thank-you only |

- **Easing:** `--ease-physical` for nearly everything. `--ease-spring` only for the acknowledgement and a selected key settling. No bounce on anything to do with money.
- **Exits** take about two-thirds of the entry time, because people have already moved on.
- **Stagger:** at most 60ms per item, at most 4 items, and 420ms in total. Longer lists arrive together.
- **Distance:** entrances travel 8–16px. Nothing slides across the whole screen except a phone sheet.
- **Only `transform` and `opacity` animate.** Colour may transition on tactile states. Never animate height, width, top or left, because they cause layout shift and jank on the mid-range Android phones many Nigerian users carry.

## 4. Touch and press

| Element | Behaviour |
|---|---|
| Raised button or key | Press moves it 1–2px toward the canvas and reduces its shadow in 100ms. Release takes 150ms. |
| Amount key selected | Purple fill arrives in 150ms and the dot appears at the same moment. The total updates at once, with no fade. |
| Busy button | The label stays and a quiet indicator appears after 300ms, so fast actions never flicker. The button keeps its width. |
| Field error | Text appears in 240ms with a colour change. No shaking. Focus moves to the field. |
| Switch or segmented control | The thumb or pill slides in 150ms, with the text changing immediately. |
| Copy link | The label changes to "Link copied." for 2 seconds. The button keeps its width. |
| Vibration | One 10ms tick on confirmed thanks only, where the device supports it. Never for errors or routine taps. |
| Sound | None. |

Hover effects are subtle and never carry information. Everything must also work by touch and keyboard.

## 5. Moving between screens

- **Use the browser's View Transitions** where supported, and an instant change elsewhere. The site must never depend on them. Confirm the current Next and React support at build time; don't add an animation library for this. The constitution prefers CSS, and a runtime dependency needs documented evidence.
- **Default page change:** the old page fades out over 120ms and the new one fades in over 240ms, rising 8px. Navigation bars stay fixed.
- **Shared elements** continue where it helps understanding, in 420ms:
  - dashboard page card to My page editor;
  - tip row to tip detail;
  - QR thumbnail to full-screen code;
  - balance to the Withdraw screen's heading, with the number unchanged throughout.
- **Back** reverses the movement and restores scroll position exactly.
- **Loading:** show nothing for the first 200ms. After that, a skeleton in the shape of the real page. Real content replaces it without a jump, and space for images is reserved.
- **Page refreshes for new data** never replace the whole screen or reset scroll.

## 6. Scrolling

- **Native scrolling everywhere.**
- **Public profile, phone:** the Tip button stays in a bar fixed to the bottom while the form is usable. It sits above the on-screen keyboard's area, or hides while a field is focused if there's no room. It must never cover a field, an error or the footer's Report link.
- **Public profile, desktop:** the tipping panel stays in view while the left column scrolls, if the page is taller than the window. It stops at the footer.
- **Cover:** no parallax. It scrolls with the page, because parallax costs performance and adds nothing to tipping.
- **Anchors** (such as `#get-paid`) land below any fixed header, and wait for late-loading content before scrolling. The card briefly gets a 2px outline for 1 second to show where you landed.
- **Home page only:** sections may rise 12px and fade in once, as they enter view, using CSS scroll-driven animation where supported. Elsewhere they simply appear. Content is never hidden if scripts or the feature fail.
- **Long lists:** "Show more" appends without moving what's on screen. Focus goes to the first new item.
- **Scroll position** is kept when a dialog opens and closes.

## 7. Journeys

### 7.1 Supporter tipping: the most important flow

1. **Arrive from a QR or link:** the cover, photo and name are visible straight away, as server-rendered content. No entrance animation holds them back. The tipping panel rises 12px and fades in over 240ms.
2. **Choose an amount:** the key presses and the Tip button's amount changes instantly.
3. **Another amount:** the keyboard opens and the field stays in view. The quote updates after a short pause in typing, with the previous figure kept until the new one is ready, so numbers don't blink.
4. **Add a note:** the disclosure opens in 240ms, with no layout jump above it.
5. **Pay:** the button shows busy, then the provider's page. Stillness here signals seriousness.
6. **Return, waiting:** a calm screen with one quiet pulse. Plain words only, with no confetti, no checkmark and no progress bar. Copy changes without animation, and screen readers are told politely.
7. **Confirmed:** the thank-you (§7.2).
8. **Declined, expired or cancelled:** a quiet, distinct screen that appears straight away, without choreography, and with one clear next action.

### 7.2 The Appreciation Moment

The one place TipMe is allowed to perform, once per confirmed tip:

| Time | What happens |
|---|---|
| 0ms | The purple canvas and final text are in place and readable. The name and amount are never delayed. |
| 0–420ms | The photo scales from 0.92 to 1 with `--ease-spring`. |
| 200–760ms | One heart rises from behind the photo, and up to five small hearts drift outward and fade. They're drawn as SVG in TipMe's own shape, with nothing covering the text. |
| 760ms | Everything settles and stays still. |
| After | The receipt card rises 12px and fades in over 240ms. |

With reduced motion, the final composition appears at once. No looping and no sound. A reload shows the settled screen.

### 7.3 Recipient signing up

- Steps move sideways by 16px and fade over 240ms, in the direction of travel.
- The preview on the right updates with each keystroke, with no animation on text. A chosen photo or cover crossfades in 240ms.
- When the handle is available, the check appears in 150ms. Availability is checked after a pause in typing.
- **Going live** is a real milestone: the preview's frame gains a live indicator in 240ms, with one line of confirmation. It's not a celebration, because no money has moved.

### 7.4 Dashboard

- The balance is on screen immediately. Numbers never animate.
- **A new tip arrives (once live updates exist):**
  - the new row slides down from above in 240ms, and rows below follow with `transform` only;
  - the balance changes instantly with a 1-second soft highlight behind it;
  - a confirmed note gets the same highlight;
  - tips arriving together are grouped into one update, and a person reading further down the list isn't moved;
  - the screen reader announcement is polite, and at most one a minute, following the rule already in the decision log.
- A failed refresh keeps the last figures on screen, with a plain note about when they were updated.
- Empty states appear without animation.

### 7.5 Withdrawing

1. Tapping a quick amount fills the field instantly. No counting.
2. Pressing Withdraw opens a dialog for large or irreversible requests if the owner chooses one; otherwise the button goes busy.
3. On acceptance the form is replaced with "On its way" by a 240ms crossfade. The progress bar shows the recorded state only.
4. Progress steps fill in 240ms when the recorded state changes, never on a timer.
5. Paid arrives as a quiet colour and label change, with no celebration: the person is getting their own money, and a bank may not have shown it yet.
6. Failed uses a distinct, calm treatment, states that the money is back in their balance, and doesn't animate.

### 7.6 Cover and page editing

- Hovering or focusing a cover choice doesn't change the page. Selecting does, crossfading the live preview in 240ms.
- Colour changes crossfade in 150ms.
- An uploading image shows its real preview at once, with a quiet busy state until saved. On failure it returns to the previous cover.
- Save shows "Saved" in place for 2 seconds. The page doesn't scroll.

### 7.7 QR studio

- Choosing a design crossfades the preview in 240ms, with the old code kept until the new image has loaded, so the panel never blanks.
- **Full screen:** the thumbnail grows to fill the screen in 420ms, the background goes to solid white, and the screen is kept on where allowed. The code is completely still, because moving codes don't scan.
- **Pro preview for Free users:** the "Preview" mark is present from the first frame, never animated in, and the upgrade action is steady. No sparkle, nagging or pulsing.
- **Print view:** no animation at all.

### 7.8 Handle change confirmation

The dialog fades in over 240ms with the content rising 8px, and the background dims. Focus moves to the dialog and returns to the Change handle button on closing. Escape cancels. On a phone it's a sheet rising from the bottom. On success the new handle crossfades in, with a confirmation line.

### 7.9 Dialogs, toasts and menus

- **Dialog:** 240ms in, 160ms out. Focus is trapped, and page scroll is locked without shifting the layout.
- **Phone sheet:** rises in 420ms, with no drag-to-dismiss unless a close button also exists.
- **Toast:** rises 8px in 240ms, stays 4 seconds, and pauses while hovered or focused. Toasts never carry anything about money that isn't also on the screen.
- **Mobile menu:** opens in 240ms.
- **Notification bell:** the panel opens in 240ms. The badge changes without bouncing.

### 7.10 Admin (`/ops`)

Nearly still: tactile feedback and instant screens only. Staff need speed and accuracy, and money-affecting confirmations never animate beyond a standard dialog.

## 8. Accessibility

- `prefers-reduced-motion: reduce` removes movement, scale, stagger, view transitions and the appreciation choreography. Instant state changes remain; opacity changes of 150ms or less may stay.
- No flashing more than 3 times a second, anywhere.
- Motion is never the only signal. Every state has words, and selection has a non-colour mark.
- Focus is never lost during a transition, and focus rings are never clipped or animated away.
- Live regions are polite, except errors that block an action.
- Everything works at 200% zoom and 320px width, with no fixed viewport-height dependency, which matters when phone keyboards resize the screen.

## 9. Performance limits

- Cumulative layout shift below 0.1 on every page, and 0 on the Tip and Withdraw actions.
- Interaction to next paint below 200ms on a mid-range Android phone.
- The cover and name appear in the largest-paint measurement without waiting for any animation.
- No new runtime animation library without documented evidence. CSS first; a small script only where CSS can't do it.
- Effects that drop frames on a throttled phone are cut, not tuned.
- `will-change` only during an animation, and never left on.

## 10. How this is tested

- **Reduced motion:** Playwright runs each journey with reduced motion on, and every final screen must match.
- **Success stays honest:** waiting, checking, declined and cancelled screens have no acknowledgement animation, and a reload of a paid receipt doesn't replay it.
- **Money:** a test observes frames around a balance change and sees only the old and new values, never a figure in between.
- **Layout shift and responsiveness:** measured in Playwright with CPU throttling on the public page, checkout, dashboard and Withdraw.
- **QR:** no motion on a visible code after its image settles.
- **Scroll:** the fixed Tip bar never covers a focused field at 320px with the keyboard open; anchors land visibly; Back restores position.
- **Human review:** on a real mid-range Android phone and an iPhone, with the checks in `VISUAL-QUALITY-GATE.md`.

## 11. Order of work

Build motion with its screen, not afterwards:

1. Tactile states, reduced-motion rules and timing tokens, shared across components.
2. The public page and tipping flow, then the Appreciation Moment.
3. Withdraw.
4. Dashboard, and live-update behaviour when that work lands.
5. Page transitions and the home page's scroll entrances, last, because they're the least essential.
