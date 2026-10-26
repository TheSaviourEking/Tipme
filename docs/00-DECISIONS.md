# Decisions and unknowns

## LOCKED (confirmed)
- Appreciation-first TipMe identity, not general money movement.
- Public recipient profile, sharable link/QR and fast voluntary guest tipping.
- Core palette: purple `#7A32F9`, white `#FFFFFF`, black `#000000`; selective derived gradients.
- Premium and original UI with high-performance, accessible, SEO-ready execution.
- Recipient experience must include tip visibility and trustworthy payment/payout information.

## PROPOSED (technical; review before first major code)
- **One repository** with `apps/web`, `apps/api`, `apps/worker`, `packages/ui`, `packages/contracts`, `packages/config`.
- pnpm workspaces + Turborepo; Next.js App Router; NestJS; Postgres; Redis; TypeScript strict.
- SQL ORM: Prisma (exact release and migration semantics to verify) or Drizzle, choose once in ADR-0002.
- Auth provider or self-hosted sessions, to select based on security and cost.
- Playwright, Vitest/Jest as appropriate, ESLint, Prettier, GitHub Actions.
- OpenTelemetry + error monitoring and privacy-conscious product analytics.

## VALIDATE BEFORE REAL MONEY
| ID | Decision | Required evidence | Owner | Status |
|---|---|---|---|---|
| D-01 | Initial launch jurisdiction, currency and eligible recipients | Business approval | Product | OPEN |
| D-02 | Company registration, legal agreements and regulator interpretation | Legal opinion | Founder | OPEN |
| D-03 | Payment processor permits tipping, split and settlement flow | Written provider confirmation | Payments | OPEN |
| D-04 | Custody/non-custody and settlement account ownership | Signed funds-flow diagram | Finance/Legal | OPEN |
| D-05 | Fee policy incl. processing, refunds, chargebacks, net recipient | Approved pricing | Product/Finance | PARTLY DECIDED: flat 10% TipMe fee, provider paid from it, recipient gets 90% (ADR-0014); refunds and chargebacks OPEN |
| D-06 | Recipient verification, payout holds and support model | Provider policy and risk plan | Risk | OPEN |
| D-07 | Fraud, sanctions/AML and regional privacy obligations | Compliance assessment | Legal/Risk | OPEN |
| D-08 | Hosting, monitoring budget and supported response coverage | Cost model + staffing | Engineering | OPEN |
| D-09 | Exact logo/typography assets | Brand review | Design | OPEN |
| D-10 | First launch segment and validated behavior | User interviews and pilots | Product | OPEN |
| D-11 | Messaging providers (SMS, WhatsApp, email, push) and their cost | Provider contracts, sender registration and cost model | Product/Engineering | OPEN |

> **D-04 note (18 Oct 2026):** the user's intended model is custodial: the full tip is collected into a TipMe-controlled provider account, TipMe deducts its cut and forwards the rest to the recipient. This is **PROPOSED, pending legal opinion**; the PRD prefers provider collection and settlement. The PR-005 ledger is custody-neutral (ADR-0006), so either outcome needs sign-off, not a rebuild. No real money moves until D-04 is approved.

> **PR-008 notes (19 Oct 2026), all PROPOSED:**
> - **Paid plans** (future idea from the user): premium QR styles, custom backgrounds, deeper insights. Premium styles are marked "free in preview"; nothing is billed. Charging to keep personal details private is **not** planned: phone and email stay private by default and free (privacy by default; D-07).
> - **Cash rewards:** TipMe-funded bonuses of 50% of the platform fees a recipient earned since the last bonus, capped at 50% of lifetime fees (cash plus waived fees) and by a monthly budget. Pretend money only; real rewards need D-05, a legal review of financial promotions, and the two-person rule for manual adjustments.
> - **Email recovery:** a verified email can schedule a move to a new phone number (confirmed by a code to that number), effective 24 hours later; the old number and email are warned and the owner can cancel. It is never a second way to sign in (ADR-0003).

> **PR-009 notes (19 Oct 2026), all PROPOSED:**
> - **Analytics consent and retention (pending D-07):** anonymous, cookieless first-party events; nothing written to a supporter's device; Global Privacy Control and Do Not Track honoured; no IP, user agent or account stored; raw events kept 90 days, daily totals kept. Collection is **off in production** (`ANALYTICS_ENABLED`) until D-07 is decided.
> - **Market visibility:** outside observations are entered by hand on the admin Market page. Automatic feeds (social listening, competitor tracking, Google Search Console, app stores) are **deferred**: they need a provider, a budget and a public domain.
> - **Admin and money:** staff can resolve, note, re-check with the provider, pause pages and cancel recoveries. Refunds, manual ledger adjustments and payout holds stay out of admin until there are two staff for the two-person rule and a real provider (D-03 to D-06).
> - **Staff accounts:** only the Owner role is seeded, and staff are granted only by `pnpm ops:grant-owner`. Staff accounts are never recovered by email, and a number change removes admin access until the grant is run again.

> **PR-011 notes (21 Oct 2026), all PROPOSED:**
> - **Numbering fix:** earlier documents called messaging providers "D-08". D-08 is the hosting and monitoring budget; messaging providers are **D-11**.
> - **Error tracking:** TipMe's own reporter sends server errors in Sentry's envelope format (Sentry or self-hosted GlitchTip), without messages, bodies, cookies, headers or user data. Off without `SENTRY_DSN`; which service and plan waits for D-08.
> - **Search engines:** `robots.txt` and `sitemap.xml` exist, but indexing stays off (`SITE_INDEXING`) on every copy until launch; public profiles stay noindex until D-06.
> - **Handle renames:** old handles keep leading to the page (at most 5) and nobody else can claim them; on deletion they are held 90 days like the current handle.
> - **Web vitals:** anonymous page-speed samples (metric, value, page kind, device class) follow the analytics rules: off in production until D-07, GPC/DNT honoured, kept 90 days.

## DEFERRED
Native apps, multi-currency routing, stored-value wallets, internal custody, crypto, memberships, NFC and team tipping. Propose separately with evidence.

> **Product-owner decisions (25 Oct 2026, ADR-0014):** TipMe takes a flat 10% of every tip and pays the payment provider out of it. Nobody receives a reduced fee automatically: staff grant fee-free tips and may set a custom fee per account, with a reason and an audit record. Milestones are celebrations only. This supersedes the PR-008 automatic reward notes above.
