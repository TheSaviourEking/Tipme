# PR-008 verification — 19 October 2026

## Scope delivered

Recipient accounts and the recipient side of TipMe. Pretend money and pretend delivery only: no real SMS, WhatsApp, email, push, payouts or billing.

- **Sign-in and sign-up:** a phone number plus a 6-digit code, delivered by WhatsApp first and SMS as the fallback, through a pretend messenger. Self-hosted sessions. Open sign-up with handles.
- **Pages:** live / not live / deleted. Optional bio, socials, phone and email, each with a public/private switch. Phone and email are private by default.
- **Dashboard:**
  - balance, with money still confirming shown separately;
  - today vs yesterday and this week vs last week, plus a 7-day trend;
  - recent activity and the tips list;
  - tip detail with provider proof;
  - pretend withdrawals of any amount;
  - the first-day state.
- **QR:** three free styles and three "premium · free in preview" styles. Print card, full screen and share image. Every style is decoded in tests.
- **Notifications:** a tip toast and bell, and a pretend email to a verified address. Email verification, phone change, and email recovery with a 24-hour hold.
- **Weekly report:** a Monday job in Lagos time, a report page, and a share image without supporter names.
- **Moments:**
  - milestones, best week and month, and lovely notes;
  - fee-free tips and capped cash bonuses as pretend money in the books;
  - sharing a moment on the public page, where supporters can add to the celebration.

Design: `docs/superpowers/specs/2026-10-19-pr008-recipient-design.md`. Plan: `docs/superpowers/plans/2026-10-19-pr008.md`. ADR-0003, ADR-0009, and the ADR-0006 addendum.

## What the plan's Review Focus asked for

| Risk                                                                    | Evidence                                                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in across the web and API origins; forged cross-site POSTs refused | `tests/e2e/accounts.spec.ts` (sign in, reload, sign out); `tests/integration/auth-api.test.mjs` (missing CSRF header or foreign Origin → 403)                     |
| "0803 123 4567" and "+234 803 123 4567" are one person                  | `packages/database/test/integration/sign-in.test.mjs`                                                                                                             |
| Page goes not live while cached                                         | e2e: not-live within 5 s via revalidation, and within about 30 s even with no signal (cache backstop); integration: an already-quoted tip → 409 `TIP_NOT_PAYABLE` |
| Two withdrawals at once exceed the balance                              | `withdrawals.test.mjs`: exactly one succeeds, the other gets `INSUFFICIENT_BALANCE`                                                                               |
| Two tips cross a milestone together; last fee-free credit               | `moments.test.mjs`: one moment, one grant; credits never below zero                                                                                               |

## Commands (Node 24.22.0, pnpm 10.33.0), after the review fix pass

| Command                                                                  | Result                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                                                      | PASS                                                                                                                                             |
| `pnpm lint` / `pnpm typecheck`                                           | PASS, 15/15 tasks each                                                                                                                           |
| `pnpm test`                                                              | PASS, 17/17 tasks (domain incl. a 1,000-run reward-cap property test; web recognition, QR decode, week share, safe-next)                         |
| `pnpm build`                                                             | PASS, 9/9 (inside `test:e2e`)                                                                                                                    |
| `pnpm db:migrate`                                                        | PASS, migrations 0010–0016 applied                                                                                                               |
| `pnpm test:integration`                                                  | PASS, 225/225                                                                                                                                    |
| `pnpm test:e2e` (web + API + worker on `tipme_test`, desktop and 360 px) | PASS, 105 passed, 1 skipped (existing mobile-only test)                                                                                          |
| `pnpm perf:lab` (lab only: 4× CPU, about 1.6 Mbps, 150 ms)               | LCP `/@tobi` 936 / 520 / 524 ms (now loaded from the database), `/tip/<id>` 628 / 584 / 580 ms, `/dashboard` 724 / 632 / 652 ms; budget 2,000 ms |

## Final review

One fresh reviewer (read-only) found no Critical issues and seven Important ones. Each is fixed with a test that failed first:

1. **Fee-free quotes could exceed the 50% cap** when made before earlier ones were paid. Open fee-free quotes now reserve their credit and cost, under a lock.
2. **A cash bonus used all the room under the cap,** so the fee-free tips granted with it could never be used. The bonus now leaves room for them, and the copy only promises what the cap can honour.
3. **A hijacked mailbox could take over an account at once.** Recovery now waits 24 hours, warns the old number and the email, and any live session can cancel it.
4. **Open redirect after sign-in** (`?next=/\evil.com`). Only dashboard paths are followed now.
5. **Unpaid "tips", with their messages,** showed in the dashboard. Only paid or really-confirming tips are shown now, with the supporter's words only once paid.
6. **The public page could stay stale.** It is now refreshed on phone change and email confirmation, the refresh is retried, and a 30-second cache backstop covers a lost signal.
7. **Deletion left the phone and email behind.** Codes, lockouts and pending links are now erased, and a deleted account's links never work.

Deferred minors are listed in the ledger (`.superpowers/sdd/2026-10-19-pr008/progress.md`, lines starting `Final: minor (deferred)`).

## Notes

- **New settings:**
  - `AUTH_CODE_SECRET`, `WEB_REVALIDATE_SECRET` and `MESSAGING_PROVIDER=mock` for the API;
  - `REWARD_CASH_BUDGET_MINOR_PER_MONTH` for the worker;
  - `API_INTERNAL_ORIGIN` and `WEB_REVALIDATE_SECRET` for the web app.
  - The local `.env` gained generated secrets, whose values were never printed. `.env.example` is updated.
- **New dependencies (pinned and registered):** `libphonenumber-js` 1.13.14, `qrcode` 1.5.4, `jsqr` 1.4.0 (dev only), `@types/qrcode` 1.5.6.
- **Demo accounts:** Ada (`0800 000 0001`) and Tobi (`0800 000 0002`). Codes appear in `/dev/inbox`.
- **Still pending decisions:** real money and rewards (D-03, D-04, D-05), messaging providers (D-11; earlier written as D-08) and recipient verification (D-06).
