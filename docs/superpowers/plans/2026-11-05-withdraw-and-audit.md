# Withdraw, redesigned, and the screen audit fixes: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things.

1. Rebuild Withdraw (`/dashboard/withdraw`) as the WithdrawRedesign board draws it, in every state. Money leads as a dark instrument. The three stacked notice boxes become one line on the instrument, one slip or one standing warning. Test mode becomes one pill in the header. The history becomes a ledger with stamps and step lamps.
2. Fix every screen the ScreenAudit board grades below the bar ("Off in places" or "Not TipMe"), except the screens other boards or running builders own (listed below).

**Owner's request:** the owner approved these canvas boards for building on 5 Nov 2026 (`.superpowers/program/planner-rules.md`). This is a visual and copy decision. It is not legal, regulatory or provider approval. No D-item in `docs/00-DECISIONS.md` changes. Nothing about fees, the ₦2,000 minimum, checkout, payouts, the ledger, the partner quote cache or any API changes. No API, contract, database or migration change in any PR of this plan.

**Boards (static HTML, read as specs),** in `/private/tmp/claude-502/-Users-dev-Workspace-SynqHQ-Tipme/579273e2-08df-4bbd-a0e2-911e1324953c/scratchpad/canvas-email/project/`:

- `WithdrawRedesign.dc.html`: "Withdraw, redesigned". Section 1 is ready to withdraw (desktop and phone). Section 2 covers below the minimum, no bank, paused, and one withdrawal just requested. Section 3 covers a failed row, the not-confirmed slip and the test-mode pill. Then "What changes" and "Rules kept, and copy".
- `ScreenAudit.dc.html`: "Screen audit: what isn't TipMe yet". All 39 screens graded, the "Across the app" findings, and the routes and states with no screenshot.

The screens' own boards, already in the repo at `docs/design/redesign/boards/`, are the design for the audit fixes: `ScreenAccess`, `ScreenTips`, `ScreenTipReport`, `ScreenSettings`, `ScreenDashboard`, `TipJourney`, `PageBusinesses`. Where the audit asks for a composition that no board draws, this plan writes it down as a **plan proposal**. Each such PR attaches before and after shots from `pnpm review:screens` for the owner.

**Architecture:** Front end only (`apps/web`, plus two small primitives in `packages/ui`). Withdraw's state model stays in `apps/web/src/lib/withdraw-state.ts`, a pure module with unit tests. It gains the lamp line and where the explanation goes. The page (`withdraw-view.tsx`) stays one client component and makes the same three reads (`usePanel` for `/v1/me/dashboard`, `/v1/me/withdrawal-quote` and `/v1/me/withdrawals`, each `ONCE` or whatever live config dev has when the builder starts). The quote read goes through the server cache from #118 (`PartnerQuoteCache` in `packages/database/src/operations/payouts.ts`, `RedisPartnerQuoteCache` in the API). This plan adds no read, poll or refetch of it. The audit fixes are layout and CSS, plus small markup changes in each screen's component. They use the states primitives that PR A put on dev (`Slip`, `StandingWarning`, `Lamp`, `Steps`, `StateLine`, `EmptySlip`, the field's red edge and flag in `packages/ui/src/components.tsx`, and `ResultKey` in `result-key.tsx`).

**Tech stack:** `@tipme/ui` (React 19.3, plain CSS in `components.css` and `tokens.css`, `node --test` on the built `dist`), Next.js 16.4 App Router (`apps/web`, `node --test` importing `.ts` directly), Playwright 1.64 (`tests/e2e`), `pnpm review:screens` (`tests/review/screens.ts`). No new dependency.

**Read on `origin/dev` `931a545`** (5 Nov 2026, after #127). Line numbers below are from that commit.

---

## Who owns what (read before starting any PR)

### Withdraw: this plan takes over states PR E

The states plan (`docs/superpowers/plans/2026-11-05-states.md`, Task 12, "PR E. Withdraw") migrates the same five withdraw notices, the uncertain answers, the failed rows and the step lamps. WithdrawRedesign was drawn after the states plan, on top of it, and the owner approved it. It redraws every element Task 12 would build:

| Element                    | States Task 12                              | WithdrawRedesign (wins: the approved design)                                                                                                   |
| -------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| "Ready to withdraw" notice | neutral slip                                | a lamp line on the instrument: "Ready to withdraw ₦5,400", and the bank as a chip                                                              |
| Test withdrawal notice     | neutral slip                                | a pill in the dashboard header                                                                                                                 |
| Paused                     | neutral slip                                | a standing warning, and "Paused for now" on the instrument                                                                                     |
| No bank                    | neutral slip                                | a slip with the stamp "Needs a bank", and "Add a bank to withdraw" on the instrument                                                           |
| Withdrawal requested       | done slip with `Steps` inside               | a done slip, one line, no steps (the row in the ledger carries them)                                                                           |
| Could not confirm          | stamp "Check first", title "Not confirmed"  | stamp "Not confirmed", title "We couldn’t confirm your withdrawal", body "Check your dashboard before trying again." (today's sentence, split) |
| Below the minimum          | flag "below 2,000" after the server refuses | red edge and "Too small. The smallest withdrawal is ₦2,000, or your whole balance if it’s less." before pressing                               |
| Failed row                 | dense error slip in the row                 | a ledger row: amount, stamp "Failed", today's note, and the proposed line "Back in your balance: ₦12,500"                                      |

**Ruling:** this plan's PRs W1 and W2 own everything on the Withdraw page, including Task 12's non-negotiables (carried over below: the money-line tests, no safe line on the unconfirmed slip, the key-keeping rules, the `.withdraw > .tm-notice` CSS, no `Notice` left in `withdraw-view.tsx`). **States PR E is not built.** The states plan should mark Task 12 "moved to `withdraw-and-audit` W1/W2". If a states builder has already built PR E by the time W1 starts, W1 starts from that code. Every test below asserts the end state, not a diff, so the tasks still apply.

### Everything else

| Area                                                                                                                              | Owner                                                                        | What this plan does                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notices on public pages, `status-view.tsx:211` "Connection lost", the tip form                                                    | states PR B (builder running, `.worktrees/states-b`)                         | R1 (receipt layout) starts after B merges. It doesn't touch the tip form.                                                                                                                                                                                |
| `recover-flow.tsx` "Your account will move" slip, code cells                                                                      | states PR C                                                                  | A1 starts after C merges and restyles the layout only.                                                                                                                                                                                                   |
| `dashboard-shell.tsx` suspended and attention notices, `tips-view.tsx:133` and `:221`, `tip-view.tsx:39`, `home-view.tsx` notices | states PR D                                                                  | D1 starts after D merges. W1 changes two other lines in `dashboard-shell.tsx` (the badge at `:137`, and the attention list's filter at `:165`). Whichever lands second merges.                                                                           |
| The recovery-email reminder's look (a standing warning)                                                                           | states PR D (dashboard-shell `:173`)                                         | W1 only decides **where** it shows: Home and Settings (WithdrawRedesign, "What changes").                                                                                                                                                                |
| Settings notices and save keys                                                                                                    | states PR F                                                                  | S1 starts after F merges.                                                                                                                                                                                                                                |
| Settings "Make it yours" start amount, pinned note                                                                                | make-it-yours PR B (running, `.worktrees/miy-start-amount`) and PR D         | S1 starts after both merge. It changes layout CSS and the preview's placement, not their cards.                                                                                                                                                          |
| Settings "Get help", "Your supporters"                                                                                            | `pro-additions` plan                                                         | S1 rebases onto whatever has landed. Its tests select chapters by heading, not by order.                                                                                                                                                                 |
| Withdraw's `usePanel` live config                                                                                                 | live updates PR 2 (running, `.worktrees/live-updates-2`, Task 14)            | W1 and W2 never change the three `usePanel` calls. Whatever `live:` PR 2 gives them stays. PR 2's test "a pretend payout paid changes the status… the status reads `Paid`" keeps passing, because the stamp's text is "Paid" and capitals come from CSS. |
| Tip page `/@handle` (the old composer)                                                                                            | TipForm board (awaiting the owner)                                           | Not planned.                                                                                                                                                                                                                                             |
| The email-verified celebration                                                                                                    | SignUpCelebration board (awaiting)                                           | A1 gives `/verify-email` the account layout only. No celebration.                                                                                                                                                                                        |
| `/ops/*`, QR studio, QR print, coming soon                                                                                        | `emails-and-admin` plan, QrStudio, QrPrint, ComingSoon boards                | Not planned. The slim footer (X1) is for the recipient dashboard only. `emails-and-admin` hides the footer in `/ops`.                                                                                                                                    |
| Design system "pink and green notice boxes"                                                                                       | fixed by states PR A (#124): `design-system/page.tsx` has no `Notice` on dev | X1 re-shoots it. Nothing to build.                                                                                                                                                                                                                       |
| Dashboard: top tabs or left sidebar                                                                                               | the owner (DesignMap: "Owner asked which to keep")                           | Not built. Default: keep the top tabs (WithdrawRedesign, approved 5 Nov, draws them). See "Open for the owner" 1.                                                                                                                                        |
| Privacy page (thin placeholder)                                                                                                   | needs the legal text (D-02, D-07)                                            | Not planned. See "Open for the owner" 4.                                                                                                                                                                                                                 |

### Audit screens below the bar, and where each is fixed

| Screen (audit grade)                   | Fix                                                                                      | PR     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| Withdraw (Not TipMe)                   | WithdrawRedesign                                                                         | W1, W2 |
| Withdraw, one on its way (Not TipMe)   | WithdrawRedesign                                                                         | W1, W2 |
| Businesses (Off)                       | composed first screen                                                                    | P1     |
| Waiting `/tip/[id]` (Off)              | composed desktop stage                                                                   | R1     |
| Didn't go through `/tip/[id]` (Off)    | composed stage, plus the paper edge and the "Not sent" stamp                             | R1     |
| Sign in (Off)                          | auth stage tightened                                                                     | A1     |
| Recovery (Off)                         | one way out under the key, and the facts in primary ink                                  | A1     |
| Recovery sent (Off)                    | the paragraph split into a status line and three short lines                             | A1     |
| Email verified (Off)                   | the auth stage, as on sign-in                                                            | A1     |
| Dashboard with tips (Off)              | the side column: right column thin (nag: W1 and states D; tabs: owner)                   | D1     |
| Before the first tip (Off)             | nag only: W1 (where) and states D (look)                                                 | W1     |
| Tips (Off)                             | money set as an instrument, the ledger rows, and a side column                           | D1     |
| Tip detail (Off)                       | receipt composed at full measure, with the note beside it                                | D1     |
| Weekly report (Cohesive, nag)          | W1 (where the reminder shows)                                                            | W1     |
| Settings, all six shots (Not TipMe)    | layout composition, and a deep link that lands on its section                            | S1     |
| Design system (Off)                    | already fixed by states PR A; re-shot                                                    | X1     |
| Tip page (Off)                         | TipForm board                                                                            | none   |
| Privacy (Off)                          | waits for the text                                                                       | none   |
| Across the app: slim footer, skip link |                                                                                          | X1     |
| No screenshot yet (states)             | Withdraw states in W1 and W2, receipts in R1, the bell in X1, Settings first views in S1 | each   |

---

## Money-safety proofs (the only reassuring money lines on Withdraw)

Re-checked on `931a545`. A builder who finds any line moved re-checks the proof before writing the words.

| Line                                                                                      | Where it shows                                                                        | Proof on `origin/dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "It didn’t go through, so the money is back in your balance." (today's)                   | ledger, a row the API reports as `failed`                                             | `payouts.ts:676` posts the payout's ledger debit only when `to === 'PAID'`. `:728`–`:729` handle `to === 'FAILED'` with `releaseFailedPayout` (`:516`–`:530`), which frees the payout's tips. The staff-decided failure uses the same function (`:553`). `balance.ts:11`–`:12` reserve only `REQUESTED` and `PROCESSING` payouts, so a `FAILED` one no longer counts against the balance. The row's state comes from `dashboard.ts:322` (`WHEN 'FAILED' THEN 'failed'`). |
| "Back in your balance: ₦X" (Proposed on the board), X = the row's `amountMinor`           | the same failed row, nowhere else                                                     | The same proof. The reserved amount that is released is the payout's `amount_minor` (`balance.ts:11`), so X is that row's amount.                                                                                                                                                                                                                                                                                                                                        |
| none                                                                                      | a `reversed` row                                                                      | Its note already says "Your balance shows where the money is." No safe line.                                                                                                                                                                                                                                                                                                                                                                                             |
| none                                                                                      | "We couldn’t confirm your withdrawal" and "This withdrawal may already be on its way" | The request may have arrived (`withdraw-state.ts:174`–`:175`). The key stays (`withdraw-view.tsx:223`), so the same amount again can't withdraw twice. A test asserts the slip has no safe line and no money words.                                                                                                                                                                                                                                                      |
| "Withdrawals are paused for now. Your balance is safe." (today's, kept)                   | the paused warning, switch off                                                        | **Kept, not added.** What the code proves is that no withdrawal starts while the switch is off: `payouts.ts:1323`–`:1324` (before any partner read) and `:1358`–`:1359` (under the lock) refuse, and `payout-start.ts:480` holds queued ones. See "Open for the owner" 3.                                                                                                                                                                                                |
| "Your tips are safe, and your balance stays here until withdrawals open." (today's, kept) | collected elsewhere                                                                   | Kept word for word. Not touched.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

No other money line is added anywhere in this plan. In particular, the instrument says "Available" and "Ready to withdraw ₦X", both of which are today's figures (`summary.availableMinor` and `withdrawableNow()`). There is no "safe", "protected" or "guaranteed" line on the instrument.

**Privacy:** the Tips list keeps `hasMessage` only. ScreenTips draws the note's text in the row, but the list API (`MyTipRow`) does not send it, and this plan changes no API. Messages stay on the tip detail, as today. No supporter detail is added to any screen.

---

## Global Constraints

- **Dev wins for behaviour, the board for the design.** Where they differ, the plan says which it chose:
  - The quote's fee line stays. When `feeMinor` is not `'0'`, "TipMe pays the ₦50 transfer fee." shows on the instrument under the lamp line. The board's sample uses the test bank, which has no fee. Dev's line is payment clarity, so it wins.
  - `withdrawableNow()` decides "Ready to withdraw ₦X", as the board says. Dev's notice said `quote.withdrawableMinor`, which is never more than the balance in practice, but the board's rule is the safer one.
  - The bank line under a row keeps `bankLine()` (`lib/withdrawal-bank.ts`): "to GTBank ••6789". The board's capital "To" comes from CSS (`::first-letter`), so tests that read `textContent` are unaffected.
  - Stamp words are the existing labels in `describe()` (`withdraw-view.tsx:42`–`:87`): Paid, Failed, Reversed, Being checked, On its way, Requested. The board's capitals come from `text-transform: uppercase`. A screen reader reads the word, not the letters.
- **Retry safety** (financial invariant: "Never retry non-idempotent external money movements blindly"). `POST /v1/me/withdrawals` is never retried, never sent on reconnect, and never sent by any new key on the page. The rules on `withdraw-view.tsx` stay exactly as they are:
  - `key.current ??= crypto.randomUUID()` (`:207`);
  - the key resets only after `result.ok` (`:217`), a refusal with `message === null` (`:223`), a different amount chosen (`:255`–`:260`) or the text changed (`:332`–`:335`);
  - tapping the amount already chosen keeps the key and the warning (`:257`).
  - The new "Too small." check never sends a request and never touches the key.
- **The quote cache.** No new read of `/v1/me/withdrawal-quote`. A visit reads it once. A refusal with `reload: true` reads it once more (`:224`). A test counts this (W1, Task 6). Nothing polls it, and no lamp, stamp or step animation triggers a read.
- **Rules for both state concepts** (StatesConcepts "Rules for both"): no tinted alert boxes; no "!" or "✓" in front of words; colour is never the only signal, so every lamp and stamp sits beside words; errors are `role="alert"`, the unconfirmed slip is an alert, and warnings and done are polite `status`.
- **Purple is a signature material:** a lamp, a stamp, a selected key. Never a background wash. The dark instrument uses `--key-face-dark` (`#141210`, `tokens.css:41`), not purple. A purple stamp is used only for "On its way", "Requested" and "Being checked" in the ledger (the board's `s-wait`). A slip's purple stamp stays reserved for `done` (states rule). So the "Needs a bank" slip's stamp is ink, not the board's purple: see "Open for the owner" 6.
- **Tokens:** `components.css` holds no hex colour (`packages/ui/test/primitives.test.mjs`). New colours are tokens in `tokens.css`, each declared once (`design-tokens.test.mjs`). New tokens in this plan are `--text-on-night: #ffffff`, `--text-on-night-quiet: #c9c4ba`, `--link-on-night: #c9aeff` and `--stamp-ok: var(--state-success)`. Check contrast: `#c9c4ba` on `#141210` is about 10:1, and `#c9aeff` on `#141210` about 9:1.
- **Touch targets** are at least 44px: the bank chip's Change link, the pill, quick amounts and Show more.
- **Motion:** only the states primitives' own motion (the field's one shake, a lamp's fade). Nothing new moves. `prefers-reduced-motion: reduce` changes nothing beyond what the primitives already handle.
- **Forced colours:** the instrument, the chip, the pill, the stamp and every ledger row keep a `CanvasText` edge. Lamps already have one (`components.css`, Task 1 of the states plan).
- **Live regions stay mounted** where they are today. The receipt's `tip-status-live` (`status-view.tsx:256`–`:264`) is never moved in the DOM. R1 moves it with CSS grid only.
- **Copy:** sentence case, plain words, active voice, no em dashes, curly apostrophes. Users never see the payment provider's name ("our payment partner"; `apps/web/test/no-provider-names.test.mjs`). Nothing implies regulatory approval. Pronouns are "they".
- **Words don't change** except for those listed in "New words" below.
- **Baselines:** only an intentional design change updates a screenshot baseline. Run the visual spec without update mode, inspect the diffs, explain the change in the commit, then `--update-snapshots` (`docs/design/VISUAL-QUALITY-GATE.md`). No PR here is expected to change `design-system.visual` or `profile.visual` baselines. If one does, stop and say why.
- **Builds:** every web build deletes `apps/web/.next/cache` first. Build for e2e with `node scripts/build-e2e.mjs`. Run e2e on your lane only (`export E2E_LANE=<n>`), and `pnpm test` with `E2E_LANE` unset (`.superpowers/program/builder-rules.md`).
- **No `Notice` or `EmptyState` in any file this plan touches.** Where a touched file still has one that a states batch owns, leave it for that batch, unless the batch has merged. In that case it is gone already.

### New words (all others are today's)

| Words                                                                                                                              | Where                                                                                       | Status                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| "Ready to withdraw ₦X"                                                                                                             | instrument lamp line                                                                        | board                                                                               |
| "Add a bank to withdraw"                                                                                                           | instrument, no bank                                                                         | board                                                                               |
| "Paused for now"                                                                                                                   | instrument, paused                                                                          | board                                                                               |
| "Too small. The smallest withdrawal is ₦2,000, or your whole balance if it’s less."                                                | amount field, below the minimum                                                             | board (Proposed). ₦2,000 comes from `FEE_POLICY_V1.minWithdrawalMinor`, never typed |
| Stamps "Needs a bank", "Not confirmed"                                                                                             | slips                                                                                       | board (Proposed)                                                                    |
| "Back in your balance: ₦X"                                                                                                         | failed row                                                                                  | board (Proposed), proven above                                                      |
| "Test mode · no real money moves" (pill), and the pill opens "No real money moves in test mode. The test bank pays straight away." | dashboard header, test mode only                                                            | board (Proposed). The sentence is today's `withdrawNotice`                          |
| "Our payment partner is checking it."                                                                                              | replaces `withdraw-state.ts:40` "Your withdrawal is being checked by the payment provider." | board ("Copy to settle"). It matches the row's note at `withdraw-view.tsx:70`       |
| Stamp "Not sent"                                                                                                                   | receipt, declined                                                                           | plan proposal (the states plan's stamp word for a tip that wasn't sent)             |

---

## Review Focus

1. **Money lines appear only where proven.** `apps/web/test/withdraw-money-lines.test.mjs` (W1 and W2) fails if any of these hold:
   - "back in your balance" appears in any file under `apps/web/src` except `app/dashboard/withdraw/withdraw-view.tsx` and `app/design-system/states-specimen.tsx`;
   - in `withdraw-view.tsx`, a `safe`/"Back in your balance" appears outside the `failed` branch of the row rendering;
   - the `unsure` slip has a `safe` prop, or its words match `/money|balance|paid|safe/i`.
     Check by hand that the instrument has no reassurance line.
2. **The key.** The idempotency key behaves exactly as before. The `withdraw.spec.ts` tests at `:508` ("tapping the amount already chosen keeps the request key and the warning") and `:533` ("changing the amount makes a new request key") pass unchanged. The new test "the unconfirmed slip keeps the key: Withdraw again sends the same key" is added. "Too small." never sends anything.
3. **One quote read per visit.** Test: "a visit reads the quote once, and a refusal over the amount reads it once more" (W1, Task 6).
4. **States are announced once.** The unconfirmed slip is `alert`. The done slip, the paused warning and the no-bank slip are `status`. Ledger rows have no live role. The "Too small." line is the field's `alert`, shown on blur or submit, not per keystroke.
5. **The live updates PR 2 tests still pass**, if it has merged: `withdraw.spec.ts` "a pretend payout paid changes the status in an open tab without a reload" and `withdrawal-controls.spec.ts` "turning withdrawals off shows in an open Withdraw tab within 15 s".
6. **Phone:** instrument, form, ledger, in that order, clear of the fixed tab bar at 320px and 360px, with `LONG_NAME` and `UNBROKEN_NAME` banks. `fitsViewport` holds in every state.
7. **Forced colours and reduced motion** on the instrument, the chip, the pill and the stamps.
8. **Audit PRs change layout, not behaviour.** Each audit PR's e2e suite for its screens passes with only selector updates. The PR lists every test it changed and why.

---

## PR boundaries and merge order

| PR     | Tasks | Scope                                                                                                                                                                        | Depends on                                        |
| ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **W1** | 1–6   | Withdraw: the boards in the repo, the state model, the test-mode pill, where the recovery reminder shows, the instrument, the form, slips and warnings, layout, review shots | none (states PR A is on dev)                      |
| **W2** | 7–9   | Withdraw: the `Stamp` primitive and the ledger (rows, stamps, step lamps, the failed row's balance line)                                                                     | none. Merge after W1 if both are open (same file) |
| **A1** | 10–12 | Account: sign in, recovery, recovery sent, email verified                                                                                                                    | states PR C merged                                |
| **R1** | 13–14 | Tip receipt: waiting, checking, didn't go through, expired: a composed desktop stage and the declined slip look                                                              | states PR B merged (running now)                  |
| **D1** | 15–17 | Dashboard: Tips, Tip detail, Home side column                                                                                                                                | states PR D merged                                |
| **P1** | 18    | For businesses: a composed first screen                                                                                                                                      | none                                              |
| **S1** | 19–21 | Settings: composition, a deep link that lands on its section, first-view shots                                                                                               | states PR F, make-it-yours PR B and D merged      |
| **X1** | 22–24 | Across the app: slim footer in the recipient dashboard, the skip-link check, the bell shot, re-shoot and re-grade                                                            | W1, W2, A1, R1, D1, P1, S1 (last)                 |

**Proposed order:** W1, then W2 (the owner's priority, and nothing blocks it). P1 can go any time. Then A1, R1 and D1, each as soon as its states batch merges. Then S1, then X1.

Each PR is independently shippable: no PR leaves a screen half-done. W1 without W2 ships the new instrument above today's history list, restyled only by the `.withdraw__history` rules it already has.

---

## PR W1: Withdraw, the instrument, the form and the states

### Task 1: Commit the two boards

**Files:**

- Create: `docs/design/redesign/boards/WithdrawRedesign.dc.html` and `docs/design/redesign/boards/ScreenAudit.dc.html`, copied byte for byte from the canvas export. If the export references `./support.js`, check how the other committed boards handle it (`git show origin/dev:docs/design/redesign/boards/StatesConcepts.dc.html | head -8`) and do the same.
- Modify: `docs/design/redesign/README.md`. Add two rows to the board table, in its format: WithdrawRedesign "Withdraw in every state (approved 5 Nov 2026)", and ScreenAudit "Every screen graded against the design rules (5 Nov 2026)".
- Modify: `docs/design/DECISION-LOG.md`. Add a "2026-11-05: Withdraw, redesigned" entry: the dark instrument, the test-mode pill, the ledger stamps, "Too small." before pressing, "Back in your balance: ₦X" only on failed rows (proof cited), and the unconfirmed slip with no money words. Say that this is a visual decision, not a regulatory approval. Say also that the states plan's Task 12 moved here.

- [ ] **Step 1:** copy, edit, `pnpm format:check`.
- [ ] **Step 2: Commit** `docs(design): the Withdraw redesign and screen audit boards`.

### Task 2: The state model: a lamp line and where the explanation goes

**Files:** Modify `apps/web/src/lib/withdraw-state.ts`. Test `apps/web/test/withdraw-state.test.mjs`.

**Interface** (additive: `notice`, `review`, `canWithdraw`, `showForm`, `kind`, `withdrawRefusal` and `withdrawableNow` keep their meaning):

```ts
import type { LampTone } from '@tipme/ui';

export interface WithdrawState {
  // …existing fields…
  /** Where the notice's words go: on the instrument (one line, no box), in a slip, or a standing warning. */
  place: 'instrument' | 'slip' | 'warning';
  /** The ink stamp on the slip, when there is one. */
  stamp?: string;
  /** The page-level "being checked" line: our payment partner is checking a withdrawal under way. */
  review: string | null; // now 'Our payment partner is checking it.' (board "Copy to settle")
}

/** The one lamp line on the instrument (WithdrawRedesign §1–2). Only from the state and withdrawableNow(). */
export function withdrawLamp(
  state: WithdrawState,
  withdrawableMinor: bigint,
): { tone: LampTone; text: string };

/** The refusals that leave the amount field: they may have followed a request that arrived. */
export function withdrawUnsure(code: string | undefined): {
  title: string;
  body: string;
} | null;
```

**The mapping** (the board where it draws the state; otherwise today's title, so no new words):

| `kind` (and case)                    | `place`      | lamp tone and text                                          | stamp           |
| ------------------------------------ | ------------ | ----------------------------------------------------------- | --------------- |
| `ready`, `withdrawableNow > 0`       | `instrument` | purple, `Ready to withdraw ${formatNaira(withdrawable)}`    | none            |
| `ready`, nothing to withdraw         | `instrument` | off, "Nothing to withdraw right now" (today's title)        | none            |
| `provider_unavailable` (or no quote) | `instrument` | amber, "We can’t check your balance" (today's title)        | none            |
| `no_destination`                     | `slip`       | off, "Add a bank to withdraw" (board)                       | "Needs\na bank" |
| `setup_needed`                       | `instrument` | off, "Finish your setup" (today's title)                    | none            |
| `destination_pending`                | `instrument` | amber, "Your bank account is being checked" (today's title) | none            |
| `paused` (both reasons)              | `warning`    | amber, "Paused for now" (board)                             | none            |
| `collected_elsewhere`                | `instrument` | off, "Withdrawals aren’t available yet" (today's title)     | none            |

With `place === 'instrument'`, the notice's `body` (and its link, when it has one) is one plain line under the lamp line. With `ready` and something to withdraw, the body is **not** shown: the lamp line and the bank chip say it. The fee sentence stays: see Task 4.

`withdrawUnsure`:

- `IDEMPOTENCY_CONFLICT` gives title "This withdrawal may already be on its way", body "Check your dashboard before asking again." (today's sentence, split at the full stop).
- Any code that `withdrawRefusal` sends to its catch-all gives title "We couldn’t confirm your withdrawal", body "Check your dashboard before trying again."
- Every other code (`SHOWN_BY_PAGE`, `INSUFFICIENT_BALANCE`, `WITHDRAWAL_TOO_SMALL`) gives `null`.

`withdrawRefusal` is unchanged, and its `message` keeps today's whole sentence for those codes. The view uses `withdrawUnsure` to decide that the words go to the slip, not to the field.

- [ ] **Step 1: Write the failing tests** in `withdraw-state.test.mjs`. Keep every existing test. Add:

```js
test('the lamp line follows the state, and ready says what can go now', () => {
  const r = of(ready({ withdrawableMinor: '540000' }));
  assert.deepEqual(withdrawLamp(r, 540000n), {
    tone: 'purple',
    text: 'Ready to withdraw ₦5,400',
  });
  // The most that can go now, not the quote: withdrawableNow() is passed in.
  assert.equal(withdrawLamp(r, 300000n).text, 'Ready to withdraw ₦3,000');
  assert.equal(r.place, 'instrument');
});
test('no bank is a stamped slip; a pause is a standing warning; the rest stay on the instrument', () => {
  const bank = of({ state: 'no_destination', inReview: false });
  assert.equal(bank.place, 'slip');
  assert.equal(bank.stamp, 'Needs\na bank');
  assert.deepEqual(withdrawLamp(bank, 0n), {
    tone: 'off',
    text: 'Add a bank to withdraw',
  });
  for (const reason of ['switched_off', 'held']) {
    const paused = of({ state: 'paused', reason, inReview: false });
    assert.equal(paused.place, 'warning');
    assert.deepEqual(withdrawLamp(paused, 0n), {
      tone: 'amber',
      text: 'Paused for now',
    });
  }
  for (const quote of [
    { state: 'provider_unavailable' },
    { state: 'setup_needed', requirementsDue: [] },
    { state: 'destination_pending' },
  ])
    assert.equal(of({ inReview: false, ...quote }).place, 'instrument');
});
test('a lamp line never carries a money reassurance', () => {
  for (const view of allStates())
    // every case above, plus collected_elsewhere and ready with 0
    assert.doesNotMatch(
      withdrawLamp(view, 0n).text,
      /safe|protected|guarantee/i,
    );
});
test('the review line names our payment partner, never the provider', () => {
  const view = of(ready({ withdrawableMinor: '180000', inReview: true }));
  assert.equal(view.review, 'Our payment partner is checking it.');
});
test('only the answers that may have followed a request are unsure, and they say nothing about money', () => {
  assert.deepEqual(withdrawUnsure('IDEMPOTENCY_CONFLICT'), {
    title: 'This withdrawal may already be on its way',
    body: 'Check your dashboard before asking again.',
  });
  for (const code of [
    undefined,
    'INTERNAL_ERROR',
    'NETWORK',
    'DEPENDENCY_UNAVAILABLE',
  ])
    assert.deepEqual(withdrawUnsure(code), {
      title: 'We couldn’t confirm your withdrawal',
      body: 'Check your dashboard before trying again.',
    });
  for (const code of [
    'INSUFFICIENT_BALANCE',
    'WITHDRAWAL_TOO_SMALL',
    'WITHDRAWALS_PAUSED',
    'PAYOUT_DESTINATION_NEEDED',
  ])
    assert.equal(withdrawUnsure(code), null);
  for (const code of ['IDEMPOTENCY_CONFLICT', 'INTERNAL_ERROR']) {
    const { title, body } = withdrawUnsure(code);
    assert.doesNotMatch(`${title} ${body}`, /money|balance|paid|safe/i);
  }
});
```

`allStates()` is a small helper in the test file that builds one view per row of the mapping. The existing test that checks the review sentence (search the file for "being checked by the payment provider") changes to the new words.

- [ ] **Step 2: Run** `pnpm --filter @tipme/web test`. Expected: FAIL (`withdrawLamp`, `withdrawUnsure` and `place` don't exist yet; the review sentence differs).
- [ ] **Step 3: Implement.** `import type { LampTone } from '@tipme/ui'` is type-only. Check that `apps/web` resolves `@tipme/ui` types in `node --test` (it does for `withdraw-view`). If the test runner can't strip the import, declare `type LampTone = 'red' | 'amber' | 'purple' | 'off'` locally with a comment pointing at `packages/ui/src/components.tsx:13`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `node --test apps/web/test/no-provider-names.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(withdraw): the state model says its lamp line and where its words go`.

### Task 3: The test-mode pill, and where the recovery reminder shows

**Files:**

- Modify: `apps/web/src/lib/payment-mode-copy.ts`. Add `dashboardBadgeDetail: string | null` to `PaymentModeCopy`: TEST `'no real money moves'`, LIVE and CLOSED `null`.
- Modify: `apps/web/src/app/dashboard/dashboard-shell.tsx:137`. The `Badge` becomes `TestModePill`.
- Create: `apps/web/src/components/dashboard/test-mode-pill.tsx`.
- Modify: `apps/web/src/lib/owner-attention.ts`. Add `attentionHere`. Modify `dashboard-shell.tsx:165`–`:189` to render `attentionHere(attention, pathname)`. `needsFix` (the nav dots, `:93`) keeps the **full** list.
- Modify: `apps/web/src/app/globals.css` (`.test-pill*`).
- Tests: `apps/web/test/payment-mode-copy.test.mjs`, `apps/web/test/owner-attention.test.mjs`, `tests/e2e/dashboard.spec.ts`.

**Interfaces:**

```tsx
/** Test mode as one calm pill in the dashboard header (WithdrawRedesign §3). It opens its sentence. */
export function TestModePill(props: {
  label: string;
  detail: string | null;
  sentence: string | null;
}): JSX.Element;
// <details class="test-pill"><summary><Lamp tone="amber"/>{label}<span class="test-pill__detail"> · {detail}</span></summary>
//   {sentence && <p class="test-pill__sentence">{sentence}</p>}</details>
// Below 40rem the detail is hidden (the board's phone pill reads "Test mode"); the summary stays ≥44px tall.

/** The reminders this page shows. The recovery-email one shows on Home and Settings only. */
export function attentionHere(
  items: AttentionItem[] | null,
  pathname: string,
): AttentionItem[] | null;
```

- `<details>`/`<summary>` is the disclosure: keyboard and screen-reader behaviour come from the browser, with no script. The sentence is `copy.withdrawNotice` (today's words). The pill shows only where `copy.dashboardBadge` is set, which is test mode only, as today.
- `attentionHere` drops `id === 'add_recovery_email'` unless `pathname` is `/dashboard` or starts with `/dashboard/settings`. Every other item shows where it shows today: they stop the owner earning (`owner-attention.ts:56`–`:58`).

- [ ] **Step 1: Write the failing tests.**

```js
// payment-mode-copy.test.mjs
test('the pill has a detail only in test mode', () => {
  assert.equal(
    paymentModeCopy('test').dashboardBadgeDetail,
    'no real money moves',
  );
  assert.equal(paymentModeCopy('live').dashboardBadgeDetail, null);
  assert.equal(paymentModeCopy('closed').dashboardBadgeDetail, null);
});
// owner-attention.test.mjs
test('the recovery reminder shows on Home and Settings only; the rest show everywhere', () => {
  const items = ownerAttention({
    profile: { emailVerified: true, pageState: 'not_live', suspended: false },
    payments: null,
    needsRecoveryEmail: true,
  });
  for (const path of ['/dashboard', '/dashboard/settings'])
    assert.deepEqual(
      attentionHere(items, path).map((i) => i.id),
      ['page_offline', 'add_recovery_email'],
    );
  for (const path of [
    '/dashboard/withdraw',
    '/dashboard/tips',
    '/dashboard/tips/t1',
    '/dashboard/reports/2026-W44',
    '/dashboard/qr',
  ])
    assert.deepEqual(
      attentionHere(items, path).map((i) => i.id),
      ['page_offline'],
    );
  assert.equal(attentionHere(null, '/dashboard'), null);
});
```

`dashboard.spec.ts`:

```ts
test('test mode is one pill in the header that opens its sentence', …)
  // signUpRecipient; /dashboard/withdraw; pill = page.locator('.test-pill');
  // expect(pill.locator('summary')).toContainText('Test mode'); the sentence is hidden;
  // pill.locator('summary').press('Enter') → getByText('No real money moves in test mode. The test bank pays straight away.') visible;
  // expect(page.locator('.withdraw .tm-notice, .withdraw .tm-slip').filter({ hasText: 'Test withdrawal' })).toHaveCount(0); expectAccessible
test('the recovery-email reminder shows on Home and Settings, not on Withdraw or Tips', …)
  // a recipient without a confirmed recovery email (signUpRecipient default; check the helper); 'Add a recovery email' visible on /dashboard and /dashboard/settings;
  // count 0 on /dashboard/withdraw and /dashboard/tips; the Settings nav dot is still there on /dashboard/withdraw
```

- [ ] **Step 2: Run** `pnpm --filter @tipme/web test`, then `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/dashboard.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** CSS: `.test-pill summary` with `min-height: 44px`, `border: 1px dashed var(--border-material)`, `border-radius: var(--radius-pill)`, `font: 700 var(--text-xs)`, colour `--text-secondary`, and `list-style: none` (plus `::-webkit-details-marker { display: none }`). `.test-pill__sentence` sits under it as a small paper card: `--surface-raised`, `--shadow-raised-1`, max-width 18rem, absolutely placed under the pill so the header doesn't grow. Forced colours: `CanvasText` border.
- [ ] **Step 4: Run** the same commands. Expected: PASS. Then grep `tests/e2e` for assertions on the old badge: `git grep -n "Badge\|'Test mode'" tests/e2e`. Update them to `.test-pill`, and list them in the commit body.
- [ ] **Step 5: Commit** `feat(dashboard): test mode is a pill in the header; the recovery reminder shows on Home and Settings`.

### Task 4: The instrument, the slips and the warning

**Files:** Modify `apps/web/src/app/dashboard/withdraw/withdraw-view.tsx` (the page, not `History`) and `apps/web/src/app/globals.css` (the `.withdraw*` block at `:8927`–`:9120`). Tests: `tests/e2e/withdraw.spec.ts`, `tests/e2e/withdrawal-controls.spec.ts`, `apps/web/test/withdraw-money-lines.test.mjs` (new).

**Composition, top to bottom** (desktop: two columns, the board's `1.05fr 1fr`; below 56rem: one column):

```
<div class="dashboard-section withdraw">
  <h1>Withdraw</h1>
  {state.place === 'warning' && <StandingWarning title={notice.title}>{notice.body}</StandingWarning>}
  {done && <Slip tone="done" title="Withdrawal requested">{done}{copy.withdrawDoneSuffix} <Link href="/dashboard">Back to your dashboard</Link></Slip>}
  <div class="withdraw__layout">
    <div class="withdraw__money">                     ← left column
      <section class="withdraw__meter" aria-labelledby="withdraw-available">   ← the dark instrument
        <h2 id="withdraw-available" class="withdraw__cap">Available</h2>
        <p class="withdraw__figure">{formatNaira(summary.availableMinor)}</p>
        <p class="withdraw__lamp"><Lamp tone={lamp.tone}/>{lamp.text}</p>
        {feeLine && <p class="withdraw__fine">{feeLine}</p>}              ← "TipMe pays the ₦50 transfer fee."
        {state.place === 'instrument' && !readyWithMoney && <p class="withdraw__fine">{notice.body} {link}</p>}
        {state.review && <p class="withdraw__lamp"><Lamp tone="amber"/>Being checked. {state.review}</p>}
        {ready && <p class="withdraw__chip">{bank chip text} <Link href="/dashboard/settings#get-paid">Change</Link></p>}
        {pilotNotice}
      </section>
      {state.place === 'slip' && <Slip tone="neutral" stamp={state.stamp} title={notice.title} actions={<ActionLink variant="continue" href={notice.href}>{notice.linkLabel}</ActionLink>}>{notice.body}</Slip>}
      {unsure && <Slip tone="unsure" stamp={'Not\nconfirmed'} title={unsure.title}>{unsure.body}</Slip>}
      {state.showForm && <Surface material="instrument" class="withdraw__panel"> …form (Task 5)… </Surface>}
    </div>
    <History …/>                                       ← right column (W2 restyles it)
  </div>
</div>
```

- **The fee line** moves out of the notice body. Add `withdrawFee(quote): string | null` to `withdraw-state.ts`, which returns `TipMe pays the ${formatNaira(fee)} transfer fee.` or `null` for `'0'`. It reuses the expression at `:117`–`:120`, and `ready`'s body uses it too, so the words exist once. Unit-test it in Task 2's file.
- **The bank chip:** `bankLine({ bankName, last4 })` from `quote.destination` ("to GTBank ••1234"), capitalised by CSS, then Change. The summary's "Going to" row (`:369`–`:373`) is removed: the chip says it.
- **Paused and switched off:** the form stays hidden (`showForm: false`, as today). The ledger still shows.
- **Collected elsewhere:** the test pill is in the header for every state (the old `state.kind !== 'collected_elsewhere'` guard at `:301` belonged to the notice, which is gone).
- **The page that couldn't load** (`:229`–`:234`): `<Slip tone="error" title="We couldn’t load your balance">Please reload the page.</Slip>`.
- **`pilotNotice`** (live mode only) stays on the page. It moves from under the h1 onto the instrument, in quiet ink.
- `Notice` is no longer imported.

**CSS** (tokens only; hex only through tokens):

- `.withdraw__meter`: `background: var(--key-face-dark)`, `color: var(--text-on-night)`, `border-radius: var(--radius-card)`, `padding: clamp(1.25rem, 4vw, 1.5rem)`, `box-shadow: inset 0 1px 0 rgb(255 255 255 / 12%), var(--shadow-instrument)`.
- `.withdraw__cap` is 13px and 700 weight, in `--text-on-night-quiet`. It is a real `h2`, sized down.
- `.withdraw__figure`: `font: 400 clamp(3rem, 8vw, 4rem) / 1 var(--font-editorial)` and `font-variant-numeric: var(--numeric-variant)`. The balance never animates (`balance-card` rule).
- `.withdraw__lamp`: flex with an 8px gap, 600 weight, `--text-on-night`. A purple lamp on the dark face keeps its ring.
- `.withdraw__chip`: `background: rgb(255 255 255 / 8%)`, `border-radius: 12px`, 700 weight. The Change link is `--link-on-night`, 800 weight, with a min 44px hit area (padding).
- Forced colours: `.withdraw__meter { border: 1px solid CanvasText; forced-color-adjust: auto; }`, and the chip gets a `CanvasText` border.
- Remove `.withdraw > .tm-notice` (`:8932`–`:8934`).

- [ ] **Step 1: Write the failing tests.**

`withdraw-money-lines.test.mjs` (walks `apps/web/src`, like `no-provider-names.test.mjs`):

```js
test('“back in your balance” appears only on Withdraw and in the design-system specimen', …)
  // files matching /back in your balance/i ⊆ ['app/dashboard/withdraw/withdraw-view.tsx', 'app/design-system/states-specimen.tsx']
test('the unconfirmed slip carries no safe line', …)
  // in withdraw-view.tsx, the JSX from '<Slip tone="unsure"' to its closing '</Slip>' has no 'safe='
test('the instrument carries no reassurance', …)
  // the source between 'className="withdraw__meter"' and its closing '</section>' does not match /safe|protected|guarantee/i
```

`withdraw.spec.ts` (update the existing tests and add new ones; keep every existing behaviour assertion):

- `:31` "the withdraw page: ready, nothing yet, and a real pause":
  - "You have nothing to withdraw yet." stays (instrument line).
  - The ready assertion becomes `meter` (`page.locator('.withdraw__meter')`) containing `Ready to withdraw ₦1,800`, plus `TipMe pays the ₦50 transfer fee.`, plus a chip matching `/to .+ ••\d{4}/` with a `Change` link to `/dashboard/settings#get-paid`.
  - The pause: `page.locator('.tm-warning')` has the account-check sentence and `role="status"`, and the meter says "Paused for now".
- `:82` "…every state the provider can put it in": each sentence stays visible. Add an `expect(page.locator('.tm-notice')).toHaveCount(0)` per case, and for `no_destination` check `.tm-slip` has `Add your bank account` and the `Go to Get paid` key with the same href. The in-review case expects "Our payment partner is checking it." on the meter.
- `:156` "an idempotency conflict never says to simply try again": the words are now in `.tm-slip--unsure` (title "This withdrawal may already be on its way", body "Check your dashboard before asking again."). The slip has `role="alert"` and `.tm-slip__safe` count 0. The amount input's `aria-invalid` is not `"true"`.
- `:187` the two refusal tests: "Ready to withdraw ₦1,000" and the chip "GTBank ••1234" replace `You can withdraw ₦1,000 to GTBank ••1234`. "Ready to withdraw ₦1,800" count 0. The message stays a field error (`.tm-field-error`).
- `:272` "the summary says where it goes, what arrives and what is left": where it goes is now the chip.
- Add:

```ts
test('a withdrawal we could not confirm is a Not confirmed slip with no money line, and Withdraw again sends the same key', …)
  // route POST /v1/me/withdrawals → 502 { error: { code: 'INTERNAL_ERROR' } } (CORS as the file does), recording each idempotency-key;
  // fill 1800; Withdraw; slip = .tm-slip--unsure; title 'We couldn’t confirm your withdrawal'; text 'Check your dashboard before trying again.';
  // slip.locator('.tm-slip__safe') toHaveCount(0); not.toContainText(/money|balance/i); Withdraw again → keys[0] === keys[1];
  // fill 1700 → the slip goes (the amount changed), a new key next time
test('withdrawal requested is a done slip, and the meter is unchanged until the API says so', …)
  // tipAsVisitor; fill 1800; Withdraw; .tm-slip--done role status 'Withdrawal requested' and '₦1,800 is on its way to your test bank.' and a 'Back to your dashboard' link
```

`withdrawal-controls.spec.ts:98` ("with withdrawals switched off…"): the sentence "Withdrawals are paused for now. Your balance is safe." is now in `.tm-warning`, and the amount field count is 0.

- [ ] **Step 2: Run** `pnpm --filter @tipme/web test && rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/withdraw.spec.ts tests/e2e/withdrawal-controls.spec.ts`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement.** Add the four tokens to `packages/ui/src/tokens.css` and to the "declared once" list in `packages/ui/test/design-tokens.test.mjs` (run `pnpm --filter @tipme/ui test`).
- [ ] **Step 4: Run** the same commands, plus `pnpm --filter @tipme/ui test && pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(withdraw): money leads as a dark instrument; one slip or warning instead of three notices`.

### Task 5: The amount field: "Too small." before pressing, and the server's answers

**Files:** `withdraw-view.tsx` (the form), `withdraw-state.ts` (`belowMinimum`), tests in `withdraw-state.test.mjs` and `withdraw.spec.ts`.

**Interface:**

```ts
/** The amount is below the smallest withdrawal and isn't the whole of what can go now (FEE_POLICY_V1). */
export function belowMinimum(
  chosen: bigint | null,
  withdrawable: bigint,
): boolean;
// chosen !== null && chosen > 0n && chosen < FEE_POLICY_V1.minWithdrawalMinor && chosen !== withdrawable
export const TOO_SMALL = `Too small. The smallest withdrawal is ${formatNaira(FEE_POLICY_V1.minWithdrawalMinor)}, or your whole balance if it’s less.`;
```

**Behaviour:**

- A new state, `checked: boolean`, is set on the field's `blur` and on a submit attempt. It goes back to `false` whenever the text changes (in the existing `onChange`, beside `setError('')`). So typing "1", "15", "150" announces nothing. Leaving the field or pressing Enter does.
- The field's `error` is `error || (checked && belowMinimum(chosen, withdrawable) ? TOO_SMALL : undefined)`. The red edge and one shake come from the primitive (states Task 5). No `flag`: the board draws the line under the well, not a flag inside it.
- `submit` (`:199`): when `belowMinimum(...)`, set `checked` and return before `setBusy`. **No request, and the key is untouched.** Today the button is disabled in that case anyway (`:389`). The early return covers Enter in the field.
- A quick amount (`choose`) sets the value. Quick amounts are never below the minimum unless one is the whole balance (`:261`), so they never show "Too small."
- `INSUFFICIENT_BALANCE` and `WITHDRAWAL_TOO_SMALL` from the server stay field errors with today's sentences, from `withdrawRefusal`. The other refusals with a message go to the unsure slip (`withdrawUnsure`), not the field. The `unsure` state is cleared in `choose` when the amount differs and in `onChange`, the same places the key resets.
- "You receive" and "Balance afterwards" keep showing "—" for an amount that can't be sent (board: below the minimum shows dashes).

- [ ] **Step 1: Write the failing tests.**

```js
// withdraw-state.test.mjs
test('below the minimum is only an amount under ₦2,000 that is not everything that can go', () => {
  assert.equal(belowMinimum(150000n, 540000n), true);
  assert.equal(belowMinimum(150000n, 150000n), false); // the whole of it, under the minimum: allowed
  assert.equal(belowMinimum(200000n, 540000n), false);
  assert.equal(belowMinimum(null, 540000n), false);
  assert.equal(
    TOO_SMALL,
    'Too small. The smallest withdrawal is ₦2,000, or your whole balance if it’s less.',
  );
});
```

```ts
// withdraw.spec.ts
test('below the minimum: a red edge and Too small when leaving the field, nothing sent, and the key unchanged', …)
  // tipAsVisitor ×3 (enough for ₦5,000 key, as the review screen does) or fakeQuote ready 540000;
  // count POSTs to /v1/me/withdrawals; fill '1500' → no alert yet (getByRole('alert') toHaveCount(0)); press Tab;
  // input aria-invalid=true; .tm-field-error toHaveText(TOO_SMALL); Withdraw ₦1,500 is disabled; press Enter in the field → still 0 POSTs;
  // fill '2000' → aria-invalid false, the line gone
```

- `:228` "…the minimum comes from the policy" and `:248` "Everything fills the whole balance, and under ₦2,000 it is the only way": run unchanged. If they read the old hint only, they still pass (the hint under the button stays).

- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm --filter @tipme/web test && pnpm test:e2e -- tests/e2e/withdraw.spec.ts`. Expected: PASS, including `:508`, `:533` and `:552` unchanged.
- [ ] **Step 5: Commit** `feat(withdraw): an amount below the minimum says so at the field before pressing`.

### Task 6: Layout, phone, the quote count, and the review shots

**Files:** `globals.css` (`.withdraw__layout`, `.withdraw__money`, the 56rem and 40rem blocks), `tests/e2e/withdraw.spec.ts`, `tests/review/screens.ts`.

- **Desktop** (≥56rem): `.withdraw { max-width: 74rem }`, `.withdraw__layout { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr) }`, and `.withdraw__money` is a grid with 16px gaps (instrument, slip, form). The ledger column is `align-self: start`.
- **Phone:** one column in DOM order: instrument, the slip if any, the form, the ledger. The existing 40rem rule that keeps the summary and Withdraw clear of the tab bar (`:9115`–) still holds. Check it.

- [ ] **Step 1: Write the failing tests.**

```ts
test('a visit reads the quote once, and a refusal over the amount reads it once more', …)
  // count GET /v1/me/withdrawal-quote via page.on('request'); goto; wait for the meter; expect 1;
  // route POST → 409 INSUFFICIENT_BALANCE; fill 1800; Withdraw; wait for the field error; expect 2;
  // pill toggle, quick-amount taps and Tab out → still 2
```

- `:460` "the withdraw page fits a phone, clear of the tab bar @mobile": add `fitsViewport` at 320px for the ready, no-bank and paused states (`fakeQuote`). Check the meter's top is above the form's top, and the form's above the ledger's.

`tests/review/screens.ts`: add four shots (the audit's "States with no shot"), each with `board: 'WithdrawRedesign'`:

- "Withdraw, paused" (`fakeQuote`-style route to `{ state: 'paused', reason: 'switched_off' }`);
- "Withdraw, no bank" (`no_destination`);
- "Withdraw, below the minimum" (ready with ₦5,400, fill 1500, blur);
- "Withdraw, not confirmed" (POST → 502).

Change the two existing withdraw entries' `board` to `'WithdrawRedesign'`.

- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/withdraw.spec.ts`. Expected: the count test may already pass. If it does, keep it: it guards the cache rule.
- [ ] **Step 3: Implement** the CSS.
- [ ] **Step 4: Run** the whole PR's checks: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (`E2E_LANE` unset), then `rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/withdraw.spec.ts tests/e2e/withdrawal-controls.spec.ts tests/e2e/dashboard.spec.ts`, then the full e2e suite on your lane, then `pnpm review:screens`. Compare the six Withdraw shots with the board, desktop and phone, and attach them to the PR.
- [ ] **Step 5: Commit** `feat(withdraw): the board's layout on desktop and phone, and shots of every state`.

**PR W1 ends here.**

---

## PR W2: Withdraw, the ledger

### Task 7: `Stamp`, a small ink stamp that carries a state's word

**Files:** `packages/ui/src/components.tsx`, `components.css`, `tokens.css` (`--stamp-ok`), `packages/ui/test/states.test.mjs`, `design-tokens.test.mjs`.

**Interface:**

```ts
export type StampTone = 'wait' | 'ok' | 'bad' | 'ink';
/** A state's word as an ink stamp beside a row (WithdrawRedesign ledger). Unlike a slip's stamp, its word IS the state, so it is read. */
export function Stamp(props: {
  tone: StampTone;
  children: string;
  className?: string;
}): JSX.Element;
// <span class="tm-stamp tm-stamp--{tone}">{children}</span>
```

**CSS:** 11px, 800 weight, `letter-spacing: .02em`, `text-transform: uppercase`, `padding: 4px 8px`, `border: 1.5px solid currentColor`, `border-radius: 6px`, `transform: rotate(-2deg)`. Colours: `wait` `--brand-ink`, `ok` `--stamp-ok`, `bad` `--state-danger`, `ink` `--stamp-ink`. Forced colours: `CanvasText` border and text. With reduced motion: no change (it doesn't move).

- [ ] **Step 1: Write the failing test:**

```js
test('a stamp is read aloud, in its own words, one class per tone', () => {
  for (const tone of ['wait', 'ok', 'bad', 'ink']) {
    const html = renderToStaticMarkup(h(ui.Stamp, { tone }, 'Paid'));
    assert.equal(html, `<span class="tm-stamp tm-stamp--${tone}">Paid</span>`);
  }
});
```

Also add `.tm-stamp` to the forced-colours list in the CSS test (states Task 5's list).

- [ ] **Steps 2–4:** run `pnpm --filter @tipme/ui test` (FAIL), implement, run again (PASS).
- [ ] **Step 5: Commit** `feat(ui): stamps that carry a state's word`.

### Task 8: The ledger rows

**Files:** `withdraw-view.tsx` (`describe`, `History`), `globals.css` (`.withdraw__history`, `.withdraw__row*`; remove `.withdraw__state*` and `.withdraw__steps*`). Tests: `withdraw.spec.ts`, `withdraw-money-lines.test.mjs`.

**`describe` gains a stamp tone** (`'ok'` for sent, `'bad'` for failed and reversed, `'wait'` otherwise). The labels and notes keep today's words.

**A row** (`<li class="withdraw__row">`, no live role: rows are history):

```
<span class="withdraw__amount">{formatNaira(amountMinor)}</span>   <Stamp tone={view.stamp}>{view.label}</Stamp>
{open && <Steps className="withdraw__steps" labels={STEPS} filled={view.steps} />}      ← STEPS = ['Requested', 'Sent to our payment partner', 'Paid'] as const
<p class="withdraw__note">{view.note}</p>
{row.state === 'failed' && <p class="withdraw__back">Back in your balance: {formatNaira(row.amountMinor)}</p>}
{bankLine(row.bank) && <p class="withdraw__bank">{bankLine(row.bank)}</p>}
```

- The ledger is one paper card (`.withdraw__history`: `--surface-raised`, `--radius-card`, `--shadow-paper` or the board's paper shadow token), with rows divided by hairlines, not separate cards.
- `.withdraw__amount`: DM Serif, 24px, `var(--numeric-variant)`.
- `Steps` in a row is compact. The lamps sit in a row with no wells (`.withdraw__steps .tm-steps__step { background: none; box-shadow: none; min-height: 0 }`). The three labels read as one line, "Requested · Sent to our payment partner · Paid": `::before { content: '· ' }` on the second and third label, and the visible label text is `--text-xs` and secondary. Screen readers hear each step with ", done" or ", not yet" (the primitive's `sr-only` text). The list keeps `aria-label="Progress"`, so the existing test selectors hold.
- `.withdraw__back`: 700 weight, primary ink. A plain line: the board draws no box.
- `.withdraw__bank::first-letter { text-transform: uppercase }`.
- "We couldn’t refresh this list…" and "Show more" stay. Show more is a secondary key at full width under the rows (board `.more`).
- The empty list stays one quiet line, "Withdrawals you make will be listed here." (board, no-bank state). It is not an `EmptySlip`: the board draws a plain line.

- [ ] **Step 1: Write the failing tests.**

`withdraw-money-lines.test.mjs`:

```js
test('“Back in your balance” is written only for a failed row', …)
  // in withdraw-view.tsx: every occurrence of 'Back in your balance' sits inside a `row.state === 'failed' &&` expression (regex on the line), and there is exactly one
```

`withdraw.spec.ts` `:306` "progress follows the real state only" (keep every assertion, and add):

- The open row: `moving.locator('.tm-stamp')` has text `On its way`. `steps` still has 3 items and 2 `[data-filled="true"]`.
- The paid row: `.tm-stamp` is `Paid`.
- The failed row: `.tm-stamp` is `Failed`, it still contains "the money is back in your balance", and `.withdraw__back` has `Back in your balance: ₦12,500`.
- The failed row has no `role`. `history.locator('[role="alert"], [role="status"]')` count is 0 inside the list.
- A reversed row (add `w4`, state `reversed`) has no `.withdraw__back`.

- [ ] **Step 2: Run** `pnpm --filter @tipme/web test && rm -rf apps/web/.next/cache && pnpm test:e2e -- tests/e2e/withdraw.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** the same, plus `:363`, `:388` and `:408` (older withdrawals, bank after change, Show more) unchanged.
- [ ] **Step 5: Commit** `feat(withdraw): the history is a ledger with stamps and step lamps; a failed row says what came back`.

### Task 9: The failed shot, and the PR's checks

- [ ] `tests/review/screens.ts`: the "Withdraw, one on its way" entry already stubs a failed row (`w3`). Rename it "Withdraw, the ledger" and keep the stub. Add `bank` to `w1` so the open row shows a bank line.
- [ ] **Run:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, the full e2e suite on your lane, and `pnpm review:screens`. If live updates PR 2 has merged, run its two withdraw tests by name.
- [ ] **Commit** `test(review): the withdraw ledger shot`.

**PR W2 ends here.**

---

## PR A1: Account screens

Board: `ScreenAccess.dc.html`. Starts after states PR C merges (it owns `recover-flow.tsx`'s scheduled slip and the code cells). A1 never changes a word. It changes the composition and the type.

### Task 10: The auth stage: heading and card read as one composition

**Files:** `apps/web/src/app/globals.css` (`.auth-stage`, `.auth-card`, `.auth-title`, `:3920`–`:4010`, `:4605`–`:4640`), `apps/web/src/components/account/auth-stage.tsx` (only if a wrapper is needed). Tests: `tests/e2e/accounts.spec.ts`.

The audit says "Desktop: heading and a small card float apart with wide empty space", and that the sign-up card is small for the space. Plan proposal:

- `.auth-stage`: `max-width: 58rem`, columns `minmax(0, 1fr) minmax(0, 28rem)`, gap `clamp(2rem, 5vw, 4rem)`, `align-items: start`. A top padding puts the card's top level with the title's cap height, so they read as one row.
- `.auth-card`: `padding: var(--space-8)` on desktop. The form's text is `--text-base`. The primary key is full width.
- `.auth-switch` (the text links under the form) sits in primary ink, at `--text-sm`, with 12px between lines.
- Phone (≤860px) is unchanged.

- [ ] **Step 1: Write the failing test** in `accounts.spec.ts`:

```ts
test('sign in on a desktop: the heading and the card sit as one composition', …)
  // 1280x800; /sign-in; title = .auth-title box, card = .auth-card box;
  // card.x - (title.x + title.width) <= 96; Math.abs(card.y - title.y) <= 48; card.width >= 420
```

- [ ] **Steps 2–4:** run `pnpm test:e2e -- tests/e2e/accounts.spec.ts` (FAIL), implement, run again (PASS). Also `tests/e2e/welcome.spec.ts` and `sign-up`'s tests unchanged. `.auth-stage` also serves `.welcome--setup` at `:4613`: check that the welcome shot hasn't moved (`pnpm review:screens`, Accounts group).
- [ ] **Step 5: Commit** `fix(account): the sign-in heading and card read as one composition`.

### Task 11: Recovery, and recovery sent

**Files:** `apps/web/src/app/recover/recover-flow.tsx` (the `email` and `code` steps' markup only), `globals.css`. Tests: `tests/e2e/recovery.spec.ts`.

**Recovery (email step).** The audit says "Three text links stacked under the button; small grey paragraph carries the key facts".

- "Back to sign in" moves **above** the card's form, as a back link (the `.tip-detail__back` pattern): `<p class="auth-back"><Link href="/sign-in">Back to sign in</Link></p>`.
- The two other ways back become one quiet block under the key. One sentence, "No recovery email? Contact support@usetipme.xyz and we’ll check it’s you.", and then the "Enter the code we sent to your new email" control as a `secondary` key at full width (today it's a `quiet` button inline in the paragraph). Words unchanged. "Already spoke to us?" stays as the key's lead-in text.
- The field's hint ("The one you can’t get into. If it has a recovery email, we’ll send a code there.") is the key fact. It renders in primary ink at `--text-base`, with a scoped class on this field.

**Recovery sent (code step).** The audit says "A dense paragraph in small type sits above the code cells".

- The `role="status"` paragraph keeps its **first sentence only**, "If that email matches an account, the next step is on its way.", at `--text-base`, 600 weight. It stays the live region.
- The other sentences follow as a short list (`<ul class="auth-facts">`), in today's words, one per item:
  - "A code sent to a recovery email expires in 10 minutes."
  - "If nothing arrives, you may have asked too many times: try again in an hour."
  - "Your balance stays safe meanwhile." (kept, see "Open for the owner" 3)
- `.auth-facts`: no bullets, 8px gap, `--text-sm`, primary ink, and a hairline above.

- [ ] **Step 1: Write the failing tests** in `recovery.spec.ts`:

```ts
test('recovery: one way back above the card, and one other way under the key', …)
  // /recover; .auth-back link 'Back to sign in' is above the form (box y); under the submit key: exactly one paragraph and one button
  // ('Enter the code we sent to your new email'); the hint's computed color === computed --text-primary
test('recovery sent: one status line, then the facts as short lines', …)
  // fill + submit as tests/review/screens.ts:361-363 does; getByRole('status') hasText exactly 'If that email matches an account, the next step is on its way.';
  // .auth-facts li count 3 with today's words
```

Existing recovery tests that read the whole paragraph (`git grep -n "next step is on its way" tests/e2e`) change to the split text.

- [ ] **Steps 2–4:** FAIL, implement, PASS (`pnpm test:e2e -- tests/e2e/recovery.spec.ts`).
- [ ] **Step 5: Commit** `fix(account): recovery has one way back and its facts in plain lines`.

### Task 12: Email verified, on the auth stage

**Files:** `apps/web/src/app/verify-email/page.tsx`, `verify-email.tsx`, `globals.css` (`.verify-card` at `:4113` and `:4300`). Tests: `tests/e2e/accounts.spec.ts` (or wherever `git grep -n "Your email is verified" tests/e2e` points).

- The page renders `AuthStage`, whose intro side takes the result heading as the page's `h1`. Today the heading lives inside the client component. Add a slot to `AuthStage`: `title` takes a `ReactNode`, and an optional `aside` replaces the intro, so `VerifyEmail` renders both columns. Keep the token-from-fragment logic exactly as it is (`verify-email.tsx:11`–`:18`).
- Confirmed: intro `h1` "Your email is verified." (editorial size). The card holds today's sentence and the "Go to your dashboard" key. Invalid: intro `h1` "This link doesn’t work". The card holds today's sentence and "Open settings".
- While checking, the `Skeleton` sits in the card. The intro is empty, not a guess.
- No celebration (SignUpCelebration owns it).

- [ ] **Step 1: Write the failing test:** `email verified sits on the auth stage: one h1, the card beside it on a desktop` (1280 wide; h1 and card boxes as in Task 10; `#v=bad` shows "This link doesn’t work" with the same layout).
- [ ] **Steps 2–4:** FAIL, implement, PASS. Run `pnpm review:screens` for the Accounts group and attach the before and after shots for sign in, recovery, recovery sent and email verified.
- [ ] **Step 5: Commit** `fix(account): email verified uses the account stage`.

**PR A1 ends here.**

---

## PR R1: The tip receipt before it's paid

Board: `TipJourney.dc.html` (waiting and failed). Starts after states PR B merges (it owns `status-view.tsx`'s "Connection lost" slip). The paid "Thank you" screen is Cohesive and is not touched. States PR H1 later changes the same file's connection handling. R1 moves no logic, so H1 rebases over CSS and a wrapper only.

### Task 13: A composed stage on a desktop

**Files:** `apps/web/src/app/tip/[tipId]/status-view.tsx` (classes only), `globals.css` (`.tip-status-page`, `.tip-status-card*`, `:3465`–`:3545`). Tests: `tests/e2e/checkout.spec.ts`.

The audit says "A small card alone on a wide empty canvas on desktop". Plan proposal: from 56rem, `.tip-status-card` (every non-paid state) becomes a two-column grid inside the existing `Surface`, at `max-width: 56rem`:

- **left:** the live region `tip-status-live` (the pulse, the `h1` at editorial size `clamp(2.25rem, 4vw, 3rem)` and the sentence);
- **right:** the amount `{amount}` (a new `<p class="tip-status-amount">`, DM Serif 40px, a figure the page already has, with no new words), the reference when there is one, then `tip-status-actions` and the pilot notice.

The DOM order doesn't change. The live region is the same element in every state (`status-view.tsx:230`–`:232`'s comment), so the layout is `grid-template-areas` by class only. On a phone it stays one column, as today.

- [ ] **Step 1: Write the failing test** in `checkout.spec.ts`:

```ts
test('waiting on a desktop: the status beside the amount, not a small card on an empty page', …)
  // stand-in status route answering 'waiting' (as the file's existing waiting test does); 1280x800;
  // .tip-status-card width >= 800; .tip-status-live and .tip-status-amount side by side (boxes overlap vertically, live.x < amount.x);
  // the live region element handle is the same before and after a route change to 'declined' (evaluate an expando on it)
```

- [ ] **Steps 2–4:** FAIL, implement, PASS. Run all `checkout.spec.ts` and `tip-card.spec.ts` tests. Expected: unchanged.
- [ ] **Step 5: Commit** `fix(receipt): before it's paid, the status and the amount share a composed stage`.

### Task 14: Didn't go through reads as a slip

**Files:** `status-view.tsx`, `globals.css`, `tests/review/screens.ts`.

The audit says "Failure reads flat: no slip, no stamp".

- For `declined`, the card gets the slip's paper edge (`tm-slip`'s perforated `::before` and paper radius, reused through a modifier class: `.tip-status-card--declined` takes `--surface-raised`, `border-radius: 4px 4px 16px 16px` and the same `::before`). A stamp `<span class="tm-slip__stamp tm-slip__stamp--red" aria-hidden="true">Not<br/>sent</span>` sits outside the live region. It is decoration, and the h1 says it.
- `cancelled` ("This tip expired") gets the paper edge and **no** stamp: no new word.
- Words unchanged. "If money left your account anyway, keep this receipt link and contact TipMe." stays as it is. It is not a reassurance.

- [ ] **Step 1: Write the failing test:** `a payment that didn't go through is a paper slip with a Not sent stamp the screen reader skips` (`.tip-status-card--declined .tm-slip__stamp` visible, `aria-hidden="true"`; `getByRole('status')` text has no "Not sent"; the `Try again` key goes to the profile as today).
- [ ] **Steps 2–4:** FAIL, implement, PASS.
- [ ] **Step 5:** in `tests/review/screens.ts`, add "Receipt, expired" and "Receipt, cancelled" shots (the audit's "States with no shot": a stand-in status of `cancelled`; if "cancelled" and "expired" are the same API state, one shot, named "Receipt, expired"). Then run `pnpm review:screens` for the Tipping group and attach the shots.
- [ ] **Step 6: Commit** `fix(receipt): a tip that wasn't sent reads as a slip`.

**PR R1 ends here.**

---

## PR D1: Dashboard money pages

Boards: `ScreenTips.dc.html`, `ScreenTipReport.dc.html`, `ScreenDashboard.dc.html`. Starts after states PR D merges (it owns these files' notices, the empty tips slip and the copy-link key). The audit says "Money on Withdraw, Tips and Tip detail is set in small grey text. Money should be the instrument: DM Serif numerals on paper, as on Home and the weekly report."

### Task 15: Tips: money with weight, and the desktop's right side

**Files:** `apps/web/src/app/dashboard/tips/tips-view.tsx` (wrappers and classes), `globals.css` (`.tips-*`, `.tip-row*`, `:8554`–). Tests: `tests/e2e/dashboard.spec.ts` (tips tests), `profile-page.spec.ts` if it reads the list.

The audit says "Rows are thin and grey; the money has no weight", "Desktop right side empty" and "Nag box on top" (W1 removes the nag here).

- **Rows** (ScreenTips): a ledger in one paper card per day, rows between hairlines, not separate cards. The row is the name in 700 primary ink, then the time and "with a note" in secondary. The money on the right is `formatNaira(netMinor)` in DM Serif 22px, with "from ₦X" under it at `--text-xs`. A non-paid row's state ("Being confirmed") is a `Stamp tone="wait"` (from W2) in place of the inline `· Being confirmed` text. The words are the same as `stateText`. If W2 hasn't merged, use a local `.tip-row__state` style and switch to `Stamp` when it lands.
- **Desktop right side** (plan proposal; the board is one column): from 64rem, `.tips-page` is two columns, `minmax(0, 1fr) 20rem`. The right column is sticky and holds the totals as a small instrument: `formatNaira(totals.receivedNetMinor)` in DM Serif 40px, and under it today's words "from N tips so far". Then "Download as CSV" and its status line, and then the search and filters. On a phone, today's order stays: header, controls, list.
- No note text in rows (Privacy, above).

- [ ] **Step 1: Write the failing tests** in `dashboard.spec.ts`:

```ts
test('tips: each amount is set in the editorial face, and a desktop shows the totals beside the list', …)
  // recipientWithTips(3) equivalent helper in e2e (check tests/e2e helpers); /dashboard/tips at 1280;
  // first .tip-row__money strong computed font-family contains 'DM Serif' (or the --font-editorial value);
  // .tips-aside box right of .tips-day box; the totals figure text matches /₦[\d,]+/; at 390 wide the aside is above the list (DOM order) and fitsViewport
```

- [ ] **Steps 2–4:** FAIL, implement, PASS. Run every tips test in `dashboard.spec.ts`, plus the live updates tips tests (`git grep -n "New tips: show" tests/e2e`).
- [ ] **Step 5: Commit** `fix(tips): money set as an instrument, and the totals beside the list`.

### Task 16: Tip detail: the receipt at full measure, with the note beside it

**Files:** `apps/web/src/app/dashboard/tips/[tipId]/tip-view.tsx` (wrappers), `globals.css` (`.tip-detail`, `.receipt*`, `:8672`–`:8730`). Tests: `tests/e2e/dashboard.spec.ts` (tip detail), `tests/e2e/messages.spec.ts` or wherever `git grep -n "MessageControls\|Hide this note" tests/e2e` points.

The audit says "Receipt card small and left, half the desktop empty". Plan proposal from ScreenTipReport: from 64rem, `.tip-detail` is two columns, `minmax(0, 35rem) minmax(0, 1fr)`:

- **left:** the paper receipt. The `h1` amount line in DM Serif `clamp(2rem, 4vw, 2.75rem)`, the rows (`rrow`) at `--text-base`, "You received" in 800 weight, the fine print.
- **right:** the note (`receipt__note` moves here as a quoted slip, using `.thanks-slip`'s paper style: decorative quote mark, `aria-hidden`), the hidden or reported line, and `MessageControls` under it.

With no note, the receipt is centred at 35rem and the right column is not drawn. The DOM order is back link, receipt, note, controls. The note moves out of the `Surface` into a sibling. This is markup, not words. Phone: one column.

- [ ] **Step 1: Write the failing test:** `tip detail on a desktop: the receipt and its note side by side; without a note the receipt is centred` (two tips, one with a message; boxes as in Task 15).
- [ ] **Steps 2–4:** FAIL, implement, PASS, with the hide and report tests unchanged.
- [ ] **Step 5: Commit** `fix(tips): the tip detail is composed at full measure`.

### Task 17: Home: a side column with weight

**Files:** `apps/web/src/app/dashboard/home-view.tsx` (classes only), `globals.css` (`.dashboard-home*`, `.week-teaser`, `.page-card*`). Tests: `tests/e2e/dashboard.spec.ts`.

The audit says "Right column thin". Plan proposal from ScreenDashboard: `.dashboard-home` columns `minmax(0, 1.5fr) minmax(18rem, 1fr)`. The week teaser becomes a paper card with its figure, `{naira(totalNetMinor)}`, in DM Serif 32px. `PageCard`'s preview gets the full column width. The tabs-or-sidebar question is not touched (owner).

- [ ] **Step 1: Write the failing test:** `home on a desktop: the side column is at least 18rem and the week's figure is set in the editorial face` (recipient with tips and a week report; aside width ≥ 288).
- [ ] **Steps 2–4:** FAIL, implement, PASS.
- [ ] **Step 5:** run `pnpm review:screens` for the Dashboard group and attach the before and after shots for Dashboard with tips, Tips, Tip detail and Weekly report.
- [ ] **Step 6: Commit** `fix(dashboard): the home side column carries its figures`.

**PR D1 ends here.**

---

## PR P1: For businesses

### Task 18: A composed first screen

**Files:** `apps/web/src/app/for-businesses/page.tsx` (one class), `globals.css` (`.business-hero`, `.business-card*`, `:8046`–`:8120`). Tests: `tests/e2e/marketing.spec.ts` or wherever `git grep -n "for-businesses" tests/e2e` points.

The audit says "Half the desktop page is empty below the hero; the email card floats with nothing around it". The board, `PageBusinesses.dc.html`, is a hero (copy left, the card right at 480px). Plan proposal, with no new content:

- `.business-hero` fills the first screen: `min-height: calc(100svh - <header height> - var(--space-24))`, `align-items: center`, and the board's columns `minmax(0, 1fr) 30rem`. The footer then follows directly, with no blank band.
- The card rests on paper (`--surface-raised`, `--shadow-paper`, `--radius-card`). Its form well is recessed, as on the board. "You’re on the list." keeps its big type.
- Phone: unchanged.

- [ ] **Step 1: Write the failing test:** `for businesses: the hero fills the first screen on a desktop, and the footer follows it` (1280x800; hero box bottom ≥ 600; footer top − hero bottom ≤ 96).
- [ ] **Steps 2–4:** FAIL, implement, PASS. Run the business interest form's existing tests unchanged.
- [ ] **Step 5: Commit** `fix(marketing): the businesses page is one composed first screen`.

**PR P1 ends here.**

---

## PR S1: Settings

Board: `ScreenSettings.dc.html` (a section list, 232px; the form, 520px; the preview beside it). Starts after states PR F and make-it-yours PR B and D merge. Rebase onto any `pro-additions` Settings card that has landed. **Dev wins for behaviour: Settings stays one scrolling page with section links** (`settings-view.tsx`; 40 e2e visits rely on it). Showing one chapter at a time is "Open for the owner" 2.

### Task 19: A deep link lands on its section, and stays there

**Files:** `apps/web/src/app/dashboard/settings/settings-view.tsx:82`–`:85`. Tests: `tests/e2e/settings.spec.ts` (or the file that covers settings navigation: `git grep -n "nav\[aria-label=\"Settings\"\]" tests/e2e`).

Today `SettingsView` scrolls to the hash once, on mount. The sections then load their own data and grow, which can push the target off screen. That is what the audit's "opens on My page" shots show, along with the full-page capture (`tests/review/screens.ts:575`–`:576`).

- Keep scrolling to the hash on mount. Then, until the person scrolls, types or clicks (listen once for `wheel`, `touchstart`, `keydown` and `pointerdown`), a `ResizeObserver` on `.settings-chapters` scrolls the target back into place whenever the layout grows. Stop after 3 s in any case.
- `prefers-reduced-motion` doesn't matter here: these are instant jumps (`scrollIntoView()` with no `behavior`).

- [ ] **Step 1: Write the failing test:**

```ts
test('a link to a section lands on it once Settings has loaded', …)
  // for '#notifications', '#security', '#data', '#get-paid': goto /dashboard/settings<hash>; wait for that section's first control;
  // await page.waitForTimeout is not used: expect.poll(() => section.boundingBox().then(b => b.y)).toBeLessThan(160)
```

- [ ] **Steps 2–4:** FAIL (expected on at least one hash), implement, PASS.
- [ ] **Step 5: Commit** `fix(settings): a link to a section still lands on it after the page loads`.

### Task 20: The composition: the list beside the content, a wider measure, the cover grid, the preview in view

**Files:** `globals.css` (`:4653`–`:4690`, `:9158`–`:9545`), `components/account/cover-settings.tsx` (classes only, if needed). Tests: `tests/e2e/cover-settings.spec.ts`, `settings.spec.ts`.

The audit says "One very long column of plain fields in small type; Cover grid crammed; preview phone drifts to the bottom; Section list sits far from the content". Against the board:

- **Section list:** `grid-template-columns: 14.5rem minmax(0, 1fr)` (the board's 232px) from 64rem, with `column-gap: var(--space-8)`. The list's hairline moves to the content's left edge, so the two touch. The links are `--text-base`.
- **Measure and type:** forms' max-width goes from `34rem` (`:9253`–`:9256`) to `32.5rem` (the board's 520px). Field labels `--text-base` 700; hints `--text-sm` in secondary; `h3` 1.25rem.
- **Cover grid:** in the 520px column it shows 3 columns (`ScreenSettings` `repeat(3, minmax(0, 1fr))`), not more. Each swatch is at least 44px tall.
- **Preview in view:** the sticky preview beside My page starts at 64rem, not 75rem (`:9516`). Between 64rem and 75rem the preview column is `minmax(16rem, 1fr)` and the phone frame scales (`width: 100%`, `max-width: 22rem`). Below 64rem it sits after the editor, as today.
- The words don't change.

- [ ] **Step 1: Write the failing tests:**

```ts
test('settings on a desktop: the section list touches the content, and the preview stays beside My page', …)
  // 1100x800 (between the old 75rem and 64rem); nav right edge to first chapter left edge <= 40;
  // .settings-preview box x > .settings-editor box x; scroll the editor 600px: preview still in viewport (sticky)
test('the cover grid shows three across in the editor column', …)
  // cover-settings first row: three swatches share the same box y
```

- [ ] **Steps 2–4:** FAIL, implement, PASS. Run `cover-settings.spec.ts` in full: `:313`–`:320` asserts the nav links in order and stays unchanged.
- [ ] **Step 5: Commit** `fix(settings): the board's composition: the list beside the content, the preview in view`.

### Task 21: First-view shots

- [ ] `tests/review/screens.ts:571`–`:600`: each Settings shot goes to `/dashboard/settings#<id>` and waits for the section, as Task 19's test does. A new option on `ReviewScreen`, `fullPage: false` (read `tests/review/review.spec.ts` for how the capture is called, and add the option there), captures the viewport, not the whole page. So each shot shows its section first: the audit's "Settings sections other than My page, as a first view".
- [ ] **Run:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, the full e2e suite on your lane, and `pnpm review:screens` (attach the seven Settings shots).
- [ ] **Commit** `test(review): Settings shots show their own section first`.

**PR S1 ends here.**

---

## PR X1: Across the app

### Task 22: A slim footer inside the recipient dashboard

**Files:** `apps/web/src/components/footer.tsx`, `apps/web/src/app/dashboard/dashboard-shell.tsx` (`data-area="recipient"` on its `<main>`), `globals.css`. Tests: `tests/e2e/dashboard.spec.ts`.

The audit proposes this: "The dashboard and settings show the full marketing footer. Proposed: a slim footer inside the signed-in app".

- `footer-bottom` gains a small nav, `<nav aria-label="Legal">` with Privacy and Terms, so the slim footer still links to them.
- `body:has(main[data-area='recipient']) > .site-footer .footer-card { display: none }`, and the footer's top margin shrinks to `var(--space-8)`. What remains is the © line, the test-mode note (`copy.footerNote`, test only) and Privacy and Terms.
- `/ops` is not affected: `emails-and-admin` hides the whole footer there.
- `/dashboard/welcome` is in the dashboard shell too, so it also gets the slim footer.

- [ ] **Step 1: Write the failing test:** `the dashboard has a slim footer with Privacy and Terms, and the home page keeps the full one` (on `/dashboard`: `.footer-card` hidden, the Legal nav has two links; on `/`: `.footer-card` visible).
- [ ] **Steps 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(dashboard): a slim footer inside the signed-in app`.

### Task 23: The skip link, and the bell

- **Skip link.** The audit says "Phone shots show 'Skip to content' visible in the middle of Withdraw and Settings… (could be a capture effect)". `.skip-link` (`globals.css:126`–`:140`) is `position: fixed` with `transform: translateY(-200%)`. Write the test first. If it passes, it was the full-page capture, and no CSS changes. Say so in the commit.

```ts
test('the skip link is out of sight until focused, on a phone @mobile', …)
  // 390x844; /dashboard/withdraw and /dashboard/settings (signed in); .skip-link boundingBox bottom <= 0 (or not intersecting the viewport);
  // press Tab once: the skip link is focused and fully inside the viewport
```

- **The bell.** In `tests/review/screens.ts`, add "Notification bell, open" (`board: 'ScreenDashboard'`): a recipient with one tip, click the bell, wait for its panel. This is from the audit's "States with no shot".

- [ ] **Steps:** the test FAILs or PASSes as above. Implement only if it fails. **Commit** `test: the skip link stays hidden on a phone; a shot of the open bell`.

### Task 24: Re-shoot and re-grade

- [ ] `pnpm review:screens` on the merged result. For every screen the audit graded "Off in places" or "Not TipMe", write one line in the PR description: the audit's note, what changed, and the PR that changed it. Mark "Design system" as fixed by states PR A (no `Notice` on `design-system/page.tsx` at `931a545`). Mark "Tip page" and "Privacy" as not in this plan, with the reason.
- [ ] **Run** the full checks and the full e2e suite on your lane.
- [ ] **Commit** `docs(design): the screen audit after the fixes` (only if a doc changes; otherwise the PR description carries it).

**PR X1 ends here.**

---

## Open for the owner

Each has a default the builder ships with.

1. **Dashboard navigation: top tabs or the ScreenDashboard board's left sidebar?** Default: **keep the top tabs.** WithdrawRedesign, approved on 5 Nov, draws them, and `DECISION-LOG.md:133` records segmented section navigation. If the answer is the sidebar, it is a PR of its own in `dashboard-shell.tsx`.
2. **Settings: one chapter at a time?** The ScreenSettings board shows one section beside the list. Dev scrolls through all seven, and 40 e2e visits rely on that. Default: **keep one scrolling page** and fix its composition (S1). Showing one chapter at a time is a later PR if wanted.
3. **Two existing money sentences the code doesn't fully prove** (kept word for word; this plan adds neither):
   - **"Your balance stays safe meanwhile."** on `/recover`. No withdrawal hold during a recovery was found (`payouts.ts` has no recovery check). Proposed: drop it. Default: **keep**, so A1 doesn't change words.
   - **"Withdrawals are paused for now. Your balance is safe."** when withdrawals are switched off. The code proves only that no withdrawal starts while the switch is off (`payouts.ts:1323`–`:1324`, `:1358`–`:1359`; `payout-start.ts:480`). Proposed: "Withdrawals are paused for now. Nothing leaves your balance while they are." Default: **keep**.
4. **Privacy page:** the audit says it needs a redesign once the text exists. That waits for the legal text (D-02, D-07). Not planned.
5. **The board's Proposed words, built by default:**
   - "Too small. The smallest withdrawal is ₦2,000, or your whole balance if it’s less."
   - the stamps "Needs a bank" and "Not confirmed", and the ledger's capitals;
   - "Back in your balance: ₦X" on failed rows (proven above);
   - the test-mode pill;
   - "Our payment partner is checking it."
   - The plan's own proposal: the "Not sent" stamp on a declined receipt.
6. **The "Needs a bank" stamp is ink, not the board's purple.** The states rule keeps a slip's purple stamp for a confirmed outcome (`done`). Default: **ink**. Purple is one token change if preferred.
7. **Plan proposals with no board** (built by default, with before and after shots in each PR):
   - the Tips totals column on a desktop;
   - the tip detail with the note beside the receipt;
   - the receipt's two-column stage before it's paid;
   - the businesses hero filling the first screen;
   - the slim footer's contents (©, test-mode note, Privacy, Terms).
