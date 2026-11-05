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

> **Staging data (31 Oct 2026, owner):** "Staging should not be that serious with data/db management." Staging's WAL archiving and base backups are **off**: the nightly logical dump (kept 14) is its backup, so a restore loses at most a day. Production's database is on Aiven, which provides its backups and point-in-time recovery; the PRD's 15-minute target applies there. Moving staging to a managed database is a TODO.

## VALIDATE BEFORE REAL MONEY
| ID | Decision | Required evidence | Owner | Status |
|---|---|---|---|---|
| D-01 | Initial launch jurisdiction, currency and eligible recipients | Business approval | Product | OPEN |
| D-02 | Company registration, legal agreements and regulator interpretation | Legal opinion | Founder | OPEN (does not block launch, owner's decision, 1 Nov 2026) |
| D-03 | Payment processor permits tipping, split and settlement flow | Written provider confirmation | Payments | OPEN (does not block launch, owner's decision, 1 Nov 2026) |
| D-04 | Custody/non-custody and settlement account ownership | Signed funds-flow diagram | Finance/Legal | OPEN (does not block launch, owner's decision, 1 Nov 2026) |
| D-05 | Fee policy incl. processing, refunds, chargebacks, net recipient | Approved pricing | Product/Finance | PARTLY DECIDED: flat 10% TipMe fee, provider paid from it, recipient gets 90% (ADR-0014); refunds and chargebacks OPEN |
| D-06 | Recipient verification, payout holds and support model | Provider policy and risk plan | Risk | OPEN (does not block launch, owner's decision, 1 Nov 2026) |
| D-07 | Fraud, sanctions/AML and regional privacy obligations | Compliance assessment | Legal/Risk | OPEN (does not block launch, owner's decision, 1 Nov 2026) |
| D-08 | Hosting, monitoring budget and supported response coverage | Cost model + staffing | Engineering | OPEN |
| D-09 | Exact logo/typography assets | Brand review | Design | OPEN |
| D-10 | First launch segment and validated behavior | User interviews and pilots | Product | OPEN |
| D-11 | Messaging providers (SMS, WhatsApp, email, push) and their cost | Provider contracts, sender registration and cost model | Product/Engineering | PARTLY DECIDED: launch email OTP via Resend; phone OTP deferred |

> **Provider selections (26 Oct 2026):** Bachs is selected for the initial payment adapter, sandbox only; this is not written provider approval for live voluntary tips, connected accounts, settlement or payouts (D-03 remains OPEN). The product owner selected email OTP via Resend for launch and deferred phone OTP until after launch. D-11 remains open pending the Resend account, verified sender domain, provider terms, Nigerian deliverability/cost evidence, privacy/retention review and operational readiness. See ADR-0004.

> **D-04 note (18 Oct 2026):** the user's intended model is custodial: the full tip is collected into a TipMe-controlled provider account, TipMe deducts its cut and forwards the rest to the recipient. This is **PROPOSED, pending legal opinion**; the PRD prefers provider collection and settlement. The PR-005 ledger is custody-neutral (ADR-0006), so either outcome needs sign-off, not a rebuild. No real money moves until D-04 is approved.
>
> **1 Nov 2026:** the owner's decision of this date (see "Launching without these" below) supersedes that sentence for launch, unless the owner's ADR says otherwise. D-04 stays open and is not approved.

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
> - **Handle renames (superseded by the handle rule below):** old handles keep leading to the page and nobody else can claim them; on deletion they are held 90 days like the current handle. The earlier limit of 5 old handles has gone, because the change count now bounds them.
> - **Web vitals:** anonymous page-speed samples (metric, value, page kind, device class) follow the analytics rules: off in production until D-07, GPC/DNT honoured, kept 90 days.

> **PR-012 notes (22 Oct 2026), all PROPOSED (pretend money):**
> - **v1.1 commercial rules applied for testing:**
>   - TipMe keeps a 10% fee and pays processing out of it, so a ₦5,000 tip gives the recipient ₦4,500.
>   - The minimum tip is ₦2,000 (the owner's decision, 2 Nov 2026; it was ₦1,000) and there is **no maximum**: supporters tip what they want (the user's decision; the API only bounds the input to 12 digits of kobo, and a real provider's own limits will apply). The minimum withdrawal is ₦2,000 (same decision).
>   - These are the PRD v1.1 *proposed* rules. They are not approved pricing (D-05) and do not enable real money.
> - **Free and Pro (the user's decision):**
>   - Every page starts on **Free**: standard amounts of ₦2,000, ₦5,000 and ₦10,000, plus any custom amount from ₦2,000.
>   - **Pro** lets the recipient choose 1–4 preset amounts and their own minimum, never below ₦2,000. Amounts saved under the old floor are no longer offered. The fee and withdrawal minimum are the same as Free.
>   - Pro is granted by staff with a written reason and is audited; there is no billing until payments are approved.
>   - Pro pricing, and whether Pro changes the fee, are open.
>   - **Leftover balances:** a withdrawal under ₦2,000 is allowed only when it takes the whole available balance, so nobody is left with money they cannot withdraw or an account they cannot close (the user's decision).
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
>   - `profile_published` is recorded once per page, ever: the page itself remembers when it first went live.
> - **Review follow-ups:**
>   - **Page reports** are kept 180 days.
>   - **Photo uploads:**
>     - Limited to 20 an hour.
>     - At most two are processed at a time per API process, each given at most 5 seconds and 25 megapixels.
>     - The browser shrinks a photo to 1,024 px before sending it.
>     - A photo URL is never reused, and photos are cached for an hour at most.
>   - **Reference matching:**
>     - Recipients match a reference only within the 6 characters they are shown.
>     - Staff match a whole reference or that 6-character ending, so neither can rebuild a full provider reference.
>     - Admin search is indexed and stops after 3 seconds.

> **Launching without these: the owner's decision, 1 Nov 2026.** In the owner's words: "Most of this questions are unnecessary to be exact. Bachs sort most of the compliance, they hold money. Let's skip them. Give a checklist and we'd circle to it later. They shouldn't block launch." So the owner chooses to launch without a legal opinion or written Bachs confirmation, and states that Bachs handles compliance and holds the funds. That statement is the owner's and has not been checked against any agreement or legal advice. D-02, D-03, D-04, D-06 and D-07 stay OPEN: nothing here is approved or resolved, and the code-level rules stay. The follow-ups are listed in `docs/runbooks/live-activation.md`. The dated acceptance is the first line of the template below. `AGENTS.md`'s hard stop ("No real payments until processor and funds flow are approved in ADR") is unchanged.

> **Live pilot acceptance (TEMPLATE, NOT ACCEPTED).** The code fence on live payments is gone (1 Nov 2026), and production keeps `PAYMENTS_LIVE_ENABLED=false`. Removing the fence decides nothing. Live payments stay unapproved until the owner completes the block below and works through `docs/runbooks/live-activation.md`. Only the owner fills this in; no agent writes an answer here.
>
> - Launching without D-02, D-03, D-04, D-06, D-07 and legal or provider approval of holds: accepted by / date:
> - Accepted by / date:
> - Scope (closed pilot, or public; Q7):
> - ADR recording the approved processor and funds flow (AGENTS.md hard stop), its number:
> - D-01 jurisdiction and currency:
> - D-05 refunds, chargebacks, reward cash:
> - May the owner alone settle money issues (Q5):
> - D-08 hosting, monitoring budget and response coverage:
> - D-10 first launch segment:
> - D-11 messaging providers and sender registration:
> - Do D-01, D-08, D-10 and D-11 block the pilot? (yes / no, and why):
> - Stolen inbox (email sign-in plus a bank code to the same inbox adds a bank at once): accepted / changed:
> - Stolen session and the 72-hour bank wait: accepted / changed:
> - Slow recovery (24 hours, then the 72-hour bank wait): accepted / changed:
> - Limits of the takeover freeze (nothing with the provider is recalled; staff check the bank by hand): accepted / changed:
> - What the withdrawals switch doesn't stop (payouts already with the provider): accepted / changed:
> - Public hint that the reserve is low (`/health/payments`): accepted / changed:
> - ₦50 fee paid from the reserve on every withdrawal, however small: accepted / changed:
> - One admin until second-person approval ships: accepted / changed:
> - Pilot notice wording: approved / changed to:
> - Provider writes on production's accounts while payments are off (manual payouts, capabilities): accepted / changed:
> - Reserve funded to, and who tops it up (Q6):

> **Takeover freeze: confirmed by the owner, 1 Nov 2026 ("keep the freeze").** "Admin and money" above says payout holds stay out of admin until there are two staff. This freeze was built first, ahead of the owner's decision, and the owner confirmed it afterwards. Staff with `payouts.resolve` can freeze a page's withdrawals for a reported account takeover, with a written reason, audited. It moves no money and recalls nothing with the provider. While it stands the bank can't change and held payouts can't resume; release needs written confirmation that the bank and sign-in were checked. All other holds stay out of admin. **This is not legal or provider approval:** D-06 stays open, and the requirement in `docs/05-SECURITY.md` that payout holds have legal or provider approval stays open, as a follow-up in the runbook.

> **Withdrawals switch: the owner's decision, 1 Nov 2026 ("we should be able to switch of withdrawals toooo").** Staff with `payouts.resolve` can stop all withdrawals from the Overview with a written reason, audited and alerted, on every copy at once, with no deploy. It is independent of `PAYMENTS_LIVE_ENABLED`. While off, requests are refused and queued payouts wait, reserved; payouts already with the provider can't be recalled and keep settling. The same D-06 limit applies: this doesn't approve holds.

## DEFERRED
Native apps, multi-currency routing, stored-value wallets, internal custody, crypto, memberships, NFC and team tipping. Propose separately with evidence.

> **Product-owner decisions (25 Oct 2026, ADR-0014):** TipMe takes a flat 10% of every tip and pays the payment provider out of it. Nobody receives a reduced fee automatically: staff grant fee-free tips and may set a custom fee per account, with a reason and an audit record. Milestones are celebrations only. This supersedes the PR-008 automatic reward notes above.

> **Covers, Pro and the handle rule (1 Nov 2026), all PROPOSED builder's calls from the design spec (`docs/superpowers/specs/2026-11-01-profile-covers-qr-design.md`) unless said otherwise. The owner has not approved the items marked open:**
> - **Handle rule:** a Free page cannot change its handle once claimed. A Pro page has 3 changes in total, counted on the server, including a switch back to an old handle; a change of letter case alone is not a change. After the last, the form is replaced by a message to contact the team. Staff with `pages.plan` can allow more, with a written reason, audited: up to 10 at a time and 20 extra in total per page. Before saving, a confirmation shows the new handle, that old links and printed QR codes keep working, and how many changes remain. The count starts at zero when this ships; leaving Pro keeps the handle and refuses further changes, and returning to Pro does not reset the count. Old handles keep leading to the page and stay unclaimable while it exists; on deletion they are held 90 days.
> - **What Pro includes now:** Pro QR designs and print formats, three handle changes, the page's own tip amounts, animated covers that loop, every cover colour on them, and no "Get your own TipMe page" footer link (animated covers are the owner's product decision of 2 Nov 2026, not a regulatory approval). Free keeps the three standard QR looks, the handle it claimed, the standard tip amounts and the footer link, plus three animated covers that play once.
> - **Covers are free** on every plan: an uploaded photo (JPEG, PNG or WebP up to 5 MB, re-encoded), or one of the designs, with a colour for the heart designs that take one. Precedence is the uploaded photo, then the chosen design, then a design picked from the handle. Builder's call.
> - **QR designs are Pro; Free gets a marked preview.** Builder's call. A Pro code printed earlier keeps working after Pro ends.
> - **Privacy line, and the 500-cover R2 threshold** (turn R2 on before many covers are uploaded, because Postgres dumps grow): builder's calls. The Privacy page wording is not changed and stays for the owner's approval.
> - **Still open (owner):** the final list of designs; whether staff may remove an uploaded image, and the wording of the email the owner receives; the Pro price, billing and how someone buys Pro (until then staff switch Pro on, and no screen names a price); the Privacy page wording; approval of the payment wording.
