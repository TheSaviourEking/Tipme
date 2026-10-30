# Ops account overview: everything about one person, in one place

**Status:** design, awaiting the product owner's approval (30 October 2026)
**Related:** `2026-10-30-mail-platform-design.md` (§5.1 email console feeds the "Emails" section) and `2026-10-30-payment-provider-switching-design.md` (overrides and per-provider accounts appear here).

**(owner)** marks what the product owner decided; **(design call)** marks what this document chose.

## 1. Intent

From a profile's main screen, staff should "see every single thing about them, aside from compliance-related private information", including growth: how much they received this month, last week and in the last 24 hours, and how many times they've changed their username **(owner)**.

Today the ops page lookup (`GET /v1/ops/pages/:handle`) returns only handle, display name, plan, page state and suspension. Staff piece the rest together from search, issues and the audit log.

**Two audiences (owner, 30 October):**

- **Staff** see everything in this document, on the account page reached from ops search, issues and the email console.
- **Recipients** see their own growth figures (§3.10) on their dashboard.

An admin who searches for a user sees, on that user's page, the emails TipMe sent them, and can open each one (§3.6) **(owner)**.

## 2. Goals and non-goals

**Goals**

1. One page per account, `/ops/accounts/[userId]`. `/ops/pages/[handle]` redirects to it.
2. Growth figures over standard periods, each with a comparison to the period before.
3. A complete, durable username history and count.
4. Everything else TipMe holds about the account, grouped and linked: payments, balance, tips, emails, moments, moderation, sessions and staff actions.
5. Compliance-sensitive data stays hidden or masked. Personal data that staff sometimes need is behind the existing audited "reveal with a reason".

**Non-goals**

- Editing from this page beyond the actions that already exist (plan, fee, fee-free grants, pause, recovery, provider override), which are linked or embedded as they are.
- Showing KYC documents, identity numbers (BVN/NIN), date of birth, home address or full bank account numbers. TipMe doesn't hold most of these (Bachs does), and what it holds stays masked.

## 3. The page

**Header.** Display name, handle, avatar, page state (live, not live, deleted), plan (Free or Pro), paused or not, account created, last sign-in, and quick links (public page, issues about them, audit log filtered to them).

### 3.1 Growth (owner)

**Periods,** in Lagos calendar time: last 24 hours, today, this week, last week, this month, last month, the last 90 days and all time.

**Each period shows:**

- **Received:** the recipient's net (what they keep), plus the gross paid by supporters and TipMe's share, from verified tips only. The ledger is the source.
- **Tips:** count of confirmed tips, average tip and largest tip.
- **Change vs the previous equal period:** count and percentage, e.g. "₦184,500 this month · +37% vs October" or "₦12,000 in the last 24 hours · −20% vs the 24 hours before".

**Also shown:**

- **Charts:** received per day over the last 90 days, with a 30-day comparison line, and tips per day.
- **Page performance** when analytics collection is on (D-07: off in production until approved; the section says so when off): page visits, tip conversion (tips ÷ visits), and QR or shared-link visits where recorded.
- **Firsts and milestones:** first tip date, the milestone moments reached and when.

**Accuracy:** only `SUCCEEDED` tips count. Reversed or refunded tips are shown separately as "reversed", never netted silently. Test and rehearsal tips are excluded.

### 3.2 Username history (owner)

- "Changed username **N** times", followed by the full list (from, to, when, and by whom: the owner, or staff with a reason).
- **This needs a new table.** Today's `handle_aliases` keeps old handles only as redirects, and drops one when the owner takes that handle back, so it can't count changes. A new append-only `handle_changes` table (`id`, `profile_id`, `from_handle`, `to_handle`, `changed_by` (user or staff), `changed_at`) is written in the same transaction as every rename and claim.
- **Backfill:** one row per existing alias, marked "reconstructed, date approximate", because exact history before this change wasn't kept **(design call)**.
- Also shown: the handles currently held as redirects to this page, and any handle hold left from a deleted page.

### 3.3 Account and sign-in

- **Sign-in email:** masked (`t•••@gmail.com`), with "Reveal" (needs `private.view` and a reason, audited).
- **Recovery email:** set or not, and when it was confirmed. The address is masked, with the same reveal rule.
- **Phone:** set or not, masked.
- **Sessions:** active sessions (device label, created, last seen). Known devices count.
- **Recoveries:** pending, completed and cancelled, with dates.
- **Staff:** whether the account is staff, its role and ops sessions. Owner-only detail stays as it is today.

### 3.4 Payments and money

- **Payment accounts by provider:** status, card collection, fee collector, requirements due, created and last synced. These are Bachs' normalised fields; no KYC data.
- **Provider override,** if any (payments and mail), and its history.
- **Balance by provider:** available and pending.
- **Withdrawals:** status, amount, provider and dates. The destination is masked to its last 4 digits.
- **Pricing:** plan, custom fee, fee-free tips remaining and grants (who granted and why).
- **Open money issues** about this account, linked.

### 3.5 Tips

A paginated list: date, amount (gross and net), status, provider, supporter label (as the supporter typed it), purpose, and whether there's a message. **Message text stays behind the existing audited reveal.** Filters: status, period and provider. Each row links to the tip's status timeline (attempts, provider events, ledger postings).

### 3.6 Emails

**On the user's page when an admin searches for them (owner):** every email TipMe sent them, newest first, with date, type, subject, provider, status and last event (delivered, opened, clicked, bounced), filterable by period and type. Also shown: counts by type and any suppression affecting the account's addresses.

**Opening an email** shows it as the user received it (subject, the HTML view and the text view), from the snapshot the mail platform keeps (mail design §4.2, `rendered_sealed`), plus its full timeline.

- **Security emails are never shown.** Their content holds codes and recovery links, so the page says "Content withheld: this email contains a sign-in or recovery code" and shows only the type, time and timeline.
- **Personal links are redacted.** In other emails, links that carry a personal token (unsubscribe, one-time links) are replaced with "[personal link]" before the snapshot is stored, so opening an email can never be used to act as the user.
- **Every open is audited** (`email.viewed`, recording staff, message and account). It needs `accounts.view`, without a reason prompt, so support can answer "what did we send them?" quickly **(design call)**.

### 3.7 Notifications and preferences

The account's email and in-app preferences (tip emails, weekly report, milestones, engagement and marketing), and its attention items currently showing (payments not set up, no recovery email, provider setup needed during a switch).

### 3.8 Moderation and trust

Reports against the page (reason and date; reporter identity never shown), flagged messages (count, plus links behind reveal), pause and restore history with reasons, and issues of every kind about this account.

### 3.9 Staff actions

The audit log filtered to this account (`subject_id` = user, profile or attempt ids belonging to it): who did what and why, newest first.

### 3.10 Growth on the recipient's own dashboard (owner)

Recipients see their own growth figures on the dashboard home, from the same queries and rollup as §3.1, without TipMe's share:

- received in the last 24 hours, this week, last week, this month and last month, each with its change from the period before ("₦12,000 this week · +20% vs last week");
- tip count and average tip for each period;
- a 30-day chart of what they received per day.

Reversed tips are shown as their own line. The figures follow the design constitution: plain numbers first, change shown in words and colour with a text equivalent. When the previous period was zero, it says "Your first tips this month" rather than a percentage. The existing dashboard summary stays; this sits above or replaces its totals, decided when building the screen with the owner.

## 4. Data and server

- **One API:** `GET /v1/ops/accounts/:userId` for the header and summary. Each section has its own endpoint (`/growth?period=`, `/handles`, `/payments`, `/tips`, `/emails`, `/moderation`, `/audit`) so the page loads in parts and a slow section doesn't block the rest.
- **Growth queries** read verified ledger postings grouped by Lagos day. For speed at scale, a `profile_daily_stats` rollup (`profile_id`, `lagos_date`, net, gross, TipMe share, tip count, reversed) is updated when a tip is booked or reversed, and can be rebuilt from the ledger **(design call)**.
- **Lookup:** handle, previous handle, user id or (with `private.view`) email, through the existing ops search.
- **Permissions:**
  - a new `accounts.view` permission to open the page;
  - `private.view` for reveals;
  - existing action permissions are unchanged.
    The Owner role gets the new permission automatically. Opening an account page writes a light audit entry (`account.viewed`), because staff browsing people's data should leave a trail **(design call)**.
- **Contracts** in `packages/contracts/src/ops.ts`; zod at ingress; amounts as minor-unit strings.

## 5. Testing

- **Growth:**
  - period boundaries in Lagos time (a tip at 23:30 Lagos on the last day of the month counts in that month);
  - comparisons, including the previous period being zero ("new" rather than infinity);
  - reversed and test tips excluded;
  - rollup equals a ledger recomputation.
- **Username history:**
  - every rename and claim writes one row;
  - taking a handle back still counts as a change;
  - the backfill marks reconstructed rows.
- **Privacy:**
  - no unmasked email, phone, bank number or message text in any response without a reveal;
  - reveals and views are audited;
  - KYC fields never appear.
- **Permissions:** `accounts.view` is required, and reveals need `private.view`.
- **E2E:** open an account from search; see growth, username history, tips and emails.

## 6. Delivery order

1. `handle_changes`, written by every rename and claim, with the backfill.
2. `profile_daily_stats`, the growth API and the growth section.
3. The account page with header, account, payments, tips and staff actions (from existing data).
4. The emails, moderation and preferences sections (emails after the mail console exists).
5. The recipient dashboard growth section (§3.10).

## 7. Answered

- Recipients see growth figures on their dashboard: yes (§3.10).
- Admins see each user's emails on their page: yes (§3.6).
