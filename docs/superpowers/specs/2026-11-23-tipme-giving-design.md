# TipMe Giving — design

Status: draft for owner approval (23 Nov 2026). Two decisions are **open** (§5): the money flow and the per-gift price. Everything else is decided or marked as a builder's call.

Sources: the owner's Giving brief (pasted 22–23 Nov 2026, "strip it back to the core product"), the owner's ChatGPT revenue/dashboard conversation (reviewed in the browser 23 Nov, including its generated dashboard images), Bachs's public docs/pricing/terms (read 23 Nov), and the conversation decisions recorded below.

---

## 1. Intent

TipMe Giving is the third TipMe product, next to **Individual** (personal tips) and **Business** (tips for businesses and staff). It lets **churches, religious organisations, NGOs, charities and causes** receive contributions through a **QR code or payment link**.

It shares TipMe's sign-in, payments, notifications, ledger and staff tools. It has its own purpose, pages and dashboard.

**Why.** Giving in a church today usually means asking for an account number, typing it into a bank app, then sending proof of payment. Banks already receive money cheaply. TipMe does not compete on receiving money. It competes on everything around the gift:

- giving that is scan, pick, give, done;
- every gift attributed to a purpose (Tithe, Offering, Building…) and, where relevant, a branch;
- a dashboard the pastor or treasurer understands in ten seconds, with records they can export.

**The distribution mechanism is the QR code.** It goes on the projector on Sunday, and on banners, bulletins, websites and WhatsApp.

**Success looks like this:**

- A church registers, creates categories, prints its QR code and starts receiving gifts with minimal help.
- A first-time visitor scans, picks a category, enters an amount and gives without creating an account.

## 2. Goals, non-goals, anti-goals

**Goals (version 1)**

- Organisation registration, profile, logo, description and contact details. Verification by TipMe staff, which grants a "Verified" badge.
- Giving categories. Organisation-level categories, plus extras added per branch (§6.3).
- A giving page per organisation; a link and QR code per organisation, per branch and per category.
- Guest giving with no account; a receipt for every gift.
- The organisation dashboard: Giving view, transactions, filters, export, gift detail, audit log. The Settlement view arrives with money movement (§5).
- Optional branches with HQ and branch-admin permissions.
- Giving Free and Giving Pro plans (§7).
- Staff (ops) screens for verification review and lookup.
- Every gift carries organisation, branch (if any), category, reference, amount, status and time, and is **verified by our backend before it counts as successful**.

**Non-goals (version 1)**, from the owner's brief: budgeted giving, giving wallets, recurring giving or schedules, fundraising campaigns, advanced analytics, member profiles and member giving statements, international giving, and an Enterprise plan. Campaigns and automated reports join Pro later. Enterprise comes later as its own plan.

**Anti-goals (what failure looks like even if it works)**

- A giver has to understand TipMe, create an account, or face surprise fees to give.
- A church's dashboard confuses "given" with "paid out".
- Givers' religious affiliation leaks: named giving histories, phone numbers in lists, or anything that profiles people by faith.
- Sunday morning breaks: thousands of scans in minutes slow the page or fail checkouts.
- Anything implies TipMe or Giving is licensed, regulated or approved. D-04, D-06 and D-07 stay open.
- Users see the payment provider's name. Always say "our payment partner".

## 3. People and roles

- **Giver.** Anyone with the link or QR code. No account needed.
- **Organisation owner.** The signed-in TipMe user who registers the organisation. Full control, billing and settlement details.
- **HQ admin.** Sees and manages the whole organisation and every branch.
- **Branch admin.** Sees and manages only their own branch's gifts, categories and QR code (Pro, with branches on).
- **Finance (Pro).** Transactions, settlement, reports and export. Changes no setup.
- **Viewer (Pro).** Read-only dashboards and reports.
- **TipMe staff.** Review verifications, look up organisations and gifts, and handle support, through the ops screens with existing permission and serious-action rules.

Admins join by invitation, reusing Business's team-role and invite model (`business-roles`). A person can be an Individual recipient and a Giving admin on the same TipMe account.

**Permissions (from the brief, extended with the Pro roles)**

| Permission                                           | Owner / HQ admin               | Branch admin | Finance | Viewer       |
| ---------------------------------------------------- | ------------------------------ | ------------ | ------- | ------------ |
| View all branches and consolidated totals            | Yes                            | No           | Yes     | Yes          |
| View own branch                                      | Yes                            | Yes          | Yes     | Yes          |
| Manage organisation categories                       | Yes                            | No           | No      | No           |
| Manage own branch's categories and QR code           | Yes                            | Yes          | No      | No           |
| Manage branches and admins                           | Yes                            | No           | No      | No           |
| Settlement, reports and export                       | Yes                            | Own branch   | Yes     | Reports only |
| Organisation profile, verification, plan and billing | Owner (HQ admin: profile only) | No           | No      | No           |

## 4. Approaches

### 4.1 Money flow (OPEN — decided by Bachs's written answers, §5)

- **A. The gift goes straight to the organisation's own Bachs account (direct charge).** TipMe never holds the money. The organisation must complete Bachs's full business verification first: registration certificate, address, tax ID, every director and every owner above 5%, and a selfie video. That is heavy for churches and slow. Branch bank accounts later would each need their own account.
- **B. TipMe collects, then pays out to the organisation's verified bank account (You collect for organisations).** The organisation is a Bachs **recipient** account: registered legal name plus a payout account in that name. That is light, so a church can start fast. It reuses the You collect engine: held money, exactly-once transfers, refunds and disputes, the reserve check, reconciliation and staff screens. The costs:
  - TipMe holds the money and is the seller of record, so TipMe carries refunds and lost disputes;
  - Bachs's terms (Merchant Terms 6.1(14)) forbid collecting for third parties **unless Bachs agrees in writing**.
- **Recommendation:** B, **only** with Bachs's written agreement that covers giving to organisations. Without it, A is the only compliant route.

### 4.2 How we build before that decision (decided)

Everything up to the "Give" button, plus records, receipts and dashboards, is built against **one collection boundary**: "collect this gift for this organisation, branch and category; tell me when it is verified". Development and tests use the existing **pretend payment provider**. A or B plugs in behind the boundary later. The fee display reads a setting (giver pays or organisation pays), so either pricing choice drops in without changing screens.

### 4.3 Pricing (OPEN — owner to choose after Bachs answers)

Bachs's standard published rates (23 Nov 2026) are:

- NGN card: 2%, no cap;
- checkout bank transfer: 1.5%, capped at ₦2,000;
- virtual account: 1%, capped at ₦300;
- NGN payout: ₦50;
- dispute: $15, and $29 for an early alert.

A flat 1% fee absorbed by TipMe loses money on cards and transfers. The options:

1. The giver pays processing, plus a 1% TipMe fee charged to the organisation.
2. **About 3% all-in, paid by the organisation**, so the giver pays exactly what they chose. This is the recommended launch option and matches the brief's "Total ₦10,000".
3. A low all-in rate with bank transfer or virtual accounts as the main way to give.
4. A plan (Giving Pro) with a lower per-gift fee.

Whatever is chosen, **the fee is an admin setting** (like the tips' 5%/3%) and is shown transparently in the Settlement view.

## 5. Open decisions and their gates

| #   | Decision                                    | Who                                                                                                                                                   | Blocks                                                                     |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| O1  | A or B                                      | Owner, after Bachs's written answers (agreement under 6.1(14); churches and charities acceptable; **Incorporated Trustees** onboardable as `company`) | Real checkout, payout setup, Settlement view, refunds and disputes         |
| O2  | Per-gift price and who pays processing      | Owner (Bachs church rate first)                                                                                                                       | Fee maths, giver total, fee bookings                                       |
| O3  | Giving Pro price                            | Owner                                                                                                                                                 | Selling Pro. It is an admin setting, and Pro stays unpurchasable until set |
| O4  | Virtual accounts per organisation or branch | Bachs's answer                                                                                                                                        | Optional cheaper bank-transfer route (phase 2+)                            |
| O5  | VAT on TipMe's fee                          | Owner's accountant                                                                                                                                    | Fee bookings and statements                                                |

## 6. The product

### 6.1 Giver experience (the priority)

**Web addresses (decided).**

- `usetipme.xyz/give/<org>`
- `/give/<org>/<category>`
- `/give/<org>/<branch>`
- `/give/<org>/<branch>/<category>`

Rules:

- `give` is a reserved word.
- Organisation slugs follow the handle and reserved-name rules, and are locked once verified (as Business's `/b/<slug>`).
- Within an organisation, **branch and category slugs share one namespace**, so a path can never be ambiguous.
- Each address has a QR code, using the existing QR generation and styling.

**Flow.**

1. **Arrive.**
   - Organisation link: the page shows the organisation's logo, name and Verified badge, and "What would you like to give towards?".
   - Branches on, organisation link: a branch picker comes first. "Not sure? Give to Grace Assembly" is allowed; that gift has no branch and is attributed to HQ.
   - Branch link: the branch is already chosen.
   - Category link: the category is already chosen.
2. **Select a category.** Cards in a grid, with icons, as in the brief's concept UI.
3. **Enter the amount.** Reuse the tip form's amount input and quick picks. Quick-pick amounts are set by the organisation, with defaults of ₦1,000, ₦5,000 and ₦10,000. The minimum follows the platform minimum, and a maximum is a setting.
4. **Optional:** a name to show the church (off by default; §8), an email or phone for the receipt, and a note.
   4a. The receipt goes to **email only** in version 1 (§9a).
5. **Summary**, shown before paying:
   - "Paying to Grace Assembly · Offering" (plus the branch);
   - the amount;
   - any fee (only if O2 makes the giver pay);
   - the total.
6. **"Give ₦10,000"** goes to checkout through the collection boundary.
7. **Back from payment:** the success screen with the reference, gift details and receipt link. The gift shows as successful **only after backend verification**, using the same pending-then-confirmed pattern as tip receipts.

**Receipts.** Every gift gets a receipt page with its reference: organisation, branch, category, amount, time, status and "Paid via TipMe for {Organisation}". It is readable with its receipt token, like tip receipts. If the giver left an email or phone, the receipt is also sent there.

**Copy rules.** Never name the payment partner, never say "wallet", never claim licensing or regulation. The words come from one copy module and are tested, as with You collect's copy.

**Look.** The page uses TipMe's design system, not a new theme. It is phone-first. The logo-only header rule for public tip pages applies. Free organisations get the default look with their logo and cover; Pro organisations can pick any curated Page Studio style (§9a).

### 6.2 Organisation setup and verification

- **Register.** Signed-in only. Name, slug, organisation type (church, mosque or other religious, NGO or charity, other), logo, description, contact details, country (Nigeria).
- **Verify.** The organisation submits a configurable document list.
  - The default for option B is the registration certificate (CAC, including Part F Incorporated Trustees), the registered name, a contact person, and proof of authority to receive funds.
  - Option A adds Bachs's full KYB list.
  - Staff review in ops, approve or ask for more, and the Verified badge appears.
- **Before verification:** the organisation can set everything up and preview its pages, but **cannot receive gifts**. The public page says it isn't taking gifts yet.
- **Settlement details** (after O1):
  - B: a bank account in the organisation's registered name, name-checked as in You collect Task 13.
  - A: Bachs onboarding.

### 6.3 Categories

- **Defaults on creation:** Tithe, Offering, Thanksgiving, Building Project, Welfare, Other. Each can be edited, reordered, hidden or archived; deleting one with gifts isn't allowed.
- **Organisation categories** show at every branch. **Branch admins can add branch-only categories.**
- Free has up to 6 active categories. Pro is unlimited.
- "Other" can ask the giver for a short purpose note (an organisation setting).

### 6.4 Branches (Pro)

- Off by default. A small organisation never sees branches.
- When on, the organisation becomes HQ. Branches have a name, slug, city, their own QR code and their own branch admins.
- Gifts carry `branch_id` when given at a branch link or chosen in the picker. Otherwise they are HQ or unbranched.
- HQ sees everything combined and per branch. A branch admin sees only their own branch.
- **Settlement in version 1 is one organisation account.** Separate branch payout accounts come later, each verified on its own.
- **Downgrading from Pro** keeps branch data and links working. Branch management becomes read-only, and new branches can't be added. This is the builder's call on exact behaviour, and must never break a printed QR code.

### 6.5 Organisation dashboard

The layout follows the owner's reference images (KPI cards, then trend, then breakdowns, then recent gifts), in TipMe's look, with version 1's scope only.

**Giving view**

- **Cards:** Total given, Number of gifts, Average gift, and **Paid out** (Settlement; after O1).
- **Charts:**
  - giving trend over the chosen period;
  - by category (ring and list);
  - by branch (Pro, branches on);
  - how people gave: card, bank transfer, QR or link (Pro analytics; a basic version in Free).
- **Recent gifts:** category, amount, time, and "Guest" or the giver's chosen name.
- **Quick actions:** Categories, My QR code, Branches (Pro), Reports.
- **Period picker:** this week, month, quarter, or a custom range.

**Transactions.** A table of time, category, branch, amount, status (pending, successful, failed or refunded) and reference. It has search, filters (category, branch, status, date) and paging. Export is CSV on Free, plus PDF and Excel on Pro.

**Gift detail.** Amount, category, branch, reference, how the giver paid, and a timeline: **Payment received → Verified → Paid out**. Paid out comes after O1. Actions: download receipt, and refund (after O1, with two people, following the You collect refund rules).

**Settlement view** (after O1). Given, then fees, then paid out, then pending. It lists payouts with references, and reconciliation differences. **It is never mixed with the Giving view.** A church may have ₦30M given and ₦28M paid out at the same moment, and the screen must make that obvious.

**Reports (Pro):** a giving summary, a category report, a branch report and a settlement report, as PDF or Excel.

**Audit log.** Who changed categories, branches, admins, settlement details, plan, refunds or exports, and when.

**Not shown:** "TipMe revenue". Organisations see fees, not our revenue. No member lists. No "Upgrade" card is shown to Pro organisations.

### 6.6 Notifications

- **To the organisation:** verification outcome, the first gift received, payouts sent or failed (after O1), and a weekly summary email (Pro, optional).
- **To the giver:** the receipt, only if they left an email or phone.
- Everything reuses the existing mail and notification system and the "never name the partner" rule.

### 6.7 Staff (ops) screens

- A verification queue with documents. Approve or request more; serious actions follow existing rules.
- Organisation lookup: plan, status, branches, admins.
- Gift lookup by reference.
- Turning the `giving` switch on and off.
- After O1: the payout and refund screens reuse You collect's ops screens where possible.

## 7. Plans

|                                                                                           | Giving Free     | Giving Pro (price is an admin setting, O3) |
| ----------------------------------------------------------------------------------------- | --------------- | ------------------------------------------ |
| Giving page, organisation, category and branch links and QR codes, guest giving, receipts | ✓               | ✓                                          |
| Dashboard basics, transactions, CSV export, audit log                                     | ✓               | ✓                                          |
| Active categories                                                                         | up to 6         | unlimited                                  |
| Admins                                                                                    | owner + 1 admin | more admins, plus Finance and Viewer roles |
| Branches (HQ view, branch admins, branch QR codes)                                        | —               | ✓                                          |
| PDF and Excel reports; settlement and branch reports                                      | —               | ✓                                          |
| How-people-gave and longer-range analytics                                                | basic           | ✓                                          |
| Branded giving page (cover, colours)                                                      | basic           | full                                       |
| Fee per gift (O2)                                                                         | standard        | lower; admin-settable                      |
| Later: campaigns, automated reports                                                       | —               | Pro                                        |
| Later: Enterprise (integrations, dedicated support, custom reports)                       | —               | its own plan                               |

Billing reuses the existing Pro and Business Pro billing: pay from balance or card, auto-renew, bank transfer, and an admin-set price. Giving Pro can't be bought until its price is set.

## 8. Constraints

- **The `giving` switch** is staff-controlled, off by default and money-gated, like `you_collect`. With it off, nothing about Individual or Business changes.
- **Sensitive data.** Linking a named person to giving to a religious organisation reveals religious belief, which Nigeria's data protection law treats as sensitive. So:
  - the giver's name is optional and off by default (the organisation can enable "ask for name");
  - an email or phone is used only for the receipt and isn't shown to the organisation unless the giver ticks "share my contact with {Organisation}";
  - no giving profiles are kept across gifts;
  - exports contain the name only when the giver chose to share it.

  The privacy register gets a Giving entry.

- **Backend verification.** A gift is successful only after our backend verifies the payment. It reuses the existing payment-verification and ledger paths and exactly-once rules.
- **The Sunday rush.**
  - Giving pages must be served mostly from the edge (cacheable, with no per-visit API work beyond what's needed).
  - Checkout creation must be fast and idempotent.
  - Before the **first large organisation** goes live, a load test must show the target: **thousands of gifts within about 10 minutes** for one organisation, at acceptable latency and with no failed checkouts. This ties to the parked infrastructure and load-test work.
- **Regulatory.** No claims. D-04, D-06 and D-07 stay open. Production switch-on also needs the Bachs agreement (O1).
- **Reuse.** Use existing patterns: Business roles and invites, QR generation, the tip amount input, receipts and status tokens, ops list pages, mail, the audit log and the switch system. Add no new client dependencies without reason.

## 9. Delivery

**Phase 1 (can start on approval, independent of O1 and O2), all behind `giving`, on the pretend provider:**

1. Foundations: organisation, branch, category and membership data; roles and permissions; the switch; reserved slugs.
2. Organisation setup and profile; the verification submission and ops review queue; the Verified badge.
3. Categories (organisation and branch), with Free limits.
4. Giving pages, links, QR codes, and the 4-step giver flow, ending at the collection boundary.
5. Gift records, attribution, backend verification (pretend provider), receipts and optional receipt email.
6. Dashboard Giving view, transactions, filters, CSV export, gift detail, audit log.
7. Branches and permissions (Pro gating), and the HQ and branch views.
8. Giving Free and Pro plans with admin-set pricing and billing reuse; Pro reports (PDF and Excel).
9. Ops screens: verification queue, organisation and gift lookup.

**Phase 2 (after O1 and O2):**

- the real collection adapter (A or B);
- settlement details and payouts;
- the Settlement view;
- refunds and disputes;
- reconciliation;
- fee bookings;
- optionally, virtual accounts.

**Launch gates:** O1 answered with the written agreement; O2 set; the load test passed for the first large organisation; switch-on by staff with a second person.

## 9a. Calls made after the builder check (Claude's calls unless marked; owner may override)

- **Owner, 23 Nov 2026: staging only until O1.** The `giving` switch is not turned on in production until O1 is answered, so no real organisations sign up early. Section 6.2's "set up and preview, not taking gifts yet" state describes the product's behaviour for an organisation that isn't verified yet. It is not an early-onboarding phase. Phase 1 ships behind the switch and is exercised on staging only.
- **Owner, 23 Nov 2026: Pro branding reuses Page Studio.**
  - **Free:** the default (Classic) look with the organisation's logo and cover photo.
  - **Pro:** unlocks the other curated Studio styles for the giving page.
  - No custom colour controls, following the 16–17 Nov Studio decision of curated styles only.

  The §7 row "Branded giving page: basic / full" means exactly this.

- **Paying for Giving Pro: card or bank transfer only, never from gifts.** Giving Pro is never paid from an organisation's gifts. Under option B those gifts are donor money that TipMe holds. Paying from the owner's personal TipMe balance is allowed only if it reuses `pro-balance` unchanged; otherwise it's card or bank transfer.
- **Receipts: email only in version 1.** Phone/SMS/WhatsApp receipts wait for D-11 (messaging providers). The giver form offers email only.
- **Sunday rate limits.** Many givers share one church Wi-Fi address, so per-IP-address limits on giving pages and gift checkouts must not stop a congregation. Limit per device or session, plus per organisation. The existing per-address cap on intents must not apply unchanged to Giving. This is part of the load-test target.
- **Downgrading from Pro.** More than 6 categories, extra admins and branches keep working, and links and QR codes never break. New ones are blocked until the organisation upgrades again.
- **What a branch admin sees under Settlement.** The branch's given totals and fees attributed to it. Payouts are organisation-wide, so they show only to HQ, Finance and the owner.
- **Keeping data (provisional defaults until D-07 and a legal check; owner to confirm):**
  - **Verification documents** are kept while the organisation is active, plus 6 years after it closes (record-keeping). Staff can view them in ops; downloading one is a serious action and is audited. They're stored privately, never in a public bucket.
  - **A giver's receipt email** is kept for 180 days, which covers the partner's dispute and settlement windows. After that it's deleted, unless the giver ticked "share my contact with {Organisation}".
  - **The giver's optional name** stays with the gift only if they gave it.
  - The privacy register gets these entries.

## 10. Left to the builder

- Table and column names; how organisation and branch reuse or extend Business tables.
- Exact category icons; quick-pick defaults per organisation type.
- Cache strategy for giving pages, within the Sunday-rush requirement.
- Chart components (reuse existing ones).
- Exact downgrade behaviour for branches (must not break printed QR codes).
- Report layouts.
- How the "Other" purpose note is stored and shown.
