# TipMe theme rollout and welcome — design

**Date:** 25 October 2026
**Builds on:** Design Correction Directive 001 (public profile, approved by the product owner), `docs/design/DESIGN-CONSTITUTION.md`, PRD §6 (journeys) and §8 (UX).

## Intent

The product owner's words: once someone lands on TipMe it should feel **human**; a new recipient should be onboarded **as easily as possible, with no stress**; and the whole UI should feel **touchable, feelable and relatable**. When sign-up finishes, TipMe should **congratulate them, welcome them on board, give them an onboarding event, and make them feel at home**.

The approved profile (`/@handle`) is the visual reference: warm canvas, portrait-led editorial composition, differentiated physical materials, purple only for selection and brand moments, black continuation actions.

## Goals

- One visual system across every recipient- and supporter-facing screen (PRD §8).
- A welcome after sign-up that greets the person by name and turns setup into a few small, skippable steps with their real page taking shape beside them.
- Sign-up and sign-in that read as a calm, human conversation, with an honest sense of progress.

## Non-goals

- Backend, payment, ledger, auth or API changes. Everything here uses existing endpoints.
- Photo upload (no endpoint exists; needs storage, moderation and an ADR). People without a photo get the framed monogram.
- Practice tips to yourself (would enter the ledger as earnings without backend support). Deferred; needs a product decision.
- Redesigning staff (`/ops/*`) or internal screens; they inherit shared materials only.

## Anti-goals (failure even if it works)

- Guilt or pressure ("finish your profile or lose out"), fake urgency, confetti, or success styling around money that is not confirmed.
- Hiding disclosures or that payments are pretend during the preview.
- A setup that cannot be skipped or that loses what someone already typed.

## Slices (in order; each its own reviewable change)

1. **Shell and onboarding** — navbar, footer, sign-up, sign-in, and the new welcome at `/dashboard/welcome`.
2. **Public pages** — home, how it works, for creators, about the preview, legal, not found; tip status/receipt and the pretend checkout.
3. **Recipient home** — dashboard, tips, tip detail, withdraw, QR (and print), reports, settings; a gentle "finish setting up" card while the page is not live.
4. **Shared materials pass** — ops and internal screens inherit tokens/primitives; no redesign.

## Slice 1 decisions

- **Navbar (shared):** quiet, warm-canvas header with a hairline edge; small links; one compact primary action. Same accessible names and Escape behaviour as today.
- **Footer:** same canvas family, quieter type; links unchanged.
- **Sign-up / sign-in:** editorial serif headline at left, the form as one compact floating card (the profile's instrument material), a three-step progress line for sign-up (number → code → handle). Handle copy is corrected: the domain is not `tipme.app`, and handles **can** be renamed later (PR-011).
- **Welcome (`/dashboard/welcome`), the onboarding event:**
  1. Welcome: "Welcome to TipMe" with their handle, what happens next, `Let's set up` or `I'll do this later`.
  2. Your name and what you do → `PATCH /v1/me/profile { displayName, role }`.
  3. A line about you → `PATCH /v1/me/profile { bio }`.
  4. Go live → `PUT /v1/me/page/state { state: 'live' }`, with the page preview.
  5. Done: "Your page is live", their link (copy), QR, "See your page as supporters do", "Go to my dashboard".
  - Every step has `Skip`/`Back`; values persist per step; a live preview card mirrors what they type (monogram when no photo).
  - Claiming a handle goes to the welcome instead of settings.
- **Calls made by the builder (not the product owner):** the combination of welcome directions A+B, deferring C (practice tip), the step order, and the `/dashboard/welcome` route.

## Validation

Playwright for the welcome (every step, skip, keyboard, axe, 320px reflow), updated sign-up helpers, visual baselines for the welcome, sign-up and shell, plus screenshots at 1440 and 390 reviewed against the profile reference.
