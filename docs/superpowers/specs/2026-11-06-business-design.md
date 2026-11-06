# TipMe for businesses — design (owner-approved direction, 6 November 2026)

Sources: the owner's messages of 5–6 Nov 2026; the canvas board `Business.dc.html` (canvas version 106); the holes-and-improvements review the owner accepted on 6 Nov ("add all of them to the implementation plan... we need to ship the business fast"). PRD v1.1 FR-08 (Phase 2) is the product background. Nothing here is legal advice or implies regulatory approval.

## Intent

Bring visibility to businesses whose staff are tipped (restaurants, bars, salons, hotels). A customer scans the business's location code, finds the person who served them, and tips them through the usual TipMe flow. The business sees who is thanked most and what customers say. Tipping must stay fast: extras are optional and never block the tip.

## Goals (release 1, "Business MVP")

1. **Business accounts.** A business is a new account kind with a name, a verified badge, one or more locations, and managers. Roles: business owner (all locations), location manager (one location). A TipMe staff member verifies a business before its codes go live (new ops permission, audited, serious action).
2. **Staff join by invitation only.** A manager invites a person by email or phone; the person accepts with their own TipMe account (existing or new). Businesses can never create staff accounts. A staff member appears on the location page as soon as they accept; their tips build up in their own balance; they add a bank only when they want to withdraw (today's rules). A person can belong to several businesses.
3. **Codes.** One code per location (printed once; never reprinted when staff change), opening `/b/<business>/<location>`. Optional staff code per person at a business, opening that person's tip page at that business. The page always shows the verified badge, business name and location clearly (QR-sticker fraud).
4. **The supporter's flow.** Scan → location page (people on shift first, with first name and photo as each person chooses; search; "I don't see them" searches everyone at the business) → the person's tip form (today's form and payment) → after payment, an optional note about the person with one-tap positive tags (Friendly, Fast, Went the extra mile, …) and optional text → skip at any point. The phone remembers the last person tipped at this business (browser only).
5. **On shift.** Staff check themselves in and out at a location, or a manager does. Location page shows people on shift first, everyone else below.
6. **What the business sees.** Per location and week: tip counts and tag counts per staff member, the notes customers wrote (after moderation), busiest tipping hours, most-mentioned tags. **No naira amounts per person by default**; a staff member can choose to share their amounts with the business. Groups smaller than 3 are hidden in aggregates. The business never sees a supporter's name or contact details.
7. **Notes are kind by design.** Positive tags only, no star ratings. Free text goes through moderation (existing hide/report). Staff see their own notes and can report one. A reported note is hidden from the business until reviewed.
8. **Staff leaving.** Removed from the location instantly by either side. Their balance and notes stay theirs; the business keeps counts only.
9. **Business pricing.** Free during the pilot. A per-location monthly plan comes later on the Pro billing rails (blocked, like Pro billing).
10. **Admin.** Staff can verify, suspend and look up businesses, with the same masking rules as the staff-roles board.

## Release 2 (to build: the owner confirmed on 6 Nov 2026 that our payment partner and the legal check said yes)

11. **Share agreement.** The business proposes a split (staff keeps / business takes: 100/0, 90/10, 80/20, 70/30, 50/50, the owner's options). Safeguards: a cap at 50% (the owner's largest option; staff always keep at least half); the business never sees who declined; at most one change per month with 14 days' notice; applies only to tips after both agree; staff can report the business to TipMe; tips through the staff member's own page outside the business are never shared. The supporter is told on the tip page ("Tobi keeps 90% of your tip; 10% goes to The Yellow Chilli"). Ledger: the share is a separate line so refunds and chargebacks reverse both parts.
12. **Tip the whole team.** A pooled tip per location for people who never face customers (kitchen, cleaning, security), and the fallback when the person isn't listed. Split rule: equal among people on shift at that time (proposed). Same legal question as 11.
13. **Table cards that name the server** for a shift, skipping the list.

## Non-goals and anti-goals

- No business-created staff accounts; no tips held by the business in release 1.
- No star ratings or negative tags; no supporter identity to businesses.
- Nothing that slows the tip: notes come after payment.
- Users never see the payment provider's name ("our payment partner").

## Constraints

- Reuse today's tip form, payment, ledger, payouts, notes moderation, QR rendering, serious actions and approvals. Live updates may signal the business dashboard.
- Money safety: release 1 changes no money movement; every tip still credits the person tipped, exactly as today.
- Privacy: aggregates with k ≥ 3; data visible to the business is documented in the privacy page outline and decisions log.

## Open for the owner (defaults ship unless changed)

- Who is listed: people on shift first, then everyone (default) vs on-shift only.
- Business verification evidence (default: TipMe staff check name, address and a contact; no document upload in release 1).
- Tag list (default: Friendly, Fast, Went the extra mile, Great advice, Made my day).
- Business plan price (later, with billing).

## Owner's answers (6 November 2026)

- **Share basis:** the business's share is taken from what the staff member receives after TipMe's 10% fee (the plan's default). Tip page: "Of what Tobi receives, they keep 90% and 10% goes to The Yellow Chilli."
- **Who can create a business:** anyone signed in, from the "Businesses" entry already in the navbar; TipMe staff verify it before its codes go live. When `BUSINESS_ENABLED` is on, `/for-businesses` invites people to create a business instead of the coming-soon interest form.
- **Inviting staff, three ways:** by email; by a one-time link the manager shares; and **in the app, by searching a TipMe username** — the person gets an in-app notification (and, if they have a confirmed email, an email) and accepts or declines from their Work page.
- **Notes:** the business sees a note at once; it is hidden as soon as it is reported (default kept).
- **Refunds and team tips:** the defaults stand — staff confirm each reversal as a serious action, a reversal after withdrawal may take the balance below zero (withdrawals stop and a money issue opens), partial refunds reverse each part in proportion; team tips carry no business share and split equally among people on shift when the tip is made.
