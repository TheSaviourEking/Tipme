# Make it yours: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipient can shape what supporters meet, from a new Settings chapter called "Make it yours":

1. a thank-you line on the supporter's receipt, in the recipient's own words (Free: the line, up to 140 characters; Pro: also one of 3 card styles and a signature);
2. on Pro, an accent colour taken from the cover colour (the Tip button stays black);
3. on Pro, one pinned supporter note, only from a supporter who ticked a new consent box on the tip form, and never a hidden or reported note;
4. on Pro, the amount the page starts on, chosen from the page's own amounts.

**Owner's request:** "work on what can be customized" (5 Nov 2026), answering the "Make it yours" board. The items above are the ones the caller put in scope. This is a product and visual decision, not a legal, regulatory or provider approval. No D-item in `docs/00-DECISIONS.md` changes, and nothing about fees, the minimum, checkout, money or the ledger changes.

**Boards (static HTML, read as specs):**

- `ProCustomise.dc.html`: "Make it yours: what people can customise". The map of what exists, and the six Settings cards.
- `ProStartAmount.dc.html`: "Pro: the amount a page starts on".
- `AppreciationDetails.dc.html`: context only. Its receipt frames show the thank-you slip under today's heading, and its "What we will not do" list says a note is never shown publicly without its writer's yes.

The boards are in the session scratchpad, `canvas-email/project/`. Before Task 1, copy them into `docs/design/redesign/boards/` so the repo holds the spec.

**Out of scope, with a slot kept for them:** the tip sound picker and the celebration styles ("When a tip lands"). They depend on live updates (`feat/live-updates` adds a boolean `profiles.tip_sound` and a "Sound for new tips" switch in Notifications) and on sound files that do not exist yet. See "Slots for later" below. Also out of scope: the weekly share card colour, the first-tip keepsake, "Thank you, Chidi." as the receipt heading, and the weekly share nudge.

**Architecture:** Every choice is a column on `profiles`, or on `tip_messages` for consent. Read-time functions turn what is stored, plus the page's plan, into what shows. The pattern is `tipAmountsOf`, `shownQrStyle` and `coverPlay`: a page that leaves Pro keeps every saved choice and shows the Free version, and a page that returns to Pro gets its choices back. Writes that need Pro use the existing check-then-conditional-update pattern. It reads the plan, refuses on Free, and then adds `eq(profiles.plan, 'pro')` to the `UPDATE`'s `WHERE`, because staff, or billing once `feat/pro-billing` lands, may move the page to Free between the read and the write. `setTipAmounts` and `updateMyProfile` (QR) in `packages/database/src/operations/profiles.ts:225-255, 406-456` do this today. Shapes live in `packages/contracts`, and the web never decides Pro on its own: it shows what the API resolved.

**Tech stack:** Drizzle/Postgres, NestJS, Next App Router, Zod, Playwright, `node --test`. No new dependency.

---

## What the code does today (origin/dev `d0325dd`)

- **Settings** (`apps/web/src/app/dashboard/settings/`):
  - `sections/section.tsx:4-11` has the list `SETTINGS_SECTIONS`, six entries: page, paid, notifications, security, plan, data.
  - `settings-view.tsx` draws the nav and the chapters from that list.
  - `sections/my-page.tsx:739-756` (`MyPageSection`) holds PageState, PhotoSettings, AboutYou, HandleChange, TipAmountsSettings and CoverSettings, beside `PagePreview`.
  - `tests/e2e/cover-settings.spec.ts:313-320` asserts the six nav links in order.
- **Receipt** (`apps/web/src/app/tip/[tipId]/status-view.tsx`):
  - the paid state is the "thanks" screen: `tip-thanks`, `<h1>{name} got your thanks.</h1>` at :289, then the `tip-thanks__receipt` Surface at :312-350;
  - the data is `TipStatusView` (`packages/contracts/src/checkout.ts:69-80`), from `tipStatusView` (`packages/database/src/operations/tip-status.ts`), served by `GET /v1/tips/:tipId/status` with the status token (`apps/api/src/checkout/status.controller.ts`);
  - `TipStatusView` "Never includes the supporter's message".
- **Tip form** (`apps/web/src/components/appreciation-form.tsx`):
  - message at :417-435 ("Sent privately with your tip.");
  - name at :436-450 (optional, 60 characters);
  - "Remember my tips on this phone" at :452-466;
  - `createTip` body at :246-254, checked by `tipIntentRequestSchema` (`checkout.ts:41-49`);
  - the start amount is `amountOptions(...).defaultMinor`, from `closestToDefault` (`apps/web/src/lib/tip-amounts.ts:16-31`).
- **Storage:**
  - a message is `tip_messages(tip_id, body)` (`schema.ts:912-924`), written in `createPaymentIntent` (`operations/intents.ts:205-206`);
  - the request fingerprint at `intents.ts:86-95` covers quote, label, message and moment;
  - tips keep only an optional `payer_display_label` (`schema.ts:889`).
- **Hide and report** (`operations/message-flags.ts`): either one inserts `message_flags`. There is no unhide. The routes are `POST /v1/me/tips/:tipId/message/{hide,report}` (`apps/api/src/dashboard/dashboard.controller.ts:165-193`).
- **Covers:**
  - `COVER_COLOURS` (`packages/contracts/src/covers.ts:54-106`) holds 7 colours, each with `base`, `tone` and `line`;
  - `resolveCover` (:177-201) returns `photo` or `design` with an optional `colour`, and automatic covers get a colour from the handle;
  - `feat/animated-covers` adds `{ kind: 'animated', colour? }`.
- **Amounts:**
  - `tipAmountsProblem` (`packages/domain/src/fees.ts:94-110`);
  - `tipAmountsOf` (`operations/profiles.ts:203-222`), which filters out presets below the floor;
  - `PUT /v1/me/tip-amounts` (`apps/api/src/profiles/me-profile.controller.ts:134-146`);
  - the error mapping is in `apps/api/src/http/api-exception.filter.ts:112-113, 217-218, 277-286`.
- **Public page:**
  - `apps/web/src/app/people/[handle]/page.tsx` draws the cover, `RecipientIdentity` (`components/profile/recipient-card.tsx:116-190`) and the `tip-instrument` aside;
  - the selected amount key's styles are at `globals.css:1888-1894`, and it fills with brand purple from `packages/ui`.

---

## Design

### 1. The thank-you line

**Storage:** migration A, additive.

- `profiles.thanks_line text NULL`, with the check `thanks_line IS NULL OR char_length(thanks_line) BETWEEN 1 AND 140`.
- `profiles.thanks_style text NULL`, with the check `thanks_style IS NULL OR thanks_style IN ('paper','violet','night')`. NULL reads as `paper`.
- `profiles.thanks_signed boolean NOT NULL DEFAULT false`.

**Contracts** (new file `packages/contracts/src/thanks.ts`):

```ts
export const THANKS_STYLES = ['paper', 'violet', 'night'] as const;
export type ThanksStyle = (typeof THANKS_STYLES)[number];
export const THANKS_LINE_LIMIT = 140; // code points, so it matches Postgres char_length
/** Control characters out, whitespace collapsed to single spaces, trimmed; '' means "no line". */
export function cleanThanksLine(raw: string): string;
/** True when the text looks like a link: a scheme, `www.`, or a host with a dot and letters after it. */
export function hasLink(text: string): boolean;
export const thanksPatchSchema: z.ZodType<{
  line: string | null; // checked after cleaning: at most 140 code points, no links
  style?: ThanksStyle;
  signed?: boolean;
}>; // .strict()
export interface ThanksChoice {
  line: string | null;
  style: ThanksStyle;
  signed: boolean;
} // stored
export interface ThanksSlip {
  line: string;
  style: ThanksStyle;
  signature?: string;
} // shown
/** What a receipt shows: null without a line; Free (or no plan) is always paper and unsigned. */
export function shownThanks(p: {
  line: string | null;
  style: string | null;
  signed: boolean;
  plan: PagePlan | undefined;
  displayName: string;
}): ThanksSlip | null;
/** True when a save would set a Pro-only part: a style other than paper, or signed: true. */
export function thanksNeedsPro(patch: {
  style?: ThanksStyle;
  signed?: boolean;
}): boolean;
```

- `MyProfile.thanks?: ThanksChoice` holds everything stored, including the hidden Pro parts, so Settings can say they are kept.
- `TipStatusView.thanks?: ThanksSlip` is present only when `state === 'paid'` and a line exists.
- The signature is the first word of the display name at read time (the same rule as `firstName` in `page.tsx:61`). It is never stored, so a name change shows on the next view.
- The receipt shows the line as it is now, not as it was when the tip was made. This is documented in a code comment.

**Rules:**

- The "no links" rule matches the board ("checked like a bio: no links"). Today's bio (`profiles.ts:44`) has no link check. That gap is reported, not fixed here.
- A Free page may save `line` only. A save with `thanksNeedsPro(patch)` on Free is refused with `403 THANKS_PRO_REQUIRED` ("Card styles and your signature are part of TipMe Pro."). Leaving `style` and `signed` out keeps the stored values, so a Free save never erases hidden Pro choices.
- A Pro save with `style` or `signed` uses the conditional `WHERE plan = 'pro'`. If no row updates, the plan is read again: Free throws `THANKS_PRO_REQUIRED`, and anything else returns as unchanged.
- `line: null`, or a line that is empty after cleaning, clears the line.
- The heading stays "{name} got your thanks." (`status-view.tsx:289`). Changing it is an open board question, out of scope.

**Receipt UI:**

- A new `ThanksSlip` component, `apps/web/src/components/thanks-slip.tsx`, used by both the receipt and the Settings preview.
- Markup: `<figure className="thanks-slip" data-style="paper|violet|night"><blockquote><p>{line}</p></blockquote>{signature && <figcaption>{signature}</figcaption>}</figure>`.
- It sits after the live region, inside `paid`, and before the receipt Surface. It is outside the live region, so the announcement stays short.
- The quote mark is CSS `::before`, `aria-hidden` in effect.
- The violet card is TipMe purple with white text, and night is `#141210` with white text. Both pass 4.5:1.
- In `forced-colors` it shows a 1px `CanvasText` border.

### 2. The accent colour (Pro)

**No storage.** The accent is derived from the cover.

**Contracts** (new `packages/contracts/src/accent.ts`):

```ts
export interface AccentTokens {
  fill: string;
  ink: '#000000' | '#ffffff';
  edge: string;
}
/** The colour id a page's accent uses: the cover's colour on a Pro page, otherwise undefined. */
export function pageAccent(
  cover: ResolvedCover | undefined,
  plan: PagePlan | undefined,
): string | undefined;
/** The colour's key fill, its readable text and an edge visible against the tip panel. */
export function accentTokens(colourId: string): AccentTokens | null;
export function contrastRatio(a: string, b: string): number; // WCAG relative luminance
```

**Rules:**

- `pageAccent` gives `cover.colour` for `kind: 'design'`, and for `kind: 'animated'` with a colour once `feat/animated-covers` is in. It gives undefined for a photo cover, a design without colours (`dark`, `indigo`, …), an animation in its own palette, Free, or no plan.
- `accentTokens`:
  - `fill = base`;
  - `ink` is white when `contrastRatio(base, '#ffffff') >= 4.5`, otherwise black. Lilac, Sun and Neutral get black, as the board asks ("weak contrast against white text get dark text automatically");
  - `edge` is the first of `base`, `tone` or `line` that has at least 3:1 against the tip panel surface (`--surface-recessed` in `packages/ui/src/tokens.css`; read the value at implementation time), otherwise `#000000`. This keeps the selected key visible without relying on its fill (WCAG 1.4.11).
- The API computes it: `PublicProfile.accent?: string` and `MyProfile.accent?: string`, from `pageAccent(resolveCover(row), plan)` in `publicProfile` and `toMine`. The web only maps an id to tokens, and draws brand purple when the id is absent, as an older API sends it.

**Where it applies:**

- On `/@handle`, the `<main className="profile-page">` gets `style={{'--page-accent': fill, '--page-accent-ink': ink, '--page-accent-edge': edge}}` and `data-accent={id}`.
- The CSS uses `var(--page-accent, var(--brand-primary))` for:
  - the selected amount key (`.tip-instrument .tm-amount-choice input:checked + span`) and its corner dot;
  - the pinned note's quote mark and its "Pinned by" tag.
- Nothing else changes: the Tip button, the wordmark, focus rings, links and the Pro badge stay brand. Purple stays the signature material (DESIGN-CONSTITUTION:20, LOCKED brand).
- The Settings preview uses `pageAccent` on the cover being looked at, for the preview only.

**Settings card "Your colour":**

- A read-only row of the 7 swatches, each with its visible name, and the one in use marked "In use" in text.
- Under it: "Your accent follows your cover colour. Change it under Cover." with a link to `#cover`.
- On Free: "On TipMe Pro, your page's amount keys take your cover colour." On a photo or colourless cover: "Your cover has no colour, so your page uses TipMe purple."
- Whether a photo cover should get its own picker is an owner question (Q1).

### 3. The pinned note (Pro)

**Storage:**

- Migration C: `tip_messages.may_show boolean NOT NULL DEFAULT false`. It sits on the message row because consent belongs to the note.
- Migration D: `profiles.pinned_tip_id uuid NULL REFERENCES tips(id)`.

**Consent on the tip form:**

- A new checkbox appears under the message field, only while the message has text, and is off by default.
- Label: "{recipient} may show this note on their page". Hint: "With your name, if you gave one. Without this, your note stays private."
- The board's "on her page" is replaced by "their page", because TipMe does not know the recipient's pronoun. Owner check: Q3.
- It sends `noteMayShow: true` only when ticked and a message is sent.
- `tipIntentRequestSchema` gains `noteMayShow: z.literal(true).optional()`.
- `createPaymentIntent` stores `may_show` with the message. A `noteMayShow` with no message is ignored (stored nowhere).
- The fingerprint gets `true` appended only when consent is given. Existing fingerprints for in-flight replays stay byte-identical, and two requests that differ only by consent conflict.
- Analytics: no new event, and no consent value in any event (`apps/web/AGENTS.md`: no free-form messages; consent is about one).

**Pinnable notes:** a tip of this page, `status = 'SUCCEEDED'`, a `tip_messages` row with `may_show = true`, and no `message_flags` row (hidden and reported both create one).

**Operations** (new `packages/database/src/operations/pinned-note.ts`):

```ts
export interface PinnableNote { tipId: string; body: string; name: string | null; at: string }
export function pinnableNotes(db, profileId, limit = 20): Promise<PinnableNote[]>; // newest first
export function setPinnedNote(db, userId, tipId: string | null): Promise<MyProfile>;
export function pinnedNoteOf(db | tx, profile: { id; plan; pinnedTipId }): Promise<{ body: string; name?: string } | null>;
export function withdrawNoteConsent(db, tipId: string): Promise<void>; // the supporter's own withdrawal
```

**Rules:**

- **Pin:**
  - `tipId` null unpins, on any plan, so a lapsed page can always remove a note.
  - A non-null `tipId` needs Pro: `PIN_PRO_REQUIRED`, 403, "Pinning a note is part of TipMe Pro.", checked before the write and in the `WHERE`.
  - It also needs the tip to be pinnable: `NOTE_NOT_PINNABLE`, 404. This is the same answer for another page's tip, an unknown tip, no consent, a hidden or reported note, or an unpaid tip, so it reveals nothing.
  - One `UPDATE … WHERE id = $page AND plan = 'pro' AND EXISTS (pinnable)` does the write, so a hide that races the pin cannot leave a hidden note pinned.
- **Showing:**
  - `pinnedNoteOf` checks the same conditions again at read time and needs Pro.
  - A page that lapses keeps `pinned_tip_id` and shows nothing. It shows again on return to Pro.
  - `name` is `payer_display_label` when present. Without a name, the web shows "A supporter".
- **Hide or report:** `hideMessage` and `reportMessage` set `pinned_tip_id = NULL` where it equals the tip, in the same transaction as the flag. `hideMessage` gains a transaction for this. Both routes then call `ProfileRevalidator.revalidate(handle)`, so the public page drops the note on its next view. The read-time check covers the gap until then.
- **Supporter withdraws:**
  - `POST /v1/tips/:tipId/note-consent/withdraw`, with the receipt's status token, sets `may_show = false` and clears any pin of that tip. It answers 204 and is idempotent.
  - A wrong token is 404, as on the status route.
  - `TipStatusView.noteMayShow?: true` lets the receipt offer "Stop {name} showing my note".
  - Whether to keep this is owner question Q2. It is planned because it is cheap and protects the supporter.
- **Account deletion:** clear `pinned_tip_id` beside the other personal columns in `deleteAccount`.

**API:**

- `GET /v1/me/notes/pinnable`: `{ notes: PinnableNote[]; pinnedTipId: string | null }`. Any plan may read it, since the recipient already sees these notes on the dashboard.
- `PUT /v1/me/pinned-note`: `{ tipId: uuid | null }`, returns `MyProfile`.

**Contracts:**

- `MyProfile.pinnedNote?: { tipId: string; body: string; name: string | null } | null` is the stored pin, shown even after a lapse, with `pinnedNoteShown?: boolean`.
- `PublicProfile.pinnedNote?: { body: string; name?: string }`.

**Public UI:**

- In `RecipientIdentity`, after the bio and before the contact links:
  `<figure className="profile-pinned" aria-labelledby="pinned-label"><p id="pinned-label" className="profile-pinned__tag">Pinned by {firstName}</p><blockquote><p>{body}</p></blockquote><figcaption>{name ?? 'A supporter'}</figcaption></figure>`.
- React renders it as text, never as raw HTML.
- It is not in the metadata, OG image or JSON-LD (`apps/web/AGENTS.md`: no payer-sensitive info in public HTML except this deliberate, consented note; see Review Focus).

**Settings card "A pinned note":**

- The current pin, with an "Unpin" button.
- A radio list of up to 20 pinnable notes (body, name or "A supporter", date), and "Pin this note".
- An empty state: "No notes can be pinned yet. A note can be pinned only when its writer agrees on the tip form."
- Free: a locked description with a link to `#plan`.
- Lapsed with a pin: "Your pinned note is kept. It shows again when your page is Pro." with Unpin.

### 4. The starting amount (Pro)

**Storage:** migration B, `profiles.tip_start_minor bigint NULL`, with the check `tip_start_minor IS NULL OR tip_start_minor = ANY (tip_presets_minor)`. The database itself then refuses a start outside the page's amounts, like `pro-tipping.test.mjs:299`.

**Domain** (`packages/domain/src/fees.ts`):

```ts
/** True when the start is one of the page's own presets. Nothing about fees or the minimum changes. */
export function tipStartAllowed(
  presetsMinor: readonly bigint[],
  startMinor: bigint,
): boolean;
```

**Contracts:**

- `TipAmounts.startMinor?: string`.
- `tipAmountsSchema` gains `startMinor: kobo.nullable().optional()`.

**Server:**

- `setTipAmounts(db, userId, { presetsMinor, minTipMinor, startMinor?: bigint | null })`:
  - a start that is not allowed is `INVALID_TIP_START` (400, `VALIDATION_FAILED`, `fields: ['startMinor']`);
  - an omitted `startMinor` keeps the stored one if it is still among the new presets, otherwise sets it to NULL;
  - `null` clears it;
  - the existing Pro check and `WHERE plan = 'pro'` cover it.
- `tipAmountsOf` sends `startMinor` only when the page is Pro, uses its own amounts, and the stored start is among the payable presets (after the floor filter). Otherwise it sends nothing.

**Web:**

- `amountOptions(amounts).defaultMinor` is `amounts.startMinor` when it is one of `presets`, otherwise `closestToDefault` (`tip-amounts.ts:16-31`, unchanged). `AppreciationForm` and `PagePreview` already read `defaultMinor`.
- Settings, in `TipAmountsSettings` (Pro):
  - a `fieldset` with the legend "Your page starts on" and one radio for each valid filled amount, plus "Closest to ₦2,000 (automatic)";
  - the board's "Starts here" text sits beside the chosen one;
  - it is saved with the amounts, by the same button;
  - Free sees the existing hint plus "Pro pages choose which amount the page starts on."

### 5. The Settings chapter "Make it yours"

- `SETTINGS_SECTIONS` gets `{ id: 'yours', title: 'Make it yours' }` after `page`, which makes seven sections. Update the "six" comments in `section.tsx:3` and `settings-view.tsx:16`.
- A new `apps/web/src/app/dashboard/settings/sections/make-it-yours.tsx` draws the chapter from a registry:

```ts
type Part = {
  id: string;
  title: string;
  Card: () => JSX.Element;
  needs?: 'pro';
};
export const MAKE_IT_YOURS_PARTS: readonly Part[] = [
  { id: 'thanks', title: 'Your thank-you', Card: ThanksSettings },
  { id: 'colour', title: 'Your colour', Card: AccentSettings, needs: 'pro' }, // PR D
  {
    id: 'pinned',
    title: 'A pinned note',
    Card: PinnedNoteSettings,
    needs: 'pro',
  }, // PR D
  {
    id: 'more',
    title: 'Covers that move, QR codes that are yours',
    Card: AlreadyYours,
  },
];
```

- `AlreadyYours` lists what already exists:
  - the cover, linking to `#cover`;
  - QR designs and print formats, linking to `/dashboard/qr`;
  - your own tip amounts and starting amount, linking to `#tip-amounts`;
  - the animated cover, once `feat/animated-covers` is in.
- It has no controls and no price.
- `TipAmountsSettings` gets `id="tip-amounts"`, so the link has a target.

**Slots for later** (a comment above the registry, and this plan):

- "Tip sound" and "When a tip lands" go into `MAKE_IT_YOURS_PARTS` between `pinned` and `more`, with nothing else in the chapter changing.
- `feat/live-updates` puts the boolean "Sound for new tips" in Notifications ("Pop-ups and sound"). When the picker lands, that switch either stays where it is and the picker's card links to it, or moves into the Tip sound card. Decide then, so the switch never appears twice.
- The picker needs a new `profiles.tip_sound_choice text NULL` beside live-updates' `tip_sound boolean`, rather than changing that column.
- Celebrations need `profiles.tip_celebration text NULL`.
- Both resolve the same way at read time: a Pro-only choice falls back to the Free default on Free.

### Lapse summary (Pro → Free)

| Choice             | Kept in storage                    | Shows on Free                                                  |
| ------------------ | ---------------------------------- | -------------------------------------------------------------- |
| Thank-you line     | yes (Free feature)                 | the line                                                       |
| Card style, signed | yes                                | paper, unsigned                                                |
| Accent             | nothing stored (follows the cover) | brand purple                                                   |
| Pinned note        | `pinned_tip_id` kept               | nothing; Settings says it is kept; Unpin works                 |
| Starting amount    | `tip_start_minor` kept             | the standard amounts, starting on ₦2,000 (the closest-to rule) |

---

## Global Constraints

- **Workspace:**
  - The plan lives on `feat/make-it-yours` in `.worktrees/make-it-yours`, off `origin/dev` `d0325dd`.
  - PRs B to D are branches off `origin/dev` once PR A is merged (see PR boundaries). Each PR goes into `dev`.
  - Never push or merge without the owner, and never use bare `git stash`.
- **Read first:**
  - `AGENTS.md` and the nearest scoped `AGENTS.md`: `packages/contracts/AGENTS.md`, `apps/api/AGENTS.md`, `apps/web/AGENTS.md`;
  - for UI, `docs/design/DESIGN-CONSTITUTION.md` and the documents it requires (`REFERENCE-ANATOMY.md`, `RESPONSIVE-COMPOSITION.md`, `VISUAL-QUALITY-GATE.md`);
  - `docs/00-DECISIONS.md`, `docs/agent/ACTIVE_TASK.md` and `docs/agent/HANDOFF.md`, which each PR updates.
- **Pro is enforced on the server:**
  - every Pro-only write checks the plan, then writes with `eq(profiles.plan, 'pro')` in the `WHERE`;
  - every Pro-only display is resolved by the API (`shownThanks`, `pageAccent`, `pinnedNoteOf`, `tipAmountsOf`), and the web shows what it is sent;
  - lapsing hides, and never deletes.
- **Supporters are anonymous:**
  - tips store only an optional name;
  - there is no supporter account, email or matching;
  - consent lives on the message row, and only the status token can withdraw it.
- **Copy:**
  - users never see the payment provider's name (`apps/web/test/no-provider-names.test.mjs` must pass; say "our payment partner");
  - no regulatory, legal or compliance claims;
  - no Pro price anywhere, because `feat/pro-billing` owns the price;
  - locked choices say "Pro" in text.
- **Accessibility:**
  - every control is at least 44px and has a visible label;
  - colour never stands alone ("In use", "Starts here", "Pinned by" are text);
  - radios are in a `fieldset` with a `legend`;
  - errors are tied to their field with `aria-describedby`;
  - after a save, `role="status"` says so;
  - after Unpin, focus goes to the card heading;
  - `expectAccessible(page)` runs in every new e2e test.
- **Migrations:**
  - take the next free number at write time. Dev is at `0070`, and branches already claim `0071` (`feat/social-links`, `feat/live-updates`) and `0074` (`feat/animated-covers`);
  - generate with `pnpm --filter @tipme/database generate`. The journal `when` must be later than every other entry;
  - branches regenerate at merge: renumber the file and snapshot, and regenerate, rather than hand-edit;
  - never relax `packages/database/test/integration/migration-journal.test.mjs`;
  - additive only: new nullable columns, or columns with defaults, and checks.
- **Contracts:**
  - shapes only in `packages/contracts`, with no `any`;
  - every new field is optional, because the web deploys before the API;
  - an older API sending none of them must draw exactly today's page and receipt.
- **OpenAPI:** run `pnpm api:openapi` after any route or shape change, and `tests/integration/openapi.test.mjs` must pass.
- **Reporting:** run commands exactly as written, record pass, fail or skipped, and report every failing test by name with its error.

## Review Focus

1. **Pro locks under a race.** A Free page saving a card style or signature, a pin, or a starting amount is refused, and nothing is written. The same holds when the plan drops between the read and the write (Tasks A3, B2, D3).
2. **Consent and moderation.** Only a consented, paid, unflagged note of this page can be pinned or shown. Hide or report clears the pin in the same transaction. A withdrawal clears it. The public read checks all of this again (Tasks C2, D2, D3).
3. **A public supporter note is a deliberate exception** to "never render payer-sensitive info in public HTML". It is shown only with consent, is never in metadata, OG or JSON-LD, and is never logged or put in analytics. The threat model (P2, P7) and the privacy page say so (Task D6).
4. **Fingerprint stability.** Tips without consent hash exactly as before (Task C2).
5. **Length counting.** 140 means code points in both the contract and Postgres `char_length`, so an emoji line accepted by the web is never refused by the database (Task A1).
6. **Accent contrast.** Every colour's ink has at least 4.5:1 on its fill, and its edge at least 3:1 on the panel. The Tip button stays black (Task D1).
7. **No regression.** Older API responses, Free pages and pages without choices look exactly as today. That covers the receipt heading, the start amount and the visual snapshots (all PRs).

---

## PR boundaries

| PR                                        | Branch                       | Tasks | Migration              | Depends on                                                                 |
| ----------------------------------------- | ---------------------------- | ----- | ---------------------- | -------------------------------------------------------------------------- |
| **A. The chapter and the thank-you line** | `feat/make-it-yours`         | A0–A6 | A: `NNNN_thanks_line`  | —                                                                          |
| **B. The starting amount**                | `feat/make-it-yours-start`   | B1–B4 | B: `NNNN_tip_start`    | none (touches My page, not the chapter); can run beside A                  |
| **C. The consent tick box**               | `feat/make-it-yours-consent` | C1–C3 | C: `NNNN_note_consent` | none. **Ship early:** only notes written after it ships can ever be pinned |
| **D. Pinned note and accent colour**      | `feat/make-it-yours-pin`     | D1–D7 | D: `NNNN_pinned_note`  | A (the chapter) and C (consent)                                            |

Accent and pin share PR D because both change the public page and its visual snapshots, so that page gets one visual review. If D grows too large, split the accent (D1, D4 accent part, D5 accent card) into its own PR. It needs no migration.

## Overlaps with other branches

- **`feat/social-links`** (`581e943`, `docs/superpowers/plans/2026-11-05-social-links.md`):
  - it replaces the About you socials in `my-page.tsx` with a "Your links" section, and adds `PUT /v1/me/links`;
  - it also changes `profiles.ts` (contracts), `toMine` and `publicProfile`, and has its own Pro-lapse rule (the first 3 Free links);
  - it claims migration `0071`;
  - conflicts are expected in `my-page.tsx` (`MyPageSection`'s children), `MyProfile` and `PublicProfile`, `toMine` and `publicProfile`, and `recipient-card.tsx` (the link row sits where the pinned note goes: put the note after the bio and before `Contact`/links);
  - the lapse rules agree: hide, never delete. Whichever merges second rebases and regenerates its migration.
- **`feat/animated-covers`** (`ead3f38`):
  - it changes `resolveCover`, adding `animated` with an optional `colour` and `plan` as an input, `cover-settings.tsx`, `toMine` and `publicProfile`, and claims `0074`;
  - `pageAccent` must handle `kind: 'animated'` with a colour. Write the test against the union with `animated`, guarded so it passes before and after that branch merges;
  - `AlreadyYours` gains the animated cover row once it is in;
  - its fix commit "a page that left Pro opens plain and can re-save" touches `plan.tsx`, as A6 may.
- **`feat/states`** (at `d0325dd`, no commits yet; boards `StatesMap.dc.html` and `StatesConcepts.dc.html`):
  - it will retone every `Notice`, `EmptyState` and field error, including `status-view.tsx:211`, `appreciation-form.tsx:481, 583, 648` and the Settings sections;
  - the new cards here use the existing `Notice` and field-error patterns, so they can be retoned with the rest. Expect conflicts in `status-view.tsx` and `appreciation-form.tsx`, but none in logic.
- **`feat/live-updates`** (`1a1abb3`):
  - it adds `tip_sound` and `popup_hide_tip_details` (migration `0071`), a Notifications card, and `profile.changed` publishing after profile writes in `my-page.tsx` and `plan.tsx`;
  - once it merges, the new routes here (`PUT /v1/me/thanks`, `/pinned-note`, the start amount, and hide or report when a pin is cleared) also publish `profile.changed`, one line each.
- **`feat/pro-billing`** (`595dfb3`, plan only): `plan` becomes recomputed (`recomputePlan`) when a paid month ends. Nothing here keeps its own copy of the plan, and every rule reads `profiles.plan` at read time and in the write's `WHERE`, so no change is needed.

---

## PR A: the chapter and the thank-you line

### Task A0: Bring the boards into the repo, and record the decision

**Files:**

- Create: `docs/design/redesign/boards/ProCustomise.dc.html`, `ProStartAmount.dc.html` and `AppreciationDetails.dc.html`, copied unchanged.
- Modify: `docs/00-DECISIONS.md` and `docs/design/DECISION-LOG.md`.

- [ ] **Step 1: Check, expecting FAIL.**

  ```bash
  test -f docs/design/redesign/boards/ProCustomise.dc.html && grep -q "Make it yours (owner's request" docs/00-DECISIONS.md
  ```

- [ ] **Step 2: Write the entries.**
  - `docs/00-DECISIONS.md`: "Make it yours (owner's request, 5 Nov 2026)". It covers the four items and their Free and Pro split, consent before any note is public, and that lapsing hides without deleting. Say it is a product decision, not a legal, regulatory or provider approval. List the open questions Q1 to Q5.
  - `DECISION-LOG.md`: the accent exception. Pro pages tint only the selected amount key and the pinned note's marks, and the Tip button and brand chrome stay purple or black.
- [ ] **Step 3: Run Step 1 again, expecting PASS, then `pnpm exec prettier --check docs/00-DECISIONS.md docs/design`.**
- [ ] **Step 4: Commit** `docs: Make it yours boards and the owner's request`.

### Task A1: Contracts for the thank-you line

**Files:**

- Create: `packages/contracts/src/thanks.ts`.
- Modify: `packages/contracts/src/index.ts`, `profiles.ts` (`MyProfile.thanks?`), `checkout.ts` (`TipStatusView.thanks?`) and `errors.ts` (`THANKS_PRO_REQUIRED`).
- Test: `packages/contracts/test/thanks.test.mjs` (new).

**Interfaces:** see Design §1.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('cleanThanksLine removes control characters, collapses spaces and trims', ...);
  //   '  Thank\u0007 you\n\nso   much ' -> 'Thank you so much'
  test('a line of 140 code points is accepted, 141 is refused, emoji count once', ...);
  //   '😀'.repeat(140) parses; '😀'.repeat(141) fails with path ['line']; 'a'.repeat(141) fails
  test('a line with a link is refused', ...);
  //   'see https://x.com', 'www.me.ng', 'tipme.xyz/@ada', 'ada.com.ng' fail;
  //   'Thanks a lot. See you soon!', 'No. 1 fan', 'Mr. Ade' pass
  test('null or an empty line clears it', ...);
  //   { line: null } and { line: '   ' } both parse, and cleaned to null
  test('unknown style and extra keys are refused', ...);
  //   { line: 'x', style: 'gold' } fails; { line: 'x', colour: 'red' } fails (strict)
  test('thanksNeedsPro: violet, night or signed: true', ...);
  //   {} false; { style: 'paper' } false; { signed: false } false; { style: 'night' } true; { signed: true } true
  test('shownThanks: Free shows the line on paper, unsigned, whatever is saved', ...);
  //   plan 'free', style 'night', signed true -> { line, style: 'paper' } with no signature
  //   plan undefined behaves as Free
  test('shownThanks: Pro shows its style and signs with the first name', ...);
  //   displayName 'Ada Okafor', signed -> signature 'Ada'; style null -> 'paper'
  test('shownThanks: no line, no slip', ...);
  //   line null -> null on both plans
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm --filter @tipme/contracts build && node --test packages/contracts/test/thanks.test.mjs
  ```

  Expected: FAIL (`thanks.js` is not found).

- [ ] **Step 3: Implement.**
  - Count with `Array.from(s).length`.
  - The link test: `/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/|\b))/i`. Do not match a dot followed by a space, and keep the passing cases above passing.
  - Add the error code to `API_ERROR_CODES`.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm --filter @tipme/contracts build && pnpm --filter @tipme/contracts test && pnpm --filter @tipme/contracts typecheck && pnpm --filter @tipme/contracts lint
  ```

- [ ] **Step 5: Commit** `feat(contracts): the thank-you line, its styles and the Free/Pro rule`.

### Task A2: Storage and the save

**Files:**

- Modify:
  - `packages/database/src/schema.ts` (three columns and two checks);
  - the new migration `packages/database/drizzle/NNNN_thanks_line.sql`, with its snapshot and journal;
  - `packages/database/src/operations/profiles.ts` (`toMine` gets `thanks`; a new `setThanks`; `deleteAccount` clears all three);
  - `packages/database/src/operations/tip-status.ts` (select the profile's thanks columns and plan; `thanks` only when paid);
  - `packages/database/src/operations/errors.ts`.
- Test:
  - `packages/database/test/integration/thanks.test.mjs` (new);
  - `packages/database/test/integration/tip-status.test.mjs` (extend);
  - `migration-journal.test.mjs` (must pass).

**Interfaces (produces):**

```ts
export function setThanks(
  db: Database,
  userId: string,
  patch: ThanksPatch,
): Promise<MyProfile>;
// throws OperationError('THANKS_PRO_REQUIRED') | OperationError('INVALID_INPUT')
```

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a Free page saves and clears its line; style and signed stay as stored', ...);
  //   set the row's thanks_style 'night', thanks_signed true by SQL; Free setThanks({ line: 'Thank you' })
  //   -> MyProfile.thanks deepEqual { line: 'Thank you', style: 'night', signed: true }; then { line: null } -> line null
  test('a Free page sending a style or a signature is refused and nothing changes', ...);
  //   each of { line:'x', style:'violet' } and { line:'x', signed:true } rejects THANKS_PRO_REQUIRED; row xmin unchanged
  test('a Pro page saves night and signed; dropping to Free between read and write refuses it', ...);
  //   hold the profile row lock in a second connection, set plan='free', release; expect THANKS_PRO_REQUIRED, no write
  test('the database refuses a 141-character line and an unknown style', ...);
  //   raw UPDATE fails on profiles_thanks_line_length and profiles_thanks_style
  test('deleting the account clears the line, style and signature', ...);
  // tip-status.test.mjs:
  test('a paid tip receipt carries the recipient's line; a Free page shows paper, unsigned', ...);
  test('a receipt that is not paid has no thank-you, and a page without a line has none', ...);
  test('a page that leaves Pro shows paper and unsigned, and its choices come back on Pro', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/thanks.test.mjs packages/database/test/integration/tip-status.test.mjs packages/database/test/integration/migration-journal.test.mjs
  ```

- [ ] **Step 3: Implement.**
  - Write the schema, then run `pnpm --filter @tipme/database generate`, taking the next free number at that moment.
  - `setThanks`:
    1. parse;
    2. read the row;
    3. if `thanksNeedsPro` and the plan is not `pro`, throw;
    4. run one `UPDATE` setting only the keys present (`thanks_line` always), with `...(needsPro ? [eq(profiles.plan,'pro')] : [])` in the `WHERE`;
    5. on 0 rows, read the plan again: Free throws, and anything else is unchanged;
    6. return `toMine`.
- [ ] **Step 4: Run Step 2's command, expecting PASS, then `pnpm --filter @tipme/database typecheck && pnpm --filter @tipme/database lint`.**
- [ ] **Step 5: Commit** `feat(database): store the thank-you line; Pro-only style and signature`.

### Task A3: API

**Files:**

- Modify:
  - `apps/api/src/profiles/me-profile.controller.ts` (`PUT /v1/me/thanks`);
  - `apps/api/src/http/api-exception.filter.ts` (`THANKS_PRO_REQUIRED` 403 with its message; `INVALID_INPUT` from this route maps to `fields: ['line']`, so add a route-specific `INVALID_THANKS_LINE` operation error rather than reuse `INVALID_INPUT`, which maps to `['message']`);
  - `apps/api/src/openapi/document.ts`;
  - `docs/api/openapi.json`.
- Test: `tests/integration/thanks-api.test.mjs` (new).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('PUT /v1/me/thanks saves a Free line and the receipt shows it after payment', ...);
  //   pretend-pay a tip (helpers) -> GET /v1/tips/:id/status with the token -> data.thanks deepEqual { line, style: 'paper' }
  test('a Free page sending a style gets 403 THANKS_PRO_REQUIRED', ...);
  test('a link or 141 characters is 400 VALIDATION_FAILED with fields ["line"]', ...);
  test('Pro: night and signed show on the receipt with the first name; staff moving the page to Free hides them', ...);
  //   setPlan(pro) -> PUT { line, style:'night', signed:true } -> receipt thanks.signature 'Ada'; setPlan(free) -> style 'paper', no signature
  test('without a session or CSRF the route is refused', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/thanks-api.test.mjs tests/integration/openapi.test.mjs
  ```

- [ ] **Step 3: Implement.** Use `ZodValidationPipe(thanksPatchSchema)`, call `setThanks`, then `revalidator.revalidate(handle)`. The public page does not show the line, but keep the pattern for when live-updates' `profile.changed` lands. Then run `pnpm api:openapi`.
- [ ] **Step 4: Run Step 2's command, expecting PASS, then `pnpm --filter @tipme/api typecheck && pnpm --filter @tipme/api lint`.**
- [ ] **Step 5: Commit** `feat(api): PUT /v1/me/thanks`.

### Task A4: The receipt slip

**Files:**

- Create: `apps/web/src/components/thanks-slip.tsx`.
- Modify: `apps/web/src/app/tip/[tipId]/status-view.tsx` and `apps/web/src/app/globals.css` (`.thanks-slip`, the three styles, forced colours).
- Test: `tests/e2e/thanks.spec.ts` (new) and `tests/e2e/checkout.spec.ts` (existing, must pass unchanged).

- [ ] **Step 1: Write the failing e2e tests** (pretend payments only).

  ```ts
  test('a supporter reads the recipient's thank-you line under "got your thanks."', ...);
  //   recipient saves 'Thank you for backing my channel.' -> tip -> heading 'Ada Okafor got your thanks.'
  //   then getByRole('figure') contains the blockquote text; no figcaption on Free; expectAccessible(page)
  test('a Pro night card is signed with the first name, and is plain paper after the page leaves Pro', ...);
  //   figure has data-style 'night' and figcaption 'Ada'; staff set Free; reload -> data-style 'paper', no figcaption
  test('no line means no slip, and the receipt reads exactly as before', ...);
  //   figure count 0; the heading and receipt text are unchanged
  test('the slip has a visible edge in forced colours', ...);
  //   emulateMedia({ forcedColors: 'active' }); computed border-top-style !== 'none'
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm test:e2e -- tests/e2e/thanks.spec.ts
  ```

- [ ] **Step 3: Implement** as Design §1 describes. Draw the slip only for `paid && tip.thanks`.
- [ ] **Step 4: Run, expecting PASS.**

  ```bash
  pnpm test:e2e -- tests/e2e/thanks.spec.ts tests/e2e/checkout.spec.ts tests/e2e/pilot-notice.spec.ts && node --test apps/web/test/no-provider-names.test.mjs && pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint
  ```

- [ ] **Step 5: Commit** `feat(web): the recipient's thank-you on the supporter's receipt`.

### Task A5: The "Make it yours" chapter and the thank-you card

**Files:**

- Create: `apps/web/src/app/dashboard/settings/sections/make-it-yours.tsx` (the registry, `ThanksSettings` and `AlreadyYours`).
- Modify:
  - `sections/section.tsx` (add `yours` after `page`; "seven");
  - `settings-view.tsx` (render `<MakeItYoursSection />` after `MyPageSection`; comment);
  - `sections/my-page.tsx` (`id="tip-amounts"` on the Pro and Free tip amount cards);
  - `globals.css`.
- Test: `tests/e2e/cover-settings.spec.ts` (the `SECTIONS` list gains `['Make it yours', 'yours']`) and `tests/e2e/make-it-yours.spec.ts` (new).

**`ThanksSettings`:**

- A `TextareaField` labelled "Your thank-you line", with `maxLength={140}`. The hint is `{n} of 140`, counted in code points, plus "Supporters read it on their receipt right after paying. No links."
- On Pro, a `fieldset` "Card style" with the radios Paper, Violet and Night, and a checkbox `Sign it "{firstName}"`.
- On Free, in place of those: "Card styles and your signature are part of TipMe Pro." with a link to `#plan`.
- On a lapsed page with Pro choices stored: "Your card style and signature are kept for when your page is Pro again."
- Beside it, "The supporter's receipt", a preview with today's heading and a `ThanksSlip` that follows unsaved edits.
- "Save thank-you" sends `{ line }` on Free, and `{ line, style, signed }` on Pro.
- Errors: `THANKS_PRO_REQUIRED` shows that message, and `fields: ['line']` shows "Keep it to 140 characters, with no links."
- An older API (no `profile.thanks`) gets no card. The chapter still shows `AlreadyYours`.

- [ ] **Step 1: Write the failing e2e tests.**

  ```ts
  // cover-settings.spec.ts: SECTIONS now has seven entries, 'Make it yours' second; reachEachSection passes
  test('Make it yours: a Free page writes its thank-you line and sees it in the receipt preview', ...);
  //   type -> preview figure text follows before saving; Save -> role=status 'Saved'; reload keeps it; expectAccessible
  test('Make it yours: a Free page sees card styles and the signature as Pro, with no price', ...);
  //   no radio 'Night'; text 'part of TipMe Pro'; no '₦' in the card
  test('Make it yours: a Pro page picks Night and signs; the preview shows both', ...);
  test('Make it yours: a link in the line is refused next to the field', ...);
  //   error text tied by aria-describedby; focus on the field
  test('Make it yours: the "already yours" card links to the cover, QR and tip amounts', ...);
  //   links to #cover, /dashboard/qr and #tip-amounts reach their targets
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm test:e2e -- tests/e2e/make-it-yours.spec.ts tests/e2e/cover-settings.spec.ts
  ```

- [ ] **Step 3: Implement.** Use the registry exactly as in Design §5, with the "Slots for later" comment above it.
- [ ] **Step 4: Run Step 2's command, expecting PASS, then `pnpm --filter @tipme/web typecheck && pnpm --filter @tipme/web lint`.**
- [ ] **Step 5: Commit** `feat(web): Settings gets "Make it yours", starting with your thank-you`.

### Task A6: The Plan list, handoff and PR

**Files:** `apps/web/src/app/dashboard/settings/sections/plan.tsx` (Pro list: "Card styles and your signature on your thank-you"), `docs/agent/ACTIVE_TASK.md`, `docs/agent/HANDOFF.md`. Test: `tests/e2e/pro.spec.ts` (extend one assertion).

- [ ] **Step 1:** Add the assertion `the Plan section lists card styles and a signature among Pro features`, and run `pnpm test:e2e -- tests/e2e/pro.spec.ts`, expecting FAIL.
- [ ] **Step 2:** Implement, then run it again, expecting PASS.
- [ ] **Step 3: Full checks.**

  ```bash
  pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e
  ```

  Record each one's result.

- [ ] **Step 4:** Update ACTIVE_TASK and HANDOFF with the verified state and the next step (PR B, C or D).
- [ ] **Step 5: Commit** `feat(web): Plan lists the thank-you card styles`.

---

## PR B: the starting amount

### Task B1: Domain and contracts

**Files:** `packages/domain/src/fees.ts` (`tipStartAllowed`), `packages/contracts/src/profiles.ts` (`TipAmounts.startMinor?` and `tipAmountsSchema.startMinor`). Tests: `packages/domain/test/fees.test.mjs` and `packages/contracts/test/contracts.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('tipStartAllowed: only one of the page's own presets', ...);
  //   ([500000n,1000000n,2000000n], 1000000n) true; 300000n false; [] with anything false
  test('tipAmountsSchema takes an optional or null startMinor in kobo', ...);
  //   '1000000' ok; null ok; omitted ok; '10.5' fails; 1000000 (number) fails
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm --filter @tipme/domain build && pnpm --filter @tipme/contracts build && node --test packages/domain/test/fees.test.mjs packages/contracts/test/contracts.test.mjs
  ```

- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expecting PASS, then typecheck and lint both packages.**
- [ ] **Step 5: Commit** `feat(domain): a Pro page's starting amount must be one of its own`.

### Task B2: Storage and the save

**Files:**

- Modify:
  - `schema.ts` (`tipStartMinor` and the check);
  - the migration `NNNN_tip_start.sql`;
  - `operations/profiles.ts`: `tipAmountsOf` takes `tipStartMinor` and sends `startMinor` only as Design §4 says; `setTipAmounts` takes `startMinor?: bigint | null`;
  - `operations/errors.ts` (`INVALID_TIP_START`).
- Test: `packages/database/test/tip-amounts.test.mjs` (pure), `tests/integration/pro-tipping.test.mjs` (extend) and `migration-journal.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  // tip-amounts.test.mjs (pure tipAmountsOf)
  test('a Pro page with a saved start among its amounts sends it', ...);
  //   presets [5000,10000,20000] naira, start 10000 -> startMinor '1000000'
  test('a Free page sends no start, whatever is saved', ...);
  test('a start below the floor (an old saved amount) is not sent', ...);
  //   presets [1000, 5000] naira under the old floor, start 1000 -> no startMinor; presets ['500000']
  // pro-tipping.test.mjs
  test('a Pro page chooses its starting amount; one outside its amounts is 400 with fields ["startMinor"]', ...);
  test('re-saving amounts without the start keeps it if still offered, and clears it if removed', ...);
  //   save [5k,10k,20k] start 10k -> save [5k,20k] (no startMinor) -> GET profile tipAmounts has no startMinor; DB column NULL
  test('a Free page sending a start is refused PRO_REQUIRED; leaving Pro shows the standard amounts with no start, and returning brings it back', ...);
  test('the database refuses a start that is not one of the presets', ...);
  //   raw UPDATE set tip_start_minor = 300000 fails on profiles_tip_start_in_presets
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --test packages/database/test/tip-amounts.test.mjs && node --import ./packages/observability/dist/register.js --test tests/integration/pro-tipping.test.mjs packages/database/test/integration/migration-journal.test.mjs
  ```

- [ ] **Step 3: Implement.** The controller passes `startMinor` through: `undefined` stays `undefined`, `null` stays `null`, and a string becomes `BigInt`. Map `INVALID_TIP_START` in the exception filter. Run `pnpm api:openapi`.
- [ ] **Step 4: Run Step 2's command, expecting PASS, plus `tests/integration/openapi.test.mjs`, typecheck and lint.**
- [ ] **Step 5: Commit** `feat(database,api): a Pro page saves the amount its page starts on`.

### Task B3: The web reads it

**Files:** `apps/web/src/lib/tip-amounts.ts` (`amountOptions`). Test: `apps/web/test/tip-amounts.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('the picker starts on the page's chosen amount', ...);
  //   { presetsMinor: ['500000','1000000','2000000'], minMinor: '500000', startMinor: '1000000' } -> defaultMinor 1000000
  test('a start that is not among the presets is ignored for the closest-to-₦2,000 rule', ...);
  //   startMinor '700000' -> defaultMinor 500000
  test('no start keeps today's rule', ...);
  //   the existing 'closest preset, the lower on a tie' cases unchanged
  ```

- [ ] **Step 2: Run** `node --test apps/web/test/tip-amounts.test.mjs`, expecting FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expecting PASS.**
- [ ] **Step 5: Commit** `feat(web): the tip form starts on the page's chosen amount`.

### Task B4: The Settings control

**Files:** `apps/web/src/app/dashboard/settings/sections/my-page.tsx` (`TipAmountsSettings`). Test: `tests/e2e/pro-start-amount.spec.ts` (new).

**UI:**

- Below the amount fields: `<fieldset><legend>Your page starts on</legend>`.
- One radio for each filled amount that parses, labelled `NGN 10,000`, then "Closest to NGN 2,000 (automatic)".
- The chosen one shows the text "Starts here".
- The radios follow the fields as they are typed. A removed amount that was chosen moves the choice to automatic.
- Saving sends `startMinor` (null for automatic). Errors with `fields: ['startMinor']` show "Choose one of your own amounts." beside the fieldset.
- Free: one hint line added to the existing card.

- [ ] **Step 1: Write the failing e2e tests.**

  ```ts
  test('a Pro page picks ₦10,000 to start on, and its page opens on ₦10,000', ...);
  //   amounts 5000, 10000, 20000; choose radio 'NGN 10,000'; Save; open /@handle ->
  //   radio 'NGN 10,000' checked and the button reads 'Tip ₦10,000'; the Settings preview shows the same
  test('removing the chosen amount moves the choice to automatic, and the page starts on the closest to ₦2,000', ...);
  test('a page that leaves Pro starts on ₦2,000 again, and gets its choice back on Pro', ...);
  test('Free sees that choosing the start is part of Pro, with no price', ...);
  //   each test ends with expectAccessible(page)
  ```

- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/pro-start-amount.spec.ts`, expecting FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expecting PASS, plus `tests/e2e/tip-card.spec.ts tests/e2e/pro.spec.ts`, then the full checks as in A6 Step 3.** Update ACTIVE_TASK and HANDOFF.
- [ ] **Step 5: Commit** `feat(web): Pro chooses the amount its page starts on`.

---

## PR C: the consent tick box

### Task C1: Contracts

**Files:** `packages/contracts/src/checkout.ts` (`tipIntentRequestSchema.noteMayShow`; `TipStatusView.noteMayShow?: true`). Test: `packages/contracts/test/checkout.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('noteMayShow is only ever true, or absent', ...);
  //   { quoteId, message: 'x', noteMayShow: true } ok; noteMayShow: false fails; 'yes' fails; absent ok
  ```

- [ ] **Step 2: Run, expecting FAIL. Step 3: Implement. Step 4: Run, expecting PASS, and run the package checks.**
- [ ] **Step 5: Commit** `feat(contracts): a supporter may let the recipient show their note`.

### Task C2: Storage

**Files:**

- Modify:
  - `schema.ts` (`tipMessages.mayShow`);
  - the migration `NNNN_note_consent.sql`;
  - `operations/intents.ts` (`CreatePaymentIntentInput.noteMayShow?: true`, the insert, and the fingerprint);
  - `operations/tip-status.ts` (`noteMayShow` when paid and `may_show`).
- Test: `packages/database/test/integration/intents.test.mjs` (extend) and `tip-status.test.mjs` (extend).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('a tip with a note and consent stores may_show; without consent it is false', ...);
  test('consent without a note stores nothing and does not fail', ...);
  //   no tip_messages row; tip created
  test('the fingerprint of a tip without consent is unchanged', ...);
  //   compute the pre-change hash for a fixed input (inline the old JSON array) and compare with the stored request_fingerprint
  test('replaying a key with consent added is IDEMPOTENCY_CONFLICT', ...);
  test('the paid receipt says the note may be shown, and never carries the note', ...);
  //   view.noteMayShow === true; JSON.stringify(view) does not include the body
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/intents.test.mjs packages/database/test/integration/tip-status.test.mjs packages/database/test/integration/migration-journal.test.mjs
  ```

- [ ] **Step 3: Implement.** Pass `noteMayShow` through in `apps/api/src/checkout/checkout.controller.ts`, then run `pnpm api:openapi`.
- [ ] **Step 4: Run Step 2's command plus `tests/integration/checkout-api.test.mjs tests/integration/openapi.test.mjs`, expecting PASS.**
- [ ] **Step 5: Commit** `feat(database): keep a supporter's consent with their note`.

### Task C3: The tick box

**Files:** `apps/web/src/components/appreciation-form.tsx` and `globals.css` (reuse `.tip-remember`). Test: `tests/e2e/note-consent.spec.ts` (new) and `tests/e2e/checkout.spec.ts` (must pass).

- [ ] **Step 1: Write the failing e2e tests.**

  ```ts
  test('the consent box appears only with a note, is off by default and is named for the recipient', ...);
  //   no checkbox before typing; type a note -> checkbox 'Ada may show this note on their page' not checked
  test('a ticked box is sent; an unticked one is not', ...);
  //   route-intercept POST /v1/tip-intents: body.noteMayShow === true / absent
  test('clearing the note hides the box and sends no consent', ...);
  test('the tip form stays accessible with the box shown', ...); // expectAccessible
  ```

- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/note-consent.spec.ts`, expecting FAIL.
- [ ] **Step 3: Implement.** Changing the box resets `draftKey`, as other fields do.
- [ ] **Step 4: Run, expecting PASS, plus `checkout.spec.ts tip-card.spec.ts`, then the full checks.** Update ACTIVE_TASK and HANDOFF.
- [ ] **Step 5: Commit** `feat(web): a supporter can agree to their note being shown`.

---

## PR D: pinned note and accent colour

### Task D1: Contracts (accent and pinned note)

**Files:** `packages/contracts/src/accent.ts` (new) and `profiles.ts` (`MyProfile.accent?`, `pinnedNote?`, `pinnedNoteShown?`; `PublicProfile.accent?`, `pinnedNote?`; `pinNoteSchema`), `errors.ts` (`PIN_PRO_REQUIRED`, `NOTE_NOT_PINNABLE`). Tests: `packages/contracts/test/accent.test.mjs` (new) and `contracts.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('every cover colour's ink reads at 4.5:1 on its fill', ...);
  //   for each COVER_COLOURS id: contrastRatio(t.fill, t.ink) >= 4.5; lilac, sun, neutral -> '#000000'
  test('every edge is at least 3:1 against the tip panel', ...);
  //   panel = the --surface-recessed value from packages/ui/src/tokens.css, read in the test
  test('pageAccent: a Pro page with a coloured cover gets its colour', ...);
  //   { kind:'design', design:'scattered', colour:'ocean' }, 'pro' -> 'ocean'
  test('pageAccent: Free, no plan, a photo or a colourless design get none', ...);
  test('pageAccent: an animated cover with a colour gives it; without one gives none', ...);
  //   written against { kind: 'animated', ... } cast, so it passes before and after feat/animated-covers
  test('contrastRatio matches WCAG for black on white', ...); // 21
  test('pinNoteSchema takes a uuid or null, nothing else', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL. Step 3: Implement. Step 4: Run, expecting PASS, with the package checks.**
- [ ] **Step 5: Commit** `feat(contracts): accent from the cover colour, and the pinned note shapes`.

### Task D2: Storage and rules

**Files:**

- Modify:
  - `schema.ts` (`profiles.pinnedTipId`);
  - the migration `NNNN_pinned_note.sql`;
  - `operations/pinned-note.ts` (new; Design §3);
  - `operations/message-flags.ts` (clear the pin in the same transaction; `hideMessage` becomes transactional; both return the handle when a pin was cleared);
  - `operations/profiles.ts` (`toMine` and `publicProfile` get `accent`, `pinnedNote` and `pinnedNoteShown`; `deleteAccount` clears the pin);
  - `index.ts` exports;
  - `operations/errors.ts`.
- Test: `packages/database/test/integration/pinned-note.test.mjs` (new) and `migration-journal.test.mjs`.

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('only a paid, consented, unflagged note of this page is pinnable', ...);
  //   pinnableNotes lists A (consent); not B (no consent), C (hidden), D (reported), E (AWAITING_PAYMENT), F (another page)
  test('a Pro page pins A and the public page shows it with the supporter's name, or none when anonymous', ...);
  //   publicProfile(...).pinnedNote deepEqual { body, name: 'Chidi' }; anonymous tip -> { body } only
  test('pinning B, C, D, E or F is NOTE_NOT_PINNABLE, the same error for each', ...);
  test('a Free page cannot pin (PIN_PRO_REQUIRED), but can unpin', ...);
  test('the plan dropping between read and write refuses the pin', ...);
  test('hiding or reporting the pinned note unpins it in the same transaction', ...);
  //   after hideMessage: pinned_tip_id NULL; a hide racing a pin (two connections) never leaves a flagged pin
  test('leaving Pro hides the pin and keeps it; returning shows it again', ...);
  //   publicProfile has no pinnedNote on Free; toMine.pinnedNote kept with pinnedNoteShown false
  test('the supporter withdrawing consent unpins and makes it unpinnable', ...);
  test('publicProfile sends accent only for Pro pages with a coloured cover', ...);
  test('deleting the account clears the pin', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=@tipme/database... && node --import ./packages/observability/dist/register.js --test packages/database/test/integration/pinned-note.test.mjs packages/database/test/integration/migration-journal.test.mjs
  ```

- [ ] **Step 3: Implement.** Use one `UPDATE … WHERE plan = 'pro' AND EXISTS(pinnable)`, as Design §3 says.
- [ ] **Step 4: Run, expecting PASS, then typecheck and lint.**
- [ ] **Step 5: Commit** `feat(database): pin one consented note; hide, report and withdrawal unpin it`.

### Task D3: API

**Files:**

- Modify:
  - `apps/api/src/profiles/me-profile.controller.ts` (`GET /v1/me/notes/pinnable`, `PUT /v1/me/pinned-note`);
  - `apps/api/src/dashboard/dashboard.controller.ts` (inject `ProfileRevalidator`; revalidate after a hide or report that cleared a pin);
  - `apps/api/src/checkout/status.controller.ts` (`POST /v1/tips/:tipId/note-consent/withdraw`, the same token check, 204);
  - the exception filter, OpenAPI and `docs/api/openapi.json`.
- Test: `tests/integration/pinned-note-api.test.mjs` (new), plus `message-reports.test.mjs` and `dashboard-api.test.mjs` (must pass).

- [ ] **Step 1: Write the failing tests.**

  ```js
  test('Pro pins a consented note and GET /v1/profiles/:handle returns it', ...);
  test('another page's tip, or a note without consent, is 404 NOTE_NOT_PINNABLE', ...);
  test('Free gets 403 PIN_PRO_REQUIRED; unpinning with null works on Free', ...);
  test('reporting the pinned note removes it from the public profile', ...);
  test('the supporter withdraws with the status token; a wrong token is 404 and changes nothing', ...);
  test('the public profile of a Pro page with an ocean cover has accent "ocean"; Free has none', ...);
  test('routes need a session and CSRF; the withdraw route needs only the token', ...);
  ```

- [ ] **Step 2: Run, expecting FAIL.**

  ```bash
  pnpm turbo run build --filter=!@tipme/web && node --import ./packages/observability/dist/register.js --test tests/integration/pinned-note-api.test.mjs tests/integration/message-reports.test.mjs tests/integration/dashboard-api.test.mjs tests/integration/openapi.test.mjs
  ```

- [ ] **Step 3: Implement.** Run `pnpm api:openapi`.
- [ ] **Step 4: Run, expecting PASS, then typecheck and lint.**
- [ ] **Step 5: Commit** `feat(api): pinned notes, the supporter's withdrawal, and the page accent`.

### Task D4: The public page

**Files:** `apps/web/src/app/people/[handle]/page.tsx` (accent variables on `main`), `apps/web/src/components/profile/recipient-card.tsx` (`PinnedNote`), `globals.css` (`var(--page-accent, var(--brand-primary))` on the selected key and dot; `.profile-pinned`), and `tests/e2e/profile.visual.spec.ts-snapshots` (updated only for the new fixture). Test: `tests/e2e/pinned-note.spec.ts` (new), `tests/e2e/page-accent.spec.ts` (new), and `profile-page.spec.ts`, `tip-card.spec.ts`, `profile.visual.spec.ts` (all must pass).

- [ ] **Step 1: Write the failing e2e tests.**

  ```ts
  // page-accent.spec.ts
  test('a Pro page with an Ocean cover fills the chosen amount key with Ocean; the Tip button stays black', ...);
  //   computed background of the checked key span === rgb(29, 78, 137); the submit button background is black
  test('Lilac and Sun keys get dark text', ...);
  test('a Free page and a photo-cover Pro page keep TipMe purple', ...);
  test('leaving Pro returns the key to purple', ...);
  // pinned-note.spec.ts
  test('a pinned note shows under the bio with "Pinned by Ada" and the supporter's name', ...);
  test('an anonymous pinned note is signed "A supporter"', ...);
  test('the note is not in the page title, description or OG tags', ...);
  //   head meta content and og:description do not contain the note body
  test('after the recipient reports the note, the page no longer shows it', ...);
  //   every test ends with expectAccessible(page)
  ```

- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/page-accent.spec.ts tests/e2e/pinned-note.spec.ts`, expecting FAIL.
- [ ] **Step 3: Implement.** The existing visual snapshots must stay unchanged, since their fixtures are Free or have no pin. Update a snapshot only if a fixture is deliberately changed, and say so in the PR.
- [ ] **Step 4: Run, expecting PASS, plus `profile-page.spec.ts tip-card.spec.ts profile.visual.spec.ts`.**
- [ ] **Step 5: Commit** `feat(web): Pro pages take their cover colour and show a pinned note`.

### Task D5: Settings cards and the receipt withdrawal

**Files:** `sections/make-it-yours.tsx` (`AccentSettings`, `PinnedNoteSettings`, registered as in Design §5), `sections/page-preview.tsx` (preview accent and pinned note), `apps/web/src/app/tip/[tipId]/status-view.tsx` (the quiet "Stop {name} showing my note" button when `noteMayShow`, then `role="status"` "Done. Your note won't be shown."). Test: `tests/e2e/make-it-yours.spec.ts` (extend) and `tests/e2e/note-consent.spec.ts` (extend).

- [ ] **Step 1: Write the failing e2e tests.**

  ```ts
  test('Make it yours: Your colour marks the cover colour "In use" and links to Cover', ...);
  test('Make it yours: a Pro page pins a note, sees it in the preview, and unpins it; focus returns to the heading', ...);
  test('Make it yours: with no consented notes the card explains why', ...);
  test('Make it yours: Free sees the pinned note and colour as Pro, with no price', ...);
  test('Make it yours: a lapsed page sees its pin is kept and can unpin it', ...);
  test('the supporter stops their note being shown from the receipt', ...);
  //   pinned note on /@handle -> receipt button -> status text -> /@handle no longer shows it
  ```

- [ ] **Step 2: Run** `pnpm test:e2e -- tests/e2e/make-it-yours.spec.ts tests/e2e/note-consent.spec.ts`, expecting FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expecting PASS, then web typecheck and lint.**
- [ ] **Step 5: Commit** `feat(web): choose a pinned note and see your colour in Make it yours`.

### Task D6: Privacy, threat model and the Plan list

**Files:** `apps/web/src/app/legal/privacy/page.tsx` (one plain sentence: a supporter's note is private unless they tick the box, and then the recipient may show it and its name on their page; the supporter can stop it from their receipt), `docs/security/threat-model.md` (P2 and P7: the consented public note, its controls and tests), `docs/architecture/ERD.md` (new columns), and `plan.tsx` (Pro list: your colour; one pinned note; the starting amount). Test: `tests/e2e/pro.spec.ts` (assertion) and `apps/web/test/no-provider-names.test.mjs`.

- [ ] **Step 1:** Add the assertion, and run it, expecting FAIL.
- [ ] **Step 2:** Write the copy, with no legal or compliance claims, and run it, expecting PASS. Then run `pnpm exec prettier --check docs`.
- [ ] **Step 3: Commit** `docs: a supporter's consented note on the recipient's page`.

### Task D7: Full checks and handoff

- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm perf:lab`. The profile LCP must stay under 2000ms with a pinned note and an accent. Record each result.
- [ ] Update `docs/agent/ACTIVE_TASK.md` and `HANDOFF.md`: verified state, migrations taken, and the slots left for the tip sound and celebrations.
- [ ] Commit `docs: handoff for Make it yours`.

---

## Questions only the owner can answer

- **Q1. A photo cover has no colour.** Should a Pro page with a photo or colourless cover pick its accent from the 7 colours, as the board's swatches suggest? This plan derives the accent from the cover only, with no new column.
- **Q2. Withdrawal.** May the supporter stop their note being shown from their receipt, as planned in D3 and D5? The receipt link is the only thing that proves who they are.
- **Q3. Wording.** The board says "Ada may show this note on her page". TipMe does not know pronouns, so this plan uses "their page". Is that acceptable, or should it be "Ada may show this note on Ada's page"?
- **Q4. Old notes.** Notes written before the tick box ships can never be pinned. Agreed, and so ship PR C first?
- **Q5. Edited lines.** The receipt shows the thank-you line as it is now, so an edit also changes old receipts. Keep it this way, or freeze the line onto each tip?

## Reported, not fixed

- The bio has no "no links" check (`packages/contracts/src/profiles.ts:44`), although the board describes the thank-you line as "checked like a bio".
- The board's swatch hexes (for example Forest `#2f6b4f`) differ from `COVER_COLOURS` (Forest `#1f4d3a`). This plan uses `COVER_COLOURS`.
- Staff cannot remove a recipient's pinned note directly. Today the only routes are the recipient's hide or report and the supporter's withdrawal. Consider adding this to ops later.
