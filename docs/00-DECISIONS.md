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
| D-05 | Fee policy incl. processing, refunds, chargebacks, net recipient | Approved pricing | Product/Finance | PARTLY DECIDED: plan-based TipMe fee from the next production release (owner, 12 Nov 2026): Free 7%, Pro 5%, processing paid from it (before: flat 10%, ADR-0014; see the 12 Nov block); refunds and chargebacks OPEN; Pro refunds: see the Pro billing block (9 Nov 2026) |
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

> **D-05 note (6 Nov 2026):** Reversal of business shares: see Q7/Q8 defaults in "Business release 2 (owner's report, 6 Nov 2026)" below. D-05 keeps its status: refunds and chargebacks stay OPEN.

> **PR-008 notes (19 Oct 2026), all PROPOSED:**
> - **Paid plans** (future idea from the user): premium QR styles, custom backgrounds, deeper insights. Premium styles are marked "free in preview"; nothing is billed. Charging to keep personal details private is **not** planned: phone and email stay private by default and free (privacy by default; D-07).
> - **Cash rewards:** TipMe-funded bonuses of 50% of the platform fees a recipient earned since the last bonus, capped at 50% of lifetime fees (cash plus waived fees) and by a monthly budget. Pretend money only; real rewards need D-05, a legal review of financial promotions, and the two-person rule for manual adjustments.
> - **Email recovery:** a verified email can schedule a move to a new phone number (confirmed by a code to that number), effective 24 hours later; the old number and email are warned and the owner can cancel. It is never a second way to sign in (ADR-0003).

> **PR-009 notes (19 Oct 2026), all PROPOSED:**
> - **Analytics consent and retention (pending D-07):** anonymous, cookieless first-party events; nothing written to a supporter's device; Global Privacy Control and Do Not Track honoured; no IP, user agent or account stored; raw events kept 90 days, daily totals kept. Collection is on in production by default (owner, 9 Nov 2026; see below).
> - **Market visibility:** outside observations are entered by hand on the admin Market page. Automatic feeds (social listening, competitor tracking, Google Search Console, app stores) are **deferred**: they need a provider, a budget and a public domain.
> - **Admin and money:** staff can resolve, note, re-check with the provider, pause pages and cancel recoveries. Refunds, manual ledger adjustments and payout holds stay out of admin until there are two staff for the two-person rule and a real provider (D-03 to D-06).
> - **Staff accounts:** only the Owner role is seeded, and staff are granted only by `pnpm ops:grant-owner`. Staff accounts are never recovered by email, and a number change removes admin access until the grant is run again.

> **Visitor analytics in production: the owner's decision, 9 Nov 2026.** Anonymous visitor analytics is on by default in production, within the PR-009 rules above (anonymous, cookieless, nothing written to the device, GPC and DNT honoured, no IP, user agent or account stored, raw events kept 90 days, daily totals kept). `ANALYTICS_ENABLED=false` turns it off. This is the owner's product decision; it is not a legal or data-protection approval. **D-07 stays OPEN** as a compliance item. It also turns on web-vitals samples and, once built, tip-source attribution (Pro additions plan PR 5).

> **PR-011 notes (21 Oct 2026), all PROPOSED:**
> - **Numbering fix:** earlier documents called messaging providers "D-08". D-08 is the hosting and monitoring budget; messaging providers are **D-11**.
> - **Error tracking:** TipMe's own reporter sends server errors in Sentry's envelope format (Sentry or self-hosted GlitchTip), without messages, bodies, cookies, headers or user data. Off without `SENTRY_DSN`; which service and plan waits for D-08.
> - **Search engines:** `robots.txt` and `sitemap.xml` exist, but indexing stays off (`SITE_INDEXING`) on every copy until launch; public profiles stay noindex until D-06.
> - **Handle renames (superseded by the handle rule below):** old handles keep leading to the page and nobody else can claim them; on deletion they are held 90 days like the current handle. The earlier limit of 5 old handles has gone, because the change count now bounds them.
> - **Web vitals:** anonymous page-speed samples (metric, value, page kind, device class) follow the analytics rules: on in production by default since 9 Nov 2026 (see below), GPC/DNT honoured, kept 90 days.

> **PR-012 notes (22 Oct 2026), all PROPOSED (pretend money):**
> - **v1.1 commercial rules applied for testing:**
>   - TipMe keeps a 10% fee and pays processing out of it, so a ₦5,000 tip gives the recipient ₦4,500.
>   - The minimum tip is ₦2,000 (the owner's decision, 2 Nov 2026; it was ₦1,000) and there is **no maximum**: supporters tip what they want (the user's decision; the API only bounds the input to 12 digits of kobo, and a real provider's own limits will apply). The minimum withdrawal is ₦2,000 (same decision).
>   - These are the PRD v1.1 *proposed* rules. They are not approved pricing (D-05) and do not enable real money.
> - **Free and Pro (the user's decision):**
>   - Every page starts on **Free**: standard amounts of ₦2,000, ₦5,000 and ₦10,000, plus any custom amount from ₦2,000.
>   - **Pro** lets the recipient choose 1–4 preset amounts and their own minimum, never below ₦2,000. Amounts saved under the old floor are no longer offered. The fee and withdrawal minimum are the same as Free.
>   - Pro is granted by staff with a written reason and is audited. Paying for Pro: see "Paying for Pro" (9 Nov 2026) below.
>   - Pro does not change the tip fee (superseded 12 Nov 2026: Pro keeps 5%, Free 7%). The Pro price: see "Paying for Pro" (9 Nov 2026) below.
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

> **Social links: the owner's product decision, 5 Nov 2026.** The owner approved the SocialLinks board (design artifact 8D6hJZsqMkLSGh8KUUBmmh, version 97) as designed. This is a product decision. It is not legal advice, and it is not a regulatory or payment-partner approval.
> - **Free:** up to 3 links, from TikTok, Facebook, Instagram, YouTube, X, Snapchat, WhatsApp channel, Twitch, Kick, Audiomack, Boomplay, Spotify, Apple Music and SoundCloud.
> - **Pro:** also own website, Telegram, LinkedIn, Threads, Patreon, Selar and Substack. Up to 8 links, a featured link, and the page's own order.
> - **Adult platforms:** OnlyFans and Fansly links are allowed **for Pro only**. This is the owner's product decision, not legal or regulatory approval.
> - **Never allowed:** Linktree and other link-list pages, and URL shorteners, as any site or as a website.
> - **When Pro lapses:** the extra links are hidden, not deleted. The page shows the first 3 Free-site links in the saved order, without the featured styling.
>   - **Removing them (review ruling, 5 Nov 2026):** the Free editor lists the hidden links, each with Remove. A Free page may delete them, but may never add them or make them show.
>   - **Removing a shown link:** a hidden Free-site link may then move up to fill the slot. The editor says so before the save.
>   - **Pro sites on Free:** they never show on a Free page, including OnlyFans and Fansly.
> - **Adult-platform switch:** `ADULT_PLATFORM_LINKS` (`on` by default, an API setting). When `off`, OnlyFans and Fansly links are hidden from public pages and can't be added, and nothing is deleted. This is the lever for when the payment partner answers (`docs/runbooks/adult-platform-links.md`).
> - **Still open:**
>   - our payment partner's written position on pages that link to adult platforms;
>   - the acceptable-use section of the Terms, which is still only a heading (`apps/web/src/app/legal/terms/page.tsx`).
> - **Builder's calls (PROPOSED):**
>   - **Accepted addresses:** each site's own https addresses, as listed in `packages/contracts/src/social-links.ts`, with the sources in the build report.
>   - **WhatsApp:** channel links only.
>   - **Telegram:** public usernames only, not invite links.
>   - **Order on Free:** the catalogue order.
>   - **Featured key:** fixed wording for each site, with no free text.
>   - **Letter badges** in place of brand logos.
>   - **A Free save on a lapsed Pro page:** it keeps the hidden links. The page then stores at most 11.
> - **Shipped without press counts per link:**
>   - **Why:** they wait on the owner's D-07 decision on anonymous collection in production, which is already in front of the owner on the ProAdditions board. Analytics is staff-only today, and a count per link shown to recipients would be a new use of visitor data.
>   - **Follow-up:** add the counts once D-07 is decided.
> - **Order on Free:** existing pages showed X first (the database's own key order, which no one chose). They now show Facebook, Instagram, X, the order the old editor listed them in. Say so in the release notes.
> - **Release compatibility (one release):** links saves also write the old `socials` column from what shows, so a rollback stays truthful. The profile form takes and ignores the old links, so tabs opened before the release still save. Both are marked TODO, to remove with the column.

> **Pro additions: the owner's decision, 5 Nov 2026.** The owner approved five Pro additions from the ProAdditions board (canvas v101): repeat supporters, priority support, where your tips come from, the monthly recap, and early access (plan `docs/superpowers/plans/2026-11-05-pro-additions.md`). Excluded: the board's section 6, profile sections (owner to confirm), and tip goals and campaigns (TODO, pending our payment partner's view). This is a product decision. It is not legal advice, and it is not a regulatory, data-protection or payment-partner approval. **D-07 stays OPEN.** No fee, minimum, checkout amount, ledger posting or payout changes. Each PR of the plan appends its own builder's calls here. (This entry was opened by PR 3, which merges first; PR 1 adds the board and its own parts.)
>
> - **Repeat supporters, PR 3 (the supporter's choice), option (a):**
>   - The tip form offers "Let {name} recognise me next time" only on a Pro page, only once a name is typed, off by default. Emptying the name unticks it.
>   - The browser makes a random 32-byte key per recipient (`tipme.supporters.v1`); the server stores only its SHA-256 in `supporters`, linking tips in `tip_supporters`. The money tables gain no column. Never a card, IP, device or browser fingerprint.
>   - Any receipt of a recognised tip has "Stop {name} recognising me", which deletes the supporter and their tip links; the tips stay. "Forget my tips and keys on this phone" clears only the browser's copy.
>   - `SUPPORTER_RECOGNITION` (`on` by default, an API setting) turns it off without deleting anything (`docs/runbooks/supporter-recognition.md`). **Whether it should wait for the D-07 privacy review, i.e. whether production runs it `on`, is the owner's call (open question 3).** The default ships `on` because the owner approved option (a), opt-in and off by default.
>   - **Privacy lines, for the privacy notice's author** (not legal advice; check the Nigeria Data Protection Act 2023, especially its lawful-basis and consent provisions, before relying on them):
>     - **What is stored:** a random key, in the supporter's browser and, as a one-way hash, with their tips to that recipient. Never contact details.
>     - **Why:** so that recipient can recognise them, only with their consent.
>     - **How long:** until they stop it from a receipt, or the recipient deletes their account.
>     - **How to stop:** "Stop {name} recognising me" on any receipt. "Forget my tips and keys on this phone" clears the browser's copy.
>     - **Known limit:** a new phone, a new browser, cleared storage or the recipient renaming their handle makes a new supporter; old ones stay as they were.
>   - **Builder's calls (PROPOSED):**
>     - **The key is made when the tip is sent, not when the box is ticked,** so a supporter who ticks and leaves stores nothing. A browser that can't keep the key sends none, and the tip goes ahead unrecognised.
>     - **The receipt says "recognised" only once the tip is paid,** like the note-consent flag. Unpaid tips are never counted anyway.
>     - **Stopping works while the switch is off:** it is always the supporter's to do.
>     - **The receipt line names the recipient by first name,** as the tip form does.
>     - **The newest name wins** when one key is used with different names; concurrent tips keep the name of the latest tip.
>     - **Logs and Sentry:** `supporterKey` is redacted by the shared logger (`packages/observability`, used by the API and the worker), not an API-only list, and is removed at any depth from Sentry events by the web's scrub.
>     - **The stop route has no rate limit:** it needs the receipt's own status token and does nothing without it.
>     - **The "Your choices" group** on the receipt holds only this line until make-it-yours PR D adds its note-consent withdrawal beside it.

## DEFERRED
Native apps, multi-currency routing, stored-value wallets, internal custody, crypto, memberships, NFC and team tipping. Propose separately with evidence.

> **Product-owner decisions (25 Oct 2026, ADR-0014):** TipMe takes a flat 10% of every tip and pays the payment provider out of it. Nobody receives a reduced fee automatically: staff grant fee-free tips and may set a custom fee per account, with a reason and an audit record. Milestones are celebrations only. This supersedes the PR-008 automatic reward notes above.

> **Covers, Pro and the handle rule (1 Nov 2026), all PROPOSED builder's calls from the design spec (`docs/superpowers/specs/2026-11-01-profile-covers-qr-design.md`) unless said otherwise. The owner has not approved the items marked open:**
> - **Handle rule:** a Free page cannot change its handle once claimed. A Pro page has 3 changes in total, counted on the server, including a switch back to an old handle; a change of letter case alone is not a change. After the last, the form is replaced by a message to contact the team. Staff with `pages.plan` can allow more, with a written reason, audited: up to 10 at a time and 20 extra in total per page. Before saving, a confirmation shows the new handle, that old links and printed QR codes keep working, and how many changes remain. The count starts at zero when this ships; leaving Pro keeps the handle and refuses further changes, and returning to Pro does not reset the count. Old handles keep leading to the page and stay unclaimable while it exists; on deletion they are held 90 days.
> - **What Pro includes now:** Pro QR designs and print formats, three handle changes, the page's own tip amounts, animated covers that loop, every cover colour on them, and no "Get your own TipMe page" footer link (animated covers are the owner's product decision of 2 Nov 2026, not a regulatory approval). Free keeps the three standard QR looks, the handle it claimed, the standard tip amounts and the footer link, plus three animated covers that play once.
> - **Covers are free** on every plan: an uploaded photo (JPEG, PNG or WebP up to 5 MB, re-encoded), or one of the designs, with a colour for the heart designs that take one. Free also gets three animated covers that play once; the other animated covers, a colour on an animation and the slow loop are Pro, enforced on the server (owner's product decision, 2 Nov 2026). Precedence is the uploaded photo, then the animation, then the chosen design, then a design picked from the handle. Builder's call.
> - **QR designs are Pro; Free gets a marked preview.** Builder's call. A Pro code printed earlier keeps working after Pro ends.
> - **Privacy line, and the 500-cover R2 threshold** (turn R2 on before many covers are uploaded, because Postgres dumps grow): builder's calls. The Privacy page wording is not changed and stays for the owner's approval.
> - **Still open (owner):** the final list of designs; whether staff may remove an uploaded image, and the wording of the email the owner receives; the Privacy page wording; approval of the payment wording.

> **Paying for Pro: the owner's decisions, 4, 5 and 9 Nov 2026.** Billing is built before any new Pro feature. Pro is monthly; the launch price is ₦2,500 a month, set by staff with `pro.price` in the admin area (₦100 to ₦1,000,000, whole naira, with a reason; a second person approves, a lone admin acts alone with an alert), and a change applies to new months only. One month can be paid ahead. After an unpaid month there are 3 days' grace, then the page is Free; reminders go 7 days and 1 day before. When Pro lapses its extras hide and nothing is deleted. Recipients pay by card or bank transfer through our payment partner's checkout, or from their TipMe balance; there is no staff-confirmed transfer. Automatic renewal waits until the partner supports it for naira cards. An annual plan is not decided. Staff can still grant Pro with a reason. This is the owner's product decision. It is not a legal, regulatory or provider approval: D-03, D-04, D-06 and D-07 stay OPEN, D-05 stays PARTLY DECIDED, real payments still need the live pilot acceptance, and `subscription_revenue` and `platform_clearing` need finance sign-off (ADR-0006, ADR-0015).
> - **Builder's calls (pending the owner's answer, plan `2026-11-09-pro-billing-and-package.md`):** a month paid during grace starts at the old end date, so grace is not free time; a staff grant keeps Pro on whatever the paid months say; Pro refunds wait the owner's refund rule; a bank transfer that arrives after its checkout expired is still credited, from the confirmation, and any other amount or currency goes to staff review with nothing booked.
> - **Billing core:** the price in the admin area, the monthly periods with grace, expiry and reminders, and buying a month by card or bank transfer on pretend money and the partner's sandbox, behind `PRO_BILLING_ENABLED` (off by default).
> - **Buy screens and the Pro package (owner approved the ProPage, ProBadge, ProEarnings and ProCampaigns boards, 11 Nov 2026; Pro merge train):** the /pro page and Settings → Plan show the price the server sends (₦2,500 a month at launch, never written into the web app) and, with `PRO_BILLING_ENABLED` on, let a recipient buy a month by card or bank transfer; with it off they say "Pro is coming soon to buy". The Pro badge is a paid-plan mark ("TipMe Pro is a paid plan. It doesn't mean TipMe checked who runs this page."), never a verification. Earnings analytics, Campaigns (Free 1, Pro 20 running links), the monthly recap and priority support ("Pro requests are answered first", no promised time) are built.
> - **Behind their own flags, off by default:** paying from the TipMe balance (`PRO_PAY_FROM_BALANCE`; the partner's policy answer is still open), staff refunds of card months (`PRO_REFUNDS`: on the member's request, within 14 days, a second approver, TipMe absorbs the fee, bank-transfer months can't be refunded through the partner) and automatic renewal on a saved card (`PRO_AUTO_RENEW`, waits a sandbox proof). Turning auto-renew off always works. These are default rulings of 11 Nov 2026, listed in the Pro merge train PR, until the owner changes them.

> **The handle rule, amended for username take-backs (4 Nov 2026), from the owner's answers of 3 Nov 2026.** A product rule, not a legal, regulatory or provider approval: it approves nothing in D-02 to D-07. "Old handles keep leading to the page and stay unclaimable while it exists, unless TipMe takes one back (`docs/superpowers/specs/2026-11-03-username-reservation-design.md`)." A take-back is a serious action (`username.take_back`, permission `usernames.manage`, a second person when one exists) with a written staff reason that the user never sees. The user reads only the category's fixed words. Notice is 7 to 30 days (ordinary) or 1 to 7 (impersonation, trademark, required by law); the clock starts at the earlier of the notice email being sent and the dashboard banner being seen, and with neither the take-back goes ahead after 14 days (owner answers 1 to 3). A take-back breaks the old links and printed QR codes for that name only; the page, its tips and its balance are unchanged, and the name is then reserved. A page given a new username (`page_` and six letters or digits) gets one free change within 30 days (owner answer 4). The terms' "Your username" section must be on `main` before this deploys to production.

> **Make it yours (owner's request, 5 Nov 2026: "work on what can be customized").** A product and visual decision, not a legal, regulatory or provider approval. No D-item changes, and nothing about fees, the minimum, checkout, money or the ledger changes. Plan: `docs/superpowers/plans/2026-11-05-make-it-yours.md`; boards in `docs/design/redesign/boards/` (`ProCustomise`, `ProStartAmount`, `AppreciationDetails`).
> - **A thank-you line on the supporter's receipt.** Free: the line, up to 140 characters, no links. Pro: also one of three card styles (Paper, Violet, Night) and a signature (the first word of the display name, read at view time). The receipt shows the line as it is now, not frozen per tip.
> - **Accent colour (Pro).** Follows the cover colour; a photo or colourless cover uses TipMe purple, and nothing new is stored. Only the selected amount key and the pinned note's marks are tinted; the Tip button stays black.
> - **One pinned note (Pro).** Only a paid note whose writer ticked "{name} may show this note on their page" on the tip form, and never a hidden or reported one. Consent is off by default and lives on the note. A supporter may stop their note being shown from their receipt. Notes written before the tick box shipped can never be pinned, so the tick box ships first.
> - **The amount a page starts on (Pro),** chosen from the page's own amounts.
> - **Leaving Pro hides, never deletes:** every saved choice is kept and shows again on return to Pro; a Free page shows the Free version.
> - **Answers to the plan's questions (5 Nov 2026, final):** Q1, the accent follows the cover colour, and photo and automatic covers use TipMe purple. Q2, a supporter may stop their note being shown, from their receipt. Q3, the consent says "on their page": TipMe never infers pronouns. Q4, the tick box ships first; earlier notes can never be pinned. Q5, the receipt shows the current thank-you line.

> **TipMe for businesses (owner's direction, 6 Nov 2026).** A product decision, not a legal, regulatory or provider approval: no D-item changes. Spec `docs/superpowers/specs/2026-11-06-business-design.md`, plan `docs/superpowers/plans/2026-11-06-business.md`, board `docs/design/redesign/boards/Business.dc.html`. Everything is behind `BUSINESS_ENABLED`, off by default.
> - **Release 1 scope:** verified business accounts with locations and managers (owner, location manager); staff join by invitation only, with their own TipMe accounts; one printed code per location and an optional staff code; the supporter picks the person who served them and tips with today's form; an optional kind note with one-tap positive tags after paying; on shift; weekly counts, tags, notes and busy hours for the business with groups smaller than 3 hidden; TipMe staff verify, suspend and look up businesses.
> - **Release 1 moves no money; every tip credits the person tipped.** A tip made at a business carries a label (member and location) that the server chose and checked; a bad or stale label is ignored, never refused, and no posting reads it. Release 2 (share agreement, team tips, table cards) is recorded separately when it is built.
> - **Owner's answers (6 Nov 2026), binding:**
>   - Q1, a staff member's own page must be live to be listed (today's rules).
>   - Q2, invitations go by email, by a one-time link the manager sends themselves (7 days, once), **or to a TipMe username** found by search in the manager's screen (an in-app notification, plus an email when the person has a confirmed email). Search shows only a username's public card and refuses suspended or deleted pages. The invited person can block further invitations from that business.
>   - Q3, anyone signed in can create a business; TipMe staff verify it before its codes go live.
>   - 6 Nov 2026 (owner): someone who owns or manages a business can never verify it, even as the only admin. Asking is refused; another staff member must.
>   - Q4, a note shows to the business at once; text with links, emails or phone numbers is refused; a reported note is hidden until TipMe staff review it.
>   - Q5, no naira in the business view except the weekly amounts of people who chose to share theirs.
>   - Q9, a share (release 2) is of what the person receives after TipMe's fee.
> - **Spec items shipped with their defaults:** O1 people on shift first, then everyone; O2 staff check name, address and a contact, no document upload; O3 tags Friendly, Fast, Went the extra mile, Great advice, Made my day; O4 the business plan price comes later, with billing (nothing built, no price shown).

> **What a business sees (release 1 close-out, plan B9 Task 24, 6 Nov 2026).** A product and privacy decision, not a legal, regulatory or provider approval: no D-item changes. It records what the code on `dev` shows a business, and it is written into the privacy page (`/legal/privacy`, "If you tip at a business" and "If you work at a business") before `BUSINESS_ENABLED` is turned on.
> - **A business sees:** per location and week, how many tips each current team member received, the tags and notes supporters left about them (a note shows with its date only, never the time), and the busiest hours. Every count below 3 shows as "Fewer than 3". It sees who is on shift, and the name and photo each person chose to show.
> - **A business never sees:** a supporter's name, contact details, message (`tip_messages`), status token, exact time of a tip or payment reference. No naira, except the weekly amount of a person who chose to share theirs, in a week with at least 3 tips (Q5).
> - **When a person leaves:** their row, name and notes disappear from the business's view; the location's totals keep their tips (M6). A reported note is hidden from the business until TipMe staff review it (Q4).
> - **The person's own copy:** the tips file (`/v1/me/exports/tips.csv`) names the business and location a tip was made at and carries the note written about them (a note TipMe removed reads "Removed by TipMe"); the work file (`/v1/me/exports/work.csv`) lists every membership, left ones included.

> **Business release 2 (owner's report, 6 Nov 2026).** The owner reported that our payment partner and a legal check said yes to a business sharing staff tips and to team tips. The options are 100/0, 90/10, 80/20, 70/30 and 50/50, with a cap of 50%. This records the owner's report. It is not a regulatory approval, a licence, or written provider confirmation held in this repository. D-03, D-04 and D-05 keep their status (OPEN, OPEN, PARTLY DECIDED), and `AGENTS.md`'s hard stop on real payments is unchanged. Spec `docs/superpowers/specs/2026-11-06-business-design.md` ("Release 2"), plan `docs/superpowers/plans/2026-11-06-business.md` (PRs R2-0 to R2-E). Each part sits behind its own flag on top of `BUSINESS_ENABLED`, off by default: `BUSINESS_SHARES_ENABLED` and `TEAM_TIPS_ENABLED`. The owner turns them on only after the share and team-tip PRs are on dev and the terms and privacy text below is live.
> - **Safeguards (spec item 11):**
>   - The split is "staff keeps / business takes", one of the five options; the business never takes more than 50%, so staff always keep at least half. The database refuses any other value.
>   - A share applies only after the staff member accepts, and only to tips made after the agreed start date. It is fixed on the tip when the supporter starts paying and never changes afterwards.
>   - Tips through the staff member's own page, outside the business, are never shared. The database refuses a share on a tip not made at that membership.
>   - At most one change takes effect per person per calendar month (Lagos), with at least 14 days' notice.
>   - The business never learns who declined: a declined proposal reads "No change", like one never answered.
>   - Staff can report the business to TipMe; the report is never shown to the business.
>   - The supporter is told about any share on the tip page before paying.
>   - The share is its own ledger line (`business_payable`), so a refund or chargeback reverses the person's part and the business's part together.
>   - Leaving a business ends its agreement at once; rejoining starts at 100/0.
> - **Owner's answers and defaults:**
>   - Q7, staff confirm each reversal of a refunded or charged-back tip as a serious action (`tip.reverse`, `payments.repair`) after checking our payment partner's dashboard; it is never automatic. A partial refund reverses each line in proportion, with the remaining kobo on the person's line. (Default kept, 6 Nov 2026.)
>   - Q8, a reversal after the money was withdrawn posts anyway: the balance may go below zero, withdrawals for that person or business stop until it is back above zero, and a money issue opens. Nothing is collected automatically. (Default kept.)
>   - Q9, the share is of what the person receives after TipMe's 10% fee (ADR-0014), so TipMe's fee and the supporter's total are unchanged. The tip page says: "Of what Tobi receives, they keep 90% and 10% goes to The Yellow Chilli." (Owner's answer.)
>   - Q10, team tips carry no business share. A team tip is split equally among the people on shift at that location when the tip is made; the earliest check-in takes any remaining kobo. (Default kept.)
>
> **How a share's money moves: option B (owner, 11 Nov 2026).** The owner chose option B of `.superpowers/program/business-funds-flow-brief.md` after the sandbox tests of 11 Nov 2026 (S1 to S5 passed in sandbox; partner questions (a) to (e) are still open). This records the owner's product choice. It is not a regulatory approval, a licence, or written provider confirmation; D-04 and D-05 keep their status, and live use still waits on the partner confirming that this is the flow they agreed to.
> - **The tip is unchanged:** a direct charge on the staff member's own partner account, with TipMe's 10% as the platform fee. The staff member stays the seller.
> - **The share moves after collection,** once the tip's money is available on the staff member's account: staff → TipMe → business, two transfers (the partner refuses a transfer between two accounts). Each leg has its own idempotency key and is recorded before it is sent; a lost answer is read back, never re-sent blindly; the second leg starts only after the first is confirmed. TipMe's balance holds the share only between the two legs. The ledger is unchanged by the moves.
> - **The business has its own receive-only account** with our payment partner (payouts and transfers; no card payments), set up by an owner from the Money section.
> - **A refunded shared tip:** the partner takes the whole refund from the staff member and keeps TipMe's fee, so TipMe sends its fee back to the staff member (TipMe absorbs the partner's processing fee). The business gives its share back (business → TipMe → staff) while it still holds it; if it already withdrew it, the amount is held back from the business's next shares and paid to the staff member, and the business's owners are told in the app.
> - **Rulings in the build (changeable):** a business withdraws at least ₦5,000, with no "everything" exception (the partner's ₦50 fee on each payout, covered by TipMe, stays at most 1%); a share is first tried 48 hours after its tip is paid (`BUSINESS_SHARE_SETTLE_HOURS`, partner question (e)), then only when the staff account's available balance holds it; TipMe does not front a held-back share to the staff member; a share is pulled back whole or not at all. The worker's `BUSINESS_SHARES_ENABLED` must be on with the API's.
>
> **TipMe's fee on a refunded tip (owner, 12 Nov 2026).** "We're returning TipMe's fee on every refunded tip." On every refunded tip (a person's page or a business, with or without a share), once our payment partner says the refund is final (`refund.paid`), TipMe transfers the fee it kept (its platform fee, with the provider fee it took from the tip) back to the person's own account, TipMe → account, once per partner refund, and absorbs the partner's processing fee. The same applies when staff reverse a lost dispute. Behind `REFUND_FEE_RETURN` on the API and the worker: on by default with the pretend provider, off by default with our real partner until the owner turns it on. A shared business tip gets it whatever the flag (11 Nov). Money never moves without its posting: with the flag on, a final refund is reversed in the ledger in the same transaction as the fee's return, keyed on the refund, and staff reversals (`tip.reverse`) run for every tip, whatever the release 2 flags (this changes Q7's "never automatic" for final refunds only; disputes stay staff-confirmed). Ruling: the amount is TipMe's platform fee plus the provider fee it took from the tip, so TipMe absorbs the partner's fee. This is a product decision, not a regulatory approval; D-05 keeps its status.

> **Pricing: Free 7%, Pro 5%, Pro ₦5,000 a month (owner, 12 Nov 2026).** The owner's pricing decision. It is not legal advice, and it is not regulatory or payment-partner approval (D-02, D-03 and D-05 stay as listed).
> - **TipMe Free:** 7% of each successful tip, no subscription. **TipMe Pro:** ₦5,000 a month plus 5% of each successful tip. Both rates include processing (TipMe pays processing out of its share; the supporter still pays exactly the tip). This replaces the flat 10% (D-05, ADR-0014) and an earlier "flat 5%" instruction the same day.
> - **When:** from the next production release. A new fee policy (`v2-free-7pct`, `v2-pro-5pct`) applies to quotes created after deploy. A quote already shown (15-minute life) is charged as shown. Tips before keep their recorded 10% (`proposed-v1.1`). Nothing is retroactive.
> - **Which rate:** the recipient's plan when the quote is made (`profiles.plan`: a staff grant or a paid Pro month, grace included). The rate is recorded on the quote in its version and amounts, so a later plan change never alters a recorded tip. When Pro lapses, the next quotes are 7%. Business tips use the staff member's own plan.
> - **Old per-page deals:** capped at the page's plan rate. A deal at or above the rate becomes the rate (deals of 7% or more were cleared by migration `0094_fee_deals_capped`, each with a system audit row); a deal below it stays. Fee-free tips already granted stay.
> - **Pro price:** the default becomes ₦5,000 a month through the price history (migration `0093_pro_price_5000`, with a system audit row). Staff can still change it in ops. Months already paid keep their price.
> - **Cash rewards** stay at 50% of the fees TipMe recorded on each tip.
> - **Withdrawals (owner, 12 Nov 2026):** the user pays the partner's ₦50 transfer fee, taken from the amount: withdraw ₦10,000, receive ₦9,950; "Everything" sends the whole balance less ₦50. Each payout records its rule (`payouts.fee_payer`, `user_fee_minor`, migration `0095_payout_fee_payer`): payouts requested before the release keep TipMe topping up, new ones get no top-up and book the fee against the user's (or business's) payable. A ₦50 top-up TipMe already sent and never used pays that account's next withdrawal fee (the user is shown "TipMe pays the ₦50 transfer fee this time"), so it is neither stranded nor counted twice.
> - **Withdrawal defaults (Claude's, changeable):** the ₦2,000 minimum stays; a balance of ₦50 or less can't be withdrawn (`WITHDRAWAL_BELOW_FEE`, said plainly on the screen); a partner fee above ₦50 is absorbed by TipMe (`provider_fee_expense`) and opens a `payout_fee_short` issue for staff.
> - **Claude's defaults (changeable):** both rates are "processing included" (no extra supporter line); the ₦2,000 minimum tip stays.

> **Changelog and What's new (owner, 5–6 Nov 2026).** The owner asked for the full changelog in admin, and for users to see what an update brings when it ships. The `Changelog.dc.html` board was approved on 5–6 Nov 2026. It is on the design canvas only, not in the repo. On 6 Nov the owner said "use the defaults for the changelogs".
>
> - **Drafts come from merged PRs.** When a PR merges into `dev`, CI sends its number, title, body and merge commit to TipMe, signed with a secret. TipMe reads nothing else from GitHub, and the PR body is parsed and never stored. The staff text is the title plus the body's first paragraph. The user text is the PR description's "For users" section. An empty section makes the entry staff only ("Recorded").
> - **One approval** by someone holding `changelog.publish` (owner only by default) is needed before users see anything. Editors (`changelog.edit`, every role except release_check) ask through the existing Approvals screen. Users only ever read the approved copy.
> - **In-app only, no email.** "What's new" sits in the dashboard menu, with a dot and one Home slip per update. It never appears on public pages or the tip form.
> - **"Reached production"** is decided by git ancestry. After a production (or staging) deploy passes its release check, the deploy job asks TipMe for pending entries and checks `git merge-base --is-ancestor <merge sha> <deployed version>`. It reports the contained ones, signed. The step never fails a deploy, and a hand-run workflow catches up. This requires `main` to keep taking `dev` through a merge commit.
> - **Copy rules:** user text may not name the payment provider or imply approval by a regulator (refused at approval). The Pro price is shown only as the server sends it, and pronouns are "they".
>
> This is a product decision, not a legal, regulatory or provider approval. No D-item changes. Nothing about money, fees, checkout, the ledger or payouts changes.
>
> **Open, with the defaults shipped:**
> 1. Pro entries are shown to every page as "On Pro, …".
> 2. One approval is enough, even when the approver wrote the text.
> 3. Drafts go to production only; staging gets only the "on staging" sync.
> 4. `changelog.publish` is sensitive: a fresh code, and a second person to add it to a role.
> 5. On phones, "What's new" is a small link beside the bell, and the tab bar keeps four items.
> 6. A production rollback does not un-live entries; staff withdraw them.
> 7. Anyone with `changelog.edit` can withdraw, with a reason; showing an entry again needs a new approval.
> 8. No backfill of older PRs; a one-off resend is possible by dispatch.
