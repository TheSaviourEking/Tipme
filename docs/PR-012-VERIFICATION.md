# PR-012 verification — 22 October 2026

## Scope delivered

PRD v1.1's proposed commercial rules, and Free and Pro tipping. Pretend money only; the rules are recorded as _proposed_ in `docs/00-DECISIONS.md` (D-05).

- **Free (every page):**
  - **Fee:** TipMe keeps 10% of each tip and pays the processing fee out of it, so the recipient receives 90%. A ₦5,000 tip gives ₦4,500.
  - **Tips:** minimum ₦1,000, maximum ₦100,000. The standard amounts are ₦1,000, ₦2,000 and ₦5,000, plus any custom amount.
  - **Withdrawals:** minimum ₦1,000, except that a recipient can always withdraw their whole balance.
  - **Fee display:** one line on checkout and the tip detail, "TipMe fee (10%, includes processing)".
- **Pro (granted by staff):**
  - **Amounts:** the recipient chooses 1–4 preset amounts and their own smallest tip, never below ₦1,000. The fee and the withdrawal minimum are the same as Free.
  - **Enforcement:** quotes enforce the page's minimum on the server. The database rejects inconsistent amounts. Saves are refused on Free (`PRO_REQUIRED`), and errors name the wrong field.
  - **Granting:** staff use the new admin page **Pages**: they look a page up by handle (old handles work too) and switch it to Pro or back to Free, with a written reason. This needs the new permission `pages.plan` (Owners have it) and is audited as `page.plan_pro` or `page.plan_free`. Asking for the plan a page already has records nothing.
  - **Downgrade:** going back to Free restores the standard amounts. The page's own amounts are kept for if Pro comes back.
- **Rewards and reports:**
  - **Fee-free tips:** the recipient gets the whole tip, and TipMe absorbs the processing.
  - **Lifetime cap:** "half of what TipMe kept" is now checked against the full 10% cost, so the 10th-tip reward is 4 fee-free ₦2,000 tips.
  - **Overview:** the tile reads "TipMe keeps (after processing)".
- **Old records:** quotes, tips and ledger entries priced under `mock-v0` keep their recorded amounts.
- **Deploy order:** the new fields are optional in the contracts, so the web app keeps working while it talks to an older API.

Plan: `docs/superpowers/plans/2026-10-22-pr012-free-pro-tipping.md`. Migrations: `0029_page_plans` and `0030_tip_amount_checks`. Both only add things; 0030 first clears any inconsistent amounts, which the application never writes.

## Evidence

| Check                                 | Result                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| Format, lint, typecheck               | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: all exit 0 |
| Unit tests                            | 180/180                                                        |
| Integration (`pnpm test:integration`) | 324/324                                                        |
| End-to-end (`pnpm test:e2e`)          | 65/65 (includes the new `pro.spec.ts`)                         |
| OpenAPI                               | Regenerated; `--check` is part of the integration job          |

Tests added:

- `pro-tipping` integration (7 tests):
  - Free amounts and fee;
  - a Free page cannot set amounts;
  - plan changes need the permission and are audited;
  - Pro amounts and their validation, with field-specific errors;
  - the withdrawal minimum, and withdrawing the whole balance;
  - the database checks;
  - lookup by an old handle.
- Domain fee and amount-rule tests.
- The reward-cap test.
- `pro.spec` e2e: staff grant Pro, the recipient sets amounts (with a field error first), a supporter sees them and is refused below the minimum, with axe checks.

Existing tests that asserted the old 6.5% maths were updated to the new rule: ₦2,000 → ₦1,800 net, ₦1,000 → ₦900. Tests that used amounts below ₦1,000 now use ₦1,000 or more.

## Final review

A fresh reviewer read the branch. Its findings, all fixed:

**Important:**

1. The fee-free cap was checked at 8.5% but recorded at 10%. Fixed, with a failing test first.
2. The plan audit didn't say which way the plan changed. Fixed.
3. Leftover balances under ₦1,000 got stuck. Fixed with your "withdraw everything" decision.

**Minor:**

- Database checks for the amounts.
- A save racing a downgrade.
- Field-specific errors.
- The Overview label, and the report changes recorded in the decision register.
- Old fee-free tips' label on the tip detail.
- Stale-page refusal copy.
- The restored sum assertion.
- Admin lookup by old handle.

## Not done here

- **Pro pricing:** billing, and whether Pro changes the fee, are open decisions.
- **Real money:** still gated on D-03 to D-07.
