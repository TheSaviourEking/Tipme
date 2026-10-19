# PR-008 design — recipient accounts, dashboard, QR, notifications and moments

Status: DRAFT for user approval. Date: 2026-10-19. A builder check was done; its seven questions are answered below as the agent's calls.

## Intent

A recipient (Tobi the barista, or Kemi, a new hairdresser) opens TipMe after a busy shift. The user's words describe what they want to see and do:

- their performance: are they being tipped more today, yesterday, this week or last week, and the up or down trend;
- their balance;
- recent transactions, both tips and withdrawals;
- a list of their tips;
- "what actions they can take".

Recipients should be able to customise the experience "as far as possible". TipMe should notice their growth and appreciate them, sometimes with money in their wallet, "because humans appreciate things coming to their wallets".

PR-008 is the delivery plan's dashboard slice (recipient authentication, tip history and earnings, QR sharing, notifications mock) **plus open sign-up**. The user added sign-up because no other PR covers it.

Only pretend money exists. D-03, D-04 and D-05 are OPEN, so every amount, withdrawal and reward is pretend and labelled as such.

## Goals (agreed with the user)

1. **Sign in with a phone number and a 6-digit code.**
   - The code is sent by WhatsApp first, with SMS as the fallback.
   - Email is optional and serves as a backup.
   - No passwords.
2. **Open sign-up.** Anyone creates an account, claims a handle and gets `/@handle`.
3. **Page states, controlled by the recipient:**
   - **Live:** anyone can open the page and tip.
   - **Not live:** visitors see a friendly "This page isn't available right now" that does not reveal whose page it is, and no tips can be made.
   - **Deleted.**
   - New pages start not live. Only a handle is needed to go live.
4. **Optional profile enrichment from the dashboard:**
   - socials (Facebook, Instagram, X/Twitter);
   - bio;
   - phone number;
   - email.
   - Each detail has its own Public / Private switch. Phone and email start **private** and are free to keep private. Socials and bio start public.
5. **Dashboard home** (the approved sketch, `.superpowers/brainstorm/30869-1792388103/content/dashboard-home.html`):
   - **Balance:** confirmed money only. Money still being confirmed is shown separately.
   - **Performance:** today vs yesterday and this week vs last week, with up/down arrows and a 7-day trend.
   - **Actions:** Show my QR, Share link, Withdraw.
   - **Recent activity:** tips and withdrawals with statuses.
   - **Full tips list.**
6. **Tip detail.**
   - Shows the supporter's private message, the gross amount, fees, the recipient's net amount, and proof that the provider confirmed it. The proof comes from the existing PR-005 proof records.
   - This answers the user's PR-005 requirement to "prove without doubt the funds went through".
7. **Withdraw (pretend).**
   - The recipient requests a payout of their balance to a pretend bank account.
   - It uses the PR-005/006 payout records, the mock provider and payout reconciliation.
8. **QR code** (the approved sketch `qr-share.html`):
   - **Three free styles:** Purple, Night, Clean.
   - **Designer styles** (initially Sunset, Glow, Stripe), marked "Premium · free in preview". Nothing is charged.
   - **Uses:**
     - **Print card:** a printable table card or sticker.
     - **Show full screen:** a large, bright code to scan straight off the phone.
     - **Post / share image:** a square image through the phone's share sheet, for WhatsApp status, Instagram and similar.
   - Every offered style must still scan.
9. **Tip notifications.**
   - When a tip is verified (never while it is still confirming), the recipient gets:
     - an in-app pop-up when the dashboard is open, plus a notification list (bell);
     - an email, if they have a verified email address.
   - No SMS for tips.
   - Real push notifications are later. Email goes to a pretend mailbox in this PR.
10. **Weekly report** by email and in-app:
    - totals, the change from last week, the best day, the number of tips and notes, and moments;
    - "top supporter", only by the name the supporter chose to give, in the private report only;
    - a shareable "my week on TipMe" image showing the recipient's own numbers and milestones, **never supporters' names**.
11. **Surprise moments.** TipMe notices growth (milestones, best week, a lovely note) and celebrates it. Some moments come with a reward:
    - **Fee-free tips** (the default reward). For example: "100 tips! Your next 10 tips are fee-free." TipMe waives its own platform fee; the provider fee still applies.
    - **Cash bonus** at the big milestones (for example the 50th tip, the 100th tip and the best month).
      - The bonus is **a share of the TipMe fees that this recipient earned TipMe**. Starting value: 50% of the fees from the tips that led to the milestone.
      - Bonuses come out of a **monthly cash-reward budget** set in configuration. When the budget is spent, moments fall back to fee-free rewards.
      - A bonus is booked as TipMe's own promotional cost, never taken from supporters' tips.
    - **Supporters can add to a celebration.** A shared moment or report links to the recipient's page, which shows an "Add to the celebration" prompt. That tip goes through the normal PR-007 flow, with a celebration label.

## Non-goals

- Real SMS, WhatsApp, email or push delivery: each needs a provider, an account and costs (D-08).
- Real payouts or bank accounts (D-03, D-04).
- Billing or charging for premium QR styles or plans. "Paid plans" is recorded as a future idea in the decisions log.
- Photo and background-image uploads.
- Changing a handle after it is claimed.
- The ops view and analytics (PR-009).
- Supporter accounts.

## Anti-goals

- Supporters' names or messages in anything shareable or public.
- Money that is still confirming shown as balance.
- Notifications or rewards triggered by unverified tips.
- Phone or email public by default, or charging people to keep their own details private.
- Comparing supporters with each other in anything public.
- Any guilt or pressure copy, for recipients as well as supporters.
- A reward that can cost TipMe more than the fees it earned from that recipient.
- A reward that pays twice for the same milestone.
- Sign-in codes, session tokens, phone numbers or emails in logs, traces or URLs.

## Constraints

- **AGENTS.md** and `docs/05-SECURITY.md`:
  - sessions in Secure, HttpOnly, SameSite cookies, rotated on sign-in and revocable;
  - CSRF protection or a strict origin check for state-changing requests;
  - server-side authorization on every resource;
  - strong rate limiting for authentication;
  - minimal personal data.
- **Web AGENTS.md:** server-rendered public profiles, all UI states, WCAG 2.2 AA, LCP ≤ 2.0 s.
- **Money and state changes:**
  - PR-005 invariants: integer minor units, append-only ledger, balanced transactions, every state change through the operations layer with transitions.
  - The PR-007 status rules: only verified evidence counts.
- **Existing suites stay green.** Brand #7A32F9, white, black. The `/@handle` route scheme stays.
- **Dependencies:** any new dependency (for example a QR library) is pinned, justified and added to `docs/third-party-component-register.md`.

## Decided with the user

- Sign-in method: phone number and code, WhatsApp then SMS, email as backup.
- Sign-up in this PR.
- Page states: live, not live, deleted.
- Socials, bio, phone and email are optional, each with a public/private switch; phone and email are private by default and free.
- The dashboard contents (sketch approved).
- QR: three free styles plus premium styles free during the preview; print, full-screen and share uses.
- Notifications: in-app and email, no SMS.
- The weekly report and share image.
- Surprise moments with fee-free rewards by default and cash bonuses sized as a share of the fees earned, under a monthly budget.
- Supporters can add to a celebration.
- Everything in one PR.

## Builder's design (agent's calls, open to review)

### Accounts and sessions (ADR-0003)

- **Users:**
  - The phone number (E.164, unique) is the identity.
  - **Countries** _(builder check, agent's call)_: any country is accepted, with +234 (Nigeria) pre-selected, because D-01 is open. Numbers are validated and normalised with a small, pinned phone-number library (registered). Seeded test numbers use a reserved fictional range.
  - **One page per account:** `profiles.user_id` becomes unique and required for new profiles.
  - Email is optional and must be verified through a link before it is used for notifications or recovery. In this PR the link goes to the pretend mailbox.
  - **What email "backup" allows** _(builder check, agent's call)_: **recovery only, not a second way to sign in.** If Tobi loses his number, a link to his verified email lets him attach a new number, which still must be confirmed with a code sent to that new number. Recovery ends every other session. A hijacked email alone therefore never opens the account.
  - Changing the phone number requires a code sent to the new number.
- **Sign-in codes:**
  - 6 digits, valid for 10 minutes, only the latest code counts, stored hashed.
  - At most 5 wrong attempts, then a 15-minute lockout.
  - At most 3 codes per number per hour and 10 per IP per hour.
  - Responses never reveal whether a number has an account.
- **Delivery:** through a `Messenger` interface. The only adapter is a **pretend messenger**: a development-only page lists "messages that would have been sent" (WhatsApp, then SMS on simulated failure). It is gated like the mock payment provider: refused in production.
- **Sessions:**
  - Self-hosted, with no third-party auth service.
  - A random 256-bit token in a `Secure` (except on localhost), `HttpOnly`, `SameSite=Lax` cookie. Postgres stores only the token's hash, the device label and last-seen time.
  - Sliding 30-day expiry, rotated on sign-in.
  - The recipient sees their devices and can sign out any one of them, or all.
- **State-changing requests:** the request's `Origin` must equal `WEB_ORIGIN`, plus a custom header. The session token is never readable by JavaScript.

### Handles, profiles and page states

- **Handles:**
  - 3–30 characters (letters, digits, underscore), case-insensitive and unique.
  - Reserved words: `admin`, `api`, `dashboard`, `sign-in`, `sign-up`, `tipme`, `support`, `help`, `legal`, `tip`, `mock-checkout`, `people`, `about-preview`, `how-it-works`, `for-creators`, `design-system`, `preview-states`, and similar.
  - Availability is checked live while typing, with rate limiting.
  - A deleted handle is held for 90 days.
- **Page states:**
  - `live` and `not_live`. New pages start `not_live`.
  - `deleted` anonymises the profile and keeps the money records.
  - **Deleting the page deletes the account** _(builder check, agent's call)_:
    - All sessions end.
    - Phone, email, socials and bio are erased.
    - The user row is anonymised; money records keep their IDs.
    - The phone number may sign up again later.
    - The old handle is held for 90 days for everyone, including the former owner, because TipMe no longer knows who they were.
  - Deleting is blocked while the balance is above zero or a tip is confirming.
  - Not-live and deleted pages show the same "isn't available" screen as an unknown handle, so a page's existence is never revealed.
  - The existing `suspended` status stays TipMe-controlled (for PR-009).
- **Public `/@handle`:**
  - Loaded from the database through a public API endpoint.
  - Server-rendered, `noindex` and labelled pretend payments, as before.
  - Public details only: display name, role, bio and socials, plus phone and email only where switched public.
  - Cached for speed. A change made on the dashboard, including going not live, is visible within a few seconds (on-demand revalidation).
- **Demo recipients:** Ada and Tobi become ordinary seeded accounts with test phone numbers. Their current static content (bio, craft, note, avatar) moves into the seed.
- **Socials:** only `https://` URLs on facebook.com, instagram.com, x.com or twitter.com, shown as icons.
- **Supporter name on the tip form:** a small "Your name (optional)" field is added to the PR-007 tip form, so dashboards can show "Tip from Ada M.". It uses the existing `payer_display_label`.

### Dashboard (`/dashboard`, recipient-authenticated)

- **Home:**
  - **Balance:** the recipient's confirmed payable from the ledger, minus payouts requested or paid. Confirming tips are shown separately.
  - **Performance:** today vs yesterday and this week vs last week, plus a 7-day trend. Lagos time (WAT) is used for day and week boundaries.
  - **Actions** and **recent activity** as in the sketch.
  - **First-day state:** "Show your QR to get your first tip" instead of an empty chart.
- **Tips list:** paged, newest first, filterable by status.
- **Tip detail:** the message, amounts and provider proof.
- **Withdraw** _(builder check, agent's call)_:
  - A pretend payout of **any amount up to the available balance**. The available balance includes cash bonuses.
  - Payouts become **amount-based**. The PR-005 `payout_items` link to tips is replaced by the ledger balance as the source of truth.
    - A migration adds an amount-based payout model.
    - Idempotency comes from the request's idempotency key.
    - A failed payout returns its amount to the balance through a reversing ledger entry.
  - ADR-0006 gets an addendum. Finance sign-off is still needed before real money (D-04).
  - The withdrawal's status is shown in recent activity.
- **Settings:**
  - profile details and public/private switches;
  - page state;
  - phone and email;
  - devices and sign-out;
  - delete page.
- **Access control:** a recipient can only ever read or change their own data. This is enforced on the server, with tests across two accounts.

### QR

- The QR always encodes the recipient's `/@handle` URL.
- **Styles** are fixed, named presets (colour, frame and pattern), chosen per recipient and stored. There is no free-form editing yet.
- **Generation:** in the browser, with a small QR library. Print cards and share images are produced from the same preview.
- **Tests:** every style is decoded by an automated check, so a style that doesn't scan cannot ship.

### Notifications, weekly report and moments (worker)

- **Notifications:**
  - The worker already receives the `tip.succeeded` outbox event. From it, it creates a notification and, if the recipient has a verified email, an email in the pretend mailbox.
  - Both are idempotent per tip.
  - The dashboard polls for new notifications.
- **Weekly report:**
  - A scheduled job runs Monday morning, Lagos time.
  - One report per recipient per week (idempotent), stored for in-app viewing and emailed.
  - A development-only "run now" trigger exists for testing.
  - **Share image:** server-rendered with the existing Next image-generation route used for Open Graph images. It shows the recipient's own numbers only.
- **Moments:**
  - Evaluated after each verified tip and in the weekly job. Each moment has a unique key (for example `milestone.100.<profileId>`), so it can never be awarded twice.
  - **Starting set:**

    | Moment                  | Reward                        |
    | ----------------------- | ----------------------------- |
    | First tip               | Celebration only              |
    | 10th tip                | 5 fee-free tips               |
    | 50th tip                | Cash bonus                    |
    | 100th tip               | Cash bonus + 10 fee-free tips |
    | Best week so far        | Celebration only              |
    | Best month so far       | Cash bonus                    |
    | A note from a supporter | Celebration only              |

  - All amounts, counts and percentages live in one configuration module, so they are easy to tune.
  - **"Best week/month so far"** _(builder check, agent's call)_:
    - Judged only **after the period closes**: the weekly job, plus a monthly job on the 1st (Lagos time).
    - Needs at least 4 earlier weeks (or 2 earlier months) with tips, and at least 5 tips in the period.
    - Must beat the previous best.
    - Keys are per period (`best_week.<isoWeek>.<profileId>`), so each record-breaking period can be celebrated once. A new recipient's first period never counts.
- **Fee-free tips:**
  - While a recipient has fee-free credits, quotes show a TipMe fee of ₦0 (provider fee unchanged) and are recorded with their own fee-policy version.
  - A credit is used up when such a tip **succeeds**. A quoted fee-free tip is always honoured, even if the credits ran out in the meantime.
- **Cash bonus** _(builder check, agent's call)_:
  - **What counts towards a bonus:** the platform fees from verified tips **since the previous cash bonus**. Windows never overlap, so the same tips never feed two bonuses.
  - **Amount:** the configured share (50%) of those fees, capped by the remaining monthly budget.
  - **Lifetime cap per recipient:** everything TipMe gives a recipient (cash bonuses plus waived fees from fee-free tips) never exceeds 50% of the platform fees that recipient has earned TipMe. Property tests prove this.
  - Booked as a new `reward` operation: debit a TipMe promotions-expense account, credit the recipient's payable.
  - Balanced and append-only, with its own proof record.
  - No budget left means no bonus; the moment falls back to fee-free tips.
- **Public moments** _(builder check, agent's call)_:
  - A moment is private until the recipient taps **Share** on it.
  - Only shared moments, from the last 14 days, can show the celebration prompt on the public page.
  - A shared moment or report links to `/@handle` with a celebration reference.
  - The public page shows a short "Celebrating Tobi's 100th tip — add to the celebration" prompt. It names only the recipient, never supporters, and only for a real, recent, public moment.
  - Tips started from it carry a `celebration` label.

### API

New `/v1` routes, all in the `{data}` / `{error}` envelope:

- **Auth:** request code, verify code, sign out, sessions list and revoke.
- **Sign-up:** handle check, claim.
- **Me:** profile, settings, page state, delete.
- **Dashboard:** summary, tips, tip detail, withdrawals.
- **Notifications:** list, mark read.
- **Reports:** list, detail.
- **Moments:** list.
- **Public:** profile by handle.
- **Development only:** pretend messenger and pretend mailbox views.

Rate limits follow PR-007's design. Authenticated routes allow CORS with credentials for `WEB_ORIGIN` only.

### Documentation

- ADR-0003 (accounts and sessions).
- ADR-0009 (recipient profiles, notifications, moments and rewards, including the reward ledger operation).
- Decisions log: the D-04 note stays. Add notes for paid plans (future idea) and cash rewards (pending D-05 and legal review).
- `docs/PR-008-VERIFICATION.md`, updated runbooks and the handoff.

## Left to the builder

- Exact component split and page layout within the approved sketches.
- Polling intervals.
- The exact reserved-handle list.
- Which QR library (pinned and registered).
- How the dashboard tells the web to revalidate a profile.
- Email template wording within the agreed tone.
- The exact preset designs for the six QR styles.

## Risks

- **Size:** this PR is roughly two to three times PR-007. The plan should stage it so each stage is shippable and tested on its own:
  1. accounts and sessions;
  2. sign-up and profiles;
  3. dashboard and withdraw;
  4. QR;
  5. notifications and reports;
  6. moments and rewards.
- **Moving profiles to the database** must keep `/@handle` fast and avoid showing a not-live page from a stale cache.
- **Cash rewards** are a financial promotion. Before real money they need D-05, legal review, and the two-person approval rule from the security baseline for any manual adjustment.
- **Phone-number identity** depends on number recycling by mobile operators. The email backup and the devices list mitigate this.
- **Impersonation** (anyone can claim "@tobi"): pages stay `noindex` and labelled pretend. Verification waits for D-06.
