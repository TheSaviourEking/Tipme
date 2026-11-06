# Screen redesign boards

The repository-owned boards for the screen redesign (`docs/design/VISUAL-QUALITY-GATE.md` compares
built screens against these). They are copies of the design canvas at
https://claude.ai/artifact/8D6hJZsqMkLSGh8KUUBmmh, version `1793674371-ce32` (3 Nov 2026).

Each `boards/*.dc.html` is the canvas's own format: plain HTML and inline CSS inside `<x-dc>`, with
`{{holes}}`, `<sc-if>` and `<sc-for>` for the interactive boards and a `class Component` at the end that
holds their state. Read them for layout, copy, materials and behaviour. Images are `/_blob/…`
references that only resolve on the canvas; open the canvas to see them.

Where a board and a newer owner decision disagree, the decision wins:

| Board says                                            | Now                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ₦1,000 keys, "withdraw from ₦1,000"                   | ₦2,000, ₦5,000 and ₦10,000; minimum tip and withdrawal ₦2,000 (2 Nov 2026)            |
| "Tipping opens soon", "no bank details needed yet"    | Tipping is live for named pages (`LIVE_CHECKOUT_HANDLES`); copy follows payment mode  |
| Home hero "global payments (USD, EUR, GBP, NGN, …)"   | Shipped as on the board: the owner's decision, 3 Nov 2026 (DECISION-LOG) |
| `[PRICE SET BY STAFF]` on Pro                         | "Ask for Pro" with no amount until staff can set a price (a later plan)               |
| Email boards: DM Serif Display and Manrope, a heart SVG | Georgia and the system sans; the heart is a text glyph; emails load nothing remote (DECISION-LOG, 5 Nov 2026) |
| Email boards: the supporter's note on a slip, a code box in the staff invitation | No note text in any email; the invitation's code stays inside its one-time link (DECISION-LOG, 5 Nov 2026) |

| Board                       | Screen                                                     |
| --------------------------- | ---------------------------------------------------------- |
| `RedesignPlan`              | Every screen, its status and the order to build them in    |
| `PhonePages`                | Home, menu, individuals and Pro on a phone                 |
| `ScreenHome`                | Home                                                       |
| `PageCreators`              | Who it's for: individuals (`/for-creators`)                |
| `PageBusinesses`            | Businesses, coming soon (`/for-businesses`)                |
| `PagePro`                   | Pro and pricing (new `/pro`)                               |
| `ScreenHowItWorks`          | How it works                                               |
| `TipJourney`, `ScreenThanks`| After Tip: waiting, thank-you, didn't go through, receipt |
| `ScreenWelcome`             | Sign up and first steps                                    |
| `ScreenAccess`              | Sign in, code, recovery, small confirmations               |
| `ScreenDashboard`, `ScreenDashboardPhone`, `ScreenFirstDay` | Dashboard, phone, before the first tip |
| `ScreenTips`, `ScreenTipReport` | Tips, tip detail, weekly report                        |
| `ScreenWithdraw`            | Withdraw                                                   |
| `ScreenSettings`            | Settings and page editor                                   |
| `ScreenSmall`               | Errors, not found, coming soon, legal layout               |
| `ScreenAnimatedCovers`, `OpsProPrice` | Later plans: animated covers, staff Pro price    |
| `StatesConcepts`            | States: the slip (A) and the key tells you (B), with the rules for both |
| `StatesMap`                 | States: every message on every screen and the pattern it becomes        |
| `FeedbackMoments`           | Feedback: press, settle, shake and the withdrawal's step lamps           |
| `SocialLinks`               | Social links: the editor in Settings and the public row (version 97, approved by the owner 5 Nov 2026) |
| `EmailTip`                  | Email: you got a tip, in a desktop inbox and on a phone (approved by the owner 5 Nov 2026) |
| `EmailAccount`              | Emails: sign-in code, confirm an email address, getting back in, welcome (approved by the owner 5 Nov 2026) |
| `EmailSecurity`             | Emails: bank account changed, new sign-in, number about to change, account deleted (approved by the owner 5 Nov 2026) |
| `EmailReports`              | Emails: weekly report, ready for tips, staff invitation, a username taken back (approved by the owner 5 Nov 2026) |

| `WithdrawRedesign`          | Withdraw in every state (approved 5 Nov 2026)              |
| `ScreenAudit`               | Every screen graded against the design rules (5 Nov 2026)  |
