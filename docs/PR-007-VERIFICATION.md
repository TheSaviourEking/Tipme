# PR-007 verification — 19 October 2026

## Scope delivered

Guest checkout with pretend payments only. No real provider, credentials or money.

- **Server-quoted amount step on `/@handle`.** It shows the fee breakdown and what the recipient receives.
- **Idempotent tip creation.** A double tap never creates two tips.
- **Pretend provider page** (`/mock-checkout/<reference>`) with five outcomes.
- **Status screen `/tip/<id>`.** It shows only what the server verified: waiting, paid, declined, still checking, expired.
- **Private receipt link** (`#t=` token).
- **Opt-in, device-only recognition**, shown after a confirmed tip only and never comparing.
- **API side:**
  - CORS limited to the web origin.
  - Rate limits: 30 quotes/min and 10 tips/min per IP.
  - Worker expiry of never-paid tips, which asks the provider first.

Design: `docs/superpowers/specs/2026-10-18-pr007-checkout-design.md`; plan: `docs/superpowers/plans/2026-10-18-pr007.md`; ADR-0008.

## What the supporter sees (all automated, desktop and 360 px)

| Journey                                                                                 | Evidence (`tests/e2e/checkout.spec.ts` unless noted)                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Choose ₦2,000 on `/@tobi`: "Tobi receives NGN 1,870.00 after fees"                      | PASS, axe clean                                                                                 |
| Opted in, then paid: "That's your first tip. You've made someone's day. We see you."    | PASS                                                                                            |
| Second tip (to Ada): "That's your 2nd tip. You've made 2 people's day."                 | PASS                                                                                            |
| Device record holds only `id`, `handle`, `at`; "Forget my tips on this phone" clears it | PASS                                                                                            |
| Not opted in: no recognition, storage empty                                             | PASS                                                                                            |
| Declined: "The payment was declined", "Try again" goes back to `/@tobi`                 | PASS, axe clean                                                                                 |
| Slow payment: waiting, then paid                                                        | PASS                                                                                            |
| Provider never replies: paid once the worker reconciles                                 | PASS. "Never paid before reconciliation" is proven in `tests/integration/checkout-api.test.mjs` |
| Waiting screen announced (`role="status"`)                                              | PASS, axe clean                                                                                 |
| Double tap on Tip: one idempotency key, one row in `payment_intents`                    | PASS                                                                                            |
| Reload after the fragment is removed: status still shown                                | PASS                                                                                            |
| Receipt opened elsewhere without `#t=`: "This receipt link is incomplete", no request   | PASS, axe clean                                                                                 |
| API unreachable on first load: "We can't reach TipMe right now", then Check again       | PASS, axe clean                                                                                 |
| Every receipt says "Pretend payment · no real money moved"                              | PASS                                                                                            |
| Expired tip: the pretend provider refuses it ("expired and can no longer be paid")      | PASS (+ integration: 409 `TIP_NOT_PAYABLE`, status `cancelled`)                                 |
| Back from the provider page: form consistent and usable                                 | PASS                                                                                            |
| 320 px reflow on profile, pretend provider and status pages                             | PASS                                                                                            |

The API and database were tested against `tipme_test`. The integration suite covers these cases:

- **Quotes:** net `93500` for ₦1,000; unknown handle → 404; too small → 400.
- **Tip intents:**
  - Missing or invalid `Idempotency-Key` → 400.
  - Concurrent same-key requests give the same tip, token and checkout URL.
  - The same key with a different body → 409.
  - Expired quote → 409; quote already used → 409.
  - The 31st quote in a minute → 429 with `Retry-After`.
- **CORS:** allowed only for `WEB_ORIGIN`, and not on health routes.
- **Status:**
  - A wrong, missing or other tip's token → 404.
  - The message is never returned.
  - Responses carry `private, no-store`.
  - The read model covers all five states.
- **Pretend checkout:**
  - Succeed and decline work end to end.
  - The outcome cannot be changed once chosen.
  - It is registered only with the mock provider.
- **Expiry:**
  - The provider is asked first.
  - A tip the provider says was paid is never cancelled.
  - The grace period is respected; a provider failure is counted and leaves the tip alone.
  - A late success after expiry → `payment.conflict`.
  - The worker logs `expired`, `expired_paid` and `expire_errors`.

## Performance (lab only)

`pnpm perf:lab`: Chromium at 360 px, 4× CPU slowdown, about 1.6 Mbps and 150 ms latency, on local loopback, 3 runs. This is a lab measurement, not field data.

| Page                   | LCP (ms)        | Budget |
| ---------------------- | --------------- | ------ |
| `/@tobi` (prerendered) | 712 / 204 / 212 | 2,000  |
| `/tip/<id>`            | 628 / 580 / 584 | 2,000  |

## Commands (Node 24.22.0, pnpm 10.33.0), after the review fixes

| Command                                                      | Result                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `pnpm format`                                                | PASS (see the note on the baseline file below)                         |
| `pnpm lint` / `pnpm typecheck`                               | PASS, 15/15 tasks each                                                 |
| `pnpm test`                                                  | PASS, 17/17 tasks (includes web recognition 7/7, api 24, contracts 6)  |
| `pnpm build`                                                 | PASS, 9/9; `/@ada` and `/@tobi` remain static                          |
| `pnpm db:migrate`                                            | PASS, no new migrations in PR-007                                      |
| `pnpm test:integration`                                      | PASS, 145/145                                                          |
| `pnpm test:e2e` (web 3100 + API 4100 + worker, `tipme_test`) | PASS, 77 passed, 1 skipped (existing mobile-only test), twice in a row |

## Final review

One fresh reviewer, read-only, found no Critical issues. It rated the change "ready to merge with fixes". Each fix below has a test that failed first:

1. If the first status check failed, the status screen showed a skeleton forever. It now shows a recoverable "can't reach TipMe" state with Check again.
2. The expired screen promised "nothing was charged", and the pretend provider still accepted payment for an expired tip. The copy no longer promises that, and the provider refuses (409 `TIP_NOT_PAYABLE`).
3. The shareable receipt had no pretend-payment label. Every state now carries one.
4. Going Back from the provider page left the radio checked while the form's state was empty. Browser form restoration is now off, and a back-forward cache restore re-enables the button.

Deferred minors are listed in the ledger `.superpowers/sdd/2026-10-18-pr007/progress.md` (`Final: minor (deferred)`).

## Notes

- **New settings:** `STATUS_TOKEN_SECRET` (at least 32 characters, required), `WEB_ORIGIN`, `NEXT_PUBLIC_API_ORIGIN`, and `RATE_LIMIT_QUOTES_PER_MIN` / `RATE_LIMIT_INTENTS_PER_MIN`. `.env.example` is updated. The local `.env` gained a generated `STATUS_TOKEN_SECRET`; its value was never printed.
- **Local development:** browse the web at the same host as `WEB_ORIGIN` (default `http://localhost:3000`). Otherwise CORS refuses the API calls.
- **`docs/architecture/IMPLEMENTATION_BASELINE.md`:** the first `pnpm format` of this PR (Task 1) reformatted it. The change is prettier whitespace only, but it is the user's file and earlier PRs had left it untouched on purpose. With no Git I cannot show the diff. It now passes `prettier --check`.
- **No new third-party dependencies.** `@tipme/contracts` became a type-only workspace dependency of the web app.

## Follow-up — deferred minors fixed

All ten review minors were fixed, each with a test that failed first (ledger: `Minor fixed:` lines):

1. The "price refreshed" notice now appears only when the refresh worked.
2. Amount, message and opt-in are locked while a tip is starting, so a retry can never use a different idempotency key.
3. The idempotency key is created before the button turns busy, with a fallback where `crypto.randomUUID` is missing.
4. Replaying a tip that expired before its payment started → 409 `TIP_NOT_PAYABLE`, and the provider is not asked.
5. The pretend checkout charges and shows the quote's payer total.
6. Rate limits count per IPv4 address or IPv6 /64, and trust `X-Forwarded-For` only with `TRUST_PROXY_HOPS`.
7. Expiry checks least-recently-checked first, so failing checks cannot starve newer tips.
8. The return URL no longer carries the receipt token. The tipping tab keeps the token, so a provider reference alone never reveals a receipt.
9. Recognition keeps counting past the 500 tips it lists.
10. The pretend provider page offers Try again when it cannot load.

Gate after the follow-up:

- `prettier --check .` PASS.
- Lint 15/15, typecheck 15/15, unit 17/17 tasks (web recognition 9/9), build 9/9.
- Integration 149/149.
- e2e 87 passed, 1 skipped.
