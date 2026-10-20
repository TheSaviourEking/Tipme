# PR-009 verification — 19 October 2026

## Scope delivered

A staff-only admin area, anonymous analytics and market notes. Pretend money only; admin never moves money.

- **Access:**
  - an Owner role with permissions, granted only by `pnpm ops:grant-owner`;
  - an authenticator app (TOTP) as the second step;
  - an admin grant bound to the recipient session (12 hours at most, 1 hour idle);
  - an append-only audit log.
- **Issues inbox:**
  - Issues come from outbox alerts and from scheduled checks (stuck tips, unmatched provider events, pending recoveries), and close themselves when the cause clears.
  - The evidence view shows history, provider events, the ledger, the payout, the page, the masked person, the trace link and notes.
  - Private details are shown only with a reason, and every reveal is audited.
  - Actions: resolve, note, re-check with the provider, pause or restore a page, cancel a recovery.
- **Paused pages:** hidden, take no new tips, can't go live; tips in flight settle; withdrawals still work; no moments.
- **Analytics:**
  - The allow-list is cookieless. Nothing is written to a supporter's device. GPC and DNT are honoured.
  - Server-side outcomes come from the worker. A daily rollup runs, and raw events are purged after 90 days.
  - QR codes carry `?src=qr`.
  - Collection is off in production until D-07.
- **Dashboards:** Overview (money, funnel, reliability, recipients; this week against last week), Visibility (channels, visits per day, sharing, celebrations, top pages), Market (manual observations with https sources, charted over time), Audit log, Staff & roles.

Design: `docs/superpowers/specs/2026-10-19-pr009-admin-analytics-design.md`. Plan: `docs/superpowers/plans/2026-10-19-pr009.md`. ADR-0010. Runbook: `docs/runbooks/issues-inbox.md`. Ledger (all rulings and deferred minors): `.superpowers/sdd/2026-10-19-pr009/progress.md`.

## Review Focus evidence

| Risk                                      | Evidence                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The admin grant must end with its session | `staff.test.mjs` (idle, 12 h, revoked session, other session); `ops-access.test.mjs` (old `tipme_ops` cookie after sign-out → 404)                                                                      |
| TOTP reuse and clock skew                 | `totp.test.mjs` (RFC vectors, ±1 accepted, ±2 refused, no reuse); `staff.test.mjs` and `ops-access.test.mjs` (same code twice refused; 5 wrong codes lock); review fix: parallel wrong codes still lock |
| Non-staff probing, missing permissions    | `ops-access.test.mjs` and `ops-issues.test.mjs` (404 for non-staff; 403 `FORBIDDEN` for staff without the permission, including reveal)                                                                 |
| Personal data in analytics                | `contracts/test/analytics.test.mjs`; `analytics.test.mjs` (unknown keys, phone-like handles and server-only names refused or dropped; no IP, user agent or URL columns)                                 |
| A paused recipient                        | `ops-actions.test.mjs` (409 `PAGE_SUSPENDED`; in-flight tip settles with no moment; withdrawal works); `ops.spec.ts` (banner)                                                                           |

## Commands (Node 24.22.0, pnpm 10.33.0)

| Command                                   | Result                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck`            | PASS, 15/15 tasks each                                                                                                                                                                       |
| `pnpm build`                              | PASS, 9/9                                                                                                                                                                                    |
| `pnpm db:migrate`                         | PASS, migrations 0017–0021                                                                                                                                                                   |
| `pnpm test:integration`                   | PASS, 276/276 (after the review fixes)                                                                                                                                                       |
| `pnpm test:e2e` (before the review fixes) | 121 passed, 1 skipped; a second run had one failure in an existing checkout test (a timing race: the page reported the expiry by itself before the click); a third run passed 121, 1 skipped |
| `pnpm perf:lab` (lab only)                | LCP `/@tobi` 944 / 536 / 520 ms, `/dashboard` 744 / 628 / 636 ms, `/ops` 192 / 196 / 204 ms (the admin banner paints before data); budget 2,000 ms                                           |

**After the review fix pass (late on 19 October)**, `pnpm format:check`, `pnpm test` and one marketing e2e test (`shell.spec.ts`, the hero heading) fail. These are in files changed by **another session working at the same time** on Git setup and hosted-preview mode (for example `scripts/preview/gateway.mjs`, `turbo.json`, `packages/ui/src/tokens.css` and the new hero copy). They are outside PR-009 and were not changed here. All other e2e tests passed (119), including every admin test.

## Final review

One fresh, read-only reviewer found no Critical issues and two Important ones, both fixed with a test that failed first:

1. **Wrong authenticator codes sent in parallel got around the 5-strike lockout.** The lockout is now checked inside the row lock.
2. **The pause reason is shown word for word to the recipient, but the form read like an internal note.** The field is now "Message to the recipient", with a warning not to include supporters' names, numbers or who reported the page.

Seven minors are deferred (listed in the ledger, lines starting `Final: minor (deferred)`).

## Notes

- **New settings:** `OPS_TOTP_KEY` (required by the API; a local value was generated and never printed), `ANALYTICS_ENABLED`, `RATE_LIMIT_ANALYTICS_PER_MIN` and `OPS_TRACE_URL_TEMPLATE`. `.env.example` is updated.
- **No new dependencies.** TOTP uses `node:crypto`; charts are hand-made SVG.
- **Deviation from the design:** the "visited before" flag and the session flow id were not stored on the device, to keep the PR-007 promise that a supporter who did not opt in is never remembered. "Returning" is known only for supporters who chose "Remember my tips", and the dashboard says so.
- **Still pending:** D-07 (analytics consent and retention), automatic market feeds, and the two-person rule before any admin money action.
