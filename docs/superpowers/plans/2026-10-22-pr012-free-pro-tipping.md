# PR-012 Free and Pro tipping — implementation plan

**Goal:** apply PRD v1.1's proposed commercial rules to every page (Free), and let pages that staff mark Pro choose their own preset amounts and minimum. Pretend money only.

**Source:** PRD v1.1 §2 "Proposed commercial rules" and the user's decisions (22 Oct 2026):

- **Free:** 10% TipMe fee with processing paid out of it, a ₦1,000 minimum tip and a ₦1,000 minimum withdrawal.
- **Pro:**
  - presets and the page's own minimum, which can never go below ₦1,000;
  - the same fee and withdrawal minimum as Free;
  - granted by staff in the admin, audited, with no billing.

## Global constraints

- Money is integer minor units (kobo) with an explicit currency. No floats.
- **Fee version:** quotes are written with the new fee version `proposed-v1.1`. Quotes, tips and ledger entries already written are never recomputed.
- **Proposed only:** the rules are recorded as _proposed_ in `docs/00-DECISIONS.md`. Nothing enables real money.
- **Server-side checks:** the minimum and the presets are enforced on the server; the web only displays them.

## Tasks

- **T1 Fee rules (domain).**
  - `FEE_POLICY_V1` replaces `MOCK_FEE_POLICY_V0` for new quotes: TipMe share 1,000 bps (processing included), estimated processing 150 bps, minimum tip ₦1,000, maximum tip ₦100,000, minimum withdrawal ₦1,000.
  - `priceTip(tip, policy, { feeFree?, minTipMinor? })`:
    - the recipient gets tip − 10%;
    - the breakdown keeps its three parts: `platformFeeMinor` = TipMe's share minus processing, `providerFeeMinor` = processing, `recipientNetMinor` = 90%;
    - fee-free: the recipient gets 100%, both fees are 0, and TipMe absorbs the actual processing (the ledger already books an unrecovered processing cost as TipMe's expense);
    - `minTipMinor` raises the minimum, never lowers it.
  - Tests: the PRD example (₦5,000 → ₦500 fee and ₦4,500 net), rounding, the minimums, fee-free, and a page minimum below the floor being ignored.
- **T2 Plans and amounts (database).**
  - Profile columns: `plan` ('free' | 'pro', default free), `tip_presets_minor` (bigint[]) and `min_tip_minor` (bigint), with checks.
  - New permission `pages.plan`, granted to owners.
  - Operations:
    - `tipAmountsFor` (Free gives the defaults; Pro gives its own, falling back to the defaults);
    - `setTipAmounts` (Pro only: 1–4 presets in whole naira, unique, each between the page minimum and the maximum; minimum between ₦1,000 and the maximum);
    - `setPagePlan` (audited, with a reason).
  - Quotes enforce the page minimum. Withdrawals below ₦1,000 are refused.
  - Integration tests cover each of these.
- **T3 Contracts and API.**
  - `PublicProfile.tipAmounts` and `MyProfile.plan` / `tipAmounts`.
  - `PUT /v1/me/tip-amounts`.
  - `GET /v1/ops/pages/:handle` and `POST /v1/ops/pages/:profileId/plan`.
  - Errors: `PRO_REQUIRED` (403) and `WITHDRAWAL_TOO_SMALL` (409). The OpenAPI document is regenerated.
- **T4 Web.**
  - The tip page uses the profile's own amounts.
  - The fee is shown as one line, "TipMe fee (10%, includes processing)".
  - Settings gets a "Tip amounts" section for Pro and a note for Free.
  - The withdraw page shows the minimum.
  - New admin page `/ops/pages` to look a page up by handle and switch its plan.
  - Expected amounts in existing tests are updated (₦2,000 → ₦1,800 net).
- **T5 Docs and verification.** Decision register (v1.1 rules, Free/Pro), domain doc, `PR-012-VERIFICATION`, full gate, fresh review and one fix pass.

## Review focus

1. A supporter tipping below a Pro page's minimum by calling the API directly.
2. A Free recipient setting amounts by calling the API directly.
3. Fee rounding that makes the parts not add up to the tip, or makes processing exceed TipMe's share.
4. Old quotes or tips changing value after the policy switch.
5. A staff member changing a plan without the permission, or without leaving an audit trail.
