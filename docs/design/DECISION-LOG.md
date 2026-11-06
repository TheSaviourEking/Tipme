# Design decision log

## 2026-11-05 — States: the connection-failure copy

The owner approved changing the connection-failure wording (states plan
`docs/superpowers/plans/2026-11-05-states.md`, Task 17) with the plan's proposed
answers to its questions 1 to 4. The strings live in one file,
`apps/web/src/lib/connection-copy.ts`. A copy decision, not a regulatory approval.

1. **"Your code still works." is dropped** (it can't be proven: a first try that
   reached TipMe has used the code). Sign-in, both tries dropped: "That didn’t go
   through. The connection dropped before your code reached us. Tap Continue
   again."
2. **No "Your account and your money are safe."** TipMe's own faults say "This is
   on our side. Try again in a minute." on sign-in and welcome. On the tip form,
   before the redirect to the payment partner (the only way to pay), the line
   also says "You haven’t paid anything.": "This is on our side. You haven’t paid
   anything. Try again in a minute." Never on withdraw.
3. **Welcome says "Tap Continue"**, as its buttons read: "That didn’t save. The
   connection dropped. Tap Continue to try again."
4. **A code used by a dropped first try:** "That code can’t be used now. Tap Send
   a new code.", with the "Send a new code" key lit.

Unchanged from the plan: "You’re offline. Connect to the internet and we’ll send
your tip." (tip form, offline at the tap), "Your tip didn’t go through. The
connection dropped before it reached us. You haven’t paid anything. Tap Tip to
send it again." (tip form, both tries dropped), and on the receipt's "Connection
lost" slip "We’ll check again in a moment." or "You’re offline.".

## 2026-11-05 — Bank picker: search your bank (A) and the name check on its own (C)

The owner approved sections A and C of the `BankPicker` board
(`docs/design/redesign/boards/BankPicker.dc.html`) for the Get paid card:

1. Popular banks show as keys only when their code is in the partner's list.
2. Forgiving aliases. The alias list lives in code and is unit-tested.
3. Popular keys first, then A to Z. Microfinance and mortgage banks are grouped
   under "More banks", classified from their names.
4. Phones get a full-screen sheet with the search field focused.
5. The WAI-ARIA combobox and listbox pattern.
6. The name check fires once a bank is chosen and 10 digits are typed. It never
   fires again for the same bank-and-number pair. "Check again" shows only after
   an error.
7. All existing copy is kept, except "The payment provider can’t pay to this
   account. Please add another.", which becomes "Our payment partner can’t pay
   to this account. Please add another." By the owner's later ruling (5 Nov
   2026), the card's two other "payment provider" messages also say "our
   payment partner".
8. Users never see the provider's name.

Rulings on the plan's open questions (5 Nov 2026): popular keys stay code-only,
because the partner's live list could not be checked (staging is behind a
preview password that is not to be used), so a key whose code is missing simply
hides; badge colours are the board's, with initials only and no logos.

B (account number first) deferred until the payment partner confirms its codes
are CBN codes. Presentation only: the bank list, codes, name-check limit, email
code and bank-change pause are unchanged. No regulatory or partner approval is
implied (`docs/00-DECISIONS.md`).

## 2026-10-27 — Payer-total-only tip summary

At the product owner's direction, the public tip quote displays only the exact
amount the supporter pays. The fee breakdown, recipient net, and fee-policy
version are removed from that summary; quote calculation and payment behavior
are unchanged. This presentation conflicts with PRD v1.1's fee-treatment
disclosure requirement and no-hidden-fees principle. Revisit before enabling
real payments; live payments remain disabled.

## 2026-10-27 — Recipient onboarding and tip-purpose baselines

Accepted for PR #23: the public profile gains an optional structured tip-purpose
selector, while navigation, footer, and preview copy reflect the current
individual/business and test-mode experience. The selector adds a deliberate
step before the personal message; desktop remains the portrait-led composition,
and mobile remains a readable single sequence with no overlap. The Darwin and
Linux screenshot baselines were refreshed only after reviewing the CI
expected/actual/diff images at both sizes. This changes presentation only; it
does not change payment outcomes or provider behavior.

## 2026-10-26 — Production launch countdown

Approved for the public production hold: one focused TipMe composition with no
navigation, footer, email capture or preview language. The visual hierarchy uses
the established Physical/Editorial/Playful ratio: a warm canvas and raised timer
keys, an oversized human serif headline, and purple concentrated in the seconds
instrument. Copy is fixed to “A little thanks is almost here.” and “TipMe opens
at midnight in Lagos.” The exact semantic release time is
`27 October 2026 · 00:00 WAT` (`2026-10-26T23:00:00Z`).

The timer's four visual values are hidden from assistive technology; one combined
polite announcement changes no more than once a minute. Reduced motion removes
tile transitions. The 320px and 1440px renders were inspected against the image
board direction; the focused Playwright check passes axe, reflow, metadata,
no-store, route preservation and operational-exemption assertions.

## 2026-10-25 — Direction hierarchy

Approved: 60% Physical Interface, 30% Editorial Interface, 10% Playful Interface. Physical behavior is the foundation; editorial composition supplies humanity; play is reserved for meaningful acknowledgement.

## 2026-10-25 — Flagship slice

Approved: establish governance, tokens, primitives, typography specimens, and visual validation, then redesign the public recipient profile, tipping panel, and verified receipt. Payment behavior and the broader dashboard/operations redesign are out of scope.

## Open — D-09 typography

Exact fonts require rendered brand approval. Prototypes remain provisional.

## Open — reference custody

The original board is present in the design conversation but not the repository. Final parity cannot be approved until it is stored under `docs/design/reference/` with provenance.

## 2026-10-25 — Design Correction Directive 001: portrait-led profile

Approved by the product owner (Concept A is authoritative). The public profile is one composition: editorial serif headline at left, portrait as the anchor, a compact identity card overlapping the portrait's lower left, and a narrow tipping panel floating over its right edge. Mobile is a sequence — portrait, identity sheet sliding over it with the avatar straddling its edge, then the panel — not the desktop overlap compressed. Materials are differentiated by role on the profile only (stable portrait frame, subtle identity card, more pronounced floating panel); the selected amount key loses its glow but keeps its dot so selection is not shown by colour alone.

## 2026-10-25 — Black continuation action on the flagship profile

The directive overrides the constitution's purple primary action for this screen: the profile's Tip button is black, purple stays on selected amounts and brand details. Other screens keep the shared purple primary button until a separate decision.

## 2026-10-25 — Font tokens resolve from `<html>`

`next/font` variables were on `<body>` while `--font-interface`/`--font-editorial` are declared on `:root`, so both tokens were invalid and every page rendered in browser default fonts (the design-system baseline was Times). Variables now sit on `<html>`; Manrope and DM Serif Display render as `TYPOGRAPHY.md` states. Visual baselines were re-accepted for this reason. D-09 remains open.

## Resolved in part — reference custody

Column A is stored (`reference/concept-a-physical-interface.png`). The full three-column board is still absent.

## 2026-10-25 — Profile refinement round 2 (Concept A proportions)

The composition is a centred 59rem object with tracks measured from Concept A (headline 22, card overlap 4, portrait 26, panel 20; overlaps are percentages of their grid areas so it scales). Amount keys use the recessed tone; the panel title is small. On the profile only, the optional name and "remember tips" choices sit behind a closed disclosure so the panel ends within the portrait; they keep their labels, hints and behaviour, and the homepage form is unchanged.

## 2026-10-25 — Theme rollout slice 1: shell and onboarding

Approved direction (product owner): onboarding should feel human and stress-free, and the UI touchable and relatable; after sign-up, congratulate and welcome people with an onboarding event. Design: `docs/superpowers/specs/2026-10-25-theme-rollout-design.md`.

- Elevation roles are now tokens in `packages/ui/src/tokens.css` (`--edge-hairline`, `--shadow-frame`, `--shadow-card-subtle`, `--shadow-instrument`); the profile uses them.
- Continuation actions inside floating cards (tipping panel, sign-up/sign-in card, welcome) are black; the header's single primary action ("Create your page") stays purple, compact and without glow.
- The header's guest actions hide on dashboard routes through CSS (`body:has(.dashboard-page)`), because reading the pathname in the root header breaks prerendering under Cache Components.
- Welcome (`/dashboard/welcome`): greeting, three skippable steps with a live page preview, and a server-confirmed "page is live" settle. Practice tips and photo upload are deferred (backend decisions).

## 2026-10-25 — Theme rollout slice 2 (part 1): full-screen pages and public pages

- Every page's content fills at least one screen below the header (`--nav-height`); the footer follows on scroll. The canvas is now the page background everywhere.
- Public titles use the editorial serif with no purple italic accent words; eyebrow labels are sentence case, not tracked capitals.
- Home reuses the profile composition (copy, a real portrait, the working tipping instrument); people are shown as portraits with overlapping cards instead of illustrations; numbered steps remain because they are a real sequence. The black closing band became a raised card.
- The profile panel styles are shared as `.tip-instrument` (profile and home).
- Copy corrected where it had become untrue: fees are shown (illustrative) in the preview; the third step and the about page now describe pretend checkout, saved tips and accounts accurately. The about-page wording is a transparency statement and needs product-owner review.

## 2026-10-25 — Theme rollout slice 2 (part 2): header, footer, receipt

- Header sits on the canvas (no white bar); "Sign in" is a raised secondary key, "Create your page" the single purple action; on narrow screens the menu opens as a floating raised card.
- Footer is one raised card with links grouped as TipMe / Get started / About; the preview line now reads "Pretend payments only" (the old "No payments available" was untrue).
- `--shadow-raised-signature` and the primary hover no longer glow: purple material shows through an inner edge and a tight contact shadow.
- Receipt: floating card, serif headline, black continuation, and the purple settle only for a provider-confirmed `paid`. The pretend checkout stays deliberately neutral (it stands in for a third party's page).

## 2026-10-25 — Theme rollout slice 3: dashboard

- Dashboard home is two columns: the balance as an instrument card (ink numerals; Withdraw black, QR and share inside it), performance in recessed wells with neutral bars and only the latest day purple, recent tips in a raised list; beside it the recipient's own page card (live state; "Finish setting up" back to the welcome while offline), the weekly teaser and moments as quiet cards.
- Section navigation and tip filters are segmented controls (the current one raised); dashboard titles use the editorial serif, card titles quiet interface type; saving or continuing inside a card is black.
- The shared neutral notice is a raised surface with a purple edge instead of a lavender band; status tags use state tokens instead of raw colours.
- The QR card's purple is the recipient's chosen print style (a product feature) and stays.

## 2026-10-25 — Theme rollout: remaining pages

- Recovery uses the sign-in stage; email confirmation is one centred card. The profile loading state draws the profile's own silhouette (it previously referenced a removed layout class).
- QR styles are tactile keys (raised with a purple edge when chosen); the print view and QR page use serif titles. The notification bell is an authored SVG icon, its panel a floating card; toasts use the instrument shadow.
- Staff area: section titles are quiet interface type (scoped to `.ops-page`), metric tiles inherit the card materials. The black "Staff area" banner and the purple funnel bars stay: they mark a privileged context and show data.
- The shared empty state uses a smaller mark and a serif title. The development inbox uses raised message cards.
- Emails are plain text (subject and body only) with no visual template, so there is nothing to theme yet; branded HTML emails would need a decision on a messaging provider (D-11).

## 2026-10-25 — Master wordmark and short links

- The wordmark is the product owner's master SVG (`apps/web/public/brand/tipme-wordmark.svg`), rendered from one set of paths in `components/brand.tsx` by the header, footer and share image. Nunito is no longer loaded; the favicon (`app/icon.svg`) is unchanged.
- `/handle` (any case) is a 308 to the canonical `/@handle`, issued by the request proxy so scanners and crawlers see a real redirect; only the QR marker carries over. Single-word routes and public folders must be reserved handles (enforced by `apps/web/test/short-links.test.mjs`); likely future page names were reserved too. Reserving only blocks new claims: check the live database for existing holders before release.

## 2026-10-25 — Error, staging and loading screens; staff charts; favicon

- Missing pages, unavailable profiles and failures share one `QuietScreen` card (serif title, one plain sentence, black primary action). New `app/error.tsx` and `app/global-error.tsx` replace Next's bare default; the site 404 no longer claims every missing URL is a profile.
- The staging password page keeps its strict policy and behaviour but uses the canvas, a raised card, the inline wordmark and a black action (system fonts: the policy blocks font files).
- Loading placeholders are recessed wells instead of flat grey bars.
- Staff charts: text moved out of stretched SVGs into HTML (labels were distorted and overlapped at wide widths); lines use non-scaling strokes.
- Favicon: the wordmark's heart, white on a purple tile, measured and centred.

## 2026-10-26 — Merged with dev: dev's features, this branch's design

- dev had built page reports, profile photos (converted on the server), tips search, notification choices, admin search and Free/Pro pages (PR-012, PR-013). Where both branches built the same thing, dev's version is kept and wears this branch's design; this branch's duplicates were removed.
- Kept from this branch: the whole visual design, CSV export of a recipient's tips, staff-set fees and staff-granted fee-free tips (ADR-0014, migration 0038, on the admin Pages screen), and no automatic fee cuts or cash rewards from milestones.
- One fee line everywhere, as dev shows it: "TipMe fee (10%, includes processing)". The CSV has one fee column to match.
- The demo pages keep their portrait photos (`/portraits/*.webp`), described as fictional demo recipients; uploaded photos are described as "Photo of {name}".
- dev's "Report this page" quiet button sits under the preview note, aligned with it.

## 2026-10-27 — Business interest page composition

- The coming-soon page uses one centred editorial column with deliberate vertical rhythm between the eyebrow, headline, lede and primary action. The voluntary interest form sits in a raised card at the same width, with a mobile-safe stacked layout.

## 2026-10-27 — Recipient onboarding path

- The homepage now explains the recipient journey beside the Ada tipping demo: create a personal link, make the page recognizable, and share the link or QR. The primary action continues to `/sign-up`; the demo remains explicitly identified as fictional.
- New recipients with no tips see a dashboard checklist for profile details, publishing, sharing, and payment setup. Profile photos remain optional; payment setup is clearly marked unavailable until provider and funds-flow approvals are complete.
- The dashboard states that payments remain in test mode and real payment/payout setup is blocked on provider and funds-flow approvals.
- Business interest is a mailto draft to the owner's provided inbox (`usetipme@gmail.com`), not a server submission. The visitor must choose to send it; TipMe does not persist the form value.

## 2026-10-27 — Public page before tips are ready

- While the owner hasn't finished the payment account that new tips need, the profile's tipping panel shows "<Name> can't receive tips just yet." with one line of explanation, in place of the form. Same panel material and position as the form, so the composition holds; no badge and no button, because the supporter has nothing to do.
- Said before the supporter chooses an amount, never after they press Tip.

## 2026-10-27 — Owner attention

- Anything that stops an owner earning (payments not set up, unfinished or being checked, an unconfirmed email blocking payment setup, the page offline) appears above every dashboard page as the shared neutral notice, one per issue, most urgent first, each with one primary button that names the fix. It disappears as soon as the problem is gone. The welcome flow does not show it.
- The dashboard tab that leads to the fix carries a small purple dot, announced to screen readers as "(needs your attention)". Purple is the signature material, used here as a mark, not a fill.
- Tone is encouraging, not alarming: the neutral notice, not the error tone, because nothing has gone wrong yet; the owner has a step left.
- When payments need the owner's own provider account, the first-day checklist shows the real payment step instead of "Coming later".
- Withdraw says up front when the balance cannot be paid out yet, and shows no amount form.

## 2026-11-01 — Experience and motion

- `EXPERIENCE-AND-MOTION.md` sets how screens move, on the existing motion tokens, with no new runtime dependency. Drafted at the owner's request; its specifics await the owner's review.
- Money never performs: balances don't count up, and no animation implies a payment or withdrawal has progressed past its recorded state.
- The Appreciation Moment plays once per confirmed tip, and is the only celebration. A paid withdrawal is deliberately quiet, because it's the person's own money.
- No parallax or scroll-tied animation on money screens; the home page alone may use one-time section entrances.

## 2026-11-01 — Public page leads with the person and the tip

- The owner approved this on 1 Nov, with the mockup's Main, Phone and PhoneClosed boards: the cover-led page replaces the portrait-led Concept A on `/@handle` only. This supersedes the 2026-10-26 "Report this page sits under the preview note" placement. "Portrait-led identity" in the constitution now means the profile photo here; other surfaces keep their compositions.
- The page opens with the logo, then the cover. The profile photo overlaps the cover's edge, appears once, and shows initials in the same circle when there is none. Its ring is solid canvas, because it sits on any of the 24 covers.
- The site's navigation and footer links are hidden on `/@handle` only (CSS). The page's own footer is "Report this page", quiet Privacy and Terms links in every state (owner's ruling, because this page takes payment), and, except on Pro pages, "Get your own TipMe page".
- Phone Tip bar: the form's own submit button, fixed to the bottom, so there is one action and one accessible button. It hides while a typing field has focus, because the keyboard needs the room; a select opens none, so the bar stays. It carries the amount, the confirmed total and, directly above the button, the same notice as the wording under the button, so a pilot notice is always seen before paying. Scroll padding and page padding follow its height. Closing an Android keyboard ends the editing, so the bar comes back. Browsers without `:has()` keep the button in the form.
- The page no longer streams a silhouette (`instant = false`, no `loading.tsx`): the name and photo are in the first paint and work without scripts. Unknown and moved handles still answer 200, because Partial Prerendering sends the root shell first; a real 404 or 308 would need an API call in the proxy on every profile request. The cost is that a cold cache waits for the API before anything shows.
- While a tip is starting, the form's transitions are switched off: only the button's label changes.
- On phones the panel fades without rising 12px, because a transform on the panel would carry the fixed bar with it.
- Kept from the existing form rather than the mockup, because the checkout flow and its tests depend on them: the "Other" key that reveals the amount field (replaced on 2 Nov 2026, see below), and the purpose select. Awaiting the owner's view on one open question: amount keys above the bio on phones (for now the bio comes first). The other, preselecting ₦2,000, was decided on 2 Nov 2026 (see below).
- The trust line says "handles your payment" rather than "your card", because bank transfer also exists.

## 2026-11-01 — Cover colour exception

- Covers may use colours beyond `#7A32F9`, `#FFFFFF` and `#000000`: the catalogue's tones and the pattern artwork. It is a narrow exception to the locked palette, for the person's own decorative picture only. Controls, text and TipMe's own surfaces keep the locked colours and the tokens, and nothing that carries meaning sits only on a cover.

## 2026-11-02 — Cover designs and colours

- Settings has one Cover card: a live preview, "Upload your own photo", 24 designs (six hearts, eighteen patterns) and, only for designs that take them, a colour group. Colours carry visible names beside the swatch, never colour alone. Nothing is saved until "Save cover".
- Selecting a design or colour changes the preview at once, crossfading in 240ms (150ms for a colour change). Hovering or focusing does nothing. Reduced motion replaces the crossfade with an instant change. Saved shows in place for 2 seconds.
- An uploaded photo beats any design. While one exists the card says so, says which design is saved, and offers "Remove photo", rather than letting a choice appear to do nothing.
- A saved design or colour the catalogue no longer holds opens as "nothing chosen" (neutral colour), and the page shows the automatic design. "If you don't choose, we'll pick one for your page." shows until a design is saved.
- The preview of an uploaded cover is read from the account's own route, so it works while the page is not live.
- Violet and lilac are offered only as a person's own choice (see "Cover colour exception"). Covers are free; this is a builder's call from the spec, not an owner decision. The list of designs awaits the owner's review.
- Settings had content wider than a 360px screen (a file input held the Photo card 402px wide). Cards now use a shrinkable single column, and the test measures every element at 360 and 320.

## 2026-11-02 — Owner changes to the public tip page

- **₦2,000 starts selected.** The owner chose this on 2 Nov 2026. It is a product default, not a regulatory approval, and no D-item is affected. The amount keys start on ₦2,000 where the page offers it. A page whose own amounts lack ₦2,000 (a Pro page) starts on the preset closest to ₦2,000, the lower on a tie (owner's change, 2 Nov 2026, also a product decision with no regulatory approval and no D-item affected). The starting amount is not a choice: a page view requests no quote and sends no `amount_selected`. The first tap on Tip then fetches and shows the total for that amount without paying, and the next tap pays, so nobody starts a payment without having seen the total. Tapping an amount, including ₦2,000 again, counts as choosing. Closed pages ("Tipping opens soon") have no form, so nothing changes there.
- **The mode wording appears once on a phone.** With the fixed Tip bar showing, the bar carries the test-mode line or the live pilot notice (with its help link) directly above the button, and the copy under the button is removed from view and from assistive technology. Everywhere else (desktop, short screens, browsers without `:has()`) the bar copy is removed and the copy under the button stays. The live pilot notice therefore always sits beside the money action.
- **The compact tip card (owner-approved, 2 Nov 2026).** A product and visual decision, not a regulatory approval; no D-item is affected and nothing about how a payment works changed. Closed, the card is the keys, a full-width "Other amount" field, the celebration tick box (when there is a moment), one disclosure and the Tip button. Message, reason, name and "remember" all sit behind "Add a message, reason or your name", which opens in 240ms on opacity and transform only. Full amounts always (₦100,000, never ₦100k): keys per row follow the longest label and the card's width, and no key is left alone on a row. The minimum now reads in the field's label.
- **One trust line, and one partner line beside the Tip action.** The card says "No account needed. You pay exactly this amount." (wording of the later one-tap decision below). Directly under the Tip button, in the phone's bar too, on every page that takes tips and in every mode that can pay, one line says who handles the payment and where it is confirmed: live, "Our payment partner handles this. You'll confirm on its page."; test mode, "A test page stands in for our payment partner. Confirm there.", because no real partner takes a test tip. It is said once, and never names a provider. The coordinator's ruling on 2 Nov 2026, after review found supporters could reach the provider's page without being told; no legal opinion was taken. The "Test payments" badge is gone from a person's page, so test mode is said once, in the wording by the Tip button; Home keeps it.
- **The celebration moved.** The announcement sits in the identity column under the bio, above the links (before the card on a phone), only where the form can add to it. In the card, a tick box "Add to the celebration" starts unticked and sends `celebrationMomentId` exactly as the old button did.
- **Go on a phone's keyboard doesn't start a tip** while the Tip bar is stepped aside: it closes the keyboard and brings the bar and its amount back. On desktop Enter in a text field pays the amount shown, as the button does.
- **Sticky while it fits.** The panel stays in view on desktop only while it fits the window. A taller one (details open on a short window) scrolls with the page so the Tip button is always reachable; the scroll position compensates so what is on screen doesn't jump.
- **One tap pays, and the supporter sees only the amount (owner's decision, 2 Nov 2026; supersedes the "first tap shows the total" rule and the "You pay" line above).** A product decision, not an approval: D-05 is still not approved. "Tip ₦2,000" goes straight to payment. The public page and checkout show no "You pay", no total step and nothing about what the recipient receives. This is honest only because the charge equals the tip on every path: `priceTip` takes TipMe's share off the tip, proved for normal, fee-free and staff-set-share quotes in `packages/domain/test/fees.test.mjs` and `quotes.test.mjs`. If that ever changes, this decision must be reopened. The quote is fetched on the tap; the form refuses to charge if the server's tip or payer total differs from the amount shown. A ready quote and its draft key are reused on a retry, so a retry replays one tip. Choosing an amount quotes nothing, and the 500ms pause is gone. The trust line is "No account needed. You pay exactly this amount." It never says the recipient receives all of it, and never says "no fees". Recipients still see fees and what they receive.
- **Covers have more presence.** Every heart colour has a deeper tone (at least 1.45:1 against its base) and a clearer line (at least 2.5:1, under 4:1 to stay calm), and the dark design is lighter against its base. Outlines are 3px, up from 2. Geometry, assignment by handle, the pattern images and uploaded photos are unchanged.

## 2026-11-02 — Automatic covers use rich colours

- **Owner decision, 2 Nov 2026: a page with no chosen cover gets a rich colour.** It is a product and visual decision, not a regulatory approval; no VALIDATE item is touched and it needs none. Violet, forest, ocean or rose is picked by the handle, so a new page looks finished from day one. Before, the automatic covers were dark, scattered/neutral and large/neutral.
- **How it is picked.** The design is still chosen by the handle (32-bit FNV-1a, spread over three designs). The colour reads a finalised copy of the same hash, so it does not follow the design and all twelve pairings occur about equally (a test prints the spread over 2,400 handles). Nothing is stored: pages with no chosen cover change on their next view, and `cover_design`, `cover_colour` and the uploaded photo are untouched. A design or photo a person chose, and a chosen design's saved colour (or neutral), stay exactly as they were.
- **The dark design leaves the automatic set; its heart is unchanged.** Dark takes no colour, so a third of pages would have skipped the decision, and lightening its heart would restyle every page whose owner chose Dark. The third automatic design is now "Rising hearts" (a filled heart design, like the other two). Dark stays in the catalogue for anyone who picks it. Handles that had the old third design now have Rising hearts, in a colour.
- **A page that changes its handle may change look.** The pick follows the handle, as it did before, so a rename can give a different design and colour. The old handle redirects to the new page, which shows the new look. Choosing a design in Settings fixes it.
- **Legibility.** Nothing is written on a cover. The name, share button and bio sit on the page's canvas, the photo's ring is the solid canvas (at least 3:1 against all four colours), and the panel is an opaque surface. A test asserts that no text or control sits on the cover except the photo and the panel.
- **Settings shows what the page shows.** "Let TipMe pick" previews the handle's design in its colour and says it in words ("Now: Rising hearts in Violet"). Violet and lilac remain offered as a person's own choice.

## Home hero names global payments (owner's decision, 3 Nov 2026)

The redesigned home page says "Your personalized link and QR code to receive global payments (USD, EUR, GBP, NGN, Stablecoins)", as on the `ScreenHome` board. The owner chose this wording knowing TipMe takes naira only today ("use global payment. We'd work on that soon"). It is a product and copy decision, not a regulatory approval: payments in other currencies and stablecoins are not built, and nothing in `docs/00-DECISIONS.md` approves them.

## Home's example card starts on ₦5,000 (owner's decision, 3 Nov 2026)

The example card in the Home hero shows ₦5,000 chosen and a "Tip ₦5,000" button, as on the `ScreenHome` board. The owner said on 3 Nov 2026: "it should start selected at 5k". It is a picture of a tip page, not a working one. Real tip pages keep "₦2,000 starts selected" (2 Nov 2026). A product and visual decision, not a regulatory approval; no D-item is affected.

## Home's example cards come alive on desktop (owner's request, 3 Nov 2026)

After seeing Home in the live preview the owner asked for: the example card centred on a phone; the example QR matching the board (navy dot code on a white card over the Indigo Grid cover); and "an easter egg in the desktop view ... something cool that a user can find out ... the cards flip or something. They should have an animation going on there." A product and visual decision, not a regulatory approval; no D-item is affected, and nothing is paid or sent.

- **Where.** Wherever there is a mouse (a fine pointer that can hover), at any width; below 75rem only Ada's card is shown, and it still drifts, flips and sends hearts. Phones and touch screens get the still picture. (Widened 3 Nov 2026 after the owner looked in a laptop window narrower than 75rem and saw nothing move.)
- **Ambient.** The three cards drift on a slow, offset loop (a few pixels, under two degrees) and the QR card bobs. Transforms only.
- **Carousel and flip.** The three cards are a carousel. It opens with Zainab in the centre, Ada to her left and Tobi to her right (the owner, 3 Nov 2026: "It should be centered on load"); below 75rem, on phones and narrow windows, only the centre card shows, so every device leads with Zainab (the owner, 3 Nov 2026: "the devices need to lead with zainab"). Clicking a side card turns the carousel one place, so that card slides to the centre face up and the others move round. Only the centre card turns over: clicking it turns it in 3D to a postcard from that example person (see "Postcard backs" below); clicking again turns it back, and it turns back on its own if it leaves the centre. The three cards are alike: each has the three standard amounts, a Tip and the hidden thank-you, so the centre card is always the biggest and the cards change size as they move (a side card is 82% Later the same day: "the one in the center should always be the biggest ... They should all have amount buttons when in the middle ... and they should have the easter eggs too."). Keys and Tip work only on the centre card; to one side, clicking them brings that card to the centre. (The owner, 3 Nov 2026: "When a card is clicked, the carousel moves and that card becomes centered, its only the center card that can flip." This replaces the same day's "one card at a time, turned card to the front". Later the same day: "the one in the center should always be the biggest ... They should all have amount buttons when in the middle ... and they should have the easter eggs too.")
- **Step pictures on hover.** Hovering a "How it works" step makes its picture act out the step: hearts rise from the avatar over the cover, the QR lifts and a scan line passes over it, tips arrive and their hearts beat, the amounts are pressed in turn and then Tip, the big heart beats. Mouse only, with motion welcome; transforms and opacity only; the pictures stay aria-hidden. (The owner, 3 Nov 2026: "We need some activity/animations on the top of this cards when hovered, e.g the hearts could react or something.")
- **The Pro badge.** A Pro page wears a small raised purple "Pro" tag with a gold spark (`ProBadge` in `@tipme/ui`). On a real page it follows the handle under the name, shown only when the page's plan is Pro, and stays out of the name heading. A shine passes over it once soon after the page shows and again when pointed at, only where motion is welcome. Zainab's example card wears it on Home. It names the plan, never a price; how Pro is bought is still open in `docs/00-DECISIONS.md`. (The owner, 3 Nov 2026: "a premium/in style pro badge ... a component we'd display on our user's page when they subscribed to pro.")
- **Zainab's own amounts and cover.** Zainab's example page shows that an owner can set their own amounts and bring their own cover: her keys are ₦100k, ₦500k and ₦1M (short, so ₦1,000,000 fits a key), with ₦500k chosen, and her Tip and thank-you give the whole amount ("Tip ₦500,000", "Thank you for the ₦1,000,000!"). Her cover is a quiet, warm photo of late sun through blinds on a plaster wall with a palm's soft shadow, unlike any of TipMe's cover designs, so it reads as one she uploaded. It was rendered for this page, not taken from a stock library. (A neon version came first; the owner found it loud and childish and asked for an adult, premium feel.) (The owner, 3 Nov 2026.)

### 2026-11-03 — How it works is a section of Home, not its own page

The owner: "The how it works nav links should smooth scroll to this section in the homepage, we don't need a seperate page when the homepage already covers that information." The header, footer and legal-page links go to `/#how-it-works`; on Home the page glides down to the steps (instantly with reduced motion). `/how-it-works` permanently redirects there, and leaves the sitemap. A product decision; no D-item is affected.

- **The hidden moment.** "Tip ₦5,000" on Ada's card (or another key first, then Tip) sends hearts up from the card and turns it to "Thank you for the ₦5,000!" with the chosen standard amount, then it settles back after a few seconds. No request, no navigation, no payment.
- **Still decorative.** The stack stays hidden from assistive technology and holds nothing focusable. (The caption "Examples, not real people." under it, and under the Individuals page's examples, was removed on 3 Nov 2026 at the owner's request: "We need this off 'Examples, not real people.' the website.") The turned card carries no "Example" tag (removed with the caption, 3 Nov 2026). Reduced motion: no drift and no hearts, and a flip is an instant swap. Forced colours keep each face's edge.
- **Postcard backs.** A turned card's back is a postcard from that person (the owner, 3 Nov 2026: "This can't be the final design of the text in the hero cards", then, shown a mockup, "The postcard design is better, let's go."). Top to bottom: their avatar with "A note from {name}" over their role; a perforated postage stamp, top right, holding their own cover, with a small purple "TipMe" postmark and cancel lines over its lower-left corner; the note in DM Serif Display, centred in the space, under a purple opening quotation mark (a tip's "Thank you for the ₦…!" takes its place); a rule, then their name as an italic signature and `usetipme.xyz/@{handle}` as plain text. It replaces the "Example" label. The back stays the paper face; forced colours give the stamp a plain line edge.

### 2026-11-03 — An open page offers a refresh after an update

The owner: "add an update on the UI so the current user knows that there has been an update and then clicks on it, so it updates the UI." A product request, not a regulatory approval; no D-item is affected and nothing is paid or sent.

- **What it does.** Each build carries a version (the host's deployment id or commit, else the git commit, else the build time), baked into the page and returned by `GET /api/version` (`{ "version": ... }`, never cached, nothing else). An open page checks it when the tab becomes visible again and every 5 minutes while visible, never while hidden. A failed or odd answer is ignored without a sound.
- **What the person sees.** When the versions differ, a small raised card says "TipMe has been updated." with a black "Refresh" and a quiet "Later". It never reloads by itself, since someone may be typing a note or mid-tip. "Later" hides it until the version changes again.
- **Where.** Bottom left, announced politely (`role="status"`), 44px targets, no animation, an edge in forced colours. On a phone it lifts above the profile page's fixed Tip bar and sits under the phone menu. `next dev` never shows it.

## 2026-11-03 — The terms say a username can be taken back, with notice

- **Owner decision, 3 Nov 2026.** The terms gain a "Your username" section: TipMe may take a username back when it needs it (for example to protect a brand, a public figure or one of its own names), telling the person at least 7 days before, by email or on their dashboard when they sign in, saying why and asking them to choose a new one; if TipMe cannot reach them either way within 14 days, it goes ahead (owner, 3 Nov 2026, so the notice cannot be dodged by never adding an email; 14 days, shortened by the owner from 30). Their page, tips and balance stay theirs; links and QR codes with the old username stop working; if they have not chosen by then, TipMe gives the page a new username and emails it. TipMe may act sooner, or without notice, for impersonation, a trademark infringement, or where the law requires it.
- **The tool that does this is not built yet.** Staff reserving or taking back usernames from the admin area is planned after the screen redesign. Until then this is a stated policy, carried out by hand. It is not a regulatory approval, and the full terms still need a lawyer.

## 2026-11-03 — The terms state the fee

- **Owner decision, 3 Nov 2026: the 10% fee is stated in the terms.** The terms page was a placeholder with no fee disclosure. It now has a Fees section: a supporter pays exactly the tip, with nothing added; TipMe keeps 10% of each tip unless a different fee has been agreed with the recipient (a staff-set share, ADR-0014), and processing is paid from that share, so a ₦5,000 tip leaves ₦4,500; the smallest tip and the smallest withdrawal are ₦2,000, unless the whole balance is withdrawn; withdrawing is free, because a payout's provider fee is TipMe's cost (`packages/domain/src/ledger.ts`). Every figure follows `FEE_POLICY_V1` and must change with it.
- **This is disclosure, not approval.** It states the flat 10% that D-05 already decided. Refunds and chargebacks are still OPEN under D-05, so the terms say nothing about them. Entity, jurisdiction and the rest of the terms still wait on D-02 and D-07, and the page still says the full terms are being finalised. It no longer says they will come "before TipMe takes real payments", because real payments are live. The full terms need a lawyer.

## 2026-11-05 — Admin menu: a grouped sidebar and a phone Menu sheet

- **Owner's request, 5 Nov 2026** ("the admin restyle"). A visual decision, not a regulatory approval; no D-item changes, and no permission, staff action or audit changes. Boards: `docs/design/redesign/boards/OpsShell.dc.html` and `OpsPages.dc.html`.
- The OpsShell board's grouped sidebar (desktop, from 1024px) and Menu sheet (below) replace #126's one-row scrolling menu. Groups, in order: Overview and Approvals; Work (Issues, Search, Pages, Usernames); Numbers (Visibility, Market); Email and records (Providers, Email, Audit log); Staff (People, Roles, Your access). Each person still sees only the links their permissions allow.
- The site header and footer are hidden in the admin area only once access is granted, so a non-staff visitor still sees the ordinary missing page, and the sign-in and authenticator steps keep the site's header.
- The Approvals link carries a purple count of the waiting requests this person can decide now (never their own); no count when the list can't be read.
- Group labels use the secondary text colour, not the board's `#8A867E`, which is under 4.5:1 on the canvas at 12px.

## 2026-11-05 — Make it yours: a Pro accent, and the thank-you slip

- **Owner's request, 5 Nov 2026.** A product and visual decision, not a regulatory approval; see `docs/00-DECISIONS.md` ("Make it yours"). Boards: `docs/design/redesign/boards/ProCustomise.dc.html`, `ProStartAmount.dc.html` and `AppreciationDetails.dc.html`.
- **The accent exception.** On a Pro page whose cover has a colour, only the selected amount key (and its corner dot) and the pinned note's quote mark and "Pinned by" tag take that colour. The Tip button stays black, and the wordmark, focus rings, links and the Pro badge stay brand, so purple remains the signature material and paying always looks the same. A photo or colourless cover, and every Free page, keep TipMe purple. Text on the tinted key switches to black where white would fall under 4.5:1, and the key keeps an edge of at least 3:1 against the tip panel.
- **The thank-you slip.** The receipt keeps its heading ("{name} got your thanks.") and adds the recipient's line under it as a quoted slip: Paper on Free; Paper, Violet (TipMe purple, white text) or Night (`#141210`, white text) on Pro, with an optional first-name signature. The quote mark is decorative. In forced colours the slip keeps a 1px edge.

## 2026-11-03 — Live updates: the tip pop-up, a background-tab sound, public pages stay as they are

The owner's answers to the live-updates design
(`docs/superpowers/specs/2026-11-03-live-updates-design.md` §14):

1. **The pop-up names the supporter and the amount** ("You got a tip · NGN 1,800.00 from Chidi"),
   from the notification's own title and body, once, through the bell's one polite announcer (at
   most one a minute; more become a count, "3 new tips"). A Settings switch, "Hide who tipped and
   how much in pop-ups", is for shared screens and shop counters: on, the pop-up says only "You got a
   new tip", and the tips list still shows the details. Off by default, per account.
2. **A new paid tip in a background tab plays one soft sound.** Never for anything else, with no
   browser notification and no permission prompt. It plays only while the tab is hidden, only after
   the person has clicked or typed on the page once (browsers block audio before that; it then
   fails silently), and only for a tip the API reports as paid. "Sound for new tips" in Settings
   mutes it; it is on by default, per account. Reduced motion has no bearing on sound. The file is
   ours (`scripts/make-tip-sound.mjs` writes `apps/web/public/sounds/new-tip.wav`: two quiet sine
   notes, half a second). The switch is on/off only: a choice of sounds was shown on the design
   canvas but is not approved.
3. **Public pages are not live.** An open public page refreshes on its next load; checkout re-checks
   on the server and refuses safely if something changed.

EXPERIENCE-AND-MOTION §4's Sound row changes accordingly; §7.2 (no sound with reduced motion, for
the appreciation moment) is unchanged.

## 2026-11-04 — Animated covers

- **Owner decision, 2 Nov 2026, confirmed 4 Nov 2026.** A page's cover can be animated. A product and visual decision, not a regulatory approval; no D-item is affected and nothing about payments changes.
- **Free and Pro.** Free: Drifting, Rising and Ripple, which play once. Pro: all six (adding Pulse, Night sky and Sunrise), in every cover colour, with "Plays once" or "Slow loop". Automatic covers never animate.
- **Timings.** Plays once 2800ms; Slow loop 8000ms, infinite alternate; both `--ease-physical` with a 0 to 600ms stagger. These are an exception to the stagger limit in EXPERIENCE-AND-MOTION §3.
- **Freeze rules.** The cover pauses on the first use of the tip form and stays paused for that view; it also pauses off screen. Reduced motion, forced colours and print show the still frame.
- **Lock.** The server refuses Pro-only choices from Free pages. A page that leaves Pro shows the still frame and keeps its choice.
- **Performance.** Transform and opacity only; profile LCP stays under 2000ms in `pnpm perf:lab`.

## 2026-11-05 — Emails

- **Owner decision, 5 Nov 2026.** The four email boards (`EmailTip`, `EmailAccount`, `EmailSecurity`, `EmailReports` in `docs/design/redesign/boards/`) are approved for building: every email TipMe sends moves into the new paper-and-slab frame. A visual and copy decision, not a legal, regulatory or provider approval; no D-item changes and nothing about fees, payouts or the ledger changes.
- **Emails load nothing remote.** The serif is Georgia, not DM Serif Display, and the heart is a text glyph. A remote font or image would tell a third party when an email, security mail included, is opened.
- **Tip notes never appear in email** (`schema.ts`: tip messages are never copied elsewhere). The boards' quoted notes are not built; the tip email may only say that a note exists.
- **Codes in cells stay one copyable string**, so copy, paste and code autofill still get the whole code.
- **Nothing private in a subject or preview line.** No code, link, address, name, bank or device in a subject or the hidden preheader; the tip amount in the tip email's subject is the one existing exception.
- **Plan:** `docs/superpowers/plans/2026-11-05-emails-and-admin.md` (PR M1 is the frame and blocks with today's words; PR M2 is the boards' compositions).

## 2026-11-06 — The claim moment

- **Owner-approved board, 5 Nov 2026** (Sign-up celebration). A product and visual decision, not a regulatory approval; no D-item is affected and nothing about payments changes.
- **Trigger.** The moment follows the server's 2xx for `POST /v1/me/page` and nothing else. The claim leaves a one-time marker (the handle only) in this tab's session storage; the welcome reads and deletes it on mount. A reload, another tab or another device finds nothing, so the moment plays once and needs no "seen" record. Without session storage there is no moment.
- **No name.** No name is known at claim time, so the copy is "@handle is yours." and "Welcome to TipMe. People can start thanking you the moment your page is online." The card shows the handle as the name.
- **Purple hearts.** Six hearts rise once in TipMe purple: a new page has picked no colour yet. No confetti (FeedbackMoments).
- **Timeline.** 1600ms in all (`CLAIM_MOMENT_MS`): the card falls (0–350ms) and lands (350–550ms), the stamp presses (550–800ms), the hearts rise and the heading fades in (800–1200ms), then the scene rises away (1200–1600ms). An exception to the acknowledgement duration in EXPERIENCE-AND-MOTION §3, as the claim is the first-day milestone. Any tap, any key, "Continue" or Escape hands over at once; focus goes to the hello heading.
- **Vibration.** One 30ms buzz as the card lands, where the device allows it; never with reduced motion. An exception to the 10ms tick in EXPERIENCE-AND-MOTION §4, for this one moment.
- **Reduced motion.** The still scene (card on the table, stamp in place, three hearts beside it), no vibration, the same hand-over.
- **No sound** in this change. The stamp sound is a separate change, held for the owner.
