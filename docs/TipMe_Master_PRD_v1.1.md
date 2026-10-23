# TipMe — Master Product Requirements Document

**Version:** 1.1  
**Date:** 21 October 2026  
**Status:** Product baseline for engineering planning; subject to payment-provider and legal validation  
**Product:** TipMe  
**Website:** https://www.usetipme.xyz  
**Market:** Nigeria first  
**Brand:** Purple `#7A32F9`, white `#FFFFFF`, black `#000000`; selective gradients  
**Tagline:** Appreciation Pays

## 1. Executive summary

TipMe is an appreciation-first digital tipping product. A recipient creates a personal tipping identity and shares a link or QR code. A supporter opens that link, enters an amount, and pays without creating a TipMe account. The recipient sees their tips, transaction history, and eligible balance through a mobile-first dashboard.

The initial product focuses on individual recipients and guest supporters. TipMe Business—staff profiles, QR assignments, and business analytics—is an expansion built on the same underlying identity and transaction platform, not a dependency for the first launch. Future extensions may include hosted widgets, APIs, partnerships, and white-label integrations.

**North star:** Make expressing appreciation through money as easy, trusted, and delightful as sharing a link.

## 2. Decision register

### Confirmed product and design decisions

- TipMe is appreciation-first, not a generic wallet or bank replacement.
- Primary flows: recipient account creation, shareable personal tipping page, guest supporter payment, recipient dashboard.
- Web-first and mobile-first responsive experience; the interface must be premium, accessible, and fast.
- Core colors: `#7A32F9`, `#FFFFFF`, `#000000`. Motion should be intentional, performant, and respect reduced-motion preferences.
- Nigeria is the initial launch market.
- Do not activate real money movement until provider arrangements, compliance, and operational safeguards are approved.

### Proposed commercial rules — confirm before building money movement

The earlier commercial brief specifies a **10% platform fee**, **₦1,000 minimum tip**, **₦1,000 minimum withdrawal**, and processing fees covered from TipMe's fee share. These are treated as **proposed rules requiring final sign-off**, not as verified provider capabilities or regulatory approvals. A ₦5,000 gross tip would produce ₦500 platform fee and ₦4,500 recipient net before any refunds, reversals, or adjustments.

### Open decisions

- Payment service provider, checkout methods, funds custody, splits, settlement, refund and dispute responsibility.
- Recipient onboarding/KYC thresholds, payout eligibility and timelines, payout fees, risk holds and limits.
- Whether fees are recipient-paid or supporter-added; public pages must disclose the implemented model before confirmation.
- Final naming, URLs and scope of business features, paid plans, notifications, and international transactions.

No undecided item may be silently hardcoded as a product requirement.

## 3. Problem and opportunity

Cashless customers often want to reward excellent service or support an individual but do not have cash or a convenient way to pay. Bank-account sharing creates friction and privacy concerns. Existing payments experiences often feel transactional rather than personal. TipMe creates a recognisable personal appreciation identity that is easy to discover, share, and trust.

## 4. Audiences and roles

| Role                                 | Primary need                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Recipient                            | Own an attractive tipping identity; receive and track tips; withdraw eligible funds. |
| Guest supporter                      | Verify who they are tipping and pay quickly without signing up.                      |
| Business owner/manager (later phase) | Configure locations, staff, QR assignments, and reporting.                           |
| Business staff (later phase)         | Receive attributed tips with appropriate privacy.                                    |
| Administrator                        | Monitor transactions, risk, verification, disputes, balances and support.            |

## 5. Goals and non-goals

### Launch goals

1. A recipient can set up a usable identity and share it in minutes.
2. A guest supporter can complete a tip in a short, reliable mobile flow.
3. Every payment outcome is accurate, auditable, and clearly communicated.
4. The product feels distinctive without sacrificing speed, accessibility, or trust.
5. The team can measure acquisition, activation, payment conversion, and successful recipient payout.

### Out of scope for the first release

- General-purpose stored-value accounts, cards, loans, savings, and peer-to-peer transfers unrelated to tipping.
- Crypto, cross-border settlement, multi-currency payouts, and self-operated payment rails.
- Automated pooled-tip distribution and sophisticated split rules.
- Public API/SDK, white-label, advanced enterprise workflows, and native mobile apps.

These may be considered later after the core product works consistently.

## 6. Primary user journeys

### Recipient onboarding

1. Create account and complete required verification.
2. Choose an available unique handle, display name, optional photo, and bio.
3. Preview and publish a public tipping page.
4. Copy the personal link and download/share a genuine QR code.
5. View tips, payment statuses, available balance, and payout eligibility.

### Guest supporter tipping

1. Open a recipient link or scan a QR code.
2. Confirm recipient identity from the public profile.
3. Enter/select a permitted amount; optionally include a short message.
4. Review full amount, fee treatment, and total payment before continuing.
5. Complete provider-hosted or approved payment flow.
6. See a truthful pending/success/failure state; get a shareable receipt/reference where appropriate.

### Withdrawal

1. Recipient views **available**, **pending**, and **total received** balances separately.
2. Adds or selects a verified eligible payout account.
3. Reviews amount, fees (if any), and estimated processing status.
4. Requests a withdrawal; the system reserves eligible funds atomically.
5. Dashboard shows submitted, processing, paid, or failed/reversed status based on verified provider evidence.

## 7. Functional requirements

### FR-01 Authentication and recipient identity — P0

- Email or phone-based authentication with secure recovery and rate limiting.
- Username uniqueness and canonical URL routing; reserved handles and moderation rules.
- Editable display name, optional profile photo and short bio.
- Public page shows only explicitly intended public data.
- Prevent impersonation with reporting and review mechanisms.

**Acceptance:** Two users cannot claim the same handle; account changes do not expose private payout details.

### FR-02 Public tipping page — P0

- Fast-loading mobile-responsive profile with recipient identity and clear Tip action.
- Preset amounts and custom amount, respecting configured min/max limits.
- Optional message with length and abuse controls.
- Clear amount, charges, and confirmation copy before redirecting to payment.
- Helpful invalid/expired/suspended-profile states.

**Acceptance:** A first-time mobile visitor can understand the recipient, amount and action without registration.

### FR-03 Payments — P0, gated

- Adapter interface for approved processor; hosted checkout where appropriate.
- Server-generated, immutable payment intent and unique transaction reference.
- Idempotency keys for initiation and event handling.
- Server-side verification of signed webhooks and/or authoritative provider status.
- Safe handling for asynchronous, duplicated, delayed and out-of-order events.
- Accurate success/pending/failure/cancelled/refunded/disputed status.
- No wallet credit based solely on frontend callbacks or return URLs.

**Acceptance:** Replayed callbacks and concurrent requests never double-credit a tip; payment reconciliation identifies mismatches.

### FR-04 Financial ledger, balances and payouts — P0, gated

- Append-only double-entry ledger or equivalent fully balanced accounting model; immutable posting records with reversals rather than edits.
- Track gross tips, TipMe fees, processor costs, recipient liability, pending/available funds, payout reservations, payouts, reversals, and disputes.
- Reconcile provider payments and settlement/payout reports to internal records.
- Enforce payout eligibility, balance sufficiency, transaction limits, and idempotent payout requests.
- Maintain operator tools for exceptions and investigation.

**Acceptance:** Every balance can be reconstructed from entries; ledger balances and provider settlement differences are explainable.

### FR-05 Recipient dashboard — P0

- Summary of tips and status-specific balances.
- Searchable transaction history with timestamps, gross/net figures, reference, and status.
- Payout account management, withdrawal requests, and payout history where enabled.
- Profile and QR sharing controls.
- Basic notification preferences.

### FR-06 QR codes and sharing — P0

- QR encodes a genuine first-party HTTPS URL resolving to the user's canonical page.
- Provide copy-link and downloadable QR file, tested on common cameras.
- QR attribution/source token may be used for analytics, with privacy-safe tracking.
- Do not embed banking details or credentials in codes.

### FR-07 Notifications and receipts — P1

- In-product notifications and optional email delivery for verified tip and payout states.
- Receipt/reference for supporter when practical without creating an account.
- Avoid sending sensitive payout details in messages.
- Queue retries and deduplicate notifications.

### FR-08 Business experience — Phase 2

- Business entity and verified manager accounts.
- Staff invite, permissions, and deactivation.
- Unique first-party QR assignments, reusable card/tag identifiers, reassign and revoke actions.
- Business/staff/location views with appropriate access boundaries.
- Exportable reports and future support for pooled-tip workflows after legal and settlement review.

### FR-09 Admin and support — P0 limited, Phase 2 expanded

- Role-controlled search across accounts, payment intents, ledger entries, payout attempts and disputes.
- Account/report moderation; suspension with reason and audit trail.
- Reconciliation exceptions, webhook event logs, and customer support notes.
- Explicit approval controls for sensitive manual operations; no untracked balance edits.

## 8. UX, visual design and accessibility

TipMe should communicate warmth and appreciation through editorial typography, crisp layouts, confident use of purple, careful contrast and restrained interaction design. The visual system must be consistent across landing, public profile, checkout handoff, dashboard, errors and emails.

- Build responsive views deliberately at narrow mobile, tablet and desktop widths.
- Prioritise clear recipient identity and a single primary action on public profiles.
- Use accessible form labels, keyboard navigation, visible focus, live status announcements, and WCAG 2.2 AA as the target.
- Honor `prefers-reduced-motion`; no essential information conveyed by animation alone.
- Prefer meaningful motion (feedback, continuity, state transitions) over decorative effects.
- Optimise image formats, font loading, rendering, and payment-step latency.
- Avoid dark patterns, guilt messaging, hidden fees, and misleading success states.

## 9. Proposed technical baseline (not a code audit)

A reasonable initial architecture is a monorepo with `apps/web` (Next.js), `apps/api` (NestJS), `apps/worker`, shared `ui`, `contracts`, `config`, and `analytics` packages. PostgreSQL is the transactional source of truth; Redis supports queues/caching, never the authoritative wallet balance. Use REST/OpenAPI, idempotent command handling, a transactional outbox, background reconciliation jobs, object storage for media, and observability (structured logs, traces, metrics, errors).

**Important:** These are proposed implementation choices and must be checked against the existing repository before changing architecture or duplicating work.

Core entities: `users`, `profiles`, `handles`, `tip_intents`, `payments`, `provider_events`, `ledger_accounts`, `ledger_entries`, `payout_accounts`, `payouts`, `qr_destinations`, `audit_logs`, and later `businesses`, `staff_memberships`, `qr_assignments`, and `locations`.

## 10. Security, fraud and compliance

- Document data flows, access scopes, processor responsibilities and retention periods.
- Protect sessions, credentials, payment integrations, and PII; secrets only in secure server configuration.
- Verify webhook signatures and rotate signing secrets safely.
- Enforce request throttling, bot protection and abuse detection on high-risk flows.
- Support account holds, payment reversals and dispute evidence workflows.
- Obtain Nigerian legal advice on licensing, AML/KYC, applicable data protection, payout model, taxes and consumer disclosures.
- Finalise provider agreements, terms, privacy notice, acceptable-use and refund/dispute policies before money movement.

## 11. Analytics and success metrics

Instrument consent-aware events: `landing_viewed`, `profile_created`, `profile_published`, `tip_page_viewed`, `tip_started`, `checkout_opened`, `tip_paid_verified`, `tip_failed`, `payout_requested`, and `payout_paid_verified`. Deduplicate by canonical IDs; do not record full payment or sensitive personal data in event properties.

Core KPIs: activated recipients, first-tip activation rate, tipping page-to-verified-payment conversion, payment success rate, tip GMV, successful tip count, average tip value, payout completion rate, time to payout, reconciliation exceptions, fee revenue, processor costs and contribution margin.

Initial numerical targets should be established after instrumentation and a pilot rather than invented in the PRD.

## 12. Phases and milestones

| Phase                        | Deliverables                                                                                                   | Gate                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0 — Foundation               | Repository audit, requirements sign-off, design system, web shell, identity scaffolding, processor feasibility | Architecture and compliance plan reviewed                           |
| 1 — Non-payment MVP          | Onboarding, public profiles, shareable links, QR downloads, dashboard shell, analytics baseline                | Usability, accessibility, QA checks passed                          |
| 2 — Controlled payment pilot | Provider integration, ledger, payouts, reconciliation, admin controls, security testing                        | Written provider/compliance approval; end-to-end money tests passed |
| 3 — Public launch            | Performance, support, monitoring, dispute ops, marketing site, conversion optimisation                         | Go-live checklist and incident plan signed off                      |
| 4 — Business/expansion       | Businesses, staff, reusable QR tags, reporting, partner integrations                                           | Evidence of demand and validated settlement model                   |

## 13. Launch acceptance checklist

- Recipient can sign up, publish a profile, and share a working link/QR.
- Guest supporter can initiate checkout without creating an account.
- Financial amounts and fees are presented transparently and calculated consistently.
- Only verified successful payments create recipient credit, exactly once.
- Available and pending funds are distinct and payouts cannot exceed eligible balance.
- Reversals, duplicate/out-of-order webhooks, chargebacks, and payout failures are tested.
- Support/admin can investigate a transaction without editing ledger history.
- Core pages meet accessibility and performance targets on realistic mobile devices.
- Event tracking, logs, alerts, backups, reconciliation and incident procedures work.
- Legal disclosures, verified processor contract and production approvals are complete.

## 14. Risks and mitigations

| Risk                                         | Mitigation                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Fee model uneconomic on small tickets        | Model processor minimum fees, taxes and payout costs before confirming price floors.      |
| Provider delays, holds or reversals          | Distinguish pending from available funds; run reconciliation and dispute workflows.       |
| Fraudulent public identities/QR substitution | Canonical profile identity, reporting, first-party redirect mapping, admin revocation.    |
| Hidden payment status or duplicate credits   | Verified webhooks, idempotency, append-only ledger, automated reconciliation.             |
| Design weight harms conversion               | Performance budgets, real-device testing, reduced-motion support, funnel instrumentation. |
| Premature business complexity                | Keep business modules behind clear phase boundaries and shared core contracts.            |

## 15. Immediate engineering handoff

Before implementing financial transactions, publish and review: (1) repository state audit, (2) system architecture/ADRs, (3) endpoint contracts and error taxonomy, (4) payment and payout state machines, (5) balanced ledger and reconciliation specification, (6) processor fee and settlement model, (7) access-control matrix, (8) security and compliance checklist, and (9) automated integration/contract test plan.

**Document principle:** Confirmed decisions are requirements. Proposed architecture and commercial assumptions require validation. Future features are directional, not launch blockers.
