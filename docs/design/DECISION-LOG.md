# Design decision log

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
