# ADR-0009 — Recipient profiles, dashboard, notifications, moments and rewards

Date: 2026-10-19
Status: ACCEPTED for development (PR-008). Pretend money and pretend delivery only. Real cash rewards wait for D-05 (fee and promotion policy) and legal review. Real payouts wait for D-03 and D-04.
Owners: Engineering

## Context

Recipients sign up (ADR-0003), claim a handle and control their page. They want to see, in the user's words:

- their performance and the trend;
- their balance;
- recent tips and withdrawals;
- the actions they can take.

They should be able to share a styled QR code, hear about tips in the app and by email, get a weekly report, and be appreciated with surprise moments, sometimes with money ("humans appreciate things coming to their wallets").

## Decision

### Pages

- **One page per account:** `profiles.user_id` is unique.
- **Handles:** 3–30 characters (letters, digits, underscore), unique without regard to case. A reserved list protects TipMe's own routes. A deleted handle is held for 90 days.
- **Page state:** `live` or `not_live` (new pages start not live), or `deleted`.
  - Not live, deleted, suspended and unknown pages all show the same "This page isn't available right now" screen (404, `noindex`).
  - Tips are refused once a page is not live, even on an already-open page (409 `TIP_NOT_PAYABLE`).
- **Optional details:** bio and socials (https links on Facebook, Instagram or X only) are public by default. Phone and email are **private by default and free to keep private**. Each detail has its own switch.
- **Public `/@handle`:** loaded from the API on the web server and cached with `use cache` plus a per-handle tag. Every change, including a phone change or a newly confirmed email, expires the tag at once (`revalidateTag(tag, { expire: 0 })`) through `/api/revalidate`, which is protected by a shared secret and retried once. A 30-second cache life is the backstop if that signal is ever lost.
- **Deleting the page deletes the account:**
  - Personal details are erased and every session ends.
  - The money records stay, linked by ids only.
  - Deleting is refused while the balance is above zero or a tip is still confirming.

### Dashboard

- **Balance:** `recipient_payable` from the ledger, minus payouts still in flight. Money still confirming is shown separately.
- **Performance:** today vs yesterday and this week vs last week, plus a 7-day trend in Lagos time. These compare the recipient only with their own past.
- **Tips:**
  - Only paid tips, or tips the provider is really confirming, are shown. A checkout opened but never paid is not a tip; a supporter's name and words appear only once paid.
  - The tips list is paged.
  - A tip's detail shows the private message, gross, fees, net, and the provider's confirmation with only the last 6 characters of its reference.
- **Withdrawals:** any amount up to the balance (ADR-0006 addendum). With the mock provider the pretend bank pays at once and payout reconciliation records it.

### QR codes

- Six presets: three free, and three marked "Premium · free in preview" (no billing).
- The code is always dark modules on a light square with a quiet zone and solid finder squares. The style lives in the frame and module shape. The modules-to-square contrast must be at least 4.5:1, and every preset is decoded in tests.
- Print card (A6), full screen (with wake lock where available), and a square share image drawn in the browser.

### Notifications and reports

- **Tip notifications:** a verified `tip.succeeded` event creates one notification per tip (in-app bell and toast; the dashboard polls every 10 s while visible). A verified email also gets a pretend email. No SMS.
- **Weekly report:** Monday 07:00, Lagos time, for recipients tipped that week.
  - It shows the total, the change, tips, notes, the best day and moments.
  - "Most frequent supporter" uses only the name a supporter chose to give, and is private to the recipient.
  - The share image is drawn from a shareable view that structurally cannot contain a supporter's name.

### Moments and rewards

- **Moments** have unique keys, so each is created once, even when tips arrive at the same moment. They are:
  - milestones at 1, 10, 50 and 100 tips;
  - "best week" and "best month", judged after the period closes, needing history and at least 5 tips;
  - the week's first lovely note.
- **Rewards** (configured in `packages/domain/src/rewards.ts`):
  - **Fee-free tips** waive TipMe's own fee while credits last. The provider fee always applies. A credit is used only when a tip succeeds, and never goes below zero.
  - **Cash bonuses** are 50% of the platform fees since the previous cash bonus, booked as a `reward` ledger operation (debit `promotions_expense`, credit `recipient_payable`).
  - Cash comes out of a **monthly budget** (`REWARD_CASH_BUDGET_MINOR_PER_MONTH`, default ₦250,000, locked per month). With no budget left, the reward becomes fee-free tips.
  - **Lifetime cap:** cash bonuses plus waived fees never exceed 50% of the platform fees the recipient has earned TipMe. This is checked before every fee-free quote and every bonus, and proven by a randomised property test.
- **Review fixes (19 Oct):**
  - **Reservation:** an open fee-free quote reserves its credit and its waived fee, under a lock on the credits row, so quotes made before any is paid can never overspend the credits or the cap.
  - **Headroom:** a cash bonus keeps room under the cap for the fee-free tips granted with it, and fee-free grants are trimmed to what the cap can honour, so the copy never promises fee-free tips that cannot be used.
- **Sharing:** moments are private until the recipient shares one. A shared moment shows on the public page for 14 days as "Celebrating Kemi's 10th tip". The words come from the kind of moment, never from its reward.
  - Supporters can "Add to the celebration". The tip is labelled only if the moment really is that recipient's shared moment.

## Rationale

- Rewards sized from fees earned make every reward self-funding and keep self-tipping pointless: it costs the provider fee and returns at most half of TipMe's fee.
- Unique keys and row locks reuse the PR-005 approach to "never twice".
- Privacy defaults follow privacy-by-default expectations (NDPA/GDPR) while D-07 is open.

## Financial, security, privacy and accessibility impacts

- **Financial:** rewards are pretend money, balanced, append-only and capped.
- **Security:** every recipient route checks ownership on the server, with tests across two accounts.
- **Privacy:** supporter names never appear in public or shared output. Phone and email are private by default.
- **Accessibility:** pages are checked with axe and at 320 px. The chart has a text-table alternative, and the status and toast regions are announced.

## Consequences

- Real email, push, SMS and WhatsApp need providers (D-08).
- Real cash rewards need D-05, legal review, and the two-person rule for manual adjustments.
- Recipient identity verification (D-06) is still open, so pages stay `noindex` and labelled pretend.

## Validation evidence

`docs/PR-008-VERIFICATION.md`.
