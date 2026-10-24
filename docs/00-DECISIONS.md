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
| D-05 | Fee policy incl. processing, refunds, chargebacks, net recipient | Approved pricing | Product/Finance | OPEN |
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

> **PR-012 notes (22 Oct 2026), all PROPOSED (pretend money):**
> - **v1.1 commercial rules applied for testing:**
>   - TipMe keeps a 10% fee and pays processing out of it, so a ₦5,000 tip gives the recipient ₦4,500.
>   - The minimum tip is ₦1,000 and there is **no maximum**: supporters tip what they want (the user's decision; the API only bounds the input to 12 digits of kobo, and a real provider's own limits will apply). The minimum withdrawal is ₦1,000.
>   - These are the PRD v1.1 *proposed* rules. They are not approved pricing (D-05) and do not enable real money.
> - **Free and Pro (the user's decision):**
>   - Every page starts on **Free**: standard amounts of ₦1,000, ₦2,000 and ₦5,000, plus any custom amount from ₦1,000.
>   - **Pro** lets the recipient choose 1–4 preset amounts and their own minimum, never below ₦1,000. The fee and withdrawal minimum are the same as Free.
>   - Pro is granted by staff with a written reason and is audited; there is no billing until payments are approved.
>   - Pro pricing, and whether Pro changes the fee, are open.
>   - **Leftover balances:** a withdrawal under ₦1,000 is allowed only when it takes the whole available balance, so nobody is left with money they cannot withdraw or an account they cannot close (the user's decision).
> - **What the new fee changes in rewards and reports:**
>   - A fee-free tip now gives the recipient the whole tip, and costs TipMe its whole 10% (processing included).
>   - The lifetime cap (half of what TipMe kept) is checked against that full cost. So the 10th-tip reward is 4 fee-free ₦2,000 tips, not 5.
>   - Cash bonuses ("half the fees since the last bonus") are based on what TipMe keeps after processing (8.5% of each tip, up from 5%). They are larger, but the monthly budget still caps them.
>   - The admin Overview tile is now "TipMe keeps (after processing)". Weeks spanning the switch mix the old and new rules.

> **PR-013 notes (24 Oct 2026), all PROPOSED:**
> - **Reporting a page (impersonation, scam, abuse):** a reason from a fixed list only. No IP, user agent or free text is kept, and the answer is the same whether or not the page exists. One open issue per page; after a review, the next report opens a new one.
> - **Profile photos:**
>   - Every upload is re-encoded on the server to a 512×512 WebP with no metadata (no location or camera details). JPEG, PNG and WebP only, up to 5 MB and 40 megapixels.
>   - Stored in Postgres, so photos are backed up and recovered with everything else; object storage can come later.
>   - Served only for live pages, and erased with the account.
> - **Notification preferences:** tip emails, weekly-report notices and milestone notices can be turned off. In-app tip notices, sign-in codes and security warnings cannot.
> - **Admin search:** needs the permission `search.view`. It returns ids and short labels, never phone numbers, emails, supporter names or messages. Each search is audited by its length, not its text.
> - **Analytics (PRD v1.1 §11):**
>   - Added: `landing_viewed`, `checkout_opened`, `profile_created`, `profile_published`, `payout_requested`, `payout_paid_verified`.
>   - The other v1.1 names map to the existing events: `tip_page_viewed` = `profile_viewed`, `tip_started` = `payment_started`, `tip_paid_verified` = `tip_completed`, `tip_failed` = `payment_failed`.

## DEFERRED
Native apps, multi-currency routing, stored-value wallets, internal custody, crypto, memberships, NFC and team tipping. Propose separately with evidence.
