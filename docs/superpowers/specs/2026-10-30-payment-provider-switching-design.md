# Payment provider switching from the admin screen

**Status:** design, awaiting the product owner's approval (30 October 2026)
**Builds on:** `2026-10-30-mail-platform-design.md` §5 and §7 (the shared `provider_settings`, `provider_tests`, `/ops/providers` page and `providers.manage` permission). Built after the mail platform.
**Decision record to write:** ADR-0018 (payment provider routing and admin switching).

**(owner)** marks what the product owner decided; **(design call)** marks what this document chose and the owner can overturn while reviewing.

## 1. Intent

The owner asked for the same admin control over payment providers as for mail: choose the active provider in the admin screen, and prove a provider works before switching to it **(owner)**. Payments carry stakes mail doesn't: money, per-recipient provider accounts, webhooks that must be verified, and a live gate that no screen may bypass.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Providers are configured on the server (keys). Which provider handles **new** tips and **new** recipient onboarding is chosen in `/ops/providers` and audited.
2. A provider can become active only after an end-to-end **test payment** through it has passed, within the last 24 hours.
3. Staff see the impact before switching: how many recipients can take tips through the candidate provider, and how many would show "not accepting tips".
4. Checkout, onboarding, the public page's "accepting tips", reconciliation and the worker all route through a provider registry instead of `if (provider === 'bachs')` branches.

**Non-goals**

- Live (real-money) providers. The admin screen can't select a live provider until `docs/00-DECISIONS.md` D-01–D-07 are approved and ADR-0004's live gate is recorded. Only `mock` (never in production) and `bachs-sandbox` exist today.
- Moving existing payments, payouts, refunds or provider accounts between providers. They keep the provider that created them, as ADR-0004 §6 already requires.
- Adding a second real payment provider. This builds the switch, not a new adapter.

**Anti-goals**

- A switch that leaves every page silently unable to take tips.
- A switch that reroutes reconciliation, webhooks or payouts of existing payments.
- Any path where a client or staff member asserts a payment outcome. The test passes only on the provider's signed webhook plus a server-to-server verification, the same rules as real tips.

## 3. Routing model (design call — the owner's open question)

On 30 October the owner was asked whether a switch should move every recipient at once, or let each recipient keep collecting through the provider they're set up on. Neither was chosen. This design takes the second, because it never breaks a working page **(design call; the owner can overturn this)**:

- **Each configured provider has one of three states** in `provider_settings` (a `payment` row per provider, alongside the mail row):
  - `active`: exactly one. New onboarding goes here, and new tips go here when the recipient is ready on it.
  - `enabled`: still takes new tips for recipients ready on it and not on the active one.
  - `disabled`: takes no new tips. Its existing payments still reconcile and its webhooks are still accepted.
- **Checkout route for a new tip:** the active provider if the recipient's account there is ready; otherwise the first `enabled` provider (in a fixed order shown on the admin page) where they're ready; otherwise "not accepting tips" (`PAYMENT_ACCOUNT_REQUIRED`, as today). `mock` needs no recipient account, so it's always ready.
- **Pinned to its provider for life:** an attempt, its reconciliation, refunds, disputes and payouts of money it collected (the existing `collectedElsewhere` rule).
- **The public page** says "accepting tips" when any route above exists.
- **The dashboard** shows the recipient's account per provider. "Set up payments" opens onboarding with the active provider.
- **Moving everyone at once** is just "set the old provider to `disabled`". The admin page offers it as a separate, explicit action, showing the number of pages that would stop taking tips.

## 4. The test payment

**Purpose:** prove keys, checkout, webhook signing, server verification and fee handling together for the candidate provider.

1. Staff click **Test payment** for a provider and give a reason. TipMe creates a test tip of ₦100 to the standing test page (`@release_bachs` today, set with `PAYMENT_TEST_HANDLE`). It's routed to that provider **regardless of state**, marked as a test (excluded from analytics, reports, moments, rewards and recipient notifications, like rehearsal tips), and recorded in `provider_tests`.
2. The page shows the provider's checkout link. Staff complete it with the provider's sandbox test card. Live providers can't be tested here until the live gate (§2).
3. **The test passes only when all of these hold:**
   - the provider's **signed webhook** arrived and was verified;
   - the server-to-server verification agrees (amount, currency, fee bearer, platform fee equal to the quote);
   - the tip reached `SUCCEEDED`.
     A pass recorded only through the reconcile fallback is marked "passed without webhook", and it **doesn't** allow switching, because the webhook path is part of what's tested **(design call)**.
4. **Failure** is shown with the reason (checkout refused, webhook not received within 15 minutes, signature failed, amount or fee mismatch). The test tip itself follows normal state rules, so nothing is faked.
5. **The mock provider's test** is its pretend checkout, completed in the browser. It's allowed outside production only.

## 5. Switching

- **Needs:** the `providers.manage` permission, a reason, and a passing test within 24 hours for the provider that's becoming `active`. Setting a provider to `enabled` or `disabled` needs only the permission and a reason.
- **Before confirming, staff see:**
  - recipients with a ready account on the candidate, out of all pages with a payment account;
  - how many would route through an `enabled` fallback;
  - how many would stop accepting tips (shown only when disabling);
  - open unresolved attempts per provider.
- **Audited:** `payment_provider.state_changed`, recording provider, from, to, the reason and the counts shown. The public pages' cache is refreshed after a change (the existing revalidate path, with the 30-second backstop).
- **Refused:**
  - `mock` in production;
  - any provider whose configuration is incomplete;
  - any live provider before the live gate;
  - disabling the last provider that has any ready recipients unless the warning is explicitly acknowledged.

## 6. Server changes

- **Configuration.**
  - `PAYMENT_PROVIDER` becomes `PAYMENT_PROVIDERS` (a comma list of configured providers, e.g. `mock,bachs-sandbox`) plus `PAYMENT_DEFAULT_PROVIDER` (used until staff pick one).
  - The old variable stays accepted for one release, with a deprecation log, so staging's environment doesn't break mid-deploy **(design call)**.
  - Production refuses `mock`, as today. API and worker validate the same way.
- **A provider registry** in `packages/payments` (or API wiring): `registry.get(name)` gives the adapter, `registry.configured()` gives the names. Checkout, the payment-accounts controller, the ops actions, webhooks and the worker's reconcile use it. The Bachs-specific checkout branch becomes the adapter path.
- **Routing:** `routeTip(db, { profileId, now })` returns `{ provider, accountReference? } | null` from §3.
- **Data:** the `payment` rows in `provider_settings` gain `state`; `provider_tests` is used with `kind = 'payment'` and `tip_id`. The test tip's marking reuses the existing rehearsal mechanism where it fits; otherwise it gets an `is_provider_test` flag **(design call; the builder picks one after reading how rehearsal tips are excluded)**.
- **Worker:** reconcile and expiry already route by each attempt's stored provider. It also starts every configured provider's verifier, not just the default one.

## 7. Ops page — payment section

`/ops/providers` gets a "Payments" section under "Mail". It lists configured providers with state, live or sandbox, readiness counts, last test (result, time and who ran it), unresolved attempts, and webhook failures in the last 24 hours. The actions are: Test payment, Make active, Enable, Disable. Every action is confirmed in a dialog showing the §5 counts.

## 8. Testing

- **Routing:**
  - active and ready;
  - active not ready but enabled fallback ready;
  - nothing ready;
  - mock always ready;
  - a disabled provider is never chosen;
  - existing attempts stay pinned.
- **Switching rules:**
  - a switch without a passing test is refused;
  - an expired test is refused;
  - "passed without webhook" doesn't count;
  - mock is refused in production;
  - a live provider is refused;
  - every change is audited with its counts.
- **Test payment:**
  - passes on a signed webhook plus verification;
  - fails on a bad signature or fee mismatch;
  - the test tip is excluded from analytics, reports, notifications and moments.
- **Config:** the old `PAYMENT_PROVIDER` is still accepted with a warning; incomplete provider config fails startup.
- **E2E:** the mock test payment and switch on a local stack. A Bachs sandbox test payment is a manual staging check with the sandbox test card, recorded in the PR.

## 9. Delivery order

1. Registry plus routing (§3, §6), with no behaviour change while one provider is configured.
2. Provider states, switching API, audit and the readiness counts.
3. The test payment flow.
4. The ops page section, the ADR-0018 and runbook update (`docs/runbooks/` payment provider switching), and the decision-log note.

## 10. Open questions for the owner

1. **P1 — routing:** keep the §3 design call ("recipients keep their provider; the active one is for new onboarding and new tips where ready"), or move everyone at once on every switch?
2. **P2 — test amount:** ₦100 to `@release_bachs`, completed by staff with the sandbox test card. Is that page and amount right?
